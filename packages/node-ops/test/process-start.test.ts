// Process start from /proc/<pid>/stat field 22 plus btime or /proc/uptime, and from `ps -o lstart=` when /proc yields nothing.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { processIdentity, processStartedMs, resetProcessStartCache, startMsFromProc, startMsFromUptime, startTicksFromStat } from "../src/pid.ts";

const STAT = "7 (a proc) S " + Array.from({ length: 18 }, () => "0").join(" ") + " 18872294";
const BOOT = "cpu 1\nbtime 1791293952\n";
const START_MS = 1791293952 * 1000 + Math.round((18872294 * 1000) / 100);

describe("process start", () => {
  beforeEach(() => { resetProcessStartCache(); });

  it("turns starttime ticks and btime into ms", () => {
    expect(startMsFromProc(STAT, BOOT, 100)).toBe(START_MS);
    expect(startMsFromProc("7 (no close", BOOT, 100)).toBeNull();
    expect(startMsFromProc(STAT, "cpu 1\n", 100)).toBeNull();
  });

  // STAT started 188722.94 s after boot; /proc/uptime read 200 ms later says 188723.14, beside the wall clock NOW.
  it("turns starttime ticks and uptime into ms from the wall clock read beside it", () => {
    const NOW = 1_791_500_000_123;
    expect(startMsFromUptime(STAT, "188723.14 9000.00\n", 100, NOW)).toBe(NOW - 200);
    expect(startMsFromUptime(STAT, "188723.14", 100, NOW)).toBe(NOW - 200);
    expect(startMsFromUptime("7 (no close", "188723.14 1.00\n", 100, NOW)).toBeNull();
    for (const bad of ["", "\n", "x 1.00", "-1.00 1.00", "1e3 1.00"]) expect(startMsFromUptime(STAT, bad, 100, NOW)).toBeNull();
    expect(startMsFromUptime(STAT, "188723.14 1.00\n", 0, NOW)).toBeNull();
    expect(startMsFromUptime(STAT, "188723.14 1.00\n", 100, Number.NaN)).toBeNull();
  });

  it("reads this process from /proc and does not call ps", async () => {
    let ps = 0;
    const ms = await processStartedMs(process.pid, { ps: () => { ps += 1; return null; } });
    expect(ps).toBe(0);
    expect(ms).toEqual(expect.any(Number));
    expect(Date.now() - (ms ?? 0)).toBeLessThan(60 * 60 * 1000);
  });

  it("reads /proc/stat once, then reuses that boot time", async () => {
    let statReads = 0;
    const read = (path: string) => {
      if (path === "/proc/stat") { statReads += 1; return BOOT; }
      return STAT;
    };
    expect(await processStartedMs(7, { read, hz: 100, ps: () => null })).toBe(START_MS);
    expect(await processStartedMs(8, { read, hz: 100, ps: () => null })).toBe(START_MS);
    expect(statReads).toBe(1);
  });

  it("asks for CLK_TCK again after getconf fails", async () => {
    let n = 0;
    const getconf = () => { n += 1; if (n === 1) throw new Error("getconf"); return "100"; };
    const read = (path: string) => path === "/proc/stat" ? BOOT : STAT;
    expect(await processStartedMs(7, { read, getconf, ps: () => null })).toBeNull();
    expect(await processStartedMs(7, { read, getconf, ps: () => null })).toBe(START_MS);
    expect(n).toBe(2);
  });

  it("uses ps when /proc is missing, without treating the awaitable as the date line", async () => {
    const line = "Thu Oct  8 12:00:00 2026";
    const previous = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      const pending = processStartedMs(7, { read: () => null, hz: 100, ps: async () => line });
      expect(pending).toBeInstanceOf(Promise);
      // Thu Oct 8 12:00:00 2026 in UTC. Independent of the parser under test.
      expect(await pending).toBe(Date.UTC(2026, 9, 8, 12, 0, 0));
      expect(await processStartedMs(7, { read: () => null, hz: 100, ps: async () => "not a date" })).toBeNull();
      expect(await processStartedMs(0)).toBeNull();
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
    expect(processIdentity(7, read)).toEqual({ ticks: 18872294, bootId: "abc-boot" });
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
