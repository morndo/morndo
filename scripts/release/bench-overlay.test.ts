// The release bench is a local tree: git archive of a commit, plus a known overlay. bench-overlay.sh builds it
// and audits it. It never pushes. Throwaway keys are generated at run time; nothing here is a real key.
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./bench-overlay.sh", import.meta.url));
const VERSION = "1.2.3";
const PROMOTION_FROM = "export const PROMOTION_WAIT_MS = 7 * 24 * 60 * 60 * 1000;";
const PROMOTION_TO = "export const PROMOTION_WAIT_MS = 20 * 60 * 1000;";
const AGE_FROM = "PROMOTE_MIN_AGE=${PROMOTE_MIN_AGE:-604800}";
const AGE_TO = "PROMOTE_MIN_AGE=${PROMOTE_MIN_AGE:-1200}";
const TRUST_FILES = ["keys.json", "keys.json.sig", "release_allowed_signers", "feed_allowed_signers"] as const;
const REMOVED = [
  "scripts/release/workflow.test.ts",
  "scripts/release/signing.test.ts",
  "scripts/release/release.test.ts",
  "apps/hub/test/val-b12-e2e-listed.test.ts",
  "plugins/transcribe-whisper-cpp/test/install.test.ts",
  "apps/updater/test/docs.test.ts",
];

const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
delete env.GIT_DIR;
delete env.GIT_WORK_TREE;

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8", env });
const tmp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

type Pub = { type: string; body: string; fp: string; priv: string };
type Keys = { root: Pub; other: Pub; release: Pub; feed: Pub };
type Trust = { trust: string; signer: string; line: string };
type Fx = { dir: string; repo: string; sha: string; keys: Keys; trust: Trust };

let cached: Fx | undefined;
afterAll(() => { if (cached) rmSync(cached.dir, { recursive: true, force: true }); });

function genKey(dir: string, name: string): Pub {
  const priv = join(dir, name);
  const made = sh("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", priv]);
  expect(made.status, made.stderr).toBe(0);
  const parts = readFileSync(`${priv}.pub`, "utf8").trim().split(" ");
  const type = parts[0];
  const body = parts[1];
  if (type === undefined || body === undefined) throw new Error("public key");
  expect(type).toBe("ssh-ed25519");
  const listed = sh("ssh-keygen", ["-lf", `${priv}.pub`]);
  expect(listed.status, listed.stderr).toBe(0);
  const fp = listed.stdout.trim().split(/\s+/)[1];
  if (fp === undefined || !fp.startsWith("SHA256:")) throw new Error("fingerprint");
  return { type, body, fp, priv };
}

function keysJson(p: { expiresAt: string; root: string; release: string; feed: string }): string {
  return `{
  "schema": 1,
  "version": 1,
  "expiresAt": "${p.expiresAt}",
  "root": ["${p.root}"],
  "release": ["${p.release}"],
  "feed": ["${p.feed}"]
}
`;
}

