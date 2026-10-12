---
name: recurring-job
description: Turn a job that repeats (a daily blog post, a weekly report, a nightly check) into an SOP, a checked procedure as data, built from the loop-pattern skills, with the principal's approval before anything outward, a Role and a model class per step instead of a model id, stop rules, a budget, a report and metrics; then run sop-check on it. Use when someone asks for the same work on a schedule or on an event, or when a brief has been written three times. Not for one-off work, or a job with no input that changes between runs.
license: AGPL-3.0 (LICENSE.md in the Morndo repository)
metadata:
  morndo-kind: procedure
  morndo-sources-read: "2026-10-12"
  morndo-recheck: "2027-01-10"
---

# Recurring job

An SOP is a recurring job written down as data: what starts it, what each step does and how it is checked, where the principal approves, when it stops, what it may spend, what it reports and what it measures. Write it once, check it with `scripts/sop-check.ts`, and ask the principal before its first run. The shape is in `assets/sop.schema.json`; the worked example is `assets/daily-blog-post.yaml`.

## When to use

- The same job is asked for on a schedule (every weekday morning, every Monday) or on an event (a card reaches a column, a file lands).
- Each run has a fresh input: today's topic, this week's changes, last night's errors.
- A brief for it has been written more than twice, and the reasons for its choices were lost each time.
- Something tells a good run from a bad one: an approval, a count, a cost.

## When not to use

- One-off work. Use `loop-one-shot` or `loop-plan-execute-verify` directly.
- Nothing changes between runs: the job would redo the same work.
- Nobody will read the report or the metrics: the job would run unwatched. Fix that first, or don't schedule it.

## How to design it

1. **The trigger.** One schedule (a cron line and a time zone) or one event. Check the input first: no input means the run is skipped and the skip reported, never an error.
2. **The loop around the runs.** Every recurring job is a `loop-scheduled`: per-run caps, a budget, and a rule that pauses the job after repeated failed or rejected runs.
3. **The steps, each from a pattern.** Work whose steps can be named up front follows `loop-plan-execute-verify`. A step that needs critique against criteria is `loop-review-fix`, with `max_rounds` of 1 to 5 (2 is a good default) and `on_fail` pointing back to an earlier step. Independent parts are `loop-fan-out-merge`. One call with a deciding check is `loop-one-shot`.
4. **Each step has an output and a check.** The check is fixed in the SOP, run by something other than the worker, and decides the step. Prefer a tool (a link check, a quote check, a validator) to a model's opinion.
5. **Deterministic work is a tool step.** Publishing, sending and fetching are programs, not models: `tool:` with no `model`.
6. **Gates, stop rules, budget, report, metrics,** as the next sections say.
7. **Check it:** `node scripts/sop-check.ts <sop.yaml>` from this skill's folder (or `npm run knowledge:sop-check -- <sop.yaml>` from the repository). Fix every refusal; the rule name says which part to change.
8. **Ask before the first run.** Send the principal the SOP: its steps, classes, citations, gates and budget. Their answer installs it or sends it back.

## Where the approval sits

- Before every step that acts outside the user's machines or can't be undone: publishing, posting, sending, paying, deleting, deploying, pushing to a shared branch. Mark such a step `effect: outward` or `effect: irreversible` and put a gate with `before:` that step. `sop-check` refuses an outward step without its gate, and a step whose id or tool reads as outward but doesn't say so (`loop-human-gate`; Morndo rules A2 and F4).
- Nowhere else. A gate on a reversible step trains the principal to approve without looking (`loop-human-gate`).
- The gate shows the evidence: the rendered result, the checks and their results, the cost, the citations. It offers `approve` among its options.
- Silence never approves: `on_silence: { after: 48h, then: expire }`, with `then` one of expire, drop or pause (Morndo rule A1).
- A requested change goes back to an earlier step (`on_change`) at most `max_changes` times, then the run ends.
- Spending past the budget is never automatic: `budget.on_exceed` is `stop` or `ask`.

## Choosing engines

