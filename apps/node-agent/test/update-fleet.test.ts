// The node's half of the Rollout (updates §6.7, §7): the agent keeps the fleet view file the node's updater
// follows — written on every welcome and every `rollout` frame, its moment refreshed at every health tick while
// the agent is online, so a quiet fleet still counts as a live word — and its health carries what the updater last
// did (state.json, §6.3) when there is one. The update.apply op (§5.4) starts the updater's apply unit through an
// injected runner: `systemctl --user start --no-block morndo-update-apply@<version>.service`, never a shell, never
// inside the agent's own unit, and answers accepted once the start was queued.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RolloutWire } from "@morndo/protocol";
// The schema through the worktree's own source: this scratch's node_modules still links another worktree's
// protocol build, which has no FleetViewFile yet (resyncing it needs an install this task may not run).
import { FleetViewFileSchema } from "../../../packages/protocol/src/fleet.ts";
import type { AgentConfig } from "../src/config.ts";
import { agentPaths } from "../src/paths.ts";
import { startFakeFleet, type FakeFleet, type Msg } from "./fake-fleet.ts";
import { joinedConfig, runAgent } from "./agent-harness.ts";
import { isolatedTmux, tempHome, until, type TestTmux } from "./helpers.ts";

const roll = (o: Partial<RolloutWire> = {}): RolloutWire => ({
  version: "0.2.0", controlPlaneCommittedAt: Date.now() - 3600_000, soakMinutes: 30,
  halted: false, haltedBy: null, haltReason: null, haltedAt: null, ...o,
});
// The welcome's own Rollout, made once so a test compares against the very object the fleet sent.
const ROLL = roll();

let fleet: FakeFleet;
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let config: AgentConfig;
const stops: (() => Promise<void>)[] = [];
beforeEach(async () => {
  fleet = await startFakeFleet({
    welcome: {
      connEpoch: 1, ackSeq: 0, streamKnown: true,
      controlPlane: { version: "0.2.0", commit: "0123456789abcdef0123456789abcdef01234567" },
      rollout: ROLL,
    },
  });
  home = tempHome();
  t = isolatedTmux();
  config = await joinedConfig(home.home, fleet, t.socket);
});
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  await fleet.close();
  await t.kill();
  home.cleanup();
});

const viewFile = (): { observedAt: number; controlPlane: unknown; rollout: unknown; offer: unknown } => {
  const paths = agentPaths(home.home);
  return FleetViewFileSchema.parse(JSON.parse(readFileSync(paths.fleetViewFile, "utf8")));
};
const updateStateFile = (): string => join(home.home, ".local", "state", "morndo-update", "state.json");

