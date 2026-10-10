// A Command to the manager goes into its inbox (ADR-0010), never typed by the hub: S5 still holds (one request id,
// at most one message; a repeat says duplicate, and queued), and the kill switch types it directly, as before.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { SENDER, inboxKey, managerInbox } from "../src/adapters/manager-inbox.ts";
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
const inboxed = () => readdirSync(join(inboxDir, "msg")).map(f => JSON.parse(readFileSync(join(inboxDir, "msg", f), "utf8")));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-steer-inbox-")); inboxDir = join(dir, "inbox"); store = new Store(dir); typed = [];
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: NOW }));   // a deliverer runs
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("a message for the manager", () => {
  it("is queued in its inbox once, not typed; the answer says queued", async () => {
    const r = await steering().send(A, "%0", "Please queue this note", "rid-1");
    expect(r).toEqual({ ok: true, at: NOW, queued: true });
    expect(typed).toEqual([]);
    expect(inboxed()).toEqual([expect.objectContaining({ sender: "morndo-hub", id: "command:ep1:rid-1", kind: "owner", text: "Please queue this note" })]);
    expect(store.auditOf("CommandSent", 0)).toHaveLength(1);
  });
  it("the same request again, even after a restart, is a duplicate that still says queued, and adds nothing", async () => {
    await steering().send(A, "%0", "hello", "rid-1");
    expect(await steering().send(A, "%0", "hello", "rid-1")).toEqual({ ok: false, problem: "duplicate", at: NOW, queued: true, inbox: "queued", reason: null });
    expect(inboxed()).toHaveLength(1);
  });
  it("another worker is typed as before", async () => {
    expect(await steering().send(A, "%3", "build it", "rid-2")).toEqual({ ok: true, at: NOW });
    expect(typed).toEqual(["build it"]);
  });
  it("no deliverer running (no heartbeat for 90 s): typed directly instead of queued where nobody empties it", async () => {
    writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: NOW - 5 * 60_000 }));
    expect(await steering().send(A, "%0", "direct too", "rid-4")).toEqual({ ok: true, at: NOW });
    expect(typed).toEqual(["direct too"]);
  });
  it("the kill switch (`manager-inbox disable`): typed directly", async () => {
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(join(inboxDir, "disabled"), "");
    expect(await steering().send(A, "%0", "direct", "rid-3")).toEqual({ ok: true, at: NOW });
    expect(typed).toEqual(["direct"]);
  });
});

// Send again on the phone (review, 2026-10-05): the same request id again. It never makes a second message while the
// first may still arrive; only once the inbox gave the first up does it queue the text once more, and only once.
describe("the same request again after the inbox gave it up", () => {
  const stateOf = (id: string, status: string) => {
    mkdirSync(join(inboxDir, "state"), { recursive: true });
    const key = inboxKey(SENDER, id);
    writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ v: 1, key, status, attempts: 0, updatedAt: NOW }));
  };
  it("while the first still waits, or arrived late, adds nothing", async () => {
    await steering().send(A, "%0", "hello", "rid-1");
    stateOf("command:ep1:rid-1", "held");
    expect(await steering().send(A, "%0", "hello", "rid-1")).toEqual({ ok: false, problem: "duplicate", at: NOW, queued: true, inbox: "held", reason: null });
    stateOf("command:ep1:rid-1", "delivered");
    expect(await steering().send(A, "%0", "hello", "rid-1")).toMatchObject({ ok: false, problem: "duplicate" });
    expect(inboxed()).toHaveLength(1);
  });
  it("while it is lost (the inbox waits for a person to retry or cancel it: the spool's terminal states), adds nothing", async () => {
    await steering().send(A, "%0", "hello", "rid-1");
    stateOf("command:ep1:rid-1", "lost");
    expect(await steering().send(A, "%0", "hello", "rid-1")).toEqual({ ok: false, problem: "duplicate", at: NOW, queued: true, inbox: "lost", reason: null });
    expect(inboxed()).toHaveLength(1);
  });
  it("once it expired, is queued once more under its own inbox id, and a further repeat adds nothing", async () => {
    await steering().send(A, "%0", "hello", "rid-1");
    stateOf("command:ep1:rid-1", "expired");
    expect(await steering().send(A, "%0", "hello", "rid-1", [], undefined, undefined, undefined, false, true)).toEqual({ ok: true, at: NOW, queued: true });
    expect(await steering().send(A, "%0", "hello", "rid-1")).toMatchObject({ ok: false, problem: "duplicate", queued: true });
    expect(inboxed().map(m => String(m.id)).sort((x, y) => x.localeCompare(y))).toEqual(["command:ep1:rid-1", "command:ep1:rid-1:again"]);
    expect(inboxed().every(m => m.text === "hello")).toBe(true);
  });
});

// Review #2 (2026-10-05, the team's call A): the phone shows where a message really stands in the inbox instead of
// claiming a resend. The hub tells it: the state of the copy under way (the second one once queued).
describe("where a message for the manager stands in its inbox", () => {
  const stateWith = (id: string, status: string, reason: string | null) => {
    mkdirSync(join(inboxDir, "state"), { recursive: true });
    const key = inboxKey(SENDER, id);
    writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ v: 1, key, status, reason, attempts: 0, updatedAt: NOW }));
  };
  it("the first copy's state and reason; the second's once it was queued; null for a request it never queued", async () => {
    await steering().send(A, "%0", "hello", "rid-1");
    expect(steering().inboxState(A, "%0", "rid-1")).toEqual({ status: "queued", reason: null });
    stateWith("command:ep1:rid-1", "held", "foreign_text");
    expect(steering().inboxState(A, "%0", "rid-1")).toEqual({ status: "held", reason: "foreign_text" });
    stateWith("command:ep1:rid-1", "cancelled", null);
    await steering().send(A, "%0", "hello", "rid-1", [], undefined, undefined, undefined, false, true);   // queued once more
    expect(steering().inboxState(A, "%0", "rid-1")).toEqual({ status: "queued", reason: null });
    expect(steering().inboxState(A, "%0", "rid-unknown")).toBeNull();
    expect(steering().inboxState(A, "%1", "rid-1")).toBeNull();             // not the manager
  });
});
