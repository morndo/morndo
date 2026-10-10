// Decisions for the manager through its inbox (ADR-0010): queued at once, recorded only when the inbox reports them in
// the manager's conversation, never typed by the hub; the inbox switched off falls back to typing, as before.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId, type Message } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { managerInbox, inboxKey, SENDER } from "../src/adapters/manager-inbox.ts";
import { EscalationService, type Watch } from "../src/application/escalation-service.ts";
import type { Authenticated } from "../src/application/access-service.ts";

const T0 = Date.UTC(2026, 9, 4, 14);
const MIN = 60_000;
let now = T0;
let dir: string, inboxDir: string, store: Store, ledgerPath: string;
let sent: { pane: string; text: string }[];
let manager: Message[];

const auth = (): Authenticated => ({
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: now, lastSeenAt: now, verifiedAt: now, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Phone", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: now, revokedAt: null },
});
const agent = (id: string, at: number, text: string): Message => ({ id, at, author: { kind: "agent", name: "manager" }, kind: "text", text });
const principal = (id: string, at: number, text: string): Message => ({ id, at, author: { kind: "principal", name: "You" }, kind: "text", text });
const watch: Watch = { workers: () => [{ id: "%0", name: "manager" }], history: id => (id === "%0" ? manager : []), openQuestions: () => [], screen: () => undefined };
const service = (inbox = true) => new EscalationService({
  watch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
  send: async (pane, text) => { sent.push({ pane, text }); return { problem: null, typedAt: now }; },
  inbox: inbox ? managerInbox(inboxDir, () => now) : null,
});
// The deliverer's side of the contract: it alone writes state/<key>.json.
const deliverer = (key: string, state: Record<string, unknown>) => {
  mkdirSync(join(inboxDir, "state"), { recursive: true });
  writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ v: 1, key, attempts: 1, updatedAt: now, ...state }));
};
const queuedMessages = () => readdirSync(join(inboxDir, "msg")).map(f => JSON.parse(readFileSync(join(inboxDir, "msg", f), "utf8")));
const answers = () => store.auditOf("EscalationAnswered", 0);

