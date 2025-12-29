# Mask-expanding BFS (resume under a widening corridor)

This document describes the refine-stage search used by coarse-to-fine: a BFS that runs under an allowed-region mask and can continue when that mask is widened.

Implementation: `MultiSourceAnyTargetBFS.findWaterPathFromSeedsMaskExpanding(...)` in `src/core/pathfinding/MultiSourceAnyTargetBFS.ts`.

## Why this exists

We already have a robust corridor repair rule (“visited-driven widening”, see `pathingReworkDocs/LocalCorridorWidening.md`).
The remaining performance problem was *restart churn*:

- run fine BFS under a corridor
- corridor too tight → widen corridor
- restart fine BFS from scratch

Restarting re-enqueues and re-walks the same fine tiles over and over on “almost correct” corridors.
That’s wasted work in exactly the case we’re trying to optimize.

## Key invariant (what makes resuming safe)

Mask expansion is monotonic:
- the allowed set only grows
- already visited tiles remain valid

Invariant: once a fine tile is marked visited, it is never “unvisited” again — mask expansion only enables additional neighbors/regions and never invalidates already visited tiles.

This is why we can resume without clearing `visitedStamp`.

### Important trade-off

Because the graph changes mid-run (more nodes become allowed), resuming a FIFO BFS is not guaranteed to return the globally shortest path in the *final* expanded allowed set.

For our use this is acceptable:
- the corridor is a heuristic bound anyway (we’re already not searching the whole ocean)
- we primarily want “valid + cheap” corridor repair
- correctness is still guarded by the unconditional unrestricted fine BFS fallback

If we ever need strict shortest paths under the final expanded mask, we can implement the “optimal” variant (see “If we needed optimality” below).

## How the implementation works

Inputs:
- `allowedMask`: `{ tileToRegion, regionStamp, stamp }`
  - `tileToRegion` is usually `fineToCoarse`
  - `regionStamp[region] === stamp` means that region is currently allowed
- `onQueueEmpty(outNewlyAllowedRegions)`: callback that widens the mask in-place and returns how many regions became newly allowed

During neighbor expansion:
1) If a neighbor is water and unvisited:
   - if its region is allowed → visit + enqueue
   - otherwise → defer it

### Deferring without allocations (region-local frontier lists)

Deferral is implemented as “per-region linked lists” in typed arrays:
- `regionHead[region]` points at the head of a linked list of deferred fine tiles in that region
- `deferredNext[tile]` links the list
- `deferredPrev[tile]` stores the predecessor tile so we can set `prev[]` correctly when the tile becomes reachable

When the queue exhausts:
1) `onQueueEmpty(outNewlyAllowedRegions)` widens the corridor and returns the newly allowed regions.
2) For each newly allowed region, we pop its deferred list and enqueue any tiles that are still unvisited.

This is the main win: activating new frontier nodes is O(newlyAllowedRegions + deferredInThoseRegions), not O(allVisitedFineTiles).

## How this is used by coarse-to-fine

`src/core/pathfinding/CoarseToFineWaterPath.ts` wires this together:
- coarse plan builds an initial corridor mask (stamps)
- fine refine runs `findWaterPathFromSeedsMaskExpanding(...)` under that mask
- when the queue empties, the callback widens the corridor by one ring around the coarse regions visited in the last phase
- widening is capped; final fallback is unrestricted fine BFS

## If we needed optimality later

If we ever decide “the path must be shortest under the final expanded allowed set”, the clean approach is to switch from plain FIFO BFS to a monotone distance queue:
- track `dist[tile]`
- when new nodes become enabled, allow relaxations (`nd = dist[cur] + 1`)
- process nodes in non-decreasing distance (bucket/Dial queue works because edge weights are 1)

That is strictly more code and usually unnecessary for corridor repair, but it’s the upgrade path if we ever need it.
