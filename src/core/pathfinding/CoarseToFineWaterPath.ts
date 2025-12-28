import { GameMap, TileRef } from "../game/GameMap";
import {
  MultiSourceAnyTargetBFS,
  MultiSourceAnyTargetBFSOptions,
  MultiSourceAnyTargetBFSResult,
} from "./MultiSourceAnyTargetBFS";

export type CoarseToFineWaterPathOptions = {
  /**
   * Corridor radius in coarse cells (Chebyshev) around the coarse path.
   * Larger = safer (less likely to miss due to minimap tearing), smaller = faster.
   */
  corridorRadius?: number;
  /**
   * How many corridor attempts to try before falling back to unrestricted fine BFS.
   */
  maxAttempts?: number;
  /**
   * Multiply radius each attempt (e.g. 2 turns 2 -> 4 -> 8 ...).
   */
  radiusMultiplier?: number;
};

const bfsCache = new WeakMap<GameMap, MultiSourceAnyTargetBFS>();
function getBfs(gm: GameMap): MultiSourceAnyTargetBFS {
  const cached = bfsCache.get(gm);
  if (cached) return cached;
  const bfs = new MultiSourceAnyTargetBFS(gm.width() * gm.height());
  bfsCache.set(gm, bfs);
  return bfs;
}

type FineToCoarseMapping = {
  coarse: GameMap;
  fineToCoarse: Uint32Array;
  scaleX: number;
  scaleY: number;
};
const fineToCoarseCache = new WeakMap<GameMap, FineToCoarseMapping>();

function getFineToCoarseMapping(
  fine: GameMap,
  coarse: GameMap,
): FineToCoarseMapping | null {
  const cached = fineToCoarseCache.get(fine);
  if (cached && cached.coarse === coarse) return cached;

  const fw = fine.width();
  const fh = fine.height();
  const cw = coarse.width();
  const ch = coarse.height();

  if (cw <= 0 || ch <= 0) return null;
  if (fw % cw !== 0 || fh % ch !== 0) return null;

  const scaleX = fw / cw;
  const scaleY = fh / ch;
  if (!Number.isInteger(scaleX) || !Number.isInteger(scaleY)) return null;
  if (scaleX <= 0 || scaleY <= 0) return null;

  const fineToCoarse = new Uint32Array(fw * fh);

  // Fill by coarse cell rectangles to avoid division in the inner loop.
  for (let cy = 0; cy < ch; cy++) {
    const fineYStart = cy * scaleY;
    const fineYEnd = fineYStart + scaleY;
    for (let cx = 0; cx < cw; cx++) {
      const coarseRef = cy * cw + cx;
      const fineXStart = cx * scaleX;
      const fineXEnd = fineXStart + scaleX;
      for (let y = fineYStart; y < fineYEnd; y++) {
        let fineRef = y * fw + fineXStart;
        for (let x = fineXStart; x < fineXEnd; x++) {
          fineToCoarse[fineRef++] = coarseRef;
        }
      }
    }
  }

  const entry: FineToCoarseMapping = { coarse, fineToCoarse, scaleX, scaleY };
  fineToCoarseCache.set(fine, entry);
  return entry;
}

type StampSet = { stamp: number; data: Uint32Array };
const stampSetCache = new WeakMap<GameMap, StampSet>();
function getStampSet(gm: GameMap): StampSet {
  const cached = stampSetCache.get(gm);
  if (cached) return cached;
  const set: StampSet = { stamp: 1, data: new Uint32Array(gm.width() * gm.height()) };
  stampSetCache.set(gm, set);
  return set;
}

// Separate stamp array for "visited coarse regions" marking to avoid clobbering the allowed corridor stamp.
const visitedStampSetCache = new WeakMap<GameMap, StampSet>();
function getVisitedStampSet(gm: GameMap): StampSet {
  const cached = visitedStampSetCache.get(gm);
  if (cached) return cached;
  const set: StampSet = { stamp: 1, data: new Uint32Array(gm.width() * gm.height()) };
  visitedStampSetCache.set(gm, set);
  return set;
}
function nextStamp(set: StampSet): number {
  const next = (set.stamp + 1) >>> 0;
  set.stamp = next === 0 ? 1 : next;
  return set.stamp;
}

