import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";

const KEY = "sk-ant-synthetic-test-key-0001";
// The real CLI is optional (CI has no checkout). ENGINES_BIN names it; otherwise the stand-in covers the same argv.
const REAL = process.env.ENGINES_BIN && existsSync(process.env.ENGINES_BIN) ? process.env.ENGINES_BIN : "";
const STAND_IN = join(import.meta.dirname, "fixtures/engines-cli.mjs");
const BIN = REAL || STAND_IN;
if (!REAL) console.log(`engines CLI: stand-in (${STAND_IN}); the real one isn't at ${process.env.ENGINES_BIN ?? "ENGINES_BIN"}`);
const catalog = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function home(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "morndo-engines-"));
  dirs.push(dir);
  const state = join(dir, "state");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(dir, "models"), { recursive: true });
  writeFileSync(join(dir, "models", "anthropic.json"), JSON.stringify({ ids: ["sonnet-5.5"] }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MORNDO_CONNECTIONS_HOME: dir,
    MORNDO_VAULT: "file",
    MORNDO_CATALOG: catalog,
    MORNDO_ENGINES_BIN: BIN,
    ENGINES_CONFIG: join(dir, "layer.json"),
    ENGINES_STATE: state,
    ENGINES_SESSIONS: join(dir, "sessions"),
    ENGINES_TRANSCRIPTS: join(dir, "transcripts"),
    PWD: dir,
  };
  return { dir, env };
}

