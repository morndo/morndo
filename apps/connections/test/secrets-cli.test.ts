// morndo-secrets (PLAN step 13, criteria 21 to 24; design §5.2, §6): each command once with success and once refused, on
// a real age vault and database in a throwaway home. The value, References and names are synthetic.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodedForms } from "@morndo/node-ops";
import { runSecrets, type SecretsIo } from "../src/secrets-cli.ts";

// Each test runs several real commands (age, SQLite, the index): about 3 s alone, but past the 20 s default in a full run
// under load (r1-all-units.txt), so 60 s here; what each test checks is unchanged.
vi.setConfig({ testTimeout: 60_000 });

const REF = "secret://example-app/payments-test";
const VALUE = "synthetic-value-with-slash/and+plus é";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function home() {
  const root = mkdtempSync(join(tmpdir(), "morndo-secrets-cli-"));
  dirs.push(root);
  const dir = join(root, "connections");
  return { root, dir, env: { ...process.env, MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: undefined } as NodeJS.ProcessEnv };
}

// Every byte any command wrote, for the scan of criterion 23.
const transcript: string[] = [];
async function cli(env: NodeJS.ProcessEnv, args: string[], opts: { stdin?: string | null; typed?: string | null } = {}) {
  let stdout = "";
  let stderr = "";
  const prompts: string[] = [];
  const io: SecretsIo = {
    stdout: t => { stdout += t; },
    stderr: t => { stderr += t; },
    stdin: opts.stdin === undefined || opts.stdin === null ? null : new TextEncoder().encode(opts.stdin),
    confirm: async prompt => { prompts.push(prompt); return opts.typed === undefined ? null : opts.typed; },
  };
  const code = await runSecrets(args, env, io);
  transcript.push(stdout, stderr, ...prompts);
  return { code, stdout, stderr, prompts };
}
const put = (env: NodeJS.ProcessEnv, value = VALUE, ref = REF) => cli(env, ["put", ref], { stdin: `${value}\n`, typed: ref });

describe("morndo-secrets put (criterion 21; D3)", () => {
  it("reads the value from stdin only, asks for the Reference at the terminal, and stores it", async () => {
    const h = home();
    const r = await put(h.env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.prompts).toHaveLength(1);
    expect(r.prompts[0]).toContain(REF);
    expect(r.stdout).toContain("version 1");
    expect(readdirSync(join(h.dir, "vault")).filter(n => n.startsWith("s-") && n.endsWith(".age"))).toHaveLength(1);
  });
  it("refuses a value in the arguments, no value on stdin, a mistyped Reference, no terminal, and --yes", async () => {
    const h = home();
    expect((await cli(h.env, ["put", REF, VALUE], { stdin: VALUE, typed: REF })).code).toBe(64);
    expect((await cli(h.env, ["put", REF, "--value", VALUE], { stdin: VALUE, typed: REF })).code).toBe(64);
    expect((await cli(h.env, ["put", REF], { stdin: null, typed: REF })).code).toBe(64);
    expect((await cli(h.env, ["put", REF], { stdin: "", typed: REF })).code).toBe(64);
    const mistyped = await cli(h.env, ["put", REF], { stdin: VALUE, typed: "secret://example-app/payments" });
    expect(mistyped.code).toBe(1);
    expect(mistyped.stderr).toContain("not confirmed");
    expect((await cli(h.env, ["put", REF], { stdin: VALUE, typed: null })).code).toBe(1);
    expect((await cli(h.env, ["put", REF, "--yes"], { stdin: VALUE, typed: REF })).code).toBe(64);
    expect(existsVault(h.dir)).toEqual([]);
  });
  it("strips one trailing newline unless --raw, so the same text piped twice is the same value", async () => {
    const h = home();
    expect((await cli(h.env, ["put", REF], { stdin: `${VALUE}\n`, typed: REF })).code).toBe(0);
    const again = await cli(h.env, ["put", REF], { stdin: VALUE, typed: REF });
    expect(again.stderr).toContain("earlier");
    const raw = await cli(h.env, ["put", REF, "--raw"], { stdin: `${VALUE}\n`, typed: REF });
    expect(raw.code, raw.stderr).toBe(0);
    expect(raw.stdout).toContain("version 2");
  });
  it("criterion 17: a value under 8 bytes is stored, and put says it isn't indexed", async () => {
    const h = home();
    const r = await put(h.env, "short");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/under 8 bytes.*not indexed/);
  });
});

