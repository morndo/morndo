// Validation of review finding B8 (escalation-service.ts:323): the stored Decision body carries untyped "inbox" (the key)
// and "words" ({length, digest}) fields; after a restart they flow through restore() into Escalation.decision, so board()
// (sent verbatim by GET /api/escalations, http.ts:330, and the feed's "decisions" frame, http.ts:427/453) carries them.
// Setup copied from escalation-inbox.test.ts.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
let manager: Message[];

const auth = (): Authenticated => ({
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: now, lastSeenAt: now, verifiedAt: now, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Phone", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: now, revokedAt: null },
});
const agent = (id: string, at: number, text: string): Message => ({ id, at, author: { kind: "agent", name: "manager" }, kind: "text", text });
const watch: Watch = { workers: () => [{ id: "%0", name: "manager" }], history: id => (id === "%0" ? manager : []), openQuestions: () => [], screen: () => undefined };
const service = () => new EscalationService({
  watch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
  send: async () => ({ problem: null, typedAt: now }), inbox: managerInbox(inboxDir, () => now),
});
const deliverer = (key: string, state: Record<string, unknown>) => {
  mkdirSync(join(inboxDir, "state"), { recursive: true });
  writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ v: 1, key, attempts: 1, updatedAt: now, ...state }));
};
const queuedMessages = () => readdirSync(join(inboxDir, "msg")).map(f => JSON.parse(readFileSync(join(inboxDir, "msg", f), "utf8")));
// The Decision fields the domain and the protocol declare (packages/domain/src/escalation.ts Decision;
// packages/protocol/src/feed.ts DecisionItemSchema.decision).
const DECLARED = ["choice", "at", "via", "endpointId", "sessionId", "delivery"];
const WORDS = "The rewrite is Quinn's task";
const DIGEST = createHash("sha256").update(WORDS).digest("hex").slice(0, 16);

beforeEach(() => {
  now = T0;
  dir = mkdtempSync(join(tmpdir(), "morndo-val-b8-"));
  inboxDir = join(dir, "manager-inbox");
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: now }));
  store = new Store(dir);
  ledgerPath = join(dir, "ledger.json");
  manager = [agent("m1", T0 - MIN, "Anything else?")];
  writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-175", kind: "words", question: "The rewrite?" }], needsYouClosed: [] }));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("B8: undeclared Decision fields after a restart", () => {
  it("queued, then restart: board() (what /api/escalations and the feed send) carries only declared Decision fields", async () => {
    const s = service();
    s.poll();
    expect((await s.answer(auth(), "ny-175", { kind: "words", text: WORDS }, "req-3")).ok).toBe(true);
    const before = s.board().items.find(i => i.id === "ny-175")?.decision ?? {};
    expect(Object.keys(before).filter(k => !DECLARED.includes(k))).toEqual([]);     // same process: clean
    s.stop();
    store.close(); store = new Store(dir);
    const again = service();
    again.poll();
    const decision = again.board().items.find(i => i.id === "ny-175")?.decision ?? {};
    const wire = JSON.stringify(again.board());                                      // http.ts:160 json() body
    expect({ extra: Object.keys(decision).filter(k => !DECLARED.includes(k)), digestOnWire: wire.includes(DIGEST), keyOnWire: wire.includes(queuedMessages()[0].key) })
      .toEqual({ extra: [], digestOnWire: false, keyOnWire: false });
  });

  it("delivered after the restart, then another restart: the delivered Decision on the board is still clean", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-175", { kind: "words", text: WORDS }, "req-3");
    const key = queuedMessages()[0].key as string;
    s.stop();
    store.close(); store = new Store(dir);
    const again = service();
    again.poll();
    deliverer(key, { status: "delivered", deliveredAt: now + 1_000 });
    now += MIN; again.poll();
    again.stop();
    store.close(); store = new Store(dir);
    const third = service();
    third.poll();
    const decision = third.board().items.find(i => i.id === "ny-175")?.decision;
    expect({ state: decision?.delivery?.state, extra: Object.keys(decision ?? {}).filter(k => !DECLARED.includes(k)) }).toEqual({ state: "delivered", extra: [] });
  });
});
