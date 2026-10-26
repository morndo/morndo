// morndo-decide against a hub in this process: lint refuses the blank, the example files, a lane's brief is a draft
// the manager forwards, and the exit codes match the board CLI (0 done, 1 refused, 2 usage, 3 unreachable).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startInProcessHub, type InProcessHub } from "../../hub/test/inprocess-hub.ts";
import { run, type Io } from "../src/decide.ts";

const NOW = new Date(2026, 9, 1, 12).getTime();
const doc = readFileSync(new URL("../../../docs/agents/decision-requests.md", import.meta.url), "utf8");
const example = () => {
  const at = doc.indexOf("## An example");
  const open = doc.indexOf("```markdown\n", at);
  const close = doc.indexOf("\n```", open + 12);
  return doc.slice(open + "```markdown\n".length, close + 1);
};

let hub: InProcessHub;
let manager: string;
let workers: string;
beforeEach(async () => {
  hub = await startInProcessHub({ now: () => NOW });
  manager = hub.agents.issue("manager", "manager").secret;
  workers = hub.agents.issue("lanes", "worker").secret;
});
afterEach(async () => { await hub.close(); });

async function cli(argv: string[], token: string | null, o: { lane?: string; files?: Record<string, string> } = {}) {
  const out: string[] = [], err: string[] = [];
  const io: Io = {
    fetch, lane: async () => o.lane ?? null, now: () => NOW,
    read: async path => {
      if (path === "-") return example();
      const text = o.files?.[path];
      if (text === undefined) throw new Error(`no such file ${path}`);
      return text;
    },
    out: l => out.push(l), err: l => err.push(l),
  };
  const env = token ? { MORNDO_HUB: hub.base, MORNDO_AGENT_TOKEN: token, ...(o.lane ? { MORNDO_LANE: o.lane } : {}) } : {};
  const code = await run(argv, env, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("lint and usage", () => {
  it("the blank is refused, one problem a line, and the example is clean", async () => {
    const blank = await cli(["lint", "blank.md"], null, { files: { "blank.md": (await cli(["template"], null)).out + "\n" } });
    expect(blank.code).toBe(1);
    expect(blank.err.split("\n").every(l => l.startsWith("error "))).toBe(true);
    expect(blank.out).toBe("");
    const clean = await cli(["lint", "-"], null);
    expect(clean).toMatchObject({ code: 0, err: "", out: "" });
  });
  it("a missing command is usage, a dead hub is unreachable, and a bad token is refused", async () => {
    expect((await cli(["new"], manager)).code).toBe(2);
    expect((await cli(["sideways"], manager)).code).toBe(2);
    const dead = await run(["list"], { MORNDO_HUB: "http://127.0.0.1:1", MORNDO_AGENT_TOKEN: "not-a-token" }, {
      fetch, lane: async () => null, read: async () => "", out: () => {}, err: () => {}, now: () => NOW,
    });
    expect(dead).toBe(3);
    expect((await cli(["list"], "not-a-token")).code).toBe(1);
  });
});

describe("filing", () => {
  it("the manager files the example, and a lane's draft is forwarded or declined", async () => {
    const filed = await cli(["new", "brief.md"], manager, { files: { "brief.md": example() } });
    expect(filed.code).toBe(0);
    expect(filed.out).toBe("d-1");
    const shown = await cli(["show", "d-1"], manager);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("Support inbox triage");
    expect(shown.out).toContain("Answer: no answer yet");
    const draft = await cli(["new", "brief.md"], workers, { lane: "builder", files: { "brief.md": example() } });
    expect(draft.out).toBe("d-2");
    expect((await cli(["list"], manager)).out).not.toContain("d-2");
    const drafts = await cli(["list", "--drafts"], manager);
    expect(drafts.out).toContain("d-2");
    expect(drafts.out).toContain("draft");
    expect((await cli(["forward", "d-2"], workers, { lane: "builder" })).code).toBe(1);
    expect((await cli(["forward", "d-2"], manager)).out).toBe("d-2 forwarded");
    const listed = await cli(["list", "--json"], manager);
    const rows = JSON.parse(listed.out) as { id: string; draftedBy: string | null; status: string }[];
    expect(rows.find(r => r.id === "d-2")).toMatchObject({ status: "open", draftedBy: "builder" });
    const another = await cli(["new", "brief.md"], workers, { lane: "builder", files: { "brief.md": example() } });
    expect((await cli(["decline", another.out, "--why", "not this week"], manager)).out).toBe(`${another.out} declined`);
    expect((await cli(["withdraw", "d-1", "--why", "the slot was cancelled"], manager)).out).toBe("d-1 withdrawn");
    const settled = await cli(["new", "brief.md"], manager, { files: { "brief.md": example() } });
    expect((await cli(["settle", settled.out, "--note", "bought the script time"], manager)).out).toBe(`${settled.out} settled`);
  });
});
