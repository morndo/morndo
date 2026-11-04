// The block gate as the CLI shows it (T-805, B21, ADR-0041): the notice after a block the hub marked unwatched, the
// refusal once the gate is on, in words a lane can act on, and the prompts that say a block names a wait, 31 days at
// most. The hub is a fake answering the shapes the agents' route returns.
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";

// A blocked task and the event of its block, as the hub answers a change: enough for the CLI to print.
const shipIt = { key: "T-1", n: 1, title: "Ship it", description: "", status: "blocked", assignee: "builder", priority: "normal",
  blockedReason: "needs the API key", createdAt: 0, updatedAt: 0, stateChangedAt: 0, createdBy: { kind: "manager", name: "manager", token: "mat_x" }, rev: 5, doneAt: null, comments: 0 };
const actor = { kind: "worker", name: "builder", token: "mat_w" } as const;
const moved = (change: Record<string, unknown>) =>
  ({ key: "T-1", rev: 5, at: 0, actor, change: { kind: "moved", from: "doing", to: "blocked", reason: "needs the API key", ...change } });

// One call against a fetch that answers as told: what the CLI builds is noted, what it prints returned.
async function stubCli(answer: unknown, status: number, argv: string[]) {
  const sent: unknown[] = [];
  const out: string[] = [], err: string[] = [];
  const code = await run(argv, { MORNDO_HUB: "https://hub.example.test", MORNDO_AGENT_TOKEN: "mat_stub", MORNDO_LANE: "builder" }, {
    fetch: async (_url, init) => {
      sent.push(init?.body === undefined ? undefined : JSON.parse(init.body as string));
      return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
    },
    lane: async () => "builder", out: l => out.push(l), err: l => err.push(l),
  });
  return { code, out: out.join("\n"), err: err.join("\n"), sent };
}

describe("the block gate in the CLI (B21)", () => {
  it("a block whose move carries unwatched still exits 0, with the notice naming the date the gate refuses from", async () => {
    const r = await stubCli({ task: shipIt, event: moved({ unwatched: true }) }, 200, ["block", "T-1", "--why", "needs the API key"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("no watched wait: from 2026-11-12 a block without --on or --decision is refused; name one (--on T-12, #93, owner/repo#93, ny-530 or until:<time>, at most 31 days ahead)");
    expect(r.out).toContain("unless the hub's MORNDO_BLOCK_GATE says otherwise");   // the hub's setting may differ from the default date
  });
  it("a no_wait refusal exits non-zero, in words naming --on and the 31 days", async () => {
    const r = await stubCli({ error: "no_wait" }, 400, ["block", "T-1", "--why", "needs the API key"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("refused:");
    expect(r.err).toContain("--on");
    expect(r.err).toContain("31 days");
  });
  it("a block that names an until wait, answered plainly, prints no notice", async () => {
    const at = Date.now() + 24 * 3_600_000;
    const until = `until:${new Date(at).toISOString()}`;
    const r = await stubCli({ task: shipIt, event: moved({ waits: [{ kind: "time", at }] }) }, 200, ["block", "T-1", "--why", "needs the API key", "--on", until]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).not.toContain("no watched wait");
    expect(r.sent).toEqual([{ action: "move", to: "blocked", reason: "needs the API key", waits: [until] }]);
  });
  it("the worker prompt tells a lane what refusal it can mend: --on, or --decision; next: belongs to the status line, never offered as a fix for a refused morndo-board block", async () => {
    const out: string[] = [];
    expect(await run(["prompt", "--role", "worker"], {}, { fetch, lane: async () => null, out: l => out.push(l), err: () => {} })).toBe(0);
    const text = out.join("\n").replace(/\s+/g, " ");
    expect(text).toContain("--on");
    expect(text).toContain("--decision");
    expect(text).not.toMatch(/refused: end the line with/);
    expect(text).toMatch(/status line.{0,160}next: <who> by <when>/);
  });
  it("the prompts for both roles say a block names a wait, 31 days at most", async () => {
    for (const role of ["worker", "manager"] as const) {
      const out: string[] = [];
      expect(await run(["prompt", "--role", role], {}, { fetch, lane: async () => null, out: l => out.push(l), err: () => {} }), role).toBe(0);
      expect(out.join("\n"), role).toContain("31 days");
    }
  });
});
