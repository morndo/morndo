// The proof gate's own settings (ADR-0035 step 3): the mode, the repositories the hub reads, and the forge credential
// (optional; a value does appear in these assertions, built at runtime so none sits in the source).
import { describe, expect, it } from "vitest";
import { loadConfig, standInNotice } from "../src/config.ts";

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

  it("MORNDO_FORGE_URL defaults to null and accepts a bare http(s) origin without a token", () => {
    expect(loadConfig({}).forgeUrl).toBeNull();
    expect(loadConfig({ MORNDO_FORGE_URL: "" }).forgeUrl).toBeNull();
    expect(loadConfig({ MORNDO_FORGE_URL: "http://127.0.0.1:9" }).forgeUrl).toBe("http://127.0.0.1:9");
    expect(loadConfig({ MORNDO_FORGE_URL: "https://forge.test" }).forgeUrl).toBe("https://forge.test");
  });

  it("MORNDO_FORGE_URL refuses a path, credentials, a non-http scheme and garbage", () => {
    expect(() => loadConfig({ MORNDO_FORGE_URL: "http://127.0.0.1:9/repos" })).toThrow(/MORNDO_FORGE_URL/);
    expect(() => loadConfig({ MORNDO_FORGE_URL: "http://user:pass@127.0.0.1" })).toThrow(/MORNDO_FORGE_URL/);
    expect(() => loadConfig({ MORNDO_FORGE_URL: "ftp://127.0.0.1" })).toThrow(/MORNDO_FORGE_URL/);
    expect(() => loadConfig({ MORNDO_FORGE_URL: "not-a-url" })).toThrow(/MORNDO_FORGE_URL/);
  });

  it("MORNDO_FORGE_URL cannot be set together with MORNDO_GITHUB_TOKEN_FILE", () => {
    const msg = "MORNDO_FORGE_URL names a stand-in forge and cannot be used with MORNDO_GITHUB_TOKEN_FILE: the token would be sent to it";
    expect(() => loadConfig({
      MORNDO_FORGE_URL: "http://127.0.0.1:9",
      MORNDO_GITHUB_TOKEN_FILE: "/run/secrets/forge-read",
    })).toThrow(msg);
  });

  it("a stand-in forge is announced at start: the notice names the address and says it is not GitHub", () => {
    expect(standInNotice(loadConfig({}))).toBeNull();
    const notice = standInNotice(loadConfig({ MORNDO_FORGE_URL: "http://127.0.0.1:18999" }));
    expect(notice).toContain("http://127.0.0.1:18999");
    expect(notice).toContain("stand-in forge");
    expect(notice).toContain("not from GitHub");
  });

  it("a stand-in forge is refused with the gate on, unless the hub says it is a scratch hub", () => {
    const forge = { MORNDO_FORGE_URL: "http://127.0.0.1:18999" };
    expect(() => loadConfig({ ...forge, MORNDO_PROOF_GATE: "on" })).toThrow(/stand-in forge.*MORNDO_PROOF_GATE=on/s);
    expect(loadConfig({ ...forge, MORNDO_PROOF_GATE: "on", MORNDO_SCRATCH_HUB: "1" }).forgeUrl).toBe("http://127.0.0.1:18999");
    expect(loadConfig({ ...forge, MORNDO_PROOF_GATE: "warn" }).forgeUrl).toBe("http://127.0.0.1:18999");     // recorded, never held
    expect(loadConfig({ ...forge }).proofGate).toBe("warn");
    expect(loadConfig({ MORNDO_PROOF_GATE: "on" }).proofGate).toBe("on");                                       // no stand-in: nothing to refuse
  });
});

