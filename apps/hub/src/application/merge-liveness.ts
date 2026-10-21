// A merge's liveness over the nodes' builds (B11): the domain's livenessOf, with each ancestry answer cached per
// (merge, build) pair and filled out of band — `of` never runs git, a queue worker does, at most a few checks at once.
// "ancestor" and "not_ancestor" are kept for good (git's answer about those two commits never changes); "unknown" is
// asked again on a backing-off schedule (the operator may have updated the checkout it was read from), and a rejecting
// ancestry is an unknown too. When a drained queue changed what `of` would answer, onChange says so — once — so the hub
// may push a fresh board without waiting for the next look.
import { livenessOf, type AncestryAnswer, type Liveness, type NodeBuild } from "@morndo/domain";

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 600_000;
const PARALLEL = 4;

export class MergeLiveness {
  readonly #builds: () => readonly NodeBuild[];
  readonly #ancestry: (merge: string, build: string) => Promise<AncestryAnswer>;
  readonly #now: () => number;
  readonly #baseMs: number;
  readonly #maxMs: number;
  readonly #parallel: number;
  readonly #onChange: (() => void) | undefined;
  readonly #answers = new Map<string, { answer: AncestryAnswer; until: number | null }>();   // "<merge> <build>"; until null: settled for good
  readonly #misses = new Map<string, number>();       // a pair's consecutive unknowns, for its next backoff
  readonly #pending = new Set<string>();              // queued or running: never queued twice
  readonly #queue: { merge: string; build: string; key: string }[] = [];
  readonly #waiters: (() => void)[] = [];             // settle(), released when nothing is queued or running
  #active = 0;
  #pumpQueued = false;
  #changed = false;                                   // an answer changed since the queue last drained
  #stopped = false;

  constructor(o: {
    builds: () => readonly NodeBuild[];
    ancestry: (merge: string, build: string) => Promise<AncestryAnswer>;
    now?: () => number;
    backoffBaseMs?: number;
    backoffMaxMs?: number;
    parallel?: number;
    onChange?: () => void;
  }) {
    this.#builds = o.builds;
    this.#ancestry = o.ancestry;
    this.#now = o.now ?? Date.now;
    this.#baseMs = o.backoffBaseMs ?? BACKOFF_BASE_MS;
    this.#maxMs = o.backoffMaxMs ?? BACKOFF_MAX_MS;
    this.#parallel = o.parallel ?? PARALLEL;
    this.#onChange = o.onChange;
  }

  // Synchronous, always: the cached answer for now, and unknown for a pair it doesn't hold yet — the check runs behind
  // this, not in it.
  of(sha: string): Liveness {
    return livenessOf(sha, this.#builds(), (merge, build) => this.#ask(merge, build));
  }

  // Waits for every queued or running check to have landed. A test's hold on git; the hub never calls it.
  settle(): Promise<void> {
    if (this.#pending.size === 0) return Promise.resolve();
    return new Promise<void>(resolve => this.#waiters.push(resolve));
  }

  // The end of the hub: queued checks are dropped, a check still running lands into nothing, and nothing is asked again.
  stop() {
    this.#stopped = true;
    for (const job of this.#queue.splice(0)) this.#pending.delete(job.key);
  }

  #ask(merge: string, build: string): AncestryAnswer {
    const key = `${merge} ${build}`;
    const held = this.#answers.get(key);
    const now = this.#now();
    if (held && (held.answer !== "unknown" || held.until !== null && held.until > now)) return held.answer;
    if (!this.#stopped && !this.#pending.has(key)) {
      this.#pending.add(key);
      this.#queue.push({ merge, build, key });
      this.#schedule();
    }
    return "unknown";
  }

  // The worker starts on a microtask, never inside `of`: a board action must not even begin git.
  #schedule() {
    if (this.#stopped || this.#pumpQueued) return;
    this.#pumpQueued = true;
    queueMicrotask(() => { this.#pumpQueued = false; this.#pump(); });
  }

  #pump() {
    while (!this.#stopped && this.#active < this.#parallel) {
      const job = this.#queue.shift();
      if (!job) break;
      this.#active++;
      void this.#ancestry(job.merge, job.build)
        .catch(() => "unknown" as const)              // git failing to answer is not an answer
        .then(answer => this.#land(job, answer));
    }
  }

  #land(job: { merge: string; build: string; key: string }, answer: AncestryAnswer) {
    this.#active--;
    this.#pending.delete(job.key);
    if (this.#stopped) { this.#drained(); return; }   // stopped: the late answer is dropped, nothing is said
    if (this.#answers.get(job.key)?.answer !== answer) this.#changed = true;
    if (answer === "unknown") {
      const misses = (this.#misses.get(job.key) ?? 0) + 1;
      this.#misses.set(job.key, misses);
      this.#answers.set(job.key, { answer, until: this.#now() + Math.min(this.#baseMs * 2 ** (misses - 1), this.#maxMs) });
    } else {
      this.#misses.delete(job.key);                   // a final answer ends the asking
      this.#answers.set(job.key, { answer, until: null });
    }
    this.#pump();                                     // the freed slot may start the next check
    this.#drained();
  }

  // Nothing queued and nothing running: say what changed, once, and release settle().
  #drained() {
    if (this.#active > 0 || this.#queue.length > 0) return;
    if (this.#changed) {
      this.#changed = false;
      this.#onChange?.();
    }
    for (const w of this.#waiters.splice(0)) w();
  }
}
