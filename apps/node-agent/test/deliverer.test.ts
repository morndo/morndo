// The deliverer (fleet clients spec §4.3, rule for rule; plan Contracts, "Agent internals shared by Tasks 4 to 6") against
// scripted parts on a real store: an executor that records each op and answers as the test says, and panes and
// transcripts that the test sets. kick() runs a round and drain() waits for it.
// The transcript lines are in Claude Code 2.1.293's shapes (README §1; the queue records as e2e/signal.e2e.ts has 2.1.288's)
// with synthetic texts, read by Task 2's readReceipts: the rules the drills (Task 16) meet in the fake box.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ERROR_EXECUTED, LIMITS, type Delivery, type DeliveryTarget, type ErrorCode, type OpError, type SessionStatus } from "@morndo/protocol";
import { openAgentDb } from "../src/db/open.ts";
import { Deliverer, ownLine, type DelivererDeps, type DraftStashDeps, type PaneState } from "../src/deliveries/deliverer.ts";
import { DeliveryStore } from "../src/deliveries/store.ts";
import type { Reply, Request } from "../src/ops/executor.ts";
import { captureLog, tempHome, until } from "./helpers.ts";

const T0 = Date.parse("2026-10-08T05:00:00.000Z");
const [S1, S2, S3, S4] = [1, 2, 3, 4].map(n => `3c4d5e6f-0000-4000-8000-00000000000${n}`) as [string, string, string, string];
const [W1, W2, W3, W4, W5, W6] = [1, 2, 3, 4, 5, 6].map(n => `pc.0a1b2c3d.${n}`) as [string, string, string, string, string, string];
const MANAGER: DeliveryTarget = { lane: "manager", sticky: true };

// Transcript entries as Claude Code 2.1.293 writes them (synthetic texts).
const iso = (ms: number) => new Date(ms).toISOString();
const L = {
  prompt: (text: string, at: number, promptSource = "typed") =>
    ({ type: "user", uuid: randomUUID(), timestamp: iso(at), promptSource, message: { role: "user", content: text } }),
  command: (name: string, at: number) => ({
    type: "user", uuid: randomUUID(), timestamp: iso(at), promptSource: "typed",
    message: { role: "user", content: `<command-name>${name}</command-name>\n<command-message>${name.slice(1)}</command-message>\n<command-args></command-args>` },
  }),
  enqueue: (text: string, at: number) => ({ type: "queue-operation", operation: "enqueue", timestamp: iso(at), sessionId: S1, content: text }),
  dequeue: (at: number) => ({ type: "queue-operation", operation: "dequeue", timestamp: iso(at), sessionId: S1 }),
  remove: (text: string, reason: string, at: number) =>
    ({ type: "queue-operation", operation: "remove", reason, timestamp: iso(at), sessionId: S1, content: text }),
  queuedCommand: (text: string, at: number) => ({
    type: "attachment", uuid: randomUUID(), isSidechain: false, timestamp: iso(at),
    attachment: { type: "queued_command", prompt: text, commandMode: "prompt", origin: { kind: "human" }, timestamp: iso(at), humanTurn: true },
  }),
};

const reply = (r: Request, x: { ok: true; result: unknown } | { ok: false; error: OpError }): Reply => ({ id: r.id, invVersion: 1, ...x });
const refuse = (code: ErrorCode) => (r: Request): Reply =>
  reply(r, { ok: false, error: { code, executed: ERROR_EXECUTED[code], message: `refused: ${code}` } });
const pane = (window: string, workerId: string, id: string, sessionId: string | null,
  status: SessionStatus | null = sessionId === null ? null : "idle", startedAt: number | null = null): PaneState =>
  ({ workerId, pane: id, window, sessionId, status, startedAt });

type Answer = (r: Request) => Reply | Promise<Reply>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

function rig(o: { panes?: PaneState[]; hooks?: DelivererDeps["hooks"]; stash?: DraftStashDeps } = {}) {
  const home = tempHome();
  const adb = openAgentDb(join(home.home, "agent.db"));
  const clock = { now: T0 };
  const store = new DeliveryStore(adb.db, () => clock.now, "pc");
  const calls: Request[] = [];
  const emitted: Delivery[] = [];
  const panes: PaneState[] = o.panes ?? [pane("manager", W1, "%1", S1)];
  const drafts = new Map<string, string>();
  const transcripts = new Map<string, string>();
  const fileIds = new Map<string, string>();                         // session → the transcript file's identity (its inode)
  const fail = { refresh: false };                                   // the node's panes can't be read (tmux didn't answer)
  const typed = (problem: "not_submitted" | null = null) => (r: Request): Reply =>
    reply(r, { ok: true, result: r.op === "pane.keys" ? { ok: true } : { problem, typedAt: clock.now } });
  let answer: Answer = typed();
  const deliverer = new Deliverer({
    store, now: () => clock.now, emit: d => { emitted.push(d); }, log: captureLog().log,
    executor: { handle: async r => { calls.push(r); return answer(r); } },
    panes: {
      snapshot: () => panes.map(p => ({ ...p })),
      refresh: async () => { if (fail.refresh) throw new Error("tmux did not answer"); return panes.map(p => ({ ...p })); },
      draft: async p => drafts.get(p) ?? null,
    },
    transcripts: {
      size: async s => { const t = transcripts.get(s); return t === undefined ? null : Buffer.byteLength(t); },
      identity: async s => (transcripts.has(s) ? (fileIds.get(s) ?? "file-1") : null),
      lines: async (s, from) => {
        const t = transcripts.get(s);
        if (t === undefined) return null;
        if (from > Buffer.byteLength(t)) from = 0;                   // a file shorter than before is read again (views.ts)
        const rest = Buffer.from(t).subarray(from);
        const end = rest.lastIndexOf(0x0a);
        if (end === -1) return { lines: [], next: from };
        const rows = rest.subarray(0, end).toString("utf8").split("\n");
        let at = from;
        const starts = rows.map(row => { const s = at; at += Buffer.byteLength(row) + 1; return s; });
        return { lines: rows.filter(l => l.length > 0), starts: starts.filter((_, i) => rows[i]!.length > 0), next: from + end + 1 };
      },
    },
    ...(o.hooks ? { hooks: o.hooks } : {}),
    ...(o.stash ? { stash: o.stash } : {}),
  });
  cleanups.push(async () => { deliverer.stop(); await deliverer.drain(); adb.close(); home.cleanup(); });
  return {
    deliverer, store, clock, calls, emitted, panes, drafts, fail, db: adb.db, typed,
    answer: (f: Answer) => { answer = f; },
    say: (session: string, ...entries: object[]) => {
      transcripts.set(session, (transcripts.get(session) ?? "") + entries.map(e => `${JSON.stringify(e)}\n`).join(""));
    },
    // The transcript is replaced by another file (or cut short) at the same path.
    replace: (session: string, id: string | null, ...entries: object[]) => {
      transcripts.set(session, entries.map(e => `${JSON.stringify(e)}\n`).join(""));
      if (id !== null) fileIds.set(session, id);
    },
    round: async () => { deliverer.kick("timer"); await deliverer.drain(); },
    sends: () => calls.filter(c => c.op === "pane.send"),
    keys: () => calls.filter(c => c.op === "pane.keys"),
  };
}
type Rig = ReturnType<typeof rig>;
const state = (r: Rig, id: string) => r.store.get(id)?.state;

