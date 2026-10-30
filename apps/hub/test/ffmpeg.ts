// Tests that make their sample with a real ffmpeg. CI installs it (ci.yml), so there they run, and without it they fail
// one failing test naming the cause (they themselves skip then); anywhere else (a machine without ffmpeg) they skip, the title saying why.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "vitest";

export const ffmpegOk = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;

if (!ffmpegOk && process.env.CI) {
  it("ffmpeg is on PATH (CI installs it)", () => { throw new Error("ffmpeg is not on PATH, but CI must have it: see the ffmpeg step in .github/workflows/ci.yml"); });
}

export const itFfmpeg: typeof it = ffmpegOk
  ? it
  : ((name: string, ...rest: unknown[]) => (it.skip as (n: string, ...r: unknown[]) => void)(`${name} [skipped: ffmpeg is not on PATH]`, ...rest)) as unknown as typeof it;

// A folder that goes after the test whatever the test did, so a sample that failed to make leaves nothing behind.
const folders: string[] = [];
afterEach(() => { for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true }); });
export function scratchFolder(prefix: string): string {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  folders.push(folder);
  return folder;
}
