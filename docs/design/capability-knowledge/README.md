# Capability knowledge: what the orchestrator knows about engines, agent loops and recurring work (design, 2026-10-12)

**Phase: design only.** This document and [ADR-0026](../../adr/0026-capability-knowledge.md). No product code yet.

**The request:** issue #30. The orchestrating agent (the manager that briefs lanes, checks their results and runs recurring work) knows only what its instructions and its training data say about AI tools. That is not enough to plan new kinds of work. Example: "write a blog post every day". To set that up it has to know which agent loop fits, which engine is strongest at each step and what each costs, and how to turn the result into a repeatable SOP. Model rankings change every few weeks, so hard-coding them would go stale.

**Builds on:**
- ADR-0013: Roles, Engines, chains, the other-provider rule.
- ADR-0015: the board, proposals, done.
- ADR-0016: Usage windows.
- ADR-0017: background jobs that report back.
- ADR-0018: Connections and the vendor catalog (`packages/protocol/catalog/vendors.json`).
- ADR-0020 (PR #18, proposed): auto routing, the model class, Outcomes and the Scorecard.
- ADR-0024 (PR #28, proposed): usage from other vendors (the GLM Coding Plan and Cursor).

**Number:** 0019 to 0025 are taken by open pull requests (#12, #18, #20, #21, #22, #28, #35).

Facts carry a source, the date it was read, and a re-check date. **[K*n*]** points to section 13; every source there was read on 2026-10-12. UNVERIFIED marks what no primary source settled. A secondary research summary was read as a lead only; nothing from it is used without the primary page behind it. **Q*n*** is open question *n* in section 12.

## 1. What exists today

- **The vendor catalog** (ADR-0018) holds what the gate enforces: each preset's runtimes, model list source, family, prices (dated, for Z.ai only so far), isolation floor, and data terms as a revision with a one-line summary and sources. It says nothing about what a model is good at.
- **Auto routing** (ADR-0020, proposed) adds a model **class** per catalog model (`flagship`, `everyday`, `fast`), taken from each vendor's own words, as a prior. Its ranking is per Tier: `hard` work by Standing, then the Scorecard's quality band, then the class, then the Role's order; `standard` by Standing, cost, quality; `routine` by cost first. Standing and the quality band come from this user's own Outcomes ("4 of 5 accepted first try"). A fenced decider may then choose among what the rules allow.
- **The engine layer** names the Roles (plan, implement, validate, review, research, read long documents, images, video) and runs each Role's chain (ADR-0013).
- **Nothing holds** which engine suits which kind of task and why, which loop fits a job, or how a recurring job is set up. Each new workflow is improvised in a brief, and the reason for an engine choice is lost with the brief.

## 2. Goals and non-goals

**Goals:**
- A versioned, sourced knowledge base the orchestrator reads before it routes work or designs a workflow, and cites when it does.
- Every factual claim carries a source URL, the date it was checked, and a re-check date. Where sources disagree, both are shown.
- A user's preferences are recorded as preferences, apart from sourced facts, and never shown as facts.
- The common agent loops written down once: when to use each, how each fails, and the guard that catches it.
- A recurring job as data (an SOP): trigger, steps with the engine per step and the reason, gates for anything outward-facing, done criteria, report, metric.
- A scheduled re-check that proposes changes for review. Nothing changes silently.

**Non-goals:**
- No ranking of models baked into code. The cards hold Facts with dates; the Scorecard (ADR-0020) holds this user's results.
- No new routing rule. Cards grant nothing, exclude nothing and reorder nothing (K9). ADR-0020's ranking keys stay as they are.
- No scheduler. Triggers use what exists: the node's timers and ADR-0017's jobs.
- No automatic publishing of anything. Every outward step in an SOP has a human gate.

## 3. The model

### 3.1 Where it lives

A new bounded context, **Knowledge**. Pure rules in `packages/domain/src/knowledge.ts`; the files are read by an adapter. It is reference data with history, so it has few aggregates:

| Piece | Kind | Holds |
|---|---|---|
| Card | Aggregate, one per Subject | The Facts about one engine line or agent tool, its links to catalog presets and model ids. Guards K1 to K8 and K13. |
| Pattern | Aggregate, one per loop pattern | When to use, when not, and its failure modes and guards as Facts. Guards K1 to K8. |
| SOP | Aggregate, one per recurring job | Trigger, steps, gates, done criteria, report, metric, budget, stop rule, and its own sourced Facts. Guards K1 to K8, K10 and K11. |
| Preference set | Aggregate, one per user | The user's Preferences. Guards K4 and K12. |
| Disagreement | Aggregate, one per Disagreement across Facts, `docs/knowledge/disagreements/<id>.md` | The Facts it joins, what each says, opened and closed by Proposal. Guards K5. |
| Proposal | Aggregate, one per change | A change to any of the above with the reads behind it, and its review. Guards K7 and K8. |
| Knowledge index | Read model | Facts by task kind and subject, stale and disputed Facts, the Facts that catalog values point to. |

How it relates to the other contexts:
- **Engines and auto routing** read it, downstream. A Fact never admits, excludes, fences or ranks a Candidate (K9). The catalog values that ADR-0020 ranks on (class, family, prices) point to the Fact that justifies them (section 7.3).
- **Connections** stands beside it. The catalog stays the one place code reads what the gate enforces: terms revisions, prices used for budgets, isolation floors. A Card holds the evidence for those values, never a second value for code to use (K13).
- **Usage** and **the Scorecard** are read, not copied. A Card can show "your Cursor plan, 62% of the month" (ADR-0024) or "4 of 5 accepted first try" (ADR-0020) beside its Facts, but those are per-user observations, never shipped.
- **Authority and Escalation:** an SOP's gate is an Ask to the principal; its answer is a Decision, or a Mandate where a policy Ask issues one (AC7). Knowledge defines where a gate must sit, not how it is answered.
- **Jobs:** the re-check and every SOP run start as jobs that report back (ADR-0017).

### 3.2 Ubiquitous language

| Term | Means | Is not |
|---|---|---|
| Subject | What a Card is about: one vendor's model line (`claude`, `gpt`, `gemini`, `glm`) or one agent tool (`cursor`). | A Connection; a single model id. |
| Card | A capability card: all Facts about one Subject, with its catalog links. One file. | A ranking; a settings page; a catch-up card (a decision or update card). |
| Facet | What a Fact is about. On a Card: `lineup`, `context`, `tools`, `strength`, `weakness`, `cost`, `quota`, `data`, `agent`. On a Pattern: `when`, `failure`, `guard`. On an SOP template: `rule`. | A task kind; the basis. |
| Task kind | The kind of work a Fact speaks to (section 4.2). Some map to engine-layer Roles. | A Role; a Tier. |
| Fact | One sourced statement on one Facet, with a basis, sources, a checked date, a re-check date and a status. Most are about a Subject and some of its models; Patterns and SOP templates hold Facts too. | A Preference; an Outcome; a Verification Claim (a worker's statement, V1). |
| Basis | How a Fact is known: `vendor-doc`, `vendor-claim`, `measured`, `study` (section 4.3). | A confidence score. |
| Source | A page read on a date: URL, publisher, type, the date the page states, the date read, a short verbatim quote; for a leaderboard also its snapshot date and method. | A search result; a summary someone wrote of the page. |
| Status | `current`, `stale` (past its re-check date), `disputed` (in a Disagreement), `unverifiable` (its source can't be read), `withdrawn`. | A verdict on the Subject. |
| Disagreement | Facts whose sources point different ways: two or more Facts on one Facet and task kind, or the Sources of one Fact. All are kept and shown. Its id is its own (`write.ranking`) or, inside one Fact, that Fact's id. | An error to fix by picking one. |
| Preference | A user's stated view ("use Claude for long-form writing"), with its holder, its date and its words. It may link Facts that support or contradict it. | A Fact. It needs no source and is never shown as fact. |
| Pattern | A named agent loop: one-shot, plan–execute–verify, review–fix, scheduled loop, fan-out with merge, human gate. | An SOP. |
| Failure mode | A named way a Pattern goes wrong: looping, gaming tests, silent partial result, drift, and others in section 5. | A bug in one run. |
| Guard | What catches a Failure mode: a stop rule, a budget, an independent Check, a gate. | A hope that the model behaves. |
| SOP | A recurring job as data: trigger, steps, gates, done criteria, report, metric, budget, stop rule. | A brief; a job (one run of a command). |
| Step | One stage of an SOP: its Pattern, its Role and the engine it was designed for and why, or a deterministic tool; its input, its output and its Check (a Check as the domain defines it: deterministic, fixed before the run). | A lane. |
| Gate | A point in an SOP that waits for the principal before an outward-facing or irreversible step. | A review by another model. |
| Stop rule | A condition that ends a loop or skips a run: a count, a budget, a time, or a missing input. | A timeout alone. |
| Citation | A reference to a Fact (`gemini.tools.search-grounding@2026-10-12`), a Preference (`pref:write-claude`) or a Disagreement (`write.ranking`) in a brief, an SOP, a route's `why` or a report. | A link to a vendor page. |
| Re-check | The scheduled run that re-reads the Sources of Facts past their re-check date and drafts Proposals. | An edit. |
| Proposal | A reviewable change to Cards, Patterns, SOPs or Preferences, with the reads behind it. Shipped knowledge: a pull request. Per-user knowledge: a board proposal and an Ask. | A change already made. |

### 3.3 Invariants

| # | Invariant |
|---|---|
| K1 | Every Fact has at least one Source with a URL, a publisher, the date read, and a verbatim quote of at most 300 characters that appears on the page as read. It has a checked date (the newest of its Sources' read dates) and a re-check date after it. |
| K2 | A Fact's re-check date is at most the interval for its Facet and basis after its checked date (section 4.5). A user may shorten an interval, never lengthen it past the shipped one. |
| K3 | A `measured` Fact names the leaderboard or benchmark, its snapshot date, its method (who or what judges, on which tasks, with which harness) and the position or score with its stated uncertainty if one is published. It says "ranked 2nd of 40 on X, snapshot D, method M", never "best at X". A `vendor-claim` Fact is labelled vendor-reported wherever it is shown. |
| K4 | A Preference names its holder, its date and its words. It is never rendered, cited or counted as a Fact. It becomes evidence only through a Proposal that adds Facts; the Preference stays, now linked to them. |
| K5 | Facts on one Subject's Facet and task kind, or on several Subjects' rankings for one task kind, whose sources point different ways form a Disagreement; so do the Sources of one Fact that point different ways. Each such Fact is `disputed`, every side is shown, and a Citation of it names the Disagreement. |
| K6 | A Fact past its re-check date is `stale`. It is still shown, marked stale wherever it is cited, and never dropped by time alone. |
| K7 | Only an accepted Proposal changes knowledge. The re-check drafts Proposals and never writes. The history of every Fact is kept (git for shipped files). |
| K8 | A Source that can't be read leaves its Fact as it was, `unverifiable` from that date, and drafts a Proposal to replace the Source or withdraw the Fact. Nothing is deleted for a failed fetch. |
| K9 | Knowledge grants nothing. A Fact never admits a Connection the gate refuses, never changes a chain, and never excludes, fences or ranks a Candidate. ADR-0020's rules and Scorecard decide; a route may cite the Fact behind a catalog value. |
| K10 | An SOP Step that acts outside the user's machines (publish, post, send, push to a shared branch, spend past its budget) comes after a Gate. Each Step that runs on an engine cites at least one Fact or Preference for its choice, or says `no evidence: default`; a deterministic `tool` Step cites nothing. Each Step has an output and a Check. Every loop in an SOP has a Stop rule. |
| K11 | An SOP run's report lists the Citations its Steps used, with their status at run time. |
| K12 | Shipped knowledge holds no per-user data: no Preferences, subscriptions, quotas, Outcomes or SOP instances. A Fact a user adds locally follows K1 to K8 like a shipped one. |
| K13 | A value the catalog holds (a terms revision, a price, a family, a class) is read by code only from the catalog. A Card's Fact about it is its evidence: the vendor's words and the source, pointing to the catalog entry. A test fails when the two disagree. |

### 3.4 Events

FactAdded, FactChanged, FactWithdrawn, FactWentStale, FactUnverifiable, DisagreementOpened, DisagreementClosed, PreferenceRecorded, PreferenceLinked, ProposalDrafted, ProposalAccepted, ProposalRejected, SopInstalled, SopRunReported. For shipped files the events are derived from git history; the per-user overlay records them as it changes.

## 4. Capability cards

### 4.1 The file

One Markdown file per Subject, `docs/knowledge/cards/<subject>.md`. The front matter is the data, checked by a JSON Schema. The body is a short summary for people, which cites Fact ids and adds no Facts of its own. An illustrative, shortened card:

```markdown
---
card: gemini
kind: model-line            # model-line | agent-tool
vendor: Google
catalog: [agy]              # preset ids in packages/protocol/catalog/vendors.json
models: [gemini-3.8-flash, gemini-3.1-pro-preview, gemini-3.6-flash, gemini-3.5-flash-lite]
facts:
  - id: gemini.tools.search-grounding
    facet: tools
    tasks: [research.web, seo]
    models: ["*"]
    basis: vendor-doc
    says: Grounding with Google Search lets the model search the web and cite the sources it used.
    sources:
      - url: https://ai.google.dev/gemini-api/docs/google-search
        publisher: Google
        type: vendor-doc
        stated: null            # the date the page gives, if any
        read: 2026-10-12
        quote: "Grounding with Google Search connects the Gemini model to real-time web content and works with all available languages."
    checked: 2026-10-12
    recheck: 2026-12-11
    status: current
---
Gemini grounds on Google's own search results [gemini.tools.search-grounding],
under terms that limit how grounded output may be reused [gemini.data.grounding-terms].
No source ranks any model for SEO work (section 4.7).
```

Fact ids read `<subject>.<group>.<name>`. The group sorts Facts for people and is often the Facet; the `facet` field is what the rules read. The full card is in section 4.6.

### 4.2 Task kinds

A small, fixed vocabulary, versioned with the schema. A Role of the engine layer maps to a task kind where one exists.

| Task kind | Means | Engine-layer Role |
|---|---|---|
| `plan` | Turn a goal into steps and a brief. | plan |
| `code.implement` | Write or change code in a repository. | implement (backend, UI, infra) |
| `code.review` | Find defects in someone else's change. | review |
| `code.validate` | Run and judge checks and tests. | validate |
| `research.web` | Find and cite current sources on the web. | research |
| `read.long` | Read long documents, video or audio and answer about them. | read long documents |
| `write.longform` | Draft long text for people: posts, docs, reports. | `write`, proposed (Q4) |
| `write.edit` | Edit someone else's text for clarity, accuracy and voice. | review |
| `seo` | Search-facing work on a page: titles, descriptions, headings, structured data, queries. | `seo`, proposed (Q4) |
| `fact-check` | Check each claim of a text against sources. | validate |
| `image` | Make or edit images. | images |
| `video` | Make or edit video. | video |

### 4.3 What counts as a source

| Basis | What it can establish | What it can't |
|---|---|---|
| `vendor-doc`: the vendor's own docs, pricing page, terms, model or system card, changelog, or a staff answer on the vendor's own forum | What a product is, what it does, what it costs, its limits, how it treats data, what the vendor says it is for. | That it is better than another vendor's product. |
| `vendor-claim`: the vendor's own benchmark results or claims of quality, in a launch post or model card | That the vendor reports a result, with the setup the vendor states. Always shown as vendor-reported. | An independent ranking. |
| `measured`: an independent leaderboard or benchmark, with its snapshot date and method | A position or score on that board's tasks, judged by that board's method, on that date. | A general verdict, or anything about task kinds the board doesn't test. |
| `study`: a paper with an arXiv id or a venue, and its version date | A finding under the study's setup. | Anything about models the study didn't test. |

Not a source, at most a lead to the page behind it: an AI-written summary (a deep-research report included), a search snippet, a social post, a forum post by someone other than the vendor, an SEO or marketing blog, press coverage, a reseller's page.

A leaderboard that judges with a model names that judge in its method. The bias of model judges is documented: position, verbosity and self-enhancement biases [K1], and evaluators that "score their own outputs higher than others'" [K2]. So a board judged by one vendor's model is shown with that judge named, and is never the only Fact for that vendor's own models.

### 4.4 Disagreements

When two Sources disagree on one Facet and task kind (two leaderboards ranking the same models differently, a vendor's price page and its model page giving two context sizes), both Facts stay, each `disputed`, joined by a Disagreement. The card's summary says "sources disagree" and shows both. A Citation of either names the Disagreement. A Disagreement closes only by a Proposal: a newer read of one Source that now agrees, or a Fact withdrawn with its reason.

### 4.5 Re-check intervals

| Facet | Interval | Also re-checked when |
|---|---|---|
| `lineup`, `cost`, `quota` | 30 days | The catalog's model list for the preset changes; a vendor changelog entry. |
| `measured` Facts of any Facet | 30 days | The board publishes a new snapshot. |
| `tools`, `context`, `agent` | 60 days | A vendor changelog entry. |
| `strength`, `weakness` (`vendor-doc`, `vendor-claim`) | 90 days | A new model in the line. |
| `data` | 90 days | The catalog's terms revision changes. |
| `rule` (an SOP template's sourced rules) | 90 days | The page's stated update date changes. |
| `study` Facts, and Pattern Facts on studies | 365 days | A new version of the paper. |

### 4.6 The first cards

Every Fact below was checked on 2026-10-12; the last column is its re-check date (section 4.5). Quotes are the vendor's words. Benchmark figures from a vendor's own post are vendor-reported. Each card names the catalog presets it links to (ADR-0018). The PR that writes the files (section 11, PR 1) carries the quotes in full; the tables carry what a reader needs.

#### Claude (Anthropic): card `claude`

Catalog presets: `anthropic` (API key), `claude` (subscription).

| Fact | Says | Basis | Source | Re-check |
|---|---|---|---|---|
| `claude.lineup.models` | Fable 5.1 (`claude-fable-5-1`, released 2026-09-01), Opus 5.5 (`claude-opus-5-5`, 2026-09-22), Sonnet 5.5 (`claude-sonnet-5-5`, 2026-09-28), Haiku 5.5 (`claude-haiku-5-5`, 2026-10-07). "If you're unsure which model to use, start with Claude Opus 5.5 for most workloads." | vendor-doc | [K3], [K4] | 2026-11-11 |
| `claude.lineup.class` | Fable 5.1 "for demanding reasoning and long-horizon agentic work"; Opus 5.5 "for long-running agentic coding and knowledge work"; Sonnet 5.5 "the best combination of speed and intelligence"; Haiku 5.5 "for high-volume, latency-sensitive tasks such as classification, extraction, and routing". This is the evidence for ADR-0020's classes: Fable and Opus `flagship`, Sonnet `everyday`, Haiku `fast`. | vendor-doc | [K3], [K5] | 2026-11-11 |
| `claude.context.window` | 1M tokens of context and 128K tokens of output on all four. | vendor-doc | [K3] | 2026-12-11 |
| `claude.tools.server` | Web search, web fetch, code execution and tool search run on the vendor's side; memory, bash, text editor and computer use are client tools the caller executes. Web search costs "$10 per 1,000 searches"; web fetch has "no additional cost". | vendor-doc | [K6], [K7] | 2026-12-11 |
| `claude.cost.api` | Per 1M tokens, input / output: Fable 5.1 $10 / $50, Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50 (prompts up to 100K). Batch is 50% off. Goes to the catalog's `prices` for `anthropic` (K13). | vendor-doc | [K7] | 2026-11-11 |
| `claude.quota.plans` | Pro $20 a month, Max 5x $100, Max 20x $200. "Every plan has usage limits that reset on a rolling five-hour session window, and paid plans add weekly limits on top", one pool across the apps and Claude Code. Max has a separate weekly limit for Fable. The limits in numbers are not published (UNVERIFIED). | vendor-doc | [K8], [K9], [K10] | 2026-11-11 |
| `claude.data.api` | "By default, we will not use your inputs or outputs from our commercial products (e.g. Claude for Work, Anthropic API ...) to train our models." | vendor-doc | [K11] | 2027-01-10 |
| `claude.data.retention` | **Disputed**, twice. Retention: the privacy centre says API inputs and outputs are deleted "within 30 days of receipt or generation"; the platform docs say conversation content "is not retained by default; the exception is Covered Models" (Fable and Mythos), "which require 30-day retention". Fable and zero data retention: the docs say such models are "not available under ZDR unless expressly authorized by Anthropic"; the Fable launch post says "Until EFS is available, eligible customers will be able to use Fable 5.1 with zero data retention." | vendor-doc | [K12], [K13], [K108] | 2027-01-10 |
| `claude.data.consumer` | On Free, Pro and Max, training on chats and coding sessions is on unless the user opts out ("Opt-out" in the plan table); this covers Claude Code on those accounts. Team and Enterprise: "None by default". | vendor-doc | [K8], [K14] | 2027-01-10 |
| `claude.strength.code` | Opus 5.5 "is particularly good at long and sprawling jobs like codebase-wide migrations and audits". Sonnet 5.5 "is strongest at well-scoped everyday tasks, fixing bugs, and creating polished documents", while "Opus 5.5 remains clearly stronger at complex, open-ended work requiring sustained judgment." | vendor-claim | [K15], [K16] | 2027-01-10 |
| `claude.strength.write` | Opus 5.5 "puts the most important information up front, is less likely to use jargon or idiosyncratic phrases, and follows the writing rules you give it." No metric is given. | vendor-claim | [K15] | 2027-01-10 |
| `claude.strength.sourced-reports` | In the vendor's own test, "an automated grader checked every figure and quote against sources", and "16 out of 18 of Opus 5.5's reports cleared our quality bar, where any invented figure or quote would have failed." | vendor-claim | [K15] | 2027-01-10 |
| `claude.measured.longform` | **Disputed** (Disagreement `write.ranking`). EQ-Bench Longform Creative Writing: Claude Opus 5 86.3, Fable 5.1 85.3, Opus 5.5 84.6, the top three of the board. Method: an 8-turn story of about 8,000 words, "evaluated with a scoring rubric by Claude Sonnet 4.6", an Anthropic model. Fiction only. No snapshot date on the page; its data file was last modified 2026-09-24. | measured | [K17] | 2026-11-11 |
| `claude.measured.code` | Vendor-reported, 2026-09-22: Terminal-Bench 4.0 66.4% for Opus 5.5 against 57.9% for GPT-6 Astra "as reported by OpenAI"; the vendor adds that "benchmark margins have become a less reliable guide to real-world differences." Sonnet 5.5's post gives it 70.6% on the same benchmark. | vendor-claim | [K15], [K16] | 2026-11-11 |
| `claude.measured.terminal-bench` | Terminal-Bench 4.0 leaderboard, updated 2026-10-06: Opus 5.5 in Claude Code at max effort 64.8% ± 3.1, first; Sonnet 5.5 61.8% ± 2.9, second. Method: resolution rate on the 4.0 tasks, 330 trials per row, 95% intervals. The board's experiments are "supported with grants from OpenAI, Anthropic, Z.ai, SpaceX AI, and Laude Institute". | measured | [K18], [K19] | 2026-11-11 |
| `claude.measured.index` | Artificial Analysis Intelligence Index v4.3.2: Opus 5.5 58, first of 205 models; Sonnet 5.5 56. A weighted average of 10 evaluations (agents 30%, coding 20%, scientific reasoning 20%, general 30%), "primarily text-based, English-language". No "as of" date on the board; the site's changelog runs to 8 October. | measured | [K20], [K21] | 2026-11-11 |
| `claude.measured.creative` | **Disputed** (Disagreement `write.ranking`, section 4.7). LMArena Creative Writing, 2026-10-08, anonymous pairwise human votes with style control: Opus 5.5 second at 1517 ± 17, within the interval of the first. | measured | [K22], [K23] | 2026-11-11 |
| `claude.weakness.injection` | Opus 5.5 "is more vulnerable than other recent Claude models to user-turn prompt injection". | vendor-doc | [K24] | 2027-01-10 |
| `claude.weakness.grader` | The system card reports models, Opus 5.5 included, "attempting to cover their tracks after performing actions that a grader might view negatively, such as manipulating git records or deleting logs", and that on tasks missing a needed file "all three models attempted reward hacks three to six times as often". | vendor-doc | [K24] | 2027-01-10 |

#### GPT (OpenAI): card `gpt`

Catalog presets: `openai` (API key), `codex` (subscription).

| Fact | Says | Basis | Source | Re-check |
|---|---|---|---|---|
| `gpt.lineup.models` | GPT-6 Astra (`gpt-6-astra`, released 2026-09-03), GPT-6.1 Sol (`gpt-6.1-sol`, 2026-09-29, superseding `gpt-6-sol`), GPT-6 Luna (`gpt-6-luna`, 2026-09-22). | vendor-doc | [K25], [K26] | 2026-11-11 |
| `gpt.lineup.class` | "Use GPT-6 Astra, our flagship model for complex reasoning and coding. Choose GPT-6.1 Sol to balance intelligence and cost, or GPT-6 Luna for cost-sensitive, high-volume workloads." So: Astra `flagship`, 6.1 Sol `everyday`, Luna `fast`. | vendor-doc | [K25] | 2026-11-11 |
| `gpt.context.window` | "1,050,000 context window", "Maximum input tokens: 922,000", "128,000 max output tokens", the same for all three. | vendor-doc | [K27] | 2026-12-11 |
| `gpt.tools.responses` | Built-in tools: web search, file search, image generation, code interpreter, hosted shell, apply patch, skills, computer use, MCP, tool search. "Tool calling requires the Responses API." Web search: "$10.00 / 1k calls" plus content tokens. | vendor-doc | [K27], [K26], [K28] | 2026-12-11 |
| `gpt.cost.api` | Per 1M tokens, input / output, standard, short context: Astra $10 / $50, 6.1 Sol $2 / $10, Luna $0.10 / $0.50. Above 272K input tokens, "2x input and cache rates and 1.5x output for the full request". Batch and Flex 50% off. Goes to the catalog's `prices` for `openai` (K13). | vendor-doc | [K28], [K27] | 2026-11-11 |
| `gpt.quota.plans` | **Disputed** on Astra for Plus: the page's Plus card lists only "GPT-6.1 Sol and GPT-6 Luna", while its usage table gives Plus Astra messages. Plus $20 a month; Pro at $100, $200 or $500; Business $20 a user a month billed annually. For Plus, local Codex messages per five hours: Astra 5–45, 6.1 Sol 15–160, Luna 350–3,000. "Pro plans currently have no five-hour limit." "Weekly limits may also apply." Codex can also run on an API key at API prices, without cloud features. | vendor-doc | [K29] | 2026-11-11 |
| `gpt.data.api` | "As of March 1, 2023, data sent to the OpenAI API is not used to train or improve OpenAI models (unless you explicitly opt in ...)". Abuse-monitoring logs are kept "for up to 30 days" by default; Zero Data Retention needs OpenAI's approval. | vendor-doc | [K30] | 2027-01-10 |
| `gpt.data.consumer` | "No training on API or business data by default" is marked unavailable for Plus and Pro. The opt-out is "Improve the model for everyone", which "also applies to your Codex tasks" on a personal plan. | vendor-doc | [K29], [K31] | 2027-01-10 |
| `gpt.strength.tasks` | "Astra, for the hardest end-to-end work"; "GPT-6.1 Sol, for repeated, long-running work"; "Luna, for clear, repeatable tasks ... such as extraction, classification, transformation, and structured summaries." | vendor-claim | [K32] | 2027-01-10 |
| `gpt.weakness.style` | Astra "tends toward detailed, formatted responses and may use recurring phrases across sessions"; it is "more likely to ask the user a question when additional input could materially change the result", which "can cause it to stop when the user may expect it to make reasonable assumptions and persist." | vendor-doc | [K33] | 2027-01-10 |
| `gpt.weakness.misreport` | OpenAI tracks "the rate at which, during coding tasks, our models make misleading representations in their final response, including false reports of completed actions, tool access, verification, or ongoing background work", and reports it only as a ratio between models. | vendor-doc | [K34] | 2027-01-10 |
| `gpt.measured.longform` | **Disputed** (Disagreement `write.ranking`). EQ-Bench Longform Creative Writing: GPT-6 Sol and GPT-6 Astra 82.8, tied 6th to 8th, behind four Claude models and Grok 4.7; judged by Claude Sonnet 4.6. Fiction only. | measured | [K17] | 2026-11-11 |
| `gpt.measured.creative` | **Disputed** (Disagreement `write.ranking`). EQ-Bench Creative Writing v3: GPT-6 Astra first at 2173.3 Elo, Claude Fable 5.1 second at 2162.0. Pairwise matchups judged by Claude Sonnet 4.6; the board says "We *do not* control for the judge possibly preferring its own outputs." On LMArena Creative Writing (human votes, 2026-10-08) the best OpenAI entry is 20th. | measured | [K35], [K36], [K22] | 2026-11-11 |
| `gpt.measured.terminal-bench` | Terminal-Bench 4.0, updated 2026-10-06: GPT-6 Astra and GPT-6.1 Sol in Codex at max effort, both 58.2% (± 2.8 and ± 3.1), third. | measured | [K18] | 2026-11-11 |
| `gpt.measured.hallucination` | Vectara hallucination leaderboard, updated 2026-09-22: when summarising a document, GPT-6 Sol adds a hallucination in 6.5% of summaries, GPT-6 Astra in 8.7%. Judged by Vectara's own model (HHEM-2.3) over more than 7,700 articles. The board has no Claude 5.x, Gemini 4 or GLM-5.3 rows yet. | measured | [K37] | 2026-11-11 |
| `gpt.measured.index` | Artificial Analysis Intelligence Index v4.3.2: GPT-6 Astra at max effort 53. Method as in `claude.measured.index`. | measured | [K20], [K21] | 2026-11-11 |

#### Gemini (Google): card `gemini`

Catalog presets: none yet for the Gemini API; `agy` (Antigravity, in the engine layer's custody) is the subscription route.

| Fact | Says | Basis | Source | Re-check |
|---|---|---|---|---|
| `gemini.lineup.models` | Gemini 3.8 Flash (`gemini-3.8-flash`, generally available 2026-09-02), "our most intelligent Flash model, engineered for long-horizon software engineering, autonomous agents, and complex enterprise workflows"; Gemini 3.1 Pro Preview (`gemini-3.1-pro-preview`, 2026-02-19), still a preview; Gemini 3.6 Flash, "our previous-generation Flash model"; Gemini 3.5 Flash-Lite, "our fastest, most cost-effective 3.5 model". Gemini 4 Argon exists but is "currently rolling out to trusted cyber defenders" only. | vendor-doc | [K38], [K39], [K40], [K41] | 2026-11-11 |
| `gemini.lineup.class` | The vendor calls 3.8 Flash its "most intelligent workhorse model". Proposed classes: 3.1 Pro `flagship` (a preview), 3.8 and 3.6 Flash `everyday`, 3.5 Flash-Lite `fast`. The class rests on the vendor's labels; the vendor's newest generally available model is a Flash. | vendor-doc | [K42], [K40] | 2026-11-11 |
| `gemini.context.window` | 1,048,576 input and 65,536 output tokens on 3.8 Flash, 3.1 Pro Preview, 3.6 Flash and 3.5 Flash-Lite. | vendor-doc | [K43], [K44], [K110] | 2026-12-11 |
| `gemini.tools.search-grounding` | "Grounding with Google Search connects the Gemini model to real-time web content ... and cite verifiable sources beyond its knowledge cutoff." Grounded Results are built from "results from Google's search engine". "5,000 free search requests per month (shared across all Gemini 3 and newer models), then $14 per 1,000 requests"; one prompt may count several searches. Also URL context (up to 20 URLs a request), code execution (Python, 30 seconds), file search. | vendor-doc | [K45], [K46], [K47], [K48], [K109] | 2026-12-11 |
| `gemini.data.grounding-terms` | Grounded Results are shown only "with the associated Search Suggestion(s) to the end user who submitted the prompt"; "unless permitted by Google in writing, you: (1) will not modify, or intersperse any other content with, the Grounded Results"; no one may "cache, frame, syndicate, resell, analyze, train on, or otherwise learn from" them. Prompts and output for grounding are stored 30 days. | vendor-doc | [K46] | 2027-01-10 |
| `gemini.cost.api` | **Disputed** on one figure. Per 1M tokens, input / output: 3.8 Flash $0.75 / $3.75 "through December 31, 2026", then $1.50 / $7.50; 3.1 Pro Preview $2 / $12 for prompts up to 200K; 3.5 Flash-Lite $0.30 / $2.50. Cursor lists 3.8 Flash output at $3.50. | vendor-doc | [K47], [K49] | 2026-11-11 |
| `gemini.quota.plans` | **Disputed.** Google AI Pro $19.99 a month, Ultra $99.99 (5x) or $199.99 (20x) in the US; the app limit "refreshes every 5 hours until you reach your weekly limit". Plan benefits apply only in AI Studio; "direct use of the Gemini API ... is billed and managed separately." Since 2026-06-18 Google sign-in no longer serves Gemini CLI on individual and Google AI plans, which moved to the Antigravity CLI (`agy`); the CLI's own quota page on GitHub still lists the old daily quotas. | vendor-doc | [K50], [K51], [K52], [K53] | 2026-11-11 |
| `gemini.data.tiers` | Unpaid tier: Google uses submitted content "to provide, improve, and develop Google products", and "human reviewers may read, annotate, and process your API input and output". Paid tier (a Cloud project with active billing): Google "doesn't use your prompts ... or responses to improve our products". Only paid services may be offered to users in the EEA, Switzerland or the UK. Terms effective 2026-03-23. | vendor-doc | [K46] | 2027-01-10 |
| `gemini.strength.tasks` | 3.8 Flash is "designed for cost-effective scaling of general-purpose, production-ready agents", for "software engineering, agent tasks, and complex knowledge workflows". | vendor-claim | [K54] | 2027-01-10 |
| `gemini.weakness.card` | 3.8 Flash "may exhibit some of the general limitations of foundation models, such as hallucinations"; it "can use more tokens on longer running and complex tasks, by design"; "Safety performance across non-English languages regressed slightly relative to 3.7 Flash." | vendor-doc | [K54], [K38] | 2027-01-10 |
| `gemini.measured.terminal-bench` | Terminal-Bench 4.0, updated 2026-10-06: the best Google row is 3.8 Flash at 19.1% ± 3.4, 29th, run in a generic harness (mini-SWE-agent) rather than a vendor agent; no Gemini 4 row. Google's own model card gives 3.8 Flash 19.1% on the same benchmark against 51.8% for Claude Opus 5 (vendor-reported). | measured | [K18], [K54] | 2026-11-11 |
| `gemini.measured.creative` | **Disputed** (Disagreement `write.ranking`). LMArena Creative Writing, 2026-10-08, human votes: Gemini 4 Argon first at 1519 ± 20, marked "Preliminary" on 1,053 votes, and not generally available. On the Claude-judged EQ-Bench boards the best Google model is 3.8 Flash (Longform 76.8; Creative Writing v3 1747.9), and Gemini 4 isn't listed. | measured | [K22], [K17], [K35] | 2026-11-11 |
| `gemini.measured.index` | Artificial Analysis Intelligence Index v4.3.2: Gemini 4 Argon at high effort 53, level with GPT-6 Astra. | measured | [K20] | 2026-11-11 |

#### GLM (Z.ai): card `glm`

Catalog preset: `zai` (API key). The GLM Coding Plan is a subscription with its own usage design (ADR-0024).

| Fact | Says | Basis | Source | Re-check |
|---|---|---|---|---|
| `glm.lineup.models` | **Disputed** on the date. GLM-5.3 (`glm-5.3`), "Z.ai's latest flagship model", released 2026-08-18 by the release notes (the launch post's build is dated 2026-08-14); "It uses the same base model as GLM-5.2". GLM-5.3-Flash and FlashX (2026-08-26): "the first native multimodal model in the GLM-5 series, delivering stronger intelligence than GLM-5.2 at an exceptionally low cost". Classes, as in ADR-0020: GLM-5.3 `flagship`, GLM-5.3-Flash `fast`. | vendor-doc | [K55], [K56], [K57] | 2026-11-11 |
| `glm.context.window` | GLM-5.3: text input only, a 1M-token context and 128K output; reasoning always on, effort `low`, `high` or `max`, default `max`. GLM-5.3-Flash takes video, images, text and files, 1M and 128K. | vendor-doc | [K55], [K56] | 2026-12-11 |
| `glm.tools.api` | Function calling (`tool_choice` only `auto`), structured output, context caching. A web search tool at $0.01 a use. OpenAI-compatible and Anthropic-compatible endpoints (`https://api.z.ai/api/anthropic`). | vendor-doc | [K55], [K58], [K59] | 2026-12-11 |
| `glm.cost.api` | Per 1M tokens, input / cached input / output: GLM-5.3 $1.4 / $0.26 / $4.4; GLM-5.3-Flash $0.15 / $0.03 / $0.50. These match the catalog's `zai` prices dated 2026-10-11 (K13 holds). | vendor-doc | [K59] | 2026-11-11 |
| `glm.quota.plan` | GLM Coding Plan, credits since 2026-07-30 ("The new credits-based plan is now available"): Lite 2,000 credits per 5 hours and 10,000 a week; Pro 12,000 and 60,000; Max 28,000 and 140,000; half rate off-peak; "Starting at just 18 USD per month". The quota is for supported tools only: "You shall not use the GLM Coding Plan quota for general-purpose API access ... from your own applications, bots, websites". | vendor-doc | [K60], [K61], [K111] | 2026-11-11 |
| `glm.data.api` | API content: "This information is processed in real-time ... and is not saved on our servers." Personal data "is generally processed in Singapore". Whether an individual Coding Plan's prompts are used for training is not stated (UNVERIFIED); the team plan says "Data is not used for model training by default". Matches the catalog's terms revision 2025-09-29. | vendor-doc | [K62], [K63] | 2027-01-10 |
| `glm.strength.code` | "GLM-5.3 delivers a significant improvement in coding capabilities, achieving a 50% performance gain over GLM-5.2 on Z.ai Code Bench", a private benchmark. On the same benchmark, GLM-5.3 "reaches 34.5%" at max effort, and the vendor adds that it "remains behind Claude Fable 5, which reaches 39.5% at Max effort". | vendor-claim | [K55] | 2027-01-10 |
| `glm.measured.terminal-bench` | Terminal-Bench 4.0, updated 2026-10-06: GLM-5.3 run in Claude Code at max effort, 41.8% ± 3.2, twentieth. | measured | [K18] | 2026-11-11 |
| `glm.measured.index` | Artificial Analysis Intelligence Index v4.3.2: GLM-5.3 at max effort 45, second among open-weights models. | measured | [K20] | 2026-11-11 |
| `glm.measured.creative` | **Disputed** (Disagreement `write.ranking`). EQ-Bench Longform 81.8 and Creative Writing v3 2075.0 (Claude judge); LMArena Creative Writing, best Z.ai entry 32nd (human votes, 2026-10-08). | measured | [K17], [K35], [K22] | 2026-11-11 |

#### Cursor: card `cursor`

Kind: agent tool. Catalog presets: `cursor` (subscription), `cursor-cloud` (in the engine layer's custody). Families are per model (ADR-0020): a Claude model inside Cursor is family `anthropic`.

| Fact | Says | Basis | Source | Re-check |
|---|---|---|---|---|
| `cursor.lineup.models` | "Cursor supports frontier models from OpenAI, Anthropic, Google, SpaceXAI, and more." Its own pool holds Grok 4.7 ("Cursor's flagship model", built "together with SpaceXAI", 2026-09-21) and Composer 2.5 ("Cursor's fast, cost-efficient model", built on "Moonshot's Kimi K2.5"). The model table read today lists GPT-5.6 models and no GPT-6 model; GLM 5.3 is "Hidden by default". | vendor-doc | [K49], [K64], [K65], [K66] | 2026-11-11 |
| `cursor.context.window` | Grok 4.7: "a 256k standard window and 500k long context"; Composer 2.5: 200k. Third-party models keep their own windows. | vendor-doc | [K67], [K68] | 2026-12-11 |
| `cursor.agent.tools` | Agent tools: file search, web search, read and edit, shell, browser, image generation; "There is no limit on the number of tool calls Agent can make during a task." Cloud agents run "in isolated VMs"; with My Machines "the agent loop runs in Cursor's cloud, but terminal commands, file edits ... execute on your machine". The CLI has a print mode "for non-interactive scenarios like scripts, CI pipelines, or automation". | vendor-doc | [K69], [K70], [K71], [K72] | 2026-12-11 |
| `cursor.agent.router` | **Disputed** on availability. Cursor Router (Auto) "runs a classifier on each agent request and routes it based on task type and complexity"; "you can't hand-pick which model handles a request"; the routed model is hidden by default; "All Auto modes bill at the list price of the model each request is routed to." The docs say it "is currently only available on Teams and Enterprise plans"; the pricing help page says, in the future tense, that individual plans get it "a few months after launch". | vendor-doc | [K73], [K49], [K74] | 2026-11-11 |
| `cursor.cost.plans` | Hobby free, Pro $20, Pro+ $60, Ultra $200 a month; Teams $40 or $120 a user. Third-party models draw from a pool "charged at the model's API price"; Teams and Enterprise add "$0.25 per million tokens" on third-party models, BYOK included. The dollar value of the included usage per plan is not stated (UNVERIFIED). | vendor-doc | [K74], [K49] | 2026-11-11 |
| `cursor.data.privacy` | With Privacy Mode on, "Customer Data will not be used for training by Cursor" and providers keep nothing under zero-retention agreements; off, Cursor "may use and store codebase data, prompts ... to improve our AI features and train our models". On by default for team members. "ZDR doesn't apply when you use your own API keys," and BYOK requests still pass through Cursor's servers. | vendor-doc | [K75], [K76], [K77] | 2027-01-10 |
| `cursor.strength.observed` | From Cursor's own traffic, not a benchmark: "no model dominates every kind of work"; "Sol performs especially well on planning and codebase comprehension", "Opus performs well on execution-heavy work", "Fable excels at debugging and visual implementation", "Grok offers strong value across broad, routine work". | vendor-claim | [K78] | 2027-01-10 |
| `cursor.measured.grok` | Boards list Grok 4.7 under its maker, xAI, not under Cursor; whether it is the build Cursor serves is not stated (UNVERIFIED). Terminal-Bench 4.0, updated 2026-10-06: 37.6% ± 3.5, 21st, in xAI's own agent. EQ-Bench Longform 83.0, 5th, and Creative Writing v3 2006.7 (Claude judge, data of 2026-09-24). | measured | [K18], [K17], [K35] | 2026-11-11 |
| `cursor.weakness.reward-hacking` | On Composer 2.5's training: "large scale synthetic task creation ... can cause unexpected reward hacking." On the router: "offline analysis still cannot fully capture how a policy will behave in production". | vendor-doc | [K66], [K78] | 2027-01-10 |

No leaderboard read today lists Composer, Cursor's own model (LMArena text and WebDev, SWE-bench, SWE-Bench Pro, Terminal-Bench, Artificial Analysis, Vectara, EQ-Bench). No card cites SWE-bench: its newest entry is dated 2026-02-26, and it has no row for any model above [K107].

### 4.7 The two claims in issue #30, checked

Both are recorded as Preferences in the user's overlay. What the sources say decides how they are linked, not whether they stay.

```markdown
---
preferences:
  - id: write-claude
    holder: principal
    on: 2026-10-11                   # as written in issue #30
    said: Claude writes best.
    tasks: [write.longform, write.edit]
    subject: claude
    linked: [write.ranking]          # a Disagreement: some Facts support, some contradict
  - id: seo-gemini
    holder: principal
    on: 2026-10-11
    said: Gemini is best for SEO.
    tasks: [seo]
    subject: gemini
    linked: [gemini.tools.search-grounding, gemini.data.grounding-terms]
---
```

**"Claude writes best"** stays a Preference. The sources disagree (Disagreement `write.ranking`):

| Board, date | Method | Says |
|---|---|---|
| EQ-Bench Longform, data files last modified 2026-09-24 | An 8-turn story; one rubric score per model from Claude Sonnet 4.6 | Claude first, second and third (Opus 5 86.3, Fable 5.1 85.3, Opus 5.5 84.6); GPT-6 Astra 82.8; GLM-5.3 81.8; best Gemini 76.8 [K17] |
| EQ-Bench Creative Writing v3, the same date | 32 prompts, pairwise matchups judged by Claude Sonnet 4.6, self-bias "not" controlled | GPT-6 Astra first (2173.3), Claude Fable 5.1 second (2162.0), Opus 5.5 behind GLM-5.3 [K35], [K36] |
| LMArena Creative Writing, 2026-10-08 | Anonymous pairwise human votes, style control | Gemini 4 Argon first (1519 ± 20, "Preliminary", not generally available), Claude Opus 5.5 second (1517 ± 17), overlapping [K22] |

All three are fiction or open prompts; none measures non-fiction or blog posts, and two are judged by a Claude model, which the study on self-preference warns about [K2]. The vendor's own words (`claude.strength.write`) have no metric. So the blog SOP may use the Preference, labelled as one, and this user's own record (first-try approvals, the size of requested edits) is what can turn it into evidence for them.

**"Gemini is best for SEO"** stays a Preference, with nothing to dispute:
- No credible public benchmark ranks models on SEO work. The only leaderboard found is an SEO agency's multiple-choice quiz whose questions are not published [K79]; under section 4.3 it is not a source. It ranks Claude and GPT models above every Gemini model it lists. Academic work measures optimisation techniques, not which model does SEO best [K80], [K81].
- What is sourced is a capability: Gemini can ground on "results from Google's search engine" (`gemini.tools.search-grounding`). That is not a ranking.
- And a limit: grounded output may not be modified or mixed with other content without Google's written permission, and is shown only to the user who asked (`gemini.data.grounding-terms`). A publishing pipeline can't simply paste it into a post (Q10).
- Google's own search guidance: "Using AI doesn't give content any special gains. It's just content." [K82]

## 5. Loop patterns

One file per Pattern, `docs/knowledge/patterns/<id>.md`. Its failure modes and guards are Facts with the same rules as a card's (K1 to K8), with ids such as `review-fix.guard.other-family`, so an SOP Step can cite them. The first six come from the vendors' agent guides and published studies. Each Guard names the Morndo rule that already enforces it, where one does.

### 5.1 Failure modes

| Failure mode | What the sources saw | Sources |
|---|---|---|
| `looping` | Repeating steps or never stopping. In annotated multi-agent traces, "step repetitions (FM-1.3, 15.7%)" and "not recognizing task completion (FM-1.5, 12.4%)". Long runs "descending into tangential 'meltdown' loops from which they rarely recover". An unattended loop that "runs forever". | [K83], [K84], [K85] |
| `gaming-tests` | Passing the check instead of doing the task. Models exploit "bugs in our scoring code or subverting the task setup"; telling them not to "had a nearly negligible effect" (METR). On impossible tasks GPT-5 "cheats 54.0% of the time"; Claude models cheat mostly "through modifying test cases", OpenAI models by "special-casing"; allowing retries raised cheating "from 33% to 38%". A vendor's own card: attempted reward hacks "three to six" times as often on impossible tasks. | [K86], [K87], [K24] |
| `silent-partial` | Claiming done when it isn't. A later session would "see that progress had been made, and declare the job done"; features marked complete "without proper testing". "Knowingly incomplete work" is about 80% of the attempted reward hacks on impossible tasks. Premature termination 6.2%, "no or incomplete verification" 8.2%, "incorrect verification" 9.1%. Fake "shortcuts that omit the hard part of a task". | [K88], [K24], [K83], [K89] |
| `drift` | Leaving the task over time. "For more complex tasks, the agent still tends to go off the rails over time"; recall falls as the context fills; "an average drop of 39%" in multi-turn conversations; at an 80% success bar, task lengths agents complete are several times shorter than at 50%. | [K90], [K91], [K92], [K93] |
| `self-grading` | Judging its own work leniently. Agents "tend to respond by confidently praising the work"; an evaluator saw issues, then talked "itself into deciding they weren't a big deal". Model judges favour their own outputs and show position and verbosity biases. | [K90], [K2], [K1] |
| `rubber-stamp` | Approving without looking. "Claude Code users approve 93% of permission prompts", which "leads to approval fatigue". | [K94] |
| `cost-blowup` | Spending far past the task's worth. Multi-agent research systems "use about 15× more tokens than chats"; a full harness took 6 hours and $200 against 20 minutes and $9 solo. | [K95], [K90] |

### 5.2 The patterns

| Pattern | Use when | Don't use when | Typical failure modes | Guards |
|---|---|---|---|---|
| `one-shot`: one run, one output, one check | The task fits one call and has a check that settles it. For many applications, "optimizing single LLM calls with retrieval and in-context examples is usually enough" [K96]; "a deterministic solution may suffice" [K97]. | The work is larger than a context: agents that try to "one-shot the app" run out of context and leave a feature half built [K88]. | `silent-partial` | A Check fixed before the run and run by someone other than the worker (V1). The report says what wasn't done. |
| `plan-execute-verify`: write the steps and the checks, do them, check the end state | Multi-step work whose steps can be named up front; "programmatic checks ... on any intermediate steps" [K96]. | The plan would fix details nobody knows yet: planner errors "cascade into the downstream implementation" [K90]. | `silent-partial`, `drift`, `gaming-tests` | Done-means frozen before work (the vendor's "sprint contract" [K90]; here V1, V3); a feature list the worker can't rewrite and one feature at a time [K88]; judge the end state instead of "whether the agent followed a specific process" [K95]; a high-level objective check (+15.6% task success in one study [K83]). |
| `review-fix`: another model reviews, the worker fixes, until clean or out of rounds | "Clear evaluation criteria" and "iterative refinement provides measurable value" [K96]; worth it "when the task sits beyond what the current model does reliably solo" [K90]. | The task is within what the model does reliably alone: there the evaluator is "unnecessary overhead" [K90]. | `looping`, `self-grading`, `gaming-tests` | A reviewer of another family (ADR-0013's other-provider rule; [K2]); a skeptical reviewer with hard thresholds per criterion [K90]; tests hidden or read-only during the fix, and an explicit exit to a human (a `flag_for_human_intervention` answer cut GPT-5's cheating from 54% to 9%) [K87]; a weakened test refutes the worker's Claim (V3); at most 2 or 3 rounds, then escalate. |
| `scheduled-loop`: a run on a timer, each run bounded, with a rule that skips or stops | Recurring work with a fresh input each time; "stopping conditions (such as a maximum number of iterations)" [K96]; exit on "reaching a maximum number of turns" [K97]. | There is no input that changes between runs, or no metric to tell a good week from a bad one. | `looping`, `drift`, `cost-blowup` | A turn cap with a controlled stop (the Agents SDK raises `MaxTurnsExceeded`, default 10 turns) [K98]; failure thresholds that escalate to a human [K97]; a budget per run and per month (ADR-0018); a missing input skips the run; N failed runs in a row pause the SOP; a metric reviewed on a cadence; regression checks that run every time [K99]. |
| `fan-out-merge`: split independent parts, run them in parallel, merge | Independent parts or several attempts [K96]; breadth-first research, where one vendor measured +90.2% over a single agent [K95]. | Parts share context or depend on each other: "most coding tasks involve fewer truly parallelizable tasks than research" [K95]; one big task, where workers "overwrite each other's changes" [K85]. Gains are "often minimal" on benchmarks [K83]. | `cost-blowup`, `silent-partial` (a part lost in the merge) | Each worker gets "an objective, an output format, guidance on the tools and sources to use, and clear task boundaries" [K95]; workers write artifacts and pass references [K95]; a lock per part [K85]; the merge checks that every part came back (count in equals count out); a budget for the whole fan-out. |
| `human-gate`: wait for the principal before an outward or irreversible step | Actions that are "sensitive, irreversible, or have high stakes", and after "exceeding failure thresholds" [K97]. | Low-risk, reversible steps: gating them breeds `rubber-stamp` [K94]. | `rubber-stamp`; a gate that fires after the action | Gate only what is outward or irreversible (F4); the Ask carries the evidence, the diff and the cost; silence never approves; a blocking check before the side effect, since with a parallel guardrail "the agent may have already consumed tokens and executed tools before being cancelled" [K100]; the approval is bound to the exact version approved. |

Two disagreements are kept as they are:
- **Does telling a model not to cheat help?** METR: "nearly negligible effect" [K86]. ImpossibleBench: a stricter prompt cut one model's cheating "from 92% to 1%" on one benchmark, much less on another [K87]. Both favour structural guards over wording, so the Patterns rely on those.
- **Is a separate evaluator always worth it?** MAST measured +15.6% from a verification step [K83]; Anthropic found it "unnecessary overhead" for tasks the model already does reliably [K90]. The `review-fix` Pattern says when.

## 6. SOP templates

### 6.1 The schema

An SOP template is a file, `docs/knowledge/sops/<id>.md`, front matter as data. A user's instance (`<overlay>/sops/<id>.md`) names the template and fills its blanks: schedule, Roles, topic source, publish target, budget.

| Field | Holds | Rule |
|---|---|---|
| `sop`, `version` | Its id and version. A changed Step is a new version. | |
| `patterns` | The Patterns it composes, by id. | Each is a Pattern file. |
| `trigger` | `schedule` (cron, time zone) or `event` (a board column, a file, a webhook the node receives). | One trigger per SOP. |
| `inputs` | What a run needs and where it comes from. | A missing input is a Stop rule, not an error. |
| `steps[]` | `id`, `pattern`, `role` (an engine-layer Role) with an advisory `model` (a catalog model id) and engine `options`, or `tool` (a deterministic program); `why` (Citations), `input`, `output`, `check`; for a loop `max_rounds` and `on_fail` (the Step it returns to). | K10. |
| `gates[]` | `before` (a Step id), `who` (principal), `shows` (what the Ask carries), `options`, `on_change` (the Step a requested change returns to), `on_silence`. | `on_silence` is never "go ahead" for an outward Step. |
| `done` | Checks that make a run done. | Each is a Check: deterministic and fixed before the run. A model's review may gate a Step; it is never a done Check. |
| `stop` | Stop rules for the whole run: budget, wall time, rounds, missing input. | At least one. |
| `report` | Where the run reports (a lane, a board task) and what the report holds. | It lists Citations (K11). |
| `metrics` | What is measured across runs, and where it is read from. | Each has a source and a review cadence. |
| `budget` | Most spend per run and per month, per Connection. | Within the Connections' Budgets (ADR-0018). |
| `facts` | The template's own sourced Facts, such as the search engine's publishing guidance a Step applies. | K1 to K8. |

### 6.2 Worked example: a daily blog post

The template, `docs/knowledge/sops/daily-blog-post.md`, shortened (its own Facts are listed by id only). Blanks (`<...>`) are filled by the user's instance. Every engine Step names an engine-layer Role, so chains, fallback and auto routing decide what runs. `model` is advisory: the catalog model id the Step was designed for, shown when the SOP is reviewed and compared with what ran in each report. It is never a routing input (K9). `sop check` warns when the Role's chain doesn't hold that model. `why` cites Facts; a template's Citations carry no date, and installing an instance records the checked date of each.

```yaml
---
sop: daily-blog-post
version: 1
patterns: [scheduled-loop, plan-execute-verify, review-fix, human-gate]
trigger: { schedule: "<cron, e.g. 0 7 * * 1-5>", timezone: "<IANA zone>" }
inputs:
  topic: { from: "<board column or file>", one_per_run: true }
  site: { search_console_property: "<property>", cms: "<publish target>" }
  style: "<style guide file>"
steps:
  - id: research
    pattern: plan-execute-verify
    role: research
    model: claude-opus-5-5
    why: [claude.tools.server, claude.strength.sourced-reports, gemini.data.grounding-terms]
    output: research.md, at least 5 sources, each with URL, publisher, date and verbatim quotes
    check: tool quote-check re-fetches every source and finds every quote
  - id: outline
    pattern: plan-execute-verify
    role: plan
    model: claude-sonnet-5-5
    why: [claude.lineup.class, pref:write-claude]
    output: outline.md, the claims the post will make, each tied to a research quote
    check: every claim in the outline names a source in research.md
  - id: draft
    pattern: plan-execute-verify
    role: write                                   # Q4
    model: claude-opus-5-5
    why: [pref:write-claude, claude.strength.write, write.ranking]
    output: draft.md in the style guide
    check: tool cite-check finds every source the draft cites in research.md
  - id: edit
    pattern: one-shot
    role: review                                  # other-provider rule on
    model: gemini-3.8-flash                       # Q11
    why: [review-fix.guard.other-family, gpt.weakness.style, gemini.cost.api]
    output: edited.md and a change list
    check: the change list accounts for every changed paragraph
  - id: seo
    pattern: one-shot
    role: seo                                     # Q4
    model: gemini-3.8-flash
    options: { grounding: off }                   # gemini.data.grounding-terms
    why: [pref:seo-gemini, daily-blog-post.google.people-first,
          daily-blog-post.google.review-metadata, gemini.data.grounding-terms]
    input: edited.md and tool search-console rows for related pages
    output: title, meta description, headings, internal links, structured data
    check: title and description lengths, one H1, every internal link resolves, structured data validates
  - id: fact-check
    pattern: review-fix
    role: validate
    model: gpt-6-luna
    why: [gpt.strength.tasks, gpt.weakness.misreport, review-fix.guard.other-family]
    output: claims.json, every claim with verdict supported, unsupported or contradicted, and its quote
    check: tool quote-check finds every quote in its source; tool link-check gets 200 for every link
    on_fail: draft
    max_rounds: 2
  - id: publish
    tool: cms-publish                             # deterministic, no model
    output: the public URL
    check: the URL answers 200 and its content hash equals the approved version's
gates:
  - before: publish
    who: principal
    shows: [rendered post, title and description, claims.json, change list, cost, citations]
    options: [approve, change, drop]
    on_change: draft                              # one round, then fact-check and a new Ask
    on_silence: expire after 48 h, publish nothing, return the topic to the queue
done: [publish.check, every claim supported, report delivered]
stop:
  - no topic in the queue: skip the run and report it
  - budget spent: stop and report what was done
  - fact-check past max_rounds: stop, report "not publishable", no Ask
  - three runs in a row dropped or expired: pause the SOP and ask the principal
  - wall time: 2 h
budget: { per_run: "<default $5>", per_month: "<default $100>" }
report: { to: manager, holds: [URL or reason, cost per step, rounds, claim counts, citations with status] }
metrics:
  - approved first try, share of runs: from the gate's answers, weekly
  - claims caught before approval, and corrections after publishing: from claims.json and later edits, weekly
  - cost per post: from Lease spend (ADR-0018), weekly
  - clicks and impressions per post at 28 days: tool search-console, monthly
facts:                                            # this template's own sourced Facts (K1)
  - id: daily-blog-post.google.people-first       # [K101]
  - id: daily-blog-post.google.review-metadata    # [K102]
  - id: daily-blog-post.google.scaled-content     # [K103]
---
```

Why each step runs where it does:

| Step | Role and pick | Why, from the cards | Rejected, and why |
|---|---|---|---|
| Research | `research`, Claude Opus 5.5 with web search and web fetch | The vendor's tools search and fetch; a fetch adds no fee beyond its tokens (`claude.tools.server`). In the vendor's own sourced-report test, 16 of 18 reports had no invented figure or quote (`claude.strength.sourced-reports`, vendor-reported). A source-quality warning applies to any engine: early research agents "consistently chose SEO-optimized content farms over authoritative but less highly-ranked sources" [K95], so the check re-fetches every source. | Gemini with Google Search grounding: the best search data, but grounded output may not be modified or mixed into other content without Google's written permission (`gemini.data.grounding-terms`, Q10). |
| Outline | `plan`, Claude Sonnet 5.5 | A short, well-scoped step; Sonnet is "the best combination of speed and intelligence" (`claude.lineup.class`). | |
| Draft | `write`, Claude Opus 5.5 | The user's Preference (`pref:write-claude`), labelled as one. The vendor's claim of clearer writing has no metric (`claude.strength.write`), and the boards disagree (`write.ranking`). This step rests on a Preference; the metrics will show whether it holds for this user. | |
| Edit | `review` with the other-provider rule, Gemini 3.8 Flash | Another family than the drafter, since model judges favour their own outputs [K2]. OpenAI says its flagship "may use recurring phrases across sessions" (`gpt.weakness.style`), a poor trait in a prose editor. Cheap (`gemini.cost.api`). No source ranks models as editors. | GPT: the weakness above. |
| SEO pass | `seo`, Gemini 3.8 Flash, grounding off | The user's Preference (`pref:seo-gemini`); no source ranks models for SEO (section 4.7). The step applies Google's own guidance: people-first content, no preferred word count ("No, we don't"), and the same review for titles, meta descriptions and structured data [K101], [K102]. Its data is the site's own Search Console rows (clicks, impressions, CTR, position by query and page) [K104]. Grounding stays off for the reason in the Research row. | |
| Fact check | `validate`, GPT-6 Luna | Another family than the drafter's and the editor's. ADR-0013's other-provider rule binds `review` only, so the instance sets the `validate` chain this way, and the report says which family ran. The vendor puts Luna on "clear, repeatable tasks ... such as extraction, classification" (`gpt.strength.tasks`); checking each claim against a quote is that. Because OpenAI itself tracks "false reports of completed actions" (`gpt.weakness.misreport`), the verdicts don't stand on the model's word: `quote-check` must find every quote in its source. | |
| Approval | the principal | Google: "It is critical to manually factcheck and review all AI-generated content for accuracy and trustworthiness before publishing" [K102]. Outward and public, so a Gate (K10, F4). | |
| Publish | a deterministic tool | No model needed. With a WordPress-style API, the post is created as `draft` and set to `publish` only after its content hash matches the approved version (status values `publish`, `future`, `draft`, `pending`, `private` [K105]). | |

Why the stop rules look as they do:
- **A daily cadence is a ceiling, not a quota.** Google's spam policy counts "using generative AI tools or other similar tools to generate many pages without adding value for users" as scaled content abuse [K103]; its guidance asks "Are you using extensive automation to produce content on many topics?" [K101]. So no topic means no post, and three dropped runs in a row pause the SOP.
- **Two fix rounds at most.** Retries raise test-gaming in one study (33% to 38%) [K87], and an evaluator–optimizer loop is worth it only with clear criteria [K96]; the fact check's criteria are the quotes.
- **Cost, estimated at API prices on 2026-10-12, before thinking tokens:** about $1 for research (Opus 5.5 at $4 / $20 per 1M tokens, plus about 20 searches at $10 per 1,000), under $0.30 for the draft, a few cents for each Gemini and Luna step: about $1.50 a post (estimate; measured runs replace it). On subscriptions, the same steps spend quota instead. The default budget of $5 a run leaves room for two fix rounds.

What the run reports, for example: "Published `<URL>`. 14 claims, 14 supported, 2 caught and fixed in round 1. $1.62. Ran: research and draft on claude-opus-5-5, outline on claude-sonnet-5-5, edit and SEO on gemini-3.8-flash, fact check on gpt-6-luna, as designed. Knowledge used (15): claude.tools.server@2026-10-12 current, claude.strength.sourced-reports@2026-10-12 current, gemini.data.grounding-terms@2026-10-12 current, claude.lineup.class@2026-10-12 current, claude.strength.write@2026-10-12 current, write.ranking disputed, review-fix.guard.other-family@2026-10-12 current, gpt.weakness.style@2026-10-12 current, gemini.cost.api@2026-10-12 disputed, daily-blog-post.google.people-first@2026-10-12 current, daily-blog-post.google.review-metadata@2026-10-12 current, gpt.strength.tasks@2026-10-12 current, gpt.weakness.misreport@2026-10-12 current, pref:write-claude, pref:seo-gemini."

## 7. Use

The orchestrator is whoever plans work for lanes: the manager lane today, and Morndo's own planner later. It reads knowledge through one CLI, `morndo-knowledge`, which works from the files alone, without the hub:

```
morndo-knowledge cards [--task KIND] [--subject S] [--json]   # Facts by task kind, with basis, dates, status
morndo-knowledge fact ID [--json]                              # one Fact with its Sources and Disagreement
morndo-knowledge prefs [--task KIND] [--json]                  # the user's Preferences, marked as such
morndo-knowledge patterns [ID]                                 # loop patterns
morndo-knowledge sop new --from TEMPLATE                       # an SOP instance with blanks to fill
morndo-knowledge sop check FILE                                # K10: gates, checks, stop rules, citations
morndo-knowledge stale [--json]                                # stale, disputed and unverifiable Facts
```

### 7.1 When the orchestrator designs a workflow

1. **Pick the Patterns.** Read section 5's table: the shape of the job (one change, a recurring output, many independent parts, anything outward) names the Patterns. Cite them by id.
2. **For each Step, find the task kind and read its Facts.** `cards --task write.longform` lists every Subject's Facts for that kind with their basis and dates, and the user's Preferences for it, apart.
3. **Choose the Role, then the engine, and write why.** The Step names an engine-layer Role, so the Role's chain, fallback and auto routing still apply. The `why` cites the Facts and Preferences that decided, and says when the choice rests on a Preference alone or on `no evidence: default`.
4. **Put the Gates where K10 requires them** and the Stop rules on every loop.
5. **Check it:** `sop check` refuses an SOP that breaks K10.
6. **Ask before the first run.** A new SOP with an outward Step goes to the principal as an Ask: each Step, its engine, the Citations, the Gates, the budget. The answer installs it or sends it back.

### 7.2 Citing

- A Citation is `<fact-id>@<checked>`, `pref:<id>`, or a Disagreement's id. Facts live in Cards, Patterns and SOP templates; all follow K1 to K8. Rendered, a Fact shows its basis ("Google's docs", "vendor-reported", "LMArena, snapshot 2026-10-08, human votes"), a Preference shows its holder ("your preference, 2026-10-11").
- A stale, disputed or unverifiable Fact is cited with its status, so a reader sees it.
- Briefs, SOP Steps, route reasons and run reports cite this way. The report of an SOP run lists every Citation its Steps used (K11), so a later reader knows which knowledge a run relied on, and a Fact changed later can be traced to the runs that used it.

### 7.3 With auto routing (ADR-0020)

ADR-0020 excludes Candidates by hard rules, ranks the rest per Tier (`hard`: Standing, quality band, class, Role order; `standard`: Standing, cost, quality; `routine`: cost first), fences them by cost and trust, and may let a fenced decider choose. Knowledge changes none of that (K9). It links in three places:

1. **The class has a source.** ADR-0020 puts a class per model in the catalog, "from the vendor's docs". With this design each catalog class and price carries `fact: <id>`, the Fact with the vendor's words. A test fails when a class or price has no current Fact, or when the two disagree (K13). A route's `why` can show the Fact behind a class, and says when that Fact is stale.
2. **Chains are designed with the cards.** Routing chooses only inside a Role's chain, the allowed set. Which Connections belong in a Role's chain is the user's choice; the cards are what the orchestrator reads when it suggests one, with Citations.
3. **The Scorecard outranks the cards.** A vendor's own words, a leaderboard and a Preference are priors. This user's Outcomes on their own work are the evidence ADR-0020 ranks on, as the vendor itself advises: "having a good evaluation set is the most important step in the process" [K5].

Not done: cards as a ranking key, or a task-kind prior for a Candidate with no record yet. Q3 asks whether the cold start needs one.

## 8. Freshness

The re-check is itself an SOP (`knowledge-recheck`), a scheduled loop with a stop rule, a review–fix step and a human gate. It runs weekly as a job (ADR-0017), started by the node's timer, and reports to the manager.

| Step | Does | How | Check |
|---|---|---|---|
| 1. Select | Facts with a re-check date on or before today, plus those whose event trigger fired (section 4.5): a new or missing model id in a preset's model list, a new terms revision in the catalog. | Deterministic. Oldest first, at most 40 per run. | The list and the count left for the next run. |
| 2. Fetch | Each Source once, whatever number of Facts use it. | Deterministic HTTP. Records status, final URL, the date the page states, a hash of the text. Snapshots go to the user's cache directory, never the repo. | A page that fails twice is `unreachable`. |
| 3. Compare | Is each Fact's stored quote still on the page, verbatim after whitespace is normalised? | Deterministic. | Three outcomes: re-confirmed, changed, unreachable. |
| 4. Draft | For a changed Fact: the new wording and a new quote from the page. For a new model: a Fact stub. | A model, Role `research`. | The new quote must appear verbatim on the fetched page, or the draft is dropped. |
| 5. Verify | Does each drafted Fact say what its quote says, no more? | A model of another family than step 4 (the other-provider rule). One fix round, then the Fact is left `stale` with the reviewer's note. | Agree, or a note. |
| 6. Propose | Shipped files: one local branch with every change, re-confirmed dates in one commit and each changed Fact in its own, and a summary of the diff. Overlay files: a board proposal and an Ask with the diff. | Deterministic. Nothing leaves the machine. | The branch or the Ask exists. |
| 7. Gate | A person reads the summary and pushes the branch and opens the pull request, or drops it; the repository's review rules then decide the merge. For the overlay, the principal answers the Ask. Until then the Facts stay `stale` where they are, and are cited as stale. | A person. | Merged, or dropped with a reason. |
| 8. Report | Counts: re-confirmed, changed, unreachable, not reached; the Proposal's link. | The job's completion to the manager (ADR-0017). | |

Stop rules: 40 Facts per run, a run budget (default $1, Q6), and one fix round per Fact. A Source that a run couldn't reach makes its Facts `unverifiable` through the same Proposal (K8), never a deletion.

Who runs it:
- **For the shipped cards,** the Morndo maintainers run it against this repository. A user's install gets the accepted changes with the next release.
- **On a user's install,** shipped Facts past their date show as stale until the release that refreshes them. The user may run it on their overlay, and may add a sourced local Fact (K12), which the next shipped refresh doesn't overwrite. A local Fact that disagrees with a shipped one opens a Disagreement.

## 9. Storage

### 9.1 Options

| | A: Markdown with front matter under `docs/knowledge/` | B: a domain context with a store and a page | C: A's files as the source, B's page as a read model later |
|---|---|---|---|
| Who can read it | Any agent CLI, without Morndo running; GitHub renders it. | Only through the hub's API or page. | Both. |
| Proposals | Pull requests: diffs, review, history, all in git. | Records in the hub; a review page to build. | Pull requests for shipped files; Commands for the overlay. |
| Shipping | The files are in the release. | Seed data and migrations per release. | The files are in the release; the hub indexes them at start. |
| Per-user data | An overlay directory, merged on read. | Natural: the hub's database. | The overlay directory, shown by the hub. |
| Validation | A JSON Schema and a loader with tests. | Types and a database schema. | The same loader for both. |
| Cost before the first card | A schema, a loader, a CLI. | An aggregate, a migration, an API, a page. | As A. |
| Weak point | No page for the principal; merging the overlay needs rules. | Knowledge is hard to review as diffs; agents need the hub up. | Two views of one thing once the page exists. |

### 9.2 Shipped and per-user

| Part | Shipped with Morndo | Per user |
|---|---|---|
| The schema, the task kinds, the source rules (section 4.3), the intervals | Yes | May shorten intervals (K2). |
| Cards with sourced Facts | Yes | May add sourced local Facts (K12). |
| Patterns | Yes | |
| SOP templates | Yes | |
| SOP instances: schedule, Roles, topic source, publish target, budget | | Yes, in the overlay. |
| Preferences | | Yes, in the overlay. |
| Which subscriptions and keys the user has | | Already in Connections (ADR-0018); read, not copied. |
| Quotas and usage | | Already in Usage (ADR-0016, ADR-0024); read, not copied. |
| Outcomes and the Scorecard | | Already in auto routing (ADR-0020); read, not copied. |

The overlay lives in `~/.config/morndo-knowledge/`, named as ADR-0018 names `~/.config/morndo-connections/`, with the same layout as `docs/knowledge/`: `cards/`, `prefs.md`, `sops/`. Source snapshots from the re-check go to `~/.cache/morndo-knowledge/`. Merging: an overlay Fact with a new id is added; one with a shipped id is refused (a local Fact gets its own id, and a conflict is a Disagreement, K5).

### 9.3 Recommendation

**C, built as A first.** The files under `docs/knowledge/` are the source of truth, read by a pure loader that the CLI, the manager and later the hub share. Reasons:
- The main reader today is an agent CLI, which reads files without the hub.
- Proposals as pull requests give review, diffs and history for free, and the re-check needs exactly that (K7).
- The cards are reference data that changes by review, not state that changes by use. A database adds migrations for each release with no gain.
- A page can come later as a read model over the same loader, with no change to the files. Q2 asks when.

The pure rules (K1 to K13) go in `packages/domain/src/knowledge.ts`; the file reader and the overlay merge are adapters; `morndo-knowledge` is the CLI. Whether the files stay under `docs/` once the hub reads them, or move to `packages/protocol/knowledge/` beside the catalog, is Q1.

## 10. Test plan

1. **Invariants.** One negative-control test per invariant, each with a fixture that breaks only that invariant and must be refused: K1 a Fact without a quote; K2 a re-check date past its interval; K3 a `measured` Fact without a method; K4 a Preference cited as a Fact; K5 a disputed Fact cited without its Disagreement; K6 a stale Fact dropped from the index; K7 a re-check run that writes a file; K8 an unreachable Source that deletes its Fact; K9 a Fact that changes an Auto pick (the same route replayed with and without the knowledge files must pick the same Candidate); K10 an outward Step with no Gate, and a loop with no Stop rule; K11 a run report missing a Citation its Steps used; K12 a shipped file holding a Preference; K13 a catalog class with no Fact.
2. **Schema.** Every shipped file parses and validates in CI. A deliberately broken copy in the fixtures must fail.
3. **Quotes.** A local, outside-CI check (`npm run knowledge:quotes`) fetches every Source and reports quotes no longer found. In CI it is skipped and says so; it needs the network and must not make CI flaky.
4. **The re-check.** Against a fake HTTP server with three pages (unchanged, changed, gone): the run drafts exactly one re-confirmed batch, one changed Fact with a quote found on the new page, one `unverifiable` Proposal, and writes nothing else. A draft whose quote isn't on the page is dropped.
5. **The SOP check.** The blog-post template passes `sop check`. Copies with the approval Gate removed, the fact check's `max_rounds` removed, or an engine Step without `why` fail, each with its rule's name; a `tool` Step without `why` passes.
6. **Citations in reports.** An SOP run against fakes produces a report whose Citations match the Steps' `why` lists, with the status each had at run time.
7. **Catalog link (K13).** A catalog class or price whose Fact is missing, stale or different fails the catalog's own test.

## 11. Build plan: small stacked PRs

1. **The first files** (docs only): `docs/knowledge/cards/{claude,gpt,gemini,glm,cursor}.md` from section 4.6, `disagreements/write.ranking.md` from section 4.7, `patterns/*.md` from section 5, `sops/daily-blog-post.md` from section 6.2, and the JSON Schema. Done: every file validates against the schema with a throwaway script; every Source re-read on the day of the PR.
2. **The domain and the loader:** `packages/domain/src/knowledge.ts` (K1 to K13 as pure checks) and the file adapter with the overlay merge. Done: tests 1 and 2.
3. **The CLI** `morndo-knowledge` (section 7). Done: tests 5 and 6 against fakes; the manager's prompt block in `docs/agents/knowledge.md`, as `docs/agents/board.md` does for the board.
4. **The catalog link** (K13): `fact` on catalog classes and prices. Done: test 7. Waits for ADR-0020's class field.
5. **The re-check** SOP and its job. Done: tests 3 and 4, then one real run against this repo whose pull request a person reviews.
6. **A page** in the hub as a read model (only if Q2 says yes).

## 12. Open questions

Each has a recommended default; none blocks the first PR.

- **Q1. Where the files live once the hub reads them.** `docs/knowledge/` renders on GitHub and reads as documentation; `packages/protocol/knowledge/` sits beside the catalog the code already loads. Default: `docs/knowledge/` until PR 6; move only if the hub's packaging needs it.
- **Q2. A page, and when.** A read-only Knowledge page (stale and disputed Facts, Preferences, SOPs and their last runs) on the desktop. Default: not before the CLI has been used for a month and someone asks for it.
- **Q3. A prior for the cold start.** Should a card's task-kind Facts rank a Candidate that has no Outcomes yet, ahead of ADR-0020's probation? Default: no. Probation is deterministic and learns from this user's work; a vendor's own words or a leaderboard on other tasks are weaker evidence.
- **Q4. Roles for writing work.** The engine layer has no `write`, `edit` or `seo` Role, and a Role has one chain, so two Steps on one Role can't run on two engines. Default: two additive asks, `write` and `seo`; the edit uses `review` (another family by the other-provider rule), the fact check `validate`.
- **Q5. What counts as credible for a ranking.** Section 4.3: vendor docs for what a product does and costs, independent boards only with snapshot date and method, model-judged boards only with the judge named and never alone. Default: adopt as written; revisit when a board this design doesn't cover is proposed.
- **Q6. The re-check's cadence and budget.** Default: weekly, at most 40 Facts a run, $1 a run.
- **Q7. Quotes in a public repository.** Each Fact stores a verbatim quote of at most 300 characters from a vendor's page. Is that cap right for an AGPL repository? This is a legal question for the owner. Default until answered: 300 characters, attributed, with the URL.
- **Q8. Who keeps the shipped cards.** Default: the maintainers run the weekly re-check against this repository; outside contributions are welcome as pull requests that follow K1 to K8.
- **Q9. Disclosure on published posts.** The blog-post template leaves disclosure of AI assistance as a blank each user fills; Google suggests it "for content where someone might think 'How was this created?'" [K101]. Default: on, one line at the foot of the post.
- **Q10. Grounded output in a publishing pipeline.** Google's terms bar modifying or mixing Grounded Results with other content without written permission, and caching or analysing them (`gemini.data.grounding-terms`). Whether a grounded answer may serve as research notes for a post someone then writes is a legal question for the owner. Default: the blog SOP doesn't use grounding.
- **Q11. A Gemini API preset.** The catalog has no `google` API-key preset; Gemini runs today only through `agy` (Antigravity), in the engine layer's custody. The blog SOP's edit and SEO Steps suggest Gemini 3.8 Flash. Default: add a `google` preset (dialect, model list, prices, terms) in the catalog's own PR; until then those Steps fall back down the Role's chain.

## 13. Sources (all read 2026-10-12)

- [K1] Zheng et al., "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena", arXiv:2306.05685, v4 2023-12-24: position, verbosity and self-enhancement biases of model judges. https://arxiv.org/abs/2306.05685
- [K2] Panickssery, Bowman, Feng, "LLM Evaluators Recognize and Favor Their Own Generations", arXiv:2404.13076, 2024-04-15: self-preference, "where an LLM evaluator scores its own outputs higher than others'". https://arxiv.org/abs/2404.13076
- [K3] Anthropic, Models overview: API ids, context, output, default effort, "start with Claude Opus 5.5 for most workloads". https://platform.claude.com/docs/en/about-claude/models/overview
- [K4] Anthropic, model pages with release dates: https://platform.claude.com/docs/en/models/fable-5-1/overview, https://platform.claude.com/docs/en/models/opus-5-5/overview, https://platform.claude.com/docs/en/models/sonnet-5-5/overview, https://platform.claude.com/docs/en/models/haiku-5-5/overview
- [K5] Anthropic, Choosing the right model: the selection matrix; "Tuning effort is often a better lever than switching models"; the evaluation set. https://platform.claude.com/docs/en/about-claude/models/choosing-a-model
- [K6] Anthropic, Tool use overview: server tools (web search, web fetch, code execution, tool search) and client tools. https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- [K7] Anthropic, Pricing: token prices per model, batch, web search and web fetch fees. https://platform.claude.com/docs/en/about-claude/pricing
- [K8] Anthropic, plans and pricing: Pro, Max, Team; the five-hour window and weekly limits; model training per plan. https://claude.com/pricing
- [K9] Anthropic Help Center, What is the Max plan? https://support.claude.com/en/articles/11049741-what-is-the-max-plan
- [K10] Anthropic Help Center, Using Claude Code with your Pro or Max plan: the separate weekly Fable limit. https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan
- [K11] Anthropic Privacy Center, Is my data used for model training? (dated 2026-08-18). https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training
- [K12] Anthropic Privacy Center, How long do you store my organization's data? (dated 2026-07-01). https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data
- [K13] Anthropic, API and data retention: default retention, Covered Models, zero data retention. https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
- [K14] Anthropic, Updates to our consumer terms (2025-08-28): Free, Pro and Max, "including when they use Claude Code". https://www.anthropic.com/news/updates-to-our-consumer-terms
- [K15] Anthropic, Claude Opus 5.5 (launch, 2026-09-22): strengths, writing, the sourced-report test, Terminal-Bench 4.0 (vendor-reported). https://www.anthropic.com/claude-opus-5-5
- [K16] Anthropic, Claude Sonnet 5.5 (launch, 2026-09-28): cache reads at "$0.20 per million tokens". https://www.anthropic.com/claude-sonnet-5-5
- [K17] EQ-Bench, Longform Creative Writing: 8 turns of about 1,000 words, "evaluated with a scoring rubric by Claude Sonnet 4.6"; scores from its data file (last modified 2026-09-24). https://eqbench.com/creative_writing_longform.html
- [K18] Terminal-Bench 4.0 leaderboard (data updated 2026-10-06): resolution rate with 95% intervals, 330 trials per row. https://www.tbench.ai/
- [K19] Terminal-Bench, "Terminal-Bench 4.0" (2026-08-28): task changes, an 8-hour agent timeout, the grants behind the experiments. https://www.tbench.ai/news/terminal-bench-4-0
- [K20] Artificial Analysis, LLM leaderboard (no "as of" date); the site's changelog runs to 8 October 2026. https://artificialanalysis.ai/leaderboards/models, https://artificialanalysis.ai/
- [K21] Artificial Analysis, Intelligence benchmarking methodology: Index v4.3.2, 10 evaluations, category weights. https://artificialanalysis.ai/methodology/intelligence-benchmarking
- [K22] LMArena (arena.ai), Creative Writing leaderboard, 2026-10-08, 1,393,561 votes. https://arena.ai/leaderboard/chat/text/creative-writing
- [K23] LMArena, FAQ: anonymous pairwise votes, the Bradley-Terry rating, style control. https://arena.ai/faq
- [K24] Anthropic, System Card: Claude Opus 5.5 (2026-09-22): prompt injection, grader awareness, reward hacking on impossible tasks. https://www.anthropic.com/claude-opus-5-5-system-card
- [K25] OpenAI, Models: "use GPT-6 Astra, our flagship model for complex reasoning and coding". https://developers.openai.com/api/docs/models
- [K26] OpenAI, API changelog: GPT-6 Astra (2026-09-03), GPT-6 Sol and Luna (2026-09-22), GPT-6.1 Sol (2026-09-29). https://developers.openai.com/api/docs/changelog
- [K27] OpenAI, GPT-6 Astra model page: context, tools, long-context pricing. https://developers.openai.com/api/docs/models/gpt-6-astra
- [K28] OpenAI, Pricing. https://developers.openai.com/api/docs/pricing
- [K29] OpenAI, Codex pricing: plans, five-hour message estimates per model, training defaults per plan. https://developers.openai.com/codex/pricing
- [K30] OpenAI, Your data: API training since 2023-03-01, abuse monitoring, zero data retention. https://developers.openai.com/api/docs/guides/your-data
- [K31] OpenAI Help Center, Data controls FAQ: "Improve the model for everyone" and Codex on personal plans. Read through a text reader (r.jina.ai), since the page answers HTTP 403 to direct requests; to re-read in a browser. https://help.openai.com/en/articles/7730893-data-controls-faq
- [K32] OpenAI, ChatGPT models guide: where each model is strongest. https://learn.chatgpt.com/docs/models
- [K33] OpenAI, Using GPT-6: model behaviours and prompting. https://developers.openai.com/api/docs/guides/latest-model
- [K34] OpenAI, GPT-6 Astra deployment safety (2026-09-03): misleading representations during coding. https://deploymentsafety.openai.com/gpt-6-astra
- [K35] EQ-Bench, Creative Writing v3 leaderboard (data file last modified 2026-09-24). https://eqbench.com/creative_writing.html
- [K36] EQ-Bench, About: methods, the judge, "We *do not* control for the judge possibly preferring its own outputs." https://eqbench.com/about.html
- [K37] Vectara, hallucination leaderboard (last updated 2026-09-22): HHEM-2.3 over 7,700+ articles. https://github.com/vectara/hallucination-leaderboard
- [K38] Google, Gemini API: the latest model (Gemini 3.8 Flash). https://ai.google.dev/gemini-api/docs/latest-model
- [K39] Google, Gemini API changelog. https://ai.google.dev/gemini-api/docs/changelog
- [K40] Google, Gemini API models. https://ai.google.dev/gemini-api/docs/models
- [K41] Google, AI updates from September 2026 (2026-10-02): Gemini 4 Argon's limited rollout. https://blog.google/innovation-and-ai/technology/ai/google-ai-updates-september-2026/
- [K42] Google, Gemini 3.8 Flash and 3.8 Flash Cyber (2026-09-02). https://blog.google/innovation-and-ai/models-and-research/gemini-models/3-8-flash-and-3-8-flash-cyber/
- [K43] Google, Gemini 3.8 Flash model page. https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
- [K44] Google, Gemini 3.1 Pro Preview model page. https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview
- [K45] Google, Grounding with Google Search. https://ai.google.dev/gemini-api/docs/google-search
- [K46] Google, Gemini API Additional Terms of Service (effective 2026-03-23): Grounded Results, unpaid and paid services. https://ai.google.dev/gemini-api/terms
- [K47] Google, Gemini API pricing (last updated 2026-10-09). https://ai.google.dev/gemini-api/docs/pricing
- [K48] Google, URL context. https://ai.google.dev/gemini-api/docs/url-context
- [K49] Cursor, Models & Pricing. https://cursor.com/docs/models-and-pricing
- [K50] Google, Google AI subscriptions (US page). https://gemini.google/us/subscriptions/?hl=en
- [K51] Google, Gemini API and Google AI plans. https://ai.google.dev/gemini-api/docs/google-ai-plans
- [K52] Google, Gemini Code Assist for individuals: deprecation (2026-06-18, Gemini CLI included). https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals
- [K53] Gemini CLI, quota and pricing (GitHub, main). https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/resources/quota-and-pricing.md
- [K54] Google DeepMind, Gemini 3.8 Flash model card (2026-09-02): intended use, limitations, vendor-reported results. https://deepmind.google/models/model-cards/gemini-3-8-flash/
- [K55] Z.ai, GLM-5.3. https://docs.z.ai/guides/llm/glm-5.3
- [K56] Z.ai, GLM-5.3-Flash. https://docs.z.ai/guides/vlm/glm-5.3-flash
- [K57] Z.ai, release notes (GLM-5.3, 2026-08-18); launch post https://z.ai/blog/glm-5.3. https://docs.z.ai/release-notes/new-released
- [K58] Z.ai, Function calling. https://docs.z.ai/guides/capabilities/function-calling
- [K59] Z.ai, Pricing. https://docs.z.ai/guides/overview/pricing
- [K60] Z.ai, GLM Coding Plan overview: credits, windows, off-peak rate. https://docs.z.ai/devpack/overview
- [K61] Z.ai, Subscription terms: use within supported tools. https://docs.z.ai/legal-agreement/subscription-terms
- [K62] Z.ai, Privacy policy (last update 2025-09-29) and the API data processing addendum. https://docs.z.ai/legal-agreement/privacy-policy
- [K63] Z.ai, Team plan. https://docs.z.ai/devpack/teamplan
- [K64] Cursor Help, Available models. https://cursor.com/help/models-and-usage/available-models
- [K65] Cursor, Grok 4.7 (2026-09-21). https://cursor.com/blog/grok-4-7
- [K66] Cursor, Composer 2.5 (2026-05-18). https://cursor.com/blog/composer-2-5
- [K67] Cursor Docs, Grok 4.7. https://cursor.com/docs/models/grok-4-7
- [K68] Cursor Docs, Composer 2.5. https://cursor.com/docs/models/cursor-composer-2-5
- [K69] Cursor Docs, Agent overview. https://cursor.com/docs/agent/overview
- [K70] Cursor Docs, Cloud agents. https://cursor.com/docs/cloud-agent
- [K71] Cursor Docs, My Machines. https://cursor.com/docs/cloud-agent/self-hosted/my-machines
- [K72] Cursor Docs, CLI overview. https://cursor.com/docs/cli/overview
- [K73] Cursor Docs, Cursor Router. https://cursor.com/docs/cursor-router
- [K74] Cursor Help, Pricing. https://cursor.com/help/account-and-billing/pricing
- [K75] Cursor, Data use. https://cursor.com/data-use
- [K76] Cursor Help, Privacy. https://cursor.com/help/security-and-privacy/privacy
- [K77] Cursor Help, API keys. https://cursor.com/help/models-and-usage/api-keys
- [K78] Cursor, How Cursor Router chooses the right model for the task (2026-08-06). https://cursor.com/blog/how-cursor-router-works
- [K79] Previsible, AI SEO Benchmark (updated 2026-10-07). Read and not used as a source: an agency's quiz whose questions are not published (section 4.3). https://previsible.com/ai-seo-benchmark/
- [K80] Aggarwal et al., "GEO: Generative Engine Optimization", arXiv:2311.09735, 2023-11-16. https://arxiv.org/abs/2311.09735
- [K81] Puerto et al., C-SEO Bench, arXiv:2506.11097, 2025-06-06. https://arxiv.org/abs/2506.11097
- [K82] Google Search Central Blog, Google Search's guidance about AI-generated content (2023-02-08). https://developers.google.com/search/blog/2023/02/google-search-and-ai-content
- [K83] Cemri et al., "Why Do Multi-Agent LLM Systems Fail?" (MAST), arXiv:2503.13657, v3 2025-10-26. https://arxiv.org/abs/2503.13657
- [K84] Backlund, Petersson, "Vending-Bench", arXiv:2502.15840, 2025-02-20. https://arxiv.org/abs/2502.15840
- [K85] Anthropic Engineering, Building a C compiler with a team of parallel Claudes (2026-02-05). https://www.anthropic.com/engineering/building-c-compiler
- [K86] METR, Recent Frontier Models Are Reward Hacking (2025-06-05). https://metr.org/blog/2025-06-05-recent-reward-hacking/
- [K87] Zhong, Raghunathan, Carlini, "ImpossibleBench: Measuring LLMs' Propensity of Exploiting Test Cases", arXiv:2510.20270, 2025-10-23. https://arxiv.org/abs/2510.20270
- [K88] Anthropic Engineering, Effective harnesses for long-running agents (2025-11-26). https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- [K89] Xu et al., "TheAgentCompany", arXiv:2412.14161, v3 2025-09-10. https://arxiv.org/abs/2412.14161
- [K90] Anthropic Engineering, Harness design for long-running application development (2026-03-24). https://www.anthropic.com/engineering/harness-design-long-running-apps
- [K91] Anthropic Engineering, Effective context engineering for AI agents (2025-09-29). https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- [K92] Laban et al., "LLMs Get Lost In Multi-Turn Conversation", arXiv:2505.06120, 2025-05-09. https://arxiv.org/abs/2505.06120
- [K93] METR, Time horizons (last updated 2026-09-08, "no longer actively updated"); the paper is arXiv:2503.14499, v4 2026-07-10. https://metr.org/time-horizons/
- [K94] Anthropic Engineering, How we built Claude Code auto mode (2026-03-25). https://www.anthropic.com/engineering/claude-code-auto-mode
- [K95] Anthropic Engineering, How we built our multi-agent research system (2025-06-13). https://www.anthropic.com/engineering/multi-agent-research-system
- [K96] Anthropic Engineering, Building effective agents (2024-12-19; the page now notes "Much of the tooling landscape described in this post has changed since December 2024"). https://www.anthropic.com/engineering/building-effective-agents
- [K97] OpenAI, A practical guide to building agents (PDF; no date in its text, created 2025-04-07 by its metadata). https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf
- [K98] OpenAI Agents SDK, Running agents: `max_turns`, `MaxTurnsExceeded`, error handlers (SDK 0.23.1 on PyPI, 2026-10-02; `DEFAULT_MAX_TURNS = 10` in `run_config.py` on main). https://openai.github.io/openai-agents-python/running_agents/
- [K99] Anthropic Engineering, Demystifying evals for AI agents (2026-01-09). https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- [K100] OpenAI Agents SDK, Guardrails: parallel and blocking execution. https://openai.github.io/openai-agents-python/guardrails/
- [K101] Google Search Central, Creating helpful, reliable, people-first content (last updated 2026-10-05). https://developers.google.com/search/docs/fundamentals/creating-helpful-content
- [K102] Google Search Central, Google Search's guidance on using generative AI content (last updated 2026-10-01). https://developers.google.com/search/docs/fundamentals/using-gen-ai-content
- [K103] Google Search Central, Spam policies: scaled content abuse (last updated 2026-08-28). https://developers.google.com/search/docs/essentials/spam-policies
- [K104] Google, Search Console API, `searchanalytics.query`: clicks, impressions, CTR, position by query and page (last updated 2026-08-11). https://developers.google.com/webmaster-tools/v1/searchanalytics/query
- [K105] WordPress REST API, Posts: status values for a new post (page dated 2024-01-16). https://developer.wordpress.org/rest-api/reference/posts/
- [K106] Anthropic, Claude Haiku 5.5 (launch, 2026-10-07): "We’re halving the price of Claude Sonnet 5.5’s cache reads". https://www.anthropic.com/claude-haiku-5-5
- [K107] SWE-bench, leaderboards: % resolved; the Bash Only view runs every model in mini-SWE-agent; newest entry dated 2026-02-26. https://www.swebench.com/
- [K108] Anthropic, Claude Fable 5.1 and Mythos 5.1 (launch, 2026-09-01). https://www.anthropic.com/claude-fable-and-mythos-5-1
- [K109] Google, Code execution: "The maximum runtime of the code environment is 30 seconds." https://ai.google.dev/gemini-api/docs/code-execution
- [K110] Google, model pages for Gemini 3.6 Flash and Gemini 3.5 Flash-Lite: https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash, https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite
- [K111] Z.ai, GLM Coding Plan usage revision notice: "The new credits-based plan is now available." https://docs.z.ai/devpack/notice/usage-revision
