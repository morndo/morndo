// Codex launch line. Checked 2026-10-10.
// [model_providers.<id>.auth] command prints the token to stdout. timeout_ms 5000.
// refresh_interval_ms defaults to 300000; the launcher sets 60000. Do not set env_key.
// Project config cannot override model_providers; they live in the user config (CODEX_HOME).
// https://developers.openai.com/codex/config-advanced
// https://developers.openai.com/codex/config-reference
// default_permissions and [permissions.*] do not compose with sandbox_mode.
// If sandbox_mode is set, Codex uses the older sandbox instead of permission profiles.
// Built-ins: :read-only, :workspace, :danger-full-access.
// https://developers.openai.com/codex/permissions
import { binCommand } from "./spawn-bin.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Isolation } from "@morndo/domain";
import type { RunHandle, RunPlan, Runtime } from "../application/ports.ts";
import { assertSubscription, childEnv, loginEnv, runChild, StatusRefused, statusOf, type ChildHooks, type ChildResult } from "./runtime-claude.ts";
import { poolRunHome } from "./codex-pool-home.ts";
import { CODEX_AUTH_TIMEOUT_MS, HELPER_TTL_MS } from "./runtime-limits.ts";

function quoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

export function isolationFromProfile(text: string): Isolation {
  const permissions = /^\s*default_permissions\s*=\s*"([^"]+)"/m.exec(text)?.[1];
  const sandbox = /^\s*sandbox_mode\s*=\s*"([^"]+)"/m.exec(text)?.[1];
  const mode = sandbox ?? permissions ?? "";
  if (mode === "danger-full-access" || mode === ":danger-full-access") return "none";
  if (sandbox) return "rules";
  if (mode === ":read-only" || mode === ":workspace" || mode === "read-only" || mode === "workspace-write") return "rules";
  if (profileCanDenyReads(text)) return "os";
  return "rules";
}

export function profileCanDenyReads(text: string): boolean {
  const name = permissionName(text);
  if (!name) return false;
  return text.includes(`[permissions.${name}.filesystem`);
}

export function permissionName(text: string): string | null {
  const name = /^\s*default_permissions\s*=\s*"([^"]+)"/m.exec(text)?.[1];
  if (!name || name.startsWith(":") || name === "danger-full-access" || name === "read-only" || name === "workspace-write") return null;
  return name;
}

// Vendor root keys follow model_provider and precede every table. A root key the profile already
// sets is the profile's: Codex reads one value, and a later -c on the command line still wins.
export function codexConfig(profile: string, deny: readonly string[], auth: string, vendor = ""): string {
  if (/^\s*model_provider\s*=/m.test(profile)) {
    throw new Error("profile sets model_provider; remove it so the morndo provider stays selected");
  }
  const root = auth.split("\n").filter(line => line.startsWith("model_provider = ")).join("\n");
  const tables = auth.split("\n").filter(line => !line.startsWith("model_provider = ")).join("\n").trim();
  const name = permissionName(profile);
  const denies = name
    ? deny.map(path => `[permissions.${name}.filesystem.${quoted(path)}]\n"." = "deny"\n`).join("\n")
    : "";
  return `${root}\n${vendorRoot(vendor, profile)}${profile.trim()}\n${denies}${tables}\n`;
}

// Hosted web_search is OpenAI's tool and cannot run on any other endpoint (HTTP 400).
// OpenAI's own host gets no vendor lines, so those key runs stay as they were. Every other
// endpoint turns the tool off and, when the plan names an effort, sets it. A host that only
// looks like OpenAI's, or a base URL with no scheme, is not OpenAI's. Codex 0.161.0 takes any
// non-empty effort: its ReasoningEffort has none, minimal, low, medium, high, xhigh, max, ultra,
// persistent and Custom(String) for the rest (codex-rs/protocol/src/openai_models.rs at rust-v0.161.0),
// and the config reference says the levels depend on the model
// (https://learn.chatgpt.com/docs/config-file/config-reference). Mistral's GLM 5.3 takes low, high
// and max (probe 2026-11-07). Only a trimmed, lowercased plain word reaches the file.
const EFFORT_WORD = /^[a-z][a-z0-9_-]{0,31}$/;

