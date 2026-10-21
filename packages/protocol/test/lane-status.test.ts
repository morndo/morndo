// A lane's status line (reliable lanes §3.1): read the same at the node's relay and in the fleet's lane events.
import { describe, expect, it } from "vitest";
import { WAIT_MAX_MS, firstLineOf, statusLineOf } from "../src/lane-status.ts";

describe("the status line", () => {
  it("reads the four statuses, decorated as lanes write them", () => {
    expect(statusLineOf("STATUS: DONE")).toEqual({ status: "done" });
    expect(statusLineOf("**STATUS: BLOCKED** on the staging key")).toEqual({ status: "blocked" });
    expect(statusLineOf("- Status — needs decision")).toEqual({ status: "needs_decision" });
    expect(statusLineOf("STATUS: WAITING")).toEqual({ status: "waiting" });
  });

  it("reads a checkpoint line as NEEDS DECISION, which the board maps to blocked (B11)", () => {
    expect(statusLineOf("STATUS: NEEDS DECISION checkpoint: the schema is in, the migration is not")).toEqual({ status: "needs_decision" });
  });

  it("reads what a wait is on and for how long, a day at most", () => {
    expect(statusLineOf("STATUS: WAITING on CI for 20 min")).toEqual({ status: "waiting", waitingOn: "CI", forMs: 20 * 60_000 });
    expect(statusLineOf("STATUS: WAITING — the deploy to finish, for 2h.")).toEqual({ status: "waiting", waitingOn: "the deploy to finish", forMs: 2 * 3_600_000 });
    expect(statusLineOf("STATUS: WAITING for 45 minutes on review")).toEqual({ status: "waiting", waitingOn: "review", forMs: 45 * 60_000 });
    expect(statusLineOf("STATUS: WAITING on the nightly run for 30 hours")?.forMs).toBe(WAIT_MAX_MS);
    expect(statusLineOf(`STATUS: WAITING on ${"x".repeat(300)}`)?.waitingOn).toHaveLength(120);
  });

  it("states no status unless the line says one (negative controls)", () => {
    expect(statusLineOf("All done, the tests pass.")).toBeNull();
    expect(statusLineOf("The status is DONE")).toBeNull();
    expect(statusLineOf("STATUS: DONEISH")).toBeNull();
    expect(statusLineOf("")).toBeNull();
  });

  it("reads the first line that isn't blank, at most 200 characters", () => {
    expect(firstLineOf("\n\n  STATUS: DONE  \nrest")).toBe("STATUS: DONE");
    expect(firstLineOf("y".repeat(300))).toHaveLength(200);
    expect(firstLineOf("")).toBe("");
  });
});
