// What a lane starts as (reliable lanes §3.3): the node's launch as before; an engine by role through the engine layer's
// resolver or by name; a default role; fail closed on every gap; the launch words filled from the pick; and the policy
// fields that set it up. The engine layer's CLI is a fake script here, run as the real one is (execFile, exit 0 or 3).
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, loadPolicy, type EnginesPolicy, type Policy } from "../src/config.ts";
import { engineCommand, engineLayer, laneLaunch, type EngineLayer, type Resolved } from "../src/ops/lane-engine.ts";
import { agentPaths } from "../src/paths.ts";
import { tempHome } from "./helpers.ts";

const homes: { home: string; cleanup: () => void }[] = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });
const home = () => { const h = tempHome(); homes.push(h); return h.home; };

const ACME_LAUNCH = { command: ["acme-lane", "--engine", "acme", "--model", "{model}", "--effort", "{effort}", "--window", "{lane}"], via: "shell" as const };
const BETA_LAUNCH = { command: ["claude-as", "{account}", "--model", "{model}"], via: "shell" as const };
const ENGINES: EnginesPolicy = { cli: "/opt/engines/bin/engines", launch: { acme: ACME_LAUNCH, beta: BETA_LAUNCH } };
const policy = (engines?: EnginesPolicy): Policy => ({ ...DEFAULT_POLICY, ...(engines ? { engines } : {}) });
function layer(resolved: Resolved | Error, enabled = true): EngineLayer & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    enabled: async () => enabled,
    resolve: async (_cli, role) => { asked.push(role); if (resolved instanceof Error) throw resolved; return resolved; },
  };
}
const FIRST: Resolved = { picked: "acme:large-2@high", skipped: [] };
const start = { name: "w1", cwd: "/w" };

describe("the launch words", () => {
  it("fills model, effort and lane; leaves out a missing value's word with the option before it", () => {
    expect(engineCommand(ACME_LAUNCH, { provider: "acme", model: "large-2", effort: "high" }, start))
      .toEqual(["acme-lane", "--engine", "acme", "--model", "large-2", "--effort", "high", "--window", "w1"]);
    expect(engineCommand(ACME_LAUNCH, { provider: "acme", model: "small-1", effort: "" }, { ...start, resume: "45460920-67e6-4bea-8c1d-2f3a4b5c6d7e" }))
      .toEqual(["acme-lane", "--engine", "acme", "--model", "small-1", "--window", "w1", "--resume", "45460920-67e6-4bea-8c1d-2f3a4b5c6d7e"]);
    expect(engineCommand(BETA_LAUNCH, { provider: "beta", model: "m", effort: "" }, { ...start, account: "a1" })).toEqual(["claude-as", "a1", "--model", "m"]);
    expect(engineCommand(BETA_LAUNCH, { provider: "beta", model: "m", effort: "" }, start)).toEqual(["claude-as", "--model", "m"]);
  });

  it("puts a named account into a codex launch command that takes {account}, and leaves the option out without one (T-250)", () => {
    const CODEX = { command: ["/opt/bin/pool-lane", "--account", "{account}", "--lane", "{lane}", "--", "/opt/bin/engine-lane", "--engine", "codex", "--model", "{model}"], via: "shell" as const };
    expect(engineCommand(CODEX, { provider: "codex", model: "model-x", effort: "" }, { ...start, account: "codex-b" }))
      .toEqual(["/opt/bin/pool-lane", "--account", "codex-b", "--lane", "w1", "--", "/opt/bin/engine-lane", "--engine", "codex", "--model", "model-x"]);
    expect(engineCommand(CODEX, { provider: "codex", model: "model-x", effort: "" }, start))
      .toEqual(["/opt/bin/pool-lane", "--lane", "w1", "--", "/opt/bin/engine-lane", "--engine", "codex", "--model", "model-x"]);
  });

  it("refuses an account the command can't take, a placeholder inside a word with no value, and a lane name that reads as a flag", () => {
    expect(engineCommand(ACME_LAUNCH, { provider: "acme", model: "m", effort: "" }, { ...start, account: "a1" })).toHaveProperty("refused");
    expect(engineCommand({ command: ["run", "--effort={effort}"], via: "direct" }, { provider: "acme", model: "m", effort: "" }, start)).toHaveProperty("refused");
    expect(engineCommand(ACME_LAUNCH, { provider: "acme", model: "m", effort: "" }, { ...start, name: "--dangerously-skip-permissions" })).toHaveProperty("refused");
  });
});

