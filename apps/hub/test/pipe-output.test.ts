// The `morndo` bin with its output on a pipe (T-273): a long console answer arrives whole through a slow reader, a reader
// that closes the pipe early ends it quietly with its own code (not an EPIPE stack and exit 1), and a usage error still
// says what is wrong. The real bin as a child with a temporary home; never the owner's hub, data or ports.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runIntoHead, runOnPipe } from "../../../test/pipe-child.ts";
import { Store } from "../src/adapters/store.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");
let home: string;
let env: NodeJS.ProcessEnv;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "morndo-hub-pipe-"));
  const store = new Store(home);
  const now = Date.now();
  store.record(Array.from({ length: 4000 }, (_, i) => ({ type: "device.paired", at: now + i, deviceId: `d-${i}`, name: `Phone ${i} ${"x".repeat(200)}` }) as never));
  store.close();
  env = { ...process.env, MORNDO_HOME: home, MORNDO_PORT: "0" };
  for (const name of ["MORNDO_FLEET_SOCKET", "TMUX"]) delete env[name];
});
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

describe("morndo on a pipe", () => {
  it("audit: a long answer arrives whole", async () => {
    const r = await runOnPipe([MAIN, "audit", "5000"], env);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(1024 * 1024);
    expect(r.stdout.trimEnd().split("\n")).toHaveLength(4000);
  });
  it("audit: ends quietly with its own code when the reader closes the pipe early", async () => {
    const r = await runIntoHead([MAIN, "audit", "5000"], env);
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });
  });
  it("a usage error says what is wrong and exits 2", async () => {
    const r = await runOnPipe([MAIN, "revoke"], env);
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 2, stderr: "usage: morndo revoke <device id>\n" });
  });
});
