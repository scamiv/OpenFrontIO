# Water pathfinding evolution (from `main` → `lazy-theta`) — core developer notes

This doc is the “how it actually works” companion to `pathingReworkDocs/PathfindingEvolution.md`.
It’s organized as:

1) Milestone tree / timeline by commit
2) Current architecture (modules + contracts)
3) Invariants, gotchas, and performance notes

---

## 0) Milestone index (docs + branches)

Two kinds of signposts:
- **Doc checkpoints**: commits that introduced/updated a design doc (best entry points).
- **Branch bookmarks**: branch names that mark major new ideas.

Doc checkpoints:
- `pathingReworkDocs/MultiSourceAnyTargetBFS.md` - `65ca00d5..69e422d3`
- `pathingReworkDocs/CoarseToFine.md` - `e08acdf0..368f5c59`
- `pathingReworkDocs/LocalCorridorWidening.md` - `aa09240d`
- `pathingReworkDocs/MaskExpanding.md` - `7bd7d35d`
- `pathingReworkDocs/lazytheta.md` - `a6050794` (optional later)

Branch bookmarks (major ideas):

```
* a6050794 (lazy-theta)      (optional later) Lazy Theta* refine mode
| * 9e8ac07e (pathPostprocessWaypointSpline)  (sibling) post-process: smooth + offshore + spline/waypoints
|/
* b1f05aba (BSPish)          Rubber-band coarse corridor spine
* 368f5c59 (CoarseToFine)    Coarse-to-fine corridor planning
* 69e422d3 (MultiSourceAnyTargetBFS) Multi-source / any-target BFS
* 02a6ac58 (main)            Base
```

Notes:
- Despite the branch name `SpineAndPortals` at `aa09240d`, that commit is **local corridor widening** (no portal/spine abstraction yet).
- We keep **BFS as the default refine** until the corridor + postprocess pipeline is stable; Lazy Theta* stays an opt-in/late-stage knob.
- A real "Spine & Portals" hierarchy (see `pathingReworkDocs/SpineAndPortals.md`) likely comes before Lazy Theta*.

### Pathfinding branches + commits (tree)

```
main (02a6ac58)
└─ MultiSourceAnyTargetBFS (02a6ac58..69e422d3)
   └─ CoarseToFine (69e422d3..368f5c59)
      └─ BSPish (368f5c59..b1f05aba)
         ├─ lazy-theta (b1f05aba..a6050794)
         └─ pathPostprocessWaypointSpline (b1f05aba..9e8ac07e)
```

Branch commit lists (from `git log --reverse <base>..<branch>`):

- `MultiSourceAnyTargetBFS` (`02a6ac58..69e422d3`)
  - `65ca00d5` Implement MultiSourceAnyTargetBFS for efficient boat routing
  - `4564f9e4` Refactor TransportShipExecution for improved pathfinding and routing
  - `9769cf25` Trade/warship routing now uses shared boat helpers
  - `722c0235` Add water component ID caching for improved pathfinding
  - `790600e9` Instrumentation detour (temporary)
  - `69e422d3` Docs checkpoint: `pathingReworkDocs/MultiSourceAnyTargetBFS.md`

- `CoarseToFine` (`69e422d3..368f5c59`)
  - `e08acdf0` Add coarse-to-fine pathfinding for water navigation
  - `27762942` Enhance game map handling with microGameMap integration
  - `368f5c59` Docs checkpoint: `pathingReworkDocs/CoarseToFine.md`

- `BSPish` (`368f5c59..b1f05aba`)
  - `aa09240d` Add local corridor widening for adaptive pathfinding + `pathingReworkDocs/LocalCorridorWidening.md`
  - `7bd7d35d` Add mask-expanding for adaptive corridor refinement + `pathingReworkDocs/MaskExpanding.md`
  - `f3edd553` Update corridor parameters in `CoarseToFineWaterPath` for robustness
  - `26d215b8` Use microMap (16x) for boat coarse planning
  - `b1f05aba` Add rubber band path optimization for coarse water pathfinding

- `pathPostprocessWaypointSpline` (`b1f05aba..9e8ac07e`) (sibling branch)
  - `ae9a8cc8` Post-refinement string pulling; expose sparse polyline for later spline-render
  - `89d638a0` Path postprocess: offshore waypoint snapping + robust LOS compression
  - `9e8ac07e` PathRubberBand: offshore depth-snap + spline output for boat routes

- `lazy-theta` (`b1f05aba..a6050794`) (optional later)
  - `a6050794` Add Lazy Theta* pathfinding for water refinement + `pathingReworkDocs/lazytheta.md`

The linear commit sequence since `main` is:

`65ca00d5 → 4564f9e4 → 9769cf25 → 722c0235 → 790600e9 → 69e422d3 → e08acdf0 → 27762942 → 368f5c59 → aa09240d → 7bd7d35d → f3edd553 → 26d215b8 → b1f05aba → a6050794`