function expiresAhead(): string {
  const when = new Date();
  when.setUTCFullYear(when.getUTCFullYear() + 1);
  return when.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function makeTrust(parent: string, keys: Keys, opts: { expiresAt: string; signPriv: string; signer: Pub }): Trust {
  const trust = join(parent, "trust");
  mkdirSync(trust, { recursive: true });
  const keysPath = join(trust, "keys.json");
  writeFileSync(keysPath, keysJson({
    expiresAt: opts.expiresAt, root: keys.root.fp, release: keys.release.fp, feed: keys.feed.fp,
  }));
  const signed = sh("ssh-keygen", ["-q", "-Y", "sign", "-f", opts.signPriv, "-n", "keys@morndo.github.io", keysPath]);
  expect(signed.status, signed.stderr).toBe(0);
  const releaseLine = `release@morndo.github.io namespaces="release@morndo.github.io" ${keys.release.type} ${keys.release.body}\n`;
  const feedLine = `feed@morndo.github.io namespaces="feed@morndo.github.io" ${keys.feed.type} ${keys.feed.body}\n`;
  writeFileSync(join(trust, "release_allowed_signers"), releaseLine);
  writeFileSync(join(trust, "feed_allowed_signers"), feedLine);
  const line = `root@morndo.github.io namespaces="keys@morndo.github.io" ${opts.signer.type} ${opts.signer.body}`;
  const signer = join(parent, "root_allowed_signers");
  writeFileSync(signer, `${line}\n`);
  return { trust, signer, line };
}

function commit(repo: string): string {
  const add = sh("git", ["-C", repo, "add", "-A"]);
  expect(add.status, add.stderr).toBe(0);
  const made = sh("git", [
    "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "-m", "fixture",
  ]);
  expect(made.status, made.stderr + made.stdout).toBe(0);
  const rev = sh("git", ["-C", repo, "rev-parse", "HEAD"]);
  expect(rev.status, rev.stderr).toBe(0);
  return rev.stdout.trim();
}

function seed(repo: string, alter?: (repo: string) => void): string {
  mkdirSync(repo, { recursive: true });
  const init = sh("git", ["init", "-b", "main", repo]);
  expect(init.status, init.stderr).toBe(0);
  mkdirSync(join(repo, ".github/workflows"), { recursive: true });
  mkdirSync(join(repo, "scripts/release"), { recursive: true });
  mkdirSync(join(repo, "apps/updater/test"), { recursive: true });
  mkdirSync(join(repo, "apps/x/src"), { recursive: true });
  cpSync("trust", join(repo, "trust"), { recursive: true });
  copyFileSync(".github/workflows/release.yml", join(repo, ".github/workflows/release.yml"));
  copyFileSync("scripts/release/check-key-set.sh", join(repo, "scripts/release/check-key-set.sh"));
  for (const name of ["feed", "withdraw", "promote", "ci", "secrets"]) {
    writeFileSync(join(repo, ".github/workflows", `${name}.yml`), `name: ${name}\non: push\njobs: {}\n`);
  }
  writeFileSync(join(repo, "scripts/release/feed.ts"), `${PROMOTION_FROM}\nexport const MARKER = 1;\n`);
  writeFileSync(join(repo, "scripts/release/check-signing-feed.sh"), `${AGE_FROM}\necho kept\n`);
  writeFileSync(join(repo, "scripts/release/workflow.test.ts"), "workflow\n");
  writeFileSync(join(repo, "scripts/release/signing.test.ts"), "signing\n");
  writeFileSync(join(repo, "scripts/release/release.test.ts"), "release\n");
  writeFileSync(join(repo, "apps/updater/test/docs.test.ts"), "docs\n");
  writeFileSync(join(repo, "README.md"), "readme\n");
  writeFileSync(join(repo, "apps/x/src/main.ts"), "export const main = 1;\n");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs/note.md"), "A note that mentions a PRIVATE KEY only as prose.\n");
  alter?.(repo);
  return commit(repo);
}

function fx(): Fx {
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), "morndo-bench-"));
  const keyDir = join(dir, "keys");
  mkdirSync(keyDir);
  const keys = {
    root: genKey(keyDir, "root"),
    other: genKey(keyDir, "other"),
    release: genKey(keyDir, "release"),
    feed: genKey(keyDir, "feed"),
  };
  const trust = makeTrust(join(dir, "bench"), keys, { expiresAt: expiresAhead(), signPriv: keys.root.priv, signer: keys.root });
  const repo = join(dir, "repo");
  const sha = seed(repo);
  cached = { dir, repo, sha, keys, trust };
  return cached;
}

function overlay(p: { repo: string; sha: string; trust: string; signer: string; out: string; version?: string }) {
  return sh("sh", [
    SCRIPT, p.sha, "--version", p.version ?? VERSION, "--trust", p.trust, "--root-signer", p.signer,
    "--out", p.out, "--repo", p.repo,
  ]);
}

function audit(repo: string, sha: string, out: string) {
  return sh("sh", [SCRIPT, "--audit", sha, out, "--repo", repo]);
}

function walk(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const rec = (abs: string, rel: string) => {
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      if (rel === "" && ent.name === ".git") continue;
      const path = rel === "" ? ent.name : `${rel}/${ent.name}`;
      const child = join(abs, ent.name);
      if (ent.isDirectory()) rec(child, path);
      else out.set(path, readFileSync(child));
    }
  };
  rec(dir, "");
  return out;
}

function classify(src: Map<string, Buffer>, dst: Map<string, Buffer>) {
  const changed: string[] = [];
  const removed: string[] = [];
  const added: string[] = [];
  for (const [path, bytes] of src) {
    const other = dst.get(path);
    if (other === undefined) removed.push(path);
    else if (!other.equals(bytes)) changed.push(path);
  }
  for (const path of dst.keys()) if (!src.has(path)) added.push(path);
  changed.sort();
  removed.sort();
  added.sort();
  return { changed, removed, added };
}

function job(yaml: string, name: string): string {
  const marker = `\n  ${name}:\n`;
  const start = yaml.indexOf(marker);
  if (start < 0) throw new Error(`missing job ${name}`);
  const from = start + marker.length;
  const next = yaml.slice(from).search(/\n  [A-Za-z0-9-]+:\n/);
  return yaml.slice(start, next < 0 ? undefined : from + next);
}

