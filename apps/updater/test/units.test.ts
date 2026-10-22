// The unit templates every Version ships (design §5): the systemd files parse as unit files, name only the
// specifiers the design settled on (%h the home, %S the state directory, %i the instance — systemd.unit(5),
// systemd 255, the design's source U18), run every program through ~/.local/bin (the launchers that resolve
// `current` once), and keep the rules §5 states: 78 never restarts, the boot unit applies before the services,
// recovery runs only while the applying mark exists, one apply is nobody's child. systemd-analyze, where the
// machine has it, is the syntax gate over a copy with a real ExecStart binary.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const UNITS = join(import.meta.dirname, "../units");

const SYSTEMD = [
  "morndo-hub.service", "morndo-fleet.service", "morndo-node.service",
  "morndo-update.service", "morndo-update.timer",
  "morndo-update-boot.service",
  "morndo-update-recover.service", "morndo-update-recover.timer",
  "morndo-update-apply@.service",
] as const;
const LAUNCHD = [
  "com.morndo.hub.plist", "com.morndo.fleet.plist", "com.morndo.node.plist",
  "com.morndo.update.plist", "com.morndo.update-recover.plist",
] as const;

// A unit file is INI (systemd.unit(5)): bracketed sections, `key=value` lines, `#` or `;` comments. Anything
// else — a stray word, a key twice — is refused here, before systemd has to guess at boot time.
const readIni = (text: string): { sections: string[]; entries: Record<string, string> } => {
  const sections: string[] = [];
  const entries: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) { sections.push(section[1]!); continue; }
    const entry = /^([A-Za-z][\w-]*)=(.*)$/.exec(line);
    if (entry === null) throw new Error(`not a unit line: ${JSON.stringify(raw)}`);
    if (entry[1]! in entries) throw new Error(`key twice: ${entry[1]}`);
    entries[entry[1]!] = entry[2]!;
  }
  if (sections.length === 0) throw new Error("no section at all");
  return { sections, entries };
};

const made: string[] = [];
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

