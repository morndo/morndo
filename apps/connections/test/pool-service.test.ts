// The account pool's store and service (ADR-0029): one versioned row per runtime, one writer per session across two services on
// one database, the Connection gate, a usage limit in each mode, waiting work for the reset advice, no email kept, and a read's
// hold. Temporary homes, the file vault, a fixed clock and a fake process table; no sign-in is used.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { emptyPool, type Actor, type Holder, type Reading } from "@morndo/domain";
import { openHome, type Opened } from "../src/compose.ts";
import { SqlitePoolStore } from "../src/adapters/pool-store-sqlite.ts";
import { PoolService } from "../src/application/pool-service.ts";

const catalog = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const who: Actor = { kind: "principal", command: "c1" };
const NONE = { keep: false, expires: null, onlyFor: [] as string[] };
const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 15, 12);
const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const holder = (pid: number): Holder => ({ node: "node-a", pid, startedAt: pid * 10, bootId: "boot-1", lane: null });

function reading(member: string, over: Partial<Reading> & { short?: number; long?: number } = {}): Reading {
  const { short = 20, long = 30, ...rest } = over;
  return {
    member, at: T0 - 60_000, signedIn: true, identity: `id-${member}`, plan: "plus", paid: true, allowed: true, credits: { available: 0, expiresAt: null },
    windows: [{ usedPercent: short, minutes: 300, resetsAt: T0 + 2 * H }, { usedPercent: long, minutes: 10_080, resetsAt: T0 + 72 * H }],
    ...rest,
  };
}

type World = { home: Opened; clock: { t: number }; service(): PoolService; add(name: string, opts?: { ack?: boolean; configDir?: string | null }): void };

// A home with Connections `codex-a` and `codex-b` (signed in to homes of their own, terms acknowledged), as the CLI would make them.
function world(): World {
  const dir = mkdtempSync(join(tmpdir(), "morndo-pool-service-"));
  dirs.push(dir);
  const home = openHome({ ...process.env, MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: catalog });
  closers.push(() => home.close());
  const clock = { t: T0 };
  const service = (): PoolService => {
    const store = new SqlitePoolStore(home.db);
    closers.push(() => store.close());
    return new PoolService({ clock: { now: () => clock.t }, store, connections: home.store, catalog: home.catalog, processes: { identity: () => null, ancestors: () => [], alive: () => true } });
  };
  const add = (name: string, opts: { ack?: boolean; configDir?: string | null } = {}): void => {
    const configDir = opts.configDir === undefined ? join(dir, "accounts", name) : opts.configDir;
    expect(home.connections.addSubscription({ name, vendor: "codex", runtime: "codex", configDir }, who).ok).toBe(true);
    if (opts.ack !== false) expect(home.connections.acknowledge(name, "test", who).ok).toBe(true);
  };
  return { home, clock, service, add };
}

// Two members, read, in the given mode.
function pooled(mode: "pinned" | "rotate" = "pinned", readings: Reading[] = [reading("codex-a"), reading("codex-b")]): World & { pool: PoolService } {
  const w = world();
  const pool = w.service();
  for (const r of readings) {
    w.add(r.member);
    expect(pool.add("codex", r.member, NONE).ok).toBe(true);
    pool.record("codex", r);
  }
  if (mode === "rotate") expect(pool.setMode("codex", "rotate", "principal@example.com").ok).toBe(true);
  return { ...w, pool };
}

const start = (over: Partial<Parameters<PoolService["begin"]>[0]> = {}): Parameters<PoolService["begin"]>[0] => ({
  runtime: "codex", claimId: "c1", session: null, pin: null, dir: "/work/repo", night: false, model: null, holder: holder(101), ...over,
});

