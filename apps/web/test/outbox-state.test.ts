// The outbox's pure rules (ADR-0008 phase C; S7, S8): forward-only send states, the retry schedule and budget, and
// echo matching.
import { describe, expect, it } from "vitest";
import { LIMITS } from "@morndo/protocol";
import { ATTEMPT_TIMEOUT_MS, BUDGET_MS, HUB_KEEPS_MS, MAX_TEXT, RETRY_WINDOW_MS, advance, canEdit, canRetry, matchEchoes, retryDelay, withinBudget, type OutboxRecord } from "../src/lib/outbox/state.ts";

const rec = (id: string, createdAt: number, text: string, state: OutboxRecord["state"] = "sent"): OutboxRecord =>
  ({ id, worker: "%1", workerName: "alpha", text, uploads: [], createdAt, budgetFrom: createdAt, state, error: null, attempts: 1, seen: "none", sentAt: createdAt, typedAt: null });

describe("the longest one message", () => {
  it("is the protocol's maxMessageText", () => {
    expect(MAX_TEXT).toBe(LIMITS.maxMessageText);
    expect(MAX_TEXT).toBe(100_000);
  });
});

describe("send states move forward only (S8)", () => {
  it("queued, sending, sent", () => {
    expect(advance("queued", "sending")).toBe("sending");
    expect(advance("sending", "sent")).toBe("sent");
    expect(advance("queued", "sent")).toBe("sent");
  });
  it("never back", () => {
    expect(advance("sending", "queued")).toBe("sending");
    expect(advance("sent", "sending")).toBe("sent");
    expect(advance("sent", "queued")).toBe("sent");
  });
  it("a late error never undoes Sent", () => {
    expect(advance("sent", "failed")).toBe("sent");
  });
  it("a failure from queued or sending is Not sent, which only Retry leaves", () => {
    expect(advance("queued", "failed")).toBe("failed");
    expect(advance("sending", "failed")).toBe("failed");
    expect(advance("failed", "sending")).toBe("failed");
    expect(advance("failed", "sent")).toBe("failed");
    expect(advance("failed", "queued", true)).toBe("queued");
  });
  it("Uncertain moves only to what Check again finds: Sent (typed then or now) or Not sent (never typed, refused now)", () => {
    expect(advance("sending", "uncertain")).toBe("uncertain");
    expect(advance("uncertain", "queued", true)).toBe("uncertain");
    expect(advance("uncertain", "sending")).toBe("uncertain");
    expect(advance("uncertain", "queued")).toBe("uncertain");
    expect(advance("uncertain", "sent")).toBe("sent");
    expect(advance("uncertain", "failed")).toBe("failed");
  });
});

describe("retry schedule and budget (S7)", () => {
  it("1.5, 3, 6, 12 s, then 15 s", () => {
    expect([0, 1, 2, 3, 4, 9].map(retryDelay)).toEqual([1500, 3000, 6000, 12_000, 15_000, 15_000]);
  });
  it("retries on its own only for 2 minutes from when it was queued", () => {
    expect(withinBudget({ createdAt: 0 }, BUDGET_MS - 1)).toBe(true);
    expect(withinBudget({ createdAt: 0 }, BUDGET_MS)).toBe(false);
  });
  it("offers Retry for Not sent and Check again for Uncertain, only while a full 2 minutes would still end inside the hub's record (L1)", () => {
    expect(canRetry(rec("a", 0, "x", "failed"), RETRY_WINDOW_MS - 1)).toBe(true);
    expect(canRetry(rec("a", 0, "x", "failed"), RETRY_WINDOW_MS)).toBe(false);
    expect(RETRY_WINDOW_MS).toBeLessThanOrEqual(HUB_KEEPS_MS - BUDGET_MS);
    expect(canRetry(rec("a", 0, "x", "uncertain"), RETRY_WINDOW_MS - 1)).toBe(true);
    expect(canRetry(rec("a", 0, "x", "uncertain"), RETRY_WINDOW_MS)).toBe(false);
    expect(canRetry(rec("a", 0, "x", "sent"), 1)).toBe(false);
  });
  // A message to the manager waits in the hub while the fleet waits for the node
  // (LIMITS.deliveryOpTimeoutMs) and the hub's client 2 s more. An attempt given up sooner is sent again while the first
  // is still out, and the two overlap in the hub's queue.
  it("gives one POST longer than the hub may wait on the fleet for a message to the manager", () => {
    expect(ATTEMPT_TIMEOUT_MS).toBeGreaterThan(LIMITS.deliveryOpTimeoutMs + 2_000);
  });
});

