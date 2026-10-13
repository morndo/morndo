import { describe, expect, it } from "vitest";
import {
  askIdentity, askVersion,
  Escalations, LEDGER_GRACE_MS, TAP_TTL_MS, endpointId, escalationId, sessionId,
  type Ask, type Sighting, type SourceState,
} from "../src/index.ts";

const T0 = Date.UTC(2026, 9, 1, 8, 0);
const MIN = 60_000;
const by = { endpointId: endpointId("e1"), sessionId: sessionId("s1") };

const ask = (id: string, over: Partial<Ask> = {}): Ask => ({
  id: escalationId(id), asker: { kind: "manager", name: "Manager", workerId: "%0" }, need: "decision",
  title: `Question ${id}`, shortTitle: null, summary: null, minutes: null, link: null, details: null, context: "Some context.", contextKind: "markdown",
  options: [{ key: "ship", label: "Ship it", detail: null }, { key: "hold", label: "Hold", detail: null }],
  answerBy: "tap", recommendation: null, ifNoAnswer: "hold", deadline: null, blocking: false, project: null,
  askedAt: T0, messageId: `m-${id}`, tracking: id.startsWith("ny-") ? "ledger" : "age", ...over,
});
const open: SourceState = { kind: "open" };
const seen = (a: Ask, source: SourceState = open, answered: Sighting["answered"] = null): Sighting => ({ ask: a, source, answered });

describe("E1: one Escalation per id", () => {
  it("keeps one item when the same id is sighted twice, and the newest wording wins", () => {
    const x = new Escalations();
    x.reconcile([seen(ask("ny-1"))], T0, true);
    x.reconcile([seen(ask("ny-1", { title: "Reworded", askedAt: T0 + MIN }))], T0 + MIN, true);
    expect(x.list()).toHaveLength(1);
    expect(x.get("ny-1")?.title).toBe("Reworded");
  });
  it("reports a change only when something visible changed", () => {
    const x = new Escalations();
    expect(x.reconcile([seen(ask("ny-1"))], T0, true)).toBe(true);
    expect(x.reconcile([seen(ask("ny-1"))], T0 + 1000, true)).toBe(false);
  });
});

describe("E8: at most one Decision per Escalation", () => {
  it("takes the first answer and refuses the second, which keeps the first", () => {
    const x = new Escalations();
    x.reconcile([seen(ask("ny-1"))], T0, true);
    const first = x.record("ny-1", { kind: "option", key: "ship" }, by, T0 + MIN);
    expect(first.ok).toBe(true);
    const second = x.record("ny-1", { kind: "option", key: "hold" }, by, T0 + 2 * MIN);
    expect(second).toEqual({ ok: false, error: "already_answered" });
    expect(x.get("ny-1")?.decision?.choice).toEqual({ kind: "option", key: "ship", label: "Ship it" });
    expect(x.get("ny-1")?.status).toBe("answered");
  });
  it("an answer seen at the asker's end (another endpoint's tap) blocks an answer here, without becoming ours", () => {
    const x = new Escalations();
    x.reconcile([seen(ask("ny-1"), open, { key: "hold", label: "Hold", at: T0 + MIN })], T0 + MIN, true);
    expect(x.get("ny-1")?.decision?.via).toBe("elsewhere");
    expect(x.check("ny-1", { kind: "option", key: "ship" }, T0 + 2 * MIN)).toEqual({ ok: false, error: "already_answered" });
  });
  it("ignores a tap older than the ask (an answer to an earlier round)", () => {
    const x = new Escalations();
    x.reconcile([seen(ask("ny-1"), open, { key: "hold", label: "Hold", at: T0 - MIN })], T0, true);
    expect(x.get("ny-1")?.status).toBe("open");
  });
  it("asked again after an answer: open again, marked as asked again", () => {
    const x = new Escalations();
    x.reconcile([seen(ask("ny-1"))], T0, true);
    x.record("ny-1", { kind: "option", key: "ship" }, by, T0 + MIN);
    x.reconcile([seen(ask("ny-1", { askedAt: T0 + 5 * MIN, messageId: "m-again" }))], T0 + 5 * MIN, true);
    const e = x.get("ny-1");
    expect(e?.status).toBe("open");
    expect(e?.askedAgain).toBe(true);
    expect(x.check("ny-1", { kind: "option", key: "hold" }, T0 + 6 * MIN).ok).toBe(true);
  });
  it("a restored Decision (hub restart) still counts, unless the ask is newer", () => {
    const x = new Escalations();
    const decision = { choice: { kind: "option" as const, key: "ship", label: "Ship it" }, at: T0 + MIN, via: "here" as const, ...by };
    x.restore([{ id: escalationId("ny-1"), decision }, { id: escalationId("ny-2"), decision }]);
    x.reconcile([seen(ask("ny-1")), seen(ask("ny-2", { askedAt: T0 + 2 * MIN }))], T0 + 3 * MIN, true);
    expect(x.get("ny-1")?.status).toBe("answered");
    expect(x.get("ny-2")?.status).toBe("open");
  });
});

