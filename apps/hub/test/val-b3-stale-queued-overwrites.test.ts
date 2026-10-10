// Validation of review finding B3 (escalation-service.ts:152 and :159): when the inbox finishes an answer that is no
// longer the ask's Decision (it was asked again and answered anew meanwhile), #deliveries still writes the store by
// escalation id: cancelled/expired drops the newer Decision's row, delivered replaces it with the old one. A restart
// then no longer knows the newer Decision. Setup copied from escalation-inbox.test.ts.
//
// The restart is checked with the manager's conversation moved on (the typed tap out of the hub's last 300 messages, or
// a new manager session): while the tap is still in view, the restarted hub shows it as "answered elsewhere" instead.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId, type Message } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { managerInbox } from "../src/adapters/manager-inbox.ts";
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
const service = () => new EscalationService({
  watch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
  // Typed directly: the line shows in the manager's conversation as the principal's.
  send: async (pane, text) => { sent.push({ pane, text }); manager.push(principal(`typed-${sent.length}`, now, text)); return { problem: null, typedAt: now }; },
  inbox: managerInbox(inboxDir, () => now),
});
const deliverer = (key: string, state: Record<string, unknown>) => {
  mkdirSync(join(inboxDir, "state"), { recursive: true });
  writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ v: 1, key, attempts: 1, updatedAt: now, ...state }));
};
const queuedMessages = () => readdirSync(join(inboxDir, "msg")).map(f => JSON.parse(readFileSync(join(inboxDir, "msg", f), "utf8")));
const stored = () => store.decisions().map(d => ({ id: d.id, key: (d.decision as { choice: { key?: string } }).choice.key }));
const BUTTONS = "[buttons ny-176] deploy-morndo=Go live after the review | hold=Hold";

beforeEach(() => {
  now = T0;
  dir = mkdtempSync(join(tmpdir(), "morndo-val-b3-"));
  inboxDir = join(dir, "manager-inbox");
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: now }));
  store = new Store(dir);
  ledgerPath = join(dir, "ledger.json");
  sent = [];
  manager = [agent("m1", T0 - MIN, `Ready to go live.\n\n${BUTTONS}`)];
  writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-176", kind: "tap", question: "Deploy Morndo?" }], needsYouClosed: [] }));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

// A queued; the ask asked again; the deliverer's heartbeat goes stale, so B is typed directly and recorded.
async function answeredAnewWhileAWaits(s: EscalationService) {
  s.poll();
  expect((await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1")).ok).toBe(true);
  const keyA = queuedMessages()[0].key as string;
  now += MIN;
  manager.push(agent("m2", now, `Restated after the hotfix: still go live today?\n\n${BUTTONS}`));
  now += MIN; s.poll();                                                    // T0+2min: heartbeat (T0) older than 90 s
  expect((await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-2")).ok).toBe(true);
  expect(sent).toEqual([{ pane: "%0", text: "[tap ny-176] hold (Hold)" }]);
  expect(stored()).toEqual([{ id: "ny-176", key: "hold" }]);
  return keyA;
}

describe("B3: the inbox finishing an answer that was replaced leaves the newer Decision alone", () => {
  it("cancelled: B's stored row survives, and a restart still has the ask answered", async () => {
    const s = service();
    const keyA = await answeredAnewWhileAWaits(s);
    now += MIN;
    deliverer(keyA, { status: "cancelled" });                              // A cancelled by hand
    s.poll();
    expect(s.board().items.find(i => i.id === "ny-176")).toMatchObject({ status: "answered", decision: { choice: { key: "hold" } } });
    expect.soft(stored()).toEqual([{ id: "ny-176", key: "hold" }]);       // soft: the restart below is checked too

    manager = [];                                                          // the conversation moved on
    const again = service();
    again.poll();
    expect(again.board().items.find(i => i.id === "ny-176")).toMatchObject({ status: "answered", answerable: "already_answered" });
  });

  it("delivered late: the old answer doesn't replace B's stored row", async () => {
    const s = service();
    const keyA = await answeredAnewWhileAWaits(s);
    now += MIN;
    writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: now }));   // the deliverer is back
    deliverer(keyA, { status: "delivered", deliveredAt: now });            // and had typed A already
    s.poll();
    expect(stored()).toEqual([{ id: "ny-176", key: "hold" }]);
  });

  it("control: without the inbox finishing A, B's row is there and a restart has the ask answered", async () => {
    const s = service();
    await answeredAnewWhileAWaits(s);
    now += MIN;
    s.poll();
    expect(stored()).toEqual([{ id: "ny-176", key: "hold" }]);
    manager = [];
    const again = service();
    again.poll();
    expect(again.board().items.find(i => i.id === "ny-176")).toMatchObject({ status: "answered", answerable: "already_answered" });
  });
});
