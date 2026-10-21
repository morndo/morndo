// The executor's shared rules (spec §5.3) with fake ops, so each rule is checked on its own: unknown ops, the policy,
// argument checks, keys, two-phase done keys, per-queue serialization, reads that never wait, and the deadline under a
// wall-clock jump (plan Review Focus 4).
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS, type Delivery, type OpName } from "@morndo/protocol";
import { Flight } from "@morndo/service-kit";
import { ALL_OPS } from "../src/config.ts";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { DoneKeys } from "../src/ops/done-keys.ts";
import { OpExecutor, effect, fail, ok, read, type OpTable } from "../src/ops/executor.ts";
import { dropOnce } from "../src/test-hooks.ts";
import { captureLog, tempHome } from "./helpers.ts";

const W = "pc.0a1b2c3d.4";
const EXPECT = { server: "0a1b2c3d", window: "api" };
const open: { adb: AgentDb; cleanup: () => void }[] = [];
afterEach(() => { vi.useRealTimers(); for (const o of open.splice(0)) { o.adb.close(); o.cleanup(); } });

function executor(ops: OpTable, allowed: readonly OpName[] = ALL_OPS, o: { afterStarted?: (key: string) => boolean; noDoneKeys?: boolean; held?: () => boolean; flight?: Flight } = {}) {
  const h = tempHome();
  const adb = openAgentDb(join(h.home, "agent.db"));
  open.push({ adb, cleanup: h.cleanup });
  const doneKeys = new DoneKeys(adb.db, Date.now, { disabled: o.noDoneKeys === true });
  const ex = new OpExecutor({
    ops, allowed: new Set(allowed), doneKeys, invVersion: () => 42, log: captureLog().log,
    ...(o.afterStarted ? { afterStarted: o.afterStarted } : {}),
    ...(o.held ? { held: o.held } : {}),
    ...(o.flight ? { flight: o.flight } : {}),
  });
  let n = 0;
  const call = (op: string, args: unknown, o: { key?: string; timeoutMs?: number } = {}) =>
    ex.handle({ id: `r${++n}`, op, args, timeoutMs: o.timeoutMs ?? 5000, ...(o.key !== undefined ? { key: o.key } : {}) });
  return { ex, call, doneKeys, adb };
}
const sendArgs = (text = "hello") => ({ workerId: W, text, expect: EXPECT });

