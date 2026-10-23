// The hub's board view for the not-live rule (T-308): notLiveFromHub reads /api/agent/board as the agents' CLI does and
// answers the tasks whose merges the board has not live; every way the hub can fail to answer gives null, so the rule
// is skipped, never a block.
import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { BOARD_VIEW_TIMEOUT_MS, notLiveFromHub } from "../src/relay/board-view.ts";

const TOKEN = "mgr_secret-token";
const entry = (key: string, live: boolean | null, shas: [string, string][]) => ({
  key, live, label: "", merges: shas.map(([repo, sha]) => ({ repo, sha, at: 1, by: "manager", override: null })),
});

const listen = (server: Server) => new Promise<string>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject);
    const address = server.address();
    if (!address || typeof address === "string") { reject(new Error("no port")); return; }
    resolve(`http://127.0.0.1:${address.port}`);
  });
});
const closed = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));

describe("the hub's board view", () => {
  it("sends the manager's token and lane, and answers only the merges the board has not live", async () => {
    const state: { status: number; body: unknown } = {
      status: 200,
      body: { merged: [
        entry("T-310", false, [["morndo/morndo", "5b354d6aaa"]]),
        entry("T-311", true, [["morndo/morndo", "aaaaaaaaa"]]),                  // live: not returned
        entry("T-312", null, [["morndo/morndo", "bbbbbbbbb"]]),                 // liveness unknown: not returned
        { key: "broken", live: false },                                         // not a MergedView: dropped, as the app drops it
        entry("T-313", false, [["client/client", "ccccccccc"], ["MORNDO/MORNDO", "ddddddddd"]]),
      ] },
    };
    const seen: { method?: string; url?: string; auth?: string; lane?: string }[] = [];
    const server = createServer((req, res) => {
      req.resume();
      seen.push({ method: req.method ?? "", url: req.url ?? "/", auth: req.headers.authorization ?? "", lane: String(req.headers["x-morndo-lane"]) });
      res.writeHead(state.status, { "content-type": "application/json" });
      res.end(JSON.stringify(state.body));
    });
    const url = await listen(server);
    try {
      expect(await notLiveFromHub({ hub: url, token: TOKEN, lane: "manager" })).toEqual([
        { key: "T-310", shas: ["5b354d6aaa"] },
        { key: "T-313", shas: ["ddddddddd"] },                                 // only the morndo/morndo repo's sha
      ]);
      expect(seen).toEqual([{ method: "GET", url: "/api/agent/board", auth: `Bearer ${TOKEN}`, lane: "manager" }]);
    } finally {
      await closed(server);
    }
  });

  it("answers null for a 500, a non-JSON body, no merged list, a closed port and a hub that never answers", async () => {
    const state: { status: number; raw: string } = { status: 200, raw: "{}" };
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(state.status, { "content-type": "application/json" });
      res.end(state.raw);
    });
    const url = await listen(server);
    const call = (timeoutMs?: number) => notLiveFromHub({ hub: url, token: TOKEN, lane: "manager", ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    try {
      state.status = 500;
      state.raw = JSON.stringify({ error: "internal error" });
      expect(await call()).toBeNull();
      state.status = 200;
      state.raw = "not json";
      expect(await call()).toBeNull();
      state.raw = JSON.stringify({ tasks: [] });                              // no merged array
      expect(await call()).toBeNull();
    } finally {
      await closed(server);
    }
    expect(await call()).toBeNull();                                          // the port is closed now
    const silent = createServer(() => {});
    const silentUrl = await listen(silent);
    try { expect(await notLiveFromHub({ hub: silentUrl, token: TOKEN, lane: "manager", timeoutMs: 50 })).toBeNull(); }
    finally { await closed(silent); }
  });

  it("waits about a second for the board, not longer: a Stop is held until it answers", async () => {
    expect(BOARD_VIEW_TIMEOUT_MS).toBeLessThanOrEqual(1_000);
    const silent = createServer(() => {});
    const silentUrl = await listen(silent);
    try {
      const started = performance.now();
      expect(await notLiveFromHub({ hub: silentUrl, token: TOKEN, lane: "manager" })).toBeNull();   // the default timeout
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally { silent.closeAllConnections(); await closed(silent); }
  });
});
