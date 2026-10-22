// The host side of the throwaway-machine run (design §13, e2e/update.e2e.ts): six whole Releases of this very
// repository, built and signed the way the pipeline builds them (§9) — scripts/release's own writers for the
// stage, the file list, the archive, the manifest and the feed, throwaway keys made in memory by the updater's
// test helper — plus the six publish points of the run's story. Version A (0.1.0) is the tree as it stands;
// B (0.2.0) appends one additive hub migration; C (0.3.0) appends B's change, one breaking hub migration (so the
// old Version cannot open the database and a rollback must restore the backup) and a hub that exits 1 right
// after its store opened; 0.3.1 appends B's change and a migration whose `up` throws (the failed migration); 0.3.2
// appends B's change, C's breaking migration and a hub that serves and answers health normally, then exits 1
// after 20 s (the death in probation, whose rollback restores around the revocations typed meanwhile); 0.4.0
// appends B's change and one more additive migration (the healthy one the story ends on). Everything but A
// exists only in the scratch copy; nothing generated lands inside the repository.
//
// Every path here is inside a scratch directory the caller removes (or keeps with E2E_KEEP=1); every key and
// certificate lives in memory or in the scratch, never in the repository, and every name is made up
// (feed.example.invalid nowhere needed: the feed's host is the container's own 127.0.0.1).
//
// Two steps of the release workflow's build (release.yml) are not this build's to do: the units test run (build
// QA, not part of the artifact) and `npm run build` (the web UI — the hub answers 503 per request for an unbuilt
// UI and starts all the same; no door this run reads is a UI route).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { KeySetSchema } from "@morndo/protocol";
import { packTree, type TreeFile } from "../../scripts/release/archive.ts";
import { publishRelease } from "../../scripts/release/feed.ts";
import { listFiles } from "../../scripts/release/files.ts";
import { artifactName } from "../../scripts/release/manifest.ts";
import { stageRelease } from "../../scripts/release/stage.ts";
import { FEED_NAMESPACE, KEYS_NAMESPACE, RELEASE_NAMESPACE } from "../../apps/updater/src/application/namespaces.ts";
import { makeSigningKey } from "../../apps/updater/test/helpers/sshsig.ts";
import { makeTestCa } from "../../apps/updater/test/helpers/tls.ts";
import { nextMigration, ownerOf, ownerText } from "./checks.ts";

// The feed's fixed address, baked into the signed documents on the host and served inside the container on
// exactly this port (scenario.ts serves it; the two constants must agree).
export const FEED_PORT = 8443;
export const FEED_URL = `https://127.0.0.1:${FEED_PORT}/`;

const VERSION_A = "0.1.0";
const VERSION_B = "0.2.0";
const VERSION_C = "0.3.0";
const VERSION_D = "0.3.1";
const VERSION_E = "0.3.2";
const VERSION_F = "0.4.0";
const CHANNEL = "stable";
const PLATFORM = "linux-x64";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";     // informational (§9.6); a made-up one, as a fixture's
const REPOSITORY = "example/morndo";

const sha256hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export type BuiltWorld = {
  /** The scratch directory: everything generated, removed by the caller (kept with E2E_KEEP=1). */
  scratch: string;
  /** The directory to `docker cp` into the machine: the feeds, the certificate files and the scenario's bundle. */
  bundle: string;
  /** The A archive, for the scenario to unpack and install as install.sh would (§10.3). */
  archiveA: string;
};

