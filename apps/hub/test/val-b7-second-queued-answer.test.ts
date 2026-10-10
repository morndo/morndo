// Validation of review finding B7 (escalation-service.ts:322): #queued is keyed by escalation id, so a second answer
// queued for the same ask (after it was asked again) replaces the first one's entry. The first one, typed and delivered
// by the inbox, is then never recorded: no EscalationAnswered with its endpoint, session and time (the record of a
// Decision taken here, docs/domain.md: "recorded only after the asker has it ..., with the endpoint, session and time
// as provenance (A1)"; the #queued comment: "recorded with its provenance once delivered, even if the ask was asked
// again meanwhile"). Setup copied from escalation-inbox.test.ts.
//
// The deliverer honours a withdrawal (ctl/<key>.cancel) as manager-inbox.service does, so a fix for B1 that withdraws
// the first answer passes too: the test expects a record for each answer the inbox actually delivered.
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
const deliver = (key: string): boolean => {
  if (existsSync(join(inboxDir, "ctl", `${key}.cancel`))) { deliverer(key, { status: "cancelled" }); return false; }
  const msg = JSON.parse(readFileSync(join(inboxDir, "msg", `${key}.json`), "utf8")) as { text: string };
  manager.push(principal(`u-${key}`, now, msg.text));
  deliverer(key, { status: "delivered", deliveredAt: now });
  return true;
};
const queuedMessages = () => readdirSync(join(inboxDir, "msg")).map(f => JSON.parse(readFileSync(join(inboxDir, "msg", f), "utf8")) as { key: string; text: string; enqueuedAt: number });
const answers = () => store.auditOf("EscalationAnswered", 0) as unknown as { choice: { key?: string }; sessionId: string; at: number }[];
const BUTTONS = "[buttons ny-176] deploy-morndo=Go live after the review | hold=Hold";

beforeEach(() => {
  now = T0;
  dir = mkdtempSync(join(tmpdir(), "morndo-val-b7-"));
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

describe("B7: two answers queued for one ask (asked again in between)", () => {
  it("each one the inbox delivers is recorded, with its own choice and the time it reached the manager", async () => {
    const s = service();
    s.poll();
    expect((await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1")).ok).toBe(true);
    now += 10_000;
    manager.push(agent("m2", now, `Restated after the hotfix: still go live today?\n\n${BUTTONS}`));
    now += 1_000; s.poll();
    expect((await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-2")).ok).toBe(true);
    expect(sent).toEqual([]);
    const msgs = queuedMessages().sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    expect(msgs.map(m => m.text)).toEqual(["[tap ny-176] deploy-morndo (Go live after the review)", "[tap ny-176] hold (Hold)"]);

    now += MIN;
    const delivered = msgs.filter(m => deliver(m.key));                    // oldest first, as the inbox goes
    s.poll();
    const choiceOf = (m: { text: string }) => (m.text.includes("deploy-morndo") ? "deploy-morndo" : "hold");
    const byText = (a?: string, b?: string) => String(a).localeCompare(String(b));
    expect(answers().map(a => a.choice.key).sort(byText)).toEqual(delivered.map(choiceOf).sort(byText));
  });

  it("control: the first answer withdrawn before the inbox types it, only the second is delivered and recorded", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1");
    const [first] = queuedMessages();
    if (!first) throw new Error("nothing was queued");
    const keyA = first.key;
    now += 10_000;
    manager.push(agent("m2", now, `Restated after the hotfix: still go live today?\n\n${BUTTONS}`));
    now += 1_000; s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-2");
    mkdirSync(join(inboxDir, "ctl"), { recursive: true });
    writeFileSync(join(inboxDir, "ctl", `${keyA}.cancel`), "");
    now += MIN;
    const delivered = queuedMessages().sort((a, b) => a.enqueuedAt - b.enqueuedAt).filter(m => deliver(m.key));
    s.poll();
    expect(delivered.map(m => m.text)).toEqual(["[tap ny-176] hold (Hold)"]);
    expect(answers().map(a => a.choice.key)).toEqual(["hold"]);
  });
});
