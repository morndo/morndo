// scripts/release/check-release-settings.sh proves, read-only, the GitHub settings a release depends on: the
// environments and their reviewers, the main-only branch rules, the tag ruleset on v* and where each key lives (names
// only, never a value). These tests run it against a fake gh whose every answer is a JSON fixture shaped as the GitHub
// API answered it on 2026-10-23, break one setting at a time and expect a FAIL line naming it — or, when two are
// broken, both lines at once: the check reports every problem, not only the first.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./check-release-settings.sh", import.meta.url));
const REPO = "acme/widgets";
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

// The fake gh the check finds first on PATH: `api <endpoint>` (any --paginate is ignored) answers with
// $FAKE_GH_DIR/<endpoint with every / mapped to __>.json, and a missing fixture is a 404, as a token without the
// scope would see it. /usr/bin:/bin stays behind the fake, so the check still finds the real jq.
const FAKE_GH = [
  "#!/bin/sh",
  "set -eu",
  '[ "${1:-}" = api ] || { echo "gh: unexpected command: $*" >&2; exit 1; }',
  "shift",
  "endpoint=",
  'for arg in "$@"; do',
  '  case $arg in -*) continue ;; esac',
  "  endpoint=$arg",
  "  break",
  "done",
  '[ -n "$endpoint" ] || { echo "gh: no endpoint" >&2; exit 1; }',
  'file="$FAKE_GH_DIR/$(printf \'%s\' "$endpoint" | sed \'s|/|__|g\').json"',
  'if [ -f "$file" ]; then cat "$file"; else echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi',
  "",
].join("\n");

