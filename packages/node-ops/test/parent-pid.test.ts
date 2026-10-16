// The parent of a process, from /proc/<pid>/stat (command names may hold spaces and parentheses) or ps.
import { describe, expect, it } from "vitest";
import { parentPid } from "../src/pid.ts";

describe("parentPid", () => {
  it("reads the parent after the command's last parenthesis", () => {
    const stat = "4242 (engine (lane) x) S 4100 4242 4000 34816 4242 4194560 1 0 0 0 0 0 0 0 20 0 1 0 5500 1000 100 18446744073709551615";
    expect(parentPid(4242, { read: () => stat })).toBe(4100);
  });
  it("asks ps when there is no /proc, and answers null for a process that is gone, a bad answer or a bad pid", () => {
    expect(parentPid(4242, { read: () => null, ps: () => "4100" })).toBe(4100);
    expect(parentPid(4242, { read: () => null, ps: () => null })).toBeNull();
    expect(parentPid(4242, { read: () => null, ps: () => "x" })).toBeNull();
    expect(parentPid(4242, { read: () => "garbage" })).toBeNull();
    expect(parentPid(0, { read: () => "1 (a) S 1" })).toBeNull();
  });
  it("is the real parent for this process", () => {
    expect(parentPid(process.pid)).toBe(process.ppid);
  });
});
