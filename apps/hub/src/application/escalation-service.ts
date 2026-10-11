// Application service for the Escalation context (ADR-0006 addendum "Decisions"): gathers what waits for the principal
// from its sources, keeps the Escalations aggregate current, and delivers his Decision to the asker.
// Sources, each through its adapter: the manager's needs-you list (ledger), the manager's button messages and the taps
// seen in its conversation (manager protocol), and workers' open questions and menus (the transcript and screen
// adapters, read through Observation; nothing is decided from them, O4).
import { createHash } from "node:crypto";
import {
  DEFAULT_POLICY, Escalations, answered, askVersion, endpointId, escalationId, mayCommand, refusal, sameDecision, sessionId,
  type AccessPolicy, type AnswerRefusal, type Ask, type Choice, type Decision, type DecidedChoice, type Escalation, type Message, type Sighting,
} from "@morndo/domain";
import { menuEscalationId } from "@morndo/protocol";
import type { LedgerItem, LedgerRead } from "../adapters/ledger.ts";
import { isLedgerId, parseAnswer, parseTap, tapLine, wordsLine, type ButtonOption } from "../adapters/manager-protocol.ts";
import type { ManagerDeliveryRow, SendRow, Store } from "../adapters/store.ts";
import { menuIdentity, menuOnScreen, type SendProblem } from "@morndo/node-ops";
import type { Authenticated } from "./access-service.ts";
import { SendInDoubt, type SendOutcome, type SendRefused } from "./ports.ts";
import { cleanText, keepInDoubt, settleOutcome, type SendResult } from "./steering-service.ts";
import type { ManagerQueue, QueueView } from "./manager-queue.ts";
import { log } from "../adapters/log.ts";

// What the service reads from Observation: who runs where, their conversations and screens.
export type Watch = {
  // `conflict`: the fleet's lane registry has this name in conflict (two windows claim it, Task 14); legacy never says.
  workers(): { id: string; name: string; conflict?: boolean }[];
  history(id: string): Message[];
  openQuestions(id: string): Message[];
  screen(id: string): string | undefined;
};

// `waiting`: while a Decision for the manager waits in the fleet's queue, why (a WaitingReason, or "typed", "held").
// `notice`: a sentence on an open card: its answer through the queue never reached the manager, or reached it late.
export type EscalationView = Escalation & { answerable: AnswerRefusal | null; version: string; waiting?: string; notice?: string };
type ButtonMessage = { message: Message; body: string; options: ButtonOption[] };
export type Board = { items: EscalationView[]; ledger: { configured: boolean; ok: boolean; at: number | null } };
// `duplicate`: a repeat of an answer in doubt that its node had typed after all; `at` is when, on that node's clock.
export type AnswerResult =
  | { ok: true; item: EscalationView | null; duplicate?: true; at?: number }
  | { ok: false; problem: AnswerRefusal | SendProblem | SendRefused | "node_offline" | "lane_conflict" | "step_up" | "in_progress" | "too_long" | "changed" | "uncertain" | "answer_in_doubt" | "not_delivered"; item: EscalationView | null };
// How a row in doubt is settled with its node: SteeringService's settle (a duplicate, uncertain, or null: the node never
// started it, so it is judged anew). Without a fleet nobody else knows: uncertain.
export type SettleInDoubt = (key: string, workerId: string) => Promise<SendResult | null>;

const MAX_WORDS = 4000;
const SCREEN_LINES = 14;
const REQUEST_TTL_MS = 10 * 60_000;
const ECHO_SLACK_MS = 5000;                           // an echo is no older than its answer's queueing, less this (clocks)
const SETTLED_LEDGER_MS = 3 * 24 * 3_600_000;        // closed list items shown under "Decided" for three days
const NOT_DELIVERED = "Not delivered: the answer never reached the manager. Answer again.";
const LATE_ANSWER = "This reached the manager late, as an answer to the earlier version of the question.";

const digest = (words: string) => createHash("sha256").update(words.trim()).digest("hex").slice(0, 16);
// An answer's choice in its queue row (manager_deliveries.choice): its option as decided, or its words' length and digest
// (E9: never the words).
type StoredChoice = { kind: "option"; key: string; label: string; version?: string } | { kind: "words"; length: number; digest: string; version?: string };
// The Decision an answer's row was queued as (A1: who answered, when, with what): what the queue's word on it moves.
function decisionOf(row: ManagerDeliveryRow): Decision {
  const c = JSON.parse(row.choice ?? "{}") as StoredChoice;
  return {
    choice: c.kind === "option" ? { kind: "option", key: c.key, label: c.label } : { kind: "words" }, at: row.queuedAt, via: "here",
    endpointId: endpointId(row.endpointId), sessionId: sessionId(row.sessionId), delivery: { state: "queued", at: null },
  };
}
const wordsOf = (row: ManagerDeliveryRow) => {
  const c = JSON.parse(row.choice ?? "{}") as StoredChoice;
  return c.kind === "words" ? { length: c.length, digest: c.digest } : {};
};
// The key an answer carries to the asker's node (fleet core §3.1): one choice for one ask is one key, so a repeat after a
// dropped connection gets the node's outcome of the first instead of the line typed again. The ask is the message that
// asked it (its time when it has none): the same choice for a question asked again is a new answer, typed again. Words
// go by their digest.
// The manager's pane: the worker named so (the first, as the legacy hub always took it), or none while that name is in
// conflict in the fleet (two windows claim it, on one node or two, Task 14): which one asked can't be told, so its asks
// come from the ledger alone and an answer is refused (lane_conflict), never typed into either.
export function managerOf(workers: readonly { id: string; name: string; conflict?: boolean }[], managerName: string): string | null {
  const named = workers.filter(w => w.name === managerName);
  return named.some(w => w.conflict) ? null : named[0]?.id ?? null;
}
const choicePart = (choice: Choice) => (choice.kind === "option" ? `option:${choice.key}` : `words:${digest(choice.text)}`);
// One ask of one escalation (the message that asked it, or its time): every answer key to it starts so, whatever the choice.
export const askPrefix = (id: string, ask: { messageId: string | null; askedAt: number }) => `answer:${id}:${ask.messageId ?? `t${ask.askedAt}`}:`;
export const answerKey = (id: string, ask: { messageId: string | null; askedAt: number }, choice: Choice) =>
  `${askPrefix(id, ask)}${choicePart(choice)}`;

