// Shared by the agent's tests: a temporary HOME, an isolated tmux server (`tmux -L test-<uuid>`, never the owner's; the
// helper node-ops' tests share), a logger that keeps its lines, and polling.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type Logger } from "../src/log.ts";

export { isolatedTmux, type TestTmux } from "../../../packages/node-ops/test/isolated-tmux.ts";

export function tempHome(prefix = "morndo-node-"): { home: string; cleanup: () => void } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)));    // realpath: macOS /var is a link to /private/var
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// The monotonic clock, as it was when this module loaded: the wall clock jumps when time sync steps it, and a test may
// stub performance.now (job-systemd.test.ts freezes it) while it waits here.
const monotonic = performance.now.bind(performance);

export async function until(f: () => boolean | Promise<boolean>, ms = 5000, step = 25): Promise<boolean> {
  const end = monotonic() + ms;
  while (monotonic() < end) { if (await f()) return true; await wait(step); }
  return f();
}

export function captureLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { log: createLogger({ level: "debug", sink: line => { lines.push(line); } }), lines };
}
