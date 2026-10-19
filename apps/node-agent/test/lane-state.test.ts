// Lane state events (fleet clients spec §7; plan Contracts: the hook stream's "/lane" path): needs_input when a session's
// status turns waiting, with the question its menu asks read from the screen; answered when it leaves waiting. Both are
// appended to the durable spool. First with scripted lanes and screens on a real spool, then through a whole agent to the
// fake fleet, from a real pane's screen and a session file the test writes (claude-session.ts).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionStatus } from "@morndo/protocol";
import { openAgentDb } from "../src/db/open.ts";
import { LaneStates } from "../src/lane-state.ts";
import type { Lane } from "../src/ops/inventory.ts";
import { Spool } from "../src/relay/spool.ts";
import { joinedConfig, runAgent } from "./agent-harness.ts";
import { claudeSession } from "./claude-session.ts";
import { startFakeFleet, type Msg } from "./fake-fleet.ts";
import { captureLog, isolatedTmux, tempHome } from "./helpers.ts";

const T0 = Date.parse("2026-10-08T05:00:00.000Z");
const S1 = "2b3c4d5e-0000-4000-8000-000000000001";
const S2 = "2b3c4d5e-0000-4000-8000-000000000002";
const QUESTION = "Do you want to make this edit to login.ts?";
const MENU = ["Edit file login.ts", QUESTION, "❯ 1. Yes", "  2. Yes, allow all edits during this session", "  3. No, and tell Claude what to do differently (esc)"].join("\n");

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const lane = (window: string, n: number, sessionId: string | null, status: SessionStatus | null): Lane =>
  ({ workerId: `pc.0a1b2c3d.${n}`, pane: `%${n}`, windowId: `@${n}`, window, sessionId, status, pid: sessionId === null ? null : 4000 + n });

function rig(o: { failWrites?: boolean } = {}) {
  const h = tempHome();
  const adb = openAgentDb(join(h.home, "agent.db"));
  cleanups.push(() => { adb.close(); h.cleanup(); });
  const spool = new Spool(adb.db, adb.streamId, { failWrites: o.failWrites === true });
  const screens = new Map<string, string>();
  const looks: string[] = [];
  const counts = { kicks: 0, appended: 0 };
  const logged = captureLog();
  const states = new LaneStates({
    spool, now: () => T0, log: logged.log, retryMs: 10,
    appended: () => { counts.appended++; }, changed: () => { counts.kicks++; },
    screen: async pane => { looks.push(pane); return screens.get(pane) ?? null; },
  });
  const events = () => spool.after(0, 100).map(e => ({ path: e.path, at: e.at, window: e.window, body: e.body }));
  return { states, spool, screens, looks, counts, events, lines: logged.lines };
}

