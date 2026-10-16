// Claude Code launch line. Checked 2026-10-10.
// --settings is a path or inline JSON and overrides same-named keys for the session.
// --max-budget-usd is print mode only (claude -p). Spend can pass the cap.
// https://code.claude.com/docs/en/cli-reference
// apiKeyHelper prints only the credential; Claude Code sends it as Authorization and x-api-key.
// https://code.claude.com/docs/en/llm-gateway-connect
// sandbox.enabled defaults to false, so denyRead does nothing until it is true.
// failIfUnavailable defaults to false: a missing sandbox then runs unsandboxed.
// allowUnsandboxedCommands defaults to true: a blocked command can retry outside the sandbox.
// All three are set here, checked 2026-10-10.
// failIfUnavailable is the guard: a host that cannot start the sandbox fails the run.
// isolation() reports os for that reason. There is no separate host probe.
// https://code.claude.com/docs/en/settings-reference
// sandbox.credentials.envVars is { name, mode: "deny" | "mask" }.
// sandbox.filesystem.denyRead is an array of path prefixes (trailing slash stripped).
// permissions.deny blocks the Read tool; denyRead covers only sandboxed Bash.
// A file is Read(//absolute). A directory is Read(//absolute/**). Checked 2026-10-10:
// Read(./.env), Read(./config/credentials.json), Read(./secrets/**), Read(//etc/secrets/**).
// https://code.claude.com/docs/en/settings-reference
// CLAUDE_CODE_API_KEY_HELPER_TTL_MS overrides the helper cache.
// https://code.claude.com/docs/en/env-vars
import { spawn, type SpawnOptions } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Isolation } from "@morndo/domain";
import { BUILTIN_FIRST_PARTY_HOST } from "@morndo/protocol";
import type { RunHandle, RunPlan, Runtime } from "../application/ports.ts";
import { PLACEHOLDER_MODELS } from "./models.ts";
import { HELPER_TTL_MS } from "./runtime-limits.ts";

const ENV_ALLOW = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ"] as const;

const DENIED_NAMES = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY",
] as const;

export type ChildResult = { status: number; stdout: string; stderr: string };
export type ChildHooks = { onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void };

export function runChild(command: string, args: readonly string[], options: {
  env: NodeJS.ProcessEnv; cwd: string; hooks?: ChildHooks;
}): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env, cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const decodeOut = new StringDecoder("utf8");
    const decodeErr = new StringDecoder("utf8");
    const out: string[] = [];
    const err: string[] = [];
    const take = (decoder: StringDecoder, parts: string[], chunk: Buffer, hook?: (text: string) => void) => {
      const text = decoder.write(chunk);
      if (text === "") return;
      parts.push(text);
      hook?.(text);
    };
    child.stdout.on("data", (chunk: Buffer) => { take(decodeOut, out, chunk, options.hooks?.onStdout); });
    child.stderr.on("data", (chunk: Buffer) => { take(decodeErr, err, chunk, options.hooks?.onStderr); });
    child.on("error", reject);
    child.on("close", status => {
      const tailOut = decodeOut.end();
      const tailErr = decodeErr.end();
      if (tailOut !== "") { out.push(tailOut); options.hooks?.onStdout?.(tailOut); }
      if (tailErr !== "") { err.push(tailErr); options.hooks?.onStderr?.(tailErr); }
      resolve({ status: status ?? 1, stdout: out.join(""), stderr: err.join("") });
    });
  });
}

export function pathDenied(path: string, deny: readonly string[]): boolean {
  return deny.some(prefix => {
    const root = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    return path === root || path.startsWith(`${root}/`);
  });
}

const PRODUCT = ["MORNDO_CONNECTIONS_HOME", "MORNDO_VAULT", "MORNDO_CATALOG"] as const;

// claude auth status exits 0 when signed in and 1 when not. JSON includes authMethod and configDirectory
// from Claude Code 2.1.268. https://code.claude.com/docs/en/cli-reference (read 2026-10-10).
export class StatusRefused extends Error {
  readonly exit = 75;
  constructor(message: string) {
    super(message);
    this.name = "StatusRefused";
  }
}

export function isStatusRefusal(error: unknown): error is StatusRefused {
  return error instanceof StatusRefused;
}

export type AuthReading =
  | { signedIn: boolean; method: string | null }
  | "unknown"
  | "denied"
  | "timeout"
  | { killed: NodeJS.Signals };

// A cold `codex login status` took 14.6 s with the disk busy (2026-10-16), and 15 s failed every turn then as "timed out".
export const STATUS_TIMEOUT_MS = 60_000;

