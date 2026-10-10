// PR #29 review: each case is the failure scenario, and failed before its fix.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEEP_SETTLED_MS, endpointId, sessionId, type Message } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { managerInbox } from "../src/adapters/manager-inbox.ts";
import { EscalationService, answerKey, type Watch } from "../src/application/escalation-service.ts";
import { SteeringService } from "../src/application/steering-service.ts";
import type { Authenticated } from "../src/application/access-service.ts";

const T0 = Date.UTC(2026, 9, 4, 14);
const MIN = 60_000;
const HOUR = 60 * MIN;
let now = T0;
let dir: string, inboxDir: string, store: Store, ledgerPath: string;
let history: Message[];

const auth = (): Authenticated => ({
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: now, lastSeenAt: now, verifiedAt: now, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Phone", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: now, revokedAt: null },
});
const agent = (id: string, at: number, text: string): Message => ({ id, at, author: { kind: "agent", name: "manager" }, kind: "text", text });
const watch: Watch = {
  workers: () => [{ id: "%0", name: "manager" }],
  history: id => (id === "%0" ? history : []),
  openQuestions: () => [],
  screen: () => undefined,
};
const service = () => new EscalationService({
  watch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
  send: async () => ({ problem: null, typedAt: now }),
  inbox: managerInbox(inboxDir, () => now),
});
const deliverer = (key: string, state: Record<string, unknown>) => {
  mkdirSync(join(inboxDir, "state"), { recursive: true });
  writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ v: 1, key, attempts: 1, updatedAt: now, ...state }));
};
const msgs = () => readdirSync(join(inboxDir, "msg")).map(f => JSON.parse(readFileSync(join(inboxDir, "msg", f), "utf8")) as { key: string });
const cancels = () => existsSync(join(inboxDir, "ctl")) ? readdirSync(join(inboxDir, "ctl")).filter(n => n.endsWith(".cancel")) : [];
const item = (s: EscalationService, id = "ny-176") => s.board().items.find(i => i.id === id);
const heartbeat = () => writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: now }));

beforeEach(() => {
  now = T0;
  dir = mkdtempSync(join(tmpdir(), "morndo-review29-"));
  inboxDir = join(dir, "inbox");
  mkdirSync(inboxDir, { recursive: true });
  heartbeat();
  store = new Store(dir);
  ledgerPath = join(dir, "ledger.json");
  history = [agent("m1", T0 - MIN, "Ready.\n\n[buttons ny-176] deploy-morndo=Go live | hold=Hold")];
  writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-176", kind: "tap", question: "Deploy Morndo?", addedAt: new Date(T0 - HOUR).toISOString() }], needsYouClosed: [] }));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("review 1: lost is not final until the cancel is confirmed", () => {
  it("a lost answer is cancelled, and Answer again waits until the inbox says cancelled", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    const key = msgs()[0]!.key;
    deliverer(key, { status: "lost", reason: "lost_in_queue", attempts: 1 });
    now += MIN;
    s.poll();
    expect(cancels()).toContain(`${key}.cancel`);
    expect(item(s)).toMatchObject({ status: "answered", decision: { delivery: { state: "queued" } } });
    expect(JSON.stringify(item(s))).not.toContain("did not reach the manager");
    deliverer(key, { status: "cancelled", attempts: 1 });
    now += MIN;
    s.poll();
    const card = item(s);
    expect(card).toMatchObject({ status: "open", decision: null });
    expect(JSON.stringify(card)).toContain("did not reach the manager");
    expect((await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-2")).ok).toBe(true);
  });
});

describe("review 2: an answer in doubt blocks another before it is queued", () => {
  it("a tap still in doubt is not followed by a second answer in the inbox", async () => {
    writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: now - 120_000 }));
    const s = new EscalationService({
      watch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => { throw new Error("mid-paste"); },
      inbox: managerInbox(inboxDir, () => now),
    });
    s.poll();
    expect(await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1")).toMatchObject({ ok: false, problem: "uncertain" });
    heartbeat();
    const second = await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-2");
    expect(second).toMatchObject({ ok: false, problem: "answer_in_doubt" });
    expect(existsSync(join(inboxDir, "msg")) ? readdirSync(join(inboxDir, "msg")) : []).toEqual([]);
  });
});

