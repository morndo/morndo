## Lane notes (tests and docs)

Tasks 15, 16 and 17 run in wave 2 on `feat/fleet-clients-tests`, after Tasks 1–14 are merged into `feat/fleet-clients`. Every Contract in [plan.md](../plan.md) is assumed to exist. They add no product code. They add:
- a client API reference whose examples run as tests;
- drills over real processes;
- the negative controls;
- the domain model's and the READMEs' text;
- the bench gate's arithmetic.

**Run order: Task 16, then Task 15, then Task 17** ([RECONCILIATION.md](RECONCILIATION.md), ruling 36). Task 15's doc test drives its lanes through the fake input box and the harness that Task 16 extends, so Task 16 goes first in this lane. The tasks keep the numbers the plan's index gives them, and this file lists them in the order they run.

**What these tasks rely on, as the reconciliation settled it** (the rulings are in [RECONCILIATION.md](RECONCILIATION.md); a test here fails loudly if one doesn't hold):
- **The fake box's lines** are Task 2's recorded 2.1.293 lines (`test/fixtures/claude-code/2.1.293/`), made the box's own: its text, session, folder, ids and times.
- **Agent test hooks** (ruling 20): `killAfterEffect`, `noSessionBinding`, `retypeUnderFirstKey` and `deliveryStartGraceMs`. `noDoneKeys` also covers the deliverer.
- **Delivery refusals** (rulings 3, 45) are 200 `{ ok: false, error }`, as `/v1/op` answers op refusals. A body that doesn't fit is 400 `{ ok: false, error }` (`bad_args`), as `POST /v1/op` answers one, and an unknown id 404 `{ error: "no_such_delivery" }` on GET and on cancel.
- **`POST /v1/op`** refuses `lane.deliver` and `delivery.cancel` with 400 `bad_args` (ruling 4).
- **Sessions** (rulings 11, 12, 13):
  - a lane takes deliveries while it has a live session, whatever its `status`; `shell` means a shell command is running under it;
  - `Pane.pid` is the session's process, `null` without one;
  - `Pane` gains `topic?` and `lastPrompt?` (rulings 13, 46).
- **Typing and receipts** (rulings 16, 17):
  - a delivery waiting for its receipt holds the next one for at most 60 s;
  - a `/clear` is confirmed by the pane's session changing.
- **A lane start's first prompt** is the delivery `<client>:prompt:<first 16 hex of SHA-256 of the start's key>` (ruling 7).
- **Alert details** (ruling 25): `delivery_waiting { id, lane, state, reason, minutes }` and `subscriber_lagging { subscriber, oldestAgeMs, streams }`.
- **Lane-event delivery ids** (ruling 6): `fleet:lane-events:<node>:<ms>`, with `-<n>` for a split batch and `.<n>` for one queued again. `/lane` is never a subscriber path (ruling 5).
- **The bench gate's last line** is `gate: PASS` or `gate: FAIL (<which>)` (ruling 38).
- **Negative-control ids** are `fc<task>-…` (ruling 1).
- **A new delivery** is answered `queued`, with `waiting` only while queued and a try found the lane not ready (ruling 43). A lane event's `firstLine` is the turn text's first non-blank line, trimmed, at most 200 characters; `bg` and `crons` are counts (ruling 44). `Pane.topic` and `Pane.lastPrompt` are optional, absent when unknown (ruling 46).

**Where the new files live.** These follow the fleet core's rule (its plan part 07, "Where the shared helpers live"):

| File | Why there |
|---|---|
| `test/fleet/*.test.ts` | The drills and the doc test start real fleet and agent processes, and the vitest project `fleet` runs that folder (`vitest.config.ts`). CI runs it in its `fleet` job, so no workflow change is needed. |
| `test/api-doc-examples.ts` | Parses the doc's examples and matches answers to them. It imports no vitest, like `test/fleet-harness.ts`, so the matcher's own test and the doc test can share it. |
| `scripts/bench-gate.ts` | The gate's arithmetic, apart from `scripts/bench-relay.ts`, which starts a fleet when it is run. The unit project runs `scripts/**/*.test.ts`. |

**Isolation, as in every fleet test.** Each test uses:
- its own tmux server (`tmux -L test-<uuid>`, never the default server);
- temporary HOMEs, random ports, and child processes that `stopAll()` ends.

The doc names the node's relay by its default port 8787, but the doc test sends every relay request to its own agent's random port and never connects to 8787. No test uses ports 8786–8791. None of these tasks writes to the owner's PC.

---

### Task 16: Drills (test/fleet) and the fake input box

**Files:**
- Modify: `test/fixtures/fake-claude-pane.ts` (the fake input box: 2.1.293's transcript and session shapes, a control file)
- Modify: `test/fleet-harness.ts` (lanes the test can steer, fleet config for lane events, policy updates, a subscriber that can refuse, a delivery watch)
- Create: `test/fleet/fake-box.test.ts` (the box against the agent's own readers)
- Create: `test/fleet/drills-deliveries.test.ts` (waiting, Enter again, the agent killed while typing, a lane in `shell`, the 60 s hold)
- Create: `test/fleet/drills-receipts.test.ts` (receipts, the interrupt's one retype, `/clear`)
- Create: `test/fleet/drills-lanes.test.ts` (the manager's restart, a session that changed, `lane.start` through the shell)
- Create: `test/fleet/drills-lane-events.test.ts` (batches to the manager, a fleet restart, a subscriber that refuses)
- Create: `test/fleet/drills-lanes-cli.test.ts` (`morndo lanes` against a real fleet and agent: list, peek, keys, send, status, start, stop, events, the exits 5 and 69; ruling 57)
- Create: `test/fleet/drills-manager-queue.test.ts` (the hub's manager queue through a real fleet: an answer and a message delivered, an answer in flight across a hub kill, the switch off; ruling 66)
- Test: the seven files above, and the whole `fleet` project (the box still serves the fleet core's drills)

**Interfaces:**
- Consumes:
  - `FleetClient` from `@morndo/fleet-client` (Task 3): `deliver()`, `delivery()`, `laneEvents()`, `events()` with `t: "delivery"` (body `Delivery & { stale }`), `op()`, `lanes()` and `alerts()`. A refusal throws `FleetOpFailed`.
  - From `packages/protocol/src/fleet.ts` (Task 1): `Delivery`, `Pane` (with `status`, `pid`, `topic` and `lastPrompt`), `LaneEvent`, `AlertKind` (`subscriber_lagging`), `LIMITS.deliveryTryMs` and `LIMITS.deliveryReceiptHoldMs` (ruling 42). `parseWorkerId` (`worker-id.ts`).
  - From `packages/node-ops` (Task 2): `readReceipts(lines, pending)` from `src/receipt.ts`; `menuQuestion(screen)` from `src/menu.ts`; `sessionRegistry(dir).byPane()` from `src/sessions.ts`, whose `SessionInfo` has `status`; and `inputBoxOnScreen` and `menuOnScreen` from `src/tmux.ts`.
  - Task 2's recorded lines in `test/fixtures/claude-code/2.1.293/`: `typed-prompt.jsonl`, `queued-then-prompt.jsonl`, `absorbed-mid-turn.jsonl`, `delivered-to-agent.jsonl`, `cleared-on-cancel.jsonl` and `session-file.json`.
  - `FleetConfig.stickyLanes` and `FleetConfig.laneEvents` (`apps/fleet/src/config.ts`, Tasks 7–9), and `Policy.launch` and `Policy.protected` (`apps/node-agent/src/config.ts`, Task 6).
  - `TestHooks` (`apps/node-agent/src/test-hooks.ts`, ruling 20):
    - `noDoneKeys`, which exists, and also covers the deliverer;
    - `killAfterEffect`, `noSessionBinding`, `retypeUnderFirstKey` and `deliveryStartGraceMs` (Tasks 5–6).
  - `lane.start { prompt }`, which answers `{ workerId, prompt }`. The prompt's delivery id is `<client>:prompt:<first 16 hex of SHA-256 of the start's key>` (ruling 7, Task 6).
  - The deliverer's rulings 11 (any live session takes deliveries), 16 (a delivery without its receipt holds the next for at most 60 s) and 17 (a `/clear` is confirmed by the session changing), Task 5.
  - The `subscriber_lagging` alert with detail `{ subscriber, oldestAgeMs, streams }` (Task 10, ruling 25).
  - The hub's manager queue (Task 12, part 04; ruling 66):
    - `startHub(fleet, { managerQueue })` (Step 12.49);
    - the answer key `hub:answer:<escalation>:<ask>:<choice>` and the message key `hub:<endpoint>:<request>`, which are also the delivery ids;
    - the Decision's `delivery.state` on `GET /api/escalations`, behind the card's "Delivered";
    - a message's `delivery` on its send's answer and on its repeat's `duplicate`;
    - `EscalationAnswered` in `morndo audit`;
    - the start line `manager queue: on|off`;
    - at a start with the switch off, what is still queued is cancelled.
  - `morndo lanes` (Task 14, `apps/hub/src/console/lanes.ts`, run as `node apps/hub/src/main.ts lanes …`): its commands and output lines (`<id>: <state>`, `x sent to w1`, `stopped w2`, `<time> w1@n1 finished done …`, `--json` rows and results), and its exits as plan.md's Contracts give them (ruling 49): 0, 2, 4, **5 in doubt** and 69.
- Produces:
  - `test/fixtures/fake-claude-pane.ts` exports the types `Status`, `TranscriptKind` and `Control`. Its CLI:
    `node fake-claude-pane.ts <state dir> [--claude=<dir> --session=<id|auto> --tmux-session=<name>] [--offset=<ms>] [--start-delay=<ms>]`.
    Beside today's `submitted.jsonl`, `raw.bin` and `prose.txt`, it reads `<state dir>/control.jsonl` and writes `<state dir>/applied`.
  - `test/fleet-harness.ts` gains these (used by Task 15):
    ```ts
    export function tempDir(prefix: string, base?: string): string;
    export type Lane = { /* today's fields */ control(c: Control): Promise<void>; entries(): Record<string, unknown>[]; enters(): number };
    export function fakeLane(t: TmuxServer, o: { window: string; session?: string; prose?: string; claudeHome?: string; offsetMs?: number;
      startDelayMs?: number; wait?: boolean }): Promise<Lane>;
    export function controlAt(dir: string, c: Control): Promise<void>;
    export function submittedAt(dir: string): string[];
    export function startFleet(o?: { subscribers?: FleetConfig["subscribers"]; stickyLanes?: string[];
      laneEvents?: Partial<FleetConfig["laneEvents"]> }): Promise<Fleet>;          // laneEvents.deliverTo defaults to null here
    export type Agent = { /* … */ run(hooks?: TestHooks, o?: { env?: Record<string, string> }): Promise<void>;
      waitOnline(ms?: number): Promise<void> };   // now waits until the node answers, twice, from one store (ruling 37)
    export function updatePolicy(agent: Agent, patch: Partial<AgentConfig["policy"]>): void;
    export type Delivery = { key: string; event: HookEvent; got: number; path: string; headers: Record<string, string> };
    export function subscriber(o?: { delayMs?: number; path?: string; answer?: (d: Delivery) => number }): Promise<Subscriber>;
    export type DeliveryWatch = { states(id: string): (DrillDelivery & { stale: boolean })[];
      until(id: string, what: (d: DrillDelivery) => boolean, ms?: number): Promise<DrillDelivery> };
    export function watchDeliveries(fleet: Fleet): Promise<DeliveryWatch>;
    export type Hub = { /* today's fields */ get(path: string): Promise<Reply>; log(): string;
      restart(o?: { signal?: NodeJS.Signals; managerQueue?: boolean; whileStopped?: () => Promise<void> }): Promise<void> };
    ```
  - Seven test files. Their "(negative control)" cases are listed in Task 17's controls step.

The drills test behaviour that Tasks 4–10 built, and that behaviour is already on the branch when they run. So a drill shows that it can fail through its negative control:
- the same drill runs with the guard taken out by a test hook;
- it asserts the very failure the guard prevents.

Spec §12 names three controls: without the `started` check, the restarted agent types again; without the session binding, the message lands in the new lane; the retype under the first key types nothing. They are tests of their own, named "… (negative control)", so they run with every suite (Global Constraints, "Negative controls as data").

- [ ] **Step 1: Check that Task 2's recorded lines are there, as the box reads them**

The box writes only shapes that were recorded, never shapes written by hand (Global Constraints, "Claude Code internals"). It takes them from the files Task 2 records under `test/fixtures/claude-code/2.1.293/`:
- the text-bearing lines carry a synthetic text starting `[fixture] `;
- the session is `5e1f0c2a-…`, the folder `/work/demo`, and the ids are `0f1c….-2d3e-4f5a-8b6c-…`.

Run:

```bash
node -e '
const fs = require("fs"); const d = "test/fixtures/claude-code/2.1.293/";
const need = { "typed-prompt.jsonl": 1, "queued-then-prompt.jsonl": 3, "absorbed-mid-turn.jsonl": 3, "delivered-to-agent.jsonl": 2, "cleared-on-cancel.jsonl": 2 };
for (const [f, n] of Object.entries(need)) {
  const lines = fs.readFileSync(d + f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  const kinds = lines.map(l => l.operation ?? l.attachment?.type ?? l.promptSource ?? l.type);
  const texts = lines.filter(l => JSON.stringify(l).includes("\"[fixture] ")).length;
  console.log(f, lines.length >= n ? "ok" : "SHORT", kinds.join(","), texts);
}
const s = JSON.parse(fs.readFileSync(d + "session-file.json", "utf8"));
console.log("session-file.json", ["pid", "sessionId", "cwd", "tmux", "status", "version"].every(k => k in s) ? "ok" : "MISSING KEYS", s.version, s.cwd);'
```

Expected:

```
typed-prompt.jsonl ok typed 1
queued-then-prompt.jsonl ok enqueue,dequeue,queued 2
absorbed-mid-turn.jsonl ok enqueue,remove,queued_command 3
delivered-to-agent.jsonl ok enqueue,remove 2
cleared-on-cancel.jsonl ok enqueue,remove 2
session-file.json ok 2.1.293 /work/demo
```

Stop here and ask the reconciler in any of these cases:
- a file is missing, or holds other lines;
- a text-bearing line has no `[fixture] ` text (the box finds the text by that prefix);
- the session file lacks `status` or `tmux`.

- [ ] **Step 2: Write the failing test of the box, `test/fleet/fake-box.test.ts`**

```ts
// The fake input box (test/fixtures/fake-claude-pane.ts) against the readers the node agent itself uses. A drill that
// passed on a box writing other shapes than Claude Code 2.1.293 would prove nothing, so each kind of line the box writes
// is read here by Task 2's receipt rules, its session file by the session registry, and its screens by the menu and input
// box checks and kira's menu parser (fleet clients spec §12; Global Constraints, "Claude Code internals"). An isolated
// tmux server; no fleet, no agent.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { menuQuestion } from "../../packages/node-ops/src/menu.ts";
import { readReceipts } from "../../packages/node-ops/src/receipt.ts";
import { sessionRegistry } from "../../packages/node-ops/src/sessions.ts";
import { inputBoxOnScreen, menuOnScreen } from "../../packages/node-ops/src/tmux.ts";
import { fakeLane, stopAll, tempDir, tmuxServer, until, type Lane, type TmuxServer } from "../fleet-harness.ts";

afterEach(stopAll);

async function box(): Promise<{ t: TmuxServer; lane: Lane; claude: string }> {
  const t = tmuxServer();
  const home = tempDir("morndo-box-");
  const lane = await fakeLane(t, { window: "box", claudeHome: home });
  return { t, lane, claude: join(home, ".claude") };
}
// Typed at the keyboard (not pasted), then Enter, as the owner would.
async function type(b: { t: TmuxServer; lane: Lane }, text: string) {
  b.t.run("send-keys", "-t", b.lane.paneId, "-l", text);
  b.t.run("send-keys", "-t", b.lane.paneId, "Enter");
  await until(`"${text}" submitted`, () => b.lane.submitted().includes(text));
}
const lines = (lane: Lane) => readFileSync(lane.transcript ?? "", "utf8").split("\n").filter(Boolean);
// Each pending text's last verdict, as the deliverer would end up reading it ("none" when no entry decided it).
function verdict(lane: Lane, text: string, typedAt: number): string {
  const all = readReceipts(lines(lane), [{ id: "d", text, typedAt }]);
  return all.filter(r => r.id === "d").at(-1)?.verdict ?? "none";
}
const statusOf = (b: { lane: Lane; claude: string }) => sessionRegistry(b.claude).byPane().get(b.lane.paneId)?.status ?? null;

describe("the fake input box writes what Claude Code 2.1.293 writes", () => {
  it("a prompt typed while idle is a receipt; the session file says idle", async () => {
    const b = await box();
    expect(statusOf(b)).toBe("idle");
    const at = Date.now();
    await type(b, "typed while idle");
    expect(verdict(b.lane, "typed while idle", at)).toBe("delivered");
  });

  it("typed while busy: held on its enqueue; a dequeue alone decides nothing; the queued prompt delivers it", async () => {
    const b = await box();
    await b.lane.control({ status: "busy" });
    expect(statusOf(b)).toBe("busy");
    const at = Date.now();
    await type(b, "queued while busy");
    expect(verdict(b.lane, "queued while busy", at)).toBe("held");
    await b.lane.control({ dequeue: true });
    expect(verdict(b.lane, "queued while busy", at)).toBe("held");
    await b.lane.control({ prompt: true, status: "idle" });
    expect(verdict(b.lane, "queued while busy", at)).toBe("delivered");
  });

  it("taken into the running turn (remove absorbed_mid_turn, then queued_command): delivered", async () => {
    const b = await box();
    await b.lane.control({ status: "busy" });
    const at = Date.now();
    await type(b, "absorbed mid turn");
    await b.lane.control({ absorb: true });
    expect(lines(b.lane).filter(l => l.includes("absorbed mid turn"))).toHaveLength(3);   // enqueue, remove, queued_command
    expect(verdict(b.lane, "absorbed mid turn", at)).toBe("delivered");
  });

  it("remove delivered_to_agent: delivered; a remove with a reason no rule names: still held", async () => {
    const b = await box();
    await b.lane.control({ status: "busy" });
    const at = Date.now();
    await type(b, "to the agent");
    await b.lane.control({ remove: "delivered_to_agent" });
    expect(verdict(b.lane, "to the agent", at)).toBe("delivered");
    await type(b, "moved somewhere new");
    await b.lane.control({ remove: "moved_elsewhere" });
    expect(verdict(b.lane, "moved somewhere new", at)).toBe("held");
  });

  it("an interrupt drops the queued line (cleared_on_cancel), and the session turns idle", async () => {
    const b = await box();
    await b.lane.control({ status: "busy" });
    const at = Date.now();
    await type(b, "dropped by the interrupt");
    await b.lane.control({ interrupt: {} });
    expect(verdict(b.lane, "dropped by the interrupt", at)).toBe("dropped");
    expect(statusOf(b)).toBe("idle");
  });

  it("a menu: no input box, a menu with its question, the session waiting; answered, the box is back", async () => {
    const b = await box();
    await b.lane.control({ status: "waiting", question: "Merge the docs branch?" });
    expect(statusOf(b)).toBe("waiting");
    const screen = b.lane.screen();
    expect(menuOnScreen(screen)).toBe(true);
    expect(inputBoxOnScreen(screen)).toBe(false);
    expect(menuQuestion(screen)).toBe("Merge the docs branch?");
    await b.lane.control({ status: "idle" });
    expect(inputBoxOnScreen(b.lane.screen())).toBe(true);
  });

  it("a shell command running (status shell, ruling 11): the box stays, a typed line is a prompt", async () => {
    const b = await box();
    await b.lane.control({ status: "shell" });
    expect(statusOf(b)).toBe("shell");
    expect(inputBoxOnScreen(b.lane.screen())).toBe(true);
    expect(menuOnScreen(b.lane.screen())).toBe(false);
    const at = Date.now();
    await type(b, "typed beside a shell command");
    expect(verdict(b.lane, "typed beside a shell command", at)).toBe("delivered");
  });

  it("/clear starts a new session (ruling 17): a new id in the same session file, and a new transcript", async () => {
    const b = await box();
    const before = sessionRegistry(b.claude).byPane().get(b.lane.paneId)?.sessionId;
    expect(before).toBe(b.lane.sessionId);
    await type(b, "/clear");
    const after = await until("a new session id", () => {
      const s = sessionRegistry(b.claude).byPane().get(b.lane.paneId)?.sessionId;
      return s && s !== before ? s : null;
    });
    expect(existsSync(join(b.claude, "projects", "-qa", `${after}.jsonl`))).toBe(true);
  });

  it("/exit ends the process: the session is no longer live", async () => {
    const b = await box();
    await type(b, "/exit");
    await until("the session gone from the registry", () => !sessionRegistry(b.claude).byPane().has(b.lane.paneId));
  });

  it("starting: no box and no session file until the delay has passed", async () => {
    const t = tmuxServer();
    const home = tempDir("morndo-box-");
    const lane = await fakeLane(t, { window: "late", claudeHome: home, startDelayMs: 2500, wait: false });
    await until("the starting screen", () => lane.screen().includes("Starting Claude Code"));
    expect(inputBoxOnScreen(lane.screen())).toBe(false);
    expect(sessionRegistry(join(home, ".claude")).byPane().get(lane.paneId)).toBeUndefined();
    await until("the box after the delay", () => inputBoxOnScreen(lane.screen()), 8000);
    expect(sessionRegistry(join(home, ".claude")).byPane().get(lane.paneId)?.status).toBe("idle");
  });
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `npx vitest run --project fleet test/fleet/fake-box.test.ts`

Expected: FAIL, 10 of 10, each `TypeError: tempDir is not a function` (vitest's transform turns the missing export into `undefined`). The harness has no `tempDir` or `Lane.control` yet.

- [ ] **Step 4: Rewrite `test/fixtures/fake-claude-pane.ts`**

Replace the whole file with:

```ts
// A stand-in for Claude Code's input box in a tmux pane, for the fleet's tests (test/fleet), its two-node e2e and its QA
// runbook. It is never the real CLI, so none of the real one's hooks fire, and it runs nothing: it only records, and
// writes the files Claude Code writes.
// It draws like Claude Code (as apps/hub/test/tmux-fake-claude.fixture.ts does): optional prose, a ─ rule, "❯ " and the
// input, a ─ rule, a footer. A busy turn adds "✻ Working…" above the box; a menu replaces the box; a shell command running
// under the session (status shell) adds "· 1 shell" to the footer, as 2.1.293 does, and the box stays. It turns bracketed
// paste on (ESC[?2004h). Inside a paste every byte is text; outside it, Enter submits, Ctrl-U clears the draft, Escape
// answers a menu or interrupts a busy turn, Ctrl-C interrupts or clears.
// What it writes is Claude Code 2.1.293's (fleet clients, Task 16): the lines Task 2 recorded on the owner's PC, in
// test/fixtures/claude-code/2.1.293 (synthetic values in the recorded keys and shapes), made this box's own: their
// "[fixture] …" text is the line's text, and their session, folder, ids and times are this box's. Never a shape written
// here, so the drills and the receipt's own unit tests read the same lines:
// - the session file <claude>/sessions/<pid>.json, with its `status`: busy, idle, waiting (a menu) or shell (a shell
//   command running; the session is alive: RECONCILIATION.md ruling 11);
// - the transcript: a submit while idle (or shell) is a typed `user` prompt; a submit while busy is a `queue-operation`
//   `enqueue` with its text, held in the box's queue until the test says what Claude Code does with it next: a `dequeue`
//   (no text) and then the queued prompt (the queued lines merged), a `remove` `absorbed_mid_turn` with the
//   `queued_command` attachment, a `remove` with another reason, or an interrupt (a `remove` `cleared_on_cancel` for each).
// Usage: node fake-claude-pane.ts <state dir> [--claude=<dir> --session=<id|auto> --tmux-session=<name>] [--offset=<ms>]
//          [--start-delay=<ms>]
//   <state dir>/prose.txt        read at start: the prose drawn above the box
//   <state dir>/raw.bin          every byte received
//   <state dir>/submitted.jsonl  one JSON string per submit
//   <state dir>/control.jsonl    the test's commands (Control below), one JSON object per line, applied in order every
//                                25 ms; how many were applied so far is written to <state dir>/applied
//   --claude: the session file <dir>/sessions/<pid>.json naming this pane (from TMUX_PANE) and the transcript
//     <dir>/projects/-qa/<session>.jsonl, timed on this machine's clock plus --offset (the node's clock, the one the real
//     CLI writes with). --session=auto makes up a session id (a lane that lane.start opened, whose id no one chose).
//   --start-delay: for that long the pane shows Claude Code starting, with no box and no session file.
//   A state dir holding a file named `untrusted` shows Claude Code's folder-trust dialog first (the screen recorded on
//   2.1.287, packages/node-ops/test/fixtures/claude-code-2.1.287/trust-dialog.ansi): Down then Enter trusts the folder;
//   Enter alone, or Escape, exits, as there.
// Submitted while not busy: "/exit" ends the process, as Claude Code's /exit does: its session file stays, its process
// is gone, so the session is no longer live; "/clear" or "/new" starts a new session (ruling 17): a new session id in the
// same session file, and a new transcript.
// Options take the --name=value form: util.parseArgs takes a value starting with "-" (a negative offset) only that way
// (https://nodejs.org/docs/latest-v24.x/api/util.html#utilparseargsconfig, read 2026-10-06).
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseArgs } from "node:util";

export type Status = "busy" | "idle" | "waiting" | "shell";
export type TranscriptKind = "userTyped" | "userQueued" | "enqueue" | "dequeue" | "removeAbsorbed" | "removeDeliveredToAgent"
  | "removeCleared" | "queuedCommand";
// A test's command (test/fleet-harness.ts, Lane.control). The fields act in the order they are listed here.
export type Control = {
  silent?: boolean;                 // from now on a submit reaches no transcript (a prompt Claude Code never records)
  swallowEnters?: number;           // the next n Enters leave the line in the box…
  replaceWith?: string;             // …and the first of them puts this text there instead (the owner typing over it)
  question?: string;                // the menu's question from now on (default "Do you want to proceed?")
  clear?: true;                     // the draft is cleared
  write?: TranscriptKind;           // one transcript line of this kind…
  text?: string;                    // …with this text
  dequeue?: true;                   // a dequeue line (no text): Claude Code takes its queue as the next prompt…
  prompt?: true;                    // …and the queued prompt: the queued lines merged, one per line
  absorb?: true;                    // each queued line taken into the running turn: remove absorbed_mid_turn + queued_command
  remove?: string;                  // each queued line removed with this reason
  interrupt?: { restore?: boolean; queueNext?: boolean };   // Escape on a busy turn: each queued line cleared_on_cancel,
                                                            // status idle; restore: the lines back in the box; queueNext: below
  status?: Status;                  // the session's status and the screen that goes with it; shell: a shell command
                                    // running under the live session, the box stays and takes lines as when idle
  queueNext?: true;                 // the next submit is queued, and the status turns busy (a turn starting as it lands)
  exit?: true;                      // the process exits, as on /exit: the session is no longer live
};
type Line = Record<string, unknown>;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    claude: { type: "string" }, session: { type: "string" }, "tmux-session": { type: "string" }, offset: { type: "string" },
    "start-delay": { type: "string" },
  },
});
const dir = resolve(positionals[0] ?? ".");
const offset = Number(values.offset ?? 0);
const clock = () => Date.now() + offset;
const startDelay = Number(values["start-delay"] ?? 0);
const tmuxSession = values["tmux-session"] ?? "qa";
const prose = existsSync(join(dir, "prose.txt")) ? readFileSync(join(dir, "prose.txt"), "utf8").replace(/\n+$/, "") : "";

// Task 2's recorded lines (test/fixtures/claude-code/2.1.293), one per kind the box writes.
const RECORDED = join(import.meta.dirname, "claude-code", "2.1.293");
function recorded(file: string, line: number): Line {
  const l = readFileSync(join(RECORDED, file), "utf8").split("\n").filter(Boolean)[line];
  if (!l) throw new Error(`${file} has no line ${line + 1}: the box needs Task 2's recorded lines`);
  return JSON.parse(l) as Line;
}
const T: Record<TranscriptKind, Line> = {
  userTyped: recorded("typed-prompt.jsonl", 0),
  enqueue: recorded("queued-then-prompt.jsonl", 0),
  dequeue: recorded("queued-then-prompt.jsonl", 1),
  userQueued: recorded("queued-then-prompt.jsonl", 2),
  removeAbsorbed: recorded("absorbed-mid-turn.jsonl", 1),
  queuedCommand: recorded("absorbed-mid-turn.jsonl", 2),
  removeDeliveredToAgent: recorded("delivered-to-agent.jsonl", 1),
  removeCleared: recorded("cleared-on-cancel.jsonl", 1),
};
const SESSION = JSON.parse(readFileSync(join(RECORDED, "session-file.json"), "utf8")) as Line;
const RECORDED_SESSION = String(SESSION.sessionId);
const RECORDED_CWD = String(SESSION.cwd);
const RECORDED_ID = /^0f1c[0-9a-f]{4}-2d3e-4f5a-8b6c-[0-9a-f]{12}$/;     // the recorded lines' synthetic uuids
const TRUST = join(import.meta.dirname, "..", "..", "packages", "node-ops", "test", "fixtures", "claude-code-2.1.287", "trust-dialog.ansi");

const claude = values.claude ?? null;
let sessionId = values.session === "auto" ? randomUUID() : (values.session ?? null);
const transcriptOf = (id: string | null) => (claude && id ? join(claude, "projects", "-qa", `${id}.jsonl`) : null);
let transcript = transcriptOf(sessionId);
const sessionFile = claude && sessionId ? join(claude, "sessions", `${process.pid}.json`) : null;
const startedAt = clock();

let phase: "starting" | "trust" | "running" = "starting";
let trustDown = false;
let status: Status = "idle";
let input = "";
let paste = false;
let pending = "";
let queue: string[] = [];
let queueNext = false;
let silent = false;
let swallow = 0;
let replaceWith: string | null = null;
let question = "Do you want to proceed?";
let lastUuid: string | null = null;

// A recorded line made this box's: its "[fixture] …" text is `text`; its session, folder, ids and times are this box's.
function own(v: unknown, text: string, key = ""): unknown {
  if (typeof v === "string") {
    if (key === "timestamp") return new Date(clock()).toISOString();
    if (v.startsWith("[fixture] ")) return text;
    if (v === RECORDED_SESSION) return sessionId;
    if (v === RECORDED_CWD) return process.cwd();
    if (RECORDED_ID.test(v)) return key === "parentUuid" ? lastUuid : randomUUID();
    return v;
  }
  if (Array.isArray(v)) return v.map(x => own(x, text));
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, own(x, text, k)]));
  return v;
}

