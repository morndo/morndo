// The release pipeline's shape (design §9, ADR-0019). These read the workflow files; they do not
// call GitHub. A private scratch repository still has to run the real tag once the owner adds keys.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { BUNDLED_NODE, NODE_RELEASE_KEYS_COMMIT } from "./node-pin.ts";
import { RELEASE_NAMESPACE } from "./sign.ts";

const RELEASE_PLEASE = "45996ed1f6d02564a971a2fa1b5860e934307cf7";
const APP_TOKEN = "64ab729a6294000f5aa4a4bc0b73d1f32bc45510"; //gitleaks:allow
const ATTEST = "1e69f48acb82d1966a394da916b4c1698aa569d6";
const DOWNLOAD_ARTIFACT = "37930b1c2abaa49bbe596cd826c3c89aef350131";
const UPLOAD_PAGES = "fc324d3547104276b827a68afc52ff2a11cc49c9";
const DEPLOY_PAGES = "368f82528645a54fb793d4d04e342629a3f51346";

const scratch: string[] = [];
afterEach(() => { for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true }); });

function job(yaml: string, name: string): string {
  const marker = `\n  ${name}:\n`;
  const start = yaml.indexOf(marker);
  if (start < 0) throw new Error(`missing job ${name}`);
  const from = start + marker.length;
  const next = yaml.slice(from).search(/\n  [A-Za-z0-9-]+:\n/);
  return yaml.slice(start, next < 0 ? undefined : from + next);
}

