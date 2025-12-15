import type { Game, Player } from "../../src/core/game/Game";
import type { ConquestUpdate } from "../../src/core/game/GameUpdates";
import type { EconomyReport, EconomyTotals } from "./types";
import { asBigInt, bigintToNumberSafe, minBigInt } from "./utils";

type GoldStats = { work: bigint; war: bigint; trade: bigint; steal: bigint };

function readGoldStatsForClient(allPlayersStats: any, clientID: string): GoldStats {
  const ps = allPlayersStats?.[clientID];
  const gold = ps?.gold;
  if (!Array.isArray(gold)) {
    return { work: 0n, war: 0n, trade: 0n, steal: 0n };
  }
  return {
    work: asBigInt(gold[0]) ?? 0n,
    war: asBigInt(gold[1]) ?? 0n,
    trade: asBigInt(gold[2]) ?? 0n,
    steal: asBigInt(gold[3]) ?? 0n,
  };
}

function topEconomyClientIds(
  totalsByClientId: ReadonlyMap<string, EconomyTotals>,
  metric: "earnedTrade" | "earnedConquer" | "earnedOther" | "spentTotal",
  n: number,
): string[] {
  return [...totalsByClientId.entries()]
    .sort((a, b) => {
      const av = a[1][metric];
      const bv = b[1][metric];
      if (av === bv) return a[0].localeCompare(b[0]);
      return av > bv ? -1 : 1;
    })
    .slice(0, n)
    .map(([cid]) => cid);
}

export type EconomyTracker = {
  totalsByClientId: ReadonlyMap<string, EconomyTotals>;
  init: (game: Game) => void;
  afterTick: (game: Game, turnNumber: number, conquestEvents: ConquestUpdate[], isLast: boolean) => void;
  buildReport: () => EconomyReport;
};

