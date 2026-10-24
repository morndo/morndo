// The settings commands (design §8.1, §8.3): `update --channel`, `auto`, `pin`, `unpin` and `window`. Each is one
// command alone. The file tests run over a scratch HOME the way cli.test.ts does; the ones that need a feed reuse
// cli-apply.test.ts's world — a real install, a signed feed offering a higher Version, the machine's services faked.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { writeFloor } from "@morndo/service-kit";
import { parseVersion, type UpdateService } from "@morndo/domain";
import { UpdateStatusSchema } from "@morndo/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApplyTiming } from "../src/application/apply-steps.ts";
import { DirsInstaller } from "../src/adapters/installer-dirs.ts";
import { databasePaths, updaterPaths } from "../src/adapters/paths.ts";
import { openUpdateStore, SqliteUpdateStore } from "../src/adapters/store-sqlite.ts";
import { runUpdater } from "../src/cli.ts";
import { Die, FakeProbe, FakeServices, NOW, A, B, SCHEMAS_A } from "./helpers/apply-fakes.ts";
import { FakeArtifacts, FakeFeed, FakeFleetView, wipe } from "./helpers/fakes.ts";
import { feedFixture, keySetDocument, makeKeys, manifestSignature, releaseFixture, type Keys, type ReleaseFixture } from "./helpers/release-fixtures.ts";

const DAY = 24 * 3600_000;
const YEAR = 365 * DAY;
const SHORT: Partial<ApplyTiming> = { drainMs: 400, pollMs: 5, healthMs: 500, holdAckMs: 200 };

let scratch = "";
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "morndo-upd-")); });
afterAll(() => { wipe(scratch); });