function dedupeByStamp(
  tiles: readonly TileRef[],
  stampSet: StampSet,
  stamp: number,
): TileRef[] {
  const out: TileRef[] = [];
  for (const t of tiles) {
    if (t < 0 || t >= stampSet.data.length) continue;
    if (stampSet.data[t] === stamp) continue;
    stampSet.data[t] = stamp;
    out.push(t);
  }
  return out;
}

function markCoarseCorridor(
  coarseWidth: number,
  coarseHeight: number,
  corridorStamp: Uint32Array,
  stamp: number,
  coarsePath: readonly TileRef[],
  radius: number,
) {
  for (const ref of coarsePath) {
    const x = ref % coarseWidth;
    const y = Math.floor(ref / coarseWidth);
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(coarseHeight - 1, y + radius);
    const x0 = Math.max(0, x - radius);
    const x1 = Math.min(coarseWidth - 1, x + radius);

    for (let yy = y0; yy <= y1; yy++) {
      const row = yy * coarseWidth;
      for (let xx = x0; xx <= x1; xx++) {
        corridorStamp[row + xx] = stamp;
      }
    }
  }
}

function widenAllowedByVisitedRing(
  coarseWidth: number,
  coarseHeight: number,
  allowedStamp: Uint32Array,
  allowed: number,
  visitedStamp: Uint32Array,
  visited: number,
  outNewlyAllowed: Int32Array,
): number {
  let count = 0;
  for (let y = 0; y < coarseHeight; y++) {
    const row = y * coarseWidth;
    for (let x = 0; x < coarseWidth; x++) {
      const idx = row + x;
      if (visitedStamp[idx] !== visited) continue;
      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(coarseHeight - 1, y + 1);
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(coarseWidth - 1, x + 1);
      for (let yy = y0; yy <= y1; yy++) {
        const nRow = yy * coarseWidth;
        for (let xx = x0; xx <= x1; xx++) {
          const n = nRow + xx;
          if (allowedStamp[n] === allowed) continue;
          allowedStamp[n] = allowed;
          outNewlyAllowed[count++] = n;
        }
      }
    }
  }
  return count;
}

function microMapOrNull(gm: GameMap): GameMap | null {
  const mm = (gm as any).microMap;
  if (typeof mm === "function") return mm.call(gm) as GameMap;
  return null;
}

function miniMapOrNull(gm: GameMap): GameMap | null {
  const mm = (gm as any).miniMap;
  if (typeof mm === "function") return mm.call(gm) as GameMap;
  return null;
}

function defaultCoarseMapOrNull(fineMap: GameMap): GameMap | null {
  return microMapOrNull(fineMap) ?? miniMapOrNull(fineMap);
}

