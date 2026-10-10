// Review B4 (characterization, passes at bddbea8): a Command handed to the manager's inbox reads "Queued, it will be
// delivered" for as long as the outbox keeps it (KEEP_SENT_MS, a day); the 10-minute "not seen" warning never shows.
import { describe, expect, it } from "vitest";
import { BUDGET_MS, RETRY_WINDOW_MS, UNSEEN_AFTER_MS, canRetry, type OutboxRecord } from "../src/lib/outbox/state.ts";
import { sendLabel } from "../src/lib/outbox/words.ts";

const SENT = 1_000_000;
const rec = (o: Partial<OutboxRecord> = {}): OutboxRecord => ({
  id: "a", worker: "%0", workerName: "manager", text: "go", uploads: [], createdAt: SENT, budgetFrom: SENT, state: "sent", error: null, attempts: 1, seen: "none", sentAt: SENT, typedAt: null, hubAt: SENT, ...o,
});

describe("B4: a queued Command's label", () => {
  it("typed directly: after 10 minutes without an echo it says so", () => {
    expect(sendLabel(rec(), [], SENT + UNSEEN_AFTER_MS + 1)).toBe("Sent, not seen in the conversation yet");
  });
  it("says Not sent, and offers Retry, only when the spool expired a command it never typed", () => {
    const q = rec({ queued: true });
    // Past two minutes with no spool word yet: still queued. The clock is not a verdict.
    expect(sendLabel(q, [q], SENT + BUDGET_MS)).toBe("Queued, it will be delivered");
    expect(canRetry(q, SENT + BUDGET_MS)).toBe(false);
    const own = (inbox: NonNullable<OutboxRecord["inbox"]>, inboxReason?: string) =>
      sendLabel({ ...q, inbox, ...(inboxReason ? { inboxReason } : {}) }, [q], SENT + BUDGET_MS);
    expect(own("accepted")).toBe("Accepted, waiting to be delivered");
    expect(own("sent")).toBe("Sent, not seen in the conversation yet");
    expect(own("stuck")).toBe("Stuck, still waiting to be delivered");
    expect(own("sent", "unconfirmed")).toBe("Sent, not confirmed in the conversation yet");
    for (const inbox of ["accepted", "sent", "stuck"] as const) expect(canRetry({ ...q, inbox }, SENT + BUDGET_MS)).toBe(false);
    expect(canRetry({ ...q, inbox: "lost" }, SENT + BUDGET_MS)).toBe(true);
    expect(canRetry({ ...q, inbox: "cancelled" }, SENT + BUDGET_MS)).toBe(true);
    expect(sendLabel({ ...q, inbox: "lost" }, [q], SENT + BUDGET_MS)).not.toBe("Not sent");
    const expired = { ...q, inbox: "expired" as const };
    expect(sendLabel(expired, [expired], SENT + BUDGET_MS)).toBe("Not sent");
    expect(canRetry(expired, SENT + BUDGET_MS)).toBe(true);
    expect(canRetry(expired, SENT + RETRY_WINDOW_MS)).toBe(false);
  });
});
