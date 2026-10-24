// Which account a lane's failure belongs to (plan 4.5 item 4): the hook's own word first, then the lane's record (the
// node's own before one the hub could not place, the newest at equal place), then the session, then the node's only
// account — and no account at all when the node holds two or none. And the closed list of limit words (U9).
import { describe, expect, it } from "vitest";
import { RECORD_FRESH_MS, limitKindOfError, resolveAccount, type FreshSession, type LaneRecord, type ResolveInput } from "../src/index.ts";

const T = 1_700_000_000_000;      // 10:00
const DAY = 86_400_000;
const record = (o: Partial<LaneRecord> = {}): LaneRecord =>
  ({ node: "pc", lane: "w1", account: "seat-a", at: T - 60_000, ...o });
const session = (o: Partial<FreshSession> = {}): FreshSession =>
  ({ account: "seat-a", sessionId: "sid-1", lane: "w1", ...o });
const input = (o: Partial<ResolveInput> = {}): ResolveInput => ({
  hookAccount: null, node: "pc", lane: "w1", sessionId: null, now: T, records: [], sessions: [],
  laneNode: () => null, ...o,
});

describe("which account a lane's failure belongs to (plan 4.5 item 4)", () => {
  it("the hook's own word wins, over a record, a session and a node's accounts alike", () => {
    expect(resolveAccount(input({ hookAccount: "seat-b", records: [record()], sessions: [session()], laneNode: () => "pc" })))
      .toEqual({ account: "seat-b", by: "hook" });
  });

  it("a record beats a session; a session beats the single-account rule; the hook field beats a stale record", () => {
    expect(resolveAccount(input({ records: [record({ account: "seat-a" })], sessions: [session({ account: "seat-b" })] })))
      .toEqual({ account: "seat-a", by: "record" });
    expect(resolveAccount(input({ records: [record({ account: "seat-a", lane: "w2" })], sessions: [session({ account: "seat-b" })], sessionId: "sid-1", laneNode: () => "pc" })))
      .toEqual({ account: "seat-b", by: "session" });
    expect(resolveAccount(input({ records: [record({ account: "seat-a", at: T - 8 * DAY })], hookAccount: "seat-b" })))
      .toEqual({ account: "seat-b", by: "hook" });
  });

  it("a record for the lane: this node's before one of node \"\", the newest at equal place; no lane, no record", () => {
    expect(resolveAccount(input({ records: [record({ node: "", account: "seat-b", at: T - 30_000 }), record({ account: "seat-a" })] })))
      .toEqual({ account: "seat-a", by: "record" });
    expect(resolveAccount(input({ records: [record({ account: "seat-b" })] }))).toEqual({ account: "seat-b", by: "record" });
    expect(resolveAccount(input({ records: [record({ account: "seat-b", at: T - 30_000 }), record({ account: "seat-c" })] })))
      .toEqual({ account: "seat-b", by: "record" });       // seat-b's stamp (T-30s) is the newer of the two
    expect(resolveAccount(input({ lane: null, records: [record()] }))).toEqual({ account: "seat-a", by: "node" });      // no lane: the record step is skipped, the node's only account still serves
  });

  it("a record older than seven days is ignored; seven days less one minute is not", () => {
    expect(resolveAccount(input({ records: [record({ at: T - RECORD_FRESH_MS - 1 })] }))).toEqual({ account: null, by: null });
    expect(resolveAccount(input({ records: [record({ at: T - RECORD_FRESH_MS + 60_000 })] }))).toEqual({ account: "seat-a", by: "record" });
    expect(RECORD_FRESH_MS).toBe(7 * DAY);
  });

  it("the session of the session id, when it is fresh; another session's id is not it", () => {
    expect(resolveAccount(input({ sessionId: "sid-1", sessions: [session()] }))).toEqual({ account: "seat-a", by: "session" });
    expect(resolveAccount(input({ sessionId: "sid-2", sessions: [session()] }))).toEqual({ account: null, by: null });
  });

  it("the node's only account: its records' and its fresh sessions' (through laneNode); two accounts or none is null; a node of \"\" is never the node", () => {
    expect(resolveAccount(input({ lane: null, records: [record({ lane: "w1" }), record({ lane: "w2", account: "default" })] })))
      .toEqual({ account: null, by: null });
    expect(resolveAccount(input({ lane: null, records: [record({ lane: "w1" }), record({ lane: "w2", account: "default" })], hookAccount: undefined, sessions: [session({ account: "default", lane: "w3" })], laneNode: lane => lane === "w3" ? "pc" : null })))
      .toEqual({ account: null, by: null });
    expect(resolveAccount(input({ lane: null, records: [], sessions: [session({ account: "default", lane: "w3" })], laneNode: lane => lane === "w3" ? "pc" : null })))
      .toEqual({ account: "default", by: "node" });
    expect(resolveAccount(input({ lane: null, records: [record({ node: "", lane: "w2", account: "seat-b" })] })))
      .toEqual({ account: null, by: null });
    expect(resolveAccount(input({ lane: null, node: "srv", records: [record({ lane: "w1" })] })))
      .toEqual({ account: null, by: null });
  });
});

describe("which failures are limits (U9)", () => {
  it("every error word, trimmed and lowercased; anything else is no limit", () => {
    expect(limitKindOfError("rate_limit")).toBe("usage_limit");
    expect(limitKindOfError("  Rate_Limit ")).toBe("usage_limit");
    expect(limitKindOfError("billing_error")).toBe("billing");
    expect(limitKindOfError("authentication_failed")).toBe("signed_out");
    expect(limitKindOfError("account_on_hold")).toBe("refused");
    expect(limitKindOfError("oauth_org_not_allowed")).toBe("refused");
    expect(limitKindOfError("overloaded")).toBeNull();
    expect(limitKindOfError("unknown")).toBeNull();
    expect(limitKindOfError("")).toBeNull();
  });
});
