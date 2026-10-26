// The relay's one question per turn (reliable lanes design §3.1): a lane whose answer states no status is asked for one
// before its Stop counts. Claude Code reads an HTTP hook's 2xx JSON answer as it reads a command hook's output, and a Stop
// hook's {"decision":"block","reason"} keeps the turn going with the reason to act on (https://code.claude.com/docs/en/hooks,
// read 2026-10-13). The relay asks only:
// - for Claude Code's own Stop body (hook_event_name "Stop"), from a window it placed that is not exempt;
// - when the Stop was not itself caused by a Stop hook (stop_hook_active): so once per turn, far below Claude Code's cap of
//   eight continuations in a row (same page);
// - when nothing is left running or scheduled in the session (background_tasks, session_crons): that turn waits on it, and
//   the fleet's lane watch gives it a deadline;
// - when the answer is there to read (last_assistant_message) and its first line states no status.
// The asked Stop is still kept, marked `statusAsked` (server.ts): its answer reaches the subscribers, but it is no turn end.
//
// W1, every wait needs a waker (ADR-0032; agent board design §5). A Stop whose first line does state a status, and that
// status is WAITING, is asked the other question when nothing will end the wait: a waker. Under the same rules as above
// (mode, exempt windows so never the orchestrator, "Stop", stop_hook_active), and only when, besides:
// - `background_tasks` and `session_crons` are both arrays, and both empty. The hooks page says both "are present when
//   the task registry is reachable and are empty when nothing is in flight or scheduled", and that they exist to tell
//   "session is done" from "session is paused waiting for background work to wake it back up"
//   (https://code.claude.com/docs/en/hooks, Stop input, read 2026-10-20). A field that is missing or not an array is a
//   registry the CLI couldn't read, so nothing is known about what will wake it, and it is not asked;
// - no job of that lane is queued, starting or running on this node (`jobsOf`, the job store): a job's notice is a
//   waker. A count the node can't give (null: its job store not open yet, or a read that failed) is not asked either.
// The status ask keeps priority: a Stop with no status line at all gets STATUS_ASK, exactly as before. The waker ask is
// answered and kept the same way ({"decision":"block","reason"}, `statusAsked`), so the fleet takes neither as a turn
// end, and the Stop Claude Code sends after it (stop_hook_active) is the one that counts. So a turn is asked at most once,
// whichever question it gets. A Stop hook's "block" "prevents Claude from stopping", with `reason` telling it why; Claude
// Code overrides the ninth block in a row (same page, Stop decision control, read 2026-10-20).
import { firstLineOf, statusLineOf } from "@morndo/protocol";
import type { StatusContract } from "../config.ts";

export const STATUS_ASK = "Start a short answer with one line saying where this lane stands, then stop: STATUS: DONE, "
  + "STATUS: BLOCKED, STATUS: NEEDS DECISION, or STATUS: WAITING <on what> for <N> min. Don't redo the work.";

// How many jobs of a lane are queued, starting or running on this node, or null when the node can't tell.
export type JobsOf = (lane: string) => number | null;

// The waker ask (W1): one short paragraph naming what the lane said it waits on and the lane its job would notify. The
// tools are Claude Code's own: ScheduleWakeup, and CronCreate with a one-time schedule (https://code.claude.com/docs/en/
// scheduled-tasks, read 2026-10-20). A WAITING line that names nothing is "it waits".
export function wakerAsk(lane: string, waitingOn?: string): string {
  return `This lane says it waits${waitingOn ? ` on ${waitingOn}` : ""}, but nothing will wake it: no background task, `
    + "no scheduled wake-up and no job. Do one of these: schedule a one-time wake-up for when it should be ready "
    + `(ScheduleWakeup or CronCreate); run the wait as a job: morndo job start --notify lane:${lane} -- <command>; or, `
    + "if you won't come back to it, end with STATUS: DONE, STATUS: BLOCKED or STATUS: NEEDS DECISION. Then end the "
    + "turn with your status line again.";
}

const pending = (v: unknown) => Array.isArray(v) && v.length > 0;
const none = (v: unknown) => Array.isArray(v) && v.length === 0;

// The reason to send back with {"decision":"block"}, or null when this Stop is not asked. Without `jobsOf` the node
// can't tell whether a job will wake the lane, so only the status ask is made.
export function statusAsk(body: unknown, window: string | null, contract: StatusContract, jobsOf?: JobsOf): string | null {
  if (contract.mode !== "ask" || window === null || contract.exempt.includes(window)) return null;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.hook_event_name !== "Stop" || b.stop_hook_active === true) return null;
  if (pending(b.background_tasks) || pending(b.session_crons)) return null;
  if (typeof b.last_assistant_message !== "string") return null;
  const line = statusLineOf(firstLineOf(b.last_assistant_message));
  if (line === null) return STATUS_ASK;
  if (line.status !== "waiting" || jobsOf === undefined) return null;
  if (!none(b.background_tasks) || !none(b.session_crons)) return null;
  return jobsOf(window) === 0 ? wakerAsk(window, line.waitingOn) : null;
}
