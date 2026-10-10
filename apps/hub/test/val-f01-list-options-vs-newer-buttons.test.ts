// Validator for review finding #1: a list item that has its own options, asked again by a newer button message with
// different options. ADR-0006 ("the message supplies the options") and kira's tap rule (a tap counts only with a key of
// the message that currently holds the id) say the newest button message's options are the ones to show and type.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { endpointId, sessionId, type Message } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { EscalationService, type Watch } from "../src/application/escalation-service.ts";
import type { Authenticated } from "../src/application/access-service.ts";

const T0 = Date.UTC(2026, 9, 4, 8);
const MIN = 60_000;
let dir: string;
let store: Store;
let ledgerPath: string;
let sent: { pane: string; text: string }[];
let manager: Message[];

const auth = (): Authenticated => ({
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: T0, lastSeenAt: T0, verifiedAt: T0, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Phone", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: T0, revokedAt: null },
});
const agent = (id: string, at: number, text: string): Message => ({ id, at, author: { kind: "agent", name: "manager" }, kind: "text", text });
const watch: Watch = { workers: () => [{ id: "%0", name: "manager" }], history: id => (id === "%0" ? manager : []), openQuestions: () => [], screen: () => undefined };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-val-f01-"));
  store = new Store(dir);
  ledgerPath = join(dir, "ledger.json");
  sent = [];
  writeFileSync(ledgerPath, JSON.stringify({ needsYou: [
    { id: "ny-9", kind: "tap", question: "Ship the release?", options: [{ key: "a", label: "Ship" }, { key: "b", label: "Hold" }] },
  ], needsYouClosed: [] }));
  manager = [
    agent("m1", T0 - 10 * MIN, "Ship the release?\n\n[buttons ny-9] a=Ship | b=Hold"),
    agent("m2", T0 - MIN, "Asked again: when do you do it?\n\n[buttons ny-9] now=Doing it now | later=Later today"),
  ];
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

it("asked again with new buttons, the board shows the newest options and a tap types a key the manager offers now", async () => {
  const s = new EscalationService({ watch, ledger: ledgerReader(ledgerPath, () => T0), store, managerName: "manager", now: () => T0,
    send: async (pane, text) => { sent.push({ pane, text }); return { problem: null, typedAt: 0 }; } });
  s.poll();
  const item = s.board().items.find(i => i.id === "ny-9");
  expect(item?.context).toContain("Asked again: when do you do it?");     // the newest message is the context
  expect(item?.messageId).toBe("m2");
  expect(item?.options.map(o => o.key)).toEqual(["now", "later"]);       // ...so its options are the ones shown
  const r = await s.answer(auth(), "ny-9", { kind: "option", key: "now" }, "req-1");
  expect(r.ok).toBe(true);
  expect(sent).toEqual([{ pane: "%0", text: "[tap ny-9] now (Doing it now)" }]);
});
