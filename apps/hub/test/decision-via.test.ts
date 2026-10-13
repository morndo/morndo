// The via of an answer is per client: the hub records which endpoint accepted it (the Decision's endpointId), and each
// connected device reads "here" only for its own answer, "elsewhere" for anyone else's, and no via at all when the
// record can no longer say whose it was. Two paired devices on real feeds, and a restored row from before endpoints
// were kept. The manager's tap typed by hand stays elsewhere for everyone, as it always was.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId, type Message } from "@morndo/domain";
import type { WebSocket } from "ws";
import { ORIGIN, startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import { frameText } from "./http-crash-fixture.ts";
import { Store } from "../src/adapters/store.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { EscalationService, type Watch } from "../src/application/escalation-service.ts";
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
  // it was, not the endpoint whose repeat happened to learn it.
  it("an answer in doubt, settled by another endpoint's repeat of the same choice, is recorded as the endpoint that created it", async () => {
    const s = new EscalationService({
      watch: ledgerWatch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => { throw new Error("the connection was lost while typing"); },            // in doubt: typed at the node
      settle: async () => ({ ok: false, problem: "duplicate", at: now + 5 }),                     // its node typed it after all
    });
    s.poll();
    expect(await s.answer(auth("desk"), "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: false, problem: "uncertain" });
    const r = await s.answer(auth("phone"), "ny-7", { kind: "option", key: "ship" }, "r2");      // same choice: the same key
    expect(r).toMatchObject({ ok: true, duplicate: true });
    expect(s.seenBy(endpointId("desk")).items.find(i => i.id === "ny-7")?.decision?.via).toBe("here");    // its row, its answer
    expect(s.seenBy(endpointId("phone")).items.find(i => i.id === "ny-7")?.decision?.via).toBe("elsewhere");
    expect(s.board().items.find(i => i.id === "ny-7")?.decision?.endpointId).toBe(endpointId("desk"));
  });
});
