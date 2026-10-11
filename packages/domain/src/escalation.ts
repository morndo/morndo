// Escalation context on the web endpoint (docs/domain.md "Escalation", ADR-0006 addendum "Decisions"): what waits for
// the principal's call, and his Decision on it. The sources (the manager's needs-you list and its button messages,
// worker questions and menus) reach this only through adapters, as Sightings. The rules here decide what is still
// answerable, and accept at most one Decision per ask (E8–E12).

import { err, ok, type EndpointId, type Result, type SessionId } from "./shared.ts";

export type EscalationId = string & { readonly __brand: "EscalationId" };
export const escalationId = (s: string) => s as EscalationId;

export type AskOption = { key: string; label: string; detail: string | null };
export type Asker = { kind: "manager" | "worker"; name: string; workerId: string | null };

// How the principal answers: a tap on one of the options, words to the asker, or on the asker's own screen (a worker's
// menu: the hub never presses keys in it).
export type AnswerBy = "tap" | "words" | "screen";

// How long an ask stays answerable: while the manager's list has it open ("ledger"), for a day after it was asked
// ("age", button messages whose id isn't on the list), or while its source still shows it ("source", a worker's
// question or menu).
export type Tracking = "ledger" | "age" | "source";

export type Ask = {
  id: EscalationId;
  asker: Asker;
  need: "decision" | "time";            // time: it needs the principal's time or hands, not a choice
  title: string;
  // The asker's own short form, when it gives one (the manager's list, from 2026-10-04): a few words, one sentence,
  // the minutes it takes, an http(s) address and the long details. The app falls back to the title without them.
  shortTitle: string | null;
  summary: string | null;
  minutes: number | null;
  link: string | null;
  details: string | null;
  context: string | null;               // the message that asked it (untrusted text), or a screen excerpt
  contextKind: "markdown" | "screen";
  options: AskOption[];                 // the asker's recommended option first (the manager's protocol)
  answerBy: AnswerBy;
  recommendation: string | null;
  ifNoAnswer: string | null;            // what happens if the principal never answers
  deadline: number | null;
  blocking: boolean;
  project: string | null;
  askedAt: number;
  messageId: string | null;             // the conversation message that carries it
  tracking: Tracking;
};

export type SourceState =
  | { kind: "open" }
  | { kind: "settled"; resolution: string | null; at: number | null }
  | { kind: "missing" }                 // the list doesn't have it (yet)
  | { kind: "unreadable" };             // the list can't be read now

export type SeenAnswer = { key: string; label: string; at: number };

// What an adapter saw of one ask in this round. `answered` is an answer seen at the asker's end (a tap from another
// endpoint, such as the chat bot), shown so nobody answers twice; it is never taken as this endpoint's Decision.
export type Sighting = { ask: Ask; source: SourceState; answered: SeenAnswer | null };

export type Choice = { kind: "option"; key: string } | { kind: "words"; text: string };
export type DecidedChoice = { kind: "option"; key: string; label: string } | { kind: "words" };

// A Decision for the manager goes through the fleet's delivery queue (E13; fleet-clients §9.1, ADR-0014): "queued" until
// the queue reports it in the manager's conversation, then "delivered"; "uncertain" once it was typed and never seen
// taken. Absent: it reached the asker when it was taken (typed directly, or seen at the asker's end).
export type Delivery = { state: "queued" | "delivered" | "uncertain"; at: number | null };

export type Decision = {
  choice: DecidedChoice;
  at: number;
  via: "here" | "elsewhere";
  endpointId: EndpointId | null;
  sessionId: SessionId | null;
  delivery?: Delivery | undefined;
};

export type EscalationStatus = "open" | "answered" | "settled" | "expired";

export type Escalation = Ask & {
  status: EscalationStatus;
  source: SourceState["kind"];
  decision: Decision | null;
  resolution: string | null;            // how the asker settled it, in its words
  settledAt: number | null;
  askedAgain: boolean;                  // asked again after an earlier answer
};

export type AnswerRefusal =
  | "unknown" | "already_answered" | "settled" | "expired" | "not_filed_yet" | "cant_check"
  | "on_screen" | "not_a_choice" | "bad_option" | "empty";

export type EscalationAnswered = {
  type: "EscalationAnswered"; escalationId: EscalationId; choice: DecidedChoice;
  endpointId: EndpointId; sessionId: SessionId; at: number;
};

export const LEDGER_GRACE_MS = 10 * 60_000;          // E10: the manager may post buttons before it files the item
export const TAP_TTL_MS = 24 * 3_600_000;            // E10: an id that isn't on the list expires after a day
export const KEEP_SETTLED_MS = 3 * 24 * 3_600_000;   // how long decided items stay listed once no source shows them