export function findWaterPathFromSeedsCoarseToFine(
  fineMap: GameMap,
  seedNodes: readonly TileRef[],
  seedOrigins: readonly TileRef[],
  targets: readonly TileRef[],
  bfsOpts: MultiSourceAnyTargetBFSOptions = {},
  coarseMap?: GameMap | null,
  coarseToFine: CoarseToFineWaterPathOptions = {},
): MultiSourceAnyTargetBFSResult | null {
  const totalStart = performance.now();
  const fineBfs = getBfs(fineMap);

  const attachTimings = (
    result: MultiSourceAnyTargetBFSResult | null,
    patch: {
      totalMs: number;
      planMs: number;
      maskMs: number;
      refineMs: number;
      fallbackMs: number;
      planExpanded?: number;
      planTiles?: number;
      planSeedCount?: number;
      planTargetCount?: number;
      maskExpansions?: number;
      newlyAllowedRegions?: number;
    },
  ) => {
    if (result === null) return null;
    if (!result.stats) {
      result.stats = { expanded: 0, enqueued: 0 };
    }
    result.stats.totalMs = patch.totalMs;
    result.stats.planMs = patch.planMs;
    result.stats.maskMs = patch.maskMs;
    result.stats.refineMs = patch.refineMs;
    result.stats.fallbackMs = patch.fallbackMs;
    result.stats.planExpanded = patch.planExpanded;
    result.stats.planTiles = patch.planTiles;
    result.stats.planSeedCount = patch.planSeedCount;
    result.stats.planTargetCount = patch.planTargetCount;
    if (patch.maskExpansions !== undefined) {
      result.stats.maskExpansions = patch.maskExpansions;
    }
    if (patch.newlyAllowedRegions !== undefined) {
      result.stats.newlyAllowedRegions = patch.newlyAllowedRegions;
    }
    return result;
  };

  const resolvedCoarseMap =
    coarseMap === undefined ? defaultCoarseMapOrNull(fineMap) : coarseMap;

  if (!resolvedCoarseMap) {
    const result = fineBfs.findWaterPathFromSeeds(
      fineMap,
      seedNodes,
      seedOrigins,
      targets,
      bfsOpts,
    );
    const totalMs = performance.now() - totalStart;
    return attachTimings(result, {
      totalMs,
      planMs: 0,
      maskMs: 0,
      refineMs: totalMs,
      fallbackMs: 0,
    });
  }

  const mapping = getFineToCoarseMapping(fineMap, resolvedCoarseMap);
  if (mapping === null) {
    const result = fineBfs.findWaterPathFromSeeds(
      fineMap,
      seedNodes,
      seedOrigins,
      targets,
      bfsOpts,
    );
    const totalMs = performance.now() - totalStart;
    return attachTimings(result, {
      totalMs,
      planMs: 0,
      maskMs: 0,
      refineMs: totalMs,
      fallbackMs: 0,
    });
  }

  const coarseWidth = resolvedCoarseMap.width();
  const coarseHeight = resolvedCoarseMap.height();
  const coarseStampSet = getStampSet(resolvedCoarseMap);
  const coarseSeedStamp = nextStamp(coarseStampSet);
  const coarseTargetStamp = nextStamp(coarseStampSet);

  const coarseSeedsRaw: TileRef[] = [];
  for (const s of seedNodes) {
    if (s < 0 || s >= mapping.fineToCoarse.length) continue;
    coarseSeedsRaw.push(mapping.fineToCoarse[s] as TileRef);
  }
  const coarseTargetsRaw: TileRef[] = [];
  for (const t of targets) {
    if (t < 0 || t >= mapping.fineToCoarse.length) continue;
    coarseTargetsRaw.push(mapping.fineToCoarse[t] as TileRef);
  }

  const coarseSeeds = dedupeByStamp(
    coarseSeedsRaw,
    coarseStampSet,
    coarseSeedStamp,
  );
  const coarseTargets = dedupeByStamp(
    coarseTargetsRaw,
    coarseStampSet,
    coarseTargetStamp,
  );

  if (coarseSeeds.length === 0 || coarseTargets.length === 0) {
    const result = fineBfs.findWaterPathFromSeeds(
      fineMap,
      seedNodes,
      seedOrigins,
      targets,
      bfsOpts,
    );
    const totalMs = performance.now() - totalStart;
    return attachTimings(result, {
      totalMs,
      planMs: 0,
      maskMs: 0,
      refineMs: totalMs,
      fallbackMs: 0,
    });
  }

  // Coarse solve (cheap) to define a corridor.
  const coarseBfs = getBfs(resolvedCoarseMap);
  const planStart = performance.now();
  const coarseResult = coarseBfs.findWaterPath(
    resolvedCoarseMap,
    coarseSeeds,
    coarseTargets,
    bfsOpts,
  );
  const planMs = performance.now() - planStart;
  const planExpanded = coarseResult?.stats?.expanded;
  const planTiles = coarseWidth * coarseHeight;
  const planSeedCount = coarseSeeds.length;
  const planTargetCount = coarseTargets.length;

  if (coarseResult === null) {
    // Safe fallback: if the coarse map is conservative, we might still have a fine path.
    const fallbackStart = performance.now();
    const result = fineBfs.findWaterPathFromSeeds(
      fineMap,
      seedNodes,
      seedOrigins,
      targets,
      bfsOpts,
    );
    const fallbackMs = performance.now() - fallbackStart;
    const totalMs = performance.now() - totalStart;
    return attachTimings(result, {
      totalMs,
      planMs,
      maskMs: 0,
      refineMs: 0,
      fallbackMs,
      planExpanded,
      planTiles,
      planSeedCount,
      planTargetCount,
    });
  }

  // Default to a slightly inflated corridor to avoid "optimistic coarse water" cliffs.
  const corridorRadius0 = Math.max(0, coarseToFine.corridorRadius ?? 2);
  const maxAttempts = Math.max(1, coarseToFine.maxAttempts ?? 6);

  // Allowed corridor stamp is stable across attempts (widening is cumulative).
  const allowedSet = getStampSet(resolvedCoarseMap);
  const allowed = nextStamp(allowedSet);
  const maskStart = performance.now();
  markCoarseCorridor(
    coarseWidth,
    coarseHeight,
    allowedSet.data,
    allowed,
    coarseResult.path,
    corridorRadius0,
  );
  const maskMs = performance.now() - maskStart;

  const visitedSet = getVisitedStampSet(resolvedCoarseMap);
  let expansionsLeft = maxAttempts - 1;
  const visitedMask = {
    tileToRegion: mapping.fineToCoarse,
    regionStamp: visitedSet.data,
    stamp: nextStamp(visitedSet),
  };

  let maskExpansions = 0;
  let newlyAllowedRegions = 0;
  const refineStart = performance.now();
  const refined = fineBfs.findWaterPathFromSeedsMaskExpanding(
    fineMap,
    seedNodes,
    seedOrigins,
    targets,
    {
      ...bfsOpts,
      allowedMask: {
        tileToRegion: mapping.fineToCoarse,
        regionStamp: allowedSet.data,
        stamp: allowed,
      },
      visitedMaskOut: visitedMask,
    },
    (outNewlyAllowed) => {
      if (expansionsLeft <= 0) return 0;

      // Expand by 1 ring around the coarse regions actually visited in the most recent phase.
      // Widening is cumulative (newly allowed regions stay allowed).
      const newCount = widenAllowedByVisitedRing(
        coarseWidth,
        coarseHeight,
        allowedSet.data,
        allowed,
        visitedSet.data,
        visitedMask.stamp,
        outNewlyAllowed,
      );
      expansionsLeft--;
      if (newCount <= 0) return 0;
      maskExpansions++;
      newlyAllowedRegions += newCount;

      // Reset visited coarse tracking for the next phase.
      visitedMask.stamp = nextStamp(visitedSet);
      return newCount;
    },
  );
  const refineMs = performance.now() - refineStart;
  if (refined !== null) {
    const totalMs = performance.now() - totalStart;
    return attachTimings(refined, {
      totalMs,
      planMs,
      maskMs,
      refineMs,
      fallbackMs: 0,
      planExpanded,
      planTiles,
      planSeedCount,
      planTargetCount,
      maskExpansions: refined.stats?.maskExpansions ?? maskExpansions,
      newlyAllowedRegions: refined.stats?.newlyAllowedRegions ?? newlyAllowedRegions,
    });
  }

  // Final fallback: unrestricted fine BFS.
  const fallbackStart = performance.now();
  const fallback = fineBfs.findWaterPathFromSeeds(
    fineMap,
    seedNodes,
    seedOrigins,
    targets,
    bfsOpts,
  );
  const fallbackMs = performance.now() - fallbackStart;
  const totalMs = performance.now() - totalStart;
  return attachTimings(fallback, {
    totalMs,
    planMs,
    maskMs,
    refineMs,
    fallbackMs,
    planExpanded,
    planTiles,
    planSeedCount,
    planTargetCount,
    maskExpansions,
    newlyAllowedRegions,
  });
}
