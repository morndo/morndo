// The `morndo-fleet` bin with its output on a pipe (T-273): a long console answer arrives whole through a slow reader, a
// reader that closes the pipe early ends it quietly with its own code (not an EPIPE stack and exit 1), and a refusal still
// says what is wrong. The real bin as a child, a temp HOME and config, no service.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runIntoHead, runOnPipe } from "../../../test/pipe-child.ts";
import { openFleetDb } from "../src/adapters/db.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");
const NODES = 20000;
// Not the suite's tempDir(): that one is removed after every test, and the database has to last for all three.
let home: string;
let env: NodeJS.ProcessEnv;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "mf-pipe-"));
  const config = join(home, "fleet.json");
  writeFileSync(config, JSON.stringify({ socketPath: join(home, "run", "f.sock") }));
  const db = openFleetDb(join(home, ".local/share/morndo-fleet/fleet.db"));
  const insert = db.prepare("INSERT INTO nodes (name, public_key, created_at, last_seen_at, last_source, agent_version) VALUES (?, ?, ?, ?, ?, ?)");
  db.transaction(() => { for (let i = 0; i < NODES; i++) insert.run(`node-${i}`, "made-up-key", 1_700_000_000_000 + i, 1_700_000_100_000 + i, "203.0.113.7", "0.0.0"); })();
  db.close();
  env = { ...process.env, HOME: home, MORNDO_FLEET_CONFIG: config };
}, 60_000);
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

describe("morndo-fleet on a pipe", () => {
  it("node list: a long answer arrives whole", async () => {
    const r = await runOnPipe([MAIN, "node", "list"], env);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(1024 * 1024);
    expect(r.stdout.trimEnd().split("\n")).toHaveLength(NODES);
  });
  it("node list: ends quietly with its own code when the reader closes the pipe early", async () => {
    const r = await runIntoHead([MAIN, "node", "list"], env);
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });
  });
  it("a refusal says what is wrong and exits with its code", async () => {
    const r = await runOnPipe([MAIN, "node", "add", "Bad_Name"], env);
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 2, stderr: 'a node name is 1 to 32 of a-z, 0-9 and "-": "Bad_Name"\n' });
  });
});
