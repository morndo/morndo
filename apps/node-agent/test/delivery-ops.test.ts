// lane.deliver and delivery.cancel as the fleet asks for them (fleet clients spec §4.1–4.3; plan Contracts): through the
// executor, with the policy's say, on an isolated tmux server where a Claude Code lane is the agent's fake box with a
// session the test writes (claude-session.ts) and a lane without Claude Code is a shell; then over a connection, with
// ev.delivery after each change.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS, type Delivery } from "@morndo/protocol";
import { joinedConfig, runAgent } from "./agent-harness.ts";
import { claudeSession } from "./claude-session.ts";
import { startFakeFleet, type Msg } from "./fake-fleet.ts";
import { isolatedTmux, tempHome, until, type TestTmux } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

const FIXTURE = join(import.meta.dirname, "fake-claude.fixture.ts");
const SHELL = "bash --norc --noprofile";
const MANAGER = { lane: "manager", sticky: true } as const;
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let h: Harness;
beforeEach(() => {
  home = tempHome();
  t = isolatedTmux();
  h = opsHarness({ home: home.home, socket: t.socket });
  t.tmux("new-session", "-d", "-s", "main", "-n", "shell", SHELL);
});
afterEach(async () => { h.deliverer.stop(); await h.deliverer.drain(); h.close(); await t.kill(); home.cleanup(); });

// A lane running Claude Code: the fake box, idle in a session the test wrote.
async function claudeLane(window: string) {
  const dir = join(home.home, window);
  mkdirSync(dir, { recursive: true });
  const pane = t.tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "=main:", "-n", window, `${process.execPath} ${FIXTURE} ${dir}`).trim();
  expect(await until(() => t.tmux("capture-pane", "-p", "-t", pane).includes("❯"))).toBe(true);
  const session = claudeSession({ tmux: t, claudeDir: join(home.home, ".claude"), pane });
  session.status("idle");
  await h.inventory.refresh();
  return session;
}
const deliver = (args: Record<string, unknown>, o: { key?: string } = {}) => h.call("lane.deliver", args, o);

describe("lane.deliver", () => {
  it("answers queued once stored, the same request again with its state, and other content under its id with id_conflict", async () => {
    const session = await claudeLane("api");
    const args = { id: "hub:cmd:1", target: { lane: "api", sticky: false }, text: "run the tests" };
    expect(await deliver(args)).toMatchObject({ ok: true, result: { delivery: { id: "hub:cmd:1", node: "pc", target: { lane: "api" }, state: "queued", sessionId: session.sessionId } } });
    expect(await deliver(args)).toMatchObject({ ok: true, result: { delivery: { id: "hub:cmd:1" } } });
    expect(await deliver({ ...args, text: "something else" })).toMatchObject({ ok: false, error: { code: "id_conflict", executed: "no" } });
    expect(h.deliveries.textOf("hub:cmd:1")).toBe("run the tests");
  });

  it("refuses, not executed and with nothing stored: no_session for a lane without Claude Code, no_pane for a name not here, lane_conflict for a name two windows claim; a pane started in the last 2 minutes waits instead", async () => {
    t.tmux("new-window", "-d", "-t", "=main:", "-n", "twin", SHELL);
    t.tmux("new-window", "-d", "-t", "=main:", "-n", "twin", SHELL);
    // Every pane here started just now: within the 2-minute grace, counted from the pane's own process (ruling 14), a
    // delivery waits for Claude Code instead. The drills' test hook sets the grace to 0.
    const graceless = opsHarness({ home: home.home, socket: t.socket, hooks: { deliveryStartGraceMs: 0 } });
    try {
      const cases = [[{ lane: "shell", sticky: false }, "no_session"], [{ lane: "nowhere", sticky: false }, "no_pane"], [{ lane: "twin", sticky: true }, "lane_conflict"]] as const;
      for (const [target, code] of cases) {
        expect(await graceless.call("lane.deliver", { id: "hub:r", target, text: "x" }), code).toMatchObject({ ok: false, error: { code, executed: "no" } });
      }
      expect(graceless.deliveries.get("hub:r")).toBeNull();
    } finally {
      graceless.close();
    }
    expect(await deliver({ id: "hub:g", target: { lane: "shell", sticky: false }, text: "x" })).toMatchObject({ ok: true, result: { delivery: { state: "queued" } } });
  });

  it("refuses as bad_args, storing nothing, an id ending in #<digits>, a ttlMs over 7 days and a target naming both a lane and a pane (ruling 7)", async () => {
    const bad = [
      { id: "hub:r#2", target: MANAGER, text: "x" },
      { id: "hub:r", target: MANAGER, text: "x", ttlMs: LIMITS.deliveryKeepMs + 1 },
      { id: "hub:r", target: { ...MANAGER, workerId: "pc.0a1b2c3d.1" }, text: "x" },
    ];
    for (const args of bad) {
      expect(await deliver(args), JSON.stringify(args)).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    }
    expect([h.deliveries.get("hub:r"), h.deliveries.get("hub:r#2")]).toEqual([null, null]);
    expect(await deliver({ id: "hub:r", target: MANAGER, text: "x", ttlMs: LIMITS.deliveryKeepMs })).toMatchObject({ ok: true, result: { delivery: { state: "queued" } } });
  });

  it("a pane refresh that fails stores nothing and is not in doubt", async () => {
    h.panes.refresh = () => Promise.reject(new Error("tmux list-panes did not answer"));
    expect(await deliver({ id: "hub:stall", target: MANAGER, text: "x" })).toMatchObject({ ok: false, error: { code: "internal", executed: "no" } });
    expect(h.deliveries.get("hub:stall")).toBeNull();
  });

  it("is denied on a node whose policy doesn't allow pane.send, and takes no key", async () => {
    const strict = opsHarness({ home: home.home, socket: t.socket, policy: { ops: ["inventory.get", "lane.deliver"] } });
    try {
      expect(await strict.call("lane.deliver", { id: "hub:p", target: MANAGER, text: "x" })).toMatchObject({ ok: false, error: { code: "denied", executed: "no" } });
      expect(strict.deliveries.get("hub:p")).toBeNull();
    } finally {
      strict.close();
    }
    expect(await deliver({ id: "hub:k", target: MANAGER, text: "x" }, { key: "hub:k" })).toMatchObject({ ok: false, error: { code: "bad_args", message: "lane.deliver takes no key" } });
  });
});

