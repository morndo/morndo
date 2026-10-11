// The protocol for fleet clients (docs/design/fleet-clients/README.md §4, §5, §7, §8; plan.md Contracts,
// "packages/protocol"): the new error codes, keys by name, pane.capture, lane.start's first prompt and lane.stop's mode,
// session state on each pane, the delivery queue's ops and event, the "/lane" hook path, lane events, the new alert kinds
// and the limits. Synthetic messages only.
import { describe, expect, it } from "vitest";
import {
  AgentFrames, AgentMessage, DeliverySchema, ERROR_EXECUTED, KEYED_OPS, KEY_NAMES, LIMITS, LaneEventSchema, LaneStateBodySchema, OP_ARGS,
  OP_NAMES, OP_RESULTS, SESSION_STATUSES, decode, readOpError, type AlertKind, type Delivery, type LaneEvent, type OpName,
} from "../src/index.ts";
import * as z from "../src/z.ts";

const UUID = "3f1c2d4e-5b6a-4c7d-8e9f-0a1b2c3d4e5f";
const W = "pc.3fa2c1d0.12";
const EXPECT = { server: "3fa2c1d0", window: "manager" };
const kind = (d: { kind: string }) => d.kind;
const ok = (op: OpName, args: unknown) => z.safeParse(OP_ARGS[op], args).success;
const delivery: Delivery = {
  id: "hub:answer:e1:t1:option:1", node: "pc", target: { lane: "manager" }, state: "queued",
  queuedAt: 1_791_460_800_000, notAfter: 1_791_547_200_000, waiting: { reason: "menu_open", since: 1_791_460_801_000 },
};

describe("limits for fleet clients", () => {
  it("are the plan's numbers", () => {
    expect(LIMITS).toMatchObject({
      maxDeliveryId: 200, deliveryTtlMs: 24 * 3_600_000, deliveryTryMs: 5000, deliveryAlertMs: [2 * 60_000, 15 * 60_000, 60 * 60_000],
      deliveryKeepMs: 7 * 86_400_000, deliveryStartGraceMs: 2 * 60_000, deliveryReceiptHoldMs: 60_000, deliveryOpTimeoutMs: 15_000, captureMaxLines: 2000, captureMaxBytes: 256 << 10,
      laneEventBatchMs: 3000, laneEventKeepMs: 7 * 86_400_000, intakeWindowMs: 25, subscriberLagMs: 60_000, laneStopWaitMs: 30_000,
    });
  });
  // The cap counts the text's JSON-escaped size: its JSON is larger by every escape in it (an ESC is 6 bytes as "\u001b"),
  // so the agent caps pane.capture's text by its encoded size (Task 6). Plain text and a screen with colours fit one message.
  it("a full pane.capture of plain text, or of a screen with colours, fits one message", () => {
    const answer = (text: string) => Buffer.byteLength(JSON.stringify({ v: 1, t: "res", id: "r1", invVersion: 1, store: UUID, ok: true, result: { text, truncated: true } }));
    expect(answer("x".repeat(LIMITS.captureMaxBytes))).toBeLessThanOrEqual(LIMITS.maxMessageBytes);
    const line = "\x1b[2m  ⎿  Tip: a dim hint\x1b[0m and some prose after it, as a screen shows it\n";
    expect(answer(line.repeat(Math.floor(LIMITS.captureMaxBytes / Buffer.byteLength(line))))).toBeLessThanOrEqual(LIMITS.maxMessageBytes);
  });
});

describe("error codes for deliveries", () => {
  it("id_conflict, no_session and already_typed: none of them ran, and each reads as itself", () => {
    for (const code of ["id_conflict", "no_session", "already_typed"] as const) {
      expect(ERROR_EXECUTED[code], code).toBe("no");
      expect(readOpError(code, "no", "m")).toEqual({ code, executed: "no", message: "m" });
    }
  });
});

describe("the new ops", () => {
  it("are named once, in OP_ARGS and OP_RESULTS, and none carries a key (a delivery's id is its own idempotency)", () => {
    for (const op of ["pane.capture", "lane.deliver", "delivery.cancel"] as const) {
      expect(OP_NAMES.filter(o => o === op), op).toHaveLength(1);
      expect(KEYED_OPS.has(op), op).toBe(false);
    }
  });
});