describe("the unit templates every Version ships (§5)", () => {
  it("holds exactly the templates the design names, the launchd ones under launchd/", () => {
    const names = (dir: string, prefix = ""): string[] =>
      readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? names(dir, `${prefix}${e.name}/`) : [`${prefix}${e.name}`]);
    expect(names(UNITS).sort()).toEqual([...SYSTEMD, ...LAUNCHD.map(n => `launchd/${n}`)].sort());
  });

  it("every systemd template parses, names only %h %S %i, and execs through ~/.local/bin", () => {
    for (const name of SYSTEMD) {
      const text = readFileSync(join(UNITS, name), "utf8");
      const ini = readIni(text);                       // parses or throws: no syntax error survives this
      expect(ini.sections.length, name).toBeGreaterThan(0);
      for (const [, spec] of text.matchAll(/%([a-zA-Z%])/g)) {
        expect(["h", "S", "i", "%"], `${name}: %${spec}`).toContain(spec!);
      }
      for (const [key, value] of Object.entries(ini.entries)) {
        // recovery alone runs from `good` (§6.6): `current`, which ~/.local/bin links through, may be the broken one
        const via = name === "morndo-update-recover.service" ? "%h/.local/share/morndo-releases/good/bin/" : "%h/.local/bin/";
        if (key === "ExecStart") expect(value.startsWith(via), `${name}: ${value}`).toBe(true);
      }
    }
  });

  it("the three services restart on failure, every 5 s, never on a setup to fix (78)", () => {
    for (const name of ["morndo-hub.service", "morndo-fleet.service", "morndo-node.service"] as const) {
      const { entries } = readIni(readFileSync(join(UNITS, name), "utf8"));
      expect(entries, name).toMatchObject({
        Restart: "on-failure",
        RestartSec: "5",
        RestartPreventExitStatus: "78",
        WantedBy: "default.target",
      });
    }
  });

  it("the tick is a oneshot behind a six-hour timer with an hour of spread", () => {
    expect(readIni(readFileSync(join(UNITS, "morndo-update.service"), "utf8")).entries).toMatchObject({
      Type: "oneshot",
      ExecStart: "%h/.local/bin/morndo-update update tick",
    });
    expect(readIni(readFileSync(join(UNITS, "morndo-update.timer"), "utf8")).entries).toMatchObject({
      OnBootSec: "5min",
      OnUnitActiveSec: "6h",
      RandomizedDelaySec: "1h",
      Persistent: "true",
    });
  });

  it("the boot unit applies before the three services start", () => {
    const { entries } = readIni(readFileSync(join(UNITS, "morndo-update-boot.service"), "utf8"));
    expect(entries.Before).toBe("morndo-hub.service morndo-fleet.service morndo-node.service");
    expect(entries.ExecStart).toBe("%h/.local/bin/morndo-update update boot");
    expect(entries.WantedBy).toBe("default.target");
  });

  it("recovery runs only while the applying mark exists, after the services", () => {
    const { entries } = readIni(readFileSync(join(UNITS, "morndo-update-recover.service"), "utf8"));
    expect(entries.ConditionPathExists).toBe("%S/morndo-update/applying");
    expect(entries.After).toBe("morndo-hub.service morndo-fleet.service morndo-node.service");
    expect(entries.ExecStart).toBe("%h/.local/share/morndo-releases/good/bin/morndo-update update recover");
    // launchd's recovery job the same: good's launcher, never the ~/.local/bin link through `current`
    expect(readFileSync(join(UNITS, "launchd", "com.morndo.update-recover.plist"), "utf8"))
      .toMatch(/<key>ProgramArguments<\/key>\s*<array>\s*<string>@HOME@\/\.local\/share\/morndo-releases\/good\/bin\/morndo-update<\/string>/);
    expect(readIni(readFileSync(join(UNITS, "morndo-update-recover.timer"), "utf8")).entries).toMatchObject({
      OnBootSec: "2min",
      OnUnitActiveSec: "5min",
    });
  });

  it("one apply is its own oneshot unit, its instance the Version to apply", () => {
    const { entries } = readIni(readFileSync(join(UNITS, "morndo-update-apply@.service"), "utf8"));
    expect(entries).toMatchObject({
      Type: "oneshot",
      ExecStart: "%h/.local/bin/morndo-update update apply --version %i",
    });
  });

  it("every launchd template is a plist with a ProgramArguments array", () => {
    for (const name of LAUNCHD) {
      const text = readFileSync(join(UNITS, "launchd", name), "utf8");
      expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'), name).toBe(true);
      expect(text).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
      expect(text).toContain('<plist version="1.0">');
      expect(text).toMatch(/<key>ProgramArguments<\/key>\s*<array>/);
    }
  });
});

// systemd-analyze is the machine's own parser; a box without it (this WSL, sometimes) skips with this reason.
const probe = spawnSync("systemd-analyze", ["--version"]);
const hasAnalyze = probe.error === undefined && probe.status === 0;

(hasAnalyze ? it : it.skip)(
  "systemd-analyze --user verify accepts every template (skip reason: no systemd-analyze on this machine)",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-upd-analyze-"));
    made.push(dir);
    for (const name of SYSTEMD) {
      // %h would point verify at this account's ~/.local/bin; /bin/true is only there to exist.
      const text = readFileSync(join(UNITS, name), "utf8").replace(/^ExecStart=.*$/m, "ExecStart=/bin/true");
      writeFileSync(join(dir, name), text);
    }
    const out = spawnSync("systemd-analyze", ["--user", "verify", ...SYSTEMD.map(n => join(dir, n))],
      { encoding: "utf8" });
    expect(out.status, `systemd-analyze said:\n${out.stdout}${out.stderr}`).toBe(0);
  });
