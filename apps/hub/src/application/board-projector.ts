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
// - Idempotent: a move made changes the task (rev, updatedAt), so the same run moves it no further (D6). A refusal (the
//   task changed meanwhile, B5's one_doing, a reason the domain won't take) is logged once for that task's revision and
//   that run, and not tried again for them; a new run or another change of the task may try again.
// - Safe: nothing here throws into the event loop. A failure is logged, and the next run tries afresh.
import { derivedMove, type Task } from "@morndo/domain";
import type { RunView } from "@morndo/protocol";
import { log as hubLog, type Logger } from "../adapters/log.ts";
import type { BoardService } from "./board-service.ts";
import type { RunsSource } from "./ports.ts";

export type ProjectorBoard = Pick<BoardService, "openTasksOf" | "follow" | "runsChanged">;

// A list that failed is asked for again on the next run event, but not more often than this.
export const RETRY_MS = 5000;
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
  #unsubscribe: (() => void) | null = null;

  constructor(p: { source: RunsSource; board: ProjectorBoard; log?: Pick<Logger, "info" | "warn" | "error"> }) {
    this.#source = p.source; this.#board = p.board; this.#log = p.log ?? hubLog;
  }

  // Every lane's latest Run, by lane name: what the board frame carries (BoardView.runs).
  runs(): RunView[] { return [...this.#runs.values()].sort((a, b) => a.lane.localeCompare(b.lane)); }

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
    let list: RunView[];
    try { list = await this.#source.runs(); }
    catch (e) {
      this.#live = false;
      if (!this.#said) {
        this.#said = true;
        this.#log.warn(`board: the fleet's runs can't be read (${(e as Error).message}); the board moves nothing by itself until they can`);
      }
      return;
    }
    if (this.#said) { this.#said = false; this.#log.info("board: the fleet's runs are read again; the board follows them"); }
    this.#live = true;
    this.#runs = new Map(list.map(r => [r.lane, r]));
    this.#tellRuns();
    for (const r of this.#runs.values()) this.#follow(r);
  }

  #take(run: RunView) {
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

  #remember(memo: string) {
    this.#refused.add(memo);
    if (this.#refused.size <= REFUSALS_KEPT) return;
    const oldest = this.#refused.values().next().value;
    if (oldest !== undefined) this.#refused.delete(oldest);
  }
}
