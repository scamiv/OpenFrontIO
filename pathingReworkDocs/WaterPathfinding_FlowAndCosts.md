# Water pathfinding flow + expected costs (baseline `9e8ac07e` vs old `main` `02a6ac58`)

This doc explains the end-to-end routing flow as of `9e8ac07e7870d9092f66b8db7f81ee7b1474e1ca` (the `pathPostprocessWaypointSpline` line),
and contrasts it with the pre-rework flow at `02a6ac58ea1f5122d57731d20148b7319ddeee98`.

Scope: water navigation for transport boats / trade ships / warships.

Related docs:
- `pathingReworkDocs/MultiSourceAnyTargetBFS.md`
- `pathingReworkDocs/CoarseToFine.md`
- `pathingReworkDocs/MaskExpanding.md`
- `pathingReworkDocs/PathPostprocessWaypointSpline.md`

---

## Map sizes and symbols

- `Nf`: number of tiles in the fine map (`fineMap.width * fineMap.height`)
- `Nc`: number of tiles in the coarse map (`coarseMap.width * coarseMap.height`)
- `Vf`: visited fine tiles during refine (dominant cost driver)
- `Vc`: visited coarse tiles during coarse plan / widening bookkeeping
- `L`: length of the produced tile path (steps ~= `L - 1`)
- `W`: number of postprocess waypoints (typically `W << L`)

Rule of thumb: runtime is roughly linear in the visited tile count, not the path length.

---

## New flow (baseline: `9e8ac07e`)

Implementation references:
- `src/core/pathfinding/CoarseToFineWaterPath.ts` (orchestration)
- `src/core/pathfinding/MultiSourceAnyTargetBFS.ts` (BFS + mask-expanding BFS)
- `src/core/pathfinding/PathRubberBand.ts` (coarse rubber-band + postprocess)
- `src/core/game/TransportShipUtils.ts` (seed/target building, route object)

### 0) Build bounded seed + target sets (call site work)

This is not pathfinding yet, but it controls pathfinding cost.

Typical pattern:
1) Pick a bounded set of candidate shore tiles near the click (targets).
2) Convert each shore to adjacent water tiles (targets are water tiles, not shore tiles).
3) Pick a bounded set of candidate spawn shores (sources), then convert to adjacent water tiles (seed nodes).

Expected cost:
- O(number of candidate shores) to scan/collect
- O(number of candidates) to expand "shore -> adjacent water"

### 1) Early reject: water-body component filter (fine map)

`WaterComponents.ts` provides a connected-component ID per water tile.
We filter seeds/targets to the same component before spending time on routing.

Expected cost:
- O(|seeds| + |targets|) with very small constants

Effect:
- "lake vs ocean" and other impossible routes become cheap no-ops.

### 2) Coarse plan (cheap BFS on a low-res map)

We map fine seeds/targets to coarse cells (`fineToCoarse[tile]`) and dedupe.
Then we run the same unweighted search on the coarse map to get a coarse path.

Expected cost:
- O(Vc) where `Vc <= Nc`
- If `coarseMap` is truly "micro" (16x), `Nc` is tiny compared to `Nf` and this stage is usually negligible.

### 3) Tighten the corridor spine (rubber-band the coarse path)

Naively inflating a zig-zag coarse path creates a fat corridor. We reduce that by:
- compressing the coarse path into far fewer LOS waypoints
- expanding each LOS segment back into a contiguous coarse-cell "spine"

Expected cost:
- bounded LOS checks (`maxLookahead`, `maxChecksPerAnchor`)
- on coarse grids this is usually negligible next to refine

### 4) Build the coarse corridor mask (stamp array)

We build `allowedMask` on the coarse grid:
- a coarse cell is "allowed" if it is within radius `r` of the spine

Expected cost:
- O(spineLength * (2r+1)^2)

### 5) Refine on the fine map (mask-expanding multi-source BFS)

This is the dominant stage.

We run `findWaterPathFromSeedsMaskExpanding(...)` on the fine map:
- traversal is `gm.isWater` with king moves + no-corner-cutting
- `allowedMask` restricts exploration to coarse regions in the corridor
- `visitedMaskOut` stamps which coarse regions were actually reached

If the queue exhausts under the current corridor:
1) widen the corridor by one Chebyshev ring around the visited coarse regions
2) activate newly allowed regions by enqueuing deferred frontier tiles
3) continue without clearing fine `visitedStamp`

Expected cost (no fallback):
- O(Vf) where `Vf` is approximately "corridor area actually reached"
- widening step overhead is roughly O(Nc) per expansion + O(deferred tiles in newly opened regions)

Worst case:
- if the corridor is wrong enough and widening can't repair it within attempts,
  we fall back to unrestricted fine BFS which can approach O(size of water component).

### 6) Post-process the final tile path (endgame: geometry)

After refine returns a valid tile path, we post-process it via `rubberBandWaterPath(...)`:

Pass 1: LOS-compress the tile path into sparse waypoints
- bounded lookahead (`maxLookahead`) to keep it predictable
- uses the same water + no-corner-cutting LOS predicate as the solver

