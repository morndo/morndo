// Asking the asker to restate a decision as a brief is one wording and one error voice, shared by the desktop modal
// and the phone sheet (review round 1). The surfaces bring their own passkey gate and queue. Synthetic data only.
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/api.ts";
import { askForBrief, type AskWorker } from "../src/lib/ask-brief.ts";
import type { DecisionItem } from "../src/lib/desktop/decisions.ts";

const ask = (over: Partial<DecisionItem> = {}): DecisionItem => ({
  id: "d-1" as DecisionItem["id"],
  asker: { kind: "worker", name: "alpha", workerId: "node.1.alpha.0" },
  need: "decision", title: "Approve option B: extend the triage script", shortTitle: "Triage", summary: null, minutes: null,
  link: null, details: null, context: null, contextKind: "markdown",
  options: [{ key: "b", label: "Extend the triage script", detail: null }],
  answerBy: "tap", recommendation: null, ifNoAnswer: null, deadline: null, blocking: false,
  project: null, askedAt: 0, messageId: null, tracking: "hub", status: "open", source: "open",
  decision: null, resolution: null, settledAt: null, askedAgain: false, answerable: null,
  version: "v1", inbox: null, brief: null, briefVersion: 0, draftedBy: null,
  ...over,
});

describe("asking for a brief", () => {
  it("says when there is no one to ask, before any passkey check", async () => {
    let verified = 0;
    const out = await askForBrief(
      ask({ asker: { kind: "manager", name: "Manager", workerId: null } }),
      [],
      async () => { throw new Error("not reached"); },
      async () => { verified += 1; return null; },
    );
    expect(out).toEqual({ ok: false, error: "This decision has no one to ask." });
    expect(verified).toBe(0);
  });

  it("brings the passkey gate's refusal through and queues nothing", async () => {
    const queued: unknown[] = [];
    const out = await askForBrief(ask(), [], async c => { queued.push(c); }, async () => "Not sent: the passkey check didn't finish.");
    expect(out).toEqual({ ok: false, error: "Not sent: the passkey check didn't finish." });
    expect(queued).toEqual([]);
  });

  it("sends the restate command to the asker's pane, with what it waits on", async () => {
    const queued: { worker: string; workerName: string; text: string; seen: string }[] = [];
    const roster: AskWorker[] = [{ id: "node.1.alpha.0", name: "alpha", waitingOn: "review" }];
    const out = await askForBrief(ask(), roster, async c => { queued.push(c); }, async () => null);
    expect(out).toEqual({ ok: true });
    expect(queued).toEqual([{ worker: "node.1.alpha.0", workerName: "alpha", text: "Please restate d-1 as a decision brief: morndo-decide template", seen: "review" }]);
  });

  it("names the asker itself when the roster doesn't hold it, and waits on nothing", async () => {
    const queued: { worker: string; workerName: string; text: string; seen: string }[] = [];
    const out = await askForBrief(ask(), [], async c => { queued.push(c); }, async () => null);
    expect(out).toEqual({ ok: true });
    expect(queued).toEqual([{ worker: "node.1.alpha.0", workerName: "alpha", text: "Please restate d-1 as a decision brief: morndo-decide template", seen: "none" }]);
  });

  it("explains a queue failure, on the phone as on the desktop", async () => {
    const out = await askForBrief(ask(), [], async () => { throw new ApiError(429, "rate_limited", 30_000); }, async () => null);
    expect(out).toEqual({ ok: false, error: "Too many attempts. Try again in 30 seconds." });
  });
});