const REVIEWER = { type: "User", reviewer: { login: "reviewer-account", id: 1 } };
const reviewed = (name: string) => ({
  name,
  protection_rules: [
    { type: "required_reviewers", prevent_self_review: true, reviewers: [REVIEWER] },
    { type: "branch_policy" },
  ],
  deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
});
// github-pages serves documents the clients verify, so it needs no reviewer; it still allows main only.
const PAGES = { name: "github-pages", protection_rules: [{ type: "branch_policy" }], deployment_branch_policy: { custom_branch_policies: true, protected_branches: false } };
const MAIN_ONLY = { total_count: 1, branch_policies: [{ id: 1, name: "main", type: "branch" }] };
const secret = (name: string) => ({ name, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" });
const ENVIRONMENTS = ["release", "feed", "promote", "withdraw", "github-pages"] as const;

// The good settings set: four environments with a reviewer and Prevent self-review on, every environment allowing the
// branch main only, a tag ruleset only the release App can bypass, a main ruleset whose bypass the owner can read,
// the two signing keys as secrets of exactly the environments that use them, the App's two secrets as repository
// secrets (the known exposure, decision 10), and workflows naming release, feed and github-pages.
function world() {
  const dir = mkdtempSync(join(tmpdir(), "morndo-settings-"));
  roots.push(dir);
  const ghDir = join(dir, "fixtures");
  const bin = join(dir, "bin");
  const workflows = join(dir, "workflows");
  mkdirSync(ghDir);
  mkdirSync(bin);
  mkdirSync(workflows);
  writeFileSync(join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  const put = (path: string, data: unknown) =>
    writeFileSync(join(ghDir, `${path.split("/").join("__")}.json`), `${JSON.stringify(data, null, 1)}\n`);
  const file = (path: string) => join(ghDir, `${path.split("/").join("__")}.json`);

  const environments = [reviewed("release"), reviewed("feed"), reviewed("promote"), reviewed("withdraw"), PAGES];
  put(`repos/${REPO}/environments`, { total_count: environments.length, environments });
  for (const name of ENVIRONMENTS) put(`repos/${REPO}/environments/${name}/deployment-branch-policies`, MAIN_ONLY);
  put(`repos/${REPO}/environments/release/secrets`, { total_count: 1, secrets: [secret("RELEASE_SSH_KEY")] });
  put(`repos/${REPO}/environments/feed/secrets`, { total_count: 1, secrets: [secret("FEED_SSH_KEY")] });
  for (const name of ["promote", "withdraw", "github-pages"]) {
    put(`repos/${REPO}/environments/${name}/secrets`, { total_count: 0, secrets: [] });
  }
  put(`repos/${REPO}/actions/secrets`, { total_count: 2, secrets: [secret("RELEASE_APP_ID"), secret("RELEASE_APP_PRIVATE_KEY")] });
  put("orgs/acme/actions/secrets", { total_count: 0, secrets: [] });
  put(`repos/${REPO}/rulesets`, [
    { id: 10, name: "main: pull request and code owners", target: "branch", enforcement: "active" },
    { id: 20, name: "v* tags: only the release App", target: "tag", enforcement: "active" },
  ]);
  put(`repos/${REPO}/rulesets/10`, {
    id: 10, name: "main: pull request and code owners", target: "branch", enforcement: "active",
    bypass_actors: [{ actor_id: 3, actor_type: "RepositoryRole", bypass_mode: "always" }],
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    rules: [{ type: "pull_request" }, { type: "required_linear_history" }],
  });
  put(`repos/${REPO}/rulesets/20`, {
    id: 20, name: "v* tags: only the release App", target: "tag", enforcement: "active",
    bypass_actors: [{ actor_id: 7, actor_type: "Integration", bypass_mode: "always" }],
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
  });
  writeFileSync(join(workflows, "release.yml"), [
    "name: release",
    "on:",
    "  push:",
    "    branches: [main]",
    "jobs:",
    "  sign:",
    "    runs-on: ubuntu-24.04",
    "    environment: release",
    "    steps:",
    "      - run: echo signing",
    "  feed:",
    "    runs-on: ubuntu-24.04",
    "    environment: feed",
    "    steps:",
    "      - run: echo feeding",
    "",
  ].join("\n"));
  writeFileSync(join(workflows, "pages.yml"), [
    "name: pages",
    "on:",
    "  push:",
    "    branches: [main]",
    "jobs:",
    "  deploy:",
    "    runs-on: ubuntu-24.04",
    "    environment:",
    "      name: github-pages",
    "      url: ${{ steps.deploy.outputs.page_url }}",
    "    steps:",
    "      - run: echo deploying",
    "",
  ].join("\n"));

  const edit = (path: string, change: (data: any) => any) => {
    const data = JSON.parse(readFileSync(file(path), "utf8"));
    writeFileSync(file(path), JSON.stringify(change(data) ?? data, null, 1));
  };
  const remove = (path: string) => rmSync(file(path));
  const run = (args: string[] = []) =>
    spawnSync("/bin/sh", [SCRIPT, "--repo", REPO, "--workflows", workflows, ...args], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_GH_DIR: ghDir, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
    });
  return { dir, workflows, edit, remove, run };
}

describe("check-release-settings.sh", () => {
  it("a good settings set passes", () => {
    const w = world();
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("check-release-settings: ok");
    expect(r.stdout).toContain("KNOWN: RELEASE_APP_PRIVATE_KEY and RELEASE_APP_ID are repository secrets (decision 10: move them to an environment limited to main)");
    expect(r.stdout).toContain("INFO: main ruleset");
    expect(r.stdout).toContain("INFO: tag ruleset bypass: Integration:7");
  });

  it("a missing reviewer fails", () => {
    for (const name of ["release", "feed", "promote", "withdraw"]) {
      const w = world();
      w.edit(`repos/${REPO}/environments`, data => {
        for (const env of data.environments) if (env.name === name) env.protection_rules[0].reviewers = [];
      });
      const r = w.run();
      expect(r.status, `${name}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout).toMatch(new RegExp(`environment ${name} has no required reviewer`));
    }
  });

  it("a missing environment fails", () => {
    for (const name of ["promote", "withdraw"]) {
      const w = world();
      w.edit(`repos/${REPO}/environments`, data => ({ ...data, environments: data.environments.filter((e: { name: string }) => e.name !== name) }));
      const r = w.run();
      expect(r.status, `${name}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout).toMatch(new RegExp(`environment ${name} does not exist`));
    }
  });

  it("Prevent self-review off fails", () => {
    const w = world();
    w.edit(`repos/${REPO}/environments`, data => {
      for (const env of data.environments) if (env.name === "release") env.protection_rules[0].prevent_self_review = false;
    });
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/environment release: Prevent self-review is off/);
  });

  it("a tag pattern on an environment fails", () => {
    const tag = (id: number) => ({ id, name: "v*", type: "tag" });
    const cases: [string, RegExp, (w: ReturnType<typeof world>) => void][] = [
      ["main and a tag on feed", /environment feed allows main \(branch\), v\* \(tag\); it must allow the branch main only/, w => {
        w.edit(`repos/${REPO}/environments/feed/deployment-branch-policies`, d => ({ ...d, branch_policies: [...d.branch_policies, tag(2)] }));
      }],
      ["main and a tag on github-pages", /environment github-pages allows main \(branch\), v\* \(tag\); it must allow the branch main only/, w => {
        w.edit(`repos/${REPO}/environments/github-pages/deployment-branch-policies`, d => ({ ...d, branch_policies: [...d.branch_policies, tag(2)] }));
      }],
      ["a tag only", /environment feed allows v\* \(tag\); it must allow the branch main only/, w => {
        w.edit(`repos/${REPO}/environments/feed/deployment-branch-policies`, d => ({ ...d, branch_policies: [tag(2)] }));
      }],
      ["no custom policies", /environment feed [^;]*; it must allow the branch main only/, w => {
        w.edit(`repos/${REPO}/environments`, d => {
          for (const env of d.environments) if (env.name === "feed") env.deployment_branch_policy.custom_branch_policies = false;
        });
      }],
    ];
    for (const [what, message, change] of cases) {
      const w = world();
      change(w);
      const r = w.run();
      expect(r.status, `${what}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout).toMatch(message);
    }
  });

  it("github-pages allows main only", () => {
    const w = world();
    w.edit(`repos/${REPO}/environments/github-pages/deployment-branch-policies`, d => ({ ...d, branch_policies: [{ id: 1, name: "develop", type: "branch" }] }));
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/environment github-pages allows develop \(branch\); it must allow the branch main only/);
  });

  it("a workflow naming an environment that does not exist fails", () => {
    const inline = world();
    writeFileSync(join(inline.workflows, "extra.yml"), [
      "jobs:",
      "  sign:",
      "    runs-on: ubuntu-24.04",
      "    environment: nowhere",
      "    steps:",
      "      - run: echo signing",
      "",
    ].join("\n"));
    const a = inline.run();
    expect(a.status, a.stdout + a.stderr).toBe(1);
    expect(a.stdout).toMatch(/workflow extra\.yml names environment nowhere, which does not exist/);

    const block = world();
    writeFileSync(join(block.workflows, "pages.yml"), [
      "jobs:",
      "  deploy:",
      "    runs-on: ubuntu-24.04",
      "    environment:",
      "      name: nowhere",
      "      url: ${{ steps.deploy.outputs.page_url }}",
      "    steps:",
      "      - run: echo deploying",
      "",
    ].join("\n"));
    const b = block.run();
    expect(b.status, b.stdout + b.stderr).toBe(1);
    expect(b.stdout).toMatch(/workflow pages\.yml names environment nowhere, which does not exist/);

    // a name given as an expression is not a name: it is ignored, not reported
    const expression = world();
    writeFileSync(join(expression.workflows, "matrix.yml"), [
      "jobs:",
      "  sign:",
      "    runs-on: ubuntu-24.04",
      "    environment: ${{ matrix.env }}",
      "    steps:",
      "      - run: echo signing",
      "  deploy:",
      "    runs-on: ubuntu-24.04",
      "    environment:",
      "      name: ${{ inputs.environment }}",
      "      url: ${{ steps.deploy.outputs.page_url }}",
      "    steps:",
      "      - run: echo deploying",
      "",
    ].join("\n"));
    const c = expression.run();
    expect(c.status, c.stdout + c.stderr).toBe(0);
  });

  it("no tag ruleset fails", () => {
    const w = world();
    w.edit(`repos/${REPO}/rulesets`, d => d.filter((r: { target: string }) => r.target !== "tag"));
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/no tag ruleset on v\*/);
  });

  it("a tag ruleset that is not active, has the wrong pattern, lacks deletion, or lists the maintainer as a bypass actor fails", () => {
    const cases: [string, (d: any) => any][] = [
      ["not active", d => ({ ...d, enforcement: "disabled" })],
      ["the wrong pattern", d => ({ ...d, conditions: { ref_name: { include: ["refs/tags/*"], exclude: [] } } })],
      ["no deletion rule", d => ({ ...d, rules: d.rules.filter((r: { type: string }) => r.type !== "deletion") })],
      ["the maintainer as bypass actor", d => ({ ...d, bypass_actors: [{ actor_id: 3, actor_type: "RepositoryRole", bypass_mode: "always" }] })],
    ];
    for (const [what, change] of cases) {
      const w = world();
      w.edit(`repos/${REPO}/rulesets/20`, change);
      const r = w.run();
      expect(r.status, `${what}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout).toMatch(/tag ruleset/);
    }
    // two bypass actors are one too many as well
    const w = world();
    w.edit(`repos/${REPO}/rulesets/20`, d => ({ ...d, bypass_actors: [...d.bypass_actors, { actor_id: 8, actor_type: "Integration", bypass_mode: "always" }] }));
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/tag ruleset/);
  });

  it("a signing key as a repository or organisation secret fails", () => {
    const some = world();
    some.edit(`repos/${REPO}/actions/secrets`, d => ({ ...d, secrets: [...d.secrets, secret("SOME_SSH_KEY")] }));
    const a = some.run();
    expect(a.status, a.stdout + a.stderr).toBe(1);
    expect(a.stdout).toMatch(/repository secret SOME_SSH_KEY looks like a signing key/);

    // the feed key as a repository secret is the feed key in the wrong place, and a signing key in the open
    const wrongPlace = world();
    wrongPlace.edit(`repos/${REPO}/actions/secrets`, d => ({ ...d, secrets: [...d.secrets, secret("FEED_SSH_KEY")] }));
    const b = wrongPlace.run();
    expect(b.status, b.stdout + b.stderr).toBe(1);
    expect(b.stdout).toMatch(/FEED_SSH_KEY must be a secret of environment feed only \(found in: [^\n]*repository\)/);

    const org = world();
    org.edit("orgs/acme/actions/secrets", d => ({ ...d, secrets: [secret("ORG_SIGNING_KEY")] }));
    const c = org.run();
    expect(c.status, c.stdout + c.stderr).toBe(1);
    expect(c.stdout).toMatch(/organisation secret ORG_SIGNING_KEY looks like a signing key/);

    // the App's private key alone is the known exposure, not a failure (decision 10)
    const app = world();
    app.edit(`repos/${REPO}/actions/secrets`, d => ({ ...d, secrets: d.secrets.filter((s: { name: string }) => s.name !== "RELEASE_APP_ID") }));
    const e = app.run();
    expect(e.status, e.stdout + e.stderr).toBe(0);
    expect(e.stdout).toContain("KNOWN: RELEASE_APP_PRIVATE_KEY");
  });

  it("RELEASE_SSH_KEY or FEED_SSH_KEY in the wrong environment fails", () => {
    const cases: [string, string, string, (w: ReturnType<typeof world>) => void][] = [
      ["the release key in feed only", "RELEASE_SSH_KEY", "release", w => {
        w.edit(`repos/${REPO}/environments/release/secrets`, d => ({ ...d, secrets: [] }));
        w.edit(`repos/${REPO}/environments/feed/secrets`, d => ({ ...d, secrets: [...d.secrets, secret("RELEASE_SSH_KEY")] }));
      }],
      ["the feed key also in release", "FEED_SSH_KEY", "feed", w => {
        w.edit(`repos/${REPO}/environments/release/secrets`, d => ({ ...d, secrets: [...d.secrets, secret("FEED_SSH_KEY")] }));
      }],
      ["the release key missing", "RELEASE_SSH_KEY", "release", w => {
        w.edit(`repos/${REPO}/environments/release/secrets`, d => ({ ...d, secrets: [] }));
      }],
      ["the feed key in promote", "FEED_SSH_KEY", "feed", w => {
        w.edit(`repos/${REPO}/environments/promote/secrets`, d => ({ ...d, secrets: [secret("FEED_SSH_KEY")] }));
      }],
    ];
    for (const [what, key, wanted, change] of cases) {
      const w = world();
      change(w);
      const r = w.run();
      expect(r.status, `${what}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout).toMatch(new RegExp(`${key} must be a secret of environment ${wanted} only \\(found in: `));
    }
  });

  it("organisation secrets that cannot be read fail unless --no-org-secrets, which says they were not checked", () => {
    const w = world();
    w.remove("orgs/acme/actions/secrets");
    const refused = w.run();
    expect(refused.status, refused.stdout + refused.stderr).toBe(1);
    expect(refused.stdout).toMatch(/cannot read organisation secrets \(needs admin:org\); rerun with an admin token, or with --no-org-secrets/);
    const skipped = w.run(["--no-org-secrets"]);
    expect(skipped.status, skipped.stdout + skipped.stderr).toBe(0);
    expect(skipped.stdout).toContain("INFO: NOT CHECKED: organisation secrets");
  });

  it("a gh call that fails is a failure, not a pass", () => {
    const w = world();
    w.remove(`repos/${REPO}/environments`);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/FAIL: cannot read repos\/acme\/widgets\/environments/);
  });

  it("the output carries names only, never a value", () => {
    const w = world();
    const withValue = (s: { name: string }) => ({ ...s, value: "CANARY-VALUE-12345" });
    w.edit(`repos/${REPO}/actions/secrets`, d => ({ ...d, secrets: d.secrets.map(withValue) }));
    w.edit(`repos/${REPO}/environments/release/secrets`, d => ({ ...d, secrets: d.secrets.map(withValue) }));
    w.edit("orgs/acme/actions/secrets", d => ({ ...d, secrets: [withValue(secret("ORG_DEPLOY_TOKEN"))] }));
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("CANARY-VALUE-12345");
  });

  it("it reports every problem at once, not only the first", () => {
    const w = world();
    w.edit(`repos/${REPO}/environments`, data => {
      for (const env of data.environments) if (env.name === "feed") env.protection_rules[0].reviewers = [];
      data.environments = data.environments.filter((e: { name: string }) => e.name !== "promote");
    });
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout.split("\n").filter(line => line.startsWith("FAIL:"))).toEqual([
      "FAIL: environment feed has no required reviewer",
      "FAIL: environment promote does not exist",
    ]);
  });
});
