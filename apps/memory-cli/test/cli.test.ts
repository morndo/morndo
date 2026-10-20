// morndo-memory against a fake hub (the hub's memory routes are another change): what each command sends to the agent
// door, what it prints, the default scope and node, the words a refusal comes back in, and the exit codes.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Note } from "@morndo/domain";
import { HELP, nodeName, parseArgs, repoScope, run, type Env, type GitPlace } from "../src/cli.ts";

const NOW = Date.UTC(2026, 9, 20, 12);
const DAY = 86_400_000;
const note = (over: Partial<Note> = {}): Note => ({
  id: "N-3" as Note["id"], kind: "fact", scope: "repo:shop-api" as Note["scope"], title: "Deploys go through make release",
  summary: "", body: "Run make release from the main branch; it tags and pushes.", tier: 3,
  provenance: { by: "lane:builder", node: "build-box", ref: "T-12", untrusted: false },
  createdAt: NOW - DAY, lastConfirmedAt: NOW - DAY, recheckAt: null, approvedAt: null, approvedBy: null,
  invalidatedAt: null, invalidatedBy: null, invalidReason: null, supersedes: null, supersededBy: null, ...over,
});

type Call = { method: string; url: URL; headers: Record<string, string>; body: unknown };
type Answer = { status: number; body: unknown } | "down" | { status: number; raw: string };
// A lane in a linked worktree of shop-api, on a host named "Build-Box.local", unless a case says otherwise.
const WORKTREE: GitPlace = { top: "/work/shop-api/.worktrees/fix-login", common: "/work/shop-api/.git" };

