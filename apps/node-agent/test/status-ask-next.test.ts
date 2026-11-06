// The relay's ask for a next (T-805, B22): a Stop whose answer ends BLOCKED or NEEDS DECISION with no next: is asked
// for one, so a block names who owes the next move and by when. The status ask keeps priority, a WAITING line keeps
// its waker ask, the contract can turn the next ask off, and NEXT_ASK's own examples parse as a next. Pure.
import { describe, expect, it } from "vitest";
import { statusLineOf } from "@morndo/protocol";
import { ConfigError, parsePolicy, type StatusContract } from "../src/config.ts";
import { NEXT_ASK, STATUS_ASK, statusAsk, wakerAsk, type JobsOf } from "../src/relay/status-ask.ts";

const ASK: StatusContract = { mode: "ask", exempt: ["manager"] };
const stop = (over: Record<string, unknown> = {}) => ({
  session_id: "s1", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "I pushed the branch.", background_tasks: [], session_crons: [], ...over,
});
const none: JobsOf = () => 0;

describe("a BLOCKED line with no next is asked for one (B22); a decision is not: the board makes no wait of it", () => {
  it("a keyed BLOCKED line, nothing running or scheduled: NEXT_ASK; a NEEDS DECISION line: nothing, its deadline and the inbox are its watch", () => {
    expect(statusAsk(stop({ last_assistant_message: "STATUS: BLOCKED T-12 stuck" }), "api", ASK)).toBe(NEXT_ASK);
    expect(statusAsk(stop({ last_assistant_message: "STATUS: NEEDS DECISION T-12 which db?" }), "api", ASK)).toBeNull();
  });
  it("the same when the relay can count jobs (it always passes jobsOf): a BLOCKED line is asked whatever the count, a WAITING one is not asked for a next", () => {
    for (const jobs of [0, 1]) {
      expect(statusAsk(stop({ last_assistant_message: "STATUS: BLOCKED T-12 stuck" }), "api", ASK, () => jobs), `${jobs} jobs`).toBe(NEXT_ASK);
      expect(statusAsk(stop({ last_assistant_message: "STATUS: NEEDS DECISION T-12 which db?" }), "api", ASK, () => jobs), `${jobs} jobs`).toBeNull();
    }
    expect(statusAsk(stop({ last_assistant_message: "STATUS: WAITING on CI for 5 min" }), "api", ASK, () => 1)).toBeNull();
    // Something still running or scheduled in the session: the turn is not over, so no ask of any kind (as before).
    expect(statusAsk(stop({ last_assistant_message: "STATUS: BLOCKED T-12 stuck", background_tasks: [{ id: "b1" }] }), "api", ASK, none)).toBeNull();
  });
  it("never once the line carries a next", () => {
    expect(statusAsk(stop({ last_assistant_message: "STATUS: BLOCKED T-12 stuck, next: owner by 2026-11-05" }), "api", ASK)).toBeNull();
  });
  it("never for a settled or a waiting line: a wait has its lease and its waker (W1), and makes no block", () => {
    expect(statusAsk(stop({ last_assistant_message: "STATUS: DONE T-12" }), "api", ASK)).toBeNull();
    expect(statusAsk(stop({ last_assistant_message: "STATUS: WAITING on CI for 5 min" }), "api", ASK, () => 1)).toBeNull();
  });
  it("never under the rules every ask already has: after a Stop-hook continuation, an exempt window, mode off, or contract next off", () => {
    expect(statusAsk(stop({ last_assistant_message: "STATUS: BLOCKED T-12 stuck", stop_hook_active: true }), "api", ASK)).toBeNull();
    expect(statusAsk(stop({ last_assistant_message: "STATUS: BLOCKED T-12 stuck" }), "manager", ASK)).toBeNull();
    expect(statusAsk(stop({ last_assistant_message: "STATUS: BLOCKED T-12 stuck" }), null, ASK)).toBeNull();
    expect(statusAsk(stop({ last_assistant_message: "STATUS: BLOCKED T-12 stuck" }), "api", { mode: "off", exempt: [] })).toBeNull();
    expect(statusAsk(stop({ last_assistant_message: "STATUS: BLOCKED T-12 stuck" }), "api", { mode: "ask", exempt: [], next: "off" })).toBeNull();
  });
  it("the status ask keeps priority, and a WAITING line with no waker keeps its waker ask, as before", () => {
    expect(statusAsk(stop(), "api", ASK)).toBe(STATUS_ASK);
    expect(statusAsk(stop({ last_assistant_message: "STATUS: WAITING on CI for 10 min" }), "builder", ASK, none)).toBe(wakerAsk("builder", "CI"));
  });
  it("NEXT_ASK's own examples parse as a next", () => {
    expect(NEXT_ASK).toContain("End your status line with: next:");
    expect(NEXT_ASK).toContain("Then end the turn with your status line again.");
    expect(NEXT_ASK).toContain("under 200 characters");          // firstLineOf cuts a status line at 200: a next: past it is lost
    const EXAMPLE = /next: [a-z0-9][a-z0-9-]* by (?:\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?|in \d{1,6} (?:minutes|mins|min|hours|hour|h))/g;
    const examples = [...NEXT_ASK.matchAll(EXAMPLE)].map(m => m[0]);
    expect(examples.length).toBeGreaterThanOrEqual(1);
    for (const e of examples) expect(statusLineOf(`STATUS: BLOCKED ${e}`)?.next, e).toMatchObject({ who: expect.any(String) });
    // A lane copies an example as it stands: one that names a fixed date goes stale the day it passes, and the block
    // it makes then has no wait. Every example must still point ahead of now, whenever the test runs.
    const now = Date.now();
    for (const e of examples) {
      const by = statusLineOf(`STATUS: BLOCKED ${e}`)?.next?.by;
      const ahead = by === undefined ? false : "at" in by ? by.at > now : by.inMs > 0;
      expect(ahead, `${e} points ahead of now`).toBe(true);
    }
  });
});

describe("the status contract's next field", () => {
  it("accepts ask and off, defaults to ask, and refuses anything else naming next", () => {
    expect(parsePolicy({ statusContract: { next: "off" } }, "policy.json").statusContract).toMatchObject({ next: "off" });
    expect(parsePolicy({ statusContract: { next: "ask" } }, "policy.json").statusContract).toMatchObject({ mode: "ask" });
    expect(parsePolicy({}, "policy.json").statusContract).toMatchObject({ mode: "ask", exempt: ["manager"] });
    expect(parsePolicy({ statusContract: {} }, "policy.json").statusContract.next ?? "ask").toBe("ask");
    expect(() => parsePolicy({ statusContract: { next: "maybe" } }, "policy.json")).toThrow(ConfigError);
    expect(() => parsePolicy({ statusContract: { next: "maybe" } }, "policy.json")).toThrow(/statusContract\.next/);
  });
  it("an unknown field still throws, and the known list names next among the rest", () => {
    expect(() => parsePolicy({ statusContract: { bogus: true } }, "policy.json")).toThrow(/known: mode, exempt, next/);
  });
});
