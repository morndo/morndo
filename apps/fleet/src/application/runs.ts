// Runs (ADR-0032; docs/design/agent-board/README.md §3, §6; domain run.ts): what each lane is doing now, derived by the
// domain's deriveRun from what the fleet observed, never from the board (R1). One Run per window the fleet knows on a
// registered node: the windows of each node's latest inventory, the manager's included, and, for a node that has not
// reported since the fleet started, the lane registry's names it owns. A window and a node are its key, so two nodes'
// windows of one name are two Runs (a lane-name conflict); a window's several panes are one. Its facts (RunFacts):
//   nodeOnline   the node is online and has sent an inventory since it came online. Until then its last inventory may
//                be out of date, and a window missing from it is not known to be gone: R5 says unknown, never gone on a guess.
//   windowAlive  the window is in that node's latest inventory
//   session      the session state of the window's panes (the node's session registry), the most active of them first:
//                waiting, busy, shell, idle; null with no session
//   turn, activity, needsInput   the lane watch's (runOf: the last turn end, the hooks after it, a menu still open)
//   jobs         the jobs not ended (queued, starting or running: each will wake the lane) of that lane, or whose
//                notice goes to lane:<window> on the node that lane is on (the job mirror's own rule: the registry's
//                owner, else the job's node), as the node's relay counts them for W1; each from when it started, or, still
//                queued, from when it was queued
//   waitMs       laneWatch.waitingMin; tzOffsetMin: the node's latest health's, else null (no fire time)
//   changedAt    when the window came or went, or its node's status changed, in memory; after a restart, the restart
// GET /v1/runs serves them by lane; a `run` event { t: "run", node, body: RunView } goes out on /v1/events whenever one
// changes (its JSON differs from the last one sent), never for a recompute that changes nothing. Recomputed after every
// intake commit (a hook is activity), every inventory, health, node status, job and lane event, coalesced into one pass
// per turn of the event loop, and on a sweep every minute: overdue and ACTIVE_MS turn with time alone. A gone window
// stays `gone` for a day, then drops; a revoked node's Runs drop at once. Neither drop is an event: a client lets a
// `gone` Run go the same way.
import { deriveRun, type LaneSessionState, type Run, type RunFacts } from "@morndo/domain";
import type { JobView, Pane, RunView } from "@morndo/protocol";
import type { Logger } from "../adapters/log.ts";
import type { Connections } from "./connections.ts";
import type { EventHub } from "./events.ts";
import type { JobMirror } from "./job-mirror.ts";
import type { LaneRegistry } from "./lane-registry.ts";
import type { LaneWatch } from "./lane-watch.ts";

export const RUNS_SWEEP_MS = 60_000;
export const GONE_KEEP_MS = 86_400_000;
// The most active session state of a window's panes first.
const SESSION_RANK: readonly LaneSessionState[] = ["waiting", "busy", "shell", "idle"];

type Entry = {
  node: string; window: string;
  online: boolean;                 // nodeOnline as last computed
  alive: boolean;                  // windowAlive as last computed
  changedAt: number;
  goneAt: number | null;           // when its window went, while it is gone
  sessionId?: string;              // its session while the window was there, for its gone Run
  json: string | null;             // the Run last published
  run: Run | null;
};
type OpenJob = { view: JobView; queuedAt: number; startedAt: number | null };

const keyOf = (node: string, window: string) => `${node}\u0000${window}`;

export class Runs {
  #events: EventHub;
  #connections: Pick<Connections, "list" | "latest">;
  #lanes: Pick<LaneRegistry, "list">;
  #watch: Pick<LaneWatch, "runOf">;
  #jobs: Pick<JobMirror, "snapshot">;
  #waitMs: number;
  #log: Logger;
  #now: () => number;
  #sweepMs: number;
  #entries = new Map<string, Entry>();
  #open = new Map<string, OpenJob>();    // `${node}\0${id}` → a job not ended
  #fresh = new Set<string>();            // nodes that sent an inventory since their status last changed
  #timer: ReturnType<typeof setInterval> | null = null;
  #pending: ReturnType<typeof setImmediate> | null = null;
  #unsubscribe: (() => void) | null = null;

  constructor(p: {
    events: EventHub; connections: Pick<Connections, "list" | "latest">; lanes: Pick<LaneRegistry, "list">; watch: Pick<LaneWatch, "runOf">;
    jobs: Pick<JobMirror, "snapshot">; waitMs: number; log: Logger; now?: () => number; sweepMs?: number;
  }) {
    this.#events = p.events;
    this.#connections = p.connections;
    this.#lanes = p.lanes;
    this.#watch = p.watch;
    this.#jobs = p.jobs;
    this.#waitMs = p.waitMs;
    this.#log = p.log;
    this.#now = p.now ?? Date.now;
    this.#sweepMs = p.sweepMs ?? RUNS_SWEEP_MS;
  }

