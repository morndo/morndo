// Home's usage helpers (S4, plan 4.4), pure: the account's health from its sources, the clock, a source's and a
// seat's line in the hub's closed words, and the decoding of the frame's notices. Synthetic accounts only.
import { describe, expect, it } from "vitest";
import type { AccountUsage, SeatView, SourceView } from "@morndo/domain";
import { accountHealth, clockOf, decodeNotices, seatLine, sourceLine } from "../src/lib/desktop/usage.ts";

const T = Date.UTC(2026, 9, 11, 21, 0, 0);
const MIN = 60_000;
const pad = (n: number) => String(n).padStart(2, "0");
const at = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

const src = (o: Partial<SourceView> = {}): SourceView => ({
  source: "app-server", node: null, state: "available", since: null, asOf: null, reason: null, fix: null, hint: null, ...o,
});
const acc = (sources?: SourceView[]): AccountUsage => ({
  account: "seat-a", reportedAt: T, fiveHour: null, sevenDay: null, spend: null, limits: null, onDemand: null, profile: null, sessions: [],
  ...(sources === undefined ? {} : { sources }),
});
const seat = (o: Partial<SeatView> = {}): SeatView => ({ state: "out", why: "usage_limit", since: T, backAt: T + 30 * MIN, owner: "derived", by: "a source", fix: null, ...o });

describe("accountHealth (S4)", () => {
  it("no sources at all — an older hub, or an account no source speaks of — is unknown, with no times", () => {
    expect(accountHealth(acc(undefined), T)).toEqual({ state: "unknown", since: null, asOf: null, sources: [] });
    expect(accountHealth(acc([]), T)).toEqual({ state: "unknown", since: null, asOf: null, sources: [] });
  });
  it("the best state among the sources wins: available beats stale beats unavailable beats missing", () => {
    const available = src({ state: "available", asOf: T });
    const stale = src({ source: "cli-screen", state: "stale", asOf: T - 20 * MIN });
    const unavailable = src({ source: "vendor-api", state: "unavailable", since: T - 2 * MIN });
    const missing = src({ source: "claude-usage", state: "missing" });
    expect(accountHealth(acc([available]), T).state).toBe("available");
    expect(accountHealth(acc([stale, available]), T).state).toBe("available");
    expect(accountHealth(acc([stale]), T).state).toBe("stale");
    expect(accountHealth(acc([unavailable, stale]), T).state).toBe("stale");
    expect(accountHealth(acc([unavailable, missing]), T).state).toBe("unavailable");
    expect(accountHealth(acc([missing]), T).state).toBe("missing");
  });
  it("since is the earliest among unavailable sources, and only when the best is unavailable; asOf is the newest any source gave", () => {
    const early = src({ state: "unavailable", since: T - 40 * MIN, asOf: T - 40 * MIN });
    const late = src({ source: "cli-screen", state: "unavailable", since: T - 5 * MIN, asOf: T - 5 * MIN });
    const live = src({ source: "claude-usage", state: "available", asOf: T - MIN });
    const h = accountHealth(acc([late, early]), T);
    expect(h.state).toBe("unavailable");
    expect(h.since).toBe(T - 40 * MIN);
    expect(h.asOf).toBe(T - 5 * MIN);
    expect(accountHealth(acc([early, live]), T)).toMatchObject({ state: "available", since: null, asOf: T - MIN });
  });
});

describe("clockOf", () => {
  it("says the hour and minute of the viewer's own clock, 24 h", () => {
    expect(clockOf(T)).toBe(at(T));
    expect(clockOf(Date.UTC(2026, 9, 11, 23, 59, 0))).toBe(at(Date.UTC(2026, 9, 11, 23, 59, 0)));
    expect(clockOf(T)).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe("sourceLine (the hub's closed words only)", () => {
  it("a source that reads now, one that last read a while ago, one that never read", () => {
    expect(sourceLine(src({ state: "available" }), T)).toBe("app-server: reading now");
    expect(sourceLine(src({ state: "stale" }), T)).toBe("app-server: last read a while ago");
    expect(sourceLine(src({ state: "missing" }), T)).toBe("app-server: no reading yet");
  });
  it("a failure says since when and why, in the reason's own words", () => {
    expect(sourceLine(src({ state: "unavailable", since: T - 5 * MIN, reason: "unknown_screen" }), T))
      .toBe(`app-server: can't read since ${at(T - 5 * MIN)}, its screen was not in a shape Morndo knows`);
    expect(sourceLine(src({ state: "unavailable", since: T - 5 * MIN, reason: "signed_out" }), T))
      .toBe(`app-server: can't read since ${at(T - 5 * MIN)}, it is signed out`);
    expect(sourceLine(src({ state: "unavailable", since: T - 5 * MIN, reason: "rate_limited" }), T))
      .toBe(`app-server: can't read since ${at(T - 5 * MIN)}, the provider is limiting reads`);
  });
  it("a stale source with a failure reason says it too; the node is not part of the line", () => {
    expect(sourceLine(src({ state: "stale", reason: "timeout", node: "mac-mini" }), T))
      .toBe("app-server: last read a while ago, the read took too long");
  });
});

describe("seatLine", () => {
  it("out with a back time, and out without one", () => {
    expect(seatLine(seat({ backAt: T + 30 * MIN }), T)).toBe(`Out until ${at(T + 30 * MIN)}`);
    expect(seatLine(seat({ backAt: null }), T)).toBe("Out (back time unknown)");
  });
  it("retired and signed out say their fix", () => {
    expect(seatLine(seat({ state: "retired", why: "refused", backAt: null }), T)).toBe("Retired: use another account");
    expect(seatLine(seat({ state: "logged-out", why: "signed_out", backAt: null }), T)).toBe("Signed out: sign in again");
  });
});

describe("decodeNotices", () => {
  const notice = { id: "seat-a|seat|out|usage_limit|3", kind: "seat", account: "seat-a", at: T, text: "seat-a: usage limit reached." };
  it("parses each row with the protocol's schema and keeps the order it was given (newest-first is the feed's job)", () => {
    const older = { ...notice, id: "n2", kind: "threshold", at: T - MIN, text: "seat-a: the 5-hour window passed 75%." };
    const d = decodeNotices([notice, older]);
    expect(d).toEqual({ notices: [notice, older], dropped: 0 });
  });
  it("drops a row that does not parse, and counts it", () => {
    const badKind = { ...notice, id: "n3", kind: "gossip" };
    const noText = { ...notice, id: "n4", text: undefined };
    expect(decodeNotices([notice, badKind, noText, null])).toEqual({ notices: [notice], dropped: 3 });
  });
});
