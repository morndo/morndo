// The words for the manager's delivery queue (fleet-clients Task 13; plan.md Wording): exactly "Queued, it will be
// delivered", "Delivered", "May have been delivered", and why it waits in plain words, one for each reason the queue
// gives, never its code. The same words for a message (the outbox) and an answer (the decision cards, the phone's Today).
import { describe, expect, it } from "vitest";
import type { DecisionItem } from "../src/lib/desktop/decisions.ts";
import { deliveryLine } from "../src/lib/desktop/decisions.ts";
import { horizon } from "../src/lib/phone/horizon.ts";
import type { OutboxRecord } from "../src/lib/outbox/state.ts";
import { deliveryNote, sendLabel } from "../src/lib/outbox/words.ts";
import { DELIVERED, GIVEN_UP, MAY_HAVE_BEEN, QUEUED, WAITING, queuedLine } from "../src/lib/queue-words.ts";

const T0 = new Date(2026, 9, 8, 9, 0).getTime();
const REASONS = ["menu_open", "draft_present", "no_input_box", "busy", "no_pane", "no_session", "earlier", "unavailable", "typed", "held"];
const rec = (o: Partial<OutboxRecord> = {}): OutboxRecord => ({
  id: "r1", worker: "pc.aaaaaaaa.0", workerName: "manager", text: "status please", uploads: [], createdAt: T0, budgetFrom: T0, state: "sent",
  error: null, attempts: 1, seen: "none", sentAt: T0, typedAt: T0, ...o,
});
const item = (o: Partial<DecisionItem> = {}): DecisionItem => ({
  id: "ny-7", asker: { kind: "manager", name: "Manager", workerId: "pc.aaaaaaaa.0" }, need: "decision", title: "Ship it?", shortTitle: null,
  summary: null, minutes: null, link: null, details: null, context: null, contextKind: "markdown", options: [], answerBy: "tap",
  recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null, askedAt: T0 - 60_000, messageId: null,
  tracking: "ledger", status: "answered", source: "open", resolution: null, settledAt: null, askedAgain: false, answerable: "already_answered", version: "v1",
  decision: { choice: { kind: "option", key: "ship", label: "Ship it" }, at: T0, via: "here", endpointId: null, sessionId: null, delivery: { state: "queued", at: null } },
  ...o,
} as DecisionItem);

describe("the queue's words", () => {
  it("are exactly the plan's", () => {
    expect([QUEUED, DELIVERED, MAY_HAVE_BEEN]).toEqual(["Queued, it will be delivered", "Delivered", "May have been delivered"]);
    expect(queuedLine("unavailable")).toBe("Queued, it will be delivered: the machine didn't answer, trying again.");   // ruling 15
  });
  it("say why it waits for every reason the queue gives, in words, never the code", () => {
    for (const r of REASONS) {
      expect(WAITING[r], r).toMatch(/^[a-z][^_]*[a-z]$/);                   // a clause, never a code such as menu_open
      expect(queuedLine(r)).toBe(`Queued, it will be delivered: ${WAITING[r]}.`);
    }
    for (const why of ["expired", "cancelled", "gone", "refused"]) expect(GIVEN_UP[why], why).toMatch(/^[a-z][^_]*[a-z]$/);
  });
  it("a reason it doesn't know adds nothing it can't vouch for (negative control)", () => {
    expect(queuedLine("teleporting")).toBe("Queued, it will be delivered.");
    expect(queuedLine(null)).toBe("Queued, it will be delivered.");
  });
});

describe("a message to the manager in the outbox", () => {
  it("reads as its delivery says, with why it waits or why it never went", () => {
    expect(sendLabel(rec({ delivery: { state: "queued", waiting: "menu_open", why: null } }), [], T0)).toBe("Queued, it will be delivered");
    expect(deliveryNote(rec({ delivery: { state: "queued", waiting: "menu_open", why: null } }))).toBe(queuedLine("menu_open"));
    expect(sendLabel(rec({ delivery: { state: "delivered", waiting: null, why: null } }), [], T0)).toBe("Delivered");
    expect(deliveryNote(rec({ delivery: { state: "delivered", waiting: null, why: null } }))).toBe("");
    expect(sendLabel(rec({ delivery: { state: "uncertain", waiting: null, why: null } }), [], T0)).toBe("May have been delivered");
    expect(deliveryNote(rec({ delivery: { state: "uncertain", waiting: null, why: null } }))).toMatch(/^It was typed, but never seen/);
    expect(sendLabel(rec({ delivery: { state: "given_up", waiting: null, why: "expired" } }), [], T0)).toBe("Not delivered");
    expect(deliveryNote(rec({ delivery: { state: "given_up", waiting: null, why: "expired" } }))).toBe(`Nothing reached the manager: ${GIVEN_UP.expired}. Write it again if it's still needed.`);
  });
  it("queued a day long, it still says it will be delivered, never 'not seen yet'", () => {
    expect(sendLabel(rec({ delivery: { state: "queued", waiting: null, why: null } }), [], T0 + 23 * 3_600_000)).toBe("Queued, it will be delivered");
  });
  it("one typed directly reads as before (negative control)", () => {
    expect(sendLabel(rec(), [], T0)).toBe("Sent");
    expect(deliveryNote(rec())).toBe("");
  });
});

describe("an answer to the manager", () => {
  it("the card's line: queued with why, delivered with when, or may have been delivered", () => {
    expect(deliveryLine(item({ waiting: "draft_present" }))).toEqual({ state: "queued", why: WAITING.draft_present });
    expect(deliveryLine(item())).toEqual({ state: "queued", why: null });
    expect(deliveryLine(item({ decision: { ...item().decision!, delivery: { state: "delivered", at: T0 + 5000 } } }))).toEqual({ state: "delivered", at: T0 + 5000 });
    expect(deliveryLine(item({ decision: { ...item().decision!, delivery: { state: "uncertain", at: null } } }))).toEqual({ state: "uncertain" });
    expect(deliveryLine(item({ decision: { ...item().decision!, delivery: undefined } }))).toBeNull();
  });
  it("the phone's Today says it is queued, or may have been delivered, in the row", () => {
    const row = (d: DecisionItem) => horizon({ decisions: [d], workers: [], later: new Set(), now: T0 + 60_000 }).whenReady.find(r => r.key === "d:ny-7")?.detail;
    expect(row(item())).toBe("You said “Ship it” at 09:00. Queued, it will be delivered.");
    expect(row(item({ decision: { ...item().decision!, delivery: { state: "uncertain", at: null } } }))).toBe("You said “Ship it” at 09:00. May have been delivered.");
    expect(row(item({ decision: { ...item().decision!, delivery: { state: "delivered", at: T0 + 5000 } } }))).toBe("You said “Ship it” at 09:00. The manager takes it from here.");
  });
});