export function readAuth(bin: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = STATUS_TIMEOUT_MS): Promise<AuthReading> {
  const script = bin.endsWith(".mjs") || bin.endsWith(".js");
  const command = script ? process.execPath : bin;
  const argv = [...(script ? [bin] : []), ...args];
  const options: SpawnOptions = { env, stdio: ["ignore", "pipe", "pipe"], detached: true };
  return new Promise(resolve => {
    const child = spawn(command, argv, options);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    let settled = false;
    let timedOut = false;
    const finish = (reading: AuthReading) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(reading);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
      }
      finish("timeout");
    }, timeoutMs);
    child.on("error", error => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") finish("denied");
      else if (code === "ETIMEDOUT") finish("timeout");
      else finish("unknown");
    });
    child.on("close", (status, signal) => {
      if (timedOut) finish("timeout");
      else if (signal) finish({ killed: signal });
      else if (status !== 0) finish({ signedIn: false, method: null });
      else {
        const stdout = Buffer.concat(out).toString("utf8");
        const stderr = Buffer.concat(err).toString("utf8");
        const method = authMethod(stdout, stderr);
        if (signedOutLine(`${stdout}\n${stderr}`)) finish({ signedIn: false, method });
        else finish({ signedIn: true, method });
      }
    });
  });
}

export function authMethod(stdout: string, stderr = ""): string | null {
  for (const text of [stdout, stderr]) {
    const trimmed = text.trim();
    const at = trimmed.indexOf("{");
    if (at < 0) continue;
    try {
      const body = JSON.parse(trimmed.slice(at)) as { authMethod?: unknown };
      if (typeof body.authMethod === "string" && body.authMethod !== "") return body.authMethod;
    } catch { /* a status line, not JSON */ }
  }
  const line = `${stdout}\n${stderr}`.split("\n").map(row => row.trim()).find(row => row !== "" && !row.startsWith("WARNING:"));
  return line ?? null;
}

// claude.ai is the subscription. api_key and api_key_helper are keys (cli-reference, read 2026-10-10).
// Codex prints the active mode; a ChatGPT login is the subscription (cli reference, read 2026-10-10).
// Cursor's browser login is the subscription; an API key is not (authentication page, read 2026-10-10).
export function acceptsSubscription(runtime: "claude" | "codex" | "cursor", method: string | null): boolean {
  if (method === null || method === "" || method === "none") return false;
  if (signedOutLine(method)) return false;
  if (runtime === "claude") return method === "claude.ai";
  if (runtime === "codex") return /chatgpt/i.test(method);
  if (method === "api_key" || method === "api_key_helper" || /api[_ -]?key/i.test(method)) return false;
  const line = method.replace(/^✓\s*/, "").trim();
  return line === "cursor.com" || /^logged in as\b/i.test(line);
}

function signedOutLine(method: string | null): boolean {
  if (method === null) return false;
  return /not logged in/i.test(method) || /not authenticated/i.test(method) || /unauthenticated/i.test(method);
}

export async function assertSubscription(
  bin: string, args: readonly string[], env: NodeJS.ProcessEnv, runtime: "claude" | "codex" | "cursor", timeoutMs = STATUS_TIMEOUT_MS,
): Promise<void> {
  const reading = await readAuth(bin, args, env, timeoutMs);
  if (reading === "unknown") throw new Error(`${bin} is not on PATH`);
  if (reading === "denied") throw new StatusRefused(`${bin} is denied`);
  if (reading === "timeout") throw new StatusRefused(`${bin} timed out`);
  if (typeof reading === "object" && "killed" in reading) throw new StatusRefused(`${bin} was killed by ${reading.killed}`);
  if (!reading.signedIn || !acceptsSubscription(runtime, reading.method)) throw new StatusRefused("not the subscription");
}

export function loginEnv(runtime: "claude" | "codex" | "cursor", configDir: string | null): Record<string, string> {
  if (configDir === null || configDir === "") return {};
  if (runtime === "claude") return { CLAUDE_CONFIG_DIR: configDir };
  if (runtime === "codex") return { CODEX_HOME: configDir };
  return { CURSOR_CONFIG_DIR: configDir };
}

