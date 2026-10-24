// The forge credential's file (ADR-0035 step 3, private repositories): read once at start, from a path the settings
// name, refused when others can read it, and never said back in any warning. The token is built here at runtime so no
// such string sits in the source.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTokenFile } from "../src/adapters/token-file.ts";

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "morndo-token-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const SECRET = ["forge", "token", "for", "tests"].join("-");
const fileWith = (text: string, mode = 0o600) => {
  const path = join(tempDir(), "forge-read");
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
};
const warnings = () => { const seen: string[] = []; return { seen, warn: (m: string) => { seen.push(m); } }; };

describe("the forge credential's file", () => {
  it("returns the token of a file only its owner can read, trimmed, and says nothing", () => {
    const w = warnings();
    expect(readTokenFile(fileWith(`${SECRET}\n`), w.warn)).toBe(SECRET);
    expect(w.seen).toEqual([]);
  });

  it("no path means no token and no warning", () => {
    const w = warnings();
    expect(readTokenFile(null, w.warn)).toBeNull();
    expect(w.seen).toEqual([]);
  });

  it("a file others can read is refused with a warning that names the path and not the token", () => {
    const w = warnings();
    const path = fileWith(SECRET, 0o644);
    expect(readTokenFile(path, w.warn)).toBeNull();
    expect(w.seen).toHaveLength(1);
    expect(w.seen[0]).toContain(path);
    expect(w.seen[0]).not.toContain(SECRET);
  });

  it("a missing or empty file is no token, with a warning that does not hold the token either", () => {
    const w = warnings();
    expect(readTokenFile(join(tempDir(), "absent"), w.warn)).toBeNull();
    expect(readTokenFile(fileWith("  \n"), w.warn)).toBeNull();
    expect(w.seen).toHaveLength(2);
    for (const m of w.seen) expect(m).not.toContain(SECRET);
  });
});
