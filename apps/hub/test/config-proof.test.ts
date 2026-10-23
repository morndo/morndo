// The proof gate's own settings (ADR-0035 step 3): the mode, the repositories the hub reads, and the forge credential
// (optional; a value does appear in these assertions, built at runtime so none sits in the source).
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const TOKEN = ["forge", "token", "for", "tests"].join("-");

describe("the proof gate settings", () => {
  it("MORNDO_PROOF_GATE defaults to warn and rejects other values", () => {
    expect(loadConfig({}).proofGate).toBe("warn");
    expect(loadConfig({ MORNDO_PROOF_GATE: "off" }).proofGate).toBe("off");
    expect(loadConfig({ MORNDO_PROOF_GATE: "on" }).proofGate).toBe("on");
    expect(() => loadConfig({ MORNDO_PROOF_GATE: "maybe" })).toThrow(/MORNDO_PROOF_GATE/);
    expect(() => loadConfig({ MORNDO_PROOF_GATE: "maybe" })).toThrow(/off.*warn.*on/);   // it says what is allowed
  });

  it("MORNDO_PROOF_REPOS defaults to morndo/morndo, is split on commas and rejects a name that is not owner/repo", () => {
    expect(loadConfig({}).proofRepos).toEqual(["morndo/morndo"]);
    expect(loadConfig({ MORNDO_PROOF_REPOS: "acme/shop" }).proofRepos).toEqual(["acme/shop"]);
    expect(loadConfig({ MORNDO_PROOF_REPOS: "acme/shop, corp/bot" }).proofRepos).toEqual(["acme/shop", "corp/bot"]);   // split and trimmed
    expect(loadConfig({ MORNDO_PROOF_REPOS: "" }).proofRepos).toEqual(["morndo/morndo"]);    // empty means unset
    expect(() => loadConfig({ MORNDO_PROOF_REPOS: "acme" })).toThrow(/MORNDO_PROOF_REPOS/);
    expect(() => loadConfig({ MORNDO_PROOF_REPOS: "acme/shop,acme" })).toThrow(/MORNDO_PROOF_REPOS/);   // each one must be whole
  });

  it("MORNDO_GITHUB_TOKEN_FILE names an absolute path, is optional, and the token itself is never a setting", () => {
    expect(loadConfig({}).githubTokenFile).toBeNull();
    expect(loadConfig({ MORNDO_GITHUB_TOKEN_FILE: "" }).githubTokenFile).toBeNull();
    expect(loadConfig({ MORNDO_GITHUB_TOKEN_FILE: "/run/secrets/forge-read" }).githubTokenFile).toBe("/run/secrets/forge-read");
    expect(() => loadConfig({ MORNDO_GITHUB_TOKEN_FILE: "forge-read" })).toThrow(/MORNDO_GITHUB_TOKEN_FILE/);
    // a token put straight in the environment is not read: nothing of it reaches the settings
    const config = loadConfig({ MORNDO_GITHUB_TOKEN: TOKEN });
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    expect(config).not.toHaveProperty("githubToken");
  });
});
