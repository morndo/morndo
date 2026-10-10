# Fleet clients plan, part 1: foundation (Tasks 1 to 3)

Lane `foundation`, branch `feat/fleet-clients-foundation`, worktree `.worktrees/fc-foundation`. It merges into `feat/fleet-clients` before wave 1 starts, so the agent, fleet and hub lanes build on it.

Read first: [`../plan.md`](../plan.md) (its Contracts bind every name below), [`../README.md`](../README.md) (§N below), and the fleet core's [`../../fleet-core/README.md`](../../fleet-core/README.md) ("core §N").

How this part was checked (2026-10-08). Every step's code was run, in a scratch copy of this repository at `849759c` with `npm ci --offline`, on macOS (Darwin 25.5), Node 26.3.1, tmux 3.6a:
- it was built one commit per step, in the order below;
- every "Expected" below is what that run printed;
- every negative control was run with `node scripts/negative-controls.ts --only …` after its commit (58 of 58 bit);
- the code blocks below are copied out of those commits by a script, not typed again.

This version applies the reconciliation's rulings that name part 01 ([`RECONCILIATION.md`](RECONCILIATION.md)): 1, 4, 5, 7 to 13, 15 and 17, then the review round's 48, 49, 50, 56 and 61. Each step was run again.

Two things differ by machine:
- `pane-lock.test.ts` fails with 2 tests on macOS, where there is no `flock(1)`, before and after every task;
- Linux CI runs Node 24.21.0.

---

### Task 1: Protocol: deliveries, lane events, capture, keys by name, session state

Everything in the Contracts' `packages/protocol/src/fleet.ts`, in one commit. The protocol's types are used by all three apps, so the commit also carries the smallest change that keeps each of them compiling. None of those changes alters behaviour:
- every table keyed by `OpName` or by a hook path names the new entries;
- every `Pane` built in code gets `status` and `pid`;
- `pane.keys`' `data` is now optional;
- the fleet's switch over agent messages reads `ev.delivery` and leaves it.

Their real handling is the agent lane's (Tasks 4 to 6) and the fleet lane's (Tasks 7 to 10).

Four rules here are this task's own reading of the Contracts. Each is tested and listed under "Contract additions requested":
- **A delivery's id** is `<client>:<rest>`:
  - the client is a-z, at most 16 letters (§8);
  - at most 200 characters, no control character;
  - never ending in `#` and digits, because `hub:x#2` would collide with the retype key of `hub:x` (§4.3).
- **`ttlMs`** is 1 ms to 7 days (`LIMITS.deliveryKeepMs`). A clock time sent instead is dropped, never used (Review Focus 3).
- **A target** names a lane or a worker ID, never both. The schema's objects are strict, so one naming both fits neither.
- **`Pane.status` and `Pane.pid`** read as `null` when an agent from before sends neither, and when Claude Code writes a status the protocol doesn't know. An older agent's inventory is never malformed (ruling 12).

The rulings add three things here:
- `Pane` gains `topic?` and `lastPrompt?` (ruling 13);
- `WaitingReason` gains `unavailable` (ruling 15);
- `pane.capture` takes `join?`, tmux's `-J`, default true (ruling 10).

**Files:**
- Modify: `packages/protocol/src/fleet.ts`:
  - the header (lines 1–6);
  - `LIMITS` (after line 32);
  - errors (48–56);
  - `Pane`, `OpName`, `OpArgs` and `OpResult` (59–100);
  - `KEYED_OPS`' comment (101);
  - `HookEvent` and `AlertKind` (106–112);
  - the schema pieces (after 158);
  - `OP_NAMES` and `OP_ARGS` (160–188);
  - `PaneSchema`, `DeliverySchema` and `OP_RESULTS` (190–216);
  - the hook path (236);
  - the lane schemas (before 240);
  - `EvDelivery` and the unions (265, 285–291);
  - the type checks (after 372).
- Test: `packages/protocol/test/fleet-clients.test.ts` (new); `packages/protocol/test/fleet.test.ts:46,51,196,281` (the counts, the new ops' results, the error table).
- Modify (the compile ripple, no change of behaviour):
  - `apps/node-agent/src/ops/args.ts:47` (`CHECK` names the three new ops), `apps/node-agent/src/ops/inventory.ts:69` (`status: null, pid` until Task 2), `apps/node-agent/src/ops/pane-ops.ts:100-101` (`data` optional), `apps/node-agent/test/executor.test.ts:210`;
  - `apps/fleet/src/adapters/op-body.ts:15` (`OPS`), `apps/fleet/src/adapters/agent-session.ts:192` (the `ev.delivery` case, for `switch-exhaustiveness-check`), `apps/fleet/src/config.ts:30` (`PATHS` leaves out `/lane`);
  - `apps/fleet/test/helpers/fake-agent.ts:40,170`, `apps/fleet/test/lane-registry.test.ts:17,77`, `apps/fleet/test/liveness.test.ts:56`, `apps/fleet/test/client-api.test.ts:210`;
  - `apps/hub/test/helpers/fake-fleet.ts:108`.
- Modify (Step 10): `scripts/negative-controls.ts:1002` (the `fc1-` entries, before the closing `];`).

**Interfaces:**
- Consumes (in `packages/protocol/src`): `z.ts`; `decode.ts` (`decode`, `parseBody`); `worker-id.ts` (`NODE_NAME`, `WORKER_ID`).
- Produces (all exported from `@morndo/protocol`, `fleet.ts`), the Contracts' names and types exactly:
  - errors: `ErrorCode` gains `id_conflict`, `no_session`, `already_typed`, and `ERROR_EXECUTED` has each as `"no"` (18 codes);
  - session state:
    - `SESSION_STATUSES` (`["busy", "idle", "waiting", "shell"]`, a contract addition) and `SessionStatus`. `"shell"` means Claude Code is alive and running a shell command (ruling 11);
    - `Pane` gains `status: SessionStatus | null`, `pid: number | null`, `topic?: string` and `lastPrompt?: string`: the session's latest `ai-title` and `last-prompt` entries, which the agent fills (ruling 13);
  - keys: `KEY_NAMES` (52 names) and `KeyName`;
  - deliveries: `DeliveryState`, `WaitingReason` (with `unavailable`, ruling 15), `GiveUpReason`, `DeliveryTarget`, `Delivery`, and `DeliverySchema` (the Contracts name it in `EvDelivery`; exported for `packages/fleet-client`);
  - ops:
    - `OP_NAMES` (19), `OpName`, `OpArgs`, `OpResult`, `OP_ARGS`, `OP_RESULTS`, with `pane.capture` (`{ workerId, lines, attributes?, join? }`, ruling 10), `lane.deliver` and `delivery.cancel`;
    - `pane.keys` takes `data?` or `names?`, exactly one;
    - `lane.start` takes `prompt?` and answers `{ workerId, waiting?: "trust", prompt? }`;
    - `lane.stop` takes `mode?: "exit" | "kill"`;
    - `KEYED_OPS` is unchanged.
  - events: `EvDelivery`, in `AgentMessage` and as `AgentFrames["ev.delivery"]`; `HookEvent.path` gains `"/lane"`, with its body `LaneStateBody` and `LaneStateBodySchema` (a contract addition);
  - lane events: `LaneEventName`, `LaneEvent`, `LaneEventSchema` (a contract addition, for `packages/fleet-client`);
  - alerts: `AlertKind` gains `delivery_waiting` and `subscriber_lagging`;
  - limits: `LIMITS` gains the Contracts' 14 fields, `deliveryReceiptHoldMs: 60_000` among them (ruling 48: how long a typed or held delivery waiting for its receipt holds the next one to its lane back; Task 5 reads it).

- [ ] **Step 1: Record the suite before anything changes**

Run: `npx vitest run --project units packages apps/hub apps/node-agent apps/fleet`
Expected: everything passes but, on macOS, `pane-lock.test.ts`'s 2 tests and `process-start.test.ts`'s 2 (they read `/proc`). Note `Test Files` and `Tests`; Step 9 compares. At `12c2811` on 2026-10-09: 202 files, 1469 tests (2 skipped without `flock` on `PATH`, 1 with it).

- [ ] **Step 2: Write the failing test**

Create `packages/protocol/test/fleet-clients.test.ts`:

```ts
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
      deliveryKeepMs: 7 * 86_400_000, deliveryStartGraceMs: 2 * 60_000, deliveryReceiptHoldMs: 60_000, captureMaxLines: 2000, captureMaxBytes: 256 << 10,
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
```

In `packages/protocol/test/fleet.test.ts`, update the counts, the results of the new ops and the error table:

Replace line 46:

```ts
    expect(Object.keys(ERROR_EXECUTED)).toHaveLength(15);
```

with:

```ts
    expect(Object.keys(ERROR_EXECUTED)).toHaveLength(18);
```

Replace line 51:

```ts
    expect(OP_NAMES).toHaveLength(16);
```

with:

```ts
    expect(OP_NAMES).toHaveLength(19);
```

After line 196 (`"lane.start": { workerId: W }, "lane.stop": { ok: true }, "worktree.l…`), insert:

```ts
      "pane.capture": { text: "$ ", truncated: false },
      "lane.deliver": { delivery: { id: "hub:k1", node: "pc", target: { lane: "manager" }, state: "queued", queuedAt: 1, notAfter: 2 } },
      "delivery.cancel": { delivery: { id: "hub:k1", node: "pc", target: { lane: "manager" }, state: "given_up", queuedAt: 1, notAfter: 2, why: "cancelled" } },
```

Replace line 281:

```ts
    const codes: ErrorCode[] = ["bad_args", "unknown_op", "denied", "no_pane", "menu_open", "no_input_box", "draft_present", "busy", "name_taken", "lane_conflict", "too_large", "timeout", "node_offline", "uncertain", "internal"];
```

with:

```ts
    const codes: ErrorCode[] = ["bad_args", "unknown_op", "denied", "no_pane", "menu_open", "no_input_box", "draft_present", "busy", "name_taken", "lane_conflict", "too_large", "timeout", "node_offline", "uncertain", "internal",
      "id_conflict", "no_session", "already_typed"];
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run packages/protocol/test/fleet-clients.test.ts packages/protocol/test/fleet.test.ts`
Expected: FAIL, 28 failed and 26 passed. Most are `TypeError: Cannot read properties of undefined (reading '_zod')` (`OP_ARGS` has no schema for the new ops), with `KEY_NAMES is not iterable`, `SESSION_STATUSES is not iterable` and the counts' assertions (`expected [ 'bad_args', … ] to have a length of 18`).

- [ ] **Step 4: Extend `packages/protocol/src/fleet.ts`**

Each edit below names the file's lines before this step.

Replace line 4:

```ts
// arguments and results, the events, the handshake's signing payloads and the join string.
```

with:

```ts
// arguments and results, the events, the handshake's signing payloads and the join string. Fleet clients (sub-project
// 2, docs/design/fleet-clients/README.md) add the delivery queue (§4), keys by name and the larger capture (§5), each
// pane's session state (§5) and lane events (§7).
```

After line 32 (`subscriberBacklog: 50_000, spoolMaxEvents: 100_000, spoolMaxBytes: 26…`), insert:

```ts
  // the delivery queue (fleet clients §4): an id's length, how long a delivery may wait by default (a client sends a
  // duration, ttlMs, which the node turns into notAfter on its own clock: Review Focus 3), how often the head of a
  // lane is tried at least, the waiting alerts (once each), how long final deliveries are kept, how long a pane that
  // has just started may have no Claude Code session yet before a delivery to it is refused, and how long a typed or
  // held delivery waiting for its receipt holds the next one to its lane back (§4.3)
  maxDeliveryId: 200, deliveryTtlMs: 86_400_000, deliveryTryMs: 5000, deliveryAlertMs: [120_000, 900_000, 3_600_000],
  deliveryKeepMs: 604_800_000, deliveryStartGraceMs: 120_000, deliveryReceiptHoldMs: 60_000,
  // pane.capture (§5): lines asked for, and the text it answers with (one bulk chunk), counted as its JSON-escaped size
  captureMaxLines: 2000, captureMaxBytes: 262_144,
  // lane events (§7) and the fleet's commits (§6): the manager's batch window, how long lane events are kept, the
  // intake window that shares one synced commit, when a subscriber counts as lagging, and how long lane.stop waits
  laneEventBatchMs: 3000, laneEventKeepMs: 604_800_000, intakeWindowMs: 25, subscriberLagMs: 60_000, laneStopWaitMs: 30_000,
```

Replace lines 48–49:

```ts
export type ErrorCode = "bad_args" | "unknown_op" | "denied" | "no_pane" | "menu_open" | "no_input_box"
  | "draft_present" | "busy" | "name_taken" | "lane_conflict" | "too_large" | "timeout" | "node_offline" | "uncertain" | "internal";
```

with:

```ts
// id_conflict: a delivery id already used with another target or text; no_session: a delivery to a pane with no live
// Claude Code session, that is no session file or its process gone (fleet clients §4.1); already_typed:
// delivery.cancel of a delivery past `queued` (§4.3).
export type ErrorCode = "bad_args" | "unknown_op" | "denied" | "no_pane" | "menu_open" | "no_input_box"
  | "draft_present" | "busy" | "name_taken" | "lane_conflict" | "too_large" | "timeout" | "node_offline" | "uncertain" | "internal"
  | "id_conflict" | "no_session" | "already_typed";
```

After line 55 (`busy: "no", name_taken: "no", lane_conflict: "no", too_large: "no", t…`), insert:

```ts
  id_conflict: "no", no_session: "no", already_typed: "no",
```

Replace lines 59–64:

```ts
// `title`: the pane's terminal title (tmux pane_title); `sessionName`: the name Claude Code's session registry gives the
// session running there (what legacy shows as the session's name).
export type Pane = { workerId: string; window: string; cwd: string; sessionId?: string; sessionName?: string; title?: string; claudeVersion?: string };
export type OpName = "inventory.get" | "pane.captureMany" | "pane.frame" | "pane.keys" | "pane.send" | "op.status"
  | "transcript.size" | "transcript.read" | "transcript.locate" | "file.stat" | "file.get" | "file.put"
  | "lane.start" | "lane.stop" | "worktree.list" | "worktree.add";
```

with:

```ts
// A Claude Code session's state, as its session file (~/.claude/sessions/<pid>.json) says it: Claude Code's own value,
// undocumented (seen on 2.1.293 and 2.1.294: busy, idle, waiting, shell). "shell": Claude Code is alive and running a
// shell command (seen at its prompt with a background shell), not exited. A live session takes deliveries whatever its
// status (§4.1).
export const SESSION_STATUSES = ["busy", "idle", "waiting", "shell"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
// `title`: the pane's terminal title (tmux pane_title); `sessionName`: the name Claude Code's session registry gives the
// session running there (what legacy shows as the session's name). `status`: that session's state (null without a
// session); `pid`: the process its session file names, Claude Code's own, as `lanes --json` reports it and claude-pool
// reads it (null without a session). `topic` and `lastPrompt`: the session's latest `ai-title` and `last-prompt`
// transcript entries (Claude Code cuts the prompt to about 200 characters), which the agent keeps from its transcript
// reads; kira shows `title || lastPrompt` and the title (fleet clients §5).
export type Pane = { workerId: string; window: string; cwd: string; sessionId?: string; sessionName?: string; title?: string;
  claudeVersion?: string; status: SessionStatus | null; pid: number | null; topic?: string; lastPrompt?: string };

// Keys a client may press by name (pane.keys `names`, §5): tmux key names (tmux(1), "KEY BINDINGS"), an allow-list.
// None starts with "-" or ends in ";", so none reads as a flag or a command separator on tmux's command line.
export const KEY_NAMES = ["Enter", "Escape", "Tab", "BSpace", "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown",
  "C-c", "C-d", "C-u", "Space", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z"] as const;
export type KeyName = (typeof KEY_NAMES)[number];

// The delivery queue (fleet clients §4). A delivery's `target` as the node keeps it: a lane name (sticky or bound to
// the session it had when queued) or a worker ID. Times are the node's clock.
export type DeliveryState = "queued" | "typed" | "held" | "delivered" | "uncertain" | "given_up";
// unavailable: the node couldn't read or type the pane just now (tmux didn't answer, a capture failed); it tries again.
export type WaitingReason = "menu_open" | "draft_present" | "no_input_box" | "busy" | "no_pane" | "no_session" | "earlier" | "unavailable";
export type GiveUpReason = "expired" | "cancelled" | "gone" | "refused";
// What the fleet asks a node to queue: a lane name with whether it is sticky (the fleet's stickyLanes), or a worker ID.
export type DeliveryTarget = { lane: string; sticky: boolean } | { workerId: string };
export type Delivery = {
  id: string; node: string; target: { lane: string } | { workerId: string };
  state: DeliveryState; queuedAt: number; notAfter: number;
  waiting?: { reason: WaitingReason; since: number };
  sessionId?: string;                                                  // bound (a non-sticky name) or typed into
  typedAt?: number; deliveredAt?: number;
  why?: GiveUpReason; note?: string;                                   // note: e.g. "typed, never seen taken"
};

export type OpName = "inventory.get" | "pane.captureMany" | "pane.frame" | "pane.keys" | "pane.send" | "op.status"
  | "transcript.size" | "transcript.read" | "transcript.locate" | "file.stat" | "file.get" | "file.put"
  | "lane.start" | "lane.stop" | "worktree.list" | "worktree.add" | "pane.capture" | "lane.deliver" | "delivery.cancel";
```

Replace line 69:

```ts
  "pane.keys": { workerId: string; data: string; expect: Expect };
```

with:

```ts
  "pane.keys": { workerId: string; data?: string; names?: KeyName[]; expect: Expect };   // exactly one of data and names
```

Replace lines 78–81:

```ts
  "lane.start": { name: string; cwd: string; account?: string; resume?: string };
  "lane.stop": { name: string };
  "worktree.list": { repo: string };
  "worktree.add": { repo: string; name: string; base: string };
```

with:

```ts
  "lane.start": { name: string; cwd: string; account?: string; resume?: string; prompt?: string };
  "lane.stop": { name: string; mode?: "exit" | "kill" };
  "worktree.list": { repo: string };
  "worktree.add": { repo: string; name: string; base: string };
  "pane.capture": { workerId: string; lines: number; attributes?: boolean; join?: boolean };   // join: tmux -J, default true
  "lane.deliver": { id: string; target: DeliveryTarget; text: string; ttlMs?: number };
  "delivery.cancel": { id: string };
```

Replace line 96:

```ts
  "lane.start": { workerId: string };
```

with:

```ts
  "lane.start": { workerId: string; waiting?: "trust"; prompt?: string /* the first prompt's delivery id */ };
```

Replace lines 100–101:

```ts
};
// Ops with a side effect, which carry a caller's idempotency key (§5.3). Keystrokes carry none: they are never retried.
```

with:

```ts
  "pane.capture": { text: string | null; truncated: boolean };
  "lane.deliver": { delivery: Delivery };
  "delivery.cancel": { delivery: Delivery };
};
// Ops with a side effect, which carry a caller's idempotency key (§5.3). Keystrokes carry none: they are never retried.
// Nor do lane.deliver and delivery.cancel: a delivery's id is its idempotency (fleet clients §4.1), and its typing runs
// inside the agent under the id as a done key (§4.3), a retype under `${id}#2`.
```

Replace lines 106–107:

```ts
export type HookEvent = { streamId: string; seq: number; at: number; path: "/cc" | "/sl" | "/hook/stop" | "/hook/failure" | "/notify" | "/file";
  node: string; window: string | null; late?: true; body: unknown };
```

with:

```ts
// "/lane": a lane state event the node made from its session state (fleet clients §7), carried and replayed like a hook.
// Its body: { event: "needs_input" | "answered"; sessionId: string | null; question?: string }.
export type HookEvent = { streamId: string; seq: number; at: number;
  path: "/cc" | "/sl" | "/hook/stop" | "/hook/failure" | "/notify" | "/file" | "/lane";
  node: string; window: string | null; late?: true; body: unknown };

// A lane event (fleet clients §7), built by the fleet per node and window from the hooks and each node's session state.
// `seq` is the fleet's own (lane_events), so a client reads on with GET /v1/lane-events?since=<seq>.
export type LaneEventName = "finished" | "needs_input" | "answered" | "stop_failure";
export type LaneEvent = { v: 1; t: "lane"; seq: number; event: LaneEventName; node: string;
  window: string | null; lane: string | null; sessionId?: string; at: number;
  status?: "done" | "blocked" | "needs_decision" | null; firstLine?: string; bg?: number; crons?: number; question?: string; error?: string };
```

Replace lines 111–112:

```ts
export type AlertKind = "instance_conflict" | "source_changed" | "clock_offset" | "rate_limited" | "lane_conflict" | "dead_letter" | "backlog_full"
  | "unrouted_hook";
```

with:

```ts
// delivery_waiting: a delivery still queued, typed or held after 2, 15 and 60 minutes (fleet clients §4.5);
// subscriber_lagging: a subscriber's oldest undelivered event is older than 60 s (§6).
export type AlertKind = "instance_conflict" | "source_changed" | "clock_offset" | "rate_limited" | "lane_conflict" | "dead_letter" | "backlog_full"
  | "unrouted_hook" | "delivery_waiting" | "subscriber_lagging";
```

After line 158 (`const refName = () => z.string().check(z.regex(/^(?![-/.]|HEAD$)(?!.*…`), insert:

```ts
// Text typed into a lane: a delivery's, a first prompt's (as pane.send's).
const sendText = () => z.string().check(z.minLength(1), z.maxLength(LIMITS.maxSendText));
// A delivery's id (fleet clients §4.1), chosen by its client and namespaced like a key ("hub:…", "kira:…"; the client a-z,
// at most 16 letters, §8), at most 200 characters, no control character. It is also the done key its typing runs under,
// and `${id}#2` the one retype's (§4.3), so an id never ends in "#" and digits: "hub:x#2" would meet the retype of "hub:x".
const deliveryId = () => z.string().check(z.regex(/^[a-z]{1,16}:[^\p{Cc}]+$/u), z.maxLength(LIMITS.maxDeliveryId),
  z.refine(id => !/#\d+$/.test(id), "an id that is not a retype's key"));
// Exactly one kind of target: one naming both a lane and a worker ID fits neither branch (strict objects), so it is
// refused, never read as one of the two.
const DeliveryTargetSchema = z.union([z.strictObject({ lane: windowName(), sticky: z.boolean() }), z.strictObject({ workerId: workerId() })]);
```

Replace line 163:

```ts
  "lane.start", "lane.stop", "worktree.list", "worktree.add",
```

with:

```ts
  "lane.start", "lane.stop", "worktree.list", "worktree.add", "pane.capture", "lane.deliver", "delivery.cancel",
```

Replace line 171:

```ts
  "pane.keys": z.object({ workerId: workerId(), data: z.string().check(z.minLength(1), z.maxLength(LIMITS.maxKeys)), expect: ExpectSchema }),
```

with:

```ts
  // Literal text (data) or tmux key names (names), exactly one (fleet clients §5).
  "pane.keys": z.object({
    workerId: workerId(), data: z.exactOptional(z.string().check(z.minLength(1), z.maxLength(LIMITS.maxKeys))),
    names: z.exactOptional(z.array(z.enum(KEY_NAMES)).check(z.minLength(1), z.maxLength(LIMITS.maxKeys))), expect: ExpectSchema,
  }).check(z.refine(a => (a.data === undefined) !== (a.names === undefined), "data or names, exactly one")),
```

Replace lines 184–187:

```ts
  "lane.start": z.object({ name: windowName(), cwd: absolutePath(), account: z.exactOptional(account()), resume: z.exactOptional(z.uuid()) }),
  "lane.stop": z.object({ name: windowName() }),
  "worktree.list": z.object({ repo: absolutePath() }),
  "worktree.add": z.object({ repo: absolutePath(), name: refName(), base: refName() }),
```

with:

```ts
  "lane.start": z.object({ name: windowName(), cwd: absolutePath(), account: z.exactOptional(account()), resume: z.exactOptional(z.uuid()),
    prompt: z.exactOptional(sendText()) }),
  "lane.stop": z.object({ name: windowName(), mode: z.exactOptional(z.enum(["exit", "kill"])) }),
  "worktree.list": z.object({ repo: absolutePath() }),
  "worktree.add": z.object({ repo: absolutePath(), name: refName(), base: refName() }),
  "pane.capture": z.object({
    workerId: workerId(), lines: z.int().check(z.gte(1), z.lte(LIMITS.captureMaxLines)), attributes: z.exactOptional(z.boolean()), join: z.exactOptional(z.boolean()),
  }),
  // ttlMs, never a clock time: the node turns it into notAfter on its own clock (Review Focus 3). At most the 7 days a
  // final delivery is kept.
  "lane.deliver": z.object({
    id: deliveryId(), target: DeliveryTargetSchema, text: sendText(), ttlMs: z.exactOptional(z.int().check(z.gte(1), z.lte(LIMITS.deliveryKeepMs))),
  }),
  "delivery.cancel": z.object({ id: deliveryId() }),
```

Replace lines 193–194:

```ts
});
export const SEND_PROBLEMS = ["menu_open", "draft_present", "no_input_box", "not_submitted", "no_pane", "busy"] as const;
```

with:

```ts
  topic: z.exactOptional(text()), lastPrompt: z.exactOptional(text()),
  // An agent from before session state sends neither, and Claude Code may one day write a status this protocol doesn't
  // know: either reads as null, never as a malformed inventory. A default "short-circuit[s] the parsing process. If the
  // input is undefined, the default value is eagerly returned"; any other value goes through the transform (zod 4.6.5,
  // https://zod.dev/api#defaults and #transforms, read 2026-10-08).
  status: z._default(z.pipe(z.unknown(), z.transform((s): SessionStatus | null => ((SESSION_STATUSES as readonly unknown[]).includes(s) ? s as SessionStatus : null))), null),
  pid: z._default(z.pipe(z.unknown(), z.transform((p): number | null => (typeof p === "number" && Number.isSafeInteger(p) && p >= 1 ? p : null))), null),
});
export const SEND_PROBLEMS = ["menu_open", "draft_present", "no_input_box", "not_submitted", "no_pane", "busy"] as const;

const DELIVERY_STATES = ["queued", "typed", "held", "delivered", "uncertain", "given_up"] as const satisfies readonly DeliveryState[];
const WAITING_REASONS = ["menu_open", "draft_present", "no_input_box", "busy", "no_pane", "no_session", "earlier", "unavailable"] as const satisfies readonly WaitingReason[];
const GIVE_UP_REASONS = ["expired", "cancelled", "gone", "refused"] as const satisfies readonly GiveUpReason[];
// A delivery as its node reports it (agent → fleet: shape), and as the fleet passes it on to clients (§4.4, §8).
export const DeliverySchema = z.object({
  id: label(), node: nodeName(), target: z.union([z.object({ lane: text() }), z.object({ workerId: workerId() })]),
  state: z.enum(DELIVERY_STATES), queuedAt: z.number(), notAfter: z.number(),
  waiting: z.exactOptional(z.object({ reason: z.enum(WAITING_REASONS), since: z.number() })),
  sessionId: z.exactOptional(text()), typedAt: z.exactOptional(z.number()), deliveredAt: z.exactOptional(z.number()),
  why: z.exactOptional(z.enum(GIVE_UP_REASONS)), note: z.exactOptional(label()),
});
```

Replace line 212:

```ts
  "lane.start": z.object({ workerId: workerId() }),
```

with:

```ts
  "lane.start": z.object({ workerId: workerId(), waiting: z.exactOptional(z.literal("trust")), prompt: z.exactOptional(label()) }),
```

After line 215 (`"worktree.add": z.object({ path: text() }),`), insert:

```ts
  "pane.capture": z.object({ text: z.nullable(text()), truncated: z.boolean() }),
  "lane.deliver": z.object({ delivery: DeliverySchema }),
  "delivery.cancel": z.object({ delivery: DeliverySchema }),
```

Replace lines 236–237:

```ts
  path: z.enum(["/cc", "/sl", "/hook/stop", "/hook/failure", "/notify", "/file"]),
  node: nodeName(), window: z.nullable(text()), late: z.exactOptional(z.literal(true)), body: z.unknown(),
```

with:

```ts
  path: z.enum(["/cc", "/sl", "/hook/stop", "/hook/failure", "/notify", "/file", "/lane"]),
  node: nodeName(), window: z.nullable(text()), late: z.exactOptional(z.literal(true)), body: z.unknown(),
});

