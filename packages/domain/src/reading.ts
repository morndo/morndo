// Reading (Observation, ADR-0008 phase D; O7–O9 in docs/domain.md): read marks follow the principal across his
// Endpoints. A Read mark only moves forward, a mark later than both the newest message and the hub's clock is clamped
// to the later of the two, and it grants and starts nothing (O8): nothing here makes a Mandate, a Decision or an
// Acknowledgement, or touches a timer.

// The mark to store for a Conversation, or null when `proposed` changes nothing (O7). `now` is the hub's clock: a
// device whose clock runs fast can't push the mark past it and hide unread messages on every device.
// `newest`: the time of the Conversation's newest message as the hub holds it. In fleet mode that is a node's clock, which
// may run ahead of the hub's (FL13: correctness never depends on the clocks agreeing): a mark may reach it, never pass
// it, so reading the newest message always settles it.
export function advanceReadMark(stored: number | null, proposed: number, now: number, newest: number | null = null): number | null {
  if (!Number.isFinite(proposed) || proposed < 0) return null;
  const at = Math.min(proposed, Math.max(now, newest ?? 0));
  return stored !== null && at <= stored ? null : at;
}

// O9: an older page holds at most this many messages.
export const OLDER_PAGE = 100;
