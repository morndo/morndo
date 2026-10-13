// The transcription guard's machine reads (design §9, as jobs' guard): what each platform can answer, and only the
// configured lines. Linux reads /proc. macOS sums vm_stat's free, inactive and speculative pages. A made-up
// vm_stat listing stands in for the command. Synthetic files under a temp dir.
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
  it("reads load and reclaimable pages where there is no /proc (macOS)", () => {
    const vm = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                               100.",
      "Pages active:                            8000.",
      "Pages inactive:                            50.",
      "Pages speculative:                         25.",
    ].join("\n");
    const available = (100 + 50 + 25) * 16384 / (1024 * 1024);
    const mac = readMachine({ load1: 6, memAvailableMiB: 1024 }, {
      platform: "darwin", loadavg: () => [3.25, 2, 1], vmStat: () => vm,
      loadPath: "/nonexistent", memPath: "/nonexistent",
    });
    expect(mac).toEqual({ load1: 3.25, memAvailableMiB: available });
    expect(available).toBeLessThan(8 * 1024);
    expect(guardNow({ load1: 6, memAvailableMiB: 1 }, () => mac)).toBe("off");
    expect(guardNow({ load1: 3 }, () => mac)).toBe("load");
    expect(guardNow({ memAvailableMiB: 4 }, () => mac)).toBe("memory");
    expect(guardNow({ memAvailableMiB: 1024 }, () => readMachine({ memAvailableMiB: 1024 }, {
      platform: "darwin", vmStat: () => { throw new Error("vm_stat failed"); },
    }))).toBe("unknown");
  });

  it("keeps total memory on every platform that is not linux or macOS", () => {
    let calls = 0;
    const vmStat = () => { calls += 1; throw new Error("no vm_stat"); };
    const freebsd = readMachine({ memAvailableMiB: 1 }, {
      platform: "freebsd", vmStat, totalmem: () => 2048 * 1024 * 1024,
    });
    const win = readMachine({ memAvailableMiB: 1 }, {
      platform: "win32", vmStat, totalmem: () => 512 * 1024 * 1024,
    });
    expect(calls).toBe(0);
    expect(freebsd.memAvailableMiB).toBe(2048);
    expect(win.memAvailableMiB).toBe(512);
    expect(guardNow({ memAvailableMiB: 1024 }, () => freebsd)).toBe("off");
    expect(guardNow({ memAvailableMiB: 1024 }, () => win)).toBe("memory");
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