describe("release pipeline files", () => {
  const release = readFileSync(".github/workflows/release.yml", "utf8");
  const feed = readFileSync(".github/workflows/feed.yml", "utf8");
  const config = JSON.parse(readFileSync("release-please-config.json", "utf8")) as {
    packages: Record<string, Record<string, unknown>>;
  };

  it("lets Release Please cut one draft tag from the root package", () => {
    expect(Object.keys(config.packages)).toEqual(["."]);
    expect(config.packages["."]).toMatchObject({
      "release-type": "node",
      "bump-minor-pre-major": true,
      "draft": true,
      "force-tag-creation": true,
      "include-component-in-tag": false,
      "changelog-path": "CHANGELOG.md",
    });
    expect(config.packages["."]).not.toHaveProperty("bump-patch-for-minor-pre-major");
    // The first Release is 0.1.0 (design updates README, "Before 1.0"; ADR-0019 "0.x first"). Without this key Release
    // Please falls back to 1.0.0 when no tag exists yet, and a published release can never be withdrawn.
    expect(config.packages["."]).toHaveProperty("initial-version", "0.1.0");
    const prepare = job(release, "release-please");
    expect(prepare).toContain(`actions/create-github-app-token@${APP_TOKEN}`);
    expect(prepare).toContain("secrets.RELEASE_APP_ID");
    expect(prepare).toContain("secrets.RELEASE_APP_PRIVATE_KEY");
    expect(prepare).toContain("permission-contents: write");
    expect(prepare).toContain("permission-pull-requests: write");
    expect(prepare).toContain("steps.app.outputs.token");
    // The manifest names the root package's own version: Release Please bumps both together in its release PR, so the
    // test follows the package and pins neither.
    const root = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(JSON.parse(readFileSync(".release-please-manifest.json", "utf8"))).toEqual({ ".": root.version });
    expect(readFileSync("CHANGELOG.md", "utf8").startsWith("# Changelog\n")).toBe(true);
    expect(release).toContain(`googleapis/release-please-action@${RELEASE_PLEASE}`);
    expect(release).toContain("config-file: release-please-config.json");
    expect(release).toContain("manifest-file: .release-please-manifest.json");
    expect(release).not.toContain("pull_request_target");
  });

  it("builds the three platforms on the runners the design names", () => {
    const build = job(release, "build");
    expect(build).toContain("fail-fast: false");
    expect(build).toContain("timeout-minutes: 90");
    expect(build).toContain("platform: linux-x64");
    expect(build).toContain("runner: ubuntu-24.04");
    expect(build).toContain("platform: linux-arm64");
    expect(build).toContain("runner: ubuntu-24.04-arm");
    expect(build).toContain("platform: darwin-arm64");
    expect(build).toContain("runner: macos-15");
    expect(release).not.toContain("ubuntu-latest");
    expect(release).not.toContain("macos-latest");
    expect(build).toContain(BUNDLED_NODE);
    expect(build).toContain(NODE_RELEASE_KEYS_COMMIT);
    expect(build).toContain("verify-node.sh");
    expect(build).toContain("persist-credentials: false");
    expect(build).toContain("fetch-depth: 0");
    expect(build).toContain("npm ci");
    expect(build).toContain("npm run build");
    // The legs that make the shipped tarballs install no distribution packages and run no test suite: the units run in
    // their own job below, which holds no key and ships nothing (an unpinned apt install stays out of a shipping leg).
    // (The one package the Apple leg may install is GnuPG, which verifies the bundled Node, and only when it is missing.)
    const code = build.split("\n").filter(l => !l.trimStart().startsWith("#")).join("\n");   // a comment between jobs belongs to the slice before it
    expect(code).not.toContain("apt-get");
    expect(code).not.toMatch(/brew install (?!gnupg)/);
    expect(code).not.toContain("tmux");
    expect(code).not.toContain("ffmpeg");
    expect(code).not.toContain("vitest");
    // The Key set is checked before any repository program runs, and again on the copy that ships: a missing or wrong
    // signature, or a set older than the pinned minimum version, fails the build. The root signer and the minimum version
    // are pinned once, at the top of the workflow (the signers job reads them too), not read from the tree they check.
    expect(build).not.toContain("ROOT_ALLOWED_SIGNER:");
    expect(release).toMatch(/\nenv:\n(  .*\n)*  ROOT_ALLOWED_SIGNER: 'root@morndo\.github\.io namespaces="keys@morndo\.github\.io" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPjwqMc0uDQdQHelLxhebc5\/oO2hpmEzFNQQuXX0UBUC'/);
    expect(release).toMatch(/\n  KEY_SET_MIN_VERSION: "\d+"\n/);
    const checks = [...build.matchAll(/sh scripts\/release\/check-key-set\.sh "\$RUNNER_TEMP\/root_allowed_signers" (\S+) "\$KEY_SET_MIN_VERSION"/g)].map(m => m[1]);
    expect(checks).toEqual(["trust", '"$RUNNER_TEMP/stage/trust"']);
    expect(build.indexOf("check-key-set.sh")).toBeLessThan(build.indexOf("npm ci"));
    expect(build.lastIndexOf("check-key-set.sh")).toBeGreaterThan(build.indexOf("main.ts stage"));
    expect(build.lastIndexOf("check-key-set.sh")).toBeLessThan(build.indexOf("main.ts pack"));
    expect(build).toContain("npm prune --omit=dev");
    // T-355: the prune must not run a workspace's lifecycle scripts: apps/web's prepare is `svelte-kit sync`, and by then
    // svelte-kit is pruned (exit 127). No runtime dependency has an install script (ADR-0005).
    expect(build).toMatch(/npm prune --omit=dev --ignore-scripts\s*$/m);
    expect(build).toContain('"$RUNNER_TEMP"/stage/bin/*');
    expect(build).toContain("better-sqlite3");
    expect(build).toContain("contents: read");
  });

  it("runs the unit suite in a job of its own on the two Linux runners, with the tools it needs, before anything is assembled", () => {
    const units = job(release, "units");
    expect(units).toContain("runner: ubuntu-24.04\n");
    expect(units).toContain("runner: ubuntu-24.04-arm");
    expect(units).not.toContain("macos");
    expect(units).toContain("fail-fast: false");
    expect(units).toContain("contents: read");
    expect(units).toContain("persist-credentials: false");
    expect(units).toContain("fetch-depth: 0");   // the downgrade-contract tests read an earlier commit
    expect(units).toContain("ref: ${{ needs.release-please.outputs.sha }}");
    // The suite needs tmux and ffmpeg, as ci.yml installs them: the first bench run failed seven remux tests with
    // `spawnSync ffmpeg ENOENT` (ubuntu-24.04 ships no ffmpeg). It is a Linux suite (/proc, systemd, tmux, a directory
    // renamed at 0555): on macos-15 it had 179 failures, so it runs on the Linux runners only.
    expect(units).toContain("sudo apt-get install -y --no-install-recommends tmux ffmpeg");
    expect(units).toContain("node-version: ${{ env.BUNDLED_NODE }}");
    expect(units).toContain("npm ci");
    expect(units).toContain("npx vitest run --project=units");
    expect(units.indexOf("tmux ffmpeg")).toBeLessThan(units.indexOf("npx vitest run --project=units"));
    expect(units).not.toContain("secrets.");
    expect(units).not.toContain("environment:");
    expect(units).not.toContain("upload-artifact");
    // the release is not assembled, signed or published unless the units passed
    expect(job(release, "assemble")).toMatch(/needs: \[release-please, build, units\]/);
  });

  it("signs in its own release-environment job, then attests and publishes the draft without the key", () => {
    const assemble = job(release, "assemble");
    expect(assemble).not.toContain("environment:");
    expect(assemble).not.toContain("SSH_KEY");
    expect(assemble).toContain("npm ci");
    expect(assemble).toContain("name: unsigned");
    const sign = job(release, "sign");
    expect(sign).toContain("needs: [release-please, assemble]");
    expect(sign).toContain("environment: release");
    expect(sign).toContain("RELEASE_SSH_KEY");
    expect(sign).toContain("umask 077");
    expect(sign).toContain(RELEASE_NAMESPACE);
    expect(sign).toContain("check-signing-release.sh");
    expect(sign).toContain("name: signatures");
    expect(sign).not.toContain("npm ci");
    const publish = job(release, "publish");
    expect(publish).toContain("needs: [release-please, sign]");
    expect(publish).not.toContain("environment:");
    expect(publish).not.toContain("SSH_KEY");
    expect(publish).not.toContain("npm");
    expect(publish).toContain(`actions/attest@${ATTEST}`);
    expect(publish).toContain("id-token: write");
    expect(publish).toContain("attestations: write");
    expect(publish).toContain("contents: write");
    expect(publish).toContain(`actions/download-artifact@${DOWNLOAD_ARTIFACT}`);
    expect(publish).toContain("gh release upload");
    expect(publish).not.toContain("--draft=false");
    const ship = job(release, "ship");
    expect(ship).toContain("needs: [release-please, outside]");
    expect(ship).toContain("gh release edit");
    expect(ship).toContain("--draft=false");
    const signers = job(release, "signers");
    expect(signers).toContain("skipping release:");
    expect(signers).toContain("trust/release_allowed_signers");
    expect(signers).toContain("trust/feed_allowed_signers");
    expect(signers).not.toContain("release-please");
    expect(job(release, "build")).toContain("needs.signers.outputs.ready");
    expect(job(release, "build")).toContain("needs.release-please.outputs.release_created");
    expect(job(release, "release-please")).toContain("needs: signers");
    expect(job(release, "release-please")).toContain("needs.signers.outputs.ready");
    const prepare = job(release, "release-please");
    expect(prepare).toContain("contents: write");
    expect(prepare).toContain("pull-requests: write");
    expect(release).toMatch(/\npermissions:\n  contents: read\n/);
    expect(feed).toMatch(/\npermissions:\n  contents: read\n/);
  });

  it("the signers job checks the Key set's signature, so a bad set stops the run before Release Please makes the tag and the draft", () => {
    const doc = parse(release) as { env?: Record<string, string>; jobs: Record<string, { needs?: unknown; steps: { id?: string; run?: string }[] }> };
    expect(doc.env?.["ROOT_ALLOWED_SIGNER"]).toContain("ssh-ed25519");
    expect(doc.env?.["KEY_SET_MIN_VERSION"]).toMatch(/^\d+$/);
    expect(doc.jobs["release-please"]?.needs).toBe("signers");
    const script = doc.jobs["signers"]?.steps.find(step => step.id === "check")?.run ?? "";
    expect(script).toContain("check-key-set.sh");
    const run = (mutate: (tree: string, dir: string) => void, minVersion = "1") => {
      const dir = mkdtempSync(join(tmpdir(), "morndo-signers-"));
      scratch.push(dir);
      const tree = join(dir, "tree");
      mkdirSync(join(tree, "trust"), { recursive: true });
      mkdirSync(join(tree, "scripts", "release"), { recursive: true });
      writeFileSync(join(tree, "scripts", "release", "check-key-set.sh"), readFileSync("scripts/release/check-key-set.sh"));
      const keygen = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "root", "-f", join(dir, "root")], { encoding: "utf8" });
      expect(keygen.status, keygen.stderr).toBe(0);
      const signer = `root@morndo.github.io namespaces="keys@morndo.github.io" ${readFileSync(join(dir, "root.pub"), "utf8").split(" ").slice(0, 2).join(" ")}`;
      for (const name of ["release_allowed_signers", "feed_allowed_signers"]) writeFileSync(join(tree, "trust", name), "x\n");
      writeFileSync(join(tree, "trust", "keys.json"), '{\n  "schema": 1,\n  "version": 1,\n  "expiresAt": "2099-01-01T00:00:00Z"\n}\n');
      const signed = spawnSync("ssh-keygen", ["-q", "-Y", "sign", "-f", join(dir, "root"), "-n", "keys@morndo.github.io", join(tree, "trust", "keys.json")], { encoding: "utf8" });
      expect(signed.status, signed.stderr).toBe(0);
      mutate(tree, dir);
      const output = join(dir, "github-output");
      writeFileSync(output, "");
      const result = spawnSync("bash", ["-c", script], {
        cwd: tree, encoding: "utf8",
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ROOT_ALLOWED_SIGNER: signer, KEY_SET_MIN_VERSION: minVersion, RUNNER_TEMP: dir, GITHUB_OUTPUT: output },
      });
      return { status: result.status, output: readFileSync(output, "utf8"), stderr: result.stderr };
    };
    expect(run(() => {})).toMatchObject({ status: 0, output: "ready=true\n" });
    // Not in the tree yet: skipped cleanly, as before.
    expect(run(tree => rmSync(join(tree, "trust", "keys.json")))).toMatchObject({ status: 0, output: "ready=false\n" });
    // In the tree and wrong: the job fails, and never says ready, so no tag and no draft are made.
    for (const [name, mutate, min] of [
      ["a changed keys.json", (tree: string) => writeFileSync(join(tree, "trust", "keys.json"), "{}\n"), "1"],
      ["a missing signature", (tree: string) => rmSync(join(tree, "trust", "keys.json.sig")), "1"],
      ["an older set than the pinned minimum", () => {}, "2"],
    ] as const) {
      const r = run(mutate, min);
      expect(r.status, name).not.toBe(0);
      expect(r.output, name).not.toContain("ready=true");
    }
  });

  it("checks the release from a job that cannot see the signing secret", () => {
    const outside = job(release, "outside");
    expect(outside).not.toContain("environment:");
    expect(outside).not.toContain("RELEASE_SSH_KEY");
    expect(outside).not.toContain("FEED_SSH_KEY");
    // The release is still a draft here, and GitHub lists a draft only to a token with push access ("Only users with push
    // access will receive listings for draft releases", REST releases docs): with contents: read, `gh release download`
    // said "release not found" in the bench's run. The job holds no signing key and uploads nothing.
    expect(outside).toContain("contents: write");
    expect(outside).not.toContain("contents: read");
    expect(outside).toContain("attestations: read");
    expect(outside).not.toContain("gh release upload");
    expect(outside).not.toContain("gh release edit");
    expect(outside).toContain("trust/release_allowed_signers");
    expect(outside).toContain("ssh-keygen -Y verify");
    expect(outside).toContain("gh attestation verify");
    expect(readFileSync("scripts/release/published-gh.sh", "utf8")).toContain("verify-asset");
    expect(outside).toContain("signer-workflow");
    expect(outside).toContain(".github/workflows/release.yml@refs/heads/main");
    expect(outside).not.toContain("gh release verify");
    const published = job(release, "published");
    expect(published).toContain("needs: [release-please, ship]");
    expect(published).toContain("GH_REPO: ${{ github.repository }}");
    expect(published).toContain("published-gh.sh");
    expect(job(release, "ship")).toContain("GH_REPO: ${{ github.repository }}");
    const dir = mkdtempSync(join(tmpdir(), "morndo-gh-"));
    scratch.push(dir);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "log");
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s %s\\n' "$GH_REPO" "$*" >> "${log}"\nif [ "$1" = release ] && [ "$2" = download ]; then\n  mkdir -p "${dir}/assets"\n  : > "${dir}/assets/morndo-0.0.0-linux-x64.tar.gz"\n  : > "${dir}/assets/manifest.json"\n  : > "${dir}/assets/install.sh"\n  : > "${dir}/assets/SHA256SUMS"\nfi\nexit 0\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const dry = spawnSync("sh", ["scripts/release/published-gh.sh"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, GH_REPO: "morndo/morndo", TAG: "v0.0.0", RUNNER_TEMP: dir },
    });
    expect(dry.status, dry.stderr).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("morndo/morndo release verify v0.0.0");
    expect(calls).toContain("morndo/morndo release download v0.0.0");
    // Every downloaded asset is checked against the release's attestation, by tag.
    for (const name of ["morndo-0.0.0-linux-x64.tar.gz", "manifest.json", "install.sh", "SHA256SUMS"]) {
      expect(calls, name).toMatch(new RegExp(`morndo/morndo release verify-asset v0\\.0\\.0 .*/${name.replaceAll(".", "\\.")}\n`));
    }
    const summary = join(dir, "summary");
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s %s\\n' "$GH_REPO" "$*" >> "${log}"\nif [ "$1" = release ] && [ "$2" = verify ]; then exit 1; fi\nexit 0\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const failed = spawnSync("sh", ["scripts/release/published-gh.sh"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, GH_REPO: "morndo/morndo", TAG: "v0.0.0", RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary },
    });
    expect(failed.status).not.toBe(0);
    expect(readFileSync(summary, "utf8")).toMatch(/withdraw/i);
    // A digest that does not match the attestation fails the job and says how to withdraw.
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s %s\\n' "$GH_REPO" "$*" >> "${log}"\nif [ "$1" = release ] && [ "$2" = download ]; then\n  mkdir -p "${dir}/assets"\n  : > "${dir}/assets/manifest.json"\nfi\nif [ "$1" = release ] && [ "$2" = verify-asset ]; then echo "digest mismatch" >&2; exit 1; fi\nexit 0\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const summary2 = join(dir, "summary2");
    const mismatch = spawnSync("sh", ["scripts/release/published-gh.sh"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, GH_REPO: "morndo/morndo", TAG: "v0.0.0", RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary2 },
    });
    expect(mismatch.status).not.toBe(0);
    expect(readFileSync(summary2, "utf8")).toMatch(/withdraw/i);
    const missing = spawnSync("sh", ["scripts/release/published-gh.sh"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, TAG: "v0.0.0", RUNNER_TEMP: dir, GH_REPO: "" },
    });
    expect(missing.status).not.toBe(0);
    expect(job(release, "feed-prepare")).toContain("needs: [release-please, published]");
  });

  it("publishes the feed from the release and re-signs it weekly", () => {
    const first = job(release, "feed-prepare");
    expect(first).not.toContain("environment:");
    expect(first).not.toContain("SSH_KEY");
    expect(first).not.toContain(".github.io/");
    expect(first).toContain("feed-publish-prepare");
    expect(first).not.toMatch(/--key-set [0-9]/);
    expect(first).toContain("key-set --keys trust/keys.json");
    const second = job(release, "feed-sign");
    expect(second).toContain("environment: feed");
    expect(second).toContain("FEED_SSH_KEY");
    expect(second).toContain("MODE: publish");
    expect(second).toContain("check-signing-feed.sh");
    expect(second).toContain("pages: read");
    const third = job(release, "feed");
    expect(third).toContain("needs: [release-please, feed-sign]");
    expect(third).toContain("feed-commit");
    expect(third).toContain("contents: write");
    expect(third).not.toContain("SSH_KEY");
    expect(job(feed, "resign")).not.toContain(".github.io/");
    expect(job(feed, "resign")).not.toContain("?ref=feed");
    expect(job(feed, "resign-prepare")).toContain("feed-resign-prepare");
    expect(third).toContain("trust/feed_allowed_signers");
    const sync = readFileSync("scripts/release/feed-sync.ts", "utf8");
    expect(sync).toContain("publishRelease");
    expect(sync).toContain("emptyFeed");
    expect(sync).toContain("resignFeed");
    expect(readFileSync("scripts/release/feed-site.ts", "utf8")).toContain("ssh-keygen");
    const pages = job(release, "pages");
    expect(pages).toContain(`actions/upload-pages-artifact@${UPLOAD_PAGES}`);
    expect(pages).toContain("scripts/release/feed-site.ts");
    expect(pages).not.toContain("npm ci");
    expect(pages).toContain("trust/feed_allowed_signers");
    expect(pages).toContain("environment:");
    expect(pages).toContain("name: github-pages");
    expect(pages).toContain(`actions/deploy-pages@${DEPLOY_PAGES}`);
    expect(pages).toContain("pages: write");
    expect(pages).toContain("id-token: write");

    expect(feed).toContain("group: morndo-feed");
    expect(feed).toContain("cancel-in-progress: false");
    expect(feed).not.toContain("morndo-release");
    expect(job(feed, "resign-prepare")).toContain("skipping re-sign:");
    expect(job(release, "feed")).toContain("group: morndo-release-feed");
    expect(job(release, "pages")).toContain("group: morndo-pages");
    expect(job(feed, "pages")).toContain("group: morndo-pages");
    expect(job(feed, "pages")).toContain("scripts/release/feed-site.ts");
    expect(job(feed, "pages")).not.toContain("npm ci");
    expect(job(feed, "pages")).toContain("trust/feed_allowed_signers");
    expect(feed).not.toContain("morndo-release-feed");
    expect(feed).toContain('cron: "17 6 * * 1"');
    expect(feed).toContain("workflow_dispatch");
    const resign = job(feed, "resign");
    expect(resign).not.toContain("SSH_KEY");
    expect(resign).toContain("feed-commit");
    expect(job(feed, "resign-prepare")).toContain("feed-resign-prepare");
    expect(job(feed, "resign-prepare")).not.toContain("SSH_KEY");
    expect(job(feed, "resign-sign")).toContain("environment: feed");
    expect(job(feed, "resign-sign")).toContain("FEED_SSH_KEY");
    expect(job(feed, "resign-sign")).toContain("MODE: resign");
    expect(resign).not.toContain("git/blobs");
    expect(resign).toContain("trust/feed_allowed_signers");
    expect(job(feed, "node-pin")).toContain("node-check");
    expect(feed).toContain("https://nodejs.org/dist/index.json");
    expect(job(feed, "pages")).toContain(`actions/deploy-pages@${DEPLOY_PAGES}`);
    expect(feed).not.toContain("pull_request_target");
  });

  it("gates the scheduled node-pin check on the repository variable the owner sets with the release setup", () => {
    const jobs = (parse(feed) as { jobs: Record<string, { needs?: unknown; if?: string }> }).jobs;
    expect(jobs["node-pin"]?.if).toBe("vars.MORNDO_RELEASES_ENABLED == 'true'");
    // A job without `needs` starts on every scheduled run. Only resign-prepare may do so without the variable,
    // because it ends cleanly while trust/feed_allowed_signers is not in the tree; the rest wait on it.
    const unguarded = Object.entries(jobs).filter(([, j]) => !j.needs && !j.if).map(([name]) => name);
    expect(unguarded).toEqual(["resign-prepare"]);
    expect(job(feed, "resign-prepare")).toContain("skipping re-sign:");
  });
});

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> };
type Workflow = { jobs: Record<string, { steps: Step[] }> };

