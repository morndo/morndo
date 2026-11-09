# Codex run pricing when resumes overlap (design, 2026-11-09)

**Phase: design only (T-906).** No code. Builds on ADR-0043 decision 3 and replaces its per-thread record. The follow-up build is one pull request.

## 1. The problem

A key run on the Codex runtime is charged the tokens it added to its thread. ADR-0043 does that by subtracting a per-thread record (`codex-usage/<thread>.json`) that each run writes at settle. Two defects remain after PR 242 removed the file lock:

- Two runs of one thread that settle out of order read the same base, or leave the record lower than the real total. The next run is then charged tokens twice.
- `exec resume --last` has no thread id before the run, so no start snapshot can exist for it.

## 2. What Codex records

Read at tag `rust-v0.161.0` (commit `979011409de0`), the version the connections code cites, and checked by running codex-cli 0.161.0 against a local stub endpoint on 2026-11-09. ADR-0043's probe used 0.163.0, so the build re-captures its fixture on the version it ships with.

| Fact | Source at the tag |
|---|---|
| One rollout file per thread, `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`. A resume appends to the same file. Each line has a `timestamp` and a rising `ordinal`. | `codex-rs/rollout/src/lib.rs`, `rollout_file_name.rs`, `recorder.rs` |
| After every completed response it appends a `token_usage_record` line: `thread_id`, `turn_id`, `response_id`, `usage` (that response alone), `turn_token_usage`, `thread_token_usage`. A `task_started` line with the same `turn_id` opens each turn. `token_count` lines carry running and last totals. | `codex-rs/protocol/src/protocol.rs` (`TokenUsageRecord`, `TokenUsageInfo`), `rollout/src/policy.rs` |
| `turn.completed.usage` on stdout is the thread's running total, not the run's. `turn.started` has no fields, and `thread.started` has the thread id. | `codex-rs/exec/src/event_processor_with_jsonl_output.rs` (`usage_from_last_total`), `exec_events.rs` |
| One live writer per thread per Codex home. `thread/resume` takes `thread-writer-locks/<thread>.lock` and fails with a conflict if it is held. | `rollout/src/writer_lock.rs`, `thread-store/src/local/live_writer.rs` |
| `--last` is resolved inside Codex, newest thread by update time, filtered by working directory. | `codex-rs/exec/src/lib.rs` (`resolve_resume_thread_id`) |
| After a compaction overflow the totals can be rewritten to the context window with zero input and output counts, so a total can go down. | `protocol.rs` (`fill_to_context_window`) |

Observed with 0.161.0: while one resume of thread T was alive, a second `exec resume T` in the same home exited 1 with "thread T already has an active writer", printed no events and appended nothing. The first run's lines were appended contiguously, with its `task_started` after the previous run's `task_complete`.

A key run's `CODEX_HOME` is `runtime/<connection>`, shared by all its runs, so the lock covers every key run of a thread. Subscription runs use a home per run and are not token-priced, so they are out of scope.

## 3. Options

| | How a run is priced | Verdict |
|---|---|---|
| A. Async lock | Keep the per-thread record. Take an async lease (exclusive create, owner token, heartbeat, expiry) around read, price, write. | Rejected. It rebuilds the stale-lock and wrong-owner cases of PR 242, still has no base for `--last`, and a crashed holder delays or loses a charge. |
| B. Start and end snapshot | Read the thread's total from the rollout before spawn, subtract it from the final `turn.completed` total. No shared record. | Rejected. `--last` has no thread before spawn. For an explicit id, another run can append between the snapshot and Codex taking its lock, which makes the base low and charges that run's tokens twice. |
| C. Own records | After the run, read the thread's rollout and sum the `usage` of the `token_usage_record` lines this run appended. No Morndo record, no lock, no write. | **Chosen.** |

## 4. Decision: option C

Codex already keeps, per response, the exact tokens billed and which turn they belong to. Morndo stops keeping a second copy. After the child exits, off the event loop:

1. From stdout take the thread id (`thread.started`), the number `n` of `turn.started` lines, and, if present, the final total `E`.
2. Find the rollout for that thread under the connection's `sessions` directory by file name. Read it from the end in bounded chunks, with `fs/promises`.
3. This run's turns are the last `n` turns with a `task_started` line, and its records are those whose `thread_id` is the thread and whose `turn_id` is in that set. The writer lock makes them contiguous at the end of the file.
4. Cost is the existing price formula (`(input − cached) × input + cached × cache-read + output × output`, model from the argv or the plan) applied to the sum of their `usage`, rounded once.
5. When `E` is present it must equal the last record's `thread_token_usage`. If not, treat the record as unreadable.

Why: nothing is shared between runs, so settle order cannot matter. The thread comes from stdout, so `--last` needs no special case. A total that goes down after a compaction costs nothing, because only the run's own responses are summed. The code and files of `CodexSessionUsageFile`, `keepTotals` and `codexRunCost` go away. Old `codex-usage/*.json` files are ignored.

## 5. Failure cases

| Case | Result |
|---|---|
| Two runs of one thread, settles in either order | Each is charged its own records. The sum equals the thread's growth. |
| Second live resume refused by Codex | No `thread.started`, so no request was made: cost 0 (today it closes at the whole reservation). |
| `exec resume --last` | As above. The thread id is read from stdout. |
| Codex killed mid-run (no `turn.completed`) | Price the records that landed. Log that the run was partial. A response still in flight when it died is in neither source and is not charged. |
| Morndo killed before settle | No pricing runs. The lease reaper closes at the reservation, as now. The rollout keeps the truth for a later reconcile, which is not in this build. |
| Rollout missing, compressed, unparsable, or `E` mismatch | Cost null, so the lease keeps the reservation, and one stderr line names the cause. Never the whole `E` (it double-charges a resume) and never a Morndo record. |
| Codex changes the line format | The pinned-fixture test fails first. Until then the mismatch rule above stops a wrong charge. |
| Two homes sharing one sessions directory | Not a key-run layout. If one is added, the build must detect records from turns it cannot attribute and return null. |

## 6. Tests the build writes first

All fail on today's code. Fixtures are rollouts written by the pinned Codex, plus stdout captures.

1. Settle two sequential resumes of one thread in reverse order: each cost equals its own tokens, and the two sum to the thread's growth.
2. A refused resume (empty stdout, exit 1) is charged 0.
3. `--last` argv: priced from the thread in stdout, with no read before the run.
4. Killed run: stdout has `turn.started` and no `turn.completed`, the rollout has two of three records: two are priced, and the log says partial.
5. Missing, compressed, truncated-line and `E`-mismatch rollouts each give null with a named cause.
6. A rollout where `thread_token_usage` drops after a compaction: charged by `usage` only, not the whole total.
7. The event loop is not blocked: a 10 ms timer keeps ticking while a 50 MB rollout is read, and only the tail is read. The settle path has no `Atomics.wait` and no sync fs call.
8. An unwritable or missing `codex-usage/` has no effect on the cost.
9. A fixture from the pinned Codex parses, and the fixture's version equals the pin in `runtime-codex.ts`.
