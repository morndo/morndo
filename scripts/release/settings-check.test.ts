// scripts/release/check-release-settings.sh proves, read-only, the GitHub settings a release depends on: the
// environments, their one reviewer (by id) and that administrators cannot bypass them, the main-only branch rules, the
// tag ruleset on v* that only the release App (by id) can bypass, a feed-branch ruleset nobody can bypass, a CODEOWNERS
// owner for /trust/, and where each signing key lives (names only, never a value). The workflows and CODEOWNERS it
// reads are the ones on main, through the API, and the key secrets are the ones those workflows use in the release,
// feed, promote and withdraw jobs. These tests run it against a fake gh whose every answer is a JSON fixture shaped as
// the GitHub API answered it on 2026-10-24, break one setting at a time and expect a FAIL line naming it — or, when
// two are broken, both lines at once: the check reports every problem, not only the first.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./check-release-settings.sh", import.meta.url));
const REPO = "acme/widgets";
const REVIEWER_ID = 1;
const APP_ID = 7;
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

// The fake gh the check finds first on PATH: `api <endpoint> [-H header]` (any --paginate is ignored, the value after
// -H is not an endpoint) answers with $FAKE_GH_DIR/<endpoint with every / mapped to __>.json, and a missing fixture
// is a 404, as a token without the scope would see it. /usr/bin:/bin stays behind the fake, so the check still finds
// the real jq.
const FAKE_GH = [
  "#!/bin/sh",
  "set -eu",
  '[ "${1:-}" = api ] || { echo "gh: unexpected command: $*" >&2; exit 1; }',
  "shift",
  "endpoint=",
  "skip=0",
  'for arg in "$@"; do',
  '  if [ "$skip" = 1 ]; then skip=0; continue; fi',
  '  case $arg in -H|--header) skip=1; continue ;; -*) continue ;; esac',
  "  endpoint=$arg",
  "  break",
  "done",
  '[ -n "$endpoint" ] || { echo "gh: no endpoint" >&2; exit 1; }',
  'file="$FAKE_GH_DIR/$(printf \'%s\' "$endpoint" | sed \'s|/|__|g\').json"',
  'if [ -f "$file" ]; then cat "$file"; else echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi',
  "",
].join("\n");