describe("a receipt must be written after the typing began", () => {
  // A transcript that times its lines in whole seconds (the engine layer's lane): a line from the second the text was typed in
  // can't be told from an earlier one by its time, so the transcript's size before the typing is the line to cross.
  const whole = (text: string, at: number) => ({ type: "user", timestamp: `${new Date(at).toISOString().slice(0, 19)}Z`, message: { role: "user", content: text } });
  it("two identical short briefs: an earlier line with the same text in the same second is not the receipt; the lane's own new line is", async () => {
    const r = rig();
    r.say(S1, whole("continue", T0));                                   // a person typed it just before, in the same second
    await r.deliverer.enqueue({ id: "lanes:c1", target: MANAGER, text: "continue" });
    await r.deliverer.drain();
    expect(state(r, "lanes:c1")).toBe("typed");
    await r.round();
    expect(state(r, "lanes:c1")).toBe("typed");                         // the old line is not its receipt
    r.say(S1, whole("continue", T0 + 300));
    await r.round();
    expect(state(r, "lanes:c1")).toBe("delivered");
  });
  // The offset was the file's size when the text was typed. A file that is cut short, or replaced by another at the same path,
  // has other offsets: nothing there is "after the typing" by position, so only a line that is later by its time and has the text counts.
  const fill = (n: number) => Array.from({ length: n }, (_, i) => ({ type: "user", timestamp: "2026-10-08T04:00:00Z", message: { role: "user", content: `earlier ${i}` } }));
  it("a transcript cut short after the typing: a same-second line of the same text is not the receipt; one from a later second is", async () => {
    const r = rig();
    r.say(S1, ...fill(40));
    await r.deliverer.enqueue({ id: "lanes:s1", target: MANAGER, text: "continue" });
    await r.deliverer.drain();
    expect(state(r, "lanes:s1")).toBe("typed");
    r.replace(S1, null, whole("continue", T0));                       // smaller than the offset: a new file in effect
    await r.round();
    expect(state(r, "lanes:s1")).toBe("typed");                       // not "every line is new"
    r.say(S1, whole("continue", T0 + 1500));
    await r.round();
    expect(state(r, "lanes:s1")).toBe("delivered");
  });
  it("a transcript replaced by a bigger file: its old lines are no receipt either (negative control)", async () => {
    const r = rig();
    r.say(S1, ...fill(2));
    await r.deliverer.enqueue({ id: "lanes:s2", target: MANAGER, text: "continue" });
    await r.deliverer.drain();
    r.replace(S1, "file-2", ...fill(60), whole("continue", T0));      // longer than the offset, but another file
    await r.round();
    expect(state(r, "lanes:s2")).toBe("typed");
    r.say(S1, whole("continue", T0 + 1500));
    await r.round();
    expect(state(r, "lanes:s2")).toBe("delivered");
  });
  it("a transcript that only grows keeps its offset: a line past it counts in the second the text was typed in", async () => {
    const r = rig();
    r.say(S1, ...fill(3));
    await r.deliverer.enqueue({ id: "lanes:s3", target: MANAGER, text: "continue" });
    await r.deliverer.drain();
    r.say(S1, whole("continue", T0 + 100));
    await r.round();
    expect(state(r, "lanes:s3")).toBe("delivered");
  });

  it("a first brief to a lane whose transcript does not exist yet is delivered by the line that creates it", async () => {
    const r = rig();
    await r.deliverer.enqueue({ id: "lanes:c2", target: MANAGER, text: "first brief" });
    await r.deliverer.drain();
    expect(state(r, "lanes:c2")).toBe("typed");
    r.say(S1, whole("first brief", T0 + 200));
    await r.round();
    expect(state(r, "lanes:c2")).toBe("delivered");
  });
});

