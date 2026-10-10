// The hub's copy of the fleet's job mirror (design §7). The fleet is the source: a GET on connect and each
// ev.job after it. What the hub shows has the list fields and the counts beside a node. It has no command and no tail.
import { clampEnded, jobCounts, taskNotice, type JobCounts } from "@morndo/domain";
import { JobViewSchema, type JobView } from "@morndo/protocol";
import type { Store } from "../adapters/store.ts";
import type { BoardService } from "./board-service.ts";

// The board calls a comment needs. A stand-in can refuse without being the whole service.
type NoticeBoard = Pick<BoardService, "task" | "act">;

export type JobListItem = {
  id: string; node: string; lane: string; name: string; class: string; state: string;
  outcome: string | null; exit: number | null; durationSec: number | null; notice: string;
  noticeDetail: "task_gone" | null;
  task: string | null; at: number;
};

export type JobsView = { jobs: JobListItem[]; counts: JobCounts[]; more: number; stale: boolean; at: number };

// The board header lists every open job and this many newest finished ones. The rest are a count and a link.
export const JOB_LIST_MAX = 20;

const shown = (job: JobView, notice: { result: "commented" | "given_up"; detail: "task_gone" | null } | undefined): JobListItem => ({
  id: job.id, node: job.node, lane: job.lane, name: job.name, class: job.class, state: job.state,
  outcome: job.outcome, exit: job.exit, durationSec: job.durationSec,
  notice: notice?.result ?? job.notice, noticeDetail: notice?.detail ?? null,
  task: job.task, at: job.at,
});

const NOTICE_ACTOR = "job-notice";
const jobCursor = (job: { ended: number | null; at: number; node: string; id: string }) => `${job.ended ?? job.at}:${job.at}:${job.node}:${job.id}`;
const received = (job: JobView, at: number): JobView => {
  const ended = clampEnded(job.ended, at);
  return ended === job.ended ? job : { ...job, ended };
};
const kept = (job: { node: string; id: string }) => `${job.node}\0${job.id}`;
const noted = (job: { node: string; id: string }) => `${job.node}:${job.id}`;

export class JobsService {
  #now: () => number;
  #jobs = new Map<string, JobView>();
  #stale = false;
  #listeners = new Set<(v: JobsView) => void>();
  #lastTold = "";
  #store: Store | null = null;
  #board: NoticeBoard | null = null;
  #notices = new Map<string, { result: "commented" | "given_up"; detail: "task_gone" | null }>();
  #counts = new Map<string, JobCounts>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #onNotice: ((job: JobView, notice: "commented" | "given_up") => void) | null = null;

  constructor(p: { now?: () => number; tickMs?: number; store?: Store; board?: NoticeBoard } = {}) {
    this.#now = p.now ?? Date.now;
    const tick = p.tickMs ?? 60_000;
    if (tick > 0) {
      this.#timer = setInterval(() => { this.#recount(); this.#tell(); }, tick);
      this.#timer.unref?.();
    }
    if (p.store && p.board) this.attach({ store: p.store, board: p.board });
  }

  // The fleet and the node learn what the board did. Called after the comment commits.
  reportNotice(fn: (job: JobView, notice: "commented" | "given_up") => void): void {
    this.#onNotice = fn;
  }

  // Board results the fleet has not acknowledged. A new process reads the same rows.
  unackedNotices(): { node: string; id: string; notice: "commented" | "given_up" }[] {
    const store = this.#store;
    if (!store) return [];
    const out: { node: string; id: string; notice: "commented" | "given_up" }[] = [];
    for (const row of store.unackedJobNotices()) {
      const at = row.id.indexOf(":");
      if (at <= 0) continue;
      if (row.result !== "commented" && row.result !== "given_up" && row.result !== "task_gone") continue;
      out.push({ node: row.id.slice(0, at), id: row.id.slice(at + 1), notice: row.result === "commented" ? "commented" : "given_up" });
    }
    return out;
  }

  ackNotice(node: string, id: string): void {
    this.#store?.ackJobNotice(`${node}:${id}`);
  }

  close(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  // The board is up after the fleet mirror may already hold jobs. A claimed id is never commented again.
  attach(p: { store: Store; board: NoticeBoard }): void {
    this.#store = p.store;
    this.#board = p.board;
    for (const row of p.store.jobNotices()) {
      if (row.result !== "commented" && row.result !== "given_up" && row.result !== "task_gone") continue;
      this.#notices.set(row.id, {
        result: row.result === "commented" ? "commented" : "given_up",
        detail: row.result === "task_gone" ? "task_gone" : null,
      });
    }
    for (const job of this.#jobs.values()) this.#comment(job);
  }

