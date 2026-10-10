// One lane.deliver per notice id (ADR-0017, design §4). The row is stored before anything is typed. The same id
// and text returns that row and types nothing again. A different text is id_conflict and types nothing.
import type Database from "better-sqlite3";
import { err, ok, type Result } from "@morndo/domain";
import type { JobStore, NoticeHandoff } from "./job-store.ts";

export type JobDelivery = { id: string; lane: string; text: string; state: "queued"; typed: boolean };

// True only when the lane has the text. A promise is the tmux send; false leaves the row untyped so a later handoff tries again.
export type TypeNotice = (delivery: JobDelivery) => boolean | Promise<boolean>;

// A paste that landed is delivered even when Enter was not seen: the text is already in the pane.
export function noticeLanded(problem: string | null): boolean {
  return problem === null || problem === "not_submitted";
}

// One paste per notice. A lane that is not there yet pastes nothing and can be tried again. Once send is
// attempted, a throw still counts: the text may already be in the pane, and this id is never pasted again.
export async function typeJobNotice(
  findPane: (lane: string) => Promise<string | null>,
  send: (pane: string, text: string) => Promise<string | null>,
  delivery: JobDelivery,
): Promise<boolean> {
  const pane = await findPane(delivery.lane);
  if (!pane) return false;
  try { return noticeLanded(await send(pane, delivery.text)); }
  catch { return true; }
}

type Row = { id: string; lane: string; text: string; typed: number };

const pending = <T>(value: T | Promise<T>): value is Promise<T> =>
  typeof (value as Promise<T> | null)?.then === "function";

export class JobDeliveries {
  #db: Database.Database;
  #type: TypeNotice;
  #flight = new Map<string, Promise<boolean>>();

  constructor(db: Database.Database, type: TypeNotice) {
    this.#db = db;
    this.#type = type;
  }

  enqueue(id: string, lane: string, text: string): Result<JobDelivery, "id_conflict"> | Promise<Result<JobDelivery, "id_conflict">> {
    const existing = this.#row(id);
    if (existing) {
      if (existing.lane !== lane || existing.text !== text) return err("id_conflict");
      const typed = existing.typed === 1 ? true : this.#typeOnce(existing);
      return pending(typed) ? typed.then(got => ok(view(existing, got))) : ok(view(existing, typed));
    }
    this.#db.prepare("INSERT INTO job_deliveries (id, lane, text, typed) VALUES (?, ?, ?, 0)").run(id, lane, text);
    const stored = this.#row(id);
    if (!stored) return err("id_conflict");
    const typed = this.#typeOnce(stored);
    return pending(typed) ? typed.then(got => ok(view(stored, got))) : ok(view(stored, typed));
  }

  // The row stays untyped when the lane did not get the text, so the same id can be tried again.
  // A paste already in flight is the same paste: a second caller waits for it and does not send another.
  #typeOnce(row: Row): boolean | Promise<boolean> {
    if (row.typed === 1) return true;
    const running = this.#flight.get(row.id);
    if (running) return running;
    let result: boolean | Promise<boolean>;
    try { result = this.#type(view(row, false)); }
    catch { return false; }
    if (!pending(result)) return this.#keep(row, result === true);
    const flight = result.then(got => this.#keep(row, got), () => false);
    this.#flight.set(row.id, flight);
    return flight.finally(() => { if (this.#flight.get(row.id) === flight) this.#flight.delete(row.id); });
  }

  #keep(row: Row, got: boolean): boolean {
    if (!got) return false;
    this.#db.prepare("UPDATE job_deliveries SET typed = 1 WHERE id = ? AND typed = 0").run(row.id);
    row.typed = 1;
    return true;
  }

  #row(id: string): Row | undefined {
    return this.#db.prepare("SELECT id, lane, text, typed FROM job_deliveries WHERE id = ?").get(id) as Row | undefined;
  }
}

function view(row: Row, typed: boolean): JobDelivery {
  return { id: row.id, lane: row.lane, text: row.text, state: "queued", typed };
}

// A lane target becomes one delivery. The notice is `typed` only after that delivery says the lane has the text.
// A fleet target and a task target do not: the fleet event and the comment are other steps.
export function deliverJobNotice(store: JobStore, deliveries: JobDeliveries, notice: NoticeHandoff): void {
  if (notice.job.notify.kind !== "lane") return;
  const decided = deliveries.enqueue(notice.noticeId, notice.job.notify.name, notice.text);
  const apply = (result: Result<JobDelivery, "id_conflict">) => {
    if (result.ok && result.value.typed) store.markNotice(notice.job.id, "typed");
  };
  if (pending(decided)) { void decided.then(apply); return; }
  apply(decided);
}
