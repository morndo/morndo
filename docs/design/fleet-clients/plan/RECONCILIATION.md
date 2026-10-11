# Reconciliation of the fleet clients plan (2026-10-08)

Seven drafters wrote the parts in parallel against plan.md's Contracts, each running its own steps in a scratch copy. Their contract requests and open questions are settled below; each ruling names the parts it changes. A ruling overrides the Contracts where they differ, and plan.md's Contracts are updated to match. **R** marks a ruling that also corrects the spec (§N of README.md, recorded in its §16).

## Names and wire

1. **Negative-control ids** are `fc<task>-<what>` (`fc5-started-check`); the core's `t1`–`t21` stay its own. *All parts.*
2. **The fleet's mirror table is `lane_deliveries`:** `fleet.db` already has a `deliveries` table, the hook bus's. Added columns: `lane_deliveries.alerted` (the alerts raised) and `lane_events.delivery_id` (the batch that carried it). *03, plan.md Databases.*
3. **Delivery refusals follow the client API's existing mapping for op refusals:** 200 `{ ok: false, error: OpError }` from `POST /v1/deliveries` and `POST /v1/deliveries/<id>/cancel`. `GET /v1/deliveries/<id>` of an unknown id answers 404 `{ error: "no_such_delivery" }`. `GET /v1/deliveries` returns the newest 1000 of the last 7 days. *03, 04 (fake fleet), 05 (examples), plan.md routes.*
4. **`/v1/op` refuses `lane.deliver` and `delivery.cancel`** with `bad_args` ("use /v1/deliveries"): a delivery goes through its route, where the fleet resolves the target and keeps the mirror. *01 (fleet-client never sends them as ops), 03 (Task 8 refuses), 05.*
5. **`/lane` is the node's own path:** never a subscriber path, never counted as unrouted (`unrouted_hook`). *01, 03, 05.*
6. **Lane-event delivery ids:**
   - the form is `fleet:lane-events:<node>:<first event's time, ms>`;
   - a batch queued again after it was given up gets `.2`, `.3` …;
   - a batch split over 8000 characters (Review Focus 4) gets `-1`, `-2` … before any suffix. *03, 05.*