describe("the shared rules", () => {
  it("answers unknown_op, denied and bad_args, each not executed, with the current invVersion", async () => {
    const { call } = executor({ "inventory.get": read(async () => ok<"inventory.get">({ panes: [], invVersion: 42 })) }, ["inventory.get"]);
    expect(await call("pane.exec", {})).toEqual({ id: "r1", invVersion: 42, ok: false, error: { code: "unknown_op", executed: "no", message: expect.any(String) } });
    expect(await call("pane.frame", { workerId: W })).toMatchObject({ ok: false, error: { code: "denied", executed: "no" } });
    expect(await call("inventory.get", { extra: 1 })).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    expect(await call("inventory.get", {})).toMatchObject({ ok: true, result: { panes: [] } });
  });
  it("refuses a keyed op without a key, and bad arguments of every kind (a sample)", async () => {
    const { call } = executor({ "pane.send": effect(() => "q", async () => ok<"pane.send">({ problem: null, typedAt: 1 })) });
    expect(await call("pane.send", sendArgs())).toMatchObject({ error: { code: "bad_args", message: "pane.send needs a key" } });
    for (const args of [
      { ...sendArgs(), workerId: "%3" },                               // a legacy pane id is not a worker id
      { ...sendArgs(), workerId: "pc.0a1b2c3d.04" },                    // a leading zero: not the pane's one worker ID
      { ...sendArgs(), text: "x".repeat(LIMITS.maxMessageText + 1) },  // over LIMITS.maxMessageText
      { ...sendArgs(), text: "" },
      { ...sendArgs(), expect: { server: "XYZ", window: "api" } },
      { ...sendArgs(), expect: { server: "0a1b2c3d", window: "a\tb" } },  // a control character in the window name
    ]) {
      expect(await call("pane.send", args, { key: "hub:k" })).toMatchObject({ ok: false, error: { code: "bad_args" } });
    }
    expect(await call("pane.send", sendArgs("ü".repeat(LIMITS.maxMessageText)), { key: "hub:long" })).toMatchObject({ ok: true });   // a whole message, to the new bound
  });
  it("refuses a key on an op that takes none, as the fleet does (plan Contracts)", async () => {
    const { call } = executor({
      "pane.keys": effect(() => "q", async () => ok<"pane.keys">({ ok: true })),
      "inventory.get": read(async () => ok<"inventory.get">({ panes: [], invVersion: 42 })),
    });
    expect(await call("pane.keys", { workerId: W, data: "x", expect: EXPECT }, { key: "hub:k" })).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no", message: "pane.keys takes no key" } });
    expect(await call("inventory.get", {}, { key: "hub:k" })).toMatchObject({ ok: false, error: { code: "bad_args" } });
    expect(await call("pane.keys", { workerId: W, data: "x", expect: EXPECT })).toMatchObject({ ok: true });   // negative control
  });
  it("decodes with OP_ARGS first, as the fleet did: an unknown field is dropped, never passed on", async () => {
    let seen: unknown = null;
    const { call } = executor({ "lane.start": effect(a => `lane:${a.name}`, async a => { seen = a; return ok<"lane.start">({ workerId: W }); }) });
    expect(await call("lane.start", { name: "x", cwd: "/w", flags: "--dangerously-skip-permissions" }, { key: "hub:f" })).toMatchObject({ ok: true });
    expect(seen).toEqual({ name: "x", cwd: "/w" });
    for (const args of [{ name: "x", cwd: "/w", account: "acct_2" }, { name: "x", cwd: "/w", resume: "-r" }, { name: "x", cwd: "w" }]) {
      expect(await call("lane.start", args, { key: "hub:f2" }), JSON.stringify(args)).toMatchObject({ ok: false, error: { code: "bad_args" } });
    }
  });
});

