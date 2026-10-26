// The queue decision two contexts share (ADR-0017 J5; ADR-0021 TX5): one class runs at most its limit, the rest wait
// in the order they were accepted, each with a visible position and a reason, and a guard delays a start and never
// stops a run. Pure: the caller passes the rows and the readings; this holds no clock and starts nothing.
// Jobs calls it per class (jobs.ts, schedule); Transcription calls it for its one class (transcription.ts).

export const QUEUE_REASONS = ["class", "load", "memory", "guard_unknown"] as const;
export type QueueReason = (typeof QUEUE_REASONS)[number];

// The node policy's optional load and memory line. `off` means no guard is configured; `unknown` is a configured
// guard that could not be read, which queues like any other reading over the line.
export type QueueGuard = "off" | "load" | "memory" | "unknown";

// What one waiting row gets: a free slot to start, or its place in line and why it waits.
export type QueueSlot = { start: boolean; position: number | null; reason: QueueReason | null };

// Enough of a row for the order: the key that tells it apart among its own rows — a Job's id, a Transcription's
// Recording and Language (two rows may share an id) — and when it was accepted.
export type QueueItem = { key: string; acceptedAt: number };

// The limit's free slots go to the earliest accepted (a tie by key); the rest wait from position 1 with the reason.
// A guard over the line (load, memory, unknown) holds every start, with the guard's own reason rather than `class`.
export function queueDecision(queued: readonly QueueItem[], running: number, limit: number, guard: QueueGuard): Map<string, QueueSlot> {
  let free = Math.max(0, limit - Math.max(0, running));
  const blocking = guard === "load" || guard === "memory" || guard === "unknown";
  const reason: QueueReason = free === 0 ? "class" : guard === "unknown" ? "guard_unknown" : guard === "off" ? "class" : guard;
  const order = [...queued].sort((a, b) => a.acceptedAt - b.acceptedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let position = 1;
  const out = new Map<string, QueueSlot>();
  for (const item of order) {
    if (free > 0 && !blocking) {
      free -= 1;
      out.set(item.key, { start: true, position: null, reason: null });
    } else {
      out.set(item.key, { start: false, position: position++, reason });
    }
  }
  return out;
}
