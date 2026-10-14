// Where his message stands, as a chat app says it (ADR-0011; S4–S8): Sending, Queued (waiting for the connection, or in
// the manager's queue until it can be typed: fleet-clients §9.1), Delivered (typed into a lane, or seen in the manager's
// conversation), or Not sent with the reason and Retry. Never a silent drop: every outbox entry has one, and none stays
// good forever without its echo: typed into a lane but not seen in its conversation after 10 minutes, it warns
// ("unseen"). A message the manager's queue gave up is Not delivered ("lost"), with Send again: the same request id,
// flagged, which the hub queues once more as the next attempt (steering-service #sendAgain). A second copy given up, or
// one the hub can't queue again, is final ("dead"). A late echo still ends either (S8).
// Signal's words for the same steps: Sending, Sent, Delivered (support.signal.org/hc/en-us/articles/360007320751,
// read 2026-10-05); the manager's queue speaks its own (queue-words.ts, the fleet-clients plan's Wording).
import { UNSEEN_AFTER_MS, type OutboxRecord } from "../../outbox/state.ts";
import { heldBehind } from "../../outbox/words.ts";
import { GIVEN_UP, MAY_HAVE_BEEN, NOT_DELIVERED, queuedLine } from "../../queue-words.ts";

export type Delivery = "sending" | "queued" | "delivered" | "arrived" | "maybe" | "unseen" | "lost" | "dead" | "failed" | "uncertain";

export function deliveryOf(r: OutboxRecord, now = Date.now()): Delivery {
  const since = now - (r.sentAt ?? r.createdAt);
  switch (r.state) {
    case "queued": return "queued";
    case "sending": return "sending";
    case "sent":
      if (!r.delivery) return since > UNSEEN_AFTER_MS ? "unseen" : "delivered";
      if (r.delivery.state === "delivered") return "arrived";
      if (r.delivery.state === "uncertain") return "maybe";
      if (r.delivery.state === "given_up") return r.resent || r.resendFailed ? "dead" : "lost";
      return "queued";
    case "failed": return "failed";
    case "uncertain": return "uncertain";
  }
}

const why = (r: OutboxRecord) => {
  const w = r.delivery?.why;
  return w && GIVEN_UP[w] ? `: ${GIVEN_UP[w]}` : "";
};
export const lostReason = (r: OutboxRecord) => `${NOT_DELIVERED}${why(r)}. Send again queues it once more.`;
export const deadReason = (r: OutboxRecord) => `${NOT_DELIVERED}${why(r)}, and it can't be queued again. Write it again as a new message, or discard it.`;
export const maybeReason = () => "It was typed, but never seen in the manager's conversation. Look at its Screen before sending it again.";

export function deliveryLabel(r: OutboxRecord, all: readonly OutboxRecord[], online: boolean, now = Date.now()): string {
  const d = deliveryOf(r, now);
  if (d === "queued" && r.state === "sent") return queuedLine(r.delivery?.waiting).replace(/\.$/, "");
  if (d === "queued") return heldBehind(r, all) ? "Waiting for the message above" : online ? "Queued" : "Queued · sends when you're back online";
  if (d === "sending") return "Sending…";
  if (d === "delivered") return "Delivered";
  if (d === "arrived") return "Delivered to the manager, not shown in this chat";
  if (d === "maybe") return MAY_HAVE_BEEN;
  if (d === "unseen") return "Typed in, but not seen in its conversation after 10 min: check its Screen";
  if (d === "uncertain") return "May have been sent";
  if (d === "lost" || d === "dead") return NOT_DELIVERED;
  return "Not sent";
}
