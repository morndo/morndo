---
name: loop-scheduled
description: A run on a timer, each run bounded by turns, time and budget, with rules that skip a run, stop it, or pause the whole schedule. Use for recurring work with a fresh input each time, such as a daily report, a weekly dependency check or a daily post. Not when nothing changes between runs, or when no metric tells a good run from a bad one. Covers how it fails (runs that never end, drifting output, runaway cost) and the guards that catch it.
license: AGPL-3.0 (LICENSE.md in the Morndo repository)
metadata:
  morndo-kind: loop-pattern
  morndo-sources-read: "2026-10-12"
  morndo-recheck: "2027-01-10"
---

# Scheduled loop

A timer starts a run; each run takes a fresh input, does bounded work, checks it and reports. Rules decide when a run is skipped, when it stops, and when the schedule itself pauses for a person.

## When to use

- The work recurs and each run has a new input: today's topic, this week's dependency updates, last night's errors.
- Each run can be bounded. Agents usually stop on completion, and it is common to add stopping conditions such as a maximum number of iterations (Anthropic, Building effective agents); common exit conditions include reaching a maximum number of turns (OpenAI, A practical guide to building agents).
- A metric over runs tells whether the schedule is worth keeping.

## When not to use

- No input changes between runs: the loop would redo the same work.
- No metric tells a good week from a bad one: nobody will notice when it goes wrong.
- A one-off task. Use `loop-one-shot` or `loop-plan-execute-verify`.

## How to run it

1. Start each run from a timer that already exists; each run is one job that ends once and reports once.
2. Check the input first. No input means no run: skip and report the skip.
3. Bound each run by turns, wall time and budget. The OpenAI Agents SDK, for example, raises `MaxTurnsExceeded` past `max_turns`, which defaults to 10 (OpenAI Agents SDK, Running agents).
4. Inside a run, use the other patterns: `loop-plan-execute-verify` for the work, `loop-review-fix` for quality, `loop-human-gate` before anything outward.
5. Set failure thresholds that hand control to a person (OpenAI, A practical guide to building agents). Pause the schedule after a few failed, rejected or expired runs in a row, and ask.
6. Keep a budget per run and per month.
7. Review the metric on a fixed cadence and drop the schedule when it stops paying.

## Failure modes

- **looping:** a loop with no stop runs until someone ends it; one vendor's harness looped its agent forever by design (Anthropic, Building a C compiler). Long-running agents fall into tangential loops they rarely recover from (Vending-Bench). Step repetition and not recognising completion are frequent multi-agent failures (MAST).
- **drift:** run after run, the output wanders from what was asked; agents go off the rails on longer tasks (Anthropic, Harness design).
- **silent-partial:** a run that ends early, or whose process vanishes, reads as a quiet success unless its end is recorded; premature termination is one of the failure modes in annotated multi-agent traces (MAST).
- **cost-blowup:** an unattended loop spends without anyone looking; multi-agent systems use about 15 times the tokens of a chat (Anthropic, multi-agent research system).

## Guards

| Guard | Catches | Morndo rule |
|---|---|---|
| A turn cap and a wall-time cap per run, with a controlled stop. | looping | None yet. |
| A budget per run and per month; spend that reaches the budget gets no new lease. | cost-blowup | CN11: no new lease once spend and reservations reach the budget; CN12 warns at 50, 80 and 95%. |
| Each run is one job that becomes terminal once, is never restarted, and sends one notice. | looping | J2: a job becomes terminal exactly once; J3: one notice per terminal job. |
| A run whose process vanished is shown as lost, never deleted. | silent-partial | J4: a lost job keeps its row and its notice. |
| A missing input skips the run and says so. | drift, cost-blowup | None yet. |
| A few failed or rejected runs in a row pause the schedule and ask a person. | looping, drift | None yet. |
| A metric reviewed on a cadence. | drift | None yet. |

## Sources

- Anthropic, Building effective agents (2024-12-19). https://www.anthropic.com/engineering/building-effective-agents (read 2026-10-12). Stopping conditions such as a maximum number of iterations.
- OpenAI, A practical guide to building agents (PDF). https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf (read 2026-10-12). Exit conditions including a maximum number of turns; failure thresholds that escalate to a person.
- OpenAI Agents SDK, Running agents. https://openai.github.io/openai-agents-python/running_agents/ (read 2026-10-12). `max_turns` and `MaxTurnsExceeded`; the default of 10 is `DEFAULT_MAX_TURNS` in `src/agents/run_config.py` on the main branch, read the same day (package version 0.23.1 on PyPI).
- Anthropic, Building a C compiler with a team of parallel Claudes (2026-02-05). https://www.anthropic.com/engineering/building-c-compiler (read 2026-10-12). An unattended agent loop that never stops on its own.
- Vending-Bench: A Benchmark for Long-Term Coherence of Autonomous Agents, arXiv:2502.15840, 2025-02-20. https://arxiv.org/abs/2502.15840 (read 2026-10-12). Long runs derail into loops they rarely recover from.
- Why Do Multi-Agent LLM Systems Fail? (MAST), arXiv:2503.13657, v3 2025-10-26. https://arxiv.org/abs/2503.13657 (read 2026-10-12). Step repetition 15.7%, missed task completion 12.4%, premature termination.
- Anthropic, Harness design for long-running application development (2026-03-24). https://www.anthropic.com/engineering/harness-design-long-running-apps (read 2026-10-12). Agents go off the rails on longer tasks.
- Anthropic, How we built our multi-agent research system (2025-06-13). https://www.anthropic.com/engineering/multi-agent-research-system (read 2026-10-12). Multi-agent systems use about 15 times the tokens of a chat.
