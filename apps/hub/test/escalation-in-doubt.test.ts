// An escalation answer in doubt gets the send path's discipline (fleet core §3.1, §7; final review C1). Its row is written
// "started" before it is typed, with the worker it goes to and the request that sends it, as a send's is; when the node
// may have typed it (SendInDoubt), the row keeps the store it went to, and when the hub stopped while typing it, the row
// has no store. A repeat (the same request, or a new one with the same answer key) is settled through op.status
// as SteeringService settles a send:
// - done → delivered after all: a duplicate at the node's own typedAt, recorded once, typed once;
// - unknown from the store the answer went to → the node never started it, so it is typed now, once;
// - unknown from another store (the agent's database was lost or reinstalled), started, or the node offline →
//   uncertain, and nothing is typed.
// The row is in the hub's database, so a hub restart between the attempt and the repeat changes nothing. And the repeat
// asks the node the answer went to, even when the manager's name now points at another window (a conflict resolved by a
// rename, the Task 14d design note), so it is never typed into that one as well.
// The legacy hub has no store and no SendInDoubt: its answer path is as before (the port's throw passed on, no row).
// EscalationService on a real store, the fleet adapters and the fake fleet; synthetic list and conversation.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId, type Message } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import type { EscalationService } from "../src/application/escalation-service.ts";
import { LOST, localNode, memoryBackend, refusal, until, type MemoryBackend } from "./helpers/fake-fleet.ts";
import { escalationsFor, fleetRig, portsFor, type FleetRig } from "./helpers/hub-mode.ts";

const T0 = Date.UTC(2026, 9, 6, 8);
const PC0 = "pc.aaaaaaaa.0";                                           // the manager's pane, on node pc
const BOX0 = "box.bbbbbbbb.0";                                         // a window on node box, later named manager
const TAP = "[tap ny-7] ship (Ship it)";
const KEY = "answer:ny-7:m1:option:ship";
const SHIP = { kind: "option", key: "ship" } as const;
const auth: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: T0, lastSeenAt: T0, verifiedAt: T0, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: T0, revokedAt: null },
};
const asked: Message = { id: "m1", at: T0 - 60_000, author: { kind: "agent", name: "manager" }, kind: "text", text: "Ready.\n\n[buttons ny-7] ship=Ship it | hold=Hold for a day" };

