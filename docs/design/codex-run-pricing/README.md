# Codex run pricing when resumes overlap (design, 2026-11-09)

**Phase: design only (T-906).** No code. This design supersedes ADR-0043 decision 3 (the per-thread record) once the build lands; ADR-0043 carries a pointer to it.

## 1. The problem

ADR-0043 charges a key run the tokens it added to its thread by subtracting a per-thread record (`codex-usage/<thread>.json`) written at settle. After PR 242 dropped the file lock, two defects remain:

- Runs of one thread that settle out of order read the same base or leave the record too low, so tokens are charged twice.
- `exec resume --last` has no thread id before the run, so there is no start snapshot.

## 2. What Codex records

Read at tag `rust-v0.161.0` (commit `979011409de0`), the version the connections code cites, and checked by running codex-cli 0.161.0 against a local stub endpoint on 2026-11-09. ADR-0043's probe used 0.163.0, so the build re-captures its fixture on the version it ships.

| Fact | Source at the tag |
|---|---|
| One rollout file per thread, `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`. A resume appends to the same file. Each line has a `timestamp` and a rising `ordinal`. | `codex-rs/rollout/src/lib.rs`, `rollout_file_name.rs` |
| After every completed response a `token_usage_record` line: `thread_id`, `turn_id`, `response_id`, `usage` (that response alone), `turn_token_usage`, `thread_token_usage`. A `task_started` line with the same `turn_id` opens each turn, and `turn_context` names the turn's model. | `codex-rs/protocol/src/protocol.rs` (`TokenUsageRecord`), `rollout/src/policy.rs` |
| `turn.completed.usage` on stdout is the thread's running total, not the run's. `turn.started` has no fields; `thread.started` has the thread id. A `collab_tool_call` item marks a spawned child thread. | `codex-rs/exec/src/event_processor_with_jsonl_output.rs` (`usage_from_last_total`), `exec_events.rs` |
| One live writer per thread per Codex home. `thread/resume` takes `thread-writer-locks/<thread>.lock` and fails with a conflict if it is held. | `rollout/src/writer_lock.rs`, `thread-store/src/local/live_writer.rs` |
| `--last` is resolved inside Codex: newest thread by update time, filtered by working directory. | `codex-rs/exec/src/lib.rs` (`resolve_resume_thread_id`) |
| After a compaction overflow the totals can be rewritten to the context window with zero input and output counts, so a total can go down. | `protocol.rs` (`fill_to_context_window`) |

Observed with 0.161.0: while one resume of thread T was alive, a second `exec resume T` in the same home exited 1 with "thread T already has an active writer", printed no events and appended nothing. A key member's `CODEX_HOME` is `runtime/<connection>`, shared by its runs, so the lock covers them. Subscription runs are not token-priced: out of scope.

## 3. Options

| | How a run is priced | Verdict |
|---|---|---|
| A. Async lock | Keep the per-thread record. Take an async lease (exclusive create, owner token, heartbeat, expiry) around read, price, write. | Rejected. It brings back PR 242's stale-lock and wrong-owner cases, has no base for `--last`, and a crashed holder delays or loses a charge. |
| B. Start and end snapshot | Read the thread's total from the rollout before spawn, subtract it from the final total. No shared record. | Rejected. `--last` has no thread before spawn. For an explicit id another run can append between the snapshot and Codex taking its lock, so the base is low and that run's tokens are charged twice. |
| C. Own records | After the run, sum the `usage` of the `token_usage_record` lines this run appended to the thread's rollout. No Morndo record, no lock, no write. | **Chosen.** |

## 4. Decision: option C

Codex already keeps, per response, the tokens billed and the turn they belong to. Morndo stops keeping a second copy. After the child exits, with `fs/promises` and off the event loop:

1. Keep from the run: spawn time, exit time, the thread id and the number `n` of `turn.started` lines from stdout, whether argv has `--json`, and the run's stderr. Without `--json` there is no thread id and no `n`: the cost is null and today's `costFromOutput(stdout)` fallback stays.
2. Find the rollout by file name under `sessions`. Thread ids are UUIDv7, so the day directory is the id's timestamp and its two neighbours (the observed id decodes to its file's creation time). Read backwards in bounded chunks, at most 16 MiB, until the earliest selected `task_started`.
3. This run's turns are the `task_started` lines timestamped between spawn and exit; there must be exactly `n`. Timestamps give the coarse bound and `ordinal` the cut: no other `task_started` may lie between the first selected one and the nearest earlier turn-level line (`task_complete`, `turn_aborted` or `session_meta`). Its records are the `token_usage_record` lines of those turns for this thread.
4. Each record is priced at the model its turn's `turn_context` names, using the catalog row for that model; no row is null. Cost is the existing formula (`(input − cached) × input + cached × cache-read + output × output`) on the summed `usage`, rounded once.
5. The final total on stdout is a log-only cross-check against the last record's `thread_token_usage`. A difference is logged, never used to price, because a compaction rewrites totals.