describe("two-phase done keys through the executor", () => {
  it("commits started before the side effect, done after it, and a repeat gets the stored outcome without acting", async () => {
    let acted = 0;
    let seenDuring: unknown = null;
    const x = executor({
      "pane.send": effect(() => "pane:%4", async () => {
        seenDuring = x.doneKeys.status("hub:1");
        acted++;
        return ok<"pane.send">({ problem: null, typedAt: 111 });
      }),
    });
    expect(await x.call("pane.send", sendArgs(), { key: "hub:1" })).toMatchObject({ ok: true, result: { problem: null, typedAt: 111 } });
    expect(seenDuring).toEqual({ state: "started" });
    expect(x.doneKeys.status("hub:1")).toEqual({ state: "done", outcome: { problem: null, typedAt: 111 } });
    expect(await x.call("pane.send", sendArgs(), { key: "hub:1" })).toMatchObject({ ok: true, result: { problem: null, typedAt: 111 } });
    expect(acted).toBe(1);
  });
  it("deletes the key on a refusal with executed: no, so the retry acts", async () => {
    let attempt = 0;
    const x = executor({
      "pane.send": effect(() => "pane:%4", async () => (++attempt === 1 ? fail("draft_present", "a draft") : ok<"pane.send">({ problem: null, typedAt: 2 }))),
    });
    expect(await x.call("pane.send", sendArgs(), { key: "hub:2" })).toMatchObject({ ok: false, error: { code: "draft_present", executed: "no" } });
    expect(x.doneKeys.status("hub:2")).toEqual({ state: "unknown" });
    expect(await x.call("pane.send", sendArgs(), { key: "hub:2" })).toMatchObject({ ok: true });
    expect(attempt).toBe(2);
  });
  it("keeps the key started when the outcome is unknown: a repeat is uncertain and does not act", async () => {
    let acted = 0;
    const x = executor({ "pane.send": effect(() => "pane:%4", async () => { acted++; throw new Error("tmux died mid-paste"); }) });
    expect(await x.call("pane.send", sendArgs(), { key: "hub:3" })).toMatchObject({ ok: false, error: { code: "internal", executed: "maybe" } });
    expect(await x.call("pane.send", sendArgs(), { key: "hub:3" })).toMatchObject({ ok: false, error: { code: "uncertain", executed: "maybe" } });
    expect(acted).toBe(1);
  });
  it("a done-keys store that can't record started (a full disk) answers internal, not executed: nothing ran (final review M6)", async () => {
    let acted = 0;
    const x = executor({ "pane.send": effect(() => "pane:%4", async () => { acted++; return ok<"pane.send">({ problem: null, typedAt: 1 }); }) });
    x.adb.db.pragma("query_only = ON");                                            // every write fails, as on a full disk
    expect(await x.call("pane.send", sendArgs(), { key: "hub:full" })).toMatchObject({ ok: false, error: { code: "internal", executed: "no" } });
    expect(acted).toBe(0);
    x.adb.db.pragma("query_only = OFF");
    expect(await x.call("pane.send", sendArgs(), { key: "hub:full" })).toMatchObject({ ok: true });   // the retry acts, once
    expect(acted).toBe(1);
    // A store that can't even be read: the same, before anything ran.
    const broken = { lookup: () => { throw new Error("disk I/O error"); } } as unknown as DoneKeys;
    const ex = new OpExecutor({ ops: { "pane.send": effect(() => "q", async () => { acted++; return ok<"pane.send">({ problem: null, typedAt: 1 }); }) }, allowed: new Set(ALL_OPS), doneKeys: broken, invVersion: () => 1, log: captureLog().log });
    expect(await ex.handle({ id: "b1", op: "pane.send", args: sendArgs(), timeoutMs: 5000, key: "hub:io" })).toMatchObject({ ok: false, error: { code: "internal", executed: "no" } });
    expect(acted).toBe(1);
  });
  it("answers uncertain (it may have run) for the same key with other effect-determining arguments, and does not act", async () => {
    let acted = 0;
    const x = executor({ "pane.send": effect(() => "pane:%4", async () => { acted++; return ok<"pane.send">({ problem: null, typedAt: 1 }); }) });
    await x.call("pane.send", sendArgs("one"), { key: "hub:4" });
    expect(await x.call("pane.send", sendArgs("two"), { key: "hub:4" })).toMatchObject({ ok: false, error: { code: "uncertain", executed: "maybe", message: expect.stringMatching(/other arguments/) } });
    expect(acted).toBe(1);
  });
  it("a retry with a refreshed expectation is the same request: the stored outcome, nothing acts again", async () => {
    let acted = 0;
    const x = executor({ "pane.send": effect(() => "pane:%4", async () => { acted++; return ok<"pane.send">({ problem: null, typedAt: 9 }); }) });
    expect(await x.call("pane.send", sendArgs("one"), { key: "hub:5" })).toMatchObject({ ok: true, result: { typedAt: 9 } });
    const refreshed = { ...sendArgs("one"), expect: { ...EXPECT, sessionId: "3f0c1d2e-1111-4222-8333-444455556666" } };
    expect(await x.call("pane.send", refreshed, { key: "hub:5", timeoutMs: 9000 })).toMatchObject({ ok: true, result: { typedAt: 9 } });
    expect(acted).toBe(1);
  });
});

