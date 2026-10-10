// Decisions 2–5 and the review findings rebuilt on main (ADR-0010 addendum). Each case failed on the port of #10
// before its fix.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEEP_SETTLED_MS, endpointId, sessionId, type Message } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { managerInbox } from "../src/adapters/manager-inbox.ts";
import { EscalationService, type Watch } from "../src/application/escalation-service.ts";
import { SteeringService } from "../src/application/steering-service.ts";
import type { Authenticated } from "../src/application/access-service.ts";

const T0 = Date.UTC(2026, 9, 4, 14);
const MIN = 60_000;
const HOUR = 60 * MIN;
let now = T0;
let dir: string, inboxDir: string, store: Store, ledgerPath: string;
let manager: Message[];
let history: Message[];

const auth = (): Authenticated => ({
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: now, lastSeenAt: now, verifiedAt: now, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Phone", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: now, revokedAt: null },
});
const agent = (id: string, at: number, text: string): Message => ({ id, at, author: { kind: "agent", name: "manager" }, kind: "text", text });
const principal = (id: string, at: number, text: string): Message => ({ id, at, author: { kind: "principal", name: "You" }, kind: "text", text });
const watch: Watch = {
  workers: () => [{ id: "%0", name: "manager" }],
  history: id => (id === "%0" ? history : []),
  openQuestions: () => [],
  screen: () => undefined,
};
const service = (inbox = true) => new EscalationService({
  watch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
  send: async () => ({ problem: null, typedAt: now }),
  inbox: inbox ? managerInbox(inboxDir, () => now) : null,
});
const deliverer = (key: string, state: Record<string, unknown>) => {
  mkdirSync(join(inboxDir, "state"), { recursive: true });
  writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ v: 1, key, attempts: 1, updatedAt: now, ...state }));
};
const msgs = () => readdirSync(join(inboxDir, "msg")).map(f => JSON.parse(readFileSync(join(inboxDir, "msg", f), "utf8")) as { key: string; text: string; notAfter?: number });
const cancels = () => existsSync(join(inboxDir, "ctl")) ? readdirSync(join(inboxDir, "ctl")) : [];
const item = (s: EscalationService, id = "ny-176") => s.board().items.find(i => i.id === id);
const openList = (question = "Deploy Morndo?") => {
  writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-176", kind: "tap", question, addedAt: new Date(T0 - HOUR).toISOString() }, { id: "ny-175", kind: "words", question: "The rewrite?", addedAt: new Date(T0 - HOUR).toISOString() }], needsYouClosed: [] }));
};

beforeEach(() => {
  now = T0;
  dir = mkdtempSync(join(tmpdir(), "morndo-inbox-v2-"));
  inboxDir = join(dir, "inbox");
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: now }));
  store = new Store(dir);
  ledgerPath = join(dir, "ledger.json");
  manager = [agent("m1", T0 - MIN, "Ready.\n\n[buttons ny-176] deploy-morndo=Go live | hold=Hold")];
  history = manager;
  openList();
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("decision 2: cancel only while the answer is still untyped", () => {
  it("an answer already accepted is not cancelled; when it arrives it is a late answer to the old version", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1");
    const key = msgs()[0]!.key;
    deliverer(key, { status: "accepted", attempts: 1 });
    now += MIN;
    history = [...manager, agent("m2", now, "Restated.\n\n[buttons ny-176] deploy-morndo=Go live | hold=Hold")];
    now += 1_000;
    s.poll();
    expect(cancels()).toEqual([]);
    deliverer(key, { status: "delivered", deliveredAt: now, attempts: 1 });
    now += MIN;
    s.poll();
    const card = item(s);
    expect(card).toMatchObject({ status: "open", decision: null });
    expect(JSON.stringify(card)).toContain("earlier version");
    expect(store.auditOf("EscalationAnswered", 0)).toHaveLength(1);
  });

  it("a cancelled message that was typed (attempts ≥ 1) keeps its echo for 24 h, then a genuine tap answers", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1");
    const key = msgs()[0]!.key;
    const line = "[tap ny-176] deploy-morndo (Go live)";
    now += MIN;
    history = [...manager, agent("m2", now, "Restated.\n\n[buttons ny-176] deploy-morndo=Go live | hold=Hold")];
    now += 1_000;
    s.poll();
    deliverer(key, { status: "cancelled", attempts: 1 });
    now += MIN;
    s.poll();
    history = [...history, principal("echo", now, line)];
    now += 1_000;
    s.poll();
    expect(item(s)).toMatchObject({ status: "open", decision: null });
    now += 25 * HOUR;
    history = [agent("m3", now, "Still open.\n\n[buttons ny-176] deploy-morndo=Go live | hold=Hold"), principal("real", now + 500, line)];
    now += MIN;
    s.poll();
    expect(item(s)).toMatchObject({ status: "answered", decision: { via: "elsewhere", choice: { key: "deploy-morndo" } } });
  });
});

