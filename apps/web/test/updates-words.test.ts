// The Updates page's words (updates design §8.2 "Settings → Updates", PR 6c part 2): from an UpdatesView — the
// control plane's own updater status, the fleet's Rollout and nodes — the rows the page shows, one per machine, the
// control plane first, then the nodes by name. Each row: one state sentence (the updater's own reason made readable)
// and the actions it offers. Synthetic view only, no hub, no Svelte.
import { describe, expect, it } from "vitest";
import type { RolloutWire, UpdatesNode, UpdatesView, UpdaterStatus } from "@morndo/protocol";
import { rolloutLine, updatesRows } from "../src/lib/updates.ts";

const NOW = 1_800_000_000_000;
const AT = "2026-10-22T10:00:00Z";

const status = (o: Partial<UpdaterStatus> = {}): UpdaterStatus => ({
  installMethod: "updater", channel: "stable", mode: "apply", pin: null, window: null,
  current: "0.4.2", previous: "0.4.1", good: "0.4.2", staged: null,
  feed: null, keySet: null, lastCheck: null, checks: [],
  ...o,
});
const node = (o: Partial<UpdatesNode> = {}): UpdatesNode =>
  ({ name: "pc", status: "online", version: "0.4.2", proto: [1], update: null, ...o });
const rollout = (o: Partial<RolloutWire> = {}): RolloutWire => ({
  version: "0.5.0", controlPlaneCommittedAt: NOW - 40 * 60_000, soakMinutes: 30,
  halted: false, haltedBy: null, haltReason: null, haltedAt: null,
  ...o,
});
const view = (o: Partial<UpdatesView> = {}): UpdatesView => ({
  controlPlane: { version: "0.4.2", commit: null, status: status(), state: null },
  rollout: rollout(), aboveControlPlane: [], nodes: [],
  ...o,
});

