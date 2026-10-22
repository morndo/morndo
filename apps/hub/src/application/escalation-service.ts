// Application service for the Escalation context (ADR-0006 addendum "Decisions"): gathers what waits for the principal
// from its sources, keeps the Escalations aggregate current, and delivers his Decision to the asker.
// Sources, each through its adapter: the manager's needs-you list (ledger), the manager's button messages and the taps
// seen in its conversation (manager protocol), and workers' open questions and menus (the transcript and screen
// adapters, read through Observation; nothing is decided from them, O4).
import { createHash } from "node:crypto";
import {
  DEFAULT_POLICY, Escalations, WORKER_ASK_GRACE_MS, answered, askFromBrief, askIdentity, askVersion, decidedChoice, endpointId, escalationId, mayCommand, refusal, sameDecision, sessionId, viaFor,
  type AccessPolicy, type AnswerRefusal, type Ask, type Choice, type Decision, type DecisionBrief, type EndpointId, type Escalation, type Message, type Note, type SessionId, type Sighting,
} from "@morndo/domain";
import type { BriefSighting } from "./brief-service.ts";
import { memoryAsk } from "./memory-asks.ts";
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
// `brief`, `briefVersion`, `draftedBy`: the brief the ask was filed from (ADR-0023), its version, and who drafted a
// forwarded one; null, 0 and null for a plain ask.
export type EscalationView = Escalation & {
  answerable: AnswerRefusal | null; version: string; waiting?: string; notice?: string;
  brief: DecisionBrief | null; briefVersion: number; draftedBy: string | null;
};
type ButtonMessage = { message: Message; body: string; options: ButtonOption[] };
// A tap line read in the manager's pane.
type PaneTap = { key: string; label: string; at: number };
export type Board = { items: EscalationView[]; ledger: { configured: boolean; ok: boolean; at: number | null } };
// `duplicate`: a repeat of an answer in doubt that its node had typed after all; `at` is when, on that node's clock.
export type AnswerResult =
  | { ok: true; item: EscalationView | null; duplicate?: true; at?: number }
  | { ok: false; problem: AnswerRefusal | SendProblem | SendRefused | "node_offline" | "lane_conflict" | "step_up" | "in_progress" | "too_long" | "changed" | "uncertain" | "answer_in_doubt" | "not_delivered"; item: EscalationView | null };
// How a row in doubt is settled with its node: SteeringService's settle (a duplicate, uncertain, or null: the node never
// started it, so it is judged anew). Without a fleet nobody else knows: uncertain.
export type SettleInDoubt = (key: string, workerId: string) => Promise<SendResult | null>;

// What the escalation service needs of Memory (ADR-0031 round 2): the pending Notes whose Asks it files, and the
// app's answer to one. A getter, because the hub builds Memory after Decisions; absent, nothing changes.
export type MemoryAsks = {
  pending(): readonly Note[];
  decide(a: Authenticated, id: string, decision: "approve" | "reject"): { ok: true } | { ok: false; problem: "step_up" | "not_found" | "changed" };
};

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
// What the record keeps of an answer in words beside its Decision (E9): their length and a hash, never the text.
const wordsKept = (choice: Choice): { length?: number; digest?: string } =>
  (choice.kind === "words" ? { length: choice.text.trim().length, digest: digest(choice.text) } : {});
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
// One ask of one escalation (the message that asked it, or its time: askIdentity): every answer key to it starts so,
// whatever the choice.
export const askPrefix = (id: string, ask: { messageId: string | null; askedAt: number }) => `answer:${id}:${askIdentity(ask)}:`;
export const answerKey = (id: string, ask: { messageId: string | null; askedAt: number }, choice: Choice) =>
  `${askPrefix(id, ask)}${choicePart(choice)}`;