describe("trying and confirming (spec §4.3)", () => {
  it("types the head once into its pane, under its id as the done key, and confirms it from a prompt in the session it was typed into", async () => {
    const r = rig();
    const answer = r.deliverer.enqueue({ id: "hub:a", target: MANAGER, text: "ship it" });
    expect(answer).toMatchObject({ delivery: { id: "hub:a", state: "queued" } });
    expect(answer).not.toHaveProperty("delivery.waiting");            // nothing has found the lane not ready (ruling 43)
    await r.deliverer.drain();
    expect(r.sends()).toEqual([expect.objectContaining({
      op: "pane.send", key: "hub:a", args: { workerId: W1, text: "ship it", expect: { server: "0a1b2c3d", window: "manager" } },
    })]);
    expect(r.store.get("hub:a")).toMatchObject({ state: "typed", typedAt: T0, sessionId: S1 });
    await r.round();
    expect(state(r, "hub:a")).toBe("typed");                           // no receipt yet, and nothing typed again
    r.say(S1, L.prompt("ship it", T0 + 300));
    await r.round();
    expect(r.store.get("hub:a")).toMatchObject({ state: "delivered", deliveredAt: T0 + 300 });
    expect(r.sends()).toHaveLength(1);
    expect(r.emitted.map(d => d.state)).toEqual(["queued", "typed", "delivered"]);
  });

  it("types one at a time per lane in the order stored: the next waits `earlier` until the one before is confirmed, and two of one text need two receipts (Review Focus 2)", async () => {
    const r = rig();
    const ids = ["kira:tap-1", "hub:answer:e1:a1:ship", "fleet:lane-events:pc:1"] as const;
    const texts = ["approve the deploy", "ship it", "ship it"] as const;
    for (const [i, id] of ids.entries()) await r.deliverer.enqueue({ id, target: MANAGER, text: texts[i] as string });
    await r.deliverer.drain();
    expect(r.sends().map(c => c.key)).toEqual([ids[0]]);
    expect([ids[1], ids[2]].map(id => r.store.get(id)?.waiting?.reason)).toEqual(["earlier", "earlier"]);
    r.clock.now = T0 + 1000;
    await r.round();
    expect(r.sends()).toHaveLength(1);                                 // the first not seen taken yet: the rest wait
    r.say(S1, L.prompt("approve the deploy", T0 + 1100));
    r.clock.now = T0 + 2000;
    await r.round();
    expect(r.store.get(ids[0])).toMatchObject({ state: "delivered", deliveredAt: T0 + 1100 });
    expect(r.sends().map(c => c.key)).toEqual([ids[0], ids[1]]);
    expect(r.store.get(ids[1])).toMatchObject({ state: "typed", typedAt: T0 + 2000 });
    r.say(S1, L.prompt("ship it", T0 + 2100));
    r.clock.now = T0 + 3000;
    await r.round();
    expect(state(r, ids[1])).toBe("delivered");
    expect(r.store.get(ids[2])).toMatchObject({ state: "typed", typedAt: T0 + 3000 });
    await r.round();
    expect(state(r, ids[2])).toBe("typed");                            // that receipt confirmed only the earlier of the two
    r.say(S1, L.prompt("ship it", T0 + 3100));
    await r.round();
    expect(state(r, ids[2])).toBe("delivered");
    expect(r.sends().map(c => c.key)).toEqual([...ids]);
  });

  it("holds the next one back while the one before waits for its receipt, at most 60 s from that typing; then the next types (rulings 16, 42)", async () => {
    const r = rig();
    await r.deliverer.enqueue({ id: "hub:first", target: MANAGER, text: "first" });
    await r.deliverer.enqueue({ id: "hub:second", target: MANAGER, text: "second" });
    await r.deliverer.drain();
    expect(r.sends().map(c => c.key)).toEqual(["hub:first"]);
    expect(LIMITS.deliveryReceiptHoldMs).toBe(60_000);
    r.clock.now = T0 + LIMITS.deliveryReceiptHoldMs - 1;
    await r.round();
    expect(r.store.get("hub:second")).toMatchObject({ state: "queued", waiting: { reason: "earlier" } });
    r.clock.now = T0 + LIMITS.deliveryReceiptHoldMs;
    await r.round();
    expect(r.sends().map(c => c.key)).toEqual(["hub:first", "hub:second"]);
    expect(state(r, "hub:first")).toBe("typed");                       // still waiting for its receipt, which still counts
    r.say(S1, L.prompt("first", T0 + 60_100), L.prompt("second", T0 + 60_200));
    await r.round();
    expect([state(r, "hub:first"), state(r, "hub:second")]).toEqual(["delivered", "delivered"]);
  });

  it("leaves it queued with the reason of a refusal that typed nothing, keeps when it began waiting, and types once the pane is ready", async () => {
    const r = rig();
    r.answer(refuse("menu_open"));
    await r.deliverer.enqueue({ id: "hub:w", target: MANAGER, text: "x" });
    await r.deliverer.drain();
    expect(r.store.get("hub:w")).toMatchObject({ state: "queued", waiting: { reason: "menu_open", since: T0 } });
    const said = r.emitted.length;
    r.clock.now = T0 + 5000;
    await r.round();
    expect(r.store.get("hub:w")?.waiting).toEqual({ reason: "menu_open", since: T0 });
    expect(r.emitted).toHaveLength(said);                              // a round that changed nothing says nothing
    const steps = [["draft_present", "draft_present"], ["timeout", "unavailable"], ["no_input_box", "no_input_box"], ["busy", "busy"], ["updating", "unavailable"], ["no_pane", "no_pane"]] as const;
    for (const [code, reason] of steps) {
      r.answer(refuse(code));
      r.clock.now += 1000;
      await r.round();
      expect(r.store.get("hub:w")?.waiting, code).toEqual({ reason, since: r.clock.now });
    }
    r.answer(r.typed());
    r.clock.now += 1000;
    await r.round();
    expect(r.store.get("hub:w")).toMatchObject({ state: "typed" });
    expect(r.store.get("hub:w")).not.toHaveProperty("waiting");
    expect(r.sends()).toHaveLength(9);
  });

  it("gives a definite refusal up (refused), with what the pane said", async () => {
    const r = rig();
    r.answer(refuse("too_large"));
    await r.deliverer.enqueue({ id: "hub:big", target: MANAGER, text: "x" });
    await r.deliverer.drain();
    expect(r.store.get("hub:big")).toMatchObject({ state: "given_up", why: "refused", note: "too_large: refused: too_large" });
  });

  it("types a text starting with / once, and confirms it by the command entry Claude Code writes for it (Review Focus 1)", async () => {
    const r = rig();
    await r.deliverer.enqueue({ id: "lanes:compact-1", target: MANAGER, text: "/compact" });
    await r.deliverer.drain();
    expect(state(r, "lanes:compact-1")).toBe("typed");
    r.say(S1, L.command("/compact", T0 + 200));
    await r.round();
    expect(r.store.get("lanes:compact-1")).toMatchObject({ state: "delivered", deliveredAt: T0 + 200 });
    expect(r.sends()).toHaveLength(1);
  });

  it("confirms a command that starts a new session (/clear) by its pane's session changing after the typing (ruling 17)", async () => {
    const r = rig();
    await r.deliverer.enqueue({ id: "lanes:clear-1", target: MANAGER, text: "/clear" });
    await r.deliverer.drain();
    expect(state(r, "lanes:clear-1")).toBe("typed");
    await r.round();
    expect(state(r, "lanes:clear-1")).toBe("typed");                   // the same session: no receipt yet
    r.clock.now = T0 + 500;
    Object.assign(r.panes[0] as PaneState, { sessionId: S2 });         // Claude Code began a new session in the pane
    await r.round();
    expect(r.store.get("lanes:clear-1")).toMatchObject({ state: "delivered", deliveredAt: T0 + 500 });
    expect(r.sends()).toHaveLength(1);
  });
});

