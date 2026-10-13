// Application service for the Escalation context (ADR-0006 addendum "Decisions"): gathers what waits for the principal
// from its sources, keeps the Escalations aggregate current, and delivers his Decision to the asker.
// Sources, each through its adapter: the manager's needs-you list (ledger), the manager's button messages and the taps
// seen in its conversation (manager protocol), and workers' open questions and menus (the transcript and screen
// adapters, read through Observation; nothing is decided from them, O4).
import { createHash } from "node:crypto";
import {
  DEFAULT_POLICY, Escalations, answered, askFromBrief, askVersion, endpointId, escalationId, mayCommand, refusal, sameDecision, sessionId, viaFor,
  type AccessPolicy, type AnswerRefusal, type Ask, type Choice, type Decision, type DecidedChoice, type DecisionBrief, type EndpointId, type Escalation, type Message, type SessionId, type Sighting,
} from "@morndo/domain";
import type { BriefSighting } from "./brief-service.ts";
import { menuEscalationId } from "@morndo/protocol";
import type { LedgerItem, LedgerRead } from "../adapters/ledger.ts";
import { isLedgerId, parseAnswer, parseTap, tapLine, wordsLine, type ButtonOption } from "../adapters/manager-protocol.ts";
import type { SendRow, Store } from "../adapters/store.ts";
import { menuIdentity, menuOnScreen, type SendProblem } from "@morndo/node-ops";
import { cleanText, managerInbox, type InboxReason, type InboxState, type InboxStatus, type ManagerInbox } from "../adapters/manager-inbox.ts";
import type { Authenticated } from "./access-service.ts";
import { SendInDoubt, type SendOutcome, type SendRefused } from "./ports.ts";
import { keepInDoubt, settleOutcome, type SendResult } from "./steering-service.ts";
import { log } from "../adapters/log.ts";

// What the service reads from Observation: who runs where, their conversations and screens.
export type Watch = {
  // `conflict`: the fleet's lane registry has this name in conflict (two windows claim it, Task 14); legacy never says.
  workers(): { id: string; name: string; conflict?: boolean }[];
  history(id: string): Message[];
  openQuestions(id: string): Message[];
  screen(id: string): string | undefined;
};

// inbox: while a Decision for the manager waits in its inbox (ADR-0010), where it stands there; null otherwise.
export type InboxView = { status: InboxStatus; reason: InboxReason | null };
// One queued answer, by inbox key. The same shape is what the constructor restores, what a new answer stores, and what
// #giveUp withdraws (review #29.9).
type QueuedAnswer = {
  escalationId: string; decision: Decision; words: { length?: number; digest?: string }; state: InboxView; dir: string | null;
  line?: string; cancel?: boolean; late?: boolean; missed?: boolean; notice?: string; version?: string; unreadableSince?: number; sendKey?: string;
};
// What a pending row stores: the queued answer without the fields only the running hub keeps, plus settledAt once withdrawn.
type RestoredAnswer = Partial<Omit<QueuedAnswer, "escalationId" | "decision" | "words" | "state">> & {
  decision: Decision; words?: QueuedAnswer["words"]; settledAt?: number;
};
export type EscalationView = Escalation & {
  answerable: AnswerRefusal | null; version: string; inbox: InboxView | null; notice: string | null;
  brief: DecisionBrief | null; briefVersion: number; draftedBy: string | null;
};
type ButtonMessage = { message: Message; body: string; options: ButtonOption[] };
export type Board = { items: EscalationView[]; ledger: { configured: boolean; ok: boolean; at: number | null } };
// `duplicate`: a repeat of an answer in doubt that its node had typed after all; `at` is when, on that node's clock.
// `queued`: the answer is in the inbox and not typed yet. That is not delivered, and `at` is not the enqueue time.
export type AnswerResult =
  | { ok: true; item: EscalationView | null; duplicate?: true; at?: number; queued?: true }
  | { ok: false; problem: AnswerRefusal | SendProblem | SendRefused | "node_offline" | "lane_conflict" | "step_up" | "in_progress" | "too_long" | "changed" | "uncertain" | "answer_in_doubt" | "not_delivered"; item: EscalationView | null };
// How a row in doubt is settled with its node: SteeringService's settle (a duplicate, uncertain, or null: the node never
// started it, so it is judged anew). Without a fleet nobody else knows: uncertain.
export type SettleInDoubt = (key: string, workerId: string) => Promise<SendResult | null>;

const MAX_WORDS = 4000;
const SCREEN_LINES = 14;
const REQUEST_TTL_MS = 10 * 60_000;
const SETTLED_LEDGER_MS = 3 * 24 * 3_600_000;        // closed list items shown under "Decided" for three days
const ECHO_KEEP_MS = 24 * 3_600_000;                  // how long a withdrawn answer's echo is ignored (B1)
const UNREADABLE_GIVE_UP_MS = 15 * 60_000;            // an inbox that can't be read this long counts as gone (H3)
const LATE_ANSWER = "This reached the manager late, as an answer to the earlier version of the question.";
const MISSED_ANSWER = "The answer did not reach the manager. Answer again.";
const TYPED = new Set<InboxStatus>(["typing", "sent", "stuck", "accepted"]);

