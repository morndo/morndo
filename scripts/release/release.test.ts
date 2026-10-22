// The release pipeline's local half (ADR-0019 §9, design §9 and §15 PR 3). A tag on a scratch
// repository, with the owner's keys, is what proves the GitHub jobs; everything that can be shown
// on this machine is here: the same tree packs to the same bytes twice, the file list and the
// Manifest are the wire documents, ssh-keygen accepts the signature, and re-signing a Feed moves
// its number and its expiry only.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CLIENT_API, ChannelFeedSchema, FileListSchema, FLEET_PROTO, ManifestSchema } from "@morndo/protocol";
import { packTree, type TreeFile } from "./archive.ts";
import { compilePackage } from "./compile.ts";
import { emptyFeed, FEED_TTL_MS, publishRelease, resignFeed } from "./feed.ts";
import { deployedSeq, writeVerifiedSite } from "./feed-site.ts";
import { commitFeeds, feedTree, MOVED, prepareFeeds, refUpdateResult } from "./feed-sync.ts";
import { readSchemaJson } from "./schema-read.ts";
import { freshSite } from "./pages.ts";
import { listFiles } from "./files.ts";
import { launcherSource, launchersFrom } from "./launchers.ts";
import { artifactName, buildManifest, declaredSchemas, protocolRange, schemaFrom } from "./manifest.ts";
import { orderProblems } from "./schema.ts";
import { keySetVersion } from "./key-set.ts";
import { BUNDLED_NODE, newerNode24, nodeTarball } from "./node-pin.ts";
import { sha256Sums } from "./checksums.ts";
import { FEED_NAMESPACE, RELEASE_NAMESPACE, signBytes } from "./sign.ts";
import { stageRelease } from "./stage.ts";
import { stampVersion, UNSTAMPED_VERSION } from "./stamp.ts";
import { thirdPartyNotice } from "./notice.ts";

const COMMIT = "ab".repeat(20);
const STAMP_COMMIT = "3fa2c1d09b7e4a5c8d1f6e2b0a9c7d5e4f3a2b1c";
const WHEN = Date.parse("2026-11-02T10:00:00Z");
const tree = [
  { path: "bin/morndo", bytes: new TextEncoder().encode("#!/bin/sh\necho morndo\n"), mode: "0555" as const },
  { path: "app/readme.txt", bytes: new TextEncoder().encode("hello\n"), mode: "0444" as const },
];

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "morndo-release-"));
  scratch.push(dir);
  return dir;
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("deterministic archive", () => {
  it("packs the same bytes twice, whatever order the files were given in", () => {
    const first = packTree(tree, 1_700_000_000);
    const second = packTree([...tree].reverse(), 1_700_000_000);
    expect(Buffer.from(second).equals(first)).toBe(true);
    const again = packTree(tree, 1_700_000_000);
    expect(Buffer.from(again).equals(first)).toBe(true);
  });

  it("changes when the commit time changes, and the result is a tar a system tar can read", () => {
    const early = packTree(tree, 1_700_000_000);
    const later = packTree(tree, 1_700_000_001);
    expect(Buffer.from(later).equals(early)).toBe(false);
    const dir = temp();
    const archive = join(dir, "a.tar.gz");
    writeFileSync(archive, early);
    const listed = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
    expect(listed.status).toBe(0);
    expect(listed.stdout.split("\n").filter(Boolean)).toEqual(["app/", "app/readme.txt", "bin/", "bin/morndo"]);
    const body = spawnSync("tar", ["-xOzf", archive, "app/readme.txt"], { encoding: "utf8" });
    expect(body.stdout).toBe("hello\n");
  });

  it("refuses a path that could escape the tree", () => {
    expect(() => packTree([{ path: "../outside.txt", bytes: new Uint8Array([1]), mode: "0444" }], 1)).toThrow(/path/i);
    expect(() => packTree([{ path: "/etc/passwd", bytes: new Uint8Array([1]), mode: "0444" }], 1)).toThrow(/path/i);
  });

  it("carries a path longer than the ustar name field", () => {
    const path = `app/${"nested/".repeat(20)}leaf.txt`;
    expect(path.length).toBeGreaterThan(100);
    const bytes = new TextEncoder().encode("long\n");
    const packed = packTree([{ path, bytes, mode: "0444" }], 1_700_000_000);
    const dir = temp();
    const archive = join(dir, "long.tar.gz");
    writeFileSync(archive, packed);
    const body = spawnSync("tar", ["-xOzf", archive, path], { encoding: "utf8" });
    expect(body.status).toBe(0);
    expect(body.stdout).toBe("long\n");
  });
});

describe("file list and manifest", () => {
  it("lists every file except the list itself, in the wire's shape", () => {
    const listed = listFiles(tree);
    expect(FileListSchema.safeParse(JSON.parse(listed.json)).success).toBe(true);
    expect(JSON.parse(listed.json)).toEqual([
      { path: "app/readme.txt", mode: "0444", sha256: sha256(tree[1]!.bytes) },
      { path: "bin/morndo", mode: "0555", sha256: sha256(tree[0]!.bytes) },
    ]);
    expect(listed.sha256).toBe(sha256(new TextEncoder().encode(listed.json)));
    expect(listed.json.endsWith("\n")).toBe(true);
  });

  it("reads the schema version and floor from the apps' migrations", async () => {
    const { MIGRATIONS: hub } = await import("../../apps/hub/src/adapters/migrations.ts");
    const { MIGRATIONS: fleet } = await import("../../apps/fleet/src/adapters/migrations.ts");
    const { MIGRATIONS: node } = await import("../../apps/node-agent/src/db/migrations.ts");
    const { MIGRATIONS: connections } = await import("../../apps/connections/src/adapters/store-migrations.ts");
    expect(declaredSchemas()).toEqual({
      hub: schemaFrom(hub),
      fleet: schemaFrom(fleet),
      node: schemaFrom(node),
      connections: schemaFrom(connections),
    });
  });

  it("the release declares every migration in the tree, in order", async () => {
    const { MIGRATIONS: hub } = await import("../../apps/hub/src/adapters/migrations.ts");
    const { MIGRATIONS: fleet } = await import("../../apps/fleet/src/adapters/migrations.ts");
    const { MIGRATIONS: node } = await import("../../apps/node-agent/src/db/migrations.ts");
    const { MIGRATIONS: connections } = await import("../../apps/connections/src/adapters/store-migrations.ts");
    const lists = { hub, fleet, node, connections };
    for (const [name, list] of Object.entries(lists)) expect(orderProblems(list), name).toEqual([]);
    const declared = declaredSchemas();
    for (const [name, list] of Object.entries(lists)) {
      expect(declared[name as keyof typeof declared].version, name).toBe(list.length);
    }
  });

  it("control: a gap, a repeat or a swap in a migration list is named", () => {
    const at = (...versions: number[]) => versions.map(version => ({ version, compat: "additive" as const }));
    expect(orderProblems(at(1, 2, 3))).toEqual([]);
    expect(orderProblems(at(1, 3))).toEqual(["version 3 follows 1"]);
    expect(orderProblems(at(1, 1))).toEqual(["version 1 follows 1"]);
    expect(orderProblems(at(2, 1))).toEqual(["version 2 follows 0", "version 1 follows 2"]);
  });

  it("starts the schema child in the repo and reports the child's own error", () => {
    for (const name of ["schema-read.ts", "feed-site.ts"]) {
      const source = readFileSync(join(import.meta.dirname, name), "utf8");
      expect(source, name).not.toMatch(/apps\//);
      expect(source, name).not.toMatch(/@morndo/);
    }
    const dir = temp();
    const bad = join(dir, "bad.js");
    writeFileSync(bad, "console.error('sqlite was not built'); process.exit(1);\n");
    expect(() => readSchemaJson(bad)).toThrow(/schema read failed: sqlite was not built/);
    const probe = join(dir, "probe.js");
    writeFileSync(probe, "process.stdout.write(JSON.stringify({ cwd: process.cwd(), execArgv: process.execArgv }));\n");
    const realRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
    expect(readSchemaJson(probe)).toEqual({ cwd: realRoot, execArgv: [] });
  });

  it("states this tree's schemas: the last migration's version, and a floor of 0 where nothing breaking has shipped", async () => {
    const { MIGRATIONS: hub } = await import("../../apps/hub/src/adapters/migrations.ts");
    const { MIGRATIONS: fleet } = await import("../../apps/fleet/src/adapters/migrations.ts");
    const { MIGRATIONS: node } = await import("../../apps/node-agent/src/db/migrations.ts");
    const { MIGRATIONS: connections } = await import("../../apps/connections/src/adapters/store-migrations.ts");
    // Worked out from the lists here, so a migration main adds later is the tree's, not a number to update.
    const expected = (list: readonly { version: number; compat: "additive" | "breaking" }[]) => ({
      version: Math.max(...list.map(m => m.version)),
      floor: Math.max(0, ...list.filter(m => m.compat === "breaking").map(m => m.version)),
    });
    expect(declaredSchemas()).toEqual({ hub: expected(hub), fleet: expected(fleet), node: expected(node), connections: expected(connections) });
    expect(protocolRange()).toEqual({
      agent: [Math.max(1, FLEET_PROTO - 1), FLEET_PROTO],
      clientApi: [Math.max(1, CLIENT_API - 1), CLIENT_API],
    });
  });

  it("reads the schema version and floor from the migration list", () => {
    expect(schemaFrom([
      { version: 1, compat: "additive" },
      { version: 2, compat: "breaking" },
      { version: 3, compat: "additive" },
    ])).toEqual({ version: 3, floor: 2 });
  });

  it("builds a Manifest the wire accepts, artifacts ordered by platform", () => {
    const archive = packTree(tree, 1_700_000_000);
    const files = listFiles(tree);
    const name = artifactName("0.1.0", "linux-x64");
    expect(name).toBe("morndo-0.1.0-linux-x64.tar.gz");
    const json = buildManifest({
      version: "0.1.0", commit: COMMIT, publishedAt: WHEN, repository: "morndo/morndo",
      protocol: protocolRange(), schemas: declaredSchemas(),
      artifacts: [
        { platform: "darwin-arm64", name: artifactName("0.1.0", "darwin-arm64"), size: 4, sha256: "cd".repeat(32), filesSha256: "ef".repeat(32), node: BUNDLED_NODE },
        { platform: "linux-x64", name, size: archive.length, sha256: sha256(archive), filesSha256: files.sha256, node: BUNDLED_NODE },
      ],
    });
    const parsed = ManifestSchema.safeParse(JSON.parse(json));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.schemas).toEqual(declaredSchemas());
    expect(parsed.data.artifacts.map(a => a.platform)).toEqual(["darwin-arm64", "linux-x64"]);
    expect(parsed.data.notes).toBe("https://github.com/morndo/morndo/releases/tag/v0.1.0");
    expect(parsed.data.publishedAt).toBe(WHEN);
    expect(json.endsWith("\n")).toBe(true);
  });

  it("writes SHA256SUMS in filename order, two spaces, lowercase", () => {
    const sums = sha256Sums([
      { name: "b.txt", bytes: new TextEncoder().encode("b") },
      { name: "a.txt", bytes: new TextEncoder().encode("a") },
    ]);
    expect(sums).toBe(`${sha256(new TextEncoder().encode("a"))}  a.txt\n${sha256(new TextEncoder().encode("b"))}  b.txt\n`);
  });
});

