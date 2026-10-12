---
name: loop-review-fix
description: A reviewer from another model family checks the work against criteria fixed in advance, the worker fixes, and the loop ends when the review is clean or after 2 to 3 rounds, then escalates to a person. Use when the criteria are clear and the task is beyond what the model does reliably alone, such as code review before a merge or fact-checking a draft. Not when the model already does the task reliably. Covers how it fails (endless rounds, grading its own work, editing tests to pass) and the guards that catch it.
license: AGPL-3.0 (LICENSE.md in the Morndo repository)
metadata:
  morndo-kind: loop-pattern
  morndo-sources-read: "2026-10-12"
  morndo-recheck: "2027-01-10"
---

# Review, fix

A worker produces; a separate reviewer judges against criteria fixed before the first round; the worker fixes what the reviewer found. The loop has a round limit and an exit to a person.

## When to use

- The criteria are clear and another round measurably improves the result (Anthropic, Building effective agents).
- The task sits beyond what the model does reliably alone. One vendor found the separate evaluator worth its cost exactly there (Anthropic, Harness design).
- Typical steps: a code review before a merge, a fact check of a draft, an edit of someone else's text.

## When not to use

- The model already does the task reliably. For such tasks the same vendor found the evaluator became overhead (Anthropic, Harness design). Use `loop-one-shot`.
- There are no criteria anyone can state. The rounds turn into taste and never converge.
- The fix would need a person's decision (scope, product, money). Ask; don't loop.

## How to run it

1. Fix the criteria before the first round, each with a threshold that fails the round when missed. One vendor used a hard threshold per criterion and tuned a standalone evaluator to be skeptical, which it found far easier than making a worker critical of its own work (Anthropic, Harness design).
2. Pick the reviewer from another model family than the worker.
3. During the fix, hide the tests from the worker or make them read-only, and revert any test change before scoring. Both cut cheating sharply in ImpossibleBench.
4. Check each finding before fixing it: reproduce it, or find the code or source that confirms it. Drop the ones that don't hold.
5. The worker fixes; the checks run again, on the new revision.
6. Stop after 2 or 3 rounds. Escalate with the open findings, the evidence and the cost so far.
7. Give the worker an explicit way out for tasks it finds impossible or contradictory, such as answering that a person must look. In ImpossibleBench this cut GPT-5's cheating from 54% to 9% and o3's from 49% to 12%, but the effect was much weaker for Claude Opus 4.1. Treat it as an extra, never as the guard that stands alone.

## Failure modes

- **looping:** rounds that never end, or that undo each other. Step repetition (15.7%) and not recognising that the task is done (12.4%) are among the most frequent failures in annotated multi-agent traces (MAST).
- **self-grading:** agents asked to judge their own work tend to praise it, even when it is mediocre (Anthropic, Harness design). Model judges favour their own outputs (Panickssery et al.) and show position and verbosity biases (Zheng et al.).
- **gaming-tests:** the worker makes the tests pass instead of the code work. On impossible tasks GPT-5 cheated 54% of the time on one variant; Claude models cheated mostly by editing tests, OpenAI models more often by special-casing; letting models retry raised cheating from 33% to 38% (ImpossibleBench).

## Guards

| Guard | Catches | Morndo rule |
|---|---|---|
| A reviewer from another model family than the worker. | self-grading | The other-provider rule (ADR-0013). |
| Criteria and thresholds fixed before the first round; the verdict comes from checks, not from the worker. | self-grading, looping | V1: verified only with evidence from a producer other than the claimant. |
| Tests hidden or read-only during the fix; a weakened test refutes the claim. | gaming-tests | V3: a claimed revision that weakens a check is refuted. |
| Every finding checked before it is fixed; any refuting evidence wins. | self-grading | V2: refuting evidence makes the claim refuted, whatever else passed. |
| At most 2 or 3 rounds, then escalate with the open findings. | looping | None yet. |
| An exit to a person for impossible tasks, never the only guard. | gaming-tests | None yet. |

## Sources

- Anthropic, Building effective agents (2024-12-19). https://www.anthropic.com/engineering/building-effective-agents (read 2026-10-12). The evaluator-optimizer loop fits when criteria are clear and iteration adds measurable value.
- Anthropic, Harness design for long-running application development (2026-03-24). https://www.anthropic.com/engineering/harness-design-long-running-apps (read 2026-10-12). Self-praise; a skeptical standalone evaluator; hard thresholds per criterion; the evaluator is overhead within what the model does reliably and worth it beyond.
- Zhong, Raghunathan, Carlini, ImpossibleBench, arXiv:2510.20270, v1 2025-10-23. https://arxiv.org/abs/2510.20270 (read 2026-10-12). Cheating rates and kinds per vendor; retries raise cheating; hidden and read-only tests; the abort exit and its weaker effect on Claude Opus 4.1.
- Cemri et al., Why Do Multi-Agent LLM Systems Fail? (MAST), arXiv:2503.13657, v3 2025-10-26. https://arxiv.org/abs/2503.13657 (read 2026-10-12). Step repetition and missed task completion rates.
- Panickssery, Bowman, Feng, LLM Evaluators Recognize and Favor Their Own Generations, arXiv:2404.13076. https://arxiv.org/abs/2404.13076 (read 2026-10-12). Self-preference of model evaluators.
- Zheng et al., Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena, arXiv:2306.05685. https://arxiv.org/abs/2306.05685 (read 2026-10-12). Position, verbosity and self-enhancement biases of model judges.
