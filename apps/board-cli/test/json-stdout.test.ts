// --json on every command (T-873): stdout is exactly one JSON document, and every notice goes to stderr. The hub is a
// fake that answers the shapes the agents' route returns, by method, path and action; each test names the command it
// pins. parseArgs lets --json take the word after it as a value, so the order of the flags is pinned too.
import { describe, expect, it } from "vitest";
import { parseArgs, run } from "../src/cli.ts";

const actor = { kind: "worker", name: "builder", token: "mat_w" } as const;
const task = (status: string, extra: Record<string, unknown> = {}) => ({
  key: "T-1", n: 1, title: "Ship it", description: "", status, assignee: "builder", priority: "normal", blockedReason: null,
  createdAt: 0, updatedAt: 0, stateChangedAt: 0, createdBy: { kind: "manager", name: "manager", token: "mat_x" }, rev: 5, doneAt: null, comments: 0, ...extra,
});
const event = (change: Record<string, unknown>, rev = 6) => ({ key: "T-1", rev, at: 0, actor, change });
const item = (spec: string) => ({ spec, kind: "tests", repo: null, status: "open", by: "manager" });
const briefed = { summary: "did it", decisions: "", leftOut: "nothing", limits: "none", refs: [], attested: [{ kind: "tests", how: "npm test" }], noCode: null };
const proofView = (coverage: unknown[], brief: unknown = null) => ({ rev: brief === null ? null : 7, brief, results: [], coverage, state: { line: "no brief" } });

// The hub as one stub: every call is noted (method, path, body) and answered from `answers`, keyed "METHOD path" or
// "METHOD path action"; the more specific key wins.
type Call = { method: string; path: string; body: Record<string, unknown> | undefined };
async function cli(argv: string[], answers: Record<string, unknown>, files: Record<string, string> = {}) {
  const calls: Call[] = [];
  const out: string[] = [], err: string[] = [];
  const code = await run(argv, { MORNDO_HUB: "https://hub.example.test", MORNDO_AGENT_TOKEN: "mat_stub", MORNDO_LANE: "builder" }, {
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body === undefined ? undefined : JSON.parse(init.body as string) as Record<string, unknown>;
      const method = init?.method ?? "GET";
      calls.push({ method, path, body });
      const hit = answers[`${method} ${path} ${String(body?.action)}`] ?? answers[`${method} ${path}`];
      if (hit === undefined) throw new Error(`the stub hub has no answer for ${method} ${path} ${String(body?.action)}`);
      return new Response(JSON.stringify(hit), { status: 200, headers: { "content-type": "application/json" } });
    },
    lane: async () => "builder", out: l => out.push(l), err: l => err.push(l),
    readFile: async p => { const f = files[p]; if (f === undefined) throw new Error("no such file"); return f; },
  });
  return { code, out: out.join("\n"), err: err.join("\n"), calls };
}

// stdout as one JSON document: two documents, or a sentence before one, do not parse.
const document = (out: string): unknown => JSON.parse(out);

const TASK = "/api/agent/board/tasks/T-1";
const doing = task("doing");
const hub: Record<string, unknown> = {
  [`POST ${TASK} move`]: { task: task("review"), event: event({ kind: "moved", from: "doing", to: "review" }) },
  [`POST ${TASK} comment`]: { task: task("review", { comments: 1 }), event: event({ kind: "commented", text: "ran the suite" }, 7) },
  [`POST ${TASK} assign`]: { task: doing, event: event({ kind: "assigned", from: null, to: "builder" }) },
  [`POST ${TASK} proof_list`]: { task: doing, event: event({ kind: "proof_listed", add: ["tests: x"], drop: [] }) },
  [`POST ${TASK} brief`]: { task: doing, event: event({ kind: "briefed", brief: briefed }, 8) },
  [`GET ${TASK}`]: { task: doing, events: [], proof: proofView([item("tests: x"), item("manual: y")]) },
  "GET /api/agent/board": { tasks: [doing], at: 0, lanes: ["builder"] },
  "GET /api/agent/whoami": { actor: { kind: "worker", name: "builder" } },
};

