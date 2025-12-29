# “BSP-ish” refinement strategies (boats)

This doc explains what we mean by “BSP-ish” in the context of OpenFront water pathfinding and why we evolved the refine stage the way we did.

It also captures the next refinement ideas in a form that is implementable (and reviewable), not just a brainstorm.

## The underlying problem

We already have a cheap coarse solve (`map16x` corridor planning).
The expensive failures happen when the fine search is forced to explore far more area than the route actually needs:
- a small abstraction error (optimistic coarse water, minimap tearing)
- a narrow channel opening into a huge ocean
- a corridor that accidentally includes a massive open region

If the response is “drop the mask and floodfill the whole ocean”, the coarse stage becomes pointless.

## What “BSP-ish” means here (no magic trees)

We are not literally building a BSP tree.

We are aiming for the *behavior* you get from hierarchical / partition-refinement methods:
- plan globally at low resolution
- refine locally at high resolution
- expand the expensive search space only near the part that is actually constrained

In other words: **localize the cost**, don’t pay “ocean-sized” prices for “river-sized” mistakes.

## What is implemented today (the current refinement stack)

The current implementation is described in:
- `pathingReworkDocs/CoarseToFine.md`
- `pathingReworkDocs/LocalCorridorWidening.md`
- `pathingReworkDocs/MaskExpanding.md`

Summary of the actual algorithm:
1) coarse BFS produces a coarse path
2) we build a corridor mask around that path (tightened via rubber-banding)
3) we run a fine search under that mask
4) when the fine queue exhausts, we widen the corridor *around the coarse regions actually visited*
5) widening is capped; final guardrail is unrestricted fine BFS

Why this was chosen first:
- It is minimally invasive (doesn’t change move legality, doesn’t introduce heuristics).
- It is easy to reason about (monotonic widening + unconditional fallback).
- It eliminates the “restart churn” cost by resuming the fine BFS (mask-expanding BFS).

## If we still see spikes: what to do next

At this point the remaining spikes are usually “open region unlocked”, not “BFS is slow”.
The next steps should change the *shape of the search space*, not micro-optimize the queue.

### 1) Segment-limited refinement (local windows along the coarse route)

Idea:
- turn the coarse route into a small set of waypoints (endpoints + turns + every N cells)
- refine each waypoint segment independently inside a small local window around that segment
- stitch the segment results

Why it helps:
- it puts a hard bound on how much fine area any single segment can unlock
- narrow “problem areas” don’t blow up the whole route

Why it’s not the first step:
- you need robust stitching rules and deterministic waypoint selection
- you need to ensure segment endpoints correspond to reachable fine water tiles

### 2) Spine & Portals (hierarchical portal-to-portal refinement)

This is the “proper” hierarchical version of segment-limited refinement:
- coarse path becomes the global “spine”
- adjacent coarse cells define “portals” (fine tiles on their shared border)
- refine as a sequence of portal-to-portal searches

This is documented in `pathingReworkDocs/SpineAndPortals.md`.

Why it helps:
- it keeps the fine search naturally constrained (each segment is anchored at a portal boundary)
- it makes “river → ocean” cases cheap because the global routing stays coarse

Cost:
- more plumbing (portal extraction, sampling, stitching)
- more determinism requirements (portal ordering / selection)

### 3) Any-angle refinement (Lazy Theta*) (optional later)

Lazy Theta* is a refine-stage solver that tends to expand far fewer nodes in open water than BFS.
It is best treated as an optional upgrade once the hierarchy/corridor logic is stable:
- see `pathingReworkDocs/lazytheta.md`

Why it’s later:
- it introduces more moving parts (heap, floating costs, tie-breaking)
- it’s easier to debug after the “where do we search?” problem is solved
