// morndo-board against a real hub in this process (apps/hub/test/inprocess-hub.ts): the manager's and a lane's day on
// the board as the prompt blocks describe it, the words a refusal comes back in, and the exit codes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startInProcessHub, type InProcessHub } from "../../hub/test/inprocess-hub.ts";
import { HELP, parseArgs, run } from "../src/cli.ts";
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
    const done = await asManager("done", "T-1");
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
