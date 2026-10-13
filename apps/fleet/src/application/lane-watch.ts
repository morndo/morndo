// The lane watch (reliable lanes design §3.2): every lane's last turn end, and whether anything happened since. A turn
// that said WAITING, or ended with background work running or a wake-up scheduled, has until its lease; one that ended with no status
// line has laneWatch.noStatusMin; DONE, BLOCKED and NEEDS DECISION have no deadline (the orchestrator acts on them).
// Past its deadline with no hook from that lane since (progress, a session state change, a new turn), the watch makes one
// `stale` lane event for that turn, delivered to the orchestrator with the others, and, with laneWatch.nudge, one delivery
// to the lane itself saying what it was waiting on and the line to end with. `stalls` counts the stale events since the
// lane last ended DONE, BLOCKED or NEEDS DECISION; from the third on, the lane is for the orchestrator to re-plan, so it is
// not nudged again (Magentic-One's stall counter: arXiv 2411.04468). Only lanes that make lane events are watched (not the
// orchestrator's own, not ignored ones), and a lane whose window is gone is dropped. A lane whose node is not online is
// left as it is until the node is back: its silence is the node's, which has its own status.
// The watch lives in memory. At start it is rebuilt from the stored lane events of the last day; a restart counts as
// activity, so a lane's deadline runs again from the restart and nothing is called stale for what the fleet did not see.
import type { HookEvent, LaneEvent, LaneWatchEntry, TurnStatus } from "@morndo/protocol";
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

type Turn = {
  node: string; window: string; sessionId?: string;
  at: number;                      // the turn's end
  status: TurnStatus | null;
  base: number;                    // activity counts after this (the turn's end, or the fleet's start)
  active: number;                  // the latest hook seen from this lane
  deadline: number | null;
  reason: "waiting" | "no_status";
  waitingOn?: string;
  reported: boolean;               // its stale event is made
  stalls: number;
};

const keyOf = (node: string, window: string) => `${node}\u0000${window}`;
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

export class LaneWatch {
  #turns = new Map<string, Turn>();
  #config: LaneWatchConfig;
  #raise: (d: LaneEventDraft) => LaneEvent | null;
  #nudge: ((r: DeliveryRequest) => Promise<unknown>) | null;
  #alive: (node: string, window: string) => boolean;
  #online: (node: string) => boolean;
  #log: Logger;
  #now: () => number;
  #sweepMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(p: {
    config: LaneWatchConfig; raise: (d: LaneEventDraft) => LaneEvent | null; nudge?: (r: DeliveryRequest) => Promise<unknown>;
    alive: (node: string, window: string) => boolean; online?: (node: string) => boolean; log: Logger; now?: () => number; sweepMs?: number;
  }) {
    this.#config = p.config;
    this.#raise = p.raise;
    this.#nudge = p.nudge ?? null;
    this.#alive = p.alive;
    this.#online = p.online ?? (() => true);
    this.#log = p.log;
    this.#now = p.now ?? Date.now;
    this.#sweepMs = p.sweepMs ?? SWEEP_MS;
  }

  // Any hook from a lane: activity after its last turn end.
  saw(e: HookEvent): void {
    if (e.window === null) return;
    const t = this.#turns.get(keyOf(e.node, e.window));
    if (t && e.at > t.active) t.active = e.at;
  }

  // A lane's turn ended: its `finished` lane event, as stored.
  turn(le: LaneEvent): void {
    if (le.event !== "finished" || le.window === null) return;
    const key = keyOf(le.node, le.window);
    const before = this.#turns.get(key);
    const settled = le.status === "done" || le.status === "blocked" || le.status === "needs_decision";
    const bg = (le.bg ?? 0) > 0 || (le.crons ?? 0) > 0;
    const waiting = le.status === "waiting" || (!le.status && bg);
    const deadline = settled ? null
      : le.status === "waiting" ? (le.until ?? le.at + this.#config.waitingMin * 60_000)
      : le.at + (bg ? this.#config.waitingMin : this.#config.noStatusMin) * 60_000;
    this.#turns.set(key, {
      node: le.node, window: le.window, ...(le.sessionId === undefined ? {} : { sessionId: le.sessionId }),
      at: le.at, status: le.status ?? null, base: le.at, active: le.at, deadline, reason: waiting ? "waiting" : "no_status",
      ...(le.waitingOn === undefined ? (bg && !le.status ? { waitingOn: (le.bg ?? 0) > 0 ? "background work" : "a scheduled wake-up" } : {}) : { waitingOn: le.waitingOn }),
      reported: false, stalls: settled ? 0 : (before?.stalls ?? 0),
    });
  }

  // A stale event of a turn, as stored: that turn has been reported (a rebuild reads them back).
  staled(le: LaneEvent): void {
    if (le.event !== "stale" || le.window === null) return;
    const t = this.#turns.get(keyOf(le.node, le.window));
    if (t && le.since === t.at) { t.reported = true; t.stalls = Math.max(t.stalls, le.stalls ?? 1); }
  }

  // At start: the stored turns and stale events, in order; the restart is the new base for every deadline.
  rebuild(events: LaneEvent[]): void {
    for (const le of events) { if (le.event === "finished") this.turn(le); else if (le.event === "stale") this.staled(le); }
    const now = this.#now();
    for (const t of this.#turns.values()) {
      if (t.deadline !== null) t.deadline = now + Math.max(0, t.deadline - t.at);
      t.base = now;
      t.active = now;
    }
  }

  // The lanes past their deadline with nothing since: one stale event each, and a nudge while it is worth one. A turn a
  // day old that is settled or reported is let go, as a rebuild would not read it.
  sweep(): void {
    const now = this.#now();
    for (const [key, t] of this.#turns) {
      if ((t.deadline === null || t.reported) && now - t.at > REBUILD_WINDOW_MS) { this.#turns.delete(key); continue; }
      if (t.deadline === null || t.reported || t.active > t.base || now < t.deadline || !this.#online(t.node)) continue;
      if (!this.#alive(t.node, t.window)) { this.#turns.delete(key); continue; }
      t.reported = true;
      t.stalls += 1;
      let made: LaneEvent | null = null;
      try {
        made = this.#raise({
          v: 1, t: "lane", event: "stale", node: t.node, window: t.window, lane: t.window, at: now,
          ...(t.sessionId === undefined ? {} : { sessionId: t.sessionId }), reason: t.reason,
          ...(t.waitingOn === undefined ? {} : { waitingOn: t.waitingOn }), since: t.at, stalls: t.stalls,
        });
      } catch (e) { this.#log.error(`lane watch: the stale event of ${t.window} on ${t.node} could not be stored (fleet.db busy?)`, e); }
      if (!made || !this.#config.nudge || !this.#nudge || t.stalls > NUDGE_MAX_STALLS) continue;
      this.#nudge({ id: `fleet:nudge:${t.node}:${t.at}`, lane: t.window, text: nudgeText(t, now), ttlMs: NUDGE_TTL_MS })
        .catch((e: unknown) => this.#log.warn(`lane watch: nudging ${t.window} on ${t.node} failed`, e));
    }
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
