// Discovery (design §6): one known path, never PATH. A group-writable file is not run.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { locateTranscriber } from "../src/adapters/transcriber-path.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), "morndo-tx-")); dirs.push(d); return d; };

function place(dir: string, name: string, mode: number): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode });
  chmodSync(path, mode);
  return path;
}

describe("transcriber discovery", () => {
  it("does not take a program that is only on PATH", () => {
    const dir = temp();
    const bin = join(dir, "bin");
    place(bin, "morndo-transcribe", 0o755);
    const home = join(dir, "home");
    const found = locateTranscriber({ PATH: bin }, home);
    expect(found).toEqual({ path: null, reason: "missing", detail: "missing" });
  });

  it("uses MORNDO_TRANSCRIBER when that file is the user's and not group-writable", () => {
    const dir = temp();
    const safe = place(dir, "ear", 0o755);
    place(join(dir, "bin"), "morndo-transcribe", 0o755);
    const found = locateTranscriber({ PATH: join(dir, "bin"), MORNDO_TRANSCRIBER: safe }, join(dir, "home"));
    expect(found).toEqual({ path: safe });
  });

  it("refuses a relative path, a group-writable file, and a symlink to one", () => {
    const dir = temp();
    const loose = place(dir, "loose", 0o775);
    const home = join(dir, "home");
    expect(locateTranscriber({ MORNDO_TRANSCRIBER: "ear" }, home)).toEqual({ path: null, reason: "missing", detail: "missing" });
    expect(locateTranscriber({ MORNDO_TRANSCRIBER: loose }, home)).toEqual({ path: null, reason: "not_ready", detail: "unsafe_permissions" });
    const link = join(dir, "link");
    symlinkSync(loose, link);
    expect(locateTranscriber({ MORNDO_TRANSCRIBER: link }, home)).toEqual({ path: null, reason: "not_ready", detail: "unsafe_permissions" });
    const safe = place(dir, "safe", 0o755);
    const ok = join(dir, "ok");
    symlinkSync(safe, ok);
    expect(locateTranscriber({ MORNDO_TRANSCRIBER: ok }, home)).toEqual({ path: ok });
  });

  it("reads the plugin under the home directory when the variable is unset", () => {
    const home = temp();
    const path = place(join(home, "plugins/transcribe/bin"), "morndo-transcribe", 0o755);
    expect(locateTranscriber({}, home)).toEqual({ path });
  });
});
