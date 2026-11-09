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

1. Keep from the run: the spawn time, the exit time, the thread id and the number `n` of `turn.started` lines on stdout, and whether the argv has `--json`. Without `--json` there is no thread id and no `n`, so the cost is null and the existing `costFromOutput(stdout)` fallback stays as it is.
2. Find the rollout by file name in `sessions`, and in `archived_sessions` for an archived thread. Thread ids from 0.161.0 are UUIDv7, so the day directory comes from the id's timestamp (the observed id decodes to its file's creation time) and its two neighbours. An id that is not v7, or a layout the build's fixture shows to be flat, falls back to one listing capped at 64 directories; otherwise null. Read backwards in bounded chunks, at most 16 MiB in all (more is null), until the earliest selected `task_started` is found. Timestamps give the coarse bound and `ordinal` the cut: the nearest earlier turn-level line (`task_complete`, `turn_aborted` or `session_meta`) must come before it with no other `task_started` between, otherwise null. A turn that ended in `turn.failed` is priced from the responses that landed, like a completed one.
3. This run's turns are the `task_started` lines timestamped between spawn and exit, and there must be exactly `n` distinct ones (open point 1). Its records are the `token_usage_record` lines of those turns for this thread. The `turn_context` line of each turn names its model, which is the model each response is priced at, from the preset's catalog row; no row for it is null. The argv and plan model only choose the row when `turn_context` has none. Any other case is null (section 5).
4. Cost is the existing formula (`(input − cached) × input + cached × cache-read + output × output`, model from the argv or the plan) on the sum of their `usage`, rounded once. `cache_write_input_tokens` goes in as `cacheWrite`, which `charge()` in `spend.ts` prices at the input rate, once open point 3 shows whether it is already inside `input_tokens` (then it is subtracted from input first).
5. The final total `E` on stdout is a log-only cross-check: a difference from the last record's `thread_token_usage` is logged, never used to price (a compaction rewrites totals).

Why: nothing is shared between runs, so settle order cannot matter, and a later run that appended before this one settled is outside the window. Codex's lock makes the window exclusive. At its edges (a predecessor finishing, a successor that started before Morndo saw the exit) the turn-count and ordinal checks give null. A wrong charge would need a clock step and a successor inside the same few milliseconds. The thread comes from stdout, so `--last` needs no special case. `CodexSessionUsageFile`, `keepTotals` and `codexRunCost` go away, and old `codex-usage/*.json` is ignored until a later change deletes it. A rollback to ADR-0043 code would read those older, lower bases and charge too much, not too little.

## 5. Failure cases

| Case | Result |
|---|---|
| Two runs of one thread, settles in either order | Each is charged its own turn. The sum is the `usage` of all their records. |
| Second live resume refused by Codex | Only when argv has `--json`, stdout has no `thread.started`, the exit is non-zero stdout is empty, and the stderr the run kept has "already has an active writer" (the build keeps stderr, unredacted for this match, until settle): no request was made, cost 0 (today the reservation). Any other failure before `thread.started` stays null. |
| `exec resume --last` | The thread id is read from stdout. No read before the run. |
| Codex killed mid-run (no `turn.completed`) | Null, so the reservation stands. A response in flight at the kill is billed but in neither source, so pricing the landed records would under-charge. |
| Morndo killed before settle | No pricing runs. The lease reaper closes at the reservation, as now. The rollout keeps the truth for a later reconcile, not in this build. |
| Rollout missing, compressed, unparsable, not in the day directories, or turn count not `n` | Null, so the lease keeps the reservation, with one stderr line naming the cause. Never the whole `E` and never a Morndo record. |
| The run spawned child threads (`collab_tool_call` item on stdout) | Their responses are billed in other rollouts. Null for now; adding them is a follow-up. |
| A pool moves a thread to a member with another home | Codex there does not know the thread and refuses before any request. The rollout is not found, so null. Each key member has its own home and its own lock. A thread lives in one member's home, so the lock covers it. A layout that shares `sessions` between homes without `thread-writer-locks`, as a subscription run home does, has no lock, so the build returns null for it. |

## 6. Tests the build writes first

All fail on today's code. Fixtures are rollouts written by the pinned Codex, plus stdout captures.

1. Run 1 and run 2 resume one thread in turn, and run 2 has appended before run 1 settles: run 1 is charged only its turn, run 2 only its own, and the two sum to the `usage` of all their records, whichever settles first.
2. A refused resume (`--json`, empty stdout, exit 1, the conflict text on stderr) is 0. The same without the conflict text, or without `--json`, is null.
3. `--last` argv: priced from the stdout thread, with no read before the run.
4. A killed run (`turn.started`, no `turn.completed`) is null, whatever landed in the rollout.
5. Missing, compressed, truncated-line, wrong-turn-count and no-price-for-the-turn-model rollouts each give null with a named cause. A `collab_tool_call` run gives null.
6. A rollout where `thread_token_usage` drops after a compaction: charged by `usage` only, and the `E` difference is logged.
7. The rollout read and pricing do not block the event loop: a 10 ms timer keeps ticking while a 50 MB rollout is read, reading stops at the earliest selected turn even when a later run appended 50 MB, and the day lookup lists six directories at most and the fallback 64, and a rollout read over 16 MiB is null.
8. An unwritable or missing `codex-usage/` has no effect on the cost.
9. A fixture from the pinned Codex parses, its version equals a `CODEX_PINNED_VERSION` constant the build adds (today 0.161.0 is only in comments), and the fixture holds the conflict text of that version.

## 7. Open points the build settles with a fixture from the pinned Codex

1. Whether an auto-compaction writes its own `task_started` while stdout shows one `turn.started`. If it does, the turn rule counts them, or the run is null.
2. Whether `archived_sessions` is flat or dated, and whether the lookup needs the fallback listing.
3. Whether `cache_write_input_tokens` is inside `input_tokens`. ADR-0043 settled that `output_tokens` includes reasoning, and that cached input is inside input.
