// morndo-board against a real hub in this process (apps/hub/test/inprocess-hub.ts): the manager's and a lane's day on
// the board as the prompt blocks describe it, the words a refusal comes back in, and the exit codes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startInProcessHub, type InProcessHub } from "../../hub/test/inprocess-hub.ts";
import { GithubChecks } from "../../hub/src/adapters/github-checks.ts";
import { startFakeForge, type FakeForge } from "../../hub/test/fake-forge.ts";
import { HELP, parseArgs, run, valuesOf } from "../src/cli.ts";
import { MANAGER_PROMPT, WORKER_PROMPT } from "../src/prompt.ts";

let hub: InProcessHub;
let manager: string;
let workers: string;
beforeEach(async () => {
  hub = await startInProcessHub();
  manager = hub.agents.issue("manager", "manager").secret;
  workers = hub.agents.issue("lanes", "worker").secret;
});
afterEach(async () => { await hub.close(); });

// One call of the CLI: its lines and exit code. `lane`: what tmux would say when MORNDO_LANE is unset.
async function cli(argv: string[], token: string, o: { lane?: string | null; env?: Record<string, string> } = {}) {
  const out: string[] = [], err: string[] = [];
  const code = await run(argv, { MORNDO_HUB: hub.base, MORNDO_AGENT_TOKEN: token, ...(o.env ?? {}) }, { fetch, lane: async () => o.lane ?? null, out: l => out.push(l), err: l => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const asManager = (...argv: string[]) => cli(argv, manager);
const asBuilder = (...argv: string[]) => cli(argv, workers, { env: { MORNDO_LANE: "builder" } });

describe("the flags", () => {
  it("--name value, --name=value, bare --flag, the rest positional in order", () => {
    expect(parseArgs(["new", "Fix it", "--assign", "builder", "--priority=high", "--json", "--desc", "two words"]))
      .toEqual({ positional: ["new", "Fix it"], flags: { assign: "builder", priority: "high", json: true, desc: "two words" } });
  });
});

describe("the manager's day", () => {
  it("files a task for a lane, lists it, hands another over, and accepts what the lane offered", async () => {
    const made = await asManager("new", "Build the login page", "--desc", "Form plus tests; 14 of 14 pass", "--assign", "builder", "--priority", "high");
    expect(made.code).toBe(0);
    expect(made.out).toContain("T-1  Build the login page");
    expect(made.out).toContain("To do · assigned to builder · priority high");
    expect((await asManager("new", "Found later")).out).toContain("Backlog · nobody assigned");
    const assigned = await asManager("assign", "T-2", "reviewer");
    expect(assigned.out).toContain("manager assigned it to reviewer");
    const list = await asManager("list");
    expect(list.out).toBe("To do (2)\n  T-1    builder        Build the login page  (high)\n  T-2    reviewer       Found later");
    expect((await asBuilder("start", "T-1")).code).toBe(0);
    expect((await asBuilder("review", "T-1", "--note", "npm test: 14 passed")).code).toBe(0);
    const unchecked = await asManager("done", "T-1");
    expect(unchecked.code).toBe(1);
    expect(unchecked.err).toContain("what you checked");
    const done = await asManager("done", "T-1", "--why", "ran npm test at the lane's commit: 14 passed");
    expect(done.code).toBe(0);
    expect(done.out).toContain("Done this week");
    expect(done.out).toContain("  manager review → done");
    const shown = await asManager("show", "T-1");
    expect(shown.out).toContain("builder      commented: npm test: 14 passed");
    expect(shown.out).toContain("manager      review → done");
    expect((await asManager("whoami")).out).toBe("the manager (manager)");
  });
  it("lists by status and as JSON, and says when the board is empty", async () => {
    expect((await asManager("list")).out).toBe("the board is empty");
    await asManager("new", "A", "--assign", "builder");
    await asBuilder("start", "T-1");
    await asBuilder("block", "T-1", "--why", "needs the API key");
    const blocked = await asManager("list", "--status", "blocked");
    expect(blocked.out).toBe("Blocked (1)\n  T-1    builder        A  [blocked: needs the API key]");
    const json = await asManager("list", "--json");
    expect(JSON.parse(json.out)).toMatchObject([{ key: "T-1", status: "blocked" }]);
    expect((await asManager("list", "--status", "sideways")).code).toBe(2);
  });
  it("list marks an orphan task, in text and in --json", async () => {
    // B2: a to do task whose lane the fleet no longer lists. A hub of its own, whose board flags "ghost" as gone.
    const orphanHub = await startInProcessHub({ orphans: ts => ts.filter(t => t.assignee === "ghost").map(t => t.key) });
    try {
      const here = orphanHub.agents.issue("manager", "manager").secret;
      const out: string[] = [], err: string[] = [];
      const call = async (argv: string[]) => {
        const mark = out.length;
        const code = await run(argv, { MORNDO_HUB: orphanHub.base, MORNDO_AGENT_TOKEN: here }, { fetch, lane: async () => null, out: l => out.push(l), err: l => err.push(l) });
        return { code, out: out.slice(mark).join("\n") };
      };
      await call(["new", "A", "--assign", "builder"]);
      await call(["new", "B", "--assign", "ghost"]);
      const list = await call(["list"]);
      expect(list.out.split("\n").find(l => l.includes("T-1"))).toBe("  T-1    builder        A");
      expect(list.out.split("\n").find(l => l.includes("T-2"))).toBe("  T-2    ghost          B  [orphan: its lane is gone; reassign it]");
      expect(list.out).not.toContain("[lane not running]");
      const json = JSON.parse((await call(["list", "--json"])).out) as { key: string; orphan?: boolean }[];
      expect(json.find(t => t.key === "T-2")?.orphan).toBe(true);
      expect("orphan" in (json.find(t => t.key === "T-1") ?? {})).toBe(false);
    } finally { await orphanHub.close(); }
  });
});

describe("a lane's day", () => {
  it("sees its own tasks, starts one, is refused a second, blocks, resumes, offers for review, and can't mark done", async () => {
    await asManager("new", "A", "--assign", "builder");
    await asManager("new", "B", "--assign", "builder");
    await asManager("new", "C", "--assign", "reviewer");
    const mine = await asBuilder("list", "--mine");
    expect(mine.out).toContain("T-1");
    expect(mine.out).toContain("T-2");
    expect(mine.out).not.toContain("T-3");
    expect((await asBuilder("start", "T-1")).out).toContain("In progress");
    const second = await asBuilder("start", "T-2");
    expect(second).toMatchObject({ code: 1, err: "refused: T-1 is already in progress for this lane; finish, block or put it back first" });
    expect((await asBuilder("block", "T-1")).code).toBe(2);
    expect((await asBuilder("block", "T-1", "--why", "waiting on the API key")).out).toContain("Blocked (waiting on the API key)");
    expect((await asBuilder("resume", "T-1")).out).toContain("In progress");
    expect((await asBuilder("review", "T-1")).out).toContain("In review");
    const done = await asBuilder("done", "T-1");
    expect(done.code).toBe(1);
    expect(done.err).toMatch(/^refused: a task can't move from review like that; a lane moves its own tasks/);
    const theirs = await asBuilder("start", "T-3");
    expect(theirs).toMatchObject({ code: 1, err: "refused: that task is assigned to someone else" });
    expect((await asBuilder("assign", "T-3", "builder")).err).toBe("refused: only the manager (or the principal) may do that");
    const proposal = await asBuilder("new", "Found a bug", "--assign", "builder");
    expect(proposal.out).toContain("Backlog · nobody assigned");
  });
  it("the lane's name comes from MORNDO_LANE, else from tmux, else the call is refused with what to set", async () => {
    await asManager("new", "A", "--assign", "reviewer");
    expect((await cli(["whoami"], workers, { lane: "reviewer" })).out).toBe("the lane reviewer");
    expect((await cli(["start", "T-1"], workers, { lane: "reviewer" })).code).toBe(0);
    const nobody = await cli(["list", "--mine"], workers);
    expect(nobody).toMatchObject({ code: 1, err: "refused: which lane? set MORNDO_LANE, or run inside the lane's tmux window" });
  });
  it("show gives the task with its history; a comment keeps its lines; an unknown task says so", async () => {
    await asManager("new", "A", "--desc", "Line one\nLine two", "--assign", "builder");
    await asBuilder("comment", "T-1", "Ran it:\n  ok");
    const shown = await asBuilder("show", "T-1");
    expect(shown.out).toContain("  Line one\n  Line two");
    expect(shown.out).toContain("commented:\n      Ran it:\n        ok");
    expect(await asBuilder("show", "T-9")).toMatchObject({ code: 1, err: "refused: no such task" });
    expect((await asBuilder("show", "nope")).code).toBe(2);
  });
  it("the record names the console's change and the board's own moves, with the rule and the lane (ADR-0032)", async () => {
    await asManager("new", "A");
    expect(hub.board.act("T-1", { action: "assign", to: "builder" }, { kind: "console" }).ok).toBe(true);    // lanes start --task
    const rev = hub.board.task("T-1")?.task.rev ?? 0;
    expect(hub.board.follow("T-1", { to: "doing", reason: null, rule: "D4" }, "builder", rev).ok).toBe(true);
    const done = hub.board.follow("T-1", { to: "review", reason: "STATUS: DONE npm test: 14 passed", rule: "D1" }, "builder", rev + 1);
    expect(done.ok).toBe(true);
    const shown = await asManager("show", "T-1");
    expect(shown.out).toContain("console      assigned it to builder");
    expect(shown.out).toContain("board (D4, builder) todo → doing");
    expect(shown.out).toContain("board (D1, builder) doing → review: STATUS: DONE npm test: 14 passed");
    expect((await asManager("list")).out).toBe("In review (1)\n  T-1    builder        A\n      proof: no brief");   // a review without a brief says so (B15)
  });
});

// B11: a task's PR merged is a record on the task, and Done waits for it to be live on every node. This hub answers
// liveness as two nodes' builds would: pc's build doesn't carry the merge (on abc1234), srv01 names none. All names
// synthetic, as everywhere here.
describe("a task's merge and the done gate (B11)", () => {
  let gate: InProcessHub;
  let gateManager: string;
  let gateBuilder: string;
  beforeEach(async () => {
    gate = await startInProcessHub({ liveness: () => ({ live: false, blockers: [{ node: "pc", on: "abc1234" }, { node: "srv01", on: null }] }) });
    gateManager = gate.agents.issue("manager", "manager").secret;
    gateBuilder = gate.agents.issue("lanes", "worker").secret;
  });
  afterEach(async () => { await gate.close(); });

  async function gateCli(argv: string[], token: string, laneName: string | null) {
    const out: string[] = [], err: string[] = [];
    const code = await run(argv, { MORNDO_HUB: gate.base, MORNDO_AGENT_TOKEN: token, ...(laneName ? { MORNDO_LANE: laneName } : {}) },
      { fetch, lane: async () => null, out: l => out.push(l), err: l => err.push(l) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }
  const managerSays = (...argv: string[]) => gateCli(argv, gateManager, null);
  const builderSays = (...argv: string[]) => gateCli(argv, gateBuilder, "builder");

  // One task through to review, its PR merged as abc1234: what the done gate judges.
  async function taskMerged() {
    await managerSays("new", "Ship it", "--assign", "builder");
    await builderSays("start", "T-1");
    await builderSays("review", "T-1");
    await managerSays("merged", "T-1", "abc1234");
  }

  // One call against a fetch that notes what was sent and answers as told: for the body the CLI builds.
  async function stubCli(answer: Record<string, unknown>, argv: string[]) {
    const sent: { path: string; body: unknown }[] = [];
    const out: string[] = [], err: string[] = [];
    const code = await run(argv, { MORNDO_HUB: "https://hub.example.test", MORNDO_AGENT_TOKEN: "mat_stub" }, {
      fetch: async (url, init) => {
        sent.push({ path: new URL(url).pathname, body: init?.body === undefined ? undefined : JSON.parse(init.body as string) });
        return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
      },
      lane: async () => null, out: l => out.push(l), err: l => err.push(l),
    });
    return { code, out: out.join("\n"), err: err.join("\n"), sent };
  }
  // A task and the event of its merge, as the hub answers a change: enough for the CLI to print.
  const shipIt = { key: "T-1", n: 1, title: "Ship it", description: "", status: "review", assignee: "builder", priority: "normal", blockedReason: null, createdAt: 0, updatedAt: 0, stateChangedAt: 0, createdBy: { kind: "manager", name: "manager", token: "mat_x" }, rev: 4, doneAt: null, comments: 0 };
  const mergedIn = { key: "T-1", rev: 4, at: 0, actor: { kind: "manager", name: "manager", token: "mat_x" }, change: { kind: "merged", repo: "morndo/morndo", sha: "abc1234" } };
  const actor = { kind: "manager", name: "manager", token: "mat_x" } as const;

  it("merged records the commit, default repo morndo/morndo", async () => {
    const mine = await stubCli({ task: shipIt, event: mergedIn }, ["merged", "T-1", "abc1234"]);
    expect(mine.code).toBe(0);
    expect(mine.out).toContain("recorded its merge: morndo/morndo abc1234");
    expect(mine.sent).toEqual([{ path: "/api/agent/board/tasks/T-1", body: { action: "merged", sha: "abc1234" } }]);
    const other = await stubCli({ task: shipIt, event: mergedIn }, ["merged", "T-1", "abc1234", "--repo", "acme/other"]);
    expect(other.sent).toEqual([{ path: "/api/agent/board/tasks/T-1", body: { action: "merged", sha: "abc1234", repo: "acme/other" } }]);
    await managerSays("new", "Ship it", "--assign", "builder");
    expect(await managerSays("merged", "T-1")).toMatchObject({ code: 2, err: "usage: morndo-board merged T-12 <sha> [--repo owner/name]" });
    expect(await managerSays("merged", "T-1", "abc1234", "--repo")).toMatchObject({ code: 2, err: "usage: morndo-board merged T-12 <sha> [--repo owner/name]" });
  });
  it("unmerged clears a record, and its usage needs a sha", async () => {
    const cleared = await stubCli({ task: shipIt, event: { ...mergedIn, change: { kind: "unmerged", repo: "morndo/morndo", sha: "abc1234" } } }, ["unmerged", "T-1", "abc1234"]);
    expect(cleared.code).toBe(0);
    expect(cleared.out).toContain("cleared its merge record: morndo/morndo abc1234");
    expect(cleared.sent).toEqual([{ path: "/api/agent/board/tasks/T-1", body: { action: "unmerged", sha: "abc1234" } }]);
    await taskMerged();
    const again = await managerSays("unmerged", "T-1", "abc1234");
    expect(again.code).toBe(0);
    expect(again.out).toContain("cleared its merge record: morndo/morndo abc1234");
    expect((await managerSays("show", "T-1")).out).not.toContain("Merged:");
    expect((await managerSays("list")).out).not.toContain("merged, not live");
    expect(await managerSays("unmerged", "T-1")).toMatchObject({ code: 2, err: "usage: morndo-board unmerged T-12 <sha> [--repo owner/name]" });
    expect(await managerSays("unmerged", "T-1", "abc1234", "--repo")).toMatchObject({ code: 2, err: "usage: morndo-board unmerged T-12 <sha> [--repo owner/name]" });
  });
  it("done is refused while the merge is not live", async () => {
    await taskMerged();
    const refused = await managerSays("done", "T-1", "--why", "ran the checks at the merge");
    expect(refused).toMatchObject({ code: 1, err: 'refused: its merge is not live: merged, not live: pc on abc1234, srv01 unknown; if you accept it anyway: done T-12 --why "…" --not-live "<reason>"' });
  });
  it("done --not-live sends the reason", async () => {
    const event = { key: "T-1", rev: 5, at: 0, actor, change: { kind: "moved", from: "review", to: "done", reason: "ran the checks", notLive: "srv01 is retiring this week" } };
    const cli = await stubCli({ task: { ...shipIt, status: "done" }, event }, ["done", "T-1", "--why", "ran the checks", "--not-live", "srv01 is retiring this week"]);
    expect(cli.code).toBe(0);
    expect(cli.sent).toEqual([{ path: "/api/agent/board/tasks/T-1", body: { action: "move", to: "done", reason: "ran the checks", notLive: "srv01 is retiring this week" } }]);
    await taskMerged();
    expect(await managerSays("done", "T-1", "--why", "checked", "--not-live")).toMatchObject({ code: 2, err: "--not-live takes the reason it is accepted before it is live" });
  });
  it("show prints the merge and its label", async () => {
    await taskMerged();
    const shown = await managerSays("show", "T-1");
    expect(shown.out).toContain("Merged: morndo/morndo abc1234 (by manager, ");
    expect(shown.out).toContain("merged, not live: pc on abc1234, srv01 unknown");
  });
  it("show prints the override", async () => {
    await taskMerged();
    await managerSays("done", "T-1", "--why", "ran the checks", "--not-live", "srv01 is retiring this week");
    const shown = await managerSays("show", "T-1");
    expect(shown.out).toContain("Accepted as done while not live: srv01 is retiring this week");
    expect(shown.out).toContain("review → done: ran the checks (done while not live: srv01 is retiring this week)");
  });
  it("list marks a task that merged but is not live", async () => {
    await taskMerged();
    expect((await managerSays("list")).out).toContain("Ship it  [merged, not live: pc on abc1234, srv01 unknown]");
    await managerSays("done", "T-1", "--why", "ran the checks", "--not-live", "srv01 is retiring this week");
    expect((await managerSays("list")).out).toContain("  (done not live: srv01 is retiring this week)");
  });
  it("list leaves tasks without a merge as they were", async () => {
    await managerSays("new", "A", "--assign", "builder");
    await builderSays("start", "T-1");
    await builderSays("review", "T-1");
    expect((await managerSays("list")).out).toBe("In review (1)\n  T-1    builder        A\n      proof: no brief");
    expect(JSON.parse((await managerSays("list", "--json")).out)).toMatchObject([{ key: "T-1", status: "review" }]);
  });
  it("bad_sha and bad_repo are explained", async () => {
    await managerSays("new", "Ship it", "--assign", "builder");
    expect(await managerSays("merged", "T-1", "nope")).toMatchObject({ code: 1, err: "refused: that isn't a commit hash (7 to 40 hex characters)" });
    expect(await managerSays("merged", "T-1", "abc1234", "--repo", "acme")).toMatchObject({ code: 1, err: "refused: that isn't a repo name (owner/name)" });
  });
  it("too_many and no_commit are explained", async () => {
    await managerSays("new", "Ship it", "--assign", "builder");
    for (let i = 0; i < 5; i++) expect((await managerSays("merged", "T-1", String(i).repeat(40))).code).toBe(0);
    expect(await managerSays("merged", "T-1", "a".repeat(40))).toMatchObject({ code: 1, err: "refused: a task holds at most 5 merge records; clear a wrong one first: unmerged T-12 <sha>" });
    const err: string[] = [];
    const code = await run(["merged", "T-1", "abc1234"], { MORNDO_HUB: "https://hub.example.test", MORNDO_AGENT_TOKEN: "mat_stub" }, {
      fetch: async () => new Response(JSON.stringify({ error: "no_commit" }), { status: 409, headers: { "content-type": "application/json" } }),
      lane: async () => null, out: () => {}, err: l => err.push(l),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toBe("refused: the hub's checkout doesn't have that commit yet; ask the manager to record it, or update the checkout");
  });
  it("merged then done: refused while not live, done once the reason is given", async () => {
    await taskMerged();
    expect((await managerSays("done", "T-1", "--why", "ran the checks")).code).toBe(1);
    const done = await managerSays("done", "T-1", "--why", "ran the checks", "--not-live", "srv01 is retiring this week");
    expect(done.code).toBe(0);
    expect(done.out).toContain("Done this week");
    expect(gate.board.task("T-1")).toMatchObject({ merged: { merges: [{ repo: "morndo/morndo", sha: "abc1234", override: "srv01 is retiring this week" }] } });
  });
});

describe("the prompt and the plumbing", () => {
  it("prints the instructions block for a role, needing no hub", async () => {
    const out: string[] = [];
    expect(await run(["prompt", "--role", "worker"], {}, { fetch, lane: async () => null, out: l => out.push(l), err: () => {} })).toBe(0);
    expect(out.join("\n")).toBe(WORKER_PROMPT.trimEnd());
    expect(MANAGER_PROMPT).toContain("morndo-board done T-12");
    expect(WORKER_PROMPT).toContain("You can't mark a task done");
    expect(await run(["prompt"], {}, { fetch, lane: async () => null, out: () => {}, err: () => {} })).toBe(2);
  });
  it("help needs nothing; a wrong token is refused in one line; a hub that can't be reached is exit 3", async () => {
    expect((await cli(["help"], "")).out).toBe(HELP);
    expect((await cli(["list"], "", { env: { MORNDO_HUB: "" } })).code).toBe(2);
    expect(await cli(["list"], "mat_wrong")).toMatchObject({ code: 1, err: "refused: the hub doesn't know this token (MORNDO_AGENT_TOKEN)" });
    const gone = await run(["list"], { MORNDO_HUB: "http://127.0.0.1:1", MORNDO_AGENT_TOKEN: "mat_x" }, { fetch, lane: async () => null, out: () => {}, err: () => {} });
    expect(gone).toBe(3);
  });
});

describe("the brief and the proof (B13 to B16)", () => {
  // A hub with the proof gate on and a local forge to check references against: what the CLI's lanes see, driven the
  // way the prompts tell them to work. Everything the forge answers was registered here; nothing leaves this process.
  const PR = "morndo/morndo#42@3e9d1a7";
  const CI = "morndo/morndo@3e9d1a7:ci,lint";
  const FULL = "3e9d1a7c5b2f4a8e9d0c1b2a3f4e5d6c7b8a9f01";
  let proofHub: InProcessHub;
  let fakeForge: FakeForge;
  let proofManager: string;
  let proofBuilder: string;
  let files: Map<string, string>;     // what --json reads, standing in for the disk
  beforeEach(async () => {
    fakeForge = await startFakeForge();
    proofHub = await startInProcessHub({ forge: new GithubChecks({ baseUrl: fakeForge.base }), proofMode: "on" });
    proofManager = proofHub.agents.issue("manager", "manager").secret;
    proofBuilder = proofHub.agents.issue("lanes", "worker").secret;
    files = new Map();
  });
  afterEach(async () => { await proofHub.proof.idle(); await proofHub.close(); await fakeForge.close(); });

  async function proofCli(argv: string[], token: string, laneName: string | null) {
    const out: string[] = [], err: string[] = [];
    const code = await run(argv, { MORNDO_HUB: proofHub.base, MORNDO_AGENT_TOKEN: token, ...(laneName ? { MORNDO_LANE: laneName } : {}) },
      { fetch, lane: async () => null, out: l => out.push(l), err: l => err.push(l),
        readFile: p => { const c = files.get(p); return c === undefined ? Promise.reject(new Error("no such file")) : Promise.resolve(c); } });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }
  const managerSays = (...argv: string[]) => proofCli(argv, proofManager, null);
  const builderSays = (...argv: string[]) => proofCli(argv, proofBuilder, "builder");

  // One task of this lane's in review: the state a brief is filed from (revs: created 1, doing 2, review 3).
  const atReview = async (key: string, title: string) => {
    await managerSays("new", title, "--assign", "builder");
    await builderSays("start", key);
    await builderSays("review", key);
  };
  // The forge answering green: the pull request of the brief's references, open at the head the refs point at, both
  // of its checks a success.
  const greenForge = () => {
    fakeForge.pr("morndo/morndo", 42, { head: FULL });
    fakeForge.runs("morndo/morndo", FULL, [
      { id: 1, name: "ci", status: "completed", conclusion: "success" },
      { id: 2, name: "lint", status: "completed", conclusion: "success" },
    ]);
  };
  const briefCmd = (key: string, ...extra: string[]) => ["brief", key, "--summary", "Totals row rounds to cents", "--left-out", "nothing", "--limit", "locale formats not covered", ...extra];
  // One task in review with a green brief: what a checked `done` follows.
  const greenBriefed = async (key: string, title: string) => {
    greenForge();
    await atReview(key, title);
    await builderSays(...briefCmd(key, "--pr", PR, "--ci", CI));
    await proofHub.proof.idle();
  };

  it("brief T-12 --pr … --ci … files one action and prints the ref states", async () => {
    greenForge();
    await atReview("T-1", "Ship the totals row");
    const filed = await builderSays(...briefCmd("T-1", "--pr", PR, "--ci", CI));
    expect(filed.code).toBe(0);
    expect(filed.out).toContain("T-1 brief filed (rev 4)");
    await proofHub.proof.idle();                       // the checks the filing set off land
    for (const shown of [await builderSays("show", "T-1"), await builderSays("brief", "T-1", "--show")]) {
      expect(shown.out).toContain(`✓ ${PR}`);
      expect(shown.out).toContain("proof: 2 of 2 green");
    }
    expect((proofHub.board.task("T-1")?.events ?? []).filter(e => e.change.kind === "briefed")).toHaveLength(1);
  });

  it("a ref missing its repository exits 1 with the grammar", async () => {
    await atReview("T-1", "Ship the totals row");
    const refused = await builderSays(...briefCmd("T-1", "--pr", "#42@3e9d1a7"));
    expect(refused).toMatchObject({ code: 1, err: `refused: a reference must be whole: #42@3e9d1a7: a reference is owner/repo#PR@sha or owner/repo@sha:check,check` });
  });

  it("brief repeats --pr and --ci and takes --test, --manual, --ui, --data, --infra and --no-code", async () => {
    greenForge();
    await atReview("T-1", "Ship the totals row");
    // valuesOf itself: every --name value and every --name=value, in the order the command line gave them
    expect(valuesOf(["brief", "T-1", "--pr", "a/b#1@1111111", "--pr=c/d#2@2222222", "--pr", "e/f#3@3333333"], "pr"))
      .toEqual(["a/b#1@1111111", "c/d#2@2222222", "e/f#3@3333333"]);
    const filed = await builderSays(...briefCmd("T-1",
      "--pr", PR, "--pr", "morndo/morndo#43@3e9d1a7",
      "--ci", CI, "--ci", "morndo/morndo@3e9d1a7:*",
      "--test", "npm test: 48 passed, 0 failed", "--manual", "read the diff", "--ui", "the totals row renders",
      "--data", "a sample of 30 rows", "--infra", "restarted the hub",
      "--decision", "round at display, not at sum",
    ));
    expect(filed.code).toBe(0);
    expect(proofHub.proof.view("T-1")?.brief).toEqual({
      summary: "Totals row rounds to cents",
      decisions: "round at display, not at sum",
      leftOut: "nothing",
      limits: "locale formats not covered",
      refs: [PR, "morndo/morndo#43@3e9d1a7", CI, "morndo/morndo@3e9d1a7:*"],
      attested: [
        { kind: "tests", how: "npm test: 48 passed, 0 failed" },
        { kind: "manual", how: "read the diff" },
        { kind: "ui", how: "the totals row renders" },
        { kind: "data", how: "a sample of 30 rows" },
        { kind: "infra", how: "restarted the hub" },
      ],
      noCode: "",
    });
    // --no-code stands in for the references: a brief of its own
    const memo = await builderSays("brief", "T-1", "--summary", "A look at the numbers", "--left-out", "nothing", "--limit", "none known", "--no-code", "an analysis, no code changed");
    expect(memo.code).toBe(0);
    expect(proofHub.proof.view("T-1")?.brief).toMatchObject({ refs: [], noCode: "an analysis, no code changed" });
  });

  it("brief --json reads the wire shape from a file", async () => {
    await atReview("T-1", "Ship the totals row");
    const wire = {
      summary: "Totals row rounds to cents", decisions: "round at display, not at sum", leftOut: "nothing", limits: "locale formats not covered",
      refs: [PR], attested: [{ kind: "tests", how: "npm test: 48 passed, 0 failed" }],
    };
    files.set("brief.json", JSON.stringify(wire));
    const filed = await builderSays("brief", "T-1", "--json", "brief.json");
    expect(filed.code).toBe(0);
    expect(filed.out).toContain("T-1 brief filed (rev 4)");
    expect(proofHub.proof.view("T-1")?.brief).toEqual({ ...wire, noCode: "" });
    // a file that is not there or not JSON is a usage error, never a hub call
    files.set("broken.json", "{not json");
    expect(await builderSays("brief", "T-1", "--json", "broken.json")).toMatchObject({ code: 2 });
    const missing = await builderSays("brief", "T-1", "--json", "missing.json");
    expect(missing).toMatchObject({ code: 2 });
    expect(missing.err).toContain("usage:");
  });

  it("brief without its required flags is a usage error naming the flag", async () => {
    await atReview("T-1", "Ship the totals row");
    expect(HELP).toContain('brief T-12 --summary "…" --left-out "…" --limit "…" [--decision "…"] [--pr owner/repo#42@sha]… [--ci owner/repo@sha:ci,lint]… [--test "…"]… [--manual|--ui|--data|--infra "…"]… [--no-code "…"] | --json brief.json');
    expect(HELP).toContain("brief T-12 --show [--json] [--from-last]   the brief the hub holds and how each reference checked out");
    expect(HELP).toContain('done T-12 --why "…" [--not-live "…"] [--proof-override "<reason>"]');
    const noSummary = await builderSays("brief", "T-1", "--left-out", "nothing", "--limit", "none known");
    expect(noSummary).toMatchObject({ code: 2 });
    expect(noSummary.err).toContain("--summary");
    const noLeftOut = await builderSays("brief", "T-1", "--summary", "Totals row rounds to cents", "--limit", "none known");
    expect(noLeftOut).toMatchObject({ code: 2 });
    expect(noLeftOut.err).toContain("--left-out");
    const noLimit = await builderSays("brief", "T-1", "--summary", "Totals row rounds to cents", "--left-out", "nothing");
    expect(noLimit).toMatchObject({ code: 2 });
    expect(noLimit.err).toContain("--limit");
  });

  it("brief --show prints the brief and --show --json prints it as JSON; --from-last prints a stale brief after the task went back to doing", async () => {
    greenForge();
    await atReview("T-1", "Ship the totals row");
    await builderSays(...briefCmd("T-1", "--pr", PR, "--ci", CI));
    await proofHub.proof.idle();
    const shown = await builderSays("brief", "T-1", "--show");
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("  Proof: proof: 2 of 2 green");
    expect(shown.out).toContain("    Brief (rev 4): Totals row rounds to cents");
    expect(shown.out).toContain(`    ✓ ${PR} green`);
    const asJson = await builderSays("brief", "T-1", "--show", "--json");
    expect(JSON.parse(asJson.out)).toMatchObject({ rev: 4, state: { kind: "verified", green: 2, total: 2, accepts: true, line: "proof: 2 of 2 green" } });
    // the task goes back to doing: the brief no longer counts, but the next round starts from it
    await managerSays("move", "T-1", "doing");
    expect((await builderSays("brief", "T-1", "--show")).out).toContain("proof: no brief");
    const fromLast = await builderSays("brief", "T-1", "--show", "--from-last");
    expect(JSON.parse(fromLast.out)).toEqual({
      summary: "Totals row rounds to cents", decisions: "", leftOut: "nothing", limits: "locale formats not covered",
      refs: [PR, CI], attested: [], noCode: "",
    });
    await managerSays("new", "Another one");
    expect((await builderSays("brief", "T-2", "--show")).out).toContain("no brief filed");
  });

  it("--why naming an unverified sha prints the warning and still sends", async () => {
    await greenBriefed("T-1", "Ship the totals row");
    const warned = await managerSays("done", "T-1", "--why", "ran the checks at 9f8e7d6: 48 passed");
    expect(warned.code).toBe(0);
    expect(warned.err).toBe(`warning: --why names 9f8e7d6, which the board did not verify; verified: ${PR}, ${CI}`);
    expect(proofHub.board.task("T-1")?.task.status).toBe("done");
    // the same done naming the sha the board did verify prints nothing
    await greenBriefed("T-2", "Ship the other row");
    const quiet = await managerSays("done", "T-2", "--why", "ran the checks at 3e9d1a7: 48 passed");
    expect(quiet).toMatchObject({ code: 0, err: "" });
  });

  it("--why with a #n that no verified pull request has warns, and a verified #n does not", async () => {
    await greenBriefed("T-1", "Ship the totals row");
    const warned = await managerSays("done", "T-1", "--why", "PR #43 looked green");
    expect(warned.code).toBe(0);
    expect(warned.err).toBe(`warning: --why names #43, which the board did not verify; verified: ${PR}, ${CI}`);
    await greenBriefed("T-2", "Ship the other row");
    const quiet = await managerSays("done", "T-2", "--why", "PR #42 is green");
    expect(quiet).toMatchObject({ code: 0, err: "" });
  });

  it("done --proof-override sends the reason and the event records it", async () => {
    fakeForge.pr("morndo/morndo", 42, { head: FULL });
    fakeForge.runs("morndo/morndo", FULL, [
      { id: 1, name: "ci", status: "completed", conclusion: "success" },
      { id: 2, name: "lint", status: "completed", conclusion: "failure" },
    ]);
    await atReview("T-1", "Ship the totals row");
    await builderSays(...briefCmd("T-1", "--pr", PR, "--ci", CI));
    await proofHub.proof.idle();
    const refused = await managerSays("done", "T-1", "--why", "read the diff");
    expect(refused).toMatchObject({ code: 1, err: `refused: done is held: proof: 1 of 2 green · ✗ ${CI} "lint" failed; to accept it anyway: done T-12 --why "…" --proof-override "<what you looked at instead>"` });
    expect(proofHub.board.task("T-1")?.task.status).toBe("review");
    const accepted = await managerSays("done", "T-1", "--why", "read the diff", "--proof-override", "read the diff at the merge; the lint failure is the known flake");
    expect(accepted.code).toBe(0);
    expect(proofHub.board.task("T-1")?.task.status).toBe("done");
    const shown = await managerSays("show", "T-1");
    expect(shown.out).toContain("(proof: proof: 1 of 2 green · ✗ morndo/morndo@3e9d1a7:ci,lint \"lint\" failed; override: read the diff at the merge; the lint failure is the known flake [mode on])");
  });

  it("list prints the proof line under a task in review; show prints the Proof block with attested items marked as the lane's word", async () => {
    greenForge();
    await atReview("T-1", "Ship the totals row");
    await builderSays(...briefCmd("T-1", "--pr", PR, "--ci", CI, "--test", "npm test: 48 passed, 0 failed", "--ui", "the totals row renders"));
    await proofHub.proof.idle();
    const listed = await managerSays("list");
    expect(listed.out).toContain("In review (1)");
    expect(listed.out.split("\n").find(l => l.includes("proof: 2 of 2 green"))).toBe("      proof: 2 of 2 green");
    const shown = await managerSays("show", "T-1");
    expect(shown.out).toContain("  Proof: proof: 2 of 2 green");
    expect(shown.out).toContain(`    ✓ ${PR} green`);
    expect(shown.out).toContain(`    ✓ ${CI} green`);
    expect(shown.out).toContain("    Attested (tests): npm test: 48 passed, 0 failed  (the lane's word, not checked)");
    expect(shown.out).toContain("    Attested (ui): the totals row renders  (the lane's word, not checked)");
    expect(JSON.parse((await managerSays("show", "T-1", "--json")).out).proof).toMatchObject({ rev: 4, state: { kind: "verified", green: 2, total: 2 } });
  });

  it("a bare --proof-override is a usage error", async () => {
    await atReview("T-1", "Ship the totals row");
    const bare = await managerSays("done", "T-1", "--why", "checked", "--proof-override");
    expect(bare).toMatchObject({ code: 2 });
    expect(bare.err).toContain("--proof-override takes the reason");
  });
});
