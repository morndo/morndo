// E13 (fleet-clients §9.1; ADR-0014, with ADR-0010's domain rules): a Decision for the manager handed to the fleet's
// delivery queue counts as given while queued (E8), is recorded once delivered, at the time it reached the manager;
// "uncertain" (typed, never seen taken) keeps it given and is never asked again; given up (never typed), the ask is open
// again. Only the Decision that was queued moves: a newer one, or an ask asked again since, is left alone (#29's code
// review B3), and one restored after a restart moves before its ask is sighted (B5). Synthetic asks.
import { describe, expect, it } from "vitest";
import { Escalations, answered, endpointId, escalationId, sameDecision, sessionId, type Ask, type Decision } from "../src/index.ts";

const T0 = Date.UTC(2026, 9, 8, 9);
const BY = { endpointId: endpointId("ep1"), sessionId: sessionId("s1") };
const SHIP = { kind: "option" as const, key: "ship", label: "Ship it" };          // as decided: the label is the ask's
const ask = (o: Partial<Ask> = {}): Ask => ({
  id: escalationId("ny-7"), asker: { kind: "manager", name: "Manager", workerId: null }, need: "decision", title: "Ship it tonight?",
  shortTitle: null, summary: null, minutes: null, link: null, details: null, context: null, contextKind: "markdown",
  options: [{ key: "ship", label: "Ship it", detail: null }, { key: "hold", label: "Hold", detail: null }], answerBy: "tap",
  recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null, askedAt: T0 - 60_000, messageId: "m1",
  tracking: "ledger", ...o,
});
const board = () => {
  const x = new Escalations();
  x.reconcile([{ ask: ask(), source: { kind: "open" }, answered: null }], T0, true);
  return x;
};
const queued = (x: Escalations): Decision => {
  const q = x.queue("ny-7", { kind: "option", key: "ship" }, BY, T0);
  if (!q.ok) throw new Error(`not queued: ${q.error}`);
  return q.value;
};

