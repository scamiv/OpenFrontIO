export function ensureEnvFetchShim() {
  const key = "__openfrontReplayAnalyzerEnvFetchShim";
  const g = globalThis as any;
  if (g[key]) return;
  if (typeof g.fetch !== "function") return;

  const originalFetch = g.fetch.bind(globalThis);
  g.fetch = async (input: any, init?: any) => {
    if (typeof input === "string" && input === "/api/env") {
      const game_env = process.env.GAME_ENV ?? "dev";
      return new Response(JSON.stringify({ game_env }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (typeof input === "string" && input.startsWith("/")) {
      throw new Error(`Replay analyzer cannot fetch relative URL: ${input}`);
    }
    return await originalFetch(input, init);
  };

  g[key] = true;
}

