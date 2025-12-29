# Water pathfinding evolution (from `main` → `lazy-theta`) — general audience

This branch series is a case study in “how to do pathfinding right”:
start with something correct and simple, then add *measured* optimizations and abstractions without breaking determinism.

If you don’t care about implementation details, the headline is:

1) **One search, not many:** multi-source / any-target BFS picks the best spawn and landing in a single run.
2) **Don’t search the impossible:** precompute connected water bodies and reject routes that can’t exist.
3) **Don’t flood the whole ocean:** plan on a low-res map, then refine only inside a corridor.
4) **Relax locally, not globally:** when the corridor is wrong, widen where the search actually tried, not everywhere.
5) **Make ships look like ships:** post-process the final tile path into sparse waypoints/splines and push it offshore.
6) **(Optional later) Any-angle refinement:** Lazy Theta* can reduce expansions and improve geometry once the pipeline is solid.

---

## Milestone index (docs + branches)

There are two kinds of signposts in this history:
- **Doc checkpoints**: commits that introduced/updated a design doc (best entry points).
- **Branch bookmarks**: branch names that mark major new ideas.

### Doc checkpoints (read these first)

- `pathingReworkDocs/MultiSourceAnyTargetBFS.md` (BFS invariants) - `65ca00d5..69e422d3`
- `pathingReworkDocs/CoarseToFine.md` (corridor plan+refine) - `e08acdf0..368f5c59`
- `pathingReworkDocs/LocalCorridorWidening.md` (visited-driven widening) - `aa09240d`
- `pathingReworkDocs/MaskExpanding.md` (widen mask without restart) - `7bd7d35d`
- `pathingReworkDocs/lazytheta.md` (optional later) - `a6050794`

### Branch bookmarks (major ideas)

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
- A real "Spine & Portals" hierarchy (as described in `pathingReworkDocs/SpineAndPortals.md`) likely comes **before** Lazy Theta* in practice.

### Pathfinding branches (tree + commit ranges)

The pathing rework uses branches to mark *major ideas* (not every single step).
This is the relationship between the important pathfinding branches and the commits that belong to them.

```
main (02a6ac58)
└─ MultiSourceAnyTargetBFS (02a6ac58..69e422d3)
   └─ CoarseToFine (69e422d3..368f5c59)
      └─ BSPish (368f5c59..b1f05aba)
         ├─ lazy-theta (b1f05aba..a6050794)          (optional later)
         └─ pathPostprocessWaypointSpline (b1f05aba..9e8ac07e)
```

#### MultiSourceAnyTargetBFS (efficient boat routing algorithms)

Range: `02a6ac58..69e422d3`
- `65ca00d5` Multi-source / any-target BFS (baseline water routing)
- `4564f9e4` Integrate into transport routing (seed origins → pick best spawn)
- `9769cf25` Unify trade/warship routing on the same helpers
- `722c0235` Water component ids (reject impossible searches)
- `69e422d3` Docs checkpoint: `pathingReworkDocs/MultiSourceAnyTargetBFS.md`

#### CoarseToFine (coarse-to-fine pathfinding for water navigation)

Range: `69e422d3..368f5c59`
- `e08acdf0` Coarse plan + corridor mask + refine
- `27762942` Expose low-res maps (microMap plumbing)
- `368f5c59` Docs checkpoint: `pathingReworkDocs/CoarseToFine.md`

#### BSPish (rubber-band corridor + adaptive refinement)

Range: `368f5c59..b1f05aba`
- `aa09240d` Local corridor widening (visited-driven) + `pathingReworkDocs/LocalCorridorWidening.md`
- `7bd7d35d` Mask-expanding BFS (no restart) + `pathingReworkDocs/MaskExpanding.md`
- `f3edd553` Tune corridor defaults (avoid “optimistic coarse water” cliffs)
- `26d215b8` Prefer `microMap` (16x) for coarse planning
- `b1f05aba` Rubber-band coarse spine (tighten corridor)

#### pathPostprocessWaypointSpline (path postprocessing: waypoints + spline output)

Range: `b1f05aba..9e8ac07e`
- `ae9a8cc8` Post-refine string pulling; expose sparse polyline (waypoints)
- `89d638a0` Offshore waypoint snapping + robust LOS compression
- `9e8ac07e` Offshore depth snap + spline output

#### lazy-theta (Lazy Theta* water refinement)

Range: `b1f05aba..a6050794`
- `a6050794` Lazy Theta* refine mode (optional later) + `pathingReworkDocs/lazytheta.md`

---

## Timeline (step-by-step)

Below is the chronological evolution from the branch point on `main`.

### 1) `65ca00d5` — Multi-source / any-target BFS (water only)

Problem:
- Boats need to go from “one of many possible spawn waters” to “any of many target waters”.
- Doing repeated single-source searches (or “guess destination then search”) wastes work.

Change:
- Add `MultiSourceAnyTargetBFS` (unweighted BFS) that starts from **many sources** and stops at **any target**.
- Returns `{ source, target, path }` so the caller learns which source won.

Why it’s “right”:
- BFS is optimal on unweighted graphs.
- Any-target early exit is correct **only** when stopping on *dequeue* (pop), not discovery.

