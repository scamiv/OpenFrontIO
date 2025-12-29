# Spine & Portals

**Hierarchical Coarse-to-Fine Path Planning with Portal-Based Refinement**

Goal: avoid “fine BFS floods the ocean” cases (e.g. thin river opens into huge water) by using coarse planning for global routing, and only doing fine-res search in local, bounded regions.

This builds directly on:
- `docs/CoarseToFine.md` (coarse corridor + safe fallback)
- `docs/LocalCorridorWidening.md` (stamp-based masks + adaptive relaxation on failure)

## Concept

- **Spine**: a coarse path on `microMap` (`map16x`) gives the global route structure.
- **Portals**: for each adjacent coarse-cell transition on the spine, define the set of fine water tiles that can legally cross between the two coarse cells.
- **Refinement**: solve the route as a sequence of **portal→portal** fine searches, each restricted to a small window around the current spine segment, with **local corridor widening** as the segment-level fallback.

The effect is “BSP-ish”: the search space only expands where the route is constrained or the coarse abstraction lies.

## Data / prerequisites (reused groundwork)

From `CoarseToFine` we already have:
- `fineToCoarse: Uint32Array` mapping for a `(fineMap, coarseMap)` pair
- stamp arrays used as `allowedMask` to restrict fine BFS to coarse regions

From `LocalCorridorWidening` we already have:
- `visitedMaskOut` (or equivalent) to discover which coarse regions were explored in a failed attempt
- cumulative widening: newly allowed coarse regions stay allowed across retries

Spine & Portals reuses those pieces; it just applies them **per segment** instead of for the whole path.

## Algorithm (implementation description)

### 0) Choose maps

- `fineMap`: full resolution water map used by boats (current `gameMap`).
- `corridorMap`: `microMap()` (16x) preferred; fall back to `miniMap()` (4x) if needed.
- `spineMap`: `nanoMap()` (derived from `microMap()`) preferred; fall back to `microMap()` if `nanoMap()` is too lossy.

### 1) Coarse “spine” planning

Run multi-source/any-target on `spineMap` (cheap) to get a coarse cell path:
- Sources: map fine seeds to coarse cells and dedupe
- Targets: map fine targets to coarse cells and dedupe

Important: coarse rules should be permissive enough to not reject valid fine connectivity (coarse is guidance, not truth).
If coarse planning fails, skip straight to unrestricted fine solve (same correctness guardrail as today).

### 2) Select waypoints on the spine

Turn the coarse cell path `C0..Cn` into waypoints:
- Always include endpoints
- Include cells at direction changes (“turns”)
- Optionally include every `N`th cell (to bound segment length)

Waypoints define segments `(Wi -> Wi+1)` along the spine.

### 3) Define portals (segment endpoints)

For a segment boundary between two adjacent coarse cells `A` and `B`:
- Consider the fine rectangle for each cell.
- The **portal set** is the set of fine water tiles on the shared border between the two rectangles.
- Optionally cap portal size by sampling (e.g. take every Kth tile, or take tiles closest to the segment direction) to reduce seed/target fanout.

For the first segment:
- “entry portal” comes from the original fine seeds (or the seed-adjacent water tiles).

For the last segment:
- “exit portal” targets are either the fine targets, or a portal into the coarse cell that contains the fine target region.

### 4) Refine each segment (portal→portal)

For each segment `(Wi -> Wi+1)`:

1) Build an initial allowed region mask consisting of coarse cells within radius `r0` of the spine segment cells.
2) Run fine `MultiSourceAnyTargetBFS` with:
   - `seedNodes = entryPortalTiles`
   - `targets = exitPortalTiles`
   - `allowedMask` = segment corridor
3) If it succeeds: append the segment path and set the next segment’s entry portal to the reached exit tile (or its portal neighborhood).
4) If it fails: apply **Local corridor widening** for this segment:
   - use `visitedMaskOut` from the failed attempt
   - widen the segment’s allowed coarse cells by 1 ring around visited coarse regions
   - retry up to `k` attempts
5) If still failing: last resort for this segment is an unrestricted fine solve between the same portals (or widen the segment corridor aggressively once, then fallback).

This keeps failures local: a single bad abstraction/tight choke only expands that segment’s window.

### 5) Stitch + validate

Concatenate segment paths, ensuring:
- no duplicate “join” tile (drop first tile of subsequent segments)
- path is contiguous under the same move rules (king moves + no corner cutting)

Correctness is guaranteed by construction because the final stitched path is entirely produced by fine-res BFS steps (coarse never “authorizes” a move).

## Why this fixes the “thin river → ocean” expensive case

The expensive part is when fine BFS exits a narrow channel and starts expanding into huge open water.
Spine & Portals prevents that by:
- routing across open water on **coarse** (tiny state space)
- only running fine BFS inside bounded segment windows (narrow around the spine)
- widening only when needed (segment-level, visited-driven)

## Tuning knobs

- `N` waypoint spacing (bigger = fewer segments, larger windows)
- `r0` initial segment corridor radius (smaller = faster, riskier)
- `k` local widening attempts (usually 2–4)
- portal sampling cap (trade seed/target fanout vs robustness)
- coarse movement permissiveness (avoid coarse false negatives)

## Integration points (where to put it)

Implement as a generic wrapper next to `findWaterPathFromSeedsCoarseToFine(...)`:
- `findWaterPathFromSeedsSpineAndPortals(...)`
- keep the same return type (`MultiSourceAnyTargetBFSResult | null`)
- keep the same fallback contract (unrestricted fine BFS is always the final guardrail)