Pass 2 (optional): "push offshore" by snapping each interior waypoint to a local maximum depth
- uses a small window (e.g. 17x17) around the waypoint
- computes local distance-to-land in the window, then picks the deepest water tile that preserves LOS to prev/next
- validates the whole snapped waypoint chain; if it breaks LOS anywhere, it keeps the original waypoints

Final: reconstruct a tile-valid path by expanding waypoint segments with Bresenham.

Optional: sample a spline from waypoints for rendering (does not affect the tile path).

Expected cost:
- LOS compression: roughly O(number of LOS checks * segment length), bounded
- offshore snapping: O(W * windowSize^2) plus LOS checks from (prev,candidate,next); near coast this is the only post-pass that can become noticeable
- expansion back to tiles: O(L)
- spline sampling: O(W * samplesPerSegment), typically negligible

Outputs:
- authoritative: `path: TileRef[]` (tile-valid)
- extra: `waypoints: TileRef[]` and `spline?: number[]` (for rendering/motion)

---

## Old flow (baseline: `main` `02a6ac58`)

Implementation references:
- `src/core/game/TransportShipUtils.ts` (spawn/target selection, candidate sampling)
- `src/core/execution/TransportShipExecution.ts` (tick-by-tick movement)
- `src/core/pathfinding/PathFinding.ts` + `src/core/pathfinding/MiniAStar.ts` (mini-map A*)

### 0) Pick source/destination shores (often scans large borders)

Key behavior:
- `closestShoreFromPlayer(...)` scans `player.borderTiles()` and picks the Manhattan-closest shore.
- `candidateShoreTiles(...)` scans border shore tiles, collects extremums, and samples up to ~50 tiles.

Expected cost:
- O(border length) per query (border can be very large on big empires)
- alloc-heavy patterns (array conversions + filters + reduce)

### 1) "Pathfinding" is spread across ticks (mini-map A* inside `PathFinder`)

In `TransportShipExecution`:
- create a `PathFinder.Mini(...)`
- each tick call `pathFinder.nextTile(curr, dst)`
  - it may recompute a mini-map A* path when it decides tolerance has been exceeded
  - computation is iteration-budgeted and can return `Pending`
  - when completed it reconstructs a path and steps along it

Expected cost:
- not a single predictable spike; instead a repeated per-tick budget
- can recompute multiple times over a long trip (especially if the `shouldRecompute` tolerance triggers)
- no corridor / locality concept: if minimap is permissive, it can still do large searches

### 2) No connected-component early reject

There is no "same water body" check up front.
Impossible routes can still burn A* iterations before failing.

### 3) No explicit post-pass contract (geometry handled elsewhere)

The old codebase already had curve utilities (e.g. `ParabolaPathFinder`), but boat movement was driven by the grid pathfinder.
There wasn't a first-class `{ path, waypoints, spline }` contract that could be fed into rendering deterministically.

---

## Scenario comparison (what gets cheaper, what stays expensive)

### Case A: impossible route (lake vs ocean)

New (`9e8ac07e`):
- O(|seeds| + |targets|) component filter, then early return

Old (`02a6ac58`):
- no component filter; can spend A* iterations before giving up

### Case B: open ocean crossing (few obstacles)

New:
- coarse plan is tiny
- refine stays inside corridor; `Vf` is usually a small fraction of the ocean
- post-pass collapses to very few waypoints and often does no offshore snapping (no land in window)

Old:
- repeated mini-map A* budgets across ticks
- no corridor bounding; recomputation policy can cause extra work over long distances

### Case C: narrow strait / chokepoint

New:
- corridor keeps the search localized
- if the corridor misses the strait due to coarse abstraction, visited-driven widening repairs it locally; worst-case falls back

Old:
- minimap abstraction can either "lie open" or "lie closed"; behavior depends on downscale artifacts and iteration limits

### Case D: huge empire coastline (many candidate spawn shores)

New:
- multi-source BFS cost is linear in the number of seeds you feed it (so we keep them bounded)
- the expensive part is still `Vf`, not "number of sources * number of searches"

Old:
- `borderTiles()` scans show up directly in the hot path
- candidate building + recomputation churn can dominate for very large borders

### Case E: "why is it still expensive?"

New:
- if you see a big spike, it almost always means `Vf` was large:
  - corridor accidentally included a large open region, or
  - widening/fallback unlocked too much, or
  - you effectively ran unrestricted fine BFS in a huge water component

That's a search-space problem, not a micro-optimization problem.
The next structural fix is hierarchical segmentation (Spine & Portals), not tuning queue code.

---

## Practical profiling checklist (what to measure)

When diagnosing a slow route, capture:
- fine map size `Nf`
- coarse map size `Nc` (and which map was chosen)
- `Vf` (visited/enqueued counts in refine)
- number of mask expansions (widen steps) and whether fallback happened
- waypoint count `W` before/after offshore snapping
- window size used for offshore snapping

This makes it obvious whether the cost is:
- corridor/refine (most common), or
- postprocessing (only near coast with large window sizes), or
- candidate-building (too many shores/ports fed in).

---

## Notes on "what's missing" at `9e8ac07e`

`9e8ac07e` produces `waypoints` and optional `spline` samples, but renderer integration is still pending:
- rendering should prefer `spline`/`waypoints` when present and keep a debug toggle for the underlying tile path
- ship motion can interpolate along the polyline/spline while the simulation remains tile-authoritative