describe("decision 3: lost and unconfirmed reopen the ask once the cancel is confirmed", () => {
  it("lost: the card says the answer did not reach the manager, and the ask can be answered again", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    const key = msgs()[0]!.key;
    deliverer(key, { status: "lost", reason: "lost_in_queue", attempts: 1 });
    now += MIN;
    s.poll();
    expect(cancels()).toContain(`${key}.cancel`);
    expect(item(s)?.status).toBe("answered");
    deliverer(key, { status: "cancelled", attempts: 1 });
    now += MIN;
    s.poll();
    const card = item(s);
    expect(card).toMatchObject({ status: "open", decision: null, answerable: null });
    expect(JSON.stringify(card)).toContain("did not reach the manager");
    expect((await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-2")).ok).toBe(true);
  });

  it("unconfirmed: the same, not an endless Queued", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    const key = msgs()[0]!.key;
    deliverer(key, { status: "sent", reason: "unconfirmed", attempts: 3 });
    now += MIN;
    s.poll();
    expect(item(s)?.status).toBe("answered");
    deliverer(key, { status: "cancelled", attempts: 3 });
    now += MIN;
    s.poll();
    const card = item(s);
    expect(card).toMatchObject({ status: "open", answerable: null });
    expect(JSON.stringify(card)).toContain("did not reach the manager");
  });
});

describe("decision 4: a duplicate enqueue reads the message that is already there", () => {
  it("cancelled: the client is told, and the answer is not ok", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    deliverer(msgs()[0]!.key, { status: "cancelled", attempts: 0 });
    now += MIN;
    s.poll();
    expect(item(s)).toMatchObject({ status: "open" });
    now += 11 * MIN;
    writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: now }));
    const again = await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    expect(again).toMatchObject({ ok: false, problem: "not_delivered" });
    expect(item(s)?.status).toBe("open");
  });
});

describe("decision 5: fixtures use synthetic names", () => {
  it("the name from the owner's ledger is not in the inbox fixtures", () => {
    const root = join(import.meta.dirname);
    const files = ["escalation-inbox.test.ts", "val-b8-decision-extra-fields.test.ts"].map(f => readFileSync(join(root, f), "utf8"));
    for (const src of files) expect(src).not.toContain("Stevo");
  });
});

describe("finding 3: an echo is one remembered message, and expires", () => {
  it("once the echo has left the history window, a later tap of the same line answers", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1");
    const line = "[tap ny-176] deploy-morndo (Go live)";
    now += MIN;
    history = [...manager, agent("m2", now, "Restated.\n\n[buttons ny-176] deploy-morndo=Go live | hold=Hold")];
    now += 1_000;
    s.poll();
    deliverer(msgs()[0]!.key, { status: "cancelled", attempts: 1 });
    now += MIN;
    history = [...history, principal("echo", now, line)];
    s.poll();
    history = [agent("m9", now + HOUR, "Still.\n\n[buttons ny-176] deploy-morndo=Go live | hold=Hold"), principal("real", now + HOUR, line)];
    now += HOUR;
    s.poll();
    expect(item(s)).toMatchObject({ status: "answered", decision: { via: "elsewhere" } });
  });
});

describe("finding 6: a command to the manager carries a deadline", () => {
  it("the queued message has notAfter, so a menu open for hours does not type it later", async () => {
    const typed: string[] = [];
    const tmux = { send: async (_id: string, text: string) => { typed.push(text); return { problem: null, typedAt: now }; } };
    const steering = new SteeringService(store, tmux, () => now, undefined, null, () => "none", () => null, undefined, null,
      { isManager: id => id === "%0", inbox: managerInbox(inboxDir, () => now) });
    expect((await steering.send(auth(), "%0", "ship it", "rid-1")).ok).toBe(true);
    expect(msgs()[0]?.notAfter).toBeGreaterThan(now);
  });
});

describe("finding 7: giving up on an unreadable inbox withdraws the message", () => {
  it("after 15 minutes a cancel is written when the inbox directory is still there", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    const key = msgs()[0]!.key;
    rmSync(join(inboxDir, "msg"), { recursive: true, force: true });
    now += 10_000;
    s.poll();
    expect(item(s)?.status).toBe("answered");
    now += 16 * MIN;
    s.poll();
    expect(item(s)).toMatchObject({ status: "open", decision: null });
    expect(cancels()).toContain(`${key}.cancel`);
  });
});