export async function statusOf(bin: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<"ok" | "missing" | "unknown"> {
  const reading = await readAuth(bin, args, env);
  if (typeof reading !== "object" || !("signedIn" in reading)) return "unknown";
  return reading.signedIn ? "ok" : "missing";
}

// A stray inherited key beats the subscription. Cloud-provider variables, ANTHROPIC_AUTH_TOKEN and
// ANTHROPIC_API_KEY come before the signed-in account.
// https://code.claude.com/docs/en/authentication (checked 2026-10-10).
// One list. childEnv keeps these, and anthropicGatewayEnv returns only these.
export const GATEWAY_ENV_KEYS = [
  "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
] as const;

const KEPT = new Set<string>([
  "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CURSOR_CONFIG_DIR", "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
  ...GATEWAY_ENV_KEYS,
]);

// A third-party base (secret-store README §8.3). The caller passes the first-party host from the
// catalog's firstParty flag. URL.host is already lower-case and omits the scheme's default port.
export function isThirdPartyAnthropicBase(baseUrl: string, firstPartyHost: string): boolean {
  const party = firstPartyHost !== "" ? firstPartyHost : BUILTIN_FIRST_PARTY_HOST;
  let host = "";
  try { host = new URL(baseUrl).host; } catch { return false; }
  return host !== "" && host !== party;
}

export const BASE_URL_PROBLEM = "base URL missing or invalid";

export function baseUrlProblem(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (trimmed === "") return BASE_URL_PROBLEM;
  try {
    if (new URL(trimmed).host === "") return BASE_URL_PROBLEM;
  } catch {
    return BASE_URL_PROBLEM;
  }
  return null;
}

function namedModel(model: string): string | null {
  const trimmed = model.trim();
  if (trimmed === "" || PLACEHOLDER_MODELS.has(trimmed)) return null;
  return trimmed;
}

// --effort sets the session. CLAUDE_CODE_EFFORT_LEVEL is the same value, and
// CLAUDE_CODE_ALWAYS_ENABLE_EFFORT sends it for a model id the runtime does not recognise.
// https://code.claude.com/docs/en/cli-reference and https://code.claude.com/docs/en/env-vars — checked 2026-10-11.
export function anthropicGatewayEnv(baseUrl: string, model: string, effort = "", small = "", firstPartyHost = ""): Record<string, string> {
  // Empty means this runtime was given no base. A non-URL throws so a typo cannot be ignored.
  if (baseUrl.trim() !== "") {
    const problem = baseUrlProblem(baseUrl);
    if (problem) throw new Error(problem);
  }
  if (!isThirdPartyAnthropicBase(baseUrl, firstPartyHost)) return {};
  const named = namedModel(model);
  const haiku = namedModel(small) ?? named;
  const env: Record<string, string> = { ANTHROPIC_BASE_URL: baseUrl };
  if (effort !== "") {
    env.CLAUDE_CODE_EFFORT_LEVEL = effort;
    env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = "1";
  }
  if (!named && !haiku) return env;
  return {
    ...env,
    ...(named ? {
      ANTHROPIC_MODEL: named,
      ANTHROPIC_DEFAULT_OPUS_MODEL: named,
      ANTHROPIC_DEFAULT_SONNET_MODEL: named,
      CLAUDE_CODE_SUBAGENT_MODEL: named,
    } : {}),
    ...(haiku ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: haiku } : {}),
  };
}

function stripped(key: string): boolean {
  return key.startsWith("ANTHROPIC_")
    || key === "CLAUDE_CODE_USE_BEDROCK" || key === "CLAUDE_CODE_USE_VERTEX" || key === "CLAUDE_CODE_USE_FOUNDRY"
    || key === "CLAUDE_CODE_OAUTH_TOKEN"
    || key.startsWith("OPENAI_")
    || key.startsWith("CODEX_")
    || key === "CURSOR_API_KEY";
}

export function childEnv(parent: NodeJS.ProcessEnv, extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...ENV_ALLOW, ...PRODUCT]) {
    if (stripped(key)) continue;
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (stripped(key) && !KEPT.has(key)) continue;
    env[key] = value;
  }
  return env;
}

// The keys helper is the stable launcher, not a Version's own path (design: releases, section 5).
// An install writes this absolute path. A relative path is never used, including when HOME is unset.
const INSTALLED_KEYS = "/usr/local/bin/morndo-keys";

export function keysLauncher(home: string, configured?: string): string {
  if (configured !== undefined && configured.length > 0 && isAbsolute(configured)) return configured;
  if (isAbsolute(home)) return join(home, ".local", "bin", "morndo-keys");
  return INSTALLED_KEYS;
}

// A run from a checkout has no installer-written launcher. The helper must still be this program,
// on an absolute path, or the runtime receives an empty key.
export function keysProgram(
  home: string,
  configured: string | undefined,
  present: (path: string) => boolean,
  self: { command: string; args: readonly string[] },
): { command: string; args: readonly string[] } {
  const layout = keysLauncher(home, configured);
  if (present(layout)) return { command: layout, args: [] };
  return { command: self.command, args: self.args };
}

export function helperCommand(launcher: string, lease: string): string {
  return `${launcher} helper --lease ${lease}`;
}

const SANDBOX = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } as const;

