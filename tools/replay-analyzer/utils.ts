import type { Turn } from "../../src/core/Schemas";

export function topN(
  map: ReadonlyMap<string, number>,
  n: number,
): { key: string; count: number }[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, p * (sorted.length - 1)));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const t = idx - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

export function expandTurns(turns: Turn[], numTurns: number): Turn[] {
  const sorted = [...turns].sort((a, b) => a.turnNumber - b.turnNumber);
  const expanded: Turn[] = [];
  let lastTurnNum = -1;

  for (const turn of sorted) {
    while (lastTurnNum < turn.turnNumber - 1) {
      lastTurnNum++;
      expanded.push({ turnNumber: lastTurnNum, intents: [] });
    }
    expanded.push(turn);
    lastTurnNum = turn.turnNumber;
  }
  for (let i = expanded.length; i < numTurns; i++) {
    expanded.push({ turnNumber: i, intents: [] });
  }
  return expanded;
}

const idRegex = /^[a-zA-Z0-9]{8}$/;
export function isId(value: unknown): value is string {
  return typeof value === "string" && idRegex.test(value);
}

const bigIntRegex = /^-?\d+$/;
export function asBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && bigIntRegex.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    return BigInt(value);
  }
  return null;
}

export function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function bigintToNumberSafe(value: bigint): number {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (value >= max) return Number.MAX_SAFE_INTEGER;
  if (value <= -max) return -Number.MAX_SAFE_INTEGER;
  return Number(value);
}