export function codexVendorToml(baseUrl: string, effort: string, warn = (line: string) => { process.stderr.write(`${line}\n`); }): string {
  if (openAiApiHost(baseUrl)) return "";
  const lines = ['web_search = "disabled"'];
  const word = effort.trim().toLowerCase();
  if (EFFORT_WORD.test(word)) lines.push(`model_reasoning_effort = ${quoted(word)}`);
  else if (word !== "") warn(`codex effort ${JSON.stringify(effort.trim())} is not one plain word (letters, digits, - and _, up to 32); model_reasoning_effort is not set, so the model's own default effort is used`);
  return lines.join("\n");
}

function openAiApiHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return (host.endsWith(".") ? host.slice(0, -1) : host) === "api.openai.com";
  } catch {
    return false;
  }
}

function rootKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) break;
    const key = /^([A-Za-z0-9_-]+)\s*=/.exec(trimmed)?.[1];
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

function vendorRoot(vendor: string, profile: string): string {
  if (vendor === "") return "";
  const taken = rootKeys(profile);
  const kept: string[] = [];
  for (const line of vendor.split("\n")) {
    const trimmed = line.trim();
    const key = /^([A-Za-z0-9_-]+)\s*=/.exec(trimmed)?.[1];
    if (key === undefined || taken.has(key)) continue;
    kept.push(trimmed);
  }
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
}

export function codexAuthToml(command: string, args: readonly string[], baseUrl: string): string {
  const argList = args.map(quoted).join(", ");
  return [
    `model_provider = "morndo"`,
    ``,
    `[model_providers.morndo]`,
    `name = "Morndo"`,
    `base_url = ${quoted(baseUrl)}`,
    `wire_api = "responses"`,
    ``,
    `[model_providers.morndo.auth]`,
    `command = ${quoted(command)}`,
    `args = [${argList}]`,
    `timeout_ms = ${CODEX_AUTH_TIMEOUT_MS}`,
    `refresh_interval_ms = ${HELPER_TTL_MS}`,
    ``,
  ].join("\n");
}

// A subscription run must not write the login directory. -c overlays the loaded config, and a
// sandbox_mode in that file makes Codex ignore permission profiles (permissions guide, 2026-10-10).
// --ignore-user-config is only on `codex exec` (codex-cli 0.161.0 --help, 2026-10-10). The run
// therefore uses its own CODEX_HOME: config.toml is written there, and auth.json is a link to the
// login file. https://developers.openai.com/codex/config-reference
// https://developers.openai.com/codex/auth
// https://developers.openai.com/codex/permissions
export function defaultCodexLogin(parent: NodeJS.ProcessEnv): string {
  const home = parent.HOME && parent.HOME !== "" ? parent.HOME : homedir();
  return join(home, ".codex");
}

export function subscriptionRunHome(login: string, profile: string, deny: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "morndo-codex-run-"));
  const auth = join(login, "auth.json");
  // A symlink, not a copy. Codex saves auth.json with OpenOptions truncate+write+create, so a
  // token refresh writes through the link into the login file (codex-rs/login/src/auth/storage.rs,
  // FileAuthStorage::save, tag rust-v0.161.0).
  // https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/login/src/auth/storage.rs
  if (existsSync(auth)) symlinkSync(auth, join(dir, "auth.json"));
  // Session files are $CODEX_HOME/sessions/YYYY/MM/DD (SESSIONS_SUBDIR in
  // codex-rs/rollout/src/lib.rs; recorder.rs pushes that directory, tag rust-v0.161.0).
  // Message history is $CODEX_HOME/history.jsonl (codex-rs/message-history/src/lib.rs).
  // https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/rollout/src/lib.rs
  // https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/rollout/src/recorder.rs
  // https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/message-history/src/lib.rs
  linkFromLogin(login, dir, "sessions", true);
  linkFromLogin(login, dir, "history.jsonl", false);
  writeFileSync(join(dir, "config.toml"), codexConfig(profile, deny, ""), { mode: 0o600 });
  return dir;
}

// The keyring entry is a hash of the canonical CODEX_HOME (compute_store_key in
// codex-rs/login/src/auth/storage.rs, tag rust-v0.161.0). A different run home cannot find it.
// cli_auth_credentials_store is file, keyring, auto, or ephemeral.
// https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/login/src/auth/storage.rs
// https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/config/src/types.rs
export function keyringLogin(text: string): boolean {
  const mode = /^\s*cli_auth_credentials_store\s*=\s*"([^"]+)"/mi.exec(text)?.[1]?.toLowerCase();
  return mode === "keyring" || mode === "auto";
}

