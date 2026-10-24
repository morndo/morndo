// `morndo update --to <version>` (design §8.1, §8.4, RL1, RL2, RL11): a named Version the machine's own channel
// feed lists. The world is the apply tests' — a real install over a throwaway HOME, the real store, faked services
// and a feed signed by the fixtures — so a staging is a Version the installer really promoted.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseVersion, type UpdateService } from "@morndo/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { updaterPaths } from "../src/adapters/paths.ts";
import { openUpdateStore, type SqliteUpdateStore } from "../src/adapters/store-sqlite.ts";
import { DirsInstaller } from "../src/adapters/installer-dirs.ts";
import { FRESH_VIEW_MS } from "../src/application/fleet-follow.ts";
import { CHECKOUT_SENTENCE } from "../src/application/check-service.ts";
import type { FleetWord } from "../src/application/ports.ts";
import { runUpdater } from "../src/cli.ts";
import { Die, FakeProbe, FakeServices, A } from "./helpers/apply-fakes.ts";
import { FakeArtifacts, FakeFeed, FakeFleetView, wipe } from "./helpers/fakes.ts";
import {
  doctoredFeed, feedFixture, keySetDocument, makeKeys, manifestSignature, releaseFixture, type ReleaseFixture,
} from "./helpers/release-fixtures.ts";

const DAY = 24 * 3600_000;
const YEAR = 365 * DAY;

let scratch = "";
let made = 0;
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "morndo-upd-")); });
afterAll(() => { wipe(scratch); });

type World = {
  home: string;
  paths: ReturnType<typeof updaterPaths>;
  store: SqliteUpdateStore;
  services: FakeServices;
  feed: FakeFeed;
  artifacts: FakeArtifacts;
  fleet: FakeFleetView;
  run(argv: string[], env?: Record<string, string | undefined>): Promise<{ code: number; out: string; err: string }>;
};

