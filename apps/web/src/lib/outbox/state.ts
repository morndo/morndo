// The outbox's rules (ADR-0008 phase C; S4–S8 in docs/domain.md), pure: send states that only move forward, the retry
// schedule and budget, and matching the principal's echoed messages to what was sent. Design reference, not code:
// Signal-Desktop ts/messages/MessageSendState.std.ts (a ranked state, the higher rank wins) and
// ts/jobs/conversationJobQueue.preload.ts (a wall-clock budget from the job's creation).
import { LIMITS } from "@morndo/protocol";

export type SendState = "queued" | "sending" | "sent" | "failed" | "uncertain";

// A message to the manager through the fleet's delivery queue (fleet-clients §9.1): where it stands there, as the hub
// says (its send answer, then each `deliveries` frame): queued (with why it waits), delivered, uncertain (it may have
// reached the manager), or given up (with why: nothing reached it). Its record stays Sent: the hub took it (S8).
export type CommandDelivery = { state: "queued" | "delivered" | "uncertain" | "given_up"; waiting: string | null; why: string | null };

// One Command in the outbox (S4). `id` is the request id, the same for every attempt (S5). `seen` is the needs-you
// state the principal saw when he wrote it (S6): "none", or the question or menu it answers.
export type OutboxRecord = {
  id: string;
  worker: string;
  workerName: string;
  text: string;
  uploads: string[];
  createdAt: number;
  budgetFrom: number;             // when its 2 minutes started: createdAt, or the principal's last Retry (S7)
  state: SendState;
  error: string | null;           // the reason, while Not sent or Uncertain
  attempts: number;
  seen: string;
  sentAt: number | null;          // when the hub said it typed it, on this device's clock (for "not seen yet")
  // The same moment on the clock of the machine that typed it, which its transcript's times are on (fleet core §3.1;
  // the hub's clock before, review M2). A record kept from before has `hubAt` instead: read as the same.
  typedAt: number | null;
  hubAt?: number | null;
  delivery?: CommandDelivery;
  again?: true;                   // this attempt is Send again (ADR-0011); a status read never sets it
  resent?: true;                  // Send again queued it once more; a later given-up is final
  resendFailed?: true;            // given up, and Send again couldn't queue it once more (the hub's cannot_resend)
  // The hub's store when this was written (RL10, §11.5): stamped on every attempt and never rewritten, so a hub whose
  // database was put back — another store — answers "uncertain" instead of typing it twice. None before any answer.
  hubStore?: string;
};

// The hub's `delivery` on a send answer, or null when it gives none (a message typed directly). A state this app
// doesn't know reads as queued: it never claims a delivery it can't vouch for.
export function commandDelivery(v: unknown): CommandDelivery | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const state = o.state === "delivered" || o.state === "uncertain" || o.state === "given_up" ? o.state : "queued";
  return { state, waiting: typeof o.waiting === "string" ? o.waiting : null, why: typeof o.why === "string" ? o.why : null };
}

// Forward only (S8): queued < sending < sent. Failed may come from queued or sending, never from sent; uncertain is
// the hub's word on a send it may have typed, and only Check again leaves it (fleet core §3.1): to Sent (the hub found
// it typed, or typed it now), or to Not sent (the hub judged it anew and refused it: nothing was typed). The ways back
// are the principal's Retry (failed to queued, `retry`) and, for a message the manager's queue gave up, Send again.
const RANK: Record<SendState, number> = { queued: 0, sending: 1, sent: 2, failed: 1.5, uncertain: 3 };
export function advance(from: SendState, to: SendState, retry = false): SendState {
  if (retry) return from === "failed" ? "queued" : from;
  if (from === "uncertain") return to === "sent" || to === "failed" ? to : from;
  if (from === "sent") return from;                                    // a late error never undoes Sent
  if (to === "failed") return from === "failed" ? from : "failed";
  if (from === "failed") return from;                                  // only Retry leaves Not sent
  return RANK[to] >= RANK[from] ? to : from;
}