describe("the afterStarted hook (the test hook dropAfterStarted)", () => {
  it("runs right after started is committed; the op runs on, its reply says discarded, and the key ends done", async () => {
    let acted = 0;
    const atHook: unknown[] = [];
    const x = executor(
      { "pane.send": effect(() => "pane:%4", async () => { acted++; return ok<"pane.send">({ problem: null, typedAt: 7 }); }) },
      ALL_OPS, { afterStarted: dropOnce("drop", () => { atHook.push(x.doneKeys.status("hub:drop-1"), acted); }) },
    );
    expect(await x.call("pane.send", sendArgs(), { key: "hub:drop-1" })).toMatchObject({ ok: true, discarded: true, result: { typedAt: 7 } });
    expect(atHook).toEqual([{ state: "started" }, 0]);                  // after the commit, before the side effect
    expect(acted).toBe(1);
    expect(x.doneKeys.status("hub:drop-1")).toEqual({ state: "done", outcome: { problem: null, typedAt: 7 } });
    const again = await x.call("pane.send", sendArgs(), { key: "hub:drop-1" });   // once per key: answered, from the stored outcome
    expect(again).toMatchObject({ ok: true, result: { typedAt: 7 } });
    expect(again.discarded).toBeUndefined();
    expect(acted).toBe(1);
    expect((await x.call("pane.send", sendArgs("other"), { key: "hub:keep" })).discarded).toBeUndefined();
  });
  it("with done keys disabled (noDoneKeys) runs at that same point, and a repeat acts again", async () => {
    let acted = 0;
    let drops = 0;
    const x = executor(
      { "pane.send": effect(() => "pane:%4", async () => { acted++; return ok<"pane.send">({ problem: null, typedAt: acted }); }) },
      ALL_OPS, { noDoneKeys: true, afterStarted: dropOnce("drop", () => { drops++; }) },
    );
    expect(await x.call("pane.send", sendArgs(), { key: "hub:drop-2" })).toMatchObject({ ok: true, discarded: true });
    expect(await x.call("pane.send", sendArgs(), { key: "hub:drop-2" })).toMatchObject({ ok: true, result: { typedAt: 2 } });
    expect([acted, drops]).toEqual([2, 1]);
    expect(x.doneKeys.status("hub:drop-2")).toEqual({ state: "unknown" });
  });
});

describe("concurrency", () => {
  it("runs side effects on one queue in arrival order, other queues alongside, and reads without waiting", async () => {
    const log: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const x = executor({
      "pane.keys": effect(a => `pane:${a.workerId}`, async a => {
        log.push(`start ${a.data}`);
        if (a.data === "first") await gate;
        log.push(`end ${a.data}`);
        return ok<"pane.keys">({ ok: true });
      }),
      "pane.frame": read(async () => { log.push("read"); return ok<"pane.frame">({ frame: null }); }),
    });
    const first = x.call("pane.keys", { workerId: W, data: "first", expect: EXPECT });
    const second = x.call("pane.keys", { workerId: W, data: "second", expect: EXPECT });
    const other = x.call("pane.keys", { workerId: "pc.0a1b2c3d.5", data: "other", expect: EXPECT });
    await other;
    await x.call("pane.frame", { workerId: W });
    expect(log).toEqual(["start first", "start other", "end other", "read"]);
    release();
    await Promise.all([first, second]);
    expect(log.slice(4)).toEqual(["end first", "start second", "end second"]);
  });
});