let dir: string;
let store: Store;
let ledgerPath: string;
let pc: MemoryBackend;
let box: MemoryBackend;
let rig: FleetRig;
let manager: string;                                                   // the worker the manager's name points at now
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-answer-doubt-"));
  store = new Store(dir);
  ledgerPath = join(dir, "ledger.json");
  writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-7", kind: "tap", question: "Ship the demo release tonight?", default: "hold" }], needsYouClosed: [] }));
  pc = memoryBackend({ "%0": { name: "manager", cwd: "/w/manager", screen: "❯ " } });
  pc.typedAt = T0 + 7;                                                 // the node's clock, a little ahead of the hub's
  box = memoryBackend({ "%0": { name: "spare", cwd: "/w/spare", screen: "❯ " } });
  rig = await fleetRig([localNode("pc", "aaaaaaaa", pc), localNode("box", "bbbbbbbb", box)]);
  await rig.ports.tmux.listWorkers();
  manager = PC0;
});
afterEach(async () => {
  await rig.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// A new service on the same store and the same fleet stands for the hub restarting.
function hub(): EscalationService {
  const s = escalationsFor(rig.ports, {
    store, now: () => T0, ledger: ledgerReader(ledgerPath, () => T0),
    watch: { workers: () => [{ id: manager, name: "manager" }], history: id => (id === manager ? [asked] : []), openQuestions: () => [], screen: () => undefined },
  });
  s.poll();
  return s;
}
// The first attempt's answer lost: after the node typed it ("after"), or before the node had it ("before").
function lose(when: "after" | "before") {
  let left = 1;
  rig.fleet.intercept("pane.send", async (_call, next) => {
    if (left-- <= 0) return next();
    if (when === "after") await next();
    return LOST;
  });
}
const taps = (b: MemoryBackend) => b.typed.filter(t => t.text === TAP).length;
const decisions = () => store.audit(20).filter(a => a.type === "EscalationAnswered").length;
const row = () => store.db.prepare("SELECT key, state, worker_id AS workerId, request, node_store AS store FROM sends").all();
const statusCalls = () => rig.fleet.calls.filter(c => c.op === "op.status");

describe("an answer in doubt is settled with its node (op.status)", () => {
  it("in doubt after the paste, then the agent's database reset (a new store): every repeat is uncertain, typed once", async () => {
    const s = hub();
    lose("after");
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    expect(row()).toEqual([{ key: KEY, state: "started", workerId: PC0, request: "ep1:r1", store: rig.fleet.node("pc").store }]);
    rig.fleet.node("pc").resetStore();                                 // its keys are gone: op.status can only say unknown
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });   // Check again
    expect(await s.answer(auth, "ny-7", SHIP, "r2")).toMatchObject({ ok: false, problem: "uncertain" });   // a new tap
    expect(taps(pc)).toBe(1);
    expect(decisions()).toBe(0);
    expect(statusCalls().map(c => c.args)).toEqual([{ key: `hub:${KEY}` }, { key: `hub:${KEY}` }]);
  });

  it("unknown from the store it went to: the node never had it, so the repeat types it now, once, and records it", async () => {
    const s = hub();
    lose("before");
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    expect(taps(pc)).toBe(0);
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: true });
    expect(taps(pc)).toBe(1);
    expect(decisions()).toBe(1);
    // The row in doubt went when the node said unknown; the answer typed then has its own, done (written before typing).
    expect(row()).toEqual([{ key: KEY, state: "done", workerId: PC0, request: "ep1:r1", store: rig.fleet.node("pc").store }]);
    expect(statusCalls()).toHaveLength(1);
  });

  it("done: a duplicate at the node's typedAt, recorded once, typed once", async () => {
    const s = hub();
    lose("after");
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    expect(decisions()).toBe(0);                                       // recorded only once it is known to have arrived
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: true, duplicate: true, at: T0 + 7 });
    expect(taps(pc)).toBe(1);
    expect(decisions()).toBe(1);
    expect(row()).toMatchObject([{ key: KEY, state: "done" }]);
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: true });   // once more: nothing new
    expect(taps(pc)).toBe(1);
    expect(decisions()).toBe(1);
  });

  it("started (the node is still typing it), then the node offline: uncertain each time, nothing typed again", async () => {
    const s = hub();
    const release = pc.hold();                                         // the pane takes the paste, then waits
    rig.fleet.intercept("pane.send", async (_call, next) => { void next(); return LOST; });
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    rig.fleet.intercept("pane.send", null);
    await until(() => pc.typed.length === 1);
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });   // the node: started
    await rig.fleet.setStatus("pc", "offline");
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });   // can't be asked
    release();
    expect(taps(pc)).toBe(1);
    expect(decisions()).toBe(0);
  });
});

// Final review I2, the store sequence: the node's database put back in place from an older copy keeps its store, so only
// its sequence can tell it from the one the answer went to.
describe("the store sequence", () => {
  const rowSeq = () => store.db.prepare("SELECT node_store_seq AS seq FROM sends").all();
  it("in doubt after the paste, then the node's database put back in place from an older copy: every repeat is uncertain, typed once", async () => {
    const s = hub();
    const putBack = rig.fleet.node("pc").copy();
    lose("after");
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    expect(rowSeq()).toEqual([{ seq: 1 }]);
    putBack();                                                         // the key gone, the store id kept, the sequence back at 0
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });   // Check again
    expect(await s.answer(auth, "ny-7", SHIP, "r2")).toMatchObject({ ok: false, problem: "uncertain" });   // a new tap
    expect(await hub().answer(auth, "ny-7", SHIP, "r3")).toMatchObject({ ok: false, problem: "uncertain" });   // after a hub restart
    expect(taps(pc)).toBe(1);
    expect(decisions()).toBe(0);
  });
  it("no restore: unknown from the same store at the same or a higher sequence types the answer, once", async () => {
    const s = hub();
    lose("before");
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    pc.panes["%1"] = { name: "spare", cwd: "/w/spare", screen: "❯ " };
    await rig.ports.tmux.send("pc.aaaaaaaa.1", "elsewhere", "other");    // another keyed op on that node: its sequence moves on
    expect(rig.fleet.node("pc").storeSeq).toBe(1);
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: true });
    expect(taps(pc)).toBe(1);
    expect(decisions()).toBe(1);
  });
});