function writeSession() {
  if (!claude || !sessionFile || !sessionId || phase !== "running") return;
  mkdirSync(join(claude, "sessions"), { recursive: true });
  const now = clock();
  const tmp = `${sessionFile}.tmp`;
  writeFileSync(tmp, JSON.stringify({
    ...SESSION, pid: process.pid, sessionId, cwd: process.cwd(), startedAt, tmux: `${tmuxSession}:@0.${process.env.TMUX_PANE ?? ""}`,
    status, updatedAt: now, statusUpdatedAt: now,
  }));
  renameSync(tmp, sessionFile);   // rename(2): a reader sees the old file or the new one, never half of one
}

// `reason`: the recorded cleared_on_cancel line with another reason, one Claude Code may add that no rule names.
function write(kind: TranscriptKind, text = "", reason?: string) {
  if (!transcript) return;
  const line = own(T[kind], text) as Line;
  if (reason !== undefined && "reason" in line) line.reason = reason;
  if (typeof line.uuid === "string") lastUuid = line.uuid;
  appendFileSync(transcript, `${JSON.stringify(line)}\n`);
}

const RULE = "─".repeat(40);
function screen(): string {
  if (phase === "starting") return "Starting Claude Code…";
  if (phase === "trust") return readFileSync(TRUST, "utf8").replace(/\r?\n/g, "\r\n");
  if (status === "waiting") {
    return [" Bash command", "   npm run docs", "", ` ${question}`, " ❯ 1. Yes", "   2. No", "", " Esc to cancel · Tab to amend"].join("\r\n");
  }
  const line = input.replace(/\n/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
  return `${prose ? `${prose.replace(/\n/g, "\r\n")}\r\n\r\n` : ""}${status === "busy" ? "✻ Working… (esc to interrupt)\r\n" : ""}`
    + `${RULE}\r\n\x1b[38;5;246m❯ \x1b[39m${line}\r\n${RULE}\r\n  ? for shortcuts${status === "shell" ? " · 1 shell" : ""}`;
}
const draw = () => { process.stdout.write(`\x1b[H\x1b[2J${screen()}`); };

function setStatus(s: Status) { status = s; writeSession(); }
function exit() { draw(); setTimeout(() => process.exit(0), 100); }

// The transcript's opening lines (the shapes the fleet core's tests read, among them the uuid "seed-2" that
// integration.test.ts locates).
function seed(file: string) {
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  const t0 = clock() - 60_000;
  writeFileSync(file, [
    { type: "ai-title", aiTitle: "Fleet fixture" },
    { type: "user", uuid: "seed-1", timestamp: new Date(t0).toISOString(), origin: { kind: "human" }, message: { role: "user", content: "seeded prompt" } },
    { type: "assistant", uuid: "seed-2", timestamp: new Date(t0 + 1000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "seeded reply" }] } },
  ].map(l => JSON.stringify(l)).join("\n") + "\n");
}
// /clear or /new (ruling 17): a new session in the same process, so the same session file names a new id.
function newSession() {
  sessionId = randomUUID();
  transcript = transcriptOf(sessionId);
  lastUuid = null;
  queue = [];
  if (transcript) seed(transcript);
  setStatus("idle");
}

// submitted.jsonl is written last: a test that waits for the text there then finds its transcript line written too.
function submit() {
  const text = input;
  input = "";
  const submitted = () => appendFileSync(join(dir, "submitted.jsonl"), `${JSON.stringify(text)}\n`);
  if (text === "/exit" && status !== "busy") { submitted(); exit(); return; }
  if ((text === "/clear" || text === "/new") && status !== "busy") { newSession(); submitted(); return; }
  if (silent) { submitted(); return; }
  if (status === "busy" || queueNext) {
    if (queueNext) { queueNext = false; setStatus("busy"); }
    queue.push(text); write("enqueue", text);
  } else write("userTyped", text);
  submitted();
}
function interrupt(o: { restore?: boolean; queueNext?: boolean }) {
  const dropped = queue;
  queue = [];
  for (const t of dropped) write("removeCleared", t);
  if (o.restore && dropped.length) input = dropped.join("\n");
  if (o.queueNext) queueNext = true;
  setStatus("idle");
}
function removeAll(reason: string) {
  for (const t of queue) {
    if (reason === "absorbed_mid_turn") write("removeAbsorbed", t);
    else if (reason === "delivered_to_agent") write("removeDeliveredToAgent", t);
    else if (reason === "cleared_on_cancel") write("removeCleared", t);
    else write("removeCleared", t, reason);
  }
  queue = [];
}
function apply(c: Control) {
  if (c.silent !== undefined) silent = c.silent;
  if (c.swallowEnters !== undefined) { swallow = c.swallowEnters; replaceWith = c.replaceWith ?? null; }
  if (c.question !== undefined) question = c.question;
  if (c.clear) input = "";
  if (c.write) write(c.write, c.text ?? "");
  if (c.dequeue) write("dequeue");
  if (c.prompt && queue.length) { write("userQueued", queue.join("\n")); queue = []; }
  if (c.absorb) { for (const t of queue) { write("removeAbsorbed", t); write("queuedCommand", t); } queue = []; }
  if (c.remove !== undefined) removeAll(c.remove);
  if (c.interrupt) interrupt(c.interrupt);
  if (c.status) setStatus(c.status);
  if (c.queueNext) queueNext = true;
  if (c.exit) exit();
}

// Claude Code has started: the seeded transcript, the session file, the box.
function open() {
  if (transcript) seed(transcript);
  writeSession();
  draw();
}

// A key as the running Claude Code takes it.
function key(k: string) {
  if (phase === "starting") return;                                   // nothing reads the keyboard yet
  if (phase === "trust") {
    if (k === "Down") trustDown = true;
    else if (k === "Enter" && trustDown) { phase = "running"; open(); }
    else if (k === "Enter" || k === "Escape") process.exit(1);
    return;
  }
  if (status === "waiting") { if (["Enter", "Escape", "1", "2"].includes(k)) setStatus("idle"); return; }
  if (k === "Escape" || k === "C-c") { if (status === "busy") interrupt({}); else if (k === "C-c") input = ""; return; }
  if (k === "Enter") {
    if (swallow > 0) { swallow--; if (replaceWith !== null) { input = replaceWith; replaceWith = null; } return; }
    submit();
    return;
  }
  if (k.length === 1) input += k;
}

const controls = join(dir, "control.jsonl");
let readTo = 0;
let applied = 0;
setInterval(() => {
  if (!existsSync(controls)) return;
  const all = readFileSync(controls, "utf8");
  const end = all.lastIndexOf("\n") + 1;
  if (end <= readTo) return;
  for (const l of all.slice(readTo, end).split("\n").filter(Boolean)) { apply(JSON.parse(l) as Control); applied++; }
  readTo = end;
  writeFileSync(join(dir, "applied"), String(applied));
  draw();
}, 25);

const decoder = new StringDecoder("utf8");
process.stdin.setRawMode(true);
process.stdout.write("\x1b[?2004h");
process.stdin.on("data", (chunk: Buffer) => {
  appendFileSync(join(dir, "raw.bin"), chunk);
  pending += decoder.write(chunk);
  while (pending) {
    if (pending.startsWith("\x1b[200~")) { paste = true; pending = pending.slice(6); continue; }
    if (pending.startsWith("\x1b[201~")) { paste = false; pending = pending.slice(6); continue; }
    if (pending === "\x1b") { pending = ""; key("Escape"); continue; }   // a lone ESC is the Escape key: tmux writes a key in one go
    if (pending[0] === "\x1b") {
      const csi = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(pending);
      if (!csi && pending.length < 8) break;                             // the rest of the sequence is still on its way
      if (csi?.[0] === "\x1b[B") key("Down");                           // other keys are ignored
      pending = pending.slice(csi ? csi[0].length : 1);
      continue;
    }
    const ch = pending[0] ?? "";
    pending = pending.slice(1);
    if (paste) { if (phase === "running" && status !== "waiting") input += ch === "\r" ? "\n" : ch; }
    else if (ch === "\r") key("Enter");
    else if (ch === "\x15") { if (phase === "running") input = ""; }      // Ctrl-U: the draft is cleared
    else if (ch === "\x03") key("C-c");
    else if (ch >= " " && ch !== "\x7f") key(ch);
  }
  draw();
});

