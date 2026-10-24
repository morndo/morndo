// Usage on the hub (ADR-0016): a session's status-line JSON posted under an agent token, kept per account (U1, U2),
// pushed to every feed when what is shown changed, read back by the principal, and there again after a restart of
// the service over the same store. Real server on a random port, fake passkeys, synthetic data only.
import type { WebSocket } from "ws";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import { frameText } from "./http-crash-fixture.ts";
import { UsageService } from "../src/application/usage-service.ts";
import { poolProfiles } from "../src/adapters/pool-accounts.ts";

let hub: InProcessHub;
let now: number;
let workerToken: string;
const HOUR = 3_600_000;
type Body = Record<string, unknown>;

// A status line's JSON as Claude Code gives it (code.claude.com/docs/en/statusline): resets_at in epoch seconds, and
// much the hub doesn't read.
const statusLine = (o: { session?: string; five?: number | null; week?: number | null; ctx?: number; spend?: boolean } = {}) => ({
  cwd: "/w", session_id: o.session ?? "s1", model: { id: "claude-opus-5-5", display_name: "Opus" }, version: "2.1.295",
  cost: { total_cost_usd: 0.1 }, context_window: { used_percentage: o.ctx ?? 8, remaining_percentage: 92 },
  ...(o.five === null && o.week === null ? {} : {
    rate_limits: {
      ...(o.five === null ? {} : { five_hour: { used_percentage: o.five ?? 23.5, resets_at: Math.floor((now + 2 * HOUR) / 1000) } }),
      ...(o.week === null ? {} : { seven_day: { used_percentage: o.week ?? 41.2, resets_at: Math.floor((now + 72 * HOUR) / 1000) } }),
      ...(o.spend ? { spend_limit: { used_percentage: 62.8, resets_at: Math.floor((now + 500 * HOUR) / 1000), used_usd: 314.12, limit_usd: 500, period: "monthly" } } : {}),
    },
  }),
});
const post = (body: unknown, account?: string, lane = "builder", token = workerToken) => fetch(`${hub.base}/api/agent/usage`, {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-morndo-lane": lane, ...(account ? { "x-morndo-account": account } : {}) }, body: JSON.stringify(body),
});
const json = async (r: Response) => (await r.json()) as Body;
function frames(ws: WebSocket) {
  const seen: Record<string, unknown>[] = [];
  const waiters: { t: string; resolve: (m: Record<string, unknown>) => void }[] = [];
  ws.on("message", d => { const m = JSON.parse(frameText(d)) as Record<string, unknown>; seen.push(m); const i = waiters.findIndex(w => w.t === m.t); if (i !== -1) { waiters[i]?.resolve(m); waiters.splice(i, 1); } });
  const next = (t: string, from = seen.length) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const had = seen.slice(from).find(m => m.t === t);
    if (had) return resolve(had);
    waiters.push({ t, resolve });
    setTimeout(() => reject(new Error(`no ${t} frame; seen ${JSON.stringify(seen.map(m => m.t))}`)), 3000);
  });
  return { seen, next };
}

beforeEach(async () => {
  now = Date.now();
  hub = await startInProcessHub({ now: () => now });
  workerToken = hub.agents.issue("lanes", "worker").secret;
});
afterEach(async () => { await hub.close(); });