const NPM_CODE = /\b(node|npm|npx|tsx|pnpm|yarn)\b|scripts\/release\/main\.ts/;

// A signing key lives in a job of its own. That job runs no npm and no node (no setup-node, no npm ci, no
// script of the repo's), so nothing a package left on the machine is there; the key is in one step, written
// to a mktemp file under umask 077, and every tool is named by its path, with PATH fixed in that step.
export function keyViolations(text: string, jobs: Record<string, string>): string[] {
  const workflow = parse(text) as Workflow;
  const found: string[] = [];
  for (const [name, secret] of Object.entries(jobs)) {
    const job = workflow.jobs[name];
    if (!job) { found.push(`${name}: no such job`); continue; }
    const steps = job.steps;
    for (const step of steps) {
      const run = (step.run ?? "").replace(/#.*$/gm, "");
      if (step.uses?.startsWith("actions/setup-node")) found.push(`${name}: ${step.uses} in a signing job`);
      if (NPM_CODE.test(run)) found.push(`${name}: a step runs npm code`);
      if (/GITHUB_ENV|GITHUB_PATH/.test(run)) found.push(`${name}: a step writes GITHUB_ENV or GITHUB_PATH`);
    }
    const keyed = steps.filter(step => JSON.stringify(step).includes(secret));
    if (keyed.length !== 1) found.push(`${name}: ${keyed.length} steps hold ${secret}`);
    for (const step of keyed) {
      if (step.uses) found.push(`${name}: ${step.uses} holds ${secret}`);
      const run = (step.run ?? "").replace(/#.*$/gm, "");
      if (!run.includes("/usr/bin/ssh-keygen -Y sign")) found.push(`${name}: the step with ${secret} does not sign by path`);
      if (/(^|[^/\w-])ssh-keygen\b/.test(run.replace(/\/usr\/bin\/ssh-keygen/g, ""))) found.push(`${name}: the step with ${secret} relies on PATH`);
      if (!/^\s*PATH=\/usr\/bin:\/bin\s*$/m.test(run)) found.push(`${name}: the step with ${secret} does not fix PATH`);
      if (!/\/usr\/bin\/mktemp/.test(run) || /\.key\b/.test(run)) found.push(`${name}: the step with ${secret} has a fixed key path`);
      if (!/umask 077/.test(run)) found.push(`${name}: the step with ${secret} has no umask 077`);
      if (Object.keys(step.env ?? {}).some(key => !key.endsWith("SSH_KEY"))) found.push(`${name}: the step with ${secret} has other env`);
    }
  }
  for (const secret of new Set(Object.values(jobs))) {
    const holders = Object.entries(workflow.jobs).filter(([, job]) => JSON.stringify(job).includes(secret)).map(([key]) => key);
    const allowed = Object.entries(jobs).filter(([, value]) => value === secret).map(([key]) => key);
    if (holders.join() !== allowed.join()) found.push(`${secret} is in ${holders.join(", ")}, not only ${allowed.join(", ")}`);
  }
  return found;
}

describe("withdraw.yml", () => {
  const text = () => readFileSync(".github/workflows/withdraw.yml", "utf8");
  const feed = () => readFileSync(".github/workflows/feed.yml", "utf8");
  type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string> };
  type Job = {
    if?: string; needs?: unknown; environment?: unknown; permissions?: Record<string, string>;
    concurrency?: { group?: string; "cancel-in-progress"?: boolean }; steps?: Step[];
  };
  type Doc = {
    name?: string;
    on?: { workflow_dispatch?: { inputs?: Record<string, { description?: string; required?: boolean; default?: boolean; type?: string }> } };
    permissions?: { contents?: string };
    concurrency?: { group?: string; "cancel-in-progress"?: boolean };
    jobs: Record<string, Job>;
  };
  const doc = () => parse(text()) as Doc;

  it("withdraw.yml is manual only, with one required version input", () => {
    const parsed = doc();
    expect(parsed.name).toBe("Withdraw");
    expect(Object.keys(parsed.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(text()).not.toMatch(/^on:\n(?:  .*\n)*  schedule:/m);
    expect(text()).not.toMatch(/^on:\n(?:  .*\n)*  push:/m);
    const inputs = parsed.on?.workflow_dispatch?.inputs ?? {};
    expect(Object.keys(inputs)).toEqual(["version", "allow_empty_channel"]);
    expect(inputs["version"]).toMatchObject({ required: true, type: "string" });
    expect(inputs["version"]?.description).toEqual(expect.any(String));
    expect(inputs["version"]?.description).not.toBe("");
    expect(inputs["allow_empty_channel"]).toEqual({
      description: "Allow withdrawing the last Version a channel offers (the channel then offers nothing)",
      required: false,
      default: false,
      type: "boolean",
    });
  });

  it("every withdraw job runs only on main", () => {
    const jobs = doc().jobs;
    expect(Object.keys(jobs)).toEqual(["withdraw-prepare", "withdraw-sign", "withdraw", "pages"]);
    for (const [name, job] of Object.entries(jobs)) {
      expect(job.if, name).toContain("github.ref == 'refs/heads/main'");
    }
  });

  it("withdraw holds the feed key only in its sign job, behind the feed environment, and the preparation behind the withdraw environment", () => {
    const jobs = doc().jobs;
    expect(jobs["withdraw-prepare"]?.environment).toBe("withdraw");
    expect(jobs["withdraw-sign"]?.environment).toBe("feed");
    expect(jobs["withdraw"]?.environment).toBeUndefined();
    expect(jobs["pages"]?.environment).toMatchObject({ name: "github-pages" });
    expect(keyViolations(text(), { "withdraw-sign": "FEED_SSH_KEY" })).toEqual([]);
    expect(job(text(), "withdraw-prepare")).not.toContain("FEED_SSH_KEY");
    expect(job(text(), "withdraw-prepare")).not.toContain("SSH_KEY");
    expect(job(text(), "withdraw-sign")).toContain("FEED_SSH_KEY");
    expect(job(text(), "withdraw-sign")).not.toContain("npm ci");
    expect(job(text(), "withdraw-prepare")).toContain("feed-withdraw-prepare");
    expect(job(text(), "withdraw-prepare")).toContain("trust/feed_allowed_signers");
    expect(job(text(), "withdraw-prepare")).not.toContain("status=absent");
  });

  it("withdraw writes contents in its commit job only, and pages permissions in its pages job only", () => {
    const parsed = doc();
    expect(parsed.permissions).toEqual({ contents: "read" });
    expect(parsed.jobs["withdraw"]?.permissions).toEqual({ contents: "write" });
    expect(parsed.jobs["pages"]?.permissions).toEqual({ contents: "read", pages: "write", "id-token": "write" });
    expect(parsed.jobs["withdraw-prepare"]?.permissions).toEqual({ contents: "read" });
    expect(parsed.jobs["withdraw-sign"]?.permissions).toEqual({ contents: "read" });
    const writers = Object.entries(parsed.jobs).filter(([, job]) => job.permissions?.["contents"] === "write").map(([name]) => name);
    expect(writers).toEqual(["withdraw"]);
    const pages = Object.entries(parsed.jobs).filter(([, job]) => job.permissions?.["pages"] === "write" || job.permissions?.["id-token"] === "write").map(([name]) => name);
    expect(pages).toEqual(["pages"]);
  });

  it("withdraw never writes the version input inside a run script", () => {
    const parsed = doc();
    const lines = text().split("\n").filter(line => line.includes("inputs."));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^\s+\w+:\s+\$\{\{\s*inputs\.[A-Za-z0-9_]+\s*\}\}\s*$/);
    const envHits: string[] = [];
    for (const job of Object.values(parsed.jobs)) {
      for (const step of job.steps ?? []) {
        expect(step.run ?? "").not.toContain("inputs.");
        for (const value of Object.values(step.env ?? {})) if (value.includes("inputs.")) envHits.push(value);
      }
    }
    expect(envHits).toHaveLength(lines.length);
  });

  it("withdraw passes the empty-channel decision to the preparation and to the check", () => {
    const parsed = doc();
    const prepare = parsed.jobs["withdraw-prepare"]?.steps?.find(step => (step.run ?? "").includes("feed-withdraw-prepare"));
    expect(prepare?.env?.["ALLOW_EMPTY"]).toBe("${{ inputs.allow_empty_channel }}");
    expect(prepare?.run).toContain('--allow-empty-channel "$ALLOW_EMPTY"');
    const check = parsed.jobs["withdraw-sign"]?.steps?.find(step => (step.run ?? "").includes("check-signing-feed.sh"));
    expect(check?.env?.["ALLOW_EMPTY_CHANNEL"]).toBe("${{ inputs.allow_empty_channel }}");
    expect(check?.run ?? "").not.toContain("allow_empty_channel");
  });

  it("every action in withdraw.yml is pinned by commit and is one feed.yml already uses", () => {
    const feedUses = new Set([...feed().matchAll(/uses: (\S+)/g)].map(match => match[1]));
    const used = [...text().matchAll(/uses: (\S+)/g)].map(match => match[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const uses of used) {
      expect(uses).toMatch(/@[0-9a-f]{40}$/);
      expect(feedUses.has(uses)).toBe(true);
    }
  });

  it("withdraw takes the feed concurrency group only in the job that writes the feed, and never cancels", () => {
    const parsed = doc();
    expect(parsed.concurrency).toBeUndefined();
    expect(text()).not.toMatch(/^concurrency:/m);
    expect(Object.entries(parsed.jobs).map(([name, job]) => [name, job.concurrency])).toEqual([
      ["withdraw-prepare", undefined],
      ["withdraw-sign", undefined],
      ["withdraw", { group: "morndo-feed", "cancel-in-progress": false }],
      ["pages", { group: "morndo-pages", "cancel-in-progress": false }],
    ]);
    expect(text()).not.toContain("cancel-in-progress: true");
  });

  it("the sign job checks what it signs before the key step", () => {
    const sign = job(text(), "withdraw-sign");
    expect(sign).toContain("MODE: withdraw");
    expect(sign).toContain("/bin/sh scripts/release/check-signing-feed.sh");
    expect(sign.indexOf("check-signing-feed.sh")).toBeLessThan(sign.indexOf("secrets.FEED_SSH_KEY"));
    expect(sign.indexOf("Check what will be signed")).toBeLessThan(sign.indexOf("Sign the feeds"));
  });

  it("no other workflow names the withdraw environment", () => {
    const files = readdirSync(".github/workflows").filter(name => name.endsWith(".yml") && name !== "withdraw.yml");
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const body = readFileSync(join(".github/workflows", name), "utf8");
      expect(body, name).not.toMatch(/environment:\s*withdraw\b/);
      expect(body, name).not.toMatch(/name:\s*withdraw\b/);
    }
  });
});

describe("the Node pin is written three times and must agree", () => {
  it("node-pin.ts, the build job and the signing check name one version", () => {
    const release = readFileSync(".github/workflows/release.yml", "utf8");
    const pins = (text: string) => [...text.matchAll(/BUNDLED_NODE: "([0-9.]+)"/g)].map(m => m[1]);
    expect(pins(job(release, "build"))).toEqual([BUNDLED_NODE]);
    expect(pins(job(release, "sign"))).toEqual([BUNDLED_NODE]);
  });
});

describe("artifacts are downloaded by exact name", () => {
  const release = readFileSync(".github/workflows/release.yml", "utf8");
  const names = ["release-linux-x64", "release-linux-arm64", "release-darwin-arm64"];

  it.each(["assemble", "sign", "publish"])("%s takes the three build artifacts by name, and no pattern", name => {
    const text = job(release, name);
    expect(text).not.toMatch(/pattern:/);
    expect(text).not.toContain("merge-multiple");
    for (const artifact of names) expect(text).toContain(`name: ${artifact}\n`);
  });

  it("the build matrix uploads under exactly those names", () => {
    expect(job(release, "build")).toContain("name: release-${{ matrix.platform }}");
    expect([...job(release, "build").matchAll(/platform: ([a-z0-9-]+)/g)].map(m => `release-${m[1]}`)).toEqual(names);
  });
});

describe("signing keys reach one shell-only step", () => {
  const release = readFileSync(".github/workflows/release.yml", "utf8");
  const feed = readFileSync(".github/workflows/feed.yml", "utf8");

  it("each key is in a signing job of its own that runs no npm code", () => {
    expect(keyViolations(release, { sign: "RELEASE_SSH_KEY", "feed-sign": "FEED_SSH_KEY" })).toEqual([]);
    expect(keyViolations(feed, { "resign-sign": "FEED_SSH_KEY" })).toEqual([]);
  });

  it("control: npm in the job, a fixed key path, a bare tool name, or a second holder is named", () => {
    const bad = [
      "jobs:",
      "  sign:",
      "    steps:",
      "      - uses: actions/setup-node@x",
      "      - run: npm ci",
      "      - env:",
      "          RELEASE_SSH_KEY: ${{ secrets.RELEASE_SSH_KEY }}",
      "        run: |",
      "          key=$RUNNER_TEMP/release.key",
      "          ssh-keygen -Y sign -f $key x",
      "          echo x >> $GITHUB_PATH",
      "  other:",
      "    steps:",
      "      - env:",
      "          RELEASE_SSH_KEY: ${{ secrets.RELEASE_SSH_KEY }}",
      "        run: echo",
    ].join("\n");
    expect(keyViolations(bad, { sign: "RELEASE_SSH_KEY" })).toEqual([
      "sign: actions/setup-node@x in a signing job",
      "sign: a step runs npm code",
      "sign: a step writes GITHUB_ENV or GITHUB_PATH",
      "sign: the step with RELEASE_SSH_KEY does not sign by path",
      "sign: the step with RELEASE_SSH_KEY relies on PATH",
      "sign: the step with RELEASE_SSH_KEY does not fix PATH",
      "sign: the step with RELEASE_SSH_KEY has a fixed key path",
      "sign: the step with RELEASE_SSH_KEY has no umask 077",
      "RELEASE_SSH_KEY is in sign, other, not only sign",
    ]);
  });
});
