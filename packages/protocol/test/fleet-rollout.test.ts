// The fleet's rollout protocol pieces (updates design §4.5, §7; ADR-0019 §7): RolloutWire and the `rollout` message,
// the welcome's controlPlane and rollout, health's update field, the update.apply op and the four update alert kinds.
// Everything new is optional or capability-gated, so an agent or a fleet from before updates keeps working: the
// previous Welcome and Health schemas (as an older agent has them) still parse what a newer fleet sends.
import { describe, expect, it } from "vitest";
import * as z from "../src/z.ts";
import {
  ALERT_KINDS, CAP_LONG_TEXT, CAP_ROLLOUT, CAP_UPDATE, EvHealth, FleetFrames, KEYED_OPS, OP_ARGS, OP_RESULTS, STEP_UP_OPS, Welcome,
  urgentAlert, type RolloutWire,
} from "../src/fleet.ts";
import { parseBody } from "../src/decode.ts";

const good: RolloutWire = {
  version: "1.2.3", controlPlaneCommittedAt: 1_791_000_000_000, soakMinutes: 30, halted: false,
  haltedBy: null, haltReason: null, haltedAt: null,
};
const halted: RolloutWire = {
  ...good, halted: true, haltedBy: "pc", haltReason: "a check failed after the swap", haltedAt: 1_791_000_000_500,
};
const goodHealth = {
  memTotal: 8e9, memAvailable: 4e9, psiSome10: 0, psiFull10: 0, diskFreeHome: 1e11, load1: 0.5, tmuxOk: true,
  wallClock: Date.now(), spoolDepth: 0, drops: 0,
};

describe("RolloutWire and the rollout message", () => {
  it("takes a Rollout as it is, halted or not", () => {
    expect(parseBody(FleetFrames.rollout, { v: 1, t: "rollout", rollout: good })).toEqual({ v: 1, t: "rollout", rollout: good });
    expect(parseBody(FleetFrames.rollout, { v: 1, t: "rollout", rollout: halted })?.rollout.haltReason).toBe("a check failed after the swap");
  });
  it("refuses a bad Version, a soak out of range and a halt reason over 200 characters", () => {
    const bad = (rollout: unknown) => parseBody(FleetFrames.rollout, { v: 1, t: "rollout", rollout });
    expect(bad({ ...good, version: "1.2" })).toBeNull();
    expect(bad({ ...good, version: "v1.2.3" })).toBeNull();
    expect(bad({ ...good, soakMinutes: -1 })).toBeNull();
    expect(bad({ ...good, soakMinutes: 10_081 })).toBeNull();
    expect(bad({ ...good, soakMinutes: 1.5 })).toBeNull();
    expect(bad({ ...halted, haltReason: "x".repeat(201) })).toBeNull();
    expect(bad({ ...good, halted: "yes" })).toBeNull();
  });
});

