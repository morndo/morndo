// The hub calls the connections program with an argument list. It does not open that app in process
// (secret-store README §4, the same way it calls the engines CLI).
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectionsCli, connectionsEnv } from "../src/adapters/connections-cli.ts";

const page = { version: 1, connections: [], mode: "keys-only", order: [], roles: [], alerts: [], catalog: [] };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function program(): { bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "morndo-hub-conn-"));
  dirs.push(dir);
  const log = join(dir, "log");
  const bin = join(dir, "morndo-keys");
  writeFileSync(bin, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const stdin = readFileSync(0, "utf8");
writeFileSync(process.env.LOG, JSON.stringify({ argv: process.argv.slice(2), stdin, home: process.env.MORNDO_CONNECTIONS_HOME ?? null, engines: Object.hasOwn(process.env, "MORNDO_ENGINES_BIN") }));
if (process.argv[2] === "page") process.stdout.write(JSON.stringify(${JSON.stringify(page)}));
else if (stdin.includes("999")) { process.stderr.write("conflict\\n"); process.exit(1); }
`);
  chmodSync(bin, 0o755);
  return { bin, log };
}

describe("the hub's connections program", () => {
  it("reads the page and sends a role save as arguments, without the engines CLI", async () => {
    const { bin, log } = program();
    const home = "/tmp/connections-home";
    const env = connectionsEnv({ ...process.env, LOG: log, MORNDO_ENGINES_BIN: "/live/engines" }, home);
    const cli = connectionsCli(bin, env);
    const pending = cli.page();
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toEqual(page);
    const saw = JSON.parse(readFileSync(log, "utf8")) as { argv: string[]; stdin: string; home: string; engines: boolean };
    expect(saw.argv).toEqual(["page"]);
    expect(saw.home).toBe(home);
    expect(saw.engines).toBe(false);

    const body = { version: 1, role: "implement", override: "follow" as const, order: [], picks: [], action: "save" as const };
    expect(await cli.role(body, "hub")).toEqual({ ok: true });
    const sent = JSON.parse(readFileSync(log, "utf8")) as { argv: string[]; stdin: string };
    expect(sent.argv).toEqual(["apply", "role", "hub"]);
    expect(JSON.parse(sent.stdin)).toEqual(body);
    expect(await cli.priority({ version: 999, mode: "keys-only", order: [] }, "hub")).toEqual({ ok: false, problem: "conflict" });
  });

  it("a child that dies before reading stdin, and a missing program, do not crash the caller", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-hub-conn-"));
    dirs.push(dir);
    const bin = join(dir, "morndo-keys");
    writeFileSync(bin, "#!/usr/bin/env node\nprocess.kill(process.pid, 'SIGKILL');\n");
    chmodSync(bin, 0o755);
    const cli = connectionsCli(bin, connectionsEnv(process.env, dir));
    const body = { version: 1, role: "implement", override: "follow" as const, order: [], picks: ["x".repeat(1_000_000)], action: "save" as const };
    const errors: string[] = [];
    const onError = (error: Error & { code?: string }) => { errors.push(error.code ?? error.message); };
    process.on("uncaughtException", onError);
    try {
      await expect(cli.role(body, "hub")).rejects.toThrow();
      await expect(connectionsCli(join(dir, "missing"), connectionsEnv(process.env, dir)).page()).rejects.toThrow();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(errors).toEqual([]);
    } finally { process.off("uncaughtException", onError); }
  });
});
