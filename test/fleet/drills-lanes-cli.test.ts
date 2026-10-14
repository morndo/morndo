// `morndo lanes` against a real fleet and a real node agent (plan/RECONCILIATION.md ruling 57; fleet clients spec §9.2):
// the console command as its own child process (`node apps/hub/src/main.ts lanes …`, MORNDO_FLEET_SOCKET set, a temporary
// HOME), a real fleet and agent (test/fleet-harness.ts: random ports, an isolated tmux server), and a lane that is the fake
// input box (test/fixtures/fake-claude-pane.ts). It covers list, peek, keys, send (with --wait), status, start and stop,
// events (one lane event seen, then SIGTERM), and the exits (README §9.2, ruling 49):
// - 5, in doubt: the fleet took the POST and never answered. The fleet's process is stopped (SIGSTOP) while the command
//   sends: the kernel still accepts the connection on the fleet's socket and takes the request, and no answer comes. Once the
//   fleet runs again it reads the request after all, so the delivery may be queued: sent again under the same --id, it is
//   typed once (a delivery's id is its idempotency);
// - 69: the fleet wasn't reached (no socket there), nothing queued;
// - 4 and 2: an unknown delivery, a key name not on the allow-list.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FAKE_CLAUDE, HUB_MAIN, cleanEnv, fakeLane, hook, joinAgent, paneOf, startFleet, stopAll, submittedAt, tempDir, tmuxServer, until,
  updatePolicy, type Fleet,
} from "../fleet-harness.ts";

afterEach(stopAll);

type Run = { code: number | null; out: string; err: string };
type Live = { out(): string; done: Promise<Run>; stop(signal: NodeJS.Signals): Promise<Run> };

