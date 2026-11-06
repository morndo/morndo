// --json on every command (T-873): stdout is exactly one JSON document, and every notice goes to stderr. The hub is a
// fake that answers the shapes the agents' route returns, by method, path and action; each test names the command it
// pins. --json never takes the word after it (only a path that names a .json file, brief's old file form), so the order
// of the flags is pinned too.
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
      const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
      const body = init?.body === undefined ? undefined : JSON.parse(init.body as string) as Record<string, unknown>;
      const method = init?.method ?? "GET";
      calls.push({ method, path, body });
      const hit = answers[`${method} ${path} ${String(body?.action)}`] ?? answers[`${method} ${path}`];
      if (hit === undefined) throw new Error(`the stub hub has no answer for ${method} ${path} ${String(body?.action)}`);
      const refusal = (hit as { refuse?: string }).refuse;
      return new Response(JSON.stringify(refusal === undefined ? hit : { error: refusal }), { status: refusal === undefined ? 200 : 400, headers: { "content-type": "application/json" } });
    },
    lane: async () => "builder", out: l => out.push(l), err: l => err.push(l),
    readFile: async p => { const f = files[p]; if (f === undefined) throw new Error("no such file"); return f; },
  });
  return { code, out: out.join("\n"), err: err.join("\n"), calls };
}

// stdout as one JSON document: two documents, or a sentence before one, do not parse.
const document = (out: string): unknown => JSON.parse(out);