- Name a **Role** of the engine layer (`plan`, `research`, `review`, `validate`, `implement-backend`, and the rest) and a **model class**: `flagship`, `everyday` or `fast`. Never a model id: ids change every few weeks, and a template with one breaks for anyone without that vendor (K14). To run a given engine, put it in the Role's chain.
- Add a **family rule** where independence matters: a judge from another family than the worker, as in `model: { class: fast, family: { other-than: [draft] } }`, a cheap model from another vendor than the writer. Model judges favour their own family's outputs.
- Give every engine step a **why**: a pattern skill, a note (`notes/<id>`), a preference (`pref:<id>`, instances only), the model snapshot (`models.dev@<date>`), or `no evidence: default`. A citation that resolves to nothing is refused; a note past its re-check date warns.
- The class and the family rule are advisory. The Role's chain and auto routing decide what runs; each run's report says when what ran didn't meet them (K9).
- A preference is shown as the user's, never as a fact. Its format is in `references/preferences.md`.

## Reporting and measuring

- Each run reports once, to a named place (`report.to`), holding what was done or why not, the cost per step, the rounds, the counts its checks produced, and the **citations** its steps used with their status (K11).
- `done` lists the checks that make a run done. A model's review may gate a step; it is never a done check.
- Stop rules are `{ when, then }`: no input, the budget spent, a loop past its rounds, repeated dropped runs, a wall-time limit.
- Metrics say whether the job is worth keeping: each has a `name`, where it comes `from` and how often (`every`). Approved first try, changes asked at the gate and cost per run are good defaults. Review them on that cadence; drop a job that stops paying.

## The check's rules

`sop-check` refuses by these names; each refusal names the step or field it is about.

| Rule | Refuses |
|---|---|
| `gate-before-outward` | An outward or irreversible step with no gate before it. |
| `outward-declared` | A step whose id or tool reads as outward (publish, post, send, push, deploy, pay, delete, ...) without `effect`. |
| `silence-never-approves` | A gate with no `on_silence`, or one whose `then` isn't expire, drop or pause. |
| `gate-shape` | A gate that names no step of the SOP, waits for anyone but the principal, shows nothing, or offers no `approve`. |
| `round-limit` | A loop or change loop without a limit of 1 to 5, or one that goes forward instead of back. |
| `stop-required` | No stop rule, or one without its `when` and `then`. |
| `budget-stop` | A budget without `per_run`, `per_month`, or `on_exceed` of stop or ask. |
| `engine-why` | An engine step without a why. |
| `why-resolves` | A citation that is no skill, note, preference, snapshot, or `no evidence: default`. |
| `step-check` | A step without an output and a check. |
| `no-model-id` | A model id where a class belongs, or a model on a tool step. |
| `model-class` | A class that isn't one, or a family rule that points at no earlier engine step. |
| `role-known` | A role the engine layer doesn't have (the defaults, or `--roles`). |
| `step-kind` | A step without an id, two steps with one id, or a step that is both or neither engine and tool. |
| `pattern-known` | A pattern that is not a shipped skill. |
| `trigger` | Not exactly one schedule or one event. |
| `done-required`, `report-citations`, `metrics-required` | No done checks; a report without its place or its citations; a metric without its name, source or cadence. |
| `shape` | A field the SOP doesn't have, or no SOP id, version or steps. |

## Sources

- OpenAI, A practical guide to building agents (PDF). https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf (read 2026-10-12). Human intervention for sensitive, irreversible or high-stakes actions, and after failure thresholds.
- Anthropic, How we built Claude Code auto mode (2026-03-25). https://www.anthropic.com/engineering/claude-code-auto-mode (read 2026-10-12). People approve nearly all permission prompts; approval fatigue, the reason to gate only what matters.
- ImpossibleBench: Measuring LLMs' Propensity of Exploiting Test Cases, arXiv:2510.20270, v1 2025-10-23. https://arxiv.org/abs/2510.20270 (read 2026-10-12). Letting models retry raised cheating on impossible tasks, the reason for round limits.
- LLM Evaluators Recognize and Favor Their Own Generations, arXiv:2404.13076, 2024. https://arxiv.org/abs/2404.13076 (read 2026-10-12). Model judges favour their own outputs, the reason for the family rule.
- Google Search Central, Spam policies, scaled content abuse. https://developers.google.com/search/docs/essentials/spam-policies (read 2026-10-12). Many pages made with generative tools without value for users count as abuse, the reason a cadence is a ceiling.
- JSON Schema, Specification: 2020-12 is the current version. https://json-schema.org/specification (read 2026-10-12). The dialect of `assets/sop.schema.json`.
