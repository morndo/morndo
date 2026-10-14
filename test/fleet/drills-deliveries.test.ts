// Delivery drills, part 1 (fleet clients spec §12 "Drills", §4.3 "How the agent delivers"), end to end: a real fleet and a
// real node agent (child processes, temporary HOMEs, random ports, an isolated tmux server; test/fleet-harness.ts), with a
// lane that is the fake input box (test/fixtures/fake-claude-pane.ts). The box writes its session file's status and its
// transcript in the 2.1.293 shapes (Task 2's recorded lines, test/fixtures/claude-code/2.1.293), and the test tells it what the CLI does
// next: open a menu, keep a line in the box after Enter, let the owner type over it.
// Real: the fleet's routing and mirror, the agent's queue in agent.db, its done keys, pane.send's checks, the receipt read
// from the transcript. Placed by a test hook: the agent's own death right after a typing (killAfterEffect), between the
// paste and the done key, which a kill from outside can't time.
// Negative control (spec §12: "without the started check, the restarted agent types again"): the same death with the
// agent's done keys off (noDoneKeys) types the delivery a second time.
// Also (plan/RECONCILIATION.md): a lane whose session runs a shell command takes deliveries (ruling 11), and a delivery
// that never gets its receipt holds the next one for at most 60 s (ruling 16).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { TestHooks } from "../../apps/node-agent/src/test-hooks.ts";
import { LIMITS } from "../../packages/protocol/src/fleet.ts";
import { fakeLane, joinAgent, paneOf, sleep, startFleet, stopAll, tmuxServer, until, watchDeliveries } from "../fleet-harness.ts";

afterEach(stopAll);

// One node with one lane running the box, w1, idle, and a watch on the fleet's deliveries.
async function office(hooks: TestHooks = {}) {
  const fleet = await startFleet();
  const tmux = tmuxServer();
  const agent = await joinAgent(fleet, "n1", { tmux });
  const w1 = await fakeLane(tmux, { window: "w1", claudeHome: agent.home });
  await agent.run(hooks);
  await agent.waitOnline();
  await until("w1 idle in n1's inventory", async () => (await paneOf(fleet.client, "n1", "w1")).status === "idle", 15_000);
  const watch = await watchDeliveries(fleet);
  return { fleet, tmux, agent, w1, watch };
}
const newId = (what: string) => `lanes:drill-${what}-${randomUUID().slice(0, 8)}`;
const times = (xs: string[], x: string) => xs.filter(t => t === x).length;
// A try runs on every change the agent sees and at least every LIMITS.deliveryTryMs: past one more period, nothing more
// was typed.
const PAST_A_TRY = LIMITS.deliveryTryMs + 2000;

describe("a delivery waits until the lane can take it, then types once", () => {
  it("waits through the owner's draft and then a menu, never typing over either, then types once", async () => {
    const o = await office();
    o.w1.draft("the owner's half thought");
    await until("the draft on w1", () => o.w1.screen().includes("the owner's half thought"));
    const id = newId("menu");
    expect(await o.fleet.client.deliver({ id, lane: "w1", text: "after the menu" })).toMatchObject({ state: "queued", node: "n1" });
    await o.watch.until(id, d => d.state === "queued" && d.waiting?.reason === "draft_present");
    await o.w1.control({ status: "waiting", question: "Run the docs build?" });
    await o.watch.until(id, d => d.state === "queued" && d.waiting?.reason === "menu_open");
    expect(o.w1.submitted()).toEqual([]);
    await o.w1.control({ status: "idle", clear: true });           // the menu answered and the draft gone, in one step
    await o.watch.until(id, d => d.state === "delivered");
    await sleep(PAST_A_TRY);
    expect(o.w1.submitted()).toEqual(["after the menu"]);
  });

  it("presses Enter again while its own text stays in the box, and the line is taken once", async () => {
    const o = await office();
    await o.w1.control({ swallowEnters: 1 });
    const id = newId("stuck");
    await o.fleet.client.deliver({ id, lane: "w1", text: "a stuck line" });
    await o.watch.until(id, d => d.state === "delivered");
    expect(o.w1.submitted()).toEqual(["a stuck line"]);
    expect(o.w1.enters()).toBe(2);                                  // the paste's own Enter, and one more
  });

  it("never presses Enter over another text: the owner's words took its line's place, and stay unsent", async () => {
    const o = await office();
    await o.w1.control({ swallowEnters: 1, replaceWith: "the owner's own words" });
    const id = newId("replaced");
    await o.fleet.client.deliver({ id, lane: "w1", text: "a line the owner typed over" });
    await o.watch.until(id, d => d.state === "typed");
    await sleep(PAST_A_TRY);
    expect(o.w1.enters()).toBe(1);
    expect(o.w1.submitted()).toEqual([]);
    expect(o.w1.screen()).toContain("the owner's own words");
    expect((await o.fleet.client.delivery(id))?.state).toBe("typed");
  });

  it("presses Enter at most twice more on a line that never leaves the box", async () => {
    const o = await office();
    await o.w1.control({ swallowEnters: 50 });
    const id = newId("stuck-forever");
    await o.fleet.client.deliver({ id, lane: "w1", text: "never taken" });
    await o.watch.until(id, d => d.state === "typed");
    await sleep(2 * PAST_A_TRY);
    expect(o.w1.enters()).toBeGreaterThanOrEqual(2);
    expect(o.w1.enters()).toBeLessThanOrEqual(3);
    expect(o.w1.submitted()).toEqual([]);
  });
});

