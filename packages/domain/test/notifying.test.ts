// Notifications (ADR-0008 phase F; N1–N3 in docs/domain.md): numbers only, raised only by a Decision starting to wait,
// a worker starting to need him (not when muted) or a device linked; per kind the latest wins after a second; never
// while he is attending on any device. Pure.
import { describe, expect, it } from "vitest";
import {
  ATTENDING_INPUT_MS, DECISION_REPEAT_MS, NOTIFICATION_KINDS, NOTIFY_DEBOUNCE_MS, NotificationQueue, PUSH_TOPICS, anyAttending, isAttending, isPushTopic, kindCode, payloadOf, raises, reasonCode, repeatsDecision,
  suppressedWhileAttending,
} from "../src/index.ts";

const NOW = 1_000_000;
const counts = { decisions: 2, workers: 1, linked: 0, alerts: 0, usage: 0 };

describe("a Notification's Topic (N6: one a push service takes)", () => {
  it("is at most 32 URL-safe Base64 characters, of a length that decodes", () => {
    for (const ok of ["alerts", "usages", "decision", "worker", "linked", "ab", "abc", "abcd", "A-_9", "x".repeat(32)]) expect(isPushTopic(ok), ok).toBe(true);
    // Apple's push service refused these two with 400 BadWebPushTopic (2026-10-12, 2026-10-25): 5 characters, 1 mod 4.
    for (const no of ["alert", "usage", "a", "abcde", "x".repeat(33), "x".repeat(29), "", "bad topic", "a.b", "a/b", "a+b", "a=b", "äbc"]) expect(isPushTopic(no), no).toBe(false);
  });
  it("every kind has one, and each one passes, so a new kind can't ship a topic Apple refuses", () => {
    expect(Object.keys(PUSH_TOPICS).sort()).toEqual([...NOTIFICATION_KINDS].sort());
    for (const k of NOTIFICATION_KINDS) expect(isPushTopic(PUSH_TOPICS[k]), `${k}: ${PUSH_TOPICS[k]}`).toBe(true);
    expect(new Set(Object.values(PUSH_TOPICS)).size).toBe(NOTIFICATION_KINDS.length);   // a newer one replaces only its own kind
  });
});

describe("a push service's reason for a refusal (N1: codes, never text)", () => {
  it("keeps a short code of letters and digits, and nothing else", () => {
    for (const ok of ["BadJwtToken", "BadTtl", "A", `A${"b".repeat(63)}`]) expect(reasonCode(ok), ok).toBe(ok);
    for (const no of ["", "42", "Bad Jwt", "bad-jwt", "Bad\nJwt", "<b>no</b>", `A${"b".repeat(64)}`, 7, null, undefined, { code: "X" }]) expect(reasonCode(no), JSON.stringify(no)).toBeUndefined();
  });
});

describe("the payload (N1)", () => {
  it("is numbers only: the kind as its number, then the counts", () => {
    const p = payloadOf("worker", counts);
    expect(p).toEqual({ kind: 1, decisions: 2, workers: 1, linked: 0, alerts: 0, usage: 0 });
    expect(Object.values(p).every(v => typeof v === "number")).toBe(true);
    expect([kindCode("decision"), kindCode("worker"), kindCode("linked"), kindCode("alert"), kindCode("usage")]).toEqual([0, 1, 2, 3, 4]);
  });
  it("a usage notice (S4, plan 4.4): appended, so the older kind codes stay what they were; the count rides along", () => {
    expect(payloadOf("usage", { ...counts, usage: 3 })).toEqual({ kind: 4, decisions: 2, workers: 1, linked: 0, alerts: 0, usage: 3 });
  });
});

