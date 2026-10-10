// V25: the hub's legacy file store opens the file it judged, not whatever the path names a moment later.
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { denyRoots } from "@morndo/node-ops";
import { fileStore } from "../src/adapters/files.ts";

const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
const realStat = fsp.stat;
let afterStat: (() => void) | null = null;
let root: string, home: string, data: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "morndo-files-swap-")));
  home = join(root, "home"); data = join(root, "data");
  for (const d of [join(home, ".config", "gh"), join(home, "proj", "a"), data]) mkdirSync(d, { recursive: true });
  // The hook runs once, right after register()'s own stat has judged the file, standing in for another process winning the race.
  (fsp as { stat: unknown }).stat = async (...a: Parameters<typeof realStat>) => { const r = await realStat(...a); const f = afterStat; afterStat = null; f?.(); return r; };
  syncBuiltinESMExports();
});
afterEach(() => { (fsp as { stat: unknown }).stat = realStat; syncBuiltinESMExports(); afterStat = null; rmSync(root, { recursive: true, force: true }); });

describe("fileStore.register: a path swapped after it was judged (negative control: the swap)", () => {
  it("refuses a parent directory swapped for a link into a denied root, and copies nothing", async () => {
    writeFileSync(join(home, ".config", "gh", "hosts.yml"), "oauth_token: gho_synthetic\n");
    writeFileSync(join(home, "proj", "a", "hosts.yml"), "benign: true\n");
    const files = fileStore({ dir: join(data, "files"), deny: denyRoots(home, data) });
    afterStat = () => { renameSync(join(home, "proj", "a"), join(home, "proj", "a.moved")); symlinkSync(join(home, ".config", "gh"), join(home, "proj", "a")); };
    const r = await files.register(join(home, "proj", "a", "hosts.yml"));
    expect(r.id).toBeNull();
  });
  it("control: with no swap the same path is copied", async () => {
    writeFileSync(join(home, "proj", "a", "hosts.yml"), "benign: true\n");
    const files = fileStore({ dir: join(data, "files"), deny: denyRoots(home, data) });
    const r = await files.register(join(home, "proj", "a", "hosts.yml"));
    expect(r.id).toMatch(/^[0-9a-f]{32}$/);
    expect(readFileSync(files.get(r.id ?? "")?.file ?? "", "utf8")).toBe("benign: true\n");
  });
});
