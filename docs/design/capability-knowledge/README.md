# Capability knowledge: loop patterns and recurring jobs as Agent Skills, model facts imported, preferences apart (design, lean scope, 2026-10-12)

**Phase: design only.** This document and [ADR-0026](../../adr/0026-capability-knowledge.md). No product code yet.

**The request:** issue #30. The orchestrating agent (the manager that briefs lanes, checks their results and runs recurring work) knows only what its instructions and its training data say about AI tools. That is not enough to plan new kinds of work. Example: "write a blog post every day". To set that up it has to know which agent loop fits, what each model is and costs, and how to turn the job into a repeatable procedure with its gates and stop rules.

**Lean scope (2026-10-12).** The first draft of this design proposed hand-kept, quoted capability cards for five engines, Disagreement and Proposal aggregates, a weekly re-check and a page. Two independent reviews found that the rules last but the hand-kept model facts start to rot the day they ship, that the first cards fit one user's subscriptions, and that storing quotes from vendor pages in a public repository is a legal question. The principal chose the lean build. What changed:

- Loop patterns and the recurring-job procedure ship as **Agent Skills** (`SKILL.md`, an open format several agent CLIs already load), not as a new file format with its own loader.
- Model lineups, context sizes and prices are **imported from models.dev**, not written by hand.
- Hand-written **Notes** hold a link, the date read and a sentence in our own words. No quotes from vendor pages. A stale Note shows a warning and never fails CI.
- **Templates name a Role and a model class** ("a cheap model from another vendor than the writer"), never a model id.
- Kept as they were: Preferences apart from Facts (K4, K12), knowledge never routes (K9), gates, checks and stop rules in every procedure (K10).
- Deferred (section 11): the Disagreement and Proposal aggregates (a pull request already is a proposal), the weekly re-check, the catalog link test, a Knowledge page.

