# Codex run pricing when resumes overlap (design, 2026-11-09)

**Phase: design only (T-906).** No code. Builds on ADR-0043 decision 3 and replaces its per-thread record. The build adds an ADR that supersedes that decision.

## 1. The problem

ADR-0043 charges a key run the tokens it added to its thread, by subtracting a per-thread record (`codex-usage/<thread>.json`) written at settle. After PR 242 dropped the file lock, two defects remain:

- Runs of one thread that settle out of order read the same base or leave the record too low, so tokens are charged twice.
- `exec resume --last` has no thread id before the run, so there is no start snapshot.

## 2. What Codex records

Read at tag `rust-v0.161.0` (commit `979011409de0`), the version the connections code cites, and checked by running codex-cli 0.161.0 against a local stub endpoint on 2026-11-09. ADR-0043's probe used 0.163.0, so the build re-captures its fixture on the version it ships.

| Fact | Source at the tag |
|---|---|
| One rollout file per thread, `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`. A resume appends to the same file. Each line has a `timestamp` and a rising `ordinal`. | `codex-rs/rollout/src/lib.rs`, `rollout_file_name.rs`, `recorder.rs` |
| After every completed response it appends a `token_usage_record` line: `thread_id`, `turn_id`, `response_id`, `usage` (that response alone), `turn_token_usage`, `thread_token_usage`. A `task_started` line with the same `turn_id` opens each turn. `token_count` lines carry running and last totals. | `codex-rs/protocol/src/protocol.rs` (`TokenUsageRecord`, `TokenUsageInfo`), `rollout/src/policy.rs` |
| `turn.completed.usage` on stdout is the thread's running total, not the run's. `turn.started` has no fields, and `thread.started` has the thread id. | `codex-rs/exec/src/event_processor_with_jsonl_output.rs` (`usage_from_last_total`), `exec_events.rs` |
| One live writer per thread per Codex home. `thread/resume` takes `thread-writer-locks/<thread>.lock` and fails with a conflict if it is held. | `rollout/src/writer_lock.rs`, `thread-store/src/local/live_writer.rs` |
| `--last` is resolved inside Codex, newest thread by update time, filtered by working directory. | `codex-rs/exec/src/lib.rs` (`resolve_resume_thread_id`) |
| After a compaction overflow the totals can be rewritten to the context window with zero input and output counts, so a total can go down. | `protocol.rs` (`fill_to_context_window`) |

Observed with 0.161.0: while one resume of thread T was alive, a second `exec resume T` in the same home exited 1 with "thread T already has an active writer", printed no events and appended nothing. A key run's `CODEX_HOME` is `runtime/<connection>`, shared by its runs, so the lock covers them. Subscription runs have a home per run and are not token-priced: out of scope.

## 3. Options

| | How a run is priced | Verdict |
|---|---|---|
| A. Async lock | Keep the per-thread record. Take an async lease (exclusive create, owner token, heartbeat, expiry) around read, price, write. | Rejected. It brings back PR 242's stale-lock and wrong-owner cases, still has no base for `--last`, and a crashed holder delays or loses a charge. |
| B. Start and end snapshot | Read the thread's total from the rollout before spawn, subtract it from the final `turn.completed` total. No shared record. | Rejected. `--last` has no thread before spawn. For an explicit id, another run can append between the snapshot and Codex taking its lock, so the base is low and that run's tokens are charged twice. |
| C. Own records | After the run, read the thread's rollout and sum the `usage` of the `token_usage_record` lines this run appended. No Morndo record, no lock, no write. | **Chosen.** |


## 4. Decision: option C

Codex already keeps, per response, the exact tokens billed and which turn they belong to. Morndo stops keeping a second copy. After the child exits, with `fs/promises` and off the event loop:

1. Keep from the run: the spawn time, the exit time, the thread id and the number `n` of `turn.started` lines on stdout, and whether the argv has `--json`.
2. Find the rollout. Thread ids are UUIDv7 (the id in the observed file decodes to its creation time, which matches the file's directory), so look in the day directory of that timestamp and its neighbours, not in a walk of the history. Read from the end in bounded chunks.
3. This run's turns are the `task_started` lines timestamped between spawn and exit. There must be exactly `n`. Its records are the `token_usage_record` lines of those turns for this thread. Any other count is null (section 5).
4. Cost is the existing formula (`(input − cached) × input + cached × cache-read + output × output`, model from the argv or the plan) on the sum of their `usage`, rounded once. `cache_write_input_tokens` stays unpriced, as in ADR-0043, because the catalog has no cache-write row. A build that adds one must price it here.
5. The final total `E` on stdout is a log-only cross-check: a difference from the last record's `thread_token_usage` is logged, never used to price (a compaction rewrites totals).

Why: nothing is shared between runs, so settle order cannot matter, and a later run that appended before this one settled is outside the window. Codex's lock makes the window exclusive. At its edges (a predecessor still finishing just after spawn, a successor starting just before the exit was seen) the `n` check gives null, never a wrong charge. The thread comes from stdout, so `--last` needs no special case. `CodexSessionUsageFile`, `keepTotals` and `codexRunCost` go away, and old `codex-usage/*.json` is ignored.

## 5. Failure cases

| Case | Result |
|---|---|
| Two runs of one thread, settles in either order | Each is charged its own turn. The sum equals the thread's growth. |
| Second live resume refused by Codex | Only when argv has `--json`, stdout has no `thread.started` and the exit is non-zero: no request was made, cost 0 (today the reservation). Without `--json` the cost stays null. |
| `exec resume --last` | The thread id is read from stdout. No read before the run. |
| Codex killed mid-run | Price the records of the turns that landed, if there are exactly `n`; log it as partial. A response in flight at the kill is in neither source and is not charged. If a turn never reached the file, null. |
| Morndo killed before settle | No pricing runs. The lease reaper closes at the reservation, as now. The rollout keeps the truth for a later reconcile, not in this build. |
| Rollout missing, compressed, unparsable, no day directory, or turn count not `n` | Null, so the lease keeps the reservation, with one stderr line naming the cause. Never the whole `E` and never a Morndo record. |
| The run spawned child threads (`collab_tool_call` item on stdout) | Their responses are billed in other rollouts. Null for now; adding them is a follow-up. |
| Two homes sharing one sessions directory | Not a key-run layout. The lock would not span them, so the build must return null if one is added. |

## 6. Tests the build writes first

All fail on today's code. Fixtures are rollouts written by the pinned Codex, plus stdout captures.

1. Run 1 and run 2 resume one thread in turn, and run 2 has appended before run 1 settles: run 1 is charged only its turn, and the two sum to the thread's growth, whichever settles first.
2. A refused resume (`--json`, empty stdout, exit 1) is 0. The same without `--json` is null.
3. `--last` argv: priced from the stdout thread, with no read before the run.
4. Killed run (`turn.started`, no `turn.completed`, two of three records landed): two priced, logged partial. Killed before `task_started` landed: null.
5. Missing, compressed, truncated-line and wrong-turn-count rollouts each give null with a named cause. A `collab_tool_call` run gives null.
6. A rollout where `thread_token_usage` drops after a compaction: charged by `usage` only, and the `E` difference is logged.
7. The rollout read and pricing do not block the event loop: a 10 ms timer keeps ticking while a 50 MB rollout is read, only the tail is read, and the day lookup lists at most three directories.
8. An unwritable or missing `codex-usage/` has no effect on the cost.
9. A fixture from the pinned Codex parses, and its version equals the pin in `runtime-codex.ts`.
