// A job's start record (ADR-0017, design §3): the spawn window, the record, and sameProcess read one start, from the
// best source the host has. Every /proc file, the wall clock, the tick rate and ps are injected, so nothing here
// depends on this machine's boot time, CLK_TCK or processes.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clockTicks, resetProcessStartCache } from "@morndo/node-ops";
import { psStarts, readRecorded, sameProcess, writeProcessFile } from "../src/ops/job-identity.ts";
import { tempHome } from "./helpers.ts";

const BOOT_ID = "0f6c1b52-7a3e-4c55-9d1e-2b8f4a6c9e10";
// Beyond any pid_max (2^22), so a real ps or /proc read can never find it.
const NO_PID = 2_147_483_646;

// A host whose boot clock started at `bootMs` (btime prints its whole seconds) and a process that started at
// `startMs`. /proc/uptime is the boot clock read at the injected wall clock, in hundredths; `stallMs` passes on that
// clock right after each /proc/uptime read. `drop` lists files that cannot be read.
function host(o: { pid: number; bootMs: number; startMs: number; nowMs: number; hz?: number; stallMs?: number; drop?: string[] }) {
  const hz = o.hz ?? 100;
  const ticks = Math.floor(((o.startMs - o.bootMs) * hz) / 1000);
  const state = { clock: o.nowMs };
  const files: Record<string, string> = {
    [`/proc/${o.pid}/stat`]: `${o.pid} (job) S ${Array.from({ length: 18 }, () => "0").join(" ")} ${ticks}`,
    "/proc/stat": `cpu 1\nbtime ${Math.floor(o.bootMs / 1000)}\n`,
    "/proc/sys/kernel/random/boot_id": `${BOOT_ID}\n`,
  };
  const reads = new Map<string, number>();
  const read = (path: string): string | null => {
    reads.set(path, (reads.get(path) ?? 0) + 1);
    if (o.drop?.includes(path)) return null;
    if (path === "/proc/uptime") {
      const text = `${(Math.floor((state.clock - o.bootMs) / 10) / 100).toFixed(2)} 1.00\n`;
      state.clock += o.stallMs ?? 0;
      return text;
    }
    return files[path] ?? null;
  };
  return { io: { read, now: () => state.clock, hz, ps: (): string | null => null }, reads, ticks, state };
}

// btime 1791300000; the boot clock's own boot time is 990 ms later in that second.
const BOOT_MS = 1_791_300_000_990;
const START_MS = BOOT_MS + 1_000_000;

let dir = "";
let cleanup = () => {};
let tz: string | undefined;
beforeEach(() => {
  ({ home: dir, cleanup } = tempHome("morndo-identity-"));
  tz = process.env.TZ;
  resetProcessStartCache();
});
afterEach(() => {
  cleanup();
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
  resetProcessStartCache();
});

const record = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), "utf8"));

