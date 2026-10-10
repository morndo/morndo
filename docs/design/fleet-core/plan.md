# Fleet Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one Morndo run on one machine or across several. A node agent on each machine dials a separate fleet service and executes typed operations on its own tmux and `~/.claude`. The hub steers every node through the fleet service. The single-host path keeps working behind configuration.

**Architecture:** There are three components.
- `packages/protocol` defines the wire format (zod/mini) and the worker-ID format.
- `packages/node-ops` holds the machine-local code, moved from the hub.
- `apps/node-agent` (`morndo-node`) and `apps/fleet` (`morndo-fleet`) are new services that talk over one authenticated WebSocket per node.

The hub gains async ports (transcripts, files, uploads, captureMany) with a local and a fleet implementation, chosen by `MORNDO_FLEET_SOCKET`.

**Tech Stack:** Node 24.21.0 (type stripping, ESM), TypeScript 6.0.3, ws ^8.22.0, better-sqlite3 ^13.0.3, zod/mini through `packages/protocol/src/z.ts`, vitest 5.0.3, tmux 3.4+. No new dependencies.

**Spec:** [`docs/design/fleet-core/README.md`](README.md) (design v2, with section 15's corrections) and [ADR-0012](../../adr/0012-fleet-pull-agents-and-a-separate-fleet-service.md). Executors read both. Section numbers below (§N) refer to the spec.

**The tasks** are in [`plan/`](plan/), one file per lane part; the [Task index](#task-index) at the end links each one. Six drafters wrote the parts in parallel; [`plan/RECONCILIATION.md`](plan/RECONCILIATION.md) records how they were made consistent, and what was verified where. Its "Review round 2" section records the second round of fixes (two independent reviews: executability and coverage).

## Branches and worktrees

- **One integration branch, `feat/fleet-core`,** made from `main` before Task 1. Nothing is committed to it directly: each lane works in its own worktree (`git worktree add ../morndo-<lane> -b feat/fleet-core-<lane> feat/fleet-core`) and its branch is merged into `feat/fleet-core` in wave order (the Lanes table). The lane branches:

  | Lane | Branch | Tasks | Merged |
  |---|---|---|---|
  | foundation | `feat/fleet-core-foundation` | 1, 2, 3 | before wave 1 starts |
  | hub-async | `feat/fleet-core-hub-async` | 4, 5 | end of wave 1 |
  | agent | `feat/fleet-core-agent` | 6, 7, 8, 9 | end of wave 1 |
  | fleet | `feat/fleet-core-fleet` | 10, 11, 12, 13 | end of wave 1 |
  | hub-fleet | `feat/fleet-core-hub-fleet` | 14, 15, 15b | wave 2 (Task 14's first commit early, for Task 16) |
  | tests | `feat/fleet-core-tests` | 16, 17 | wave 2 |
  | final | `feat/fleet-core-final` | 18, 19, 20 | wave 3 |

  A wave-2 lane branches from `feat/fleet-core` after wave 1 is merged; Task 16's lane merges `feat/fleet-core-hub-fleet` once Step 14.6 is committed there.
- **A fresh worktree needs `npm ci` and `npx playwright install chromium`** before its first run: `node_modules` and the browser are not shared between worktrees, and the web tests (Tasks 15, 15b, 18) need Chromium.
- **The QA branch** (Task 20) is `feat/fleet-core`; the runbook names it once, in its variables file.

## Global Constraints

- Runtime: `engines.node` `>=24.12`; the services run on `~/.nvm/versions/node/v24.21.0/bin/node --no-warnings <file>.ts`. TypeScript runs as stripped types; no build step for the hub, agent or fleet.
- Node on each machine (seen 2026-10-06): the PC and the control plane run 24.21.0 from nvm; the owner's Mac has Node 26.3.1 (`/opt/homebrew/bin/node`) and **no** `~/.nvm/versions/node/v24.21.0`; CI's `setup-node` resolves `engines.node` from `package.json`. Commands in the tasks therefore write `node` and `npx`, never the nvm path, except where they run on the PC or the control plane (Task 20 pins `~/.nvm/versions/node/v24.21.0/bin/node` on both). This Mac also has no `timeout(1)` and no `flock(1)`: `pane-lock.test.ts` fails there before and after every task (Linux CI has `flock`), and the agent's flock test is skipped.
- **Test counts are macOS counts.** Every count in a step was seen on macOS (Node 24.21.0, tmux 3.6a). On Linux, the `flock` tests also run; nobody has run the suites there. The first CI run of each lane records its Linux counts in RECONCILIATION.md, and the steps are corrected to them.
- **One command per Run line, each with its own Expected.** A chain such as `npx vitest run … && npm run check && npm run lint` stops at the first failure, and on macOS the known `pane-lock` failures stop it before `check` runs. Steps list the commands separately.
- No new npm dependencies. Use `ws`, `better-sqlite3`, `zod/mini` (only via `@morndo/protocol`'s `z`), `node:crypto`, `node:child_process`, `node:fs`, `node:net`, `node:http`.
- Strict DDD: `packages/domain` imports nothing else; `packages/protocol` imports no `node:*`; `packages/node-ops` imports no `apps/*`. Each rule has an architecture test.
- Every database uses numbered migrations in the style of `apps/hub/src/adapters/migrations.ts`: `user_version`, one transaction, and a newer database is refused.
- The agent database is opened with `journal_mode=WAL` and `synchronous=FULL` (the fleet's too).
- Logging goes through a redacting logger like `apps/hub/src/adapters/log.ts`. Never log typed text, hook bodies, keys or codes.
- Limits are copied from the spec, and live in one place, `LIMITS` in `packages/protocol/src/fleet.ts`:
  - messages: ≤ 512 KiB per message, `maxPayload` 1 MiB, bulk chunks ≤ 256 KiB before base64;
  - content: files ≤ 25 MiB, send text ≤ 8000 characters, keys ≤ 4096 characters, `captureMany` ≤ 64 panes (6 KiB each), a `transcript.locate` needle ≤ 200 characters;
  - streaming: replay window 256 events;
  - timing: ping 15 s, the agent's ping timeout 35 s (two pings plus slack), health every 30 s, inventory poll 2 s, deadline margin 250 ms; the instance check waits 3 s for the live connection's pong; a refused (4409) agent tries again every 5 minutes; the hub waits at most 300 ms per node for an inventory;
  - queues and buffers: at most 8 bulk ops waiting per node; a client events socket is closed once 8 MiB of events are unsent; joins and hellos 10 at once per source address, one more every 6 s;
  - lifetimes: join code 10 minutes, done keys 7 days, outbox rows 24 h after delivery, dead letter after 20 attempts, subscriber backlog 50,000, audit rows (alerts included) 90 days.
- Ports and paths (every path derives from `HOME`, never `XDG_*`; the Contracts list them all):
  - the fleet's agent endpoint is `127.0.0.1:8791/agent`;
  - the hook relay is `127.0.0.1:8787`;
  - the client API socket defaults to `~/.local/state/morndo-fleet/fleet.sock`, in a directory of mode 0700 owned by the user;
  - the agent database is `~/.local/state/morndo-node/agent.db`;
  - the fleet database is `~/.local/share/morndo-fleet/fleet.db`.
  - A Unix socket's path must fit `sockaddr_un.sun_path`: 103 bytes on macOS, 107 on Linux; a longer one fails `connect` with `EINVAL` on macOS (the hub's fleet client counts that as never reached). A temporary `HOME` on macOS is already about 60 bytes, so tests put sockets in a short directory under `/tmp` (Task 16).
- Tests never touch the owner's running system:
  - isolated tmux servers only (`tmux -L test-<uuid>`, through `packages/node-ops/test/isolated-tmux.ts`, killed in `afterEach`/`afterAll`);
  - temporary `HOME`/config directories; a test agent's `policy.json` always names its own tmux socket;
  - random free ports.
- **tmux, as every caller uses it** (seen on tmux 3.6a, 2026-10-06; Task 2's `tmux-cli.ts`):
  - pass `-u` on every call: without it, under a locale that isn't UTF-8 and outside tmux, non-ASCII characters and even tabs print as `_`. A client that runs inside tmux (`TMUX` set) writes UTF-8 anyway, so a test of this clears `TMUX` and `TMUX_PANE`;
  - name a session as `=name`: a bare `-t mai` matches `main`. In zsh, quote it (`-t '=main'`): zsh expands a word that starts with `=`;
  - pass every argument that tmux expands as a format and that carries data from outside (a window name, a directory, a session name) through `tmuxLiteral()`, which doubles `#`. Seen expanded on tmux 3.6a: `new-window -n` (`a#S b` → `amain b`), `new-window -c` (a directory `a#{session_name}b` starts the pane in `amainb`), `rename-window`, `new-session -s`/`-n`/`-c`; a `#(…)` in any of them expanded to nothing (no job ran in 2 s there; older versions are not known to behave the same). Never build a `-F` or `display-message -p` format out of outside data: read `#{window_name}` and compare in TypeScript;
  - never target a window by its name: the window part of a target is matched as a pattern (`-t '=main:f*'` found `f*x`) and split at `.` (`=main:fix.a` looked for a window `fix`), and `display-message -p -t` with a target that matches nothing printed the session's current window with exit 0. Target `@N` or `%N`, found by listing;
  - `kill-server` returns before the server process has exited (on tmux 3.6a its pid was still alive right after in 40 of 40 probes), and a server started at once on the same socket can meet the dying one (`server exited unexpectedly`, tmux 3.3a). Wait until `list-sessions` says no server, then remove the socket file (the shared `isolatedTmux().kill()` does both; its test checks the server's pid).
- **vitest 5.0.3 fake timers:** `vi.useFakeTimers()` with no `toFake` fakes every timer but `nextTick` and `queueMicrotask`, `setImmediate`, `Date` and `performance` included (`node_modules/vitest`, read 2026-10-06). A test with real sockets lists what it fakes: `{ toFake: ["Date"] }` to move only the wall clock (the rate limit, Task 11); `["setTimeout", "clearTimeout", "Date", "performance"]` to show that deadlines and backoff run on the monotonic clock (Tasks 7, 8); `["setInterval", "clearInterval"]` for the fleet's ping sweep (Task 11). Code that only reads a clock takes it injected instead (`now`/`tick`: the join-code expiry, Task 10; delivery retries, Task 13).
- **Child processes in tests:** a CLI that talks to a server running inside the test's own process must be spawned asynchronously (`spawn`, `execFile`): `spawnSync`/`execFileSync` block the event loop, so that server can't answer (Task 12's `node revoke` test). Synchronous spawning is fine when the server is itself a child process (the drills' harness, Task 16).
- **Wiring:** the vitest `units` include and `tsconfig.tests.json` may name folders that don't exist yet, but `tsc -p <folder>` fails on one (`TS5058`). Task 1 wires both new apps in before wave 1; each app's own `package.json` has `"typecheck": "tsc -p ."`, which `npm run check` runs through `npm run typecheck --workspaces --if-present`. Tests are type-checked (`tsconfig.tests.json`), so a fake must satisfy the port's type. `npm run lint` (the whole repository) is the lint check: a path-scoped `npx oxlint packages/node-ops` reports a spurious type-aware error, because that package's `tsconfig.json` includes only `src`.
- Every new external API used is cited with URL and date in the code comment or in the app's README (repo rule).
- Commits use Conventional Commits, with no AI attribution lines.

## Review Focus

These inputs are not exercised by the spec's own tests. Each line names the tasks that add its test.

1. **Window names with spaces, unicode, dots or slashes** (`fix: a/b ü.2`). They route by worker ID and survive the lane registry and the URLs, and nothing is ever split on the name. Test: Task 8 (inventory, and routing by worker ID), Task 12 (the lane registry, `GET /v1/lanes/<name>` and routing by lane, `ODD_NAMES`) and Task 16 (end to end). A window name holding a control character (a tab) is listed but can't be steered through the fleet: `OP_ARGS`' `expect.window` refuses control characters.
2. **tmux not running when the agent starts, or the tmux server dying mid-run.** Inventory is empty and the agent doesn't crash. The stamp is (re)created when a server appears. Old worker IDs answer `no_pane`. Test: Task 8 (`inventory.test.ts`), with the stamp itself in Task 2 (`stamp-health.test.ts`).
3. **Oversized inventory or capture.** 64 panes with full 150-line captures must still fit 512 KiB messages: each pane's capture is capped at 6 KiB, and the result says `truncated: true`. Test: Task 8 (`inventory.test.ts`), with the message-size arithmetic in Task 1 (`fleet.test.ts`).
4. **A wall-clock jump** (NTP step, laptop resume) during deadlines, backoff, liveness or join-code expiry. Deadlines, backoff and liveness use `performance.now()` and are unaffected; join-code expiry uses the fleet's wall clock only. Test: Task 7 (backoff, `retry.test.ts`), Task 8 (deadline, `executor.test.ts`), Task 10 (join-code expiry on the wall clock), Task 11 (the rate limit) and Task 13 (a retry time from a clock that stepped back), with fake timers or an injected clock.
5. **A join string pasted with whitespace, quotes or a trailing newline.** It is trimmed and unquoted. A truncated string gives a clear error and no partial state on disk. Test: Task 1 (`parseJoinString`) and Task 6 (`join.test.ts`: the CLI, nothing written).

---

## Contracts (names and types shared across tasks)

Every task uses exactly these names. A task that needs another name adds it here, in the same commit. Where a task file and this section differ, this section wins; tell the coordinator. These are the reconciled Contracts: each drafter's requested changes, once decided, are folded in here, and [`plan/RECONCILIATION.md`](plan/RECONCILIATION.md) says which came from where.

### `packages/protocol/src/worker-id.ts` (Task 1)

```ts
export const NODE_NAME = /^[a-z0-9-]{1,32}$/;
export const WORKER_ID = /^([a-z0-9-]{1,32})\.([0-9a-f]{8})\.(0|[1-9]\d{0,8})$/;   // the pane number without leading zeros: one ID per pane
export const LEGACY_PANE_ID = /^%\d{1,9}$/;                                            // as the legacy hub has always taken it
export type WorkerRef = { node: string; server: string; pane: number };
export function formatWorkerId(ref: WorkerRef): string;          // "pc.3fa2c1d0.12"; throws TypeError on a ref that can't form one
export function parseWorkerId(id: string): WorkerRef | null;     // null for anything not WORKER_ID (a legacy %N included)
export function isWorkerOrLegacyId(id: string): boolean;          // WORKER_ID or LEGACY_PANE_ID
export function menuEscalationId(workerId: string): string;       // "menu-" + id with "." → "_" and "%" removed ("%4" → "menu-4")
```

### `packages/protocol/src/fleet.ts` (Task 1)

```ts
export const FLEET_PROTO = 1;            // agent channel; accepted: [FLEET_PROTO - 1, FLEET_PROTO] ∩ ≥ 1
export const CLIENT_API = 1;             // `/v1/`
export const LIMITS = {
  maxMessageBytes: 524288, maxPayload: 1048576, chunkBytes: 262144,
  maxFileBytes: 26214400, maxSendText: 8000, maxKeys: 4096, captureManyMax: 64, captureBytesPerPane: 6144, maxNeedle: 200,
  replayWindow: 256,
  pingMs: 15000, agentPingTimeoutMs: 35000, healthMs: 30000, inventoryPollMs: 2000, deadlineMarginMs: 250,
  instancePongMs: 3000, conflictRetryMs: 300000, inventoryWaitMs: 300,
  bulkQueueMax: 8, eventsBufferBytes: 8388608, handshakeBurst: 10, handshakeRefillMs: 6000,
  joinCodeTtlMs: 600000, doneKeyTtlMs: 604800000, outboxKeepMs: 86400000, deadLetterAttempts: 20,
  subscriberBacklog: 50000, spoolMaxEvents: 100000, spoolMaxBytes: 268435456, relayFileKeepMs: 86400000, auditKeepMs: 7776000000,
} as const;
// agentPingTimeoutMs: two missed pings plus slack. instancePongMs: how long the fleet waits for the live connection's pong
// before it admits another instance (§5.2). conflictRetryMs: a refused (4409) agent tries again this often, ±20 % jitter.
// inventoryWaitMs: the hub's listWorkers waits at most this per node. bulkQueueMax: bulk ops waiting per node (one runs);
// more is `busy`. eventsBufferBytes: unsent events before a client's events socket is closed (1013). handshakeBurst and
// handshakeRefillMs: joins and hellos per source address, before any key work (1013 over it). spoolMaxBytes also counts
// relay copies and the upload inbox (Task 9). auditKeepMs: 90 days, alerts included.
export const CLOSE = { badProof: 4401, forbidden: 4403, conflict: 4409, unsupported: 4426 } as const;
export function fleetUrlOk(url: string): boolean;   // wss://…, or ws:// only to 127.x.x.x, localhost or [::1] (with an optional port)

export type Expect = { server: string; window: string; sessionId?: string };
export type ErrorCode = "bad_args" | "unknown_op" | "denied" | "no_pane" | "menu_open" | "no_input_box"
  | "draft_present" | "busy" | "name_taken" | "lane_conflict" | "too_large" | "timeout" | "node_offline" | "uncertain" | "internal";
export type Executed = "no" | "maybe";
export const ERROR_EXECUTED: Record<ErrorCode, Executed>;   // "uncertain" and "internal" are "maybe", all 13 others "no"
export type OpError = { code: ErrorCode; executed: Executed; message: string };   // a code a newer peer sends decodes as "internal"

export type Pane = { workerId: string; window: string; cwd: string; sessionId?: string; title?: string; claudeVersion?: string };
export type OpName = "inventory.get" | "pane.captureMany" | "pane.frame" | "pane.keys" | "pane.send" | "op.status"
  | "transcript.size" | "transcript.read" | "transcript.locate" | "file.stat" | "file.get" | "file.put"
  | "lane.start" | "lane.stop" | "worktree.list" | "worktree.add";
export type OpArgs = {
  "inventory.get": Record<string, never>;
  "pane.captureMany": { workerIds: string[] };
  "pane.frame": { workerId: string };
  "pane.keys": { workerId: string; data: string; expect: Expect };
  "pane.send": { workerId: string; text: string; expect: Expect };
  "op.status": { key: string };
  "transcript.size": { sessionId: string };
  "transcript.read": { sessionId: string; offset: number; max: number };
  "transcript.locate": { sessionId: string; needle: string };
  "file.stat": { path?: string; ref?: string };
  "file.get": { path?: string; ref?: string; offset: number; max: number };
  "file.put": { upload: string; offset: number; bytes: string /* base64 */; final: boolean; name: string };
  "lane.start": { name: string; cwd: string; account?: string /* ^[a-z0-9][a-z0-9-]{0,31}$ */; resume?: string /* a UUID */ };
  "lane.stop": { name: string };
  "worktree.list": { repo: string };
  "worktree.add": { repo: string; name: string; base: string };   // name, base: branch names (below)
};
export type OpResult = {
  "inventory.get": { panes: Pane[]; invVersion: number };
  "pane.captureMany": { captures: { workerId: string; text: string | null; truncated: boolean }[] };
  "pane.frame": { frame: { cols: number; rows: number; x: number; y: number; cursor: boolean; lines: string[] } | null };
  "pane.keys": { ok: boolean };
  "pane.send": { problem: "menu_open" | "draft_present" | "no_input_box" | "not_submitted" | "no_pane" | "busy" | null; typedAt: number };
  "op.status": { state: "unknown" | "started" | "done"; outcome?: unknown };
  "transcript.size": { size: number | null };
  "transcript.read": { bytes: string /* base64 */; eof: boolean };
  "transcript.locate": { offset: number | null };
  "file.stat": { size: number; mtime: number };
  "file.get": { bytes: string; size: number; eof: boolean };
  "file.put": { path: string | null };
  "lane.start": { workerId: string };
  "lane.stop": { ok: true };
  "worktree.list": { worktrees: { path: string; branch: string | null }[] };
  "worktree.add": { path: string };
};
export const OP_NAMES: readonly OpName[];                   // all 16
export const OP_ARGS: { [O in OpName]: ZodMiniType };       // strict, with LIMITS (what an agent acts on)
export const OP_RESULTS: { [O in OpName]: ZodMiniType };    // shape only (what a node reports)
export const KEYED_OPS: ReadonlySet<OpName>;                // pane.send, file.put, lane.start, lane.stop, worktree.add

export type Health = { memTotal: number; memAvailable: number; psiSome10: number | null; psiFull10: number | null;
  diskFreeHome: number; load1: number; tmuxOk: boolean; wallClock: number; spoolDepth: number; drops: number };
export type HookEvent = { streamId: string; seq: number; at: number; path: "/cc" | "/sl" | "/hook/stop" | "/hook/failure" | "/notify" | "/file";
  node: string; window: string | null; late?: true; body: unknown };
export type AlertKind = "instance_conflict" | "source_changed" | "clock_offset" | "rate_limited" | "lane_conflict" | "dead_letter" | "backlog_full";
export type Alert = { id: number; at: number; node: string | null; kind: AlertKind; detail: Record<string, unknown> };

export function fleetSigPayload(node: string, clientNonce: string): string;   // "morndo-fleet/1/fleet\n" + node + "\n" + clientNonce
export function nodeSigPayload(node: string, nonce: string): string;          // "morndo-fleet/1/node\n" + node + "\n" + nonce
export type JoinString = { url: string; fleetKey: string /* SPKI DER base64 */; code: string /* base64url, 16 bytes */; node: string /* NODE_NAME */ };
export function formatJoinString(j: JoinString): string;           // "morndo-join:1:" + base64url(JSON); throws TypeError on what it couldn't parse back
export function parseJoinString(s: string): JoinString | null;     // drops whitespace anywhere and surrounding quotes (straight or typographic)
```

**`lane.start` arguments** (`OP_ARGS`): `account` matches `^[a-z0-9][a-z0-9-]{0,31}$` and `resume` is a UUID, so neither can start with `-` and pass as a flag of `claude-as <account> --resume <id>`.

**Branch names** (`worktree.add`'s `name` and `base`): `OP_ARGS` takes a superset-safe form of git's rules: ASCII letters, digits, `.`, `_`, `-` and `/`; not starting with `-`, `.` or `/`; no `..`, `//`, `/.`, `@{`; not ending in `/`, `.` or `.lock` (nor a component ending in `.lock`); at most 200 characters. `fix/login` passes. The agent then asks git itself (`git check-ref-format --branch <name>`).

**The agent parses as the fleet does.** For every op the agent first decodes the arguments with `OP_ARGS[op]` (the same schema the fleet checked), then applies only what a node alone can judge (`args.ts`: paths under the policy's roots, the branch through `git check-ref-format --branch`, the account and resume once more before `claude-as`). A key on an op outside `KEYED_OPS` is `bad_args` at the agent as at the fleet, and so is a keyed op without one.

**Messages.** Every message is `{ v: 1, t, … }`. Schemas are exported under the same names, plus `AgentMessage`/`FleetMessage` (discriminated unions on `t`) and `AgentFrames`/`FleetFrames` (by `t`, for `decode()`). Field formats: `node` matches `NODE_NAME`; `instanceId`, `streamId`, `Ack.streamId` and `Res.store` are UUIDs; signatures are 88 characters of standard base64; nonces are base64url of 22–86 characters; keys match `^[a-z]+:` (at most 512 characters, the client's namespace first).

```ts
// agent → fleet
Join        { v: 1, t: "join", node: string, code: string /* 22 base64url */, publicKey: string /* Ed25519 SPKI DER base64 */,
              agent: { version: string }, proto: number[] }
Hello       { v: 1, t: "hello", node: string, instanceId: string, streamId: string, proto: number[], agent: { version: string },
              claude: { version: string | null }, caps: string[] /* the policy's ops, at most 64 */, clientNonce: string }
Proof       { v: 1, t: "proof", sig: string }
Res         { v: 1, t: "res", id: string, invVersion: number, store: string, ok: true, result: unknown }   // result checked against OP_RESULTS[op]
          | { v: 1, t: "res", id: string, invVersion: number, store: string, ok: false, error: OpError }
            // storeSeq? (added during execution, 2026-10-07; optional, so an agent from before may omit it): that database's
            //   store sequence, keyed ops started, one more with each `started`, never lowered; spec §5.3. The fleet passes the
            //   agent's on as sent, its own answers after sending carry the highest it saw from that store, null before sending.
            // store: the stream id of the agent database the answer comes from (where its done keys live), on every res,
            // op.status's included. A new or restored database is a new store (Task 9), so a caller can tell that the
            // keys it asks about may be gone.
EvHook      { v: 1, t: "ev.hook", event: HookEvent }
EvInventory { v: 1, t: "ev.inventory", panes: Pane[], invVersion: number }        // always the full list (latest wins)
EvHealth    { v: 1, t: "ev.health", health: Health }
// fleet → agent
Challenge   { v: 1, t: "challenge", nonce: string, fleetSig: string }
Welcome     { v: 1, t: "welcome", connEpoch: number /* ≥ 1 */, ackSeq: number, streamKnown: boolean, storeSeqSeen?: number }
            // storeSeqSeen (added during execution, 2026-10-07): the highest storeSeq the fleet has seen from the hello's store
            //   (fleet.db store_seqs, migration 3); an agent whose own is lower starts a new store before going online.
Req         { v: 1, t: "req", id: string /* 1–64 characters, opaque */, op: string /* any name: unknown → unknown_op */, args: unknown,
              timeoutMs: number /* 1–600000 */, key?: string }
Ack         { v: 1, t: "ack", streamId: string, seq: number }                   // cumulative, for that stream only
```

**Join flow (once per node).**
1. `morndo-fleet node add <name>` prints `formatJoinString({ url: publicUrl, fleetKey, code, node: name })` on a line of its own. The code is single use, valid 10 minutes on the fleet's wall clock, bound to `name`; fleet.db keeps only its SHA-256.
2. `morndo-node join '<join string>'` parses it (whitespace and quotes dropped; a truncated string, or a `url` that fails `fleetUrlOk`, is refused before anything is written or dialed), makes its Ed25519 key in memory and dials `url`.
3. The agent sends `join { node, code, publicKey, agent, proto }`. The fleet refuses with close 4426 when no protocol version overlaps, and with 4403 when the code is unknown, expired, used, or bound to another name than `node`. Otherwise it stores `(node, publicKey)`, answers `welcome { connEpoch: 1, ackSeq: 0, streamKnown: false }` (placeholder values: the agent reads only that it was welcomed) and closes with 1000.
4. Only after the welcome does the agent write its key (0600), a default `policy.json` (if none) and `config.json` (last). `morndo-node run` then dials again and opens with `hello`. Nothing else travels on the join connection.

**Every connection.** `hello` → `challenge` (the fleet signs `fleetSigPayload(node, clientNonce)`; the agent checks it against the pinned key and closes 1008 without a proof on a mismatch) → `proof` (over `nodeSigPayload(node, nonce)`) → `welcome`, or a close: 4401 bad proof, 4403 revoked or unknown, 4409 another live instance, 4426 unsupported protocol, 1013 too many handshakes from that address. `welcome.ackSeq`/`streamKnown` are for `hello.streamId`. The agent stops dialing on 4401 and 4403; on 4409 it keeps `status: conflict` and tries again every `conflictRetryMs` (5 minutes, ±20 % jitter); it retries 4426 hourly, and otherwise (1013 included) backs off 1 s → 60 s with full jitter. The agent dials only a URL that passes `fleetUrlOk`, at join and at every connect.

**Instances (spec §5.2).** A hello with the live connection's `instanceId` replaces that connection (a reconnect). A hello with another `instanceId` while one is live makes the fleet ping the live connection and wait `instancePongMs` (3 s), without blocking any other node: no pong, and the old connection is terminated and the new one admitted (a crashed or half-open agent can't lock its node out); a pong, and the newcomer is closed 4409 with one `instance_conflict` alert per refused `instanceId` for as long as the live connection lasts (its retries every 5 minutes raise none). Joins and hellos are counted per source address before any key work (`handshakeBurst` at once, one more every `handshakeRefillMs`); over that the connection is closed 1013, logged, with no alert (an unauthenticated address names no node, and alerts must not be fillable from outside).

**Behaviour the agent and the fleet agree on.**
- `pane.send` refusals before the paste (`menu_open`, `no_input_box`, `draft_present`, `no_pane`, `busy`) are errors with `executed: "no"` and release the key; `result.problem` is only `null` or `"not_submitted"`.
- A keyed op without a key, and a key on any other op, is `bad_args`, at the fleet and at the agent.
- The key's hash covers only what decides the effect: the op, and `pane.send`'s `workerId` and `text`; `lane.start`'s `name`, `cwd`, `account`, `resume`; `lane.stop`'s `name`; `worktree.add`'s `repo`, `name`, `base`; `file.put`'s `upload` and `offset`. Never `expect`, `timeoutMs` or the request id, so a retry with a refreshed expectation is the same request. A repeat of a `done` key with the same hash returns the stored result; of a `started` key, `uncertain`; a repeat whose hash differs from a `started` or `done` key's is `uncertain` (`executed: "maybe"`): that key's op may have run.
- `op.status { key }` answers `{ state: "unknown" | "started" | "done", outcome? }`; for `done`, `outcome` is the op's stored **result** (for `pane.send`: `{ problem, typedAt }`). Like every `res`, it carries `store`: an `unknown` is only worth anything from the store that took the original request.
- Every answer the fleet gives to an op it sent to a node carries that node's `store`: the agent's `res.store` on the agent's own answers (also when the fleet turns a result that doesn't fit `OP_RESULTS` into `internal`), or, for the fleet's own answer after it sent the request (`uncertain` on a dropped connection, `timeout`, `node_offline` for a read whose connection dropped), the store of the connection it went out on (that connection's `hello.streamId`; the two are the same id on a normal connection). A refusal before anything was sent (`node_offline` for a node that isn't online, `lane_conflict`, `name_taken`, `busy` from a full bulk queue, `bad_args`, `too_large`, `no_pane` for an unknown lane) has `store: null`.
- Hook `seq` strictly increases within a stream but has gaps (coalescing deletes superseded `/cc` and `/sl`): the fleet accepts any seq above the highest it accepted.
- Results of `transcript.read` and `file.get` travel on the bulk queue; at most one bulk op per node is in flight, and at most `bulkQueueMax` (8) wait behind it: one more is `busy` (`executed: "no"`). An op's `timeoutMs` runs from when the fleet queued it, so one that waited too long answers `timeout` without reaching the node.
- Clients put their own namespace in front of their keys (`hub:`, `kira:`, `lanes:`); the fleet passes keys through unchanged.

### `packages/node-ops/src/` (Task 2 moves and adds; Task 3 adds transcript bytes)

```ts
// tmux.ts (moved)        tmuxAdapter({ socket, session, historyLines? }): Tmux; Tmux; SendProblem; menuOnScreen; menuIdentity; inputBoxOnScreen; draftOnScreen
//                        Tmux.listWorkers(): Promise<Worker[]>, and from Task 15 (Worker gains `node`) Promise<Omit<Worker, "node">[]>
// terminal.ts (moved)    terminalAdapter({ socket }): Terminal; Terminal; Frame; keyArgs; MAX_KEYS
// sessions.ts            sessionRegistry(configDir): { byPane(): Map<"%N", SessionInfo>; transcriptPath(sessionId): string | null }; SessionInfo; CHECKED_VERSION
// pane-lock.ts (moved)   paneLock(path, waitS?): PaneLock; PaneLock = <T>(f: () => Promise<T>) => Promise<T | "busy">
// file-rules.ts          MAX_FILE_BYTES; SECRET_NAME; denyRoots(home, dataDir); deniedBy(path, roots); confine(path, { home, dataDir, roots? });
//                        openConfined(path, { home, dataDir, roots? })
export const SECRET_NAME: RegExp;   // as before, plus `.credentials.json` (Claude Code's own, and each ~/.claude-accounts/<name>/.credentials.json)
export function denyRoots(home: string, dataDir: string): string[];
// The credential places as before (~/.ssh, ~/.gnupg, …, ~/.claude/.credentials.json, /etc, /proc, …, dataDir), plus the control
// plane's and every node's own state: ~/.local/share/morndo*, ~/.local/state/morndo*, ~/.config/morndo* (the hub's
// morndo.db, the fleet's fleet.db and key, the agent's agent.db, key, config and policy), ~/.local/share/kira and
// ~/.config/kira. An entry ending in "*" is a prefix: it covers every name that starts with it. (Each account's
// ~/.claude-accounts/<name>/.credentials.json is refused by SECRET_NAME, wherever it is.)
export function deniedBy(path: string, roots: readonly string[]): boolean;   // under one of `roots`, "*" prefixes included
export function openConfined(path: string, opts: { home: string; dataDir: string; roots?: string[] }):
  Promise<{ ok: true; fh: FileHandle; real: string; size: number } | { ok: false; reason: "missing" | "denied" | "secret" | "too_large" | "not_file" }>;
// confine(), then opens `real` with O_RDONLY | O_NOFOLLOW and checks the open file again (a regular file, at most
// MAX_FILE_BYTES): a link put in its place after confine() is refused ("denied"), never followed. Every read a node does
// for someone else (file.stat/get, the relay's copies) goes through it; the hub's files.ts uses deniedBy.
// tmux-cli.ts (new, Task 2)
export function tmuxArgv(socket: string | null, args: readonly string[]): string[];   // ["-u", ...(socket ? ["-L", socket] : []), ...args]
export const exactSession: (name: string) => string;                                  // "=" + name: never a prefix match
export const tmuxLiteral: (s: string) => string;   // "#" → "##": for every argument tmux expands as a format (new-window -n/-c,
                                                   // new-session -s/-n/-c, rename-window). The one helper; windowNameArg is gone.
// stamp.ts (new, Task 2)
export function stampServer(socket: string | null): Promise<string | null>;   // 8 hex of @morndo-server (a UUID), set with set-option -o if empty; null without a server
// health.ts (new, Task 2)
export type HealthProbe = Omit<Health, "wallClock" | "spoolDepth" | "drops">;
export function healthProbe(home: string, o?: { tmuxSocket?: string | null }): Promise<HealthProbe>;   // tmuxOk: that server answers list-sessions
export function memAvailableFrom(meminfo: string): number | null; export function psiFrom(pressure: string): { some10: number | null; full10: number | null };
// transcript-bytes.ts (new, Task 3)
export type TranscriptBytes = { size(): Promise<number | null>; read(offset: number, max: number): Promise<{ bytes: Uint8Array; eof: boolean } | null>; locate(needle: string): Promise<number | null> };
export function localTranscriptBytes(path: string): TranscriptBytes;   // read ≤ min(max, LIMITS.chunkBytes); locate: start of the LAST line holding the needle
```

Every tmux call in node-ops, the agent and the tests goes through `tmuxArgv` (so `-u`), names a session as `exactSession(name)`, passes every format-expanded argument that carries outside data through `tmuxLiteral`, and targets windows and panes by ID (`@N`, `%N`), never by name. Tests use the shared helper `packages/node-ops/test/isolated-tmux.ts`: `isolatedTmux(): { socket; tmux(...args): string; kill(): void }`, a `tmux -L test-<uuid>` server whose commands run without `TMUX`/`TMUX_PANE`, and whose `kill()` returns only once the server is gone, then removes its socket file.

### The hub's transcript reader (`apps/hub/src/adapters/claude-sessions.ts`, Task 3; Task 4 removes the synchronous wrappers)

```ts
export const MAX_LINE_BYTES = 8 << 20;        // a longer line is one "A message too large to show." (id too-large-<offset>)
export const OLDER_WINDOW_BYTES = 4 << 20;    // an older page reads one window of at most this before its anchor
export type TranscriptCursor = { offset: number; pending: Set<string>; sends?: Map<string, (string | null)[]>; latest?: number;
  carry?: Uint8Array[]; skip?: { from: number; shown: boolean } };      // Task 4 drops `path` with readTranscript
export function feedTranscript(cursor: TranscriptCursor, bytes: Uint8Array, agent: string, maxLine?: number): Parsed;   // pure
export type FollowOptions = { tailBytes?: number; chunk?: number; budget?: number; maxLine?: number };
export function followTranscript(src: TranscriptBytes, cursor: TranscriptCursor, agent: string, o?: FollowOptions): Promise<Parsed>;
export type OlderPage = { messages: Message[]; done: boolean; files: FileRef[]; missing?: true; resume?: { id: string; end: number } };
export type OlderOptions = { limit?: number; from?: number | undefined; window?: number; chunk?: number; maxLine?: number };
export function olderPage(src: TranscriptBytes, agent: string, beforeId: string, o?: OlderOptions): Promise<OlderPage>;
// Task 3 keeps readTranscript/readOlder as synchronous wrappers; Task 4 deletes them, runSync and onFile.
// A source that throws (Task 4's SourceUnavailable among others) leaves the cursor exactly as it was: followTranscript
// rethrows before it moves anything, so the next follow reads the same bytes again.
```

### Hub ports (`apps/hub/src/application/ports.ts`, Task 4; `HubPorts` and the hub's `Terminal` Task 14)

Every shape below is written in its final form by Task 4 (so later tasks change no port signature); `SendOutcome.store`, `SendStatus`'s store, `SendInDoubt` and `SourceUnavailable` are defined there and given their meaning by Task 14's fleet adapters.

```ts
import type { SendProblem, SessionInfo, Terminal } from "@morndo/node-ops";
export type SendOutcome = { problem: SendProblem | "node_offline" | null; typedAt: number;   // typedAt: the node's clock
  store?: string | null };                                                                   // Task 14: the answering node's store
export type Tmux = {
  // Every window of every node, each with its node (legacy: node "local", offline false, no conflict). Fleet (Task 14):
  // built from each node's inventory, never from the lane registry's one row per name, so two windows of one name are
  // both listed; `conflict` is the lane registry's flag for that name (optional: the legacy adapter never sets it).
  listWorkers(): Promise<{ id: string; name: string; location: string; node: string; offline: boolean; conflict?: boolean }[]>;
  capture(id: string): Promise<string | null>;
  captureMany(ids: string[]): Promise<Map<string, string | null>>;
  send(id: string, text: string, key: string): Promise<SendOutcome>;   // key: the caller's (the fleet adapter adds "hub:")
};
export type SendStatus = (id: string, key: string) =>
  Promise<{ state: "unknown"; store: string } | { state: "started" | "offline" } | { state: "done"; typedAt: number }>;
  // done: the node's stored typedAt; unknown: the store that answered (Task 14)
// Task 14: the fleet adapter's send throws this when the node may have typed (executed "maybe"), with the store the
// request went to (null when the fleet never answered), so the caller can keep the store with its row in doubt.
export class SendInDoubt extends Error { readonly store: string | null }
// Task 4: a transcript source that can't answer now (node offline, the fleet down or slow) throws this; null from size
// or read means the transcript is gone. Observation keeps its place on SourceUnavailable and tries again on the next
// poll; it resets a follow only on null.
export class SourceUnavailable extends Error {}
export type Sessions = { byPane(): Promise<Map<string, SessionInfo>> };   // pane = worker ID
export type TranscriptSource = {
  size(sessionId: string): Promise<number | null>;                       // each method: SourceUnavailable when it can't tell
  read(sessionId: string, offset: number, max: number): Promise<{ bytes: Uint8Array; eof: boolean } | null>;   // may be short
  locate(sessionId: string, needle: string): Promise<number | null>;
};
// Task 14: a keystroke whose node may have typed it (the connection dropped) is "uncertain", shown as "may have been
// typed", never as refused. The hub's Terminal (Task 14) is node-ops' with this keys():
//   keys(id: string, data: string): Promise<boolean | "uncertain">;
// and the terminal socket answers it { t: "error", error: "keys_uncertain" } (a refusal stays "keys_refused").
export type RemoteFiles = { register(workerId: string, path: string): Promise<{ id: string | null; size: number | null }> };
export type UploadSink = { stage(upload: Upload, workerId: string): Promise<{ ok: true; path: string } | { ok: false; problem: "no_pane" | "too_large" | "node_offline" }> };
export type NodeState = "online" | "stale" | "offline";
export type NodeStates = () => Promise<ReadonlyMap<string, NodeState>>;   // a node missing from the map is not online
export type HubPorts = {                                                  // Task 14
  tmux: Tmux; terminal: Terminal; sessions: Sessions | null; transcripts: TranscriptSource | null;
  files: RemoteFiles; uploads: UploadSink; sendStatus: SendStatus | null; nodeStates: NodeStates | null;
};
```

**No desktop in fleet mode** (Task 14; spec §3.1; reversed by spec §16.1 on 2026-10-08: the hub offers the desktop `MORNDO_VNC` names in both modes). With `MORNDO_FLEET_SOCKET` set the desktop target is null whatever `MORNDO_VNC` says, so `RemoteService.open({ kind: "desktop" })` answers `no_desktop` and `/api/me` reports no desktop; a test pins it.

**Fleet unavailable** (Tasks 14, 15b; spec §7). When `listWorkers` fails, or the fleet socket can't be reached, the hub keeps the last roster but marks every worker offline (its state is unknown, so not online; no third state), asks no node, and says so: `ObservationService.fleet(): "ok" | "unavailable"` (legacy: always `"ok"`) and `Listener.fleet?(status: "ok" | "unavailable")`, called once on each change. The feed sends a frame `{ t: "fleet", available: boolean }` right after the snapshot (or the resumed events) of every hello, and on every change (Task 15b; a legacy hub sends `available: true`, and a hub from before the fleet never sends it, which the app reads as available). The app shows "Fleet unavailable" as a banner in both layouts while `available` is false. An older page asked while the fleet is unavailable comes back `missing`, which the app shows as Try again.

**Listing waits at most 300 ms per node** (Task 14; spec §3.1). `listWorkers` uses each node's latest inventory, and asks a node whose inventory is missing or behind for a new one, waiting at most `LIMITS.inventoryWaitMs` for it; the refresh goes on in the background, and each node's answer is applied as it lands. A hung `inventory.get` on one node never holds the listing.

**Hub services and builders.**

```ts
// apps/hub/src/adapters/local-node.ts (Tasks 4, 5): this machine as the one node "local"
export const LOCAL_NODE = "local";
export function localTmux(tmux: PaneTmux /* node-ops' Tmux */): Tmux;
export const localSessions: (registry: Pick<Registry, "byPane">) => Sessions;
export function localTranscripts(registry: Pick<Registry, "transcriptPath">): TranscriptSource;
export const localUploads: () => UploadSink;
export const localFiles: (files: Pick<Files, "register">) => RemoteFiles;
// apps/hub/src/adapters/local-ports.ts (Task 14)
export function legacyPorts(config: Config, deps: { files: Pick<Files, "register"> }): HubPorts;   // sendStatus null, nodeStates null
export function desktopTarget(config: Config, fleet: boolean): DesktopTarget | null;                // null in fleet mode: no_desktop (since spec §16.1: desktopTarget(config), MORNDO_VNC in both modes)
// apps/hub/src/application/observation-service.ts (Tasks 4, 5)
new ObservationService(tmux: Pick<Tmux, "listWorkers" | "captureMany">, quietAfterMs: number, now?: () => number, o?: ObservationSources);
export type ObservationSources = { sessions?: Sessions | null; transcripts?: TranscriptSource | null; files?: RemoteFiles | null;
  nodeStates?: NodeStates | null; nodeWaitMs?: number };
older(id: string, before: string): Promise<OlderResult>;   // OlderResult = { messages: Message[]; done: boolean; missing?: true }
Listener.attachments?(workerId: string, messageId: string, attachments: Attachment[]): void;
// apps/hub/src/application/steering-service.ts (Task 5; `status` Task 14)
new SteeringService(store, tmux: Pick<Tmux, "send">, now?, policy?, inbox?, waitingOn?, nameOf?, uploads: UploadSink = localUploads(), status: SendStatus | null = null);
// SendResult.problem adds "too_large" | "node_offline"; BEFORE_PASTE (released rows) = no_pane, menu_open, no_input_box, draft_present, busy, node_offline
// apps/hub/src/application/escalation-service.ts (Task 5)
export const answerKey: (id: string, ask: { messageId: string | null; askedAt: number }, choice: Choice) => string;
//   "answer:<id>:<ask>:option:<key>" | "answer:<id>:<ask>:words:<16 hex of sha256(trimmed words)>", where <ask> is the
//   asking message's id, or "t<askedAt>" when it has none: the same tap on a re-asked question is a new answer, typed once
//   per ask; a retry of one answer to one ask is the same key.
// EscalationService deps.send: (pane: string, text: string, key: string) => Promise<SendProblem | "node_offline" | null>
// Task 14: managerOf(workers, managerWindow) is the one worker named config.managerWindow whose name is not in conflict.
// While the name is in conflict (two windows claim it, on one node or two) there is no manager: its asks come from the
// ledger alone, and an answer is refused `lane_conflict`, nothing typed (AnswerResult gains "lane_conflict"; http.ts
// answers it 409 { error: "lane_conflict", item }). #managerSightings and main.ts' managerPane (the pane lock) both use
// managerOf. EscalationService's watch.workers() items carry `conflict?: boolean`; ObservationService.conflicted(id).
// apps/hub/src/adapters/store.ts (Task 5): migration 8 sends.typed_at; (Task 14): migration 10 sends.node_store (9 went to ask_first_seen during execution)
Store.send(key): { state: "started" | "done"; at: number; typedAt: number | null; store: string | null } | null;   // store: Task 14
Store.finishSend(key: string, typedAt: number): void;
Store.setSendStore(key: string, store: string): void;                    // Task 14: the store a send in doubt went to
// (2026-10-07) setSendStore(key, store, storeSeq) keeps the store sequence too (migration 12, sends.node_store_seq), and
// escalation answers keep rows here as sends do (migration 11, sends.worker_id and sends.request; startAnswer)
// apps/hub/src/config.ts (Task 14)
Config.fleetSocket?: string | null;   // MORNDO_FLEET_SOCKET, an absolute path; unset or empty: the legacy adapters
```

**Repeat of a send in doubt** (Task 14, spec §3.1). A send whose node answered "maybe" (`SendInDoubt`) keeps its `started` row and records the store it went to (`setSendStore`). A local `started` row asks `SendStatus`: `done` → `finishSend(key, typedAt)` and `duplicate` with the node's `typedAt`; `unknown` from the **same** store the row recorded → the row is dropped and the send is judged and typed anew; `unknown` from another store, or with no store recorded → `uncertain` (the keys that would tell may be gone with an old agent database); `started` or `offline` (or no fleet) → `uncertain`. Two repeats of one key at once: the second waits for the first's answer (the key is registered as typing before `op.status` is awaited, and the row is read again after it), so one paste at most.

**The hub's answers to a send** (`POST /api/workers/<worker id>/send`, unchanged mapping in `http.ts`): 200 `{ ok: true, at }` (`at` = the node's `typedAt`); 200 `{ error: "duplicate", ok: true, at }`; 403 `step_up`; 404 `no_pane` (also a legacy `%N` the fleet hub doesn't hold); **409 `{ error: <problem> }` for every other refusal, `uncertain` and `node_offline` included**. An attempt whose node answered "maybe" (the connection dropped after `started`) throws and is a 500 `{ error: "internal error" }`, as today; its repeat resolves through `op.status`. (Changed in the fix wave, final review I1: that first attempt is a 409 `{ error: "uncertain" }` too, so the app shows "may have been sent" with Check again, never Not sent; an escalation answer in doubt likewise, and its repeat is settled through `op.status` as a send's is, C1, migration 11.) A send by worker ID is allowed while that worker's name is in conflict: the owner picked one pane, and the node checks its expectation.

### Fleet client (`apps/hub/src/adapters/fleet-client.ts`, Task 14; also used by tests)

```ts
export type NodeStatus = NodeState;   // "online" | "stale" | "offline" (the hub port's type)
export type FleetNode = { name: string; status: NodeStatus; health: Health | null; agent: string | null };
export type FleetLane = { name: string; node: string; workerId: string | null; conflict: boolean };
export type FleetEvent = { t: "inventory" | "health" | "status" | "conflict" | "alert"; node: string; body: unknown };
export type OpTarget = { workerId: string } | { node: string } | { lane: string };
export type OpAnswer<O extends OpName> = { ok: true; result: OpResult[O]; invVersion: number; store: string }
  | { ok: false; error: OpError; store: string | null };   // store: null when nothing was sent to a node; an ok answer
                                                           // without a store string is a FleetMismatch
export class FleetClient {
  constructor(socketPath: string);   // every request names its client: header `x-morndo-client: hub`
  caps(): Promise<{ api: number[] }>;
  nodes(): Promise<FleetNode[]>;
  lanes(): Promise<FleetLane[]>;
  alerts(): Promise<Alert[]>;
  op<O extends OpName>(target: OpTarget, op: O, args: OpArgs[O], opts?: { key?: string; timeoutMs?: number }): Promise<OpAnswer<O>>;
  fileStream(node: string, refOrPath: string): AsyncIterable<Uint8Array>;
  events(on: (e: FleetEvent) => void): () => void;    // reconnects with backoff; the fleet sends the current state first
}
export class FleetUnavailable extends Error { readonly reached: boolean }   // no answer; reached=false: the request never left
export class FleetMismatch extends Error {}                                 // an answer that isn't the client API
export class FleetOpFailed extends Error { readonly error: OpError }        // a refused file, or "maybe" where a value is needed
export function checkFleet(client: FleetClient): Promise<"ok" | "unsupported" | "unreachable">;
// The client waits for an op's answer timeoutMs + 2000 ms, more than the fleet's RESULT_SLACK_MS (1000 ms): the fleet's
// own deadline answer can come up to timeoutMs + 1 s after it queued the op, so a slow node is the fleet's `timeout` or
// `uncertain`, never the client's FleetUnavailable.
// apps/hub/src/adapters/fleet-adapters.ts
export type LocalFileStore = { register(path: string): { id: string | null; size: number | null } | Promise<{ id: string | null; size: number | null }> };
export type FleetTimeouts = { listMs: number; captureMs: number; sendMs: number; keysMs: number; frameMs: number; statusMs: number; transcriptMs: number; fileMs: number };
export const FLEET_TIMEOUTS: FleetTimeouts;   // listMs: the background inventory refresh's op timeout (listing itself waits inventoryWaitMs)
export type FleetPorts = HubPorts & { sessions: Sessions; transcripts: TranscriptSource; sendStatus: SendStatus; nodeStates: NodeStates;
  nodeStatus(node: string): NodeStatus | null; start(): Promise<void>; stop(): void };
export function fleetPorts(client: FleetClient, o: { files: LocalFileStore | null; stagingDir: string; timeouts?: Partial<FleetTimeouts> }): FleetPorts;
```

### Client API (`/v1/` on the fleet's Unix socket; Task 12 serves it, Task 14's client and fake fleet speak it)

| Route | Answer |
|---|---|
| `GET /v1/caps` | 200 `{ api: number[] }` |
| `GET /v1/<other version>/…` | 404 `{ error: "unsupported_api", api: number[] }` |
| `GET /v1/nodes` | 200 `FleetNode[]` |
| `GET /v1/lanes` | 200 `FleetLane[]` |
| `GET /v1/lanes/<name>` (one URL-encoded segment) | 200 `FleetLane` (`conflict: true` while two windows claim it; `workerId: null` when two windows on its owner claim it), or 404 `{ error: "no_such_lane" }` |
| `GET /v1/alerts` | 200 `Alert[]`, oldest first: the latest 500 of the security kinds (`instance_conflict`, `source_changed`, `clock_offset`) and the latest 500 of the others, so no amount of other alerts pushes a security one out; rows older than 90 days are gone |
| `POST /v1/nodes/<name>/revoke` | 200 `{ ok: true, revoked: boolean }`; closes the node's connection with 4403 and drops its lanes, so `GET /v1/lanes` no longer lists them, whichever path revoked it (this route, `morndo-fleet node revoke`) |
| `POST /v1/op` | body `{ workerId? \| node? \| lane? (exactly one), op, args, key?, timeoutMs? }`, `args` required; `expect` travels inside `args` (a top-level `expect` is refused). Always JSON: 200 `{ ok: true, result, invVersion, store }` or `{ ok: false, error: OpError, store }` (`store`: the node's, or null when nothing was sent, Contracts above); 400 for a body that doesn't fit and 415 for one that isn't JSON, both `{ ok: false, error: { code: "bad_args", executed: "no", message }, store: null }`; 413 `too_large` over 1 MiB. Every side-effecting op (the keyed ones and `pane.keys`) is audited: `op.<name>` with `{ target, keyNs, outcome, client }` (`keyNs`: the key's namespace; `outcome`: `ok` or the error code; `client`: the `x-morndo-client` header, `^[a-z]{1,16}$`, else `"unknown"`), never the text, data or bytes |
| `GET /v1/files/<node>/<ref or path>` (each one URL-encoded segment; a value starting with `/` is a path, anything else a relay file's ref; `OP_ARGS` takes absolute paths only, so a `~` path is refused by the node as `bad_args`) | 200 `application/octet-stream` with `x-file-size`; a refusal before the first byte is `{ ok: false, error: OpError }` with 400 `bad_args`, 403 `denied`, 413 `too_large`, 503 `node_offline`, 504 `timeout`, 502 `uncertain`/`internal`, else 404; a failure mid-stream ends the response early |
| `WS /v1/events` | text frames `{ t, node, body }`: first each registered node's `status`, then each online node's latest `inventory` and `health`, then events as they happen, in causal order. A client that falls `eventsBufferBytes` (8 MiB) behind (`bufferedAmount`) is closed with 1013; it reconnects and gets the current state first |

Event bodies: `status` → `{ status: NodeStatus }`; `inventory` → `OpResult["inventory.get"]` (`{ panes, invVersion }`); `health` → `Health`; `conflict` → `{ name: string; nodes: string[] }` (the distinct nodes claiming it, `[]` when the conflict ends; sent before the `lane_conflict` alert it causes); `alert` → `Alert` (the frame's `node` is the alert's node, or `""`). An offline node's last inventory and health are not replayed on subscribe.

Routing: `{ workerId }` goes to its node, whatever the lane registry says of its name (the caller picked that pane); `{ node }` to that node (the agent judges the worker ID inside `args`); `{ lane }` to the lane's node, and for `pane.send` and `pane.keys` the fleet fills in `args.expect = { server, window: <lane> }` unless the caller gave one. An unknown lane is `no_pane`; a lane name two windows claim is `lane_conflict` (`executed: "no"`) for every route by name; `lane.start` of a name registered anywhere in the fleet, or whose `lane.start` is in flight, is `name_taken` (the fleet reserves the name from the request until the registry holds it; after an answer with `executed: "no"` the reservation ends at once, after any other answer it lasts at most 10 s more). A node that isn't online is `node_offline`. Op timeout: 15 s by default, 120 s at most, counted from when the fleet queued the op. A request over 512 KiB is `too_large` and never sent. A result is checked against `OP_RESULTS[op]`; one that doesn't fit is `internal` (`executed: "maybe"`). Keys match `^[a-z]{1,16}:` followed by 1–239 printable ASCII characters.

### Alerts (fleet, Tasks 10–13)

Alerts are audit rows with action `alert.<kind>` plus a log warning, served by `GET /v1/alerts` and the `alert` event. The security kinds (`instance_conflict`, `source_changed`, `clock_offset`) are capped apart from the others (500 each in `GET /v1/alerts`), so other kinds never evict them. Audit rows, alerts included, are deleted after 90 days (`auditKeepMs`), on start and daily.

The audit (Tasks 10–13) also records every side-effecting op (`op.<name>`, actor `client`, the client API table), every join and refused join, every revocation, every admission (`conn.admitted`), every refused hello (`conn.refused`, with its reason and source address), every instance replaced after a missed instance check (`conn.replaced`), and subscriber removals; never text, keystrokes, file bytes or hook bodies. A source over its handshake bucket is only logged (no audit row), so nothing from outside can fill fleet.db.

| Kind | Raised by | When, and how often | `detail` | The alert's `node` |
|---|---|---|---|---|
| `instance_conflict` | Task 11 | another instance is refused (4409) because the live one answered the instance check's ping; once per refused `instanceId` for as long as that live connection lasts (a refused agent's retries every 5 minutes raise none) | `{ live, refused, source }` (the two instance IDs, the refused connection's source address) | the node |
| `source_changed` | Task 11 | a node is admitted from another source address than its last one; each change, never on its first connection | `{ from, to }` | the node |
| `clock_offset` | Task 11 | the offset between `health.wallClock` and the fleet's clock, either way, exceeds 2000 ms plus the last ping's round trip; once, until a report back within that (or a new connection) re-arms it | `{ offsetMs }` (the node's clock minus the fleet's) | the node |
| `rate_limited` | Task 11 | a node's inventory or health messages exceed its token bucket (60 at once, 2 a second; hook events are exempt); the connection closes 1008, so once per connection | `{}` | the node |
| `lane_conflict` | Task 12 | a lane name goes from one claiming window to more than one; each time it goes into conflict | `{ name, claims: { node, workerId }[] }` | the name's owner |
| `dead_letter` | Task 13 | a delivery is dead-lettered (a 4xx other than 408 and 429, or the 20th failed attempt); once per subscriber episode: the first dead letter after a successful delivery to that subscriber (or since start) raises it, later ones count into it until a delivery succeeds again | `{ subscriber, streamId, seq, path, reason, attempts }` of the first one, `reason` `"HTTP <status>"` or `"no answer (<error>)"` | the event's node |
| `backlog_full` | Task 13 | a subscriber's backlog is at 50,000 and a new event finds no `/cc` or `/sl` left to drop (it is dead-lettered, without a `dead_letter` alert); once per subscriber until its backlog is below the cap again | `{ subscriber, cap, droppedProgress, deadLettered }` | the batch's node |
| `unrouted_hook` | fix wave (final review I3) | an event of a script path (`/hook/stop`, `/hook/failure`, `/notify`, `/file`) that no subscriber takes: it is acknowledged and counted per path (`morndo-fleet status`), never delivered; once per path while the service runs | `{ path, events }` (that batch's count for the path) | the batch's node |

### Hook bus delivery (Task 13)

Each delivery is `POST <subscriber url>` with `Content-Type: application/json`, `Idempotency-Key: <node>:<streamId>:<seq>`, and exactly one `HookEvent` as the body. Any 2xx is delivered. 408, 429, 5xx and network errors are retried with exponential backoff; any other 4xx, or 20 failed attempts, makes a dead letter. Order is per `(node, streamId)`. Delivered events and dead letters are deleted after 24 h; a subscriber removed from config has its rows deleted.

### Web: the offline marker and Check again (Task 15b)

```ts
// packages/domain/src/observation.ts
export type ListedWorker = Worker & { offline: boolean };       // what Roster.observeListing takes
RosterEntry.offline: boolean;                                    // roster state, like `state`; Worker itself has no `offline`
FeedBody |= { type: "WorkerOfflineChanged"; workerId: WorkerId; offline: boolean };   // and WorkerAppeared carries `offline`
// packages/protocol/src/feed.ts: `offline` on roster entries and WorkerAppeared reads as false from an older hub
```

The app marks an offline worker in both layouts (the desktop sidebar row and conversation header, the phone's agents list) and keeps it listed. An outbox record in `uncertain` offers **Check again** within the Retry window: one POST with the same request ID; 200 (`duplicate`, or typed now) → Sent with `typedAt: at`; a definite refusal (an answer that says nothing was typed: 404 `no_pane`, 403 `step_up`, 409 with any problem but `uncertain`) → Not sent, with that refusal's words; `uncertain`, a 5xx, a 429, a refusal without a status or no answer → stays Uncertain. The hub's answers are unchanged.

```ts
// apps/web/src/lib/outbox/outbox.ts (Task 15b)
PostOutcome = … | { kind: "refused"; code: string; status?: number } | …;   // status: the hub's HTTP status (device.ts); 409 uncertain is { kind: "uncertain" }
export const definiteRefusal: (o: Extract<PostOutcome, { kind: "refused" }>) => boolean;
//   o.status === 409 || (o.status === 404 && o.code === "no_pane") || (o.status === 403 && o.code === "step_up")
```

While the feed's `fleet` frame says `available: false`, both layouts show a "Fleet unavailable" banner (Contracts, "Fleet unavailable"). In the terminal view, a keystroke the hub answers `keys_uncertain` reads "Those keys may have been typed." (not the refusal's "The pane didn't take those keys.").

### Agent and fleet entry points, files and config

```ts
// apps/node-agent/src/main.ts    `morndo-node join '<join string>'` | `morndo-node run` | `morndo-node status`
// apps/node-agent/src/paths.ts   agentPaths(home) → { configDir: <home>/.config/morndo-node, configFile: …/config.json, policyFile: …/policy.json,
//                                 keyPath: …/node-key.pem, stateDir: <home>/.local/state/morndo-node, dbPath: …/agent.db, statusFile: …/status.json,
//                                 relayFilesDir: …/relay-files, inboxDir: …/inbox }
// apps/node-agent/src/config.ts  AgentConfig { node, fleetUrl, fleetKey, keyPath, dbPath, relayPort, home, policy: Policy }
//   config.json (written by join, mode 0600): AgentConfig without home and policy; relayPort 8787.
//   policy.json (the owner's; join writes the defaults when absent): Policy { ops: OpName[]; session: string; repoRoots: string[];
//   fileRoots?: string[]; lockedPanes: Record<string, string>; tmuxSocket: string | null }, default every op, "main", [], {}, null.
// apps/node-agent/src/test-hooks.ts (created in Task 8, Steps 1–4; `run` loads them in Task 9)  TestHooks, loadTestHooks (below)
// apps/fleet/src/main.ts         `morndo-fleet serve` | `node add <name>` | `node list` | `node revoke <name>` | `status`
//   `status` prints each node's status and, per subscriber, its outbox depth (undelivered events) and its dead letters
//   (count, and the latest one's time and reason) — Task 13 adds those lines.
// apps/fleet/src/config.ts       FleetConfig { listen: { host, port }, socketPath, dbPath, keyPath, publicUrl, subscribers: { name, url, paths }[] }
//   homeOf(env = process.env) = env.HOME || os.homedir()
//   configPath(env = process.env, home = homeOf(env)) = env.MORNDO_FLEET_CONFIG || <home>/.config/morndo-fleet/config.json
//   defaults: listen 127.0.0.1:8791, socketPath <home>/.local/state/morndo-fleet/fleet.sock (directory 0700, owner-checked),
//   dbPath <home>/.local/share/morndo-fleet/fleet.db, keyPath <home>/.local/share/morndo-fleet/fleet-key.pem, publicUrl ws://127.0.0.1:8791/agent
//   loadConfig refuses a listen.host that isn't loopback (127.x.x.x, localhost, ::1): Tailscale Serve terminates TLS in
//   front of it, so the agent endpoint is never plain on the network; and a publicUrl that fails fleetUrlOk.
// apps/hub/src/config.ts         Config.fleetSocket (MORNDO_FLEET_SOCKET)
```

Every path of the agent and the fleet derives from `HOME` (`process.env.HOME || os.homedir()`), never from `XDG_*`, so a test or a QA run gives each process its own `HOME`.

### Agent test hooks (`apps/node-agent/src/test-hooks.ts`)

```ts
export type TestHooks = {
  dropAfterStarted?: string;  // a keyed op whose key contains this: right after `started` is committed (with noDoneKeys: at that
                              // point), the fleet socket is terminated and that op's result discarded; the op runs on. Once per key.
  noDoneKeys?: true;          // negative control: keys are neither recorded nor consulted; op.status answers "unknown"
  noExpect?: true;            // negative control: a worker ID resolves by its pane number alone; `expect` is not checked
  clockOffsetMs?: number;     // added to every wall-clock time the agent reports (typedAt, health.wallClock, HookEvent.at)
  spoolFail?: true;           // every spool write fails, as on a full disk (acknowledgements included)
  fixedStreamId?: string;     // negative control: this stream id (a UUID) instead of the database's own; it is also the
                              // `res.store`, and a restored database is not rotated while it is set
};
export class TestHooksRefused extends Error {}
export function loadTestHooks(env: NodeJS.ProcessEnv, where: { home: string; accountHome: string }): TestHooks;
// MORNDO_NODE_TEST_HOOKS (JSON). Unset or empty: {}. Refused (TestHooksRefused; `run` exits 78 naming why) unless NODE_ENV is
// "test" AND `home` is not the account's own home directory (os.userInfo().homedir, which reads the password database, not
// $HOME). Bad JSON, an unknown key or a value of the wrong type is refused too. `run` logs one warning naming every active hook.
```

**Why this guard.** There is no build step (Node runs the TypeScript as stripped types), so a build-time flag can't remove the hooks. An environment variable alone can leak into a unit file. Every test and the QA drill run the agent with a throwaway `HOME`; the installed agent runs with the account's real home. Requiring both `NODE_ENV=test` and a `HOME` that isn't the account's own makes a production agent refuse to start with hooks, rather than run with them.

### Negative controls, as data (Task 18; spec §12.1)

Every negative control a step describes ("change X to Y, run Z, expected: N failures") is also an entry in `scripts/negative-controls.ts`, so it can be run again without reading the plan. The runner (`node scripts/negative-controls.ts [--only <id>]`) makes one temporary worktree of `HEAD` (`git worktree add --detach`, `npm ci --offline` once), and for each entry: applies the patch, runs the named test files, asserts that they fail (and, when `expect` is given, that the output contains it), then restores the file with `git checkout -- <file>` inside that temporary worktree only. It exits 1 if any control passed. It never touches the checkout it was started from. A scheduled CI job runs it weekly and on demand.

```ts
export type Control = {
  id: string;          // "t8-no-done-keys": t<task>-<what is removed>
  task: string;        // "8", "15b"
  file: string;        // the file the control changes, from the repository root
  find: string;        // exact text, found exactly once in that file
  replace: string;     // what the control puts in its place ("" removes it)
  run: string[];       // vitest files, from the repository root, that must fail with it
  expect?: string;     // a piece of the failure the step names
};
export const CONTROLS: Control[];
```

Controls that need more than one edit, a test hook (`MORNDO_NODE_TEST_HOOKS`) or a browser are entries with `run` naming the file whose own control test applies them (the test's "negative control" case), or are listed in Task 18's table of controls the runner can't express, with why.

Before each control the runner runs its test files unchanged; they must pass, or the control proves nothing (reported `BASELINE`). A control whose `find` text no longer occurs exactly once is `STALE`, and one whose tests still pass with it applied is `PASSED`; each of the three exits 1. `node scripts/negative-controls.ts --check` (read-only: it only confirms every entry's `find` still occurs exactly once) runs in the `ci` job on every push; the full run is `.github/workflows/negative-controls.yml`, weekly and on demand (GitHub runs a scheduled workflow only from the default branch).

## Lanes and order

| Wave | Tasks | Notes |
|---|---|---|
| 0 (serial) | 1 → 2 → 3 | Protocol; node-ops (the move, then `confine`, the tmux rules and test helper, the stamp and health); transcript bytes. Everything else imports these. Task 1 also wires `apps/node-agent` and `apps/fleet` into the tests, the type check and the linter, so that wave 1 shares no lines. |
| 1 (parallel) | **Hub-async:** 4 → 5 · **Agent:** 6 → 7 → 8 → 9 · **Fleet:** 10 → 11 → 12 → 13 | Three lanes. The shared files are `package-lock.json` (Tasks 6 and 10 each add their workspace with `npm install`; if git can't merge the two, the second to land runs `npm install` again) and the root `package.json`'s `scripts` (Task 10 adds `fleet`). |
| 2 (parallel) | **Hub-fleet:** 14 (needs 4, 5, 12) → 15 → 15b (needs 15) · **Tests:** 16 (needs 8, 9, 12, 13, and Task 14's fleet client, Step 14.6) → 17 (needs 9, 13, 14, 15) | Task 16's harness imports `FleetClient`, so it starts once Task 14's first commit has landed. |
| 3 | 18 (needs all, 15b included) → 19 (docs) → 20 (manual QA; the owner's go-ahead for the PC part) | |

## Task index

Each task, its file and its heading. Start a lane by reading its file's "Lane notes" first.

| Task | Title | File |
|---|---|---|
| 1 | [Protocol: worker IDs and the agent channel](plan/01-foundation.md#task-1-protocol-worker-ids-and-the-agent-channel) | [`01-foundation.md`](plan/01-foundation.md) |
| 2 | [`packages/node-ops`: the machine-local code, moved out of the hub](plan/01-foundation.md#task-2-packagesnode-ops-the-machine-local-code-moved-out-of-the-hub) | [`01-foundation.md`](plan/01-foundation.md) |
| 3 | [Transcript bytes and the parser split](plan/01-foundation.md#task-3-transcript-bytes-and-the-parser-split) | [`01-foundation.md`](plan/01-foundation.md) |
| 4 | [Hub async ports and per-node observation (legacy single-host mode)](plan/02-hub-async.md#task-4-hub-async-ports-and-per-node-observation-legacy-single-host-mode) | [`02-hub-async.md`](plan/02-hub-async.md) |
| 5 | [Files, uploads, keys and the node's typing time](plan/02-hub-async.md#task-5-files-uploads-keys-and-the-nodes-typing-time) | [`02-hub-async.md`](plan/02-hub-async.md) |
| 6 | [Node agent skeleton: config, policy, identity, join, database](plan/03-agent.md#task-6-node-agent-skeleton-config-policy-identity-join-database) | [`03-agent.md`](plan/03-agent.md) |
| 7 | [Connection to the fleet: mutual handshake, backoff, liveness, close codes](plan/03-agent.md#task-7-connection-to-the-fleet-mutual-handshake-backoff-liveness-close-codes) | [`03-agent.md`](plan/03-agent.md) |
| 8 | [Operations](plan/03-agent.md#task-8-operations) | [`03-agent.md`](plan/03-agent.md) |
| 9 | [Hook relay, durable stream, health and inventory events, `morndo-node run`](plan/03-agent.md#task-9-hook-relay-durable-stream-health-and-inventory-events-morndo-node-run) | [`03-agent.md`](plan/03-agent.md) |
| 10 | [Fleet service skeleton: config, key, fleet.db, join codes, console](plan/04-fleet.md#task-10-fleet-service-skeleton-config-key-fleetdb-join-codes-console) | [`04-fleet.md`](plan/04-fleet.md) |
| 11 | [The agent endpoint: join, mutual authentication, instance rules, liveness](plan/04-fleet.md#task-11-the-agent-endpoint-join-mutual-authentication-instance-rules-liveness) | [`04-fleet.md`](plan/04-fleet.md) |
| 12 | [Router, lane registry and the client API on the Unix socket](plan/04-fleet.md#task-12-router-lane-registry-and-the-client-api-on-the-unix-socket) | [`04-fleet.md`](plan/04-fleet.md) |
| 13 | [The hook bus: intake before the ack, ordered delivery, dead letters](plan/04-fleet.md#task-13-the-hook-bus-intake-before-the-ack-ordered-delivery-dead-letters) | [`04-fleet.md`](plan/04-fleet.md) |
| 14 | [Fleet client and fleet adapters in the hub](plan/05-hub-fleet.md#task-14-fleet-client-and-fleet-adapters-in-the-hub) | [`05-hub-fleet.md`](plan/05-hub-fleet.md) |
| 15 | [Worker IDs end to end](plan/05-hub-fleet.md#task-15-worker-ids-end-to-end) | [`05-hub-fleet.md`](plan/05-hub-fleet.md) |
| 15b | [web: offline marker and 'Check again' for uncertain sends](plan/06-web-uncertain-offline.md#task-15b-web-offline-marker-and-check-again-for-uncertain-sends) | [`06-web-uncertain-offline.md`](plan/06-web-uncertain-offline.md) |
| 16 | [Integration of a real agent with a real fleet](plan/07-tests-docs-qa.md#task-16-integration-of-a-real-agent-with-a-real-fleet) | [`07-tests-docs-qa.md`](plan/07-tests-docs-qa.md) |
| 17 | [Chaos and failure drills](plan/07-tests-docs-qa.md#task-17-chaos-and-failure-drills) | [`07-tests-docs-qa.md`](plan/07-tests-docs-qa.md) |
| 18 | [The two-node CI e2e](plan/07-tests-docs-qa.md#task-18-the-two-node-ci-e2e) | [`07-tests-docs-qa.md`](plan/07-tests-docs-qa.md) |
| 19 | [Docs](plan/07-tests-docs-qa.md#task-19-docs) | [`07-tests-docs-qa.md`](plan/07-tests-docs-qa.md) |
| 20 | [The manual QA runbook and its evidence](plan/07-tests-docs-qa.md#task-20-the-manual-qa-runbook-and-its-evidence) | [`07-tests-docs-qa.md`](plan/07-tests-docs-qa.md) |
