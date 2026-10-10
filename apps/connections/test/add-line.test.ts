// The add line shown on the page is a command the machine can run. The key is a file the user names.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keyAddLine } from "../../web/src/lib/connections/line.ts";
import { run } from "../src/cli.ts";

const KEY = "sk-ant-synthetic-test-key-0001";
const catalog = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function cli(args: string[], env: NodeJS.ProcessEnv, stdin = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await run(args, env, { stdin, stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}

describe("the page add line", () => {
  it("reads the key from the file the line names", async () => {
    expect(keyAddLine({ name: "key-a", vendor: "openai", runtime: "codex", budget: "", expires: "" })).toBe("");
    const line = keyAddLine({ name: "key-a", vendor: "openai", runtime: "codex", budget: "20", expires: "" });
    expect(line).toContain("--budget");
    expect(line).not.toContain("pbpaste");
    expect(line.endsWith(" < keyfile")).toBe(true);
    expect(line).toContain("--budget 20");
    const dir = mkdtempSync(join(tmpdir(), "morndo-add-line-"));
    dirs.push(dir);
    writeFileSync(join(dir, "keyfile"), KEY);
    const command = line.slice(0, line.length - " < keyfile".length);
    const args = command.slice("morndo-keys ".length).split(" ");
    const env: NodeJS.ProcessEnv = { ...process.env, MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: catalog, PWD: dir };
    delete env.MORNDO_ENGINES_BIN;
    const added = await cli(args, env, readFileSync(join(dir, "keyfile"), "utf8"));
    expect(added.code, added.stderr).toBe(0);
    expect(added.stdout).not.toContain(KEY);
    const listed = await cli(["list"], env);
    expect(listed.stdout).toContain("key-a");
    expect(listed.stdout).not.toContain(KEY);
  });
});
