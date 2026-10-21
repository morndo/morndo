// Application service for the board's own moves (ADR-0032: B10 with D1 to D6, docs/design/agent-board/README.md §4).
// It keeps each lane's latest Run as the Fleet derived it, and moves that lane's tasks as the domain's derivedMove says,
// as actor { kind: "board", rule, lane }, through BoardService.follow: one transaction, its record and its push, as any
// change (B6). The Fleet supplies the runs and the Board never writes one (§2); the domain judges every move (B10, D5).
// - Its runs: the source's whole list at start and after every reconnect (a `run` sent while the hub was away is not
//   replayed), and each `run` event between. A list replaces what was held: a lane the fleet no longer lists is dropped,
//   never kept from memory. An event and a list read at the same time may land in either order; D6 keeps a move made on
//   the newer one from being undone by the older.
// - When it acts: on a run it was just told, an event or a list just read, for that lane's open tasks, one move at a
//   time (a move changes what the next may do: D4 reads B5). Never on what it only holds, so never on a board change
//   (D6 refuses those anyway: the run began before the change). Never while the fleet can't be asked: until a list is
//   read, and after a list fails, nothing moves; a run event then asks for the list again, at most every RETRY_MS.
// - A lane the fleet's list doesn't hold (no Run at all) is gone too (D3): its task in progress goes back to to do, once;
//   its to do tasks are only flagged (orphans(), never moved: D5). The fleet's drops (a gone lane after a day, a revoked
//   node) are no event, so they are read at the next list read (start, reconnect): eventual by design.
// - Idempotent: a move made changes the task (rev, updatedAt), so the same run moves it no further (D6). A refusal (the
//   task changed meanwhile, B5's one_doing, a reason the domain won't take) is logged once for that task's revision and
//   that run, and not tried again for them; a new run or another change of the task may try again.
// - Safe: nothing here throws into the event loop. A failure is logged, and the next run tries afresh.
import { derivedMove, isOrphan, unregisteredMove, type Task } from "@morndo/domain";
import type { RunView } from "@morndo/protocol";
import { log as hubLog, type Logger } from "../adapters/log.ts";
import type { BoardService } from "./board-service.ts";
import type { RunsSource } from "./ports.ts";

export type ProjectorBoard = Pick<BoardService, "openTasksOf" | "tasksInProgress" | "follow" | "runsChanged">;

// A list that failed is asked for again on the next run event, but not more often than this.
export const RETRY_MS = 5000;
// A task assigned by `lanes start --task` waits this long for its lane's first Run before it is flagged.
export const ORPHAN_GRACE_MS = 120_000;
// The refusals kept, so each is logged and tried once; the oldest goes first (a refusal names a revision and a run, which
// newer ones replace).
const REFUSALS_KEPT = 500;
// Each of a lane's tasks moves at most once for one run (D6), and a lane has one task in progress (B5): a bound, not a
// budget.
const MOVES_PER_RUN = 8;

export class BoardProjector {
  #source: RunsSource;
  #board: ProjectorBoard;
  #log: Pick<Logger, "info" | "warn" | "error">;
  #runs = new Map<string, RunView>();                    // lane → its latest Run
  #live = false;                                         // the last list was read: the fleet answers
  #said = false;                                         // "can't be read" logged, for this outage
  #refused = new Set<string>();
  #refreshing: Promise<void> | null = null;
  #again = false;
  #triedAt = -Infinity;                                  // performance.now() of the last list asked for
  #told: Map<string, RunView> | null = null;            // the runs told while a list read is in flight, merged into it when it lands
  #unsubscribe: (() => void) | null = null;

  constructor(p: { source: RunsSource; board: ProjectorBoard; log?: Pick<Logger, "info" | "warn" | "error"> }) {
    this.#source = p.source; this.#board = p.board; this.#log = p.log ?? hubLog;
  }