describe("reports under an agent token (U1)", () => {
  it("a status line's JSON becomes the account's windows, in ms, with the session, its lane and its model", async () => {
    const r = await post(statusLine({ spend: true }), "max-1");
    expect(r.status).toBe(200);
    const a = (await json(r)).account as Body;
    expect(a).toMatchObject({ account: "max-1", reportedAt: now, fiveHour: { usedPercentage: 23.5 }, sevenDay: { usedPercentage: 41.2 }, spend: { usedUsd: 314.12, limitUsd: 500, period: "monthly" } });
    expect((a.fiveHour as Body).resetsAt).toBe(Math.floor((now + 2 * HOUR) / 1000) * 1000);
    expect(a.sessions).toEqual([{ sessionId: "s1", lane: "builder", model: "Opus", contextUsed: 8, at: now }]);
  });
  it("no account header is the default account; a bad name is refused; no token is refused; a bad body is 400", async () => {
    expect(((await json(await post(statusLine()))).account as Body).account).toBe("default");
    expect(await json(await post(statusLine(), "bad name"))).toEqual({ error: "bad_account" });
    expect((await fetch(`${hub.base}/api/agent/usage`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await post({ no_session: true }, "max-1")).status).toBe(400);
  });
  it("reports before the first reply carry no windows and never clear what another session reported (U2)", async () => {
    await post(statusLine({ session: "s1" }), "max-1");
    now += 1000;
    const a = (await json(await post(statusLine({ session: "s2", five: null, week: null }), "max-1"))).account as Body;
    expect(a).toMatchObject({ fiveHour: { usedPercentage: 23.5 }, sevenDay: { usedPercentage: 41.2 } });
    expect((a.sessions as Body[]).map(s => s.sessionId)).toEqual(["s2", "s1"]);
  });
  it("a window with an epoch value in its percentage is unknown, not the old number shown as fresh (U14)", async () => {
    await post(statusLine({ session: "s1", five: 60, week: 40 }), "max-1");
    now += 10 * 60_000;
    const a = (await json(await post(statusLine({ session: "s1", five: 1_700_000_000, week: 41 }), "max-1"))).account as Body;
    expect(a.fiveHour).toBeNull();
    expect(a.sevenDay).toMatchObject({ usedPercentage: 41 });
    expect(a.reportedAt).toBe(now);
  });
  it("a report that names its windows keeps those bars and does not invent a 5-hour window", async () => {
    const resets = Math.floor((now + 27 * 24 * HOUR) / 1000);
    const body = {
      session_id: "cursor-plan", model: { display_name: "Cursor Ultra" },
      rate_limits: { spend_limit: { used_percentage: 85, resets_at: resets } },
      limits: [
        { label: "Cursor models", used_percentage: 88, resets_at: resets, resets_on: "2026-11-07" },
        { label: "Other models", used_percentage: 45, resets_at: resets, resets_on: "2026-11-07" },
      ],
      on_demand: "off",
    };
    const a = (await json(await post(body, "cursor"))).account as Body;
    expect(a.fiveHour).toBeNull();
    expect(a.sevenDay).toBeNull();
    expect(a.onDemand).toBe("off");
    expect(a.limits).toEqual([
      { label: "Cursor models", usedPercentage: 88, resetsAt: resets * 1000, resetsOn: "2026-11-07" },
      { label: "Other models", usedPercentage: 45, resetsAt: resets * 1000, resetsOn: "2026-11-07" },
    ]);
  });
  it("a bad named row is dropped and the session and spend are kept; nine windows keep eight", async () => {
    const resets = Math.floor((now + 27 * 24 * HOUR) / 1000);
    const limits = [{ label: "", used_percentage: 1 }, ...Array.from({ length: 8 }, (_, i) => ({ label: `W${i}`, used_percentage: 10 + i, resets_at: resets }))];
    const posted = await post({
      session_id: "cursor-plan",
      rate_limits: { spend_limit: { used_percentage: 85, resets_at: resets } },
      limits, on_demand: "off",
    }, "cursor");
    expect(posted.status).toBe(200);
    const a = (await json(posted)).account as Body;
    expect((a.limits as Body[]).map(w => w.label)).toEqual(Array.from({ length: 8 }, (_, i) => `W${i}`));
    expect((a.spend as Body).usedPercentage).toBe(85);
    expect((a.sessions as Body[])[0]?.sessionId).toBe("cursor-plan");
    const junk = { label: "\u0001", used_percentage: 10, resets_at: resets };
    const kept = Array.from({ length: 9 }, (_, i) => ({ label: `W${i}`, used_percentage: 10 + i, resets_at: resets }));
    const capped = await post({
      session_id: "cursor-plan",
      rate_limits: { spend_limit: { used_percentage: 85, resets_at: resets } },
      limits: [...Array.from({ length: 8 }, () => junk), ...kept],
    }, "slots");
    expect(capped.status).toBe(200);
    const b = (await json(capped)).account as Body;
    expect((b.limits as Body[]).map(w => w.label)).toEqual(Array.from({ length: 8 }, (_, i) => `W${i}`));
  });
  it("a row of the wrong type and an over-long on-demand line do not reject the report", async () => {
    const resets = Math.floor((now + 27 * 24 * HOUR) / 1000);
    const phrase = `on-demand ${"y".repeat(100)}`;
    const posted = await post({
      session_id: "cursor-plan",
      rate_limits: { spend_limit: { used_percentage: 85, resets_at: resets } },
      limits: [
        { label: 42, used_percentage: 10 },
        { used_percentage: "50" },
        { label: "Kept", used_percentage: 12, resets_on: 20261107, resets_at: resets },
        null,
      ],
      on_demand: phrase,
    }, "cursor");
    expect(posted.status).toBe(200);
    const a = (await json(posted)).account as Body;
    expect((a.limits as Body[]).map(w => w.label)).toEqual(["Kept"]);
    expect((a.spend as Body).usedPercentage).toBe(85);
    expect((a.sessions as Body[])[0]?.sessionId).toBe("cursor-plan");
    expect(a.onDemand).toBe(phrase.slice(0, 80));
  });
  it("once the named windows reset, the account is a normal card and on-demand is gone", async () => {
    const resets = Math.floor((now + 2 * HOUR) / 1000);
    await post({
      session_id: "cursor-plan",
      limits: [{ label: "Cursor models", used_percentage: 88, resets_at: resets }],
      on_demand: "off",
    }, "cursor");
    now += 3 * HOUR;
    const cookie = await hub.cookie();
    const later = await json(await fetch(`${hub.base}/api/usage`, { headers: { cookie: `__Host-morndo=${cookie}` } }));
    const cursor = (later.accounts as Body[]).find(a => a.account === "cursor");
    expect(cursor?.limits).toBeNull();
    expect(cursor?.onDemand).toBeNull();
  });
  it("the manager's token reports as the manager's lane", async () => {
    const manager = hub.agents.issue("manager", "manager").secret;
    const a = (await json(await post(statusLine(), "max-1", "", manager))).account as Body;
    expect((a.sessions as Body[])[0]?.lane).toBe("manager");
  });
});

describe("the principal's side and the feed", () => {
  it("GET /api/usage lists every account, sorted, with past resets dropped and only fresh sessions", async () => {
    await post(statusLine({ session: "a1" }), "max-2");
    await post(statusLine({ session: "b1", five: 92 }), "max-1");
    const cookie = await hub.cookie();
    const v = await json(await fetch(`${hub.base}/api/usage`, { headers: { cookie: `__Host-morndo=${cookie}` } }));
    expect((v.accounts as Body[]).map(a => a.account)).toEqual(["max-1", "max-2"]);
    now += 3 * HOUR;                                                   // the 5-hour windows reset 2 h out; sessions went quiet
    const later = await json(await fetch(`${hub.base}/api/usage`, { headers: { cookie: `__Host-morndo=${cookie}` } }));
    expect((later.accounts as Body[])[0]).toMatchObject({ fiveHour: null, sevenDay: { usedPercentage: 41.2 }, sessions: [] });
    expect((await fetch(`${hub.base}/api/usage`)).status).toBe(401);
  });
  it("every feed gets the accounts after its hello, and again only when a report changed what is shown", async () => {
    const cookie = await hub.cookie();
    const ws = await hub.socket("/api/feed", cookie);
    const f = frames(ws);
    ws.send(JSON.stringify({ t: "hello" }));
    expect(await f.next("usage")).toMatchObject({ t: "usage", accounts: [] });
    let mark = f.seen.length;
    expect((await post(statusLine(), "max-1")).status).toBe(200);
    expect(((await f.next("usage", mark)).accounts as Body[])[0]).toMatchObject({ account: "max-1" });
    mark = f.seen.length;
    expect((await post(statusLine(), "max-1")).status).toBe(200);     // the same again: nothing shown changed
    await new Promise(r => setTimeout(r, 300));
    expect(f.seen.slice(mark).filter(m => m.t === "usage")).toEqual([]);
    expect((await post(statusLine({ five: 30 }), "max-1")).status).toBe(200);
    const changed = ((await f.next("usage", mark)).accounts as Body[])[0] as Body;
    expect((changed.fiveHour as Body).usedPercentage).toBe(30);
    ws.close();
  });
  it("the accounts are there again after the service restarts over the same store", async () => {
    await post(statusLine({ session: "s1", spend: true }), "max-1");
    const again = new UsageService({ store: hub.store, now: () => now });
    expect(again.view().accounts.map(a => ({ account: a.account, five: a.fiveHour?.usedPercentage, spend: a.spend?.usedUsd, sessions: a.sessions.length }))).toEqual([{ account: "max-1", five: 23.5, spend: 314.12, sessions: 1 }]);
  });
});

describe("account labels from the pool's file (U5)", () => {
  let poolDir = "";
  const writePool = (lines: unknown[]) => writeFileSync(join(poolDir, "usage.jsonl"), `${lines.map(l => JSON.stringify(l)).join("\n")}\n`);
  const a3 = (tier: string) => ({ name: "a3", email: "ada@example.test", org: "claude_team", tier, plan: "max", orgId: "org-0001" });
  let pool: ReturnType<typeof poolProfiles>;
  const restart = async () => {
    await hub.close();
    pool = poolProfiles(join(poolDir, "usage.jsonl"));
    await pool.refresh();
    hub = await startInProcessHub({ now: () => now, profiles: pool.current });
    workerToken = hub.agents.issue("lanes", "worker").secret;
  };
  const accountsOf = async (cookie: string) => (await json(await fetch(`${hub.base}/api/usage`, { headers: { cookie: `__Host-morndo=${cookie}` } }))).accounts as Body[];

  beforeEach(() => {
    poolDir = mkdtempSync(join(tmpdir(), "morndo-pool-"));
    writePool([a3("default_claude_max_5x")]);
  });
  afterEach(() => { rmSync(poolDir, { recursive: true, force: true }); });

  it("the principal's GET shows a reporting account's profile and only its; the agent door's reply carries none", async () => {
    await restart();
    await post(statusLine(), "a3");
    await post(statusLine(), "b9");
    const cookie = await hub.cookie();
    const accounts = await accountsOf(cookie);
    expect(accounts.find(a => a.account === "a3")?.profile).toEqual({ email: "ada@example.test", org: "team", plan: "Max 5x" });
    expect(accounts.find(a => a.account === "b9")?.profile).toBeNull();        // reports, but is not in the file
    const reply = await json(await post(statusLine({ session: "s2" }), "a3"));
    expect((reply.account as Body).profile).toBeNull();                        // U5: never in the agent door's reply
    expect(JSON.stringify(reply)).not.toContain("example.test");
  });

  it("a changed file reaches a connected feed without a report; an unchanged look tells nobody", async () => {
    await restart();
    const cookie = await hub.cookie();
    const ws = await hub.socket("/api/feed", cookie);
    const f = frames(ws);
    ws.send(JSON.stringify({ t: "hello" }));
    await f.next("usage");
    let mark = f.seen.length;
    expect((await post(statusLine(), "a3")).status).toBe(200);
    expect((((await f.next("usage", mark)).accounts as Body[])[0] as Body).profile).toEqual({ email: "ada@example.test", org: "team", plan: "Max 5x" });
    mark = f.seen.length;
    writePool([a3("default_claude_max_20x")]);                                 // the file changed, with every lane quiet
    await pool.refresh();
    hub.usage.refreshProfiles();
    expect((((await f.next("usage", mark)).accounts as Body[])[0] as Body).profile).toMatchObject({ plan: "Max 20x" });
    mark = f.seen.length;
    hub.usage.refreshProfiles();                                               // nothing changed since
    await new Promise(r => setTimeout(r, 300));
    expect(f.seen.slice(mark).filter(m => m.t === "usage")).toEqual([]);
    ws.close();
  });

  it("with no profiles source, every profile is null", async () => {
    await post(statusLine(), "a3");                                            // the beforeEach hub, no pool file wired
    const cookie = await hub.cookie();
    expect((await accountsOf(cookie)).find(a => a.account === "a3")?.profile).toBeNull();
  });
});
