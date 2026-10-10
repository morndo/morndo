// Validation of review finding B6 (escalation-service.ts:88): queued Decisions are loaded into #queued on restart even
// when no inbox is configured; #deliveries returns early, so they never become delivered or withdrawn. Scenario: the
// documented kill switch "leaving MORNDO_MANAGER_INBOX unset" (ADR-0010 point 5) applied while an answer is queued.
// Setup copied from escalation-inbox.test.ts.
// Expectations rewritten for option (b), the manager's decision (2026-10-04, manager-approved): the hub keeps reading
// the inbox the answer went to. Until it resolves, the answer counts as given; delivered, it is recorded once; given up
// (expired, or cancelled by hand), the ask can be answered again. The setup and the steps up to the restart are unchanged.
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
const watch: Watch = { workers: () => [{ id: "%0", name: "manager" }], history: id => (id === "%0" ? manager : []), openQuestions: () => [], screen: () => undefined };
const service = (inbox = true) => new EscalationService({
  watch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
  send: async (pane, text) => { sent.push({ pane, text }); return { problem: null, typedAt: now }; },
  inbox: inbox ? managerInbox(inboxDir, () => now) : null,
});
const queuedMessages = () => readdirSync(join(inboxDir, "msg")).map(f => JSON.parse(readFileSync(join(inboxDir, "msg", f), "utf8")));
// The deliverer's side of the contract: it alone writes state/<key>.json.
const deliverer = (key: string, state: Record<string, unknown>) => {
  mkdirSync(join(inboxDir, "state"), { recursive: true });
  writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ v: 1, key, attempts: 1, updatedAt: now, ...state }));
};
const answers = () => store.auditOf("EscalationAnswered", 0);

beforeEach(() => {
  now = T0;
  dir = mkdtempSync(join(tmpdir(), "morndo-val-b6-"));
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

// The scenario's steps, unchanged: answer while the inbox is configured, then restart without it and poll for 100 min.
const answeredThenRestarted = async () => {
  const s = service();
  s.poll();
  expect((await s.answer(auth(), "ny-176", { kind: "option", key: "deploy-morndo" }, "req-1")).ok).toBe(true);
  expect(queuedMessages()).toHaveLength(1);
  s.stop();
  store.close(); store = new Store(dir);              // restart on the same SQLite file, inbox not configured
  const again = service(false);
  for (let i = 0; i < 10; i++) { now += 10 * MIN; again.poll(); }   // well past any poll the hub would make
  return { again, key: queuedMessages()[0].key as string };
};

describe("B6: restart with MORNDO_MANAGER_INBOX unset while an answer is queued (option b)", () => {
  it("the queued answer still counts (queued, already_answered), and is recorded once its inbox reports it delivered", async () => {
    const { again, key } = await answeredThenRestarted();
    const item = again.board().items.find(i => i.id === "ny-176");
    const retry = await again.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-2");
    const observed = { status: item?.status, delivery: item?.decision?.delivery?.state, answerable: item?.answerable, retry: retry.ok ? "ok" : retry.problem };
    expect(observed).toEqual({ status: "answered", delivery: "queued", answerable: "already_answered", retry: "already_answered" });
    expect(queuedMessages()).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(answers()).toEqual([]);
    deliverer(key, { status: "delivered", deliveredAt: now + 1_000 });
    now += MIN; again.poll();
    now += MIN; again.poll();
    expect(again.board().items.find(i => i.id === "ny-176")?.decision?.delivery).toEqual({ state: "delivered", at: now - 2 * MIN + 1_000 });
    expect(answers()).toHaveLength(1);
  });

  for (const given of ["expired", "cancelled"] as const) {
    it(`given up by its inbox (${given}): the ask can be answered again`, async () => {
      const { again, key } = await answeredThenRestarted();
      deliverer(key, { status: given });
      now += MIN; again.poll();
      expect(again.board().items.find(i => i.id === "ny-176")).toMatchObject({ status: "open", decision: null, answerable: null });
      expect(answers()).toEqual([]);
      expect((await again.answer(auth(), "ny-176", { kind: "option", key: "hold" }, "req-2")).ok).toBe(true);
      expect(sent).toEqual([{ pane: "%0", text: "[tap ny-176] hold (Hold)" }]);   // no inbox configured now: typed directly
    });
  }
});