describe("across a hub restart", () => {
  it("the agent's database reset meanwhile: the restarted hub's repeat is uncertain, typed once", async () => {
    lose("after");
    expect(await hub().answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    rig.fleet.node("pc").resetStore();
    const restarted = hub();                                           // a new service on the same database
    expect(await restarted.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    expect(await restarted.answer(auth, "ny-7", SHIP, "r2")).toMatchObject({ ok: false, problem: "uncertain" });
    expect(taps(pc)).toBe(1);
  });

  it("the node typed it: the restarted hub's repeat is a duplicate, recorded once, typed once", async () => {
    lose("after");
    expect(await hub().answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    const restarted = hub();
    expect(await restarted.answer(auth, "ny-7", SHIP, "r2")).toMatchObject({ ok: true, duplicate: true, at: T0 + 7 });
    expect(taps(pc)).toBe(1);
    expect(decisions()).toBe(1);
  });
});

// Follow-up B: the row is written before the answer is typed, as a send's is, so a hub that stops between the paste and
// the node's answer leaves it "started" with no store. Its repeat then can't be vouched for by an unknown from any store.
describe("a hub that stopped while typing an answer", () => {
  it("the agent's database lost meanwhile: the restarted hub's repeat is uncertain, typed once", async () => {
    let answered = () => {};
    rig.fleet.intercept("pane.send", async (_call, next) => {           // pasted; the answer never comes back to this hub
      await next();
      await new Promise<void>(r => { answered = r; });
      return LOST;
    });
    const crashed = hub().answer(auth, "ny-7", SHIP, "r1");             // the hub dies while waiting: never awaited
    await until(() => taps(pc) === 1);
    rig.fleet.intercept("pane.send", null);
    rig.fleet.node("pc").resetStore();                                 // and the agent's database is lost: its keys gone
    const restarted = hub();                                           // a new service on the same database
    expect(await restarted.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });   // Check again
    expect(await restarted.answer(auth, "ny-7", SHIP, "r2")).toMatchObject({ ok: false, problem: "uncertain" });   // a new tap
    expect(taps(pc)).toBe(1);
    expect(decisions()).toBe(0);
    // What kept it: the row the dead hub wrote before typing, with no store (no answer ever came to it).
    expect(row()).toEqual([{ key: KEY, state: "started", workerId: PC0, request: "ep1:r1", store: null }]);
    answered();                                                        // let the stand-in end (the dead hub's promise)
    await crashed;
  });
  it("the node typed it: the restarted hub's repeat finds it done there, a duplicate, recorded once", async () => {
    let answered = () => {};
    rig.fleet.intercept("pane.send", async (_call, next) => { await next(); await new Promise<void>(r => { answered = r; }); return LOST; });
    const crashed = hub().answer(auth, "ny-7", SHIP, "r1");
    await until(() => taps(pc) === 1);
    rig.fleet.intercept("pane.send", null);
    expect(await hub().answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: true, duplicate: true, at: T0 + 7 });
    expect(taps(pc)).toBe(1);
    expect(decisions()).toBe(1);
    answered();
    await crashed;
  });
});

describe("the manager's name moved to another window (a conflict resolved by a rename)", () => {
  it("the repeat asks the node the answer went to: typed there, so a duplicate, and never typed into the new manager", async () => {
    const s = hub();
    lose("after");
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    box.panes["%0"] = { name: "manager", cwd: "/w/manager", screen: "❯ " };
    manager = BOX0;                                                    // the name now points at box's window
    await rig.ports.tmux.listWorkers();
    s.poll();
    expect(await s.answer(auth, "ny-7", SHIP, "r2")).toMatchObject({ ok: true, duplicate: true });
    expect(taps(pc)).toBe(1);
    expect(taps(box)).toBe(0);
    expect(statusCalls().map(c => c.node)).toEqual(["pc"]);
  });
});

// Final review M1: a refusal that says nothing ran is not in doubt: a refusal, no row, and the same tap types once its
// cause is fixed.
describe("a definite refusal of an answer", () => {
  it("denied (a policy without pane.send): a refusal, no row; once allowed, the same request types once", async () => {
    const s = hub();
    rig.fleet.intercept("pane.send", async () => refusal("denied"));
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "denied" });
    expect(row()).toEqual([]);
    rig.fleet.intercept("pane.send", null);
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: true });
    expect(taps(pc)).toBe(1);
    expect(decisions()).toBe(1);
  });
  it("internal with executed no (a full disk before keys.start): a refusal, no row; the same request types once", async () => {
    const s = hub();
    rig.fleet.intercept("pane.send", async () => ({ ok: false, error: { code: "internal", executed: "no", message: "keys.start: disk full" } }));
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "internal" });
    expect(row()).toEqual([]);
    rig.fleet.intercept("pane.send", null);
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: true });
    expect(taps(pc)).toBe(1);
  });
});