describe("E9: a Decision names one of the ask's own options, or carries words", () => {
  it("refuses a key that isn't on the ask, and takes the label from the ask, not the request", () => {
    const x = new Escalations();
    x.reconcile([seen(ask("ny-1"))], T0, true);
    expect(x.record("ny-1", { kind: "option", key: "deploy" }, by, T0)).toEqual({ ok: false, error: "bad_option" });
    const r = x.record("ny-1", { kind: "option", key: "hold" }, by, T0);
    expect(r.ok && r.value.choice).toEqual({ kind: "option", key: "hold", label: "Hold" });
  });
  it("words need text, and an ask without options can't take an option", () => {
    const x = new Escalations();
    x.reconcile([seen(ask("ny-2", { options: [], answerBy: "words" }))], T0, true);
    expect(x.check("ny-2", { kind: "option", key: "ship" }, T0)).toEqual({ ok: false, error: "not_a_choice" });
    expect(x.check("ny-2", { kind: "words", text: "   " }, T0)).toEqual({ ok: false, error: "empty" });
    expect(x.record("ny-2", { kind: "words", text: "Yes, go" }, by, T0).ok).toBe(true);
    expect(x.get("ny-2")?.decision?.choice).toEqual({ kind: "words" });   // the words go to the asker, not into the record
  });
  it("a worker's menu is answered on its screen, never from here", () => {
    const x = new Escalations();
    x.reconcile([seen(ask("menu-3", { answerBy: "screen", options: [], tracking: "source", asker: { kind: "worker", name: "builder", workerId: "%3" } }))], T0, true);
    expect(x.check("menu-3", { kind: "words", text: "1" }, T0)).toEqual({ ok: false, error: "on_screen" });
  });
});