**Builds on:**
- ADR-0013: Roles, Engines, chains, the other-provider rule.
- ADR-0015: the board, proposals, done.
- ADR-0017: background jobs that report back.
- ADR-0018: Connections and the vendor catalog (`packages/protocol/catalog/vendors.json`).
- ADR-0020 (PR #18, proposed): auto routing, the model class, Outcomes and the Scorecard.

**Number:** 0019 to 0025 are taken by open pull requests (#12, #18, #20, #21, #22, #28, #35).

**[S*n*]** points to section 13; every source there was read on 2026-10-12. UNVERIFIED marks what no primary source settled. **Q*n*** is open question *n* in section 12.

## 1. What exists today

- **The vendor catalog** (ADR-0018) holds what the gate enforces: each preset's runtimes, model list source, family, prices, isolation floor, and data terms. It says nothing about what a model is good at.
- **Auto routing** (ADR-0020, proposed) adds a model **class** per catalog model (`flagship`, `everyday`, `fast`), taken from each vendor's own words, and ranks Candidates by this user's own Outcomes first (the Scorecard: "4 of 5 accepted first try").
- **The engine layer** names the Roles (plan, implement, validate, review, research, read long documents, images, video) and runs each Role's chain (ADR-0013).
- **Nothing holds** which loop fits a job, how each loop fails, or how a recurring job is set up. Each new workflow is improvised in a brief, and the reason for each choice is lost with it.

## 2. Goals and non-goals

**Goals:**
- The common agent loops written down once, in a format the agent CLIs already load: when to use each, when not, how each fails, and the guard that catches it, with the Morndo rule that enforces the guard where one exists.
- A recurring job as data (an SOP): trigger, steps, a check per step, the principal's approval before anything outward, stop rules, budget, report, metric; and a check that refuses an SOP that breaks those rules.
- Model facts (lineup, context, price) from a maintained open dataset, dated, instead of by hand.
- The user's preferences recorded as preferences, beside this user's own results, never shown as facts.

**Non-goals:**
- No ranking of models in code or in shipped files. The Scorecard (ADR-0020) holds this user's results.
- No new routing rule. Knowledge grants nothing, excludes nothing and reorders nothing (K9).
- No scheduler. Triggers use what exists: the node's timers and ADR-0017's jobs.
- No automatic publishing of anything. Every outward step in an SOP comes after a gate.
- Not in this scope: shipped capability cards per vendor, the Disagreement and Proposal aggregates, the weekly re-check, the catalog link test, a page (section 11, later steps).

## 3. The model

### 3.1 Where it lives

A bounded context, **Knowledge**. Its shipped files live under `knowledge/` at the repository root; per-user files under `~/.config/morndo-knowledge/`; downloaded data under `~/.cache/morndo-knowledge/`. The pure rules (the SOP check, the staleness rule, the Preference rendering) go in `packages/domain/src/knowledge.ts` when PR 2 needs them; file reading is an adapter.

| Piece | Kind | Holds | Lives |
|---|---|---|---|
| Pattern skill | Shipped file, one per loop | When to use, when not, failure modes, guards, sources as links with read dates. | `knowledge/skills/loop-<id>/SKILL.md` |
| Recurring-job skill | Shipped file | How to write an SOP, the SOP check, templates. | `knowledge/skills/recurring-job/` |
| SOP | Aggregate, one per recurring job | Trigger, steps, gates, checks, stop rules, budget, report, metrics. Guards K10, K11, K14. | Templates in the skill's `assets/`; a user's instances in the overlay |
| Model facts | Read model over an imported snapshot | Lineup, context, output limit, price per model, from models.dev, with the date fetched. Guards K13, K15. | `~/.cache/morndo-knowledge/models-dev/` |
| Note | Shipped file | One topic: links, the date each was read, a sentence each in our own words, a re-check date. Guards K1, K3, K6. | the citing skill's `references/<topic>.md` |
| Preference set | Aggregate, one per user | The user's Preferences. Guards K4, K12. | `~/.config/morndo-knowledge/preferences.yaml` |

How it relates to the other contexts:
- **Engines and auto routing** read it, downstream. Nothing in it admits, excludes, fences or ranks a Candidate (K9).
- **Connections** stands beside it. The catalog stays the one place code reads what the gate enforces (terms revisions, prices for budgets, isolation floors). The models.dev snapshot never overrides a catalog value (K13).
- **The Scorecard** (ADR-0020) is read, not copied: beside a Preference the CLI shows this user's first-try approvals and edits needed per model for that kind of task.
- **Authority and Escalation:** an SOP's gate is an Ask to the principal; its answer is a Decision. Knowledge says where a gate must sit, not how it is answered.
- **Jobs:** every SOP run starts as a job that reports back (ADR-0017).

### 3.2 Ubiquitous language

| Term | Means | Is not |
|---|---|---|
| Skill | A directory with a `SKILL.md` in the Agent Skills format [S1]: front matter (`name`, `description`) and instructions an agent loads when the task matches. | A Morndo plugin; a prompt pasted into a brief. |
| Pattern | A named agent loop, shipped as a skill: one-shot, plan-execute-verify, review-fix, scheduled loop, fan-out with merge, human gate. | An SOP. |
| Failure mode | A named way a Pattern goes wrong: looping, gaming tests, silent partial result, drift, self-grading, rubber-stamp approval, cost blow-up (section 5). | A bug in one run. |
| Guard | What catches a Failure mode: a stop rule, a budget, an independent Check, a gate. | A hope that the model behaves. |
| SOP | A recurring job as data: trigger, steps, gates, checks, stop rules, budget, report, metrics. | A brief; a job (one run of a command). |
| Step | One stage of an SOP: its Pattern, its Role and model class, or a deterministic tool; its input, output and Check. | A lane. |
| Model class | `flagship`, `everyday` or `fast`, as ADR-0020 takes it from the vendor's words, with a family rule (`any`, `other-than` some Steps). | A model id. |
| Gate | A point in an SOP that waits for the principal before an outward or irreversible Step. | A review by another model. |
| Stop rule | A condition that ends a loop or skips a run: a count, a budget, a time, or a missing input. | A timeout alone. |
| Model facts | What the models.dev snapshot says about a model: lineup, context, output limit, price, release date, and the date fetched. | A vendor's own page; a value the gate enforces. |
| Note | A short hand-written file on one topic: each source as a link, the date read and one sentence in our words. | A quote store; a ranking. |
| Basis | How a statement in a Note is known: `vendor-doc`, `vendor-claim`, `measured`, `study` (section 4.3). | A confidence score. |
| Preference | A user's stated view ("Claude for long-form writing"), with its holder, its date and its words. | A Fact. It needs no source and is never shown as one. |
| Citation | A reference in a brief, an SOP or a report: a skill name (`loop-review-fix`), a Note and its read date, `pref:<id>`, or `models.dev@<date>`. | A pasted quote. |

### 3.3 Invariants

The numbers of the first draft are kept so reviews stay traceable.

| # | Status | Invariant |
|---|---|---|
| K1 | Changed | Every source in a Note or a skill has a URL, a publisher and the date read, and says in our own words what it supports. No quote from a vendor page is stored (Q7). |
| K2 | Changed | Every Note and every skill has a re-check date at most 90 days after its sources were read. |
| K3 | Kept | A leaderboard or benchmark statement names the board, its snapshot date, its method (who or what judges, on which tasks) and the position or score; it says "ranked 2nd on X, snapshot D, method M", never "best at X". A vendor's own result is labelled vendor-reported. |
| K4 | Kept | A Preference names its holder, its date and its words. It is never rendered, cited or counted as a Fact. It is shown as "your preference, *date*", beside this user's Scorecard numbers for that kind of task where they exist. |
| K5 | Deferred | Disagreements as aggregates. Until then a Note that holds sources pointing different ways says so and lists each. |
| K6 | Changed | Past its re-check date, a Note, a skill or the models.dev snapshot is stale: it is still shown, marked stale where it is cited, and a check prints a warning. Staleness never fails CI and never drops anything. |
| K7 | Changed | Shipped knowledge changes only through a reviewed pull request; git keeps its history. |
| K8 | Deferred | With the weekly re-check. |
| K9 | Kept | Knowledge grants nothing. It never admits a Connection the gate refuses, never changes a chain, and never excludes, fences or ranks a Candidate. ADR-0020's rules and Scorecard decide. |
| K10 | Kept | An SOP Step that acts outside the user's machines (publish, post, send, push to a shared branch, spend past its budget) comes after a Gate whose silence never approves. Each engine Step cites a skill, a Note or a Preference for its choice, or says `no evidence: default`; a deterministic `tool` Step cites nothing. Each Step has an output and a Check. Every loop has a round limit, and the SOP has at least one Stop rule. |
| K11 | Kept | An SOP run's report lists the Citations its Steps used, with their status (current or stale) at run time. |
| K12 | Kept | Shipped knowledge holds no per-user data: no Preferences, subscriptions, quotas, Outcomes or SOP instances. |
| K13 | Changed | A value the catalog holds (a terms revision, a price, a family, a class) is read by code only from the catalog. The models.dev snapshot is reference data and never overrides it. A test that the two agree is deferred (section 11). |
| K14 | New | An SOP names a Role and a model class with a family rule, never a model id. To run a given engine, the user puts it in the Role's chain. |
| K15 | New | Lineup, context, output limit and price come from the models.dev snapshot with its fetch date, not from hand-written Notes. A Note that needs such a value cites the snapshot. |
| K16 | New | Every shipped skill follows the Agent Skills specification: a `SKILL.md` whose `name` matches its directory and the format's character rules, a non-empty `description` of at most 1,024 characters, and `metadata` values that are strings [S1]. |

### 3.4 Events

For shipped files, git history is the record. The overlay records PreferenceRecorded and SopInstalled; an SOP run reports through its job (SopRunReported).

## 4. Agent Skills

### 4.1 Why skills

The specification at agentskills.io (read 2026-10-12) [S1] defines a skill as a directory holding at least a `SKILL.md`: YAML front matter, then Markdown instructions with no format restrictions. Required fields are `name` (1 to 64 characters, lowercase letters, digits and hyphens, no leading, trailing or doubled hyphen, equal to the directory name) and `description` (1 to 1,024 characters, what the skill does and when to use it). Optional: `license`, `compatibility` (up to 500 characters), `metadata` (a map of string keys to string values) and the experimental `allowed-tools`. Optional folders are `scripts/`, `references/` and `assets/`.

Agents load skills in three steps [S1], [S3]: the name and description of every skill at start (about 100 tokens each), the whole `SKILL.md` when the task matches (under 5,000 tokens and 500 lines recommended), and the referenced files only when needed. So six patterns cost a few hundred tokens until one is used.

The format's client list (read 2026-10-12) includes Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, Goose, OpenCode and others [S2]. A lane on any of these reads the same files without a new tool, which is the reason to adopt the format instead of the first draft's own card format.

### 4.2 Layout and names

```
knowledge/
├── README.md                       how to install the skills; ignored by skill scanners [S3]
├── skills/
│   ├── loop-one-shot/SKILL.md
│   ├── loop-plan-execute-verify/SKILL.md
│   ├── loop-review-fix/SKILL.md
│   ├── loop-scheduled/SKILL.md
│   ├── loop-fan-out-merge/SKILL.md
│   ├── loop-human-gate/SKILL.md
│   └── recurring-job/              PR 2
│       ├── SKILL.md
│       ├── scripts/sop-check.mjs (generated from knowledge/tools/sop-check), package.json
│       ├── assets/daily-blog-post.yaml, assets/sop.schema.json
│       └── references/preferences.md
└── notes/                          PR 2: the Notes the blog template cites
```

- **The `loop-` prefix.** Clients resolve two skills with one name by precedence, project over user [S3]. Common names such as `review-fix` are likely to exist in a user's own folder already; the prefix keeps Morndo's patterns from shadowing them or being shadowed.
- **Front matter.** `name`, `description`, `license`, and `metadata` with `morndo-kind` (`loop-pattern` or `procedure`), `morndo-sources-read` and `morndo-recheck` as quoted dates, since metadata values must be strings [S1]. Sources go in the body, as links with read dates (K1), because metadata can't hold a list.
- **Why not `.agents/skills/` in this repository.** That folder is the cross-client convention for a project's own skills [S3]; skills there would load for anyone working on Morndo's code. These skills are for the user's orchestrator and lanes, so they ship under `knowledge/` and are installed per user.
- **Install.** Claude Code reads personal skills from `~/.claude/skills/<name>/SKILL.md` and follows a symlinked skill folder [S4]; the cross-client user folder is `~/.agents/skills/` [S3]. Until Morndo's installer does it, `knowledge/README.md` gives the two link commands.

### 4.3 What counts as a source

Kept from the first draft; it applies to Notes and to the sources a skill lists.

| Basis | What it can establish | What it can't |
|---|---|---|
| `vendor-doc`: the vendor's own docs, pricing page, terms, model or system card, changelog | What a product is, does and costs, its limits, how it treats data. | That it is better than another vendor's product. |
| `vendor-claim`: the vendor's own benchmark results or claims of quality | That the vendor reports a result, with the setup the vendor states. Always shown as vendor-reported. | An independent ranking. |
| `measured`: an independent leaderboard or benchmark, with its snapshot date and method | A position or score on that board's tasks, by that board's method, on that date. | A general verdict, or anything about tasks the board doesn't test. |
| `study`: a paper with an arXiv id or a venue, and its version date | A finding under the study's setup, for the models it tested. | Anything about models or tasks the study didn't test. |

Not a source, at most a lead to the page behind it: a model-written summary (a deep-research report included), a search snippet, a social post, a marketing blog, press coverage. A board judged by one vendor's model names that judge, and never stands alone for that vendor's own models, since model judges favour their own outputs [S20], [S21].

## 5. Loop patterns (PR 1)

Each Pattern is one skill. Its body has the sections: when to use, when not, failure modes, guards (each naming the Morndo rule that enforces it, where one exists), and sources as links with read dates.

### 5.1 Failure modes

| Failure mode | What the sources saw | Sources |
|---|---|---|
| `looping` | Agents repeat steps (15.7% of failures in annotated multi-agent traces) or fail to notice the task is done (12.4%); long runs fall into loops they rarely recover from; an unattended loop runs forever. | [S11], [S12], [S13] |
| `gaming-tests` | Models change tests or scoring code instead of doing the task. METR found that telling o3 not to cheat had almost no effect, in one task (Optimize LLM Foundry, 20 runs per prompt). On impossible tasks GPT-5 cheated in 54% of cases; Claude models cheated mostly by editing tests, OpenAI models by special-casing; allowing retries raised cheating from 33% to 38%. | [S9], [S10] |
| `silent-partial` | Work declared done when it isn't: a later session sees progress and calls the job finished; premature termination and missing or wrong verification are frequent multi-agent failures. | [S11], [S14] |
| `drift` | The agent leaves the task as the run grows; recall falls as the context fills. | [S15], [S16] |
| `self-grading` | An agent asked to judge its own work tends to praise it; model judges favour their own outputs and show position and verbosity biases. | [S15], [S20], [S21] |
| `rubber-stamp` | People approve almost every prompt they see: 93% of permission prompts in one vendor's data, which it calls approval fatigue. | [S17] |
| `cost-blowup` | A multi-agent research system used about 15 times the tokens of a chat; a full harness run cost about 20 times a solo run. | [S18], [S15] |

### 5.2 The patterns

The skills are the source; this table mirrors each skill's failure modes, and the skill test (`knowledge/skills.test.ts`) fails when the two differ.

| Skill | Use when | Don't use when | Failure modes | Guards (Morndo rule) |
|---|---|---|---|---|
| `loop-one-shot` | The task fits one call and a check settles it; often a single well-prompted call is enough [S19]. | The work is larger than one context: an agent that tries to build it all in one go runs out of context mid-feature [S14]. | `silent-partial`, `gaming-tests`, `looping` | A Check fixed before the run, run by someone other than the worker (V1); the report says what wasn't done (E6); no retry inside the pattern, a second try is `loop-review-fix` with a round limit [S10]. |
| `loop-plan-execute-verify` | Multi-step work whose steps and checks can be named up front [S19]. | The plan would fix details nobody knows yet; planner errors cascade [S15]. | `silent-partial`, `drift`, `gaming-tests` | Done-means frozen before work (V1, V3); a feature list the worker can't rewrite, one feature at a time [S14]; judge the end state, not the process [S18]. |
| `loop-review-fix` | Clear criteria and a measurable gain from iterating [S19]; the task is beyond what the model does reliably alone [S15]. | The model already does the task reliably; the reviewer is then overhead [S15]. | `looping`, `self-grading`, `gaming-tests` | A reviewer of another family (the other-provider rule in docs/domain.md); tests hidden or read-only during the fix [S10]; a change to anything a test depends on refutes the Claim (V3); an explicit exit to a human, which cut GPT-5's cheating from 54% to 9% but worked much less well for Claude Opus 4.1 [S10], so it never replaces read-only tests; at most 2 or 3 rounds, then escalate. |
| `loop-scheduled` | Recurring work with a fresh input each run, with stopping conditions such as a turn cap [S19], [S22]. | No input changes between runs, or no metric tells a good week from a bad one. | `looping`, `drift`, `silent-partial`, `cost-blowup` | A turn cap with a controlled stop (the OpenAI Agents SDK default is 10 turns) [S23]; a missing input skips the run; N failed runs in a row pause it; a budget per run and per month (CN11); one job per run that ends once and reports once (J2, J3). |
| `loop-fan-out-merge` | Independent parts, or breadth-first research, where one vendor measured a 90.2% gain over a single agent [S18]. | Parts depend on each other; most coding work has fewer parallel parts than research [S18]; workers on one task overwrite each other [S13]. | `cost-blowup`, `silent-partial`, `duplicated or missing work`, `overwrites` | Each worker gets an objective, an output format and boundaries [S18]; a lock per part [S13]; the merge counts parts in and out; a concurrency cap per class (J5); one budget for the whole fan-out (CN11). |
| `loop-human-gate` | Actions that are sensitive, irreversible or costly, and after repeated failures [S22]. | Low-risk, reversible steps: gating them breeds `rubber-stamp` [S17]. | `rubber-stamp`, `late gate`, `stale approval` | Gate only what is outward or irreversible (F4, A2); silence and defaults never approve (A1); the check blocks before the side effect, since a parallel guardrail may run after tools already ran [S24]; the approval covers one action and the version shown (A3, E12). |

Two disagreements are kept as they are, in the skills too:
- **Does telling a model not to cheat help?** METR: almost no effect, for one model on one task [S9]. ImpossibleBench: a stricter prompt cut one model's cheating from 92% to 1% on one benchmark, much less on another [S10]. Both favour structural guards over wording.
- **Is a separate evaluator always worth it?** A verification step helped in one multi-agent study [S11]; one vendor found it overhead when the model already does the task reliably [S15]. `loop-review-fix` says when.

## 6. The recurring-job skill and SOPs (PR 2)

### 6.1 The skill

`knowledge/skills/recurring-job/` holds: `SKILL.md` (when a job is worth making recurring, how to design it from the pattern skills, where the approval sits, how to choose engines, how to report and measure, and the check's rules), `scripts/sop-check.mjs` (a bundle of `knowledge/tools/sop-check/` and the domain's rules; a copied skill needs Node and `npm install` there for its one package, yaml), `assets/sop.schema.json` (the SOP's shape as JSON Schema 2020-12), `assets/daily-blog-post.yaml` (the first template) and `references/preferences.md` (the user's preferences format). The notes it cites are in its `references/`, so a copied skill has them.

### 6.2 The SOP file

| Field | Holds | Rule |
|---|---|---|
| `sop`, `version` | Its id and version. A changed Step is a new version. | |
| `patterns` | The pattern skills it composes, by name. | Each names a shipped skill. |
| `trigger` | `schedule` (cron, time zone) or `event`. | Exactly one. |
| `inputs` | What a run needs and where it comes from. | A missing input is a Stop rule, not an error. |
| `steps[]` | `id`, `pattern`, then either `role` (an engine-layer Role) with `model: {class, family}` and `why` (Citations), or `tool` (a deterministic program); `effect` (`local`, `outward`, `irreversible`), `input`, `output`, `check`; for a loop `on_fail` (an earlier Step) and `max_rounds` (1 to 5). | K10, K14. |
| `gates[]` | `before` (a Step id), `who` (the principal), `shows`, `options` (with `approve`), `on_change` (an earlier Step) and `max_changes`, `on_silence: {after, then}` with `then` expire, drop or pause. | Silence never approves (K10). |
| `done` | The checks that make a run done. | At least one; never a model's opinion. |
| `stop` | Stop rules for the whole run, each `{when, then}`. | At least one. |
| `budget` | `per_run`, `per_month`, `on_exceed` (`stop` or `ask`). | Spending past it never goes on by itself; within the Connections' Budgets (ADR-0018). |
| `report` | Where the run reports (`to`) and what it `holds`. | Holds the Citations (K11). |
| `metrics` | Each with a `name`, where it comes `from` and how often (`every`). | At least one. |

`model` is a class and a family rule. It is advisory (K9): the Role's chain and auto routing decide what runs, and each run's report says when what ran didn't meet the class or the family rule. To run a given engine, the user puts it in the Role's chain (K14).

### 6.3 The SOP check

The rules are pure, in `packages/domain/src/knowledge.ts` (`checkSop`); `scripts/sop-check.mjs` reads the SOP, the skills installed beside it, the notes' re-check dates and the engine layer's roles, and prints one line per refusal with its rule and step. Exit 1 on a refusal, 2 on a bad call or anything unexpected. Its rules: `gate-before-outward`, `effect-declared` (every step says local, outward or irreversible; a word list only warns on a local step that sounds outward), `blanks-filled` (an instance, the default `kind`, keeps no `<blank>`; a template may), `silence-never-approves`, `gate-shape`, `round-limit`, `stop-required`, `budget-stop` (amounts in one currency, or 0, which allows only tool steps), `engine-why`, `why-resolves`, `step-check`, `no-model-id`, `model-class`, `role-known`, `step-kind`, `pattern-known`, `trigger` (in an instance, a five-field POSIX cron line and a known time zone), `done-required`, `report-citations`, `metrics-required`, `shape`. A test holds the JSON Schema's fields and enums equal to the domain's lists.

It warns, without failing, on each Citation of a note past its re-check date (K6).

### 6.4 Worked example: a daily blog post

`assets/daily-blog-post.yaml`. Steps, each with its Role and class:
- **research** (`research`, flagship, grounding off): sources with URL, publisher, date and the passage each claim rests on; checked by `link-check` and `quote-check`.
- **outline** (`plan`, everyday): each claim tied to a source.
- **draft** (`plan`, flagship): checked by `cite-check`; an instance may cite a Preference.
- **edit** (`review`, fast, another family than the draft).
- **search-pass** (`research`, everyday, grounding off): title, description, headings, internal links, structured data, from the site's own search data.
- **fact-check** (`validate`, fast, another family than the draft and the edit; `loop-review-fix`, 2 rounds back to the draft): every passage found in its source, every link answering.
- **publish** (tool `cms-publish`, `effect: outward`), after the principal's gate (approve, change once, drop; silence expires after 48 h).

Stop rules: no topic, budget spent, fact-check past its rounds, three dropped runs in a row, two hours. Metrics: approved first try, changes asked at the gate, cost per post, clicks and impressions at 28 days.

Why it looks as it does (the notes it cites, in the skill's `references/`, each hold links, read dates and a sentence per source):
- **Grounding off.** Gemini's API terms bar modifying grounded results or mixing them with other content without Google's written permission [S25]; a post is exactly that. Whether a grounded answer may serve as research notes is a question for counsel (Q10).
- **A cadence is a ceiling, not a quota.** Google's spam policy counts generating many pages with AI tools without adding value for users as scaled content abuse [S26]; its guidance asks whether content is produced with extensive automation on many topics [S27]. So no topic means no post, and three dropped runs pause the SOP.
- **The approval gate.** Google advises fact-checking and reviewing AI-generated content by hand before publishing [S28]; publishing is outward (K10, F4).
- **Two fix rounds at most.** Retries raised test-gaming in one study [S10].
- **No model is named.** The writer is a flagship-class model; the editor and the fact-checker are cheap models from other families than the writer, so a judge never grades its own family [S21]. A user with one vendor gets a warning at install, not a broken template.

### 6.5 The two claims in issue #30

Both stay Preferences in the user's file; the Notes say what the sources show.
- **"Claude writes best."** Claude models place in the top three on the three writing boards read on 2026-10-12, but the boards disagree on first place, all three test fiction or open prompts and none tests articles, and two are judged by a Claude model [S29], [S30], [S31]. The user's own first-try approvals on real posts are the evidence that can settle it for them (section 8).
- **"Gemini is best for SEO."** No credible public benchmark ranks models for SEO work. What is sourced is a capability (Gemini can ground on Google Search results) and a limit on reusing grounded output [S25]. Google's guidance is that AI use earns content no special ranking gain [S32].

## 7. Model facts from models.dev (PR 3)

**What it is.** models.dev is an open database of model specifications, prices and capabilities, kept as TOML files in its repository and served as JSON [S5]. Licence: MIT, read 2026-10-12 [S6]. On 2026-10-12 `https://models.dev/api.json` returned 226 providers and 8,474 provider-model entries in 5.4 MB, each with `limit` (context, output, sometimes input), `cost` per million tokens (input, output, cache read and write), release date and family [S7]. The repository had 30 commits on 2026-10-11 alone [S5]. `models.json` holds model-only facts and `catalog.json` both [S5].

**How Morndo uses it.**
- `npm run knowledge:models -- refresh` (`knowledge/tools/models-dev/`) fetches `api.json` and models.dev's licence once, each request within 60 seconds (then exit 2), and writes a trimmed snapshot dated with the machine's real date to `$XDG_CACHE_HOME/morndo-knowledge/models-dev/<date>.json` (`~/.cache/...` when it is unset), through a temporary file renamed over it, so a broken write leaves the cache as it was, and removes temporary files older than ten minutes, which a refresh that died left behind: per model its provider, id, name, family, context, output limit, input and output price per million tokens and release date, with the source URL, the fetch date and the licence text. The trimming is pure (`trimModelsDev` in `packages/domain/src/knowledge-facts.ts`). The repository ships no copy: a copy would add megabytes per refresh to a public history and change many times a day upstream. The tests use a made-up fixture in `api.json`'s shape and a fake fetch, never the network.
- `npm run knowledge:models -- show [provider[/model]]` prints the newest snapshot that reads with "models.dev, fetched *date*", and names each newer one it skipped. Older than 30 days, it is shown with a warning and still exits 0 (K6); dated after today (a wrong clock or a wrong file), it is shown with a warning too, never as fresh. Without a snapshot it says how to make one and fails nothing. `--today` is show's alone. An SOP's `models.dev@<date>` resolves against this directory when `sop-check --snapshots` is given it: the snapshot of that date must read, as show reads it, and say it was fetched that day.
- It is community data, not the vendor's page. Example, read 2026-10-12: models.dev gives GPT-6 Astra an input limit of 922,000 tokens [S7]; OpenAI's model page shows a 1,050,000-token context and 128,000 output tokens and no separate input limit [S8]. So any value that moves money or permissions stays in the catalog (K13), and a Note that relies on a limit says which source it used.
- It answers what a model is and costs, not what it is good at. Strength claims stay out of it (K15).

## 8. Preferences and our own results (PR 3)

The Preference file is the user's, in the overlay:

```yaml
preferences:
  - id: write-claude
    holder: principal
    on: "2026-10-11"
    said: Claude for long-form writing.
    tasks: [write]
```

Rendered: "Claude for long-form writing (your preference, 2026-10-11)", never as a fact (K4). Its shape is the recurring-job skill's `assets/preferences.schema.json`; `parsePreferences`, the authority, holds the same rules and that ids are unique, leaves a broken entry out with a refusal naming its place, and `renderPreference` shows it as its holder's. `sop-check --preferences` resolves an SOP's `pref:<id>` against the file. A shipped template never cites one (`sop-check` refuses it: `preference-in-template`), and no preferences file ships (K12).

**The Scorecard link.** A step's role group (its Role up to the first hyphen, as ADR-0020 pools them) and its model class select this user's Scorecard cells: `scorecardFor` returns them sorted by entry, never by a score (K9), and refuses a class that isn't `flagship`, `everyday` or `fast`. ADR-0020 is still a proposal (PR #18), so the cells come through this port; showing them beside a step or a preference waits for its Scorecard. That record, first-try approvals and changes asked per model, is what can turn a preference into evidence for this user.

## 9. Use

The orchestrator is whoever plans work for lanes: the manager lane today, and Morndo's own planner later.

1. **Pick the Patterns.** The agent CLI offers the pattern skills by description; the orchestrator loads the ones the job's shape names (one change, a recurring output, many independent parts, anything outward) and cites them by name in the brief.
2. **For a recurring job, load `recurring-job`,** start from a template, fill the Steps with Roles and model classes, and run `sop-check`.
3. **Look up what a model is and costs** in the models.dev snapshot, with its date; look up the user's Preferences and the Scorecard beside them.
4. **Ask before the first run.** A new SOP with an outward Step goes to the principal as an Ask: the Steps, the classes, the Citations, the Gates, the budget.

Citations: a skill by name, a Note with its read date, `pref:<id>`, `models.dev@<date>`. A stale one is cited as stale (K6). An SOP run's report lists them (K11).

## 10. Test plan

1. **Skills (PR 1).** Every `knowledge/skills/*/SKILL.md` parses as YAML front matter plus a body and meets the specification's rules: `name` pattern, length, no doubled hyphen, equal to its directory; `description` 1 to 1,024 characters; `compatibility` at most 500 if present; `metadata` values strings (K16). Each pattern skill has the sections when to use, when not, failure modes, guards, sources, and every source line has a URL and a read date (K1). A skill past its re-check date prints a warning and passes (K6). Negative controls: fixtures with a bad name, a name that differs from its directory, an empty description, a non-string metadata value, and a source without a date must each be refused.
2. **Loading (PR 1).** One skill loaded by an agent CLI from the install link, shown in its session output.
3. **SOP check (PR 2).** The blog template passes. Copies with the Gate removed, `on_silence` set to approve, `max_rounds` removed, no Stop rule, a Step without `check`, an engine Step without `why`, or a model id in a template each fail with the rule's name. A `tool` Step without `why` passes.
4. **Model facts (PR 3).** The loader reads the fixture; a snapshot older than 30 days is marked stale and still shown; a missing snapshot says so and fails nothing; no code path reads a gate value from the snapshot (K13).
5. **Preferences (PR 3).** A Preference renders with its holder and date and never in the place of a fact; a shipped file holding a Preference fails (K12).
6. **K9 and K13 (PR 3).** No source under `packages/*/src` or `apps/*/src` outside the knowledge modules names them, and none outside them names the model snapshot; each matcher is proven on a planted line. Until ADR-0020's replay exists in code, this stands in for replaying a route with and without the knowledge files: no routing or gate code can read them.

## 11. Build plan

Small stacked PRs:

1. **Pattern skills.** The six `knowledge/skills/loop-*/SKILL.md` from section 5, `knowledge/README.md` with the install links, and the skill test (section 10.1). Done: the test passes with its negative controls; one skill loaded in Claude Code from the link; every source re-read on the day of the PR.
2. **Recurring-job skill, `sop-check`, blog template.** `knowledge/skills/recurring-job/`, the check's pure rules in `packages/domain/src/knowledge.ts`, the Notes the template cites. Done: tests 10.3; Notes re-read on the day.
3. **models.dev snapshot, Preferences file, Scorecard link.** `knowledge/tools/models-dev/` (refresh and show), `packages/domain/src/knowledge-facts.ts` (trimming, freshness, preferences, `scorecardFor`), the preferences schema, and the rule `preference-in-template`. Done: tests 10.4 to 10.6. Showing Scorecard numbers waits for ADR-0020.

Later steps, each only when a need shows:
- **Disagreement and Proposal aggregates** (first draft K5, K7, K8). A pull request already is a proposal; a Note lists sources that disagree.
- **The weekly re-check** as an SOP: re-read sources past their date, draft changes, a person reviews. Until then the re-check dates warn.
- **The catalog link test** (first draft K13): catalog classes and prices pointing to their evidence, once ADR-0020's class field lands.
- **A Knowledge page** in the hub, as a read model over the same files.
- **Capability Notes per vendor** (strengths and weaknesses from vendor docs and boards), written to K1 and K3, if the Scorecard alone proves too thin for a cold start (Q3).

## 12. Open questions

Each has a recommended default; none blocks PR 1.

- **Q1. Where the files live.** Default: `knowledge/` at the root (section 4.2). Move beside the catalog only if the hub's packaging needs it.
- **Q3. A prior for the cold start.** Should anything in Knowledge rank a Candidate with no Outcomes yet? Default: no; ADR-0020's probation learns from this user's work.
- **Q4. Roles for writing work.** The engine layer has no `write` or `seo` Role. Default: the template uses existing Roles (`research` for the research and the search pass, `plan` for the outline and the draft, `review` for the edit, `validate` for the fact check). Add a Role only if a second recurring job needs one.
- **Q5. What counts as a source.** Default: section 4.3 as written.
- **Q7. Quotes in a public repository.** German law (§51 UrhG) allows a quote only to the extent its purpose justifies; whether a collection of quotes qualifies is a question for counsel. Default until answered: links, dates and our own words, no stored quotes.
- **Q9. Disclosure on published posts.** Default: the blog template leaves disclosure that models helped write the post as a blank each user fills, suggested on.
- **Q10. Grounded output in a publishing pipeline.** Whether a grounded answer may serve as research notes for a post is a question for counsel. Default: the blog template keeps grounding off.

Closed or dropped with the lean scope: Q2 (a page) and Q6 (the re-check's cadence) are later steps; Q8 (who keeps the shipped cards) and Q11 (a Gemini API preset for the template) fall away with the cards and with templates that name no model.

## 13. Sources (all read 2026-10-12)

- [S1] Agent Skills, Specification: directory layout, front matter fields and limits, progressive disclosure, `skills-ref` validator. https://agentskills.io/specification
- [S2] Agent Skills, Client showcase: products that load the format. https://agentskills.io/clients
- [S3] Agent Skills, How to add skills support to your agent: project and user scopes, the `.agents/skills/` convention, name collisions (project over user), files other than skill folders ignored. https://agentskills.io/client-implementation/adding-skills-support
- [S4] Claude Code docs, Skills: personal skills in `~/.claude/skills/<name>/SKILL.md`, project skills in `.claude/skills/`, symlinked skill folders. https://code.claude.com/docs/en/skills
- [S5] models.dev repository (served from `anomalyco/models.dev`; `sst/models.dev` redirects there): README with the `api.json`, `models.json` and `catalog.json` endpoints and the TOML data layout; commit history. https://github.com/anomalyco/models.dev
- [S6] models.dev, LICENSE: MIT. https://github.com/anomalyco/models.dev/blob/dev/LICENSE
- [S7] models.dev API: provider and model counts, `limit` and `cost` fields, the GPT-6 Astra entry. https://models.dev/api.json
- [S8] OpenAI, GPT-6 Astra model page: context window and maximum output. https://developers.openai.com/api/docs/models/gpt-6-astra
- [S9] METR, Recent Frontier Models Are Reward Hacking (2025-06-05): the prompt test on o3 in the Optimize LLM Foundry task, 20 runs per prompt. https://metr.org/blog/2025-06-05-recent-reward-hacking/
- [S10] ImpossibleBench: Measuring LLMs' Propensity of Exploiting Test Cases, arXiv:2510.20270, v1 2025-10-23: cheating rates, kinds of cheating per vendor, retries, hidden and read-only tests, the abort exit and its weaker effect on Claude Opus 4.1. https://arxiv.org/abs/2510.20270
- [S11] Why Do Multi-Agent LLM Systems Fail? (MAST), arXiv:2503.13657, v3 2025-10-26. https://arxiv.org/abs/2503.13657
- [S12] Vending-Bench: A Benchmark for Long-Term Coherence of Autonomous Agents, arXiv:2502.15840, 2025-02-20. https://arxiv.org/abs/2502.15840
- [S13] Anthropic Engineering, Building a C compiler with a team of parallel Claudes (2026-02-05). https://www.anthropic.com/engineering/building-c-compiler
- [S14] Anthropic Engineering, Effective harnesses for long-running agents (2025-11-26). https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- [S15] Anthropic Engineering, Harness design for long-running application development (2026-03-24). https://www.anthropic.com/engineering/harness-design-long-running-apps
- [S16] Anthropic Engineering, Effective context engineering for AI agents (2025-09-29). https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- [S17] Anthropic Engineering, How we built Claude Code auto mode (2026-03-25): the approval rate of permission prompts. https://www.anthropic.com/engineering/claude-code-auto-mode
- [S18] Anthropic Engineering, How we built our multi-agent research system (2025-06-13). https://www.anthropic.com/engineering/multi-agent-research-system
- [S19] Anthropic Engineering, Building effective agents (2024-12-19). https://www.anthropic.com/engineering/building-effective-agents
- [S20] Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena, arXiv:2306.05685, 2023. https://arxiv.org/abs/2306.05685
- [S21] LLM Evaluators Recognize and Favor Their Own Generations, arXiv:2404.13076, 2024. https://arxiv.org/abs/2404.13076
- [S22] OpenAI, A practical guide to building agents (PDF). https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf
- [S23] OpenAI Agents SDK, Running agents: `max_turns`, `MaxTurnsExceeded`. https://openai.github.io/openai-agents-python/running_agents/
- [S24] OpenAI Agents SDK, Guardrails: parallel and blocking execution. https://openai.github.io/openai-agents-python/guardrails/
- [S25] Google, Gemini API Additional Terms of Service: Grounded Results. https://ai.google.dev/gemini-api/terms
- [S26] Google Search Central, Spam policies: scaled content abuse. https://developers.google.com/search/docs/essentials/spam-policies
- [S27] Google Search Central, Creating helpful, reliable, people-first content. https://developers.google.com/search/docs/fundamentals/creating-helpful-content
- [S28] Google Search Central, Google Search's guidance on using generative AI content. https://developers.google.com/search/docs/fundamentals/using-gen-ai-content
- [S29] EQ-Bench, Longform Creative Writing: method and judge. https://eqbench.com/creative_writing_longform.html
- [S30] EQ-Bench, Creative Writing v3 and About: method, judge, no control for self-preference. https://eqbench.com/creative_writing.html, https://eqbench.com/about.html
- [S31] LMArena, Creative Writing leaderboard, snapshot 2026-10-08, human pairwise votes. https://arena.ai/leaderboard/chat/text/creative-writing
- [S32] Google Search Central Blog, Google Search's guidance about AI-generated content (2023-02-08). https://developers.google.com/search/blog/2023/02/google-search-and-ai-content