describe("job start record", () => {
  // ps -o lstart= prints whole seconds. A process that started at :05.990 and was stamped 60 ms later, after spawn()
  // returned, is inside the window although ps says :05.
  it("on the ps fallback, a start truncated to the second is inside the window", () => {
    process.env.TZ = "UTC";
    const startMs = Date.UTC(2026, 9, 8, 12, 0, 5, 990);
    const io = { read: () => null, now: () => startMs + 200, hz: 100, ps: () => "Thu Oct  8 12:00:05 2026" };
    writeProcessFile(join(dir, "ps.at"), NO_PID, startMs + 60, io);
    expect(existsSync(join(dir, "ps.at"))).toBe(true);
    const rec = record("ps.at") as { earliest: number; latest: number };
    expect(rec.earliest).toBe(Date.UTC(2026, 9, 8, 12, 0, 5));
    expect(rec.latest).toBeGreaterThan(startMs);
    writeProcessFile(join(dir, "ps-late.at"), NO_PID, startMs + 60_000, io);
    expect(existsSync(join(dir, "ps-late.at"))).toBe(false);
  });

  it("uses the tick rate it is given, not this host's", () => {
    const { io, ticks } = host({ pid: NO_PID, bootMs: BOOT_MS, startMs: START_MS, nowMs: START_MS + 200, hz: 250 });
    writeProcessFile(join(dir, "hz.at"), NO_PID, START_MS + 50, io);
    expect(existsSync(join(dir, "hz.at"))).toBe(true);
    expect(record("hz.at")).toEqual({ ticks, bootId: BOOT_ID });
  });

  // 300 ms pass between reading /proc/uptime and the clock. The start comes out as a range that holds that gap,
  // not 300 ms late: one that began 900 ms after the stamp is inside the window, one 1.5 s after it is not.
  it("a stall between /proc/uptime and the clock widens the start instead of moving it", () => {
    const inside = host({ pid: NO_PID, bootMs: BOOT_MS, startMs: START_MS, nowMs: START_MS + 200, stallMs: 300 });
    writeProcessFile(join(dir, "stall.at"), NO_PID, START_MS - 900, inside.io);
    expect(existsSync(join(dir, "stall.at"))).toBe(true);
    const outside = host({ pid: NO_PID, bootMs: BOOT_MS, startMs: START_MS, nowMs: START_MS + 200, stallMs: 300 });
    writeProcessFile(join(dir, "stall-out.at"), NO_PID, START_MS - 1_500, outside.io);
    expect(existsSync(join(dir, "stall-out.at"))).toBe(false);
  });

  // No boot id, so no identity: the record is the start itself. It is the exact start the window was checked on, and
  // sameProcess finds the same process from /proc and from one ps line, and a later process on that pid is not it.
  it("with no boot id, the record is the exact start, and sameProcess matches it from /proc and from ps", async () => {
    process.env.TZ = "UTC";
    const pid = process.pid;
    const startMs = Date.UTC(2026, 9, 8, 12, 0, 5, 990);
    const bootMs = startMs - 1_000_000;
    const drop = ["/proc/sys/kernel/random/boot_id"];
    const at = host({ pid, bootMs, startMs, nowMs: startMs + 200, drop });
    writeProcessFile(join(dir, "start.at"), pid, startMs + 50, at.io);
    const rec = record("start.at") as { earliest: number; latest: number };
    expect(rec.earliest).toBeLessThanOrEqual(startMs);
    expect(rec.latest).toBeGreaterThanOrEqual(startMs);
    expect(rec.latest - rec.earliest).toBeLessThanOrEqual(30);
    const recorded = readRecorded(readFileSync(join(dir, "start.at"), "utf8"));
    const later = host({ pid, bootMs, startMs, nowMs: startMs + 60_000, drop });
    expect(await sameProcess(pid, recorded, undefined, later.io)).toBe(true);
    const viaPs = await psStarts([pid], async () => `${pid} Thu Oct  8 12:00:05 2026\n`);
    expect(await sameProcess(pid, recorded, viaPs, later.io)).toBe(true);
    const reused = host({ pid, bootMs, startMs: startMs + 3_000, nowMs: startMs + 60_000, drop });
    expect(await sameProcess(pid, recorded, undefined, reused.io)).toBe(false);
  });

  it("keeps an exact start when /proc/stat and ps give none", () => {
    const { io, ticks } = host({ pid: NO_PID, bootMs: BOOT_MS, startMs: START_MS, nowMs: START_MS + 200, drop: ["/proc/stat"] });
    writeProcessFile(join(dir, "nobtime.at"), NO_PID, START_MS + 50, io);
    expect(record("nobtime.at")).toEqual({ ticks, bootId: BOOT_ID });
  });

  it("reads the process's /proc stat once per record", () => {
    const { io, reads } = host({ pid: NO_PID, bootMs: BOOT_MS, startMs: START_MS, nowMs: START_MS + 200 });
    writeProcessFile(join(dir, "once.at"), NO_PID, START_MS + 50, io);
    expect(existsSync(join(dir, "once.at"))).toBe(true);
    expect(reads.get(`/proc/${NO_PID}/stat`)).toBe(1);
  });

  // One CLK_TCK for the node: read once, and the rate the start record uses when it is not given one.
  it("one cached tick rate for every caller", () => {
    let asked = 0;
    const getconf = () => { asked += 1; return "250\n"; };
    expect(clockTicks(getconf)).toBe(250);
    expect(clockTicks(getconf)).toBe(250);
    expect(asked).toBe(1);
    const { io, ticks } = host({ pid: NO_PID, bootMs: BOOT_MS, startMs: START_MS, nowMs: START_MS + 200, hz: 250 });
    writeProcessFile(join(dir, "cached.at"), NO_PID, START_MS + 50, { read: io.read, now: io.now, ps: io.ps });
    expect(record("cached.at")).toEqual({ ticks, bootId: BOOT_ID });
  });
});