7. **Delivery ids:**
   - at most 200 characters;
   - no trailing `#<digits>` (reserved for retype keys);
   - `ttlMs` at most 7 days;
   - the target strict (exactly one of `lane` and `workerId`).

   **A lane start's first prompt** gets the id `<client>:prompt:<first 16 hex of SHA-256 of the start's key>`, always within 200. *01, 02.*
8. **`GET /v1/caps`** answers `{ api, stickyLanes }`; an older fleet without `stickyLanes` reads as `[]`. **R** §8 said caps "lists" the routes. *01, 03, 04, README §8.*
9. **`packages/fleet-client`** imports `packages/protocol`, `ws` (its events socket, as the hub's client does today) and `node:*`. It adds a `FleetLog` option and the `FleetDelivery` type (`Delivery & { stale: boolean }`). *01, plan.md Global Constraints.*
10. **`pane.capture { workerId, lines, attributes?, join? }`:**
    - `join` (tmux `-J`) defaults to true, as kira reads screen text;
    - `attributes` (tmux `-e`) is how kira finds the input box;
    - the 256 KiB cap counts the JSON-escaped size. *01, 02, 06.*

## Sessions and lanes

11. **R `status: "shell"` means Claude Code is alive and running a shell command,** not that it has exited (seen on a live idle session with a background shell). The triple-check's reading in spec §16 item 20 was wrong.
    - A lane takes deliveries while it has a live session, whatever its `status`.
    - `no_session` means no live session: no session file, or its process gone.
    - *01, 02, 06, README §4.1, §5, §16.*
12. **`Pane.pid` is the session's process (Claude Code's), from its session file.** `null` without a session; `status` and `pid` read as `null` from an older agent. *01, 02, 06.*
13. **R `Pane` gains `topic` and `lastPrompt`,** the session's latest `ai-title` and `last-prompt` entries, which the agent keeps from its transcript reads: a tail scan, cached per session. kira shows `title || lastPrompt` in the Mini App and the title in the Overview (`kira.ts:520`, `app/index.html:98`). Without them both would show the pane's terminal title and nothing. `morndo lanes --json` carries them. *01 (protocol), 02 (inventory), 04 (Task 14's JSON), 06 (kira and `lanes` map `title` from `topic`), README §5.*
14. **The 2-minute start grace** is measured from the pane process's own start time:
    - on Linux, `/proc/<pid>/stat` field 22 against boot time;
    - elsewhere, `ps -o lstart=`.

    So it survives an agent restart. *02.*
15. **A waiting reason `unavailable`:** the node couldn't read or type the pane just now (tmux didn't answer, a capture failed). The delivery waits and tries again. *01, 02, 04 (wording: "the machine didn't answer, trying again").*

## Delivering

16. **R Typing is one at a time per lane and in order.** A typed or held delivery waiting for its receipt holds the next one back for at most 60 s (`earlier`); then the next one types. Before this, a delivery that never got a receipt (a slash command missed by the receipt, a lane that isn't Claude Code after all) blocked its lane for up to 24 hours. Receipts still match the earliest delivery waiting for one. *02, 05, README §4.3.*
17. **R A slash command that starts a new session** (`/clear`, `/new`) is only recorded in the new session's transcript. Its receipt is the pane's session changing to a new session id after the typing. *01 (receipt helper), 02, README §4.3.*
18. **`needs_input` after an agent restart:** the fleet drops a `needs_input` for a session whose last lane event is a `needs_input` without an `answered` after it. *03.*
19. **The deliverer's internal types** (`PaneView`, `TranscriptView`, `PaneState`, `Executor`, `Deliverer.drain()`, `EffectContext.key`, the `OpsRuntime` fields, `Launch`, `EFFECT_FIELDS` gaining `prompt` and `mode`, `DeliveryStore`'s `node` parameter and `detail()`, `recentFinal(sinceTimestamp)`):
    - stay as part 02 defines them;
    - Task 4 takes the three Task 6 items that Task 1 would otherwise leave uncompiled;
    - a recorded "Exit and stop tasks" screen goes into `test/fixtures/claude-code/`. *02.*
20. **Agent test hooks** `killAfterEffect`, `noSessionBinding`, `retypeUnderFirstKey` and `deliveryStartGraceMs` are added; `noDoneKeys` also covers the deliverer. *02, 05.*

## The fleet

21. **The intake window** is never shorter than one event-loop turn and never longer than 25 ms (part 03's reading). *03.*
22. **A Stop or StopFailure hook without a window** makes no lane event, as in kira. *03.*
23. **Lane events stored while `deliverTo` is `null` are never delivered later.** So turning delivery on (rollout step 3b) doesn't flood the manager with what kira's own feed already told it. *03, 07.*
24. **`deliverTo` defaults to `"manager"`** for every user. The owner's PC sets `deliverTo: null` from step 1 until step 3b, while `lane-events-push` still feeds the manager. *not in this tree.*
25. **Alert details:**
    - `delivery_waiting { id, lane, state, reason, minutes }`;
    - `subscriber_lagging { subscriber, oldestAgeMs, streams }` (part 05's table). *03, 05.*

## The hub and `morndo lanes`

26. **The hub additions are adopted as part 04 defines them:**
    - the domain's E13 methods and the `DecisionDelivery` type;
    - the feed's `deliveries` frame and `DecisionItem.waiting`;
    - `Config.managerQueue`;
    - the wording "Not delivered" for `given_up`;
    - `hub:<key>~<n>` for an answer sent again after its delivery was given up;
    - the FakeFleet helpers.

    **E13 goes into `docs/domain.md`** in Task 12, with its code (PR #10 never merged it). *04, 05 (Task 17 doesn't add it again).*
27. **An answer delivered after its ask was asked again** is recorded against the ask it answered (its id names that ask), never the new one (ADR-0010 H1). *04.*
28. **`CommandSent`** is recorded when the hub queues the command (its provenance), and the delivery's outcome later; the race part 04 found goes away. *04.*
29. **`morndo lanes`:**
    - **Options:** they may follow the lane name; `start --node`; `send --direct --id`.
    - **`--json`:** its fields are those of Task 14's table (part 04), with `topic` and `lastPrompt` added (ruling 13). `start --json` prints the result, with `waiting: "trust"`.
    - **Exit codes:** `stop` exits 0 once stopped, 3 for `uncertain`, 4 when refused; `--kill` after an exit that timed out is allowed.
    - **Errors:** refusal codes go to stderr, and 69 means the fleet is unavailable. *04, 06, 07.*
30. **`lanes --json` (the owner's wrapper) lists only lanes with a live session,** as `lanes` does today.

## The owner's setup

31. **R kira keeps writing `~/.local/share/kira/events.jsonl`,** now from the fleet's lane events (`/v1/events`), in today's format. `claude-pool` (account failover) and the manager's `lane-watchdog` read it; it is local to the owner, outside Morndo. §9.4 said it stops. *README §9.4, §9.5.*
32. **R The owner's monitors stay local by design,** like `claude-pool`:
    - `lane-watchdog` and `box-health`, which reach the manager's pane or transcripts as a fallback;
    - the manager's timers.

    §15.2's search excludes them by name. Task 20 updates `box-health`: kira's health probe moves to 8786, and `lane-events-push` stopped is expected after step 3b. *README §2, §15.*
33. **`lanes start --engine` stays on tmux** (engine lanes are out of scope, §14).
34. **The `manager-inbox` shim keeps today's commands and exit codes** where they still mean something. kira's unmerged `feat/manager-inbox` branch is superseded.
35. **kira's config gains `hookPort`** (the old listener: `8787` until step 3b, then `null`) **and `fleetHookPort`** (`8786`). Its tests use a throwaway HOME.

## Tests and the rollout

36. **Task 16 runs before Task 15** in the tests lane: the doc's examples need the drills' harness. *05, plan.md Lanes.*
37. **The drill harness's `waitOnline` gap,** which let `(b‴)` fail once under parallel load, is fixed in Task 16. *05.* **Later (2026-10-09):** the gap failed PR #25's CI three times running, so the fix went to `main` on its own (PR #27). Task 16's edit 7 is skipped when `main` already has it.
38. **`scripts/bench-relay.ts --gate`** prints `gate: PASS` or `gate: FAIL (<which>)` and exits 0 or 1. *05.*
39. **The hub logs `manager queue: on|off`** and the sticky check (Review Focus 5) once at start. *04.*
40. **Step 0** deploys Task 11 alone, from `main`, with the hub's own rollback (code only: no migration).

## For the owner

41. **Should `studio` be sticky and protected like `manager`?** The default stays `["manager"]`. **The owner decided on 2026-10-09: only `manager`.** `studio` can be added later in the node's policy, with no code change.

## Second pass (after the parts applied the rulings)

42. **The 60 s receipt hold is `LIMITS.deliveryReceiptHoldMs = 60_000`.** *01, 02, 05.*
43. **A new delivery is answered in state `queued`;** `waiting` is present only while it is queued and a try has found the lane not ready. *02, 03, 05.*
44. **`firstLine`** is the answer's first non-blank line, trimmed, at most 200 characters, taken from `last_assistant_message`, else `text` (part 03's definition); `bg` and `crons` are counts. *03, 05, 06.*
45. **Errors from the delivery routes:**
    - a cancel of an unknown id answers 404 `{ error: "no_such_delivery" }`, like `GET`;
    - a request body that fails `lane.deliver`'s schema answers 400 `{ ok: false, error: { code: "bad_args", … } }`, as `POST /v1/op` answers a malformed body today (`client-api.ts:124`); 415 for a body that isn't JSON and 413 for one over the limit, in the same shape;
    - a refusal by the node or the fleet answers 200 `{ ok: false, error }` (ruling 3). *03, 05.*
46. **`Pane.topic?: string` and `Pane.lastPrompt?: string` are optional,** absent when unknown (part 01's types). *01, 02, 04, 06, plan.md.*
47. **kira reads lane events with a stored cursor** (`GET /v1/lane-events?since=<seq>`), not only `/v1/events`, so a kira restart or a fleet outage loses none; it writes `events.jsonl` from them. This refines ruling 31. *README §9.4.*

## Review round (two independent reviews: executability, coverage; 2026-10-08)

The executability reviewer applied Tasks 1–5, 7–9, 11 and 12 in scratch copies: every count matched once item 48 is fixed. The coverage reviewer checked every spec section and Review Focus item against the parts' 614 tests and 189 controls.

**Blocking**

48. **`LIMITS.deliveryReceiptHoldMs: 60_000` goes into Task 1's LIMITS insert and its test (14 fields).** Without it Task 5 doesn't compile (TS2339). *01.*
49. **In doubt is never typed again by hand.** A client that reached the fleet but got no answer (`FleetUnavailable` with `reached: true`, or a refusal `uncertain`) sends the same delivery id again; that is safe, since a delivery's id is its idempotency.
    - **What it never does:** fall back to typing directly, or tell the owner "not delivered".
    - **`morndo lanes` exits:** a new `EXIT.inDoubt: 5` (reached, no answer: run it again with the same `--id`); 69 only when the fleet wasn't reached (nothing queued). Task 14 used 69 for both; 3 and 4 keep Task 14's meanings.
    - **The `manager-inbox` shim:** its callers type the line themselves on *any* non-zero exit, and `night-fill` and `lane-watchdog` also when the shim takes over 30 s. That is `digest-tick:15-19`, `night-tick:15-19`, `night-fill:276-285` and `lane-watchdog:100-111`, read on the PC on 2026-10-08; `cloud-run-wait` ignores the exit. So in doubt the shim:
      - asks again under the same id (`delivery(key)`, then `deliver`) for at most 20 s in all;
      - if still unanswered, exits **0** with `in doubt <key>: Morndo may have it; not typed directly` on stdout.
      
      The node agent types a delivery at most once, and a timer's line lost once is less harm than the same line typed twice. Exit 11 (the caller types it) only when nothing left this process (`reached: false`) or the fleet refused with `node_offline`.
    - **kira** asks again under the same id and tells the owner "checking", then the state; never "not delivered".
    - **Tests:** a timeout after the POST and an `uncertain` refusal, each with its control.
    - **R** §9.2's exit codes gain 5. *01 (fleet-client keeps `reached`), 04 (Task 14), 06 (kira, shim), 07, README §9.2.*

**Should-fix (executability)**

50. **Controls run after their commit** (the runner reads HEAD): every step that runs `negative-controls.ts --only` comes after its task's commit. *All parts; 01:1042, 2192, 3443 seen.*
51. **Existing controls a task makes stale are updated in that same step:**
    - `t9-prune-not-wired` (after Task 5 Step 23);
    - `t5-answer-key-random` and `t5-answer-key-without-ask` (found twice after Step 12.34).
    
    `--check` runs in CI. *02, 04.*
52. **A "replace this text" quotes the text as the earlier tasks left it:**
    - the `pane.keys` line (02:467, after Task 1 Step 8);
    - `new FleetClient(socket)` (04:3805, after Task 3 Step 5). *02, 04.*
53. **Step 12.21 also changes `fleet-adapters.test.ts:320`** (`status: "idle"`). Step 12.5's `git add` includes `docs/domain.md`. *04.*
54. **The deliverer imports `startsNewSession` from `@morndo/node-ops`** and keeps no copy of its own (with its own copy, `/reset` and `" /clear"` disagreed). *02.*
55. **kira's waiting texts are Task 13's `WAITING` table, copied exactly,** `unavailable` included.
56. **Smaller:**
    - `cancelDelivery` returns `null` on 404 (`no_such_delivery`), not a "fleet unavailable" throw (contract updated);
    - the drill harness's own type is `DrillDelivery`, not `FleetDelivery`;
    - a test for a `last-prompt` entry without `lastPrompt`;
    - `fc4-title-uncapped` in its `--only` list and the expected count corrected;
    - part 02's open questions brought up to date;
    - `npx tsc -p e2e` replaced by the repo's own check (there is no `e2e/tsconfig.json`);
    - plan.md's `capture` contract shows `join?` and an optional argument. *01, 02, 04, 05, 07, plan.md.*

**Should-fix (coverage)**

57. **`morndo lanes` runs against a real fleet in CI:** a Task 16 drill covering send, status, peek, keys, start and stop, and events, with a real agent and the fake input box. *05.*
58. **The rollout's guards are tested:**
    - `weekday_morning` refuses outside the window;
    - `go_ahead` refuses without the answer;
    - step 3b's rollback sets `lane-events-push`'s offset to the end, tested with a non-empty events file.
    
    One of them is a "(negative control)".
59. **The "not synced" side of §6 is pinned:** a test in Task 10 counts the `FULL` commits while an event is delivered to a subscriber, and expects only the intake's. It has a control. *03.*
60. **Smaller tests:**
    - `morndo lanes` exit 4 for `uncertain` and `start --resume` (04);
    - a sticky name across a fleet restart (03);
    - a hook kicking the deliverer (02);
    - kira's restore through `lanes start --resume` (06);
    - the done criterion's search also covers the hub's transcript reads (07);
    - Task 17 greps the new code's external citations for a URL and a date (05).
61. **Controls:**
    - `fc12-uncertain-reopens` (04), `fc2-receipt-dequeue` (01);
    - the shim's in-doubt path (06), the rollout guards (07), the not-synced commits (03).
    
    **R** §15.1: a control is an entry in `scripts/negative-controls.ts` or a test named "… (negative control)", as the runner's header already says.

**Deviations, ruled**

62. **Task 7 syncs the node's connection epoch:** a reused epoch after a power loss could let a stale result be taken as current. **R** §6's synced list gains it. *03.*
63. **kira polls `GET /v1/alerts` with a cursor** rather than following `/v1/events` for alerts, so a restart loses none (as ruling 47 for lane events).
64. **Accepted as written:** `/reset` as a new-session command; `--json` on `peek`, `status` and `events`; kira's `fleetAlertKinds` setting.
65. **If §6's gate fails, step 3 doesn't proceed.** The worker-thread change becomes its own task then; nothing is planned for it now.


**Found while applying the round (part 04's full run)**

66. **The fleet harness's hub follows production: the manager queue is on.**
    - **Why:** `MORNDO_MANAGER_QUEUE` is on by default with a fleet (Task 12), so a drill written later tests what ships unless it says otherwise.
    - **Opting out:** `drills-retry` and `duplicate-names` pass `startHub(fleet, { managerQueue: false })`, with a comment that they drill the direct path. The hub still uses that path with the switch off (the rollback of step 2) and for every lane other than the manager. In part 04's run, 14 of their 20 tests failed with the queue on. *04 (Step 12.49).*
    - **New drill:** Task 16 drills the queue itself through a real fleet and node agent, with the fake input box. *05.*
      - An answer and a message to the manager are typed once and confirmed, and the card shows "Delivered".
      - The hub, killed after queuing an answer and before recording it, answers once after its restart.
      - Switching the queue off cancels what is still queued. A direct retry of an answer already typed finds its key and isn't typed again (§9.1's "nothing is typed twice").

## Whole-plan run (2026-10-09)

The whole plan applied in order on one clone of `main`: Tasks 1–17, then Task 21's repo part. Tasks 18–20 are not in this tree.
- **Commits:** 61, with no conflicts between the lanes.
- **Tests:** 2336 of 2348 passed, 2 failed (fake-box) and 10 skipped (9 rollout tests and 1 confine test, Linux only). The 9 rollout tests passed 11/11 in a Linux container.
- **Drills:** `drills-lanes-cli` and `drills-manager-queue` each passed 6/6 in five runs.
- **Checks:** `check` was clean; `lint` failed with 2 errors.
- **Controls:** 203 of 204 `fc*` controls bit.

Fixed in the plan, each checked again on that tree:

67. **Task 3's `git add` named two paths `git mv` had already taken out of the index** (blocking): the whole `add` failed, and the commit missed the new package. The two paths are dropped. *01.*
68. **The fake input box wrote `submitted.jsonl` before the transcript line.** A test that waited for the first read the second 1 ms too early: `fake-box` failed 2–3 of 10 in each run, and `fc16-box-enqueue` broke at its baseline.
    - **Fix:** `submitted.jsonl` is now written last.
    - **Checked:** five runs of 10/10, and the control bit with its expected text. *05.*
69. **Two lint errors:** a `.sort()` without a compare function, and `String(v)` on an unknown value. Lint now exits 0. *05.*
70. **The doc's `deliver-bad` example answered 200;** the fleet answers 400 (ruling 45). The doc test passes 115/115 with the three related files. *05.*
71. **The citation check read only the URL's line and the next,** so it missed a date written on the line before. It now reads the comment lines on both sides of the URL.
    - **Checked:** 17 citations, 0 undated, exit 0.
    - **Still catches:** an undated probe, at exit 1. *05.*
72. **Wrong counts and expected messages,** all corrected to what was seen:
    - Task 4 Step 3: 3 failed, 2 passed;
    - Task 11: 100 files, 715 tests;
    - Step 13.2: the module error;
    - Task 16 Step 3: `TypeError`;
    - vitest's "Cannot find module" wording;
    - six bench lines;
    - Task 17 Step 17 adds only Tasks 15–17's controls, since Tasks 1–14 already added theirs;
    - Step 12.52 runs all 30 `fc12-` controls;
    - the stand-in sentences in part 04 are dropped. *01, 02, 04, 05.*
73. **The rollout stubs are not in this tree.** The data-copy test skips when run as root, where `chmod 000` doesn't stop the copy.
74. **Two plan steps fail before they run their tests, for reasons outside the tests,** and stay as they are:
    - Task 5's Step 5 commit compiles only from Step 11; noted at the step.
    - `npm run e2e` stops at `desktop.e2e.ts` without TigerVNC, so Step 13.5 runs `gallery.e2e.ts` on its own.
75. **For the executor:** 38 of the 204 `fc*` controls carry no `expect` text (fc5 ×3, fc6 ×1, fc7 ×1, fc8 ×7, fc9 ×21, fc10 ×5). For them, "bit" only proves that some test failed. When a task's controls run, add the failure text seen to each entry without one, in that task's commit.

## Run on the current main (2026-10-09)

`main` gained PRs #18 and #24 after the first run, and they touch files the plan edits. So the whole plan ran again in order, on a fresh clone of `main` at 12c2811: Tasks 1–17, then Task 21's repo part, in 66 commits.
- **Tests:** 2383 of 2395 passed, 2 failed, 10 skipped.
  - The 2 failures are main's own `process-start.test.ts`, which reads `/proc` and fails on macOS before any plan step.
  - The 9 rollout tests passed 11/11 in a Linux container.
- **Checks:** `check` and `lint` are clean.
- **Controls:** 204 of 204 `fc*` controls bit.
- **Citation check:** 17 cited, 0 undated, and it bites on a probe.

76. **26 drift edits** fit the plan to `main` after #18 and #24. They are parts 01 (D1–D20), 04 (D21–D25) and 05 (D26), listed in the run's `fc-main/logs/drift-edits.txt`.
    - **What they change:** counts that include main's new tests; line anchors in `sessions.ts`, `index.ts` and `main.ts`; and the quotes in `config.ts` and `main.ts`. The plan's lines now sit next to main's `engineSessions`, `engineNode`, `MORNDO_ENGINE_*` and `engineLanes` lines, and both are kept.
    - **One new replace:** `status: null` in main's `val-pr18-findings.test.ts`, which builds a `SessionInfo`.
    - **Checked:** each edited file came out as the first run's file plus exactly main's lines. Parts 02 and 03 needed none.
77. **Task 2 Step 6's commit message named the product,** which the local hook refuses and the Global Constraints forbid. It now says "recorded 2.1.293 transcript shapes"; no plan commit message names it any more. *01.*
78. **Task 15 Step 9 restored the doc with `git checkout`,** but the doc isn't tracked until Step 10. It now changes `["boss"]` back by hand. *05.*
79. **Every `fc*` control carries the failure text the run saw** (ruling 75, done in the plan): 38 texts were added from the run's tree, and all 204 match it.
80. **Wording fixes:**
    - Task 4 Step 3: the lanes lack `status`, not the panes;
    - "see it fail" in the menu step, where the colours change fails 3 tests;
    - Task 15's run takes about 25 s.
    
    **Left as they are:** three expected messages worded differently from what vitest prints (03:388, 1703, 3084; same meaning), and a load flake in the existing `lane-worktree-ops` (it passed on rerun).

## Refresh on main after #32, #34, #29, #38 and #39 (2026-10-09)

After the plan merged, main gained:
- #32, the board (hub migration 13);
- #34, Home with usage (14);
- #29, the manager's answers through kira's inbox, ADR-0010 rebuilt (15);
- #38, the board redesign;
- #39, the two red checks after #34.

A drift map against `feat/fleet-clients` (main 662e688) found:
- parts 02 and 03 apply as written;
- parts 01 and 05 need anchors and counts;
- Task 12, Task 13 and the rollout part (outside this tree) need rework.

The owner decided the design questions on 2026-10-09.

81. **The fleet's delivery queue is the only queue for the manager's answers and messages** (the owner: "Fleet queue only").
    - **Removed by Tasks 12–13:**
      - `apps/hub/src/adapters/manager-inbox.ts` and its switch `MORNDO_MANAGER_INBOX`;
      - the inbox branches in `escalation-service.ts` and `steering-service.ts`, and `withdrawOverdue`;
      - the outbox's inbox fields and labels;
      - `e2e/inbox.e2e.ts` and its CI job.
    - **Kept from #29:** these are the plan's own design, and Tasks 12–13 build on them instead of adding twins.
      - the domain functions (`queue`, `delivered`, `withdraw`, `sameDecision`, `answered`), with `uncertain` added;
      - `replaceDecisionIf` and `dropDecisionIf`;
      - the decision cards' delivery line, the notices, `not_delivered` and `createdAt`.
    - **Tests:** #29's 16 inbox test files go. The cases the plan's tests don't cover are ported to the queue: B3, B5, B7, B8, B9, B10 and the notices.
    - **The table:** migration 15's `pending_answers` stays, unused. Dropping a table would be a migration of its own, and nothing needs it.
    - **R** ADR-0014 supersedes ADR-0010 as rebuilt by #29. Its domain rules stay: an answer counts as given once queued, and is recorded once it reached the manager.
82. **An answer typed and never seen taken stays given:** "May have been delivered", never reopened (the owner). An answer never typed (expired, cancelled, its lane gone) is "Not delivered", and the ask opens again. #29's "Answer again" for a typed answer goes.
83. **A message to a busy manager waits up to 24 h,** with its waiting reason shown and a cancel (the owner). #29's 2-minute deadline and Retry for commands go.
84. **The hub's migration is 16** (`manager_deliveries`); 13–15 are taken. The plan's "schema 12 → 13" becomes "→ 16" everywhere.
85. **Tasks 12 and 13 are rewritten against main as it is now.** They quote today's `main.ts`, `config.ts`, `http.ts`, `store.ts`, the escalation and steering services, `feed.ts`, the decision cards and the outbox, and they say what they remove.
    - Task 14's first `main.ts` edit is anchored on `import { fileStore }`, so it doesn't depend on Task 12's import.
    - The drift map ran Steps 12.21–12.31 (the queue's core) and Task 14 green on 8c97099, so they stay.
86. **Part 07 follows how the PC deploys now:**
    - The hub ships from `.worktrees/live-ship-<sha>` through the drop-in `ship.conf`, with backups in `morndo-backups/<date>-ship-<sha>`. Fleet and node stay on `live-fleet` until the rollout moves them.
    - Step 0 ("Task 11 alone on live-fleet") goes: Task 11 reaches the PC with the release before step 1.
    - Step 1 migrates from whatever schema the hub then runs (15 once main is shipped) to 16.
    - Step 5's search for anything typing through kira's inbox now covers the hub's code too.
87. **Spec and plan.md:**
    - §1, §3, §9.1 and §9.5 say #29 is on main (not "open PR #10");
    - E13 and S5 in `docs/domain.md` say queue, not inbox;
    - `plan.md`'s Databases table says hub migration 16.
88. **`POST /api/manager/cancel { requestId }`** (part 04, for ruling 83's cancel) is accepted. It answers 200 `{ ok, delivery }`, 409 `{ error }` (e.g. `already_typed`) or 404 `{ error: "unknown" }`. It asks for no fresh passkey, because cancelling types nothing.
89. **No answer is left in kira's inbox at the upgrade on the owner's PC.** #29's inbox was never on there: `MORNDO_MANAGER_INBOX` unset, `pending_answers` 0 rows on 2026-10-09 23:48. Part 07's step 1 refuses to run with that variable set. A Decision restored as queued, without a delivery row, reads "May have been delivered" and is neither re-asked nor typed.
90. **Notices last as long as their delivery rows** (7 days).
91. **`qa/` records stay as written.** ADR-0010 gains a "Superseded by ADR-0014" status line in the Task 12 step that removes the inbox.

**Run of the refreshed plan (2026-10-10).** Every task, 1–17, plus Task 21's repo part, was applied in order on `feat/fleet-clients` e56fa70: 61 commits.
- **Replaces:** every one found its text exactly once.
- **Expected outputs:** every count matched, apart from the wording nits below.
- **Controls:** every part's ran after its commit and bit with its text.
- **Fleet project:** 18 files and 208 tests, none skipped. That includes `drills-manager-queue` (8 cases) and `drills-lanes-cli`.

The owner stopped the run before its last stage (the non-fleet projects, and the bite runs of all controls together).

92. **Task 17 Step 19's citation check gets `maxBuffer: 64 MiB`** on its `git` calls. Without it the script threw ENOBUFS before checking anything: the diff from main is about 1.1 MB, over the 1 MiB default.
    - With the buffer: 17 cited, 0 undated, exit 0.
    - With an undated probe: exit 1, so the check still bites.

    *05.*
93. **Nits left as they are.** Each quoted message means what vitest prints, but its words differ:
    - Task 1 Step 9's bundle sizes (+0.5 KB on Node 24.21);
    - 03:388, 2272, 3084, 4030;
    - 04:4530.