describe("review 4: a queued answer is remembered as that request", () => {
  it("the same request after the seen window, and after a restart, is still queued, not delivered", async () => {
    const s = service();
    s.poll();
    expect((await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1")).ok).toBe(true);
    now += 11 * MIN;
    heartbeat();
    const again = await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    expect(again).toMatchObject({ ok: true, queued: true });
    expect(again.ok ? again.duplicate : true).toBeUndefined();
    expect(again.ok ? again.at : 0).toBeUndefined();
    store.close();
    store = new Store(dir);
    const restarted = service();
    restarted.poll();
    const after = await restarted.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    expect(after).toMatchObject({ ok: true, queued: true });
    expect(after.ok ? after.at : 0).toBeUndefined();
  });
});

describe("round 3.8: a started answer with no worker is not a permanent refusal", () => {
  it("is queued again after a restart, so the same request is not uncertain", async () => {
    const s = service();
    s.poll();
    expect((await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1")).ok).toBe(true);
    const row = store.db.prepare("SELECT key FROM sends WHERE state = 'done' AND outcome = 'queued'").get() as { key: string };
    store.db.prepare("UPDATE sends SET state = 'started', outcome = NULL, worker_id = NULL WHERE key = ?").run(row.key);
    store.close();
    store = new Store(dir);
    const restarted = service();
    now += 11 * MIN;
    heartbeat();
    restarted.poll();
    const again = await restarted.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    expect(again).toMatchObject({ ok: true, queued: true });
  });
});

describe("round 3.7: a delivered queued answer is remembered as delivered", () => {
  it("the same request after it was delivered says delivered, not still queued", async () => {
    const s = service();
    s.poll();
    expect((await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1")).ok).toBe(true);
    const deliveredAt = now + 5_000;
    deliverer(msgs()[0]!.key, { status: "delivered", deliveredAt, attempts: 1 });
    now += MIN;
    s.poll();
    now += 11 * MIN;
    heartbeat();
    const again = await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    expect(again).toMatchObject({ ok: true, duplicate: true, at: deliveredAt });
    expect(again.ok ? again.queued : true).toBeUndefined();
  });
});

describe("round 2.6: a queued answer is remembered while the manager is not running", () => {
  it("the same request after the seen window is not refused as already answered", async () => {
    writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-176", kind: "tap", question: "Deploy Morndo?", addedAt: new Date(T0 - HOUR).toISOString(), options: [{ key: "hold", label: "Hold" }] }], needsYouClosed: [] }));
    const quiet: Watch = { ...watch, workers: () => [] };
    const s = new EscalationService({
      watch: quiet, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => ({ problem: null, typedAt: now }), inbox: managerInbox(inboxDir, () => now),
    });
    s.poll();
    expect((await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1")).ok).toBe(true);
    now += 11 * MIN;
    heartbeat();
    const again = await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    expect(again.ok).toBe(true);
  });
});

describe("review 5: a duplicate of a message already delivered does not answer the new ask", () => {
  it("does not record the old message as delivered to the question asked since", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    deliverer(msgs()[0]!.key, { status: "delivered", deliveredAt: now, attempts: 1 });
    now += MIN;
    s.poll();
    now += MIN;
    history = [agent("m2", now, "Asked again.\n\n[buttons ny-176] deploy-morndo=Go live | hold=Hold")];
    s.poll();
    expect(item(s)?.status).toBe("open");
    store.dropSend(answerKey("ny-176", { messageId: "m1", askedAt: T0 - MIN }, { kind: "option", key: "hold" }));
    now += 11 * MIN;
    heartbeat();
    const again = await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    now += MIN;
    s.poll();
    expect(again.ok).toBe(false);
    expect(item(s)?.status).toBe("open");
    expect(item(s)?.decision ?? null).toBeNull();
  });
});

describe("review 6: a command expires from when it was written", () => {
  it("notAfter is the command's creation plus 2 minutes, not the hub's arrival", async () => {
    const steering = new SteeringService(store, { send: async () => ({ problem: null, typedAt: now }) }, () => now, undefined, null, () => "none", () => null, undefined, null,
      { isManager: () => true, inbox: managerInbox(inboxDir, () => now) });
    const created = now - 115_000;
    expect((await steering.send(auth(), "%0", "ship it", "rid-9", [], "none", "manager", created)).ok).toBe(true);
    const file = readdirSync(join(inboxDir, "msg"))[0]!;
    const msg = JSON.parse(readFileSync(join(inboxDir, "msg", file), "utf8")) as { notAfter?: number };
    expect(msg.notAfter).toBe(created + 2 * MIN);
  });

  it("a createdAt more than 2 minutes ago, or in the future, counts from now", async () => {
    const steering = new SteeringService(store, { send: async () => ({ problem: null, typedAt: now }) }, () => now, undefined, null, () => "none", () => null, undefined, null,
      { isManager: () => true, inbox: managerInbox(inboxDir, () => now) });
    const send = (id: string, createdAt: number) => steering.send(auth(), "%0", "ship it", id, [], "none", "manager", createdAt);
    const notAfter = (id: string) => {
      const file = readdirSync(join(inboxDir, "msg")).map(f => JSON.parse(readFileSync(join(inboxDir, "msg", f), "utf8")) as { id?: string; notAfter?: number }).find(m => m.id === `command:ep1:${id}`);
      return file?.notAfter;
    };
    await send("rid-late", now - 10 * MIN);
    await send("rid-ahead", now + 3 * MIN);
    expect(notAfter("rid-late")).toBe(now + 2 * MIN);
    expect(notAfter("rid-ahead")).toBe(now + 2 * MIN);
  });
});

describe("review 7: settled pending rows are pruned while the hub runs", () => {
  it("a withdrawn answer kept for its echo is dropped after 24 hours without a restart", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1");
    const key = msgs()[0]!.key;
    now += MIN;
    history = [...history, agent("m2", now, "Restated.\n\n[buttons ny-176] deploy-morndo=Go live | hold=Hold")];
    now += 1_000;
    s.poll();
    deliverer(key, { status: "cancelled", attempts: 1 });
    now += MIN;
    s.poll();
    const settled = () => store.pendingAnswers().filter(r => (r.body as { settledAt?: number }).settledAt !== undefined);
    expect(settled().length).toBeGreaterThan(0);
    now += 25 * HOUR;
    s.poll();
    expect(settled()).toEqual([]);
  });
});

describe("review 8: a card's notice survives a restart and does not outlive the ask", () => {
  const missed = async (s: EscalationService) => {
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    const key = msgs()[0]!.key;
    deliverer(key, { status: "lost", reason: "lost_in_queue", attempts: 1 });
    now += MIN;
    s.poll();
    deliverer(key, { status: "cancelled", attempts: 1 });
    now += MIN;
    s.poll();
  };

  it("is still there after a restart", async () => {
    const s = service();
    await missed(s);
    expect(JSON.stringify(item(s))).toContain("did not reach the manager");
    store.close();
    store = new Store(dir);
    const again = service();
    again.poll();
    expect(JSON.stringify(item(again))).toContain("did not reach the manager");
  });

  it("a directly typed answer clears it", async () => {
    const s = service();
    await missed(s);
    writeFileSync(join(inboxDir, "disabled"), "");
    heartbeat();
    expect((await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-2")).ok).toBe(true);
    expect(JSON.stringify(item(s))).not.toContain("did not reach the manager");
  });

  it("does not come back on an ask that had gone", async () => {
    const s = service();
    await missed(s);
    history = [];
    writeFileSync(ledgerPath, JSON.stringify({ needsYou: [], needsYouClosed: [] }));
    now += MIN;
    s.poll();
    now += KEEP_SETTLED_MS + MIN;
    s.poll();
    expect(item(s)).toBeUndefined();
    history = [agent("m3", now, "Back.\n\n[buttons ny-176] deploy-morndo=Go live | hold=Hold")];
    writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-176", kind: "tap", question: "Deploy Morndo?", addedAt: new Date(now).toISOString() }], needsYouClosed: [] }));
    now += MIN;
    s.poll();
    expect(JSON.stringify(item(s) ?? {})).not.toContain("did not reach the manager");
  });
});

describe("review 9: giving up a queued answer is one helper", () => {
  it("withdraw, drop the decision and drop the row happen in #giveUp, on a QueuedAnswer", () => {
    const src = readFileSync(new URL("../src/application/escalation-service.ts", import.meta.url), "utf8");
    expect(src).toContain("type QueuedAnswer = ");
    expect(src).toContain("Map<string, QueuedAnswer>");
    expect(src.match(/this\.#giveUp\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(src.match(/dropDecisionIf\(/g)).toEqual(["dropDecisionIf("]);
  });
});

describe("round 3.3: a cancel that was not written is tried again", () => {
  it("does not remember the cancel until the file exists", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    const key = msgs()[0]!.key;
    deliverer(key, { status: "lost", reason: "lost_in_queue", attempts: 1 });
    rmSync(join(inboxDir, "ctl"), { recursive: true, force: true });
    writeFileSync(join(inboxDir, "ctl"), "not a directory");
    now += MIN;
    s.poll();
    s.poll();
    const body = () => store.pendingAnswers().find(r => r.key === key)?.body as { missed?: boolean } | undefined;
    expect(body()?.missed).not.toBe(true);
    rmSync(join(inboxDir, "ctl"));
    s.poll();
    expect(cancels()).toContain(`${key}.cancel`);
    expect(body()?.missed).toBe(true);
  });
});

describe("round 2.9: one queued-answer shape, and no dead branch", () => {
  it("the field list is written once, and the lost branch does not test what cannot happen", () => {
    const src = readFileSync(new URL("../src/application/escalation-service.ts", import.meta.url), "utf8");
    expect(src).not.toContain('&& s.status !== "cancelled"');
    expect(src.match(/if \(!reader\) continue/g)?.length ?? 0).toBe(1);
    expect(src.match(/cancel\?: boolean; late\?: boolean; missed\?: boolean/g)?.length).toBe(1);
    expect(src).toContain("type QueuedAnswer = ");
    expect(src.match(/this\.#giveUp\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe("review 10: one poll reads a queued answer's inbox state once", () => {
  it("a restated ask does not read the spool twice", async () => {
    let reads = 0;
    const inbox = managerInbox(inboxDir, () => now);
    const s = new EscalationService({
      watch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => ({ problem: null, typedAt: now }),
      inbox: { ...inbox, state: key => { reads += 1; return inbox.state(key); } },
    });
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    reads = 0;
    now += MIN;
    history = [...history, agent("m2", now, "Restated.\n\n[buttons ny-176] deploy-morndo=Go live | hold=Hold")];
    now += 1_000;
    s.poll();
    expect(reads).toBe(1);
  });
});

describe("round 2.1: a late delivery does not block the restated ask", () => {
  it("the same message, asked again, can be answered with another choice", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    const key = msgs()[0]!.key;
    deliverer(key, { status: "delivered", deliveredAt: now, attempts: 1 });
    now += MIN;
    history = [agent("m1", now, "Asked again.\n\n[buttons ny-176] deploy-morndo=Go live | hold=Hold")];
    now += 1_000;
    s.poll();
    expect(item(s)?.status).toBe("open");
    expect(JSON.stringify(item(s))).toContain("earlier version");
    expect(await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-2")).toMatchObject({ ok: true });
  });
});

describe("round 2.8: a poll does not rewrite a lost answer, and reads pending rows once", () => {
  it("two polls while an answer stays lost write the cancel and the pending row once", async () => {
    let cancelsN = 0;
    const inbox = managerInbox(inboxDir, () => now);
    const s = new EscalationService({
      watch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
      send: async () => ({ problem: null, typedAt: now }),
      inbox: { ...inbox, cancel: key => { cancelsN += 1; return inbox.cancel(key); } },
    });
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    const key = msgs()[0]!.key;
    deliverer(key, { status: "lost", reason: "lost_in_queue", attempts: 1 });
    let saves = 0;
    const save = store.savePending.bind(store);
    store.savePending = (k, id, body) => { saves += 1; save(k, id, body); };
    now += MIN;
    s.poll();
    s.poll();
    expect(cancelsN).toBe(1);
    expect(saves).toBe(1);
    expect(cancels()).toContain(`${key}.cancel`);
  });

  it("one poll reads pending answers once when a notice belongs to an ask that is gone", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-1");
    const key = msgs()[0]!.key;
    deliverer(key, { status: "delivered", deliveredAt: now, attempts: 1 });
    now += MIN;
    history = [agent("m1", now, "Asked again.\n\n[buttons ny-176] deploy-morndo=Go live | hold=Hold")];
    now += 1_000;
    s.poll();
    history = [];
    writeFileSync(ledgerPath, JSON.stringify({ needsYou: [], needsYouClosed: [] }));
    now += MIN;
    s.poll();                                           // the ask settles as missing; it is still there
    let reads = 0;
    const pending = store.pendingAnswers.bind(store);
    store.pendingAnswers = () => { reads += 1; return pending(); };
    now += 3 * 24 * HOUR + MIN;                         // now it is gone, and its notice is forgotten on this poll
    s.poll();
    expect(reads).toBe(1);
  });
});
