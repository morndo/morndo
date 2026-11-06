// scripts/c6/dropins.sh, run for real against a made-up HOME: the drop-ins that set ExecStart are found, and taken out of
// the way (in place, after the backup holds them) so the unit the install writes is the one that starts.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const NOT_ROOT = typeof process.getuid === "function" && process.getuid() !== 0;   // root reads any file, so a test of an unreadable one is moot

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

function machine(extra: Record<string, string> = {}, o: { prefix?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), o.prefix ?? "morndo-c6-dropins-"));
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
  // systemd's own answer to `show -p DropInPaths`: the files of the folder and whatever the test adds (FAKE_PATHS)
  const fake = join(root, "fake-systemctl");
  writeFileSync(fake, `#!/bin/sh\nif [ -n "$FAKE_FAIL" ]; then exit 1; fi\nif [ "$1 $2 $3 $4 $5" = "--user show -p DropInPaths --value" ] && [ "$6" = "morndo-node.service" ]; then echo "$FAKE_PATHS"; fi\nexit 0\n`, { mode: 0o755 });
  return { root, home, units, folder, fake, outside: [] as string[] };
}

// A backup the way backup.sh makes it: the unit folders copied as they are under <backup>/units.
function backupOf(m: ReturnType<typeof machine>) {
  const bk = join(m.root, "backup");
  mkdirSync(join(bk, "units/morndo-node.service.d"), { recursive: true });
  for (const f of readdirSync(m.folder)) writeFileSync(join(bk, "units/morndo-node.service.d", f), readFileSync(join(m.folder, f)));
  return bk;
}

const run = (m: ReturnType<typeof machine>, ...args: string[]) => runWith(m, {}, ...args);
function runWith(m: ReturnType<typeof machine>, env: Record<string, string>, ...args: string[]) {
  const here = readdirSync(m.folder).filter(n => n.endsWith(".conf")).map(n => join(m.folder, n));
  const done = spawnSync("sh", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { HOME: m.home, PATH: process.env.PATH ?? "", C6_SYSTEMCTL: m.fake, FAKE_PATHS: [...here, ...m.outside].join(" "), ...env },
  });
  return { code: done.status, out: done.stdout, err: done.stderr };
}

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

describe("dropins.sh with an ExecStart over several lines", () => {
  it("takes the continuation lines out with it and leaves no fragment behind", () => {
    const text = "[Service]\nEnvironment=PATH=/x\nExecStart=\nExecStart=/h/node \\\n  --no-warnings \\\n  /h/main.ts run\nRestart=always\n";
    const m = machine({ "multi.conf": text });
    const bk = backupOf(m);
    expect(run(m, bk).code).toBe(0);
    expect(readFileSync(join(m.folder, "multi.conf"), "utf8")).toBe("[Service]\nEnvironment=PATH=/x\nRestart=always\n");
  });
});

describe("dropins.sh never hides an error", () => {
  it("stops, changing nothing and leaving no temporary file, when the rewrite itself fails", () => {
    const m = machine();
    const bk = backupOf(m);
    const bin = join(m.root, "bin");
    mkdirSync(bin);
    // an awk that does everything but the rewrite (the one program that has a `skip` in it)
    writeFileSync(join(bin, "awk"), `#!/bin/sh\ncase "$*" in *skip*) exit 2 ;; *) exec "${spawnSync("sh", ["-c", "command -v awk"], { encoding: "utf8" }).stdout.trim()}" "$@" ;; esac\n`, { mode: 0o755 });
    const r = runWith(m, { PATH: `${bin}:${process.env.PATH ?? ""}` }, bk);
    expect(r.code).toBe(2);
    expect(r.err).toContain("ship.conf");
    expect(readFileSync(join(m.folder, "ship.conf"), "utf8")).toBe(SHIP);
    expect(readdirSync(m.folder).sort()).toEqual(["limits.conf", "pre.conf", "ship.conf"]);
    expect(r.out).not.toContain("ExecStart taken out");
  });

  it.skipIf(!NOT_ROOT)("stops with a message naming a drop-in it cannot read, instead of calling it clean", () => {
    const m = machine();
    const bk = backupOf(m);
    chmodSync(join(m.folder, "pre.conf"), 0o000);
    for (const args of [["--list"], [bk]]) {
      const r = run(m, ...args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.err).toContain("pre.conf");
    }
    chmodSync(join(m.folder, "pre.conf"), 0o644);
    expect(readFileSync(join(m.folder, "ship.conf"), "utf8")).toBe(SHIP);
  });
});

