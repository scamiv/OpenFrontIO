# BSP-ish coarse-to-fine refinement (boats)

Problem: we already have a cheap coarse solve (`map16x` corridor), but today the refine stage is mostly:

- Try full-res BFS inside coarse corridor
- If it fails, eventually fall back to unrestricted full-res BFS (global “panic”)

That’s correct, but it throws away locality: a *small* coarse-map lie (minimap “tearing”) can force an *ocean-sized* fallback.

The goal here is “BSP-like” behavior:

- Use coarse everywhere by default
- Only pay full-res (or widen search space) in the *constricted / unreliable* part

This doc proposes a generic refinement strategy that applies to all current callsites (transport/trade/warship).

## Mental model

Think of the coarse path as a **sequence of coarse cells** that defines a corridor. Refinement is not “coarse then fine once”.
Refinement is “coarse gives a *plan*, fine only validates/stitches where needed”.

## Option A2: Local corridor widening (recommended next step)

Instead of “corridor fail → full map”, do:

1) Build initial corridor around coarse path (radius `r0`).
2) Run fine BFS restricted to the corridor (`allowedMask`).
3) If it fails, widen **only around the failure** and retry.

Key question: “where is the failure?”

- If fine BFS exhausts the corridor without reaching a target, the *frontier* of reached coarse regions tells you which part is tight.
- Widen the corridor only near the frontier / last reached coarse regions (not globally).

### Practical approach (cheap + hot-path-friendly)

- Keep using the existing stamp-based `allowedMask` (no allocations).
- Track the set of coarse regions that were actually visited by fine BFS.
- On failure, grow the corridor by 1 ring **around visited regions** (or around the visited∩coarsePath regions).
- Retry with the same seeds/targets.
- Cap retries (`k` small, e.g. 2–4). Only then do an unrestricted fallback.

This is “BSP-ish” in spirit: you’re expanding the search space like a partition refinement, not exploding to the whole map.

## Option A3: Segment / waypoint refinement (more “BSP”, very controllable)

Treat the coarse path as a list of waypoints `C0..Cn` and refine incrementally:

1) Choose a set of coarse waypoints along the coarse path (e.g. every N cells, plus turns).
2) For each segment `(Ci -> Ci+1)`:
   - Build a small corridor/window around *that segment only*
   - Run fine BFS inside that window
   - If it fails, widen the window for that segment only (limited retries)
3) Concatenate the refined segments into a final fine path

Benefits:
- Worst-case work is bounded by “tight bits”, not by ocean area.
- Easy to tune “how BSP-ish” it is: waypoint spacing + local window radius.

Costs:
- More bookkeeping (stitching, avoiding tiny oscillations).
- Must ensure segment endpoints are water-reachable (choose waypoints as coarse cells that map to at least one fine water tile).

## Mask-expanding BFS without restart (most performance-oriented)

Same idea as A2, but avoid restarting the fine BFS:

- Start fine BFS inside the initial corridor.
- If the queue empties, expand the corridor (one ring) and continue BFS without clearing `visited`.

This avoids repeated queue/visited churn on “almost works” corridors.
It’s the closest to “incrementally refining the partition” and often the fastest once implemented correctly.

## When to apply

Use the same logic for all water path callsites:

- Transport boat path to a shore / water target
- Trade ship route between ports
- Warship route to shore/water targets

The refinement layer should be a generic wrapper that sits above `MultiSourceAnyTargetBFS` and below “shore picking”.

## Guardrails (don’t regress correctness)

- Coarse map is approximate. Never accept “coarse says ok” without a fine validation.
- Always have a final fallback to unrestricted fine BFS.
- Keep the hot path allocation-free:
  - Reuse `MultiSourceAnyTargetBFS` instance(s) via caches
  - Use stamp arrays for masks/visited sets

## Suggested implementation order

1) Implement **A2 local widening** first (least invasive; big win vs global fallback).
2) If we still see pathological oceans, consider **no-restart mask expansion**.
3) Only then consider **A3 waypoint refinement** if we want tighter bounds / more “BSP feel”.
