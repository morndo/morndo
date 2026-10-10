// The repeat of a send in doubt, resolved by the node's own record (spec §3.1 "Uncertain becomes resolvable"; §7
// "Connection lost during pane.send"). The hub's row says started, and op.status decides:
// - done → duplicate, at the node's own typedAt, typed once;
// - unknown from the store the send went to → the node never started it, so it is typed now, once;
// - unknown from another store (the agent's database was lost meanwhile), or with no store known (the fleet took the send
//   and never answered) → uncertain, never typed again;
// - started, or the node can't be asked → uncertain;
// - unknown from that same store at a lower store sequence than the send saw (the agent's database put back in place
//   from an older copy, which keeps the store) → uncertain; at the same or a higher one → typed; from an agent that
//   sends no sequence, the stores alone decide, as before (final review I2).
// The first attempt in doubt is "uncertain" itself (the hub's 409, so the app says "may have been sent"), never a throw
// (final review I1). Two repeats at once ask the node once and paste at most once. A node that is offline refuses before
// anything is typed, so the row goes and the retry types once the node is back.
// SteeringService on a real store, the fleet adapters, the fake fleet; no tmux.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import { OP_ARGS, parseBody } from "@morndo/protocol";
import { Store } from "../src/adapters/store.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import { LOST, localNode, memoryBackend, refusal, until, type FleetCall, type MemoryBackend, type Reply } from "./helpers/fake-fleet.ts";
import { fleetRig, steeringFor, type FleetRig } from "./helpers/hub-mode.ts";

const NOW = Date.UTC(2026, 9, 6, 9);
const PC1 = "pc.aaaaaaaa.1";
const RID = "0b7a52c1-4d2e-4f3a-9b8c-7d6e5f4a3b2c";
const KEY = `ep1:${RID}`;
const A: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: NOW - 1000, lastSeenAt: NOW, verifiedAt: NOW - 1000, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: NOW, revokedAt: null },
};

