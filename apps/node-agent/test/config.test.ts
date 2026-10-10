// The node's configuration and policy: defaults, and refusals that name the file and the field (a typo must never
// widen what the fleet may do).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ALL_OPS, ConfigError, DEFAULT_POLICY, loadConfig, loadPolicy } from "../src/config.ts";
import { agentPaths } from "../src/paths.ts";
import { tempHome } from "./helpers.ts";

const homes: { cleanup: () => void }[] = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });
function home() { const h = tempHome(); homes.push(h); return h.home; }
function writeConfig(h: string, over: Record<string, unknown> = {}, policy?: unknown) {
  const p = agentPaths(h);
  mkdirSync(p.configDir, { recursive: true });
  writeFileSync(p.configFile, JSON.stringify({ node: "pc", fleetUrl: "ws://127.0.0.1:8791/agent", fleetKey: "MCowBQYDK2VwAyEA", keyPath: p.keyPath, dbPath: p.dbPath, relayPort: 8787, ...over }));
  if (policy !== undefined) writeFileSync(p.policyFile, JSON.stringify(policy));
}

describe("config.json", () => {
  it("is required: a machine that hasn't joined is told how to join", () => {
    expect(() => loadConfig(home())).toThrow(/has not joined a fleet.*morndo-node join/);
  });
  it("loads, with the default policy when policy.json is absent", () => {
    const h = home();
    writeConfig(h);
    const c = loadConfig(h);
    expect(c).toMatchObject({ node: "pc", relayPort: 8787, home: h });
    expect(c.policy).toEqual(DEFAULT_POLICY);
    expect(c.policy.ops).toEqual([...ALL_OPS]);
    expect(c.policy.session).toBe("main");
    expect(c.hub).toBeUndefined();
  });
  it("reads the hub address from this node's config and refuses one that is not http(s)", () => {
    const h = home();
    writeConfig(h, { hub: "http://127.0.0.1:8788" });
    expect(loadConfig(h).hub).toBe("http://127.0.0.1:8788");
    const bad = home();
    writeConfig(bad, { hub: "ws://127.0.0.1:8788" });
    expect(() => loadConfig(bad)).toThrow(/hub must be an http or https URL/);
  });
  it("refuses a bad node name or URL, naming the field", () => {
    const a = home();
    writeConfig(a, { node: "PC_1" });
    expect(() => loadConfig(a)).toThrow(/node must match/);
    const b = home();
    writeConfig(b, { fleetUrl: "http://x" });
    expect(() => loadConfig(b)).toThrow(/fleetUrl/);
  });
  it("refuses a plain ws:// fleet URL to another machine; wss:// anywhere and ws:// to this machine pass (plan Contracts, fleetUrlOk)", () => {
    for (const fleetUrl of ["ws://100.64.0.1:8791/agent", "ws://cp.tail1234.ts.net/agent", "ws://0.0.0.0:8791/agent", "ws://127.0.0.1.nip.io/agent"]) {
      const h = home();
      writeConfig(h, { fleetUrl });
      expect(() => loadConfig(h), fleetUrl).toThrow(/fleetUrl must be wss:\/\/, or ws:\/\/ to this machine/);
    }
    for (const fleetUrl of ["wss://cp.tail1234.ts.net/agent", "ws://127.0.0.1:8791/agent", "ws://localhost:8791/agent", "ws://[::1]:8791/agent"]) {
      const h = home();
      writeConfig(h, { fleetUrl });
      expect(loadConfig(h).fleetUrl, fleetUrl).toBe(fleetUrl);
    }
  });
});