function outputNames(yaml: string): string[] {
  const body = job(yaml, "release-please");
  const outStart = body.indexOf("\n    outputs:\n");
  const steps = body.indexOf("\n    steps:\n");
  if (outStart < 0 || steps < outStart) throw new Error("job has no outputs");
  const names: string[] = [];
  for (const line of body.slice(outStart, steps).split("\n")) {
    const name = /^ {6}([A-Za-z0-9_]+):/.exec(line)?.[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

function withoutBlock(yaml: string, block: string): string {
  const at = yaml.indexOf(block);
  expect(at, "overlay block missing").toBeGreaterThanOrEqual(0);
  return (yaml.slice(0, at) + yaml.slice(at + block.length)).replace(/\n  ROOT_ALLOWED_SIGNER: [^\n]*\n/, "\n");
}

// The job runs from its first line through the newline that precedes `  build:`.
function sourceJob(yaml: string): string {
  const start = yaml.indexOf("  release-please:\n");
  const build = yaml.indexOf("\n  build:\n");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(build).toBeGreaterThan(start);
  return yaml.slice(start, build + 1);
}

function refuse(result: { status: number | null; stdout: string; stderr: string }, pattern: RegExp) {
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout + result.stderr).toMatch(/^bench-overlay: /m);
  expect(result.stdout + result.stderr).toMatch(pattern);
}

describe("bench-overlay.sh", () => {
  it("changes exactly the files of the overlay table and nothing else", () => {
    const f = fx();
    const out = join(tmp("morndo-out-"), "out");
    const run = overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer: f.trust.signer, out });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const diff = classify(walk(f.repo), walk(out));
    expect(diff.changed).toEqual([
      ".github/workflows/release.yml",
      "scripts/release/check-signing-feed.sh",
      "scripts/release/feed.ts",
      "trust/feed_allowed_signers",
      "trust/keys.json",
      "trust/keys.json.sig",
      "trust/release_allowed_signers",
    ]);
    expect(diff.removed).toEqual([
      ".github/workflows/ci.yml",
      ".github/workflows/secrets.yml",
      "apps/updater/test/docs.test.ts",
      "scripts/release/release.test.ts",
      "scripts/release/signing.test.ts",
      "scripts/release/workflow.test.ts",
    ]);
    expect(diff.added).toEqual(["BENCH.md"]);
    const src = walk(f.repo);
    const dst = walk(out);
    for (const path of ["README.md", "apps/x/src/main.ts", "trust/README.md", ".github/workflows/feed.yml", ".github/workflows/withdraw.yml", ".github/workflows/promote.yml"]) {
      const before = src.get(path);
      const after = dst.get(path);
      expect(before, path).toBeDefined();
      expect(after, path).toBeDefined();
      expect(after!.equals(before!)).toBe(true);
    }
  });

  it("release.yml keeps every job but release-please byte for byte", () => {
    const f = fx();
    const out = join(tmp("morndo-out-"), "out");
    const run = overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer: f.trust.signer, out });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const src = readFileSync(join(f.repo, ".github/workflows/release.yml"), "utf8");
    const dst = readFileSync(join(out, ".github/workflows/release.yml"), "utf8");
    const standin = readFileSync("scripts/release/bench-overlay/release-please-standin.yml", "utf8").split("__VERSION__").join(VERSION);
    const standinBlock = standin.endsWith("\n") ? standin : `${standin}\n`;
    expect(withoutBlock(dst, standinBlock)).toBe(withoutBlock(src, sourceJob(src)));
    expect(dst).toContain(standinBlock);
    expect(dst).toContain(`  ROOT_ALLOWED_SIGNER: '${f.trust.line}' #gitleaks:allow`);
    expect(job(dst, "release-please")).not.toContain("release-please-action");
  });

  it("the stand-in gives the four outputs the real job gives", () => {
    const f = fx();
    const out = join(tmp("morndo-out-"), "out");
    const run = overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer: f.trust.signer, out });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const src = readFileSync(join(f.repo, ".github/workflows/release.yml"), "utf8");
    const dst = readFileSync(join(out, ".github/workflows/release.yml"), "utf8");
    expect(outputNames(dst)).toEqual(outputNames(src));
    expect(outputNames(dst)).toEqual(["release_created", "tag_name", "sha", "version"]);
  });

  it("the promotion wait is 20 minutes in both places and nothing else in those two files changes", () => {
    const f = fx();
    const out = join(tmp("morndo-out-"), "out");
    const run = overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer: f.trust.signer, out });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const feedSrc = readFileSync(join(f.repo, "scripts/release/feed.ts"), "utf8");
    const feedDst = readFileSync(join(out, "scripts/release/feed.ts"), "utf8");
    expect(feedSrc.replace(PROMOTION_FROM, PROMOTION_TO)).toBe(feedDst);
    expect(feedDst).toContain(PROMOTION_TO);
    const ageSrc = readFileSync(join(f.repo, "scripts/release/check-signing-feed.sh"), "utf8");
    const ageDst = readFileSync(join(out, "scripts/release/check-signing-feed.sh"), "utf8");
    expect(ageSrc.replace(AGE_FROM, AGE_TO)).toBe(ageDst);
    expect(ageDst).toContain(AGE_TO);
  });

  it("the removed-tests list is the six files the overlay table names", () => {
    const text = readFileSync("scripts/release/bench-overlay/removed-tests.txt", "utf8");
    expect(text.replace(/\n$/, "").split("\n")).toEqual(REMOVED);
  });

  it("a listed test that the source does not have is skipped, and a test that is not listed is kept", () => {
    const f = fx();
    const dir = tmp("morndo-keep-");
    const repo = join(dir, "repo");
    const sha = seed(repo, (r) => writeFileSync(join(r, "scripts/release/kept.test.ts"), "kept\n"));
    const out = join(dir, "out");
    const run = overlay({ repo, sha, trust: f.trust.trust, signer: f.trust.signer, out });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(readFileSync(join(out, "scripts/release/kept.test.ts"), "utf8")).toBe("kept\n");
    expect(() => readFileSync(join(out, "scripts/release/workflow.test.ts"))).toThrow();
    expect(() => readFileSync(join(out, "apps/hub/test/val-b12-e2e-listed.test.ts"))).toThrow();
    expect(() => readFileSync(join(out, "plugins/transcribe-whisper-cpp/test/install.test.ts"))).toThrow();
  });

  it("refuses trust files identical to the source's, a missing file, or an extra file", () => {
    const f = fx();
    const out = join(tmp("morndo-out-"), "out");
    const sameDir = tmp("morndo-same-");
    const same = join(sameDir, "trust");
    mkdirSync(same);
    for (const name of TRUST_FILES) copyFileSync(join(f.repo, "trust", name), join(same, name));
    refuse(overlay({ repo: f.repo, sha: f.sha, trust: same, signer: f.trust.signer, out }), /identical/);

    const missingDir = tmp("morndo-miss-");
    cpSync(f.trust.trust, join(missingDir, "trust"), { recursive: true });
    rmSync(join(missingDir, "trust", "keys.json"));
    refuse(
      overlay({ repo: f.repo, sha: f.sha, trust: join(missingDir, "trust"), signer: f.trust.signer, out: join(tmp("morndo-out-"), "out") }),
      /keys\.json/,
    );

    const extraDir = tmp("morndo-extra-");
    cpSync(f.trust.trust, join(extraDir, "trust"), { recursive: true });
    writeFileSync(join(extraDir, "trust", "extra.txt"), "extra\n");
    refuse(
      overlay({ repo: f.repo, sha: f.sha, trust: join(extraDir, "trust"), signer: f.trust.signer, out: join(tmp("morndo-out-"), "out") }),
      /extra\.txt/,
    );
  });

  it("refuses private key material in the trust directory or in the root signer file", () => {
    const f = fx();
    const priv = readFileSync(f.keys.release.priv, "utf8");
    const trustDir = tmp("morndo-priv-");
    cpSync(f.trust.trust, join(trustDir, "trust"), { recursive: true });
    appendFileSync(join(trustDir, "trust", "release_allowed_signers"), priv);
    refuse(
      overlay({ repo: f.repo, sha: f.sha, trust: join(trustDir, "trust"), signer: f.trust.signer, out: join(tmp("morndo-out-"), "out") }),
      /private key material in release_allowed_signers/,
    );
    const signerDir = tmp("morndo-privsigner-");
    const signer = join(signerDir, "root_allowed_signers");
    writeFileSync(signer, `${readFileSync(f.trust.signer, "utf8")}${priv}`);
    refuse(
      overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer, out: join(tmp("morndo-out-"), "out") }),
      /private key material in root_allowed_signers/,
    );
  });

  it("refuses the source's own root signer", () => {
    const f = fx();
    const release = readFileSync(join(f.repo, ".github/workflows/release.yml"), "utf8");
    const own = /^  ROOT_ALLOWED_SIGNER: '([^']+)' #gitleaks:allow$/m.exec(release)?.[1];
    if (own === undefined) throw new Error("fixture has no root signer line");
    const dir = tmp("morndo-own-");
    const signer = join(dir, "root_allowed_signers");
    writeFileSync(signer, `${own}\n`);
    const out = join(dir, "out");
    refuse(overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer, out }), /source's own/);
  });

  it("refuses a trust set not signed by the given root", () => {
    const f = fx();
    const dir = tmp("morndo-wrong-");
    const trust = makeTrust(dir, f.keys, { expiresAt: expiresAhead(), signPriv: f.keys.root.priv, signer: f.keys.other });
    const out = join(dir, "out");
    refuse(overlay({ repo: f.repo, sha: f.sha, trust: trust.trust, signer: trust.signer, out }), /does not verify/);
  });

  it("refuses an expired trust set", () => {
    const f = fx();
    const dir = tmp("morndo-old-");
    const trust = makeTrust(dir, f.keys, { expiresAt: "2020-01-01T00:00:00Z", signPriv: f.keys.root.priv, signer: f.keys.root });
    const out = join(dir, "out");
    refuse(overlay({ repo: f.repo, sha: f.sha, trust: trust.trust, signer: trust.signer, out }), /expired/);
  });

  it("refuses a version that is not x.y.z", () => {
    const f = fx();
    for (const version of ["1.2", "v1.2.3", "1.2.3-rc1", "1.2.3.4", "01.2", ""]) {
      const out = join(tmp("morndo-out-"), "out");
      refuse(
        overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer: f.trust.signer, out, version }),
        /version/,
      );
    }
  });

  it("refuses a source without withdraw.yml or promote.yml", () => {
    const f = fx();
    for (const name of ["withdraw.yml", "promote.yml", "feed.yml"]) {
      const dir = tmp("morndo-wf-");
      const repo = join(dir, "repo");
      const sha = seed(repo, (r) => rmSync(join(r, ".github/workflows", name)));
      const out = join(dir, "out");
      refuse(overlay({ repo, sha, trust: f.trust.trust, signer: f.trust.signer, out }), new RegExp(name.replace(".", "\\.")));
    }
  });

  it("refuses a source without the promotion constants", () => {
    const f = fx();
    const noWait = tmp("morndo-wait-");
    const waitRepo = join(noWait, "repo");
    const waitSha = seed(waitRepo, (r) => writeFileSync(join(r, "scripts/release/feed.ts"), "export const MARKER = 1;\n"));
    refuse(
      overlay({ repo: waitRepo, sha: waitSha, trust: f.trust.trust, signer: f.trust.signer, out: join(noWait, "out") }),
      /feed\.ts/,
    );
    const noAge = tmp("morndo-age-");
    const ageRepo = join(noAge, "repo");
    const ageSha = seed(ageRepo, (r) => writeFileSync(join(r, "scripts/release/check-signing-feed.sh"), "echo kept\n"));
    refuse(
      overlay({ repo: ageRepo, sha: ageSha, trust: f.trust.trust, signer: f.trust.signer, out: join(noAge, "out") }),
      /check-signing-feed\.sh/,
    );
  });

  it("refuses a release.yml whose release-please job or root signer line it cannot find exactly once", () => {
    const f = fx();
    const noJob = tmp("morndo-job-");
    const jobRepo = join(noJob, "repo");
    const jobSha = seed(jobRepo, (r) => {
      const path = join(r, ".github/workflows/release.yml");
      writeFileSync(path, readFileSync(path, "utf8").replace("\n  release-please:\n", "\n  release-please-gone:\n"));
    });
    refuse(
      overlay({ repo: jobRepo, sha: jobSha, trust: f.trust.trust, signer: f.trust.signer, out: join(noJob, "out") }),
      /release-please/,
    );
    const two = tmp("morndo-two-");
    const twoRepo = join(two, "repo");
    const twoSha = seed(twoRepo, (r) => {
      const path = join(r, ".github/workflows/release.yml");
      const text = readFileSync(path, "utf8");
      const at = text.indexOf("\n  ROOT_ALLOWED_SIGNER: ");
      expect(at).toBeGreaterThan(0);
      const end = text.indexOf("\n", at + 1);
      writeFileSync(path, text.slice(0, end + 1) + text.slice(at + 1));
    });
    refuse(
      overlay({ repo: twoRepo, sha: twoSha, trust: f.trust.trust, signer: f.trust.signer, out: join(two, "out") }),
      /ROOT_ALLOWED_SIGNER/,
    );
  });

  it("refuses an --out that is not empty, or lies inside the source repository", () => {
    const f = fx();
    const full = tmp("morndo-full-");
    const out = join(full, "out");
    mkdirSync(out);
    writeFileSync(join(out, "already"), "x\n");
    refuse(overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer: f.trust.signer, out }), /empty/);
    const inside = join(f.repo, "inside-out");
    refuse(overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer: f.trust.signer, out: inside }), /inside/);
  });

  it("refuses a commit that does not resolve", () => {
    const f = fx();
    const out = join(tmp("morndo-out-"), "out");
    refuse(
      overlay({ repo: f.repo, sha: "0000000000000000000000000000000000000000", trust: f.trust.trust, signer: f.trust.signer, out }),
      /does not resolve/,
    );
  });

  it("prints the changed files, then the diff of the workflow and release-script files, then ok", () => {
    const f = fx();
    const out = join(tmp("morndo-out-"), "out");
    const run = overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer: f.trust.signer, out });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const lines = run.stdout.trimEnd().split("\n");
    const last = lines[lines.length - 1];
    expect(last).toBe(`bench-overlay: ok ${out}`);
    const body = lines.slice(0, -1);
    const diffAt = body.findIndex((line) => line.startsWith("--- "));
    expect(diffAt).toBeGreaterThan(0);
    const list = body.slice(0, diffAt);
    const diff = body.slice(diffAt).join("\n");
    expect(list.every((line) => /^(added|changed|removed) \S+$/.test(line))).toBe(true);
    const tree = classify(walk(f.repo), walk(out));
    const expectList = [
      ...tree.added.map((path) => `added ${path}`),
      ...tree.changed.map((path) => `changed ${path}`),
      ...tree.removed.map((path) => `removed ${path}`),
    ].sort();
    expect(list).toEqual(expectList);
    expect(diff).toMatch(/^--- .*\.github\/workflows\/release\.yml/m);
    expect(diff).toMatch(/^--- .*scripts\/release\/feed\.ts/m);
    expect(diff).toMatch(/^--- .*scripts\/release\/check-signing-feed\.sh/m);
    expect(diff).not.toMatch(/^bench-overlay: ok /m);
  });

  it("the audit passes the built tree and fails one that differs outside the table", () => {
    const f = fx();
    const out = join(tmp("morndo-out-"), "out");
    const built = overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer: f.trust.signer, out });
    expect(built.status, built.stdout + built.stderr).toBe(0);
    const ok = audit(f.repo, f.sha, out);
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);

    const readme = join(out, "README.md");
    const readmeBytes = readFileSync(readme);
    writeFileSync(readme, Buffer.concat([readmeBytes, Buffer.from("x\n")]));
    const changed = audit(f.repo, f.sha, out);
    expect(changed.status).toBe(1);
    expect(changed.stdout + changed.stderr).toContain("README.md");
    writeFileSync(readme, readmeBytes);

    const main = join(out, "apps/x/src/main.ts");
    const mainBytes = readFileSync(main);
    rmSync(main);
    const deleted = audit(f.repo, f.sha, out);
    expect(deleted.status).toBe(1);
    expect(deleted.stdout + deleted.stderr).toContain("apps/x/src/main.ts");
    mkdirSync(join(out, "apps/x/src"), { recursive: true });
    writeFileSync(main, mainBytes);

    writeFileSync(join(out, "stray.txt"), "nope\n");
    const stray = audit(f.repo, f.sha, out);
    expect(stray.status).toBe(1);
    expect(stray.stdout + stray.stderr).toContain("stray.txt");
  });

  it("the audit fails a release.yml with a line appended after the stand-in and the signer line", () => {
    const f = fx();
    const out = join(tmp("morndo-out-"), "out");
    const built = overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer: f.trust.signer, out });
    expect(built.status, built.stdout + built.stderr).toBe(0);
    const yml = join(out, ".github/workflows/release.yml");
    appendFileSync(yml, "  extra-job:\n");
    const result = audit(f.repo, f.sha, out);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(".github/workflows/release.yml");
    expect(result.stderr).toContain("  extra-job:");
  });

  it("the audit fails a changed line inside another job of release.yml", () => {
    const f = fx();
    const out = join(tmp("morndo-out-"), "out");
    const built = overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer: f.trust.signer, out });
    expect(built.status, built.stdout + built.stderr).toBe(0);
    const yml = join(out, ".github/workflows/release.yml");
    const text = readFileSync(yml, "utf8");
    const next = text.replace("    timeout-minutes: 90\n", "    timeout-minutes: 91\n");
    expect(next).not.toBe(text);
    writeFileSync(yml, next);
    const result = audit(f.repo, f.sha, out);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(".github/workflows/release.yml");
    expect(result.stderr).toContain("timeout-minutes: 91");
  });

  it("the audit fails an edit inside the stand-in block", () => {
    const f = fx();
    const out = join(tmp("morndo-out-"), "out");
    const built = overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer: f.trust.signer, out });
    expect(built.status, built.stdout + built.stderr).toBe(0);
    const yml = join(out, ".github/workflows/release.yml");
    const text = readFileSync(yml, "utf8");
    const next = text.replace("(bench)", "(altered)");
    expect(next).not.toBe(text);
    writeFileSync(yml, next);
    const result = audit(f.repo, f.sha, out);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(".github/workflows/release.yml");
    expect(result.stderr).toContain("(altered)");
  });

  it("the audit fails a root signer line that is the source's own or not the pinned form", () => {
    const f = fx();
    const out = join(tmp("morndo-out-"), "out");
    const built = overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer: f.trust.signer, out });
    expect(built.status, built.stdout + built.stderr).toBe(0);
    const yml = join(out, ".github/workflows/release.yml");
    const text = readFileSync(yml, "utf8");
    const src = readFileSync(join(f.repo, ".github/workflows/release.yml"), "utf8");
    const srcLine = src.split("\n").find((line) => line.startsWith("  ROOT_ALLOWED_SIGNER: "));
    const dstLine = text.split("\n").find((line) => line.startsWith("  ROOT_ALLOWED_SIGNER: "));
    if (srcLine === undefined || dstLine === undefined) throw new Error("fixture has no root signer line");
    expect(dstLine).not.toBe(srcLine);

    writeFileSync(yml, text.replace(dstLine, srcLine));
    const own = audit(f.repo, f.sha, out);
    expect(own.status, own.stdout + own.stderr).toBe(1);
    expect(own.stderr).toContain(".github/workflows/release.yml");
    expect(own.stderr).toContain(srcLine);

    const malformed = "  ROOT_ALLOWED_SIGNER: 'nope'";
    writeFileSync(yml, text.replace(dstLine, malformed));
    const bad = audit(f.repo, f.sha, out);
    expect(bad.status, bad.stdout + bad.stderr).toBe(1);
    expect(bad.stderr).toContain(".github/workflows/release.yml");
    expect(bad.stderr).toContain(malformed);
  });

  it("the audit fails a feed.ts or check-signing-feed.sh edited outside the promotion wait line", () => {
    const f = fx();
    const out = join(tmp("morndo-out-"), "out");
    const built = overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer: f.trust.signer, out });
    expect(built.status, built.stdout + built.stderr).toBe(0);
    const feed = join(out, "scripts/release/feed.ts");
    const feedBytes = readFileSync(feed);
    appendFileSync(feed, "export const EXTRA = 1;\n");
    const feedAudit = audit(f.repo, f.sha, out);
    expect(feedAudit.status, feedAudit.stdout + feedAudit.stderr).toBe(1);
    expect(feedAudit.stderr).toContain("scripts/release/feed.ts");
    expect(feedAudit.stderr).toContain("export const EXTRA = 1;");
    writeFileSync(feed, feedBytes);

    const age = join(out, "scripts/release/check-signing-feed.sh");
    const ageBytes = readFileSync(age);
    appendFileSync(age, "echo extra\n");
    const ageAudit = audit(f.repo, f.sha, out);
    expect(ageAudit.status, ageAudit.stdout + ageAudit.stderr).toBe(1);
    expect(ageAudit.stderr).toContain("scripts/release/check-signing-feed.sh");
    expect(ageAudit.stderr).toContain("echo extra");
    writeFileSync(age, ageBytes);

    const feedText = feedBytes.toString("utf8").replace(PROMOTION_TO, "export const PROMOTION_WAIT_MS = 1;");
    expect(feedText).not.toBe(feedBytes.toString("utf8"));
    writeFileSync(feed, feedText);
    const feedWait = audit(f.repo, f.sha, out);
    expect(feedWait.status, feedWait.stdout + feedWait.stderr).toBe(1);
    expect(feedWait.stderr).toContain("scripts/release/feed.ts");
    expect(feedWait.stderr).toContain("PROMOTION_WAIT_MS = 1;");
    writeFileSync(feed, feedBytes);

    const ageText = ageBytes.toString("utf8").replace(AGE_TO, "PROMOTE_MIN_AGE=${PROMOTE_MIN_AGE:-1}");
    expect(ageText).not.toBe(ageBytes.toString("utf8"));
    writeFileSync(age, ageText);
    const ageWait = audit(f.repo, f.sha, out);
    expect(ageWait.status, ageWait.stdout + ageWait.stderr).toBe(1);
    expect(ageWait.stderr).toContain("scripts/release/check-signing-feed.sh");
    expect(ageWait.stderr).toContain("PROMOTE_MIN_AGE:-1");
  });

  it("the audit fails when a trust file is still the source's", () => {
    const f = fx();
    const out = join(tmp("morndo-out-"), "out");
    const built = overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer: f.trust.signer, out });
    expect(built.status, built.stdout + built.stderr).toBe(0);
    for (const name of TRUST_FILES) {
      const dest = join(out, "trust", name);
      const builtBytes = readFileSync(dest);
      copyFileSync(join(f.repo, "trust", name), dest);
      const result = audit(f.repo, f.sha, out);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(`trust/${name} is still the source's`);
      writeFileSync(dest, builtBytes);
    }
  });

  it("the audit refuses private key text added to any file, but not the source's own mentions", () => {
    const f = fx();
    const out = join(tmp("morndo-out-"), "out");
    const built = overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer: f.trust.signer, out });
    expect(built.status, built.stdout + built.stderr).toBe(0);
    const ok = audit(f.repo, f.sha, out);
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);

    const shaped = `${readFileSync(f.keys.release.priv, "utf8").split("\n")[0]}\n`;
    const note = join(out, "docs/note.md");
    const noteBytes = readFileSync(note);
    appendFileSync(note, shaped);
    const extra = audit(f.repo, f.sha, out);
    expect(extra.status, extra.stdout + extra.stderr).toBe(1);
    expect(extra.stdout + extra.stderr).toContain("private key material in docs/note.md");
    writeFileSync(note, noteBytes);

    const addedPath = join(out, "extra-key.txt");
    writeFileSync(addedPath, shaped);
    const added = audit(f.repo, f.sha, out);
    expect(added.status, added.stdout + added.stderr).toBe(1);
    expect(added.stdout + added.stderr).toContain("extra-key.txt");
    expect(added.stdout + added.stderr).toContain("private key material in extra-key.txt");
    rmSync(addedPath);

    const keysPath = join(out, "trust/keys.json");
    const keysBytes = readFileSync(keysPath);
    appendFileSync(keysPath, shaped);
    const trust = audit(f.repo, f.sha, out);
    expect(trust.status, trust.stdout + trust.stderr).toBe(1);
    expect(trust.stdout + trust.stderr).toContain("private key material in trust/keys.json");
    writeFileSync(keysPath, keysBytes);
  });

  it("the audit passes trees built with different versions", () => {
    const f = fx();
    for (const version of ["0.1.2", "10.20.30"]) {
      const out = join(tmp("morndo-out-"), "out");
      const built = overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer: f.trust.signer, out, version });
      expect(built.status, built.stdout + built.stderr).toBe(0);
      expect(readFileSync(join(out, ".github/workflows/release.yml"), "utf8")).toContain(`version=${version}`);
      const ok = audit(f.repo, f.sha, out);
      expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    }
  });

  it("the script never pushes and never reaches a network", () => {
    const text = readFileSync(SCRIPT, "utf8");
    expect(text).not.toContain("git push");
    expect(text).not.toContain("gh ");
    expect(text).not.toContain("curl");
    expect(text).not.toContain("wget");
  });

  it("a second run on the same inputs gives a byte-identical tree and the same BENCH.md", () => {
    const f = fx();
    const out1 = join(tmp("morndo-out-"), "out");
    const out2 = join(tmp("morndo-out-"), "out");
    const first = overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer: f.trust.signer, out: out1 });
    const second = overlay({ repo: f.repo, sha: f.sha, trust: f.trust.trust, signer: f.trust.signer, out: out2 });
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    const a = walk(out1);
    const b = walk(out2);
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    for (const path of a.keys()) expect(b.get(path)?.equals(a.get(path)!)).toBe(true);
    const bench = a.get("BENCH.md")?.toString("utf8") ?? "";
    expect(bench).toBe(b.get("BENCH.md")?.toString("utf8"));
    expect(bench).toContain(f.sha);
    expect(f.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(bench).toContain(VERSION);
    expect(bench).toMatch(/test bench/);
    expect(bench).toMatch(/not a product/);
    expect(bench).toMatch(/14-day/);
    expect(bench).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(bench).not.toContain("/");
    expect(bench).not.toContain("github");
  });
});