describe("a Decision through the delivery queue (E13)", () => {
  it("queued counts as given (E8): answered, a second answer refused, nothing recorded yet", () => {
    const x = board();
    const d = queued(x);
    expect(d).toEqual({ choice: SHIP, at: T0, via: "here", ...BY, delivery: { state: "queued", at: null } });
    expect(x.get("ny-7")).toMatchObject({ status: "answered", decision: d });
    expect(x.check("ny-7", { kind: "option", key: "hold" }, T0 + 1)).toEqual({ ok: false, error: "already_answered" });
  });

  it("delivered: recorded once, at the time it reached the manager", () => {
    const x = board();
    const d = queued(x);
    expect(x.delivered("ny-7", d, T0 + 5000)).toEqual({ type: "EscalationAnswered", escalationId: "ny-7", choice: SHIP, ...BY, at: T0 + 5000 });
    expect(x.get("ny-7")?.decision?.delivery).toEqual({ state: "delivered", at: T0 + 5000 });
    expect(x.delivered("ny-7", d, T0 + 6000)).toBeNull();                 // a second word on it records nothing
  });

  it("uncertain: still answered, never open again, and not recorded", () => {
    const x = board();
    const d = queued(x);
    expect(x.uncertain("ny-7", d)).toBe(true);
    expect(x.get("ny-7")).toMatchObject({ status: "answered", decision: { delivery: { state: "uncertain", at: null } } });
    expect(x.withdraw("ny-7", d)).toBe(false);                              // only a queued Decision is given up
    expect(x.delivered("ny-7", d, T0 + 5000)).toBeNull();
  });

  it("given up: the ask is open again, and another answer is taken", () => {
    const x = board();
    const d = queued(x);
    expect(x.withdraw("ny-7", d)).toBe(true);
    expect(x.get("ny-7")).toMatchObject({ status: "open", decision: null });
    expect(x.check("ny-7", { kind: "option", key: "hold" }, T0 + 1).ok).toBe(true);
  });

  it("asked again meanwhile: the old queued Decision moves nothing on the new ask (negative control)", () => {
    const x = board();
    const d = queued(x);
    x.reconcile([{ ask: ask({ messageId: "m2", askedAt: T0 + 1000 }), source: { kind: "open" }, answered: null }], T0 + 1000, true);
    expect(x.get("ny-7")).toMatchObject({ status: "open", decision: null, askedAgain: true });
    expect(x.delivered("ny-7", d, T0 + 2000)).toBeNull();
    expect(x.uncertain("ny-7", d)).toBe(false);
    expect(x.withdraw("ny-7", d)).toBe(false);
    expect(x.get("ny-7")).toMatchObject({ status: "open", decision: null });
  });

  it("given up, then answered again: a late word on the first Decision moves nothing on the second", () => {
    const x = board();
    const first = queued(x);
    expect(x.withdraw("ny-7", first)).toBe(true);
    const q = x.queue("ny-7", { kind: "option", key: "hold" }, BY, T0 + 1000);
    if (!q.ok) throw new Error(q.error);
    expect(x.delivered("ny-7", first, T0 + 2000)).toBeNull();
    expect(x.uncertain("ny-7", first)).toBe(false);
    expect(x.get("ny-7")?.decision).toEqual(q.value);
  });

  it("restored after a restart and not sighted yet: delivered acts on the restored Decision, which the ask then shows", () => {
    const x = new Escalations();
    const d: Decision = { choice: SHIP, at: T0, via: "here", ...BY, delivery: { state: "queued", at: null } };
    x.restore([{ id: escalationId("ny-7"), decision: d }]);
    expect(x.delivered("ny-7", d, T0 + 5000)?.at).toBe(T0 + 5000);
    x.reconcile([{ ask: ask(), source: { kind: "open" }, answered: null }], T0 + 6000, true);
    expect(x.get("ny-7")).toMatchObject({ status: "answered", decision: { delivery: { state: "delivered", at: T0 + 5000 } } });
  });

  it("restored and uncertain before it is sighted: the ask comes back answered, may have been delivered", () => {
    const x = new Escalations();
    const d: Decision = { choice: SHIP, at: T0, via: "here", ...BY, delivery: { state: "queued", at: null } };
    x.restore([{ id: escalationId("ny-7"), decision: d }]);
    expect(x.uncertain("ny-7", d)).toBe(true);
    x.reconcile([{ ask: ask(), source: { kind: "open" }, answered: null }], T0 + 6000, true);
    expect(x.get("ny-7")).toMatchObject({ status: "answered", decision: { delivery: { state: "uncertain", at: null } } });
  });

  it("restored and given up before it is sighted: the ask comes back open", () => {
    const x = new Escalations();
    const d: Decision = { choice: SHIP, at: T0, via: "here", ...BY, delivery: { state: "queued", at: null } };
    x.restore([{ id: escalationId("ny-7"), decision: d }]);
    expect(x.withdraw("ny-7", d)).toBe(true);
    x.reconcile([{ ask: ask(), source: { kind: "open" }, answered: null }], T0 + 6000, true);
    expect(x.get("ny-7")).toMatchObject({ status: "open", decision: null });
  });

  it("the same Decision: its moment, endpoint, session and choice, whatever its delivery says", () => {
    const d: Decision = { choice: SHIP, at: T0, via: "here", ...BY, delivery: { state: "queued", at: null } };
    expect(sameDecision({ ...d, delivery: { state: "delivered", at: T0 + 1 } }, d)).toBe(true);
    expect(sameDecision({ ...d, delivery: { state: "uncertain", at: null } }, d)).toBe(true);
    expect(sameDecision({ ...d, at: T0 + 1 }, d)).toBe(false);
    expect(sameDecision({ ...d, choice: { kind: "words" } }, d)).toBe(false);
    expect(sameDecision(null, d)).toBe(false);
    expect(answered(escalationId("ny-7"), { ...d, delivery: { state: "delivered", at: T0 + 9 } }).at).toBe(T0 + 9);
    expect(answered(escalationId("ny-7"), { ...d, delivery: undefined }).at).toBe(T0);
  });
});
