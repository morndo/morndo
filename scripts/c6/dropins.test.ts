// scripts/c6/dropins.sh, run for real against a made-up HOME: the drop-ins that set ExecStart are found, and taken out of
// the way (in place, after the backup holds them) so the unit the install writes is the one that starts.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "dropins.sh");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const SHIP = [
  "# Ship abc1234: the release tool's drop-in.",
  "[Service]",
  "Environment=PATH=%h/.local/bin:/usr/bin",
  "ExecStart=",
  "ExecStart=%h/node %h/product/live-ship-abc1234/apps/node-agent/src/main.ts run",
  "",
].join("\n");
const LIMITS = "[Service]\nMemoryMax=1G\n";
const PRE = "[Service]\nExecStartPre=/bin/true\n";

function machine(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "morndo-c6-dropins-"));
  dirs.push(root);
  const home = join(root, "home");
  const units = join(home, ".config/systemd/user");
  const folder = join(units, "morndo-node.service.d");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "ship.conf"), SHIP, { mode: 0o640 });
  writeFileSync(join(folder, "limits.conf"), LIMITS);
  writeFileSync(join(folder, "pre.conf"), PRE);
  mkdirSync(join(units, "other.service.d"));
  writeFileSync(join(units, "other.service.d/ship.conf"), SHIP);          // not one of ours
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(folder, name), text);
  return { root, home, units, folder };
}

// A backup the way backup.sh makes it: the unit folders copied as they are under <backup>/units.
function backupOf(m: ReturnType<typeof machine>) {
  const bk = join(m.root, "backup");
  mkdirSync(join(bk, "units/morndo-node.service.d"), { recursive: true });
  for (const f of readdirSync(m.folder)) writeFileSync(join(bk, "units/morndo-node.service.d", f), readFileSync(join(m.folder, f)));
  return bk;
}

const run = (m: ReturnType<typeof machine>, ...args: string[]) => {
  const done = spawnSync("sh", [SCRIPT, ...args], { encoding: "utf8", env: { HOME: m.home, PATH: process.env.PATH ?? "" } });
  return { code: done.status, out: done.stdout, err: done.stderr };
};

describe("dropins.sh --list", () => {
  it("names the drop-ins of our units that set ExecStart, and no others", () => {
    const m = machine();
    const r = run(m, "--list");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toEqual([join(m.folder, "ship.conf")]);   // not limits.conf, not ExecStartPre alone, not another unit's
  });

  it("prints nothing when no drop-in sets it", () => {
    const m = machine();
    rmSync(join(m.folder, "ship.conf"));
    const r = run(m, "--list");
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
  });
});

describe("dropins.sh <backup>", () => {
  it("takes the ExecStart lines out in place and keeps every other line, comments and PATH included", () => {
    const m = machine();
    const bk = backupOf(m);
    const r = run(m, bk);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(join(m.folder, "ship.conf"));
    const after = readFileSync(join(m.folder, "ship.conf"), "utf8");
    expect(after).toBe("# Ship abc1234: the release tool's drop-in.\n[Service]\nEnvironment=PATH=%h/.local/bin:/usr/bin\n");
    expect(statSync(join(m.folder, "ship.conf")).mode & 0o777).toBe(0o640);
    expect(readFileSync(join(m.folder, "limits.conf"), "utf8")).toBe(LIMITS);
    expect(readFileSync(join(m.folder, "pre.conf"), "utf8")).toBe(PRE);
    expect(readFileSync(join(m.units, "other.service.d/ship.conf"), "utf8")).toBe(SHIP);
    expect(readdirSync(m.folder).sort()).toEqual(["limits.conf", "pre.conf", "ship.conf"]);   // no temp file left
    expect(readFileSync(join(bk, "units/morndo-node.service.d/ship.conf"), "utf8")).toBe(SHIP);   // the backup keeps the original
  });

  it("refuses, changing nothing, when the backup does not hold the drop-in exactly as it is", () => {
    const m = machine();
    const bk = backupOf(m);
    writeFileSync(join(bk, "units/morndo-node.service.d/ship.conf"), `${SHIP}# edited since\n`);
    const r = run(m, bk);
    expect(r.code).toBe(3);
    expect(r.err).toContain("ship.conf");
    expect(readFileSync(join(m.folder, "ship.conf"), "utf8")).toBe(SHIP);
    rmSync(join(bk, "units/morndo-node.service.d/ship.conf"));
    expect(run(m, bk).code).toBe(3);
    expect(readFileSync(join(m.folder, "ship.conf"), "utf8")).toBe(SHIP);
  });

  it("changes nothing at all when one of two drop-ins is not backed up", () => {
    const m = machine({ "second.conf": "[Service]\nExecStart=/bin/true\n" });
    const bk = backupOf(m);
    rmSync(join(bk, "units/morndo-node.service.d/second.conf"));
    expect(run(m, bk).code).toBe(3);
    expect(readFileSync(join(m.folder, "ship.conf"), "utf8")).toBe(SHIP);
    expect(readFileSync(join(m.folder, "second.conf"), "utf8")).toBe("[Service]\nExecStart=/bin/true\n");
  });

  it("is a no-op the second time, and when there is nothing to take out", () => {
    const m = machine();
    const bk = backupOf(m);
    expect(run(m, bk).code).toBe(0);
    const once = readFileSync(join(m.folder, "ship.conf"), "utf8");
    const again = run(m, bk);
    expect(again.code).toBe(0);
    expect(again.out).toContain("no drop-in sets ExecStart");
    expect(readFileSync(join(m.folder, "ship.conf"), "utf8")).toBe(once);
  });
});

describe("dropins.sh usage", () => {
  it("wants exactly one argument: --list or a backup folder that exists", () => {
    const m = machine();
    expect(run(m).code).toBe(2);
    expect(run(m, "a", "b").code).toBe(2);
    expect(run(m, join(m.root, "no-such-backup")).code).toBe(2);
    expect(readFileSync(join(m.folder, "ship.conf"), "utf8")).toBe(SHIP);
  });
});

describe("dropins.sh style", () => {
  it("shellcheck finds nothing (no disables, no severity floor)", () => {
    const r = spawnSync("shellcheck", ["-s", "sh", "-S", "style", SCRIPT], { encoding: "utf8" });
    expect(r.error, "shellcheck must be installed (ubuntu runners have it)").toBeUndefined();
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);
  });
  it("is a plain sh script with set -eu", () => {
    expect(existsSync(SCRIPT)).toBe(true);
    chmodSync(SCRIPT, statSync(SCRIPT).mode);
    expect(readFileSync(SCRIPT, "utf8")).toMatch(/^#!\/bin\/sh\n[\s\S]*\nset -eu\n/);
  });
});
