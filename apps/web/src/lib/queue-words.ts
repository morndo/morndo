// The manager's delivery queue in words (fleet-clients §9.1, Task 13; plan.md Wording): the three states exactly, and
// why a message or an answer still waits, in plain words, one for each reason the queue gives (a WaitingReason, spec
// §4.2), and once typed ("typed": not in the manager's conversation yet; "held": Claude Code holds it in its own queue).
// The same words for a message (the outbox) and an answer (the decision cards, the phone's Today). A reason this app
// doesn't know adds nothing it can't vouch for.
import type { GiveUpReason, WaitingReason } from "@morndo/protocol";

export const QUEUED = "Queued, it will be delivered";
export const DELIVERED = "Delivered";
export const MAY_HAVE_BEEN = "May have been delivered";
export const NOT_DELIVERED = "Not delivered";

// After "Queued, it will be delivered: ".
export const WAITING: Record<string, string> = {
  menu_open: "a menu is open in the manager's terminal; it goes in once that's answered",
  draft_present: "the manager's input box has text that isn't from Morndo; it goes in once that's sent or cleared",
  no_input_box: "the manager isn't showing its input box right now; it goes in once it does",
  busy: "something else is typing into the manager right now; it goes in right after",
  no_pane: "the manager isn't running right now; it goes in once it's back",
  no_session: "the manager is still starting; it goes in once it's ready",
  earlier: "an earlier message to the manager goes in first",
  unavailable: "the machine didn't answer, trying again",                 // reconciliation ruling 15
  typed: "it was typed, and the manager hasn't shown it in its conversation yet",
  held: "the manager is busy and holds it in its own queue; it takes it after its current step",
} satisfies Record<WaitingReason | "typed" | "held", string>;

// After "Nothing reached the manager: ".
export const GIVEN_UP: Record<string, string> = {
  expired: "it waited a whole day and was never typed",
  cancelled: "it was withdrawn before it was typed",
  gone: "the manager it was meant for was replaced before it could take it",
  refused: "the manager's machine refused it",
} satisfies Record<GiveUpReason, string>;

export const queuedLine = (waiting: string | null | undefined): string => {
  const why = waiting ? WAITING[waiting] : undefined;
  return `${QUEUED}${why ? `: ${why}` : ""}.`;
};
