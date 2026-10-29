// The deliverer on a real isolated tmux server, typing through the agent's own executor into the agent's fake box
// (fake-claude.fixture.ts). The Claude Code session is the test's (claude-session.ts): the box's submitted lines become
// the transcript's prompts, the receipts the deliverer reads. Covered: plan Review Focus 2, with the bytes the pane
// received; a draft waited through; a `started` key from before a restart, with its negative control; and when a pane's
// process started, for the start grace (RECONCILIATION.md ruling 14).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS, type Delivery } from "@morndo/protocol";
import { ProcessStarts, startFromProcStat } from "../src/deliveries/views.ts";
import { argsHash } from "../src/ops/done-keys.ts";
import type { TestHooks } from "../src/test-hooks.ts";
import { claudeSession } from "./claude-session.ts";
import { isolatedTmux, tempHome, until, wait, type TestTmux } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

const FIXTURE = join(import.meta.dirname, "fake-claude.fixture.ts");
const MANAGER = { lane: "manager", sticky: true } as const;
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let h: Harness;
let pane = "";
let stopFollowing = () => {};
let emitted: Delivery[] = [];
const box = () => join(home.home, "box");
const submitted = () => (existsSync(join(box(), "submitted.jsonl"))
  ? readFileSync(join(box(), "submitted.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as string) : []);
const screen = () => t.tmux("capture-pane", "-p", "-t", pane);
const harness = (hooks?: TestHooks) => opsHarness({ home: home.home, socket: t.socket, emitDelivery: d => { emitted.push(d); }, ...(hooks ? { hooks } : {}) });

beforeEach(async () => {
  home = tempHome();
  t = isolatedTmux();
  emitted = [];
  mkdirSync(box(), { recursive: true });
  pane = t.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "main", "-n", "manager", "-x", "120", "-y", "30",
    `${process.execPath} ${FIXTURE} ${box()}`).trim();
  expect(await until(() => screen().includes("❯"))).toBe(true);
  const session = claudeSession({ tmux: t, claudeDir: join(home.home, ".claude"), pane });
  session.status("idle");
  stopFollowing = session.follow(box());
  h = harness();
  await h.inventory.refresh();
});
afterEach(async () => { stopFollowing(); h.deliverer.stop(); await h.deliverer.drain(); h.close(); await t.kill(); home.cleanup(); });

// Rounds as the hooks and the inventory kick them, until `done` (15 s at most).
const kickUntil = (done: () => boolean, ms = 15_000) =>
  until(async () => { await h.inventory.refresh(); h.deliverer.kick("hook"); await h.deliverer.drain(); return done(); }, ms, 100);
// The bracketed-paste marks in the bytes a pane received, in order: "0" opens a paste (ESC[200~), "1" closes one (ESC[201~).
function brackets(raw: string): string {
  let out = "";
  for (let i = raw.indexOf("\u001b[20"); i !== -1; i = raw.indexOf("\u001b[20", i + 1)) {
    const mark = raw.slice(i + 4, i + 6);
    if (mark === "0~" || mark === "1~") out += mark[0];
  }
  return out;
}
const managerLane = () => {
  const lane = h.inventory.last().lanes.find(l => l.window === "manager");
  if (!lane) throw new Error("no manager lane");
  return lane;
};

describe("the deliverer through the executor, on real tmux", () => {
  it("types three senders' deliveries to one lane one at a time, in the order stored, never two pastes together, each confirmed by its own receipt (Review Focus 2)", async () => {
    const sent = [
      { id: "kira:tap-1", text: "kira: the owner tapped approve" },
      { id: "hub:answer:e1:a1:ship", text: "Answer: ship it" },
      { id: "fleet:lane-events:pc:1", text: "[lane-event] Lane events (handle them as your instructions say):\n{\"lane\":\"api\",\"event\":\"finished\"}" },
    ];
    for (const s of sent) expect(h.deliverer.enqueue({ id: s.id, target: MANAGER, text: s.text })).toMatchObject({ delivery: { state: "queued" } });
    expect(await kickUntil(() => sent.every(s => h.deliveries.get(s.id)?.state === "delivered"))).toBe(true);
    expect(submitted()).toEqual(sent.map(s => s.text));
    // The bytes the pane received: each bracketed paste closed before the next opened.
    expect(brackets(readFileSync(join(box(), "raw.bin"), "latin1"))).toBe("010101");
    // One at a time: each typed only once the one before it was delivered, and waiting `earlier` meanwhile.
    expect(emitted.filter(d => d.state === "typed").map(d => d.id)).toEqual(sent.map(s => s.id));
    for (const [i, s] of sent.entries()) {
      const before = sent[i - 1];
      if (before) expect(h.deliveries.get(s.id)?.typedAt ?? 0).toBeGreaterThanOrEqual(h.deliveries.get(before.id)?.deliveredAt ?? Infinity);
    }
    expect(emitted.some(d => d.id === sent[2]?.id && d.waiting?.reason === "earlier")).toBe(true);
  }, 30_000);

  it("types a whole maxMessageText message, multi-line and single-line, as one paste each; the receipt matches it wrapped (Review Focus 2)", async () => {
    const multi = 'ü€"\n'.repeat(25_000);                   // exactly maxMessageText, over many lines
    const single = "ü".repeat(LIMITS.maxMessageText);
    for (const [id, text] of [["hub:long-m", multi], ["hub:long-s", single]] as const)
      expect(h.deliverer.enqueue({ id, target: MANAGER, text })).toMatchObject({ delivery: { state: "queued" } });
    expect(await kickUntil(() => ["hub:long-m", "hub:long-s"].every(id => h.deliveries.get(id)?.state === "delivered"))).toBe(true);
    expect(submitted()).toEqual([multi, single]);
    // The bytes the pane received: one bracketed paste per message, each closed before the next opened.
    expect(brackets(readFileSync(join(box(), "raw.bin"), "latin1"))).toBe("0101");
  }, 60_000);

  it("waits through a draft in the box (draft_present), and types once it is cleared", async () => {
    t.tmux("send-keys", "-t", pane, "-l", "half");
    expect(await until(() => screen().includes("❯ half"))).toBe(true);
    await h.deliverer.enqueue({ id: "hub:d1", target: MANAGER, text: "the message" });
    await h.deliverer.drain();
    expect(h.deliveries.get("hub:d1")).toMatchObject({ state: "queued", waiting: { reason: "draft_present" } });
    t.tmux("send-keys", "-t", pane, "BSpace", "BSpace", "BSpace", "BSpace");
    expect(await until(() => !screen().includes("half"))).toBe(true);
    expect(await kickUntil(() => h.deliveries.get("hub:d1")?.state === "delivered")).toBe(true);
    expect(submitted()).toEqual(["the message"]);
  });

  it("moves a delivery whose key was started before a restart to typed, and types nothing", async () => {
    const id = "hub:answer:e2:a1:yes";
    expect(h.doneKeys.start(id, argsHash("pane.send", { workerId: managerLane().workerId, text: "yes" }))).toBe(true);
    expect(h.deliverer.enqueue({ id, target: MANAGER, text: "yes" })).toMatchObject({ delivery: { state: "queued" } });
    expect(await kickUntil(() => h.deliveries.get(id)?.state === "typed")).toBe(true);
    for (let i = 0; i < 5; i++) { h.deliverer.kick("timer"); await h.deliverer.drain(); }
    await wait(500);
    expect(submitted()).toEqual([]);
    expect(h.deliveries.get(id)?.note).toContain("restart");
  });

  it("types it again without the started check (negative control: the noDoneKeys test hook)", async () => {
    h.deliverer.stop();
    await h.deliverer.drain();
    h.close();
    h = harness({ noDoneKeys: true });
    await h.inventory.refresh();
    const id = "hub:answer:e3:a1:yes";
    await h.doneKeys.start(id, argsHash("pane.send", { workerId: managerLane().workerId, text: "yes" }));   // recorded nowhere: keys are off
    await h.deliverer.enqueue({ id, target: MANAGER, text: "yes" });
    expect(await kickUntil(() => submitted().includes("yes"))).toBe(true);
  });
});

describe("when a pane's process started (ruling 14)", () => {
  it("reads field 22 of /proc/<pid>/stat against the boot time, whatever the command's name holds", () => {
    const stat = "4242 (a (weird) name) S 1 4242 4242 0 -1 4194560 120 0 0 0 1 2 0 0 20 0 1 0 123456 1000 10";
    expect(startFromProcStat(stat, 1_790_000_000, 100)).toBe(1_790_000_000_000 + 1_234_560);
    expect(startFromProcStat("4242 (x) S", 1_790_000_000, 100)).toBeNull();
  });

  it("knows this process's start to the second, and none for a process that doesn't exist", () => {
    const starts = new ProcessStarts();
    const at = starts.at(process.pid);
    expect(at).not.toBeNull();
    expect(Math.abs((at ?? 0) - (Date.now() - process.uptime() * 1000))).toBeLessThan(2000);
    expect(starts.at(2 ** 22 + 7)).toBeNull();                        // above every pid limit: no such process
  });

  it("gives each lane its pane process's start, so a pane started a moment ago is in its grace, after an agent restart too", () => {
    const started = h.panes.snapshot().find(p => p.window === "manager")?.startedAt;
    expect(started).not.toBeNull();
    expect(Date.now() - (started ?? 0)).toBeLessThan(60_000);
    expect(Date.now() - (started ?? 0)).toBeGreaterThanOrEqual(-2000);
  });
});