async function cli(args: string[], env: NodeJS.ProcessEnv, stdin = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await run(args, env, { stdin, stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}

function enginesGet(env: NodeJS.ProcessEnv, role: string): { chain: string[]; risk_chain?: string[] } {
  const out = execFileSync(BIN, ["get", role, "--json"], { env, encoding: "utf8" });
  return JSON.parse(out)[role] as { chain: string[]; risk_chain?: string[] };
}

async function projected(env: NodeJS.ProcessEnv): Promise<void> {
  const added = await cli(["add", "credit", "--vendor", "anthropic", "--runtime", "claude", "--billing", "prepaid", "--budget", "10", "--expires", "1893456000000"], env, KEY);
  expect(added.code, added.stderr).toBe(0);
  expect((await cli(["ack", "credit", "--by", "owner"], env)).code).toBe(0);
  expect((await cli(["picks", "review", "add", "credit:sonnet-5.5@high"], env)).code).toBe(0);
  const riskPick = await cli(["picks", "review", "--risk", "add", "credit:sonnet-5.5@high"], env);
  expect(riskPick.code, riskPick.stderr).toBe(0);
  const followed = await cli(["role", "--all", "follow"], env);
  expect(followed.code, followed.stderr).toBe(0);
  const priority = await cli(["priority", "set", "keys-only"], env);
  expect(priority.code, priority.stderr).toBe(0);
}

describe("projection through the engines CLI", () => {
  it("writes the derived chain and the risk chain where engines get reads them", async () => {
    const { env } = home();
    await projected(env);
    const review = enginesGet(env, "review");
    expect(review.chain).toEqual(["credit:sonnet-5.5@high"]);
    expect(review.risk_chain).toEqual(["credit:sonnet-5.5@high"]);
    expect(enginesGet(env, "implement-backend").chain[0]).toBe("cursor:claude-sonnet-5.5@high");
  });

  it("leaves a chain a terminal set changed, and a hand role is not drift", async () => {
    const { env, dir } = home();
    await projected(env);
    execFileSync(BIN, ["set", "review", "claude:opus-5.5@high"], { env, stdio: ["ignore", "pipe", "pipe"] });
    const again = await cli(["priority", "set", "keys-only"], env);
    expect(again.code, again.stderr).toBe(0);
    expect(enginesGet(env, "review").chain).toEqual(["claude:opus-5.5@high"]);
    const drifted = await cli(["drift"], env);
    expect(drifted.code, drifted.stderr).toBe(0);
    expect(drifted.stdout).toContain("review");
    expect(readFileSync(join(dir, "alerts.log"), "utf8")).toContain('"kind":"drift"');
    expect((await cli(["role", "review", "hand"], env)).code).toBe(0);
    execFileSync(BIN, ["set", "review", "codex:gpt-6-astra@high"], { env, stdio: ["ignore", "pipe", "pipe"] });
    const hand = await cli(["drift"], env);
    expect(hand.code, hand.stderr).toBe(0);
    expect(hand.stdout).not.toContain("review");
    expect(enginesGet(env, "review").chain).toEqual(["codex:gpt-6-astra@high"]);
  });

  it("keeps the last chain and raises an alert when the only key is revoked", async () => {
    const { env, dir } = home();
    await projected(env);
    const revoked = await cli(["revoke", "credit"], env);
    expect(revoked.code, revoked.stderr).toBe(0);
    expect(enginesGet(env, "review").chain).toEqual(["credit:sonnet-5.5@high"]);
    expect(enginesGet(env, "review").risk_chain).toEqual(["credit:sonnet-5.5@high"]);
    expect(readFileSync(join(dir, "alerts.log"), "utf8")).toContain('"kind":"kept"');
  });

  it("engines resolve skips an exhausted key and names the reason", async () => {
    const { env } = home();
    await projected(env);
    execFileSync(BIN, ["provider", "set", "credit", "--json", JSON.stringify({
      kind: "cli", adapter: "claude", family: "anthropic", login: "ok", bin: "/bin/true",
      models: ["sonnet-5.5"], efforts: ["high"], enabled: true,
    })], { env, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync(BIN, ["mark", "credit", "exhausted", "--until", "4102444800"], { env, stdio: ["ignore", "pipe", "pipe"] });
    const resolved = spawnSync(BIN, ["resolve", "review"], { env, encoding: "utf8" });
    expect(resolved.status).toBe(3);
    expect(resolved.stdout).toContain("skip  credit:sonnet-5.5@high");
    expect(resolved.stdout).toContain("exhausted");
  });

  it("runs the probe argv that publish registered", async () => {
    const { env, dir } = home();
    await projected(env);
    const layer = JSON.parse(readFileSync(env.ENGINES_CONFIG ?? "", "utf8")) as {
      providers: Record<string, { probe?: string[] }>;
    };
    const probe = layer.providers.credit?.probe;
    expect(probe).toEqual(["morndo-keys", "check", "--connection", "credit"]);
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const entry = join(import.meta.dirname, "../src/main.ts");
    writeFileSync(join(bin, "morndo-keys"), `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`, { mode: 0o755 });
    const ran = spawnSync(probe?.[0] ?? "", probe?.slice(1), {
      env: { ...env, PATH: `${bin}:${env.PATH ?? ""}` }, encoding: "utf8",
    });
    expect(ran.status, String(ran.stderr)).toBe(0);
  });

  it("turning a Morndo connection off makes resolve skip it, and on brings it back", async () => {
    const { env, dir } = home();
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "morndo-keys"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    env.PATH = `${bin}:${env.PATH ?? ""}`;
    await projected(env);
    const off = await cli(["off", "credit"], env);
    expect(off.code, off.stderr).toBe(0);
    const skipped = spawnSync(BIN, ["resolve", "review"], { env, encoding: "utf8" });
    expect(skipped.status).toBe(3);
    expect(skipped.stdout).toContain("skip  credit:sonnet-5.5@high");
    expect(skipped.stdout).toContain("disabled in the settings");
    const on = await cli(["on", "credit"], env);
    expect(on.code, on.stderr).toBe(0);
    const restored = spawnSync(BIN, ["resolve", "review"], { env, encoding: "utf8" });
    expect(restored.status, restored.stdout).toBe(0);
    expect(restored.stdout).toContain("use   credit:sonnet-5.5@high");
  });

  it("an engines failure after off, on or revoke is reported and the next save repairs the layer", async () => {
    const { env } = home();
    env.MORNDO_ENGINES_BIN = STAND_IN;
    await projected(env);
    const layer = () => JSON.parse(readFileSync(env.ENGINES_CONFIG ?? "", "utf8")).providers.credit as { enabled: boolean };
    const status = async () => {
      const listed = await cli(["list"], env);
      return listed.stdout.split("\n").map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line) as { name: string; status: string }).find(row => row.name === "credit")?.status;
    };
    env.ENGINES_FAIL_ENABLE = "1";
    const off = await cli(["off", "credit"], env);
    expect(off.code).toBe(1);
    expect(off.stderr).toContain("saved, engine layer not updated (retry: off credit)");
    expect(await status()).toBe("off");
    expect(layer().enabled).toBe(true);
    delete env.ENGINES_FAIL_ENABLE;
    const repaired = await cli(["priority", "set", "keys-only"], env);
    expect(repaired.code, repaired.stderr).toBe(0);
    expect(layer().enabled).toBe(false);
    env.ENGINES_FAIL_ENABLE = "1";
    const on = await cli(["on", "credit"], env);
    expect(on.code).toBe(1);
    expect(on.stderr).toContain("saved, engine layer not updated (retry: on credit)");
    expect(await status()).toBe("on");
    expect(layer().enabled).toBe(false);
    delete env.ENGINES_FAIL_ENABLE;
    expect((await cli(["priority", "set", "keys-only"], env)).code).toBe(0);
    expect(layer().enabled).toBe(true);
    env.ENGINES_FAIL_ENABLE = "1";
    const revoked = await cli(["revoke", "credit"], env);
    expect(revoked.code).toBe(1);
    expect(revoked.stderr).toContain("saved, engine layer not updated (retry: revoke credit)");
    expect(await status()).toBe("revoked");
    expect(layer().enabled).toBe(true);
    delete env.ENGINES_FAIL_ENABLE;
    const repairedRevoke = await cli(["revoke", "credit"], env);
    expect(repairedRevoke.code, repairedRevoke.stderr).toBe(0);
    expect(layer().enabled).toBe(false);
  });

  it("revoking a Morndo connection makes resolve skip it at once", async () => {
    const { env, dir } = home();
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "morndo-keys"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    env.PATH = `${bin}:${env.PATH ?? ""}`;
    await projected(env);
    const revoked = await cli(["revoke", "credit"], env);
    expect(revoked.code, revoked.stderr).toBe(0);
    const skipped = spawnSync(BIN, ["resolve", "review"], { env, encoding: "utf8" });
    expect(skipped.status).toBe(3);
    expect(skipped.stdout).toContain("skip  credit:sonnet-5.5@high");
    expect(skipped.stdout).toContain("disabled in the settings");
  });

  it("reads the chains once and registers every provider in one call", async () => {
    const { env, dir } = home();
    env.MORNDO_ENGINES_BIN = STAND_IN;
    const log = join(dir, "engines.log");
    env.FAKE_ENGINES_LOG = log;
    await projected(env);
    const layer = JSON.parse(readFileSync(env.ENGINES_CONFIG ?? "", "utf8")) as { roles: Record<string, unknown> };
    delete layer.roles.review;
    writeFileSync(env.ENGINES_CONFIG ?? "", JSON.stringify(layer));
    writeFileSync(log, "");
    const again = await cli(["priority", "set", "keys-only"], env);
    expect(again.code, again.stderr).toBe(0);
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
    expect(calls.filter(argv => argv[0] === "get")).toHaveLength(1);
    expect(calls.filter(argv => argv[0] === "provider" && argv[1] === "set" && argv[2] === "--batch")).toHaveLength(1);
    expect(calls.filter(argv => argv[0] === "provider" && argv[1] === "set" && argv[2] !== "--batch")).toHaveLength(0);
    expect((await cli(["picks", "implement-backend", "add", "credit:sonnet-5.5@high"], env)).code).toBe(0);
    writeFileSync(log, "");
    execFileSync(STAND_IN, ["set", "review", "codex:gpt-6-astra@high", "--force"], { env, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync(STAND_IN, ["set", "implement-backend", "codex:gpt-6-astra@high", "--force"], { env, stdio: ["ignore", "pipe", "pipe"] });
    writeFileSync(log, "");
    const drifted = await cli(["drift"], env);
    expect(drifted.code, drifted.stderr).toBe(0);
    const driftCalls = readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
    expect(driftCalls.filter(argv => argv[0] === "get")).toHaveLength(1);
  });

  it("registers one provider at a time when batch is refused as engines: usage:", async () => {
    const { env, dir } = home();
    env.MORNDO_ENGINES_BIN = STAND_IN;
    env.ENGINES_NO_BATCH = "1";
    const log = join(dir, "engines.log");
    env.FAKE_ENGINES_LOG = log;
    await projected(env);
    const layer = JSON.parse(readFileSync(env.ENGINES_CONFIG ?? "", "utf8")) as { providers: Record<string, { bin?: string[] }> };
    expect(layer.providers.credit?.bin).toEqual(["morndo-keys", "run", "--connection", "credit", "--"]);
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
    expect(calls.some(argv => argv[0] === "provider" && argv[1] === "set" && argv[2] === "--batch")).toBe(true);
    expect(calls.some(argv => argv[0] === "provider" && argv[1] === "set" && argv[2] !== "--batch")).toBe(true);
  });

  it("registers a new provider before a chain names it", async () => {
    const { env, dir } = home();
    env.MORNDO_ENGINES_BIN = STAND_IN;
    const log = join(dir, "engines.log");
    env.FAKE_ENGINES_LOG = log;
    await projected(env);
    const added = await cli(["add", "debit", "--vendor", "anthropic", "--runtime", "claude", "--billing", "prepaid", "--budget", "10", "--expires", "1893456000000"], env, "sk-ant-synthetic-test-key-0002");
    expect(added.code, added.stderr).toBe(0);
    expect((await cli(["ack", "debit", "--by", "owner"], env)).code).toBe(0);
    expect((await cli(["priority", "set", "keys-only", "credit", "debit"], env)).code).toBe(0);
    const layer = JSON.parse(readFileSync(env.ENGINES_CONFIG ?? "", "utf8")) as { providers: Record<string, unknown> };
    delete layer.providers.debit;
    writeFileSync(env.ENGINES_CONFIG ?? "", JSON.stringify(layer));
    writeFileSync(log, "");
    const picked = await cli(["picks", "review", "add", "debit:sonnet-5.5@high"], env);
    expect(picked.code, picked.stderr).toBe(0);
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
    const chain = calls.findIndex(argv => argv[0] === "set" && argv.some(arg => arg.includes("debit:")));
    const registered = calls.findIndex(argv => argv[0] === "provider" && argv[1] === "set" && argv.some(arg => arg.includes("debit")));
    expect(registered).toBeGreaterThanOrEqual(0);
    expect(chain).toBeGreaterThanOrEqual(0);
    expect(registered).toBeLessThan(chain);
  });

  it("publishes a key that is on and acknowledged as signed in", async () => {
    const { env } = home();
    env.MORNDO_ENGINES_BIN = STAND_IN;
    await projected(env);
    const credit = JSON.parse(readFileSync(env.ENGINES_CONFIG ?? "", "utf8")).providers.credit as { login?: string };
    expect(credit.login).toBe("ok");
  });

  it("publishes only after a save is accepted, and leaves login, efforts and marks alone", async () => {
    const { env } = home();
    env.MORNDO_ENGINES_BIN = STAND_IN;
    await projected(env);
    const read = () => JSON.parse(readFileSync(env.ENGINES_CONFIG ?? "", "utf8")).providers.credit as {
      bin: unknown; login: string; efforts: string[]; label: string; enabled: boolean; adapter: string; family: string;
    };
    execFileSync(STAND_IN, ["provider", "set", "credit", "--json", JSON.stringify({
      ...read(), login: "missing", efforts: ["low"], label: "kept", bin: "/bin/false", enabled: false,
    })], { env, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync(STAND_IN, ["mark", "credit", "exhausted", "--until", "4102444800"], { env, stdio: ["ignore", "pipe", "pipe"] });
    const layer = JSON.parse(readFileSync(env.ENGINES_CONFIG ?? "", "utf8")) as { roles: Record<string, unknown> };
    delete layer.roles.review;
    writeFileSync(env.ENGINES_CONFIG ?? "", JSON.stringify(layer));
    env.ENGINES_FAIL_SET = "1";
    const refused = await cli(["priority", "set", "keys-only"], env);
    expect(refused.code, refused.stderr).not.toBe(0);
    expect(read().bin).toBe("/bin/false");
    expect(read().login).toBe("missing");
    expect(read().enabled).toBe(false);
    delete env.ENGINES_FAIL_SET;
    const accepted = await cli(["priority", "set", "keys-only"], env);
    expect(accepted.code, accepted.stderr).toBe(0);
    expect(read().bin).toEqual(["morndo-keys", "run", "--connection", "credit", "--"]);
    expect(read().adapter).toBe("claude");
    expect(read().family).toBe("anthropic");
    expect(read().enabled).toBe(true);
    expect(read().login).toBe("ok");
    expect(read().efforts).toEqual(["low"]);
    expect(read().label).toBe("kept");
    const rows = JSON.parse(execFileSync(STAND_IN, ["providers", "--json"], { env, encoding: "utf8" })) as { provider: string; held: { reason: string }[] }[];
    expect(rows.find(row => row.provider === "credit")?.held.some(mark => mark.reason === "exhausted")).toBe(true);
  });

  it("refuses a revoke while a chain still names the provider, and saves nothing", async () => {
    const { env } = home();
    expect((await cli(["adopt"], env)).code).toBe(0);
    execFileSync(BIN, ["set", "research", "agy:gemini-2.5", "--force"], { env, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync(BIN, ["set", "review", "agy:gemini-2.5", "--risk", "--force"], { env, stdio: ["ignore", "pipe", "pipe"] });
    const revoked = await cli(["revoke", "agy"], env);
    expect(revoked.code).not.toBe(0);
    expect(revoked.stderr).toContain("research");
    expect(revoked.stderr).toContain("review");
    const listed = (await cli(["list"], env)).stdout;
    const agy = listed.split("\n").map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line) as { name: string; status: string }).find(row => row.name === "agy");
    expect(agy?.status).not.toBe("revoked");
  });

  it("adopts the engine layer's other providers as connections in its custody", async () => {
    const { env } = home();
    const adopted = await cli(["adopt"], env);
    expect(adopted.code, adopted.stderr).toBe(0);
    const listed = await cli(["list"], env);
    for (const name of ["studio", "cursor-cloud", "agy"]) expect(listed.stdout).toContain(`"name":"${name}"`);
    expect(listed.stdout).not.toContain('"name":"claude"');
    expect(listed.stdout).not.toContain("gemini");
    const providers = JSON.parse(execFileSync(BIN, ["providers", "--json"], { env, encoding: "utf8" })) as { provider: string; enabled: boolean }[];
    expect(providers.find(row => row.provider === "studio")?.enabled).toBe(false);
    expect(providers.find(row => row.provider === "claude")?.enabled).toBe(true);
    const again = await cli(["adopt"], env);
    expect(again.code, again.stderr).toBe(0);
    expect((await cli(["list"], env)).stdout.match(/"name":"studio"/g)).toHaveLength(1);
  });
});
