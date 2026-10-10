import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";

const KEY = "sk-ant-synthetic-test-key-0001";
const catalog = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function home(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "morndo-policy-"));
  dirs.push(dir);
  const env: NodeJS.ProcessEnv = { ...process.env, MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: catalog, PWD: dir };
  delete env.MORNDO_ENGINES_BIN;
  return { dir, env };
}

async function cli(args: string[], env: NodeJS.ProcessEnv, stdin = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await run(args, env, { stdin, stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}

describe("policy CLI", () => {
  it("follows every role and a keys-only priority projects the chain and the risk chain", async () => {
    const { env, dir } = home();
    mkdirSync(join(dir, "models"), { recursive: true });
    writeFileSync(join(dir, "models", "anthropic.json"), JSON.stringify({ ids: ["sonnet-5.5"] }));
    const added = await cli(["add", "credit", "--vendor", "anthropic", "--runtime", "claude", "--billing", "prepaid", "--budget", "10", "--expires", "1893456000000"], env, KEY);
    expect(added.code, added.stderr).toBe(0);
    expect((await cli(["ack", "credit", "--by", "owner"], env)).code).toBe(0);
    expect((await cli(["picks", "review", "add", "credit:sonnet-5.5@high"], env)).code).toBe(0);
    expect((await cli(["picks", "review", "--risk", "add", "credit:sonnet-5.5@high"], env)).code).toBe(0);
    const followed = await cli(["role", "--all", "follow"], env);
    expect(followed.code, followed.stderr).toBe(0);
    expect(followed.stdout).toContain("credit:sonnet-5.5@high");
    const priority = await cli(["priority", "set", "keys-only"], env);
    expect(priority.code, priority.stderr).toBe(0);
    expect((await cli(["priority", "show"], env)).stdout).toContain("keys-only credit");
    const saved = JSON.parse(readFileSync(join(dir, "engines.json"), "utf8")) as {
      chains: { role: string; chain: string[]; risk: string[] | null }[];
    };
    expect(saved.chains.find(row => row.role === "review")).toEqual({
      role: "review",
      chain: ["credit:sonnet-5.5@high"],
      risk: ["credit:sonnet-5.5@high"],
    });
  });

  it("follow prints the engine chain for a role it does not rewrite", async () => {
    const { env, dir } = home();
    mkdirSync(join(dir, "models"), { recursive: true });
    writeFileSync(join(dir, "models", "anthropic.json"), JSON.stringify({ ids: ["sonnet-5.5"] }));
    writeFileSync(join(dir, "engines.json"), JSON.stringify({
      providers: [], marks: [],
      chains: [{ role: "research", chain: ["seat:opus-5.5@high"], risk: null }],
    }));
    expect((await cli(["add", "credit", "--vendor", "anthropic", "--runtime", "claude", "--billing", "prepaid", "--budget", "10", "--expires", "1893456000000"], env, KEY)).code).toBe(0);
    expect((await cli(["ack", "credit", "--by", "owner"], env)).code).toBe(0);
    expect((await cli(["picks", "review", "add", "credit:sonnet-5.5@high"], env)).code).toBe(0);
    const followed = await cli(["role", "--all", "follow"], env);
    expect(followed.code, followed.stderr).toBe(0);
    expect(followed.stdout).toContain("research seat:opus-5.5@high -> seat:opus-5.5@high");
    expect((await cli(["role", "review", "hand"], env)).code).toBe(0);
    const saved = JSON.parse(readFileSync(join(dir, "engines.json"), "utf8")) as {
      chains: { role: string; chain: string[]; risk: string[] | null }[];
    };
    const review = saved.chains.find(row => row.role === "review");
    expect(review).toBeDefined();
    review!.chain = ["other:m@high"];
    writeFileSync(join(dir, "engines.json"), JSON.stringify(saved));
    const again = await cli(["role", "--all", "follow"], env);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain("review other:m@high -> other:m@high");
  });

  it("registers through the file adapter and keeps engine-side login", async () => {
    const { env, dir } = home();
    mkdirSync(join(dir, "models"), { recursive: true });
    writeFileSync(join(dir, "models", "anthropic.json"), JSON.stringify({ ids: ["sonnet-5.5"] }));
    writeFileSync(join(dir, "engines.json"), JSON.stringify({
      providers: [{ name: "credit", enabled: false, login: "missing", efforts: ["low"], label: "kept" }],
      marks: [], chains: [],
    }));
    expect((await cli(["add", "credit", "--vendor", "anthropic", "--runtime", "claude", "--billing", "prepaid", "--budget", "10", "--expires", "1893456000000"], env, KEY)).code).toBe(0);
    expect((await cli(["ack", "credit", "--by", "owner"], env)).code).toBe(0);
    expect((await cli(["picks", "review", "add", "credit:sonnet-5.5@high"], env)).code).toBe(0);
    expect((await cli(["role", "review", "follow"], env)).code).toBe(0);
    const saved = JSON.parse(readFileSync(join(dir, "engines.json"), "utf8")) as {
      providers: { name: string; bin: string[]; adapter: string; family: string; enabled: boolean; login: string; efforts: string[]; label: string }[];
    };
    const credit = saved.providers.find(row => row.name === "credit");
    expect(credit?.bin).toEqual(["morndo-keys", "run", "--connection", "credit", "--"]);
    expect(credit?.adapter).toBe("claude");
    expect(credit?.family).toBe("anthropic");
    expect(credit?.enabled).toBe(true);
    expect(credit?.login).toBe("ok");
    expect(credit?.efforts).toEqual(["low"]);
    expect(credit?.label).toBe("kept");
    const adopted = await cli(["adopt"], env);
    expect(adopted.code, adopted.stderr).toBe(0);
  });

  it("role --all follow leaves every role untouched when one of them does not fit", async () => {
    const { env, dir } = home();
    mkdirSync(join(dir, "models"), { recursive: true });
    writeFileSync(join(dir, "models", "anthropic.json"), JSON.stringify({ ids: ["sonnet-5.5"] }));
    writeFileSync(join(dir, "models", "claude.json"), JSON.stringify({ ids: ["opus-5.5"] }));
    expect((await cli(["add", "credit", "--vendor", "anthropic", "--runtime", "claude", "--billing", "prepaid", "--budget", "10", "--expires", "1893456000000"], env, KEY)).code).toBe(0);
    expect((await cli(["add", "seat", "--subscription", "--vendor", "claude", "--runtime", "claude"], env)).code).toBe(0);
    expect((await cli(["ack", "credit", "--by", "owner"], env)).code).toBe(0);
    expect((await cli(["ack", "seat", "--by", "owner"], env)).code).toBe(0);
    expect((await cli(["priority", "set", "keys-only"], env)).code).toBe(0);
    expect((await cli(["picks", "review", "add", "credit:sonnet-5.5@high"], env)).code).toBe(0);
    expect((await cli(["picks", "implement-backend", "add", "credit:sonnet-5.5@high"], env)).code).toBe(0);
    expect((await cli(["picks", "research", "add", "seat:opus-5.5@high"], env)).code).toBe(0);
    const followed = await cli(["role", "--all", "follow"], env);
    expect(followed.code, followed.stderr).not.toBe(0);
    expect(followed.stderr).toContain("research");
    const db = new Database(join(dir, "connections.db"), { readonly: true });
    const body = (db.prepare("SELECT body FROM policy WHERE id = 1").get() as { body: string }).body;
    db.close();
    const policy = JSON.parse(body) as { roles: { role: string; override: string }[] };
    for (const role of ["review", "implement-backend", "research"]) {
      expect(policy.roles.find(row => row.role === role)?.override).toBe("hand");
    }
    const saved = JSON.parse(readFileSync(join(dir, "engines.json"), "utf8")) as { chains: { role: string }[] };
    expect(saved.chains.find(row => row.role === "review")).toBeUndefined();
  });
});
