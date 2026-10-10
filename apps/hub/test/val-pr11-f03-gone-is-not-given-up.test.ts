// Validation of review finding #3 (range b9328b196..d90a1443e, PR #11): the hub's own inbox status "gone" (msg/<key>.json
// is missing) is treated as "the inbox gave it up" by #queueAgain. But the file can be missing after the message was
// delivered (removed by hand; the deliverer's own state file still says delivered), and the second copy's file can be
// missing too. The contract (steering-service.ts #queueAgain, ADR-0011): "one request is at most two inbox messages,
// and never two that can both arrive". Synthetic data only.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import type { Tmux } from "../src/application/ports.ts";
import { SENDER, inboxKey, managerInbox } from "../src/adapters/manager-inbox.ts";
import { SteeringService } from "../src/application/steering-service.ts";
import type { Authenticated } from "../src/application/access-service.ts";

const NOW = Date.UTC(2026, 9, 5, 9);
let dir: string, inboxDir: string, store: Store, typed: string[], enqueued: string[];
const A: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: NOW - 1000, lastSeenAt: NOW, verifiedAt: NOW - 1000, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Phone", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: NOW, revokedAt: null },
};
const tmux: Pick<Tmux, "send"> = { send: async (_id, text) => { typed.push(text); return { problem: null, typedAt: NOW }; } };
// Every message that ever went into the inbox, by its id (files can be removed again, so counting msg/ isn't enough).
const steering = () => {
  const inbox = managerInbox(inboxDir, () => NOW);
  return new SteeringService(store, tmux, () => NOW, undefined, null, () => "none", () => null, undefined, null, {
    isManager: id => id === "%0",
    inbox: { ...inbox, enqueue: m => { const r = inbox.enqueue(m); if (r && !r.duplicate) enqueued.push(m.id); return r; } },
  });
};
const stateOf = (id: string, status: string) => {
  mkdirSync(join(inboxDir, "state"), { recursive: true });
  const key = inboxKey(SENDER, id);
  writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ v: 1, key, status, attempts: 1, deliveredAt: NOW, updatedAt: NOW }));
};
const removeMsg = (id: string) => rmSync(join(inboxDir, "msg", `${inboxKey(SENDER, id)}.json`));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-val-pr11-f03-")); inboxDir = join(dir, "inbox"); store = new Store(dir); typed = []; enqueued = [];
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: NOW }));   // a deliverer runs
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("finding #3: a missing message file is not proof the inbox gave the message up", () => {
  it("delivered, then its message file removed (the state file still says delivered): a repeat queues nothing", async () => {
    expect(await steering().send(A, "%0", "deploy it", "rid-1")).toEqual({ ok: true, at: NOW, queued: true });
    stateOf("command:ep1:rid-1", "delivered");
    removeMsg("command:ep1:rid-1");
    const r = await steering().send(A, "%0", "deploy it", "rid-1");
    expect(enqueued).toEqual(["command:ep1:rid-1"]);            // the manager has it once; a second copy would be a duplicate
    expect(r).toMatchObject({ ok: false, problem: "duplicate" });
    expect(readdirSync(join(inboxDir, "msg"))).toEqual([]);
  });
  it("the second copy's file gone too: never a third inbox message for one request", async () => {
    expect(await steering().send(A, "%0", "deploy it", "rid-1")).toEqual({ ok: true, at: NOW, queued: true });
    stateOf("command:ep1:rid-1", "cancelled");
    await steering().send(A, "%0", "deploy it", "rid-1", [], undefined, undefined, undefined, false, true);   // the one more (ADR-0011): command:ep1:rid-1:again
    rmSync(join(inboxDir, "msg", `${inboxKey(SENDER, "command:ep1:rid-1:again")}.json`), { force: true });
    await steering().send(A, "%0", "deploy it", "rid-1");
    await steering().send(A, "%0", "deploy it", "rid-1");
    expect(enqueued.length).toBeLessThanOrEqual(2);              // at head: 3 (a second ":again"), and one more per removal
    expect(typed).toEqual([]);
  });
});