describe("the fleet view file (§6.7, §7)", () => {
  it("a welcome writes it: the control plane's build, the Rollout, and the moment it was heard", async () => {
    const { agent } = await runAgent(config);
    stops.push(() => agent.stop());
    expect(await until(() => existsSync(agentPaths(home.home).fleetViewFile))).toBe(true);
    expect(viewFile()).toEqual({
      observedAt: expect.any(Number),
      controlPlane: { version: "0.2.0", commit: "0123456789abcdef0123456789abcdef01234567" },
      rollout: ROLL,
      offer: null,                                  // this welcome offers nothing (§7: absent is no offer)
    });
  });

  it("a rollout frame moves the Rollout and keeps the control plane; the health tick refreshes the moment", async () => {
    const { agent } = await runAgent(config, { healthMs: 100 });
    stops.push(() => agent.stop());
    expect(await until(() => existsSync(agentPaths(home.home).fleetViewFile))).toBe(true);
    const heard = viewFile().observedAt;
    // While the agent is online, a quiet fleet still counts: the word's moment moves at every health tick.
    expect(await until(() => viewFile().observedAt > heard)).toBe(true);
    // The fleet halts the Rollout (RL12 as the fleet carries it): the view carries the halt, the build stays.
    fleet.send({ t: "rollout", rollout: roll({ halted: true, haltedBy: "office-2", haltReason: "nodes:node-b", haltedAt: Date.now() }) });
    expect(await until(() => (viewFile().rollout as RolloutWire).halted === true)).toBe(true);
    expect(viewFile().controlPlane).toEqual({ version: "0.2.0", commit: "0123456789abcdef0123456789abcdef01234567" });
  });

  it("a welcome from a fleet that says neither half writes a view of two nulls, in the file's own shape", async () => {
    fleet.script.welcome = { connEpoch: 1, ackSeq: 0, streamKnown: true };
    const { agent } = await runAgent(config);
    stops.push(() => agent.stop());
    expect(await until(() => existsSync(agentPaths(home.home).fleetViewFile))).toBe(true);
    expect(viewFile()).toEqual({ observedAt: expect.any(Number), controlPlane: null, rollout: null, offer: null });
  });

  it("the offer rides the welcome and each rollout frame; a frame without one clears it (§5.4, §7)", async () => {
    const first = { version: "0.2.0", attempt: "offered-by-the-fleet-0000000" };
    fleet.script.welcome = {
      connEpoch: 1, ackSeq: 0, streamKnown: true,
      controlPlane: { version: "0.2.0", commit: null }, rollout: ROLL, offer: first,
    };
    const { agent } = await runAgent(config);
    stops.push(() => agent.stop());
    const seen = (): unknown => (existsSync(agentPaths(home.home).fleetViewFile) ? viewFile().offer : "no file yet");
    expect(await until(() => seen() !== null && seen() !== "no file yet")).toBe(true);
    expect(viewFile().offer).toEqual(first);

    // A rollout frame with its own offer moves the offer with the Rollout (§7: one offer per word).
    const second = { version: "0.2.1", attempt: "offered-by-the-fleet-1111111" };
    fleet.send({ t: "rollout", rollout: roll({ version: "0.2.1" }), offer: second });
    expect(await until(() => { const o = viewFile().offer as { version: string } | null; return o !== null && o.version === "0.2.1"; })).toBe(true);
    expect(viewFile().offer).toEqual(second);

    // A frame that carries no offer says the node was offered nothing: never an offer a moment too old.
    fleet.send({ t: "rollout", rollout: roll({ version: "0.2.1" }) });
    expect(await until(() => viewFile().offer === null)).toBe(true);
    expect(viewFile().rollout).toMatchObject({ version: "0.2.1" });   // the Rollout itself still moved
  });
});

describe("health carries the updater's own state (§6.3)", () => {
  it("a valid state.json rides along as the update field; a missing or invalid one is no field at all", async () => {
    mkdirSync(join(home.home, ".local", "state", "morndo-update"), { recursive: true });
    writeFileSync(updateStateFile(), `${JSON.stringify({ state: "waiting", version: "0.1.0", reason: "waiting_soak", at: Date.now() })}\n`);
    const { agent } = await runAgent(config);
    stops.push(() => agent.stop());
    const health = (await fleet.waitFor(m => m.t === "ev.health")) as Msg & { health: { update?: unknown } };
    expect(health.health.update).toEqual({ state: "waiting", version: "0.1.0", reason: "waiting_soak" });   // the moment itself stays in the file
    await agent.stop();

    // A commit's own record carries the soak and the attempt (§4.5, §5.4); the health field carries the attempt —
    // the fleet's own id of this Update — and neither the soak nor the moment: those are the file's, not health's.
    writeFileSync(updateStateFile(), `${JSON.stringify({ state: "current", version: "0.2.0", attempt: "attempt-by-the-plane-000000", at: Date.now(), soakMinutes: 45 })}\n`);
    const middle = fleet.received.length;
    const second = await runAgent(config);
    stops.push(() => second.agent.stop());
    const soaked = (await fleet.waitFor(m => m.t === "ev.health", 5000, middle)) as Msg & { health: { update?: unknown } };
    expect(soaked.health.update).toEqual({ state: "current", version: "0.2.0", attempt: "attempt-by-the-plane-000000" });

    // A file that is not the protocol's shape is no update at all, never a malformed health.
    writeFileSync(updateStateFile(), `${JSON.stringify({ state: "exploded", version: "x", at: "when" })}\n`);
    const before = fleet.received.length;
    const third = await runAgent(config);
    stops.push(() => third.agent.stop());
    const next = (await fleet.waitFor(m => m.t === "ev.health", 5000, before)) as Msg & { health: Record<string, unknown> };
    expect(next.health.update).toBeUndefined();
  });
});