### 2) `4564f9e4` — Integrate BFS into transport ship routing

Problem:
- Transport routing needs a *real* `{src,dst}` pair: which owned shore to spawn from and which enemy shore to land at.

Change:
- `TransportShipUtils` builds:
  - seeds = water tiles adjacent to candidate owned shores
  - targets = water tiles adjacent to candidate enemy shores
- BFS returns:
  - which shore was the winning spawn origin
  - which target-water was reached
  - then we map that target-water back to a landing shore

Why it’s “right”:
- We now compute `{src,dst}` as a consequence of the shortest route, not as a pre-guess.

### 3) `9769cf25` — Reuse the same water routing for trade ships and warships

Problem:
- Multiple unit types were solving essentially the same “boat route” problem in different ways.

Change:
- Trade ships and warships are migrated to the shared boat routing helpers.

Why it’s “right”:
- One algorithm, one set of invariants, one place to optimize.

### 4) `722c0235` — Water body (connected component) IDs

Problem:
- The map contains lakes/oceans separated by land. Searching from a lake to the ocean is pointless.

Change:
- Precompute a `waterComponentId` per tile (connected water bodies).
- Filter seeds and targets to overlapping components before searching.

Why it’s “right”:
- Prevents “impossible” searches from ever starting.
- Allows removing blunt “give up after N visited tiles” style cutoffs.

### 5) `790600e9` — Instrumentation detour (console timing)

Problem:
- Without numbers, you can’t tell if changes help or just move cost around.

Change:
- Temporary logging to see timings and step counts at runtime.

Why it’s “right”:
- You optimize what you can measure.

### 6) `e08acdf0` — Coarse-to-fine corridor (global plan, local refine)

Problem:
- Even with good BFS, worst-case flooding of huge water regions can be expensive on large maps.

Change:
- Plan on a smaller (coarse) map to get a *rough route*.
- Inflate that coarse route into a **corridor mask**.
- Refine on the fine map while staying inside the corridor; if it fails, fall back to full fine search.

Why it’s “right”:
- Uses hierarchy: “cheap guidance” + “exact refinement”.

### 7) `aa09240d` — Local corridor widening (don’t widen the whole world)

Problem:
- Coarse maps lie: thin rivers / peninsulas can be lost at low resolution.
- Global radius growth can unlock huge ocean regions unnecessarily.

Change:
- When refine fails inside the corridor:
  - mark which coarse regions the fine search actually visited
  - widen only around those visited regions (cumulative)

Why it’s “right”:
- Pay more only where the constraint was wrong.

### 8) `7bd7d35d` — Mask-expanding BFS (avoid restart churn)

Problem:
- “Try corridor → fail → widen → restart” repeats work.

Change:
- Keep one BFS state; when the queue exhausts, expand the allowed mask and keep going.

Why it’s “right”:
- Still sound (finds a valid path if one exists under the eventually-allowed corridor).
- Much less repeated work on “almost good” corridors.

### 9) `26d215b8` + `b1f05aba` — Better corridors (microMap + rubber-band spine)

Problem:
- A coarse path can be zig-zaggy, and inflating it creates a fat, expensive corridor.

Change:
- Use `microMap` (16x) for coarse planning.
- “Rubber-band” the coarse path into fewer straight segments (line-of-sight), then expand that back into a tight spine.

Why it’s “right”:
- Smaller corridor ⇒ fewer fine expansions.

### 10) `9e8ac07e` - Post-process: smooth + offshore + spline/waypoints (sibling branch)

Problem:
- Even a correct tile-valid path looks griddy and can hug coasts.

Change:
- Post-process the final tile path:
  - LOS-compress into sparse waypoints
  - push waypoints away from shore (using map distance-to-land / depth signal)
  - (later) have rendering/movement consume the spline/waypoints directly

Why it's right:
- Pure post-pass: doesn't change reachability or correctness, only the produced geometry.
- Complements everything else (corridors, mask expansion, future hierarchy).

### 11) `a6050794` - (Optional later) Lazy Theta* refinement mode

Problem:
- Even inside a corridor, BFS explores area; in open water you’d prefer “go straight”.

Change:
- Add `LazyThetaStar` refinement mode (optional):
  - produces **sparse any-angle waypoints**
  - expands them deterministically into `tiles` via Bresenham

Why it’s “right”:
- A*-family search reduces expansions in open regions.
- Likely comes after a true hierarchy step (Spine & Portals) is in place and we have stable metrics.
- Output is both “pretty” (waypoints) and “safe” (tile-expanded determinism).

---

## Where we are now (conceptually)

For a boat route we typically do:

1) Build candidate **sources** (owned shore-adjacent water) and **targets** (enemy shore-adjacent water).
2) Filter by **water component** (same connected water body).
3) Coarse-to-fine:
   - coarse plan → corridor mask
   - refine inside corridor (BFS today; Lazy Theta* is an optional later knob)
   - if corridor fails, locally widen; only then consider full fallback
4) Output:
   - `path`/tiles for deterministic simulation
   - (next) sparse `waypoints`/spline for natural ship movement/rendering

If you want the implementation details, see:
- `pathingReworkDocs/PathfindingEvolution_Core.md`
- `pathingReworkDocs/PathfindingEvolution_Scientific.md`
