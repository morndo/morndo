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
  writeFileSync(join(state, "failstop"), "");
  writeFileSync(join(state, "spawnon"), "");               // "<unit stopped> <unit that then starts>": a timer firing between list and stop
  writeFileSync(join(state, "sticky"), "");                // units that stay active however often they are stopped
  writeFileSync(join(state, "activating"), "");            // units systemd lists as activating / auto-restart
  writeFileSync(fake, `#!/bin/sh
echo "$@ #$(cksum < '${dbPath}')" >> '${calls}'
case "$2" in
  list-units) for a in "$@"; do last=$a; done; case "$last" in *.service) pat='[.]service ' ;; *.timer) pat='[.]timer ' ;; *) pat='.' ;; esac
    { sed 's/$/ loaded active running x/' '${state}/active'; sed 's/$/ loaded activating auto-restart x/' '${state}/activating'; } | sed '/^ loaded/d' | grep -E "$pat"; exit 0 ;;
  is-active) grep -qx "$3" '${state}/active' && { echo active; exit 0; }; echo inactive; exit 3 ;;
  is-enabled) grep -qx "$3" '${state}/enabled' && { echo enabled; exit 0; }; echo disabled; exit 1 ;;
  restart) grep -qx "$3" '${state}/failrestart' && exit 1; exit 0 ;;
  stop) grep -qx "$3" '${state}/failstop' && exit 1
    if [ -s '${state}/spawnon' ] && [ "$(cut -d' ' -f1 '${state}/spawnon')" = "$3" ]; then cut -d' ' -f2 '${state}/spawnon' >> '${state}/active'; : > '${state}/spawnon'; fi
    grep -qx "$3" '${state}/sticky' && exit 0
    sed -i "/^$3\\$/d" '${state}/active' '${state}/activating'; exit 0 ;;
  daemon-reload) for t in $(grep '[.]timer$' '${state}/active'); do echo "TIMER-FIRED $t" >> '${calls}'; done; exit 0 ;;
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
  it("refuses (manual run) to put old code on a database whose schema changed since the backup, unless told --keep-data; --with-db is the other way", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    install(m);
    const d = new DatabaseSync(m.dbPath); d.exec("ALTER TABLE t ADD COLUMN extra TEXT;"); d.close();
    const r = sh(join(m.dest, "restore.sh"), [], m.env);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("--with-db");
    expect(r.stderr).toContain("--keep-data");
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

describe("round 2 of the review of PR 176", () => {
  const backup = (m: ReturnType<typeof machine>, extra: string[] = []) => sh(BACKUP, [m.dest, "--db", `node=${m.dbPath}`, ...extra], m.env);
  const exec = (path: string, sql: string) => { const d = new DatabaseSync(path); d.exec(sql); d.close(); };
  const refused = (m: ReturnType<typeof machine>) => {
    const r = sh(join(m.dest, "restore.sh"), [], m.env);
    expect(r.status).toBe(4);
    expect(readFileSync(join(m.units, "morndo-node.service"), "utf8")).toBe(NEW_UNIT);
  };

  it("sees a data-only migration: a user_version bump, a change of the _morndo_schema floor row", () => {
    const a = machine();
    expect(backup(a).status).toBe(0);
    install(a);
    exec(a.dbPath, "PRAGMA user_version = 7;");
    refused(a);
    const b = machine();
    exec(b.dbPath, "CREATE TABLE _morndo_schema (floor INTEGER); INSERT INTO _morndo_schema VALUES (1);");
    expect(backup(b).status).toBe(0);
    install(b);
    exec(b.dbPath, "UPDATE _morndo_schema SET floor = 3;");
    refused(b);
  });
  it("does not call ordinary new rows a schema change", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    install(m);
    expect(sh(join(m.dest, "restore.sh"), [], m.env).status).toBe(0);
  });

  it("the dead-man on a changed schema copies the current databases aside inside the backup folder, puts the backed-up ones back, and writes what it did", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    install(m);
    exec(m.dbPath, "ALTER TABLE t ADD COLUMN extra TEXT; INSERT INTO t (v) VALUES ('written-after-migration');");
    const r = sh(join(m.dest, "restore.sh"), ["--deadman"], m.env);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(m.units, "morndo-node.service"), "utf8")).toBe(OLD_UNIT);
    expect(rows(m.dbPath)).toEqual(["before-backup"]);
    const aside = readdirSync(m.dest, { recursive: true, encoding: "utf8" }).filter(f => f.endsWith(".db") && !f.startsWith("dbs/"));
    expect(aside.length).toBe(1);
    expect(rows(join(m.dest, aside[0]!))).toEqual(["before-backup", "after-backup", "written-after-migration"]);
    const report = readFileSync(join(m.dest, "deadman-report.txt"), "utf8");
    expect(report).toContain(aside[0]!.split("/")[0]!);
    expect(r.stderr).toContain("deadman-report.txt");
  });
  it("the dead-man with an unchanged schema leaves the databases alone and makes no copies", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    install(m);
    expect(sh(join(m.dest, "restore.sh"), ["--deadman"], m.env).status).toBe(0);
    expect(rows(m.dbPath)).toEqual(["before-backup", "after-backup"]);
    expect(readdirSync(m.dest, { recursive: true, encoding: "utf8" }).filter(f => f.endsWith(".db") && !f.startsWith("dbs/"))).toEqual([]);
  });

  it("puts every unit back to its recorded state: stops what was inactive, disables what was disabled", () => {
    const m = machine();
    writeFileSync(join(m.units, "morndo-fleet.service"), "[Service]\nExecStart=/bin/true\n");
    writeFileSync(join(m.units, "morndo-sweep.timer"), "[Timer]\nOnCalendar=daily\n");
    expect(backup(m).status).toBe(0);                      // fleet inactive, sweep disabled, node active
    install(m);
    writeFileSync(join(m.state, "active"), "morndo-node.service\nmorndo-fleet.service\n");
    writeFileSync(join(m.state, "enabled"), "morndo-sweep.timer\n");
    rmSync(m.calls, { force: true });
    expect(sh(join(m.dest, "restore.sh"), [], m.env).status).toBe(0);
    const calls = readFileSync(m.calls, "utf8");
    expect(calls).toContain("--user stop morndo-fleet.service");
    expect(calls).toContain("--user disable --now morndo-sweep.timer");
    expect(calls).not.toContain("restart morndo-fleet.service");
    expect(calls).not.toContain("enable --now morndo-sweep.timer");
    expect(calls).toContain("--user restart morndo-node.service");
  });

  it("--with-db: when a database copy fails, the service on it stays stopped, the run exits non-zero, and stderr says which database and what to do", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    install(m);
    rmSync(join(m.dest, "dbs/node.db"));
    rmSync(m.calls, { force: true });
    const r = sh(join(m.dest, "restore.sh"), ["--with-db"], m.env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("node");
    expect(r.stderr).toMatch(/stay[s]? stopped|left stopped/);
    const calls = readFileSync(m.calls, "utf8");
    expect(calls).toContain("--user stop morndo-node.service");
    expect(calls).not.toContain("--user restart morndo-node.service");
  });

  it("arm-deadman re-arming restarts the timer so the new time applies, and refuses while an ok marker exists", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    const env = { ...m.env, C6_NOW: "1800000000" };
    expect(sh(ARM, ["m1", m.dest], env).status).toBe(0);
    rmSync(m.calls, { force: true });
    const again = sh(ARM, ["m1", m.dest, "--seconds", "30"], env);
    expect(again.status, again.stderr).toBe(0);
    const calls = readFileSync(m.calls, "utf8");
    expect(calls).toContain("--user restart c6-deadman-m1.timer");
    expect(calls.indexOf("--user daemon-reload")).toBeLessThan(calls.indexOf("--user restart c6-deadman-m1.timer"));
    expect(readFileSync(join(m.units, "c6-deadman-m1.timer"), "utf8")).toContain("OnCalendar=2027-01-15 08:00:30");
    writeFileSync(join(m.dest, "ok"), "");
    rmSync(join(m.units, "c6-deadman-m1.timer"));
    const refusedArm = sh(ARM, ["m1", m.dest], env);
    expect(refusedArm.status).not.toBe(0);
    expect(refusedArm.stderr).toContain(join(m.dest, "ok"));
    expect(existsSync(join(m.units, "c6-deadman-m1.timer"))).toBe(false);
  });
});

describe("round 3 of the review of PR 176", () => {
  const backup = (m: ReturnType<typeof machine>, extra: string[] = []) => sh(BACKUP, [m.dest, "--db", `node=${m.dbPath}`, ...extra], m.env);
  const exec = (path: string, sql: string) => { const d = new DatabaseSync(path); d.exec(sql); d.close(); };
  const sum = (path: string) => spawnSync("cksum", { input: readFileSync(path), encoding: "utf8" }).stdout.trim();
  const unit = (m: ReturnType<typeof machine>, name: string, body = "[Service]\nExecStart=/bin/true\n") => writeFileSync(join(m.units, name), body);

  it("the signature ignores runtime rows of a migration-looking table (locks, last-run times) and counts only user_version and _morndo_schema", () => {
    const m = machine();
    exec(m.dbPath, "CREATE TABLE migration_locks (holder TEXT, at INTEGER); INSERT INTO migration_locks VALUES ('a', 1);");
    expect(backup(m).status).toBe(0);
    install(m);
    exec(m.dbPath, "INSERT INTO migration_locks VALUES ('b', 2); UPDATE migration_locks SET at = 9 WHERE holder = 'a';");
    expect(sh(join(m.dest, "restore.sh"), [], m.env).status).toBe(0);
  });

  it("a service recorded disabled that the install enabled is disabled again; one recorded enabled is enabled", () => {
    const m = machine();
    unit(m, "morndo-fleet.service");
    writeFileSync(join(m.state, "enabled"), "morndo-node.service\n");
    expect(backup(m).status).toBe(0);            // fleet: inactive, disabled; node: active, enabled
    install(m);
    writeFileSync(join(m.state, "enabled"), "morndo-fleet.service\n");
    rmSync(m.calls, { force: true });
    expect(sh(join(m.dest, "restore.sh"), [], m.env).status).toBe(0);
    const calls = readFileSync(m.calls, "utf8");
    expect(calls).toMatch(/--user disable( --now)? morndo-fleet\.service/);
    expect(calls).toMatch(/--user enable( --now)? morndo-node\.service/);
  });

  it("a timer put back on its schedule is restarted after enable --now, so a running timer takes the old schedule", () => {
    const m = machine();
    unit(m, "morndo-sweep.timer", "[Timer]\nOnCalendar=daily\n");
    writeFileSync(join(m.state, "enabled"), "morndo-sweep.timer\n");
    expect(backup(m).status).toBe(0);
    install(m);
    rmSync(m.calls, { force: true });
    expect(sh(join(m.dest, "restore.sh"), [], m.env).status).toBe(0);
    const calls = readFileSync(m.calls, "utf8");
    expect(calls.indexOf("--user restart morndo-sweep.timer")).toBeGreaterThan(calls.indexOf("--user enable --now morndo-sweep.timer"));
    expect(calls.indexOf("--user enable --now morndo-sweep.timer")).toBeGreaterThanOrEqual(0);
  });

  it("before a database is put back, every morndo service running now is stopped, whatever was recorded", () => {
    const m = machine();
    unit(m, "morndo-fleet.service");
    expect(backup(m).status).toBe(0);            // fleet recorded inactive
    install(m);
    writeFileSync(join(m.state, "active"), "morndo-node.service\nmorndo-fleet.service\nmorndo-newthing.service\n");
    const migrated = sum(m.dbPath);
    rmSync(m.calls, { force: true });
    expect(sh(join(m.dest, "restore.sh"), ["--with-db"], m.env).status).toBe(0);
    const lines = readFileSync(m.calls, "utf8").split("\n");
    const at = (needle: string) => lines.findIndex(l => l.includes(needle));
    for (const s of ["morndo-node.service", "morndo-fleet.service", "morndo-newthing.service"]) {
      const i = at(`--user stop ${s}`);
      expect(i, s).toBeGreaterThanOrEqual(0);
      expect(lines[i]).toContain(`#${migrated}`);               // the database was still the migrated one when this stop ran
    }
    const restart = lines.find(l => l.includes("--user restart morndo-node.service"))!;
    expect(restart).not.toContain(`#${migrated}`);                // and was the backed-up one when the unit started
  });

  it("the dead-man whose aside copy fails leaves that database alone, still puts the units back, exits non-zero, and says so in the report and on stderr", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    install(m);
    exec(m.dbPath, "ALTER TABLE t ADD COLUMN extra TEXT; INSERT INTO t (v) VALUES ('after-migration');");
    const wrapper = join(m.root, "node-fails-backup");
    writeFileSync(wrapper, `#!/bin/sh\n[ "$4" = backup ] && exit 1\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
    const r = sh(join(m.dest, "restore.sh"), ["--deadman"], { ...m.env, C6_NODE: wrapper });
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(m.units, "morndo-node.service"), "utf8")).toBe(OLD_UNIT);
    expect(rows(m.dbPath)).toContain("after-migration");
    const report = readFileSync(join(m.dest, "deadman-report.txt"), "utf8");
    expect(report).toContain("FAILED");
    expect(report).toContain("node");
    expect(r.stderr).toContain("FAILED");
  });

  it("a date or mkdir failure in the dead-man path still puts the units back, then exits non-zero with a report", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    install(m);
    exec(m.dbPath, "ALTER TABLE t ADD COLUMN extra TEXT;");
    const bin = join(m.root, "bad-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "date"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const r = sh(join(m.dest, "restore.sh"), ["--deadman"], { ...m.env, PATH: `${bin}:${process.env.PATH}` });
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(m.units, "morndo-node.service"), "utf8")).toBe(OLD_UNIT);
    expect(readFileSync(join(m.dest, "deadman-report.txt"), "utf8")).toContain("FAILED");
    expect(r.stderr).toContain("FAILED");
  });

  it("arm-deadman quotes the restore.sh path in the unit (a space is quoted, a % is doubled)", () => {
    const m = machine();
    const dest = join(m.root, "back up 5%");
    expect(sh(BACKUP, [dest, "--db", `node=${m.dbPath}`], m.env).status).toBe(0);
    const r = sh(ARM, ["m1", dest], { ...m.env, C6_NOW: "1800000000" });
    expect(r.status, r.stderr).toBe(0);
    const service = readFileSync(join(m.units, "c6-deadman-m1.service"), "utf8");
    expect(service).toContain(`ExecStart="${dest.replaceAll("%", "%%")}/restore.sh" --deadman`);
  });

  it("a service that will not stop keeps its database from being overwritten: the failure is named, the exit non-zero, the units still put back", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    install(m);
    writeFileSync(join(m.state, "failstop"), "morndo-node.service\n");
    const r = sh(join(m.dest, "restore.sh"), ["--with-db"], m.env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("FAILED");
    expect(r.stderr).toContain("morndo-node.service");
    expect(rows(m.dbPath)).toEqual(["before-backup", "after-backup"]);          // not overwritten while the service runs
    expect(readFileSync(join(m.units, "morndo-node.service"), "utf8")).toBe(OLD_UNIT);
  });
});

describe("round 4 of the review of PR 176", () => {
  const backup = (m: ReturnType<typeof machine>, extra: string[] = []) => sh(BACKUP, [m.dest, "--db", `node=${m.dbPath}`, ...extra], m.env);
  const unit = (m: ReturnType<typeof machine>, name: string, body = "[Service]\nExecStart=/bin/true\n") => writeFileSync(join(m.units, name), body);

  it("a backup copy of a database that fails quick_check is never put in place: the live database stays whole and its service stays stopped", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    install(m);
    writeFileSync(join(m.dest, "dbs/node.db"), "garbage that is not a database, long enough to look like a file ".repeat(100));
    rmSync(m.calls, { force: true });
    const r = sh(join(m.dest, "restore.sh"), ["--with-db"], m.env);
    expect(r.status).not.toBe(0);
    expect(rows(m.dbPath)).toEqual(["before-backup", "after-backup"]);
    expect(readdirSync(join(m.home)).filter(f => f.includes(".tmp") || f.includes("c6-restore"))).toEqual([]);   // no temp file left beside it
    expect(readFileSync(m.calls, "utf8")).not.toContain("--user restart morndo-node.service");
    expect(r.stderr).toContain("node");
  });

  it("stops the morndo timers before a database is touched (none fires in the window) and puts them back to the recorded state at the end", () => {
    const m = machine();
    unit(m, "morndo-sweep.timer", "[Timer]\nOnCalendar=daily\n");
    writeFileSync(join(m.state, "enabled"), "morndo-sweep.timer\n");
    writeFileSync(join(m.state, "active"), "morndo-node.service\nmorndo-sweep.timer\n");
    expect(backup(m).status).toBe(0);
    install(m);
    writeFileSync(join(m.state, "active"), "morndo-node.service\nmorndo-sweep.timer\n");
    rmSync(m.calls, { force: true });
    const r = sh(join(m.dest, "restore.sh"), ["--with-db"], m.env);
    expect(r.status, r.stderr).toBe(0);
    const calls = readFileSync(m.calls, "utf8");
    expect(calls).toContain("--user stop morndo-sweep.timer");
    expect(calls).not.toContain("TIMER-FIRED");
    expect(calls.lastIndexOf("--user enable --now morndo-sweep.timer")).toBeGreaterThan(calls.indexOf("--user stop morndo-sweep.timer"));
  });

  it("the unit set is every loaded morndo unit in an active-like state, template instances included: a service that is auto-restarting is stopped before the database, an instance is recorded and put back", () => {
    const m = machine();
    unit(m, "morndo-worker@.service");
    writeFileSync(join(m.state, "active"), "morndo-node.service\nmorndo-worker@a.service\n");
    expect(backup(m).status).toBe(0);
    expect(readFileSync(join(m.dest, "state.txt"), "utf8")).toContain("morndo-worker@a.service");
    install(m);
    writeFileSync(join(m.state, "active"), "morndo-node.service\nmorndo-worker@a.service\n");
    writeFileSync(join(m.state, "activating"), "morndo-flapping.service\n");
    rmSync(m.calls, { force: true });
    expect(sh(join(m.dest, "restore.sh"), ["--with-db"], m.env).status).toBe(0);
    const calls = readFileSync(m.calls, "utf8");
    expect(calls).toContain("--user stop morndo-flapping.service");
    expect(calls).toContain("--user stop morndo-worker@a.service");
    expect(calls.indexOf("--user restart morndo-worker@a.service")).toBeGreaterThan(calls.indexOf("--user stop morndo-worker@a.service"));
    expect(calls).not.toContain("restart morndo-flapping.service");
  });

  it("a unit file or wrapper that cannot be copied back is not removed first: the live file stays whole, its service is not started, the run exits non-zero", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    install(m);
    chmodSync(join(m.dest, "units/morndo-node.service"), 0o000);
    chmodSync(join(m.dest, "wrappers/morndo-node"), 0o000);
    rmSync(m.calls, { force: true });
    const r = sh(join(m.dest, "restore.sh"), [], m.env);
    chmodSync(join(m.dest, "units/morndo-node.service"), 0o644);
    chmodSync(join(m.dest, "wrappers/morndo-node"), 0o755);
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(m.units, "morndo-node.service"), "utf8")).toBe(NEW_UNIT);
    expect(lstatSync(join(m.bin, "morndo-node")).isSymbolicLink()).toBe(true);
    expect(readFileSync(m.calls, "utf8")).not.toContain("--user restart morndo-node.service");
    expect(r.stderr).toContain("morndo-node");
  });

  it("every dead-man exit leaves a line in a report file: a host mismatch writes it next to the folder and says where", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    install(m);
    const r = sh(join(m.dest, "restore.sh"), ["--deadman"], { ...m.env, C6_HOSTNAME: "host-b" });
    expect(r.status).toBe(3);
    const report = `${m.dest}.deadman-report.txt`;
    expect(readFileSync(report, "utf8")).toContain("host-a");
    expect(r.stderr).toContain(report);
    expect(readFileSync(join(m.units, "morndo-node.service"), "utf8")).toBe(NEW_UNIT);
  });

  it("the dead-man that finds the ok marker says so in the journal and in the report, and changes nothing", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    install(m);
    writeFileSync(join(m.dest, "ok"), "");
    const r = sh(join(m.dest, "restore.sh"), ["--deadman"], m.env);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/ok marker/);
    expect(readFileSync(join(m.dest, "deadman-report.txt"), "utf8")).toMatch(/ok marker/);
    expect(readFileSync(join(m.units, "morndo-node.service"), "utf8")).toBe(NEW_UNIT);
  });
});

describe("round 5 of the review of PR 176", () => {
  const exec = (path: string, sql: string) => { const d = new DatabaseSync(path); d.exec(sql); d.close(); };
  const backup = (m: ReturnType<typeof machine>, extra: string[] = []) => sh(BACKUP, [m.dest, "--db", `node=${m.dbPath}`, ...extra], m.env);
  const unit = (m: ReturnType<typeof machine>, name: string, body = "[Service]\nExecStart=/bin/true\n") => writeFileSync(join(m.units, name), body);
  const sum = (path: string) => spawnSync("cksum", { input: readFileSync(path), encoding: "utf8" }).stdout.trim();

  it("shellcheck finds nothing in backup.sh, arm-deadman.sh or the restore.sh the backup writes (no disables, no severity floor)", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    const files = [BACKUP, ARM, join(m.dest, "restore.sh")];
    const r = spawnSync("shellcheck", ["-s", "sh", "-S", "style", ...files], { encoding: "utf8" });
    expect(r.error, "shellcheck must be installed (ubuntu runners have it)").toBeUndefined();
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);
    for (const f of files) expect(readFileSync(f, "utf8")).not.toMatch(/shellcheck\s+disable/);
  });

  it("a blocked pattern of * (an unknown database) blocks every service, whatever file names the working directory holds", () => {
    const m = machine();
    const extra = join(m.home, "extra.db");
    exec(extra, "CREATE TABLE t (v TEXT);");
    expect(sh(BACKUP, [m.dest, "--db", `node=${m.dbPath}`, "--db", `extra=${extra}`], m.env).status).toBe(0);
    install(m);
    rmSync(join(m.dest, "dbs/extra.db"));
    const cwd = join(m.root, "cwd");
    mkdirSync(cwd);
    writeFileSync(join(cwd, "zzz-file"), "");
    rmSync(m.calls, { force: true });
    const r = spawnSync("sh", [join(m.dest, "restore.sh"), "--with-db"], { cwd, env: m.env, encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(readFileSync(m.calls, "utf8")).not.toContain("--user restart morndo-node.service");
  });

  it("sockets and path units that the restore stops are recorded and put back", () => {
    const m = machine();
    unit(m, "morndo-gate.socket", "[Socket]\nListenStream=/tmp/x\n");
    unit(m, "morndo-watch.path", "[Path]\nPathExists=/tmp/y\n");
    unit(m, "morndo-idle.socket", "[Socket]\nListenStream=/tmp/z\n");
    writeFileSync(join(m.state, "active"), "morndo-node.service\nmorndo-gate.socket\nmorndo-watch.path\n");
    expect(backup(m).status).toBe(0);
    const state = readFileSync(join(m.dest, "state.txt"), "utf8");
    expect(state).toContain("morndo-gate.socket");
    expect(state).toContain("morndo-watch.path");
    install(m);
    writeFileSync(join(m.state, "active"), "morndo-node.service\nmorndo-gate.socket\nmorndo-watch.path\nmorndo-idle.socket\n");
    rmSync(m.calls, { force: true });
    expect(sh(join(m.dest, "restore.sh"), ["--with-db"], m.env).status).toBe(0);
    const calls = readFileSync(m.calls, "utf8");
    for (const u of ["morndo-gate.socket", "morndo-watch.path", "morndo-idle.socket"]) expect(calls).toContain(`--user stop ${u}`);
    expect(calls.indexOf("--user restart morndo-gate.socket")).toBeGreaterThan(calls.indexOf("--user stop morndo-gate.socket"));
    expect(calls.indexOf("--user restart morndo-watch.path")).toBeGreaterThan(calls.indexOf("--user stop morndo-watch.path"));
    expect(calls).not.toContain("restart morndo-idle.socket");
  });

  it("stops, lists again, and stops again: a unit a timer started between the list and the stop is also stopped before the database", () => {
    const m = machine();
    unit(m, "morndo-sweep.timer", "[Timer]\nOnCalendar=daily\n");
    expect(backup(m).status).toBe(0);
    install(m);
    writeFileSync(join(m.state, "active"), "morndo-node.service\nmorndo-sweep.timer\n");
    writeFileSync(join(m.state, "spawnon"), "morndo-sweep.timer morndo-late.service\n");
    const migrated = sum(m.dbPath);
    rmSync(m.calls, { force: true });
    const r = sh(join(m.dest, "restore.sh"), ["--with-db"], m.env);
    expect(r.status, r.stderr).toBe(0);
    const line = readFileSync(m.calls, "utf8").split("\n").find(l => l.includes("--user stop morndo-late.service"));
    expect(line).toBeDefined();
    expect(line).toContain(`#${migrated}`);
    expect(rows(m.dbPath)).toEqual(["before-backup"]);
  });

  it("gives up on a unit that will not stay stopped after a bounded number of rounds: no database is overwritten, non-zero, a report line", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    install(m);
    writeFileSync(join(m.state, "sticky"), "morndo-node.service\n");
    const r = sh(join(m.dest, "restore.sh"), ["--with-db"], m.env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("FAILED");
    expect(r.stderr).toContain("morndo-node.service");
    expect(rows(m.dbPath)).toEqual(["before-backup", "after-backup"]);
  });

  it("the -wal and -shm are moved aside and put back when the rename fails, and deleted only after it worked", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    install(m);
    writeFileSync(`${m.dbPath}-wal`, "wal-bytes");
    writeFileSync(`${m.dbPath}-shm`, "shm-bytes");
    const bin = join(m.root, "bad-mv-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "mv"), `#!/bin/sh\nfor a in "$@"; do last=$a; done\ncase "$last" in *node.db) exit 1 ;; esac\nexec /bin/mv "$@"\n`, { mode: 0o755 });
    const failed = sh(join(m.dest, "restore.sh"), ["--with-db"], { ...m.env, PATH: `${bin}:${process.env.PATH}` });
    expect(failed.status).not.toBe(0);
    expect(readFileSync(`${m.dbPath}-wal`, "utf8")).toBe("wal-bytes");
    expect(readFileSync(`${m.dbPath}-shm`, "utf8")).toBe("shm-bytes");
    expect(rows(m.dbPath)).toEqual(["before-backup", "after-backup"]);
    const ok = sh(join(m.dest, "restore.sh"), ["--with-db"], m.env);
    expect(ok.status, ok.stderr).toBe(0);
    expect(existsSync(`${m.dbPath}-wal`)).toBe(false);
    expect(readdirSync(m.home).filter(f => f.includes("c6-"))).toEqual([]);
  });

  it("a destination that is a symlink to a directory is replaced, not entered", () => {
    const m = machine();
    expect(backup(m).status).toBe(0);
    install(m);
    const elsewhere = join(m.root, "elsewhere");
    mkdirSync(elsewhere);
    rmSync(join(m.bin, "morndo-node"));
    symlinkSync(elsewhere, join(m.bin, "morndo-node"));
    const r = sh(join(m.dest, "restore.sh"), [], m.env);
    expect(r.status, r.stderr).toBe(0);
    expect(lstatSync(join(m.bin, "morndo-node")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(m.bin, "morndo-node"), "utf8")).toContain("exec node old");
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});