let dir: string;
let store: Store;
let pc: MemoryBackend;
let rig: FleetRig;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-fleet-steering-"));
  store = new Store(dir);
  pc = memoryBackend({ "%1": { name: "alpha", cwd: "/w/alpha", screen: "──────\n❯ " } });
  pc.typedAt = NOW + 7;                                  // the node's clock, a little ahead of the hub's
  rig = await fleetRig([localNode("pc", "aaaaaaaa", pc)]);
  await rig.ports.tmux.listWorkers();
});
afterEach(async () => {
  await rig.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
// A new SteeringService on the same store and the same fleet stands for the hub restarting.
const steering = () => steeringFor(rig.ports, { store, now: () => NOW });
const send = () => steering().send(A, PC1, "ship it", RID, [], "none");
const rows = () => store.db.prepare("SELECT key, state FROM sends ORDER BY key").all();
const statusCalls = () => rig.fleet.calls.filter(c => c.op === "op.status").length;

describe("a repeat of a send in doubt asks the node (op.status)", () => {
  it("a drop after the paste: uncertain while the node's record says started; duplicate once it says done; typed once", async () => {
    const release = pc.hold();                                         // the pane takes the paste, then waits
    rig.fleet.intercept("pane.send", async (_call, next) => { void next(); return LOST; });
    expect(await send()).toEqual({ ok: false, problem: "uncertain" });   // 409 uncertain: may have been sent
    rig.fleet.intercept("pane.send", null);
    expect(rows()).toEqual([{ key: KEY, state: "started" }]);
    await until(() => pc.typed.length === 1);
    expect(await send()).toEqual({ ok: false, problem: "uncertain" });   // the node: started
    release();
    await until(() => rig.fleet.node("pc").keys.get(`hub:${KEY}`)?.state === "done");
    expect(await send()).toEqual({ ok: false, problem: "duplicate", at: NOW + 7 });   // the node's typedAt, from op.status
    expect(pc.typed.map(t => t.text)).toEqual(["ship it"]);
    expect(rows()).toEqual([{ key: KEY, state: "done" }]);
  });

  it("lost before the node had it: op.status unknown, so the repeat types it, once", async () => {
    rig.fleet.intercept("pane.send", async () => LOST);
    expect(await send()).toEqual({ ok: false, problem: "uncertain" });   // 409 uncertain: may have been sent
    rig.fleet.intercept("pane.send", null);
    expect(pc.typed).toEqual([]);
    expect(await send()).toEqual({ ok: true, at: NOW + 7 });
    expect(pc.typed.map(t => t.text)).toEqual(["ship it"]);
    expect(rows()).toEqual([{ key: KEY, state: "done" }]);
    expect(rig.fleet.calls.filter(c => c.op === "op.status")).toHaveLength(1);
  });

  it("a drop after the paste, then the node's agent database lost (a new store): uncertain, never typed again", async () => {
    rig.fleet.intercept("pane.send", async (_call, next) => { await next(); return LOST; });
    expect(await send()).toEqual({ ok: false, problem: "uncertain" });   // 409 uncertain: may have been sent
    rig.fleet.intercept("pane.send", null);
    expect(store.send(KEY)?.store).toBe(rig.fleet.node("pc").store);   // the store the send went to, kept with its row
    rig.fleet.node("pc").resetStore();                                 // its keys are gone: op.status can only say unknown
    expect(await send()).toEqual({ ok: false, problem: "uncertain" });
    expect(pc.typed.map(t => t.text)).toEqual(["ship it"]);
    expect(rows()).toEqual([{ key: KEY, state: "started" }]);
  });

  it("the fleet took the send and never answered: no store is known, so an unknown from the node isn't trusted", async () => {
    await rig.close();
    rig = await fleetRig([localNode("pc", "aaaaaaaa", pc)], { timeouts: { sendMs: 50 } });
    await rig.ports.tmux.listWorkers();
    rig.fleet.intercept("pane.send", () => new Promise(() => {}));   // the request is taken; no answer ever comes
    expect(await send()).toEqual({ ok: false, problem: "uncertain" });
    rig.fleet.intercept("pane.send", null);
    expect(store.send(KEY)).toMatchObject({ state: "started", store: null });
    expect(await send()).toEqual({ ok: false, problem: "uncertain" });
    expect(pc.typed).toEqual([]);
  });

  it("two repeats at once: the node is asked once, and the send typed once", async () => {
    rig.fleet.intercept("pane.send", async () => LOST);               // lost before the node had it: unknown, its store
    expect(await send()).toEqual({ ok: false, problem: "uncertain" });   // 409 uncertain: may have been sent
    rig.fleet.intercept("pane.send", null);
    const s = steering();                                             // one hub process, two repeats at once
    const [one, two] = await Promise.all([s.send(A, PC1, "ship it", RID, [], "none"), s.send(A, PC1, "ship it", RID, [], "none")]);
    expect([one, two]).toEqual([{ ok: true, at: NOW + 7 }, { ok: false, problem: "duplicate", at: NOW + 7 }]);
    expect(statusCalls()).toBe(1);
    expect(pc.typed.map(t => t.text)).toEqual(["ship it"]);
  });

  it("the node can't be asked about it: uncertain, and nothing is typed", async () => {
    rig.fleet.intercept("pane.send", async () => LOST);
    expect(await send()).toEqual({ ok: false, problem: "uncertain" });   // 409 uncertain: may have been sent
    rig.fleet.intercept("pane.send", null);
    await rig.fleet.setStatus("pc", "offline");
    expect(await send()).toEqual({ ok: false, problem: "uncertain" });
    expect(rows()).toEqual([{ key: KEY, state: "started" }]);
    expect(pc.typed).toEqual([]);
  });
});

// Final review I2, the store sequence: a database put back from an older copy keeps its store (cp over the file in place,
// a VM snapshot), so the store alone can't tell it from the one the send went to; its sequence can.
describe("the store sequence: a database that went backwards can't vouch", () => {
  it("a drop after the paste, then the node's database put back in place from an older copy: the same store, behind; uncertain, typed once", async () => {
    const putBack = rig.fleet.node("pc").copy();                       // the copy, taken before the send
    rig.fleet.intercept("pane.send", async (_call, next) => { await next(); return LOST; });
    expect(await send()).toEqual({ ok: false, problem: "uncertain" });
    rig.fleet.intercept("pane.send", null);
    expect(store.send(KEY)).toMatchObject({ state: "started", store: rig.fleet.node("pc").store, storeSeq: 1 });   // kept with its row
    putBack();                                                          // the key is gone, the store id stays, the sequence goes back
    for (let i = 0; i < 2; i++) expect(await send()).toEqual({ ok: false, problem: "uncertain" });   // the repeat, then Check again
    expect(pc.typed.map(t => t.text)).toEqual(["ship it"]);
    expect(rows()).toEqual([{ key: KEY, state: "started" }]);
    expect(statusCalls()).toBe(2);
  });

  it("no restore: unknown from the same store at the same sequence types the repeat, once (retries still work)", async () => {
    rig.fleet.intercept("pane.send", async () => LOST);                // lost before the node had it: nothing started there
    expect(await send()).toEqual({ ok: false, problem: "uncertain" });
    rig.fleet.intercept("pane.send", null);
    expect(store.send(KEY)).toMatchObject({ storeSeq: 0 });
    expect(await send()).toEqual({ ok: true, at: NOW + 7 });
    expect(pc.typed.map(t => t.text)).toEqual(["ship it"]);
  });

  it("no restore: unknown from the same store at a higher sequence (other sends since) types the repeat, once", async () => {
    rig.fleet.intercept("pane.send", async () => LOST);
    expect(await send()).toEqual({ ok: false, problem: "uncertain" });
    rig.fleet.intercept("pane.send", null);
    expect(await steering().send(A, PC1, "another", "1c8b63d2-5e3f-4a4b-8c9d-8e7f6a5b4c3d", [], "none")).toEqual({ ok: true, at: NOW + 7 });
    expect(rig.fleet.node("pc").storeSeq).toBe(1);                     // the node moved on past what the send saw (0)
    expect(await send()).toEqual({ ok: true, at: NOW + 7 });
    expect(pc.typed.map(t => t.text)).toEqual(["another", "ship it"]);
  });

  it("an agent that sends no store sequence: the stores alone decide, as before, so a copy put back in place isn't caught", async () => {
    await rig.close();
    rig = await fleetRig([localNode("pc", "aaaaaaaa", pc, { storeSeq: false })]);
    await rig.ports.tmux.listWorkers();
    const putBack = rig.fleet.node("pc").copy();
    rig.fleet.intercept("pane.send", async (_call, next) => { await next(); return LOST; });
    expect(await send()).toEqual({ ok: false, problem: "uncertain" });
    rig.fleet.intercept("pane.send", null);
    expect(store.send(KEY)).toMatchObject({ state: "started", storeSeq: null });
    putBack();
    expect(await send()).toEqual({ ok: true, at: NOW + 7 });           // today's behaviour without the sequence: typed again
    expect(pc.typed.map(t => t.text)).toEqual(["ship it", "ship it"]);
  });
});

describe("a node that is offline", () => {
  it("refuses before typing: the row goes, and the retry types once the node is back", async () => {
    await rig.fleet.setStatus("pc", "offline");
    expect(await send()).toEqual({ ok: false, problem: "node_offline" });
    expect(rows()).toEqual([]);
    await rig.fleet.setStatus("pc", "online");
    expect(await send()).toEqual({ ok: true, at: NOW + 7 });
    expect(pc.typed.map(t => t.text)).toEqual(["ship it"]);
  });
});

// A definite refusal from the node or the fleet (executed "no": nothing ran, the key released) is a refusal here too:
// the row goes, the owner sees why, and a retry types once the cause is fixed (final review M1; before, it was thrown as
// FleetOpFailed, a 500, and the row stayed "started", so every retry answered "uncertain").
describe("a definite refusal releases the row", () => {
  // Plan Review Focus 1: a window name with a control character is listed but can't be steered through the fleet, since
  // OP_ARGS' expect.window refuses it. The fleet and the agent check the arguments with that schema; so does this stand-in.
  const checked = (call: FleetCall, next: () => Promise<Reply>) =>
    parseBody(OP_ARGS["pane.send"], call.args) === null ? Promise.resolve(refusal("bad_args", "expect.window: a control character")) : next();

  it("a tab in the window's name: bad_args, nothing typed, no row; renamed, the same request types once", async () => {
    pc.panes["%1"] = { name: "fix\tplan", cwd: "/w/alpha", screen: "──────\n❯ " };
    await rig.ports.tmux.listWorkers();
    rig.fleet.intercept("pane.send", checked);
    expect(await send()).toEqual({ ok: false, problem: "bad_args" });
    expect(rows()).toEqual([]);
    expect(pc.typed).toEqual([]);
    pc.panes["%1"] = { name: "fix plan", cwd: "/w/alpha", screen: "──────\n❯ " };   // the owner renames the window
    await until(async () => (await rig.ports.tmux.listWorkers()).some(w => w.id === PC1 && w.name === "fix plan"));
    expect(await send()).toEqual({ ok: true, at: NOW + 7 });
    expect(pc.typed.map(t => t.text)).toEqual(["ship it"]);
    expect(statusCalls()).toBe(0);                                    // never in doubt: nothing to ask the node
  });

  // Widened by ruling (ADR-0012 decision 7): any error whose executed is "no" releases the row, an agent's `internal` among
  // them (a full disk before keys.start, lane FB's M6).
  it("internal with executed no (nothing ran on the node): a refusal, no row; the retry types once", async () => {
    rig.fleet.intercept("pane.send", async () => ({ ok: false, error: { code: "internal", executed: "no", message: "keys.start: disk full" } }));
    expect(await send()).toEqual({ ok: false, problem: "internal" });
    expect(rows()).toEqual([]);
    rig.fleet.intercept("pane.send", null);
    expect(await send()).toEqual({ ok: true, at: NOW + 7 });
    expect(pc.typed.map(t => t.text)).toEqual(["ship it"]);
  });

  it("internal with executed maybe, or a code that says uncertain whatever its executed: in doubt, the row kept", async () => {
    for (const [code, executed] of [["internal", "maybe"], ["uncertain", "no"]] as const) {
      store.dropSend(KEY);
      rig.fleet.intercept("pane.send", async () => ({ ok: false, error: { code, executed, message: "x" } }));
      expect(await send(), `${code}/${executed}`).toEqual({ ok: false, problem: "uncertain" });
      expect(rows(), `${code}/${executed}`).toEqual([{ key: KEY, state: "started" }]);
    }
  });

  it.each(["denied", "too_large", "unknown_op"] as const)("%s: a refusal, no row; once the cause is fixed, the same request types once", async code => {
    rig.fleet.intercept("pane.send", async () => refusal(code));     // denied: a policy without pane.send
    expect(await send()).toEqual({ ok: false, problem: code });
    expect(rows()).toEqual([]);
    rig.fleet.intercept("pane.send", null);
    expect(await send()).toEqual({ ok: true, at: NOW + 7 });
    expect(pc.typed.map(t => t.text)).toEqual(["ship it"]);
  });
});

// ADR-0006 "every send is audited" (V38): a send in doubt that its node had typed is audited when the repeat learns it.
describe("a send found typed there is audited then", () => {
  it("a drop after the paste, then the repeat finds it done there: its CommandSent audit row is recorded then, once", async () => {
    rig.fleet.intercept("pane.send", async (_call, next) => { await next(); return LOST; });
    expect(await send()).toEqual({ ok: false, problem: "uncertain" });
    rig.fleet.intercept("pane.send", null);
    expect(store.audit(10).filter(e => e.type === "CommandSent")).toEqual([]);         // in doubt: not audited yet
    expect(await send()).toEqual({ ok: false, problem: "duplicate", at: NOW + 7 });
    expect(await send()).toEqual({ ok: false, problem: "duplicate", at: NOW + 7 });     // a third press adds no row
    expect(store.audit(10).filter(e => e.type === "CommandSent").map(e => e.body)).toEqual([{
      type: "CommandSent", sessionId: "s1", endpointId: "ep1", workerId: PC1, length: 7,
      digest: createHash("sha256").update("ship it").digest("hex").slice(0, 16), at: NOW + 7,
    }]);
    expect(pc.typed.map(t => t.text)).toEqual(["ship it"]);
  });
});