// The three Releases and the three publish points, built once. Nothing here touches the repository: the tree is
// copied into the scratch (without .git and .worktrees), the copies are edited, compiled, pruned and staged there.
export function buildWorld(repo: string): BuiltWorld {
  const scratch = mkdtempSync(join(tmpdir(), "morndo-c2-build-"));
  // Whose scratch this is, first thing: another run's sweep leaves it alone while this process runs (checks.ts).
  writeFileSync(join(scratch, "owner"), ownerText(ownerOf(process.pid)));
  // A build that fails leaves nothing of itself behind (unless E2E_KEEP=1): the repository copy is large.
  try { return buildInto(repo, scratch); }
  catch (error) {
    if (process.env.E2E_KEEP !== "1") rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

function buildInto(repo: string, scratch: string): BuiltWorld {
  const now = Date.now();
  const mtime = Math.floor(now / 1000);                         // one clock for every archive: a rebuild is comparable
                                                                 // (packTree's mtime is whole seconds, like git's %ct)

  // One key per role (§10.1), made in memory by the updater's own test helper: no key file is ever written.
  const root = makeSigningKey();
  const release = makeSigningKey();
  const feed = makeSigningKey();
  const keyDoc = {
    schema: 1 as const, version: 1,
    expiresAt: new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    root: [root.fingerprint], release: [release.fingerprint], feed: [feed.fingerprint],
  };
  if (!KeySetSchema.safeParse(keyDoc).success) throw new Error("the key set is not the wire's shape");
  const keysJson = `${JSON.stringify(keyDoc, null, 2)}\n`;
  const keysBytes = Buffer.from(keysJson);
  const keysSig = root.signature(keysBytes, KEYS_NAMESPACE);

  // The certificate authority the container's own HTTPS is trusted through (the scenario's server and the
  // updater's NODE_EXTRA_CA_CERTS both read these files out of the bundle).
  const caDir = join(scratch, "ca");
  mkdirSync(caDir);
  const ca = makeTestCa(caDir);

  // The bundled Node (§9.3): this host's own binary and Node's licence, nothing else.
  const nodeDir = join(scratch, "node");
  mkdirSync(join(nodeDir, "bin"), { recursive: true });
  cpSync(process.execPath, join(nodeDir, "bin", "node"));
  writeFileSync(join(nodeDir, "LICENSE"), nodeLicence());

  const bundle = join(scratch, "bundle");
  const feeds = join(bundle, "feeds");
  mkdirSync(feeds, { recursive: true });
  mkdirSync(join(bundle, "tls"), { recursive: true });
  writeFileSync(join(bundle, "tls", "ca.pem"), ca.ca);
  writeFileSync(join(bundle, "tls", "server.pem"), ca.serverCert);
  writeFileSync(join(bundle, "tls", "server.key"), ca.serverKey);

  // One Release per Version: a scratch copy of the repository, edited for everything after A, compiled, pruned,
  // staged, trusted (trust/keys.json is the tree's own anchor, §10.1 — the stage leaves trust/ empty for the
  // pipeline's own signing step, so it is written here and the file list is made again around it), packed and
  // signed.
  const releases: readonly { version: string; edit: () => readonly ((copy: string) => void)[] }[] = [
    { version: VERSION_A, edit: () => [] },
    { version: VERSION_B, edit: () => [additiveMigration()] },
    { version: VERSION_C, edit: () => [additiveMigration(), breakingMigration(), plantedHubFailure()] },
    { version: VERSION_D, edit: () => [additiveMigration(), failingMigration()] },
    { version: VERSION_E, edit: () => [additiveMigration(), breakingMigration(), hubDiesInProbation()] },
    { version: VERSION_F, edit: () => [additiveMigration(), secondAdditiveMigration()] },
  ];
  const built: { version: string; archive: Buffer; manifestBytes: Buffer }[] = [];
  for (const spec of releases) {
    const copy = copyRepo(repo, join(scratch, `repo-${spec.version}`));
    for (const edit of spec.edit()) edit(copy);
    run(process.execPath, ["scripts/release/main.ts", "compile", "--repo", copy, "--out", join(scratch, `compiled-${spec.version}`)], copy);
    // --ignore-scripts: prune runs workspaces' lifecycle scripts, and apps/web's `prepare` (svelte-kit sync) needs
    // the devDependency prune has just removed — the release workflow's own `npm prune --omit=dev` carries the same
    // trap (release.yml line 154; reported, not worked around there). No runtime dependency has an install script
    // (release.yml's own better-sqlite3 note), so skipping scripts leaves the pruned tree itself untouched.
    run("npm", ["prune", "--omit=dev", "--offline", "--ignore-scripts"], copy);
    const stage = join(scratch, `stage-${spec.version}`);
    try {
      stageRelease({
        repo: copy, nodeDir, dest: stage, version: spec.version, commit: COMMIT, compiled: join(scratch, `compiled-${spec.version}`),
      });
    } catch (error) {
      // The stage's own rule is "no link resolves outside the tree" (stage.ts:84); say which links broke it.
      const findings = linkFindings(copy);
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nlinks in the copy that escape or dangle:\n${
        findings.length === 0 ? "(none)" : findings.slice(0, 40).join("\n")}`);
    }
    writeFileSync(join(stage, "trust", "keys.json"), keysBytes, { mode: 0o444 });
    rmSync(join(stage, "files.json"));
    const listed = listFiles(walk(stage, new Set(["files.json"])));
    writeFileSync(join(stage, "files.json"), listed.json, { mode: 0o444 });
    const archive = packTree(walk(stage), mtime);
    writeFileSync(join(scratch, `archive-${spec.version}.tar.gz`), archive);
    const manifestPath = join(scratch, `manifest-${spec.version}.json`);
    run(process.execPath, [
      "scripts/release/main.ts", "manifest", "--version", spec.version, "--commit", COMMIT,
      "--published-at", String(now), "--repository", REPOSITORY,
      "--artifact", `${PLATFORM}=${join(scratch, `archive-${spec.version}.tar.gz`)}`,
      "--files", `${PLATFORM}=${join(stage, "files.json")}`, "--out", manifestPath,
    ], copy);
    built.push({ version: spec.version, archive, manifestBytes: readFileSync(manifestPath) });
  }

  // The six publish points (§13's run): feed-1 offers A, feed-2 adds B, feed-3 adds C, feed-4 adds the failed
  // migration, feed-5 adds the probation death, feed-6 adds the healthy ending. Each is a complete servable feed
  // directory — keys, channel document, every release it lists — with the archives shared by hard link so the
  // scratch stays honest about how much is really new.
  let feedText: string | null = null;
  for (let i = 0; i < built.length; i++) {
    const b = built[i]!;
    const dir = join(feeds, `feed-${i + 1}`);
    mkdirSync(join(dir, "keys"), { recursive: true });
    writeFileSync(join(dir, "keys", "1.json"), keysBytes);
    writeFileSync(join(dir, "keys", "1.json.sig"), keysSig);
    const text = publishRelease(feedText, {
      channel: CHANNEL,
      now: now + i,                                            // a later publish point, a later moment, a higher number
      keySetVersion: 1,
      entry: {
        version: b.version,
        manifest: `${FEED_URL}releases/v${b.version}/manifest.json`,
        manifestSize: b.manifestBytes.length,
        manifestSha256: sha256hex(b.manifestBytes),
      },
    });
    feedText = text;
    writeFileSync(join(dir, `${CHANNEL}.json`), text);
    writeFileSync(join(dir, `${CHANNEL}.json.sig`), feed.signature(Buffer.from(text), FEED_NAMESPACE));
    for (const earlier of built.slice(0, i + 1)) {
      const releaseDir = join(dir, "releases", `v${earlier.version}`);
      mkdirSync(releaseDir, { recursive: true });
      writeFileSync(join(releaseDir, "manifest.json"), earlier.manifestBytes);
      writeFileSync(join(releaseDir, "manifest.json.sig"), release.signature(earlier.manifestBytes, RELEASE_NAMESPACE));
      const artifact = join(releaseDir, artifactName(earlier.version, PLATFORM));
      if (existsSync(artifact)) continue;                      // feed-N+1's own copy of a shared archive
      try { linkSync(join(scratch, `archive-${earlier.version}.tar.gz`), artifact); }
      catch { cpSync(join(scratch, `archive-${earlier.version}.tar.gz`), artifact); }   // a filesystem without hard links
    }
  }

  return {
    scratch,
    bundle,
    archiveA: join(feeds, "feed-1", "releases", `v${VERSION_A}`, artifactName(VERSION_A, PLATFORM)),
  };
}

// The stage's link rule, applied as a report: a copied-out tree can carry links npm made against another root
// (an absolute .bin link) or prune left dangling, and the finding names which links broke it.
function linkFindings(root: string): string[] {
  const realRoot = realpathSync(root);
  const findings: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        try {
          const real = realpathSync(abs);
          if (real !== realRoot && !real.startsWith(`${realRoot}/`)) findings.push(`${relative(realRoot, abs)} -> ${real}`);
        } catch (error) {
          findings.push(`${relative(realRoot, abs)} dangles (${error instanceof Error ? error.message.split("\n")[0] : "removed"})`);
        }
      } else if (st.isDirectory()) walk(abs);
    }
  };
  walk(root);
  return findings;
}

// The repository into the scratch: everything except .git and .worktrees (the links and the history are the
// host's, not the machine's), node_modules included — the copy compiles, prunes and stages on its own.
// verbatimSymlinks: cpSync's default resolves each symlink and copies an absolute link to the resolved path —
// in this host's tree, not the copy's — which the release stage rightly refuses (stage.ts:84); the literal link
// strings (npm's own relative ones) resolve inside the copy.
function copyRepo(repo: string, dest: string): string {
  const skip = new Set([".git", ".worktrees"]);
  cpSync(repo, dest, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src: string) => {
      const rel = relative(repo, src).split(sep)[0] ?? "";
      return rel === "" || !skip.has(rel);
    },
  });
  return dest;
}

function run(file: string, args: string[], cwd: string): void {
  const done = spawnSync(file, args, { cwd, encoding: "utf8" });
  if (done.status !== 0) {
    throw new Error(`${file} ${args.join(" ")} failed (${done.status}): ${(done.stderr || done.stdout || "").slice(0, 2000)}`);
  }
}

// The file list walk of scripts/release/main.ts's pack, mirrored here so the list can be made again around a
// trust/keys.json the stage does not write (§9.3 leaves trust/ empty for the pipeline's own signing step):
// files 0444, bin/ and node/bin/ 0555, links and empty directories as themselves, everything sorted. The list
// itself is the pipeline's own writer (scripts/release/files.ts), exactly as the stage and the pack use it.
function walk(root: string, exclude: Set<string> = new Set()): TreeFile[] {
  const out: TreeFile[] = [];
  const step = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      if (exclude.has(rel)) continue;
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) out.push({ path: rel, mode: "0555", link: readlinkSync(abs).split(sep).join("/") });
      else if (st.isDirectory()) {
        if (readdirSync(abs).length === 0) out.push({ path: rel, mode: "0555", directory: true });
        else step(abs, rel);
      } else if (st.isFile()) {
        out.push({ path: rel, mode: rel.startsWith("bin/") || rel.startsWith("node/bin/") ? "0555" : "0444", bytes: readFileSync(abs) });
      }
    }
  };
  step(root, "");
  return out;
}

// ---- the scratch-copy edits (B and C): each returns the edits as functions over the copy, and each edit
// verifies its own anchor landed, so a moved line in the repository fails the build instead of quietly shipping
// a release without its marker.

// B (0.2.0): one additive hub migration (§11.2) — an older hub opens the database it leaves, so a rollback to A
// restores nothing and the marker table stays.
function additiveMigration(): (copy: string) => void {
  return copy => {
    const path = join(copy, "apps/hub/src/adapters/migrations.ts");
    const text = readFileSync(path, "utf8");
    const anchor = "];\n\nexport const SCHEMA_VERSION";
    if (!text.includes(anchor)) throw new Error("migrations.ts: the MIGRATIONS array's end moved; the B edit needs a new anchor");
    const marker = "e2e_b_marker";
    if (text.includes(marker)) throw new Error("migrations.ts: the B marker is already there");
    writeFileSync(path, text.replace(anchor, `  {
    version: ${nextMigration(text)},
    name: "the update-vm run's additive marker (release B; a scratch-copy edit, never shipped)",
    compat: "additive",
    up: db => db.exec("CREATE TABLE IF NOT EXISTS ${marker} (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL)"),
  },
];\n\nexport const SCHEMA_VERSION`));
  };
}

// C (0.3.0): B's change, then one breaking hub migration (§11.1) — the floor rises past what A knows, so A
// cannot open the database it leaves and the rollback must restore the backup.
function breakingMigration(): (copy: string) => void {
  return copy => {
    const path = join(copy, "apps/hub/src/adapters/migrations.ts");
    const text = readFileSync(path, "utf8");
    const anchor = "];\n\nexport const SCHEMA_VERSION";
    if (!text.includes(anchor) || !text.includes("e2e_b_marker")) throw new Error("migrations.ts: the C edit did not find B's change in place");
    writeFileSync(path, text.replace(anchor, `  {
    version: ${nextMigration(text)},
    name: "the update-vm run's breaking floor (release C; a scratch-copy edit, never shipped)",
    compat: "breaking",
    up: db => db.exec("CREATE TABLE IF NOT EXISTS e2e_c_marker (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL)"),
  },
];\n\nexport const SCHEMA_VERSION`));
  };
}

// C (0.3.0): the planted health failure (§13's "a release whose service will not come healthy") — the hub opens
// its store (the migration ran) and leaves at once on the serve path, so the apply's health walk fails and the
// walk rolls the machine back. `morndo --version` and the updater's own words still work: both leave before this.
function plantedHubFailure(): (copy: string) => void {
  return copy => {
    const path = join(copy, "apps/hub/src/main.ts");
    const text = readFileSync(path, "utf8");
    const anchor = "const store = openStore(config.dataDir);";
    if (!text.includes(anchor)) throw new Error("hub main.ts: openStore's line moved; the planted failure needs a new anchor");
    writeFileSync(path, text.replace(anchor, `${anchor}
// The update-vm run's planted failure (release C; a scratch-copy edit, never shipped): the store is open — the
// migration ran — and the hub leaves at once, only on the serve path.
if (process.argv[2] === undefined || process.argv[2] === "serve") process.exit(1);`));
  };
}

// 0.3.1 (the failing migration, §13's "a migration throws"): B's change, then one additive migration whose `up`
// throws. The runner wraps every migration — floor, body, user_version — in one transaction, so the database
// keeps exactly what it had; the hub's start refuses, the apply's health walk fails at its wall, and the rollback
// restores nothing because nothing moved.
function failingMigration(): (copy: string) => void {
  return copy => {
    const path = join(copy, "apps/hub/src/adapters/migrations.ts");
    const text = readFileSync(path, "utf8");
    const anchor = "];\n\nexport const SCHEMA_VERSION";
    if (!text.includes(anchor) || !text.includes("e2e_b_marker")) throw new Error("migrations.ts: the 0.3.1 edit did not find B's change in place");
    writeFileSync(path, text.replace(anchor, `  {
    version: ${nextMigration(text)},
    name: "the update-vm run's failing migration (release 0.3.1; a scratch-copy edit, never shipped)",
    compat: "additive",
    up: () => { throw new Error("the update-vm run's planted migration failure (release 0.3.1)"); },
  },
];\n\nexport const SCHEMA_VERSION`));
  };
}

// 0.3.2 (the death in probation): B's change, C's breaking migration (so the rollback restores the hub database
// and the revocations typed meanwhile must survive the restore), and a hub that serves and answers health
// normally, then exits 1 after 20 s — past the health walk, inside the probation window, where a restart counts
// against the Version. Serve path only: the console commands the run types while this hub is up (the two
// revocations) are never the process that dies.
function hubDiesInProbation(): (copy: string) => void {
  return copy => {
    const path = join(copy, "apps/hub/src/main.ts");
    const text = readFileSync(path, "utf8");
    const anchor = "    await running(http.ready);";
    if (!text.includes(anchor)) throw new Error("hub main.ts: http.ready's line moved; the probation death needs a new anchor");
    writeFileSync(path, text.replace(anchor, `${anchor}
// The update-vm run's planted death (release 0.3.2; a scratch-copy edit, never shipped): serving and healthy,
// then gone — serve only, so the console commands the run types while this hub is up are never the one that dies.
if (process.argv[2] === undefined || process.argv[2] === "serve") setTimeout(() => process.exit(1), 20_000);`));
  };
}

// 0.4.0 (the healthy ending): B's change, then one more additive hub migration — a second marker table, so the
// story closes on a commit that migrates and holds nothing back.
function secondAdditiveMigration(): (copy: string) => void {
  return copy => {
    const path = join(copy, "apps/hub/src/adapters/migrations.ts");
    const text = readFileSync(path, "utf8");
    const anchor = "];\n\nexport const SCHEMA_VERSION";
    if (!text.includes(anchor) || !text.includes("e2e_b_marker")) throw new Error("migrations.ts: the 0.4.0 edit did not find B's change in place");
    writeFileSync(path, text.replace(anchor, `  {
    version: ${nextMigration(text)},
    name: "the update-vm run's second additive marker (release 0.4.0; a scratch-copy edit, never shipped)",
    compat: "additive",
    up: db => db.exec("CREATE TABLE IF NOT EXISTS e2e_d_marker (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL)"),
  },
];\n\nexport const SCHEMA_VERSION`));
  };
}

// Node's licence, from wherever this host's Node keeps it; a sentence of our own when it is nowhere to be found,
// so the tree always ships the file the stage's layout names.
function nodeLicence(): string {
  const here = dirname(process.execPath);
  for (const candidate of [join(here, "LICENSE"), join(here, "..", "LICENSE"), join(here, "..", "..", "LICENSE")]) {
    try { return readFileSync(candidate, "utf8"); } catch { /* not there; the next place */ }
  }
  return "node/bin/node is a copy of the build host's own Node binary; its licence ships with every official Node distribution (nodejs.org).\n";
}