  // Every lane's latest Run, by lane name: what the board frame carries (BoardView.runs).
  runs(): RunView[] { return [...this.#runs.values()].sort((a, b) => a.lane.localeCompare(b.lane)); }

  // B2: the to do tasks whose lane the fleet's list doesn't hold, for the board frame (BoardView.orphans). Flagged only,
  // never moved (D5); and never while the fleet can't be asked: a list that couldn't be read says nothing about who is
  // gone. Flagged only after the grace from the task's last update (a comment on it extends it; harmless).
  orphans(tasks: readonly Task[], now: number): string[] {
    if (!this.#live) return [];
    const registered = new Set(this.#runs.keys());
    return tasks.filter(t => now - t.updatedAt >= ORPHAN_GRACE_MS && isOrphan(t, registered)).map(t => t.key);
  }

  // At hub start: the runs followed from now on, and the list read once, which applies what is due (a lane that ended
  // DONE or stopped while the hub was away). Never throws: a fleet that can't be asked is logged, and asked again.
  async start(): Promise<void> {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#source.subscribe(r => this.#take(r), () => { void this.refresh(); });
    await this.refresh();
  }
  stop() { this.#unsubscribe?.(); this.#unsubscribe = null; }

  // The whole list, read again: one read at a time, and one more after it when asked meanwhile (a reconnect during a
  // read must not lose its own read).
  refresh(): Promise<void> {
    if (this.#refreshing) { this.#again = true; return this.#refreshing; }
    this.#refreshing = (async () => {
      do { this.#again = false; await this.#read(); } while (this.#again);
    })().finally(() => { this.#refreshing = null; });
    return this.#refreshing;
  }

  async #read() {
    this.#triedAt = performance.now();
    this.#told = new Map();                                  // the runs told from here until the read lands
    let list: RunView[];
    try { list = await this.#source.runs(); }
    catch (e) {
      this.#told = null;
      this.#live = false;
      if (!this.#said) {
        this.#said = true;
        this.#log.warn(`board: the fleet's runs can't be read (${(e as Error).message}); the board moves nothing by itself until they can`);
      }
      return;
    }
    if (this.#said) { this.#said = false; this.#log.info("board: the fleet's runs are read again; the board follows them"); }
    this.#live = true;
    // The list is the fleet's answer as of when the read began, so a run told since is as new or newer: a lane an event
    // named while the read was in flight stays registered (else D3 would move its task back, and D6 would keep the same
    // phase from taking it again), and for a lane both name, the one whose phase began later stands.
    const runs = new Map(list.map(r => [r.lane, r]));
    for (const [lane, told] of this.#told ?? []) {
      const listed = runs.get(lane);
      if (!listed || told.since >= listed.since) runs.set(lane, told);
    }
    this.#told = null;
    this.#runs = runs;
    this.#tellRuns();
    for (const r of this.#runs.values()) this.#follow(r);
    this.#followUnregistered();
  }

  #take(run: RunView) {
    this.#told?.set(run.lane, run);
    this.#runs.set(run.lane, run);
    this.#tellRuns();
    if (this.#live) this.#follow(run);
    else if (performance.now() - this.#triedAt >= RETRY_MS) void this.refresh();
  }

  #tellRuns() {
    try { this.#board.runsChanged(); }
    catch (e) { this.#log.error("board: pushing the runs failed", e); }
  }

  // B10: what is due for `run`'s lane, applied one move at a time, its open tasks read again after each.
  #follow(run: RunView) {
    try {
      for (let i = 0; i < MOVES_PER_RUN; i++) {
        const tasks = this.#board.openTasksOf(run.lane);
        let due: { task: Task; move: NonNullable<ReturnType<typeof derivedMove>>; memo: string } | null = null;
        for (const task of tasks) {
          const move = derivedMove(task, run, tasks);
          if (!move) continue;
          const memo = `${task.key}@${task.rev} ${run.lane}@${run.since} ${move.rule}`;
          if (this.#refused.has(memo)) continue;
          due = { task, move, memo };
          break;
        }
        if (!due) return;
        const { task, move } = due;
        const r = this.#board.follow(task.key, move, run.lane, task.rev);
        if (r.ok) {
          this.#log.info(`board: ${move.rule} moved ${task.key} ${task.status} → ${move.to}, following ${run.lane}'s run`);
          continue;
        }
        this.#remember(due.memo);
        this.#log.warn(`board: ${move.rule} would move ${task.key} ${task.status} → ${move.to} for ${run.lane}, refused (${r.problem}${r.other ? ` ${r.other}` : ""}); it stays where it is`);
      }
    } catch (e) {
      this.#log.error(`board: following ${run.lane}'s run failed; its next run tries again`, e);
    }
  }

  // B10, D3 without a Run to read: a lane the fleet's list doesn't hold at all is gone too, its task in progress put back
  // once. Only a list read reaches here — the fleet's whole answer, which is authoritative — never a run event (a lane one
  // names is registered by definition), and never a list that couldn't be read.
  #followUnregistered() {
    try {
      const registered = new Set(this.#runs.keys());
      for (const task of this.#board.tasksInProgress()) {
        const move = unregisteredMove(task, registered);
        if (!move || task.assignee === null) continue;
        const memo = `${task.key}@${task.rev} ${task.assignee}@unregistered D3`;
        if (this.#refused.has(memo)) continue;
        const r = this.#board.follow(task.key, move, task.assignee, task.rev);
        if (r.ok) {
          this.#log.info(`board: D3 moved ${task.key} doing → todo, ${task.assignee} is not a registered lane`);
          continue;
        }
        this.#remember(memo);
        this.#log.warn(`board: ${move.rule} would move ${task.key} ${task.status} → ${move.to} for ${task.assignee}, refused (${r.problem}${r.other ? ` ${r.other}` : ""}); it stays where it is`);
      }
    } catch (e) {
      this.#log.error("board: following the unregistered lanes failed; the next list read tries again", e);
    }
  }

  #remember(memo: string) {
    this.#refused.add(memo);
    if (this.#refused.size <= REFUSALS_KEPT) return;
    const oldest = this.#refused.values().next().value;
    if (oldest !== undefined) this.#refused.delete(oldest);
  }
}
