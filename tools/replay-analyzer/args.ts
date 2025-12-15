export function usage(): string {
  return [
    "Replay performance analyzer",
    "",
    "Usage:",
    "  npx tsx tools/replay-analyzer/analyzeReplay.ts <replay.json> [--out <report.html>] [--maxTurns <n>] [--economySampleEvery <n>] [--verbose]",
    "",
    "Notes:",
    "  - Accepts OpenFront GameRecord / PartialGameRecord JSON.",
    "  - Runs the same tick engine used by the worker (GameRunner) and records per-tick execution time.",
    "  - Economy series are computed from in-engine Stats + gold balances and sampled every N turns to keep report size reasonable.",
  ].join("\n");
}

export function parseArgs(argv: string[]): {
  replayPath: string | null;
  outPath: string | null;
  maxTurns: number | null;
  economySampleEvery: number;
  help: boolean;
  verbose: boolean;
} {
  let replayPath: string | null = null;
  let outPath: string | null = null;
  let maxTurns: number | null = null;
  let economySampleEvery = 10;
  let help = false;
  let verbose = false;

  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--verbose" || arg === "-v") {
      verbose = true;
      continue;
    }
    if (arg === "--out") {
      outPath = args.shift() ?? null;
      continue;
    }
    if (arg === "--maxTurns") {
      const value = args.shift();
      maxTurns = value ? Number.parseInt(value, 10) : NaN;
      if (!Number.isFinite(maxTurns)) {
        throw new Error(`Invalid --maxTurns: ${value ?? ""}`);
      }
      continue;
    }
    if (arg === "--economySampleEvery") {
      const value = args.shift();
      economySampleEvery = value ? Number.parseInt(value, 10) : NaN;
      if (!Number.isFinite(economySampleEvery) || economySampleEvery <= 0) {
        throw new Error(`Invalid --economySampleEvery: ${value ?? ""}`);
      }
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    if (replayPath === null) {
      replayPath = arg;
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }

  return { replayPath, outPath, maxTurns, economySampleEvery, help, verbose };
}

