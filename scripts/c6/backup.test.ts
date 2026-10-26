// scripts/c6/backup.sh and arm-deadman.sh, run for real against a made-up HOME with a fake systemctl and a fake
// systemd-run, so no machine and no Docker is needed. The databases are made and read with node:sqlite.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const BACKUP = join(import.meta.dirname, "backup.sh");
const ARM = join(import.meta.dirname, "arm-deadman.sh");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const OLD_UNIT = "[Unit]\nDescription=old node\n[Service]\nExecStart=/h/node /h/morndo/releases/abc1234/apps/node-agent/src/main.ts run\nEnvironment=PATH=/x\n";
const NEW_UNIT = "# Morndo's own unit: every update rewrites it. Put changes in a drop-in (<unit>.d/*.conf).\n[Service]\nExecStart=%h/.local/bin/morndo-node run\n";

function machine() {
  const root = mkdtempSync(join(tmpdir(), "morndo-c6-"));
  dirs.push(root);
  const home = join(root, "home");
  const units = join(home, ".config/systemd/user");
  const bin = join(home, ".local/bin");
  mkdirSync(units, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(units, "morndo-node.service"), OLD_UNIT);
  mkdirSync(join(units, "morndo-node.service.d"));
  writeFileSync(join(units, "morndo-node.service.d/limits.conf"), "[Service]\nMemoryMax=1G\n");
  writeFileSync(join(units, "unrelated.service"), "[Service]\nExecStart=/bin/true\n");
  writeFileSync(join(bin, "morndo-node"), "#!/usr/bin/env bash\nexec node old \"$@\"\n", { mode: 0o755 });
  writeFileSync(join(bin, "other-tool"), "#!/bin/sh\n", { mode: 0o755 });
  const dbPath = join(home, "node.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('before-backup');");
  db.close();
  const calls = join(root, "systemctl-calls.txt");
  const fake = join(root, "fake-systemctl");
  writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${calls}'\n`, { mode: 0o755 });
  chmodSync(fake, 0o755);
  const env = { ...process.env, HOME: home, C6_SYSTEMCTL: fake, C6_NODE: process.execPath };
  return { root, home, units, bin, dbPath, calls, env, dest: join(root, "backup") };
}
const rows = (path: string) => { const d = new DatabaseSync(path, { readOnly: true }); try { return (d.prepare("SELECT v FROM t ORDER BY rowid").all() as { v: string }[]).map(r => r.v); } finally { d.close(); } };
const sh = (script: string, args: string[], env: NodeJS.ProcessEnv) => spawnSync("sh", [script, ...args], { env, encoding: "utf8" });

// The state after `morndo install` over the machine: new marked unit, the old kept aside, a launcher link, update units.
function install(m: ReturnType<typeof machine>) {
  writeFileSync(join(m.units, "morndo-node.service.before-morndo"), OLD_UNIT);
  writeFileSync(join(m.units, "morndo-node.service"), NEW_UNIT);
  writeFileSync(join(m.units, "morndo-update.timer"), "# Morndo's own unit\n[Timer]\n");
  rmSync(join(m.bin, "morndo-node"));
  symlinkSync("../share/morndo-releases/current/bin/morndo-node", join(m.bin, "morndo-node"));
  const db = new DatabaseSync(m.dbPath);
  db.exec("INSERT INTO t VALUES ('after-backup');");
  db.close();
}

describe("backup.sh", () => {
  it("writes units with drop-ins, wrappers, an online copy of each database, restore.sh and ROLLBACK.md", () => {
    const m = machine();
    const r = sh(BACKUP, [m.dest, "--db", `node=${m.dbPath}`], m.env);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(m.dest, "units/morndo-node.service"), "utf8")).toBe(OLD_UNIT);
    expect(readFileSync(join(m.dest, "units/morndo-node.service.d/limits.conf"), "utf8")).toContain("MemoryMax=1G");
    expect(existsSync(join(m.dest, "units/unrelated.service"))).toBe(false);
    expect(readFileSync(join(m.dest, "wrappers/morndo-node"), "utf8")).toContain("exec node old");
    expect(existsSync(join(m.dest, "wrappers/other-tool"))).toBe(false);
    expect(rows(join(m.dest, "dbs/node.db"))).toEqual(["before-backup"]);
    expect(lstatSync(join(m.dest, "restore.sh")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(m.dest, "ROLLBACK.md"), "utf8")).toContain("restore.sh");
  });
  it("refuses a backup folder that exists, and writes nothing into it", () => {
    const m = machine();
    mkdirSync(m.dest);
    const r = sh(BACKUP, [m.dest], m.env);
    expect(r.status).not.toBe(0);
    expect(readdirSync(m.dest)).toEqual([]);
  });
});

