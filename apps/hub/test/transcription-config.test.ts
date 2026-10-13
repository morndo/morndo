// The transcription guard's machine reads (design §9, as jobs' guard): what each platform can answer, and only the
// configured lines. Linux reads /proc; macOS has no /proc, so the load and free memory come from os, as health.ts
// already does for the fleet. Synthetic files under a temp dir.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guardNow, readMachine } from "../src/adapters/transcription-config.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function procFiles(load1: string, memAvailableKb?: number): { loadPath: string; memPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "morndo-txconf-"));
  dirs.push(dir);
  const loadPath = join(dir, "loadavg");
  const memPath = join(dir, "meminfo");
  writeFileSync(loadPath, `${load1} 0.50 0.25 1/300 12345\n`);
  writeFileSync(memPath, memAvailableKb === undefined ? "MemTotal:       16000000 kB\n" : `MemTotal:       16000000 kB\nMemAvailable:   ${memAvailableKb} kB\n`);
  return { loadPath, memPath };
}

describe("transcription guard reads", () => {
  it("reads load and free memory from os where there is no /proc (macOS), and the guard passes on them", () => {
    const mac = readMachine({ load1: 6, memAvailableMiB: 1024 }, {
      platform: "darwin", loadavg: () => [3.25, 2, 1], freemem: () => 512 * 1024 * 1024, loadPath: "/nonexistent", memPath: "/nonexistent",
    });
    expect(mac).toEqual({ load1: 3.25, memAvailableMiB: 512 });
    expect(guardNow({ load1: 6, memAvailableMiB: 256 }, () => mac)).toBe("off");
    expect(guardNow({ load1: 3 }, () => mac)).toBe("load");
    expect(guardNow({ memAvailableMiB: 513 }, () => mac)).toBe("memory");
  });

  it("reads only the configured line on linux, so a load-only guard never touches meminfo", () => {
    const files = procFiles("4.25", undefined);
    const read = readMachine({ load1: 6 }, { platform: "linux", ...files, memPath: "/nonexistent" });
    expect(read).toEqual({ load1: 4.25 });
    expect(guardNow({ load1: 6 }, () => read)).toBe("off");
    expect(guardNow({ load1: 4 }, () => read)).toBe("load");
  });

  it("still answers unknown when a configured line cannot be read on linux", () => {
    const files = procFiles("4.25", 2_097_152);
    expect(guardNow({ memAvailableMiB: 1024 }, () => readMachine({ memAvailableMiB: 1024 }, { platform: "linux", ...files, memPath: "/nonexistent" }))).toBe("unknown");
  });
});
