// The worker socket's policy on its own (T-440): pure, so a closed-by-default rule and the redaction of a protected
// lane's words can be pinned without a fleet.
import { OP_NAMES, type OpName, type Pane } from "@morndo/protocol";
import { describe, expect, it } from "vitest";
import {
  redactAlert, redactDelivery, redactEvent, redactPanes, visibleLaneEvents, visibleLaneWatch, visibleRuns, workerOpVerdict,
  type Hide, type WorkerLook, type WorkerScope,
} from "../src/application/worker-scope.ts";

const scope: WorkerScope = { protectedLanes: new Set(["manager"]), startNodes: new Set(["pc"]) };
const names = new Map([["pc.3fa2c1d0.0", "pc-lane"], ["ctl.3fa2c1d0.0", "manager"], ["ctl.3fa2c1d0.1", "worker-a"], ["pc.3fa2c1d0.5", "renamed"]]);
const lanes = new Map([["pc-lane", "pc.3fa2c1d0.0"], ["manager", "ctl.3fa2c1d0.0"], ["worker-a", "ctl.3fa2c1d0.1"], ["renamed", "pc.3fa2c1d0.5"]]);
const SID = "11111111-1111-4111-8111-111111111111";
const look: WorkerLook = {
  nameOfWorker: id => names.get(id) ?? null,
  nodeOfLane: name => (lanes.has(name) ? (lanes.get(name) ?? "").split(".")[0] ?? null : null),
  workerOfLane: name => lanes.get(name) ?? null,
  isProtectedWorker: id => names.get(id) === "manager" || id === "pc.3fa2c1d0.5",           // 5: a protected pane that was renamed
  isProtectedPath: (node, path) => node === "pc" && path.startsWith("/work/m/"),
};
const hide: Hide = { lane: n => n === "manager", worker: id => id === "ctl.3fa2c1d0.0", session: s => s === SID };
const pane = (workerId: string, window: string, extra: Partial<Pane> = {}): Pane => ({ workerId, window, cwd: "/work", status: "idle", pid: 100, ...extra });

describe("worker socket policy", () => {
  it("an op the policy does not list is refused, whatever its target and arguments", () => {
    const v = workerOpVerdict(scope, { target: { node: "pc" }, op: "future.op" as OpName, args: {} }, look);
    expect(v).toMatchObject({ ok: false, reason: expect.stringContaining("worker socket") });
  });

  it("the ops closed to the worker socket are refused on a startNode too", () => {
    const closed: OpName[] = ["job.notice", "job.noticeResult", "memory.sync", "connections.priority", "connections.role", "connections.revoke", "connections.narrow", "update.apply", "lane.deliver", "delivery.cancel",
      "transcript.size", "transcript.read", "transcript.locate"];
    for (const op of closed) expect(workerOpVerdict(scope, { target: { node: "pc" }, op, args: {} }, look), op).toMatchObject({ ok: false });
  });

  it("every op the protocol has is decided: either allowed with a node or lane that fits, or refused", () => {
    for (const op of OP_NAMES) {
      const v = workerOpVerdict(scope, { target: { node: "ctl" }, op, args: {} }, look);
      expect(typeof v.ok, op).toBe("boolean");
    }
  });

  it("a protected pane that was renamed is refused by its worker ID and by its lane, for reads and writes", () => {
    for (const target of [{ workerId: "pc.3fa2c1d0.5" }, { lane: "renamed" }]) {
      for (const op of ["pane.keys", "pane.send", "pane.capture", "pane.frame"] as OpName[]) {
        expect(workerOpVerdict(scope, { target, op, args: op === "pane.capture" ? { lines: 5 } : {} }, look), `${op} ${JSON.stringify(target)}`).toMatchObject({ ok: false });
      }
    }
    const many = workerOpVerdict(scope, { target: { node: "pc" }, op: "pane.captureMany", args: { workerIds: ["pc.3fa2c1d0.5", "pc.3fa2c1d0.0"] } }, look);
    expect(many).toEqual({ ok: true, args: { workerIds: ["pc.3fa2c1d0.0"] } });
  });

  it("file reads are refused under a protected lane's paths on a startNode, and allowed elsewhere on it", () => {
    for (const op of ["file.stat", "file.get"] as OpName[]) {
      expect(workerOpVerdict(scope, { target: { node: "pc" }, op, args: { path: "/work/m/a" } }, look), op).toMatchObject({ ok: false });
      expect(workerOpVerdict(scope, { target: { node: "pc" }, op, args: { path: "/work/other/a" } }, look), op).toEqual({ ok: true });
    }
  });
});