describe("Enter again (spec §4.3)", () => {
  it("presses Enter again only while the box shows its own line, at most twice, and never again for it", async () => {
    const r = rig();
    r.answer(q => (q.op === "pane.send" ? r.typed("not_submitted")(q) : r.typed()(q)));
    r.drafts.set("%1", "ship it");                                     // Enter changes nothing: the line stays in the box
    await r.deliverer.enqueue({ id: "hub:e", target: MANAGER, text: "ship it" });
    await r.deliverer.drain();
    const enter = expect.objectContaining({ op: "pane.keys", args: { workerId: W1, names: ["Enter"], expect: { server: "0a1b2c3d", window: "manager" } } });
    expect(r.keys()).toEqual([enter, enter]);
    expect(state(r, "hub:e")).toBe("typed");
    await r.round();
    expect(r.keys()).toHaveLength(2);
  });

  it("never presses Enter on a line that isn't its own (negative control), nor once the box is clear", async () => {
    const theirs = rig();
    theirs.answer(q => theirs.typed("not_submitted")(q));
    theirs.drafts.set("%1", "the owner's own words");
    await theirs.deliverer.enqueue({ id: "hub:e", target: MANAGER, text: "ship it" });
    await theirs.deliverer.drain();
    expect(theirs.keys()).toEqual([]);
    const clear = rig();
    clear.answer(q => clear.typed("not_submitted")(q));
    await clear.deliverer.enqueue({ id: "hub:e", target: MANAGER, text: "ship it" });
    await clear.deliverer.drain();
    expect(clear.keys()).toEqual([]);
  });

  it("knows its own line: exactly its text, the start of a long one, or a paste's placeholder for a text of several lines", () => {
    expect(ownLine("ship it", "ship it")).toBe(true);
    expect(ownLine("ship  it ", "ship it")).toBe(true);
    expect(ownLine("ship", "ship it")).toBe(false);                   // a shorter line is another line
    const long = "a long message that wraps over more than one line of the box";
    expect(ownLine(long.slice(0, 30), long)).toBe(true);
    expect(ownLine(long.slice(0, 10), long)).toBe(false);
    expect(ownLine("[Pasted text #1 +3 lines]", "a\nb\nc\nd")).toBe(true);
    expect(ownLine("[Pasted text #1 +3 lines]", "one line")).toBe(false);
    expect(ownLine("[Pasted text #1]", "x".repeat(100_000))).toBe(true);     // a long single line: a chip without a line count
    expect(ownLine("[Pasted text #1]", "a\nb\nc\nd")).toBe(false);
    expect(ownLine("someone else's words", "ship it")).toBe(false);
    expect(ownLine("", "ship it")).toBe(false);
  });
});

describe("a typing from before a restart (spec §4.3, §10)", () => {
  it("moves it to typed when its key was started already (the agent restarted while typing), and never types it again", async () => {
    const r = rig();
    r.answer(refuse("uncertain"));                                     // the executor's answer for a key already started
    await r.deliverer.enqueue({ id: "hub:s", target: MANAGER, text: "ship it" });
    await r.deliverer.drain();
    expect(r.store.get("hub:s")).toMatchObject({ state: "typed", typedAt: T0, sessionId: S1, note: expect.stringContaining("restart") });
    r.answer(r.typed());
    r.clock.now = T0 + 10_000;
    await r.round();
    await r.round();
    expect(r.sends()).toHaveLength(1);
    r.say(S1, L.prompt("ship it", T0 + 50));                          // what it typed then, found in the transcript
    await r.round();
    expect(state(r, "hub:s")).toBe("delivered");
  });

  it("takes a key already done at its stored outcome: typed at the time it was typed, and no Enter pressed for a line stuck back then", async () => {
    const r = rig();
    r.answer(q => reply(q, { ok: true, result: q.op === "pane.send" ? { problem: "not_submitted", typedAt: T0 - 5000 } : { ok: true } }));
    r.drafts.set("%1", "ship it");
    await r.deliverer.enqueue({ id: "hub:o", target: MANAGER, text: "ship it" });
    await r.deliverer.drain();
    expect(r.store.get("hub:o")).toMatchObject({ state: "typed", typedAt: T0 - 5000 });
    expect(r.keys()).toEqual([]);
  });
});

describe("receipts (spec §4.3, Confirming)", () => {
  it("holds it while Claude Code queues it; a dequeue (no text) decides nothing; the prompt after it delivers it", async () => {
    const r = rig();
    await r.deliverer.enqueue({ id: "hub:h", target: MANAGER, text: "ship it" });
    await r.deliverer.drain();
    r.say(S1, L.enqueue("ship it", T0 + 100));
    await r.round();
    expect(state(r, "hub:h")).toBe("held");
    r.say(S1, L.dequeue(T0 + 200));
    await r.round();
    expect(state(r, "hub:h")).toBe("held");
    r.say(S1, L.prompt("ship it", T0 + 300, "queued"));
    await r.round();
    expect(r.store.get("hub:h")).toMatchObject({ state: "delivered", deliveredAt: T0 + 300 });
    expect(r.emitted.map(d => d.state)).toEqual(["queued", "typed", "held", "delivered"]);
  });

  it.each([
    ["remove absorbed_mid_turn", "delivered", (text: string, at: number) => [L.enqueue(text, at), L.remove(text, "absorbed_mid_turn", at + 1)]],
    ["remove delivered_to_agent", "delivered", (text: string, at: number) => [L.enqueue(text, at), L.remove(text, "delivered_to_agent", at + 1)]],
    ["a queued_command attachment", "delivered", (text: string, at: number) => [L.enqueue(text, at), L.queuedCommand(text, at + 1)]],
    ["remove for a reason no rule names", "held", (text: string, at: number) => [L.enqueue(text, at), L.remove(text, "moved_elsewhere", at + 1)]],
  ])("after %s it is %s, and is never typed again", async (_, after, entries) => {
    const r = rig();
    await r.deliverer.enqueue({ id: "hub:r", target: MANAGER, text: "ship it" });
    await r.deliverer.drain();
    r.say(S1, ...entries("ship it", T0 + 100));
    await r.round();
    await r.round();
    expect(state(r, "hub:r")).toBe(after);
    expect(r.sends()).toHaveLength(1);
  });

  it("types a line Claude Code dropped (cleared_on_cancel) once more, under <id>#2, when the box is clear and the session idle; dropped again, it is uncertain: never a third typing", async () => {
    const r = rig();
    await r.deliverer.enqueue({ id: "hub:d", target: MANAGER, text: "ship it" });
    await r.deliverer.drain();
    r.say(S1, L.enqueue("ship it", T0 + 100), L.remove("ship it", "cleared_on_cancel", T0 + 200));
    r.clock.now = T0 + 1000;
    await r.round();
    expect(r.sends().map(c => c.key)).toEqual(["hub:d", "hub:d#2"]);
    expect(r.store.get("hub:d")).toMatchObject({ state: "typed", typedAt: T0 + 1000 });
    expect(r.store.detail("hub:d")?.retyped).toBe(true);
    r.say(S1, L.enqueue("ship it", T0 + 1100), L.remove("ship it", "cleared_on_cancel", T0 + 1200));
    await r.round();
    expect(r.store.get("hub:d")).toMatchObject({ state: "uncertain" });
    expect(r.sends()).toHaveLength(2);
  });

  it.each([
    ["its line is back in the box", (r: Rig) => { r.drafts.set("%1", "ship it"); }],
    ["its session is busy", (r: Rig) => { (r.panes[0] as PaneState).status = "busy"; }],
  ])("does not type a dropped line again when %s: uncertain", async (_, setup) => {
    const r = rig();
    await r.deliverer.enqueue({ id: "hub:d", target: MANAGER, text: "ship it" });
    await r.deliverer.drain();
    setup(r);
    r.say(S1, L.enqueue("ship it", T0 + 100), L.remove("ship it", "cleared_on_cancel", T0 + 200));
    await r.round();
    expect(r.store.get("hub:d")).toMatchObject({ state: "uncertain", note: expect.stringContaining("not typed again") });
    expect(r.sends()).toHaveLength(1);
  });
});