export const BUDGET_MS = 2 * 60_000;              // S7: an agent must not get a stale instruction (Signal's is a day)
export const RETRY_MS = [1500, 3000, 6000, 12_000] as const;
export const RETRY_CAP_MS = 15_000;
export const ECHO_SLACK_MS = 5000;                // an echo is a principal message no older than createdAt minus this
export const UNSEEN_AFTER_MS = 10 * 60_000;       // Sent but not echoed this long: say so
export const HUB_KEEPS_MS = 24 * 3_600_000;       // S5: the hub's record of a request id
// One POST with no answer by then is given up and tried again (H3). Longer than the hub may take for a message to the
// manager: the fleet waits up to LIMITS.deliveryOpTimeoutMs for the node, the hub's client 2 s more. A shorter one sends
// it again while the first is still out.
export const ATTEMPT_TIMEOUT_MS = LIMITS.deliveryOpTimeoutMs + 5_000;
// Retry only while a full 2 minutes started now would still end inside the hub's record, with margin (review L1).
export const RETRY_WINDOW_MS = HUB_KEEPS_MS - BUDGET_MS - 5 * 60_000;

export const retryDelay = (attempt: number) => RETRY_MS[attempt] ?? RETRY_CAP_MS;
export const withinBudget = (r: Pick<OutboxRecord, "createdAt">, now: number) => now - r.createdAt < BUDGET_MS;
// Retry on Not sent, Check again on Uncertain: the same request id both times, so the hub types it at most once (S5).
// A message the manager's queue has is Sent: never retried (ruling 83). It waits there up to 24 hours, or is cancelled.
// Refusals a retry can't change: the text itself has to (over the length a lane takes, or nothing left of it once control
// characters go). A Retry there could only fail again: Edit instead (the rage QA: a long paste offered a Retry that never
// worked).
const LASTING = new Set(["too_long", "empty"]);
export const canRetry = (r: OutboxRecord, now: number) =>
  (r.state === "failed" || r.state === "uncertain") && !(r.state === "failed" && LASTING.has(r.error ?? "")) && now - r.createdAt < RETRY_WINDOW_MS;
// Edit: back into its box to be read or changed first: the question it was written for changed, or its text can't go as
// it is.
export const canEdit = (r: OutboxRecord) => r.state === "failed" && (r.error === "stale" || LASTING.has(r.error ?? ""));
// The longest text one message can carry (the hub refuses longer: too_long).
export const MAX_TEXT = LIMITS.maxMessageText;
// Cancel: a message the manager's queue still holds, not typed yet (ruling 83). Once typed it can't be taken back.
export const canCancel = (r: OutboxRecord) => r.state === "sent" && r.delivery?.state === "queued" && r.delivery.waiting !== "typed" && r.delivery.waiting !== "held";

export type Echo = { id: string; at: number; text: string };

// Which Sent records the conversation has echoed (S8): only principal messages no older than a record's typing minus
// 5 s count, on the typing machine's clock when known (its transcript's times are on it; fleet core §3.1), else createdAt.
// Each echo ends at most one record, and the oldest record goes first, so two identical texts don't both vanish on one
// echo; `used` carries the echoes already spent by earlier calls (review M1). A delivery that was given up was never
// typed, so it has no echo to spend. `text` is compared trimmed (the echo carries image notes after the text; the
// caller strips them).
export function matchEchoes(records: readonly OutboxRecord[], echoes: readonly Echo[], used: Set<string> = new Set()): Map<string, string> {
  const matched = new Map<string, string>();       // record id → echo id
  const sent = records.filter(r => r.state === "sent" && r.delivery?.state !== "given_up").sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const byTime = [...echoes].sort((a, b) => a.at - b.at);
  for (const r of sent) {
    const want = r.text.trim();
    const e = byTime.find(x => !used.has(x.id) && x.at >= (r.typedAt ?? r.hubAt ?? r.createdAt) - ECHO_SLACK_MS && x.text.trim() === want);
    if (!e) continue;
    used.add(e.id);
    matched.set(r.id, e.id);
  }
  return matched;
}