const digest = (words: string) => createHash("sha256").update(words.trim()).digest("hex").slice(0, 16);
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
  #seen = new Map<string, number>();
  #lastLedger: LedgerRead | null = null;
  #filed = new Map<string, LedgerItem>();              // the last readable list's items: wording while it can't be read
  #buttons = new Map<string, ButtonMessage>();         // each id's last button message: its options once it scrolls out
  // A menu on a worker's screen by escalation id: the menu itself (its question and choices, menuIdentity), what its
  // version is made of instead of the screen's last lines, which a redraw or a spinner changes (Stage-4 review, 2).
  #menus = new Map<string, string>();
  #timer: NodeJS.Timeout | null = null;
  // Decisions handed to the manager's inbox and not delivered yet, by escalation id: the inbox key, the Decision as
  // queued (recorded with its provenance once delivered, even if the ask was asked again meanwhile), the words' length
  // and hash for the record, and the inbox's latest word on it.
  #inbox: ManagerInbox | null;
  // By inbox key (code review B7): two answers to one ask, the ask asked again between them, are two messages, each
  // recorded once it arrives. The store keeps the same, one pending_answers row per message.
  // dir: the inbox the message went to; read until it settles there, even when the hub runs without an inbox now (B6).
  // line: what was queued; cancel: withdrawn while still untyped (the ask changed); late: already typed, so it is
  // waited for and, if the ask moved on, recorded as an answer to the earlier version. version: the ask as queued (E12).
  // missed: lost or unconfirmed, so a cancel was asked; Answer again waits until the spool says cancelled (review #29.1).
  // unreadableSince: since then its inbox couldn't be read (H3).
  #queued = new Map<string, QueuedAnswer>();
  // Lines that may still reach the manager after the ask moved on. For 24 hours the first message with that line is
  // not an answer to the new ask (B1, H1). Once that message is known, a later one with the same line is (review #3).
  #echoes = new Map<string, { line: string; after: number; messageId: string | null }[]>();
  // A sentence on an open card: a late delivery, or an answer the inbox lost (decisions 2 and 3). Kept on the settled
  // pending row so a restart still shows it, and cleared when he answers (inbox or typed) or the ask is gone (review #29.8).
  #notices = new Map<string, string>();
  #readers = new Map<string, ManagerInbox>();
  #prunedAt = 0;                                        // settled pending rows are dropped on a coarse timer, not every poll
  static readonly #pruneEveryMs = 60 * 60_000;
  // Briefs filed through the hub (ADR-0023). Read at the start of each poll; the service does not store them.
  #briefs: (() => BriefSighting[]) | null;
  #briefOf = new Map<string, BriefSighting>();
  #paneTaps = new Map<string, { key: string; label: string; at: number }>();

  constructor(p: {
    watch: Watch; ledger: (() => LedgerRead) | null; store: Store; managerName: string;
    briefs?: () => BriefSighting[];
    // Typing the answer: the port's outcome, with the node's own typedAt (spec 3.1) and the store it went to.
    send: (pane: string, text: string, key: string) => Promise<SendOutcome>; now?: () => number; policy?: () => AccessPolicy;
    // How an answer in doubt is settled with its node (SteeringService.settleInDoubt). Absent: the legacy hub, which has
    // no node to ask, so an answer in doubt there (a throw while typing it) stays uncertain.
    settle?: SettleInDoubt;
    inbox?: ManagerInbox | null;
  }) {
    this.#inbox = p.inbox ?? null;
    this.#watch = p.watch;
    this.#ledger = p.ledger;
    this.#store = p.store;
    this.#store.recoverQueuedAnswers();
    this.#send = p.send;
    this.#settle = p.settle ?? (async () => ({ ok: false, problem: "uncertain" }));
    this.#managerName = p.managerName;
    this.#now = p.now ?? Date.now;
    this.#policy = p.policy ?? (() => DEFAULT_POLICY);
    this.#briefs = p.briefs ?? null;
    this.#firstSeen = this.#store.askFirstSeen();
    // The stored row may also carry the inbox key and the words' hash: they are the service's, never the Decision's, so
    // they never reach the board (code review B8).
    const saved = this.#store.decisions().map(d => {
      const { inbox, words, ...decision } = d.decision as Decision & { inbox?: string; words?: { length?: number; digest?: string } };
      return { id: d.id, decision: decision as Decision, inbox, words };
    });
    this.#x.restore(saved.map(d => ({ id: escalationId(d.id), decision: d.decision })));
    // Queued before a restart: still waiting in the inbox, one row per message.
    for (const r of this.#store.pendingAnswers()) {
      const b = r.body as RestoredAnswer;
      if (b.settledAt !== undefined) {                 // a withdrawn answer kept for its echo (B1), and its card's notice
        if (this.#now() - b.settledAt > ECHO_KEEP_MS) this.#store.dropPending(r.key);
        else {
          if (b.line) this.#echo(r.escalationId, b.line, b.decision.at);
          if (typeof b.notice === "string") this.#notices.set(r.escalationId, b.notice);
        }
        continue;
      }
      this.#queued.set(r.key, this.#open({ escalationId: r.escalationId, decision: b.decision, dir: b.dir ?? null,
        ...(b.words !== undefined ? { words: b.words } : {}), ...(b.line !== undefined ? { line: b.line } : {}),
        ...(b.cancel ? { cancel: true } : {}), ...(b.late ? { late: true } : {}), ...(b.missed ? { missed: true } : {}),
        ...(b.version !== undefined ? { version: b.version } : {}), ...(b.sendKey !== undefined ? { sendKey: b.sendKey } : {}) }));
      if (b.cancel && b.line) this.#echo(r.escalationId, b.line, b.decision.at);
    }
    for (const d of saved) {                             // a row from before pending_answers: moved there
      if (d.decision.delivery?.state === "queued" && typeof d.inbox === "string" && !this.#queued.has(d.inbox)) {
        const dir = this.#inbox?.dir ?? null;
        this.#store.savePending(d.inbox, d.id, { decision: d.decision, words: d.words ?? {}, ...(dir ? { dir } : {}) });
        this.#queued.set(d.inbox, this.#open({ escalationId: d.id, decision: d.decision, dir, ...(d.words !== undefined ? { words: d.words } : {}) }));
      }
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
      items: this.#x.list().map(e => ({ ...e, answerable: refusal(e, now), version: this.#version(e), inbox: this.#inboxView(e), notice: this.#notices.get(e.id) ?? null, ...this.#briefView(e.id) })),
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
    return this.#forViewer({ ...e, answerable: refusal(e, this.#now()), version: this.#version(e), inbox: this.#inboxView(e), notice: this.#notices.get(e.id) ?? null, ...this.#briefView(e.id) }, viewer);
  }
  #briefView(id: string): { brief: DecisionBrief | null; briefVersion: number; draftedBy: string | null } {
    const b = this.#briefOf.get(id);
    return { brief: b?.brief ?? null, briefVersion: b?.version ?? 0, draftedBy: b?.draftedBy ?? null };
  }
  // A queued answer whose ask was asked again or settled meanwhile answers a question the principal no longer has
  // (E11, E12): withdrawn from the inbox, once, and its echo ignored should the cancel come too late (code review B1).
  #withdrawStale(spool: Map<string, InboxState | null>) {
    for (const [key, q] of this.#queued) {
      if (q.cancel || q.late) continue;
      const e = this.#x.get(q.escalationId);
      if (!e) continue;
      // Settled or expired meanwhile: withdrawn even though the ask still holds this Decision (code review H2).
      // Restated in place (same addedAt, new wording): the version changed while this Decision still stands (review #8).
      const closed = e.status === "settled" || e.status === "expired";
      const restated = q.version !== undefined && this.#version(e) !== q.version;
      if (!closed && !restated && (sameDecision(e.decision, q.decision) || !(e.askedAt > q.decision.at))) continue;
      const reader = this.#reader(q.dir);
      if (!reader) continue;
      const s = spool.get(key) ?? null;
      // Still untyped (no state file reads as queued, attempts 0): withdraw. Once typed, never cancel (decision 2):
      // wait for delivered, and if the ask moved on, record it then as a late answer to the old version.
      if (!s || this.#mayHaveTyped(s)) {
        if (s && this.#mayHaveTyped(s)) {
          q.late = true;
          if (q.line) this.#echo(q.escalationId, q.line, q.decision.at);
          this.#store.savePending(key, q.escalationId, this.#pendingBody(q));
        }
        continue;
      }
      if (s.status !== "queued" && s.status !== "held") continue;   // delivered, lost, gone, cancelled: #deliveries
      try { reader.cancel(key); } catch (err) { log.error(`answer to ${q.escalationId}: the withdrawal can't be written`, err); continue; }
      q.cancel = true;
      this.#store.savePending(key, q.escalationId, this.#pendingBody(q));
      if (q.line) this.#echo(q.escalationId, q.line, q.decision.at);
      log.info(`answer to ${q.escalationId} withdrawn from the manager's inbox: the ask changed since`);
    }
  }
  // Typed, or a cancel that arrived after a paste: an echo of it may still show up (decision 2).
  #mayHaveTyped(s: InboxState): boolean {
    return TYPED.has(s.status) || (s.attempts ?? 0) >= 1;
  }
  #echo(id: string, line: string, after: number) {
    const list = this.#echoes.get(id) ?? [];
    if (list.some(e => e.line === line && e.after === after)) return;
    list.push({ line, after, messageId: null });
    this.#echoes.set(id, list);
  }
  #unecho(id: string, line: string, after: number) {
    const list = (this.#echoes.get(id) ?? []).filter(e => e.line !== line || e.after !== after);
    if (list.length) this.#echoes.set(id, list); else this.#echoes.delete(id);
  }
  #open(p: Omit<QueuedAnswer, "state" | "words" | "unreadableSince" | "notice"> & { words?: QueuedAnswer["words"] }): QueuedAnswer {
    return { escalationId: p.escalationId, decision: p.decision, words: p.words ?? {}, state: { status: "queued", reason: null }, dir: p.dir,
      ...(p.line ? { line: p.line } : {}), ...(p.cancel ? { cancel: true } : {}), ...(p.late ? { late: true } : {}), ...(p.missed ? { missed: true } : {}), ...(p.version ? { version: p.version } : {}), ...(p.sendKey ? { sendKey: p.sendKey } : {}) };
  }
  #pendingBody(q: QueuedAnswer, settledAt?: number) {
    return { decision: q.decision, words: q.words, ...(q.dir ? { dir: q.dir } : {}), ...(q.line ? { line: q.line } : {}), ...(q.cancel ? { cancel: true } : {}),
      ...(q.late ? { late: true } : {}), ...(q.missed ? { missed: true } : {}), ...(q.notice ? { notice: q.notice } : {}), ...(q.version ? { version: q.version } : {}), ...(q.sendKey ? { sendKey: q.sendKey } : {}), ...(settledAt !== undefined ? { settledAt } : {}) };
  }
  // The answer did not stand (withdrawn, expired, gone): its sends row must not block the next one (E8).
  #releaseSend(q: { sendKey?: string }) { if (q.sendKey) this.#store.dropSend(q.sendKey); }
  // One withdraw: the Decision, its send, and the queued row. keepEcho holds a paste that may still show up; notice is
  // the card's sentence, stored on the row so a restart still shows it (review #29.9).
  #giveUp(key: string, q: QueuedAnswer, o: { now?: number; keepEcho?: boolean; notice?: string } = {}) {
    const id = q.escalationId;
    this.#x.withdraw(id, q.decision);
    this.#store.dropDecisionIf(id, q.decision.at);       // only this answer's row: a newer one stays (B3)
    this.#releaseSend(q);
    if (o.notice) q.notice = o.notice;
    if (o.keepEcho || o.notice) {
      if (q.line) this.#echo(id, q.line, q.decision.at);
      this.#store.savePending(key, id, this.#pendingBody(q, o.now));
    } else {
      this.#store.dropPending(key);
      if (q.cancel && q.line) this.#unecho(id, q.line, q.decision.at);
    }
    this.#queued.delete(key);
    if (o.notice) this.#notices.set(id, o.notice);
  }
  #forgetEchoes(now: number, rows: { key: string; escalationId: string; body: unknown }[], prune: boolean) {
    for (const [id, list] of this.#echoes) {
      const kept = list.filter(e => now - e.after < ECHO_KEEP_MS);
      if (kept.length) this.#echoes.set(id, kept); else this.#echoes.delete(id);
    }
    // Settled rows are only dropped in the constructor otherwise, so a long-running hub keeps every one (review #29.7).
    // Once an hour is enough: a poll that jumps past the keep window still drops them (round 2.8).
    if (!prune) return;
    for (const r of rows) {
      const body = r.body as { settledAt?: number; notice?: string };
      if (body.settledAt === undefined || now - body.settledAt <= ECHO_KEEP_MS) continue;
      this.#store.dropPending(r.key);
      if (typeof body.notice === "string" && this.#notices.get(r.escalationId) === body.notice) this.#notices.delete(r.escalationId);
    }
  }
  // The sentence leaves with the answer that caused it: a new answer, or the ask itself (review #29.8). An echo row
  // stays, without the sentence, so a later paste of the same line is still ignored. `rows` is the poll's one read.
  #clearNotice(id: string, rows: { key: string; escalationId: string; body: unknown }[] = this.#store.pendingAnswers()) {
    this.#notices.delete(id);
    for (const r of rows) {
      if (r.escalationId !== id) continue;
      const b = r.body as { notice?: string; line?: string };
      if (typeof b.notice !== "string") continue;
      if (b.line) {
        const rest = { ...b };
        delete rest.notice;
        this.#store.savePending(r.key, id, rest);
      } else this.#store.dropPending(r.key);
    }
  }
  #forgetNotices(rows: { key: string; escalationId: string; body: unknown }[]) {
    for (const id of [...this.#notices.keys()]) if (!this.#x.get(id)) this.#clearNotice(id, rows);
  }

  // The inbox a queued answer went to: the configured one, or, read-only, the one it named when it was queued (B6:
  // a restart without MORNDO_MANAGER_INBOX still sees it through, so it is recorded exactly once).
  #reader(dir: string | null): ManagerInbox | null {
    if (!dir) return this.#inbox;
    if (this.#inbox?.dir === dir) return this.#inbox;
    let r = this.#readers.get(dir);
    if (!r) { r = managerInbox(dir, this.#now); this.#readers.set(dir, r); }
    return r;
  }

  #inboxView(e: Escalation): InboxView | null {
    if (e.decision?.delivery?.state !== "queued") return null;
    for (const q of this.#queued.values()) if (q.escalationId === e.id && q.decision.at === e.decision.at) return q.state;
    return { status: "queued", reason: null };
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
    const sightings = [...this.#managerSightings(ledger, now), ...this.#workerSightings(now), ...this.#hubSightings()];
    const changed = this.#x.reconcile(sightings, now, ledger?.ok ?? true);
    for (const id of this.#buttons.keys()) if (!this.#x.get(id)) this.#buttons.delete(id);   // kept as long as its ask
    const pending = this.#store.pendingAnswers();       // one read per poll, shared by the notice and the echo prune
    this.#forgetNotices(pending);
    const prune = now - this.#prunedAt >= EscalationService.#pruneEveryMs;
    if (prune) this.#prunedAt = now;
    this.#forgetEchoes(now, pending, prune);
    // One read of each queued message per poll, shared by the withdrawal and the delivery step (review #29.10).
    const spool = new Map<string, InboxState | null>();
    for (const [key, q] of this.#queued) spool.set(key, this.#reader(q.dir)?.state(key) ?? null);
    this.#withdrawStale(spool);
    const delivered = this.#deliveries(now, spool);
    if (changed || delivered) this.#notify();
  }

  // Decisions in the manager's inbox: delivered ones are recorded (A1: with the endpoint, session and the time they
  // reached the manager), given-up ones (expired, cancelled by hand) open their ask again. Returns whether any changed.
  #deliveries(now: number, spool: Map<string, InboxState | null>): boolean {
    let changed = false;
    for (const [key, q] of this.#queued) {
      const id = q.escalationId;
      // No inbox to read: queued before migration 8 and migrated while none was configured, so where it went is
      // unknown (H4); like an inbox that can't be read.
      const reader = this.#reader(q.dir);
      let s = spool.get(key) ?? null;
      if (!s) {                                          // the inbox can't be read now: next round (code review B2),
        q.unreadableSince ??= now;                       // unless it stays so: moved or deleted (H3)
        if (now - q.unreadableSince < UNREADABLE_GIVE_UP_MS) continue;
        // The directory is still there (msg/ went, the inbox didn't): withdraw the message too (review #7).
        // cancel itself does nothing when the directory is gone, so a removed inbox is not recreated (review #12).
        try { reader?.cancel(key); } catch (err) { log.error(`answer to ${id}: the withdrawal can't be written`, err); }
      } else delete q.unreadableSince;
      if (!s || s.status === "gone") {                   // nothing can deliver it any more: the ask is open again (B2)
        this.#giveUp(key, q);
        log.warn(`answer to ${id}: ${s ? "its message is gone from the manager's inbox" : `its inbox (${q.dir ?? this.#inbox?.dir ?? "not known"}) can't be read for ${UNREADABLE_GIVE_UP_MS / 60_000} min`}; the ask is open again`);
        changed = true;
        continue;
      }
      // lost is not terminal, and a cleared line goes back to sent and is typed again (deliverer #receipt). unconfirmed
      // is the same. Cancel first. Answer again only once the spool says cancelled, so one answer is never typed twice
      // (review #29.1). Until that confirmation the Decision stays and the card does not say to answer again.
      if (s.status === "lost" || s.reason === "unconfirmed") {
        // A state this far along was read from a reader, so there is one. Once per state change: the deliverer
        // confirms cancel on its own loop, and the next poll's spool read sees it.
        if (!q.missed && reader) {
          let wrote = false;
          try { wrote = reader.cancel(key); }
          catch (err) { log.error(`answer to ${id}: the withdrawal can't be written`, err); continue; }
          if (!wrote) continue;                        // the file is not there: the next poll tries again (round 3.3)
          q.missed = true;
          this.#store.savePending(key, id, this.#pendingBody(q));
        }
        continue;
      }
      if (s.status === "delivered") {
        // Recorded from this message's own Decision (A1: who answered, and when it reached the manager).
        const at = s.deliveredAt ?? now;
        const delivered = { ...q.decision, delivery: { state: "delivered" as const, at } };
        const applied = this.#x.delivered(id, q.decision, at);
        const event = applied ?? answered(escalationId(id), delivered);   // superseded: still his answer, to the old version
        if (applied) this.#store.replaceDecisionIf(id, q.decision.at, delivered);   // B3
        else q.notice = LATE_ANSWER;
        // The ask moved on (same message, new version). The done row would block every later answer (round 2.1).
        // Applied and current: the row becomes typed, so a repeat says delivered (round 3.7). A late one is released.
        if (applied && !q.late && q.sendKey) this.#store.finishSend(q.sendKey, at);
        if (!applied || q.late) this.#releaseSend(q);
        this.#store.record([{ ...event, ...q.words }]);
        if (q.cancel || q.late || q.notice) this.#store.savePending(key, id, this.#pendingBody(q, now));   // its echo is ignored (B1)
        else this.#store.dropPending(key);
        if (q.notice) this.#notices.set(id, q.notice);
        this.#queued.delete(key);
        log.info(`answer to ${id} delivered to the manager${applied ? "" : " late, for the earlier version"}`);
        changed = true;
      } else if (s.status === "expired" || s.status === "cancelled") {
        // A paste may have happened (attempts ≥ 1, or our own cancel that didn't say attempts 0): keep the echo (B1, decision 2).
        const keepEcho = (s.attempts ?? 0) >= 1 || (q.cancel === true && s.attempts !== 0);
        this.#giveUp(key, q, { now, keepEcho, ...(q.missed ? { notice: MISSED_ANSWER } : {}) });
        log.warn(`answer to ${id} not delivered: the manager's inbox ${s.status === "expired" ? "let it expire" : "had it cancelled"}${q.missed ? "; it had been lost or unconfirmed" : ""}`);
        changed = true;
      } else if (s.status !== q.state.status || s.reason !== q.state.reason) {
        q.state = { status: s.status, reason: s.reason };
        changed = true;
      }
    }
    return changed;
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
    const echoes = new Set<string>();                    // the messages that are withdrawn answers' echoes (B1, H1)
    for (const list of this.#echoes.values()) for (const e of list) {
      if (e.messageId) { if (messages.some(m => m.id === e.messageId)) echoes.add(e.messageId); continue; }
      const m = messages.find(m => m.author.kind === "principal" && m.at >= e.after && m.text.trim() === e.line && !echoes.has(m.id));
      if (m) { e.messageId = m.id; echoes.add(m.id); }
    }
    for (const m of messages) {
      if (m.author.kind === "agent" && m.kind === "text") {
        const a = parseAnswer(m.text);
        if (a.buttons) buttons.set(a.buttons.id, { message: m, body: a.body, options: a.buttons.options });   // the latest wins
      } else if (m.author.kind === "principal") {
        const t = parseTap(m.text);
        if (t && !echoes.has(m.id)) taps.set(t.id, { key: t.key, label: t.label, at: m.at });   // not a withdrawn answer's echo (B1)
      }
    }
    // A tap the hub itself typed for one of its own answers — a sends row under this ask's answer keys for that choice,
    // in flight, in doubt or done — is that answer arriving in the pane, not an answer from elsewhere. Reported as a
    // sighting it would settle the ask as "elsewhere" naming no endpoint, and the answer's own recording, which names
    // the endpoint that accepted it, would be refused as a second answer (E8). So it is no sighting: the answer path
    // records it (review of PR #55). One row nothing can ever record — "started", with no store to ask a node about,
    // and no answer of this ask in flight here (the hub stopped while typing it, or the port threw after the paste and
    // no node can be asked) — would leave that tap as the ask's only record: it settles the ask, as it did before the
    // filter (round 2 of the PR #55 review).
    for (const [id, t] of taps) {
      const own = this.#store.answersOfAsk(`answer:${id}:`).find(r => r.key.endsWith(`:${choicePart({ kind: "option", key: t.key })}`));
      if (own && (this.#inFlight.has(id) || own.state === "done" || own.store !== null)) taps.delete(id);
    }
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
      out.push({ ask: shown, source, answered: taps.get(id) ?? null });
    }
    return out;
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
        answered: this.#paneTaps.get(b.id) ?? null,
      });
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
    if (!mayCommand(a.session, this.#now(), this.#policy())) return { ok: false, problem: "step_up", item: this.#view(id, a.endpoint.id) };
    if (choice.kind === "words" && choice.text.length > MAX_WORDS) return { ok: false, problem: "too_long", item: this.#view(id, a.endpoint.id) };
    if (choice.kind === "words" && !cleanText(choice.text)) return { ok: false, problem: "empty", item: this.#view(id, a.endpoint.id) };
    const now = this.#now();
    for (const [k, t] of this.#seen) if (now - t > REQUEST_TTL_MS) this.#seen.delete(k);
    const key = `${a.session.id}:${requestId}`;
    if (this.#seen.has(key)) return { ok: true, item: this.#view(id, a.endpoint.id) };
    if (this.#inFlight.has(id)) return { ok: false, problem: "in_progress", item: this.#view(id, a.endpoint.id) };
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
      const c = this.#x.check(id, choice, this.#now());
      if (!c.ok) return { ok: false, problem: c.error, item: this.#view(id, a.endpoint.id) };
      const e = c.value;
      if (seen !== undefined && seen !== this.#version(e)) return { ok: false, problem: "changed", item: this.#view(id, a.endpoint.id) };
      const option = choice.kind === "option" ? e.options.find(o => o.key === choice.key) : undefined;
      const line = option ? tapLine(e.id, option) : wordsLine(e.id, choice.kind === "words" ? choice.text : "");
      const words = choice.kind === "words" ? { length: choice.text.trim().length, digest: digest(choice.text) } : {};
      // The manager's answers go through its inbox (ADR-0010): queued now, delivered exactly once, recorded then.
      // The inbox switched off (`manager-inbox disable`) or not configured: typed directly, as before.
      // A manager that isn't running right now is fine: the inbox types it once it is back.
      let queued: { key: string; duplicate: boolean } | null = null;
      const k = answerKey(e.id, e, choice);
      if (e.asker.kind === "manager" && this.#inbox) {
        // The same in-doubt checks as the typed path, before anything is queued (E8, review #29.2): an earlier answer
        // this hub may have typed must block a second one, or the manager can be given both.
        const earlierSend = this.#store.send(k);
        if (earlierSend) {
          const settled = await this.#settleAnswer(a, id, choice, earlierSend, key);
          if (settled) return settled;
        }
        const other = await this.#otherAnswer(a, id, askPrefix(e.id, e), k);
        if (other) return other;
        try { queued = this.#inbox.enqueue({ id: `answer:${key}`, kind: option ? "tap" : "answer", text: line, meta: { escalation: e.id } }); }
        catch (err) { log.error(`answer to ${e.id}: the manager's inbox can't be written; typing directly`, err); }
      }
      if (queued) {
        if (queued.duplicate) {
          const st = this.#inbox?.state(queued.key) ?? null;
          if (st && (st.status === "cancelled" || st.status === "expired" || st.status === "gone")) {
            const pending = this.#queued.get(queued.key);
            if (pending) this.#giveUp(queued.key, pending);
            log.warn(`answer to ${e.id} not delivered: the same message is already ${st.status} in the manager's inbox`);
            return { ok: false, problem: "not_delivered", item: this.#view(id, a.endpoint.id) };
          }
          // delivered, lost or accepted: nothing new was typed. Queuing again would make the next poll mark that
          // fresh Decision delivered (review #29.5).
          if (st && (st.status === "delivered" || st.status === "lost" || st.status === "accepted")) {
            log.warn(`answer to ${e.id} not delivered: the same message is already ${st.status} in the manager's inbox`);
            return { ok: false, problem: "not_delivered", item: this.#view(id, a.endpoint.id) };
          }
        }
        const q = this.#x.queue(id, choice, { endpointId: a.endpoint.id, sessionId: a.session.id }, this.#now());
        if (!q.ok) {
          if (!queued.duplicate) { try { this.#inbox?.cancel(queued.key); } catch (err) { log.error(`answer to ${e.id}: the withdrawal can't be written`, err); } }
          return { ok: false, problem: q.error, item: this.#view(id, a.endpoint.id) };
        }
        this.#clearNotice(id);
        const dir = this.#inbox?.dir ?? null;
        const entry = this.#open({ escalationId: id, decision: q.value, words, dir, line, version: this.#version(e), sendKey: k });
        this.#queued.set(queued.key, entry);
        this.#store.savePending(queued.key, id, this.#pendingBody(entry));
        this.#store.saveDecision(id, q.value);
        // The same request after the seen window, or a restart, is a duplicate (review #29.4), as a typed answer's
        // done row is. Without the row, check() refuses it as already_answered.
        if (this.#store.startAnswer(k, now, { workerId: e.asker.workerId, request, session: a.session.id })) this.#store.finishQueued(k);
        this.#seen.set(key, now);
        log.info(`answer to ${e.id} queued for the manager${queued.duplicate ? " (already in its inbox)" : ""}`);
        this.#notify();
        return { ok: true, item: this.#view(id, a.endpoint.id) };
      }
      if (!e.asker.workerId) {
        const conflict = e.asker.kind === "manager" && this.#watch.workers().some(w => w.name === this.#managerName && w.conflict);
        return { ok: false, problem: conflict ? "lane_conflict" : "no_pane", item: this.#view(id, a.endpoint.id) };
      }
      // ... or of the same answer from another request. The inbox path ran these already (review #29.2).
      const inDoubt = this.#store.send(k);
      if (inDoubt) {
        const settled = await this.#settleAnswer(a, id, choice, inDoubt, key);
        if (settled) return settled;
      }
      // Then another answer to this ask, with another choice (E8: one Decision per ask; ADR-0012 7).
      const other = await this.#otherAnswer(a, id, askPrefix(e.id, e), k);
      if (other) return other;
      // Written before the first await, as a send's is: a hub that stops while this is typed leaves it "started".
      if (!this.#store.startAnswer(k, now, { workerId: e.asker.workerId, request, session: a.session.id })) return { ok: false, problem: "uncertain", item: this.#view(id, a.endpoint.id) };
      let outcome: SendOutcome;
      // A node that may have typed it (SendInDoubt): "uncertain", the hub's 409, never a 500 the app reads as a refusal
      // (final review I1), and kept for its repeat with the store it went to. Any other throw keeps its row too (below).
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
      }
      settleOutcome(this.#store, k, outcome);                           // a retry may type it; "not_submitted" keeps its row
      if (outcome.problem) {
        log.warn(`answer to ${e.id} not delivered: ${outcome.problem}`);
        return { ok: false, problem: outcome.problem, item: this.#view(id, a.endpoint.id) };
      }
      return this.#delivered(a, id, choice, key);
    } finally {
      this.#inFlight.delete(id);
    }
  }

  // An answer in doubt, settled with the node it went to (SteeringService's settle, on its row): typed there → delivered,
  // a duplicate at the node's time; null → the node never started it (its row is gone), so the answer is judged anew;
  // anything else → uncertain. A row already done was settled before: delivered.
  async #settleAnswer(a: Authenticated, id: string, choice: Choice, row: SendRow, key: string): Promise<AnswerResult | null> {
    if (row.state === "done") {
      this.#seen.set(key, this.#now());
      // Queued in the inbox, not typed: still queued. The enqueue time is not when it was delivered (round 2.7).
      if (row.outcome === "queued") return { ok: true, item: this.#view(id, a.endpoint.id), queued: true };
      return { ok: true, item: this.#view(id, a.endpoint.id), duplicate: true, at: row.typedAt ?? row.at };
    }
    const settled = row.workerId === null ? { ok: false as const, problem: "uncertain" as const } : await this.#settle(row.key, row.workerId);
    if (settled === null) return null;
    if (!settled.ok && settled.problem === "duplicate") return this.#delivered(a, id, choice, key, settled.at, this.#requesterOf(row) ?? undefined);
    log.warn(`answer to ${id} in doubt: its node can't say it never typed it; it stays uncertain`);
    return { ok: false, problem: "uncertain", item: this.#view(id, a.endpoint.id) };
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
        this.#typedEarlier(other, id, other.key.slice(prefix.length));
        return { ok: false, problem: "already_answered", item: this.#view(id, a.endpoint.id) };
      }
      log.warn(`answer to ${id} refused: another answer to it is in doubt (its node can't say it never typed it)`);
      return { ok: false, problem: "answer_in_doubt", item: this.#view(id, a.endpoint.id) };
    }
    return null;
  }

  // Who sent the answer a row in doubt holds (A1): the endpoint its request names ("<endpoint>:<request id>", a UUID,
  // no colon in it), and the session under it when this hub wrote the row down. Null when the row names no request.
  #requesterOf(row: SendRow): { endpointId: EndpointId; sessionId: SessionId | null } | null {
    const at = row.request?.indexOf(":") ?? -1;
    if (at <= 0) return null;
    return { endpointId: endpointId(row.request!.slice(0, at)), sessionId: row.requestSession === null ? null : sessionId(row.requestSession) };
  }

  // An answer found typed at the asker (an answer in doubt that its node had typed): his Decision (E8), once, as it was
  // decided: its option, labelled from the ask, or words, whose digest its key carries (their length isn't kept). The
  // row it was found under names whose answer it was, not whoever's repeat settled it (review of PR #55).
  #typedEarlier(row: SendRow, id: string, part: string) {
    const requester = this.#requesterOf(row);
    if (!requester) { log.warn(`answer to ${id} found typed but its row names no requester; not recorded`); return; }
    const e = this.#x.get(id);
    if (!e || e.status !== "open") return;
    const option = part.startsWith("option:") ? part.slice("option:".length) : null;
    const decided: DecidedChoice = option === null ? { kind: "words" } : { kind: "option", key: option, label: e.options.find(o => o.key === option)?.label ?? option };
    const r = this.#x.recordTyped(id, decided, requester, this.#now());
    if (!r.ok) { log.warn(`answer to ${id} found typed but not recorded: ${r.error}`); return; }
    const decision = this.#x.get(id)?.decision;
    if (decision) this.#store.saveDecision(id, decision);
    this.#clearNotice(id);
    this.#store.record([{ ...r.value, ...(option === null ? { digest: part.slice("words:".length) } : {}) }]);
    this.#notify();
  }

  // The answer arrived: recorded as his Decision (E8), once. `at`: a duplicate's time on the node that typed it. `by`
  // defaults to the caller; an answer in doubt that another endpoint's repeat settled is recorded for its row's own
  // requester — the endpoint whose answer it was — not whoever's repeat learnt it (review of PR #55).
  #delivered(a: Authenticated, id: string, choice: Choice, key: string, at?: number, by?: { endpointId: EndpointId; sessionId: SessionId | null }): AnswerResult {
    this.#clearNotice(id);
    this.#seen.set(key, this.#now());
    const r = this.#x.record(id, choice, by ?? { endpointId: a.endpoint.id, sessionId: a.session.id }, this.#now());
    if (r.ok) {
      const decision = this.#x.get(id)?.decision;
      if (decision) this.#store.saveDecision(id, decision);
      const words = choice.kind === "words" ? { length: choice.text.trim().length, digest: digest(choice.text) } : {};
      this.#store.record([{ ...r.value, ...words }]);
    } else {
      log.warn(`answer to ${id} delivered but not recorded: ${r.error}`);
    }
    this.#notify();
    return { ok: true, item: this.#view(id, a.endpoint.id), ...(at === undefined ? {} : { duplicate: true as const, at }) };
  }
}
