// Node drills (spec §9 "Isolation", "Clock", "Pane reuse"; §7 "Node down or partitioned", "tmux server restarted",
// "Clock offset > 2 s"): a real fleet and real agents, plus the hub in fleet mode where the drill is about the hub.
// Real: SIGSTOP on an agent process; a tmux server killed and recreated (the drill checks that %N was reused, rather
// than assuming it); the hub's polling.
// Placed by a hook:
// - the agent's wall clock 10 s behind (`clockOffsetMs`, and the fixture's --offset for the transcript it writes);
// - the negative control's missing expectation check (`noExpect`).
// The Isolation row's own negative control (sequential polling misses the bound) needs the hub's poller swapped, so it
// lives with the poller in Task 14 (apps/hub/test, against fake-fleet.ts). Here the stalled node's own lane is shown not
// to move, which proves the stall is real.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { matchEchoes, type OutboxRecord } from "../../apps/web/src/lib/outbox/state.ts";
import type { TestHooks } from "../../apps/node-agent/src/test-hooks.ts";
import { parseWorkerId } from "../../packages/protocol/src/worker-id.ts";
import { expectOf, fakeLane, joinAgent, paneOf, sleep, startFleet, startHub, stopAll, tmuxServer, until } from "../fleet-harness.ts";

afterEach(stopAll);
const POLL = 500;

describe("a slow node", () => {
  it("a stalled agent (SIGSTOP) doesn't hold up the other node's lanes on the hub", async () => {
    const fleet = await startFleet();
    const [t1, t2] = [tmuxServer(), tmuxServer()];
    const n1 = await joinAgent(fleet, "n1", { tmux: t1 });
    const n2 = await joinAgent(fleet, "n2", { tmux: t2 });
    const a1 = await fakeLane(t1, { window: "a1", prose: "a1 on n1" });
    const b1 = await fakeLane(t2, { window: "b1", prose: "b1 on n2" });
    await Promise.all([n1.run(), n2.run()]);
    await Promise.all([n1.waitOnline(), n2.waitOnline()]);
    const hub = await startHub(fleet, { pollMs: POLL });
    const [w1, w2] = await Promise.all([paneOf(fleet.client, "n1", "a1"), paneOf(fleet.client, "n2", "b1")]);
    const [f1, f2] = await Promise.all([hub.feed(), hub.feed()]);
    await until("a1 and b1 on the hub", () => f1.seen.has(w1.workerId) && f1.seen.has(w2.workerId), 15_000);
    f1.watch(w1.workerId);
    f2.watch(w2.workerId);
    await until("b1's screen while n2 runs", () => f2.screens.some(s => s.text.includes("b1 on n2")), 10_000);   // the watch works
    n2.proc()?.pause();
    const latencies: number[] = [];
    // 8 ticks over about 16 s. For the first ~15 s, n2 still counts as online to the fleet (a ping every 15 s), so ops sent
    // to it hang until they time out: the hardest case for the hub.
    for (let k = 1; k <= 8; k++) {
      const t0 = performance.now();
      a1.draft(` tick-${k}`);
      b1.draft(` b-tick-${k}`);
      await until(`a1's tick-${k} on the hub`, () => f1.screens.some(s => s.text.includes(` tick-${k}`)), 10_000);
      latencies.push(performance.now() - t0);
      await sleep(2000);
    }
    expect(Math.max(...latencies)).toBeLessThan(POLL + 1500);                 // within a poll interval, plus margin
    expect(f2.screens.some(s => s.text.includes("b-tick-"))).toBe(false);     // the stall was real: b1 never moved
    n2.proc()?.resume();
    await until("b1 moves again once n2 runs", () => f2.screens.some(s => s.text.includes("b-tick-8")), 40_000);
  });
});