describe("delivery.cancel", () => {
  it("gives up a queued delivery, and it stays given up; one typed is already_typed; an id it doesn't know is bad_args", async () => {
    expect(await deliver({ id: "hub:q", target: MANAGER, text: "later" })).toMatchObject({ ok: true });   // no manager window: it waits
    expect(await h.call("delivery.cancel", { id: "hub:q" })).toMatchObject({ ok: true, result: { delivery: { id: "hub:q", state: "given_up", why: "cancelled" } } });
    expect(await h.call("delivery.cancel", { id: "hub:q" })).toMatchObject({ ok: true, result: { delivery: { state: "given_up", why: "cancelled" } } });
    await claudeLane("api");
    expect(await deliver({ id: "hub:t", target: { lane: "api", sticky: false }, text: "now" })).toMatchObject({ ok: true });
    expect(await until(async () => { h.deliverer.kick("timer"); await h.deliverer.drain(); return h.deliveries.get("hub:t")?.state === "typed"; })).toBe(true);
    expect(await h.call("delivery.cancel", { id: "hub:t" })).toMatchObject({ ok: false, error: { code: "already_typed", executed: "no" } });
    expect(await h.call("delivery.cancel", { id: "hub:nothing" })).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
  });
});

describe("over the connection", () => {
  it("answers lane.deliver and delivery.cancel, and sends ev.delivery for every change", async () => {
    const own = tempHome();
    const fleet = await startFakeFleet({ welcome: { connEpoch: 2, ackSeq: 0, streamKnown: true } });
    try {
      const config = await joinedConfig(own.home, fleet, t.socket);
      const { agent } = await runAgent(config);
      try {
        await fleet.waitFor(m => m.t === "ev.inventory");
        const ev = (pred: (d: Delivery) => boolean) => (m: Msg) => m.t === "ev.delivery" && (m.delivery as Delivery).id === "hub:over" && pred(m.delivery as Delivery);
        fleet.send({ t: "req", id: "d1", op: "lane.deliver", args: { id: "hub:over", target: MANAGER, text: "for the manager" }, timeoutMs: 5000 });
        expect(await fleet.waitFor(m => m.t === "res" && m.id === "d1")).toMatchObject({ ok: true, result: { delivery: { id: "hub:over", state: "queued" } } });
        expect(await fleet.waitFor(ev(d => d.waiting?.reason === "no_pane"))).toBeTruthy();
        fleet.send({ t: "req", id: "d2", op: "delivery.cancel", args: { id: "hub:over" }, timeoutMs: 5000 });
        expect(await fleet.waitFor(m => m.t === "res" && m.id === "d2")).toMatchObject({ ok: true, result: { delivery: { state: "given_up", why: "cancelled" } } });
        expect(await fleet.waitFor(ev(d => d.state === "given_up"))).toMatchObject({ delivery: { why: "cancelled" } });
        expect(fleet.malformed).toEqual([]);
      } finally {
        await agent.stop();
      }
    } finally {
      await fleet.close();
      own.cleanup();
    }
  });
});
