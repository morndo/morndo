// A worker's question or menu reaches the principal as an Ask only after 10 minutes open (N2): the manager answers most
// of them first, and 71 of 74 cleared within a minute. Before that it is not on the board, not in the counts and raises
// no Notification. The manager's own questions and menus, the list's items and filed briefs stay immediate. The clock
// is fake; the first-seen time of a menu comes from the hub's own database, so it survives a restart.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, NotificationEvent } from "@morndo/domain";
import { WORKER_ASK_GRACE_MS } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { EscalationService, type Watch } from "../src/application/escalation-service.ts";
import { NotificationService, type PushStore } from "../src/application/notification-service.ts";

const T0 = Date.UTC(2026, 9, 23, 8);
const MIN = 60_000;
const MENU = "work…\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel\n\n";
let dir: string;
let store: Store;
let ledgerPath: string;
let workers: { id: string; name: string }[];
let questions: Record<string, Message[]>;
let screens: Record<string, string>;
let audit: NotificationEvent[];
let services: { stop(): void }[];

const at = (t: number) => vi.setSystemTime(t);
const question = (id: string, t: number, who: string): Message => ({
  id, at: t, author: { kind: "agent", name: who }, kind: "question", text: "Keep the old endpoint?", questionId: `toolu_${id}`,
  questions: [{ question: "Keep the old endpoint?", header: "Endpoint", options: [{ label: "Keep", description: null }, { label: "Drop", description: null }], multiSelect: false }],
});
const watch: Watch = {
  workers: () => workers,
  history: () => [],
  openQuestions: id => questions[id] ?? [],
  screen: id => screens[id],
};
const pushes: PushStore = {
  pushSubscriptions: () => [{ endpointId: "phone", endpoint: "https://fcm.googleapis.com/fcm/send/phone", p256dh: "k", auth: "a" }],
  savePushSubscription: () => {},
  deletePushSubscription: () => false,
  record: e => { audit.push(...e); },
};
// A hub start, as main.ts builds it: a service on the database, its board fed to the Notification service.
const start = (workerGraceMs?: number) => {
  const s = new EscalationService({ watch, ledger: ledgerReader(ledgerPath, () => Date.now()), store, managerName: "manager", now: () => Date.now(), send: async () => ({ problem: null, typedAt: Date.now() }), workerGraceMs });
  const n = new NotificationService({ store: pushes, send: async () => ({ status: 201 }) });
  n.board(s.board().items);
  s.subscribe(b => n.board(b.items));
  services.push(n);
  return { s, n };
};
const ids = (s: EscalationService) => s.board().items.map(i => i.id);