describe("the Updates page's rows", () => {
  it("shows the control plane first as This machine, then the nodes by name; a node's Channel and mode are unknown here, not invented", () => {
    const rows = updatesRows(view({ nodes: [node({ name: "zeta" }), node({ name: "alpha" })] }));
    expect(rows.map(r => r.machine)).toEqual(["control-plane", "alpha", "zeta"]);
    expect(rows.map(r => r.title)).toEqual(["This machine", "alpha", "zeta"]);
    expect(rows[0]).toMatchObject({ version: "0.4.2", channel: "stable", mode: "apply" });
    expect(rows[1]).toMatchObject({ version: "0.4.2", channel: null, mode: null });
  });

  it("the control plane's own node agent shows inside This machine: no separate row, no rollback hint; other nodes keep both", () => {
    const own = { version: "0.4.2", commit: null, status: status(), state: null, node: "e2e-cp" };
    const rows = updatesRows(view({ controlPlane: own, nodes: [node({ name: "pc" }), node({ name: "e2e-cp" })] }));
    expect(rows.map(r => r.machine)).toEqual(["control-plane", "pc"]);
    expect(rows.map(r => r.rollbackNote)).toEqual([null, "run morndo update --rollback on pc"]);
    // A hub that names no node of its own (no MORNDO_CONTROL_PLANE_NODE) hides nothing: the node keeps its row and hint.
    const unnamed = updatesRows(view({ controlPlane: { ...own, node: null }, nodes: [node({ name: "e2e-cp" })] }));
    expect(unnamed.map(r => r.machine)).toEqual(["control-plane", "e2e-cp"]);
    expect(unnamed[1]!.rollbackNote).toBe("run morndo update --rollback on e2e-cp");
  });

  it("the live shape: the control plane's own node cp folds into This machine; pc (where the engine lanes run) and srv01 stay", () => {
    const own = { version: "0.4.2", commit: null, status: status(), state: null, node: "cp" };
    const rows = updatesRows(view({ controlPlane: own, nodes: [node({ name: "srv01" }), node({ name: "cp" }), node({ name: "pc" })] }));
    expect(rows.map(r => r.machine)).toEqual(["control-plane", "pc", "srv01"]);
    expect(rows.map(r => r.rollbackNote)).toEqual([null, "run morndo update --rollback on pc", "run morndo update --rollback on srv01"]);
  });

  it("the control plane's sentence, from its own updater's status", () => {
    const sentence = (o: Partial<UpdatesView>) => updatesRows(view(o))[0]!.state;
    expect(sentence({})).toBe("up to date");
    expect(sentence({ controlPlane: { version: "0.4.2", commit: null, state: null, status: status({ staged: "0.5.0" }) } })).toBe("staged 0.5.0 (ready to apply)");
    expect(sentence({
      controlPlane: {
        version: "0.4.2", commit: null, state: null,
        status: status({ updates: [{ id: "u1", target: "0.5.0", state: "draining", startedAt: AT, finishedAt: null }] }),
      },
    })).toBe("applying 0.5.0");
    expect(sentence({
      controlPlane: {
        version: "0.4.2", commit: null, state: null,
        status: status({ updates: [{ id: "u1", target: "0.5.0", state: "committed", startedAt: AT, finishedAt: AT }] }),
      },
    })).toBe("up to date");
    expect(sentence({
      controlPlane: {
        version: "0.4.2", commit: null, state: null,
        status: status({ updates: [{ id: "u1", target: "0.5.0", state: "rolled_back", startedAt: AT, finishedAt: AT }] }),
      },
    })).toBe("rolled back from 0.5.0");
    expect(sentence({ controlPlane: { version: "0.4.2", commit: null, status: null, state: null } })).toBe("this machine's updater did not answer");
  });

  it("a node's sentence, from its updater's last report", () => {
    const sentence = (o: Partial<UpdatesNode> = {}, r: Partial<RolloutWire> = {}) =>
      updatesRows(view({ nodes: [node(o)], rollout: rollout(r) }))[1]!.state;
    // up to date: the node runs the Rollout's Version, and so does the control plane that committed it
    expect(updatesRows(view({
      controlPlane: { version: "0.5.0", commit: null, status: status({ current: "0.5.0" }), state: null },
      nodes: [node({ update: { state: "current", version: "0.5.0" } })],
    }))[1]!.state).toBe("up to date");
    expect(sentence({ update: { state: "current", version: "0.4.2" } })).toBe("needs update");
    expect(sentence({ update: null, version: "0.4.2" })).toBe("needs update");
    expect(sentence({ update: null, version: "0.4.2" }, { controlPlaneCommittedAt: null })).toBe("no update report yet");
    expect(sentence({ update: { state: "current", version: "0.4.2" }, version: null }, { controlPlaneCommittedAt: null })).toBe("up to date");
    expect(sentence({ update: { state: "staged", version: "0.4.2", target: "0.5.0" } })).toBe("staged 0.5.0 (ready to apply)");
    expect(sentence({ update: { state: "applying", version: "0.4.2", target: "0.5.0" } })).toBe("applying 0.5.0");
    expect(sentence({ update: { state: "rolled_back", version: "0.4.2", target: "0.5.0" } })).toBe("rolled back from 0.5.0");
    expect(sentence({ update: { state: "rolled_back", version: "0.4.2", target: "0.5.0", failedCheck: "node health (fleet connection)" } }))
      .toBe("rolled back from 0.5.0: node health (fleet connection) failed");
    expect(sentence({ update: { state: "rollback_failed", version: "0.4.2", target: "0.5.0" } })).toBe("rollback failed");
    expect(sentence({ status: "offline", update: { state: "current", version: "0.4.2" } })).toBe("offline");
  });

  it("a node waiting says why, in words: the updater's own reason, made readable", () => {
    const waiting = (reason: string | undefined) =>
      updatesRows(view({ nodes: [node({ update: { state: "waiting", version: "0.4.2", ...(reason === undefined ? {} : { reason }) } })] }))[1]!.state;
    expect(waiting(undefined)).toBe("waiting");
    expect(waiting("skew_blocked: n2, n3")).toBe("waiting: the target would drop an agent protocol these nodes still speak: n2, n3");
    expect(waiting("skew_blocked")).toBe("waiting: the target would drop an agent protocol a joined node still speaks");
    expect(waiting("fleet_unreachable")).toBe("waiting: the fleet cannot be asked for its nodes, so the apply waits");
    expect(waiting("waiting_soak")).toBe("waiting: the control plane's soak is still running");
    expect(waiting("waiting_jitter")).toBe("waiting: this node's own delay is still running");
    expect(waiting("waiting_control_plane")).toBe("waiting: the control plane runs below the Rollout it committed");
    expect(waiting("halted")).toBe("waiting: the target's Rollout is halted");
    expect(waiting("no_view")).toBe("waiting: no fresh word from the control plane");
    expect(waiting("not_committed")).toBe("waiting: the control plane has not committed the target's Rollout, or offered it to this node");
    expect(waiting("node_ahead")).toBe("waiting: the target is above this node's control plane");
    expect(waiting("a_word_from_a_newer_updater")).toBe("waiting: a_word_from_a_newer_updater");
  });

  it("the actions: Update now where a Version is ready to take, Roll back only on the control plane", () => {
    // The control plane: Update now exactly when its status says a Version stands staged.
    expect(updatesRows(view({ controlPlane: { version: "0.4.2", commit: null, state: null, status: status({ staged: "0.5.0" }) } }))[0]!.apply).toBe("0.5.0");
    expect(updatesRows(view({}))[0]!.apply).toBeNull();
    expect(updatesRows(view({ controlPlane: { version: "0.4.2", commit: null, status: null, state: null } }))[0]!.apply).toBeNull();
    // Roll back to the previous Version the status names; a node instead says the command to run on it.
    const cp = updatesRows(view({}))[0]!;
    expect(cp.rollback).toBe("0.4.1");
    expect(updatesRows(view({ controlPlane: { version: "0.4.2", commit: null, state: null, status: status({ previous: null }) } }))[0]!.rollback).toBeNull();
    const pc = updatesRows(view({ nodes: [node()] }))[1]!;
    expect(pc.rollback).toBeNull();
    expect(pc.rollbackNote).toBe("run morndo update --rollback on pc");
  });

  it("a node offers Update now when the Rollout's Version is above its own and the Rollout is not halted", () => {
    const apply = (o: Partial<UpdatesNode> = {}, r: Partial<RolloutWire> = {}) =>
      updatesRows(view({ nodes: [node(o)], rollout: rollout(r) }))[1]!.apply;
    expect(apply()).toBe("0.5.0");                                     // below the committed Rollout
    expect(apply({ update: { state: "current", version: "0.5.0" } })).toBeNull();   // at the Rollout's Version
    expect(apply({}, { halted: true, haltedBy: "pc", haltReason: "node health (fleet connection) failed", haltedAt: NOW })).toBeNull();
    expect(apply({ version: null })).toBeNull();                       // its Version unknown here: nothing to compare
  });
});