---

## 1) Commit-by-commit evolution (what changed, why)

### `65ca00d5` — `MultiSourceAnyTargetBFS` introduced
Files:
- `src/core/pathfinding/MultiSourceAnyTargetBFS.ts`
- `pathingReworkDocs/MultiSourceAnyTargetBFS.md`

Key ideas:
- Multi-source BFS over water tiles with early exit on **target dequeue**.
- King moves (8-neighbor) supported with optional no-corner-cutting.

At this point:
- Result is `{ source, target, path }`.
- Options include a crude `maxVisited` budget (removed later once we had better guards).

### `4564f9e4` — seed origins (spawn shore) + transport integration
Files:
- `src/core/game/TransportShipUtils.ts`
- `src/core/execution/TransportShipExecution.ts`
- `src/core/pathfinding/MultiSourceAnyTargetBFS.ts`

Key ideas:
- Introduce `findWaterPathFromSeeds(gm, seedNodes, seedOrigins, targets, opts)`:
  - `seedNodes`: water tiles to enqueue
  - `seedOrigins`: “semantic sources” (usually shore tiles) to report as `result.source`
- `bestTransportShipRoute`:
  - seeds = adjacent water of candidate owned shores (`seedOrigins` is the shore)
  - targets = adjacent water of target shores
  - returned `result.target` is converted back into a shore `dst` (landing)

### `9769cf25` — unify trade/warship routing on boat helpers
Files:
- `src/core/execution/TradeShipExecution.ts`
- `src/core/execution/WarshipExecution.ts`
- `src/core/game/TransportShipUtils.ts`

Key idea:
- Reuse the same boat route primitives across unit types, reducing algorithm drift.

### `722c0235` — water component IDs (reachability prefilter)
Files:
- `src/core/pathfinding/WaterComponents.ts`
- `src/core/game/GameImpl.ts`
- `src/core/game/TransportShipUtils.ts`

Key idea:
- Cache connected water component IDs (`WeakMap<GameMap, Uint32Array>`) so we can:
  - filter seeds and targets to overlapping components
  - avoid impossible searches

Side effect:
- Remove `maxVisited` from BFS options (hard cutoffs replaced by actual reachability filtering).

### `790600e9` — runtime logging (instrumentation detour)
Files:
- `src/core/game/TransportShipUtils.ts`

Key idea:
- Add temporary `console.log` instrumentation (timings/steps). This is purely for tuning.

### `69e422d3` — BFS docs cleanup (milestone)
Files:
- `pathingReworkDocs/MultiSourceAnyTargetBFS.md`

Key idea:
- Document invariants (especially early exit correctness), and performance constraints.

### `e08acdf0` — coarse-to-fine corridor planning
Files:
- `src/core/pathfinding/CoarseToFineWaterPath.ts`
- `pathingReworkDocs/CoarseToFine.md`
- `tests/core/pathfinding/CoarseToFineWaterPath.test.ts`

Key ideas:
- Add `allowedMask` to BFS options:
  - map each fine tile to a coarse “region id”
  - allow traversal only when `regionStamp[region] == stamp`
- Implement `findWaterPathFromSeedsCoarseToFine(...)`:
  1) plan on `coarseMap` to get a coarse path
  2) inflate coarse path into a corridor mask
  3) refine on fine map inside the corridor
  4) if corridor fails, widen (initially by global radius growth), then fallback to full fine search

### `27762942` — micro map integration
Files:
- `src/core/game/GameImpl.ts` (+ loader plumbing)
- `pathingReworkDocs/CoarseToFine.md`
- `tests/util/Setup.ts`

Key idea:
- Ensure low-res maps (e.g. `microMap`) are present and accessible for coarse planning.

### `368f5c59` — coarse-to-fine docs checkpoint
Files:
- `pathingReworkDocs/CoarseToFine.md`

Key idea:
- Clarify corridor/fallback semantics and expected failure modes of coarse abstraction.

### `aa09240d` — local corridor widening (visited-driven)
Files:
- `pathingReworkDocs/LocalCorridorWidening.md`
- `src/core/pathfinding/CoarseToFineWaterPath.ts`
- `src/core/pathfinding/MultiSourceAnyTargetBFS.ts`

Key ideas:
- Add `visitedMaskOut` to BFS options:
  - stamp coarse regions visited during the fine search (cheap)
- Replace “increase radius globally” with:
  - widen by 1 Chebyshev ring around visited coarse regions
  - widening is cumulative

### `7bd7d35d` — mask-expanding BFS (resume instead of restart)
Files:
- `pathingReworkDocs/MaskExpanding.md`
- `src/core/pathfinding/MultiSourceAnyTargetBFS.ts`
- `src/core/pathfinding/CoarseToFineWaterPath.ts`