// `morndo lanes <args>` as the owner runs it: its own process, the fleet's socket, a HOME of its own (it reads no hub setting).
function live(fleet: Fleet | null, args: string[], o: { socket?: string; stdin?: string } = {}): Live {
  const home = tempDir("morndo-lanes-cli-");
  const child = spawn(process.execPath, ["--no-warnings", HUB_MAIN, "lanes", ...args], {
    env: cleanEnv(home, { MORNDO_FLEET_SOCKET: o.socket ?? fleet?.socketPath ?? "" }), stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
  child.stderr.on("data", (d: Buffer) => { err += d.toString("utf8"); });
  child.stdin.end(o.stdin ?? "");
  const done = new Promise<Run>(resolve => child.once("close", code => resolve({ code, out, err })));
  return {
    out: () => out,
    done,
    async stop(signal) { child.kill(signal); return done; },
  };
}
// Runs to its end (at most 60 s: its own --wait is shorter).
async function lanes(fleet: Fleet | null, args: string[], o: { socket?: string; stdin?: string } = {}): Promise<Run> {
  const run = live(fleet, args, o);
  const timer = setTimeout(() => void run.stop("SIGKILL"), 60_000);
  try { return await run.done; }
  finally { clearTimeout(timer); }
}

// One node, n1, with one lane running the box, w1, idle; lanes it starts run the box too (launch.via "direct").
async function office() {
  const fleet = await startFleet();
  const tmux = tmuxServer();
  const agent = await joinAgent(fleet, "n1", { tmux });
  updatePolicy(agent, {
    launch: { command: [process.execPath, "--no-warnings", FAKE_CLAUDE, ".", `--claude=${join(agent.home, ".claude")}`, "--session=auto"], via: "direct" },
  });
  const w1 = await fakeLane(tmux, { window: "w1", claudeHome: agent.home });
  await agent.run();
  await agent.waitOnline();
  await until("w1 idle in n1's inventory", async () => (await paneOf(fleet.client, "n1", "w1")).status === "idle", 15_000);
  return { fleet, tmux, agent, w1 };
}
const times = (xs: string[], x: string) => xs.filter(t => t === x).length;

describe("morndo lanes against a real fleet and agent", () => {
  it("lists, peeks and presses keys by name", async () => {
    const o = await office();
    const listed = await lanes(o.fleet, ["--json"]);
    expect(listed.code).toBe(0);
    expect((JSON.parse(listed.out) as { name: string; node: string; status: string | null; online: boolean }[]).find(r => r.name === "w1"))
      .toMatchObject({ node: "n1", status: "idle", online: true });
    const peek = await lanes(o.fleet, ["peek", "w1", "--lines", "30"]);   // the whole 30-row screen: the box is drawn at its top
    expect(peek).toMatchObject({ code: 0 });
    expect(peek.out).toContain("❯");
    expect(await lanes(o.fleet, ["keys", "w1", "x"])).toMatchObject({ code: 0, out: expect.stringContaining("x sent to w1") });
    await until("the x in w1's box", () => /❯ x\s*$/m.test(o.w1.screen()));
    expect((await lanes(o.fleet, ["keys", "w1", "C-u"])).code).toBe(0);
    await until("w1's box empty again", () => !/❯ x\s*$/m.test(o.w1.screen()));
    expect((await lanes(o.fleet, ["keys", "w1", "Hyper"])).code).toBe(2);   // not on the allow-list: nothing sent
  });

  it("send --wait: delivered, typed once; status says so; an unknown id is exit 4", async () => {
    const o = await office();
    const sent = await lanes(o.fleet, ["send", "w1", "from morndo lanes", "--id", "drill-send", "--wait", "30"]);
    expect(sent).toMatchObject({ code: 0, out: expect.stringContaining("lanes:drill-send: delivered") });
    expect(o.w1.submitted()).toEqual(["from morndo lanes"]);
    expect(await lanes(o.fleet, ["status", "lanes:drill-send"])).toMatchObject({ code: 0, out: expect.stringContaining("lanes:drill-send: delivered") });
    expect((await lanes(o.fleet, ["status", "lanes:no-such-delivery"])).code).toBe(4);
    const piped = await lanes(o.fleet, ["send", "w1", "-", "--id", "drill-stdin", "--wait", "30"], { stdin: "from stdin\n" });
    expect(piped.code).toBe(0);
    expect(o.w1.submitted()).toEqual(["from morndo lanes", "from stdin"]);   // the last newline isn't part of the text
  });

  it("start with a first prompt, then stop: the prompt typed once, the window closed", async () => {
    const o = await office();
    const cwd = tempDir("morndo-lanes-cli-w2-");
    const started = await lanes(o.fleet, ["start", "w2", "--cwd", cwd, "--node", "n1", "--prompt", "first words", "--json"]);
    expect(started.code).toBe(0);
    const result = JSON.parse(started.out) as { node: string; workerId: string; prompt: string };
    expect(result).toMatchObject({ node: "n1", prompt: expect.stringMatching(/^lanes:prompt:[0-9a-f]{16}$/) });   // ruling 7
    await until("the first prompt delivered", async () => (await lanes(o.fleet, ["status", result.prompt])).out.includes(": delivered"), 30_000, 500);
    expect(submittedAt(cwd)).toEqual(["first words"]);
    expect(await lanes(o.fleet, ["stop", "w2"])).toMatchObject({ code: 0, out: expect.stringContaining("stopped w2") });
    expect(o.tmux.run("list-windows", "-t", "=qa", "-F", "#{window_name}").split("\n")).not.toContain("w2");
  });

  it("events: prints a lane event as it happens, and ends with 0 on SIGTERM", async () => {
    const o = await office();
    const ev = live(o.fleet, ["events"]);
    // The command's subscription opens on its own time: a turn's end is posted every 2 s until one is printed.
    await until("a lane event printed by morndo lanes events", async () => {
      if (ev.out().includes("w1@n1 finished")) return true;
      await hook(o.agent, "/hook/stop", { session_id: o.w1.sessionId, transcript_path: o.w1.transcript, cwd: o.w1.dir, permission_mode: "default",
        hook_event_name: "Stop", last_assistant_message: "STATUS: DONE\nseen by morndo lanes", background_tasks: [], session_crons: [] });
      return false;
    }, 30_000, 2000);
    const end = await ev.stop("SIGTERM");
    expect(end.code).toBe(0);
    expect(end.out).toMatch(/w1@n1 finished done STATUS: DONE/);
  });

  it("in doubt (the fleet took the POST and never answered): exit 5; the same --id sent again is typed once", async () => {
    const o = await office();
    o.fleet.proc().pause();                                           // SIGSTOP: the socket still takes the request
    let first: Run;
    try { first = await lanes(o.fleet, ["send", "w1", "maybe queued", "--id", "drill-doubt"]); }
    finally { o.fleet.proc().resume(); }
    expect(first.code).toBe(5);
    expect(first.err).toContain("lanes:drill-doubt");                 // the line names the id to send again
    await o.fleet.client.caps();                                      // the fleet answers again
    const again = await lanes(o.fleet, ["send", "w1", "maybe queued", "--id", "drill-doubt", "--wait", "30"]);
    expect(again).toMatchObject({ code: 0, out: expect.stringContaining("lanes:drill-doubt: delivered") });
    await new Promise(r => setTimeout(r, 7000));                       // past one more try of the node's queue
    expect(times(o.w1.submitted(), "maybe queued")).toBe(1);
  });

  it("the fleet not reached (no socket there): exit 69, nothing queued", async () => {
    const run = await lanes(null, ["send", "w1", "nowhere", "--id", "drill-nowhere"], { socket: join(tempDir("morndo-lanes-cli-none-"), "fleet.sock") });
    expect(run.code).toBe(69);
  });
});