function loginConfig(login: string): string {
  try { return readFileSync(join(login, "config.toml"), "utf8"); }
  catch { return ""; }
}

function linkFromLogin(login: string, run: string, name: string, directory: boolean): void {
  const target = join(login, name);
  if (directory && !existsSync(target)) mkdirSync(target, { recursive: true, mode: 0o700 });
  symlinkSync(target, join(run, name));
}

export function helperParts(launcher: string, lease: string): { command: string; args: string[] } {
  return { command: launcher, args: ["helper", "--lease", lease] };
}

export class CodexRuntime implements Runtime {
  readonly #bin: string;
  readonly #profilePath: string;
  readonly #configDir: string | null;
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #baseUrl: string;
  readonly #parent: NodeJS.ProcessEnv;
  constructor(input: {
    bin: string; profilePath: string; configDir: string | null; command: string; args: readonly string[];
    baseUrl: string; parent: NodeJS.ProcessEnv;
  }) {
    this.#bin = input.bin;
    this.#profilePath = input.profilePath;
    this.#configDir = input.configDir;
    this.#command = input.command;
    this.#args = input.args;
    this.#baseUrl = input.baseUrl;
    this.#parent = input.parent;
  }

  isolation(): Isolation {
    try { return isolationFromProfile(readFileSync(this.#profilePath, "utf8")); }
    catch { return "rules"; }
  }
  dialects(): readonly string[] { return ["openai-responses"]; }
  // codex login status prints the active authentication mode and exits 0 when logged in.
  // https://developers.openai.com/codex/cli/reference (read 2026-10-10).
  loginStatus(configDir: string | null): Promise<"ok" | "missing" | "unknown"> {
    return statusOf(this.#bin, ["login", "status"], childEnv(this.#parent, loginEnv("codex", configDir)));
  }
  async launch(plan: RunPlan): Promise<RunHandle> {
    try { await this.execute(plan, []); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${this.#bin} is not on PATH`);
      throw error;
    }
    return { id: plan.lease };
  }

  // `shared` is a pool turn: its home links the conversation store every account shares (ADR-0029), and its child leads a group of its own.
  async execute(plan: RunPlan, extra: readonly string[], hooks?: ChildHooks, shared?: string): Promise<ChildResult> {
    const started = binCommand(this.#bin, extra);
    if (plan.subscription) {
      const env = childEnv(this.#parent, loginEnv("codex", plan.configDir));
      await assertSubscription(this.#bin, ["login", "status"], env, "codex");
      const login = plan.configDir ?? defaultCodexLogin(this.#parent);
      if (keyringLogin(loginConfig(login))) {
        throw new StatusRefused("a keyring login stays in its own directory; this run uses another home and cannot find it");
      }
      const runHome = shared === undefined ? subscriptionRunHome(login, this.#profileText(), plan.deny) : poolRunHome(login, shared, this.#profileText(), plan.deny);
      try {
        return await runChild(started.command, started.argv, {
          env: childEnv(this.#parent, loginEnv("codex", runHome)),
          cwd: plan.workspace,
          ...(hooks ? { hooks } : {}),
          ...(shared === undefined ? {} : { detached: true }),
        });
      } finally {
        rmSync(runHome, { recursive: true, force: true });
      }
    }
    const profile = this.#profileText();
    const config = codexConfig(
      profile,
      plan.deny,
      codexAuthToml(this.#command, this.#args, this.#baseUrl),
      codexVendorToml(this.#baseUrl, plan.effort),
    );
    if (!this.#configDir) throw new Error("missing config dir");
    const path = `${this.#configDir}/config.toml`;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, config, { mode: 0o600 });
    return runChild(started.command, started.argv, {
      env: childEnv(this.#parent, loginEnv("codex", this.#configDir)),
      cwd: plan.workspace,
      ...(hooks ? { hooks } : {}),
    });
  }

  #profileText(): string {
    try { return readFileSync(this.#profilePath, "utf8"); }
    catch { return ""; }
  }
}
