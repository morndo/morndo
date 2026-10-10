// What the fleet keeps of a job (design §4, §7). The node sends ev.job; the fleet stores the view and
// publishes it. The command never arrives here: the agent frame already dropped it.
import { clampEnded, jobFailed } from "@morndo/domain";
import { JobViewSchema, type EvJob, type JobView, type JobsQuery } from "@morndo/protocol";
import type { Logger } from "../adapters/log.ts";
import { fleetNoticeId, JOB_KEEP_MS, type JobsStore } from "../adapters/jobs-store.ts";
import type { EventHub } from "./events.ts";

// A job that ended just before the alert table was created still counts. Older history does not.
const ALERT_GRACE_MS = 10 * 60 * 1000;

export type JobRoute = { noticeId: string; node: string; lane: string; text: string };
export type LaneOwner = { node: string; conflict: boolean };
export type NoticeResult = { ok: boolean; state: string };

// A missed notice waits a minute, then twice as long each time, and never longer than an hour.
export const NOTICE_RETRY_MS = 60_000;
export const NOTICE_RETRY_MAX_MS = 60 * 60 * 1000;

export function nextNoticeDelay(prev: number | null): number {
  if (prev === null) return NOTICE_RETRY_MS;
  return Math.min(prev * 2, NOTICE_RETRY_MAX_MS);
}

export class JobMirror {
  #store: JobsStore;
  #events: EventHub;
  #online: (node: string) => boolean;
  #laneOf: (name: string) => LaneOwner | null;
  #deliver: (route: JobRoute) => Promise<boolean | NoticeResult>;
  #note: ((route: JobRoute, state: string) => void) | null;
  #log: Logger | null;
  #onFailed: (view: JobView) => void;
  #onUnnoticed: (view: JobView) => void;
  #tell: (node: string, id: string, notice: "commented" | "given_up") => Promise<boolean>;
  #now: () => number;
  #alertSince: number;
  #due = new Map<string, { at: number; delay: number }>();
  #seen = new Map<string, string>();
  #taken = 0;
  #watchers = new Set<() => void>();

  constructor(p: {
    store: JobsStore; events: EventHub; online: (node: string) => boolean;
    laneOf: (name: string) => LaneOwner | null; deliver: (route: JobRoute) => Promise<boolean | NoticeResult>; log?: Logger;
    now?: () => number; note?: (route: JobRoute, state: string) => void;
    onFailed?: (view: JobView) => void;
    onUnnoticed?: (view: JobView) => void;
    tell?: (node: string, id: string, notice: "commented" | "given_up") => Promise<boolean>;
  }) {
    this.#store = p.store;
    this.#events = p.events;
    this.#online = p.online;
    this.#laneOf = p.laneOf;
    this.#deliver = p.deliver;
    this.#note = p.note ?? null;
    this.#log = p.log ?? null;
    this.#onFailed = p.onFailed ?? (() => {});
    this.#onUnnoticed = p.onUnnoticed ?? (() => {});
    this.#tell = p.tell ?? (async () => false);
    this.#now = p.now ?? Date.now;
    this.#alertSince = p.store.alertSince();
  }

  accept(event: EvJob): void {
    const parsed = JobViewSchema.parse(event);
    const ended = clampEnded(parsed.ended, this.#now());
    const view = ended === parsed.ended ? parsed : { ...parsed, ended };
    const changed = this.#store.transaction(() => {
      const wrote = this.#store.upsert(view);
      this.#remember(view);
      return wrote;
    });
    const stored = this.#store.get(view.node, view.id);
    if (changed && stored) this.#events.emit({ t: "job", node: stored.node, body: stored });
    if (stored && jobFailed(stored) && this.#alertable(stored) && this.#store.claimFailure(stored.node, stored.id)) this.#onFailed(stored);
    if (stored?.notice === "given_up" && this.#store.claimUnnoticed(stored.node, stored.id)) this.#onUnnoticed(stored);
    if (stored && view.notice === stored.notice && (stored.notice === "commented" || stored.notice === "given_up")) this.#store.holdNotice(stored.node, stored.id, stored.notice);
    this.#dispatch(view);
  }

  // The hub's board result. The row updates even when the node is away; a welcome sends it again.
  report(node: string, id: string, notice: "commented" | "given_up"): JobView | null {
    const prev = this.#store.get(node, id);
    const stored = this.#store.setNotice(node, id, notice);
    if (!stored) return null;
    if (!prev || prev.notice !== stored.notice) this.#events.emit({ t: "job", node: stored.node, body: stored });
    if (stored.notice === "given_up" && this.#store.claimUnnoticed(stored.node, stored.id)) this.#onUnnoticed(stored);
    return stored;
  }

  holdNotice(node: string, id: string, notice: "commented" | "given_up"): void {
    this.#store.holdNotice(node, id, notice);
  }

  // Jobs whose notice the hub already settled and the node has not confirmed. A welcome does not repeat the rest.
  pushNotices(node: string): void {
    for (const view of this.#store.list({ node })) {
      if (view.notice !== "commented" && view.notice !== "given_up") continue;
      if (this.#store.nodeNotice(view.node, view.id) === view.notice) continue;
      void this.#tell(node, view.id, view.notice).then(ok => {
        if (ok) this.#store.holdNotice(view.node, view.id, view.notice);
      }, (e: unknown) => {
        this.#log?.error(`telling ${node} the notice for ${view.id} failed`, e);
      });
    }
  }

  // No end time, or an end from before this fleet alerted, is not a new failure.
  #alertable(view: JobView): boolean {
    if (view.ended === null) return false;
    return view.ended >= this.#alertSince - ALERT_GRACE_MS;
  }

