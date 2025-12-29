# Multi-source / any-target BFS (boat water routing)

This is the core pathfinding primitive used by transport boats, trade ships, and warships.
Implementation lives in `src/core/pathfinding/MultiSourceAnyTargetBFS.ts`.

## Problem statement

Given:
- a set of source water tiles (seeds)
- a set of destination water tiles (targets)
- boat movement rules (8-neighbor “king moves” + no corner cutting)

Find the shortest **water-only** path from *any* seed to *any* target.
All edges cost the same, so **BFS is optimal**.

## Why this (and why it replaces the old “multi-stage floodfill”)

- “Multiple destinations” here really means **any destination**. We stop at the first target reached in BFS order.
- Multi-source BFS solves “many starts → any goal” in a **single pass**. Doing one floodfill per source/target is wasted work.
- We keep correctness simple (BFS) and get performance from **pruning** (water components, coarse corridor masks), not from heuristic hacks.

## API and contract

Primary entry points:
- `findWaterPathFromSeeds(gm, seedNodes, seedOrigins, targets, opts)`
- `findWaterPathFromSeedsMaskExpanding(..., onQueueEmpty)` (used by coarse-to-fine; see `pathingReworkDocs/MaskExpanding.md`)

Return type: `{ source, target, path } | null`
- `source`: the winning seed origin (typically a shore tile associated with the seed water tile)
- `target`: the reached target water tile
- `path`: contiguous list of water `TileRef` from the chosen seed to the target

Correctness invariant: **goal test happens on dequeue**, not on discovery. That’s what makes the path length truly minimal with multiple sources.

## Movement model (boats)

- Traversal is `gm.isWater(tile)` only.
- Neighbors are 8-directional (“king moves”) by default.
- With `noCornerCutting`, a diagonal move is allowed only if both touching orthogonals are water.
- Each move costs 1, so BFS gives the shortest path under these rules.

## How it is implemented (hot-path constraints)

The implementation is built for “called a lot”:
- Typed arrays for `visitedStamp`, `prev`, `startOf`, and `targetStamp`.
- Stamp counters (no full-array clears) for visited/target membership.
- `WeakMap<GameMap, MultiSourceAnyTargetBFS>` caching so buffers are reused per map instance.

High level:
1) Stamp all targets into `targetStamp`.
2) Push all valid seeds into the queue (water + allowed by mask + not already visited) and record their origin in `startOf`.
3) Standard BFS loop:
   - pop `node`
   - if `node` is a target: reconstruct via `prev[]` and return
   - otherwise expand neighbors, applying movement rules + optional masks

## O(1) “impossible route” reject via water components

`src/core/pathfinding/WaterComponents.ts` precomputes connected-component IDs for each `GameMap` instance.
Call sites should filter seed/target candidates to the same water component first (ocean vs lake becomes a constant-time reject).
This replaced earlier “visited-count early exits” that were both brittle and incorrect.

## Integration notes (transport/trade/warship)

- Keep seeds/targets bounded (sample shores/ports) before calling BFS; runtime is proportional to visited tiles.
- Compute once on intent/launch, cache the returned `path`, and advance an index during ticks.
- Retreat should reuse the cached `path` in reverse (no recompute).