describe("what a start runs", () => {
  it("without role, engine or default role: the node's launch, as before, and the resolver is never asked", async () => {
    const l = layer(FIRST);
    expect(await laneLaunch(policy(ENGINES), start, l)).toEqual({ via: "shell", command: ["claude"] });
    expect(await laneLaunch(policy(), start, l)).toEqual({ via: "shell", command: ["claude"] });
    expect(l.asked).toEqual([]);
  });

  it("a role runs what the resolver picks, and says what it passed over", async () => {
    const skipped = [{ entry: "acme:large-2@high", reason: "acme: agent is not installed" }];
    const l = layer({ picked: "beta:mid-3@high", skipped });
    expect(await laneLaunch(policy(ENGINES), { ...start, role: "implement", account: "a1" }, l)).toEqual({
      via: "shell", command: ["claude-as", "a1", "--model", "mid-3"], engine: { entry: "beta:mid-3@high", role: "implement", skipped },
    });
    expect(l.asked).toEqual(["implement"]);
  });

  it("a start by role passes its account only to a pick whose command takes one; a named engine refuses one it can't take", async () => {
    const withDefault = policy({ ...ENGINES, defaultRole: "implement" });
    expect(await laneLaunch(withDefault, { ...start, account: "a1" }, layer(FIRST)))
      .toMatchObject({ command: ["acme-lane", "--engine", "acme", "--model", "large-2", "--effort", "high", "--window", "w1"] });
    expect(await laneLaunch(withDefault, { ...start, account: "a1" }, layer({ picked: "beta:mid-3", skipped: [] })))
      .toMatchObject({ command: ["claude-as", "a1", "--model", "mid-3"] });
    expect(await laneLaunch(withDefault, { ...start, account: "a1", engine: "acme:large-2", reason: "r" }, layer(FIRST))).toMatchObject({ refused: { code: "bad_args" } });
  });

  it("the default role fills a start that names nothing, but not a resume or a protected lane", async () => {
    const l = layer(FIRST);
    const withDefault = policy({ ...ENGINES, defaultRole: "implement" });
    expect(await laneLaunch(withDefault, start, l)).toMatchObject({ engine: { entry: "acme:large-2@high", role: "implement" } });
    expect(await laneLaunch(withDefault, { ...start, resume: "45460920-67e6-4bea-8c1d-2f3a4b5c6d7e" }, l)).toEqual({ via: "shell", command: ["claude", "--resume", "45460920-67e6-4bea-8c1d-2f3a4b5c6d7e"] });
    expect(await laneLaunch(withDefault, { ...start, name: "manager" }, l)).toEqual({ via: "shell", command: ["claude"] });
    expect(l.asked).toEqual(["implement"]);
  });

  it("an engine by name needs a reason where a default role is set", async () => {
    const withDefault = policy({ ...ENGINES, defaultRole: "implement" });
    expect(await laneLaunch(withDefault, { ...start, engine: "acme:large-2" }, layer(FIRST))).toMatchObject({ refused: { code: "bad_args" } });
    expect(await laneLaunch(withDefault, { ...start, engine: "acme:large-2", reason: "the owner asked" }, layer(FIRST)))
      .toEqual({ via: "shell", command: ["acme-lane", "--engine", "acme", "--model", "large-2", "--window", "w1"], engine: { entry: "acme:large-2" } });
  });

  it("fails closed: no engines, no engine layer, nothing available, a provider without a launch, a resolver that fails, switched off", async () => {
    const refused = async (p: Policy, a: object, l: EngineLayer) => {
      const r = await laneLaunch(p, { ...start, ...a }, l);
      return "refused" in r ? r.refused.code : `ran ${JSON.stringify(r)}`;
    };
    expect(await refused(policy(), { role: "implement" }, layer(FIRST))).toBe("denied");
    expect(await refused(policy({ launch: ENGINES.launch }), { role: "implement" }, layer(FIRST))).toBe("denied");
    expect(await refused(policy(ENGINES), { role: "implement" }, layer({ picked: null, skipped: [{ entry: "acme:large-2", reason: "out of quota" }] }))).toBe("denied");
    expect(await refused(policy(ENGINES), { role: "implement" }, layer({ picked: "gamma:x", skipped: [] }))).toBe("denied");
    expect(await refused(policy(ENGINES), { engine: "gamma:x" }, layer(FIRST))).toBe("denied");
    expect(await refused(policy(ENGINES), { role: "implement" }, layer(new Error("spawn failed")))).toBe("internal");
    expect(await refused(policy(ENGINES), { role: "implement" }, layer(FIRST, false))).toBe("denied");
    // Switched off, a default role is simply not applied: the node's launch, as before.
    expect(await laneLaunch(policy({ ...ENGINES, defaultRole: "implement" }), start, layer(FIRST, false))).toEqual({ via: "shell", command: ["claude"] });
  });
});