describe("the agent killed while typing", () => {
  it("started again, it never types the delivery a second time, and confirms it from the transcript", async () => {
    const id = newId("killed");
    const o = await office({ killAfterEffect: id });
    const text = "typed as the agent died";
    await o.fleet.client.deliver({ id, lane: "w1", text });
    await until("the agent gone", () => !o.agent.proc()?.alive(), 15_000);
    expect(o.w1.submitted()).toEqual([text]);                     // typed, and the done key never written
    await o.agent.run();                                             // as shipped: no hook
    await o.agent.waitOnline();
    await o.watch.until(id, d => d.state === "delivered", 30_000);
    await sleep(PAST_A_TRY);
    expect(times(o.w1.submitted(), text)).toBe(1);
  });

  it("(negative control) without its done keys, the restarted agent types the delivery again", async () => {
    const id = newId("killed-nokeys");
    const o = await office({ killAfterEffect: id, noDoneKeys: true });
    const text = "typed as the agent died, without keys";
    await o.fleet.client.deliver({ id, lane: "w1", text });
    await until("the agent gone", () => !o.agent.proc()?.alive(), 15_000);
    await o.agent.run({ noDoneKeys: true });
    await o.agent.waitOnline();
    await until("the second typing", () => times(o.w1.submitted(), text) === 2, 30_000);
  });
});

describe("a session running a shell command (status shell) is alive (RECONCILIATION.md ruling 11)", () => {
  it("takes a delivery as when idle, and types it once", async () => {
    const o = await office();
    await o.w1.control({ status: "shell" });
    await until("w1 shell in n1's inventory", async () => (await paneOf(o.fleet.client, "n1", "w1")).status === "shell", 15_000);
    const id = newId("shell");
    await o.fleet.client.deliver({ id, lane: "w1", text: "beside the shell command" });
    await o.watch.until(id, d => d.state === "delivered");
    await sleep(PAST_A_TRY);
    expect(o.w1.submitted()).toEqual(["beside the shell command"]);
    expect(o.watch.states(id).some(d => d.waiting?.reason === "no_session")).toBe(false);
  });
});

// Rulings 16 and 42: a typed or held delivery waiting for its receipt holds the next one back (`earlier`) for at most
// LIMITS.deliveryReceiptHoldMs (60 s).
const HOLD_MS = LIMITS.deliveryReceiptHoldMs;

describe("a delivery waiting for its receipt holds the next one for at most 60 s (ruling 16)", () => {
  it("the next one waits (earlier), types once the minute is up, and is confirmed by its own receipt", async () => {
    const o = await office();
    await o.w1.control({ silent: true });                            // the first line never reaches the transcript
    const first = newId("no-receipt");
    await o.fleet.client.deliver({ id: first, lane: "w1", text: "never confirmed" });
    const a = await o.watch.until(first, d => d.state === "typed");
    await o.w1.control({ silent: false });
    const next = newId("next");
    await o.fleet.client.deliver({ id: next, lane: "w1", text: "the next one" });
    await o.watch.until(next, d => d.state === "queued" && d.waiting?.reason === "earlier");
    const b = await o.watch.until(next, d => d.state === "delivered", HOLD_MS + 30_000);
    const held = (b.typedAt ?? 0) - (a.typedAt ?? 0);                 // both on the node's clock
    expect(held).toBeGreaterThanOrEqual(HOLD_MS - 1000);
    expect(held).toBeLessThanOrEqual(HOLD_MS + LIMITS.deliveryTryMs + 3000);
    expect(o.w1.submitted()).toEqual(["never confirmed", "the next one"]);
    expect((await o.fleet.client.delivery(first))?.state).toBe("typed");   // still waiting for its own receipt
  }, 150_000);
});
