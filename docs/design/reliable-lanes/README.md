# Reliable lanes: status at every turn end, waiting with a deadline, engines by role, done with evidence (design, 2026-10-13)

**Status:** accepted by the principal on 2026-10-13. [ADR-0027](../../adr/0027-reliable-lanes.md).

**Builds on:** ADR-0012 (the fleet, typed operations), ADR-0013 (Roles, Engines, Chains; the engine layer's resolver), ADR-0014 (the delivery queue and lane events), ADR-0015 (the board), ADR-0017 (jobs that report back).

## 1. The problem

A month of one orchestrator running many lanes showed two failures that no single bug explains.

**Lanes go quiet and "done" is not done.** Claude Code's `Stop` hook fires whenever the agent finishes responding, not when a task is complete ([hooks guide](https://code.claude.com/docs/en/hooks-guide), read 2026-10-13). Lane events (§7 of the fleet clients design) turn every Stop into `finished`. In one week of real use, 77% of 1,049 `finished` events carried no status line at all, 40% ended with background work still running, and nothing watched a lane that stopped without saying where it stood. The orchestrator had to remember every one of them, and the principal kept asking "what is stale, what is done, what is live".

**Work runs on the wrong engine.** Lanes start as the node's single `launch` command unless the caller names something else every time. A Role's Chain in the engine layer (ADR-0013) named another engine for implementation, but a lane start never consulted it, and when the resolver was asked, a missed binary made it fall back to the last engine of the chain without anyone seeing it.

Sources for the mechanisms: agents declare work done early and skip verification ([Anthropic, effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), 2025-11-26; [MAST, arXiv 2503.13657](https://arxiv.org/abs/2503.13657): premature termination and missing verification among the common failures); models check their own work badly without external feedback ([arXiv 2310.01798](https://arxiv.org/abs/2310.01798), [arXiv 2402.08115](https://arxiv.org/abs/2402.08115)); agents follow defaults even more than people do ([Cherep et al., arXiv 2505.11584](https://arxiv.org/abs/2505.11584)). All read 2026-10-13.

## 2. What other systems do

| System | Turn end vs task end | Stalls | Done |
|---|---|---|---|
| OpenHands | an explicit finish action sets FINISHED; AWAITING_USER_INPUT is its own state | a stuck detector, a STUCK status | a critic checks a finish claim |
| SWE-agent | an explicit `submit` | turn limits | an optional reviewer |
| AutoGen / Magentic-One | termination conditions; a tool call ends the run | a progress ledger with a stall counter, re-planning | the orchestrator judges, not the worker |
| Agent Client Protocol | `stopReason: end_turn` is a turn, not a task | | |
| Vibe Kanban | an agent's finish moves a task to In Review | | a merge moves it to Done |

Morndo takes the same shape: an explicit status per turn, a deadline for waiting, stalls counted and reported, and Done kept for someone other than the worker.

## 3. Decisions

### 3.1 Every turn ends with a status (node, lane events)

A lane's answer starts with one status line (the first line, the rule lane events already read):

```
STATUS: DONE | STATUS: BLOCKED | STATUS: NEEDS DECISION | STATUS: WAITING <on what> [for <N> min|h]
```

- **The relay asks once.** When a `Stop` reaches the node's relay for a lane whose answer has no status line and no background work running, and Claude Code says this Stop was not already caused by a hook (`stop_hook_active`), the relay answers `{"decision": "block", "reason": …}`: Claude writes a status line and stops again. It never asks twice for one turn, so Claude Code's limit (it overrides a Stop hook after eight blocks in a row) is never reached. The asked Stop is not a turn end: it makes no lane event. It is still kept, marked `statusAsked`, because a subscriber that shows a lane's answers (a chat bridge) must not lose the answer it carried.
- **Off for the orchestrator.** `statusContract.exempt` (default `["manager"]`) names lanes that are never asked. `statusContract.mode: "off"` turns it off for a node.
- **A WAITING with nothing to wake it** is asked for a waker instead, under the same rules: W1 in [`docs/design/agent-board/README.md`](../agent-board/README.md) §5.
- **WAITING is a lease.** The line's duration — after `for`, a comma or a parenthesis, with a qualifier (`about`, `~`, `up to`, …), a range (`5–10 min`, the upper end), a trailing `+`, a decimal (`1.5 h`) — sets its deadline at 1.5 times itself plus 10 minutes (lanes under-declare: p90 of actual/declared 1.05, p95 1.31), at most 24 h; without one, the fleet's default (30 min). A `finished` event carries `status: "waiting"`, `waitingOn` and `until`.

### 3.2 The fleet watches every lane's last turn (lane watch)

For each lane (node and window), the fleet keeps its last turn end: status, background work, and when. Any later hook from that lane (a tool call or prompt, a new turn, a session state change) is activity, judged by the hook's own time on its node, not by when the fleet receives it. The status line is not activity, since Claude Code can re-run it on a timer while the lane is idle. Nor is Claude Code's `idle_prompt` notification, sent about a minute after a turn ends when nothing has happened since.

| Last turn | Deadline |
|---|---|
| WAITING | its `until`: the line's own duration at 1.5x plus 10 min, else `laneWatch.waitingMin` |
| no status, background work running or a wake-up scheduled | turn end + `laneWatch.waitingMin` (30); a wake-up at least until its next fire time + 5 min, when the node's UTC offset is known |
| no status, nothing running | turn end + `laneWatch.noStatusMin` (15) |
| DONE, BLOCKED, NEEDS DECISION | none: it is the orchestrator's to act on |

A turn that ended with background work is not judged past its deadline while its window's session shows `shell` — the lane's own shell is running, and Claude Code wakes the lane when it ends — and for 2 min (`SHELL_GRACE_MS`) after the shell stopped, never past 6 h (`BACKGROUND_LIVE_MAX_MS`) from the turn end.

Past the deadline with no activity, the fleet first nudges the lane (with `laneWatch.nudge`, on by default): one delivery to the lane itself, what it was waiting on, since when, and the status line to end with. Its `stale` lane event (`reason`: `waiting` or `no_status`, `waitingOn`, `since`, `stalls`) is made for the orchestrator only when the lane needs it: no answer to the nudge within 10 min (`PROBE_ANSWER_MS`), a third expiry since the lane last settled, or a lane that cannot be nudged. `stalls` counts the expiries since the lane last ended DONE, BLOCKED or NEEDS DECISION, the nudged ones included: two or three in a row is a lane to re-plan, not to nudge again (the Magentic-One rule). A probe is not stored: after a restart the deadline runs again in full. The orchestrator and lanes matching `laneEvents.ignore` are not watched. The watch lives in memory and is rebuilt from the stored lane events at start.

A session that went busy and idle again with no turn end is a lost turn end only when the watch took a hook from that window in that busy span: Claude Code's idle compaction runs inside the session and fires no hook, so a busy span with no hook is not a turn to lose (9 of one week's 74 stale events were a compaction read as a lost turn end). A real one is flagged as `stale` with reason `no_turn_end` and never nudged.

### 3.3 Lanes start on a Role's engine (node, fleet)

- **A node may run engines.** `policy.engines.cli` names the engine layer's CLI on that node; `policy.engines.launch` maps a provider to its launch command, with `{model}`, `{effort}`, `{account}` and `{lane}` filled from the pick and the op. A word that is only a placeholder with no value (a model without an effort) is left out, with the option just before it.
- **`lane.start` takes `role` or `engine`.** With `role`, the node asks its engine layer (`resolve <role> --json`) what runs now, and launches that provider. With `engine` (`provider:model[@effort]`), it launches that one. A pick whose provider has no launch command on the node, a role the resolver can fill with nothing, a node without an engine layer, or the engine layer's switch off (`option enabled`) is refused: never a quiet fall back to the default `launch`.
- **The answer says what ran.** `lane.start`'s answer carries `engine` and, for a role, what the resolver skipped. When the pick is not the Chain's first choice, the fleet raises the alert `engine_fallback`. Every start with a role or an engine is in the fleet's audit with its reason and the entry that ran.
- **A default role, per node.** `policy.engines.defaultRole` is the role of every new lane on that node that names none (not a resume, not a protected lane such as the orchestrator). It lives with the launch commands it needs, on the node, so a node without engines never gets a role it can't run. With a default role set, naming an engine instead needs a `reason`, which the audit keeps.
- **Release is its own step.** A Role such as `release` takes a reviewed commit as it is; a fix goes back to the implementation lane (build once, release what was tested: [12factor.net/build-release-run](https://12factor.net/build-release-run), [continuousdelivery.com](https://continuousdelivery.com/implementing/patterns/)). This is a rule for the orchestrator's briefs, not code.

### 3.4 Done needs evidence (board)

B3 already keeps a lane from moving its task to Done, and a lane's DONE moves its task to Review in its own hands. New: the manager moves a task to Done only with a reason that names its evidence (what was checked: tests, CI at a commit, a review). The principal may move without one. B8 stands: Done is still an acceptance, not proof; the reason makes it one that can be checked.

### 3.5 The orchestrator's brief

`morndo lanes brief` (`--json` for a program) prints, from the fleet, what an orchestrator must know after a restart or a compaction: each lane's last status and deadline, the stale ones with their stall count, deliveries still waiting, and the last day's alerts, in at most 60 lines. Run as a `SessionStart` hook with the matcher `startup|resume|clear|compact`, it is put back into the orchestrator's context every time the conversation starts or is compacted ([Claude Code hooks](https://code.claude.com/docs/en/hooks), [memory](https://code.claude.com/docs/en/memory): an instruction given only in conversation may be lost at compaction). The state lives in the fleet, not in the conversation (Magentic-One's ledger, [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)'s todo file).

## 4. Not in this step

- A status as a tool call rather than a line: Claude Code lanes have no Morndo tool yet. The line is what lane events already read.
- Restarting the orchestrator by itself: the brief makes a restart or a compaction safe; when to restart stays the operator's.
- Engines outside the engine layer's providers: a provider the resolver doesn't know can still run by `engine` with a launch command.

## 5. Checks

Unit tests for each rule above (the status line, the relay's one ask, the lease table, stall counting, role resolution and its refusals, the fallback alert, the reason rule, Done's evidence, the brief); fleet tests with real agents for a role start and a stale lane; negative controls for the relay's ask, the lease and the refusal of an engine a node does not advertise.
