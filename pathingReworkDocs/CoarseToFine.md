# Coarse-to-fine water routing (corridor + widening)

This document describes the current implementation in `src/core/pathfinding/CoarseToFineWaterPath.ts`.

## Why coarse-to-fine exists

A full-resolution BFS on water is simple and optimal, but it can still visit a huge number of tiles in “open ocean” cases.
That makes ship launch / routing too expensive in the hot path.

We already ship downscaled maps (`map4x`, `map16x`), so we can:
1) plan cheaply on a coarse map
2) use that plan to bound the expensive fine search

## One non-negotiable constraint

The coarse map is an approximation. It must never be able to make the final route incorrect.

So coarse-to-fine is designed as “guidance + guardrails”:
- coarse planning proposes a corridor
- fine planning is the authority (it produces the actual moves)
- if the corridor is wrong, we widen it locally
- if that still fails, we fall back to unrestricted fine BFS

## What maps we use

Coarse-to-fine works with any `(fineMap, coarseMap)` pair where the dimensions divide cleanly.
In practice we use:
- `fineMap`: the full-resolution boat navigation map (`gameMap`)
- `coarseMap`: the 16x map (`microGameMap` / `map16x`) when available

The loader already provides `map`, `map4x`, and `map16x` (see `src/core/game/TerrainMapLoader.ts`).

## Implementation (step-by-step)

### 1) Build the fine→coarse mapping

`getFineToCoarseMapping(fineMap, coarseMap)` returns:
- `fineToCoarse[tile] = coarseCellIndex`

This mapping is the bridge for both:
- corridor masking (`allowedMask`)
- visited tracking (`visitedMaskOut`)

### 2) Coarse plan (cheap)

We map the fine seeds/targets to coarse cells and dedupe them:
- `coarseSeeds = dedupe(fineSeeds.map(fineToCoarse))`
- `coarseTargets = dedupe(fineTargets.map(fineToCoarse))`

Then we run the same unweighted search on the coarse map:
- `coarseResult = coarseBfs.findWaterPath(coarseMap, coarseSeeds, coarseTargets, bfsOpts)`

If the coarse plan fails, we immediately fall back to unrestricted fine BFS.
This covers cases where the coarse map is conservative/loses connectivity.

### 3) Tighten the coarse path before masking

Naively inflating a coarse “staircase” path creates an unnecessarily fat corridor.

We run `rubberBandCoarsePath(coarseMap, coarseResult.path, bfsOpts)` which:
- compresses the coarse path into line-of-sight waypoints
- expands those straight segments back into a contiguous coarse-cell “spine”

This keeps the corridor narrow without changing correctness (coarse is guidance only).

### 4) Build the corridor mask (stamps)

We mark “allowed” coarse cells in a stamp array:
- `allowedStamp[coarseCell] === allowedStampValue` means “allowed”

The corridor is:
- all coarse cells within radius `r` of the spine
- radius uses Chebyshev geometry (matches king moves)

### 5) Fine refinement under the corridor (mask-expanding BFS)

The refine stage uses:
- `MultiSourceAnyTargetBFS.findWaterPathFromSeedsMaskExpanding(...)`
- with `allowedMask` (corridor restriction)
- and `visitedMaskOut` (to record which coarse regions were actually explored)

If the corridor is correct, this produces the final fine path cheaply.

### 6) Local widening when the queue exhausts

When the fine BFS queue empties under the current mask, we “repair” the corridor:
- compute `visitedCoarse` from `visitedMaskOut` (regions touched in the most recent phase)
- widen the corridor by one Chebyshev ring around `visitedCoarse`
- widening is cumulative (newly allowed regions stay allowed)
- visited tracking is reset for the next phase by advancing the visited stamp

This is the key performance win: we unlock *only where the search actually pushed*, not the entire ocean.

### 7) Final guardrail

If widening runs out of attempts and we still have no path:
- run unrestricted fine BFS

Correctness always comes from the fine solve. Coarse planning never “authorizes” a move by itself.

## Defaults (and why they are not “0”)

In `CoarseToFineWaterPath.ts` the defaults are intentionally non-zero:
- `corridorRadius` defaults to `2`
- `maxAttempts` defaults to `6`

Reasoning:
- The coarse map is often optimistic (a coarse cell becomes “water” if any child tile is water).
  Thin peninsulas / narrow land bridges can disappear at 16x and cause the initial corridor to miss the real channel.
- A slightly inflated initial corridor avoids immediate failure and reduces how often we hit the expensive final fallback.
- Widening is cheap (coarse grid), but not free. `maxAttempts` caps worst-case behavior.

## Related docs

- `pathingReworkDocs/MultiSourceAnyTargetBFS.md`
- `pathingReworkDocs/LocalCorridorWidening.md` (the widening rule)
- `pathingReworkDocs/MaskExpanding.md` (no-restart refine)
