// A first install takes the tree exactly as the release packed it: install.sh unpacks the archive and runs its
// bin/morndo, whose `morndo install` checks that tree against its own files.json (verifyTreeAt) before copying it.
// These tests build a release tree the way the release does (stageRelease, then the pack step's own tree walk),
// run the real install.sh on it under umask 022 and 077, and judge the tree install.sh handed over with the
// updater's own verifyTreeAt. The bundled node is a stand-in that keeps a copy of that tree, so nothing runs but
// install.sh, the launcher and the stand-in. They also pin where install.sh unpacks (never a noexec /tmp) and that
// it cleans up a read-only tree and keeps its exit code.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DirsInstaller } from "../../apps/updater/src/adapters/installer-dirs.ts";
import { packTree } from "./archive.ts";
import { artifactName, buildManifest, declaredSchemas, protocolRange } from "./manifest.ts";
import { BUNDLED_NODE } from "./node-pin.ts";
import { RELEASE_NAMESPACE, signBytes } from "./sign.ts";
import { stagedTreeFiles, stageRelease } from "./stage.ts";
import { stampVersion } from "./stamp.ts";

const COMMIT = "cd".repeat(20);
const WHEN = Date.parse("2026-11-02T10:00:00Z");
const MTIME = 1_700_000_000;
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    spawnSync("chmod", ["-R", "u+w", r]);
    rmSync(r, { recursive: true, force: true });
  }
});
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), "morndo-install-tree-")); roots.push(d); return d; };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function hostPlatform(): "linux-x64" | "linux-arm64" | "darwin-arm64" {
  const os = spawnSync("uname", ["-s"], { encoding: "utf8" }).stdout.trim();
  const arch = spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout.trim();
  if (os === "Linux" && arch === "x86_64") return "linux-x64";
  if (os === "Linux" && arch === "aarch64") return "linux-arm64";
  if (os === "Darwin" && arch === "arm64") return "darwin-arm64";
  throw new Error(`unsupported test platform ${os} ${arch}`);
}

/** The modes `tar -tv` lists, by path (directories end in "/"). GNU tar and bsdtar both start a line with them. */
function listedModes(archive: Buffer): Map<string, string> {
  const dir = temp();
  writeFileSync(join(dir, "a.tar.gz"), archive);
  const r = spawnSync("tar", ["-tvzf", join(dir, "a.tar.gz")], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  const out = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    out.set(parts[parts.length - 1]!, parts[0]!);
  }
  return out;
}

/**
 * A repository the release would stage: one app with a `morndo` bin, a service template, a signed-looking Key set.
 * The bundled node is `node`: a shell script the launcher runs as `node app/... install --role R --channel C`.
 */
function stagedRelease(node: string): { dest: string } {
  const repo = temp();
  const nodeDir = temp();
  writeFileSync(join(repo, "package.json"), '{"name":"morndo","version":"0.1.2"}\n');
  writeFileSync(join(repo, "LICENSE.md"), "AGPL\n");
  mkdirSync(join(repo, "apps/updater/src"), { recursive: true });
  writeFileSync(join(repo, "apps/updater/package.json"), '{"name":"@morndo/updater","bin":{"morndo":"src/main.ts"}}\n');
  writeFileSync(join(repo, "apps/updater/src/main.ts"), "export {};\n");
  mkdirSync(join(repo, "apps/updater/units"), { recursive: true });
  writeFileSync(join(repo, "apps/updater/units/morndo-hub.service"), "[Unit]\nDescription=Morndo hub\n");
  mkdirSync(join(repo, "trust"), { recursive: true });
  writeFileSync(join(repo, "trust/keys.json"), '{"version":1}\n');
  writeFileSync(join(repo, "trust/keys.json.sig"), "-----BEGIN SSH SIGNATURE-----\nsig\n-----END SSH SIGNATURE-----\n");
  mkdirSync(join(nodeDir, "bin"), { recursive: true });
  writeFileSync(join(nodeDir, "bin/node"), node, { mode: 0o755 });
  const dest = join(temp(), "out");
  stageRelease({ repo, nodeDir, dest, version: "0.1.2", commit: COMMIT });
  return { dest };
}

