// Validation of review finding B2 (escalation-service.ts:147): the inbox message file gone (removed, or the msg dir
// briefly unreadable) drops the hub's tracking while the Escalation keeps delivery "queued": the card says queued
// forever and every new answer is refused as already_answered. Setup copied from escalation-inbox.test.ts.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
const queuedMessages = () => readdirSync(join(inboxDir, "msg")).map(f => JSON.parse(readFileSync(join(inboxDir, "msg", f), "utf8")));
const answers = () => store.auditOf("EscalationAnswered", 0);

beforeEach(() => {
  now = T0;
  dir = mkdtempSync(join(tmpdir(), "morndo-val-b2-"));
  inboxDir = join(dir, "manager-inbox");
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: now }));
  store = new Store(dir);
  ledgerPath = join(dir, "ledger.json");
  sent = [];
  manager = [agent("m1", T0 - MIN, "Ready to go live.\n\n[buttons ny-176] deploy-morndo=Go live after the review | hold=Hold")];
  writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-176", kind: "tap", question: "Deploy Morndo?" }], needsYouClosed: [] }));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("B2: the inbox message gone", () => {
  it("removed msg file: the ask must not stay 'queued' and refuse every new answer", async () => {
    const s = service();
    s.poll();
    expect((await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1")).ok).toBe(true);
    const key = queuedMessages()[0].key as string;
    rmSync(join(inboxDir, "msg", `${key}.json`));
    now += MIN; s.poll();
    now += MIN; s.poll();
    const item = s.board().items.find(i => i.id === "ny-176");
    const observed = { status: item?.status, delivery: item?.decision?.delivery, inbox: item?.inbox, answerable: item?.answerable };
    // Correct: nothing can deliver it any more, so it is not shown as queued and the ask can be answered again.
    expect(item?.decision?.delivery?.state, JSON.stringify(observed)).not.toBe("queued");
    expect(item?.answerable, JSON.stringify(observed)).toBeNull();
  });

  it("removed msg file, then a hub restart: still not stuck as 'queued' (a restart is no way out)", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1");
    rmSync(join(inboxDir, "msg", `${queuedMessages()[0].key as string}.json`));
    now += MIN; s.poll();
    s.stop();
    store.close(); store = new Store(dir);
    const again = service();
    now += MIN; again.poll();
    const item = again.board().items.find(i => i.id === "ny-176");
    const observed = { status: item?.status, delivery: item?.decision?.delivery, inbox: item?.inbox, answerable: item?.answerable };
    expect(item?.answerable, JSON.stringify(observed)).toBeNull();
  });

  it("msg dir unreadable for one poll only: the hub keeps tracking and records the delivery once it is back", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1");
    const key = queuedMessages()[0].key as string;
    renameSync(join(inboxDir, "msg"), join(inboxDir, "msg.away"));     // one poll sees no msg dir (transient)
    now += MIN; s.poll();
    renameSync(join(inboxDir, "msg.away"), join(inboxDir, "msg"));     // back, unchanged
    deliverer(key, { status: "delivered", deliveredAt: now + 1_000 });
    now += MIN; s.poll();
    const item = s.board().items.find(i => i.id === "ny-176");
    const observed = { delivery: item?.decision?.delivery, inbox: item?.inbox, recorded: answers().length };
    expect(item?.decision?.delivery?.state, JSON.stringify(observed)).toBe("delivered");
    expect(answers(), JSON.stringify(observed)).toHaveLength(1);
  });
});
