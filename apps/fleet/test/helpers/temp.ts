// Temporary directories for the fleet's tests, removed after each test. Short names: a Unix socket path must stay
// under 104 bytes on macOS (108 on Linux), and the client API's socket lives inside one of these.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const dirs: string[] = [];
export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mf-"));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
