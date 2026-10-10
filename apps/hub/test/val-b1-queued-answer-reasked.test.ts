// Validation of review finding B1 (escalation-service.ts:322): an answer still queued in the manager's inbox when its
// ask is asked again is neither withdrawn nor kept apart from the new question. The inbox types the old tap later, and
// #managerSightings takes it as the answer to the restated question (E11: the earlier Decision doesn't answer the new
// question; E12: it never answers a question the principal didn't see). Setup copied from escalation-inbox.test.ts.
//
// The deliverer is played as manager-inbox.service does it: a withdrawal the hub
// may ask for (ctl/<key>.cancel, the inbox's one way to drop a message) is applied before typing; otherwise the line is
// typed, shows in the manager's conversation as the principal's, and is reported delivered. So the test holds for a fix
// that withdraws the old answer and for one that keeps it from answering the new question.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  send: async (pane, text) => { sent.push({ pane, text }); return { problem: null, typedAt: now }; },
  inbox: managerInbox(inboxDir, () => now),
});
const deliverer = (key: string, state: Record<string, unknown>) => {
  mkdirSync(join(inboxDir, "state"), { recursive: true });
  writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ v: 1, key, attempts: 1, updatedAt: now, ...state }));
};
// One deliverer round for this message: a cancel request wins; else typed, in the conversation, delivered.
const deliver = (key: string): boolean => {
  if (existsSync(join(inboxDir, "ctl", `${key}.cancel`))) { deliverer(key, { status: "cancelled" }); return false; }
  const msg = JSON.parse(readFileSync(join(inboxDir, "msg", `${key}.json`), "utf8")) as { text: string };
  manager.push(principal(`u-${key}`, now, msg.text));
  deliverer(key, { status: "delivered", deliveredAt: now });
  return true;
};
const queuedMessages = () => readdirSync(join(inboxDir, "msg")).map(f => JSON.parse(readFileSync(join(inboxDir, "msg", f), "utf8")));
const BUTTONS = "[buttons ny-176] deploy-morndo=Go live after the review | hold=Hold";

beforeEach(() => {
  now = T0;
  dir = mkdtempSync(join(tmpdir(), "morndo-val-b1-"));
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

describe("B1: an answer queued before its ask was asked again", () => {
  it("never answers the restated question (E11, E12): it stays open and the principal can answer it", async () => {
    const s = service();
    s.poll();
    expect((await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1")).ok).toBe(true);
    const key = queuedMessages()[0].key as string;
    deliverer(key, { status: "held", reason: "foreign_text" });            // waits: someone's text in the box
    now += MIN;
    manager.push(agent("m2", now, `Restated after the hotfix: still go live today?\n\n${BUTTONS}`));
    now += 1_000; s.poll();
    // Asked again: open, the earlier answer doesn't count (E11). This part holds at the reviewed head.
    expect(s.board().items.find(i => i.id === "ny-176")).toMatchObject({ status: "open", decision: null, askedAgain: true });

    now += MIN;
    deliver(key);                                                          // the box is clear again: the inbox goes on
    s.poll();
    // The restated question is still open: the old tap is not its answer, and the principal can give one.
    expect(s.board().items.find(i => i.id === "ny-176")).toMatchObject({ status: "open", decision: null, answerable: null });
    expect(await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-2")).toMatchObject({ ok: true });
  });

  it("control: the same steps with the old answer withdrawn (a cancel request, as `manager-inbox cancel` files it) pass", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1");
    const key = queuedMessages()[0].key as string;
    now += MIN;
    manager.push(agent("m2", now, `Restated after the hotfix: still go live today?\n\n${BUTTONS}`));
    now += 1_000; s.poll();
    mkdirSync(join(inboxDir, "ctl"), { recursive: true });
    writeFileSync(join(inboxDir, "ctl", `${key}.cancel`), "");
    now += MIN;
    expect(deliver(key)).toBe(false);
    s.poll();
    expect(s.board().items.find(i => i.id === "ny-176")).toMatchObject({ status: "open", decision: null, answerable: null });
    expect(await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-2")).toMatchObject({ ok: true });
  });
});
