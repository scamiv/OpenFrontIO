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

  return { fine, coarse4x };
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

  beforeAll(async () => {
    ({ fine, coarse4x } = await loadMaps(map));
  });

  function runCase(
    label: string,
    repro: ReproCase,
    coarseToFine?: { corridorRadius?: number; maxAttempts?: number },
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
      coarse4x,
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

