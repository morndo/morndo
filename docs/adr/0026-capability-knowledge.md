# ADR-0026: Capability knowledge, lean: loop patterns and recurring jobs as Agent Skills, model facts imported from models.dev, preferences apart, our own results decide

- **Status:** Proposed, 2026-10-12; revised the same day to the lean scope the principal chose. Design: [`docs/design/capability-knowledge/README.md`](../design/capability-knowledge/README.md). Design only; no product code.
- **The request:** issue #30, a capability knowledge base for the orchestrator: what models are and cost, agent loop patterns, procedures for recurring work.
- **Number:** 0019 to 0025 are taken by open pull requests (#12, #18, #20, #21, #22, #28, #35).
- **Builds on:**
  - ADR-0013: Roles, Engines, chains, the other-provider rule.
  - ADR-0015: the board and its proposals.
  - ADR-0017: jobs that report back.
  - ADR-0018: Connections and the vendor catalog.
  - ADR-0020 (proposed, PR #18): auto routing, the model class, the Scorecard.
- **Sources:** [S1]–[S32] in the design, section 13, all read 2026-10-12.

## Context

1. **The orchestrator improvises.** The manager briefs lanes and sets up recurring work from its instructions and its training data. Which loop fits a job, how it fails, and what a recurring job needs are decided again in each brief, and the reasons are lost with it.
2. **The loops and their failures are known.** Vendors and studies describe the common agent loops and how they fail: looping, gaming tests, claiming work that wasn't done, drift, grading one's own work, rubber-stamp approvals, runaway cost; and the guards that catch them (design, section 5).
3. **Hand-kept model facts rot.** The first draft of this design (68c3c0a) kept 67 quoted Facts on five vendors, about 47 of them due for re-check each month, and its own sources showed models superseded, prices cut and models deprecated within days of each other. Independent reviews also found that the five cards matched one user's subscriptions, and that a store of quotes from vendor pages in a public repository is a legal question (design, Q7).
4. **Standards exist for both halves.** Agent Skills is an open format for instructions agents load on demand, read by Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot and others [S1], [S2]. models.dev is an MIT-licensed open database of model limits and prices, 226 providers on 2026-10-12, changed many times a day [S5]–[S7].
5. **Opinions pass as facts.** Views such as "Claude writes best" and "Gemini is best for SEO" (issue #30) are assumed or forgotten. Neither is settled by a primary source today (design, section 6.5); this user's own approval record could settle them for this user.

## Decision

1. **Loop patterns ship as Agent Skills.** Six skills, `knowledge/skills/loop-<id>/SKILL.md`: one-shot, plan-execute-verify, review-fix, scheduled loop, fan-out with merge, human gate. Each says when to use it, when not, its failure modes, its guards with the Morndo rule that enforces each where one exists, and its sources as links with read dates. They follow the specification exactly (K16) and are installed per user by linking them into the agent CLIs' user skill folders.
2. **Recurring jobs are SOPs, written with a `recurring-job` skill and checked.** An SOP is data: trigger, steps, a check per step, the principal's gate before anything outward, stop rules, budget, report, metrics. `sop-check` refuses one that publishes without a gate, lets silence approve, loops without a round limit, or lacks a stop rule (K10). Templates name a Role and a model class with a family rule ("a cheap model from another vendor than the writer"), never a model id (K14). The daily blog post is the first template.
3. **Model facts are imported, not hand-kept.** Lineup, context, output limit and price come from a dated models.dev snapshot in the user's cache, with its licence notice (K15). It is community data: values the gate enforces stay in the catalog and are read only from there (K13).
4. **Hand-written Notes are small.** A link, the date read and a sentence in our own words per source; no stored quotes from vendor pages (K1). Leaderboard statements carry board, snapshot date and method (K3). A Note, skill or snapshot past its re-check date shows a warning and never fails CI (K6).
5. **Preferences are kept apart and shown beside our own results.** A Preference has a holder, a date and its words, is never shown as a fact (K4), and lives only in the user's overlay (K12). Beside it the CLI shows the Scorecard's first-try approvals and edits needed per model (ADR-0020).
6. **Knowledge grants nothing** (K9). It never admits, excludes, fences or ranks a Candidate; a template's model class is advisory, compared with what ran in each report.
7. **Order:** PR 1 the pattern skills; PR 2 the recurring-job skill, `sop-check` and the blog template; PR 3 the models.dev snapshot, the Preferences file and the Scorecard link. Deferred: the Disagreement and Proposal aggregates, the weekly re-check, the catalog link test, a page (design, section 11).

## Alternatives

| Option | Verdict |
|---|---|
| **The first draft: quoted capability cards per vendor, Disagreements, Proposals, a weekly re-check** | Deferred. The rules stay; the machinery waits for a need. Hand-kept facts rot faster than a monthly re-check, and the quotes are a legal question. |
| **Our own file format and loader for patterns** | Rejected. Agent Skills already gives the format, progressive loading and support in the agent CLIs the lanes run. |
| **Hand-written model lineups and prices** | Rejected. models.dev keeps them, under MIT, with the date we fetched. |
| **Commit the models.dev snapshot to the repository** | Rejected. Megabytes per refresh in a public history, for data that changes many times a day; the user's cache holds it, a trimmed fixture serves the tests. |
| **Patterns in this repository's `.agents/skills/`** | Rejected. They would load for anyone working on Morndo's own code; they are for the user's orchestrator and lanes. |
| **Templates with model ids** | Rejected. They break when models change and can't run for a user with one vendor. A class and a family rule keep working. |
| **Rankings in the prompt or in code** ("use Claude for writing") | Rejected. Unsourced, undated, and wrong within weeks. |
| **Knowledge as a ranking key in auto routing** | Rejected for now (Q3). ADR-0020 ranks this user's own Outcomes first. |
| **Shipped preferences ("the team's view")** | Rejected. A preference is a person's. |

## Consequences

- **Good:** each loop a brief or an SOP uses is a named skill with its failure modes and guards, read by any of the lanes' agent CLIs, at a cost of about a hundred tokens per skill until one is used.
- **Good:** a new kind of recurring work starts from a template whose gates, checks and stop rules are already in place and checked.
- **Good:** model facts stay current without a re-check job; their date is always shown.
- **Good:** the two claims in issue #30 stay what they are, preferences, beside the numbers that could turn them into evidence.
- **Cost:** six skills and a Notes folder to keep, with a 90-day re-check date each; a small check; a refresh command; a test of the skills against the specification.
- **Limit:** models.dev can differ from a vendor's own page (design, section 7, with an example). It informs; it never sets a gate value.
- **Limit:** for some kinds of work no credible public ranking exists (SEO among them). There the choice rests on a Preference or on this user's Scorecard.
- **Risk:** the specification may change. The skill test pins its rules as read on 2026-10-12, and the validator it names (`skills-ref`) is the reference to compare against.

## Verification this implies

1. Every shipped skill parses and meets the specification's rules; negative fixtures (bad name, name unequal to its directory, empty description, non-string metadata, a source without a date) are refused. A stale skill warns and passes.
2. One skill loaded by an agent CLI from its install link.
3. `sop-check` passes the blog template and refuses copies with the gate, the round limit, the stop rule, a check or a `why` removed, `on_silence` set to approve, or a model id in a template.
4. The snapshot loader marks an old snapshot stale and still shows it; no code path reads a gate value from it.
5. A Preference never renders as a fact, and a shipped file holding one fails.
6. Re-check triggers for this ADR: the Agent Skills specification changes its required fields; ADR-0020 changes how it uses the class; a credible public benchmark appears for SEO work or for non-fiction writing judged by people.
