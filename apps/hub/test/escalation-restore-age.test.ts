// Issue #20: a hub restart restores a Decision for every ask still open, whatever its age. Before, Store.decisions()
// loaded only the last 7 days, so a manager's list item answered 8 days ago, still open while the manager works on it,
// came back as "to decide" after a restart (2026-10-08, ny-21). Only a menu on a screen (`menu-…`) keeps the 7-day
// window: a legacy pane id comes back on a later pane, and its old answer must not answer that pane's new menu (fleet
// core §4). Synthetic list, conversation and screens; the decisions rows are dated back in the hub's own database.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKER_ASK_GRACE_MS, endpointId, sessionId, type Decision } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { EscalationService, type Watch } from "../src/application/escalation-service.ts";
import type { Authenticated } from "../src/application/access-service.ts";

const DAY = 24 * 3_600_000;
const T0 = Date.UTC(2026, 9, 1, 4, 46);
const MENU = "Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel";
let now = T0;
let dir: string;
let store: Store;
let ledgerPath: string;
let sent: { pane: string; text: string }[];
let screens: Record<string, string>;

const auth = (): Authenticated => ({
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: now, lastSeenAt: now, verifiedAt: now, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: now, revokedAt: null },
});
// The manager (%0) and a worker (%3) whose screen may show a menu: a legacy hub's panes.
const watch: Watch = {
  workers: () => [{ id: "%0", name: "manager" }, { id: "%3", name: "builder" }],
  history: () => [],
  openQuestions: () => [],
  screen: id => screens[id],
};
// A hub start: a new service on the same database, as main.ts builds it.
const start = () => new EscalationService({
  watch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
  send: async (pane, text) => { sent.push({ pane, text }); return { problem: null, typedAt: now }; },
});
const item = (s: EscalationService, id: string) => s.board().items.find(i => i.id === id);
// A decisions row dated `days` back on the hub's clock (Store.saveDecision stamps Date.now()).
const age = (id: string, days: number) => store.db.prepare("UPDATE decisions SET at = ? WHERE escalation_id = ?").run(Date.now() - days * DAY, id);

beforeEach(() => {
  now = T0;
  dir = mkdtempSync(join(tmpdir(), "morndo-restore-age-"));
  store = new Store(dir);
  ledgerPath = join(dir, "ledger.json");
  sent = [];
  screens = { "%0": "❯ ", "%3": "❯ " };
  // ny-21 is a list item without buttons: the manager keeps it open while it works on the answer.
  writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-21", kind: "tap", question: "Pick the launch date", default: "next Monday" }], needsYouClosed: [] }));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("a restart restores the answers to asks still open, whatever their age (issue #20)", () => {
  it("a list item answered 8 days ago and still open is still answered after a restart; a second answer is refused", async () => {
    const before = start();
    before.poll();
    expect(await before.answer(auth(), "ny-21", { kind: "words", text: "Monday the 12th" }, "r1")).toMatchObject({ ok: true });
    expect(sent).toEqual([{ pane: "%0", text: "About ny-21: Monday the 12th" }]);
    age("ny-21", 8);
    now = T0 + 8 * DAY + 22_000;                          // the hub restarts 22 s after the answer turned 7 days old
    const after = start();
    after.poll();
    expect(item(after, "ny-21")).toMatchObject({ status: "answered", decision: { choice: { kind: "words" }, via: "here" } });
    expect(await after.answer(auth(), "ny-21", { kind: "words", text: "Tuesday instead" }, "r2")).toMatchObject({ ok: false, problem: "already_answered" });
    expect(sent).toHaveLength(1);
  });

  it("an answer to a menu on a screen 8 days old is not restored: that pane's new menu is a new ask (negative control)", () => {
    const old: Decision = { choice: { kind: "option", key: "1", label: "Yes" }, at: T0, via: "here", endpointId: endpointId("ep1"), sessionId: sessionId("s1") };
    store.saveDecision("menu-3", old);
    age("menu-3", 8);
    now = T0 + 8 * DAY;
    screens["%3"] = MENU;                                 // a later pane %3 shows a menu of its own
    const after = start();
    after.poll();                                         // first sight; a worker's menu waits WORKER_ASK_GRACE_MS (N2)
    now += WORKER_ASK_GRACE_MS;
    after.poll();
    expect(item(after, "menu-3")).toMatchObject({ status: "open", decision: null });
  });

  it("an answer to a menu within its 7 days is still restored (the window stays for menus)", () => {
    const recent: Decision = { choice: { kind: "option", key: "1", label: "Yes" }, at: T0, via: "here", endpointId: endpointId("ep1"), sessionId: sessionId("s1") };
    store.saveDecision("menu-3", recent);
    age("menu-3", 6);
    now = T0 + 6 * DAY;
    screens["%3"] = MENU;
    const after = start();
    after.poll();                                         // first sight; a worker's menu waits WORKER_ASK_GRACE_MS (N2)
    now += WORKER_ASK_GRACE_MS;
    after.poll();
    expect(item(after, "menu-3")).toMatchObject({ status: "answered", decision: { choice: { key: "1" } } });
  });
});
