// The release pipeline's local half (ADR-0019 §9, design §9 and §15 PR 3). A tag on a scratch
// repository, with the owner's keys, is what proves the GitHub jobs; everything that can be shown
// on this machine is here: the same tree packs to the same bytes twice, the file list and the
// Manifest are the wire documents, ssh-keygen accepts the signature, and re-signing a Feed moves
// its number and its expiry only.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelFeedSchema, FileListSchema, ManifestSchema } from "@morndo/protocol";
import { packTree, type TreeFile } from "./archive.ts";
import { emptyFeed, FEED_TTL_MS, publishRelease, resignFeed } from "./feed.ts";
import { listFiles } from "./files.ts";
import { launcherSource, LAUNCHERS } from "./launchers.ts";
import { artifactName, buildManifest, declaredSchemas, protocolRange } from "./manifest.ts";
import { BUNDLED_NODE, newerNode24, nodeTarball } from "./node-pin.ts";
import { sha256Sums } from "./checksums.ts";
import { allowedSignerLine, FEED_NAMESPACE, RELEASE_NAMESPACE, signBytes, verifyBytes } from "./sign.ts";
import { stageRelease } from "./stage.ts";
import { stampVersion, UNSTAMPED_VERSION } from "./stamp.ts";
import { thirdPartyNotice } from "./notice.ts";

const COMMIT = "ab".repeat(20);
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

  it("states this tree's schemas, including a floor of 0 where nothing breaking has shipped", () => {
    expect(declaredSchemas()).toEqual({
      hub: { version: 17, floor: 0 },
      fleet: { version: 14, floor: 7 },
      node: { version: 6, floor: 0 },
      connections: { version: 2, floor: 0 },
    });
    expect(protocolRange()).toEqual({ agent: [1, 1], clientApi: [1, 1] });
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
    expect(parsed.data.schemas.hub).toEqual({ version: 17, floor: 0 });
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

describe("stage, launchers, node pin, notice", () => {
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
    writeFileSync(join(repo, "apps/hub/src/main.test.ts"), "nope\n");
    writeFileSync(join(repo, "docs/notes.md"), "not in the archive\n");
    writeFileSync(join(nodeDir, "bin/node"), "#!/bin/sh\n", { mode: 0o755 });
    const outside = join(temp(), "outside");
    writeFileSync(outside, "nope\n");
    symlinkSync(outside, join(repo, "escape"));
    expect(() => stageRelease({ repo, nodeDir, dest: join(temp(), "out"), version: "0.1.0" })).toThrow(/symlink/i);
    rmSync(join(repo, "escape"));
    const destA = join(temp(), "a");
    const destB = join(temp(), "b");
    stageRelease({ repo, nodeDir, dest: destA, version: "0.1.0" });
    stageRelease({ repo, nodeDir, dest: destB, version: "0.1.0" });
    const files = (root: string) => FileListSchema.parse(JSON.parse(readFileSync(join(root, "files.json"), "utf8"))).map(e => e.path);
    expect(files(destA)).toEqual(files(destB));
    expect(files(destA).some(p => p.includes("docs/") || p.endsWith(".test.ts"))).toBe(false);
    expect(files(destA)).toContain("bin/morndo");
    expect(files(destA)).toContain("units");
    expect(files(destA)).toContain("trust");
    expect(files(destA)).toContain("LICENSES/LICENSE.md");
    expect(readFileSync(join(destA, "bin/morndo"), "utf8")).toBe(launcherSource(LAUNCHERS.morndo));
    const packedA = packTree(readStaged(destA), 1_700_000_000);
    const packedB = packTree(readStaged(destB), 1_700_000_000);
    expect(Buffer.from(packedA).equals(packedB)).toBe(true);
    const listed = spawnSync("tar", ["-tzf", "-"], { input: packedA, encoding: "utf8" });
    expect(listed.stdout).toContain("units/");
    expect(listed.stdout).toContain("trust/");
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
    stageRelease({ repo, nodeDir, dest, version: "0.1.0", compiled });
    expect(readlinkSync(join(dest, "node/bin/npm"))).toBe("../lib/npm-cli.js");
    expect(lstatSync(join(dest, "app/node_modules/@morndo/domain")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dest, "app/node_modules/@morndo/domain/src/index.js"), "utf8")).toBe("export const n = 1;\n");
    expect(readFileSync(join(dest, "app/node_modules/@morndo/domain/package.json"), "utf8")).toContain("./src/index.js");
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

  const fixture = (p: { tamper?: boolean; size?: number; archive?: Buffer }) => {
    const dir = temp();
    const key = join(dir, "release");
    expect(spawnSync("ssh-keygen", ["-t", "ed25519", "-f", key, "-N", "", "-C", "release-test", "-q"]).status).toBe(0);
    const pub = spawnSync("ssh-keygen", ["-y", "-f", key], { encoding: "utf8" });
    const signers = join(dir, "allowed");
    writeFileSync(signers, `${allowedSignerLine({ identity: RELEASE_NAMESPACE, namespace: RELEASE_NAMESPACE, publicKey: pub.stdout.trim() })}\n`);
    const marker = join(dir, "marker");
    const payload = new TextEncoder().encode(`#!/bin/sh\nprintf '%s\\n' "$*" > "${marker}"\n`);
    const archive = p.archive ?? packTree([{ path: "bin/morndo", bytes: payload, mode: "0555" }], 1_700_000_000);
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
    const script = stampVersion(readFileSync(join(import.meta.dirname, "../../install.sh"), "utf8"), "0.1.0");
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

function craftArchive(entryName: string): Buffer {
  const buf = Buffer.alloc(512);
  buf.write(entryName, 0);
  const oct = (at: number, width: number, value: number) => {
    buf.write(value.toString(8).padStart(width - 1, "0"), at, width - 1, "ascii");
  };
  oct(100, 8, 0o644);
  oct(108, 8, 0);
  oct(116, 8, 0);
  oct(124, 12, 0);
  oct(136, 12, 0);
  buf.fill(0x20, 148, 156);
  buf.write("0", 156, 1, "ascii");
  buf.write("ustar\0", 257, 6, "binary");
  buf.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  buf[154] = 0;
  buf[155] = 0x20;
  return gzipSync(Buffer.concat([buf, Buffer.alloc(1024)]));
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