async function cli(argv: string[], answer: Answer | ((c: Call) => Answer) = { status: 200, body: { notes: [] } }, o: {
  env?: Env; lane?: string | null; git?: GitPlace | null; host?: string; stdin?: string;
} = {}) {
  const calls: Call[] = [];
  const out: string[] = [], err: string[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const c: Call = { method: init?.method ?? "GET", url: new URL(url), headers: { ...(init?.headers as Record<string, string>) }, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(c);
    const a = typeof answer === "function" ? answer(c) : answer;
    if (a === "down") throw new TypeError("fetch failed");
    return new Response("raw" in a ? a.raw : JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const code = await run(argv, { MORNDO_HUB: "http://hub.test:8790/", MORNDO_AGENT_TOKEN: "mat_lanes", MORNDO_LANE: "builder", ...(o.env ?? {}) }, {
    fetch: fake, lane: async () => o.lane ?? null, git: async () => (o.git === undefined ? WORKTREE : o.git), host: () => o.host ?? "Build-Box.local",
    stdin: async () => o.stdin ?? "", out: l => out.push(l), err: l => err.push(l), now: () => NOW,
  });
  return { code, out: out.join("\n"), err: err.join("\n"), calls, call: calls[0] };
}

describe("the flags", () => {
  it("--name value, --name=value, the rest positional; --json and --untrusted never take the next word", () => {
    expect(parseArgs(["search", "--json", "deploy", "--scope=user", "--limit", "5", "release"]))
      .toEqual({ positional: ["search", "deploy", "release"], flags: { json: true, scope: "user", limit: "5" } });
    expect(parseArgs(["remember", "--untrusted", "--body", "-"]).flags).toEqual({ untrusted: true, body: "-" });
  });
});

describe("search", () => {
  it("asks the agent door for the words in the repository's scope, as this lane, and prints one line per note", async () => {
    const stale = note({ id: "N-9" as Note["id"], kind: "procedure", tier: 1, approvedAt: NOW - DAY, title: "Cut a release", recheckAt: NOW - 2 * DAY });
    const r = await cli(["search", "deploy", "release", "--kind", "procedure", "--limit", "5"], { status: 200, body: { notes: [note(), stale] } });
    expect(r.code).toBe(0);
    expect(r.call?.method).toBe("GET");
    expect(`${r.call?.url.origin}${r.call?.url.pathname}`).toBe("http://hub.test:8790/api/agent/memory/search");
    expect(Object.fromEntries(r.call?.url.searchParams ?? [])).toEqual({ q: "deploy release", scope: "repo:shop-api", kind: "procedure", limit: "5" });
    expect(r.call?.headers).toMatchObject({ authorization: "Bearer mat_lanes", "x-morndo-lane": "builder" });
    expect(r.out).toBe([
      "N-3  fact       repo:shop-api  agent  Deploys go through make release",
      "N-9  procedure  repo:shop-api  owner  Cut a release  [stale]",
    ].join("\n"));
  });
  it("drops a note it can't read and says how many, and says when nothing matches", async () => {
    const r = await cli(["search", "deploy"], { status: 200, body: { notes: [note(), { id: "N-4", kind: "rumour" }] } });
    expect(r.code).toBe(0);
    expect(r.out).toBe("N-3  fact  repo:shop-api  agent  Deploys go through make release");
    expect(r.err).toBe("1 note in the answer could not be read by this morndo-memory; update it to see it");
    expect((await cli(["search", "deploy"])).out).toBe('nothing in repo:shop-api matches "deploy"');
    expect((await cli(["search"])).out).toBe("nothing in repo:shop-api yet");
  });
  it("--json prints the hub's answer as it came; outside a repository the search covers every scope", async () => {
    const answer = { notes: [note(), { id: "N-4", kind: "rumour" }] };
    const r = await cli(["search", "deploy", "--json"], { status: 200, body: answer });
    expect(JSON.parse(r.out)).toEqual(answer);
    const anywhere = await cli(["search", "deploy"], undefined, { git: null });
    expect(anywhere.call?.url.searchParams.has("scope")).toBe(false);
    expect(anywhere.out).toBe('nothing in any scope matches "deploy"');
  });
});

describe("show", () => {
  it("prints the note's line, where it came from, where it stands, and its body", async () => {
    const proc = note({ id: "N-7" as Note["id"], kind: "procedure", title: "Rotate the API key", summary: "Every 90 days.", supersedes: "N-2" as Note["id"] });
    const r = await cli(["show", "N-7"], { status: 200, body: { note: proc } });
    expect(r.code).toBe(0);
    expect(r.call?.url.pathname).toBe("/api/agent/memory/notes/N-7");
    expect(r.out).toBe([
      "N-7  procedure  repo:shop-api  agent  Rotate the API key",
      "  by lane:builder on build-box · from T-12 · written 2026-10-19 · confirmed 2026-10-19 · replaces N-2",
      "  waits for the owner's approval: no lane gets it until then",
      "  Every 90 days.",
      "",
      "Run make release from the main branch; it tags and pushes.",
    ].join("\n"));
    const gone = await cli(["show", "N-3"], { status: 200, body: { note: note({ invalidatedAt: NOW, supersededBy: "N-8" as Note["id"], invalidReason: "superseded by N-8" }) } });
    expect(gone.out).toContain("\n  replaced by N-8\n");
  });
  it("--json prints the hub's answer; a bad id is usage; an unknown note is refused in words; an unreadable note is exit 3", async () => {
    const r = await cli(["show", "N-3", "--json"], { status: 200, body: { note: note() } });
    expect(JSON.parse(r.out)).toEqual({ note: note() });
    expect(await cli(["show", "T-3"])).toMatchObject({ code: 2, err: 'which note? give its id, like N-12 (got "T-3")', calls: [] });
    expect(await cli(["show", "N-99"], { status: 404, body: { error: "not_found" } })).toMatchObject({ code: 1, err: expect.stringMatching(/^No such note for this lane/) });
    expect((await cli(["show", "N-3"], { status: 200, body: { note: { id: "N-3" } } })).code).toBe(3);
  });
});

describe("remember", () => {
  it("files a fact in the repository's scope with this node, and says it is live", async () => {
    const r = await cli(["remember", "--kind", "fact", "--title", "Deploys go through make release", "--body", "Run make release.", "--summary", "make release", "--ref", "T-12"],
      c => ({ status: 201, body: { note: note({ title: (c.body as { title: string }).title }) } }));
    expect(r.code).toBe(0);
    expect(r.call?.method).toBe("POST");
    expect(r.call?.url.pathname).toBe("/api/agent/memory/notes");
    expect(r.call?.headers["content-type"]).toBe("application/json");
    expect(r.call?.body).toEqual({ kind: "fact", scope: "repo:shop-api", title: "Deploys go through make release", body: "Run make release.", summary: "make release", ref: "T-12", node: "build-box-local" });
    expect(r.out).toBe("N-3  fact  repo:shop-api  agent  Deploys go through make release\n  live: a search finds it now");
  });
  it("--body - reads the body from stdin; --untrusted and --supersedes go to the hub as given", async () => {
    const successor = note({ id: "N-8" as Note["id"], kind: "procedure", scope: "project:payments" as Note["scope"], title: "Rotate the API key", supersedes: "N-7" as Note["id"], tier: 4, provenance: { by: "lane:builder", node: "build-box-local", ref: null, untrusted: true } });
    const r = await cli(["remember", "--kind", "procedure", "--title", "Rotate the API key", "--body", "-", "--untrusted", "--supersedes", "N-7", "--scope", "project:payments"],
      { status: 201, body: { note: successor } }, { stdin: "1. Open the console.\n2. Rotate.\n" });
    expect(r.code).toBe(0);
    expect(r.call?.body).toEqual({ kind: "procedure", scope: "project:payments", title: "Rotate the API key", body: "1. Open the console.\n2. Rotate.\n", untrusted: true, node: "build-box-local", supersedes: "N-7" });
    expect(r.out).toBe("N-8  procedure  project:payments  untrusted  Rotate the API key\n  replaces N-7\n  untrusted: no lane gets it until the owner approves it");
    const plain = await cli(["remember", "--kind", "fact", "--title", "T", "--body", "B"], { status: 201, body: { note: note() } });
    expect(plain.call?.body).not.toHaveProperty("untrusted");
    expect(plain.call?.body).not.toHaveProperty("supersedes");
  });
  it("--json prints the hub's answer; a successor of another kind or scope is refused in words", async () => {
    const r = await cli(["remember", "--kind", "fact", "--title", "T", "--body", "B", "--json"], { status: 201, body: { note: note() } });
    expect(JSON.parse(r.out)).toEqual({ note: note() });
    const other = await cli(["remember", "--kind", "fact", "--title", "T", "--body", "B", "--supersedes", "N-7"], { status: 409, body: { error: "mismatch" } });
    expect(other).toMatchObject({ code: 1, err: "A successor keeps the kind and the scope of the note it replaces; pass the same --kind and --scope." });
  });
  it("checks the hub's limits first, so the refusal names the field", async () => {
    const long = await cli(["remember", "--kind", "fact", "--title", "x".repeat(121), "--body", "B"]);
    expect(long).toMatchObject({ code: 1, err: "The title is too long: 120 characters at most.", calls: [] });
    expect(await cli(["remember", "--kind", "fact", "--title", "T", "--body", "-"], undefined, { stdin: "  \n" })).toMatchObject({ code: 1, err: "A note needs a title and a body.", calls: [] });
  });
});

describe("invalidate", () => {
  it("sends the reason and prints the reason the hub recorded", async () => {
    const r = await cli(["invalidate", "N-3", "--reason", "make release is gone"], { status: 200, body: { note: note({ invalidatedAt: NOW, invalidReason: "make release is gone" }) } });
    expect(r.code).toBe(0);
    expect(r.call?.method).toBe("POST");
    expect(r.call?.url.pathname).toBe("/api/agent/memory/notes/N-3/invalidate");
    expect(r.call?.body).toEqual({ reason: "make release is gone" });
    expect(r.out).toBe("N-3 invalidated: make release is gone");
  });
  it("another lane's note is refused (not_yours) with exit 1 and one plain line", async () => {
    const r = await cli(["invalidate", "N-3", "--reason", "wrong"], { status: 403, body: { error: "not_yours" } });
    expect(r).toMatchObject({ code: 1, out: "", err: "That note was written by another lane; only it, the manager or the owner can invalidate it." });
  });
});

describe("the default scope and node", () => {
  it("the scope is the main checkout's folder name, whatever worktree the lane is in", () => {
    expect(repoScope(WORKTREE)).toBe("repo:shop-api");
    expect(repoScope({ top: "/work/shop-api", common: "/work/shop-api/.git" })).toBe("repo:shop-api");
    expect(repoScope({ top: "/work/wt/fix-login", common: "/srv/git/shop-api.git" })).toBe("repo:shop-api");
    expect(repoScope({ top: "/work/super/vendor-lib", common: "/work/super/.git/modules/vendor-lib" })).toBe("repo:vendor-lib");
    expect(repoScope({ top: "/work/my notes", common: "/work/my notes/.git" })).toBeNull();
  });
  it("a folder name that is no scope is usage; remember outside a repository needs --scope", async () => {
    const odd = await cli(["search", "x"], undefined, { git: { top: "/work/my notes", common: "/work/my notes/.git" } });
    expect(odd).toMatchObject({ code: 2, calls: [] });
    const nowhere = await cli(["remember", "--kind", "fact", "--title", "T", "--body", "B"], undefined, { git: null });
    expect(nowhere).toMatchObject({ code: 2, err: expect.stringMatching(/^which scope\?/), calls: [] });
  });
  it("the node is MORNDO_NODE, else the host name made a node name; a bad MORNDO_NODE is usage", async () => {
    expect(nodeName({ MORNDO_NODE: "pc-2" }, () => "ignored")).toBe("pc-2");
    expect(nodeName({}, () => "Build-Box.Example.lan")).toBe("build-box-example-lan");
    expect(nodeName({}, () => `-${"a".repeat(70)}`)).toBe("a".repeat(64));
    expect(nodeName({}, () => "...")).toBeNull();
    const bad = await cli(["remember", "--kind", "fact", "--title", "T", "--body", "B"], undefined, { env: { MORNDO_NODE: "Build Box" } });
    expect(bad).toMatchObject({ code: 2, calls: [] });
    const named = await cli(["remember", "--kind", "fact", "--title", "T", "--body", "B"], { status: 201, body: { note: note() } }, { env: { MORNDO_NODE: "pc-2" } });
    expect(named.call?.body).toMatchObject({ node: "pc-2" });
  });
  it("the lane is MORNDO_LANE, else tmux's window; with neither, no lane header is sent", async () => {
    expect((await cli(["search", "x"], undefined, { env: { MORNDO_LANE: "" }, lane: "reviewer" })).call?.headers["x-morndo-lane"]).toBe("reviewer");
    expect((await cli(["search", "x"], undefined, { env: { MORNDO_LANE: "" } })).call?.headers).not.toHaveProperty("x-morndo-lane");
  });
});

describe("usage, refusals and the plumbing", () => {
  it("usage errors are exit 2 and call nothing", async () => {
    for (const argv of [
      ["frobnicate"], ["search", "x", "--kind", "rumour"], ["search", "x", "--limit", "0"], ["search", "x", "--limit", "51"], ["search", "x", "--limit", "5x"],
      ["search", "x", "--scope", "team"], ["search", "x", "--scope"], ["search", "x".repeat(201)], ["search", "x", "--json=yes"],
      ["remember", "--kind", "fact", "--body", "B"], ["remember", "--kind", "fact", "--title", "T"], ["remember", "--title", "T", "--body", "B"],
      ["remember", "--kind", "fact", "--title", "T", "--body", "B", "--supersede", "N-2"], ["remember", "--kind", "fact", "--title", "T", "--body", "B", "--supersedes", "2"],
      ["invalidate", "N-3"], ["invalidate", "--reason", "x"], ["invalidate", "N-3", "--reason", "x", "--json"], ["show"],
    ]) expect(await cli(argv), argv.join(" ")).toMatchObject({ code: 2, calls: [] });
    expect(await cli(["search", "x"], undefined, { env: { MORNDO_HUB: "" } })).toMatchObject({ code: 2, calls: [] });
  });
  it("help needs nothing; the agent door's refusals come back in words", async () => {
    const out: string[] = [];
    expect(await run(["help"], {}, { fetch, lane: async () => null, git: async () => null, host: () => "h", stdin: async () => "", out: l => out.push(l), err: () => {} })).toBe(0);
    expect(out.join("\n")).toBe(HELP);
    expect(await cli(["search", "x"], { status: 401, body: { error: "unknown_token" } })).toMatchObject({ code: 1, err: "The hub doesn't know this token (MORNDO_AGENT_TOKEN)." });
    expect(await cli(["search", "x"], { status: 400, body: { error: "lane_needed" } })).toMatchObject({ code: 1, err: "Which lane? Set MORNDO_LANE, or run inside the lane's tmux window." });
    expect(await cli(["search", "x"], { status: 404, body: { error: "no such route" } })).toMatchObject({ code: 1, err: "This hub has no memory yet; it needs an update." });
  });
  it("a hub that can't be reached, fails, or answers without JSON is exit 3", async () => {
    expect(await cli(["search", "x"], "down")).toMatchObject({ code: 3, err: "can't reach the hub at http://hub.test:8790: fetch failed" });
    expect((await cli(["search", "x"], { status: 500, body: { error: "internal error" } })).code).toBe(3);
    expect((await cli(["search", "x"], { status: 502, raw: "<html>bad gateway</html>" })).code).toBe(3);
    expect((await cli(["search", "x"], { status: 200, body: { results: [] } })).code).toBe(3);
  });
  it("cli.ts touches no process, file or network of its own: main.ts wires them", () => {
    const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from "node:|process\./);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { bin?: Record<string, string> };
    expect(pkg.bin).toEqual({ "morndo-memory": "./src/main.ts" });
  });
});
