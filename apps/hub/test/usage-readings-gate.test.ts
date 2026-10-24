// The role gate on usage readings (T-430, slice 1). POST /api/agent/usage/readings takes a manager token or a worker
// token with the usage-pool scope, like the lease and limit routes. It ships in `warn`: a reading from a plain worker
// token is still accepted and counted on that token (unbound_count, shown by `agent-token list`). `enforce` (the
// MORNDO_USAGE_READINGS_GATE setting, default warn) refuses it with a clear error. Real server on a random port, fake
// clock, synthetic data only.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { MIGRATIONS, migrate } from "../src/adapters/migrations.ts";
import { agentTokenLine } from "../src/console/agent-token.ts";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

let hub: InProcessHub;
let now: number;
const HOUR = 3_600_000;
const dirs: string[] = [];
const when = (t: number | null) => (t === null ? "-" : `t${t}`);

const start = async (gate?: "warn" | "enforce") => {
  hub = await startInProcessHub({ now: () => now, ...(gate ? { readingsGate: gate } : {}) });
};
const tokens = (h: InProcessHub) => ({
  plain: h.agents.issue("lanes", "worker"),
  pool: h.agents.issue("collector", "worker", ["usage-pool"]),
  manager: h.agents.issue("manager", "manager"),
});
const unboundOf = (id: string) => hub.agents.list().find(t => t.id === id);

const fiveHour = (usedPercent: number) => ({ id: "five_hour", used_percent: usedPercent, resets_at: Math.floor((now + 2 * HOUR) / 1000), length_mins: 300 });
const reading = (secret: string, account = "seat-a", used = 30) => fetch(`${hub.base}/api/agent/usage/readings`, {
  method: "POST",
  headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "x-morndo-lane": "collector", "x-morndo-account": account },
  body: JSON.stringify({ source: "app-server", node: null, captured_at: Math.floor(now / 1000), windows: [fiveHour(used)] }),
});
const statusLine = (secret: string, account = "seat-a") => fetch(`${hub.base}/api/agent/usage`, {
  method: "POST",
  headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "x-morndo-lane": "builder", "x-morndo-account": account },
  body: JSON.stringify({ session_id: "s1", rate_limits: { five_hour: { used_percentage: 12, resets_at: Math.floor((now + 2 * HOUR) / 1000) } } }),
});
const shownFiveHour = async (account = "seat-a") => {
  const cookie = await hub.cookie();
  const view = (await (await fetch(`${hub.base}/api/usage`, { headers: { cookie: `__Host-morndo=${cookie}` } })).json()) as { accounts: { account: string; fiveHour?: { usedPercentage?: number } }[] };
  return view.accounts.find(a => a.account === account)?.fiveHour?.usedPercentage;
};

beforeEach(() => { now = 1_700_000_000_000; });
afterEach(async () => {
  await hub.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readings role gate, warn (the default)", () => {
  beforeEach(() => start());

  it("a plain worker token's reading is accepted and counted on that token", async () => {
    const t = tokens(hub);
    expect(unboundOf(t.plain.token.id)?.unboundCount).toBe(0);
    expect((await reading(t.plain.secret, "seat-a", 30)).status).toBe(200);
    expect(await shownFiveHour()).toBe(30);
    expect(unboundOf(t.plain.token.id)).toMatchObject({ unboundCount: 1, lastUnboundAt: now });
    now += 5 * 60_000;
    expect((await reading(t.plain.secret, "seat-a", 31)).status).toBe(200);
    expect(unboundOf(t.plain.token.id)).toMatchObject({ unboundCount: 2, lastUnboundAt: now });
  });

  it("a usage-pool token's reading is accepted and not counted", async () => {
    const t = tokens(hub);
    expect((await reading(t.pool.secret)).status).toBe(200);
    expect(await shownFiveHour()).toBe(30);
    expect(unboundOf(t.pool.token.id)).toMatchObject({ unboundCount: 0, lastUnboundAt: null });
  });

  it("the manager token's reading is accepted and not counted", async () => {
    const t = tokens(hub);
    expect((await reading(t.manager.secret)).status).toBe(200);
    expect(unboundOf(t.manager.token.id)).toMatchObject({ unboundCount: 0, lastUnboundAt: null });
  });

  it("the status line route is not part of the gate: a plain token posts it and nothing is counted", async () => {
    const t = tokens(hub);
    expect((await statusLine(t.plain.secret)).status).toBe(200);
    expect(unboundOf(t.plain.token.id)?.unboundCount).toBe(0);
  });

  it("the count belongs to the posting token only", async () => {
    const t = tokens(hub);
    const other = hub.agents.issue("other-lanes", "worker");
    await reading(t.plain.secret);
    expect(unboundOf(t.plain.token.id)?.unboundCount).toBe(1);
    expect(unboundOf(other.token.id)?.unboundCount).toBe(0);
  });
});