describe("lane.deliver and delivery.cancel arguments (§4.1)", () => {
  const deliver = (o: Record<string, unknown>) => ok("lane.deliver", { id: "hub:c1:r1", target: { lane: "manager", sticky: true }, text: "hello", ...o });
  it("take a lane (sticky or not) or a worker ID, a text of up to 8000 characters and a duration", () => {
    expect(deliver({})).toBe(true);
    expect(deliver({ target: { lane: "fix: a/b ü.2", sticky: false } })).toBe(true);
    expect(deliver({ target: { workerId: W } })).toBe(true);
    expect(deliver({ text: "x".repeat(8000), ttlMs: 60_000 })).toBe(true);
    expect(deliver({ ttlMs: LIMITS.deliveryKeepMs })).toBe(true);
    expect(deliver({ id: `kira:${"x".repeat(195)}` })).toBe(true);                               // 200 characters
    for (const id of ["fleet:lane-events:pc:1791460800000", "fleet:lane-events:pc:1791460800000-2.3", "inbox:digest-tick:d1", "lanes:7f3a",
      "lanes:prompt:0123456789abcdef", "hub:answer:menu-pc_3fa2c1d0_12:t1791460800000:option:1",
      "hub:ep1:req ü 1", "hub:a#b", "hub:a#2b"]) {
      expect(deliver({ id }), id).toBe(true);
    }
  });
  it("refuse an id that isn't namespaced, is too long, holds a control character or ends like a retype's key (negative controls)", () => {
    for (const id of ["nonamespace", "Hub:x", ":x", "hub:", `kira:${"x".repeat(196)}`, "hub:a\nb", "hub:a\u0000", "hub:a\u001b[201~", "hub:x#2", "hub:x#10",
      "abcdefghijklmnopq:x", 7]) {
      expect(deliver({ id }), JSON.stringify(id)).toBe(false);
    }
  });
  it("refuse a target that names both or neither, or isn't a lane or a worker ID (negative controls)", () => {
    for (const target of [{ lane: "manager", sticky: true, workerId: W }, { lane: "manager" }, {}, { workerId: "%1" }, { workerId: W, sticky: true },
      { lane: "a\nb", sticky: true }, { lane: "manager", sticky: "yes" }, "manager"]) {
      expect(deliver({ target }), JSON.stringify(target)).toBe(false);
    }
  });
  it("refuse an empty or too long text, and a duration out of range; a clock time is dropped, never used (negative controls)", () => {
    for (const o of [{ text: "" }, { text: "x".repeat(8001) }, { ttlMs: 0 }, { ttlMs: 1.5 }, { ttlMs: LIMITS.deliveryKeepMs + 1 }, { ttlMs: "60000" }]) {
      expect(deliver(o), JSON.stringify(o).slice(0, 40)).toBe(false);
    }
    expect(z.parse(OP_ARGS["lane.deliver"], { id: "hub:x", target: { workerId: W }, text: "t", notAfter: 1 })).toEqual({ id: "hub:x", target: { workerId: W }, text: "t" });
  });
  it("delivery.cancel takes an id", () => {
    expect(ok("delivery.cancel", { id: "hub:x" })).toBe(true);
    expect(ok("delivery.cancel", { id: "x" })).toBe(false);
  });
});

describe("pane.keys by name (§5)", () => {
  const keys = (o: Record<string, unknown>) => ok("pane.keys", { workerId: W, expect: EXPECT, ...o });
  it("takes literal text or key names from the allow-list, exactly one", () => {
    expect(keys({ data: "\x1b[A" })).toBe(true);
    expect(keys({ names: ["Escape"] })).toBe(true);
    expect(keys({ names: [...KEY_NAMES] })).toBe(true);
    expect(KEY_NAMES).toHaveLength(52);                                                         // 16 named keys, 10 digits, 26 letters
  });
  it("refuses both, neither, an empty list, and any name off the allow-list (negative controls)", () => {
    expect(keys({ data: "x", names: ["Enter"] }), "both").toBe(false);
    expect(keys({}), "neither").toBe(false);
    expect(keys({ names: [] })).toBe(false);
    for (const name of ["enter", "A", "C-z", "M-x", "F1", "Enter;", ";", "-t", "kill-server", "", "Enter Enter"]) expect(keys({ names: [name] }), name).toBe(false);
    expect(keys({ names: Array.from({ length: LIMITS.maxKeys + 1 }, () => "a") })).toBe(false);
  });
  it("no allowed name starts with - or ends in ;, so none reads as a flag or as tmux's command separator", () => {
    for (const n of KEY_NAMES) expect(n.startsWith("-") || n.endsWith(";"), n).toBe(false);
  });
});

