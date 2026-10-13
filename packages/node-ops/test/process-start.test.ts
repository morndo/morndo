// Process start as a range: /proc/uptime less field 22 of /proc/<pid>/stat, else btime plus field 22, else
// `ps -o lstart=` when /proc yields nothing.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clockTicks, identityFromStat, processIdentity, processStart, processStartSync, resetProcessStartCache, sameStart,
  startFromBtime, startFromLstart, startFromUptime, startTicksFromStat,
} from "../src/pid.ts";

const STAT = "7 (a proc) S " + Array.from({ length: 18 }, () => "0").join(" ") + " 18872294";
const BOOT = "cpu 1\nbtime 1791293952\n";
const BTIME_MS = 1791293952 * 1000 + 188722940;

describe("process start", () => {
  beforeEach(() => { resetProcessStartCache(); });

  // STAT started 188722.94 s after boot; /proc/uptime read at NOW says 188723.14, 200 ms later.
  it("turns starttime ticks and uptime into a range around the wall clock read beside it", () => {
    const NOW = 1_791_500_000_123;
    expect(startFromUptime(STAT, "188723.14 9000.00\n", 100, NOW, NOW)).toEqual({ earliest: NOW - 210, latest: NOW - 189 });
    expect(startFromUptime(STAT, "188723.14", 100, NOW, NOW + 300)).toEqual({ earliest: NOW - 210, latest: NOW + 111 });
    expect(startFromUptime("7 (no close", "188723.14 1.00\n", 100, NOW, NOW)).toBeNull();
    for (const bad of ["", "\n", "x 1.00", "-1.00 1.00", "1e3 1.00"]) expect(startFromUptime(STAT, bad, 100, NOW, NOW)).toBeNull();
    expect(startFromUptime(STAT, "188723.14 1.00\n", 0, NOW, NOW)).toBeNull();
    expect(startFromUptime(STAT, "188723.14 1.00\n", 100, Number.NaN, NOW)).toBeNull();
    expect(startFromUptime(STAT, "188723.14 1.00\n", 100, NOW, NOW - 1)).toBeNull();
  });

  it("turns starttime ticks and btime into a range up to a second and a tick late", () => {
    expect(startFromBtime(STAT, BOOT, 100)).toEqual({ earliest: BTIME_MS, latest: BTIME_MS + 1010 });
    expect(startFromBtime("7 (no close", BOOT, 100)).toBeNull();
    expect(startFromBtime(STAT, "cpu 1\n", 100)).toBeNull();
  });

  it("reads ps's whole seconds as a range: two seconds and a tick on Linux, one elsewhere", () => {
    const previous = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      const at = Date.UTC(2026, 9, 8, 12, 0, 0);
      expect(startFromLstart("Thu Oct  8 12:00:00 2026\n", "linux")).toEqual({ earliest: at, latest: at + 2010 });
      expect(startFromLstart("Thu Oct  8 12:00:00 2026", "darwin")).toEqual({ earliest: at, latest: at + 1000 });
      expect(startFromLstart("not a date")).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("two ranges are the same start when they overlap", () => {
    expect(sameStart({ earliest: 0, latest: 10 }, { earliest: 10, latest: 20 })).toBe(true);
    expect(sameStart({ earliest: 0, latest: 10 }, { earliest: 11, latest: 20 })).toBe(false);
    expect(sameStart({ earliest: 5, latest: 6 }, { earliest: 0, latest: 2010 })).toBe(true);
  });

  it("reads this process from /proc, to about 20 ms, and does not call ps", async () => {
    let ps = 0;
    const start = await processStart(process.pid, { ps: () => { ps += 1; return null; } });
    expect(ps).toBe(0);
    expect(start).not.toBeNull();
    expect(start!.latest - start!.earliest).toBeLessThan(100);
    expect(Date.now() - start!.earliest).toBeLessThan(60 * 60 * 1000);
    expect(sameStart(start!, processStartSync(process.pid)!)).toBe(true);
  });

  it("falls back to btime without /proc/uptime", async () => {
    const read = (path: string) => path === "/proc/stat" ? BOOT : path === "/proc/uptime" ? null : STAT;
    expect(await processStart(7, { read, hz: 100, ps: () => null })).toEqual({ earliest: BTIME_MS, latest: BTIME_MS + 1010 });
    expect(processStartSync(7, { read, hz: 100, ps: () => null })).toEqual({ earliest: BTIME_MS, latest: BTIME_MS + 1010 });
  });

  it("keeps CLK_TCK once read, and asks again after getconf fails", async () => {
    let n = 0;
    const getconf = () => { n += 1; if (n === 1) throw new Error("getconf"); return "100\n"; };
    const read = (path: string) => path === "/proc/stat" ? BOOT : path === "/proc/uptime" ? null : STAT;
    expect(await processStart(7, { read, getconf, ps: () => null })).toBeNull();
    expect(await processStart(7, { read, getconf, ps: () => null })).toEqual({ earliest: BTIME_MS, latest: BTIME_MS + 1010 });
    expect(clockTicks(getconf)).toBe(100);
    expect(n).toBe(2);
  });

  it("uses ps when /proc is missing, without treating the awaitable as the date line", async () => {
    const line = "Thu Oct  8 12:00:00 2026";
    const previous = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      const pending = processStart(7, { read: () => null, hz: 100, ps: async () => line });
      expect(pending).toBeInstanceOf(Promise);
      // Thu Oct 8 12:00:00 2026 in UTC. Independent of the parser under test.
      expect((await pending)?.earliest).toBe(Date.UTC(2026, 9, 8, 12, 0, 0));
      expect(processStartSync(7, { read: () => null, hz: 100, ps: () => line })?.earliest).toBe(Date.UTC(2026, 9, 8, 12, 0, 0));
      expect(await processStart(7, { read: () => null, hz: 100, ps: async () => "not a date" })).toBeNull();
      expect(await processStart(0)).toBeNull();
      expect(processStartSync(0)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("reads field 22 and this boot's id, and keeps a successful boot id", () => {
    let boots = 0;
    const read = (path: string) => {
      if (path === "/proc/7/stat") return STAT;
      if (path === "/proc/sys/kernel/random/boot_id") { boots += 1; return "abc-boot\n"; }
      return null;
    };
    expect(processIdentity(7, read)).toEqual({ ticks: 18872294, bootId: "abc-boot" });
    expect(processIdentity(8, read)).toBeNull();
    expect(identityFromStat(STAT, read)).toEqual({ ticks: 18872294, bootId: "abc-boot" });
    expect(boots).toBe(1);
    expect(startTicksFromStat(STAT)).toBe(18872294);
  });

  it("retries a boot id read that failed", () => {
    let fail = true;
    const read = (path: string) => {
      if (path === "/proc/7/stat") return STAT;
      if (path === "/proc/sys/kernel/random/boot_id") return fail ? null : "later\n";
      return null;
    };
    expect(processIdentity(7, read)).toBeNull();
    fail = false;
    expect(processIdentity(7, read)).toEqual({ ticks: 18872294, bootId: "later" });
  });

  it("matches this process's field 22 and boot id", () => {
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    expect(processIdentity(process.pid)).toEqual({ ticks: startTicksFromStat(stat), bootId: boot });
  });
});