draw();
const begin = () => {
  phase = existsSync(join(dir, "untrusted")) ? "trust" : "running";
  if (phase === "running") open(); else draw();
};
if (startDelay > 0) setTimeout(begin, startDelay); else begin();
```

- [ ] **Step 5: Extend `test/fleet-harness.ts`**

Make eight edits.

1. **Imports.** Replace the line `import { FleetClient } from "../apps/hub/src/adapters/fleet-client.ts";` with the package Task 3 made (the hub's old module re-exports it for one release only). If Task 3 already switched this line, keep it and add only the `Control` import:

   ```ts
   import { FleetClient } from "@morndo/fleet-client";
   import type { Control } from "./fixtures/fake-claude-pane.ts";
   ```

   Then add `type Delivery as DrillDelivery` to the import from `../packages/protocol/src/fleet.ts`. The alias is the drill harness's own: `FleetDelivery` is the client's name for `Delivery & { stale }` (ruling 56). The import becomes:

   ```ts
   import { OP_NAMES, type Delivery as DrillDelivery, type Expect, type HookEvent, type OpName, type Pane } from "../packages/protocol/src/fleet.ts";
   ```

2. **`tempDir`.** Export it. Change `function tempDir(prefix: string, base = tmpdir()): string {` to `export function tempDir(prefix: string, base = tmpdir()): string {`.

3. **Lanes.** Replace the `Lane` type and `fakeLane` (from `export type Lane = {` to the end of `fakeLane`) with:

   ```ts
   export type Lane = {
     window: string; paneId: string; dir: string; sessionId: string | null; transcript: string | null;
     submitted(): string[]; screen(): string; draft(text: string): void; clear(): void;
     control(c: Control): Promise<void>;          // what Claude Code does next (test/fixtures/fake-claude-pane.ts, Control)
     entries(): Record<string, unknown>[];         // its transcript's lines, parsed
     enters(): number;                             // Enter presses since the last bracketed paste ended
   };
   // The box whose state dir is `dir` applies `c` (and every command before it) before this returns. A lane's state dir is its
   // window's working directory, so a lane that lane.start opened is reached by the directory it was started in.
   export async function controlAt(dir: string, c: Control): Promise<void> {
     const file = join(dir, "control.jsonl");
     const n = (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0) + 1;
     appendFileSync(file, `${JSON.stringify(c)}\n`);
     const done = join(dir, "applied");
     await until(`the box in ${dir} to apply ${JSON.stringify(c)}`, () => existsSync(done) && Number(readFileSync(done, "utf8")) >= n, 5000, 20);
   }
   export const submittedAt = (dir: string): string[] => {
     const file = join(dir, "submitted.jsonl");
     return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as string) : [];
   };
   // A lane: one window running the fake input box. With `claudeHome` (an agent's HOME), the box writes its session file and
   // transcript into <claudeHome>/.claude, so the agent reports its session and status and serves its transcript.
   // `startDelayMs`: the box shows Claude Code starting for that long; `wait: false` returns before the box is drawn.
   export async function fakeLane(t: TmuxServer, o: {
     window: string; session?: string; prose?: string; claudeHome?: string; offsetMs?: number; startDelayMs?: number; wait?: boolean;
   }): Promise<Lane> {
     const session = o.session ?? "qa";
     const dir = tempDir("morndo-lane-");
     if (o.prose) writeFileSync(join(dir, "prose.txt"), o.prose);
     const sessionId = o.claudeHome ? randomUUID() : null;
     const claude = o.claudeHome ? join(o.claudeHome, ".claude") : null;
     const paneId = openWindow(t, session, o.window, dir, [process.execPath, "--no-warnings", FAKE_CLAUDE, dir,
       ...(claude && sessionId ? [`--claude=${claude}`, `--session=${sessionId}`, `--tmux-session=${session}`] : []),
       ...(o.offsetMs ? [`--offset=${o.offsetMs}`] : []), ...(o.startDelayMs ? [`--start-delay=${o.startDelayMs}`] : [])]);
     const screen = () => t.run("capture-pane", "-p", "-t", paneId);
     if (o.wait !== false) await until(`${o.window}'s input box`, () => screen().includes("❯"), 10_000 + (o.startDelayMs ?? 0));
     const transcript = claude && sessionId ? join(claude, "projects", "-qa", `${sessionId}.jsonl`) : null;
     return {
       window: o.window, paneId, dir, sessionId, transcript,
       submitted: () => submittedAt(dir),
       screen,
       draft: text => { t.run("send-keys", "-t", paneId, "-l", text); },
       clear: () => { t.run("send-keys", "-t", paneId, "C-u"); },
       control: c => controlAt(dir, c),
       entries: () => (transcript && existsSync(transcript)
         ? readFileSync(transcript, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>) : []),
       enters: () => {
         const raw = existsSync(join(dir, "raw.bin")) ? readFileSync(join(dir, "raw.bin")).toString("latin1") : "";
         const end = raw.lastIndexOf("\x1b[201~");
         return end === -1 ? 0 : raw.slice(end).split("\r").length - 1;
       },
     };
   }
   ```

4. **The fleet's config.** In `startFleet`, change the signature to

   ```ts
   export async function startFleet(o: {
     subscribers?: FleetConfig["subscribers"]; stickyLanes?: string[]; laneEvents?: Partial<FleetConfig["laneEvents"]>;
   } = {}): Promise<Fleet> {
   ```

   and replace the `const config: FleetConfig = { … };` literal with:

   ```ts
     const config: FleetConfig = {
       listen: { host: "127.0.0.1", port }, socketPath: join(sockDir, "fleet.sock"),
       dbPath: join(home, ".local/share/morndo-fleet/fleet.db"), keyPath: join(home, ".local/share/morndo-fleet/fleet-key.pem"),
       publicUrl: `ws://127.0.0.1:${port}/agent`, subscribers: o.subscribers ?? [],
       stickyLanes: o.stickyLanes ?? ["manager"],
       // Off unless a test turns it on: a lane-event batch typed into a lane named "manager" would land in drills that count
       // what that lane received (the fleet core's retry drills have one).
       laneEvents: { deliverTo: null, header: "[lane-event] Lane events (handle them as your instructions say):", ignore: [], batchMs: 3000, ...o.laneEvents },
     };
   ```

   If Tasks 7–9 already wrote these two fields into the literal, this replaces their lines.

5. **Agents.** In the `Agent` type, change `run(hooks?: TestHooks): Promise<void>;` to `run(hooks?: TestHooks, o?: { env?: Record<string, string> }): Promise<void>;`. In `agentAt`, replace the `run` method with:

   ```ts
       async run(hooks, o = {}) {
         // The agent refuses test hooks unless NODE_ENV is "test" and its HOME isn't the account's own (Task 8 of the fleet core).
         const extra: Record<string, string> = { ...(hooks ? { MORNDO_NODE_TEST_HOOKS: JSON.stringify(hooks), NODE_ENV: "test" } : {}), ...o.env };
         proc = startProc(`agent ${node} (${home})`, [AGENT_MAIN, "run"], cleanEnv(home, extra), join(home, "agent.log"));
       },
   ```

   Add after `agentAt`:

   ```ts
   // The agent's policy.json with these fields changed, before run() (the agent reads it at start). A policy the agent would
   // refuse fails here, with the setting named, not in the agent's log.
   export function updatePolicy(agent: Agent, patch: Partial<AgentConfig["policy"]>): void {
     const file = agentPaths(agent.home).policyFile;
     writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>), ...patch }, null, 2), { mode: 0o600 });
     loadConfig(agent.home);
   }
   ```

6. **The hook subscriber and a delivery watch.** Replace `export type Delivery = …`, `export type Subscriber = …` and `subscriber()` with:

   ```ts
   export type Delivery = { key: string; event: HookEvent; got: number; path: string; headers: Record<string, string> };
   export type Subscriber = { url: string; received: Delivery[]; unique(): Map<string, Delivery> };
   // Records each request before it answers, after `delayMs`, so a fleet killed mid-request redelivers it (at least once).
   // `answer` picks each answer's status (default 200): a subscriber that refuses, as kira did while Telegram blocked it.
   // `path`: the URL's path, "/hook" by default (the doc test uses kira's, "/fleet/hook").
   export async function subscriber(o: { delayMs?: number; path?: string; answer?: (d: Delivery) => number } = {}): Promise<Subscriber> {
     const received: Delivery[] = [];
     const server = createHttpServer((req, res) => {
       const parts: Buffer[] = [];
       req.on("data", (d: Buffer) => parts.push(d));
       req.on("end", () => {
         const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")]));
         const d: Delivery = {
           key: headers["idempotency-key"] ?? "", event: JSON.parse(Buffer.concat(parts).toString()) as HookEvent, got: performance.now(),
           path: (req.url ?? "/").split("?")[0] ?? "/", headers,
         };
         received.push(d);
         setTimeout(() => res.writeHead(o.answer?.(d) ?? 200).end(), o.delayMs ?? 0);
       });
     });
     await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
     closers.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
     return {
       url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${o.path ?? "/hook"}`,
       received,
       unique: () => { const m = new Map<string, Delivery>(); for (const d of received) if (!m.has(d.key)) m.set(d.key, d); return m; },
     };
   }

   // Deliveries as the fleet publishes them (`delivery` events) and mirrors them (GET /v1/deliveries/<id>). `states` keeps
   // every state an id went through, so a drill can tell it waited for a menu after it has moved on; `until` polls the mirror
   // and also accepts a state already published.
   export type DeliveryWatch = {
     states(id: string): (DrillDelivery & { stale: boolean })[];
     until(id: string, what: (d: DrillDelivery) => boolean, ms?: number): Promise<DrillDelivery>;
   };
   export async function watchDeliveries(fleet: Fleet): Promise<DeliveryWatch> {
     const seen = new Map<string, (DrillDelivery & { stale: boolean })[]>();
     let open = false;
     closers.push(fleet.client.events(e => {
       if (e.t !== "delivery") return;
       const d = e.body as DrillDelivery & { stale: boolean };
       seen.set(d.id, [...(seen.get(d.id) ?? []), d]);
     }, { onOpen: () => { open = true; } }));
     await until("the fleet's events subscription", () => open);
     return {
       states: id => seen.get(id) ?? [],
       until: (id, what, ms = 30_000) => until(`delivery ${id}: ${what.toString().slice(0, 100)}`, async () => {
         const now = await fleet.client.delivery(id);
         if (now && what(now)) return now;
         return seen.get(id)?.find(what) ?? null;
       }, ms, 200),
     };
   }
   ```

   The fleet core's drills take nothing else from these functions: they read `key`, `event` and `got`, which keep their meaning.

7. **`waitOnline` waits until the node answers** (ruling 37). A restored agent is welcomed, turns the welcome down (it starts a new store) and redials (`connection.ts`, `admit`). The old `waitOnline` could pass on that first connection's "online", and the next op then landed in the gap. `drills-retry`'s (b‴) failed that way under load (part 03, "How this part was checked"), and three times in a row on PR #25's CI. **PR #27 puts this exact method on `main`.** If `agentAt`'s `waitOnline` already reads as below, skip this edit. If it is still the one-line `async waitOnline(ms = 15_000) { await until(`${node} online`, async () => (await status()) === "online", ms); },`, replace it with:

   ```ts
       // Online, and answering: a read through the fleet (op.status starts nothing, and moves no store sequence) answers
       // ok twice, 300 ms apart, from one store, with the node still online after. A connection the agent turns down
       // answers neither, and a new store after it shows as another store.
       async waitOnline(ms = 15_000) {
         await until(`${node} online and answering`, async () => {
           if ((await status()) !== "online") return false;
           const first = await fleet.client.op({ node }, "op.status", { key: "hub:wait-online" });
           if (!first.ok) return false;
           await sleep(300);
           const again = await fleet.client.op({ node }, "op.status", { key: "hub:wait-online" });
           return again.ok && again.store === first.store && (await status()) === "online";
         }, ms);
       },
   ```

   Every fleet test's agent may run `op.status`: the harness writes `ops: ALL_OPS` into each policy, and no test narrows it.

8. **A hub that can restart on its own database** (ruling 66's drills). A drill restarts the same hub:
   - killed (`SIGKILL`) between queuing an answer and recording it;
   - with the queue switched off (step 2's rollback, spec §13);
   - with its database put back from a copy (step 1's rollback restores the databases).

   `startHub` makes a new hub with a HOME of its own each time, so `Hub` gains `restart`, `get` and `log`. These edits leave alone the lines Task 12 changed in Step 12.49: the signature with `managerQueue`, and the `MORNDO_MANAGER_QUEUE` line.

   In the `Hub` type, replace `  feed(): Promise<FeedWatch>; audit(): string; pairUrl(): string; stop(): Promise<void>;` with:

   ```ts
     feed(): Promise<FeedWatch>; audit(): string; pairUrl(): string; stop(): Promise<void>;
     get(path: string): Promise<Reply>;                      // a GET with the seeded session's cookie
     log(): string;                                          // the hub's log so far, every start included
     // Stops the hub (SIGTERM by default), runs `whileStopped`, and serves again on the same HOME, port and database, with the
     // manager queue switched as asked (unchanged when not given); resolves once it listens again.
     restart(o?: { signal?: NodeJS.Signals; managerQueue?: boolean; whileStopped?: () => Promise<void> }): Promise<void>;
   ```

   In `startHub`, replace everything from `  const env = cleanEnv(home, extra);` to the end of the function with:

   ```ts
     const env = cleanEnv(home, extra);
     const secret = seedSession(home);
     const log = join(home, "hub.log");
     const logText = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
     const starts = () => logText().split("morndo hub on").length - 1;
     let current = env;
     let proc: Proc | null = null;
     // The hub on this HOME, port and database; listening once its log says "morndo hub on" once more than before.
     const serve = async (e: NodeJS.ProcessEnv) => {
       const before = starts();
       const p = startProc("hub", [HUB_MAIN, "serve"], e, log);
       proc = p;
       await until("the hub listening", () => {
         if (!p.alive()) throw new Fatal(`the hub exited during startup (${p.child.exitCode ?? p.child.signalCode})\n${p.tail(15)}`);
         return starts() > before;
       }, 30_000);
     };
     await serve(env);
     const headers = { origin, "content-type": "application/json", cookie: `__Host-morndo=${secret}` };
     const post = async (path: string, body: unknown): Promise<Reply> => {
       const r = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
       return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
     };
     const get = async (path: string): Promise<Reply> => {
       const r = await fetch(base + path, { headers });
       return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
     };
     const cli = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", HUB_MAIN, ...args], { env: current, encoding: "utf8", timeout: 30_000 }).stdout ?? "";
     return {
       base, origin, port, home, env, cookie: secret, post, get,
       send: (workerId, text, requestId = randomUUID()) => post(`/api/workers/${encodeURIComponent(workerId)}/send`, { text, requestId, seen: "none" }),
       answer: (id, key, requestId = randomUUID()) => post(`/api/escalations/${encodeURIComponent(id)}/answer`, { key, requestId }),
       feed: () => openFeed(base, origin, secret),
       audit: () => cli("audit", "200"),
       pairUrl: () => cli("pair").split("\n").find(l => l.includes("/pair#t="))?.trim() ?? "",
       log: logText,
       stop: async () => { await proc?.stop(); },
       async restart(o = {}) {
         await proc?.stop(o.signal ?? "SIGTERM");
         await o.whileStopped?.();
         if (o.managerQueue !== undefined) {
           // On is the hub's own default with a fleet (Task 12): the setting is left out; off is "off".
           const { MORNDO_MANAGER_QUEUE: _, ...rest } = current;
           current = o.managerQueue ? rest : { ...rest, MORNDO_MANAGER_QUEUE: "off" };
         }
         await serve(current);
       },
     };
   }
   ```

- [ ] **Step 6: Run the box's test, then the whole fleet project**

Run: `npx vitest run --project fleet test/fleet/fake-box.test.ts`

Expected: PASS, `Tests  10 passed (10)`. If a verdict differs from the expected one, two things can be wrong: Task 2's `readReceipts`, or the recorded lines it was written against. Find out which before changing either. Task 2 owns both. This box only makes them its own.

Run: `npx vitest run --project fleet`

Expected: PASS. Every fleet core file still passes, among them `integration.test.ts` (it locates `seed-2` in the box's transcript) and the retry drills (they count submits). `drills-retry`'s (b‴) now waits for an agent that answers (edit 7). Run it 4 times beside the other fleet files to see the gap closed: `for i in 1 2 3 4; do npx vitest run --project fleet test/fleet/drills-retry.test.ts test/fleet/drills-stream.test.ts test/fleet/integration.test.ts test/fleet/harness.test.ts || break; done`. Only `fake-box.test.ts` is new so far.

Run: `npm run check`

Expected: exit 0. If `FleetConfig` or `Policy` gained a required field the Contracts don't show, the type check names it. Fill it into `startFleet` or `updatePolicy` as its default.

- [ ] **Step 7: Commit**

```bash
git add test/fixtures/fake-claude-pane.ts test/fleet-harness.ts test/fleet/fake-box.test.ts
git commit -m "test(fleet): the fake input box writes the recorded 2.1.293 shapes, steered by a control file; waitOnline waits for answers"
```

- [ ] **Step 8: Write `test/fleet/drills-deliveries.test.ts`: waiting, Enter again, the agent killed while typing**

```ts
// Delivery drills, part 1 (fleet clients spec §12 "Drills", §4.3 "How the agent delivers"), end to end: a real fleet and a
// real node agent (child processes, temporary HOMEs, random ports, an isolated tmux server; test/fleet-harness.ts), with a
// lane that is the fake input box (test/fixtures/fake-claude-pane.ts). The box writes its session file's status and its
// transcript in the 2.1.293 shapes (Task 2's recorded lines, test/fixtures/claude-code/2.1.293), and the test tells it what the CLI does
// next: open a menu, keep a line in the box after Enter, let the owner type over it.
// Real: the fleet's routing and mirror, the agent's queue in agent.db, its done keys, pane.send's checks, the receipt read
// from the transcript. Placed by a test hook: the agent's own death right after a typing (killAfterEffect), between the
// paste and the done key, which a kill from outside can't time.
// Negative control (spec §12: "without the started check, the restarted agent types again"): the same death with the
// agent's done keys off (noDoneKeys) types the delivery a second time.
// Also (plan/RECONCILIATION.md): a lane whose session runs a shell command takes deliveries (ruling 11), and a delivery
// that never gets its receipt holds the next one for at most 60 s (ruling 16).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { TestHooks } from "../../apps/node-agent/src/test-hooks.ts";
import { LIMITS } from "../../packages/protocol/src/fleet.ts";
import { fakeLane, joinAgent, paneOf, sleep, startFleet, stopAll, tmuxServer, until, watchDeliveries } from "../fleet-harness.ts";

afterEach(stopAll);

// One node with one lane running the box, w1, idle, and a watch on the fleet's deliveries.
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
const newId = (what: string) => `lanes:drill-${what}-${randomUUID().slice(0, 8)}`;
const times = (xs: string[], x: string) => xs.filter(t => t === x).length;
// A try runs on every change the agent sees and at least every LIMITS.deliveryTryMs: past one more period, nothing more
// was typed.
const PAST_A_TRY = LIMITS.deliveryTryMs + 2000;

describe("a delivery waits until the lane can take it, then types once", () => {
  it("waits through the owner's draft and then a menu, never typing over either, then types once", async () => {
    const o = await office();
    o.w1.draft("the owner's half thought");
    await until("the draft on w1", () => o.w1.screen().includes("the owner's half thought"));
    const id = newId("menu");
    expect(await o.fleet.client.deliver({ id, lane: "w1", text: "after the menu" })).toMatchObject({ state: "queued", node: "n1" });
    await o.watch.until(id, d => d.state === "queued" && d.waiting?.reason === "draft_present");
    await o.w1.control({ status: "waiting", question: "Run the docs build?" });
    await o.watch.until(id, d => d.state === "queued" && d.waiting?.reason === "menu_open");
    expect(o.w1.submitted()).toEqual([]);
    await o.w1.control({ status: "idle", clear: true });           // the menu answered and the draft gone, in one step
    await o.watch.until(id, d => d.state === "delivered");
    await sleep(PAST_A_TRY);
    expect(o.w1.submitted()).toEqual(["after the menu"]);
  });

  it("presses Enter again while its own text stays in the box, and the line is taken once", async () => {
    const o = await office();
    await o.w1.control({ swallowEnters: 1 });
    const id = newId("stuck");
    await o.fleet.client.deliver({ id, lane: "w1", text: "a stuck line" });
    await o.watch.until(id, d => d.state === "delivered");
    expect(o.w1.submitted()).toEqual(["a stuck line"]);
    expect(o.w1.enters()).toBe(2);                                  // the paste's own Enter, and one more
  });

  it("never presses Enter over another text: the owner's words took its line's place, and stay unsent", async () => {
    const o = await office();
    await o.w1.control({ swallowEnters: 1, replaceWith: "the owner's own words" });
    const id = newId("replaced");
    await o.fleet.client.deliver({ id, lane: "w1", text: "a line the owner typed over" });
    await o.watch.until(id, d => d.state === "typed");
    await sleep(PAST_A_TRY);
    expect(o.w1.enters()).toBe(1);
    expect(o.w1.submitted()).toEqual([]);
    expect(o.w1.screen()).toContain("the owner's own words");
    expect((await o.fleet.client.delivery(id))?.state).toBe("typed");
  });

  it("presses Enter at most twice more on a line that never leaves the box", async () => {
    const o = await office();
    await o.w1.control({ swallowEnters: 50 });
    const id = newId("stuck-forever");
    await o.fleet.client.deliver({ id, lane: "w1", text: "never taken" });
    await o.watch.until(id, d => d.state === "typed");
    await sleep(2 * PAST_A_TRY);
    expect(o.w1.enters()).toBeGreaterThanOrEqual(2);
    expect(o.w1.enters()).toBeLessThanOrEqual(3);
    expect(o.w1.submitted()).toEqual([]);
  });
});

describe("the agent killed while typing", () => {
  it("started again, it never types the delivery a second time, and confirms it from the transcript", async () => {
    const id = newId("killed");
    const o = await office({ killAfterEffect: id });
    const text = "typed as the agent died";
    await o.fleet.client.deliver({ id, lane: "w1", text });
    await until("the agent gone", () => !o.agent.proc()?.alive(), 15_000);
    expect(o.w1.submitted()).toEqual([text]);                     // typed, and the done key never written
    await o.agent.run();                                             // as shipped: no hook
    await o.agent.waitOnline();
    await o.watch.until(id, d => d.state === "delivered", 30_000);
    await sleep(PAST_A_TRY);
    expect(times(o.w1.submitted(), text)).toBe(1);
  });

  it("(negative control) without its done keys, the restarted agent types the delivery again", async () => {
    const id = newId("killed-nokeys");
    const o = await office({ killAfterEffect: id, noDoneKeys: true });
    const text = "typed as the agent died, without keys";
    await o.fleet.client.deliver({ id, lane: "w1", text });
    await until("the agent gone", () => !o.agent.proc()?.alive(), 15_000);
    await o.agent.run({ noDoneKeys: true });
    await o.agent.waitOnline();
    await until("the second typing", () => times(o.w1.submitted(), text) === 2, 30_000);
  });
});

describe("a session running a shell command (status shell) is alive (RECONCILIATION.md ruling 11)", () => {
  it("takes a delivery as when idle, and types it once", async () => {
    const o = await office();
    await o.w1.control({ status: "shell" });
    await until("w1 shell in n1's inventory", async () => (await paneOf(o.fleet.client, "n1", "w1")).status === "shell", 15_000);
    const id = newId("shell");
    await o.fleet.client.deliver({ id, lane: "w1", text: "beside the shell command" });
    await o.watch.until(id, d => d.state === "delivered");
    await sleep(PAST_A_TRY);
    expect(o.w1.submitted()).toEqual(["beside the shell command"]);
    expect(o.watch.states(id).some(d => d.waiting?.reason === "no_session")).toBe(false);
  });
});

// Rulings 16 and 42: a typed or held delivery waiting for its receipt holds the next one back (`earlier`) for at most
// LIMITS.deliveryReceiptHoldMs (60 s).
const HOLD_MS = LIMITS.deliveryReceiptHoldMs;

describe("a delivery waiting for its receipt holds the next one for at most 60 s (ruling 16)", () => {
  it("the next one waits (earlier), types once the minute is up, and is confirmed by its own receipt", async () => {
    const o = await office();
    await o.w1.control({ silent: true });                            // the first line never reaches the transcript
    const first = newId("no-receipt");
    await o.fleet.client.deliver({ id: first, lane: "w1", text: "never confirmed" });
    const a = await o.watch.until(first, d => d.state === "typed");
    await o.w1.control({ silent: false });
    const next = newId("next");
    await o.fleet.client.deliver({ id: next, lane: "w1", text: "the next one" });
    await o.watch.until(next, d => d.state === "queued" && d.waiting?.reason === "earlier");
    const b = await o.watch.until(next, d => d.state === "delivered", HOLD_MS + 30_000);
    const held = (b.typedAt ?? 0) - (a.typedAt ?? 0);                 // both on the node's clock
    expect(held).toBeGreaterThanOrEqual(HOLD_MS - 1000);
    expect(held).toBeLessThanOrEqual(HOLD_MS + LIMITS.deliveryTryMs + 3000);
    expect(o.w1.submitted()).toEqual(["never confirmed", "the next one"]);
    expect((await o.fleet.client.delivery(first))?.state).toBe("typed");   // still waiting for its own receipt
  }, 150_000);
});
```

- [ ] **Step 9: Write `test/fleet/drills-receipts.test.ts`: receipts and the interrupt's one retype**

```ts
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
```

- [ ] **Step 10: Write `test/fleet/drills-lanes.test.ts`: the manager's restart, a session that changed, `lane.start` through the shell**

```ts
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
```

- [ ] **Step 11: Write `test/fleet/drills-lane-events.test.ts`: batches to the manager, a fleet restart, a subscriber that refuses**

```ts
// Lane-event and hook-bus drills (fleet clients spec §12 "Drills"; §7 lane events, §6 the subscriber contract): a real
// fleet and agent; lanes that are the fake input box (test/fixtures/fake-claude-pane.ts); hooks posted to the agent's own
// relay in the CLI's Stop form (https://code.claude.com/docs/en/hooks, "Stop", read 2026-10-08).
// - The manager gets lane events in batches, as one delivery per batch: a header line, then one JSON line per event.
//   Its own lane, the lanes `laneEvents.ignore` matches, and `answered` are not sent.
// - The events not yet delivered when the fleet is killed are sent once it runs again (they were in its synced intake).
// - A subscriber answering 503 holds its stream (the bus sends one event at a time, in order), raises subscriber_lagging
//   once its oldest undelivered event is 60 s old, and loses nothing once it answers again. That one takes about two
//   minutes: the lag itself, then the bus's backoff (up to 64 s by then) before its next try.
import { afterEach, describe, expect, it } from "vitest";
import type { FleetConfig } from "../../apps/fleet/src/config.ts";
import { LIMITS } from "../../packages/protocol/src/fleet.ts";
import {
  fakeLane, hook, joinAgent, keyParts, paneOf, sleep, startFleet, stopAll, subscriber, tmuxServer, until, type Agent, type Lane,
} from "../fleet-harness.ts";

afterEach(stopAll);

const HEADER = "[lane-event] Drill events:";
type Line = { lane: string; event: string; status: string | null; sessionId: string | null };

async function office(laneEvents: Partial<FleetConfig["laneEvents"]> = {}) {
  const fleet = await startFleet({ laneEvents: { deliverTo: "manager", header: HEADER, ignore: ["pooltest*"], ...laneEvents } });
  const tmux = tmuxServer();
  const agent = await joinAgent(fleet, "n1", { tmux });
  const lane = (window: string) => fakeLane(tmux, { window, claudeHome: agent.home });
  const manager = await lane("manager");
  const w1 = await lane("w1");
  const w2 = await lane("w2");
  const pool = await lane("pooltest-1");
  await agent.run();
  await agent.waitOnline();
  for (const w of ["manager", "w1", "w2", "pooltest-1"]) {
    await until(`${w} idle in n1's inventory`, async () => (await paneOf(fleet.client, "n1", w)).status === "idle", 15_000);
  }
  return { fleet, agent, manager, w1, w2, pool };
}
// A turn's end, as the CLI's Stop hook posts it.
const stopped = (agent: Agent, lane: Lane, text: string) => hook(agent, "/hook/stop", {
  session_id: lane.sessionId, transcript_path: lane.transcript, cwd: lane.dir, permission_mode: "default", hook_event_name: "Stop",
  last_assistant_message: text, background_tasks: [], session_crons: [],
});
// What the manager received as lane events: each batch's JSON lines, in the order typed.
const batches = (manager: Lane): Line[][] =>
  manager.submitted().filter(t => t.startsWith(HEADER)).map(t => t.split("\n").slice(1).filter(Boolean).map(l => JSON.parse(l) as Line));

describe("lane events delivered to the manager", () => {
  it("in one batch per window; not the manager's own lane, not ignored lanes, and answered is published only", async () => {
    const o = await office();
    for (const r of await Promise.all([
      stopped(o.agent, o.w1, "STATUS: DONE\nshipped the docs"),
      stopped(o.agent, o.w2, "STATUS: BLOCKED\nneeds the staging key"),
      stopped(o.agent, o.pool, "STATUS: DONE\na pool probe"),
      stopped(o.agent, o.manager, "STATUS: DONE\nthe manager's own turn"),
    ])) expect(r.status).toBe(200);
    await until("one batch at the manager", () => batches(o.manager).length === 1, 20_000);
    const [batch = []] = batches(o.manager);
    expect(batch.map(e => [e.lane, e.event, e.status]).sort((a, b) => a.join().localeCompare(b.join()))).toEqual([["w1", "finished", "done"], ["w2", "finished", "blocked"]]);
    expect(batch.find(e => e.lane === "w1")?.sessionId).toBe(o.w1.sessionId);
    await o.w1.control({ status: "waiting", question: "Merge the docs branch?" });
    await until("needs_input published", async () => (await o.fleet.client.laneEvents(0)).some(e => e.event === "needs_input" && e.lane === "w1"), 15_000);
    expect((await o.fleet.client.laneEvents(0)).find(e => e.event === "needs_input")?.question).toBe("Merge the docs branch?");
    await o.w1.control({ status: "idle" });
    await until("answered published", async () => (await o.fleet.client.laneEvents(0)).some(e => e.event === "answered" && e.lane === "w1"), 15_000);
    await until("the second batch", () => batches(o.manager).length === 2, 20_000);
    await sleep(LIMITS.laneEventBatchMs + 3000);
    const all = batches(o.manager).flat();
    expect(all.filter(e => e.event === "needs_input")).toHaveLength(1);
    expect(all.some(e => e.event === "answered")).toBe(false);
    expect(all.some(e => e.lane === "manager" || e.lane === "pooltest-1")).toBe(false);
    expect(batches(o.manager)).toHaveLength(2);
  });

  it("the ones not yet delivered when the fleet dies are sent once it runs again, once", async () => {
    const o = await office({ batchMs: 6000 });
    expect((await stopped(o.agent, o.w1, "STATUS: DONE\nbefore the crash")).status).toBe(200);
    await until("the event in the fleet", async () => (await o.fleet.client.laneEvents(0)).some(e => e.lane === "w1" && e.event === "finished"), 5000, 50);
    expect(batches(o.manager)).toEqual([]);                          // still inside its 6 s batch
    await o.fleet.restart("SIGKILL");
    await until("the batch after the restart", () => batches(o.manager).length === 1, 30_000);
    expect(batches(o.manager)[0]?.map(e => [e.lane, e.event])).toEqual([["w1", "finished"]]);
    await sleep(8000);
    expect(batches(o.manager)).toHaveLength(1);
  });
});

describe("the subscriber contract", () => {
  it("a subscriber answering 503 holds its stream, raises subscriber_lagging, and loses nothing once it answers", async () => {
    let refusing = true;
    const sub = await subscriber({ answer: () => (refusing ? 503 : 200) });
    const fleet = await startFleet({ subscribers: [{ name: "slow", url: sub.url, paths: ["/notify"] }] });
    const tmux = tmuxServer();
    const agent = await joinAgent(fleet, "n1", { tmux });
    await agent.run();
    await agent.waitOnline();
    for (let i = 0; i < 5; i++) expect((await hook(agent, "/notify", { window: "w1", text: `note ${i}` })).status).toBe(202);
    await until("the first event tried", () => sub.received.length > 0, 15_000);
    const alert = await until("subscriber_lagging", async () => (await fleet.client.alerts()).find(a => a.kind === "subscriber_lagging") ?? null, 100_000, 1000);
    expect(alert.detail).toMatchObject({ subscriber: "slow" });
    expect(new Set(sub.received.map(d => d.key)).size).toBe(1);     // only the first event, tried again and again
    refusing = false;
    await until("all five delivered", () => sub.unique().size === 5, 120_000, 500);
    const got = [...sub.unique().values()];
    expect(got.map(d => keyParts(d.key).seq)).toEqual(got.map(d => keyParts(d.key).seq).sort((a, b) => a - b));
    expect(got.map(d => (d.event.body as { text: string }).text)).toEqual(["note 0", "note 1", "note 2", "note 3", "note 4"]);
  }, 240_000);
});
```

- [ ] **Step 12: Write `test/fleet/drills-lanes-cli.test.ts`: `morndo lanes` against a real fleet and agent (ruling 57)**

The command runs as the owner runs it: its own child process (`node apps/hub/src/main.ts lanes …`, Task 14), with `MORNDO_FLEET_SOCKET` set and a HOME of its own.

How the in-doubt exit (5, ruling 49) is reached: the fleet's process is stopped (`SIGSTOP`, the harness's `Proc.pause()`) while the command sends. The kernel still accepts the connection on the fleet's Unix socket and takes the request, and no answer comes. Once continued, the fleet reads the request after all. This was checked on 2026-10-08 with a node HTTP server on a Unix socket:
- the client connected after 7 ms;
- it got no answer, a timeout rather than a refused connection;
- the stopped server took the POST once it was continued.

```ts
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
```

- [ ] **Step 13: Write `test/fleet/drills-manager-queue.test.ts`: the hub's manager queue through a real fleet (ruling 66)**

Task 12 turns the queue on by default wherever the hub has a fleet. So this drill runs the hub as it ships (`startHub(fleet, { managerQueue: true })`, explicit whatever the harness's default), with a real fleet and agent and the manager as the box with a live session. The fleet core's `drills-retry` and `duplicate-names` drill the direct path, with the queue off (part 04, Step 12.49).

Two of its cases restart the same hub (edit 8):
- killed between queuing an answer and recording it (drill (f) of the fleet core's durability work, on the queue);
- switched off, with its database put back from a copy taken before an answer, as §13's step-1 rollback does.

The second is the one place where the hub types directly an answer the queue already typed. The node's done key, which the queue's typing and the direct send share, is then what keeps it to once (§9.1); its "(negative control)" takes that key away (`noDoneKeys`).

```ts
// The hub's manager queue through a real fleet (plan/RECONCILIATION.md ruling 66; fleet clients spec §9.1, §13 steps 1 and
// 2): the hub with MORNDO_MANAGER_QUEUE on, a real fleet and node agent (test/fleet-harness.ts: random ports, temporary
// HOMEs, an isolated tmux server), and the manager as the fake input box with a live session
// (test/fixtures/fake-claude-pane.ts), so a delivery is typed and confirmed from its transcript. The ask is the
// manager's needs-you list's ny-1, as in drills-retry.
// - An answer and a message to the manager are each queued under the hub's key, typed once and confirmed; the answer's
//   card ends "Delivered" (its Decision's delivery state), and its EscalationAnswered is recorded once.
// - Answer in flight (drill (f) of the fleet core's durability work, on the queue): the hub is killed after it queued an
//   answer and before it recorded it; restarted, it records it once, and nothing is delivered or typed a second time.
// - Switched off (step 2's rollback):
//   - an answer still queued is cancelled at start, its ask opens again, and its direct answer types it once;
//   - a direct retry of an answer already typed finds its key on the node and is not typed again (§9.1: "nothing is typed
//     twice"). The hub only types such an answer again when it no longer knows it: here its database is put back from a
//     copy taken before the answer, as step 1's rollback does. The manager's box writes no transcript line for that answer
//     (`silent`), so the restored hub sees no echo of the tap and takes the ask as open.
// Negative control: the same retry with the node's done keys off (noDoneKeys) types the answer a second time. The key the
// queue and the direct send share is what keeps it to once.
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestHooks } from "../../apps/node-agent/src/test-hooks.ts";
import { LIMITS } from "../../packages/protocol/src/fleet.ts";
import { fakeLane, joinAgent, paneOf, sleep, startFleet, startHub, stopAll, tmuxServer, until, type Fleet, type Hub } from "../fleet-harness.ts";

afterEach(stopAll);

const TAP = "[tap ny-1] ship (Ship it)";                     // what the hub types for that answer (drills-retry's TAP)
const PAST_A_TRY = LIMITS.deliveryTryMs + 2000;
const times = (xs: string[], x: string) => xs.filter(t => t === x).length;

// n1 with the manager's lane (the box, a live session), and the hub with its queue on and the needs-you list's ny-1 open.
async function office(hooks: TestHooks = {}) {
  const fleet = await startFleet();
  const tmux = tmuxServer();
  const agent = await joinAgent(fleet, "n1", { tmux });
  const manager = await fakeLane(tmux, { window: "manager", claudeHome: agent.home });
  await agent.run(hooks);
  await agent.waitOnline();
  await until("the manager idle in n1's inventory", async () => (await paneOf(fleet.client, "n1", "manager")).status === "idle", 15_000);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const hub = await startHub(fleet, { managerQueue: true, ledger: { needsYou: [{ id: "ny-1", kind: "tap", question: "Ship the drill build?",
    options: [{ key: "ship", label: "Ship it" }, { key: "hold", label: "Hold" }], deadline: tomorrow, ts: new Date(Date.now() - 60_000).toISOString() }] } });
  await until("the hub's start line: manager queue on", () => /manager queue: on\n/.test(hub.log()), 15_000);
  const feed = await hub.feed();
  await until("the manager on the hub", () => feed.names.has("manager"), 15_000);
  const managerId = (await paneOf(fleet.client, "n1", "manager")).workerId;
  return { fleet, agent, manager, hub, managerId };
}
type Office = Awaited<ReturnType<typeof office>>;

const statusIs = (o: Office, s: string) =>
  until(`the manager ${s} in n1's inventory`, async () => (await paneOf(o.fleet.client, "n1", "manager")).status === s, 15_000);
// The hub's view of ny-1 (GET /api/escalations): open or not, and its Decision's delivery state, which its card shows
// ("Queued, it will be delivered", "Delivered", "May have been delivered").
type Item = { id: string; status: string; decision: { delivery?: { state: string } } | null };
const ask = async (hub: Hub) => ((await hub.get("/api/escalations")).body.items as Item[] | undefined)?.find(i => i.id === "ny-1") ?? null;
// The fleet's deliveries whose id is the hub's answer key for ny-1, hub:answer:ny-1:<ask>:<choice> (§9.1).
const answers = async (fleet: Fleet) => (await fleet.client.deliveries({ lane: "manager" })).filter(d => d.id.startsWith("hub:answer:ny-1:"));
const recorded = (hub: Hub) => hub.audit().split("\n").filter(l => l.includes("EscalationAnswered") && l.includes("ny-1")).length;
async function theAnswer(o: Office, state: string) {
  return until(`ny-1's delivery ${state}`, async () => (await answers(o.fleet)).find(d => d.state === state) ?? null, 30_000, 250);
}

describe("an answer and a message to the manager, through the queue", () => {
  it("an answer: queued under the hub's key, typed once, confirmed; its card ends Delivered; recorded once", async () => {
    const o = await office();
    expect(await o.hub.answer("ny-1", "ship")).toMatchObject({ status: 200, body: { ok: true } });
    const d = await theAnswer(o, "delivered");
    expect(d.id).toMatch(/^hub:answer:ny-1:[^:]+:option:ship$/);   // the key a direct send types under (§9.1)
    await until("its card Delivered", async () => (await ask(o.hub))?.decision?.delivery?.state === "delivered", 15_000);
    await until("recorded", () => recorded(o.hub) === 1, 15_000);
    await sleep(PAST_A_TRY);
    expect(times(o.manager.submitted(), TAP)).toBe(1);
    expect(recorded(o.hub)).toBe(1);
    expect(await answers(o.fleet)).toHaveLength(1);
  });

  it("a message: queued as hub:<endpoint>:<request>, typed once, confirmed; its repeat says delivered and types nothing", async () => {
    const o = await office();
    const rid = randomUUID();
    expect(await o.hub.send(o.managerId, "status, please", rid)).toMatchObject({ status: 200, body: { ok: true, delivery: { requestId: rid } } });
    const id = await until("the message's delivery", async () => (await o.fleet.client.deliveries({ lane: "manager" })).find(d => d.id.endsWith(`:${rid}`))?.id ?? null);
    expect(id).toMatch(new RegExp(`^hub:fleet-test-[0-9a-f]{8}:${rid}$`));   // the hub's key: hub:<endpoint>:<request>
    await until("the message delivered", async () => (await o.fleet.client.delivery(id))?.state === "delivered", 30_000);
    const again = await until("the hub's own state: delivered", async () => {
      const r = await o.hub.send(o.managerId, "status, please", rid);
      return (r.body.delivery as { state?: string } | undefined)?.state === "delivered" ? r : null;
    }, 15_000, 500);
    expect(again).toMatchObject({ status: 200, body: { ok: true, error: "duplicate" } });
    await sleep(PAST_A_TRY);
    expect(times(o.manager.submitted(), "status, please")).toBe(1);
  });
});

describe("answer in flight", () => {
  it("the hub killed after queuing an answer and before recording it records it once after its restart; typed once, delivered once", async () => {
    const o = await office();
    await o.manager.control({ status: "busy" });                   // a turn runs: the answer waits in the manager's own queue
    await statusIs(o, "busy");
    expect((await o.hub.answer("ny-1", "ship")).status).toBe(200);
    const held = await theAnswer(o, "held");
    expect(recorded(o.hub)).toBe(0);                               // queued counts as given (E8); recorded only once delivered (E13)
    await o.hub.restart({ signal: "SIGKILL", whileStopped: async () => {
      await o.manager.control({ prompt: true, status: "idle" });   // the turn ends, and the manager takes its queue
      await until("delivered while the hub was down", async () => (await o.fleet.client.delivery(held.id))?.state === "delivered", 30_000);
    } });
    await until("recorded after the restart", () => recorded(o.hub) === 1, 30_000);
    await until("its card Delivered", async () => (await ask(o.hub))?.decision?.delivery?.state === "delivered", 15_000);
    await sleep(PAST_A_TRY);
    expect(recorded(o.hub)).toBe(1);
    expect(times(o.manager.submitted(), TAP)).toBe(1);
    expect(await answers(o.fleet)).toHaveLength(1);                // no second delivery (no ~2)
  });
});

// The hub's database, copied while it is stopped (the file and its -wal and -shm), or put back from that copy.
function copyDb(hub: Hub, to: string) {
  const db = join(hub.home, "morndo.db");
  for (const s of ["", "-wal", "-shm"]) { rmSync(to + s, { force: true }); if (existsSync(db + s)) copyFileSync(db + s, to + s); }
}
function putBackDb(hub: Hub, from: string) {
  const db = join(hub.home, "morndo.db");
  for (const s of ["", "-wal", "-shm"]) { rmSync(db + s, { force: true }); if (existsSync(from + s)) copyFileSync(from + s, db + s); }
}
// An answer the queue typed into the manager, which the hub then no longer knows: the queue switched off, and the hub's
// database put back from a copy taken before the answer (§13: step 1's rollback restores the databases). The box writes no
// line for it (silent), so the restored hub sees no echo of the tap and takes ny-1 as open.
async function typedThenForgotten(o: Office): Promise<void> {
  const copy = join(o.hub.home, "morndo.db.before-the-answer");
  await o.hub.restart({ whileStopped: async () => { copyDb(o.hub, copy); } });
  await o.manager.control({ silent: true });
  expect((await o.hub.answer("ny-1", "ship")).status).toBe(200);
  await theAnswer(o, "typed");                                     // typed: the node holds its key, done
  expect(times(o.manager.submitted(), TAP)).toBe(1);
  await o.hub.restart({ managerQueue: false, whileStopped: async () => { putBackDb(o.hub, copy); } });
  await until("the start line: manager queue off", () => /manager queue: off \(MORNDO_MANAGER_QUEUE\)/.test(o.hub.log()), 15_000);
  await until("ny-1 open again: the restored hub never saw the answer", async () => (await ask(o.hub))?.status === "open", 15_000);
}

describe("switched off (MORNDO_MANAGER_QUEUE=off, step 2's rollback)", () => {
  it("an answer still queued is cancelled at start, its ask opens again, and a direct answer types it once", async () => {
    const o = await office();
    await o.manager.control({ status: "waiting" });                // a menu: the answer waits in the queue (menu_open)
    await statusIs(o, "waiting");
    expect((await o.hub.answer("ny-1", "ship")).status).toBe(200);
    const queued = await until("ny-1's delivery waiting for the menu", async () =>
      (await answers(o.fleet)).find(d => d.state === "queued" && d.waiting?.reason === "menu_open") ?? null, 30_000, 250);
    await o.hub.restart({ managerQueue: false });
    await until("the start line: manager queue off", () => /manager queue: off \(MORNDO_MANAGER_QUEUE\)/.test(o.hub.log()), 15_000);
    await until("cancelled at start", async () => (await o.fleet.client.delivery(queued.id))?.why === "cancelled", 15_000);
    expect(await o.fleet.client.delivery(queued.id)).toMatchObject({ state: "given_up", why: "cancelled" });
    await until("ny-1 open again", async () => (await ask(o.hub))?.status === "open", 15_000);
    await o.manager.control({ status: "idle" });
    await statusIs(o, "idle");
    expect(await o.hub.answer("ny-1", "ship")).toMatchObject({ status: 200, body: { ok: true } });
    await until("typed directly", () => times(o.manager.submitted(), TAP) === 1, 15_000);
    await sleep(PAST_A_TRY);
    expect(times(o.manager.submitted(), TAP)).toBe(1);
    expect(await answers(o.fleet)).toHaveLength(1);                // only the cancelled one: the direct answer queued nothing
  });

  it("a direct retry of an answer already typed finds its key on the node and isn't typed again (§9.1)", async () => {
    const o = await office();
    await typedThenForgotten(o);
    const r = await o.hub.answer("ny-1", "ship");                   // the same answer, typed directly under the same key
    expect([200, 409]).toContain(r.status);                        // the node's stored outcome, or in doubt: never a second typing
    await sleep(PAST_A_TRY);
    expect(times(o.manager.submitted(), TAP)).toBe(1);
  });

  it("(negative control) without the node's done keys, that direct retry types the answer a second time", async () => {
    const o = await office({ noDoneKeys: true });
    await typedThenForgotten(o);
    expect((await o.hub.answer("ny-1", "ship")).status).toBe(200);
    await until("the second typing", () => times(o.manager.submitted(), TAP) === 2, 15_000);
  });
});
```

- [ ] **Step 14: Run each drill file, then the fleet project**

Run: `npx vitest run --project fleet test/fleet/drills-deliveries.test.ts test/fleet/drills-receipts.test.ts test/fleet/drills-lanes.test.ts test/fleet/drills-lane-events.test.ts test/fleet/drills-lanes-cli.test.ts test/fleet/drills-manager-queue.test.ts`

Expected: PASS, `Test Files  6 passed (6)` and `Tests  36 passed (36)`:
- drills-deliveries: 8 (4 waiting and Enter cases, the kill and its control, a lane in `shell`, the 60 s hold);
- drills-receipts: 9 (4 receipt cases, 3 retype cases and the control, `/clear`);
- drills-lanes: 4;
- drills-lane-events: 3;
- drills-lanes-cli: 6 (list, peek and keys; send, status and stdin; start and stop; events; in doubt; not reached);
- drills-manager-queue: 6 (an answer; a message; an answer in flight; the switch off: a queued answer cancelled, a typed answer's direct retry, and its control).

Each "(negative control)" case passes by showing the failure its guard prevents. Expect about 5 minutes; the subscriber drill and the 60 s hold take about 2 minutes each, in two files that run side by side.

A failing drill prints the logs of the processes (`until` adds the tail of each live log). Read the failing one first:
- a wrong state, or a typing too many, belongs to the task that owns that behaviour (Tasks 4–10, Task 12 for the hub's queue, and Task 14 for `morndo lanes`' output and exits), and is reported to it;
- a wrong name in the harness or in the box is this task's to fix.

Run: `npx vitest run --project fleet`

Expected: PASS, every fleet file: the fleet core's nine and this task's seven.

- [ ] **Step 15: Type check, lint, and confirm nothing was left running**

Run: `npm run check`
Expected: exit 0.

Run: `npm run lint`
Expected: exit 0, no problems reported.

Run: `pgrep -fl 'apps/(node-agent|fleet|hub)/src/main.ts|fake-claude-pane' || echo "nothing left running"`
Expected: `nothing left running`. That pattern also covers `morndo lanes`, which is `apps/hub/src/main.ts lanes`.

Run: `for s in /tmp/tmux-$(id -u)/test-*; do [ -S "$s" ] && tmux -L "$(basename "$s")" ls 2>/dev/null; done; echo done`
Expected: only `done`.

- [ ] **Step 16: Commit**

```bash
git add test/fleet/drills-deliveries.test.ts test/fleet/drills-receipts.test.ts test/fleet/drills-lanes.test.ts test/fleet/drills-lane-events.test.ts test/fleet/drills-lanes-cli.test.ts test/fleet/drills-manager-queue.test.ts
git commit -m "test(fleet): delivery, lane, lane-event, morndo lanes and manager-queue drills over real processes, each with its negative control"
```

- [ ] **Step 17: Show that the box is what the held drills depend on (after the commits)**

The control `fc16-box-enqueue` becomes an entry in Task 17 (Step 17), and the runner first runs it there, after Task 17's commit (Step 18): it reads HEAD (ruling 50). Here, after this task's commits, the same check by hand:
1. In `test/fixtures/fake-claude-pane.ts`, replace `queue.push(text); write("enqueue", text);` with `write("userTyped", text);`.
2. Run `npx vitest run --project fleet test/fleet/fake-box.test.ts`.
3. Expected: FAIL in "typed while busy", `expected 'delivered' to be 'held'`.
4. Then `git checkout -- test/fixtures/fake-claude-pane.ts`, and `git status --short` shows nothing changed.

---

### Task 15: `docs/fleet-api.md`, its examples run as tests

**Files:**
- Create: `docs/fleet-api.md` (the client API reference: the socket, versions, every route, op, event and error, deliveries, lane events, the hook bodies, the subscriber contract)
- Create: `test/api-doc-examples.ts` (parses the doc's examples and matches answers to them; no vitest)
- Create: `test/fleet/api-doc-matcher.test.ts` (the matcher, and the altered answers that must fail)
- Create: `test/fleet/api-doc.test.ts` (every example against a real fleet, plus the doc's coverage of the API)
- Test: `test/fleet/api-doc-matcher.test.ts`, `test/fleet/api-doc.test.ts`

**Interfaces:**
- Consumes:
  - Task 16's harness: `startFleet({ subscribers })` (lane events not delivered by default), `joinAgent`, `updatePolicy`, `fakeLane` with `control()`, `shellLane`, `subscriber({ path })` with `path` and `headers` on each `Delivery`, `tempDir`, `cleanEnv`, `paneOf`, `until`, `sleep`, `stopAll`, `FAKE_CLAUDE` and `ROOT`. Task 16's fake box: `status`, `dequeue`, `prompt`, `silent` and the `untrusted` marker.
  - The client API as the Contracts give it (Tasks 8, 9): the routes table, and `POST /v1/op` for every op in `OP_NAMES`.
  - The rulings of [RECONCILIATION.md](RECONCILIATION.md):
    - 3, 45: refusals 200 `{ ok: false, error }`; 400 `{ ok: false, error }` for a body that doesn't fit; 404 `no_such_delivery` for an unknown id; the newest 1000.
    - 4: `/v1/op` refuses the two delivery ops.
    - 5: `/lane` is never a subscriber path.
    - 6: lane-event delivery ids.
    - 7: the first prompt's id.
    - 10, 12, 13: `pane.capture`'s `join`; `pid`; `topic` and `lastPrompt`.
    - 11: any live session takes deliveries.
    - 15: `unavailable`.
    - 16: the 60 s hold.
    - 17: `/clear`'s receipt.
    - 22, 23: lane events without a window, or stored while not delivered.
    - 25: alert details.
  - Rulings 42 to 46: the hold's name, a new delivery answered `queued`, `firstLine`, the delivery routes' errors, `topic` and `lastPrompt` optional.
  - `ERROR_EXECUTED`, `OP_NAMES`, `AlertKind` and `LaneEventName` (`packages/protocol/src/fleet.ts`, Task 1); `WORKER_ID` (`worker-id.ts`).
  - The agent's test hook `deliveryStartGraceMs` (ruling 20), so a shell lane is "not starting" within seconds.
- Produces:
  - `docs/fleet-api.md`. Its example format is its own section 4. The negative-control entries `fc15-doc-answer` and `fc15-doc-executed` (Task 17) alter it.
  - `test/api-doc-examples.ts`:
    ```ts
    export type Http = { method: string; target: string; headers: Record<string, string>; body: string };
    export type Answer = { status: number; headers: Record<string, string>; body: string };
    export type Example = { name: string; kind: "http"; poll: boolean; request: Http; answer: Answer } | { name: string; kind: "ws"; request: Http; messages: string[] }
      | { name: string; kind: "events"; messages: string[] } | { name: string; kind: "subscriber"; request: Http };
    export type Vars = Map<string, unknown>;
    export type Verdict = { ok: true; vars: Vars } | { ok: false; why: string };
    export type Received = { path: string; headers: Record<string, string>; event: unknown };
    export function parseExamples(markdown: string): Example[];
    export function substitute(text: string, vars: Vars): string;
    export function match(exp: unknown, act: unknown, vars: Vars, at?: string): string | null;    // null: it matches
    export function matchAnswer(exp: Answer, got: Answer, vars: Vars): Verdict;
    export function matchEvents(exp: string[], got: readonly unknown[], vars: Vars): Verdict;
    export function matchReceived(exp: Http, got: readonly Received[], vars: Vars): Verdict;
    ```

- [ ] **Step 1: Write the matcher's test, `test/fleet/api-doc-matcher.test.ts`**

```ts
// The doc test's matcher (test/api-doc-examples.ts) on its own, with no fleet: what an example matches and what it doesn't
// (docs/fleet-api.md §4, "How to read the examples"). The "(negative control)" cases are the altered answers the spec asks
// for (fleet clients spec §12 "Contract"): each must fail to match, so a doc that drifted from the API fails its test.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { match, matchAnswer, matchEvents, parseExamples, substitute, type Vars } from "../api-doc-examples.ts";
import { ROOT } from "../fleet-harness.ts";

const m = (exp: unknown, act: unknown, vars: Vars = new Map()) => match(exp, act, vars);
const S = "6f1c2a8e-0b1d-4f5e-9a3b-2c4d5e6f7a8b";

describe("placeholders", () => {
  it("each kind matches its values, and only those", () => {
    expect(m("{{any}}", { x: 1 })).toBeNull();
    expect(m("{{string}}", "x")).toBeNull();
    expect(m("{{string}}", 1)).toMatch(/expected string/);
    expect(m("{{number}}", 1.5)).toBeNull();
    expect(m("{{number}}", "1")).toMatch(/expected number/);
    expect(m("{{time}}", Date.now())).toBeNull();
    expect(m("{{time}}", 1000)).toMatch(/expected time/);
    expect(m("{{uuid}}", S)).toBeNull();
    expect(m("{{uuid}}", "not-a-uuid")).toMatch(/expected uuid/);
    expect(m("{{workerId}}", "n1.0a1b2c3d.4")).toBeNull();
    expect(m("{{workerId}}", "%4")).toMatch(/expected workerId/);
  });

  it("binds a name the first time, then holds every later use to that value", () => {
    const vars: Vars = new Map();
    expect(m({ a: "{{number:n}}", b: "{{number:n}}" }, { a: 3, b: 3 }, vars)).toBeNull();
    expect(vars.get("n")).toBe(3);
    expect(m("{{number:n}}", 4, vars)).toMatch(/expected n = 3/);
  });

  it("an optional field may be absent, but not of another kind", () => {
    expect(m({ a: 1, b: "{{string?}}" }, { a: 1 })).toBeNull();
    expect(m({ a: 1, b: "{{string?}}" }, { a: 1, b: "x" })).toBeNull();
    expect(m({ a: 1, b: "{{string?}}" }, { a: 1, b: 2 })).toMatch(/\$\.b/);
  });

  it("an unordered list matches its items in any order, each once", () => {
    expect(m(["{{unordered}}", 1, 2], [2, 1])).toBeNull();
    expect(m(["{{unordered}}", 1, 1], [1, 2])).toMatch(/nothing matches/);
    expect(m(["{{unordered}}", 1], [1, 1])).toMatch(/1 items/);
  });

  it("a placeholder inside a string matches part of it, and binds it", () => {
    const vars: Vars = new Map();
    expect(m("n1:{{uuid:s}}:{{number}}", `n1:${S}:7`, vars)).toBeNull();
    expect(vars.get("s")).toBe(S);
    expect(m("n1:{{uuid:s}}:{{number}}", `n2:${S}:7`)).toMatch(/expected/);
  });

  it("substitutes bound names into a request, and refuses an unbound or an open one", () => {
    const vars: Vars = new Map<string, unknown>([["w1", "n1.0a1b2c3d.4"], ["n", 3], ["p", "/a b/c"]]);
    expect(substitute('{ "workerId": "{{workerId:w1}}", "since": "{{number:n}}" }', vars)).toBe('{ "workerId": "n1.0a1b2c3d.4", "since": 3 }');
    expect(substitute("/v1/files/n1/{{uri:p}}?since={{number:n}}", vars)).toBe("/v1/files/n1/%2Fa%20b%2Fc?since=3");
    expect(() => substitute('"{{string:nobody}}"', vars)).toThrow(/nothing bound to nobody/);
    expect(() => substitute('"{{string}}"', vars)).toThrow(/open placeholder/);
  });

  it("events match in their order, with others between them", () => {
    const got = [{ t: "status", n: 1 }, { t: "other" }, { t: "inventory" }];
    expect(matchEvents(['{"t":"status","n":"{{number}}"}', '{"t":"inventory"}'], got, new Map()).ok).toBe(true);
    expect(matchEvents(['{"t":"inventory"}', '{"t":"status","n":1}'], got, new Map()).ok).toBe(false);
  });
});

describe("(negative control) an altered answer fails", () => {
  it("a changed value", () => expect(m({ api: [1] }, { api: [2] })).toMatch(/\$\.api\[0\]/));
  it("a field the example doesn't name", () => expect(m({ a: 1 }, { a: 1, b: 2 })).toMatch(/not in the example/));
  it("a field the example names and the answer lacks", () => expect(m({ a: 1, b: 2 }, { a: 1 })).toMatch(/\$\.b: missing/));
  it("another status, or a header that differs", () => {
    const ok = { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
    expect(matchAnswer(ok, { ...ok }, new Map()).ok).toBe(true);
    expect(matchAnswer(ok, { ...ok, status: 409 }, new Map()).ok).toBe(false);
    expect(matchAnswer(ok, { ...ok, headers: { "content-type": "text/plain" } }, new Map()).ok).toBe(false);
  });
  it("the doc's own caps example, altered, fails against the answer it describes", () => {
    const caps = parseExamples(readFileSync(join(ROOT, "docs/fleet-api.md"), "utf8")).find(e => e.name === "caps");
    if (caps?.kind !== "http") throw new Error("docs/fleet-api.md has no request example named caps");
    const real = { status: 200, headers: { "content-type": "application/json" }, body: '{"api":[1],"stickyLanes":["manager"]}' };
    expect(matchAnswer(caps.answer, real, new Map()).ok).toBe(true);
    const altered = { ...caps.answer, body: caps.answer.body.replace('"manager"', '"boss"') };
    expect(matchAnswer(altered, real, new Map())).toMatchObject({ ok: false, why: expect.stringContaining("stickyLanes") });
  });
});

describe("the doc's examples parse", () => {
  it("every one: a unique name, known modifiers, known placeholders", () => {
    expect(parseExamples(readFileSync(join(ROOT, "docs/fleet-api.md"), "utf8")).length).toBeGreaterThanOrEqual(80);
  });
  it("a duplicate name, an unknown placeholder and an example without its answer are refused", () => {
    const one = "```example a\nGET /v1/caps\n---\n200\n```\n";
    expect(() => parseExamples(one + one)).toThrow(/used twice/);
    expect(() => parseExamples('```example b\nGET /v1/caps\n---\n200\n\n{"x":"{{date}}"}\n```\n')).toThrow(/unknown placeholder/);
    expect(() => parseExamples("```example c\nGET /v1/caps\n```\n")).toThrow(/no "---"/);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run --project fleet test/fleet/api-doc-matcher.test.ts`

Expected: FAIL. The suite doesn't load: `Error: Cannot find module '../api-doc-examples.ts' imported from …/api-doc-matcher.test.ts`.

- [ ] **Step 3: Write `test/api-doc-examples.ts`**

```ts
// Reads docs/fleet-api.md's examples and matches real answers to them (fleet clients, Task 15). The format is the doc's own
// section 4, "How to read the examples":
// - a fenced block whose info string is `example <name> [poll|events|subscriber]`;
// - a request ("METHOD target", header lines, a blank line, the body), a line "---", then its answer (the status, header
//   lines, a blank line, the body); with `poll` the request is repeated until the answer matches;
// - `events`: JSON messages, one per line, seen in that order on a /v1/events subscription;
// - `subscriber`: a request the fleet made to a hook subscriber.
// Placeholders ({{kind}}, {{kind?}}, {{kind:name}}, {{uri:name}}, ["{{unordered}}", …]) are JSON strings in the doc and
// match values of their kind; a name binds once and holds every later use, in answers and in requests. Everything else
// matches only itself, and an answer may hold no field its example doesn't name.
// It imports no vitest: the doc test (test/fleet/api-doc.test.ts) and the matcher's own (test/fleet/api-doc-matcher.test.ts)
// both use it.
import { WORKER_ID } from "../packages/protocol/src/worker-id.ts";

export type Http = { method: string; target: string; headers: Record<string, string>; body: string };
export type Answer = { status: number; headers: Record<string, string>; body: string };
export type Example =
  | { name: string; kind: "http"; poll: boolean; request: Http; answer: Answer }
  | { name: string; kind: "ws"; request: Http; messages: string[] }
  | { name: string; kind: "events"; messages: string[] }
  | { name: string; kind: "subscriber"; request: Http };
export type Vars = Map<string, unknown>;
export type Verdict = { ok: true; vars: Vars } | { ok: false; why: string };
// What a hook subscriber received (test/fleet-harness.ts, subscriber()): its path, its headers and the event, parsed.
export type Received = { path: string; headers: Record<string, string>; event: unknown };

const FENCE = /^```example ([a-z0-9-]+)((?: [a-z]+)*)\n([\s\S]*?)\n```$/gm;
const MODIFIERS = new Set(["poll", "events", "subscriber"]);
const KINDS = new Set(["any", "string", "number", "time", "uuid", "workerId", "unordered", "uri"]);
const TOKEN = /\{\{([A-Za-z]+)(\?)?(?::([A-Za-z0-9_-]+))?\}\}/g;
const WHOLE = /^\{\{([A-Za-z]+)(\?)?(?::([A-Za-z0-9_-]+))?\}\}$/;
const HEADER = /^([A-Za-z0-9-]+): (.*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TWO_DAYS = 2 * 86_400_000;
const show = (v: unknown) => (v === undefined ? "nothing" : (JSON.stringify(v) ?? typeof v).slice(0, 200));   // undefined only for a function or a symbol

// ---- parsing

function head(text: string): { first: string; headers: Record<string, string>; body: string } {
  const lines = text.split("\n");
  const first = (lines.shift() ?? "").trim();
  const headers: Record<string, string> = {};
  for (let h = HEADER.exec(lines[0] ?? ""); h; h = HEADER.exec(lines[0] ?? "")) {
    headers[(h[1] ?? "").toLowerCase()] = h[2] ?? "";
    lines.shift();
  }
  return { first, headers, body: lines.join("\n").trim() };
}
function request(text: string, where: string): Http {
  const h = head(text);
  const r = /^(GET|POST|WS) (\S+)$/.exec(h.first);
  if (!r) throw new Error(`${where}: "${h.first}" is not "METHOD target"`);
  return { method: r[1] ?? "", target: r[2] ?? "", headers: h.headers, body: h.body };
}
function answer(text: string, where: string): Answer {
  const h = head(text);
  if (!/^\d{3}$/.test(h.first)) throw new Error(`${where}: "${h.first}" is not a status`);
  return { status: Number(h.first), headers: h.headers, body: h.body };
}
const messages = (text: string) => text.split("\n").map(l => l.trim()).filter(Boolean);

export function parseExamples(markdown: string): Example[] {
  const out: Example[] = [];
  const names = new Set<string>();
  for (const f of markdown.matchAll(FENCE)) {
    const name = f[1] ?? "";
    const where = `example ${name}`;
    const flags = (f[2] ?? "").trim().split(" ").filter(Boolean);
    const content = f[3] ?? "";
    if (names.has(name)) throw new Error(`${where}: the name is used twice`);
    names.add(name);
    for (const flag of flags) if (!MODIFIERS.has(flag)) throw new Error(`${where}: unknown modifier ${flag}`);
    for (const t of content.matchAll(TOKEN)) if (!KINDS.has(t[1] ?? "")) throw new Error(`${where}: unknown placeholder ${t[0]}`);
    if (flags.includes("events")) { out.push({ name, kind: "events", messages: messages(content) }); continue; }
    if (flags.includes("subscriber")) { out.push({ name, kind: "subscriber", request: request(content, where) }); continue; }
    const at = content.indexOf("\n---\n");
    if (at === -1) throw new Error(`${where}: no "---" between the request and the answer`);
    const req = request(content.slice(0, at), where);
    const rest = content.slice(at + 5);
    if (req.method === "WS") out.push({ name, kind: "ws", request: req, messages: messages(rest) });
    else out.push({ name, kind: "http", poll: flags.includes("poll"), request: req, answer: answer(rest, where) });
  }
  return out;
}

// ---- requests

// A request with each {{kind:name}} replaced by the value bound to `name`: a whole JSON string "{{kind:name}}" by the value
// as JSON (a number stays a number), anything else by its text, and {{uri:name}} by its text URL-encoded as one segment.
export function substitute(text: string, vars: Vars): string {
  const value = (token: string, name: string) => {
    if (!vars.has(name)) throw new Error(`${token}: nothing bound to ${name} yet`);
    return vars.get(name);
  };
  const out = text
    .replace(/"\{\{([A-Za-z]+):([A-Za-z0-9_-]+)\}\}"/g, (t, kind: string, name: string) =>
      JSON.stringify(kind === "uri" ? encodeURIComponent(String(value(t, name))) : value(t, name)))
    .replace(/\{\{([A-Za-z]+):([A-Za-z0-9_-]+)\}\}/g, (t, kind: string, name: string) =>
      (kind === "uri" ? encodeURIComponent(String(value(t, name))) : String(value(t, name))));
  const open = /\{\{[^}]*\}\}/.exec(out);
  if (open) throw new Error(`${open[0]}: a request can't hold an open placeholder; bind a name in an earlier answer`);
  return out;
}

// ---- matching

const CHECK: Record<string, (v: unknown) => boolean> = {
  any: () => true,
  string: v => typeof v === "string",
  number: v => typeof v === "number" && Number.isFinite(v),
  time: v => typeof v === "number" && Number.isInteger(v) && Math.abs(v - Date.now()) < TWO_DAYS,
  uuid: v => typeof v === "string" && UUID.test(v),
  workerId: v => typeof v === "string" && WORKER_ID.test(v),
};
// Inside a longer string, as a regular expression (groups made non-capturing, so each placeholder is one group).
const inner = (re: RegExp) => re.source.slice(1, -1).replace(/\((?!\?)/g, "(?:");
const PART: Record<string, string> = {
  any: "[\\s\\S]*?", string: "[\\s\\S]+?", number: "-?\\d+(?:\\.\\d+)?", time: "\\d{12,14}", uuid: inner(UUID), workerId: inner(WORKER_ID),
};
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function bind(name: string | undefined, v: unknown, vars: Vars, at: string): string | null {
  if (name === undefined) return null;
  if (!vars.has(name)) { vars.set(name, v); return null; }
  return JSON.stringify(vars.get(name)) === JSON.stringify(v) ? null : `${at}: expected ${name} = ${show(vars.get(name))}, got ${show(v)}`;
}

function embedded(exp: string, act: unknown, vars: Vars, at: string): string | null {
  if (typeof act !== "string") return `${at}: expected a string like ${show(exp)}, got ${show(act)}`;
  const names: (string | undefined)[] = [];
  let source = "";
  let last = 0;
  for (const t of exp.matchAll(TOKEN)) {
    source += `${escape(exp.slice(last, t.index))}(${PART[t[1] ?? ""] ?? "(?!)"})`;
    names.push(t[3]);
    last = (t.index ?? 0) + t[0].length;
  }
  const found = new RegExp(`^${source}${escape(exp.slice(last))}$`).exec(act);
  if (!found) return `${at}: expected ${show(exp)}, got ${show(act)}`;
  for (const [i, name] of names.entries()) {
    const why = bind(name, found[i + 1], vars, at);
    if (why) return why;
  }
  return null;
}

function unordered(exp: unknown[], act: unknown[], vars: Vars, at: string): string | null {
  if (exp.length !== act.length) return `${at}: expected ${exp.length} items in any order, got ${act.length}`;
  const used = new Set<number>();
  for (const [i, e] of exp.entries()) {
    let why = "";
    const hit = act.findIndex((a, j) => {
      if (used.has(j)) return false;
      const trial = new Map(vars);
      const r = match(e, a, trial, `${at}[${j}]`);
      if (r !== null) { why ||= r; return false; }
      for (const [k, v] of trial) vars.set(k, v);
      return true;
    });
    if (hit === -1) return `${at}: nothing matches item ${i} (${why})`;
    used.add(hit);
  }
  return null;
}

// Null when `act` matches `exp`; else where and how it differs. Names bound on the way go into `vars`.
export function match(exp: unknown, act: unknown, vars: Vars, at = "$"): string | null {
  if (typeof exp === "string") {
    const w = WHOLE.exec(exp);
    if (w) {
      const [, kind = "", , name] = w;
      const ok = CHECK[kind];
      if (!ok) return `${at}: ${exp} can't stand for a value`;
      if (!ok(act)) return `${at}: expected ${kind}, got ${show(act)}`;
      return bind(name, act, vars, at);
    }
    if (exp.includes("{{")) return embedded(exp, act, vars, at);
    return exp === act ? null : `${at}: expected ${show(exp)}, got ${show(act)}`;
  }
  if (Array.isArray(exp)) {
    if (!Array.isArray(act)) return `${at}: expected a list, got ${show(act)}`;
    if (exp[0] === "{{unordered}}") return unordered(exp.slice(1), act, vars, at);
    if (exp.length !== act.length) return `${at}: expected ${exp.length} items, got ${act.length}`;
    for (const [i, e] of exp.entries()) {
      const why = match(e, act[i], vars, `${at}[${i}]`);
      if (why) return why;
    }
    return null;
  }
  if (exp !== null && typeof exp === "object") {
    if (act === null || typeof act !== "object" || Array.isArray(act)) return `${at}: expected an object, got ${show(act)}`;
    const e = exp as Record<string, unknown>;
    const a = act as Record<string, unknown>;
    for (const k of Object.keys(a)) if (!Object.hasOwn(e, k)) return `${at}.${k}: not in the example (${show(a[k])})`;
    for (const [k, v] of Object.entries(e)) {
      if (!Object.hasOwn(a, k)) {
        if (typeof v === "string" && WHOLE.exec(v)?.[2] === "?") continue;
        return `${at}.${k}: missing`;
      }
      const why = match(v, a[k], vars, `${at}.${k}`);
      if (why) return why;
    }
    return null;
  }
  return Object.is(exp, act) ? null : `${at}: expected ${show(exp)}, got ${show(act)}`;
}

function body(exp: string, got: string, vars: Vars): string | null {
  if (exp === "") return got.trim() === "" ? null : `body: expected none, got ${show(got)}`;
  let e: unknown;
  try { e = JSON.parse(exp); } catch { return got.replace(/\n$/, "") === exp ? null : `body: expected ${show(exp)}, got ${show(got)}`; }
  let a: unknown;
  try { a = JSON.parse(got); } catch { return `body: expected JSON, got ${show(got)}`; }
  return match(e, a, vars, "body");
}

function headersMatch(exp: Record<string, string>, got: Record<string, string>, vars: Vars): string | null {
  for (const [name, value] of Object.entries(exp)) {
    const why = match(value, got[name], vars, `header ${name}`);
    if (why) return why;
  }
  return null;
}

export function matchAnswer(exp: Answer, got: Answer, vars: Vars): Verdict {
  if (exp.status !== got.status) return { ok: false, why: `status: expected ${exp.status}, got ${got.status}` };
  const trial = new Map(vars);
  const why = headersMatch(exp.headers, got.headers, trial) ?? body(exp.body, got.body, trial);
  return why ? { ok: false, why } : { ok: true, vars: trial };
}

// Each expected message, in order, among the ones received (others may come between them).
export function matchEvents(exp: string[], got: readonly unknown[], vars: Vars): Verdict {
  const trial = new Map(vars);
  let from = 0;
  for (const [i, line] of exp.entries()) {
    const e = JSON.parse(line) as unknown;
    let why = "none received after the one before it";
    let hit = -1;
    for (let j = from; j < got.length && hit === -1; j++) {
      const t = new Map(trial);
      const r = match(e, got[j], t, `message ${i}`);
      if (r === null) { hit = j; for (const [k, v] of t) trial.set(k, v); } else why = r;
    }
    if (hit === -1) return { ok: false, why: `message ${i} not seen (${got.length} received; the last that differed: ${why})` };
    from = hit + 1;
  }
  return { ok: true, vars: trial };
}

// Any one request the subscriber received that matches.
export function matchReceived(exp: Http, got: readonly Received[], vars: Vars): Verdict {
  const e = JSON.parse(exp.body) as unknown;
  let why = `none of the ${got.length} requests received`;
  for (const g of got) {
    const trial = new Map(vars);
    const r = exp.method !== "POST" ? `method: expected ${exp.method}, got POST`
      : match(exp.target, g.path, trial, "path") ?? headersMatch(exp.headers, g.headers, trial) ?? match(e, g.event, trial, "body");
    if (r === null) return { ok: true, vars: trial };
    why = r;
  }
  return { ok: false, why };
}
```

- [ ] **Step 4: Run the matcher's test**

Run: `npx vitest run --project fleet test/fleet/api-doc-matcher.test.ts`

Expected: `Tests  2 failed | 12 passed (14)`. Every placeholder case and every altered-answer case passes. The two cases that read `docs/fleet-api.md` fail with `ENOENT: no such file or directory`; the doc comes in Step 7.

- [ ] **Step 5: Write the doc test, `test/fleet/api-doc.test.ts`**

```ts
// docs/fleet-api.md runs as tests (fleet clients spec §8, §12 "Contract", §15.3): every example in it, in the order written,
// against a real fleet, a real node agent and lanes that stand in for the CLI (test/fleet-harness.ts: temporary HOMEs,
// random ports, an isolated tmux server; test/fixtures/fake-claude-pane.ts). The doc's section 4 says how an example reads,
// and test/api-doc-examples.ts parses and matches them. The setup the doc's section 4 names is made here; an example that
// needs a lane in another state (a menu open, a busy turn) gets it from BEFORE, by the example's name, and back from AFTER.
// The doc names the node's hook relay by its default address, http://127.0.0.1:8787; requests to it go to this agent's own
// relay port, and nothing here connects to 8787.
// Also checked: the doc covers every route, every relay path, every op the client API takes, every error code with its
// `executed`, every event type, every lane event and every alert kind. The lists come from packages/protocol where they
// live there, so a new one fails here until it is documented.
// Negative controls: test/fleet/api-doc-matcher.test.ts ("(negative control) an altered answer fails"), and
// scripts/negative-controls.ts fc15-doc-answer and fc15-doc-executed, which alter the doc itself.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import { WebSocket, type RawData } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ERROR_EXECUTED, OP_NAMES, type AlertKind, type LaneEventName } from "../../packages/protocol/src/fleet.ts";
import { matchAnswer, matchEvents, matchReceived, parseExamples, substitute, type Answer, type Example, type Http, type Vars, type Verdict } from "../api-doc-examples.ts";
import {
  FAKE_CLAUDE, ROOT, cleanEnv, fakeLane, joinAgent, paneOf, shellLane, sleep, startFleet, stopAll, subscriber, tempDir, tmuxServer, until,
  updatePolicy, type Agent, type Fleet, type Lane, type Subscriber,
} from "../fleet-harness.ts";

const doc = readFileSync(join(ROOT, "docs/fleet-api.md"), "utf8");
const examples = parseExamples(doc);
const RELAY = "http://127.0.0.1:8787";
const HOOK_PATHS = ["/cc", "/sl", "/hook/stop", "/hook/failure", "/notify", "/file"] as const;
const GRACE_MS = 5000;              // the agent's start grace for a pane with no session, shortened (deliveryStartGraceMs)

let fleet: Fleet;
let agent: Agent;
let sub: Subscriber;
let w1: Lane;
let sh1At = 0;
let events: WebSocket | null = null;
const recorded: unknown[] = [];     // every message on one /v1/events subscription, opened before the agent first connects
const vars: Vars = new Map();

const text = (raw: RawData) => (Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer)).toString("utf8");
// A WebSocket to /v1/events over the fleet's socket, through ws's createConnection option as packages/fleet-client does it.
function openEvents(into: unknown[]): Promise<WebSocket> {
  const ws = new WebSocket("ws://fleet/v1/events", { createConnection: () => createConnection(fleet.socketPath) });
  ws.on("message", raw => into.push(JSON.parse(text(raw)) as unknown));
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

// The doc's setup (its section 4): node n1 with manager and w1 (the box, idle), sh1 (a shell), two windows named dup;
// n2 and n3 joined and offline; a file, a git repository and two empty lane folders on n1 (w3's marked untrusted).
beforeAll(async () => {
  sub = await subscriber({ path: "/fleet/hook" });
  fleet = await startFleet({ subscribers: [{ name: "doc", url: sub.url, paths: [...HOOK_PATHS] }] });   // lane events: published only
  events = await openEvents(recorded);
  const tmux = tmuxServer();
  agent = await joinAgent(fleet, "n1", { tmux });
  await joinAgent(fleet, "n2", { tmux });
  await joinAgent(fleet, "n3", { tmux });
  updatePolicy(agent, {
    launch: { command: [process.execPath, "--no-warnings", FAKE_CLAUDE, ".", `--claude=${join(agent.home, ".claude")}`, "--session=auto"], via: "direct" },
    protected: ["manager"],
  });
  const manager = await fakeLane(tmux, { window: "manager", claudeHome: agent.home });
  w1 = await fakeLane(tmux, { window: "w1", claudeHome: agent.home });
  shellLane(tmux, { window: "sh1" });
  sh1At = Date.now();
  shellLane(tmux, { window: "dup" });
  shellLane(tmux, { window: "dup" });
  const home = realpathSync(agent.home);
  mkdirSync(join(home, "notes"));
  writeFileSync(join(home, "notes/hello.txt"), "hello\n");
  const repo = join(home, "repos/r1");
  mkdirSync(repo, { recursive: true });
  const env = { ...cleanEnv(agent.home), GIT_AUTHOR_NAME: "doc", GIT_AUTHOR_EMAIL: "doc@example.invalid", GIT_COMMITTER_NAME: "doc", GIT_COMMITTER_EMAIL: "doc@example.invalid" };
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], { env });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README"), "r1\n");
  git("add", "README");
  git("commit", "-q", "-m", "r1");
  const w2 = tempDir("morndo-doc-w2-");
  const w3 = tempDir("morndo-doc-w3-");
  writeFileSync(join(w3, "untrusted"), "");
  await agent.run({ deliveryStartGraceMs: GRACE_MS });
  await agent.waitOnline();
  const lanes = await until("n1's lanes, dup in conflict", async () => {
    const l = await fleet.client.lanes();
    return l.some(x => x.name === "dup" && x.conflict) && ["manager", "w1", "sh1"].every(n => l.some(x => x.name === n && x.workerId)) ? l : null;
  }, 20_000);
  for (const name of ["manager", "w1", "sh1"]) vars.set(name, lanes.find(l => l.name === name)?.workerId);
  for (const w of ["manager", "w1"]) await until(`${w} idle`, async () => (await paneOf(fleet.client, "n1", w)).status === "idle", 15_000);
  vars.set("manager-session", manager.sessionId);
  vars.set("w1-session", w1.sessionId);
  vars.set("notes", join(home, "notes/hello.txt"));
  vars.set("repo", repo);
  vars.set("w2-dir", w2);
  vars.set("w3-dir", w3);
}, 120_000);
afterAll(async () => { events?.close(); await stopAll(); });

const statusIs = (window: string, s: string) =>
  until(`${window} ${s} in n1's inventory`, async () => (await paneOf(fleet.client, "n1", window)).status === s, 15_000);
const BEFORE: Record<string, () => Promise<void>> = {
  "deliver-menu": async () => { await w1.control({ status: "waiting" }); await statusIs("w1", "waiting"); },
  "deliver-busy": async () => { await w1.control({ status: "busy" }); await statusIs("w1", "busy"); },
  "delivery-held-delivered": async () => { await w1.control({ dequeue: true }); await w1.control({ prompt: true, status: "idle" }); },
  "deliver-silent": async () => { await w1.control({ silent: true }); },
  "deliver-no-session": async () => { await sleep(Math.max(0, sh1At + GRACE_MS + 1000 - Date.now())); },
  "err-menu-open": async () => { await w1.control({ status: "waiting" }); await statusIs("w1", "waiting"); },
  "err-draft-present": async () => { w1.draft("half a thought"); await until("the draft on w1", () => w1.screen().includes("half a thought")); },
};
const AFTER: Record<string, () => Promise<void>> = {
  "delivery-expired": async () => { await w1.control({ status: "idle" }); await statusIs("w1", "idle"); },
  "delivery-uncertain": async () => { await w1.control({ silent: false }); },
  "err-menu-open": async () => { await w1.control({ status: "idle" }); await statusIs("w1", "idle"); },
  "err-draft-present": async () => { w1.clear(); await until("w1's box empty", () => !w1.screen().includes("half a thought")); },
};

async function send(req: Http): Promise<Answer> {
  const target = substitute(req.target, vars);
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, substitute(v, vars)]));
  const body = substitute(req.body, vars);
  if (target.includes("://")) {
    if (!target.startsWith(`${RELAY}/`)) throw new Error(`${target}: an example names only the fleet's socket and the relay at ${RELAY}`);
    const r = await fetch(`http://127.0.0.1:${agent.relayPort}${target.slice(RELAY.length)}`, { method: req.method, headers, ...(body ? { body } : {}) });
    return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() };
  }
  return new Promise((resolve, reject) => {
    const q = request({ socketPath: fleet.socketPath, agent: false, method: req.method, path: target, headers }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"),
        headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")])),
      }));
    });
    q.on("error", reject);
    q.end(body || undefined);
  });
}
const commit = (v: Verdict): true => {
  if (!v.ok) throw new Error(v.why);
  for (const [k, x] of v.vars) vars.set(k, x);
  return true;
};

