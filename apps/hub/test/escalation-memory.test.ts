// A pending Memory Note as an Ask on the Decisions board (ADR-0031, docs/design/memory/README.md "App"; M4, M5, M8): what
// files an Ask (id mem-n-<k>), what the principal's answer in the app does under step-up (AC7), and what never happens
// (nothing typed, no queue, no code on this path). A real Store and MemoryStore in temp dirs, a controllable clock,
// synthetic notes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, isDeliverable, sessionId, type BoardActor, type Note } from "@morndo/domain";
import type { MemoryRememberBody } from "@morndo/protocol";
import { Store } from "../src/adapters/store.ts";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import { EscalationService, type Watch } from "../src/application/escalation-service.ts";
import { MemoryService, waitsForApproval } from "../src/application/memory-service.ts";
import { memoryAsk } from "../src/application/memory-asks.ts";
import type { Authenticated } from "../src/application/access-service.ts";

const T0 = Date.UTC(2026, 9, 20, 9);
let now = T0;
let dir: string;
let store: Store;
let memoryStore: MemoryStore;
let memory: MemoryService;
let sent: { pane: string; text: string }[];

const apiFix: BoardActor = { kind: "worker", name: "api-fix", token: "tok-w" };
const watch: Watch = { workers: () => [], history: () => [], openQuestions: () => [], screen: () => undefined };
// The port main.ts gives the escalation service: Memory is built after Decisions, so it arrives as a getter.
const asks = () => ({
  pending: () => memory.pendingApprovals(),
  decide: (a: Authenticated, id: string, d: "approve" | "reject") => memory.decide(a, id, d),
});
const service = (memoryPort: () => (ReturnType<typeof asks>) | null = asks) => new EscalationService({
  watch, ledger: null, store, managerName: "manager", now: () => now,
  send: async (pane, text) => { sent.push({ pane, text }); return { problem: null, typedAt: 0 }; },
  memory: memoryPort,
});

// The principal's signed-in Endpoint, as escalation-service.test.ts builds one. The policy is the default (a 1h step-up
// window), so `now - 2h` is a session that must verify again.
const auth = (verifiedAt = now): Authenticated => ({
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: verifiedAt, lastSeenAt: now, verifiedAt, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: now, revokedAt: null },
});
const body = (over: Partial<MemoryRememberBody> = {}): MemoryRememberBody =>
  ({ kind: "fact", scope: "repo:shop-api", title: "Ports", body: "The api listens on 8080.", ...over });
const made = (r: ReturnType<MemoryService["remember"]>): Note => {
  if (!r.ok) throw new Error(r.problem);
  return r.note;
};
const note = (over: Partial<MemoryRememberBody> = {}): Note => made(memory.remember(apiFix, body(over)));
// The principal's answer: the actor a fresh step-up yields (M8), as memory-service.test.ts builds one.
const answer = () => {
  const a = memory.principal(auth());
  if ("problem" in a) throw new Error(a.problem);
  return a;
};
const live = (id: string): Note => {
  const n = memoryStore.get(id);
  if (!n) throw new Error(`no note ${id}`);
  return n;
};
const openMemIds = (s: EscalationService) => s.board().items.filter(i => i.id.startsWith("mem-") && i.status === "open").map(i => i.id);
const escalationsAnswered = () => store.audit(20)
  .filter(a => a.type === "EscalationAnswered")
  .map(a => (a.body as { escalationId: string }).escalationId);