describe("dropins.sh and the drop-ins it must leave alone or cannot back up", () => {
  it("leaves a job unit's drop-in out, as backup.sh does", () => {
    const m = machine();
    const jobDir = join(m.units, "morndo-job-x.service.d");
    mkdirSync(jobDir);
    writeFileSync(join(jobDir, "foo.conf"), "[Service]\nExecStart=/bin/true\n");
    const bk = backupOf(m);
    expect(run(m, "--list").out.trim().split("\n")).toEqual([join(m.folder, "ship.conf")]);
    expect(run(m, bk).code).toBe(0);
    expect(readFileSync(join(jobDir, "foo.conf"), "utf8")).toBe("[Service]\nExecStart=/bin/true\n");
  });

  it("lists a drop-in systemd reads from another place, and refuses to rewrite what the backup does not keep", () => {
    const m = machine();
    const elsewhere = join(m.root, "etc-systemd-user/morndo-node.service.d/ship.conf");
    mkdirSync(join(m.root, "etc-systemd-user/morndo-node.service.d"), { recursive: true });
    writeFileSync(elsewhere, SHIP);
    m.outside.push(elsewhere);
    const bk = backupOf(m);
    expect(run(m, "--list").out.trim().split("\n").sort()).toEqual([elsewhere, join(m.folder, "ship.conf")].sort());
    const r = run(m, bk);
    expect(r.code).toBe(4);
    expect(r.err).toContain(elsewhere);
    expect(readFileSync(join(m.folder, "ship.conf"), "utf8")).toBe(SHIP);
    expect(readFileSync(elsewhere, "utf8")).toBe(SHIP);
  });
});

describe("dropins.sh and systemd's own answers", () => {
  it("exits 2 when systemd cannot be asked, for the list and for the rewrite, instead of calling it clean", () => {
    const m = machine();
    const bk = backupOf(m);
    for (const args of [["--list"], [bk]]) {
      const r = runWith(m, { FAKE_FAIL: "1" }, ...args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.err).toContain("systemd");
    }
    expect(readFileSync(join(m.folder, "ship.conf"), "utf8")).toBe(SHIP);
  });

  it("does not split a path with a space, or expand a glob in it: the drop-in is found whole", () => {
    const m = machine();
    const odd = join(m.root, "etc *systemd user", "morndo-node.service.d");
    mkdirSync(odd, { recursive: true });
    writeFileSync(join(odd, "ship.conf"), SHIP);
    m.outside.push(join(odd, "ship.conf"));
    const bk = backupOf(m);
    expect(run(m, "--list").out.trim().split("\n").sort()).toEqual([join(odd, "ship.conf"), join(m.folder, "ship.conf")].sort());
    const r = run(m, bk);
    expect(r.code).toBe(4);
    expect(r.err).toContain(join(odd, "ship.conf"));
  });

  it("finds the user config folder through XDG_CONFIG_HOME, and through a HOME that is a symlink", () => {
    const m = machine();
    const link = join(m.root, "link-home");
    symlinkSync(m.home, link);
    const viaLink = spawnSync("sh", [SCRIPT, "--list"], {
      encoding: "utf8",
      env: { HOME: link, PATH: process.env.PATH ?? "", C6_SYSTEMCTL: m.fake, FAKE_PATHS: join(m.folder, "ship.conf") },   // systemd answers with real paths
    });
    expect(viaLink.status, viaLink.stderr).toBe(0);
    expect(viaLink.stdout.trim()).toBe(join(m.folder, "ship.conf"));
    const bk = backupOf(m);
    const xdg = mkdtempSync(join(tmpdir(), "morndo-c6-xdg-"));
    dirs.push(xdg);
    mkdirSync(join(xdg, "systemd/user/morndo-node.service.d"), { recursive: true });
    writeFileSync(join(xdg, "systemd/user/morndo-node.service.d/ship.conf"), SHIP);
    mkdirSync(join(bk, "units/morndo-node.service.d"), { recursive: true });
    const viaXdg = spawnSync("sh", [SCRIPT, bk], {
      encoding: "utf8",
      env: { HOME: m.home, XDG_CONFIG_HOME: xdg, PATH: process.env.PATH ?? "", C6_SYSTEMCTL: m.fake, FAKE_PATHS: join(xdg, "systemd/user/morndo-node.service.d/ship.conf") },
    });
    expect(viaXdg.status, viaXdg.stderr).toBe(0);        // inside the user config folder: backed up as units/<name>.d/ship.conf, which backupOf() put there
    expect(readFileSync(join(xdg, "systemd/user/morndo-node.service.d/ship.conf"), "utf8")).not.toContain("ExecStart");
  });
});

describe("dropins.sh with a comment inside a continued ExecStart", () => {
  it("skips the comment line as systemd does and takes the rest of the command out too", () => {
    const text = "[Service]\nEnvironment=PATH=/x\nExecStart=/h/node \\\n# a note\n; another\n  /h/main.ts run\nRestart=always\n";
    const m = machine({ "comment.conf": text });
    const bk = backupOf(m);
    expect(run(m, bk).code).toBe(0);
    expect(readFileSync(join(m.folder, "comment.conf"), "utf8")).toBe("[Service]\nEnvironment=PATH=/x\nRestart=always\n");
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
    expect(readFileSync(SCRIPT, "utf8")).toMatch(/^#!\/bin\/sh\n[\s\S]*\nset -eu\n/);
  });
});