async function run(ex: Example): Promise<void> {
  if (ex.kind === "http") {
    const end = performance.now() + (ex.poll ? 20_000 : 0);
    for (;;) {
      const got = await send(ex.request);
      const v = matchAnswer(ex.answer, got, vars);
      if (v.ok) { commit(v); return; }
      if (performance.now() > end) throw new Error(`${ex.name}: ${v.why}\n  the answer: ${got.status} ${got.body.slice(0, 3000)}`);
      await sleep(250);
    }
  }
  if (ex.kind === "events") {
    await until(`${ex.name} on /v1/events`, () => commit(matchEvents(ex.messages, recorded, vars)), 20_000);
    return;
  }
  if (ex.kind === "subscriber") {
    await until(`${ex.name} at the subscriber`, () => commit(matchReceived(ex.request, sub.received, vars)), 20_000);
    return;
  }
  expect(ex.request.target).toBe("/v1/events");
  const got: unknown[] = [];
  const ws = await openEvents(got);
  try { await until(`${ex.name}: its messages`, () => commit(matchEvents(ex.messages, got, vars)), 10_000); }
  finally { ws.close(); }
}

describe("docs/fleet-api.md: every example against a real fleet, in the order written", () => {
  for (const ex of examples) {
    it(ex.name, async () => {
      await BEFORE[ex.name]?.();
      await run(ex);
      await AFTER[ex.name]?.();
    }, 60_000);
  }
});