describe("readings role gate, enforce", () => {
  beforeEach(() => start("enforce"));

  it("refuses a plain worker token with a clear error, stores nothing, and still counts the attempt", async () => {
    const t = tokens(hub);
    const r = await reading(t.plain.secret, "seat-a", 30);
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string; message?: string };
    expect(body.error).toBe("scope_required");
    expect(body.message).toMatch(/usage-pool/);
    expect(await shownFiveHour()).toBeUndefined();
    expect(unboundOf(t.plain.token.id)?.unboundCount).toBe(1);
  });

  it("still accepts a usage-pool token and the manager token", async () => {
    const t = tokens(hub);
    expect((await reading(t.pool.secret, "seat-a", 40)).status).toBe(200);
    expect((await reading(t.manager.secret, "seat-b", 41)).status).toBe(200);
    expect(await shownFiveHour("seat-a")).toBe(40);
    expect(await shownFiveHour("seat-b")).toBe(41);
    expect(unboundOf(t.pool.token.id)?.unboundCount).toBe(0);
    expect(unboundOf(t.manager.token.id)?.unboundCount).toBe(0);
  });

  it("leaves the lanes' status line alone", async () => {
    const t = tokens(hub);
    expect((await statusLine(t.plain.secret)).status).toBe(200);
  });
});

describe("the setting", () => {
  it("MORNDO_USAGE_READINGS_GATE defaults to warn; enforce and warn are the only words", () => {
    expect(loadConfig({}).usageReadingsGate).toBe("warn");
    expect(loadConfig({ MORNDO_USAGE_READINGS_GATE: "" }).usageReadingsGate).toBe("warn");
    expect(loadConfig({ MORNDO_USAGE_READINGS_GATE: "warn" }).usageReadingsGate).toBe("warn");
    expect(loadConfig({ MORNDO_USAGE_READINGS_GATE: "enforce" }).usageReadingsGate).toBe("enforce");
  });
  it("a misspelling is refused, never read as warn (a typo must not leave the gate open unseen)", () => {
    expect(() => loadConfig({ MORNDO_USAGE_READINGS_GATE: "enforced" })).toThrow(/MORNDO_USAGE_READINGS_GATE/);
    expect(() => loadConfig({ MORNDO_USAGE_READINGS_GATE: "on" })).toThrow(/warn, enforce/);
  });
});

describe("agent-token list", () => {
  const token = { id: "tok-1", name: "lanes", role: "worker" as const, scopes: [] as string[], secretHash: "h", createdAt: 1, lastUsedAt: 2, revokedAt: null, unboundCount: 0, lastUnboundAt: null as number | null };
  it("says nothing extra for a token that never posted a plain reading", () => {
    expect(agentTokenLine(token, when)).not.toMatch(/unbound/);
  });
  it("shows the count and the last time for a token that did", () => {
    const line = agentTokenLine({ ...token, unboundCount: 7, lastUnboundAt: 99 }, when);
    expect(line).toContain("unbound readings 7");
    expect(line).toContain("last t99");
    expect(line).toContain("tok-1");
    expect(line).toContain("active");
  });
});

describe("the migration", () => {
  it("a database at the previous version gets the counters at 0 and keeps its tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-unbound-")); dirs.push(dir);
    const db = new Database(join(dir, "morndo.db"));
    const previous = MIGRATIONS.length - 1;
    migrate(db, MIGRATIONS.slice(0, previous));
    db.prepare("INSERT INTO agent_tokens (id, name, role, secret_hash, scopes, created_at) VALUES ('t1', 'lanes', 'worker', 'h1', '', 1)").run();
    expect(migrate(db)).toEqual({ from: previous, to: MIGRATIONS.length });
    const row = db.prepare("SELECT unbound_count, last_unbound_at FROM agent_tokens WHERE id = 't1'").get() as { unbound_count: number; last_unbound_at: number | null };
    expect(row).toEqual({ unbound_count: 0, last_unbound_at: null });
    db.close();
  });
});
