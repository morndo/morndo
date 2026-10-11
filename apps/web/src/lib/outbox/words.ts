// How a Command in the outbox reads (ADR-0008 phase C; S4 to S8): where it stands, and why it didn't go, by the hub's
// code. One wording for the desktop's conversation and the phone's update card (review of PR #7, finding 12): the
// phone had its own short list and showed the hub's raw codes for the rest.
import { unreachable } from "@morndo/domain";
import { UNSEEN_AFTER_MS, type OutboxRecord } from "./state.ts";

// After the worker's name: "builder is showing a menu. …". The desktop says where to look as "the Terminal tab".
const PROBLEMS: Record<string, string> = {
  menu_open: "is showing a menu. Answer it in the Terminal tab first.",
  draft_present: "has unsent text in its input box, typed there by someone or something else. Look at its Terminal tab, then try again.",
  no_input_box: "isn't showing its input box, so nothing was typed. Its agent may have exited: look at its Terminal tab.",
  not_submitted: "didn't take the message. Check its Terminal tab.",
  no_pane: "is no longer running.",
  busy: "is being typed into by something else right now. Try again in a few seconds.",
  too_long: "can't take a message this long (8000 characters at most).",
  not_yours: "can't take that file: it was uploaded from another device.",
  unknown_upload: "can't take that file anymore. Attach it again.",
  expired: "can't take that file anymore: it's over a day old. Attach it again.",
  too_many: "can take at most 6 files per message.",
  // Fleet core §3.1: an attached file is put on the worker's machine before anything is typed.
  too_large: "can't take that file: it's too big for its machine, so nothing was typed. Attach a smaller one.",
  node_offline: "is on a machine that isn't answering right now, so nothing was typed. Try again once it's back.",
  // The node or the fleet refused it saying nothing ran (fleet core §5.3; the fix wave releases the send on any refusal
  // with executed "no"), so these come back as Not sent. Nothing was typed.
  denied: "is on a machine that doesn't let Morndo type into it (its node policy), so nothing was typed.",
  bad_args: "couldn't be reached: the fleet refused the message as malformed, so nothing was typed. If its window name has a tab or another control character in it, rename the window, then try again.",
  unknown_op: "is on a machine whose Morndo agent is too old to type messages, so nothing was typed. Update Morndo on that machine.",
  internal: "is on a machine that couldn't record the message before typing it (a full disk?), so nothing was typed. Try again once it has room.",
  name_taken: "shares its name with a lane on another machine, so nothing was typed. Rename one of them, then try again.",
  lane_conflict: "shares its name with another window, so nothing was typed: nobody can tell which one it's for. Rename one of them, then try again.",
};
const REASONS: Record<string, string> = {
  stale: "The question changed: review before sending.",
  step_up: "Not sent: verify with your passkey, then it goes.",
  timeout: "The hub didn't answer within 2 minutes. Retry checks whether it went in; it is never typed twice.",
  closed: "The app closed before the hub answered. Retry checks whether it went in; it is never typed twice.",
  rate_limited: "The hub asked to wait for longer than 2 minutes.",
  // The hub can't say whether it was typed (fleet core §3.1, §7): it stopped while typing it, or the worker's machine may
  // have typed it before its answer was lost. Check again sends the same request id; a fleet hub asks that machine, which
  // may settle it, but it stays here when nobody can say: the machine's store is unknown, changed or behind, and always
  // on the legacy hub, which has no machine to ask (the residual round: the words promised it would be typed).
  uncertain: "May have been sent. Check again asks whether it was typed; if that can't be known, it stays here, so look at the worker's screen before sending it again.",
  not_delivered: "Not sent: that command is no longer in the inbox, so it cannot be sent again.",
};

// A message waits behind an earlier one of the same conversation that is Not sent or Uncertain (review M3).
export const heldBehind = (o: OutboxRecord, all: readonly OutboxRecord[]) =>
  all.some(x => x.worker === o.worker && x.createdAt < o.createdAt && (x.state === "failed" || x.state === "uncertain"));

// Why it didn't go, in words. `screen`: where to look at the worker's screen ("the Terminal tab" on the desktop).
export function sendReason(o: OutboxRecord, name: string, screen = "the Terminal tab"): string {
  if (o.error === null) return "";
  const problem = PROBLEMS[o.error];
  if (REASONS[o.error]) return REASONS[o.error] ?? "";
  if (!problem) return `Not sent: the hub answered "${o.error}".`;
  return `${name} ${screen === "the Terminal tab" ? problem : problem.replace(/(the|its) Terminal tab/g, screen)}`;
}

// Where it stands, in words (S8).
export function sendLabel(o: OutboxRecord, all: readonly OutboxRecord[], now: number): string {
  switch (o.state) {
    case "queued": return heldBehind(o, all) ? "Waiting for the message above" : o.attempts === 0 ? "Queued" : "Waiting to send…";
    case "sending": return "Sending…";
    case "sent":
      // Queued in the manager's inbox. "Not sent" only when the spool expired it, still untyped. A command it has
      // accepted, sent, stuck or left unconfirmed has no deadline and keeps its own words. One typed directly
      // keeps the "not seen yet" warning.
      if (o.queued) return queuedPlace(o);
      return o.sentAt !== null && now - o.sentAt > UNSEEN_AFTER_MS ? "Sent, not seen in the conversation yet" : "Sent";
    case "failed": return "Not sent";
    case "uncertain": return "May have been sent";
    default: return unreachable(o.state);
  }
}

function queuedPlace(o: OutboxRecord): string {
  if (o.inbox === "expired") return "Not sent";
  if (o.inbox === "accepted") return "Accepted, waiting to be delivered";
  if (o.inbox === "stuck") return "Stuck, still waiting to be delivered";
  if (o.inbox === "sent" && o.inboxReason === "unconfirmed") return "Sent, not confirmed in the conversation yet";
  if (o.inbox === "sent") return "Sent, not seen in the conversation yet";
  if (o.inbox === "typing") return "Being typed";
  if (o.inbox === "held") return "Held, it will be delivered";
  if (o.inbox === "lost") return "Lost from the queue";
  if (o.inbox === "cancelled") return "Cancelled";
  if (o.inbox === "gone") return "Not in the inbox";
  return "Queued, it will be delivered";
}