// Each list below is checked complete by the type checker: a kind the protocol adds fails to compile until listed.
const ALERT_KINDS = {
  instance_conflict: true, source_changed: true, clock_offset: true, rate_limited: true, lane_conflict: true, dead_letter: true,
  backlog_full: true, unrouted_hook: true, delivery_waiting: true, subscriber_lagging: true,
} satisfies Record<AlertKind, true>;
const LANE_EVENTS = { finished: true, needs_input: true, answered: true, stop_failure: true } satisfies Record<LaneEventName, true>;
const EVENT_TYPES = ["status", "inventory", "health", "conflict", "alert", "delivery", "lane"];
const ROUTES: RegExp[] = [
  /^GET \/v1\/caps$/, /^GET \/v1\/nodes$/, /^POST \/v1\/nodes\/[^/]+\/revoke$/, /^GET \/v1\/lanes$/, /^GET \/v1\/lanes\/[^/]+$/,
  /^GET \/v1\/alerts$/, /^POST \/v1\/op$/, /^GET \/v1\/files\/[^/]+\/[^/]+$/, /^POST \/v1\/deliveries$/, /^GET \/v1\/deliveries\/[^/?]+$/,
  /^GET \/v1\/deliveries\?/, /^POST \/v1\/deliveries\/[^/]+\/cancel$/, /^GET \/v1\/lane-events\?since=/, /^WS \/v1\/events$/,
];

describe("docs/fleet-api.md covers the whole client API", () => {
  const targets = examples.flatMap(e => (e.kind === "http" || e.kind === "ws" ? [`${e.request.method} ${e.request.target}`] : []));
  it("an example for every route and every path of the hook relay", () => {
    for (const route of ROUTES) expect(targets.some(t => route.test(t)), String(route)).toBe(true);
    for (const p of HOOK_PATHS) expect(targets, p).toContain(`POST ${RELAY}${p}`);
  });
  it("an example for every op, the two that POST /v1/op refuses included", () => {
    for (const op of OP_NAMES) expect(doc, op).toContain(`"op": "${op}"`);
  });
  it("every error code in the errors table, with whether it ran", () => {
    for (const [code, executed] of Object.entries(ERROR_EXECUTED)) expect(doc).toContain(`| \`${code}\` | ${executed} |`);
  });
  it("every event type in an example, every lane event in an example, every alert kind in the alerts table", () => {
    for (const t of EVENT_TYPES) expect(doc, t).toContain(`{"t":"${t}"`);
    for (const e of Object.keys(LANE_EVENTS)) expect(doc, e).toContain(`"event": "${e}"`);
    for (const k of Object.keys(ALERT_KINDS)) expect(doc, k).toContain(`| \`${k}\` |`);
  });
  it("names the relay only by its default address, which this test never dials", () => {
    for (const t of targets.filter(x => x.includes("://"))) expect(t.startsWith(`POST ${RELAY}/`), t).toBe(true);
  });
});
```

- [ ] **Step 6: Run it and see it fail**

Run: `npx vitest run --project fleet test/fleet/api-doc.test.ts`

Expected: FAIL. The suite doesn't load: `ENOENT: no such file or directory, open '…/docs/fleet-api.md'`.

- [ ] **Step 7: Write `docs/fleet-api.md`**

Each example states what this plan expects the code of Tasks 1–14 to answer. Step 8 checks every one of them against the real code.

````markdown
# The fleet's client API (version 1)

The fleet service (`morndo-fleet`, [apps/fleet](../apps/fleet/README.md)) is how every client reaches the lanes: the hub, `morndo lanes`, kira, the manager's helpers, and anything you write. This is its reference, version 1. It covers:
- the socket and the version rules;
- every route, and every op you can run through `POST /v1/op`;
- deliveries and lane events;
- every event on `/v1/events` and every error code;
- the hook relay's bodies and the subscriber contract.

**Every example below runs as a test.** `test/fleet/api-doc.test.ts` sends each request to a real fleet with a real node agent, whose lanes stand in for Claude Code, and compares the answer. A change that breaks an example fails CI. For TypeScript there is a client, `@morndo/fleet-client` (`packages/fleet-client`).

The design behind it: [fleet clients](design/fleet-clients/README.md) and [fleet core](design/fleet-core/README.md).

**Contents:**
1. The socket
2. Versions
3. Clients name themselves
4. How to read the examples
5. Nodes, lanes and alerts
6. Deliveries
7. Lane events
8. Ops (`POST /v1/op`)
9. Events (`WS /v1/events`)
10. Errors
11. The hook relay and its bodies
12. Files
13. The subscriber contract
14. Alerts
15. Sources

## 1. The socket

- **Transport.** The API is HTTP/1.1 and one WebSocket over a Unix socket: `~/.local/state/morndo-fleet/fleet.sock` by default (the fleet's `socketPath`). Nothing listens on the network.
- **Access.** The socket has mode 0600, in a directory of mode 0700 that belongs to the fleet's user, and that directory is the only access control. Any process of that user can call every route. Client names (§3) are labels for the audit, not credentials.
- **Bodies.** Requests send JSON (`content-type: application/json`), at most 1 MiB. Answers are JSON with `cache-control: no-store`; a file (§12) is the one exception.
- **Path segments.** Each segment of a path is URL-encoded on its own, so a lane name or a file path that holds `/` stays one segment (`%2F`).
- **From a shell:** `curl --unix-socket ~/.local/state/morndo-fleet/fleet.sock http://fleet/v1/caps`. The host name is ignored.

```example caps
GET /v1/caps
---
200
content-type: application/json

{ "api": [1], "stickyLanes": ["manager"] }
```

- `api` lists the versions this fleet serves.
- `stickyLanes` lists the lane names that deliveries follow across a restart (§6.1). They come from the fleet's config.

## 2. Versions

- **Paths.** Every route is under `/v<N>/`. A fleet serves its current version and the one before it (`api`), so a client one version behind keeps working through an upgrade.
- **What a version may gain.** Within a version, the fleet may add fields to answers, routes, ops, event types (`t`), alert kinds, lane events and error codes. A client ignores fields, events and alert kinds it doesn't know.
- **An unknown error code.** A client reads it as `internal` with `executed: "maybe"`: it may have run, so it is never retried on a guess.
- **What takes a new version:** removing or renaming anything, or changing what a field means.
- **A version the fleet doesn't serve** is answered 404, with the versions it does serve. A WebSocket to one is refused with 404 too.

```example unsupported-version
GET /v2/caps
---
404

{ "error": "unsupported_api", "api": [1] }
```

## 3. Clients name themselves

- **The header.** Every request names its client in `x-morndo-client`: 1 to 16 lower-case letters `a`–`z`, such as `hub`, `lanes`, `kira` or `fleet`. Anything else (a missing header, upper case, digits, more than 16 letters) is recorded as `unknown`, and the request is served all the same.
- **Namespaces.** A client namespaces its delivery ids and operation keys with the same name and a colon, such as `kira:tap:123`. The fleet never checks that a name is honest (§1).
- **The audit.** For every side effect, the fleet's audit records the client that asked, its target and its outcome. That covers every delivery, every keyed op (`pane.send`, `file.put`, `lane.start`, `lane.stop`, `worktree.add`) and every `pane.keys`. It never records the text typed, the keys pressed or a file's bytes.

```example client-name-unknown
GET /v1/lanes/w1
x-morndo-client: Kira-2
---
200

{ "name": "w1", "node": "n1", "workerId": "{{workerId:w1}}", "conflict": false }
```

## 4. How to read the examples

**The format.** Each example is a fenced block whose first line is `example <name>`. It holds the request, then a line `---`, then the answer:
- **The request:** `METHOD path` for the socket, or `METHOD http://127.0.0.1:8787/…` for the node's hook relay (§11). Then header lines, a blank line, and the body.
- **The answer:** the status, then header lines, then a blank line and the body. Only the headers listed are checked.

A word after the name changes how the block reads:
- `poll`: the answer comes once the fleet has acted, a delivery confirmed say. The request is repeated until the answer matches, for up to 20 s.
- `events`: messages the fleet sent on a `/v1/events` subscription that was opened before anything else, in this order. Other messages may come between them.
- `subscriber`: a request the fleet made to a hook subscriber (§13).

**Placeholders.** These stand for values that change from run to run. They are written as JSON strings but match values of their kind:

| Placeholder | Matches |
|---|---|
| `"{{any}}"` | anything |
| `"{{string}}"` | any string |
| `"{{number}}"` | any number |
| `"{{time}}"` | a time in milliseconds since the epoch, within two days of now |
| `"{{uuid}}"` | a UUID |
| `"{{workerId}}"` | a worker id, `<node>.<server>.<pane>` |
| `"{{kind?}}"` | as `{{kind}}`, or the field is absent |
| `"{{kind:name}}"` | as `{{kind}}`, and the same value wherever `name` comes again, in answers and in later requests; in a path, `{{uri:name}}` is that value URL-encoded |
| `["{{unordered}}", …]` | the items that follow, in any order |

Any other value matches only itself. An answer may hold no field that its example doesn't name.

**The setup.** The examples run against one node, `n1`, with these lanes:
- `manager` and `w1`: Claude Code, idle;
- `sh1`: a shell;
- two windows that are both named `dup`.

`n2` and `n3` are nodes that have joined and are offline. On `n1` there are also a file `notes/hello.txt` holding `hello`, a git repository `repos/r1`, and two empty folders for new lanes. Where an example needs `w1` in another state (a menu open, a turn running), the text before it says so.

## 5. Nodes, lanes and alerts

| Route | Answer |
|---|---|
| `GET /v1/caps` | `{ api, stickyLanes }` (§1) |
| `GET /v1/nodes` | every node not revoked, by name: `{ name, status, health, agent }[]` |
| `POST /v1/nodes/<name>/revoke` | `{ ok: true, revoked }`: the node is cut off now and for good |
| `GET /v1/lanes` | every lane name, by name: `{ name, node, workerId, conflict }[]` |
| `GET /v1/lanes/<name>` | one lane, or 404 `{ error: "no_such_lane" }` |
| `GET /v1/alerts` | the latest alerts, oldest first (§14) |
| `POST /v1/op` | an op on a node (§8) |
| `GET /v1/files/<node>/<ref or path>` | a file's bytes (§12) |
| `POST /v1/deliveries`, `GET /v1/deliveries/<id>`, `GET /v1/deliveries?lane=&state=` (the newest 1000 of the last 7 days), `POST /v1/deliveries/<id>/cancel` | deliveries (§6) |
| `GET /v1/lane-events?since=<seq>` | lane events (§7) |
| `WS /v1/events` | the fleet's events (§9) |

### 5.1 Nodes

**Fields:**
- `status` is `online`, `stale` (a missed ping) or `offline`.
- `health` is the node's latest report: memory, load, disk, the clock, the depth of its hook spool. It is null until the node has sent one.
- `agent` is the version its agent last reported.

```example nodes
GET /v1/nodes
---
200

[
  { "name": "n1", "status": "online", "health": "{{any}}", "agent": "{{string}}" },
  { "name": "n2", "status": "offline", "health": null, "agent": "{{any}}" },
  { "name": "n3", "status": "offline", "health": null, "agent": "{{any}}" }
]
```

**Revoking a node** closes its connection (code 4403) and drops its lanes. It never connects again; joining again takes a new join code. `revoked` is false for a node that was already revoked.

```example revoke
POST /v1/nodes/n3/revoke
x-morndo-client: lanes
---
200

{ "ok": true, "revoked": true }
```

### 5.2 Lanes

A lane is a tmux window with one pane, in the node's session, and its name is its window's name. Names are unique across the fleet:
- A name belongs to the node that reported it first.
- When two windows claim one name, on two nodes or on one, the name is in conflict (`conflict: true`, and `workerId: null` while two windows of its owner claim it) and nothing is routed by it. Each window can still be reached by its worker id.

```example lanes
GET /v1/lanes
---
200

[
  { "name": "dup", "node": "n1", "workerId": null, "conflict": true },
  { "name": "manager", "node": "n1", "workerId": "{{workerId:manager}}", "conflict": false },
  { "name": "sh1", "node": "n1", "workerId": "{{workerId:sh1}}", "conflict": false },
  { "name": "w1", "node": "n1", "workerId": "{{workerId:w1}}", "conflict": false }
]
```

```example lane-one
GET /v1/lanes/w1
---
200

{ "name": "w1", "node": "n1", "workerId": "{{workerId:w1}}", "conflict": false }
```

```example lane-none
GET /v1/lanes/nobody
---
404

{ "error": "no_such_lane" }
```

A lane's session status (`busy`, `idle`, `waiting`, `shell`), its process and its folder are in its node's inventory (`inventory.get`, §8).

### 5.3 Alerts

The fleet keeps the latest 500 security alerts and the latest 500 others, and serves both oldest first. §14 lists the kinds.

```example alerts
GET /v1/alerts
---
200

[
  { "id": "{{number}}", "at": "{{time}}", "node": "n1", "kind": "lane_conflict",
    "detail": { "name": "dup", "claims": ["{{unordered}}", { "node": "n1", "workerId": "{{workerId}}" }, { "node": "n1", "workerId": "{{workerId}}" }] } }
]
```

## 6. Deliveries

A delivery is a message for one lane running Claude Code. It is queued on the lane's node, typed into the lane once, when the lane can take it, and confirmed from the lane's own conversation. It is how anything reaches the manager, and how a client says something to a Claude Code lane without racing the owner's typing or a menu. A lane with no Claude Code (a shell, an engine) is typed into directly instead, with `pane.send` and `pane.keys` (§8).

### 6.1 Sending one

`POST /v1/deliveries` takes `{ id, lane | workerId, text, ttlMs? }`:

- **`id`.** Chosen by the client, namespaced (`kira:…`), at most 200 characters, never ending in `#<digits>` (kept for the node's retype key). It is the delivery's idempotency:
  - The same id with the same target and text is the same delivery. Sending it again answers its current state and queues nothing.
  - The same id with another target or text is refused with `id_conflict`.
  - The node types the delivery under this id as an operation key, so a crash while typing never types it twice.
- **`lane`, a sticky name.** The fleet's `stickyLanes` (`GET /v1/caps`; default `["manager"]`) follow the name wherever its node runs it:
  - after a restart in a new pane and a new session, the new one gets the delivery;
  - while no window has the name, the delivery goes to the node that last had it and waits there (`no_pane`).
- **`lane`, any other name.** The delivery is bound to the session that lane has when it is queued. If another session takes the name, the delivery is given up (`gone`) and never typed into the other conversation.
- **`workerId`.** Bound to that pane: when the pane is gone, so is the delivery.
- **`text`.** At most 8000 characters.
- **`ttlMs`.** How long it may wait, at most 7 days. The default is 24 hours, turned into `notAfter` on the node's clock when stored, so the clocks of client and node never need to agree.
- **Only a lane with a live Claude Code session takes deliveries,** whatever the session's `status` (`busy`, `idle`, `waiting`, or `shell`: a shell command running under it).
  - A pane with no live session (no session file, or its process gone) makes the delivery wait (`no_session`) when the lane is sticky, or when the pane's process started in the last 2 minutes (Claude Code still starting).
  - Any other such pane refuses it with `no_session`.

A delivery answered `queued` is stored on its node and synced to the disk: the sender may stop retrying. A refusal queued nothing. It is answered 200 `{ ok: false, error }`, as `/v1/op` answers an op's refusal (§10). Only a body that doesn't fit the route is 400, in the same `{ ok: false, error }` shape (`bad_args`). While the node is offline, a new delivery is refused with `node_offline` and is never queued anywhere else.

**No answer: in doubt** (plan/RECONCILIATION.md ruling 49). A request that reached the fleet and got no answer leaves the delivery in doubt: it may be queued. That happens when the connection drops, or the client gives up waiting; `@morndo/fleet-client` then throws `FleetUnavailable` with `reached: true`. A refusal `uncertain` is the same case.
- **What a client does:** it sends the same `id` again. That is safe, since a delivery's id is its idempotency, and the answer is then its current state.
- **What it never does:** it never falls back to typing the text directly, and never tells the owner it wasn't delivered.
- **`morndo lanes`** exits 5 then, and its line names the id to send again. It exits 69 only when the fleet wasn't reached (`reached: false`): nothing was queued.

```example deliver
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:1", "lane": "w1", "text": "Ship the docs build." }
---
200

{ "ok": true, "delivery": { "id": "kira:doc:1", "node": "n1", "target": { "lane": "w1" }, "state": "queued", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}" } }
```

### 6.2 Its state

**The `Delivery` object.** The fleet keeps the latest state of every delivery from the last 7 days, never its text:

| Field | Meaning |
|---|---|
| `id`, `node`, `target` | as sent, and the node it is queued on |
| `state` | below |
| `queuedAt`, `notAfter` | milliseconds on the node's clock |
| `waiting` | `{ reason, since }`, only while `queued`, once a try found the lane not ready |
| `sessionId` | the session it is bound to (a lane name that isn't sticky), or was typed into |
| `typedAt`, `deliveredAt` | milliseconds on the node's clock |
| `why` | for `given_up` |
| `note` | words for a person, such as why it is `uncertain` |

**The states:**

| `state` | Meaning |
|---|---|
| `queued` | stored on the node, not yet taken by the lane |
| `typed` | typed, waiting for Claude Code to take it |
| `held` | in Claude Code's own queue: it was typed while a turn was running |
| `delivered` | in the conversation, at `deliveredAt` |
| `uncertain` | typed, and seen neither taken nor back in the input box before `notAfter`: it may or may not have reached the lane. It is never typed again. |
| `given_up` | `why`: `expired` (never typed before `notAfter`), `cancelled`, `gone` (its pane or its bound session is gone), or `refused` (a definite refusal, such as `too_large`) |

**Why a queued delivery waits** (`waiting.reason`):

| `reason` | Meaning |
|---|---|
| `menu_open` | a menu is on the screen |
| `draft_present` | the owner's own text is in the input box |
| `no_input_box` | no input box on the screen |
| `busy` | another typist holds the pane's lock |
| `no_pane` | no window has the name (a sticky lane mid-restart) |
| `no_session` | Claude Code isn't running there yet |
| `earlier` | an earlier delivery to the same lane goes first: one still queued, or one typed or held and waiting for its receipt, for at most 60 s |
| `unavailable` | the node couldn't read or type the pane just now (tmux didn't answer, a capture failed); it tries again |

**How the node types and confirms it.**
- **One at a time per lane,** in the order queued. A try comes at once, on every change the node sees, and at least every 5 seconds. A delivery typed or held and waiting for its receipt holds the next one back for at most 60 s; then the next one types.
- **The checks of `pane.send`,** each time: never over a menu or a draft, never past the pane's lock.
- **A line that stays in the box after Enter** gets Enter again, but only while the box still shows exactly that line, and at most twice more.
- **`delivered` comes only from Claude Code's transcript** of the session it was typed into, as a prompt that holds the text. Each receipt confirms one delivery, the earliest still waiting.
- **A slash command that starts a new session** (`/clear`, `/new`) is recorded only in the new session's transcript. Its receipt is the pane's session changing to a new id after the typing.
- **A line Claude Code dropped on an interrupt** is typed once more, under its own key, if the box is clear and the session idle. Otherwise the delivery is `uncertain`. There is never a third typing.

**`stale`** is true while the delivery's node is offline: the fleet's copy may be behind the node's. A delivery still `queued`, `typed` or `held` after 2, 15 and 60 minutes raises a `delivery_waiting` alert each time (§14).

```example delivery-delivered poll
GET /v1/deliveries/kira:doc:1
---
200

{ "delivery": { "id": "kira:doc:1", "node": "n1", "target": { "lane": "w1" }, "state": "delivered", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}", "typedAt": "{{time}}", "deliveredAt": "{{time}}" }, "stale": false }
```

The same id with the same content again: the same delivery, as it is now.

```example deliver-again
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:1", "lane": "w1", "text": "Ship the docs build." }
---
200

{ "ok": true, "delivery": { "id": "kira:doc:1", "node": "n1", "target": { "lane": "w1" }, "state": "delivered", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}", "typedAt": "{{time}}", "deliveredAt": "{{time}}" } }
```

The same id with other content is refused:

```example deliver-id-conflict
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:1", "lane": "w1", "text": "Hold the docs build." }
---
200

{ "ok": false, "error": { "code": "id_conflict", "executed": "no", "message": "{{string}}" } }
```

To the manager, a sticky name: no session is bound, and the session it was typed into is known once it is typed.

```example deliver-sticky
POST /v1/deliveries
x-morndo-client: hub
content-type: application/json

{ "id": "hub:doc:2", "lane": "manager", "text": "Answer: ship it." }
---
200

{ "ok": true, "delivery": { "id": "hub:doc:2", "node": "n1", "target": { "lane": "manager" }, "state": "queued", "queuedAt": "{{time}}", "notAfter": "{{time}}" } }
```

```example delivery-sticky-delivered poll
GET /v1/deliveries/hub:doc:2
---
200

{ "delivery": { "id": "hub:doc:2", "node": "n1", "target": { "lane": "manager" }, "state": "delivered", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:manager-session}}", "typedAt": "{{time}}", "deliveredAt": "{{time}}" }, "stale": false }
```

While `w1` shows a menu, a delivery waits and says why:

```example deliver-menu
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:menu", "lane": "w1", "text": "After the menu." }
---
200

{ "ok": true, "delivery": { "id": "kira:doc:menu", "node": "n1", "target": { "lane": "w1" }, "state": "queued", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}" } }
```

```example delivery-waiting poll
GET /v1/deliveries/kira:doc:menu
---
200

{ "delivery": { "id": "kira:doc:menu", "node": "n1", "target": { "lane": "w1" }, "state": "queued", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}", "waiting": { "reason": "menu_open", "since": "{{time}}" } }, "stale": false }
```

### 6.3 Cancelling one

`POST /v1/deliveries/<id>/cancel` takes no body. It gives up a delivery that is still `queued`. One already typed can't be called back: that is refused with `already_typed`. An id the fleet doesn't know is 404 `{ error: "no_such_delivery" }`, as on `GET`.

```example cancel
POST /v1/deliveries/kira:doc:menu/cancel
x-morndo-client: kira
---
200

{ "ok": true, "delivery": { "id": "kira:doc:menu", "node": "n1", "target": { "lane": "w1" }, "state": "given_up", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}", "why": "cancelled" } }
```

```example cancel-typed
POST /v1/deliveries/kira:doc:1/cancel
x-morndo-client: kira
---
200

{ "ok": false, "error": { "code": "already_typed", "executed": "no", "message": "{{string}}" } }
```

```example cancel-unknown
POST /v1/deliveries/kira:doc:nothing/cancel
x-morndo-client: kira
---
404

{ "error": "no_such_delivery" }
```

### 6.4 Listing them

`GET /v1/deliveries` lists the newest 1000 of the last 7 days, oldest first. `lane` and `state` filter the list, each optional; a `state` that isn't one is 400.

```example deliveries-list
GET /v1/deliveries?lane=w1&state=given_up
---
200

{ "deliveries": [ { "id": "kira:doc:menu", "node": "n1", "target": { "lane": "w1" }, "state": "given_up", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}", "why": "cancelled", "stale": false } ] }
```

### 6.5 Deadlines, held lines, and lines never seen taken

The menu is still open on `w1`. A delivery that may wait only 2 seconds expires without being typed:

```example deliver-ttl
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:ttl", "lane": "w1", "text": "Too late for the menu.", "ttlMs": 2000 }
---
200

{ "ok": true, "delivery": { "id": "kira:doc:ttl", "node": "n1", "target": { "lane": "w1" }, "state": "queued", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}" } }
```

```example delivery-expired poll
GET /v1/deliveries/kira:doc:ttl
---
200

{ "delivery": { "id": "kira:doc:ttl", "node": "n1", "target": { "lane": "w1" }, "state": "given_up", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}", "why": "expired" }, "stale": false }
```

The menu is answered. Now `w1` runs a turn, so a delivery typed into it lands in Claude Code's own queue (`held`):

```example deliver-busy
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:busy", "lane": "w1", "text": "Queued behind the turn." }
---
200

{ "ok": true, "delivery": { "id": "kira:doc:busy", "node": "n1", "target": { "lane": "w1" }, "state": "queued", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}" } }
```

```example delivery-held poll
GET /v1/deliveries/kira:doc:busy
---
200

{ "delivery": { "id": "kira:doc:busy", "node": "n1", "target": { "lane": "w1" }, "state": "held", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}", "typedAt": "{{time}}" }, "stale": false }
```

The turn ends and Claude Code takes its queue as the next prompt:

```example delivery-held-delivered poll
GET /v1/deliveries/kira:doc:busy
---
200

{ "delivery": { "id": "kira:doc:busy", "node": "n1", "target": { "lane": "w1" }, "state": "delivered", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}", "typedAt": "{{time}}", "deliveredAt": "{{time}}" }, "stale": false }
```

Next, `w1` takes a line but its transcript never shows it. Typed and never seen taken by its deadline, the delivery is `uncertain`: it may or may not have reached the lane, and it is never typed again.

```example deliver-silent
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:lost", "lane": "w1", "text": "Never seen taken.", "ttlMs": 4000 }
---
200

{ "ok": true, "delivery": { "id": "kira:doc:lost", "node": "n1", "target": { "lane": "w1" }, "state": "queued", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}" } }
```

```example delivery-uncertain poll
GET /v1/deliveries/kira:doc:lost
---
200

{ "delivery": { "id": "kira:doc:lost", "node": "n1", "target": { "lane": "w1" }, "state": "uncertain", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}", "typedAt": "{{time}}", "note": "{{string?}}" }, "stale": false }
```

### 6.6 Refusals

A shell takes no delivery. Type into it with `pane.send` instead.

```example deliver-no-session
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:sh", "lane": "sh1", "text": "ls" }
---
200

{ "ok": false, "error": { "code": "no_session", "executed": "no", "message": "{{string}}" } }
```

```example deliver-no-lane
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:none", "lane": "nobody", "text": "Hello?" }
---
200

{ "ok": false, "error": { "code": "no_pane", "executed": "no", "message": "{{string}}" } }
```

```example deliver-conflict
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:dup", "lane": "dup", "text": "Which one?" }
---
200

{ "ok": false, "error": { "code": "lane_conflict", "executed": "no", "message": "{{string}}" } }
```

```example deliver-offline
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:n2", "workerId": "n2.0a1b2c3d.1", "text": "Are you there?" }
---
200

{ "ok": false, "error": { "code": "node_offline", "executed": "no", "message": "{{string}}" } }
```

```example deliver-bad
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "doc-1", "lane": "w1", "text": "An id without its client's name." }
---
400

{ "ok": false, "error": { "code": "bad_args", "executed": "no", "message": "{{string}}" } }
```

So is a body that doesn't fit the route at all (here both a lane and a worker id): 400, before anything is looked up, in the shape `POST /v1/op` answers a malformed body with:

```example deliver-malformed
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:both", "lane": "w1", "workerId": "{{workerId:w1}}", "text": "Which target?" }
---
400

{ "ok": false, "error": { "code": "bad_args", "executed": "no", "message": "{{string}}" } }
```

```example delivery-none
GET /v1/deliveries/kira:doc:nothing
---
404

{ "error": "no_such_delivery" }
```

## 7. Lane events

The fleet builds four lane events from two sources: the hooks of each lane, and the session state each node reports.

| `event` | When | Fields |
|---|---|---|
| `finished` | a turn ended (the Stop hook, §11) | `status`, `firstLine`, `bg`, `crons` |
| `needs_input` | the session's status turned `waiting`: a menu (a question, a permission prompt, a usage-limit dialog) | `question` |
| `answered` | the session's status left `waiting` | none |
| `stop_failure` | a turn ended on an API error (the StopFailure hook) | `error` |

**The fields:**
- `status` is `done`, `blocked`, `needs_decision` or null. It comes from the turn text's first line, matched by `/^[\W_]*STATUS[\W_]*:?[\W_]*(DONE|BLOCKED|NEEDS DECISION)\b/i`.
- `firstLine` is that first line.
- `bg` and `crons` count the background tasks and the scheduled wake-ups.
- `question` is the menu's question as the screen shows it: the last line ending in "?", else the line above the options, at most 200 characters.
- `error` is the error's type.

**The shape:** `{ v: 1, t: "lane", seq, event, node, window, lane, sessionId?, at, … }`.
- `seq` is the fleet's own counter, growing by one.
- `lane` is the window's name when it is a lane, and null otherwise.
- `at` is when it happened, on the node's clock.

**Where they go.**
- **Every client:** `/v1/events` (§9) and `GET /v1/lane-events?since=<seq>`. That route answers at most 1000 events, oldest first, from the last 7 days.
- **The manager:** delivered in batches, by the fleet's `laneEvents` config:
  - every `batchMs` (3000), one delivery to the lane `deliverTo` (default `manager`; `null` turns this off), split at 8000 characters;
  - its text is the `header` line, then one JSON line per event: `{ ts, lane, sessionId, event, status, firstLine, bg, crons }`;
  - its delivery id is `fleet:lane-events:<node>:<the first event's time, in ms>`. A batch split over 8000 characters gets `-1`, `-2` … after it, and a batch queued again after its delivery was given up gets `.2`, `.3` … after any of those.
- **Not sent:**
  - `answered` is published but not delivered;
  - the manager's own lane, and lanes matching `laneEvents.ignore` (globs), raise none;
  - events stored while `deliverTo` is `null` are never delivered later, so turning delivery on doesn't flood the manager with old ones.
- **Not made at all:** a Stop or StopFailure hook that the relay couldn't place in a window (§11.2) makes no lane event.

Each event is stored in the same synced commit as the hooks it came from, so a fleet restart loses none, and the ones the manager hasn't had are sent then.

While the examples above ran, a menu opened on `w1` and was answered. Now its turn ends, posted the way Claude Code posts its Stop hook (§11):

```example hook-stop
POST http://127.0.0.1:8787/hook/stop
content-type: application/json

{
  "session_id": "{{uuid:w1-session}}",
  "transcript_path": "/home/user/.claude/projects/-home-user-docs/w1.jsonl",
  "cwd": "/home/user/docs",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "last_assistant_message": "STATUS: DONE\nThe docs build is green.",
  "background_tasks": [{ "id": "task-1", "name": "docs-check", "status": "running" }],
  "session_crons": []
}
---
200
content-type: application/json

{"ok":true,"queued":true}
```

```example lane-events poll
GET /v1/lane-events?since=0
---
200

{ "events": [
  { "v": 1, "t": "lane", "seq": "{{number:le1}}", "event": "needs_input", "node": "n1", "window": "w1", "lane": "w1", "sessionId": "{{uuid:w1-session}}", "at": "{{time}}", "question": "Do you want to proceed?" },
  { "v": 1, "t": "lane", "seq": "{{number:le2}}", "event": "answered", "node": "n1", "window": "w1", "lane": "w1", "sessionId": "{{uuid:w1-session}}", "at": "{{time}}" },
  { "v": 1, "t": "lane", "seq": "{{number:le3}}", "event": "finished", "node": "n1", "window": "w1", "lane": "w1", "sessionId": "{{uuid:w1-session}}", "at": "{{time}}", "status": "done", "firstLine": "STATUS: DONE", "bg": 1, "crons": 0 }
] }
```

The same turn's end in the older body that the owner's Stop script posts (§11.3), after the last event seen:

```example hook-stop-compat
POST http://127.0.0.1:8787/hook/stop
content-type: application/json

{ "window": "w1", "cwd": "/home/user/docs", "session_id": "{{uuid:w1-session}}", "branch": "docs/api", "changed": 3, "ahead": 1, "text": "STATUS: BLOCKED\nThe staging key is missing.", "background": 0, "crons": 1 }
---
200

{"ok":true,"queued":true}
```

```example lane-events-since poll
GET /v1/lane-events?since={{number:le3}}
---
200

{ "events": [
  { "v": 1, "t": "lane", "seq": "{{number:le4}}", "event": "finished", "node": "n1", "window": "w1", "lane": "w1", "sessionId": "{{uuid:w1-session}}", "at": "{{time}}", "status": "blocked", "firstLine": "STATUS: BLOCKED", "bg": 0, "crons": 1 }
] }
```

A turn that ended on an API error, first as Claude Code posts its StopFailure hook, then in the owner's script's body:

```example hook-failure
POST http://127.0.0.1:8787/hook/failure
content-type: application/json

{
  "session_id": "{{uuid:w1-session}}",
  "transcript_path": "/home/user/.claude/projects/-home-user-docs/w1.jsonl",
  "cwd": "/home/user/docs",
  "permission_mode": "default",
  "hook_event_name": "StopFailure",
  "error_type": "rate_limit",
  "error_message": "Rate limit exceeded. Please retry after 60 seconds."
}
---
202
```

```example hook-failure-compat
POST http://127.0.0.1:8787/hook/failure
content-type: application/json

{ "window": "w1", "session_id": "{{uuid:w1-session}}", "error": "rate limited" }
---
202
```

```example lane-events-failures poll
GET /v1/lane-events?since={{number:le4}}
---
200

{ "events": [
  { "v": 1, "t": "lane", "seq": "{{number}}", "event": "stop_failure", "node": "n1", "window": "w1", "lane": "w1", "sessionId": "{{uuid:w1-session}}", "at": "{{time}}", "error": "rate_limit" },
  { "v": 1, "t": "lane", "seq": "{{number}}", "event": "stop_failure", "node": "n1", "window": "w1", "lane": "w1", "sessionId": "{{uuid:w1-session}}", "at": "{{time}}", "error": "rate limited" }
] }
```

## 8. Ops (`POST /v1/op`)

**The body:** `{ node | workerId | lane, op, args, key?, timeoutMs? }`. Exactly one target is named.
- **Lane targets.** For a `lane`, the fleet gives the pane ops (`pane.frame`, `pane.keys`, `pane.send`) the lane's worker id. `pane.send` and `pane.keys` also get the expectation `{ server, window: lane }`, unless `args` has one. A pane renamed or reused meanwhile then refuses with `no_pane` instead of taking the keys.
- **Keys.** A keyed op (`pane.send`, `file.put`, `lane.start`, `lane.stop`, `worktree.add`) needs a `key`: namespaced, at most 256 characters, the same on every retry. Any other op refuses a key.
- **Retries.** A keyed op takes effect at most once per key within 7 days. A repeat answers the stored outcome, or `uncertain` while the first attempt's outcome is unknown. `op.status` says which.
- **Timeouts.** `timeoutMs` runs from 1 to 120000, 15000 by default. A side effect that hasn't started by then answers `timeout`, not executed.

**The answer** is always status 200 and an op's outcome:
- `{ ok: true, result, invVersion, store, storeSeq }`, or
- `{ ok: false, error: { code, executed, message }, store, storeSeq }`.

`store` names the node's database that answered, and `storeSeq` how many keyed ops it has started. Both are null when nothing was sent to a node. Only a body that isn't an op at all gets another status (400, 413, 415, §10).

| Op | Args | Result | Key |
|---|---|---|---|
| `inventory.get` | `{}` | `{ panes, invVersion }`. Each pane is `{ workerId, window, cwd, sessionId?, sessionName?, title?, claudeVersion?, status, pid, topic?, lastPrompt? }`. `status` is the live session's (`busy`, `idle`, `waiting`, or `shell`: a shell command running under it) and `pid` Claude Code's process, each null without a live session; `topic` and `lastPrompt` are the session's latest `ai-title` and `last-prompt` entries, absent when unknown. | none |
| `pane.captureMany` | `{ workerIds }`, at most 64 | `{ captures: { workerId, text \| null, truncated }[] }`, each at most 6 KiB | none |
| `pane.capture` | `{ workerId, lines (1–2000), attributes?, join? }` | `{ text \| null, truncated }`, at most 256 KiB as JSON. `attributes` keeps tmux's colour escapes, so dim text can be told apart; `join` (default true) joins wrapped lines. | none |
| `pane.frame` | `{ workerId }` | `{ frame: { cols, rows, x, y, cursor, lines } \| null }` | none |
| `pane.keys` | `{ workerId, expect }` with exactly one of `data` (literal text, at most 4096) or `names` (key names: `Enter`, `Escape`, `Tab`, `BSpace`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, `C-c`, `C-d`, `C-u`, `Space`, the digits, the letters) | `{ ok }` | none: keys are never retried |
| `pane.send` | `{ workerId, text (at most 8000), expect }` | `{ problem: null \| "not_submitted", typedAt }`. It types at once or refuses (§10). A lane running Claude Code is better reached by a delivery (§6). | yes |
| `op.status` | `{ key }` | `{ state: "unknown" \| "started" \| "done", outcome? }` | none |
| `transcript.size` | `{ sessionId }` | `{ size \| null }` | none |
| `transcript.read` | `{ sessionId, offset, max (at most 256 KiB) }` | `{ bytes (base64), eof }` | none |
| `transcript.locate` | `{ sessionId, needle (at most 200) }` | `{ offset \| null }`: the start of the line that holds it | none |
| `file.stat` | `{ path \| ref }` | `{ size, mtime }` | none |
| `file.get` | `{ path \| ref, offset, max }` | `{ bytes (base64), size, eof }` | none |
| `file.put` | `{ upload, offset, bytes (base64), final, name }` | `{ path \| null }`: the file's place once final | yes |
| `lane.start` | `{ name, cwd, account?, resume?, prompt? }` | `{ workerId, waiting?: "trust", prompt? }` (below) | yes |
| `lane.stop` | `{ name, mode?: "exit" \| "kill" }` | `{ ok: true }` (below) | yes |
| `worktree.list` | `{ repo }` | `{ worktrees: { path, branch \| null }[] }` | none |
| `worktree.add` | `{ repo, name, base }` | `{ path }`: beside the repository, `<repo>-worktrees/<name>` | yes |
| `lane.deliver`, `delivery.cancel` | | refused here with `bad_args`: use `/v1/deliveries` (§6), which records the delivery for every client | |

**`lane.start`** runs the node's launcher, `launch` in its `policy.json`; the default is `{ "command": ["claude"], "via": "shell" }`.
- `{account}` in the command is the op's `account`, and `resume` adds `--resume <session>`. An op can add nothing else to the command.
- With `via: "shell"`, the window starts the user's shell, and the launcher is pasted once the shell's prompt shows. The window then outlives Claude Code.
- `prompt` becomes a delivery to the new pane, whose id the answer carries as `prompt`: `<client>:prompt:<the first 16 hex digits of the SHA-256 of the start's key>`, always within 200 characters. It waits for Claude Code to start, so it never races the startup.
- `waiting: "trust"`: Claude Code is asking whether to trust the folder. Accepting stays the client's decision: send the keys.

**`lane.stop`.** The default, `exit`, types `/exit` the way a delivery is typed and answers Claude Code's exit prompt. It then answers once the window has closed or is back at its shell, or with `uncertain` after 30 s. `kill` closes the window. Names in the policy's `protected` list (default `["manager"]`) are refused with `denied`.

```example op-inventory
POST /v1/op
x-morndo-client: lanes
content-type: application/json

{ "node": "n1", "op": "inventory.get", "args": {} }
---
200

{
  "ok": true,
  "result": {
    "panes": [
      "{{unordered}}",
      { "workerId": "{{workerId:manager}}", "window": "manager", "cwd": "{{string}}", "sessionId": "{{uuid:manager-session}}", "sessionName": "{{string?}}", "title": "{{string?}}", "claudeVersion": "2.1.293", "status": "idle", "pid": "{{number}}", "topic": "{{string?}}", "lastPrompt": "{{string?}}" },
      { "workerId": "{{workerId:w1}}", "window": "w1", "cwd": "{{string}}", "sessionId": "{{uuid:w1-session}}", "sessionName": "{{string?}}", "title": "{{string?}}", "claudeVersion": "2.1.293", "status": "idle", "pid": "{{number}}", "topic": "{{string?}}", "lastPrompt": "{{string?}}" },
      { "workerId": "{{workerId:sh1}}", "window": "sh1", "cwd": "{{string}}", "title": "{{string?}}", "status": null, "pid": null },
      { "workerId": "{{workerId}}", "window": "dup", "cwd": "{{string}}", "title": "{{string?}}", "status": null, "pid": null },
      { "workerId": "{{workerId}}", "window": "dup", "cwd": "{{string}}", "title": "{{string?}}", "status": null, "pid": null }
    ],
    "invVersion": "{{number}}"
  },
  "invVersion": "{{number}}",
  "store": "{{uuid:store}}",
  "storeSeq": "{{number}}"
}
```

```example op-capture-many
POST /v1/op
x-morndo-client: lanes
content-type: application/json

{ "node": "n1", "op": "pane.captureMany", "args": { "workerIds": ["{{workerId:w1}}"] } }
---
200

{ "ok": true, "result": { "captures": [ { "workerId": "{{workerId:w1}}", "text": "{{string}}", "truncated": false } ] }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-capture
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "workerId": "{{workerId:w1}}", "op": "pane.capture", "args": { "workerId": "{{workerId:w1}}", "lines": 60, "attributes": true } }
---
200

{ "ok": true, "result": { "text": "{{string}}", "truncated": false }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-frame
POST /v1/op
x-morndo-client: hub
content-type: application/json

{ "lane": "w1", "op": "pane.frame", "args": {} }
---
200

{ "ok": true, "result": { "frame": { "cols": "{{number}}", "rows": "{{number}}", "x": "{{number}}", "y": "{{number}}", "cursor": "{{any}}", "lines": "{{any}}" } }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-send
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "lane": "w1", "op": "pane.send", "args": { "text": "Hello from the docs." }, "key": "kira:doc-send-1" }
---
200

{ "ok": true, "result": { "problem": null, "typedAt": "{{time}}" }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-status
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "node": "n1", "op": "op.status", "args": { "key": "kira:doc-send-1" } }
---
200

{ "ok": true, "result": { "state": "done", "outcome": { "problem": null, "typedAt": "{{time}}" } }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

Keys, as literal text and then by name. `C-u` clears the line the text left in the input box:

```example op-keys-text
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "lane": "w1", "op": "pane.keys", "args": { "data": "x" } }
---
200

