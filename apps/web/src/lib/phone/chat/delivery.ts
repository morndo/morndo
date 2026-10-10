// Where his message stands, as a chat app says it (ADR-0011; S4–S8, ADR-0010): Sending, Queued (waiting for the
// connection, or in the manager's inbox until its pane is free), Delivered (typed into a lane, or seen in the
// manager's conversation), or Not sent with the reason and Retry. Never a silent drop: every outbox entry has one, and
// none stays good forever without its echo (review, 2026-10-05): typed into a lane but not seen in its conversation
// after 10 minutes, it warns ("unseen"); in the manager's inbox and not delivered after 60 minutes (the inbox's last
// alert to the owner), it is Not sent ("lost"), with Send again: the same request id again, which the hub queues once
// more only if the inbox gave the first up (steering-service #queueAgain). A late echo still ends either (S8).
// Signal's words for the same steps: Sending, Sent, Delivered (support.signal.org/hc/en-us/articles/360007320751,
// read 2026-10-05); "Sent" to a server we can't vouch for reads here as Queued, since the manager may not have it yet.
import { INBOX_GIVEN_UP, UNSEEN_AFTER_MS, inboxPlace, type OutboxRecord } from "../../outbox/state.ts";
import { heldBehind } from "../../outbox/words.ts";

export type Delivery = "sending" | "queued" | "late" | "delivered" | "arrived" | "unseen" | "lost" | "dead" | "failed" | "uncertain";
// The inbox's word that it reached the manager's conversation (delivered), or the manager's own queue in its transcript
// (accepted): final, even if this chat never matches its echo (medium verify of the review fixes, issue 2).
const ARRIVED = new Set(["delivered", "accepted"]);

export const QUEUED_GIVE_UP_MS = 60 * 60_000;
const REASON_WORDS: Record<string, string> = {
  menu: "a menu is open on its screen", foreign_text: "someone else's text is in its box", no_manager: "the manager isn't running",
  busy: "its pane is busy", lock: "someone else is typing into its pane", unseen: "typed, not confirmed yet", unconfirmed: "typed, not confirmed yet",
  lost_in_queue: "it fell out of the manager's queue and needs a person on the box",
};
const STATUS_WORDS: Record<string, string> = {
  queued: "waiting its turn", held: "waiting for its box", typing: "being typed", sent: "typed, not confirmed yet", stuck: "typed, still in its box",
  accepted: "queued by the manager", lost: "it fell out of the manager's queue and needs a person on the box", delivered: "delivered, not shown here yet",
};
const where = (i: { status: string; reason: string | null }) => (i.reason ? REASON_WORDS[i.reason] : undefined) ?? STATUS_WORDS[i.status] ?? i.status;

export function deliveryOf(r: OutboxRecord, now = Date.now()): Delivery {
  const since = now - (r.sentAt ?? r.createdAt);
  const place = inboxPlace(r.inbox, r.inboxReason);
  switch (r.state) {
    case "queued": return "queued";
    case "sending": return "sending";
    case "sent":
      if (!r.queued) return since > UNSEEN_AFTER_MS ? "unseen" : "delivered";
      if (place && ARRIVED.has(place.status)) return "arrived";
      if (place && INBOX_GIVEN_UP.has(place.status)) return r.resendFailed ? "dead" : "lost";
      return since > QUEUED_GIVE_UP_MS ? "late" : "queued";
    case "failed": return "failed";
    case "uncertain": return "uncertain";
  }
}

// Only what the inbox said: Not sent only once it gave the message up (review #2, the team's call A).
export const lostReason = () => "Not sent: the manager's inbox gave it up. Send again queues it once more.";
export const deadReason = () => "Not sent: the manager's inbox gave it up, and it can't be queued again. Write it again as a new message, or discard it.";
export const lateReason = () => "It may still be typed in. Check asks the hub where it stands.";

export function deliveryLabel(r: OutboxRecord, all: readonly OutboxRecord[], online: boolean, now = Date.now()): string {
  const d = deliveryOf(r, now);
  const place = inboxPlace(r.inbox, r.inboxReason);
  const inInbox = place && place.status !== "queued" ? `Still waiting in the manager's inbox: ${where(place)}` : null;
  if (d === "late") return inInbox ?? (place ? `Still waiting in the manager's inbox: ${where(place)}` : "Not delivered after 60 min");
  if (d === "queued" && r.state === "sent") return inInbox ?? "Queued for the manager · delivered when its box is free";
  if (d === "queued") return heldBehind(r, all) ? "Waiting for the message above" : online ? "Queued" : "Queued · sends when you're back online";
  if (d === "sending") return "Sending…";
  if (d === "delivered") return "Delivered";
  if (d === "arrived") return "Delivered to the manager, not shown in this chat";
  if (d === "unseen") return "Typed in, but not seen in its conversation after 10 min: check its Screen";
  if (d === "uncertain") return "May have been sent";
  return "Not sent";
}