beforeEach(() => {
  now = T0;
  dir = mkdtempSync(join(tmpdir(), "morndo-inbox-"));
  inboxDir = join(dir, "manager-inbox");
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: now }));   // a deliverer runs
  store = new Store(dir);
  ledgerPath = join(dir, "ledger.json");
  sent = [];
  manager = [agent("m1", T0 - MIN, "Ready to go live.\n\n[buttons ny-176] deploy-morndo=Go live after the review | hold=Hold")];
  writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-176", kind: "tap", question: "Deploy Morndo?" }, { id: "ny-175", kind: "words", question: "The rewrite?" }], needsYouClosed: [] }));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("a decision for the manager goes into its inbox", () => {
  it("queued at once: one message in the inbox with the exact tap line, nothing typed, nothing recorded yet", async () => {
    const s = service();
    s.poll();
    const r = await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1");
    expect(r.ok).toBe(true);
    expect(sent).toEqual([]);
    const [m] = queuedMessages();
    expect(m).toMatchObject({ v: 1, sender: SENDER, kind: "tap", text: "[tap ny-176] deploy-morndo (Go live after the review)", key: inboxKey(SENDER, "answer:s1:req-1") });
    expect(r.item).toMatchObject({ status: "answered", decision: { via: "here", delivery: { state: "queued", at: null } }, inbox: { status: "queued", reason: null } });
    expect(answers()).toEqual([]);
  });

  it("a second answer while it waits is refused (E8) and queues nothing; the same request again is not a second answer", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1");
    expect((await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1")).ok).toBe(true);
    expect(await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-2")).toMatchObject({ ok: false, problem: "already_answered" });
    expect(queuedMessages()).toHaveLength(1);
  });

  it("while it waits, the inbox's reason shows; delivered, it is recorded with the time it reached the manager", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1");
    const key = queuedMessages()[0].key as string;
    deliverer(key, { status: "held", reason: "foreign_text" });
    now += MIN; s.poll();
    expect(s.board().items.find(i => i.id === "ny-176")?.inbox).toEqual({ status: "held", reason: "foreign_text" });
    deliverer(key, { status: "delivered", deliveredAt: now + 5_000 });
    now += MIN; s.poll();
    const item = s.board().items.find(i => i.id === "ny-176");
    expect(item).toMatchObject({ status: "answered", decision: { delivery: { state: "delivered", at: T0 + MIN + 5_000 } }, inbox: null });
    expect(answers()).toEqual([expect.objectContaining({ escalationId: "ny-176", choice: { kind: "option", key: "deploy-morndo", label: "Go live after the review" }, endpointId: "ep1", sessionId: "s1", at: T0 + MIN + 5_000 })]);
  });

  it("the tap showing in the manager's conversation before the inbox says so is still this endpoint's decision, recorded once", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1");
    manager.push(principal("u1", now + 2_000, "[tap ny-176] deploy-morndo (Go live after the review)"));
    now += 3_000; s.poll();
    expect(s.board().items.find(i => i.id === "ny-176")?.decision).toMatchObject({ via: "here", delivery: { state: "queued" } });
    deliverer(queuedMessages()[0].key, { status: "delivered", deliveredAt: now });
    s.poll(); s.poll();
    expect(answers()).toHaveLength(1);
  });

  it("words go as 'About <id>: …'; the record keeps their length and hash only", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-175", { kind: "words", text: "The rewrite is Quinn's task" }, "req-3");
    const [m] = queuedMessages();
    expect(m).toMatchObject({ kind: "answer", text: "About ny-175: The rewrite is Quinn's task" });
    deliverer(m.key, { status: "delivered", deliveredAt: now });
    s.poll();
    const body = JSON.stringify(answers());
    expect(body).toContain('"length":27');
    expect(body).not.toContain("Quinn");
  });

  it("the inbox gives it up (expired or cancelled by hand): the ask is open again, nothing recorded", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    deliverer(queuedMessages()[0].key, { status: "cancelled" });
    s.poll();
    expect(s.board().items.find(i => i.id === "ny-176")).toMatchObject({ status: "open", decision: null, answerable: null, inbox: null });
    expect(answers()).toEqual([]);
  });

  it("a hub restart keeps waiting for it, and records it once delivered", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1");
    const key = queuedMessages()[0].key;
    const again = service();
    again.poll();
    expect(again.board().items.find(i => i.id === "ny-176")).toMatchObject({ status: "answered", inbox: { status: "queued" } });
    deliverer(key, { status: "delivered", deliveredAt: now });
    again.poll();
    expect(answers()).toHaveLength(1);
  });

  it("a manager that isn't running right now: still queued (the inbox types it when it is back)", async () => {
    const s = new EscalationService({
      watch: { ...watch, workers: () => [] }, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => ({ problem: "no_pane" as const, typedAt: now }), inbox: managerInbox(inboxDir, () => now),
    });
    s.poll();
    expect((await s.answer(auth(), "ny-175", { kind: "words", text: "yes" }, "r")).ok).toBe(true);
    expect(queuedMessages()).toHaveLength(1);
  });

  it("a restart without MORNDO_MANAGER_INBOX keeps reading the inbox the answer went to, and records it once delivered (B6, option b)", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1");
    const key = queuedMessages()[0].key as string;
    store.close(); store = new Store(dir);
    const again = service(false);                     // the inbox is not configured any more
    again.poll();
    expect(again.board().items.find(i => i.id === "ny-176")).toMatchObject({ status: "answered", decision: { delivery: { state: "queued" } } });
    deliverer(key, { status: "delivered", deliveredAt: now + 1_000 });
    now += MIN; again.poll();
    expect(again.board().items.find(i => i.id === "ny-176")?.decision?.delivery).toEqual({ state: "delivered", at: now - MIN + 1_000 });
    expect(answers()).toHaveLength(1);
  });

  it("asked again while queued: the answer is withdrawn (ctl cancel); typed anyway (too late), its echo doesn't answer the new ask (B1)", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1");
    const key = queuedMessages()[0].key as string;
    now += MIN;
    manager.push(agent("m2", now, "Restated: still go live today?\n\n[buttons ny-176] deploy-morndo=Go live after the review | hold=Hold"));
    now += 1_000; s.poll();
    expect(readdirSync(join(inboxDir, "ctl"))).toEqual([`${key}.cancel`]);
    manager.push(principal("u-late", now + 500, "[tap ny-176] deploy-morndo (Go live after the review)"));   // already typed
    deliverer(key, { status: "delivered", deliveredAt: now + 500 });
    now += MIN; s.poll();
    expect(s.board().items.find(i => i.id === "ny-176")).toMatchObject({ status: "open", decision: null, answerable: null });
    store.close(); store = new Store(dir);
    const again = service();                          // and after a restart, while the echo is in the history
    again.poll();
    expect(again.board().items.find(i => i.id === "ny-176")).toMatchObject({ status: "open", decision: null });
  });

  // Review of the fix round, H1: the echo filter took every tap with the withdrawn line's text as its echo, so a later
  // genuine tap of the same option (another endpoint, Telegram) never answered the new ask.
  const restatedAndWithdrawn = async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1");
    const key = queuedMessages()[0].key as string;
    now += MIN;
    manager.push(agent("m2", now, "Restated: still go live today?\n\n[buttons ny-176] deploy-morndo=Go live after the review | hold=Hold"));
    now += 1_000; s.poll();
    expect(readdirSync(join(inboxDir, "ctl"))).toEqual([`${key}.cancel`]);
    return { s, key };
  };
  const tapLine = "[tap ny-176] deploy-morndo (Go live after the review)";

  it("after a withdrawn answer's echo, a genuine tap of the same option answers the new ask (H1)", async () => {
    const { s, key } = await restatedAndWithdrawn();
    manager.push(principal("u-late", now + 500, tapLine));    // typed anyway (the cancel came too late): its echo
    deliverer(key, { status: "delivered", deliveredAt: now + 500 });
    now += MIN; s.poll();
    expect(s.board().items.find(i => i.id === "ny-176")).toMatchObject({ status: "open", decision: null });
    now += MIN;
    manager.push(principal("u-genuine", now, tapLine));      // then answered on another endpoint
    now += 1_000; s.poll();
    expect(s.board().items.find(i => i.id === "ny-176")).toMatchObject({ status: "answered", decision: { via: "elsewhere", choice: { key: "deploy-morndo" } } });
  });

  it("a withdrawn answer the inbox dropped before typing it has no echo: a later tap of the same option answers (H1)", async () => {
    const { s, key } = await restatedAndWithdrawn();
    deliverer(key, { status: "cancelled", attempts: 0 });   // the cancel came in time: never pasted
    now += MIN; s.poll();
    manager.push(principal("u-genuine", now, tapLine));
    now += 1_000; s.poll();
    expect(s.board().items.find(i => i.id === "ny-176")).toMatchObject({ status: "answered", decision: { via: "elsewhere", choice: { key: "deploy-morndo" } } });
  });

  it("an ask settled on the list while its answer waits in the inbox: the answer is withdrawn (H2)", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1");
    const key = queuedMessages()[0].key as string;
    now += MIN;
    writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-176", kind: "tap", question: "Deploy Morndo?", status: "closed", answer: "Deployed by hand",
      closedAt: new Date(now).toISOString() }, { id: "ny-175", kind: "words", question: "The rewrite?" }], needsYouClosed: [] }));
    now += 1_000; s.poll();
    expect(s.board().items.find(i => i.id === "ny-176")?.status).toBe("settled");
    expect(readdirSync(join(inboxDir, "ctl"))).toEqual([`${key}.cancel`]);
  });

  it("the inbox the answer went to is gone: no verdict for a moment, but not 'queued' forever (H3)", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1");
    rmSync(inboxDir, { recursive: true, force: true });      // moved or deleted
    now += 10_000; s.poll();
    expect(s.board().items.find(i => i.id === "ny-176")).toMatchObject({ status: "answered", answerable: "already_answered" });   // a blip: wait
    for (let i = 0; i < 12; i++) { now += 2 * MIN; s.poll(); }
    expect(s.board().items.find(i => i.id === "ny-176")).toMatchObject({ status: "open", decision: null, answerable: null });
    expect(answers()).toEqual([]);
  });

  it("an answer queued before pending_answers, the hub restarted without an inbox: not 'queued' forever (H4)", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1");
    const key = queuedMessages()[0].key as string;
    const stored = store.decisions().find(d => d.id === "ny-176")!.decision as object;
    store.dropPending(key);
    store.saveDecision("ny-176", { ...stored, inbox: key, words: {} });   // the row as the hub kept it before migration 8
    s.stop();
    store.close(); store = new Store(dir);
    const again = service(false);                     // no inbox configured: where it went is unknown
    again.poll();
    expect(again.board().items.find(i => i.id === "ny-176")).toMatchObject({ status: "answered", answerable: "already_answered" });
    for (let i = 0; i < 12; i++) { now += 2 * MIN; again.poll(); }
    expect(again.board().items.find(i => i.id === "ny-176")).toMatchObject({ status: "open", decision: null, answerable: null });
  });

  it("the kill switch (`manager-inbox disable`): typed directly and recorded at once, as before the inbox", async () => {
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(join(inboxDir, "disabled"), "");
    const s = service();
    s.poll();
    expect((await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1")).ok).toBe(true);
    expect(sent).toEqual([{ pane: "%0", text: "[tap ny-176] hold (Hold)" }]);
    expect(answers()).toHaveLength(1);
  });
});