  // Subscribes (after the lane registry's own inventory subscriber, so its names are current), reads the open jobs, and
  // computes every Run once: after a restart, each known lane is unknown from now until its node reports. Jobs that
  // can't be read now (fleet.db busy) come with their next event.
  start(): void {
    try { for (const view of this.#jobs.snapshot()) if (view.outcome === null) this.#job(view); }
    catch (e) { this.#log.error("runs: reading the open jobs failed (fleet.db busy?); each job counts from its next event", e); }
    this.#unsubscribe = this.#events.subscribe(e => {
      if (e.t === "status") this.#fresh.delete(e.node);
      else if (e.t === "inventory") this.#fresh.add(e.node);
      else if (e.t === "job") this.#job(e.body as JobView);
      if (e.t === "status" || e.t === "inventory" || e.t === "health" || e.t === "job" || e.t === "lane") this.kick();
    });
    this.recompute();
    this.#timer = setInterval(() => this.recompute(), this.#sweepMs);
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#pending) clearImmediate(this.#pending);
    this.#pending = null;
  }

  // A fact changed: one recompute for everything that changed in this turn of the event loop.
  kick(): void {
    if (this.#pending !== null) return;
    this.#pending = setImmediate(() => { this.#pending = null; this.recompute(); });
  }

  // Every lane's Run now, by lane, then node.
  view(): RunView[] {
    const runs: Run[] = [];
    for (const e of this.#entries.values()) if (e.run) runs.push(e.run);
    return runs.sort((a, b) => (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
  }

  // Computes every Run, and publishes each that changed. fleet.db busy (the node and lane lists are read from it) is
  // logged and tried again at the next kick or sweep.
  recompute(): void {
    try { this.#recompute(); }
    catch (e) { this.#log.error("runs: recomputing failed (fleet.db busy?); trying again on the next change or sweep", e); }
  }

  // A job's latest view: open, it is kept with when it was first seen queued and first seen starting or running (the
  // view's `at` is its latest state change); ended, it goes.
  #job(view: JobView): void {
    const key = keyOf(view.node, view.id);
    if (view.outcome !== null) { this.#open.delete(key); return; }
    const before = this.#open.get(key);
    const started = view.state === "starting" || view.state === "running";
    this.#open.set(key, { view, queuedAt: before?.queuedAt ?? view.at, startedAt: before?.startedAt ?? (started ? view.at : null) });
  }

  #recompute(): void {
    const now = this.#now();
    const nodes = this.#connections.list();
    const registered = new Set(nodes.map(n => n.name));
    for (const [key, e] of this.#entries) if (!registered.has(e.node)) this.#entries.delete(key);
    const owners = new Map(this.#lanes.list().map(l => [l.name, l]));
    // Each lane's open jobs: its own (a job runs on the node of the lane that started it, J1), and those whose notice
    // goes to it, on the node its notice goes to.
    const jobs = new Map<string, { id: string; name: string; startedAt: number }[]>();
    for (const { view, queuedAt, startedAt } of this.#open.values()) {
      const keys = new Set([keyOf(view.node, view.lane)]);
      if (view.notify.kind === "lane") {
        const owner = owners.get(view.notify.name);
        keys.add(keyOf(owner && !owner.conflict ? owner.node : view.node, view.notify.name));
      }
      for (const key of keys) jobs.set(key, [...(jobs.get(key) ?? []), { id: view.id, name: view.name, startedAt: startedAt ?? queuedAt }]);
    }
    for (const n of nodes) {
      const latest = this.#connections.latest(n.name);
      const inventory = latest.inventory;
      const online = n.status === "online" && this.#fresh.has(n.name);
      const windows = new Map<string, Pane[]>();
      for (const p of inventory?.panes ?? []) windows.set(p.window, [...(windows.get(p.window) ?? []), p]);
      const names = new Set(windows.keys());
      if (!inventory) for (const l of owners.values()) if (l.node === n.name) names.add(l.name);
      for (const e of this.#entries.values()) if (e.node === n.name) names.add(e.window);
      const tz = latest.health?.tzOffsetMin;
      for (const window of names) {
        const key = keyOf(n.name, window);
        const before = this.#entries.get(key);
        // With no inventory since the fleet started, a registry name is taken as there; its node is not online anyway.
        const alive = inventory ? windows.has(window) : (before?.alive ?? true);
        const e: Entry = before ?? { node: n.name, window, online, alive, changedAt: now, goneAt: alive ? null : now, json: null, run: null };
        if (before) {
          if (before.online !== online || before.alive !== alive) e.changedAt = now;
          if (before.alive !== alive) e.goneAt = alive ? null : now;
          e.online = online;
          e.alive = alive;
        }
        if (!e.alive && e.goneAt !== null && now - e.goneAt > GONE_KEEP_MS) { this.#entries.delete(key); continue; }
        this.#entries.set(key, e);
        const panes = windows.get(window) ?? [];
        const pane = sessionPane(panes);
        const sessionId = pane?.sessionId ?? panes.find(p => p.sessionId !== undefined)?.sessionId;
        if (e.alive && inventory) { if (sessionId === undefined) delete e.sessionId; else e.sessionId = sessionId; }
        const track = this.#watch.runOf(n.name, window);
        const facts: RunFacts = {
          lane: window, node: n.name, ...(e.sessionId === undefined ? {} : { sessionId: e.sessionId }),
          nodeOnline: online, windowAlive: e.alive, session: e.alive ? (pane?.status ?? null) : null,
          turn: track?.turn ?? null, activity: track?.activity ?? null, needsInput: track?.needsInput ?? null,
          jobs: jobs.get(key) ?? [], waitMs: this.#waitMs, tzOffsetMin: tz ?? null, changedAt: e.changedAt, now,
        };
        const run = deriveRun(facts);
        const json = JSON.stringify(run);
        if (json === e.json) continue;
        e.json = json;
        e.run = run;
        this.#events.emit({ t: "run", node: n.name, body: run });
      }
    }
  }
}

// The pane whose session says the most about the window (SESSION_RANK), or null when none runs a session.
function sessionPane(panes: readonly Pane[]): Pane | null {
  let best: Pane | null = null;
  for (const p of panes) {
    if (p.status === null) continue;
    if (best === null || SESSION_RANK.indexOf(p.status) < SESSION_RANK.indexOf(best.status as LaneSessionState)) best = p;
  }
  return best;
}
