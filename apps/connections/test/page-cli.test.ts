// The hub reaches RoutingService by calling this program (secret-store README §4: the hub calls the program, as it
// calls the engines CLI). `page` prints the view. `apply` is the page command, checked and saved inside this program.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";

const catalog = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function home(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "morndo-page-cli-"));
  dirs.push(dir);
  return { ...process.env, MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: catalog, PWD: dir };
}

async function cli(args: string[], env: NodeJS.ProcessEnv, stdin = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await run(args, env, { stdin, stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}

describe("the page's program", () => {
  it("prints the page and saves a role through the program, refusing a stale version and an extra field", async () => {
    const env = home();
    const shown = await cli(["page"], env);
    expect(shown.code).toBe(0);
    const view = JSON.parse(shown.stdout) as { version: number; mode: string; roles: { role: string; override: string }[] };
    expect(view.roles).toEqual([]);
    expect(shown.stdout).not.toMatch(/secret|apiKey/);

    const stale = await cli(["apply", "priority", "hub"], env, JSON.stringify({ version: view.version + 9, mode: "keys-only", order: [] }));
    expect(stale.code).not.toBe(0);
    expect(stale.stderr).toContain("conflict");

    const extra = await cli(["apply", "priority", "hub"], env, JSON.stringify({ version: view.version, mode: "keys-only", order: [], secret: "x" }));
    expect(extra.code).not.toBe(0);

    const saved = await cli(["apply", "role", "hub"], env, JSON.stringify({
      version: view.version, role: "implement", override: "hand", order: [], picks: [], action: "save",
    }));
    expect(saved.code, saved.stderr).toBe(0);
    const after = JSON.parse((await cli(["page"], env)).stdout) as { roles: { role: string; override: string }[] };
    expect(after.roles[0]).toMatchObject({ role: "implement", override: "hand" });
  });
});