// Whether an answer key holds this choice for this escalation, in whichever version of its ask it was given.
const holdsChoice = (key: string, id: string, choice: Choice) => key.startsWith(`answer:${id}:`) && key.endsWith(`:${choicePart(choice)}`);
// The asking such a key was given for (askIdentity): what it holds between the escalation and the choice.
const askingOf = (key: string, id: string, choice: Choice) => key.slice(`answer:${id}:`.length, key.length - `:${choicePart(choice)}`.length);

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
  // The answers in flight, one per escalation id (a second is refused, in_progress): the answer key being typed now (a
  // started row with no store yet), or null while it is judged, settled or queued (round 4.10 of the PR #55 review).
  #inFlight = new Map<string, string | null>();
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
  // Briefs filed through the hub (ADR-0023). Read at the start of each poll; the service does not store them.
  #briefs: (() => BriefSighting[]) | null;
  #briefOf = new Map<string, BriefSighting>();
  #paneTaps = new Map<string, PaneTap>();
  // Memory's pending Notes, when the hub has Memory (ADR-0031): their Asks ride the board like any hub-held ask.
  #memory: (() => MemoryAsks | null) | null;

  constructor(p: {
    watch: Watch; ledger: (() => LedgerRead) | null; store: Store; managerName: string;
    briefs?: () => BriefSighting[];
    // Typing the answer: the port's outcome, with the node's own typedAt (spec 3.1) and the store it went to.
    send: (pane: string, text: string, key: string) => Promise<SendOutcome>; now?: () => number; policy?: () => AccessPolicy;
    // How an answer in doubt is settled with its node (SteeringService.settleInDoubt). Absent: the legacy hub, which has
    // no node to ask, so an answer in doubt there (a throw while typing it) stays uncertain.
    settle?: SettleInDoubt;
    // The manager's queue (spec §9.1). Off or absent: answers to the manager are typed directly; one queued before the
    // switch went off is still followed (and was cancelled at start if it hadn't been typed).
    queue?: ManagerQueue | null;
    // Memory's asks (ADR-0031 round 2): a pending Note files an Ask the principal answers in the app. Absent: a hub
    // without Memory files none.
    memory?: () => MemoryAsks | null;
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
    this.#briefs = p.briefs ?? null;
    this.#memory = p.memory ?? null;
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

  // The board as kept, with each Decision's own provenance via: what the hub records and stores, for callers that
  // count and log rather than show one client (notifications, the brief service). What a client is shown goes through
  // seenBy.
  board(): Board {
    const now = this.#now();
    const l = this.#lastLedger;
    return {
      items: this.#x.list().map(e => ({ ...e, answerable: refusal(e, now), version: this.#version(e), ...this.#waiting(e), ...this.#notice(e), ...this.#briefView(e.id) })),
      ledger: { configured: this.#ledger !== null, ok: l?.ok ?? false, at: l?.at ?? null },
    };
  }
  // What one endpoint is shown of an item: its Decision's via says where it stands for that endpoint (viaFor), "here"
  // only for the endpoint whose request accepted it, "elsewhere" for anyone else's, absent when the record can no
  // longer say whose it was. The stored record and its provenance are untouched; only the copy for this viewer says
  // it. What the feed and GET /api/escalations send goes through here.
  #forViewer(item: EscalationView, viewer: EndpointId): EscalationView {
    return item.decision ? { ...item, decision: { ...item.decision, via: viaFor(item.decision, viewer) } } : item;
  }
  // The board as one endpoint sees it.
  seenBy(viewer: EndpointId, b: Board = this.board()): Board {
    return { ...b, items: b.items.map(i => this.#forViewer(i, viewer)) };
  }
  #view(id: string, viewer: EndpointId): EscalationView | null {
    const e = this.#x.get(id);
    if (!e) return null;
    return this.#forViewer({ ...e, answerable: refusal(e, this.#now()), version: this.#version(e), ...this.#waiting(e), ...this.#notice(e), ...this.#briefView(e.id) }, viewer);
  }
  #briefView(id: string): { brief: DecisionBrief | null; briefVersion: number; draftedBy: string | null } {
    const b = this.#briefOf.get(id);
    return { brief: b?.brief ?? null, briefVersion: b?.version ?? 0, draftedBy: b?.draftedBy ?? null };
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
    const base = menu === undefined ? e : { ...e, context: menu };
    // A brief's version joins the hash (DB9, E12), so a restate counts even when the markdown reads the same.
    const brief = this.#briefOf.get(e.id);
    return askVersion(brief ? { ...base, briefVersion: brief.version } : base);
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
    this.#briefOf = new Map((this.#briefs?.() ?? []).map(b => [b.id, b]));
    const sightings = [...this.#managerSightings(ledger, now), ...this.#workerSightings(now), ...this.#hubSightings(), ...this.#memorySightings()];
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
    const taps = new Map<string, PaneTap>();
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
    // The taps as read; whether one is this hub's own answer's paste, each ask's sighting judges for its own version
    // (#ownTapOf). The pane keeps every tap line for as long as the history window holds it, across ask versions.
    this.#paneTaps = taps;
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
    // A brief that names a list item is that item (E10): one Escalation, the list still decides whether it is open.
    for (const b of this.#briefOf.values()) if (b.ref !== null) ids.add(b.id);
    // "mem-" is Memory's own (ADR-0031 round 2): a button message or a list item that carries such an id must not borrow
    // a note's Ask, or a tap on its text would approve the note it names. Such an id is no manager ask at all.
    for (const id of [...ids]) if (id.startsWith("mem-")) ids.delete(id);
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
      let source: Sighting["source"] = !onList ? { kind: "open" }
        : !ledger || !ledger.ok ? { kind: "unreadable" }
        : !l ? { kind: "missing" }
        : l.open ? { kind: "open" } : { kind: "settled", resolution: l.resolution, at: l.closedAt };
      const filed = this.#briefOf.get(id);
      let shown = ask;
      if (filed?.ref) {
        // The brief's options, short form and version time. tracking stays the list's (E10). The version's own time
        // and a message id make a restate a new ask (DB9): an earlier Decision no longer answers it (E11).
        const from = askFromBrief(id, filed.brief, ask.asker, filed.version, filed.at);
        shown = {
          ...ask, need: "decision", title: from.title, shortTitle: from.shortTitle, summary: from.summary,
          minutes: from.minutes, details: from.details, options: from.options, answerBy: "tap",
          recommendation: from.recommendation, ifNoAnswer: from.ifNoAnswer, deadline: from.deadline,
          blocking: from.blocking, project: from.project, askedAt: filed.at, messageId: `brief-v${filed.version}`,
        };
        if (filed.closed) source = { kind: "settled", resolution: filed.closed.resolution, at: filed.closed.at };
      }
      out.push({ ask: shown, source, answered: this.#ownTapOf(shown, taps.get(id) ?? null) });
    }
    return out;
  }

  // A tap in the manager's pane that the hub itself typed for one of its own answers is that answer arriving in the
  // pane, not an answer from elsewhere. Reported as a sighting it would settle the ask as "elsewhere" naming no
  // endpoint, and the answer's own recording, which names the endpoint that accepted it, would be refused as a second
  // answer (E8). So it is no sighting: the answer path records it (review of PR #55). The row that says so is this
  // ask's own answer key — the key carries the ask's version (the message that asked it), so an earlier version's row
  // is another answer to an ask asked again — and one still waiting to be recorded: being typed here, done, or in
  // doubt with a store to ask a node about. One row nothing can ever record — "started", no store, not being typed
  // (the hub stopped while typing it, or the port threw after the paste and no node can be asked) — would leave that
  // tap as the ask's only record: it settles the ask, as it did before the filter (rounds 2.1 and 2.2, PR #55 review).
  // No tap the hub read before it wrote the row is that row's paste, and none needs telling apart: the hub writes no
  // answer row after it read a tap that answers the ask (#settleEarlier), so a row's paste and a hand tap read only
  // after the row are the two left, and those the hub can't tell apart (docs/domain.md, E8's known limit). Nothing
  // here is kept in memory, so a restart judges every tap as before it (round 4.1). An ask is judged by its latest tap
  // alone, so one read of the row under that tap's key, by the primary key, is all it takes (round 4.7), and an ask
  // without a tap reads nothing. Being typed is that answer's own key, never the whole ask: a tap of another choice is
  // no paste of this one, and still refuses it (E8, round 3.1).
  #ownTapOf(ask: Ask, tap: PaneTap | null): Sighting["answered"] {
    if (tap === null) return null;
    const k = answerKey(ask.id, ask, { kind: "option", key: tap.key });
    const row = this.#store.send(k);
    if (row !== null && (row.state === "done" || row.store !== null || this.#inFlight.get(ask.id) === k)) return null;
    return { key: tap.key, label: tap.label, at: tap.at };
  }

  // Briefs the hub holds open itself (E14). A `ref` is sighted with its list item, above, not here.
  #hubSightings(): Sighting[] {
    const out: Sighting[] = [];
    for (const b of this.#briefOf.values()) {
      if (b.ref !== null) continue;
      const ask = askFromBrief(b.id, b.brief, b.asker, b.version, b.at);
      const { briefVersion: _version, ...shown } = ask;
      out.push({
        ask: shown,
        source: b.closed ? { kind: "settled", resolution: b.closed.resolution, at: b.closed.at } : { kind: "open" },
        answered: this.#ownTapOf(ask, this.#paneTaps.get(b.id) ?? null),
      });
    }
    return out;
  }

  // The Asks of Memory's pending Notes (ADR-0031 round 2): the hub holds each open (E14) until the note stops waiting
  // or the principal answers in the app. No `answered`: only this hub's own answer path records one.
  #memorySightings(): Sighting[] {
    return (this.#memory?.()?.pending() ?? []).map(note => ({ ask: memoryAsk(note), source: { kind: "open" } as const, answered: null }));
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

  // Workers that wait for the principal: an open question (answered on its screen), or a menu on its screen. A worker's
  // ask waits WORKER_ASK_GRACE_MS first (N2): the manager answers most of them, so it reaches the principal only once
  // it has been open that long, and until then it is on no board and raises no Notification. The manager's own asks are immediate.
  #workerSightings(now: number): Sighting[] {
    const out: Sighting[] = [];
    for (const w of this.#watch.workers()) {
      const isManager = w.name === this.#managerName;
      const asker = { kind: isManager ? "manager" as const : "worker" as const, name: isManager ? "Manager" : w.name, workerId: w.id };
      // N2: a worker's ask is held from the principal until WORKER_ASK_GRACE_MS has passed since it was asked; the manager's never is.
      const held = (askedAt: number) => asker.kind === "worker" && now - askedAt < WORKER_ASK_GRACE_MS;
      const questions = this.#watch.openQuestions(w.id);
      const read = this.#watch.screen(w.id);              // undefined: never read, offline or failed; no news about its menu
      const screen = read ?? "";
      const base = { asker, need: "decision" as const, answerBy: "screen" as const, recommendation: null, ifNoAnswer: null,
        deadline: null, blocking: false, project: null, tracking: "source" as const,
        shortTitle: null, summary: null, minutes: null, link: null, details: null };
      for (const q of questions) {
        if (held(q.at)) continue;                          // N2: open less than WORKER_ASK_GRACE_MS, so not for the principal yet
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
        // First sight persists even while the ask is held, so its clock survives a restart; a held menu is no sighting,
        // sets no #menus and must not reach the else below, which drops the first sight and would restart the clock.
        const askedAt = this.#since(menuKey, now);
        if (!held(askedAt)) {
          this.#menus.set(id, menuIdentity(screen) ?? "");
          out.push({
            ask: {
              ...base, id: escalationId(id), title: "Waiting at a prompt on its screen",
              context: lines.slice(-SCREEN_LINES).join("\n"), contextKind: "screen", options: [],
              askedAt, messageId: null,
            },
            source: { kind: "open" }, answered: null,
          });
        }
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
    if (!mayCommand(a.session, this.#now(), this.#policy())) return { ok: false, problem: "step_up", item: this.#view(id, a.endpoint.id) };
    if (choice.kind === "words" && choice.text.length > MAX_WORDS) return { ok: false, problem: "too_long", item: this.#view(id, a.endpoint.id) };
    if (choice.kind === "words" && !cleanText(choice.text)) return { ok: false, problem: "empty", item: this.#view(id, a.endpoint.id) };
    const now = this.#now();
    for (const [k, t] of this.#seen) if (now - t > REQUEST_TTL_MS) this.#seen.delete(k);
    const key = `${a.session.id}:${requestId}`;
    // A repeat of an answer the queue gave up, never typed: it reached no one, and its ask is open again (E13). Answering
    // again is a new request (#29's not_delivered; ruling 82).
    const givenUp = this.#queue?.byRequest(a.endpoint.id, requestId) ?? null;
    if (givenUp?.kind === "answer" && givenUp.escalationId === id && givenUp.state === "given_up") return { ok: false, problem: "not_delivered", item: this.#view(id, a.endpoint.id) };
    if (this.#seen.has(key)) return { ok: true, item: this.#view(id, a.endpoint.id) };
    if (this.#inFlight.has(id)) return { ok: false, problem: "in_progress", item: this.#view(id, a.endpoint.id) };
    this.#inFlight.set(id, null);
    try {
      // A repeat of this request's answer in doubt first: whatever became of the ask since — gone from the board, or
      // asked again — it must learn what became of that answer (its row names the answer: this escalation, this choice,
      // as asked when the row was written; round 3.5 of the PR #55 review). Typed there, it is that earlier version's
      // answer (#settleAnswer); never started, the same choice is a new answer to the ask as it stands, judged and
      // typed anew (the answer key's own rule, round 2.8).
      const request = `${a.endpoint.id}:${requestId}`;
      const earlier = this.#store.sendOfRequest(request);
      if (earlier && holdsChoice(earlier.key, id, choice)) {
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
          return { ok: true, item: this.#view(id, a.endpoint.id) };
        }
        // Still in doubt while the switch is off: it may be queued, so it is never typed by hand (ruling 49).
        if (queued.state === "sending" && this.#queue && !this.#queue.on) return { ok: false, problem: "uncertain", item: this.#view(id, a.endpoint.id) };
      }
      const c = this.#x.check(id, choice, this.#now());
      if (!c.ok) return { ok: false, problem: c.error, item: this.#view(id, a.endpoint.id) };
      let e = c.value;
      if (seen !== undefined && seen !== this.#version(e)) return { ok: false, problem: "changed", item: this.#view(id, a.endpoint.id) };
      const k = answerKey(e.id, e, choice);
      // ... or of the same answer from another request, or another answer to this ask (E8), before anything is queued
      // or typed (review #29.2): an earlier answer this hub may have typed must block a second one, or the manager can
      // be given both. Once per answer, for the queue and the typed path alike (round 5.6 of the PR #55 review). What
      // follows is the ask as it judged it afresh (round 5.1).
      const judged = await this.#settleEarlier(a, id, choice, e, k, key);
      if ("refused" in judged) return judged.refused;
      e = judged.e;
      // A Memory note's Ask (ADR-0031 round 2): answered in the app, decided by Memory itself; never typed, never queued.
      if (e.id.startsWith("mem-")) return this.#answerMemory(a, e, choice, key);
      if (this.#queue?.on && e.asker.kind === "manager") return await this.#queueAnswer(a, e, choice, requestId, key);
      if (!e.asker.workerId) {
        const conflict = e.asker.kind === "manager" && this.#watch.workers().some(w => w.name === this.#managerName && w.conflict);
        return { ok: false, problem: conflict ? "lane_conflict" : "no_pane", item: this.#view(id, a.endpoint.id) };
      }
      // ... and one queued for the manager before the switch went off, still in doubt: it may be queued (E8, ruling 49).
      if (this.#queue?.sendingOf(`hub:${askPrefix(e.id, e)}`).length) {
        log.warn(`answer to ${id} refused: an answer to it through the manager's queue is in doubt; nothing is typed directly`);
        return { ok: false, problem: "answer_in_doubt", item: this.#view(id, a.endpoint.id) };
      }
      const decided = decidedChoice(choice, e.options);
      const option = decided.kind === "option" ? decided : null;
      const line = option ? tapLine(e.id, option) : wordsLine(e.id, choice.kind === "words" ? choice.text : "");
      // Written before the first await, as a send's is: a hub that stops while this is typed leaves it "started".
      if (!this.#store.startAnswer(k, now, { workerId: e.asker.workerId, request, session: a.session.id, label: option?.label ?? null })) return { ok: false, problem: "uncertain", item: this.#view(id, a.endpoint.id) };
      let outcome: SendOutcome;
      // A node that may have typed it (SendInDoubt): "uncertain", the hub's 409, never a 500 the app reads as a refusal
      // (final review I1), and kept for its repeat with the store it went to. Any other throw keeps its row too (below).
      this.#inFlight.set(id, k);
      try { outcome = await this.#send(e.asker.workerId, line, k); }
      catch (err) {
        // Any other throw (the legacy port's tmux command list, which can fail after the paste) may have typed it too:
        // its row stays, with no store, so a repeat is uncertain and it is never typed twice (ADR-0008, phase C).
        if (!(err instanceof SendInDoubt)) {
          log.warn(`answer to ${e.id} in doubt: typing it threw, maybe after the paste; a repeat stays uncertain`, err);
          return { ok: false, problem: "uncertain", item: this.#view(id, a.endpoint.id) };
        }
        keepInDoubt(this.#store, k, err);
        log.warn(`answer to ${e.id} in doubt: its node may have typed it; a repeat asks the node`, err);
        return { ok: false, problem: "uncertain", item: this.#view(id, a.endpoint.id) };
      } finally { this.#inFlight.set(id, null); }
      settleOutcome(this.#store, k, outcome);                           // a retry may type it; "not_submitted" keeps its row
      if (outcome.problem) {
        log.warn(`answer to ${e.id} not delivered: ${outcome.problem}`);
        return { ok: false, problem: outcome.problem, item: this.#view(id, a.endpoint.id) };
      }
      return this.#delivered(a, id, choice, key, option?.label ?? null);
    } finally {
      this.#inFlight.delete(id);
      const held = this.#held.filter(c => c.row.escalationId === id);
      if (held.length > 0) this.#held = this.#held.filter(c => c.row.escalationId !== id);
      for (const c of held) this.#applyDelivery(c.row, c.view);
      if (held.length > 0) this.#notify();
    }
  }

  // The principal's answer to a Memory note's Ask (ADR-0031 round 2; M4, M5, M8): approve or reject, decided by Memory
  // itself under step-up — `answer()` judged the session already (AC7) and `decide` judges it again. Nothing is typed
  // and no queue is touched: the hub holds the ask, so the Decision is recorded as any answer is (E8), and the feed and
  // every endpoint learn it. A note that stopped waiting answers "changed" (E12): the Ask no longer says what he was
  // shown. Nothing is recorded on a refusal.
  #answerMemory(a: Authenticated, e: Escalation, choice: Choice, key: string): AnswerResult {
    const item = this.#view(e.id, a.endpoint.id);
    if (choice.kind !== "option" || (choice.key !== "approve" && choice.key !== "reject")) return { ok: false, problem: "bad_option", item };
    const noteId = e.id.slice(4).toUpperCase();                  // mem-n-12 → N-12
    const memory = this.#memory?.() ?? null;
    if (!memory) return { ok: false, problem: "changed", item };
    // The Ask answered is the Ask Memory files for that note now, word for word (E12): whatever else carries the id, or
    // whatever the note became, a tap approves only what Memory itself showed him.
    const note = memory.pending().find(n => n.id === noteId);
    if (!note || e.asker.name !== "memory" || this.#version(e) !== askVersion(memoryAsk(note))) return { ok: false, problem: "changed", item };
    const r = memory.decide(a, noteId, choice.key);
    if (!r.ok) return { ok: false, problem: r.problem === "step_up" ? "step_up" : "changed", item };
    log.info(`memory note ${noteId} ${choice.key === "approve" ? "approved" : "rejected"} in the app`);   // the id only, never the body or a code
    return this.#delivered(a, e.id as string, choice, key, e.options.find(o => o.key === choice.key)?.label ?? null);
  }

  // The manager's answer through the fleet's queue (spec §9.1, E13): queued, it counts as given (E8) and the card says
  // so, with why it waits; the queue's later word moves it on (#onDelivery). Its id is its key (`hub:<key>`), so the
  // switch never types it twice. A manager mid-restart is no refusal: its sticky name waits on its node (spec §4.6).
  async #queueAnswer(a: Authenticated, e: Escalation, choice: Choice, requestId: string, key: string): Promise<AnswerResult> {
    const queue = this.#queue as ManagerQueue;
    const id = e.id as string;
    const k = answerKey(e.id, e, choice);
    // An answer typed directly before the queue was on, still in doubt, was settled with its node already (answer(),
    // #settleEarlier), as every earlier answer to this ask is, before anything is queued.
    // Another answer to this ask whose delivery is in doubt (the fleet took it and never answered) may be queued (E8).
    const deliveryId = queue.idFor(k);
    if (queue.sendingOf(`hub:${askPrefix(e.id, e)}`).some(r => r.deliveryId !== deliveryId)) {
      log.warn(`answer to ${id} refused: another answer to it may be queued for the manager (its delivery is in doubt)`);
      return { ok: false, problem: "answer_in_doubt", item: this.#view(id, a.endpoint.id) };
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
      return { ok: false, problem: r.problem === "timeout" ? "busy" : r.problem, item: this.#view(id, a.endpoint.id) };
    }
    const nowAsk = this.#x.get(id);
    if (!nowAsk || nowAsk.messageId !== e.messageId || this.#version(nowAsk) !== version) {
      log.warn(`answer to ${id} was queued for an ask that was restated meanwhile; its delivery is withdrawn`);
      void queue.cancel(r.row.deliveryId);
      return { ok: false, problem: "changed", item: this.#view(id, a.endpoint.id) };
    }
    // The Decision as its row has it: a repeat in doubt keeps its first attempt's time and provenance.
    const expected = decisionOf(r.row);
    const q = this.#x.queue(id, choice, { endpointId: endpointId(r.row.endpointId), sessionId: sessionId(r.row.sessionId) }, expected.at);
    if (!q.ok) {                       // closed or asked again while it was queued: the next poll withdraws it
      log.warn(`answer to ${id} queued, but its ask no longer takes it (${q.error}); its delivery is withdrawn`);
      return { ok: false, problem: q.error, item: this.#view(id, a.endpoint.id) };
    }
    this.#store.saveDecision(id, q.value);
    this.#seen.set(key, this.#now());
    log.info(`answer to ${id} queued for the manager`);
    this.#applyDelivery(r.row, queue.view(deliveryId) ?? r.view);   // the latest word: a repeat may find it delivered already
    this.#notify();
    return { ok: true, item: this.#view(id, a.endpoint.id) };
  }

  // An answer in doubt, settled with the node it went to (SteeringService's settle, on its row): typed there → delivered,
  // a duplicate at the node's time; null → the node never started it (its row is gone), so the answer is judged anew;
  // anything else → uncertain. A row already done was settled before: delivered. Whose duplicate it is, the row says
  // (A1): another endpoint's row, done or settled now, is not this caller's answer — its result says what its view
  // says, answered from elsewhere, not a duplicate of its own (rounds 2.5 and 3.4). A row that names no request is
  // recorded under the caller, whose answer key it holds, and stays its duplicate.
  async #settleAnswer(a: Authenticated, id: string, choice: Choice, row: SendRow, key: string): Promise<AnswerResult | null> {
    const requester = this.#requesterOf(row);
    const others = requester !== null && requester.endpointId !== a.endpoint.id;
    if (row.state === "done") {
      // Another endpoint's row, done, is its answer and never this caller's duplicate: the same rule as a settled one
      // (round 3.4). Typed, it is recorded for that endpoint; queued, its inbox records it once delivered (E13).
      if (others) {
        this.#record(id, choice, requester, row.label);
        return { ok: false, problem: "already_answered", item: this.#view(id, a.endpoint.id) };
      }
      this.#seen.set(key, this.#now());
      return { ok: true, item: this.#view(id, a.endpoint.id), duplicate: true, at: row.typedAt ?? row.at };
    }
    const settled = row.workerId === null ? { ok: false as const, problem: "uncertain" as const } : await this.#settle(row.key, row.workerId);
    if (settled === null) return null;
    if (!settled.ok && settled.problem === "duplicate") {
      if (!others) {
        // Its own request's row, for a version of the ask that is gone or was asked again since: delivered, but an
        // answer to that earlier version, never to the ask as it stands (E11, E12; round 3.5). Which it is, the
        // aggregate says (round 4.6); for the ask as it stands, it is the ask's own Decision.
        return this.#deliveredEarlier(a, id, choice, row, key, settled.at, requester)
          ?? this.#delivered(a, id, choice, key, row.label, settled.at, requester ?? undefined);
      }
      // Recorded for its own endpoint. This caller's request delivered nothing, so it is not remembered as delivered:
      // a retry of it is told the same, never ok (round 3.3).
      this.#record(id, choice, requester, row.label);
      return { ok: false, problem: "already_answered", item: this.#view(id, a.endpoint.id) };
    }
    log.warn(`answer to ${id} in doubt: its node can't say it never typed it; it stays uncertain`);
    return { ok: false, problem: "uncertain", item: this.#view(id, a.endpoint.id) };
  }

  // Every answer to this ask that its node may have typed, settled with that node before this one is typed or queued
  // (E8): the same choice's row first (a repeat by another request), then another choice's. Each ends in a result for
  // the caller, or in nothing when its node never started it, and then its row is gone. A tap that row hid as its own
  // paste was no paste: a hand typed it, and it answers the ask. So once a row went, the ask is judged again from a
  // fresh read before anything is typed (the conservative outcome, E8): the hub never writes its own row after a tap
  // that answers the ask, and no order of what it read and wrote is needed (round 4.1 of the PR #55 review). Asked
  // again or restated meanwhile, the answer is refused as changed (E12), with or without a `seen` (round 5.1): never
  // typed under the earlier version's key, nor with a label he did not see. Meanwhile is since the caller judged `e`
  // (and held `seen` to it): a poll updates an escalation in place, so its version is taken before the first await.
  // Otherwise the result is the ask as judged afresh, which the caller goes on with.
  async #settleEarlier(a: Authenticated, id: string, choice: Choice, e: Escalation, k: string, key: string): Promise<{ refused: AnswerResult } | { e: Escalation }> {
    const version = this.#version(e);
    const prefix = askPrefix(e.id, e);
    const own = this.#store.send(k);
    const others = this.#store.answersOfAsk(prefix).filter(r => r.key !== k);
    if (own === null && others.length === 0) return { e };
    if (own) {
      const settled = await this.#settleAnswer(a, id, choice, own, key);
      if (settled) return { refused: settled };
    }
    const other = await this.#otherAnswer(a, id, prefix, others);
    if (other) return { refused: other };
    this.poll();
    const c = this.#x.check(id, choice, this.#now());
    if (!c.ok) return { refused: { ok: false, problem: c.error, item: this.#view(id, a.endpoint.id) } };
    if (answerKey(c.value.id, c.value, choice) !== k || this.#version(c.value) !== version) return { refused: { ok: false, problem: "changed", item: this.#view(id, a.endpoint.id) } };
    return { e: c.value };
  }

  // Another answer to the same ask (another choice, another request) that its node may have typed (E8 while an answer is
  // in doubt; fleet core §3.1). It is settled with that node first, as a repeat of it would be: never started there →
  // its row is gone and this answer is judged as usual (null); typed there, now or before → it was his answer, recorded
  // now, and this one is refused as a second answer; anything else → this one is refused as in doubt. Nothing is typed
  // in either refusal.
  async #otherAnswer(a: Authenticated, id: string, prefix: string, rows: readonly SendRow[]): Promise<AnswerResult | null> {
    for (const other of rows) {
      const settled = other.state === "done" ? { ok: false as const, problem: "duplicate" as const, at: other.typedAt ?? other.at }
        : other.workerId === null ? { ok: false as const, problem: "uncertain" as const }
        : await this.#settle(other.key, other.workerId);
      if (settled === null) continue;
      if (!settled.ok && settled.problem === "duplicate") {
        this.#typedEarlier(other, id, other.key.slice(prefix.length), { endpointId: a.endpoint.id, sessionId: a.session.id });
        return { ok: false, problem: "already_answered", item: this.#view(id, a.endpoint.id) };
      }
      log.warn(`answer to ${id} refused: another answer to it is in doubt (its node can't say it never typed it)`);
      return { ok: false, problem: "answer_in_doubt", item: this.#view(id, a.endpoint.id) };
    }
    return null;
  }

  // Who sent the answer a row in doubt holds (A1): the endpoint its request names ("<endpoint>:<request id>") and the
  // session under it when this hub wrote the row down. The split is at the last colon: the request id is the uuid, the
  // part known to carry no colon, while an endpoint id may take a prefixed form with one of its own (round 2.6). Null
  // when the row names no request.
  #requesterOf(row: SendRow): { endpointId: EndpointId; sessionId: SessionId | null } | null {
    const at = row.request?.lastIndexOf(":") ?? -1;
    if (at <= 0) return null;
    return { endpointId: endpointId(row.request!.slice(0, at)), sessionId: row.requestSession === null ? null : sessionId(row.requestSession) };
  }

  // An answer found typed at the asker (an answer in doubt that its node had typed): his Decision (E8), once, as it was
  // decided: its option, with the label it was typed with (#shown), or words, whose digest its key carries (their
  // length isn't kept). The row it was found under names whose answer it was, not whoever's repeat settled it (review
  // of PR #55). A row that names no requester — from before requests were kept — is recorded under whoever's repeat
  // learnt it, as before the request column: unrecorded, the ask could never close, every answer refused as already
  // answered (round 2.3).
  #typedEarlier(row: SendRow, id: string, part: string, by: { endpointId: EndpointId; sessionId: SessionId | null }) {
    const requester = this.#requesterOf(row) ?? by;
    const e = this.#x.get(id);
    if (!e || e.status !== "open") return;
    const option = part.startsWith("option:") ? part.slice("option:".length) : null;
    const chosen = option === null ? { kind: "words" as const } : { kind: "option" as const, key: option };
    const r = this.#x.recordTyped(id, decidedChoice(chosen, this.#shown(id, chosen, row.label)), requester, this.#now());
    if (!r.ok) { log.warn(`answer to ${id} found typed but not recorded: ${r.error}`); return; }
    const decision = this.#x.get(id)?.decision;
    if (decision) this.#store.saveDecision(id, decision);
    this.#store.record([{ ...r.value, ...(option === null ? { digest: part.slice("words:".length) } : {}) }]);
    this.#notify();
  }

  // The answer arrived: recorded as his Decision (E8), once. `label`: its row's, the one it was typed with (#shown).
  // `at`: a duplicate's time on the node that typed it. `by` defaults to the caller; an answer in doubt that another
  // endpoint's repeat settled is recorded for its row's own requester — the endpoint whose answer it was — not whoever's
  // repeat learnt it (review of PR #55).
  #delivered(a: Authenticated, id: string, choice: Choice, key: string, label: string | null, at?: number, by?: { endpointId: EndpointId; sessionId: SessionId | null }): AnswerResult {
    this.#seen.set(key, this.#now());
    this.#record(id, choice, by ?? { endpointId: a.endpoint.id, sessionId: a.session.id }, label);
    return { ok: true, item: this.#view(id, a.endpoint.id), ...(at === undefined ? {} : { duplicate: true as const, at }) };
  }
  // A request's answer found typed for a version of the ask that is gone from the board or was asked again since: it
  // reached the asker, so the caller is told so (a duplicate at the node's time) and it is recorded with its provenance
  // (A1), as an answer to that earlier version, as the inbox records a late one, with the label that version showed:
  // its row's (#shown; E9, round 4.5). The ask as it stands is not answered by it (E11, E12): asked again, it stays
  // open. The aggregate records it, as every answered event (round 4.6), and says null when the row's asking is the ask
  // as it stands: no earlier answer.
  #deliveredEarlier(a: Authenticated, id: string, choice: Choice, row: SendRow, key: string, at: number, by: { endpointId: EndpointId; sessionId: SessionId | null } | null): AnswerResult | null {
    const event = this.#x.recordEarlier(id, askingOf(row.key, id, choice), decidedChoice(choice, this.#shown(id, choice, row.label)), by ?? { endpointId: a.endpoint.id, sessionId: a.session.id }, this.#now());
    if (!event) return null;
    this.#seen.set(key, this.#now());
    this.#store.record([{ ...event, ...wordsKept(choice) }]);
    log.info(`answer to ${id} found typed, for an earlier version of its ask: recorded as that version's answer`);
    return { ok: true, item: this.#view(id, a.endpoint.id), duplicate: true, at };
  }
  // The Decision itself, for the endpoint whose answer it was, without saying anything to whoever learnt it. `label`:
  // its row's (#shown).
  #record(id: string, choice: Choice, by: { endpointId: EndpointId; sessionId: SessionId | null }, label: string | null) {
    const r = this.#x.record(id, choice, by, this.#now(), this.#shown(id, choice, label));
    if (r.ok) {
      const decision = this.#x.get(id)?.decision;
      if (decision) this.#store.saveDecision(id, decision);
      this.#store.record([{ ...r.value, ...wordsKept(choice) }]);
    } else {
      log.warn(`answer to ${id} delivered but not recorded: ${r.error}`);
    }
    this.#notify();
  }
  // The options an answer is labelled from (E9), one rule for every record of it (rounds 5.2 and 5.3 of the PR #55
  // review): the label its row kept, the one the hub typed, whatever the ask was restated as since (round 4.5). A row
  // from before labels were kept (migration 22) has none: the label is then the held ask's own for that option, as
  // before the column, and the key only when the ask no longer has it. Never the request's.
  #shown(id: string, choice: { kind: "option"; key: string } | { kind: "words" }, label: string | null): readonly { key: string; label: string }[] {
    return choice.kind === "option" && label !== null ? [{ key: choice.key, label }] : this.#x.get(id)?.options ?? [];
  }
}
