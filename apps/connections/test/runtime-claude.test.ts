import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunPlan } from "../src/application/ports.ts";
import { anthropicGatewayEnv, baseUrlProblem, childEnv, ClaudeRuntime, claudeArgv, claudeIsolation, claudeSettings, GATEWAY_ENV_KEYS, isThirdPartyAnthropicBase, pathDenied, sandboxReady } from "../src/adapters/runtime-claude.ts";
import { HELPER_LIMIT, HELPER_TTL_MS } from "../src/adapters/runtime-limits.ts";

const plan: RunPlan = {
  lease: "l1", connection: "credit", ref: "key-credit", configDir: "/tmp/cfg", model: "sonnet-5.5",
  effort: "high", workspace: "/tmp/work", deny: ["/tmp/vault"], reservation: 2, probe: false,
};

describe("anthropic-compatible base URL", () => {
  it("points the child at the third-party base and keeps the key out of the environment", () => {
    const key = "sk-ant-synthetic-test-key-0001";
    const env = childEnv(
      { PATH: "/usr/bin", ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: "https://inherited.example" },
      anthropicGatewayEnv("http://127.0.0.1:9", "glm-5.3"),
    );
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9");
    expect(env.ANTHROPIC_MODEL).toBe("glm-5.3");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5.3");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-5.3");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("glm-5.3");
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("glm-5.3");
    const flash = childEnv({}, anthropicGatewayEnv("http://127.0.0.1:9", "glm-5.3", "max", "glm-5.3-flash"));
    expect(flash.ANTHROPIC_MODEL).toBe("glm-5.3");
    expect(flash.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5.3");
    expect(flash.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-5.3");
    expect(flash.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("glm-5.3-flash");
    expect(flash.CLAUDE_CODE_SUBAGENT_MODEL).toBe("glm-5.3");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain(key);
    const first = childEnv({}, anthropicGatewayEnv("https://api.anthropic.com", "sonnet-5.5", "", "", "api.anthropic.com"));
    expect(first.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(first.ANTHROPIC_MODEL).toBeUndefined();
  });

  it("keeps placeholder model names out of the gateway environment", () => {
    for (const name of ["default", "ask"]) {
      const env = childEnv({}, anthropicGatewayEnv("http://127.0.0.1:9", name));
      expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9");
      expect(env.ANTHROPIC_MODEL).toBeUndefined();
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
      expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    }
  });
});

describe("gateway env keys", () => {
  it("keeps every gateway variable from one list, and reads the first-party host from the caller", () => {
    const source = readFileSync(join(import.meta.dirname, "../src/adapters/runtime-claude.ts"), "utf8");
    expect(source).not.toContain("api.anthropic.com");
    const host = "api.anthropic.com";
    expect(isThirdPartyAnthropicBase("https://API.ANTHROPIC.COM", host)).toBe(false);
    expect(isThirdPartyAnthropicBase("https://api.anthropic.com:443", host)).toBe(false);
    expect(isThirdPartyAnthropicBase("https://api.anthropic.com:8443", host)).toBe(true);
    const extra = anthropicGatewayEnv("http://127.0.0.1:9", "glm-5.3", "max", "glm-5.3-flash", host);
    expect(Object.keys(extra).sort()).toEqual([...GATEWAY_ENV_KEYS].sort());
    const env = childEnv({ ANTHROPIC_API_KEY: "sk-ant-synthetic-test-key-0001", ANTHROPIC_MODEL: "inherited" }, extra);
    for (const key of GATEWAY_ENV_KEYS) expect(env[key]).toBe(extra[key]);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("base URL", () => {
  it("refuses an empty or unparseable base instead of leaving the host unset", () => {
    expect(baseUrlProblem("")).toBe("base URL missing or invalid");
    expect(baseUrlProblem("not a url")).toBe("base URL missing or invalid");
    expect(baseUrlProblem("https://api.z.ai/api/anthropic")).toBeNull();
    expect(anthropicGatewayEnv("", "glm-5.3")).toEqual({});
    expect(() => anthropicGatewayEnv("not a url", "glm-5.3")).toThrow(/base URL/);
  });
});

describe("third-party run settings", () => {
  it("denies WebSearch behind a third-party base and leaves it on the first-party host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-websearch-"));
    const fixture = join(import.meta.dirname, "fixtures/fake-runtime.mjs");
    const record = join(dir, "record.json");
    const jobPath = join(dir, "job.json");
    const denyOf = async (baseUrl: string): Promise<string[]> => {
      writeFileSync(jobPath, JSON.stringify({ record, exit: 0 }));
      const runtime = new ClaudeRuntime(fixture, "helper", {}, baseUrl, "api.anthropic.com");
      const ran = await runtime.execute({ ...plan, workspace: dir }, ["--job", jobPath]);
      expect(ran.status).toBe(0);
      const recorded = JSON.parse(readFileSync(record, "utf8")) as { argv: string[] };
      const settings = JSON.parse(recorded.argv[recorded.argv.indexOf("--settings") + 1] ?? "{}") as { permissions: { deny: string[] } };
      return settings.permissions.deny;
    };
    try {
      expect(await denyOf("http://127.0.0.1:9")).toContain("WebSearch");
      expect(await denyOf("https://api.anthropic.com")).not.toContain("WebSearch");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("runtime flags", () => {
  it("passes the helper, the reservation and a denied path", () => {
    const argv = claudeArgv("claude", plan, "morndo-keys helper --lease l1", ["--job", "job.json"]);
    expect(argv).toContain("-p");
    expect(argv).toContain("--output-format");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("json");
    expect(argv).toContain("--max-budget-usd");
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("2.00");
    const settings = JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "{}") as {
      apiKeyHelper: string;
      permissions: { deny: string[] };
      sandbox: {
        enabled: boolean; failIfUnavailable: boolean; allowUnsandboxedCommands: boolean;
        filesystem: { denyRead: string[] }; credentials: { envVars: { name: string; mode: string }[] };
      };
    };
    expect(settings.apiKeyHelper).toBe("morndo-keys helper --lease l1");
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.failIfUnavailable).toBe(true);
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(settings.sandbox.filesystem.denyRead).toEqual(["/tmp/vault"]);
    expect(settings.permissions.deny).toContain("Read(//tmp/vault/**)");
    const root = mkdtempSync(join(tmpdir(), "morndo-rules-"));
    try {
      const file = join(root, "connections.db");
      const identity = join(root, "identity");
      writeFileSync(file, "db");
      writeFileSync(identity, "key");
      const argv = claudeArgv("claude", { ...plan, deny: [root, file, identity] }, "helper", []);
      const ruled = JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "{}") as { permissions: { deny: string[] } };
      expect(ruled.permissions.deny).toContain(`Read(/${root}/**)`);
      expect(ruled.permissions.deny).toContain(`Read(/${file})`);
      expect(ruled.permissions.deny).toContain(`Read(/${identity})`);
      expect(ruled.permissions.deny).not.toContain(`Read(/${identity}/**)`);
    } finally { rmSync(root, { recursive: true, force: true }); }
    expect(sandboxReady(settings.sandbox)).toBe(true);
    expect(sandboxReady({ enabled: true, failIfUnavailable: false, allowUnsandboxedCommands: false })).toBe(false);
    expect(new ClaudeRuntime("claude", "helper", {}).isolation()).toBe("os");
    const subscription = JSON.parse(claudeSettings(plan, null)) as { apiKeyHelper?: string; permissions: { deny: string[] }; sandbox: { filesystem: { denyRead: string[] } } };
    expect(subscription.apiKeyHelper).toBeUndefined();
    expect(subscription.permissions.deny).toContain("Read(//tmp/vault/**)");
    expect(subscription.sandbox.filesystem.denyRead).toEqual(["/tmp/vault"]);
    expect(claudeIsolation(claudeSettings(plan, null))).toBe("os");
    expect(claudeIsolation(JSON.stringify({ permissions: { deny: [] }, sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }))).toBe("rules");
    expect(settings.sandbox.credentials.envVars).toContainEqual({ name: "ANTHROPIC_API_KEY", mode: "deny" });
    expect(pathDenied("/tmp/vault/key", ["/tmp/vault"])).toBe(true);
    expect(pathDenied("/tmp/other", ["/tmp/vault"])).toBe(false);
    expect(HELPER_TTL_MS).toBe(60_000);
    expect(HELPER_LIMIT).toBe(4);
  });

  it("drops inherited key variables and keeps the connection directory", () => {
    const env = childEnv({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "sk-ant-synthetic-test-key-0001",
      ANTHROPIC_AUTH_TOKEN: "tok",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      OPENAI_API_KEY: "sk-openai",
      CODEX_API_KEY: "sk-codex",
      CURSOR_API_KEY: "sk-cursor",
    }, {
      CLAUDE_CONFIG_DIR: "/cfg",
      CODEX_HOME: "/codex",
      CURSOR_CONFIG_DIR: "/cursor",
      ANTHROPIC_API_KEY: "sk-ant-synthetic-test-key-0001",
      CODEX_API_KEY: "sk-codex",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/cfg");
    expect(env.CODEX_HOME).toBe("/codex");
    expect(env.CURSOR_CONFIG_DIR).toBe("/cursor");
    expect(JSON.stringify(env)).not.toContain("sk-");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });

  it("cites the pages checked on 2026-10-10", () => {
    const source = readFileSync(join(import.meta.dirname, "../src/adapters/runtime-claude.ts"), "utf8");
    const limits = readFileSync(join(import.meta.dirname, "../src/adapters/runtime-limits.ts"), "utf8");
    expect(source).toContain("https://code.claude.com/docs/en/cli-reference");
    expect(source).toContain("https://code.claude.com/docs/en/llm-gateway-connect");
    expect(source).toContain("https://code.claude.com/docs/en/settings-reference");
    expect(source).toContain("https://code.claude.com/docs/en/env-vars");
    expect(source).toContain("failIfUnavailable is the guard");
    expect(source).not.toMatch(/isolation\(\): Isolation \{ return sandboxReady/);
    expect(source).toMatch(/isolation\(\): Isolation \{\n\s*return sandboxReady\(SANDBOX\) \? "os" : "rules"/);
    expect(source).toContain("2026-10-10");
    const cli = readFileSync(join(import.meta.dirname, "../src/cli.ts"), "utf8");
    expect(cli).not.toContain("stdout +=");
    expect(cli).not.toContain("stderr +=");
    expect(limits).toContain("2026-10-10");
  });
});
