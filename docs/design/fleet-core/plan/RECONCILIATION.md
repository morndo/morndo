# Reconciliation log: the fleet core plan (2026-10-06)

Six drafters wrote the plan's parts in parallel against [`plan.md`](../plan.md)'s first Contracts. Each part opened with a "Contract changes requested" preamble. This log records how the parts were made one plan:
- every coordinator decision, as applied;
- every other conflict found, and how it was resolved;
- every change to code a drafter had already executed;
- what is left open, and the claims in the parts that turned out false.

The preambles are gone from the task files. What they asked for, once decided, is in `plan.md`'s Contracts.

The files:

| File | Tasks | Was |
|---|---|---|
| [`01-foundation.md`](01-foundation.md) | 1–3 | part 01, executed |
| [`02-hub-async.md`](02-hub-async.md) | 4–5 | part 02, executed against stand-ins of 1–3 |
| [`03-agent.md`](03-agent.md) | 6–9 | part 03, executed against stand-ins |
| [`04-fleet.md`](04-fleet.md) | 10–13 | part 04, executed against stand-ins |
| [`05-hub-fleet.md`](05-hub-fleet.md) | 14–15 | part 05, type-checked |
| [`06-web-uncertain-offline.md`](06-web-uncertain-offline.md) | 15b | new |
| [`07-tests-docs-qa.md`](07-tests-docs-qa.md) | 16–20 | part 06, type-checked against stubs |

Each lane file now opens with "Lane notes": what that lane relies on, and the decisions that shaped it.

## How it was checked