describe("the other commands: one success and one refusal each (criterion 22)", () => {
  it("list and log show metadata only; an unknown Reference is refused", async () => {
    const h = home();
    await put(h.env);
    const listed = await cli(h.env, ["list"]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout.trim().split("\n")[0] ?? "")).toMatchObject({ reference: REF, status: "active", version: 1 });
    expect((await cli(h.env, ["list", "extra"])).code).toBe(64);
    const logged = await cli(h.env, ["log", REF]);
    expect(logged.code).toBe(0);
    expect(logged.stdout).toContain("SecretStored");
    expect((await cli(h.env, ["log", "not-a-reference"])).code).toBe(64);
  });
  it("grant widens, so it needs the typed Reference; a bad grant is refused", async () => {
    const h = home();
    await put(h.env);
    expect((await cli(h.env, ["grant", REF, "--lane", "lane-a", "--mode", "exec"], { typed: "nope" })).code).toBe(1);
    const granted = await cli(h.env, ["grant", REF, "--lane", "lane-a", "--mode", "exec"], { typed: REF });
    expect(granted.code, granted.stderr).toBe(0);
    expect((await cli(h.env, ["list"])).stdout).toContain("lane-a");
    expect((await cli(h.env, ["grant", REF, "--lane", "lane-a", "--mode", "teleport"], { typed: REF })).code).toBe(64);
  });
  it("disable needs no confirmation (SC7); enable does", async () => {
    const h = home();
    await put(h.env);
    const disabled = await cli(h.env, ["disable", REF], { typed: null });
    expect(disabled.code, disabled.stderr).toBe(0);
    expect(disabled.prompts).toEqual([]);
    expect((await cli(h.env, ["disable", REF])).stderr).toContain("same");
    expect((await cli(h.env, ["enable", REF], { typed: null })).code).toBe(1);
    expect((await cli(h.env, ["enable", REF], { typed: REF })).code).toBe(0);
  });
  it("revoke removes the vault file (SC8); a second revoke is refused", async () => {
    const h = home();
    await put(h.env);
    const revoked = await cli(h.env, ["revoke", REF], { typed: REF });
    expect(revoked.code, revoked.stderr).toBe(0);
    expect(existsVault(h.dir)).toEqual([]);
    expect((await cli(h.env, ["revoke", REF], { typed: REF })).stderr).toContain("revoked");
    expect((await cli(h.env, ["list"])).stdout).toContain("\"status\":\"revoked\"");
  });
  it("delete removes the Reference; a missing one is refused", async () => {
    const h = home();
    await put(h.env);
    expect((await cli(h.env, ["delete", REF], { typed: REF })).code).toBe(0);
    expect((await cli(h.env, ["list"])).stdout).toBe("");
    expect((await cli(h.env, ["delete", REF], { typed: REF })).stderr).toContain("missing");
  });
  it("recipient prints the node's age recipient and a short fingerprint; the plaintext vault has none", async () => {
    const h = home();
    const r = await cli(h.env, ["recipient"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^age1[0-9a-z]+ [0-9a-f]{12}\n$/);
    expect((await cli(h.env, ["recipient"])).stdout).toBe(r.stdout);
    expect((await cli({ ...h.env, MORNDO_VAULT: "file" }, ["recipient"])).code).toBe(1);
  });
  it("an unknown command is refused", async () => {
    expect((await cli(home().env, ["show", REF])).code).toBe(64);
  });
});

describe("workspace add (criterion 24)", () => {
  it("registers the root git --git-common-dir names; a second worktree of it is the same workspace", async () => {
    const h = home();
    const repo = join(h.root, "example-app");
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "one");
    git("worktree", "add", "-q", join(h.root, "example-app-b"));
    const added = await cli(h.env, ["workspace", "add", repo], { typed: repo });
    expect(added.code, added.stderr).toBe(0);
    expect(added.stdout).toContain("example-app");
    const second = await cli(h.env, ["workspace", "add", join(h.root, "example-app-b")], { typed: join(h.root, "example-app-b") });
    expect(second.stderr).toContain("same");
    expect((await cli(h.env, ["workspace", "add", h.dir], { typed: h.dir })).stderr).toContain("not_repository");
  });
});

describe("criterion 23: no command prints the value", () => {
  it("the output of every command above holds no indexed encoding of the value", () => {
    const out = new TextEncoder().encode(transcript.join("\n"));
    expect(out.length).toBeGreaterThan(0);
    for (const form of encodedForms(new TextEncoder().encode(VALUE))) {
      expect(indexOf(out, form.bytes), `${form.encoding}/${form.alignment}`).toBe(-1);
    }
  });
});

function existsVault(dir: string): string[] {
  try { return readdirSync(join(dir, "vault")).filter(n => n.startsWith("s-")); } catch { return []; }
}

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