describe("pane.capture (§5)", () => {
  it("takes 1 to 2000 lines, with the screen's attributes and its wrapped lines joined or not, when asked", () => {
    expect(ok("pane.capture", { workerId: W, lines: 60 })).toBe(true);
    expect(ok("pane.capture", { workerId: W, lines: 2000, attributes: true, join: false })).toBe(true);
    for (const lines of [0, 2001, 1.5, -1, "60"]) expect(ok("pane.capture", { workerId: W, lines }), String(lines)).toBe(false);
    expect(ok("pane.capture", { workerId: W, lines: 60, join: "no" })).toBe(false);
    expect(ok("pane.capture", { workerId: "%1", lines: 60 })).toBe(false);
  });
  it("answers text or null, and whether it was cut", () => {
    expect(z.safeParse(OP_RESULTS["pane.capture"], { text: null, truncated: false }).success).toBe(true);
    expect(z.safeParse(OP_RESULTS["pane.capture"], { text: "x" }).success).toBe(false);
  });
});

describe("lane.start's first prompt and lane.stop's mode (§5)", () => {
  it("lane.start takes a prompt as a delivery's text, and answers the trust dialog and the prompt's delivery id", () => {
    expect(ok("lane.start", { name: "x", cwd: "/w", prompt: "begin" })).toBe(true);
    expect(ok("lane.start", { name: "x", cwd: "/w", prompt: "" })).toBe(false);
    expect(ok("lane.start", { name: "x", cwd: "/w", prompt: "x".repeat(8001) })).toBe(false);
    expect(z.safeParse(OP_RESULTS["lane.start"], { workerId: W, waiting: "trust", prompt: "lanes:k1:prompt" }).success).toBe(true);
    expect(z.safeParse(OP_RESULTS["lane.start"], { workerId: W, waiting: "menu" }).success).toBe(false);
  });
  it("lane.stop exits gracefully by default, or kills", () => {
    for (const mode of ["exit", "kill", undefined]) expect(ok("lane.stop", { name: "x", ...(mode ? { mode } : {}) }), String(mode)).toBe(true);
    expect(ok("lane.stop", { name: "x", mode: "force" })).toBe(false);
  });
});

describe("session state on each pane (§5)", () => {
  const inv = (pane: object) => decode(AgentFrames, JSON.stringify({ v: 1, t: "ev.inventory", panes: [{ workerId: W, window: "api", cwd: "/w", ...pane }], invVersion: 1 }));
  const paneOf = (d: ReturnType<typeof inv>) => (d.kind === "ok" && d.frame.t === "ev.inventory" ? d.frame.panes[0] : null);
  it("carries the session file's status and its process", () => {
    expect([...SESSION_STATUSES]).toEqual(["busy", "idle", "waiting", "shell"]);
    for (const status of SESSION_STATUSES) expect(paneOf(inv({ sessionId: UUID, status, pid: 4242 })), status).toMatchObject({ status, pid: 4242 });
    expect(paneOf(inv({ status: null, pid: null }))).toMatchObject({ status: null, pid: null });
  });
  it("carries the session's topic and its last prompt when the agent knows them", () => {
    expect(paneOf(inv({ sessionId: UUID, status: "idle", pid: 4242, topic: "Fix the login form", lastPrompt: "please fix the login form" })))
      .toMatchObject({ topic: "Fix the login form", lastPrompt: "please fix the login form" });
    expect(paneOf(inv({ sessionId: UUID }))).not.toHaveProperty("topic");
    expect(kind(inv({ topic: 7 }))).toBe("malformed");
  });
  it("an agent from before sends neither, and a status this protocol doesn't know reads as null: never a malformed inventory", () => {
    expect(paneOf(inv({}))).toEqual({ workerId: W, window: "api", cwd: "/w", status: null, pid: null });
    expect(paneOf(inv({ status: "compacting", pid: "7" }))).toMatchObject({ status: null, pid: null });
  });
});

