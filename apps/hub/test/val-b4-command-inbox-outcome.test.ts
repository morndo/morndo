// Review B4, changed on purpose by ADR-0011: a plain repeat after the inbox gave a command up for good (cancelled,
// expired) queues it once more. "lost" is not final, so a plain repeat of a lost one still adds nothing. An explicit
// Retry (the retry flag) still asks the deliverer again, after the same checks.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { inboxKey, managerInbox, SENDER } from "../src/adapters/manager-inbox.ts";
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
const inboxed = () => readdirSync(join(inboxDir, "msg"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-val-b4-")); inboxDir = join(dir, "inbox"); store = new Store(dir); typed = [];
  mkdirSync(join(inboxDir, "state"), { recursive: true });
  writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: NOW }));   // a deliverer runs
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("B4: a Command the manager's inbox gave up on", () => {
  it("lost: not final, so a repeat still says duplicate and queued, and nothing is queued again", async () => {
    expect(await steering().send(A, "%0", "deploy it", "rid-1")).toEqual({ ok: true, at: NOW, queued: true });
    const key = inboxKey(SENDER, "command:ep1:rid-1");
    writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ key, status: "lost", updatedAt: NOW }));
    expect(managerInbox(inboxDir, () => NOW).state(key)?.status).toBe("lost");
    expect(await steering().send(A, "%0", "deploy it", "rid-1")).toEqual({ ok: false, problem: "duplicate", at: NOW, queued: true, inbox: "lost", reason: null });
    expect(inboxed()).toHaveLength(1);
    expect(typed).toEqual([]);
  });
  for (const status of ["cancelled", "expired"] as const) {
    it(`${status}: a repeat queues it once more, a further repeat adds nothing, and nothing is typed`, async () => {
      expect(await steering().send(A, "%0", "deploy it", "rid-1")).toEqual({ ok: true, at: NOW, queued: true });
      const key = inboxKey(SENDER, "command:ep1:rid-1");
      writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ key, status, updatedAt: NOW }));
      expect(managerInbox(inboxDir, () => NOW).state(key)?.status).toBe(status);
      expect(await steering().send(A, "%0", "deploy it", "rid-1", [], undefined, undefined, undefined, false, true)).toEqual({ ok: true, at: NOW, queued: true });
      expect(existsSync(join(inboxDir, "ctl", `${key}.retry`))).toBe(false);
      expect(inboxed()).toHaveLength(2);
      expect(await steering().send(A, "%0", "deploy it", "rid-1")).toMatchObject({ ok: false, problem: "duplicate", queued: true });
      expect(inboxed()).toHaveLength(2);
      expect(typed).toEqual([]);
    });
  }

  it("accepted, sent, stuck or unconfirmed: a repeat says where it stands, and does not treat it as expired", async () => {
    expect(await steering().send(A, "%0", "deploy it", "rid-1")).toEqual({ ok: true, at: NOW, queued: true });
    const key = inboxKey(SENDER, "command:ep1:rid-1");
    for (const status of ["accepted", "sent", "stuck"] as const) {
      writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ key, status, updatedAt: NOW }));
      expect(await steering().send(A, "%0", "deploy it", "rid-1")).toEqual({ ok: false, problem: "duplicate", at: NOW, queued: true, inbox: status, reason: null });
    }
    writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ key, status: "sent", reason: "unconfirmed", updatedAt: NOW }));
    expect(await steering().send(A, "%0", "deploy it", "rid-1")).toEqual({ ok: false, problem: "duplicate", at: NOW, queued: true, inbox: "sent", reason: "unconfirmed" });
    expect(existsSync(join(inboxDir, "ctl", `${key}.retry`))).toBe(false);
  });

  it("lost or cancelled: an explicit Retry asks the deliverer again, after the same checks", async () => {
    for (const status of ["lost", "cancelled"] as const) {
      const named = new SteeringService(store, tmux, () => NOW, undefined, null, () => "q1", () => "manager", undefined, null,
        { isManager: id => id === "%0", inbox: managerInbox(inboxDir, () => NOW) });
      const id = `rid-${status}`;
      expect(await named.send(A, "%0", "deploy it", id, [], "q1", "manager")).toEqual({ ok: true, at: NOW, queued: true });
      const key = inboxKey(SENDER, `command:ep1:${id}`);
      writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ key, status, updatedAt: NOW }));
      // A plain repeat of a lost command adds nothing. A cancelled one is given up, so a plain repeat is Send again
      // (covered above) and would consume the row; Retry is checked on a row that is still the first copy.
      if (status === "lost") {
        expect(await named.send(A, "%0", "deploy it", id)).toEqual({ ok: false, problem: "duplicate", at: NOW, queued: true, inbox: status, reason: null });
      }
      expect(existsSync(join(inboxDir, "ctl", `${key}.retry`))).toBe(false);
      expect(await named.send(A, "%0", "deploy it", id, [], "other", "manager", NOW, true)).toEqual({ ok: false, problem: "stale" });
      expect(existsSync(join(inboxDir, "ctl", `${key}.retry`))).toBe(false);
      expect(await named.send(A, "%0", "deploy it", id, [], "q1", "manager", NOW, true)).toEqual({ ok: true, at: NOW, queued: true });
      expect(existsSync(join(inboxDir, "ctl", `${key}.retry`))).toBe(true);
    }
    expect(typed).toEqual([]);
  });

  it("delivered: an explicit Retry says it was delivered, and does not refuse it", async () => {
    expect(await steering().send(A, "%0", "deploy it", "rid-del")).toEqual({ ok: true, at: NOW, queued: true });
    const key = inboxKey(SENDER, "command:ep1:rid-del");
    const deliveredAt = NOW + 30_000;
    writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ key, status: "delivered", deliveredAt, updatedAt: deliveredAt }));
    expect(await steering().send(A, "%0", "deploy it", "rid-del", [], "none", "manager", NOW, true)).toEqual({ ok: true, at: deliveredAt });
    expect(existsSync(join(inboxDir, "ctl", `${key}.retry`))).toBe(false);
  });

  it("gone: an explicit Retry says it cannot, and does not pretend the command is queued again", async () => {
    expect(await steering().send(A, "%0", "deploy it", "rid-gone")).toEqual({ ok: true, at: NOW, queued: true });
    const key = inboxKey(SENDER, "command:ep1:rid-gone");
    unlinkSync(join(inboxDir, "msg", `${key}.json`));
    expect(await steering().send(A, "%0", "deploy it", "rid-gone", [], "none", "manager", NOW, true)).toEqual({ ok: false, problem: "not_delivered" });
    expect(existsSync(join(inboxDir, "ctl", `${key}.retry`))).toBe(false);
  });

  it("a Retry typed directly cancels the lost copy first, so a returning deliverer cannot type it", async () => {
    expect(await steering().send(A, "%0", "deploy it", "rid-lost")).toEqual({ ok: true, at: NOW, queued: true });
    const key = inboxKey(SENDER, "command:ep1:rid-lost");
    writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ key, status: "lost", reason: "lost_in_queue", attempts: 0, updatedAt: NOW }));
    writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: NOW - 5 * 60_000 }));
    rmSync(join(inboxDir, "ctl"), { recursive: true, force: true });
    writeFileSync(join(inboxDir, "ctl"), "not a directory");
    expect(await steering().send(A, "%0", "deploy it", "rid-lost", [], "none", "manager", NOW, true)).toEqual({ ok: false, problem: "duplicate", at: NOW, queued: true, inbox: "lost", reason: "lost_in_queue" });
    expect(typed).toEqual([]);
    rmSync(join(inboxDir, "ctl"));
    expect(await steering().send(A, "%0", "deploy it", "rid-lost", [], "none", "manager", NOW, true)).toEqual({ ok: true, at: NOW });
    expect(typed).toEqual(["deploy it"]);
    expect(existsSync(join(inboxDir, "ctl", `${key}.cancel`))).toBe(true);
    expect(existsSync(join(inboxDir, "ctl", `${key}.retry`))).toBe(false);
    writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: NOW }));
    expect(await steering().send(A, "%0", "deploy it", "rid-lost")).toEqual({ ok: false, problem: "duplicate", at: NOW });
    expect(typed).toEqual(["deploy it"]);
    expect(existsSync(join(inboxDir, "ctl", `${key}.cancel`))).toBe(true);
  });

  it("an explicit Retry with nobody delivering types directly, and does not leave a retry file", async () => {
    const key = inboxKey(SENDER, "command:ep1:rid-dead");
    expect(await steering().send(A, "%0", "deploy it", "rid-dead", [], "none", "manager")).toEqual({ ok: true, at: NOW, queued: true });
    writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ key, status: "expired", attempts: 0, updatedAt: NOW }));
    writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: NOW - 5 * 60_000 }));
    expect(await steering().send(A, "%0", "deploy it", "rid-dead", [], "other", "manager", NOW, true)).toEqual({ ok: false, problem: "stale" });
    expect(typed).toEqual([]);
    expect(existsSync(join(inboxDir, "ctl", `${key}.retry`))).toBe(false);
    const named = new SteeringService(store, tmux, () => NOW, undefined, null, () => "none", () => null, undefined, null,
      { isManager: id => id === "%0", inbox: managerInbox(inboxDir, () => NOW) });
    expect(await named.send(A, "%0", "deploy it", "rid-dead", [], "none", "manager", NOW, true)).toEqual({ ok: true, at: NOW });
    expect(typed).toEqual(["deploy it"]);
    expect(existsSync(join(inboxDir, "ctl", `${key}.retry`))).toBe(false);
    writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: NOW }));
    const off = inboxKey(SENDER, "command:ep1:rid-off");
    expect(await named.send(A, "%0", "hold it", "rid-off", [], "none", "manager")).toEqual({ ok: true, at: NOW, queued: true });
    writeFileSync(join(inboxDir, "disabled"), "");
    writeFileSync(join(inboxDir, "state", `${off}.json`), JSON.stringify({ key: off, status: "expired", attempts: 0, updatedAt: NOW }));
    expect(await named.send(A, "%0", "hold it", "rid-off", [], "none", "manager", NOW, true)).toEqual({ ok: true, at: NOW });
    expect(typed).toEqual(["deploy it", "hold it"]);
    expect(existsSync(join(inboxDir, "ctl", `${off}.retry`))).toBe(false);
  });

  it("a revived command gets two fresh minutes, then the hub withdraws it", async () => {
    let now = NOW;
    const MIN = 60_000;
    const s = new SteeringService(store, tmux, () => now, undefined, null, () => "none", () => null, undefined, null,
      { isManager: id => id === "%0", inbox: managerInbox(inboxDir, () => now) });
    expect(await s.send(A, "%0", "deploy it", "rid-revive")).toEqual({ ok: true, at: NOW, queued: true });
    const key = inboxKey(SENDER, "command:ep1:rid-revive");
    const read = () => JSON.parse(readFileSync(join(inboxDir, "msg", `${key}.json`), "utf8")) as { notAfter?: number };
    now = NOW + 3 * MIN;
    writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: now }));
    writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ key, status: "expired", attempts: 0, updatedAt: now }));
    expect(await s.send(A, "%0", "deploy it", "rid-revive", [], "none", "manager", now, true)).toEqual({ ok: true, at: now, queued: true });
    expect(read().notAfter).toBe(now + 2 * MIN);
    expect(existsSync(join(inboxDir, "ctl", `${key}.cancel`))).toBe(false);
    writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ key, status: "held", attempts: 0, updatedAt: now }));
    s.withdrawOverdue();
    expect(existsSync(join(inboxDir, "ctl", `${key}.cancel`))).toBe(false);
    now += 2 * MIN + 1;
    s.withdrawOverdue();
    expect(existsSync(join(inboxDir, "ctl", `${key}.cancel`))).toBe(true);
    expect(await s.send(A, "%0", "deploy it", "rid-revive")).toEqual({ ok: false, problem: "duplicate", at: NOW, queued: true, inbox: "expired", reason: null });
  });

  it("a command already typed is not withdrawn when its deadline passes", async () => {
    let now = NOW;
    const s = new SteeringService(store, tmux, () => now, undefined, null, () => "none", () => null, undefined, null,
      { isManager: id => id === "%0", inbox: managerInbox(inboxDir, () => now) });
    expect(await s.send(A, "%0", "deploy it", "rid-typed")).toEqual({ ok: true, at: NOW, queued: true });
    const key = inboxKey(SENDER, "command:ep1:rid-typed");
    writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ key, status: "accepted", attempts: 1, updatedAt: NOW }));
    now = NOW + 3 * 60_000;
    s.withdrawOverdue();
    expect(existsSync(join(inboxDir, "ctl", `${key}.cancel`))).toBe(false);
    expect(await s.send(A, "%0", "deploy it", "rid-typed")).toEqual({ ok: false, problem: "duplicate", at: NOW, queued: true, inbox: "accepted", reason: null });
  });

  it("expired: only an explicit Retry asks the deliverer, and only after the seen and name checks", async () => {
    const named = (waiting: string, name: string | null) => new SteeringService(store, tmux, () => NOW, undefined, null, () => waiting, () => name, undefined, null,
      { isManager: id => id === "%0", inbox: managerInbox(inboxDir, () => NOW) });
    const s = named("q1", "manager");
    expect(await s.send(A, "%0", "deploy it", "rid-1", [], "q1", "manager")).toEqual({ ok: true, at: NOW, queued: true });
    const key = inboxKey(SENDER, "command:ep1:rid-1");
    writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ key, status: "expired", updatedAt: NOW }));
    expect(await s.send(A, "%0", "deploy it", "rid-1", [], "other", "manager", NOW, true)).toEqual({ ok: false, problem: "stale" });
    expect(await s.send(A, "%0", "deploy it", "rid-1", [], "q1", "someone-else", NOW, true)).toEqual({ ok: false, problem: "no_pane" });
    expect(existsSync(join(inboxDir, "ctl", `${key}.retry`))).toBe(false);
    expect(await s.send(A, "%0", "deploy it", "rid-1", [], "q1", "manager", NOW, true)).toEqual({ ok: true, at: NOW, queued: true });
    expect(existsSync(join(inboxDir, "ctl", `${key}.retry`))).toBe(true);
    expect(typed).toEqual([]);
  });
});