/** A signed release of `archive` under a file:// base, and install.sh stamped for it. */
function published(archive: Buffer): { dir: string; base: string; script: string; signers: string } {
  const dir = temp();
  const key = join(dir, "release");
  expect(spawnSync("ssh-keygen", ["-t", "ed25519", "-f", key, "-N", "", "-C", "release-test", "-q"]).status).toBe(0);
  const pub = spawnSync("ssh-keygen", ["-y", "-f", key], { encoding: "utf8" }).stdout.trim();
  const signers = join(dir, "allowed");
  writeFileSync(signers, `${RELEASE_NAMESPACE} namespaces="${RELEASE_NAMESPACE}" ${pub}\n`);
  const host = hostPlatform();
  const name = artifactName("0.1.2", host);
  const manifest = buildManifest({
    version: "0.1.2", commit: COMMIT, publishedAt: WHEN, repository: "morndo/morndo",
    protocol: protocolRange(), schemas: declaredSchemas(),
    artifacts: [{ platform: host, name, size: archive.length, sha256: sha256(archive), filesSha256: "0".repeat(64), node: BUNDLED_NODE }],
  });
  const bytes = new TextEncoder().encode(manifest);
  const base = join(dir, "base");
  mkdirSync(base);
  writeFileSync(join(base, "manifest.json"), bytes);
  writeFileSync(join(base, "manifest.json.sig"), signBytes({ bytes, keyPath: key, namespace: RELEASE_NAMESPACE, dir }));
  writeFileSync(join(base, name), archive);
  const script = join(dir, "install.sh");
  writeFileSync(script, stampVersion(readFileSync(join(import.meta.dirname, "../../install.sh"), "utf8"), "0.1.2"), { mode: 0o755 });
  return { dir, base, script, signers };
}

/** The stand-in node: records where it ran and what it was asked, keeps a mode-preserving copy of its tree. */
function keepingNode(p: { marker: string; keep: string; then?: string }): string {
  return [
    "#!/bin/sh",
    "set -eu",
    'tree=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)',
    `printf '%s\\n%s\\n' "$0" "$*" > '${p.marker}'`,
    `cp -Rp "$tree" '${p.keep}'`,
    p.then ?? "exit 0",
    "",
  ].join("\n");
}