describe("the Rollout line", () => {
  it("no Rollout in flight is null", () => {
    expect(rolloutLine(null, NOW)).toBeNull();
  });
  it("committed, or soaking with the minutes left", () => {
    expect(rolloutLine(rollout(), NOW)).toEqual({ version: "0.5.0", sentence: "committed", resume: false });
    expect(rolloutLine(rollout({ controlPlaneCommittedAt: NOW - 10 * 60_000 }), NOW)!.sentence).toBe("soaking, 20 minutes left");
    expect(rolloutLine(rollout({ controlPlaneCommittedAt: NOW - 30 * 60_000 + 30_000 }), NOW)!.sentence).toBe("soaking, 1 minute left");
    expect(rolloutLine(rollout({ controlPlaneCommittedAt: null }), NOW)!.sentence).toBe("not committed yet");
  });
  it("halted says who and why, and offers Resume; unhalted does not", () => {
    const halted = rolloutLine(rollout({ halted: true, haltedBy: "pc", haltReason: "node health (fleet connection) failed", haltedAt: NOW }), NOW)!;
    expect(halted.sentence).toBe("halted by pc: node health (fleet connection) failed");
    expect(halted.resume).toBe(true);
    expect(rolloutLine(rollout({ halted: true, haltedBy: "pc", haltReason: null, haltedAt: NOW }), NOW)!.sentence).toBe("halted by pc");
    expect(rolloutLine(rollout(), NOW)!.resume).toBe(false);
  });
});

// The review of 6c part 2: the control plane's own waiting reason, and a node left above the control plane.
describe("the Updates page's rows, review of part 2", () => {
  it("the control plane's own waiting record says why it waits, from the updater's state file", () => {
    const row = updatesRows(view({
      controlPlane: {
        version: "0.4.2", commit: null, status: status({ staged: "0.5.0" }),
        state: { state: "waiting", version: "0.4.2", target: "0.5.0", reason: "skew_blocked: n3", at: NOW },
      },
    }))[0]!;
    expect(row.state).toBe("waiting: the target would drop an agent protocol these nodes still speak: n3");
    expect(row.apply).toBe("0.5.0");                    // the press is still the principal's; the updater holds it
  });

  it("a node running above the control plane says so, offers no apply, and names the way back", () => {
    const row = updatesRows(view({
      rollout: rollout({ version: "0.4.2" }),
      nodes: [node({ name: "pc", version: "0.5.0", update: { state: "current", version: "0.5.0" } })],
    }))[1]!;
    expect(row.state).toBe("runs above this machine's 0.4.2: roll it back with morndo update --rollback on pc, or update this machine");
    expect(row.apply).toBeNull();
  });
});