beforeEach(() => {
  vi.useFakeTimers();
  at(T0);
  dir = mkdtempSync(join(tmpdir(), "morndo-grace-"));
  store = new Store(dir);
  ledgerPath = join(dir, "ledger.json");
  workers = [{ id: "%0", name: "manager" }, { id: "%3", name: "builder" }];
  questions = {}; screens = { "%0": "❯ ", "%3": "❯ " }; audit = []; services = [];
  writeFileSync(ledgerPath, JSON.stringify({ needsYou: [], needsYouClosed: [] }));
});
afterEach(() => { for (const s of services) s.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

describe("a worker's menu waits 10 minutes before it reaches the principal", () => {
  it("is not on the board at 9 minutes; at 10 it is, with its first-seen time, and raises exactly one decision Notification", async () => {
    const { s, n } = start();
    expect(WORKER_ASK_GRACE_MS).toBe(10 * MIN);
    screens["%3"] = MENU;
    s.poll();
    expect(ids(s)).toEqual([]);
    at(T0 + 9 * MIN);
    s.poll();
    expect(ids(s)).toEqual([]);
    expect(n.counts().decisions).toBe(0);
    await vi.advanceTimersByTimeAsync(5000); await n.settled();
    expect(audit).toEqual([]);

    at(T0 + 10 * MIN);
    s.poll();
    expect(s.board().items).toHaveLength(1);
    expect(s.board().items[0]).toMatchObject({ id: "menu-3", status: "open", need: "decision", asker: { kind: "worker", name: "builder" }, askedAt: T0 });
    expect(n.counts().decisions).toBe(1);
    await vi.advanceTimersByTimeAsync(5000); await n.settled();
    expect(audit.filter(e => e.type === "NotificationSent" && e.kind === "decision")).toHaveLength(1);
    s.poll();                                             // a later poll raises no second one
    await vi.advanceTimersByTimeAsync(5000); await n.settled();
    expect(audit.filter(e => e.type === "NotificationSent")).toHaveLength(1);
  });

  it("a menu gone at 2 minutes never appears and never pushes, not even when it comes back and 10 minutes pass since the first sight", async () => {
    const { s, n } = start();
    screens["%3"] = MENU;
    s.poll();
    at(T0 + 2 * MIN);
    screens["%3"] = "❯ ";
    s.poll();
    at(T0 + 12 * MIN);
    s.poll();
    expect(ids(s)).toEqual([]);
    expect(n.counts().decisions).toBe(0);
    await vi.advanceTimersByTimeAsync(5000); await n.settled();
    expect(audit).toEqual([]);
    at(T0 + 12 * MIN);                                    // the notification flush above advanced the fake clock 5 s; re-pin it
    screens["%3"] = MENU;                                 // shown again: a new ask, its 10 minutes start now
    s.poll();
    at(T0 + 21 * MIN);
    s.poll();
    expect(ids(s)).toEqual([]);
    at(T0 + 22 * MIN);
    s.poll();
    expect(ids(s)).toEqual(["menu-3"]);
  });

  it("after a hub restart at 5 minutes it appears at 10 minutes after the first sight, not 15 (first-seen from the store)", () => {
    const before = start();
    screens["%3"] = MENU;
    before.s.poll();
    at(T0 + 5 * MIN);
    before.s.stop();
    const after = start();
    after.s.poll();
    expect(ids(after.s)).toEqual([]);
    at(T0 + 9 * MIN);
    after.s.poll();
    expect(ids(after.s)).toEqual([]);
    at(T0 + 10 * MIN);
    after.s.poll();
    expect(after.s.board().items[0]).toMatchObject({ id: "menu-3", askedAt: T0 });
  });
});

describe("a worker's open question waits the same 10 minutes, from the moment it was asked", () => {
  it("is on the board at 10 minutes, not before, with one decision Notification", async () => {
    questions["%3"] = [question("q1", T0, "builder")];
    const { s, n } = start();
    s.poll();
    expect(ids(s)).toEqual([]);
    at(T0 + 9 * MIN);
    s.poll();
    expect(ids(s)).toEqual([]);
    expect(n.counts().decisions).toBe(0);
    at(T0 + 10 * MIN);
    s.poll();
    expect(s.board().items[0]).toMatchObject({ id: "q-toolu_q1", status: "open", askedAt: T0, asker: { kind: "worker" } });
    await vi.advanceTimersByTimeAsync(5000); await n.settled();
    expect(audit.filter(e => e.type === "NotificationSent" && e.kind === "decision")).toHaveLength(1);
  });

  it("a question answered at 2 minutes never appears and never pushes", async () => {
    questions["%3"] = [question("q1", T0, "builder")];
    const { s, n } = start();
    s.poll();
    at(T0 + 2 * MIN);
    questions["%3"] = [];
    s.poll();
    at(T0 + 12 * MIN);
    s.poll();
    expect(ids(s)).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000); await n.settled();
    expect(n.counts().decisions).toBe(0);
    expect(audit).toEqual([]);
  });

  it("a question already older than 10 minutes when the hub first sees it is on the board at once", () => {
    at(T0 + 30 * MIN);
    questions["%3"] = [question("q1", T0, "builder")];
    const { s } = start();
    s.poll();
    expect(ids(s)).toEqual(["q-toolu_q1"]);
  });
});

describe("the tests-only override of the grace (workerGraceMs)", () => {
  it("a grace of 0 (the tests-only override) shows a worker's menu and question at once", () => {
    workers.push({ id: "%4", name: "coder" });            // the menu and the question on two workers: one with an open question shows no menu
    screens["%3"] = MENU;
    questions["%4"] = [question("q1", T0, "coder")];
    const { s } = start(0);
    s.poll();
    expect(ids(s).sort()).toEqual(["menu-3", "q-toolu_q1"]);
  });

  it("a grace of 3000 holds a menu at 2 seconds and shows it at 3", () => {
    screens["%3"] = MENU;
    const { s } = start(3000);
    s.poll();                                             // the first sight starts the menu's clock
    expect(ids(s)).toEqual([]);
    at(T0 + 2000);
    s.poll();
    expect(ids(s)).toEqual([]);
    at(T0 + 3000);
    s.poll();
    expect(ids(s)).toEqual(["menu-3"]);
  });
});

describe("what stays immediate", () => {
  it("the manager's own menu and question are on the board at once", () => {
    screens["%0"] = MENU;
    const { s } = start();
    s.poll();
    expect(s.board().items).toMatchObject([{ id: "menu-0", asker: { kind: "manager" }, status: "open" }]);
    screens["%0"] = "❯ ";
    questions["%0"] = [question("q9", T0, "manager")];
    s.poll();
    expect(s.board().items.map(i => i.id)).toContain("q-toolu_q9");
    expect(s.board().items.find(i => i.id === "q-toolu_q9")).toMatchObject({ asker: { kind: "manager" }, status: "open" });
  });

  it("a manager's question raises its decision Notification without waiting", async () => {
    const { s, n } = start();
    questions["%0"] = [question("q9", T0, "manager")];
    s.poll();
    expect(n.counts().decisions).toBe(1);
    await vi.advanceTimersByTimeAsync(5000); await n.settled();
    expect(audit.filter(e => e.type === "NotificationSent" && e.kind === "decision")).toHaveLength(1);
  });

  it("the list's cards stay on the board at once, a worker's menu beside them waits", () => {
    writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-8", kind: "tap", question: "Pick the launch date", default: "next Monday" }], needsYouClosed: [] }));
    screens["%3"] = MENU;
    const { s } = start();
    s.poll();
    expect(ids(s)).toEqual(["ny-8"]);
    at(T0 + 10 * MIN);
    s.poll();
    expect(ids(s).sort()).toEqual(["menu-3", "ny-8"]);
  });
});
