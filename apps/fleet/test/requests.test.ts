// Requests to an agent (spec 5.2, 5.3): req { id, op, args, timeoutMs, key? } and its res, matched by id, its result
// checked against OP_RESULTS; deadlines the agent never answered: timeout (executed: no) for a read, uncertain
// (executed: maybe) for a side-effecting op; no message over 512 KiB; one bulk transfer at a time per node, with
// control ops never queued behind it, at most 8 waiting, each waiting op's deadline counted from when it was queued.
// Every outcome carries the store its answer comes from: the agent's, the connection's for the fleet's own answer
// after sending, null when nothing was sent. And that store's sequence (final review I2): the agent's own as it sent it,
// the highest any answer from that store showed for the fleet's own answer after sending, null when nothing was sent or
// the agent sends none.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CAP_LONG_TEXT, LIMITS } from "@morndo/protocol";
import type { Req } from "./helpers/fake-agent.ts";
import { startTestFleet } from "./helpers/fleet.ts";
import { tempDir } from "./helpers/temp.ts";

describe("requests to an agent", () => {
  it("a request reaches the agent with its args, key and timeout, and its result comes back with invVersion", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    a.answer = req => (req.op === "pane.send" ? { ok: true, result: { problem: null, typedAt: 42 } } : { ok: true, result: {} });
    const args = { workerId: "pc.3fa2c1d0.1", text: "hello", expect: { server: "3fa2c1d0", window: "api" } };
    const r = await fleet.connections.request("pc", "pane.send", args, { key: "hub:e1:r1", timeoutMs: 4000 });
    expect(r).toEqual({ ok: true, result: { problem: null, typedAt: 42 }, invVersion: 1, store: a.streamId, storeSeq: null });
    expect(a.reqs).toEqual([{ v: 1, t: "req", id: "1.1", op: "pane.send", args, timeoutMs: 4000, key: "hub:e1:r1" }]);
  });

  it("passes the agent's refusal through as it is", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    a.answer = () => ({ ok: false, error: { code: "menu_open", executed: "no", message: "a menu is open" } });
    expect(await fleet.connections.request("pc", "pane.send", {}, { key: "hub:k", timeoutMs: 1000 }))
      .toEqual({ ok: false, error: { code: "menu_open", executed: "no", message: "a menu is open" }, store: a.streamId, storeSeq: null });
  });

  it("a result that doesn't fit its op's shape is internal (executed: maybe), never handed on; op.status's outcome passes as stored", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    a.answer = req => ({ ok: true, result: req.op === "pane.send" ? { problem: "exploded", typedAt: 1 } : { panes: "none" } });
    expect(await fleet.connections.request("pc", "pane.send", {}, { key: "hub:k", timeoutMs: 1000 }))
      .toMatchObject({ ok: false, error: { code: "internal", executed: "maybe" } });
    expect(await fleet.connections.request("pc", "inventory.get", {}, { timeoutMs: 1000 }))
      .toMatchObject({ ok: false, error: { code: "internal", executed: "maybe" } });
    const outcome = { problem: null, typedAt: 5, more: [1] };
    a.answer = () => ({ ok: true, result: { state: "done", outcome } });
    expect(await fleet.connections.request("pc", "op.status", { key: "hub:k" }, { timeoutMs: 1000 }))
      .toEqual({ ok: true, result: { state: "done", outcome }, invVersion: 1, store: a.streamId, storeSeq: null });
  });

  it("every answer carries its store: the agent's own on its answers, the connection's on the fleet's after sending, null before", async () => {
    const fleet = await startTestFleet({ resultSlackMs: 20 });
    const a = await fleet.online("pc", { caps: [CAP_LONG_TEXT] });
    a.store = randomUUID();                                                        // the agent says where its keys are
    a.answer = req => (req.op === "pane.send" ? { ok: false, error: { code: "busy", executed: "no", message: "locked" } }
      : req.op === "inventory.get" ? { ok: true, result: { panes: "none" } } : req.op === "op.status" ? { ok: true, result: { state: "unknown" } } : "never");
    expect(await fleet.connections.request("pc", "op.status", { key: "hub:k" }, { timeoutMs: 1000 })).toMatchObject({ ok: true, store: a.store });
    expect(await fleet.connections.request("pc", "pane.send", {}, { key: "hub:k", timeoutMs: 1000 })).toMatchObject({ ok: false, store: a.store });
    expect(await fleet.connections.request("pc", "inventory.get", {}, { timeoutMs: 1000 })).toMatchObject({ error: { code: "internal" }, store: a.store });
    // The fleet's own answers to a request it sent: the store of the connection it went out on (the hello's stream id).
    expect(await fleet.connections.request("pc", "transcript.size", { sessionId: "s" }, { timeoutMs: 50 })).toMatchObject({ error: { code: "timeout" }, store: a.streamId });
    expect(await fleet.connections.request("pc", "lane.stop", { name: "x" }, { key: "hub:k2", timeoutMs: 50 })).toMatchObject({ error: { code: "uncertain" }, store: a.streamId });
    // Nothing sent: no store.
    expect(await fleet.connections.request("pc", "pane.send", { text: "x".repeat(LIMITS.maxMessageBytes) }, { key: "hub:k3", timeoutMs: 1000 })).toMatchObject({ error: { code: "too_large" }, store: null });
    expect(await fleet.connections.request("mac", "inventory.get", {}, { timeoutMs: 1000 })).toMatchObject({ error: { code: "node_offline" }, store: null });
  });

  it("every answer carries its store's sequence: the agent's own as sent, the highest seen on the fleet's after sending, null before (final review I2)", async () => {
    const fleet = await startTestFleet({ resultSlackMs: 20 });
    const a = await fleet.online("pc");
    // An agent from before the store sequence sends none: null, never guessed.
    expect(await fleet.connections.request("pc", "op.status", { key: "hub:k" }, { timeoutMs: 1000 })).toMatchObject({ ok: true, storeSeq: null });
    a.storeSeq = 7;
    a.answer = req => (req.op === "op.status" ? { ok: true, result: { state: "unknown" } } : req.op === "pane.send" ? { ok: false, error: { code: "busy", executed: "no", message: "locked" } } : "never");
    expect(await fleet.connections.request("pc", "op.status", { key: "hub:k" }, { timeoutMs: 1000 })).toMatchObject({ ok: true, store: a.streamId, storeSeq: 7 });
    expect(await fleet.connections.request("pc", "pane.send", {}, { key: "hub:k", timeoutMs: 1000 })).toMatchObject({ ok: false, storeSeq: 7 });
    // The agent's own goes on as it sent it, a lower one included: op.status's must say where the database is now.
    a.storeSeq = 3;
    expect(await fleet.connections.request("pc", "op.status", { key: "hub:k" }, { timeoutMs: 1000 })).toMatchObject({ ok: true, storeSeq: 3 });
    // The fleet's own answer after sending (the answer lost): the highest this store has shown, 7, a number it reached.
    expect(await fleet.connections.request("pc", "lane.stop", { name: "x" }, { key: "hub:k2", timeoutMs: 50 }))
      .toMatchObject({ error: { code: "uncertain" }, store: a.streamId, storeSeq: 7 });
    expect(fleet.connections.requests.highestSeq("pc", a.streamId)).toBe(7);
    // Nothing sent: no store, no sequence.
    expect(await fleet.connections.request("mac", "inventory.get", {}, { timeoutMs: 1000 })).toMatchObject({ store: null, storeSeq: null });
    // A store no answer has shown a sequence for has none.
    expect(fleet.connections.requests.highestSeq("pc", randomUUID())).toBeNull();
  });

  it("the welcome says the highest store sequence the hello's store has shown (storeSeqSeen), kept in fleet.db across a restart", async () => {
    const dir = tempDir();
    const fleet = await startTestFleet({ dir });
    const a = await fleet.online("pc");
    expect(a.welcome && "storeSeqSeen" in a.welcome).toBe(false);                 // nothing seen yet: omitted
    a.storeSeq = 4;
    expect(await fleet.connections.request("pc", "op.status", { key: "hub:k" }, { timeoutMs: 1000 })).toMatchObject({ ok: true, storeSeq: 4 });
    a.storeSeq = 9;
    expect(await fleet.connections.request("pc", "inventory.get", {}, { timeoutMs: 1000 })).toMatchObject({ ok: true, storeSeq: 9 });
    a.storeSeq = 2;                                                                  // lower later: what was seen stays 9
    await fleet.connections.request("pc", "inventory.get", {}, { timeoutMs: 1000 });
    expect((await a.connect()).ok).toBe(true);                                       // a reconnect of the same store
    expect(a.welcome?.storeSeqSeen).toBe(9);
    await fleet.close();
    const restarted = await startTestFleet({ dir });                                // the fleet restarted: fleet.db kept it
    const again = restarted.agent({ node: "pc", key: a.key, streamId: a.streamId });
    expect(await again.connect()).toMatchObject({ ok: true, welcome: { storeSeqSeen: 9 } });
    expect(restarted.connections.requests.highestSeq("pc", a.streamId)).toBe(9);
    const other = restarted.agent({ node: "pc", key: a.key, streamId: randomUUID(), instanceId: again.instanceId });   // a new store
    const r = await other.connect();
    expect(r.ok && "storeSeqSeen" in r.welcome).toBe(false);
  });

  it("an unanswered read times out (executed: no); an unanswered side effect is uncertain (executed: maybe)", async () => {
    const fleet = await startTestFleet({ resultSlackMs: 20 });
    const a = await fleet.online("pc");
    a.answer = () => "never";
    expect(await fleet.connections.request("pc", "transcript.size", { sessionId: "s" }, { timeoutMs: 50 }))
      .toMatchObject({ ok: false, error: { code: "timeout", executed: "no" } });
    expect(await fleet.connections.request("pc", "pane.send", {}, { key: "hub:k", timeoutMs: 50 }))
      .toMatchObject({ ok: false, error: { code: "uncertain", executed: "maybe" } });
    expect(await fleet.connections.request("pc", "pane.keys", {}, { timeoutMs: 50 }))
      .toMatchObject({ ok: false, error: { code: "uncertain", executed: "maybe" } });     // keystrokes: a side effect
    expect(fleet.connections.requests.size).toBe(0);
  });

  it("a request over 512 KiB is refused too_large (executed: no) and never sent: it would close the node's connection", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc", { caps: [CAP_LONG_TEXT] });
    expect(await fleet.connections.request("pc", "pane.send", { text: "x".repeat(LIMITS.maxMessageBytes) }, { key: "hub:k", timeoutMs: 1000 }))
      .toMatchObject({ ok: false, error: { code: "too_large", executed: "no" } });
    expect(a.reqs).toEqual([]);
    expect(a.open).toBe(true);
  });

  it("bulk transfers go one at a time per node, and control ops never wait behind them (spec 5.2)", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    const held: Req[] = [];
    a.answer = req => {
      if (req.op !== "file.get") return { ok: true, result: { panes: [], invVersion: 1 } };
      held.push(req);
      return "never";
    };
    const first = fleet.connections.request("pc", "file.get", { path: "/a", offset: 0, max: 10 }, { timeoutMs: 5000 });
    const second = fleet.connections.request("pc", "file.get", { path: "/b", offset: 0, max: 10 }, { timeoutMs: 5000 });
    expect(await fleet.connections.request("pc", "inventory.get", {}, { timeoutMs: 5000 })).toMatchObject({ ok: true });
    expect(a.reqs.map(r => r.op)).toEqual(["file.get", "inventory.get"]);            // the second file.get waits
    const reply = (req: Req | undefined) => a.send({ v: 1, t: "res", id: req?.id, invVersion: 1, store: a.store, ok: true, result: { bytes: "", size: 0, eof: true } });
    reply(held[0]);
    expect(await first).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(held).toHaveLength(2));
    expect(held[1]?.args).toMatchObject({ path: "/b" });
    reply(held[1]);
    expect(await second).toMatchObject({ ok: true });
  });

  it("a waiting bulk op's deadline counts from when it was queued: behind a hung transfer it answers timeout, never sent", async () => {
    const fleet = await startTestFleet({ resultSlackMs: 20 });
    const a = await fleet.online("pc");
    a.answer = () => "never";
    const hung = fleet.connections.request("pc", "file.get", { path: "/a", offset: 0, max: 10 }, { timeoutMs: 3000 });
    const started = performance.now();
    const waiting = await fleet.connections.request("pc", "file.get", { path: "/b", offset: 0, max: 10 }, { timeoutMs: 300 });
    expect(waiting).toEqual({ ok: false, error: expect.objectContaining({ code: "timeout", executed: "no" }), store: null, storeSeq: null });
    expect(performance.now() - started).toBeLessThan(1500);                        // its own 300 ms, not the hung one's 3 s
    expect(a.reqs.map(r => (r.args as { path: string }).path)).toEqual(["/a"]);
    expect(await hung).toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  it("a slow node that answers: each waiting bulk op goes with what is left of its own timeout, and all of them land", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    a.answer = req => {
      setTimeout(() => a.send({ v: 1, t: "res", id: req.id, invVersion: 1, store: a.store, ok: true, result: { bytes: "", size: 0, eof: true } }), 150);
      return "never";
    };
    const all = await Promise.all([1, 2, 3, 4].map(n => fleet.connections.request("pc", "file.get", { path: `/${n}`, offset: 0, max: 10 }, { timeoutMs: 5000 })));
    expect(all.every(o => o.ok)).toBe(true);
    const sent = a.reqs.map(r => r.timeoutMs);
    expect(sent[0]).toBe(5000);
    for (let i = 1; i < sent.length; i++) expect(sent[i], `transfer ${i + 1}`).toBeLessThan((sent[i - 1] ?? 0) - 100);   // ~150 ms less each
  });

  it("at most 8 bulk ops wait per node: the next one is busy (executed: no), never sent", async () => {
    const fleet = await startTestFleet({ resultSlackMs: 20 });
    const a = await fleet.online("pc");
    a.answer = () => "never";
    const get = (n: number) => fleet.connections.request("pc", "file.get", { path: `/${n}`, offset: 0, max: 10 }, { timeoutMs: 400 });
    const inFlight = [0, ...Array.from({ length: LIMITS.bulkQueueMax }, (_, i) => i + 1)].map(get);   // one sent, 8 waiting
    expect(await get(99)).toEqual({ ok: false, error: expect.objectContaining({ code: "busy", executed: "no" }), store: null, storeSeq: null });
    await vi.waitFor(() => expect(a.reqs).toHaveLength(1));
    expect((await Promise.all(inFlight)).every(o => !o.ok)).toBe(true);           // the hung one and those behind it time out
    expect(a.reqs).toHaveLength(1);                                                 // none of those waiting was ever sent
  });

  it("a node that is not online answers node_offline (executed: no) without sending anything", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.joined("pc");
    expect(await fleet.connections.request("pc", "inventory.get", {}, { timeoutMs: 1000 }))
      .toEqual({ ok: false, error: { code: "node_offline", executed: "no", message: "node pc is offline" }, store: null, storeSeq: null });
    expect(await fleet.connections.request("nobody", "inventory.get", {}, { timeoutMs: 1000 })).toMatchObject({ ok: false, error: { code: "node_offline" } });
    expect(a.reqs).toEqual([]);
  });
});