// The body of a "/lane" hook event: a lane state event the node made from its session's status (fleet clients §7).
export type LaneStateBody = { event: "needs_input" | "answered"; sessionId: string | null; question?: string };
export const LaneStateBodySchema = z.object({
  event: z.enum(["needs_input", "answered"]), sessionId: z.nullable(text()), question: z.exactOptional(label()),
});
// A lane event as the fleet publishes and serves it (§7, §8).
export const LaneEventSchema = z.object({
  v, t: z.literal("lane"), seq: z.int().check(z.gte(1)), event: z.enum(["finished", "needs_input", "answered", "stop_failure"]),
  node: nodeName(), window: z.nullable(text()), lane: z.nullable(text()), sessionId: z.exactOptional(text()), at: z.number(),
  status: z.exactOptional(z.nullable(z.enum(["done", "blocked", "needs_decision"]))), firstLine: z.exactOptional(text()),
  bg: z.exactOptional(count()), crons: z.exactOptional(count()), question: z.exactOptional(text()), error: z.exactOptional(text()),
```

After line 265 (`export const EvHealth = z.object({ v, t: z.literal("ev.health"), heal…`), insert:

```ts
// The latest state of one delivery (fleet clients §4.4): on every change, and after every (re)connect for each one not
// final and the final ones of the last hour. Latest wins, as the inventory.
export const EvDelivery = z.object({ v, t: z.literal("ev.delivery"), delivery: DeliverySchema });
```

Replace line 285:

```ts
export const AgentMessage = z.discriminatedUnion("t", [Join, Hello, Proof, Res, EvHook, EvInventory, EvHealth]);
```

with:

```ts
export const AgentMessage = z.discriminatedUnion("t", [Join, Hello, Proof, Res, EvHook, EvInventory, EvHealth, EvDelivery]);
```

Replace line 291:

```ts
export const AgentFrames = { join: Join, hello: Hello, proof: Proof, res: Res, "ev.hook": EvHook, "ev.inventory": EvInventory, "ev.health": EvHealth };
```

with:

```ts
export const AgentFrames = {
  join: Join, hello: Hello, proof: Proof, res: Res, "ev.hook": EvHook, "ev.inventory": EvInventory, "ev.health": EvHealth, "ev.delivery": EvDelivery,
};
```

After line 372 (`check<Same<z.output<typeof JoinStringSchema>, JoinString>>(true);`), insert:

```ts
check<Same<z.output<typeof DeliverySchema>, Delivery>>(true);
check<Same<z.output<typeof DeliveryTargetSchema>, DeliveryTarget>>(true);
check<Same<z.output<typeof LaneEventSchema>, LaneEvent>>(true);
check<Same<z.output<typeof LaneStateBodySchema>, LaneStateBody>>(true);
check<Same<(typeof SESSION_STATUSES)[number], SessionStatus>>(true);
```

`LaneStateBodySchema` caps `question` at 200 characters, as kira's rule does (§7). `topic` and `lastPrompt` are optional strings, as `title` is. On the PC on 2026-10-08:
- the entries were `{"type":"ai-title","aiTitle":…,"sessionId":…}` and `{"type":"last-prompt","lastPrompt":…,"leafUuid":…,"sessionId":…}`;
- Claude Code cut `lastPrompt` to at most 201 characters, so an inventory stays small;
- some `last-prompt` entries had no `lastPrompt` at all.

Reading them is the agent's (Task 6). `PaneSchema`'s `status` and `pid` take any value: a default handles a missing one, and a transform handles one of the wrong kind. `z.catch` would also have worked, but oxlint's `promise/valid-params` reads `z.catch(schema, null)` as a `Promise.catch` with two arguments and refuses it.

- [ ] **Step 5: Run the protocol tests**

Run: `npx vitest run packages/protocol`
Expected: PASS, 9 files, 105 tests (78 before, plus 27 in `fleet-clients.test.ts`).

Then check that each new rule bites. Make each change alone, run `npx vitest run packages/protocol/test/fleet-clients.test.ts`, see the one failure, and restore the line before the next. These are Step 10's `fc1-` entries:
- the retype suffix: change `z.refine(id => !/#\d+$/.test(id), "an id that is not a retype's key")` to `z.refine(() => true, "an id that is not a retype's key")`. Expected: `"hub:x#2": expected true to be false`.
- no control character: change `z.regex(/^[a-z]{1,16}:[^\p{Cc}]+$/u)` to `z.regex(/^[a-z]{1,16}:.+$/su)`. Expected: `"hub:a\nb": expected true to be false`.
- one kind of target: change both `z.strictObject(` in `DeliveryTargetSchema` to `z.object(`. Expected: `{"lane":"manager","sticky":true,"workerId":"pc.3fa2c1d0.12"}: expected true to be false`.
- `ttlMs` bounded: drop `, z.lte(LIMITS.deliveryKeepMs)`. Expected: `{"ttlMs":604800001}: expected true to be false`.
- exactly one of `data` and `names`: change `(a.data === undefined) !== (a.names === undefined)` to `(a.data !== undefined || a.names !== undefined)`. Expected: `both: expected true to be false`.
- the allow-list: change `z.enum(KEY_NAMES)` to `z.enum([...KEY_NAMES, "kill-server"])`. Expected: `kill-server: expected true to be false`.
- an older agent's pane: change `PaneSchema`'s `status: z._default(z.pipe(…), null),` to `status: z.nullable(z.enum(SESSION_STATUSES)),`. Expected: two failures, "… never a malformed inventory" and "carries the session's topic and its last prompt"; the first one (`expected null to deeply equal { workerId: 'pc.3fa2c1d0.12', … }`).

- [ ] **Step 6: Check that the compile-time type checks bite**

In `fleet.ts`, change `why?: GiveUpReason; note?: string;` in `Delivery` to `why?: GiveUpReason; note?: number;`.

Run: `npx tsc -p packages/protocol`
Expected: FAIL with `error TS2344: Type 'false' does not satisfy the constraint 'true'.` twice: on the `OP_RESULTS` check line (`lane.deliver` answers a `Delivery`) and on `check<Same<z.output<typeof DeliverySchema>, Delivery>>(true);`.

Change it back and run `npx tsc -p packages/protocol` again. Expected: no output, exit 0.

- [ ] **Step 7: See what the apps need**

Run: `npx tsc -p apps/hub; (cd apps/node-agent && npx tsc -p .); (cd apps/fleet && npx tsc -p .); npx tsc -p tsconfig.tests.json`
Expected: errors only at these lines (each app's own `tsc` and `tsconfig.tests.json` report the test files twice):
- `apps/node-agent/src/ops/args.ts:31`, `inventory.ts:64`, `pane-ops.ts:101`, `apps/node-agent/test/executor.test.ts:210`;
- `apps/fleet/src/adapters/op-body.ts:12`, `apps/fleet/src/config.ts:30`;
- `apps/fleet/test/client-api.test.ts:21,104,199,204,213`, `helpers/fake-agent.ts:34`, `lane-registry.test.ts:17,77`, `liveness.test.ts:53`, `router.test.ts:14,93,128`;
- `apps/hub/test/helpers/fake-fleet.ts:102`.

- [ ] **Step 8: The compile ripple**

`apps/node-agent/src/ops/args.ts`:

After line 47 (`"worktree.add": decoded("worktree.add"),`), insert:

```ts
  // Fleet clients (docs/design/fleet-clients/README.md §4, §5): checked here like every op; a node without their
  // handlers answers them unknown_op.
  "pane.capture": decoded("pane.capture"),
  "lane.deliver": decoded("lane.deliver"),
  "delivery.cancel": decoded("delivery.cancel"),
```

`apps/node-agent/src/ops/inventory.ts`: Task 2 replaces `status: null` with the session's own:

After line 69 (`...(s?.version ? { claudeVersion: s.version } : {}),`), insert:

```ts
        status: null, pid: s?.pid ?? null,                       // the session's status: node-ops reads it from Task 2 on
```

`apps/node-agent/src/ops/pane-ops.ts`: keys by name type nothing until Task 6 gives the agent `sendKeyNames`:

Replace line 101:

```ts
      guarded(a.workerId, a.expect, ctx, async pane => ok<"pane.keys">({ ok: await d.terminal.keys(pane, a.data) }))),
```

with:

```ts
      // Literal text; keys by name (`names`, fleet clients §5) type nothing until this node has them.
      guarded(a.workerId, a.expect, ctx, async pane => ok<"pane.keys">({ ok: a.data !== undefined && await d.terminal.keys(pane, a.data) }))),
```

`apps/node-agent/test/executor.test.ts`:

Replace line 210:

```ts
        acted.push(a.data);
```

with:

```ts
        acted.push(a.data ?? "");
```

`apps/fleet/src/adapters/op-body.ts` names every op to compile. Task 8 then refuses `lane.deliver` and `delivery.cancel` on `/v1/op` (ruling 4):

After line 15 (`"lane.start": true, "lane.stop": true, "worktree.list": true, "worktr…`), insert:

```ts
  "pane.capture": true, "lane.deliver": true, "delivery.cancel": true,
```

`apps/fleet/src/adapters/agent-session.ts`. oxlint's `typescript/switch-exhaustiveness-check` requires the case; Task 8 keeps the mirror:

After line 192 (`return d.connections.health(state.node, m.health);`), insert:

```ts
      case "ev.delivery":
        // A delivery's latest state (fleet clients §4.4): read and left until the fleet keeps a mirror of deliveries (§4.6).
        if (state.kind !== "live") return close(1008, "unexpected event");
        return;
```

`apps/fleet/src/config.ts`. `HOOK_PATHS` stays the six that a subscriber may name (`config.test.ts` pins them): `/lane` is the node's own path, never a subscriber's (ruling 5):

Replace line 30:

```ts
const PATHS: Record<HookPath, true> = { "/cc": true, "/sl": true, "/hook/stop": true, "/hook/failure": true, "/notify": true, "/file": true };
```

with:

```ts
// "/lane" is not one a subscriber names: it carries the node's own lane state events, from which the fleet builds lane
// events (fleet clients §7).
const PATHS: Record<Exclude<HookPath, "/lane">, true> = { "/cc": true, "/sl": true, "/hook/stop": true, "/hook/failure": true, "/notify": true, "/file": true };
```

`apps/fleet/test/helpers/fake-agent.ts`:

After line 40 (`"worktree.add": { path: "/work" },`), insert:

```ts
    "pane.capture": { text: null, truncated: false },
    "lane.deliver": { delivery: { id: "hub:fake", node: node || "node", target: { lane: "fake" }, state: "queued", queuedAt: 1, notAfter: 2 } },
    "delivery.cancel": { delivery: { id: "hub:fake", node: node || "node", target: { lane: "fake" }, state: "given_up", queuedAt: 1, notAfter: 2, why: "cancelled" } },
```

Replace line 170:

```ts
  inventory(panes: Pane[]): void { this.send({ v: 1, t: "ev.inventory", panes, invVersion: ++this.invVersion }); }
```

with:

```ts
  // A pane may leave out status and pid, as an agent from before session state does (fleet clients §5).
  inventory(panes: (Omit<Pane, "status" | "pid"> & Partial<Pick<Pane, "status" | "pid">>)[]): void { this.send({ v: 1, t: "ev.inventory", panes, invVersion: ++this.invVersion }); }
```

`apps/fleet/test/lane-registry.test.ts`:

Replace line 17:

```ts
const pane = (node: string, n: number, window: string): Pane => ({ workerId: `${node}.3fa2c1d0.${n}`, window, cwd: `/work/${n}` });
```

with:

```ts
const pane = (node: string, n: number, window: string): Pane => ({ workerId: `${node}.3fa2c1d0.${n}`, window, cwd: `/work/${n}`, status: null, pid: null });
```

Replace line 77:

```ts
    lanes.inventory("pc", [{ workerId: "pc.0badcafe.0", window: "api", cwd: "/work" }]);
```

with:

```ts
    lanes.inventory("pc", [{ workerId: "pc.0badcafe.0", window: "api", cwd: "/work", status: null, pid: null }]);
```

`apps/fleet/test/liveness.test.ts` and `apps/fleet/test/client-api.test.ts` compare a fake agent's panes, as the fleet passes them on, exactly:

Replace line 56:

```ts
    expect(seen[1]).toEqual({ t: "inventory", node: "pc", body: { panes: [{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/work/api" }], invVersion: 2 } });
```

with:

```ts
    // An agent that sends no session state (one from before it): the fleet reads both as null (fleet clients §5).
    expect(seen[1]).toEqual({ t: "inventory", node: "pc", body: { panes: [{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/work/api", status: null, pid: null }], invVersion: 2 } });
```

Replace line 210:

```ts
      { status: "offline" }, { status: "online" }, { panes: [{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w" }], invVersion: 2 },
```

with:

```ts
      { status: "offline" }, { status: "online" }, { panes: [{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w", status: null, pid: null }], invVersion: 2 },
```

`apps/hub/test/helpers/fake-fleet.ts`:

After line 108 (`...(s ? { sessionId: s.sessionId } : {}), ...(s?.name ? { sessionName…`), insert:

```ts
        status: null, pid: s?.pid ?? null,
```

- [ ] **Step 9: Run the repo's checks**

Run each in turn, from the repo root:
- `npm run check`. Expected: exit 0; svelte-check ends with `0 ERRORS 0 WARNINGS`.
- `npm run lint`. Expected: no problems reported.
- `npx vitest run --project units packages apps/hub apps/node-agent apps/fleet`. Expected: Step 1's `Test Files` + 1 and `Tests` + 27, with the same failures as Step 1. At `12c2811` on 2026-10-09: 203 files, 1496 tests.
- `npm run build`, then `npm run check:build`. Expected: three `PASS` lines. Measured on 2026-10-08: all client JS went from 303.2 KB to 303.6 KB gzipped (+10.4% against the recorded 275.0 KB; the limit is +15%).

- [ ] **Step 10: The negative controls, as data**

In `scripts/negative-controls.ts`, before the closing `];` of `CONTROLS` (line 1002), add:

```ts
  // ---- Fleet clients, Tasks 1 to 3: the foundation (docs/design/fleet-clients/plan/01-foundation.md; each task's
  // "check that it bites" step). Task ids carry "fc" so they never meet the fleet core's task numbers.
  { id: "fc1-delivery-id-retype", task: "fc1", file: "packages/protocol/src/fleet.ts",
    find: String.raw`z.refine(id => !/#\d+$/.test(id), "an id that is not a retype's key")`, replace: `z.refine(() => true, "an id that is not a retype's key")`,
    run: ["packages/protocol/test/fleet-clients.test.ts"], expect: '"hub:x#2"' },
  { id: "fc1-delivery-id-no-control", task: "fc1", file: "packages/protocol/src/fleet.ts",
    find: String.raw`z.regex(/^[a-z]{1,16}:[^\p{Cc}]+$/u)`, replace: String.raw`z.regex(/^[a-z]{1,16}:.+$/su)`,
    run: ["packages/protocol/test/fleet-clients.test.ts"], expect: String.raw`"hub:a\nb"` },
  { id: "fc1-delivery-target-one-kind", task: "fc1", file: "packages/protocol/src/fleet.ts",
    find: "z.union([z.strictObject({ lane: windowName(), sticky: z.boolean() }), z.strictObject({ workerId: workerId() })])",
    replace: "z.union([z.object({ lane: windowName(), sticky: z.boolean() }), z.object({ workerId: workerId() })])",
    run: ["packages/protocol/test/fleet-clients.test.ts"], expect: '{"lane":"manager","sticky":true,"workerId":"pc.3fa2c1d0.12"}' },
  { id: "fc1-delivery-ttl-bounded", task: "fc1", file: "packages/protocol/src/fleet.ts",
    find: "ttlMs: z.exactOptional(z.int().check(z.gte(1), z.lte(LIMITS.deliveryKeepMs)))", replace: "ttlMs: z.exactOptional(z.int().check(z.gte(1)))",
    run: ["packages/protocol/test/fleet-clients.test.ts"], expect: '{"ttlMs":604800001}' },
  { id: "fc1-keys-data-or-names", task: "fc1", file: "packages/protocol/src/fleet.ts",
    find: "(a.data === undefined) !== (a.names === undefined)", replace: "(a.data !== undefined || a.names !== undefined)",
    run: ["packages/protocol/test/fleet-clients.test.ts"], expect: "both: expected true to be false" },
  { id: "fc1-key-names-allow-list", task: "fc1", file: "packages/protocol/src/fleet.ts",
    find: "names: z.exactOptional(z.array(z.enum(KEY_NAMES))", replace: "names: z.exactOptional(z.array(z.enum([...KEY_NAMES, \"kill-server\"]))",
    run: ["packages/protocol/test/fleet-clients.test.ts"], expect: "kill-server" },
  { id: "fc1-pane-status-older-agent", task: "fc1", file: "packages/protocol/src/fleet.ts",
    find: "status: z._default(z.pipe(z.unknown(), z.transform((s): SessionStatus | null => ((SESSION_STATUSES as readonly unknown[]).includes(s) ? s as SessionStatus : null))), null),",
    replace: "status: z.nullable(z.enum(SESSION_STATUSES)),",
    run: ["packages/protocol/test/fleet-clients.test.ts"], expect: "never a malformed inventory" },
```

Run: `node scripts/negative-controls.ts --check | grep -v '^ok'`
Expected: no output.

- [ ] **Step 11: Commit**

```bash
git add packages/protocol/src/fleet.ts packages/protocol/test/fleet-clients.test.ts packages/protocol/test/fleet.test.ts apps/node-agent/src/ops/args.ts apps/node-agent/src/ops/inventory.ts apps/node-agent/src/ops/pane-ops.ts apps/node-agent/test/executor.test.ts apps/fleet/src/adapters/op-body.ts apps/fleet/src/adapters/agent-session.ts apps/fleet/src/config.ts apps/fleet/test/helpers/fake-agent.ts apps/fleet/test/lane-registry.test.ts apps/fleet/test/liveness.test.ts apps/fleet/test/client-api.test.ts apps/hub/test/helpers/fake-fleet.ts scripts/negative-controls.ts
git commit -m "feat(protocol): deliveries, lane events, keys by name, capture and session state for fleet clients"
```

- [ ] **Step 12: Run the controls, after the commit**

The runner works on a worktree of `HEAD` (ruling 50), so it runs once the controls and their guards are committed.

Run: `node scripts/negative-controls.ts --only fc1-delivery-id-retype --only fc1-delivery-id-no-control --only fc1-delivery-target-one-kind --only fc1-delivery-ttl-bounded --only fc1-keys-data-or-names --only fc1-key-names-allow-list --only fc1-pane-status-older-agent`
Expected: `7/7 controls bit; still pass 0, broke 0, timed out 0, skipped 0`.

---

### Task 2: node-ops: transcript receipts, menu question, session status, keys and capture

Four additions to `packages/node-ops`, each in its own commit:
- **the transcript receipt** (Steps 1–6): the manager inbox's rules for "Claude Code has taken this text", ported with their tests, then extended to what 2.1.293 writes. On top come Review Focus 1's slash command, and the receipt of a command that starts a new session (ruling 17). The recorded fixtures come first; the deliverer (Task 5) and the drills (Task 16) use them too;
- **the menu question** (Steps 7–10): kira's `parseMenu` and its pick, ported;
- **each session's status** (Steps 11–14), from its session file;
- **the tmux adapter's additions** (Steps 15–19): keys by name, a capture of N lines with attributes, and the launcher's literal paste.

**Where the rules come from.** All read on 2026-10-08, read-only:
- the inbox's transcript rules and their tests ("transcript receipts"; finding 1);
- the chat bot's pane text, its menu parser and the question it emits;
- the shapes in the owner's transcripts of the last two days on the PC (970 files; a 2.1.293 transcript for the fixtures' key sets), tallied by kind with `jq`, masked;
- the live session files (`~/.claude/sessions/*.json`).

No text of the owner's was copied: every fixture text is synthetic, in the recorded keys and shapes. What the tally found, beyond the spec's §1:
- **`remove`:** 2,736 in two days, every one with a reason (2,727 `absorbed_mid_turn`, 9 `delivered_to_agent`). The inbox counted one without a reason as delivered; here it gives no verdict.
- **A queued line:** 92 queued prompts (`promptSource: "queued"`) in two days, outside subagents. 90 were each the text of exactly one `enqueue` before them; 2 had no `enqueue` in the same file. None held two queued lines: 2.1.293 did not merge them into one prompt. The inbox's merged rule is kept, as the inbox has it.
- **`cleared_on_cancel`** did not occur in the transcripts searched. Its shape is the inbox's (`review-fixes.test.ts`, written against 2.1.289).
- **A slash command** is a `user` entry with no `promptSource`: `"<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>"`. A plugin's command puts `<command-message>` first.
  - On `/compact` it comes after the compaction's summary (`isCompactSummary`), which quotes earlier prompts verbatim, and a meta caveat (`isMeta`). Neither is a prompt.
  - On `/clear` it is the 7th line of the **new** session's transcript: a `/clear` typed into one session is recorded only in another. Ruling 17: its receipt is the pane's session changing to a new id after the typing (`newSessionReceipt`). `clear-new-session.jsonl` pins where the command is recorded.
- **The session file's `status`** was `shell` on two live 2.1.293 and 2.1.294 sessions, each sampled for two minutes:
  - the Claude Code process was alive (`ps -o comm=` printed `claude`);
  - the pane showed its input box, not busy;
  - one showed a "· 1 shell" footer.
  
  Ruling 11 settles it: `shell` means Claude Code is alive and running a shell command, and a lane takes deliveries while it has a live session, whatever its status. `sessions.ts` passes the file's value on as it is. A session file whose process is gone is no session, as before (`byPane`).

**Files:**
- Create (Steps 1–6):
  - `test/fixtures/claude-code/2.1.293/` with `typed-prompt.jsonl`, `queued-then-prompt.jsonl`, `absorbed-mid-turn.jsonl`, `delivered-to-agent.jsonl`, `cleared-on-cancel.jsonl`, `unknown-remove-reason.jsonl`, `pasted-wrapper.jsonl`, `pasted-short-form.jsonl`, `slash-command.jsonl`, `clear-new-session.jsonl`, `not-prompts.jsonl` and `session-file.json`, at the repo root, next to `test/fixtures/fake-claude-pane.ts`, so Task 16's drills read the same files;
  - `packages/node-ops/src/receipt.ts`, `packages/node-ops/test/receipt.test.ts`.
- Create (Steps 7–10): `packages/node-ops/src/menu.ts`, `packages/node-ops/test/menu.test.ts`.
- Create (Steps 15–19): `packages/node-ops/test/tmux-keys-capture.test.ts`.
- Modify:
  - `packages/node-ops/src/index.ts:12` (two exports);
  - `.oxlintrc.json:30` (`menu.ts` reads escape sequences, so `no-control-regex` is off for it, as for `tmux.ts`);
  - `packages/node-ops/src/sessions.ts:8-10,21,43-45`;
  - `packages/node-ops/test/sessions.test.ts:3,33`;
  - `packages/node-ops/src/tmux.ts:1-21,128-142,148-157`.
- Modify (Step 13, the session status ripple):
  - `apps/node-agent/src/ops/inventory.ts:70`, `apps/hub/src/adapters/fleet-adapters.ts:305`;
  - `apps/hub/test/helpers/fake-fleet.ts:289`, `apps/hub/test/escalation-window.test.ts:133`, `apps/hub/test/observation-unavailable.test.ts:41`, `apps/hub/test/fleet-adapters.test.ts:320`, `apps/node-agent/test/relay-server.test.ts:32`, `apps/hub/test/val-pr18-findings.test.ts:51`.
- Modify (Step 17): `apps/hub/test/local-node.test.ts:21` (its fake `Tmux` gains the two methods).
- Modify:
  - `scripts/negative-controls.ts:840` (Step 18: `b4-paste-spawn-timeout`'s text moved into `pasteText`);
  - the `fc2-` entries (Step 20).

**Interfaces:**
- Consumes:
  - `@morndo/protocol` (Task 1): `KEY_NAMES`, `KeyName`, `SESSION_STATUSES`, `SessionStatus`, and `LIMITS.captureMaxLines` and `LIMITS.maxKeys`;
  - `tmuxArgv` (`tmux-cli.ts`);
  - the test helper `isolatedTmux` (`test/isolated-tmux.ts`).
- Produces (all exported from `@morndo/node-ops`):
  - `receipt.ts`, the Contracts' exactly:
    - `type ReceiptVerdict = "delivered" | "held" | "dropped" | "none"` and `type PendingText = { id: string; text: string; typedAt: number }`;
    - `readReceipts(lines: string[], pending: PendingText[]): { id: string; verdict: Exclude<ReceiptVerdict, "none">; at: number }[]`: each entry decides at most one pending text, the earliest typed that it fits at or after its `typedAt`;
      - an `enqueue` holds one not yet held in the same read;
      - `at` is the entry's own `timestamp`, which Claude Code writes on the node's clock;
    - `promptMatches(text: string, prompt: string): boolean`;
    - ruling 17 (names chosen here, a contract addition): `startsNewSession(text: string): boolean`, for `/clear [name]` and its aliases `/reset` and `/new`; and `newSessionReceipt(text: string, typedInto: string, sessionNow: string | null): boolean`, true when such a command's pane now runs another session than the one it was typed into.
  - `menu.ts`: `menuQuestion(screen: string): string | null`.
  - `sessions.ts`: `SessionInfo` gains `status: SessionStatus | null`. Its `pid: number` is already there: the process the session file is named for, Claude Code's own.
  - `tmux.ts`: `Tmux` gains:
    - `sendKeyNames(paneId: string, names: KeyName[]): Promise<boolean>`;
    - `capture(paneId: string, o?: { lines: number; attributes?: boolean; join?: boolean }): Promise<string | null>`, as the Contracts have it (ruling 56). `attributes` (tmux `-e`) defaults to false, `join` (tmux `-J`) to true (ruling 10). `o` itself is optional, so the hub's `capture(id)` is unchanged;
    - `pasteLiteral(paneId: string, text: string): Promise<void>`: it rejects when tmux fails, and drops every control character, a newline too.
  - the fixtures under `test/fixtures/claude-code/2.1.293/`.

- [ ] **Step 1: Record Claude Code's transcript shapes**

The shapes below were read on the PC with commands like these (read-only; every free text masked before it left the PC). Each prints keys and kinds, never content:

```bash
ssh devbox 'cd ~/.claude/projects && find . -name "*.jsonl" -mtime -2 -print0 | xargs -0 cat 2>/dev/null | jq -c "select(.type==\"queue-operation\") | {operation, reason, hasContent: (.content|type), keys: (keys|sort)}" | sort | uniq -c | sort -rn'
ssh devbox 'cd ~/.claude/projects && find . -name "*.jsonl" -mtime -2 -print0 | xargs -0 grep -h "\"promptSource\"" | jq -c "{ps: .promptSource, ok: (.origin.kind), ct: (.message.content|type)}" | sort | uniq -c'
ssh devbox 'cd ~/.claude/projects && find . -name "*.jsonl" -mtime -2 -print0 | xargs -0 grep -h "<command-name>" | jq -c "select(.type==\"user\") | {ps: .promptSource, meta: .isMeta, skel: ((.message.content|tostring) | gsub(\"<command-args>[^<]*</command-args>\"; \"<command-args>ARGS</command-args>\")), keys: (keys|sort|join(\",\"))}" | sort | uniq -c'
ssh devbox 'cd ~/.claude/projects && f=$(grep -l "<command-name>/clear</command-name>" $(find . -name "*.jsonl" -mtime -2) | head -1); head -8 "$f" | jq -c "{type, at: .attachment.type, meta: .isMeta, keys: (keys|join(\",\"))}"'
```

Create each file under `test/fixtures/claude-code/2.1.293/` with exactly the content shown. Each line is one JSONL entry. The keys and their order are as recorded, the texts synthetic, the times 2026-10-08T12:mm:ss.

`typed-prompt.jsonl`, a prompt typed at the box:

```jsonl
{"parentUuid":"0f1c0001-2d3e-4f5a-8b6c-000000000001","isSidechain":false,"promptId":"0f1c0002-2d3e-4f5a-8b6c-000000000002","type":"user","message":{"role":"user","content":"[fixture] a line typed at the box"},"uuid":"0f1c0003-2d3e-4f5a-8b6c-000000000003","timestamp":"2026-10-08T12:00:01.000Z","permissionMode":"default","origin":{"kind":"human"},"promptSource":"typed","turnOrigin":"human","turnPosition":{"promptIndex":1,"turnIndex":1},"userType":"external","entrypoint":"cli","cwd":"/work/demo","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","version":"2.1.293","gitBranch":"main","slug":"fixture-slug"}
```

`queued-then-prompt.jsonl`, typed while busy and taken as the next prompt: `enqueue`, a `dequeue` without text, then the prompt:

```jsonl
{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-08T12:01:00.000Z","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","content":"[fixture] typed while busy, taken as the next prompt"}
{"type":"queue-operation","operation":"dequeue","timestamp":"2026-10-08T12:01:30.000Z","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b"}
{"parentUuid":"0f1c0004-2d3e-4f5a-8b6c-000000000004","isSidechain":false,"promptId":"0f1c0005-2d3e-4f5a-8b6c-000000000005","type":"user","message":{"role":"user","content":"[fixture] typed while busy, taken as the next prompt"},"uuid":"0f1c0006-2d3e-4f5a-8b6c-000000000006","timestamp":"2026-10-08T12:01:30.050Z","permissionMode":"default","origin":{"kind":"human"},"promptSource":"queued","turnOrigin":"human","turnPosition":{"promptIndex":2,"turnIndex":2},"userType":"external","entrypoint":"cli","cwd":"/work/demo","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","version":"2.1.293","gitBranch":"main","slug":"fixture-slug"}
```

`absorbed-mid-turn.jsonl`, taken into the running turn. The attachment's timestamp is the time the line was sent, 1 ms before the `enqueue`'s, as recorded:

```jsonl
{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-08T12:02:00.001Z","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","content":"[fixture] typed while busy, taken into the running turn"}
{"type":"queue-operation","operation":"remove","timestamp":"2026-10-08T12:02:05.000Z","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","content":"[fixture] typed while busy, taken into the running turn","reason":"absorbed_mid_turn","commandUuid":"0f1c0007-2d3e-4f5a-8b6c-000000000007","deliveryId":"0f1c0008-2d3e-4f5a-8b6c-000000000008"}
{"parentUuid":"0f1c000b-2d3e-4f5a-8b6c-00000000000b","isSidechain":false,"attachment":{"type":"queued_command","prompt":"[fixture] typed while busy, taken into the running turn","source_uuid":"0f1c0009-2d3e-4f5a-8b6c-000000000009","delivery_id":"0f1c000a-2d3e-4f5a-8b6c-00000000000a","commandMode":"prompt","origin":{"kind":"human"},"timestamp":"2026-10-08T12:02:00.000Z","humanTurn":true},"type":"attachment","uuid":"0f1c000c-2d3e-4f5a-8b6c-00000000000c","timestamp":"2026-10-08T12:02:00.000Z","rendered":[{"content":"[fixture] typed while busy, taken into the running turn"}],"renderedRole":"user","session_id":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","userType":"external","entrypoint":"cli","cwd":"/work/demo","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","version":"2.1.293","gitBranch":"main","slug":"fixture-slug"}
```

`delivered-to-agent.jsonl` (this reason's `remove` has no `commandUuid` or `deliveryId`, as recorded):

```jsonl
{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-08T12:03:00.000Z","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","content":"[fixture] handed to the agent"}
{"type":"queue-operation","operation":"remove","timestamp":"2026-10-08T12:03:02.000Z","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","content":"[fixture] handed to the agent","reason":"delivered_to_agent"}
```

`cleared-on-cancel.jsonl`, in the inbox's recorded shape:

```jsonl
{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-08T12:04:00.000Z","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","content":"[fixture] dropped by an interrupt"}
{"type":"queue-operation","operation":"remove","timestamp":"2026-10-08T12:04:03.000Z","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","content":"[fixture] dropped by an interrupt","reason":"cleared_on_cancel"}
```

`unknown-remove-reason.jsonl`, a reason no Claude Code wrote, standing for one a later version may:

```jsonl
{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-08T12:05:00.000Z","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","content":"[fixture] removed for a reason not known here"}
{"type":"queue-operation","operation":"remove","timestamp":"2026-10-08T12:05:01.000Z","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","content":"[fixture] removed for a reason not known here","reason":"moved_elsewhere","commandUuid":"0f1c000d-2d3e-4f5a-8b6c-00000000000d","deliveryId":"0f1c000e-2d3e-4f5a-8b6c-00000000000e"}
```

`pasted-wrapper.jsonl`: a typed paste comes back as `\n\n<pasted_content id="…">\n…\n</pasted_content id="…">\n`, a queued one without the leading newlines:

```jsonl
{"parentUuid":"0f1c000f-2d3e-4f5a-8b6c-00000000000f","isSidechain":false,"promptId":"0f1c0010-2d3e-4f5a-8b6c-000000000010","type":"user","message":{"role":"user","content":"\n\n<pasted_content id=\"a3f9\">\n[fixture] pasted line one\n[fixture] pasted line two\n[fixture] pasted line three\n</pasted_content id=\"a3f9\">\n"},"uuid":"0f1c0011-2d3e-4f5a-8b6c-000000000011","timestamp":"2026-10-08T12:06:00.000Z","permissionMode":"default","origin":{"kind":"human"},"promptSource":"typed","turnOrigin":"human","turnPosition":{"promptIndex":3,"turnIndex":3},"userType":"external","entrypoint":"cli","cwd":"/work/demo","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","version":"2.1.293","gitBranch":"main","slug":"fixture-slug"}
{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-08T12:06:30.000Z","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","content":"<pasted_content id=\"b7e2\">\n[fixture] pasted line one\n[fixture] pasted line two\n[fixture] pasted line three\n</pasted_content id=\"b7e2\">"}
{"type":"queue-operation","operation":"remove","timestamp":"2026-10-08T12:06:35.000Z","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","content":"<pasted_content id=\"b7e2\">\n[fixture] pasted line one\n[fixture] pasted line two\n[fixture] pasted line three\n</pasted_content id=\"b7e2\">","reason":"absorbed_mid_turn","commandUuid":"0f1c0012-2d3e-4f5a-8b6c-000000000012","deliveryId":"0f1c0013-2d3e-4f5a-8b6c-000000000013"}
{"parentUuid":"0f1c0016-2d3e-4f5a-8b6c-000000000016","isSidechain":false,"attachment":{"type":"queued_command","prompt":"<pasted_content id=\"b7e2\">\n[fixture] pasted line one\n[fixture] pasted line two\n[fixture] pasted line three\n</pasted_content id=\"b7e2\">","source_uuid":"0f1c0014-2d3e-4f5a-8b6c-000000000014","delivery_id":"0f1c0015-2d3e-4f5a-8b6c-000000000015","commandMode":"prompt","origin":{"kind":"human"},"timestamp":"2026-10-08T12:06:30.000Z","humanTurn":true},"type":"attachment","uuid":"0f1c0017-2d3e-4f5a-8b6c-000000000017","timestamp":"2026-10-08T12:06:30.000Z","rendered":[{"content":"<pasted_content id=\"b7e2\">\n[fixture] pasted line one\n[fixture] pasted line two\n[fixture] pasted line three\n</pasted_content id=\"b7e2\">"}],"renderedRole":"user","session_id":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","userType":"external","entrypoint":"cli","cwd":"/work/demo","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","version":"2.1.293","gitBranch":"main","slug":"fixture-slug"}
```

`pasted-short-form.jsonl`, the input box's short form, as the inbox recorded it on 2.1.288:

```jsonl
{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-08T12:07:00.000Z","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","content":"[Pasted text #3 +2 lines]"}
```

`slash-command.jsonl`, `/compact` (Review Focus 1). `compactMetadata` keeps 4 of its recorded keys:

```jsonl
{"parentUuid":null,"logicalParentUuid":"0f1c0018-2d3e-4f5a-8b6c-000000000018","isSidechain":false,"type":"system","subtype":"compact_boundary","content":"Conversation compacted","timestamp":"2026-10-08T12:08:40.000Z","uuid":"0f1c0019-2d3e-4f5a-8b6c-000000000019","level":"info","compactMetadata":{"trigger":"manual","preTokens":120000,"postTokens":9000,"durationMs":41000},"userType":"external","entrypoint":"cli","cwd":"/work/demo","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","version":"2.1.293","gitBranch":"main","slug":"fixture-slug"}
{"parentUuid":"0f1c001a-2d3e-4f5a-8b6c-00000000001a","isSidechain":false,"promptId":"0f1c001b-2d3e-4f5a-8b6c-00000000001b","type":"user","message":{"role":"user","content":"This session is being continued from a previous conversation.\n\nAll user messages:\n/compact\n[fixture] a line typed at the box"},"isCompactSummary":true,"isVisibleInTranscriptOnly":true,"uuid":"0f1c001c-2d3e-4f5a-8b6c-00000000001c","timestamp":"2026-10-08T12:08:40.010Z","session_id":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","userType":"external","entrypoint":"cli","cwd":"/work/demo","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","version":"2.1.293","gitBranch":"main","slug":"fixture-slug"}
{"parentUuid":"0f1c001d-2d3e-4f5a-8b6c-00000000001d","isSidechain":false,"promptId":"0f1c001e-2d3e-4f5a-8b6c-00000000001e","type":"user","message":{"role":"user","content":"<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>"},"isMeta":true,"uuid":"0f1c001f-2d3e-4f5a-8b6c-00000000001f","timestamp":"2026-10-08T12:08:40.020Z","session_id":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","userType":"external","entrypoint":"cli","cwd":"/work/demo","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","version":"2.1.293","gitBranch":"main","slug":"fixture-slug"}
{"parentUuid":"0f1c0020-2d3e-4f5a-8b6c-000000000020","isSidechain":false,"promptId":"0f1c0021-2d3e-4f5a-8b6c-000000000021","type":"user","message":{"role":"user","content":"<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>"},"uuid":"0f1c0022-2d3e-4f5a-8b6c-000000000022","timestamp":"2026-10-08T12:08:40.030Z","session_id":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","userType":"external","entrypoint":"cli","cwd":"/work/demo","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","version":"2.1.293","gitBranch":"main","slug":"fixture-slug"}
{"parentUuid":"0f1c0023-2d3e-4f5a-8b6c-000000000023","isSidechain":false,"promptId":"0f1c0024-2d3e-4f5a-8b6c-000000000024","type":"user","message":{"role":"user","content":"<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m</local-command-stdout>"},"uuid":"0f1c0025-2d3e-4f5a-8b6c-000000000025","timestamp":"2026-10-08T12:08:40.040Z","session_id":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","userType":"external","entrypoint":"cli","cwd":"/work/demo","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","version":"2.1.293","gitBranch":"main","slug":"fixture-slug"}
```

`clear-new-session.jsonl`, the first 7 lines of the session a `/clear` started. Its kinds are as recorded: `mode`, a file history snapshot, three hook attachments, a meta caveat, then the command. The inner objects are cut to their types:

```jsonl
{"type":"mode","mode":"normal","sessionId":"6a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"}
{"type":"file-history-snapshot","messageId":"0f1d0001-2d3e-4f5a-8b6c-000000000001","snapshot":{},"isSnapshotUpdate":false}
{"parentUuid":null,"cwd":"/work/demo","entrypoint":"cli","gitBranch":"main","isSidechain":false,"sessionId":"6a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d","userType":"external","version":"2.1.293","type":"attachment","attachment":{"type":"hook_success"},"uuid":"0f1d0002-2d3e-4f5a-8b6c-000000000002","timestamp":"2026-10-08T12:10:01.000Z"}
{"parentUuid":"0f1d0002-2d3e-4f5a-8b6c-000000000002","cwd":"/work/demo","entrypoint":"cli","gitBranch":"main","isSidechain":false,"sessionId":"6a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d","userType":"external","version":"2.1.293","type":"attachment","attachment":{"type":"hook_success"},"uuid":"0f1d0003-2d3e-4f5a-8b6c-000000000003","timestamp":"2026-10-08T12:10:01.010Z"}
{"parentUuid":"0f1d0003-2d3e-4f5a-8b6c-000000000003","cwd":"/work/demo","entrypoint":"cli","gitBranch":"main","isSidechain":false,"sessionId":"6a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d","userType":"external","version":"2.1.293","type":"attachment","attachment":{"type":"hook_additional_context"},"rendered":[{"content":"[fixture] hook context"}],"renderedRole":"user","uuid":"0f1d0004-2d3e-4f5a-8b6c-000000000004","timestamp":"2026-10-08T12:10:01.020Z"}
{"parentUuid":"0f1d0004-2d3e-4f5a-8b6c-000000000004","cwd":"/work/demo","entrypoint":"cli","gitBranch":"main","isSidechain":false,"sessionId":"6a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d","userType":"external","version":"2.1.293","type":"user","message":{"role":"user","content":"<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>"},"isMeta":true,"uuid":"0f1d0005-2d3e-4f5a-8b6c-000000000005","timestamp":"2026-10-08T12:10:01.030Z"}
{"parentUuid":"0f1d0005-2d3e-4f5a-8b6c-000000000005","cwd":"/work/demo","entrypoint":"cli","gitBranch":"main","isSidechain":false,"sessionId":"6a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d","userType":"external","version":"2.1.293","type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>"},"uuid":"0f1d0006-2d3e-4f5a-8b6c-000000000006","timestamp":"2026-10-08T12:10:01.040Z"}
```

`not-prompts.jsonl`: a subagent's entry, a tool result, a meta entry and a compaction's summary that quotes a text:

```jsonl
{"parentUuid":"0f1c0026-2d3e-4f5a-8b6c-000000000026","isSidechain":true,"promptId":"0f1c0027-2d3e-4f5a-8b6c-000000000027","agentId":"a0f1e2d3c4b5a6978","type":"user","message":{"role":"user","content":"[fixture] seen by a subagent only"},"uuid":"0f1c0028-2d3e-4f5a-8b6c-000000000028","timestamp":"2026-10-08T12:09:00.000Z","userType":"external","entrypoint":"cli","cwd":"/work/demo","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","version":"2.1.293","gitBranch":"main","slug":"fixture-slug"}
{"parentUuid":"0f1c0029-2d3e-4f5a-8b6c-000000000029","isSidechain":false,"promptId":"0f1c002a-2d3e-4f5a-8b6c-00000000002a","type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_fixture","type":"tool_result","content":"[fixture] seen in a tool result only","is_error":false}]},"uuid":"0f1c002b-2d3e-4f5a-8b6c-00000000002b","timestamp":"2026-10-08T12:09:01.000Z","session_id":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","userType":"external","entrypoint":"cli","cwd":"/work/demo","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","version":"2.1.293","gitBranch":"main","slug":"fixture-slug"}
{"parentUuid":"0f1c002c-2d3e-4f5a-8b6c-00000000002c","isSidechain":false,"promptId":"0f1c002d-2d3e-4f5a-8b6c-00000000002d","type":"user","message":{"role":"user","content":"[fixture] seen in a meta entry only"},"isMeta":true,"uuid":"0f1c002e-2d3e-4f5a-8b6c-00000000002e","timestamp":"2026-10-08T12:09:02.000Z","session_id":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","userType":"external","entrypoint":"cli","cwd":"/work/demo","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","version":"2.1.293","gitBranch":"main","slug":"fixture-slug"}
{"parentUuid":"0f1c002f-2d3e-4f5a-8b6c-00000000002f","isSidechain":false,"promptId":"0f1c0030-2d3e-4f5a-8b6c-000000000030","type":"user","message":{"role":"user","content":"Summary of the conversation so far.\n[fixture] quoted by a compaction summary\nThe end."},"isCompactSummary":true,"isVisibleInTranscriptOnly":true,"uuid":"0f1c0031-2d3e-4f5a-8b6c-000000000031","timestamp":"2026-10-08T12:09:03.000Z","session_id":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","userType":"external","entrypoint":"cli","cwd":"/work/demo","sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","version":"2.1.293","gitBranch":"main","slug":"fixture-slug"}
```

`session-file.json`, a session file in 2.1.293's recorded keys. `pidDomain` is a synthetic machine ID; `peerFeatures` are Claude Code's own feature names:

```json
{"pid":4242,"sessionId":"5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b","cwd":"/work/demo","startedAt":1791460800000,"procStart":"123456789","version":"2.1.293","peerProtocol":1,"peerFeatures":["notify_idle","reply_across_default_dirs","artifact_yield"],"kind":"interactive","entrypoint":"cli","pidDomain":"linux:00000000000000000000000000000000:pid:[4026531836]","tmux":"main:@3.%7","messagingSocketPath":"/run/user/1000/cc-socks/4242.sock","name":"fixture-lane","nameSource":"derived","nameSince":1791460800000,"updatedAt":1791460860000,"status":"idle","statusUpdatedAt":1791460860000}
```

- [ ] **Step 2: Write the failing receipt test**

Create `packages/node-ops/test/receipt.test.ts`:

```ts
// The transcript receipt (src/receipt.ts; docs/design/fleet-clients/README.md §4.3, §1; plan.md Review Focus 1): the manager
// inbox's receipt rules and their tests ("transcript receipts", finding 1),
// ported, and every entry kind Claude Code 2.1.293 writes, each from a recorded transcript in
// test/fixtures/claude-code/2.1.293: synthetic texts in the shapes and with the keys seen on the owner's PC on 2026-10-08.
// Not ported: the inbox's visible id ("⟨m:…⟩"), which Morndo never types.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newSessionReceipt, promptMatches, readReceipts, startsNewSession, type PendingText } from "../src/receipt.ts";

const FIXTURES = join(import.meta.dirname, "../../../test/fixtures/claude-code/2.1.293");
const lines = (name: string) => readFileSync(join(FIXTURES, name), "utf8").split("\n").filter(Boolean);
const at = (hms: string) => Date.parse(`2026-10-08T${hms}Z`);
const T0 = at("11:59:00.000");                                     // every fixture's text was typed after this
const pending = (id: string, text: string, typedAt = T0): PendingText => ({ id, text, typedAt });
const verdicts = (rows: string[], p: PendingText[]) => readReceipts(rows, p).map(r => `${r.id}:${r.verdict}`);

describe("the inbox's rules, ported", () => {
  const row = (o: object) => JSON.stringify({ timestamp: "2026-10-08T12:00:00.000Z", ...o });
  const of = (o: object, text = "q") => verdicts([row(o)], [pending("d1", text)]);
  it("the row kinds Claude Code writes for a prompt", () => {
    expect(of({ type: "user", message: { content: "hi" } }, "hi")).toEqual(["d1:delivered"]);
    expect(of({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } }, "x")).toEqual([]);
    expect(of({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }, { type: "text", text: "x" }] } }, "x")).toEqual([]);
    expect(of({ type: "user", message: { content: [{ type: "text", text: "a" }, { type: "image" }] } }, "a")).toEqual(["d1:delivered"]);
    expect(of({ type: "queue-operation", operation: "enqueue", content: "q" })).toEqual(["d1:held"]);
    expect(of({ type: "queue-operation", operation: "remove", content: "q", reason: "absorbed_mid_turn" })).toEqual(["d1:delivered"]);
    expect(of({ type: "queue-operation", operation: "dequeue" })).toEqual([]);
    expect(of({ type: "attachment", attachment: { type: "queued_command", prompt: "q" } })).toEqual(["d1:delivered"]);
    expect(of({ type: "user", isSidechain: true, message: { content: "q" } })).toEqual([]);
  });
  it("an interrupt that clears Claude Code's queue (remove, cleared_on_cancel) is not a delivery (review fix 1)", () => {
    expect(of({ type: "queue-operation", operation: "remove", content: "x", reason: "cleared_on_cancel" }, "x")).toEqual(["d1:dropped"]);
    expect(of({ type: "queue-operation", operation: "remove", content: "x", reason: "absorbed_mid_turn" }, "x")).toEqual(["d1:delivered"]);
  });
  it("a remove without a reason gives no verdict (the inbox took it as a delivery; 2.1.293 always writes a reason)", () => {
    expect(of({ type: "queue-operation", operation: "remove", content: "q" })).toEqual([]);
  });
  it("matching: exact, a pasted_content wrapper, the [Pasted text] form, inside a merged prompt", () => {
    const typed = "[lane-event] Lane events:\n{\"ts\":1}\n{\"ts\":2}";
    expect(promptMatches(typed, `${typed}  \r\n`)).toBe(true);
    const tap = "[tap ny-176] deploy-morndo (Go live after the review)";
    expect(promptMatches(tap, `\n\n<pasted_content id="0512">\n${tap}\n</pasted_content id="0512">\n`)).toBe(true);
    expect(promptMatches("ship it", `\n\n<pasted_content id="c1d2">\nship it\n</pasted_content id="c1d2">\n`)).toBe(true);   // too short to be found inside: the wrapper itself
    expect(promptMatches(tap, `Make sure to queue\n\n${tap}`)).toBe(true);
    expect(promptMatches(tap, `${tap} and more`)).toBe(false);                     // not a whole line
    expect(promptMatches("a\nb\nc", "[Pasted text #3 +2 lines]")).toBe(true);
    expect(promptMatches("a\nb\nc", "[Pasted text #3 +9 lines]")).toBe(false);
    expect(promptMatches("x  \n y \n", "x\n y")).toBe(true);                       // line ends and both ends trimmed
  });
  it("a short text is never found inside another prompt, only as a whole one (negative control)", () => {
    expect(promptMatches("ok", "fine\nok")).toBe(false);
    expect(promptMatches("ok", "ok")).toBe(true);
  });
  it("matches the text as the paste typed it: control characters but newline and tab dropped", () => {
    expect(promptMatches("a\x1b[201~b", "a[201~b")).toBe(true);
    expect(promptMatches("one\r\ntwo", "one\ntwo")).toBe(true);
  });
});

describe("each kind 2.1.293 writes, from a recorded transcript", () => {
  it("a prompt typed at the box: delivered", () => {
    expect(readReceipts(lines("typed-prompt.jsonl"), [pending("d1", "[fixture] a line typed at the box")]))
      .toEqual([{ id: "d1", verdict: "delivered", at: at("12:00:01.000") }]);
  });
  it("typed while busy and taken as the next prompt: held, then delivered by the prompt after the dequeue", () => {
    const p = [pending("d1", "[fixture] typed while busy, taken as the next prompt")];
    const rows = lines("queued-then-prompt.jsonl");
    expect(readReceipts(rows, p)).toEqual([{ id: "d1", verdict: "held", at: at("12:01:00.000") }, { id: "d1", verdict: "delivered", at: at("12:01:30.050") }]);
  });
  it("a dequeue gives no verdict, without a text as recorded or with one (negative control)", () => {
    const p = [pending("d1", "[fixture] typed while busy, taken as the next prompt")];
    const dequeue = lines("queued-then-prompt.jsonl")[1] ?? "";
    expect(readReceipts([dequeue], p)).toEqual([]);
    const withText = JSON.stringify({ ...(JSON.parse(dequeue) as object), content: "[fixture] typed while busy, taken as the next prompt" });
    expect(readReceipts([withText], p)).toEqual([]);
  });
  it("taken into the running turn (remove absorbed_mid_turn): delivered; the queued_command alone delivers too", () => {
    const p = [pending("d1", "[fixture] typed while busy, taken into the running turn")];
    const rows = lines("absorbed-mid-turn.jsonl");
    expect(verdicts(rows, p)).toEqual(["d1:held", "d1:delivered"]);
    expect(readReceipts(rows, p)[1]?.at).toBe(at("12:02:05.000"));
    expect(readReceipts([rows[2] ?? ""], p)).toEqual([{ id: "d1", verdict: "delivered", at: at("12:02:00.000") }]);
  });
  it("remove delivered_to_agent: delivered", () => {
    expect(verdicts(lines("delivered-to-agent.jsonl"), [pending("d1", "[fixture] handed to the agent")])).toEqual(["d1:held", "d1:delivered"]);
  });
  it("remove cleared_on_cancel: dropped, never delivered (negative control)", () => {
    expect(verdicts(lines("cleared-on-cancel.jsonl"), [pending("d1", "[fixture] dropped by an interrupt")])).toEqual(["d1:held", "d1:dropped"]);
  });
  it("a remove reason not known here: no verdict, the delivery stays held", () => {
    expect(verdicts(lines("unknown-remove-reason.jsonl"), [pending("d1", "[fixture] removed for a reason not known here")])).toEqual(["d1:held"]);
  });
  it("a pasted text comes back wrapped: typed at the box, and held then taken into the turn", () => {
    const text = "[fixture] pasted line one\n[fixture] pasted line two\n[fixture] pasted line three";
    const p = [pending("d1", text), pending("d2", text, at("12:06:10.000"))];
    expect(readReceipts(lines("pasted-wrapper.jsonl"), p)).toEqual([
      { id: "d1", verdict: "delivered", at: at("12:06:00.000") },
      { id: "d2", verdict: "held", at: at("12:06:30.000") },
      { id: "d2", verdict: "delivered", at: at("12:06:35.000") },
    ]);
  });
  it("the input box's short form of a long paste: held", () => {
    expect(verdicts(lines("pasted-short-form.jsonl"), [pending("d1", "[fixture] one\n[fixture] two\n[fixture] three")])).toEqual(["d1:held"]);
  });
  it("a subagent's entry, a tool result, a meta entry and a compaction's summary are not prompts (negative controls)", () => {
    const p = ["[fixture] seen by a subagent only", "[fixture] seen in a tool result only", "[fixture] seen in a meta entry only",
      "[fixture] quoted by a compaction summary"].map((t, i) => pending(`d${i}`, t));
    expect(readReceipts(lines("not-prompts.jsonl"), p)).toEqual([]);
  });
});

describe("a slash command (Review Focus 1)", () => {
  it("/compact is confirmed by its command entry, not by the summary that quotes it", () => {
    expect(readReceipts(lines("slash-command.jsonl"), [pending("d1", "/compact", at("12:08:00.000"))]))
      .toEqual([{ id: "d1", verdict: "delivered", at: at("12:08:40.030") }]);
  });
  const entry = (name: string, args: string) =>
    `<command-name>${name}</command-name>\n            <command-message>${name.slice(1)}</command-message>\n            <command-args>${args}</command-args>`;
  it("a command with arguments: the same name and the same arguments", () => {
    expect(promptMatches("/compact keep the parser notes", entry("/compact", "keep the parser notes"))).toBe(true);
    expect(promptMatches("/telegram:access pair", "<command-message>telegram:access</command-message>\n<command-name>/telegram:access</command-name>\n<command-args>pair</command-args>")).toBe(true);
    expect(promptMatches("/goal fix <x> & ship", entry("/goal", "fix &lt;x&gt; &amp; ship"))).toBe(true);
  });
  it("another command, other arguments, or a text that isn't a command: no match (negative controls)", () => {
    expect(promptMatches("/compact", entry("/clear", ""))).toBe(false);
    expect(promptMatches("/compact keep notes", entry("/compact", "drop notes"))).toBe(false);
    expect(promptMatches("/compact", entry("/compact", "keep notes"))).toBe(false);
    expect(promptMatches("compact", entry("/compact", ""))).toBe(false);
    expect(promptMatches("/compact", "/compact")).toBe(true);                          // taken as a prompt instead: matches as text
  });
});

describe("which pending text an entry decides", () => {
  const typedRow = (text: string, hms: string) => JSON.stringify({ type: "user", message: { content: text }, timestamp: `2026-10-08T${hms}Z` });
  it("two deliveries of one text need two receipts; the earliest typed goes first", () => {
    const p = [pending("d2", "same", at("12:00:02.000")), pending("d1", "same", at("12:00:01.000"))];
    expect(verdicts([typedRow("same", "12:00:03.000")], p)).toEqual(["d1:delivered"]);
    expect(verdicts([typedRow("same", "12:00:03.000"), typedRow("same", "12:00:04.000")], p)).toEqual(["d1:delivered", "d2:delivered"]);
  });
  it("an entry from before a text was typed decides nothing (negative control)", () => {
    expect(verdicts([typedRow("same", "12:00:00.000")], [pending("d1", "same", at("12:00:01.000"))])).toEqual([]);
  });
  it("an enqueue holds a text once; the next enqueue of the same text holds the next pending one", () => {
    const enq = (hms: string) => JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "same", timestamp: `2026-10-08T${hms}Z` });
    const p = [pending("d1", "same", at("12:00:01.000")), pending("d2", "same", at("12:00:02.000"))];
    expect(verdicts([enq("12:00:03.000"), enq("12:00:04.000"), typedRow("same", "12:00:05.000")], p)).toEqual(["d1:held", "d2:held", "d1:delivered"]);
  });
  it("a line that isn't JSON, a kind it doesn't know and an entry without a time give no verdict", () => {
    expect(verdicts(["{\"type\":\"user\",\"mess", "not json", JSON.stringify({ type: "summary", summary: "same", timestamp: "2026-10-08T12:00:03.000Z" }),
      JSON.stringify({ type: "user", message: { content: "same" } })], [pending("d1", "same")])).toEqual([]);
  });
});

describe("a command that starts a new session (/clear, /reset, /new)", () => {
  it("is known from its text, with or without its argument", () => {
    for (const t of ["/clear", "/clear release-prep", "/reset", "/new", "/new  "]) expect(startsNewSession(t), t).toBe(true);
    for (const t of ["/compact", "/clearer", "/newt", " /clear", "clear", "/clear\nand more", "please /clear"]) expect(startsNewSession(t), JSON.stringify(t)).toBe(false);
  });
  it("is recorded only in the new session's transcript: the session it was typed into has no verdict", () => {
    const newSession = lines("clear-new-session.jsonl");
    expect(newSession.findIndex(l => l.includes("<command-name>/clear</command-name>"))).toBe(6);              // its 7th line
    expect(readReceipts(newSession, [pending("d1", "/clear")])).toEqual([{ id: "d1", verdict: "delivered", at: at("12:10:01.040") }]);
    expect(readReceipts(lines("typed-prompt.jsonl"), [pending("d1", "/clear")])).toEqual([]);
  });
  it("its receipt is the pane's session changing to another id after the typing (negative control)", () => {
    expect(newSessionReceipt("/clear", "s-old", "s-new")).toBe(true);
    expect(newSessionReceipt("/new", "s-old", "s-old")).toBe(false);
    expect(newSessionReceipt("/clear", "s-old", null)).toBe(false);
    expect(newSessionReceipt("/compact", "s-old", "s-new")).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run packages/node-ops/test/receipt.test.ts`
Expected: FAIL with `Error: Cannot find module '../src/receipt.ts'`, and no tests run.

- [ ] **Step 4: Write `packages/node-ops/src/receipt.ts`, and export it**

```ts
// "Has Claude Code taken this text?", read from the transcript of the session it was typed into (docs/design/fleet-clients/
// README.md §4.3, §1). The rules are the manager inbox's (checked on 2.1.288), ported
// with their tests, and extended to what Claude Code 2.1.293 writes. The transcript is Claude Code's own and undocumented
// ("The entry format is internal to Claude Code and changes between versions", https://code.claude.com/docs/en/sessions,
// read 2026-10-08); every shape read here is pinned by a recorded example in test/fixtures/claude-code/2.1.293 (synthetic
// texts, the recorded keys), so a change in Claude Code shows as a failing test.
// What each entry says of a text typed before it:
// - {"type":"user","message":{"content":…},"promptSource":…}: a prompt the session took, whatever its source: delivered.
//   Not a prompt: a subagent's entry (isSidechain), a tool result, a meta entry (isMeta: a reminder, a command's caveat)
//   and a compaction's summary (isCompactSummary, which quotes earlier prompts).
// - A slash command ("/compact", Review Focus 1) comes back as its command, not as the text:
//   "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>".
// - {"type":"queue-operation","operation":"enqueue","content":…}: typed while it was busy; Claude Code holds it: held.
// - "dequeue" carries no text: no verdict. The prompt written after it decides.
// - "remove" with reason "absorbed_mid_turn" or "delivered_to_agent": taken into the turn: delivered. "cleared_on_cancel":
//   an interrupt dropped it: dropped. Any other reason, or none: no verdict. (The inbox counted a remove without a reason
//   as delivered; 2.1.293 wrote a reason on every one of 2,736 in two days, and the attachment that follows a real
//   delivery still confirms it, so no verdict is the safe side.)
// - {"type":"attachment","attachment":{"type":"queued_command","prompt":…}}: handed to the model: delivered.
// Anything else, a line that isn't JSON, and an entry without a time give no verdict.
// A command that starts a new session (/clear and its aliases) is written only into the new session's transcript, so its
// receipt is the pane's session changing (newSessionReceipt, below), never an entry of the session it was typed into.

export type ReceiptVerdict = "delivered" | "held" | "dropped" | "none";
export type PendingText = { id: string; text: string; typedAt: number };

type Said = { verdict: Exclude<ReceiptVerdict, "none">; text: string; at: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const DELIVERED_REASONS = new Set(["absorbed_mid_turn", "delivered_to_agent"]);

// One JSONL line: what it says of a text, or null.
function said(line: string): Said | null {
  let o: unknown;
  try { o = JSON.parse(line); } catch { return null; }                // a half-written line, or not JSON
  if (!isRecord(o) || o.isSidechain === true) return null;
  const at = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : Number.NaN;
  if (!Number.isFinite(at)) return null;                              // without a time, "after it was typed" can't be told
  if (o.type === "user") {
    if (o.isMeta === true || o.isCompactSummary === true || !isRecord(o.message)) return null;
    const c = o.message.content;
    if (typeof c === "string") return { verdict: "delivered", text: c, at };
    if (!Array.isArray(c) || c.some(b => isRecord(b) && b.type === "tool_result")) return null;
    const text = c.filter((b): b is { type: "text"; text: string } => isRecord(b) && b.type === "text" && typeof b.text === "string").map(b => b.text).join("\n");
    return text ? { verdict: "delivered", text, at } : null;
  }
  if (o.type === "queue-operation" && typeof o.content === "string") {
    if (o.operation === "enqueue") return { verdict: "held", text: o.content, at };
    if (o.operation !== "remove") return null;                        // "dequeue": no verdict, even should it carry a text
    if (typeof o.reason === "string" && DELIVERED_REASONS.has(o.reason)) return { verdict: "delivered", text: o.content, at };
    if (o.reason === "cleared_on_cancel") return { verdict: "dropped", text: o.content, at };
    return null;
  }
  if (o.type === "attachment" && isRecord(o.attachment) && o.attachment.type === "queued_command" && typeof o.attachment.prompt === "string") {
    return { verdict: "delivered", text: o.attachment.prompt, at };
  }
  return null;
}

// Each entry decides at most one pending text: the earliest typed (then the first listed) that it fits, at or after its
// typedAt and not yet decided in this read. An enqueue holds one not yet held in this read, so two typings of one text
// held in turn are two pending texts held. Two deliveries of one text need two receipts.
export function readReceipts(lines: string[], pending: PendingText[]): { id: string; verdict: Exclude<ReceiptVerdict, "none">; at: number }[] {
  const order = pending.map((p, i) => ({ p, i })).sort((a, b) => a.p.typedAt - b.p.typedAt || a.i - b.i).map(x => x.p);
  const held = new Set<string>();
  const decided = new Set<string>();
  const out: { id: string; verdict: Exclude<ReceiptVerdict, "none">; at: number }[] = [];
  for (const line of lines) {
    const e = said(line);
    if (!e) continue;
    const p = order.find(q => !decided.has(q.id) && !(e.verdict === "held" && held.has(q.id)) && e.at >= q.typedAt && promptMatches(q.text, e.text));
    if (!p) continue;
    if (e.verdict === "held") held.add(p.id); else decided.add(p.id);
    out.push({ id: p.id, verdict: e.verdict, at: e.at });
  }
  return out;
}

// ---- matching (the inbox's `matches`, without its visible id: Morndo types no marker into the text)

const PASTE_TAG = /<\/?pasted_content id="[^"]*">/g;
const PLACEHOLDER = /\[Pasted text #\d+ \+(\d+) lines\]/;
// The text as tmux.send pastes it (tmux.ts drops every C0 control but newline and tab, and DEL), so as the transcript can
// have it. A function, not a regular expression with control characters (the lint rule).
function typed(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || (c >= 0x20 && c !== 0x7f)) out += s.charAt(i);
  }
  return out;
}
const normalize = (s: string) => s.replace(/\r\n?/g, "\n").replace(PASTE_TAG, "").split("\n").map(l => l.trimEnd()).join("\n").trim();
// A text Claude Code runs as a slash command: "/", a command name (a plugin's has a ":"), then its arguments.
const SLASH = /^\/([A-Za-z0-9][\w:.-]*)(?:[ \t]+([\s\S]*))?$/;
const tag = (s: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s)?.[1];
// Whether Claude Code escapes markup in the arguments is not known (none seen with any): both forms are taken.
const unescaped = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");

// Is `prompt`, as the transcript has it, the text that was typed?
export function promptMatches(text: string, prompt: string): boolean {
  const want = normalize(typed(text)), got = normalize(prompt);
  if (!got || !want) return false;
  if (got === want) return true;
  // Several queued lines reaching the model as one prompt (the inbox's rule, 2.1.288; 2.1.293 wrote each queued line as
  // its own prompt in two days of transcripts): ours inside it as whole lines, long enough to be ours.
  if (want.length >= 12 && (got.startsWith(`${want}\n`) || got.endsWith(`\n${want}`) || got.includes(`\n${want}\n`))) return true;
  // The input box's short form for a long paste: the rest must agree, and the line count must fit.
  const p = PLACEHOLDER.exec(got);
  if (p && want.includes("\n")) {
    const [before = "", after = ""] = got.split(p[0]);
    const lines = want.split("\n").length, k = Number(p[1]);
    if ((k === lines || k === lines - 1) && want.startsWith(before.trim()) && want.endsWith(after.trim())) return true;
  }
  // A slash command (Review Focus 1): the command entry with its name and the same arguments.
  const slash = SLASH.exec(want);
  const name = tag(got, "command-name");
  if (!slash || name === undefined || name.trim() !== `/${slash[1]}`) return false;
  const args = tag(got, "command-args") ?? "";
  const wantArgs = normalize(slash[2] ?? "");
  return normalize(args) === wantArgs || normalize(unescaped(args)) === wantArgs;
}

// ---- a command that starts a new session (README §4.3)

// `/clear [name]` and its aliases `/reset` and `/new` (https://code.claude.com/docs/en/commands, read 2026-10-08), as one
// line typed at the start of the box. Claude Code records the command only in the new session's transcript (2.1.293: its
// 7th line, test/fixtures/claude-code/2.1.293/clear-new-session.jsonl).
const NEW_SESSION = /^\/(?:clear|reset|new)(?:[ \t][^\n]*)?$/;
export function startsNewSession(text: string): boolean {
  return NEW_SESSION.test(typed(text).replace(/\s+$/, ""));
}
// Its receipt: the pane's session now (null while there is none) is another than the one it was typed into.
export function newSessionReceipt(text: string, typedInto: string, sessionNow: string | null): boolean {
  return startsNewSession(text) && sessionNow !== null && sessionNow !== typedInto;
}
```

In `packages/node-ops/src/index.ts`, after line 12 (`export * from "./transcript-bytes.ts";`), add:

```ts
export * from "./receipt.ts";
```

- [ ] **Step 5: Run it, and check that each rule bites**

Run: `npx vitest run packages/node-ops/test/receipt.test.ts`
Expected: PASS (26 tests).

Then make each change alone in `receipt.ts`, run the same command, see it fail, and restore the line. These are Step 20's entries:
- `cleared_on_cancel` counted as delivered (§12's control): change its `verdict: "dropped"` to `verdict: "delivered"`. Expected: `expected [ 'd1:delivered' ] to deeply equal [ 'd1:dropped' ]`.
- an unknown reason taken as a delivery: change the `return null;` after the `cleared_on_cancel` line to `return { verdict: "delivered", text: o.content, at };`. Expected: failures in "a remove reason not known here" and "a remove without a reason".
- a `dequeue` taken as a receipt (§12's other control, ruling 61): change `if (o.operation !== "remove") return null;` to `if (o.operation !== "remove") return { verdict: "delivered", text: o.content, at };`. Expected: a failure in "a dequeue gives no verdict, without a text as recorded or with one (negative control)". A recorded `dequeue` has no text. The test also feeds one that has a text, standing for a later version that writes one, so the rule is pinned either way.
- meta entries and summaries taken as prompts: change `if (o.isMeta === true || o.isCompactSummary === true || !isRecord(o.message)) return null;` to `if (!isRecord(o.message)) return null;`. Expected: a failure in "… are not prompts".
- a subagent's entry: drop `|| o.isSidechain === true`. Expected: a failure in "the row kinds Claude Code writes".
- a tool result: drop `|| c.some(b => isRecord(b) && b.type === "tool_result")`. Expected: a failure in "the row kinds Claude Code writes".
- an entry from before the typing: drop ` && e.at >= q.typedAt`. Expected: a failure in "an entry from before a text was typed decides nothing".
- one entry, one delivery: drop `!decided.has(q.id) && `. Expected: failures in "need two receipts" and two more.
- the merged rule's minimum: change `want.length >= 12` to `want.length >= 1`. Expected: a failure in "a short text is never found inside another prompt".
- a wrapped echo missed (§12's control): delete `.replace(PASTE_TAG, "")` in `normalize`. Expected: a failure in "matching: exact, a pasted_content wrapper, …". Only the short wrapped text catches it: a longer one still matches as whole lines inside the wrapper.
- the command's name: change the line `if (!slash || name === undefined || name.trim() !== …) return false;` to `if (!slash || name === undefined) return false;`. Expected: a failure in "another command, other arguments, …".
- the text as typed: change `normalize(typed(text))` to `normalize(text)`. Expected: a failure in "… control characters but newline and tab dropped".
- the new-session commands: change `NEW_SESSION` to `/^\/(?:clear|reset|new)/`. Expected: a failure in "is known from its text, with or without its argument" (`"/clearer"`).
- the session change: change `sessionNow !== null && sessionNow !== typedInto` to `sessionNow !== null`. Expected: a failure in "… changing to another id after the typing (negative control)".

- [ ] **Step 6: Commit**

```bash
git add test/fixtures/claude-code/2.1.293 packages/node-ops/src/receipt.ts packages/node-ops/src/index.ts packages/node-ops/test/receipt.test.ts
git commit -m "feat(node-ops): transcript receipts for deliveries, from recorded 2.1.293 transcript shapes"   # a message never names the product (Global Constraints)
```

- [ ] **Step 7: Write the failing menu test**

Create `packages/node-ops/test/menu.test.ts`:

```ts
// The question a menu asks (src/menu.ts; docs/design/fleet-clients/README.md §7, needs_input): kira's parseMenu and its
// pick (kira.ts:636-661, 704, read 2026-10-08), ported. Real screens: the recorded 2.1.287 captures in
// fixtures/claude-code-2.1.287 (with their colours). The multi-question form is synthetic, in the layout kira's parser
// documents (kira.ts:630-638, "verified on Claude Code 2.1.284"): no lane was waiting on a form while this was written.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { menuQuestion } from "../src/menu.ts";

const screen = (name: string) => readFileSync(join(import.meta.dirname, "fixtures/claude-code-2.1.287", `${name}.ansi`), "utf8");
const FORM = [
  "  Shall I go on?",
  "",
  " ←  ☐ Branch  ☐ Tests  ✔ Submit  →",
  "",
  " Pick the branch for the fix",
  "",
  " ❯ 1. main",
  "      The default branch",
  "   2. release/1.2",
  "      The maintenance branch",
  "   3. Type something.",
  "",
  " Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
].join("\n");

describe("menuQuestion (kira's rule)", () => {
  it("a permission prompt: the line ending in ? above the options (recorded, with colours)", () => {
    expect(menuQuestion(screen("permission-prompt"))).toBe("Do you want to proceed?");
  });
  it("a menu without a question mark: the last line above the options (recorded /model menu)", () => {
    expect(menuQuestion(screen("real-menu-model")))
      .toBe("Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.");
  });
  it("no numbered options (the trust dialog, recorded, with hyperlinks): the screen's last line, as kira emits it", () => {
    expect(menuQuestion(screen("trust-dialog"))).toBe("Enter to confirm · Esc to cancel");
  });
  it("a multi-question form: only the lines below its tab strip, never prose above it (negative control)", () => {
    expect(menuQuestion(FORM)).toBe("Pick the branch for the fix");
  });
  it("the last line ending in ? wins over the lines below it (negative control)", () => {
    expect(menuQuestion(" Shall I merge it now?\n It needs one more review.\n ❯ 1. Yes\n   2. No")).toBe("Shall I merge it now?");
  });
  it("only the 10 lines above the first option count", () => {
    const far = [" Is this too far up?", ...Array.from({ length: 10 }, (_, i) => ` line ${i}`), " ❯ 1. Yes", "   2. No"].join("\n");
    expect(menuQuestion(far)).toBe("line 9");
  });
  it("at most 200 characters, never half of one", () => {
    const q = `${"x".repeat(199)}😀 and more?`;
    expect(menuQuestion(` ${q}\n ❯ 1. Yes`)).toBe(`${"x".repeat(199)}😀`);
  });
  it("nothing on screen: null", () => {
    expect(menuQuestion("")).toBeNull();
    expect(menuQuestion("\n\n   \n")).toBeNull();
  });
});
```

Run: `npx vitest run packages/node-ops/test/menu.test.ts`
Expected: FAIL with `Error: Cannot find module '../src/menu.ts'`.

- [ ] **Step 8: Write `packages/node-ops/src/menu.ts`, export it, and let it hold escapes**

```ts
// The question a menu on screen asks, for the lane event `needs_input` (docs/design/fleet-clients/README.md §7): kira's
// rule, ported from the chat bot's menu parser (read 2026-10-08; written against Claude Code 2.1.284's menus, and its
// emit at kira.ts:704 picks the question). Of the screen's last 45 lines:
// - the question lines run from below a multi-question form's tab strip ("←  ☐ Branch  ✔ Submit  →"), else from 10 lines
//   above the first numbered option ("1."), down to that option; box-drawing characters are dropped, blank lines too, and
//   the last 6 are kept;
// - the question is the last of them that ends in "?", else the last of them, at most 200 characters.
// A screen with colours or hyperlinks is read without them (kira reads a plain capture; a node may hand this either).
const SGR = /\x1b\[[0-9;]*m/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const TAB_STRIP = /^\s*←.*→\s*$/;
const OPTION = /^\s*(?:[❯>]\s*)?(\d{1,2})\.\s+(.+?)\s*$/;
const BOX = /[│╭╮╰╯─━┃]/g;

export function menuQuestion(screen: string): string | null {
  // kira reads a capture without its trailing blank lines (paneText, kira.ts:346-347), then its last 45 lines.
  const lines = screen.replace(OSC, "").replace(SGR, "").replace(/\s+$/, "").split("\n").slice(-45).map(l => l.replace(/\s+$/, ""));
  let tabAt = -1;
  lines.forEach((l, i) => { if (TAB_STRIP.test(l)) tabAt = i; });
  // The first option "1." below the tab strip (kira's: the first line of each number counts, the options run from 1).
  let firstOptAt = lines.length;
  for (let i = tabAt + 1; i < lines.length; i++) {
    if (Number(OPTION.exec(lines[i] ?? "")?.[1]) === 1) { firstOptAt = i; break; }
  }
  const question = lines.slice(tabAt >= 0 ? tabAt + 1 : Math.max(0, firstOptAt - 10), firstOptAt)
    .map(l => l.replace(BOX, "").trim()).filter(Boolean).slice(-6);
  const q = [...question].reverse().find(l => /\?\s*$/.test(l)) ?? question.at(-1) ?? "";
  return q ? Array.from(q).slice(0, 200).join("") : null;                     // 200 characters, never half of one
}
```

In `packages/node-ops/src/index.ts`, after `export * from "./receipt.ts";`, add `export * from "./menu.ts";`.

In `.oxlintrc.json`, the first override's `"files"`:

After line 30 (`"packages/node-ops/src/tmux.ts",`), insert:

```json
        "packages/node-ops/src/menu.ts",
```

- [ ] **Step 9: Run it, and check that each rule bites**

Run: `npx vitest run packages/node-ops/test/menu.test.ts`, then `npm run lint`
Expected: PASS (8 tests); no lint problems.

Then make each change alone in `menu.ts` and see it fail:
- the tab strip: change `TAB_STRIP` to `/^$ never/`. Expected: `expected 'Shall I go on?' to be 'Pick the branch for the fix'`.
- the question mark: change the `q` line to `const q = question.at(-1) ?? "";`. Expected: `expected 'It needs one more review.' to be 'Shall I merge it now?'`.
- colours: change `screen.replace(OSC, "").replace(SGR, "")` to `screen.replace(OSC, "")`. Expected: `expected '\u001b[39m Do you want to proceed?' to be 'Do you want to proceed?'`, and two more.
- whole characters: change `Array.from(q).slice(0, 200).join("")` to `q.slice(0, 200)`. Expected: a failure in "at most 200 characters, never half of one".

- [ ] **Step 10: Commit**

```bash
git add packages/node-ops/src/menu.ts packages/node-ops/src/index.ts packages/node-ops/test/menu.test.ts .oxlintrc.json
git commit -m "feat(node-ops): the question a menu on screen asks, ported from kira"
```

- [ ] **Step 11: Write the failing session-status tests**

In `packages/node-ops/test/sessions.test.ts`:

Replace line 3:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
```

with:

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
```

After line 33 (`});`), insert:

```ts
  // fleet clients §5: each pane's session status and pid, from a session file in 2.1.293's recorded shape
  // (test/fixtures/claude-code/2.1.293/session-file.json, synthetic values), its pid made this process so it is live.
  it("reads the session's status and its process from a recorded session file", () => {
    mkdirSync(join(dir, "sessions"));
    const recorded = JSON.parse(readFileSync(join(import.meta.dirname, "../../../test/fixtures/claude-code/2.1.293/session-file.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "sessions", `${process.pid}.json`), JSON.stringify({ ...recorded, pid: process.pid }));
    expect(sessionRegistry(dir).byPane().get("%7")).toEqual({
      sessionId: "5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b", name: "fixture-lane", pane: "%7", cwd: "/work/demo", version: "2.1.293", pid: process.pid, status: "idle",
    });
  });
  it("keeps each status Claude Code writes; one it doesn't know, or none, is null (negative control)", () => {
    mkdirSync(join(dir, "sessions"));
    for (const [status, kept] of [["busy", "busy"], ["idle", "idle"], ["waiting", "waiting"], ["shell", "shell"], ["compacting", null], ["Idle", null], [7, null], [undefined, null]] as const) {
      writeFileSync(join(dir, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s-live", tmux: "qa:@0.%3", cwd: "/tmp/demo", version: "2.1.293", status, updatedAt: 1 }));
      expect(sessionRegistry(dir).byPane().get("%3")?.status, String(status)).toBe(kept);
    }
  });
```

Run: `npx vitest run packages/node-ops/test/sessions.test.ts`
Expected: FAIL, 2 failed and 2 passed: `expected { …(6) } to deeply equal { …(7) }` and `busy: expected undefined to be 'busy'`.

- [ ] **Step 12: Read the status in `packages/node-ops/src/sessions.ts`**

After line 9 (`import { join } from "node:path";`), insert:

```ts
import { SESSION_STATUSES, type SessionStatus } from "@morndo/protocol";
```

Replace line 21:

```ts
export type SessionInfo = { sessionId: string; name: string | null; pane: string; cwd: string; version: string | null; pid: number };
```

with:

```ts
// `pid`: the process the file is named for, Claude Code's own. `status`: the session's state as Claude Code writes it
// (fleet clients §5; seen on 2.1.289 to 2.1.294: busy, idle, waiting, shell, the last while Claude Code runs a shell
// command); null for a value the protocol doesn't know. A file whose process is gone is no session at all (byPane).
export type SessionInfo = { sessionId: string; name: string | null; pane: string; cwd: string; version: string | null; pid: number; status: SessionStatus | null };
const STATUSES = new Set<string>(SESSION_STATUSES);
```

After line 44 (`cwd: text(d.cwd), version: typeof d.version === "string" && VERSION.t…`), insert:

```ts
          status: typeof d.status === "string" && STATUSES.has(d.status) ? d.status as SessionStatus : null,
```

Run: `npx vitest run packages/node-ops/test/sessions.test.ts`
Expected: PASS (4 tests).

Then change the `status:` line to `status: typeof d.status === "string" ? d.status as SessionStatus : null,`. Expected: `compacting: expected 'compacting' to be null`. Restore it.

- [ ] **Step 13: The session status ripple**

Run: `npx tsc -p apps/hub; (cd apps/node-agent && npx tsc -p .); npx tsc -p tsconfig.tests.json`
Expected: errors at `apps/hub/src/adapters/fleet-adapters.ts:305`, `apps/hub/test/escalation-window.test.ts:135`, `apps/hub/test/helpers/fake-fleet.ts:289`, `apps/hub/test/observation-unavailable.test.ts:41`, `apps/hub/test/val-pr18-findings.test.ts:51` and `apps/node-agent/test/relay-server.test.ts:35`: each builds a `SessionInfo` without `status`.

`apps/node-agent/src/ops/inventory.ts`: each pane's status from its session (the agent's lane state events, Task 6, read it):

Replace line 70:

```ts
        status: null, pid: s?.pid ?? null,                       // the session's status: node-ops reads it from Task 2 on
```

with:

```ts
        status: s?.status ?? null, pid: s?.pid ?? null,
```

`apps/hub/src/adapters/fleet-adapters.ts`. The status comes from the fleet's inventory; a fleet from before sends none:

Replace line 305:

```ts
        out.set(p.workerId, { sessionId: p.sessionId, name: p.sessionName ?? null, pane: p.workerId, cwd: p.cwd, version: p.claudeVersion ?? null, pid: 0 });
```

with:

```ts
        out.set(p.workerId, { sessionId: p.sessionId, name: p.sessionName ?? null, pane: p.workerId, cwd: p.cwd, version: p.claudeVersion ?? null, pid: 0, status: p.status ?? null });
```

The hub's and the agent's tests:

Replace line 289:

```ts
          if (p.sessionId !== undefined) out.set(id, { sessionId: p.sessionId, name: null, pane: id, cwd: p.cwd, version: null, pid: 1 });
```

with:

```ts
          if (p.sessionId !== undefined) out.set(id, { sessionId: p.sessionId, name: null, pane: id, cwd: p.cwd, version: null, pid: 1, status: null });
```

Replace line 133:

```ts
    byPane: async () => new Map([["%0", { sessionId: "sess-1", name: null, pane: "%0", cwd: dir, version: "2.1.286", pid: process.pid }]]),
```

with:

```ts
    byPane: async () => new Map([["%0", { sessionId: "sess-1", name: null, pane: "%0", cwd: dir, version: "2.1.286", pid: process.pid, status: null }]]),
```

Replace line 41:

```ts
  const sessions: Sessions = { byPane: async () => new Map([["%1", { sessionId: "s1", name: null, pane: "%1", cwd: "/w", version: null, pid: 1 }]]) };
```

with:

```ts
  const sessions: Sessions = { byPane: async () => new Map([["%1", { sessionId: "s1", name: null, pane: "%1", cwd: "/w", version: null, pid: 1, status: null }]]) };
```

Replace line 320:

```ts
    expect([...(await ports.sessions.byPane())]).toEqual([[PC1, { sessionId: "s-alpha", name: null, pane: PC1, cwd: "/w/alpha", version: null, pid: 0 }]]);
```

with:

```ts
    expect([...(await ports.sessions.byPane())]).toEqual([[PC1, { sessionId: "s-alpha", name: null, pane: PC1, cwd: "/w/alpha", version: null, pid: 0, status: null }]]);
```

Replace line 32:

```ts
  const sessions = new Map([["%7", { sessionId: "sess-web", name: null, pane: "%7", cwd: "/w", version: null, pid: 1 }]]);
```

with:

```ts
  const sessions = new Map([["%7", { sessionId: "sess-web", name: null, pane: "%7", cwd: "/w", version: null, pid: 1, status: null }]]);
```

`apps/hub/test/val-pr18-findings.test.ts`:

Replace line 51:

```ts
    const sessions: Sessions = { byPane: async () => new Map([["%1", { sessionId: "s1", name: "builder", pane: "%1", cwd: "/w", version: null, pid: 1 }]]) };
```

with:

```ts
    const sessions: Sessions = { byPane: async () => new Map([["%1", { sessionId: "s1", name: "builder", pane: "%1", cwd: "/w", version: null, pid: 1, status: null }]]) };
```

Run: `npx tsc -p apps/hub && (cd apps/node-agent && npx tsc -p .) && npx tsc -p tsconfig.tests.json`, then `npx vitest run --project units packages/node-ops apps/hub apps/node-agent`
Expected: no type errors; everything passes but, on macOS, `pane-lock.test.ts`'s 2 and `process-start.test.ts`'s 2.

- [ ] **Step 14: Commit**

```bash
git add packages/node-ops/src/sessions.ts packages/node-ops/test/sessions.test.ts apps/node-agent/src/ops/inventory.ts apps/hub/src/adapters/fleet-adapters.ts apps/hub/test/helpers/fake-fleet.ts apps/hub/test/escalation-window.test.ts apps/hub/test/observation-unavailable.test.ts apps/hub/test/fleet-adapters.test.ts apps/node-agent/test/relay-server.test.ts apps/hub/test/val-pr18-findings.test.ts
git commit -m "feat(node-ops): each session's status from its session file, in the inventory"
```

- [ ] **Step 15: Write the failing tmux test**

Create `packages/node-ops/test/tmux-keys-capture.test.ts`. A pane runs a recorder, `sh` that turns on bracketed paste, puts its terminal in raw mode (`stty raw -echo`) and copies every byte to a file. Its pane ID is read with `list-panes -t =main`: `display-message -p -t =main '#{pane_id}'` printed nothing on a server without a client (tmux 3.6a).

```ts
// The tmux adapter's additions for fleet clients (src/tmux.ts; docs/design/fleet-clients/README.md §5), on an isolated tmux
// server: keys by name, a capture of N lines with attributes, and the launcher's literal paste. A recorder pane (a shell
// that turns on bracketed paste, puts its terminal in raw mode and copies every byte it gets to a file) shows exactly what
// tmux sent. Synthetic text only.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KeyName } from "@morndo/protocol";
import { tmuxAdapter } from "../src/tmux.ts";
import { isolatedTmux, type TestTmux } from "./isolated-tmux.ts";

let t: TestTmux;
let dir: string;
beforeEach(() => { t = isolatedTmux(); dir = mkdtempSync(join(tmpdir(), "morndo-keys-")); });
afterEach(() => { t.kill(); rmSync(dir, { recursive: true, force: true }); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(f: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error(`not within ${ms} ms`); await sleep(20); }
}
// A pane that records the bytes it receives, once its terminal is raw (so Enter stays CR and C-c a byte, not a signal).
async function recorder(): Promise<{ pane: string; got: () => string }> {
  const out = join(dir, "got.bin");
  t.tmux("new-session", "-d", "-s", "main", "-x", "120", "-y", "40",
    `sh -c 'printf "\\033[?2004h"; stty raw -echo; : > ${out}.ready; exec cat > ${out}'`);
  await until(() => existsSync(`${out}.ready`));
  const pane = t.tmux("list-panes", "-t", "=main", "-F", "#{pane_id}").trim();
  return { pane, got: () => (existsSync(out) ? readFileSync(out, "latin1") : "") };
}

describe("sendKeyNames", () => {
  it("presses each named key as tmux names it", async () => {
    const r = await recorder();
    const names: KeyName[] = ["a", "1", "Space", "Tab", "BSpace", "Enter", "C-c", "C-u", "C-d", "Escape", "Up"];
    expect(await tmuxAdapter({ socket: t.socket, session: "main" }).sendKeyNames(r.pane, names)).toBe(true);
    await until(() => r.got().length >= 12);
    expect(r.got()).toMatch(/^a1 \t\x7f\r\x03\x15\x04\x1b\x1b(?:\[A|OA)$/);
  });
  it("refuses a name off the allow-list, no names, a pane that isn't one, and a pane that is gone; nothing is typed (negative controls)", async () => {
    const r = await recorder();
    const keys = tmuxAdapter({ socket: t.socket, session: "main" });
    expect(await keys.sendKeyNames(r.pane, ["kill-server" as KeyName])).toBe(false);
    expect(await keys.sendKeyNames(r.pane, ["Enter", "M-x" as KeyName])).toBe(false);
    expect(await keys.sendKeyNames(r.pane, [])).toBe(false);
    expect(await keys.sendKeyNames("main:0", ["Enter"])).toBe(false);
    expect(await keys.sendKeyNames("%999", ["Enter"])).toBe(false);
    await sleep(200);
    expect(r.got()).toBe("");
    expect(t.tmux("list-sessions", "-F", "#{session_name}").trim()).toBe("main");
  });
});

describe("capture with lines and attributes", () => {
  const PRINT = `sh -c 'i=1; while [ $i -le 300 ]; do echo "line $i"; i=$((i+1)); done; printf "\\033[2mdim tail\\033[0m\\n"; exec sleep 600'`;
  async function printed(): Promise<string> {
    t.tmux("new-session", "-d", "-s", "main", "-x", "120", "-y", "40", PRINT);
    const pane = t.tmux("list-panes", "-t", "=main", "-F", "#{pane_id}").trim();
    await until(() => t.tmux("capture-pane", "-p", "-t", pane).includes("dim tail"));
    return pane;
  }
  it("answers the screen's last N lines, from the history as well, without the pane's empty bottom", async () => {
    const pane = await printed();
    const text = await tmuxAdapter({ socket: t.socket, session: "main" }).capture(pane, { lines: 50 });
    const lines = text?.split("\n") ?? [];
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe("line 252");
    expect(lines.at(-1)).toBe("dim tail");
  });
  it("with attributes, keeps tmux's escapes (kira reads dim text so); without, or by default, none", async () => {
    const pane = await printed();
    const tmux = tmuxAdapter({ socket: t.socket, session: "main" });
    expect(await tmux.capture(pane, { lines: 5, attributes: true })).toContain("\x1b[");
    expect(await tmux.capture(pane, { lines: 5, attributes: false })).not.toContain("\x1b[");
    expect(await tmux.capture(pane, { lines: 5 })).not.toContain("\x1b[");
  });
  it("joins a wrapped line unless join is false", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-x", "20", "-y", "10", `sh -c 'echo "${"w".repeat(50)}"; echo end; exec sleep 600'`);
    const pane = t.tmux("list-panes", "-t", "=main", "-F", "#{pane_id}").trim();
    await until(() => t.tmux("capture-pane", "-p", "-t", pane).includes("end"));
    const tmux = tmuxAdapter({ socket: t.socket, session: "main" });
    expect((await tmux.capture(pane, { lines: 10 }))?.split("\n")).toEqual(["w".repeat(50), "end"]);
    expect((await tmux.capture(pane, { lines: 10, attributes: false, join: false }))?.split("\n")).toEqual(["w".repeat(20), "w".repeat(20), "w".repeat(10), "end"]);
  });
  it("a count out of range, a pane that isn't one or is gone: null", async () => {
    const pane = await printed();
    const tmux = tmuxAdapter({ socket: t.socket, session: "main" });
    for (const lines of [0, 2001, 1.5]) expect(await tmux.capture(pane, { lines, attributes: false }), String(lines)).toBeNull();
    expect(await tmux.capture("main:0", { lines: 5, attributes: false })).toBeNull();
    expect(await tmux.capture("%999", { lines: 5, attributes: false })).toBeNull();
  });
});

describe("pasteLiteral (the launcher at a shell's prompt)", () => {
  it("pastes one line bracketed, every control character and newline left out, and presses no Enter", async () => {
    const r = await recorder();
    await tmuxAdapter({ socket: t.socket, session: "main" }).pasteLiteral(r.pane, "claude-as acct2\n--resume x\x1b[201~;rm\r");
    await until(() => r.got().endsWith("\x1b[201~"));
    expect(r.got()).toBe("\x1b[200~claude-as acct2--resume x[201~;rm\x1b[201~");
  });
  it("rejects a pane that isn't one, or is gone", async () => {
    await recorder();
    const tmux = tmuxAdapter({ socket: t.socket, session: "main" });
    await expect(tmux.pasteLiteral("main:0", "x")).rejects.toThrow("not a pane ID");
    await expect(tmux.pasteLiteral("%999", "x")).rejects.toThrow("tmux exited");
  });
});
```

Run: `npx vitest run packages/node-ops/test/tmux-keys-capture.test.ts`
Expected: FAIL, 8 failed: among them `TypeError: keys.sendKeyNames is not a function` and `TypeError: tmux.pasteLiteral is not a function`, and the old `capture(id)`, which answers its whole view whatever is asked.

- [ ] **Step 16: Extend `packages/node-ops/src/tmux.ts`**

`send`'s paste moves into `pasteText`, unchanged, so that `pasteLiteral` uses the same command list and bound. Then the two new methods and `capture`'s options. `join` defaults to true, as kira reads screen text (ruling 10).

Replace lines 1–2:

```ts
// Terminal multiplexer adapter: lists panes, captures their text, and (ADR-0006) pastes a command into one.
// Commands used (tmux(1), 3.4): list-panes, capture-pane, and for sending load-buffer, paste-buffer, send-keys.
```

with:

```ts
// Terminal multiplexer adapter: lists panes, captures their text, and (ADR-0006) pastes a command into one; for fleet
// clients (docs/design/fleet-clients/README.md §5) also a capture of N lines with attributes, keys by name and the
// launcher's literal paste. Commands used (tmux(1), 3.4; the texts quoted below are tmux 3.6a's man page, read 2026-10-08,
// https://man7.org/linux/man-pages/man1/tmux.1.html): list-panes, capture-pane, and for sending load-buffer,
// paste-buffer, send-keys. Panes are targeted by ID (%N) only; no argument here is a format, so none needs tmuxLiteral.
```

After line 7 (`import { workerId, type Worker } from "@morndo/domain";`), insert:

```ts
import { KEY_NAMES, LIMITS, type KeyName } from "@morndo/protocol";
```

Replace lines 19–21:

```ts
  capture(id: string): Promise<string | null>;
  send(id: string, text: string, call?: { signal?: AbortSignal }): Promise<SendProblem | null>;
};
```

with:

```ts
  // Without `o`, the hub's view: the history it was made with and the screen, plain. With `o` (pane.capture), the screen's
  // last `o.lines` lines (1 to LIMITS.captureMaxLines), with tmux's attribute escapes when `o.attributes`, and wrapped
  // lines joined unless `o.join` is false. null: no such pane, or a count out of range.
  capture(id: string, o?: { lines: number; attributes?: boolean; join?: boolean }): Promise<string | null>;
  send(id: string, text: string, call?: { signal?: AbortSignal }): Promise<SendProblem | null>;
  // Keys by name (pane.keys `names`): true once tmux took them; false for a name off KEY_NAMES, no names or too many, a
  // pane that isn't one, or a tmux that failed.
  sendKeyNames(paneId: string, names: KeyName[]): Promise<boolean>;
  // The launcher's command line at a shell's prompt (`launch.via: "shell"`): pasted bracketed as one line, with no input-box
  // checks and no Enter (the caller presses it). Rejects when tmux fails.
  pasteLiteral(paneId: string, text: string): Promise<void>;
};

const KEYS = new Set<string>(KEY_NAMES);
const PANE_ID = /^%\d+$/;

// Text into a pane as one tmux command list, so no other tmux client's keys land between its parts: load it into a private
// buffer from stdin (load-buffer: "If path is '-', the contents are read from stdin"), paste it (-p: "paste bracket control
// codes are inserted around the buffer if the application has requested bracketed paste mode") and delete the buffer (-d),
// then `after`. The same 5 s bound as every other tmux call here; SIGKILL, because tmux's client exits 0 on SIGTERM, which
// would read as success.
function pasteText(socket: string | null, id: string, text: string, after: readonly string[]): Promise<void> {
  const buffer = `morndo-${randomUUID()}`;
  return new Promise<void>((resolve, reject) => {
    const p = spawn("tmux", tmuxArgv(socket, ["load-buffer", "-b", buffer, "-", ";", "paste-buffer", "-p", "-d", "-b", buffer, "-t", id, ...after]), { timeout: 5000, killSignal: "SIGKILL" });
    p.on("error", reject);
    p.on("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(`tmux exited ${code ?? signal}`))));
    p.stdin.on("error", () => { /* the exit handler reports it */ });
    p.stdin.end(text);
  });
}
```

Replace lines 131–142:

```ts
      // One command list, so no other tmux client's keys land between paste and Enter: load the text into a private
      // buffer from stdin, paste it bracketed (-p) and delete the buffer (-d), then press Enter.
      const buffer = `morndo-${randomUUID()}`;
      call?.signal?.throwIfAborted();             // the deadline's last word: nothing is pasted after it
      await new Promise<void>((resolve, reject) => {
        // The same 5 s bound as every other tmux call here; SIGKILL, because tmux's client exits 0 on SIGTERM, which would read as success.
        const p = spawn("tmux", tmuxArgv(opts.socket, ["load-buffer", "-b", buffer, "-", ";", "paste-buffer", "-p", "-d", "-b", buffer, "-t", id, ";", "send-keys", "-t", id, "Enter"]), { timeout: 5000, killSignal: "SIGKILL" });
        p.on("error", reject);
        p.on("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(`tmux exited ${code ?? signal}`))));
        p.stdin.on("error", () => { /* the exit handler reports it */ });
        p.stdin.end(clean);
      });
```

with:

```ts
      call?.signal?.throwIfAborted();             // the deadline's last word: nothing is pasted after it
      await pasteText(opts.socket, id, clean, [";", "send-keys", "-t", id, "Enter"]);
```

Replace lines 148–152:

```ts
    async capture(id) {
      if (!/^%\d+$/.test(id)) return null;
      try {
        const out = await tmux(["capture-pane", "-p", "-J", "-t", id, "-S", `-${history}`]);
        return out.split("\n").map(l => l.trimEnd()).join("\n").replace(/\n+$/, "");
```

with:

```ts
    async capture(id, o) {
      if (!/^%\d+$/.test(id)) return null;
      if (o && (!Number.isInteger(o.lines) || o.lines < 1 || o.lines > LIMITS.captureMaxLines)) return null;
      try {
        if (!o) {
          const out = await tmux(["capture-pane", "-p", "-J", "-t", id, "-S", `-${history}`]);
          return out.split("\n").map(l => l.trimEnd()).join("\n").replace(/\n+$/, "");
        }
        // -S: "negative numbers are lines in the history", so -S -N is N lines of history and the visible pane; -J "joins
        // any wrapped lines" (as kira reads screen text; left out when `join` is false); -e "includes escape sequences for
        // text and background attributes". The pane's empty bottom lines go first (blank once their escapes are left out),
        // then the last N lines are what was asked for.
        const out = await tmux(["capture-pane", "-p", ...(o.join === false ? [] : ["-J"]), ...(o.attributes ? ["-e"] : []), "-t", id, "-S", `-${o.lines}`]);
        const lines = out.split("\n").map(l => l.trimEnd());
        while (lines.length && !lines.at(-1)?.replace(SGR, "").trim()) lines.pop();
        return lines.slice(-o.lines).join("\n");
```

After line 156 (`},`), insert:

```ts
    async sendKeyNames(paneId, names) {
      // send-keys: "Each argument key is the name of the key (such as 'C-a' or 'NPage') to send"; one argument per name,
      // never -l ("disables key name lookup"). The allow-list is checked again here, right before tmux sees the names.
      if (!PANE_ID.test(paneId) || names.length === 0 || names.length > LIMITS.maxKeys || !names.every(n => KEYS.has(n))) return false;
      try { await tmux(["send-keys", "-t", paneId, ...names]); return true; }
      catch { return false; }
    },
    async pasteLiteral(paneId, text) {
      if (!PANE_ID.test(paneId)) throw new Error(`not a pane ID: ${JSON.stringify(paneId)}`);
      // One line: every control character is dropped, a newline too. paste-buffer replaces "any linefeed (LF) characters
      // in the paste buffer ... by default [with] carriage return (CR)", which a shell without bracketed paste would run.
      let line = "";
      for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c >= 0x20 && c !== 0x7f) line += text.charAt(i); }
      await pasteText(opts.socket, paneId, line, []);
    },
```

- [ ] **Step 17: The fake `Tmux` in the hub's test**

After line 21 (`send: async (id, text) => { typed.push({ id, text, at: Date.now() });…`), insert:

```ts
    sendKeyNames: async () => false,                                  // the hub's local node never presses keys by name
    pasteLiteral: async () => {},
```

- [ ] **Step 18: Run it, check that each rule bites, and move `b4-paste-spawn-timeout`'s text**

Run: `npx vitest run packages/node-ops/test/tmux-keys-capture.test.ts packages/node-ops/test/tmux.test.ts`, three times
Expected: PASS (12 tests) each time.

Run: `npx vitest run apps/node-agent/test/pane-ops.test.ts`
Expected: PASS, unchanged: `send` behaves as before.

`b4-paste-spawn-timeout` finds its text in `tmux.ts` with the old indentation. In `scripts/negative-controls.ts`, replace line 840:

```ts
    find: ', { timeout: 5000, killSignal: "SIGKILL" });\n        p.on("error", reject);', replace: ');\n        p.on("error", reject);',
```

with:

```ts
    find: ', { timeout: 5000, killSignal: "SIGKILL" });\n    p.on("error", reject);', replace: ');\n    p.on("error", reject);',
```

Run: `node scripts/negative-controls.ts --check | grep -v '^ok'`
Expected: no output. Step 19 runs the control itself, after the commit.

Then make each change alone in `tmux.ts` and see the failure (Step 20's entries):
- the allow-list: drop ` || !names.every(n => KEYS.has(n))`. Expected: a failure in "refuses a name off the allow-list, …" (`expected true to be false`).
- one line: change `if (c >= 0x20 && c !== 0x7f) line += text.charAt(i);` to `if (c === 10 || (c >= 0x20 && c !== 0x7f)) line += text.charAt(i);`. Expected: `expected '\u001b[200~claude-as acct2\r--resume …' to be …`: tmux turned the newline into a CR, which a shell runs.
- the last N lines: change `return lines.slice(-o.lines).join("\n");` to `return lines.join("\n");`. Expected: `to have a length of 50 but got 89`.
- the line count's bounds: delete the line `if (o && (!Number.isInteger(o.lines) || o.lines < 1 || o.lines > LIMITS.captureMaxLines)) return null;`. Expected: `0: expected 'line 263…' to be null`.
- attributes: change `...(o.attributes ? ["-e"] : [])` to `...([] as string[])`. Expected: `expected 'line 297…' to contain '\u001b['`.
- join: change `...(o.join === false ? [] : ["-J"])` to `"-J"`. Expected: a failure in "joins a wrapped line unless join is false".

- [ ] **Step 19: Commit**

```bash
git add packages/node-ops/src/tmux.ts packages/node-ops/test/tmux-keys-capture.test.ts apps/hub/test/local-node.test.ts scripts/negative-controls.ts
git commit -m "feat(node-ops): keys by name, a capture of N lines with attributes, and the launcher's literal paste"
```

Run, now that the commit holds the moved text (the runner reads `HEAD`, ruling 50): `node scripts/negative-controls.ts --only b4-paste-spawn-timeout`
Expected: `1/1 controls bit`. Its test, `pane-ops.test.ts`, still sees "stalls at the paste".

- [ ] **Step 20: The negative controls, as data, and the repo's checks**

In `scripts/negative-controls.ts`, after Task 1's `fc1-` entries, add:

```ts
  { id: "fc2-receipt-cleared-dropped", task: "fc2", file: "packages/node-ops/src/receipt.ts",
    find: 'if (o.reason === "cleared_on_cancel") return { verdict: "dropped", text: o.content, at };',
    replace: 'if (o.reason === "cleared_on_cancel") return { verdict: "delivered", text: o.content, at };',
    run: ["packages/node-ops/test/receipt.test.ts"], expect: "to deeply equal [ 'd1:dropped' ]" },
  { id: "fc2-receipt-unknown-reason", task: "fc2", file: "packages/node-ops/src/receipt.ts",
    find: '    if (o.reason === "cleared_on_cancel") return { verdict: "dropped", text: o.content, at };\n    return null;',
    replace: '    if (o.reason === "cleared_on_cancel") return { verdict: "dropped", text: o.content, at };\n    return { verdict: "delivered", text: o.content, at };',
    run: ["packages/node-ops/test/receipt.test.ts"], expect: "a remove reason not known here" },
  { id: "fc2-receipt-dequeue", task: "fc2", file: "packages/node-ops/src/receipt.ts",
    find: 'if (o.operation !== "remove") return null;', replace: 'if (o.operation !== "remove") return { verdict: "delivered", text: o.content, at };',
    run: ["packages/node-ops/test/receipt.test.ts"], expect: "a dequeue gives no verdict" },
  { id: "fc2-receipt-not-prompts", task: "fc2", file: "packages/node-ops/src/receipt.ts",
    find: "if (o.isMeta === true || o.isCompactSummary === true || !isRecord(o.message)) return null;", replace: "if (!isRecord(o.message)) return null;",
    run: ["packages/node-ops/test/receipt.test.ts"], expect: "are not prompts" },
  { id: "fc2-receipt-sidechain", task: "fc2", file: "packages/node-ops/src/receipt.ts",
    find: "if (!isRecord(o) || o.isSidechain === true) return null;", replace: "if (!isRecord(o)) return null;",
    run: ["packages/node-ops/test/receipt.test.ts"], expect: "the row kinds Claude Code writes" },
  { id: "fc2-receipt-tool-result", task: "fc2", file: "packages/node-ops/src/receipt.ts",
    find: 'if (!Array.isArray(c) || c.some(b => isRecord(b) && b.type === "tool_result")) return null;', replace: "if (!Array.isArray(c)) return null;",
    run: ["packages/node-ops/test/receipt.test.ts"], expect: "the row kinds Claude Code writes" },
  { id: "fc2-receipt-after-typing", task: "fc2", file: "packages/node-ops/src/receipt.ts",
    find: " && e.at >= q.typedAt && ", replace: " && ",
    run: ["packages/node-ops/test/receipt.test.ts"], expect: "decides nothing" },
  { id: "fc2-receipt-one-each", task: "fc2", file: "packages/node-ops/src/receipt.ts",
    find: "order.find(q => !decided.has(q.id) && ", replace: "order.find(q => ",
    run: ["packages/node-ops/test/receipt.test.ts"], expect: "need two receipts" },
  { id: "fc2-receipt-merged-min-length", task: "fc2", file: "packages/node-ops/src/receipt.ts",
    find: "if (want.length >= 12 && ", replace: "if (want.length >= 1 && ",
    run: ["packages/node-ops/test/receipt.test.ts"], expect: "a short text is never found inside another prompt" },
  { id: "fc2-receipt-pasted-wrapper", task: "fc2", file: "packages/node-ops/src/receipt.ts",
    find: '.replace(PASTE_TAG, "")', replace: "",
    run: ["packages/node-ops/test/receipt.test.ts"], expect: "a pasted_content wrapper" },
  { id: "fc2-receipt-slash-name", task: "fc2", file: "packages/node-ops/src/receipt.ts",
    find: "if (!slash || name === undefined || name.trim() !== `/${slash[1]}`) return false;", replace: "if (!slash || name === undefined) return false;",
    run: ["packages/node-ops/test/receipt.test.ts"], expect: "another command, other arguments" },
  { id: "fc2-receipt-as-typed", task: "fc2", file: "packages/node-ops/src/receipt.ts",
    find: "const want = normalize(typed(text)), got = normalize(prompt);", replace: "const want = normalize(text), got = normalize(prompt);",
    run: ["packages/node-ops/test/receipt.test.ts"], expect: "control characters but newline and tab dropped" },
  { id: "fc2-new-session-commands", task: "fc2", file: "packages/node-ops/src/receipt.ts",
    find: String.raw`const NEW_SESSION = /^\/(?:clear|reset|new)(?:[ \t][^\n]*)?$/;`, replace: String.raw`const NEW_SESSION = /^\/(?:clear|reset|new)/;`,
    run: ["packages/node-ops/test/receipt.test.ts"], expect: "is known from its text" },
  { id: "fc2-new-session-changed", task: "fc2", file: "packages/node-ops/src/receipt.ts",
    find: "return startsNewSession(text) && sessionNow !== null && sessionNow !== typedInto;", replace: "return startsNewSession(text) && sessionNow !== null;",
    run: ["packages/node-ops/test/receipt.test.ts"], expect: "changing to another id" },
  { id: "fc2-menu-tab-strip", task: "fc2", file: "packages/node-ops/src/menu.ts",
    find: String.raw`const TAB_STRIP = /^\s*←.*→\s*$/;`, replace: "const TAB_STRIP = /^$ never/;",
    run: ["packages/node-ops/test/menu.test.ts"], expect: "Shall I go on?" },
  { id: "fc2-menu-question-mark", task: "fc2", file: "packages/node-ops/src/menu.ts",
    find: String.raw`const q = [...question].reverse().find(l => /\?\s*$/.test(l)) ?? question.at(-1) ?? "";`, replace: 'const q = question.at(-1) ?? "";',
    run: ["packages/node-ops/test/menu.test.ts"], expect: "It needs one more review." },
  { id: "fc2-menu-colours", task: "fc2", file: "packages/node-ops/src/menu.ts",
    find: 'screen.replace(OSC, "").replace(SGR, "")', replace: 'screen.replace(OSC, "")',
    run: ["packages/node-ops/test/menu.test.ts"], expect: "Do you want to proceed?" },
  { id: "fc2-menu-whole-characters", task: "fc2", file: "packages/node-ops/src/menu.ts",
    find: 'return q ? Array.from(q).slice(0, 200).join("") : null;', replace: "return q ? q.slice(0, 200) : null;",
    run: ["packages/node-ops/test/menu.test.ts"], expect: "never half of one" },
  { id: "fc2-session-status-known", task: "fc2", file: "packages/node-ops/src/sessions.ts",
    find: 'status: typeof d.status === "string" && STATUSES.has(d.status) ? d.status as SessionStatus : null,',
    replace: 'status: typeof d.status === "string" ? d.status as SessionStatus : null,',
    run: ["packages/node-ops/test/sessions.test.ts"], expect: "compacting" },
  { id: "fc2-keys-allow-list", task: "fc2", file: "packages/node-ops/src/tmux.ts",
    find: " || !names.every(n => KEYS.has(n))) return false;", replace: ") return false;",
    run: ["packages/node-ops/test/tmux-keys-capture.test.ts"], expect: "refuses a name off the allow-list" },
  { id: "fc2-paste-one-line", task: "fc2", file: "packages/node-ops/src/tmux.ts",
    find: "if (c >= 0x20 && c !== 0x7f) line += text.charAt(i);", replace: "if (c === 10 || (c >= 0x20 && c !== 0x7f)) line += text.charAt(i);",
    run: ["packages/node-ops/test/tmux-keys-capture.test.ts"], expect: "every control character and newline left out" },
  { id: "fc2-capture-last-lines", task: "fc2", file: "packages/node-ops/src/tmux.ts",
    find: 'return lines.slice(-o.lines).join("\\n");', replace: 'return lines.join("\\n");',
    run: ["packages/node-ops/test/tmux-keys-capture.test.ts"], expect: "to have a length of 50" },
  { id: "fc2-capture-lines-bounded", task: "fc2", file: "packages/node-ops/src/tmux.ts",
    find: "if (o && (!Number.isInteger(o.lines) || o.lines < 1 || o.lines > LIMITS.captureMaxLines)) return null;", replace: "",
    run: ["packages/node-ops/test/tmux-keys-capture.test.ts"], expect: "a count out of range" },
  { id: "fc2-capture-attributes", task: "fc2", file: "packages/node-ops/src/tmux.ts",
    find: '...(o.attributes ? ["-e"] : [])', replace: "...([] as string[])",
    run: ["packages/node-ops/test/tmux-keys-capture.test.ts"], expect: "keeps tmux's escapes" },
  { id: "fc2-capture-join", task: "fc2", file: "packages/node-ops/src/tmux.ts",
    find: '...(o.join === false ? [] : ["-J"])', replace: '"-J"',
    run: ["packages/node-ops/test/tmux-keys-capture.test.ts"], expect: "joins a wrapped line unless join is false" },
```

Run each in turn:
- `node scripts/negative-controls.ts --check | grep -v '^ok'`. Expected: no output.
- `npm run check`. Expected: exit 0; `0 ERRORS 0 WARNINGS`.
- `npm run lint`. Expected: no problems reported.
- `npx vitest run --project units packages apps/hub apps/node-agent apps/fleet scripts`. Expected: everything passes but, on macOS, `pane-lock.test.ts`'s 2 and `process-start.test.ts`'s 2. At `12c2811` on 2026-10-09: 207 files.

```bash
git add scripts/negative-controls.ts
git commit -m "test(node-ops): negative controls for the receipt, the menu question, the session status and the tmux additions"
```

Then, after the commit (ruling 50), run them: `node scripts/negative-controls.ts --list | awk -F'\t' '$1 ~ /^fc2-/ {print "--only " $1}' | xargs node scripts/negative-controls.ts`
Expected: `25/25 controls bit; still pass 0, broke 0, timed out 0, skipped 0`.

---

### Task 3: `packages/fleet-client`

The hub's fleet client moves into a workspace package, `@morndo/fleet-client`, so `morndo lanes` (Task 14) and kira (Task 18) can take it without the hub. Then it gains the Contracts' additions. Two commits:
- **a pure move** (Steps 1–9). The proof is the suite: the same tests pass, with the new package's architecture test the only addition. Two things are cut from the hub on the way, without changing behaviour: its logger becomes an option (`log`, by default a redacting stderr writer), and its `NodeState` becomes the client's own `NodeStatus`. The old module re-exports the package for one release.
- **the additions** (Steps 10–15):
  - the client's name (`x-morndo-client`, §8);
  - `caps()`' sticky lanes (Review Focus 5);
  - `deliver`, `delivery`, `deliveries`, `cancelDelivery` and `laneEvents`;
  - `delivery` and `lane` events with their bodies checked;
  - the two new alert kinds;
  - `op()` never sends the two delivery ops (ruling 4);
  - `cancelDelivery` answers `null` for a delivery the fleet doesn't know (ruling 56), and `FleetUnavailable.reached` keeps the in-doubt rule on every delivery call (ruling 49).

  They are tested against a stub of the Contracts' routes on a real Unix socket, so this task needs neither Task 8 nor Task 9.

How the package is set up follows `packages/service-kit` and `packages/node-ops`:
- `package.json` with `exports` pointing at `src/index.ts`;
- `tsconfig.json` with Node's types;
- one `tsc -p packages/fleet-client` in the root `check` script.

Two things need no change, checked on 2026-10-08: `vitest.config.ts`'s `units` project already includes `packages/*/test/**/*.test.ts`, and `tsconfig.tests.json` includes `packages/*/test`.

The package imports `ws`, besides the protocol and `node:*`, as ruling 9 allows (its events socket over the Unix socket).

**Files:**
- Create: `packages/fleet-client/package.json`, `packages/fleet-client/tsconfig.json`, `packages/fleet-client/src/index.ts`, `packages/fleet-client/test/architecture.test.ts`, `packages/fleet-client/test/deliveries.test.ts` (Step 10).
- Move:
  - `apps/hub/src/adapters/fleet-client.ts` → `packages/fleet-client/src/fleet-client.ts`, then its header, imports and constructor (Step 4);
  - `apps/hub/test/fleet-client.test.ts` → `packages/fleet-client/test/fleet-client.test.ts` (imports only);
  - `apps/hub/test/fleet-unknown-error-code.test.ts` → `packages/fleet-client/test/unknown-error-code.test.ts` (imports only).
- Create (Step 4): a new `apps/hub/src/adapters/fleet-client.ts` that re-exports `@morndo/fleet-client`.
- Modify:
  - `apps/hub/src/main.ts:31,240`, `apps/hub/src/adapters/fleet-adapters.ts:18`, `apps/hub/package.json:10`;
  - `package.json:14` (`check`), `package-lock.json` (by `npm install`), `.oxlintrc.json` (after `"packages/node-ops/src/**",`: `no-console` for the package's source);
  - `test/fleet-harness.ts:25`, `e2e/fleet-qa.ts:19`, `test/fleet/upload-retry-expired.test.ts:9`.
- Modify `scripts/negative-controls.ts`:
  - Step 8: the 12 entries on the moved client point at its new file and tests. Four of them get new text where Step 12 changes their line: `t14-client-no-alert-event`, `t14-client-no-name`, `t14a-5xx-not-op` and `b3-v13-ipc-url`;
  - Step 14: the `fc3-` entries.
- Modify (Step 10): `packages/fleet-client/test/fleet-client.test.ts:37`. (Step 12): `packages/fleet-client/src/fleet-client.ts`.

**Interfaces:**
- Consumes:
  - `@morndo/protocol`: `CLIENT_API`, `readOpError`, `redactText`, `toLogFormat`, `parseBody`, and from Task 1 `DeliverySchema`, `LaneEventSchema`, `Delivery`, `DeliveryState`, `LaneEvent` and `AlertKind`;
  - `node:http`, `node:net`, `node:os`, and `ws` ^8.22.0, already in the stack.
- Produces (`@morndo/fleet-client`):
  - `FleetClient`:
    - `constructor(socketPath: string, o?: { client?: string; log?: FleetLog })`. `client` is the Contracts', default `"hub"`; one that isn't a-z, at most 16 letters, throws `TypeError`. `log` is a contract addition;
    - `caps(): Promise<{ api: number[]; stickyLanes: string[] }>`, with `[]` from a fleet that sends no `stickyLanes`;
    - `op<O extends ClientOp>(…)`, where `ClientOp = Exclude<OpName, "lane.deliver" | "delivery.cancel">` (a contract addition). It throws `TypeError` for those two at runtime as well, and sends nothing (ruling 4);
    - `nodes()`, `lanes()`, `alerts()` (keeping `delivery_waiting` and `subscriber_lagging`), `fileStream()` and `events()`, unchanged otherwise;
    - `deliver(d)`, `delivery(id)`, `deliveries(q?)`, `cancelDelivery(id): Promise<Delivery | null>` and `laneEvents(since?)`, as the Contracts have them. `cancelDelivery` answers `null` on 404 `{ error: "no_such_delivery" }`, as `delivery(id)` does (ruling 56). A refusal throws `FleetOpFailed` with its `OpError`;
    - no answer throws `FleetUnavailable` (ruling 49). `reached: false` only when nothing left this process (no socket, refused, no permission, a path too long): nothing was queued. `reached: true` when the request went out and no answer came: the connection dropped, the time ran out, a 5xx on a read, or an answer that isn't a delivery's. The delivery is then in doubt, and a caller sends the same id again, never types the text itself;
  - `FleetEvent`: as before, plus `{ t: "delivery"; node; body: Delivery & { stale: boolean } }` and `{ t: "lane"; node; body: LaneEvent }`;
  - `FleetDelivery = Delivery & { stale: boolean }` and `FleetLog` (contract additions);
  - unchanged from the hub: `NodeStatus`, `FleetNode`, `FleetLane`, `OpTarget`, `OpAnswer`, `FleetUnavailable`, `FleetMismatch`, `FleetOpFailed`, `checkFleet`.
- The hub imports `@morndo/fleet-client`; `apps/hub/src/adapters/fleet-client.ts` re-exports it.

- [ ] **Step 1: Record the suite before anything moves**

Run: `npx vitest run --project units packages apps/hub`
Expected: everything passes but, on macOS, `pane-lock.test.ts`'s 2 and `process-start.test.ts`'s 2. Note the totals; Step 7 compares. At `12c2811` on 2026-10-09, after Task 2: 140 files, 1161 tests (1 skipped).

- [ ] **Step 2: Write the failing architecture test**

Create `packages/fleet-client/test/architecture.test.ts`:

```ts
// The fleet client imports only the protocol, node:* and ws (docs/design/fleet-clients/plan.md, Global Constraints, DDD;
// ws for the events socket over a Unix socket): any client can take it without the hub, the fleet or the agent.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../src");
const importsOf = (code: string) => [...code.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1] ?? m[2] ?? "");

export const offending = (code: string) => importsOf(code).filter(spec =>
  !(/^\.\/[\w-]+\.ts$/.test(spec) || /^node:[\w/]+$/.test(spec) || spec === "@morndo/protocol" || spec === "ws"));

describe("fleet-client architecture", () => {
  it("every file imports only siblings, node:*, the protocol and ws", () => {
    const files = readdirSync(SRC).filter(f => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const bad = files.flatMap(f => offending(readFileSync(join(SRC, f), "utf8")).map(spec => `${f} -> ${spec}`));
    expect(bad).toEqual([]);
  });
  it("the check catches an app, another package or a relative path out of the package (negative controls)", () => {
    expect(offending(`import { log } from "../../../apps/hub/src/adapters/log.ts";`)).toEqual(["../../../apps/hub/src/adapters/log.ts"]);
    expect(offending(`import type { NodeState } from "../application/ports.ts";`)).toEqual(["../application/ports.ts"]);
    expect(offending(`import { sessionRegistry } from "@morndo/node-ops";`)).toEqual(["@morndo/node-ops"]);
    expect(offending(`import Database from "better-sqlite3";`)).toEqual(["better-sqlite3"]);
    expect(offending(`import { request } from "node:http";\nimport { WebSocket } from "ws";\nimport { LIMITS } from "@morndo/protocol";\nexport * from "./fleet-client.ts";`)).toEqual([]);
  });
});
```

Run: `npx vitest run packages/fleet-client/test/architecture.test.ts`
Expected: FAIL with `ENOENT: no such file or directory, scandir '…/packages/fleet-client/src'`. The negative-control test passes.

- [ ] **Step 3: Create the package**

`packages/fleet-client/package.json`:

```json
{
  "name": "@morndo/fleet-client",
  "version": "0.0.0",
  "private": true,
  "description": "The TypeScript client of the fleet's client API: HTTP and events over the fleet's Unix socket, deliveries and lane events included. Used by the hub and `morndo lanes`; any client may import it.",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@morndo/protocol": "0.0.0",
    "ws": "^8.22.0"
  },
  "devDependencies": {
    "@types/ws": "^8.18.2"
  }
}
```

`packages/fleet-client/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["esnext"], "types": ["node"] },
  "include": ["src"]
}
```

- [ ] **Step 4: Move the client and its tests; cut it loose from the hub**

```bash
mkdir -p packages/fleet-client/src packages/fleet-client/test
git mv apps/hub/src/adapters/fleet-client.ts packages/fleet-client/src/fleet-client.ts
git mv apps/hub/test/fleet-client.test.ts packages/fleet-client/test/fleet-client.test.ts
git mv apps/hub/test/fleet-unknown-error-code.test.ts packages/fleet-client/test/unknown-error-code.test.ts
```

In `packages/fleet-client/src/fleet-client.ts`, nothing changes but its header, its imports, the logger and `NodeStatus`. The Node docs give the global `WebSocket` no way to dial a Unix socket (https://nodejs.org/docs/latest-v24.x/api/globals.html#websocket, read 2026-10-08), so `ws` stays.

Replace lines 1–2:

```ts
// The hub's client of the fleet service's client API (ADR-0012; docs/design/fleet-core/README.md §5.6; the wire format
// in plan.md § Contracts, "Client API"): HTTP and one WebSocket over the fleet's Unix socket.
```

with:

```ts
// The TypeScript client of the fleet service's client API (ADR-0012; docs/design/fleet-core/README.md §5.6; fleet clients,
// docs/design/fleet-clients/README.md §8): HTTP and one WebSocket over the fleet's Unix socket. Moved out of the hub
// (fleet clients, Task 3) for the hub, `morndo lanes` and kira; it imports only @morndo/protocol, node:* and ws.
```

After line 9 (`//   through new URL() (a space or a non-ASCII letter percent-encoded…`), insert:

```ts
// - ws, not Node's own WebSocket: Node's is undici's, whose docs give it no way to dial a Unix socket
//   (https://nodejs.org/docs/latest-v24.x/api/globals.html#websocket, read 2026-10-08).
```

Replace lines 14–19:

```ts
import { WebSocket } from "ws";
import { CLIENT_API, readOpError, type Alert, type AlertKind, type Health, type OpArgs, type OpError, type OpName, type OpResult } from "@morndo/protocol";
import type { NodeState } from "../application/ports.ts";
import { log } from "./log.ts";

export type NodeStatus = NodeState;                     // "online" | "stale" | "offline"
```

with:

```ts
import { homedir } from "node:os";
import { WebSocket } from "ws";
import {
  CLIENT_API, readOpError, redactText, toLogFormat, type Alert, type AlertKind, type Health, type OpArgs, type OpError, type OpName, type OpResult,
} from "@morndo/protocol";

export type NodeStatus = "online" | "stale" | "offline";
// Where the client says what went wrong with its events (a frame it couldn't read, a listener that threw). The hub passes
// its own logger; without one, a line goes to stderr, redacted as the services' own logs are (protocol redact.ts).
export type FleetLog = { warn(message: string, error?: unknown): void; error(message: string, error?: unknown): void };
const stderrLog = (level: "warn" | "error") => (message: string, error?: unknown) => {
  process.stderr.write(`${redactText(`[fleet-client] ${level}: ${message}${error === undefined ? "" : `\n${toLogFormat(error)}`}`, homedir())}\n`);
};
const STDERR_LOG: FleetLog = { warn: stderrLog("warn"), error: stderrLog("error") };
```

Replace lines 93–94:

```ts

  constructor(socketPath: string) { this.#socketPath = socketPath; }
```

with:

```ts
  readonly #log: FleetLog;

  constructor(socketPath: string, o: { log?: FleetLog } = {}) {
    this.#socketPath = socketPath;
    this.#log = o.log ?? STDERR_LOG;
  }
```

Replace lines 207–208:

```ts
        try { void Promise.resolve(o.onOpen?.()).catch(e => log.error("fleet events: onOpen failed", e)); }
        catch (e) { log.error("fleet events: onOpen failed", e); }
```

with:

```ts
        try { void Promise.resolve(o.onOpen?.()).catch(e => this.#log.error("fleet events: onOpen failed", e)); }
        catch (e) { this.#log.error("fleet events: onOpen failed", e); }
```

Replace lines 213–219:

```ts
        try { v = JSON.parse(raw.toString("utf8")); } catch { log.warn("fleet events: a frame that isn't JSON, ignored"); return; }
        if (!isRecord(v) || typeof v.t !== "string" || typeof v.node !== "string" || !("body" in v)) { log.warn("fleet events: a frame of an unknown shape, ignored"); return; }
        if (!EVENTS.has(v.t)) return;                                 // a kind a newer fleet added
        try { on({ t: v.t as FleetEvent["t"], node: v.node, body: v.body }); }
        catch (e) { log.error("fleet events: a listener failed", e); }
      });
      ws.on("error", e => log.warn(`fleet events: ${e.message}`));
```

with:

```ts
        try { v = JSON.parse(raw.toString("utf8")); } catch { this.#log.warn("fleet events: a frame that isn't JSON, ignored"); return; }
        if (!isRecord(v) || typeof v.t !== "string" || typeof v.node !== "string" || !("body" in v)) { this.#log.warn("fleet events: a frame of an unknown shape, ignored"); return; }
        if (!EVENTS.has(v.t)) return;                                 // a kind a newer fleet added
        try { on({ t: v.t as FleetEvent["t"], node: v.node, body: v.body }); }
        catch (e) { this.#log.error("fleet events: a listener failed", e); }
      });
      ws.on("error", e => this.#log.warn(`fleet events: ${e.message}`));
```

`packages/fleet-client/src/index.ts`:

```ts
// The fleet's client API for TypeScript clients (docs/design/fleet-clients/README.md §8): the hub, `morndo lanes`, kira.
export * from "./fleet-client.ts";
```

The old path, `apps/hub/src/adapters/fleet-client.ts`, re-exports it:

```ts
// The fleet client moved to packages/fleet-client (fleet clients, Task 3). This module re-exports it for one release, for
// code that still imports it from here; the hub's own code imports "@morndo/fleet-client".
export * from "@morndo/fleet-client";
```

The moved tests change their imports (and the first its header comment):

Replace line 1:

```ts
// The hub's fleet client (spec §5.6) against the fake fleet on a real Unix socket: capabilities, nodes, lanes and
```

with:

```ts
// The fleet client (fleet core spec §5.6, moved out of the hub: fleet clients, Task 3) against the fake fleet on a real Unix socket: capabilities, nodes, lanes and
```

Replace lines 12–13:

```ts
import { FleetClient, FleetMismatch, FleetOpFailed, FleetUnavailable, checkFleet, type FleetEvent } from "../src/adapters/fleet-client.ts";
import { localNode, memoryBackend, startFakeFleet, until, type FakeFleet } from "./helpers/fake-fleet.ts";
```

with:

```ts
import { FleetClient, FleetMismatch, FleetOpFailed, FleetUnavailable, checkFleet, type FleetEvent } from "../src/index.ts";
// The hub's fake fleet (its tests' helper, built on the hub's ports) serves the client API these tests read.
import { localNode, memoryBackend, startFakeFleet, until, type FakeFleet } from "../../../apps/hub/test/helpers/fake-fleet.ts";
```

Replace line 9:

```ts
import { FleetClient } from "../src/adapters/fleet-client.ts";
```

with:

```ts
import { FleetClient } from "../src/index.ts";
```

- [ ] **Step 5: The hub depends on the package, and everything imports it from there**

`apps/hub/package.json`:

After line 9 (`"dependencies": {`), insert:

```json
    "@morndo/fleet-client": "0.0.0",
```

Run: `npm install`
Expected: `up to date` or `added 1 package`; `ls -l node_modules/@morndo/fleet-client` shows a link to `../../packages/fleet-client`. `package-lock.json` gains exactly three things:
- `"@morndo/fleet-client": "0.0.0"` under `apps/hub`;
- a `node_modules/@morndo/fleet-client` link entry;
- a `packages/fleet-client` entry with its `@morndo/protocol`, `ws` and `@types/ws`.

No external package is added.

`apps/hub/src/main.ts`. The hub passes its own logger:

Replace line 31:

```ts
import { FleetClient, checkFleet } from "./adapters/fleet-client.ts";
```

with:

```ts
import { FleetClient, checkFleet } from "@morndo/fleet-client";
```

Replace line 240:

```ts
  const client = new FleetClient(socket);
```

with:

```ts
  const client = new FleetClient(socket, { log });
```

`apps/hub/src/adapters/fleet-adapters.ts`:

Replace line 18:

```ts
import { FleetOpFailed, FleetUnavailable, type FleetClient, type FleetEvent, type FleetLane, type NodeStatus, type OpAnswer } from "./fleet-client.ts";
```

with:

```ts
import { FleetOpFailed, FleetUnavailable, type FleetClient, type FleetEvent, type FleetLane, type NodeStatus, type OpAnswer } from "@morndo/fleet-client";
```

The root's own importers (`test/` and `e2e/` import packages by path, as `test/fleet-harness.ts` does the protocol):

Replace line 25:

```ts
import { FleetClient } from "../apps/hub/src/adapters/fleet-client.ts";
```

with:

```ts
import { FleetClient } from "../packages/fleet-client/src/index.ts";
```

Replace line 19:

```ts
import { FleetClient } from "../apps/hub/src/adapters/fleet-client.ts";
```

with:

```ts
import { FleetClient } from "../packages/fleet-client/src/index.ts";
```

Replace line 9:

```ts
import { FleetClient } from "../../apps/hub/src/adapters/fleet-client.ts";
```

with:

```ts
import { FleetClient } from "../../packages/fleet-client/src/index.ts";
```

- [ ] **Step 6: Wire the package into the checks**

`package.json`, the `check` script:

Replace line 14:

```json
    "check": "tsc -p packages/domain && tsc -p packages/protocol && tsc -p packages/node-ops && tsc -p packages/service-kit && tsc -p packages/brand && tsc -p apps/hub && npm run typecheck --workspaces --if-present && tsc -p tsconfig.tests.json && tsc -p tsconfig.web-tests.json && npm run check -w @morndo/web",
```

with:

```json
    "check": "tsc -p packages/domain && tsc -p packages/protocol && tsc -p packages/node-ops && tsc -p packages/service-kit && tsc -p packages/fleet-client && tsc -p packages/brand && tsc -p apps/hub && npm run typecheck --workspaces --if-present && tsc -p tsconfig.tests.json && tsc -p tsconfig.web-tests.json && npm run check -w @morndo/web",
```

`.oxlintrc.json`, the second override's `"files"` (the package logs through its `FleetLog`, never `console`):

After line 46 (`"packages/node-ops/src/**",`), insert:

```json
        "packages/fleet-client/src/**",
```

- [ ] **Step 7: Prove it is a pure move**

Run: `npm run check`, then `npm run lint`
Expected: exit 0, `0 ERRORS 0 WARNINGS`; no lint problems.

Run: `npx vitest run --project units packages apps/hub`
Expected: `Test Files` = Step 1's + 1 and `Tests` = Step 1's + 2, with the same failures as Step 1. The +1 file and the +2 tests are the architecture test's; the moved files only changed folders. At `12c2811` on 2026-10-09: 141 files, 1163 tests.

- [ ] **Step 8: Point the moved client's negative controls at its new files**

In `scripts/negative-controls.ts`:
- in every entry, replace `file: "apps/hub/src/adapters/fleet-client.ts"` with `file: "packages/fleet-client/src/fleet-client.ts"` (12 entries: `t14-client-*`, `t14a-file-*`, `t14a-5xx-not-op`, `t14a-op-*`, `b3-v13-ipc-url`, `pr12-unknown-op-error-code`);
- replace `"apps/hub/test/fleet-client.test.ts"` with `"packages/fleet-client/test/fleet-client.test.ts"` (11 entries);
- replace `"apps/hub/test/fleet-unknown-error-code.test.ts"` with `"packages/fleet-client/test/unknown-error-code.test.ts"` (1 entry).

Run: `node scripts/negative-controls.ts --check | grep -v '^ok'`
Expected: no output.

- [ ] **Step 9: Commit the move**

```bash
git add -A packages/fleet-client apps/hub/src/adapters/fleet-client.ts   # the moved tests' old paths are staged by git mv already; naming them again fails the whole add
git add apps/hub/src/main.ts apps/hub/src/adapters/fleet-adapters.ts apps/hub/package.json package.json package-lock.json .oxlintrc.json test/fleet-harness.ts e2e/fleet-qa.ts test/fleet/upload-retry-expired.test.ts scripts/negative-controls.ts
git commit -m "refactor(fleet-client): move the fleet client out of the hub into packages/fleet-client"
```

- [ ] **Step 10: Write the failing tests of the additions**

Create `packages/fleet-client/test/deliveries.test.ts`:

```ts
// The fleet client's additions for fleet clients (docs/design/fleet-clients/README.md §8; plan.md Contracts,
// "packages/fleet-client" and "Client API routes"): its name, the capabilities' sticky lanes, deliveries, lane events, and
// the delivery and lane events. Against a stub of those routes on a real Unix socket (the fleet's own come with Tasks 8
// and 9): it answers each request as the Contracts' table says and records what it was asked. Synthetic data only.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { Alert, Delivery, LaneEvent } from "@morndo/protocol";
import { FleetClient, FleetMismatch, FleetOpFailed, FleetUnavailable, type FleetEvent } from "../src/index.ts";

type Seen = { method: string; path: string; client: string; body: unknown };
type Answer = { status: number; body: unknown } | { status: number; raw: string };
let dir: string;
let seen: Seen[];
let answer: (s: Seen) => Answer | "hangup";
let frames: unknown[];
let close: () => Promise<void>;

const D: Delivery = { id: "hub:answer:e1:t1:option:1", node: "pc", target: { lane: "manager" }, state: "queued", queuedAt: 1_791_460_800_000, notAfter: 1_791_547_200_000 };
const E: LaneEvent = { v: 1, t: "lane", seq: 7, event: "finished", node: "pc", window: "api", lane: "api", sessionId: "s1", at: 1_791_460_801_000, status: "done", firstLine: "STATUS: DONE", bg: 0, crons: 0 };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-client-"));
  seen = [];
  frames = [];
  answer = () => ({ status: 404, body: { error: "no such route" } });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const s: Seen = { method: req.method ?? "", path: req.url ?? "", client: String(req.headers["x-morndo-client"] ?? ""), body: text ? JSON.parse(text) : null };
      seen.push(s);
      const a = answer(s);
      if (a === "hangup") { req.socket.destroy(); return; }               // the request arrived, and no answer leaves
      res.writeHead(a.status, { "content-type": "application/json" });
      res.end("raw" in a ? a.raw : JSON.stringify(a.body));
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
    seen.push({ method: "WS", path: req.url ?? "", client: String(req.headers["x-morndo-client"] ?? ""), body: null });
    for (const f of frames) ws.send(JSON.stringify(f));
  }));
  await new Promise<void>(resolve => server.listen(join(dir, "fleet.sock"), () => resolve()));
  close = async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  };
});
afterEach(async () => {
  await close();
  rmSync(dir, { recursive: true, force: true });
});
const client = (o?: { client?: string }) => new FleetClient(join(dir, "fleet.sock"), o);
async function until(f: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error(`not within ${ms} ms`); await new Promise(r => setTimeout(r, 20)); }
}

describe("the client's name (§8)", () => {
  it("is hub unless given, and every request carries it: reads, a delivery, the events socket", async () => {
    answer = s => (s.path === "/v1/caps" ? { status: 200, body: { api: [1] } } : { status: 200, body: { ok: true, delivery: D } });
    await client().caps();
    const kira = client({ client: "kira" });
    await kira.caps();
    await kira.deliver({ id: "kira:tg:1:42", lane: "manager", text: "hi" });
    const stop = kira.events(() => {});
    await until(() => seen.some(s => s.method === "WS"));
    stop();
    expect(seen.map(s => `${s.method} ${s.client}`)).toEqual(["GET hub", "GET kira", "POST kira", "WS kira"]);
  });
  it("a name that isn't a-z, at most 16 letters, is refused at once (negative control)", () => {
    for (const name of ["", "Kira", "kira!", "k-1", "abcdefghijklmnopq", "hub\r\nx-evil: 1"]) expect(() => client({ client: name }), JSON.stringify(name)).toThrow(TypeError);
    expect(() => client({ client: "abcdefghijklmnop" })).not.toThrow();
  });
});

describe("the capabilities (§8, Review Focus 5)", () => {
  it("list the sticky lanes; a fleet from before them makes none sticky", async () => {
    answer = () => ({ status: 200, body: { api: [1], stickyLanes: ["manager"] } });
    expect(await client().caps()).toEqual({ api: [1], stickyLanes: ["manager"] });
    answer = () => ({ status: 200, body: { api: [1] } });
    expect(await client().caps()).toEqual({ api: [1], stickyLanes: [] });
  });
  it("sticky lanes that aren't a list of names are a mismatch (negative control)", async () => {
    for (const stickyLanes of ["manager", [1], null]) {
      answer = () => ({ status: 200, body: { api: [1], stickyLanes } });
      await expect(client().caps(), JSON.stringify(stickyLanes)).rejects.toBeInstanceOf(FleetMismatch);
    }
  });
});

describe("deliver (POST /v1/deliveries)", () => {
  it("posts the id, the lane or the worker ID, the text and the duration, and answers the stored delivery", async () => {
    answer = () => ({ status: 200, body: { ok: true, delivery: D } });
    expect(await client().deliver({ id: D.id, lane: "manager", text: "Answer: ship it", ttlMs: 60_000 })).toEqual(D);
    await client().deliver({ id: "lanes:k1", workerId: "pc.3fa2c1d0.12", text: "hi" });
    expect(seen.map(s => [s.method, s.path, s.body])).toEqual([
      ["POST", "/v1/deliveries", { id: D.id, lane: "manager", text: "Answer: ship it", ttlMs: 60_000 }],
      ["POST", "/v1/deliveries", { id: "lanes:k1", workerId: "pc.3fa2c1d0.12", text: "hi" }],
    ]);
  });
  it("a refusal throws FleetOpFailed with the fleet's error, whatever the status", async () => {
    for (const [status, code] of [[409, "id_conflict"], [409, "lane_conflict"], [409, "no_session"], [404, "no_pane"], [503, "node_offline"], [400, "bad_args"]] as const) {
      answer = () => ({ status, body: { ok: false, error: { code, executed: "no", message: code } } });
      const e = await client().deliver({ id: "hub:x", lane: "manager", text: "t" }).catch((x: unknown) => x);
      expect(e, code).toBeInstanceOf(FleetOpFailed);
      expect((e as FleetOpFailed).error, code).toEqual({ code, executed: "no", message: code });
    }
  });
  it("an answer that isn't a delivery's leaves it in doubt: FleetUnavailable, reached; the same id may be sent again (negative control)", async () => {
    for (const a of [{ status: 200, body: { ok: true } }, { status: 200, body: { ok: true, delivery: { ...D, state: "lost" } } }, { status: 502, raw: "<html>bad gateway</html>" }] as Answer[]) {
      answer = () => a;
      const e = await client().deliver({ id: "hub:x", lane: "manager", text: "t" }).catch((x: unknown) => x);
      expect(e, JSON.stringify(a).slice(0, 50)).toBeInstanceOf(FleetUnavailable);
      expect((e as FleetUnavailable).reached).toBe(true);
    }
  });
  it("no socket: FleetUnavailable, not reached: nothing was queued", async () => {
    const e = await new FleetClient(join(dir, "missing.sock")).deliver({ id: "hub:x", lane: "manager", text: "t" }).catch((x: unknown) => x);
    expect((e as FleetUnavailable).reached).toBe(false);
  });
  it("an uncertain refusal is the fleet's own word that it may have run: FleetOpFailed, executed maybe", async () => {
    answer = () => ({ status: 200, body: { ok: false, error: { code: "uncertain", executed: "maybe", message: "the connection to the node dropped" } } });
    const e = await client().deliver({ id: "hub:x", lane: "manager", text: "t" }).catch((x: unknown) => x);
    expect((e as FleetOpFailed).error).toEqual({ code: "uncertain", executed: "maybe", message: "the connection to the node dropped" });
  });
});

describe("the delivery ops are never sent through op() (the fleet refuses them on /v1/op)", () => {
  it("op() throws for lane.deliver and delivery.cancel and sends nothing (negative control)", async () => {
    const c = client();
    await expect(c.op({ lane: "manager" }, "lane.deliver" as never, { id: "hub:x", target: { lane: "manager", sticky: true }, text: "t" } as never)).rejects.toThrow(TypeError);
    await expect(c.op({ node: "pc" }, "delivery.cancel" as never, { id: "hub:x" } as never)).rejects.toThrow("cancelDelivery");
    expect(seen).toEqual([]);
  });
});

describe("a delivery's state (GET /v1/deliveries)", () => {
  it("one by its id, the id one path segment however it's written; none is null", async () => {
    answer = s => (s.path.startsWith("/v1/deliveries/hub") ? { status: 200, body: { delivery: D, stale: true } } : { status: 404, body: { error: "no such delivery" } });
    expect(await client().delivery("hub:a/b ü#1")).toEqual({ ...D, stale: true });
    expect(seen[0]?.path).toBe("/v1/deliveries/hub%3Aa%2Fb%20%C3%BC%231");
    expect(await client().delivery("kira:gone")).toBeNull();
  });
  it("the list, by lane and state, each with whether its node is offline", async () => {
    answer = () => ({ status: 200, body: { deliveries: [{ ...D, stale: false }] } });
    expect(await client().deliveries({ lane: "fix: a/b", state: "queued" })).toEqual([{ ...D, stale: false }]);
    expect(await client().deliveries()).toEqual([{ ...D, stale: false }]);
    expect(seen.map(s => s.path)).toEqual(["/v1/deliveries?lane=fix%3A+a%2Fb&state=queued", "/v1/deliveries"]);
  });
  it("an answer of another shape is a mismatch, a 5xx is unavailable (negative controls)", async () => {
    for (const body of [{ delivery: D }, { delivery: { ...D, target: {} }, stale: false }, []]) {
      answer = () => ({ status: 200, body });
      await expect(client().delivery("hub:x"), JSON.stringify(body).slice(0, 40)).rejects.toBeInstanceOf(FleetMismatch);
    }
    answer = () => ({ status: 200, body: { deliveries: [D] } });
    await expect(client().deliveries()).rejects.toBeInstanceOf(FleetMismatch);
    answer = () => ({ status: 500, body: { error: "internal error" } });
    await expect(client().delivery("hub:x")).rejects.toBeInstanceOf(FleetUnavailable);
  });
});

describe("in doubt: the request went out and no answer came (ruling 49)", () => {
  const calls = (c: FleetClient) => [() => c.deliver({ id: "hub:x", lane: "manager", text: "t" }), () => c.cancelDelivery("hub:x"), () => c.delivery("hub:x")];
  it("deliver, cancelDelivery and delivery: the connection dropped after the request is FleetUnavailable, reached (negative control)", async () => {
    answer = () => "hangup";
    for (const call of calls(client())) {
      const e = await call().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(FleetUnavailable);
      expect((e as FleetUnavailable).reached).toBe(true);
    }
    expect(seen.map(s => s.method)).toEqual(["POST", "POST", "GET"]);
  });
  it("nothing left this process (no socket there): FleetUnavailable, not reached, for each", async () => {
    for (const call of calls(new FleetClient(join(dir, "missing.sock")))) {
      const e = await call().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(FleetUnavailable);
      expect((e as FleetUnavailable).reached).toBe(false);
    }
  });
});

describe("cancelDelivery (POST /v1/deliveries/<id>/cancel)", () => {
  it("answers the delivery given up; one already typed is refused already_typed", async () => {
    const cancelled: Delivery = { ...D, state: "given_up", why: "cancelled" };
    answer = () => ({ status: 200, body: { ok: true, delivery: cancelled } });
    expect(await client().cancelDelivery("hub:a/b")).toEqual(cancelled);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/v1/deliveries/hub%3Aa%2Fb/cancel" });
    answer = () => ({ status: 409, body: { ok: false, error: { code: "already_typed", executed: "no", message: "typed already" } } });
    const e = await client().cancelDelivery("hub:x").catch((x: unknown) => x);
    expect((e as FleetOpFailed).error.code).toBe("already_typed");
  });
  it("one the fleet doesn't know is null, as delivery(id) answers; another 404 leaves it in doubt (negative control)", async () => {
    answer = () => ({ status: 404, body: { error: "no_such_delivery" } });
    expect(await client().cancelDelivery("kira:gone")).toBeNull();
    answer = () => ({ status: 404, body: { error: "no such route" } });
    const e = await client().cancelDelivery("kira:gone").catch((x: unknown) => x);
    expect((e as FleetUnavailable).reached).toBe(true);
  });
});

describe("lane events (GET /v1/lane-events)", () => {
  it("reads on from a sequence, oldest first", async () => {
    answer = () => ({ status: 200, body: { events: [E, { ...E, seq: 8, event: "answered", status: undefined }] } });
    expect((await client().laneEvents(7)).map(e => [e.seq, e.event])).toEqual([[7, "finished"], [8, "answered"]]);
    await client().laneEvents();
    expect(seen.map(s => s.path)).toEqual(["/v1/lane-events?since=7", "/v1/lane-events"]);
  });
  it("an event of another shape is a mismatch (negative control)", async () => {
    answer = () => ({ status: 200, body: { events: [{ ...E, event: "started" }] } });
    await expect(client().laneEvents()).rejects.toBeInstanceOf(FleetMismatch);
  });
});

describe("the events socket: deliveries, lane events and the new alerts", () => {
  it("passes on a delivery's state and a lane event with their bodies checked, and leaves out a malformed one (negative control)", async () => {
    frames = [
      { t: "delivery", node: "pc", body: { ...D, state: "delivered", deliveredAt: 2, stale: false } },
      { t: "delivery", node: "pc", body: { ...D, state: "lost", stale: false } },
      { t: "lane", node: "pc", body: E },
      { t: "lane", node: "pc", body: { ...E, seq: 0 } },
      { t: "status", node: "pc", body: { status: "online" } },
    ];
    const got: FleetEvent[] = [];
    const warned: string[] = [];
    const stop = new FleetClient(join(dir, "fleet.sock"), { log: { warn: m => warned.push(m), error: m => warned.push(m) } }).events(e => got.push(e));
    await until(() => got.some(e => e.t === "status"));
    stop();
    expect(got).toEqual([
      { t: "delivery", node: "pc", body: { ...D, state: "delivered", deliveredAt: 2, stale: false } },
      { t: "lane", node: "pc", body: E },
      { t: "status", node: "pc", body: { status: "online" } },
    ]);
    expect(warned).toHaveLength(2);
  });
  it("keeps the alerts delivery_waiting and subscriber_lagging", async () => {
    const waiting: Alert = { id: 1, at: 1, node: "pc", kind: "delivery_waiting", detail: { id: D.id, state: "queued", reason: "menu_open", minutes: 2 } };
    const lagging: Alert = { id: 2, at: 2, node: null, kind: "subscriber_lagging", detail: { subscriber: "kira", oldestMs: 61_000 } };
    answer = () => ({ status: 200, body: [waiting, lagging] });
    expect(await client().alerts()).toEqual([waiting, lagging]);
  });
});
```

In `packages/fleet-client/test/fleet-client.test.ts`, the capabilities now carry the sticky lanes:

Replace line 37:

```ts
    expect(await c.caps()).toEqual({ api: [1] });
```

with:

```ts
    expect(await c.caps()).toEqual({ api: [1], stickyLanes: [] });                 // the fake fleet sends no sticky lanes
```

- [ ] **Step 11: Run them to see them fail**

Run: `npx vitest run packages/fleet-client`
Expected: FAIL, 22 failed and 27 passed. Among them: `TypeError: client(...).deliver is not a function`, `….laneEvents is not a function`, `….delivery is not a function`, and `promise resolved "{ api: [ 1 ] }" instead of rejecting`.

- [ ] **Step 12: The additions, in `packages/fleet-client/src/fleet-client.ts`**

`op()` now uses the same `#outcome` as the delivery routes, so a side effect's answer is read one way:
- its refusal in the body whatever the status;
- an answer that isn't JSON leaves it in doubt.

Before, `#json` read `/v1/op` differently by its path.

Replace line 14:

```ts
// request names this client (`x-morndo-client: hub`), which the fleet's audit records with each op it sends to a node.
```

with:

```ts
// request names this client (`x-morndo-client`, "hub" unless the caller names another, §8), which the fleet's audit
// records with each op it sends to a node and each delivery.
```

Replace line 20:

```ts
  CLIENT_API, readOpError, redactText, toLogFormat, type Alert, type AlertKind, type Health, type OpArgs, type OpError, type OpName, type OpResult,
```

with:

```ts
  CLIENT_API, DeliverySchema, LaneEventSchema, parseBody, readOpError, redactText, toLogFormat, type Alert, type AlertKind, type Delivery,
  type DeliveryState, type Health, type LaneEvent, type OpArgs, type OpError, type OpName, type OpResult,
```

Replace lines 33–35:

```ts
// `alert`: its body is an Alert, and `node` is the alert's node or "".
export type FleetEvent = { t: "inventory" | "health" | "status" | "conflict" | "alert"; node: string; body: unknown };
export type OpTarget = { workerId: string } | { node: string } | { lane: string };
```

with:

```ts
// `alert`: its body is an Alert, and `node` is the alert's node or "". `delivery` and `lane` (fleet clients §4.4, §7):
// their bodies are checked here, so they come typed.
export type FleetEvent = { t: "inventory" | "health" | "status" | "conflict" | "alert"; node: string; body: unknown }
  | { t: "delivery"; node: string; body: Delivery & { stale: boolean } }
  | { t: "lane"; node: string; body: LaneEvent };
// A delivery as the fleet serves it: its latest state, and whether its node is offline now (stale).
export type FleetDelivery = Delivery & { stale: boolean };
export type OpTarget = { workerId: string } | { node: string } | { lane: string };
// The ops a client sends through op(): every op but the two of the delivery queue.
export type ClientOp = Exclude<OpName, "lane.deliver" | "delivery.cancel">;
const DELIVERY_OPS = new Set<string>(["lane.deliver", "delivery.cancel"]);
```

Replace line 74:

```ts
const CLIENT = { "x-morndo-client": "hub" };
```

with:

```ts
// A client's name (§8): a-z, at most 16 letters. Not a credential (the socket's directory is the boundary), but checked
// here, so a header never carries anything else.
const CLIENT_NAME = /^[a-z]{1,16}$/;
```

Replace lines 78–81:

```ts
const EVENTS = new Set<string>(["inventory", "health", "status", "conflict", "alert"]);
// "unrouted_hook": hook events for a script path no subscriber takes (ADR-0012 decision 8; detail { path, events }).
const ALERT_KINDS = new Set<string>(["instance_conflict", "source_changed", "clock_offset", "rate_limited", "lane_conflict", "dead_letter",
  "backlog_full", "unrouted_hook"] satisfies AlertKind[]);
```

with:

```ts
const EVENTS = new Set<string>(["inventory", "health", "status", "conflict", "alert", "delivery", "lane"]);
// "unrouted_hook": hook events for a script path no subscriber takes (ADR-0012 decision 8; detail { path, events }).
// "delivery_waiting" and "subscriber_lagging": fleet clients §4.5, §6.
const ALERT_KINDS = new Set<string>(["instance_conflict", "source_changed", "clock_offset", "rate_limited", "lane_conflict", "dead_letter",
  "backlog_full", "unrouted_hook", "delivery_waiting", "subscriber_lagging"] satisfies AlertKind[]);
```

After line 100 (`&& typeof v.kind === "string" && isRecord(v.detail);`), insert:

```ts
// A delivery with its `stale` (the fleet's word on its node), or null when it isn't one.
const fleetDelivery = (delivery: unknown, stale: unknown): FleetDelivery | null => {
  const d = parseBody(DeliverySchema, delivery);
  return d && typeof stale === "boolean" ? { ...d, stale } : null;
};
const seg = (s: string) => encodeURIComponent(s);
```

Replace lines 105–114:

```ts

  constructor(socketPath: string, o: { log?: FleetLog } = {}) {
    this.#socketPath = socketPath;
    this.#log = o.log ?? STDERR_LOG;
  }

  async caps(): Promise<{ api: number[] }> {
    const v = await this.#json("GET", "/v1/caps");
    if (!isRecord(v) || !Array.isArray(v.api) || !v.api.every(n => Number.isInteger(n))) throw new FleetMismatch("GET /v1/caps: not a capability list");
    return { api: v.api as number[] };
```

with:

```ts
  readonly #headers: Record<string, string>;

  // `client`: the name this client gives the fleet (x-morndo-client), "hub" unless given; one that isn't a-z, at most 16
  // letters, throws TypeError.
  constructor(socketPath: string, o: { client?: string; log?: FleetLog } = {}) {
    const client = o.client ?? "hub";
    if (!CLIENT_NAME.test(client)) throw new TypeError(`a client name is a-z, at most 16 letters: ${JSON.stringify(client)}`);
    this.#socketPath = socketPath;
    this.#log = o.log ?? STDERR_LOG;
    this.#headers = { "x-morndo-client": client };
  }

  // The API versions the fleet takes, and its sticky lane names (fleet clients §4.1, Review Focus 5). A fleet from before
  // sticky lanes sends none: it makes no lane sticky.
  async caps(): Promise<{ api: number[]; stickyLanes: string[] }> {
    const v = await this.#json("GET", "/v1/caps");
    if (!isRecord(v) || !Array.isArray(v.api) || !v.api.every(n => Number.isInteger(n))) throw new FleetMismatch("GET /v1/caps: not a capability list");
    const sticky = v.stickyLanes === undefined ? [] : v.stickyLanes;
    if (!Array.isArray(sticky) || !sticky.every(n => typeof n === "string")) throw new FleetMismatch("GET /v1/caps: stickyLanes is not a list of lane names");
    return { api: v.api as number[], stickyLanes: sticky as string[] };
```

Replace lines 137–145:

```ts
  // One typed op (spec §5.3). The result's fields are checked by whoever reads them; the envelope is checked here.
  async op<O extends OpName>(target: OpTarget, op: O, args: OpArgs[O], opts: { key?: string; timeoutMs?: number } = {}): Promise<OpAnswer<O>> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const body = { ...target, op, args, timeoutMs, ...(opts.key !== undefined ? { key: opts.key } : {}) };
    // The fleet took the op, so an answer that isn't JSON at all (an HTML 502, say) leaves it in doubt as well.
    const v = await this.#json("POST", "/v1/op", body, timeoutMs + ANSWER_SLACK_MS).catch((e: unknown) => {
      if (e instanceof FleetMismatch) throw new FleetUnavailable(e.message, true, { cause: e });
      throw e;
    });
```

with:

```ts
  // One typed op (spec §5.3). The result's fields are checked by whoever reads them; the envelope is checked here. The
  // delivery ops are never sent as ops: they go through deliver() and cancelDelivery(), whose routes resolve the target
  // and keep the fleet's mirror, and the fleet refuses them on /v1/op (bad_args).
  async op<O extends ClientOp>(target: OpTarget, op: O, args: OpArgs[O], opts: { key?: string; timeoutMs?: number } = {}): Promise<OpAnswer<O>> {
    if (DELIVERY_OPS.has(op)) throw new TypeError(`${op} goes through deliver() or cancelDelivery(), never POST /v1/op`);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const body = { ...target, op, args, timeoutMs, ...(opts.key !== undefined ? { key: opts.key } : {}) };
    // The fleet took the op, so an answer that isn't JSON at all (an HTML 502, say) leaves it in doubt as well (#outcome).
    const v = (await this.#outcome("POST", "/v1/op", body, timeoutMs + ANSWER_SLACK_MS)).value;
```

After line 156 (``), insert:

```ts
  // A message to a lane through the delivery queue on its node (fleet clients §4, §8): the delivery once stored. Its id is
  // the client's own, namespaced like a key ("kira:…"), and its idempotency: the same id with the same target and text
  // answers the same delivery. No answer throws FleetUnavailable: `reached: false` when nothing left this process (nothing
  // was queued); `reached: true` when the request went out and no answer came, so the delivery is in doubt, and the caller
  // sends the same id again, never types the text itself (ruling 49). A refusal (lane_conflict, node_offline,
  // id_conflict, no_session, no_pane, bad_args) throws FleetOpFailed; nothing was queued. `uncertain` is the fleet's own
  // word that it may have been: in doubt as well.
  async deliver(d: { id: string; text: string; ttlMs?: number } & ({ lane: string } | { workerId: string })): Promise<Delivery> {
    const body = { id: d.id, ...("lane" in d ? { lane: d.lane } : { workerId: d.workerId }), text: d.text, ...(d.ttlMs === undefined ? {} : { ttlMs: d.ttlMs }) };
    return this.#delivered("deliver", (await this.#outcome("POST", "/v1/deliveries", body)).value);
  }

  // One delivery's latest state as the fleet keeps it, or null when it knows none of that id.
  async delivery(id: string): Promise<FleetDelivery | null> {
    const { status, value } = await this.#request("GET", `/v1/deliveries/${seg(id)}`);
    if (status === 404) return null;
    const d = isRecord(value) ? fleetDelivery(value.delivery, value.stale) : null;
    if (!d) throw new FleetMismatch("GET /v1/deliveries/<id>: not a delivery");
    return d;
  }

  // The deliveries of the last 7 days, by lane and state.
  async deliveries(q: { lane?: string; state?: DeliveryState } = {}): Promise<FleetDelivery[]> {
    const query = new URLSearchParams({ ...(q.lane === undefined ? {} : { lane: q.lane }), ...(q.state === undefined ? {} : { state: q.state }) }).toString();
    const v = await this.#json("GET", `/v1/deliveries${query ? `?${query}` : ""}`);
    const list = isRecord(v) && Array.isArray(v.deliveries) ? v.deliveries.map(x => (isRecord(x) ? fleetDelivery(x, x.stale) : null)) : null;
    if (!list || list.some(x => x === null)) throw new FleetMismatch("GET /v1/deliveries: not a delivery list");
    return list as FleetDelivery[];
  }

  // Gives up a delivery still queued; one already typed is refused already_typed (FleetOpFailed). null: the fleet knows
  // no delivery of that id (404 no_such_delivery), as delivery(id) answers.
  async cancelDelivery(id: string): Promise<Delivery | null> {
    const { status, value } = await this.#outcome("POST", `/v1/deliveries/${seg(id)}/cancel`, {});
    if (status === 404 && isRecord(value) && value.error === "no_such_delivery") return null;
    return this.#delivered("cancelDelivery", value);
  }

  // Lane events (fleet clients §7) after the sequence `since` (the fleet's own), oldest first, at most 1000 per answer.
  async laneEvents(since?: number): Promise<LaneEvent[]> {
    const v = await this.#json("GET", `/v1/lane-events${since === undefined ? "" : `?since=${since}`}`);
    const events = isRecord(v) && Array.isArray(v.events) ? v.events.map(e => parseBody(LaneEventSchema, e)) : null;
    if (!events || events.some(e => e === null)) throw new FleetMismatch("GET /v1/lane-events: not a list of lane events");
    return events as LaneEvent[];
  }
```

Replace line 161:

```ts
      const req = request({ socketPath: this.#socketPath, agent: false, method: "GET", path, headers: CLIENT }, resolve);
```

with:

```ts
      const req = request({ socketPath: this.#socketPath, agent: false, method: "GET", path, headers: this.#headers }, resolve);
```

Replace line 218:

```ts
      const ws = new WebSocket("ws://fleet/v1/events", { maxPayload: MAX_ANSWER_BYTES, headers: CLIENT, createConnection: () => createConnection(this.#socketPath) });
```

with:

```ts
      const ws = new WebSocket("ws://fleet/v1/events", { maxPayload: MAX_ANSWER_BYTES, headers: this.#headers, createConnection: () => createConnection(this.#socketPath) });
```

Replace lines 231–232:

```ts
        try { on({ t: v.t as FleetEvent["t"], node: v.node, body: v.body }); }
        catch (e) { this.#log.error("fleet events: a listener failed", e); }
```

with:

```ts
        let e: FleetEvent;
        if (v.t === "delivery" || v.t === "lane") {
          const body = v.t === "delivery" ? (isRecord(v.body) ? fleetDelivery(v.body, v.body.stale) : null) : parseBody(LaneEventSchema, v.body);
          if (!body) { this.#log.warn(`fleet events: a ${v.t} event of an unknown shape, ignored`); return; }
          e = v.t === "delivery" ? { t: "delivery", node: v.node, body: body as FleetDelivery } : { t: "lane", node: v.node, body: body as LaneEvent };
        } else {
          e = { t: v.t as "inventory" | "health" | "status" | "conflict" | "alert", node: v.node, body: v.body };
        }
        try { on(e); }
        catch (x) { this.#log.error("fleet events: a listener failed", x); }
```

Replace lines 251–252:

```ts
  // A JSON request. The client API puts the outcome in the body whatever the status, so any status is read.
  #json(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
```

with:

```ts
  // A side effect's answer (POST /v1/op, the delivery routes): its outcome is in the body whatever the status, and the
  // fleet took the request, so an answer that isn't JSON at all (an HTML 502, say) leaves it in doubt as well.
  async #outcome(method: "POST", path: string, body: unknown, timeoutMs = DEFAULT_TIMEOUT_MS + ANSWER_SLACK_MS): Promise<{ status: number; value: unknown }> {
    try { return await this.#request(method, path, body, timeoutMs, true); }
    catch (e) {
      if (e instanceof FleetMismatch) throw new FleetUnavailable(e.message, true, { cause: e });
      throw e;
    }
  }

  // The delivery a delivery route answers with, or its refusal thrown as FleetOpFailed; anything else leaves it in doubt.
  #delivered(what: string, v: unknown): Delivery {
    const d = isRecord(v) && v.ok === true ? parseBody(DeliverySchema, v.delivery) : null;
    if (d) return d;
    const error = isRecord(v) && v.ok === false ? opErrorOf(v.error) : null;
    if (error) throw new FleetOpFailed(what, error);
    throw new FleetUnavailable(`${what}: not a delivery answer`, true);
  }

  // A JSON request's body. A read route's 5xx is the fleet failing (FleetUnavailable).
  async #json(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    return (await this.#request(method, path, body, timeoutMs)).value;
  }

  // A JSON request: its status and its body. `outcome`: a route whose refusals carry their outcome in the body, read
  // whatever the status; any other route's 5xx is FleetUnavailable.
  #request(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS, outcome = false): Promise<{ status: number; value: unknown }> {
```

Replace line 257:

```ts
        headers: data ? { ...CLIENT, "content-type": "application/json", "content-length": String(data.length) } : CLIENT,
```

with:

```ts
        headers: data ? { ...this.#headers, "content-type": "application/json", "content-length": String(data.length) } : this.#headers,
```

Replace lines 267–269:

```ts
          if ((res.statusCode ?? 200) >= 500 && path !== "/v1/op") {    // an op's refusal carries its outcome in the body, whatever the status
            reject(new FleetUnavailable(`${method} ${path}: answered ${res.statusCode}`, true)); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
```

with:

```ts
          if ((res.statusCode ?? 200) >= 500 && !outcome) {            // a side effect's refusal carries its outcome in the body, whatever the status
            reject(new FleetUnavailable(`${method} ${path}: answered ${res.statusCode}`, true)); return; }
          try { resolve({ status: res.statusCode ?? 200, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
```

- [ ] **Step 13: Run them, the hub and the type checks**

Run: `npx vitest run packages/fleet-client`
Expected: PASS, 4 files, 49 tests.

Run: `npx tsc -p packages/fleet-client && npx tsc -p apps/hub && npx tsc -p tsconfig.tests.json`, then `npx vitest run --project units apps/hub`
Expected: no type errors. The hub's suite passes as before: its `NodeView.apply` reads the new event kinds as before and ignores them.

Then make each change alone in `fleet-client.ts`, run `npx vitest run packages/fleet-client/test/deliveries.test.ts`, see the failure, and restore the line. These are Step 14's entries:
- the name check: change `if (!CLIENT_NAME.test(client)) throw new TypeError(` to `if (false) throw new TypeError(`. Expected: a failure in "… is refused at once (negative control)".
- the sticky lanes' check: change `if (!Array.isArray(sticky) || !sticky.every(n => typeof n === "string")) throw new FleetMismatch(` to `if (false) throw new FleetMismatch(`. Expected: `promise resolved "{ api: [ 1 ], stickyLanes: 'manager' }" instead of rejecting`.
- the events' bodies: make the `if (!body)` line pass the frame on instead of warning. Expected: a failure in "… leaves out a malformed one (negative control)".
- a refusal read whatever its status: change `#outcome`'s `this.#request(method, path, body, timeoutMs, true)` to `…, false)`. Expected: `node_offline: expected FleetUnavailable: … to be an instance of FleetOpFailed`.
- a delivery's shape: change `parseBody(DeliverySchema, v.delivery)` in `#delivered` to `(v.delivery as Delivery)`. Expected: `… to be an instance of FleetUnavailable`.
- the id as one segment: change `seg` to `(s: string) => s`. Expected: `TypeError: Request path contains unescaped characters`, in "… one path segment …".
- an unknown delivery: delete `if (status === 404) return null;`. Expected: a failure in "… none is null".
- lane events' shape: change `if (!events || events.some(e => e === null))` to `if (!events)`. Expected: `promise resolved "[ null ]" instead of rejecting`.
- the alert kinds: drop `"delivery_waiting", "subscriber_lagging"` from `ALERT_KINDS`. Expected: `expected [] to deeply equal [ …(2) ]`.
- no delivery ops through `op()`: change `if (DELIVERY_OPS.has(op)) throw new TypeError(` to `if (false) throw new TypeError(`. Expected: a failure in "op() throws for lane.deliver and delivery.cancel and sends nothing (negative control)".
- an unknown delivery to cancel: delete the line `if (status === 404 && isRecord(value) && value.error === "no_such_delivery") return null;`. Expected: a failure in "one the fleet doesn't know is null, …".
- in doubt is reached: in `#request`'s error handler, change `!NOT_SENT.has(e.code ?? "")` to `false`. Expected: a failure in "… the connection dropped after the request is FleetUnavailable, reached (negative control)".

- [ ] **Step 14: The negative controls, as data**

Step 12 changed the text of four moved entries. In `scripts/negative-controls.ts`:

`t14-client-no-alert-event` (`EVENTS` lists the two new kinds):

```ts
    find: "const EVENTS = new Set<string>([\"inventory\", \"health\", \"status\", \"conflict\", \"alert\"]);",
    replace: "const EVENTS = new Set<string>([\"inventory\", \"health\", \"status\", \"conflict\"]);",
```

becomes:

```ts
    find: "const EVENTS = new Set<string>([\"inventory\", \"health\", \"status\", \"conflict\", \"alert\", \"delivery\", \"lane\"]);",
    replace: "const EVENTS = new Set<string>([\"inventory\", \"health\", \"status\", \"conflict\", \"delivery\", \"lane\"]);",
```

`t14-client-no-name` (the header is the instance's):

```ts
    find: "const CLIENT = { \"x-morndo-client\": \"hub\" };",
    replace: "const CLIENT = {};",
```

becomes:

```ts
    find: "this.#headers = { \"x-morndo-client\": client };",
    replace: "this.#headers = {};",
```

`t14a-5xx-not-op` (a route's outcome is a parameter now, not its path):

```ts
    find: "          if ((res.statusCode ?? 200) >= 500 && path !== \"/v1/op\") {", replace: "          if (false) {",
```

becomes:

```ts
    find: "          if ((res.statusCode ?? 200) >= 500 && !outcome) {", replace: "          if (false) {",
```

`b3-v13-ipc-url` (the headers):

```ts
    find: "new WebSocket(\"ws://fleet/v1/events\", { maxPayload: MAX_ANSWER_BYTES, headers: CLIENT, createConnection: () => createConnection(this.#socketPath) });",
    replace: "new WebSocket(`ws+unix:${this.#socketPath}:/v1/events`, { maxPayload: MAX_ANSWER_BYTES, headers: CLIENT });",
```

becomes:

```ts
    find: "new WebSocket(\"ws://fleet/v1/events\", { maxPayload: MAX_ANSWER_BYTES, headers: this.#headers, createConnection: () => createConnection(this.#socketPath) });",
    replace: "new WebSocket(`ws+unix:${this.#socketPath}:/v1/events`, { maxPayload: MAX_ANSWER_BYTES, headers: this.#headers });",
```

After Task 2's `fc2-` entries, add:

```ts
  { id: "fc3-client-name-checked", task: "fc3", file: "packages/fleet-client/src/fleet-client.ts",
    find: "    if (!CLIENT_NAME.test(client)) throw new TypeError(", replace: "    if (false) throw new TypeError(",
    run: ["packages/fleet-client/test/deliveries.test.ts"], expect: "is refused at once" },
  { id: "fc3-caps-sticky-checked", task: "fc3", file: "packages/fleet-client/src/fleet-client.ts",
    find: '    if (!Array.isArray(sticky) || !sticky.every(n => typeof n === "string")) throw new FleetMismatch(', replace: "    if (false) throw new FleetMismatch(",
    run: ["packages/fleet-client/test/deliveries.test.ts"], expect: "instead of rejecting" },
  { id: "fc3-event-bodies-checked", task: "fc3", file: "packages/fleet-client/src/fleet-client.ts",
    find: "          if (!body) { this.#log.warn(`fleet events: a ${v.t} event of an unknown shape, ignored`); return; }",
    replace: "          if (!body) { on({ t: v.t, node: v.node, body: v.body } as FleetEvent); return; }",
    run: ["packages/fleet-client/test/deliveries.test.ts"], expect: "leaves out a malformed one" },
  { id: "fc3-deliver-any-status", task: "fc3", file: "packages/fleet-client/src/fleet-client.ts",
    find: "    try { return await this.#request(method, path, body, timeoutMs, true); }",
    replace: "    try { return await this.#request(method, path, body, timeoutMs, false); }",
    run: ["packages/fleet-client/test/deliveries.test.ts"], expect: "node_offline" },
  { id: "fc3-delivered-checked", task: "fc3", file: "packages/fleet-client/src/fleet-client.ts",
    find: "    const d = isRecord(v) && v.ok === true ? parseBody(DeliverySchema, v.delivery) : null;", replace: "    const d = isRecord(v) && v.ok === true ? (v.delivery as Delivery) : null;",
    run: ["packages/fleet-client/test/deliveries.test.ts"], expect: "to be an instance of FleetUnavailable" },
  { id: "fc3-id-one-segment", task: "fc3", file: "packages/fleet-client/src/fleet-client.ts",
    find: "const seg = (s: string) => encodeURIComponent(s);", replace: "const seg = (s: string) => s;",
    run: ["packages/fleet-client/test/deliveries.test.ts"], expect: "one path segment" },
  { id: "fc3-unknown-delivery-null", task: "fc3", file: "packages/fleet-client/src/fleet-client.ts",
    find: "    if (status === 404) return null;\n", replace: "",
    run: ["packages/fleet-client/test/deliveries.test.ts"], expect: "none is null" },
  { id: "fc3-cancel-unknown-null", task: "fc3", file: "packages/fleet-client/src/fleet-client.ts",
    find: '    if (status === 404 && isRecord(value) && value.error === "no_such_delivery") return null;\n', replace: "",
    run: ["packages/fleet-client/test/deliveries.test.ts"], expect: "one the fleet doesn't know is null" },
  { id: "fc3-in-doubt-reached", task: "fc3", file: "packages/fleet-client/src/fleet-client.ts",
    find: "reject(new FleetUnavailable(`${method} ${path}: ${e.message}`, !NOT_SENT.has(e.code ?? \"\"), { cause: e }))",
    replace: "reject(new FleetUnavailable(`${method} ${path}: ${e.message}`, false, { cause: e }))",
    run: ["packages/fleet-client/test/deliveries.test.ts"], expect: "the connection dropped after the request is FleetUnavailable, reached" },
  { id: "fc3-lane-events-checked", task: "fc3", file: "packages/fleet-client/src/fleet-client.ts",
    find: "    if (!events || events.some(e => e === null)) throw new FleetMismatch(", replace: "    if (!events) throw new FleetMismatch(",
    run: ["packages/fleet-client/test/deliveries.test.ts"], expect: "an event of another shape is a mismatch" },
  { id: "fc3-alert-kinds", task: "fc3", file: "packages/fleet-client/src/fleet-client.ts",
    find: '"backlog_full", "unrouted_hook", "delivery_waiting", "subscriber_lagging"] satisfies AlertKind[]);', replace: '"backlog_full", "unrouted_hook"] satisfies AlertKind[]);',
    run: ["packages/fleet-client/test/deliveries.test.ts"], expect: "keeps the alerts delivery_waiting and subscriber_lagging" },
  { id: "fc3-op-no-delivery-ops", task: "fc3", file: "packages/fleet-client/src/fleet-client.ts",
    find: "    if (DELIVERY_OPS.has(op)) throw new TypeError(", replace: "    if (false) throw new TypeError(",
    run: ["packages/fleet-client/test/deliveries.test.ts"], expect: "are never sent through op()" },
```

Run: `node scripts/negative-controls.ts --check | grep -v '^ok'`
Expected: no output. Before `op()` used `#outcome`, `t14a-op-non-json-in-doubt` showed as `STALE … found 2 times`. Step 15 runs the controls, after the commit.

- [ ] **Step 15: Run all checks, and commit**

Run each in turn, from the repo root:
- `npm run check`. Expected: exit 0; `0 ERRORS 0 WARNINGS`.
- `npm run lint`. Expected: no problems reported.
- `npx vitest run --project units packages apps/hub apps/node-agent apps/fleet scripts`. Expected: everything passes but, on macOS, `pane-lock.test.ts`'s 2 and `process-start.test.ts`'s 2. At `12c2811` on 2026-10-09: 209 files.
- `npx vitest run --project fleet`. Expected: the drills pass. They import the client from the package. On 2026-10-08: 9 files, 48 tests. The run had a parallel test run next to it, and one retry drill failed with `op.status on n1: node_offline` right after a fleet restart. That file then passed alone twice, 18 of 18.

```bash
git add packages/fleet-client/src/fleet-client.ts packages/fleet-client/test/deliveries.test.ts packages/fleet-client/test/fleet-client.test.ts scripts/negative-controls.ts
git commit -m "feat(fleet-client): the client's name, sticky lanes, deliveries and lane events"
```

Then, after the commit (the runner reads `HEAD`, ruling 50): `node scripts/negative-controls.ts --list | awk -F'\t' '$1 ~ /^fc3-/ || $3 ~ /fleet-client/ {print "--only " $1}' | xargs node scripts/negative-controls.ts`
Expected: `24/24 controls bit; still pass 0, broke 0, timed out 0, skipped 0`: the 12 `fc3-` entries and the 12 moved ones.

---

## Open questions

Settled by the reconciliation, except the last:
1. **What `status: "shell"` means.** Ruling 11: Claude Code is alive and running a shell command (seen at its prompt with a background shell, `claude-pool`'s reading), not exited. A lane takes deliveries while it has a live session, whatever its `status`. `no_session` means no session file, or its process gone. `sessions.ts` passes the value on as Claude Code writes it, and the protocol's comments say so (Tasks 1, 2).
2. **A `/clear` delivery.** Ruling 17: its receipt is the pane's session changing to a new id after the typing. `newSessionReceipt` (Task 2, Step 4) gives it, for `/clear` and its aliases `/reset` and `/new`; Task 5 uses it. `clear-new-session.jsonl` pins that the command is recorded only in the new session's transcript.
3. **`pane.capture`'s 256 KiB.** Ruling 10: the cap counts the JSON-escaped size. The agent caps by it (Task 6); Task 1's test shows plain and coloured screens fit one message.
4. **`lane.start`'s first prompt's id.** Ruling 7: `<client>:prompt:<first 16 hex of SHA-256 of the start's key>`, always within 200 (Task 6). Task 1's test accepts an id of that form.
5. **Recording a multi-question form** (still open). No lane was waiting on one while this was written, so `menu.test.ts`'s form is synthetic, in the layout kira's parser documents (2.1.284). Task 16 could record one on the PC (`tmux capture-pane -p -J -S -60` of a waiting lane, masked) and add it to `test/fixtures/claude-code/`.

## Contract additions requested

Names and rules these tasks needed beyond plan.md's Contracts, each in the code above, with the ruling that settled it where there is one:

1. **`SESSION_STATUSES`** (protocol), `["busy", "idle", "waiting", "shell"] as const`, with `SessionStatus` derived from it. `node-ops`' `sessions.ts` checks the file's value against it at runtime.
2. **`DeliverySchema` and `LaneEventSchema` exported** (protocol). The Contracts name `DeliverySchema` in `EvDelivery`. `packages/fleet-client` checks the answers and events of the delivery and lane-event routes with both; the fleet (Tasks 8, 9) can build with them.
3. **`LaneStateBody` and `LaneStateBodySchema`** (protocol): the `/lane` hook body the Contracts describe, `{ event: "needs_input" | "answered"; sessionId: string | null; question?: string }`, with `question` at most 200 characters. The agent writes it (Task 6) and the fleet reads it (Task 9), so one schema serves both.
4. **A delivery's arguments**, as ruling 7 adopts them (`OP_ARGS["lane.deliver"]`):
   - the id is `^[a-z]{1,16}:` with no control character, at most 200, never ending in `#` and digits;
   - `ttlMs` is 1 to `LIMITS.deliveryKeepMs`;
   - the target is strict;
   - `pane.keys`' `names` hold 1 to `LIMITS.maxKeys`.
5. **`Pane`** (rulings 12, 13):
   - `pid` is the session file's pid, Claude Code's own process, `null` without a session;
   - `status` and `pid` read as `null` from an agent from before them;
   - `topic?: string` and `lastPrompt?: string`, the session's latest `ai-title` and `last-prompt` entries. They are optional strings, as `title` is: the types are chosen here.
6. **`packages/fleet-client` imports `ws`** (ruling 9). Node's own `WebSocket` has no documented way to dial a Unix socket, and `ws` is already a dependency of `apps/hub` and `apps/fleet`.
7. **`FleetLog`** and the constructor option `log` (fleet-client; ruling 9). The client wrote through the hub's logger; a package can't import the hub. By default it writes redacted lines to stderr.
8. **`FleetDelivery = Delivery & { stale: boolean }`** (rulings 8, 9). `caps()` answers `stickyLanes: []` from a fleet that sends none.
9. **`ClientOp = Exclude<OpName, "lane.deliver" | "delivery.cancel">`** (fleet-client), the type of `op()`'s op. Ruling 4: the fleet refuses the two delivery ops on `/v1/op`, and the client never sends them there. `apps/fleet/src/adapters/op-body.ts` still names them, so that it compiles; Task 8 refuses them.
10. **`/lane` is not a subscriber path** (`apps/fleet/src/config.ts`; ruling 5). `HOOK_PATHS` stays the six, and `SCRIPT_PATHS` never counts `/lane` as unrouted.
11. **The inventory carries `status` and `pid` from Task 2 on** (`apps/node-agent/src/ops/inventory.ts`). Task 6 adds `topic` and `lastPrompt` from its transcript reads (ruling 13) and builds lane state events on the rest.
12. **`WaitingReason` gains `unavailable`** (ruling 15): the node couldn't read or type the pane just now, so it tries again.
13. **`pane.capture`'s `join?: boolean`** (ruling 10). In node-ops this is `capture(paneId, o?: { lines; attributes?; join? })`, with `join` defaulting to true, tmux's `-J` (the Contracts', ruling 56; `o` is optional for the hub's own `capture(id)`).
14. **`startsNewSession(text)` and `newSessionReceipt(text, typedInto, sessionNow)`** (node-ops `receipt.ts`; ruling 17): names chosen here.
15. **Now in the Contracts, after the review round:**
    - `LIMITS.deliveryReceiptHoldMs: 60_000` (ruling 48);
    - `cancelDelivery(id): Promise<Delivery | null>` (ruling 56);
    - `FleetUnavailable.reached` as the in-doubt rule (ruling 49);
    - the `fc2-receipt-dequeue` control (ruling 61).

    Each is in the code above.
