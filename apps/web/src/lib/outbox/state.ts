// The outbox's rules (ADR-0008 phase C; S4–S8 in docs/domain.md), pure: send states that only move forward, the retry
// schedule and budget, and matching the principal's echoed messages to what was sent. Design reference, not code:
// Signal-Desktop ts/messages/MessageSendState.std.ts (a ranked state, the higher rank wins) and
// ts/jobs/conversationJobQueue.preload.ts (a wall-clock budget from the job's creation).

export type SendState = "queued" | "sending" | "sent" | "failed" | "uncertain";

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
  queued?: boolean;               // Sent into the manager's inbox (ADR-0010): it types it once the pane is free
  // Where that inbox says the command stands. A string is the spool's word (inbox-v2). The object form is the same
  // word as the phone's chat tests state it (ADR-0011): status plus reason together.
  inbox?: "queued" | "held" | "typing" | "sent" | "stuck" | "accepted" | "delivered" | "lost" | "expired" | "cancelled" | "gone" | { status: string; reason: string | null };
  inboxReason?: string | null;   // "unconfirmed" is a reason on a sent command, not a status of its own
  revive?: true;                  // this attempt is the owner's Retry; a plain repeat must not set it
  again?: true;                   // this attempt is Send again; a status check must not set it
  resent?: true;                  // Send again already queued a second copy; a later given-up is final
  resendFailed?: true;            // given up, and a Send again couldn't queue it once more (ADR-0011)
};

// Forward only (S8): queued < sending < sent. Failed may come from queued or sending, never from sent; uncertain is
// the hub's word on a send it may have typed, and only Check again leaves it (fleet core §3.1): to Sent (the hub found
// it typed, or typed it now), or to Not sent (the hub judged it anew and refused it: nothing was typed). The ways back
// are the principal's Retry (failed to queued, `retry`) and, for a Command Sent into the manager's inbox, Send again.
const RANK: Record<SendState, number> = { queued: 0, sending: 1, sent: 2, failed: 1.5, uncertain: 3 };
export function advance(from: SendState, to: SendState, retry = false): SendState {
  if (retry) return from === "failed" ? "queued" : from;
  if (from === "uncertain") return to === "sent" || to === "failed" ? to : from;
  if (from === "sent") return from;                                    // a late error never undoes Sent
  if (to === "failed") return from === "failed" ? from : "failed";
  if (from === "failed") return from;                                  // only Retry leaves Not sent
  return RANK[to] >= RANK[from] ? to : from;
}

// The manager's inbox's states in which a message will never be typed, as the hub counts them (steering-service GIVEN_UP).
export const INBOX_GIVEN_UP: ReadonlySet<string> = new Set(["expired", "cancelled", "gone"]);

// The spool word, whether the record keeps it as a string (inbox-v2) or as status and reason together (the phone's tests).
export function inboxPlace(inbox: OutboxRecord["inbox"] | undefined, reason?: string | null): { status: string; reason: string | null } | null {
  if (inbox === undefined) return null;
  if (typeof inbox === "string") return { status: inbox, reason: reason ?? null };
  return inbox;
}

export const BUDGET_MS = 2 * 60_000;              // S7: an agent must not get a stale instruction (Signal's is a day)
export const RETRY_MS = [1500, 3000, 6000, 12_000] as const;
export const RETRY_CAP_MS = 15_000;
export const ECHO_SLACK_MS = 5000;                // an echo is a principal message no older than createdAt minus this
export const UNSEEN_AFTER_MS = 10 * 60_000;       // Sent but not echoed this long: say so
export const HUB_KEEPS_MS = 24 * 3_600_000;       // S5: the hub's record of a request id
export const ATTEMPT_TIMEOUT_MS = 15_000;          // one POST with no answer by then is given up and tried again (H3)
// Retry only while a full 2 minutes started now would still end inside the hub's record, with margin (review L1).
export const RETRY_WINDOW_MS = HUB_KEEPS_MS - BUDGET_MS - 5 * 60_000;

export const retryDelay = (attempt: number) => RETRY_MS[attempt] ?? RETRY_CAP_MS;
export const withinBudget = (r: Pick<OutboxRecord, "createdAt">, now: number) => now - r.createdAt < BUDGET_MS;
// Retry on Not sent, Check again on Uncertain: the same request id both times, so the hub types it at most once (S5).
// A queued command is Not sent only once the spool expired it, still untyped. accepted, sent, stuck and unconfirmed
// have no such deadline, so the two minutes passing is not a reason to retry them.
export const canRetry = (r: OutboxRecord, now: number) =>
  ((r.state === "failed" || r.state === "uncertain") && now - r.createdAt < RETRY_WINDOW_MS)
  || (r.queued === true && r.state === "sent" && (r.inbox === "expired" || r.inbox === "lost" || r.inbox === "cancelled") && now - r.createdAt < RETRY_WINDOW_MS);

export type Echo = { id: string; at: number; text: string };

// Which Sent records the conversation has echoed (S8): only principal messages no older than a record's typing minus
// 5 s count, on the typing machine's clock when known (its transcript's times are on it; fleet core §3.1), else createdAt.
// Each echo ends at most one record, and the oldest record goes first, so two identical texts don't both vanish on one
// echo; `used` carries the echoes already spent by earlier calls (review M1). `text` is compared trimmed (the echo
// carries image notes after the text; the caller strips them).
export function matchEchoes(records: readonly OutboxRecord[], echoes: readonly Echo[], used: Set<string> = new Set()): Map<string, string> {
  const matched = new Map<string, string>();       // record id → echo id
  const sent = records.filter(r => r.state === "sent").sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
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