describe("ev.delivery (§4.4)", () => {
  const ev = (d: unknown) => decode(AgentFrames, JSON.stringify({ v: 1, t: "ev.delivery", delivery: d }));
  it("carries one delivery's latest state, by t and in the union", () => {
    const done: Delivery = { id: "kira:tg:1:42", node: "pc", target: { workerId: W }, state: "delivered", queuedAt: 1, notAfter: 2, sessionId: UUID, typedAt: 1, deliveredAt: 2 };
    const gone: Delivery = { ...delivery, state: "given_up", why: "gone", note: "the lane's session changed" };
    const unavailable: Delivery = { ...delivery, waiting: { reason: "unavailable", since: 1_791_460_802_000 } };
    for (const d of [delivery, done, gone, unavailable]) {
      expect(kind(ev(d)), d.state).toBe("ok");
      expect(z.safeParse(AgentMessage, { v: 1, t: "ev.delivery", delivery: d }).success, d.state).toBe(true);
      expect(z.parse(DeliverySchema, d)).toEqual(d);
    }
  });
  it("refuses a state, a reason or a give-up it doesn't know, and a delivery without its times (negative controls)", () => {
    for (const bad of [{ ...delivery, state: "lost" }, { ...delivery, waiting: { reason: "asleep", since: 1 } }, { ...delivery, why: "bored" },
      { ...delivery, notAfter: undefined }, { ...delivery, node: "PC" }, { ...delivery, id: "x".repeat(201) }, { ...delivery, target: {} }]) {
      expect(kind(ev(bad)), JSON.stringify(bad).slice(0, 60)).toBe("malformed");
    }
  });
  it("lane.deliver and delivery.cancel answer the delivery", () => {
    for (const op of ["lane.deliver", "delivery.cancel"] as const) expect(z.safeParse(OP_RESULTS[op], { delivery }).success, op).toBe(true);
  });
});

describe("the /lane hook path (§7)", () => {
  const hook = (path: string, body: unknown) => decode(AgentFrames, JSON.stringify({ v: 1, t: "ev.hook", event: { streamId: UUID, seq: 3, at: 1, path, node: "pc", window: "api", body } }));
  it("carries a lane state event the node made, like any hook", () => {
    const body = { event: "needs_input", sessionId: UUID, question: "Which branch should I use?" };
    expect(kind(hook("/lane", body))).toBe("ok");
    expect(z.parse(LaneStateBodySchema, body)).toEqual(body);
    expect(z.parse(LaneStateBodySchema, { event: "answered", sessionId: null })).toEqual({ event: "answered", sessionId: null });
  });
  it("a body of another event, or a question over 200 characters, is not one; nor is another path (negative controls)", () => {
    for (const bad of [{ event: "finished", sessionId: null }, { event: "needs_input" }, { event: "needs_input", sessionId: null, question: "x".repeat(201) }]) {
      expect(z.safeParse(LaneStateBodySchema, bad).success, JSON.stringify(bad).slice(0, 40)).toBe(false);
    }
    expect(kind(hook("/lanes", {}))).toBe("malformed");
  });
});

describe("lane events (§7)", () => {
  const finished: LaneEvent = { v: 1, t: "lane", seq: 7, event: "finished", node: "pc", window: "api", lane: "api", sessionId: UUID, at: 1,
    status: "done", firstLine: "STATUS: DONE, merged", bg: 0, crons: 1 };
  it("decode in each of the four kinds", () => {
    const events: LaneEvent[] = [finished, { ...finished, status: null },
      { v: 1, t: "lane", seq: 8, event: "needs_input", node: "pc", window: "api", lane: "api", at: 2, question: "Proceed?" },
      { v: 1, t: "lane", seq: 9, event: "answered", node: "pc", window: null, lane: null, at: 3 },
      { v: 1, t: "lane", seq: 10, event: "stop_failure", node: "pc", window: "api", lane: "api", at: 4, error: "rate_limit" }];
    for (const e of events) expect(z.parse(LaneEventSchema, e)).toEqual(e);
  });
  it("refuse what isn't one (negative controls)", () => {
    for (const bad of [{ ...finished, event: "started" }, { ...finished, status: "DONE" }, { ...finished, seq: 0 }, { ...finished, v: 2 }, { ...finished, bg: -1 }, { ...finished, t: "ev.lane" }]) {
      expect(z.safeParse(LaneEventSchema, bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
  });
});

describe("alert kinds (§4.5, §6)", () => {
  it("include delivery_waiting and subscriber_lagging (a compile-time check: AlertKind takes both)", () => {
    const kinds: AlertKind[] = ["delivery_waiting", "subscriber_lagging"];
    expect(kinds).toHaveLength(2);
  });
});
