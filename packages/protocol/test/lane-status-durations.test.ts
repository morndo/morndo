// How long a WAITING line says, read the way lanes write it (lane stalls, 2026-10-28): 198 of 723 WAITING lines in nine
// days named a duration the `for <N> min` rule did not read ("for about 25 min", "for ~20 min", ", about 265 min",
// "(about 7 min)", "for up to 60 min", "for 20+ min"), so each got the 30-minute default. And a lane's own estimate is
// short of the real wait often enough (p90 of actual/declared 1.05, p95 1.31) that the lease is 1.5 times it plus 10 min.
import { describe, expect, it } from "vitest";
import { WAIT_MAX_MS, statusLineOf, waitLeaseMs } from "../src/lane-status.ts";

const MIN = 60_000;

describe("a WAITING line's duration, as lanes write it", () => {
  it("reads about, ~, up to, a trailing +, a range's upper end, a decimal, after `for`, a comma or a parenthesis", () => {
    expect(statusLineOf("STATUS: WAITING T-107 on wave 1 to finish, about 265 min")).toEqual({ status: "waiting", taskKey: "T-107", waitingOn: "wave 1 to finish", forMs: 265 * MIN });
    expect(statusLineOf("STATUS: WAITING T-378 CI on 42c424d08 for about 20 min")).toEqual({ status: "waiting", taskKey: "T-378", waitingOn: "CI on 42c424d08", forMs: 20 * MIN });
    expect(statusLineOf("STATUS: WAITING T-376 Jest on cfde1a0 for ~10 min")).toEqual({ status: "waiting", taskKey: "T-376", waitingOn: "Jest on cfde1a0", forMs: 10 * MIN });
    expect(statusLineOf("STATUS: WAITING on the shared test lock (`/tmp/x-tests.lock`) for 20+ min")).toEqual({ status: "waiting", waitingOn: "the shared test lock (`/tmp/x-tests.lock`)", forMs: 20 * MIN });
    expect(statusLineOf("STATUS: WAITING T-451 on `make check` (about 7 min)")).toEqual({ status: "waiting", taskKey: "T-451", waitingOn: "`make check`", forMs: 7 * MIN });
    expect(statusLineOf("STATUS: WAITING on the executor's final sweep, for about 5–10 min")).toEqual({ status: "waiting", waitingOn: "the executor's final sweep", forMs: 10 * MIN });
    expect(statusLineOf("STATUS: WAITING on #177 (df41c630), for up to 60 min")).toEqual({ status: "waiting", waitingOn: "#177 (df41c630)", forMs: 60 * MIN });
    expect(statusLineOf("STATUS: WAITING on the nightly import for 1.5 h")).toEqual({ status: "waiting", waitingOn: "the nightly import", forMs: 90 * MIN });
    expect(statusLineOf("STATUS: WAITING on review for about 2 hours")).toEqual({ status: "waiting", waitingOn: "review", forMs: 120 * MIN });
    expect(statusLineOf("STATUS: WAITING on the backfill, about 30 hours")?.forMs).toBe(WAIT_MAX_MS);
  });

  it("keeps reading the plain form as before, and a bold line's decoration is no part of what it waits on", () => {
    expect(statusLineOf("STATUS: WAITING on CI for 20 min")).toEqual({ status: "waiting", waitingOn: "CI", forMs: 20 * MIN });
    expect(statusLineOf("**STATUS: WAITING on CI for 20 min**")).toEqual({ status: "waiting", waitingOn: "CI", forMs: 20 * MIN });
    expect(statusLineOf("**STATUS: WAITING on the review**")).toEqual({ status: "waiting", waitingOn: "the review" });
    expect(statusLineOf("STATUS: WAITING for 45 minutes on review")).toEqual({ status: "waiting", waitingOn: "review", forMs: 45 * MIN });
  });

  it("takes no duration from a number that is not one (negative controls)", () => {
    expect(statusLineOf("STATUS: WAITING on the 30 min CI job")).toEqual({ status: "waiting", waitingOn: "the 30 min CI job" });
    expect(statusLineOf("STATUS: WAITING T-316 on main CI for 2331eef")).toEqual({ status: "waiting", taskKey: "T-316", waitingOn: "main CI for 2331eef" });
    expect(statusLineOf("STATUS: WAITING on PR 1121 CI, run 39841853073")).toEqual({ status: "waiting", waitingOn: "PR 1121 CI, run 39841853073" });
  });
});

describe("a wait's lease", () => {
  it("is the lane's estimate times 1.5 plus 10 minutes, at most a day", () => {
    expect(waitLeaseMs(20 * MIN)).toBe(40 * MIN);
    expect(waitLeaseMs(10 * MIN)).toBe(25 * MIN);
    expect(waitLeaseMs(265 * MIN)).toBe(24_450_000);
    expect(waitLeaseMs(WAIT_MAX_MS)).toBe(WAIT_MAX_MS);
  });
});
