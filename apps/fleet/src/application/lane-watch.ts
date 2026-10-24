// The lane watch (reliable lanes design §3.2): every lane's last turn end, and whether anything happened since. A turn
// that said WAITING, or ended with background work running or a wake-up scheduled, has until its lease; one that ended with no status
// line has laneWatch.noStatusMin; DONE, BLOCKED and NEEDS DECISION have no deadline (the orchestrator acts on them).
// Past its deadline with no hook from that lane since (progress, a session state change, a new turn), the watch makes one
// `stale` lane event for that turn, delivered to the orchestrator with the others, and, with laneWatch.nudge, one delivery
// to the lane itself saying what it was waiting on and the line to end with. `stalls` counts the stale events since the
// lane last ended DONE, BLOCKED or NEEDS DECISION; from the third on, the lane is for the orchestrator to re-plan, so it is
// not nudged again (Magentic-One's stall counter: arXiv 2411.04468). Only a lane running the agent CLI is nudged: a
// delivery is typed only into a live session of it (FL18), so one to any other lane would wait for nothing. The nudge
// goes to that session's pane by its worker ID, never by the lane's name, which another node's window may share (a
// pane's ID is "unique and unchanged for the life of the … pane", tmux(1), read 2026-10-13); its id names that pane and
// the turn, so no two lanes' nudges share one. Only lanes that make lane events are watched (not the orchestrator's own,
// not ignored ones), and a lane whose window is gone is dropped. A lane whose node is not online is left as it is until
// the node is back: its silence is the node's, which has its own status.
// A session the watch saw go from idle to working, and then to idle, ended a turn. When no turn end for that window
// reached the fleet within 5 min of it going idle (LOST_TURN_GRACE_MS, with LOST_TURN_SKEW_MS of slack for the node's
// inventory poll and transit), the watch makes one `stale` event with reason `no_turn_end` and sends no nudge. A user
// interrupt (Esc) also ends a turn with no Stop hook and is flagged the same way; typing into that lane would restart
// work the owner stopped, so the orchestrator decides. Turn ends are compared by when the fleet took them, not by the
// node's clock, so a node with a wrong clock does not make short turns look lost; a turn end replayed late after an
// outage counts as received then.
// A lane first seen already working is not judged (after a restart a hook may be replayed with an older time), nor is
// one that never made a turn end the fleet knows of; a failed turn (/hook/failure) is a turn end. The orchestrator's
// own lane and ignored windows are left out.
// Activity is judged by each hook's own time on its node ("the time that each individual event occurred on its producing
// device": https://nightlies.apache.org/flink/flink-docs-stable/docs/concepts/time/, read 2026-10-13), not by when the
// fleet takes it: a hook in the same intake batch as the Stop before it, or one a node sends on after an outage, counts.
// The watch lives in memory. At start it is rebuilt from the stored lane events of the last day (turn ends, stale events,
// and the session state changes and failed turns after them); a restart counts as activity, so a lane's deadline runs
// again from the restart and nothing is called stale for what the fleet did not see.
// It also keeps what a Run needs of each window (ADR-0032; domain run.ts RunFacts), read by the fleet's Runs (runs.ts)
// through runOf, apart from the turns above so their stale events and nudges stay as they are: the last turn end (its
// time, status, first line, pending tasks and wake-ups, what a wait names and until when), the first and the latest
// activity after it by the same rule (not /sl, not the idle notice; before any turn end, since the fleet started), and a
// needs_input after it with no answered since. Every window is kept, the manager's own and ignored ones too, whose Stops
// make no lane event: LaneEvents hands their turn ends to runTurn, in memory only, so after a restart such a window's Run
// rests on its session state until its next Stop. A restart is not activity here: a Run's overdue is deriveRun's, from
// the turn's own lease. A window's entry goes a day after its last sign once its window is gone.
import { pendingOf, type TurnEnd } from "@morndo/domain";
import type { HookEvent, LaneEvent, LaneWatchEntry, Pane, TurnStatus } from "@morndo/protocol";
import type { LaneEventDraft } from "../adapters/lane-events-store.ts";
import type { Logger } from "../adapters/log.ts";
import type { DeliveryRequest } from "./deliveries.ts";

