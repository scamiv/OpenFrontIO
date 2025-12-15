import { PlayerType, UnitType } from "../../src/core/game/Game";

export type TickSample = {
  turnNumber: number;
  gameTick: number;
  tickExecutionMs: number;
  intents: number;
  aliveHumans: number;
  connectedAliveHumans: number;
  spawnedHumans: number;
};

export type PlayerSummary = {
  smallID: number;
  clientID: string | null;
  type: PlayerType;
  name: string;
  displayName: string;
  isAlive: boolean;
  isDisconnected: boolean;
  tilesOwned: number;
  tilesOwnedMax: number;
  troops: number;
  gold: string;
  goldEarnedTotal: string | null;
  goldSpentTotal: string | null;
  goldLostConquestTotal: string | null;
  goldEarnedTradeTotal: string | null;
  goldEarnedConquerTotal: string | null;
  goldEarnedOtherTotal: string | null;
  goldEarnedReplayTotal: string | null;
  unitsOwned: Partial<Record<UnitType, number>>;
};

export type EconomyPlayerSeries = {
  earnedTrade: number[];
  earnedConquer: number[];
  earnedOther: number[];
  spentTotal: number[];
  spentOther: number[];
  lostConquest: number[];
};

export type EconomyTotals = {
  earnedTotal: bigint;
  earnedTrade: bigint;
  earnedConquer: bigint;
  earnedOther: bigint;
  spentTotal: bigint;
  spentOther: bigint;
  lostConquest: bigint;
};

export type EconomyReport = {
  sampleEveryTurns: number;
  turns: number[];
  players: { clientID: string; displayName: string }[];
  seriesByClientId: Record<string, EconomyPlayerSeries>;
  top: {
    earnedTrade: string[];
    earnedConquer: string[];
    earnedOther: string[];
    spentTotal: string[];
  };
};

export type WarningSummary = {
  total: number;
  missingClientId: { total: number; top: { clientID: string; count: number }[] };
  missingTargetId: { total: number; top: { targetID: string; count: number }[] };
  other: { total: number; top: { message: string; count: number }[] };
};

export type LogsSummary = {
  total: number;
  log: { total: number; top: { message: string; count: number }[] };
  info: { total: number; top: { message: string; count: number }[] };
};

export type ReplayPerfReport = {
  meta: {
    generatedAt: string;
    replayPath: string;
    gameID: string;
    replayGitCommit: string | null;
    map: string;
    mapSize: string;
    numTurns: number;
    numTicksSimulated: number;
    players: { total: number; humans: number; bots: number; fakeHumans: number };
    unknownClientIds: {
      total: number;
      withNonMarkIntents: number;
      markOnly: number;
      samples: { clientID: string; firstSeenTurn: number; hasNonMarkIntent: boolean }[];
    };
  };
  summary: {
    tickExecutionMs: {
      avg: number;
      p50: number;
      p95: number;
      p99: number;
      max: number;
    };
    intents: { total: number; avgPerTurn: number; byType: Record<string, number> };
    hashChecks: {
      expectedHashes: number;
      compared: number;
      mismatches: number;
      mismatchSamples: { tick: number; expected: number; actual: number }[];
    };
    warnings: WarningSummary;
    logs: LogsSummary;
  };
  samples: TickSample[];
  players: PlayerSummary[];
  economy: EconomyReport;
};

