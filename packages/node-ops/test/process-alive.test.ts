// One pid check for the registry readers: a positive integer that answers, and EPERM counts as alive.
import { describe, expect, it } from "vitest";
import { processAlive } from "../src/pid.ts";

describe("processAlive", () => {
  it("a positive integer that answers is alive, and EPERM is alive", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(0)).toBe(false);
    expect(processAlive(-1)).toBe(false);
    expect(processAlive(1.5)).toBe(false);
    const kill = () => { const e = new Error("EPERM"); (e as NodeJS.ErrnoException).code = "EPERM"; throw e; };
    expect(processAlive(4, kill)).toBe(true);
  });
});
