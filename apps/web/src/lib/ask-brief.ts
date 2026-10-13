// Asking the asker to restate a decision as a brief (ADR-0023): one wording and one error voice for the desktop
// modal and the phone sheet. The surface that calls it brings its own passkey gate (`verify`, null when it has
// nothing to say) and its own queue, and this helper decides everything the two said differently until now.
import { explain } from "./api.ts";
import type { AskOutcome } from "./desktop/answer-session.ts";
import type { DecisionItem } from "./desktop/decisions.ts";

// Who the restate goes to, in the shape both surfaces hold: the roster on the panel, the chat list on the phone.
export type AskWorker = { id: string; name: string; waitingOn?: string | null };

export async function askForBrief(
  d: DecisionItem,
  workers: readonly AskWorker[],
  queue: (c: { worker: string; workerName: string; text: string; seen: string }) => Promise<void>,
  verify: () => Promise<string | null>,
): Promise<AskOutcome> {
  const worker = d.asker.workerId;
  if (!worker) return { ok: false, error: "This decision has no one to ask." };
  const refused = await verify();
  if (refused !== null) return { ok: false, error: refused };
  const w = workers.find(x => x.id === worker);
  // The command is written for the question that pane is on now, or the hub refuses it as stale (S6).
  try {
    await queue({ worker, workerName: w?.name ?? d.asker.name, text: `Please restate ${d.id} as a decision brief: morndo-decide template`, seen: w?.waitingOn ?? "none" });
  } catch (e) {
    return { ok: false, error: explain(e) };
  }
  return { ok: true };
}
