import { createGameRunner, GameRunner } from "../../src/core/GameRunner";
import type { ErrorUpdate, GameUpdateViewData } from "../../src/core/game/GameUpdates";
import type { GameStartInfo } from "../../src/core/Schemas";
import { ensureEnvFetchShim } from "./envShim";
import { FileSystemGameMapLoader } from "./FileSystemGameMapLoader";

export async function createGameRunnerForReplay(
  gameStart: GameStartInfo,
  clientID: string,
  gameUpdate: (gu: GameUpdateViewData | ErrorUpdate) => void,
  mapsRoot: string,
): Promise<GameRunner> {
  ensureEnvFetchShim();
  const mapLoader = new FileSystemGameMapLoader(mapsRoot);
  return await createGameRunner(gameStart, clientID, mapLoader, gameUpdate);
}