describe("expiring and cancelling (spec §4.3)", () => {
  it("past notAfter: queued is given up (expired); typed and held are uncertain, and none is typed again", async () => {
    const r = rig({ panes: [pane("a", W1, "%1", S1), pane("b", W2, "%2", S2), pane("c", W3, "%3", S3)] });
    r.answer(q => ((q.args as { workerId: string }).workerId === W1 ? refuse("menu_open")(q) : r.typed()(q)));
    for (const [id, lane] of [["hub:q", "a"], ["hub:t", "b"], ["hub:h", "c"]] as const) {
      await r.deliverer.enqueue({ id, target: { lane, sticky: false }, text: `for ${lane}`, ttlMs: 60_000 });
    }
    await r.deliverer.drain();
    r.say(S3, L.enqueue("for c", T0 + 10));
    await r.round();
    const states = () => ["hub:q", "hub:t", "hub:h"].map(id => state(r, id));
    expect(states()).toEqual(["queued", "typed", "held"]);
    r.clock.now = T0 + 60_000;                                         // at notAfter, not past it
    await r.round();
    expect(states()).toEqual(["queued", "typed", "held"]);
    r.clock.now = T0 + 60_001;
    await r.round();
    expect(r.store.get("hub:q")).toMatchObject({ state: "given_up", why: "expired" });
    expect(r.store.get("hub:t")).toMatchObject({ state: "uncertain", note: "typed, never seen taken before notAfter" });
    expect(r.store.get("hub:h")).toMatchObject({ state: "uncertain", note: "held by Claude Code, never seen taken before notAfter" });
    const sent = r.sends().length;
    r.answer(r.typed());
    await r.round();
    expect(r.sends()).toHaveLength(sent);
  });

  it("cancels a queued delivery, and it stays cancelled; one typed can't be (already_typed); an id it doesn't know is bad_args", async () => {
    const r = rig({ panes: [pane("manager", W1, "%1", S1), pane("api", W2, "%2", S2)] });
    r.answer(q => ((q.args as { workerId: string }).workerId === W1 ? refuse("menu_open")(q) : r.typed()(q)));
    await r.deliverer.enqueue({ id: "hub:q", target: MANAGER, text: "later" });
    await r.deliverer.enqueue({ id: "hub:t", target: { lane: "api", sticky: false }, text: "now" });
    await r.deliverer.drain();
    const tried = r.sends().filter(c => c.key === "hub:q").length;      // refused tries (the second enqueue runs one more round)
    const cancelled = r.deliverer.cancel("hub:q");
    expect(cancelled).toMatchObject({ delivery: { id: "hub:q", state: "given_up", why: "cancelled" } });
    expect(r.emitted.at(-1)).toMatchObject({ id: "hub:q", state: "given_up", why: "cancelled" });
    expect(r.deliverer.cancel("hub:q")).toEqual(cancelled);
    expect(r.deliverer.cancel("hub:t")).toMatchObject({ code: "already_typed", executed: "no" });
    expect(r.deliverer.cancel("hub:nothing")).toMatchObject({ code: "bad_args", executed: "no" });
    r.answer(r.typed());
    await r.round();
    expect(r.sends().filter(c => c.key === "hub:q")).toHaveLength(tried);   // no try after the cancel
  });

  it("answers a cancel during its try with busy, and the try's outcome stands", async () => {
    const r = rig();
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    r.answer(async q => { await gate; return r.typed()(q); });
    await r.deliverer.enqueue({ id: "hub:c", target: MANAGER, text: "x" });
    expect(await until(() => r.calls.length === 1)).toBe(true);
    expect(r.deliverer.cancel("hub:c")).toMatchObject({ code: "busy", executed: "no" });
    release();
    await r.deliverer.drain();
    expect(state(r, "hub:c")).toBe("typed");
    expect(r.deliverer.cancel("hub:c")).toMatchObject({ code: "already_typed" });
  });
});