export function sandboxReady(sandbox: { enabled?: boolean; failIfUnavailable?: boolean; allowUnsandboxedCommands?: boolean }): boolean {
  return sandbox.enabled === true && sandbox.failIfUnavailable === true && sandbox.allowUnsandboxedCommands === false;
}

function readRule(path: string): string[] {
  const absolute = path.startsWith("/") ? `/${path}` : path;
  try {
    return statSync(path).isDirectory() ? [`Read(${absolute}/**)`] : [`Read(${absolute})`];
  } catch {
    return [`Read(${absolute})`, `Read(${absolute}/**)`];
  }
}

// A bare tool name in permissions.deny removes that tool. WebSearch uses the first-party
// backend, so a third-party base denies it (design 8.3).
// https://code.claude.com/docs/en/permissions — checked 2026-10-11.
export function claudeSettings(plan: RunPlan, helper: string | null, denyWebSearch = false): string {
  const body: Record<string, unknown> = {
    permissions: { deny: [...plan.deny.flatMap(readRule), ...(denyWebSearch ? ["WebSearch"] : [])] },
    sandbox: {
      ...SANDBOX,
      credentials: { envVars: DENIED_NAMES.map(name => ({ name, mode: "deny" })) },
      filesystem: { denyRead: [...plan.deny] },
    },
  };
  if (helper !== null) body.apiKeyHelper = helper;
  return JSON.stringify(body);
}

export function claudeIsolation(settings: string): Isolation {
  const body = JSON.parse(settings) as {
    permissions?: { deny?: unknown[] };
    sandbox?: { enabled?: boolean; failIfUnavailable?: boolean; allowUnsandboxedCommands?: boolean };
  };
  const denies = body.permissions?.deny ?? [];
  return sandboxReady(body.sandbox ?? {}) && denies.length > 0 ? "os" : "rules";
}

export function claudeArgv(bin: string, plan: RunPlan, helper: string, extra: readonly string[], denyWebSearch = false): string[] {
  return [bin, "-p", "--effort", plan.effort, "--output-format", "json", "--settings", claudeSettings(plan, helper, denyWebSearch), "--max-budget-usd", plan.reservation.toFixed(2), ...extra];
}

export class ClaudeRuntime implements Runtime {
  readonly #bin: string;
  readonly #helper: string;
  readonly #parent: NodeJS.ProcessEnv;
  readonly #baseUrl: string;
  readonly #firstPartyHost: string;
  constructor(bin: string, helper: string, parent: NodeJS.ProcessEnv, baseUrl = "", firstPartyHost = "") {
    this.#bin = bin;
    this.#helper = helper;
    this.#parent = parent;
    this.#baseUrl = baseUrl;
    this.#firstPartyHost = firstPartyHost;
  }

  isolation(): Isolation {
    return sandboxReady(SANDBOX) ? "os" : "rules";
  }
  dialects(): readonly string[] { return ["anthropic"]; }
  loginStatus(configDir: string | null): Promise<"ok" | "missing" | "unknown"> {
    return statusOf(this.#bin, ["auth", "status"], childEnv(this.#parent, loginEnv("claude", configDir)));
  }
  async launch(plan: RunPlan): Promise<RunHandle> {
    try { await this.execute(plan, []); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${this.#bin} is not on PATH`);
      throw error;
    }
    return { id: plan.lease };
  }

  async execute(plan: RunPlan, extra: readonly string[], hooks?: ChildHooks): Promise<ChildResult> {
    const script = this.#bin.endsWith(".mjs") || this.#bin.endsWith(".js");
    const extraEnv = loginEnv("claude", plan.configDir);
    let denyWebSearch = false;
    if (plan.subscription) await assertSubscription(this.#bin, ["auth", "status"], childEnv(this.#parent, extraEnv), "claude");
    else {
      Object.assign(extraEnv, anthropicGatewayEnv(this.#baseUrl, plan.model, plan.effort, plan.smallModel ?? "", this.#firstPartyHost));
      extraEnv.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = String(HELPER_TTL_MS);
      denyWebSearch = isThirdPartyAnthropicBase(this.#baseUrl, this.#firstPartyHost);
    }
    const flags = plan.subscription
      ? ["-p", "--effort", plan.effort, "--output-format", "json", "--settings", claudeSettings(plan, null), ...extra]
      : claudeArgv(this.#bin, plan, this.#helper, extra, denyWebSearch).slice(1);
    return runChild(script ? process.execPath : this.#bin, script ? [this.#bin, ...flags] : flags, {
      env: childEnv(this.#parent, extraEnv),
      cwd: plan.workspace,
      ...(hooks ? { hooks } : {}),
    });
  }
}
