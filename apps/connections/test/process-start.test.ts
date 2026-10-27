// When a process started, in wall-clock milliseconds (ADR-0037 fix round 2): what `watch --server-pid` can prove about the key a server loaded.
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { processStartMs, processStartWindow } from "../src/adapters/processes.ts";

describe("processStartMs", () => {
  it("a process started now started now (within a second of the clock before and after)", async () => {
    const before = Date.now();
    const child = spawn("sleep", ["5"]);
    await new Promise<void>(resolve => { child.on("spawn", () => { resolve(); }); });
    const after = Date.now();
    try {
      const started = processStartMs(child.pid ?? 0);
      expect(started).not.toBeNull();
      expect(started ?? 0).toBeGreaterThanOrEqual(before - 1000);
      expect(started ?? 0).toBeLessThanOrEqual(after + 1000);
    } finally { child.kill("SIGKILL"); }
  });
  it("a later process started later", async () => {
    const first = spawn("sleep", ["5"]);
    await new Promise<void>(resolve => { first.on("spawn", () => { resolve(); }); });
    await new Promise<void>(resolve => { setTimeout(resolve, 1300); });
    const second = spawn("sleep", ["5"]);
    await new Promise<void>(resolve => { second.on("spawn", () => { resolve(); }); });
    try {
      expect((processStartMs(second.pid ?? 0) ?? 0) - (processStartMs(first.pid ?? 0) ?? 0)).toBeGreaterThanOrEqual(1000);
    } finally { first.kill("SIGKILL"); second.kill("SIGKILL"); }
  });
  it("a pid that is not a process, or not a pid, is null", () => {
    expect(processStartMs(2147483646)).toBeNull();
    expect(processStartMs(0)).toBeNull();
    expect(processStartMs(-3)).toBeNull();
    expect(processStartMs(Number.NaN)).toBeNull();
  });
});

describe("processStartWindow", () => {
  it("is a window one second wide that holds the moment the process started: the boot time is only known to the second", async () => {
    const before = Date.now();
    const child = spawn("sleep", ["5"]);
    await new Promise<void>(resolve => { child.on("spawn", () => { resolve(); }); });
    const after = Date.now();
    try {
      const window = processStartWindow(child.pid ?? 0);
      expect(window).not.toBeNull();
      expect((window?.to ?? 0) - (window?.from ?? 0)).toBe(1000);
      expect(window?.from ?? Infinity).toBeLessThanOrEqual(after);
      expect(window?.to ?? 0).toBeGreaterThanOrEqual(before);
      expect(processStartMs(child.pid ?? 0)).toBe(window?.from);
    } finally { child.kill("SIGKILL"); }
  });
  it("is null for a pid that is not a process, or not a pid", () => {
    for (const pid of [2147483646, 0, -3, Number.NaN]) expect(processStartWindow(pid)).toBeNull();
  });
});
