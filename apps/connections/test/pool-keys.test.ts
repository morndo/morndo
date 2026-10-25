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
import { guardedRelay, watchPoolKeys } from "../src/pool-keys.ts";

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
        id: "gl1", member: "k3", lease: "l1", holder: { node: "n", pid: 1, startedAt: 1, bootId: "b", lane: null },
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