describe("deadlines (spec §5.3) under a wall-clock jump (Review Focus 4)", () => {
  it("measure on the monotonic clock: a jump neither expires a waiting op nor extends one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const acted: string[] = [];
    const x = executor({
      "pane.keys": effect(() => "pane:%4", async (a, ctx) => {
        if (a.data === "blocker") { await new Promise(r => setTimeout(r, 600)); acted.push(a.data); return ok<"pane.keys">({ ok: true }); }
        const late = ctx.ready();
        if (late) return { ok: false, error: late };
        acted.push(a.data ?? "");
        return ok<"pane.keys">({ ok: true });
      }),
    });
    const keys = (data: string, timeoutMs: number) => x.call("pane.keys", { workerId: W, data, expect: EXPECT }, { timeoutMs });
    const blocker = keys("blocker", 5000);
    const inTime = keys("in-time", 1000);                              // deadline at 750 ms
    const tooLate = keys("too-late", 700);                             // deadline at 450 ms
    await vi.advanceTimersByTimeAsync(100);
    vi.setSystemTime(Date.now() + 3_600_000);                          // an hour ahead: must not expire in-time
    await vi.advanceTimersByTimeAsync(100);
    vi.setSystemTime(Date.now() - 7_200_000);                          // two hours back: must not save too-late
    await vi.advanceTimersByTimeAsync(400);                            // 600 ms: the blocker finishes
    expect(await blocker).toMatchObject({ ok: true });
    expect(await inTime).toMatchObject({ ok: true });
    expect(await tooLate).toMatchObject({ ok: false, error: { code: "timeout", executed: "no" } });
    expect(acted).toEqual(["blocker", "in-time"]);
  });
  it("a keyed op that times out before acting releases its key", async () => {
    const x = executor({ "pane.send": effect(() => "pane:%4", async (_a, ctx) => { const late = ctx.ready(); return late ? { ok: false, error: late } : ok<"pane.send">({ problem: null, typedAt: 1 }); }) });
    expect(await x.call("pane.send", sendArgs(), { key: "hub:t", timeoutMs: 100 })).toMatchObject({ ok: false, error: { code: "timeout", executed: "no" } });
    expect(x.doneKeys.status("hub:t")).toEqual({ state: "unknown" });
  });
});

describe("a hold, and a stop that waits for the op in flight", () => {
  it("refuses a new keyed op while held, and does not record it as started", async () => {
    const x = executor({
      "pane.send": effect(() => "q", async () => ok<"pane.send">({ problem: null, typedAt: 1 })),
      "connections.revoke": effect(() => "q", async () => ok<"connections.revoke">({ ok: true })),
      "connections.narrow": effect(() => "q", async () => ok<"connections.narrow">({ ok: true })),
      "lane.stop": effect(() => "q", async () => ok<"lane.stop">({ ok: true })),
      "job.cancel": effect(() => "q", async () => ok<"job.cancel">({ ok: true })),
      "delivery.cancel": effect(a => `delivery:${a.id}`, async () => ok<"delivery.cancel">({ delivery: { id: "hub:q", state: "given_up", why: "cancelled" } as Delivery })),
    }, ALL_OPS, { held: () => true });
    expect(await x.call("pane.send", sendArgs(), { key: "hub:held" })).toMatchObject({ ok: false, error: { code: "updating", executed: "no" } });
    expect(x.doneKeys.status("hub:held")).toEqual({ state: "unknown" });
    expect(await x.call("connections.revoke", { version: 1, name: "work" }, { key: "hub:revoke" })).toMatchObject({ ok: true });
    expect(await x.call("connections.narrow", { version: 1, name: "work", action: "off" }, { key: "hub:narrow" })).toMatchObject({ ok: true });
    expect(await x.call("lane.stop", { name: "gone" }, { key: "hub:stop" })).toMatchObject({ ok: true });
    expect(await x.call("job.cancel", { id: "job-1", token: "lane-token" })).toMatchObject({ ok: true });
    expect(await x.call("delivery.cancel", { id: "hub:q" }), "delivery.cancel while held").toMatchObject({ ok: true });
  });
  it("a stop waits until the keyed op finishes and records done", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const flight = new Flight();
    const x = executor({
      "pane.send": effect(() => "q", async () => { await gate; return ok<"pane.send">({ problem: null, typedAt: 1 }); }),
    }, ALL_OPS, { flight });
    const pending = x.call("pane.send", sendArgs(), { key: "hub:drain" });
    await vi.waitFor(() => expect(flight.list()).toEqual([{ kind: "pane.send", id: "hub:drain" }]));
    expect(x.doneKeys.status("hub:drain")).toEqual({ state: "started" });
    let idle = false;
    const waiting = flight.idle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    release();
    expect(await pending).toMatchObject({ ok: true });
    await waiting;
    expect(x.doneKeys.status("hub:drain").state).toBe("done");
    expect(flight.list()).toEqual([]);
  });
});
