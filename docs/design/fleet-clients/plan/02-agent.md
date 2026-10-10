## Lane notes (agent)

- **Drafted, reconciled, then run.** This part was drafted on 2026-10-08 against the Contracts in [plan.md](../plan.md), and its code against `apps/node-agent` at `60a3036` (this branch), read in full where it changes.
  - [RECONCILIATION.md](RECONCILIATION.md)'s rulings 1, 7, 10–17, 19, 20, 42, 43 and 46 are applied, the same day, and the review round's 50–52, 54, 56 and 60. A ruling is cited where the code follows it.
  - Each "watch it pass" step gives the number of cases in the files as written. The executor records the counts that were really printed, as the fleet core's lane notes did.
- **What ran, in a scratch clone of this branch** (2026-10-08, after the review round; macOS, Node 26.3.1, tmux 3.6a, the repository's own `node_modules`, vitest 5.0.3):
  - Applied by their steps, each task committed there (the control runner tests HEAD):
    - part 01's Tasks 1 and 2 as committed at `37f03df`, plus ruling 48's `deliveryReceiptHoldMs: 60_000` in `LIMITS` by hand (part 01's text since adds that same line);
    - then Tasks 4, 5 and 6 of this part. Task 3 (`packages/fleet-client`) isn't used by the agent and wasn't applied.
  - macOS has no `flock(1)` or `timeout(1)`, which the pane lock runs, so stand-ins for both were on `PATH`. Linux has both.
  - Every count this part states held:
    - each "watch it pass" step's;
    - the whole agent suite: 31 files and 201 tests before Task 4, then 34 and 219, 38 and 266, 43 and 300 after Tasks 4, 5 and 6 (1 skipped throughout);
    - Task 5 Step 21's two failures, with `agent.ts` as Task 4 leaves it.
  - `tsc -p apps/node-agent`, `tsc -p tsconfig.tests.json` and `oxlint apps/node-agent` (type-aware) printed nothing.
  - `negative-controls.ts --check` passed after each task. With `--only`, all 45 controls of this part bit: `fc4` 9, `fc5` 20, `fc6` 15, and `t9-prune-not-wired` as Task 5 Step 23 changes it.
  - Fixed by that run, in this file:
    - lane.stop read a lane from 50 lines with history, where a box cleared at /exit stays (tmux's `scroll-on-clear`); it now reads what the pane shows;
    - the trust-dialog lane scrolled the recorded screen off its pane;
    - every new pane is in the start grace now (ruling 14), so `delivery-ops`' `no_session` case sets the grace to 0;
    - `fc6-exit-prompt-unanswered` expected text that vitest never prints.
  - Not run: Task 16's drills, which use this part's test hooks across processes.
- **What these tasks take from Tasks 1 and 2, as plan.md's Contracts state it after the reconciliation:**
  - Task 1 (`@morndo/protocol`):
    - `OP_ARGS` and `OpArgs` for `lane.deliver`, `delivery.cancel` and `pane.capture` (with `join?`, ruling 10);
    - `pane.keys` with `data?` and `names?`;
    - `lane.start` with `prompt?`, `lane.stop` with `mode?`;
    - `Pane` with `status`, `pid`, and the optional `topic?` and `lastPrompt?` (rulings 12, 13 and 46);
    - `WaitingReason` with `unavailable` (ruling 15);
    - the error codes `id_conflict`, `no_session` and `already_typed` in `ERROR_EXECUTED` (executed "no");
    - `EvDelivery` in `AgentMessage` and `AgentFrames`;
    - `"/lane"` in `HookEvent["path"]`;
    - the `LIMITS` keys of the Contracts, `deliveryReceiptHoldMs` (60 000, ruling 42) among them.

    `lane.deliver` and `delivery.cancel` are not in `KEYED_OPS`.
  - Task 2 (`@morndo/node-ops`):
    - `readReceipts`, `menuQuestion`;
    - `SessionInfo.status`;
    - on the `Tmux` adapter, `sendKeyNames(pane, names)`, `capture(pane, { lines, attributes, join })` and `pasteLiteral(pane, text)`.

    `join` is ruling 10's: plan.md's `Tmux` contract is `capture(paneId, { lines; attributes?; join? })`, `join` defaulting to true.

    The one-argument `capture(pane)` that `pane.captureMany` calls today is assumed to stay (the Contract says the adapter "gains" the new form).
- **Task 4 begins by bringing the agent onto Task 1's protocol (Steps 1–11):**
  - `pane.keys` by name, from Task 6's list;
  - `status` and `pid` in the inventory, also from Task 6's list, and `topic` and `lastPrompt` (ruling 13);
  - argument checks for the three new ops.

  Task 1 makes `Pane.status`, `Pane.pid` and the new `OpName`s required; `topic` and `lastPrompt` are optional (ruling 46) and come with them. Without these steps `tsc -p apps/node-agent` fails from the first task of this lane on (`args.ts`'s `CHECK` must cover every `OpName`). Task 6 does the rest.
- **Typing is one at a time per target, in the order stored** (rulings 16 and 42). A queued delivery waits `earlier` behind one queued before it, and behind one `typed` or `held` that waits for its receipt, for at most `LIMITS.deliveryReceiptHoldMs` (60 s) from that typing; then it types. Plan Review Focus 2 holds: one paste at a time per lane, and receipts match the earliest delivery waiting for one, so each is confirmed by its own. A delivery that never gets a receipt (a slash command the receipts miss, a lane that isn't Claude Code after all) holds its lane for a minute, not until its `notAfter`.
- **Test hooks for Task 16's drills** (ruling 20): `killAfterEffect`, `noSessionBinding`, `retypeUnderFirstKey` and `deliveryStartGraceMs`. They are built in Task 5, with unit tests here; the drills use them across processes. The deliverer has no done-key checks of its own: every typing goes through the executor, so `noDoneKeys` already covers it.
- **The agent's own tests use the agent's fake box, not the shared one.** Task 16 rewrites `test/fixtures/fake-claude-pane.ts` in wave 2 (its own session-file status, templates, a control file). The tests here use instead:
  - `apps/node-agent/test/fake-claude.fixture.ts`, extended in Task 6 with `/exit`;
  - a small helper, `apps/node-agent/test/claude-session.ts` (Task 4), which writes a pane's session file with the status the test sets, and turns what the box submitted into 2.1.293-shaped `user` prompts.

  So the rewrite can't change what these tests see.
- **The default launcher starts lanes from the shell** (`via: "shell"`, Contracts). A test that starts a lane sets `via: "direct"`, or a shell without rc files through tmux's `default-command`, so no test reads the account's own shell setup. `lane-worktree-ops.test.ts` is changed accordingly (Task 6).
- **Negative controls** use ids `fc<task>-…` (ruling 1; the fleet core's agent tasks were 6–9, so `t6-…` is taken). Each task appends its entries to `scripts/negative-controls.ts` at the end of `CONTROLS`. Lanes of one wave that append there meet in a merge conflict that keeps both blocks.
- **Where:** each step runs in the lane's worktree (`.worktrees/fc-agent`, branch `feat/fleet-clients-agent`) after `npm ci`.

# Tasks 4–6: the node agent (`apps/node-agent`)

Drafted for `docs/design/fleet-clients/plan.md`, lane **agent**, wave 1: Task 4, then 5, then 6. The spec is `docs/design/fleet-clients/README.md`, its §4 (the delivery queue), §5 (starting, stopping, reading and keying lanes) and §7 (lane events). §N refers to it; "core §N" to the fleet core's.

### Task 4: Agent: migration 3 and the delivery store

**Files:**
- Modify (the agent on Task 1's protocol): `apps/node-agent/src/ops/args.ts`, `apps/node-agent/src/ops/inventory.ts`, `apps/node-agent/src/ops/pane-ops.ts`, `apps/node-agent/src/ops/runtime.ts`
- Create: `apps/node-agent/src/ops/transcript-titles.ts` (the inventory's `topic` and `lastPrompt`, RECONCILIATION.md ruling 13)
- Modify: `apps/node-agent/src/db/migrations.ts` (migration 3)
- Create: `apps/node-agent/src/deliveries/store.ts`
- Modify: `scripts/negative-controls.ts` (this task's entries)
- Test: `apps/node-agent/test/claude-session.ts` (helper), `apps/node-agent/test/session-state.test.ts`, `apps/node-agent/test/transcript-titles.test.ts`, `apps/node-agent/test/delivery-store.test.ts`, `apps/node-agent/test/db.test.ts` (modified)

**Interfaces:**
- **Consumes:**
  - from Task 1:
    - `LIMITS.maxDeliveryId`, `deliveryTtlMs`, `deliveryKeepMs` and `captureMaxLines`;
    - `KEY_NAMES`;
    - `OP_ARGS["pane.keys" | "pane.capture" | "lane.deliver" | "delivery.cancel"]`;
    - the types `Delivery`, `DeliveryState`, `DeliveryTarget`, `WaitingReason` (with `unavailable`, ruling 15), `GiveUpReason`, `SessionStatus`, `Pane` (with `status`, `pid`, and the optional `topic` and `lastPrompt`, rulings 12, 13 and 46) and `OpArgs`;
  - from Task 2: `SessionInfo.status`, `Tmux.sendKeyNames`;
  - existing: `synced()` (`ops/done-keys.ts`), `migrate()` (`@morndo/service-kit`), `Inventory`.
- **Produces:**

```ts
// db/migrations.ts: migration 3, the table `deliveries` (plan Contracts, Databases; its columns exactly).
// ops/inventory.ts
export type Lane = { workerId: string; pane: string; windowId: string; window: string; sessionId: string | null;
  status: SessionStatus | null; pid: number | null };                              // and Pane gains status, pid, topic?, lastPrompt? (Task 1)
export type InventoryDeps = { /* existing */ titles?: (sessionId: string) => Promise<Titles> };   // runtime.ts passes TranscriptTitles
// ops/transcript-titles.ts (ruling 13)
export type Titles = { topic: string | null; lastPrompt: string | null };
export class TranscriptTitles { constructor(transcriptPath: (sessionId: string) => string | null); read(sessionId: string): Promise<Titles> }
// ops/args.ts: CHECK covers every OpName; pane.keys takes exactly one of data and names (names from KEY_NAMES); a delivery's
// id ends in no `#<digits>`, its ttlMs is at most 7 days and its target exactly one of lane and workerId (ruling 7).
// deliveries/store.ts (plan Contracts, "Agent internals shared by Tasks 4 to 6"; additions: the node, detail())
export const FINAL: ReadonlySet<DeliveryState>;                                    // delivered, uncertain, given_up
export type DeliveryDetail = { target: DeliveryTarget; boundSession: string | null; retyped: boolean };
export type DeliveryChange = Partial<Pick<Delivery, "state" | "waiting" | "sessionId" | "typedAt" | "deliveredAt" | "why" | "note">> & { retyped?: boolean };
export class DeliveryStore {
  constructor(db: Database.Database, now: () => number, node: string);
  store(d: { id: string; target: DeliveryTarget; text: string; ttlMs: number; boundSession: string | null }): { delivery: Delivery; fresh: boolean } | { conflict: true };
  get(id: string): Delivery | null;
  head(lane: { lane: string } | { workerId: string }): Delivery | null;
  open(): Delivery[];
  recentFinal(sinceMs: number): Delivery[];        // sinceMs: a time on the node's clock; final ones changed at or after it
  update(id: string, change: DeliveryChange): Delivery;   // a final delivery is returned unchanged; an unknown id throws
  textOf(id: string): string | null;
  detail(id: string): DeliveryDetail | null;
  prune(): number;
}
// test/claude-session.ts (test helper)
export type TestSession = { sessionId: string; pid: number; transcript: string; status(s: SessionStatus | null): void;
  follow(stateDir: string): () => void; end(): void };
export function claudeSession(o: { tmux: TestTmux; claudeDir: string; pane: string; tmuxSession?: string; sessionId?: string }): TestSession;
```

- [ ] **Step 1: Create `apps/node-agent/test/claude-session.ts`**

A Claude Code session for a test pane, written in the shapes of README §1 and §5 with synthetic content (plan Global Constraints). Every tmux test of this lane uses it, so none of them depends on the shared fake box that Task 16 rewrites.

```ts
// A Claude Code session for a test pane, in the shapes Claude Code 2.1.293 writes (fleet clients README §1, §5; plan
// Global Constraints: synthetic texts in the recorded shapes):
// - the session file <claude>/sessions/<pid>.json naming the pane (its `tmux` field ends in the pane ID), with the
//   `status` the test sets, or none (a session file from before 2.1.293, or Claude Code still starting);
// - a transcript <claude>/projects/-test/<session>.jsonl, in which follow() turns each line the agent's fake box
//   (fake-claude.fixture.ts) submitted into a typed `user` prompt, the receipt the deliverer reads.
// The pid is the pane's own process (#{pane_pid}), alive for as long as the pane runs, as the session registry requires.
// The agent's tests use this rather than the shared fake box (test/fixtures/fake-claude-pane.ts), which Task 16 rewrites
// for the drills.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionStatus } from "@morndo/protocol";
import type { TestTmux } from "./helpers.ts";

export type TestSession = {
  sessionId: string;
  pid: number;
  transcript: string;
  status(s: SessionStatus | null): void;           // rewrite the session file with this status (null: the field absent)
  follow(stateDir: string): () => void;            // write a prompt for each submitted line; the result stops it
  end(): void;                                     // the session file gone
};

export function claudeSession(o: { tmux: TestTmux; claudeDir: string; pane: string; tmuxSession?: string; sessionId?: string }): TestSession {
  const sessionId = o.sessionId ?? randomUUID();
  const pid = Number(o.tmux.tmux("display-message", "-p", "-t", o.pane, "#{pane_pid}").trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no process in pane ${o.pane}`);
  const sessions = join(o.claudeDir, "sessions");
  const project = join(o.claudeDir, "projects", "-test");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(project, { recursive: true });
  const file = join(sessions, `${pid}.json`);
  const transcript = join(project, `${sessionId}.jsonl`);
  const write = (status: SessionStatus | null) => writeFileSync(file, JSON.stringify({
    pid, sessionId, tmux: `${o.tmuxSession ?? "main"}:@0.${o.pane}`, name: null, cwd: o.claudeDir, version: "2.1.293",
    updatedAt: Date.now(), ...(status === null ? {} : { status }),
  }));
  write(null);
  return {
    sessionId, pid, transcript,
    status: write,
    follow(stateDir) {
      let seen = 0;
      const timer = setInterval(() => {
        const f = join(stateDir, "submitted.jsonl");
        if (!existsSync(f)) return;
        const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
        for (const l of lines.slice(seen)) {
          appendFileSync(transcript, `${JSON.stringify({
            type: "user", uuid: randomUUID(), timestamp: new Date().toISOString(), promptSource: "typed",
            message: { role: "user", content: JSON.parse(l) as string },
          })}\n`);
        }
        seen = lines.length;
      }, 25);
      return () => clearInterval(timer);
    },
    end: () => rmSync(file, { force: true }),
  };
}
```

- [ ] **Step 2: Create `apps/node-agent/test/session-state.test.ts`**

The failing test for the agent on Task 1's protocol: session `status` and `pid` in the inventory (§5, "Session state"), and `pane.keys` by key name (§5, "Keys by name").

```ts
// The agent on Task 1's protocol (fleet clients spec §5): each pane's session `status` and `pid` in the inventory, from the
// session registry, its `topic` and `lastPrompt` from the transcript (RECONCILIATION.md ruling 13), and pane.keys by tmux
// key name from an allow-list. Real isolated tmux; the session file and the transcript are the test's (claude-session.ts),
// so the status is exactly what Claude Code would have written.
import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { claudeSession } from "./claude-session.ts";
import { isolatedTmux, tempHome, until, type TestTmux } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

const SHELL = "bash --norc --noprofile";
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let h: Harness;
beforeEach(() => { home = tempHome(); t = isolatedTmux(); h = opsHarness({ home: home.home, socket: t.socket }); });
afterEach(() => { h.close(); t.kill(); home.cleanup(); });

function lanes() {
  const shell = t.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "main", "-n", "shell", SHELL).trim();
  const claude = t.tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "=main:", "-n", "lane", "sleep 600").trim();
  return { shell, session: claudeSession({ tmux: t, claudeDir: join(home.home, ".claude"), pane: claude }) };
}

describe("each pane's session state in the inventory (spec §5)", () => {
  it("reports the session file's own status and the session's pid, and null for both without a session", async () => {
    const { session } = lanes();
    for (const status of ["busy", "idle", "waiting", "shell"] as const) {
      session.status(status);
      const snap = await h.inventory.refresh();
      expect(snap.panes.find(p => p.window === "lane"), status).toMatchObject({ sessionId: session.sessionId, status, pid: session.pid });
      expect(snap.lanes.find(l => l.window === "lane"), status).toMatchObject({ status, pid: session.pid });
      expect(snap.panes.find(p => p.window === "shell")).toMatchObject({ status: null, pid: null });
    }
    session.status(null);                                            // a session file without a status (before 2.1.293)
    expect((await h.inventory.refresh()).panes.find(p => p.window === "lane")).toMatchObject({ sessionId: session.sessionId, status: null });
  });

  it("grows invVersion when only a status changes, so the fleet hears of it within one poll", async () => {
    const { session } = lanes();
    session.status("idle");
    const v = (await h.inventory.refresh()).invVersion;
    expect((await h.inventory.refresh()).invVersion).toBe(v);
    session.status("busy");
    expect((await h.inventory.refresh()).invVersion).toBe(v + 1);
  });

  it("reports the session's topic and last prompt, its transcript's latest ai-title and last-prompt entries, each absent when unknown (rulings 13, 46)", async () => {
    const { session } = lanes();
    session.status("idle");
    const before = (await h.inventory.refresh()).panes.find(p => p.window === "lane");
    expect(before).toMatchObject({ sessionId: session.sessionId });
    expect(before).not.toHaveProperty("topic");                        // no transcript yet
    expect(before).not.toHaveProperty("lastPrompt");
    const put = (...entries: object[]) => appendFileSync(session.transcript, entries.map(e => `${JSON.stringify(e)}\n`).join(""));
    put({ type: "ai-title", aiTitle: "Build the login page" },
      { type: "user", promptSource: "typed", message: { role: "user", content: "a long prompt ".repeat(500) } },
      { type: "last-prompt", lastPrompt: "add the tests" });
    const lane = async () => (await h.inventory.refresh()).panes.find(p => p.window === "lane");
    expect(await lane()).toMatchObject({ topic: "Build the login page", lastPrompt: "add the tests" });
    put({ type: "ai-title", aiTitle: "Login page, with tests" });          // appended later: the latest wins
    expect(await lane()).toMatchObject({ topic: "Login page, with tests", lastPrompt: "add the tests" });
    put({ type: "last-prompt", lastPrompt: "x".repeat(300) });
    expect((await lane())?.lastPrompt).toBe("x".repeat(200));             // at most 200 characters, so 64 panes fit one message
    const shell = (await h.inventory.refresh()).panes.find(p => p.window === "shell");
    expect(shell).toBeDefined();
    expect(shell).not.toHaveProperty("topic");                         // no session
    expect(shell).not.toHaveProperty("lastPrompt");
  });
});

describe("pane.keys by key name (spec §5)", () => {
  it("types tmux key names from the allow-list into the pane", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "shell", "-x", "100", "-y", "20", SHELL);
    const snap = await h.inventory.refresh();
    const p = snap.panes[0];
    if (!p || !snap.stamp) throw new Error("no pane");
    const names = ["e", "c", "h", "o", "Space", "k", "e", "y", "s", "Space", "4", "2", "Enter"];
    expect(await h.call("pane.keys", { workerId: p.workerId, names, expect: { server: snap.stamp, window: "shell" } }))
      .toMatchObject({ ok: true, result: { ok: true } });
    expect(await until(() => t.tmux("capture-pane", "-p", "-t", "=main:0").includes("\nkeys 42"))).toBe(true);
  });

  it("refuses a name off the list, data and names together, and neither (bad_args, not executed)", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "shell", SHELL);
    const snap = await h.inventory.refresh();
    const p = snap.panes[0];
    if (!p || !snap.stamp) throw new Error("no pane");
    const exp = { server: snap.stamp, window: "shell" };
    for (const keys of [{ names: ["F1"] }, { names: ["enter"] }, { names: ["Enter"], data: "x" }, {}, { names: [] }]) {
      expect(await h.call("pane.keys", { workerId: p.workerId, ...keys, expect: exp }), JSON.stringify(keys))
        .toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    }
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run apps/node-agent/test/session-state.test.ts`

Expected: FAIL.
- Two inventory tests: the lanes (`snap.lanes`) have no `status` or `pid` (`busy: expected { workerId: …, … } to match object { status: 'busy', pid: … }`; the panes have them since Task 2 Step 13), and the panes have no `topic` or `lastPrompt`. The third, "grows invVersion when only a status changes", already passes: Task 2 Step 13 puts the session's status in the inventory first.
- "types tmux key names": pane.keys answers `{ ok: true, result: { ok: false } }`, because today's op types `data`, which is absent.
- The refusals test may already pass on Task 1's schema alone. It stays as the node's own check.

- [ ] **Step 4: Replace `apps/node-agent/src/ops/args.ts`**

```ts
// The arguments of every op, as this node acts on them (spec §5.3, §8; plan Contracts, "The agent parses as the fleet
// does"): first OP_ARGS[op], the schema the fleet checked them with (strict, with LIMITS; an unknown field is dropped,
// never passed on), then only what this node alone can judge. This is where a path is opened and text is typed, so the
// checks hold even against a fleet that is wrong or compromised. Each checker returns the typed arguments, or null for
// `bad_args`.
// Fleet clients (spec §4, §5; plan Contracts, protocol): pane.keys takes literal `data` or key `names` from KEY_NAMES,
// exactly one of them; pane.capture at most LIMITS.captureMaxLines lines; a delivery as RECONCILIATION.md ruling 7 has it:
// its id at most LIMITS.maxDeliveryId characters, no control character, no trailing `#<digits>`; its ttlMs at most 7 days;
// exactly one target.
import { KEY_NAMES, LIMITS, OP_ARGS, parseBody, type OpArgs, type OpName } from "@morndo/protocol";

// C0 control characters and DEL (a function, not a regular expression with control characters: the lint rule).
export function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}
// The hook relay's own copies are named by 32 hex digits (relay-files.ts): any other ref is none of this node's.
export const RELAY_REF = /^[0-9a-f]{32}$/;
// lane.start's account and resume id become arguments of the launcher's command (`{account}`, `--resume <id>`): checked
// once more here, as OP_ARGS has them, right before they reach a command line, so neither can ever pass as a flag.
export const ACCOUNT = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const RESUME_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validKey = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512 && !hasControl(v);

const KEYS: ReadonlySet<string> = new Set<string>(KEY_NAMES);
// pane.keys: literal text, or key names from the allow-list; never both, never neither, never an empty list.
const oneKind = (a: OpArgs["pane.keys"]): boolean =>
  a.names === undefined ? a.data !== undefined : a.data === undefined && a.names.length > 0 && a.names.every(n => KEYS.has(n));
// `#<digits>` at the end is the retype's key (`<id>#2`), never a delivery's id.
const deliveryId = (id: string): boolean => id.length > 0 && id.length <= LIMITS.maxDeliveryId && !hasControl(id) && !/#\d+$/.test(id);

type Checkers = { [O in OpName]: (a: unknown) => OpArgs[O] | null };
// OP_ARGS[op], then the node's own check of what came out.
const decoded = <O extends OpName>(op: O, node: (a: OpArgs[O]) => boolean = () => true) => (a: unknown): OpArgs[O] | null => {
  const v = parseBody(OP_ARGS[op], a) as OpArgs[O] | null;
  return v !== null && node(v) ? v : null;
};

export const CHECK: Checkers = {
  "inventory.get": decoded("inventory.get"),
  "pane.captureMany": decoded("pane.captureMany"),
  "pane.capture": decoded("pane.capture", a => Number.isInteger(a.lines) && a.lines >= 1 && a.lines <= LIMITS.captureMaxLines),
  "pane.frame": decoded("pane.frame"),
  "pane.keys": decoded("pane.keys", oneKind),
  "pane.send": decoded("pane.send"),
  "op.status": decoded("op.status", a => validKey(a.key)),
  "transcript.size": decoded("transcript.size"),
  "transcript.read": decoded("transcript.read"),
  "transcript.locate": decoded("transcript.locate"),
  "file.stat": decoded("file.stat", a => a.ref === undefined || RELAY_REF.test(a.ref)),
  "file.get": decoded("file.get", a => a.ref === undefined || RELAY_REF.test(a.ref)),
  "file.put": decoded("file.put", a => !hasControl(a.name)),
  "lane.start": decoded("lane.start", a => (a.account === undefined || ACCOUNT.test(a.account)) && (a.resume === undefined || RESUME_ID.test(a.resume))),
  "lane.stop": decoded("lane.stop"),
  "lane.deliver": decoded("lane.deliver", a => deliveryId(a.id) && ("lane" in a.target) !== ("workerId" in a.target)
    && (a.ttlMs === undefined || (Number.isSafeInteger(a.ttlMs) && a.ttlMs >= 1 && a.ttlMs <= LIMITS.deliveryKeepMs))),
  "delivery.cancel": decoded("delivery.cancel", a => deliveryId(a.id)),
  "worktree.list": decoded("worktree.list"),
  "worktree.add": decoded("worktree.add"),
};
```

- [ ] **Step 5: Replace `apps/node-agent/src/ops/inventory.ts`**

```ts
// What this node reports (spec §4, §5.4): the panes of the policy's tmux session that are alone in their window (a lane
// is one window with one pane), each under its worker ID `<node>.<server stamp>.<pane>`, with the Claude Code session
// running there. The stamp is read in the same tmux command as the panes, so a list never mixes two servers; a server
// without a stamp (new, or restarted) is stamped and read again. `invVersion` grows whenever what is reported changes,
// within this agent process. Refreshes run one at a time, so each sees every change made before it was asked for.
// Fleet clients (spec §5, "Session state"): each pane also carries its session's `status`, the session file's own value
// as Claude Code writes it (busy, idle, waiting, shell), and `pid`, the session's process; both null without a session
// (Task 2's session registry). A change of status alone changes what is reported, so the fleet hears of it within one
// poll; the deliverer and the lane state events read it from here too.
// RECONCILIATION.md ruling 13: each pane also carries its session's `topic` and `lastPrompt`, its transcript's latest
// ai-title and last-prompt entries (`titles`: transcript-titles.ts); each is absent when unknown (ruling 46).
import { formatWorkerId, type Pane, type SessionStatus } from "@morndo/protocol";
import type { SessionInfo } from "@morndo/node-ops";
import type { Titles } from "./transcript-titles.ts";
import { listPanes, type PaneRow } from "./tmux-panes.ts";

export type InventoryDeps = {
  node: string;
  session: string;
  socket: string | null;
  sessions: () => Map<string, SessionInfo>;
  stamp: (socket: string | null) => Promise<string | null>;
  titles?: (sessionId: string) => Promise<Titles>;        // topic and lastPrompt (ruling 13); without it, both null
};
export type Lane = { workerId: string; pane: string; windowId: string; window: string; sessionId: string | null; status: SessionStatus | null; pid: number | null };
export type Snapshot = { invVersion: number; stamp: string | null; panes: Pane[]; lanes: Lane[]; rows: PaneRow[] };

export class Inventory {
  #d: InventoryDeps;
  #snap: Snapshot = { invVersion: 0, stamp: null, panes: [], lanes: [], rows: [] };
  #reported = "[]";
  #chain: Promise<unknown> = Promise.resolve();
  #readAt = Number.NEGATIVE_INFINITY;                    // performance.now() when the snapshot was last read

  constructor(d: InventoryDeps) { this.#d = d; }

  get invVersion(): number { return this.#snap.invVersion; }
  last(): Snapshot { return this.#snap; }

  refresh(): Promise<Snapshot> {
    const next = this.#chain.then(() => this.#read());
    this.#chain = next.catch(() => undefined);
    return next;
  }

  // The snapshot, read again only when it is older than `maxAgeMs`: the agent reads it every inventoryPollMs anyway, so a
  // caller that asks often (the hub's capture of its panes every poll) needn't spawn tmux and scan the sessions each time.
  current(maxAgeMs: number): Promise<Snapshot> {
    return performance.now() - this.#readAt <= maxAgeMs ? Promise.resolve(this.#snap) : this.refresh();
  }

  windowOfPane(pane: string): string | null {
    return this.#snap.rows.find(r => r.pane === pane)?.window ?? null;
  }

  async #read(): Promise<Snapshot> {
    const d = this.#d;
    let rows = await listPanes(d.socket, d.session);
    if (rows.length && rows.some(r => !r.stamp)) {
      await d.stamp(d.socket);
      rows = await listPanes(d.socket, d.session);
    }
    const stamp = rows[0]?.stamp || null;
    const sessions = d.sessions();
    const lanes: Lane[] = [];
    const panes: Pane[] = [];
    for (const r of rows) {
      if (r.windowPanes !== 1 || !r.stamp) continue;
      const s = sessions.get(r.pane);
      const workerId = formatWorkerId({ node: d.node, server: r.stamp, pane: r.paneNum });
      const state = { status: s?.status ?? null, pid: s?.pid ?? null };
      const titles = s && d.titles ? await d.titles(s.sessionId) : { topic: null, lastPrompt: null };
      lanes.push({ workerId, pane: r.pane, windowId: r.windowId, window: r.window, sessionId: s?.sessionId ?? null, ...state });
      panes.push({
        workerId, window: r.window, cwd: r.cwd,
        ...(s ? { sessionId: s.sessionId } : {}),
        ...(s?.name ? { sessionName: s.name } : {}),
        ...(r.title !== null ? { title: r.title } : {}),
        ...(s?.version ? { claudeVersion: s.version } : {}),
        ...state,
        ...(titles.topic !== null ? { topic: titles.topic } : {}),
        ...(titles.lastPrompt !== null ? { lastPrompt: titles.lastPrompt } : {}),
      });
    }
    const reported = JSON.stringify(panes);
    const invVersion = reported === this.#reported ? this.#snap.invVersion : this.#snap.invVersion + 1;
    this.#reported = reported;
    this.#snap = { invVersion, stamp, panes, lanes, rows };
    this.#readAt = performance.now();
    return this.#snap;
  }
}
```

- [ ] **Step 6: Change `pane.keys` in `apps/node-agent/src/ops/pane-ops.ts`**

Replace, as Task 1 Step 8 left it:

```ts
    "pane.keys": effect(a => `pane:${paneOf(a.workerId)}`, (a, ctx) =>
      // Literal text; keys by name (`names`, fleet clients §5) type nothing until this node has them.
      guarded(a.workerId, a.expect, ctx, async pane => ok<"pane.keys">({ ok: a.data !== undefined && await d.terminal.keys(pane, a.data) }))),
```

with:

```ts
    // Literal text as typed (terminal.keys), or tmux key names from the allow-list (Task 2's sendKeyNames); args.ts let
    // exactly one of them through.
    "pane.keys": effect(a => `pane:${paneOf(a.workerId)}`, (a, ctx) =>
      guarded(a.workerId, a.expect, ctx, async pane => ok<"pane.keys">({
        ok: a.names !== undefined ? await d.tmux.sendKeyNames(pane, a.names) : await d.terminal.keys(pane, a.data ?? ""),
      }))),
```

- [ ] **Step 7: Create `apps/node-agent/test/transcript-titles.test.ts`**

The failing test for the topic and last prompt without tmux, including a `last-prompt` entry without `lastPrompt` (ruling 56).

```ts
// The topic and last prompt of a session (src/ops/transcript-titles.ts; RECONCILIATION.md rulings 13, 46 and 56): its
// transcript's latest ai-title and last-prompt entries, read from the tail and then from what was appended. Temporary
// transcripts with synthetic texts in Claude Code's shapes; no tmux.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptTitles } from "../src/ops/transcript-titles.ts";
import { tempHome } from "./helpers.ts";

let home: { home: string; cleanup: () => void };
let file = "";
beforeEach(() => { home = tempHome(); file = join(home.home, "s1.jsonl"); });
afterEach(() => home.cleanup());
const line = (o: object) => `${JSON.stringify(o)}\n`;
const titles = () => new TranscriptTitles(id => (id === "s1" ? file : null));

describe("a session's topic and last prompt (ruling 13)", () => {
  it("reads the latest ai-title and last-prompt, then only what was appended; a line still being written waits", async () => {
    const t = titles();
    expect(await t.read("s1")).toEqual({ topic: null, lastPrompt: null });              // no transcript yet
    writeFileSync(file, line({ type: "ai-title", aiTitle: "Build the login page" }) + line({ type: "last-prompt", lastPrompt: "add the tests" }));
    expect(await t.read("s1")).toEqual({ topic: "Build the login page", lastPrompt: "add the tests" });
    const next = JSON.stringify({ type: "ai-title", aiTitle: "Login page, with tests" });
    appendFileSync(file, next.slice(0, 12));
    expect((await t.read("s1")).topic).toBe("Build the login page");
    appendFileSync(file, `${next.slice(12)}\n`);
    expect((await t.read("s1")).topic).toBe("Login page, with tests");
    expect(await t.read("s2")).toEqual({ topic: null, lastPrompt: null });              // no transcript for that session
  });

  it("skips a last-prompt entry without lastPrompt, as 2 of 448 on the owner's PC were: no throw, never \"undefined\" (ruling 56)", async () => {
    writeFileSync(file, line({ type: "last-prompt" }) + line({ type: "last-prompt", lastPrompt: null }));
    const t = titles();
    expect(await t.read("s1")).toEqual({ topic: null, lastPrompt: null });
    appendFileSync(file, line({ type: "last-prompt", lastPrompt: "run the tests" }) + line({ type: "last-prompt", sessionId: "s1" }));
    expect(await t.read("s1")).toEqual({ topic: null, lastPrompt: "run the tests" });   // one without keeps the last known
    appendFileSync(file, line({ type: "ai-title" }) + "{\"type\":\"last-prompt\",\"lastPrompt\":\n");   // no aiTitle; a broken line
    expect(await t.read("s1")).toEqual({ topic: null, lastPrompt: "run the tests" });
  });

  it("cuts each to 200 characters, and reads only the last 4 MiB of a long transcript", async () => {
    writeFileSync(file, line({ type: "ai-title", aiTitle: "far back" })
      + line({ type: "assistant", message: { content: "z".repeat(1000) } }).repeat(5000) + line({ type: "last-prompt", lastPrompt: "p".repeat(300) }));
    expect(await titles().read("s1")).toEqual({ topic: null, lastPrompt: "p".repeat(200) });
  });
});
```

- [ ] **Step 8: Run it and watch it fail**

Run: `npx vitest run apps/node-agent/test/transcript-titles.test.ts`

Expected: FAIL: the file doesn't load, since `../src/ops/transcript-titles.ts` doesn't exist yet.

- [ ] **Step 9: Create `apps/node-agent/src/ops/transcript-titles.ts`**

```ts
// The topic and the last prompt of a Claude Code session (RECONCILIATION.md ruling 13; README §5): its transcript's latest
// `ai-title` entry (`aiTitle`, as the hub reads it, apps/hub/src/adapters/claude-sessions.ts) and latest `last-prompt`
// entry (`lastPrompt`; a last-prompt without one is skipped, ruling 56), which kira shows in its Overview and Mini App. Each is cut to 200 characters, so
// 64 panes still fit one inventory message.
// - A tail scan, cached per session: the first read of a session reads its transcript's last 4 MiB, and each later read
//   only what was appended since the last whole line it saw. An inventory read every 2 s costs a stat for a transcript
//   that didn't grow.
// - A transcript that got shorter (rewritten) is scanned again from its tail. One that grew by more than the tail is
//   scanned from its tail too, keeping what was known until a newer entry shows. One that can't be read keeps what was
//   known.
// - An ai-title further back than the tail isn't seen until Claude Code writes a new one (open question 4).
import { open, type FileHandle } from "node:fs/promises";

export type Titles = { topic: string | null; lastPrompt: string | null };
type Seen = Titles & { size: number };

const TAIL_BYTES = 4 << 20;
const TEXT_MAX = 200;
const NONE: Titles = { topic: null, lastPrompt: null };

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

// The latest of each entry in these whole lines. A line that names neither kind is never parsed.
function scan(text: string, into: Titles): void {
  for (const line of text.split("\n")) {
    if (!line.includes("\"ai-title\"") && !line.includes("\"last-prompt\"")) continue;
    let e: unknown;
    try { e = JSON.parse(line); } catch { continue; }
    if (e === null || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (o.type === "ai-title" && typeof o.aiTitle === "string") into.topic = o.aiTitle.slice(0, TEXT_MAX);
    if (o.type === "last-prompt" && typeof o.lastPrompt === "string") into.lastPrompt = o.lastPrompt.slice(0, TEXT_MAX);
  }
}

export class TranscriptTitles {
  #path: (sessionId: string) => string | null;
  #seen = new Map<string, Seen>();

  constructor(transcriptPath: (sessionId: string) => string | null) { this.#path = transcriptPath; }

  async read(sessionId: string): Promise<Titles> {
    const was = this.#seen.get(sessionId);
    const known = (): Titles => (was ? { topic: was.topic, lastPrompt: was.lastPrompt } : NONE);
    const path = this.#path(sessionId);
    if (path === null) return known();
    let fh: FileHandle;
    try { fh = await open(path, "r"); } catch { return known(); }
    try {
      const size = (await fh.stat()).size;
      if (was !== undefined && was.size === size) return known();
      const kept = was !== undefined && was.size < size ? was : null;        // it grew: what was known still holds
      const grew = kept !== null && size - kept.size <= TAIL_BYTES;
      const from = kept !== null && grew ? kept.size : Math.max(0, size - TAIL_BYTES);
      const buf = await readAt(fh, from, size - from);
      const end = buf.lastIndexOf(0x0a);
      const next: Seen = { ...(kept ?? NONE), size: from };
      if (end !== -1) {
        let text = buf.subarray(0, end).toString("utf8");
        if (!grew && from > 0) text = text.slice(text.indexOf("\n") + 1);   // the tail's first line is a part of one
        scan(text, next);
        next.size = from + end + 1;
      }
      this.#seen.set(sessionId, next);
      return { topic: next.topic, lastPrompt: next.lastPrompt };
    } catch {
      return known();
    } finally {
      await fh.close();
    }
  }
}
```

- [ ] **Step 10: Give the inventory its titles in `apps/node-agent/src/ops/runtime.ts`**

1. Replace:

```ts
import { buildOps, claudeDir } from "./table.ts";
```

with:

```ts
import { buildOps, claudeDir } from "./table.ts";
import { TranscriptTitles } from "./transcript-titles.ts";
```

2. Replace:

```ts
  const inventory = new Inventory({
    node: config.node, session: config.policy.session, socket: config.policy.tmuxSocket,
    sessions: () => registry.byPane(), stamp: stampServer,
  });
```

with:

```ts
  // topic and lastPrompt (RECONCILIATION.md ruling 13): each session's transcript, found through the same registry.
  const titles = new TranscriptTitles(sessionId => registry.transcriptPath(sessionId));
  const inventory = new Inventory({
    node: config.node, session: config.policy.session, socket: config.policy.tmuxSocket,
    sessions: () => registry.byPane(), stamp: stampServer, titles: sessionId => titles.read(sessionId),
  });
```

- [ ] **Step 11: Run it and watch it pass**

Run: `npx vitest run apps/node-agent/test/session-state.test.ts apps/node-agent/test/transcript-titles.test.ts`

Expected: PASS, `Test Files  2 passed (2)`, `Tests  8 passed (8)` (5 in `session-state`, 3 in `transcript-titles`).

Then run `npx tsc -p apps/node-agent`. Expected: no output, exit 0.

- [ ] **Step 12: Commit**

```bash
git add apps/node-agent/src/ops/args.ts apps/node-agent/src/ops/inventory.ts apps/node-agent/src/ops/pane-ops.ts apps/node-agent/src/ops/transcript-titles.ts apps/node-agent/src/ops/runtime.ts apps/node-agent/test/claude-session.ts apps/node-agent/test/session-state.test.ts apps/node-agent/test/transcript-titles.test.ts
git commit -m "feat(node-agent): session status, pid, topic and last prompt in the inventory, pane.keys by key name"
```

- [ ] **Step 13: Create `apps/node-agent/test/delivery-store.test.ts`**

The failing test for the store (spec §4.1–4.3).

```ts
// The delivery store (fleet clients spec §4.1–4.3; plan Contracts, "Agent internals shared by Tasks 4 to 6" and Databases:
// agent.db migration 3) on a real agent database:
// - storing is synced to the disk, and nothing after it is;
// - a deadline arrives as a duration and becomes notAfter on this node's clock (plan Review Focus 3);
// - the same id is the same delivery, or an id_conflict;
// - a target's open deliveries come in the order stored;
// - a final delivery is never changed, and final ones are pruned after 7 days.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS, type DeliveryTarget } from "@morndo/protocol";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { DeliveryStore } from "../src/deliveries/store.ts";
import { tempHome } from "./helpers.ts";

const T0 = Date.parse("2026-10-08T05:00:00.000Z");
const S1 = "1a2b3c4d-0000-4000-8000-000000000001";
const S2 = "1a2b3c4d-0000-4000-8000-000000000002";
const W = "pc.0a1b2c3d.4";
const MANAGER: DeliveryTarget = { lane: "manager", sticky: true };

const open: { adb: AgentDb; cleanup: () => void }[] = [];
afterEach(() => { for (const o of open.splice(0)) { o.adb.close(); o.cleanup(); } });
function storeOn(start = T0) {
  const h = tempHome();
  const adb = openAgentDb(join(h.home, "agent.db"));
  open.push({ adb, cleanup: h.cleanup });
  const clock = { now: start };
  return { store: new DeliveryStore(adb.db, () => clock.now, "pc"), adb, clock };
}
type Put = { target?: DeliveryTarget; text?: string; ttlMs?: number; boundSession?: string | null };
const put = (s: DeliveryStore, id: string, o: Put = {}) =>
  s.store({ id, target: o.target ?? MANAGER, text: o.text ?? `text of ${id}`, ttlMs: o.ttlMs ?? LIMITS.deliveryTtlMs, boundSession: o.boundSession ?? null });
// The answer of a fresh store; a conflict fails the test here.
const fresh = (r: ReturnType<typeof put>) => { if ("conflict" in r) throw new Error("an id conflict"); return r; };
const rows = (adb: AgentDb) => (adb.db.prepare("SELECT COUNT(*) AS n FROM deliveries").get() as { n: number }).n;
// What the store asks of the database: each change of the synchronous setting and each write, in order.
function watch(adb: AgentDb): string[] {
  const seen: string[] = [];
  const pragma = adb.db.pragma.bind(adb.db);
  adb.db.pragma = ((source: string, options?: { simple?: boolean }) => {
    if (/^synchronous\s*=/.test(source)) seen.push(source);
    return pragma(source, options as never);
  }) as typeof adb.db.pragma;
  const prepare = adb.db.prepare.bind(adb.db);
  adb.db.prepare = ((source: string) => {
    if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(source)) seen.push(source.trim().split(/\s+/).slice(0, 3).join(" "));
    return prepare(source);
  }) as typeof adb.db.prepare;
  return seen;
}

describe("storing", () => {
  it("stores a delivery queued, with notAfter on this node's clock: the time it was stored plus the duration sent (Review Focus 3)", () => {
    const { store } = storeOn();
    const r = fresh(put(store, "hub:a", { ttlMs: 90_000 }));
    expect(r).toEqual({ fresh: true, delivery: { id: "hub:a", node: "pc", target: { lane: "manager" }, state: "queued", queuedAt: T0, notAfter: T0 + 90_000 } });
    expect(store.get("hub:a")).toEqual(r.delivery);
    expect(store.textOf("hub:a")).toBe("text of hub:a");
    expect(store.detail("hub:a")).toEqual({ target: { lane: "manager", sticky: true }, boundSession: null, retyped: false });
    // A node whose clock runs 1.1 s behind the sender's (the owner's PC): the deadline is the node's own time plus the
    // duration, so the delivery has all of it.
    const behind = storeOn(T0 - 1100).store;
    expect(fresh(put(behind, "hub:b", { ttlMs: 90_000 })).delivery).toMatchObject({ queuedAt: T0 - 1100, notAfter: T0 - 1100 + 90_000 });
    expect(store.get("hub:none")).toBeNull();
    expect(store.textOf("hub:none")).toBeNull();
    expect(store.detail("hub:none")).toBeNull();
  });

  it("answers the same id with the same target and text with that delivery as it is now, and stores nothing again", () => {
    const { store, adb, clock } = storeOn();
    put(store, "hub:a", { text: "x" });
    store.update("hub:a", { state: "typed", typedAt: T0 + 5, sessionId: S1 });
    clock.now = T0 + 60_000;
    expect(put(store, "hub:a", { text: "x", ttlMs: 1 }))
      .toEqual({ fresh: false, delivery: expect.objectContaining({ state: "typed", queuedAt: T0, notAfter: T0 + LIMITS.deliveryTtlMs, sessionId: S1 }) });
    // Whether a name is sticky is the fleet's judgement when it routes, not the delivery's content.
    expect(put(store, "hub:a", { text: "x", target: { lane: "manager", sticky: false } })).toMatchObject({ fresh: false });
    expect(rows(adb)).toBe(1);
  });

  it("refuses the same id with another text or target as a conflict, and keeps the first as it was (negative control: an id conflict accepted)", () => {
    const { store } = storeOn();
    put(store, "hub:a", { text: "x" });
    const others: Put[] = [{ text: "y" }, { text: "x", target: { lane: "api", sticky: false } }, { text: "x", target: { workerId: W } }];
    for (const other of others) expect(put(store, "hub:a", other), JSON.stringify(other)).toEqual({ conflict: true });
    expect(store.textOf("hub:a")).toBe("x");
    expect(store.get("hub:a")?.target).toEqual({ lane: "manager" });
  });

  it("commits a new delivery synced to the disk (FULL for that transaction only), and a repeat or a later change without a sync", () => {
    const { store, adb } = storeOn();
    const seen = watch(adb);
    put(store, "hub:a");
    expect(seen.splice(0)).toEqual(["synchronous = FULL", "INSERT INTO deliveries", "synchronous = NORMAL"]);
    put(store, "hub:a");
    expect(seen.splice(0)).toEqual(["synchronous = FULL", "synchronous = NORMAL"]);
    store.update("hub:a", { waiting: { reason: "menu_open", since: T0 } });
    expect(seen.splice(0)).toEqual(["UPDATE deliveries SET"]);
    expect(adb.db.pragma("synchronous", { simple: true })).toBe(1);   // NORMAL again
  });

  it("stores nothing when the disk refuses, and throws: the sender is told, never a silent loss", () => {
    const { store, adb } = storeOn();
    adb.db.exec("CREATE TRIGGER no_room BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    expect(() => put(store, "hub:a")).toThrow(/disk full/);
    expect(store.get("hub:a")).toBeNull();
    expect(adb.db.pragma("synchronous", { simple: true })).toBe(1);
  });
});

describe("reading", () => {
  it("finds a target's head, the oldest open one, in the order stored even within one millisecond; open() and recentFinal() likewise", () => {
    const { store, clock } = storeOn();
    for (const id of ["hub:z", "hub:m", "hub:a"]) put(store, id);                       // one millisecond, ids out of order
    put(store, "hub:w", { target: { workerId: W } });
    put(store, "hub:b", { target: { lane: "api", sticky: false }, boundSession: S1 });
    expect(store.head({ lane: "manager" })?.id).toBe("hub:z");
    store.update("hub:z", { state: "typed", typedAt: T0, sessionId: S1 });
    expect(store.head({ lane: "manager" })?.id).toBe("hub:z");                         // typed is not final: still the head
    clock.now = T0 + 10;
    store.update("hub:z", { state: "delivered", deliveredAt: T0 + 10 });
    expect(store.head({ lane: "manager" })?.id).toBe("hub:m");
    expect(store.head({ workerId: W })?.id).toBe("hub:w");
    expect(store.head({ lane: "nowhere" })).toBeNull();
    expect(store.open().map(d => d.id)).toEqual(["hub:m", "hub:a", "hub:w", "hub:b"]);
    clock.now = T0 + 20;
    store.update("hub:b", { state: "given_up", why: "gone" });
    expect(store.recentFinal(T0 + 15).map(d => d.id)).toEqual(["hub:b"]);
    expect(store.recentFinal(T0).map(d => d.id)).toEqual(["hub:z", "hub:b"]);
  });
});

describe("changing", () => {
  it("keeps a reason while queued and drops it once typed; sessionId binds a queued name and records where a typed one went; the retype is kept", () => {
    const { store } = storeOn();
    put(store, "hub:a", { target: { lane: "api", sticky: false }, boundSession: S1 });
    expect(store.get("hub:a")).toMatchObject({ sessionId: S1 });
    expect(store.update("hub:a", { waiting: { reason: "menu_open", since: T0 + 1 } }).waiting).toEqual({ reason: "menu_open", since: T0 + 1 });
    const typed = store.update("hub:a", { state: "typed", typedAt: T0 + 2, sessionId: S2 });
    expect(typed).toMatchObject({ state: "typed", typedAt: T0 + 2, sessionId: S2 });
    expect(typed).not.toHaveProperty("waiting");
    expect(store.detail("hub:a")).toMatchObject({ boundSession: S1, retyped: false });
    store.update("hub:a", { retyped: true });
    expect(store.detail("hub:a")?.retyped).toBe(true);
    put(store, "hub:late", { target: { lane: "api", sticky: false } });                 // queued while its lane was starting
    store.update("hub:late", { sessionId: S1 });
    expect(store.detail("hub:late")?.boundSession).toBe(S1);
    expect(() => store.update("hub:none", { state: "typed" })).toThrow(/no delivery hub:none/);
  });

  it("never changes a final delivery", () => {
    const { store } = storeOn();
    put(store, "hub:a");
    const done = store.update("hub:a", { state: "delivered", deliveredAt: T0 + 3 });
    expect(store.update("hub:a", { state: "typed", note: "again" })).toEqual(done);
    expect(store.get("hub:a")).toEqual(done);
  });

  it("prunes final deliveries 7 days after their last change, never an open one", () => {
    const { store, clock } = storeOn();
    for (const id of ["hub:old", "hub:newer", "hub:open"]) put(store, id, { target: { lane: id, sticky: true } });
    store.update("hub:old", { state: "delivered", deliveredAt: T0 });
    clock.now = T0 + 3_600_000;
    store.update("hub:newer", { state: "given_up", why: "expired" });
    clock.now = T0 + LIMITS.deliveryKeepMs + 1;
    expect(store.prune()).toBe(1);
    expect(store.get("hub:old")).toBeNull();
    expect(store.get("hub:newer")?.state).toBe("given_up");
    expect(store.get("hub:open")?.state).toBe("queued");
  });
});
```

- [ ] **Step 14: Update `apps/node-agent/test/db.test.ts` for migration 3**

1. In "is created with WAL, synchronous=NORMAL, every migration and a streamId", replace:

```ts
    expect(tables).toEqual(["done_keys", "meta", "relay_files", "store_seq", "stream"]);
```

with:

```ts
    expect(tables).toEqual(["deliveries", "done_keys", "meta", "relay_files", "store_seq", "stream"]);
```

2. In "migrates a database made at version 1…", replace:

```ts
    expect(a.db.pragma("user_version", { simple: true })).toBe(2);
```

with:

```ts
    expect(a.db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
```

3. After that test (its last line is `a.close();`, then `  });`), insert:

```ts
  it("migrates a database made at version 2 to the deliveries table (fleet clients, migration 3), with its checks", () => {
    const path = dbPath();
    mkdirSync(dirname(path), { recursive: true });
    const raw = new Database(path);
    migrate(raw, MIGRATIONS.slice(0, 2));
    raw.prepare("INSERT INTO done_keys (key, hash, state, at) VALUES ('hub:a', 'h', 'started', 1)").run();
    raw.close();
    const a = openAgentDb(path);
    expect(a.db.pragma("user_version", { simple: true })).toBe(3);
    expect(a.db.prepare("SELECT key FROM done_keys").all()).toEqual([{ key: "hub:a" }]);
    const ins = (o: Record<string, unknown>) => a.db.prepare(`INSERT INTO deliveries (id, target_lane, target_worker, sticky, text, state, queued_at, not_after, updated_at)
      VALUES (@id, @lane, @worker, @sticky, 'x', @state, 1, 2, 1)`).run({ id: "hub:x", lane: "manager", worker: null, sticky: 1, state: "queued", ...o });
    expect(() => ins({ id: "hub:both", worker: "pc.0a1b2c3d.1" })).toThrow(/CHECK/);       // exactly one target
    expect(() => ins({ id: "hub:none", lane: null })).toThrow(/CHECK/);
    expect(() => ins({ id: "hub:state", state: "sent" })).toThrow(/CHECK/);
    expect(() => ins({ id: "hub:sticky", sticky: 2 })).toThrow(/CHECK/);
    ins({ id: "hub:ok" });
    expect(a.db.prepare("SELECT id, state, retyped, waiting_reason FROM deliveries").all()).toEqual([{ id: "hub:ok", state: "queued", retyped: 0, waiting_reason: null }]);
    a.close();
  });
```

- [ ] **Step 15: Run them and watch them fail**

Run: `npx vitest run apps/node-agent/test/delivery-store.test.ts apps/node-agent/test/db.test.ts`

Expected: FAIL.
- `delivery-store.test.ts`: `Error: Cannot find module '../src/deliveries/store.ts'`.
- `db.test.ts`, 2 failed:
  - the table list: `expected [ 'done_keys', 'meta', 'relay_files', 'store_seq', 'stream' ] to deeply equal [ 'deliveries', … ]`;
  - the new migration test: `expected 2 to be 3`.

- [ ] **Step 16: Add migration 3 to `apps/node-agent/src/db/migrations.ts`**

In `MIGRATIONS`, after the entry with `version: 2` (it ends `    },\n  },`), insert:

```ts
  {
    version: 3,
    name: "deliveries: the delivery queue (fleet clients spec §4; plan Contracts, Databases, agent.db migration 3)",
    // One row per delivery, the text included (the fleet's mirror never holds it, spec §4.6). Storing a row is synced to
    // the disk (deliveries/store.ts, fleet core §16.4); every later change is an ordinary commit. rowid is the order
    // stored, so the table keeps SQLite's rowid (not WITHOUT ROWID).
    up: db => {
      db.exec(`
        CREATE TABLE deliveries (
          id TEXT PRIMARY KEY,
          target_lane TEXT, target_worker TEXT, sticky INTEGER NOT NULL CHECK (sticky IN (0, 1)), bound_session TEXT,
          text TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('queued', 'typed', 'held', 'delivered', 'uncertain', 'given_up')),
          waiting_reason TEXT CHECK (waiting_reason IN ('menu_open', 'draft_present', 'no_input_box', 'busy', 'no_pane', 'no_session', 'earlier', 'unavailable')),
          waiting_since INTEGER, queued_at INTEGER NOT NULL, not_after INTEGER NOT NULL,
          typed_at INTEGER, typed_session TEXT, delivered_at INTEGER,
          why TEXT CHECK (why IN ('expired', 'cancelled', 'gone', 'refused')), note TEXT,
          retyped INTEGER NOT NULL DEFAULT 0 CHECK (retyped IN (0, 1)),
          updated_at INTEGER NOT NULL,
          CHECK ((target_lane IS NULL) <> (target_worker IS NULL)));
        CREATE INDEX deliveries_by_state ON deliveries (state, updated_at);
        CREATE INDEX deliveries_by_lane ON deliveries (target_lane) WHERE target_lane IS NOT NULL;
        CREATE INDEX deliveries_by_worker ON deliveries (target_worker) WHERE target_worker IS NOT NULL;
      `);
    },
  },
```

- [ ] **Step 17: Create `apps/node-agent/src/deliveries/store.ts`**

```ts
// The delivery queue's store (fleet clients spec §4.1–4.3; plan Contracts, "Agent internals shared by Tasks 4 to 6" and
// Databases, agent.db migration 3). One row per delivery in agent.db, with this agent as the only writer.
// - Storing a new delivery is its own transaction, synced to the disk (synced(), fleet core §16.4): an answer of `queued`
//   is a promise the sender may stop retrying on, so it must outlive a power loss. Every later change (a waiting reason,
//   typed, held, delivered, expired) is an ordinary NORMAL commit. One lost to a power loss is found again: a `started`
//   key (synced, ops/done-keys.ts) says a delivery may have been typed, and the transcript says whether it was taken.
// - A deadline arrives as a duration (ttlMs) and becomes notAfter on this node's clock when stored. A client's clock is
//   never compared with the node's (plan Review Focus 3: the owner's PC ran 1.1 s behind the control plane).
// - The same id with the same target and text is the same delivery: the answer is its state now, and nothing is stored
//   again (its notAfter stays). The same id with another target or text is a conflict (id_conflict). Whether a lane name
//   is sticky is the fleet's judgement when it routes, not the delivery's content.
// - The order stored is the rowid, which SQLite gives "one larger than the largest ROWID in the table prior to the
//   insert" (https://www.sqlite.org/autoinc.html, read 2026-10-08). So a new row sorts after every row still there, even
//   two stored in one millisecond, whatever pruning removed.
// - `sessionId` in a change binds a queued delivery to a session (a lane name queued while its lane was starting binds
//   the first session it shows) and, once typed, records the session it was typed into. The Delivery the fleet sees
//   shows the second, else the first.
// - A final delivery (delivered, uncertain, given_up) is never changed. Final ones are pruned 7 days after their last
//   change (LIMITS.deliveryKeepMs); open ones never are.
// - The text stays on this node: the Delivery the store answers with carries none (textOf reads it for the deliverer).
import type Database from "better-sqlite3";
import { LIMITS, type Delivery, type DeliveryState, type DeliveryTarget, type GiveUpReason, type WaitingReason } from "@morndo/protocol";
import { synced } from "../ops/done-keys.ts";

export const FINAL: ReadonlySet<DeliveryState> = new Set<DeliveryState>(["delivered", "uncertain", "given_up"]);
const OPEN = "('queued', 'typed', 'held')";

// What the deliverer needs beyond the Delivery the fleet sees: whether a lane name is sticky, the session a name is bound
// to, and whether its one retype after an interrupt was used (spec §4.1, §4.3).
export type DeliveryDetail = { target: DeliveryTarget; boundSession: string | null; retyped: boolean };
export type DeliveryChange = Partial<Pick<Delivery, "state" | "waiting" | "sessionId" | "typedAt" | "deliveredAt" | "why" | "note">> & { retyped?: boolean };

type Row = {
  id: string; target_lane: string | null; target_worker: string | null; sticky: number; bound_session: string | null; text: string;
  state: DeliveryState; waiting_reason: WaitingReason | null; waiting_since: number | null; queued_at: number; not_after: number;
  typed_at: number | null; typed_session: string | null; delivered_at: number | null; why: GiveUpReason | null; note: string | null;
  retyped: number; updated_at: number;
};

export class DeliveryStore {
  #db: Database.Database;
  #now: () => number;
  #node: string;

  constructor(db: Database.Database, now: () => number, node: string) {
    this.#db = db;
    this.#now = now;
    this.#node = node;
  }

  #row(id: string): Row | undefined {
    return this.#db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as Row | undefined;
  }

  #delivery(r: Row): Delivery {
    const sessionId = r.typed_session ?? r.bound_session;
    return {
      id: r.id, node: this.#node,
      target: r.target_lane !== null ? { lane: r.target_lane } : { workerId: r.target_worker ?? "" },
      state: r.state, queuedAt: r.queued_at, notAfter: r.not_after,
      ...(r.state === "queued" && r.waiting_reason !== null ? { waiting: { reason: r.waiting_reason, since: r.waiting_since ?? r.queued_at } } : {}),
      ...(sessionId !== null ? { sessionId } : {}),
      ...(r.typed_at !== null ? { typedAt: r.typed_at } : {}),
      ...(r.delivered_at !== null ? { deliveredAt: r.delivered_at } : {}),
      ...(r.why !== null ? { why: r.why } : {}),
      ...(r.note !== null ? { note: r.note } : {}),
    };
  }

  store(d: { id: string; target: DeliveryTarget; text: string; ttlMs: number; boundSession: string | null }): { delivery: Delivery; fresh: boolean } | { conflict: true } {
    const lane = "lane" in d.target ? d.target.lane : null;
    const worker = "workerId" in d.target ? d.target.workerId : null;
    const sticky = "lane" in d.target && d.target.sticky ? 1 : 0;
    const write = () => this.#db.transaction((): { delivery: Delivery; fresh: boolean } | { conflict: true } => {
      const old = this.#row(d.id);
      if (old) {
        const same = old.target_lane === lane && old.target_worker === worker && old.text === d.text;
        return same ? { delivery: this.#delivery(old), fresh: false } : { conflict: true };
      }
      const at = this.#now();
      this.#db.prepare(`INSERT INTO deliveries (id, target_lane, target_worker, sticky, bound_session, text, state, queued_at, not_after, retyped, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0, ?)`).run(d.id, lane, worker, sticky, d.boundSession, d.text, at, at + d.ttlMs, at);
      return { delivery: this.#delivery(this.#row(d.id) as Row), fresh: true };
    }).immediate();
    return synced(this.#db, write);
  }

  get(id: string): Delivery | null {
    const r = this.#row(id);
    return r ? this.#delivery(r) : null;
  }

  textOf(id: string): string | null {
    return this.#row(id)?.text ?? null;
  }

  detail(id: string): DeliveryDetail | null {
    const r = this.#row(id);
    if (!r) return null;
    return {
      target: r.target_lane !== null ? { lane: r.target_lane, sticky: r.sticky === 1 } : { workerId: r.target_worker ?? "" },
      boundSession: r.bound_session,
      retyped: r.retyped === 1,
    };
  }

  // The oldest delivery of that target that isn't final (spec §4.3, "One at a time per lane").
  head(t: { lane: string } | { workerId: string }): Delivery | null {
    const lane = "lane" in t ? t.lane : null;
    const worker = "workerId" in t ? t.workerId : null;
    const r = this.#db.prepare(`SELECT * FROM deliveries WHERE (target_lane = ? OR target_worker = ?) AND state IN ${OPEN} ORDER BY rowid LIMIT 1`)
      .get(lane, worker) as Row | undefined;
    return r ? this.#delivery(r) : null;
  }

  open(): Delivery[] {
    return (this.#db.prepare(`SELECT * FROM deliveries WHERE state IN ${OPEN} ORDER BY rowid`).all() as Row[]).map(r => this.#delivery(r));
  }

  // Final deliveries whose last change is at or after `sinceMs`, a time on this node's clock (spec §4.4: the last hour's).
  recentFinal(sinceMs: number): Delivery[] {
    return (this.#db.prepare(`SELECT * FROM deliveries WHERE state NOT IN ${OPEN} AND updated_at >= ? ORDER BY rowid`).all(sinceMs) as Row[])
      .map(r => this.#delivery(r));
  }

  update(id: string, change: DeliveryChange): Delivery {
    const r = this.#row(id);
    if (!r) throw new Error(`no delivery ${id}`);
    if (FINAL.has(r.state)) return this.#delivery(r);
    const state = change.state ?? r.state;
    const queued = state === "queued";
    const next: Row = {
      ...r,
      state,
      waiting_reason: !queued ? null : change.waiting !== undefined ? change.waiting.reason : r.waiting_reason,
      waiting_since: !queued ? null : change.waiting !== undefined ? change.waiting.since : r.waiting_since,
      bound_session: queued && change.sessionId !== undefined ? change.sessionId : r.bound_session,
      typed_session: !queued && change.sessionId !== undefined ? change.sessionId : r.typed_session,
      typed_at: change.typedAt ?? r.typed_at,
      delivered_at: change.deliveredAt ?? r.delivered_at,
      why: change.why ?? r.why,
      note: change.note ?? r.note,
      retyped: change.retyped === undefined ? r.retyped : change.retyped ? 1 : 0,
      updated_at: this.#now(),
    };
    this.#db.prepare(`UPDATE deliveries SET state = ?, waiting_reason = ?, waiting_since = ?, bound_session = ?, typed_session = ?, typed_at = ?,
      delivered_at = ?, why = ?, note = ?, retyped = ?, updated_at = ? WHERE id = ?`)
      .run(next.state, next.waiting_reason, next.waiting_since, next.bound_session, next.typed_session, next.typed_at, next.delivered_at, next.why,
        next.note, next.retyped, next.updated_at, id);
    return this.#delivery(next);
  }

  prune(): number {
    return this.#db.prepare(`DELETE FROM deliveries WHERE state NOT IN ${OPEN} AND updated_at < ?`).run(this.#now() - LIMITS.deliveryKeepMs).changes;
  }
}
```

- [ ] **Step 18: Run them and watch them pass**

Run: `npx vitest run apps/node-agent/test/delivery-store.test.ts apps/node-agent/test/db.test.ts`

Expected: PASS, `Test Files  2 passed (2)`, `Tests  22 passed (22)` (9 in the store's file, 13 in the database's).

- [ ] **Step 19: Check the whole task**

Run each command on its own (a chain would stop at the first failure and hide the rest):
- `npx vitest run apps/node-agent/test`. Expected: no failed test. There are 3 more files than before this task (`session-state`, `transcript-titles`, `delivery-store`) and 18 more tests.
- `npx tsc -p apps/node-agent`. Expected: no output, exit 0.
- `npx tsc -p tsconfig.tests.json`. Expected: no output, exit 0.
- `npx oxlint --format=stylish apps/node-agent`. Expected: no output.

- [ ] **Step 20: Commit**

```bash
git add apps/node-agent/src/db/migrations.ts apps/node-agent/src/deliveries/store.ts apps/node-agent/test/delivery-store.test.ts apps/node-agent/test/db.test.ts
git commit -m "feat(node-agent): the delivery store in agent.db (migration 3), synced when stored"
```

- [ ] **Step 21: Add this task's negative controls to `scripts/negative-controls.ts`**

Each entry removes one guard of this task and names the tests that must then fail. In `scripts/negative-controls.ts`, before the closing `];` of `CONTROLS`, add:

```ts
  // ---- fleet clients, Tasks 4-6: the agent (docs/design/fleet-clients/plan/02-agent.md). Ids "fc<task>-…": the fleet
  // core's agent tasks were 6-9, so "t6-…" is taken.
  { id: "fc4-status-not-reported", task: "fc4", file: "apps/node-agent/src/ops/inventory.ts",
    find: "const state = { status: s?.status ?? null, pid: s?.pid ?? null };",
    replace: "const state = { status: null, pid: null };",
    run: ["apps/node-agent/test/session-state.test.ts"], expect: "status" },
  { id: "fc4-title-uncapped", task: "fc4", file: "apps/node-agent/src/ops/transcript-titles.ts",
    find: "const TEXT_MAX = 200;", replace: "const TEXT_MAX = 1_000_000;",
    run: ["apps/node-agent/test/transcript-titles.test.ts"], expect: "cuts each to 200 characters" },
  { id: "fc4-last-prompt-unchecked", task: "fc4", file: "apps/node-agent/src/ops/transcript-titles.ts",
    find: "    if (o.type === \"last-prompt\" && typeof o.lastPrompt === \"string\") into.lastPrompt = o.lastPrompt.slice(0, TEXT_MAX);",
    replace: "    if (o.type === \"last-prompt\") into.lastPrompt = String(o.lastPrompt).slice(0, TEXT_MAX);",
    run: ["apps/node-agent/test/transcript-titles.test.ts"], expect: "without lastPrompt" },
  { id: "fc4-store-unsynced", task: "fc4", file: "apps/node-agent/src/deliveries/store.ts",
    find: "return synced(this.#db, write);", replace: "return write();",
    run: ["apps/node-agent/test/delivery-store.test.ts"], expect: "synchronous = FULL" },
  { id: "fc4-ttl-not-node-clock", task: "fc4", file: "apps/node-agent/src/deliveries/store.ts",
    find: "at + d.ttlMs", replace: "Date.now() + d.ttlMs",
    run: ["apps/node-agent/test/delivery-store.test.ts"], expect: "notAfter" },
  { id: "fc4-id-conflict-accepted", task: "fc4", file: "apps/node-agent/src/deliveries/store.ts",
    find: "old.text === d.text", replace: "true",
    run: ["apps/node-agent/test/delivery-store.test.ts"], expect: "conflict" },
  { id: "fc4-final-changed", task: "fc4", file: "apps/node-agent/src/deliveries/store.ts",
    find: "    if (FINAL.has(r.state)) return this.#delivery(r);\n", replace: "",
    run: ["apps/node-agent/test/delivery-store.test.ts"], expect: "delivered" },
  { id: "fc4-prune-open", task: "fc4", file: "apps/node-agent/src/deliveries/store.ts",
    find: "DELETE FROM deliveries WHERE state NOT IN ${OPEN} AND updated_at < ?", replace: "DELETE FROM deliveries WHERE updated_at < ?",
    run: ["apps/node-agent/test/delivery-store.test.ts"], expect: "expected 2 to be 1" },
  { id: "fc4-order-by-id", task: "fc4", file: "apps/node-agent/src/deliveries/store.ts",
    find: "ORDER BY rowid LIMIT 1", replace: "ORDER BY id LIMIT 1",
    run: ["apps/node-agent/test/delivery-store.test.ts"], expect: "hub:z" },
```

Not caught by design: the node's own `pane.keys` check in `args.ts` (`oneKind`) repeats what Task 1's `OP_ARGS` already refuses. Removing it changes nothing a test can see, as with the fleet core's account and resume checks. It stays as the last check before tmux.

Run: `node scripts/negative-controls.ts --check`. Expected: no `ENTRY` or stale line, exit 0.

- [ ] **Step 22: Commit**

```bash
git add scripts/negative-controls.ts
git commit -m "test(node-agent): negative controls for the delivery store and session state"
```

- [ ] **Step 23: Run this task's negative controls**

The runner tests HEAD, so this comes after Step 22's commit (ruling 50).

Run: `node scripts/negative-controls.ts --only fc4-status-not-reported --only fc4-title-uncapped --only fc4-last-prompt-unchecked --only fc4-store-unsynced --only fc4-ttl-not-node-clock --only fc4-id-conflict-accepted --only fc4-final-changed --only fc4-prune-open --only fc4-order-by-id`

Expected: nine lines `bit      fc4-…`, then `9/9 controls bit; still pass 0, broke 0, timed out 0, skipped 0`, exit 0.

### Task 5: Agent: the deliverer (trying, confirming, expiring, the retype)

**Files:**
- Create: `apps/node-agent/src/deliveries/deliverer.ts`, `apps/node-agent/src/deliveries/views.ts`
- Modify:
  - `apps/node-agent/src/test-hooks.ts` (four hooks for the drills);
  - `apps/node-agent/src/ops/executor.ts` (`afterEffect`);
  - `apps/node-agent/src/ops/runtime.ts` (the store, the deliverer, the hooks);
  - `apps/node-agent/src/ops/tmux-panes.ts` (each pane's own process, `pane_pid`, for the start grace: ruling 14);
  - `apps/node-agent/src/events.ts` (`onInventory`);
  - `apps/node-agent/src/agent.ts` (`ev.delivery`, replay after a welcome, kicks, start and stop, housekeeping);
  - `scripts/negative-controls.ts`.
- Test:
  - created: `apps/node-agent/test/deliverer.test.ts`, `apps/node-agent/test/delivery-hooks.test.ts`, `apps/node-agent/test/deliverer-tmux.test.ts`, `apps/node-agent/test/agent-deliveries.test.ts`;
  - modified: `apps/node-agent/test/ops-harness.ts`, `apps/node-agent/test/fake-claude.fixture.ts`.

**Interfaces:**
- **Consumes:**
  - Task 1:
    - `LIMITS.deliveryTryMs`, `deliveryStartGraceMs`, `deliveryTtlMs`, `deliveryReceiptHoldMs` (ruling 42);
    - `ERROR_EXECUTED` with `id_conflict`, `no_session` and `already_typed`;
    - `EvDelivery` in `AgentMessage`;
    - the types `Delivery`, `DeliveryTarget`, `WaitingReason`, `SessionStatus`, `OpArgs["lane.deliver"]`, `OpResult["lane.deliver" | "delivery.cancel" | "pane.send" | "pane.keys"]` and `Expect`.
  - Task 2: `readReceipts`, `PendingText`, `startsNewSession` (ruling 54), `draftOnScreen` (existing), `localTranscriptBytes` (existing), `Tmux.capture(pane, { lines, attributes })`.
  - Task 4: `DeliveryStore`, `FINAL`, `DeliveryDetail`, `DeliveryChange`, and `Lane.status`.
- **Produces:**

```ts
// deliveries/deliverer.ts (plan Contracts, "Agent internals shared by Tasks 4 to 6"; additions: the views, hooks, drain())
export type Executor = Pick<OpExecutor, "handle">;
export type PaneState = { workerId: string; pane: string; window: string; sessionId: string | null; status: SessionStatus | null; startedAt: number | null };
export type PaneView = { snapshot(): PaneState[]; refresh(): Promise<PaneState[]>; draft(pane: string): Promise<string | null> };
export type TranscriptView = { size(sessionId: string): Promise<number | null>;
  lines(sessionId: string, from: number): Promise<{ lines: string[]; next: number } | null> };
export type KickReason = "status" | "hook" | "inventory" | "timer";
export type DelivererDeps = { store: DeliveryStore; executor: Executor; panes: PaneView; transcripts: TranscriptView; now: () => number;
  emit: (d: Delivery) => void; log: Logger; hooks?: Pick<TestHooks, "noSessionBinding" | "retypeUnderFirstKey" | "deliveryStartGraceMs"> };
export class Deliverer {
  constructor(d: DelivererDeps);
  enqueue(args: OpArgs["lane.deliver"]): OpResult["lane.deliver"] | OpError;
  cancel(id: string): OpResult["delivery.cancel"] | OpError;   // busy while its try runs
  kick(reason: KickReason): void;
  start(): void; stop(): void;
  drain(): Promise<void>;                                       // resolves once no round runs or waits to run
}
export function ownLine(draft: string, text: string): boolean;  // the box shows exactly that line (Enter again, the retype)
// deliveries/views.ts (ruling 14: the start grace from the pane process's own start time)
export function startFromProcStat(stat: string, btimeSec: number, ticksPerSec: number): number | null;
export class ProcessStarts { at(pid: number): number | null; keepOnly(pids: ReadonlySet<number>): void }
export function agentPaneView(d: { inventory: Inventory; tmux: Pick<Tmux, "capture">; starts?: ProcessStarts }): PaneView;
export function agentTranscripts(transcriptPath: (sessionId: string) => string | null): TranscriptView;
// test-hooks.ts
export type TestHooks = { /* existing */ killAfterEffect?: string; noSessionBinding?: true; retypeUnderFirstKey?: true; deliveryStartGraceMs?: number };
export function killOnce(match: string, kill?: () => void): (key: string) => void;
// ops/executor.ts: ExecutorDeps gains afterEffect?: (key: string) => void   (after a keyed op acted, before its `done`)
// ops/runtime.ts
export type OpsRuntime = { /* existing */ tmux: Tmux; deliveries: DeliveryStore; deliverer: Deliverer; panes: PaneView };
// ops/tmux-panes.ts: PaneRow gains panePid: number | null (#{pane_pid}).
export type RuntimeOptions = { /* existing */ emitDelivery?: (d: Delivery) => void };
// events.ts: EventLoopOptions gains onInventory?: (s: Snapshot) => void | Promise<void>
// agent.ts: ev.delivery { v: 1, t: "ev.delivery", delivery } on every change; after every welcome the open deliveries and
// the final ones changed in the last hour.
```

- [ ] **Step 1: Create `apps/node-agent/test/deliverer.test.ts`**

The failing test for the deliverer, rule for rule (§4.3), against scripted parts on a real store.

```ts
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
import { Deliverer, ownLine, type DelivererDeps, type PaneState } from "../src/deliveries/deliverer.ts";
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

function rig(o: { panes?: PaneState[]; hooks?: DelivererDeps["hooks"] } = {}) {
  const home = tempHome();
  const adb = openAgentDb(join(home.home, "agent.db"));
  const clock = { now: T0 };
  const store = new DeliveryStore(adb.db, () => clock.now, "pc");
  const calls: Request[] = [];
  const emitted: Delivery[] = [];
  const panes: PaneState[] = o.panes ?? [pane("manager", W1, "%1", S1)];
  const drafts = new Map<string, string>();
  const transcripts = new Map<string, string>();
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
      lines: async (s, from) => {
        const t = transcripts.get(s);
        if (t === undefined) return null;
        const rest = Buffer.from(t).subarray(from);
        const end = rest.lastIndexOf(0x0a);
        return end === -1 ? { lines: [], next: from } : { lines: rest.subarray(0, end).toString("utf8").split("\n").filter(l => l.length > 0), next: from + end + 1 };
      },
    },
    ...(o.hooks ? { hooks: o.hooks } : {}),
  });
  cleanups.push(async () => { deliverer.stop(); await deliverer.drain(); adb.close(); home.cleanup(); });
  return {
    deliverer, store, clock, calls, emitted, panes, drafts, fail, db: adb.db, typed,
    answer: (f: Answer) => { answer = f; },
    say: (session: string, ...entries: object[]) => {
      transcripts.set(session, (transcripts.get(session) ?? "") + entries.map(e => `${JSON.stringify(e)}\n`).join(""));
    },
    round: async () => { deliverer.kick("timer"); await deliverer.drain(); },
    sends: () => calls.filter(c => c.op === "pane.send"),
    keys: () => calls.filter(c => c.op === "pane.keys"),
  };
}
type Rig = ReturnType<typeof rig>;
const state = (r: Rig, id: string) => r.store.get(id)?.state;

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
    for (const [i, id] of ids.entries()) r.deliverer.enqueue({ id, target: MANAGER, text: texts[i] as string });
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
    r.deliverer.enqueue({ id: "hub:first", target: MANAGER, text: "first" });
    r.deliverer.enqueue({ id: "hub:second", target: MANAGER, text: "second" });
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
    r.deliverer.enqueue({ id: "hub:w", target: MANAGER, text: "x" });
    await r.deliverer.drain();
    expect(r.store.get("hub:w")).toMatchObject({ state: "queued", waiting: { reason: "menu_open", since: T0 } });
    const said = r.emitted.length;
    r.clock.now = T0 + 5000;
    await r.round();
    expect(r.store.get("hub:w")?.waiting).toEqual({ reason: "menu_open", since: T0 });
    expect(r.emitted).toHaveLength(said);                              // a round that changed nothing says nothing
    const steps = [["draft_present", "draft_present"], ["timeout", "unavailable"], ["no_input_box", "no_input_box"], ["busy", "busy"], ["no_pane", "no_pane"]] as const;
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
    expect(r.sends()).toHaveLength(8);
  });

  it("gives a definite refusal up (refused), with what the pane said", async () => {
    const r = rig();
    r.answer(refuse("too_large"));
    r.deliverer.enqueue({ id: "hub:big", target: MANAGER, text: "x" });
    await r.deliverer.drain();
    expect(r.store.get("hub:big")).toMatchObject({ state: "given_up", why: "refused", note: "too_large: refused: too_large" });
  });

  it("types a text starting with / once, and confirms it by the command entry Claude Code writes for it (Review Focus 1)", async () => {
    const r = rig();
    r.deliverer.enqueue({ id: "lanes:compact-1", target: MANAGER, text: "/compact" });
    await r.deliverer.drain();
    expect(state(r, "lanes:compact-1")).toBe("typed");
    r.say(S1, L.command("/compact", T0 + 200));
    await r.round();
    expect(r.store.get("lanes:compact-1")).toMatchObject({ state: "delivered", deliveredAt: T0 + 200 });
    expect(r.sends()).toHaveLength(1);
  });

  it("confirms a command that starts a new session (/clear) by its pane's session changing after the typing (ruling 17)", async () => {
    const r = rig();
    r.deliverer.enqueue({ id: "lanes:clear-1", target: MANAGER, text: "/clear" });
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
    r.deliverer.enqueue({ id: "hub:e", target: MANAGER, text: "ship it" });
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
    theirs.deliverer.enqueue({ id: "hub:e", target: MANAGER, text: "ship it" });
    await theirs.deliverer.drain();
    expect(theirs.keys()).toEqual([]);
    const clear = rig();
    clear.answer(q => clear.typed("not_submitted")(q));
    clear.deliverer.enqueue({ id: "hub:e", target: MANAGER, text: "ship it" });
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
    expect(ownLine("someone else's words", "ship it")).toBe(false);
    expect(ownLine("", "ship it")).toBe(false);
  });
});

describe("a typing from before a restart (spec §4.3, §10)", () => {
  it("moves it to typed when its key was started already (the agent restarted while typing), and never types it again", async () => {
    const r = rig();
    r.answer(refuse("uncertain"));                                     // the executor's answer for a key already started
    r.deliverer.enqueue({ id: "hub:s", target: MANAGER, text: "ship it" });
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
    r.deliverer.enqueue({ id: "hub:o", target: MANAGER, text: "ship it" });
    await r.deliverer.drain();
    expect(r.store.get("hub:o")).toMatchObject({ state: "typed", typedAt: T0 - 5000 });
    expect(r.keys()).toEqual([]);
  });
});

describe("receipts (spec §4.3, Confirming)", () => {
  it("holds it while Claude Code queues it; a dequeue (no text) decides nothing; the prompt after it delivers it", async () => {
    const r = rig();
    r.deliverer.enqueue({ id: "hub:h", target: MANAGER, text: "ship it" });
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
    r.deliverer.enqueue({ id: "hub:r", target: MANAGER, text: "ship it" });
    await r.deliverer.drain();
    r.say(S1, ...entries("ship it", T0 + 100));
    await r.round();
    await r.round();
    expect(state(r, "hub:r")).toBe(after);
    expect(r.sends()).toHaveLength(1);
  });

  it("types a line Claude Code dropped (cleared_on_cancel) once more, under <id>#2, when the box is clear and the session idle; dropped again, it is uncertain: never a third typing", async () => {
    const r = rig();
    r.deliverer.enqueue({ id: "hub:d", target: MANAGER, text: "ship it" });
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
    r.deliverer.enqueue({ id: "hub:d", target: MANAGER, text: "ship it" });
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
      r.deliverer.enqueue({ id, target: { lane, sticky: false }, text: `for ${lane}`, ttlMs: 60_000 });
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
    r.deliverer.enqueue({ id: "hub:q", target: MANAGER, text: "later" });
    r.deliverer.enqueue({ id: "hub:t", target: { lane: "api", sticky: false }, text: "now" });
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
    r.deliverer.enqueue({ id: "hub:c", target: MANAGER, text: "x" });
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
    r.deliverer.enqueue({ id: "hub:b", target: { lane: "api", sticky: false }, text: "for this api" });
    await r.deliverer.drain();
    expect(r.store.get("hub:b")).toMatchObject({ state: "queued", sessionId: S1 });
    expect(r.sends()[0]?.args).toMatchObject({ expect: { sessionId: S1 } });   // the pane is asked for the session too
    Object.assign(r.panes[0] as PaneState, { workerId: W2, pane: "%2", sessionId: S2 });   // stopped; a new lane took the name
    r.answer(r.typed());
    await r.round();
    expect(r.store.get("hub:b")).toMatchObject({ state: "given_up", why: "gone" });
    expect(r.sends()).toHaveLength(1);
  });

  it("binds a name queued while its lane was starting to the first session the lane shows", async () => {
    const r = rig({ panes: [pane("api", W1, "%1", null, null, T0 - 1000)] });
    r.deliverer.enqueue({ id: "hub:l", target: { lane: "api", sticky: false }, text: "first words" });
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
    r.deliverer.enqueue({ id: "hub:p", target: { workerId: W1 }, text: "x" });
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
    r.deliverer.enqueue({ id: "hub:a", target: MANAGER, text: "x" });
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
    r.deliverer.enqueue({ id: "hub:u", target: MANAGER, text: "x" });
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
      r.deliverer.enqueue({ id: "hub:t", target: MANAGER, text: "x" });
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
    r.deliverer.enqueue({ id: "hub:u", target: { lane: "api", sticky: false }, text: "for the first api" });
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
    r.deliverer.enqueue({ id: "hub:k", target: MANAGER, text: "ship it" });
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run apps/node-agent/test/deliverer.test.ts`

Expected: FAIL, `Error: Cannot find module '../src/deliveries/deliverer.ts'`.

- [ ] **Step 3: Create `apps/node-agent/src/deliveries/deliverer.ts`**

```ts
// The delivery queue's deliverer (fleet clients spec §4.3, rule for rule; plan Contracts, "Agent internals shared by Tasks
// 4 to 6"): a port of the manager inbox's deliverer onto the agent's own parts.
// - A new delivery is answered `queued`, without `waiting`; a reason is set only while it is queued and a round has found
//   its lane not ready (RECONCILIATION.md ruling 43).
// - Typing is one at a time per target and in the order stored (ruling 16). A queued delivery waits
//   `earlier` behind one still queued before it, and behind one typed or held that waits for its receipt, for at most 60 s
//   from that typing; then it types. So three senders to one lane never type into each other's text (plan Review Focus
//   2), and a delivery whose receipt never comes holds its lane for a minute, not until its notAfter. Receipts match the
//   earliest delivery waiting for one.
// - A lane takes deliveries while it has a live Claude Code session, whatever the session's status (ruling 11: `shell`
//   is Claude Code running a shell command). no_session is no live session: no session file, or its process gone.
// - A round runs at once for a new delivery, on each kick (a session's status, a hook, the inventory) and at least every
//   5 s once started (LIMITS.deliveryTryMs). Rounds never overlap: a kick during one runs another after it.
// - A try is a pane.send through the agent's own executor under the delivery's id as its done key, with every check of
//   pane.send (the pane lock, the menu and draft checks, the expectation; for a lane name bound to its session, that
//   session too).
//   - A refusal that typed nothing leaves the delivery queued, with its reason; a tmux that did not answer, or panes that
//     couldn't be read, make it `unavailable` (ruling 15).
//   - An answer that may have acted makes it `typed`, never typed again: `uncertain` (the key was started already: the
//     agent restarted while typing) or internal "maybe".
//   - A key already `done` answers its stored outcome, with the time it was typed then.
//   - Any other refusal is final: `given_up` (`refused`).
// - A line left in the box after Enter (`not_submitted`) gets Enter again (pane.keys) only while the box shows that very
//   line, at most twice, and only for a typing of this process.
// - Confirming reads the transcript of the session the text was typed into, from where it ended just before the typing
//   (after a restart, up to 8 MiB back), with Task 2's readReceipts: delivered, held, or dropped (cleared_on_cancel).
//   - A dropped line is typed once more, under `<id>#2` with its own synced `started`, only when its line isn't in the
//     box and that session is idle. Otherwise it is `uncertain`, and so is a second drop.
//   - The retype's own key makes a third typing impossible even if the flag that records it was lost.
//   - A command that starts a new session (Task 2's startsNewSession: /clear, /reset, /new; ruling 54) is recorded only
//     in the new session's transcript: its receipt is its pane's session changing to another id after the typing
//     (ruling 17).
// - Past notAfter: queued is given up (`expired`); typed or held is `uncertain`, never typed again.
// - Every change is emitted (agent.ts sends it as ev.delivery); a round that changes nothing emits nothing.
// - Test hooks for the drills (test-hooks.ts): noSessionBinding holds a lane name like a sticky one (no binding);
//   retypeUnderFirstKey retypes under the delivery's own key; deliveryStartGraceMs shortens the 2-minute grace.
import { setTimeout as sleep } from "node:timers/promises";
import { ERROR_EXECUTED, LIMITS, parseWorkerId, type Delivery, type ErrorCode, type Expect, type OpArgs, type OpError, type OpResult,
  type SessionStatus, type WaitingReason } from "@morndo/protocol";
import { readReceipts, startsNewSession, type PendingText } from "@morndo/node-ops";
import type { Logger } from "../log.ts";
import type { OpExecutor } from "../ops/executor.ts";
import type { TestHooks } from "../test-hooks.ts";
import { FINAL, type DeliveryChange, type DeliveryDetail, type DeliveryStore } from "./store.ts";

// The agent's executor as the deliverer uses it: one side effect at a time per pane, with the policy, the done keys and
// every check of the op (ops/executor.ts).
export type Executor = Pick<OpExecutor, "handle">;
// One lane as the deliverer sees it: the inventory's pane, the Claude Code session in it and that session's status (Task
// 2's session registry), and when its pane's own process started (ruling 14), for the 2-minute grace of spec §4.1.
export type PaneState = { workerId: string; pane: string; window: string; sessionId: string | null; status: SessionStatus | null; startedAt: number | null };
export type PaneView = {
  snapshot(): PaneState[];                                  // as the inventory last read them (enqueue answers at once)
  refresh(): Promise<PaneState[]>;                          // read again when older than the inventory's poll interval
  draft(pane: string): Promise<string | null>;              // the input box's own text (not its dim suggestion), else null
};
export type TranscriptView = {
  size(sessionId: string): Promise<number | null>;          // null: no transcript of that session on this node (yet)
  lines(sessionId: string, from: number): Promise<{ lines: string[]; next: number } | null>;   // whole lines from a byte offset
};
export type KickReason = "status" | "hook" | "inventory" | "timer";
export type DelivererDeps = {
  store: DeliveryStore; executor: Executor; panes: PaneView; transcripts: TranscriptView; now: () => number;
  emit: (d: Delivery) => void; log: Logger;
  hooks?: Pick<TestHooks, "noSessionBinding" | "retypeUnderFirstKey" | "deliveryStartGraceMs">;
};

const WAIT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["menu_open", "draft_present", "no_input_box", "busy", "no_pane"]);
const TRY_TIMEOUT_MS = 20_000;                              // the pane lock may wait up to 20 s (ops/pane-ops.ts)
const KEYS_TIMEOUT_MS = 5000;
const ENTER_PAUSE_MS = 600;                                 // tmux send waits 400 ms for a submit; then this before each look
const ENTER_MAX = 2;
const LOOKBACK_BYTES = 8 << 20;                             // after a restart, how far back a transcript is read for a receipt
const NO_SESSION = "the pane has no live Claude Code session; type into it directly with pane.send or pane.keys";
const CONFLICT = "that delivery id was used with another target or text";

const err = (code: ErrorCode, message: string): OpError => ({ code, executed: ERROR_EXECUTED[code], message });
// A live session (the registry lists a session only while its process is alive), whatever its status (ruling 11).
const takes = (p: PaneState): boolean => p.sessionId !== null;
const targetKey = (t: Delivery["target"]): string => ("lane" in t ? `lane:${t.lane}` : `worker:${t.workerId}`);

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const PASTED = /^\[Pasted text #\d+ \+\d+ lines\]$/;
// The box shows this delivery's own line: exactly its text; or, for a text longer than the box shows on its first line,
// a start of it at least 20 characters long; or Claude Code's placeholder for a pasted text of several lines.
export function ownLine(draft: string, text: string): boolean {
  const d = flat(draft);
  const t = flat(text);
  if (d === "") return false;
  if (PASTED.test(d)) return text.includes("\n");
  return t.startsWith(d) && d.length >= Math.min(t.length, 20);
}


type Where = { pane: PaneState } | { wait: WaitingReason } | { gone: true };
type At = { workerId: string; pane: string; session: string };

export class Deliverer {
  #d: DelivererDeps;
  #grace: number;
  #unbound: boolean;
  #cursors = new Map<string, number>();                    // session → the transcript's byte offset read up to
  #trying = new Set<string>();                             // deliveries whose pane.send is in flight
  #current: Promise<void> | null = null;
  #again = false;
  #stopped = false;
  #timer: NodeJS.Timeout | null = null;
  #n = 0;

  constructor(d: DelivererDeps) {
    this.#d = d;
    this.#grace = d.hooks?.deliveryStartGraceMs ?? LIMITS.deliveryStartGraceMs;
    this.#unbound = d.hooks?.noSessionBinding === true;
  }

  // Validates, binds and stores a delivery (spec §4.1, §4.3 "Storing"); the answer comes once it is stored, synced.
  enqueue(a: OpArgs["lane.deliver"]): OpResult["lane.deliver"] | OpError {
    const store = this.#d.store;
    const known = store.get(a.id);
    if (known) return this.#sameContent(a) ? { delivery: known } : err("id_conflict", CONFLICT);
    const panes = this.#d.panes.snapshot();
    const now = this.#d.now();
    const refuse = (p: PaneState) => !takes(p) && !(p.startedAt !== null && now - p.startedAt < this.#grace);
    const target = a.target;
    let bound: string | null = null;
    if ("workerId" in target) {
      const p = panes.find(x => x.workerId === target.workerId);
      if (!p) return err("no_pane", "no such pane on this node");
      if (refuse(p)) return err("no_session", NO_SESSION);
    } else {
      const named = panes.filter(x => x.window === target.lane);
      if (named.length > 1) return err("lane_conflict", "two windows on this node have that name");
      const p = named[0];
      if (!target.sticky) {
        if (!p) return err("no_pane", "no lane of that name on this node");
        if (refuse(p)) return err("no_session", NO_SESSION);
        bound = takes(p) && !this.#unbound ? p.sessionId : null;   // a lane still starting binds the first session it shows
      }
    }
    let stored: ReturnType<DeliveryStore["store"]>;
    try {
      stored = store.store({ id: a.id, target, text: a.text, ttlMs: a.ttlMs ?? LIMITS.deliveryTtlMs, boundSession: bound });
    } catch (e) {
      this.#d.log.error("a delivery could not be stored; nothing was queued", e);
      return { code: "internal", executed: "no", message: "the delivery could not be stored (a full disk?); nothing was queued" };
    }
    if ("conflict" in stored) return err("id_conflict", CONFLICT);
    if (stored.fresh) {
      this.#d.emit(stored.delivery);
      this.#schedule();
    }
    return { delivery: stored.delivery };
  }

  // Gives up a queued delivery (spec §4.3, "Cancelling"). One being typed right now is `busy`: ask again.
  cancel(id: string): OpResult["delivery.cancel"] | OpError {
    const d = this.#d.store.get(id);
    if (!d) return err("bad_args", "no delivery with that id on this node");
    if (this.#trying.has(id)) return err("busy", "the delivery is being typed right now; ask again in a moment");
    if (d.state === "given_up") return { delivery: d };
    if (d.state !== "queued") return err("already_typed", "the delivery was typed already and can't be cancelled");
    return { delivery: this.#change(d, { state: "given_up", why: "cancelled" }) };
  }

  kick(_reason: KickReason): void { this.#schedule(); }

  start(): void {
    this.#stopped = false;
    this.#timer ??= setInterval(() => this.kick("timer"), LIMITS.deliveryTryMs);
    this.#schedule();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  async drain(): Promise<void> {
    while (this.#current) await this.#current;
  }

  #schedule(): void {
    if (this.#stopped) return;
    if (this.#current) { this.#again = true; return; }
    this.#current = this.#rounds().finally(() => { this.#current = null; });
  }

  async #rounds(): Promise<void> {
    do {
      this.#again = false;
      try { await this.#round(); }
      catch (e) { this.#d.log.warn("a delivery round failed; the next one tries again", e); }
    } while (this.#again && !this.#stopped);
  }

  async #round(): Promise<void> {
    const store = this.#d.store;
    if (store.open().length === 0) { this.#cursors.clear(); return; }
    let panes: PaneState[];
    try { panes = await this.#d.panes.refresh(); }
    catch (e) {
      this.#d.log.warn("the node's panes could not be read; deliveries wait (unavailable) and are tried again", e);
      for (const d of store.open()) this.#wait(d, "unavailable");
      return;
    }
    await this.#confirm(panes);
    this.#expire();
    // Typing one at a time per target, in the order stored (ruling 16): per target the first queued delivery is tried,
    // unless one typed or held before it still waits for its receipt within LIMITS.deliveryReceiptHoldMs (60 s, ruling 42)
    // of its typing. Every other queued one waits `earlier`.
    const now = this.#d.now();
    const next = new Map<string, Delivery>();
    const held = new Set<string>();
    for (const d of store.open()) {
      const key = targetKey(d.target);
      if (d.state !== "queued") {
        if (now - (d.typedAt ?? d.queuedAt) < LIMITS.deliveryReceiptHoldMs) held.add(key);
        continue;
      }
      if (held.has(key) || next.has(key)) { this.#wait(d, "earlier"); continue; }
      next.set(key, d);
    }
    await Promise.all([...next.values()].map(d => this.#try(d, panes)));
  }

  // Receipts from each session something was typed into, read on from where the last round stopped.
  async #confirm(panes: PaneState[]): Promise<void> {
    const store = this.#d.store;
    // A command that starts a new session: its receipt is its pane showing another session than the one it was typed into.
    for (const d of store.open()) {
      if ((d.state !== "typed" && d.state !== "held") || d.sessionId === undefined) continue;
      const t = store.detail(d.id);
      const text = store.textOf(d.id);
      if (!t || text === null || !startsNewSession(text)) continue;
      const p = this.#paneOf(t, panes);
      if (p !== null && p.sessionId !== null && p.sessionId !== d.sessionId) this.#change(d, { state: "delivered", deliveredAt: this.#d.now() });
    }
    const waiting = new Map<string, Delivery[]>();
    for (const d of store.open()) {
      if ((d.state === "typed" || d.state === "held") && d.sessionId !== undefined) waiting.set(d.sessionId, [...(waiting.get(d.sessionId) ?? []), d]);
    }
    for (const session of [...this.#cursors.keys()]) if (!waiting.has(session)) this.#cursors.delete(session);
    for (const [session, ds] of waiting) {
      let from = this.#cursors.get(session);
      if (from === undefined) {
        const size = await this.#d.transcripts.size(session);
        if (size === null) continue;
        from = Math.max(0, size - LOOKBACK_BYTES);
      }
      const got = await this.#d.transcripts.lines(session, from);
      if (got === null) continue;
      this.#cursors.set(session, got.next);
      const pending: PendingText[] = ds.flatMap(d => {
        const text = store.textOf(d.id);
        return text === null ? [] : [{ id: d.id, text, typedAt: d.typedAt ?? d.queuedAt }];
      });
      for (const r of readReceipts(got.lines, pending)) await this.#receipt(r.id, r.verdict, r.at, panes);
    }
  }

  async #receipt(id: string, verdict: "delivered" | "held" | "dropped", at: number, panes: PaneState[]): Promise<void> {
    const d = this.#d.store.get(id);
    if (!d || FINAL.has(d.state)) return;
    if (verdict === "delivered") { this.#change(d, { state: "delivered", deliveredAt: at }); return; }
    if (verdict === "held") { if (d.state === "typed") this.#change(d, { state: "held" }); return; }
    await this.#dropped(d, panes);
  }

  // Claude Code dropped the line from its queue (an interrupt): the inbox's one retype (spec §4.3).
  async #dropped(d: Delivery, panes: PaneState[]): Promise<void> {
    const store = this.#d.store;
    const t = store.detail(d.id);
    const text = store.textOf(d.id);
    if (!t || text === null) return;
    if (t.retyped) { this.#change(d, { state: "uncertain", note: "dropped by an interrupt again, after its one retype" }); return; }
    const where = this.#resolve(t, panes);
    const p = "pane" in where ? where.pane : null;
    const ref = p === null ? null : parseWorkerId(p.workerId);
    if (p === null || ref === null || p.sessionId === null || p.sessionId !== d.sessionId || p.status !== "idle") {
      this.#change(d, { state: "uncertain", note: "dropped by an interrupt while its session was not idle; not typed again" });
      return;
    }
    const draft = await this.#d.panes.draft(p.pane);
    if (draft !== null && ownLine(draft, text)) {
      this.#change(d, { state: "uncertain", note: "dropped by an interrupt and back in the input box; not typed again" });
      return;
    }
    const bindable = "lane" in t.target && !t.target.sticky && !this.#unbound;
    const expect: Expect = { server: ref.server, window: p.window, ...(bindable && t.boundSession !== null ? { sessionId: t.boundSession } : {}) };
    const key = this.#d.hooks?.retypeUnderFirstKey === true ? d.id : `${d.id}#2`;
    await this.#type(d, text, { workerId: p.workerId, pane: p.pane, session: p.sessionId }, expect, key, true);
  }

  #expire(): void {
    const now = this.#d.now();
    for (const d of this.#d.store.open()) {
      if (now <= d.notAfter) continue;
      if (d.state === "queued") { this.#change(d, { state: "given_up", why: "expired" }); continue; }
      this.#change(d, { state: "uncertain", note: `${d.state === "held" ? "held by Claude Code" : "typed"}, never seen taken before notAfter` });
    }
  }

  // The one pane a delivery's target names now, whichever session runs there.
  #paneOf(t: DeliveryDetail, panes: PaneState[]): PaneState | null {
    const target = t.target;
    if ("workerId" in target) return panes.find(x => x.workerId === target.workerId) ?? null;
    const named = panes.filter(x => x.window === target.lane);
    return named.length === 1 ? (named[0] as PaneState) : null;
  }

  // Where a delivery would be typed now, or why it waits, or that it is gone (spec §4.1).
  #resolve(t: DeliveryDetail, panes: PaneState[]): Where {
    const target = t.target;
    if ("workerId" in target) {
      const p = panes.find(x => x.workerId === target.workerId);
      if (!p) return { gone: true };
      return takes(p) ? { pane: p } : { wait: "no_session" };
    }
    const named = panes.filter(x => x.window === target.lane);
    if (named.length > 1) return { wait: "no_pane" };               // two windows claim the name: neither is typed into
    const p = named[0];
    const bound = !target.sticky && !this.#unbound;
    if (!p) return bound ? { gone: true } : { wait: "no_pane" };
    if (bound && t.boundSession !== null && p.sessionId !== null && p.sessionId !== t.boundSession) return { gone: true };
    return takes(p) ? { pane: p } : { wait: "no_session" };
  }

  async #try(d: Delivery, panes: PaneState[]): Promise<void> {
    const store = this.#d.store;
    const t = store.detail(d.id);
    const text = store.textOf(d.id);
    if (!t || text === null) return;
    const where = this.#resolve(t, panes);
    if ("gone" in where) {
      const note = "lane" in t.target ? "the lane's window closed or another session took its name: never typed into another conversation" : "the pane is gone";
      this.#change(d, { state: "given_up", why: "gone", note });
      return;
    }
    if ("wait" in where) { this.#wait(d, where.wait); return; }
    const p = where.pane;
    const ref = parseWorkerId(p.workerId);
    if (p.sessionId === null || ref === null) return;
    const bindable = "lane" in t.target && !t.target.sticky && !this.#unbound;
    if (bindable && t.boundSession === null) this.#change(d, { sessionId: p.sessionId });   // queued while its lane was starting
    const bound = bindable ? (t.boundSession ?? p.sessionId) : null;
    const expect: Expect = { server: ref.server, window: p.window, ...(bound !== null ? { sessionId: bound } : {}) };
    await this.#type(d, text, { workerId: p.workerId, pane: p.pane, session: p.sessionId }, expect, d.id, false);
  }

  async #type(d: Delivery, text: string, at: At, expect: Expect, key: string, retype: boolean): Promise<void> {
    const tryAt = this.#d.now();
    const attempt = async () => ({
      before: await this.#d.transcripts.size(at.session),
      reply: await this.#d.executor.handle({
        id: `deliver-${++this.#n}`, op: "pane.send", args: { workerId: at.workerId, text, expect }, timeoutMs: TRY_TIMEOUT_MS, key,
      }),
    });
    this.#trying.add(d.id);
    const { before, reply } = await attempt().finally(() => this.#trying.delete(d.id));
    const retyped = retype ? { retyped: true } : {};
    if (reply.ok) {
      const r = reply.result as OpResult["pane.send"];
      if (!this.#cursors.has(at.session)) this.#cursors.set(at.session, before ?? 0);
      this.#change(d, { state: "typed", typedAt: r.typedAt, sessionId: at.session, ...retyped });
      if (r.problem === "not_submitted" && r.typedAt >= tryAt) await this.#enterAgain(at, expect, text);
      return;
    }
    const e = reply.error;
    if (e.executed === "maybe") {
      // A key started already (the agent restarted while typing) or a typing that failed part way: it may have been
      // typed, so it never is again. Its receipt may be from before this try, so it is read from the queuing on.
      this.#change(d, { state: "typed", typedAt: retype ? tryAt : d.queuedAt, sessionId: at.session,
        note: "typing may have begun before an agent restart or a failure; never typed again", ...retyped });
      return;
    }
    if (retype) { this.#change(d, { state: "uncertain", note: `dropped by an interrupt; its one retype was refused (${e.code}), not typed again` }); return; }
    if (WAIT_CODES.has(e.code)) { this.#wait(d, e.code as WaitingReason); return; }
    if (e.code === "timeout" || e.code === "internal") {
      this.#d.log.warn(`a delivery was not tried (${e.code}); it waits (unavailable) and is tried again`);
      this.#wait(d, "unavailable");
      return;
    }
    this.#change(d, { state: "given_up", why: "refused", note: `${e.code}: ${e.message}`.slice(0, 200) });
  }

  // Enter again on its own stuck line (spec §4.3): only while the box shows it, at most ENTER_MAX times.
  async #enterAgain(at: At, expect: Expect, text: string): Promise<void> {
    for (let i = 0; i < ENTER_MAX; i++) {
      await sleep(ENTER_PAUSE_MS);
      const draft = await this.#d.panes.draft(at.pane);
      if (draft === null || !ownLine(draft, text)) return;
      const r = await this.#d.executor.handle({
        id: `deliver-${++this.#n}`, op: "pane.keys", args: { workerId: at.workerId, names: ["Enter"], expect }, timeoutMs: KEYS_TIMEOUT_MS,
      });
      if (!r.ok || !(r.result as OpResult["pane.keys"]).ok) {
        this.#d.log.info(`Enter could not be pressed again on a delivery's line (${r.ok ? "tmux refused the key" : r.error.code}); it stays typed`);
        return;
      }
    }
  }

  #wait(d: Delivery, reason: WaitingReason): void {
    if (d.state !== "queued" || d.waiting?.reason === reason) return;
    this.#change(d, { waiting: { reason, since: this.#d.now() } });
  }

  #change(d: Delivery, change: DeliveryChange): Delivery {
    const next = this.#d.store.update(d.id, change);
    this.#d.emit(next);
    return next;
  }

  #sameContent(a: OpArgs["lane.deliver"]): boolean {
    const t = this.#d.store.detail(a.id);
    if (!t || this.#d.store.textOf(a.id) !== a.text) return false;
    const was = t.target;
    const now = a.target;
    return "lane" in now ? "lane" in was && was.lane === now.lane : "workerId" in was && was.workerId === now.workerId;
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run apps/node-agent/test/deliverer.test.ts`

Expected: PASS, `Tests  35 passed (35)`. The first Enter test takes about 1.2 s (two pauses of 600 ms).

- [ ] **Step 5: Commit**

This commit passes vitest but not `tsc` yet: `deliverer.ts` names the test hook `noSessionBinding`, which Step 8's `test-hooks.ts` adds (the replay found TS2344 and TS2322 here). It compiles again at Step 11's commit.

```bash
git add apps/node-agent/src/deliveries/deliverer.ts apps/node-agent/test/deliverer.test.ts
git commit -m "feat(node-agent): the deliverer: one at a time per lane, receipts, Enter again, the one retype, expiry"
```

- [ ] **Step 6: Create `apps/node-agent/test/delivery-hooks.test.ts`**

The failing test for the drills' hooks outside the deliverer: the loader, `killOnce`, and the executor's `afterEffect`.

```ts
// The test hooks fleet clients adds for Task 16's drills (RECONCILIATION.md ruling 20): the loader takes
// them under its usual guard, killOnce matches keys as dropOnce does, and the executor's afterEffect runs right after a
// keyed op acted, before its `done` is written (where killAfterEffect kills the agent). The kill itself is the drills'.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ALL_OPS } from "../src/config.ts";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { DoneKeys } from "../src/ops/done-keys.ts";
import { OpExecutor, effect, fail, ok } from "../src/ops/executor.ts";
import { TestHooksRefused, killOnce, loadTestHooks } from "../src/test-hooks.ts";
import { captureLog, tempHome } from "./helpers.ts";

const homes: { cleanup: () => void }[] = [];
const dbs: AgentDb[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); for (const h of homes.splice(0)) h.cleanup(); });
const env = (hooks: unknown): NodeJS.ProcessEnv => ({ NODE_ENV: "test", MORNDO_NODE_TEST_HOOKS: JSON.stringify(hooks) });

describe("the drills' test hooks", () => {
  it("loads killAfterEffect, noSessionBinding, retypeUnderFirstKey and deliveryStartGraceMs, and refuses a value of the wrong type", () => {
    const h = tempHome();
    homes.push(h);
    const where = { home: h.home, accountHome: "/nonexistent-account-home" };
    const all = { killAfterEffect: "lanes:drill-killed", noSessionBinding: true, retypeUnderFirstKey: true, deliveryStartGraceMs: 3000 };
    expect(loadTestHooks(env(all), where)).toEqual(all);
    for (const bad of [{ killAfterEffect: "" }, { noSessionBinding: false }, { retypeUnderFirstKey: 1 }, { deliveryStartGraceMs: -1 }, { deliveryStartGraceMs: 1.5 }]) {
      expect(() => loadTestHooks(env(bad), where), JSON.stringify(bad)).toThrow(TestHooksRefused);
    }
  });

  it("killOnce kills the first time a key that contains its text has acted", () => {
    const kills: string[] = [];
    const k = killOnce("drill-killed", () => { kills.push("kill"); });
    k("lanes:other");
    expect(kills).toEqual([]);
    k("lanes:drill-killed-1a2b");
    k("lanes:drill-killed-1a2b");
    expect(kills).toEqual(["kill"]);
  });

  it("runs the executor's afterEffect right after a keyed op acted, before its done is written; never for a refusal or an unkeyed op", async () => {
    const h = tempHome();
    homes.push(h);
    const adb = openAgentDb(join(h.home, "agent.db"));
    dbs.push(adb);
    const keys = new DoneKeys(adb.db);
    const seen: string[] = [];
    const x = new OpExecutor({
      ops: {
        "pane.send": effect(() => "q", async a => (a.text === "refuse me" ? fail("menu_open", "a menu") : ok<"pane.send">({ problem: null, typedAt: 1 }))),
        "pane.keys": effect(() => "q", async () => ok<"pane.keys">({ ok: true })),
      },
      allowed: new Set(ALL_OPS), doneKeys: keys, invVersion: () => 0, log: captureLog().log,
      afterEffect: key => { seen.push(`${key} ${keys.status(key).state}`); },
    });
    const W = "pc.0a1b2c3d.1";
    const EXPECT = { server: "0a1b2c3d", window: "w" };
    expect(await x.handle({ id: "1", op: "pane.send", args: { workerId: W, text: "typed", expect: EXPECT }, timeoutMs: 5000, key: "hub:a" })).toMatchObject({ ok: true });
    expect(await x.handle({ id: "2", op: "pane.send", args: { workerId: W, text: "refuse me", expect: EXPECT }, timeoutMs: 5000, key: "hub:b" })).toMatchObject({ ok: false });
    expect(await x.handle({ id: "3", op: "pane.keys", args: { workerId: W, data: "x", expect: EXPECT }, timeoutMs: 5000 })).toMatchObject({ ok: true });
    expect(seen).toEqual(["hub:a started"]);
    expect(keys.status("hub:a")).toMatchObject({ state: "done" });
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

Run: `npx vitest run apps/node-agent/test/delivery-hooks.test.ts`

Expected: FAIL.
- The file fails to load, since `killOnce` isn't exported yet. If the runner loads it anyway:
  - the loader refuses the new hooks (`TestHooksRefused: MORNDO_NODE_TEST_HOOKS: unknown hook "killAfterEffect"`);
  - `killOnce is not a function`;
  - `seen` stays empty (`expected [] to deeply equal [ 'hub:a started' ]`).

- [ ] **Step 8: Replace `apps/node-agent/src/test-hooks.ts`**

```ts
// Hooks for the agent's tests and the QA drill only (plan Contracts, "Agent test hooks"). Each one bends one thing the
// agent does, to show what the real behaviour prevents (a negative control) or to reach a state that is hard to time
// (the connection lost right after a `started` key is committed). They come from MORNDO_NODE_TEST_HOOKS (JSON) and are
// refused unless NODE_ENV is "test" AND the agent's HOME is not the account's own home directory:
// - there is no build step (Node runs the TypeScript as stripped types), so no build flag can remove them, and an
//   environment variable alone can leak into a unit file;
// - every test and the QA drill run the agent with a throwaway HOME, and the installed agent runs with the account's
//   real home, so a production agent refuses to start with hooks rather than run with them;
// - the account's home is os.userInfo().homedir, which the operating system gives from the password database, where
//   os.homedir() would read $HOME (https://nodejs.org/docs/latest-v24.x/api/os.html#osuserinfooptions, read 2026-10-06).
// Bad JSON, an unknown hook or a value of the wrong type is refused too: a typo must not silently turn a hook off.
// Fleet clients adds four for the delivery drills (Task 16; RECONCILIATION.md ruling 20):
// killAfterEffect, noSessionBinding, retypeUnderFirstKey and deliveryStartGraceMs.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export type TestHooks = {
  dropAfterStarted?: string;  // a keyed op whose key contains this: right after `started` is committed (with noDoneKeys: at that
                              // point), the fleet socket is terminated and that op's result discarded; the op runs on. Once per key.
  noDoneKeys?: true;          // negative control: keys are neither recorded nor consulted; op.status answers "unknown"
  noExpect?: true;            // negative control: a worker ID resolves by its pane number alone; `expect` is not checked
  clockOffsetMs?: number;     // added to every wall-clock time the agent reports (typedAt, health.wallClock, HookEvent.at)
  spoolFail?: true;           // every spool write fails, as on a full disk
  fixedStreamId?: string;     // negative control: this stream id (a UUID) instead of the database's own
  killAfterEffect?: string;   // a keyed op whose key contains this: right after its side effect, before its `done` is written, the
                              // agent kills itself (SIGKILL), as a crash there would (the drills' "agent killed while typing"). Once.
  noSessionBinding?: true;    // negative control: a delivery to a lane name is not bound to the lane's session; it is held for the
                              // name like a sticky one, and the pane is never asked for the session
  retypeUnderFirstKey?: true; // negative control: the one retype after an interrupt runs under the delivery's own key, not `<id>#2`
  deliveryStartGraceMs?: number; // how long a pane this agent started may wait for Claude Code (LIMITS.deliveryStartGraceMs)
};

export class TestHooksRefused extends Error {
  constructor(message: string) { super(message); this.name = "TestHooksRefused"; }
}

export const TEST_HOOKS_VAR = "MORNDO_NODE_TEST_HOOKS";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VALID: { [K in keyof Required<TestHooks>]: (v: unknown) => boolean } = {
  dropAfterStarted: v => typeof v === "string" && v.length > 0,
  noDoneKeys: v => v === true,
  noExpect: v => v === true,
  clockOffsetMs: v => Number.isSafeInteger(v),
  spoolFail: v => v === true,
  fixedStreamId: v => typeof v === "string" && UUID.test(v),
  killAfterEffect: v => typeof v === "string" && v.length > 0,
  noSessionBinding: v => v === true,
  retypeUnderFirstKey: v => v === true,
  deliveryStartGraceMs: v => Number.isSafeInteger(v) && (v as number) >= 0,
};

// A directory with its links resolved, so a link to the account's home is that home; one that doesn't exist (yet) is
// only made absolute.
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

// `home`: the HOME the agent runs with; `accountHome`: the account's own home (os.userInfo().homedir), "" when unknown.
export function loadTestHooks(env: NodeJS.ProcessEnv, where: { home: string; accountHome: string }): TestHooks {
  const raw = env[TEST_HOOKS_VAR];
  if (raw === undefined || raw.trim() === "") return {};
  if (env.NODE_ENV !== "test") {
    throw new TestHooksRefused(`${TEST_HOOKS_VAR} is set, but NODE_ENV is not "test": test hooks never run outside tests. Unset ${TEST_HOOKS_VAR}.`);
  }
  if (!where.accountHome) throw new TestHooksRefused(`${TEST_HOOKS_VAR} is set, but this account's home directory is unknown, so HOME can't be told apart from it.`);
  if (real(where.home) === real(where.accountHome)) {
    throw new TestHooksRefused(`${TEST_HOOKS_VAR} is set, but HOME is this account's own home directory: test hooks run only with a throwaway HOME.`);
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new TestHooksRefused(`${TEST_HOOKS_VAR} is not valid JSON.`); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TestHooksRefused(`${TEST_HOOKS_VAR} must hold a JSON object.`);
  for (const [name, v] of Object.entries(value)) {
    if (!Object.hasOwn(VALID, name)) {
      throw new TestHooksRefused(`${TEST_HOOKS_VAR}: unknown hook ${JSON.stringify(name.slice(0, 40))} (known: ${Object.keys(VALID).join(", ")}).`);
    }
    if (!VALID[name as keyof TestHooks](v)) throw new TestHooksRefused(`${TEST_HOOKS_VAR}: ${name} has a value of the wrong type.`);
  }
  return value as TestHooks;
}

// The wall clock the agent reports (pane.send's typedAt, health.wallClock, HookEvent.at), moved by clockOffsetMs.
export function wallClock(hooks: TestHooks): () => number {
  const offset = hooks.clockOffsetMs ?? 0;
  return () => Date.now() + offset;
}

// dropAfterStarted as the executor's afterStarted hook: the first time a key that contains `match` is started in this
// process, `drop` cuts the connection and the answer is to be discarded (true).
export function dropOnce(match: string, drop: () => void): (key: string) => boolean {
  const dropped = new Set<string>();
  return key => {
    if (!key.includes(match) || dropped.has(key)) return false;
    dropped.add(key);
    drop();
    return true;
  };
}

// killAfterEffect as the executor's afterEffect hook: the first time a key that contains `match` has acted, `kill` ends
// the agent at once. SIGKILL can't be caught: no handler runs and nothing more is written, as in a crash.
export function killOnce(match: string, kill: () => void = () => { process.kill(process.pid, "SIGKILL"); }): (key: string) => void {
  let done = false;
  return key => {
    if (done || !key.includes(match)) return;
    done = true;
    kill();
  };
}
```

- [ ] **Step 9: Add `afterEffect` to `apps/node-agent/src/ops/executor.ts`**

1. In the header, replace:

```ts
// `afterStarted` runs right after a keyed op's `started` is committed (the test hook dropAfterStarted cuts the connection
// there); when it answers true, the op runs on and its reply says `discarded`, for agent.ts never to send.
```

with:

```ts
// `afterStarted` runs right after a keyed op's `started` is committed (the test hook dropAfterStarted cuts the connection
// there); when it answers true, the op runs on and its reply says `discarded`, for agent.ts never to send.
// `afterEffect` runs right after a keyed op acted, before its `done` is written (the test hook killAfterEffect kills the
// agent there: a typing whose key stays `started`, fleet clients Task 16's drill).
```

2. In `ExecutorDeps`, replace:

```ts
  afterStarted?: (key: string) => boolean;
};
```

with:

```ts
  afterStarted?: (key: string) => boolean;
  afterEffect?: (key: string) => void;
};
```

3. In `#effect`, replace:

```ts
      if (key !== undefined) {
        if (out.ok) keys.finish(key, out.result);
```

with:

```ts
      if (key !== undefined && out.ok) this.#d.afterEffect?.(key);
      if (key !== undefined) {
        if (out.ok) keys.finish(key, out.result);
```

- [ ] **Step 10: Run it and watch it pass**

Run: `npx vitest run apps/node-agent/test/delivery-hooks.test.ts apps/node-agent/test/test-hooks.test.ts apps/node-agent/test/executor.test.ts`

Expected: PASS, every test of the three files. `delivery-hooks.test.ts` has 3; the other two pass as before, so the new hooks change nothing for them.

- [ ] **Step 11: Commit**

```bash
git add apps/node-agent/src/test-hooks.ts apps/node-agent/src/ops/executor.ts apps/node-agent/test/delivery-hooks.test.ts
git commit -m "test(node-agent): test hooks for the delivery drills: killAfterEffect, noSessionBinding, retypeUnderFirstKey, deliveryStartGraceMs"
```

- [ ] **Step 12: Replace `apps/node-agent/test/fake-claude.fixture.ts`**

The agent's fake box gains three things, which this task's tmux test and Task 6 use:
- `raw.bin`, every byte the box received, to show that pastes never interleave;
- `/exit`, which clears the frame and ends, as Claude Code's does;
- `--tasks`, the exit prompt first, and `--stay`, which never ends.

What existing tests see is unchanged.

```ts
// A stand-in for Claude Code's input box, run as a pane's program by the agent's tmux tests (never the real CLI), like
// apps/hub/test/tmux-fake-claude.fixture.ts. It turns bracketed paste on and draws a ─ rule, "❯ " and the input, a ─
// rule and a footer. Inside a paste every byte is text; outside it Enter submits and DEL deletes. It runs nothing: it
// records what reaches it.
// Usage: node fake-claude.fixture.ts <state dir> [--tasks] [--stay]; writes <dir>/submitted.jsonl (one JSON string per
// submit) and <dir>/raw.bin (every byte received).
// "/exit" submitted ends it as Claude Code's does: it clears its frame, so no stale box is left on the screen (Claude Code
// 2.1.287, packages/node-ops/test/fixtures/claude-code-2.1.287/exited-to-shell.ansi), and exits 0.
// - With --tasks it first asks, as Claude Code does while background tasks run, in a menu whose first choice is "Exit
//   and stop tasks" (the words claude-pool answers with 1; their real screen is still to be recorded, RECONCILIATION.md
//   ruling 19), and ends on "1".
// - With --stay it records "/exit" and goes on: a lane that never closes.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const dir = process.argv[2] ?? ".";
const tasks = process.argv.includes("--tasks");
const stay = process.argv.includes("--stay");
const decoder = new StringDecoder("utf8");
let input = "";
let paste = false;
let pending = "";
let menu = false;

function draw() {
  if (menu) {
    process.stdout.write("\u001b[H\u001b[2JBackground tasks are still running.\r\n\r\n❯ 1. Exit and stop tasks\r\n  2. Keep working\r\n\r\nEnter to confirm · Esc to cancel");
    return;
  }
  const line = input.replace(/\n/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
  process.stdout.write(`\u001b[H\u001b[2J${"─".repeat(40)}\r\n\u001b[38;5;246m❯ \u001b[39m${line}\r\n${"─".repeat(40)}\r\n  ? for shortcuts`);
}

function end(): never {
  process.stdout.write("\u001b[?2004l\u001b[H\u001b[2J");
  process.exit(0);
}

process.stdin.setRawMode(true);
process.stdout.write("\u001b[?2004h");
draw();
process.stdin.on("data", (chunk: Buffer) => {
  appendFileSync(join(dir, "raw.bin"), chunk);
  pending += decoder.write(chunk);
  while (pending) {
    if (pending.startsWith("\u001b[200~")) { paste = true; pending = pending.slice(6); continue; }
    if (pending.startsWith("\u001b[201~")) { paste = false; pending = pending.slice(6); continue; }
    if (pending[0] === "\u001b") {
      const csi = /^\u001b\[[0-9;?]*[ -/]*[@-~]/.exec(pending);
      if (!csi && pending.length < 8) break;
      pending = pending.slice(csi ? csi[0].length : 1);
      continue;
    }
    const ch = pending[0] ?? "";
    pending = pending.slice(1);
    if (menu) { if (ch === "1") end(); continue; }
    if (paste) input += ch === "\r" ? "\n" : ch;
    else if (ch === "\r") {
      appendFileSync(join(dir, "submitted.jsonl"), `${JSON.stringify(input)}\n`);
      const exit = input === "/exit";
      input = "";
      if (exit && tasks) menu = true;
      else if (exit && !stay) end();
    }
    else if (ch === "\u007f") input = input.slice(0, -1);
    else if (ch >= " ") input += ch;
  }
  draw();
});
```

- [ ] **Step 13: Replace `apps/node-agent/test/ops-harness.ts`**

The harness passes `emitDelivery` through, and `close()` stops the deliverer before the database closes.

```ts
// The agent's op side on a temporary HOME and an isolated tmux server, driven through the executor as the fleet would
// drive it, without a connection. Its deliverer runs a round for each new delivery and when a test kicks it (start()
// adds the 5 s timer); close() stops it. A test that leaves rounds running awaits deliverer.drain() before close().
import type { PaneLock } from "@morndo/node-ops";
import type { Delivery } from "@morndo/protocol";
import { DEFAULT_POLICY, type AgentConfig, type Policy } from "../src/config.ts";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import type { Reply } from "../src/ops/executor.ts";
import type { GuardInput } from "../src/ops/pane-ops.ts";
import { createOpsRuntime, type OpsRuntime } from "../src/ops/runtime.ts";
import { agentPaths, type AgentPaths } from "../src/paths.ts";
import type { TestHooks } from "../src/test-hooks.ts";
import { captureLog } from "./helpers.ts";

export type Harness = OpsRuntime & {
  config: AgentConfig;
  paths: AgentPaths;
  adb: AgentDb;
  call(op: string, args: unknown, o?: { key?: string; timeoutMs?: number }): Promise<Reply>;
  close(): void;
};

export function opsHarness(o: { home: string; socket: string; node?: string; policy?: Partial<Policy>; guard?: (g: GuardInput) => boolean; hooks?: TestHooks;
  lock?: (path: string, waitS: number) => PaneLock; room?: () => number; emitDelivery?: (d: Delivery) => void }): Harness {
  const paths = agentPaths(o.home);
  const config: AgentConfig = {
    node: o.node ?? "pc", fleetUrl: "ws://127.0.0.1:9/agent", fleetKey: "AA==", keyPath: paths.keyPath, dbPath: paths.dbPath,
    relayPort: 0, home: o.home, policy: { ...DEFAULT_POLICY, tmuxSocket: o.socket, ...o.policy },
  };
  const adb = openAgentDb(paths.dbPath);
  const runtime = createOpsRuntime({
    config, db: adb.db, log: captureLog().log, ...(o.guard ? { guard: o.guard } : {}), ...(o.hooks ? { hooks: o.hooks } : {}),
    ...(o.lock ? { lock: o.lock } : {}), ...(o.room ? { room: o.room } : {}), ...(o.emitDelivery ? { emitDelivery: o.emitDelivery } : {}),
  });
  let n = 0;
  return {
    ...runtime, config, paths, adb,
    call: (op, args, c = {}) => runtime.executor.handle({ id: `r${++n}`, op, args, timeoutMs: c.timeoutMs ?? 10_000, ...(c.key !== undefined ? { key: c.key } : {}) }),
    close: () => { runtime.deliverer.stop(); adb.close(); },
  };
}
```

- [ ] **Step 14: Create `apps/node-agent/test/deliverer-tmux.test.ts`**

The failing test for the deliverer wired into the runtime: real tmux, the real executor, and a session the test writes.

```ts
// The deliverer on a real isolated tmux server, typing through the agent's own executor into the agent's fake box
// (fake-claude.fixture.ts). The Claude Code session is the test's (claude-session.ts): the box's submitted lines become
// the transcript's prompts, the receipts the deliverer reads. Covered: plan Review Focus 2, with the bytes the pane
// received; a draft waited through; a `started` key from before a restart, with its negative control; and when a pane's
// process started, for the start grace (RECONCILIATION.md ruling 14).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Delivery } from "@morndo/protocol";
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
afterEach(async () => { stopFollowing(); h.deliverer.stop(); await h.deliverer.drain(); h.close(); t.kill(); home.cleanup(); });

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

  it("waits through a draft in the box (draft_present), and types once it is cleared", async () => {
    t.tmux("send-keys", "-t", pane, "-l", "half");
    expect(await until(() => screen().includes("❯ half"))).toBe(true);
    h.deliverer.enqueue({ id: "hub:d1", target: MANAGER, text: "the message" });
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
    h.doneKeys.start(id, argsHash("pane.send", { workerId: managerLane().workerId, text: "yes" }));   // recorded nowhere: keys are off
    h.deliverer.enqueue({ id, target: MANAGER, text: "yes" });
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
```

- [ ] **Step 15: Run it and watch it fail**

Run: `npx vitest run apps/node-agent/test/deliverer-tmux.test.ts`

Expected: FAIL: the file doesn't load, since `../src/deliveries/views.ts` doesn't exist yet. Without that import, the first four tests would fail with `TypeError: Cannot read properties of undefined (reading 'enqueue')`, since the runtime has no deliverer yet.

- [ ] **Step 16: Create `apps/node-agent/src/deliveries/views.ts`**

```ts
// The deliverer's view of this node (deliverer.ts: PaneView, TranscriptView; RECONCILIATION.md ruling 19):
// - the lanes the inventory lists, each with its Claude Code session and that session's status (Task 4's Lane, from the
//   session registry), and when its pane's own process started (ruling 14);
// - the input box's own text, read from the pane's screen with its colours (Claude Code's dim suggestion is no draft);
// - a session's transcript, read as whole JSONL lines from a byte offset, at most 1 MiB a call.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { draftOnScreen, localTranscriptBytes, type Tmux } from "@morndo/node-ops";
import { LIMITS } from "@morndo/protocol";
import type { Inventory, Snapshot } from "../ops/inventory.ts";
import type { PaneState, PaneView, TranscriptView } from "./deliverer.ts";

// When a process started, on this machine's clock (ruling 14). The 2-minute grace of spec §4.1 counts from a pane's own
// process, so it survives an agent restart.
// - Linux: field 22 of /proc/<pid>/stat, "the time the process started after system boot ... expressed in clock ticks
//   (divide by sysconf(_SC_CLK_TCK))", plus /proc/stat's btime, "boot time, in seconds since the Epoch"
//   (https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html, https://man7.org/linux/man-pages/man5/proc_stat.5.html,
//   read 2026-10-08). The command's name (field 2) may hold spaces and parentheses, so fields are counted after its last ")".
// - Elsewhere (macOS): `ps -o lstart= -p <pid>` under LC_ALL=C. It gives the start to the second, in a form Date.parse
//   reads only in the C locale: "Thu Oct  8 21:57:02 2026"; under de_DE it printed "Do.  8 Okt. 21:57:02 2026" (macOS,
//   2026-10-08).
// null when the process is gone or its start can't be read. A start once read is kept while its pid is listed, since a pid
// is reused only after its process ended. Reads are synchronous, once per new pane.
export function startFromProcStat(stat: string, btimeSec: number, ticksPerSec: number): number | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");       // field 3 onwards
  const raw = fields[19];                                                   // field 22
  const ticks = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(ticks) && Number.isFinite(btimeSec) && ticksPerSec > 0 ? btimeSec * 1000 + Math.round((ticks / ticksPerSec) * 1000) : null;
}

// /proc/stat's boot time, and the clock ticks a second (getconf CLK_TCK; 100 on the usual kernels).
function bootInfo(): { btimeSec: number; ticks: number } {
  const btimeSec = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
  let ticks = 100;
  try { ticks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim()) || 100; }
  catch { /* the usual 100 */ }
  return { btimeSec, ticks };
}

export class ProcessStarts {
  #at = new Map<number, number>();
  #boot: { btimeSec: number; ticks: number } | null = null;

  at(pid: number): number | null {
    const known = this.#at.get(pid);
    if (known !== undefined) return known;
    const at = this.#read(pid);
    if (at !== null) this.#at.set(pid, at);
    return at;
  }

  // Forgets every pid but these (the panes listed now), so a pid used again by a new process is read again.
  keepOnly(pids: ReadonlySet<number>): void {
    for (const pid of this.#at.keys()) if (!pids.has(pid)) this.#at.delete(pid);
  }

  #read(pid: number): number | null {
    try {
      if (process.platform === "linux") {
        this.#boot ??= bootInfo();
        return startFromProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"), this.#boot.btimeSec, this.#boot.ticks);
      }
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" },
      }).trim();
      const at = Date.parse(out);
      return Number.isFinite(at) ? at : null;
    } catch {
      return null;
    }
  }
}

// A screen line as it shows, without SGR sequences (ESC [ … m), read character by character: the lint forbids the
// escape character in a regular expression outside the terminal fixtures.
function visible(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    if (line.charCodeAt(i) === 27 && line[i + 1] === "[") {
      let j = i + 2;
      while (j < line.length && "0123456789;".includes(line[j] as string)) j++;
      if (line[j] === "m") { i = j; continue; }
    }
    out += line[i];
  }
  return out;
}

export function agentPaneView(d: { inventory: Inventory; tmux: Pick<Tmux, "capture">; starts?: ProcessStarts }): PaneView {
  const starts = d.starts ?? new ProcessStarts();
  const states = (s: Snapshot): PaneState[] => {
    const pids = new Map(s.rows.map(r => [r.pane, r.panePid] as const));
    starts.keepOnly(new Set([...pids.values()].filter((p): p is number => p !== null)));
    return s.lanes.map(l => {
      const pid = pids.get(l.pane) ?? null;
      return { workerId: l.workerId, pane: l.pane, window: l.window, sessionId: l.sessionId, status: l.status, startedAt: pid === null ? null : starts.at(pid) };
    });
  };
  return {
    snapshot: () => states(d.inventory.last()),
    refresh: async () => states(await d.inventory.current(LIMITS.inventoryPollMs)),
    async draft(pane) {
      const screen = await d.tmux.capture(pane, { lines: 30, attributes: true });
      if (screen === null) return null;
      const lines = screen.split("\n");
      while (lines.length && visible(lines.at(-1) ?? "").trim() === "") lines.pop();   // the pane's empty bottom lines
      return draftOnScreen(lines.join("\n"));
    },
  };
}

const READ_MAX = 1 << 20;

export function agentTranscripts(transcriptPath: (sessionId: string) => string | null): TranscriptView {
  return {
    async size(sessionId) {
      const path = transcriptPath(sessionId);
      return path === null ? null : await localTranscriptBytes(path).size();
    },
    // Whole lines from `from` (a line still being written stays for the next call). A line longer than one call reads
    // is skipped: the cursor moves past what was read, and the line's rest is no JSON that could be a receipt.
    async lines(sessionId, from) {
      const path = transcriptPath(sessionId);
      if (path === null) return null;
      const source = localTranscriptBytes(path);
      const size = await source.size();
      if (size === null) return null;
      const start = from > size ? 0 : from;                    // a transcript shorter than before: read it again
      const parts: Buffer[] = [];
      let pos = start;
      while (pos < size && pos - start < READ_MAX) {
        const got = await source.read(pos, LIMITS.chunkBytes);
        if (!got || got.bytes.length === 0) break;
        parts.push(Buffer.from(got.bytes));
        pos += got.bytes.length;
      }
      const buf = Buffer.concat(parts);
      const end = buf.lastIndexOf(0x0a);
      if (end === -1) return { lines: [], next: buf.length >= READ_MAX ? start + buf.length : start };
      return { lines: buf.subarray(0, end).toString("utf8").split("\n").filter(l => l.length > 0), next: start + end + 1 };
    },
  };
}
```

- [ ] **Step 17: Add each pane's own process to `listPanes` in `apps/node-agent/src/ops/tmux-panes.ts`**

The start grace counts from the pane process's own start (ruling 14), so the inventory's rows carry `#{pane_pid}`.

1. Replace:

```ts
export type PaneRow = { pane: string; paneNum: number; windowId: string; windowPanes: number; window: string; cwd: string; title: string | null; stamp: string };
```

with:

```ts
// panePid: the pane's own process (#{pane_pid}): its shell, or the command a lane was started with.
export type PaneRow = { pane: string; paneNum: number; windowId: string; windowPanes: number; window: string; cwd: string; title: string | null; stamp: string;
  panePid: number | null };
```

2. Replace:

```ts
      format(nonce, ["pane_id", "window_id", "window_panes", "@morndo-server", "host", "window_name", "pane_current_path", "pane_title"])]);
```

with:

```ts
      format(nonce, ["pane_id", "window_id", "window_panes", "@morndo-server", "host", "window_name", "pane_current_path", "pane_title", "pane_pid"])]);
```

3. Replace:

```ts
  return records(out, nonce, 8).flatMap(([pane = "", windowId = "", panes = "", stamp = "", host = "", window = "", cwd = "", title = ""]) => {
    const m = /^%(\d{1,9})$/.exec(pane);
    if (!m || !/^@\d+$/.test(windowId)) return [];
    return [{ pane, paneNum: Number(m[1]), windowId, windowPanes: Number(panes), window, cwd, title: title && title !== host ? title : null, stamp: shortStamp(stamp) }];
```

with:

```ts
  return records(out, nonce, 9).flatMap(([pane = "", windowId = "", panes = "", stamp = "", host = "", window = "", cwd = "", title = "", pid = ""]) => {
    const m = /^%(\d{1,9})$/.exec(pane);
    if (!m || !/^@\d+$/.test(windowId)) return [];
    return [{ pane, paneNum: Number(m[1]), windowId, windowPanes: Number(panes), window, cwd, title: title && title !== host ? title : null, stamp: shortStamp(stamp),
      panePid: /^\d{1,10}$/.test(pid) ? Number(pid) : null }];
```

- [ ] **Step 18: Replace `apps/node-agent/src/ops/runtime.ts`**

```ts
// The op side of the agent, assembled: inventory, done keys, upload inbox, session registry and the executor over
// every op, and the wall clock the node reports. agent.ts runs it behind the fleet connection; the tests drive the
// executor directly. Test hooks act here (test-hooks.ts): noDoneKeys, noExpect, clockOffsetMs, and for the delivery
// drills killAfterEffect (the executor's afterEffect), noSessionBinding, retypeUnderFirstKey and deliveryStartGraceMs.
// Fleet clients (spec §4):
// - the delivery queue: its store in agent.db, and the deliverer typing through this executor;
// - the policy's tmux server, for the deliverer's box checks;
// - the deliverer's view of the lanes, with each pane process's start for the 2-minute grace (RECONCILIATION.md ruling 14);
// - each session's topic and last prompt, for the inventory (ruling 13).
import type Database from "better-sqlite3";
import { sessionRegistry, stampServer, tmuxAdapter, type PaneLock, type Tmux } from "@morndo/node-ops";
import type { Delivery } from "@morndo/protocol";
import type { AgentConfig } from "../config.ts";
import { Deliverer, type PaneView } from "../deliveries/deliverer.ts";
import { DeliveryStore } from "../deliveries/store.ts";
import { agentPaneView, agentTranscripts } from "../deliveries/views.ts";
import type { Logger } from "../log.ts";
import { agentPaths } from "../paths.ts";
import { killOnce, wallClock, type TestHooks } from "../test-hooks.ts";
import { DoneKeys } from "./done-keys.ts";
import { OpExecutor } from "./executor.ts";
import { Inventory } from "./inventory.ts";
import type { GuardInput } from "./pane-ops.ts";
import { buildOps, claudeDir } from "./table.ts";
import { TranscriptTitles } from "./transcript-titles.ts";
import { UploadInbox } from "./upload-inbox.ts";

export type OpsRuntime = {
  inventory: Inventory;
  doneKeys: DoneKeys;
  inbox: UploadInbox;
  registry: ReturnType<typeof sessionRegistry>;
  executor: OpExecutor;
  now: () => number;                                      // the wall clock the node reports (clockOffsetMs included)
  tmux: Tmux;                                             // the policy's tmux server
  deliveries: DeliveryStore;
  deliverer: Deliverer;
  panes: PaneView;                                        // the deliverer's view of the lanes
};

export type RuntimeOptions = {
  config: AgentConfig;
  db: Database.Database;
  log: Logger;
  guard?: (g: GuardInput) => boolean;                     // a test replaces the expectation check to show what it prevents
  hooks?: TestHooks;
  afterStarted?: (key: string) => boolean;                // the executor's hook after a committed `started` (agent.ts)
  lock?: (path: string, waitS: number) => PaneLock;       // a test's slow lock; node-ops' paneLock otherwise
  room?: () => number;                                    // bytes still free in the node's disk budget (agent.ts)
  emitDelivery?: (d: Delivery) => void;                   // each change of a delivery (agent.ts: ev.delivery)
};

const acceptAny = () => true;

export function createOpsRuntime(o: RuntimeOptions): OpsRuntime {
  const { config } = o;
  const hooks = o.hooks ?? {};
  const now = wallClock(hooks);
  const paths = agentPaths(config.home);
  const registry = sessionRegistry(claudeDir(config.home));
  // topic and lastPrompt (RECONCILIATION.md ruling 13): each session's transcript, found through the same registry.
  const titles = new TranscriptTitles(sessionId => registry.transcriptPath(sessionId));
  const inventory = new Inventory({
    node: config.node, session: config.policy.session, socket: config.policy.tmuxSocket,
    sessions: () => registry.byPane(), stamp: stampServer, titles: sessionId => titles.read(sessionId),
  });
  const doneKeys = new DoneKeys(o.db, Date.now, { disabled: hooks.noDoneKeys === true });
  const inbox = new UploadInbox({ dir: paths.inboxDir, ...(o.room ? { room: o.room } : {}) });
  const guard = o.guard ?? (hooks.noExpect ? acceptAny : undefined);
  const ops = buildOps({ config, paths, db: o.db, doneKeys, inventory, inbox, registry, now, ...(guard ? { guard } : {}), ...(o.lock ? { lock: o.lock } : {}) });
  const executor = new OpExecutor({
    ops, allowed: new Set(config.policy.ops), doneKeys, invVersion: () => inventory.invVersion, log: o.log,
    ...(o.afterStarted ? { afterStarted: o.afterStarted } : {}),
    ...(hooks.killAfterEffect !== undefined ? { afterEffect: killOnce(hooks.killAfterEffect) } : {}),
  });
  const tmux = tmuxAdapter({ socket: config.policy.tmuxSocket, session: config.policy.session });
  const deliveries = new DeliveryStore(o.db, now, config.node);
  const panes = agentPaneView({ inventory, tmux });
  const deliverer = new Deliverer({
    store: deliveries, executor, panes, transcripts: agentTranscripts(sessionId => registry.transcriptPath(sessionId)),
    now, emit: o.emitDelivery ?? (() => {}), log: o.log, hooks,
  });
  return { inventory, doneKeys, inbox, registry, executor, now, tmux, deliveries, deliverer, panes };
}
```

- [ ] **Step 19: Run it and watch it pass**

Run: `npx vitest run apps/node-agent/test/deliverer-tmux.test.ts`

Expected: PASS, `Tests  7 passed (7)`.

- [ ] **Step 20: Create `apps/node-agent/test/agent-deliveries.test.ts`**

The failing test for `ev.delivery` over the connection (§4.4).

```ts
// The agent's deliveries over its connection (fleet clients spec §4.4), against the scripted fake fleet: every change of
// a delivery as ev.delivery, and after every (re)connect the state of each delivery not final plus the final ones of the
// last hour. The deliveries are put in agent.db before the agent starts, as a restart finds them. And a hook arriving at
// the relay kicks the deliverer (RECONCILIATION.md ruling 60).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Delivery } from "@morndo/protocol";
import type { AgentConfig } from "../src/config.ts";
import { openAgentDb } from "../src/db/open.ts";
import { DeliveryStore } from "../src/deliveries/store.ts";
import { joinedConfig, runAgent } from "./agent-harness.ts";
import { startFakeFleet, type FakeFleet } from "./fake-fleet.ts";
import { isolatedTmux, tempHome, until, type TestTmux } from "./helpers.ts";

let fleet: FakeFleet;
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let config: AgentConfig;
const stops: (() => Promise<void>)[] = [];
beforeEach(async () => {
  fleet = await startFakeFleet({ welcome: { connEpoch: 4, ackSeq: 0, streamKnown: true } });
  home = tempHome();
  t = isolatedTmux();
  config = await joinedConfig(home.home, fleet, t.socket);
});
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  await fleet.close();
  t.kill();
  home.cleanup();
});
const deliveries = (from = 0) => fleet.received.slice(from).filter(r => r.msg.t === "ev.delivery").map(r => r.msg.delivery as Delivery);

describe("ev.delivery (spec §4.4)", () => {
  it("sends each change, and after every welcome the open deliveries and the final ones of the last hour", async () => {
    const T = Date.now();
    const adb = openAgentDb(config.dbPath);
    const clock = { now: T - 2 * 3_600_000 };
    const store = new DeliveryStore(adb.db, () => clock.now, "pc");
    const api = { lane: "api", sticky: false } as const;
    store.store({ id: "hub:old", target: api, text: "old", ttlMs: 60_000, boundSession: null });
    store.update("hub:old", { state: "given_up", why: "expired" });                 // final two hours ago
    clock.now = T - 30 * 60_000;
    store.store({ id: "hub:recent", target: api, text: "recent", ttlMs: 60_000, boundSession: null });
    store.update("hub:recent", { state: "delivered", deliveredAt: clock.now });      // final half an hour ago
    clock.now = T;
    store.store({ id: "hub:open", target: { lane: "manager", sticky: true }, text: "for the manager", ttlMs: 86_400_000, boundSession: null });
    adb.close();
    const { agent } = await runAgent(config);
    stops.push(() => agent.stop());
    // The change its first round makes: no manager window, so it waits there (no_pane).
    expect(await until(() => deliveries().some(d => d.id === "hub:open" && d.waiting?.reason === "no_pane"))).toBe(true);
    expect(await until(() => deliveries().some(d => d.id === "hub:recent"))).toBe(true);
    expect(deliveries().map(d => d.id)).not.toContain("hub:old");
    const cut = fleet.received.length;
    fleet.closeAgent(1011, "fleet restart");
    expect(await until(() => ["hub:open", "hub:recent"].every(id => deliveries(cut).some(d => d.id === id)))).toBe(true);
    expect(deliveries(cut).find(d => d.id === "hub:open")).toMatchObject({ node: "pc", state: "queued", waiting: { reason: "no_pane" }, target: { lane: "manager" } });
    expect(deliveries(cut).find(d => d.id === "hub:recent")).toMatchObject({ state: "delivered" });
    expect(deliveries(cut).map(d => d.id)).not.toContain("hub:old");
    expect(fleet.malformed).toEqual([]);
  });

  it("kicks the deliverer when a hook arrives, so a receipt or a lane's change is acted on at once (ruling 60)", async () => {
    const { agent, post } = await runAgent(config);
    stops.push(() => agent.stop());
    const reasons: string[] = [];
    const kick = agent.deliverer.kick.bind(agent.deliverer);
    agent.deliverer.kick = reason => { reasons.push(reason); kick(reason); };
    expect((await post("/hook/stop", { session_id: "3c4d5e6f-0000-4000-8000-000000000001" })).status).toBe(200);
    expect(await until(() => reasons.includes("hook"))).toBe(true);
  });
});
```

- [ ] **Step 21: Run it and watch it fail**

Run: `npx vitest run apps/node-agent/test/agent-deliveries.test.ts`

Expected: FAIL, 2 failed:
- `expected false to be true`: no `ev.delivery` reaches the fleet. The agent doesn't start the deliverer or send its changes yet.
- `TypeError: Cannot read properties of undefined (reading 'kick')`: the running agent has no `deliverer` yet.

- [ ] **Step 22: Replace `apps/node-agent/src/events.ts`**

```ts
// Inventory and health events (spec §5.4), latest wins. The inventory is read every 2 s (LIMITS.inventoryPollMs) and
// sent when its invVersion moved, and in full after every welcome; health every 30 s (LIMITS.healthMs) and after every
// welcome. Each loop waits for its previous round, so a slow tmux never piles reads up.
// Fleet clients: each inventory read is also handed to `onInventory` (the deliverer's kick; Task 6's lane state events)
// before it is sent, whether or not the fleet is connected. A failure there is logged and never stops the loop.
import { LIMITS, type AgentMessage, type Health } from "@morndo/protocol";
import type { Logger } from "./log.ts";
import type { Inventory, Snapshot } from "./ops/inventory.ts";

export type EventLoopOptions = {
  inventory: Inventory;
  send: (m: AgentMessage) => boolean;
  health: () => Promise<Health>;
  log: Logger;
  pollMs?: number;
  healthMs?: number;
  onInventory?: (s: Snapshot) => void | Promise<void>;
};

export class EventLoops {
  #o: EventLoopOptions;
  #online = false;
  #sentVersion = -1;
  #timers = new Set<NodeJS.Timeout>();
  #stopped = false;

  constructor(o: EventLoopOptions) { this.#o = o; }

  start(): void {
    this.#loop(this.#o.pollMs ?? LIMITS.inventoryPollMs, () => this.#inventory());
    this.#loop(this.#o.healthMs ?? LIMITS.healthMs, () => this.#health());
  }

  // After a welcome: the full inventory and a health event, whatever was sent before.
  online(): void {
    this.#online = true;
    this.#sentVersion = -1;
    void this.#inventory();
    void this.#health();
  }

  offline(): void { this.#online = false; }

  stop(): void {
    this.#stopped = true;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
  }

  #loop(ms: number, round: () => Promise<void>): void {
    const next = () => {
      if (this.#stopped) return;
      const t = setTimeout(() => {
        this.#timers.delete(t);
        void round().finally(next);
      }, ms);
      this.#timers.add(t);
    };
    next();
  }

  async #inventory(): Promise<void> {
    let s: Snapshot;
    try { s = await this.#o.inventory.refresh(); }
    catch (e) { this.#o.log.warn("reading the inventory failed", e); return; }
    try { await this.#o.onInventory?.(s); }
    catch (e) { this.#o.log.warn("acting on the inventory failed", e); }
    if (!this.#online || s.invVersion === this.#sentVersion) return;
    if (this.#o.send({ v: 1, t: "ev.inventory", invVersion: s.invVersion, panes: s.panes })) this.#sentVersion = s.invVersion;
  }

  async #health(): Promise<void> {
    if (!this.#online) return;
    try { this.#o.send({ v: 1, t: "ev.health", health: await this.#o.health() }); }
    catch (e) { this.#o.log.warn("reading health failed", e); }
  }
}
```

- [ ] **Step 23: Wire the deliverer into `apps/node-agent/src/agent.ts`**

Fifteen replacements, each of text that occurs once: fourteen in `agent.ts`, and one in `scripts/negative-controls.ts` for the control this step makes stale (ruling 51). Items 12 to 14 let a test see what kicks the deliverer (ruling 60).

1. Replace:

```ts
// - The disk budget, LIMITS.spoolMaxBytes, is the spool's, the relay's copies' and the upload inbox's together.
```

with:

```ts
// - The disk budget, LIMITS.spoolMaxBytes, is the spool's, the relay's copies' and the upload inbox's together.
// - Deliveries (fleet clients spec §4): the deliverer runs from start to stop, kicked by hooks and inventory reads; each
//   change goes out as ev.delivery, and after every welcome the open ones and the final ones of the last hour (§4.4).
```

2. Replace:

```ts
import { ERROR_EXECUTED, LIMITS, type AgentMessage, type OpError } from "@morndo/protocol";
```

with:

```ts
import { ERROR_EXECUTED, LIMITS, type AgentMessage, type Delivery, type OpError } from "@morndo/protocol";
```

3. Replace:

```ts
const HOUSEKEEPING_MS = 3_600_000;
```

with:

```ts
const HOUSEKEEPING_MS = 3_600_000;
// After every welcome: the deliveries not final, and the final ones changed within this long (spec §4.4).
const DELIVERY_REPLAY_MS = 3_600_000;
```

4. Replace:

```ts
  const ops = createOpsRuntime({
    config, db: adb.db, log, hooks, room: () => room(),
```

with:

```ts
  const ops = createOpsRuntime({
    config, db: adb.db, log, hooks, room: () => room(),
    emitDelivery: d => { sendDelivery(d); },
```

5. Replace:

```ts
  const send = (m: AgentMessage, lane: Lane = "control") => conn?.send(m, lane) ?? false;
```

with:

```ts
  const send = (m: AgentMessage, lane: Lane = "control") => conn?.send(m, lane) ?? false;
  const sendDelivery = (d: Delivery) => send({ v: 1, t: "ev.delivery", delivery: d });
  // After every welcome (spec §4.4): each delivery not final, and the final ones of the last hour; latest wins at the
  // fleet, as for the inventory. A change made while offline is in there, so none is lost by a dropped send.
  const replayDeliveries = () => {
    try {
      for (const d of [...ops.deliveries.open(), ...ops.deliveries.recentFinal(ops.now() - DELIVERY_REPLAY_MS)]) sendDelivery(d);
    } catch (e) { log.warn("could not read the deliveries to send after a welcome", e); }
  };
```

6. Replace:

```ts
    inventory: ops.inventory, send: m => send(m), log,
```

with:

```ts
    inventory: ops.inventory, send: m => send(m), log, onInventory: () => { ops.deliverer.kick("inventory"); },
```

7. Replace:

```ts
      port: config.relayPort, spool, files, log, onAppended: () => sender.kick(), now: ops.now,
```

with:

```ts
      port: config.relayPort, spool, files, log, onAppended: () => { sender.kick(); ops.deliverer.kick("hook"); }, now: ops.now,
```

8. Replace:

```ts
    onWelcome: w => {
      sender.online(w);
      events.online();
    },
```

with:

```ts
    onWelcome: w => {
      sender.online(w);
      events.online();
      replayDeliveries();
    },
```

9. Replace:

```ts
    try { ops.doneKeys.prune(); files.sweep(); ops.inbox.sweep(); }
```

with:

```ts
    try { ops.doneKeys.prune(); ops.deliveries.prune(); files.sweep(); ops.inbox.sweep(); }
```

10. Replace:

```ts
  events.start();
  conn.start();
```

with:

```ts
  events.start();
  ops.deliverer.start();
  conn.start();
```

11. Replace:

```ts
      for (const t of timers) clearInterval(t);
      events.stop();
      await conn?.stop();
      await relay.close();
      saveStatus();
      adb.close();
```

with:

```ts
      for (const t of timers) clearInterval(t);
      events.stop();
      ops.deliverer.stop();
      await conn?.stop();
      await relay.close();
      await ops.deliverer.drain();                         // a round in flight ends before its database closes
      saveStatus();
      adb.close();
```

12. Replace:

```ts
import { openAgentDb, rotateStreamId } from "./db/open.ts";
```

with:

```ts
import { openAgentDb, rotateStreamId } from "./db/open.ts";
import type { Deliverer } from "./deliveries/deliverer.ts";
```

13. Replace:

```ts
  inventory: Inventory;
  spool: Spool;
```

with:

```ts
  inventory: Inventory;
  deliverer: Deliverer;                                    // the delivery queue's deliverer (tests watch what kicks it)
  spool: Spool;
```

14. Replace:

```ts
    instanceId, get streamId() { return streamId; }, relayPort: relay.port, inventory: ops.inventory, spool, status,
```

with:

```ts
    instanceId, get streamId() { return streamId; }, relayPort: relay.port, inventory: ops.inventory, deliverer: ops.deliverer, spool, status,
```

Item 9's housekeeping line is the text of the fleet core's control `t9-prune-not-wired`, which keeps its meaning (`doneKeys.prune` not wired).

In `scripts/negative-controls.ts`, replace:

```ts
    find: "    try { ops.doneKeys.prune(); files.sweep(); ops.inbox.sweep(); }",
    replace: "    try { files.sweep(); ops.inbox.sweep(); }",
```

with:

```ts
    find: "    try { ops.doneKeys.prune(); ops.deliveries.prune(); files.sweep(); ops.inbox.sweep(); }",
    replace: "    try { ops.deliveries.prune(); files.sweep(); ops.inbox.sweep(); }",
```

Run: `node scripts/negative-controls.ts --check`. Expected: exit 0: every entry's text, `t9-prune-not-wired`'s included, is there exactly once.

- [ ] **Step 24: Run it and watch it pass**

Run: `npx vitest run apps/node-agent/test/agent-deliveries.test.ts apps/node-agent/test/agent.test.ts apps/node-agent/test/stream.test.ts`

Expected: PASS, every test of the three files. `agent-deliveries.test.ts` has 2; the other two show the agent's earlier behaviour unchanged.

- [ ] **Step 25: Check the whole task**

Run each command on its own:
- `npx vitest run apps/node-agent/test`. Expected: no failed test, 4 more files and 47 more tests than after Task 4 (deliverer 35, delivery-hooks 3, deliverer-tmux 7, agent-deliveries 2).
- `npx tsc -p apps/node-agent`. Expected: no output, exit 0.
- `npx tsc -p tsconfig.tests.json`. Expected: no output, exit 0.
- `npx oxlint --format=stylish apps/node-agent`. Expected: no output.

- [ ] **Step 26: Commit**

```bash
git add apps/node-agent/src/deliveries/views.ts apps/node-agent/src/ops/tmux-panes.ts apps/node-agent/src/ops/runtime.ts apps/node-agent/src/events.ts apps/node-agent/src/agent.ts apps/node-agent/test/ops-harness.ts apps/node-agent/test/fake-claude.fixture.ts apps/node-agent/test/deliverer-tmux.test.ts apps/node-agent/test/agent-deliveries.test.ts scripts/negative-controls.ts
git commit -m "feat(node-agent): the deliverer in the running agent: ev.delivery, replay after a welcome, kicks from hooks and the inventory"
```

- [ ] **Step 27: Add this task's negative controls to `scripts/negative-controls.ts`**

After Task 4's `fc4-order-by-id` entry (it ends `run: ["apps/node-agent/test/delivery-store.test.ts"], expect: "hub:z" },`), insert:

```ts
  { id: "fc5-all-at-once", task: "fc5", file: "apps/node-agent/src/deliveries/deliverer.ts",
    find: "      if (held.has(key) || next.has(key)) { this.#wait(d, \"earlier\"); continue; }",
    replace: "      if (next.has(key)) { this.#wait(d, \"earlier\"); continue; }",
    run: ["apps/node-agent/test/deliverer.test.ts"], expect: "hub:answer:e1:a1:ship" },
  { id: "fc5-hold-unbounded", task: "fc5", file: "apps/node-agent/src/deliveries/deliverer.ts",
    find: "        if (now - (d.typedAt ?? d.queuedAt) < LIMITS.deliveryReceiptHoldMs) held.add(key);", replace: "        held.add(key);",
    run: ["apps/node-agent/test/deliverer.test.ts"], expect: "hub:second" },
  { id: "fc5-new-session-unconfirmed", task: "fc5", file: "apps/node-agent/src/deliveries/deliverer.ts",
    find: "      if (p !== null && p.sessionId !== null && p.sessionId !== d.sessionId) this.#change(d, { state: \"delivered\", deliveredAt: this.#d.now() });\n",
    replace: "",
    run: ["apps/node-agent/test/deliverer.test.ts"], expect: "delivered" },
  { id: "fc5-unavailable-unsaid", task: "fc5", file: "apps/node-agent/src/deliveries/deliverer.ts",
    find: "      for (const d of store.open()) this.#wait(d, \"unavailable\");",
    replace: "      for (const d of store.open()) this.#wait(d, \"busy\");",
    run: ["apps/node-agent/test/deliverer.test.ts"], expect: "unavailable" },
  { id: "fc5-maybe-typed-again", task: "fc5", file: "apps/node-agent/src/deliveries/deliverer.ts",
    find: "    if (e.executed === \"maybe\") {", replace: "    if (false) {",
    run: ["apps/node-agent/test/deliverer.test.ts", "apps/node-agent/test/deliverer-tmux.test.ts"], expect: "restart" },
  { id: "fc5-enter-not-own-line", task: "fc5", file: "apps/node-agent/src/deliveries/deliverer.ts",
    find: "      if (draft === null || !ownLine(draft, text)) return;", replace: "      if (draft === null) return;",
    run: ["apps/node-agent/test/deliverer.test.ts"], expect: "pane.keys" },
  { id: "fc5-enter-three-times", task: "fc5", file: "apps/node-agent/src/deliveries/deliverer.ts",
    find: "const ENTER_MAX = 2;", replace: "const ENTER_MAX = 3;",
    run: ["apps/node-agent/test/deliverer.test.ts"], expect: "at most twice, and never again for it" },
  { id: "fc5-retype-first-key", task: "fc5", file: "apps/node-agent/src/deliveries/deliverer.ts",
    find: "`${d.id}#2`", replace: "d.id",
    run: ["apps/node-agent/test/deliverer.test.ts"], expect: "hub:d#2" },
  { id: "fc5-third-typing", task: "fc5", file: "apps/node-agent/src/deliveries/deliverer.ts",
    find: "    if (t.retyped) { this.#change(d, { state: \"uncertain\", note: \"dropped by an interrupt again, after its one retype\" }); return; }\n",
    replace: "",
    run: ["apps/node-agent/test/deliverer.test.ts"], expect: "uncertain" },
  { id: "fc5-dropped-as-delivered", task: "fc5", file: "apps/node-agent/src/deliveries/deliverer.ts",
    find: "    await this.#dropped(d, panes);", replace: "    this.#change(d, { state: \"delivered\", deliveredAt: at });",
    run: ["apps/node-agent/test/deliverer.test.ts"], expect: "hub:d#2" },
  { id: "fc5-no-session-binding", task: "fc5", file: "apps/node-agent/src/deliveries/deliverer.ts",
    find: "    if (bound && t.boundSession !== null && p.sessionId !== null && p.sessionId !== t.boundSession) return { gone: true };\n",
    replace: "",
    run: ["apps/node-agent/test/deliverer.test.ts"], expect: "gone" },
  { id: "fc5-typed-expired", task: "fc5", file: "apps/node-agent/src/deliveries/deliverer.ts",
    find: "      if (d.state === \"queued\") { this.#change(d, { state: \"given_up\", why: \"expired\" }); continue; }",
    replace: "      { this.#change(d, { state: \"given_up\", why: \"expired\" }); continue; }",
    run: ["apps/node-agent/test/deliverer.test.ts"], expect: "uncertain" },
  { id: "fc5-no-session-taken", task: "fc5", file: "apps/node-agent/src/deliveries/deliverer.ts",
    find: "    const refuse = (p: PaneState) => !takes(p) && !(p.startedAt !== null && now - p.startedAt < this.#grace);",
    replace: "    const refuse = (_p: PaneState) => false;",
    run: ["apps/node-agent/test/deliverer.test.ts"], expect: "no_session" },
  { id: "fc5-start-grace-ignored", task: "fc5", file: "apps/node-agent/src/deliveries/deliverer.ts",
    find: "    const refuse = (p: PaneState) => !takes(p) && !(p.startedAt !== null && now - p.startedAt < this.#grace);",
    replace: "    const refuse = (p: PaneState) => !takes(p);",
    run: ["apps/node-agent/test/deliverer.test.ts"], expect: "no_session" },
  { id: "fc5-shell-status-refused", task: "fc5", file: "apps/node-agent/src/deliveries/deliverer.ts",
    find: "const takes = (p: PaneState): boolean => p.sessionId !== null;",
    replace: "const takes = (p: PaneState): boolean => p.sessionId !== null && p.status !== \"shell\";",
    run: ["apps/node-agent/test/deliverer.test.ts"], expect: "hub:s" },
  { id: "fc5-process-start-unread", task: "fc5", file: "apps/node-agent/src/deliveries/views.ts",
    find: "startedAt: pid === null ? null : starts.at(pid)", replace: "startedAt: null",
    run: ["apps/node-agent/test/deliverer-tmux.test.ts"], expect: "gives each lane its pane process's start" },
  { id: "fc5-cancel-while-typing", task: "fc5", file: "apps/node-agent/src/deliveries/deliverer.ts",
    find: "    if (this.#trying.has(id)) return err(\"busy\", \"the delivery is being typed right now; ask again in a moment\");\n",
    replace: "",
    run: ["apps/node-agent/test/deliverer.test.ts"], expect: "busy" },
  { id: "fc5-no-replay", task: "fc5", file: "apps/node-agent/src/agent.ts",
    find: "      replayDeliveries();\n", replace: "",
    run: ["apps/node-agent/test/agent-deliveries.test.ts"], expect: "after every welcome the open deliveries" },
  { id: "fc5-hook-no-kick", task: "fc5", file: "apps/node-agent/src/agent.ts",
    find: "onAppended: () => { sender.kick(); ops.deliverer.kick(\"hook\"); }", replace: "onAppended: () => { sender.kick(); }",
    run: ["apps/node-agent/test/agent-deliveries.test.ts"], expect: "kicks the deliverer when a hook arrives" },
  { id: "fc5-after-effect-skipped", task: "fc5", file: "apps/node-agent/src/ops/executor.ts",
    find: "      if (key !== undefined && out.ok) this.#d.afterEffect?.(key);\n", replace: "",
    run: ["apps/node-agent/test/delivery-hooks.test.ts"], expect: "hub:a started" },
```

Run: `node scripts/negative-controls.ts --check`. Expected: exit 0.

- [ ] **Step 28: Commit**

```bash
git add scripts/negative-controls.ts
git commit -m "test(node-agent): negative controls for the deliverer"
```

- [ ] **Step 29: Run this task's negative controls**

The runner tests HEAD, so this comes after Step 28's commit (ruling 50).

Run `node scripts/negative-controls.ts` with `--only` once for each of the twenty `fc5-…` ids above, and `--only t9-prune-not-wired` (its text changed in Step 23).

Expected: twenty-one `bit      …` lines, then `21/21 controls bit; still pass 0, broke 0, timed out 0, skipped 0`.

### Task 6: Agent: delivery ops, launcher and `lane.start`/`lane.stop`, capture and keys, inventory status and lane state events

`pane.keys` by name and the inventory's `status`, `pid`, `topic` and `lastPrompt` were built in Task 4 (Steps 1–11): Task 1 makes the first ones required (RECONCILIATION.md ruling 19), and ruling 13 adds the last two. This task does the rest.

**Files:**
- Create: `apps/node-agent/src/ops/delivery-ops.ts`, `apps/node-agent/src/lane-state.ts`
- Modify:
  - `apps/node-agent/src/config.ts` (`launch`, `protected`);
  - `apps/node-agent/src/ops/executor.ts` (`EffectContext.key`);
  - `apps/node-agent/src/ops/done-keys.ts` (`EFFECT_FIELDS`);
  - `apps/node-agent/src/ops/pane-ops.ts` (`pane.capture`);
  - `apps/node-agent/src/ops/lane-ops.ts` (replaced);
  - `apps/node-agent/src/ops/table.ts`, `apps/node-agent/src/ops/runtime.ts`;
  - `apps/node-agent/src/agent.ts` (`pane.capture` on the bulk lane, lane state events);
  - `scripts/negative-controls.ts`.
- Test:
  - created: `apps/node-agent/test/config-launch.test.ts`, `apps/node-agent/test/pane-capture.test.ts`, `apps/node-agent/test/delivery-ops.test.ts`, `apps/node-agent/test/launcher.test.ts`, `apps/node-agent/test/lane-state.test.ts`;
  - modified: `apps/node-agent/test/ops-harness.ts`, `apps/node-agent/test/lane-worktree-ops.test.ts`.

**Interfaces:**
- **Consumes:**
  - Task 1:
    - `OP_ARGS` and the `OpArgs`/`OpResult` of `lane.deliver`, `delivery.cancel`, `pane.capture`, `lane.start` (`prompt`; answers `waiting`, `prompt`) and `lane.stop` (`mode`);
    - `LIMITS.captureMaxBytes`, `captureMaxLines`, `laneStopWaitMs`, `maxDeliveryId`;
    - `"/lane"` in `HookEvent["path"]`.
  - Task 2: `menuQuestion`, `Tmux.capture` (with `join`, ruling 10), `Tmux.pasteLiteral`, `Tmux.sendKeyNames`, `inputBoxOnScreen` and `menuOnScreen`.
  - Task 5: `Deliverer.enqueue`/`cancel`/`kick`, `PaneView`, `OpsRuntime.tmux`/`deliveries`/`deliverer`/`panes`, `EventLoopOptions.onInventory`.
- **Produces:**

```ts
// config.ts (plan Contracts, Config: Policy gains launch and protected)
export type Launch = { command: string[]; via: "shell" | "direct" };
export type Policy = { /* existing */ launch: Launch; protected: string[] };   // defaults { command: ["claude"], via: "shell" }, ["manager"]
// ops/executor.ts
export type EffectContext = { ready(): OpError | null; remainingMs(): number; key?: string };   // key: a keyed op's done key
// ops/lane-ops.ts
export type LaneWaits = { pollMs: number; shellMs: number; trustMs: number; stopMs: number };
export const LANE_WAITS: LaneWaits;                       // 250 ms, 10 s, 10 s, LIMITS.laneStopWaitMs
export function launchCommand(launch: Launch, a: { account?: string; resume?: string }): string[] | { refused: string };
export function shellLine(words: readonly string[]): string;
export function trustDialogOnScreen(screen: string): boolean;
export function promptId(key: string): string;            // a first prompt's delivery id (ruling 7)
// ops/delivery-ops.ts
export function deliveryOps(d: { deliverer: () => Deliverer; panes: PaneView; policy: Policy }): Pick<OpTable, "lane.deliver" | "delivery.cancel">;
// lane-state.ts
export type LaneStateBody = { event: "needs_input" | "answered"; sessionId: string | null; question?: string };   // the "/lane" body
export class LaneStates { constructor(d: LaneStateDeps); observe(lanes: readonly Lane[]): Promise<void> }
// ops/runtime.ts: RuntimeOptions gains laneWaits?: Partial<LaneWaits> (tests; the defaults otherwise)
```

- [ ] **Step 1: Create `apps/node-agent/test/config-launch.test.ts`**

The failing test for the policy's launcher and protected names.

```ts
// The policy's launcher and protected names (fleet clients spec §5; plan Contracts, Config: Policy gains launch and
// protected): the defaults, the owner's PC's setting, and a refusal naming the file and the field for anything else.
// A typo must never widen what an op may start.
import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_POLICY, loadPolicy } from "../src/config.ts";
import { agentPaths } from "../src/paths.ts";
import { tempHome } from "./helpers.ts";

const homes: { cleanup: () => void }[] = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });
function policyFile(content: unknown): string {
  const h = tempHome();
  homes.push(h);
  const p = agentPaths(h.home);
  mkdirSync(p.configDir, { recursive: true });
  writeFileSync(p.policyFile, JSON.stringify(content));
  return p.policyFile;
}

describe("policy.json: launch and protected", () => {
  it("defaults to claude started from the shell, and the manager protected", () => {
    expect(DEFAULT_POLICY.launch).toEqual({ command: ["claude"], via: "shell" });
    expect(DEFAULT_POLICY.protected).toEqual(["manager"]);
    expect(loadPolicy(policyFile({ session: "work" }))).toMatchObject({ launch: { command: ["claude"], via: "shell" }, protected: ["manager"] });
  });

  it("takes the owner's launcher and protected names, and keeps the default for a field of launch it doesn't set", () => {
    expect(loadPolicy(policyFile({ launch: { command: ["claude-as", "{account}"], via: "shell" }, protected: ["manager", "kira"] })))
      .toMatchObject({ launch: { command: ["claude-as", "{account}"], via: "shell" }, protected: ["manager", "kira"] });
    expect(loadPolicy(policyFile({ launch: { via: "direct" } })).launch).toEqual({ command: ["claude"], via: "direct" });
    expect(loadPolicy(policyFile({ protected: [] })).protected).toEqual([]);
    expect(DEFAULT_POLICY.launch.command).toEqual(["claude"]);                  // a parse never changes the defaults
  });

  it("refuses a launcher or protected names that don't fit, naming the field (negative controls for a typo widening what an op may start)", () => {
    const cases: [unknown, RegExp][] = [
      [{ launch: "claude" }, /launch must be an object/],
      [{ launch: { cmd: ["claude"] } }, /launch has an unknown field cmd/],
      [{ launch: { command: [] } }, /launch\.command must be/],
      [{ launch: { command: "claude" } }, /launch\.command must be/],
      [{ launch: { command: ["claude", "a\nb"] } }, /launch\.command must be/],
      [{ launch: { command: ["--dangerously-skip-permissions"] } }, /launch\.command must be/],
      [{ launch: { via: "tmux" } }, /launch\.via must be "shell" or "direct"/],
      [{ protected: "manager" }, /protected must be a list of lane names/],
      [{ protected: ["a\tb"] }, /protected must be a list of lane names/],
    ];
    for (const [policy, message] of cases) {
      const file = policyFile(policy);
      expect(() => loadPolicy(file), JSON.stringify(policy)).toThrow(ConfigError);
      expect(() => loadPolicy(file), JSON.stringify(policy)).toThrow(message);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run apps/node-agent/test/config-launch.test.ts`

Expected: FAIL, 3 failed.
- `DEFAULT_POLICY.launch` is undefined.
- The owner's policy is refused: `unknown field launch, protected`.
- No refusal names `launch` or `protected`: the field itself is unknown.

- [ ] **Step 3: Replace `apps/node-agent/src/config.ts`**

```ts
// The node's configuration (spec §5.1, §8; plan Contracts: AgentConfig, Policy). config.json says who this node is in
// the fleet and which fleet it trusts (written by `morndo-node join`); policy.json says what the fleet may do here
// (the owner's to edit; written with the defaults at join). Both are JSON under ~/.config/morndo-node/. A value that
// doesn't fit is an error naming the file and the field, never a silent default: a typo in the policy must not widen
// what the fleet may do.
// Fleet clients (spec §5; plan Contracts, Config):
// - `launch` is the command a lane starts with, and how. `{account}` in it stands for the op's account. "shell" types the
//   command into the user's shell once its prompt shows; "direct" runs it as the pane's own program.
// - `protected` lists the lane names lane.stop refuses.
// An op can't add a word to the command (spec §11): only `{account}` and `--resume <session>`, both of fixed formats.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { NODE_NAME, OP_NAMES, fleetUrlOk, type OpName } from "@morndo/protocol";
import { agentPaths } from "./paths.ts";

export type Launch = { command: string[]; via: "shell" | "direct" };
export type Policy = {
  ops: OpName[];
  session: string;
  repoRoots: string[];
  fileRoots?: string[];
  lockedPanes: Record<string, string>;
  tmuxSocket: string | null;
  launch: Launch;
  protected: string[];
};
export type AgentConfig = {
  node: string; fleetUrl: string; fleetKey: string; keyPath: string; dbPath: string; relayPort: number; home: string; policy: Policy;
};

// Every op the protocol names: an op added there is on by default here, and a policy.json may list it.
export const ALL_OPS: readonly OpName[] = OP_NAMES;
export const isOpName = (s: unknown): s is OpName => typeof s === "string" && (ALL_OPS as readonly string[]).includes(s);

export const RELAY_PORT = 8787;
// Every op on (pane.keys too: the hub's terminal view needs it; spec §8 lists turning it off as the owner's mitigation),
// the tmux session "main", no repositories for worktrees until the owner names them, files under today's rules, lanes
// started as `claude` from the user's shell, and the manager protected from lane.stop.
export const DEFAULT_POLICY: Policy = {
  ops: [...ALL_OPS], session: "main", repoRoots: [], lockedPanes: {}, tmuxSocket: null,
  launch: { command: ["claude"], via: "shell" }, protected: ["manager"],
};
// The defaults as a copy that a parse may change, never DEFAULT_POLICY itself.
const defaults = (): Policy => ({
  ...DEFAULT_POLICY, ops: [...DEFAULT_POLICY.ops], repoRoots: [], lockedPanes: {},
  launch: { command: [...DEFAULT_POLICY.launch.command], via: DEFAULT_POLICY.launch.via }, protected: [...DEFAULT_POLICY.protected],
});

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigError"; }
}

type Obj = Record<string, unknown>;
const SESSION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SOCKET_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
// A launcher's word and a lane's name hold no control character (a window name may hold anything else, spec §4).
const WORD = /^[^\p{Cc}]{1,4096}$/u;
const LANE_NAME = /^[^\p{Cc}]{1,200}$/u;

function readJson(path: string): Obj {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { throw new ConfigError(`${path} is not valid JSON: ${(e as Error).message}`); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ConfigError(`${path} must hold a JSON object`);
  return value as Obj;
}

const absolutePaths = (v: unknown): v is string[] => Array.isArray(v) && v.every(p => typeof p === "string" && isAbsolute(p));

// `launch`: a field it doesn't set keeps its default. The program comes first and is never an option.
function parseLaunch(v: unknown, where: string): Launch {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`${where}: launch must be an object { command, via }`);
  const o = v as Obj;
  const unknown = Object.keys(o).filter(k => k !== "command" && k !== "via");
  if (unknown.length) throw new ConfigError(`${where}: launch has an unknown field ${unknown.join(", ")} (known: command, via)`);
  const command = o.command ?? DEFAULT_POLICY.launch.command;
  if (!Array.isArray(command) || command.length < 1 || command.length > 32 || !command.every(w => typeof w === "string" && WORD.test(w))
    || String(command[0]).startsWith("-")) {
    throw new ConfigError(`${where}: launch.command must be 1 to 32 words without control characters, the program first (not an option)`);
  }
  const via = o.via ?? DEFAULT_POLICY.launch.via;
  if (via !== "shell" && via !== "direct") throw new ConfigError(`${where}: launch.via must be "shell" or "direct"`);
  return { command: command.map(String), via };
}

export function parsePolicy(value: Obj, where: string): Policy {
  const known = ["ops", "session", "repoRoots", "fileRoots", "lockedPanes", "tmuxSocket", "launch", "protected"];
  const unknown = Object.keys(value).filter(k => !known.includes(k));
  if (unknown.length) throw new ConfigError(`${where}: unknown field ${unknown.join(", ")} (known: ${known.join(", ")})`);
  const policy: Policy = defaults();
  if (value.ops !== undefined) {
    if (!Array.isArray(value.ops) || !value.ops.every(isOpName)) throw new ConfigError(`${where}: ops must be a list of op names (${ALL_OPS.join(", ")})`);
    policy.ops = [...new Set(value.ops)];
  }
  if (value.session !== undefined) {
    if (typeof value.session !== "string" || !SESSION_NAME.test(value.session)) throw new ConfigError(`${where}: session must be a tmux session name of letters, digits, "_" or "-"`);
    policy.session = value.session;
  }
  if (value.repoRoots !== undefined) {
    if (!absolutePaths(value.repoRoots)) throw new ConfigError(`${where}: repoRoots must be a list of absolute paths`);
    policy.repoRoots = value.repoRoots;
  }
  if (value.fileRoots !== undefined) {
    if (!absolutePaths(value.fileRoots)) throw new ConfigError(`${where}: fileRoots must be a list of absolute paths`);
    policy.fileRoots = value.fileRoots;
  }
  if (value.lockedPanes !== undefined) {
    const lp = value.lockedPanes;
    if (lp === null || typeof lp !== "object" || Array.isArray(lp) || !Object.values(lp).every(p => typeof p === "string" && isAbsolute(p))) {
      throw new ConfigError(`${where}: lockedPanes must map window names to absolute lock file paths`);
    }
    policy.lockedPanes = lp as Record<string, string>;
  }
  if (value.tmuxSocket !== undefined) {
    if (value.tmuxSocket !== null && (typeof value.tmuxSocket !== "string" || !SOCKET_NAME.test(value.tmuxSocket))) {
      throw new ConfigError(`${where}: tmuxSocket must be null (the default server) or a tmux -L socket name`);
    }
    policy.tmuxSocket = value.tmuxSocket;
  }
  if (value.launch !== undefined) policy.launch = parseLaunch(value.launch, where);
  if (value.protected !== undefined) {
    if (!Array.isArray(value.protected) || !value.protected.every(n => typeof n === "string" && LANE_NAME.test(n))) {
      throw new ConfigError(`${where}: protected must be a list of lane names (window names without control characters)`);
    }
    policy.protected = [...new Set(value.protected as string[])];
  }
  return policy;
}

export function loadPolicy(path: string): Policy {
  return existsSync(path) ? parsePolicy(readJson(path), path) : defaults();
}

// The fields of config.json, as `join` writes them.
export type StoredConfig = Omit<AgentConfig, "home" | "policy">;

export function loadConfig(home: string): AgentConfig {
  const paths = agentPaths(home);
  if (!existsSync(paths.configFile)) {
    throw new ConfigError(`This machine has not joined a fleet (no ${paths.configFile}). Run: morndo-node join '<join string>'`);
  }
  const c = readJson(paths.configFile);
  const where = paths.configFile;
  if (typeof c.node !== "string" || !NODE_NAME.test(c.node)) throw new ConfigError(`${where}: node must match ${NODE_NAME}`);
  // TLS on the network: Tailscale Serve terminates it in front of the fleet, so a plain ws:// URL is only ever this
  // machine's own fleet (plan Contracts, fleetUrlOk; spec §8 "Exposure").
  if (typeof c.fleetUrl !== "string" || !fleetUrlOk(c.fleetUrl)) {
    throw new ConfigError(`${where}: fleetUrl must be wss://, or ws:// to this machine (127.0.0.1, localhost or [::1])`);
  }
  if (typeof c.fleetKey !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(c.fleetKey)) throw new ConfigError(`${where}: fleetKey must be the fleet's public key (base64)`);
  if (typeof c.keyPath !== "string" || !isAbsolute(c.keyPath)) throw new ConfigError(`${where}: keyPath must be an absolute path`);
  if (typeof c.dbPath !== "string" || !isAbsolute(c.dbPath)) throw new ConfigError(`${where}: dbPath must be an absolute path`);
  if (typeof c.relayPort !== "number" || !Number.isInteger(c.relayPort) || c.relayPort < 0 || c.relayPort > 65535) {
    throw new ConfigError(`${where}: relayPort must be a port number`);
  }
  return {
    node: c.node, fleetUrl: c.fleetUrl, fleetKey: c.fleetKey, keyPath: c.keyPath, dbPath: c.dbPath, relayPort: c.relayPort,
    home, policy: loadPolicy(paths.policyFile),
  };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run apps/node-agent/test/config-launch.test.ts apps/node-agent/test/config.test.ts`

Expected: PASS. `config-launch.test.ts` has 3 tests; `config.test.ts` passes as before (its `toEqual(DEFAULT_POLICY)` includes the new defaults).

- [ ] **Step 5: Commit**

```bash
git add apps/node-agent/src/config.ts apps/node-agent/test/config-launch.test.ts
git commit -m "feat(node-agent): the policy's launcher and protected lane names"
```

- [ ] **Step 6: Replace `apps/node-agent/test/ops-harness.ts`**

The harness gains `laneWaits`, so a test can shorten lane.start's and lane.stop's waits.

```ts
// The agent's op side on a temporary HOME and an isolated tmux server, driven through the executor as the fleet would
// drive it, without a connection. Its deliverer runs a round for each new delivery and when a test kicks it (start()
// adds the 5 s timer); close() stops it. A test that leaves rounds running awaits deliverer.drain() before close().
// laneWaits shortens lane.start's and lane.stop's waits (the shell's prompt, the trust dialog, the lane's end).
import type { PaneLock } from "@morndo/node-ops";
import type { Delivery } from "@morndo/protocol";
import { DEFAULT_POLICY, type AgentConfig, type Policy } from "../src/config.ts";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import type { Reply } from "../src/ops/executor.ts";
import type { LaneWaits } from "../src/ops/lane-ops.ts";
import type { GuardInput } from "../src/ops/pane-ops.ts";
import { createOpsRuntime, type OpsRuntime } from "../src/ops/runtime.ts";
import { agentPaths, type AgentPaths } from "../src/paths.ts";
import type { TestHooks } from "../src/test-hooks.ts";
import { captureLog } from "./helpers.ts";

export type Harness = OpsRuntime & {
  config: AgentConfig;
  paths: AgentPaths;
  adb: AgentDb;
  call(op: string, args: unknown, o?: { key?: string; timeoutMs?: number }): Promise<Reply>;
  close(): void;
};

export function opsHarness(o: { home: string; socket: string; node?: string; policy?: Partial<Policy>; guard?: (g: GuardInput) => boolean; hooks?: TestHooks;
  lock?: (path: string, waitS: number) => PaneLock; room?: () => number; emitDelivery?: (d: Delivery) => void; laneWaits?: Partial<LaneWaits> }): Harness {
  const paths = agentPaths(o.home);
  const config: AgentConfig = {
    node: o.node ?? "pc", fleetUrl: "ws://127.0.0.1:9/agent", fleetKey: "AA==", keyPath: paths.keyPath, dbPath: paths.dbPath,
    relayPort: 0, home: o.home, policy: { ...DEFAULT_POLICY, tmuxSocket: o.socket, ...o.policy },
  };
  const adb = openAgentDb(paths.dbPath);
  const runtime = createOpsRuntime({
    config, db: adb.db, log: captureLog().log, ...(o.guard ? { guard: o.guard } : {}), ...(o.hooks ? { hooks: o.hooks } : {}),
    ...(o.lock ? { lock: o.lock } : {}), ...(o.room ? { room: o.room } : {}), ...(o.emitDelivery ? { emitDelivery: o.emitDelivery } : {}),
    ...(o.laneWaits ? { laneWaits: o.laneWaits } : {}),
  });
  let n = 0;
  return {
    ...runtime, config, paths, adb,
    call: (op, args, c = {}) => runtime.executor.handle({ id: `r${++n}`, op, args, timeoutMs: c.timeoutMs ?? 10_000, ...(c.key !== undefined ? { key: c.key } : {}) }),
    close: () => { runtime.deliverer.stop(); adb.close(); },
  };
}
```

- [ ] **Step 7: Update `apps/node-agent/test/lane-worktree-ops.test.ts` for the launcher**

The default launcher is now `claude` from the shell. These tests start their stand-ins directly, so no window ever runs the account's own shell. `lane.stop`'s old behaviour is now `mode: "kill"`.

1. Replace:

```ts
import { branchNameOk } from "../src/ops/worktree-ops.ts";
```

with:

```ts
import type { Launch } from "../src/config.ts";
import { branchNameOk } from "../src/ops/worktree-ops.ts";
```

2. Replace:

```ts
const SID = "3f0c1d2e-1111-4222-8333-444455556666";
```

with:

```ts
const SID = "3f0c1d2e-1111-4222-8333-444455556666";
// The stand-in `claude` as the pane's own program (spec §5, launch.via "direct"), and no wait for a trust dialog that a
// stand-in never shows (lane-ops.ts).
const DIRECT: Launch = { command: ["claude"], via: "direct" };
const QUICK = { trustMs: 0 };
```

3. Replace:

```ts
  h = opsHarness({ home: home.home, socket: t.socket, policy: { repoRoots: [join(home.home, "code")] } });
```

with:

```ts
  h = opsHarness({ home: home.home, socket: t.socket, policy: { repoRoots: [join(home.home, "code")], launch: DIRECT }, laneWaits: QUICK });
```

4. Replace the first test of `describe("lane.start")`, from `  it("starts claude-as with the typed account and resume id in a new window, and the answer's invVersion lists it", async () => {` to its closing `  });`, with:

```ts
  it("starts claude-as with the typed account and resume id in a new window, and the answer's invVersion lists it", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "base", "sleep 600");
    // The owner's launcher (spec §5): claude-as, with the op's account in place of {account}.
    const owner = opsHarness({ home: home.home, socket: t.socket, policy: { launch: { command: ["claude-as", "{account}"], via: "direct" } }, laneWaits: QUICK });
    try {
      const name = "fix: a/b ü.2 #S";                              // "#S" would become the session name unescaped
      const r = await owner.call("lane.start", { name, cwd: work, account: "acct", resume: SID }, { key: "hub:ls1" });
      if (!r.ok) throw new Error(r.error.message);
      const workerId = (r.result as { workerId: string }).workerId;
      expect(workerId).toMatch(/^pc\.[0-9a-f]{8}\.\d+$/);
      expect(owner.inventory.last().invVersion).toBe(r.invVersion);
      expect(owner.inventory.last().panes.find(p => p.workerId === workerId)).toMatchObject({ window: name, cwd: work });
      expect(await until(() => argv("claude-as") !== null)).toBe(true);
      expect(argv("claude-as")).toEqual(["claude-as", "acct", "--resume", SID]);
    } finally {
      owner.close();
    }
  });
```

5. Replace:

```ts
    const viaLink = opsHarness({ home: linked, socket: t.socket });
```

with:

```ts
    const viaLink = opsHarness({ home: linked, socket: t.socket, policy: { launch: DIRECT }, laneWaits: QUICK });
```

6. Replace:

```ts
  it("closes the lane's window; a name it doesn't have is no_pane", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "base", "sleep 600");
    t.tmux("new-window", "-d", "-t", "=main:", "-n", "done lane", "sleep 600");
    expect(await h.call("lane.stop", { name: "done lane" }, { key: "hub:st1" })).toMatchObject({ ok: true, result: { ok: true } });
    expect(t.tmux("list-windows", "-t", "=main", "-F", "#{window_name}").trim()).toBe("base");
    expect(await h.call("lane.stop", { name: "done lane" }, { key: "hub:st2" })).toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
```

with:

```ts
  it("closes the lane's window with mode kill; a name it doesn't have is no_pane", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "base", "sleep 600");
    t.tmux("new-window", "-d", "-t", "=main:", "-n", "done lane", "sleep 600");
    expect(await h.call("lane.stop", { name: "done lane", mode: "kill" }, { key: "hub:st1" })).toMatchObject({ ok: true, result: { ok: true } });
    expect(t.tmux("list-windows", "-t", "=main", "-F", "#{window_name}").trim()).toBe("base");
    expect(await h.call("lane.stop", { name: "done lane", mode: "kill" }, { key: "hub:st2" })).toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
```

- [ ] **Step 8: Create `apps/node-agent/test/pane-capture.test.ts`**

```ts
// pane.capture (fleet clients spec §5, "Reading"): a pane's last lines, at most 2000, with tmux's attribute escapes when
// asked, in one answer of at most 256 KiB (LIMITS.captureMaxBytes, one bulk chunk); pane.captureMany keeps its 6 KiB a
// pane. Real isolated tmux, with panes that print known screens.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "@morndo/protocol";
import { isolatedTmux, tempHome, until, type TestTmux } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

let home: { home: string; cleanup: () => void };
let t: TestTmux;
let h: Harness;
beforeEach(() => {
  home = tempHome();
  t = isolatedTmux();
  h = opsHarness({ home: home.home, socket: t.socket });
  t.tmux("new-session", "-d", "-s", "main", "-n", "base", "-x", "250", "-y", "50", "sleep 600");
  t.tmux("set-option", "-g", "history-limit", "5000");             // the windows made after this keep 2000 lines and more
});
afterEach(() => { h.close(); t.kill(); home.cleanup(); });

// A lane whose pane runs `script` with sh, then stays.
async function lane(name: string, script: string): Promise<string> {
  const file = join(home.home, `${name}.sh`);
  writeFileSync(file, `${script}\nexec sleep 600\n`);
  t.tmux("new-window", "-d", "-t", "=main:", "-n", name, `sh ${file}`);
  const p = (await h.inventory.refresh()).panes.find(x => x.window === name);
  if (!p) throw new Error(`no lane ${name}`);
  return p.workerId;
}
async function capture(workerId: string, lines: number, attributes?: boolean) {
  const r = await h.call("pane.capture", { workerId, lines, ...(attributes !== undefined ? { attributes } : {}) });
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.result as { text: string | null; truncated: boolean };
}

describe("pane.capture (spec §5)", () => {
  it("returns a pane's last lines, plain or with the screen's attribute escapes, and refuses more than 2000 lines", async () => {
    const w = await lane("dim", "printf 'one\\ntwo\\n\\033[2mdim words\\033[0m\\n'");
    expect(await until(async () => (await capture(w, 50)).text?.includes("dim words") ?? false)).toBe(true);
    const plain = await capture(w, 50);
    expect(plain.truncated).toBe(false);
    expect(plain.text).toContain("one\ntwo\ndim words");
    expect(plain.text).not.toContain("\u001b[");
    expect((await capture(w, 50, true)).text).toContain("\u001b[2m");
    expect(await h.call("pane.capture", { workerId: w, lines: 2000 })).toMatchObject({ ok: true });
    for (const lines of [0, 2001]) {
      expect(await h.call("pane.capture", { workerId: w, lines }), String(lines)).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    }
  });

  it("joins a line the pane wrapped, unless asked not to (join: false; RECONCILIATION.md ruling 10)", async () => {
    const w = await lane("wrapped", `printf '%s\\n' '${"y".repeat(300)}'`);
    expect(await until(async () => (await capture(w, 10)).text?.includes("y".repeat(300)) ?? false)).toBe(true);
    const r = await h.call("pane.capture", { workerId: w, lines: 10, join: false });
    if (!r.ok) throw new Error(r.error.message);
    const text = (r.result as { text: string }).text;
    expect(text).toContain("y".repeat(250));                          // the pane is 250 columns wide
    expect(text).not.toContain("y".repeat(251));
  });

  it("keeps its answer within 256 KiB, the bottom of the pane kept and truncated said, while pane.captureMany keeps 6 KiB a pane", async () => {
    const line = (i: number) => `${String(i).padStart(4, "0")} ${"x".repeat(195)}`;
    const file = join(home.home, "screen.txt");
    writeFileSync(file, `${Array.from({ length: 2000 }, (_, i) => line(i)).join("\n")}\n`);
    const w = await lane("big", `cat '${file}'`);
    expect(await until(async () => (await capture(w, 5)).text?.includes(line(1999)) ?? false, 10_000)).toBe(true);
    const r = await h.call("pane.capture", { workerId: w, lines: 2000 });
    if (!r.ok) throw new Error(r.error.message);
    const got = r.result as { text: string; truncated: boolean };
    expect(got.truncated).toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify(got.text));
    expect(bytes).toBeLessThanOrEqual(LIMITS.captureMaxBytes);
    expect(bytes).toBeGreaterThan(LIMITS.captureMaxBytes - 1024);   // the cap is used, not a smaller one
    expect(got.text.trimEnd().endsWith(line(1999))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ v: 1, t: "res", ...r }))).toBeLessThanOrEqual(LIMITS.maxMessageBytes);
    const many = await h.call("pane.captureMany", { workerIds: [w] });
    const one = many.ok ? (many.result as { captures: { text: string | null }[] }).captures[0]?.text ?? "" : "";
    expect(Buffer.byteLength(JSON.stringify(one))).toBeLessThanOrEqual(LIMITS.captureBytesPerPane);
  }, 30_000);

  it("answers text null for a worker id that is no lane here", async () => {
    expect(await capture("pc.0a1b2c3d.999", 10)).toEqual({ text: null, truncated: false });
  });
});
```

- [ ] **Step 9: Create `apps/node-agent/test/delivery-ops.test.ts`**

```ts
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
afterEach(async () => { h.deliverer.stop(); await h.deliverer.drain(); h.close(); t.kill(); home.cleanup(); });

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
```

- [ ] **Step 10: Create `apps/node-agent/test/launcher.test.ts`**

```ts
// The launcher and lane.start/lane.stop of fleet clients (spec §5) on an isolated tmux server, with:
// - stand-ins on the server's PATH;
// - the real trust dialog's screen (Claude Code 2.1.287);
// - the agent's fake box (fake-claude.fixture.ts), which ends on /exit, and with --tasks asks "Exit and stop tasks" first;
// - a session the test writes (claude-session.ts).
// A window started from the shell gets bash without rc files (tmux's default-command), so no test reads the account's
// own shell setup.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Launch, Policy } from "../src/config.ts";
import { launchCommand, promptId, shellLine, trustDialogOnScreen, type LaneWaits } from "../src/ops/lane-ops.ts";
import { claudeSession } from "./claude-session.ts";
import { isolatedTmux, tempHome, until, type TestTmux } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const FIXTURE = join(import.meta.dirname, "fake-claude.fixture.ts");
const SCREENS = join(ROOT, "packages", "node-ops", "test", "fixtures", "claude-code-2.1.287");
const TRUST_SCREEN = join(SCREENS, "trust-dialog.ansi");
// A lane that shows the recorded trust dialog and stays. The recording ends in 29 blank lines, which would scroll the
// dialog off a 24-line pane; `$(…)` drops them.
const TRUST_LANE = ["sh", "-c", `printf '%s\\n' "$(cat '${TRUST_SCREEN}')"; exec sleep 600`];
const RESUME = "3f0c1d2e-1111-4222-8333-444455556666";
const SHELL = "bash --norc --noprofile";

let home: { home: string; cleanup: () => void };
let t: TestTmux;
let bin = "";
let argvDir = "";
let work = "";
const harnesses: Harness[] = [];
const savedPath = process.env.PATH;
const savedArgv = process.env.MORNDO_TEST_ARGV;

beforeEach(() => {
  home = tempHome();
  bin = join(home.home, "bin");
  argvDir = join(home.home, "argv");
  work = join(home.home, "work");
  for (const dir of [bin, argvDir, work]) mkdirSync(dir, { recursive: true });
  // claude-as records its arguments and stays, like a lane; claude-quick records them and ends at once.
  writeFileSync(join(bin, "claude-as"), `#!/bin/sh\nprintf '%s\\n' "$(basename "$0")" "$@" > "$MORNDO_TEST_ARGV/$(basename "$0").argv"\nexec sleep 600\n`);
  writeFileSync(join(bin, "claude-quick"), `#!/bin/sh\nprintf '%s\\n' "$(basename "$0")" "$@" > "$MORNDO_TEST_ARGV/$(basename "$0").argv"\n`);
  for (const f of ["claude-as", "claude-quick"]) chmodSync(join(bin, f), 0o755);
  // The tmux server takes its environment, the stand-ins' PATH included, when it is made: so after this.
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  process.env.MORNDO_TEST_ARGV = argvDir;
  t = isolatedTmux();
  t.tmux("new-session", "-d", "-s", "main", "-n", "base", "sleep 600");
  t.tmux("set-option", "-g", "default-command", SHELL);         // a window started without a command gets this
});
afterEach(async () => {
  for (const h of harnesses.splice(0)) { h.deliverer.stop(); await h.deliverer.drain(); h.close(); }
  t.kill();
  process.env.PATH = savedPath;
  if (savedArgv === undefined) delete process.env.MORNDO_TEST_ARGV; else process.env.MORNDO_TEST_ARGV = savedArgv;
  home.cleanup();
});

function harness(launch: Launch, waits: Partial<LaneWaits> = {}, policy: Partial<Policy> = {}): Harness {
  const h = opsHarness({ home: home.home, socket: t.socket, policy: { launch, ...policy }, laneWaits: { pollMs: 100, trustMs: 500, stopMs: 3000, ...waits } });
  harnesses.push(h);
  return h;
}
const argv = (name: string) => (existsSync(join(argvDir, `${name}.argv`)) ? readFileSync(join(argvDir, `${name}.argv`), "utf8").trim().split("\n") : null);
const paneOf = (workerId: string) => `%${workerId.replace(/^.*\./, "")}`;
const show = (...args: string[]) => t.tmux(...args).replace(/\n$/, "");
const windows = () => show("list-windows", "-t", "=main", "-F", "#{window_name}").split("\n");
const submitted = (dir: string) => (existsSync(join(dir, "submitted.jsonl"))
  ? readFileSync(join(dir, "submitted.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as string) : []);
const boxIn = (name: string) => { const dir = join(home.home, name); mkdirSync(dir, { recursive: true }); return dir; };
const showsBox = (workerId: string) => until(() => t.tmux("capture-pane", "-p", "-t", paneOf(workerId)).includes("❯"));
async function start(h: Harness, args: Record<string, unknown>, key: string) {
  const r = await h.call("lane.start", { cwd: work, ...args }, { key, timeoutMs: 30_000 });
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.result as { workerId: string; waiting?: "trust"; prompt?: string };
}

describe("the launcher's command (spec §5, §11)", () => {
  it("fills {account} wherever it stands, adds --resume, and refuses an account where it has no place or none where it needs one", () => {
    expect(launchCommand({ command: ["claude"], via: "shell" }, {})).toEqual(["claude"]);
    expect(launchCommand({ command: ["claude"], via: "shell" }, { resume: RESUME })).toEqual(["claude", "--resume", RESUME]);
    expect(launchCommand({ command: ["claude-as", "{account}"], via: "shell" }, { account: "acct", resume: RESUME })).toEqual(["claude-as", "acct", "--resume", RESUME]);
    expect(launchCommand({ command: ["run", "--profile={account}", "claude"], via: "direct" }, { account: "a2" })).toEqual(["run", "--profile=a2", "claude"]);
    expect(launchCommand({ command: ["claude"], via: "shell" }, { account: "acct" })).toEqual({ refused: expect.stringContaining("takes no account") });
    expect(launchCommand({ command: ["claude-as", "{account}"], via: "shell" }, {})).toEqual({ refused: expect.stringContaining("needs an account") });
    // A first prompt's id (ruling 7): the key's client, "prompt", 16 hex of the key's SHA-256; short whatever the key.
    expect(promptId("lanes:p1")).toBe(`lanes:prompt:${createHash("sha256").update("lanes:p1").digest("hex").slice(0, 16)}`);
    expect(promptId(`kira:${"k".repeat(500)}`)).toMatch(/^kira:prompt:[0-9a-f]{16}$/);
  });

  it("quotes a word for the shell unless it is plainly safe", () => {
    expect(shellLine(["claude-as", "acct", "--resume", RESUME])).toBe(`claude-as acct --resume ${RESUME}`);
    expect(shellLine(["sh", "-c", "echo it's $HOME; rm x"])).toBe("sh -c 'echo it'\\''s $HOME; rm x'");
    expect(shellLine(["/opt/my tools/claude"])).toBe("'/opt/my tools/claude'");
  });

  it("knows the real trust dialog (Claude Code 2.1.287), and no other screen as one", () => {
    expect(trustDialogOnScreen(readFileSync(TRUST_SCREEN, "utf8"))).toBe(true);
    for (const other of ["typed-draft", "permission-prompt", "exited-to-shell"]) {
      expect(trustDialogOnScreen(readFileSync(join(SCREENS, `${other}.ansi`), "utf8")), other).toBe(false);
    }
  });
});

describe("lane.start (spec §5)", () => {
  it("via direct: the command's words are the pane's own program, with {account} filled", async () => {
    const h = harness({ command: ["claude-as", "{account}"], via: "direct" });
    await start(h, { name: "direct", account: "acct", resume: RESUME }, "lanes:d1");
    expect(await until(() => argv("claude-as") !== null)).toBe(true);
    expect(argv("claude-as")).toEqual(["claude-as", "acct", "--resume", RESUME]);
  });

  it("via shell: the window starts with the shell, the launcher is pasted at its prompt, and the shell stays under the lane once it ends", async () => {
    const h = harness({ command: ["claude-quick", "{account}"], via: "shell" });
    const r = await start(h, { name: "shelled", account: "acct" }, "lanes:s1");
    expect(await until(() => argv("claude-quick") !== null)).toBe(true);
    expect(argv("claude-quick")).toEqual(["claude-quick", "acct"]);
    const pane = paneOf(r.workerId);
    expect(await until(() => show("display-message", "-p", "-t", pane, "#{pane_current_command}") === "bash")).toBe(true);
    expect(windows()).toContain("shelled");
    expect(t.tmux("capture-pane", "-p", "-t", pane)).toContain("claude-quick acct");
  });

  it("refuses an account the launcher has no place for, and none where it needs one: bad_args, not executed, nothing started", async () => {
    const plain = harness({ command: ["claude"], via: "direct" });
    expect(await plain.call("lane.start", { name: "x", cwd: work, account: "acct" }, { key: "lanes:a1" })).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    expect(plain.doneKeys.status("lanes:a1")).toEqual({ state: "unknown" });
    const templated = harness({ command: ["claude-as", "{account}"], via: "direct" });
    expect(await templated.call("lane.start", { name: "x", cwd: work }, { key: "lanes:a2" })).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    expect(windows()).toEqual(["base"]);
  });

  it("answers waiting: trust when Claude Code's folder-trust dialog shows, and nothing when its box does", async () => {
    const untrusted = harness({ command: TRUST_LANE, via: "direct" }, { trustMs: 5000 });
    expect(await start(untrusted, { name: "untrusted" }, "lanes:t1")).toMatchObject({ waiting: "trust" });
    const trusted = harness({ command: [process.execPath, FIXTURE, boxIn("trusted")], via: "direct" }, { trustMs: 5000 });
    expect(await start(trusted, { name: "trusted" }, "lanes:t2")).not.toHaveProperty("waiting");
  });

  it("queues a first prompt as a delivery to the new pane: it waits for Claude Code, and is typed once the lane can take it", async () => {
    const dir = boxIn("prompted");
    const h = harness({ command: [process.execPath, FIXTURE, dir], via: "direct" });
    const r = await start(h, { name: "prompted", prompt: "Build the login page" }, "lanes:p1");
    const id = promptId("lanes:p1");
    expect(r.prompt).toBe(id);
    expect(h.deliveries.get(id)).toMatchObject({ target: { workerId: r.workerId }, state: "queued" });
    expect(await showsBox(r.workerId)).toBe(true);
    const kick = async () => { await h.inventory.refresh(); h.deliverer.kick("status"); await h.deliverer.drain(); };
    // No Claude Code session in the pane yet: the prompt waits (no_session), within its pane process's grace (ruling 14).
    expect(await until(async () => { await kick(); return h.deliveries.get(id)?.waiting?.reason === "no_session"; })).toBe(true);
    expect(submitted(dir)).toEqual([]);
    claudeSession({ tmux: t, claudeDir: join(home.home, ".claude"), pane: paneOf(r.workerId) }).status("idle");
    expect(await until(async () => { await kick(); return submitted(dir).length > 0; })).toBe(true);
    expect(submitted(dir)).toEqual(["Build the login page"]);
    expect(h.deliveries.get(id)?.state).toBe("typed");
  });
});

describe("lane.stop (spec §5)", () => {
  it("refuses a protected name in either mode (denied, not executed, the key freed)", async () => {
    const h = harness({ command: ["claude"], via: "direct" });
    t.tmux("new-window", "-d", "-t", "=main:", "-n", "manager", SHELL);
    expect(await h.call("lane.stop", { name: "manager" }, { key: "lanes:x1" })).toMatchObject({ ok: false, error: { code: "denied", executed: "no" } });
    expect(await h.call("lane.stop", { name: "manager", mode: "kill" }, { key: "lanes:x2" })).toMatchObject({ ok: false, error: { code: "denied", executed: "no" } });
    expect(h.doneKeys.status("lanes:x1")).toEqual({ state: "unknown" });
    expect(windows()).toContain("manager");
  });

  it("mode exit types /exit, answers Claude Code's 'Exit and stop tasks' with 1, and answers once the window has closed", async () => {
    const dir = boxIn("tasks");
    const h = harness({ command: [process.execPath, FIXTURE, dir, "--tasks"], via: "direct" });
    const r = await start(h, { name: "with-tasks" }, "lanes:e1");
    expect(await showsBox(r.workerId)).toBe(true);
    expect(await h.call("lane.stop", { name: "with-tasks" }, { key: "lanes:e2", timeoutMs: 30_000 })).toMatchObject({ ok: true, result: { ok: true } });
    expect(windows()).not.toContain("with-tasks");
    expect(submitted(dir)).toEqual(["/exit"]);
  });

  it("mode exit on a lane started from the shell answers once the pane is back at its shell, and the window stays", async () => {
    const dir = boxIn("plain");
    const h = harness({ command: [process.execPath, FIXTURE, dir], via: "shell" }, { shellMs: 5000 });
    const r = await start(h, { name: "shell-lane" }, "lanes:e3");
    expect(await showsBox(r.workerId)).toBe(true);
    expect(await h.call("lane.stop", { name: "shell-lane" }, { key: "lanes:e4", timeoutMs: 30_000 })).toMatchObject({ ok: true, result: { ok: true } });
    expect(windows()).toContain("shell-lane");
    expect(show("display-message", "-p", "-t", paneOf(r.workerId), "#{pane_current_command}")).toBe("bash");
    expect(submitted(dir)).toEqual(["/exit"]);
  });

  it("mode exit never types into a menu (menu_open, not executed), and is uncertain when the lane neither closes nor reaches its shell in time", async () => {
    const inMenu = harness({ command: TRUST_LANE, via: "direct" });
    const m = await start(inMenu, { name: "in-menu" }, "lanes:m1");
    expect(await until(() => t.tmux("capture-pane", "-p", "-t", paneOf(m.workerId)).includes("trust this folder"))).toBe(true);
    expect(await inMenu.call("lane.stop", { name: "in-menu" }, { key: "lanes:m2" })).toMatchObject({ ok: false, error: { code: "menu_open", executed: "no" } });
    expect(inMenu.doneKeys.status("lanes:m2")).toEqual({ state: "unknown" });
    const dir = boxIn("stays");
    const stays = harness({ command: [process.execPath, FIXTURE, dir, "--stay"], via: "direct" });
    const r = await start(stays, { name: "stays" }, "lanes:m3");
    expect(await showsBox(r.workerId)).toBe(true);
    expect(await stays.call("lane.stop", { name: "stays" }, { key: "lanes:m4", timeoutMs: 30_000 })).toMatchObject({ ok: false, error: { code: "uncertain", executed: "maybe" } });
    expect(stays.doneKeys.status("lanes:m4")).toEqual({ state: "started" });
    expect(submitted(dir)).toEqual(["/exit"]);
    expect(windows()).toContain("stays");
  });

  it("mode exit counts a lane with a live Claude Code session as running, whatever its status says (ruling 11)", async () => {
    const h = harness({ command: ["claude"], via: "direct" });
    const pane = t.tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "=main:", "-n", "running", "sleep 600").trim();
    claudeSession({ tmux: t, claudeDir: join(home.home, ".claude"), pane }).status("shell");   // running a shell command
    expect(await h.call("lane.stop", { name: "running" }, { key: "lanes:b2" })).toMatchObject({ ok: false, error: { code: "no_input_box", executed: "no" } });
    expect(windows()).toContain("running");
  });

  it("mode exit on a pane already at its shell answers at once and types nothing", async () => {
    const h = harness({ command: ["claude"], via: "direct" });
    const pane = t.tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "=main:", "-n", "bare", SHELL).trim();
    expect(await until(() => t.tmux("capture-pane", "-p", "-t", pane).includes("$"))).toBe(true);
    expect(await h.call("lane.stop", { name: "bare" }, { key: "lanes:b1" })).toMatchObject({ ok: true, result: { ok: true } });
    expect(windows()).toContain("bare");
    expect(t.tmux("capture-pane", "-p", "-t", pane)).not.toContain("/exit");
  });
});
```

- [ ] **Step 11: Run them and watch them fail**

Run: `npx vitest run apps/node-agent/test/pane-capture.test.ts apps/node-agent/test/delivery-ops.test.ts apps/node-agent/test/launcher.test.ts apps/node-agent/test/lane-worktree-ops.test.ts`

Expected: FAIL.
- `pane-capture.test.ts` and `delivery-ops.test.ts`: the ops answer `unknown_op` ("this node has no pane.capture", "this node has no lane.deliver").
- `launcher.test.ts`: the file fails to load, since `launchCommand`, `shellLine` and `trustDialogOnScreen` aren't exported yet. If the runner loads it anyway, the lane.start and lane.stop tests fail on today's ops (no launcher, no prompt, and lane.stop always kills), except "via direct: the command's words are the pane's own program", which today's lane.start already passes.
- `lane-worktree-ops.test.ts` still passes. Today's lane.start ignores the policy's launcher (it runs `claude-as` whenever an account is given), and today's lane.stop drops the unknown `mode` and kills. The file is a regression guard: it must stay green through Step 20.

- [ ] **Step 12: Give a keyed op its key in `apps/node-agent/src/ops/executor.ts`**

1. Replace:

```ts
export type EffectContext = { ready(): OpError | null; remainingMs(): number };
```

with:

```ts
// `key`: the op's done key, for a keyed op. lane.start makes its first prompt's delivery id from it (promptId,
// RECONCILIATION.md ruling 7), and lane.stop types /exit under `<key>:exit` (fleet clients spec §5).
export type EffectContext = { ready(): OpError | null; remainingMs(): number; key?: string };
```

2. Replace:

```ts
      const ctx: EffectContext = {
        ready: () => (deadline.expired() ? fail("timeout", "the deadline passed before the side effect").error : null),
        remainingMs: () => deadline.remainingMs(),
      };
```

with:

```ts
      const ctx: EffectContext = {
        ready: () => (deadline.expired() ? fail("timeout", "the deadline passed before the side effect").error : null),
        remainingMs: () => deadline.remainingMs(),
        ...(key !== undefined ? { key } : {}),
      };
```

- [ ] **Step 13: Add the new fields to `EFFECT_FIELDS` in `apps/node-agent/src/ops/done-keys.ts`**

Replace:

```ts
  "lane.start": ["name", "cwd", "account", "resume"],
  "lane.stop": ["name"],
```

with:

```ts
  "lane.start": ["name", "cwd", "account", "resume", "prompt"],
  "lane.stop": ["name", "mode"],
```

An op without the new fields hashes as before: `stableJson` leaves out undefined fields.

- [ ] **Step 14: Create `apps/node-agent/src/ops/delivery-ops.ts`**

```ts
// lane.deliver and delivery.cancel (fleet clients spec §4.1–4.3; plan Contracts): the fleet's ops onto this node's
// deliverer.
// - lane.deliver reads the inventory within its poll interval (a lane started a moment ago is known), then the deliverer
//   validates, binds and stores the delivery, synced, before the answer goes out: `queued` is a promise the sender may
//   stop retrying on.
// - Its id is its idempotency, so it carries no key (not in KEYED_OPS); its typing runs under that id as a done key inside
//   the agent.
// - Deliveries are typed through pane.send, so a node whose policy doesn't allow pane.send refuses lane.deliver (`denied`)
//   rather than queue what it would never type.
// - Both run one at a time per delivery id: a repeat waits for the first to be stored, and answers what was stored.
import type { Policy } from "../config.ts";
import type { Deliverer, PaneView } from "../deliveries/deliverer.ts";
import { effect, fail, ok, type OpTable } from "./executor.ts";

export function deliveryOps(d: { deliverer: () => Deliverer; panes: PaneView; policy: Policy }): Pick<OpTable, "lane.deliver" | "delivery.cancel"> {
  return {
    "lane.deliver": effect(a => `delivery:${a.id}`, async (a, ctx) => {
      if (!d.policy.ops.includes("pane.send")) return fail("denied", "deliveries are typed through pane.send, which this node's policy does not allow");
      await d.panes.refresh();
      const late = ctx.ready();
      if (late) return { ok: false, error: late };
      const r = d.deliverer().enqueue(a);
      return "code" in r ? { ok: false, error: r } : ok<"lane.deliver">(r);
    }),
    "delivery.cancel": effect(a => `delivery:${a.id}`, async a => {
      const r = d.deliverer().cancel(a.id);
      return "code" in r ? { ok: false, error: r } : ok<"delivery.cancel">(r);
    }),
  };
}
```

- [ ] **Step 15: Add `pane.capture` to `apps/node-agent/src/ops/pane-ops.ts`**

1. Replace:

```ts
// `problem` is null or not_submitted (typed, but no submit seen).
```

with:

```ts
// `problem` is null or not_submitted (typed, but no submit seen).
// pane.capture (fleet clients spec §5, "Reading") is a read: one pane's last lines, at most 2000 (args.ts), with tmux's
// attribute escapes when asked and wrapped lines joined unless `join` is false (RECONCILIATION.md ruling 10), in an
// answer of at most 256 KiB measured as it travels (LIMITS.captureMaxBytes, one bulk chunk; agent.ts sends it on the bulk
// lane). pane.captureMany keeps its 6 KiB a pane.
```

2. Replace:

```ts
export function paneOps(d: PaneDeps): Pick<OpTable, "pane.captureMany" | "pane.frame" | "pane.keys" | "pane.send"> {
```

with:

```ts
export function paneOps(d: PaneDeps): Pick<OpTable, "pane.captureMany" | "pane.capture" | "pane.frame" | "pane.keys" | "pane.send"> {
```

3. Replace:

```ts
      return ok<"pane.captureMany">({ captures });
    }),
```

with:

```ts
      return ok<"pane.captureMany">({ captures });
    }),

    "pane.capture": read(async a => {
      let snap = await d.inventory.current(LIMITS.inventoryPollMs);
      if (!snap.lanes.some(l => l.workerId === a.workerId)) snap = await d.inventory.refresh();
      const lane = snap.lanes.find(l => l.workerId === a.workerId);
      const text = lane ? await d.tmux.capture(lane.pane, { lines: a.lines, attributes: a.attributes === true, join: a.join !== false }) : null;
      if (text === null) return ok<"pane.capture">({ text: null, truncated: false });
      return ok<"pane.capture">(capCapture(text, LIMITS.captureMaxBytes));
    }),
```

- [ ] **Step 16: Replace `apps/node-agent/src/ops/lane-ops.ts`**

```ts
// lane.start and lane.stop (fleet core §4 "Lane names", §5.3, §8; fleet clients spec §5): typed fields only, never free
// flags or a shell line from the op. A lane is a tmux window in the policy's session, and its name is unique on this node.
// - The launcher is the node owner's setting (policy.launch). `{account}` in its words is the op's account, and `resume`
//   adds `--resume <session>`; an op can add nothing else (spec §11). A command without `{account}` refuses an op that
//   names one (bad_args); a command with it refuses an op that names none.
// - via "direct": tmux runs the command's words as the pane's program, without `sh -c` (tmux(1) new-window: "shell-command
//   given as multiple arguments and executed directly", read 2026-10-06).
// - via "shell": the window starts with no command, so tmux starts the user's shell (tmux(1) default-command: "The default
//   is an empty string, which instructs tmux to create a login shell using the value of the default-shell option",
//   https://man7.org/linux/man-pages/man1/tmux.1.html, read 2026-10-08). Once its screen has settled (its prompt drawn, as
//   `lanes start` waits) or 10 s have passed (a shell reads what was typed once it is ready), the command is pasted as one
//   literal line (Task 2's pasteLiteral: load-buffer, then paste-buffer -p, which brackets the paste only "if the
//   application has requested bracketed paste mode", tmux 3.6a's tmux(1)), and Enter is pressed. The window outlives
//   Claude Code, and claude-pool can move the lane. pane.send can't type it: at a shell it refuses no_input_box, which is
//   right for everyone else (spec §5). Each word is single-quoted for the shell unless it is plainly safe.
// - Folder trust: after starting, the agent looks at the new pane for Claude Code's trust dialog until Claude Code shows
//   its box, for up to 10 s. Seen, the answer carries `waiting: "trust"`; accepting it stays the client's
//   decision (spec §5). Its words are pinned by the real 2.1.287 screen
//   (packages/node-ops/test/fixtures/claude-code-2.1.287/trust-dialog.ansi).
// - A first prompt becomes a delivery to the new pane (spec §5), with the id `<client>:prompt:<first 16 hex of SHA-256 of
//   the start's key>` (RECONCILIATION.md ruling 7; always within 200 characters). The pane's process has just started, so it
//   is in the deliverer's 2-minute grace (ruling 14): the delivery waits for Claude Code (no_session) and is typed once
//   the lane can take it.
// - tmux expands formats in -n and -c, so the name and the directory go through tmuxLiteral, and the session through
//   exactSession. The window to stop is targeted by its ID (@N) from the inventory, never by its name.
// - lane.stop refuses the policy's protected names (`denied`). mode "kill" closes the window. mode "exit" (the default):
//   - types `/exit` through pane.send under `<key>:exit`, with every check a delivery has (never into a menu or over a
//     draft);
//   - answers Claude Code's "Exit and stop tasks" prompt with 1, as claude-pool does (its real screen is still to be
//     recorded, RECONCILIATION.md ruling 19);
//   - answers once the window has closed or the pane is back at its shell, or `uncertain` after 30 s
//     (LIMITS.laneStopWaitMs).
//   A pane already at its shell (no live Claude Code session there, whatever a session's `status` said: ruling 11; no box
//   and no menu on its screen) is answered at once.
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { LIMITS, formatWorkerId, parseWorkerId, type OpArgs, type OpError, type OpResult } from "@morndo/protocol";
import { deniedBy, denyRoots, exactSession, inputBoxOnScreen, menuOnScreen, resolvedRoots, tmuxLiteral, type Tmux } from "@morndo/node-ops";
import type { Launch, Policy } from "../config.ts";
import { effect, fail, ok, type EffectContext, type OpTable, type Outcome, type Reply, type Request } from "./executor.ts";
import type { Inventory, Lane } from "./inventory.ts";
import { tmuxRun } from "./tmux-panes.ts";

// How long lane.start and lane.stop wait, each also bounded by the op's own deadline. Tests shorten them.
export type LaneWaits = { pollMs: number; shellMs: number; trustMs: number; stopMs: number };
export const LANE_WAITS: LaneWaits = { pollMs: 250, shellMs: 10_000, trustMs: 10_000, stopMs: LIMITS.laneStopWaitMs };

export type LaneDeps = {
  node: string;
  policy: Policy;
  inventory: Inventory;
  home: string;
  stateDir: string;
  stamp: (socket: string | null) => Promise<string | null>;
  tmux: Pick<Tmux, "capture" | "pasteLiteral" | "sendKeyNames">;
  send: (req: Request) => Promise<Reply>;                                          // the agent's executor (pane.send, pane.keys)
  deliver: (a: OpArgs["lane.deliver"]) => OpResult["lane.deliver"] | OpError;    // the deliverer's enqueue
  waits?: Partial<LaneWaits>;
};

const TRUST = /Yes, I trust this folder|Do you trust the files in this folder/;
export const trustDialogOnScreen = (screen: string): boolean => TRUST.test(screen);
const EXIT_PROMPT = /Exit and stop tasks/;
const SAFE_WORD = /^[A-Za-z0-9_./:@+=,-]+$/;

export function launchCommand(launch: Launch, a: { account?: string; resume?: string }): string[] | { refused: string } {
  const templated = launch.command.some(w => w.includes("{account}"));
  if (a.account !== undefined && !templated) return { refused: "this node's launcher takes no account (its command has no {account})" };
  if (a.account === undefined && templated) return { refused: "this node's launcher needs an account (its command has {account})" };
  const account = a.account;
  const words = account === undefined ? [...launch.command] : launch.command.map(w => w.replaceAll("{account}", account));
  return a.resume === undefined ? words : [...words, "--resume", a.resume];
}

// The command as one line for a POSIX shell: a plainly safe word as it is, any other single-quoted.
export function shellLine(words: readonly string[]): string {
  return words.map(w => (SAFE_WORD.test(w) ? w : `'${w.replaceAll("'", "'\\''")}'`)).join(" ");
}

// A first prompt's delivery id (ruling 7): the start's client (its key's namespace), "prompt", and the first 16 hex digits
// of the SHA-256 of the start's key. Within 200 characters whatever the key, and never ending in "#<digits>".
export function promptId(key: string): string {
  const client = /^[a-z]{1,16}:/.exec(key)?.[0] ?? "lane:";
  return `${client}prompt:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function realDir(p: string): string | null {
  try {
    const real = realpathSync(p);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

// A wait's length: its own limit, and never past the op's deadline less what must still follow it.
const within = (ctx: EffectContext, ms: number, reserve: number): number => Math.max(0, Math.min(ms, ctx.remainingMs() - reserve));

export function laneOps(d: LaneDeps): Pick<OpTable, "lane.start" | "lane.stop"> {
  const socket = d.policy.tmuxSocket;
  const session = d.policy.session;
  const w: LaneWaits = { ...LANE_WAITS, ...d.waits };
  // The cwd is judged resolved (realDir), so the deny roots are too, at each start: under a HOME that is a symbolic
  // link, "~/.ssh" as given never prefixes the real path of a directory in it (final review M10).
  const deny = () => resolvedRoots(denyRoots(d.home, d.stateDir));
  const sessionExists = async () => {
    try { await tmuxRun(socket, ["has-session", "-t", exactSession(session)]); return true; }
    catch { return false; }
  };
  const screen = (pane: string) => d.tmux.capture(pane, { lines: 50, attributes: false });
  // Only what the pane shows now (capture-pane without -S: "The default is to capture only the visible contents of the
  // pane", tmux(1) 3.6a). A box cleared away at /exit can sit in the history just above the shell's prompt: tmux's
  // scroll-on-clear, on by default, scrolls "the contents of the screen into history before clearing it".
  const visible = async (pane: string): Promise<string | null> => {
    try { return await tmuxRun(socket, ["capture-pane", "-p", "-t", pane]); } catch { return null; }
  };

  // A new shell has drawn its prompt once its screen holds something and stays the same for one poll (rc files done).
  async function settled(pane: string, ms: number): Promise<boolean> {
    const end = performance.now() + ms;
    let last: string | null = null;
    while (performance.now() < end) {
      const shown = await screen(pane);
      if (shown !== null && shown.trim() !== "" && shown === last) return true;
      last = shown;
      await sleep(w.pollMs);
    }
    return false;
  }

  // The trust dialog on the new pane, looked for until Claude Code shows its box, or the time is up. A session file proves
  // nothing here: Claude Code may write one while its dialog still shows.
  async function sawTrust(pane: string, ms: number): Promise<boolean> {
    const end = performance.now() + ms;
    for (;;) {
      const shown = await screen(pane);
      if (shown !== null && trustDialogOnScreen(shown)) return true;
      if (shown === null || inputBoxOnScreen(shown)) return false;
      if (performance.now() >= end) return false;
      await sleep(w.pollMs);
    }
  }

  // Where a lane stands after /exit: its window closed ("gone"); back at its shell (no live Claude Code session there,
  // whatever a status said: ruling 11; no box and no menu on its screen: true); or still in Claude Code (false).
  async function standing(windowId: string): Promise<"gone" | boolean> {
    const snap = await d.inventory.refresh();
    const lane = snap.lanes.find(l => l.windowId === windowId);
    if (!lane) return snap.rows.some(r => r.windowId === windowId) ? false : "gone";
    if (lane.sessionId !== null) return false;
    const shown = await visible(lane.pane);
    return shown !== null && !inputBoxOnScreen(shown) && !menuOnScreen(shown);
  }

  async function exit(lane: Lane, ctx: EffectContext): Promise<Outcome<"lane.stop">> {
    if ((await standing(lane.windowId)) !== false) return ok<"lane.stop">({ ok: true });   // closed, or no Claude Code there
    const ref = parseWorkerId(lane.workerId);
    if (ref === null || ctx.key === undefined) return fail("internal", "lane.stop could not name the pane to type /exit into");
    const expect = { server: ref.server, window: lane.window };
    const typed = await d.send({
      id: "lane-stop-exit", op: "pane.send", args: { workerId: lane.workerId, text: "/exit", expect },
      timeoutMs: Math.max(1000, Math.floor(ctx.remainingMs())), key: `${ctx.key}:exit`,
    });
    if (!typed.ok && typed.error.executed === "no") return { ok: false, error: typed.error };
    const end = performance.now() + within(ctx, w.stopMs, 250);
    let answered = false;
    while (performance.now() < end) {
      await sleep(w.pollMs);
      if ((await standing(lane.windowId)) !== false) return ok<"lane.stop">({ ok: true });
      if (answered) continue;
      const shown = await screen(lane.pane);
      if (shown === null || !EXIT_PROMPT.test(shown)) continue;
      const r = await d.send({ id: "lane-stop-answer", op: "pane.keys", args: { workerId: lane.workerId, names: ["1"], expect }, timeoutMs: 5000 });
      answered = r.ok && (r.result as OpResult["pane.keys"]).ok;
    }
    return fail("uncertain", "after /exit the lane neither closed nor came back to its shell in time");
  }

  return {
    "lane.start": effect(a => `lane:${a.name}`, async (a, ctx) => {
      const cwd = realDir(a.cwd);
      if (!cwd) return fail("bad_args", "cwd is not a directory on this node");
      if (deniedBy(cwd, deny())) return fail("denied", "lanes may not start in that directory");
      const command = launchCommand(d.policy.launch, a);
      if (!Array.isArray(command)) return fail("bad_args", command.refused);
      const firstPrompt = ctx.key === undefined ? undefined : promptId(ctx.key);
      if (a.prompt !== undefined && firstPrompt === undefined) return fail("bad_args", "lane.start needs its key to queue a first prompt");
      const snap = await d.inventory.refresh();
      if (snap.rows.some(r => r.window === a.name)) return fail("name_taken", "a window of that name already exists on this node");
      const late = ctx.ready();
      if (late) return { ok: false, error: late };
      const shell = d.policy.launch.via === "shell";
      const where = (await sessionExists()) ? ["new-window", "-d", "-t", `${exactSession(session)}:`] : ["new-session", "-d", "-s", tmuxLiteral(session)];
      const out = await tmuxRun(socket, [...where, "-n", tmuxLiteral(a.name), "-c", tmuxLiteral(cwd), "-P", "-F", "#{pane_id}", ...(shell ? [] : command)]);
      const m = /^%(\d{1,9})$/.exec(out.trim());
      if (!m) return fail("internal", "tmux did not report the new pane");
      const pane = `%${m[1]}`;
      const stamp = await d.stamp(socket);
      if (!stamp) return fail("internal", "the tmux server could not be stamped");
      const workerId = formatWorkerId({ node: d.node, server: stamp, pane: Number(m[1]) });
      if (shell) {
        await settled(pane, within(ctx, w.shellMs, 4000));
        await d.tmux.pasteLiteral(pane, shellLine(command));
        await d.tmux.sendKeyNames(pane, ["Enter"]);
      }
      await d.inventory.refresh();                           // so this answer's invVersion already lists the new lane
      let prompt: string | undefined;
      if (a.prompt !== undefined && firstPrompt !== undefined) {
        const r = d.deliver({ id: firstPrompt, target: { workerId }, text: a.prompt });
        if ("code" in r) return fail("internal", `the lane started, but its first prompt was not queued (${r.code}: ${r.message})`);
        prompt = r.delivery.id;
      }
      const trust = await sawTrust(pane, within(ctx, w.trustMs, 1000));
      return ok<"lane.start">({ workerId, ...(trust ? { waiting: "trust" as const } : {}), ...(prompt !== undefined ? { prompt } : {}) });
    }),

    "lane.stop": effect(a => `lane:${a.name}`, async (a, ctx) => {
      if (d.policy.protected.includes(a.name)) return fail("denied", "this node's policy protects that lane from lane.stop");
      const snap = await d.inventory.refresh();
      const lanes = snap.lanes.filter(l => l.window === a.name);
      const windows = [...new Set(lanes.map(l => l.windowId))];
      if (windows.length === 0) return fail("no_pane", "no lane of that name on this node");
      if (windows.length > 1) return fail("bad_args", "two windows on this node have that name; stop one in tmux");
      const late = ctx.ready();
      if (late) return { ok: false, error: late };
      if (a.mode === "kill") {
        await tmuxRun(socket, ["kill-window", "-t", windows[0] as string]);
        await d.inventory.refresh();
        return ok<"lane.stop">({ ok: true });
      }
      return exit(lanes[0] as Lane, ctx);
    }),
  };
}
```

- [ ] **Step 17: Replace `apps/node-agent/src/ops/table.ts`**

```ts
// Every op of the protocol (plan Contracts: OpName), wired to this node's tmux, Claude Code files, disk and database.
// Fleet clients:
// - lane.deliver and delivery.cancel go to the deliverer;
// - pane.capture and pane.keys by name use the policy's tmux server;
// - lane.start and lane.stop use the policy's launcher and protected names; they type /exit through the executor, and
//   queue a first prompt with the deliverer.
// The deliverer and the executor are made from this table, so it reaches them late (runtime.ts), by the time an op runs.
import { join } from "node:path";
import type Database from "better-sqlite3";
import { paneLock, sessionRegistry, stampServer, terminalAdapter, type PaneLock, type Tmux } from "@morndo/node-ops";
import type { AgentConfig } from "../config.ts";
import type { Deliverer, PaneView } from "../deliveries/deliverer.ts";
import type { AgentPaths } from "../paths.ts";
import { deliveryOps } from "./delivery-ops.ts";
import type { DoneKeys } from "./done-keys.ts";
import { ok, read, type OpTable, type Reply, type Request } from "./executor.ts";
import { fileOps } from "./file-ops.ts";
import type { Inventory } from "./inventory.ts";
import { laneOps, type LaneWaits } from "./lane-ops.ts";
import { nodeOpener, relayRef } from "./node-files.ts";
import { paneOps, type GuardInput } from "./pane-ops.ts";
import { transcriptOps } from "./transcript-ops.ts";
import type { UploadInbox } from "./upload-inbox.ts";
import { worktreeOps } from "./worktree-ops.ts";

export type OpsDeps = {
  config: AgentConfig;
  paths: AgentPaths;
  db: Database.Database;
  doneKeys: DoneKeys;
  inventory: Inventory;
  inbox: UploadInbox;
  registry: ReturnType<typeof sessionRegistry>;
  now: () => number;
  guard?: (g: GuardInput) => boolean;
  lock?: (path: string, waitS: number) => PaneLock;
  tmux: Tmux;                                              // the policy's tmux server
  panes: PaneView;                                         // the deliverer's view (lane.deliver reads it first)
  deliverer: () => Deliverer;                              // late: made from the executor this table goes into
  send: (req: Request) => Promise<Reply>;                  // late: that executor (lane.stop's /exit and its answer)
  laneWaits?: Partial<LaneWaits>;
};

export function claudeDir(home: string): string { return join(home, ".claude"); }

export function buildOps(d: OpsDeps): OpTable {
  const { config, paths } = d;
  const policy = config.policy;
  return {
    "inventory.get": read(async () => {
      const s = await d.inventory.refresh();
      return ok<"inventory.get">({ panes: s.panes, invVersion: s.invVersion });
    }),
    "op.status": read(async a => ok<"op.status">(d.doneKeys.status(a.key))),
    ...paneOps({
      node: config.node, policy, inventory: d.inventory, tmux: d.tmux,
      terminal: terminalAdapter({ socket: policy.tmuxSocket }),
      sessions: () => d.registry.byPane(),
      lock: d.lock ?? ((path, waitS) => paneLock(path, waitS)),
      now: d.now,
      ...(d.guard ? { guard: d.guard } : {}),
    }),
    ...transcriptOps({ transcriptPath: sid => d.registry.transcriptPath(sid) }),
    ...fileOps({
      open: nodeOpener({ home: config.home, stateDir: paths.stateDir, configDir: paths.configDir, inboxDir: paths.inboxDir, ...(policy.fileRoots ? { fileRoots: policy.fileRoots } : {}) }),
      relayRef: relayRef(d.db),
      inbox: d.inbox,
    }),
    ...laneOps({
      node: config.node, policy, inventory: d.inventory, home: config.home, stateDir: paths.stateDir, stamp: stampServer,
      tmux: d.tmux, send: d.send, deliver: a => d.deliverer().enqueue(a),
      ...(d.laneWaits ? { waits: d.laneWaits } : {}),
    }),
    ...worktreeOps({ repoRoots: policy.repoRoots, home: config.home, stateDir: paths.stateDir }),
    ...deliveryOps({ deliverer: d.deliverer, panes: d.panes, policy }),
  };
}
```

- [ ] **Step 18: Replace `apps/node-agent/src/ops/runtime.ts`**

```ts
// The op side of the agent, assembled: inventory, done keys, upload inbox, session registry and the executor over
// every op, and the wall clock the node reports. agent.ts runs it behind the fleet connection; the tests drive the
// executor directly. Test hooks act here (test-hooks.ts): noDoneKeys, noExpect, clockOffsetMs, and for the delivery
// drills killAfterEffect (the executor's afterEffect), noSessionBinding, retypeUnderFirstKey and deliveryStartGraceMs.
// Fleet clients (spec §4, §5):
// - the delivery queue: its store in agent.db, and the deliverer typing through this executor;
// - the policy's tmux server, for the deliverer's box checks, pane.capture, pane.keys by name and the launcher;
// - the deliverer's view of the lanes, with each pane process's start for the 2-minute grace (RECONCILIATION.md ruling 14);
// - each session's topic and last prompt, for the inventory (ruling 13).
// The ops and the deliverer need each other: lane.deliver and lane.start enqueue, and the deliverer and lane.stop type
// through the executor. So the table reaches both late, through closures over the two made just below it, by the time an
// op runs.
import type Database from "better-sqlite3";
import { sessionRegistry, stampServer, tmuxAdapter, type PaneLock, type Tmux } from "@morndo/node-ops";
import type { Delivery } from "@morndo/protocol";
import type { AgentConfig } from "../config.ts";
import { Deliverer, type PaneView } from "../deliveries/deliverer.ts";
import { DeliveryStore } from "../deliveries/store.ts";
import { agentPaneView, agentTranscripts } from "../deliveries/views.ts";
import type { Logger } from "../log.ts";
import { agentPaths } from "../paths.ts";
import { killOnce, wallClock, type TestHooks } from "../test-hooks.ts";
import { DoneKeys } from "./done-keys.ts";
import { OpExecutor } from "./executor.ts";
import { Inventory } from "./inventory.ts";
import type { LaneWaits } from "./lane-ops.ts";
import type { GuardInput } from "./pane-ops.ts";
import { buildOps, claudeDir } from "./table.ts";
import { TranscriptTitles } from "./transcript-titles.ts";
import { UploadInbox } from "./upload-inbox.ts";

export type OpsRuntime = {
  inventory: Inventory;
  doneKeys: DoneKeys;
  inbox: UploadInbox;
  registry: ReturnType<typeof sessionRegistry>;
  executor: OpExecutor;
  now: () => number;                                      // the wall clock the node reports (clockOffsetMs included)
  tmux: Tmux;                                             // the policy's tmux server
  deliveries: DeliveryStore;
  deliverer: Deliverer;
  panes: PaneView;                                        // the deliverer's view of the lanes
};

export type RuntimeOptions = {
  config: AgentConfig;
  db: Database.Database;
  log: Logger;
  guard?: (g: GuardInput) => boolean;                     // a test replaces the expectation check to show what it prevents
  hooks?: TestHooks;
  afterStarted?: (key: string) => boolean;                // the executor's hook after a committed `started` (agent.ts)
  lock?: (path: string, waitS: number) => PaneLock;       // a test's slow lock; node-ops' paneLock otherwise
  room?: () => number;                                    // bytes still free in the node's disk budget (agent.ts)
  emitDelivery?: (d: Delivery) => void;                   // each change of a delivery (agent.ts: ev.delivery)
  laneWaits?: Partial<LaneWaits>;                         // a test's shorter lane.start and lane.stop waits
};

const acceptAny = () => true;

export function createOpsRuntime(o: RuntimeOptions): OpsRuntime {
  const { config } = o;
  const hooks = o.hooks ?? {};
  const now = wallClock(hooks);
  const paths = agentPaths(config.home);
  const registry = sessionRegistry(claudeDir(config.home));
  // topic and lastPrompt (RECONCILIATION.md ruling 13): each session's transcript, found through the same registry.
  const titles = new TranscriptTitles(sessionId => registry.transcriptPath(sessionId));
  const inventory = new Inventory({
    node: config.node, session: config.policy.session, socket: config.policy.tmuxSocket,
    sessions: () => registry.byPane(), stamp: stampServer, titles: sessionId => titles.read(sessionId),
  });
  const doneKeys = new DoneKeys(o.db, Date.now, { disabled: hooks.noDoneKeys === true });
  const inbox = new UploadInbox({ dir: paths.inboxDir, ...(o.room ? { room: o.room } : {}) });
  const guard = o.guard ?? (hooks.noExpect ? acceptAny : undefined);
  const tmux = tmuxAdapter({ socket: config.policy.tmuxSocket, session: config.policy.session });
  const deliveries = new DeliveryStore(o.db, now, config.node);
  const panes = agentPaneView({ inventory, tmux });
  const ops = buildOps({
    config, paths, db: o.db, doneKeys, inventory, inbox, registry, now, tmux, panes,
    deliverer: () => deliverer, send: req => executor.handle(req),
    ...(guard ? { guard } : {}), ...(o.lock ? { lock: o.lock } : {}), ...(o.laneWaits ? { laneWaits: o.laneWaits } : {}),
  });
  const executor = new OpExecutor({
    ops, allowed: new Set(config.policy.ops), doneKeys, invVersion: () => inventory.invVersion, log: o.log,
    ...(o.afterStarted ? { afterStarted: o.afterStarted } : {}),
    ...(hooks.killAfterEffect !== undefined ? { afterEffect: killOnce(hooks.killAfterEffect) } : {}),
  });
  const deliverer = new Deliverer({
    store: deliveries, executor, panes, transcripts: agentTranscripts(sessionId => registry.transcriptPath(sessionId)),
    now, emit: o.emitDelivery ?? (() => {}), log: o.log, hooks,
  });
  return { inventory, doneKeys, inbox, registry, executor, now, tmux, deliveries, deliverer, panes };
}
```

- [ ] **Step 19: Send `pane.capture`'s answer on the bulk lane in `apps/node-agent/src/agent.ts`**

Replace:

```ts
// Results that carry transcript or file bytes go on the bulk queue (spec §5.2 "Frames").
const BULK_OPS = new Set(["transcript.read", "file.get"]);
```

with:

```ts
// Results that carry transcript or file bytes, or a capture of up to 256 KiB, go on the bulk queue (spec §5.2 "Frames").
const BULK_OPS = new Set(["transcript.read", "file.get", "pane.capture"]);
```

- [ ] **Step 20: Run them and watch them pass**

Run: `npx vitest run apps/node-agent/test/pane-capture.test.ts apps/node-agent/test/delivery-ops.test.ts apps/node-agent/test/launcher.test.ts apps/node-agent/test/lane-worktree-ops.test.ts apps/node-agent/test/done-keys.test.ts apps/node-agent/test/executor.test.ts`

Expected: PASS, every test of the six files.
- pane-capture has 4 tests, delivery-ops 6 and launcher 14.
- lane-worktree-ops keeps its count.
- done-keys and executor pass as before: the new `EFFECT_FIELDS` change no hash of an op that leaves the new fields out.

- [ ] **Step 21: Commit**

```bash
git add apps/node-agent/src/ops apps/node-agent/src/agent.ts apps/node-agent/test/ops-harness.ts apps/node-agent/test/lane-worktree-ops.test.ts apps/node-agent/test/pane-capture.test.ts apps/node-agent/test/delivery-ops.test.ts apps/node-agent/test/launcher.test.ts
git commit -m "feat(node-agent): lane.deliver and delivery.cancel, pane.capture, the launcher, lane.start with a first prompt, lane.stop that exits"
```

- [ ] **Step 22: Create `apps/node-agent/test/lane-state.test.ts`**

The failing test for lane state events (§7).

```ts
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
    cleanups.push(async () => { await fleet.close(); t.kill(); h.cleanup(); });
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
    cleanups.push(async () => { await fleet.close(); t.kill(); h.cleanup(); });
    const config = await joinedConfig(h.home, fleet, t.socket);
    const { agent, post } = await runAgent(config);
    cleanups.push(() => agent.stop());
    expect((await post("/lane", { event: "needs_input", sessionId: S1, question: "made up?" })).status).toBe(404);
    expect(agent.spool.depth()).toBe(0);
  });
});
```

- [ ] **Step 23: Run it and watch it fail**

Run: `npx vitest run apps/node-agent/test/lane-state.test.ts`

Expected: FAIL, `Error: Cannot find module '../src/lane-state.ts'`.

- [ ] **Step 24: Create `apps/node-agent/src/lane-state.ts`**

```ts
// Lane state events (fleet clients spec §7): `needs_input` when a session's status turns `waiting` (any menu: a question,
// a permission prompt, a usage-limit dialog), with the question that menu asks read from this node's own screen (Task 2's
// menuQuestion, kira's rule); `answered` when it leaves `waiting`. Each is appended to the durable hook stream (the
// spool) on the path "/lane", with the window and session it came from, and goes to the fleet as a hook does: kept until
// acknowledged, replayed after a reconnect, with its own seq (plan Contracts, HookEvent). The relay never accepts "/lane"
// from outside (relay/server.ts answers 404), so no hook script can make one.
// - Statuses come from the inventory, read every 2 s (LIMITS.inventoryPollMs), by session.
// - A session first seen waiting (at the agent's start, say) gets its needs_input then: at least once, since a missed
//   one would leave a lane waiting unseen. A session gone while waiting gets its `answered`.
// - Which lanes the manager hears of (not its own, not laneEvents.ignore) is the fleet's to decide (spec §7, Task 9).
// - Any change of a status kicks the deliverer: a lane that stops waiting may take its delivery now.
// - Observations run one at a time, so the loop's read and the one after a welcome never both send an event.
import { setTimeout as sleep } from "node:timers/promises";
import { menuQuestion } from "@morndo/node-ops";
import type { Logger } from "./log.ts";
import type { Lane } from "./ops/inventory.ts";
import type { Spool } from "./relay/spool.ts";

export type LaneStateBody = { event: "needs_input" | "answered"; sessionId: string | null; question?: string };
export type LaneStateDeps = {
  spool: Pick<Spool, "append">;
  appended: () => void;                                    // the stream sender's kick
  screen: (pane: string) => Promise<string | null>;       // the pane's last lines, plain
  now: () => number;
  changed: () => void;                                     // the deliverer's kick
  log: Logger;
  retryMs?: number;                                        // the second look for a question (a test's shorter one)
};

const QUESTION_RETRY_MS = 500;

export class LaneStates {
  #d: LaneStateDeps;
  #seen = new Map<string, { status: Lane["status"]; window: string }>();   // session → its last status, and its window
  #chain: Promise<unknown> = Promise.resolve();

  constructor(d: LaneStateDeps) { this.#d = d; }

  observe(lanes: readonly Lane[]): Promise<void> {
    const next = this.#chain.then(() => this.#observe(lanes));
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async #observe(lanes: readonly Lane[]): Promise<void> {
    const live = new Map<string, Lane>();
    for (const l of lanes) if (l.sessionId !== null) live.set(l.sessionId, l);
    let changed = false;
    for (const [sid, l] of live) {
      const was = this.#seen.get(sid);
      this.#seen.set(sid, { status: l.status, window: l.window });
      if (was !== undefined && was.status === l.status) continue;
      changed = true;
      if (l.status === "waiting") await this.#needsInput(sid, l);
      else if (was?.status === "waiting") this.#append(sid, l.window, { event: "answered", sessionId: sid });
    }
    for (const [sid, was] of [...this.#seen]) {
      if (live.has(sid)) continue;
      this.#seen.delete(sid);
      changed = true;
      if (was.status === "waiting") this.#append(sid, was.window, { event: "answered", sessionId: sid });
    }
    if (changed) this.#d.changed();
  }

  // The menu may draw a moment after the status turns: one more look before the event goes without a question.
  async #needsInput(sid: string, l: Lane): Promise<void> {
    let question = await this.#question(l.pane);
    if (question === null) {
      await sleep(this.#d.retryMs ?? QUESTION_RETRY_MS);
      question = await this.#question(l.pane);
    }
    this.#append(sid, l.window, { event: "needs_input", sessionId: sid, ...(question !== null ? { question } : {}) });
  }

  async #question(pane: string): Promise<string | null> {
    const shown = await this.#d.screen(pane);
    return shown === null ? null : menuQuestion(shown);
  }

  #append(sid: string, window: string, body: LaneStateBody): void {
    const r = this.#d.spool.append({ path: "/lane", at: this.#d.now(), session: sid, window, body });
    if (r.ok) this.#d.appended();
    else this.#d.log.warn(`a lane event (${body.event}) could not be spooled (${r.why}); counted as a drop`);
  }
}
```

- [ ] **Step 25: Wire the lane state events into `apps/node-agent/src/agent.ts`**

1. Replace:

```ts
// - Deliveries (fleet clients spec §4): the deliverer runs from start to stop, kicked by hooks and inventory reads; each
//   change goes out as ev.delivery, and after every welcome the open ones and the final ones of the last hour (§4.4).
```

with:

```ts
// - Deliveries (fleet clients spec §4): the deliverer runs from start to stop, kicked by hooks and inventory reads; each
//   change goes out as ev.delivery, and after every welcome the open ones and the final ones of the last hour (§4.4).
// - Lane state events (fleet clients spec §7): each inventory read is observed for sessions that turn `waiting` or leave
//   it; the events go into the spool on "/lane" and to the fleet with the hooks (lane-state.ts).
```

2. Replace:

```ts
import { EventLoops } from "./events.ts";
```

with:

```ts
import { EventLoops } from "./events.ts";
import { LaneStates } from "./lane-state.ts";
```

3. Replace:

```ts
  const sender = new StreamSender({ spool, node: config.node, send: m => send(m), log });
```

with:

```ts
  const sender = new StreamSender({ spool, node: config.node, send: m => send(m), log });
  const states = new LaneStates({
    spool, appended: () => sender.kick(), screen: pane => ops.tmux.capture(pane, { lines: 50, attributes: false }),
    now: ops.now, changed: () => ops.deliverer.kick("status"), log,
  });
```

4. Replace:

```ts
    inventory: ops.inventory, send: m => send(m), log, onInventory: () => { ops.deliverer.kick("inventory"); },
```

with:

```ts
    inventory: ops.inventory, send: m => send(m), log,
    onInventory: async s => { ops.deliverer.kick("inventory"); await states.observe(s.lanes); },
```

- [ ] **Step 26: Run it and watch it pass**

Run: `npx vitest run apps/node-agent/test/lane-state.test.ts apps/node-agent/test/agent.test.ts`

Expected: PASS. `lane-state.test.ts` has 7 tests; `agent.test.ts` passes as before.

- [ ] **Step 27: Check the whole task**

Run each command on its own:
- `npx vitest run apps/node-agent/test`. Expected: no failed test. There are 5 more files and 34 more tests than after Task 5:
  - config-launch 3, pane-capture 4, delivery-ops 6, launcher 14, lane-state 7;
  - lane-worktree-ops keeps its count.
- `npx tsc -p apps/node-agent`. Expected: no output, exit 0.
- `npx tsc -p tsconfig.tests.json`. Expected: no output, exit 0.
- `npx oxlint --format=stylish apps/node-agent`. Expected: no output.
- `npm run check` is not this lane's gate. Task 1's types reach `apps/fleet` and `apps/hub` too, and their lanes adapt them; wave 1 merges the three together, and the integration branch must pass `npm run check` then.
- `HOME=$(mktemp -d) node apps/node-agent/src/main.ts status; echo "exit $?"`. Expected: `This machine has not joined a fleet (…/config.json). Run: morndo-node join '<join string>'`, then `exit 78`.

- [ ] **Step 28: Commit**

```bash
git add apps/node-agent/src/lane-state.ts apps/node-agent/src/agent.ts apps/node-agent/test/lane-state.test.ts
git commit -m "feat(node-agent): lane state events needs_input and answered, from session status, through the spool"
```

- [ ] **Step 29: Add this task's negative controls to `scripts/negative-controls.ts`**

After Task 5's `fc5-after-effect-skipped` entry (it ends `run: ["apps/node-agent/test/delivery-hooks.test.ts"], expect: "hub:a started" },`), insert:

```ts
  { id: "fc6-launch-option-first", task: "fc6", file: "apps/node-agent/src/config.ts",
    find: "\n    || String(command[0]).startsWith(\"-\")", replace: "",
    run: ["apps/node-agent/test/config-launch.test.ts"], expect: "dangerously" },
  { id: "fc6-protected-stopped", task: "fc6", file: "apps/node-agent/src/ops/lane-ops.ts",
    find: "      if (d.policy.protected.includes(a.name)) return fail(\"denied\", \"this node's policy protects that lane from lane.stop\");\n",
    replace: "",
    run: ["apps/node-agent/test/launcher.test.ts"], expect: "denied" },
  { id: "fc6-account-without-place", task: "fc6", file: "apps/node-agent/src/ops/lane-ops.ts",
    find: "  if (a.account !== undefined && !templated) return { refused: \"this node's launcher takes no account (its command has no {account})\" };\n",
    replace: "",
    run: ["apps/node-agent/test/launcher.test.ts"], expect: "takes no account" },
  { id: "fc6-shell-word-unquoted", task: "fc6", file: "apps/node-agent/src/ops/lane-ops.ts",
    find: String.raw`w.replaceAll("'", "'\\''")`, replace: "w",
    run: ["apps/node-agent/test/launcher.test.ts"], expect: "rm x" },
  { id: "fc6-trust-unseen", task: "fc6", file: "apps/node-agent/src/ops/lane-ops.ts",
    find: "      if (shown !== null && trustDialogOnScreen(shown)) return true;\n", replace: "",
    run: ["apps/node-agent/test/launcher.test.ts"], expect: "trust" },
  { id: "fc6-exit-into-menu", task: "fc6", file: "apps/node-agent/src/ops/lane-ops.ts",
    find: "    if (!typed.ok && typed.error.executed === \"no\") return { ok: false, error: typed.error };\n", replace: "",
    run: ["apps/node-agent/test/launcher.test.ts"], expect: "menu_open" },
  { id: "fc6-exit-prompt-unanswered", task: "fc6", file: "apps/node-agent/src/ops/lane-ops.ts",
    find: "names: [\"1\"]", replace: "names: [\"2\"]",
    run: ["apps/node-agent/test/launcher.test.ts"], expect: "answers Claude Code's 'Exit and stop tasks' with 1" },
  { id: "fc6-prompt-without-key", task: "fc6", file: "apps/node-agent/src/ops/executor.ts",
    find: "        ...(key !== undefined ? { key } : {}),\n", replace: "",
    run: ["apps/node-agent/test/launcher.test.ts"], expect: "prompt" },
  { id: "fc6-stop-trusts-shell-status", task: "fc6", file: "apps/node-agent/src/ops/lane-ops.ts",
    find: "    if (lane.sessionId !== null) return false;", replace: "    if (lane.status !== null && lane.status !== \"shell\") return false;",
    run: ["apps/node-agent/test/launcher.test.ts"], expect: "no_input_box" },
  { id: "fc6-stop-reads-history", task: "fc6", file: "apps/node-agent/src/ops/lane-ops.ts",
    find: "    const shown = await visible(lane.pane);", replace: "    const shown = await screen(lane.pane);",
    run: ["apps/node-agent/test/launcher.test.ts"], expect: "back at its shell" },
  { id: "fc6-capture-join-ignored", task: "fc6", file: "apps/node-agent/src/ops/pane-ops.ts",
    find: "join: a.join !== false", replace: "join: true",
    run: ["apps/node-agent/test/pane-capture.test.ts"], expect: "unless asked not to (join: false" },
  { id: "fc6-capture-uncapped", task: "fc6", file: "apps/node-agent/src/ops/pane-ops.ts",
    find: "return ok<\"pane.capture\">(capCapture(text, LIMITS.captureMaxBytes));", replace: "return ok<\"pane.capture\">({ text, truncated: false });",
    run: ["apps/node-agent/test/pane-capture.test.ts"], expect: "truncated" },
  { id: "fc6-deliver-without-pane-send", task: "fc6", file: "apps/node-agent/src/ops/delivery-ops.ts",
    find: "      if (!d.policy.ops.includes(\"pane.send\")) return fail(\"denied\", \"deliveries are typed through pane.send, which this node's policy does not allow\");\n",
    replace: "",
    run: ["apps/node-agent/test/delivery-ops.test.ts"], expect: "denied" },
  { id: "fc6-no-answered", task: "fc6", file: "apps/node-agent/src/lane-state.ts",
    find: "      else if (was?.status === \"waiting\") this.#append(sid, l.window, { event: \"answered\", sessionId: sid });\n", replace: "",
    run: ["apps/node-agent/test/lane-state.test.ts"], expect: "answered" },
  { id: "fc6-relay-takes-lane", task: "fc6", file: "apps/node-agent/src/relay/server.ts",
    find: "const KEPT = new Set([\"/hook/stop\", \"/hook/failure\", \"/notify\", \"/file\"]);",
    replace: "const KEPT = new Set([\"/hook/stop\", \"/hook/failure\", \"/notify\", \"/file\", \"/lane\"]);",
    run: ["apps/node-agent/test/lane-state.test.ts"], expect: "404" },
```

Not caught by design: the node's own `pane.capture` line check in `args.ts` repeats Task 1's `OP_ARGS` (the same bounds).

Run: `node scripts/negative-controls.ts --check`. Expected: exit 0.

- [ ] **Step 30: Commit**

```bash
git add scripts/negative-controls.ts
git commit -m "test(node-agent): negative controls for delivery ops, the launcher, lane.stop and lane state events"
```

- [ ] **Step 31: Run this task's negative controls**

The runner tests HEAD, so this comes after Step 30's commit (ruling 50).

Run `node scripts/negative-controls.ts` with `--only` once for each of the fifteen `fc6-…` ids above.

Expected: fifteen `bit      fc6-…` lines, then `15/15 controls bit; still pass 0, broke 0, timed out 0, skipped 0`.

## Contract additions (adopted)

RECONCILIATION.md adopted items 1–14 as this part defines them (rulings 1, 19 and 20); plan.md's Contracts follow. Items 15–22 are the rulings that changed this part.

1. **`DeliveryStore`'s constructor takes `node: string`** (`new DeliveryStore(db, now, node)`). `Delivery.node` is required, and the store is the one place that makes a `Delivery`, both for op answers and for `ev.delivery`.
2. **`DeliveryStore.detail(id): { target: DeliveryTarget; boundSession: string | null; retyped: boolean } | null`.** `Delivery` doesn't carry what the deliverer decides with:
   - whether a lane name is sticky (`Delivery.target` drops `sticky`);
   - the session a name was bound to (`Delivery.sessionId` shows the typed session once typed);
   - whether the one retype was used.
3. **`DeliveryStore.update(id, { sessionId })` binds while queued.** While the delivery stays `queued`, `sessionId` sets `bound_session` (a name queued in its lane's first 2 minutes binds the first session it shows). Otherwise it sets `typed_session`. `Delivery.sessionId` shows `typed_session ?? bound_session`. A final delivery is returned unchanged. A state other than `queued` drops `waiting`.
4. **`DeliveryStore.recentFinal(sinceMs)`: `sinceMs` is a time on the node's clock**, not a duration. The agent passes `now() - 3_600_000`.
5. **The types the `Deliverer` constructor names but the Contracts don't define:**
   - `Executor = Pick<OpExecutor, "handle">`;
   - `PaneView`, `TranscriptView` and `PaneState`.

   Also two additions to the deliverer: `DelivererDeps.hooks?` (below) and `Deliverer.drain(): Promise<void>`. The agent's `stop()` awaits `drain()` before the database closes, and the tests await it after a kick.
6. **Agent test hooks for Task 16's drills** (ruling 20), with these exact names and types:
   - `killAfterEffect?: string`: a SIGKILL right after a keyed op whose key contains it acted, before its `done`. It runs through the new `ExecutorDeps.afterEffect`.
   - `noSessionBinding?: true`: a lane name is held like a sticky one: no binding, and no `expect.sessionId`.
   - `retypeUnderFirstKey?: true`.
   - `deliveryStartGraceMs?: number`.
   - `noDoneKeys` already covers the deliverer, which has no key checks of its own.
7. **`EffectContext.key?: string`**, a keyed op's done key. `lane.start` makes its first prompt's id from it (item 15), and `lane.stop` types `/exit` under `<key>:exit`.
8. **`OpsRuntime` gains `tmux`, `deliveries`, `deliverer` and `panes` (the deliverer's `PaneView`). `RuntimeOptions` gains `emitDelivery` and `laneWaits`.** `ProcessStarts` is new: each pane process's start, for the 2-minute grace of §4.1 (item 19).
9. **`Policy.launch`'s type is named `Launch`.** A partial `launch` in policy.json keeps the default for the field it leaves out.
10. **`EFFECT_FIELDS` gains `"prompt"` for `lane.start` and `"mode"` for `lane.stop`.** A repeat with another first prompt or mode is `uncertain`, not the stored outcome.
11. **The `/lane` body is `{ event, sessionId, question? }`, as plan.md has it, with `sessionId` always a string from the node** (a lane without a session makes no state event).
12. **A recorded screen of Claude Code's "Exit and stop tasks" prompt (2.1.293)** goes under `test/fixtures/claude-code/` (ruling 19). The Global Constraints ask for one for every Claude Code fact. Until it exists, the words come from `claude-pool` (README §5), and the agent's fake box draws them.
13. **Ids of negative controls `fc<task>-…`** (ruling 1). Each task appends its entries itself, so two lanes of a wave meet in one merge conflict at the end of `CONTROLS`.
14. **This part moves three Task 6 items into Task 4** (`pane.keys` by name, the inventory's `status` and `pid`, and the argument checks for the new ops): Task 1 makes them required types, and the agent wouldn't compile without them. plan.md's Task index can stay as it is.
15. **Delivery ids (ruling 7).** The agent's own check refuses an id ending in `#<digits>`, a `ttlMs` over 7 days (`LIMITS.deliveryKeepMs`) and a target that isn't exactly one of `lane` and `workerId`. A first prompt's id is `promptId(key)`: `<client>:prompt:<first 16 hex of SHA-256 of the key>`.
16. **`pane.capture`'s `join`, default true (ruling 10).** The agent passes it to Task 2's `capture(pane, { lines, attributes, join })`, whose adapter turns it into tmux `-J`.
17. **A lane takes deliveries while its session is live, whatever its `status` (ruling 11).** `no_session` is no live session. `lane.stop` counts a lane as back at its shell once no live session is there and its visible screen shows no box or menu, and the trust-dialog wait no longer ends on a status. `pid` stays the session's process (ruling 12).
18. **`Pane.topic?` and `Pane.lastPrompt?` (rulings 13 and 46)** come from `TranscriptTitles` (`ops/transcript-titles.ts`): a tail scan of each session's transcript, cached per session, each value cut to 200 characters, and absent when unknown. `InventoryDeps` gains `titles?`.
19. **The start grace counts from the pane process's own start (ruling 14):** `ProcessStarts` in `deliveries/views.ts`, and `PaneRow.panePid` (`#{pane_pid}`) in `ops/tmux-panes.ts`. `PaneStarts`, `OpsRuntime.starts` and `LaneDeps.started` are gone.
20. **`unavailable` (ruling 15)** is in migration 3's CHECK. A `timeout` or an `internal` refusal that typed nothing, and panes that couldn't be read, make a delivery wait as `unavailable`.
21. **Receipts (rulings 16, 17 and 42).** A delivery waiting for its receipt holds the next for at most `LIMITS.deliveryReceiptHoldMs` (60 s, ruling 42). A command that starts a new session (Task 2's `startsNewSession`: `/clear`, `/reset`, `/new`; ruling 54) is delivered once its pane shows another session than the one it was typed into.
22. **A new delivery is answered `queued`, without `waiting` (ruling 43).** `waiting` is set only while it is queued and a round has found its lane not ready.

## Open questions

1. **`needs_input` at least once.** A session first seen `waiting` after an agent start gets its `needs_input` again, so the manager may hear twice of one menu. Keeping the last statuses in `agent.db` would avoid that, at the cost of a table the Contracts don't have. Ruling 18 settles it on the fleet's side (part 03): the fleet drops the repeat.
2. **The shapes `readReceipts` reads.** `claude-session.ts` writes `{ type: "user", promptSource: "typed", message: { role: "user", content } }`, and the deliverer's unit test also writes:
   - `queue-operation` records (`enqueue`, `dequeue`, `remove` with `reason` and `content`);
   - `queued_command` attachments;
   - a slash command's `<command-name>` prompt.

   These are README §1's shapes and `e2e/signal.e2e.ts`'s. If Task 2's recorded fixtures differ, the test helpers here follow them. In the scratch run, the deliverer's tests passed against Task 2's own `readReceipts`.
3. **A recorded `ai-title` and `last-prompt` entry.** Part 01 notes the keys read on the PC (`{"type":"ai-title","aiTitle",…}` and `{"type":"last-prompt","lastPrompt",…}`), and the review found 2 of 448 `last-prompt` entries without `lastPrompt` (ruling 56); `transcript-titles.test.ts` pins those. Task 2 records no example of either kind under `test/fixtures/claude-code/2.1.293/`; the tests here write them in that shape.
4. **A topic further back than the transcript's last 4 MiB** isn't found until Claude Code writes a new `ai-title`.

Settled in the review round, and no longer open: `capture`'s `join` is in plan.md's `Tmux` contract (ruling 56), and the deliverer uses Task 2's `startsNewSession` (ruling 54).
