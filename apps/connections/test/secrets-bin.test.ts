// The morndo-secrets bin itself, as another process starts it (review round 1 of PR #40, points 7 and 11). It runs the .ts
// entry with node, as the package's bin does. Values and References are synthetic.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SecretEvent } from "@morndo/domain";
import { SqliteSecrets } from "../src/adapters/secrets-sqlite.ts";
import { runSecrets } from "../src/secrets-cli.ts";

const BIN = join(import.meta.dirname, "../src/secrets-main.ts");
const REF = "secret://example-app/payments-test";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function home() {
  const root = mkdtempSync(join(tmpdir(), "morndo-secrets-bin-"));
  dirs.push(root);
  const dir = join(root, "connections");
  const env: NodeJS.ProcessEnv = { ...process.env, MORNDO_CONNECTIONS_HOME: dir };
  delete env.MORNDO_VAULT;
  return { dir, env };
}

// Starts the bin; resolves with its exit and output, or with `timedOut` when it hasn't exited within `ms`.
function start(env: NodeJS.ProcessEnv, args: string[], opts: { closeStdin: boolean; readAfterMs: number; ms: number }) {
  const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  if (opts.closeStdin) child.stdin.end();
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.pause();
  setTimeout(() => { child.stdout.on("data", (c: Buffer) => out.push(c)); child.stdout.resume(); }, opts.readAfterMs);
  child.stderr.on("data", (c: Buffer) => err.push(c));
  return new Promise<{ code: number | null; timedOut: boolean; stdout: string; stderr: string }>(resolve => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: null, timedOut: true, stdout: "", stderr: "" }); }, opts.ms);
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, timedOut: false, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

describe("review point 7: only put reads stdin, so no other command waits on an open pipe", () => {
  it("list, log and disable exit with stdin a pipe that never closes", async () => {
    const h = home();
    for (const args of [["list"], ["log"], ["disable", REF]]) {
      const r = await start(h.env, args, { closeStdin: false, readAfterMs: 0, ms: 8_000 });
      expect(r.timedOut, args.join(" ")).toBe(false);
    }
  }, 60_000);
});

describe("review point 11: the bin's output reaches a slow reader whole", () => {
  it("log of many events, read only after a pause, holds every line", async () => {
    const h = home();
    const put = await runSecrets(["put", REF], h.env, { stdout: () => {}, stderr: () => {}, stdin: new TextEncoder().encode("synthetic-value-one\n"), confirm: async () => REF });
    expect(put).toBe(0);
    const secrets = new SqliteSecrets(join(h.dir, "connections.db"));
    const extra: SecretEvent[] = Array.from({ length: 20_000 }, (_, i) => ({ type: "SecretDisabled", reference: REF, at: 1_700_000_000_000 + i }));
    secrets.write(state => ({ next: { ...state, directory: { ...state.directory, events: [...state.directory.events, ...extra] } }, result: null }));
    secrets.close();
    const r = await start(h.env, ["log"], { closeStdin: true, readAfterMs: 1_500, ms: 60_000 });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    const lines = r.stdout.split("\n").filter(l => l !== "");
    expect(lines).toHaveLength(20_001);
    expect(() => JSON.parse(lines.at(-1) ?? "")).not.toThrow();
  }, 90_000);
});
