// A "*" deny root whose matching directory is itself a symbolic link (service state moved to another disk / stowed):
// a file under it, asked by its REAL path, must still be denied (spec README §8, the deny list covers the services' state).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confine } from "../src/file-rules.ts";

let base: string, home: string, data: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "confine-star-")));
  home = join(base, "home"); data = join(base, "data");
  mkdirSync(join(home, ".local", "share"), { recursive: true });
  mkdirSync(join(base, "bigdisk", "morndo-data"), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(base, "bigdisk", "morndo-data", "morndo.db"), "HUB-DB");
  symlinkSync(join(base, "bigdisk", "morndo-data"), join(home, ".local", "share", "morndo"));   // a "*" entry is a link
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("confine on a linked '*' service directory", () => {
  it("denies the hub db by its real path, not only by the link path", () => {
    const real = realpathSync(join(home, ".local", "share", "morndo", "morndo.db"));
    const r = confine(real, { home, dataDir: data });
    expect(r).toEqual({ ok: false, reason: "denied" });
  });
});