describe("echo matching (S8)", () => {
  it("an echo ends the Sent record with its text", () => {
    expect(matchEchoes([rec("a", 10_000, "ship it")], [{ id: "m1", at: 10_500, text: "ship it" }])).toEqual(new Map([["a", "m1"]]));
  });
  it("only echoes newer than createdAt minus 5 s count", () => {
    expect(matchEchoes([rec("a", 10_000, "yes")], [{ id: "old", at: 4999, text: "yes" }]).size).toBe(0);
    expect(matchEchoes([rec("a", 10_000, "yes")], [{ id: "near", at: 5000, text: "yes" }]).get("a")).toBe("near");
  });
  it("one echo ends at most one record, the oldest first: two identical texts don't both vanish", () => {
    const m = matchEchoes([rec("b", 2000, "yes"), rec("a", 1000, "yes")], [{ id: "m1", at: 2500, text: "yes" }]);
    expect(m).toEqual(new Map([["a", "m1"]]));
  });
  it("two echoes end two records", () => {
    const m = matchEchoes([rec("a", 1000, "yes"), rec("b", 2000, "yes")], [{ id: "m2", at: 2600, text: "yes" }, { id: "m1", at: 2500, text: "yes" }]);
    expect(m).toEqual(new Map([["a", "m1"], ["b", "m2"]]));
  });
  it("only Sent records are matched: an echo proves nothing about a send the hub never confirmed", () => {
    for (const s of ["queued", "sending", "failed", "uncertain"] as const) {
      expect(matchEchoes([rec("a", 1000, "yes", s)], [{ id: "m1", at: 1500, text: "yes" }]).size, s).toBe(0);
    }
  });
  it("compares the text trimmed", () => {
    expect(matchEchoes([rec("a", 1000, "  ship it\n")], [{ id: "m1", at: 1500, text: "ship it" }]).size).toBe(1);
  });
  it("a Sent record whose delivery was given up does not consume a later echo of the same text", () => {
    const givenUp = { ...rec("old", 1000, "status of the release?"), delivery: { state: "given_up" as const, waiting: null, why: "cancelled" } };
    const again = rec("new", 2000, "status of the release?");
    expect(matchEchoes([givenUp, again], [{ id: "m1", at: 2500, text: "status of the release?" }])).toEqual(new Map([["new", "m1"]]));
  });
});

describe("echo matching on the clock of the machine that typed it (fleet core §3.1)", () => {
  it("that machine's clock 10 s behind the hub's: the echo matches by its typedAt; by the hub's time it doesn't (negative control)", () => {
    const hub = 100_000;                                                 // when the hub answered, on the hub's clock
    const node = hub - 10_000;                                           // the same moment on the node that typed it
    const echo = { id: "m1", at: node + 300, text: "ship it" };         // the transcript line, on the node's clock
    expect(matchEchoes([{ ...rec("a", hub, "ship it"), typedAt: node }], [echo]).get("a")).toBe("m1");
    expect(matchEchoes([{ ...rec("a", hub, "ship it"), hubAt: hub }], [echo]).size).toBe(0);
  });
  it("a record kept from before typedAt (hubAt only) is still matched by it", () => {
    expect(matchEchoes([{ ...rec("a", 100_000, "ship it"), hubAt: 90_000 }], [{ id: "m1", at: 90_200, text: "ship it" }]).get("a")).toBe("m1");
  });
});

describe("Retry or Edit (the rage QA: a Retry that could only fail again)", () => {
  const failed = (error: string) => ({ state: "failed", error, createdAt: 0 }) as unknown as Parameters<typeof canRetry>[0];
  it("too_long and empty are Edit, never Retry; any other refusal keeps Retry; stale is Edit", () => {
    for (const e of ["too_long", "empty"]) { expect(canRetry(failed(e), 1), e).toBe(false); expect(canEdit(failed(e)), e).toBe(true); }
    expect(canRetry(failed("node_offline"), 1)).toBe(true);
    expect(canEdit(failed("node_offline"))).toBe(false);
    expect(canEdit(failed("stale"))).toBe(true);
  });
});
