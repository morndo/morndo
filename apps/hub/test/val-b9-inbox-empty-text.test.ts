// Review B9: the hub's enqueue must keep the inbox contract its header cites: a text that is
// empty once cleaned (control characters dropped, trimmed) is refused ("empty text"), never written as text "".
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { managerInbox } from "../src/adapters/manager-inbox.ts";
import { SteeringService } from "../src/application/steering-service.ts";
import type { Authenticated } from "../src/application/access-service.ts";

const NOW = Date.UTC(2026, 9, 4, 15);
let dir: string, inboxDir: string, store: Store, typed: string[];
const A: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: NOW - 1000, lastSeenAt: NOW, verifiedAt: NOW - 1000, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Phone", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: NOW, revokedAt: null },
};
const tmux = { send: async (_id: string, text: string) => { typed.push(text); return { problem: null, typedAt: NOW }; } };
const steering = () => new SteeringService(store, tmux, () => NOW, undefined, null, () => "none", () => null, undefined, null,
  { isManager: id => id === "%0", inbox: managerInbox(inboxDir, () => NOW) });
const inboxed = () => existsSync(join(inboxDir, "msg"))
  ? readdirSync(join(inboxDir, "msg")).map(f => JSON.parse(readFileSync(join(inboxDir, "msg", f), "utf8")) as { text: string })
  : [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-val-b9-")); inboxDir = join(dir, "inbox"); store = new Store(dir); typed = [];
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: NOW }));   // a deliverer runs
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("B9: a text that is empty once cleaned never reaches the manager's inbox", () => {
  it("the adapter writes no message with text \"\" (the contract's Spool.enqueue throws \"empty text\")", () => {
    let threw = false;
    try { managerInbox(inboxDir, () => NOW).enqueue({ id: "command:ep1:bel", kind: "owner", text: "\x07" }); }
    catch { threw = true; }
    expect(inboxed().filter(m => m.text === "")).toEqual([]);
    expect(threw || inboxed().length === 0).toBe(true);
  });
  it("a Command of only control characters to the manager is refused as empty, not queued", async () => {
    const r = await steering().send(A, "%0", "\x07\x1b", "rid-bel");
    expect(r).toEqual({ ok: false, problem: "empty" });
    expect(inboxed()).toEqual([]);
  });
});
