// Lane drills (fleet clients spec §12 "Drills"; §4.1 targets, §4.6 sticky names, §5 the launcher): a real fleet and a
// real agent, lanes that are the fake input box (test/fixtures/fake-claude-pane.ts), an isolated tmux server.
// - A delivery to "manager" (a sticky name) waits through a manager restart, with no window and then no session yet, and
//   goes to the new pane: the fleet routes the name to the node that last had it.
// - A delivery to any other name is bound to that lane's session when queued: if a new session takes the name, it is
//   given up (gone), never typed into the new conversation.
// - lane.start through the shell (launch.via "shell"): the CLI runs on a shell that outlives it (so claude-pool can still
//   move the lane), and its first prompt waits for the CLI to start, then is typed once.
// Negative control (spec §12: "without the session binding, a message lands in the new lane"): noSessionBinding.
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestHooks } from "../../apps/node-agent/src/test-hooks.ts";
import { LIMITS } from "../../packages/protocol/src/fleet.ts";
import { parseWorkerId } from "../../packages/protocol/src/worker-id.ts";
import {
  FAKE_CLAUDE, controlAt, fakeLane, joinAgent, paneOf, sleep, startFleet, stopAll, submittedAt, tempDir, tmuxServer, until,
  updatePolicy, watchDeliveries,
} from "../fleet-harness.ts";

afterEach(stopAll);

const newId = (what: string) => `lanes:drill-${what}-${randomUUID().slice(0, 8)}`;
const PAST_A_TRY = LIMITS.deliveryTryMs + 2000;

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
// A delivery to w1 queued while w1 shows a menu, so it waits there, bound to w1's session as it is now.
async function queuedBehindMenu(o: Office, text: string): Promise<string> {
  await o.w1.control({ status: "waiting" });
  await until("w1 waiting in n1's inventory", async () => (await paneOf(o.fleet.client, "n1", "w1")).status === "waiting", 15_000);
  const id = newId("bound");
  await o.fleet.client.deliver({ id, lane: "w1", text });
  await o.watch.until(id, d => d.waiting?.reason === "menu_open");
  return id;
}

describe("where a delivery goes when the lane behind its name changes", () => {
  it("to the manager (a sticky name): it waits through the manager's restart and goes to the new pane", async () => {
    const fleet = await startFleet();                                // stickyLanes: ["manager"], the default
    const tmux = tmuxServer();
    const agent = await joinAgent(fleet, "n1", { tmux });
    const old = await fakeLane(tmux, { window: "manager", claudeHome: agent.home });
    await agent.run();
    await agent.waitOnline();
    const watch = await watchDeliveries(fleet);
    const first = newId("before");
    await fleet.client.deliver({ id: first, lane: "manager", text: "before the restart" });
    await watch.until(first, d => d.state === "delivered");
    tmux.run("kill-window", "-t", old.paneId);
    await until("manager gone from the fleet's lanes", async () => !(await fleet.client.lanes()).some(l => l.name === "manager"), 15_000);
    const id = newId("sticky");
    const queued = await fleet.client.deliver({ id, lane: "manager", text: "for whichever manager runs" });
    expect(queued).toMatchObject({ node: "n1", state: "queued", target: { lane: "manager" } });
    await watch.until(id, d => d.waiting?.reason === "no_pane");
    const fresh = await fakeLane(tmux, { window: "manager", claudeHome: agent.home, startDelayMs: 4000, wait: false });
    const done = await watch.until(id, d => d.state === "delivered", 45_000);
    expect(done.sessionId).toBe(fresh.sessionId);
    expect(fresh.submitted()).toEqual(["for whichever manager runs"]);
    expect(old.submitted()).toEqual(["before the restart"]);
  });

  it("to another name: bound to that lane's session, it is given up (gone) when a new session takes the name", async () => {
    const o = await office();
    const id = await queuedBehindMenu(o, "for the first w1 only");
    expect((await o.fleet.client.delivery(id))?.sessionId).toBe(o.w1.sessionId);
    o.tmux.run("kill-window", "-t", o.w1.paneId);
    const next = await fakeLane(o.tmux, { window: "w1", claudeHome: o.agent.home });
    await o.watch.until(id, d => d.state === "given_up" && d.why === "gone", 30_000);
    await sleep(PAST_A_TRY);
    expect(next.submitted()).toEqual([]);
  });

  it("(negative control) without the session binding, the message lands in the new lane", async () => {
    const o = await office({ noSessionBinding: true });
    await queuedBehindMenu(o, "for the first w1 only, unbound");
    o.tmux.run("kill-window", "-t", o.w1.paneId);
    const next = await fakeLane(o.tmux, { window: "w1", claudeHome: o.agent.home });
    await until("the text in the new w1", () => next.submitted().includes("for the first w1 only, unbound"), 30_000);
  });
});

