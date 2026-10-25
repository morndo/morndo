// The output filter of a pooled run (ADR-0037, decision 18): the relay never writes a chunk it could not filter, and the watch learns the key of
// every member the run is, or was, handed to. The keys are synthetic. The watch tests use a real home in a temporary directory, no network.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findConnection, isKey, noteLent, openGrant, type Actor, type Grant, type KeyConnection } from "@morndo/domain";
import { openHome, type Opened } from "../src/compose.ts";
import { SqliteKeyPoolStore } from "../src/adapters/key-pool-store-sqlite.ts";
import { streamRedactor } from "../src/adapters/redact.ts";
import { acceptsPoolKey, FilterIncomplete, guardedRelay, watchPoolKeys } from "../src/pool-keys.ts";

const KEY1 = "sk-ant-synthetic-watch-key-0001";
const KEY2 = "sk-ant-synthetic-watch-key-0002";
const KEY3 = "sk-ant-synthetic-watch-key-0003";
const ACTOR: Actor = { kind: "principal", command: "test" };
const catalogPath = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const dirs: string[] = [];
const homes: Opened[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the relay: a chunk is written only once the filter is current", () => {
  const rig = (learn: () => Promise<readonly string[]>, attempts = 3, seed = KEY1) => {
    const out = streamRedactor([seed]);
    const err = streamRedactor([seed]);
    const written: { stream: string; text: string }[] = [];
    const relay = guardedRelay({
      learn,
      add: keys => { out.add(keys); err.add(keys); },
      push: (stream, text) => (stream === "out" ? out : err).push(text),
      write: (stream, text) => { written.push({ stream, text }); },
      attempts, pauseMs: 1,
    });
    return { relay, written, out };
  };
  const joined = (text: string[]) => text.join("");

  it("holds the chunk, retries the failed read, and writes the chunk redacted with the key it learned", async () => {
    let calls = 0;
    const { relay, written, out } = rig(async () => {
      calls += 1;
      if (calls < 3) throw new Error("busy");
      return [KEY3];
    });
    relay.chunk("out", `the key is ${KEY3} ok`);
    await relay.settled();
    expect(calls).toBe(3);
    expect(joined(written.map(w => w.text)) + out.flush()).toBe("the key is [redacted] ok");
    expect(JSON.stringify(written)).not.toContain(KEY3);
  });

  it("when every attempt fails, the chunk is withheld and a marker is written instead: never the chunk as it was", async () => {
    const { relay, written } = rig(async () => { throw new Error("unreadable"); });
    relay.chunk("out", `leak ${KEY3} here`);
    relay.chunk("err", `leak ${KEY3} there`);
    await relay.settled();
    expect(written.map(w => w.stream)).toEqual(["out", "err"]);
    expect(JSON.stringify(written)).not.toContain(KEY3);
    expect(JSON.stringify(written)).not.toContain("leak");
    expect(written[0]?.text).toMatch(/withheld/);
  });

  it("the next chunk tries again, and is written once the read works", async () => {
    let healthy = false;
    const { relay, written, out } = rig(async () => {
      if (!healthy) throw new Error("busy");
      return [KEY3];
    });
    relay.chunk("out", `first ${KEY3}`);
    await relay.settled();
    healthy = true;
    relay.chunk("out", `second ${KEY3}`);
    await relay.settled();
    expect(written).toHaveLength(2);
    expect(written[0]?.text).toMatch(/withheld/);
    expect(joined(written.map(w => w.text)) + out.flush()).not.toContain(KEY3);
    expect(joined(written.map(w => w.text)) + out.flush()).toContain("second [redacted]");
  });

  it("keeps the order of chunks across both streams, and a poll learns a key with no chunk in sight", async () => {
    const seen: string[] = [];
    // No needle at all, so nothing is held back and the text shows the order.
    const { relay, written } = rig(async () => { seen.push("learn"); return []; }, 3, "");
    relay.chunk("out", "a");
    relay.chunk("err", "b");
    relay.chunk("out", "c");
    relay.poll();
    await relay.settled();
    expect(written.map(w => w.text).join("")).toBe("abc");
    expect(seen).toHaveLength(4);
  });

  it("a failed poll is not an error and writes nothing", async () => {
    const { relay, written } = rig(async () => { throw new Error("busy"); });
    relay.poll();
    await relay.settled();
    expect(written).toEqual([]);
  });
});

