// The manager is told, in one message, which open tasks have a merged pull request they do not record (T-805, B23): the
// same rhythm as the stale sweep — at once when the list changed, at most every 12 hours while it is the same, nothing
// when there is nothing, and a message that did not go is tried again under its own id. It sends through the fleet's
// delivery port and types nothing itself. Synthetic flags and times only.
import { describe, expect, it } from "vitest";
import { mergedMessage, type MergedFlag } from "@morndo/domain";
import { MergedSweep } from "../src/application/board-inbox.ts";

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const SHA = "3e9d1a7c5b2f4a8e9d0c1b2a3f4e5d6c7b8a9f01";
const flag = (n: number, pr = 42): MergedFlag => ({ key: `T-${n}` as MergedFlag["key"], status: "review", prs: [{ repo: "acme/shop", n: pr, mergeSha: SHA }] });

type Sent = { id: string; lane: string; text: string; ttlMs?: number };
function rig() {
  const r = { now: T0, flags: [] as MergedFlag[], sent: [] as Sent[], ok: true as boolean | "throw", logged: [] as string[] };
  const deliver = async (d: Sent) => {
    if (r.ok === "throw") throw new Error("the fleet is down");
    if (!r.ok) return false;
    r.sent.push(d);
    return true;
  };
  const sweep = new MergedSweep({ flags: () => r.flags, deliver, lane: "manager", now: () => r.now, log: { warn: (l: string) => { r.logged.push(l); } } });
  return { r, sweep };
}

describe("the merged-pull-request message to the manager", () => {
  it("says nothing while nothing is flagged", async () => {
    const { r, sweep } = rig();
    expect(await sweep.tick()).toEqual({ sent: false, items: 0 });
    expect(r.sent).toEqual([]);
  });

  it("sends ONE message to the manager's lane listing every flagged task, under a fresh id, for 12 hours", async () => {
    const { r, sweep } = rig();
    r.flags = [flag(1), flag(2, 43)];
    expect(await sweep.tick()).toEqual({ sent: true, items: 2 });
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.lane).toBe("manager");
    expect(r.sent[0]?.text).toBe(mergedMessage(r.flags));
    expect(r.sent[0]?.id).toBe(`board-merged:${T0}`);
    expect(r.sent[0]?.ttlMs).toBe(12 * HOUR);
  });

  it("sends an unchanged list again only after 12 hours, and a changed one at once", async () => {
    const { r, sweep } = rig();
    r.flags = [flag(1)];
    await sweep.tick();
    r.now += 11 * HOUR;
    expect(await sweep.tick()).toEqual({ sent: false, items: 1 });
    r.now += 2 * HOUR;
    expect(await sweep.tick()).toEqual({ sent: true, items: 1 });
    r.now += 1 * HOUR;
    r.flags = [flag(1), flag(2, 43)];
    expect(await sweep.tick()).toEqual({ sent: true, items: 2 });
    expect(r.sent.map(s => s.id)).toEqual([`board-merged:${T0}`, `board-merged:${T0 + 13 * HOUR}`, `board-merged:${T0 + 14 * HOUR}`]);
  });

  it("a flag that goes away and comes back is a changed list: sent again", async () => {
    const { r, sweep } = rig();
    r.flags = [flag(1)];
    await sweep.tick();
    r.flags = [];
    expect(await sweep.tick()).toEqual({ sent: false, items: 0 });
    r.now += HOUR;
    r.flags = [flag(1)];
    expect(await sweep.tick()).toEqual({ sent: true, items: 1 });
  });

  it("a message that did not go is tried again at the next pass under the same id and text, and a throw is a refusal, not a crash", async () => {
    const { r, sweep } = rig();
    r.flags = [flag(1)];
    r.ok = false;
    expect(await sweep.tick()).toEqual({ sent: false, items: 1 });
    r.ok = "throw";
    r.now += 5 * 60_000;
    expect(await sweep.tick()).toEqual({ sent: false, items: 1 });
    expect(r.logged).toHaveLength(2);
    r.ok = true;
    r.now += 5 * 60_000;
    expect(await sweep.tick()).toEqual({ sent: true, items: 1 });
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.id).toBe(`board-merged:${T0}`);                         // the first attempt's id, text unchanged
  });

  it("a retry whose list has changed meanwhile goes under a fresh id with the new text", async () => {
    const { r, sweep } = rig();
    r.flags = [flag(1)];
    r.ok = false;
    await sweep.tick();
    r.ok = true;
    r.now += 5 * 60_000;
    r.flags = [flag(1), flag(2, 43)];
    expect(await sweep.tick()).toEqual({ sent: true, items: 2 });
    expect(r.sent[0]?.id).toBe(`board-merged:${T0 + 5 * 60_000}`);
    expect(r.sent[0]?.text).toBe(mergedMessage(r.flags));
  });
});
