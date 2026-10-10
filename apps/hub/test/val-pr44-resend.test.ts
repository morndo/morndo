// Review #44, findings 1, 3, 5 and 15: a plain repeat of a request id is a status read. It answers the inbox
// state and never queues command:<key>:again, even when the session may not command. Only an explicit Send again
// (again: true) queues that second copy, and only after the same checks as a first send. Retry renews the copy
// that is live, which after Send again is the :again id. A removed message file whose state still says the
// command is in flight is that state, not "gone".
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import type { Tmux } from "../src/application/ports.ts";
import { SENDER, inboxKey, managerInbox } from "../src/adapters/manager-inbox.ts";
import { SteeringService } from "../src/application/steering-service.ts";
import type { Authenticated } from "../src/application/access-service.ts";

const NOW = Date.UTC(2026, 9, 10, 9);
let dir: string, inboxDir: string, store: Store, typed: string[];
const endpoint: Authenticated["endpoint"] = { id: endpointId("ep1"), name: "Phone", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: NOW, revokedAt: null };
const session = (verifiedAt: number): Authenticated => ({
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: NOW - 3_600_000, lastSeenAt: NOW, verifiedAt, endedAt: null, endReason: null },
  endpoint,
});
const FRESH = session(NOW - 1000);
const LAPSED = session(NOW - 11 * 60_000);
const tmux: Pick<Tmux, "send"> = { send: async (_id, text) => { typed.push(text); return { problem: null, typedAt: NOW }; } };
const manager = () => ({ isManager: (id: string) => id === "%0", inbox: managerInbox(inboxDir, () => NOW) });
const steering = () => new SteeringService(store, tmux, () => NOW, () => ({ stay: "12h", stepUp: "10m" }), null, () => "none", () => null, undefined, null, manager());
const expiredUpload = () => new SteeringService(store, tmux, () => NOW, () => ({ stay: "12h", stepUp: "10m" }), {
  get: () => ({ id: "u", endpointId: endpoint.id, path: "/tmp/x.png", mime: "image/png" as const, size: 8, at: NOW - 25 * 3_600_000 }),
}, () => "none", () => null, undefined, null, manager());
const ids = () => readdirSync(join(inboxDir, "msg")).map(f => (JSON.parse(readFileSync(join(inboxDir, "msg", f), "utf8")) as { id: string }).id);
const stateOf = (id: string, status: string, attempts = 1) => {
  mkdirSync(join(inboxDir, "state"), { recursive: true });
  const key = inboxKey(SENDER, id);
  writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ v: 1, key, status, attempts, updatedAt: NOW }));
};
const send = (a: Authenticated, id: string, again = false, retry = false) =>
  steering().send(a, "%0", "deploy it", id, [], "none", "manager", NOW, retry, again);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-val-pr44-")); inboxDir = join(dir, "inbox"); store = new Store(dir); typed = [];
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: NOW }));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("a status read is not a resend", () => {
  it("a plain repeat after the inbox gave the first up answers that state and queues nothing, even when the passkey check has lapsed", async () => {
    expect(await send(FRESH, "rid-1")).toEqual({ ok: true, at: NOW, queued: true });
    stateOf("command:ep1:rid-1", "expired");
    const r = await send(LAPSED, "rid-1");
    expect(r).toMatchObject({ ok: false, problem: "duplicate", inbox: "expired" });
    expect(ids()).toEqual(["command:ep1:rid-1"]);
    expect(typed).toEqual([]);
  });

  it("an explicit Send again still needs a fresh passkey check before it queues the second copy", async () => {
    expect(await send(FRESH, "rid-2")).toEqual({ ok: true, at: NOW, queued: true });
    stateOf("command:ep1:rid-2", "expired");
    expect(await send(LAPSED, "rid-2", true)).toEqual({ ok: false, problem: "step_up" });
    expect(ids()).toEqual(["command:ep1:rid-2"]);
    expect(await send(FRESH, "rid-2", true)).toEqual({ ok: true, at: NOW, queued: true });
    expect(ids().sort()).toEqual(["command:ep1:rid-2", "command:ep1:rid-2:again"]);
    expect(await send(FRESH, "rid-2", true)).toMatchObject({ ok: false, problem: "duplicate" });
    expect(ids()).toHaveLength(2);
  });

  it("Retry renews the requeued :again copy, not the first one", async () => {
    expect(await send(FRESH, "rid-3")).toEqual({ ok: true, at: NOW, queued: true });
    stateOf("command:ep1:rid-3", "expired");
    expect(await send(FRESH, "rid-3", true)).toEqual({ ok: true, at: NOW, queued: true });
    stateOf("command:ep1:rid-3:again", "expired");
    const againKey = inboxKey(SENDER, "command:ep1:rid-3:again");
    const firstKey = inboxKey(SENDER, "command:ep1:rid-3");
    expect(await send(FRESH, "rid-3", false, true)).toEqual({ ok: true, at: NOW, queued: true });
    expect(existsSync(join(inboxDir, "ctl", `${againKey}.retry`))).toBe(true);
    expect(existsSync(join(inboxDir, "ctl", `${firstKey}.retry`))).toBe(false);
  });

  it("a removed message file whose state says accepted is still accepted, so a plain repeat does not queue another copy", async () => {
    expect(await send(FRESH, "rid-4")).toEqual({ ok: true, at: NOW, queued: true });
    stateOf("command:ep1:rid-4", "accepted");
    rmSync(join(inboxDir, "msg", `${inboxKey(SENDER, "command:ep1:rid-4")}.json`));
    const r = await send(FRESH, "rid-4");
    expect(r).toMatchObject({ ok: false, problem: "duplicate", inbox: "accepted" });
    expect(readdirSync(join(inboxDir, "msg"))).toEqual([]);
    expect(typed).toEqual([]);
  });

  it("a queued or held command whose message file is gone is past its deadline and can be given up", async () => {
    for (const [id, status] of [["rid-6", "queued"], ["rid-6b", "held"]] as const) {
      expect(await send(FRESH, id)).toEqual({ ok: true, at: NOW, queued: true });
      stateOf(`command:ep1:${id}`, status, 0);
      const key = inboxKey(SENDER, `command:ep1:${id}`);
      rmSync(join(inboxDir, "msg", `${key}.json`));
      expect(await send(FRESH, id)).toMatchObject({ ok: false, problem: "duplicate", inbox: "expired" });
      expect(existsSync(join(inboxDir, "ctl", `${key}.cancel`))).toBe(true);
      expect(await send(FRESH, id, true)).toEqual({ ok: true, at: NOW, queued: true });
      expect(ids()).toContain(`command:ep1:${id}:again`);
    }
    expect(typed).toEqual([]);
  });

  it("a Send again that can never be queued is a final refusal, not a retryable outage", async () => {
    expect(await send(FRESH, "rid-7")).toEqual({ ok: true, at: NOW, queued: true });
    stateOf("command:ep1:rid-7", "expired");
    const again = (text: string, uploads: string[] = [], svc = steering()) =>
      svc.send(FRESH, "%0", text, "rid-7", uploads, "none", "manager", NOW, false, true);
    expect(await again("    ")).toEqual({ ok: false, problem: "cannot_resend" });
    expect(await again("x".repeat(8001))).toEqual({ ok: false, problem: "cannot_resend" });
    expect(await again("deploy it", ["u"], expiredUpload())).toEqual({ ok: false, problem: "cannot_resend" });
    expect(ids()).toEqual(["command:ep1:rid-7"]);
  });

  it("Retry of an expired command whose message file is gone says it was not delivered", async () => {
    expect(await send(FRESH, "rid-5")).toEqual({ ok: true, at: NOW, queued: true });
    stateOf("command:ep1:rid-5", "expired");
    const key = inboxKey(SENDER, "command:ep1:rid-5");
    rmSync(join(inboxDir, "msg", `${key}.json`));
    expect(await send(FRESH, "rid-5", false, true)).toEqual({ ok: false, problem: "not_delivered" });
    expect(existsSync(join(inboxDir, "ctl", `${key}.retry`))).toBe(false);
    expect(typed).toEqual([]);
  });
});