// What the hub answers when it refuses the call.
const refuse = (error: string) => ({ refuse: error });

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
  it("brief with flags and --out-json prints one document: the proof the hub holds, the shape brief --show --json has", async () => {
    const r = await cli(["brief", "T-1", "--summary", "did it", "--left-out", "nothing", "--limit", "none", "--test", "npm test", "--out-json"], hub);
    expect(r.code, r.err).toBe(0);
    const doc = document(r.out) as { coverage: unknown[]; state: { line: string } };
    expect(doc.coverage).toHaveLength(2);
    expect(doc.state.line).toBe("no brief");
    expect(r.err).toBe("T-1 brief filed (rev 8)");
    const shown = await cli(["brief", "T-1", "--show", "--json"], { ...hub, [`GET ${TASK}`]: { task: doing, events: [event({ kind: "briefed", brief: briefed })], proof: proofView([item("tests: x"), item("manual: y")], briefed) } });
    expect(Object.keys(document(shown.out) as object).sort()).toEqual(Object.keys(doc).sort());   // one shape for the family
  });
  it("brief --file reads the wire shape from a file; --out-json beside it asks for the JSON output", async () => {
    const wire = { summary: "from file", leftOut: "nothing", limits: "none" };
    const filed = await cli(["brief", "T-1", "--file", "brief.json"], hub, { "brief.json": JSON.stringify(wire) });
    expect(filed.code, filed.err).toBe(0);
    expect(filed.calls.find(c => c.body?.action === "brief")?.body).toEqual({ action: "brief", brief: wire });
    expect(filed.out).toContain("T-1 brief filed (rev 8)");
    expect(filed.err).toBe("");
    const asJson = await cli(["brief", "T-1", "--file", "brief.json", "--out-json"], hub, { "brief.json": JSON.stringify(wire) });
    expect(asJson.code, asJson.err).toBe(0);
    expect((document(asJson.out) as { coverage: unknown[] }).coverage).toHaveLength(2);
  });
  it("brief --json <file> keeps its old meaning exactly: the file, the plain lines, one line on stderr naming --file", async () => {
    const wire = { summary: "from file", leftOut: "nothing", limits: "none" };
    for (const argv of [["brief", "T-1", "--json", "brief.json"], ["brief", "T-1", "--json=brief.json"], ["brief", "T-1", "--json", "brief.txt"]]) {
      const r = await cli(argv, hub, { "brief.json": JSON.stringify(wire), "brief.txt": JSON.stringify(wire) });
      expect(r.code, `${argv.join(" ")}: ${r.err}`).toBe(0);
      expect(r.calls.find(c => c.body?.action === "brief")?.body, argv.join(" ")).toEqual({ action: "brief", brief: wire });
      expect(r.out, argv.join(" ")).toContain("T-1 brief filed (rev 8)");
      expect(r.err, argv.join(" ")).toBe("--json <file> is deprecated for brief: use --file <file>");
    }
  });
  it("brief: --file together with --json <file> is a usage error, and so is a bare --json with the flags; nothing is sent", async () => {
    const both = await cli(["brief", "T-1", "--file", "a.json", "--json", "b.json"], hub, { "a.json": "{}", "b.json": "{}" });
    expect(both.code).toBe(2);
    expect(both.err).toContain("--file");
    expect(both.out).toBe("");
    expect(both.calls).toEqual([]);
    const bare = await cli(["brief", "T-1", "--summary", "s", "--left-out", "n", "--limit", "n", "--json"], hub);
    expect(bare.code).toBe(2);
    expect(bare.err).toContain("--out-json");
    expect(bare.calls).toEqual([]);
  });
  it("--json=<value> on any command but brief is refused in words, never taken for the output switch", async () => {
    for (const argv of [["show", "T-1", "--json=false"], ["list", "--json=x"], ["review", "T-1", "--json=1"]]) {
      const r = await cli(argv, hub);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.out, argv.join(" ")).toBe("");
      expect(r.err, argv.join(" ")).toContain("--json takes no value");
      expect(r.calls, argv.join(" ")).toEqual([]);
    }
  });
  it("an unquoted flag value in brief names its real cause: the stray word, not --file", async () => {
    const r = await cli(["brief", "T-1", "--summary", "did", "it", "--left-out", "nothing", "--limit", "none"], hub);
    expect(r.code).toBe(2);
    expect(r.err).toContain('unexpected word "it" after the task key');
    expect(r.err).toContain("quote");
    expect(r.err).not.toContain("deprecated");
    expect(r.calls).toEqual([]);
  });

  it("brief --show --json with no brief filed prints the proof view, and --from-last prints null, never the sentence", async () => {
    const r = await cli(["brief", "T-1", "--show", "--json"], hub);
    expect(r.code, r.err).toBe(0);
    expect(document(r.out)).toMatchObject({ brief: null, coverage: [item("tests: x"), item("manual: y")] });
    const last = await cli(["brief", "T-1", "--show", "--from-last", "--json"], hub);
    expect(document(last.out)).toBeNull();
    const viaOut = await cli(["brief", "T-1", "--show", "--out-json"], hub);
    expect(document(viaOut.out)).toMatchObject({ brief: null });
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

  it("review --note --json whose note is refused still prints the move on stdout, the refusal on stderr, and exits 1", async () => {
    const r = await cli(["review", "T-1", "--note", "ran it", "--json"], { ...hub, [`POST ${TASK} comment`]: refuse("too_long") });
    expect(r.code).toBe(1);
    expect((document(r.out) as { event: { change: { kind: string } } }).event.change.kind).toBe("moved");   // the task is in review: stdout says so
    expect(r.err).toContain("refused:");
  });
  it("assign --proof --json whose proof list is refused still prints the assigned task, and exits 1", async () => {
    const r = await cli(["assign", "T-1", "builder", "--proof", "tests: x", "--json"], { ...hub, [`POST ${TASK} proof_list`]: refuse("bad_item") });
    expect(r.code).toBe(1);
    expect((document(r.out) as { event: { change: { kind: string } } }).event.change.kind).toBe("assigned");
    expect(r.err).toContain("refused:");
  });
  it("new --proof --json whose proof list is refused still prints the task as filed, and exits 1", async () => {
    const r = await cli(["new", "Ship it", "--proof", "tests: x", "--json"], { ...hub, "POST /api/agent/board/tasks": { task: doing, event: event({ kind: "created", status: "todo" }) }, [`POST ${TASK} proof_list`]: refuse("bad_item") });
    expect(r.code).toBe(1);
    expect((document(r.out) as { task: { key: string } }).task.key).toBe("T-1");
    expect(r.err).toContain("refused:");
  });
  it("plain new --proof whose proof list is refused still shows the key of the task that was filed", async () => {
    const r = await cli(["new", "Ship it", "--proof", "bad"], { ...hub, "POST /api/agent/board/tasks": { task: doing, event: event({ kind: "created", status: "todo" }) }, [`POST ${TASK} proof_list`]: refuse("bad_item") });
    expect(r.code).toBe(1);
    expect(r.out).toContain("T-1  Ship it");
    expect(r.err).toContain("refused:");
  });
  it("plain new --proof, all answered, shows the task once, as before", async () => {
    const r = await cli(["new", "Ship it", "--proof", "tests: x"], { ...hub, "POST /api/agent/board/tasks": { task: doing, event: event({ kind: "created", status: "todo" }) } });
    expect(r.code, r.err).toBe(0);
    expect(r.out.split("\n").filter(l => l.startsWith("T-1  Ship it"))).toHaveLength(1);
  });
  it("a free-text word that ends in .json is the title or the comment, not a value of --json", async () => {
    const filed = await cli(["new", "--json", "Bump package.json"], { ...hub, "POST /api/agent/board/tasks": { task: doing, event: event({ kind: "created", status: "todo" }) } });
    expect(filed.code, filed.err).toBe(0);
    expect(filed.calls[0]?.body).toMatchObject({ title: "Bump package.json" });
    const said = await cli(["comment", "T-1", "--json", "regenerated tsconfig.json"], { ...hub, [`POST ${TASK} comment`]: { task: doing, event: event({ kind: "commented", text: "x" }) } });
    expect(said.code, said.err).toBe(0);
    expect(said.calls[0]?.body).toEqual({ action: "comment", text: "regenerated tsconfig.json" });
  });
  it("without --json a refused note leaves the move on stdout and the refusal on stderr, as before", async () => {
    const r = await cli(["review", "T-1", "--note", "ran it"], { ...hub, [`POST ${TASK} comment`]: refuse("too_long") });
    expect(r.code).toBe(1);
    expect(r.out).toContain("builder doing → review");
  });
  it("list --json against a stand-in forge keeps stdout one document and sends the notice to stderr", async () => {
    const r = await cli(["list", "--json"], { ...hub, "GET /api/agent/board": { tasks: [doing], at: 0, lanes: ["builder"], standIn: true } });
    expect(r.code, r.err).toBe(0);
    expect(document(r.out)).toHaveLength(1);
    expect(r.err).toBe("(proof references are read from a stand-in forge, not GitHub)");
  });

  it("parseArgs: the flags named as booleans never take the word after them; with none named every flag does, as morndo-decide has it", () => {
    expect(parseArgs(["show", "--json", "T-1"], ["json"])).toEqual({ positional: ["show", "T-1"], flags: { json: true } });
    expect(parseArgs(["list", "--json", "--mine"], ["json"])).toEqual({ positional: ["list"], flags: { json: true, mine: true } });
    expect(parseArgs(["list", "--json=x"], ["json"]).flags).toEqual({ json: "x" });
    expect(parseArgs(["show", "--json", "T-1"])).toEqual({ positional: ["show"], flags: { json: "T-1" } });
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
