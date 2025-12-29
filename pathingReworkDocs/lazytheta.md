# Lazy Theta* (optional later): any-angle refinement inside a corridor

This is a **future/optional** refinement-stage idea.
Current stance: keep the refine stage on BFS until the corridor / widening / portal hierarchy is solid and easy to debug.

## Why consider Lazy Theta*

Lazy Theta* is an A*-family algorithm that tends to:
- expand far fewer nodes than BFS in open water (frontier doesn’t balloon into an area flood)
- naturally produce an any-angle parent chain (straight runs collapse into long segments)

That matches what we want for ships:
- global routing should be cheap
- open ocean should not be floodfilled
- geometry should look “steered”, not “staircased”

## Where it fits in our stack (clean integration point)

Lazy Theta* is a **refine-stage replacement/option**, not a new high-level routing strategy:
- coarse planning still decides *where* to go (corridor, spines/portals, etc.)
- the refine solver decides *how* to traverse inside the allowed region

Planned file: `src/core/pathfinding/LazyThetaStar.ts`

Planned entry point (mirrors BFS):
- `findWaterPathFromSeedsLazyTheta(fineMap, seedNodes, seedOrigins, targets, opts): Result | null`
- supports `allowedMask` and `noCornerCutting` using the same predicates as BFS

Return contract (for compatibility with later post-processing):
- `{ source, target, waypoints, path }`
  - `waypoints`: sparse any-angle parent chain (debuggable anchors)
  - `path`: deterministic tile-expanded segments via Bresenham (simulation-safe)

Rationale for returning both:
- the sim/execution layer still wants a tile-valid path
- postprocessing/rendering can use the sparse waypoints without re-running pathfinding

## Cost model and heuristic (pick one and stay consistent)

If the search graph is the standard 8-neighbor grid:
- edge costs: orthogonal = `1`, diagonal = `sqrt(2)`
- heuristic: octile distance (consistent and fast)

If we later decide the objective is truly “any-angle Euclidean length”, then both `g` and `h` should be Euclidean. That is a bigger semantic shift and should be done intentionally (with tests).

## Lazy Theta* mechanics (what makes it “lazy”)

We still expand neighbors like A*.
The “Theta” part comes from parent rewiring via line-of-sight (LOS), but Lazy Theta* delays the expensive LOS check:

1) **Relax neighbors normally**
- for each neighbor `n` of current node `s`:
  - propose `g2 = g(s) + cost(s,n)`
  - if `g2` improves `g(n)`, set `parent(n)=s` and push/update in the open set

2) **Repair parent on pop (`SetVertex`)**
- when `s` is popped:
  - if `parent(s)` does not have LOS to `s` (water-only + no-corner-cutting):
    - choose the best already-closed neighbor `p` to become the parent:
      - minimize `g(p) + cost(p,s)`
    - update `parent(s)=p`, `g(s)=...`

This yields long straight parent chains in open water without doing an LOS test for every neighbor relaxation.

## Determinism requirements

If this ever impacts hashes/simulation, determinism must be explicit:
- stable tie-breaking in the priority queue (`f`, then `h`, then tile id)
- stable neighbor expansion order
- stable LOS predicate (must match BFS + postprocessing)

## Testing plan (what would make reviewers happy)

Minimal tests (compare against BFS for validity, not necessarily identical paths):
1) All-water map: expands far fewer nodes than BFS; produces near-straight waypoints; expanded tiles stay water.
2) Tight corridor: still finds a valid route; doesn’t regress correctness.
3) Island obstacle: routes around land; expanded tiles never include land; no-corner-cutting respected.

## Relationship to other docs

- Complements `pathingReworkDocs/MaskExpanding.md`: both aim to avoid wasted work when the corridor is “almost right”.
- Likely comes **after** `pathingReworkDocs/SpineAndPortals.md`: first fix “where do we search?”, then optimize “how do we search inside it?”.