async function world(): Promise<{ home: Opened; env: NodeJS.ProcessEnv; refs: Record<string, string> }> {
  const dir = mkdtempSync(join(tmpdir(), "morndo-watch-"));
  dirs.push(dir);
  mkdirSync(join(dir, "conn"), { mode: 0o700 });
  mkdirSync(join(dir, "home"), { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { HOME: join(dir, "home"), MORNDO_CONNECTIONS_HOME: join(dir, "conn"), MORNDO_VAULT: "file", MORNDO_CATALOG: catalogPath };
  const home = openHome(env);
  homes.push(home);
  const refs: Record<string, string> = {};
  for (const [name, key] of [["k1", KEY1], ["k2", KEY2], ["k3", KEY3]] as const) {
    refs[name] = `ref-${name}-watch`;
    await home.seal(refs[name], key);
    const added = await home.connections.addKey({ name, vendor: "anthropic", runtime: "claude", ref: refs[name], billing: "metered", budget: { kind: "unlimited" }, expiry: null }, ACTOR);
    expect(added.ok, JSON.stringify(added)).toBe(true);
    expect(home.connections.acknowledge(name, "ada", ACTOR).ok).toBe(true);
  }
  const made = home.keypools.create({ name: "p", vendor: "anthropic", runtime: "claude", members: ["k1", "k2"], by: "ada", confirmOwn: true }, ACTOR);
  expect(made.ok, JSON.stringify(made)).toBe(true);
  return { home, env, refs };
}
const keyConn = (home: Opened, name: string): KeyConnection => {
  const c = findConnection(home.store.load().directory, name);
  if (!c || !isKey(c)) throw new Error(`no key ${name}`);
  return c;
};

describe("fix round 4: the filter is complete only when every key the grant lent the run is loaded", () => {
  const lentGrant = (member: string, lent: string[]): Grant => ({
    id: "gl1", member, lease: "l1", holder: { node: "n", pid: 1, startedAt: 1, bootId: "b", lane: null },
    request: { role: "run", entry: "m", workspacePath: "/w", limit: 8, reserve: 1, margin: 0 }, window: { calls: 1, windowStart: 1 },
    previous: null, seen: [], lent,
  });
  const withGrant = async (lent: string[]) => {
    const w = await world();
    const store = new SqliteKeyPoolStore(w.home.db);
    const loaded = store.load("p");
    const opened = openGrant(loaded.pool!, lentGrant("k1", lent), 1);
    if (!opened.ok) throw new Error("grant");
    expect(store.save(opened.value, loaded.version)).toBe(true);
    store.close();
    return w;
  };
  // A home whose open() fails for the named refs while `failing` holds; everything else is the real home.
  const flaky = (env: NodeJS.ProcessEnv, refs: string[], failing: { on: boolean }) => () => {
    const real = openHome(env);
    return { open: async (ref: string) => { if (failing.on && refs.includes(ref)) throw new Error("transient"); return real.open(ref); }, close: () => real.close() };
  };

  it("one key that fails to open is not skipped: learn says which member (never the key), keeps the others it opened, and the next call loads the rest", async () => {
    const { home, env, refs } = await withGrant(["k1", "k2"]);
    const seen = new Set<string>();
    const failing = { on: true };
    const watch = watchPoolKeys({ db: home.db, pool: "p", grant: "gl1", open: flaky(env, [refs.k2 ?? ""], failing), seen });
    expect(home.keypools.join("p", "k3", { confirmOwn: true }, ACTOR).ok).toBe(true);
    const first = await watch.learn().catch((error: unknown) => error);
    expect(first).toBeInstanceOf(FilterIncomplete);
    expect((first as FilterIncomplete).members).toEqual(["k2"]);
    expect(String((first as FilterIncomplete).message)).not.toContain(KEY2);
    expect(seen.has(refs.k2 ?? "")).toBe(false);
    await expect(watch.learn()).rejects.toBeInstanceOf(FilterIncomplete);
    failing.on = false;
    const done = await watch.learn();
    expect([...done].sort()).toEqual([KEY1, KEY2, KEY3].sort());
    expect(await watch.learn()).toEqual([]);
    watch.close();
  });

  it("a current member the run was never lent that cannot be opened does not hold the output back", async () => {
    const { home, env, refs } = await withGrant(["k1"]);
    const failing = { on: true };
    const watch = watchPoolKeys({ db: home.db, pool: "p", grant: "gl1", open: flaky(env, [refs.k2 ?? ""], failing), seen: new Set() });
    expect(home.keypools.join("p", "k3", { confirmOwn: true }, ACTOR).ok).toBe(true);
    const learned = await watch.learn();
    expect(learned).toContain(KEY1);
    expect(learned).not.toContain(KEY2);
    watch.close();
  });
});

describe("fix round 5: the watch's required set only grows, and a required thing that is gone is a failure", () => {
  it("a lent member it has seen stays required after the pool is deleted: its key is still loaded, or the read throws", async () => {
    const w = await world();
    const store = new SqliteKeyPoolStore(w.home.db);
    const loaded = store.load("p");
    const grant: Grant = {
      id: "gl1", member: "k1", lease: "l1", holder: { node: "n", pid: 1, startedAt: 1, bootId: "b", lane: null },
      request: { role: "run", entry: "m", workspacePath: "/w", limit: 8, reserve: 1, margin: 0 }, window: { calls: 1, windowStart: 1 },
      previous: null, seen: [], lent: ["k1", "k2"],
    };
    const opened = openGrant(loaded.pool!, grant, 1);
    if (!opened.ok) throw new Error("grant");
    expect(store.save(opened.value, loaded.version)).toBe(true);
    store.close();
    let failing = true;
    const seen = new Set<string>();
    const watch = watchPoolKeys({
      db: w.home.db, pool: "p", grant: "gl1",
      open: () => { const real = openHome(w.env); return { open: async (ref: string) => { if (failing && ref === w.refs.k2) throw new Error("transient"); return real.open(ref); }, close: () => real.close() }; },
      seen,
    });
    await expect(watch.learn()).rejects.toBeInstanceOf(FilterIncomplete);
    expect(w.home.keypools.delete("p", ACTOR).ok).toBe(true);
    failing = false;
    const learned = await watch.learn();
    expect(learned).toContain(KEY2);
    watch.close();
  });

  it("a required name with no key Connection (gone or not a key) counts as failed, never as nothing to learn", async () => {
    const w = await world();
    const store = new SqliteKeyPoolStore(w.home.db);
    const loaded = store.load("p");
    const grant: Grant = {
      id: "gl1", member: "k1", lease: "l1", holder: { node: "n", pid: 1, startedAt: 1, bootId: "b", lane: null },
      request: { role: "run", entry: "m", workspacePath: "/w", limit: 8, reserve: 1, margin: 0 }, window: { calls: 1, windowStart: 1 },
      previous: null, seen: [], lent: ["k1", "ghost"],
    };
    const opened = openGrant(loaded.pool!, grant, 1);
    if (!opened.ok) throw new Error("grant");
    expect(store.save(opened.value, loaded.version)).toBe(true);
    store.close();
    const watch = watchPoolKeys({ db: w.home.db, pool: "p", grant: "gl1", open: () => openHome(w.env), seen: new Set([w.refs.k1 ?? ""]) });
    expect(w.home.keypools.join("p", "k3", { confirmOwn: true }, ACTOR).ok).toBe(true);
    const error = await watch.learn().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FilterIncomplete);
    expect((error as FilterIncomplete).members).toEqual(["ghost"]);
    watch.close();
  });
});

describe("fix round 4: the relay marks a withheld stretch once and ends the run instead of writing unfiltered", () => {
  const rig = (learn: () => Promise<readonly string[]>, extra: { giveUpAfterMs?: number; now?: () => number } = {}) => {
    const written: { stream: string; text: string }[] = [];
    const gave: Error[] = [];
    const relay = guardedRelay({
      learn, add: () => undefined, push: (_stream, text) => text, write: (stream, text) => { written.push({ stream, text }); },
      attempts: 1, pauseMs: 1, giveUpAfterMs: extra.giveUpAfterMs ?? 1000, now: extra.now ?? (() => 0), onGiveUp: error => { gave.push(error); },
    });
    return { relay, written, gave };
  };

  it("one marker for a whole stretch of withheld chunks, a new one for the next stretch", async () => {
    let healthy = false;
    const { relay, written } = rig(async () => { if (!healthy) throw new Error("busy"); return []; });
    for (const text of ["a", "b", "c"]) relay.chunk("out", text);
    await relay.settled();
    expect(written).toHaveLength(1);
    expect(written[0]?.text).toMatch(/withheld/);
    healthy = true;
    relay.chunk("out", "d");
    await relay.settled();
    expect(written.map(w => w.text).slice(1)).toEqual(["d"]);
    healthy = false;
    relay.chunk("out", "e");
    await relay.settled();
    expect(written.filter(w => /withheld/.test(w.text))).toHaveLength(2);
  });

  it("after the bounded time it gives up once, naming the member from the error, writes nothing more and drops what follows", async () => {
    let clock = 0;
    const { relay, written, gave } = rig(async () => { throw new FilterIncomplete(["k3"]); }, { now: () => clock });
    relay.chunk("out", "a");
    await relay.settled();
    clock = 500;
    relay.chunk("out", "b");
    await relay.settled();
    expect(written).toHaveLength(1);
    expect(gave).toHaveLength(0);
    clock = 1500;
    relay.chunk("out", `c ${KEY3}`);
    relay.chunk("err", `d ${KEY3}`);
    await relay.settled();
    expect(gave).toHaveLength(1);
    expect(gave[0]).toBeInstanceOf(FilterIncomplete);
    expect(written).toHaveLength(1);
    expect(JSON.stringify(written)).not.toContain(KEY3);
  });

  it("a poll that works clears the clock too, so a fresh blip is not an old stretch", async () => {
    let clock = 0;
    let healthy = false;
    const { relay, gave } = rig(async () => { if (!healthy) throw new Error("busy"); return []; }, { now: () => clock });
    relay.chunk("out", "a");
    await relay.settled();
    healthy = true;
    clock = 900;
    relay.poll();
    await relay.settled();
    healthy = false;
    clock = 1800;
    relay.chunk("out", "b");
    await relay.settled();
    expect(gave).toHaveLength(0);
  });

  it("a read that works clears the clock: a stretch that ends in time is not a give-up", async () => {
    let clock = 0;
    let healthy = false;
    const { relay, gave } = rig(async () => { if (!healthy) throw new Error("busy"); return []; }, { now: () => clock });
    relay.chunk("out", "a");
    await relay.settled();
    healthy = true;
    clock = 900;
    relay.chunk("out", "b");
    await relay.settled();
    healthy = false;
    clock = 1800;
    relay.chunk("out", "c");
    await relay.settled();
    expect(gave).toHaveLength(0);
  });
});

describe("the watch: every key the run may be, or was, handed", () => {
  it("a read that fails does not count as seen: the next read still learns the member that joined", async () => {
    const { home, env, refs } = await world();
    const seen = new Set([refs.k1 ?? "", refs.k2 ?? ""]);
    let fail = true;
    const watch = watchPoolKeys({ db: home.db, pool: "p", grant: "gnone", open: () => { if (fail) { fail = false; throw new Error("busy"); } return openHome(env); }, seen });
    expect(home.keypools.join("p", "k3", { confirmOwn: true }, ACTOR).ok).toBe(true);
    await expect(watch.learn()).rejects.toThrow("busy");
    expect(seen.has(refs.k3 ?? "")).toBe(false);
    expect(await watch.learn()).toEqual([KEY3]);
    expect(await watch.learn()).toEqual([]);
    watch.close();
  });

  it("a member handed to and gone from the pool since (left, or revoked) is learned from the grant's history", async () => {
    for (const how of ["leave", "revoke"] as const) {
      const { home, env, refs } = await world();
      expect(home.keypools.join("p", "k3", { confirmOwn: true }, ACTOR).ok).toBe(true);
      const store = new SqliteKeyPoolStore(home.db);
      const loaded = store.load("p");
      const grant: Grant = {
        id: "gl1", member: "k1", lease: "l1", holder: { node: "n", pid: 1, startedAt: 1, bootId: "b", lane: null },
        request: { role: "run", entry: "m", workspacePath: "/w", limit: 8, reserve: 1, margin: 0 }, window: { calls: 1, windowStart: 1 },
        previous: null, seen: [], lent: [],
      };
      const opened = openGrant(loaded.pool!, grant, 1);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(store.save(noteLent(opened.value, "gl1", "k3"), loaded.version)).toBe(true);
      store.close();
      const watch = watchPoolKeys({ db: home.db, pool: "p", grant: "gl1", open: () => openHome(env), seen: new Set([refs.k1 ?? "", refs.k2 ?? ""]) });
      // The signature is taken when the watch is made; the member goes after.
      if (how === "leave") expect(home.keypools.leave("p", "k3", ACTOR).ok).toBe(true);
      else expect(home.connections.revoke("k3", ACTOR).ok).toBe(true);
      expect(keyConn(home, "k3").ref).toBe(refs.k3);
      expect(await watch.learn(), how).toEqual([KEY3]);
      watch.close();
      home.close();
      homes.splice(homes.indexOf(home), 1);
    }
  });

  it("a member that never was lent to the run and is not in the pool is not opened", async () => {
    const { home, env, refs } = await world();
    const watch = watchPoolKeys({ db: home.db, pool: "p", grant: "gnone", open: () => openHome(env), seen: new Set([refs.k1 ?? "", refs.k2 ?? ""]) });
    expect(home.connections.turnOff("k3").ok).toBe(true);
    expect(await watch.learn()).toEqual([]);
    watch.close();
  });
});

describe("fix round 6: the run's filter takes a key only if it is a key of the pool the run is on", () => {
  const withGrant = async (lent: string[]) => {
    const w = await world();
    const store = new SqliteKeyPoolStore(w.home.db);
    const loaded = store.load("p");
    const grant: Grant = {
      id: "gl1", member: "k1", lease: "l1", holder: { node: "n", pid: 1, startedAt: 1, bootId: "b", lane: null },
      request: { role: "run", entry: "m", workspacePath: "/w", limit: 8, reserve: 1, margin: 0 }, window: { calls: 1, windowStart: 1 },
      previous: null, seen: [], lent, filter: null,
    };
    const opened = openGrant(loaded.pool!, grant, 1);
    if (!opened.ok) throw new Error("grant");
    expect(store.save(opened.value, loaded.version)).toBe(true);
    store.close();
    return w;
  };
  const accepter = (w: { home: Opened; env: NodeJS.ProcessEnv }) => acceptsPoolKey({ db: w.home.db, pool: "p", grant: "gl1", open: () => openHome(w.env) });
  const said = async (accepts: (key: string) => Promise<boolean>, key: string): Promise<boolean> => accepts(key).catch(() => false);

  it("accepts the key of a member of the pool, and refuses a key that is nobody's and the key of a Connection that is not in the pool", async () => {
    const w = await withGrant(["k1"]);
    const acc = accepter(w);
    expect(await said(acc.accepts, KEY1)).toBe(true);
    expect(await said(acc.accepts, KEY2)).toBe(true);
    expect(await said(acc.accepts, KEY3)).toBe(false);
    expect(await said(acc.accepts, "sk-ant-synthetic-junk-key-9999")).toBe(false);
    acc.close();
  });
  it("sees the pool as it is now: a member that joins is accepted from then on", async () => {
    const w = await withGrant(["k1"]);
    const acc = accepter(w);
    expect(await said(acc.accepts, KEY3)).toBe(false);
    expect(w.home.keypools.join("p", "k3", { confirmOwn: true }, ACTOR).ok).toBe(true);
    expect(await said(acc.accepts, KEY3)).toBe(true);
    acc.close();
  });
  it("a rotated member's new key is accepted and its old key, which no store holds any more, is not", async () => {
    const w = await withGrant(["k1"]);
    const NEW = "sk-ant-synthetic-watch-key-0007";
    const fresh = `ref-k2-rotated`;
    await w.home.seal(fresh, NEW);
    expect((await w.home.connections.rotate("k2", fresh, ACTOR)).ok).toBe(true);
    const acc = accepter(w);
    expect(await said(acc.accepts, NEW)).toBe(true);
    expect(await said(acc.accepts, KEY2)).toBe(false);
    acc.close();
  });
  it("a member the run was lent still counts after it left the pool", async () => {
    const w = await withGrant(["k1", "k2"]);
    expect(w.home.keypools.leave("p", "k2", ACTOR).ok).toBe(true);
    const acc = accepter(w);
    expect(await said(acc.accepts, KEY2)).toBe(true);
    acc.close();
  });
  it("a store it cannot read, or a grant that is gone, accepts nothing", async () => {
    const w = await withGrant(["k1"]);
    const broken = acceptsPoolKey({ db: w.home.db, pool: "p", grant: "gl1", open: () => ({ open: async () => { throw new Error("transient"); }, close: () => undefined }) });
    expect(await said(broken.accepts, KEY1)).toBe(false);
    broken.close();
    const gone = acceptsPoolKey({ db: w.home.db, pool: "p", grant: "no-such-grant", open: () => openHome(w.env) });
    expect(await said(gone.accepts, KEY1)).toBe(false);
    gone.close();
  });
});
