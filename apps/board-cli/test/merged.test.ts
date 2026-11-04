// `morndo-board merged` and the tag in `list` (T-805, B23): the open tasks whose pull request merged without a merge
// record, as the hub's last pass saw them. Through the real CLI against an in-process hub, whose merge source is the
// test's own. The board moves and records nothing.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MergedFlag } from "@morndo/domain";
import { startInProcessHub, type InProcessHub } from "../../hub/test/inprocess-hub.ts";
import { HELP, run } from "../src/cli.ts";
import { MANAGER_PROMPT } from "../src/prompt.ts";

const SHA = "3e9d1a7c5b2f4a8e9d0c1b2a3f4e5d6c7b8a9f01";

describe("morndo-board merged (B23)", () => {
  let hub: InProcessHub;
  let manager: string;
  let flags: MergedFlag[];
  beforeEach(async () => {
    hub = await startInProcessHub({});
    manager = hub.agents.issue("manager", "manager").secret;
    flags = [];
    hub.board.attachMerged({ flags: () => flags });
  });
  afterEach(async () => { await hub.close(); });
  async function say(...argv: string[]) {
    const out: string[] = [], err: string[] = [];
    const code = await run(argv, { MORNDO_HUB: hub.base, MORNDO_AGENT_TOKEN: manager }, { fetch, lane: async () => null, out: l => out.push(l), err: l => err.push(l) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }
  const file = async (title: string) => { await say("new", title, "--assign", "builder"); };

  it("says so when nothing is flagged", async () => {
    expect(await say("merged")).toMatchObject({ code: 0, out: "no merged pull requests without a merge record" });
  });

  it("lists each flagged task with its pull requests, and tags it in list", async () => {
    await file("Ship the totals row");
    await file("Fix the footer");
    flags = [{ key: "T-1" as MergedFlag["key"], status: "todo", prs: [{ repo: "acme/shop", n: 42, mergeSha: SHA }, { repo: "acme/vault", n: 9, mergeSha: null }] }];
    const merged = await say("merged");
    expect(merged.code, merged.err).toBe(0);
    expect(merged.out).toBe("T-1 (todo): acme/shop#42 merged 3e9d1a7 · acme/vault#9 merged");
    const list = await say("list");
    expect(list.out).toContain("[PR merged: acme/shop#42 merged 3e9d1a7 · acme/vault#9 merged]");
    expect(list.out.split("\n").filter(l => l.includes("[PR merged:"))).toHaveLength(1);        // T-2 carries no tag
  });

  it("--json prints the list as the hub holds it", async () => {
    await file("Ship the totals row");
    flags = [{ key: "T-1" as MergedFlag["key"], status: "todo", prs: [{ repo: "acme/shop", n: 42, mergeSha: SHA }] }];
    const r = await say("merged", "--json");
    expect(JSON.parse(r.out)).toEqual([{ key: "T-1", prs: ["acme/shop#42 merged 3e9d1a7"] }]);
  });

  it("changes nothing on the board: the task keeps its status and has no merge record", async () => {
    await file("Ship the totals row");
    flags = [{ key: "T-1" as MergedFlag["key"], status: "todo", prs: [{ repo: "acme/shop", n: 42, mergeSha: SHA }] }];
    await say("merged");
    await say("list");
    expect(hub.board.task("T-1")?.task.status).toBe("todo");
    expect(hub.board.task("T-1")?.merged).toBeNull();
  });

  it("the help and the manager's prompt name it", () => {
    expect(HELP).toContain("merged                                the open tasks whose pull request merged without a merge record");
    expect(MANAGER_PROMPT).toContain("morndo-board merged");
  });
});