const REVIEWER = { type: "User", reviewer: { login: "reviewer-account", id: REVIEWER_ID } };
const reviewed = (name: string) => ({
  name,
  can_admins_bypass: false,
  protection_rules: [
    { type: "required_reviewers", prevent_self_review: true, reviewers: [REVIEWER] },
    { type: "branch_policy" },
  ],
  deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
});
// github-pages serves documents the clients verify, so it needs no reviewer and may let administrators bypass; it still
// allows main only. release-please runs on every push to main, so it has no required reviewer either; administrator
// bypass may stay on, and it still allows main only.
const PAGES = { name: "github-pages", can_admins_bypass: true, protection_rules: [{ type: "branch_policy" }], deployment_branch_policy: { custom_branch_policies: true, protected_branches: false } };
const RELEASE_PLEASE = { name: "release-please", can_admins_bypass: true, protection_rules: [{ type: "branch_policy" }], deployment_branch_policy: { custom_branch_policies: true, protected_branches: false } };
const MAIN_ONLY = { total_count: 1, branch_policies: [{ id: 1, name: "main", type: "branch" }] };
const secret = (name: string) => ({ name, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" });
const ENVIRONMENTS = ["release", "feed", "promote", "withdraw", "github-pages", "release-please"] as const;
const KEY_ENVIRONMENTS = ["release", "feed", "promote", "withdraw"] as const;
const WORKFLOWS = `repos/${REPO}/contents/.github/workflows`;

const RELEASE_YML = [
  "name: release",
  "on:",
  "  push:",
  "    branches: [main]",
  "jobs:",
  "  release-please:",
  "    runs-on: ubuntu-24.04",
  "    environment: release-please",
  "    steps:",
  "      # the app token opens the release pull request",
  "      - uses: example/app-token@v1",
  "        with:",
  "          app-id: ${{ secrets.RELEASE_APP_ID }}",
  "          private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}",
  "      - run: echo ${{ secrets.GITHUB_TOKEN }}",
  "  sign:",
  "    runs-on: ubuntu-24.04",
  "    environment: release",
  "    steps:",
  "      - uses: example/sign@v1",
  "        with:",
  "          key: ${{ secrets.RELEASE_SSH_KEY }}",
  "  feed-sign:",
  "    runs-on: ubuntu-24.04",
  "    environment: feed",
  "    steps:",
  "      - uses: example/sign@v1",
  "        with:",
  "          key: ${{ secrets.FEED_SSH_KEY }}",
  "",
].join("\n");
const PAGES_YML = [
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
].join("\n");

// The good settings set: four environments with exactly the one reviewer (by id), Prevent self-review on and
// administrator bypass off, every environment allowing the branch main only, release-please with no required reviewer
// and the branch main only, a tag ruleset only the release App (by id) can bypass, a main ruleset whose bypass the
// owner can read, a feed-branch ruleset with no bypass that blocks force pushes and deletion, CODEOWNERS naming an
// owner for /trust/, the two signing keys as secrets of exactly the environments whose jobs use them, the App's two
// secrets as secrets of release-please only, and the workflows on main using them.
function world() {
  const dir = mkdtempSync(join(tmpdir(), "morndo-settings-"));
  roots.push(dir);
  const ghDir = join(dir, "fixtures");
  const bin = join(dir, "bin");
  mkdirSync(ghDir);
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  const file = (path: string) => join(ghDir, `${path.split("/").join("__")}.json`);
  const put = (path: string, data: unknown) => writeFileSync(file(path), `${JSON.stringify(data, null, 1)}\n`);
  // Raw bodies (the workflows, CODEOWNERS) are the file the contents API returns for the raw media type, not JSON.
  const raw = (path: string, text: string) => writeFileSync(file(path), text);

  const environments = [reviewed("release"), reviewed("feed"), reviewed("promote"), reviewed("withdraw"), PAGES, RELEASE_PLEASE];
  put(`repos/${REPO}/environments`, { total_count: environments.length, environments });
  for (const name of ENVIRONMENTS) put(`repos/${REPO}/environments/${name}/deployment-branch-policies`, MAIN_ONLY);
  put(`repos/${REPO}/environments/release/secrets`, { total_count: 1, secrets: [secret("RELEASE_SSH_KEY")] });
  put(`repos/${REPO}/environments/feed/secrets`, { total_count: 1, secrets: [secret("FEED_SSH_KEY")] });
  put(`repos/${REPO}/environments/release-please/secrets`, { total_count: 2, secrets: [secret("RELEASE_APP_ID"), secret("RELEASE_APP_PRIVATE_KEY")] });
  for (const name of ["promote", "withdraw", "github-pages"]) {
    put(`repos/${REPO}/environments/${name}/secrets`, { total_count: 0, secrets: [] });
  }
  put(`repos/${REPO}/actions/secrets`, { total_count: 0, secrets: [] });
  put("orgs/acme/actions/secrets", { total_count: 0, secrets: [] });
  put(`repos/${REPO}/rulesets`, [
    { id: 10, name: "main: pull request and code owners", target: "branch", enforcement: "active" },
    { id: 20, name: "v* tags: only the release App", target: "tag", enforcement: "active" },
    { id: 30, name: "feed branch: no force push, no deletion", target: "branch", enforcement: "active" },
  ]);
  put(`repos/${REPO}/rulesets/10`, {
    id: 10, name: "main: pull request and code owners", target: "branch", enforcement: "active",
    bypass_actors: [{ actor_id: 3, actor_type: "RepositoryRole", bypass_mode: "always" }],
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    rules: [{ type: "pull_request", parameters: { require_code_owner_review: true, required_approving_review_count: 1 } }, { type: "required_linear_history" }],
  });
  put(`repos/${REPO}/rulesets/20`, {
    id: 20, name: "v* tags: only the release App", target: "tag", enforcement: "active",
    bypass_actors: [{ actor_id: APP_ID, actor_type: "Integration", bypass_mode: "always" }],
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
  });
  put(`repos/${REPO}/rulesets/30`, {
    id: 30, name: "feed branch: no force push, no deletion", target: "branch", enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["refs/heads/feed"], exclude: [] } },
    rules: [{ type: "non_fast_forward" }, { type: "deletion" }],
  });
  raw(`repos/${REPO}/contents/.github/CODEOWNERS?ref=main`, "# one maintainer\n* @owner-account\n/trust/ @owner-account\n");

  // The workflows on main, as the contents API answers: the directory listing, then each file as raw text.
  const workflows: Record<string, string> = { "release.yml": RELEASE_YML, "pages.yml": PAGES_YML };
  const publishWorkflows = () => {
    put(`${WORKFLOWS}?ref=main`, Object.keys(workflows).map(name => ({ name, path: `.github/workflows/${name}`, type: "file" })));
    for (const [name, text] of Object.entries(workflows)) raw(`${WORKFLOWS}/${name}?ref=main`, text);
  };
  publishWorkflows();
  const workflow = (name: string, text: string | null) => {
    if (text === null) delete workflows[name]; else workflows[name] = text;
    publishWorkflows();
  };

  const edit = (path: string, change: (data: any) => any) => {
    const data = JSON.parse(readFileSync(file(path), "utf8"));
    writeFileSync(file(path), JSON.stringify(change(data) ?? data, null, 1));
  };
  const remove = (path: string) => rmSync(file(path));
  // `runRaw` passes exactly the arguments given; `run` adds the repository and the two required ids.
  const runRaw = (args: string[], cwd?: string) =>
    spawnSync("/bin/sh", [SCRIPT, ...args], {
      encoding: "utf8",
      ...(cwd === undefined ? {} : { cwd }),
      env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_GH_DIR: ghDir, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
    });
  const run = (args: string[] = [], cwd?: string) =>
    runRaw(["--repo", REPO, "--reviewer-id", String(REVIEWER_ID), "--app-id", String(APP_ID), ...args], cwd);
  return { dir, edit, remove, run, runRaw, workflow, put, raw };
}
type World = ReturnType<typeof world>;

const editEnvironment = (w: World, name: string, change: (env: any) => void) =>
  w.edit(`repos/${REPO}/environments`, data => { for (const env of data.environments) if (env.name === name) change(env); });
const failLines = (stdout: string) => stdout.split("\n").filter(line => line.startsWith("FAIL:"));