{ "ok": true, "result": { "ok": true }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-keys-names
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "lane": "w1", "op": "pane.keys", "args": { "names": ["C-u"] } }
---
200

{ "ok": true, "result": { "ok": true }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-transcript-size
POST /v1/op
x-morndo-client: hub
content-type: application/json

{ "node": "n1", "op": "transcript.size", "args": { "sessionId": "{{uuid:w1-session}}" } }
---
200

{ "ok": true, "result": { "size": "{{number}}" }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-transcript-read
POST /v1/op
x-morndo-client: hub
content-type: application/json

{ "node": "n1", "op": "transcript.read", "args": { "sessionId": "{{uuid:w1-session}}", "offset": 0, "max": 64 } }
---
200

{ "ok": true, "result": { "bytes": "{{string}}", "eof": false }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-transcript-locate
POST /v1/op
x-morndo-client: hub
content-type: application/json

{ "node": "n1", "op": "transcript.locate", "args": { "sessionId": "{{uuid:w1-session}}", "needle": "Hello from the docs." } }
---
200

{ "ok": true, "result": { "offset": "{{number}}" }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-file-stat
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "node": "n1", "op": "file.stat", "args": { "path": "{{string:notes}}" } }
---
200

{ "ok": true, "result": { "size": 6, "mtime": "{{number}}" }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-file-get
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "node": "n1", "op": "file.get", "args": { "path": "{{string:notes}}", "offset": 0, "max": 1024 } }
---
200

{ "ok": true, "result": { "bytes": "aGVsbG8K", "size": 6, "eof": true }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-file-put
POST /v1/op
x-morndo-client: hub
content-type: application/json

{ "node": "n1", "op": "file.put", "args": { "upload": "docup1", "offset": 0, "bytes": "aGkK", "final": true, "name": "hi.txt" }, "key": "hub:doc-upload-1" }
---
200

{ "ok": true, "result": { "path": "{{string}}" }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

A lane started with a first prompt, which is delivered once Claude Code can take it:

```example op-lane-start
POST /v1/op
x-morndo-client: lanes
content-type: application/json

{ "node": "n1", "op": "lane.start", "args": { "name": "w2", "cwd": "{{string:w2-dir}}", "prompt": "Start with the README." }, "key": "lanes:doc-start-w2", "timeoutMs": 30000 }
---
200

{ "ok": true, "result": { "workerId": "{{workerId:w2}}", "prompt": "lanes:prompt:052ed21d0f6032a9" }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-lane-start-prompt poll
GET /v1/deliveries/lanes:prompt:052ed21d0f6032a9
---
200

{ "delivery": { "id": "lanes:prompt:052ed21d0f6032a9", "node": "n1", "target": { "workerId": "{{workerId:w2}}" }, "state": "delivered", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w2-session}}", "typedAt": "{{time}}", "deliveredAt": "{{time}}" }, "stale": false }
```

A lane started in a folder Claude Code doesn't trust yet:

```example op-lane-start-trust
POST /v1/op
x-morndo-client: lanes
content-type: application/json

{ "node": "n1", "op": "lane.start", "args": { "name": "w3", "cwd": "{{string:w3-dir}}" }, "key": "lanes:doc-start-w3", "timeoutMs": 30000 }
---
200

{ "ok": true, "result": { "workerId": "{{workerId:w3}}", "waiting": "trust" }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-lane-stop-kill
POST /v1/op
x-morndo-client: lanes
content-type: application/json

{ "node": "n1", "op": "lane.stop", "args": { "name": "w3", "mode": "kill" }, "key": "lanes:doc-stop-w3" }
---
200

{ "ok": true, "result": { "ok": true }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-lane-stop
POST /v1/op
x-morndo-client: lanes
content-type: application/json

{ "node": "n1", "op": "lane.stop", "args": { "name": "w2" }, "key": "lanes:doc-stop-w2", "timeoutMs": 45000 }
---
200

{ "ok": true, "result": { "ok": true }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-lane-stop-protected
POST /v1/op
x-morndo-client: lanes
content-type: application/json

{ "node": "n1", "op": "lane.stop", "args": { "name": "manager" }, "key": "lanes:doc-stop-manager" }
---
200

{ "ok": false, "error": { "code": "denied", "executed": "no", "message": "{{string}}" }, "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-worktree-list
POST /v1/op
x-morndo-client: hub
content-type: application/json

{ "node": "n1", "op": "worktree.list", "args": { "repo": "{{string:repo}}" } }
---
200

{ "ok": true, "result": { "worktrees": [ { "path": "{{string}}", "branch": "main" } ] }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-worktree-add
POST /v1/op
x-morndo-client: hub
content-type: application/json

{ "node": "n1", "op": "worktree.add", "args": { "repo": "{{string:repo}}", "name": "doc-wt", "base": "main" }, "key": "hub:doc-worktree-1" }
---
200

{ "ok": true, "result": { "path": "{{string}}" }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

The two delivery ops are the node's own; a client reaches them through `/v1/deliveries`:

```example op-deliver-refused
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "node": "n1", "op": "lane.deliver", "args": { "id": "kira:doc:op", "target": { "lane": "w1", "sticky": false }, "text": "x" } }
---
400

{ "ok": false, "error": { "code": "bad_args", "executed": "no", "message": "{{string}}" }, "store": null, "storeSeq": null }
```

```example op-cancel-refused
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "node": "n1", "op": "delivery.cancel", "args": { "id": "kira:doc:1" } }
---
400

{ "ok": false, "error": { "code": "bad_args", "executed": "no", "message": "{{string}}" }, "store": null, "storeSeq": null }
```

## 9. Events (`WS /v1/events`)

A WebSocket on the socket, `ws://fleet/v1/events`, at the path's version. It sends JSON messages `{ t, node, body }`:

| `t` | `body` |
|---|---|
| `status` | `{ status }`: a node went `online`, `stale` or `offline` |
| `inventory` | `{ panes, invVersion }`: a node's lanes changed (the result of `inventory.get`, §8) |
| `health` | the node's health report |
| `conflict` | `{ name, nodes }`: a lane name went into conflict (the nodes whose windows claim it), or out of it (`[]`) |
| `alert` | an alert (§14); `node` is the alert's node, or "" |
| `delivery` | a delivery's new state: the `Delivery` of §6.2 with `stale` |
| `lane` | a lane event (§7) |

**On connecting,** a client first gets each node's `status`, then each online node's latest `inventory` and `health`. Every event after that comes as it happens.

**Reconnecting.** Deliveries, lane events, alerts and conflicts that happened while a client was away are not replayed. Read them from `/v1/deliveries`, `/v1/lane-events?since=` and `/v1/alerts` after each reconnect.

**A client that doesn't read** is closed with 1013 once 8 MiB of events wait for it. It gets the current state first when it reconnects.

```example events-connect
WS /v1/events
---
{"t":"status","node":"n1","body":{"status":"online"}}
{"t":"status","node":"n2","body":{"status":"offline"}}
{"t":"inventory","node":"n1","body":{"panes":"{{any}}","invVersion":"{{number}}"}}
{"t":"health","node":"n1","body":"{{any}}"}
```

These were sent while the examples above ran:

```example events-conflict events
{"t":"conflict","node":"n1","body":{"name":"dup","nodes":["n1"]}}
```

```example events-alert events
{"t":"alert","node":"n1","body":{"id":"{{number}}","at":"{{time}}","node":"n1","kind":"lane_conflict","detail":{"name":"dup","claims":["{{unordered}}",{"node":"n1","workerId":"{{workerId}}"},{"node":"n1","workerId":"{{workerId}}"}]}}}
```

```example events-delivery events
{"t":"delivery","node":"n1","body":{"id":"kira:doc:1","node":"n1","target":{"lane":"w1"},"state":"delivered","queuedAt":"{{time}}","notAfter":"{{time}}","sessionId":"{{uuid:w1-session}}","typedAt":"{{time}}","deliveredAt":"{{time}}","stale":false}}
```

```example events-lane events
{"t":"lane","node":"n1","body":{"v":1,"t":"lane","seq":"{{number:le3}}","event":"finished","node":"n1","window":"w1","lane":"w1","sessionId":"{{uuid:w1-session}}","at":"{{time}}","status":"done","firstLine":"STATUS: DONE","bg":1,"crons":0}}
```

## 10. Errors

**Every refusal says whether anything ran.** `executed: "no"` is safe to retry. `executed: "maybe"` means the side effect may have happened: ask `op.status` with the same key, and never retry blindly.

**Statuses** (plan/RECONCILIATION.md rulings 3 and 45):
- On `POST /v1/op`, `POST /v1/deliveries` and `POST /v1/deliveries/<id>/cancel`, every outcome is status 200, refusals included: `{ ok: false, error }` (§6, §8).
- A body that doesn't fit is the exception: 400 for one that doesn't fit the route, 415 for one that isn't JSON, 413 for one over 1 MiB, each `{ ok: false, error }` (`bad_args`, or `too_large` over the limit). On `/v1/op` it also carries `store: null, storeSeq: null`: nothing was sent to a node.
- An unknown delivery id is 404 `{ error: "no_such_delivery" }`, on `GET` and on cancel.
- On `/v1/files`, a refusal before the first byte has the status of §12.

| Code | Executed | Means | Example |
|---|---|---|---|
| `bad_args` | no | The request or the op's arguments don't fit: an unknown op, a missing or extra key, a field of the wrong type, a delivery id without its client's name. | `err-bad-args`, `err-not-json`, `deliver-bad`, `deliver-malformed` |
| `unknown_op` | no | The node doesn't know an op the fleet does: an older agent. | none: needs an older agent |
| `denied` | no | The node's policy refuses it: an op left out of its `ops`, a `protected` lane for `lane.stop`, a folder lanes may not start in. | `op-lane-stop-protected` |
| `no_pane` | no | No such lane, worker or window, or the pane isn't the one expected (another server, window or session). | `err-no-pane`, `deliver-no-lane` |
| `menu_open` | no | `pane.send`: a menu is on the screen. A delivery waits instead. | `err-menu-open` |
| `no_input_box` | no | `pane.send`: no input box on the screen, such as a shell, or Claude Code still starting. | `err-no-input-box` |
| `draft_present` | no | `pane.send`: the owner's own text is in the input box. | `err-draft-present` |
| `busy` | no | Another typist holds the pane's lock (`lockedPanes`), or 8 bulk ops already wait for the node. | none: needs a lock held from outside |
| `name_taken` | no | `lane.start` of a name registered anywhere in the fleet, or being started; `worktree.add` of a branch that exists. | `err-name-taken` |
| `lane_conflict` | no | Two windows claim the lane name: address one by its worker id. | `err-lane-conflict`, `deliver-conflict` |
| `too_large` | no | A body over 1 MiB, a message over 512 KiB, a file over 25 MiB or over the node's disk budget. | none: a body over 1 MiB |
| `timeout` | no | The deadline passed before the side effect started, or a read had no answer in time. | none: needs a stalled node |
| `node_offline` | no | The node isn't connected. Nothing is queued anywhere else. | `err-node-offline`, `deliver-offline` |
| `uncertain` | maybe | The side effect may have happened: the connection dropped after it started, or the key's first attempt never finished. | none: needs a drop in mid-op (the drills have one) |
| `internal` | maybe | The node or the fleet failed while acting, or sent a code this client doesn't know (§2). | none |
| `id_conflict` | no | A delivery id already used with another target or text. | `deliver-id-conflict` |
| `no_session` | no | A delivery to a pane with no live Claude Code session (no session file, or its process gone) that isn't waiting for one to start (§6.1). | `deliver-no-session` |
| `already_typed` | no | `cancel` of a delivery past `queued`. | `cancel-typed` |

```example err-bad-args
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "lane": "w1", "op": "pane.paste", "args": {} }
---
400

{ "ok": false, "error": { "code": "bad_args", "executed": "no", "message": "{{string}}" }, "store": null, "storeSeq": null }
```

```example err-not-json
POST /v1/op
x-morndo-client: kira
content-type: text/plain

send hello to w1
---
415

{ "ok": false, "error": { "code": "bad_args", "executed": "no", "message": "{{string}}" }, "store": null, "storeSeq": null }
```

```example err-no-pane
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "lane": "nobody", "op": "pane.send", "args": { "text": "Hello?" }, "key": "kira:doc-send-nobody" }
---
200

{ "ok": false, "error": { "code": "no_pane", "executed": "no", "message": "{{string}}" }, "store": null, "storeSeq": null }
```

`w1` shows a menu:

```example err-menu-open
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "lane": "w1", "op": "pane.send", "args": { "text": "Over the menu?" }, "key": "kira:doc-send-menu" }
---
200

{ "ok": false, "error": { "code": "menu_open", "executed": "no", "message": "{{string}}" }, "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

The owner has half a thought typed in `w1`'s box:

```example err-draft-present
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "lane": "w1", "op": "pane.send", "args": { "text": "Over the draft?" }, "key": "kira:doc-send-draft" }
---
200

{ "ok": false, "error": { "code": "draft_present", "executed": "no", "message": "{{string}}" }, "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example err-no-input-box
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "lane": "sh1", "op": "pane.send", "args": { "text": "ls" }, "key": "kira:doc-send-shell" }
---
200

{ "ok": false, "error": { "code": "no_input_box", "executed": "no", "message": "{{string}}" }, "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example err-name-taken
POST /v1/op
x-morndo-client: lanes
content-type: application/json

{ "node": "n1", "op": "lane.start", "args": { "name": "w1", "cwd": "{{string:w2-dir}}" }, "key": "lanes:doc-start-w1-again" }
---
200

{ "ok": false, "error": { "code": "name_taken", "executed": "no", "message": "{{string}}" }, "store": null, "storeSeq": null }
```

```example err-lane-conflict
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "lane": "dup", "op": "pane.send", "args": { "text": "Which one?" }, "key": "kira:doc-send-dup" }
---
200

{ "ok": false, "error": { "code": "lane_conflict", "executed": "no", "message": "{{string}}" }, "store": null, "storeSeq": null }
```

```example err-node-offline
POST /v1/op
x-morndo-client: hub
content-type: application/json

{ "node": "n2", "op": "inventory.get", "args": {} }
---
200

{ "ok": false, "error": { "code": "node_offline", "executed": "no", "message": "{{string}}" }, "store": null, "storeSeq": null }
```

## 11. The hook relay and its bodies

Each node runs a hook relay on `127.0.0.1:8787` (the agent's `relayPort`). Claude Code's HTTP hooks and the node's hook scripts post there, so `~/.claude/settings.json` can be the same on every machine.
- **Acknowledging.** The relay answers once the event is durable in the node's hook stream, and before any network I/O.
- **On to the fleet.** The node sends the events on, in order, and the fleet keeps each one until every subscriber has it (§13).
- **Web pages are refused.** A request with an `Origin` header comes from a web page, never from a hook, and the relay refuses it.

### 11.1 Paths and answers

| Path | What | Answer | Kept |
|---|---|---|---|
| `/cc` | tool-call progress (`PreToolUse` and the like) | 204, empty, always: a slow answer would stall the session | the latest per session |
| `/sl` | the status line's data | 204, empty, always | the latest per session |
| `/hook/stop` | a turn's end (`Stop`) | 200 `{"ok":true,"queued":true}` | every one |
| `/hook/failure` | a turn ended on an API error (`StopFailure`) | 202 | every one |
| `/notify` | a message for the owner | 202 | every one |
| `/file` | a file for the owner: `{ path, … }` | 202 (413 over 25 MiB, 400 for a path that isn't absolute, 403 where files are never shared, 404 when missing) | a copy, by the node's file rules |

When the stream can't be written (a full disk), the script paths answer 503 so the calling script's own fallback runs, while `/cc` and `/sl` still answer 204 and count the event as dropped. Claude Code treats an HTTP hook's non-2xx answer, or no answer, as a non-blocking error (§15).

### 11.2 Identity

The relay adds the node's name and the window the event came from, found in this order:
1. the pane in the body's `TMUX_PANE`;
2. the pane where the body's `session_id` runs;
3. the body's own `window`, such as a `notify` sent from outside any pane.

### 11.3 The bodies

**The relay accepts Claude Code's own hook JSON on every path** (§15). Every hook carries `session_id`, `transcript_path`, `cwd` and `hook_event_name`.
- **`Stop`** adds `last_assistant_message`, `background_tasks` (a list) and `session_crons` (a list).
- **`StopFailure`** adds `error_type` and `error_message`. `error_type` is one of: `rate_limit`, `overloaded`, `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `cloud_credential_error`, `unknown`.
- **`PreToolUse`** adds `tool_name`, `tool_input` and `tool_use_id`.

**For compatibility it also accepts the bodies of the owner's older hook scripts:**
- Stop: `{ window, cwd, session_id, branch, changed, ahead, text, background, crons }`.
- StopFailure: `{ window, session_id, error }`.
- `/notify` and `/file`: `{ window?, text?, path?, … }`.

**Lane events (§7) read either form:**
- the text from `last_assistant_message` or `text`;
- the counts from the length of `background_tasks` and `session_crons`, or from `background` and `crons`;
- the error from `error_type` or `error`.

Section 7 has a Stop body and a StopFailure body in each form. The other paths:

```example hook-pretooluse
POST http://127.0.0.1:8787/cc
content-type: application/json

{
  "session_id": "{{uuid:w1-session}}",
  "transcript_path": "/home/user/.claude/projects/-home-user-docs/w1.jsonl",
  "cwd": "/home/user/docs",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "npm run docs", "description": "Build the docs" },
  "tool_use_id": "toolu_01docs"
}
---
204
```

```example hook-statusline
POST http://127.0.0.1:8787/sl
content-type: application/json

{ "session_id": "{{uuid:w1-session}}", "transcript_path": "/home/user/.claude/projects/-home-user-docs/w1.jsonl", "cwd": "/home/user/docs", "workspace": { "current_dir": "/home/user/docs" }, "version": "2.1.293" }
---
204
```

```example hook-notify
POST http://127.0.0.1:8787/notify
content-type: application/json

{ "window": "w1", "text": "The docs build is green." }
---
202
```

```example hook-file
POST http://127.0.0.1:8787/file
content-type: application/json

{ "window": "w1", "path": "{{string:notes}}", "caption": "the notes" }
---
202
```

### 11.4 What a subscriber receives

Each event reaches every subscriber that takes its path (§13) as `POST <url>`. The body is the event as JSON: `{ streamId, seq, at, path, node, window, late?, body }`. The header `Idempotency-Key: <node>:<streamId>:<seq>` comes with it.
- `body` is the hook's body as posted, except for `/file`. There the file's path is replaced by `ref`, `name` and `size`, and the bytes come from `GET /v1/files/<node>/<ref>` (§12).
- `late` marks an event the node sent after a long time offline.

```example sub-stop subscriber
POST /fleet/hook
idempotency-key: n1:{{uuid:stream}}:{{number}}
content-type: application/json

{ "streamId": "{{uuid:stream}}", "seq": "{{number}}", "at": "{{time}}", "path": "/hook/stop", "node": "n1", "window": "w1",
  "body": { "session_id": "{{uuid:w1-session}}", "transcript_path": "/home/user/.claude/projects/-home-user-docs/w1.jsonl", "cwd": "/home/user/docs", "permission_mode": "default", "hook_event_name": "Stop", "last_assistant_message": "STATUS: DONE\nThe docs build is green.", "background_tasks": [{ "id": "task-1", "name": "docs-check", "status": "running" }], "session_crons": [] } }
```

```example sub-stop-compat subscriber
POST /fleet/hook
idempotency-key: n1:{{uuid:stream}}:{{number}}

{ "streamId": "{{uuid:stream}}", "seq": "{{number}}", "at": "{{time}}", "path": "/hook/stop", "node": "n1", "window": "w1",
  "body": { "window": "w1", "cwd": "/home/user/docs", "session_id": "{{uuid:w1-session}}", "branch": "docs/api", "changed": 3, "ahead": 1, "text": "STATUS: BLOCKED\nThe staging key is missing.", "background": 0, "crons": 1 } }
```

```example sub-failure subscriber
POST /fleet/hook
idempotency-key: n1:{{uuid:stream}}:{{number}}

{ "streamId": "{{uuid:stream}}", "seq": "{{number}}", "at": "{{time}}", "path": "/hook/failure", "node": "n1", "window": "w1",
  "body": { "session_id": "{{uuid:w1-session}}", "transcript_path": "/home/user/.claude/projects/-home-user-docs/w1.jsonl", "cwd": "/home/user/docs", "permission_mode": "default", "hook_event_name": "StopFailure", "error_type": "rate_limit", "error_message": "Rate limit exceeded. Please retry after 60 seconds." } }
```

```example sub-cc subscriber
POST /fleet/hook
idempotency-key: n1:{{uuid:stream}}:{{number}}

{ "streamId": "{{uuid:stream}}", "seq": "{{number}}", "at": "{{time}}", "path": "/cc", "node": "n1", "window": "w1",
  "body": { "session_id": "{{uuid:w1-session}}", "transcript_path": "/home/user/.claude/projects/-home-user-docs/w1.jsonl", "cwd": "/home/user/docs", "permission_mode": "default", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": { "command": "npm run docs", "description": "Build the docs" }, "tool_use_id": "toolu_01docs" } }
```

The window of a `notify` comes from its body: no pane or session sent it.

```example sub-notify subscriber
POST /fleet/hook
idempotency-key: n1:{{uuid:stream}}:{{number}}

{ "streamId": "{{uuid:stream}}", "seq": "{{number}}", "at": "{{time}}", "path": "/notify", "node": "n1", "window": "w1", "body": { "window": "w1", "text": "The docs build is green." } }
```

```example sub-file subscriber
POST /fleet/hook
idempotency-key: n1:{{uuid:stream}}:{{number}}

{ "streamId": "{{uuid:stream}}", "seq": "{{number}}", "at": "{{time}}", "path": "/file", "node": "n1", "window": "w1",
  "body": { "window": "w1", "caption": "the notes", "ref": "{{string:ref}}", "name": "hello.txt", "size": 6 } }
```

## 12. Files

`GET /v1/files/<node>/<ref or path>` streams a file from a node:
- **The target.** A value that starts with `/` or `~` is a path, read under the node's file rules (never its secrets or Morndo's own state). Anything else is the `ref` of a file sent through the relay's `/file`. Either is URL-encoded as one segment.
- **The answer.** The bytes, with their size in `x-file-size`.
- **A refusal before the first byte** is `{ ok: false, error }` with status 400 (bad args, such as a missing file), 403 (denied), 413 (too large), 503 (node offline), 504 (timeout) or 502 (uncertain or internal), else 404.
- **A download that ends short of `x-file-size`, or runs past it,** is cut off, so a client sees an error and never a clean short file.

```example files-ref
GET /v1/files/n1/{{uri:ref}}
---
200
content-type: application/octet-stream
x-file-size: 6

hello
```

```example files-path
GET /v1/files/n1/{{uri:notes}}
---
200
x-file-size: 6

hello
```

```example files-missing
GET /v1/files/n1/%2Fnowhere%2Fmissing.txt
---
400

{ "ok": false, "error": { "code": "bad_args", "executed": "no", "message": "{{string}}" } }
```

## 13. The subscriber contract

A subscriber is a URL in the fleet's config (`subscribers: [{ name, url, paths }]`) that takes the events of the hook paths it lists. The fleet's hook bus delivers to it this way:
- **In order, one event in flight.** Each `(node, streamId)` stream is delivered in `seq` order, with one request in flight per stream and subscriber. Streams and subscribers don't wait for each other.
- **At least once.** An event can come again (after a fleet restart, a timeout, a lost answer). Skip one whose `Idempotency-Key` you have seen; keep the keys for a day.
- **Retries.** An answer of 408, 429 or 5xx, or no answer within 10 s, is retried with backoff from 1 s up to 10 minutes. After 20 attempts the event goes to dead letters with a `dead_letter` alert. Any other 4xx goes to dead letters at once.

**What a subscriber owes the bus:**
- Answer 2xx once you have the event: stored, or acted on.
- Never refuse an event for a reason of your own downstream: a chat service that blocks you, a handler that failed, a restart under way. Keep what you can't act on yet, durably, and act later.
- An event you keep refusing holds up every later event of its stream, for up to about two hours of retries.

The fleet raises `subscriber_lagging` (§14) when a subscriber's oldest undelivered event is older than 60 seconds.

The `subscriber` examples in §11.4 are what such a subscriber receives. Lane state events travel in each node's stream under the path `/lane`, but they reach clients as lane events (§7): they never go to subscribers, and are never counted as unrouted hooks (`unrouted_hook`).

## 14. Alerts

An alert is something for the owner to look at that changes no state. Each one is an audit row `{ id, at, node, kind, detail }`, kept 90 days, served by `GET /v1/alerts` and sent as the `alert` event.

| Kind | When | `detail` |
|---|---|---|
| `instance_conflict` | a second instance of a node was refused, because the live one answered the instance check | `{ live, refused, source }` |
| `source_changed` | a node's network source address changed: possibly a stolen node key | `{ from, to }` |
| `clock_offset` | a node's clock is more than 2 s off. Nothing depends on the clocks agreeing. | `{ offsetMs }` |
| `rate_limited` | a node sent more messages than its rate allows, and was disconnected | `{}` |
| `lane_conflict` | a lane name got a second claimant | `{ name, claims: { node, workerId }[] }` |
| `dead_letter` | a subscriber refused an event, or the event failed 20 times; once per subscriber until a delivery to it succeeds again | `{ subscriber, streamId, seq, path, reason, attempts }` |
| `backlog_full` | a subscriber's backlog reached 50,000 events | `{ subscriber, cap, droppedProgress, deadLettered }` |
| `unrouted_hook` | the first event of a script path that no subscriber takes | `{ path, events }` |
| `delivery_waiting` | a delivery still `queued`, `typed` or `held` after 2, 15 and 60 minutes, once each | `{ id, lane, state, reason, minutes }` |
| `subscriber_lagging` | a subscriber's oldest undelivered event is older than 60 s | `{ subscriber, oldestAgeMs, streams }`: `streams`, the streams it holds up |

## 15. Sources

- Claude Code hooks: the common input fields; the `Stop`, `StopFailure` and `PreToolUse` inputs; an HTTP hook's non-2xx answer or connection failure is a non-blocking error. https://code.claude.com/docs/en/hooks, read 2026-10-08.
- Claude Code status line: the JSON a status line command receives. https://code.claude.com/docs/en/statusline, read 2026-10-08.
- The transcript and session-file shapes the delivery receipt reads are Claude Code internals, undocumented. Each is pinned by a recorded example in `test/fixtures/claude-code/`, from Claude Code 2.1.293, so a change shows as a failing test.
- Node.js `http` over a Unix socket (`socketPath`): https://nodejs.org/docs/latest-v24.x/api/http.html#httprequestoptions-callback, read 2026-10-06.
- `ws` 8, a client over a Unix socket through `createConnection`: https://github.com/websockets/ws/blob/master/doc/ws.md, read 2026-10-07.
````

- [ ] **Step 8: Run the doc test and the matcher's test**

Run: `npx vitest run --project fleet test/fleet/api-doc.test.ts test/fleet/api-doc-matcher.test.ts`

Expected: PASS, `Test Files  2 passed (2)`. `api-doc.test.ts` runs one test per example plus 5 coverage tests. `api-doc-matcher.test.ts` runs 14. The doc has 93 examples, so `Tests  112 passed (112)`. Expect about 25 s.

A failing example names itself, says where the answer differs from the doc (for instance `body.delivery.waiting: not in the example`), and prints the real answer. Decide which side is wrong:
- **The code does what the spec and the Contracts say, and the example is wrong.** Correct the doc.
- **The code differs from the spec or a Contract.** Report it to the task that owns it (Tasks 1–14) and leave the doc as it is. The doc states the API clients may rely on.
- **The behaviour is one that RECONCILIATION.md settled** (rulings 3–7, 10–17, 22–25), the code follows the ruling, and this doc doesn't. Correct the doc to the ruling, and say so in the commit.

- [ ] **Step 9: Show that an altered answer fails the doc test**

The matcher's own controls already ran in Step 8. To see the doc test itself bite:
1. In `docs/fleet-api.md`, change `{ "api": [1], "stickyLanes": ["manager"] }` to `{ "api": [1], "stickyLanes": ["boss"] }`.
2. Run `npx vitest run --project fleet test/fleet/api-doc.test.ts -t caps`.
3. Expected: FAIL in `caps`, with `body.stickyLanes[0]: expected "boss", got "manager"`.
4. Then change `["boss"]` back to `["manager"]`. (`git checkout` can't restore it: the doc isn't committed until Step 10.)

Task 17 adds this control as the entry `fc15-doc-answer`.

- [ ] **Step 10: Type check, lint, and commit**

Run: `npm run check`
Expected: exit 0.

Run: `npm run lint`
Expected: exit 0, no problems reported.

```bash
git add docs/fleet-api.md test/api-doc-examples.ts test/fleet/api-doc.test.ts test/fleet/api-doc-matcher.test.ts
git commit -m "docs(fleet): the client API reference, with every example run as a test against a real fleet"
```

---

### Task 17: Negative controls, `docs/domain.md`, READMEs, the bench gate

**Files:**
- Create: `scripts/bench-gate.ts` (the gate's arithmetic)
- Create: `scripts/bench-gate.test.ts`
- Modify: `scripts/bench-relay.ts` (`--gate`)
- Modify: `docs/domain.md` (the Fleet context: Delivery, Sticky lane, Receipt, Lane event; FL15–FL21; events; context map; one adapter)
- Modify: `apps/fleet/README.md`, `apps/node-agent/README.md`, `apps/hub/README.md`
- Modify: `scripts/negative-controls.ts` (the entries of Tasks 1–17)
- Test: `scripts/bench-gate.test.ts`; `node scripts/negative-controls.ts --check`; the `fc` controls run; the citation check (Step 19)

**Interfaces:**
- Consumes:
  - `scripts/negative-controls.ts`: `Control` (`{ id, task, file, find, replace, run, expect?, platform? }`), `--check`, `--only`, `--list`.
  - The negative-control entries that Tasks 1–16 list in their last steps.
  - `scripts/bench-relay.ts` as it is: `hooks`, `ops`, `answeredAt`, `lag`, `hookFailures`, `opFailures`, `HOOKS`, `RATE`.
  - The behaviour of Tasks 4–14 that the READMEs describe, from the spec and the Contracts.
- Produces:
  - `scripts/bench-gate.ts`:
    ```ts
    export const GATE: { readonly deliverP95Ms: 1000; readonly opMaxMs: 2000; readonly minRate: 2 };
    export function nearestRank(xs: readonly number[], p: number): number | null;
    export type BenchRun = { rate: number; hooks: number; answered: number; delivered: number; hookFailures: number; opFailures: number; deliver: number[]; op: number[] };
    export function gate(r: BenchRun): { pass: boolean; lines: string[] };   // the measured numbers, then "gate: PASS" or "gate: FAIL (<which>)"
    ```
  - `node scripts/bench-relay.ts [--hooks N] [--rate R] [--sends S] --gate`: 2 hooks a second unless `--rate` says otherwise; its last line is `gate: PASS` or `gate: FAIL (<which>)`, and it exits 1 unless the gate holds (ruling 38; Task 21 runs it on the PC's HDD before the hook swap).
  - The text of the domain model and the READMEs.
  - Negative-control entries `fc15-*`, `fc16-*` and `fc17-*`.

- [ ] **Step 1: Write the gate's test, `scripts/bench-gate.test.ts`**

```ts
// The hook swap's gate (scripts/bench-gate.ts; fleet clients spec §6, "Gate for the swap"; plan/RECONCILIATION.md ruling 38)
// on numbers made up to sit on each side of its limits: the arithmetic, not the bench. scripts/bench-relay.ts --gate prints
// these lines, the last one `gate: PASS` or `gate: FAIL (…)`, and exits 1 when the gate fails.
import { describe, expect, it } from "vitest";
import { GATE, gate, nearestRank, type BenchRun } from "./bench-gate.ts";

const range = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
// A run that passes: 2 hooks a second, all 100 answered and delivered, deliveries of 1 to 100 ms, ops of 10 ms.
const good: BenchRun = {
  rate: 2, hooks: 100, answered: 100, delivered: 100, hookFailures: 0, opFailures: 0, deliver: range(100, i => i + 1), op: range(40, () => 10),
};
const last = (r: BenchRun) => gate(r).lines.at(-1);

describe("nearestRank", () => {
  it("is the smallest sample with at least p % of the samples at or below it", () => {
    expect(nearestRank(range(100, i => i + 1), 95)).toBe(95);
    expect(nearestRank(range(20, i => i + 1), 95)).toBe(19);
    expect(nearestRank([7], 95)).toBe(7);
    expect(nearestRank([], 95)).toBeNull();
    expect(nearestRank([5, 1, 4, 2, 3], 50)).toBe(3);               // in any order
    expect(nearestRank([5, 1, 4, 2, 3], 100)).toBe(5);
  });
});

describe("the gate", () => {
  it("passes a run within both limits: the measured numbers, then exactly `gate: PASS`", () => {
    expect(gate(good)).toEqual({
      pass: true,
      lines: ["gate: deliver p95 95.0 ms (bound 1000 ms), slowest op 10.0 ms (bound 2000 ms), 100/100 hooks delivered at 2/s", "gate: PASS"],
    });
  });

  it("holds the deliver p95 to 1 s: exactly 1000 ms passes, a little over fails", () => {
    const at = (ms: number): BenchRun => ({ ...good, deliver: range(100, i => (i < 94 ? 10 : ms)) });   // the 95th sample and up
    expect(last(at(GATE.deliverP95Ms))).toBe("gate: PASS");
    expect(gate(at(1000.5))).toMatchObject({ pass: false });
    expect(last(at(1000.5))).toBe("gate: FAIL (deliver p95 1000.5 ms over 1000 ms)");
  });

  it("holds every op to 2 s: one slow op among fast ones fails", () => {
    expect(last({ ...good, op: [...good.op, GATE.opMaxMs] })).toBe("gate: PASS");
    expect(last({ ...good, op: [...good.op, 2000.1] })).toBe("gate: FAIL (slowest op 2000.1 ms over 2000 ms)");
  });

  it("counts an op that failed or gave up as over the limit", () => {
    expect(last({ ...good, opFailures: 1 })).toBe("gate: FAIL (1 client ops failed or gave up)");
  });

  it("fails a run that lost hooks: unanswered at the relay, or never at the subscriber", () => {
    expect(last({ ...good, answered: 99, hookFailures: 1 })).toBe("gate: FAIL (1 of 100 hooks failed at the relay)");
    expect(last({ ...good, delivered: 97 })).toBe("gate: FAIL (3 hooks never reached the subscriber)");
  });

  it("fails a run slower than the gate's rate, or one with nothing measured, naming every bound it missed", () => {
    expect(last({ ...good, rate: 1 })).toBe("gate: FAIL (rate 1/s under 2/s)");
    const empty = gate({ ...good, hooks: 0, answered: 0, delivered: 0, deliver: [], op: [] });
    expect(empty).toEqual({
      pass: false,
      lines: ["gate: deliver p95 none (bound 1000 ms), slowest op none (bound 2000 ms), 0/0 hooks delivered at 2/s",
        "gate: FAIL (no hook reached the subscriber; no client op ran)"],
    });
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run --project units scripts/bench-gate.test.ts`

Expected: FAIL. The suite doesn't load: `Error: Cannot find module './bench-gate.ts' imported from …/bench-gate.test.ts`.

- [ ] **Step 3: Write `scripts/bench-gate.ts`**

```ts
// The hook swap's gate (fleet clients spec §6, "Gate for the swap"; Task 17): measured with scripts/bench-relay.ts on the
// owner's PC, its HDD, at 2 hooks a second, a hook reaches a subscriber within 1 s at p95, and no client op through the
// fleet takes over 2 s while hooks flow. If it isn't met, the fleet's intake commits move to a worker thread (spec §6), and
// the swap waits. Percentiles are by the nearest-rank method: the smallest sample with at least p % of the samples at or
// below it, so a p95 is always a time some hook really took.
// Its last line is `gate: PASS`, or `gate: FAIL (<which bound>)` (plan/RECONCILIATION.md ruling 38), which the rollout
// greps for; the line before it gives the measured numbers.
export const GATE = { deliverP95Ms: 1000, opMaxMs: 2000, minRate: 2 } as const;

export function nearestRank(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}

// One run as bench-relay counts it: the hooks sent, answered by the relay and delivered to the subscriber; the deliver
// times (from a hook's answer to its arrival at the subscriber) and the client ops' times while hooks flowed, in ms; the
// ops that failed or gave up.
export type BenchRun = {
  rate: number; hooks: number; answered: number; delivered: number; hookFailures: number; opFailures: number; deliver: number[]; op: number[];
};

const ms = (v: number | null) => (v === null ? "none" : `${v.toFixed(1)} ms`);

export function gate(r: BenchRun): { pass: boolean; lines: string[] } {
  const p95 = nearestRank(r.deliver, 95);
  const slowest = r.op.length ? Math.max(...r.op) : null;
  const failed: string[] = [];
  if (r.rate < GATE.minRate) failed.push(`rate ${r.rate}/s under ${GATE.minRate}/s`);
  if (r.hookFailures > 0 || r.answered < r.hooks) failed.push(`${r.hooks - r.answered} of ${r.hooks} hooks failed at the relay`);
  if (r.delivered < r.answered) failed.push(`${r.answered - r.delivered} hooks never reached the subscriber`);
  if (p95 === null) failed.push("no hook reached the subscriber");
  else if (p95 > GATE.deliverP95Ms) failed.push(`deliver p95 ${ms(p95)} over ${GATE.deliverP95Ms} ms`);
  if (r.opFailures > 0) failed.push(`${r.opFailures} client ops failed or gave up`);
  if (slowest === null) failed.push("no client op ran");
  else if (slowest > GATE.opMaxMs) failed.push(`slowest op ${ms(slowest)} over ${GATE.opMaxMs} ms`);
  const measured = `gate: deliver p95 ${ms(p95)} (bound ${GATE.deliverP95Ms} ms), slowest op ${ms(slowest)} (bound ${GATE.opMaxMs} ms), `
    + `${r.delivered}/${r.hooks} hooks delivered at ${r.rate}/s`;
  return { pass: failed.length === 0, lines: [measured, failed.length ? `gate: FAIL (${failed.join("; ")})` : "gate: PASS"] };
}
```

- [ ] **Step 4: Run it**

Run: `npx vitest run --project units scripts/bench-gate.test.ts`
Expected: PASS, `Tests  7 passed (7)`.

- [ ] **Step 5: Give `scripts/bench-relay.ts` its `--gate` flag**

Make five edits.

1. In the header comment, replace the usage line `//   node scripts/bench-relay.ts [--hooks 300] [--rate 5] [--sends 10]` with:

   ```ts
   //   node scripts/bench-relay.ts [--hooks 300] [--rate 5] [--sends 10] [--gate]
   // --gate: also judge the run by the hook swap's gate (scripts/bench-gate.ts; fleet clients spec §6). The rate is then 2
   // hooks a second unless --rate says otherwise, and the gate refuses a lower one. The output ends with the measured numbers
   // and a last line, `gate: PASS` or `gate: FAIL (<which bound>)` (plan/RECONCILIATION.md ruling 38); the exit is 0 or 1.
   // Run it on the disk the fleet uses: TMPDIR points there.
   ```

2. After `import { expectOf, … } from "../test/fleet-harness.ts";`, add:

   ```ts
   import { gate, nearestRank } from "./bench-gate.ts";
   ```

3. Replace the `parseArgs` line with:

   ```ts
   const { values } = parseArgs({ options: { hooks: { type: "string", default: "300" }, rate: { type: "string" }, sends: { type: "string", default: "10" }, gate: { type: "boolean", default: false } } });
   ```

   and the line after it, `const HOOKS = Number(values.hooks), RATE = Number(values.rate), SENDS = Number(values.sends);`, with:

   ```ts
   const HOOKS = Number(values.hooks), RATE = Number(values.rate ?? (values.gate ? "2" : "5")), SENDS = Number(values.sends);
   ```

4. Replace the `pct` line with this one, so the printed p95 is the one the gate judges:

   ```ts
   const pct = (xs: number[], p: number) => nearestRank(xs, p) ?? 0;
   ```

5. Find the top-level `try {` at the start of a line, right after the `const body = (i: number) => ({ … });` helper and before `console.log(`node ${process.version}, …`)`. (The `try {` inside `fsyncProbe` is indented and stays as it is.) Put `let code = 0;` on a line of its own just above it. After the line that prints `hooks answered …`, inside that `try`, add:

   ```ts
     if (values.gate) {
       const verdict = gate({ rate: RATE, hooks: HOOKS, answered: answeredAt.size, delivered: lag.length, hookFailures, opFailures, deliver: lag, op: ops });
       for (const l of verdict.lines) console.log(l);
       if (!verdict.pass) code = 1;
     }
   ```

   Replace the last line, `process.exit(0);`, with `process.exit(code);`.

- [ ] **Step 6: Run the bench briefly with the gate, once passing and once failing**

The bench runs through the harness: temporary HOMEs, an isolated tmux server, random ports.

Run: `node scripts/bench-relay.ts --hooks 20 --sends 2 --gate; echo "exit $?"`

Expected on this Mac's SSD:
- the header line, which says `20 hooks at 2/s`: `--gate` sets the rate;
- the six percentile lines (fsync before and after, hook, op, send, deliver);
- `hooks answered 20/20, delivered 20; …`;
- a line starting `gate: deliver p95 `, then the last line, exactly `gate: PASS`;
- `exit 0`.

Run: `node scripts/bench-relay.ts --hooks 6 --rate 1 --sends 1 --gate; echo "exit $?"`

Expected: the last line `gate: FAIL (rate 1/s under 2/s)`, then `exit 1`.

The gate's real run is on the PC's HDD, at 2 hooks a second, and belongs to the rollout (Task 21, step 3).

- [ ] **Step 7: Commit**

```bash
git add scripts/bench-gate.ts scripts/bench-gate.test.ts scripts/bench-relay.ts
git commit -m "test(scripts): bench-relay --gate judges the hook swap's numbers, p95 delivery within 1 s and no op over 2 s"
```

- [ ] **Step 8: Check that `docs/domain.md` doesn't have the new terms yet**

Run: `grep -c '^| Sticky lane |\|^| Receipt |\|^| Lane event |\|^| FL21 |' docs/domain.md; grep -c '^| Delivery |' docs/domain.md`

Expected: `0`, then `1`. The one Delivery today is the Escalation context's.

- [ ] **Step 9: Add Delivery, Sticky lane, Receipt and Lane event to the Fleet context of `docs/domain.md`**

The domain model names no vendor outside its adapter table, so these say "the agent CLI". E13, the Escalation context's rule for a Decision delivered, comes with Task 12 and its code (ruling 26); this task doesn't add it again. Make seven edits.

1. In the Fleet terms table, after the row that starts `| Hook bus |`, add:

   ```markdown
   | Delivery | A message for one lane that runs the agent CLI. It is queued on the lane's node, typed into the lane once, when the lane can take it (never over a menu or the principal's own text), and confirmed by a Receipt. The sender names it by an id of its own, namespaced like an Operation key; the same id with the same content is the same Delivery. Its states: queued, typed, held (in the CLI's own queue), delivered, uncertain, given up. | An Escalation's Delivery (one attempt to show an Escalation on an Endpoint); a keyed `pane.send`, which types at once or refuses. |
   | Sticky lane | A lane name a Delivery follows wherever its node runs it: through a restart in a new pane and a new session, and, while no window has it, on the node that last had it. The manager's, by default. | Any other lane name: that binds a Delivery to the session it had when the Delivery was queued. |
   | Receipt | The lane's own conversation (the agent CLI's transcript of the session the text was typed into) showing that it took the text: a prompt that holds it, or the entry that takes it from the CLI's own queue into a turn. For a command that starts a new session, the lane's session changing to a new one after the typing. | The paste having happened, the input box emptying, or a transport "ok". |
   | Lane event | A fact about a lane that the Fleet derives from its hooks and its session state, and publishes to every client: finished (a turn ended, with the worker's STATUS line), needs input (a menu waits), answered (it no longer does), stop failure (a turn ended on an error). Kept 7 days, and delivered to the manager in batches, as Deliveries. | A hook event (its raw input); an Escalation (the hub decides what needs the principal). |
   ```

2. In the `| Alert |` row, replace `a lane name in conflict, a dead letter, a full backlog. |` with `a lane name in conflict, a dead letter, a full backlog, a Delivery still waiting after 2, 15 or 60 minutes, a subscriber more than a minute behind. |`.

3. Replace `**LaneName** and **HookStream** (with what each subscriber has had delivered).` with `**LaneName**, **HookStream** (with what each subscriber has had delivered), **Delivery** (its state, and the session it is bound to or was typed into) and **LaneEvent** (with whether the manager has had it).`

4. After the row that starts `| FL14 |`, add:

   ```markdown
   | FL15 | A Delivery is stored on its node, synced to the disk, before its sender is told it is queued: from then on the sender may stop retrying. A refusal (`id_conflict`, `no_session`, `node_offline`, `lane_conflict`, …) queued nothing. The same id with the same target and text is the same Delivery; with other content it is refused. |
   | FL16 | A Delivery is typed into its lane at most once, under its id as an Operation key (FL7), so a node that died while typing never types it again. The one exception: the agent CLI dropped the line on an interrupt, and the input box is clear and the session idle. Then it is typed once more, under a key of its own, and never a third time. |
   | FL17 | A Delivery is delivered only on a Receipt, and each Receipt confirms one Delivery, the earliest still waiting. A Delivery typed and never seen taken by its deadline is uncertain and never typed again; one never typed by then is given up (expired). |
   | FL18 | A Delivery is typed only into a lane with a live session of the agent CLI, whatever that session is doing, never over a menu or the principal's own text, and one at a time per lane, in the order queued: one typed and still waiting for its Receipt holds the next back for at most a minute. Until then it waits, and says why. |
   | FL19 | A Delivery to a Sticky lane follows the name to whichever window and session hold it on the node that last had it. A Delivery to any other lane name reaches only the session it was bound to when queued, and one to a Worker ID only that pane: if another session takes the name, or the pane is gone, the Delivery is given up (gone). |
   | FL20 | Each Lane event is stored in the same synced commit as the hook events it came from, published to every client, and delivered to the manager at least once, in batches; answered is published only. The manager's own lane, and the lanes its configuration ignores, raise none. |
   | FL21 | A subscriber answers 2xx once it has an event, and never refuses one for a reason of its own (a downstream outage, a failed handler): one refused event holds up its whole stream. An Alert is raised when a subscriber's oldest undelivered event is a minute old. |
   ```

5. In the Fleet's events paragraph, replace `HookDeadLettered, AlertRaised.` with `HookDeadLettered, AlertRaised; DeliveryQueued, DeliveryTyped, DeliveryHeld, DeliveryDelivered, DeliveryUncertain and DeliveryGivenUp (each with the client that sent it, its target and its reason, never its text), LaneStarted, LaneStopped, KeysPressed (never the keys) and LaneEventRaised.` In the same paragraph, replace `They are kept until delivered, plus 24 hours.` with `They are kept until delivered, plus 24 hours. Lane events, and the states of finished Deliveries, are kept 7 days.`

6. In the context map, replace the bullet that starts `- *Fleet supplies Observation and Steering*` with:

   ```markdown
   - *Fleet supplies Observation and Steering* (customer and supplier). Observation reads workers, screens and transcripts through it. A Decision (E8) or a Command (S5) for the manager reaches it as a Delivery: once queued, the answer counts as given; delivered, by a Receipt, it is recorded (E13); uncertain, it is never typed again and the Ask is not opened again; given up, nothing reached the manager and the Ask opens again. A Command to another lane reaches its pane as a keyed operation (FL7). Neither is typed twice across a dropped connection. The Hook bus feeds the chat bot, a subscriber, which turns hook events into Escalations through its own adapter; Lane events reach the manager as Deliveries.
   ```

7. In the adapters table, after the row that starts `| Hook relay (`, add:

   ```markdown
   | Claude Code's transcripts and session files, for deliveries (`morndo-node`) | a prompt, a queue entry or an attachment that carries a typed text to a Receipt (held, delivered, dropped, or no verdict); the session file's status to a lane's session state (busy, idle, waiting, shell); the menu on its screen to the question of a needs-input Lane event |
   ```

- [ ] **Step 10: Check the domain model**

Run: `grep -c '^| Sticky lane |\|^| Receipt |\|^| Lane event |\|^| FL21 |' docs/domain.md; grep -c '^| Delivery |' docs/domain.md; grep -n 'Claude' docs/domain.md | grep -v '^[0-9]*:| ' || echo "vendor names only in tables"`

Expected:
- `4`;
- `2`;
- `vendor names only in tables`: every line naming the vendor is a table row (the adapters table), as before.

Then:
- read the Fleet section once, top to bottom;
- check every FL number from FL1 to FL21 appears exactly once: `grep -o '^| FL[0-9]* |' docs/domain.md | sort | uniq -d` prints nothing;
- check that the section's terms agree with `docs/fleet-api.md`.

- [ ] **Step 11: Commit**

```bash
git add docs/domain.md
git commit -m "docs(domain): Delivery, Sticky lane, Receipt and Lane event in the Fleet context, with FL15 to FL21"
```

- [ ] **Step 12: Check that the READMEs don't describe the new parts yet**

Run: `grep -c 'stickyLanes\|subscriber_lagging' apps/fleet/README.md; grep -c 'lane.deliver\|killAfterEffect' apps/node-agent/README.md; grep -c 'MORNDO_MANAGER_QUEUE\|morndo lanes' apps/hub/README.md`

Expected: `0`, `0`, `0`. If Task 12 or 14 already added a row or a section that Step 15 adds, replace theirs with Step 15's text, and keep anything they wrote that Step 15 doesn't cover.

- [ ] **Step 13: `apps/fleet/README.md`**

Make nine edits.

1. In the Files table's `fleet.db` row, replace `alerts, audit (kept 90 days, alerts included). Numbered migrations;` with:

   ```markdown
   alerts, audit (kept 90 days, alerts included), the latest state of each delivery (`lane_deliveries`, never its text), the node that last had each sticky lane name, and lane events (kept 7 days, each marked once the manager has had it). Commits are synced to the disk only where what they guard must outlive the machine: the intake of hook and lane events, before the node is told they are stored, and joins, revocations and keys. Delivered marks, deliveries, the audit and alerts are not (`synchronous=NORMAL`): a mark lost to a power cut means one more delivery, which its receiver skips by its key or id. Events that arrive within 25 ms share one intake commit, and on macOS the database is opened with `fullfsync`. Numbered migrations;
   ```

2. In the Config table, after the `subscribers` row, add:

   ```markdown
   | `stickyLanes` | `["manager"]` | Lane names a delivery follows across a restart: while no window has the name, a delivery to it goes to the node that last had it and waits there (`no_pane`). Any other name binds a delivery to the session it had when queued. |
   | `laneEvents` | `{ "deliverTo": "manager", "header": "[lane-event] Lane events (handle them as your instructions say):", "ignore": [], "batchMs": 3000 }` | Lane events delivered to a lane: batched for `batchMs`, one delivery per batch (split at 8000 characters), the `header` line, then one JSON line per event. `deliverTo: null` turns delivery off; the events are still published and kept. `ignore`: globs of lane names that raise none. |
   ```

3. In the Client API table, replace the `GET /v1/caps` row with:

   ```markdown
   | `GET /v1/caps` | `{ api: [1], stickyLanes }`: the API versions served, and the lane names deliveries follow across a restart |
   ```

4. After the `GET /v1/files/…` row, add:

   ```markdown
   | `POST /v1/deliveries` | `{ id, lane \| workerId, text, ttlMs? }`: a delivery, queued on the lane's node; 200 `{ ok: true, delivery }`. A refusal is 200 `{ ok: false, error }`, as `/v1/op` answers an op's refusal; a body that doesn't fit is 400 `{ ok: false, error }` (`bad_args`; 415 not JSON, 413 over 1 MiB, in the same shape). The same id with the same content is the same delivery. |
   | `GET /v1/deliveries/<id>` | `{ delivery, stale }`, or 404 `{ error: "no_such_delivery" }` |
   | `GET /v1/deliveries?lane=&state=` | `{ deliveries }`: the newest 1000 of the last 7 days, oldest first, each with `stale` (true while its node is offline) |
   | `POST /v1/deliveries/<id>/cancel` | `{ ok: true, delivery }` for one still `queued`; 200 `{ ok: false, error }` (`already_typed`) past that; 404 `{ error: "no_such_delivery" }` for an id it doesn't know |
   | `GET /v1/lane-events?since=<seq>` | `{ events }`: lane events after `seq`, at most 1000, oldest first, from the last 7 days |
   ```

5. In the `WS /v1/events` row, replace `` `status`, `inventory`, `health`, `conflict`, `alert`, the current state first. `` with `` `status`, `inventory`, `health`, `conflict`, `alert`, `delivery` (a delivery's new state) and `lane` (a lane event); the current status, inventory and health first. ``.

6. After the paragraph that ends with `curl --unix-socket ~/.local/state/morndo-fleet/fleet.sock http://fleet/v1/nodes`.`, add this paragraph:

   ```markdown
   The full reference, with every route, op, event and error code, and an example of each that runs as a test against a real fleet: [`docs/fleet-api.md`](../../docs/fleet-api.md).
   ```

7. Before `## Hook bus`, add:

   ```markdown
   ## Deliveries

   A delivery is a message for one lane running Claude Code. It is queued on the lane's node, typed once when the lane can take it, and confirmed from the lane's transcript (design: [fleet clients](../../docs/design/fleet-clients/README.md) §4; reference: [`docs/fleet-api.md`](../../docs/fleet-api.md) §6). This service:
   - routes `POST /v1/deliveries` and its cancel to the lane's node, as `lane.deliver` and `delivery.cancel`: a name in `stickyLanes` to the node that last had it while no window has it, any other name to its owner;
   - refuses a new delivery to an offline node (`node_offline`), so nothing is queued where it can't be stored;
   - refuses `lane.deliver` and `delivery.cancel` on `POST /v1/op` (400 `bad_args`): a delivery goes through its route, where the fleet resolves its target and keeps its mirror;
   - keeps each delivery's latest state from the node's `ev.delivery` in `fleet.db` (never the text), serves it at `GET /v1/deliveries`, marked `stale` while the node is offline, and publishes each change on `/v1/events`;
   - raises `delivery_waiting` for a delivery still `queued`, `typed` or `held` after 2, 15 and 60 minutes;
   - audits each delivery and its outcome with its client and target, never its text.

   ## Lane events

   Built per node and window, from two sources:
   - the hooks: `finished` from `/hook/stop`, `stop_failure` from `/hook/failure`. Either Claude Code's own body or the owner's older script body is read: `docs/fleet-api.md` §11.3.
   - the session states the node reports: `needs_input` and `answered`, which the node sends through its hook stream as `/lane`.

   Each is stored in the same synced intake commit as the hooks, kept 7 days, served at `GET /v1/lane-events?since=` and published on `/v1/events`.

   `laneEvents` delivers them to a lane, the manager:
   - batched for `batchMs`, one delivery per batch (split at 8000 characters);
   - the `header` line, then one JSON line per event in the shape `lane-events-push` used: `{ ts, lane, sessionId, event, status, firstLine, bg, crons }`;
   - the delivery id is `fleet:lane-events:<node>:<first event's time, ms>`, with `-1`, `-2` … for a batch split over 8000 characters, and `.2`, `.3` … for a batch queued again after its delivery was given up.

   What is not delivered:
   - `answered`;
   - anything from the manager's own lane, or from lanes matching `ignore`, which raise none.

   A batch whose delivery is given up is queued again with the next one. After a restart, the events the manager hasn't had are sent. Events stored while `deliverTo` is `null` are never delivered later, so turning delivery on doesn't flood the manager. A Stop or StopFailure hook the relay couldn't place in a window makes no lane event.

   ```

8. Before `## Alerts`, add:

   ```markdown
   **The subscriber contract** ([`docs/fleet-api.md`](../../docs/fleet-api.md) §13):
   - A subscriber answers 2xx once it has an event, and never refuses one for a reason of its own downstream (a chat service that blocks it, a failed handler). It keeps what it can't act on yet, and acts later.
   - An event it keeps refusing holds up every later event of its stream.
   - `subscriber_lagging` is raised when a subscriber's oldest undelivered event is older than 60 s.
   - Delivered marks are not synced: after a power cut a subscriber may get an event once more, and skips it by its `Idempotency-Key`.
   - `/lane` (the node's lane state events) is the node's own path: never a subscriber's, and never counted as an unrouted hook.

   ```

9. In the Alerts table, after the `lane_conflict` row, add:

   ```markdown
   | `delivery_waiting` | A delivery is still `queued`, `typed` or `held` 2, 15 and 60 minutes after it was queued, once each; `detail` `{ id, lane, state, reason, minutes }`. |
   | `subscriber_lagging` | A subscriber's oldest undelivered event is older than 60 s; `detail` `{ subscriber, oldestAgeMs, streams }`. |
   ```

Then, in the Checks block, after the `node e2e/fleet-two-node.e2e.ts` line, add:

```sh
npx vitest run --project fleet test/fleet/api-doc.test.ts   # docs/fleet-api.md: every example against a real fleet
node scripts/bench-relay.ts --rate 2 --gate                 # the hook swap's gate on the disk TMPDIR points at; exit 1 when it fails
```

- [ ] **Step 14: `apps/node-agent/README.md`**

Make six edits.

1. In the Files table's `agent.db` row, replace `The one commit synced is a done key's `started`, before its side effect (`FULL` for that transaction): a retry may go to another pane than the first attempt, so it must survive a power loss or a failing disk; if the sync fails, nothing is typed.` with:

   ```markdown
   Two commits are synced (`FULL` for that transaction). The first is a done key's `started`, before its side effect: a retry may go to another pane than the first attempt, so it must survive a power loss or a failing disk, and if the sync fails, nothing is typed. The second is storing a delivery, before its sender is told it is queued: if that sync fails, the delivery is refused, never silently lost. The database also holds the delivery queue (migration 3): each delivery's text, target, state, and the session it is bound to or was typed into. Final ones are pruned after 7 days, with the done keys.
   ```

2. In the Policy table, after the `tmuxSocket` row, add:

   ```markdown
   | `launch` | `{ "command": ["claude"], "via": "shell" }` | How `lane.start` runs Claude Code. `{account}` in `command` is the op's `account`: a command without it refuses an op that names one, and a command with it refuses an op that names none. `resume` adds `--resume <session>`; an op adds nothing else. `via: "shell"` starts the user's shell and pastes the command once its prompt shows, so the window outlives Claude Code and `claude-pool` can still move the lane. `direct` runs the command as the window's own. The owner's PC: `{ "command": ["claude-as", "{account}"], "via": "shell" }`. |
   | `protected` | `["manager"]` | Lane names `lane.stop` refuses (`denied`). |
   ```

3. Before `## Hook relay (`127.0.0.1:8787`)`, add:

   ```markdown
   ## Deliveries (`lane.deliver`, `delivery.cancel`)

   The node's delivery queue (design: [fleet clients](../../docs/design/fleet-clients/README.md) §4). Clients use the fleet's `/v1/deliveries` ([`docs/fleet-api.md`](../../docs/fleet-api.md) §6), never these ops directly.
   - **Storing.** `lane.deliver { id, target, text, ttlMs? }` stores the delivery in `agent.db`, synced, then answers `queued`. `notAfter` is set on this node's clock. The same id with the same target and text answers its current state; with other content, `id_conflict`.
   - **Only lanes with a live Claude Code session** take deliveries, whatever its `status` (`shell` means a shell command is running under it). A pane with no live session (no session file, or its process gone) makes a delivery wait (`no_session`) when its lane is sticky or the pane's process started in the last 2 minutes, and refuses it otherwise.
   - **Typing:**
     - one at a time per lane, in the order queued;
     - tried at once, on each change of the session's status, of a hook of its session, or of the inventory, and at least every 5 s;
     - a delivery typed or held and still waiting for its receipt holds the next one back (`earlier`) for at most 60 s;
     - each try is a `pane.send` under the delivery's id as its done key, with all of its checks (menu, draft, input box, the pane lock). A refusal leaves the delivery `queued`, with that reason;
     - a line still in the box after Enter gets Enter again while the box shows exactly that line, at most twice more;
     - a `started` key found after a restart moves the delivery to `typed`, never typed again.
   - **Confirming,** from the transcript of the session it was typed into, by the receipt rules in `packages/node-ops` (`receipt.ts`):
     - a prompt that holds the text, or a queued line taken into a turn: `delivered`;
     - an `enqueue`: `held`;
     - a `dequeue`: no verdict;
     - a line Claude Code dropped on an interrupt (`cleared_on_cancel`): typed once more under `<id>#2` if the box is clear and the session idle, else `uncertain`;
     - a slash command that starts a new session (`/clear`, `/new`): the pane's session changing to a new id after the typing.

     Each receipt confirms one delivery.
   - **Expiring.** Past `notAfter`, a `queued` delivery is given up (`expired`). A `typed` or `held` one is `uncertain`, and never typed again.
   - **Cancelling.** `delivery.cancel { id }` gives up a `queued` delivery. Past that it answers `already_typed`.
   - **Events.** `ev.delivery` on every change. After each (re)connect it also sends the state of each delivery not final, and the final ones of the last hour.

   ## Lanes, keys, captures and session state

   - **`lane.start { name, cwd, account?, resume?, prompt? }`** runs the policy's `launch`.
     - It answers `{ workerId, waiting: "trust" }` when Claude Code asks whether to trust the folder. Accepting stays the client's decision.
     - `prompt` becomes a delivery to the new pane, with id `<client>:prompt:<the first 16 hex digits of the SHA-256 of the start's key>`. It waits for Claude Code to start, then is typed once.
   - **`lane.stop { name, mode? }`.**
     - `exit`, the default, types `/exit` as a delivery is typed, answers Claude Code's exit prompt, then answers once the window has closed or is back at its shell, or `uncertain` after 30 s.
     - `kill` closes the window.
     - Names in `protected` are refused with `denied`.
   - **`pane.capture { workerId, lines (at most 2000), attributes?, join? }`** returns up to 256 KiB (as JSON) of the screen's last lines, with tmux's attribute escapes when asked, and wrapped lines joined unless `join` is false. `pane.captureMany` keeps its 6 KiB per pane.
   - **`pane.keys`** takes `names`, tmux key names from an allow-list (`Enter`, `Escape`, `Tab`, `BSpace`, the arrows, `Home`, `End`, `PageUp`, `PageDown`, `C-c`, `C-d`, `C-u`, `Space`, digits, letters), or `data`, literal text. Never both.
   - **Session state.** The inventory gives each pane, from its live session, the `status` as Claude Code writes it in `~/.claude/sessions/<pid>.json` (`busy`, `idle`, `waiting`, or `shell`: a shell command running under it), `pid` (Claude Code's process), and `topic` and `lastPrompt` (the session's latest `ai-title` and `last-prompt` entries, from a tail scan of its transcript, cached per session). `status` and `pid` are null without a live session; `topic` and `lastPrompt` are absent when unknown.
   - **Lane state events.** When a session's status turns `waiting`, the node reads the menu's question from the screen and sends a `needs_input` lane state event. When it leaves `waiting`, it sends `answered`. Both go through the hook stream as `/lane`, kept and replayed like hooks.

   ```

4. In the Hook relay section, replace `Each event gets this node's name and the window it finds through `TMUX_PANE` or `session_id`, then flows in order` with `Each event gets this node's name and the window it finds through `TMUX_PANE` or `session_id`, else the body's own `window` (a `notify` sent from outside any pane), then flows in order`.

5. In the Test hooks table, replace the `noDoneKeys` row with:

   ```markdown
   | `noDoneKeys: true` | Keys are neither recorded nor consulted, the delivery queue's included (negative control) |
   ```

6. After the `fixedStreamId` row of the Test hooks table, add:

   ```markdown
   | `killAfterEffect: "<substring>"` | For a keyed op whose key contains it: right after its side effect returns, before `done` is committed, the agent kills itself (SIGKILL). Once per process. |
   | `noSessionBinding: true` | A delivery to a lane name that isn't sticky follows the name as a sticky one does (negative control) |
   | `retypeUnderFirstKey: true` | The one retype after `cleared_on_cancel` runs under the delivery's own id instead of `<id>#2` (negative control) |
   | `deliveryStartGraceMs: <n>` | A new pane with no session makes a delivery wait n ms instead of 2 minutes |
   ```

- [ ] **Step 15: `apps/hub/README.md`**

Make three edits.

1. In the Settings table, before the `MORNDO_OFFICE_NAME` row, add:

   ```markdown
   | `MORNDO_MANAGER_QUEUE` | on when `MORNDO_FLEET_SOCKET` is set | The manager's answers and commands go through the fleet's delivery queue. An answer counts as given once queued, and its card says "Queued, it will be delivered", then "Delivered", or "May have been delivered" when it was typed and never seen taken (it is never typed again, and the ask doesn't open again). An answer given up (expired, cancelled, or its lane gone) reached no one: its card says "Not delivered", and the ask opens again. `off` or `0` types to the manager directly, as before: a delivery still queued is cancelled first, and since a delivery's id is the key a direct send uses, nothing is typed twice. Without a fleet the hub always types directly. Commands to other lanes are typed directly either way. |
   ```

2. Before `## Checks`, add:

   ```markdown
   ## `morndo lanes`

   Every lane of every node, for anyone with the fleet's socket. It is a subcommand of the `morndo` console (`node apps/hub/src/main.ts lanes …`). It reaches the fleet over `MORNDO_FLEET_SOCKET`, `~/.local/state/morndo-fleet/fleet.sock` by default, and names itself `lanes` to it. The API it uses is documented, with examples that run as tests, in [`docs/fleet-api.md`](../../docs/fleet-api.md).

   | Command | What |
   |---|---|
   | `morndo lanes [--json]` | every lane: name, node, worker id, window, session status, pid, folder, title |
   | `morndo lanes peek <lane> [--lines N]` | its screen's last lines (default 40) |
   | `morndo lanes send <lane> <text \| ->` | a delivery to the lane (`-` reads the text from stdin as is; `--id` chooses its id). It prints the state and returns, or with `--wait <s>` waits that long for `delivered`. `--direct` types at once (`pane.send`), for a lane without Claude Code; `--id` then names its key. |
   | `morndo lanes keys <lane> <key…>` | keys by name (`Enter`, `Escape`, `C-c`, `Up`, the digits, …) |
   | `morndo lanes start <name> --cwd <dir> [--node <n>] [--account <a>] [--resume <session>] [--prompt <text>] [--json]` | a new lane, run by the node's launcher; the prompt is typed once Claude Code can take it. `--json` prints the result, with `waiting: "trust"` when Claude Code asks to trust the folder. |
   | `morndo lanes stop <lane> [--kill]` | `/exit`, typed as a delivery is; `--kill` closes the window, also after an exit that timed out. The node's protected lanes (the manager) are refused. |
   | `morndo lanes status <delivery id>` | a delivery's state |
   | `morndo lanes events` | lane events as they happen |

   | Exit | Meaning |
   |---|---|
   | 0 | accepted: for `send`, queued, typed, held or delivered; with `--wait`, delivered; for `stop`, stopped |
   | 2 | bad arguments |
   | 3 | late: with `--wait`, not delivered in time; for `stop`, not seen to stop in its 30 s (`--kill` may follow) |
   | 4 | not delivered: given up, uncertain, or refused; for `stop`, refused |
   | 5 | in doubt: the fleet was reached and didn't answer. Run it again with the same `--id`: that is safe, and it is never typed twice. Never type the text by hand instead. |
   | 69 | the fleet wasn't reached (EX_UNAVAILABLE): nothing was queued |

   Options may come after the lane's name. A refusal prints its error code (`no_session`, `node_offline`, `lane_conflict`, …) on stderr.

   ```

3. In the Checks block, after the `npx vitest run --project fleet` line, add:

   ```sh
   npx vitest run --project fleet test/fleet/api-doc.test.ts   # docs/fleet-api.md: every example against a real fleet
   ```

- [ ] **Step 16: Check the READMEs and commit**

Run: `grep -c 'stickyLanes\|subscriber_lagging' apps/fleet/README.md; grep -c 'lane.deliver\|killAfterEffect' apps/node-agent/README.md; grep -c 'MORNDO_MANAGER_QUEUE\|morndo lanes' apps/hub/README.md`

Expected: three numbers above 0: at least `4`, at least `2`, at least `3`.

Then check what the READMEs claim against the code on the branch:
- the commands in `morndo lanes`'s table against `node apps/hub/src/main.ts lanes --help`;
- the exit codes against Task 14's tests;
- the config defaults against `apps/fleet/src/config.ts` and `apps/node-agent/src/config.ts`.

Where the code differs from this text, the code was settled by its task: correct the README to it, and say what changed in the commit message.

```bash
git add apps/fleet/README.md apps/node-agent/README.md apps/hub/README.md
git commit -m "docs: fleet, node agent and hub READMEs for deliveries, lane events, the launcher and morndo lanes"
```

- [ ] **Step 17: Collect the negative controls in `scripts/negative-controls.ts`**

Tasks 1–14 added their entries in their own steps, so they are in already: adding them again would repeat their ids, which the runner refuses. Before the closing `];` of `CONTROLS`, add only this task's and Tasks 15–16's own entries:

```ts
  // ---- Fleet clients, Tasks 15–17 (docs/design/fleet-clients/plan/05-tests-docs.md). This sub-project's ids are
  // fc<task>-…, so they never collide with the fleet core's t<task>-… (plan/RECONCILIATION.md, ruling 1).
  // The doc test bites on an altered answer, and on an error code's `executed` changed in the doc.
  { id: "fc15-doc-answer", task: "fc15", file: "docs/fleet-api.md",
    find: `{ "api": [1], "stickyLanes": ["manager"] }`, replace: `{ "api": [1], "stickyLanes": ["boss"] }`,
    run: ["test/fleet/api-doc.test.ts"], expect: "stickyLanes" },
  { id: "fc15-doc-executed", task: "fc15", file: "docs/fleet-api.md",
    find: "| `id_conflict` | no |", replace: "| `id_conflict` | maybe |",
    run: ["test/fleet/api-doc.test.ts"], expect: "id_conflict" },
  // The matcher refuses an answer field its example doesn't name: an API that grew a field fails until it is documented.
  { id: "fc15-matcher-extra-field", task: "fc15", file: "test/api-doc-examples.ts",
    find: "    for (const k of Object.keys(a)) if (!Object.hasOwn(e, k)) return `${at}.${k}: not in the example (${show(a[k])})`;\n", replace: "",
    run: ["test/fleet/api-doc-matcher.test.ts"], expect: "a field the example doesn't name" },
  // The fake box writes an enqueue for a line typed while busy: the held drills rest on it.
  { id: "fc16-box-enqueue", task: "fc16", file: "test/fixtures/fake-claude-pane.ts",
    find: `queue.push(text); write("enqueue", text);`, replace: `write("userTyped", text);`,
    run: ["test/fleet/fake-box.test.ts"], expect: "expected 'delivered' to be 'held'" },
  // The bench gate's three judgements.
  { id: "fc17-gate-deliver-p95", task: "fc17", file: "scripts/bench-gate.ts",
    find: "else if (p95 > GATE.deliverP95Ms) failed.push(", replace: "else if (false) failed.push(",
    run: ["scripts/bench-gate.test.ts"], expect: "1000.5" },
  { id: "fc17-gate-op-max", task: "fc17", file: "scripts/bench-gate.ts",
    find: "else if (slowest > GATE.opMaxMs) failed.push(", replace: "else if (false) failed.push(",
    run: ["scripts/bench-gate.test.ts"], expect: "2000.1" },
  { id: "fc17-gate-lost-hooks", task: "fc17", file: "scripts/bench-gate.ts",
    find: "if (r.delivered < r.answered) failed.push(", replace: "if (false) failed.push(",
    run: ["scripts/bench-gate.test.ts"], expect: "never reached the subscriber" },
```

These controls are tests of their own, named "… (negative control)", so they need no entry (Global Constraints, "Negative controls as data"). Check that each one still exists:
- `test/fleet/drills-deliveries.test.ts`: "(negative control) without its done keys, the restarted agent types the delivery again" (spec §12: without the `started` check);
- `test/fleet/drills-receipts.test.ts`: "(negative control) the retype under the first key types nothing…";
- `test/fleet/drills-lanes.test.ts`: "(negative control) without the session binding, the message lands in the new lane";
- `test/fleet/drills-manager-queue.test.ts`: "(negative control) without the node's done keys, that direct retry types the answer a second time" (§9.1, ruling 66);
- `test/fleet/api-doc-matcher.test.ts`: the five cases under "(negative control) an altered answer fails".

If an entry from Tasks 1–14 has an id that collides, rename it to the `fc<task>-…` form and keep its text. A collision is either a duplicate among this sub-project's entries, or a `t<n>-…` id that the fleet core already uses. The runner refuses duplicate ids (`ENTRY … a second entry with this id`).

- [ ] **Step 18: Check every entry's text, then run this sub-project's controls**

Run: `node scripts/negative-controls.ts --check; echo "exit $?"`

Expected: one `ok` line per entry, no `STALE`, then `exit 0`. A `STALE` entry names its file. Its text moved since the task listed it: correct the entry's `find` to the code on the branch, still breaking the same guard.

The controls run on `HEAD` (the runner makes a worktree of it), so commit first:

```bash
git add scripts/negative-controls.ts
git commit -m "test(scripts): negative controls of the fleet clients, Tasks 1 to 17"
```

Run: `node scripts/negative-controls.ts $(node scripts/negative-controls.ts --list | awk -F'\t' '$2 ~ /^Task fc/ { printf "--only %s ", $1 }'); echo "exit $?"`

Expected: one `bit` line per `fc` entry, then `<N>/<N> controls bit; still pass 0, broke 0, timed out 0, skipped 0`, and `exit 0`. Here N is the number of `fc` entries; this part adds 7 of them. It takes a while: each control runs its tests twice, and the two doc controls start a fleet each time.

What a non-bite line means:
- `PASSED` or `ELSEWHERE`: the guard isn't what its test depends on. Report it to the task that listed the entry.
- `BASELINE`: its tests fail unchanged. Fix that first.

- [ ] **Step 19: Check that every external citation in the new code is dated (ruling 60)**

Global Constraints, "Primary docs": every library, API and version is cited with its URL and the date it was read. This step checks the new code itself.
- **What it reads:** each line added or changed on this sub-project's branches (`git diff` from the merge base with `main`, `*.ts`) that cites a URL in a comment.
- **What must hold:** the line, or the comment line right before or after it (a citation that wraps), says `read YYYY-MM-DD`.
- **What it leaves alone:** older lines, which this sub-project didn't touch.

Run:

```bash
node -e '
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const base = execFileSync("git", ["merge-base", "main", "HEAD"], { encoding: "utf8" }).trim();
const diff = execFileSync("git", ["diff", "--unified=0", "--diff-filter=AM", base, "HEAD", "--", "*.ts"], { encoding: "utf8" });
let file = "", line = 0, seen = 0, bad = 0;
for (const l of diff.split("\n")) {
  if (l.startsWith("+++ ")) { file = l.slice(6); continue; }
  const hunk = /^@@ -\S+ \+(\d+)/.exec(l);
  if (hunk) { line = Number(hunk[1]); continue; }
  if (!l.startsWith("+")) continue;
  const text = l.slice(1), at = line++;
  const url = text.indexOf("https://");
  if (url === -1 || !/\/\/|^\s*\*/.test(text.slice(0, url))) continue;      // only a comment cites
  seen++;
  const lines = readFileSync(file, "utf8").split("\n");
  const [before, after] = [lines[at - 2], lines[at]].map(n => (n ?? "").replace(/^\s*(?:\/\/|\*)\s*/, ""));   // the comment lines around it
  if (!/read\s+\d{4}-\d{2}-\d{2}/.test(`${before} ${text} ${after}`)) { bad++; console.log(`${file}:${at}: ${text.trim().slice(0, 140)}`); }
}
console.log(`${seen} cited URLs in new or changed comments, ${bad} without "read YYYY-MM-DD"`);
process.exit(bad ? 1 : 0);'
```

Expected: `<N> cited URLs in new or changed comments, 0 without "read YYYY-MM-DD"`, and exit 0. Each line it prints names a file, a line and its citation. For each one:
- read the source again and add `read <the date>` to the comment;
- or, where the URL isn't a source the code relies on, drop it.

Then run it again. Committed fixes go in the commit of the task that wrote the code. This check was tried on 2026-10-08 on a scratch repository holding this part's new files and one undated citation. It printed that one, with `5 cited URLs …, 1 without …` and exit 1. Without it, the output was `4 cited URLs …, 0 without …` and exit 0; an undated line left on `main` was not counted.

- [ ] **Step 20: The whole lane, as CI will run it**

Run: `npx vitest run --project fleet`
Expected: PASS, every file under `test/fleet`: the fleet core's, and this lane's nine (`fake-box`, the six drill files, `api-doc`, `api-doc-matcher`).

Run: `npx vitest run --project='!fleet'`
Expected: PASS, the unit and Chromium projects, `scripts/bench-gate.test.ts` among them, but, on macOS, process-start.test.ts's 2 (they read /proc). At 12c2811 on 2026-10-09: 300 files, 2178 tests (1 skipped).

Run: `npm run check`
Expected: exit 0.

Run: `npm run lint`
Expected: exit 0, no problems reported.

Run: `node scripts/negative-controls.ts --check`
Expected: exit 0.

Run: `pgrep -fl 'apps/(node-agent|fleet|hub)/src/main.ts|fake-claude-pane' || echo "nothing left running"`
Expected: `nothing left running`.

---

## Contract additions requested, and how they were settled

The reconciliation ([RECONCILIATION.md](RECONCILIATION.md)) settled every request of this part, as follows.

| # | Request | Settled |
|---|---|---|
| 1 | `test/fixtures/claude-code/templates.json` from Task 2 | Not needed. The fake box reads Task 2's recorded lines in `test/fixtures/claude-code/2.1.293/` directly and makes them its own (Task 16, Steps 1 and 4). |
| 2 | Agent test hooks `killAfterEffect`, `noSessionBinding`, `retypeUnderFirstKey`, `deliveryStartGraceMs` | Ruling 20, built in Task 5 (part 02). |
| 3 | `noDoneKeys` also covers the deliverer | Ruling 20: every typing goes through the executor (part 02). |
| 4 | Statuses of delivery refusals | Rulings 3 and 45, otherwise than asked: a refusal is 200 `{ ok: false, error }`, as on `/v1/op`; a body that doesn't fit is 400 (415, 413) `{ ok: false, error }` (`bad_args`), as `POST /v1/op` answers a malformed body (`client-api.ts:124`); an unknown id is 404 `{ error: "no_such_delivery" }` on GET and on cancel. The doc's examples and the READMEs follow it. |
| 5 | `/v1/op` refuses `lane.deliver` and `delivery.cancel` | Ruling 4 (400 `bad_args`). |
| 6 | What a delivery's answers hold | Ruling 43: a new delivery is answered `queued`, with `waiting` only while queued and a try found the lane not ready. The first prompt's delivery targets `{ workerId }` (part 02), with ruling 7's id. |
| 7 | Alert details | Ruling 25: `delivery_waiting { id, lane, state, reason, minutes }`, `subscriber_lagging { subscriber, oldestAgeMs, streams }`. |
| 8 | `LaneEvent.firstLine` and `bg`/`crons` | Ruling 44: the first non-blank line of `last_assistant_message`, else `text`, trimmed, at most 200 characters; `bg` and `crons` are counts. |
| 9 | Negative-control ids `fc<task>-…` | Ruling 1. |
| 10 | This lane runs Task 16, then 15, then 17 | Ruling 36. |
| 11 | `/lane` is not a subscriber path | Ruling 5, which adds that `/lane` is never counted as unrouted. |

**One more, from ruling 16:** the 60 s hold is `LIMITS.deliveryReceiptHoldMs` (ruling 42), which the drill uses.
