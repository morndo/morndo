---
name: loop-fan-out-merge
description: Split work into independent parts, run them in parallel, then merge the results and check that no part was lost. Use for breadth-first research, independent files or modules, or several attempts at one problem. Not when parts share context or depend on each other, or when every worker would hit the same problem. Covers how it fails (runaway cost, parts lost or duplicated, workers overwriting each other) and the guards that catch it.
license: AGPL-3.0 (LICENSE.md in the Morndo repository)
metadata:
  morndo-kind: loop-pattern
  morndo-sources-read: "2026-10-12"
  morndo-recheck: "2027-01-10"
---

# Fan-out with merge

A lead splits the work into parts, workers do the parts in parallel, and the lead merges what comes back. The merge counts the parts and checks the whole.

## When to use

- The parts are independent: sectioning a task into independent subtasks, or voting by running one task several times (Anthropic, Building effective agents).
- Breadth-first research over many sources. One vendor's multi-agent research system beat its single-agent setup by 90.2% on an internal research evaluation (Anthropic, multi-agent research system).
- Several independent attempts at one hard problem, with a check that picks among them.

## When not to use

- The parts share context or depend on each other. The same vendor notes that most coding tasks have fewer truly parallel parts than research (Anthropic, multi-agent research system).
- It is one big task in disguise. When many agents worked on one giant task, each hit the same bug, fixed it, and overwrote the others' changes (Anthropic, Building a C compiler).
- Cost matters more than speed or breadth: multi-agent systems use about 15 times the tokens of a chat (Anthropic, multi-agent research system).

## How to run it

1. Split the work. Give each worker an objective, an output format, guidance on tools and sources, and clear boundaries; without them workers duplicate work and leave gaps (Anthropic, multi-agent research system).
2. Let each worker claim its part with a lock, so two never take the same part; one vendor used a text file per task as the lock (Anthropic, Building a C compiler).
3. Have workers write their results to files and pass references, instead of long messages through the lead (Anthropic, multi-agent research system).
4. Cap how many workers run at once, and set one budget for the whole fan-out.
5. Merge: count the parts sent out and the results that came back. A missing part is reported as missing, never filled in by guesswork.
6. Check each worker's result on its own, then the merged whole.

## Failure modes

- **cost-blowup:** tokens grow with every worker; about 15 times a chat for a multi-agent system (Anthropic, multi-agent research system).
- **silent-partial:** a part is lost in the merge, or a worker's failure is papered over by the summary.
- **duplicated or missing work:** vague task descriptions lead workers to duplicate work, leave gaps or miss information (Anthropic, multi-agent research system).
- **overwrites:** workers on a shared task undo each other's changes (Anthropic, Building a C compiler).

## Guards

| Guard | Catches | Morndo rule |
|---|---|---|
| A task description per worker: objective, output format, tools and sources, boundaries. | duplicated or missing work | None yet. |
| A lock per part. | overwrites, duplicated work | None yet. |
| A cap on concurrent workers; further ones wait in order. | cost-blowup | J5: a job class runs at most its configured limit; the rest stay queued in order. |
| One budget for the whole fan-out. | cost-blowup | CN11: no new lease once spend and reservations reach the budget. |
| Parts in equals parts out; a part with no result counts as unverified, not passed. | silent-partial | V4: missing evidence gives Unverified. |
| Each worker's result checked by someone other than that worker. | silent-partial | V1: verified only with evidence from a producer other than the claimant. |

## Sources

- Anthropic, Building effective agents (2024-12-19). https://www.anthropic.com/engineering/building-effective-agents (read 2026-10-12). Parallelization as sectioning and voting.
- Anthropic, How we built our multi-agent research system (2025-06-13). https://www.anthropic.com/engineering/multi-agent-research-system (read 2026-10-12). 90.2% over a single agent on an internal research evaluation; about 15 times the tokens of a chat; most coding tasks have fewer parallel parts than research; what each subagent needs; subagent output to a filesystem.
- Anthropic, Building a C compiler with a team of parallel Claudes (2026-02-05). https://www.anthropic.com/engineering/building-c-compiler (read 2026-10-12). Lock files per task; agents on one giant task overwrite each other's changes.
