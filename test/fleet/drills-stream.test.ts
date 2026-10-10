// Hook-stream drills (spec §9 "Stream"; §7 "Agent database lost or reinstalled", "Spool cannot be written"; §5.4–§5.6).
// A test subscriber (an HTTP server in this process) sits on the fleet's hook bus.
// Real: the agent's relay, its database, the fleet's outbox and its restart (SIGKILL, then a restart on the same
// database), with hook events posted while the fleet is down, so the agent's spool and its replay after the reconnect
// are exercised end to end.
// Placed by a hook:
// - the spool failure (`spoolFail`): a real full disk needs root or a tmpfs, and what is under test is the relay's
//   answer to a failed write;
// - the negative control's fixed stream id (`fixedStreamId`). The spec's control is "the same reset without streamId
//   drops the new events".
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestHooks } from "../../apps/node-agent/src/test-hooks.ts";
import { hook, joinAgent, keyParts, startFleet, stopAll, subscriber, tmuxServer, until, type Delivery } from "../fleet-harness.ts";

afterEach(stopAll);

const PATHS = ["/cc", "/sl", "/hook/stop", "/hook/failure", "/notify", "/file"] as const;
async function node(o: { delayMs?: number; hooks?: TestHooks } = {}) {
  const sub = await subscriber(o.delayMs === undefined ? {} : { delayMs: o.delayMs });
  const fleet = await startFleet({ subscribers: [{ name: "test", url: sub.url, paths: [...PATHS] }] });
  const agent = await joinAgent(fleet, "n1", { tmux: tmuxServer() });
  await agent.run(o.hooks);
  await agent.waitOnline();
  return { sub, fleet, agent };
}
const stop = (n: number) => ({ session_id: "s-drill", hook_event_name: "Stop", n });
const n = (d: Delivery) => (d.event.body as { n: number }).n;

describe("the hook stream", () => {
  it("an agent database reset starts a new stream, and every event of the new stream is delivered", async () => {
    const { sub, agent } = await node();
    for (let i = 1; i <= 5; i++) expect((await hook(agent, "/hook/stop", stop(i))).status).toBe(200);
    await until("the first stream's 5 events", () => sub.unique().size === 5, 15_000);
    const first = keyParts([...sub.unique().keys()][0] ?? "").streamId;
    await agent.resetDatabase();
    for (let i = 101; i <= 107; i++) expect((await hook(agent, "/hook/stop", stop(i))).status).toBe(200);
    await until("the new stream's 7 events", () => sub.unique().size === 12, 15_000);
    const fresh = [...sub.unique().values()].filter(d => keyParts(d.key).streamId !== first);
    expect(new Set(fresh.map(d => keyParts(d.key).streamId)).size).toBe(1);
    expect(fresh.map(d => keyParts(d.key).seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(fresh.map(n)).toEqual([101, 102, 103, 104, 105, 106, 107]);
  });

  it("negative control: the same reset under one fixed stream id loses the new stream's first events", async () => {
    const hooks: TestHooks = { fixedStreamId: "00000000-0000-4000-8000-000000000001" };
    const { sub, agent } = await node({ hooks });
    for (let i = 1; i <= 5; i++) await hook(agent, "/hook/stop", stop(i));
    await until("the first 5 events", () => sub.unique().size === 5, 15_000);
    await agent.resetDatabase(hooks);
    for (let i = 101; i <= 107; i++) await hook(agent, "/hook/stop", stop(i));
    // 106 and 107 (seq 6 and 7) are past the old stream's last seq, so they arrive. Once they have arrived, in-order
    // delivery means 101–105 never will.
    await until("106 and 107", () => [...sub.unique().values()].some(d => n(d) === 107), 15_000);
    expect([...sub.unique().values()].map(n).filter(x => x > 100)).toEqual([106, 107]);
  });

  it("a fleet restart mid-stream, with events posted while it is down: every event reaches the subscriber at least once, in order, and its key deduplicates it", async () => {
    const N = 200;
    const DOWN = 50;                                                     // posted while no fleet listens
    const { sub, fleet, agent } = await node({ delayMs: 20 });         // 20 ms a delivery: 200 take at least 4 s
    for (let i = 1; i <= N; i++) expect((await hook(agent, "/hook/stop", stop(i))).status).toBe(200);
    await until("delivery under way", () => sub.received.length >= 10, 15_000);
    expect(sub.unique().size).toBeLessThan(N);                           // the kill lands mid-stream, not after it
    await fleet.restart("SIGKILL", async () => {
      // The relay answers once the event is durable on the node (spec §5.5), whatever the fleet does: these wait in the
      // agent's spool and reach the fleet only by the replay after its reconnect (spec §5.4).
      for (let i = N + 1; i <= N + DOWN; i++) expect((await hook(agent, "/hook/stop", stop(i))).status).toBe(200);
    });
    await agent.waitOnline(30_000);
    await until(`all ${N + DOWN} keys`, () => sub.unique().size === N + DOWN, 60_000);
    expect([...sub.unique().values()].map(n)).toEqual(Array.from({ length: N + DOWN }, (_, i) => i + 1));   // first arrivals in order
    for (const d of sub.received) expect(d.event).toEqual(sub.unique().get(d.key)?.event);       // a repeat is the same event
    expect(new Set([...sub.unique().keys()].map(k => keyParts(k).streamId)).size).toBe(1);        // one stream, before and after
    console.log(`fleet restart drill: ${sub.received.length - N - DOWN} repeated deliveries, each deduplicated by its key`);
  });

  it("the spool can't be written: /cc and /sl still answer 204, the script paths 503, and the drops are counted", async () => {
    const { agent, fleet } = await node({ hooks: { spoolFail: true } });
    const file = join(agent.home, "note.txt");
    writeFileSync(file, "a file a hook sent\n");
    const got: Record<string, number> = {};
    for (const path of PATHS) got[path] = (await hook(agent, path, { session_id: "s-drill", hook_event_name: "Notification", path: file })).status;
    expect(got).toEqual({ "/cc": 204, "/sl": 204, "/hook/stop": 503, "/hook/failure": 503, "/notify": 503, "/file": 503 });
    // Health goes every 30 s (LIMITS.healthMs), so the counter shows within one interval.
    await until("the drops in n1's health", async () => ((await fleet.client.nodes()).find(x => x.name === "n1")?.health?.drops ?? 0) >= 2, 40_000);
  });

  it("control: the same posts with a writable spool are queued", async () => {
    const { agent } = await node();
    const file = join(agent.home, "note.txt");
    writeFileSync(file, "a file a hook sent\n");
    const got: Record<string, number> = {};
    for (const path of PATHS) got[path] = (await hook(agent, path, { session_id: "s-drill", hook_event_name: "Notification", path: file })).status;
    expect(got).toEqual({ "/cc": 204, "/sl": 204, "/hook/stop": 200, "/hook/failure": 202, "/notify": 202, "/file": 202 });
    expect(JSON.parse((await hook(agent, "/hook/stop", stop(1))).text)).toEqual({ ok: true, queued: true });
  });
});