describe("pool service: the store", () => {
  it("keeps one row per runtime and saves only on the version it read", () => {
    const w = world();
    const store = new SqlitePoolStore(w.home.db);
    closers.push(() => store.close());
    const first = store.load("codex");
    expect(first.version).toBe(0);
    expect(store.save(first.pool, 0)).toBe(true);
    const stale = { ...first.pool, settings: { ...first.pool.settings, defaultMember: "codex-b" } };
    expect(store.save(emptyPool("codex"), 0)).toBe(false);
    expect(store.save(stale, 1)).toBe(true);
    expect(store.save(first.pool, 1)).toBe(false);
    const again = store.load("codex");
    expect(again.version).toBe(2);
    expect(again.pool.settings.defaultMember).toBe("codex-b");
    const raw = new Database(w.home.db, { readonly: true });
    closers.push(() => raw.close());
    expect(raw.prepare("SELECT COUNT(*) FROM pool WHERE runtime = 'codex'").pluck().get()).toBe(1);
  });
});

describe("pool service: one writer per session, one turn per account", () => {
  it("lets only one of two services claim one session", () => {
    const w = pooled();
    const one = w.service();
    const two = w.service();
    const a = one.begin(start({ claimId: "c1", session: "s1", pin: "codex-a", holder: holder(101) }));
    const b = two.begin(start({ claimId: "c2", session: "s1", pin: "codex-a", holder: holder(202) }));
    expect(a).toMatchObject({ ok: true, value: { member: "codex-a" } });
    expect(b).toEqual({ ok: false, error: { problem: "session-busy", exit: 1, holder: holder(101) } });
  });

  it("holds an account for a read without placing anything, and refuses while a turn runs", () => {
    const w = pooled();
    w.pool.retire("codex", "codex-a", "out for the test");
    expect(w.pool.hold("codex", "codex-a", "r1", holder(301)).ok).toBe(true);
    expect(w.pool.hold("codex", "codex-a", "r2", holder(302))).toEqual({ ok: false, error: { problem: "codex-a is busy", exit: 1 } });
    w.pool.release("codex", "r1");
    expect(w.pool.hold("codex", "codex-a", "r3", holder(303)).ok).toBe(true);
    w.pool.release("codex", "r3");
    expect(w.pool.begin(start({ claimId: "t1", session: "s9", pin: "codex-b" })).ok).toBe(true);
    expect(w.pool.hold("codex", "codex-b", "r4", holder(304))).toEqual({ ok: false, error: { problem: "codex-b is busy", exit: 1 } });
    expect(w.pool.list("codex").placements.map(x => x.session)).toEqual(["s9"]);
  });
});

describe("pool service: the Connection gate", () => {
  it("refuses a member whose Connection is off, unacknowledged, or not a subscription of the runtime", () => {
    const w = world();
    const pool = w.service();
    w.add("codex-a", { ack: false });
    expect(pool.add("codex", "codex-a", NONE).ok).toBe(true);
    pool.record("codex", reading("codex-a"));
    expect(pool.begin(start({ pin: "codex-a" }))).toEqual({ ok: false, error: { problem: "member codex-a has no terms acknowledgement", exit: 75 } });
    expect(w.home.connections.acknowledge("codex-a", "test", who).ok).toBe(true);
    expect(pool.begin(start({ pin: "codex-a" })).ok).toBe(true);
    pool.release("codex", "c1");
    expect(w.home.connections.turnOff("codex-a").ok).toBe(true);
    expect(pool.begin(start({ claimId: "c2", pin: "codex-a" }))).toEqual({ ok: false, error: { problem: "member codex-a is off", exit: 75 } });

    expect(w.home.connections.addSubscription({ name: "no-home", vendor: "codex", runtime: "codex", configDir: null }, who).ok).toBe(true);
    expect(pool.add("codex", "no-home", NONE)).toEqual({ ok: false, error: { problem: "a pool member needs its own --config-dir", exit: 1 } });
    expect(pool.add("codex", "missing-one", NONE)).toEqual({ ok: false, error: { problem: "no such connection: missing-one", exit: 1 } });
  });

  it("refuses a key as a member", async () => {
    const w = world();
    await w.home.seal("ref-key", "sk-synthetic-pool-0001");
    const added = await w.home.connections.addKey({ name: "key-a", vendor: "openai", runtime: "codex", ref: "ref-key", billing: "metered", budget: { kind: "unlimited" }, expiry: null }, who);
    expect(added.ok).toBe(true);
    expect(w.service().add("codex", "key-a", NONE)).toEqual({ ok: false, error: { problem: "a pool member is a subscription of its runtime", exit: 1 } });
  });
});