describe("finding 8: an ask restated in place withdraws the queued answer", () => {
  it("the same addedAt with a new question withdraws the old tap", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-175", { kind: "words", text: "Ship Friday" }, "req-w");
    expect(cancels()).toEqual([]);
    openList();
    writeFileSync(ledgerPath, JSON.stringify({ needsYou: [
      { id: "ny-176", kind: "tap", question: "Deploy Morndo?", addedAt: new Date(T0 - HOUR).toISOString() },
      { id: "ny-175", kind: "words", question: "Ship which day?", addedAt: new Date(T0 - HOUR).toISOString() },
    ], needsYouClosed: [] }));
    now += MIN;
    s.poll();
    expect(cancels().length).toBe(1);
  });
});

describe("finding 9: a withdrawn restored Decision is not applied again", () => {
  it("after the item is dropped and reopened, the old queued Decision stays gone", async () => {
    history = [];
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-175", { kind: "words", text: "Ship Friday" }, "req-w");
    const key = msgs()[0]!.key;
    store.close();
    store = new Store(dir);
    const again = service();
    again.poll();
    deliverer(key, { status: "cancelled", attempts: 0 });
    now += MIN;
    again.poll();
    expect(item(again, "ny-175")).toMatchObject({ status: "open", decision: null });
    writeFileSync(ledgerPath, JSON.stringify({ needsYou: [], needsYouClosed: [] }));
    now += MIN;
    again.poll();
    now += KEEP_SETTLED_MS + MIN;
    again.poll();
    expect(again.board().items.find(i => i.id === "ny-175")).toBeUndefined();
    openList();
    now += MIN;
    again.poll();
    expect(item(again, "ny-175")?.decision ?? null).toBeNull();
    expect(item(again, "ny-175")?.status).not.toBe("answered");
  });
});

describe("finding 11: a words answer of only control characters is refused", () => {
  it("is not queued", async () => {
    const s = service();
    s.poll();
    const r = await s.answer(auth(), "ny-175", { kind: "words", text: "\u0007" }, "req-bel");
    expect(r).toMatchObject({ ok: false, problem: "empty" });
    expect(existsSync(join(inboxDir, "msg")) ? readdirSync(join(inboxDir, "msg")) : []).toEqual([]);
  });
});

describe("finding 12: cancel does not recreate a removed inbox", () => {
  it("a settled answer whose inbox directory is gone leaves it gone", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    rmSync(inboxDir, { recursive: true, force: true });
    writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-176", kind: "tap", question: "Deploy Morndo?", status: "closed", answer: "by hand", closedAt: new Date(now).toISOString(), addedAt: new Date(T0 - HOUR).toISOString() }], needsYouClosed: [] }));
    now += MIN;
    s.poll();
    expect(existsSync(inboxDir)).toBe(false);
  });
});

describe("finding 10: a Decision the aggregate refuses is not left in the inbox", () => {
  it("the message is withdrawn when queue refuses", async () => {
    // One poll, then answer(): mayCommand, its clock, its poll, check, then queue. The jump is that last call.
    const jumps = [T0, T0, T0, T0, T0, T0, T0 + 25 * HOUR];
    let n = 0;
    const clock = () => jumps[Math.min(n++, jumps.length - 1)]!;
    const s = new EscalationService({
      watch: { workers: () => [{ id: "%0", name: "manager" }], history: () => history, openQuestions: () => [], screen: () => undefined },
      ledger: ledgerReader(ledgerPath, () => T0), store, managerName: "manager", now: clock,
      send: async () => ({ problem: null, typedAt: T0 }),
      inbox: managerInbox(inboxDir, () => T0),
    });
    // Not a ledger id: only an age-tracked ask expires a day after it was asked (E10), so queue can refuse after check passed.
    history = [agent("m1", T0 - MIN, "Ready.\n\n[buttons ask-1] go=Go | hold=Hold")];
    s.poll();
    const r = await s.answer(auth(), "ask-1", { kind: "option", key: "hold" }, "req-age");
    expect(r).toMatchObject({ ok: false, problem: "expired" });
    expect(cancels()).toHaveLength(1);
  });
});

describe("finding 15: a reused e2e directory does not keep the last run's inbox", () => {
  it("inbox.e2e clears its inbox before the hub starts", () => {
    const src = readFileSync(join(import.meta.dirname, "../../../e2e/inbox.e2e.ts"), "utf8");
    const clear = src.indexOf("rmSync(INBOX");
    const start = src.indexOf("startOffice(");
    expect(clear).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(start);
  });
});