// Version A installed and current; the channel feed lists `versions` (signed, served). A control plane unless
// `running` says otherwise — the node's RL11 gate is the cases that pass `["node"]`.
async function world(o: { versions: string[]; running?: UpdateService[]; withdrawn?: string[] }): Promise<World> {
  const home = join(scratch, `home-${(made += 1)}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const paths = updaterPaths(home);
  const keys = makeKeys();
  const keySet = keySetDocument(keys, { version: 1, expiresAt: Date.now() + 20 * YEAR });
  const listed = [...new Set(o.versions)];
  const fixtures = new Map<string, ReleaseFixture>();
  for (const version of new Set([A, ...listed])) {
    fixtures.set(version, releaseFixture({ version, now: Date.now() - DAY }));
  }
  const installer = new DirsInstaller({ releases: paths.releases });
  const install = async (fixture: ReleaseFixture): Promise<void> => {
    const archive = join(home, `${fixture.version}.tar.gz`);
    writeFileSync(archive, fixture.archive);
    const unpacked = await installer.unpack(archive, fixture.version, { filesSha256: fixture.filesSha256, maxBytes: 1 << 20 });
    if (!unpacked.ok) throw new Error(`${fixture.version} did not unpack: ${unpacked.reason}`);
    installer.promote(fixture.version, { manifestSha256: fixture.manifestSha256, filesSha256: fixture.filesSha256, at: Date.now() });
    rmSync(archive, { force: true });
  };
  await install(fixtures.get(A)!);
  installer.swap({ current: A, previous: null });
  installer.setGood(A);
  const store = openUpdateStore({ db: paths.db, lock: paths.lock });
  store.saveTrust({ keySet: keySet.decoded, highestFeedSeq: { stable: 0, latest: 0 } });
  const releases = listed.map(version => fixtures.get(version)!);
  const published = feedFixture(keys, releases, { channel: "stable", now: Date.now() });
  const feed = new FakeFeed();
  feed.channels.set("stable", o.withdrawn === undefined ? published.served
    : doctoredFeed(keys, published.text, doc => { doc.withdrawn = o.withdrawn; }));
  for (const release of releases) {
    feed.manifests.set(release.manifestUrl, { bytes: release.manifestBytes, signature: manifestSignature(keys, release) });
  }
  const artifacts = new FakeArtifacts(paths.downloads);
  for (const release of releases) artifacts.serve(release.name, { bytes: release.archive });
  const fleet = new FakeFleetView();
  fleet.nodesWord = [];
  const tape: string[] = [];
  const services = new FakeServices({ tape, die: new Die(), currentOf: () => installer.layout().current, running: o.running });
  const probe = new FakeProbe({ tape, die: new Die(), currentOf: () => installer.layout().current });
  return {
    home, paths, store, services, feed, artifacts, fleet,
    run: async (argv, env = {}) => {
      const out: string[] = [], err: string[] = [];
      const code = await runUpdater(argv, { HOME: home, PATH: process.env.PATH, ...env }, {
        out: s => out.push(s), err: s => err.push(s),
      }, { services, probe, feed, artifacts, fleet });
      return { code, out: out.join(""), err: err.join("") };
    },
  };
}

const writeConfig = (w: World, doc: unknown): void => {
  mkdirSync(dirname(w.paths.config), { recursive: true });
  writeFileSync(w.paths.config, `${JSON.stringify(doc)}\n`);
};

const heard = (version: string, observedAt = Date.now()): FleetWord => ({
  observedAt,
  controlPlane: { version, commit: null },
  rollout: null,
  offer: null,
});

describe("morndo update --to <version> (§8.1, §8.4, RL11)", () => {
  it("--to stages exactly the named Version, not the highest the feed offers", async () => {
    const named = await world({ versions: ["0.1.0", "0.2.0", "0.3.0"] });
    const to = await named.run(["update", "--to", "0.2.0", "--check"]);
    expect(to.code, to.err).toBe(0);
    expect(named.store.staged()?.version).toBe("0.2.0");
    expect(named.services.calls.filter(c => c.op === "runApply")).toEqual([]);

    const bare = await world({ versions: ["0.1.0", "0.2.0", "0.3.0"] });
    const check = await bare.run(["update", "--check"]);
    expect(check.code, check.err).toBe(0);
    expect(bare.store.staged()?.version).toBe("0.3.0");
  });

  it("--to a Version the feed does not list is refused and stages nothing", async () => {
    const w = await world({ versions: ["0.2.0"] });
    const r = await w.run(["update", "--to", "0.9.0", "--check"]);
    expect(r.code).toBe(64);
    expect(r.err).toContain("0.9.0 is not in the stable feed (--to takes a Version the machine's own channel lists; switch with --channel first)");
    expect(w.store.staged()).toBeNull();
    expect(w.store.checks(1)[0]).toMatchObject({ outcome: "skipped", detail: "no_entry", version: "0.9.0" });
  });

  it("--to a withdrawn Version is refused", async () => {
    const w = await world({ versions: ["0.2.0"], withdrawn: ["0.2.0"] });
    const r = await w.run(["update", "--to", "0.2.0", "--check"]);
    expect(r.code).toBe(64);
    expect(r.err).toContain("0.2.0 was withdrawn; it is not offered");
    expect(w.store.staged()).toBeNull();
  });

  it("--to a lower Version is refused, and the sentence names --rollback", async () => {
    const w = await world({ versions: ["0.0.9", "0.2.0"] });
    const r = await w.run(["update", "--to", "0.0.9", "--check"]);
    expect(r.code).toBe(64);
    expect(r.err).toContain("0.0.9 is lower than the running 0.1.0; morndo update --rollback goes back to the previous Version");
    expect(w.store.staged()).toBeNull();
  });

  it("--to a Version below the highest this machine has run is refused plainly", async () => {
    const w = await world({ versions: ["0.1.0", "0.2.0", "0.5.0"] });
    w.store.recordCommitted("0.5.0", Date.now(), null);
    const r = await w.run(["update", "--to", "0.2.0", "--check"]);
    expect(r.code, r.err).toBe(64);
    expect(r.err).toContain("0.2.0 is at or below 0.5.0, the highest Version this machine has run; an apply never takes one (RL2); morndo update --rollback goes back one Version");
    expect(w.store.staged()).toBeNull();
    expect(w.store.versionRecord("0.2.0")).toBeNull();
    expect(w.feed.calls.channels).toEqual(["stable"]);
    expect(w.feed.calls.manifests).toEqual([]);
    expect(w.artifacts.calls).toEqual([]);
  });

  it("--to above the highest this machine has run is unaffected", async () => {
    const named = await world({ versions: ["0.1.0", "0.2.0", "0.3.0"] });
    named.store.recordCommitted("0.1.0", Date.now(), null);
    const to = await named.run(["update", "--to", "0.2.0", "--check"]);
    expect(to.code, to.err).toBe(0);
    expect(named.store.staged()?.version).toBe("0.2.0");
  });

  it("--to the running Version says it is already running", async () => {
    const w = await world({ versions: ["0.1.0", "0.2.0"] });
    const r = await w.run(["update", "--to", "0.1.0", "--check"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Up to date: 0.1.0 is already running.");
    expect(w.store.staged()).toBeNull();
  });

  it("--to under a pin is refused as pinned", async () => {
    const held = await world({ versions: ["0.2.0"] });
    writeConfig(held, { pin: "0.1.0" });
    const refused = await held.run(["update", "--to", "0.2.0", "--check"]);
    expect(refused.code).toBe(78);
    expect(refused.err).toContain("this machine is pinned to 0.1.0; morndo update unpin first");
    expect(held.store.staged()).toBeNull();

    const allowed = await world({ versions: ["0.2.0", "0.3.0"] });
    writeConfig(allowed, { pin: "0.2.0" });
    const r = await allowed.run(["update", "--to", "0.2.0", "--check"]);
    expect(r.code, r.err).toBe(0);
    expect(allowed.store.staged()?.version).toBe("0.2.0");
  });

  it("--to a Version marked bad here is refused", async () => {
    const w = await world({ versions: ["0.2.0"] });
    w.store.recordBad("0.2.0", Date.now());
    const r = await w.run(["update", "--to", "0.2.0", "--check"]);
    expect(r.code).toBe(64);
    expect(r.err).toContain("0.2.0 failed on this machine before and is not tried again");
    expect(w.store.staged()).toBeNull();
  });

  it("--to a halted rollout is refused", async () => {
    const w = await world({ versions: ["0.2.0"] });
    w.fleet.word = {
      observedAt: Date.now(),
      controlPlane: { version: "0.2.0", commit: null },
      rollout: {
        version: "0.2.0", controlPlaneCommittedAt: Date.now(), soakMinutes: 30,
        halted: true, haltedBy: "office-1", haltReason: "health", haltedAt: Date.now(),
      },
      offer: null,
    };
    const r = await w.run(["update", "--to", "0.2.0", "--check"]);
    expect(r.code).toBe(75);
    expect(r.err).toContain("the rollout of 0.2.0 is halted");
    expect(w.store.staged()).toBeNull();
  });

  it("--to above the control plane is refused on a node", async () => {
    const node = await world({ versions: ["0.0.9", "0.1.0", "0.2.0"], running: ["node"] });
    node.fleet.word = heard("0.1.0");
    const above = await node.run(["update", "--to", "0.2.0"]);
    expect(above.code).toBe(75);
    expect(above.err).toContain("0.2.0 is above the control plane (0.1.0); a node is never newer than its control plane (RL11)");
    expect(node.feed.calls.channels).toEqual([]);
    expect(node.feed.calls.keySets).toEqual([]);
    expect(node.artifacts.calls).toEqual([]);
    expect(node.store.staged()).toBeNull();

    const at = await node.run(["update", "--to", "0.1.0", "--check"]);
    expect(at.code, at.err).toBe(0);
    expect(at.out).toContain("Up to date: 0.1.0 is already running.");
    expect(at.err).not.toMatch(/RL11/);

    const lower = await node.run(["update", "--to", "0.0.9", "--check"]);
    expect(lower.code).toBe(64);
    expect(lower.err).toContain("--rollback");
    expect(lower.err).not.toMatch(/above the control plane|has not told this node/);

    const quiet = await world({ versions: ["0.2.0"], running: ["node"] });
    const none = await quiet.run(["update", "--to", "0.2.0"]);
    expect(none.code).toBe(75);
    expect(none.err).toContain("the fleet has not told this node its control plane, so --to waits (RL11)");
    expect(quiet.feed.calls.channels).toEqual([]);

    quiet.fleet.word = heard("0.2.0", Date.now() - FRESH_VIEW_MS);
    const stale = await quiet.run(["update", "--to", "0.2.0"]);
    expect(stale.code).toBe(75);
    expect(stale.err).toContain("the fleet has not told this node its control plane, so --to waits (RL11)");
    expect(quiet.feed.calls.channels).toEqual([]);

    const plane = await world({ versions: ["0.2.0"], running: ["hub", "fleet"] });
    const same = await plane.run(["update", "--to", "0.2.0", "--check"]);
    expect(same.code, same.err).toBe(0);
    expect(same.err).not.toMatch(/RL11/);
    expect(plane.store.staged()?.version).toBe("0.2.0");
  });

  it("MORNDO_DISABLE_UPDATES=1 wins over the node gate: --to answers the switch, not the fleet", async () => {
    const node = await world({ versions: ["0.1.0", "0.2.0"], running: ["node"] });
    node.fleet.word = heard("0.1.0");
    const r = await node.run(["update", "--to", "0.2.0", "--check"], { MORNDO_DISABLE_UPDATES: "1" });
    expect(r.code, r.err).toBe(78);
    expect(r.err).toContain("MORNDO_DISABLE_UPDATES");
    expect(r.err).not.toMatch(/RL11|above the control plane/);
    expect(node.store.staged()).toBeNull();
  });

  it("a --to run applies only the Version it names, even when a higher one stood staged", async () => {
    const w = await world({ versions: ["0.2.0", "0.3.0"] });
    const earlier = await w.run(["update", "--check"]);
    expect(earlier.code, earlier.err).toBe(0);
    expect(w.store.staged()?.version).toBe("0.3.0");
    w.services.runApplyScript = async version => {
      const unit = openUpdateStore({ db: w.paths.db, lock: w.paths.lock });
      unit.saveUpdate({
        id: "upd-to", kind: "update", target: parseVersion(version)!, preUpdate: { current: parseVersion(A)!, previous: null },
        state: "staged", mark: null, backups: [], migrations: null,
        format: 1, startedAt: Date.now(), doneMarks: [], judgeBaseline: null, backupOf: null, attempt: null,
      });
      unit.finishUpdate("upd-to", "committed", Date.now());
      unit.close();
    };
    const r = await w.run(["update", "--to", "0.2.0", "--yes"]);
    expect(r.code, r.err).toBe(0);
    expect(w.store.staged()?.version).toBe("0.2.0");
    expect(w.services.calls.filter(c => c.op === "runApply")).toEqual([{ op: "runApply", version: "0.2.0", wait: true }]);
  });

  it("--to with no value, a word that is not a Version, a second --to or another command is usage", async () => {
    const home = join(scratch, `usage-${(made += 1)}`);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const feed = new FakeFeed();
    const paths = updaterPaths(home);
    const run = async (argv: string[]) => {
      const out: string[] = [], err: string[] = [];
      const code = await runUpdater(argv, { HOME: home, PATH: process.env.PATH }, {
        out: s => out.push(s), err: s => err.push(s),
      }, { feed });
      return { code, out: out.join(""), err: err.join("") };
    };
    for (const argv of [
      ["update", "--to"],
      ["update", "--to", "nope"],
      ["update", "--to", "0.2"],
      ["update", "--to", "0.2.0", "--to", "0.3.0"],
      ["update", "--to", "0.2.0", "--rollback"],
      ["update", "--to", "0.2.0", "pin", "0.2.0"],
      ["update", "--to", "0.2.0", "--staged", "0.2.0"],
      ["update", "--to", "0.2.0", "--channel", "latest"],
      ["update", "--to", "0.2.0", "--status"],
      ["update", "--to", "0.2.0", "window"],
      ["update", "--to", "0.2.0", "auto", "apply"],
    ]) {
      const r = await run(argv);
      expect(r.code, JSON.stringify(argv)).toBe(64);
      expect(r.err, JSON.stringify(argv)).toMatch(/usage:/);
      expect(r.out, JSON.stringify(argv)).toBe("");
    }
    expect(feed.calls.channels).toEqual([]);
    expect(feed.calls.keySets).toEqual([]);
    expect(existsSync(paths.state)).toBe(false);
    expect(existsSync(paths.releases)).toBe(false);
  });

  it("MORNDO_DISABLE_UPDATES=1 refuses --to (78) and --to on a checkout is not ours (78)", async () => {
    const home = join(scratch, `checkout-${(made += 1)}`);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const feed = new FakeFeed();
    const run = async (env: Record<string, string> = {}) => {
      const out: string[] = [], err: string[] = [];
      const code = await runUpdater(["update", "--to", "0.2.0"], { HOME: home, PATH: process.env.PATH, ...env }, {
        out: s => out.push(s), err: s => err.push(s),
      }, { feed });
      return { code, out: out.join(""), err: err.join("") };
    };
    const disabled = await run({ MORNDO_DISABLE_UPDATES: "1" });
    expect(disabled.code).toBe(78);
    expect(disabled.err).toMatch(/MORNDO_DISABLE_UPDATES/);
    const checkout = await run();
    expect(checkout.code).toBe(78);
    expect(checkout.err).toContain(CHECKOUT_SENTENCE);
    expect(feed.calls.channels).toEqual([]);
  });

  it("a plain check is unchanged by the --to work", async () => {
    const pinned = await world({ versions: ["0.2.0"] });
    writeConfig(pinned, { pin: "0.1.0" });
    const pin = await pinned.run(["update", "--check"]);
    expect(pin.code, pin.err).toBe(0);
    expect(pin.out).toContain("Skipped: pinned. Nothing was staged.");

    const withdrawn = await world({ versions: ["0.2.0"], withdrawn: ["0.2.0"] });
    const gone = await withdrawn.run(["update", "--check"]);
    expect(gone.code, gone.err).toBe(0);
    expect(gone.out).toMatch(/Up to date: 0\.1\.0/);
    expect(gone.err).not.toMatch(/was withdrawn/);
  });
});
