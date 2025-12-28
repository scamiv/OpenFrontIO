import fs from "fs";
import path from "path";
import { findWaterPathFromSeedsCoarseToFine } from "../../../src/core/pathfinding/CoarseToFineWaterPath";
import {
  genTerrainFromBin,
  MapManifest,
} from "../../../src/core/game/TerrainMapLoader";
import { GameMap, TileRef } from "../../../src/core/game/GameMap";

type ReproCase = {
  map: string;
  src: { x: number; y: number };
  seedWater: Array<[seedX: number, seedY: number, originX: number, originY: number]>;
  targetWaterList: Array<[x: number, y: number]>;
};

async function loadMaps(mapKeyLower: string): Promise<{
  fine: GameMap;
  coarse4x: GameMap;
  coarse16x: GameMap;
}> {
  const root = path.resolve(__dirname, "../../../");
  const base = path.join(root, "resources", "maps", mapKeyLower);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(base, "manifest.json"), "utf8"),
  ) as MapManifest;

  const fine = await genTerrainFromBin(
    manifest.map,
    fs.readFileSync(path.join(base, "map.bin")),
  );
  const coarse4x = await genTerrainFromBin(
    manifest.map4x,
    fs.readFileSync(path.join(base, "map4x.bin")),
  );
  const coarse16x = await genTerrainFromBin(
    manifest.map16x,
    fs.readFileSync(path.join(base, "map16x.bin")),
  );

  return { fine, coarse4x, coarse16x };
}

function buildOptimisticWaterDownsample(
  fine: GameMap,
  scaleX: number,
  scaleY: number,
): GameMap {
  const fw = fine.width();
  const fh = fine.height();
  if (fw % scaleX !== 0 || fh % scaleY !== 0) {
    throw new Error(`fine ${fw}x${fh} not divisible by ${scaleX}x${scaleY}`);
  }
  const cw = fw / scaleX;
  const ch = fh / scaleY;
  const water = new Uint8Array(cw * ch);

  // Optimistic water: coarse cell is water if ANY fine tile is water.
  for (let y = 0; y < fh; y++) {
    const cy = (y / scaleY) | 0;
    const fineRow = y * fw;
    const coarseRow = cy * cw;
    for (let x = 0; x < fw; x++) {
      const cx = (x / scaleX) | 0;
      const fineRef = fineRow + x;
      if (fine.isWater(fineRef as TileRef)) {
        water[coarseRow + cx] = 1;
      }
    }
  }

  return {
    width: () => cw,
    height: () => ch,
    ref: (x: number, y: number) => y * cw + x,
    x: (ref: TileRef) => ref % cw,
    y: (ref: TileRef) => (ref / cw) | 0,
    isWater: (ref: TileRef) => water[ref] === 1,
  } as any;
}

function toRefs(
  fine: GameMap,
  seedWater: ReproCase["seedWater"],
  targetWaterList: ReproCase["targetWaterList"],
): { seedNodes: TileRef[]; seedOrigins: TileRef[]; targets: TileRef[] } {
  const seedNodes: TileRef[] = [];
  const seedOrigins: TileRef[] = [];
  for (const [sx, sy, ox, oy] of seedWater) {
    seedNodes.push(fine.ref(sx, sy));
    seedOrigins.push(fine.ref(ox, oy));
  }

  const targets = targetWaterList.map(([x, y]) => fine.ref(x, y));
  return { seedNodes, seedOrigins, targets };
}

function pct(n: number, d: number): number {
  if (d <= 0) return 0;
  return (n / d) * 100;
}