describe("worker socket redaction", () => {
  it("a protected pane keeps its name, status and process, and loses everything it said", () => {
    const panes = [pane("ctl.3fa2c1d0.0", "manager", { topic: "t", lastPrompt: "p", title: "x", sessionId: SID, sessionName: "n", claudeVersion: "2.0.0", cwd: "/work/m" }), pane("ctl.3fa2c1d0.1", "worker-a", { topic: "ok" })];
    const out = redactPanes(panes, hide);
    expect(out[0]).toEqual({ workerId: "ctl.3fa2c1d0.0", window: "manager", cwd: "", status: "idle", pid: 100 });
    expect(out[1]).toBe(panes[1]);
  });

  it("a pane is protected by its worker ID or its session too, whatever its window is called now", () => {
    const out = redactPanes([pane("ctl.3fa2c1d0.0", "boss", { topic: "t" }), pane("ctl.3fa2c1d0.9", "other", { topic: "t", sessionId: SID })], hide);
    expect(out.map(p => p.topic)).toEqual([undefined, undefined]);
  });

  it("an inventory event is redacted, runs and lane events of a protected lane are dropped, other events pass", () => {
    const inv = redactEvent({ t: "inventory", node: "ctl", body: { panes: [pane("ctl.3fa2c1d0.0", "manager", { topic: "t" })], invVersion: 3 } }, hide);
    expect(inv).toEqual({ t: "inventory", node: "ctl", body: { panes: [{ workerId: "ctl.3fa2c1d0.0", window: "manager", cwd: "", status: "idle", pid: 100 }], invVersion: 3 } });
    expect(redactEvent({ t: "run", node: "ctl", body: { lane: "manager", line: "STATUS: x" } }, hide)).toBeNull();
    expect(redactEvent({ t: "run", node: "ctl", body: { lane: "boss", sessionId: SID, line: "x" } }, hide)).toBeNull();
    expect(redactEvent({ t: "lane", node: "ctl", body: { lane: "manager", window: "manager", firstLine: "x" } }, hide)).toBeNull();
    expect(redactEvent({ t: "lane", node: "ctl", body: { lane: null, window: "boss", sessionId: SID } }, hide)).toBeNull();
    const ok = { t: "run" as const, node: "ctl", body: { lane: "worker-a", line: "x" } };
    expect(redactEvent(ok, hide)).toEqual(ok);
    const health = { t: "health" as const, node: "ctl", body: { load1: 1 } };
    expect(redactEvent(health, hide)).toEqual(health);
  });

  it("runs, lane-watch entries and lane events of a protected lane are left out of the lists", () => {
    expect(visibleRuns([{ lane: "manager" }, { lane: "worker-a" }, { lane: "x", sessionId: SID }], hide)).toEqual([{ lane: "worker-a" }]);
    expect(visibleLaneWatch([{ window: "manager" }, { window: "worker-a" }], hide)).toEqual([{ window: "worker-a" }]);
    expect(visibleLaneEvents([{ lane: "manager", window: "manager" }, { lane: "worker-a", window: "worker-a" }, { lane: null, window: "w", sessionId: SID }], hide)).toEqual([{ lane: "worker-a", window: "worker-a" }]);
  });
});

