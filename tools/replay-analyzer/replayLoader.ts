import fs from "node:fs/promises";
import path from "node:path";
import { GameRecordSchema, GameStartInfo, PartialGameRecordSchema, Turn } from "../../src/core/Schemas";
import { expandTurns, asBigInt, isId } from "./utils";

export type UnknownClientIdSample = {
  clientID: string;
  firstSeenTurn: number;
  hasNonMarkIntent: boolean;
};

type SenderClientIdMeta = {
  firstSeen: Map<string, number>;
  hasNonMarkIntent: Set<string>;
};

function collectSenderClientIdMeta(turns: Turn[]): SenderClientIdMeta {
  const firstSeen = new Map<string, number>();
  const hasNonMarkIntent = new Set<string>();

  for (const turn of turns) {
    for (const intent of turn.intents as any[]) {
      if (!isId(intent.clientID)) continue;

      const prev = firstSeen.get(intent.clientID);
      if (prev === undefined || turn.turnNumber < prev) {
        firstSeen.set(intent.clientID, turn.turnNumber);
      }

      if (intent.type !== "mark_disconnected") {
        hasNonMarkIntent.add(intent.clientID);
      }
    }
  }

  return { firstSeen, hasNonMarkIntent };
}

export type LoadedReplay = {
  absoluteReplayPath: string;
  replayGitCommit: string | null;
  record: any;
  gameStartInfo: GameStartInfo;
  clientID: string;
  expandedTurns: Turn[];
  turnsToRun: Turn[];
  expectedHashes: Map<number, number>;
  unknownClientIds: UnknownClientIdSample[];
  goldEarnedReplayByClientId: Map<string, bigint>;
};

export async function loadReplay(opts: {
  replayPath: string;
  maxTurns: number | null;
}): Promise<LoadedReplay> {
  const absoluteReplayPath = path.resolve(process.cwd(), opts.replayPath);
  const raw = await fs.readFile(absoluteReplayPath, "utf8");
  const json = JSON.parse(raw.replace(/^\uFEFF/, ""));

  const parsedGame = GameRecordSchema.safeParse(json);
  const parsedPartial = PartialGameRecordSchema.safeParse(json);
  if (!parsedGame.success && !parsedPartial.success) {
    throw new Error("Replay JSON did not match GameRecordSchema or PartialGameRecordSchema");
  }
  const record = (parsedGame.success ? parsedGame.data : parsedPartial.data) as any;
  const replayGitCommit = typeof record.gitCommit === "string" ? record.gitCommit : null;

  const goldEarnedReplayByClientId = new Map<string, bigint>();
  for (const p of (record.info.players as any[]) ?? []) {
    const clientId = typeof p?.clientID === "string" ? p.clientID : null;
    if (!clientId) continue;
    const gold = p?.stats?.gold;
    if (!Array.isArray(gold)) continue;
    let total = 0n;
    for (const entry of gold) {
      const v = asBigInt(entry);
      if (v !== null) total += v;
    }
    goldEarnedReplayByClientId.set(clientId, total);
  }

  const playersFromInfo = (record.info.players as any[]).map((p) => ({
    clientID: p.clientID,
    username: p.username,
    cosmetics: p.cosmetics,
  }));

  const senderClientIds = collectSenderClientIdMeta(record.turns as Turn[]);
  const mergedPlayers: GameStartInfo["players"] = [];
  const seenClientIds = new Set<string>();

  for (const p of playersFromInfo) {
    if (!isId(p.clientID)) continue;
    if (seenClientIds.has(p.clientID)) continue;
    seenClientIds.add(p.clientID);
    mergedPlayers.push(p);
  }

  const unknownClientIds = [...senderClientIds.firstSeen.entries()]
    .filter(([id]) => !seenClientIds.has(id))
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([clientID, firstSeenTurn]) => ({
      clientID,
      firstSeenTurn,
      hasNonMarkIntent: senderClientIds.hasNonMarkIntent.has(clientID),
    }));

  const gameStartInfo: GameStartInfo = {
    gameID: record.info.gameID,
    lobbyCreatedAt: record.info.lobbyCreatedAt,
    config: record.info.config,
    players: mergedPlayers,
  };

  const clientID = gameStartInfo.players[0]?.clientID;
  if (!clientID) {
    throw new Error("Replay has no players; cannot select a clientID");
  }

  const expandedTurns = expandTurns(record.turns as Turn[], record.info.num_turns as number);
  const turnsToRun = opts.maxTurns !== null ? expandedTurns.slice(0, opts.maxTurns) : expandedTurns;

  const expectedHashes = new Map<number, number>();
  for (const t of expandedTurns) {
    if (t.hash !== undefined && t.hash !== null) {
      expectedHashes.set(t.turnNumber, t.hash);
    }
  }

  return {
    absoluteReplayPath,
    replayGitCommit,
    record,
    gameStartInfo,
    clientID,
    expandedTurns,
    turnsToRun,
    expectedHashes,
    unknownClientIds,
    goldEarnedReplayByClientId,
  };
}

