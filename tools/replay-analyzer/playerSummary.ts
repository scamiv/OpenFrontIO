import type { Game, Player } from "../../src/core/game/Game";
import { UnitType } from "../../src/core/game/Game";
import type { EconomyTotals, PlayerSummary } from "./types";

export function summarizePlayers(
  game: Game,
  maxTilesBySmallID: ReadonlyMap<number, number>,
  economyTotalsByClientId: ReadonlyMap<string, EconomyTotals>,
  goldEarnedReplayByClientId: ReadonlyMap<string, bigint>,
): PlayerSummary[] {
  const unitTypes = Object.values(UnitType);
  return game.allPlayers().map((p: Player) => {
    const unitsOwned: Partial<Record<UnitType, number>> = {};
    for (const t of unitTypes) {
      const count = p.unitsOwned(t);
      if (count > 0) {
        unitsOwned[t] = count;
      }
    }
    return {
      smallID: p.smallID(),
      clientID: p.clientID(),
      type: p.type(),
      name: p.name(),
      displayName: p.displayName(),
      isAlive: p.isAlive(),
      isDisconnected: p.isDisconnected(),
      tilesOwned: p.numTilesOwned(),
      tilesOwnedMax: maxTilesBySmallID.get(p.smallID()) ?? p.numTilesOwned(),
      troops: p.troops(),
      gold: p.gold().toString(),
      goldEarnedTotal: (() => {
        const cid = p.clientID();
        if (!cid) return null;
        const totals = economyTotalsByClientId.get(cid);
        return totals ? totals.earnedTotal.toString() : null;
      })(),
      goldSpentTotal: (() => {
        const cid = p.clientID();
        if (!cid) return null;
        const totals = economyTotalsByClientId.get(cid);
        return totals ? totals.spentTotal.toString() : null;
      })(),
      goldLostConquestTotal: (() => {
        const cid = p.clientID();
        if (!cid) return null;
        const totals = economyTotalsByClientId.get(cid);
        return totals ? totals.lostConquest.toString() : null;
      })(),
      goldEarnedTradeTotal: (() => {
        const cid = p.clientID();
        if (!cid) return null;
        const totals = economyTotalsByClientId.get(cid);
        return totals ? totals.earnedTrade.toString() : null;
      })(),
      goldEarnedConquerTotal: (() => {
        const cid = p.clientID();
        if (!cid) return null;
        const totals = economyTotalsByClientId.get(cid);
        return totals ? totals.earnedConquer.toString() : null;
      })(),
      goldEarnedOtherTotal: (() => {
        const cid = p.clientID();
        if (!cid) return null;
        const totals = economyTotalsByClientId.get(cid);
        return totals ? totals.earnedOther.toString() : null;
      })(),
      goldEarnedReplayTotal: (() => {
        const cid = p.clientID();
        if (!cid) return null;
        const earned = goldEarnedReplayByClientId.get(cid);
        return earned !== undefined ? earned.toString() : null;
      })(),
      unitsOwned,
    };
  });
}