describe("policy.json", () => {
  it("keeps the defaults for fields it doesn't set", () => {
    const h = home();
    writeConfig(h, {}, { session: "work", ops: ["inventory.get", "pane.frame"] });
    expect(loadConfig(h).policy).toEqual({ ...DEFAULT_POLICY, session: "work", ops: ["inventory.get", "pane.frame"] });
  });
  it("refuses an unknown op, an unknown field and a relative path (negative controls for silent widening)", () => {
    const h = home();
    const p = agentPaths(h).policyFile;
    mkdirSync(agentPaths(h).configDir, { recursive: true });
    for (const [policy, message] of [
      [{ ops: ["pane.exec"] }, /ops must be a list of op names/],
      [{ opz: [] }, /unknown field opz/],
      [{ repoRoots: ["code"] }, /repoRoots must be a list of absolute paths/],
      [{ lockedPanes: { manager: "lock" } }, /lockedPanes/],
      [{ tmuxSocket: "a b" }, /tmuxSocket/],
    ] as const) {
      writeFileSync(p, JSON.stringify(policy));
      expect(() => loadPolicy(p)).toThrow(ConfigError);
      expect(() => loadPolicy(p)).toThrow(message);
    }
  });
  it("reads class limits and leaves the guard off unless the file sets one", () => {
    const h = home();
    writeConfig(h, {}, { jobs: { classes: { default: { limit: 2, timeoutSec: 30 }, review: { limit: 1 } } } });
    const jobs = loadConfig(h).policy.jobs;
    expect(jobs.enabled).toBe(true);
    expect(jobs.classes).toEqual({ default: { limit: 2, timeoutSec: 30 }, review: { limit: 1 } });
    expect(jobs.guard).toBeUndefined();
    const guarded = home();
    writeConfig(guarded, {}, { jobs: { enabled: false, classes: { default: { limit: 2 } }, guard: { load1: 4, memAvailableMiB: 512 } } });
    expect(loadConfig(guarded).policy.jobs).toEqual({
      enabled: false, classes: { default: { limit: 2 } }, guard: { load1: 4, memAvailableMiB: 512 },
    });
    const empty = home();
    writeConfig(empty, {}, { jobs: { classes: { default: { limit: 2 } }, guard: {} } });
    expect(loadConfig(empty).policy.jobs.guard).toBeUndefined();
  });
  it("refuses a class timeout the process timer cannot arm", () => {
    const h = home();
    writeConfig(h, {}, { jobs: { classes: { default: { limit: 1, timeoutSec: 2_500_000 } } } });
    const policy = loadConfig(h).policy;
    expect(policy.jobs.enabled).toBe(false);
    expect(policy.jobsWarning).toMatch(/timeoutSec/);
  });
  it("accepts jobs turned off with no classes", () => {
    const h = home();
    writeConfig(h, {}, { jobs: { enabled: false } });
    const policy = loadConfig(h).policy;
    expect(policy.jobs).toEqual({ enabled: false, classes: {} });
    expect(policy.jobsWarning).toBeUndefined();
  });
  it("turns jobs off and names the field when the jobs block is wrong", () => {
    const h = home();
    const p = agentPaths(h).policyFile;
    mkdirSync(agentPaths(h).configDir, { recursive: true });
    writeFileSync(p, JSON.stringify({ jobs: { classes: { default: { limit: 0 } } } }));
    const policy = loadPolicy(p);
    expect(policy.jobs).toEqual({ enabled: false, classes: {} });
    expect(policy.jobsWarning).toMatch(/limit/);
    expect(policy.ops.length).toBeGreaterThan(0);
  });
  it("names the field of a jobs block that would widen or misname a class, and leaves the other ops on", () => {
    const h = home();
    const p = agentPaths(h).policyFile;
    mkdirSync(agentPaths(h).configDir, { recursive: true });
    for (const [policy, message] of [
      [{ jobs: { classes: { Default: { limit: 2 } } } }, /jobs.classes/],
      [{ jobs: { classes: { default: { limit: 0 } } } }, /limit/],
      [{ jobs: { classes: { default: { limit: 2, timeout: 1 } } } }, /timeout/],
      [{ jobs: { nope: true, classes: { default: { limit: 2 } } } }, /unknown field nope/],
      [{ jobs: { classes: { default: { limit: 2 } }, guard: { load: 4 } } }, /jobs.guard/],
    ] as const) {
      writeFileSync(p, JSON.stringify(policy));
      const loaded = loadPolicy(p);
      expect(loaded.jobs, JSON.stringify(policy)).toEqual({ enabled: false, classes: {} });
      expect(loaded.jobsWarning, JSON.stringify(policy)).toMatch(message);
      expect(loaded.ops.length).toBeGreaterThan(0);
    }
  });
  it("names the file when it isn't JSON", () => {
    const h = home();
    const p = join(h, "policy.json");
    writeFileSync(p, "{ ops: ");
    expect(() => loadPolicy(p)).toThrow(/policy\.json is not valid JSON/);
  });
});
