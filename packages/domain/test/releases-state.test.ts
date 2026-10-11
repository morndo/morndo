// The Update state machine (§4.4), the recovery table (§6.6) and the rollout and skew rules (§7), each as a table:
// the diagram's edges exactly, nothing more, and the table's rows verbatim. The invariants these tables serve
// (RL4, RL11, RL12) have their own histories in releases-invariants.test.ts.
import { describe, expect, it } from "vitest";
import {
  advance, beginRollback, beginStep, beginUpdate, haltRollout, nodeMayApply, parseVersion, resumeRollout,
  TERMINAL_UPDATE_STATES, UPDATE_MARKS, UPDATE_STATES, updateCanMove, recover, type UpdateState,
} from "../src/releases.ts";

const v = (s: string) => {
  const p = parseVersion(s);
  if (!p) throw new Error(`${s} did not parse`);
  return p;
};
const MIN = 60_000;
const NOW = 1_790_000_000_000;

describe("the Update state table (§4.4's diagram, exactly)", () => {
  // The diagram's edges. `skipped` only from `checked`; `abandoned` from staged through backing_up (nothing
  // swapped); `rolling_back` from the swap onward; the terminals admit nothing.
  const EDGES: readonly (readonly [UpdateState, UpdateState])[] = [
    ["checked", "staged"], ["checked", "skipped"],
    ["staged", "draining"], ["staged", "abandoned"],
    ["draining", "stopping"], ["draining", "abandoned"],
    ["stopping", "backing_up"], ["stopping", "abandoned"],
    ["backing_up", "swapping"], ["backing_up", "abandoned"],
    ["swapping", "starting"], ["swapping", "rolling_back"],
    ["starting", "probation"], ["starting", "rolling_back"],
    ["probation", "committed"], ["probation", "rolling_back"],
    ["rolling_back", "rolled_back"], ["rolling_back", "rollback_failed"],
  ];
  it("a move is legal exactly when the diagram draws it (negative control: any other move)", () => {
    for (const from of UPDATE_STATES) for (const to of UPDATE_STATES) {
      const drawn = EDGES.some(([f, t]) => f === from && t === to);
      expect(updateCanMove(from, to), `${from} -> ${to}`).toBe(drawn);
    }
  });
  it("nothing leaves a terminal state", () => {
    expect(TERMINAL_UPDATE_STATES).toEqual(["committed", "skipped", "abandoned", "rolled_back", "rollback_failed"]);
    for (const from of TERMINAL_UPDATE_STATES) for (const to of UPDATE_STATES)
      expect(updateCanMove(from, to), `${from} -> ${to}`).toBe(false);
  });
  it("advance moves along an edge and refuses off it", () => {
    const u = beginUpdate({ target: v("0.5.0"), machine: {
      current: v("0.4.3"), previous: v("0.4.2"), staged: null, badVersions: [], highestCommitted: v("0.4.3"),
      keySet: null, highestFeedSeq: { stable: 42, latest: 42 }, installMethod: "updater",
      settings: { channel: "stable", mode: "apply", pin: null, window: null } } });
    const moved = advance(u, "abandoned");
    expect(moved.ok && moved.value.state).toBe("abandoned");
    expect(advance(moved.ok ? moved.value : u, "staged")).toEqual({ ok: false, error: "illegal_move" });
  });
});