describe("worker socket redaction of deliveries, usage and alerts", () => {
  const stash = { at: 5, since: 4, chars: 7, copy: "/tmp/draft-copy" };
  const delivery = (target: { lane: string } | { workerId: string }, extra: Record<string, unknown> = {}) =>
    ({ id: "lanes:d1", node: "ctl", target, state: "typed", queuedAt: 1, notAfter: 9, typedAt: 2, note: "n", stale: false, sessionId: SID, stashed: stash, ...extra });

  it("a delivery to a protected lane loses its session and its stashed draft, whichever way the target names it", () => {
    for (const target of [{ lane: "manager" }, { workerId: "ctl.3fa2c1d0.0" }]) {
      const out = redactDelivery(delivery(target), hide);
      expect(out, JSON.stringify(target)).toEqual({ id: "lanes:d1", node: "ctl", target, state: "typed", queuedAt: 1, notAfter: 9, typedAt: 2, note: "n", stale: false });
    }
    const bySession = redactDelivery(delivery({ lane: "boss" }), hide);          // a renamed window: its session is a protected one
    expect(bySession.sessionId).toBeUndefined();
    expect(bySession.stashed).toBeUndefined();
  });

  it("a delivery to another lane is the same object, session and stash included", () => {
    const own = delivery({ lane: "worker-a" }, { sessionId: "22222222-2222-4222-8222-222222222222" });
    expect(redactDelivery(own, hide)).toBe(own);
  });

  it("a delivery event is redacted the same way; a usage event of a protected lane is dropped", () => {
    const ev = redactEvent({ t: "delivery", node: "ctl", body: delivery({ lane: "manager" }) }, hide);
    expect(ev).toMatchObject({ t: "delivery", body: { id: "lanes:d1", state: "typed" } });
    const shown = (ev ? ev.body : {}) as Record<string, unknown>;
    expect(shown.stashed).toBeUndefined();
    expect(shown.sessionId).toBeUndefined();
    expect(redactEvent({ t: "usage", node: "ctl", body: { kind: "lane_account", lane: "manager", account: "acct-x", at: 1 } }, hide)).toBeNull();
    expect(redactEvent({ t: "usage", node: "ctl", body: { kind: "failure", lane: null, window: "boss", sessionId: SID, error: "e", account: "acct-x", at: 1 } }, hide)).toBeNull();
    expect(redactEvent({ t: "usage", node: "ctl", body: { kind: "failure", lane: null, window: "manager", error: "e", account: "acct-x", at: 1 } }, hide)).toBeNull();
    const own = { t: "usage" as const, node: "ctl", body: { kind: "lane_account", lane: "worker-a", account: "acct-y", at: 1 } };
    expect(redactEvent(own, hide)).toBe(own);
  });

  it("a draft_stashed alert of a protected lane loses the copy's path; other alerts are the same object", () => {
    const stashed = { id: 1, at: 1, node: "ctl", kind: "draft_stashed", detail: { id: "lanes:d1", lane: "manager", since: 4, at: 5, chars: 7, copy: "/tmp/draft-copy" } };
    const out = redactAlert(stashed, hide);
    expect(out.detail).toEqual({ id: "lanes:d1", lane: "manager", since: 4, at: 5 });
    const byWorker = redactAlert({ ...stashed, detail: { ...stashed.detail, lane: undefined, workerId: "ctl.3fa2c1d0.0" } }, hide);
    expect(byWorker.detail.copy).toBeUndefined();
    const own = { ...stashed, detail: { ...stashed.detail, lane: "worker-a" } };
    expect(redactAlert(own, hide)).toBe(own);
    const other = { id: 2, at: 1, node: "ctl", kind: "lane_conflict", detail: { name: "manager" } };
    expect(redactAlert(other, hide)).toBe(other);
    expect(redactEvent({ t: "alert", node: "ctl", body: stashed }, hide)?.body).toEqual(out);
  });
});
