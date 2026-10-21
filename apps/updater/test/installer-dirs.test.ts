// The versioned-directories installer's contract (design §5, §6.1 steps 4–6, §13 fault injection): a good
// Version unpacks into .staging-<version>, matches its signed file list file for file, self-tests and promotes
// into a read-only <version>/ tree; every fault leaves the releases directory exactly as it was.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TreeFile } from "../../../scripts/release/archive.ts";
import { listFiles } from "../../../scripts/release/files.ts";
import { DirsInstaller } from "../src/adapters/installer-dirs.ts";
import { buildRelease, evilGz, packWithList } from "./helpers/tar-fixtures.ts";

const VERSION = "0.2.0";
const RUN = "#!/bin/sh\necho 0.2.0\n";
// a whole second, so install.json's time is exactly what Date.parse round-trips
const INSTALLED_AT = 1761000000000;

const TREE = (): TreeFile[] => [
  { path: "README.md", mode: "0444", bytes: Buffer.from("morndo 0.2.0\n") },
  { path: "app/run.sh", mode: "0555", bytes: Buffer.from(RUN) },
  { path: "bin/morndo", mode: "0555", link: "../app/run.sh" },
  { path: "units", mode: "0555", directory: true },
  { path: "units/hub.service", mode: "0444", bytes: Buffer.from("[Unit]\n") },
];

let scratch = "";
let releases = "";
let reader = "";   // the child that resolves current while the swaps run

// A reader in another process (§6.2 step 6): it resolves the current link until the stop file appears, then
// prints one JSON line — how many reads succeeded, how many found no link at all, and every target it saw.
// A swap that could ever leave current missing shows up as exactly that.
const READER_SOURCE = `
const { readlinkSync, existsSync } = require("node:fs");
const [link, stop] = process.argv.slice(2);
let ok = 0, missing = 0, other = 0;
const seen = new Set();
const step = () => {
  for (let i = 0; i < 100; i++) {
    try { seen.add(readlinkSync(link)); ok++; }
    catch (error) { if (error && error.code === "ENOENT") missing++; else other++; }
  }
  if (existsSync(stop)) { process.stdout.write(JSON.stringify({ ok, missing, other, seen: [...seen] })); process.exit(0); }
  setImmediate(step);
};
step();
`;

// Removes a read-only Version tree (files 0444, directories 0555 — §5): deleting a file needs write on its
// directory, so the write bit goes back before rm. The installer does the same through its own removeTree.
const wipe = (path: string): void => {
  const soften = (dir: string): void => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) { soften(full); chmodSync(full, 0o755); }
      else if (dirent.isFile()) chmodSync(full, 0o644);
    }
    chmodSync(dir, 0o755);
  };
  try { soften(path); } catch { /* not there */ }
  rmSync(path, { recursive: true, force: true });
};

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "morndo-upd-"));
  releases = join(scratch, "releases");
  reader = join(scratch, "link-reader.cjs");
  writeFileSync(reader, READER_SOURCE);
});
afterAll(() => { wipe(scratch); });
beforeEach(() => { wipe(releases); mkdirSync(releases, { recursive: true }); });

// A good release on disk, ready to unpack: the archive, the signed list's digest, and the installer.
const good = () => {
  const built = buildRelease(TREE());
  const archive = join(scratch, "release.tar.gz");
  writeFileSync(archive, built.gz);
  return { installer: new DirsInstaller({ releases }), archive, filesSha256: built.filesSha256 };
};

const unpackGood = async () => {
  const { installer, archive, filesSha256 } = good();
  expect(await installer.unpack(archive, VERSION, { filesSha256, maxBytes: 1 << 20 })).toEqual({ ok: true });
  return { installer, filesSha256 };
};

// Unpack then promote, the check-and-stage flow of §6.1 steps 4 to 6.
const installGood = async () => {
  const { installer, filesSha256 } = await unpackGood();
  installer.promote(VERSION, { manifestSha256: "a".repeat(64), filesSha256, at: INSTALLED_AT });
  return { installer, filesSha256, vdir: join(releases, VERSION) };
};

