// Application service for the proof of work (ADR-0035; B13 to B15): the brief is the assignee's word, filed as its own
// board action, and its references are checked by the hub, not by the lane. Here a brief is filed (the board judges it
// like any action) and its references seeded as pending rows; the checks themselves are step 3, so this service holds
// no port yet and a result is handed to `record`. A check is a row of its own, never a change of the task (plan 3.4:
// results are rows, not events, so a re-check never moves the task's `rev`), and it is never pushed: a re-check is not
// a board change. Rows of an older brief or an earlier round are kept in the table, never shown.
import { currentBrief, proofOf, type BriefInput, type ProofBrief, type ProofState, type RefResult, type TaskActor } from "@morndo/domain";
import { redactKeyMaterial } from "@morndo/protocol";
import type { Store } from "../adapters/store.ts";
import type { BoardResult, BoardService } from "./board-service.ts";

// What the card shows of one task's proof (B15): the brief that still counts, its rows and the one line. No brief:
// `rev` and `brief` null, the no_brief line.
export type ProofView = { rev: number | null; brief: ProofBrief | null; results: RefResult[]; state: ProofState };

export class ProofService {
  #store: Store;
  #board: BoardService;
  #now: () => number;

  constructor(p: { store: Store; board: BoardService; now?: () => number }) {
    this.#store = p.store; this.#board = p.board; this.#now = p.now ?? Date.now;
  }

  // A brief, filed as its own board action (B13): the board judges who may file it, its words and its references, so a
  // refused brief writes nothing and seeds nothing. Every text field loses key material first, before it is judged and
  // stored (plan 3.8); the references are typed values, not prose, and pass as they are.
  async file(key: string, input: BriefInput, actor: TaskActor): Promise<BoardResult> {
    const brief: BriefInput = {
      summary: redactKeyMaterial(input.summary),
      leftOut: redactKeyMaterial(input.leftOut),
      limits: redactKeyMaterial(input.limits),
      ...(input.decisions !== undefined ? { decisions: redactKeyMaterial(input.decisions) } : {}),
      ...(input.noCode !== undefined ? { noCode: redactKeyMaterial(input.noCode) } : {}),
      ...(input.refs !== undefined ? { refs: [...input.refs] } : {}),
      ...(input.attested !== undefined ? { attested: input.attested.map(a => ({ kind: a.kind, how: redactKeyMaterial(a.how) })) } : {}),
    };
    const r = await this.#board.actChecked(key, { action: "brief", brief }, actor);
    // Seeded after the event, outside its transaction: a reference with no row is read as pending by proofOf, so a
    // crash between the two leaves the same picture, and the seed's INSERT OR IGNORE keeps a row that exists standing.
    if (r.ok && r.event.change.kind === "briefed") this.#store.seedProofs(key, r.event.rev, r.event.change.brief.refs, this.#now());
    return r;
  }

  // The task's proof as it stands (null: no such task): the brief that still counts (currentBrief; one from before the
  // last review-to-doing move is stale) with its rows and its one line.
  view(key: string): ProofView | null {
    if (this.#store.task(key) === null) return null;
    const current = currentBrief(this.#store.taskEvents(key));
    if (current === null) return { rev: null, brief: null, results: [], state: proofOf(null, []) };
    const results = this.#store.proofResultsOf(key, current.rev);
    return { rev: current.rev, brief: current.brief, results, state: proofOf(current.brief, results) };
  }

  // One reference's state, as a row: never the task, never an event, never a push. Stored only for the brief that
  // still counts and only for a reference it holds; a result for a stale round or a ref the brief does not hold is
  // ignored and writes nothing, so a slow check cannot judge a round it was not asked about. The rows of a round that
  // is over stay as that round's history.
  record(key: string, briefRev: number, result: RefResult): boolean {
    const current = currentBrief(this.#store.taskEvents(key));
    if (current === null || current.rev !== briefRev || !current.brief.refs.includes(result.ref)) return false;
    this.#store.saveProofResult(key, briefRev, result);
    return true;
  }
}