describe("lane.start through the shell", () => {
  it("the CLI runs on a shell that outlives it; the first prompt waits for the CLI to start, and is typed once", async () => {
    const fleet = await startFleet();
    const tmux = tmuxServer();
    const agent = await joinAgent(fleet, "n1", { tmux });
    // The lane's shell is bash with a plain prompt, in the agent's HOME, never the account's own shell setup: tmux gives a
    // new window its server's global environment, and this test started the server, so HOME, SHELL and the default shell
    // are set on it (tmux(1): set-environment -g, default-shell; https://man7.org/linux/man-pages/man1/tmux.1.html, read
    // 2026-10-08). The rc files cover a login and an interactive start alike.
    for (const rc of [".bash_profile", ".bashrc", ".profile", ".zshrc"]) writeFileSync(join(agent.home, rc), "PS1='$ '\n");
    tmux.run("new-session", "-d", "-s", "qa", "-n", "keeper", "sleep", "600");
    tmux.run("set-option", "-g", "default-shell", "/bin/bash");
    tmux.run("set-environment", "-g", "HOME", agent.home);
    tmux.run("set-environment", "-g", "SHELL", "/bin/bash");
    updatePolicy(agent, {
      launch: {
        command: [process.execPath, "--no-warnings", FAKE_CLAUDE, ".", `--claude=${join(agent.home, ".claude")}`, "--session=auto", "--start-delay=4000"],
        via: "shell",
      },
    });
    await agent.run(undefined, { env: { SHELL: "/bin/bash" } });
    await agent.waitOnline();
    const watch = await watchDeliveries(fleet);
    const cwd = tempDir("morndo-started-");
    // The key's namespace is the harness client's own name ("hub"), so the prompt's id is the same whichever of the two
    // ruling 7's <client> means.
    const key = `hub:drill-start-${randomUUID().slice(0, 8)}`;
    const promptId = `hub:prompt:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;   // ruling 7
    const r = await fleet.client.op({ node: "n1" }, "lane.start", { name: "s1", cwd, prompt: "first words" }, { key, timeoutMs: 60_000 });
    if (!r.ok) throw new Error(`lane.start: ${r.error.code}: ${r.error.message}`);
    expect(r.result.prompt).toBe(promptId);
    const pane = `%${parseWorkerId(r.result.workerId)?.pane ?? -1}`;
    const current = () => tmux.run("display-message", "-p", "-t", pane, "#{pane_current_command}").trim();
    await until("the box running in s1", () => current() === "node", 20_000);
    await watch.until(promptId, d => d.state === "delivered", 60_000);
    expect(watch.states(promptId).some(d => d.waiting?.reason === "no_session")).toBe(true);   // it waited for the CLI
    expect(submittedAt(cwd)).toEqual(["first words"]);
    await controlAt(cwd, { exit: true });                                // the CLI exits…
    await until("s1 back at its shell", () => /^-?(bash|sh)$/.test(current()), 15_000);
    expect(tmux.run("list-windows", "-t", "=qa", "-F", "#{window_name}").split("\n")).toContain("s1");   // …and the window stays
    expect(tmux.run("capture-pane", "-p", "-t", pane)).not.toContain("first words");   // the shell never ran the prompt
  }, 120_000);
});
