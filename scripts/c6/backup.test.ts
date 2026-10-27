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
  const state = join(root, "fake-state");                  // active / enabled / failrestart: one unit name per line
  mkdirSync(state);
  writeFileSync(join(state, "active"), "morndo-node.service\n");
  writeFileSync(join(state, "enabled"), "");
  writeFileSync(join(state, "failrestart"), "");
  writeFileSync(fake, `#!/bin/sh
echo "$@" >> '${calls}'
case "$2" in
  is-active) grep -qx "$3" '${state}/active' && { echo active; exit 0; }; echo inactive; exit 3 ;;
  is-enabled) grep -qx "$3" '${state}/enabled' && { echo enabled; exit 0; }; echo disabled; exit 1 ;;
  restart) grep -qx "$3" '${state}/failrestart' && exit 1; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
  chmodSync(fake, 0o755);
  const env = { ...process.env, HOME: home, TZ: "UTC", C6_SYSTEMCTL: fake, C6_NODE: process.execPath, C6_HOSTNAME: "host-a" };
  return { root, home, units, bin, dbPath, calls, state, env, dest: join(root, "backup") };
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
    const r = sh(BACKUP, [m.dest, "--db", `node=${m.dbPath}`], m.env);
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
  it("does nothing at all, run as the dead-man (--deadman), when the ok marker exists", () => {
    const m = machine();
    expect(sh(BACKUP, [m.dest, "--db", `node=${m.dbPath}`], m.env).status).toBe(0);
    install(m);
    rmSync(m.calls, { force: true });                 // backup.sh asked is-active; the dead-man must call nothing
    writeFileSync(join(m.dest, "ok"), "");
    const r = sh(join(m.dest, "restore.sh"), ["--deadman"], m.env);
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
  const NOW = "1800000000";                                  // 2027-01-15 08:00:00 UTC
  function arm(m: ReturnType<typeof machine>, extra: string[] = [], env: NodeJS.ProcessEnv = {}) {
    return sh(ARM, ["m1", m.dest, ...extra], { ...m.env, C6_NOW: NOW, ...env });
  }
  const backedUp = () => { const m = machine(); expect(sh(BACKUP, [m.dest, "--db", `node=${m.dbPath}`], m.env).status).toBe(0); return m; };

  it("writes a persistent timer and its service under ~/.config/systemd/user (a reboot or a manager restart keeps it), 60 minutes out by default", () => {
    const m = backedUp();
    const r = arm(m);
    expect(r.status, r.stderr).toBe(0);
    const timer = readFileSync(join(m.units, "c6-deadman-m1.timer"), "utf8");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("OnCalendar=2027-01-15 09:00:00");
    expect(timer).toMatch(/WantedBy=timers\.target/);
    const service = readFileSync(join(m.units, "c6-deadman-m1.service"), "utf8");
    expect(service).toContain("Type=oneshot");
    expect(service).toContain(`ExecStart=${join(m.dest, "restore.sh")} --deadman`);
    const calls = readFileSync(m.calls, "utf8");
    expect(calls).toContain("--user daemon-reload");
    expect(calls).toContain("--user enable --now c6-deadman-m1.timer");
  });
  it("takes seconds for a rehearsal", () => {
    const m = backedUp();
    expect(arm(m, ["--seconds", "90"]).status).toBe(0);
    expect(readFileSync(join(m.units, "c6-deadman-m1.timer"), "utf8")).toContain("OnCalendar=2027-01-15 08:01:30");
  });
  it("refuses an unknown flag and arms nothing", () => {
    const m = backedUp();
    expect(arm(m, ["--minutes", "5"]).status).not.toBe(0);
    expect(existsSync(join(m.units, "c6-deadman-m1.timer"))).toBe(false);
  });
  it("refuses a backup made on another machine or under another HOME, and arms nothing", () => {
    const m = backedUp();
    const other = arm(m, [], { C6_HOSTNAME: "host-b" });
    expect(other.status).not.toBe(0);
    expect(other.stderr).toContain("host-a");
    expect(existsSync(join(m.units, "c6-deadman-m1.timer"))).toBe(false);
    const home2 = join(m.root, "home2");
    mkdirSync(join(home2, ".config/systemd/user"), { recursive: true });
    expect(arm(m, [], { HOME: home2 }).status).not.toBe(0);
    expect(existsSync(join(home2, ".config/systemd/user/c6-deadman-m1.timer"))).toBe(false);
  });
  it("refuses a missing or non-executable restore.sh, and takes a relative folder as an absolute one", () => {
    const m = backedUp();
    chmodSync(join(m.dest, "restore.sh"), 0o644);
    expect(arm(m).status).not.toBe(0);
    expect(existsSync(join(m.units, "c6-deadman-m1.timer"))).toBe(false);
    chmodSync(join(m.dest, "restore.sh"), 0o755);
    const r = spawnSync("sh", [ARM, "m1", "backup"], { cwd: m.root, env: { ...m.env, C6_NOW: NOW }, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(m.units, "c6-deadman-m1.service"), "utf8")).toContain(`ExecStart=${join(m.dest, "restore.sh")} --deadman`);
  });
  it("--disarm removes the timer and the service and reloads, and leaves the ok marker alone", () => {
    const m = backedUp();
    expect(arm(m).status).toBe(0);
    const r = sh(ARM, ["--disarm", "m1"], m.env);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(m.units, "c6-deadman-m1.timer"))).toBe(false);
    expect(existsSync(join(m.units, "c6-deadman-m1.service"))).toBe(false);
    expect(readFileSync(m.calls, "utf8")).toContain("--user disable --now c6-deadman-m1.timer");
    expect(existsSync(join(m.dest, "ok"))).toBe(false);
  });
  it("the restore survives the switch's own units (a restore never removes c6-deadman-*)", () => {
    const m = backedUp();
    expect(arm(m).status).toBe(0);
    install(m);
    expect(sh(join(m.dest, "restore.sh"), ["--deadman"], m.env).status).toBe(0);
    expect(existsSync(join(m.units, "c6-deadman-m1.service"))).toBe(true);
  });
});

describe("the rest of what the review of PR 176 found", () => {
  const backup = (m: ReturnType<typeof machine>, extra: string[] = []) => sh(BACKUP, [m.dest, "--db", `node=${m.dbPath}`, ...extra], m.env);

  it("records the host and HOME, and restore.sh refuses any other host or HOME before it changes anything", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    const record = readFileSync(join(m.dest, "machine.txt"), "utf8");
    expect(record).toContain("host=host-a");
    expect(record).toContain(`home=${m.home}`);
    install(m);
    for (const env of [{ C6_HOSTNAME: "host-b" }, { HOME: join(m.root, "elsewhere") }]) {
      const r = sh(join(m.dest, "restore.sh"), [], { ...m.env, ...env });
      expect(r.status).toBe(3);
      expect(r.stderr).toContain("host-a");
      expect(readFileSync(join(m.units, "morndo-node.service"), "utf8")).toBe(NEW_UNIT);
    }
  });
  it("also refuses as the dead-man on another host (the ok marker is checked first, the guard second)", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    install(m);
    expect(sh(join(m.dest, "restore.sh"), ["--deadman"], { ...m.env, C6_HOSTNAME: "host-b" }).status).toBe(3);
    expect(readFileSync(join(m.units, "morndo-node.service"), "utf8")).toBe(NEW_UNIT);
  });
  it("a stale ok marker does not silence a manual restore; it is said, and the restore runs", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    install(m);
    writeFileSync(join(m.dest, "ok"), "");
    const r = sh(join(m.dest, "restore.sh"), [], m.env);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("ok");
    expect(readFileSync(join(m.units, "morndo-node.service"), "utf8")).toBe(OLD_UNIT);
    expect(readFileSync(join(m.dest, "ROLLBACK.md"), "utf8")).toMatch(/ok.*(manual|ignored|stale)/is);
  });
  it("removes the launcher links the install added to ~/.local/bin, and keeps a file somebody else added", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    install(m);
    symlinkSync("../share/morndo-releases/current/bin/morndo-fleet", join(m.bin, "morndo-fleet"));
    writeFileSync(join(m.bin, "morndo-extra"), "#!/bin/sh\n", { mode: 0o755 });
    expect(sh(join(m.dest, "restore.sh"), [], m.env).status).toBe(0);
    expect(existsSync(join(m.bin, "morndo-fleet"))).toBe(false);
    expect(lstatSync(join(m.bin, "morndo-fleet"), { throwIfNoEntry: false })).toBeUndefined();
    expect(existsSync(join(m.bin, "morndo-extra"))).toBe(true);
  });
  it("restarts only the services that were active at backup time, and re-enables the timers that were enabled", () => {
    const m = machine();
    writeFileSync(join(m.units, "morndo-fleet.service"), "[Service]\nExecStart=/bin/true\n");
    writeFileSync(join(m.units, "morndo-sweep.timer"), "[Timer]\nOnCalendar=daily\n");
    writeFileSync(join(m.state, "enabled"), "morndo-sweep.timer\n");
    expect(backup(m).status).toBe(0);
    install(m);
    rmSync(m.calls, { force: true });
    expect(sh(join(m.dest, "restore.sh"), [], m.env).status).toBe(0);
    const calls = readFileSync(m.calls, "utf8");
    expect(calls).toContain("--user restart morndo-node.service");
    expect(calls).not.toContain("restart morndo-fleet.service");
    expect(calls).toContain("--user enable --now morndo-sweep.timer");
  });
  it("tries every restart even when one fails, then exits non-zero naming it", () => {
    const m = machine();
    writeFileSync(join(m.units, "morndo-hub.service"), "[Service]\nExecStart=/bin/true\n");
    writeFileSync(join(m.state, "active"), "morndo-hub.service\nmorndo-node.service\n");
    writeFileSync(join(m.state, "failrestart"), "morndo-hub.service\n");
    expect(backup(m).status).toBe(0);
    install(m);
    rmSync(m.calls, { force: true });
    const r = sh(join(m.dest, "restore.sh"), [], m.env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("morndo-hub.service");
    expect(readFileSync(m.calls, "utf8")).toContain("--user restart morndo-node.service");
  });
  it("finds the machine's own databases without --db, and refuses a database it finds but was not told about", () => {
    const m = machine();
    const hub = join(m.home, ".local/share/morndo/morndo.db");
    mkdirSync(join(m.home, ".local/share/morndo"), { recursive: true });
    const d = new DatabaseSync(hub); d.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('hub-row');"); d.close();
    const found = sh(BACKUP, [m.dest], m.env);
    expect(found.status, found.stderr).toBe(0);
    expect(rows(join(m.dest, "dbs/hub.db"))).toEqual(["hub-row"]);
    const m2 = machine();
    mkdirSync(join(m2.home, ".local/state/morndo-extra"), { recursive: true });
    const stray = new DatabaseSync(join(m2.home, ".local/state/morndo-extra/other.db")); stray.exec("CREATE TABLE t (v TEXT);"); stray.close();
    const refused = backup(m2);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("other.db");
    expect(existsSync(m2.dest)).toBe(false);
    expect(backup(m2, ["--allow-unlisted"]).status).toBe(0);
  });
  it("refuses a backup with no database at all unless told --no-db", () => {
    const m = machine();
    const none = sh(BACKUP, [m.dest], m.env);
    expect(none.status).not.toBe(0);
    expect(existsSync(m.dest)).toBe(false);
    expect(sh(BACKUP, [m.dest, "--no-db"], m.env).status).toBe(0);
  });
  it("leaves nothing behind when node is missing or a database copy fails", () => {
    const m = machine();
    expect(sh(BACKUP, [m.dest, "--db", `node=${m.dbPath}`], { ...m.env, C6_NODE: join(m.root, "no-such-node") }).status).not.toBe(0);
    expect(existsSync(m.dest)).toBe(false);
    const bad = join(m.home, "not-a-db.db");
    writeFileSync(bad, "this is not a database");
    expect(sh(BACKUP, [m.dest, "--db", `bad=${bad}`], m.env).status).not.toBe(0);
    expect(existsSync(m.dest)).toBe(false);
  });
  it("refuses to put old code on a database whose schema changed since the backup, unless told --keep-data; --with-db is the other way", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    install(m);
    const d = new DatabaseSync(m.dbPath); d.exec("ALTER TABLE t ADD COLUMN extra TEXT;"); d.close();
    const r = sh(join(m.dest, "restore.sh"), [], m.env);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("--with-db");
    expect(r.stderr).toContain("--keep-data");
    expect(readFileSync(join(m.units, "morndo-node.service"), "utf8")).toBe(NEW_UNIT);
    const dead = sh(join(m.dest, "restore.sh"), ["--deadman"], m.env);
    expect(dead.status).toBe(4);
    expect(readFileSync(join(m.units, "morndo-node.service"), "utf8")).toBe(NEW_UNIT);
    const kept = sh(join(m.dest, "restore.sh"), ["--keep-data"], m.env);
    expect(kept.status, kept.stderr).toBe(0);
    expect(readFileSync(join(m.units, "morndo-node.service"), "utf8")).toBe(OLD_UNIT);
  });
  it("ROLLBACK.md says plainly when --with-db is needed", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    expect(readFileSync(join(m.dest, "ROLLBACK.md"), "utf8")).toMatch(/migrat/i);
  });
});