describe("lane state events (unit)", () => {
  it("appends needs_input when a session turns waiting, with the question its menu asks, and answered when it leaves waiting, each as /lane", async () => {
    const r = rig();
    await r.states.observe([lane("api", 1, S1, "idle")]);
    expect(r.events()).toEqual([]);
    r.screens.set("%1", MENU);
    await r.states.observe([lane("api", 1, S1, "waiting")]);
    await r.states.observe([lane("api", 1, S1, "waiting")]);                  // still waiting: nothing more
    await r.states.observe([lane("api", 1, S1, "busy")]);
    expect(r.events()).toEqual([
      { path: "/lane", at: T0, window: "api", body: { event: "needs_input", sessionId: S1, question: QUESTION } },
      { path: "/lane", at: T0, window: "api", body: { event: "answered", sessionId: S1 } },
    ]);
    expect(r.counts.appended).toBe(2);
  });

  it("sends needs_input for a session first seen waiting (at least once, as after an agent start), and answered for one gone while waiting", async () => {
    const r = rig();
    r.screens.set("%2", MENU);
    await r.states.observe([lane("web", 2, S2, "waiting")]);
    await r.states.observe([]);                                                 // its window closed while it asked
    expect(r.events().map(e => [e.window, e.body])).toEqual([
      ["web", { event: "needs_input", sessionId: S2, question: QUESTION }],
      ["web", { event: "answered", sessionId: S2 }],
    ]);
  });

  it("looks once more for the question, and sends needs_input without one when the screen shows none", async () => {
    const r = rig();
    await r.states.observe([lane("api", 1, S1, "waiting")]);
    expect(r.looks).toEqual(["%1", "%1"]);
    expect(r.events().map(e => e.body)).toEqual([{ event: "needs_input", sessionId: S1 }]);
  });

  it("kicks the deliverer when a status changes, never on a poll that changed nothing; a pane without a session makes no lane event", async () => {
    const r = rig();
    const shell = lane("shell", 3, null, null);
    await r.states.observe([lane("api", 1, S1, "idle"), shell]);
    await r.states.observe([lane("api", 1, S1, "idle"), shell]);
    expect(r.counts.kicks).toBe(1);
    await r.states.observe([lane("api", 1, S1, "busy"), shell]);
    expect(r.counts.kicks).toBe(2);
    expect(r.events()).toEqual([]);
  });

  it("never throws when the spool can't be written: a warning, and a drop the health reports", async () => {
    const r = rig({ failWrites: true });
    r.screens.set("%1", MENU);
    await expect(r.states.observe([lane("api", 1, S1, "waiting")])).resolves.toBeUndefined();
    expect(r.spool.drops).toBe(1);
    expect(r.lines.some(l => l.includes("could not be spooled"))).toBe(true);
  });
});

describe("lane state events through the agent", () => {
  const laneEvent = (event: string) => (m: Msg) => {
    const e = m.event as { path?: string; body?: { event?: string } } | undefined;
    return m.t === "ev.hook" && e?.path === "/lane" && e.body?.event === event;
  };

  it("go to the fleet as hook events on /lane, from a real pane's session state and screen", async () => {
    const h = tempHome();
    const t = isolatedTmux();
    const fleet = await startFakeFleet({ welcome: { connEpoch: 3, ackSeq: 0, streamKnown: true } });
    cleanups.push(async () => { await fleet.close(); await t.kill(); h.cleanup(); });
    const config = await joinedConfig(h.home, fleet, t.socket);
    const menu = join(h.home, "menu.txt");
    writeFileSync(menu, `${MENU}\n`);
    const pane = t.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "main", "-n", "api", "-x", "120", "-y", "30", `cat '${menu}'; exec sleep 600`).trim();
    const session = claudeSession({ tmux: t, claudeDir: join(h.home, ".claude"), pane, sessionId: S1 });
    session.status("idle");
    const { agent } = await runAgent(config);
    cleanups.push(() => agent.stop());
    await fleet.waitFor(m => m.t === "ev.inventory");
    session.status("waiting");
    expect(await fleet.waitFor(laneEvent("needs_input"), 10_000))
      .toMatchObject({ event: { path: "/lane", node: "pc", window: "api", body: { event: "needs_input", sessionId: S1, question: QUESTION } } });
    session.status("busy");
    expect(await fleet.waitFor(laneEvent("answered"), 10_000)).toMatchObject({ event: { path: "/lane", window: "api", body: { event: "answered", sessionId: S1 } } });
    expect(fleet.malformed).toEqual([]);
  });

  it("are never taken from outside: the relay answers /lane with 404, so no hook script can make one", async () => {
    const h = tempHome();
    const t = isolatedTmux();
    const fleet = await startFakeFleet();
    cleanups.push(async () => { await fleet.close(); await t.kill(); h.cleanup(); });
    const config = await joinedConfig(h.home, fleet, t.socket);
    const { agent, post } = await runAgent(config);
    cleanups.push(() => agent.stop());
    expect((await post("/lane", { event: "needs_input", sessionId: S1, question: "made up?" })).status).toBe(404);
    expect(agent.spool.depth()).toBe(0);
  });
});