describe("--json: one JSON document on stdout, notices on stderr (T-873)", () => {
  it("review --note --json prints one document, the task after the note, though two calls went out", async () => {
    const r = await cli(["review", "T-1", "--note", "ran the suite", "--json"], hub);
    expect(r.code, r.err).toBe(0);
    expect(r.calls.filter(c => c.method === "POST").map(c => c.body?.action)).toEqual(["move", "comment"]);
    const doc = document(r.out) as { task: { comments: number }; event: { change: { kind: string } } };
    expect(doc.task.comments).toBe(1);               // the answer of the last call: the task as the note left it
    expect(doc.event.change.kind).toBe("commented");
    expect(r.err).toBe("");
  });
  it("review --note without --json still prints both changes, as before", async () => {
    const r = await cli(["review", "T-1", "--note", "ran the suite"], hub);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("T-1  Ship it");
    expect(r.out).toContain("builder doing → review");
    expect(r.out).toContain("builder commented: ran the suite");
  });
  it("proof --add --json prints the proof list as one JSON document, the notice on stderr", async () => {
    const r = await cli(["proof", "T-1", "--add", "tests: x", "--json"], hub);
    expect(r.code, r.err).toBe(0);
    expect(document(r.out)).toEqual([item("tests: x"), item("manual: y")]);
    expect(r.err).toBe("T-1 proof list updated");
  });
  it("proof --drop 1 --json prints one document too, and the dropped spec is what went out", async () => {
    const r = await cli(["proof", "T-1", "--drop", "1", "--json"], hub);
    expect(r.code, r.err).toBe(0);
    expect(document(r.out)).toEqual([item("tests: x"), item("manual: y")]);
    expect(r.calls.find(c => c.body?.action === "proof_list")?.body).toEqual({ action: "proof_list", drop: ["tests: x"] });
    expect(r.err).toBe("T-1 proof list updated");
  });
  it("proof --add without --json prints the same lines as before", async () => {
    const r = await cli(["proof", "T-1", "--add", "tests: x"], hub);
    expect(r.out.split("\n")[0]).toBe("T-1 proof list updated");
    expect(r.out).toContain("[open] tests: x");
    expect(r.err).toBe("");
  });
  it("brief with flags and --json prints one document: the event and the proof the hub holds", async () => {
    const r = await cli(["brief", "T-1", "--summary", "did it", "--left-out", "nothing", "--limit", "none", "--test", "npm test", "--json"], hub);
    expect(r.code, r.err).toBe(0);
    const doc = document(r.out) as { event: { rev: number }; proof: { coverage: unknown[] } };
    expect(doc.event.rev).toBe(8);
    expect(doc.proof.coverage).toHaveLength(2);
    expect(r.err).toBe("T-1 brief filed (rev 8)");
  });
  it("brief --file reads the wire shape from a file, and --json beside it asks for the JSON output", async () => {
    const wire = { summary: "from file", leftOut: "nothing", limits: "none" };
    const filed = await cli(["brief", "T-1", "--file", "brief.json"], hub, { "brief.json": JSON.stringify(wire) });
    expect(filed.code, filed.err).toBe(0);
    expect(filed.calls.find(c => c.body?.action === "brief")?.body).toEqual({ action: "brief", brief: wire });
    expect(filed.out).toContain("T-1 brief filed (rev 8)");
    const asJson = await cli(["brief", "T-1", "--file", "brief.json", "--json"], hub, { "brief.json": JSON.stringify(wire) });
    expect(asJson.code, asJson.err).toBe(0);
    expect((document(asJson.out) as { event: { rev: number } }).event.rev).toBe(8);
  });
  it("brief --json brief.json, the old file form, is refused in words naming --file, with nothing on stdout and nothing sent", async () => {
    const r = await cli(["brief", "T-1", "--json", "brief.json"], hub, { "brief.json": "{}" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("--file");
    expect(r.out).toBe("");
    expect(r.calls).toEqual([]);
  });
  it("brief --show --json with no brief filed prints null, not the sentence", async () => {
    const r = await cli(["brief", "T-1", "--show", "--json"], hub);
    expect(r.code, r.err).toBe(0);
    expect(document(r.out)).toBeNull();
  });
  it("assign with --proof and --json prints one document, not one per call", async () => {
    const r = await cli(["assign", "T-1", "builder", "--proof", "tests: x", "--json"], hub);
    expect(r.code, r.err).toBe(0);
    expect((document(r.out) as { task: { key: string } }).task.key).toBe("T-1");
    expect(r.err).toBe("");
  });
  it("new with --proof and --json prints one document", async () => {
    const r = await cli(["new", "Ship it", "--proof", "tests: x", "--json"], { ...hub, "POST /api/agent/board/tasks": { task: doing, event: event({ kind: "created", status: "todo" }) } });
    expect(r.code, r.err).toBe(0);
    expect((document(r.out) as { task: { key: string } }).task.key).toBe("T-1");
  });
  it("inbox --json and stale --json print one JSON array, not the sentence for an empty one", async () => {
    for (const cmd of ["inbox", "stale"]) {
      const r = await cli([cmd, "--json"], hub);
      expect(r.code, `${cmd}: ${r.err}`).toBe(0);
      expect(document(r.out), cmd).toEqual([]);
    }
  });
  it("a watched block with --json prints the task alone and leaves stderr empty", async () => {
    const r = await cli(["block", "T-1", "--why", "waits on T-2", "--on", "T-2", "--json"], {
      [`POST ${TASK} move`]: { task: task("blocked"), event: event({ kind: "moved", from: "doing", to: "blocked", reason: "waits on T-2" }) },
    });
    expect(r.code, r.err).toBe(0);
    expect((document(r.out) as { task: { key: string } }).task.key).toBe("T-1");
    expect(r.err).toBe("");
  });

  it("--json never takes the word after it: parseArgs leaves it positional, whatever the order", () => {
    expect(parseArgs(["show", "--json", "T-1"])).toEqual({ positional: ["show", "T-1"], flags: { json: true } });
    expect(parseArgs(["--json", "list"])).toEqual({ positional: ["list"], flags: { json: true } });
    expect(parseArgs(["list", "--json", "--mine"])).toEqual({ positional: ["list"], flags: { json: true, mine: true } });
  });
  it("--json before the key still means the output form: show --json T-1, block --json T-1 --why …", async () => {
    const shown = await cli(["show", "--json", "T-1"], hub);
    expect(shown.code, shown.err).toBe(0);
    expect((document(shown.out) as { task: { key: string } }).task.key).toBe("T-1");
    const moved = await cli(["review", "--json", "T-1"], hub);
    expect(moved.code, moved.err).toBe(0);
    expect((document(moved.out) as { task: { key: string } }).task.key).toBe("T-1");
    const flagged = await cli(["list", "--json", "--mine"], hub);
    expect(flagged.code, flagged.err).toBe(0);
    expect(document(flagged.out)).toHaveLength(1);
  });
});
