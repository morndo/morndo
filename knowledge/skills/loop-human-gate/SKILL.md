---
name: loop-human-gate
description: Stop and wait for the principal before an outward or irreversible step, such as publish, send, pay, delete, deploy or push to a shared branch, and after repeated failures. Use before any step that leaves the user's machines or can't be undone. Not for low-risk, reversible steps, where gates breed rubber-stamp approvals. Covers how it fails (approving without looking, a gate that fires after the action, an approval reused for a changed version) and the guards that catch it.
license: AGPL-3.0 (LICENSE.md in the Morndo repository)
metadata:
  morndo-kind: loop-pattern
  morndo-sources-read: "2026-10-12"
  morndo-recheck: "2027-01-10"
---

# Human gate

Before a step that acts outside the user's machines or can't be undone, the work stops and asks the principal. The question carries the evidence; only an answer moves it on.

## When to use

- Actions that are sensitive, irreversible or high-stakes, and after an agent exceeds its failure thresholds (OpenAI, A practical guide to building agents).
- Publishing, sending messages, paying, deleting data, deploying, merging or pushing to a shared branch.

## When not to use

- Low-risk, reversible steps. People approve nearly everything they are asked: users approved 93% of permission prompts in one vendor's data, which it calls approval fatigue (Anthropic, Claude Code auto mode). Every needless gate trains that habit.
- Checks a program can decide. Run the check; ask only what needs a person.

## How to run it

1. List the steps that are outward or irreversible. Put a gate directly before each one, and nowhere else.
2. Make the check block before the side effect. A guardrail that runs in parallel with the agent can trip after the agent has already spent tokens and run tools (OpenAI Agents SDK, Guardrails).
3. Put the evidence in the question: what will happen, the rendered result or the diff, the checks and their results, the cost, and how to undo it if that is possible.
4. Offer explicit options, such as approve, change or drop.
5. Silence never approves. An unanswered gate expires, does nothing and reports that.
6. Bind the approval to one action and the exact version shown. A changed version needs a new answer.
7. Record the answer with the version it was given for.

## Failure modes

- **rubber-stamp:** the principal approves without looking, because most prompts don't matter (Anthropic, Claude Code auto mode).
- **late gate:** the check runs beside the action instead of before it, so the action has already happened when it trips (OpenAI Agents SDK, Guardrails).
- **stale approval:** an approval given for one version is applied to a changed one, or a timeout is read as consent.

## Guards

| Guard | Catches | Morndo rule |
|---|---|---|
| Gates only before outward or irreversible steps. | rubber-stamp | A2: an irreversible action needs a live allow-Mandate that covers it; F4 is the failure class it prevents. |
| Silence, timeouts and defaults never approve. | stale approval | A1: worker text, relayed quotes, timeouts and defaults create no Mandate. |
| The check blocks before the side effect. | late gate | None yet. |
| One approval, one action, the version shown. | stale approval | A3: a once-Mandate authorises one action; E12: an answer for a restated Ask is refused. |
| An Ask whose action is gone is shown as expired. | stale approval | E7: an Ask whose action is no longer pending is shown as expired. |
| The question carries the evidence, the cost and the undo. | rubber-stamp | None yet. |

## Sources

- OpenAI, A practical guide to building agents (PDF). https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf (read 2026-10-12). Human intervention for sensitive, irreversible or high-stakes actions and after failure thresholds.
- Anthropic, How we built Claude Code auto mode (2026-03-25). https://www.anthropic.com/engineering/claude-code-auto-mode (read 2026-10-12). Users approve 93% of permission prompts; approval fatigue.
- OpenAI Agents SDK, Guardrails. https://openai.github.io/openai-agents-python/guardrails/ (read 2026-10-12). Parallel guardrails may trip after the agent has spent tokens and run tools; blocking guardrails finish before the agent starts.
