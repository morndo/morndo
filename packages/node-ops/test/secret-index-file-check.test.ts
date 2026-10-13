// The index file adapter: the check review of PR #31 (board T-94), point 2. On Linux, open(2) on a socket fails with
// ENXIO, which the round-7 test proves with a real socket. macOS and FreeBSD fail it with EOPNOTSUPP ("An attempt is made
// to open a socket"), and FreeBSD fails O_NOFOLLOW on a link with EMLINK (macOS: ELOOP, as Linux). Those can't be made
// here, so the open fails with each code as those systems would, and the reader must name it the wrong kind. open(2):
// https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/open.2.html and
// https://man.freebsd.org/cgi/man.cgi?query=open&sektion=2, read 2026-10-12.
import { afterEach, describe, expect, it, vi } from "vitest";

const fails = vi.hoisted(() => ({ code: null as string | null }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  const openSync = (...args: Parameters<typeof fs.openSync>) => {
    if (fails.code === null) return fs.openSync(...args);
    throw Object.assign(new Error(`${fails.code}: open`), { code: fails.code });
  };
  return { ...fs, openSync, default: { ...fs, openSync } };
});
const { IndexFileRefused, readSecretIndex } = await import("../src/secret-index-file.ts");

afterEach(() => { fails.code = null; });
const problem = (code: string) => {
  fails.code = code;
  try { readSecretIndex("/nonexistent/index", 1000); return "read"; } catch (error) { return error instanceof IndexFileRefused ? error.problem : `other: ${String(error)}`; }
};

describe("check review, point 2: a socket or a link at the index path is the wrong kind on macOS and the BSDs too", () => {
  it("EOPNOTSUPP (a socket on macOS and FreeBSD) and EMLINK (a link under O_NOFOLLOW on FreeBSD) are refused as kind", () => {
    expect(problem("EOPNOTSUPP")).toBe("kind");
    expect(problem("EMLINK")).toBe("kind");
  });
  it("the Linux codes still are, and any other failure is passed on unchanged", () => {
    expect(problem("ELOOP")).toBe("kind");
    expect(problem("ENXIO")).toBe("kind");
    expect(problem("EACCES")).toBe("other: Error: EACCES: open");
  });
});