beforeEach(() => {
  now = T0;
  dir = mkdtempSync(join(tmpdir(), "morndo-esc-memory-"));
  store = new Store(dir);
  memoryStore = new MemoryStore(dir);
  memory = new MemoryService({ store: memoryStore, now: () => now });
  sent = [];
});
afterEach(() => { memoryStore.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("what files an Ask", () => {
  it("a pending procedure files an Ask; an approved or invalidated one, and a fact, do not", () => {
    const proc = note({ kind: "procedure", title: "Deploy the api", body: "1. Tag.\n2. Push the tag." });
    note({ title: "The api listens on 8080" });                    // an agent's fact is deliverable, no Ask (M4)
    note({ title: "A mail's claim about 8080", untrusted: true });      // tier 4: waits too (M5)
    const approved = note({ kind: "procedure", title: "Release the api" });
    made(memory.approve(answer(), approved.id));                   // live: no Ask
    const gone = note({ kind: "procedure", title: "Old deploy steps" });
    made(memory.invalidate(apiFix, gone.id, "stale"));             // invalidated: no Ask (M2)
    const s = service();
    s.poll();
    const items = s.board().items.filter(i => i.id.startsWith("mem-"));
    expect(items.map(i => i.id)).toEqual(["mem-n-1", "mem-n-3"]);
    expect(items[0]).toMatchObject({
      asker: { kind: "worker", name: "memory", workerId: null }, need: "decision",
      title: 'Approve the procedure "Deploy the api" for repo:shop-api?',
      shortTitle: null, summary: null, minutes: null, link: null, details: null,
      context: "Written by lane:api-fix (tier 3)\n\n1. Tag.\n2. Push the tag.", contextKind: "markdown",
      options: [
        { key: "approve", label: "Approve", detail: "It reaches every lane's skills at the next sync" },
        { key: "reject", label: "Reject", detail: "The note is invalidated and reaches no lane" },
      ],
      answerBy: "tap", recommendation: null,
      ifNoAnswer: "The note stays out of every lane's skills until you approve it.",
      deadline: null, blocking: false, project: null, askedAt: proc.createdAt, messageId: null, tracking: "hub",
    });
    expect(items[1]?.title).toBe('Approve the untrusted note "A mail\'s claim about 8080" for repo:shop-api?');
    expect(items[1]?.context?.startsWith("Written by lane:api-fix (tier 4) — from untrusted content\n\n")).toBe(true);
  });

  it("the title and the body are cut, with an ellipsis each, and a summary rides along", () => {
    // Built directly (the builder is pure): a note's own title can't exceed its limit, a restated one can bring more.
    const ask = memoryAsk({ ...note({ kind: "procedure" }), title: "T".repeat(180), summary: "How a release goes out", body: "B".repeat(4500) });
    expect(ask.title.length).toBe(200);
    expect(ask.title.endsWith("…")).toBe(true);
    expect(ask.summary).toBe("How a release goes out");
    expect(ask.context).toBe(`Written by lane:api-fix (tier 3)\n\n${"B".repeat(4000)}\n\n…(cut)`);
  });
});

describe("answering in the app", () => {
  it("the app answer with step-up approves: the note is the principal's, the Decision is recorded (E8)", async () => {
    const proc = note({ kind: "procedure", title: "Deploy the api" });
    const s = service();
    s.poll();
    const r = await s.answer(auth(), "mem-n-1", { kind: "option", key: "approve" }, "req1");
    expect(r.ok).toBe(true);
    expect(sent).toEqual([]);                                       // the app answer types nothing (M1: Memory grants nothing)
    expect(r.item).toMatchObject({
      id: "mem-n-1", status: "answered",
      decision: { choice: { kind: "option", key: "approve", label: "Approve" }, via: "here", endpointId: "ep1", sessionId: "s1" },
    });
    expect(live(proc.id)).toMatchObject({ tier: 1, approvedAt: now, approvedBy: "principal:endpoint" });
    const found = memory.search({ q: "deploy" });
    expect(found.ok && found.notes.map(n => n.id)).toEqual([proc.id]);
    expect(escalationsAnswered()).toEqual(["mem-n-1"]);
    s.poll();
    const again = s.board().items.filter(i => i.id === "mem-n-1");
    expect(again).toHaveLength(1);                                  // the same Ask, never asked again
    expect(again[0]).toMatchObject({ status: "answered" });
  });

  it("an app answer without a fresh step-up is refused and approves nothing (AC7, M8)", async () => {
    const proc = note({ kind: "procedure", title: "Deploy the api" });
    const s = service();
    s.poll();
    const r = await s.answer(auth(now - 2 * 3_600_000), "mem-n-1", { kind: "option", key: "approve" }, "req1");
    expect(r).toMatchObject({ ok: false, problem: "step_up" });
    expect(waitsForApproval(live(proc.id))).toBe(true);
    expect(openMemIds(s)).toEqual(["mem-n-1"]);
    expect(escalationsAnswered()).toEqual([]);
  });

  it("words are not a choice here: the Ask offers approve and reject, nothing else", async () => {
    note({ kind: "procedure", title: "Deploy the api" });
    const s = service();
    s.poll();
    expect(await s.answer(auth(), "mem-n-1", { kind: "words", text: "go ahead" }, "req1")).toMatchObject({ ok: false, problem: "bad_option" });
    expect(await s.answer(auth(), "mem-n-1", { kind: "option", key: "hold" }, "req1")).toMatchObject({ ok: false, problem: "bad_option" });
    expect(openMemIds(s)).toEqual(["mem-n-1"]);
  });

  it("rejecting in the app invalidates the note and files no Decision for another note", async () => {
    const first = note({ kind: "procedure", title: "Deploy the api" });
    const second = note({ kind: "procedure", title: "Roll back the api" });
    const s = service();
    s.poll();
    const r = await s.answer(auth(), "mem-n-2", { kind: "option", key: "reject" }, "req1");
    expect(r.ok).toBe(true);
    expect(live(second.id)).toMatchObject({ invalidatedAt: now, invalidatedBy: "principal:endpoint", invalidReason: "rejected in the app" });
    expect(live(first.id)).toMatchObject({ approvedAt: null, invalidatedAt: null });   // untouched
    expect(escalationsAnswered()).toEqual(["mem-n-2"]);
    expect(s.board().items.find(i => i.id === "mem-n-1")?.decision ?? null).toBeNull();
  });

  it("an answer to a note that is no longer pending is refused as changed (E12)", async () => {
    const proc = note({ kind: "procedure", title: "Deploy the api" });
    const s = service();
    s.poll();
    const minted = memory.issueApprovalCode(auth(), proc.id);       // the console path approved it meanwhile (M8)
    if (!minted.ok) throw new Error(minted.problem);
    made(memory.approve("console", proc.id, { code: minted.code }));
    const r = await s.answer(auth(), "mem-n-1", { kind: "option", key: "approve" }, "req1");
    expect(r).toMatchObject({ ok: false, problem: "changed" });
    expect(escalationsAnswered()).toEqual([]);
    expect(memoryStore.events(proc.id).map(e => e.change.kind)).toEqual(["proposed", "approved"]);   // nothing recorded twice
  });

  it("a manager's button message cannot borrow a note's Ask id: it is ignored, and the note's own Ask is the one answered", async () => {
    const proc = note({ kind: "procedure", title: "Deploy the api", body: "1. Tag." });
    const spoof: Watch = {
      workers: () => [{ id: "%0", name: "manager" }],
      history: id => (id === "%0" ? [{ id: "m1", at: now, author: { kind: "agent", name: "manager" }, kind: "text", text: `Approve the release?\n\n[buttons mem-${proc.id.toLowerCase()}] approve=Approve | reject=Reject` }] : []),
      openQuestions: () => [], screen: () => undefined,
    };
    const s = new EscalationService({
      watch: spoof, ledger: null, store, managerName: "manager", now: () => now,
      send: async (pane, text) => { sent.push({ pane, text }); return { problem: null, typedAt: 0 }; }, memory: asks,
    });
    s.poll();
    const items = s.board().items.filter(i => i.id === "mem-n-1");
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Approve the procedure "Deploy the api" for repo:shop-api?');     // Memory's card, not the message's
    expect(items[0]?.asker.name).toBe("memory");
    expect(sent).toEqual([]);
    const r = await s.answer(auth(), "mem-n-1", { kind: "option", key: "approve" }, "req-spoof");
    expect(r.ok).toBe(true);
    expect(sent).toEqual([]);                                      // never typed into a pane
    expect(isDeliverable(live(proc.id))).toBe(true);
  });

  it("an answer to an Ask that is not what Memory would show now is refused as changed, and approves nothing", async () => {
    const proc = note({ kind: "procedure", title: "Deploy the api", body: "1. Tag." });
    // Memory's pending list is read by the test's poll and by answer()'s own, both before the guard reads it: from the
    // third read on it holds a different card for the same note, as if the Ask on the board were another source's.
    let reads = 0;
    const port = () => ({
      pending: () => (++reads > 2 ? [{ ...live(proc.id), title: "Something else" }] : memory.pendingApprovals()),
      decide: (a: Authenticated, id: string, d: "approve" | "reject") => memory.decide(a, id, d),
    });
    const s = service(port);
    s.poll();
    const r = await s.answer(auth(), "mem-n-1", { kind: "option", key: "approve" }, "req-swap");
    expect(r).toMatchObject({ ok: false, problem: "changed" });
    expect(waitsForApproval(live(proc.id))).toBe(true);
    expect(escalationsAnswered()).toEqual([]);
  });

  it("at most ten Asks are open at once, the oldest first", async () => {
    for (let i = 1; i <= 12; i++) { note({ kind: "procedure", title: `Procedure number ${i}` }); now += 1000; }
    const s = service();
    s.poll();
    expect(openMemIds(s)).toEqual(Array.from({ length: 10 }, (_, i) => `mem-n-${i + 1}`));
    expect((await s.answer(auth(), "mem-n-1", { kind: "option", key: "approve" }, "req1")).ok).toBe(true);
    s.poll();
    expect(openMemIds(s)).toEqual(Array.from({ length: 10 }, (_, i) => `mem-n-${i + 2}`));   // the eleventh now, in order
  });

  it("Memory off or absent files no Ask, and an answer to a memory id is refused", async () => {
    const proc = note({ kind: "procedure", title: "Deploy the api" });
    const without = service(() => null);
    without.poll();
    expect(without.board().items.filter(i => i.id.startsWith("mem-"))).toEqual([]);
    // A hub that had Memory and now doesn't (memory.db unreadable at a restart): an Ask already filed can't be answered.
    const held: { port: ReturnType<typeof asks> | null } = { port: asks() };
    const s = service(() => held.port);
    s.poll();
    expect(openMemIds(s)).toEqual(["mem-n-1"]);
    held.port = null;
    expect(await s.answer(auth(), "mem-n-1", { kind: "option", key: "approve" }, "req1")).toMatchObject({ ok: false, problem: "changed" });
    expect(waitsForApproval(live(proc.id))).toBe(true);
    expect(escalationsAnswered()).toEqual([]);
  });
});
