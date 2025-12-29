# Water pathfinding evolution (from `main` → `lazy-theta`) — scientific / “paper” notes

This document explains the *algorithmic* evolution of OpenFront’s water routing on the `lazy-theta` line, using a research-y framing: problem definition, graph model, method, and properties. For a narrative version, see `pathingReworkDocs/PathfindingEvolution.md`. For code-level notes, see `pathingReworkDocs/PathfindingEvolution_Core.md`.

---

## Abstract

We study a practical water-path routing problem on a large 2D grid under deterministic simulation constraints. The baseline "flood the ocean" approach is replaced by a pipeline that (1) collapses spawn/landing choice into a single multi-source / any-target search, (2) rejects impossible routes using connected-component labels on water, (3) reduces search space via coarse-to-fine corridor planning with monotonic constraint relaxation, and (4) post-processes tile paths into sparse waypoints/splines for natural movement. As an optional refine-stage extension, we also integrate Lazy Theta* to reduce expansions in open water while still emitting a deterministic tile-valid path via Bresenham expansion.

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
- `aa09240d` is tagged `SpineAndPortals` in git history, but that commit is local corridor widening (no portal/spine abstraction yet).
- A real "Spine & Portals" hierarchy (see `pathingReworkDocs/SpineAndPortals.md`) likely comes before Lazy Theta*.

### Pathfinding branches + commits (repro)

```
main (02a6ac58)
└─ MultiSourceAnyTargetBFS (02a6ac58..69e422d3)
   └─ CoarseToFine (69e422d3..368f5c59)
      └─ BSPish (368f5c59..b1f05aba)
         ├─ lazy-theta (b1f05aba..a6050794)
         └─ pathPostprocessWaypointSpline (b1f05aba..9e8ac07e)
```

Commit lists per branch:

- `MultiSourceAnyTargetBFS` (`02a6ac58..69e422d3`): `65ca00d5`, `4564f9e4`, `9769cf25`, `722c0235`, `790600e9`, `69e422d3`
- `CoarseToFine` (`69e422d3..368f5c59`): `e08acdf0`, `27762942`, `368f5c59`
- `BSPish` (`368f5c59..b1f05aba`): `aa09240d`, `7bd7d35d`, `f3edd553`, `26d215b8`, `b1f05aba`
- `pathPostprocessWaypointSpline` (`b1f05aba..9e8ac07e`): `ae9a8cc8`, `89d638a0`, `9e8ac07e`
- `lazy-theta` (`b1f05aba..a6050794`): `a6050794`

Linear commit sequence since the branch point:
`65ca00d5 → 4564f9e4 → 9769cf25 → 722c0235 → 790600e9 → 69e422d3 → e08acdf0 → 27762942 → 368f5c59 → aa09240d → 7bd7d35d → f3edd553 → 26d215b8 → b1f05aba → a6050794`.

---

## 1) Problem statement

Given a map grid and movement rules for ships:

- **Environment:** a 2D grid `W×H` with boolean traversability `water(t)` for tile `t`.
- **Move model:** 8-neighbor (“king moves”) with optional **no-corner-cutting** (diagonal moves require both adjacent orthogonals traversable).
- **Sources:** a set of candidate water tiles `S` (e.g., owned shore-adjacent water for spawn).
- **Targets:** a set of candidate water tiles `T` (e.g., enemy shore-adjacent water or “any water near click”).
- **Goal:** find a path from *any* `s ∈ S` to *any* `t ∈ T` subject to movement constraints, with:
  - deterministic output (stable for sim / hashing),
  - hot-path performance on very large maps,
  - “natural” geometry preferred (long straight runs across open ocean).

This is **multi-source / any-target** routing. A naive implementation often performs repeated flood-fills or repeated A* searches per source/target candidate (MSMD), which scales poorly and produces brittle “optimize by early-exit” heuristics.

---

## 2) Formal graph model

Define a directed (or undirected) graph `G=(V,E)` induced by the grid:

