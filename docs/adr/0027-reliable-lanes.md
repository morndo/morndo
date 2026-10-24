# ADR-0027: Reliable lanes: a status at every turn end, deadlines for waiting, engines by role, Done with evidence

- **Status:** Accepted, 2026-10-13. Design: [`docs/design/reliable-lanes/README.md`](../design/reliable-lanes/README.md).
- **Number:** 0019 to 0026 belong to other pull requests.
- **Builds on:** ADR-0012 (the fleet, typed operations), ADR-0013 (Roles, Engines, Chains; the engine layer's resolver), ADR-0014 (the delivery queue and lane events), ADR-0015 (the board).

## Context

An orchestrator that runs many lanes has to know, for each one, whether it is done, stuck, waiting for something, or quietly gone idle. Claude Code's `Stop` hook marks a turn's end, not a task's, and lane events turned every one into `finished`. In a week of real use, most of those carried no status line, many ended with background work still running, and nothing noticed a lane that stopped without saying where it stood. Lanes also started on whatever the node's single launcher ran, so a Role's Chain in the engine layer was never consulted, and a missed binary sent work to the last engine of a chain unseen.

Other agent systems make the same split explicitly: a finish action or submit separate from a turn's end (OpenHands, SWE-agent), a stall counter that triggers re-planning (Magentic-One), a turn `stopReason` that is not a task's end (Agent Client Protocol), an agent's finish that means review, not Done (Vibe Kanban). The design compares them.

## Decision

1. **Every turn ends with a status line.** `STATUS: DONE`, `STATUS: BLOCKED`, `STATUS: NEEDS DECISION`, or `STATUS: WAITING <on what> [for <N> min|h]`. When a lane's answer has none, the node's hook relay asks once, as a Stop hook's `decision: "block"`: only for Claude Code's own Stop, never when a Stop hook already caused it, never while background work runs or a wake-up is scheduled, never for the orchestrator (`policy.statusContract`). The asked Stop is not a turn end and makes no lane event; it is still delivered to subscribers, marked `statusAsked`, so the answer it carried is never lost.
2. **Waiting has a deadline.** The fleet keeps each lane's last turn end. WAITING holds until its lease (at most a day), background work or a wake-up for `laneWatch.waitingMin`, no status for `laneWatch.noStatusMin`; DONE, BLOCKED and NEEDS DECISION have none. Past the deadline with nothing from the lane, the fleet makes one `stale` lane event per turn and, by default, nudges the lane once. It counts stalls until the lane settles and stops nudging after two. The watch lives in memory and is rebuilt at start, where the restart counts as activity.
3. **Lanes start on a Role's engine.** A node's `policy.engines` names the engine layer's CLI, a launch command per provider and an optional default role. `lane.start` takes `role` or `engine`. It fails closed: a role nothing can fill, a provider without a launch command, no engine layer, or the layer switched off refuse the start, and nothing falls back to the node's own launcher. The answer names the engine that ran and what the resolver passed over; a fallback raises the `engine_fallback` alert; the audit keeps the role or engine, the reason, and what ran. Naming an engine on a node with a default role needs a reason.
4. **Done needs evidence.** The manager moves a task to Done only with a reason that names what it checked (B9). It remains an acceptance, not Evidence (B8).
5. **The orchestrator's state comes from the fleet.** `morndo lanes brief` prints each lane's last status and deadline, the stale ones and their stalls, deliveries not yet taken and the day's alerts, in at most 60 lines, for a `SessionStart` hook to put back into context after a start, a resume or a compaction.

Release as its own step (a release lane ships a reviewed commit as it is; a fix goes back to the implementation lane) is a rule for the orchestrator's instructions, not code.

## Consequences

- Lane events gain `stale` and the status `waiting`; the client API gains `GET /v1/lane-watch`; `lane.start` gains `role`, `engine` and `reason`, and its answer `engine`; alerts gain `engine_fallback`. Older clients ignore what they don't know.
- A node joined before this keeps working: without `engines` in its policy, lanes start as before and a role or engine is refused; the status ask is on by default and can be turned off per node.
- A turn that was asked costs one more short model turn. It is at most one per turn, by `stop_hook_active`.
- A default role makes the engine layer's resolver part of every new lane's start on that node: a resolver that can't see a provider's program (a service `PATH` without it) refuses the provider, and the start says so instead of using it silently.
- The lane watch's deadlines are minutes, read against the node's clocks; FL13's 2-second offset alert covers clocks that drift apart.

## Sources (checked 2026-10-13)

- Claude Code hooks: `Stop` fires when the agent finishes responding; `decision: "block"` with a `reason` keeps it going; `stop_hook_active`; eight continuations in a row at most; an HTTP hook's 2xx JSON answer is read as a command hook's output; `SessionStart` matchers `startup`, `resume`, `clear`, `compact`. https://code.claude.com/docs/en/hooks
- Magentic-One's progress ledger and stall counter: arXiv 2411.04468. OpenHands, SWE-agent, the Agent Client Protocol and Vibe Kanban: the design's §2.
- Early completion and missing verification as common agent failures: arXiv 2503.13657; Anthropic, "Effective harnesses for long-running agents" (2025-11-26).

## Amendment 2026-10-24 (T-422)

A Stop hook killed by Claude Code's timeout never makes a `finished` event, and DONE, BLOCKED and NEEDS DECISION have no deadline, so that lane was invisible. The watch now also reads each session's state from the node's inventory. A session it saw go from working (busy or waiting) to idle, with no turn end arriving within 5 minutes, gets one `stale` event with reason `no_turn_end`, and with nudges on, one nudge asking for a status line. A user interrupt (Esc) ends a turn the same way, with no Stop hook, and is flagged the same. Only a lane that has made at least one turn end the fleet knows of is judged, and only after the watch saw it start working.
