// The check-and-stage chain end to end (design §6.1, §10.2, §13; RL1–RL3): the real CLI against a real HTTPS feed on
// 127.0.0.1 — a throwaway certificate authority Node itself checks, joined to the trusted roots through
// NODE_EXTRA_CA_CERTS ("the well known root CAs ... will be extended with the extra certificates", Node 24 CLI docs,
// https://nodejs.org/docs/latest-v24.x/api/cli.html#node_extra_ca_certsfile, read 2026-10-21) — keys and signatures
// from the real ssh-keygen, archives and documents from the release pipeline's own writers. Every fault case is a
// feed, a manifest or an archive that lies in exactly one place; the assertions are the chain's own word (the JSON
// outcome), what landed on the disk, and what did not.
//
// The test worker hosts the feed directory (helpers/e2e-server.ts) on its own HTTPS server, and the program runs as
// its own process: src/main.ts spawned exactly as a user runs it. Nothing below the CLI is faked.
// Nothing here is committed: keys, certificates and homes are made at run time under one scratch directory this
// file removes.
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FeedEntry } from "@morndo/domain";
import { UpdateStatusSchema } from "@morndo/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TreeFile } from "../../../scripts/release/archive.ts";
import { publishRelease } from "../../../scripts/release/feed.ts";
import { listFiles } from "../../../scripts/release/files.ts";
import { canonicalJson, isoUtc } from "../../../scripts/release/json.ts";
import { artifactName, buildManifest } from "../../../scripts/release/manifest.ts";
import { updaterPaths } from "../src/adapters/paths.ts";
import { openUpdateStore } from "../src/adapters/store-sqlite.ts";
import { fingerprintOfPublicKeyLine } from "../src/adapters/verifier-sshsig.ts";
import { FEED_NAMESPACE, KEYS_NAMESPACE, RELEASE_NAMESPACE } from "../src/application/namespaces.ts";
import { platformWord } from "../src/cli.ts";
import { wipe } from "./helpers/fakes.ts";
import { diskFeed, type DiskFeed } from "./helpers/e2e-server.ts";
import { packWithList } from "./helpers/tar-fixtures.ts";
import { makeTestCa, serveHttps, type TestServer } from "./helpers/tls.ts";

const YEAR = 365 * 24 * 3600_000;
const DAY = 24 * 3600_000;
const A = "0.1.0";                        // the installed Version, current
const B = "0.2.0";                        // the offered Version
// The artifact is for this machine's platform, mapped exactly as the CLI maps it; elsewhere there is nothing to
// fetch and the suite below skips itself. The fallback word only names paths a skipped run never serves.
const platform = platformWord(process.platform, process.arch);
const word = platform ?? "linux-x64";
const bin = (version: string) => `#!/bin/sh\necho ${version}\n`;
const sha256hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Both trees are plain files (no links, no listed directories): what a release archive of this shape carries.
type PlainTree = Extract<TreeFile, { bytes: Uint8Array }>[];

const B_TREE: PlainTree = [
  { path: "README.md", mode: "0444", bytes: Buffer.from(`morndo ${B}\n`) },
  { path: "bin/morndo", mode: "0555", bytes: Buffer.from(bin(B)) },
];

// ---- keys and signatures, from the real tools (§9.4, §10.1): Ed25519 keys from ssh-keygen, documents signed in place

let scratch = "";
let feedHost!: DiskFeed;                  // the directory that is the host (helpers/e2e-server.ts)
let base = "";                            // the feed's own address, the same in every document
let port = 0;
let caPath = "";

type Role = "root1" | "root2" | "release" | "feed" | "stranger";
const keys = {} as Record<Role, { path: string; fingerprint: string }>;

const makeKey = (role: Role): void => {
  const path = join(scratch, "keys", role);
  const made = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `morndo-test-${role}`, "-f", path], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`ssh-keygen -t: ${made.stderr}`);
  keys[role] = { path, fingerprint: fingerprintOfPublicKeyLine(readFileSync(`${path}.pub`, "utf8")) };
};