describe("the engine layer's CLI", () => {
  function fakeCli(script: string): string {
    const dir = home();
    const path = join(dir, "engines");
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("reads a pick (exit 0) and none (exit 3) with what was skipped, and the kill switch", async () => {
    const pick = fakeCli(`[ "$1" = option ] && { echo true; exit 0; }
echo '{"role":"'"$2"'","picked":{"entry":"acme:large-2@high"},"skipped":[{"entry":"beta:x","reason":"beta: not signed in"}]}'`);
    expect(await engineLayer().enabled(pick)).toBe(true);
    expect(await engineLayer().resolve(pick, "implement")).toEqual({ picked: "acme:large-2@high", skipped: [{ entry: "beta:x", reason: "beta: not signed in" }] });
    const none = fakeCli(`[ "$1" = option ] && { echo false; exit 0; }
echo '{"picked":null,"skipped":[{"entry":"acme:large-2","reason":"out of quota"}]}'; exit 3`);
    expect(await engineLayer().enabled(none)).toBe(false);
    expect(await engineLayer().resolve(none, "implement")).toEqual({ picked: null, skipped: [{ entry: "acme:large-2", reason: "out of quota" }] });
  });

  it("reads the kill switch as the hub does: on only for true, off for other JSON, and output that isn't JSON refuses the start", async () => {
    for (const [out, on] of [["true", true], ["false", false], ["null", false]] as const) {
      expect([out, await engineLayer().enabled(fakeCli(`echo '${out}'`))]).toEqual([out, on]);
    }
    const garbled = fakeCli("echo False");
    await expect(engineLayer().enabled(garbled)).rejects.toMatchObject({ kind: "unavailable" });
    expect(await laneLaunch(policy({ ...ENGINES, cli: garbled }), { ...start, role: "implement" }, engineLayer()))
      .toMatchObject({ refused: { code: "internal", executed: "no" } });
  });

  it("an unknown role is the engine layer's refusal (exit 2), anything else unreadable is a failure", async () => {
    const refusing = fakeCli(`[ "$1" = option ] && { echo true; exit 0; }
echo "engines: unknown role 'nope'" >&2; exit 2`);
    await expect(engineLayer().resolve(refusing, "nope")).rejects.toMatchObject({ kind: "refused" });
    expect(await laneLaunch(policy({ ...ENGINES, cli: refusing }), { ...start, role: "nope" }, engineLayer()))
      .toMatchObject({ refused: { code: "bad_args", executed: "no", message: "the engine layer refused: unknown role 'nope'" } });
    const garbled = fakeCli("echo not json");
    await expect(engineLayer().resolve(garbled, "implement")).rejects.toMatchObject({ kind: "unavailable" });
    expect(await laneLaunch(policy({ ...ENGINES, cli: join(home(), "missing") }), { ...start, role: "implement" }, engineLayer()))
      .toMatchObject({ refused: { code: "internal", executed: "no" } });
  });
});

describe("policy.json: statusContract and engines", () => {
  function policyFile(content: unknown): string {
    const p = agentPaths(home());
    mkdirSync(p.configDir, { recursive: true });
    writeFileSync(p.policyFile, JSON.stringify(content));
    return p.policyFile;
  }

  it("asks for status lines by default, the manager exempt; no engines by default", () => {
    expect(DEFAULT_POLICY.statusContract).toEqual({ mode: "ask", exempt: ["manager"] });
    expect(loadPolicy(policyFile({}))).toMatchObject({ statusContract: { mode: "ask", exempt: ["manager"] } });
    expect(loadPolicy(policyFile({})).engines).toBeUndefined();
  });

  it("takes the owner's engines and contract", () => {
    const engines = { cli: "/opt/engines/bin/engines", defaultRole: "implement-backend", launch: { acme: ACME_LAUNCH, beta: { command: ["claude-as", "{account}"] } } };
    expect(loadPolicy(policyFile({ engines, statusContract: { mode: "off" } }))).toMatchObject({
      engines: { ...engines, launch: { acme: ACME_LAUNCH, beta: { command: ["claude-as", "{account}"], via: "shell" } } },
      statusContract: { mode: "off", exempt: ["manager"] },
    });
  });

  it("refuses what doesn't fit, naming the field", () => {
    const cases: [unknown, RegExp][] = [
      [{ statusContract: { mode: "always" } }, /statusContract.mode must be "ask" or "off"/],
      [{ statusContract: { exempt: "manager" } }, /statusContract.exempt must be a list/],
      [{ statusContract: { ask: true } }, /statusContract has an unknown field ask/],
      [{ engines: { launch: {} , cli: "engines" } }, /engines.cli must be the absolute path/],
      [{ engines: { launch: { Acme: ACME_LAUNCH } } }, /Acme is not a provider name/],
      [{ engines: { launch: { acme: {} } } }, /engines.launch.acme must name its command/],
      [{ engines: { launch: { acme: { command: ["{model}"] } } } }, /the program can't be a placeholder/],
      [{ engines: { launch: {}, defaultRole: "implement" } }, /defaultRole needs engines.cli/],
      [{ engines: { launch: {}, cli: "/e", defaultRole: "Implement" } }, /defaultRole must be a role name/],
      [{ engines: { launch: {}, roles: [] } }, /engines has an unknown field roles/],
    ];
    for (const [content, message] of cases) expect(() => loadPolicy(policyFile(content)), JSON.stringify(content)).toThrow(message);
  });
});
