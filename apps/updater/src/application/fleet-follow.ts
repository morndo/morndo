// The node's half of the Rollout (updates §6.7, §7) and the control plane's own skew gate (§7, RL11).
// A node never applies on the feed's word alone: it follows its control plane, through the fleet view its agent
// last wrote down (fleet-view.json), fresh within ten minutes — and only the Version it was offered, under the
// offer's attempt id (§5.4), because a rollback nobody issued an id for would halt nothing. The control plane,
// which owns the Rollout, has no fleet write door at all (§4.3): its state file is its word out, and the fleet
// reads it itself — so this file asks the fleet nothing on the control plane's behalf, and the skew gate asks it
// only for its node list.
import {
  NODE_JITTER_MAX_MS, beginRollout, formatVersion, haltRollout, nodeMayApply, parseVersion, skew,
  type ProtocolRange, type Version,
} from "@morndo/domain";
import type { FleetNode, FleetView, FleetWord, UpdateStore } from "./ports.ts";

// A fleet view older than this is no word at all (§6.7): the agent refreshes observedAt at every health tick
// while it is connected, so a quiet fleet still counts — a stale one means the agent stopped talking.
export const FRESH_VIEW_MS = 10 * 60_000;
// The feed itself is asked at most this often (§7): between asks the tick still follows the Rollout, so a node
// never waits six hours on a control plane that committed five minutes ago.
export const FEED_CHECK_MS = 6 * 3600_000;

// [0, 1), Math.random's own contract, behind a port so a test fixes the draw.
export type Random = () => number;

export type NodeDeferReason =
  | "no_view"                    // no view at all, one past its freshness, or one with no control plane in it
  | "node_ahead"                 // RL11: this node would run above its control plane
  | "not_committed"              // the fleet's Rollout is not of this Version, or this node was offered nothing (§5.4)
  | "waiting_control_plane"      // the Rollout is committed, but the control plane runs below it
  | "halted"                     // RL12: a machine's rollback halted this Version everywhere
  | "waiting_soak"               // §7: the control plane's soak is still running
  | "waiting_jitter";            // §7: this node's own drawn delay is still running

// The one sentence a deferral prints and records (§7); state.json keeps the reason token itself.
export const deferSentence = (reason: NodeDeferReason): string => ({
  no_view: "no fresh word from the control plane",
  node_ahead: "the target is above this node's control plane (RL11)",
  not_committed: "the control plane has not committed the target's Rollout, or offered it to this node",
  waiting_control_plane: "the control plane runs below the Rollout it committed",
  halted: "the target's Rollout is halted (RL12)",
  waiting_soak: "the control plane's soak is still running",
  waiting_jitter: "this node's own delay is still running",
})[reason];

const err = <R>(reason: R): { ok: false; error: R } => ({ ok: false, error: reason });
// A word that counts: fresh, and with a control plane in it. Anything else is no_view, whatever its reason.
const heardControlPlane = (word: FleetWord | null, now: number): { version: string; commit: string | null } | null =>
  word !== null && now - word.observedAt < FRESH_VIEW_MS && word.controlPlane !== null ? word.controlPlane : null;

