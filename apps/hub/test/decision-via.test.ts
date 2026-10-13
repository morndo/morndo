// The via of an answer is per client: the hub records which endpoint accepted it (the Decision's endpointId), and each
// connected device reads "here" only for its own answer, "elsewhere" for anyone else's, and no via at all when the
// record can no longer say whose it was. Two paired devices on real feeds, and a restored row from before endpoints
// were kept. The manager's tap typed by hand stays elsewhere for everyone, as it always was.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endpointId, sessionId, type Message } from "@morndo/domain";
import type { WebSocket } from "ws";
import { ORIGIN, startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import { frameText } from "./http-crash-fixture.ts";
import { Store } from "../src/adapters/store.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { EscalationService, answerKey, type Watch } from "../src/application/escalation-service.ts";
import { SendInDoubt } from "../src/application/ports.ts";
import type { Authenticated } from "../src/application/access-service.ts";

const NOW = new Date(2026, 9, 1, 12).getTime();
const T0 = Date.UTC(2026, 9, 1, 8);
const MIN = 60_000;
const doc = readFileSync(new URL("../../../docs/agents/decision-requests.md", import.meta.url), "utf8");
const example = () => {
  const at = doc.indexOf("## An example");
  const open = doc.indexOf("```markdown\n", at);
  const close = doc.indexOf("\n```", open + 12);
  return doc.slice(open + "```markdown\n".length, close + 1);
};

let now = NOW;
let hub: InProcessHub;
const history: Message[] = [];
const watch: Watch = { workers: () => [{ id: "%1", name: "manager" }], history: () => history, openQuestions: () => [], screen: () => undefined };

// Every frame the socket gets, in order, as { t, … } (feed-fleet.test.ts).
function frames(ws: WebSocket) {
  const got: Record<string, unknown>[] = [];
  ws.on("message", raw => { got.push(JSON.parse(frameText(raw)) as Record<string, unknown>); });
  return got;
}
type WireItem = { id: string; status: string; version: string; decision: { via?: string } | null };
const decisions = (got: Record<string, unknown>[]) => got.filter(f => f.t === "decisions").flatMap(f => (f as { items: WireItem[] }).items);
const viaOf = (got: Record<string, unknown>[], id: string) => decisions(got).filter(i => i.id === id).at(-1)?.decision?.via ?? "not answered";
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise(r => setTimeout(r, 10)); expect(ok()).toBe(true); };

const boardOf = async (cookie: string) =>
  (await (await fetch(`${hub.base}/api/escalations`, { headers: { cookie: `__Host-morndo=${cookie}`, origin: ORIGIN } })).json()) as { items: WireItem[] };