describe("pool service: a turn that ends on a usage limit", () => {
  it("marks the member and answers the next seat in rotate mode only", () => {
    const rotate = pooled("rotate");
    const first = rotate.pool.begin(start({ claimId: "c1", session: "s1" }));
    expect(first).toMatchObject({ ok: true, value: { member: "codex-a", continueBy: null } });
    const out = rotate.pool.end("codex", "c1", { kind: "usage-limit", resetAt: T0 + 3 * H, model: null });
    expect(out.refusal).toBeNull();
    expect(out.next).toMatchObject({ member: "codex-b", claimId: "c1>codex-b", continueBy: "resume" });
    expect(rotate.pool.list("codex").seats.find(s => s.member === "codex-a")).toMatchObject({ state: "out", backAt: T0 + 3 * H });
    expect(rotate.pool.list("codex").placements).toMatchObject([{ session: "s1", member: "codex-b" }]);

    const pinned = pooled("pinned");
    expect(pinned.pool.begin(start({ claimId: "c1", session: "s1", pin: "codex-a" })).ok).toBe(true);
    const stuck = pinned.pool.end("codex", "c1", { kind: "usage-limit", resetAt: T0 + 3 * H, model: null });
    expect(stuck.next).toBeNull();
    expect(stuck.refusal).toMatchObject({ problem: "member codex-a is out", exit: 1, backAt: T0 + 3 * H });
  });

  it("goes on with the same member as a handoff when a conversation can't be read, in either mode", () => {
    const w = pooled("pinned");
    expect(w.pool.begin(start({ claimId: "c1", session: "s1", pin: "codex-a" })).ok).toBe(true);
    const out = w.pool.end("codex", "c1", { kind: "unreadable" });
    expect(out.next).toMatchObject({ member: "codex-a", continueBy: "handoff", claimId: "c1>retry" });
    expect(w.pool.list("codex").settings.moveBy).toBe("handoff");
  });
});

describe("pool service: waiting work and the reset advice", () => {
  it("counts sessions refused for want of a seat as waiting", () => {
    const credits = { available: 1, expiresAt: null };
    const w = pooled("rotate", [
      reading("codex-a", { long: 99, credits, windows: [{ usedPercent: 20, minutes: 300, resetsAt: T0 + 2 * H }, { usedPercent: 99, minutes: 10_080, resetsAt: T0 + 120 * H }] }),
      reading("codex-b", { long: 99, credits, windows: [{ usedPercent: 20, minutes: 300, resetsAt: T0 + 2 * H }, { usedPercent: 99, minutes: 10_080, resetsAt: T0 + 30 * H }] }),
    ]);
    expect(w.pool.advice("codex")).toBeNull();
    expect(w.pool.begin(start({ claimId: "c1", session: "s1" })).ok).toBe(false);
    expect(w.pool.begin(start({ claimId: "c2", session: "s2" })).ok).toBe(false);
    expect(w.pool.advice("codex")).toMatchObject({ member: "codex-a", reason: "all-blocked", backAt: T0 + 30 * H });
    w.clock.t = T0 + 2 * H;
    expect(w.pool.advice("codex")?.reason).not.toBe("all-blocked");
  });
});

describe("pool service: no email is kept", () => {
  it("records a reading and shows the member's windows without any address in the pool's row", () => {
    const w = pooled("pinned", [reading("codex-a", { identity: "9f2c4e6a1b3d", plan: "plus" })]);
    const listed = w.pool.list("codex");
    expect(listed.seats[0]).toMatchObject({ member: "codex-a", state: "ok", shortLeft: 80, longLeft: 70 });
    const raw = new Database(w.home.db, { readonly: true });
    closers.push(() => raw.close());
    const body = raw.prepare("SELECT body FROM pool WHERE runtime = 'codex'").pluck().get() as string;
    expect(body).not.toContain("@");
    expect(readFileSync(w.home.db).includes("someone@example.com")).toBe(false);
  });
});
