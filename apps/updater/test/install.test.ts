// `morndo install` (design §10.3): the unpacked archive this program runs from, installed by role. The tree is a
// real one — the stage layout, files.json and all, materialized into the scratch directory and verified against
// its own list — and the install runs over a throwaway HOME with the machine's services and probes faked, as
// cli-apply.test.ts injects them. What is asserted is what a first install leaves behind: the read-only Version,
// the links, the store's first words, the settings, the units for the role, and the refusals — an install that
// already exists, no linger, a tree that does not check out — before anything is written.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TreeFile } from "../../../scripts/release/archive.ts";
import { listFiles } from "../../../scripts/release/files.ts";
import { ConfigFile } from "../src/adapters/config-file.ts";
import { DirsInstaller } from "../src/adapters/installer-dirs.ts";
import { updaterPaths } from "../src/adapters/paths.ts";
import { openUpdateStore } from "../src/adapters/store-sqlite.ts";
import { runUpdater } from "../src/cli.ts";
import { FetchFailed } from "../src/application/ports.ts";
import { Die, FakeProbe, FakeServices, NOW } from "./helpers/apply-fakes.ts";
import { FakeArtifacts, FakeFeed, wipe } from "./helpers/fakes.ts";
import { feedFixture, keySetDocument, makeKeys, manifestSignature, releaseFixture } from "./helpers/release-fixtures.ts";

const VERSION = "0.2.0";
const YEAR = 365 * 24 * 3600_000;
// The update units every role gets (§5), and the links' shape: through `current`, so an update moves them.
const UPDATE_UNITS = ["morndo-update.timer", "morndo-update-boot.service", "morndo-update-recover.service", "morndo-update-recover.timer"];

let scratch = "";
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "morndo-upd-")); });
afterAll(() => { wipe(scratch); });

// The stage layout as a directory (§5): app/VERSION names the Version, the launchers in bin/ link into app/,
// the units ship beside them, trust/keys.json is the anchor, and files.json — written from the same list the
// pipeline signs — names every other file. Materialized writable, then the list's modes put on.
const makeTree = (n: number): { tree: string; keys: ReturnType<typeof makeKeys> } => {
  const keys = makeKeys();
  const keySet = keySetDocument(keys, { version: 1, expiresAt: NOW + 20 * YEAR });
  const files: TreeFile[] = [
    { path: "app/VERSION", mode: "0444", bytes: Buffer.from(`${VERSION}\n`) },
    { path: "app/run.sh", mode: "0555", bytes: Buffer.from(`#!/bin/sh\necho ${VERSION}\n`) },
    { path: "bin/morndo", mode: "0555", link: "../app/run.sh" },
    { path: "bin/morndo-update", mode: "0555", link: "../app/run.sh" },
    { path: "units/morndo-hub.service", mode: "0444", bytes: Buffer.from("[Unit]\nDescription=the hub\n") },
    { path: "units/morndo-fleet.service", mode: "0444", bytes: Buffer.from("[Unit]\nDescription=the fleet\n") },
    { path: "units/morndo-node.service", mode: "0444", bytes: Buffer.from("[Unit]\nDescription=the agent\n") },
    { path: "trust/keys.json", mode: "0444", bytes: keySet.bytes },
  ];
  const list = listFiles(files);
  const tree = join(scratch, `tree-${n}`);
  mkdirSync(tree, { recursive: true, mode: 0o755 });
  for (const file of files) {
    const to = join(tree, file.path);
    mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
    if ("link" in file) symlinkSync(file.link, to);
    else if (!("directory" in file)) {
      writeFileSync(to, file.bytes, { mode: 0o644 });
      chmodSync(to, parseInt(file.mode, 8));
    }
  }
  writeFileSync(join(tree, "files.json"), list.json, { mode: 0o644 });
  chmodSync(join(tree, "files.json"), 0o444);
  return { tree, keys };
};

