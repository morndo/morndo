// Lane events (fleet clients spec §7): what a lane did that its manager and its clients act on, built by the fleet per
// node and window from the hook stream:
//   finished      /hook/stop (not one the relay asked for a status line: statusAsked): status (the status line,
//                 lane-status.ts, on the answer's first line), firstLine, bg, crons;
//                 a WAITING line adds waitingOn and until (its `for`, else laneWatch.waitingMin: reliable lanes §3.1)
//   stale         made by the lane watch (lane-watch.ts), not by a hook: a turn past its deadline with nothing since
//   stop_failure  /hook/failure: error
//   needs_input   /lane (the node saw the session's status turn `waiting`): question
//   answered      /lane (it left `waiting`)
// Each hook body is read in either form (spec §6): Claude Code's own (last_assistant_message, background_tasks and
// session_crons as arrays, error_type) or the owner's scripts' (text, background and crons as counts, error). kira's
// rules are kept as they are (the chat bot's emit, firstLine, statusOf and onFailure, read 2026-10-08): the first non-blank
// line, trimmed, at most 200 characters; the status from it; an error at most 60 characters, "unknown" when none; a
// question at most 200. A hook without a window makes none (kira's `if (!win) return`), nor does the manager's own lane
// (laneEvents.deliverTo) or a lane whose name matches a glob of laneEvents.ignore.
// Inside the intake's synced commit (`take`, called for each hook above its stream's mark, so a replayed hook never
// makes a second event) each event is stored, waiting for the manager unless it is `answered` or no lane takes them
// (deliverTo null: never delivered later either, so turning delivery on sends only what comes after; reconciliation ruling
// 23). A `needs_input` for a session whose latest lane event is a `needs_input` (its node restarted and reports the same
// menu again) is dropped (ruling 18). Once that commit is on the disk (`committed`), each is published on /v1/events as `lane`, and the
// manager's batch is kicked. Kept LIMITS.laneEventKeepMs (7 days) by their time on the node, pruned on start and hourly.
// Hook fields: https://code.claude.com/docs/en/hooks (Stop: last_assistant_message, background_tasks [], session_crons [];
// StopFailure: error_type), read 2026-10-08.
import { LIMITS, firstLineOf as firstLine, statusLineOf, type HookEvent, type LaneEvent } from "@morndo/protocol";
import type { LaneEventsConfig } from "../config.ts";
import type { LaneEventDraft, LaneEventsStore } from "../adapters/lane-events-store.ts";
import type { Logger } from "../adapters/log.ts";
import type { EventHub } from "./events.ts";
import type { LaneWatch } from "./lane-watch.ts";

// The rule lane events have always read (kira.ts statusOf), now with WAITING: one parser for the node's relay and here.
export const firstLineOf = firstLine;
export const statusOf = (line: string): "done" | "blocked" | "needs_decision" | "waiting" | null => statusLineOf(line)?.status ?? null;
// A glob on a lane name: `*` any run of characters, `?` one; everything else as it is.
export const globMatcher = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "su");

export type LaneEventRules = { manager: string | null; ignore: RegExp[]; waitMs: number };
// `waitMs`: a WAITING line's lease when it names no `for` (laneWatch.waitingMin).
export const rulesOf = (c: LaneEventsConfig, waitMs: number = DEFAULT_WAIT_MS): LaneEventRules =>
  ({ manager: c.deliverTo, ignore: c.ignore.map(globMatcher), waitMs });
export const DEFAULT_WAIT_MS = 30 * 60_000;

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// A count from either form: Claude Code's arrays, the owner's numbers.
const countOf = (v: unknown): number => (Array.isArray(v) ? v.length : Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0);
// A text field: a string as it is, a number or a boolean written out, anything else none.
const textOf = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");

// The lane event a hook makes, or null.
export function laneEventOf(e: HookEvent, rules: LaneEventRules): LaneEventDraft | null {
  if (e.path !== "/hook/stop" && e.path !== "/hook/failure" && e.path !== "/lane") return null;
  const lane = e.window;
  if (lane === null || lane === "" || lane === rules.manager || rules.ignore.some(g => g.test(lane))) return null;
  const b = isObject(e.body) ? e.body : {};
  const sid = e.path === "/lane" ? b.sessionId : b.session_id;
  const base = { v: 1 as const, t: "lane" as const, node: e.node, window: e.window, lane, at: e.at, ...(typeof sid === "string" && SESSION_ID.test(sid) ? { sessionId: sid } : {}) };
  if (e.path === "/hook/stop") {
    // A Stop the node's relay asked to go on for its status line (reliable lanes §3.1): the turn didn't end there.
    if (b.statusAsked === true) return null;
    const first = firstLineOf(textOf(b.last_assistant_message ?? b.text).trim());
    const line = statusLineOf(first);
    const waiting = line?.status === "waiting" ? { ...(line.waitingOn ? { waitingOn: line.waitingOn } : {}), until: e.at + (line.forMs ?? rules.waitMs) } : {};
    return { ...base, event: "finished", status: line?.status ?? null, firstLine: first, bg: countOf(b.background_tasks ?? b.background), crons: countOf(b.session_crons ?? b.crons), ...waiting };
  }
  if (e.path === "/hook/failure") return { ...base, event: "stop_failure", error: textOf(b.error_type ?? b.error ?? "unknown").slice(0, 60) || "unknown" };
  if (b.event === "answered") return { ...base, event: "answered" };
  if (b.event === "needs_input") return { ...base, event: "needs_input", ...(typeof b.question === "string" ? { question: b.question.slice(0, 200) } : {}) };
  return null;
}