// ADR-0008: a refusal after the paste ("not_submitted") keeps the request's row, so any repeat is uncertain and nothing is
// typed again, as a send's is (steering-durable.test.ts).
describe("an answer pasted but not submitted", () => {
  it("not_submitted keeps its row: a repeat of the same option is uncertain, the port is asked once, no second Decision (ADR-0008)", async () => {
    const s = hub();
    pc.panes["%0"]!.problem = "not_submitted";                         // the paste lands, the Enter does not
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "not_submitted" });
    expect(row()).toMatchObject([{ key: KEY, state: "started", workerId: PC0 }]);
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });   // Check again
    expect(await s.answer(auth, "ny-7", SHIP, "r2")).toMatchObject({ ok: false, problem: "uncertain" });   // a new tap
    expect(rig.fleet.calls.filter(c => c.op === "pane.send")).toHaveLength(1);
    expect(taps(pc)).toBe(1);
    expect(decisions()).toBe(0);
  });
});

// ADR-0008 phase C: a throw while typing may come after the paste, so the legacy hub keeps the answer's row too: the first
// attempt is 409 uncertain, and every repeat (the same request, or a new tap of the same choice) is uncertain, never typed
// twice. The legacy port has no keys, so nobody can say it wasn't typed.
describe("the legacy hub", () => {
  it("a throw while typing keeps its row: uncertain, and a repeat is uncertain, never typed twice (ADR-0008)", async () => {
    let calls = 0;
    const ports = await portsFor("legacy", {
      tmux: {
        listWorkers: async () => [{ id: "%0", name: "manager", location: "manager", node: "local", offline: false }],
        capture: async () => "❯ ", captureMany: async ids => new Map(ids.map(id => [id, "❯ "])),
        send: async () => { if (calls++ === 0) throw new Error("tmux exited 1"); return { problem: null, typedAt: T0 }; },
      },
    });
    const s = escalationsFor(ports, {
      store, now: () => T0, ledger: ledgerReader(ledgerPath, () => T0),
      watch: { workers: () => [{ id: "%0", name: "manager" }], history: () => [asked], openQuestions: () => [], screen: () => undefined },
    });
    s.poll();
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    expect(row()).toEqual([{ key: KEY, state: "started", workerId: "%0", request: "ep1:r1", store: null }]);
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });   // Check again
    expect(await s.answer(auth, "ny-7", SHIP, "r2")).toMatchObject({ ok: false, problem: "uncertain" });   // a new tap
    expect(calls).toBe(1);
    expect(decisions()).toBe(0);
  });
});

// E8 while an answer is in doubt (V7/V8): another choice for the same ask, under a new request, is never typed while the
// first may have been; the first is settled with its node before anything else (ADR-0012 decision 7).
describe("another answer to the same ask while one is in doubt", () => {
  const HOLD = { kind: "option", key: "hold" } as const;
  const HOLD_TAP = "[tap ny-7] hold (Hold for a day)";
  it("the first was typed there: the second is refused as a second answer, the first recorded once, nothing typed again", async () => {
    const s = hub();
    lose("after");
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    expect(await s.answer(auth, "ny-7", HOLD, "r2")).toMatchObject({ ok: false, problem: "already_answered" });
    expect(pc.typed.map(t => t.text)).toEqual([TAP]);
    expect(decisions()).toBe(1);
    expect(s.board().items.find(i => i.id === "ny-7")?.decision?.choice).toEqual({ kind: "option", key: "ship", label: "Ship it" });
  });
  it("the first in words, typed there: other words are refused, the first recorded as words", async () => {
    const s = hub();
    lose("after");
    expect(await s.answer(auth, "ny-7", { kind: "words", text: "Ship to staging only" }, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    expect(await s.answer(auth, "ny-7", { kind: "words", text: "Hold it for a day" }, "r2")).toMatchObject({ ok: false, problem: "already_answered" });
    expect(pc.typed.map(t => t.text)).toEqual(["About ny-7: Ship to staging only"]);
    expect(decisions()).toBe(1);
  });
  it("nobody can say whether the first was typed (the agent's database reset): the second is refused as in doubt, nothing typed", async () => {
    const s = hub();
    lose("after");
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    rig.fleet.node("pc").resetStore();
    expect(await s.answer(auth, "ny-7", HOLD, "r2")).toMatchObject({ ok: false, problem: "answer_in_doubt" });
    expect(pc.typed.map(t => t.text)).toEqual([TAP]);
    expect(decisions()).toBe(0);
  });
  it("the first never reached its node (unknown from its store): its row goes, and the second is typed once (retries still work)", async () => {
    const s = hub();
    lose("before");
    expect(await s.answer(auth, "ny-7", SHIP, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    expect(await s.answer(auth, "ny-7", HOLD, "r2")).toMatchObject({ ok: true });
    expect(pc.typed.map(t => t.text)).toEqual([HOLD_TAP]);
    expect(decisions()).toBe(1);
  });
});