describe("E10: answerable only while its source keeps it open", () => {
  it("a list item closed by the manager is settled with its resolution and refuses answers", () => {
    const x = new Escalations();
    x.reconcile([seen(ask("ny-1"))], T0, true);
    x.reconcile([seen(ask("ny-1"), { kind: "settled", resolution: "Redirected", at: T0 + MIN })], T0 + MIN, true);
    expect(x.get("ny-1")).toMatchObject({ status: "settled", resolution: "Redirected", settledAt: T0 + MIN });
    expect(x.check("ny-1", { kind: "option", key: "ship" }, T0 + 2 * MIN)).toEqual({ ok: false, error: "settled" });
  });
  it("an unreadable list refuses answers but changes nothing it knew (fails closed)", () => {
    const x = new Escalations();
    x.reconcile([seen(ask("ny-1")), seen(ask("ny-2", { options: [], answerBy: "words" }))], T0, true);
    x.reconcile([seen(ask("ny-1"), { kind: "unreadable" })], T0 + MIN, false);
    expect(x.get("ny-1")?.status).toBe("open");
    expect(x.get("ny-2")?.status).toBe("open");                       // not sighted, but the list couldn't be read
    expect(x.check("ny-1", { kind: "option", key: "ship" }, T0 + MIN)).toEqual({ ok: false, error: "cant_check" });
    x.reconcile([seen(ask("ny-1"))], T0 + 2 * MIN, true);
    expect(x.check("ny-1", { kind: "option", key: "ship" }, T0 + 2 * MIN).ok).toBe(true);
    expect(x.get("ny-2")?.status).toBe("settled");                    // readable, and gone from it
  });
  it("buttons for an id the list doesn't have yet: shown, not answerable, settled after the grace period", () => {
    const x = new Escalations();
    x.reconcile([seen(ask("ny-9"), { kind: "missing" })], T0 + MIN, true);
    expect(x.get("ny-9")?.status).toBe("open");
    expect(x.check("ny-9", { kind: "option", key: "ship" }, T0 + MIN)).toEqual({ ok: false, error: "not_filed_yet" });
    x.reconcile([seen(ask("ny-9"), { kind: "missing" })], T0 + LEDGER_GRACE_MS, true);
    expect(x.get("ny-9")?.status).toBe("settled");
  });
  it("a list item that is reopened on the list is open again", () => {
    const x = new Escalations();
    x.reconcile([seen(ask("ny-1"), { kind: "settled", resolution: null, at: T0 })], T0, true);
    x.reconcile([seen(ask("ny-1"))], T0 + MIN, true);
    expect(x.get("ny-1")?.status).toBe("open");
  });
  it("an id that isn't on the list expires after a day (negative control: open just before)", () => {
    const x = new Escalations();
    x.reconcile([seen(ask("r1"))], T0 + TAP_TTL_MS - 1, true);
    expect(x.check("r1", { kind: "option", key: "ship" }, T0 + TAP_TTL_MS - 1).ok).toBe(true);
    x.reconcile([seen(ask("r1"))], T0 + TAP_TTL_MS, true);
    expect(x.get("r1")?.status).toBe("expired");
    expect(x.check("r1", { kind: "option", key: "ship" }, T0 + TAP_TTL_MS)).toEqual({ ok: false, error: "expired" });
  });
  it("a worker's question disappears when answered, and a new menu on the same pane opens again", () => {
    const x = new Escalations();
    const menu = ask("menu-3", { answerBy: "screen", options: [], tracking: "source" });
    x.reconcile([seen(menu)], T0, true);
    x.reconcile([], T0 + MIN, true);
    expect(x.get("menu-3")?.status).toBe("settled");
    x.reconcile([seen({ ...menu, askedAt: T0 + 2 * MIN })], T0 + 2 * MIN, true);
    expect(x.get("menu-3")?.status).toBe("open");
  });
});

describe("the order the principal reads them in", () => {
  it("blocking first, then the earliest deadline, decisions before time items, then answered, then decided", () => {
    const x = new Escalations();
    x.reconcile([
      seen(ask("ny-1", { askedAt: T0 })),
      seen(ask("ny-2", { blocking: true, askedAt: T0 + 3 * MIN })),
      seen(ask("ny-3", { deadline: T0 + 60 * MIN, askedAt: T0 + 2 * MIN })),
      seen(ask("ny-4", { need: "time", options: [], answerBy: "words", blocking: true })),
      seen(ask("ny-5")),
      seen(ask("ny-6"), { kind: "settled", resolution: null, at: T0 }),
    ], T0 + 4 * MIN, true);
    x.record("ny-5", { kind: "option", key: "ship" }, by, T0 + 4 * MIN);
    expect(x.list().map(e => e.id)).toEqual(["ny-2", "ny-3", "ny-1", "ny-4", "ny-5", "ny-6"]);
  });
});

// E12 (review of PR #7, finding 5): the version an answer was given for.
describe("askVersion and the short form (code review #7)", () => {
  const base = { askedAt: 1, messageId: "m1", title: "Ship it?", context: null, options: [], recommendation: null, ifNoAnswer: null, deadline: null };
  it("a short form of only a link, or only minutes, is part of the version; none keeps the version as it was", () => {
    expect(askVersion({ ...base, link: "https://example.com/a" })).not.toBe(askVersion(base));
    expect(askVersion({ ...base, minutes: 10 })).not.toBe(askVersion(base));
    expect(askVersion({ ...base, shortTitle: null, summary: null, minutes: null, link: null, details: null })).toBe(askVersion(base));
  });
});