describe("welcome: the control plane's build and the Rollout, optional", () => {
  const old = { v: 1, t: "welcome", connEpoch: 3, ackSeq: 0, streamKnown: false } as const;
  it("a welcome without either still parses; one with both carries them", () => {
    expect(parseBody(Welcome, old)).toEqual(old);
    const withBoth = { ...old, controlPlane: { version: "1.2.3", commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" }, rollout: good };
    const parsed = parseBody(Welcome, withBoth);
    expect(parsed?.controlPlane?.version).toBe("1.2.3");
    expect(parsed?.rollout?.soakMinutes).toBe(30);
    expect(parseBody(Welcome, { ...old, rollout: null })).toMatchObject({ rollout: null });
    expect(parseBody(Welcome, { ...old, controlPlane: { version: "1.2", commit: null } })).toBeNull();
  });
  it("an agent from before updates still parses a welcome that carries them (unknown fields dropped)", () => {
    const previous = z.object({
      v: z.literal(1), t: z.literal("welcome"), connEpoch: z.int().check(z.gte(1)), ackSeq: z.int().check(z.gte(0)),
      streamKnown: z.boolean(), storeSeqSeen: z.exactOptional(z.int().check(z.gte(0))),
    });
    const sent = { ...old, storeSeqSeen: 7, controlPlane: { version: "1.2.3", commit: null }, rollout: halted };
    expect(parseBody(previous, sent)).toEqual({ ...old, storeSeqSeen: 7 });
  });
});

describe("health: the node's update state, optional", () => {
  it("takes each state, and its bounds", () => {
    const update = { state: "rolled_back", version: "1.2.2", target: "1.2.3", reason: "the API probe failed", failedCheck: "api" };
    const parsed = parseBody(EvHealth, { v: 1, t: "ev.health", health: { ...goodHealth, update } });
    expect(parsed?.health.update).toEqual(update);
    expect(parseBody(EvHealth, { v: 1, t: "ev.health", health: goodHealth })?.health.update).toBeUndefined();
    const bad = (update: unknown) => parseBody(EvHealth, { v: 1, t: "ev.health", health: { ...goodHealth, update } });
    expect(bad({ state: "downloading", version: "1.2.3" })).toBeNull();
    expect(bad({ state: "staged", version: "1.2" })).toBeNull();
    expect(bad({ state: "staged", version: "1.2.3", reason: "x".repeat(201) })).toBeNull();
    expect(bad({ state: "rolled_back", version: "1.2.3", failedCheck: "x".repeat(201) })).toBeNull();
  });
  it("an agent from before updates still parses a health that carries one", () => {
    const previous = z.object({
      memTotal: z.number(), memAvailable: z.number(), psiSome10: z.nullable(z.number()), psiFull10: z.nullable(z.number()),
      diskFreeHome: z.number(), load1: z.number(), tmuxOk: z.boolean(), wallClock: z.number(), spoolDepth: z.int().check(z.gte(0)),
      drops: z.int().check(z.gte(0)), jobs: z.exactOptional(z.string()), tzOffsetMin: z.exactOptional(z.int().check(z.gte(-840), z.lte(840))),
    });
    const sent = { ...goodHealth, update: { state: "applying", version: "1.2.3" } };
    expect(parseBody(previous, sent)).toEqual(goodHealth);
  });
});

describe("update.apply and the update capabilities and alerts", () => {
  it("a keyed, step-up op: { version } in, { accepted: true } out", () => {
    expect(parseBody(OP_ARGS["update.apply"], { version: "1.2.3" })).toEqual({ version: "1.2.3" });
    expect(parseBody(OP_ARGS["update.apply"], { version: "1.2" })).toBeNull();
    expect(parseBody(OP_RESULTS["update.apply"], { accepted: true })).toEqual({ accepted: true });
    expect(parseBody(OP_RESULTS["update.apply"], { accepted: false })).toBeNull();
    expect(KEYED_OPS.has("update.apply")).toBe(true);
    expect(STEP_UP_OPS.has("update.apply")).toBe(true);
  });
  it("the capabilities beside CAP_LONG_TEXT", () => {
    expect(CAP_ROLLOUT).toBe("rollout");
    expect(CAP_UPDATE).toBe("update");
    expect(CAP_LONG_TEXT).toBe("long-text");
  });
  it("four alert kinds; a halt, a rollback and a failed rollback are urgent, a blocked skew is not", () => {
    for (const kind of ["rollout_halted", "update_rolled_back", "update_rollback_failed", "update_skew_blocked"] as const)
      expect(ALERT_KINDS, kind).toContain(kind);
    expect(urgentAlert({ kind: "rollout_halted", detail: {} })).toBe(true);
    expect(urgentAlert({ kind: "update_rolled_back", detail: {} })).toBe(true);
    expect(urgentAlert({ kind: "update_rollback_failed", detail: {} })).toBe(true);
    expect(urgentAlert({ kind: "update_skew_blocked", detail: {} })).toBe(false);
  });
});