describe("check-release-settings.sh", () => {
  it("a good settings set passes", () => {
    const w = world();
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("check-release-settings: ok");
    expect(failLines(r.stdout)).toEqual([]);
    expect(r.stdout).not.toContain("KNOWN");
    expect(r.stdout).toMatch(/release-please allows the branch main only/);
    expect(r.stdout).toContain("INFO: main ruleset");
    expect(r.stdout).toContain("INFO: tag ruleset bypass: Integration:7");
  });

  it("a missing reviewer fails", () => {
    for (const name of KEY_ENVIRONMENTS) {
      const w = world();
      editEnvironment(w, name, env => { env.protection_rules[0].reviewers = []; });
      const r = w.run();
      expect(r.status, `${name}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout).toMatch(new RegExp(`environment ${name} has no required reviewer`));
    }
  });

  it("the reviewer must be exactly the expected account, by id", () => {
    const cases: [string, string, (reviewers: any[]) => any[]][] = [
      ["another user only (the maintainer)", "User:2", () => [{ type: "User", reviewer: { login: "maintainer-account", id: 2 } }]],
      ["a team with the expected number", "Team:1", () => [{ type: "Team", reviewer: { slug: "release-team", id: REVIEWER_ID } }]],
      ["the expected user and a second one", "User:1, User:2", reviewers => [...reviewers, { type: "User", reviewer: { login: "maintainer-account", id: 2 } }]],
    ];
    for (const [what, found, change] of cases) {
      const w = world();
      editEnvironment(w, "feed", env => { env.protection_rules[0].reviewers = change(env.protection_rules[0].reviewers); });
      const r = w.run();
      expect(r.status, `${what}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout).toContain(`FAIL: environment feed reviewers must be exactly User:${REVIEWER_ID}, found ${found}`);
    }
    // the id the caller names is the one compared: the same fixture passes for its own reviewer and fails for another
    const w = world();
    expect(w.run().status).toBe(0);
    const other = w.runRaw(["--repo", REPO, "--reviewer-id", "2", "--app-id", String(APP_ID)]);
    expect(other.status, other.stdout + other.stderr).toBe(1);
    expect(other.stdout).toContain("FAIL: environment release reviewers must be exactly User:2, found User:1");
  });

  it("administrators able to bypass an environment fails", () => {
    for (const name of KEY_ENVIRONMENTS) {
      const w = world();
      editEnvironment(w, name, env => { env.can_admins_bypass = true; });
      const r = w.run();
      expect(r.status, `${name}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout).toContain(`FAIL: environment ${name} lets repository administrators bypass its protection rules (can_admins_bypass is true); turn it off`);
    }
    // a missing field is not a pass: the check cannot tell
    const w = world();
    editEnvironment(w, "release", env => { delete env.can_admins_bypass; });
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain("FAIL: environment release lets repository administrators bypass its protection rules (can_admins_bypass is missing); turn it off");
    // github-pages needs no reviewer and is not held to it (the good fixture lets administrators bypass it)
    expect(world().run().status).toBe(0);
  });

  it("a missing --reviewer-id or --app-id is a usage error", () => {
    const w = world();
    const cases: string[][] = [
      ["--repo", REPO, "--app-id", "7"],
      ["--repo", REPO, "--reviewer-id", "1"],
      ["--repo", REPO, "--reviewer-id", "abc", "--app-id", "7"],
      ["--repo", REPO, "--reviewer-id", "1", "--app-id", ""],
      ["--repo", REPO, "--reviewer-id", "1", "--app-id", "7", "--workflows", "somewhere"],
    ];
    for (const args of cases) {
      const r = w.runRaw(args);
      expect(r.status, `${args.join(" ")}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/usage: check-release-settings\.sh/);
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
    editEnvironment(w, "release", env => { env.protection_rules[0].prevent_self_review = false; });
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/environment release: Prevent self-review is off/);
  });

  it("a tag pattern on an environment fails", () => {
    const tag = (id: number) => ({ id, name: "v*", type: "tag" });
    const cases: [string, RegExp, (w: World) => void][] = [
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
        editEnvironment(w, "feed", env => { env.deployment_branch_policy.custom_branch_policies = false; });
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
    inline.workflow("extra.yml", [
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
    block.workflow("pages.yml", [
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
    expression.workflow("matrix.yml", [
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

  it("an environment written as a flow mapping is read as the block form is", () => {
    const flows: [string, string[]][] = [
      ["one line", ["    environment: { name: nowhere, url: https://example.test }"]],
      ["one line, no spaces, quoted", ['    environment: {name: "nowhere"}']],
      ["several lines", ["    environment: {", "      url: ${{ steps.deploy.outputs.page_url }},", "      name: nowhere", "    }"]],
    ];
    for (const [what, lines] of flows) {
      const w = world();
      w.workflow("flow.yml", ["jobs:", "  deploy:", "    runs-on: ubuntu-24.04", ...lines, "    steps:", "      - run: echo deploying", ""].join("\n"));
      const r = w.run();
      expect(r.status, `${what}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout, what).toMatch(/workflow flow\.yml names environment nowhere, which does not exist/);
    }
    // an environment that exists is fine, and a key secret used under the flow form is judged like any other
    const ok = world();
    // the flow form ends with its line: a later step's own `name:` is not the environment's
    ok.workflow("flow.yml", ["jobs:", "  deploy:", "    environment: { name: github-pages, url: https://example.test }", "    steps:", "      - name: build the site", "        run: echo deploying", ""].join("\n"));
    const o = ok.run();
    expect(o.status, o.stdout + o.stderr).toBe(0);
    const multi = world();
    multi.workflow("flow.yml", ["jobs:", "  deploy:", "    environment: {", "      name: github-pages", "    }", "    steps:", "      - name: build the site", "        run: echo deploying", ""].join("\n"));
    const m = multi.run();
    expect(m.status, m.stdout + m.stderr).toBe(0);
    const key = world();
    key.workflow("flow.yml", ["jobs:", "  promote:", "    environment: { name: promote }", "    steps:", "      - run: echo ${{ secrets.PROMOTE_SIGNING }}", ""].join("\n"));
    const k = key.run();
    expect(k.status, k.stdout + k.stderr).toBe(1);
    expect(k.stdout).toMatch(/PROMOTE_SIGNING \(used by job promote of flow\.yml in environment promote\) must be a secret of environment promote only/);
    // a name that is an expression is still skipped in the flow form
    const expression = world();
    expression.workflow("flow.yml", ["jobs:", "  deploy:", "    environment: { name: '${{ inputs.environment }}' }", "    steps:", "      - run: echo deploying", ""].join("\n"));
    expect(expression.run().status).toBe(0);
  });

  it("the workflows are read from main through the API, not from the checkout", () => {
    const w = world();
    // a checkout whose own workflow names an environment that does not exist: it is not what the check reads
    const checkout = join(w.dir, "checkout");
    mkdirSync(join(checkout, ".github", "workflows"), { recursive: true });
    writeFileSync(join(checkout, ".github", "workflows", "evil.yml"), "jobs:\n  x:\n    environment: ghost\n");
    const a = w.run([], checkout);
    expect(a.status, a.stdout + a.stderr).toBe(0);
    expect(a.stdout).not.toContain("ghost");
    // what is on main is: the same name there fails
    w.workflow("evil.yml", "jobs:\n  x:\n    environment: ghost\n");
    const b = w.run([], checkout);
    expect(b.status, b.stdout + b.stderr).toBe(1);
    expect(b.stdout).toMatch(/workflow evil\.yml names environment ghost, which does not exist/);
    // an unreadable listing and no workflow files are failures, not passes
    const none = world();
    none.remove(`${WORKFLOWS}?ref=main`);
    const c = none.run();
    expect(c.status, c.stdout + c.stderr).toBe(1);
    expect(c.stdout).toContain(`FAIL: cannot read ${WORKFLOWS}?ref=main`);
    const empty = world();
    empty.edit(`${WORKFLOWS}?ref=main`, () => []);
    const d = empty.run();
    expect(d.status, d.stdout + d.stderr).toBe(1);
    expect(d.stdout).toContain("FAIL: no workflow files found on main");
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

  it("the tag ruleset's bypass must be the release App, by id", () => {
    const other = world();
    other.edit(`repos/${REPO}/rulesets/20`, d => ({ ...d, bypass_actors: [{ actor_id: 8, actor_type: "Integration", bypass_mode: "always" }] }));
    const a = other.run();
    expect(a.status, a.stdout + a.stderr).toBe(1);
    expect(a.stdout).toContain(`has a bypass actor that is not the release App (Integration:${APP_ID}); found Integration:8`);
    // the App's number on another kind of actor is not the App: the type is compared as well as the id
    for (const type of ["User", "Team", "RepositoryRole"]) {
      const w = world();
      w.edit(`repos/${REPO}/rulesets/20`, d => ({ ...d, bypass_actors: [{ actor_id: APP_ID, actor_type: type, bypass_mode: "always" }] }));
      const r = w.run();
      expect(r.status, `${type}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout).toContain(`found ${type}:${APP_ID}`);
    }
    // the id the caller names is the one compared
    const w = world();
    expect(w.run().status).toBe(0);
    const named = w.runRaw(["--repo", REPO, "--reviewer-id", String(REVIEWER_ID), "--app-id", "8"]);
    expect(named.status, named.stdout + named.stderr).toBe(1);
    expect(named.stdout).toContain("has a bypass actor that is not the release App (Integration:8); found Integration:7");
  });

  it("a key secret used by a release job must live in that job's environment only", () => {
    const cases: [string, string, string, (w: World) => void][] = [
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
      ["the feed key as a repository secret", "FEED_SSH_KEY", "feed", w => {
        w.edit(`repos/${REPO}/actions/secrets`, d => ({ ...d, secrets: [...d.secrets, secret("FEED_SSH_KEY")] }));
      }],
      ["the release key as an organisation secret", "RELEASE_SSH_KEY", "release", w => {
        w.edit("orgs/acme/actions/secrets", d => ({ ...d, secrets: [secret("RELEASE_SSH_KEY")] }));
      }],
      // a secret no name list knows: a promote job's own key is derived from the workflow that uses it
      ["a new key a promote job uses, absent from promote", "PROMOTE_SIGNING", "promote", w => {
        w.workflow("promote.yml", [
          "jobs:",
          "  promote:",
          "    runs-on: ubuntu-24.04",
          "    environment: promote",
          "    steps:",
          "      - uses: example/sign@v1",
          "        with:",
          "          key: ${{ secrets.PROMOTE_SIGNING }}",
          "",
        ].join("\n"));
      }],
      ["a new key a withdraw job uses, kept as a repository secret", "WITHDRAW_SIGNING", "withdraw", w => {
        w.workflow("withdraw.yml", [
          "jobs:",
          "  withdraw:",
          "    runs-on: ubuntu-24.04",
          "    environment:",
          "      name: withdraw",
          "    steps:",
          "      - uses: example/sign@v1",
          "        with:",
          "          key: ${{ secrets.WITHDRAW_SIGNING }}",
          "",
        ].join("\n"));
        w.edit(`repos/${REPO}/actions/secrets`, d => ({ ...d, secrets: [...d.secrets, secret("WITHDRAW_SIGNING")] }));
      }],
    ];
    for (const [what, key, wanted, change] of cases) {
      const w = world();
      change(w);
      const r = w.run();
      expect(r.status, `${what}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout, what).toMatch(new RegExp(`${key} \\(used by job [a-z-]+ of [a-z.]+ in environment ${wanted}\\) must be a secret of environment ${wanted} only \\(found in: `));
    }
    // and a key a promote job uses, in promote only, is fine
    const w = world();
    w.workflow("promote.yml", "jobs:\n  promote:\n    environment: promote\n    steps:\n      - run: echo ${{ secrets.PROMOTE_SIGNING }}\n");
    w.edit(`repos/${REPO}/environments/promote/secrets`, d => ({ ...d, secrets: [secret("PROMOTE_SIGNING")] }));
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it("a secret that no workflow uses is not judged by its name", () => {
    const w = world();
    w.edit(`repos/${REPO}/actions/secrets`, d => ({ ...d, secrets: [...d.secrets, secret("UNUSED_SSH_KEY")] }));
    w.edit("orgs/acme/actions/secrets", d => ({ ...d, secrets: [secret("ORG_SIGNING_KEY")] }));
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(failLines(r.stdout)).toEqual([]);
    // not judged, but not silent either: every repository and organisation secret no workflow uses is listed
    expect(r.stdout).toContain("INFO: repository secret UNUSED_SSH_KEY is used by no workflow on main");
    expect(r.stdout).toContain("INFO: organisation secret ORG_SIGNING_KEY is used by no workflow on main");
    // a secret a workflow does use is not listed, and neither are the environments' own
    expect(r.stdout).not.toContain("repository secret RELEASE_APP_ID is used by no workflow");
    expect(r.stdout).not.toContain("RELEASE_SSH_KEY is used by no workflow");
    expect(world().run().stdout).not.toContain("is used by no workflow");
  });

  it("a job without an environment using another secret is reported, not failed", () => {
    const w = world();
    w.workflow("lint.yml", [
      "jobs:",
      "  lint:",
      "    runs-on: ubuntu-24.04",
      "    steps:",
      "      - run: echo ${{ secrets.REPORT_TOKEN }}",
      "",
    ].join("\n"));
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("INFO: job lint of lint.yml uses repository secret REPORT_TOKEN (no environment)");
    expect(r.stdout).not.toContain("KNOWN");
  });

  it("a key secret read by a job with no environment fails", () => {
    const outside = (name: string, extra: string[] = []) => ["jobs:", "  build:", "    runs-on: ubuntu-24.04", ...extra, "    steps:", `      - run: echo \${{ secrets.${name} }}`, ""].join("\n");
    const cases: [string, string, (w: World) => void][] = [
      // a key by placement: it is a secret of the release environment
      ["the release key", "RELEASE_SSH_KEY", w => w.workflow("build.yml", outside("RELEASE_SSH_KEY"))],
      ["the feed key", "FEED_SSH_KEY", w => w.workflow("build.yml", outside("FEED_SSH_KEY"))],
      // a key by use alone: a promote job reads it, so it is a key even before the environment holds it
      ["a key a promote job reads, not yet held", "PROMOTE_SIGNING", w => {
        w.workflow("promote.yml", "jobs:\n  promote:\n    environment: promote\n    steps:\n      - run: echo ${{ secrets.PROMOTE_SIGNING }}\n");
        w.workflow("build.yml", outside("PROMOTE_SIGNING"));
      }],
      // a key by placement alone: an environment holds it and no key job reads it (a leftover)
      ["a key the release environment holds that no job reads", "LEFTOVER_KEY", w => {
        w.edit(`repos/${REPO}/environments/release/secrets`, d => ({ ...d, secrets: [...d.secrets, secret("LEFTOVER_KEY")] }));
        w.workflow("build.yml", outside("LEFTOVER_KEY"));
      }],
      // the same job, with the environment written as an expression: the check cannot see one, so it is none
      ["an environment given as an expression", "RELEASE_SSH_KEY", w => w.workflow("build.yml", outside("RELEASE_SSH_KEY", ["    environment: ${{ inputs.target }}"]))],
    ];
    for (const [what, key, change] of cases) {
      const w = world();
      change(w);
      const r = w.run();
      expect(r.status, `${what}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout, what).toContain(`FAIL: job build of build.yml reads key secret ${key} without an environment`);
      expect(r.stdout, what).not.toContain(`INFO: job build of build.yml uses repository secret ${key}`);
    }
    // the two signing keys are keys by name, whatever else is set: with no key job reading them under an environment
    // and no environment holding them, a job that reads one without an environment is still a failure — the original
    // misconfiguration, a sign job that lost its `environment:` line while the key sits as a repository secret
    for (const key of ["RELEASE_SSH_KEY", "FEED_SSH_KEY"]) {
      const bare = world();
      bare.workflow("release.yml", ["name: release", "jobs:", "  sign:", "    runs-on: ubuntu-24.04", "    steps:", "      - uses: example/sign@v1", "        with:", `          key: \${{ secrets.${key} }}`, ""].join("\n"));
      bare.edit(`repos/${REPO}/environments/release/secrets`, d => ({ ...d, secrets: [] }));
      bare.edit(`repos/${REPO}/environments/feed/secrets`, d => ({ ...d, secrets: [] }));
      bare.edit(`repos/${REPO}/actions/secrets`, d => ({ ...d, secrets: [...d.secrets, secret(key)] }));
      const k = bare.run();
      expect(k.status, `${key}: ${k.stdout}${k.stderr}`).toBe(1);
      expect(k.stdout, key).toContain(`FAIL: job sign of release.yml reads key secret ${key} without an environment`);
      expect(k.stdout, key).not.toContain(`INFO: job sign of release.yml uses repository secret ${key}`);
    }
    // the App's two secrets are keys by name, so a job with no environment that reads one fails like a signing key
    const w = world();
    w.workflow("build.yml", outside("RELEASE_APP_ID"));
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain("FAIL: job build of build.yml reads key secret RELEASE_APP_ID without an environment");
    expect(r.stdout).not.toContain("INFO: job build of build.yml uses repository secret RELEASE_APP_ID");
    expect(r.stdout).not.toContain("KNOWN");
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
    w.edit(`repos/${REPO}/environments/release-please/secrets`, d => ({ ...d, secrets: d.secrets.map(withValue) }));
    w.edit("orgs/acme/actions/secrets", d => ({ ...d, secrets: [withValue(secret("ORG_DEPLOY_TOKEN"))] }));
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("CANARY-VALUE-12345");
  });

  it("the release-please environment must exist", () => {
    const absent = world();
    absent.edit(`repos/${REPO}/environments`, data => ({ ...data, environments: data.environments.filter((e: { name: string }) => e.name !== "release-please") }));
    const a = absent.run();
    expect(a.status, a.stdout + a.stderr).toBe(1);
    expect(a.stdout).toContain("FAIL: environment release-please does not exist");
    // a missing environment is reported once: its branch rule, its reviewer and its secrets are not checked again
    expect(a.stdout).not.toMatch(/environment release-please allows/);
    expect(a.stdout).not.toMatch(/environment release-please has a required reviewer/);
    expect(a.stdout).not.toMatch(/RELEASE_APP_(ID|PRIVATE_KEY) must be a secret/);

    // the shape the first run auto-creates: no branch rule, no secrets, the App's secrets still on the repository
    const created = world();
    editEnvironment(created, "release-please", env => {
      env.protection_rules = [];
      env.deployment_branch_policy = { protected_branches: true, custom_branch_policies: false };
    });
    created.edit(`repos/${REPO}/environments/release-please/secrets`, () => ({ total_count: 0, secrets: [] }));
    created.edit(`repos/${REPO}/actions/secrets`, () => ({ total_count: 2, secrets: [secret("RELEASE_APP_ID"), secret("RELEASE_APP_PRIVATE_KEY")] }));
    const b = created.run();
    expect(b.status, b.stdout + b.stderr).toBe(1);
    expect(b.stdout).toContain("FAIL: environment release-please allows all protected branches; it must allow the branch main only");
    expect(b.stdout).toContain("FAIL: RELEASE_APP_ID must be a secret of environment release-please only (found in: repository)");
    expect(b.stdout).toContain("FAIL: RELEASE_APP_PRIVATE_KEY must be a secret of environment release-please only (found in: repository)");
    expect(b.stdout).not.toContain("environment release-please has a required reviewer");
  });

  it("the release-please environment allows main only", () => {
    const tag = { id: 2, name: "v*", type: "tag" };
    const cases: [string, string, (w: World) => void][] = [
      ["a tag policy beside main", "environment release-please allows main (branch), v* (tag); it must allow the branch main only", w => {
        w.edit(`repos/${REPO}/environments/release-please/deployment-branch-policies`, d => ({ ...d, branch_policies: [...d.branch_policies, tag] }));
      }],
      ["a branch named develop", "environment release-please allows develop (branch); it must allow the branch main only", w => {
        w.edit(`repos/${REPO}/environments/release-please/deployment-branch-policies`, d => ({ ...d, branch_policies: [{ id: 1, name: "develop", type: "branch" }] }));
      }],
      ["no custom policies", "environment release-please allows all protected branches; it must allow the branch main only", w => {
        editEnvironment(w, "release-please", env => { env.deployment_branch_policy.custom_branch_policies = false; });
      }],
    ];
    for (const [what, message, change] of cases) {
      const w = world();
      change(w);
      const r = w.run();
      expect(r.status, `${what}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(failLines(r.stdout), what).toEqual([`FAIL: ${message}`]);
    }
  });

  it("the release-please environment has no required reviewer", () => {
    const required = world();
    editEnvironment(required, "release-please", env => {
      env.protection_rules = [
        { type: "required_reviewers", prevent_self_review: false, reviewers: [REVIEWER] },
        { type: "branch_policy" },
      ];
    });
    const r = required.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain(`FAIL: environment release-please has a required reviewer (User:${REVIEWER_ID}); the job that uses it runs on every push to main`);
    expect(r.stdout).not.toContain("Prevent self-review");
    expect(r.stdout).not.toContain("can_admins_bypass");

    const empty = world();
    editEnvironment(empty, "release-please", env => {
      env.protection_rules = [
        { type: "required_reviewers", reviewers: [] },
        { type: "branch_policy" },
      ];
    });
    const e = empty.run();
    expect(e.status, e.stdout + e.stderr).toBe(0);

    const branchOnly = world();
    editEnvironment(branchOnly, "release-please", env => { env.protection_rules = [{ type: "branch_policy" }]; });
    expect(branchOnly.run().status).toBe(0);

    const noRules = world();
    editEnvironment(noRules, "release-please", env => { env.protection_rules = []; });
    const n = noRules.run();
    expect(n.status, n.stdout + n.stderr).toBe(0);
  });

  it("the App's two secrets must be secrets of release-please only", () => {
    const line = (name: string, found: string) => `FAIL: ${name} must be a secret of environment release-please only (found in: ${found})`;
    const cases: [string, string, string, (w: World) => void][] = [
      ["RELEASE_APP_ID missing from the environment", "RELEASE_APP_ID", "nowhere", w => {
        w.edit(`repos/${REPO}/environments/release-please/secrets`, d => ({ ...d, secrets: d.secrets.filter((s: { name: string }) => s.name !== "RELEASE_APP_ID") }));
      }],
      ["RELEASE_APP_PRIVATE_KEY missing from the environment", "RELEASE_APP_PRIVATE_KEY", "nowhere", w => {
        w.edit(`repos/${REPO}/environments/release-please/secrets`, d => ({ ...d, secrets: d.secrets.filter((s: { name: string }) => s.name !== "RELEASE_APP_PRIVATE_KEY") }));
      }],
      ["RELEASE_APP_ID also a repository secret", "RELEASE_APP_ID", "environment release-please, repository", w => {
        w.edit(`repos/${REPO}/actions/secrets`, d => ({ ...d, secrets: [...d.secrets, secret("RELEASE_APP_ID")] }));
      }],
      ["RELEASE_APP_ID also an organisation secret", "RELEASE_APP_ID", "environment release-please, organisation", w => {
        w.edit("orgs/acme/actions/secrets", d => ({ ...d, secrets: [secret("RELEASE_APP_ID")] }));
      }],
      ["RELEASE_APP_ID also in the feed environment", "RELEASE_APP_ID", "environment feed, environment release-please", w => {
        w.edit(`repos/${REPO}/environments/feed/secrets`, d => ({ ...d, secrets: [...d.secrets, secret("RELEASE_APP_ID")] }));
      }],
    ];
    for (const [what, name, found, change] of cases) {
      const w = world();
      change(w);
      const r = w.run();
      expect(r.status, `${what}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout, what).toContain(line(name, found));
      const other = name === "RELEASE_APP_ID" ? "RELEASE_APP_PRIVATE_KEY" : "RELEASE_APP_ID";
      expect(failLines(r.stdout).some(row => row.includes(other)), what).toBe(false);
    }
  });

  it("the App's secrets in both the environment and the repository fail until the repository copies are deleted", () => {
    const w = world();
    w.edit(`repos/${REPO}/actions/secrets`, () => ({ total_count: 2, secrets: [secret("RELEASE_APP_ID"), secret("RELEASE_APP_PRIVATE_KEY")] }));
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(failLines(r.stdout)).toEqual([
      "FAIL: RELEASE_APP_ID must be a secret of environment release-please only (found in: environment release-please, repository)",
      "FAIL: RELEASE_APP_PRIVATE_KEY must be a secret of environment release-please only (found in: environment release-please, repository)",
    ]);
    w.edit(`repos/${REPO}/actions/secrets`, () => ({ total_count: 0, secrets: [] }));
    const ok = w.run();
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).not.toContain("KNOWN");
  });

  it("a job with no environment that reads an App secret fails", () => {
    const outside = (name: string) => ["jobs:", "  build:", "    runs-on: ubuntu-24.04", "    steps:", `      - run: echo \${{ secrets.${name} }}`, ""].join("\n");
    for (const name of ["RELEASE_APP_ID", "RELEASE_APP_PRIVATE_KEY"]) {
      const w = world();
      w.workflow("build.yml", outside(name));
      const r = w.run();
      expect(r.status, `${name}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout, name).toContain(`FAIL: job build of build.yml reads key secret ${name} without an environment`);
      expect(r.stdout, name).not.toContain("KNOWN");
    }
  });

  it("the feed branch needs an active ruleset with no force push, no deletion and no bypass", () => {
    const name = "feed branch: no force push, no deletion";
    const none = "FAIL: no ruleset protects the feed branch (it needs an active branch ruleset on refs/heads/feed with non_fast_forward and deletion rules and no bypass actor)";
    const line = (what: string) => `FAIL: feed ruleset '${name}' ${what}`;
    const cases: [string, string, (w: World) => void][] = [
      ["no feed ruleset", none, w => {
        w.edit(`repos/${REPO}/rulesets`, (d: { id: number }[]) => d.filter(r => r.id !== 30));
      }],
      ["not active", line("is not active"), w => {
        w.edit(`repos/${REPO}/rulesets/30`, d => ({ ...d, enforcement: "disabled" }));
      }],
      ["lacks non_fast_forward", line("lacks non_fast_forward"), w => {
        w.edit(`repos/${REPO}/rulesets/30`, d => ({ ...d, rules: d.rules.filter((r: { type: string }) => r.type !== "non_fast_forward") }));
      }],
      ["lacks deletion", line("lacks deletion"), w => {
        w.edit(`repos/${REPO}/rulesets/30`, d => ({ ...d, rules: d.rules.filter((r: { type: string }) => r.type !== "deletion") }));
      }],
      ["a bypass actor", line("has bypass actors: RepositoryRole:5"), w => {
        w.edit(`repos/${REPO}/rulesets/30`, d => ({ ...d, bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }] }));
      }],
      ["include refs/heads/*", none, w => {
        w.edit(`repos/${REPO}/rulesets/30`, d => ({ ...d, conditions: { ref_name: { include: ["refs/heads/*"], exclude: [] } } }));
      }],
      ["an exclude entry", line("has an exclude"), w => {
        w.edit(`repos/${REPO}/rulesets/30`, d => ({ ...d, conditions: { ref_name: { include: ["refs/heads/feed"], exclude: ["refs/heads/other"] } } }));
      }],
    ];
    for (const [what, message, change] of cases) {
      const w = world();
      change(w);
      const r = w.run();
      expect(r.status, `${what}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(failLines(r.stdout), what).toEqual([message]);
    }
    const beside = world();
    beside.edit(`repos/${REPO}/rulesets`, (d: { id: number }[]) => [...d, { id: 31, name: "feed branch: retired", target: "branch", enforcement: "disabled" }]);
    beside.put(`repos/${REPO}/rulesets/31`, {
      id: 31, name: "feed branch: retired", target: "branch", enforcement: "disabled",
      bypass_actors: [],
      conditions: { ref_name: { include: ["refs/heads/feed"], exclude: [] } },
      rules: [{ type: "non_fast_forward" }, { type: "deletion" }],
    });
    const b = beside.run();
    expect(b.status, b.stdout + b.stderr).toBe(0);
    expect(failLines(b.stdout)).toEqual([]);
    const ok = world().run();
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(failLines(ok.stdout)).toEqual([]);
  });

  it("CODEOWNERS must name an owner for /trust/", () => {
    const path = `repos/${REPO}/contents/.github/CODEOWNERS?ref=main`;
    const missing = world();
    missing.remove(path);
    const a = missing.run();
    expect(a.status, a.stdout + a.stderr).toBe(1);
    expect(failLines(a.stdout)).toEqual([`FAIL: cannot read ${path}`]);
    const noEntry = "FAIL: CODEOWNERS has no entry for /trust/ with an owner";
    const rejects: [string, string][] = [
      ["only *", "* @owner\n"],
      ["no owner", "/trust/\n"],
      ["commented out", "# /trust/ @owner\n"],
    ];
    for (const [what, text] of rejects) {
      const w = world();
      w.raw(path, text);
      const r = w.run();
      expect(r.status, `${what}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(failLines(r.stdout), what).toEqual([noEntry]);
    }
    for (const text of ["trust/ @a @b\n", "/trust/* @a\n", "/trust/ @a\n"]) {
      const w = world();
      w.raw(path, text);
      const r = w.run();
      expect(r.status, `${JSON.stringify(text)}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(failLines(r.stdout), text).toEqual([]);
    }
  });

  it("main's ruleset must require code-owner review, or a CODEOWNERS entry reviews nothing", () => {
    const sentence = "FAIL: no active ruleset on main requires code-owner review (a pull_request rule with require_code_owner_review true), so the CODEOWNERS entry for /trust/ reviews nothing";
    const cases: [string, (d: any) => any][] = [
      ["no pull_request rule", d => ({ ...d, rules: d.rules.filter((r: { type: string }) => r.type !== "pull_request") })],
      ["require_code_owner_review false", d => ({ ...d, rules: d.rules.map((r: any) => r.type === "pull_request" ? { ...r, parameters: { ...r.parameters, require_code_owner_review: false } } : r) })],
      ["the parameter missing", d => ({ ...d, rules: d.rules.map((r: any) => r.type === "pull_request" ? { type: "pull_request" } : r) })],
      ["the parameter on another kind of rule", d => ({ ...d, rules: [{ type: "required_linear_history", parameters: { require_code_owner_review: true } }] })],
      ["the ruleset not active", d => ({ ...d, enforcement: "disabled" })],
      ["the ruleset on another branch", d => ({ ...d, conditions: { ref_name: { include: ["refs/heads/develop"], exclude: [] } } })],
    ];
    for (const [what, change] of cases) {
      const w = world();
      w.edit(`repos/${REPO}/rulesets/10`, change);
      const r = w.run();
      expect(r.status, `${what}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(failLines(r.stdout), what).toEqual([sentence]);
    }
    // the default-branch word GitHub itself writes passes, and so does a second ruleset that requires it
    const word = world();
    word.edit(`repos/${REPO}/rulesets/10`, d => ({ ...d, conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } } }));
    expect(word.run().status).toBe(0);
    const second = world();
    second.edit(`repos/${REPO}/rulesets/10`, d => ({ ...d, rules: d.rules.filter((r: { type: string }) => r.type !== "pull_request") }));
    second.edit(`repos/${REPO}/rulesets`, list => [...list, { id: 40, name: "main: code owners", target: "branch", enforcement: "active" }]);
    second.put(`repos/${REPO}/rulesets/40`, {
      id: 40, name: "main: code owners", target: "branch", enforcement: "active", bypass_actors: [],
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [{ type: "pull_request", parameters: { require_code_owner_review: true } }],
    });
    const r = second.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it("CODEOWNERS is last-match-wins: the last /trust/ line decides, and a later catch-all takes over", () => {
    const path = `repos/${REPO}/contents/.github/CODEOWNERS?ref=main`;
    const noEntry = "FAIL: CODEOWNERS has no entry for /trust/ with an owner";
    const overridden = "FAIL: CODEOWNERS: a later line for * takes over /trust/, so its entry reviews nothing";
    const cases: [string, string, string | null][] = [
      ["a later /trust/ line with no owner", "/trust/ @a\n/trust/\n", noEntry],
      ["a later /trust/* line with no owner", "/trust/ @a\n/trust/*\n", noEntry],
      ["a later catch-all", "/trust/ @a\n* @b\n", overridden],
      ["a later /** catch-all", "/trust/ @a\n/** @b\n", overridden],
      ["the owner line last", "/trust/\n/trust/ @a\n", null],
      ["the catch-all first", "* @b\n/trust/ @a\n", null],
      ["two owner lines", "/trust/ @a\ntrust/ @b\n", null],
    ];
    for (const [what, text, expected] of cases) {
      const w = world();
      w.raw(path, text);
      const r = w.run();
      expect(failLines(r.stdout), what).toEqual(expected === null ? [] : [expected]);
      expect(r.status, `${what}: ${r.stdout}${r.stderr}`).toBe(expected === null ? 0 : 1);
    }
  });

  it("it reports every problem at once, not only the first", () => {
    const w = world();
    w.edit(`repos/${REPO}/environments`, data => {
      for (const env of data.environments) if (env.name === "feed") env.protection_rules[0].reviewers = [];
      data.environments = data.environments.filter((e: { name: string }) => e.name !== "promote");
    });
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(failLines(r.stdout)).toEqual([
      "FAIL: environment feed has no required reviewer",
      "FAIL: environment promote does not exist",
    ]);
  });
});