let signCount = 0;
const sign = (bytes: Buffer, role: Role, namespace: string): Buffer => {
  const payload = join(scratch, `sign-${signCount += 1}`);
  rmSync(`${payload}.sig`, { force: true });                 // a stale .sig would be read as this one's
  writeFileSync(payload, bytes, { mode: 0o600 });
  const made = spawnSync("ssh-keygen", ["-Y", "sign", "-f", keys[role].path, "-n", namespace, payload], { encoding: "utf8" });
  try {
    if (made.status !== 0) throw new Error(`ssh-keygen -Y sign: ${made.stderr}`);
    return readFileSync(`${payload}.sig`);
  } finally {
    rmSync(payload, { force: true });
    rmSync(`${payload}.sig`, { force: true });
  }
};

// A key set document (§9.6): root's own, with the roles that stay fixed and root itself the rotating one.
const keySetDoc = (o: { version: number; root: readonly string[]; expiresAt: number }): string => canonicalJson({
  schema: 1 as const, version: o.version, expiresAt: isoUtc(o.expiresAt), root: o.root,
  release: [keys.release.fingerprint], feed: [keys.feed.fingerprint],
});

// The shipped anchor (§10.1): key set 1, root1's, live for the whole run. A's tree ships it as trust/keys.json and
// the host publishes the same bytes; the two cannot disagree because they are one document made once.
let anchorText = "";

// ---- Version A: an install as the updater leaves it (§5), read-only, with its signed list and shipped trust

const TREE_A = (): PlainTree => [
  { path: "README.md", mode: "0444", bytes: Buffer.from(`morndo ${A}\n`) },
  { path: "bin/morndo", mode: "0555", bytes: Buffer.from(bin(A)) },
  { path: "trust/keys.json", mode: "0444", bytes: Buffer.from(anchorText) },
];

// Every directory under root, deepest first: a promotion makes them 0555 bottom-up (§5), so the fixture does too.
const dirsDeepestFirst = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    out.push(dir);
    for (const dirent of readdirSync(dir, { withFileTypes: true })) if (dirent.isDirectory()) walk(join(dir, dirent.name));
  };
  walk(root);
  return out.reverse();
};

