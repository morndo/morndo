// Lane stalls, fresh review (2026-10-29): the line's own `for <N>` is its duration. A number with a unit earlier in the
// line, in parentheses or after a comma, describes the work ("5 min each"), not the wait; it is read only when the line
// has no `for` duration at all.
import { describe, expect, it } from "vitest";
import { statusLineOf } from "../src/lane-status.ts";

const MIN = 60_000;

describe("a WAITING line with more than one duration", () => {
  it("waits its `for` duration, and keeps the earlier one in what it waits on", () => {
    expect(statusLineOf("STATUS: WAITING on 12 shards (5 min each) for 1 h")).toEqual({ status: "waiting", waitingOn: "12 shards (5 min each)", forMs: 60 * MIN });
    expect(statusLineOf("STATUS: WAITING on the import, 3 min per batch, for about 40 min")).toEqual({ status: "waiting", waitingOn: "the import, 3 min per batch", forMs: 40 * MIN });
  });

  it("reads a comma or parenthesis duration when there is no `for` one", () => {
    expect(statusLineOf("STATUS: WAITING on wave 1 to finish, about 265 min")?.forMs).toBe(265 * MIN);
    expect(statusLineOf("STATUS: WAITING on `make check` (about 7 min)")?.forMs).toBe(7 * MIN);
  });
});
