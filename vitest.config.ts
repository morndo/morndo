import { readFileSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// The web tests that drive headless Chromium each start a Vite server and compile the app cold. All of them at once
// saturate the box and their first page load times out, so at most 4 of those files run at a time, after every other
// test file has run as before (Vitest runs projects with different worker limits as groups, one after the other). A
// test file is one of them when it imports playwright. Each needs about two CPUs (its Vite server and its browser), so
// a smaller machine runs fewer at once: 4 on this 16-CPU box, 1 on GitHub's 2-CPU runner for private repositories
// (docs.github.com, "GitHub-hosted runners", read 2026-10-02). Even here, 4 at once under a load average of 20 once
// pushed a first test from 2 s to over 30 s.
const WEB_TESTS = "apps/web/test";
const browserWorkers = Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)));
// The fleet's cross-app drills (test/fleet, spec §9): real fleet, agent and hub processes on isolated tmux servers. Most of
// their time is waiting (reconnects, health every 30 s, a 75 s flapping window), not CPU, so they run after everything
// else, in a group of their own, a few files at a time. CI runs them in a job of their own (.github/workflows/ci.yml).
// Projects in a later groupOrder run after the earlier groups (https://vitest.dev/config/sequence.html, v5.0.3, read
// 2026-10-06).
const fleetWorkers = Math.min(4, Math.max(2, Math.floor(availableParallelism() / 2)));
const browserTests = readdirSync(WEB_TESTS)
  .filter(f => f.endsWith(".test.ts") && readFileSync(join(WEB_TESTS, f), "utf8").includes('from "playwright"'))
  .map(f => `${WEB_TESTS}/${f}`);

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "units",
          include: ["packages/*/test/**/*.test.ts", "apps/hub/test/**/*.test.ts", "apps/node-agent/test/**/*.test.ts", "apps/fleet/test/**/*.test.ts", "apps/board-cli/test/**/*.test.ts", "apps/connections/test/**/*.test.ts", "apps/web/test/**/*.test.ts", "apps/updater/test/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: browserTests,
          // Many start a real hub, SQLite, tmux or TigerVNC: alone at load 7 the slowest took 3.6 to 4.0 s against Vitest's
          // 5 s default, so any load tipped them over (five such timeouts at load 18 to 23, each passing alone). 20 s
          // gives room for the setup; what each test checks keeps its own window (a socket closed within 3 s, say).
          testTimeout: 20_000,
          hookTimeout: 20_000,
          sequence: { groupOrder: 0 },
        },
      },
      // Their hooks start Vite and a browser, or close them: 60 s, not Vitest's 10 (review M2: two timed out at load 17).
      { test: { name: "chromium", include: browserTests, maxWorkers: browserWorkers, hookTimeout: 60_000, sequence: { groupOrder: 1 } } },
      { test: { name: "fleet", include: ["test/fleet/**/*.test.ts"], maxWorkers: fleetWorkers, testTimeout: 120_000, hookTimeout: 60_000, sequence: { groupOrder: 2 } } },
    ],
  },
});
