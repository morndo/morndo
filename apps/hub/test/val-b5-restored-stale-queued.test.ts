// Validation of review finding B5 (escalation-service.ts:150): after a restart the queued Decision also sits in
// Escalations.#restored. If the inbox reports it delivered or cancelled before the ask is first sighted (here: the hub
// restarts while the manager isn't running), the fallback updates only a copy / withdraw() finds nothing, and the later
// sighting brings the stale "queued" Decision back. Setup copied from escalation-inbox.test.ts.
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
let running: boolean;

const auth = (): Authenticated => ({
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: now, lastSeenAt: now, verifiedAt: now, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Phone", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: now, revokedAt: null },
});
const agent = (id: string, at: number, text: string): Message => ({ id, at, author: { kind: "agent", name: "manager" }, kind: "text", text });
const principal = (id: string, at: number, text: string): Message => ({ id, at, author: { kind: "principal", name: "You" }, kind: "text", text });
const watch: Watch = {
  workers: () => (running ? [{ id: "%0", name: "manager" }] : []),
  history: id => (id === "%0" ? manager : []), openQuestions: () => [], screen: () => undefined,
};
const service = () => new EscalationService({
  watch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
  send: async (pane, text) => { sent.push({ pane, text }); return { problem: null, typedAt: now }; },
  inbox: managerInbox(inboxDir, () => now),
});
const restart = () => { store.close(); store = new Store(dir); return service(); };   // same SQLite file, new objects
const deliverer = (key: string, state: Record<string, unknown>) => {
  mkdirSync(join(inboxDir, "state"), { recursive: true });
  writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ v: 1, key, attempts: 1, updatedAt: now, ...state }));
};
const queuedMessages = () => readdirSync(join(inboxDir, "msg")).map(f => JSON.parse(readFileSync(join(inboxDir, "msg", f), "utf8")));
const answers = () => store.auditOf("EscalationAnswered", 0);

beforeEach(() => {
  now = T0;
  running = true;
  dir = mkdtempSync(join(tmpdir(), "morndo-val-b5-"));
  inboxDir = join(dir, "manager-inbox");
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: now }));
  store = new Store(dir);
  ledgerPath = join(dir, "ledger.json");
  sent = [];
  // A button message whose id isn't on the list ("age" tracking): sighted only from the manager's conversation.
  manager = [agent("m1", T0 - MIN, "Ship the hotfix?\n\n[buttons ship-1] go=Go | hold=Hold")];
  writeFileSync(ledgerPath, JSON.stringify({ needsYou: [], needsYouClosed: [] }));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("B5: inbox outcome reported after a restart, before the ask is sighted again", () => {
  it("delivered: once the ask is sighted it shows delivered, not a stale 'queued' that refuses new answers", async () => {
    const s = service();
    s.poll();
    expect((await s.answer(auth(), "ship-1", { kind: "option", key: "go" }, "req-1")).ok).toBe(true);
    const key = queuedMessages()[0].key as string;
    s.stop();
    running = false;                                    // the hub restarts while the manager isn't running
    const again = restart();
    deliverer(key, { status: "delivered", deliveredAt: now + 1_000 });
    now += MIN; again.poll();                           // inbox says delivered; ship-1 not sighted (no conversation)
    expect(answers()).toHaveLength(1);                  // recorded via the fallback
    running = true;                                     // the manager is back; its conversation shows the tap
    manager.push(principal("u1", T0 + 1_000, "[tap ship-1] go (Go)"));
    now += MIN; again.poll();
    const item = again.board().items.find(i => i.id === "ship-1");
    const observed = { status: item?.status, delivery: item?.decision?.delivery, inbox: item?.inbox, answerable: item?.answerable };
    expect(item?.decision?.delivery?.state, JSON.stringify(observed)).toBe("delivered");
    expect(item?.inbox, JSON.stringify(observed)).toBeNull();
  });

  it("cancelled: once the ask is sighted it is open again (ADR-0010 point 2), not answered/queued", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ship-1", { kind: "option", key: "hold" }, "req-1");
    const key = queuedMessages()[0].key as string;
    s.stop();
    running = false;
    const again = restart();
    deliverer(key, { status: "cancelled" });
    now += MIN; again.poll();                           // withdraw() finds no item; the store row is dropped
    running = true;
    now += MIN; again.poll();
    const item = again.board().items.find(i => i.id === "ship-1");
    const observed = { status: item?.status, decision: item?.decision, inbox: item?.inbox, answerable: item?.answerable };
    expect(item, JSON.stringify(observed)).toMatchObject({ status: "open", decision: null, answerable: null, inbox: null });
    expect(answers()).toEqual([]);
  });
});