- `V = { t | water(t) }`.
- `(u,v) ∈ E` iff `v` is a neighbor of `u` under the movement rules (4- or 8-neighbor; with diagonal legality depending on corner-cut rule).

The multi-source / any-target problem can be reduced to single-source / single-target by adding virtual nodes:

- Add `s*` with edges `(s*, s)` for all `s ∈ S`.
- Add `t*` with edges `(t, t*)` for all `t ∈ T`.

Then compute a shortest path from `s*` to `t*`. In the unweighted case this is BFS; in the weighted case Dijkstra/A* apply. Importantly, you don’t need to build the virtual nodes explicitly: you seed the frontier with all sources, and you stop when you *dequeue* any target (not when you first discover it).

---

## 3) Evolution of the method (algorithmic contributions)

This branch evolves in a “correct first, then reduce search space, then reduce node work” order.

### 3.1 Multi-source / any-target BFS (unweighted baseline)

Implemented in `src/core/pathfinding/MultiSourceAnyTargetBFS.ts` (see `pathingReworkDocs/MultiSourceAnyTargetBFS.md`).

Key property:
- With uniform edge costs, BFS yields a shortest path in number of steps.
- Multi-source initialization yields the best source automatically.
- Any-target termination is valid only when the target is *popped* from the FIFO queue.

This step removes the need for repeated flood-fills per candidate source/target.

### 3.2 Water connected components (reachability pruning)

Implemented in `src/core/pathfinding/WaterComponents.ts`.

Compute component labels `comp(t)` over water tiles (typically 4-neighbor connectivity) once per map:
- If `comp(s) != comp(t)` then no path exists; abort early.

This reduces worst-case wasted searches (e.g., lakes vs ocean) to O(1) checks.

### 3.3 Coarse-to-fine corridor planning (search-space reduction)

Implemented in `src/core/pathfinding/CoarseToFineWaterPath.ts` and `pathingReworkDocs/CoarseToFine.md`.

Idea:
- Plan on a downsampled map to obtain a coarse route (cheap).
- Inflate this coarse route into an **allowed-region mask** (“corridor”).
- Refine on the fine map *restricted to the corridor*.

Implementation detail (performance):
- Use stamp-based masks `allowedMask.regionStamp[region] == allowedMask.stamp` to avoid per-call allocations.
- Maintain a `tileToRegion[tile]` mapping (fine→coarse region id).

This step attacks the dominant cost: `|V|` for BFS on huge oceans.

### 3.4 Monotonic constraint relaxation (local widening; mask-expanding search)

Two related refinements exist in this line:

1) **Local widening:** on refine failure, expand the corridor around regions actually visited (data: `visitedMaskOut`).
2) **Mask-expanding search:** instead of restarting the fine search after widening, continue the same search state and only enqueue newly-enabled frontier neighbors.

The crucial invariant is *monotonicity*:
- corridor expansion only **adds** allowed regions; it never invalidates already visited nodes.

This keeps correctness (“found paths are valid”) while avoiding repeated “restart + re-walk” churn.

### 3.5 “Rubber-band” coarse spine (corridor tightening)

Implemented in `src/core/pathfinding/PathRubberBand.ts`.

Observation:
- A coarse grid path has staircase artifacts.
- Inflating a staircase path inflates corridor area unnecessarily.

Solution:
- Perform LOS-based compression on the coarse path to obtain a small set of straight segments (“spine”).
- Build the corridor mask from the spine segments rather than the original step-by-step path.

Effect:
- Smaller corridor area → fewer fine expansions for the same start/goal pair.

### 3.6 Lazy Theta* refinement (reduce node work; improve geometry)

Implemented in `src/core/pathfinding/LazyThetaStar.ts` and described in `pathingReworkDocs/lazytheta.md`.

Motivation:
- Even inside a corridor, BFS explores *area*.
- Open ocean wants “go straight”; A*-family search explores mostly along the heuristic direction.

