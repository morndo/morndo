// Review B10 (characterization, passes at bddbea8): main.ts:95 decides "is this the manager" by the pane id the roster
// shows for the manager's window right now (`id => id === managerPane()`, main.ts:87). When the roster has no such
// window, a Command to the manager is not queued: it goes to the direct typist, which refuses it as no_pane for a pane
// that is gone (as on origin/main), and types it straight into the pane, bypassing the inbox, for one that is there but
// not listed yet (an empty roster). A Decision for the manager is queued either way (escalation-service.ts:315 keys on
// the asker recorded with the Decision).
import { mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { managerInbox } from "../src/adapters/manager-inbox.ts";
import { SteeringService } from "../src/application/steering-service.ts";
import type { Authenticated } from "../src/application/access-service.ts";

const NOW = Date.UTC(2026, 9, 4, 15);
let dir: string, inboxDir: string, store: Store, typed: string[], roster: { id: string; name: string }[], panes: Set<string>;
const A: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: NOW - 1000, lastSeenAt: NOW, verifiedAt: NOW - 1000, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Phone", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: NOW, revokedAt: null },
};
// The direct typist: a pane that doesn't exist is no_pane, one that does is typed. The port returns a SendOutcome.
const tmux = {
  send: async (id: string, text: string) => {
    if (!panes.has(id)) return { problem: "no_pane" as const, typedAt: NOW };
    typed.push(text);
    return { problem: null, typedAt: NOW };
  },
};
// As main.ts wires it: the manager is the pane the roster names, and only that pane's Commands go to the inbox.
const managerPane = () => roster.find(w => w.name === "manager")?.id ?? null;
const steering = () => new SteeringService(store, tmux, () => NOW, undefined, null, () => "none", id => roster.find(w => w.id === id)?.name ?? null,
  undefined, null, { isManager: id => id === managerPane(), inbox: managerInbox(inboxDir, () => NOW) });
const inboxed = () => (existsSync(join(inboxDir, "msg")) ? readdirSync(join(inboxDir, "msg")) : []);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-val-b10-")); inboxDir = join(dir, "inbox"); store = new Store(dir); typed = [];
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: NOW }));   // a deliverer runs
  roster = [{ id: "%0", name: "manager" }, { id: "%3", name: "builder" }]; panes = new Set(["%0", "%3"]);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("B10: a Command to the manager when the roster has no manager window", () => {
  it("listed: queued in the inbox (the baseline)", async () => {
    expect(await steering().send(A, "%0", "hi", "r0", [], undefined, "manager")).toEqual({ ok: true, at: NOW, queued: true });
  });
  it("its window gone: refused no_pane, nothing queued (as on origin/main)", async () => {
    roster = roster.filter(w => w.name !== "manager"); panes.delete("%0");
    expect(await steering().send(A, "%0", "hi", "r1", [], undefined, "manager")).toEqual({ ok: false, problem: "no_pane" });
    expect(inboxed()).toEqual([]);
  });
  it("its pane there but not in the roster yet (empty roster): typed directly, bypassing the inbox", async () => {
    roster = [];
    expect(await steering().send(A, "%0", "hi", "r2", [], undefined, "manager")).toEqual({ ok: true, at: NOW });
    expect(typed).toEqual(["hi"]);
    expect(inboxed()).toEqual([]);
  });
});