function install(p: { script: string; signers: string; base: string; home: string; tmp: string; umask: string }) {
  const r = spawnSync("sh", ["-c", `umask ${p.umask}; exec sh "$0" --role control-plane --signers "$1"`, p.script, p.signers], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: p.home, TMPDIR: p.tmp, MORNDO_RELEASE_BASE: `file://${p.base}` },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Everything install.sh left in the places it may unpack. */
function leftovers(home: string, tmp: string): string[] {
  const share = join(home, ".local/share");
  const inShare = existsSync(share) ? readdirSync(share).filter(n => n.includes("install")).map(n => join(share, n)) : [];
  return [...inShare, ...readdirSync(tmp).map(n => join(tmp, n))];
}

describe("the pack keeps the modes files.json names", () => {
  it("packTree stores a directory the tree lists with its own mode, and a parent it only implies as 0755", () => {
    const archive = packTree([
      { path: "trust", mode: "0555", directory: true },
      { path: "trust/keys.json", bytes: new TextEncoder().encode("{}\n"), mode: "0444" },
      { path: "app/VERSION", bytes: new TextEncoder().encode("0.1.2\n"), mode: "0444" },
    ], MTIME);
    const modes = listedModes(archive);
    expect(modes.get("trust/")).toBe("dr-xr-xr-x");
    expect(modes.get("trust/keys.json")).toBe("-r--r--r--");
    expect(modes.get("app/")).toBe("drwxr-xr-x");
  });

  it("the pack step's tree of a staged release lists trust and units as the directories files.json names", () => {
    const { dest } = stagedRelease("#!/bin/sh\nexit 0\n");
    const list = JSON.parse(readFileSync(join(dest, "files.json"), "utf8")) as { path: string; mode: string }[];
    expect(list.filter(e => e.path === "trust" || e.path === "units").map(e => e.mode)).toEqual(["0555", "0555"]);
    const tree = stagedTreeFiles(dest);
    for (const path of ["trust", "units"]) expect(tree).toContainEqual({ path, mode: "0555", directory: true });
    const modes = listedModes(packTree(tree, MTIME));
    expect(modes.get("trust/")).toBe("dr-xr-xr-x");
    expect(modes.get("units/")).toBe("dr-xr-xr-x");
    expect(modes.get("trust/keys.json")).toBe("-r--r--r--");
    expect(modes.get("bin/morndo")).toBe("-r-xr-xr-x");
  });
});

describe("install.sh hands `morndo install` the tree as packed", () => {
  it.each(["022", "077"])("under umask %s the tree passes verifyTreeAt, install.sh exits 0 and leaves nothing behind", async umask => {
    const work = temp();
    const home = join(work, "home");
    const tmp = join(work, "tmp");
    mkdirSync(home);
    mkdirSync(tmp);
    const marker = join(work, "marker");
    const keep = join(work, "kept");
    const { dest } = stagedRelease(keepingNode({ marker, keep }));
    const release = published(packTree(stagedTreeFiles(dest), MTIME));
    const r = install({ ...release, home, tmp, umask });
    expect(r.err).not.toMatch(/Permission denied|cannot remove/);
    expect(r.code).toBe(0);
    const [ranAs, args] = readFileSync(marker, "utf8").split("\n");
    expect(args).toMatch(/ install --role control-plane --channel stable$/);
    // never under TMPDIR: a noexec /tmp would refuse to run the archive's programs
    expect(ranAs!.startsWith(join(home, ".local/share") + "/")).toBe(true);
    expect(await new DirsInstaller({ releases: join(work, "releases") }).verifyTreeAt(keep, null)).toEqual([]);
    expect(leftovers(home, tmp)).toEqual([]);
  });

  it("cleans up a tree the install left read-only, and still exits 0", () => {
    const work = temp();
    const home = join(work, "home");
    const tmp = join(work, "tmp");
    mkdirSync(home);
    mkdirSync(tmp);
    const { dest } = stagedRelease(keepingNode({ marker: join(work, "marker"), keep: join(work, "kept"), then: 'chmod -R a-w "$tree"; exit 0' }));
    const release = published(packTree(stagedTreeFiles(dest), MTIME));
    const r = install({ ...release, home, tmp, umask: "022" });
    expect(r.err).not.toMatch(/Permission denied|cannot remove/);
    expect(r.code).toBe(0);
    expect(leftovers(home, tmp)).toEqual([]);
  });

  it("keeps a good install's exit code when its cleanup cannot remove the tree, and says so", () => {
    const work = temp();
    const home = join(work, "home");
    const tmp = join(work, "tmp");
    const bin = join(work, "bin");
    mkdirSync(home);
    mkdirSync(tmp);
    mkdirSync(bin);
    // an rm that removes nothing and fails, first on PATH: the cleanup's own failure must not become the exit code
    writeFileSync(join(bin, "rm"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const { dest } = stagedRelease(keepingNode({ marker: join(work, "marker"), keep: join(work, "kept") }));
    const release = published(packTree(stagedTreeFiles(dest), MTIME));
    const r = spawnSync("sh", ["-c", 'umask 022; exec sh "$0" --role control-plane --signers "$1"', release.script, release.signers], {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, TMPDIR: tmp, MORNDO_RELEASE_BASE: `file://${release.base}` },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/install\.sh: could not remove /);
  });

  it("exits with `morndo install`'s own code when it fails, and still cleans up", () => {
    const work = temp();
    const home = join(work, "home");
    const tmp = join(work, "tmp");
    mkdirSync(home);
    mkdirSync(tmp);
    const { dest } = stagedRelease(keepingNode({ marker: join(work, "marker"), keep: join(work, "kept"), then: "exit 65" }));
    const release = published(packTree(stagedTreeFiles(dest), MTIME));
    const r = install({ ...release, home, tmp, umask: "022" });
    expect(r.code).toBe(65);
    expect(leftovers(home, tmp)).toEqual([]);
  });

  it("falls back to TMPDIR only when it cannot write under ~/.local/share", () => {
    const work = temp();
    const home = join(work, "home");
    const tmp = join(work, "tmp");
    mkdirSync(home);
    mkdirSync(tmp);
    chmodSync(home, 0o555);
    const marker = join(work, "marker");
    const { dest } = stagedRelease(keepingNode({ marker, keep: join(work, "kept") }));
    const release = published(packTree(stagedTreeFiles(dest), MTIME));
    const r = install({ ...release, home, tmp, umask: "022" });
    expect(r.code).toBe(0);
    expect(readFileSync(marker, "utf8").split("\n")[0]!.startsWith(tmp + "/")).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
  });
});

describe("the README's install section", () => {
  it("says where install.sh unpacks, and names TMPDIR only as the fallback, which must not be noexec", () => {
    const readme = readFileSync(join(import.meta.dirname, "../../README.md"), "utf8");
    const install = readme.slice(readme.indexOf("## Install"));
    expect(install).toContain("unpacks the release under `~/.local/share`");
    expect(install).toMatch(/only when it cannot write there[^.]*`\$TMPDIR`[^.]*noexec/);
  });
});
