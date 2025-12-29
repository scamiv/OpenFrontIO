# Path postprocessing (waypoints + offshore + spline samples)

This document describes the `pathPostprocessWaypointSpline` line (`b1f05aba..9e8ac07e`).

High-level goal: keep the simulation path **tile-valid**, but make ship routes look and behave more like real navigation:
- fewer 45° “grid corners”
- less coast hugging
- optional smooth curve samples for rendering

Implementation (at `9e8ac07e`) lives in:
- `src/core/pathfinding/PathRubberBand.ts` (`rubberBandWaterPath`)
- `src/core/pathfinding/CoarseToFineWaterPath.ts` (post-process hook after refine)
- `src/core/game/TransportShipUtils.ts` (plumbs `waypoints`/`spline` into boat routes)

## Design constraints (why this is a post-pass)

1) **Zero gameplay risk:** don’t change reachability or legality rules. The post-pass must not create a route that crosses land.
2) **Deterministic + debuggable:** keep a concrete tile path for sim/hashing and for debugging (“what tiles did we traverse?”).
3) **Hot-path friendly:** this runs once per route, but on large maps it still needs hard bounds (no unbounded “try to push 30px in 8 dirs” loops).

Result: do all geometry improvements *after* the pathfinder returns a valid water tile path.

## Data contract (what we output)

The post-pass returns:
- `waypoints: TileRef[]` — sparse, line-of-sight polyline anchors
- `path: TileRef[]` — deterministic tile-expanded path derived from the waypoints
- `spline?: number[]` — optional sampled curve points (x,y pairs in tile coords), intended for rendering only

Rationale: callers can remain “tile based” (safe) while the renderer can consume the higher-level representation when available.

## Pipeline (as implemented)

### Pass 1: line-of-sight compression (“string pulling”)

Input: the original tile path (already legal water adjacency).

We build a sparse waypoint list by repeatedly choosing the **farthest** future path node that is still visible from the current anchor:
- visibility test uses Bresenham stepping through tiles and checks `gm.isWater`
- when `noCornerCutting` is enabled, diagonals require both touching orthogonals to be water (same rule as BFS)

Performance notes:
- LOS is O(segment length), so the algorithm is bounded by a `maxLookahead`.
- The implementation uses a “gallop + binary search” pattern to reduce LOS checks per anchor.

Why this decision:
- It removes staircase noise without touching the solver.
- It gives “any-angle” segments in open water while staying compatible with tile-based validation.

### Pass 2: offshore snapping (optional, waypoint-only)

Problem: even after LOS compression, waypoints can sit near the coast, producing routes that “hug” shorelines.

For each **interior** waypoint (we keep first/last unchanged):
1) Consider a local square window around the waypoint (`windowSize` must be odd to avoid bias).
2) Compute a local “depth” field inside the window: distance-to-land (Chebyshev) via a small BFS seeded from land tiles in the window.
3) Choose the **deepest** water tile in the window that preserves LOS-water to both neighboring waypoints (prev→candidate and candidate→next).
4) Apply all snaps simultaneously, then validate that each consecutive segment is still LOS-water; if any segment fails, discard snapping entirely and keep the pass-1 waypoints.

Why this decision:
- It’s deterministic, local, and bounded.
- It pushes the route toward safer/deeper-looking water without inventing new waypoints or changing connectivity.
- The “all segments must remain LOS-water” validation prevents the post-pass from cutting corners into land.

### Final: reconstruct a tile-valid path

We expand each waypoint segment back into tiles using Bresenham stepping and concatenate them.

This keeps the execution/simulation layer unchanged: it still receives a tile path.

### Optional: spline sampling (rendering aid)

If enabled, we sample a smooth curve from the waypoint polyline (Catmull–Rom in `9e8ac07e`):
- samples are emitted in tile coordinates (tile centers)
- we run a conservative “samples stay on water” check; if any sample fails, we omit the spline

This does not affect the tile-valid `path`. It’s a visual/motion hint only.

## How this plugs into the routing stack

`findWaterPathFromSeedsCoarseToFine(...)` is responsible for the *actual* route.
After refine returns `{ source, target, path }`, we post-process it and attach:
- `result.path = post.path` (tile-valid)
- `result.waypoints = post.waypoints`
- `result.spline = post.spline` (optional)

Callers (e.g. `TransportShipUtils`) can then stash these on the unit/route object.

## Rendering integration (what’s still missing)

This branch produces `waypoints`/`spline`, but making ships actually *move* along them requires renderer plumbing.

Minimal integration plan:
1) **Transport/trade/warship renderers**: if `route.spline` exists, render that; else render `route.waypoints`; else render the tile polyline.
2) **Movement interpolation**: keep server/sim authoritative on tiles, but drive the client’s displayed position by:
   - mapping “progress along tile path” to “progress along waypoint polyline/spline” (approximate arc-length)
   - smoothing heading changes at waypoint boundaries (no instantaneous turns)
3) **Debug switch**: always allow a toggle to display the underlying tile path to debug bad segments.

## Relationship to future work

- Works with `pathingReworkDocs/SpineAndPortals.md`: portals change *where* we search; this changes *how the result looks*.
- If we later add Lazy Theta* (any-angle refinement), its sparse parent chain can feed the same waypoint/spline contract.
