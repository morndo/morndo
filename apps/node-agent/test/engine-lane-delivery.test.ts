// Briefs to a lane of another engine (ADR-0030), on a real isolated tmux server and the agent's own op side, with a stand-in
// for the engine layer's `engine-lane` (fake-engine-lane.fixture.ts) as the pane's program. The node must find the lane's
// session where the engine layer records it, type into its input line, and read the receipt from its transcript.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS, type DeliveryTarget } from "@morndo/protocol";
import { isolatedTmux, tempHome, until, type TestTmux } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

const FIXTURE = join(import.meta.dirname, "fake-engine-lane.fixture.ts");
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let h: Harness;
let box = "";
const submitted = () => (existsSync(join(box, "submitted.jsonl"))
  ? readFileSync(join(box, "submitted.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as string) : []);
const laneOf = (name: string) => h.inventory.last().lanes.find(l => l.window === name);
const kickUntil = (done: () => boolean, ms = 15_000) =>
  until(async () => { await h.inventory.refresh(); h.deliverer.kick("hook"); await h.deliverer.drain(); return done(); }, ms, 100);
const windows = () => t.tmux("list-windows", "-t", "=main", "-F", "#{window_name}").trim().split("\n");

// The lane runs under a shell, as a launcher does: the pane's process is the shell, the lane its child.
function startLane(name: string, ...flags: string[]): string {
  const line = `${process.execPath} ${FIXTURE} ${home.home} ${box} ${flags.join(" ")}; sleep 30`;
  return t.tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "=main:", "-n", name, "sh", "-c", line).trim();
}
// The lane is the pane's own program: its window closes when it ends.
function startBareLane(name: string): string {
  return t.tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "=main:", "-n", name, process.execPath, FIXTURE, home.home, box).trim();
}

beforeEach(async () => {
  vi.stubEnv("ENGINES_SESSIONS", "");
  vi.stubEnv("ENGINES_TRANSCRIPTS", "");
  home = tempHome();
  t = isolatedTmux();
  box = join(home.home, "box");
  t.tmux("new-session", "-d", "-s", "main", "-n", "base", "-x", "120", "-y", "30", "sleep 600");
  mkdirSync(box, { recursive: true });
  h = opsHarness({ home: home.home, socket: t.socket });
});
afterEach(async () => { h.deliverer.stop(); await h.deliverer.drain(); h.close(); await t.kill(); home.cleanup(); vi.unstubAllEnvs(); });

describe("an engine lane takes briefs", () => {
  it("shows up in the inventory with its session, status and stable id", async () => {
    startLane("codex-a");
    expect(await until(async () => { await h.inventory.refresh(); return laneOf("codex-a")?.sessionId != null; })).toBe(true);
    const lane = laneOf("codex-a");
    expect(lane).toMatchObject({ sessionId: expect.stringMatching(/^engine-\d+-\d+$/), status: "idle" });
    expect(h.inventory.last().panes.find(p => p.window === "codex-a")).toMatchObject({ sessionId: lane?.sessionId, sessionName: "codex-a", status: "idle" });
    expect(h.registry.transcriptPath(lane!.sessionId!)).toBeNull();            // the lane writes it with its first message
    expect(h.deliverer.enqueue({ id: "lanes:t1", target: { lane: "codex-a", sticky: false }, text: "ping" })).toMatchObject({ delivery: { state: "queued" } });
    expect(await kickUntil(() => h.deliveries.get("lanes:t1")?.state === "delivered")).toBe(true);
    expect(h.registry.transcriptPath(lane!.sessionId!)).toMatch(/codex-a-[0-9a-f-]+\.jsonl$/);
  });

  it("delivers a one-line and a multi-line brief sent by lane name, each marked delivered by the lane's own transcript", async () => {
    startLane("codex-b");
    const target: DeliveryTarget = { lane: "codex-b", sticky: false };
    const brief = "Build the demo\n\nFirst: read the notes.\nThen: write the code.";
    expect(await until(async () => { await h.inventory.refresh(); return laneOf("codex-b")?.sessionId != null; })).toBe(true);
    expect(h.deliverer.enqueue({ id: "lanes:e1", target, text: "ping" })).toMatchObject({ delivery: { state: "queued" } });
    expect(h.deliverer.enqueue({ id: "lanes:e2", target, text: brief })).toMatchObject({ delivery: { state: "queued" } });
    expect(await kickUntil(() => h.deliveries.get("lanes:e1")?.state === "delivered" && h.deliveries.get("lanes:e2")?.state === "delivered")).toBe(true);
    expect(submitted()).toEqual(["ping", brief]);
  }, 30_000);

  it("delivers a brief of maxMessageText characters whole, and marks it delivered from the lane's own transcript", async () => {
    startLane("codex-long");
    const target: DeliveryTarget = { lane: "codex-long", sticky: false };
    expect(await until(async () => { await h.inventory.refresh(); return laneOf("codex-long")?.sessionId != null; })).toBe(true);
    const brief = 'ü€"\n'.repeat(24_999) + 'ü€".';                // exactly maxMessageText, with what a paste must survive
    expect(brief).toHaveLength(LIMITS.maxMessageText);
    expect(h.deliverer.enqueue({ id: "lanes:long", target, text: brief })).toMatchObject({ delivery: { state: "queued" } });
    expect(await kickUntil(() => h.deliveries.get("lanes:long")?.state === "delivered", 30_000)).toBe(true);
    expect(submitted()).toEqual([brief]);
  }, 60_000);

  it("does not lose a brief sent while a turn runs and the engine renames the lane's session under it", async () => {
    startLane("codex-c", "--busy", "1500");
    const target: DeliveryTarget = { lane: "codex-c", sticky: false };
    expect(await until(async () => { await h.inventory.refresh(); return laneOf("codex-c")?.sessionId != null; })).toBe(true);
    const id = laneOf("codex-c")!.sessionId;
    h.deliverer.enqueue({ id: "lanes:b1", target, text: "first brief" });
    expect(await kickUntil(() => h.deliveries.get("lanes:b1")?.state === "delivered")).toBe(true);
    expect(await until(async () => { await h.inventory.refresh(); return laneOf("codex-c")?.status === "busy"; })).toBe(true);
    // The second brief is bound to the session shown now; the turn ends and the lane's file names another session.
    h.deliverer.enqueue({ id: "lanes:b2", target, text: "second brief" });
    expect(await kickUntil(() => h.deliveries.get("lanes:b2")?.state === "delivered")).toBe(true);
    expect(submitted()).toEqual(["first brief", "second brief"]);
    expect(laneOf("codex-c")?.sessionId).toBe(id);
    expect(h.deliveries.get("lanes:b2")?.state).not.toBe("given_up");
  }, 30_000);

  it("takes the first prompt of lane.start: it waits for the lane's session, then is delivered", async () => {
    const hs = opsHarness({ home: home.home, socket: t.socket, policy: { launch: { command: ["sh", "-c", `${process.execPath} ${FIXTURE} ${home.home} ${box}; sleep 30`], via: "direct" } } });
    try {
      const r = await hs.call("lane.start", { name: "codex-d", cwd: home.home, prompt: "Start with the tests" }, { key: "lanes:s1" });
      expect(r).toMatchObject({ ok: true });
      const prompt = (r as { result: { prompt: string } }).result.prompt;
      expect(await until(async () => { await hs.inventory.refresh(); hs.deliverer.kick("status"); await hs.deliverer.drain(); return hs.deliveries.get(prompt)?.state === "delivered"; }, 15_000, 100)).toBe(true);
      expect(submitted()).toEqual(["Start with the tests"]);
      hs.deliverer.stop();
      await hs.deliverer.drain();
    } finally { hs.close(); }
  }, 30_000);

  it("is no engine lane while its shell has the terminal (Ctrl-Z): nothing is typed into the shell (negative control)", async () => {
    t.tmux("new-window", "-d", "-t", "=main:", "-n", "codex-z", "bash", "--norc", "--noprofile", "-i");
    const target = "=main:codex-z";
    expect(await until(() => t.tmux("capture-pane", "-p", "-t", target).includes("$"))).toBe(true);
    t.tmux("send-keys", "-t", target, "-l", `${process.execPath} ${FIXTURE} ${home.home} ${box}`);
    t.tmux("send-keys", "-t", target, "Enter");
    expect(await until(async () => { await h.inventory.refresh(); return laneOf("codex-z")?.sessionId != null; })).toBe(true);
    t.tmux("send-keys", "-t", target, "C-z");
    expect(await until(async () => { await h.inventory.refresh(); return laneOf("codex-z")?.sessionId == null; })).toBe(true);
    // The lane's process and its file are still there; the shell prompt is the last line on screen.
    expect(h.deliverer.enqueue({ id: "lanes:z1", target: { lane: "codex-z", sticky: false }, text: "echo MARK$((40+2))" })).toMatchObject({ delivery: { state: "queued" } });
    for (let i = 0; i < 4; i++) { await h.inventory.refresh(); h.deliverer.kick("hook"); await h.deliverer.drain(); }
    expect(h.deliveries.get("lanes:z1")).toMatchObject({ state: "queued", waiting: { reason: "no_session" } });
    expect(t.tmux("capture-pane", "-p", "-t", target)).not.toContain("MARK42");
    expect(submitted()).toEqual([]);
  }, 30_000);

  it("stops with /exit, no kill needed", async () => {
    startBareLane("codex-e");
    expect(await until(async () => { await h.inventory.refresh(); return laneOf("codex-e")?.sessionId != null; })).toBe(true);
    const r = await h.call("lane.stop", { name: "codex-e" }, { key: "lanes:x1" });
    expect(r).toMatchObject({ ok: true });
    expect(submitted()).toEqual(["/exit"]);
    expect(await until(() => !windows().includes("codex-e"), 10_000)).toBe(true);
  }, 30_000);
});
