// Account resolution from the fleet's usage taps (S3, plan 4.5 item 4, AT-19 to AT-20b): a limit failure resolves to
// the account the lane works under — the hook's own word first, then the lane's fresh record, the session, the node's
// only account — and marks that account's seat; nothing resolved changes nothing (U9). Real server on a random
// port, fake clock, synthetic data only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

let hub: InProcessHub;
let now: number;
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
type Body = Record<string, unknown>;

// The fleet's taps, as the fleet client would hand them to main.ts (milliseconds, the fleet's own event shape).
const laneAccount = (h: InProcessHub, lane: string, account: string, at: number) =>
  h.usage.fromFleet("pc", { kind: "lane_account", lane, account, at });
const failure = (h: InProcessHub, o: { lane: string | null; account: string | null; at: number; sessionId?: string; node?: string }) =>
  h.usage.fromFleet(o.node ?? "pc", { kind: "failure", lane: o.lane, window: o.lane, error: "rate_limit", account: o.account, at: o.at, ...(o.sessionId === undefined ? {} : { sessionId: o.sessionId }) });
const viewOn = async (h: InProcessHub) => {
  const cookie = await h.cookie();
  return (await (await fetch(`${h.base}/api/usage`, { headers: { cookie: `__Host-morndo=${cookie}` } })).json()) as Body;
};
const seatOn = async (h: InProcessHub, account: string) => ((await viewOn(h)).accounts as Body[]).find(a => a.account === account)?.seat;
const noticesOn = async (h: InProcessHub, kind: string) => ((await viewOn(h)).notices as Body[]).filter(n => n.kind === kind);
const seatOf = (account = "seat-a") => seatOn(hub, account);

beforeEach(async () => {
  now = 1_700_000_000_000;      // 10:00
  hub = await startInProcessHub({ now: () => now, laneNode: lane => ["w1", "w2", "w3"].includes(lane) ? "pc" : null });
});
afterEach(async () => { await hub.close(); });