function allowedSignerLine(p: { identity: string; namespace: string; publicKey: string }): string {
  return `${p.identity} namespaces="${p.namespace}" ${p.publicKey}`;
}

function verifyBytes(p: {
  bytes: Uint8Array; signature: Uint8Array; allowedSignersPath: string; identity: string; namespace: string;
}): void {
  const dir = mkdtempSync(join(tmpdir(), "morndo-verify-"));
  const payload = join(dir, "payload");
  const sig = join(dir, "payload.sig");
  try {
    writeFileSync(payload, p.bytes);
    writeFileSync(sig, p.signature);
    const run = spawnSync("ssh-keygen", [
      "-Y", "verify", "-f", p.allowedSignersPath, "-I", p.identity, "-n", p.namespace, "-s", sig,
    ], { input: p.bytes, encoding: "utf8" });
    if (run.status !== 0) throw new Error(`ssh-keygen -Y verify failed: ${run.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("signatures", () => {
  it("signs with a throwaway key and ssh-keygen -Y verify accepts only that namespace and those bytes", () => {
    const dir = temp();
    const key = join(dir, "release");
    expect(spawnSync("ssh-keygen", ["-t", "ed25519", "-f", key, "-N", "", "-C", "release-test", "-q"]).status).toBe(0);
    const pub = spawnSync("ssh-keygen", ["-y", "-f", key], { encoding: "utf8" });
    expect(pub.status).toBe(0);
    const line = allowedSignerLine({ identity: RELEASE_NAMESPACE, namespace: RELEASE_NAMESPACE, publicKey: pub.stdout.trim() });
    const signers = join(dir, "allowed");
    writeFileSync(signers, `${line}\n`, { mode: 0o644 });
    const bytes = new TextEncoder().encode("manifest-bytes\n");
    const signature = signBytes({ bytes, keyPath: key, namespace: RELEASE_NAMESPACE, dir });
    expect(() => verifyBytes({ bytes, signature, allowedSignersPath: signers, identity: RELEASE_NAMESPACE, namespace: RELEASE_NAMESPACE })).not.toThrow();
    const flipped = new Uint8Array(bytes);
    flipped[0] = flipped[0]! ^ 1;
    expect(() => verifyBytes({ bytes: flipped, signature, allowedSignersPath: signers, identity: RELEASE_NAMESPACE, namespace: RELEASE_NAMESPACE })).toThrow(/verify/i);
    expect(() => verifyBytes({ bytes, signature, allowedSignersPath: signers, identity: RELEASE_NAMESPACE, namespace: FEED_NAMESPACE })).toThrow(/verify/i);
  });
});

describe("feed", () => {
  const entry = {
    version: "0.1.0",
    manifest: "https://github.com/morndo/morndo/releases/download/v0.1.0/manifest.json",
    manifestSize: 100,
    manifestSha256: "ab".repeat(32),
  };
  const later = {
    version: "0.2.0",
    manifest: "https://github.com/morndo/morndo/releases/download/v0.2.0/manifest.json",
    manifestSize: 120,
    manifestSha256: "cd".repeat(32),
  };

  it("starts at seq 1 and rises by one when a release is added", () => {
    const first = publishRelease(null, { channel: "latest", entry, now: WHEN, keySetVersion: 1 });
    const parsed = ChannelFeedSchema.safeParse(JSON.parse(first));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.seq).toBe(1);
    expect(parsed.data.releases.map(r => r.version)).toEqual(["0.1.0"]);
    expect(parsed.data.expiresAt - parsed.data.issuedAt).toBe(FEED_TTL_MS);
    const second = publishRelease(first, { channel: "latest", entry: later, now: WHEN + 1000, keySetVersion: 1 });
    const again = ChannelFeedSchema.parse(JSON.parse(second));
    expect(again.seq).toBe(2);
    expect(again.releases.map(r => r.version)).toEqual(["0.2.0", "0.1.0"]);
  });

  it("puts feed file bytes in the tree instead of posting a blob first", () => {
    expect(feedTree([{ path: "latest.json", content: "{}\n" }])).toEqual([
      { path: "latest.json", mode: "100644", type: "blob", content: "{}\n" },
    ]);
    expect(readFileSync(join(import.meta.dirname, "feed-sync.ts"), "utf8")).not.toContain("git/blobs");
    expect(readFileSync(join(import.meta.dirname, "feed-sync.ts"), "utf8")).not.toContain('join(dir, "payload")');
  });

  it("does not publish a site from a feed commit whose signature was tampered", () => {
    const dir = temp();
    const key = join(dir, "feed");
    expect(spawnSync("ssh-keygen", ["-t", "ed25519", "-f", key, "-N", "", "-C", "feed-test", "-q"]).status).toBe(0);
    const pub = spawnSync("ssh-keygen", ["-y", "-f", key], { encoding: "utf8" });
    const signers = join(dir, "allowed");
    writeFileSync(signers, `${allowedSignerLine({ identity: FEED_NAMESPACE, namespace: FEED_NAMESPACE, publicKey: pub.stdout.trim() })}\n`);
    const latest = emptyFeed({ channel: "latest", now: WHEN, keySetVersion: 1 });
    const stable = emptyFeed({ channel: "stable", now: WHEN, keySetVersion: 1 });
    const files = [
      { name: "latest.json", body: latest },
      { name: "latest.json.sig", body: signBytes({ bytes: Buffer.from(latest), keyPath: key, namespace: FEED_NAMESPACE, dir }).toString("utf8") },
      { name: "stable.json", body: stable },
      { name: "stable.json.sig", body: signBytes({ bytes: Buffer.from(stable), keyPath: key, namespace: FEED_NAMESPACE, dir }).toString("utf8") },
    ];
    const site = join(dir, "site");
    const tampered = files.map(file => file.name === "latest.json" ? { ...file, body: "{\"seq\":9}\n" } : file);
    expect(() => writeVerifiedSite(site, signers, tampered)).toThrow(/signature/i);
    expect(existsSync(join(site, "latest.json"))).toBe(false);
    expect(existsSync(join(site, ".check"))).toBe(false);
    writeVerifiedSite(site, signers, files);
    expect(readFileSync(join(site, "latest.json"), "utf8")).toBe(latest);

    const malformed = "{\"seq\":4}\n";
    const bad = [
      { name: "latest.json", body: malformed },
      { name: "latest.json.sig", body: signBytes({ bytes: Buffer.from(malformed), keyPath: key, namespace: FEED_NAMESPACE, dir }).toString("utf8") },
      { name: "stable.json", body: malformed },
      { name: "stable.json.sig", body: signBytes({ bytes: Buffer.from(malformed), keyPath: key, namespace: FEED_NAMESPACE, dir }).toString("utf8") },
    ];
    const refused = join(dir, "refused");
    expect(() => writeVerifiedSite(refused, signers, bad)).toThrow(/shape/i);
    expect(existsSync(join(refused, "latest.json"))).toBe(false);
  });

  it("retries a feed ref only when GitHub says it moved or already exists", () => {
    expect(refUpdateResult(false, "422 Update is not a fast forward")).toBe("moved");
    expect(refUpdateResult(false, "409 reference moved")).toBe("moved");
    expect(refUpdateResult(false, "422 Reference already exists")).toBe("moved");
    expect(() => refUpdateResult(false, "422 Object does not exist")).toThrow(/Object does not exist/);
    expect(refUpdateResult(true, "")).toBe("ok");
  });

  it("does not deploy a site older than the feed head", () => {
    const heads = [
      { sha: "aaa", seq: 4 },
      { sha: "bbb", seq: 5 },
      { sha: "bbb", seq: 5 },
      { sha: "bbb", seq: 5 },
    ];
    let i = 0;
    const built: string[] = [];
    const site = freshSite(
      () => heads[i++] ?? heads[heads.length - 1]!,
      (head) => { built.push(head.sha); return head; },
      () => null,
    );
    expect(built).toEqual(["aaa", "bbb"]);
    expect(site).toEqual({ sha: "bbb", seq: 5 });
  });

  it("does not deploy a feed numbered below the one already deployed, and does deploy an equal or higher one", () => {
    const at = (seq: number, deployed: number | null) => freshSite(() => ({ sha: "bbb", seq }), head => head, () => deployed);
    expect(() => at(3, 4)).toThrow(/older than the deployed feed/);
    expect(at(4, 4)).toEqual({ sha: "bbb", seq: 4 });
    expect(at(5, 4)).toEqual({ sha: "bbb", seq: 5 });
    expect(at(1, null)).toEqual({ sha: "bbb", seq: 1 });
  });

  it("reads the deployed feed's number from the Pages site, and nothing when there is no site or no feed", () => {
    const bin = temp();
    const fake = (body: string) => writeFileSync(join(bin, "gh"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    try {
      const feed = emptyFeed({ channel: "latest", now: WHEN, keySetVersion: 1 }).replace('"seq": 1', '"seq": 7');
      fake("echo https://example.invalid/site/");
      const urls: string[] = [];
      expect(deployedSeq("o/r", url => { urls.push(url); return feed; })).toBe(7);
      expect(urls).toEqual(["https://example.invalid/site/latest.json"]);
      expect(deployedSeq("o/r", () => null)).toBeNull();
      fake("echo 'gh: Not Found (HTTP 404)' >&2; exit 1");
      expect(deployedSeq("o/r", () => feed)).toBeNull();
      fake("echo 'gh: Server Error (HTTP 500)' >&2; exit 1");
      expect(() => deployedSeq("o/r", () => feed)).toThrow(/pages site failed/);
    } finally {
      process.env.PATH = path;
    }
  });

  describe("the prepare step", () => {
    const manifestOf = (dir: string) => {
      const path = join(dir, "manifest.json");
      writeFileSync(path, "{}\n");
      return path;
    };
    const publish = (dir: string, io: { head: () => string | null; read: (sha: string, file: string) => string | null }) => prepareFeeds({
      mode: "publish", repository: "o/r", dir: join(dir, "site"), signers: join(dir, "none"), scratch: dir, now: WHEN,
      version: "0.1.0", manifestPath: manifestOf(dir), manifestUrl: "https://example.invalid/manifest.json", keySetVersion: 1,
    }, io);

    it("starts both feeds at 1 only when there is no feed branch at all", () => {
      const dir = temp();
      expect(publish(dir, { head: () => null, read: () => { throw new Error("no branch to read"); } })).toBe("ready");
      expect(ChannelFeedSchema.parse(JSON.parse(readFileSync(join(dir, "site/latest.json"), "utf8"))).seq).toBe(1);
      expect(ChannelFeedSchema.parse(JSON.parse(readFileSync(join(dir, "site/stable.json"), "utf8"))).seq).toBe(1);
    });

    it("refuses to restart a feed whose branch exists but whose file is missing", () => {
      for (const missing of ["latest.json", "stable.json"]) {
        const dir = temp();
        const io = { head: () => "aaa", read: (_sha: string, file: string) => file === missing ? null : "x" };
        expect(() => publish(dir, io), missing).toThrow(/refusing to start the feed again at 1/);
        expect(existsSync(join(dir, "site/latest.json")), missing).toBe(false);
      }
    });

    it("refuses a re-sign of a branch that lacks a feed, and skips when there is no branch", () => {
      const dir = temp();
      const re = (io: { head: () => string | null; read: (sha: string, file: string) => string | null }) => prepareFeeds({
        mode: "resign", repository: "o/r", dir: join(dir, "site"), signers: join(dir, "none"), scratch: dir, now: WHEN,
      }, io);
      expect(re({ head: () => null, read: () => null })).toBe("absent");
      expect(() => re({ head: () => "aaa", read: () => null })).toThrow(/refusing to start the feed again at 1/);
    });
  });

  describe("the key-set version", () => {
    const keys = (version: number) => JSON.stringify({
      schema: 1, version, expiresAt: "2027-11-02T10:00:00Z", root: ["SHA256:r"], release: ["SHA256:a"], feed: ["SHA256:b"],
    });

    it("comes from trust/keys.json, so a rotation to set 2 reaches the next feed", () => {
      const dir = temp();
      const file = join(dir, "keys.json");
      writeFileSync(file, keys(2));
      expect(keySetVersion(file)).toBe(2);
      const run = spawnSync(process.execPath, [join(import.meta.dirname, "main.ts"), "key-set", "--keys", file], { encoding: "utf8" });
      expect(run.stdout.trim()).toBe("2");
      const feed = prepareFeeds({
        mode: "publish", repository: "o/r", dir: join(dir, "site"), signers: join(dir, "none"), scratch: dir, now: WHEN,
        version: "0.1.0", manifestPath: file, manifestUrl: "https://example.invalid/manifest.json", keySetVersion: keySetVersion(file),
      }, { head: () => null, read: () => null });
      expect(feed).toBe("ready");
      expect(ChannelFeedSchema.parse(JSON.parse(readFileSync(join(dir, "site/latest.json"), "utf8"))).keySetVersion).toBe(2);
    });

    it("refuses a missing, malformed or version-less key set", () => {
      const dir = temp();
      expect(() => keySetVersion(join(dir, "missing.json"))).toThrow();
      writeFileSync(join(dir, "bad.json"), "{\"version\":0}");
      expect(() => keySetVersion(join(dir, "bad.json"))).toThrow(/key set/);
    });
  });

  describe("the commit step", () => {
    function signed() {
      const dir = temp();
      const key = join(dir, "feed");
      expect(spawnSync("ssh-keygen", ["-t", "ed25519", "-f", key, "-N", "", "-C", "feed-test", "-q"]).status).toBe(0);
      const pub = spawnSync("ssh-keygen", ["-y", "-f", key], { encoding: "utf8" });
      const signers = join(dir, "allowed");
      writeFileSync(signers, `${allowedSignerLine({ identity: FEED_NAMESPACE, namespace: FEED_NAMESPACE, publicKey: pub.stdout.trim() })}\n`);
      const site = join(dir, "site");
      mkdirSync(site);
      for (const channel of ["latest", "stable"] as const) {
        const body = emptyFeed({ channel, now: WHEN, keySetVersion: 1 });
        writeFileSync(join(site, `${channel}.json`), body);
        // The shell step signs with ssh-keygen -Y sign, which writes <file>.sig.
        expect(spawnSync("ssh-keygen", ["-Y", "sign", "-f", key, "-n", FEED_NAMESPACE, join(site, `${channel}.json`)]).status).toBe(0);
      }
      writeFileSync(join(site, "feed-prepared.json"), JSON.stringify({ head: "aaa", message: "m" }));
      return { dir, site, signers };
    }

    it("pushes the signed feeds on the head prepare read", () => {
      const { dir, site, signers } = signed();
      const pushed: Array<string | null> = [];
      commitFeeds({ repository: "o/r", dir: site, signers, scratch: dir }, { head: () => "aaa", write: parent => { pushed.push(parent); return "ok"; } });
      expect(pushed).toEqual(["aaa"]);
    });

    it("fails, and pushes nothing, when the branch moved since prepare", () => {
      const { dir, site, signers } = signed();
      const pushed: unknown[] = [];
      expect(() => commitFeeds({ repository: "o/r", dir: site, signers, scratch: dir }, { head: () => "bbb", write: () => { pushed.push(1); return "ok"; } })).toThrow(MOVED);
      expect(() => commitFeeds({ repository: "o/r", dir: site, signers, scratch: dir }, { head: () => "aaa", write: () => "moved" })).toThrow(MOVED);
      expect(pushed).toEqual([]);
    });

    it("refuses an unsigned or tampered feed", () => {
      const { dir, site, signers } = signed();
      const io = { head: () => "aaa", write: () => "ok" as const };
      writeFileSync(join(site, "latest.json"), "{\"seq\":9}\n");
      expect(() => commitFeeds({ repository: "o/r", dir: site, signers, scratch: dir }, io)).toThrow(/signature/i);
      rmSync(join(site, "stable.json.sig"));
      writeFileSync(join(site, "latest.json"), emptyFeed({ channel: "latest", now: WHEN, keySetVersion: 1 }));
      expect(() => commitFeeds({ repository: "o/r", dir: site, signers, scratch: dir }, io)).toThrow(/signature|not signed/i);
    });
  });

  it("raises seq from the last published feed", () => {
    const published = JSON.parse(publishRelease(null, { channel: "latest", entry, now: WHEN, keySetVersion: 1 })) as { seq: number };
    published.seq = 5;
    const next = ChannelFeedSchema.parse(JSON.parse(publishRelease(JSON.stringify(published), {
      channel: "latest", entry: later, now: WHEN + 1000, keySetVersion: 1,
    })));
    expect(next.seq).toBe(6);
  });

  it("a re-sign changes the number, the issue time and the expiry, and nothing else", () => {
    const base = publishRelease(null, { channel: "latest", entry, now: WHEN, keySetVersion: 1 });
    const withWithdrawal = base.replace('"withdrawn": []', '"withdrawn": ["0.0.9"]');
    const nextAt = WHEN + 7 * 24 * 60 * 60 * 1000;
    const out = ChannelFeedSchema.parse(JSON.parse(resignFeed(withWithdrawal, nextAt)));
    const before = ChannelFeedSchema.parse(JSON.parse(withWithdrawal));
    expect(out.seq).toBe(before.seq + 1);
    expect(out.expiresAt - out.issuedAt).toBe(FEED_TTL_MS);
    expect(out.issuedAt).not.toBe(before.issuedAt);
    expect(out.expiresAt).not.toBe(before.expiresAt);
    expect(out.schema).toBe(before.schema);
    expect(out.channel).toBe(before.channel);
    expect(out.keySetVersion).toBe(before.keySetVersion);
    expect(out.releases).toEqual(before.releases);
    expect(out.withdrawn).toEqual(before.withdrawn);
  });

  it("an empty stable feed is seq 1 with no releases", () => {
    const parsed = ChannelFeedSchema.parse(JSON.parse(emptyFeed({ channel: "stable", now: WHEN, keySetVersion: 1 })));
    expect(parsed.seq).toBe(1);
    expect(parsed.releases).toEqual([]);
    expect(parsed.channel).toBe("stable");
  });
});

describe("launchers follow the package bins", () => {
  const root = dirname(dirname(fileURLToPath(new URL(".", import.meta.url))));

  function bins(repo: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const top of ["apps", "packages"]) {
      for (const dir of readdirSync(join(repo, top))) {
        const file = join(repo, top, dir, "package.json");
        if (!existsSync(file)) continue;
        const bin = (JSON.parse(readFileSync(file, "utf8")) as { bin?: Record<string, string> }).bin ?? {};
        for (const [name, path] of Object.entries(bin)) out[name] = `app/${top}/${dir}/${path.replace(/^\.\//, "")}`;
      }
    }
    return out;
  }

  it("every bin in the tree has a launcher that runs its file", () => {
    const want = bins(root);
    expect(Object.keys(want)).toContain("morndo-secrets");
    expect(launchersFrom(root)).toEqual(want);
  });

  it("a new CLI cannot be missed: its bin gets a launcher without a list to edit", () => {
    const repo = temp();
    mkdirSync(join(repo, "apps/tool/src"), { recursive: true });
    writeFileSync(join(repo, "apps/tool/package.json"), '{"name":"@morndo/tool","bin":{"morndo-tool":"./src/main.ts","morndo-tool-two":"src/two.ts"}}\n');
    expect(launchersFrom(repo)).toEqual({ "morndo-tool": "app/apps/tool/src/main.ts", "morndo-tool-two": "app/apps/tool/src/two.ts" });
  });

  it("a launcher reached through `good` runs the good Version while `current` names a broken one (§6.6)", () => {
    // The recovery unit runs releases/good/bin/morndo-update: after a crash mid-swap `current` may name a Version
    // that cannot even start, and recovery must not depend on it. Each Version's node is a stub naming its Version.
    const releases = temp();
    for (const [v, node] of [["0.1.0", '#!/bin/sh\necho "ran 0.1.0 $*"\n'], ["0.2.0", "#!/bin/sh\nexit 70\n"]] as const) {
      mkdirSync(join(releases, v, "bin"), { recursive: true });
      mkdirSync(join(releases, v, "node/bin"), { recursive: true });
      writeFileSync(join(releases, v, "bin/morndo-update"), launcherSource("app/apps/updater/src/main.ts"), { mode: 0o755 });
      writeFileSync(join(releases, v, "node/bin/node"), node, { mode: 0o755 });
    }
    symlinkSync("0.1.0", join(releases, "good"));
    symlinkSync("0.2.0", join(releases, "current"));
    const viaGood = spawnSync(join(releases, "good/bin/morndo-update"), ["update", "recover"], { encoding: "utf8" });
    expect(viaGood.status, viaGood.stderr).toBe(0);
    expect(viaGood.stdout).toBe(`ran 0.1.0 ${realpathSync(releases)}/0.1.0/bin/../app/apps/updater/src/main.ts update recover\n`);
    expect(spawnSync(join(releases, "current/bin/morndo-update"), ["update", "recover"]).status).toBe(70);
  });

  it("refuses a bin path that leaves its package, and two packages that claim one name", () => {
    const repo = temp();
    mkdirSync(join(repo, "apps/a"), { recursive: true });
    mkdirSync(join(repo, "apps/b"), { recursive: true });
    writeFileSync(join(repo, "apps/a/package.json"), '{"bin":{"x":"../b/main.ts"}}\n');
    expect(() => launchersFrom(repo)).toThrow(/leaves its package/);
    writeFileSync(join(repo, "apps/a/package.json"), '{"bin":{"x":"./main.ts"}}\n');
    writeFileSync(join(repo, "apps/b/package.json"), '{"bin":{"x":"./main.ts"}}\n');
    expect(() => launchersFrom(repo)).toThrow(/two packages/);
  });
});

