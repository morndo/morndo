// The shared pane lock against a real flock(1) holder, the way kira and lane-events-push hold it.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { paneLock } from "../src/pane-lock.ts";

const dir = mkdtempSync(join(tmpdir(), "morndo-lock-"));
const path = join(dir, "pane.lock");
writeFileSync(path, "");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("pane lock", () => {
  it("runs the typing while it holds the lock, and lets go afterwards", async () => {
    const lock = paneLock(path, 2);
    expect(await lock(async () => "typed")).toBe("typed");
    expect(await lock(async () => "again")).toBe("again");          // released: a second turn gets it at once
  });
  it("is busy while another typist holds it (negative control: free again after)", async () => {
    const other = spawn("flock", ["-x", path, "-c", "echo held; sleep 3"], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise(r => other.stdout.once("data", r));
    let ran = false;
    const t = Date.now();
    expect(await paneLock(path, 1)(async () => { ran = true; })).toBe("busy");
    expect(ran).toBe(false);
    expect(Date.now() - t).toBeGreaterThanOrEqual(900);
    await new Promise(r => other.once("exit", r));
    expect(await paneLock(path, 1)(async () => "free")).toBe("free");
  }, 10_000);
});