describe("update.apply starts the apply unit (§5.4, §8.3)", () => {
  it("queues the unit without waiting for it and answers accepted; a bad Version is bad_args and runs nothing", async () => {
    const started: { file: string; args: readonly string[] }[] = [];
    let fail = false;
    const { agent } = await runAgent(config, {
      runCommand: async (file, args) => {
        started.push({ file, args });
        if (fail) throw new Error("no unit file");
      },
    });
    stops.push(() => agent.stop());
    // Not the hello itself: the agent says hello before the fleet's welcome, and a request that arrives before it
    // is a protocol error (the connection closes). The first health event is the word the agent is online.
    await fleet.waitFor(m => m.t === "ev.health");

    fleet.send({ t: "req", id: "u1", op: "update.apply", timeoutMs: 5000, key: "hub:u1", args: { version: "0.2.0" } });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "u1")).toMatchObject({ ok: true, result: { accepted: true } });
    expect(started).toEqual([{ file: "systemctl", args: ["--user", "start", "--no-block", "morndo-update-apply@0.2.0.service"] }]);

    // Not a Version: refused before anything runs (the arguments' own check, args.ts).
    fleet.send({ t: "req", id: "u2", op: "update.apply", timeoutMs: 5000, key: "hub:u2", args: { version: "not-a-version" } });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "u2"))
      .toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    expect(started).toHaveLength(1);

    // A start that fails is an op error that ran nothing: internal, executed no (safe to ask again).
    fail = true;
    fleet.send({ t: "req", id: "u3", op: "update.apply", timeoutMs: 5000, key: "hub:u3", args: { version: "0.2.0" } });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "u3"))
      .toMatchObject({ ok: false, error: { code: "internal", executed: "no" } });
  });

  it("an attempt the request carries reaches the apply unit's environment — and a request without one leaves none behind (§5.4)", async () => {
    const started: { file: string; args: readonly string[] }[] = [];
    const { agent } = await runAgent(config, {
      runCommand: async (file, args) => { started.push({ file, args }); },
    });
    stops.push(() => agent.stop());
    await fleet.waitFor(m => m.t === "ev.health");
    const envFile = join(home.home, ".local", "state", "morndo-update", "apply.env");
    mkdirSync(dirname(envFile), { recursive: true });
    writeFileSync(envFile, "MORNDO_ATTEMPT=an-apply-from-long-ago-000000\n", { mode: 0o600 });

    // The unit takes one instance string (its Version), so the attempt travels by an environment file the unit's
    // own template reads (§8.3): the agent writes it before the start, and the start itself looks the same as ever.
    fleet.send({ t: "req", id: "a1", op: "update.apply", timeoutMs: 5000, key: "hub:a1",
      args: { version: "0.2.0", attempt: "applied-by-the-principal-00000" } });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "a1")).toMatchObject({ ok: true, result: { accepted: true } });
    expect(started).toEqual([{ file: "systemctl", args: ["--user", "start", "--no-block", "morndo-update-apply@0.2.0.service"] }]);
    expect(readFileSync(envFile, "utf8")).toBe("MORNDO_ATTEMPT=applied-by-the-principal-00000\n");

    // A request with no attempt must never run under an id a moment too old: the file goes before the start.
    writeFileSync(envFile, "MORNDO_ATTEMPT=an-apply-from-long-ago-000000\n", { mode: 0o600 });
    fleet.send({ t: "req", id: "a2", op: "update.apply", timeoutMs: 5000, key: "hub:a2", args: { version: "0.2.0" } });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "a2")).toMatchObject({ ok: true, result: { accepted: true } });
    expect(started).toHaveLength(2);
    expect(existsSync(envFile)).toBe(false);
  });
});
