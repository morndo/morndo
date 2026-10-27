// T-507: a manager pane that shows a dialog for a moment on every 2-minute guard round, with one more Decision open,
// pushed the same "2 decisions" Notification seven times in fifteen minutes (2026-10-27). An unchanged Decision push
// repeats at most once per hour per card and content; a new card, another prompt or changed counts still pushes at
// once; only a push that was sent starts the hour. A fake clock, a fake sender.
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
const OTHER = "work…\n Drop the production table? This cannot be undone.\n ❯ 1. Yes\n   2. No\n Esc to cancel\n\n";
const DIALOG = "work…\n Background tasks are still running. Exit anyway?\n ❯ 1. Yes\n   2. No\n Esc to cancel\n\n";
let dir: string;
let store: Store;
let ledgerPath: string;
let screens: Record<string, string>;
let audit: NotificationEvent[];
let services: { stop(): void }[];
let status: number;

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
// A hub start, as main.ts builds it: a service on the database, its board and each card's content fed to the Notification service.
const start = () => {
  const s = new EscalationService({ watch, ledger: ledgerReader(ledgerPath, () => Date.now()), store, managerName: "manager", now: () => Date.now(), send: async () => ({ problem: null, typedAt: Date.now() }) });
  const n = new NotificationService({ store: pushes, send: async () => ({ status }) });
  const feed = (items: readonly { id: string; status: string; need: string }[]) => n.board(items.map(i => ({ id: i.id, status: i.status, need: i.need, content: s.content(i.id) })));
  feed(s.board().items);
  s.subscribe(b => feed(b.items));
  services.push(n);
  return { s, n };
};
const item = (id: string) => ({ id, kind: "tap", question: `Question ${id}?`, default: "yes" });
const sentDecisions = () => audit.filter(e => e.type === "NotificationSent" && e.kind === "decision");
const settle = async (n: NotificationService) => { await vi.advanceTimersByTimeAsync(2000); await n.settled(); };

// One guard round: its exit attempt puts a dialog on the manager's pane, the round ends and the dialog is gone.
const guardRound = async (s: EscalationService, n: NotificationService, t: number, dialog = DIALOG) => {
  at(t); screens["%0"] = dialog; s.poll();
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
  screens = { "%0": "❯ " }; audit = []; services = []; status = 201;
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

describe("what starts the hour, and what is the same card (review of PR 187)", () => {
  it("a push that failed starts no hour: the same card coming back pushes again", async () => {
    const { s, n } = start();
    s.poll();
    status = 500;
    await guardRound(s, n, T0 + 10 * MIN);
    expect(sentDecisions()).toHaveLength(0);
    status = 201;
    await guardRound(s, n, T0 + 12 * MIN);
    expect(sentDecisions()).toHaveLength(1);
    await guardRound(s, n, T0 + 14 * MIN);
    expect(sentDecisions()).toHaveLength(1);
  });

  it("another prompt on the same worker with the same count is a new question and pushes at once; the first one flickering is still capped", async () => {
    const { s, n } = start();
    s.poll();
    await guardRound(s, n, T0 + 10 * MIN);
    await guardRound(s, n, T0 + 12 * MIN);
    expect(sentDecisions()).toHaveLength(1);
    await guardRound(s, n, T0 + 14 * MIN, OTHER);
    expect(sentDecisions()).toHaveLength(2);
    await guardRound(s, n, T0 + 16 * MIN, OTHER);
    await guardRound(s, n, T0 + 18 * MIN);
    await guardRound(s, n, T0 + 20 * MIN, OTHER);
    expect(sentDecisions()).toHaveLength(2);
  });

  it("the same prompt that changes only where the pane was scrolled is the same card", async () => {
    const { s, n } = start();
    s.poll();
    await guardRound(s, n, T0 + 10 * MIN, "output 1\n" + DIALOG);
    await guardRound(s, n, T0 + 12 * MIN, "other output 99\nand more\n" + DIALOG);
    expect(sentDecisions()).toHaveLength(1);
  });
});

// The service alone: items as the board gives them, a fake clock. "s" is a card that stays open, so two cards wait
// whenever one of the others does.
describe("the cap on the Notification service", () => {
  let sentTo: unknown[];
  let made: NotificationService[];
  const card = (id: string, content = "words") => ({ id, status: "open", need: "decision", content });
  const tick = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); for (const m of made) await m.settled(); };
  const make = (first: ReturnType<typeof card>[]) => {
    const n = new NotificationService({ store: pushes, send: async (_s, payload) => { sentTo.push(JSON.parse(payload.toString())); return { status: 201 }; } });
    n.board(first);
    made.push(n);
    return n;
  };
  beforeEach(() => { sentTo = []; made = []; });
  afterEach(() => { for (const m of made) m.stop(); });

  it("a mixed update, a new card with a repeat one, pushes once and keeps the repeat card's original hour", async () => {
    const svc = make([card("s")]);
    svc.board([card("s"), card("a")]); await tick(1000);               // a is pushed for at 0
    svc.board([card("s")]); await tick(30 * MIN);
    svc.board([card("s"), card("b")]); await tick(1000);               // b at 30 minutes
    svc.board([card("s")]); await tick(10 * MIN);
    expect(sentTo).toHaveLength(2);
    svc.board([card("a"), card("c")]); await tick(1000);               // at 40 minutes: a repeats, c is new
    expect(sentTo).toHaveLength(3);
    svc.board([card("c")]); await tick(22 * MIN);
    svc.board([card("c"), card("a")]); await tick(1000);               // at 62 minutes a's own hour is over: the mixed update did not extend it
    expect(sentTo).toHaveLength(4);
  });

  it("two cards that change in one update: two repeats raise nothing, two new ones raise one", async () => {
    const svc = make([card("s")]);
    svc.board([card("s"), card("a")]); await tick(1000);
    svc.board([card("s")]); await tick(MIN);
    svc.board([card("s"), card("b")]); await tick(1000);
    svc.board([card("s")]); await tick(MIN);
    expect(sentTo).toHaveLength(2);
    svc.board([card("a"), card("b")]); await tick(1000);               // both back, both pushed for within the hour, two waiting as then
    expect(sentTo).toHaveLength(2);
    svc.board([]); await tick(MIN);
    svc.board([card("x"), card("y")]); await tick(1000);
    expect(sentTo).toHaveLength(3);
  });

  it("a hub restart forgets the hour but raises nothing on its first board: the card's next return pushes once, then is capped", async () => {
    const before = make([card("s")]);
    before.board([card("s"), card("a")]); await tick(1000);
    expect(sentTo).toHaveLength(1);
    before.stop();
    const after = make([card("s"), card("a")]);                        // the first board after the restart: a already waits
    await tick(5000);
    expect(sentTo).toHaveLength(1);
    after.board([card("s")]); await tick(MIN);
    after.board([card("s"), card("a")]); await tick(1000);
    expect(sentTo).toHaveLength(2);
    after.board([card("s")]); await tick(MIN);
    after.board([card("s"), card("a")]); await tick(1000);
    expect(sentTo).toHaveLength(2);
  });
});
