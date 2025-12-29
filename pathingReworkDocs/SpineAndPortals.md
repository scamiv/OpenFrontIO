# Spine & Portals (proposed): hierarchical portal-to-portal refinement

This is a **next-step design** (not implemented yet).

Goal: avoid “fine BFS floods the ocean” cases by keeping global routing coarse and confining fine searches to small, bounded regions.
This is the hierarchical version of the “BSP-ish” direction described in `pathingReworkDocs/CoarseToFine_BSPishRefinement.md`.

## What problem it targets

Our current corridor approach already avoids most global floods, but there are still pathological cases:
- the corridor accidentally includes a large open region, so the fine search can still expand a huge number of nodes before it finds the exit
- a thin channel opens into a big water body: once the search reaches the open area, the frontier gets enormous

The fix should be structural: stop doing a single monolithic fine search for the whole route.

## The core idea

1) Compute a coarse route (“spine”) on a low-resolution map.
2) Split that route into segments.
3) For each segment, refine *only between* two “portals”:
   - a portal is the set of fine water tiles that lie on the border between two adjacent coarse cells
4) Stitch segment results into a full fine path.

This gives you a hard locality property:
even if one segment needs widening/repair, it only blows up that segment’s window, not the entire ocean.

## Why this builds on the current groundwork

Spine & Portals reuses the pieces we already implemented for corridor refinement:
- fine→coarse mapping (`fineToCoarse`)
- stamp-based `allowedMask` corridor restrictions
- `visitedMaskOut` (to know where the fine search pushed)
- visited-driven widening (one ring around visited coarse regions)
- mask-expanding BFS (resume under widening corridor)

The difference is **where we apply them**:
- today: one corridor + one refine for the whole route
- proposed: a corridor/window per segment + one refine per segment

## Implementation sketch (step-by-step)

### 0) Choose maps

- `fineMap`: full-resolution boat navigation map (`gameMap`)
- `coarseMap`: 16x map (`microGameMap` / `map16x`)

### 1) Compute the coarse spine

Run the same multi-source/any-target search on `coarseMap` to get a coarse cell path.
Then tighten it with `rubberBandCoarsePath` so segments don’t inherit staircase noise.

If the coarse solve fails, fall back to the existing coarse-to-fine behavior (unrestricted fine BFS guardrail).

### 2) Choose coarse waypoints

Turn the coarse cell path into a waypoint list:
- always include endpoints
- include direction changes (“turns”)
- optionally include every Nth cell to bound maximum segment length

Waypoints define segments `(Wi -> Wi+1)`.

### 3) Build portals at segment boundaries

For each segment boundary where two adjacent coarse cells meet:
- each coarse cell corresponds to a fine rectangle
- the portal is the set of fine water tiles on the shared border between the two rectangles

Practical requirement:
- portal sets must be bounded; sample deterministically (e.g. take every Kth tile or take the K tiles closest to the segment direction)

### 4) Refine one segment (portal-to-portal)

For each segment:
1) Build an initial allowed coarse mask consisting of coarse cells within radius `r0` of the segment’s coarse cells.
2) Run fine `findWaterPathFromSeedsMaskExpanding(...)` with:
   - `seedNodes = entryPortalTiles`
   - `targets = exitPortalTiles`
   - `allowedMask = segment corridor`
   - widening callback = visited-driven widening (same rule as today)
3) On success, append the fine tiles to the global route and set the next segment’s entry portal based on the reached exit tile.
4) If the segment can’t be repaired within attempts, last resort is an unrestricted fine solve for that segment only.

### 5) Stitch + validate

Concatenate segment paths, ensuring:
- no duplicate join tiles at segment boundaries
- contiguity under the same move rules (king moves + no corner cutting)

Correctness stays simple:
the final stitched path is produced entirely by fine-res legal moves; coarse only proposes the decomposition.

## Determinism requirements (reviewer bait)

If this ever feeds hashes/simulation, determinism must be explicit:
- stable portal sampling order
- stable tie-breaking when selecting “which portal tile becomes the next entry”
- stable waypoint selection rules

## Why this should help the “river → ocean” case

The expensive part today is when the fine search reaches open water and the frontier balloons.
Spine & Portals prevents that by:
- letting the coarse route cross open water cheaply
- forcing the fine search to stay inside a bounded segment window
- widening only near the segment’s failure region, not the global ocean

## Where it plugs in

Add a sibling to the current coarse-to-fine helper, behind a feature flag:
- `findWaterPathFromSeedsSpineAndPortals(fineMap, coarseMap, seeds, targets, opts)`

Keep the same output type and the same final guardrail (unrestricted fine BFS).