describe("targets (spec §4.1)", () => {
  it("keeps a sticky lane's delivery waiting (no_pane) while its window is gone, and types it into the window that takes the name next", async () => {
    const r = rig({ panes: [] });
    expect(r.deliverer.enqueue({ id: "hub:m", target: MANAGER, text: "hello" })).toMatchObject({ delivery: { state: "queued" } });
    await r.deliverer.drain();
    expect(r.store.get("hub:m")).toMatchObject({ state: "queued", waiting: { reason: "no_pane" } });
    r.panes.push(pane("manager", W2, "%2", S2));
    await r.round();
    expect(r.sends()).toEqual([expect.objectContaining({ args: expect.objectContaining({ workerId: W2 }) })]);
    expect(r.store.get("hub:m")).toMatchObject({ state: "typed", sessionId: S2 });
  });

  it("gives a name bound to its session up (gone) once another session has that name, and never types there", async () => {
    const r = rig({ panes: [pane("api", W1, "%1", S1)] });
    r.answer(refuse("menu_open"));
    await r.deliverer.enqueue({ id: "hub:b", target: { lane: "api", sticky: false }, text: "for this api" });
    await r.deliverer.drain();
    expect(r.store.get("hub:b")).toMatchObject({ state: "queued", sessionId: S1 });
    expect(r.sends()[0]?.args).toMatchObject({ expect: { sessionId: S1 } });   // the pane is asked for the session too
    Object.assign(r.panes[0] as PaneState, { workerId: W2, pane: "%2", sessionId: S2 });   // stopped; a new lane took the name
    r.answer(r.typed());
    await r.round();
    expect(r.store.get("hub:b")).toMatchObject({ state: "given_up", why: "gone" });
    expect(r.sends()).toHaveLength(1);
  });

  it("a prompt queued by worker id and a follow-up queued by that lane's name type one at a time, prompt first", async () => {
    const r = rig({ panes: [pane("foo", W1, "%1", null, null, T0 - 1000)] });
    await r.deliverer.enqueue({ id: "prompt", target: { workerId: W1 }, text: "the prompt" });
    await r.deliverer.enqueue({ id: "send-1", target: { lane: "foo", sticky: false }, text: "the follow-up" });
    await r.deliverer.drain();
    expect(r.sends()).toHaveLength(0);
    Object.assign(r.panes[0] as PaneState, { sessionId: S1, status: "idle" });
    await r.round();
    expect(r.sends().map(c => c.key)).toEqual(["prompt"]);
    expect(r.store.get("send-1")).toMatchObject({ state: "queued", waiting: { reason: "earlier" } });
    r.clock.now = T0 + 1000;
    await r.round();
    expect(r.sends().map(c => c.key)).toEqual(["prompt"]);             // the prompt's receipt still holds the pane
    r.say(S1, L.prompt("the prompt", T0 + 1100));
    r.clock.now = T0 + 2000;
    await r.round();
    expect(r.store.get("prompt")).toMatchObject({ state: "delivered" });
    expect(r.sends().map(c => c.key)).toEqual(["prompt", "send-1"]);
  });

  it("binds a name queued while its lane was starting to the first session the lane shows", async () => {
    const r = rig({ panes: [pane("api", W1, "%1", null, null, T0 - 1000)] });
    await r.deliverer.enqueue({ id: "hub:l", target: { lane: "api", sticky: false }, text: "first words" });
    await r.deliverer.drain();
    expect(r.store.get("hub:l")).toMatchObject({ state: "queued", waiting: { reason: "no_session" } });
    expect(r.store.detail("hub:l")?.boundSession).toBeNull();
    Object.assign(r.panes[0] as PaneState, { sessionId: S1, status: "idle" });
    await r.round();
    expect(r.store.get("hub:l")).toMatchObject({ state: "typed", sessionId: S1 });
    expect(r.store.detail("hub:l")?.boundSession).toBe(S1);
    expect(r.sends()[0]?.args).toMatchObject({ expect: { sessionId: S1 } });
  });

  it("binds a worker id to its pane: given up (gone) with it", async () => {
    const r = rig();
    r.answer(refuse("draft_present"));
    await r.deliverer.enqueue({ id: "hub:p", target: { workerId: W1 }, text: "x" });
    await r.deliverer.drain();
    expect(state(r, "hub:p")).toBe("queued");
    r.panes.length = 0;
    await r.round();
    expect(r.store.get("hub:p")).toMatchObject({ state: "given_up", why: "gone" });
  });

  it("takes deliveries for a lane with a live session, whatever its status; no_session is refused, but a sticky lane, or a pane started in the last 2 minutes, waits (ruling 11)", async () => {
    const r = rig({ panes: [
      pane("shell", W1, "%1", null),                                              // a shell, never Claude Code
      pane("gone", W2, "%2", null),                                               // Claude Code's process gone: no live session
      pane("manager", W3, "%3", null),                                            // the manager mid-restart
      pane("fresh", W4, "%4", null, null, T0 - LIMITS.deliveryStartGraceMs + 1),  // its process started just under 2 minutes ago
      pane("stale", W5, "%5", null, null, T0 - LIMITS.deliveryStartGraceMs),      // its process started 2 minutes ago
      pane("running", W6, "%6", S3, "shell"),                                     // alive, running a shell command
    ] });
    const refused: DeliveryTarget[] = [{ lane: "shell", sticky: false }, { lane: "gone", sticky: false }, { workerId: W2 }, { workerId: W5 }];
    for (const target of refused) {
      expect(r.deliverer.enqueue({ id: "hub:n", target, text: "x" }), JSON.stringify(target)).toMatchObject({ code: "no_session", executed: "no" });
    }
    expect(r.store.get("hub:n")).toBeNull();
    expect(r.deliverer.enqueue({ id: "hub:m", target: MANAGER, text: "x" })).toMatchObject({ delivery: { state: "queued" } });
    expect(r.deliverer.enqueue({ id: "hub:f", target: { workerId: W4 }, text: "y" })).toMatchObject({ delivery: { state: "queued" } });
    expect(r.deliverer.enqueue({ id: "hub:s", target: { lane: "running", sticky: false }, text: "z" })).toMatchObject({ delivery: { state: "queued", sessionId: S3 } });
    await r.deliverer.drain();
    expect(["hub:m", "hub:f"].map(id => r.store.get(id)?.waiting?.reason)).toEqual(["no_session", "no_session"]);
    expect(r.sends().map(c => c.key)).toEqual(["hub:s"]);              // the live session running a command took its delivery
    Object.assign(r.panes[3] as PaneState, { sessionId: S4, status: "idle" });   // Claude Code started in "fresh"
    await r.round();
    expect(r.store.get("hub:f")).toMatchObject({ state: "typed", sessionId: S4 });
    expect(state(r, "hub:m")).toBe("queued");
  });

  it("answers the same id again with its state now; other content under it is id_conflict; a name two windows claim is lane_conflict; a name or pane not here is no_pane", async () => {
    const r = rig({ panes: [pane("manager", W1, "%1", S1), pane("twin", W2, "%2", S2), pane("twin", W3, "%3", S3)] });
    await r.deliverer.enqueue({ id: "hub:a", target: MANAGER, text: "x" });
    await r.deliverer.drain();
    expect(r.deliverer.enqueue({ id: "hub:a", target: MANAGER, text: "x" })).toMatchObject({ delivery: { id: "hub:a", state: "typed" } });
    const others: { target: DeliveryTarget; text: string }[] = [{ target: MANAGER, text: "y" }, { target: { lane: "twin", sticky: false }, text: "x" }];
    for (const other of others) {
      expect(r.deliverer.enqueue({ id: "hub:a", ...other }), JSON.stringify(other)).toMatchObject({ code: "id_conflict", executed: "no" });
    }
    expect(r.deliverer.enqueue({ id: "hub:b", target: { lane: "twin", sticky: true }, text: "x" })).toMatchObject({ code: "lane_conflict", executed: "no" });
    expect(r.deliverer.enqueue({ id: "hub:b", target: { lane: "nowhere", sticky: false }, text: "x" })).toMatchObject({ code: "no_pane", executed: "no" });
    expect(r.deliverer.enqueue({ id: "hub:b", target: { workerId: "pc.0a1b2c3d.99" }, text: "x" })).toMatchObject({ code: "no_pane", executed: "no" });
    expect(r.store.get("hub:b")).toBeNull();
    expect(r.sends()).toHaveLength(1);
  });
});

