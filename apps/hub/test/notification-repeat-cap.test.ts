// T-507: a manager pane that shows a dialog for a moment on every 2-minute guard round, with one more Decision open,
// pushed the same "2 decisions" Notification seven times in fifteen minutes (2026-10-27). An unchanged Decision push
// repeats at most once per hour per card; a new card or changed counts still pushes at once. A fake clock, a fake sender.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationEvent } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { EscalationService, type Watch } from "../src/application/escalation-service.ts";
import { NotificationService, type PushStore } from "../src/application/notification-service.ts";

const T0 = Date.UTC(2026, 9, 27, 7);
const MIN = 60_000;
const DIALOG = "work…\n Background tasks are still running. Exit anyway?\n ❯ 1. Yes\n   2. No\n Esc to cancel\n\n";
let dir: string;
let store: Store;
let ledgerPath: string;
let screens: Record<string, string>;
let audit: NotificationEvent[];
let services: { stop(): void }[];

const at = (t: number) => vi.setSystemTime(t);
const watch: Watch = {
  workers: () => [{ id: "%0", name: "manager" }],
  history: () => [],
  openQuestions: () => [],
  screen: id => screens[id],
};
const pushes: PushStore = {
  pushSubscriptions: () => [{ endpointId: "phone", endpoint: "https://fcm.googleapis.com/fcm/send/phone", p256dh: "k", auth: "a" }],
  savePushSubscription: () => {},
  deletePushSubscription: () => false,
  record: e => { audit.push(...e); },
};
const start = () => {
  const s = new EscalationService({ watch, ledger: ledgerReader(ledgerPath, () => Date.now()), store, managerName: "manager", now: () => Date.now(), send: async () => ({ problem: null, typedAt: Date.now() }) });
  const n = new NotificationService({ store: pushes, send: async () => ({ status: 201 }) });
  n.board(s.board().items);
  s.subscribe(b => n.board(b.items));
  services.push(n);
  return { s, n };
};
const item = (id: string) => ({ id, kind: "tap", question: `Question ${id}?`, default: "yes" });
const sentDecisions = () => audit.filter(e => e.type === "NotificationSent" && e.kind === "decision");
const settle = async (n: NotificationService) => { await vi.advanceTimersByTimeAsync(2000); await n.settled(); };

// One guard round: its exit attempt puts a dialog on the manager's pane, the round ends and the dialog is gone.
const guardRound = async (s: EscalationService, n: NotificationService, t: number) => {
  at(t); screens["%0"] = DIALOG; s.poll();
  await settle(n);
  at(t + 3_000); screens["%0"] = "❯ "; s.poll();
  await settle(n);
};

beforeEach(() => {
  vi.useFakeTimers();
  at(T0);
  dir = mkdtempSync(join(tmpdir(), "morndo-repeat-"));
  store = new Store(dir);
  ledgerPath = join(dir, "ledger.json");
  screens = { "%0": "❯ " }; audit = []; services = [];
  writeFileSync(ledgerPath, JSON.stringify({ needsYou: [item("ny-1")], needsYouClosed: [] }));
});
afterEach(() => { for (const s of services) s.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

describe("a card that closes and opens again with nothing changed", () => {
  it("guard rounds every 2 minutes for 15 minutes push once, not seven times", async () => {
    const { s, n } = start();
    s.poll();
    for (let i = 0; i < 8; i++) await guardRound(s, n, T0 + 10 * MIN + i * 2 * MIN);
    const sent = sentDecisions();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ counts: { decisions: 2 } });
  });

  it("pushes again once an hour has passed", async () => {
    const { s, n } = start();
    s.poll();
    await guardRound(s, n, T0 + 10 * MIN);
    await guardRound(s, n, T0 + 12 * MIN);
    expect(sentDecisions()).toHaveLength(1);
    await guardRound(s, n, T0 + 71 * MIN);
    expect(sentDecisions()).toHaveLength(2);
  });

  it("a new card still pushes at once", async () => {
    const { s, n } = start();
    s.poll();
    await guardRound(s, n, T0 + 10 * MIN);
    await guardRound(s, n, T0 + 12 * MIN);
    expect(sentDecisions()).toHaveLength(1);
    at(T0 + 13 * MIN);
    writeFileSync(ledgerPath, JSON.stringify({ needsYou: [item("ny-1"), item("ny-2")], needsYouClosed: [] }));
    s.poll();
    await settle(n);
    expect(sentDecisions()).toHaveLength(2);
  });

  it("changed counts push at once: the other card was answered, then the dialog card comes back", async () => {
    const { s, n } = start();
    s.poll();
    await guardRound(s, n, T0 + 10 * MIN);
    expect(sentDecisions()).toHaveLength(1);
    at(T0 + 12 * MIN);
    writeFileSync(ledgerPath, JSON.stringify({ needsYou: [], needsYouClosed: [{ id: "ny-1", closedAt: Date.now() }] }));
    s.poll();
    await guardRound(s, n, T0 + 14 * MIN);
    expect(sentDecisions()).toHaveLength(2);
    expect(sentDecisions()[1]).toMatchObject({ counts: { decisions: 1 } });
  });
});