async function fileBrief() {
  const token = hub.agents.issue("manager", "manager").secret;
  const filed = await fetch(`${hub.base}/api/agent/decisions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/markdown" },
    body: example(),
  });
  expect(filed.status).toBe(201);
  hub.escalations.poll();
}

describe("the via of an answer, per client", () => {
  afterEach(async () => { history.splice(0); await hub?.close(); });

  it("the device whose request accepted the answer reads here; every other device reads elsewhere", async () => {
    now = NOW;
    hub = await startInProcessHub({ now: () => now, watch });
    await fileBrief();
    const desk = await hub.cookie();                       // two paired devices on two feeds
    const phone = await hub.cookie();
    const wsDesk = await hub.socket("/api/feed", desk);
    const wsPhone = await hub.socket("/api/feed", phone);
    const deskFrames = frames(wsDesk), phoneFrames = frames(wsPhone);
    wsDesk.send(JSON.stringify({ t: "hello" }));
    wsPhone.send(JSON.stringify({ t: "hello" }));
    await until(() => decisions(deskFrames).some(i => i.id === "d-1"));
    const phoneBoard = await boardOf(phone);
    const answered = await hub.post("/api/escalations/d-1/answer",
      { key: "b", requestId: randomUUID(), seen: phoneBoard.items.find(i => i.id === "d-1")?.version ?? "" },
      { cookie: `__Host-morndo=${phone}` });                // answered from the phone
    expect(answered.status).toBe(200);
    await until(() => viaOf(phoneFrames, "d-1") !== "not answered");
    expect(viaOf(phoneFrames, "d-1")).toBe("here");
    await until(() => viaOf(deskFrames, "d-1") !== "not answered");
    expect(viaOf(deskFrames, "d-1")).toBe("elsewhere");
    // The same split over HTTP, each device's own board.
    expect((await boardOf(desk)).items.find(i => i.id === "d-1")?.decision?.via).toBe("elsewhere");
    expect((await boardOf(phone)).items.find(i => i.id === "d-1")?.decision?.via).toBe("here");
    wsDesk.close();
    wsPhone.close();
  });

  it("a tap typed by hand at the asker's end is elsewhere for every device", async () => {
    now = NOW;
    hub = await startInProcessHub({ now: () => now, watch });
    await fileBrief();
    const desk = await hub.cookie();
    const phone = await hub.cookie();
    const wsDesk = await hub.socket("/api/feed", desk);
    const wsPhone = await hub.socket("/api/feed", phone);
    const deskFrames = frames(wsDesk), phoneFrames = frames(wsPhone);
    wsDesk.send(JSON.stringify({ t: "hello" }));
    wsPhone.send(JSON.stringify({ t: "hello" }));
    await until(() => decisions(deskFrames).some(i => i.id === "d-1"));
    history.push({ id: "m-tap", at: now, author: { kind: "principal", name: "You" }, kind: "text", text: "[tap d-1] b (Extend the triage script)" });
    hub.escalations.poll();
    await until(() => viaOf(deskFrames, "d-1") !== "not answered");
    expect(viaOf(deskFrames, "d-1")).toBe("elsewhere");
    expect(viaOf(phoneFrames, "d-1")).toBe("elsewhere");
    wsDesk.close();
    wsPhone.close();
  });
});

// A Decision row from before endpoints were kept: the hub knows it took the answer (its record says "here") but no
// longer for which client, so no device may claim it. The record itself is unchanged.
describe("a Decision the record can no longer attribute", () => {
  let dir: string, store: Store, ledgerPath: string;
  let manager: Message[];
  const aManager = (): Message[] => [{
    id: "m1", at: T0 - MIN, author: { kind: "agent", name: "manager" }, kind: "text",
    text: "The demo release is ready. CI is green.\n\n[buttons ny-7] ship=Ship it | hold=Hold for a day",
  }];
  const ledgerWatch: Watch = { workers: () => [{ id: "%0", name: "manager" }], history: id => (id === "%0" ? manager : []), openQuestions: () => [], screen: () => undefined };
  const auth = (name: string): Authenticated => ({
    session: { id: sessionId("s1"), endpointId: endpointId(name), startedAt: now, lastSeenAt: now, verifiedAt: now, endedAt: null, endReason: null },
    endpoint: { id: endpointId(name), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: now, revokedAt: null },
  });

  beforeEach(() => {
    now = T0;
    manager = aManager();
    dir = mkdtempSync(join(tmpdir(), "morndo-via-"));
    store = new Store(dir);
    ledgerPath = join(dir, "ledger.json");
    writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-7", kind: "tap", question: "Ship the demo release tonight?", default: "hold" }], needsYouClosed: [] }));
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  it("reads as absent for every device, and the stored record keeps its own word", () => {
    store.saveDecision("ny-7", { choice: { kind: "option", key: "ship", label: "Ship it" }, at: T0, via: "here", endpointId: null, sessionId: null });
    const s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => ({ problem: null, typedAt: 0 }),
    });
    s.poll();
    expect(s.board().items.find(i => i.id === "ny-7")?.decision?.via).toBe("here");          // the record as kept
    expect(s.seenBy(endpointId("ep1")).items.find(i => i.id === "ny-7")?.decision?.via).toBeUndefined();
    expect(s.seenBy(endpointId("ep2")).items.find(i => i.id === "ny-7")?.decision?.via).toBeUndefined();
  });

  it("the answer the device itself accepted reads here, in the answer's own reply and on its board", async () => {
    const s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => ({ problem: null, typedAt: 0 }),
    });
    s.poll();
    const r = await s.answer(auth("ep2"), "ny-7", { kind: "option", key: "hold" }, randomUUID());
    expect(r.ok).toBe(true);
    expect(r.item?.decision?.via).toBe("here");                                              // the endpoint that answered
    expect(s.seenBy(endpointId("ep1")).items.find(i => i.id === "ny-7")?.decision?.via).toBe("elsewhere");
    expect(s.seenBy(endpointId("ep2")).items.find(i => i.id === "ny-7")?.decision?.via).toBe("here");
  });

  // The direct (non-inbox) path's race (review of PR #55): the hub has typed its own tap into the manager's pane, and a
  // poll reads it in the manager's conversation while the send is still in flight — before #delivered records the
  // answer. That sighting must not settle the Decision as "elsewhere" with no endpoint: the endpoint whose request
  // typed it is recorded, and it reads "here".
  it("the hub's own typed tap, seen in the manager's history before the answer is recorded, stays the answering endpoint's", async () => {
    let s: EscalationService;
    const send = async (_pane: string, text: string) => {
      manager.push({ id: "m-tap", at: now, author: { kind: "principal", name: "You" }, kind: "text", text });   // the pane has the tap
      s.poll();                                                                                                  // the hub's own poll reads it first
      return { problem: null, typedAt: 0 };
    };
    s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now, send,
    });
    s.poll();
    const r = await s.answer(auth("ep2"), "ny-7", { kind: "option", key: "hold" }, randomUUID());
    expect(r.ok).toBe(true);
    expect(r.item?.decision?.via).toBe("here");                                              // not "elsewhere": this endpoint's answer
    expect(s.seenBy(endpointId("ep2")).items.find(i => i.id === "ny-7")?.decision?.via).toBe("here");
    expect(s.seenBy(endpointId("ep1")).items.find(i => i.id === "ny-7")?.decision?.via).toBe("elsewhere");
    expect(s.board().items.find(i => i.id === "ny-7")?.decision?.endpointId).toBe(endpointId("ep2"));   // recorded, not just said
    s.poll();                                                                                // the tap line stays in the history
    expect(s.seenBy(endpointId("ep2")).items.find(i => i.id === "ny-7")?.decision?.via).toBe("here");
  });

  // The hub's own answer in flight hides only its own paste (round 3.1): a tap from elsewhere that the hub has not read
  // yet when an answer arrives is still read by that answer's own poll, and refuses it (E8). Before, every tap of the
  // ask was hidden while any answer to it was in flight, so a second answer was typed after a hand's.
  it("a tap from elsewhere, read while an answer is in flight, refuses that answer", async () => {
    const typed: string[] = [];
    const s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async (_pane, text) => { typed.push(text); return { problem: null, typedAt: 0 }; },
    });
    s.poll();
    manager.push({ id: "m-tap", at: now, author: { kind: "principal", name: "You" }, kind: "text", text: "[tap ny-7] ship (Ship it)" });   // by hand, not polled yet
    const r = await s.answer(auth("phone"), "ny-7", { kind: "option", key: "hold" }, "r1");
    expect(r).toMatchObject({ ok: false, problem: "already_answered" });
    expect(typed).toEqual([]);                                                                   // nothing typed after the hand's tap
    expect(s.board().items.find(i => i.id === "ny-7")?.decision).toMatchObject({ choice: { key: "ship" }, via: "elsewhere" });
  });

  // An answer in doubt that its node typed after all, learnt while another endpoint answers the same ask otherwise
  // (review of PR #55): the Decision is the endpoint that typed it — the row in doubt names it — not the endpoint whose
  // answer happened to settle the question.
  it("an answer in doubt, typed by one device and learnt from another's answer, is recorded as the device that typed it", async () => {
    const s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => { throw new Error("the connection was lost while typing"); },            // in doubt: typed at the node
      settle: async () => ({ ok: false, problem: "duplicate", at: now + 7 }),                     // its node typed it after all
    });
    s.poll();
    expect(await s.answer(auth("desk"), "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    expect(await s.answer(auth("phone"), "ny-7", { kind: "option", key: "hold" }, "r2")).toMatchObject({ ok: false, problem: "already_answered" });
    expect(s.seenBy(endpointId("desk")).items.find(i => i.id === "ny-7")?.decision?.via).toBe("here");    // it typed the answer
    expect(s.seenBy(endpointId("phone")).items.find(i => i.id === "ny-7")?.decision?.via).toBe("elsewhere");
    expect(s.board().items.find(i => i.id === "ny-7")?.decision?.endpointId).toBe(endpointId("desk"));
  });

  // An answer in doubt found by its answer key (review of PR #55): another endpoint taps the same choice, its repeat
  // settles the row with the node and learns it was typed there. The Decision is the row's own endpoint, whose answer
  // it was, not the endpoint whose repeat happened to learn it — and the repeat's caller is told as much (round 2.5):
  // its own answer was not delivered, so its result and its view agree (already answered, elsewhere), instead of a
  // duplicate of an answer that reads "here" for no one at that endpoint.
  it("an answer in doubt, settled by another endpoint's repeat of the same choice, is recorded as the endpoint that created it", async () => {
    const s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => { throw new Error("the connection was lost while typing"); },            // in doubt: typed at the node
      settle: async () => ({ ok: false, problem: "duplicate", at: now + 5 }),                     // its node typed it after all
    });
    s.poll();
    expect(await s.answer(auth("desk"), "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    const r = await s.answer(auth("phone"), "ny-7", { kind: "option", key: "ship" }, "r2");      // same choice: the same key
    expect(r).toMatchObject({ ok: false, problem: "already_answered" });
    expect(r.item?.decision?.via).toBe("elsewhere");                                             // as the phone reads it
    expect(s.seenBy(endpointId("desk")).items.find(i => i.id === "ny-7")?.decision?.via).toBe("here");    // its row, its answer
    expect(s.seenBy(endpointId("phone")).items.find(i => i.id === "ny-7")?.decision?.via).toBe("elsewhere");
    expect(s.board().items.find(i => i.id === "ny-7")?.decision?.endpointId).toBe(endpointId("desk"));
  });

  // The repeat's own request was not delivered (round 3.3): a retry of it, within the window a request is remembered,
  // is told the same — already answered — never ok, as if its own answer had gone through.
  it("a retry of a repeat that learnt another endpoint's answer is told it was answered elsewhere again", async () => {
    const s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => { throw new Error("the connection was lost while typing"); },            // in doubt: typed at the node
      settle: async () => ({ ok: false, problem: "duplicate", at: now + 5 }),                     // its node typed it after all
    });
    s.poll();
    expect(await s.answer(auth("desk"), "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    expect(await s.answer(auth("phone"), "ny-7", { kind: "option", key: "ship" }, "r2")).toMatchObject({ ok: false, problem: "already_answered" });
    const retry = await s.answer(auth("phone"), "ny-7", { kind: "option", key: "ship" }, "r2");  // the same request, retried
    expect(retry).toMatchObject({ ok: false, problem: "already_answered" });
    expect(retry.item?.decision?.via).toBe("elsewhere");
  });

  // The same rule for a row already done (round 3.4): the desk's answer was typed, its row done, and the hub stopped
  // before its Decision was saved, so the ask reads open. The phone's tap of the same choice finds that row: it was the
  // desk's answer, recorded for the desk, and the phone is told it was answered elsewhere — not that its own went
  // through — on the first try and on a retry.
  it("a done row of another endpoint's answer is that endpoint's Decision, not the caller's duplicate", async () => {
    store.db.prepare("INSERT INTO sends (key, state, at, outcome, typed_at, worker_id, request, request_session) VALUES (?, 'done', ?, 'typed', ?, '%0', ?, 's-desk')")
      .run(answerKey("ny-7", { messageId: "m1", askedAt: T0 - MIN }, { kind: "option", key: "ship" }), T0 - 1000, T0 - 900, "desk:r1");
    const s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => { throw new Error("not reached"); },
    });
    s.poll();
    expect(s.board().items.find(i => i.id === "ny-7")?.status).toBe("open");
    const r = await s.answer(auth("phone"), "ny-7", { kind: "option", key: "ship" }, "r2");
    expect(r).toMatchObject({ ok: false, problem: "already_answered" });
    expect(r.item?.decision?.via).toBe("elsewhere");
    expect(s.board().items.find(i => i.id === "ny-7")?.decision?.endpointId).toBe(endpointId("desk"));
    expect(s.seenBy(endpointId("desk")).items.find(i => i.id === "ny-7")?.decision?.via).toBe("here");
    expect(await s.answer(auth("phone"), "ny-7", { kind: "option", key: "ship" }, "r2")).toMatchObject({ ok: false, problem: "already_answered" });
  });

  // A tap the hub itself typed whose row nothing can settle (round 2.1): the port threw after the paste, the row keeps
  // "started" with no store, and this hub has no node to ask — no repeat can ever learn more, and no answer path is
  // left to record it. The tap in the pane is the ask's only record: it settles the ask, as it did before the pane-tap
  // filter, instead of the ask staying open with every answer refused for the row's 24 hours.
  it("the hub's own tap settles the ask when its row can never be settled", async () => {
    let s: EscalationService;
    const send = async () => {
      manager.push({ id: "m-tap", at: now, author: { kind: "principal", name: "You" }, kind: "text", text: "[tap ny-7] hold (Hold for a day)" });   // pasted; then the port threw
      throw new Error("the pane connection threw after the paste");
    };
    s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now, send,
    });
    s.poll();
    expect(await s.answer(auth("ep2"), "ny-7", { kind: "option", key: "hold" }, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    expect(store.send(answerKey("ny-7", { messageId: "m1", askedAt: T0 - MIN }, { kind: "option", key: "hold" })))
      .toMatchObject({ state: "started", store: null });                                        // nothing can settle it
    s.poll();                                                                                    // no answer in flight any more
    expect(s.board().items.find(i => i.id === "ny-7")?.status).toBe("answered");
    expect(s.seenBy(endpointId("ep2")).items.find(i => i.id === "ny-7")?.decision?.via).toBe("elsewhere");
  });

  // The same for a hub that stopped while typing (round 2.1): the row survives the restart "started", with no store,
  // nothing in flight, and the pane already holds the pasted tap.
  it("a tap left in the pane by a hub that stopped mid-type settles the ask", () => {
    store.db.prepare("INSERT INTO sends (key, state, at, worker_id) VALUES (?, 'started', ?, '%0')")
      .run(answerKey("ny-7", { messageId: "m1", askedAt: T0 - MIN }, { kind: "option", key: "ship" }), T0 - 1000);
    manager.push({ id: "m-tap", at: T0, author: { kind: "principal", name: "You" }, kind: "text", text: "[tap ny-7] ship (Ship it)" });
    const s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => ({ problem: null, typedAt: 0 }),
    });
    s.poll();
    expect(s.board().items.find(i => i.id === "ny-7")?.status).toBe("answered");
    expect(s.seenBy(endpointId("ep2")).items.find(i => i.id === "ny-7")?.decision?.via).toBe("elsewhere");
  });

  // The filter matches the ask's own version (round 2.2): an earlier version's row — kept its 24 hours after the ask
  // was asked again, so the old Decision no longer answers it (E11) — is not this ask's answer. A hand tap for the
  // restated ask settles it, as any tap from elsewhere does.
  it("a hand tap answers a restated ask even when an earlier version's row is kept", async () => {
    const s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => ({ problem: null, typedAt: 0 }),
    });
    s.poll();
    expect(await s.answer(auth("ep2"), "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: true });   // v1: answered, its row done
    manager.push({ id: "m2", at: T0, author: { kind: "agent", name: "manager" }, kind: "text",
      text: "The demo release is ready again, with the fix.\n\n[buttons ny-7] ship=Ship it | hold=Hold for a day" });
    s.poll();                                                                                                          // asked again: open, a new version
    expect(s.board().items.find(i => i.id === "ny-7")?.status).toBe("open");
    manager.push({ id: "m-tap", at: T0, author: { kind: "principal", name: "You" }, kind: "text", text: "[tap ny-7] ship (Ship it)" });
    s.poll();
    expect(s.board().items.find(i => i.id === "ny-7")?.status).toBe("answered");
    expect(s.seenBy(endpointId("ep2")).items.find(i => i.id === "ny-7")?.decision?.via).toBe("elsewhere");
  });

  // A row written after the tap is not the tap's source either (round 2.2): the row goes down before its own paste,
  // so a tap the hub read before it wrote the row was typed by a hand, and answers the ask. Which came first is the
  // hub's own order of what it read and wrote, never the transcript's time against the hub's (round 3.2). Here the
  // hand tap was read while an earlier row of the same choice still hid it; that row turns out never started, the
  // next answer's row goes down after the tap was read, in doubt with a store to ask, and the hand tap still wins.
  it("a hand tap the hub read before it wrote its own row still settles the ask", async () => {
    const k = answerKey("ny-7", { messageId: "m1", askedAt: T0 - MIN }, { kind: "option", key: "hold" });
    store.db.prepare("INSERT INTO sends (key, state, at, worker_id, request, node_store) VALUES (?, 'started', ?, '%0', ?, 'st-0')")
      .run(k, T0 - 1000, "desk:r0");                                                             // an earlier answer in doubt
    manager.push({ id: "m-tap", at: T0, author: { kind: "principal", name: "You" }, kind: "text", text: "[tap ny-7] hold (Hold for a day)" });
    const s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => { throw new SendInDoubt("st-1", "the node may have typed it"); },        // in doubt, with a store
      settle: async key => { store.dropSend(key); return null; },                                // the earlier one never started there
    });
    s.poll();                                                                                    // read now, hidden by the earlier row
    expect(s.board().items.find(i => i.id === "ny-7")?.status).toBe("open");
    expect(await s.answer(auth("ep2"), "ny-7", { kind: "option", key: "hold" }, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    s.poll();
    expect(s.board().items.find(i => i.id === "ny-7")?.status).toBe("answered");
    expect(s.seenBy(endpointId("ep2")).items.find(i => i.id === "ny-7")?.decision?.via).toBe("elsewhere");
  });

  // The hub's own paste is told by that order, not by clocks (round 3.2): the node that typed it stamps the line on
  // its own clock, here 1.5 s behind the hub's. Read after the hub wrote its row, it is that row's paste: no answer from
  // elsewhere, and the repeat that learns it was typed records it for the endpoint that sent it.
  it("the hub's own paste, stamped by a node whose clock runs behind, is not an answer from elsewhere", async () => {
    const s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async (_pane, text) => {
        manager.push({ id: "m-tap", at: now - 1500, author: { kind: "principal", name: "You" }, kind: "text", text });   // the node's clock
        throw new SendInDoubt("st-1", "the connection dropped after the paste");
      },
      settle: async () => ({ ok: false, problem: "duplicate", at: now - 1500 }),                 // typed there after all
    });
    s.poll();
    expect(await s.answer(auth("desk"), "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    s.poll();
    expect(s.board().items.find(i => i.id === "ny-7")?.status).toBe("open");                     // its own paste, not a tap from elsewhere
    expect(await s.answer(auth("desk"), "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: true, duplicate: true });
    expect(s.board().items.find(i => i.id === "ny-7")?.decision?.endpointId).toBe(endpointId("desk"));
    expect(s.seenBy(endpointId("desk")).items.find(i => i.id === "ny-7")?.decision?.via).toBe("here");
  });

  // A request's row belongs to the version it was written under (round 2.8). Asked again, a repeat of the same request
  // first learns what became of that earlier answer (round 3.5); its node never started it, so the same choice is a new
  // answer to the restated ask, typed again (the answer key's own rule).
  it("a repeat of its own request answers a restated ask anew once its earlier answer was never typed", async () => {
    let throws = true;
    const s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => { if (throws) throw new Error("lost while typing"); return { problem: null, typedAt: 0 }; },
      settle: async key => { store.dropSend(key); return null; },                                 // never started at its node
    });
    s.poll();
    expect(await s.answer(auth("ep2"), "ny-7", { kind: "option", key: "hold" }, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    manager.push({ id: "m2", at: T0, author: { kind: "agent", name: "manager" }, kind: "text",
      text: "The demo release is ready again, with the fix.\n\n[buttons ny-7] ship=Ship it | hold=Hold for a day" });
    s.poll();                                                                                      // asked again: open, a new version
    throws = false;
    const r = await s.answer(auth("ep2"), "ny-7", { kind: "option", key: "hold" }, "r1");          // the same request again
    expect(r).toMatchObject({ ok: true });
    expect(r.item?.decision?.via).toBe("here");                                                    // this version's own answer
  });

  // A retried request in doubt learns what became of its answer, whatever became of the ask since (round 3.5). Asked
  // again meanwhile: its node typed it, so the retry is told it went through (a duplicate), it is recorded as an answer
  // to the earlier version, and the restated ask stays open — that answer never answers a question he didn't see (E11).
  it("a retried request in doubt settles its answer when the ask was restated since", async () => {
    const typed: string[] = [];
    const s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async (_pane, text) => {
        typed.push(text);
        if (typed.length === 1) throw new Error("lost while typing");
        return { problem: null, typedAt: 0 };
      },
      settle: async () => ({ ok: false, problem: "duplicate", at: now + 5 }),                       // its node typed it
    });
    s.poll();
    expect(await s.answer(auth("desk"), "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    manager.push({ id: "m2", at: T0, author: { kind: "agent", name: "manager" }, kind: "text",
      text: "The demo release is ready again, with the fix.\n\n[buttons ny-7] ship=Ship it | hold=Hold for a day" });
    s.poll();                                                                                       // asked again
    const r = await s.answer(auth("desk"), "ny-7", { kind: "option", key: "ship" }, "r1");          // the same request
    expect(r).toMatchObject({ ok: true, duplicate: true, at: now + 5 });
    expect(typed).toHaveLength(1);                                                                  // not typed again
    expect(s.board().items.find(i => i.id === "ny-7")).toMatchObject({ status: "open", decision: null });
    expect(store.audit().filter(e => e.type === "EscalationAnswered").map(e => e.body))
      .toEqual([expect.objectContaining({ escalationId: "ny-7", endpointId: "desk", choice: { kind: "option", key: "ship", label: "Ship it" } })]);
  });

  // And when the ask is gone from the board (settled and dropped since, or never sighted after a restart): the retry
  // still settles it with its node, is told it went through, and the answer is recorded for its endpoint.
  it("a retried request in doubt settles its answer when the ask is gone", async () => {
    store.db.prepare("INSERT INTO sends (key, state, at, worker_id, request, request_session, node_store) VALUES (?, 'started', ?, '%0', ?, 's1', 'st-1')")
      .run(answerKey("ny-7", { messageId: "m1", askedAt: T0 - MIN }, { kind: "option", key: "ship" }), T0 - 1000, "desk:r1");
    manager.splice(0);                                                                              // no buttons in view,
    writeFileSync(ledgerPath, JSON.stringify({ needsYou: [], needsYouClosed: [] }));                // and off the list
    const s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => { throw new Error("not reached"); },
      settle: async () => ({ ok: false, problem: "duplicate", at: now + 5 }),                       // its node typed it
    });
    s.poll();
    expect(s.board().items.find(i => i.id === "ny-7")).toBeUndefined();
    expect(await s.answer(auth("desk"), "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: true, duplicate: true, at: now + 5 });
    expect(store.audit().filter(e => e.type === "EscalationAnswered").map(e => e.body))
      .toEqual([expect.objectContaining({ escalationId: "ny-7", endpointId: "desk", sessionId: "s1" })]);
  });

  // A row from before requests were kept names no requester (round 2.3): its node typed the answer after all, learnt
  // from another endpoint's answer. The Decision is still recorded — under whoever's repeat learnt it, as before the
  // request column — so the ask closes. Without it, the same answer is refused as already answered for the row's 24
  // hours while the board keeps the ask open: it can never close.
  it("an answer found typed on a row that names no request is recorded under whoever learnt it", async () => {
    store.db.prepare("INSERT INTO sends (key, state, at, worker_id) VALUES (?, 'started', ?, '%0')")
      .run(answerKey("ny-7", { messageId: "m1", askedAt: T0 - MIN }, { kind: "option", key: "ship" }), T0 - 1000);
    const s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => { throw new Error("not reached"); },
      settle: async () => ({ ok: false, problem: "duplicate", at: now + 5 }),                    // its node typed it after all
    });
    s.poll();
    expect(await s.answer(auth("phone"), "ny-7", { kind: "option", key: "hold" }, "r2")).toMatchObject({ ok: false, problem: "already_answered" });
    expect(s.board().items.find(i => i.id === "ny-7")?.status).toBe("answered");
    expect(s.board().items.find(i => i.id === "ny-7")?.decision?.endpointId).toBe(endpointId("phone"));
    expect(s.seenBy(endpointId("phone")).items.find(i => i.id === "ny-7")?.decision?.via).toBe("here");
  });

  // The request names "<endpoint>:<request id>", and the part known to carry no colon is the request id (a uuid), not
  // the endpoint (round 2.6): a prefixed endpoint id with a colon of its own splits at the last colon, so the answer is
  // recorded for the endpoint that sent it and that endpoint reads "here", not a cut-off prefix no device owns.
  it("an answer on a row whose endpoint id carries a colon is recorded for that endpoint", async () => {
    store.db.prepare("INSERT INTO sends (key, state, at, worker_id, request) VALUES (?, 'started', ?, '%0', ?)")
      .run(answerKey("ny-7", { messageId: "m1", askedAt: T0 - MIN }, { kind: "option", key: "ship" }), T0 - 1000, "pair:ep9:r1");
    const s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => { throw new Error("not reached"); },
      settle: async () => ({ ok: false, problem: "duplicate", at: now + 5 }),                    // its node typed it after all
    });
    s.poll();
    expect(await s.answer(auth("phone"), "ny-7", { kind: "option", key: "hold" }, "r2")).toMatchObject({ ok: false, problem: "already_answered" });
    expect(s.board().items.find(i => i.id === "ny-7")?.decision?.endpointId).toBe(endpointId("pair:ep9"));
    expect(s.seenBy(endpointId("pair:ep9")).items.find(i => i.id === "ny-7")?.decision?.via).toBe("here");
  });

  // One read of the answer rows per poll, not one query per tap line (round 2.7): the pane keeps every tap of the
  // conversation in the window — dozens, across asks and versions — and each is judged against the same table. The
  // result is unchanged: ny-7's tap is its own answer's paste (the row, done, is this version's, written before it),
  // ny-8's tap is a hand's and settles the ask.
  it("judges every tap of a poll against one read of the answer rows", async () => {
    manager.push({ id: "m2", at: T0 - MIN / 2, author: { kind: "agent", name: "manager" }, kind: "text",
      text: "Another release is ready.\n\n[buttons ny-8] ship=Ship it | hold=Hold for a day" });
    manager.push({ id: "m-tap-1", at: T0 - 30_000, author: { kind: "principal", name: "You" }, kind: "text", text: "[tap ny-7] ship (Ship it)" });
    manager.push({ id: "m-tap-2", at: T0 - 20_000, author: { kind: "principal", name: "You" }, kind: "text", text: "[tap ny-8] hold (Hold for a day)" });
    const own = answerKey("ny-7", { messageId: "m1", askedAt: T0 - MIN }, { kind: "option", key: "ship" });
    store.startSend(own, T0 - 31_000);
    store.finishSend(own, T0 - 30_500);                                                          // its own answer's row, done
    const sends = vi.spyOn(store, "send");
    const ofAsk = vi.spyOn(store, "answersOfAsk");
    const s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => ({ problem: null, typedAt: 0 }),
    });
    s.poll();
    expect(s.board().items.find(i => i.id === "ny-7")?.status).toBe("open");                     // its own answer's paste
    expect(s.board().items.find(i => i.id === "ny-8")?.status).toBe("answered");                 // a hand's tap
    expect(sends).toHaveBeenCalledTimes(0);                                                      // no query per tap
    expect(ofAsk.mock.calls).toEqual([["answer:"]]);                                             // one read per poll, the store's own (round 3.8)
  });

  // And none when there is no tap to judge (round 3.7): a pane without a tap line reads no answer row at all.
  it("reads no answer rows in a poll that has no tap to judge", () => {
    const ofAsk = vi.spyOn(store, "answersOfAsk");
    const s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => ({ problem: null, typedAt: 0 }),
    });
    s.poll();
    expect(s.board().items.find(i => i.id === "ny-7")?.status).toBe("open");
    expect(ofAsk).toHaveBeenCalledTimes(0);
  });
});