const isOpen = (s: EscalationStatus) => s === "open" || s === "answered";

// What the principal was shown of an Ask, as one short string: when and in which message it was asked, its wording,
// options and terms. An answer that waited (the phone's 5-second window) carries it, and is refused if the Ask was
// restated meanwhile (E12; review of PR #7, finding 5). FNV-1a over the fields: pure, with no hashing library.
// The short form counts as shown when it is given (2026-10-04); without it the version is as before.
export function askVersion(a: Pick<Ask, "askedAt" | "messageId" | "title" | "context" | "options" | "recommendation" | "ifNoAnswer" | "deadline"> & Partial<Pick<Ask, "shortTitle" | "summary" | "minutes" | "link" | "details">>): string {
  const form = [a.shortTitle ?? null, a.summary ?? null, a.minutes ?? null, a.link ?? null, a.details ?? null];
  const short = form.some(x => x !== null && x !== "") ? form : [];
  const s = JSON.stringify([a.askedAt, a.messageId, a.title, a.context, a.options.map(o => [o.key, o.label]), a.recommendation, a.ifNoAnswer, a.deadline, ...short]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `v${h.toString(16).padStart(8, "0")}${s.length.toString(16)}`;
}

// Why a Decision can't be taken now, or null if it can (E8, E10, E11). The choice itself is checked in `check`.
export function refusal(e: Escalation | undefined, now: number): AnswerRefusal | null {
  if (!e) return "unknown";
  if (e.status === "answered") return "already_answered";
  if (e.status === "settled") return "settled";
  if (e.status === "expired") return "expired";
  if (e.source === "unreadable") return "cant_check";
  if (e.tracking === "ledger" && e.source === "missing") return "not_filed_yet";
  if (e.tracking === "age" && now - e.askedAt >= TAP_TTL_MS) return "expired";
  if (e.answerBy === "screen") return "on_screen";
  return null;
}

// The order the principal reads them in, like the manager's board: open decisions (blocking first, then overdue and the
// earliest deadline, then the oldest), then time items the same way, then answered ones and decided ones, newest first.
function rank(e: Escalation): number {
  if (e.status === "open") return e.need === "decision" ? 0 : 1;
  return e.status === "answered" ? 2 : 3;
}
export function compareEscalations(a: Escalation, b: Escalation): number {
  const r = rank(a) - rank(b);
  if (r) return r;
  if (rank(a) <= 1) {
    return Number(b.blocking) - Number(a.blocking)
      || (a.deadline ?? Infinity) - (b.deadline ?? Infinity)
      || a.askedAt - b.askedAt;
  }
  const last = (e: Escalation) => e.settledAt ?? e.decision?.at ?? e.askedAt;
  return last(b) - last(a);
}

export class Escalations {
  #items = new Map<EscalationId, Escalation>();
  #restored = new Map<EscalationId, Decision>();

  // Decisions this endpoint took before a restart. Applied when their ask is sighted and wasn't asked again since.
  restore(decisions: { id: EscalationId; decision: Decision }[]) {
    for (const d of decisions) this.#restored.set(d.id, d.decision);
  }

  get(id: string): Escalation | undefined { return this.#items.get(id as EscalationId); }
  list(): Escalation[] { return [...this.#items.values()].sort(compareEscalations); }

  // One round of sightings from all sources. `ledgerReadable` false means ledger-tracked asks that weren't sighted are
  // kept as they were (an unreadable list proves nothing). Returns whether anything visible changed.
  reconcile(sightings: Sighting[], now: number, ledgerReadable: boolean): boolean {
    const before = JSON.stringify(this.list());
    const seen = new Set<EscalationId>();
    for (const s of sightings) {
      if (seen.has(s.ask.id)) continue;                  // E1: one Escalation per id; the adapter sends the newest first
      seen.add(s.ask.id);
      this.#sight(s, now);
    }
    for (const e of this.#items.values()) {
      if (seen.has(e.id)) continue;
      if (e.tracking === "ledger" && !ledgerReadable) { if (isOpen(e.status)) e.source = "unreadable"; continue; }
      if (e.tracking === "age" && isOpen(e.status)) {     // E10: its day runs whether its message is in view or not
        if (e.status === "open" && now - e.askedAt >= TAP_TTL_MS) { e.status = "expired"; e.settledAt = e.askedAt + TAP_TTL_MS; }
        else if (e.status === "answered" && now - e.askedAt > TAP_TTL_MS + KEEP_SETTLED_MS) this.#items.delete(e.id);
        continue;
      }
      if (isOpen(e.status)) { e.status = "settled"; e.source = "missing"; e.settledAt = now; }
      else if (now - (e.settledAt ?? e.askedAt) > KEEP_SETTLED_MS) this.#items.delete(e.id);
    }
    return JSON.stringify(this.list()) !== before;
  }

  #sight(s: Sighting, now: number) {
    const known = this.#items.get(s.ask.id);
    let e: Escalation;
    if (!known) {
      e = { ...s.ask, status: "open", source: s.source.kind, decision: null, resolution: null, settledAt: null, askedAgain: false };
      // A sighting without a message (a list item without buttons) has no time of its own, only when the hub first saw
      // it: it is never a newer ask, so a Decision restored after a restart still answers it (E8, E11).
      const restored = this.#restored.get(s.ask.id);
      if (restored && (s.ask.messageId === null || restored.at >= s.ask.askedAt)) e.decision = restored;
      this.#items.set(e.id, e);
    } else {
      e = known;
      const newer = s.ask.messageId !== null && s.ask.askedAt > e.askedAt;
      // E1: asked again (a newer message for the same id) is the same Escalation with the newest wording and options.
      // An answer given before the new ask doesn't answer it (the asker asked again on purpose).
      const reopened = newer && (e.decision !== null || e.status === "settled" || e.status === "expired") && s.source.kind !== "settled";
      Object.assign(e, s.ask);
      if (reopened) {
        e.askedAgain = e.decision !== null;
        e.decision = null; e.status = "open"; e.resolution = null; e.settledAt = null;
      }
    }
    e.source = s.source.kind;

    if (!e.decision && s.answered && s.answered.at >= e.askedAt) {
      e.decision = { choice: { kind: "option", key: s.answered.key, label: s.answered.label }, at: s.answered.at, via: "elsewhere", endpointId: null, sessionId: null };
    }

    if (s.source.kind === "settled") {
      if (e.status !== "settled") { e.status = "settled"; e.settledAt = s.source.at ?? now; }
      e.resolution = s.source.resolution;
      return;
    }
    if (s.source.kind === "unreadable") return;          // keep the status we had
    if (s.source.kind === "missing" && e.tracking !== "ledger") { e.status = "settled"; e.settledAt ??= now; return; }
    if (s.source.kind === "missing" && now - e.askedAt >= LEDGER_GRACE_MS) {
      if (e.status !== "settled") { e.status = "settled"; e.settledAt = now; }
      return;                                            // E10: not on the list after the grace period: decided there
    }
    if (e.tracking === "age" && now - e.askedAt >= TAP_TTL_MS && !e.decision) {
      if (e.status !== "expired") { e.status = "expired"; e.settledAt = e.askedAt + TAP_TTL_MS; }
      return;
    }
    if (e.status === "settled" || e.status === "expired") {
      if (e.tracking === "age") return;                  // a day-old ask comes back only when asked again
      e.settledAt = null; e.resolution = null;           // reopened on the list, or a worker shows a menu again
    }
    e.status = e.decision ? "answered" : "open";
  }

  // E8–E11: whether this choice would be accepted now.
  check(id: string, choice: Choice, now: number): Result<Escalation, AnswerRefusal> {
    const e = this.#items.get(id as EscalationId);
    const r = refusal(e, now);
    if (r || !e) return err(r ?? "unknown");
    if (choice.kind === "option") {
      if (e.answerBy !== "tap") return err("not_a_choice");
      if (!e.options.some(o => o.key === choice.key)) return err("bad_option");
    } else if (!choice.text.trim()) {
      return err("empty");
    }
    return ok(e);
  }

  // Takes the principal's Decision once it reached the asker. The option's label comes from the ask, never the request.
  record(id: string, choice: Choice, by: { endpointId: EndpointId; sessionId: SessionId }, now: number): Result<EscalationAnswered, AnswerRefusal> {
    const c = this.#take(id, choice, by, now);
    if (!c.ok) return c;
    const e = c.value;
    return ok(answered(e.id, e.decision!));
  }

  // E13: the Decision handed to the manager's queue. It counts as given at once (E8: a second answer is refused and shows
  // it), but is recorded, as EscalationAnswered, only once the queue reports it at the asker (`delivered`).
  queue(id: string, choice: Choice, by: { endpointId: EndpointId; sessionId: SessionId }, now: number): Result<Decision, AnswerRefusal> {
    const c = this.#take(id, choice, by, now, { state: "queued", at: null });
    return c.ok ? ok(c.value.decision!) : c;
  }

  // The queue has it in the manager's conversation: the queued Decision is delivered, and recorded from now on. Null
  // when this ask holds no longer that queued Decision (asked again, answered otherwise meanwhile: the caller records the
  // one it queued, and leaves the newer one alone; code review B3).
  delivered(id: string, expected: Decision, at: number): EscalationAnswered | null {
    const e = this.#items.get(id as EscalationId);
    if (!e) {                                          // restored after a restart, not sighted yet (code review B5)
      const r = this.#restored.get(id as EscalationId);
      if (!r || r.delivery?.state !== "queued" || !sameDecision(r, expected)) return null;
      r.delivery = { state: "delivered", at };
      return answered(id as EscalationId, r);
    }
    const d = e.decision;
    if (!d || d.delivery?.state !== "queued" || !sameDecision(d, expected)) return null;
    d.delivery = { state: "delivered", at };
    return answered(e.id, d);
  }

  // Typed and never seen taken: the queued Decision stays given, is never asked again, and is not recorded (it may not
  // have reached the manager; E13). Only that Decision, restored after a restart included (code review B3, B5).
  uncertain(id: string, expected: Decision): boolean {
    const e = this.#items.get(id as EscalationId);
    const d = e ? e.decision : this.#restored.get(id as EscalationId) ?? null;
    if (!d || d.delivery?.state !== "queued" || !sameDecision(d, expected)) return false;
    d.delivery = { state: "uncertain", at: null };
    return true;
  }

  // The queue gave the queued Decision up, never typed (it expired, was cancelled, or its lane went): the ask is open
  // again. Only that Decision: a newer one given meanwhile stays (code review B3).
  withdraw(id: string, expected: Decision): boolean {
    const e = this.#items.get(id as EscalationId);
    if (!e) {                                          // restored after a restart, not sighted yet (code review B5)
      const r = this.#restored.get(id as EscalationId);
      if (!r || r.delivery?.state !== "queued" || !sameDecision(r, expected)) return false;
      this.#restored.delete(id as EscalationId);
      return true;
    }
    if (e.decision?.delivery?.state !== "queued" || !sameDecision(e.decision, expected)) return false;
    e.decision = null;
    if (e.status === "answered") e.status = "open";
    // The same Decision was kept to reapply after a restart (E8). Withdrawing it here and leaving that copy would
    // answer the ask again once this item is dropped and sighted with no message of its own (review #9).
    this.#restored.delete(id as EscalationId);
    return true;
  }

  #take(id: string, choice: Choice, by: { endpointId: EndpointId; sessionId: SessionId }, now: number, delivery?: Delivery): Result<Escalation, AnswerRefusal> {
    const c = this.check(id, choice, now);
    if (!c.ok) return c;
    const e = c.value;
    const decided: DecidedChoice = choice.kind === "option"
      ? { kind: "option", key: choice.key, label: e.options.find(o => o.key === choice.key)?.label ?? choice.key }
      : { kind: "words" };
    e.decision = { choice: decided, at: now, via: "here", endpointId: by.endpointId, sessionId: by.sessionId, ...(delivery ? { delivery } : {}) };
    e.status = "answered";
    e.askedAgain = false;
    return ok(e);
  }

  // Takes a Decision found typed at the asker after the fact: an answer in doubt that its node had typed (fleet core
  // §3.1), learnt while another answer to the same ask arrived (E8). It was judged when it was given, so only E8, E10
  // and E11 are checked now (refusal); its choice is as it was decided, words without their text (E9).
  recordTyped(id: string, decided: DecidedChoice, by: { endpointId: EndpointId; sessionId: SessionId }, now: number): Result<EscalationAnswered, AnswerRefusal> {
    const e = this.#items.get(id as EscalationId);
    const r = refusal(e, now);
    if (r || !e) return err(r ?? "unknown");
    e.decision = { choice: decided, at: now, via: "here", endpointId: by.endpointId, sessionId: by.sessionId };
    e.status = "answered";
    e.askedAgain = false;
    return ok({ type: "EscalationAnswered", escalationId: e.id, choice: decided, endpointId: by.endpointId, sessionId: by.sessionId, at: now });
  }
}

// The same Decision: taken at the same moment by the same endpoint and session, the same choice.
export function sameDecision(a: Decision | null | undefined, b: Decision): boolean {
  return !!a && a.at === b.at && a.endpointId === b.endpointId && a.sessionId === b.sessionId && JSON.stringify(a.choice) === JSON.stringify(b.choice);
}

// The record of a Decision taken here (its provenance, A1); `at` is when it reached the asker.
export function answered(id: EscalationId, d: Decision): EscalationAnswered {
  return { type: "EscalationAnswered", escalationId: id, choice: d.choice, endpointId: d.endpointId as EndpointId, sessionId: d.sessionId as SessionId, at: d.delivery?.at ?? d.at };
}