describe("restore.sh", () => {
  it("puts the old units, drop-ins and wrappers back, removes what the install added, reloads and restarts, and leaves the database alone", () => {
    const m = machine();
    expect(sh(BACKUP, [m.dest, "--db", `node=${m.dbPath}`], m.env).status).toBe(0);
    install(m);
    const r = sh(join(m.dest, "restore.sh"), [], m.env);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(m.units, "morndo-node.service"), "utf8")).toBe(OLD_UNIT);
    expect(existsSync(join(m.units, "morndo-node.service.before-morndo"))).toBe(false);
    expect(existsSync(join(m.units, "morndo-update.timer"))).toBe(false);
    expect(readFileSync(join(m.units, "morndo-node.service.d/limits.conf"), "utf8")).toContain("MemoryMax=1G");
    expect(readFileSync(join(m.units, "unrelated.service"), "utf8")).toContain("/bin/true");
    expect(lstatSync(join(m.bin, "morndo-node")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(m.bin, "morndo-node"), "utf8")).toContain("exec node old");
    expect(rows(m.dbPath)).toEqual(["before-backup", "after-backup"]);
    const calls = readFileSync(m.calls, "utf8");
    expect(calls).toContain("--user daemon-reload");
    expect(calls).toContain("--user restart morndo-node.service");
  });
  it("does nothing at all when the ok marker exists", () => {
    const m = machine();
    expect(sh(BACKUP, [m.dest], m.env).status).toBe(0);
    install(m);
    writeFileSync(join(m.dest, "ok"), "");
    const r = sh(join(m.dest, "restore.sh"), [], m.env);
    expect(r.status).toBe(0);
    expect(readFileSync(join(m.units, "morndo-node.service"), "utf8")).toBe(NEW_UNIT);
    expect(existsSync(join(m.units, "morndo-update.timer"))).toBe(true);
    expect(lstatSync(join(m.bin, "morndo-node")).isSymbolicLink()).toBe(true);
    expect(existsSync(m.calls)).toBe(false);
  });
  it("restores a database only when asked with --with-db", () => {
    const m = machine();
    expect(sh(BACKUP, [m.dest, "--db", `node=${m.dbPath}`], m.env).status).toBe(0);
    install(m);
    const r = sh(join(m.dest, "restore.sh"), ["--with-db"], m.env);
    expect(r.status, r.stderr).toBe(0);
    expect(rows(m.dbPath)).toEqual(["before-backup"]);
  });
});

describe("arm-deadman.sh", () => {
  function armed(extra: string[]) {
    const m = machine();
    const log = join(m.root, "run-calls.txt");
    const fake = join(m.root, "fake-systemd-run");
    writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > '${log}'\n`, { mode: 0o755 });
    chmodSync(fake, 0o755);
    const r = sh(ARM, ["m1", m.dest, ...extra], { ...m.env, C6_SYSTEMD_RUN: fake });
    return { r, args: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [], dest: m.dest };
  }
  it("arms a user timer for 60 minutes on the backup's restore.sh by default", () => {
    const { r, args, dest } = armed([]);
    expect(r.status, r.stderr).toBe(0);
    expect(args).toContain("--user");
    expect(args).toContain("--unit=c6-deadman-m1");
    expect(args).toContain("--on-active=60min");
    expect(args).toContain(join(dest, "restore.sh"));
  });
  it("takes seconds for a rehearsal", () => {
    expect(armed(["--seconds", "90"]).args).toContain("--on-active=90s");
  });
  it("refuses an unknown flag and arms nothing", () => {
    const { r, args } = armed(["--minutes", "5"]);
    expect(r.status).not.toBe(0);
    expect(args).toEqual([]);
  });
});