Lazy Theta* produces any-angle parent chains on a grid:
- It performs A*-style relaxations but “repairs” parent edges lazily with line-of-sight checks when nodes are closed.

In this codebase, it is implemented with:
- **Euclidean** `g` and `h` to align with the any-angle objective.
- Deterministic tie-breaks (`f`, then `h`, then tile id).
- Final output expansion via Bresenham (`BezenhamLine`) to maintain deterministic tile-valid paths.

Output contract:
- `{ source, target, waypoints, tiles }` (plus `path` alias).
  - `waypoints`: sparse any-angle chain for downstream smoothing / postprocessing.
  - `tiles`: deterministic tile expansion of waypoint segments for sim compatibility.

---

## 4) Pipeline at the `lazy-theta` milestone

At a high level:

1) Build candidate `S` and `T` at fine resolution (domain logic).
2) Filter candidates by water component id (`WaterComponents`).
3) Coarse plan on downsampled map (`CoarseToFineWaterPath`).
4) Tighten coarse plan via LOS compression (rubber-band spine).
5) Build corridor mask from spine (stamp mask).
6) Refine inside corridor using one of:
   - unweighted BFS (`MultiSourceAnyTargetBFS`), or
   - Lazy Theta* (`LazyThetaStar`), producing waypoints + tiles.
7) If corridor is too restrictive:
   - widen mask locally (visited-driven), optionally without restart.
8) Final correctness guardrail: if constrained refine fails, fall back to unrestricted fine search.

The refine stage is selectable via `refineMode: "bfs" | "lazyTheta" | "auto"` in `src/core/pathfinding/CoarseToFineWaterPath.ts`. In practice we keep BFS as the default until the corridor + postprocess pipeline is stable; Lazy Theta* is an opt-in/late-stage refinement knob.

---

## 5) Properties and complexity (informal)

### 5.1 Correctness (validity)

All reported paths must satisfy:
- Traversability: every emitted tile is water.
- Move legality: diagonal steps respect no-corner-cutting when enabled.
- Corridor legality: if a corridor mask is active, all visited/expanded tiles must lie in allowed regions (except final unrestricted fallback).

Lazy Theta* adds:
- Parent edges are validated by LOS; expanded segments are re-validated by LOS before emitting tiles.

### 5.2 Optimality

- Unweighted BFS inside a fixed allowed region is shortest in steps within that region.
- Corridor planning is heuristic (coarse map is approximate), so the overall method is not globally optimal on the fine map; it is designed for performance with guardrail fallback.
- Lazy Theta* with Euclidean costs optimizes a continuous-ish objective over a discrete substrate; it yields “natural” geometry but is not intended to be strictly shortest in fine-grid step count.

### 5.3 Determinism

Determinism is treated as a first-class requirement:
- stable iteration order over neighbors,
- stable tie-breaking in priority queue (Lazy Theta*),
- deterministic segment expansion (Bresenham),
- avoid nondeterministic data structures (`Set`, hash iteration).

### 5.4 Runtime intuition

Let `N = W·H` and let `A` be the area of the allowed corridor in fine tiles:
- Full-map BFS is `O(A)` with `A≈N` in the worst case (ocean floods).
- Coarse-to-fine targets the dominant term by making `A << N` for typical routes.
- Rubber-banding reduces `A` further by removing staircase inflation.
- Lazy Theta* reduces node work inside `A` (fewer popped nodes) for open water, trading some extra bookkeeping and LOS checks.

---

## 6) Notes for future work (out of scope for this branch)

- **Deep-water preference:** can be modeled as a cost term or as a monotonic “constraint relaxation” (e.g., depth threshold that relaxes if no route). Lazy Theta* provides a natural hook if/when weights are introduced.
- **True hierarchical planning / portals:** would reduce both region size *and* node work by routing over an explicit abstract graph (HPA*/navmesh-like). The current pipeline keeps implementation complexity low while capturing a large fraction of the benefit.