// The node's gate before any apply (§6.7, §7, RL11, RL12, §5.4): a fresh view, the fleet's Rollout of this very
// Version — its commit, the control plane at it, its soak past, this node's drawn jitter past, and not halted —
// and the offer of exactly this Version in it, whose attempt id the Update runs under: a node applies nothing it
// holds no id for, because its rollback would halt nothing (§5.4). RL11 beside it: a target the Rollout is not
// of still never runs above this node's control plane. The Rollout's own checks answer first (the domain's
// nodeMayApply, its words as the defer reasons), so a control plane that sits below a Rollout it committed is
// said that way, waiting_control_plane; skew's node_ahead is the word for a target above the control plane that
// no committed Rollout covers. Either way the node holds. The jitter is drawn once per Version and kept in
// update.db, so a retry never redraws it.
export function nodeGate(p: {
  word: FleetWord | null; now: number; node: string;
  target: Version; targetProtocol: ProtocolRange;
  store: Pick<UpdateStore, "jitterOf" | "recordJitter">; random: Random;
}): { ok: true; attempt: string } | { ok: false; error: { reason: NodeDeferReason } } {
  const heard = heardControlPlane(p.word, p.now);
  if (heard === null || p.word === null) return err({ reason: "no_view" });
  const controlPlane = parseVersion(heard.version);
  if (controlPlane === null) return err({ reason: "no_view" });
  const wire = p.word.rollout;
  const targetText = formatVersion(p.target);
  if (wire === null || wire.version !== targetText) {
    // RL11: a node never applies above its control plane. The nodes' own protocol floor is the control plane's
    // look-out, not this node's — from here it is only this machine's place in line.
    if (!skew({ machine: "node", controlPlane, nodes: [], target: p.target, targetProtocol: p.targetProtocol }).ok) {
      return err({ reason: "node_ahead" });
    }
    return err({ reason: "not_committed" });
  }
  // The offer (§5.4): the Rollout may be committed to this Version and still offered to this node nothing — an
  // offer of another Version is no offer of this one either.
  const offer = p.word.offer;
  if (offer === null || offer.version !== targetText) return err({ reason: "not_committed" });
  // This node's drawn delay (§7): once per Version, kept in update.db, counted from the control plane's own
  // commit plus its soak — so a redraw later in the same Rollout cannot shorten the wait it already began.
  let jitterUntil = p.store.jitterOf(targetText);
  if (jitterUntil === null && wire.controlPlaneCommittedAt !== null) {
    jitterUntil = wire.controlPlaneCommittedAt + wire.soakMinutes * 60_000
      + Math.floor(p.random() * NODE_JITTER_MAX_MS);
    p.store.recordJitter(targetText, jitterUntil);
  }
  let rollout = beginRollout({
    version: p.target,
    controlPlaneCommittedAt: wire.controlPlaneCommittedAt,
    soakMinutes: wire.soakMinutes,
    ...(jitterUntil === null ? {} : { nodes: { [p.node]: { jitterUntil } } }),
  });
  if (wire.halted) rollout = haltRollout(rollout, wire.haltedBy ?? p.node);
  const may = nodeMayApply({ rollout, node: p.node, controlPlane, now: p.now });
  if (!may.ok) return err({ reason: may.error });
  return { ok: true, attempt: offer.attempt };
}

// The apply unit's own, narrower gate (§8.3): the principal's explicit "Update now" skips the soak and the
// jitter, never RL11 or RL12 — so it still needs a fresh view, the control plane at or above the target, and a
// Rollout that is not halted, in the fleet or in this machine's own halt record.
export function applyUnitGate(p: {
  word: FleetWord | null; now: number; target: Version; targetProtocol: ProtocolRange;
  localHalts: readonly { version: string; at: number }[];
}): { ok: true } | { ok: false; error: { reason: "no_view" | "node_ahead" | "halted" } } {
  const heard = heardControlPlane(p.word, p.now);
  if (heard === null || p.word === null) return err({ reason: "no_view" });
  const controlPlane = parseVersion(heard.version);
  if (controlPlane === null) return err({ reason: "no_view" });
  if (!skew({ machine: "node", controlPlane, nodes: [], target: p.target, targetProtocol: p.targetProtocol }).ok) {
    return err({ reason: "node_ahead" });
  }
  const targetText = formatVersion(p.target);
  if (p.word.rollout?.version === targetText && p.word.rollout.halted) return err({ reason: "halted" });
  if (p.localHalts.some(h => h.version === targetText)) return err({ reason: "halted" });
  return { ok: true };
}

// The control plane's own gate before an apply (§7, RL11): a Release may not drop an agent protocol a joined,
// non-revoked node still depends on, and the fleet's own node list decides — asked live, because the nodes'
// protocols are the fleet's word, not this machine's view of them. A fleet that cannot be asked is no answer at
// all: the apply waits, never runs on no word. The hold names the nodes, for state.json and the alert it becomes.
export type SkewHold = { reason: "fleet_unreachable" } | { reason: "skew_blocked"; nodes: string[] };
export async function controlPlaneSkew(p: {
  fleet: Pick<FleetView, "nodes">; controlPlane: Version; target: Version; targetProtocol: ProtocolRange;
}): Promise<{ ok: true } | { ok: false; error: SkewHold }> {
  let nodes: FleetNode[] | null;
  try { nodes = await p.fleet.nodes(); } catch { nodes = null; }
  if (nodes === null) return err({ reason: "fleet_unreachable" });
  const word = skew({
    machine: "control_plane", controlPlane: p.controlPlane, target: p.target, targetProtocol: p.targetProtocol,
    nodes: nodes.map(n => ({ name: n.name, version: null, agentProtocol: n.agentProtocol, joined: n.joined, revoked: n.revoked })),
  });
  if (!word.ok) {
    // This machine is the control plane, whose only refusal is protocol_dropped (RL11) — node_ahead is a node's
    // word, never this call's; the narrowing keeps the hold's nodes the refusal's own.
    if (word.error.reason !== "protocol_dropped") return err({ reason: "skew_blocked", nodes: [] });
    return err({ reason: "skew_blocked", nodes: word.error.nodes });
  }
  return { ok: true };
}
