// descendants(): the processes a process started, to any depth, from the `ps` table (T-274). A shell that starts two sleepers, one
// of them through a second shell, so the tree is two levels deep.
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { descendants } from "../src/process-tree.ts";

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("descendants", () => {
  it("lists children and grandchildren, not the root, and nothing for a process that is not there", async () => {
    const root = spawn("sh", ["-c", "sleep 30 & sh -c 'sleep 30 & wait' & wait"], { stdio: "ignore" });
    const pid = root.pid ?? 0;
    try {
      let found: number[] = [];
      for (let i = 0; i < 100 && found.length < 3; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        found = descendants(pid);
      }
      expect(found).toHaveLength(3);                                    // sleep, the inner sh, and its sleep
      expect(found).not.toContain(pid);
      expect(found.every(alive)).toBe(true);
      for (const child of found) process.kill(child, "SIGKILL");
    } finally { root.kill("SIGKILL"); }
    expect(descendants(2 ** 22 + 12345)).toEqual([]);
  });
});
