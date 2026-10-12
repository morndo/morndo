import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, readdirSync, statfsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { defineConfig } from "vitest/config";

// The web tests that drive headless Chromium each start a Vite server and compile the app cold. All of them at once
// saturate the box and their first page load times out, so at most 4 of those files run at a time, after every other
// test file has run as before (Vitest runs projects with different worker limits as groups, one after the other). Each
// needs about two CPUs (its Vite server and its browser), so a smaller machine runs fewer at once: 4 on this 16-CPU box,
// 1 on GitHub's 2-CPU runner for private repositories (docs.github.com, "GitHub-hosted runners", read 2026-10-02). Even
// here, 4 at once under a load average of 20 once pushed a first test from 2 s to over 30 s.
const WEB_TESTS = resolve("apps/web/test");
const browserWorkers = Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)));
// The fleet's cross-app drills (test/fleet, spec §9): real fleet, agent and hub processes on isolated tmux servers. Most of
// their time is waiting (reconnects, health every 30 s, a 75 s flapping window), not CPU, so they run after everything
// else, in a group of their own, a few files at a time. CI runs them in a job of their own (.github/workflows/ci.yml).
// Projects in a later groupOrder run after the earlier groups (https://vitest.dev/config/sequence.html, v5.0.3, read
// 2026-10-06).
const fleetWorkers = Math.min(4, Math.max(2, Math.floor(availableParallelism() / 2)));
// Test scratch on RAM. Most tests keep their SQLite databases (WAL, synchronous=FULL: one fsync per commit), sockets and
// logs under os.tmpdir(). On a disk that other work keeps busy every fsync waits behind that work. The fleet's audit
// test (2,300 single-row commits, two tests) took 71 s and 219 s on this box's /tmp at idle IO priority (ionice -c3, as
// scripts/flake-loop.sh runs) and 402 s and 292 s at the normal priority npm test has (IO pressure 72 %), all past its
// 20 s window; on a tmpfs, 0.9 s for the whole file (2026-10-12).
// Those tests check the code, not the disk, so on Linux each run's TMPDIR is a directory of its own,
// morndo-test-<pid>-<random>, in the user's runtime directory ($XDG_RUNTIME_DIR, /run/user/<uid>) when that is a tmpfs
// (TMPFS_MAGIC 0x01021994, statfs(2)) we can write with 1 GiB free: the same files and the same fsync calls, which
// return at once there. test/run-scratch.ts makes it before the first test and removes it, with whatever the tests left
// in it, after the last, passed or not. Not /dev/shm: the agent refuses a job, lane or file under /dev (denyRoots), as
// it should. With less room, a TMPDIR the caller set, or elsewhere, tmpdir() is as before. `env` reaches each test
// file's process.env before it is imported, and the processes it starts (https://vitest.dev/config/env.html, v5.0.3,
// read 2026-10-12).
function ramScratch(): Record<string, string> {
  const run = process.env.XDG_RUNTIME_DIR;
  if (process.env.TMPDIR || process.platform !== "linux" || !run) return {};
  try {
    const fs = statfsSync(run);
    if (fs.type !== 0x01021994 || fs.bavail * fs.bsize < 2 ** 30) return {};
    accessSync(run, constants.W_OK);
    return { TMPDIR: join(run, `morndo-test-${process.pid}-${randomBytes(4).toString("hex")}`) };
  } catch { return {}; }
}
const scratch = ramScratch();
// A web test file is a Chromium test when it imports playwright, or a module under apps/web/test that does, at any
// depth: static, side-effect or dynamic imports, either quote style, subfolders. `import type` and comments don't
// count. A file this misses and that launches Chromium anyway fails at once in the units project
// (test/units-without-chromium.ts) instead of running there beside everything else.
const IMPORTS = /^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;
const startsChromium = (file: string, seen = new Set<string>()): boolean => {
  if (seen.has(file) || !existsSync(file)) return false;
  seen.add(file);
  for (const m of readFileSync(file, "utf8").matchAll(IMPORTS)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? "";
    if (spec === "playwright") return true;
    const next = resolve(dirname(file), spec);
    if (spec.startsWith(".") && next.startsWith(`${WEB_TESTS}/`) && startsChromium(next, seen)) return true;
  }
  return false;
};
const browserTests = readdirSync(WEB_TESTS, { recursive: true, encoding: "utf8" })
  .filter(f => f.endsWith(".test.ts") && startsChromium(join(WEB_TESTS, f)))
  .map(f => relative(".", join(WEB_TESTS, f)));

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "units",
          include: ["packages/*/test/**/*.test.ts", "apps/hub/test/**/*.test.ts", "apps/node-agent/test/**/*.test.ts", "apps/fleet/test/**/*.test.ts", "apps/board-cli/test/**/*.test.ts", "apps/connections/test/**/*.test.ts", "apps/web/test/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: browserTests,
          // Many start a real hub, SQLite, tmux or TigerVNC: alone at load 7 the slowest took 3.6 to 4.0 s against Vitest's
          // 5 s default, so any load tipped them over (five such timeouts at load 18 to 23, each passing alone). 20 s
          // gives room for the setup; what each test checks keeps its own window (a socket closed within 3 s, say).
          testTimeout: 20_000,
          hookTimeout: 20_000,
          env: scratch,
          globalSetup: ["test/run-scratch.ts"],
          setupFiles: ["test/units-without-chromium.ts"],
          sequence: { groupOrder: 0 },
        },
      },
      // Their hooks start Vite and a browser, or close them: 60 s, not Vitest's 10 (review M2: two timed out at load 17).
      // A test that loads its page itself compiles the app cold: 4 files at once beside 16 busy CPU loops, those took
      // 3.8 s (median), 7.4 s (p90), up to 11.9 s (142 tests, 2026-10-12); a third went past Vitest's 5 s. 20 s, as units.
      { test: { name: "chromium", include: browserTests, maxWorkers: browserWorkers, testTimeout: 20_000, hookTimeout: 60_000, env: scratch, globalSetup: ["test/run-scratch.ts"], sequence: { groupOrder: 1 } } },
      { test: { name: "fleet", include: ["test/fleet/**/*.test.ts"], maxWorkers: fleetWorkers, testTimeout: 120_000, hookTimeout: 60_000, env: scratch, globalSetup: ["test/run-scratch.ts"], sequence: { groupOrder: 2 } } },
    ],
  },
});
