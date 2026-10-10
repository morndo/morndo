import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";

const KEY = "sk-ant-synthetic-test-key-0001";
const OTHER = "sk-ant-synthetic-test-key-0002";
const catalog = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function home(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "morndo-cli-"));
  dirs.push(dir);
  return { dir, env: { ...process.env, MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: catalog, PWD: dir } };
}

async function cli(args: string[], env: NodeJS.ProcessEnv, stdin = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await run(args, env, { stdin, stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}

describe("morndo-keys commands", () => {
  it("adds, lists, acknowledges, changes, rotates and revokes without printing the key", async () => {
    const { env, dir } = home();
    const added = await cli(["add", "credit", "--vendor", "anthropic", "--runtime", "claude", "--billing", "prepaid", "--budget", "10", "--expires", "1893456000000"], env, KEY);
    expect(added.code).toBe(0);
    expect(added.stdout).not.toContain(KEY);
    const listed = await cli(["list"], env);
    expect(listed.stdout).toContain("credit");
    expect(listed.stdout).not.toContain(KEY);
    const file = join(dir, "incoming");
    writeFileSync(file, OTHER);
    const imported = await cli(["import", "other", "--vendor", "anthropic", "--runtime", "claude", "--billing", "metered", "--budget", "4", "--from-file", file], env);
    expect(imported.code, imported.stderr).toBe(0);
    const prints = JSON.parse(imported.stdout) as { old: string; new: string };
    expect(prints.old).toBe(prints.new);
    expect(imported.stdout).not.toContain(KEY);
    expect(imported.stdout).not.toContain(OTHER);
    expect(await cli(["ack", "credit", "--by", "owner"], env)).toMatchObject({ code: 0 });
    expect((await cli(["check", "credit"], env)).code).toBe(0);
    expect((await cli(["check", "other"], env)).code).toBe(75);
    expect((await cli(["budget", "credit", "20"], env)).code).toBe(0);
    expect((await cli(["expiry", "other", "1993456000000"], env)).code).toBe(0);
    expect((await cli(["expiry", "other", "none"], env)).code).toBe(0);
    expect((await cli(["isolation", "credit", "os"], env)).code).toBe(0);
    expect((await cli(["off", "credit"], env)).code).toBe(0);
    expect((await cli(["on", "credit"], env)).code).toBe(0);
    const rotated = await cli(["rotate", "credit"], env, "sk-ant-synthetic-test-key-0003");
    expect(rotated.code, rotated.stderr).toBe(0);
    expect(rotated.stdout).not.toContain("sk-ant-synthetic-test-key-0003");
    const logged = await cli(["log", "credit"], env);
    expect(logged.stdout).toContain("ConnectionRotated");
    expect(logged.stdout).not.toContain(KEY);
    expect((await cli(["spend", "credit"], env)).stdout).toContain("\"spent\":0");
    expect((await cli(["revoke", "credit"], env)).code).toBe(0);
    expect((await cli(["list"], env)).stdout).toContain("revoked");
  });

  it("a refused add or import leaves the existing key in place", async () => {
    const { env, dir } = home();
    const add = ["add", "foo", "--vendor", "anthropic", "--runtime", "claude", "--billing", "metered", "--budget", "10"];
    expect((await cli(add, env, KEY)).code).toBe(0);
    const again = await cli(add, env, OTHER);
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain("taken");
    const file = join(dir, "incoming");
    writeFileSync(file, OTHER);
    const imported = await cli(["import", "foo", "--vendor", "anthropic", "--runtime", "claude", "--billing", "metered", "--budget", "4", "--from-file", file], env);
    expect(imported.code).not.toBe(0);
    const bodies = readdirSync(join(dir, "vault")).map(name => readFileSync(join(dir, "vault", name), "utf8"));
    expect(bodies).toContain(KEY);
    expect(bodies).not.toContain(OTHER);
  });

  it("a missing amount never removes a cap", async () => {
    const { env, dir } = home();
    const added = await cli(["add", "key-a", "--vendor", "openai", "--runtime", "codex", "--billing", "metered", "--budget", "10"], env, KEY);
    expect(added.code, added.stderr).toBe(0);
    const bare = await cli(["budget", "key-a"], env);
    expect(bare.code).not.toBe(0);
    expect(bare.stderr).toContain("budget: give an amount or unlimited");
    const stated = await cli(["budget", "key-a", "unlimited"], env);
    expect(stated.code, stated.stderr).toBe(0);
    const file = join(dir, "incoming");
    writeFileSync(file, OTHER);
    const imported = await cli(["import", "other", "--vendor", "openai", "--runtime", "codex", "--billing", "metered", "--from-file", file], env);
    expect(imported.code).not.toBe(0);
    expect(imported.stderr).toContain("budget");
    const omitted = await cli(["add", "bare", "--vendor", "openai", "--runtime", "codex", "--billing", "metered"], env, KEY);
    expect(omitted.code).not.toBe(0);
    expect(omitted.stderr).toContain("budget");
    const listed = await cli(["list"], env);
    expect(listed.stdout).toContain("key-a");
    expect(listed.stdout).not.toContain("other");
    expect(listed.stdout).not.toContain("bare");
  });
});