export function createEconomyTracker(opts: { sampleEveryTurns: number; topN: number }): EconomyTracker {
  const totalsByClientId = new Map<string, EconomyTotals>();
  const turns: number[] = [];
  const players: { clientID: string; displayName: string }[] = [];
  const seriesByClientId: Record<
    string,
    {
      earnedTrade: number[];
      earnedConquer: number[];
      earnedOther: number[];
      spentTotal: number[];
      spentOther: number[];
      lostConquest: number[];
    }
  > = {};

  const playerByClientId = new Map<string, Player>();
  const prevGoldByClientId = new Map<string, bigint>();
  const prevGoldStatsByClientId = new Map<string, GoldStats>();
  const clientIdByPlayerId = new Map<string, string>();

  function ensurePlayer(p: Player) {
    const cid = p.clientID();
    if (!cid) return;
    if (seriesByClientId[cid]) return;

    players.push({ clientID: cid, displayName: p.displayName() });
    seriesByClientId[cid] = {
      earnedTrade: [],
      earnedConquer: [],
      earnedOther: [],
      spentTotal: [],
      spentOther: [],
      lostConquest: [],
    };
    totalsByClientId.set(cid, {
      earnedTotal: 0n,
      earnedTrade: 0n,
      earnedConquer: 0n,
      earnedOther: 0n,
      spentTotal: 0n,
      spentOther: 0n,
      lostConquest: 0n,
    });
    playerByClientId.set(cid, p);
    prevGoldByClientId.set(cid, p.gold());
    prevGoldStatsByClientId.set(cid, { work: 0n, war: 0n, trade: 0n, steal: 0n });
  }

  return {
    totalsByClientId,
    init: (game: Game) => {
      for (const p of game.allPlayers()) {
        if (!p.isPlayer()) continue;
        ensurePlayer(p);
        const cid = p.clientID();
        if (cid) {
          clientIdByPlayerId.set(String(p.id()), cid);
        }
      }

      const initialStats = game.stats().stats();
      for (const { clientID: cid } of players) {
        prevGoldStatsByClientId.set(cid, readGoldStatsForClient(initialStats, cid));
      }
    },
    afterTick: (game: Game, turnNumber: number, conquestEvents: ConquestUpdate[], isLast: boolean) => {
      const conquestLossByClientIdThisTick = new Map<string, bigint>();
      for (const cu of conquestEvents ?? []) {
        const conqueredId = String((cu as any).conqueredId ?? "");
        const gold = asBigInt((cu as any).gold) ?? 0n;
        if (!conqueredId || gold <= 0n) continue;
        const cid = clientIdByPlayerId.get(conqueredId);
        if (!cid) continue;
        conquestLossByClientIdThisTick.set(cid, (conquestLossByClientIdThisTick.get(cid) ?? 0n) + gold);
      }

      const allStats = game.stats().stats();
      for (const { clientID: cid } of players) {
        const p = playerByClientId.get(cid) ?? game.playerByClientID(cid);
        if (!p) continue;
        playerByClientId.set(cid, p);

        const goldNow = p.gold();
        const goldPrev = prevGoldByClientId.get(cid) ?? goldNow;
        const deltaBalance = goldNow - goldPrev;

        const currGoldStats = readGoldStatsForClient(allStats, cid);
        const prevGoldStats = prevGoldStatsByClientId.get(cid) ?? currGoldStats;

        const dWork = currGoldStats.work > prevGoldStats.work ? (currGoldStats.work - prevGoldStats.work) : 0n;
        const dWar = currGoldStats.war > prevGoldStats.war ? (currGoldStats.war - prevGoldStats.war) : 0n;
        const dTrade = currGoldStats.trade > prevGoldStats.trade ? (currGoldStats.trade - prevGoldStats.trade) : 0n;
        const dSteal = currGoldStats.steal > prevGoldStats.steal ? (currGoldStats.steal - prevGoldStats.steal) : 0n;

        const deltaKnownEarned = dWork + dWar + dTrade + dSteal;
        const residual = deltaBalance - deltaKnownEarned;
        const deltaEarnedOther = residual > 0n ? residual : 0n;
        const deltaOutflow = residual < 0n ? -residual : 0n;

        const conquestLoss = conquestLossByClientIdThisTick.get(cid) ?? 0n;
        const deltaLostConquest = minBigInt(deltaOutflow, conquestLoss);
        const deltaSpentOther = deltaOutflow - deltaLostConquest;

        const totals = totalsByClientId.get(cid);
        if (totals) {
          totals.earnedTrade += dTrade;
          totals.earnedConquer += dWar;
          totals.earnedOther += deltaEarnedOther;
          totals.earnedTotal += deltaKnownEarned + deltaEarnedOther;
          totals.spentTotal += deltaOutflow;
          totals.spentOther += deltaSpentOther;
          totals.lostConquest += deltaLostConquest;
        }

        prevGoldByClientId.set(cid, goldNow);
        prevGoldStatsByClientId.set(cid, currGoldStats);
      }

      const shouldSample = turnNumber % opts.sampleEveryTurns === 0 || isLast;
      if (shouldSample) {
        turns.push(turnNumber);
        for (const { clientID: cid } of players) {
          const totals = totalsByClientId.get(cid);
          const series = seriesByClientId[cid];
          if (!totals || !series) continue;
          series.earnedTrade.push(bigintToNumberSafe(totals.earnedTrade));
          series.earnedConquer.push(bigintToNumberSafe(totals.earnedConquer));
          series.earnedOther.push(bigintToNumberSafe(totals.earnedOther));
          series.spentTotal.push(bigintToNumberSafe(totals.spentTotal));
          series.spentOther.push(bigintToNumberSafe(totals.spentOther));
          series.lostConquest.push(bigintToNumberSafe(totals.lostConquest));
        }
      }
    },
    buildReport: () => ({
      sampleEveryTurns: opts.sampleEveryTurns,
      turns,
      players,
      seriesByClientId,
      top: {
        earnedTrade: topEconomyClientIds(totalsByClientId, "earnedTrade", opts.topN),
        earnedConquer: topEconomyClientIds(totalsByClientId, "earnedConquer", opts.topN),
        earnedOther: topEconomyClientIds(totalsByClientId, "earnedOther", opts.topN),
        spentTotal: topEconomyClientIds(totalsByClientId, "spentTotal", opts.topN),
      },
    }),
  };
}