describe("account resolution from the fleet's taps (plan 4.5 item 4)", () => {
  it("a first-turn failure resolves from the lane record (AT-19)", async () => {
    laneAccount(hub, "w1", "seat-a", now);                    // the lane started with the account
    failure(hub, { lane: "w1", account: null, at: now + MIN });   // its first turn failed; the hook names no account
    expect(await seatOf()).toMatchObject({ state: "out", why: "usage_limit", owner: "derived" });
  });

  it("env style: the hook sends MORNDO_ACCOUNT (AT-19b)", async () => {
    laneAccount(hub, "w1", "seat-a", now);
    // PR #127, finding 1: the hook's own word counts only for an account the hub knows and this node runs, so another
    // lane of this node holds seat-b first.
    laneAccount(hub, "w2", "seat-b", now);
    failure(hub, { lane: "w1", account: "seat-b", at: now + MIN });   // the hook's own word, as MORNDO_ACCOUNT
    expect(await seatOf("seat-a")).toBeUndefined();
    expect(await seatOf("seat-b")).toMatchObject({ state: "out", why: "usage_limit" });
  });

  it("a single-account node (AT-19c)", async () => {
    laneAccount(hub, "w1", "seat-a", now);
    laneAccount(hub, "w2", "seat-b", now);
    failure(hub, { lane: "w3", account: null, at: now + MIN });       // a lane with no record of its own
    expect(await seatOf("seat-a")).toBeUndefined();                   // two accounts on the node: nothing is marked
    expect(await seatOf("seat-b")).toBeUndefined();
    // The node's only account: that one is marked.
    const alone = await startInProcessHub({ now: () => now, laneNode: lane => ["w1", "w3"].includes(lane) ? "pc" : null });
    try {
      laneAccount(alone, "w1", "seat-a", now);
      failure(alone, { lane: "w3", account: null, at: now + MIN });
      expect(await seatOn(alone, "seat-a")).toMatchObject({ state: "out", why: "usage_limit" });
    } finally { await alone.close(); }
  });

  it("a status-line report leaves the lane's record, which outlives the fresh session (writer b)", async () => {
    const w1 = hub.agents.issue("w1", "worker").secret;
    const report = await fetch(`${hub.base}/api/agent/usage`, {
      method: "POST",
      headers: { authorization: `Bearer ${w1}`, "content-type": "application/json", "x-morndo-lane": "w1", "x-morndo-account": "seat-a" },
      body: JSON.stringify({ session_id: "s1", rate_limits: { five_hour: { used_percentage: 10, resets_at: Math.floor((now + 4 * 3_600_000) / 1000) } } }),
    });
    expect(report.status).toBe(200);
    now += 30 * MIN;                                            // the session (10 minutes) is no longer fresh; the record (7 days) is
    failure(hub, { lane: "w1", account: null, at: now });
    expect(await seatOf()).toMatchObject({ state: "out", why: "usage_limit" });
  });

  it("a moved lane with a stale record resolves from the hook's own field (AT-20)", async () => {
    laneAccount(hub, "w1", "seat-a", now - 8 * DAY);          // the record is a week old: the lane long moved
    laneAccount(hub, "w2", "seat-b", now);                    // PR #127, finding 1: seat-b is known and run on this node
    failure(hub, { lane: "w1", account: "seat-b", at: now }); // the account it works under now, the hook's own word
    expect(await seatOf("seat-a")).toBeUndefined();
    expect(await seatOf("seat-b")).toMatchObject({ state: "out", why: "usage_limit" });
  });

  it("pool style: the config directory's name (AT-20b)", async () => {
    laneAccount(hub, "w1", "seat-a", now);
    laneAccount(hub, "w2", "acct-b2", now);                   // PR #127, finding 1: known to the hub, seen on this node
    failure(hub, { lane: "w1", account: "acct-b2", at: now + MIN });   // the pool's hooks name the account by its directory
    expect(await seatOf("acct-b2")).toMatchObject({ state: "out", why: "usage_limit" });
    expect(await seatOf("seat-a")).toBeUndefined();
  });

  // PR #127, finding 1: the hook's own account word is trusted only for an account this node is known to run.
  it("a failure naming an account the hub has never seen creates nothing (PR #127, finding 1)", async () => {
    failure(hub, { lane: "w1", account: "ghost-9", at: now + MIN });   // no account row, no source, no seat, no record names it
    const v = await viewOn(hub);
    expect((v.accounts as Body[]).find(a => a.account === "ghost-9")).toBeUndefined();   // no card: nothing was created
    expect(hub.store.usageSeats()).toEqual([]);                                          // no seat row
    expect(await noticesOn(hub, "seat")).toEqual([]);                                    // no notice
  });

  it("a failure from another node naming an account only a different node runs marks nothing (PR #127, finding 1)", async () => {
    laneAccount(hub, "w1", "seat-a", now);                    // seat-a is run by a lane of node pc
    failure(hub, { lane: "w1", account: "seat-a", at: now + MIN, node: "srv" });   // the failure arrives from srv
    expect(await seatOf()).toBeUndefined();
    expect(hub.store.usageSeats()).toEqual([]);
    expect(await noticesOn(hub, "seat")).toEqual([]);
  });

  it("a pool-retired seat takes no hit from a lane (PR #127, finding 1)", async () => {
    expect(hub.usage.poolSeat({ account: "seat-a", action: "set", state: "retired", why: "refused", backAt: null, at: now, by: "pool-bot" })).toEqual({ ok: true });
    laneAccount(hub, "w1", "seat-a", now);                    // the account is known to the hub and seen on this node
    failure(hub, { lane: "w1", account: "seat-a", at: now + MIN });   // a lane's hit against the pool's retired word
    expect(await seatOf()).toMatchObject({ state: "retired", why: "refused", owner: "pool", by: "pool-bot" });
    expect(await noticesOn(hub, "seat")).toHaveLength(1);     // the pool's own notice, and nothing from the lane's hit
    expect(hub.usage.clearSeat("seat-a", "pool")).toBe(true);
    expect(await seatOf()).toBeUndefined();                   // no derived mark was made behind the pool's word
  });

  // PR #127, finding 3a: a node replaying its events after a reconnect must not mark seats from long-old failures.
  it("a replayed old failure makes no mark; a recent one marks (PR #127, finding 3a)", async () => {
    laneAccount(hub, "w1", "seat-a", now);
    failure(hub, { lane: "w1", account: "seat-a", at: now - 6 * HOUR });   // six hours old: a replay, not news
    expect(await seatOf()).toBeUndefined();
    expect(await noticesOn(hub, "seat")).toEqual([]);
    failure(hub, { lane: "w1", account: "seat-a", at: now - 4 * MIN });    // four minutes old: still news
    expect(await seatOf()).toMatchObject({ state: "out", why: "usage_limit", since: now - 4 * MIN });
    expect(await noticesOn(hub, "seat")).toHaveLength(1);
  });

  it("a failure stamped in the future is capped at the hub's clock plus the skew (PR #127, finding 3a)", async () => {
    laneAccount(hub, "w1", "seat-a", now);
    failure(hub, { lane: "w1", account: "seat-a", at: now + 10 * MIN });   // ten minutes ahead of the hub's clock
    // `since` is the mark's own stamp as stored (an out mark's markedAt is the same value); the view shows no markedAt.
    expect(await seatOf()).toMatchObject({ state: "out", since: now + 5 * MIN });
  });

  // PR #127, finding 4: a lane the fleet's list places on no node writes no record, and a start record outranks a report.
  it("a report from a lane the fleet's list does not place writes no record, so a later failure of it resolves nothing (PR #127, finding 4a)", async () => {
    const w9 = hub.agents.issue("w9", "worker").secret;      // a lane the list knows nothing of
    const report = await fetch(`${hub.base}/api/agent/usage`, {
      method: "POST",
      headers: { authorization: `Bearer ${w9}`, "content-type": "application/json", "x-morndo-lane": "w9", "x-morndo-account": "seat-a" },
      body: JSON.stringify({ session_id: "s9", rate_limits: { five_hour: { used_percentage: 10, resets_at: Math.floor((now + 4 * 3_600_000) / 1000) } } }),
    });
    expect(report.status).toBe(200);
    expect(hub.store.laneAccounts().some(r => r.lane === "w9")).toBe(false);   // no record, not even one of node ""
    failure(hub, { lane: "w9", account: null, at: now + MIN });
    expect(await seatOf("seat-a")).toBeUndefined();
    expect(hub.store.usageSeats()).toEqual([]);
  });

  it("a lane started with an account keeps it against a report under another for twelve hours, then gives way (PR #127, finding 4b)", async () => {
    laneAccount(hub, "w1", "seat-a", now);                   // the lane started with seat-a
    const w1 = hub.agents.issue("w1", "worker").secret;
    const report = (account: string, at: number) => fetch(`${hub.base}/api/agent/usage`, {
      method: "POST",
      headers: { authorization: `Bearer ${w1}`, "content-type": "application/json", "x-morndo-lane": "w1", "x-morndo-account": account },
      body: JSON.stringify({ session_id: "s1", rate_limits: { five_hour: { used_percentage: 10, resets_at: Math.floor((at + 4 * 3_600_000) / 1000) } } }),
    });
    expect((await report("seat-b", now)).status).toBe(200);  // a self-declared header under seat-b
    failure(hub, { lane: "w1", account: null, at: now + 2 * MIN });
    expect(await seatOf("seat-a")).toMatchObject({ state: "out", why: "usage_limit" });   // the start record stands
    expect(await seatOf("seat-b")).toBeUndefined();
    now += 12 * HOUR + MIN;                                  // twelve hours past the start: a report may replace it
    expect((await report("seat-b", now)).status).toBe(200);
    failure(hub, { lane: "w1", account: null, at: now + MIN });
    expect(await seatOf("seat-b")).toMatchObject({ state: "out", why: "usage_limit" });
  });
});
