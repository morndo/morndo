// The Updates page's words (updates design §8.2 "Settings → Updates", PR 6c part 2): from an UpdatesView — the
// control plane's own updater status, the fleet's Rollout and nodes — the rows the page shows, one per machine, the
// control plane first ("This machine", named control-plane as the hub's updates service does), then the nodes by
// name. Pure words: no Svelte, no fetch. A node's Channel and mode are its own machine's word (`morndo update` on
// it); the view does not carry them, so the row says null and the page says so, never a guess. The control plane's
// own node (the hub's MORNDO_CONTROL_PLANE_NODE) is folded into This machine: it has no row of its own.
import { compareVersions, parseVersion } from "@morndo/domain";
import type { NodeUpdateHealth, RolloutWire, UpdateStateFile, UpdatesNode, UpdatesView, UpdaterStatus } from "@morndo/protocol";

export type UpdatesRow = {
  /** What a command posts: "control-plane" (this machine, through its updater CLI) or a node's name (through the fleet). */
  machine: string;
  /** The name the row shows: "This machine" or the node's name. */
  title: string;
  /** What runs on it, as known here; null before it said one. */
  version: string | null;
  /** The control plane's own words; null on a node — unknown here, not invented. */
  channel: string | null;
  mode: string | null;
  /** The one state sentence (§8.2): up to date, staged, applying, waiting and why, rolled back, needs update, offline. */
  state: string;
  /** The Version "Update now" posts, when the row offers it. */
  apply: string | null;
  /** The Version "Roll back" returns to, on the control plane only, when its status names one. */
  rollback: string | null;
  /** A node instead of a Roll back button: its rollback is its own hand (§5.4), the command to run on it. */
  rollbackNote: string | null;
};

export type RolloutLine = { version: string; sentence: string; resume: boolean };

// The machine the hub itself runs on, as its updates service names it (apps/hub/src/application/updates-service.ts).
const CONTROL_PLANE = "control-plane";

const above = (a: string, b: string): boolean => {
  const x = parseVersion(a), y = parseVersion(b);
  return x !== null && y !== null && compareVersions(x, y) > 0;
};

// The states of an update in flight (the domain's own, releases.ts' UPDATE_STATES): what the control plane's newest
// update row means as a sentence. Terminal states fall through to the machine's standing state below.
const APPLYING = new Set(["draining", "stopping", "backing_up", "swapping", "starting", "probation"]);

const controlPlaneState = (status: UpdaterStatus | null, record: UpdateStateFile | null): string => {
  if (status === null) return "this machine's updater did not answer";
  const newest = status.updates?.[0] ?? null;
  if (newest !== null) {
    if (APPLYING.has(newest.state)) return `applying ${newest.target}`;
    if (newest.state === "rolling_back") return "rolling back";
    if (newest.state === "rolled_back") return `rolled back from ${newest.target}`;
    if (newest.state === "rollback_failed") return "rollback failed";
  }
  // Why a staged Version waits: the updater's own last record (its state.json), which --status does not carry.
  if (status.staged !== null && record !== null && record.state === "waiting" && record.reason !== undefined) {
    return `waiting: ${reasonWords(record.reason)}`;
  }
  if (status.staged !== null) return `staged ${status.staged} (ready to apply)`;
  return "up to date";
};

// A waiting updater's own reason (state.json's reason token), made readable. The words follow the updater's own
// sentences (apps/updater/src/application/fleet-follow.ts and cli.ts, which writes "skew_blocked: n2, n3"); a token
// from a newer updater stays as it came, untranslated rather than wrong.
const REASONS: Record<string, string> = {
  no_view: "no fresh word from the control plane",
  not_committed: "the control plane has not committed the target's Rollout, or offered it to this node",
  waiting_control_plane: "the control plane runs below the Rollout it committed",
  halted: "the target's Rollout is halted",
  waiting_soak: "the control plane's soak is still running",
  waiting_jitter: "this node's own delay is still running",
  node_ahead: "the target is above this node's control plane",
  fleet_unreachable: "the fleet cannot be asked for its nodes, so the apply waits",
};
const reasonWords = (reason: string): string => {
  if (reason.startsWith("skew_blocked")) {
    const nodes = reason.slice("skew_blocked".length).replace(/^:\s*/, "");
    return nodes === ""
      ? "the target would drop an agent protocol a joined node still speaks"
      : `the target would drop an agent protocol these nodes still speak: ${nodes}`;
  }
  return REASONS[reason] ?? reason;
};

// A Version the state names; the domain always sends one for staged, applying and rolled back, and this never invents
// a different one when it doesn't.
const movingTo = (u: NodeUpdateHealth): string => u.target ?? "a Version it did not name";