  subscribe(fn: (v: JobsView) => void) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }

  view(): JobsView {
    const header = this.#header();
    return { jobs: header.jobs, counts: [...this.#counts.values()].sort((a, b) => a.node.localeCompare(b.node)), more: header.more, stale: this.#stale, at: this.#now() };
  }

  // The finished jobs the header does not show, newest first. `before` is the cursor of the last row already shown.
  page(before: string | null, limit = JOB_LIST_MAX): { jobs: JobListItem[]; next: string | null } {
    const hidden = this.#terminal().slice(JOB_LIST_MAX);
    const at = before === null ? 0 : hidden.findIndex(job => jobCursor(job) === before);
    const start = before === null ? 0 : at === -1 ? hidden.length : at + 1;
    const slice = hidden.slice(start, start + limit);
    const last = slice.at(-1);
    return {
      jobs: slice.map(job => shown(job, this.#noticeOf(job))),
      next: last && start + slice.length < hidden.length ? jobCursor(last) : null,
    };
  }

  // The fleet's GET /v1/jobs, read again on every connect. Replaces the mirror; a job that left the fleet leaves here.
  replace(list: { jobs: JobView[]; stale: boolean }): void {
    this.merge(list, []);
  }

  // A list read and the events that arrived while it was in flight. Per job, the newer `at` wins. A job only the
  // events saw is kept. A job in neither is gone.
  merge(list: { jobs: JobView[]; stale: boolean }, seen: readonly JobView[]): void {
    const during = new Map<string, JobView>();
    for (const raw of seen) {
      const job = received(raw, this.#now());
      const key = kept(job);
      const prev = during.get(key);
      if (!prev || job.at >= prev.at) during.set(key, job);
    }
    const next = new Map<string, JobView>();
    for (const job of list.jobs.map(row => received(row, this.#now()))) {
      const key = kept(job);
      const live = during.get(key);
      during.delete(key);
      const chosen = live && live.at >= job.at ? live : job;
      next.set(key, chosen);
    }
    for (const [key, job] of during) next.set(key, job);
    this.#jobs = next;
    this.#stale = list.stale;
    this.#recount();
    for (const job of this.#jobs.values()) this.#comment(job);
    this.#tell();
  }

  // One ev.job. An older observation does not rewind a newer one. `quiet` updates the mirror without telling
  // (a list read is in flight; the merge tells once).
  apply(raw: unknown, quiet = false): void {
    const parsed = JobViewSchema.safeParse(raw);
    if (!parsed.success) return;
    const next = received(parsed.data, this.#now());
    const key = kept(next);
    const prev = this.#jobs.get(key);
    if (prev && prev.at > next.at) return;
    this.#touch(prev, -1);
    this.#touch(next, 1);
    this.#jobs.set(key, next);
    this.#comment(next);
    if (!quiet) this.#tell();
  }

  #noticeOf(job: { node: string; id: string }): { result: "commented" | "given_up"; detail: "task_gone" | null } | undefined {
    return this.#notices.get(noted(job));
  }

  // One comment, as the lane that started the job. No text means no comment. given_up is a board refusal.
  // task_gone is only a task that is not on the board. The job stays either way.
  #comment(job: JobView): void {
    const store = this.#store;
    const board = this.#board;
    if (!store || !board) return;
    const effect = taskNotice(job);
    const key = noted(job);
    if (!effect || this.#notices.has(key)) return;
    const actor = { kind: "worker" as const, name: job.lane, token: NOTICE_ACTOR };
    let stored: "commented" | "given_up" | "task_gone" | null = null;
    store.transaction(() => {
      const claim = store.claimJobNotice(key);
      if (claim === "settled") return;
      const found = board.task(effect.task);
      const posted = found ? board.act(effect.task, { action: "comment", text: effect.text }, actor) : { ok: false as const };
      stored = posted.ok ? "commented" : found ? "given_up" : "task_gone";
      store.finishJobNotice(key, stored);
    });
    if (!stored) return;
    this.#notices.set(key, {
      result: stored === "commented" ? "commented" : "given_up",
      detail: stored === "task_gone" ? "task_gone" : null,
    });
    this.#onNotice?.(job, stored === "commented" ? "commented" : "given_up");
  }

  // One job in or out of the running totals. A minute's tick recounts, so a day-old failure leaves without an event.
  #touch(job: JobView | undefined, sign: 1 | -1): void {
    if (!job) return;
    for (const row of jobCounts([job], this.#now())) {
      const cur = this.#counts.get(row.node) ?? { node: row.node, running: 0, queued: 0, failed: 0 };
      cur.running += sign * row.running;
      cur.queued += sign * row.queued;
      cur.failed += sign * row.failed;
      this.#counts.set(row.node, cur);
    }
  }

  #recount(): void {
    this.#counts.clear();
    for (const row of jobCounts([...this.#jobs.values()], this.#now())) this.#counts.set(row.node, row);
  }

  #terminal(): JobView[] {
    const newer = (a: JobView, b: JobView) => (a.ended ?? a.at) - (b.ended ?? b.at) || a.at - b.at || b.id.localeCompare(a.id);
    return [...this.#jobs.values()].filter(job => job.outcome !== null).sort((a, b) => newer(b, a));
  }

  // Open jobs, plus the newest finished ones. One pass: the wire is this list, not every job the mirror holds.
  #header(): { jobs: JobListItem[]; more: number } {
    const open = [...this.#jobs.values()].filter(job => job.outcome === null);
    const terminal = this.#terminal();
    const recent = terminal.slice(0, JOB_LIST_MAX);
    const jobs = [...open, ...recent].map(job => shown(job, this.#noticeOf(job))).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id) || a.node.localeCompare(b.node));
    return { jobs, more: terminal.length - recent.length };
  }

  #tell(): void {
    const view = this.view();
    const body = JSON.stringify({ jobs: view.jobs, counts: view.counts, more: view.more, stale: view.stale });
    if (body === this.#lastTold) return;
    this.#lastTold = body;
    for (const listener of this.#listeners) listener(view);
  }
}
