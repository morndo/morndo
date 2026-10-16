// A process's group and its terminal's foreground group, from /proc/<pid>/stat. No ps: a missing entry is a process that is gone.
import { describe, expect, it } from "vitest";
import { procGroups } from "../src/pid.ts";

describe("procGroups", () => {
  it("reads the group and the terminal's foreground group after the command's last parenthesis", () => {
    const stat = "4242 (engine (lane) x) S 4100 4242 4000 34816 4242 4194560 1 0 0 0 0 0 0 0 20 0 1 0 5500 1000 100 18446744073709551615";
    expect(procGroups(4242, { read: () => stat })).toEqual({ pgrp: 4242, tpgid: 4242 });
  });
  it("says a process with no terminal has none (tpgid -1)", () => {
    const stat = "9 (daemon) S 1 9 9 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 5500 1000 100 18446744073709551615";
    expect(procGroups(9, { read: () => stat })).toEqual({ pgrp: 9, tpgid: -1 });
  });
  it("is null for a process that is gone (no /proc entry, no ps), garbage, or a bad pid", () => {
    let asked = 0;
    expect(procGroups(4242, { read: () => { asked++; return null; } })).toBeNull();
    expect(asked).toBe(1);
    expect(procGroups(4242, { read: () => "garbage" })).toBeNull();
    expect(procGroups(0, { read: () => "1 (a) S 1 1 1 0 1" })).toBeNull();
  });
  it("is this process's own group for this process", () => {
    const own = procGroups(process.pid);
    expect(own?.pgrp).toBeGreaterThan(0);
  });
});