describe("what raises one (N2)", () => {
  it("an urgent fleet alert, and only an urgent one", () => {
    expect(raises({ kind: "alert", urgent: true })).toBe(true);
    expect(raises({ kind: "alert", urgent: false })).toBe(false);
  });
  it("a Decision starting to wait, even in a muted conversation's world: mute isn't asked", () => {
    expect(raises({ kind: "decision", waiting: 1 })).toBe(true);
    expect(raises({ kind: "decision", waiting: 0 })).toBe(false);
  });
  it("a worker only when it starts needing him, and not when its conversation is muted", () => {
    expect(raises({ kind: "worker", needsYou: true, was: false, muted: false, isAsk: false })).toBe(true);
    expect(raises({ kind: "worker", needsYou: true, was: true, muted: false, isAsk: false })).toBe(false);   // still needing
    expect(raises({ kind: "worker", needsYou: false, was: true, muted: false, isAsk: false })).toBe(false);  // answered
    expect(raises({ kind: "worker", needsYou: true, was: false, muted: true, isAsk: false })).toBe(false);   // muted
  });
  it("a worker's question or menu is an Ask: it raises as a Decision on the board, never a second time as a worker (review M1)", () => {
    expect(raises({ kind: "worker", needsYou: true, was: false, muted: false, isAsk: true })).toBe(false);
  });
  it("a device linked (AC13)", () => {
    expect(raises({ kind: "linked" })).toBe(true);
  });
  it("a usage notice the hub wrote (S4): always", () => {
    expect(raises({ kind: "usage" })).toBe(true);
  });
});

describe("attending (N3, the product lane's amendment 3)", () => {
  it("focus and his input within 2 minutes; a report that aged out isn't", () => {
    expect(isAttending({ attending: true, at: NOW - ATTENDING_INPUT_MS + 1 }, NOW)).toBe(true);
    expect(isAttending({ attending: true, at: NOW - ATTENDING_INPUT_MS }, NOW)).toBe(false);
    expect(isAttending({ attending: false, at: NOW }, NOW)).toBe(false);
    expect(anyAttending([{ attending: false, at: NOW }, { attending: true, at: NOW - 1000 }], NOW)).toBe(true);
    expect(anyAttending([], NOW)).toBe(false);
  });
  it("a usage notification is suppressed while he is attending, like a Decision (S4); a linked one never is", () => {
    expect(suppressedWhileAttending("usage")).toBe(true);
    expect(suppressedWhileAttending("decision")).toBe(true);
    expect(suppressedWhileAttending("linked")).toBe(false);
  });
});

describe("the queue (N3)", () => {
  it("per kind the latest wins, and goes a second after it was raised", () => {
    const q = new NotificationQueue();
    q.raise("decision", { ...counts, decisions: 1 }, NOW);
    q.raise("decision", { ...counts, decisions: 2 }, NOW + 500);          // replaces, and the second starts again
    q.raise("worker", counts, NOW + 100);
    expect(q.next).toBe(NOW + 100 + NOTIFY_DEBOUNCE_MS);
    expect(q.due(NOW + NOTIFY_DEBOUNCE_MS)).toEqual([]);
    expect(q.due(NOW + 100 + NOTIFY_DEBOUNCE_MS).map(p => p.kind)).toEqual(["worker"]);
    const d = q.due(NOW + 500 + NOTIFY_DEBOUNCE_MS);
    expect(d).toEqual([{ kind: "decision", counts: { ...counts, decisions: 2 }, dueAt: NOW + 500 + NOTIFY_DEBOUNCE_MS }]);
    expect(q.next).toBeNull();
    expect(q.due(NOW + 10_000)).toEqual([]);
  });
});

describe("a repeat Decision Notification (N7)", () => {
  it("a card not pushed for before goes at once", () => expect(repeatsDecision(undefined, 2, NOW)).toBe(false));
  it("the same card with the same number waiting repeats within the hour, and not from the hour on", () => {
    const last = { at: NOW, decisions: 2 };
    expect(repeatsDecision(last, 2, NOW + 2 * 60_000)).toBe(true);
    expect(repeatsDecision(last, 2, NOW + DECISION_REPEAT_MS - 1)).toBe(true);
    expect(repeatsDecision(last, 2, NOW + DECISION_REPEAT_MS)).toBe(false);
  });
  it("a different number waiting goes at once", () => expect(repeatsDecision({ at: NOW, decisions: 2 }, 1, NOW + 1000)).toBe(false));
});