// One line of the manager's message, in today's shape (lane-events-push and kira's events.jsonl, key order included):
// { ts, lane, sessionId, event, … }, then status, firstLine, bg, crons for `finished` (and waitingOn, until for a wait),
// question or error for the others, and for `stale` its reason, waitingOn, since and stalls.
const iso = (ms: number | undefined): string | undefined => (ms === undefined ? undefined : new Date(ms).toISOString());
export function lineOf(e: LaneEvent): string {
  return JSON.stringify({
    ts: new Date(e.at).toISOString(), lane: e.lane, ...(e.sessionId === undefined ? {} : { sessionId: e.sessionId }), event: e.event,
    ...(e.event === "finished" ? { status: e.status ?? null, firstLine: e.firstLine ?? "", bg: e.bg ?? 0, crons: e.crons ?? 0 } : {}),
    ...(e.event === "finished" && e.status === "waiting" ? { ...(e.waitingOn === undefined ? {} : { waitingOn: e.waitingOn }), until: iso(e.until) } : {}),
    ...(e.event === "stale" ? { reason: e.reason, ...(e.waitingOn === undefined ? {} : { waitingOn: e.waitingOn }), since: iso(e.since), stalls: e.stalls ?? 1 } : {}),
    ...(e.question === undefined ? {} : { question: e.question }), ...(e.error === undefined ? {} : { error: e.error }),
  });
}

// A batch's parts (Review Focus 4): each the header and as many lines as fit in `max` characters, in order.
export function partsOf(events: LaneEvent[], header: string, max: number = LIMITS.maxSendText): { events: LaneEvent[]; text: string }[] {
  const parts: { events: LaneEvent[]; text: string }[] = [];
  let cur: { events: LaneEvent[]; text: string } | null = null;
  for (const e of events) {
    const line = lineOf(e);
    if (cur && cur.text.length + 1 + line.length <= max) { cur.events.push(e); cur.text += `\n${line}`; continue; }
    cur = { events: [e], text: `${header}\n${line}` };
    parts.push(cur);
  }
  return parts;
}

const PRUNE_EVERY_MS = 3_600_000;
export const SINCE_MAX = 1000;                           // GET /v1/lane-events: at most 1000 per answer

export class LaneEvents {
  #store: LaneEventsStore;
  #events: EventHub;
  #rules: LaneEventRules;
  #toManager: boolean;
  #onWaiting: () => void;
  #log: Logger;
  #now: () => number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #watch: Pick<LaneWatch, "saw" | "turn"> | null = null;

  constructor(p: {
    store: LaneEventsStore; events: EventHub; config: LaneEventsConfig; log: Logger; onWaiting?: () => void; now?: () => number; waitMs?: number;
  }) {
    this.#store = p.store;
    this.#events = p.events;
    this.#rules = rulesOf(p.config, p.waitMs);
    this.#toManager = p.config.deliverTo !== null;
    this.#onWaiting = p.onWaiting ?? (() => {});
    this.#log = p.log;
    this.#now = p.now ?? Date.now;
  }

  // Inside the intake's transaction: stores the lane event `e` makes, if any. `own`: the hook is the fleet's own (a
  // node's /lane), so it is never counted as unrouted.
  take(e: HookEvent): { event: LaneEvent | null; own: boolean } {
    const own = e.path === "/lane";
    this.#watch?.saw(e);
    const d = laneEventOf(e, this.#rules);
    if (!d) return { event: null, own };
    if (d.event === "needs_input" && d.sessionId !== undefined && this.#store.lastOf(d.sessionId) === "needs_input") return { event: null, own };
    return { event: this.#store.insert(d, this.#toManager && d.event !== "answered" ? 0 : null), own };
  }

  // After the commit that stored them.
  committed(fresh: LaneEvent[]): void {
    for (const le of fresh) { this.#watch?.turn(le); this.#events.emit({ t: "lane", node: le.node, body: le }); }
    if (this.#toManager && fresh.some(le => le.event !== "answered")) this.#onWaiting();
  }

  // The lane watch, told of every hook and every turn end (reliable lanes §3.2).
  watchWith(watch: Pick<LaneWatch, "saw" | "turn">): void { this.#watch = watch; }

  // An event the fleet makes itself (the watch's `stale`): stored and published like the others, waiting for the manager.
  raise(d: LaneEventDraft): LaneEvent {
    const le = this.#store.insert(d, this.#toManager ? 0 : null);
    this.committed([le]);
    return le;
  }

  // The turn ends and stale events since `after`, oldest first (the watch's rebuild).
  turnsSince(after: number): LaneEvent[] { return this.#store.turnsSince(after); }

  since(seq: number): LaneEvent[] { return this.#store.since(seq, SINCE_MAX); }

  start(): void {
    this.#prune();
    this.#timer = setInterval(() => this.#prune(), PRUNE_EVERY_MS);
  }

  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }

  prune(): number { return this.#store.prune(this.#now() - LIMITS.laneEventKeepMs); }

  #prune(): void {
    try { const n = this.prune(); if (n > 0) this.#log.info(`lane events: removed ${n} older than 7 days`); }
    catch (e) { this.#log.error("lane events: removing old ones failed (fleet.db busy or full?); trying again in an hour", e); }
  }
}
