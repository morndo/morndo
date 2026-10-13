// How a child's close is settled, in this process. A real stop signal cannot be used here: the plugin's
// own handler ends its process, which here would be the test runner's. The stop is recorded the way
// that handler records it (setStopSignal), and the child really dies, so runChild settles the close as
// in the binary: one loop turn after the close, against the recorded stop, never against how the child
// died. One test records behind the close dispatch itself (a listener after runChild's own, where the
// pending signal handler sits in production); the others record while the child still runs.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { children, runChild, setStopSignal, StoppedRun } from "../src/morndo-transcribe.mts";

const ROOT = mkdtempSync(join(tmpdir(), "morndo-stop-unit-"));

function childScript(body: string): string {
  const path = join(ROOT, `child-${Math.random().toString(36).slice(2)}`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

afterEach(() => { setStopSignal(null); });
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe("runChild settles a close against the recorded stop", () => {
  it("an engine child killed by a signal nobody sent is an engine death, not a stop", async () => {
    const child = runChild(childScript("kill -TERM $$"), [], ROOT);
    await expect(child).resolves.toEqual({ code: 1 });
  });

  it("a stop recorded behind the close of a signal-killed child still stops the run", async () => {
    const child = runChild(childScript("kill -TERM $$"), [], ROOT);
    // The recording sits behind runChild's own close handler, in the same dispatch: where this
    // process's pending signal handler sits in production when the kernel reaches the child first.
    const engine = [...children][0];
    if (engine === undefined) throw new Error("the child was not registered");
    engine.once("close", () => setStopSignal("SIGTERM"));
    const outcome = await child.then(() => null, (error: unknown) => error);
    expect(outcome).toBeInstanceOf(StoppedRun);
    expect((outcome as StoppedRun).signal).toBe("SIGTERM");
  });

  it("an ffmpeg-style exit 255 during a stop is a stop, not a converter failure", async () => {
    const child = runChild(childScript("exit 255"), [], ROOT);
    setImmediate(() => setStopSignal("SIGTERM"));
    const outcome = await child.then(() => null, (error: unknown) => error);
    expect(outcome).toBeInstanceOf(StoppedRun);
    expect((outcome as StoppedRun).signal).toBe("SIGTERM");
  });

  it("a clean child exit during a stop is still a stop: a cancelled run reports nothing", async () => {
    const child = runChild(childScript("exit 0"), [], ROOT);
    setImmediate(() => setStopSignal("SIGINT"));
    const outcome = await child.then(() => null, (error: unknown) => error);
    expect(outcome).toBeInstanceOf(StoppedRun);
    expect((outcome as StoppedRun).signal).toBe("SIGINT");
  });
});
