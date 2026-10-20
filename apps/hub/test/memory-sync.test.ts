// Memory's skills to every node (ADR-0031, docs/design/memory/README.md "Sync"), against a fake fleet client: sent only
// when the version changes, when a node comes back online and every 30 minutes; every part in order, each with its key
// `hub:memory:<version>:<part>`; recorded as the node's only once every part was taken and the version committed; a
// node that refuses the op left alone for an hour; an offline node skipped; and a round that fails never throws.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ERROR_EXECUTED, type ErrorCode, type OpArgs, type OpResult } from "@morndo/protocol";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import { MemoryService } from "../src/application/memory-service.ts";
import { DENIED_RETRY_MS, MemorySync, RESEND_MS, type MemoryFleet } from "../src/application/memory-sync.ts";

type Call = { node: string; args: OpArgs["memory.sync"]; key: string };
type Answer = { ok: true; result: OpResult["memory.sync"] } | { ok: false; error: { code: ErrorCode; executed: "no" | "maybe"; message: string } };
const refused = (code: ErrorCode): Answer => ({ ok: false, error: { code, executed: ERROR_EXECUTED[code], message: code } });
// What a node answers by default: each part staged, the last one committing the version.
const committing = (c: Call): Answer => ({ ok: true, result: { committed: c.args.part === c.args.parts - 1, written: c.args.files.length, removed: 0, skillDirs: [], conflicts: [] } });

let dir: string;
let store: MemoryStore;
let memory: MemoryService;
let now: number;
let status: Map<string, "online" | "stale" | "offline">;
let calls: Call[];
let answer: (c: Call) => Answer | Promise<Answer>;
let warnings: string[];
let sync: MemorySync;
const MINUTE = 60_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-memory-sync-"));
  store = new MemoryStore(dir);
  now = Date.UTC(2026, 9, 20, 12);
  memory = new MemoryService({ store, now: () => now });
  status = new Map([["pc", "online"], ["laptop", "online"]]);
  calls = [];
  answer = committing;
  warnings = [];
  const fleet: MemoryFleet = {
    nodes: async () => [...status].map(([name, s]) => ({ name, status: s })),
    op: async (target, _op, args, opts) => {
      const c = { node: target.node, args, key: opts.key };
      calls.push(c);
      return answer(c);
    },
  };
  sync = new MemorySync({ service: memory, store, fleet, now: () => now, log: { info: () => {}, warn: m => warnings.push(m), error: m => warnings.push(m) } });
  memory.remember({ kind: "worker", name: "api-fix", token: "tok" }, { kind: "fact", scope: "repo:shop-api", title: "Ports", body: "The api listens on 8080." });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const to = (node: string) => calls.filter(c => c.node === node);
const tick = async (advance = MINUTE) => { now += advance; calls = []; await sync.tick(); };

describe("sending", () => {
  it("sends the bundle to every online node once, and again only when the version changes", async () => {
    await tick(0);
    const v = memory.bundle().version;
    expect(to("pc").map(c => c.key)).toEqual([`hub:memory:${v}:0`]);
    expect(to("laptop").map(c => c.key)).toEqual([`hub:memory:${v}:0`]);
    expect(to("pc")[0]?.args).toMatchObject({ version: v, part: 0, parts: 1 });
    expect(store.lastSynced("pc")).toEqual({ version: v, at: now });
    await tick();
    expect(calls).toEqual([]);                                             // nothing changed
    memory.remember("console", { kind: "fact", scope: "repo:shop-api", title: "Deploys", body: "Fridays never." });
    await tick();
    const v2 = memory.bundle().version;
    expect(v2).not.toBe(v);
    expect(calls.map(c => c.key).sort()).toEqual([`hub:memory:${v2}:0`, `hub:memory:${v2}:0`]);
  });

  it("sends every part in order with its key, and records the version only once every part was taken", async () => {
    for (let i = 0; i < 30; i++) {
      memory.remember("console", { kind: "procedure", scope: "repo:shop-api", title: `Runbook ${i}`, body: `${"Step. ".repeat(3000)}${i}` });
    }
    const bundle = memory.bundle();
    expect(bundle.parts.length).toBeGreaterThan(1);
    status.delete("laptop");
    // The last part fails: nothing is recorded, and the next round sends every part again.
    answer = c => (c.args.part === bundle.parts.length - 1 ? refused("timeout") : committing(c));
    await tick(0);
    expect(to("pc").map(c => c.args.part)).toEqual(bundle.parts.map((_, i) => i));
    expect(store.lastSynced("pc")).toBeNull();
    answer = committing;
    await tick();
    expect(to("pc").map(c => c.key)).toEqual(bundle.parts.map((_, i) => `hub:memory:${bundle.version}:${i}`));
    expect(to("pc").every(c => c.args.parts === bundle.parts.length && c.args.version === bundle.version)).toBe(true);
    expect(to("pc").flatMap(c => c.args.files)).toEqual(bundle.parts.flat());
    expect(store.lastSynced("pc")?.version).toBe(bundle.version);
  });

  it("a part refused in the middle stops the rest; a node that took every part but committed none is not recorded", async () => {
    for (let i = 0; i < 30; i++) memory.remember("console", { kind: "procedure", scope: "org", title: `Guide ${i}`, body: `${"Line. ".repeat(3000)}${i}` });
    status.delete("laptop");
    answer = c => (c.args.part === 0 ? refused("busy") : committing(c));
    await tick(0);
    expect(to("pc").map(c => c.args.part)).toEqual([0]);
    answer = () => ({ ok: true, result: { committed: false, written: 0, removed: 0, skillDirs: [], conflicts: [] } });
    await tick();
    expect(to("pc").length).toBe(memory.bundle().parts.length);
    expect(store.lastSynced("pc")).toBeNull();
    expect(warnings.some(w => /committed none/.test(w))).toBe(true);
  });

  it("sends to every node again every 30 minutes", async () => {
    await tick(0);
    await tick(RESEND_MS - MINUTE);
    expect(calls).toEqual([]);
    await tick(MINUTE);
    expect(calls.map(c => c.node).sort()).toEqual(["laptop", "pc"]);
  });
});