describe("stage, launchers, node pin, notice", () => {
  it("stages the build stamp: the Release's Version and commit, listed in files.json", () => {
    const repo = temp();
    const nodeDir = temp();
    writeFileSync(join(repo, "package.json"), '{"name":"morndo","version":"0.0.0"}\n');
    writeFileSync(join(repo, "LICENSE.md"), "AGPL\n");
    mkdirSync(join(nodeDir, "bin"), { recursive: true });
    writeFileSync(join(nodeDir, "bin/node"), "#!/bin/sh\n");
    const dest = join(temp(), "out");
    stageRelease({ repo, nodeDir, dest, version: "0.3.1", commit: STAMP_COMMIT });
    expect(JSON.parse(readFileSync(join(dest, "app/build.json"), "utf8"))).toEqual({ version: "0.3.1", commit: STAMP_COMMIT });
    expect(readFileSync(join(dest, "files.json"), "utf8")).toContain("app/build.json");
  });

  it("stages a fixture tree twice into archives with the same bytes", () => {
    const repo = temp();
    const nodeDir = temp();
    mkdirSync(join(repo, "apps/hub/src"), { recursive: true });
    mkdirSync(join(repo, "docs"), { recursive: true });
    mkdirSync(join(nodeDir, "bin"), { recursive: true });
    writeFileSync(join(repo, "package.json"), '{"name":"morndo","version":"0.1.0"}\n');
    writeFileSync(join(repo, "package-lock.json"), '{"name":"morndo","lockfileVersion":3,"packages":{}}\n');
    writeFileSync(join(repo, "LICENSE.md"), "AGPL\n");
    writeFileSync(join(repo, "apps/hub/src/main.ts"), "export {}\n");
    writeFileSync(join(repo, "apps/hub/package.json"), '{"name":"@morndo/hub","bin":{"morndo":"./src/main.ts"}}\n');
    writeFileSync(join(repo, "apps/hub/src/main.test.ts"), "nope\n");
    writeFileSync(join(repo, "docs/notes.md"), "not in the archive\n");
    mkdirSync(join(repo, "apps/updater/units/launchd"), { recursive: true });
    writeFileSync(join(repo, "apps/updater/units/morndo-hub.service"), "[Unit]\nDescription=fixture hub\n");
    writeFileSync(join(repo, "apps/updater/units/launchd/com.morndo.hub.plist"), "<plist version=\"1.0\"/>\n");
    writeFileSync(join(nodeDir, "bin/node"), "#!/bin/sh\n", { mode: 0o755 });
    const outside = join(temp(), "outside");
    writeFileSync(outside, "nope\n");
    symlinkSync(outside, join(repo, "escape"));
    expect(() => stageRelease({ repo, nodeDir, dest: join(temp(), "out"), version: "0.1.0", commit: STAMP_COMMIT })).toThrow(/symlink/i);
    rmSync(join(repo, "escape"));
    const destA = join(temp(), "a");
    const destB = join(temp(), "b");
    stageRelease({ repo, nodeDir, dest: destA, version: "0.1.0", commit: STAMP_COMMIT });
    stageRelease({ repo, nodeDir, dest: destB, version: "0.1.0", commit: STAMP_COMMIT });
    const files = (root: string) => FileListSchema.parse(JSON.parse(readFileSync(join(root, "files.json"), "utf8"))).map(e => e.path);
    expect(files(destA)).toEqual(files(destB));
    expect(files(destA).some(p => p.includes("docs/") || p.endsWith(".test.ts"))).toBe(false);
    expect(files(destA)).toContain("bin/morndo");
    expect(files(destA)).toContain("units");
    expect(files(destA)).toContain("trust");
    expect(files(destA)).toContain("units/morndo-hub.service");
    expect(files(destA)).toContain("units/launchd/com.morndo.hub.plist");
    expect(readFileSync(join(destA, "units/morndo-hub.service"), "utf8")).toBe("[Unit]\nDescription=fixture hub\n");
    expect(files(destA)).toContain("LICENSES/LICENSE.md");
    expect(readFileSync(join(destA, "bin/morndo"), "utf8")).toBe(launcherSource("app/apps/hub/src/main.ts"));
    const packedA = packTree(readStaged(destA), 1_700_000_000);
    const packedB = packTree(readStaged(destB), 1_700_000_000);
    expect(Buffer.from(packedA).equals(packedB)).toBe(true);
    const listed = spawnSync("tar", ["-tzf", "-"], { input: packedA, encoding: "utf8" });
    expect(listed.stdout).toContain("units/");
    expect(listed.stdout).toContain("trust/");
  });

  it("stages the updater's own unit templates into units/, read-only and in the signed file list", () => {
    const repo = temp();
    const nodeDir = temp();
    mkdirSync(join(repo, "apps/hub/src"), { recursive: true });
    mkdirSync(join(nodeDir, "bin"), { recursive: true });
    writeFileSync(join(repo, "package.json"), '{"name":"morndo","version":"0.1.0"}\n');
    writeFileSync(join(repo, "package-lock.json"), '{"name":"morndo","lockfileVersion":3,"packages":{}}\n');
    writeFileSync(join(repo, "LICENSE.md"), "AGPL\n");
    writeFileSync(join(repo, "apps/hub/src/main.ts"), "export {}\n");
    writeFileSync(join(repo, "apps/hub/package.json"), '{"name":"@morndo/hub","bin":{"morndo":"./src/main.ts"}}\n');
    writeFileSync(join(nodeDir, "bin/node"), "#!/bin/sh\n");
    cpSync(join(import.meta.dirname, "../../apps/updater/units"), join(repo, "apps/updater/units"), { recursive: true });
    const dest = join(temp(), "out");
    stageRelease({ repo, nodeDir, dest, version: "0.1.0", commit: STAMP_COMMIT });
    const listed = FileListSchema.parse(JSON.parse(readFileSync(join(dest, "files.json"), "utf8")));
    const templates = (dir: string, prefix = ""): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? templates(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]);
    const names = templates(join(repo, "apps/updater/units"));
    expect(names.length).toBeGreaterThan(10);              // the design's whole set, not a stub
    for (const name of names) {
      expect(listed, name).toContainEqual({
        path: `units/${name}`, mode: "0444", sha256: sha256(readFileSync(join(dest, "units", name))),
      });
      expect(readFileSync(join(dest, "units", name), "utf8"))
        .toBe(readFileSync(join(repo, "apps/updater/units", name), "utf8"));
    }
  });

  it("keeps an in-tree symlink and ships a workspace package as JavaScript", () => {
    const repo = temp();
    const nodeDir = temp();
    mkdirSync(join(repo, "packages/domain/src"), { recursive: true });
    mkdirSync(join(repo, "node_modules/@morndo"), { recursive: true });
    mkdirSync(join(nodeDir, "bin"), { recursive: true });
    mkdirSync(join(nodeDir, "lib"), { recursive: true });
    writeFileSync(join(repo, "package.json"), '{"name":"morndo","version":"0.1.0","workspaces":["packages/*"]}\n');
    writeFileSync(join(repo, "package-lock.json"), '{"name":"morndo","lockfileVersion":3,"packages":{}}\n');
    writeFileSync(join(repo, "LICENSE.md"), "AGPL\n");
    writeFileSync(join(repo, "packages/domain/package.json"), '{"name":"@morndo/domain","exports":{".":"./src/index.ts"}}\n');
    writeFileSync(join(repo, "packages/domain/src/index.ts"), "export const n = 1;\n");
    symlinkSync("../../packages/domain", join(repo, "node_modules/@morndo/domain"));
    writeFileSync(join(nodeDir, "bin/node"), "#!/bin/sh\n");
    writeFileSync(join(nodeDir, "lib/npm-cli.js"), "#!/bin/sh\necho npm\n");
    symlinkSync("../lib/npm-cli.js", join(nodeDir, "bin/npm"));
    const compiled = temp();
    mkdirSync(join(compiled, "domain/src"), { recursive: true });
    writeFileSync(join(compiled, "domain/package.json"), '{"name":"@morndo/domain","exports":{".":"./src/index.js"}}\n');
    writeFileSync(join(compiled, "domain/src/index.js"), "export const n = 1;\n");
    const dest = join(temp(), "out");
    stageRelease({ repo, nodeDir, dest, version: "0.1.0", commit: STAMP_COMMIT, compiled });
    expect(readlinkSync(join(dest, "node/bin/npm"))).toBe("../lib/npm-cli.js");
    const linkedRoot = temp();
    const via = join(linkedRoot, "via");
    symlinkSync(nodeDir, via);
    const linkedDest = join(temp(), "linked-out");
    stageRelease({ repo, nodeDir: via, dest: linkedDest, version: "0.1.0", commit: STAMP_COMMIT, compiled });
    expect(readlinkSync(join(linkedDest, "node/bin/npm"))).toBe("../lib/npm-cli.js");
    mkdirSync(join(repo, "apps/hub/src"), { recursive: true });
    mkdirSync(join(repo, "apps/hub/test"), { recursive: true });
    writeFileSync(join(repo, "apps/hub/src/index.ts"), "export const live = 1;\n");
    writeFileSync(join(repo, "apps/hub/test/hidden.ts"), "export const hidden = 1;\n");
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "docs/x.md"), "outside the staged set\n");
    symlinkSync("index.ts", join(repo, "apps/hub/src/alias.ts"));
    symlinkSync("../test/hidden.ts", join(repo, "apps/hub/src/from-test.ts"));
    symlinkSync("../../../docs/x.md", join(repo, "apps/hub/src/doc.md"));
    const withLinks = join(temp(), "links-out");
    stageRelease({ repo, nodeDir, dest: withLinks, version: "0.1.0", commit: STAMP_COMMIT, compiled });
    expect(readlinkSync(join(withLinks, "app/apps/hub/src/alias.ts"))).toBe("index.ts");
    expect(lstatSync(join(withLinks, "app/apps/hub/src/from-test.ts")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(withLinks, "app/apps/hub/src/from-test.ts"), "utf8")).toBe("export const hidden = 1;\n");
    expect(lstatSync(join(withLinks, "app/apps/hub/src/doc.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(withLinks, "app/apps/hub/src/doc.md"), "utf8")).toBe("outside the staged set\n");
    symlinkSync("../test", join(repo, "apps/hub/src/skipped-dir"));
    expect(() => stageRelease({ repo, nodeDir, dest: join(temp(), "bad-link"), version: "0.1.0", commit: STAMP_COMMIT, compiled })).toThrow(new RegExp(`unshipped directory: ${join(repo, "apps/hub/test")}`));
    expect(lstatSync(join(dest, "app/node_modules/@morndo/domain")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dest, "app/node_modules/@morndo/domain/src/index.js"), "utf8")).toBe("export const n = 1;\n");
    expect(readFileSync(join(dest, "app/node_modules/@morndo/domain/package.json"), "utf8")).toContain("./src/index.js");
  });

  it("does not let a package.json export replace the rewritten manifest", () => {
    const repo = join(import.meta.dirname, "../..");
    const dir = temp();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/index.ts"), "export const n = 1;\n");
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({
      name: "@morndo/sample", type: "module",
      exports: { ".": "./src/index.ts", "./package.json": "./package.json" },
    })}\n`);
    writeFileSync(join(dir, "tsconfig.json"), `${JSON.stringify({
      compilerOptions: { target: "es2022", module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true },
      include: ["src"],
    })}\n`);
    const out = temp();
    compilePackage(repo, dir, join(out, "sample"), join(out, "sample.tsconfig.json"));
    const staged = readFileSync(join(out, "sample/package.json"), "utf8");
    expect(staged).toContain("./src/index.js");
    expect(staged).not.toContain("./src/index.ts");
  });

  it("copies brand assets into the compiled package", () => {
    const tree = join(import.meta.dirname, "../..");
    const compiled = temp();
    compilePackage(tree, join(tree, "packages/brand"), join(compiled, "brand"), join(compiled, "brand.tsconfig.json"));
    const repo = temp();
    const nodeDir = temp();
    mkdirSync(join(repo, "packages/brand"), { recursive: true });
    mkdirSync(join(repo, "node_modules/@morndo"), { recursive: true });
    mkdirSync(join(nodeDir, "bin"), { recursive: true });
    writeFileSync(join(repo, "package.json"), '{"name":"morndo","version":"0.1.0","workspaces":["packages/*"]}\n');
    writeFileSync(join(repo, "package-lock.json"), '{"name":"morndo","lockfileVersion":3,"packages":{}}\n');
    writeFileSync(join(repo, "LICENSE.md"), "AGPL\n");
    writeFileSync(join(repo, "packages/brand/package.json"), '{"name":"@morndo/brand"}\n');
    symlinkSync("../../packages/brand", join(repo, "node_modules/@morndo/brand"));
    writeFileSync(join(nodeDir, "bin/node"), "#!/bin/sh\n");
    const dest = join(temp(), "out");
    stageRelease({ repo, nodeDir, dest, version: "0.1.0", commit: STAMP_COMMIT, compiled });
    const css = readFileSync(join(dest, "app/node_modules/@morndo/brand/assets/tokens/morndo-tokens.css"), "utf8");
    expect(css.length).toBeGreaterThan(0);
    expect(readFileSync(join(dest, "app/node_modules/@morndo/brand/assets/mark/morndo-mark-black.svg"), "utf8")).toContain("<svg");
  });

  it("names the pinned Node 24 tarballs and notices a newer 24", () => {
    expect(BUNDLED_NODE).toBe("24.21.0");
    expect(nodeTarball("linux-x64")).toBe("node-v24.21.0-linux-x64.tar.gz");
    expect(nodeTarball("linux-arm64")).toBe("node-v24.21.0-linux-arm64.tar.gz");
    expect(nodeTarball("darwin-arm64")).toBe("node-v24.21.0-darwin-arm64.tar.gz");
    expect(newerNode24([{ version: "v24.21.0" }, { version: "v26.11.1" }])).toBeNull();
    expect(newerNode24([{ version: "v24.22.0" }, { version: "v24.21.0" }])).toBe("24.22.0");
  });

  it("lists production packages from a lockfile, skipping dev ones", () => {
    const notice = thirdPartyNotice({
      packages: {
        "": { version: "0.1.0" },
        "node_modules/leftpad": { version: "1.2.3" },
        "node_modules/types": { version: "9.0.0", dev: true },
      },
    });
    expect(notice).toContain("leftpad 1.2.3");
    expect(notice).not.toContain("types");
    expect(notice).not.toContain("0.1.0");
  });
});

describe("install.sh", () => {
  const platform = (): "linux-x64" | "linux-arm64" | "darwin-arm64" => {
    const os = spawnSync("uname", ["-s"], { encoding: "utf8" }).stdout.trim();
    const arch = spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout.trim();
    if (os === "Linux" && arch === "x86_64") return "linux-x64";
    if (os === "Linux" && arch === "aarch64") return "linux-arm64";
    if (os === "Darwin" && arch === "arm64") return "darwin-arm64";
    throw new Error(`unsupported test platform ${os} ${arch}`);
  };

  const fixture = (p: { tamper?: boolean; size?: number; archive?: Buffer | ((marker: string) => Buffer) }) => {
    const dir = temp();
    const key = join(dir, "release");
    expect(spawnSync("ssh-keygen", ["-t", "ed25519", "-f", key, "-N", "", "-C", "release-test", "-q"]).status).toBe(0);
    const pub = spawnSync("ssh-keygen", ["-y", "-f", key], { encoding: "utf8" });
    const signers = join(dir, "allowed");
    writeFileSync(signers, `${allowedSignerLine({ identity: RELEASE_NAMESPACE, namespace: RELEASE_NAMESPACE, publicKey: pub.stdout.trim() })}\n`);
    const marker = join(dir, "marker");
    const payload = new TextEncoder().encode(`#!/bin/sh\nprintf '%s\\n' "$*" > "${marker}"\n`);
    const archive = typeof p.archive === "function"
      ? p.archive(marker)
      : p.archive ?? packTree([{ path: "bin/morndo", bytes: payload, mode: "0555" }], 1_700_000_000);
    const host = platform();
    const name = artifactName("0.1.0", host);
    const files = listFiles([{ path: "bin/morndo", bytes: payload, mode: "0555" }]);
    let manifest = buildManifest({
      version: "0.1.0", commit: COMMIT, publishedAt: WHEN, repository: "morndo/morndo",
      protocol: protocolRange(), schemas: declaredSchemas(),
      artifacts: [{ platform: host, name, size: p.size ?? archive.length, sha256: sha256(archive), filesSha256: files.sha256, node: BUNDLED_NODE }],
    });
    if (p.tamper) manifest = manifest.replace("0.1.0", "0.1.1");
    const manifestBytes = new TextEncoder().encode(manifest);
    const signature = signBytes({ bytes: manifestBytes, keyPath: key, namespace: RELEASE_NAMESPACE, dir });
    const base = join(dir, "base");
    mkdirSync(base);
    writeFileSync(join(base, "manifest.json"), manifestBytes);
    writeFileSync(join(base, "manifest.json.sig"), signature);
    writeFileSync(join(base, name), archive);
    const script = stampVersion(readFileSync(join(import.meta.dirname, "../../install.sh"), "utf8"), "0.1.0")
      .replace("MORNDO_HAS_INSTALL='no'", "MORNDO_HAS_INSTALL='yes'");
    const scriptPath = join(dir, "install.sh");
    writeFileSync(scriptPath, script, { mode: 0o755 });
    return { dir, signers, marker, scriptPath, base };
  };

  it("refuses an unstamped script", () => {
    const source = readFileSync(join(import.meta.dirname, "../../install.sh"), "utf8");
    expect(source).toContain(UNSTAMPED_VERSION);
    const dir = temp();
    const script = join(dir, "install.sh");
    writeFileSync(script, source, { mode: 0o755 });
    const run = spawnSync("sh", [script, "--role", "node", "--signers", join(dir, "missing")], { encoding: "utf8" });
    expect(run.status).toBe(78);
  });

  it("fails loudly, and creates nothing, when the flag says this release has no `morndo install`", () => {
    const dir = temp();
    const home = join(dir, "home");
    mkdirSync(home);
    const script = join(dir, "install.sh");
    // The shipped script says 'yes' (the hub forwards install); a release that could not ships 'no', and the
    // guard must still fire there — a hub without the command would print help, exit 0, install nothing.
    writeFileSync(script, stampVersion(readFileSync(join(import.meta.dirname, "../../install.sh"), "utf8"), "0.1.0")
      .replace("MORNDO_HAS_INSTALL='yes'", "MORNDO_HAS_INSTALL='no'"), { mode: 0o755 });
    const signers = join(dir, "allowed");
    writeFileSync(signers, "x\n");
    const run = spawnSync("sh", [script, "--role", "control-plane", "--signers", signers], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, MORNDO_RELEASE_BASE: `file://${join(dir, "no-such-release")}` },
    });
    expect(run.status).toBe(69);
    expect(run.stderr).toMatch(/morndo install is not in this release/);
    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(["allowed", "home", "install.sh"]);
  });

  it("control: the same script with the flag on goes on to fetch the release", () => {
    const dir = temp();
    const script = join(dir, "install.sh");
    writeFileSync(script, stampVersion(readFileSync(join(import.meta.dirname, "../../install.sh"), "utf8"), "0.1.0").replace("MORNDO_HAS_INSTALL='no'", "MORNDO_HAS_INSTALL='yes'"), { mode: 0o755 });
    const signers = join(dir, "allowed");
    writeFileSync(signers, "x\n");
    const run = spawnSync("sh", [script, "--role", "control-plane", "--signers", signers], {
      encoding: "utf8",
      env: { ...process.env, MORNDO_RELEASE_BASE: `file://${join(dir, "no-such-release")}` },
    });
    expect(run.status).not.toBe(0);
    expect(run.status).not.toBe(69);
  });

  it("runs the archive's morndo only after the signature, the size and the digest match", () => {
    const good = fixture({});
    const run = spawnSync("sh", [good.scriptPath, "--role", "control-plane", "--signers", good.signers], {
      encoding: "utf8",
      env: { ...process.env, MORNDO_RELEASE_BASE: `file://${good.base}` },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(good.marker, "utf8")).toBe("install --role control-plane --channel stable\n");

    const bad = fixture({ tamper: true });
    const refused = spawnSync("sh", [bad.scriptPath, "--role", "node", "--signers", bad.signers], {
      encoding: "utf8",
      env: { ...process.env, MORNDO_RELEASE_BASE: `file://${bad.base}` },
    });
    expect(refused.status).not.toBe(0);
    expect(spawnSync("test", ["-f", bad.marker]).status).not.toBe(0);
  });

  it("refuses a packed link whose target leaves the tree", () => {
    expect(() => packTree([{ path: "app/x", mode: "0555", link: "../../../../outside" }], 1_700_000_000)).toThrow(/link/);
    expect(() => packTree([{ path: "node/bin/npm", mode: "0555", link: "../lib/npm-cli.js" }], 1_700_000_000)).not.toThrow();
  });

  // The reader's rule of 2026-10-21 (apps/updater/src/adapters/tar-read.ts): names are keyed by their folded form
  // (case and NFC/NFD), and a link is walked through the tree's own links. A tree the reader would refuse must
  // never be packed: P/UP names p/up on a file system that folds case, and two spellings of one folded name are
  // two entries here but one file on such a system.
  it("refuses a packed link that climbs out through another link, and folded names", () => {
    const composed = "café";        // é as one character
    const decomposed = "café";    // the same name as e + combining acute
    expect(() => packTree([
      { path: "p/up", mode: "0555", link: ".." },
      { path: "esc", mode: "0555", link: "P/UP/.." },
    ], 1_700_000_000)).toThrow(/through another link/);
    expect(() => packTree([
      { path: `${composed}/up`, mode: "0555", link: ".." },
      { path: "esc", mode: "0555", link: `${decomposed}/up/..` },
    ], 1_700_000_000)).toThrow(/through another link/);
    expect(() => packTree([
      { path: "README", mode: "0444", bytes: new Uint8Array([1]) },
      { path: "readme", mode: "0444", bytes: new Uint8Array([2]) },
    ], 1_700_000_000)).toThrow(/fold/);
    for (const [a, b] of [["stra\u00dfe", "strasse"], ["\ufb01le", "file"], ["\u03bb\u03bf\u03b3\u03bf\u03c2", "\u03bb\u03bf\u03b3\u03bf\u03c3"]] as const) {
      expect(() => packTree([
        { path: a, mode: "0444", bytes: new Uint8Array([1]) },
        { path: b, mode: "0444", bytes: new Uint8Array([2]) },
      ], 1_700_000_000), `${a} / ${b}`).toThrow(/fold/);
    }
    expect(() => packTree([
      { path: "a", mode: "0444", bytes: new Uint8Array([1]) },
      { path: "a/b", mode: "0444", bytes: new Uint8Array([2]) },
    ], 1_700_000_000)).toThrow(/duplicate/);
    expect(() => packTree([
      { path: "node/lib/x.js", mode: "0444", bytes: new Uint8Array([1]) },
      { path: "node/lib/up", mode: "0555", link: ".." },
      { path: "node/bin/npm", mode: "0555", link: "../lib/x.js" },
    ], 1_700_000_000)).not.toThrow();
  });

  it("refuses a dot-segment path and a name that contains a space", () => {
    for (const [name, link] of [["app/././x", "../../../outside"], ["../ x", ""]] as const) {
      const bad = fixture({ archive: craftArchive(name, link) });
      const run = spawnSync("sh", [bad.scriptPath, "--role", "node", "--signers", bad.signers], {
        encoding: "utf8",
        env: { ...process.env, MORNDO_RELEASE_BASE: `file://${bad.base}` },
      });
      expect(run.status, `${name}: ${run.stderr}`).not.toBe(0);
      expect(run.stderr, name).toMatch(/refusing archive path/);
      expect(spawnSync("test", ["-f", bad.marker]).status).not.toBe(0);
    }
    const newline = fixture({ archive: craftArchive("app/a\nb") });
    const run = spawnSync("sh", [newline.scriptPath, "--role", "node", "--signers", newline.signers], {
      encoding: "utf8",
      env: { ...process.env, MORNDO_RELEASE_BASE: `file://${newline.base}` },
    });
    expect(run.status, run.stderr).not.toBe(0);
    expect(run.stderr).toMatch(/refusing archive path/);
  });

  it("refuses a symlink whose target climbs out of the tree", () => {
    const bad = fixture({ archive: craftArchive("app/x", "../../../../outside") });
    const run = spawnSync("sh", [bad.scriptPath, "--role", "node", "--signers", bad.signers], {
      encoding: "utf8",
      env: { ...process.env, MORNDO_RELEASE_BASE: `file://${bad.base}` },
    });
    expect(run.status, run.stderr).toBe(65);
    expect(run.stderr).toMatch(/refusing archive path/);
  });

  it("refuses arrow names, star segments, dotdot names, and links that leave the tree", () => {
    const script = (marker: string) => Buffer.from(`#!/bin/sh\nprintf '%s\\n' "$*" > "${marker}"\n`);
    const cases: readonly (readonly [string, string])[] = [
      ["a -> b", "../x"],
      ["a/*/l", "../../../x"],
      ["../ x", ""],
      ["app/abs", "/tmp/outside"],
      ["app/climb", "../../../../outside"],
    ];
    for (const [name, link] of cases) {
      const bad = fixture({
        archive: marker => craftMembers([
          { name: "bin/morndo", body: script(marker) },
          { name, link },
        ]),
      });
      const run = spawnSync("sh", [bad.scriptPath, "--role", "node", "--signers", bad.signers], {
        encoding: "utf8",
        env: { ...process.env, MORNDO_RELEASE_BASE: `file://${bad.base}` },
      });
      expect(run.status, `${name}: ${run.stderr}`).not.toBe(0);
      expect(run.stderr, name).toMatch(/refusing archive path/);
      expect(spawnSync("test", ["-f", bad.marker]).status).not.toBe(0);
    }
    const kept = fixture({
      archive: marker => packTree([
        { path: "bin/morndo", bytes: script(marker), mode: "0555" },
        { path: "node/bin/npm", mode: "0555", link: "../lib/npm-cli.js" },
      ], 1_700_000_000),
    });
    const run = spawnSync("sh", [kept.scriptPath, "--role", "node", "--signers", kept.signers], {
      encoding: "utf8",
      env: { ...process.env, MORNDO_RELEASE_BASE: `file://${kept.base}` },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(kept.marker, "utf8")).toBe("install --role node --channel stable\n");
  });

  it("installs an in-tree link when temp is reached through a symlink and realpath rejects -m", () => {
    const script = (marker: string) => Buffer.from(`#!/bin/sh\nprintf '%s\\n' "$*" > "${marker}"\n`);
    const kept = fixture({
      archive: marker => packTree([
        { path: "bin/morndo", bytes: script(marker), mode: "0555" },
        { path: "node/bin/npm", mode: "0555", link: "../lib/npm-cli.js" },
      ], 1_700_000_000),
    });
    const real = join(kept.dir, "real-tmp");
    mkdirSync(real);
    const alias = join(kept.dir, "alias-tmp");
    symlinkSync(real, alias);
    const bin = join(kept.dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "realpath"), "#!/bin/sh\necho 'realpath: illegal option' >&2\nexit 1\n", { mode: 0o755 });
    const run = spawnSync("sh", [kept.scriptPath, "--role", "node", "--signers", kept.signers], {
      encoding: "utf8",
      env: { ...process.env, MORNDO_RELEASE_BASE: `file://${kept.base}`, TMPDIR: alias, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(kept.marker, "utf8")).toBe("install --role node --channel stable\n");
  });

  it("refuses an archive entry that climbs with .. or is absolute", () => {
    for (const name of ["./../x", "./a/../../x", "..", "./.."]) {
      const bad = fixture({ archive: craftArchive(name) });
      const run = spawnSync("sh", [bad.scriptPath, "--role", "node", "--signers", bad.signers], {
        encoding: "utf8",
        env: { ...process.env, MORNDO_RELEASE_BASE: `file://${bad.base}` },
      });
      expect(run.status, `${name}: ${run.stderr}`).not.toBe(0);
      expect(run.stderr, name).toMatch(/refusing archive path/);
      expect(spawnSync("test", ["-f", bad.marker]).status).not.toBe(0);
    }
  });
});

function craftArchive(entryName: string, link = ""): Buffer {
  return craftMembers([{ name: entryName, link }]);
}

function craftMembers(members: readonly { name: string; link?: string; body?: Buffer }[]): Buffer {
  const chunks = members.map(member => {
    const link = member.link ?? "";
    const body = link ? Buffer.alloc(0) : member.body ?? Buffer.alloc(0);
    const buf = Buffer.alloc(512);
    buf.write(member.name, 0);
    if (link) buf.write(link, 157);
    const oct = (at: number, width: number, value: number) => {
      buf.write(value.toString(8).padStart(width - 1, "0"), at, width - 1, "ascii");
    };
    oct(100, 8, 0o644);
    oct(108, 8, 0);
    oct(116, 8, 0);
    oct(124, 12, body.length);
    oct(136, 12, 0);
    buf.fill(0x20, 148, 156);
    buf.write(link ? "2" : "0", 156, 1, "ascii");
    buf.write("ustar\0", 257, 6, "binary");
    buf.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const byte of buf) sum += byte;
    buf.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    buf[154] = 0;
    buf[155] = 0x20;
    const pad = body.length === 0 ? Buffer.alloc(0) : Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
    return Buffer.concat([buf, pad]);
  });
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

// The staged tree, as the packer wants it: every file files.json names, plus files.json itself.
function readStaged(dest: string): TreeFile[] {
  const listed = FileListSchema.parse(JSON.parse(readFileSync(join(dest, "files.json"), "utf8")));
  const modeOf = (mode: string): "0444" | "0555" => {
    if (mode === "0444" || mode === "0555") return mode;
    throw new Error(`unexpected mode ${mode}`);
  };
  const out: TreeFile[] = listed.map(entry => {
    const abs = join(dest, entry.path);
    const st = lstatSync(abs);
    if (st.isDirectory()) return { path: entry.path, mode: "0555" as const, directory: true as const };
    if (st.isSymbolicLink()) return { path: entry.path, mode: "0555" as const, link: readlinkSync(abs) };
    return { path: entry.path, mode: modeOf(entry.mode), bytes: new Uint8Array(readFileSync(abs)) };
  });
  out.push({ path: "files.json", bytes: new Uint8Array(readFileSync(join(dest, "files.json"))), mode: "0444" });
  return out;
}