describe("the step record (§6.2's marks, RL4)", () => {
  const machine = { current: v("0.4.3"), previous: v("0.4.2"), staged: null, badVersions: [], highestCommitted: v("0.4.3"),
    keySet: null, highestFeedSeq: { stable: 42, latest: 42 }, installMethod: "updater" as const,
    settings: { channel: "stable" as const, mode: "apply" as const, pin: null, window: null } };
  it("each mark runs only from the state the step before it left, and writes itself before it runs", () => {
    expect(UPDATE_MARKS).toEqual(["draining", "stopping", "backing_up", "swapping", "starting", "committing", "rolling_back"]);
    let u = beginUpdate({ target: v("0.5.0"), machine });
    for (const mark of ["draining", "stopping", "backing_up", "swapping", "starting"] as const) {
      const step = beginStep(u, mark, { lockHeld: true });
      expect(step.ok, mark).toBe(true);
      if (!step.ok) return;
      u = step.value;
      expect(u.mark, mark).toBe(mark);
      expect(u.state, mark).toBe(mark);
    }
    const throughProbation = advance(u, "probation");   // health passed: the Update stands in probation
    expect(throughProbation.ok).toBe(true);
    if (throughProbation.ok) {
      const commit = beginStep(throughProbation.value, "committing", { lockHeld: true });
      expect(commit.ok).toBe(true);
      if (commit.ok) expect(commit.value.state).toBe("probation");   // the commit is recorded in probation
    }
  });
  it("negative control: a mark out of order never runs, whatever the lock says", () => {
    const u = beginUpdate({ target: v("0.5.0"), machine });
    for (const mark of ["stopping", "backing_up", "swapping", "starting", "committing", "rolling_back"] as const)
      expect(beginStep(u, mark, { lockHeld: true }), mark).toEqual({ ok: false, error: "step_out_of_order" });
  });
  it("a rollback may begin from the swap onward; a manual rollback is its own Update at rolling_back", () => {
    let u = beginUpdate({ target: v("0.5.0"), machine });
    for (const mark of ["draining", "stopping", "backing_up", "swapping"] as const) {
      const step = beginStep(u, mark, { lockHeld: true });
      if (!step.ok) throw new Error(mark);
      u = step.value;
    }
    const back = beginStep(u, "rolling_back", { lockHeld: true });
    expect(back.ok && back.value.state).toBe("rolling_back");
    const manual = beginRollback({ machine });
    expect(manual.state).toBe("rolling_back");
    expect(manual.mark).toBe("rolling_back");
    expect(manual.kind).toBe("rollback");
    expect(manual.target).toEqual(v("0.4.2"));
  });
});

describe("the recovery table (§6.6, verbatim)", () => {
  const preUpdate = { current: v("0.4.3") };
  const target = v("0.5.0");
  type Row = { name: string; format?: number; mark: string | null; committed?: boolean; current?: string; act: string; unknown?: string };
  const ROWS: readonly Row[] = [
    { name: "nothing started", mark: null, current: "0.4.3", act: "abandon" },
    { name: "draining", mark: "draining", current: "0.4.3", act: "abandon" },
    { name: "stopping", mark: "stopping", current: "0.4.3", act: "abandon" },
    { name: "backing_up", mark: "backing_up", current: "0.4.3", act: "abandon" },
    { name: "swapping, still the old Version", mark: "swapping", current: "0.4.3", act: "abandon" },
    { name: "swapping, the target is in", mark: "swapping", current: "0.5.0", act: "continue_apply" },
    { name: "starting, no commit", mark: "starting", current: "0.5.0", act: "judge_health" },
    { name: "rolling_back", mark: "rolling_back", current: "0.4.3", act: "continue_rollback" },
    { name: "committing", mark: "committing", current: "0.5.0", act: "finish_commit" },
    { name: "committed", mark: "committing", committed: true, current: "0.5.0", act: "finish_commit" },
    { name: "a record format this Version doesn't know", format: 2, mark: "swapping", current: "0.4.3", act: "nothing", unknown: "record format 2" },
    { name: "a step this Version doesn't know", mark: "teleporting", current: "0.4.3", act: "nothing", unknown: "step teleporting" },
    { name: "a current that is neither the old nor the target", mark: "swapping", current: "0.4.9", act: "nothing", unknown: "current 0.4.9 at swapping" },
  ];
  for (const row of ROWS) {
    it(`${row.name}: ${row.act}${row.unknown ? ` (${row.unknown})` : ""}`, () => {
      const r = recover({ format: row.format ?? 1, mark: row.mark, committed: row.committed ?? false,
        current: v(row.current ?? "0.4.3"), preUpdate, target, lockHeld: true });
      const decision = row.unknown === undefined ? { act: row.act } : { act: row.act, unknown: row.unknown };
      expect(r).toEqual({ ok: true, value: decision });
    });
  }
  it("negative control: without the apply lock, whatever runs next acts on nothing", () => {
    expect(recover({ format: 1, mark: "starting", committed: false, current: v("0.5.0"), preUpdate, target, lockHeld: false }))
      .toEqual({ ok: false, error: "apply_lock" });
  });
});

