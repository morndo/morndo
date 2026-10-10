// E10 for an id that isn't on the list (review of PR #2, finding F6): it expires 24 hours after it was asked. A round
// in which it wasn't sighted (its message scrolled out of view, or the history read came back empty) doesn't settle it:
// only its source closing it, an answer, or that expiry ends it.
import { describe, expect, it } from "vitest";
import { Escalations, TAP_TTL_MS, escalationId, type Ask, type Sighting } from "../src/index.ts";

const T0 = Date.UTC(2026, 9, 1, 8, 0);
const MIN = 60_000;

const ask = (id: string, over: Partial<Ask> = {}): Ask => ({
  id: escalationId(id), asker: { kind: "manager", name: "Manager", workerId: "%0" }, need: "decision",
  title: `Question ${id}`, shortTitle: null, summary: null, minutes: null, link: null, details: null, context: null, contextKind: "markdown",
  options: [{ key: "publish", label: "Publish", detail: null }, { key: "wait", label: "Wait", detail: null }],
  answerBy: "tap", recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null,
  askedAt: T0, messageId: `m-${id}`, tracking: "age", ...over,
});
const seen = (a: Ask): Sighting => ({ ask: a, source: { kind: "open" }, answered: null });

describe("E10: an id not on the list lasts its day, sighted or not", () => {
  it("a round without it keeps it open and answerable", () => {
    const x = new Escalations();
    x.reconcile([seen(ask("rel-3"))], T0, true);
    x.reconcile([], T0 + 30 * MIN, true);
    expect(x.get("rel-3")?.status).toBe("open");
    expect(x.check("rel-3", { kind: "option", key: "publish" }, T0 + 30 * MIN).ok).toBe(true);
  });
  it("unsighted, it expires a day after it was asked", () => {
    const x = new Escalations();
    x.reconcile([seen(ask("rel-3"))], T0, true);
    x.reconcile([], T0 + 30 * MIN, true);
    x.reconcile([], T0 + TAP_TTL_MS, true);
    expect(x.get("rel-3")?.status).toBe("expired");
    expect(x.check("rel-3", { kind: "option", key: "publish" }, T0 + TAP_TTL_MS)).toEqual({ ok: false, error: "expired" });
  });
  it("negative control: a worker's question (tracked by its source) that is no longer sighted is settled", () => {
    const x = new Escalations();
    x.reconcile([seen(ask("q-1", { tracking: "source", answerBy: "screen" }))], T0, true);
    x.reconcile([], T0 + MIN, true);
    expect(x.get("q-1")?.status).toBe("settled");
  });
});
