// What a welcome replays, read from the real stores (T-571, rev-198's recheck of #198): the open deliveries, the finals
// of the last hour and the jobs inside their 7 days, each sent as the store reads it, and only if its row still reads
// the same once the replay's sync is in. The same function runs in agent.ts.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Delivery, Job, StartBody } from "@morndo/domain";
import { replayStores } from "../src/conn/replay.ts";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { DeliveryStore } from "../src/deliveries/store.ts";
import { JobStore } from "../src/ops/job-store.ts";
import { tempHome } from "./helpers.ts";

const AT = 1_700_000_000_000;
const HOUR = 3_600_000;
const HASH = "a".repeat(64);
const body = (id: string): StartBody => ({
  id, lane: "builder", name: "pack", jobClass: "default", notify: { kind: "lane", name: "builder" }, commandHash: HASH, cwdHash: HASH,
});

const open: { adb: AgentDb; cleanup: () => void }[] = [];
afterEach(() => { for (const o of open.splice(0)) { o.adb.close(); o.cleanup(); } });

function stores() {
  const h = tempHome();
  const adb = openAgentDb(join(h.home, "agent.db"));
  open.push({ adb, cleanup: h.cleanup });
  const clock = { now: AT };
  const now = () => clock.now;
  const deliveries = new DeliveryStore(adb.db, now, "pc", async () => {});
  const jobs = new JobStore(adb.db, join(h.home, "job-logs"), now, { home: h.home, walSync: async () => {} });
  return { deliveries, jobs, clock };
}
const later = (id: string) => ({ id, target: { lane: "later", sticky: true }, text: "for later", ttlMs: HOUR, boundSession: null });

// The fake disk: the replay's sync waits until the test lets it go.
function disk() {
  let letGo = () => {};
  const held = new Promise<void>(resolve => { letGo = resolve; });
  return { sync: () => held, letGo: () => { letGo(); } };
}

function sink() {
  const deliveries: Delivery[] = [];
  const jobs: { job: Job; at: number; tail: string }[] = [];
  return { deliveries, jobs, sendDelivery: (d: Delivery) => { deliveries.push(d); }, sendJob: (job: Job, at: number, tail: string) => { jobs.push({ job, at, tail }); } };
}

describe("a welcome's replay, from the real stores (T-571)", () => {
  it("sends each open delivery, each final of the last hour and each job inside its 7 days, as the stores read them", async () => {
    const s = stores();
    await s.deliveries.store(later("d-open"));
    await s.deliveries.store(later("d-final"));
    s.deliveries.update("d-final", { state: "given_up", why: "cancelled" });
    s.clock.now = AT - 2 * HOUR;
    await s.deliveries.store(later("d-old"));
    s.deliveries.update("d-old", { state: "given_up", why: "cancelled" });         // final before the hour: left out
    s.clock.now = AT;
    s.jobs.accept(body("job-1"));
    const out = sink();
    await replayStores({ deliveries: s.deliveries, jobs: s.jobs, since: AT - HOUR, sync: async () => {}, current: () => true, ...out });
    expect(out.deliveries.map(d => d.id)).toEqual(["d-open", "d-final"]);
    expect(out.deliveries).toEqual([s.deliveries.get("d-open"), s.deliveries.get("d-final")]);
    expect(out.jobs).toEqual([{ job: s.jobs.get("job-1"), at: AT, tail: "" }]);
  });

  it("leaves out a delivery and a job whose rows changed while its sync ran, and sends the rest", async () => {
    const s = stores();
    await s.deliveries.store(later("d-a"));
    await s.deliveries.store(later("d-b"));
    s.jobs.accept(body("job-1"));
    s.jobs.accept(body("job-2"));
    await s.jobs.applySchedule({ default: 2 }, "off");                             // both starting
    const d = disk();
    const out = sink();
    const replay = replayStores({ deliveries: s.deliveries, jobs: s.jobs, since: AT - HOUR, sync: d.sync, current: () => true, ...out });
    s.deliveries.update("d-a", { state: "given_up", why: "cancelled" });          // each change goes out on its own path
    s.jobs.started("job-1");                                                      // running now
    d.letGo();
    await replay;
    expect(out.deliveries.map(x => x.id)).toEqual(["d-b"]);
    expect(out.jobs.map(x => x.job.id)).toEqual(["job-2"]);
  });

  it("sends nothing once its welcome is no longer current", async () => {
    const s = stores();
    await s.deliveries.store(later("d-a"));
    s.jobs.accept(body("job-1"));
    let current = true;
    const d = disk();
    const out = sink();
    const replay = replayStores({ deliveries: s.deliveries, jobs: s.jobs, since: AT - HOUR, sync: d.sync, current: () => current, ...out });
    current = false;
    d.letGo();
    await replay;
    expect(out.deliveries).toEqual([]);
    expect(out.jobs).toEqual([]);
  });
});