// The question in one line, for asks that aren't on the list: the message's first real line, without markdown marks.
function headline(body: string): string {
  const line = body.split("\n").map(l => l.replace(/^[#>\-*\s]+|[*_`]+/g, "").trim()).find(l => l.length > 0) ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line || "A decision for you";
}

export class EscalationService {
  #x = new Escalations();
  #watch: Watch;
  #ledger: (() => LedgerRead) | null;
  #store: Store;
  #send: (pane: string, text: string, key: string) => Promise<SendOutcome>;
  #settle: SettleInDoubt;
  #managerName: string;
  #now: () => number;
  #policy: () => AccessPolicy;
  #listeners = new Set<(b: Board) => void>();
  #firstSeen = new Map<string, number>();
  #inFlight = new Set<string>();
  #held: { row: ManagerDeliveryRow; view: QueueView }[] = [];   // queue words that arrived while that answer was being given
  #seen = new Map<string, number>();
  #lastLedger: LedgerRead | null = null;
  #filed = new Map<string, LedgerItem>();              // the last readable list's items: wording while it can't be read
  #buttons = new Map<string, ButtonMessage>();         // each id's last button message: its options once it scrolls out
  #echoed = new Map<string, string>();                 // delivery id → the message taken as its echo, so a later tap is not it
  // A menu on a worker's screen by escalation id: the menu itself (its question and choices, menuIdentity), what its
  // version is made of instead of the screen's last lines, which a redraw or a spinner changes (Stage-4 review, 2).
  #menus = new Map<string, string>();
  #timer: NodeJS.Timeout | null = null;
  // The fleet's delivery queue for the manager (fleet-clients §9.1), null without a fleet; `on` from MORNDO_MANAGER_QUEUE.
  #queue: ManagerQueue | null;
  #cancelling = new Set<string>();                    // deliveries being withdrawn (#withdrawStale), once each

  constructor(p: {
    watch: Watch; ledger: (() => LedgerRead) | null; store: Store; managerName: string;
    // Typing the answer: the port's outcome, with the node's own typedAt (spec 3.1) and the store it went to.
    send: (pane: string, text: string, key: string) => Promise<SendOutcome>; now?: () => number; policy?: () => AccessPolicy;
    // How an answer in doubt is settled with its node (SteeringService.settleInDoubt). Absent: the legacy hub, which has
    // no node to ask, so an answer in doubt there (a throw while typing it) stays uncertain.
    settle?: SettleInDoubt;
    // The manager's queue (spec §9.1). Off or absent: answers to the manager are typed directly; one queued before the
    // switch went off is still followed (and was cancelled at start if it hadn't been typed).
    queue?: ManagerQueue | null;
  }) {
    this.#queue = p.queue ?? null;
    this.#queue?.subscribe(c => this.#onDelivery(c.row, c.view));
    this.#watch = p.watch;
    this.#ledger = p.ledger;
    this.#store = p.store;
    this.#send = p.send;
    this.#settle = p.settle ?? (async () => ({ ok: false, problem: "uncertain" }));
    this.#managerName = p.managerName;
    this.#now = p.now ?? Date.now;
    this.#policy = p.policy ?? (() => DEFAULT_POLICY);
    this.#firstSeen = this.#store.askFirstSeen();
    // A row kept by the manager's inbox (PR #29, removed) may also carry its key and the words' hash: they were the
    // service's, never the Decision's, so they never reach the board (code review B8).
    const saved = this.#store.decisions().map(d => {
      const { inbox: _key, words: _words, ...decision } = d.decision as Decision & { inbox?: string; words?: unknown };
      return { id: d.id, decision: decision as Decision };
    });
    this.#x.restore(saved.map(d => ({ id: escalationId(d.id), decision: d.decision })));
    // A Decision #29's manager inbox left queued has no delivery row here: that inbox may still type it, so it may have
    // been delivered. It stays given and is never asked again (E13, ruling 82), and the hub never types it.
    for (const d of saved) {
      if (d.decision.delivery?.state !== "queued" || this.#store.answerDelivery(d.id, d.decision.at)) continue;
      this.#x.uncertain(d.id, d.decision);
      this.#store.replaceDecisionIf(d.id, d.decision.at, { ...d.decision, delivery: { state: "uncertain", at: null } });
      log.warn(`answer to ${d.id} was queued before the fleet's queue and isn't followed here: it may have been delivered`);
    }
  }

  subscribe(fn: (b: Board) => void) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }

  board(): Board {
    const now = this.#now();
    const l = this.#lastLedger;
    return {
      items: this.#x.list().map(e => ({ ...e, answerable: refusal(e, now), version: this.#version(e), ...this.#waiting(e), ...this.#notice(e) })),
      ledger: { configured: this.#ledger !== null, ok: l?.ok ?? false, at: l?.at ?? null },
    };
  }
  #view(id: string): EscalationView | null {
    const e = this.#x.get(id);
    return e ? { ...e, answerable: refusal(e, this.#now()), version: this.#version(e), ...this.#waiting(e), ...this.#notice(e) } : null;
  }
  // A sentence on an open card (E13), from the latest answer to it through the queue: given up for this ask (never typed,
  // so it reached no one) says Not delivered; delivered after the ask was asked anew, for the earlier one, says so. Read
  // from the rows, so a restart still says it; it goes once he answers again or the ask closes (#29's notices).
  #notice(e: Escalation): { notice?: string } {
    if (!this.#queue || e.status !== "open" || e.asker.kind !== "manager") return {};
    const last = this.#queue.answersTo(e.id).at(-1);
    if (!last) return {};
    const ask = e.messageId ?? `t${e.askedAt}`;
    if (last.state === "given_up" && last.ask === ask) return { notice: NOT_DELIVERED };
    if (last.state === "delivered" && last.ask !== ask && last.updatedAt >= e.askedAt) return { notice: LATE_ANSWER };
    return {};
  }
  // Why a Decision queued for the manager still waits, as the queue says it (fleet-clients §9.1): its reason while queued,
  // "typed" or "held" once typed.
  #waiting(e: Escalation): { waiting?: string } {
    if (!this.#queue || e.decision?.delivery?.state !== "queued") return {};
    const row = this.#queue.answerRow(e.id, e.decision.at);
    const v = row ? this.#queue.view(row.deliveryId) : null;
    const w = v?.state === "queued" ? v.reason : v?.state === "typed" || v?.state === "held" ? v.state : null;
    return w ? { waiting: w } : {};
  }
  // What the principal was shown of an ask, as one string (E12): for a menu on a screen, the menu, not the screen around it.
  #version(e: Escalation): string {
    const menu = e.contextKind === "screen" ? this.#menus.get(e.id) : undefined;
    return askVersion(menu === undefined ? e : { ...e, context: menu });
  }

  start(pollMs: number) {
    const loop = () => {
      try { this.poll(); }
      catch (e) { log.error("decisions poll failed", e); }   // next round tries again
      this.#timer = setTimeout(loop, pollMs);
    };
    loop();
  }
  stop() { if (this.#timer) clearTimeout(this.#timer); }

  poll() {
    const now = this.#now();
    const ledger = this.#ledger ? this.#ledger() : null;
    this.#lastLedger = ledger;
    const sightings = [...this.#managerSightings(ledger, now), ...this.#workerSightings(now)];
    const changed = this.#x.reconcile(sightings, now, ledger?.ok ?? true);
    for (const id of this.#buttons.keys()) if (!this.#x.get(id)) this.#buttons.delete(id);   // kept as long as its ask
    this.#withdrawStale();
    if (changed) this.#notify();
  }

  // A queued answer whose ask closed (settled, expired) or was asked again meanwhile answers a question the principal no
  // longer has (E11, E12; ADR-0010 B1, H2): its delivery is withdrawn, once. One typed already can't be: it is followed
  // to its end, and its record (once delivered) keeps its own Decision.
  #withdrawStale() {
    if (!this.#queue) return;
    for (const row of this.#queue.openAnswers()) {
      const id = row.escalationId;
      if (id === null || row.state !== "queued" || this.#inFlight.has(id) || this.#cancelling.has(row.deliveryId)) continue;
      const e = this.#x.get(id);
      if (!e) continue;                                  // not sighted since a restart: nothing to judge it by yet
      const closed = e.status === "settled" || e.status === "expired";
      const stored = JSON.parse(row.choice ?? "{}") as StoredChoice;
      const restated = stored.version !== undefined && stored.version !== this.#version(e);
      if (!closed && !restated && sameDecision(e.decision, decisionOf(row))) continue;
      this.#cancelling.add(row.deliveryId);
      log.info(`answer to ${id} withdrawn from the manager's queue: the ask ${closed ? "closed" : "changed"} since`);
      void this.#queue.cancel(row.deliveryId).finally(() => this.#cancelling.delete(row.deliveryId));
    }
  }

  // The queue's word on an answer (fleet-clients §9.1, E13). While an answer to this ask is still being given, the word
  // is kept and applied once that answer returns (#queueAnswer), so an older delivery is recorded even when this ask
  // holds that Decision no more.
  #onDelivery(row: ManagerDeliveryRow, view: QueueView) {
    if (row.kind !== "answer" || row.escalationId === null) return;
    if (this.#inFlight.has(row.escalationId)) { this.#held.push({ row, view }); return; }
    this.#applyDelivery(row, view);
    this.#notify();
  }
  // Delivered: recorded (EscalationAnswered at the time it reached the manager, with the row's own provenance, A1), even
  // when the ask holds that Decision no more (asked again since: the manager has the answer all the same). Uncertain: it
  // stays given, never opened again, not recorded. Given up: nothing reached the manager, so the ask is open again. The
  // decisions row follows, only while it is still that Decision.
  #applyDelivery(row: ManagerDeliveryRow, view: QueueView) {
    const id = row.escalationId;
    if (id === null || row.choice === null) return;
    const expected = decisionOf(row);
    // A put that went in doubt took no Decision (the row stayed "sending"). The queue's later word is that answer:
    // typed or held, it counts as given; delivered, it is recorded; uncertain, it stays given. A second choice is not queued.
    if (view.state === "delivered" || view.state === "typed" || view.state === "held" || view.state === "uncertain") this.#takeInDoubt(id, row, expected);
    if (view.state === "delivered") {
      const at = view.at ?? this.#now();
      const event = this.#x.delivered(id, expected, at) ?? answered(escalationId(id), { ...expected, delivery: { state: "delivered", at } });
      this.#store.replaceDecisionIf(id, expected.at, { ...expected, delivery: { state: "delivered", at } });
      this.#store.record([{ ...event, ...wordsOf(row) }]);
      log.info(`answer to ${id} delivered to the manager`);
    } else if (view.state === "uncertain") {
      this.#x.uncertain(id, expected);
      this.#store.replaceDecisionIf(id, expected.at, { ...expected, delivery: { state: "uncertain", at: null } });
      log.warn(`answer to ${id} may have reached the manager (typed, never seen taken): it stays answered and is never typed again`);
    } else if (view.state === "given_up") {
      this.#x.withdraw(id, expected);
      this.#store.dropDecisionIf(id, expected.at);
      log.warn(`answer to ${id} not delivered (${view.why ?? "given up"}): the ask is open again`);
    }
  }
  // The ask is still the one this row was queued for, and it holds no Decision: take this one, at the row's own time.
  #takeInDoubt(id: string, row: ManagerDeliveryRow, expected: Decision) {
    const e = this.#x.get(id);
    if (!e || e.decision || (e.messageId ?? `t${e.askedAt}`) !== row.ask) return;
    const c = JSON.parse(row.choice ?? "{}") as StoredChoice;
    const choice: Choice = c.kind === "option" ? { kind: "option", key: c.key } : { kind: "words", text: "x" };
    const q = this.#x.queue(id, choice, { endpointId: endpointId(row.endpointId), sessionId: sessionId(row.sessionId) }, expected.at);
    if (q.ok) this.#store.saveDecision(id, q.value);
  }
  #notify() { const b = this.board(); for (const l of this.#listeners) l(b); }

  #since(key: string, fallback: number) {
    const t = this.#firstSeen.get(key);
    if (t !== undefined) return t;
    this.#firstSeen.set(key, fallback);
    this.#store.setAskFirstSeen(key, fallback);
    return fallback;
  }

  // The manager's asks: button messages in its conversation joined with its list, by id.
  #managerSightings(ledger: LedgerRead | null, now: number): Sighting[] {
    const managerId = managerOf(this.#watch.workers(), this.#managerName);
    const manager = managerId === null ? null : { id: managerId };
    const messages = manager ? this.#watch.history(manager.id) : [];
    const buttons = new Map<string, ButtonMessage>();
    const taps = new Map<string, { key: string; label: string; at: number }>();
    for (const m of messages) {
      if (m.author.kind !== "agent" || m.kind !== "text") continue;
      const a = parseAnswer(m.text);
      if (a.buttons) buttons.set(a.buttons.id, { message: m, body: a.body, options: a.buttons.options });   // the latest wins
    }
    // ADR-0010 H1 (reconciliation ruling 27): an answer queued for an older ask of the same id, typed before its
    // withdrawal could stop it, answers that ask: its echo is never a tap on the newer one.
    const echoes = this.#echoesOfOlderAsks(messages, buttons);
    for (const m of messages) {
      if (m.author.kind !== "principal" || echoes.has(m.id)) continue;
      const t = parseTap(m.text);
      if (t) taps.set(t.id, { key: t.key, label: t.label, at: m.at });
    }
    const items = new Map<string, LedgerItem>((ledger?.ok ? ledger.items : []).map(i => [i.id, i]));
    if (ledger?.ok) this.#filed = items;
    const ids = new Set<string>(buttons.keys());
    for (const i of items.values()) {
      if (i.open || (i.closedAt !== null && now - i.closedAt < SETTLED_LEDGER_MS)) ids.add(i.id);
    }
    // A list item that is no longer on a readable list is no ask any more: its first-seen time goes (an open one is in `ids`).
    if (ledger?.ok) {
      for (const key of [...this.#firstSeen.keys()]) {
        if (key.startsWith("ledger:") && !ids.has(key.slice("ledger:".length))) { this.#firstSeen.delete(key); this.#store.dropAskFirstSeen(key); }
      }
    }
    const out: Sighting[] = [];
    for (const [id, b] of buttons) this.#buttons.set(id, b);
    for (const id of ids) {
      // Out of the history window, or one empty read: the message it was asked in still gives its options and time (E10).
      const b = buttons.get(id) ?? this.#buttons.get(id);
      const l = items.get(id);
      const words = l ?? this.#filed.get(id);           // how it reads; whether it's open comes from this read only
      const onList = isLedgerId(id);
      const askedAt = b?.message.at ?? words?.addedAt ?? this.#since(`ledger:${id}`, now);
      const ask: Ask = {
        id: escalationId(id),
        asker: { kind: "manager", name: "Manager", workerId: manager?.id ?? null },
        // The list's kind decides decision or task; a button message alone asks a decision (2026-10-04).
        need: words?.need ?? "decision",
        title: words?.title ?? headline(b?.body ?? ""),
        shortTitle: words?.shortTitle ?? null,
        summary: words?.summary ?? null,
        minutes: words?.minutes ?? null,
        link: words?.link ?? null,
        details: words?.details ?? null,
        context: b?.body.trim() ? b.body : null,
        contextKind: "markdown",
        // The button message's options when there is one (ADR-0006: "the message supplies the options"; they are what
        // every endpoint taps), else the list's own: the recommended first either way.
        options: (b?.options ?? (words?.options.length ? words.options : [])).map(o => ({ key: o.key, label: o.label, detail: null })),
        answerBy: words?.options.length || b ? "tap" : "words",
        recommendation: words?.recommendation ?? null,
        ifNoAnswer: words?.ifNoAnswer ?? null,
        deadline: words?.deadline ?? null,
        blocking: words?.blocking ?? false,
        project: words?.project ?? null,
        askedAt,
        messageId: b?.message.id ?? null,
        tracking: onList ? "ledger" : "age",
      };
      const source: Sighting["source"] = !onList ? { kind: "open" }
        : !ledger || !ledger.ok ? { kind: "unreadable" }
        : !l ? { kind: "missing" }
        : l.open ? { kind: "open" } : { kind: "settled", resolution: l.resolution, at: l.closedAt };
      out.push({ ask, source, answered: taps.get(id) ?? null });
    }
    return out;
  }

  // The echoes of answers queued for an ask asked again since (their row's ask isn't the id's newest button message),
  // unless given up: each takes one, the first of its own tap line from its queueing on (ADR-0010 H1: another tap with
  // the same line is a new answer). An answer in words is no tap, so it has no echo to take.
  #echoesOfOlderAsks(messages: readonly Message[], buttons: ReadonlyMap<string, ButtonMessage>): Set<string> {
    const out = new Set<string>();
    if (!this.#queue) return out;
    for (const [id, b] of buttons) {
      for (const row of this.#queue.answersTo(id)) {
        if (row.ask === b.message.id || row.state === "given_up" || row.choice === null) continue;
        const taken = this.#echoed.get(row.deliveryId);
        if (taken !== undefined) { if (messages.some(m => m.id === taken)) out.add(taken); continue; }
        const c = JSON.parse(row.choice) as StoredChoice;
        if (c.kind !== "option") continue;
        const line = tapLine(id, { key: c.key, label: c.label });
        const echo = messages.find(m => m.author.kind === "principal" && !out.has(m.id) && m.at >= row.queuedAt - ECHO_SLACK_MS && m.text.trim() === line);
        if (echo) { out.add(echo.id); this.#echoed.set(row.deliveryId, echo.id); }
      }
    }
    return out;
  }

  // Workers that wait for the principal: an open question (answered on its screen), or a menu on its screen.
  #workerSightings(now: number): Sighting[] {
    const out: Sighting[] = [];
    for (const w of this.#watch.workers()) {
      const isManager = w.name === this.#managerName;
      const asker = { kind: isManager ? "manager" as const : "worker" as const, name: isManager ? "Manager" : w.name, workerId: w.id };
      const questions = this.#watch.openQuestions(w.id);
      const read = this.#watch.screen(w.id);              // undefined: never read, offline or failed; no news about its menu
      const screen = read ?? "";
      const base = { asker, need: "decision" as const, answerBy: "screen" as const, recommendation: null, ifNoAnswer: null,
        deadline: null, blocking: false, project: null, tracking: "source" as const,
        shortTitle: null, summary: null, minutes: null, link: null, details: null };
      for (const q of questions) {
        const parts = q.questions ?? [];
        const first = parts[0];
        out.push({
          ask: {
            ...base, id: escalationId(`q-${q.questionId ?? q.id}`), title: first?.question ?? q.text,
            context: parts.length > 1 ? parts.slice(1).map(p => `- ${p.question}`).join("\n") : null, contextKind: "markdown",
            options: (first?.options ?? []).map((o, i) => ({ key: String(i + 1), label: o.label, detail: o.description })),
            askedAt: q.at, messageId: q.id,
          },
          source: { kind: "open" }, answered: null,
        });
      }
      const menuKey = `menu:${w.id}`;
      if (!questions.length && menuOnScreen(screen)) {
        const lines = screen.split("\n").map(l => l.trimEnd());
        while (lines.length && !lines.at(-1)) lines.pop();
        const id = menuEscalationId(w.id);                     // "menu-pc_3fa2c1d0_12"; a legacy "%4" stays "menu-4" (spec §4)
        this.#menus.set(id, menuIdentity(screen) ?? "");
        out.push({
          ask: {
            ...base, id: escalationId(id), title: "Waiting at a prompt on its screen",
            context: lines.slice(-SCREEN_LINES).join("\n"), contextKind: "screen", options: [],
            askedAt: this.#since(menuKey, now), messageId: null,
          },
          source: { kind: "open" }, answered: null,
        });
      } else if (read !== undefined) {                      // only a screen that was read can say the menu is gone
        if (this.#firstSeen.delete(menuKey)) this.#store.dropAskFirstSeen(menuKey);      // the menu is gone: a menu shown again is a new ask
        this.#menus.delete(menuEscalationId(w.id));
      }
    }
    return out;
  }

  // The principal's Decision (E8–E11), a Command under the access policy (AC7). Delivered to the asker first, recorded
  // only once it arrived there; the words themselves are never stored, only their length and a hash. `seen`: the
  // version of the ask he answered (askVersion); restated since, the answer is refused as "changed" (E12).
  // An answer keeps a row as a send does (S5): "started" before it is typed, with the worker and the request, its store
  // and store sequence once its node answers, "done" once typed. A refusal that says nothing reached the pane removes
  // it. An answer whose node may have typed it (SendInDoubt), or whose typing threw (the legacy port's, maybe after the
  // paste: ADR-0008, phase C), is "uncertain" (the hub's 409) and keeps its row. So does one the hub
  // stopped while typing: its row has no store. A repeat of either, by the same request or by the same answer key (a
  // new tap of the same choice for the same ask), is settled with that node before anything else, as a send's is
  // (fleet core §3.1; final review C1 and its follow-up): typed there → a duplicate, recorded now; never started there
  // (unknown from that same store, not behind) → judged anew and typed; anything else, a row with no store included →
  // still uncertain, nothing typed. Without that, an agent database lost between the two would know no key, and the
  // answer would be typed twice.
  async answer(a: Authenticated, id: string, choice: Choice, requestId: string, seen?: string): Promise<AnswerResult> {
    if (!mayCommand(a.session, this.#now(), this.#policy())) return { ok: false, problem: "step_up", item: this.#view(id) };
    if (choice.kind === "words" && choice.text.length > MAX_WORDS) return { ok: false, problem: "too_long", item: this.#view(id) };
    if (choice.kind === "words" && !cleanText(choice.text)) return { ok: false, problem: "empty", item: this.#view(id) };
    const now = this.#now();
    for (const [k, t] of this.#seen) if (now - t > REQUEST_TTL_MS) this.#seen.delete(k);
    const key = `${a.session.id}:${requestId}`;
    // A repeat of an answer the queue gave up, never typed: it reached no one, and its ask is open again (E13). Answering
    // again is a new request (#29's not_delivered; ruling 82).
    const givenUp = this.#queue?.byRequest(a.endpoint.id, requestId) ?? null;
    if (givenUp?.kind === "answer" && givenUp.escalationId === id && givenUp.state === "given_up") return { ok: false, problem: "not_delivered", item: this.#view(id) };
    if (this.#seen.has(key)) return { ok: true, item: this.#view(id) };
    if (this.#inFlight.has(id)) return { ok: false, problem: "in_progress", item: this.#view(id) };
    this.#inFlight.add(id);
    try {
      // A repeat of this request's answer in doubt first: whatever became of the ask since, it must learn what became of
      // that answer (its row names the answer: this escalation, this choice).
      const request = `${a.endpoint.id}:${requestId}`;
      const earlier = this.#store.sendOfRequest(request);
      if (earlier && earlier.key.startsWith(`answer:${id}:`) && earlier.key.endsWith(`:${choicePart(choice)}`)) {
        const settled = await this.#settleAnswer(a, id, choice, earlier, key);
        if (settled) return settled;
      }
      this.poll();                                       // the list may have closed it a moment ago
      // A repeat of this request's answer through the manager's queue (spec §9.1): it reached the manager, may have, or
      // is queued as this ask's Decision: so it is, whatever the switch says now. Anything else (in doubt, given up, or
      // queued while its Decision was never taken: the fleet's event came, its answer didn't) is judged again below.
      const queued = this.#queue?.byRequest(a.endpoint.id, requestId) ?? null;
      if (queued?.kind === "answer" && queued.escalationId === id) {
        const held = sameDecision(this.#x.get(id)?.decision, decisionOf(queued));
        if (queued.state === "delivered" || queued.state === "uncertain" || (held && queued.state !== "sending" && queued.state !== "given_up")) {
          this.#seen.set(key, this.#now());
          return { ok: true, item: this.#view(id) };
        }
        // Still in doubt while the switch is off: it may be queued, so it is never typed by hand (ruling 49).
        if (queued.state === "sending" && this.#queue && !this.#queue.on) return { ok: false, problem: "uncertain", item: this.#view(id) };
      }
      const c = this.#x.check(id, choice, this.#now());
      if (!c.ok) return { ok: false, problem: c.error, item: this.#view(id) };
      const e = c.value;
      if (seen !== undefined && seen !== this.#version(e)) return { ok: false, problem: "changed", item: this.#view(id) };
      if (this.#queue?.on && e.asker.kind === "manager") return await this.#queueAnswer(a, e, choice, requestId, key);
      if (!e.asker.workerId) {
        const conflict = e.asker.kind === "manager" && this.#watch.workers().some(w => w.name === this.#managerName && w.conflict);
        return { ok: false, problem: conflict ? "lane_conflict" : "no_pane", item: this.#view(id) };
      }
      const k = answerKey(e.id, e, choice);
      // ... or of the same answer from another request.
      const inDoubt = this.#store.send(k);
      if (inDoubt) {
        const settled = await this.#settleAnswer(a, id, choice, inDoubt, key);
        if (settled) return settled;
      }
      // Then another answer to this ask, with another choice (E8: one Decision per ask; ADR-0012 7).
      const other = await this.#otherAnswer(a, id, askPrefix(e.id, e), k);
      if (other) return other;
      // ... and one queued for the manager before the switch went off, still in doubt: it may be queued (E8, ruling 49).
      if (this.#queue?.sendingOf(`hub:${askPrefix(e.id, e)}`).length) {
        log.warn(`answer to ${id} refused: an answer to it through the manager's queue is in doubt; nothing is typed directly`);
        return { ok: false, problem: "answer_in_doubt", item: this.#view(id) };
      }
      const option = choice.kind === "option" ? e.options.find(o => o.key === choice.key) : undefined;
      const line = option ? tapLine(e.id, option) : wordsLine(e.id, choice.kind === "words" ? choice.text : "");
      // Written before the first await, as a send's is: a hub that stops while this is typed leaves it "started".
      if (!this.#store.startAnswer(k, now, { workerId: e.asker.workerId, request })) return { ok: false, problem: "uncertain", item: this.#view(id) };
      let outcome: SendOutcome;
      // A node that may have typed it (SendInDoubt): "uncertain", the hub's 409, never a 500 the app reads as a refusal
      // (final review I1), and kept for its repeat with the store it went to. Any other throw keeps its row too (below).
      try { outcome = await this.#send(e.asker.workerId, line, k); }
      catch (err) {
        // Any other throw (the legacy port's tmux command list, which can fail after the paste) may have typed it too:
        // its row stays, with no store, so a repeat is uncertain and it is never typed twice (ADR-0008, phase C).
        if (!(err instanceof SendInDoubt)) {
          log.warn(`answer to ${e.id} in doubt: typing it threw, maybe after the paste; a repeat stays uncertain`, err);
          return { ok: false, problem: "uncertain", item: this.#view(id) };
        }
        keepInDoubt(this.#store, k, err);
        log.warn(`answer to ${e.id} in doubt: its node may have typed it; a repeat asks the node`, err);
        return { ok: false, problem: "uncertain", item: this.#view(id) };
      }
      settleOutcome(this.#store, k, outcome);                           // a retry may type it; "not_submitted" keeps its row
      if (outcome.problem) {
        log.warn(`answer to ${e.id} not delivered: ${outcome.problem}`);
        return { ok: false, problem: outcome.problem, item: this.#view(id) };
      }
      return this.#delivered(a, id, choice, key);
    } finally {
      this.#inFlight.delete(id);
      const held = this.#held.filter(c => c.row.escalationId === id);
      if (held.length > 0) this.#held = this.#held.filter(c => c.row.escalationId !== id);
      for (const c of held) this.#applyDelivery(c.row, c.view);
      if (held.length > 0) this.#notify();
    }
  }

  // The manager's answer through the fleet's queue (spec §9.1, E13): queued, it counts as given (E8) and the card says
  // so, with why it waits; the queue's later word moves it on (#onDelivery). Its id is its key (`hub:<key>`), so the
  // switch never types it twice. A manager mid-restart is no refusal: its sticky name waits on its node (spec §4.6).
  async #queueAnswer(a: Authenticated, e: Escalation, choice: Choice, requestId: string, key: string): Promise<AnswerResult> {
    const queue = this.#queue as ManagerQueue;
    const id = e.id as string;
    const k = answerKey(e.id, e, choice);
    // An answer typed directly before the queue was on, still in doubt, is settled with its node first, as below.
    const inDoubt = this.#store.send(k);
    if (inDoubt) {
      const settled = await this.#settleAnswer(a, id, choice, inDoubt, key);
      if (settled) return settled;
    }
    const other = await this.#otherAnswer(a, id, askPrefix(e.id, e), k);
    if (other) return other;
    // Another answer to this ask whose delivery is in doubt (the fleet took it and never answered) may be queued (E8).
    const deliveryId = queue.idFor(k);
    if (queue.sendingOf(`hub:${askPrefix(e.id, e)}`).some(r => r.deliveryId !== deliveryId)) {
      log.warn(`answer to ${id} refused: another answer to it may be queued for the manager (its delivery is in doubt)`);
      return { ok: false, problem: "answer_in_doubt", item: this.#view(id) };
    }
    const option = choice.kind === "option" ? e.options.find(o => o.key === choice.key) : undefined;
    const line = option ? tapLine(e.id, option) : wordsLine(e.id, choice.kind === "words" ? choice.text : "");
    const version = this.#version(e);
    const stored: StoredChoice = option ? { kind: "option", key: option.key, label: option.label, version }
      : { kind: "words", length: choice.kind === "words" ? choice.text.trim().length : 0, digest: digest(choice.kind === "words" ? choice.text : ""), version };
    const r = await queue.put({
      deliveryId, kind: "answer", escalationId: id, ask: e.messageId ?? `t${e.askedAt}`, choice: JSON.stringify(stored),
      endpointId: a.endpoint.id, sessionId: a.session.id, requestId, queuedAt: this.#now(),
    }, line);
    if (!r.ok) {
      log.warn(`answer to ${id} not queued for the manager: ${r.problem}`);
      return { ok: false, problem: r.problem === "timeout" ? "busy" : r.problem, item: this.#view(id) };
    }
    const nowAsk = this.#x.get(id);
    if (!nowAsk || nowAsk.messageId !== e.messageId || this.#version(nowAsk) !== version) {
      log.warn(`answer to ${id} was queued for an ask that was restated meanwhile; its delivery is withdrawn`);
      void queue.cancel(r.row.deliveryId);
      return { ok: false, problem: "changed", item: this.#view(id) };
    }
    // The Decision as its row has it: a repeat in doubt keeps its first attempt's time and provenance.
    const expected = decisionOf(r.row);
    const q = this.#x.queue(id, choice, { endpointId: endpointId(r.row.endpointId), sessionId: sessionId(r.row.sessionId) }, expected.at);
    if (!q.ok) {                       // closed or asked again while it was queued: the next poll withdraws it
      log.warn(`answer to ${id} queued, but its ask no longer takes it (${q.error}); its delivery is withdrawn`);
      return { ok: false, problem: q.error, item: this.#view(id) };
    }
    this.#store.saveDecision(id, q.value);
    this.#seen.set(key, this.#now());
    log.info(`answer to ${id} queued for the manager`);
    this.#applyDelivery(r.row, queue.view(deliveryId) ?? r.view);   // the latest word: a repeat may find it delivered already
    this.#notify();
    return { ok: true, item: this.#view(id) };
  }

  // An answer in doubt, settled with the node it went to (SteeringService's settle, on its row): typed there → delivered,
  // a duplicate at the node's time; null → the node never started it (its row is gone), so the answer is judged anew;
  // anything else → uncertain. A row already done was settled before: delivered.
  async #settleAnswer(a: Authenticated, id: string, choice: Choice, row: SendRow, key: string): Promise<AnswerResult | null> {
    if (row.state === "done") {
      this.#seen.set(key, this.#now());
      return { ok: true, item: this.#view(id), duplicate: true, at: row.typedAt ?? row.at };
    }
    const settled = row.workerId === null ? { ok: false as const, problem: "uncertain" as const } : await this.#settle(row.key, row.workerId);
    if (settled === null) return null;
    if (!settled.ok && settled.problem === "duplicate") return this.#delivered(a, id, choice, key, settled.at);
    log.warn(`answer to ${id} in doubt: its node can't say it never typed it; it stays uncertain`);
    return { ok: false, problem: "uncertain", item: this.#view(id) };
  }

  // Another answer to the same ask (another choice, another request) that its node may have typed (E8 while an answer is
  // in doubt; fleet core §3.1). It is settled with that node first, as a repeat of it would be: never started there →
  // its row is gone and this answer is judged as usual (null); typed there, now or before → it was his answer, recorded
  // now, and this one is refused as a second answer; anything else → this one is refused as in doubt. Nothing is typed
  // in either refusal.
  async #otherAnswer(a: Authenticated, id: string, prefix: string, k: string): Promise<AnswerResult | null> {
    for (const other of this.#store.answersOfAsk(prefix)) {
      if (other.key === k) continue;
      const settled = other.state === "done" ? { ok: false as const, problem: "duplicate" as const, at: other.typedAt ?? other.at }
        : other.workerId === null ? { ok: false as const, problem: "uncertain" as const }
        : await this.#settle(other.key, other.workerId);
      if (settled === null) continue;
      if (!settled.ok && settled.problem === "duplicate") {
        this.#typedEarlier(a, id, other.key.slice(prefix.length));
        return { ok: false, problem: "already_answered", item: this.#view(id) };
      }
      log.warn(`answer to ${id} refused: another answer to it is in doubt (its node can't say it never typed it)`);
      return { ok: false, problem: "answer_in_doubt", item: this.#view(id) };
    }
    return null;
  }

  // An answer found typed at the asker (an answer in doubt that its node had typed): his Decision (E8), once, as it was
  // decided: its option, labelled from the ask, or words, whose digest its key carries (their length isn't kept).
  #typedEarlier(a: Authenticated, id: string, part: string) {
    const e = this.#x.get(id);
    if (!e || e.status !== "open") return;
    const option = part.startsWith("option:") ? part.slice("option:".length) : null;
    const decided: DecidedChoice = option === null ? { kind: "words" } : { kind: "option", key: option, label: e.options.find(o => o.key === option)?.label ?? option };
    const r = this.#x.recordTyped(id, decided, { endpointId: a.endpoint.id, sessionId: a.session.id }, this.#now());
    if (!r.ok) { log.warn(`answer to ${id} found typed but not recorded: ${r.error}`); return; }
    const decision = this.#x.get(id)?.decision;
    if (decision) this.#store.saveDecision(id, decision);
    this.#store.record([{ ...r.value, ...(option === null ? { digest: part.slice("words:".length) } : {}) }]);
    this.#notify();
  }

  // The answer arrived: recorded as his Decision (E8), once. `at`: a duplicate's time on the node that typed it.
  #delivered(a: Authenticated, id: string, choice: Choice, key: string, at?: number): AnswerResult {
    this.#seen.set(key, this.#now());
    const r = this.#x.record(id, choice, { endpointId: a.endpoint.id, sessionId: a.session.id }, this.#now());
    if (r.ok) {
      const decision = this.#x.get(id)?.decision;
      if (decision) this.#store.saveDecision(id, decision);
      const words = choice.kind === "words" ? { length: choice.text.trim().length, digest: digest(choice.text) } : {};
      this.#store.record([{ ...r.value, ...words }]);
    } else {
      log.warn(`answer to ${id} delivered but not recorded: ${r.error}`);
    }
    this.#notify();
    return { ok: true, item: this.#view(id), ...(at === undefined ? {} : { duplicate: true as const, at }) };
  }
}
