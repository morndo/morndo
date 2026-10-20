// The release pipeline's shape (design §9, ADR-0019). These read the workflow files; they do not
// call GitHub. A private scratch repository still has to run the real tag once the owner adds keys.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { BUNDLED_NODE, NODE_RELEASE_KEYS_COMMIT } from "./node-pin.ts";
import { RELEASE_NAMESPACE } from "./sign.ts";

const RELEASE_PLEASE = "45996ed1f6d02564a971a2fa1b5860e934307cf7";
const APP_TOKEN = "64ab729a6294000f5aa4a4bc0b73d1f32bc45510"; //gitleaks:allow
const ATTEST = "1e69f48acb82d1966a394da916b4c1698aa569d6";
const DOWNLOAD_ARTIFACT = "37930b1c2abaa49bbe596cd826c3c89aef350131";
const UPLOAD_PAGES = "fc324d3547104276b827a68afc52ff2a11cc49c9";
const DEPLOY_PAGES = "368f82528645a54fb793d4d04e342629a3f51346";

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
    const prepare = job(release, "release-please");
    expect(prepare).toContain(`actions/create-github-app-token@${APP_TOKEN}`);
    expect(prepare).toContain("secrets.RELEASE_APP_ID");
    expect(prepare).toContain("secrets.RELEASE_APP_PRIVATE_KEY");
    expect(prepare).toContain("permission-contents: write");
    expect(prepare).toContain("permission-pull-requests: write");
    expect(prepare).toContain("steps.app.outputs.token");
    expect(JSON.parse(readFileSync(".release-please-manifest.json", "utf8"))).toEqual({ ".": "0.0.0" });
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
    expect(build).toContain("npx vitest run --project=units");
    expect(build).toContain("npm run build");
    expect(build).toContain("npm prune --omit=dev");
    expect(build).toContain('"$RUNNER_TEMP"/stage/bin/*');
    expect(build).toContain("better-sqlite3");
    expect(build).toContain("contents: read");
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

  it("checks the release from a job that cannot see the signing secret", () => {
    const outside = job(release, "outside");
    expect(outside).not.toContain("environment:");
    expect(outside).not.toContain("RELEASE_SSH_KEY");
    expect(outside).not.toContain("FEED_SSH_KEY");
    expect(outside).toContain("contents: read");
    expect(outside).toContain("attestations: read");
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
    expect([...release.matchAll(/platform: ([a-z0-9-]+)/g)].map(m => `release-${m[1]}`)).toEqual(names);
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
