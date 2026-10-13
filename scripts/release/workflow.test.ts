// The release pipeline's shape (design §9, ADR-0019). These read the workflow files; they do not
// call GitHub. A private scratch repository still has to run the real tag once the owner adds keys.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUNDLED_NODE, NODE_RELEASE_KEYS_COMMIT } from "./node-pin.ts";
import { FEED_NAMESPACE, RELEASE_NAMESPACE } from "./sign.ts";

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
    expect(build).toContain("better-sqlite3");
    expect(build).toContain("contents: read");
  });

  it("signs in the release environment, attests, then publishes the draft", () => {
    const publish = job(release, "publish");
    expect(publish).toContain("environment: release");
    expect(publish).toContain("RELEASE_SSH_KEY");
    expect(publish).toContain("umask 077");
    expect(publish).toContain(RELEASE_NAMESPACE);
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
    expect(outside).toContain("signer-workflow");
    expect(outside).toContain(".github/workflows/release.yml@refs/heads/main");
    expect(outside).not.toContain("gh release verify");
    const published = job(release, "published");
    expect(published).toContain("needs: [release-please, ship]");
    expect(published).toContain("gh release verify-asset");
    expect(published).toContain("gh release verify");
    expect(job(release, "feed")).toContain("needs: [release-please, published]");
  });

  it("publishes the feed from the release and re-signs it weekly", () => {
    const first = job(release, "feed");
    expect(first).toContain("environment: feed");
    expect(first).toContain("FEED_SSH_KEY");
    expect(first).not.toContain(".github.io/");
    expect(first).toContain("feed-publish");
    expect(first).toContain("contents: write");
    expect(job(feed, "resign")).not.toContain(".github.io/");
    expect(job(feed, "resign")).not.toContain("?ref=feed");
    expect(job(feed, "resign")).toContain("feed-resign-branch");
    expect(first).toContain("trust/feed_allowed_signers");
    const sync = readFileSync("scripts/release/feed-sync.ts", "utf8");
    expect(sync).toContain("publishRelease");
    expect(sync).toContain("emptyFeed");
    expect(sync).toContain("resignFeed");
    expect(sync).toContain("ssh-keygen");
    expect(first).toContain(`actions/upload-pages-artifact@${UPLOAD_PAGES}`);
    const pages = job(release, "pages");
    expect(pages).toContain("environment:");
    expect(pages).toContain("name: github-pages");
    expect(pages).toContain(`actions/deploy-pages@${DEPLOY_PAGES}`);
    expect(pages).toContain("pages: write");
    expect(pages).toContain("id-token: write");

    expect(feed).toContain("group: morndo-feed");
    expect(feed).toContain("cancel-in-progress: false");
    expect(feed).not.toContain("morndo-release");
    expect(job(feed, "resign")).toContain("skipping re-sign:");
    expect(job(release, "feed")).toContain("group: morndo-release-feed");
    expect(job(release, "pages")).toContain("group: morndo-release-feed");
    expect(feed).not.toContain("morndo-release-feed");
    expect(feed).toContain('cron: "17 6 * * 1"');
    expect(feed).toContain("workflow_dispatch");
    const resign = job(feed, "resign");
    expect(resign).toContain("environment: feed");
    expect(resign).toContain("FEED_SSH_KEY");
    expect(resign).toContain("feed-resign-branch");
    expect(resign).not.toContain("git/blobs");
    expect(resign).toContain("trust/feed_allowed_signers");
    expect(job(feed, "node-pin")).toContain("node-check");
    expect(feed).toContain("https://nodejs.org/dist/index.json");
    expect(job(feed, "pages")).toContain(`actions/deploy-pages@${DEPLOY_PAGES}`);
    expect(feed).not.toContain("pull_request_target");
  });
});
