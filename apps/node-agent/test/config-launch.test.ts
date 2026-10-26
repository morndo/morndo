// The policy's launcher and protected names (fleet clients spec §5; plan Contracts, Config: Policy gains launch and
// protected): the defaults, the owner's PC's setting, and a refusal naming the file and the field for anything else.
// A typo must never widen what an op may start.
import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_POLICY, loadPolicy } from "../src/config.ts";
import { agentPaths } from "../src/paths.ts";
import { tempHome } from "./helpers.ts";

const homes: { cleanup: () => void }[] = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });
function policyFile(content: unknown): string {
  const h = tempHome();
  homes.push(h);
  const p = agentPaths(h.home);
  mkdirSync(p.configDir, { recursive: true });
  writeFileSync(p.policyFile, JSON.stringify(content));
  return p.policyFile;
}

describe("policy.json: launch and protected", () => {
  it("defaults to claude started from the shell, and the manager protected", () => {
    expect(DEFAULT_POLICY.launch).toEqual({ command: ["claude"], via: "shell" });
    expect(DEFAULT_POLICY.protected).toEqual(["manager"]);
    expect(loadPolicy(policyFile({ session: "work" }))).toMatchObject({ launch: { command: ["claude"], via: "shell" }, protected: ["manager"] });
  });

  it("takes the owner's launcher and protected names, and keeps the default for a field of launch it doesn't set", () => {
    expect(loadPolicy(policyFile({ launch: { command: ["claude-as", "{account}"], via: "shell" }, protected: ["manager", "kira"] })))
      .toMatchObject({ launch: { command: ["claude-as", "{account}"], via: "shell" }, protected: ["manager", "kira"] });
    expect(loadPolicy(policyFile({ launch: { via: "direct" } })).launch).toEqual({ command: ["claude"], via: "direct" });
    expect(loadPolicy(policyFile({ protected: [] })).protected).toEqual([]);
    expect(DEFAULT_POLICY.launch.command).toEqual(["claude"]);                  // a parse never changes the defaults
  });

  it("refuses a launcher or protected names that don't fit, naming the field (negative controls for a typo widening what an op may start)", () => {
    const cases: [unknown, RegExp][] = [
      [{ launch: "claude" }, /launch must be an object/],
      [{ launch: { cmd: ["claude"] } }, /launch has an unknown field cmd/],
      [{ launch: { command: [] } }, /launch\.command must be/],
      [{ launch: { command: "claude" } }, /launch\.command must be/],
      [{ launch: { command: ["claude", "a\nb"] } }, /launch\.command must be/],
      [{ launch: { command: ["--dangerously-skip-permissions"] } }, /launch\.command must be/],
      [{ launch: { via: "tmux" } }, /launch\.via must be "shell" or "direct"/],
      [{ protected: "manager" }, /protected must be a list of lane names/],
      [{ protected: ["a\tb"] }, /protected must be a list of lane names/],
    ];
    for (const [policy, message] of cases) {
      const file = policyFile(policy);
      expect(() => loadPolicy(file), JSON.stringify(policy)).toThrow(ConfigError);
      expect(() => loadPolicy(file), JSON.stringify(policy)).toThrow(message);
    }
  });
});