  #remember(view: JobView): void {
    if (view.outcome === null || view.notify.kind !== "lane") return;
    if (this.#store.noticeDest(view.node, view.id) !== null) return;
    const lane = this.#laneOf(view.notify.name);
    const chosen = lane && !lane.conflict && lane.node !== view.node ? lane.node : "";
    this.#store.decide(view.node, view.id, chosen);
  }

  // The destination is decided once, when the job finishes. A lane on this node, a conflict, or no lane
  // is recorded as staying here, so a later move does not send a stale notice. The text is not written here (ADR-0014).
  #route(view: JobView): void {
    this.#remember(view);
    this.#dispatch(view);
  }

  #handled(): void {
    this.#taken += 1;
    for (const fn of this.#watchers) fn();
  }

  #dispatch(view: JobView): void {
    if (view.outcome === null || view.notify.kind !== "lane") { this.#handled(); return; }
    const dest = this.#store.noticeDest(view.node, view.id);
    if (!dest || dest === view.node) { this.#handled(); return; }
    const noticeId = fleetNoticeId(view.node, view.id);
    if (!this.#store.claim(noticeId, view.node, view.id, dest)) { this.#handled(); return; }
    const route: JobRoute = { noticeId, node: dest, lane: view.notify.name, text: view.tail };
    void this.#deliver(route).then(raw => {
      this.#settled(route, typeof raw === "boolean" ? { ok: raw, state: raw ? "ok" : "busy" } : raw);
    }, (e: unknown) => {
      this.#settled(route, { ok: false, state: "internal" });
      this.#log?.error(`routing notice ${noticeId} to ${route.node} failed`, e);
    }).finally(() => this.#handled());
  }

  // A failure waits. The same outcome is not audited again; a different one is.
  #settled(route: JobRoute, result: NoticeResult): void {
    if (!result.ok) this.#store.release(route.noticeId);
    if (this.#seen.get(route.noticeId) !== result.state) {
      this.#seen.set(route.noticeId, result.state);
      this.#note?.(route, result.state);
    }
    if (result.ok) {
      this.#due.delete(route.noticeId);
      return;
    }
    const delay = nextNoticeDelay(this.#due.get(route.noticeId)?.delay ?? null);
    this.#due.set(route.noticeId, { at: this.#now() + delay, delay });
  }

  // How many ev.job frames have been handled, including a notice the duplicate did not send.
  get taken(): number { return this.#taken; }
  watch(fn: () => void): () => void {
    this.#watchers.add(fn);
    return () => { this.#watchers.delete(fn); };
  }

  get(node: string, id: string): JobView | null { return this.#store.get(node, id); }

  find(id: string): JobView[] { return this.#store.byId(id); }

  prune(now: number): number { return this.#store.prune(now); }

  snapshot(): JobView[] { return this.#store.snapshot(); }

  list(q: JobsQuery): JobView[] { return this.#store.list(q); }

  // A notice that was not typed is claimed again. `dest` limits that to lanes on a node that just came back,
  // and tries at once. Otherwise each notice waits out its own backoff, and nothing is tried after 7 days.
  retry(dest?: string): void {
    const now = this.#now();
    for (const view of this.#store.pendingNotices()) {
      if (now - view.at >= JOB_KEEP_MS) continue;
      const target = this.#store.noticeDest(view.node, view.id);
      if (!target || target === view.node) continue;
      if (dest !== undefined && target !== dest) continue;
      const due = this.#due.get(fleetNoticeId(view.node, view.id));
      if (dest === undefined && due && due.at > now) continue;
      this.#route(view);
    }
  }

  // A list is stale when a node it names, or a node it was filtered to, is not online.
  stale(nodes: readonly string[]): boolean {
    return nodes.some(node => !this.#online(node));
  }
}
