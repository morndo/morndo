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
import { firstLineOf, statusLineOf } from "@morndo/protocol";
import type { StatusContract } from "../config.ts";

export const STATUS_ASK = "Start a short answer with one line saying where this lane stands, then stop: STATUS: DONE, "
  + "STATUS: BLOCKED, STATUS: NEEDS DECISION, or STATUS: WAITING <on what> for <N> min. Don't redo the work.";

const pending = (v: unknown) => Array.isArray(v) && v.length > 0;

// The reason to send back with {"decision":"block"}, or null when this Stop is not asked.
export function statusAsk(body: unknown, window: string | null, contract: StatusContract): string | null {
  if (contract.mode !== "ask" || window === null || contract.exempt.includes(window)) return null;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.hook_event_name !== "Stop" || b.stop_hook_active === true) return null;
  if (pending(b.background_tasks) || pending(b.session_crons)) return null;
  if (typeof b.last_assistant_message !== "string") return null;
  return statusLineOf(firstLineOf(b.last_assistant_message)) === null ? STATUS_ASK : null;
}
