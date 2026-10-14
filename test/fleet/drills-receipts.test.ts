// Delivery drills, part 2 (fleet clients spec §12 "Drills", §4.3 "Confirming"): `delivered` only on a receipt from the
// lane's own transcript, and the one retype after the CLI dropped a queued line on an interrupt. The same office as part 1
// (test/fleet/drills-deliveries.test.ts): a real fleet and agent, w1 the fake input box writing the 2.1.293 lines. The
// receipt rules in full are Task 2's unit tests; these drills show the agent acting on them end to end.
// Negative control (spec §12: "the retype under the first key types nothing"): with retypeUnderFirstKey the agent retypes
// under the delivery's own id, whose done key holds its first outcome, so nothing is typed: the key `<id>#2` is what makes
// the retype happen.
// Also (plan/RECONCILIATION.md ruling 17): a `/clear` is recorded only in the new session's transcript, so its receipt is the
// pane's session changing to a new id after the typing.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { TestHooks } from "../../apps/node-agent/src/test-hooks.ts";
import { LIMITS } from "../../packages/protocol/src/fleet.ts";
import { fakeLane, joinAgent, paneOf, sleep, startFleet, stopAll, tmuxServer, until, watchDeliveries } from "../fleet-harness.ts";

afterEach(stopAll);

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
type Office = Awaited<ReturnType<typeof office>>;
const newId = (what: string) => `lanes:drill-${what}-${randomUUID().slice(0, 8)}`;
const times = (xs: string[], x: string) => xs.filter(t => t === x).length;
const PAST_A_TRY = LIMITS.deliveryTryMs + 2000;
// w1 busy (a turn running), then a delivery typed into it: the CLI holds the line in its own queue.
async function heldInQueue(o: Office, what: string, text: string): Promise<string> {
  await o.w1.control({ status: "busy" });
  await until("w1 busy in n1's inventory", async () => (await paneOf(o.fleet.client, "n1", "w1")).status === "busy", 15_000);
  const id = newId(what);
  await o.fleet.client.deliver({ id, lane: "w1", text });
  await o.watch.until(id, d => d.state === "held");
  return id;
}

describe("delivered only on a receipt from the lane's own transcript", () => {
  it("a submit the transcript never records stays typed; the prompt line, once written, delivers it", async () => {
    const o = await office();
    await o.w1.control({ silent: true });
    const id = newId("silent");
    await o.fleet.client.deliver({ id, lane: "w1", text: "not in the transcript yet" });
    await o.watch.until(id, d => d.state === "typed");
    await sleep(PAST_A_TRY);
    expect((await o.fleet.client.delivery(id))?.state).toBe("typed");
    await o.w1.control({ write: "userTyped", text: "not in the transcript yet" });
    const d = await o.watch.until(id, x => x.state === "delivered");
    expect(d.sessionId).toBe(o.w1.sessionId);
  });

  it("typed while busy: held on its enqueue; a dequeue (no text) decides nothing; the queued prompt delivers it", async () => {
    const o = await office();
    const id = await heldInQueue(o, "held", "behind the running turn");
    await o.w1.control({ dequeue: true });
    await sleep(PAST_A_TRY);
    expect((await o.fleet.client.delivery(id))?.state).toBe("held");
    await o.w1.control({ prompt: true, status: "idle" });
    await o.watch.until(id, d => d.state === "delivered");
    expect(times(o.w1.submitted(), "behind the running turn")).toBe(1);
  });

  it("taken into the running turn (absorbed_mid_turn and its queued_command), or delivered_to_agent: delivered", async () => {
    const o = await office();
    const a = await heldInQueue(o, "absorbed", "taken mid turn");
    await o.w1.control({ absorb: true });
    await o.watch.until(a, d => d.state === "delivered");
    const b = await heldInQueue(o, "to-agent", "handed to the agent");
    await o.w1.control({ remove: "delivered_to_agent" });
    await o.watch.until(b, d => d.state === "delivered");
  });

  it("removed for a reason no rule names: no verdict, it stays held and is never typed again", async () => {
    const o = await office();
    const id = await heldInQueue(o, "unknown-reason", "removed for a new reason");
    await o.w1.control({ remove: "moved_elsewhere", status: "idle" });
    await sleep(2 * PAST_A_TRY);
    expect((await o.fleet.client.delivery(id))?.state).toBe("held");
    expect(times(o.w1.submitted(), "removed for a new reason")).toBe(1);
  });
});

describe("a line the CLI dropped on an interrupt (cleared_on_cancel)", () => {
  it("with the box clear and the session idle: typed once more, under its own key, and delivered", async () => {
    const o = await office();
    const text = "dropped by an interrupt";
    const id = await heldInQueue(o, "dropped", text);
    await o.w1.control({ interrupt: {} });
    await o.watch.until(id, d => d.state === "delivered", 30_000);
    await sleep(PAST_A_TRY);
    expect(times(o.w1.submitted(), text)).toBe(2);
  });

  it("with its line back in the box: not typed again, uncertain", async () => {
    const o = await office();
    const text = "dropped, and back in the box";
    const id = await heldInQueue(o, "restored", text);
    await o.w1.control({ interrupt: { restore: true } });
    await o.watch.until(id, d => d.state === "uncertain", 30_000);
    await sleep(PAST_A_TRY);
    expect(times(o.w1.submitted(), text)).toBe(1);
    expect(o.w1.screen()).toContain(text);
  });

  it("dropped again after its one retype: never typed a third time, uncertain", async () => {
    const o = await office();
    const text = "dropped twice";
    const id = await heldInQueue(o, "twice", text);
    await o.w1.control({ interrupt: { queueNext: true } });          // idle; the retype then lands as a new turn starts
    await until("the retype typed", () => times(o.w1.submitted(), text) === 2, 30_000);
    await o.w1.control({ interrupt: {} });
    await o.watch.until(id, d => d.state === "uncertain", 30_000);
    await sleep(2 * PAST_A_TRY);
    expect(times(o.w1.submitted(), text)).toBe(2);
  });

  it("(negative control) the retype under the first key types nothing: that key is done, and answers its old outcome", async () => {
    const o = await office({ retypeUnderFirstKey: true });
    const text = "dropped, retyped under the first key";
    await heldInQueue(o, "first-key", text);
    await o.w1.control({ interrupt: {} });
    await sleep(2 * PAST_A_TRY);
    expect(times(o.w1.submitted(), text)).toBe(1);
  });
});

describe("a slash command that starts a new session (ruling 17)", () => {
  it("/clear: typed once, and delivered when the pane's session changes, though the old transcript never records it", async () => {
    const o = await office();
    const before = (await paneOf(o.fleet.client, "n1", "w1")).sessionId;
    expect(before).toBe(o.w1.sessionId);
    const id = newId("clear");
    await o.fleet.client.deliver({ id, lane: "w1", text: "/clear" });
    await o.watch.until(id, d => d.state === "delivered", 30_000);
    const after = (await paneOf(o.fleet.client, "n1", "w1")).sessionId;
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    await sleep(PAST_A_TRY);
    expect(o.w1.submitted()).toEqual(["/clear"]);
    expect(o.watch.states(id).some(d => d.state === "given_up")).toBe(false);   // the session change is its receipt, never "gone"
  });
});
