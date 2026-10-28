// R3 with a background shell still running (lane stalls, 2026-10-28): Claude Code shows the session as `shell` while a
// background shell runs after the turn ended, and wakes the lane when it ends ("paused waiting for background work to
// wake it back up", Stop input, https://code.claude.com/docs/en/hooks). So that wait is not overdue while the shell runs,
// up to BACKGROUND_LIVE_MAX_MS after the turn end (a `tail -f` must not hide a lane for ever). 48 of 74 stale events in a
// week came from a lane whose own background job or wake-up was still armed.
import { describe, expect, it } from "vitest";
import { BACKGROUND_LIVE_MAX_MS, deriveRun, type RunFacts, type TurnEnd } from "../src/run.ts";

const T0 = Date.parse("2026-10-20T12:00:00.000Z");
const MIN = 60_000;
const shellTask = { type: "shell", label: "gh pr checks 12 --watch" };
const turn = (o: Partial<TurnEnd> = {}): TurnEnd => ({ at: T0, status: null, line: "", tasks: [shellTask], wakes: [], waitingOn: null, until: null, ...o });
const facts = (o: Partial<RunFacts> = {}): RunFacts => ({
  lane: "alpha", node: "pc", nodeOnline: true, windowAlive: true, session: "shell", turn: turn(), activity: null, needsInput: null, jobs: [],
  waitMs: 30 * MIN, tzOffsetMin: 0, changedAt: T0 - 5 * MIN, now: T0 + 31 * MIN, ...o,
});

describe("R3: a background shell still running", () => {
  it("is six hours at most", () => {
    expect(BACKGROUND_LIVE_MAX_MS).toBe(6 * 3_600_000);
  });

  it("keeps a background wait from being overdue past its lease while the session shows `shell`", () => {
    const r = deriveRun(facts());
    expect(r.phase).toBe("waiting");
    expect(r.wait?.on).toBe("background");
    expect(r.overdue).toBe(false);
    expect(r.deadline).toBe(T0 + BACKGROUND_LIVE_MAX_MS);
  });

  it("is overdue past its lease once the shell is gone, as before (negative control)", () => {
    const r = deriveRun(facts({ session: "idle" }));
    expect(r.overdue).toBe(true);
    expect(r.deadline).toBe(T0 + 30 * MIN);
  });

  it("is overdue past six hours even while the shell runs", () => {
    expect(deriveRun(facts({ now: T0 + BACKGROUND_LIVE_MAX_MS + MIN })).overdue).toBe(true);
  });

  it("keeps a WAITING line's own lease when it is later", () => {
    const until = T0 + BACKGROUND_LIVE_MAX_MS + 60 * MIN;
    const r = deriveRun(facts({ turn: turn({ status: "waiting", until }), now: T0 + BACKGROUND_LIVE_MAX_MS + MIN }));
    expect(r.overdue).toBe(false);
    expect(r.deadline).toBe(until);
  });
});