export type LaneWatchConfig = { waitingMin: number; noStatusMin: number; nudge: boolean };
export const DEFAULT_LANE_WATCH: LaneWatchConfig = { waitingMin: 30, noStatusMin: 15, nudge: true };
export const SWEEP_MS = 60_000;
export const REBUILD_WINDOW_MS = 86_400_000;
export const NUDGE_TTL_MS = 6 * 3_600_000;
// The stale events a lane is nudged for; past these it is the orchestrator's to re-plan.
export const NUDGE_MAX_STALLS = 2;
// How long a session may sit idle before a missing turn end is lost, and the slack for the node's inventory poll (2 s)
// and transit. Both sides of the comparison are the fleet's clock, so this is not slack for the node's clock.
export const LOST_TURN_GRACE_MS = 5 * 60_000;
export const LOST_TURN_SKEW_MS = 10_000;
// What the fleet answered a nudge (Deliveries.post): a refusal is logged, never dropped unseen.
export type NudgeAnswer = { ok: true } | { ok: false; error: { code: string } };

type Turn = {
  node: string; window: string; sessionId?: string;
  at: number;                      // the turn's end, by the node's clock
  status: TurnStatus | null;
  active: number;                  // the latest hook from this lane, by the node's clock: activity once later than `at`
  deadline: number | null;         // from the turn's end, by the node's clock (ADR-0027); after a rebuild, from the restart
  reason: "waiting" | "no_status";
  waitingOn?: string;
  reported: boolean;               // its stale event is stored
  stalls: number;
};

// A session the inventory has shown, by window. `working` is busy or waiting. `busySince` stays null until the watch
// sees the session leave idle: a first sighting already working is not a start. `idleSince` is when that work went idle.
type OpenSession = {
  sessionId: string;
  busySince: number | null;
  idleSince: number | null;
  reported: boolean;
  working: boolean;
};

// What a Run reads of a window (RunFacts' turn, activity and needsInput), and the session its last turn end named.
export type RunTrack = {
  turn: TurnEnd | null; sessionId?: string;
  activity: { first: number; last: number } | null;
  needsInput: { at: number; question?: string } | null;
};
type Track = RunTrack & {
  recent: number[];                // the latest activity times as they came: a hook the fleet took before its turn end
  seenAt: number;                  // the latest sign of this window, by the node's clock
  receivedAt: number;              // the fleet's clock when the latest turn end was taken
};
// The activity times kept per window for a turn end told after them (one intake batch: hooks after the Stop are seen
// first, the turn on commit). A batch holds far fewer of one lane's hooks than this.
const RECENT_MAX = 32;

const keyOf = (node: string, window: string) => `${node}\u0000${window}`;
// A turn end as a Run reads it, from its `finished` lane event. One stored before turn ends kept their lists (only counts)
// gets one placeholder per count, as the owner's scripts' counts do (pendingOf), so its pending work still shows (R2).
export const turnEndOf = (le: LaneEvent): TurnEnd => {
  const pending = le.tasks === undefined && le.wakes === undefined ? pendingOf(le.bg ?? 0, le.crons ?? 0, s => s) : { tasks: le.tasks ?? [], wakes: le.wakes ?? [] };
  return {
    at: le.at, status: le.status ?? null, line: le.firstLine ?? "", tasks: pending.tasks, wakes: pending.wakes,
    waitingOn: le.waitingOn ?? null, until: le.until ?? null,
  };
};
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
// Claude Code's idle notice comes "about 60 seconds after Claude finishes responding, and only if you haven't typed since"
// (https://code.claude.com/docs/en/hooks, Notification, read 2026-10-13): it says nothing happened, so it is no activity.
const idleNotice = (body: unknown): boolean => {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return b.hook_event_name === "Notification" && b.notification_type === "idle_prompt";
};

