// A state change becomes the fleet's record (design §4). The command and its hash stay on this node.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fleetRecord, type FleetJob, type FinishEvent, type StartBody } from "@morndo/domain";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { JobStore } from "../src/ops/job-store.ts";
import { tempHome } from "./helpers.ts";

const HASH = "a".repeat(64);
const AT = 1_700_000_000_000;
const EXIT = { outcome: "exited", exitCode: 0, durationMs: 1500 } satisfies FinishEvent;
const body = (): StartBody => ({
  id: "job-1", lane: "builder", name: "pack", jobClass: "default",
  notify: { kind: "lane", name: "builder" }, commandHash: HASH, cwdHash: HASH,
});

const open: { adb: AgentDb; cleanup: () => void }[] = [];
afterEach(() => { for (const o of open.splice(0)) { o.adb.close(); o.cleanup(); } });

describe("a job the node sends", () => {
  it("publishes state, class, lane, timings, outcome and notice, never the command", async () => {
    const h = tempHome();
    const adb = openAgentDb(join(h.home, "agent.db"));
    const seen: FleetJob[] = [];
    const store = new JobStore(adb.db, join(h.home, "job-logs"), () => AT, {
      home: h.home,
      onJob: (job, tail) => { seen.push(fleetRecord(job, { node: "pc", at: AT, tail })); },
    });
    open.push({ adb, cleanup: h.cleanup });
    expect(store.accept(body()).ok).toBe(true);
    await store.applySchedule({ default: 2 }, "off");
    expect(store.started("job-1").ok).toBe(true);
    expect((await store.settle("job-1", EXIT)).ok).toBe(true);
    expect(seen.map(event => event.state)).toEqual(["queued", "starting", "running", "exited"]);
    expect(seen.map(event => event.ended)).toEqual([null, null, null, AT]);
    const last = seen.at(-1);
    expect(last).toMatchObject({
      t: "job", id: "job-1", node: "pc", lane: "builder", class: "default",
      state: "exited", outcome: "exited", notice: "pending", durationSec: 1.5,
    });
    for (const event of seen) {
      expect(event).not.toHaveProperty("command");
      expect(event).not.toHaveProperty("argv");
      expect(event).not.toHaveProperty("cwd");
      expect(event).not.toHaveProperty("commandHash");
      expect(JSON.stringify(event)).not.toContain(HASH);
    }
  });
});