function summarize(nums: number[]) {
  if (nums.length === 0) {
    return { n: 0, min: 0, max: 0, mean: 0, median: 0 };
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const n = sorted.length;
  const min = sorted[0]!;
  const max = sorted[n - 1]!;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const median =
    n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
  return { n, min, max, mean, median };
}

const run = process.env.RUN_WORLD_ROUTE_REPRO === "1";
(run ? describe : describe.skip)("World transport-boat repro (env-gated)", () => {
  const map = "world";

  // From `bestTransportShipRouteRepro` logs.
  const easyNoFallback: ReproCase = {
    map,
    src: { x: 1699, y: 716 },
    seedWater: [[1699, 717, 1699, 716]],
    targetWaterList: [[821, 963]],
  };

  // This used to cliff into fallback with tight corridors / low attempts.
  const formerlyFallback: ReproCase = {
    map,
    src: { x: 1699, y: 716 },
    seedWater: [[1699, 717, 1699, 716]],
    targetWaterList: [[359, 968]],
  };

  let fine: GameMap;
  let coarse4x: GameMap;
  let coarse16x: GameMap;
  let coarse64x: GameMap;

  beforeAll(async () => {
    ({ fine, coarse4x, coarse16x } = await loadMaps(map));
    // "64x" here means 8x8 downsample in each dimension (area / 64).
    coarse64x = buildOptimisticWaterDownsample(fine, 8, 8);
  });

  function runCase(
    label: string,
    repro: ReproCase,
    coarseToFine?: { corridorRadius?: number; maxAttempts?: number },
    coarseMap: GameMap = coarse4x,
  ) {
    const { seedNodes, seedOrigins, targets } = toRefs(
      fine,
      repro.seedWater,
      repro.targetWaterList,
    );

    const res = findWaterPathFromSeedsCoarseToFine(
      fine,
      seedNodes,
      seedOrigins,
      targets,
      { kingMoves: true, noCornerCutting: true },
      coarseMap,
      coarseToFine ?? {},
    );

    expect(res).not.toBeNull();

    const fineTiles = fine.width() * fine.height();
    const expanded = res!.stats?.expanded ?? 0;
    const enqueued = res!.stats?.enqueued ?? 0;
    const maskExp = res!.stats?.maskExpansions ?? 0;
    const newlyAllowed = res!.stats?.newlyAllowedRegions ?? 0;
    const fallbackMs = res!.stats?.fallbackMs ?? 0;

    const planExpanded = res!.stats?.planExpanded ?? 0;
    const planTiles = res!.stats?.planTiles ?? 0;

    console.log(
      `WORLD_REPRO_METRICS ${JSON.stringify({
        label,
        repro,
        coarse: { w: coarseMap.width(), h: coarseMap.height() },
        coarseToFine: coarseToFine ?? null,
        pathLen: res!.path.length,
        fallbackMs,
        expanded,
        expandedPct: pct(expanded, fineTiles),
        enqueued,
        maskExpansions: maskExp,
        newlyAllowedRegions: newlyAllowed,
        planExpanded,
        planPct: pct(planExpanded, planTiles),
        planTiles,
        totalMs: res!.stats?.totalMs ?? null,
        planMs: res!.stats?.planMs ?? null,
        maskMs: res!.stats?.maskMs ?? null,
        refineMs: res!.stats?.refineMs ?? null,
      })}`,
    );

    return res!;
  }

  test("baseline: easy case avoids fallback", () => {
    const res = runCase("easy/default", easyNoFallback);
    expect(res.source).toBe(fine.ref(easyNoFallback.src.x, easyNoFallback.src.y));
    expect(res.stats?.fallbackMs ?? 0).toBe(0);
    expect(res.stats?.expanded ?? Number.POSITIVE_INFINITY).toBeLessThan(200_000);
  });

  test("regression: formerly-fallback case avoids fallback with defaults", () => {
    const res = runCase("formerlyFallback/default", formerlyFallback);
    expect(res.source).toBe(
      fine.ref(formerlyFallback.src.x, formerlyFallback.src.y),
    );
    expect(res.stats?.fallbackMs ?? 0).toBe(0);
    expect(res.stats?.expanded ?? Number.POSITIVE_INFINITY).toBeLessThan(200_000);
  });

  test("mask-expansion repairs a tight corridor (radius 0)", () => {
    const res = runCase("formerlyFallback/r0-expand", formerlyFallback, {
      corridorRadius: 0,
      maxAttempts: 12,
    });
    expect(res.stats?.fallbackMs ?? 0).toBe(0);
    expect(res.stats?.maskExpansions ?? 0).toBeGreaterThan(0);
  });

  test("micro (16x) planner metrics (diagnostic)", () => {
    const res = runCase("formerlyFallback/micro16x", formerlyFallback, undefined, coarse16x);
    expect(res.stats?.fallbackMs ?? 0).toBe(0);
  });

  test("micro (64x) planner metrics (synthetic, optimistic)", () => {
    const res = runCase(
      "formerlyFallback/micro64x",
      formerlyFallback,
      undefined,
      coarse64x,
    );
    expect(res.stats?.fallbackMs ?? 0).toBe(0);
  });

  const runCompare = process.env.RUN_WORLD_ROUTE_REPRO_COMPARE === "1";
  (runCompare ? test : test.skip)("compare 4x vs 16x (10 runs)", () => {
    const iterations = 10;

    // Warm up caches (mapping, bfs instances) without recording.
    runCase("warmup/4x", formerlyFallback, undefined, coarse4x);
    runCase("warmup/16x", formerlyFallback, undefined, coarse16x);

    const results4x = { totalMs: [] as number[], planMs: [] as number[], refineMs: [] as number[] };
    for (let i = 0; i < iterations; i++) {
      const res = runCase(`cmp/4x/${i}`, formerlyFallback, undefined, coarse4x);
      results4x.totalMs.push(res.stats?.totalMs ?? 0);
      results4x.planMs.push(res.stats?.planMs ?? 0);
      results4x.refineMs.push(res.stats?.refineMs ?? 0);
    }

    const results16x = { totalMs: [] as number[], planMs: [] as number[], refineMs: [] as number[] };
    for (let i = 0; i < iterations; i++) {
      const res = runCase(`cmp/16x/${i}`, formerlyFallback, undefined, coarse16x);
      results16x.totalMs.push(res.stats?.totalMs ?? 0);
      results16x.planMs.push(res.stats?.planMs ?? 0);
      results16x.refineMs.push(res.stats?.refineMs ?? 0);
    }

    console.log(
      `WORLD_REPRO_COMPARE ${JSON.stringify({
        iterations,
        case: formerlyFallback,
        coarse4x: {
          w: coarse4x.width(),
          h: coarse4x.height(),
          totalMs: summarize(results4x.totalMs),
          planMs: summarize(results4x.planMs),
          refineMs: summarize(results4x.refineMs),
        },
        coarse16x: {
          w: coarse16x.width(),
          h: coarse16x.height(),
          totalMs: summarize(results16x.totalMs),
          planMs: summarize(results16x.planMs),
          refineMs: summarize(results16x.refineMs),
        },
      })}`,
    );

    expect(results4x.totalMs.length).toBe(iterations);
    expect(results16x.totalMs.length).toBe(iterations);
  });

  const runCompare64 = process.env.RUN_WORLD_ROUTE_REPRO_COMPARE_64X === "1";
  (runCompare64 ? test : test.skip)("compare 4x vs 16x vs 64x (10 runs)", () => {
    const iterations = 10;

    // Warm up caches (mapping, bfs instances) without recording.
    runCase("warmup/4x", formerlyFallback, undefined, coarse4x);
    runCase("warmup/16x", formerlyFallback, undefined, coarse16x);
    runCase("warmup/64x", formerlyFallback, undefined, coarse64x);

    const collect = (label: string, coarseMap: GameMap) => {
      const totalMs: number[] = [];
      const planMs: number[] = [];
      const refineMs: number[] = [];
      const maskExp: number[] = [];
      const expanded: number[] = [];
      let fallbacks = 0;

      for (let i = 0; i < iterations; i++) {
        const res = runCase(`cmp/${label}/${i}`, formerlyFallback, undefined, coarseMap);
        totalMs.push(res.stats?.totalMs ?? 0);
        planMs.push(res.stats?.planMs ?? 0);
        refineMs.push(res.stats?.refineMs ?? 0);
        maskExp.push(res.stats?.maskExpansions ?? 0);
        expanded.push(res.stats?.expanded ?? 0);
        if ((res.stats?.fallbackMs ?? 0) > 0) fallbacks++;
      }

      return {
        w: coarseMap.width(),
        h: coarseMap.height(),
        fallbacks,
        totalMs: summarize(totalMs),
        planMs: summarize(planMs),
        refineMs: summarize(refineMs),
        maskExpansions: summarize(maskExp),
        expanded: summarize(expanded),
      };
    };

    const s4 = collect("4x", coarse4x);
    const s16 = collect("16x", coarse16x);
    const s64 = collect("64x", coarse64x);

    console.log(
      `WORLD_REPRO_COMPARE_SCALES ${JSON.stringify({
        iterations,
        case: formerlyFallback,
        coarse4x: s4,
        coarse16x: s16,
        coarse64x: s64,
      })}`,
    );

    expect(s4.fallbacks).toBe(0);
    expect(s16.fallbacks).toBe(0);
    expect(s64.fallbacks).toBe(0);
  });

  const runSlowFallback = process.env.RUN_WORLD_ROUTE_REPRO_FALLBACK === "1";
  (runSlowFallback ? test : test.skip)(
    "diagnostic: tight corridor + no expansion triggers fallback (slow)",
    () => {
      const res = runCase("formerlyFallback/r0-noexpand", formerlyFallback, {
        corridorRadius: 0,
        maxAttempts: 1,
      });
      expect(res.stats?.fallbackMs ?? 0).toBeGreaterThan(0);
      expect(res.stats?.expanded ?? 0).toBeGreaterThan(500_000);
    },
  );
});