// One unpack fault: refused with a reason, and the releases directory untouched — no .staging-*, no <version>/.
const fault = async (gz: Buffer, filesSha256: string, reason: RegExp): Promise<void> => {
  const archive = join(scratch, "bad.tar.gz");
  writeFileSync(archive, gz);
  const installer = new DirsInstaller({ releases });
  const outcome = await installer.unpack(archive, VERSION, { filesSha256, maxBytes: 1 << 20 });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.reason).toMatch(reason);
  expect(readdirSync(releases)).toEqual([]);
  expect(installer.has(VERSION)).toBe(false);
};

const MODE = (path: string) => (statSync(path).mode & 0o777).toString(8);

describe("DirsInstaller", () => {
  it("unpacks and promotes a good Version: staging then a read-only tree, install.json, nothing left over", async () => {
    const { installer, filesSha256 } = await unpackGood();
    expect(existsSync(join(releases, `.staging-${VERSION}`))).toBe(true);   // the self-test runs on the staging tree
    expect(await installer.selftest(VERSION)).toEqual({ ok: true });
    installer.promote(VERSION, { manifestSha256: "a".repeat(64), filesSha256, at: INSTALLED_AT });

    const vdir = join(releases, VERSION);
    expect(installer.has(VERSION)).toBe(true);
    // the modes come from the signed list: files 0444/0555, every directory 0555 (§5)
    expect(MODE(join(vdir, "README.md"))).toBe("444");
    expect(MODE(join(vdir, "app/run.sh"))).toBe("555");
    expect(MODE(join(vdir, "units/hub.service"))).toBe("444");
    expect(MODE(join(vdir, "app"))).toBe("555");
    expect(MODE(join(vdir, "units"))).toBe("555");
    expect(MODE(vdir)).toBe("555");
    expect(readFileSync(join(vdir, "README.md"), "utf8")).toBe("morndo 0.2.0\n");
    expect(MODE(join(vdir, "install.json"))).toBe("444");
    const record = JSON.parse(readFileSync(join(vdir, "install.json"), "utf8"));
    expect(record.method).toBe("updater");
    expect(record.manifestSha256).toBe("a".repeat(64));
    expect(record.filesSha256).toBe(filesSha256);
    expect(Date.parse(record.installedAt)).toBe(INSTALLED_AT);
    expect(record.installedAt).toMatch(/Z$/);
    expect(readdirSync(releases)).toEqual([VERSION]);   // promoted away: no .staging-* left
  });

  it("an I/O error while unpacking is thrown, not returned as a refusal, and leaves no staging", async () => {
    const { installer, filesSha256 } = good();
    await expect(installer.unpack(join(scratch, "vanished.tar.gz"), VERSION, { filesSha256, maxBytes: 1 << 20 }))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(readdirSync(releases).filter(name => name.startsWith(".staging-"))).toEqual([]);
  });
  it("refuses a files.json whose digest is not the signed one", async () => {
    await fault(buildRelease(TREE()).gz, "0".repeat(64), /files\.json: file list digest/);
  });

  it("refuses a file the list does not name", async () => {
    const listed = listFiles(TREE());
    const withExtra: TreeFile[] = [...TREE(), { path: "extra.txt", mode: "0444", bytes: Buffer.from("not signed\n") }];
    await fault(packWithList(withExtra, listed.json), listed.sha256, /extra\.txt: not in the file list/);
  });

  it("refuses a listed file the archive does not carry", async () => {
    const listed = listFiles(TREE());
    const missing = TREE().filter(f => f.path !== "units/hub.service");
    await fault(packWithList(missing, listed.json), listed.sha256, /units\/hub\.service: in the file list, not in the archive/);
  });

  it("refuses a file whose bytes differ at the same size", async () => {
    const listed = listFiles(TREE());
    const swapped = TREE().map(f => f.path === "README.md" ? { ...f, bytes: Buffer.from("morndo 0.1.0\n") } : f);
    await fault(packWithList(swapped, listed.json), listed.sha256, /README\.md: content digest/);
  });

  it("refuses a listed mode other than 0444 and 0555", async () => {
    const listed = JSON.parse(listFiles(TREE()).json) as { path: string; mode: string }[];
    const tampered = listed.map(e => e.path === "README.md" ? { ...e, mode: "0644" } : e);
    const json = `${JSON.stringify(tampered, null, 2)}\n`;   // the same canonical shape files.ts writes
    const filesSha256 = createHash("sha256").update(json).digest("hex");
    await fault(packWithList(TREE(), json), filesSha256, /README\.md: mode 0644/);
  });

  it("refuses an archive the tar reader refuses (../x), and leaves nothing", async () => {
    await fault(evilGz([{ name: "../x", body: Buffer.from("x") }]), listFiles(TREE()).sha256, /\.\./);
  });

  it("layout(): no links is a checkout; links to Versions are ours; another target is not", () => {
    const installer = new DirsInstaller({ releases });
    expect(installer.layout()).toEqual({ method: "checkout", current: null, previous: null, good: null });
    symlinkSync("0.1.0", join(releases, "current"));
    symlinkSync("0.0.9", join(releases, "previous"));
    symlinkSync("0.1.0", join(releases, "good"));
    expect(installer.layout()).toEqual({ method: "updater", current: "0.1.0", previous: "0.0.9", good: "0.1.0" });
    rmSync(join(releases, "current"));
    symlinkSync("../elsewhere", join(releases, "current"));   // points outside: not our layout
    expect(installer.layout()).toEqual({ method: "checkout", current: null, previous: "0.0.9", good: "0.1.0" });
  });

  it("sweep() removes leftover read-only .staging-* trees", () => {
    const leftover = join(releases, `.staging-${VERSION}`);
    mkdirSync(join(leftover, "app"), { recursive: true });
    writeFileSync(join(leftover, "app", "run.sh"), RUN);
    chmodSync(join(leftover, "app", "run.sh"), 0o444);
    chmodSync(join(leftover, "app"), 0o555);
    chmodSync(leftover, 0o555);
    mkdirSync(join(releases, ".staging-0.1.0"));
    new DirsInstaller({ releases }).sweep();
    expect(readdirSync(releases)).toEqual([]);
  });

  it("sweep() does nothing when the releases directory does not exist", () => {
    // a machine with nothing installed yet has no releases directory; the next beforeEach puts it back
    rmSync(releases, { recursive: true, force: true });
    expect(() => new DirsInstaller({ releases }).sweep()).not.toThrow();
  });

  it("selftest passes for the staged Version and fails for another", async () => {
    const { installer, archive, filesSha256 } = good();
    expect(await installer.unpack(archive, VERSION, { filesSha256, maxBytes: 1 << 20 })).toEqual({ ok: true });
    expect(await installer.selftest(VERSION)).toEqual({ ok: true });
    // the same tree staged as another Version: its launcher still prints 0.2.0, so 0.3.0 fails on what it printed
    expect(await installer.unpack(archive, "0.3.0", { filesSha256, maxBytes: 1 << 20 })).toEqual({ ok: true });
    const wrong = await installer.selftest("0.3.0");
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toMatch(/0\.3\.0/);
  });

  it("verifyTree: an untouched Version has no findings", async () => {
    const { installer, filesSha256 } = await installGood();
    expect(await installer.verifyTree(VERSION, filesSha256)).toEqual([]);
    expect(await installer.verifyTree(VERSION, null)).toEqual([]);
  });

  it("verifyTree reports a changed file (and sorts by path)", async () => {
    const { installer, filesSha256, vdir } = await installGood();
    const readme = join(vdir, "README.md");
    const edit = (write: () => void) => { chmodSync(vdir, 0o755); write(); chmodSync(vdir, 0o555); };
    edit(() => {
      chmodSync(readme, 0o644);
      writeFileSync(readme, "morndo 0.9.9\n");
      chmodSync(readme, 0o444);
      writeFileSync(join(vdir, "stray.txt"), "x");
    });
    expect(await installer.verifyTree(VERSION, filesSha256)).toEqual([
      { path: "README.md", problem: "changed" },
      { path: "stray.txt", problem: "extra" },
    ]);
    edit(() => {
      chmodSync(readme, 0o644);
      writeFileSync(readme, "morndo 0.2.0\n");
      chmodSync(readme, 0o444);
      rmSync(join(vdir, "stray.txt"));
    });
    expect(await installer.verifyTree(VERSION, filesSha256)).toEqual([]);
  });

  it("verifyTree reports a removed listed file", async () => {
    const { installer, filesSha256, vdir } = await installGood();
    chmodSync(join(vdir, "app"), 0o755);
    rmSync(join(vdir, "app", "run.sh"));
    chmodSync(join(vdir, "app"), 0o555);
    expect(await installer.verifyTree(VERSION, filesSha256)).toEqual([{ path: "app/run.sh", problem: "missing" }]);
  });

  it("verifyTree reports a changed mode", async () => {
    const { installer, filesSha256, vdir } = await installGood();
    const readme = join(vdir, "README.md");
    chmodSync(vdir, 0o755);
    chmodSync(readme, 0o644);
    chmodSync(vdir, 0o555);
    expect(await installer.verifyTree(VERSION, filesSha256)).toEqual([{ path: "README.md", problem: "mode" }]);
  });

  it("verifyTree reports a files.json that is not the signed list", async () => {
    const { installer } = await installGood();
    expect(await installer.verifyTree(VERSION, "0".repeat(64))).toEqual([{ path: "files.json", problem: "list_digest" }]);
  });

  it("refuses to promote a Version that is already installed", async () => {
    const { installer, filesSha256 } = await installGood();
    expect(() => installer.promote(VERSION, { manifestSha256: "a".repeat(64), filesSha256, at: INSTALLED_AT }))
      .toThrow(/already installed/);
  });

  it("removeVersion removes a promoted read-only Version tree", async () => {
    const { installer } = await installGood();
    installer.removeVersion(VERSION);
    expect(installer.has(VERSION)).toBe(false);
    expect(readdirSync(releases)).toEqual([]);
  });

  it("removeVersion refuses a Version that current, previous or good points at", async () => {
    const { installer } = await installGood();
    for (const name of ["current", "previous", "good"]) {
      symlinkSync(VERSION, join(releases, name));
      expect(() => installer.removeVersion(VERSION), name).toThrow(/points at it/);
      rmSync(join(releases, name));
    }
    expect(installer.has(VERSION)).toBe(true);   // a kept Version is never removed
  });

  it("freeBytes(): a positive number from the file system holding the releases directory", () => {
    expect(new DirsInstaller({ releases }).freeBytes()).toBeGreaterThan(0);
  });

  it("freeBytes(): a machine with no releases directory yet still gets its number", () => {
    // a checkout's doctor runs before any release lands; the next beforeEach puts the directory back
    rmSync(releases, { recursive: true, force: true });
    expect(new DirsInstaller({ releases }).freeBytes()).toBeGreaterThan(0);
  });

  it("swap(): previous first, then current — a current that cannot land leaves both links on the old Version", async () => {
    const { installer } = await installGood();
    symlinkSync("0.1.0", join(releases, "current"));
    mkdirSync(join(releases, ".current.new"));   // the temp name blocked: the current link cannot land
    expect(() => installer.swap({ current: VERSION, previous: "0.1.0" })).toThrow();
    expect(readlinkSync(join(releases, "previous"))).toBe("0.1.0");   // previous went first (§6.2 step 6)
    expect(readlinkSync(join(releases, "current"))).toBe("0.1.0");    // and current never moved
    rmSync(join(releases, ".current.new"), { recursive: true, force: true });
    installer.swap({ current: VERSION, previous: "0.1.0" });
    expect(readlinkSync(join(releases, "current"))).toBe(VERSION);
    expect(readlinkSync(join(releases, "previous"))).toBe("0.1.0");
  });

  it("swap(): previous null removes the previous link (a first install has none to keep)", async () => {
    const { installer } = await installGood();
    symlinkSync("0.0.9", join(releases, "previous"));
    installer.swap({ current: VERSION, previous: null });
    expect(existsSync(join(releases, "previous"))).toBe(false);
    expect(readlinkSync(join(releases, "current"))).toBe(VERSION);
  });

  it("swap(): a reader resolving current through 2,000 swaps never finds it missing", async () => {
    const { installer, archive, filesSha256 } = good();
    for (const v of ["0.1.0", VERSION]) {   // both ends of every swap, installed from the same archive
      expect(await installer.unpack(archive, v, { filesSha256, maxBytes: 1 << 20 })).toEqual({ ok: true });
      installer.promote(v, { manifestSha256: "a".repeat(64), filesSha256, at: INSTALLED_AT });
    }
    symlinkSync("0.1.0", join(releases, "current"));
    const stop = join(scratch, "reader-stop");
    const child = spawn(process.execPath, [reader, join(releases, "current"), stop], { stdio: ["ignore", "pipe", "inherit"] });
    for (let i = 0; i < 2_000; i++) {
      installer.swap({ current: i % 2 === 0 ? VERSION : "0.1.0", previous: "0.1.0" });
    }
    writeFileSync(stop, "");
    const out = await new Promise<string>((resolve, reject) => {
      let text = "";
      child.stdout.on("data", chunk => { text += String(chunk); });
      child.on("error", reject);
      child.on("close", () => resolve(text));
    });
    const counted = JSON.parse(out) as { ok: number; missing: number; other: number; seen: string[] };
    expect(counted.missing).toBe(0);                    // the invariant: rename(2) over the link, never without it
    expect(counted.other).toBe(0);
    expect(counted.ok).toBeGreaterThan(0);
    expect(new Set(counted.seen)).toEqual(new Set(["0.1.0", VERSION]));
  }, 120_000);

  it("setGood(): the good link lands the same atomic way", async () => {
    const { installer } = await installGood();
    installer.setGood(VERSION);
    expect(readlinkSync(join(releases, "good"))).toBe(VERSION);
  });

  it("prune(): every installed Version not named goes; current, previous and good never do", async () => {
    const { installer, archive, filesSha256 } = good();
    for (const v of ["0.1.0", VERSION, "0.3.0", "0.4.0"]) {
      expect(await installer.unpack(archive, v, { filesSha256, maxBytes: 1 << 20 })).toEqual({ ok: true });
      installer.promote(v, { manifestSha256: "a".repeat(64), filesSha256, at: INSTALLED_AT });
    }
    symlinkSync(VERSION, join(releases, "current"));
    symlinkSync("0.1.0", join(releases, "previous"));
    symlinkSync("0.1.0", join(releases, "good"));
    installer.prune([VERSION]);                    // named: kept; the links' targets: kept without being named
    expect(readdirSync(releases).sort()).toEqual(["0.1.0", VERSION, "current", "good", "previous"]);
    expect(installer.has("0.3.0")).toBe(false);
    expect(installer.has("0.4.0")).toBe(false);
  });

  it("prune(): a machine with nothing installed yet has nothing to remove", () => {
    // the next beforeEach puts the releases directory back
    rmSync(releases, { recursive: true, force: true });
    expect(() => new DirsInstaller({ releases }).prune([VERSION])).not.toThrow();
  });
});
