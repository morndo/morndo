// The manager is always on the phone's and the desktop's list (fleet-clients §9.1; the owner, 2026-10-12). While it has no
// window (a restart) the app lists it as not running, under an id that is never a worker the hub knows: a message written
// to it goes to POST /api/manager/send, which waits in the fleet's queue for the manager's sticky lane (with the queue on).
import type { RosterEntry } from "@morndo/domain";

export const MANAGER = "manager";
export const ABSENT_MANAGER = "manager:absent";

export const absentManager = (): RosterEntry => ({
  id: ABSENT_MANAGER as RosterEntry["id"], name: MANAGER, location: "", node: "", title: null, lastMessageAt: null, needsYou: false, waitingOn: null,
  state: "quiet", changedAt: 0, offline: false,
});

// The outbox records one conversation shows and closes by their echo: its window's, and, for the manager's, those written
// while it had none (they reach whichever window it has next).
export const sentTo = (r: { worker: string }, w: { id: string; name: string }) => r.worker === w.id || (w.name === MANAGER && r.worker === ABSENT_MANAGER);