Key ideas:
- Introduce `findWaterPathFromSeedsMaskExpanding(...)`:
  - run one BFS under an initial allowed mask
  - when the queue empties, expand the allowed mask and **continue** without clearing visited
  - “activate” newly allowed regions using deferred frontier bookkeeping

This is sound for “corridor repair” because:
- the allowed set only grows (monotonic relaxation)
- visited nodes remain valid; we only gain new neighbors later

### `f3edd553` — corridor parameters tuned
Files:
- `src/core/pathfinding/CoarseToFineWaterPath.ts`

Key idea:
- Default corridor radius/attempt count increased to avoid “optimistic coarse water” cliffs that force full fallback.

### `26d215b8` — use `microMap` (16x) for boat coarse planning
Files:
- `src/core/game/TransportShipUtils.ts`

Key idea:
- Choose a stable coarse resolution for planning (16x), instead of relying on looser maps.

### `b1f05aba` — rubber-band coarse spine (reduce corridor staircase inflation)
Files:
- `src/core/pathfinding/PathRubberBand.ts`
- `src/core/pathfinding/CoarseToFineWaterPath.ts`

Key idea:
- Coarse paths can zig-zag. Inflating them produces fat corridors.
- `rubberBandCoarsePath`:
  - compresses coarse path into LOS waypoints
  - expands LOS segments back into a contiguous coarse-cell “spine”
  - corridor mask is built around this spine instead of the original zig-zag

### `a6050794` — Lazy Theta* refinement mode + waypoint outputs
Files:
- `src/core/pathfinding/LazyThetaStar.ts`
- `src/core/pathfinding/CoarseToFineWaterPath.ts`
- `src/core/pathfinding/MultiSourceAnyTargetBFS.ts`
- `pathingReworkDocs/lazytheta.md`

Key ideas:
- Add `refineMode: "bfs" | "lazyTheta" | "auto"` to coarse-to-fine.
- Implement Lazy Theta*:
  - search on the grid but produce sparse any-angle parent chains (`waypoints`)
  - expand waypoints deterministically to tiles (`tiles`) via Bresenham
- Extend the result contract to allow `waypoints` + `tiles` (used by postprocessing branches).

---

## 2) Current architecture (what to read)

### Core algorithms

- `src/core/pathfinding/MultiSourceAnyTargetBFS.ts`
  - `findWaterPathFromSeeds(...)`: baseline unweighted multi-source/any-target BFS
  - `allowedMask`: restrict traversal to corridor regions
  - `visitedMaskOut`: record which coarse regions were explored
  - `findWaterPathFromSeedsMaskExpanding(...)`: corridor widening without restart

- `src/core/pathfinding/WaterComponents.ts`
  - `getWaterComponentIds(gm)`: precompute connected water bodies (4-neighbor)

- `src/core/pathfinding/CoarseToFineWaterPath.ts`
  - `findWaterPathFromSeedsCoarseToFine(...)` orchestrates:
    - mapping `fineTile -> coarseRegion`
    - coarse plan (cheap)
    - corridor mask build (stamps)
    - refine stage (BFS default; Lazy Theta* behind `refineMode`) + widening callback
    - final fallback to unrestricted fine search

- `src/core/pathfinding/PathRubberBand.ts`
  - `rubberBandCoarsePath(...)`: LOS-compress coarse path to tighten corridor

- `src/core/pathfinding/LazyThetaStar.ts`
  - any-angle refinement with LOS “repair” and deterministic Bresenham expansion
  - outputs `{ source, target, waypoints, tiles }` (+ `path` alias)
  - optional refine-stage alternative; BFS stays default

### Call sites (boat route construction)

- `src/core/game/TransportShipUtils.ts`
  - `boatPathFromTileToShore(...)`
  - `boatPathFromTileToWater(...)`
  - `bestTransportShipRoute(...)`
  - constructs seeds/targets and applies water-component filtering before invoking coarse-to-fine

- `src/core/execution/TradeShipExecution.ts`, `src/core/execution/WarshipExecution.ts`
  - use the shared boat path utilities

---

## 3) Invariants / gotchas

- **Any-target correctness:** stop on *dequeue*, not on discovery.
- **No corner cutting:** diagonal moves require both orthogonal neighbors to be water (same rule must be used by BFS, LOS, and postprocess).
- **Monotonic relaxation:** corridor widening should only ever add allowed regions; never remove.
- **Determinism:** tie-breaking must be stable (especially for A*/Theta* variants).
- **Avoid allocations:** hot paths use typed arrays + stamps + `WeakMap` caches keyed by `GameMap`.

---

## 4) Tests and regression strategy

Existing tests worth keeping up to date:
- `tests/core/pathfinding/MultiSourceAnyTargetBFS.test.ts`
- `tests/core/pathfinding/CoarseToFineWaterPath.test.ts`

When integrating postprocessing (`pathPostprocessWaypointSpline`):
- prefer consuming `result.waypoints` / `result.tiles` without changing the pathfinding core again
