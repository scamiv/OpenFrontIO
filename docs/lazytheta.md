# Lazy Theta* (any-angle water refinement)

Goal: reduce “refine BFS floods the ocean” work and improve path geometry by using an any-angle planner in the refine stage, while keeping the result deterministic and tile-valid.

This is a **refine-stage replacement/option**, not a new high-level routing strategy:
- coarse planning still chooses *where* to go (corridor/spine/etc.)
- Lazy Theta* chooses *how* to traverse within the allowed region with far fewer expansions in open water

## Why Lazy Theta* here

- **Open ocean:** BFS expands area; an A*-family search expands mostly along the heuristic direction.
- **Any-angle geometry:** parent pointers can skip across many tiles; we expand final segments with Bresenham to keep a tile-valid path.
- **Bounded LOS work:** the “lazy” variant doesn’t do LOS checks on every neighbor relaxation.
- **Future-fit:** later deep-water preference is naturally “weighted A*”.

## Integration point (cleanest in this codebase)

Add a refinement solver next to `MultiSourceAnyTargetBFS`:

- `src/core/pathfinding/LazyThetaStar.ts`
  - `findWaterPathFromSeeds(gm, seedNodes, seedOrigins, targets, opts): MultiSourceAnyTargetBFSResult | null`
  - supports `allowedMask` (coarse corridor) and `noCornerCutting`
  - returns `{ source, target, waypoints, tiles, path }`
    - `waypoints`: any-angle parent chain (sparse)
    - `tiles`: deterministic tile expansion of `waypoints` (Bresenham)
    - `path`: currently aliases `tiles` for compatibility with existing callsites

Then in `src/core/pathfinding/CoarseToFineWaterPath.ts`:
- make refine stage selectable:
  - `refineMode: "bfs" | "lazyTheta" | "auto"` (default `"bfs"`)
- keep the same correctness guardrail:
  - if refinement fails under the mask, widen / fall back exactly as today

Rule of thumb for `"auto"` (cheap and safe):
- use Lazy Theta* when seed/target fanout is small (heuristic is cheap)
- otherwise use the existing mask-expanding BFS

## Core algorithm sketch (Lazy Theta*)

Terminology: `g(n)` cost-so-far, `h(n)` heuristic-to-goal, `f(n)=g+h`.

### Multi-source + any-target

- Multi-source: initialize the open set with **all seed tiles** with `g=0`.
- Any-target: stop when the best node popped is a target.
- If seeds/targets are huge, cap/sampling should happen **before** calling this (same as today).

### Move model / costs

- Expansion graph stays **8-neighbor grid** (same legality rules as today).
- `noCornerCutting` is enforced for diagonals.
- `allowedMask` restricts which tiles are traversable (corridor).

Costs / heuristic (what we currently implement):
- `g` uses straight-line distance for the (potentially long) parent edge: `dist(parent, node)` (Euclidean).
- `h` uses straight-line distance to the nearest target: `min(dist(node, t))` (admissible).

### Where LOS comes in

Lazy Theta* is Theta*-style, but it avoids doing LOS checks on every relaxation by being optimistic and fixing parents lazily:

1) **Optimistic relaxation (no LOS check)**
   - for each neighbor `n` of `s`, propose connecting via `parent(s)`:
     - `g2 = g(parent(s)) + dist(parent(s), n)`
     - `parent(n) = parent(s)`
   - this can create long any-angle parent edges in open water

2) **SetVertex(s) on pop (repair)**
   - when `s` is popped, if `LOS(parent(s), s)` fails (water + no-corner-cutting + mask):
     - choose the best already-closed neighbor `p` of `s`:
       - minimize `g(p) + dist(p,s)`
       - set `parent(s)=p`, update `g(s)`

This gives sparse any-angle waypoint chains in practice while bounding LOS checks.

## Output: keep it tile-valid (deterministic)

- Reconstruct the waypoint chain by following `parent[]` from the reached target.
- Validate each segment `(A -> B)` with the same LOS predicate used by the solver.
- Expand each segment via Bresenham into tile refs and concatenate.

This keeps the returned `path: TileRef[]` compatible with existing callers (and hashing/validation).

## Performance plan (hot path friendly)

- Use stamp + typed arrays sized to `gm.width()*gm.height()` (like BFS).
- Use a custom binary heap with deterministic tie-breaking (`f`, then `h`, then tile id).
- Cache per-map scratch via `WeakMap<GameMap, LazyThetaStar>` to avoid per-call allocations.

## Testing plan

Add focused tests alongside existing pathfinding tests:

1) All-water map:
   - finds a route (and should expand far fewer nodes than BFS in practice)
2) Tight corridor map:
   - still finds a valid route (or falls back via the coarse-to-fine guardrails)
3) Island obstacle:
   - never returns a path that touches land