// §11.4's ask, worded as the CLI words it (apps/updater/src/cli.ts): one line per database a rollback's restore
// would put back, naming the Backup's own moment and the span of writes the restore drops — the same sentence the
// terminal prints before the word. `at` is the preview's ISO text; the moment is shown as this device reads it.
const two = (n: number): string => String(n).padStart(2, "0");
const rollbackAgeWords = (ms: number): string => {
  if (ms < 60_000) return "less than a minute";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
};
export const rollbackRestoreLine = (r: { db: string; at: string }, now = Date.now()): string => {
  const t = new Date(r.at);
  const stamp = `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())} ${two(t.getHours())}:${two(t.getMinutes())}`;
  return `The ${r.db} database goes back to its backup from ${stamp} (${rollbackAgeWords(now - t.getTime())} of writes since are dropped).`;
};

const nodeState = (n: UpdatesNode, rollout: RolloutWire | null, controlPlane: string): string => {
  if (n.status === "offline") return "offline";
  const running = n.update?.version ?? n.version;
  // Left above the control plane (its rollback halted the Version it left): the fleet sends it nothing, so it waits
  // until this machine catches up or its own rollback (RL11).
  if (running !== null && above(running, controlPlane)) {
    return `runs above this machine's ${controlPlane}: roll it back with morndo update --rollback on ${n.name}, or update this machine`;
  }
  const needs = rollout !== null && rollout.controlPlaneCommittedAt !== null && running !== null && above(rollout.version, running);
  if (n.update === null) return needs ? "needs update" : "no update report yet";
  switch (n.update.state) {
    case "current": return needs ? "needs update" : "up to date";
    case "staged": return `staged ${movingTo(n.update)} (ready to apply)`;
    case "applying": return `applying ${movingTo(n.update)}`;
    case "waiting": return n.update.reason === undefined ? "waiting" : `waiting: ${reasonWords(n.update.reason)}`;
    case "rolled_back": return `rolled back from ${movingTo(n.update)}${n.update.failedCheck !== undefined ? `: ${n.update.failedCheck} failed` : ""}`;
    case "rollback_failed": return "rollback failed";
  }
};

const controlPlaneRow = (v: UpdatesView): UpdatesRow => {
  const s = v.controlPlane.status;
  return {
    machine: CONTROL_PLANE,
    title: "This machine",
    version: v.controlPlane.version,
    channel: s?.channel ?? null,
    mode: s?.mode ?? null,
    state: controlPlaneState(s, v.controlPlane.state),
    apply: s !== null && s.staged !== null ? s.staged : null,
    rollback: s !== null && s.previous !== null ? s.previous : null,
    rollbackNote: null,
  };
};

const nodeRow = (n: UpdatesNode, rollout: RolloutWire | null, controlPlane: string): UpdatesRow => {
  const running = n.update?.version ?? n.version;
  return {
    machine: n.name,
    title: n.name,
    version: running,
    channel: null,
    mode: null,
    state: nodeState(n, rollout, controlPlane),
    // A node takes the Rollout's Version when it stands above its own and the Rollout is not halted; whether it is
    // committed the fleet answers in its own words if it refuses (RL11, RL12).
    apply: rollout !== null && !rollout.halted && running !== null && above(rollout.version, running) && !above(running, controlPlane)
      ? rollout.version : null,
    rollback: null,
    rollbackNote: `run morndo update --rollback on ${n.name}`,
  };
};

export function updatesRows(v: UpdatesView): UpdatesRow[] {
  // The control plane's own node has no row of its own: that machine is This machine, already shown first.
  const nodes = v.nodes.filter(n => n.name !== v.controlPlane.node);
  return [controlPlaneRow(v), ...[...nodes].sort((a, b) => a.name.localeCompare(b.name)).map(n => nodeRow(n, v.rollout, v.controlPlane.version))];
}

// The Rollout as one line (§8.2): its Version, committed or soaking with the minutes left, or halted by whom and why
// with the Resume the principal can give (RL12). No Rollout in flight is null.
export function rolloutLine(rollout: RolloutWire | null, now: number): RolloutLine | null {
  if (rollout === null) return null;
  if (rollout.halted) {
    const by = rollout.haltedBy ?? "an unknown machine";
    return { version: rollout.version, sentence: `halted by ${by}${rollout.haltReason !== null ? `: ${rollout.haltReason}` : ""}`, resume: true };
  }
  if (rollout.controlPlaneCommittedAt === null) return { version: rollout.version, sentence: "not committed yet", resume: false };
  const left = rollout.controlPlaneCommittedAt + rollout.soakMinutes * 60_000 - now;
  if (left <= 0) return { version: rollout.version, sentence: "committed", resume: false };
  const minutes = Math.max(1, Math.ceil(left / 60_000));
  return { version: rollout.version, sentence: `soaking, ${minutes} minute${minutes === 1 ? "" : "s"} left`, resume: false };
}