describe("askVersion (E12)", () => {
  const base = { askedAt: 1000, messageId: "m1", title: "Ship it?", context: "CI is green.", options: [{ key: "ship", label: "Ship it", detail: null }], recommendation: null, ifNoAnswer: "hold", deadline: null };
  it("is the same for the same ask, and changes when it is restated, reworded or given other options", () => {
    expect(askVersion(base)).toBe(askVersion({ ...base }));
    for (const change of [{ askedAt: 2000, messageId: "m2" }, { context: "CI is red." }, { title: "Ship it now?" }, { options: [{ key: "ship", label: "Ship", detail: null }] }, { ifNoAnswer: "ship" }, { deadline: 5 }]) {
      expect(askVersion({ ...base, ...change })).not.toBe(askVersion(base));
    }
  });
  it("ignores what the principal wasn't shown (the option's detail)", () => {
    expect(askVersion({ ...base, options: [{ key: "ship", label: "Ship it", detail: "more" }] })).toBe(askVersion(base));
  });
});

// B1 V7/V8: an answer in doubt that its node had typed, learnt while another answer to the same ask arrived (E8).
describe("E8: a Decision found typed at the asker after the fact (recordTyped)", () => {
  it("takes it as it was decided, words without their text, once; a second Decision is refused", () => {
    const x = new Escalations();
    x.reconcile([seen(ask("ny-1"))], T0, true);
    expect(x.recordTyped("ny-1", { kind: "words" }, by, T0 + MIN)).toMatchObject({ ok: true, value: { type: "EscalationAnswered", choice: { kind: "words" } } });
    expect(x.get("ny-1")?.status).toBe("answered");
    expect(x.recordTyped("ny-1", { kind: "option", key: "hold", label: "Hold" }, by, T0 + 2 * MIN)).toEqual({ ok: false, error: "already_answered" });
    expect(x.record("ny-1", { kind: "option", key: "hold" }, by, T0 + 2 * MIN)).toEqual({ ok: false, error: "already_answered" });
  });
});

// Round 4.6 of the PR #55 review: an answer found typed for an earlier version of the ask (asked again since, or gone
// from the board) is recorded through the aggregate like every other answered event. It never becomes the Decision of
// the ask as it stands (E11, E12), and an answer for the version the aggregate holds is no earlier one: that is the
// ask's own Decision, taken under E8 by record or recordTyped.
describe("E11: an earlier version's answer, found typed (recordEarlier)", () => {
  it("records it with its provenance and leaves the ask as it stands open", () => {
    const x = new Escalations();
    const v1 = ask("ny-1");
    x.reconcile([seen(v1)], T0, true);
    x.reconcile([seen(ask("ny-1", { askedAt: T0 + MIN, messageId: "m-ny-1-again" }))], T0 + MIN, true);
    expect(x.recordEarlier("ny-1", askIdentity(v1), { kind: "option", key: "ship", label: "Ship it" }, by, T0 + 2 * MIN))
      .toEqual({ type: "EscalationAnswered", escalationId: "ny-1", choice: { kind: "option", key: "ship", label: "Ship it" }, endpointId: "e1", sessionId: "s1", at: T0 + 2 * MIN });
    expect(x.get("ny-1")).toMatchObject({ status: "open", decision: null });
  });
  it("records it for an ask no longer held", () => {
    const x = new Escalations();
    expect(x.recordEarlier("ny-9", "m-ny-9", { kind: "words" }, by, T0)).toMatchObject({ type: "EscalationAnswered", escalationId: "ny-9", choice: { kind: "words" } });
    expect(x.get("ny-9")).toBeUndefined();
  });
  it("refuses an answer for the version it holds: that is the ask's own Decision", () => {
    const x = new Escalations();
    const v1 = ask("ny-1");
    x.reconcile([seen(v1)], T0, true);
    expect(x.recordEarlier("ny-1", askIdentity(v1), { kind: "option", key: "ship", label: "Ship it" }, by, T0 + MIN)).toBeNull();
    expect(x.get("ny-1")).toMatchObject({ status: "open", decision: null });
    expect(askIdentity({ messageId: null, askedAt: T0 })).toBe(`t${T0}`);
  });
});