describe("nodes that can't take it", () => {
  it("skips an offline or stale node, and sends again when it comes back online", async () => {
    status.set("laptop", "offline");
    await tick(0);
    expect(to("laptop")).toEqual([]);
    expect(to("pc")).toHaveLength(1);
    status.set("laptop", "stale");
    await tick();
    expect(to("laptop")).toEqual([]);
    status.set("laptop", "online");
    await tick();
    expect(to("laptop")).toHaveLength(1);
    expect(to("pc")).toEqual([]);
    // pc drops out and comes back with the version it already has: it is sent again all the same.
    status.set("pc", "offline");
    await tick();
    status.set("pc", "online");
    await tick();
    expect(to("pc")).toHaveLength(1);
  });

  it("leaves a node that denies the op alone for an hour, then asks again", async () => {
    answer = c => (c.node === "laptop" ? refused("denied") : committing(c));
    await tick(0);
    expect(to("laptop")).toHaveLength(1);
    memory.remember("console", { kind: "fact", scope: "org", title: "New", body: "A change to send." });
    await tick();
    expect(to("laptop")).toEqual([]);                                    // denied: not asked again yet
    expect(to("pc")).toHaveLength(1);
    await tick(DENIED_RETRY_MS - 2 * MINUTE);
    expect(to("laptop")).toEqual([]);
    answer = committing;
    await tick(2 * MINUTE);
    expect(to("laptop")).toHaveLength(1);
    expect(store.lastSynced("laptop")?.version).toBe(memory.bundle().version);
  });

  it("the console's push sends now, to a node that denied and one that is current", async () => {
    answer = c => (c.node === "laptop" ? refused("denied") : committing(c));
    await tick(0);
    answer = committing;
    calls = [];
    const pushed = await sync.push({ force: true });
    expect(pushed.version).toBe(memory.bundle().version);
    expect([...pushed.outcomes].sort(([a], [b]) => a.localeCompare(b))).toEqual([["laptop", "synced"], ["pc", "synced"]]);
    expect(calls.map(c => c.node).sort()).toEqual(["laptop", "pc"]);
  });
});

describe("a round that fails", () => {
  it("never throws: an unreachable fleet, an op that throws, a store that fails are logged", async () => {
    const down: MemoryFleet = { nodes: async () => { throw new Error("no socket"); }, op: async () => refused("internal") };
    const quiet = new MemorySync({ service: memory, store, fleet: down, now: () => now, log: { info: () => {}, warn: m => warnings.push(m), error: m => warnings.push(m) } });
    await expect(quiet.tick()).resolves.toBeUndefined();
    answer = () => { throw new Error("socket closed"); };
    await expect(sync.tick()).resolves.toBeUndefined();
    expect(store.lastSynced("pc")).toBeNull();
    expect(warnings.filter(w => /a sync round failed|didn't answer/.test(w)).length).toBeGreaterThanOrEqual(3);
    answer = committing;
    await tick();
    expect(store.lastSynced("pc")).not.toBeNull();
  });

  it("does not start a round while one is still running", async () => {
    let release: () => void = () => {};
    answer = c => new Promise<Answer>(resolve => { release = () => resolve(committing(c)); });
    status.delete("laptop");
    const first = sync.tick();
    await new Promise(r => setTimeout(r, 10));
    await sync.tick();                                                   // returns at once: the first is still out
    expect(calls).toHaveLength(1);
    release();
    await first;
    expect(store.lastSynced("pc")).not.toBeNull();
  });
});