describe("the rest of the deliverer's promises", () => {
  it("refuses a delivery the disk can't store (internal, executed no): nothing is queued, and the sender is told", async () => {
    const r = rig();
    r.db.exec("CREATE TRIGGER no_room BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    expect(r.deliverer.enqueue({ id: "hub:a", target: MANAGER, text: "x" })).toMatchObject({ code: "internal", executed: "no" });
    expect(r.store.get("hub:a")).toBeNull();
    await r.deliverer.drain();
    expect(r.sends()).toEqual([]);
  });

  it("waits as unavailable while the node can't read its panes, and tries again once it can (ruling 15)", async () => {
    const r = rig();
    r.fail.refresh = true;
    await r.deliverer.enqueue({ id: "hub:u", target: MANAGER, text: "x" });
    await r.deliverer.drain();
    expect(r.store.get("hub:u")).toMatchObject({ state: "queued", waiting: { reason: "unavailable" } });
    expect(r.sends()).toEqual([]);
    r.fail.refresh = false;
    await r.round();
    expect(state(r, "hub:u")).toBe("typed");
  });

  it("tries again at least every 5 seconds once started, and not after stop()", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const r = rig();
      r.answer(refuse("menu_open"));
      await r.deliverer.enqueue({ id: "hub:t", target: MANAGER, text: "x" });
      await r.deliverer.drain();
      expect(r.sends()).toHaveLength(1);
      r.deliverer.start();
      await r.deliverer.drain();
      expect(r.sends()).toHaveLength(2);                               // start() runs a round at once
      vi.advanceTimersByTime(LIMITS.deliveryTryMs - 1);
      await r.deliverer.drain();
      expect(r.sends()).toHaveLength(2);
      vi.advanceTimersByTime(1);
      await r.deliverer.drain();
      expect(r.sends()).toHaveLength(3);
      r.deliverer.stop();
      vi.advanceTimersByTime(LIMITS.deliveryTryMs * 3);
      await r.deliverer.drain();
      expect(r.sends()).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the test hooks for Task 16's drills", () => {
  it("noSessionBinding (negative control for the binding): a lane name is held like a sticky one, and the text lands in the new lane", async () => {
    const r = rig({ panes: [pane("api", W1, "%1", S1)], hooks: { noSessionBinding: true } });
    r.answer(refuse("menu_open"));
    await r.deliverer.enqueue({ id: "hub:u", target: { lane: "api", sticky: false }, text: "for the first api" });
    await r.deliverer.drain();
    expect(r.store.detail("hub:u")?.boundSession).toBeNull();
    r.panes.length = 0;                                                // the lane stopped…
    await r.round();
    expect(r.store.get("hub:u")).toMatchObject({ state: "queued", waiting: { reason: "no_pane" } });
    r.panes.push(pane("api", W2, "%2", S2));                           // …and a new one took its name
    r.answer(r.typed());
    await r.round();
    expect(r.store.get("hub:u")).toMatchObject({ state: "typed", sessionId: S2 });
    const last = r.sends().at(-1)?.args as { workerId: string; expect: Record<string, unknown> };
    expect(last.workerId).toBe(W2);
    expect(last.expect).not.toHaveProperty("sessionId");
  });

  it("retypeUnderFirstKey (negative control for the retype's own key): the retype goes under the delivery's id", async () => {
    const r = rig({ hooks: { retypeUnderFirstKey: true } });
    await r.deliverer.enqueue({ id: "hub:k", target: MANAGER, text: "ship it" });
    await r.deliverer.drain();
    r.say(S1, L.enqueue("ship it", T0 + 100), L.remove("ship it", "cleared_on_cancel", T0 + 200));
    r.clock.now = T0 + 1000;
    await r.round();
    expect(r.sends().map(c => c.key)).toEqual(["hub:k", "hub:k"]);
  });

  it("deliveryStartGraceMs shortens the 2 minutes a pane just started may wait for Claude Code", async () => {
    const started = () => [pane("fresh", W1, "%1", null, null, T0 - 1000)];
    const short = rig({ panes: started(), hooks: { deliveryStartGraceMs: 500 } });
    expect(short.deliverer.enqueue({ id: "hub:g", target: { workerId: W1 }, text: "x" })).toMatchObject({ code: "no_session" });
    const usual = rig({ panes: started() });
    expect(usual.deliverer.enqueue({ id: "hub:g", target: { workerId: W1 }, text: "x" })).toMatchObject({ delivery: { state: "queued" } });
  });
});

// #64: a draft left in the orchestrator's input box held every delivery to it for hours. On a lane of draftStash, once the
// same draft has held a delivery for draftStash.afterMs, it is saved, stashed with Ctrl+S, and the deliveries go in.
describe("a draft in the way (#64)", () => {
  const HOUR = 60 * 60_000;
  const W1_LANE: DeliveryTarget = { lane: "w1", sticky: false };
  // The box as Claude Code keeps it: pane.send refuses while it holds text; Ctrl+S empties it (or not, `stashWorks`).
  // `restores`: Claude Code puts the stashed draft back in the box once a message is submitted (seen live, 2.1.303).
  function boxRig(o: { lanes?: string[]; save?: DraftStashDeps["save"]; stashWorks?: boolean; restores?: boolean } = {}) {
    const saved: { text: string; lane: string; at: number }[] = [];
    const r = rig({
      panes: [pane("manager", W1, "%1", S1), pane("w1", W2, "%2", S2)],
      stash: {
        lanes: o.lanes ?? ["manager"], afterMs: HOUR,
        save: o.save ?? ((text, lane, at) => { saved.push({ text, lane, at }); return `/data/drafts/${saved.length}-${lane}.txt`; }),
      },
    });
    const paneOf = (workerId: unknown) => (workerId === W1 ? "%1" : "%2");
    const stash = new Map<string, string>();
    r.answer(req => {
      const args = req.args as { workerId: string; names?: string[] };
      const id = paneOf(args.workerId);
      if (req.op === "pane.keys") {
        const text = r.drafts.get(id);
        if (args.names?.[0] === "C-s" && o.stashWorks !== false && text !== undefined) { stash.set(id, text); r.drafts.delete(id); }
        return r.typed()(req);
      }
      if (r.drafts.has(id)) return refuse("draft_present")(req);
      const back = stash.get(id);
      if (o.restores && back !== undefined) { r.drafts.set(id, back); stash.delete(id); }
      return r.typed()(req);
    });
    return { ...r, saved };
  }
  const stashKeys = (r: Rig) => r.keys().filter(k => (k.args as { names: string[] }).names[0] === "C-s");

  it("on the manager: the same draft for an hour is saved, stashed with Ctrl+S, and the deliveries go in, in order", async () => {
    const r = boxRig();
    r.drafts.set("%1", "half a thought about the release");
    for (const n of [1, 2, 3]) await r.deliverer.enqueue({ id: `lanes:m${n}`, target: MANAGER, text: `message ${n}` });
    await r.deliverer.drain();
    expect(r.store.get("lanes:m1")?.waiting?.reason).toBe("draft_present");
    expect(r.store.get("lanes:m2")?.waiting?.reason).toBe("earlier");
    r.clock.now = T0 + HOUR - 1;
    await r.round();
    expect(stashKeys(r)).toHaveLength(0);                                    // negative control: no age check stashes at once
    r.clock.now = T0 + HOUR;
    await r.round();
    expect(stashKeys(r)).toHaveLength(1);
    expect(r.saved).toEqual([{ text: "half a thought about the release", lane: "manager", at: T0 + HOUR }]);
    expect(state(r, "lanes:m1")).toBe("typed");
    expect(r.store.get("lanes:m1")?.stashed).toEqual({ at: T0 + HOUR, since: T0, chars: 32, copy: "/data/drafts/1-manager.txt" });
    expect(r.emitted.some(d => d.id === "lanes:m1" && d.stashed !== undefined)).toBe(true);
    for (const n of [1, 2, 3]) {
      r.say(S1, L.prompt(`message ${n}`, r.clock.now + 1));
      await r.round();
    }
    expect(r.sends().map(c => (c.args as { text: string }).text).filter((t, i, all) => all.indexOf(t) === i)).toEqual(["message 1", "message 2", "message 3"]);
    expect(["lanes:m1", "lanes:m2", "lanes:m3"].map(id => state(r, id))).toEqual(["delivered", "delivered", "delivered"]);
    expect(stashKeys(r)).toHaveLength(1);
  });

  it("Claude Code puts the draft back after each delivery: stashed again at once for the next, saved and recorded once", async () => {
    const r = boxRig({ restores: true });
    r.drafts.set("%1", "a long plan, pasted");
    for (const n of [1, 2, 3]) await r.deliverer.enqueue({ id: `lanes:r${n}`, target: MANAGER, text: `note ${n}` });
    await r.deliverer.drain();
    r.clock.now = T0 + HOUR;
    await r.round();
    expect(state(r, "lanes:r1")).toBe("typed");
    expect(r.drafts.get("%1")).toBe("a long plan, pasted");                  // back in the box
    for (const n of [1, 2, 3]) {
      r.clock.now += 1000;
      r.say(S1, L.prompt(`note ${n}`, r.clock.now));
      await r.round();
    }
    expect(["lanes:r1", "lanes:r2", "lanes:r3"].map(id => state(r, id))).toEqual(["delivered", "delivered", "delivered"]);   // negative control: without it r2 waits another hour
    expect(r.clock.now - T0 - HOUR).toBeLessThan(10_000);
    expect(stashKeys(r)).toHaveLength(3);
    expect(r.saved).toHaveLength(1);
    expect(["lanes:r1", "lanes:r2", "lanes:r3"].map(id => r.store.get(id)?.stashed !== undefined)).toEqual([true, false, false]);
    expect(r.drafts.get("%1")).toBe("a long plan, pasted");                  // and it stays the owner's at the end
  });

  it("a draft edited after its stash came back is someone typing: the full wait again", async () => {
    const r = boxRig({ restores: true });
    r.drafts.set("%1", "first words");
    for (const n of [1, 2]) await r.deliverer.enqueue({ id: `lanes:e${n}`, target: MANAGER, text: `note ${n}` });
    await r.deliverer.drain();
    r.clock.now = T0 + HOUR;
    await r.round();
    r.drafts.set("%1", "first words, and more");                          // the owner came back to it
    r.clock.now += 1000;
    r.say(S1, L.prompt("note 1", r.clock.now));
    await r.round();
    r.clock.now += 30 * 60_000;
    await r.round();
    expect(state(r, "lanes:e2")).toBe("queued");
    expect(stashKeys(r)).toHaveLength(1);
  });

  it("on any other lane: a draft still holds its deliveries, however long", async () => {
    const r = boxRig();
    r.drafts.set("%2", "my own notes");
    await r.deliverer.enqueue({ id: "lanes:w", target: W1_LANE, text: "go on" });
    await r.deliverer.drain();
    for (const t of [HOUR, 3 * HOUR, 20 * HOUR]) { r.clock.now = T0 + t; await r.round(); }
    expect(stashKeys(r)).toHaveLength(0);
    expect(r.saved).toEqual([]);
    expect(r.store.get("lanes:w")?.waiting?.reason).toBe("draft_present");
  });

  it("a draft that changes is someone typing: the hour starts again from the change", async () => {
    const r = boxRig();
    r.drafts.set("%1", "draft one");
    await r.deliverer.enqueue({ id: "lanes:c", target: MANAGER, text: "hello" });
    await r.deliverer.drain();
    r.clock.now = T0 + 50 * 60_000;
    r.drafts.set("%1", "draft one, longer now");
    await r.round();
    r.clock.now = T0 + 70 * 60_000;
    await r.round();
    expect(stashKeys(r)).toHaveLength(0);                                    // negative control: an hour from the first sight stashes here
    r.clock.now = T0 + 110 * 60_000;
    await r.round();
    expect(stashKeys(r)).toHaveLength(1);
    expect(r.store.get("lanes:c")?.stashed?.since).toBe(T0 + 50 * 60_000);
  });

  it("a box still full after Ctrl+S is left alone: one key, the delivery keeps waiting, and the draft has its copy", async () => {
    const r = boxRig({ stashWorks: false });
    r.drafts.set("%1", "stubborn");
    await r.deliverer.enqueue({ id: "lanes:s", target: MANAGER, text: "hello" });
    await r.deliverer.drain();
    r.clock.now = T0 + HOUR;
    await r.round();
    r.clock.now = T0 + 2 * HOUR;
    await r.round();
    expect(stashKeys(r)).toHaveLength(1);
    expect(r.keys().map(k => (k.args as { names: string[] }).names[0])).toEqual(["C-s"]);   // never Ctrl+C or Esc
    expect(r.saved.map(x => x.text)).toEqual(["stubborn"]);
    expect(state(r, "lanes:s")).toBe("queued");
    expect(r.store.get("lanes:s")?.stashed).toBeUndefined();
  });

  it("a copy that can't be saved: no key is pressed", async () => {
    const r = boxRig({ save: () => { throw new Error("disk full"); } });
    r.drafts.set("%1", "keep me");
    await r.deliverer.enqueue({ id: "lanes:f", target: MANAGER, text: "hello" });
    await r.deliverer.drain();
    r.clock.now = T0 + HOUR;
    await r.round();
    expect(r.keys()).toHaveLength(0);
    expect(state(r, "lanes:f")).toBe("queued");
  });
});
