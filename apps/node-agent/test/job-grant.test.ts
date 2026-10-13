// The 24-hour token cache (ADR-0017, decision 7). The row holds the hash only. A live refusal wins and clears it,
// so the next time the hub is unreachable that token does not start a job.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TOKEN_CACHE_MS } from "@morndo/domain";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { askHub, JobGrants } from "../src/ops/job-grant.ts";
import { tempHome } from "./helpers.ts";

const HASH = "ab".repeat(32);
const TOKEN = "mat_secret-token";
const AT = 1_700_000_000_000;

const open: { adb: AgentDb; cleanup: () => void }[] = [];
afterEach(() => { for (const o of open.splice(0)) { o.adb.close(); o.cleanup(); } });

function rig(now = AT) {
  const h = tempHome();
  const adb = openAgentDb(join(h.home, "agent.db"));
  open.push({ adb, cleanup: h.cleanup });
  return { grants: new JobGrants(adb.db, () => now), adb };
}

describe("token cache", () => {
  it("stores the hash only, lets a fresh offline hash start, and drops it when the hub refuses", () => {
    const { grants, adb } = rig();
    expect(grants.decide("builder", HASH, "offline")).toBe(false);
    expect(grants.decide("builder", HASH, "allowed")).toBe(true);
    const columns = (adb.db.prepare("PRAGMA table_info(token_cache)").all() as { name: string }[]).map(c => c.name);
    expect(columns).toEqual(["lane", "hash", "checked_at"]);
    const row = adb.db.prepare("SELECT * FROM token_cache").get() as { lane: string; hash: string; checked_at: number };
    expect(row).toEqual({ lane: "builder", hash: HASH, checked_at: AT });
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(grants.decide("builder", HASH, "offline")).toBe(true);
    expect(grants.decide("other", HASH, "offline")).toBe(false);
    expect(grants.decide("builder", "cd".repeat(32), "offline")).toBe(false);
    expect(grants.decide("builder", HASH, "refused")).toBe(false);
    expect(adb.db.prepare("SELECT COUNT(*) AS n FROM token_cache").get()).toEqual({ n: 0 });
    expect(grants.decide("builder", HASH, "offline")).toBe(false);
  });

  it("drops a refused hash from every lane and leaves a different hash", () => {
    const { grants, adb } = rig();
    grants.remember("builder", HASH);
    grants.remember("reviewer", HASH);
    grants.remember("other", "cd".repeat(32));
    expect(grants.decide("builder", HASH, "refused")).toBe(false);
    expect(adb.db.prepare("SELECT lane, hash FROM token_cache ORDER BY lane").all()).toEqual([
      { lane: "other", hash: "cd".repeat(32) },
    ]);
    expect(grants.decide("reviewer", HASH, "offline")).toBe(false);
    expect(grants.decide("other", "cd".repeat(32), "offline")).toBe(true);
  });

  it("clears the cache only when the hub refuses the token, and falls back when the hub is unavailable", async () => {
    const seen: string[] = [];
    const state: { status: number; body: unknown } = { status: 200, body: {} };
    const server = createServer((req, res) => {
      req.resume();
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(state.status, { "content-type": "application/json" });
      res.end(JSON.stringify(state.body));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("hub");
    const url = `http://127.0.0.1:${address.port}`;
    const ask = () => askHub(url, TOKEN, {
      lane: "builder", id: "job-1", jobClass: "default", notify: { kind: "lane", name: "builder" }, cwdHash: "ab".repeat(32),
    });
    try {
      const { grants, adb } = rig();
      const rows = () => adb.db.prepare("SELECT lane FROM token_cache ORDER BY lane").all();
      const tokenHash = createHash("sha256").update(TOKEN).digest("hex");
      const fill = () => { grants.remember("builder", tokenHash); grants.remember("reviewer", tokenHash); };
      fill();
      state.status = 429;
      state.body = { error: "rate_limited" };
      expect(grants.admit("builder", TOKEN, await ask())).toBe("hub");
      expect(rows()).toEqual([{ lane: "builder" }, { lane: "reviewer" }]);
      state.status = 400;
      state.body = { error: "bad_name" };
      expect(grants.admit("builder", TOKEN, await ask())).toBe("hub");
      expect(rows()).toEqual([{ lane: "builder" }, { lane: "reviewer" }]);
      state.status = 500;
      state.body = { error: "internal error" };
      expect(grants.admit("builder", TOKEN, await ask())).toBe("ok");
      expect(rows()).toEqual([{ lane: "builder" }, { lane: "reviewer" }]);
      state.status = 404;
      state.body = { error: "board_off" };
      expect(grants.admit("builder", TOKEN, await ask())).toBe("hub");
      expect(rows()).toEqual([{ lane: "builder" }, { lane: "reviewer" }]);
      state.status = 401;
      state.body = { error: "rate_limited" };
      expect(grants.admit("builder", TOKEN, await ask())).toBe("hub");
      expect(rows()).toEqual([{ lane: "builder" }, { lane: "reviewer" }]);
      state.status = 401;
      state.body = { error: "revoked" };
      expect(grants.admit("builder", TOKEN, await ask())).toBe("hub");
      expect(rows()).toEqual([]);
      fill();
      state.status = 403;
      state.body = { error: "not_yours" };
      expect(grants.admit("builder", TOKEN, await ask())).toBe("hub");
      expect(rows()).toEqual([{ lane: "builder" }, { lane: "reviewer" }]);
      expect(seen.every(line => line === "POST /api/agent/jobs/grant")).toBe(true);
    } finally {
      await new Promise(resolve => server.close(() => resolve(undefined)));
    }
  });

  it("treats a hub that never answers as unavailable before the cache is touched", async () => {
    const server = createServer(() => {});
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("hub");
    const { grants, adb } = rig();
    const tokenHash = createHash("sha256").update(TOKEN).digest("hex");
    grants.remember("builder", tokenHash);
    const started = performance.now();
    try {
      const verdict = await askHub(`http://127.0.0.1:${address.port}`, TOKEN, {
        lane: "builder", id: "job-1", jobClass: "default", notify: { kind: "lane", name: "builder" }, cwdHash: "ab".repeat(32),
      }, 200);
      expect(verdict).toEqual({ kind: "unavailable" });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(grants.admit("builder", TOKEN, verdict)).toBe("ok");
      expect(adb.db.prepare("SELECT lane, hash FROM token_cache").all()).toEqual([{ lane: "builder", hash: tokenHash }]);
    } finally {
      await new Promise(resolve => server.close(() => resolve(undefined)));
    }
  });

  it("rejects a hash older than 24 hours", () => {
    const { grants } = rig(AT + TOKEN_CACHE_MS + 1);
    grants.remember("builder", HASH, AT);
    expect(grants.decide("builder", HASH, "offline")).toBe(false);
    expect(grants.decide("builder", HASH, "allowed")).toBe(true);
  });
});
