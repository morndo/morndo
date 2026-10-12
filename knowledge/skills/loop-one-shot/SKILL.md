---
name: loop-one-shot
description: One run, one output, one check fixed before the run. Use when a task fits in a single model call or one short agent session and a check settles it (a test, a schema, an expected output, a diff). Not for work larger than one context window, or whose steps nobody can name yet. Covers when to use it, when not, how it fails (claiming done when it isn't, editing the check) and the guards that catch it.
license: AGPL-3.0 (LICENSE.md in the Morndo repository)
metadata:
  morndo-kind: loop-pattern
  morndo-sources-read: "2026-10-12"
  morndo-recheck: "2027-01-10"
---

# One-shot

One worker, one run, one output. A check, written before the run, decides whether the output is done. There is no retry loop inside this pattern: a second attempt is a different pattern with its own limits.

## When to use

- The task fits in one model call or one short session: a function with a test, a summary against a schema, a config change with a dry run.
- A check exists that settles it without judgement: a test, a validator, an expected output, a diff against a known file.
- Many applications need no more than one well-prompted call with retrieval and examples; reach for a loop only when this is shown not to be enough (Anthropic, Building effective agents).

## When not to use

- The work is larger than one context window. Agents asked to build a whole application at once tended to run out of context mid-feature and leave the next session a half-built feature (Anthropic, Effective harnesses). Use `loop-plan-execute-verify`.
- The steps can't be named yet, or the result needs rounds of critique to reach the bar. Use `loop-plan-execute-verify` or `loop-review-fix`.
- The output goes outside the user's machines (publish, send, pay, deploy). Add `loop-human-gate` before that step.

## How to run it

1. Write the check first: what the output is, where it goes, the command or rule that passes or fails it.
2. Keep the check out of the worker's reach: it can read it if it must, never change it.
3. Run the worker once.
4. Run the check yourself, or have something other than the worker run it, on the exact output the worker produced.
5. Report the check's verdict and output, and list anything the worker left undone.
6. On a failure, stop. Either escalate, or start `loop-review-fix` with a round limit. Don't re-run silently until something passes.

## Failure modes

- **silent-partial:** the worker says done when part of the task is missing. A later session in one vendor's long-running experiments looked around, saw progress, and declared the whole job finished (Anthropic, Effective harnesses).
- **gaming-tests:** the worker changes the check instead of the work. On impossible tasks, models edited or special-cased tests often; hiding tests or making them read-only cut it sharply (ImpossibleBench).

## Guards

| Guard | Catches | Morndo rule |
|---|---|---|
| The check is written before the run and run by someone other than the worker. | silent-partial | V1: verified only with evidence from a producer other than the claimant, on the claimed revision. |
| A change that touches what the check depends on fails the claim. | gaming-tests | V3: a claimed revision that weakens a check is refuted. |
| The report leads with the check's verdict, not the worker's summary, and lists what wasn't done. | silent-partial | E6: a report's headline is the verdict, never the worker's words. |
| No retry inside the pattern; a second try is `loop-review-fix` with a round limit. | looping | None yet. |

## Sources

- Anthropic, Building effective agents (2024-12-19). https://www.anthropic.com/engineering/building-effective-agents (read 2026-10-12). For many applications a single optimised model call with retrieval and in-context examples is enough.
- Anthropic, Effective harnesses for long-running agents (2025-11-26). https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents (read 2026-10-12). Agents that try to build an app in one go run out of context and leave half-built features; later sessions declare the job done too early.
- Zhong, Raghunathan, Carlini, ImpossibleBench, arXiv:2510.20270, v1 2025-10-23. https://arxiv.org/abs/2510.20270 (read 2026-10-12). Models exploit test cases on impossible tasks; hidden or read-only tests reduce it.