export class LaneWatch {
  #turns = new Map<string, Turn>();
  #tracks = new Map<string, Track>();    // every window's Run facts (runOf), the manager's and ignored ones too
  #seen = new Map<string, number>();     // each lane's latest hook, turn or not: the fleet may take it before the Stop it follows
  #open = new Map<string, OpenSession>(); // each watched window's session, from the node's inventory
  #failed = new Map<string, number>();   // a /hook/failure, by the fleet's clock when it was taken: a turn that ended on an API error, with no Stop hook
  #lostStalls = new Map<string, number>(); // stale events for lost turn ends, since the lane last settled
  #config: LaneWatchConfig;
  #raise: (d: LaneEventDraft) => LaneEvent | null;
  #nudge: ((r: DeliveryRequest) => Promise<NudgeAnswer>) | null;
  #alive: (node: string, window: string) => boolean;
  #online: (node: string) => boolean;
  #nudgeTarget: (node: string, window: string) => string | null;
  #log: Logger;
  #now: () => number;
  #sweepMs: number;
  #lostTurnMs: number;
  #watched: (window: string) => boolean;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(p: {
    config: LaneWatchConfig; raise: (d: LaneEventDraft) => LaneEvent | null; nudge?: (r: DeliveryRequest) => Promise<NudgeAnswer>;
    alive: (node: string, window: string) => boolean; online?: (node: string) => boolean;
    nudgeTarget?: (node: string, window: string) => string | null; log: Logger; now?: () => number; sweepMs?: number;
    lostTurnMs?: number; watched?: (window: string) => boolean;
  }) {
    this.#config = p.config;
    this.#raise = p.raise;
    this.#nudge = p.nudge ?? null;
    this.#alive = p.alive;
    this.#online = p.online ?? (() => true);
    this.#nudgeTarget = p.nudgeTarget ?? (() => null);
    this.#log = p.log;
    this.#now = p.now ?? Date.now;
    this.#sweepMs = p.sweepMs ?? SWEEP_MS;
    this.#lostTurnMs = p.lostTurnMs ?? LOST_TURN_GRACE_MS;
    this.#watched = p.watched ?? (() => true);
  }

  // A hook from a lane: activity once it is later than the lane's last turn end, whichever of the two the fleet took
  // first. Not the status line's: Claude Code re-runs it on a timer when `refreshInterval` is set, idle or not
  // (https://code.claude.com/docs/en/statusline, read 2026-10-13), so it says nothing about the lane doing anything. Nor
  // Claude Code's idle notice (idleNotice).
  // For a Run, a node's /lane event also says the session asked something (needs_input) or was answered.
  saw(e: HookEvent): void {
    if (e.window === null || e.path === "/sl" || idleNotice(e.body)) return;
    const key = keyOf(e.node, e.window);
    if (e.path === "/hook/failure") this.#failed.set(key, this.#now());
    this.#mark(key, e.at);
    this.#active(key, e.at);
    if (e.path !== "/lane" || typeof e.body !== "object" || e.body === null) return;
    const b = e.body as Record<string, unknown>;
    if (b.event === "needs_input") this.#asked(key, e.at, typeof b.question === "string" ? b.question.slice(0, 200) : undefined);
    else if (b.event === "answered") this.#answered(key, e.at);
  }

  // A lane's turn ended: its `finished` lane event, as stored. A hook already seen from after its end is activity.
  turn(le: LaneEvent): void {
    if (le.event !== "finished" || le.window === null) return;
    const key = keyOf(le.node, le.window);
    this.#ended(key, le);
    const before = this.#turns.get(key);
    const settled = le.status === "done" || le.status === "blocked" || le.status === "needs_decision";
    if (settled) this.#lostStalls.delete(key);
    const bg = (le.bg ?? 0) > 0 || (le.crons ?? 0) > 0;
    const waiting = le.status === "waiting" || (!le.status && bg);
    const deadline = settled ? null
      : le.status === "waiting" ? (le.until ?? le.at + this.#config.waitingMin * 60_000)
      : le.at + (bg ? this.#config.waitingMin : this.#config.noStatusMin) * 60_000;
    this.#turns.set(key, {
      node: le.node, window: le.window, ...(le.sessionId === undefined ? {} : { sessionId: le.sessionId }),
      at: le.at, status: le.status ?? null, active: Math.max(le.at, this.#seen.get(key) ?? le.at), deadline, reason: waiting ? "waiting" : "no_status",
      ...(le.waitingOn === undefined ? (bg && !le.status ? { waitingOn: (le.bg ?? 0) > 0 ? "background work" : "a scheduled wake-up" } : {}) : { waitingOn: le.waitingOn }),
      reported: false, stalls: settled ? 0 : (before?.stalls ?? 0),
    });
  }

  // A turn end that only a Run reads: the Stop of a window that makes no lane event (the manager's own, an ignored one),
  // as laneEventOf would read it. It is not watched for stale (reliable lanes §3.2: those lanes are not watched).
  runTurn(d: Omit<LaneEvent, "seq">): void {
    if (d.event !== "finished" || d.window === null) return;
    this.#ended(keyOf(d.node, d.window), { ...d, seq: 0 });
  }

  // What a Run reads of a window now (RunFacts' turn, activity, needsInput), or null when the watch saw nothing of it.
  runOf(node: string, window: string): RunTrack | null {
    const t = this.#tracks.get(keyOf(node, window));
    if (!t) return null;
    return {
      turn: t.turn, ...(t.sessionId === undefined ? {} : { sessionId: t.sessionId }),
      activity: t.activity ? { ...t.activity } : null, needsInput: t.needsInput ? { ...t.needsInput } : null,
    };
  }

  // A stale event of a turn, as stored: that turn has been reported (a rebuild reads them back).
  staled(le: LaneEvent): void {
    if (le.event !== "stale" || le.window === null) return;
    const t = this.#turns.get(keyOf(le.node, le.window));
    if (t && le.since === t.at) { t.reported = true; t.stalls = Math.max(t.stalls, le.stalls ?? 1); }
  }

  // At start: the stored turn ends and stale events, and the session state changes and failed turns after them
  // (activity, as they were live), in order. The restart runs each deadline again in full; activity stays judged by each
  // hook's own time, so one a node sends on from the outage still counts.
  rebuild(events: LaneEvent[]): void {
    for (const le of events) {
      if (le.event === "finished") this.turn(le);
      else if (le.event === "stale") this.staled(le);
      else if (le.window !== null) {
        const key = keyOf(le.node, le.window);
        this.#mark(key, le.at);
        this.#active(key, le.at);
        if (le.event === "needs_input") this.#asked(key, le.at, le.question);
        else if (le.event === "answered") this.#answered(key, le.at);
      }
    }
    const now = this.#now();
    for (const t of this.#turns.values()) if (t.deadline !== null) t.deadline = now + Math.max(0, t.deadline - t.at);
  }

  // The lanes past their deadline with nothing since: one stale event each, and a nudge while it is worth one. A turn a
  // day old that is settled or reported is let go, as a rebuild would not read it; so is a day-old hook with no turn.
  sweep(): void {
    const now = this.#now();
    for (const [key, at] of this.#seen) if (now - at > REBUILD_WINDOW_MS && !this.#turns.has(key)) this.#seen.delete(key);
    for (const [key, t] of this.#tracks) {
      if (now - t.seenAt <= REBUILD_WINDOW_MS) continue;
      const [node = "", window = ""] = key.split("\u0000");
      if (!this.#alive(node, window)) this.#tracks.delete(key);
    }
    for (const [key, t] of this.#turns) {
      if ((t.deadline === null || t.reported) && now - t.at > REBUILD_WINDOW_MS) { this.#turns.delete(key); continue; }
      if (t.deadline === null || t.reported || t.active > t.at || now < t.deadline || !this.#online(t.node)) continue;
      if (!this.#alive(t.node, t.window)) { this.#turns.delete(key); continue; }
      const stalls = t.stalls + 1;
      let made: LaneEvent | null;
      try {
        made = this.#raise({
          v: 1, t: "lane", event: "stale", node: t.node, window: t.window, lane: t.window, at: now,
          ...(t.sessionId === undefined ? {} : { sessionId: t.sessionId }), reason: t.reason,
          ...(t.waitingOn === undefined ? {} : { waitingOn: t.waitingOn }), since: t.at, stalls,
        });
      } catch (e) {
        // Not stored, so not reported: the next sweep tries again. SQLITE_BUSY is another connection's transaction, which
        // ends ("Process B will need to wait for process A to finish its transaction": https://www.sqlite.org/rescode.html,
        // read 2026-10-13).
        this.#log.error(`lane watch: the stale event of ${t.window} on ${t.node} could not be stored (fleet.db busy?); trying again next sweep`, e);
        continue;
      }
      t.reported = true;
      t.stalls = stalls;
      if (made) this.#nudgeLane(t.node, t.window, t.stalls, t.at, nudgeText(t, now));
    }
    this.#sweepOpen(now);
  }

  // One node's inventory. A window left out, split across panes, or without a session is dropped; so is one this
  // inventory no longer lists. busy and waiting are working, idle is idle, and shell or no status drops the window.
  panes(node: string, panes: readonly Pick<Pane, "window" | "sessionId" | "status">[]): void {
    const byWindow = new Map<string, (typeof panes)[number][]>();
    for (const p of panes) {
      const list = byWindow.get(p.window);
      if (list) list.push(p);
      else byWindow.set(p.window, [p]);
    }
    const seen = new Set<string>();
    for (const [window, group] of byWindow) {
      const key = keyOf(node, window);
      seen.add(key);
      const pane = group[0];
      if (!this.#watched(window) || group.length !== 1 || pane === undefined || pane.sessionId === undefined || pane.status === null || pane.status === "shell") {
        this.#open.delete(key);
        continue;
      }
      this.#seenSession(key, pane.sessionId, pane.status === "busy" || pane.status === "waiting");
    }
    const prefix = `${node}\u0000`;
    for (const key of this.#open.keys()) if (key.startsWith(prefix) && !seen.has(key)) this.#open.delete(key);
  }

  // A session goes idle to working only once the watch has seen it idle: the first sighting, already working, records
  // no start. Working to idle, after a start, notes when the turn went quiet.
  #seenSession(key: string, sessionId: string, working: boolean): void {
    const prev = this.#open.get(key);
    if (!prev || prev.sessionId !== sessionId) {
      this.#open.set(key, { sessionId, busySince: null, idleSince: null, reported: false, working });
      return;
    }
    if (working === prev.working) return;
    if (working) {
      prev.busySince = this.#now();
      prev.idleSince = null;
      prev.reported = false;
      prev.working = true;
      return;
    }
    if (prev.busySince !== null) prev.idleSince = this.#now();
    prev.working = false;
  }

  // Sessions that went idle with no turn end covering the busy start, compared by when the fleet took that end.
  // A window with no turn end at all is not judged (an engine lane never ran a Stop hook). A store failure is tried
  // again next sweep. A lost turn end is flagged and not nudged.
  #sweepOpen(now: number): void {
    for (const key of this.#lostStalls.keys()) {
      const [node = "", window = ""] = key.split("\u0000");
      if (!this.#alive(node, window)) this.#lostStalls.delete(key);
    }
    for (const [key, s] of this.#open) {
      if (s.busySince === null || s.idleSince === null || s.reported) continue;
      if (!(now >= s.idleSince + this.#lostTurnMs)) continue;
      const [node = "", window = ""] = key.split("\u0000");
      if (!this.#online(node)) continue;
      if (!this.#alive(node, window)) { this.#open.delete(key); this.#lostStalls.delete(key); continue; }
      const track = this.#tracks.get(key);
      const failedAt = this.#failed.get(key);
      const covered = track !== undefined && track.turn !== null && track.receivedAt >= s.busySince - LOST_TURN_SKEW_MS;
      const failed = failedAt !== undefined && failedAt >= s.busySince - LOST_TURN_SKEW_MS;
      if (covered || failed || track === undefined || track.turn === null) {
        s.reported = true;
        continue;
      }
      const stalls = (this.#lostStalls.get(key) ?? 0) + 1;
      try {
        this.#raise({
          v: 1, t: "lane", event: "stale", node, window, lane: window, at: now,
          sessionId: s.sessionId, reason: "no_turn_end", since: s.idleSince, stalls,
        });
      } catch (e) {
        this.#log.error(`lane watch: the stale event of ${window} on ${node} could not be stored (fleet.db busy?); trying again next sweep`, e);
        continue;
      }
      this.#lostStalls.set(key, stalls);
      s.reported = true;
    }
  }

  // One nudge to the lane's own pane, while stalls is still worth one. A refusal is logged, never dropped unseen.
  #nudgeLane(node: string, window: string, stalls: number, at: number, text: string): void {
    if (!this.#config.nudge || !this.#nudge || stalls > NUDGE_MAX_STALLS) return;
    const workerId = this.#nudgeTarget(node, window);
    if (workerId === null) return;
    this.#nudge({ id: `fleet:nudge:${workerId}:${at}`, workerId, text, ttlMs: NUDGE_TTL_MS }).then(
      a => { if (!a.ok) this.#log.warn(`lane watch: nudging ${window} on ${node} was refused (${a.error.code})`); },
      (e: unknown) => this.#log.warn(`lane watch: nudging ${window} on ${node} failed`, e),
    );
  }

  // What the watch holds now, for the brief (GET /v1/lane-watch): each lane's last turn, oldest first.
  view(): LaneWatchEntry[] {
    return [...this.#turns.values()].sort((a, b) => a.at - b.at).map(t => ({
      node: t.node, window: t.window, at: t.at, status: t.status, deadline: t.deadline,
      ...(t.deadline === null ? {} : { reason: t.reason }), ...(t.waitingOn === undefined ? {} : { waitingOn: t.waitingOn }),
      stale: t.reported, stalls: t.stalls,
    }));
  }

  start(): void { this.#timer = setInterval(() => this.sweep(), this.#sweepMs); }
  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }

  // A lane's hook at `at` (its node's clock): the latest one is kept, and its turn, if any, is active from then.
  #mark(key: string, at: number): void {
    if (at > (this.#seen.get(key) ?? Number.NEGATIVE_INFINITY)) this.#seen.set(key, at);
    const t = this.#turns.get(key);
    if (t && at > t.active) t.active = at;
  }

  #track(key: string): Track {
    let t = this.#tracks.get(key);
    if (!t) {
      t = { turn: null, activity: null, needsInput: null, recent: [], seenAt: Number.NEGATIVE_INFINITY, receivedAt: Number.NEGATIVE_INFINITY };
      this.#tracks.set(key, t);
    }
    return t;
  }

  // Activity for a Run: after the window's last turn end by the node's clock, or any before its first.
  #active(key: string, at: number): void {
    const t = this.#track(key);
    t.seenAt = Math.max(t.seenAt, at);
    t.recent.push(at);
    if (t.recent.length > RECENT_MAX) t.recent.shift();
    if (t.turn !== null && at <= t.turn.at) return;
    t.activity = t.activity ? { first: Math.min(t.activity.first, at), last: Math.max(t.activity.last, at) } : { first: at, last: at };
  }

  #asked(key: string, at: number, question: string | undefined): void {
    const t = this.#track(key);
    if (t.turn !== null && at <= t.turn.at) return;
    if (t.needsInput && t.needsInput.at > at) return;
    t.needsInput = { at, ...(question === undefined || question === "" ? {} : { question }) };
  }

  #answered(key: string, at: number): void {
    const t = this.#track(key);
    if (t.needsInput && at >= t.needsInput.at) t.needsInput = null;
  }

  // A window's turn ended (its lane event, or a Stop only a Run reads): what came after it stays its activity, what came
  // before goes. A turn end older than the one held is not taken.
  #ended(key: string, le: LaneEvent): void {
    const t = this.#track(key);
    if (t.turn !== null && le.at < t.turn.at) return;
    t.receivedAt = this.#now();
    const end = turnEndOf(le);
    t.turn = end;
    t.seenAt = Math.max(t.seenAt, le.at);
    if (le.sessionId === undefined) delete t.sessionId; else t.sessionId = le.sessionId;
    const after = t.recent.filter(x => x > end.at);
    const last = t.activity && t.activity.last > end.at ? t.activity.last : null;
    t.activity = after.length > 0 ? { first: Math.min(...after), last: Math.max(last ?? Number.NEGATIVE_INFINITY, ...after) }
      : last !== null ? { first: last, last } : null;
    if (t.needsInput && t.needsInput.at <= end.at) t.needsInput = null;
  }
}

// What the lane reads: when its turn ended and on what it waited, that nothing came since, and the line to end with.
export function nudgeText(t: { at: number; reason: "waiting" | "no_status"; waitingOn?: string }, now: number): string {
  const ago = minutes(now - t.at);
  const how = t.reason === "no_status"
    ? `Your last turn ended ${ago} min ago without a status line, and nothing has happened in this lane since.`
    : `Your last turn ended ${ago} min ago waiting${t.waitingOn ? ` on ${t.waitingOn}` : ""}, and nothing has happened in this lane since.`;
  return `[fleet] ${how} Check where it stands now and carry on if you can. Then start your answer with one line: `
    + "STATUS: DONE, STATUS: BLOCKED, STATUS: NEEDS DECISION, or STATUS: WAITING <on what> for <N> min.";
}