describe("the rollout table (§7: control plane first, soak, then nodes with jitter)", () => {
  const committedAt = NOW - 35 * MIN;                       // the soak (30 minutes) has passed
  const rolloutOf = (over: Partial<Parameters<typeof nodeMayApply>[0]["rollout"]> = {}) => ({
    version: v("0.5.0"), controlPlaneCommittedAt: committedAt, soakMinutes: 30, halted: false, haltedBy: null,
    nodes: { "node-a": { jitterUntil: null }, "node-b": { jitterUntil: NOW + 5 * MIN } }, ...over,
  });
  type Row = { name: string; cp: string; rollout: Parameters<typeof nodeMayApply>[0]["rollout"]; want: { ok: true; value: "apply" } | { ok: false; error: string } };
  const ROWS: readonly Row[] = [
    { name: "the control plane hasn't committed the target", cp: "0.5.0", rollout: rolloutOf({ controlPlaneCommittedAt: null }), want: { ok: false, error: "not_committed" } },
    { name: "the control plane runs below the target", cp: "0.4.9", rollout: rolloutOf(), want: { ok: false, error: "waiting_control_plane" } },
    { name: "the Rollout is halted", cp: "0.5.0", rollout: rolloutOf({ halted: true, haltedBy: "node-c" }), want: { ok: false, error: "halted" } },
    { name: "the soak hasn't passed", cp: "0.5.0", rollout: rolloutOf({ controlPlaneCommittedAt: NOW - 10 * MIN }), want: { ok: false, error: "waiting_soak" } },
    { name: "the node's jitter is still running", cp: "0.5.0", rollout: rolloutOf(), want: { ok: false, error: "waiting_jitter" } },
    { name: "the control plane runs newer than the target: still allowed (node ≤ control plane)", cp: "0.5.1", rollout: rolloutOf(), want: { ok: false, error: "waiting_jitter" } },
  ];
  for (const row of ROWS) {
    it(`${row.name}: ${row.want.ok ? "apply" : row.want.error}`, () => {
      expect(nodeMayApply({ rollout: row.rollout, node: "node-b", controlPlane: v(row.cp), now: NOW })).toEqual(row.want);
    });
  }
  it("with everything passed, the node applies; the soak boundary is inclusive", () => {
    expect(nodeMayApply({ rollout: rolloutOf(), node: "node-a", controlPlane: v("0.5.0"), now: NOW }))
      .toEqual({ ok: true, value: "apply" });
    const atBoundary = rolloutOf({ controlPlaneCommittedAt: NOW - 30 * MIN });
    expect(nodeMayApply({ rollout: atBoundary, node: "node-a", controlPlane: v("0.5.0"), now: NOW }).ok).toBe(true);
    expect(nodeMayApply({ rollout: rolloutOf({ controlPlaneCommittedAt: NOW - 30 * MIN + 1 }), node: "node-a", controlPlane: v("0.5.0"), now: NOW }))
      .toEqual({ ok: false, error: "waiting_soak" });
  });
  it("a halt is kept by the first halter, and the principal's resume clears it", () => {
    const once = haltRollout(rolloutOf(), "node-c");
    const twice = haltRollout(once, "node-d");
    expect(twice).toMatchObject({ halted: true, haltedBy: "node-c" });
    expect(twice).toBe(once);                                     // an idempotent second halt changes nothing
    const resumed = resumeRollout(once);
    expect(resumed).toMatchObject({ halted: false, haltedBy: null });
    expect(nodeMayApply({ rollout: resumed, node: "node-a", controlPlane: v("0.5.0"), now: NOW }).ok).toBe(true);
  });
});
