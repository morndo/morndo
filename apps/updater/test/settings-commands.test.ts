// The settings commands (design §8.1, §8.3): `update --channel`, `auto`, `pin`, `unpin` and `window`. Each is one
// command alone. The file tests run over a scratch HOME the way cli.test.ts does; the ones that need a feed reuse
// cli-apply.test.ts's world — a real install, a signed feed offering a higher Version, the machine's services faked.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { writeFloor } from "@morndo/service-kit";
import { parseVersion, PROBATION_MS, type UpdateService } from "@morndo/domain";
import { UpdateStatusSchema } from "@morndo/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApplyTiming } from "../src/application/apply-steps.ts";
import { configLockHooks, configLockWaitMs } from "../src/adapters/config-file.ts";
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
  /** B plus any extra feed Versions this world was asked for. */
  releases: ReleaseFixture[];
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
async function world(o: { running?: UpdateService[]; preStageB?: boolean; also?: readonly string[] } = {}): Promise<World> {
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
  // `also` puts more Versions on the feed beside B (one above it, one below A), built the same way.
  const extras = (o.also ?? []).map(version => releaseFixture({ version, now: NOW - 3 * DAY }));
  const releases = [...extras, b];
  const feed = feedOf(keys, releases);
  const artifacts = new FakeArtifacts(paths.downloads);
  const fleet = new FakeFleetView();
  fleet.nodesWord = [];
  const w: World = {
    home, paths, store, services, feed, artifacts, b, releases,
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

  it("the pin sentence says what the pin does at, above and below the running Version", async () => {
    const w = await world();
    const at = await w.run(["update", "pin", A]);
    expect(at.code, at.err).toBe(0);
    expect(at.out).toBe(
      "Pin set from none to 0.1.0; this machine is held at 0.1.0: it takes no other Version.\n",
    );
    const above = await w.run(["update", "pin", B]);
    expect(above.code, above.err).toBe(0);
    expect(above.out).toBe(
      "Pin set from 0.1.0 to 0.2.0; the next check moves this machine up to 0.2.0 if the feed lists it (skipping the Versions in between), then holds it there; a pin the feed does not list leaves the machine where it is.\n",
    );
    const below = await w.run(["update", "pin", "0.0.9"]);
    expect(below.code, below.err).toBe(0);
    expect(below.out).toBe(
      "Pin set from 0.2.0 to 0.0.9; 0.0.9 is below the running 0.1.0: a pin never moves a machine down (RL2), so 0.1.0 stays and no other Version is taken; morndo update --rollback goes back one Version.\n",
    );
    const plain = freshHome();
    const none = await run(plain, ["update", "pin", "1.2.3"]);
    expect(none.code, none.err).toBe(0);
    expect(none.out).toBe(
      "Pin set from none to 1.2.3; this install is not managed by the updater, so the pin has no effect here.\n",
    );
  });

  it("a pin above the running Version is reached by the next check, not the newest Version", async () => {
    const w = await world({ also: ["0.3.0"] });
    for (const release of w.releases) w.artifacts.serve(release.name, { bytes: release.archive });
    const set = await w.run(["update", "pin", B]);
    expect(set.code, set.err).toBe(0);
    const check = await w.run(["update", "--check"]);
    expect(check.code, `${check.out}\n${check.err}`).toBe(0);
    expect(check.out).toMatch(/Staged 0\.2\.0/);
    expect(check.out).not.toMatch(/0\.3\.0/);
    expect(w.store.staged()?.version).toBe(B);
    // The domain's probation is sixty seconds (judgeProbation); a shorter wall rolls the apply back as not_up.
    const tick = await w.run(["update", "tick"], {}, { timing: { ...SHORT, probationMs: PROBATION_MS } });
    expect(tick.code, `${tick.out}\n${tick.err}`).toBe(0);
    expect(w.current()).toBe(B);
  }, 120_000);

  it("a pin below the running Version holds the machine where it is", async () => {
    const w = await world({ also: ["0.0.9"] });
    for (const release of w.releases) w.artifacts.serve(release.name, { bytes: release.archive });
    const set = await w.run(["update", "pin", "0.0.9"]);
    expect(set.code, set.err).toBe(0);
    const check = await w.run(["update", "--check"]);
    expect(check.code, `${check.out}\n${check.err}`).toBe(0);
    expect(`${check.out}${check.err}`).toMatch(/Up to date/);
    expect(w.store.staged()).toBeNull();
    expect(w.current()).toBe(A);
  }, 60_000);

  it("a pin the feed does not list leaves the machine where it is", async () => {
    const w = await world();
    w.artifacts.serve(w.b.name, { bytes: w.b.archive });
    const set = await w.run(["update", "pin", "0.1.5"]);
    expect(set.code, set.err).toBe(0);
    const check = await w.run(["update", "--check"]);
    expect(check.code, `${check.out}\n${check.err}`).toBe(0);
    expect(`${check.out}${check.err}`).toMatch(/pinned/);
    expect(w.store.staged()).toBeNull();
    expect(w.current()).toBe(A);
  }, 60_000);

  it("four settings commands at once lose no update", async () => {
    const home = freshHome();
    const root = process.cwd();
    const commands = [
      ["update", "--channel", "latest"],
      ["update", "auto", "stage"],
      ["update", "pin", "0.2.0"],
      ["update", "window", "02:00-06:00"],
    ];
    const runs = commands.map(argv => new Promise<{ code: number; out: string; err: string }>((resolve, reject) => {
      const proc = spawn(process.execPath, ["apps/updater/src/main.ts", ...argv], {
        cwd: root,
        env: { ...process.env, HOME: home },
      });
      let out = "";
      let err = "";
      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => { out += chunk; });
      proc.stderr.on("data", (chunk: string) => { err += chunk; });
      proc.on("error", reject);
      proc.on("close", code => resolve({ code: code ?? 1, out, err }));
    }));
    const results = await Promise.all(runs);
    for (const r of results) expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    expect(JSON.parse(readFileSync(configOf(home), "utf8"))).toEqual({
      channel: "latest", mode: "stage", pin: "0.2.0", window: "02:00-06:00",
    });
  }, 60_000);

  it("a fresh lock held by another command times out with one sentence and exit 75", async () => {
    const home = freshHome();
    const config = configOf(home);
    mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
    const seeded = `${JSON.stringify({ channel: "stable" }, null, 2)}\n`;
    writeFileSync(config, seeded, { mode: 0o600 });
    const lock = `${config}.lock`;
    writeFileSync(lock, "", { mode: 0o600 });
    const previous = configLockWaitMs.ms;
    configLockWaitMs.ms = 50;
    try {
      const r = await run(home, ["update", "--channel", "latest"]);
      expect(r.code, r.err).toBe(75);
      expect(r.err.trim().split("\n")).toHaveLength(1);
      expect(r.err).toBe(`another settings command holds ${lock}; try again\n`);
      expect(readFileSync(config, "utf8")).toBe(seeded);
      expect(existsSync(lock)).toBe(true);
    } finally {
      configLockWaitMs.ms = previous;
    }
  });

  it("a stale lock is taken over", async () => {
    const home = freshHome();
    const config = configOf(home);
    mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
    const lock = `${config}.lock`;
    writeFileSync(lock, "", { mode: 0o600 });
    const minuteAgo = new Date(Date.now() - 60_000);
    utimesSync(lock, minuteAgo, minuteAgo);
    const r = await run(home, ["update", "--channel", "latest"]);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(lock)).toBe(false);
    expect(JSON.parse(readFileSync(config, "utf8")).channel).toBe("latest");
  });

  it("a waiter that finds a stale lock already replaced does not take the live lock", async () => {
    const home = freshHome();
    const config = configOf(home);
    mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
    const seeded = `${JSON.stringify({ channel: "stable" }, null, 2)}\n`;
    writeFileSync(config, seeded, { mode: 0o600 });
    const lock = `${config}.lock`;
    writeFileSync(lock, "", { mode: 0o600 });
    const minuteAgo = new Date(Date.now() - 60_000);
    utimesSync(lock, minuteAgo, minuteAgo);
    const previousWait = configLockWaitMs.ms;
    const previousHook = configLockHooks.afterStaleSeen;
    configLockWaitMs.ms = 50;
    configLockHooks.afterStaleSeen = () => {
      rmSync(lock);
      writeFileSync(lock, "live\n", { mode: 0o600 });
    };
    try {
      const r = await run(home, ["update", "auto", "off"]);
      expect(r.code, r.err).toBe(75);
      expect(r.err.trim().split("\n")).toHaveLength(1);
      expect(r.err).toBe(`another settings command holds ${lock}; try again\n`);
      expect(readFileSync(config, "utf8")).toBe(seeded);
      expect(readFileSync(lock, "utf8")).toBe("live\n");
    } finally {
      configLockWaitMs.ms = previousWait;
      if (previousHook === undefined) delete configLockHooks.afterStaleSeen;
      else configLockHooks.afterStaleSeen = previousHook;
    }
  });

  it("taking over a stale lock leaves no claimed file behind", async () => {
    const home = freshHome();
    const config = configOf(home);
    const dir = dirname(config);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = `${config}.lock`;
    writeFileSync(lock, "", { mode: 0o600 });
    const minuteAgo = new Date(Date.now() - 60_000);
    utimesSync(lock, minuteAgo, minuteAgo);
    const previousWait = configLockWaitMs.ms;
    const previousHook = configLockHooks.afterStaleSeen;
    configLockWaitMs.ms = 50;
    try {
      const r = await run(home, ["update", "auto", "off"]);
      expect(r.code, r.err).toBe(0);
      expect(JSON.parse(readFileSync(config, "utf8")).mode).toBe("off");
      expect(readdirSync(dir).filter(name => name === "config.json.lock" || name.startsWith("config.json.lock.stale."))).toEqual([]);
    } finally {
      configLockWaitMs.ms = previousWait;
      if (previousHook === undefined) delete configLockHooks.afterStaleSeen;
      else configLockHooks.afterStaleSeen = previousHook;
    }
  });

  it("a settings write that cannot be made is one sentence, exit 78 or 75, and leaves no temp file", async () => {
    const home = freshHome();
    const config = configOf(home);
    const dir = dirname(config);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const seeded = `${JSON.stringify({ channel: "stable" }, null, 2)}\n`;
    writeFileSync(config, seeded, { mode: 0o600 });
    chmodSync(dir, 0o500);
    try {
      const r = await run(home, ["update", "--channel", "latest"]);
      expect(r.code, r.err).toBe(78);
      expect(r.err.trim().split("\n")).toHaveLength(1);
      expect(r.err).toContain(config);
      expect(r.err).toMatch(/could not write/);
      expect(r.err).toMatch(/EACCES/);
      expect(readFileSync(config, "utf8")).toBe(seeded);
      expect(readdirSync(dir).filter(name => name.includes(".tmp") || name.endsWith(".lock"))).toEqual([]);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("a leftover config.json.tmp from an older write does not matter", async () => {
    const home = freshHome();
    const config = configOf(home);
    mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
    const stray = `${config}.tmp`;
    writeFileSync(stray, "older\n", { mode: 0o600 });
    const r = await run(home, ["update", "--channel", "latest"]);
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(stray, "utf8")).toBe("older\n");
    expect(JSON.parse(readFileSync(config, "utf8")).channel).toBe("latest");
  });

  it("a window whose start equals its end is refused", async () => {
    const home = freshHome();
    const config = configOf(home);
    mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
    const seeded = `${JSON.stringify({ channel: "stable", window: "02:00-06:00" }, null, 2)}\n`;
    writeFileSync(config, seeded, { mode: 0o600 });
    for (const word of ["03:00-03:00", "00:00-00:00"]) {
      const r = await run(home, ["update", "window", word]);
      expect(r.code, `${word} ${r.err}`).toBe(64);
      expect(r.err, word).toMatch(/window any/);
      expect(r.err.trim().split("\n"), word).toHaveLength(1);
      expect(readFileSync(config, "utf8"), word).toBe(seeded);
    }
  });
});
