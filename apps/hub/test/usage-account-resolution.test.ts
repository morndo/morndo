// Account resolution from the fleet's usage taps (S3, plan 4.5 item 4, AT-19 to AT-20b): a limit failure resolves to
// the account the lane works under — the hook's own word first, then the lane's fresh record, the session, the node's
// only account — and marks that account's seat; nothing resolved changes nothing (U9). Red until round 2: fromFleet
// throws "not implemented". Real server on a random port, fake clock, synthetic data only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

let hub: InProcessHub;
let now: number;
const MIN = 60_000, DAY = 86_400_000;
type Body = Record<string, unknown>;

// The fleet's taps, as the fleet client would hand them to main.ts (milliseconds, the fleet's own event shape).
const laneAccount = (h: InProcessHub, lane: string, account: string, at: number) =>
  h.usage.fromFleet("pc", { kind: "lane_account", lane, account, at });
const failure = (h: InProcessHub, o: { lane: string | null; account: string | null; at: number; sessionId?: string }) =>
  h.usage.fromFleet("pc", { kind: "failure", lane: o.lane, window: o.lane, error: "rate_limit", account: o.account, at: o.at, ...(o.sessionId === undefined ? {} : { sessionId: o.sessionId }) });
const seatOn = async (h: InProcessHub, account: string) => {
  const cookie = await h.cookie();
  const v = (await (await fetch(`${h.base}/api/usage`, { headers: { cookie: `__Host-morndo=${cookie}` } })).json()) as Body;
  return (v.accounts as Body[]).find(a => a.account === account)?.seat;
};
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

  it("a moved lane with a stale record resolves from the hook's own field (AT-20)", async () => {
    laneAccount(hub, "w1", "seat-a", now - 8 * DAY);          // the record is a week old: the lane long moved
    failure(hub, { lane: "w1", account: "seat-b", at: now }); // the account it works under now, the hook's own word
    expect(await seatOf("seat-a")).toBeUndefined();
    expect(await seatOf("seat-b")).toMatchObject({ state: "out", why: "usage_limit" });
  });

  it("pool style: the config directory's name (AT-20b)", async () => {
    laneAccount(hub, "w1", "seat-a", now);
    failure(hub, { lane: "w1", account: "acct-b2", at: now + MIN });   // the pool's hooks name the account by its directory
    expect(await seatOf("acct-b2")).toMatchObject({ state: "out", why: "usage_limit" });
    expect(await seatOf("seat-a")).toBeUndefined();
  });
});
