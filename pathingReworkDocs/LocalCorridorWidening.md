# Visited-driven corridor widening (local relaxation rule)

This document describes the widening rule used by coarse-to-fine water routing to repair a corridor when it is too tight.
The implementation lives in `src/core/pathfinding/CoarseToFineWaterPath.ts` (the widen callback) and is driven by `visitedMaskOut` from `src/core/pathfinding/MultiSourceAnyTargetBFS.ts`.

## The failure mode we’re fixing

Coarse-to-fine works by restricting the fine search to a coarse corridor.
If the coarse map lies (optimistic water, minimap tearing), the fine search can fail even though a valid path exists.

The naive response is “drop the mask and run an unrestricted fine BFS”, but that’s the cliff we want to avoid:
one small abstraction error should not trigger an ocean-sized floodfill.

## Key observation

When a constrained fine search fails, it still did useful work:
it discovered exactly which parts of the corridor were reachable.

So the corridor repair step should expand **around where the fine search actually went**,
not around the original coarse spine/path.

## What we track

We maintain two stamp sets on the coarse grid:

1) **Allowed corridor** (cumulative)
- `allowedCoarseStamp[coarseCell] === allowed` means the coarse cell is currently allowed
- once allowed, it stays allowed for the rest of the solve

2) **Visited regions** (per phase)
- `visitedCoarseStamp[coarseCell] === visited` means some fine tile mapping to this coarse cell was visited in the current phase
- this is reset between widening steps by incrementing the stamp

“Phase” here means: one contiguous run of the fine BFS under a fixed allowed mask.

## Widening rule (the actual algorithm)

When the fine queue exhausts:
1) Collect the set of coarse cells marked as visited in the last phase.
2) For each such coarse cell, mark its 8 neighbors as allowed (Chebyshev ring).
3) Return the list of newly allowed coarse cells so the fine search can resume/activate them.
4) Reset visited tracking for the next phase.

Why a Chebyshev ring:
- boats use king moves; the corridor should widen symmetrically in the same geometry.

Clarification (important for reviewers):
Widening is cumulative. Each phase widens around *that phase’s* visited set, but newly allowed cells stay allowed across later phases (via `allowedCoarseStamp`).

## How visited regions are collected cheaply

`MultiSourceAnyTargetBFS` supports a `visitedMaskOut` option:
- `visitedMaskOut.tileToRegion` is the `fineToCoarse` mapping
- each time a fine tile is visited, it stamps the corresponding coarse cell

This gives us “where the search pushed” without any allocations (`Set`/`Map`) and without scanning the fine grid.

## Guardrails

- Widening is capped (`maxAttempts`) to keep worst-case costs predictable.
- If widening can’t repair the corridor, we always fall back to unrestricted fine BFS to preserve correctness.

## Where this is used today

The current refine stage uses “mask-expanding BFS” (no restart) and calls this widening rule when the queue empties:
- see `pathingReworkDocs/MaskExpanding.md`
- see `src/core/pathfinding/CoarseToFineWaterPath.ts` for the wiring