Every change to executed code was run, not only read. The runs used scratch copies of the repository at `a36464c` (branch `docs/fleet-core-spec`), with Node 24.21.0 (an unpacked copy; this Mac's own Node is 26.3.1), tmux 3.6a, vitest 5.0.3 and npm 11.19.0 on macOS. One run per lane:

| Lane | Tree | Result |
|---|---|---|
| Tasks 1–3 | Part 01's own tree plus every change below. Command: `npx vitest run --project units packages apps/hub` | 89 files, 742 tests. All pass except `pane-lock.test.ts`'s 2 (macOS has no `flock(1)`; they failed before the change too). `npm run check` and `npm run lint` clean. Each new test's negative control was run and fails as the task says. |
| Agent (6–9) | Rebuilt from the plan text alone, on the real Tasks 1–3 | 17 files, 121 passed, 1 skipped (`flock`). The same with `TMUX` set. 21 single-mutation negative controls, all caught. The text's final code is byte-identical to the verified tree. Rerun with the final shared tmux helper: the same 17 files, 121 passed, 1 skipped. |
| Fleet (10–13) | Replayed from the plan text on the real Tasks 1–3 | 116 tests in 21 files, on Node 24.21.0 and on 26.3.1. Three runs under CPU load. 24 negative controls. All 33 "Run/Expected" steps match. |
| Hub (4, 5, 14, 15) | Applied from the plan text on the real Tasks 1–3 | 144 files, 1101 tests (1083 with `MORNDO_HUB_MODES=fleet`). Only `pane-lock`'s 2 fail. `check` and `lint` clean after every task. Every "see it fail" step and every listed control was run. |
| 15b | The same change as one diff, applied on top of the hub lane's tree | 148 files, 1122 tests, Chromium included; only `pane-lock`'s 2 fail. `check` and `lint` clean. |

Tasks 16–20 can't run before Tasks 1–15 exist. They were checked by reading them against the reconciled code: imports, names, files, statuses and commands.

## Coordinator decisions, as applied

1. **The join names its node.**
   - `JoinString` and `Join` carry `node`. The fleet refuses a code bound to another name with 4403; that code stays usable for the right name.
   - Part 03's flow is the one flow: join → `welcome { connEpoch: 1, ackSeq: 0, streamKnown: false }` (placeholder values) → the fleet closes 1000 → the agent writes its key, `policy.json` (if none) and `config.json` (last).
   - Applied in:
     - Task 6: the agent's join, and the fake fleet's close after join;
     - Tasks 10 and 11: `redeem(code, node, publicKey)` with `wrong_node`, and the join welcome;
     - Task 16: the harness's `joinAgent`;
     - Task 18: through the harness;
     - spec §5.1, and ADR-0012.
   - `Welcome.node` was removed: Part 01's schema never had it, and part 04's fleet sent it.
2. **`Hello.streamId` and `Ack.streamId`.**
   - Both were already in Part 01's schemas. Part 04's tests used `"another-stream"`, which is no UUID; they now use UUIDs.
   - The Contracts list every field of every message.
   - Spec §5.2.
3. **The hub's reader names are Part 01's:** `followTranscript`, `olderPage`, `feedTranscript`, `MAX_LINE_BYTES`, `OLDER_WINDOW_BYTES`, `FollowOptions`, `OlderOptions`, and the cursor's `carry`/`skip`.
   - Part 02 dropped its `FollowCursor`/`newFollowCursor` for `TranscriptCursor`, with a new cursor written as `{ offset: 0, pending: new Set() }`.
   - Part 02's Task 4 now deletes the synchronous wrappers. `claude-sessions-older.test.ts` is edited to the async `olderPage`, and all 11 of Task 3's tests are kept rather than rewritten.
   - Task 4 drops `TranscriptCursor.path`.
   - Part 05 uses the same names.
4. **Part 02 vs part 05.**
   - Resolved per part 02's table. Task 4 owns the port shapes, `offline` on listings and `localTmux`. Task 5 owns `"node_offline"` in `SendOutcome`, `BEFORE_PASTE` and the escalation send type.
   - Task 14 no longer edits any of them. It adds `HubPorts` (with `nodeStates`), `legacyPorts` (new `local-ports.ts`, with a test) and `fleetPorts`.
   - One real bug overrode the table: part 05's `SendStatus` answered a bare string, so a `done` repeat could not carry the node's `typedAt`. `SendStatus` now answers an object, `{ state: "done"; typedAt }` among them, and `#settle` calls `finishSend(key, typedAt)`.
   - `NodeState`, `NodeStates`, `HubPorts`, `legacyPorts` and `fleetPorts` are in the Contracts.
5. **Wiring in Task 1.**
   - Task 1 (Steps 14–16) adds both apps to the vitest `units` include, `tsconfig.tests.json` and `.oxlintrc.json` (the `no-console` override).
   - It makes `npm run check` run `npm run typecheck --workspaces --if-present`. Each app's own `package.json` has `"typecheck": "tsc -p ."`.
   - Task 6 no longer touches the root files. Task 10 still adds one line to the root `package.json`, the `fleet` script (`"fleet": "node apps/fleet/src/main.ts"`, Step 1), next to the existing `hub` script; the Lanes table names that file as shared. (Corrected in review round 2: this line used to say neither task touches the root files.)
   - The claim was re-checked. vitest and `tsconfig.tests.json` accept folders that don't exist yet. `tsc -p apps/fleet` before the app exists fails with TS5058, so `check` can't name the apps directly: hence the workspace script. This deviates from the letter of the decision (see Deviations).
6. **Errors, alerts and the client API.**
   - `lane_conflict` (`executed: "no"`) added. `node_offline` kept. `SendOutcome.problem` takes `"node_offline"`, and each item `listWorkers` returns has `offline: boolean`.
   - Alerts: the `Alert` type (Task 1), `GET /v1/alerts`, the `alert` event and `FleetClient.alerts()`.
     - Raised by Tasks 11 (`instance_conflict`, `source_changed`, `clock_offset`, `rate_limited`), 12 (`lane_conflict`) and 13 (`dead_letter`, `backlog_full`).
     - Read by Task 14. Observed by Tasks 17 (drills) and 20 (`qa alerts`).
   - Exact event bodies, the subscriber POST (one `HookEvent`, `Idempotency-Key: <node>:<streamId>:<seq>`), `GET /v1/lanes/<name>` and `POST /v1/nodes/<name>/revoke` are in the Contracts and in Task 12.
   - `FleetUnavailable`, `FleetMismatch`, `FleetOpFailed` and `checkFleet` are in Task 14.
   - `expect` travels inside `args`; the fleet refuses a top-level one.
   - `op.status`'s `done` outcome is the stored result.
   - Clients prefix their own keys (`hub:` in Task 14).
   - Every config path derives from `HOME`.
7. **Agent test hooks** (`apps/node-agent/src/test-hooks.ts`, `MORNDO_NODE_TEST_HOOKS`):
   - Created in Task 8 (Steps 1–4, 7 tests), wired in Tasks 7–9, and each hook exercised by a test there.
   - `dropAfterStarted`: the executor's `afterStarted` plus `FleetConnection.drop()`.
   - `noDoneKeys`: `DoneKeys` disabled.
   - `noExpect`, `clockOffsetMs`.
   - `spoolFail`: `Spool`'s `failWrites`.
   - `fixedStreamId`.
   - The guard: refused unless `NODE_ENV === "test"` **and** `realpath(HOME) !== realpath(os.userInfo().homedir)`. `run` exits 78 naming why, and warns once listing the active hooks.
   - Why this guard: there is no build step to strip hooks, and an environment variable alone can leak into a unit file. A real install always runs with the account's real home. The Contracts give the reasoning.
8. **Security: `lane.start`'s account and resume.**
   - `OP_ARGS` takes `account` matching `^[a-z0-9][a-z0-9-]{0,31}$` (the decision's `^[a-z0-9-]{1,32}$` without a leading `-`) and `resume` as a UUID.
   - Task 1 adds a test with negative controls: accounts such as `-x`, `-` and `--dangerously-skip-permissions`, and resume values such as `--fork-session`, `-r` and a UUID with a suffix.
   - The agent keeps its own check (`args.ts`).
   - Spec §5.3 and §15.
9. **tmux hardening in Task 2.**
   - `tmux-cli.ts`: `tmuxArgv` adds `-u` to every call; `exactSession` gives `=name`; `windowNameArg` doubles `#`. Every node-ops adapter switched to them.
   - The shared helper `packages/node-ops/test/isolated-tmux.ts`: its `kill()` waits until the server is gone and removes the socket file, and it runs tmux without `TMUX`/`TMUX_PANE`. Tests in `tmux-cli.test.ts`, each with a negative control.
   - Task 8 uses them (`tmux-panes.ts`, `lane-ops.ts`), and so does Task 16 (the harness's `tmuxServer`, `openWindow`).
10. **Task 15 decodes per segment.**
    - `http.ts` splits first, then decodes each segment once (`decodeSegment`, `workerIdFromSegment`), for the send route and `staticFile`.
    - The test covers `GET /%` (was 500, now the app shell, 200), a malformed escape and escaped slashes.
11. **New Task 15b: web offline marker and "Check again".**
    - The roster marks offline workers in both layouts.
    - Check again re-sends the same request ID: 200 (duplicate or typed) → Sent; anything else → stays Uncertain.
    - Full TDD with two Chromium test files (narrow and wide).
    - The hub's status for `uncertain`, decided from `http.ts`: **409** `{ error: "uncertain" }`. Every refusal but `step_up` (403) and `no_pane` (404) is 409.
    - A first attempt whose node answered "maybe" stays a throw, so it is a 500 `{ error: "internal error" }`; its repeat resolves through `op.status`.
    - Parts 05 and 07 say the same. Task 17's drill expects 500 for the first attempt.
12. **Spec corrections** were made in place, and each is logged in the spec's new [§15](../README.md#15-corrections-from-the-plan-reconciliation-2026-10-06) (12 items). Section numbering is unchanged.
    - `menu-N` rows are never pruned (§4).
    - `hello.streamId` (§5.2).
    - Alerts through the client API (§5.6).
    - The offline marker and Check again (§3, §3.1, §7).
    - The join flow (§5.1).
    - `lane_conflict` (§4, §5.3).
    - Also: `lane.start`'s formats (§5.3) and the tmux rules (§9).
    - ADR-0012 is updated to match.
13. **Lanes.**
    - 16 needs 8, 9, 12, 13 (and Task 14's first commit, see below).
    - 17 needs 9, 13, 14, 15.
    - 15b needs 15.
    - 18 needs everything.
    - See `plan.md`'s Lanes table.

## Other conflicts found, and their resolution

| # | Where | Conflict | Resolution |
|---|---|---|---|
| C1 | Contracts vs parts 01 and 03 | The Contracts put `stamp.ts` and `health.ts` in node-ops (Task 2). No part created them; part 03 used stand-ins. | Task 2, Steps 26–31, writes them, test first: `stampServer` sets the stamp with `set-option -o`, so it is race-free. |
| C2 | Part 03, Task 9 | `healthProbe(home)` had no socket, so the agent probed the **default** tmux server instead of its policy's. | `healthProbe(home, { tmuxSocket })`; the agent passes `policy.tmuxSocket`. A test kills the isolated server and sees `tmuxOk` turn false. |
| C3 | Part 04, Task 11 | "Whoever holds A's code gets A": the code was not bound to the name. | Decision 1. |
| C4 | Part 04, Task 12 | Results from the node were not checked against `OP_RESULTS`, though the Contracts said so. | Checked; a misfit is `internal` (`maybe`). |
| C5 | Part 04 `op-body.ts` | The key pattern let digits and `-` into the namespace, which the protocol's `^[a-z]+:` refuses, and allowed 257 characters while its message said 256. | `^[a-z]{1,16}:[\x21-\x7e]{1,239}$`. |
| C6 | Part 04 client API vs part 05's client | Body refusals were `{ error }`, and over-size was a plain 400. Task 14's client read both as "not the client API". | Every refusal of `POST /v1/op` is op-shaped (400/415 `bad_args`, 413 `too_large`). File refusals are `{ ok: false, error }` with the Contracts' statuses. |
| C7 | Part 04 events socket | Statuses and the latest data were interleaved per node, and offline nodes' inventory and health were replayed. | All statuses first, then online nodes only. |
| C8 | Part 04 config | An empty `HOME` gave relative default paths. | `homeOf(env) = env.HOME \|\| os.homedir()`. |
| C9 | Part 05 client | `EVENTS` lacked `alert` and `ERROR_CODES` lacked `lane_conflict`, so alert events were dropped and a `lane_conflict` answer was read as a mismatch. | Both added, with tests and controls. |
| C10 | Part 05 | Lint and type errors: `no-base-to-string`, `unbound-method`, a 9th `SteeringService` argument before Step 14.15 added it. Also `Worker` gaining `node` broke node-ops' `tmux.ts`. | Fixed in the text. Task 15 types node-ops' `listWorkers` as `Promise<Omit<Worker, "node">[]>` (Contracts updated). |
| C11 | Part 05 client | On macOS a socket path over 104 bytes fails `connect` with `EINVAL`, which the client counted as "reached", so a send ended in doubt instead of `node_offline`. | `EINVAL` and `ENAMETOOLONG` added to `NOT_SENT`, with a test and a control. |
| C12 | Part 02 | Assumed `pane-lock.test.ts` is in `apps/hub`; Task 2 moved it to node-ops. | The commands run `apps/hub packages apps/web`. The remark about it is corrected (also in 15b). |
| C13 | Part 03, Task 8 | Under the new helper, `lane-worktree-ops.test.ts` started its tmux server before setting `PATH`, so the stand-in `claude` was not found. | The helper now reads the environment on each call; the test order no longer matters. |
| C14 | Part 03, Task 8 | `.oxlintrc.json` still needs the fake-claude fixture entry: Task 1's override doesn't list it, and oxlint reports 2 `no-control-regex`. | Kept in Task 8 (Step 17). It is the only wave-1 edit to a root config file, and no other wave-1 lane touches `.oxlintrc.json`. |
| C15 | Part 06 (now 07) | The harness wrote the policy into `config.json` (the agent reads `policy.json`), and lacked `NODE_ENV=test` with hooks. The manual check ran tmux without `-u`. | The harness writes `policy.json`, reads the config back with the agent's `loadConfig` and asserts the test socket. It sets `NODE_ENV=test`. The runbook writes `policy.json` and stops unless the socket is a test one. |
| C16 | Part 06 (now 07), Task 17 | Expected 409 for the first attempt after the drop. | 500 `internal error` (decision 11). Flapping expects one `instance_conflict` per episode, and the twin's `status` shows the 4409 conflict. |
| C17 | Part 06 (now 07), Task 19 | Agent README listed `home`/`policy` as config keys; fleet README lacked `MORNDO_FLEET_CONFIG`, `hello.streamId` and the new routes. The domain text called every 4xx a dead letter. | Rewritten to the Contracts. FL11 says "a 4xx other than 408 and 429". FL9 names `lane_conflict`. The Alert term lists every kind. |
| C18 | Part 06 (now 07), Task 20 | PC-7 started a server right after `kill-server` (it can meet the dying one). PC-8 expected no offline marker. | A wait loop after `kill-server`. PC-8 expects the marker on pc-scratch only. CP-9 and PC-8 add `qa alerts`. |
| C19 | 15b vs 05 | Worker's `node` is added in Task 15. 15b's roster needs `offline` on listings, but not on `Worker`. | `ListedWorker = Worker & { offline }` and `RosterEntry.offline`. `Worker` itself has no `offline` (Contracts). |
| C20 | Part 05 gaps | Its "menu-N rows are pruned" spec claim. | Spec §4 corrected; part 05's gap note now points there. |
| C21 | Global | vitest 5.0.3's default fake timers fake everything but `nextTick` and `queueMicrotask`, `Date` and `performance` included. A test meaning to move only the wall clock would freeze the monotonic one too. | Global Constraints say which `toFake` lists to use. Tasks 7, 8 and 11 list them; Tasks 10 and 13 inject a clock instead. |
| C22 | Part 04, Task 12 | The `node revoke` CLI test used `execFileSync` against a server in the same process, which deadlocks. | Spawned asynchronously (`execFile`). Rule in Global Constraints. |

No file is created by two tasks: a script compared every "Create" across the parts. The only file two parallel lanes both change is `package-lock.json` (Tasks 6 and 10), as the Lanes table says.

## Executed code that changed

| Task | File | Change | Why |
|---|---|---|---|
| 1 | `packages/protocol/src/fleet.ts` | `lane_conflict` in `ErrorCode`/`ERROR_EXECUTED` (`no`). `AlertKind`, `Alert`. `account()` pattern and `resume: z.uuid()` in `OP_ARGS["lane.start"]`. | Decisions 6, 8 |
| 1 | `packages/protocol/test/fleet.test.ts` | Negative-control test for `lane.start` flags; counts. | Decision 8 |
| 1 | `vitest.config.ts`, `tsconfig.tests.json`, `.oxlintrc.json`, `package.json` | The apps wired in; `check` runs workspace `typecheck`. | Decision 5 |
| 2 | `packages/node-ops/src/tmux-cli.ts` (new), `tmux.ts`, `terminal.ts` | Every call through `tmuxArgv` (`-u`); `exactSession` and `windowNameArg` for the callers that name a session or create a window. | Decision 9 |
| 2 | `packages/node-ops/src/stamp.ts`, `health.ts` (new), `test/stamp-health.test.ts` | Stamp and health probe; `tmuxSocket` option. | C1, C2 |
| 2 | `packages/node-ops/test/isolated-tmux.ts` (new), `tmux-cli.test.ts` | Shared helper: waits for the server, removes the socket file, per-call environment without `TMUX`. | Decision 9, C13 |
| 3 | `apps/hub/src/adapters/claude-sessions.ts` | Notes that Task 4 drops `TranscriptCursor.path` and the wrappers. The deletion itself is in Task 4. | Decision 3 |
| 4 | `ports.ts`, `local-node.ts`, `observation-service.ts` and their tests | `TranscriptCursor`. `offline` on listings. `SendStatus` answers an object. Wrappers deleted. Imports from `@morndo/node-ops`. | Decisions 3, 4 |
| 5 | `steering-service.ts`, `escalation-service.ts`, `main.ts` | `BEFORE_PASTE` includes `node_offline`. Escalation send and `AnswerResult` widened. Exact `main.ts` import edit. | Decision 4 |
| 6 | `apps/node-agent/package.json`, `test/helpers.ts`, `test/fake-fleet.ts` | `typecheck` script. Re-exports the shared tmux helper. The fake schema-checks agent messages and closes 1000 after join. | Decisions 1, 5, 9 |
| 7 | `connection.ts` | `drop()`. | Decision 7 |
| 8 | `test-hooks.ts` (new), `done-keys.ts`, `executor.ts`, `ops-runtime.ts`, `tmux-panes.ts`, `lane-ops.ts` | Hooks, `afterStarted`, discarded replies, `now`. Uses `tmuxArgv`/`exactSession`/`windowNameArg`. | Decisions 7, 9 |
| 9 | `spool.ts`, `agent.ts`, `main.ts` | `failWrites`. `fixedStreamId`, `dropOnce`. Health on the policy's socket; one clock. `run` loads hooks first and exits 78. | Decision 7, C2 |
| 10 | `nodes-store.ts`, `audit.ts`, `config.ts`, `main.ts`, `package.json` | `redeem(code, node, publicKey)` with `wrong_node`. Alerts in the audit. `homeOf`. Join string with `node`. `typecheck` script. | Decisions 1, 5, 6, C8 |
| 11 | `agent-session.ts`, `serve.ts`, test fake agent | Join welcome placeholder, no `node` in welcomes. Alerts. Protocol check on every fleet message. | Decisions 1, 2, 6 |
| 12 | `router.ts`, `requests.ts`, `op-body.ts`, `client-api.ts`, `files-route.ts`, `lane-registry.ts` | `lane_conflict`. `OP_RESULTS` check. `args` required and `expect` inside. Key pattern. Op-shaped refusals. `GET /v1/alerts`. Event order. Conflict body. | Decision 6, C4–C7 |
| 13 | `hook-bus.ts` | `dead_letter` and `backlog_full` alerts; 408/429 retried. | Decision 6 |

Tasks 14, 15, 15b and 16–20 had not been executed before. Their text was changed and then run (14, 15, 15b) or read (16–20) as above.

## Deviations from the decisions

- **`backlog_overflow` is named `backlog_full`.** That is the executed fleet code's name. Two more kinds were added: `rate_limited` (Task 11) and `lane_conflict` (Task 12).
- **`package.json` check:** Task 1 does not name the apps (TS5058 before they exist). `check` runs `npm run typecheck --workspaces --if-present`, and each app brings its own script.
- **Task 16 also needs Task 14's first commit** (Step 14.6, `FleetClient`): its harness imports it.
- **The test hooks file is created in Task 8, not 6.** `FleetConnection.drop()` lands in Task 7 without the hooks; Task 9 wires them into `run`.
- **`POST /v1/op` requires `args`.** Part 04 had it optional; the Contracts table and Task 14 always send it.

## Unresolved

1. **Check again and definite refusals.**
   - Per the decision, any answer but 200 keeps the entry Uncertain. With Task 14, an `unknown` repeat is judged anew and can be refused (`409 stale`, `409 menu_open`, `403 step_up`): nothing was typed, yet the entry reads "May have been sent".
   - A `stale` one never resolves; the principal must Discard it.
   - Mapping refusals other than `uncertain` to Not sent is one line in `#check`. Coordinator's call.
2. **`~` paths in `GET /v1/files`.** `OP_ARGS` takes absolute paths only, so a `~` path always ends as `bad_args` from the node. The Contracts now say "a value starting with `/` is a path". Whether `~` should be expanded somewhere is open.
3. **Linux counts are unobserved.** Every count was observed on macOS. Each Linux count in the steps is the macOS count plus the `flock` test(s); nobody ran them on Linux.
4. **The real fleet and agent against the hub's fleet adapters** are untested until Task 16. Tasks 14 and 15 ran against the fake fleet, which doesn't route `lane_conflict` and whose HTTP statuses no test asserts.
5. **No `from` hint for older pages.** `ObservationService` passes `olderPage` none, so each older page costs one `locate`.
6. **`MORNDO_FLEET_SOCKET` length.** A path that is too long is not refused at startup; the client at least reports it as never reached (C11).
7. **Hub test modes.** `hub-mode`'s legacy mode builds its ports with `local-node.ts` builders, not `legacyPorts`. `main.ts` uses `legacyPorts`, which has its own test.
8. **Window names with a control character** (a tab) are listed but can't be steered through the fleet: `expect.window` refuses control characters. Review Focus 1 says so.
9. **Stale tmux socket files.**
   - `/private/tmp/tmux-501` held about 1,550 `test-*` socket files from earlier runs on this Mac. The helper now removes its own; the old ones are inert, with no servers behind them.
   - The agent lane's subagent once ran a read-only `tmux -L default ls` against the owner's default socket. It printed nothing and changed nothing.
10. **The agent is laxer than `OP_ARGS`** in two places: its `ACCOUNT` allows `_`, and it doesn't require the `^[a-z]+:` key namespace. The fleet refuses first, so nothing reaches it; left as is.
11. **ADR-0008** still says an Uncertain send offers Discard only. It is a decision record and was left alone; `docs/domain.md` S7 (Task 15b) is the current rule.
12. **Failed outbox records** are never dropped (only Sent ones, after a day). A legacy `%N` entry stays in IndexedDB until Discard. This predates the plan; it is noted in part 05.

## Claims in the parts found false

| Part | Claim | What was found |
|---|---|---|
| 02 | `vitest run apps/hub` includes `pane-lock` | Task 2 moved it to node-ops. |
| 03 | Task 6's join test first fails on `ws-text.ts`/`join.ts` | It fails on `../src/identity.ts`. |
| 03 | "Linux 100/100 in seven runs" | Against stubs, and not repeated (see Unresolved 3). |
| 04 | Its verification | It ran only on the stand-in. Against the real protocol, 54 tests failed and 7 files had type errors. |
| 04 | "Whoever holds A's code gets A" (as safe) | The code wasn't bound to the name (C3). |
| 04 | The fleet checks results | It didn't check them against `OP_RESULTS` (C4). |
| 05 | Lint and the type check are clean | Four errors (C10). |
| 05 | The smoke run exits 124 | It now exits 0 and is portable (no `timeout(1)` on macOS). |
| 06 | The harness configures the agent's tmux socket | It wrote the policy where the agent never reads it (C15). |
| 06 | The first send after the drop is 409 | It is 500 (decision 11). |

## Edits per part

Changed regions (diff hunks) against each drafter's file, with the lines added and removed:

| File | Regions | Lines added | Lines removed |
|---|---|---|---|
| `01-foundation.md` | 27 | 457 | 69 |
| `02-hub-async.md` | 109 | 201 | 235 |
| `03-agent.md` | 217 | 776 | 298 |
| `04-fleet.md` | 210 | 538 | 407 |
| `05-hub-fleet.md` | 188 | 487 | 332 |
| `07-tests-docs-qa.md` (from part 06) | 80 | 142 | 185 |
| `06-web-uncertain-offline.md` | new: Task 15b, about 1,170 lines | | |

`plan.md` was rewritten as the index: Global Constraints, Review Focus, the reconciled Contracts, Lanes and the Task index. The spec and ADR-0012 were edited in place.

## Review round 2 (2026-10-06)

Two independent reviews of the reconciled plan (d752906) came back: an **executability** review, which ran Tasks 1–3, 6 and 10 exactly as written, and a **coverage** review, which held the plan against the spec. Their 34 items (9 must-fix, 11 medium, 14 low) were all fixed in this round. The spec (§3, §3.1, §4, §5–§5.6, §7, §8, §9, §12, and a new part of §15) and ADR-0012 were updated where behaviour changed.

### How it was done and checked

1. The coordinator wrote the round-2 contracts into `plan.md` first (Branches and worktrees, Global Constraints, Contracts, Negative controls as data), so every lane worked against one text.
2. The coordinator fixed Tasks 1–3 on a copy of the executability review's Wave-0 tree and published it (`plan-fix/wave0`, `wave0-r2`).
3. One agent per lane file then fixed its tasks and ran them in a scratch tree built from the plan text on that foundation: agent (03), fleet (04), hub (02 and 05), web (06, on the hub lane's final tree), tests/docs/QA (07). Lanes edited only their own file; contract changes came back to the coordinator, who folded them into `plan.md`, the spec and the ADR.
4. The coordinator re-ran every lane's suite from its tree, and checked each tree against its text. It then merged all lanes into one tree (`plan-fix/merged`: the web tree plus the agent's and the fleet's apps, the root `fleet` script, the fixture's lint override, a lock file with both workspaces) and ran `npm run check`, `npm run lint`, the agent and fleet suites, **Tasks 16 and 17 for the first time**, Task 18's two-node e2e and every negative control there.

All runs: macOS 25.5, Node 24.21.0 (the unpacked copy; 26.3.1 where stated), tmux 3.6a, vitest 5.0.3, git 2.50.1, Playwright 1.63.0 with headless Chromium. Scratch trees live under the session scratchpad's `plan-fix/`. Nothing was committed in the repository.

### Decisions made in this round (beyond the brief's)

- **`store` is on the `res` envelope**, not inside each op's result: every answer carries it, `op.status` included. The fleet stamps its own answers after it sent a request (`uncertain`, `timeout`, `node_offline` for a read whose connection dropped) with the store of the connection it went out on (`hello.streamId`); refusals before sending carry `null`.
- **The hub keeps the store with the row in doubt** in Task 14 (migration 10, `sends.node_store`; 9 went to `ask_first_seen` during execution), recorded from the answer (`SendOutcome.store`, or the new `SendInDoubt.store` when the node answered "maybe"). An `unknown` from another store, or with **no store recorded** (the fleet never answered), is `uncertain`: strictly conservative, so such a send stays in doubt until Discarded.
- **`SourceUnavailable`** is Task 4's (`ports.ts`). Task 3 makes the follow put its cursor back on any throw: fixing item 15 showed that, before, the lines parsed from the reads that had come back were dropped with the error while the cursor had moved past them (lost for good).
- **`tmuxLiteral` replaces `windowNameArg`.** The audit (tmux 3.6a) found `new-window -n`/`-c`, `new-session -s`/`-n`/`-c` and `rename-window` expanded; a `#(…)` expanded to nothing and no job ran within 2 s; a window target is a pattern and is split at `.`; `display-message -p -t` with a target that matched nothing printed the current window, exit 0. Hence "target by ID only" in the Global Constraints.
- **The deny list** uses `*` prefixes (`~/.local/share/morndo*`, `~/.local/state/morndo*`, `~/.config/morndo*`) through a shared `deniedBy`, which the hub's `files.ts` uses too; each account's `.credentials.json` is refused by `SECRET_NAME` wherever it is, rather than by a `~/.claude-accounts/*` glob. `openNoFollow`/`openConfined` live in node-ops, so the agent's file ops and relay share them.
- **`fleetUrlOk`** lives in the protocol and the join string enforces it, so `node add` can't print, and `join` can't take, a plain `ws://` to another host.
- **Branch names** in `OP_ARGS` are a superset-safe form of git's rules (compared with `git check-ref-format --branch`); the agent asks git as well.
- **Fleet unavailable** marks workers `offline: true` (no third state) and sends a `fleet` frame; the web shows a banner.
- **Handshake rate limiting** closes with 1013 and only logs: no alert and no audit row, so nothing from outside can fill the alerts or fleet.db.
- **Alerts:** the three security kinds and the others are capped at 500 each in `GET /v1/alerts`; audit rows are kept 90 days.
- **Clients name themselves** with `x-morndo-client` (the hub sends `hub`); the audit records it.
- **`LIMITS`** gains `instancePongMs` 3000, `conflictRetryMs` 300 000 (±20 %), `inventoryWaitMs` 300, `bulkQueueMax` 8, `eventsBufferBytes` 8 MiB, `handshakeBurst` 10 and `handshakeRefillMs` 6000, `auditKeepMs` 90 days; `agentPingTimeoutMs` is 35 000.
- **Negative controls are data** (`plan.md`, "Negative controls, as data"; Task 18's runner). Every lane reported its controls in that form.

Where the round followed the brief's decision but differs in detail, with why:
- **Item 6, `file.put`:** the hash covers `upload` and `offset` as decided, not the chunk's bytes.
- **Item 4:** `listWorkers`' `conflict` is optional (`conflict?: boolean`), so the legacy adapter and existing test literals stay valid.
- **Item 12:** "unknown" workers are `offline: true`; an older page asked while the fleet is unavailable answers `missing`, which the app already offers as Try again. A legacy hub sends `{ t: "fleet", available: true }` after every hello; only a hub from before the fleet omits it.
- **Item 19:** `OP_ARGS` already refuses every branch name git refuses (about 1200 fuzzed names agreed), so the agent's git check can't be reached through an op; it is pinned by a `branchNameOk` unit test. Parity also changed three behaviours: unknown argument fields are dropped (never passed to `claude`), a `file.put` name with `/` is `bad_args`, and the agent's own 64-character lane-name rule gave way to `OP_ARGS`' 200.
- **Item 23:** the stream rotates at most once per agent process (a fleet that keeps claiming a higher `ackSeq` can't make it redial forever) and never under `fixedStreamId` (the drills' controls need it fixed).
- **Item 30:** a definite refusal is decided by HTTP status: 409 with any problem (409 `uncertain` is its own outcome), 404 only with `no_pane`, 403 only with `step_up`.
- **Item 31 L1:** removing only the wait loop did **not** make the test fail as written (the socket file is removed either way, so `list-sessions` fails at once). The test now reads the server's `#{pid}` and asserts it has exited after `kill()`; then the control bites (3 of 3).
- **Found while fixing, beyond the 34:** the web had no words for an escalation answer refused `lane_conflict` or `node_offline` (both fell back to a generic error). Task 15b gained Part F for them.

### Per item

R = run-verified (its test and control were run on a tree built from the text); D = a text or doc change, checked by reading or by a run where one applies.

| # | Status | Where | Pinned by | Control |
|---|---|---|---|---|
| 1 | R | spec §5.2, §7; plan.md Instances; Task 11 (`connections.ts`), Task 7 (`connection.ts`, `retry.ts`); Task 17 flapping | `instances.test.ts` (half-open `autoPong: false` → admitted in ~3 s; answering → 4409, one alert); `connection.test.ts` (statuses `[connecting, conflict, conflict]`, retries 240 000 then 360 000 ms); flapping 300 s: one connected, one alert | `t11-no-instance-check`, `t7-4409-no-retry`, `t7-4409-leaves-conflict` |
| 2 | R | Task 2 (`tmux-cli.ts`), Task 8 (`lane-ops.ts`); Global Constraints; spec §4, §9 | `tmux-cli.test.ts` (names, `rename-window`, directories `a#{session_name}b` and `#(touch m)`), `lane-worktree-ops.test.ts` (`lane.start` in those directories; `#{pane_start_path}` = real path; no `m`/`n`) | `t2-tmux-literal`, `t8-c-unescaped`, `t8-n-unescaped` |
| 3 | R | Task 5 (`answerKey`); spec §3.1 | `escalation-answer-keys.test.ts` "a question asked again" (typed once per ask) | `t5-answer-key-without-ask` (`expected [ 'answer:ny-7:t0:option:ship' ]…`) |
| 4 | R | Task 12 (router, registry), Task 14 (roster from inventories, `managerOf`, fake fleet mirrors the registry), Task 16 (`duplicate-names.test.ts`), Task 15b Part F (words); spec §3.1, §4, §7 | `router.test.ts`, `client-api.test.ts`, `fleet-conflicts.test.ts`, and end to end `duplicate-names.test.ts` (2 passed) | `t12-conflict-routed-by-name`, `t12-worker-id-blocked-by-conflict`, `t14-manager-in-conflict`, `t14-no-conflict-flags`; the Task 16 test's own control (one manager left → typed once) |
| 5 | R | Task 1 (`Res.store`), Task 9 (agent), Tasks 11–12 (fleet), Task 14 (migration 10, `SendInDoubt`, `#settle`; 9 went to `ask_first_seen` during execution), Task 17 (b′); spec §3.1, §5.3, §7 | `fleet.test.ts`, `agent.test.ts`, `requests.test.ts` "every answer carries its store", `fleet-steering.test.ts` (a lost agent database; never answered), drill (b′): drop, reset the agent DB, repeat → 409 and one paste | `t1-res-store-required`, `t9-res-without-store`, `t11-store-from-connection`, `t12-no-store-on-refusal`, `t14-store-not-checked`, `t14-unknown-never-trusted`; drill (b′)'s control (`fixedStreamId` keeps the store → typed twice) |
| 6 | R | Task 8 (`done-keys.ts`, `executor.ts`); plan.md Behaviour; spec §5.3 | `done-keys.test.ts`, `executor.test.ts` (the test near the old 03:2610; a refreshed `expect` returns the stored outcome) | `t8-hash-all-args`, `t8-mismatch-bad-args` |
| 7 | R | Task 17 (`statuses()`, flapping, `backAfterDrop`) | the drills, run (all 6 files, 31 tests, with the 300 s soak) | — |
| 8 | R | Task 14 Steps 14.6, 14.12, 14.17, 14.31 | the hub lane's replay: every control now runs after its step's commit, so `git checkout -- <file>` restores it (Step 14.5's control had mutated `fleet-client.ts` while it was still untracked, which `git checkout` can't restore; Step 14.16's restore had undone the change Step 14.17 was about to commit); `git status` clean after each | — |
| 9 | D | Task 20 (`qa.md`): vars files, `BRANCH` once, `NODE` pinned on both Linux hosts, `test hooks are on`, step-up re-check before CP-8, PC-7, PC-8, cleanup of QA paths only | read; the vars-file blocks run locally with a fake `ssh` (written, sourced, a second write refused by `noclobber`) | — |
| 10 | R | Task 2 (`file-rules.ts`, the hub's `files.ts`), Task 5 Step 8 (keeps the hub test), Task 8–9 (`nodeOpener`, relay); spec §5.3, §8 | `file-rules.test.ts` (the control-plane layout), `files.test.ts` (in Task 2 and, async, after Task 5), `transcript-file-ops.test.ts` | `t2-deny-prefix`, `t2-secret-credentials-json`, `t2-open-no-follow`, `t2-hub-files-denied-by`, `t8-opener-wrong-home` |
| 11 | R (docs D) | Tasks 10–13, Task 19; spec §5.2, §5.6, §8 | `audit.test.ts`, `liveness.test.ts`, `agent-auth.test.ts`, `router.test.ts`, `client-api.test.ts`, `delivery.test.ts`; Task 19's READMEs checked against the lanes' code | `t10-alerts-one-cap`, `t10-no-prune`, `t11-no-retention-on-start`, `t11-no-handshake-limit`, `t11-no-admission-audit`, `t12-no-op-audit`, `t13-dead-letter-alert-each`, `t13-dead-letter-episode-never-ends` |
| 12 | R | Task 14 (`fleet()`, `Listener.fleet`), Task 15b Part D (frame, banner); spec §3.1, §7 | `fleet-unavailable.test.ts`, `feed-fleet.test.ts` (protocol, hub), `fleet-unavailable-web.test.ts` (Chromium, wide and narrow) | `t14-fleet-down-throws`, `t15b-no-fleet-frame-*`, `t15b-no-fleet-banner-*` |
| 13 | R | Task 11 (bulk queue), Task 14 (listing ≤ 300 ms, background refresh, client timeout `timeoutMs + 2000`); spec §3.1, §5.2, §7 | `requests.test.ts` (hung transfer, slow node, cap), `fleet-adapters.test.ts` (slow and hung `inventory.get`), drill "a stalled agent (SIGSTOP)" | `t11-bulk-wait-unbounded`, `t11-bulk-full-timeout`, `t11-no-bulk-cap`, `t14-listing-waits` (1006 and 4007 ms against 800) |
| 14 | R | Task 1 (`fleetUrlOk`), Tasks 6–7 (config, connection, join), Task 10 (listen.host, publicUrl); spec §5, §8 | `fleet.test.ts`, agent `config`/`connection`/`join` tests, fleet `config.test.ts` | `t1-ws-loopback-only`, `t6-config-fleeturl`, `t7-plain-ws-dialed`, `t10-listen-anywhere`, `t10-publicurl-plain`; the two-file join control (table in Task 18) |
| 15 | R | Task 3 (cursor restore), Task 4 (`SourceUnavailable`, observation), Task 14 (fleet source); spec §3.1 | `transcript-long-lines.test.ts` "a source that fails mid-follow…", `observation-unavailable.test.ts`, `fleet-adapters.test.ts` | `t3-follow-keeps-place`, `t4-source-unavailable-drops-follow`, `t14-unavailable-as-gone` |
| 16 | R | Task 9 (sender, spool, relay, inbox budget); spec §5.5, §7 | `spool`, `relay-server`, `stream`, file-ops and `agent` tests; drill "the spool can't be written" | `t9-sender-throws`, `t9-held-not-counted`, `t9-relay-no-budget`, `t8-inbox-no-budget`, `t9-budget-ignores-held`, `t9-spoolfail-ack-ok` |
| 17 | R | Task 14 Step 14.23 (nine suites in both modes, plus `http-older`; the legacy-only ones listed with why), Task 18 (runner, `--check` on every push, weekly workflow); spec §12 | 40 tests in legacy, 40 in fleet, 79 in both for the nine suites; the runner (below) | the runner's own self-checks (`PASSED`, `STALE`, `BASELINE` all exit 1) |
| 18 | D | every lane file | `grep` for chained Run lines: none left | — |
| 19 | R | Task 1 (branch names), Task 8 (`args.ts`) | `fleet.test.ts` (branch names), `executor.test.ts`, `lane-worktree-ops.test.ts` (`fix/login`) | `t1-branch-names`, `t8-args-without-op-args`, `t8-key-on-unkeyed-op`, `t8-branch-git-check-off` |
| 20 | R | Task 15b Step 15b.34 (was 15b.19) | run: `npx vitest run apps/web packages apps/hub`, 156 files, 1195 tests (1194 before Task 5 kept Task 2's test, see Hub) | — |
| 21 | R | Task 14 (`#settle`) | `fleet-steering.test.ts`: two concurrent repeats → one status call, one paste | `t14-repeat-not-registered` |
| 22 | R | Task 12 (router reservation) | `router.test.ts` | `t12-no-name-reservation` |
| 23 | R | Tasks 6, 9 (`rotateStreamId`, `Spool.lastSeq`) | `stream.test.ts`, `db.test.ts` | `t9-no-rotation`, `t9-rotation-not-stored`, `t6-rotate-not-stored` |
| 24 | R | Task 12 (`client-api.ts`) | `client-api.test.ts` (a paused client) | `t12-events-unbounded` |
| 25 | R | Task 14 (hub `Terminal`, `http.ts`), Task 15b Part E (words) | adapter, `http-terminal-throws` and `terminal-keys-web` (Chromium) tests | `t14-keys-uncertain-as-refused`, `t14-http-keys-refused`, `t15b-keys-one-wording` |
| 26 | R | Task 1 (`WORKER_ID`) | `worker-id.test.ts` "one pane has one ID" | `t1-worker-id-leading-zeros` |
| 27 | R | Task 1 (`LIMITS`), Task 7 | `fleet.test.ts`, `connection.test.ts` (exactly 35 s, fake timers) | `t7-ping-timeout-20s` |
| 28 | R | Task 17 (restart drill posts while the fleet is down; clock drill imports `matchEchoes`) | the drills, run: restart drill `1 repeated deliveries, each deduplicated by its key`, clock drill passed | the clock drill's own control (no `typedAt` misses the echo) |
| 29 | R | Tasks 8, 9 | `pane-ops.test.ts` (a late lock never types), `agent.test.ts` (prune wired) | `t8-late-lock-types`, `t9-prune-not-wired` |
| 30 | R | Task 15b Part C (`definiteRefusal`), `docs/domain.md` S7/S8 text | `outbox.test.ts` (five definite refusals Not sent; 500, 502, no status, no answer, 429 stay Uncertain), `outbox-web.test.ts` | `t15b-every-refusal-definite`, `t15b-check-blind-to-refusals`, `t15b-check-new-id` |
| 31 | R/D | L1: Task 2 Steps 21, 24 (R). L2: Tasks 6, 10 `chmod +x` (R: committed `100755`). L3: plan.md `configPath`/`homeOf` (D). L4: decision 5 above (D). L6: Tasks 11, 12 (R). L7: Task 13 `status` (R), Task 19 docs (D). L8: plan.md, 03 lane notes (D) | `tmux-cli.test.ts` (pid), `status.test.ts`, revoke test | `t2-kill-waits`, `t2-kill-removes-socket`, `t12-revoked-offline-lanes-kept`, `t13-status-no-bus` |
| 32 | D | plan.md "Branches and worktrees" (integration `feat/fleet-core`, a branch and worktree per lane, merge order, `npm ci` and `npx playwright install chromium`), Global Constraints (macOS counts; record Linux on first CI run) | — | — |
| 33 | R | Task 14 (`desktopTarget`); spec §3.1 | `local-ports.test.ts` | `t14-fleet-desktop` (reversed by spec §16.1 on 2026-10-08: now `rollout-fleet-desktop`, `rollout-desktop-unset`) |
| 34 | R | Task 11 (`agent-session.ts`) | `agent-auth.test.ts` (over 512 KiB and over 1 MiB both 1009; a small bad message 1003) | `t11-no-1009` |

### Runs per lane

#### Foundation (Tasks 1–3), run on `plan-fix/wave0`

The executability review's Wave-0 tree (`plan-review-A/repo`, tag `wave0`: Tasks 1–3 applied exactly from the d752906 text) was copied to `plan-fix/wave0`, the round-2 changes were made there and run, and the plan text was then rebuilt from the tree. A check rebuilt every changed file from the new plan text alone onto `wave0` and compared it with the verified tree: no difference (`git diff` empty). The later change to the `kill()` test (e465781) was copied into the text from the tree the same way.

Where: macOS 25.5, Node 24.21.0 (the unpacked copy), tmux 3.6a, vitest 5.0.3, git 2.50.1.

| Item | Task, step | Change | Pinned by | Control (observed) |
|---|---|---|---|---|
| 26 | 1, Steps 3, 5, 7 | `WORKER_ID`'s pane number has no leading zeros: `(0\|[1-9]\d{0,8})`; the server keeps its 8 hex digits | `worker-id.test.ts` "one pane has one ID…" | old `\d{1,9}` → `pc.3fa2c1d0.012: expected { Object (node, server, ...) } to be null` |
| 27 | 1, Steps 8, 9 | `LIMITS.agentPingTimeoutMs` 35 000, asserted `> 2 × pingMs` | `fleet.test.ts` "limits are the spec's numbers" | (a number; Task 7's tests use it) |
| 1, 13, 11, 14 | 1, Step 9 | `LIMITS` gains `instancePongMs` 3000, `conflictRetryMs` 300 000, `inventoryWaitMs` 300, `bulkQueueMax` 8, `eventsBufferBytes` 8 MiB, `handshakeBurst` 10, `handshakeRefillMs` 6000, `auditKeepMs` 90 days | `fleet.test.ts` "limits" | — |
| 14 | 1, Steps 8–10 | `fleetUrlOk(url)`: `wss://…`, or `ws://` only to `127.x.x.x`, `localhost`, `[::1]` (no `URL()`: the package has no DOM/Node types); a join string's `url` must pass it, so `formatJoinString` throws and `parseJoinString` is null otherwise | `fleet.test.ts` "ws:// only to this machine's loopback…" (7 accepted, 13 refused incl. `127.0.0.1.nip.io`, `127.0.0.1@evil.example`, `[::2]`, `127.0.0.256`) | `\|\| /^ws:\/\/[!-~]+$/.test(url)` → `ws://100.64.0.1:8791/agent: expected true to be false` |
| 5 | 1, Steps 8–10 | `Res.store` (a UUID) required on both branches | `fleet.test.ts` "tells a t it doesn't know from a malformed message…" (a `res` without `store`, and one with `store: "store-1"`, are malformed) | `store: z.exactOptional(z.uuid())` → `…"ok":true,"result":{}}: expected 'ok' to be 'malformed'` |
| 19 | 1, Steps 8–10 | Branch names (`worktree.add` `name`/`base`): `/` allowed; not starting `-`/`.`/`/`; no `..`, `//`, `/.`, `@{`; no component ending `.lock`; not ending `/`/`.`; not `HEAD` | `fleet.test.ts` "worktree.add: branch names as git takes them…" (6 accepted, 24 refused) | the old laxer pattern → `a//b: expected true to be false`. Compared with `git check-ref-format --branch` on all 30 names: accepts none git refuses (it accepted `HEAD` until excluded) |
| 2 | 2, Steps 21–25 | `tmuxLiteral` replaces `windowNameArg` (the one helper); `tmux-cli.ts`' comment lists the format arguments and the never-by-name target rule; Global Constraints and spec §9 likewise | `tmux-cli.test.ts` "doubles #… made or renamed" (`-n`, `rename-window`) and "a directory arrives as asked for, and a #(…) in it runs nothing" (directories `a#{session_name}b` and `#(touch m)`; `#{pane_start_path}` equals the real path; no `m` in the server's `HOME` within 500 ms) | `s.replaceAll("#", "##")` → `s`: 2 failures (`a#S b: expected 'amain b'…`; the pane started in `…/amainb`) |
| 10 | 2, Steps 17–20 | `SECRET_NAME` matches `.credentials.json`; `denyRoots` adds `~/.local/share/morndo*`, `~/.local/state/morndo*`, `~/.config/morndo*` (`*` = prefix), `~/.local/share/kira`, `~/.config/kira`; `deniedBy`; `openNoFollow` (`O_RDONLY \| O_NOFOLLOW`); `openConfined` (confine, open, re-check on the open file); the hub's `files.ts` judges by `deniedBy` | `file-rules.test.ts` "refuses the control plane's and every node's own state…" (morndo.db, fleet.db, the agent's db/config/policy, kira's state; a link into morndo.db; each account's `.credentials.json`), "deniedBy", "openConfined" ×2; `files.test.ts` "refuses the fleet's, the agents' and kira's state…" | prefix off → 2 failures (`…/morndo/morndo.db: expected 'ok' to be 'denied'`); `\.?` removed → `.credentials.json: expected 'denied' to be 'secret'`; `O_NOFOLLOW` removed → `promise resolved "FileHandle{…}" instead of rejecting`; hub back to `opts.deny.some(…)` → `fleet.db: expected '<hex>' to be null`. The two old controls still bite (normalize: 1; real-path deny: now 2) |
| 31 L1 | 2, Steps 21, 24 | The `kill()` control keeps the `try` and the socket-file removal and removes only the wait loop. It did not bite at first (the socket file is removed either way, so `list-sessions` fails at once); the tests lane found the server process outlives `kill-server` (pid alive right after, 40 of 40). The helper's test now reads the server's `#{pid}` before `kill()` and asserts it has exited after | `tmux-cli.test.ts` "kill() returns once the server is gone…" (5 of 5 runs pass) | wait loop removed → `server <pid>: expected [Function] to throw an error` (3 of 3); socket-file removal removed → `expected true to be false`. The coordinator's first probe (`pgrep -f <socket>`) said the server was gone 40 of 40: it didn't match the server's process title, so it was wrong; plan.md's note was corrected |
| 15 | 3, Steps 5, 8, 10 | `followTranscript` snapshots the cursor and restores it when the source throws. Found while fixing: before, the lines parsed from the reads that had come back were dropped with the error while the cursor had moved past them, so they were lost for good | `transcript-long-lines.test.ts` "a source that fails mid-follow leaves the cursor as it was, and the next follow reads every line once" (2000 lines; the 2nd read throws; cursor `toEqual` its clone; next follow returns all 2000 once) | restore removed → `expected { …(6) } to deeply equal { …(5) }` |
| 18 | 1–3 | Command chains split: `npm run build` / `npm run check:build`; `tsc -p packages/node-ops` / `tsc -p tsconfig.tests.json` / `npm run lint` (Steps 19, 30) | — | — |

Counts (each command on its own):
- `npx vitest run packages/protocol`: 4 files, 57 tests (was 54).
- `npx vitest run --project units packages apps/hub`: 89 files, 752 tests; only `pane-lock`'s 2 fail (macOS, no `flock`). The same with `TMUX=/tmp/fake,1,0 TMUX_PANE=%99` set, and the same on the Mac's Node 26.3.1. The new tests passed 5 runs in a row. The steps' running totals were corrected: after Task 1 82/713 (was 710), after the move 84/715 (712), after Task 2 87/736 (727), after Task 3 89/752 (742).
- Watch-it-fail steps re-run: Task 2 Step 17 → 9 failed (`confine` ×6, `deniedBy`, `openConfined`, `openNoFollow`); Task 3 Step 7 → 8 failed, 10 passed (`followTranscript` ×3, `olderPage` ×5).
- `npm run check` exit 0 (svelte-check `0 ERRORS 0 WARNINGS`); `npm run lint` no problems; `npm run build` exit 0; `npm run check:build` three PASS, all client JS 301.5 KB gzipped (+9.6 %).

#### Agent (Tasks 6–9), run on `plan-fix/agent`

Built from `wave0-r2` (675a8fa) plus Tasks 6–9 taken from the edited text, one scratch commit per task. A comparison of every "Create/Replace" block with the tree (`agentrecon/extract.py`) found them byte-identical; the coordinator re-ran the suite from that tree: 17 files, 144 passed, 1 skipped (`flock`).

| Item | Task, step | Change | Pinned by | Control |
|---|---|---|---|---|
| 1 | 7 (`connection.ts`, `retry.ts`, status text) | 4409: status stays `conflict` (no `connecting`, `since` kept) and the agent tries again after `RetrySchedule.afterAbout(LIMITS.conflictRetryMs, 0.2)`; 4401/4403 still stop. The status text says it tries again every 5 minutes | `connection.test.ts` (fake timers: statuses exactly `[connecting, conflict, conflict]`, delays 240 000 then 360 000, the two ends of ±20 %), `retryInMs`/text test, `retry.test.ts` `afterAbout`, `agent.test.ts` status | `t7-4409-no-retry` (`expected null to be 240000`), `t7-4409-leaves-conflict`, `t7-no-jitter` |
| 2 | 8 (`lane-ops.ts`) | `-n`, `-c` and `new-session -s` through `tmuxLiteral`. Audit: the `-F`/`display -p` formats are fixed text plus a nonce; targets are `%N`/`@N`; command words aren't expanded (checked on 3.6a) | `lane-worktree-ops.test.ts`: directories `#{session_name}`, `#(touch m)`, `a#Sb ##x`, names with `#(touch n)`; `#{pane_start_path}` equals the real path, names exact, no `m`/`n` | `t8-c-unescaped`, `t8-n-unescaped` |
| 5 | 9 (`agent.ts`) | every `res`, `op.status` included, carries `store` = the current stream id (`fixedStreamId` when set) | `agent.test.ts` | `t9-res-without-store`, `t9-store-ignores-fixed-stream` |
| 6 | 8 (`done-keys.ts`, `executor.ts`) | `EFFECT_FIELDS` and `argsHash` over those fields only; a mismatch on a `started`/`done` key → `uncertain` (`maybe`); a retry with a refreshed `expect` returns the stored outcome | `done-keys.test.ts`, `executor.test.ts` (the test that was near 03:2610, updated) | `t8-hash-all-args`, `t8-mismatch-bad-args` |
| 10 | 8, 9 (`node-files.ts`, `file-ops.ts`, `relay-files.ts`) | `nodeOpener` (on `openConfined`) replaces `nodeConfine`; file ops read the checked handle; relay refs go through `openNoFollow`; the relay copies from the open handle | `transcript-file-ops.test.ts`: the control-plane layout (morndo.db, fleet.db, kira state, the agent's own config) and a link into it are `denied`, a neighbour served | `t8-opener-wrong-home` |
| 14 | 6, 7 (`config.ts`, `connection.ts`, `join.ts`) | plain `ws://` to anything but loopback refused in `loadConfig`, in `FleetConnection`'s constructor (it never dials) and at join | `config.test.ts`, `connection.test.ts`, `join.test.ts` | `t6-config-fleeturl`, `t7-plain-ws-dialed`; the join control needs two files (both checks removed, a real join to `ws://0.0.0.0` went through): listed as not expressible as one entry |
| 16 | 9 (`stream-sender.ts`, `spool.ts`, `relay-files.ts`, `upload-inbox.ts`, `agent.ts`) | `StreamSender` never throws (a failed delete is logged and still opens the window); `spoolFail` also fails acks; one disk budget shared by the spool (`held`), relay copies (503 when full) and the upload inbox (`too_large`) | `spool.test.ts`, `relay-server.test.ts`, `stream.test.ts`, file ops, `agent.test.ts` (budget wiring; a `spoolFail` welcome with an ack) | `t9-sender-throws`, `t9-held-not-counted`, `t9-relay-no-budget`, `t8-inbox-no-budget`, `t9-budget-ignores-held`, `t9-spoolfail-ack-ok` |
| 19 | 8 (`args.ts`, `executor.ts`, `worktree-ops.ts`) | `OP_ARGS[op]` first, then node-only checks; a key on an unkeyed op is `bad_args`; `branchNameOk` runs `git check-ref-format --branch`; `fix/login` makes `<repo>-worktrees/fix/login` | `executor.test.ts`, `lane-worktree-ops.test.ts` (`branchNameOk` unit: `OP_ARGS` already refuses every name git refuses, so the git check can't be reached through an op) | `t8-args-without-op-args`, `t8-key-on-unkeyed-op`, `t8-branch-git-check-off` |
| 23 | 6, 9 (`db/open.ts`, `spool.ts`, `agent.ts`) | `rotateStreamId` and `Spool.lastSeq` (`sqlite_sequence`); a welcome whose `ackSeq` is above `lastSeq` rotates once per process (never under `fixedStreamId`) and redials | `stream.test.ts`, `db.test.ts` (the fake fleet gained `script.streams`) | `t9-no-rotation`, `t9-rotation-not-stored`, `t6-rotate-not-stored` |
| 27 | 7 | ping timeout from `LIMITS` (35 s), at exactly 35 s on fake timers | `connection.test.ts` | `t7-ping-timeout-20s` |
| 29 | 8, 9 | a late pane lock never types (a slow lock seam, runs on macOS); the done-key prune is wired into the agent's start-up housekeeping | `pane-ops.test.ts`, `agent.test.ts` | `t8-late-lock-types`, `t9-prune-not-wired` |
| 31 L2, L8 | 6 Step 25, lane notes | `chmod +x apps/node-agent/src/main.ts`, `test -x` and `git ls-files -s` showing `100755`; lane notes rewritten, no `recon-01`/`d648100` | the steps' own checks | — |
| 18 | 6, 7, 8 | Steps 27, 13, 38 and 21: one command per line | — | — |

Per task: Task 6 24 tests, Task 7 45, Task 8 106 + 1 skipped, Task 9 (whole agent) 144 + 1 skipped in 17 files. The same with `TMUX`/`TMUX_PANE` set; pane-ops and inventory passed three repeat runs. `npm run check`, `npm run lint` and both `tsc` runs exit 0.

Behaviour that changed with argument parity (item 19): unknown argument fields are dropped (the old `flags` case is now accepted, and `claude` never sees them); a `file.put` name with `/` is `bad_args`; the agent's own 64-character lane-name rule is gone (`OP_ARGS`' 200 applies). The account and resume re-checks in `args.ts` repeat `OP_ARGS` exactly, so no control can catch their removal; they stay as defence in depth. Test setup still targets fixed literal windows (`=main:two`), names chosen without `.`, `:` or pattern characters; the code under test targets IDs only.

**Incident.** Running the existing control "health probes another socket" as first written (`healthProbe(config.home)`, no socket) sent one read-only `tmux -u list-sessions` to the default tmux server. Nothing was changed or started. The control is now written with its own socket (`test-control-elsewhere`), was re-run and is still caught, and the lane notes say so.

#### Fleet (Tasks 10–13), run on `plan-fix/fleet`

Rebuilt from the edited text on `wave0-r2` by a step-wise replay (`fleet-scripts/stepwise.py`) that applied every Create/Replace/edit, ran every `Run:` command and every commit block: every fail step failed and every pass step passed with the count the text now gives; 14 commits, a clean tree, `main.ts` committed `100755`. The coordinator re-ran the suite from that tree: 22 files, 136 tests, all pass.

| Item | Task | Change | Pinned by | Control |
|---|---|---|---|---|
| 1 | 11 (`connections.ts`) | `admit` is async: it pings the live connection and waits up to `instancePongMs`, holding no other node. No pong → old connection terminated (`conn.replaced`), newcomer admitted; a pong → 4409 with one alert per refused instance | `instances.test.ts`: a half-open old socket (`autoPong: false`) gives way in about 3 s; an answering one refuses at once; another node is admitted meanwhile; the flap test counts the check's pongs | `t11-no-instance-check` (3 failures) |
| 4 | 12 (`router.ts`, `client-api.ts`) | worker-ID routes go while the name is in conflict; `pane.send`/`pane.keys` by the name → `lane_conflict`; two windows of one name on one node → `{ workerId: null, conflict: true }`, both reachable by ID | `router.test.ts`, `client-api.test.ts` | `t12-conflict-routed-by-name`, `t12-worker-id-blocked-by-conflict` |
| 5 | 11, 12 (`requests.ts`, `client-api.ts`) | every outcome carries `store` (the agent's `res.store`; the connection's hello stream id on the fleet's own answers after sending; `null` before sending, 400/415 included); the scripted agent sends `store` | `requests.test.ts` "every answer carries its store", `client-api.test.ts` | `t11-store-from-connection`, `t12-no-store-on-refusal` |
| 11 | 10–13 | security alert kinds capped apart (500 each) and `Audit.prune()` after 90 days (Task 10, with indexes in migration 1); retention on start and daily (Task 11); joins/hellos rate-limited per source before key work, 1013, logged only (Task 11); `conn.admitted`/`conn.refused`/`conn.replaced`; `op.<name>` audit with `{ target, keyNs, outcome, client }` (Task 12); one `dead_letter` alert per subscriber episode (Task 13) | `audit.test.ts`, `liveness.test.ts`, `agent-auth.test.ts`, `router.test.ts`, `client-api.test.ts`, `delivery.test.ts` | `t10-alerts-one-cap`, `t10-no-prune`, `t11-no-retention-on-start`, `t11-no-handshake-limit`, `t11-no-admission-audit`, `t12-no-op-audit`, `t13-dead-letter-alert-each`, `t13-dead-letter-episode-never-ends` |
| 13 | 11 (`connections.ts`) | at most 8 bulk ops wait per node, then `busy` (store null); a waiting op's deadline runs from enqueue (timed out unsent, or sent with what is left) | `requests.test.ts`: a hung transfer, a slow but answering node, the cap | `t11-bulk-wait-unbounded`, `t11-bulk-full-timeout`, `t11-no-bulk-cap` |
| 14 | 10 (`config.ts`) | `loadConfig` refuses a non-loopback `listen.host` and a `publicUrl` failing `fleetUrlOk` | `config.test.ts` | `t10-listen-anywhere`, `t10-publicurl-plain` |
| 22 | 12 (`router.ts`) | a name is reserved while its `lane.start` is in flight: released at once after `executed: "no"`, else at most 10 s after the answer or when the registry holds it | `router.test.ts` | `t12-no-name-reservation` |
| 24 | 12 (`client-api.ts`) | an events client more than `eventsBufferBytes` behind is unsubscribed and closed 1013 | `client-api.test.ts` (a paused client, a 64 KiB cap) | `t12-events-unbounded` |
| 31 L2 | 10 | `chmod +x apps/fleet/src/main.ts` before the first commit | the commit's mode | — |
| 31 L6 | 11 Step 13, 12 Step 7 | the expected first errors rewritten to what printed; revoke through any path drops the node's lanes (`Connections.revoke` → `onRevoked`, and the sweep also applies revocations written to fleet.db for an offline node); the console's `node revoke` test asserts the lanes are gone | `client-api.test.ts`, console test | `t12-revoked-offline-lanes-kept` |
| 31 L7 | 13, new Steps 15–18 | `morndo-fleet status` prints per subscriber `<name>  <n> waiting  <n> dead letters (latest <time>: <reason>)` | `status.test.ts` | `t13-status-no-bus` |
| 34 | 11 (`agent-session.ts`) | over 512 KiB and over `maxPayload` (1 MiB) both close 1009; a small bad message 1003 | `agent-auth.test.ts` | `t11-no-1009` |
| 18 | 10–13 | every chained step split; `oxlint`'s silent success stated | — | — |

Per task: Task 10 32 tests in 7 files, Task 11 78 in 14, Task 12 118 in 18, Task 13 136 in 22. `tsc` (both), `oxlint apps/fleet`, `npm run lint` clean, `npm run check` exit 0. The suite passed 3 more runs (one with 8 CPU hogs) and on Node 26.3.1. All 23 new controls fail as their steps say on the tree built from the text.

Decided by the lane: a misfit `internal` carries the agent's `res.store` (equal to the connection's on a normal connection); `node_offline` for a read whose connection dropped after sending carries the store (it was sent); an op audit row has actor `client`; the test-fleet helper uses a wide handshake bucket by default (every test connects from 127.0.0.1), and `agent-auth.test.ts` tests the real one. Task 13's stream test uses the fleet's own test spool (`helpers/spool.ts`), not Task 9's.

#### Hub (Tasks 4, 5, 14, 15), run on `plan-fix/hub-v`

Replayed from the edited 02 and 05 onto the foundation (`e465781`), one tagged commit per stage (`t3` to `t15-C`); a second rebuild from the final text gave the same git trees at five stages. Every changed red step was run and its message written into the text; the 20 controls each fail at their stage. The coordinator re-ran the final tree: `npx vitest run apps/hub packages apps/web` 147 files, 1154 tests; `MORNDO_HUB_MODES=fleet` 147 files, 1112 tests; only `pane-lock`'s 2 fail in each. **One more test since:** running every control on the merged tree showed that Task 5 Step 8, which replaces the `keeping copies` block of `files.test.ts`, had dropped the deny-list test Task 2 adds (so `t2-hub-files-denied-by` passed with its guard removed). Step 8's block now keeps it (async), and every total from Task 5 (B) on is one higher; measured on copies of the trees: 147 files, 1155 tests (fleet only 1113), and with Task 15b 156 files, 1195. The table and the steps show the corrected numbers.

| Stage | Files | Tests (both modes) | Fleet only |
|---|---|---|---|
| Tasks 1–3 | 127 | 1006 | |
| Task 4 | 131 | 1021 | |
| Task 5 A / B / C | 133 / 135 / 135 | 1031 / 1041 / 1043 | |
| Step 14.25 | 140 | 1125 | 1086 |
| Step 14.30 | 142 | 1129 | 1090 |
| Task 15 | 147 | 1155 | 1113 |

`npm run check` and `npm run lint` clean at every stage; the timing-sensitive files passed three runs in a row. Items 3, 4, 5, 8, 12, 13, 15, 17, 18, 21, 25 and 33 are in the table above. New names: `desktopTarget` (`local-ports.ts`), `managerOf`, `ObservationService.fleet()`/`conflicted(id)`, `Listener.fleet?`, the hub `Terminal`, `Store.setSendStore`, `SendInDoubt`; the fake fleet gained `clients`, `FakeNode.store` and `resetStore()`, hashes effect fields only and answers a mismatch `uncertain`; an ok `OpAnswer` without a `store` string is a `FleetMismatch`. Still legacy-only, with reasons in Step 14.23: the real-tmux suites, the local-node and local-ports tests, `observation-refollow`, `observation-loop-errors`, `escalation-window`.

#### Web (Task 15b), run on `plan-fix/web`

Built on the hub lane's final tree (`t15-C`) from the edited 06; every file-creating block is byte-identical to the tree. The coordinator re-ran it: `npx vitest run apps/web packages apps/hub` 155 files, 1191 tests, then (after Part F) 156 files, 1194 tests (1195 once Task 5 kept Task 2's test, above); only `pane-lock`'s 2 fail. Chromium: 5 files, 23 tests. `npm run check` 0 errors, `npm run lint` clean, the gallery 5/5.

- Item 30 (Part C): `PostOutcome.refused.status`, `definiteRefusal`, `#check` makes a definite refusal Not sent; S7/S8 in `docs/domain.md`. Fail step 23 failed / 47 passed; pass step 6 files, 78 tests. Controls: Check again as a new send (18 fail), every refusal definite (4), `#check` blind to refusals (6).
- Item 12 (Part D, Steps 15b.18–15b.23): the `fleet` frame (protocol, the hub's feed after every hello and on change), `LiveFeed.fleetAvailable`, a shared `FleetNotice.svelte` in `Desktop.svelte` and `Phone.svelte`. Fail 6 of 6; pass 4 files, 10 tests. Controls: banner removed (each layout), frame after hello removed, frame on change removed; the `fleet` case removed from `feed.svelte.ts` fails `npm run check` (not a vitest control: in Task 18's table).
- Item 25 (Part E): "Those keys may have been typed." for `keys_uncertain`.
- Found while fixing (Part F, Steps 15b.29–15b.32): words for answers refused `node_offline` and `lane_conflict`; `decision-refusals.test.ts` checks that every code the hub can refuse an answer with has words, desktop and catch-up alike. Control `t15b-no-refusal-words`.
- Item 20: the full-suite step (now 15b.34) runs `npx vitest run apps/web packages apps/hub`, so its `pane-lock` note holds.
- The old two-file control of Step 15b.11 is now two single-file entries (`t15b-no-offline-marker-wide`, `-narrow`).

#### Tests, docs, QA (Tasks 16–20)

Edited by its lane, then **run by the coordinator** on the merged tree (`plan-fix/merged`), where Tasks 1–15b exist as the text gives them:
- The merged tree as a whole: `npx vitest run apps/node-agent/test apps/fleet/test` 39 files, 280 passed, 1 skipped (`flock`); `npm run check` exit 0 (svelte-check 663 files, 0 errors); `npm run lint` clean.
- **Task 16** (Steps 1, 2, 4, 5, 6 applied from the text): `npx tsc -p tsconfig.tests.json` exit 0; `npx vitest run --project fleet test/fleet/integration.test.ts test/fleet/duplicate-names.test.ts` 2 files, 14 passed, about 11 s (every test listed as run, none skipped). Afterwards no agent, fleet or hub process and no harness temporary directory was left. Every import in 07's code blocks names an export that exists in the final trees.
- **Task 17**: retry drills 7 passed (85 s), stream 5 (42 s; `fleet restart drill: 1 repeated deliveries, each deduplicated by its key`), nodes 4 (30 s), flapping 1 at 15 s (18 s) and at 75 s (78 s); then the whole `fleet` project as CI runs it, `FLEET_FLAP_MS=300000`: 6 files, 31 tests, 303 s.
- **Task 18**: `npm run build` exit 0; `node e2e/fleet-two-node.e2e.ts` five PASS lines, `5/5 checks passed`, 10 s; the screenshots show alpha and beta listed and the Terminal tab drawing `beta on n2`. Its control (`fleet.revoke("n3")` commented out) gives `FAIL  a revoked node never appears…`, `4/5`, exit 1.
- **The negative-controls runner** (Task 18 Step 8, byte-identical to the file run): 104 entries. Per lane tree, by the tests lane, each group in a copy of its tree: Tasks 1–3 22/22, 6–9 28/28, 10–13 23/23, 4/5/14/15b 31/31 (Chromium headless). `t5-node-offline-kept`'s expected text was widened: in the final tree Task 14's `store` column adds a field to the row (`…(3)` where Task 5's own step, rightly, says `…(2)`). On the merged tree (where CI will run it), by the coordinator: `--check` found all 104 exactly once; the full run (512 s, its temporary worktree removed, `git worktree list` unchanged) had **103/104 bite**: `t2-hub-files-denied-by` reported `PASSED`, because Task 5 had dropped the test that pins it (see Hub above). With Step 8's block fixed, that control bites on the merged tree (`1/1 controls bit`).
- **The whole merged tree:** `npx vitest run --project='!fleet'` (units and Chromium, the hub suites in both modes) 195 files, 1476 tests: 1473 passed, 1 skipped (the agent's `flock` test), 2 failed (`pane-lock`, no `flock(1)` on macOS); plus the `fleet` project's 6 files and 31 tests above. `npm run lint` exit 0.
- Task 19's READMEs and `domain.md` were checked against the lanes' code (the `status` line, the audit actions, retention, the handshake limit, the reservation's lifetime, the 4409 status text, the shared disk budget, the test hooks).
- Task 20 stays read-only (the PC part needs the owner's go-ahead); its vars-file blocks were run locally with a fake `ssh`.

| Task | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15b |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Controls | 5 | 12 | 5 | 2 | 3 | 2 | 5 | 10 | 11 | 4 | 9 | 7 | 3 | 15 | 11 |

Controls the runner can't express are in Task 18's table, each with why (a `tsc` or `svelte-check` failure, a two-file change, an e2e script, an added assertion, the round-1 lane-notes controls that name no exact edit). Drill controls (Tasks 16–17) are tests themselves.

### Round 1's "Unresolved", after this round

1. Check again and definite refusals: **resolved** (item 30).
2. `~` paths in `GET /v1/files`: unchanged.
3. Linux counts: still unobserved; `plan.md` now says each lane records them on its first CI run.
4. The real fleet and agent against the hub's fleet adapters: **resolved**, Tasks 16–18 ran against them on the merged tree.
5. No `from` hint for older pages: unchanged.
6. `MORNDO_FLEET_SOCKET` length: unchanged.
7. Hub test modes build legacy ports with `local-node.ts`: unchanged.
8. Window names with a control character: unchanged.
9. Stale tmux socket files: unchanged (about 1,490 `test-*` files from earlier runs are still in `/private/tmp/tmux-501`; none has a server; none was removed, since this round didn't create them).
10. The agent laxer than `OP_ARGS`: **resolved** (item 19: the agent decodes with `OP_ARGS` first).
11. ADR-0008 and Discard: unchanged.
12. Failed outbox records kept: unchanged.

### Still open after round 2

1. **Linux** (tmux 3.3a/3.4, util-linux `flock`): nothing in this round ran there. The `kill()` wait loop is now shown to matter on tmux 3.6a (the server's pid outlives `kill-server`); the 3.3a collision itself was not reproduced.
2. **Task 20** was not run: its PC part needs the owner's go-ahead, and its control-plane part runs on `cp.example`. Its vars-file blocks were run locally with a fake `ssh`.
3. **An incident.** While re-running the round-1 control "health probes another socket" as first written (`healthProbe(config.home)`, no socket), a test sent one read-only `tmux -u list-sessions` to the default tmux server. Nothing was changed or started. The control now names its own socket (`test-control-elsewhere`) and still bites. (Round 1 recorded a similar read-only `tmux -L default ls`.)
4. **Two temporary homes** (`$TMPDIR/morndo-node-zOi9e2`, 22:36, and `morndo-node-t78Na7`, 22:54) hold a throwaway agent config, policy and test key from a lane's manual CLI checks. They were left in place; the plan's suites don't leave such directories (checked: the agent suite and Tasks 16–17 left none).
5. **Test setup** still targets a few fixed, literal window names (`=main:two`), chosen without `.`, `:` or pattern characters; the code under test targets IDs only.
6. **Round-1 lane-notes controls** of the agent and the fleet that never named an exact edit stay in Task 18's "can't express" table.
7. **`t5-node-offline-kept`** fails with `…(2)` in Task 5's own tree and `…(3)` in the final tree (Task 14's `store` column); the runner's entry matches the final tree, where CI runs it.
8. **The foundation tree's history** is the executability review's `wave0` plus round-2 fix-up commits, not the plan's commit sequence; its end state is what the text rebuilds (checked), and each new watch-it-fail step was run on its own.

### Edits in this round

Changed regions (diff hunks) against d752906, with the lines added and removed:

| File | Regions | Lines added | Lines removed |
|---|---|---|---|
| `plan.md` | 52 | 187 | 51 |
| `README.md` (the spec) | 39 | 91 | 38 |
| ADR-0012 | 9 | 9 | 7 |
| `plan/01-foundation.md` | 78 | 351 | 89 |
| `plan/02-hub-async.md` | 51 | 237 | 61 |
| `plan/03-agent.md` | 244 | 920 | 352 |
| `plan/04-fleet.md` | 231 | 1123 | 247 |
| `plan/05-hub-fleet.md` | 163 | 1800 | 181 |
| `plan/06-web-uncertain-offline.md` | 40 | 710 | 88 |
| `plan/07-tests-docs-qa.md` | 175 | 1175 | 165 |

This log itself gained this section, and decision 5's line about the root `package.json` was corrected (L4).