Why: nothing is shared between runs, so settle order cannot matter, and a later run that appended before this one settled lies outside the window. Codex's lock makes the window exclusive; at its edges (a predecessor finishing, a successor that started before Morndo saw the exit) the turn-count and ordinal checks give null, not a charge. The thread comes from stdout, so `--last` needs no special case. `CodexSessionUsageFile`, `keepTotals` and `codexRunCost` go away, and old `codex-usage/*.json` is ignored.

## 5. Failure cases

| Case | Result |
|---|---|
| Two runs of one thread, settles in either order | Each is charged its own turn. The sum is the `usage` of all their records. |
| Second live resume refused by Codex | Cost 0 only when argv has `--json`, stdout is empty, the exit is non-zero and the kept stderr has "already has an active writer": no request was made (today the reservation). Any other failure before `thread.started` is null. |
| `exec resume --last` | The thread id is read from stdout. No read before the run. |
| Turn ends in `turn.failed` | Priced from the responses that landed, like a completed turn. |
| Codex killed mid-run (neither `turn.completed` nor `turn.failed`) | Null, so the reservation stands. A response in flight at the kill is billed but in neither source, so pricing the landed records would under-charge. |
| Morndo killed before settle | No pricing runs. The lease reaper closes at the reservation, as now. The rollout keeps the truth for a later reconcile, not in this build. |
| Rollout missing, compressed, unparsable, over 16 MiB, wrong turn count, or no catalog row for a turn's model | Null, so the lease keeps the reservation, with one stderr line naming the cause. Never the whole total and never a Morndo record. |
| The run spawned child threads (`collab_tool_call` on stdout) | Their responses are billed in other rollouts. Null for now. |
| A pool moves a thread to a member with another home | Codex there does not know the thread and refuses before any request. No rollout is found: null. A layout that shares `sessions` between homes without `thread-writer-locks` (a subscription run home) has no lock: null. |

## 6. Tests the build writes first

All fail on today's code. Fixtures are rollouts written by the pinned Codex, plus stdout and stderr captures.

1. Run 1 and run 2 resume one thread in turn and run 2 has appended before run 1 settles: run 1 is charged only its turn, run 2 only its own, and the two sum to the `usage` of all their records, whichever settles first.
2. A refused resume (`--json`, empty stdout, exit 1, the conflict text on stderr) is 0. The same without the conflict text, or without `--json`, is null.
3. `--last` argv: priced from the stdout thread, with no read before the run.
4. A `turn.failed` run is priced from the landed records. A killed run (`turn.started`, no end event) is null whatever landed.
5. Missing, compressed, truncated-line, over-16-MiB, wrong-turn-count and no-price-for-the-turn-model rollouts each give null with a named cause. A `collab_tool_call` run gives null.
6. A rollout where `thread_token_usage` drops after a compaction is charged by `usage` only, and the difference from the final total is logged.
7. The read does not block the event loop: a 10 ms timer keeps ticking while a rollout with 50 MB appended after the run is read, the read ends at the cap, and the lookup lists at most three directories.
8. An unwritable or missing `codex-usage/` has no effect on the cost.
9. A fixture from the pinned Codex parses, its version equals a `CODEX_PINNED_VERSION` constant the build adds (today 0.161.0 is only in comments), and it holds that version's conflict text.

## 7. Open questions

One line each; the build settles them with a fixture from the pinned Codex, not with another design round.

1. Does an auto-compaction write its own `task_started` while stdout shows one `turn.started`? If so, count them or return null.
2. Is `archived_sessions` flat or dated, and should an archived thread be looked up there?
3. A thread id that is not UUIDv7 (an older thread): a capped directory listing, or null?
4. Is `cache_write_input_tokens` inside `input_tokens`? `charge()` prices cache writes at the input rate, so subtract it from input first if it is.
5. The conflict text is English and version-bound, and a prompt echoed on stderr could contain it. Match more than the substring, or accept the risk?
6. A 16 MiB cap means a very large later append makes the earlier run null. Is a larger cap or an index worth it?
7. Is the lock released before Morndo records the exit, so that n+1 turns appear in the window? The count gives null, but how often it happens is unmeasured.
8. Delete the old `codex-usage/` directory in the build or a later change? A rollback to ADR-0043 code reads those older, lower bases and charges too much, not too little.
