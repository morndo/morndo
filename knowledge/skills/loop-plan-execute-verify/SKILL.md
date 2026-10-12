---
name: loop-plan-execute-verify
description: Write the steps and a check for each before any work, do the steps one at a time, then verify the end state against the goal. Use for multi-step work whose steps can be named up front, such as a feature with a known spec, a migration, or a report with known sections. Not when the plan would have to fix details nobody knows yet. Covers how it fails (claiming done early, drifting off the task, editing checks) and the guards that catch it.
license: AGPL-3.0 (LICENSE.md in the Morndo repository)
metadata:
  morndo-kind: loop-pattern
  morndo-sources-read: "2026-10-12"
  morndo-recheck: "2027-01-10"
---

# Plan, execute, verify

A plan names the steps and the check for each, before work starts. The worker does one step at a time and records progress. At the end the result is checked as a whole, against the goal, not against whether the steps were followed.

## When to use

- The work has several steps that can be named now: the features of a known spec, the tables of a migration, the sections of a report.
- Each step can have its own check. Programmatic checks between steps keep a chain of model calls on track (Anthropic, Building effective agents).
- The work spans more than one session or context window, so progress must survive in files, not in a conversation.

## When not to use

- The plan would have to fix details nobody knows yet. One vendor kept its planner at the level of deliverables, because wrong technical detail in a spec cascades into the implementation (Anthropic, Harness design). Plan what must be delivered and how it is checked; leave the path open.
- One call settles it. Use `loop-one-shot`.
- The quality bar needs rounds of critique on one artifact. Use `loop-review-fix` for that step.

## How to run it

1. Write done-means before work: the list of steps or features, each with the check that proves it. Agree it with whoever accepts the work, then freeze it.
2. Keep the list in a file the worker updates only by marking status. One vendor used JSON for its feature list because models were less likely to rewrite it than Markdown, and told the agent that removing or editing tests is unacceptable (Anthropic, Effective harnesses).
3. Work on one step at a time; that alone curbed the tendency to do too much at once (Anthropic, Effective harnesses).
4. After each step, run its check and record the result and the progress in a file, so a fresh session can pick up from it.
5. At the end, check the end state: the goal, the outputs, the system as it now is (Anthropic, multi-agent research system). Add a check of the high-level objective: adding one to a multi-agent coding system raised task success by 15.6% in one study (MAST).
6. Report each step with its check result, then the end-state verdict.

## Failure modes

- **silent-partial:** a later session sees progress and declares the job done (Anthropic, Effective harnesses). Premature termination and missing or wrong verification are common failure modes in annotated multi-agent traces (MAST).
- **drift:** on longer tasks agents still go off the rails over time (Anthropic, Harness design), and recall of what is in the context falls as the context fills (Anthropic, Effective context engineering).
- **gaming-tests:** a step's check is weakened so the step passes (ImpossibleBench).

## Guards

| Guard | Catches | Morndo rule |
|---|---|---|
| Done-means written and frozen before work; checks run by someone other than the worker. | silent-partial | V1: verified only if every Check has evidence from a producer other than the claimant, on the claimed revision. |
| A step that changes anything its check depends on fails the claim. | gaming-tests | V3: a claimed revision that changes anything a Check depends on (for example, weakens the test) is refuted. |
| A feature list the worker can only mark, one feature at a time. | silent-partial, drift | None yet. |
| Progress in a file; a fresh session per step reads it instead of a long conversation. | drift | None yet. |
| The final verdict is on the end state and the goal, and leads the report. | silent-partial | E6: a report's headline is the verdict, never the worker's words. |
| A lane holds one task in progress at a time. | drift | B5: at most one task in progress per lane. |

## Sources

- Anthropic, Building effective agents (2024-12-19). https://www.anthropic.com/engineering/building-effective-agents (read 2026-10-12). Prompt chaining with programmatic checks on intermediate steps.
- Anthropic, Harness design for long-running application development (2026-03-24). https://www.anthropic.com/engineering/harness-design-long-running-apps (read 2026-10-12). Planner errors cascade into implementation; agents go off the rails on long tasks.
- Anthropic, Effective harnesses for long-running agents (2025-11-26). https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents (read 2026-10-12). A feature list in JSON, one feature at a time, progress kept in files; later sessions declare the job done too early.
- Anthropic, Effective context engineering for AI agents (2025-09-29). https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents (read 2026-10-12). Recall falls as the context fills; note-taking outside the context.
- Anthropic, How we built our multi-agent research system (2025-06-13). https://www.anthropic.com/engineering/multi-agent-research-system (read 2026-10-12). Evaluate the end state of agents that change state over many turns.
- Why Do Multi-Agent LLM Systems Fail? (MAST), arXiv:2503.13657, v3 2025-10-26. https://arxiv.org/abs/2503.13657 (read 2026-10-12). Failure taxonomy; a high-level objective check raised task success by 15.6% in one system.
- ImpossibleBench: Measuring LLMs' Propensity of Exploiting Test Cases, arXiv:2510.20270, v1 2025-10-23. https://arxiv.org/abs/2510.20270 (read 2026-10-12). Models edit or special-case tests to pass.
