// reaper(): SIGTERM now, SIGKILL after the grace, to the processes named, and only to the very processes named. A pid the system
// has handed to a different process since is left alone: the identity is the process's start time, read when it was named and
// again before the kill (T-274). The identity is injectable, so a reused pid can be shown without waiting for the system to reuse one.
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { reaper } from "../src/reader-gone.ts";

const kids: ChildProcess[] = [];
afterEach(() => { for (const kid of kids.splice(0)) kid.kill("SIGKILL"); });

const stubborn = async (): Promise<number> => {
  const kid = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('up');setTimeout(()=>{},30000)"], { stdio: ["ignore", "pipe", "ignore"] });
  kids.push(kid);
  await new Promise<void>(resolve => kid.stdout?.once("data", () => resolve()));
  return kid.pid ?? 0;
};
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("reaper", () => {
  it("kills what ignores SIGTERM once the grace has passed", async () => {
    const pid = await stubborn();
    const reap = reaper(200);
    reap.stop([pid]);
    await reap.settle();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(alive(pid)).toBe(false);
  });

  it("leaves alone a pid that is not the process it named (a reused pid)", async () => {
    const pid = await stubborn();
    let reads = 0;
    const identify = (): string => (++reads === 1 ? "started-at-1" : "started-at-2");      // the pid, named once, is another process later
    const reap = reaper(200, identify);
    reap.stop([pid]);
    await reap.settle();
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(alive(pid)).toBe(true);                                                          // it was told SIGTERM, which it ignores; never SIGKILL
  });
});
