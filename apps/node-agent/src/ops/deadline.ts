// A request's deadline (spec §5.3, "Deadlines"): it starts when the request arrives and ends `timeoutMs` − 250 ms
// later (LIMITS.deadlineMarginMs), measured on performance.now(), so a wall-clock jump changes nothing (plan Review
// Focus 4). A side effect that hasn't started by then doesn't start: the answer is `timeout`, not executed.
import { LIMITS } from "@morndo/protocol";

export type Deadline = { remainingMs(): number; expired(): boolean };

export function startDeadline(timeoutMs: number, now: () => number = () => performance.now()): Deadline {
  const budget = Number.isFinite(timeoutMs) ? timeoutMs : 0;
  const end = now() + budget - LIMITS.deadlineMarginMs;
  return {
    remainingMs: () => Math.max(0, end - now()),
    expired: () => now() >= end,
  };
}