let made = 0;
const makeHome = (o: { install?: boolean } = {}): string => {
  made += 1;
  const home = join(scratch, `home-${made}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (o.install === false) return home;                       // a checkout: nothing installed at all

  const tree = TREE_A();
  const listed = listFiles(tree);
  const manifestSha256 = "ab".repeat(32);                     // made up: A's manifest is long gone; only the record keeps its digest
  const vdir = join(updaterPaths(home).releases, A);
  for (const file of tree) {
    const full = join(vdir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.bytes);
    chmodSync(full, parseInt(file.mode, 8));
  }
  writeFileSync(join(vdir, "files.json"), listed.json);
  chmodSync(join(vdir, "files.json"), 0o444);
  writeFileSync(join(vdir, "install.json"), `${JSON.stringify({
    method: "updater", installedAt: isoUtc(Date.now()), manifestSha256, filesSha256: listed.sha256,
  }, null, 2)}\n`);
  chmodSync(join(vdir, "install.json"), 0o444);
  for (const dir of dirsDeepestFirst(vdir)) chmodSync(dir, 0o555);
  symlinkSync(A, join(updaterPaths(home).releases, "current"));

  // A machine the updater updated once: update.db holds A's own record, so the doctor can re-verify it (§8.1).
  const paths = updaterPaths(home);
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  const store = openUpdateStore({ db: paths.db, lock: paths.lock });
  try { store.recordStaged({
    version: A, manifestSha256, filesSha256: listed.sha256, at: Date.now(),
    manifest: `${JSON.stringify({ schema: 1, product: "morndo", version: A }, null, 2)}\n`,   // made up, like the digest
  }); }
  finally { store.close(); }
  return home;
};

// ---- Version B and the standard world: one release, every document consistent, served under the feed's own address

const manifestPath = `/releases/${B}/manifest.json`;
const archivePath = `/releases/${B}/${artifactName(B, word)}`;

// The manifest for an archive of B: made-up provenance, this platform's one artifact pinned to the archive's own
// size and digest — the document a real pipeline would publish for exactly these bytes.
const manifestFor = (archive: Buffer): string => buildManifest({
  version: B,
  commit: "0123456789abcdef0123456789abcdef01234567",
  publishedAt: Date.now(),
  repository: "example/morndo",
  protocol: { agent: [1, 2], clientApi: [1, 1] },
  schemas: { hub: { version: 3, floor: 1 }, fleet: { version: 2, floor: 0 }, node: { version: 2, floor: 0 }, connections: { version: 1, floor: 0 } },
  artifacts: [{ platform: word, name: artifactName(B, word), size: archive.length, sha256: sha256hex(archive), filesSha256: listFiles(B_TREE).sha256, node: "24.21.0" }],
});

const entryFor = (manifestBytes: Buffer): FeedEntry => ({
  version: B, manifest: `${base}releases/${B}/manifest.json`,
  manifestSize: manifestBytes.length, manifestSha256: sha256hex(manifestBytes),
});

// A feed entry whose Version nobody reaches (below current, or a placeholder): its URL is never fetched.
const dummyEntry = (version: string): FeedEntry => ({
  version, manifest: `${base}releases/${version}/manifest.json`, manifestSize: 10, manifestSha256: "0".repeat(64),
});

let standardManifest = "";                 // the standard world's manifest and archive, built once and always served whole
let standardArchive: Buffer = Buffer.alloc(0);

const put = (path: string, body: Buffer, cutAt?: number): void => { feedHost.put(path, body, cutAt); };
const unput = (path: string): void => { feedHost.unput(path); };
const putSignedDoc = (path: string, text: string, sig: Buffer): void => { put(path, Buffer.from(text)); put(`${path}.sig`, sig); };

// Serve one release whole: its manifest signed by the release key, its archive, and a feed naming both. `prior` is
// the feed to publish on top of (its number carries over), `keySetVersion` what the feed names (§10.1's rotation).
const serveRelease = (manifestText: string, archive: Buffer, o: { prior?: string; keySetVersion?: number } = {}): void => {
  const manifestBytes = Buffer.from(manifestText);
  putSignedDoc(manifestPath, manifestText, sign(manifestBytes, "release", RELEASE_NAMESPACE));
  put(archivePath, archive);
  const feed = Buffer.from(publishRelease(o.prior ?? null, {
    channel: "stable", entry: entryFor(manifestBytes), now: Date.now(), keySetVersion: o.keySetVersion ?? 1,
  }));
  putSignedDoc("/stable.json", feed.toString(), sign(feed, "feed", FEED_NAMESPACE));
};

// A feed rewritten field by field and re-signed by the feed key: the doctored cases, one field per case.
const doctoredFeed = (text: string, patch: (doc: Record<string, unknown>) => void): { bytes: Buffer; sig: Buffer } => {
  const doc = JSON.parse(text) as Record<string, unknown>;
  patch(doc);
  const bytes = Buffer.from(canonicalJson(doc));
  return { bytes, sig: sign(bytes, "feed", FEED_NAMESPACE) };
};

type World = { reset(): void };
let world!: World;

// ---- the transport: a port nobody holds

// Pick a free port by asking the kernel, then letting it go: the feed's documents name it, and whichever process
// hosts the feed binds it for the length of a run. A race for it fails loudly (a bind error), never silently.
const pickPort = async (): Promise<number> => {
  const reserved = createNetServer();
  const port = await new Promise<number>((resolve, reject) => {
    reserved.once("error", reject);
    reserved.listen(0, "127.0.0.1", () => {
      const address = reserved.address();
      if (address === null || typeof address === "string") { reserved.close(); reject(new Error("no port to reserve")); return; }
      resolve(address.port);
    });
  });
  await new Promise<void>(done => reserved.close(() => done()));
  return port;
};

// ---- the program under test: its own process, as shipped

const program = join(import.meta.dirname, "../src/main.ts");

type RunResult = { status: number | null; stdout: string; stderr: string };

// Spawned asynchronously: the feed's server lives in this worker, and spawnSync would block the event loop that
// serves it, so the program would connect and never get an answer.
const run = (home: string, args: readonly string[], o: { ca?: boolean; tlsOff?: boolean; disabled?: boolean } = {}): Promise<RunResult> => {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    MORNDO_UPDATE_FEED: base,
    ...(o.ca === false ? {} : { NODE_EXTRA_CA_CERTS: caPath }),   // absent: the feed's CA is nobody's, the TLS case
    ...(o.tlsOff ? { NODE_TLS_REJECT_UNAUTHORIZED: "0" } : {}),
    ...(o.disabled ? { MORNDO_DISABLE_UPDATES: "1" } : {}),
  };
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--no-warnings", program, ...args], { env, encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== "number") { reject(error); return; }   // not an exit status: a spawn failure or the timeout
      resolve({ status: error === null ? 0 : (error.code as number), stdout, stderr });
    });
  });
};

type Outcome = { kind: string; step?: string; detail?: string; version?: string; current?: string; already?: boolean };
const outcomeOf = (r: { stdout: string }): Outcome => (JSON.parse(r.stdout) as { outcome: Outcome }).outcome;
const releasesOf = (home: string) => join(home, ".local/share/morndo-releases");
const downloadsOf = (home: string) => join(home, ".local/state/morndo-update/downloads");

// Nothing is left (§13: a failed staging leaves nothing): no promoted Version, no staging directory, no download.
const nothingLeft = (home: string): void => {
  expect(readdirSync(releasesOf(home)).filter(name => name === B || name.startsWith(".staging-")), "staged or staging").toEqual([]);
  const downloads = downloadsOf(home);
  if (existsSync(downloads)) expect(readdirSync(downloads), "downloads").toEqual([]);   // a feed-level refusal never opened one
};

// One refused case: fresh HOME, the standard world bent in exactly one way, exit 65 with the step's own name.
const refusedAt = async (step: string, bend: () => void): Promise<void> => {
  const home = makeHome();
  world.reset();
  bend();
  const r = await run(home, ["update", "--check", "--json"]);
  expect(r.status, `stderr: ${r.stderr}`).toBe(65);
  expect(outcomeOf(r)).toMatchObject({ kind: "refused", step });
  nothingLeft(home);
};

describe.skipIf(platform === null)("check and stage end to end (§6.1, §10.2, §13)", () => {
  let server: TestServer | undefined;       // the worker's own host, only where the machine allows the program its own process

  // Hooks inside the suite, so a machine with no build skips the keys, the server and the scratch directory whole.
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "morndo-upd-"));
    mkdirSync(join(scratch, "keys"), { recursive: true });
    for (const role of ["root1", "root2", "release", "feed", "stranger"] as const) makeKey(role);
    anchorText = keySetDoc({ version: 1, root: [keys.root1.fingerprint], expiresAt: Date.now() + YEAR });

    const tlsDir = join(scratch, "tls");
    mkdirSync(tlsDir, { recursive: true });
    const tls = makeTestCa(tlsDir);
    caPath = join(tlsDir, "extra-ca.pem");                    // absolute: NODE_EXTRA_CA_CERTS resolves relatives against CWD
    writeFileSync(caPath, tls.ca);

    port = await pickPort();
    base = `https://127.0.0.1:${port}/`;
    feedHost = diskFeed(join(scratch, "www"));
    standardArchive = packWithList(B_TREE, listFiles(B_TREE).json);
    standardManifest = manifestFor(standardArchive);

    // The test worker hosts the feed; the program is its own process, as shipped.
    server = await serveHttps({
      key: tls.serverKey, cert: tls.serverCert, port,
      handler: (req, res) => feedHost.handler(req, res),
    });

    const anchorBytes = Buffer.from(anchorText);
    const latest = Buffer.from(publishRelease(null, { channel: "latest", entry: dummyEntry("0.0.1"), now: Date.now(), keySetVersion: 1 }));
    world = {
      // The standard world back on the host: the good release, the anchor published as keys/1.json, an empty latest
      // feed, and no key set past v1 — every case that bends one of these starts from exactly this.
      reset: () => {
        serveRelease(standardManifest, standardArchive);
        putSignedDoc("/keys/1.json", anchorText, sign(anchorBytes, "root1", KEYS_NAMESPACE));
        putSignedDoc("/latest.json", latest.toString(), sign(latest, "feed", FEED_NAMESPACE));
        for (const path of ["/keys/2.json", "/keys/3.json"]) { unput(path); unput(`${path}.sig`); }
      },
    };
    world.reset();
  }, 120_000);

  afterAll(async () => {
    if (server !== undefined) await server.close();
    wipe(scratch);                                            // read-only trees included: wipe softens before it removes
  });

  it("RL1: a verified release is staged read-only with install.json, recorded, and the doctor is content", async () => {
    const home = makeHome();
    world.reset();
    const r = await run(home, ["update", "--check", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(outcomeOf(r)).toEqual({ kind: "staged", version: B, already: false });

    const vdir = join(releasesOf(home), B);
    expect(existsSync(join(vdir, "install.json"))).toBe(true);          // the promotion's own record
    expect(statSync(vdir).mode & 0o777).toBe(0o555);                    // read-only from promotion on (§5)
    expect(statSync(join(vdir, "install.json")).mode & 0o777).toBe(0o444);
    expect(readdirSync(downloadsOf(home))).toEqual([]);                 // the download went after the staging

    const store = openUpdateStore({ db: updaterPaths(home).db, lock: updaterPaths(home).lock });   // the real one
    try { expect(store.manifestOf(B)).toBe(standardManifest); }         // the Manifest's own text, kept with the record
    finally { store.close(); }

    const status = await run(home, ["update", "--status", "--json"]);
    expect(status.status, status.stderr).toBe(0);
    const s = UpdateStatusSchema.parse(JSON.parse(status.stdout));
    expect(s).toMatchObject({ installMethod: "updater", current: A, staged: B, channel: "stable" });
    expect(s.feed?.seq, "the feed's number").toBe(1);
    expect(s.keySet?.version, "the shipped anchor, now the store's own").toBe(1);

    const doc = await run(home, ["doctor"]);
    expect(doc.status, `${doc.stdout}${doc.stderr}`).toBe(0);
  }, 180_000);

  it("RL1: each fault is refused with the chain's own step, and leaves nothing behind", async () => {
    await refusedAt("artifact_digest", () => {                 // the bytes changed at the same size
      const flipped = Buffer.from(standardArchive);
      const at = Math.floor(flipped.length / 2);
      flipped[at] = (flipped[at] ?? 0) ^ 0xff;
      put(archivePath, flipped);
    });
    await refusedAt("artifact_size", () => {                   // the server promises the whole body, then cuts it
      put(archivePath, standardArchive, Math.floor(standardArchive.length / 2));
    });
    await refusedAt("manifest_signature", () => {              // signed, but by a key nobody trusts
      put(`${manifestPath}.sig`, sign(Buffer.from(standardManifest), "stranger", RELEASE_NAMESPACE));
    });
    await refusedAt("feed_signature", () => {                  // the feed signed by the release key
      put("/stable.json.sig", sign(readFileSync(join(feedHost.root, "stable.json")), "release", FEED_NAMESPACE));
    });
    await refusedAt("feed_namespace", () => {                  // the feed key, under the release namespace
      put("/stable.json.sig", sign(readFileSync(join(feedHost.root, "stable.json")), "feed", RELEASE_NAMESPACE));
    });
    await refusedAt("file_list", () => {                       // an extra file, with the manifest vouching for it
      const archive = packWithList([...B_TREE, { path: "extra.txt", mode: "0444", bytes: Buffer.from("smuggled\n") }], listFiles(B_TREE).json);
      serveRelease(manifestFor(archive), archive);
    });
  }, 300_000);

  it("RL2: an offer at or below current leaves the machine up to date, and a withdrawn offer is no offer", async () => {
    const home = makeHome();
    // only 0.0.9 and 0.1.0 on stable: nothing newer than what runs, so nothing is fetched beyond the feed
    let feed: string | null = null;
    for (const version of ["0.0.9", A]) feed = publishRelease(feed, { channel: "stable", entry: dummyEntry(version), now: Date.now(), keySetVersion: 1 });
    const bytes = Buffer.from(feed!);
    putSignedDoc("/stable.json", feed!, sign(bytes, "feed", FEED_NAMESPACE));

    const seen = feedHost.requests().length;                   // what this run asked for, nothing before it
    const r = await run(home, ["update", "--check", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(outcomeOf(r)).toEqual({ kind: "up_to_date", current: A });
    expect(feedHost.requests().slice(seen).filter(path => path.startsWith("/releases/")), "nothing fetched beyond the feed").toEqual([]);

    // the same feed, now offering 0.2.0 and withdrawing it in the same word: the machine stays where it is
    const withdrawn = doctoredFeed(feed!, doc => {
      doc.withdrawn = [B];
      doc.releases = [...doc.releases as unknown[], entryFor(Buffer.from(standardManifest))];
    });
    putSignedDoc("/stable.json", withdrawn.bytes.toString(), withdrawn.sig);
    const again = await run(home, ["update", "--check", "--json"]);
    expect(again.status, again.stderr).toBe(0);
    expect(outcomeOf(again)).toEqual({ kind: "up_to_date", current: A });
  }, 180_000);

  it("RL3: a stale feed, a rolled-back number, a rotation walked to key set 3, and a stranger's key set", async () => {
    // a feed whose expiry passed: published 15 days ago, expired a day ago
    await refusedAt("feed_fresh", () => {
      const stale = Buffer.from(publishRelease(null, {
        channel: "stable", entry: entryFor(Buffer.from(standardManifest)), now: Date.now() - 15 * DAY, keySetVersion: 1,
      }));
      putSignedDoc("/stable.json", stale.toString(), sign(stale, "feed", FEED_NAMESPACE));
    });

    // a feed at number 3, then the same feed served again at 2: the machine's own memory refuses the step back
    const home = makeHome();
    let prior: string | null = null;
    for (const version of [A, "0.1.5"]) prior = publishRelease(prior, { channel: "stable", entry: dummyEntry(version), now: Date.now(), keySetVersion: 1 });
    serveRelease(standardManifest, standardArchive, { prior: prior! });       // seq 3, the standard release on top
    const first = await run(home, ["update", "--check", "--json"]);
    expect(first.status, first.stderr).toBe(0);
    expect(outcomeOf(first)).toEqual({ kind: "staged", version: B, already: false });
    const servedFeed = readFileSync(join(feedHost.root, "stable.json"), "utf8");
    const backToTwo = doctoredFeed(servedFeed, doc => { doc.seq = 2; });
    putSignedDoc("/stable.json", backToTwo.bytes.toString(), backToTwo.sig);
    const second = await run(home, ["update", "--check", "--json"]);
    expect(second.status, second.stderr).toBe(65);
    expect(outcomeOf(second)).toMatchObject({ kind: "refused", step: "feed_seq" });

    // a rotation to v3 (root moves to root2, both sides signing v3), the feed naming key set 3 (§10.1)
    const rotated = makeHome();
    const ks2 = Buffer.from(keySetDoc({ version: 2, root: [keys.root1.fingerprint], expiresAt: Date.now() + YEAR }));
    putSignedDoc("/keys/2.json", ks2.toString(), sign(ks2, "root1", KEYS_NAMESPACE));
    const ks3 = Buffer.from(keySetDoc({ version: 3, root: [keys.root2.fingerprint], expiresAt: Date.now() + YEAR }));
    const bothSides = Buffer.concat([sign(ks3, "root1", KEYS_NAMESPACE), sign(ks3, "root2", KEYS_NAMESPACE)]);
    putSignedDoc("/keys/3.json", ks3.toString(), bothSides);
    serveRelease(standardManifest, standardArchive, { keySetVersion: 3 });
    const rotatedRun = await run(rotated, ["update", "--check", "--json"]);
    expect(rotatedRun.status, rotatedRun.stderr).toBe(0);
    expect(outcomeOf(rotatedRun)).toEqual({ kind: "staged", version: B, already: false });
    const status = await run(rotated, ["update", "--status", "--json"]);
    expect(UpdateStatusSchema.parse(JSON.parse(status.stdout)).keySet?.version, "the walk reached v3").toBe(3);

    // keys/2.json signed only by a stranger: the walk refuses before anything else moves
    await refusedAt("key_set", () => {
      const stranger = Buffer.from(keySetDoc({ version: 2, root: [keys.root1.fingerprint], expiresAt: Date.now() + YEAR }));
      putSignedDoc("/keys/2.json", stranger.toString(), sign(stranger, "stranger", KEYS_NAMESPACE));
    });
  }, 300_000);

  it("TLS: an untrusted certificate is unreachable and stages nothing; switching TLS off stops the program first", async () => {
    const home = makeHome();
    world.reset();
    const r = await run(home, ["update", "--check", "--json"], { ca: false });
    expect(r.status, r.stderr).toBe(75);
    expect(outcomeOf(r)).toMatchObject({ kind: "unreachable" });
    expect(`${outcomeOf(r).detail}`).toMatch(/certificate|issuer/);
    nothingLeft(home);

    const sawBefore = feedHost.requests().length;
    const off = await run(home, ["update", "--check"], { tlsOff: true });
    expect(off.status, off.stderr).toBe(78);
    expect(off.stderr).toMatch(/TLS checks are off/);
    expect(feedHost.requests().length, "the server saw none of it").toBe(sawBefore);
  }, 120_000);

  it("RL14: a checkout is not ours to update, and MORNDO_DISABLE_UPDATES refuses for every install", async () => {
    const checkout = makeHome({ install: false });
    const r = await run(checkout, ["update", "--check", "--json"]);
    expect(r.status, r.stderr).toBe(78);
    expect(outcomeOf(r)).toMatchObject({ kind: "not_ours" });
    expect(`${outcomeOf(r).detail}`).toMatch(/checkout/);

    const home = makeHome();
    const off = await run(home, ["update", "--check", "--json"], { disabled: true });
    expect(off.status, off.stderr).toBe(78);
    expect(outcomeOf(r).detail).not.toBe(outcomeOf(off).detail);        // two refusals, each in its own words
    expect(`${outcomeOf(off).detail}`).toMatch(/MORNDO_DISABLE_UPDATES/);
  }, 120_000);

  it("doctor names the changed file in the running Version (§10.4: a same-user edit)", async () => {
    const home = makeHome();
    world.reset();
    const r = await run(home, ["update", "--check", "--json"]);
    expect(r.status, r.stderr).toBe(0);

    const current = join(releasesOf(home), A, "bin/morndo");
    chmodSync(current, 0o755);                   // write back, append one byte, read-only again
    appendFileSync(current, "#");
    chmodSync(current, 0o555);

    const doc = await run(home, ["doctor"]);
    expect(doc.status, `${doc.stdout}${doc.stderr}`).toBe(1);
    expect(`${doc.stdout}${doc.stderr}`).toMatch(/bin\/morndo: changed/);
  }, 180_000);
});
