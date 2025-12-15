import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { PlayerType } from "../../src/core/game/Game";
import { parseArgs, usage } from "./args";
import { createConsoleCapture } from "./consoleCapture";
import { createEconomyTracker } from "./economyTracker";
import { summarizePlayers } from "./playerSummary";
import { loadReplay } from "./replayLoader";
import { reportHtml } from "./reportHtml";
import { simulateReplay } from "./simulateReplay";
import type { ReplayPerfReport } from "./types";
import { percentile } from "./utils";

// Some core code uses global performance.
if (globalThis.performance === undefined) {
  (globalThis as unknown as { performance: typeof performance }).performance =
    performance;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const mapsRoot = path.join(repoRoot, "resources", "maps");
const d3Path = path.join(repoRoot, "node_modules", "d3", "dist", "d3.min.js");

const { replayPath, outPath, maxTurns, economySampleEvery, help, verbose } = parseArgs(
  process.argv.slice(2),
);
if (help || !replayPath) {
  console.log(usage());
  process.exit(help ? 0 : 1);
}

const loaded = await loadReplay({ replayPath, maxTurns });

const rawLog = console.log.bind(console);
const consoleCapture = createConsoleCapture({ verbose, topN: 15 });

const economyTracker = createEconomyTracker({ sampleEveryTurns: economySampleEvery, topN: 12 });

let sim!: Awaited<ReturnType<typeof simulateReplay>>;
let elapsedMs = 0;
try {
  sim = await simulateReplay({
    gameStartInfo: loaded.gameStartInfo,
    clientID: loaded.clientID,
    mapsRoot,
    turnsToRun: loaded.turnsToRun,
    expectedHashes: loaded.expectedHashes,
    progressEvery: 2000,
    progressLog: rawLog,
    onGameInitialized: (game) => economyTracker.init(game),
    onAfterTick: ({ game, turn, conquestEvents, isLast }) => {
      economyTracker.afterTick(game, turn.turnNumber, conquestEvents, isLast);
    },
  });
  elapsedMs = sim.elapsedMs;
} finally {
  consoleCapture.restore();
}

const tickMs = {
  avg:
    sim.tickExecutionMsValues.reduce((a, b) => a + b, 0) /
    Math.max(1, sim.tickExecutionMsValues.length),
  p50: percentile(sim.tickExecutionMsValues, 0.5),
  p95: percentile(sim.tickExecutionMsValues, 0.95),
  p99: percentile(sim.tickExecutionMsValues, 0.99),
  max: Math.max(0, ...sim.tickExecutionMsValues),
};

const players = summarizePlayers(
  sim.runner.game,
  sim.maxTilesBySmallID,
  economyTracker.totalsByClientId,
  loaded.goldEarnedReplayByClientId,
);

const playersMeta = {
  total: players.length,
  humans: players.filter((p) => p.type === PlayerType.Human).length,
  bots: players.filter((p) => p.type === PlayerType.Bot).length,
  fakeHumans: players.filter((p) => p.type === PlayerType.FakeHuman).length,
};

const { warnings, logs } = consoleCapture.summarize();

const report: ReplayPerfReport = {
  meta: {
    generatedAt: new Date().toISOString(),
    replayPath: loaded.absoluteReplayPath,
    gameID: loaded.gameStartInfo.gameID,
    replayGitCommit: loaded.replayGitCommit,
    map: String(loaded.gameStartInfo.config.gameMap),
    mapSize: String(loaded.gameStartInfo.config.gameMapSize),
    numTurns: loaded.expandedTurns.length,
    numTicksSimulated: loaded.turnsToRun.length,
    players: playersMeta,
    unknownClientIds: {
      total: loaded.unknownClientIds.length,
      withNonMarkIntents: loaded.unknownClientIds.filter((x) => x.hasNonMarkIntent).length,
      markOnly: loaded.unknownClientIds.filter((x) => !x.hasNonMarkIntent).length,
      samples: loaded.unknownClientIds.slice(0, 40),
    },
  },
  summary: {
    tickExecutionMs: tickMs,
    intents: {
      total: sim.totalIntents,
      avgPerTurn: sim.totalIntents / Math.max(1, loaded.turnsToRun.length),
      byType: sim.intentsByType,
    },
    hashChecks: {
      expectedHashes: loaded.expectedHashes.size,
      compared: sim.hashesCompared,
      mismatches: sim.hashMismatches,
      mismatchSamples: sim.hashMismatchSamples,
    },
    warnings,
    logs,
  },
  samples: sim.samples,
  players,
  economy: economyTracker.buildReport(),
};

const d3Source = await fs.readFile(d3Path, "utf8");

const defaultOutDir = path.join(repoRoot, "tools", "replay-analyzer", "out");
await fs.mkdir(defaultOutDir, { recursive: true });

const replayBase = path.basename(loaded.absoluteReplayPath).replace(/[^a-zA-Z0-9_.-]+/g, "_");
const defaultOutPath = path.join(
  defaultOutDir,
  `${replayBase}.${new Date().toISOString().replace(/[:.]/g, "-")}.report.html`,
);
const finalOutPath = outPath ? path.resolve(process.cwd(), outPath) : defaultOutPath;
await fs.writeFile(finalOutPath, reportHtml(d3Source, report), "utf8");

console.log("");
console.log(`done: simulated ${loaded.turnsToRun.length} turns in ${Math.round(elapsedMs)}ms`);
console.log(`report: ${finalOutPath}`);