let worldCount = 0;
type World = {
  home: string;
  paths: ReturnType<typeof updaterPaths>;
  services: FakeServices;
  tree: string;
  feed: FakeFeed;
  run(argv: string[]): Promise<{ code: number; out: string; err: string }>;
};
// `feed` is what the install's first check finds: a stub feed that signs this Version in (`served`), or a host that
// cannot be reached (the default — no test of the install may reach the real network).
const world = (o: { joined?: boolean; feed?: "served" | "unreachable" } = {}): World => {
  const home = join(scratch, `home-${(worldCount += 1)}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const paths = updaterPaths(home);
  const { tree, keys } = makeTree(worldCount);
  const feed = new FakeFeed();
  if (o.feed === "served") {
    const release = releaseFixture({ version: VERSION, now: Date.now() });
    feed.channels.set("stable", feedFixture(keys, [release], { channel: "stable", now: Date.now() }).served);
    feed.manifests.set(release.manifestUrl, { bytes: release.manifestBytes, signature: manifestSignature(keys, release) });
  } else {
    feed.fail = { op: "channel", error: new FetchFailed("network", "getaddrinfo ENOTFOUND feed.example.invalid") };
  }
  const tape: string[] = [];
  const die = new Die();
  const installer = new DirsInstaller({ releases: paths.releases });
  const services = new FakeServices({ tape, die, currentOf: () => installer.layout().current });
  const probe = new FakeProbe({ tape, die, currentOf: () => installer.layout().current });
  if (o.joined === true) {
    mkdirSync(join(home, ".config/morndo-node"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".config/morndo-node/config.json"), "{}\n", { mode: 0o600 });
  }
  return {
    home, paths, services, tree, feed,
    run: async argv => {
      const out: string[] = [], err: string[] = [];
      const code = await runUpdater(argv, { HOME: home, PATH: process.env.PATH }, {
        out: s => out.push(s), err: s => err.push(s),
      }, { services, probe, tree, feed, artifacts: new FakeArtifacts(paths.downloads) });
      return { code, out: out.join(""), err: err.join("") };
    },
  };
};

describe("`morndo install --role control-plane` (§10.3)", () => {
  it("installs the tree read-only, links it, seeds the store and the settings, renders and enables the role's units, and waits for health", async () => {
    const w = world({ joined: true });
    const r = await w.run(["install", "--role", "control-plane"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(new RegExp(`Morndo ${VERSION} installed \\(control-plane, channel stable\\)`));
    // The Version, read-only, with the links that name it current and good (§5).
    const versionDir = join(w.paths.releases, VERSION);
    expect(existsSync(join(versionDir, "app", "VERSION"))).toBe(true);
    expect((statSync(versionDir).mode & 0o777)).toBe(0o555);
    expect((statSync(join(versionDir, "app", "VERSION")).mode & 0o777)).toBe(0o444);
    expect(existsSync(join(versionDir, "install.json"))).toBe(true);
    expect(readlinkSync(join(w.paths.releases, "current"))).toBe(VERSION);
    expect(readlinkSync(join(w.paths.releases, "good"))).toBe(VERSION);
    // The launchers, linked through `current` so an update moves them too.
    expect(readlinkSync(join(w.home, ".local/bin/morndo"))).toBe("../share/morndo-releases/current/bin/morndo");
    expect(readlinkSync(join(w.home, ".local/bin/morndo-update"))).toBe("../share/morndo-releases/current/bin/morndo-update");
    // The store's first words: this Version committed, the tree's key set trusted.
    const store = openUpdateStore({ db: w.paths.db, lock: w.paths.lock });
    expect(store.highestCommitted()).toBe(VERSION);
    expect(store.trust().keySet?.version).toBe(1);
    store.close();
    // The settings, written once with the channel and never again (§11.6).
    expect(JSON.parse(readFileSync(w.paths.config, "utf8"))).toEqual({ channel: "stable" });
    // The units for the role, and everything enabled at once.
    expect(w.services.tape).toContain(`renderUnits:${VERSION} (hub,fleet,node)`);
    expect(w.services.enables[0]).toEqual([...UPDATE_UNITS, "morndo-hub.service", "morndo-fleet.service", "morndo-node.service"]);
    for (const s of ["hub", "fleet", "node"]) expect(r.out).toMatch(new RegExp(`${s}: healthy at ${VERSION}`));
  });

  it("leaves the signed file list in the installed Version (T-486)", async () => {
    const w = world({ joined: true });
    expect((await w.run(["install", "--role", "control-plane"])).code).toBe(0);
    const versionDir = join(w.paths.releases, VERSION);
    // files.json is not in its own list (scripts/release/files.ts), so copying "the listed files" dropped it
    expect(readFileSync(join(versionDir, "files.json"), "utf8")).toBe(readFileSync(join(w.tree, "files.json"), "utf8"));
    expect((statSync(join(versionDir, "files.json")).mode & 0o777)).toBe(0o444);
  });

  it("runs the first check as its last step, so `morndo doctor` right after the install is clean (§10.3, T-486)", async () => {
    const w = world({ joined: true, feed: "served" });
    const r = await w.run(["install", "--role", "control-plane"]);
    expect(r.code, r.err).toBe(0);
    expect(w.feed.calls.channels).toEqual(["stable"]);
    expect(r.out).toContain(`Up to date: ${VERSION}.`);
    const doctor = await w.run(["doctor", "--json"]);
    expect(JSON.parse(doctor.out)).toMatchObject({ ok: true, findings: [] });
    expect(doctor.code, doctor.out).toBe(0);
  });

  it("an unreachable feed at install is said and recorded, the install still succeeds, and the doctor names the feed (T-486)", async () => {
    const w = world({ joined: true, feed: "unreachable" });
    const r = await w.run(["install", "--role", "control-plane"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`Morndo ${VERSION} installed`);
    expect(r.err).toMatch(/Unreachable: .*ENOTFOUND/);
    const store = openUpdateStore({ db: w.paths.db, lock: w.paths.lock });
    expect(store.checks(1)[0]).toMatchObject({ outcome: "unreachable", feedSeq: null });
    store.close();
    const doctor = await w.run(["doctor", "--json"]);
    const report = JSON.parse(doctor.out) as { ok: boolean; findings: { area: string; detail: string }[] };
    expect(report.findings.map(f => f.area)).toEqual(["feed"]);      // never a fake "verified": the tree and provenance are clean
    expect(report.findings[0]!.detail).toMatch(/never/);
    expect(doctor.code).toBe(1);
  });

  it("a fresh install defaults to mode apply and channel stable", async () => {
    const w = world({ joined: true });
    const r = await w.run(["install", "--role", "control-plane"]);   // no --channel: the domain's own default
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(readFileSync(w.paths.config, "utf8"))).toEqual({ channel: "stable" });
    const settings = new ConfigFile(w.paths.config).read();
    expect(settings.channel).toBe("stable");
    expect(settings.mode).toBe("apply");
    const status = await w.run(["update", "--status"]);
    expect(status.code, status.err).toBe(0);
    expect(status.out).toMatch(/channel: stable/);
    expect(status.out).toMatch(/mode: apply/);
  });

  it("--channel latest writes the channel it was given", async () => {
    const w = world({ joined: true });
    const r = await w.run(["install", "--role", "control-plane", "--channel", "latest"]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(readFileSync(w.paths.config, "utf8"))).toEqual({ channel: "latest" });
  });

  it("a first install writes its channel through the same locked write", async () => {
    const w = world({ joined: true });
    const r = await w.run(["install", "--role", "control-plane", "--channel", "latest"]);
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(w.paths.config, "utf8")).toBe(`${JSON.stringify({ channel: "latest" }, null, 2)}\n`);
    const names = readdirSync(dirname(w.paths.config));
    expect(names.filter(name => name.includes(".tmp") || name.endsWith(".lock"))).toEqual([]);
  });

  it("refuses a second install: already installed, use morndo update", async () => {
    const w = world({ joined: true });
    expect((await w.run(["install", "--role", "control-plane"])).code).toBe(0);
    const again = await w.run(["install", "--role", "control-plane"]);
    expect(again.code).toBe(78);
    expect(again.err).toMatch(/already installed: use morndo update/);
  });

  it("refuses without linger, printing the command, before anything is written", async () => {
    const w = world({ joined: true });
    w.services.linger = false;
    const r = await w.run(["install", "--role", "control-plane"]);
    expect(r.code, r.err).toBe(78);
    expect(r.err).toMatch(/loginctl enable-linger/);
    expect(w.services.enables).toEqual([]);                 // nothing was enabled
    expect(existsSync(join(w.paths.releases, "current"))).toBe(false);   // and nothing installed
    expect(existsSync(join(w.home, ".local/bin/morndo"))).toBe(false);
  });

  it("refuses a unit of ours that Morndo did not write, before anything is written; --force keeps it aside", async () => {
    const w = world({ joined: true });
    w.services.foreign = ["/srv/example-user/.config/systemd/user/morndo-hub.service"];
    const r = await w.run(["install", "--role", "control-plane"]);
    expect(r.code, r.err).toBe(78);
    expect(r.err).toMatch(/morndo-hub\.service: not written by Morndo; move it away, or run with --force/);
    expect(w.services.tape.some(t => t.startsWith("renderUnits:"))).toBe(false);   // nothing rendered
    expect(w.services.enables).toEqual([]);
    expect(existsSync(join(w.paths.releases, "current"))).toBe(false);          // and nothing installed
    const forced = await w.run(["install", "--role", "control-plane", "--force"]);
    expect(forced.code, forced.err).toBe(0);
    expect(w.services.tape).toContain(`renderUnits:${VERSION} (hub,fleet,node) replacing foreign`);
    // the first install's check reads the tree being installed: its Version is not in the releases yet
    expect(w.services.foreignFrom).toEqual([w.tree, w.tree]);
    expect(forced.out).toMatch(/kept the unit Morndo replaced as \/srv\/example-user\/.*morndo-hub\.service\.before-morndo/);
  });

  it("refuses a tree that does not check out against its own files.json, writing nothing", async () => {
    const w = world({ joined: true });
    const versionFile = join(w.tree, "app", "VERSION");
    chmodSync(versionFile, 0o644);
    writeFileSync(versionFile, "9.9.9\n");                   // a byte changed after the list was signed
    chmodSync(versionFile, 0o444);
    const r = await w.run(["install", "--role", "control-plane"]);
    expect(r.code, r.err).toBe(65);
    expect(r.err).toMatch(/does not check out/);
    expect(existsSync(join(w.paths.releases, "current"))).toBe(false);
    expect(w.services.enables).toEqual([]);
  });
});

describe("`morndo install --role node` (§10.3)", () => {
  it("on a node that has not joined, installs and enables the update units only, and says how to join", async () => {
    const w = world();                                // no ~/.config/morndo-node/config.json
    const r = await w.run(["install", "--role", "node"]);
    expect(r.code, r.err).toBe(0);
    expect(w.services.tape).toContain(`renderUnits:${VERSION} (node)`);
    expect(w.services.enables[0]).toEqual([...UPDATE_UNITS]);   // the agent's unit waits for the join
    expect(r.out).toMatch(/morndo-node join <code>, then systemctl --user start morndo-node/);
    expect(readlinkSync(join(w.paths.releases, "current"))).toBe(VERSION);
  });

  it("on a joined node, enables and waits for the agent too", async () => {
    const w = world({ joined: true });
    const r = await w.run(["install", "--role", "node"]);
    expect(r.code, r.err).toBe(0);
    expect(w.services.enables[0]).toEqual([...UPDATE_UNITS, "morndo-node.service"]);
    expect(r.out).toMatch(new RegExp(`node: healthy at ${VERSION}`));
  });
});