describe("clocks", () => {
  it("an agent 10 s behind: the fleet raises a clock alert, and echo matching on the node's time still matches", async () => {
    // Behind, not ahead. With the node behind, matching on the hub's clock misses the echo. Ahead, it would match anyway,
    // and the drill would prove nothing.
    const OFFSET = -10_000;
    const fleet = await startFleet();
    const tmux = tmuxServer();
    const agent = await joinAgent(fleet, "n1", { tmux });
    const box = await fakeLane(tmux, { window: "box", claudeHome: agent.home, offsetMs: OFFSET });
    await agent.run({ clockOffsetMs: OFFSET });
    await agent.waitOnline();
    const alert = await until("a clock alert for n1", async () => (await fleet.client.alerts()).find(a => a.kind === "clock_offset" && a.node === "n1") ?? null, 40_000);
    expect(Number(alert.detail.offsetMs)).toBeGreaterThan(-12_000);
    expect(Number(alert.detail.offsetMs)).toBeLessThan(-8_000);
    const hub = await startHub(fleet);
    const id = (await paneOf(fleet.client, "n1", "box")).workerId;
    const feed = await hub.feed();
    await until("box on the hub", () => feed.seen.has(id), 15_000);
    const hubNow = Date.now();
    const sent = await hub.send(id, "clock drill echo", randomUUID());
    expect(sent).toMatchObject({ status: 200, body: { ok: true } });
    const at = Number(sent.body.at);
    expect(at).toBeGreaterThan(hubNow + OFFSET - 2000);                       // the node's time of typing, not the hub's
    expect(at).toBeLessThan(hubNow + OFFSET + 2000);
    type Line = { uuid?: string; message?: { content?: unknown }; timestamp?: string };
    const line = await until("the echo in the transcript", () => readFileSync(box.transcript ?? "", "utf8").split("\n").filter(Boolean)
      .map(l => JSON.parse(l) as Line).find(l => l.message?.content === "clock drill echo") ?? null);
    const echo = { id: line.uuid ?? "echo", at: Date.parse(line.timestamp ?? ""), text: "clock drill echo" };
    // The app's own matcher (apps/web/src/lib/outbox/state.ts), on the record the app keeps once the hub answers 200:
    // `typedAt` is the hub's `at`, the node's time of typing (Task 5).
    const record: OutboxRecord = {
      id: "r1", worker: id, workerName: "box", text: "clock drill echo", uploads: [], createdAt: hubNow, budgetFrom: hubNow,
      state: "sent", error: null, attempts: 1, seen: "none", sentAt: hubNow, typedAt: at,
    };
    expect(matchEchoes([record], [echo]).get("r1")).toBe(echo.id);           // matched on the node's clock
    // Control: the same record without the node's time falls back to when it was written, on this machine's (the hub's)
    // clock, and misses the echo, which the node wrote 10 s "earlier".
    expect(matchEchoes([{ ...record, typedAt: null }], [echo]).size).toBe(0);
  });
});

describe("a tmux server restart", () => {
  async function restartDrill(hooks: TestHooks) {
    const fleet = await startFleet();
    const tmux = tmuxServer();
    const agent = await joinAgent(fleet, "n1", { tmux });
    await fakeLane(tmux, { window: "alpha", prose: "the old alpha" });
    await agent.run(hooks);
    await agent.waitOnline();
    const old = await paneOf(fleet.client, "n1", "alpha");
    await tmux.kill();                                                        // the server dies, as on a crash or a reboot
    const fresh = await fakeLane(tmux, { window: "alpha", prose: "the new alpha" });
    const now = await until("alpha's new worker id", async () => {
      const p = await paneOf(fleet.client, "n1", "alpha").catch(() => null);
      return p && p.workerId !== old.workerId ? p : null;
    }, 15_000);
    const [was, is] = [parseWorkerId(old.workerId), parseWorkerId(now.workerId)];
    expect(is?.server).not.toBe(was?.server);                                 // a new stamp
    expect(is?.pane).toBe(was?.pane);                                         // tmux handed out the same %N again: the drill is real
    const r = await fleet.client.op({ node: "n1" }, "pane.send",
      { workerId: old.workerId, text: "meant for the old alpha", expect: expectOf(old) }, { key: `hub:tr-${randomUUID()}` });
    return { fleet, fresh, old, r };
  }

  it("old worker ids answer no_pane, and the new pane receives nothing", async () => {
    const { fleet, fresh, old, r } = await restartDrill({});
    expect(r).toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
    const cap = await fleet.client.op({ node: "n1" }, "pane.captureMany", { workerIds: [old.workerId] });
    expect(cap).toMatchObject({ ok: true, result: { captures: [{ workerId: old.workerId, text: null }] } });
    await sleep(1500);
    expect(fresh.submitted()).toEqual([]);
  });

  it("negative control: without the expectation check, the old worker id types into the new pane", async () => {
    const { fresh, r } = await restartDrill({ noExpect: true });
    expect(r.ok).toBe(true);
    await until("the text in the new alpha", () => fresh.submitted().includes("meant for the old alpha"));
  });
});