let homes = 0;
const freshHome = (): string => {
  const home = join(scratch, `plain-${(homes += 1)}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
};

const run = async (home: string, argv: string[], env: Record<string, string | undefined> = {}):
  Promise<{ code: number; out: string; err: string }> => {
  const out: string[] = [], err: string[] = [];
  const code = await runUpdater(argv, { HOME: home, PATH: process.env.PATH, ...env }, {
    out: s => out.push(s), err: s => err.push(s),
  });
  return { code, out: out.join(""), err: err.join("") };
};

const configOf = (home: string): string => join(home, ".config/morndo-update/config.json");

// One installed machine, as cli-apply.test.ts builds it: Version A current, the feed offering B.
type World = {
  home: string;
  paths: ReturnType<typeof updaterPaths>;
  store: SqliteUpdateStore;
  services: FakeServices;
  feed: FakeFeed;
  artifacts: FakeArtifacts;
  b: ReleaseFixture;
  current(): string | null;
  run(argv: string[], env?: Record<string, string | undefined>, o?: { timing?: Partial<ApplyTiming> }):
    Promise<{ code: number; out: string; err: string }>;
};

const feedOf = (keys: Keys, releases: readonly ReleaseFixture[]) => {
  const feed = new FakeFeed();
  const served = feedFixture(keys, releases, { channel: "stable", now: Date.now() });
  feed.channels.set("stable", served.served);
  for (const release of releases)
    feed.manifests.set(release.manifestUrl, { bytes: release.manifestBytes, signature: manifestSignature(keys, release) });
  return feed;
};

let worldCount = 0;
async function world(o: { running?: UpdateService[]; preStageB?: boolean } = {}): Promise<World> {
  const home = join(scratch, `home-${(worldCount += 1)}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const paths = updaterPaths(home);
  const dbPaths = databasePaths(home, {});
  const keys = makeKeys();
  const keySet = keySetDocument(keys, { version: 1, expiresAt: NOW + 20 * YEAR });
  const a = releaseFixture({ version: A, now: NOW - 2 * DAY });
  const b = releaseFixture({ version: B, now: NOW - DAY });
  const installer = new DirsInstaller({ releases: paths.releases });
  const install = async (fixture: ReleaseFixture): Promise<void> => {
    const archive = join(home, `${fixture.version}.tar.gz`);
    writeFileSync(archive, fixture.archive);
    const unpacked = await installer.unpack(archive, fixture.version, { filesSha256: fixture.filesSha256, maxBytes: 1 << 20 });
    if (!unpacked.ok) throw new Error(`${fixture.version} did not unpack: ${unpacked.reason}`);
    installer.promote(fixture.version, { manifestSha256: fixture.manifestSha256, filesSha256: fixture.filesSha256, at: NOW });
    rmSync(archive, { force: true });
  };
  await install(a);
  installer.swap({ current: A, previous: null });
  installer.setGood(A);
  for (const db of ["hub", "fleet", "node", "connections"] as const) {
    const path = dbPaths[db];
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db_ = new Database(path);
    db_.exec("CREATE TABLE lanes (id TEXT NOT NULL)");
    db_.prepare("INSERT INTO lanes (id) VALUES (?)").run(`written-at-${db}`);
    db_.pragma(`user_version = ${SCHEMAS_A[db].version}`);
    writeFloor(db_, SCHEMAS_A[db].floor);
    db_.close();
  }
  const store = openUpdateStore({ db: paths.db, lock: paths.lock });
  store.saveTrust({ keySet: keySet.decoded, highestFeedSeq: { stable: 0, latest: 0 } });
  const tape: string[] = [];
  const die = new Die();
  const services = new FakeServices({ tape, die, currentOf: () => installer.layout().current, running: o.running });
  const probe = new FakeProbe({ tape, die, currentOf: () => installer.layout().current });
  const feed = feedOf(keys, [b]);
  const artifacts = new FakeArtifacts(paths.downloads);
  const fleet = new FakeFleetView();
  fleet.nodesWord = [];
  const w: World = {
    home, paths, store, services, feed, artifacts, b,
    current: () => installer.layout().current,
    run: async (argv, env = {}, opts = {}) => {
      const out: string[] = [], err: string[] = [];
      const code = await runUpdater(argv, { HOME: home, PATH: process.env.PATH, ...env }, {
        out: s => out.push(s), err: s => err.push(s),
      }, { services, probe, feed, artifacts, fleet, ...(opts.timing ? { timing: opts.timing } : {}) });
      return { code, out: out.join(""), err: err.join("") };
    },
  };
  if (o.preStageB === true) {
    await install(b);
    store.recordStaged({ version: b.version, manifestSha256: b.manifestSha256, filesSha256: b.filesSha256, at: NOW - 1000, manifest: b.manifestText });
  }
  return w;
}

const hhmm = (n: number): string =>
  `${String(Math.floor((n % 1440) / 60)).padStart(2, "0")}:${String((n % 1440) % 60).padStart(2, "0")}`;

const SETTINGS = [
  ["update", "--channel", "latest"],
  ["update", "auto", "off"],
  ["update", "pin", "1.2.3"],
  ["update", "unpin"],
  ["update", "window", "02:00-06:00"],
] as const;

describe("update settings commands (§8.1, §8.3)", () => {
  it("update --channel latest writes the channel and keeps every other field", async () => {
    const home = freshHome();
    const config = configOf(home);
    mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
    writeFileSync(config, `${JSON.stringify({ soakMinutes: 15, pin: "1.4.0", channel: "stable", mode: "stage" }, null, 2)}\n`, { mode: 0o600 });
    const r = await run(home, ["update", "--channel", "latest"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/stable/);
    expect(r.out).toMatch(/latest/);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
      soakMinutes: 15, pin: "1.4.0", channel: "latest", mode: "stage",
    });
    expect(statSync(config).mode & 0o777).toBe(0o600);
  });

  it("update --channel with a word that is not stable or latest is usage and writes nothing", async () => {
    const home = freshHome();
    const r = await run(home, ["update", "--channel", "nightly"]);
    expect(r.code, r.err).toBe(64);
    expect(r.err).toMatch(/usage/);
    expect(existsSync(configOf(home))).toBe(false);
    const extra = await run(home, ["update", "--channel", "latest", "--json"]);
    expect(extra.code).toBe(64);
    expect(extra.err).toMatch(/usage/);
    expect(existsSync(configOf(home))).toBe(false);
  });

  it("update auto apply, stage and off write the mode", async () => {
    const home = freshHome();
    const config = configOf(home);
    for (const mode of ["apply", "stage", "off"] as const) {
      const r = await run(home, ["update", "auto", mode]);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain(mode);
      expect(JSON.parse(readFileSync(config, "utf8")).mode).toBe(mode);
    }
  });

  it("auto off stops the background apply and morndo update still works", async () => {
    const w = await world();
    const set = await w.run(["update", "auto", "off"]);
    expect(set.code, set.err).toBe(0);
    const tick = await w.run(["update", "tick"]);
    expect(tick.code, tick.err).toBe(0);
    expect(w.feed.calls.channels).toEqual([]);
    w.artifacts.serve(w.b.name, { bytes: w.b.archive });
    const check = await w.run(["update", "--check"]);
    expect(check.code, check.err).toBe(0);
    expect(w.store.staged()?.version).toBe(B);
  }, 60_000);

  it("update pin writes a Version and a pin holds the machine at its pin (RL14)", async () => {
    const w = await world();
    const set = await w.run(["update", "pin", A]);
    expect(set.code, set.err).toBe(0);
    expect(JSON.parse(readFileSync(w.paths.config, "utf8")).pin).toBe(A);
    const status = await w.run(["update", "--status"]);
    expect(status.out).toContain(`pin: ${A}`);
    const tick = await w.run(["update", "tick"]);
    expect(tick.code, tick.err).toBe(0);
    expect(`${tick.out}${tick.err}`).toMatch(/pinned/);
    expect(w.store.staged()).toBeNull();
    const check = await w.run(["update", "--check"]);
    expect(check.code, check.err).toBe(0);
    expect(`${check.out}${check.err}`).toMatch(/pinned/);
    expect(w.store.staged()).toBeNull();
    expect(w.current()).toBe(A);
  }, 60_000);

  it("update pin refuses a word that is not a Version, and unpin removes the pin", async () => {
    const home = freshHome();
    const config = configOf(home);
    mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
    const seeded = `${JSON.stringify({ pin: "1.2.3", channel: "stable" }, null, 2)}\n`;
    writeFileSync(config, seeded, { mode: 0o600 });
    const bad = await run(home, ["update", "pin", "1.x"]);
    expect(bad.code, bad.err).toBe(64);
    expect(bad.err).toMatch(/not a Version/);
    expect(readFileSync(config, "utf8")).toBe(seeded);
    const missing = await run(home, ["update", "pin"]);
    expect(missing.code).toBe(64);
    expect(missing.err).toMatch(/usage/);
    expect(readFileSync(config, "utf8")).toBe(seeded);
    const cleared = await run(home, ["update", "unpin"]);
    expect(cleared.code, cleared.err).toBe(0);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ channel: "stable" });
    expect(cleared.out).toMatch(/1\.2\.3/);
  });

  it("update window writes the local window and any removes it", async () => {
    const home = freshHome();
    const config = configOf(home);
    mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
    writeFileSync(config, `${JSON.stringify({ soakMinutes: 15 }, null, 2)}\n`, { mode: 0o600 });
    const set = await run(home, ["update", "window", "22:00-06:00"]);
    expect(set.code, set.err).toBe(0);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ soakMinutes: 15, window: "22:00-06:00" });
    const status = await run(home, ["update", "--status"]);
    expect(status.out).toMatch(/window: 22:00-06:00/);
    const cleared = await run(home, ["update", "window", "any"]);
    expect(cleared.code, cleared.err).toBe(0);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ soakMinutes: 15 });
    const after = await run(home, ["update", "--status"]);
    expect(after.out).toMatch(/window: any hour/);
  });

  it("update window refuses a malformed window", async () => {
    const home = freshHome();
    const config = configOf(home);
    mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
    const seeded = `${JSON.stringify({ channel: "latest", window: "02:00-06:00" }, null, 2)}\n`;
    writeFileSync(config, seeded, { mode: 0o600 });
    for (const word of ["25:00-26:00", "2:00-6:00", "02:00", "02:00-06:00-07:00"]) {
      const r = await run(home, ["update", "window", word]);
      expect(r.code, word).toBe(64);
      expect(r.err, word).toMatch(/usage/);
      expect(readFileSync(config, "utf8"), word).toBe(seeded);
    }
  });

  it("an unset window is shown as \"any hour\" in --status", async () => {
    const home = freshHome();
    const text = await run(home, ["update", "--status"]);
    expect(text.code, text.err).toBe(0);
    expect(text.out).toMatch(/window: any hour/);
    expect(text.out).toMatch(/pin: none/);
    expect(text.out).not.toMatch(/window: none/);
    const json = await run(home, ["update", "--status", "--json"]);
    expect(UpdateStatusSchema.parse(JSON.parse(json.out)).window).toBeNull();
  });

  it("a window defers an automatic apply outside it and never one the principal asked for", async () => {
    const w = await world({ preStageB: true });
    const minutes = new Date().getHours() * 60 + new Date().getMinutes();
    const set = await w.run(["update", "window", `${hhmm(minutes + 10)}-${hhmm(minutes + 250)}`]);
    expect(set.code, set.err).toBe(0);
    const tick = await w.run(["update", "tick"], {}, { timing: SHORT });
    expect(tick.code, tick.err).toBe(75);
    expect(tick.err).toMatch(/window/);
    expect(w.current()).toBe(A);
    // Killed at the first start, which is after the swap: the Version is applied, and the probation wall is not
    // the question. A window deferral never reaches a start, so current would still be A.
    w.services.die.on = { op: "start" };
    w.services.runApplyScript = async version => {
      await w.run(["update", "apply", "--version", version], {}, { timing: SHORT });
    };
    const asked = await w.run(["update", "--yes", "--now"], {}, { timing: SHORT });
    expect(w.current(), asked.err).toBe(B);
    // The check's own sentence names the tick's window. The deferral is the parenthetical "(window)", and a
    // principal's --now does not meet it: the Version above is already current.
    expect(asked.err).not.toMatch(/\(window\)/);
  }, 60_000);

  it("MORNDO_DISABLE_UPDATES=1 blocks every path and MORNDO_DISABLE_AUTOUPDATE=1 only the background", async () => {
    const blocked = await world({ preStageB: true });
    const off = { MORNDO_DISABLE_UPDATES: "1" };
    const check = await blocked.run(["update", "--check"], off);
    expect(check.code).toBe(78);
    expect(check.err).toMatch(/MORNDO_DISABLE_UPDATES/);
    const update = await blocked.run(["update", "--yes"], off);
    expect(update.code).toBe(78);
    expect(update.err).toMatch(/MORNDO_DISABLE_UPDATES/);
    expect(blocked.services.calls.filter(c => c.op === "runApply")).toEqual([]);
    const tick = await blocked.run(["update", "tick"], off);
    expect(tick.code, tick.err).toBe(0);
    expect(blocked.feed.calls.channels).toEqual([]);
    const boot = await blocked.run(["update", "boot"], off);
    expect(boot.code, boot.err).toBe(0);
    expect(blocked.current()).toBe(A);
    expect(blocked.feed.calls.channels).toEqual([]);

    const background = await world({ preStageB: true });
    const held = { MORNDO_DISABLE_AUTOUPDATE: "1" };
    const quiet = await background.run(["update", "tick"], held);
    expect(quiet.code, quiet.err).toBe(0);
    expect(background.feed.calls.channels).toEqual([]);
    const bootOff = await background.run(["update", "boot"], held);
    expect(bootOff.code, bootOff.err).toBe(0);
    expect(background.current()).toBe(A);
    expect(background.feed.calls.channels).toEqual([]);
    background.artifacts.serve(background.b.name, { bytes: background.b.archive });
    const still = await background.run(["update", "--check"], held);
    expect(still.code, still.err).toBe(0);
    expect(background.feed.calls.channels).toEqual(["stable"]);
    background.services.runApplyScript = async () => {
      const unit = openUpdateStore({ db: background.paths.db, lock: background.paths.lock });
      unit.saveUpdate({
        id: "upd-unit", kind: "update", target: parseVersion(B)!,
        preUpdate: { current: parseVersion(A)!, previous: null },
        state: "staged", mark: null, backups: [], migrations: null,
        format: 1, startedAt: Date.now(), doneMarks: [], judgeBaseline: null, backupOf: null, attempt: null,
      });
      unit.finishUpdate("upd-unit", "committed", Date.now());
      unit.close();
    };
    const goes = await background.run(["update", "--yes"], held);
    expect(goes.code, goes.err).toBe(0);
    expect(goes.out).toMatch(/Committed/);
  }, 60_000);

  it("a settings file that is not the settings shape is refused and left untouched by every settings command", async () => {
    const home = freshHome();
    const config = configOf(home);
    mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
    const bad = "{ not json\n";
    writeFileSync(config, bad, { mode: 0o600 });
    for (const argv of SETTINGS) {
      const r = await run(home, [...argv]);
      expect(r.code, JSON.stringify(argv)).toBe(78);
      expect(readFileSync(config, "utf8"), JSON.stringify(argv)).toBe(bad);
    }
    const unknown = `${JSON.stringify({ channel: "stable", extra: true })}\n`;
    writeFileSync(config, unknown, { mode: 0o600 });
    for (const argv of SETTINGS) {
      const r = await run(home, [...argv]);
      expect(r.code, `unknown ${JSON.stringify(argv)}`).toBe(78);
      expect(readFileSync(config, "utf8"), JSON.stringify(argv)).toBe(unknown);
    }
  });

  it("settings commands save under a switch and say the switch still holds", async () => {
    const home = freshHome();
    const config = configOf(home);
    const updates = await run(home, ["update", "--channel", "latest"], { MORNDO_DISABLE_UPDATES: "1" });
    expect(updates.code, updates.err).toBe(0);
    expect(JSON.parse(readFileSync(config, "utf8")).channel).toBe("latest");
    expect(updates.out).toMatch(/MORNDO_DISABLE_UPDATES/);
    const auto = await run(home, ["update", "auto", "stage"], { MORNDO_DISABLE_AUTOUPDATE: "1" });
    expect(auto.code, auto.err).toBe(0);
    expect(JSON.parse(readFileSync(config, "utf8"))).toMatchObject({ channel: "latest", mode: "stage" });
    expect(auto.out).toMatch(/MORNDO_DISABLE_AUTOUPDATE/);
  });

  it("the settings write is atomic and private", async () => {
    const home = freshHome();
    const config = configOf(home);
    const r = await run(home, ["update", "--channel", "latest"]);
    expect(r.code, r.err).toBe(0);
    const dir = dirname(config);
    expect(statSync(config).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir).filter(name => name !== "config.json")).toEqual([]);
  });
});
