// Worker IDs across a fleet (docs/design/fleet-core/README.md §4, ADR-0012 decision 6): `<node>.<server>.<pane>`.
// - `node` names the machine;
// - `server` is the first 8 hex digits of the UUID its agent stamps on its tmux server (`@morndo-server`), so a
//   restarted server, which hands out `%0` and `%1` again, gives new IDs and an old one never reaches a reused pane;
// - `pane` is the number of tmux's own pane ID (`%N`), without leading zeros, so one pane has exactly one worker ID.
// URL-safe, and opaque to the app. The legacy single-host hub keeps tmux's `%N` (LEGACY_PANE_ID).
export const NODE_NAME = /^[a-z0-9-]{1,32}$/;
export const WORKER_ID = /^([a-z0-9-]{1,32})\.([0-9a-f]{8})\.(0|[1-9]\d{0,8})$/;
export const LEGACY_PANE_ID = /^%\d{1,9}$/;

export type WorkerRef = { node: string; server: string; pane: number };

// "pc.3fa2c1d0.12". A ref that can't make a worker ID is a bug in the caller: it throws, never builds a wrong ID.
export function formatWorkerId(ref: WorkerRef): string {
  const id = `${ref.node}.${ref.server}.${ref.pane}`;
  if (!Number.isSafeInteger(ref.pane) || !WORKER_ID.test(id)) throw new TypeError(`not a worker ID: ${JSON.stringify(ref)}`);
  return id;
}

// null for anything that isn't a worker ID, a legacy `%N` included.
export function parseWorkerId(id: string): WorkerRef | null {
  const m = WORKER_ID.exec(id);
  return m ? { node: m[1] as string, server: m[2] as string, pane: Number(m[3]) } : null;
}

export function isWorkerOrLegacyId(id: string): boolean {
  return WORKER_ID.test(id) || LEGACY_PANE_ID.test(id);
}

// The escalation for a menu on a worker's screen: "menu-pc_3fa2c1d0_12". A legacy `%3` gives "menu-3", the ID the hub
// has always given it, so the rows already kept in `decisions` keep their meaning.
export function menuEscalationId(workerId: string): string {
  return `menu-${workerId.replaceAll(".", "_").replaceAll("%", "")}`;
}
