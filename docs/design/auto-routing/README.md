# Auto routing: Morndo picks, per run, which allowed Connection does a Role's work (design, 2026-10-11)

**Phase: design only.** This document and [ADR-0020](../../adr/0020-auto-routing.md). No product code yet.

**The request (2026-10-11):** for execution, switch between a Cursor subscription and GLM through a Z.ai key. Morndo decides which one runs when, so the settings need an Auto mode.

**The owner's answer to decision 1 (2026-10-11):** "A combination. Maybe a lightweight model to decide... research the web when to use what model and if we could use something like decision api to make it more easy. In general maybe how we can use decision api."

**So this revision makes Auto a hybrid router.** Three stages, per run:
1. **Hard rules** exclude what may not run: the gate, budgets, each Role's allowed Connections, the principal's caps, the reviewer from another provider, and `hand` Roles, which are never routed (section 6.1).
2. **A lightweight decider** picks among what is left. It sees only a minimised task profile, offers a probability per option, and acts only at or above a threshold (section 6.4).
3. **The rules and the Scorecard** decide whenever the decider doesn't: below the threshold, or when it is off, unavailable, over its budget, or not opted in for the workspace (section 6.2). The Scorecard also feeds the decider (section 7.4).

The decider starts in shadow. It acts only after it has shown, on this user's own work, that it adds something the rules miss (section 11).

**Review history.** A fresh-context review of the first draft found fifteen problems. Each was checked against the code or the text and folded in:
- Auto was a sixth mode, which re-derived chains; it is now a switch beside the mode.
- Families were per preset, so a Claude model inside Cursor passed the review rule; families are now per model.
- A drifted Role could be auto-routed against a chain it no longer runs.
- A replay lacked the settings and the Scorecard cells it was decided on.
- The example's L-size task cost more than the default reserve.
- Standing decayed as old Outcomes left the window.
- `review` Outcomes had no caller check.
- The launcher records no entry, model or route.
- Abandoned routes counted as rounds.
- The daily cap missed concurrent picks.
- Widening was judged by command kind, not by effect.
- A QA step needed wiring that arrives only in a later PR.
- Small wording mismatches.

A second pass checked those fixes and found these gaps, also folded in:
- a route id that the starter can't hand to the launcher before the engine layer passes it;
- a reserve with no stored value;
- the Role switch's default;
- holds that move work onto a key;
- no lane to compare for `--by`;
- inputs that arrived only in PR 4;
- a missing transaction boundary;
- two switches on an `own` Role;
- unmatched models turning `unknown`;
- the example's budget;
- start levels across the Roles of one group.

The hybrid revision keeps all of that. It replaces the non-goal "no model call to decide" with a fenced decision step, and adds sections 2.1, 2.2, 5.4, 6.3–6.5, 7.4, 8.3, 10, 11 and 16.

**Builds on:**
- ADR-0013: Roles, chains, and the engine layer's resolver.
- ADR-0015: the board.
- ADR-0016: Usage windows.
- ADR-0018 and its design ([`../secret-store/README.md`](../secret-store/README.md)): Connections, the Lease gate, and the Routing policy with R7–R15.
- The Z.ai preset on `feat/zai-glm`.

Facts carry a source and the date read. **[P*n*]** points to section 18. UNVERIFIED marks what no primary source settled. A secondary research summary was read first; every fact taken from it was checked against the vendor's own page, and section 2.1 lists what didn't hold. The program is named `morndo-connections` here, as in ADR-0018; the build ships it as `morndo-keys`, and every command below runs under either name.

## 1. What we looked at first

All read on 2026-10-11.

- **The Routing policy is built** (`packages/domain/src/routing.ts`):
  - `Mode` has five values;
  - `effectiveOrder` filters or partitions the order by Kind, or keeps a `custom` order as given;
  - `deriveChain` keeps a Role's Picks whose Connection is in the order, stably sorted;
  - `hand` keeps the Picks as the chain;
  - `planWrites` and `project` decide, purely, which chains to write;
  - `RoutingService` writes them through the engines CLI, and `observeDrift` flags outside edits.
  - Nothing in it knows about a task.
- **The engine layer resolves per Role, not per task** (engine-layer `resolver.py`, `lane.py`, `config.py`):
  - `engines resolve ROLE [--risk] [--implementer E]` returns the first entry that is available: enabled, installed, signed in (a probe younger than an hour wins), and not marked out until a time. It exits 3 when nothing is available.
  - Under the other-provider rule, it skips a family it can't prove different, `unknown` included.
  - A provider's family is either fixed, or matched per model through `family_by_model` patterns, with `unknown` when none matches.
  - Its lane starter takes `--engine E|auto --role R`, where `auto` means "resolve the Role's chain".
  - Its mid-task switch, after a quota, billing or auth failure, takes the first available entry of the Role's chain other than the current one, scanning from the top.
  - Its ledger answers who implemented a branch: `engines implementers --repo R --branch B --json`.
- **Morndo registers one family per provider:** `publishOwned` sends `preset.family` (`apps/connections/src/application/engines-sync.ts`). A fixed family wins over `family_by_model` in the engine layer, so `cursor:claude-sonnet-5.5` counts as family `cursor`.
- **The launcher doesn't record what ran:**
  - `run` leases with the preset's default model as the Lease's entry, and reserves `--reserve`, default $5 (`apps/connections/src/cli.ts`).
  - `LeaseClosed` carries no entry, no model and no route (`packages/domain/src/connections.ts`).
- **The gate is a pure function.** `gate(connection, query)` answers grant or the first refusal (CN8), so a dry run costs nothing and records nothing.
- **The Z.ai preset** (`feat/zai-glm`, read only):
  - `zai`: Claude Code runtime against `https://api.z.ai/api/anthropic`, family `zai`, isolation `os`;
  - static models `glm-5.3` and `glm-5.3-flash`;
  - prices dated 2026-10-10: $1.40 / $4.40 and $0.15 / $0.50 per 1M tokens;
  - default Picks `implement` → `glm-5.3@max`, else `glm-5.3@high`;
  - third-party leases are charged from catalog prices over the run's `modelUsage`.
- **The Cursor preset** is a subscription with family `cursor`. Its default Pick is `auto`: Cursor's own router, whose model, and so whose family, Cursor chooses.
- **Usage:**
  - Windows are read from a file beside the connections home, by Connection name (`apps/connections/src/adapters/usage-file.ts`).
  - Today only Claude Code reports windows, through its status line (ADR-0016), so a Cursor subscription has none.
  - The levels are fine, running low from 75%, and nearly out from 90% (`docs/agents/usage.md`).
- **The board** (`packages/domain/src/board.ts`):
  - A task has a title, a description, a priority and a record of moves, each with its actor.
  - A lane has at most one task in progress (B5).
  - A move from review back to in progress is a send-back. Done is the manager's or the principal's (B3).
- **Rules that bind auto as they stand:**
  - U4, ADR-0018 decision 9 and secret-store §7.1: Usage decides nothing.
  - CN15: spend decides only the gate.
  - R8: availability never reorders.
  - R13: policy changes are principal Commands.
  - R14: a Role edited outside Morndo is drifted.
  - ADR-0020 amends the first two narrowly (section 4.3, R18).

## 2. What others do, and what we take

| Product | How it picks | How it explains | Source, read 2026-10-11 |
|---|---|---|---|
| OpenRouter Auto Router | A "fast, lightweight classifier" puts the prompt into one of about 30 task types, ranks models by their share of spend for that type over 7 days, applies a `cost_tier`, and routes to the top survivor "with fallbacks". `allowed_models` and `excluded_models` restrict it. "If classification or rankings are ever unavailable, the router degrades gracefully to a default model set." | "The response includes the `model` field showing which model was actually used." The task type is opt-in metadata. | [P1] |
| Cursor Router (Auto) | A classifier on each agent request "routes it based on task type and complexity". Modes: Cost, Balance, Intelligence. A complexity score from 0 to 1 against a threshold keeps easy turns on a cheap model. It learns from the user's next action. | Admins may show the routed model or hide it: "Hidden is the default and recommended". | [P2], [P3] |
| Cursor billing | "All Auto modes bill at the list price of the model each request is routed to." | | [P4] |
| Claude Code | Aliases. `opusplan` "uses `opus` during plan mode, then switches to `sonnet` for execution". A `fallbackModel` list "tries them in order, showing a notice when it switches", and "the switch lasts for the current turn only". | The model shows in the status line and `/status`. | [P5] |
| LiteLLM Router | Strategies `simple-shuffle` (default), `usage-based-routing-v2`, `latency-based-routing`, `least-busy`, `cost-based-routing`, or custom. Fallbacks, order-based failover, and cooldowns per deployment. | The `x-litellm-model-id` header names the deployment. | [P6] |
| LiteLLM Auto Routing | A heuristic scorer with "zero API calls" over seven dimensions maps to tiers SIMPLE, MEDIUM, COMPLEX and REASONING. Options: an LLM classifier, keyword rules, Thompson sampling within a tier, and `session_affinity` that pins the first-turn model. | "Every routing decision emits one greppable line naming its cause." | [P7] |
| GitHub Copilot auto | System health plus task complexity. Chooses only from models allowed "subject to your policies and subscription type". | "You can see which model was used for each Copilot response." | [P8] |
| RouteLLM (paper) | A router predicts the probability that the strong model wins on a query, and a threshold α turns it into a choice: weak below α, strong at or above. Trained on human preference data. "Reduces costs by over 2 times in certain cases" on public benchmarks without hurting quality. | Judged by curves, not single picks: performance gap recovered (PGR), its average over thresholds (APGR), and the share of strong-model calls needed for a target (CPT). | [P14] |
| OpenAI Decisions API | Not a router; a typed-answer endpoint. A `choice` question returns one of the supplied values, a probability per value, and a `confidence` (section 2.1). | The answer is the choice and its probabilities. | [P9]–[P13] |
| LiteLLM decisions | One `/v1/decisions` route in front of several decision models, hosted and self-hosted, in the OpenAI format. | | [P15] |

What we take:
1. **An allowed set first** [P1, P2, P8]. Candidates are the Role's derived chain, nothing else.
2. **A cheap deterministic classifier** [P3, P7]. The Task profile comes from rules over facts at hand. A complexity threshold becomes the Tier.
3. **A probability and a threshold, then a fallback** [P1, P14]. The decider offers a probability per option; below the threshold, or when it can't answer, the rules decide. A request never fails because the decider did [P1].
4. **Learn from what the human does next** [P3]. Accepted first try or sent back on the board, review findings, fix rounds.
5. **Name the model that ran, and the cause** [P1, P5, P6, P7, P8]. Cursor hides it by default [P2]; Morndo always shows it, because the review rule needs the family and the principal's trust needs the reason. Each pick also says which stage decided.
6. **Keep fallback apart from routing** [P5, P6]. Routing picks the start; the chain stays the fallback.
7. **Pin a pick for its run**, as LiteLLM's session affinity does [P7]. A new pick is made only when a new run starts.
8. **Judge a router by outcomes against a baseline**, as RouteLLM does with cost–quality curves [P14]. Here the baseline is the rules, and the outcomes are this user's board and reviews (section 11).
9. **Not taken:** sampling [P7], market-wide ranking [P1], and a model that decides alone over the full task text [P3]. The first breaks replay, the second needs data one user doesn't have, and the third sends the brief out and lets its text steer spend. The decider here sees fields, not text, and chooses only among options the rules already accept.

### 2.1 The Decisions API, checked against the vendor's docs

Every row was read on the vendor's own page on 2026-10-11.

| Fact | Source |
|---|---|
| In public beta; "we expect to GA in the coming weeks". Released 2026-10-06 "in beta with `gpt-6-luna`". | [P9], [P11] |
| One model, `gpt-6-luna`, on the dedicated endpoint `POST /v1/decisions`. The model itself was released on 2026-09-22. | [P9], [P11] |
| A request has `model`, `input` (a text string, or user messages with text and images) and `questions`. Answers come back in the order asked; each echoes its question's `name`. | [P9], [P10] |
| Three question types: `predicate` returns `probability`, "an estimate from 0 to 1 that the condition is true"; `choice` returns one supplied value; `score` returns "the probability-weighted average of the level indices". | [P9] |
| A `choice` takes 2 to 255 unique values, each a string or a boolean, with an optional description. Its answer has `choice`, `probabilities` (one entry per value) and `confidence`. The docs don't define how `confidence` is computed. | [P10], [P9] |
| A question may come back as `{"type": "refusal", "name": …}` instead of an answer; other questions in the request still get answers. | [P10] |
| "Include a fallback option such as `"other"` when your categories don't cover every possible input." | [P9] |
| "Use labeled examples from your application to set thresholds for routing, filtering, or review. Choose thresholds based on the cost of false positives and false negatives." | [P9] |
| "About 10x faster than the Responses API". No absolute latency is published. | [P9] |
| Price: input "$0.10 per 1M tokens. You pay only for input tokens: there are no cache-read, cache-write, or output-token charges." "Regional processing premiums and long-context input pricing multipliers apply." The pricing page sets the regional uplift at 10% for models released on or after 2026-03-05, and long context above 272K input tokens. | [P9], [P12] |
| The response carries `usage` with `input_tokens` and their cached and cache-write counts, so a call's cost can be computed from the answer itself. | [P10] |
| No seed, temperature or `store` parameter is documented, and the docs promise no determinism. A pick is therefore replayed from the recorded answer, never by asking again. | [P10] |
| `/v1/decisions` data: not used for training; abuse-monitoring logs kept up to 30 days by default; Zero Data Retention for eligible customers; prompt caching may keep encrypted key/value tensors on GPU-local storage for up to 24 hours. HIPAA use under a signed addendum. | [P13], [P9] |
| Regional processing for `/v1/decisions` in the United States and Europe (EEA + Switzerland): per project, or per request through the `us.api.openai.com` or `eu.api.openai.com` domain with a key from a global project. Data residency, US included, starts with an eligibility check through the vendor's sales team; any non-US region also needs approved abuse-monitoring controls and a Modified Retention amendment. System data (account, metadata, usage) may be processed outside the region. | [P13] |
| SDK support from these versions: Python 3.26.0, JavaScript 7.30.0, Go 3.73.0, Ruby 0.101.0, Java 4.78.0. The `openai` npm package was at 7.32.0 on the registry on 2026-10-11. | [P9]; `npm view openai version` |

What the secondary summary claimed that the vendor's pages don't support, so the design doesn't use it:
- **"Calibrated probabilities."** The docs say "an estimate" and tell you to set thresholds from your own labelled examples. Thresholds here are set from this user's outcomes (section 11.6).
- **A rate limit for "Tier 1".** The vendor replaced five usage tiers with three (Build, Launch, Grow) on 2026-10-06 [P11]. Morndo's volume is a few calls per run, so no limit is assumed; a 429 is handled as `unavailable`.
- **How the endpoint works inside** (softmax over final tokens). Not documented; nothing here depends on it.
- **Hosted image URLs.** The guide says they aren't supported; the reference says publicly accessible URLs are. Auto routing sends no images, so the conflict doesn't matter here.

### 2.2 When to use which model: what the vendors say

| Vendor | What its own docs say | Source, read 2026-10-11 |
|---|---|---|
| Anthropic | "Most workloads start with Claude Opus 5.5." Opus 5.5 for "complex agentic coding and enterprise work", such as "large-scale refactoring"; Sonnet 5.5 for "speed and capability for everyday coding"; Haiku 5.5 for "the lowest latency and price", including "sub-agent tasks"; Fable 5.1 for "the highest available capability". "Tuning effort is often a better lever than switching models." "Having a good evaluation set is the most important step." | [P16] |
| Z.ai | GLM-5.3 is "Z.ai's latest flagship model", reasoning always on, effort `low`, `high` or `max` (default `max`): "For complex tasks such as coding, we recommend using `max`." GLM-5.3-Flash delivers "stronger intelligence than GLM-5.2 at an exceptionally low cost", and is multimodal. | [P17] |
| OpenAI | `gpt-6-luna` is the only Decisions model; it is the decider here, not a coding model. | [P9] |

What we take:
1. **A model class per catalog model, from the vendor's own words:** `flagship`, `everyday` or `fast` within that vendor's line-up (Fable 5.1, Opus 5.5 and GLM-5.3 `flagship`; Sonnet 5.5 `everyday`; Haiku 5.5 and GLM-5.3-Flash `fast`). A class says where a model sits in its own vendor's line, not how it compares across vendors. That comparison is the Scorecard's job.
2. **The class is a prior, never a verdict.** It is a feature in the decision input (section 5.4) and a key in `hard` ranking after the quality band, so this user's own record outranks it (section 6.2).
3. **Effort is part of the entry** [P16, P17]. A chain may list one model at two efforts (`glm-5.3@high`, `glm-5.3@max`). Auto treats them as two Candidates, so routing can lower effort before it changes model.
4. **Your own evaluation set decides** [P16]: the Outcomes and the Scorecard (section 7), and the shadow comparison (section 11).

## 3. Goals and non-goals

**Goals:**
- Auto in the settings. Per run, Morndo picks the Connection and model to start with, among those the user allowed for the Role.
- Easy and small work goes to what is cheap. Hard and risky work goes to what the user trusts. A new model earns harder work through results.
- Where several Candidates are all acceptable, a lightweight decider may choose between them, if it has shown on this user's work that it chooses better than the rules.
- Every pick names its cause and the stage that decided, in one line and in full with `why`. Replaying its stored inputs gives the same pick, without calling any model.
- The rules in force still hold: the gate, budgets, the review rule, `hand` and drifted Roles, and fallback.
- Turning Auto, or the decider, on or off changes no chain.

**Non-goals:**
- No model call decides alone. The decider chooses only inside the option set (R30), only at or above its threshold, and never admits what the hard rules excluded.
- No task text leaves the machine for routing. The decision input is fields from an allowlist (R32).
- No change to the projected chain per task.
- No fleet-wide policy: the Routing policy is per node (ADR-0018), and so are routes, Outcomes, Standing and the decider's settings.
- No routing inside a run: the runtime's own fallback model [P5] stays the runtime's.
- No new Verification. Outcomes are acceptances by others, not Evidence (V1).

## 4. The model

### 4.1 Where auto lives

The **Engines** context, beside the Routing policy (ADR-0018 §3.4). Code: `packages/domain/src/auto-routing.ts`, pure, beside `routing.ts`.

| Piece | Kind | Holds |
|---|---|---|
| Routing policy (extended) | Aggregate | The global Priority's `auto` switch; each Role's Auto switch (default: on for the `implement` group, off for every other Role); Auto settings (Task ceiling, Save line, daily caps, and each Role's reserve, default $5); the **decider settings** (adapter, Connection, region, on or off, acting groups and Tiers, threshold, timeout, holdout, daily budget, opted-in workspaces). Guards R16, R28 and R33. |
| Standing table (new) | Aggregate, one per node | Per Candidate and role group: the level, whether the principal pinned it, and its history of StandingChanged. Guards R27. |
| Run route (new) | Aggregate, one per route id (`rt-118`) | The Auto pick, immutable once made, with all its inputs, its **decider record**, and the Outcome facts appended to it. Guards R17 to R26 and R29 to R32. |
| Scorecard | Read model | A projection of Outcome facts per entry that ran, role group and Tier. It feeds ranking, Standing moves, the decision input and the evaluation; it moves nothing by itself. |
| Decider report | Read model | A projection of decider records and Outcomes per role group and Tier: agreement, lift, calibration, cost and latency (section 11). It feeds the switch-on and switch-back rules. |

How auto relates to the other contexts:
- **Connections:** Engines stays downstream, as in ADR-0018. Auto reads the directory and runs the gate as a pure query. Connections still knows nothing about Roles (CN15). Two changes on that side: the launcher records the route, the asked entry and the model reported (section 7.1); and a decider call leases on the decider's Connection like any other use of a key (section 10.5).
- **Board:** read through an adapter. Auto takes a task's title, priority and moves with their actors; the board grants nothing (B8).
- **Usage:** read through an adapter, for windows.
- **The engine layer:** read through the existing `EngineSettings` port and a ledger port, for availability, chains, families and implementers.
- **The decider:** an outbound port (section 8.3). The domain knows the question and the answer shapes, never a vendor.
- **Grants:** none. A pick is not a Lease, a Mandate or a Verdict. A decider answer is not one either. Outcomes are not Evidence.

### 4.2 Ubiquitous language

ADR-0018 already uses **Pick** for an engine a Role may run on (`connection:model[@effort]`). To keep one meaning per word, this design says **Auto pick** for the choice made for one run, **Candidate** for an ADR-0018 Pick under consideration, **rules pick** and **decider choice** for what each stage proposed. **Outcome** here is not the Jobs context's Outcome, nor a Lease's `outcome` field (how its process ended). **Decision** here is not an ADR's decision, nor an owner decision.

| Term | Means | Is not |
|---|---|---|
| Auto | A switch on the global Priority, beside its mode. When on, each Role whose Auto switch is on has its derived chain, still derived by its mode or its own Priority (R8–R10), as the allowed set and the fallback order, and Morndo picks per run which entry starts. | A sixth mode; the engine layer's `--engine auto`, which only resolves the chain; a vendor's own router. |
| Auto switch | Per Role, on or off. Default: on for the `implement` group, off for every other Role. A Role's own Priority (`own`) shapes its chain only; it has no switch of its own. | An Override; `hand`. |
| Reserve | Per Role, an Auto setting: what a run of the Role may reserve on a key, $5 by default as the launcher's `--reserve`. `route` answers it with the pick, and the launcher uses it. | A Budget. |
| Run request | A request to start one run of a Role: role, risk, workspace, and optionally task key, lane, round, implementers and hints (kind, size, brief file). | A board task; a Lease. |
| Task profile | What a Run request is known to be. Each signal has a value and a source (section 5). The brief is kept only as a digest and counts. | The brief's text; a model's guess. |
| Tier | `routine`, `standard` or `hard`: what the profile demands, from the rules table. | A price tier of a vendor. |
| Role group | The Role name up to its first hyphen (`implement-ui` → `implement`). Standing, Scorecards and the decider's acting switches pool over it. | A Role. |
| Family | The model family of one entry, from the catalog's per-model map (`claude-*` → `anthropic` inside Cursor too). A vendor router's model is `unknown`. | The provider; the vendor. |
| Model class | `flagship`, `everyday` or `fast`: where a model sits in its own vendor's line-up, from that vendor's docs (section 2.2). | A quality score; a comparison across vendors. |
| Candidate | One entry of the Role's derived chain (its risk chain for risk-area work) under consideration for one run, with its facts: Connection, Kind, custody, family, class, availability, gate verdict, expected cost, quota, Standing, quality band and median time. | A Connection; a Pick outside the chain. |
| Exclusion | The first hard limit a Candidate fails (section 6.1), with its values. | A low rank; a Fence. |
| Rules pick | The Candidate the rules and the Scorecard rank first (section 6.2). Always computed. The floor, the fallback, and the decider's baseline. | The Auto pick, unless the rules decided. |
| Fence | A rule that keeps an eligible Candidate out of the option set: the trust floor, the Task ceiling, and kept-for-harder-work on routine work (section 6.3). | An Exclusion: a fenced Candidate can still be the rules pick and still runs as a fallback. |
| Option set | What the decider may choose from: the eligible Candidates less the fenced ones, plus the rules pick (R30). Each option has an opaque id (`o1`, `o2`, …) for the call. | The chain; the Candidates. |
| Decider | Whatever answers "which option should start this run?" with a probability per option, through the decision port: the rules adapter, a vendor's decision endpoint, or later a local model. | A gate; a router that may pick outside the option set. |
| Decision step | One call of the decider for one route, or its skip with the reason. At most one call per route. | A retry loop. |
| Decision input | The minimised profile and option features sent to the decider: an allowlist of enums and numbers (R32, section 5.4). | The brief, the title, code, paths or names. |
| Escape option | The option `rules`: "no option is clearly better; let the rules decide". Choosing it hands the pick to the rules. | A refusal. |
| Decider choice | The option the decider chose, with its probability. | The Auto pick, unless it acted. |
| Threshold | The probability, read from the answer's `probabilities` for the chosen option, at or above which a decider choice may act. 0.80 by default. | The answer's `confidence`, which is recorded but not used, since the docs don't define it. |
| Decider mode | Per role group and Tier: `off` while the decider is off; when it is on, `acting` (may act) for the groups and Tiers switched to it, and `shadow` (asked and recorded, never acts) for every other. | The Auto switch. |
| Holdout | While acting, the routes decided by the rules anyway, one in five, chosen by route id, so the decider is always compared with the rules on the same work. | A random sample. |
| Opted-in workspace | A workspace whose routes may send a decision input off the machine. None by default. | The decider Connection's repo list, which must admit the workspace too. |
| Decider budget | The most decision calls may spend per day on the node, across all uses. | A Connection's Budget, which still applies. |
| Auto pick | The Candidate chosen for one run, the run's chain (the pick, then the rest of the derived chain in Role order), the stage that decided, the Reasons, the Exclusions, the Fences, the ranking and the inputs. | A Lease; a chain written to the engine layer. |
| Reason | A typed fact that decided, fenced or excluded: a code with numbers (`cheapest`, `kept-for-harder`, `trusted-for`, `no-trusted-available`, `budget`, `decider`, `below-threshold`, `holdout`, …), rendered from the protocol's words table. | Free text; the brief. |
| Outcome | What came of an Auto pick: the entry that ran, fell back or not, accepted first try, send-backs, review findings, fix rounds, cost with its source, wall time, and the model reported. Append-only facts from named sources. | A lane's own claim of done (V1); a Verdict. |
| Scorecard | Per entry that ran, role group and Tier: counts and medians of Outcomes in a window, with a quality band. | A benchmark; a promise. |
| Task ceiling | The most a metered key may be expected to cost for one task before a kept subscription goes first, and the line the decider may not cross (Fence b). | A Budget (CN8). |
| Save line | The weekly-window share past which a subscription is kept for harder work. | The engine layer's out-of-quota mark. |
| Daily cap | Per metered Connection: what Auto's picks may commit to it in a day. | Its Budget. |

### 4.3 Invariants

They continue the Engines context's R1–R15. R16–R28 are the first design's, with R21–R25 and R28 extended for the decision step. R29–R33 are new.

| # | Invariant |
|---|---|
| R16 | A run is auto-routed only when all of these hold: Auto is on in the global Priority; the Role's Auto switch is on; the Role's Override is not `hand`; and the Role is not drifted (R14). A Role under `own` follows the same two switches; its own Priority shapes only its chain. Otherwise `route` answers "not auto" with its reason (`off`, `role-off`, `hand` or `drifted`), and the run resolves the derived chain as today. No decision step runs for such a run. Turning either switch changes no derived chain and writes nothing (R8, R10 unchanged). |
| R17 | The Candidates are exactly the entries of the Role's derived chain. For risk-area work, they are the entries of its derived risk chain when it has one. An Auto pick is always one of them, whichever stage decided, and the run's chain holds no other entry. |
| R18 | **The hard rules.** A Candidate is excluded, with its first failing reason, in this order: (1) not in the chain (a tamper guard); (2) a family of `unknown`, which covers vendor router models; (3) the engine layer's availability: off, not installed, signed out, or marked until a time; (4) the gate's dry run for this workspace, every CN8 step, for a Connection in Morndo's custody; (5) budget: a metered Candidate's expected cost is above the reservation the gate would grant for the Role's reserve (an Auto setting, $5 by default), or the day's committed Auto spend on it plus that cost passes its daily cap. Committed spend is closed spend, plus open reservations of routed runs, plus the expected cost of picks not yet leased that are younger than 10 minutes. (6) quota: a subscription window at 90% or more; (7) the review rule (R19); (8) Standing `held`. Usage windows and spend figures act only here, in fences and in ranking. They never grant, and never admit what (1)–(4) refused (amends U4, CN15, ADR-0018 decision 9). The decider sees only Candidates these rules left. |
| R19 | **Review rule**, on per-model families. The review Role is the one named `review`, which the engine layer's resolver applies `review_other_provider` to; the rule is also in effect for any Role with `other_provider` on. While it is in effect for a Role, that Role's Candidate is excluded when its family equals the family of any implementer on the task's branch (the engine layer's ledger, joined with earlier Auto picks for the task); `unknown` is already excluded by R18. While it is in effect for `review`, an implementer Candidate is excluded when no entry of another family would remain in the `review` chain. |
| R20 | The Tier is a function of the Task profile and the rules table in force, versioned (`rules-v1`, section 5.3). A missing signal takes its stated default. Risk-area work is always `hard`. |
| R21 | Ranking is lexicographic per Tier (section 6.2), and its first Candidate is the rules pick. The Role's order is the last key. The result doesn't depend on the order the Candidates were listed in. The rules pick is computed for every auto-routed run, whether or not the decider is asked. |
| R22 | An Auto pick is a pure function of its inputs: the profile; the Candidates with their facts, Standing included; the Auto settings and decider settings in force; the Scorecard cells used, with their counts; the decider record (the option set and its id map, the decision input as sent, and the answer as received, or the reason no call was made); the committed spend read before the call and the committed spend re-read in the write transaction; the policy, rules and decider versions; and `now`. All of them are stored with the pick before the run's chain is answered. A shadow answer is appended afterwards and never changes the pick. `why --replay` recomputes the pick from the stored inputs, without calling the decider, and must get the same one, whatever changed since; a mismatch raises an Alert. A route's decider is called at most once: Morndo never asks again to get a different answer. |
| R23 | An Auto pick carries at least one Reason, which names the stage and the key that decided it. Each excluded Candidate carries its first Exclusion; each fenced one its Fence. Reasons, Exclusions and Fences hold codes, names from the policy and numbers (a decider Reason holds the option, its probability and the threshold). They never hold a brief, a title, a description or a path. |
| R24 | The run's chain is the pick, then the rest of the derived chain in the Role's order. A refused lease (75) or a failed run falls down that chain as today. When no Candidate is eligible, or `route` fails or is late, the run resolves the derived chain as today. A decider that errs, refuses, times out or is over budget leaves the rules pick in force. Auto never removes a fallback and never stops a run. |
| R25 | Auto writes nothing to the policy's chains or to the engine layer: no Priority order, Override, Pick, chain, mark or provider. Neither does the decider. A pick grants nothing. The gate decides at lease time, and the engine layer decides availability at start. |
| R26 | Outcome facts are append-only, tied to one route id, and carry their source (`lease`, `ledger`, `board`, `review`, `principal`). A later fact of the same kind supersedes an earlier one only from a source of equal or higher trust. A spend figure follows CN10. No Outcome comes from the run being judged: a lane's own STATUS line or claim is never one. A `review` fact must name the reviewing run's route or lease. Both routes must carry a lane, and the lanes must differ; otherwise the fact is refused. A route counts toward a task's rounds and toward any Scorecard only once it has a `ran` fact, and it counts in the cell of the entry that ran. A Scorecard is a pure function of the facts recorded before a given time. A decider answer is never an Outcome. |
| R27 | **Standing**, per Candidate and role group. When Auto first applies to a Role, each entry that is the first of that Role's derived chain or risk chain starts trusted up to `hard` in the Role's group. If two Roles of a group start different entries, both are trusted: the higher start wins, and a later Role never lowers a level already set. Every other Candidate starts on probation, and so does one that joins a chain later. The principal may set any of them in the same Command. After that, Standing moves only when an Outcome lands, by the rules table (section 7.3), or when the principal pins it. Outcomes leaving the Scorecard window move nothing, and neither does a decider answer. A pin holds until removed. Every automatic move is persisted as StandingChanged and raises an Alert. |
| R28 | Every change to Auto's settings, the decider's included, is a principal Command (R13), judged by effect. It is narrowing, and needs a session only, when no metered Candidate can gain work or spend beyond what the rules pick, under the same caps, would give it, and no more data can leave the node: a lower Task ceiling, daily cap or reserve; a hold or a lower pin on a Candidate that shares no chain with another metered Candidate; the decider off, or a group and Tier from `acting` to `shadow`; a higher threshold; a lower decider budget; a workspace removed from the opt-in. These last ones only hand picks back to the rules pick, which the caps already bound. Every other change needs step-up (AC7), or a typed confirmation at the machine: either Auto switch on or off, a Save line change, a raised ceiling, cap or reserve, a higher pin, a release, a hold or lower pin whose work could move to a key, the decider on, a group and Tier to `acting`, a lower threshold, a raised decider budget, a workspace added to the opt-in, a change of decider adapter, Connection or region. Auto off counts too, since it returns a Role to its plain order, which may start on a metered key. R27's automatic moves and R33's automatic switch-back are the only exceptions. |
| R29 | **The decision step runs** for a route only when all of these hold: the route is auto-routed (R16); the decider is on, so the route's role group and Tier is in `shadow` or `acting` (R33); the adapter keeps data on the node, or the route's workspace is opted in; the option set (R30) has two or more options; the day's decider spend plus this call's expected cost stays within the decider budget; the decider's Connection, when it has one, is granted a Lease for the route's workspace (holder `decider`, CN8); and, for an acting call, at least the decider's timeout is left before `route`'s own deadline (1.8 s). Otherwise the step is skipped with its reason (`off`, `not-opted-in`, `one-option`, `over-budget`, `gate`, `late`), and the rules pick acts. One deadline, the timeout (1 s by default), covers the Lease, opening the key and the call; past it the step is `unavailable`, as is a call that errs. A refusal is `refused`. Either way the rules pick acts. |
| R30 | **The option set** is the eligible Candidates, after R18 and R19, less those a Fence removes, plus the rules pick if a Fence removed it. The Fences, each recorded with its reason: (a) **trust floor**: a Candidate not trusted for the Tier, while at least one Candidate trusted for it is eligible; (b) **Task ceiling**: a metered Candidate whose expected cost is above the Task ceiling, and a Candidate whose cost is `unknown`; (c) **kept for harder work**: on routine work, a kept subscription (owner decision 3). The decider chooses only from the option set or the escape option. It never admits an excluded Candidate, never lifts a Candidate past its Standing, and never moves a pick outside the Role's allowed set. |
| R31 | **The Auto pick** is the decider's choice only when all of these hold: the mode is `acting` for the route's role group and Tier; the route is not in the holdout (R33); the answer is a choice, not a refusal, error or timeout; the choice is in the option set and is not the escape option; its probability in the answer's `probabilities` is at or above the threshold; and, re-checked inside the write transaction, the chosen Candidate is still in the option set recomputed there, by R18, R19 and R30. Otherwise the Auto pick is the rules pick, with the reason (`shadow`, `holdout`, `escape`, `below-threshold`, `refused`, `unavailable`, `stale`, or the skip reason from R29). |
| R32 | **The decision input is minimised.** It is built only from an allowlist of enums, numbers and catalog ids: for the task, the role group, Tier, kind, size, risk, round, priority, workspace languages, and the implementers' families; for each option, an opaque option id, the model id and effort from the catalog, family, class, Kind (subscription or key), cost class and expected dollars, Standing, the Scorecard cell's counts, mean findings and median minutes, and the 7-day window share. Nothing else is sent: no title, description, brief, diff, code, path, file name, branch, repo name or remote, workspace id, lane, task key, Connection name, key, or free text. The allowlist is a schema; a field outside it fails the build. Option ids are assigned per call, and the map from ids to entries stays on the node. A local adapter may read more in memory (section 8.3), but stores what R23 allows. |
| R33 | **Modes and switches.** The decider is off or on. When on, every role group and Tier is in `shadow`, except those switched to `acting`. Turning it on, and switching a group and Tier to `acting`, are principal Commands with step-up (R28); `acting` is accepted only for a group and Tier where the switch-on rule (section 11.3) holds at that moment, and its numbers are stored with the Command. `acting` → `shadow` happens automatically when the switch-back rule (section 11.5) fires, with an Alert, or by any session. Turning the decider off returns every group and Tier to `off`. While acting, a route is in the holdout when the first 8 hex characters of the SHA-256 of its id, read as a number, are divisible by 5. A holdout route is decided by the rules, and its decider answer is recorded. |

### 4.4 Events

- **Routing policy:**
  - PriorityChanged (as before);
  - AutoSwitched (`global` or a role, on or off, command);
  - AutoSettingsChanged (which setting, from, to, command);
  - DeciderSwitched (on or off, or a group and Tier to `acting` or `shadow`, command or `switch-back`, with the switch-on or switch-back numbers);
  - DeciderSettingsChanged (adapter, Connection, region, threshold, budget or workspace, from, to, command).
- **Standing table:**
  - StandingChanged (Candidate, group, from, to, cause: `start`, `promoted`, `demoted` or `pinned`, with the route that tipped it);
  - StandingPinned and StandingUnpinned (Candidate, group, level, command).
- **Run route:**
  - AutoPicked (route, role, tier, pick, stage: `rules` or `decider`, cause);
  - AutoDeclined (route, role, reason: `off`, `role-off`, `hand`, `drifted` or `none-eligible`);
  - DeciderAnswered (route, adapter, choice, probability, acted or not, reason, cost, milliseconds);
  - DeciderSkipped (route, reason);
  - OutcomeRecorded (route, kind, source).

The audit keeps them for 180 days, the same window as routes and Outcomes. Standing itself is kept as long as the Connection.

### 4.5 A sketch of the domain module

```ts
// packages/domain/src/auto-routing.ts (sketch; names may change in PR 1 and PR 7)
export type Tier = "routine" | "standard" | "hard";
export type Size = "S" | "M" | "L" | "XL" | "unknown";
export type TaskKind = "fix" | "feature" | "refactor" | "test" | "docs" | "chore" | "review-fix" | "unknown";
export type ModelClass = "flagship" | "everyday" | "fast" | "unknown";
export type Source = "flag" | "board" | "lane-task" | "branch" | "diff" | "findings" | "brief" | "picks" | "ledger" | "default";
export type Signal<T> = { value: T; source: Source };
export type TaskProfile = {
  role: string; group: string; risk: Signal<boolean>; kind: Signal<TaskKind>; size: Signal<Size>;
  round: Signal<number>; priority: Signal<"high" | "normal" | "low">; workspace: string; languages: readonly string[];
  task: string | null; lane: string | null; implementers: readonly { entry: string; family: string }[];
  brief: { digest: string; items: number; paths: number } | null;
};
export type Level = "held" | Tier;                                  // trusted up to this Tier; "routine" = probation
export type Cost = { kind: "included" } | { kind: "kept" } | { kind: "metered"; usd: number; from: "scorecard" | "prior" } | { kind: "unknown" };
export type Candidate = {
  entry: string; connection: string; kindOf: "subscription" | "api-key"; family: string; modelClass: ModelClass; inChain: boolean;
  available: true | { reason: string; until: number | null }; gate: "ok" | "not-ours" | GateReason;
  reservation: number | null; cost: Cost; committedToday: number | null; window: number | null;
  level: Level; band: "A" | "B" | "C" | "new"; minutes: number | null; rank: number;   // rank: place in the Role's order
};
export type AutoSettings = {
  taskCeiling: number; saveLine: number; dailyCaps: Readonly<Record<string, number>>; reserves: Readonly<Record<string, number>>;
};
export type DeciderSettings = {
  adapter: "rules" | "vendor" | "local"; connection: string | null; region: "global" | "us" | "eu";
  on: boolean; acting: readonly { group: string; tier: Tier }[];   // when on: acting in these cells, shadow elsewhere
  threshold: number; timeoutMs: number; holdoutEvery: number; dailyBudget: number; workspaces: readonly string[];
};
export type DecisionInput = {                                       // R32: built only by decisionInput(); a schema guards it
  version: "decider-v1";
  task: { group: string; tier: Tier; kind: TaskKind; size: Size; risk: boolean; round: number;
          priority: "high" | "normal" | "low"; languages: readonly string[]; implementerFamilies: readonly string[] };
  options: readonly { id: string; model: string; effort: string | null; family: string; modelClass: ModelClass;
                      kindOf: "subscription" | "api-key"; cost: Cost; level: Level;
                      record: { k: number; n: number; findings: number; minutes: number } | null; window: number | null }[];
};
export type DecisionAnswer =
  | { kind: "choice"; choice: string; probabilities: readonly { value: string; p: number }[]; confidence: number | null;
      model: string; inputTokens: number; ms: number }
  | { kind: "refused" | "unavailable"; detail: string; ms: number };
export type DeciderRecord = {
  step: "ran" | "skipped"; reason: string; adapter: string; options: readonly string[]; ids: Readonly<Record<string, string>>;
  fenced: readonly { entry: string; reason: Reason }[]; input: DecisionInput | null; answer: DecisionAnswer | null; usd: number | null;
};
export type AutoPick = {
  route: string; at: number; tier: Tier; pick: string | null; chain: readonly string[]; stage: "rules" | "decider";
  rulesPick: string | null; reasons: readonly Reason[]; excluded: readonly { entry: string; reason: Reason }[]; ranked: readonly string[];
  inputs: { profile: TaskProfile; candidates: readonly Candidate[]; settings: AutoSettings; decider: DeciderSettings;
            cells: readonly CellCounts[]; record: DeciderRecord; versions: { policy: number; rules: string; decider: string } };
};
export function tierOf(profile: TaskProfile, rules: RulesV1): Tier;                                    // R20
export function decide(candidates: readonly Candidate[], profile: TaskProfile, settings: AutoSettings,
                       rules: RulesV1, now: number): RulesResult;                                    // R17–R21: exclusions, ranking, rules pick
export function fence(result: RulesResult, settings: AutoSettings): OptionSet;                        // R30
export function decisionInput(profile: TaskProfile, options: OptionSet): DecisionInput;              // R32
export function finalize(result: RulesResult, options: OptionSet, record: DeciderRecord,
                         decider: DeciderSettings, route: string): Omit<AutoPick, "route" | "inputs">; // R22–R24, R31
export function inHoldout(route: string, every: number): boolean;                                   // R33
export function scorecard(facts: readonly OutcomeFact[], before: number, window: Window): Scorecard;  // R26
export function move(level: Level, pinned: boolean, cell: CellCounts, landed: OutcomeFact, rules: RulesV1): Level; // R27
export function switchOn(report: DeciderCell, rules: RulesV1): Verdict;                              // section 11.3
export function switchBack(report: DeciderCell, rules: RulesV1): Verdict;                            // section 11.5
```

## 5. The Task profile

### 5.1 Signals and where they come from

| Signal | Values | Sources, first that answers wins | Default |
|---|---|---|---|
| Role | a Role | The Run request (`--role`, the engine layer's role). | none; refused |
| Risk | yes or no | `--risk`: the engine layer's risk-area flag, the one that selects the risk chain. | no |
| Task | a key | 1. `--task`. 2. The lane's task in progress on the board (B5). 3. The lane's only task in to do. | none |
| Kind | see the sketch | 1. `--kind`. 2. The task title's conventional prefix (`fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `feat:`). 3. The branch prefix (`fix/`, `docs/`, …). 4. A keyword table over the title, as data in `rules-v1`. 5. `review-fix` when the round is above 1. | `unknown` |
| Size | S, M, L, XL | 1. `--size`. 2. A review run: the diff, `git diff --shortstat base...HEAD`. 3. A fix round: the number of findings. 4. The brief or the task description: acceptance items (list lines under a done-means heading) and paths named. | `unknown` |
| Round | 1 or more | 1. `--round`. 2. One more than the earlier routes for the same task and role group that have a `ran` fact (R26). Timeouts, retries and refused routes don't count. | 1 |
| Priority | high, normal, low | The board task. | normal |
| Workspace | an id and languages | The `RepoInspector`. The id is 12 hex characters of SHA-256 over the normalized first git remote, else over the real path. The languages come from manifest files (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, …). | the path's id |
| Implementers | entries with families | The engine layer's ledger (`engines implementers --repo --branch --json`), joined with earlier ran routes for the task. Families come from the catalog's per-model map. | none |
| Brief | digest, items, paths | `--brief-file`: read once, then kept only as these three. | none |

The title and description are read in memory to find the kind and the size, and are never stored (R23) or sent (R32). Everything stays on the node, except the decision input of an opted-in workspace.

### 5.2 Size thresholds (`rules-v1`, defaults)

| From | S | M | L | XL |
|---|---|---|---|---|
| Diff (changed lines, files) | ≤ 50 and ≤ 3 | ≤ 400 and ≤ 15 | ≤ 1,500 | above |
| Findings in a fix round | ≤ 2 | ≤ 5 | above | |
| Brief (acceptance items, paths named) | ≤ 2 and ≤ 2 | not S, L or XL | ≥ 6 or ≥ 10, below XL | ≥ 12 or ≥ 25 |

These are starting values. PR 4 records the actual diff at acceptance beside the estimate, and `log --routes` reports how often they agree (section 12). The thresholds change only with a new rules version.

### 5.3 Tier (`rules-v1`)

In order; the first row that matches decides.

| # | When | Tier | Reason code |
|---|---|---|---|
| 1 | Risk-area work. | hard | `risk` |
| 2 | Round 3 or later: two fix rounds already failed. | hard | `third-round` |
| 3 | Size L or XL. | hard | `large` |
| 4 | Size S, and the kind is `docs`, `test`, `chore`, `fix` or `review-fix`, and the priority isn't high. | routine | `small-routine-kind` |
| 5 | Anything else, unknown signals included. | standard | `default` |

The decider never changes the Tier. The Tier selects the fences, the ranking key and whether the decider may act.

### 5.4 The decision input

What leaves the machine, for an opted-in workspace, is exactly this (R32):

| Sent | Never sent |
|---|---|
| Task: role group, Tier, kind, size, risk, round, priority, workspace languages, implementers' families. | Title, description, brief, acceptance items, diff, code, file names and paths, branch, repo name or remote, workspace id, lane, task key. |
| Each option: an id for this call (`o1`, `o2`, …), the catalog's model id and effort, family, class, subscription or key, cost class and expected dollars, Standing, the Scorecard cell (k of n accepted first try, mean findings, median minutes), the 7-day window share. | Connection names (they are the user's labels and may name a client or a person), keys, Budgets, the Role's order, the rules pick, and any end-user identifier (`safety_identifier` stays unset). |

The rules pick isn't sent, so the decider can't simply echo it, and agreement in shadow means something.

The adapter renders the input as one text string and one `choice` question. An illustrative request (the setup of section 6.5, table B, task U-2):

```json
{
  "model": "gpt-6-luna",
  "input": "Task: group implement; tier standard; kind feature; size M; risk no; round 1; priority normal; languages typescript, css; implementers none.",
  "questions": [{
    "type": "choice",
    "name": "start",
    "instructions": "Pick the option most likely to have this task accepted on the first try, at the lowest cost. Every option is allowed for this task. Prefer an option's record on this kind of work over its general reputation. Choose rules when no option is clearly better.",
    "choices": [
      {"value": "o1", "description": "claude-sonnet-5.5 at high effort; family anthropic; everyday class; subscription, included (weekly window 35%); trusted up to hard; record here 3 of 5 first try, 1.4 findings, 22 min."},
      {"value": "o2", "description": "glm-5.3 at high effort; family zai; flagship class; key, metered, about $2.54; trusted up to standard; record here 4 of 4 first try, 0.5 findings, 18 min."},
      {"value": "o3", "description": "claude-sonnet-5.5 at high effort; family anthropic; everyday class; subscription, quota not reported; trusted up to hard; no record here yet."},
      {"value": "rules", "description": "No option is clearly better; let the rules decide."}
    ]
  }]
}
```

An illustrative answer:

```json
{
  "answers": [{
    "type": "choice", "name": "start", "choice": "o2",
    "probabilities": [
      {"value": "o1", "probability": 0.08}, {"value": "o2", "probability": 0.86},
      {"value": "o3", "probability": 0.03}, {"value": "rules", "probability": 0.03}
    ],
    "confidence": 0.81
  }],
  "model": "gpt-6-luna",
  "usage": {"input_tokens": 412, "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0}, "output_tokens": 0, "total_tokens": 412}
}
```

Notes:
- The instructions are versioned with the input (`decider-v1`). Changing a word is a new version, recorded with each pick.
- The descriptions are rendered from the allowlisted fields by a fixed template; no field is copied in as free text.
- With a threshold of 0.80 or more, a chosen option above the threshold is at least 0.60 ahead of every other, since the probabilities sum to 1. So a margin rule isn't needed.

## 6. Candidates, exclusions, ranking, and the decision step

### 6.1 Exclusions: the hard rules

R18's order, each with the value it shows. A refusal from the gate's dry run (4) uses the gate's own words (CN8).

| # | Exclusion | Shows |
|---|---|---|
| 1 | not in the chain | the entry |
| 2 | unknown family | "its model and family are chosen by the vendor" for a router model, else "no family is known for this model" |
| 3 | unavailable | the engine layer's reason and until when |
| 4 | gate | the first CN8 reason: off, terms, expired, repo, isolation, dialect, leases, budget |
| 5 | budget | the expected cost against the reservation (the Role's reserve, $5 by default, or what is left of the Budget), or against what is left of the daily cap |
| 6 | quota | the window and its share |
| 7 | review rule | the implementer's family |
| 8 | held | since when, and why (a demotion or a pin) |

With R16 (`hand` and drifted Roles aren't routed) and R17 (only the Role's chain), these are the hard rules the owner listed: the gate, budgets, each Role's allowed Connections, the principal's caps (reserve, daily cap, Budget), the reviewer from another provider, and `hand` Roles never routed. The Task ceiling is a ranking key for the rules and a Fence for the decider (section 6.3).

A Connection in the engine layer's custody (`studio`, `cursor-cloud`, `agy`) has no gate dry run, since the gate doesn't reach it: step 4 reads `not-ours`. Its cost is `unknown`.

### 6.2 Ranking: the rules pick

Each Tier has a key, compared left to right. The Role's order is always last. The first Candidate is the rules pick.

| Tier | Key |
|---|---|
| hard | trusted for `hard` first → quality band (A, B, new, C) → model class (`flagship`, `everyday`, `fast`, `unknown`) → Role order |
| standard | trusted for `standard` first → cost class → quality band → median time → Role order |
| routine | cost class → quality band → median time → Role order. Everyone not held counts as trusted for routine work. |

**Cost classes,** cheapest first:
1. `included`: a subscription whose 7-day window is reported and below the Save line;
2. `metered` at its expected dollars for this task, ascending, while at or under the Task ceiling;
3. `kept`: a subscription past the Save line, or one whose quota isn't reported;
4. `metered` above the Task ceiling;
5. `unknown`.

A Cursor subscription today reports no window, so it is `kept`. That is the rule that sends routine work to the key and keeps Cursor for harder work (owner decision 3).

**Expected cost of a metered Candidate:**
- With 5 or more outcomes in the Scorecard cell, the median recorded spend.
- Otherwise the catalog's latest dated price times a token prior for the size. The priors (input / output tokens):
  - S: 0.3M / 0.03M;
  - M: 1.5M / 0.1M;
  - L: 5M / 0.3M;
  - XL: 12M / 0.6M;
  - unknown: as M.
- The priors are placeholders (UNVERIFIED). PR 4 replaces them per cell from recorded runs. The `zai` route already prices leases from `modelUsage`.

For GLM-5.3, these priors give about $0.55 for S, $2.54 for M and $8.32 for L. With the default reserve of $5, the budget step (R18, 5) therefore keeps L and XL work off a metered key unless the Role's reserve is raised. The page says so beside the Task ceiling.

**Quality band,** from the Scorecard cell (section 7.2):
- A: at least 80% accepted first try, and at most 1.0 findings on average;
- B: at least 60% accepted first try;
- C: below 60%;
- new: fewer than 5 outcomes.

**No trusted Candidate available.** If the Candidates trusted for the Tier are all excluded, the best of the rest is picked, and the Reason says so ("no Candidate trusted for hard work is available: cursor is marked until 14:00"). Standing ranks; only `held` excludes. Auto must never leave a run with nothing when the plain chain would have run something (R24).

### 6.3 Fences: the option set

The decider chooses among acceptable options; it never decides what is acceptable. So before it is asked, three Fences narrow the eligible Candidates (R30):

| Fence | Removes | Why |
|---|---|---|
| (a) trust floor | A Candidate not trusted for the Tier, while one trusted for it is eligible. | A model new to this user earns harder work through Outcomes (R27), not through a model's opinion. |
| (b) Task ceiling | A metered Candidate expected to cost more than the Task ceiling, and one whose cost is unknown (a Connection in the engine layer's custody). | The ceiling is the principal's number (owner decision 2), and an unknown cost can't be shown to be under it. |
| (c) kept for harder work | On routine work, a kept subscription. | Owner decision 3: an unseen quota is saved for harder work. |

Then the rules pick is added back if a Fence removed it, so the decider can always agree with the rules. With fewer than two options left, no call is made (`one-option`): there is nothing to choose.

In practice the decider has a choice on routine work when two cheap options exist, and on standard and hard work when two or more Candidates are trusted for it. As more Candidates earn Standing, it has more to choose from.

### 6.4 The decision step

For one route, in order:
1. **Gather the slow facts**, outside any transaction: availability, the gate's dry run, Usage, the board and the diff.
2. **Rules and fences**, pure: `decide` gives the exclusions, the ranking and the rules pick on a snapshot of committed spend; `fence` gives the option set; `decisionInput` builds the input.
3. **The call**, when R29 allows it, the route's group and Tier is `acting`, and the route isn't in the holdout: lease on the decider's Connection (holder `decider`, reserve $0.01), open the key, and ask, all within one deadline, the timeout (1 s by default). The call happens outside the write transaction, so no lock is held during a network call. The Lease is closed as soon as the answer, or the deadline, arrives.
4. **Decide and save**, inside one SQLite write transaction (`BEGIN IMMEDIATE`): re-read each metered Candidate's committed spend, run `decide` and `fence` again, then `finalize` with the answer. If the decider's choice is no longer in the recomputed option set (a budget spent meanwhile, or a trusted Candidate eligible again, which brings back the trust floor), the rules pick acts with the reason `stale`. Both spend readings are stored, so a replay recomputes both option sets. Save the route with every input and the decider record. Two picks made together therefore see each other's committed spend (R18, step 5).
5. **Answer the chain.**
6. **In shadow**, after answering: the route is marked for a shadow call, and a detached job (`decider shadow rt-118`, started without waiting) leases, asks with the stored input under the same timeout, and appends the answer. The pick is already made, so shadow adds no latency, and an engine-layer hook that ends `route` at 2 s can't cut the call short. A holdout route while acting is asked the same way. A job that dies between grant and close leaves a $0.01 reservation open, as any interrupted Lease does (CN9); `decider report` lists such Leases.

**The threshold.** A choice acts at 0.80 or more on its entry in `probabilities`. 0.80 is a starting value, not a measured one. The vendor's advice is to set thresholds from labelled examples and the cost of each kind of error [P9]; section 11.6 does that from this user's Outcomes. The answer's `confidence` is stored for later study but decides nothing, because the docs don't say what it measures.

**The timeout.** 1 s by default, UNVERIFIED: the vendor publishes a relative speed, not a latency [P9]. PR 8 measures p50 and p95 and records them. The engine layer's router hook gives up at 2 s (section 8.5). So `route` has its own deadline of 1.8 s, and an acting call starts only if the timeout fits before it (R29, `late`).

### 6.5 Worked examples

**Table A: rules only, or one option.** The setup:
- Connections: `cursor` (subscription, reports no window), `glm` (Z.ai key, metered, budget $20, reserve $5), `claude` (subscription).
- The global Priority is `subscriptions-first` with Auto on.
- The Role `implement-backend` has Override `own` (mode `custom`, order `cursor, glm`) and its Auto switch on. So `claude` is outside its allowed set.
- Its Picks: `cursor:claude-sonnet-5.5@high` and `glm:glm-5.3@max`.
- Its risk Picks: `cursor:claude-opus-5.5@high` and `glm:glm-5.3@max`.
- Families from the per-model map: the `cursor` entries are `anthropic`; `glm` is `zai`.
- Auto was switched on with `cursor` first in both chains, so both `cursor` entries are trusted up to hard, and `glm` is on probation.
- Defaults: Task ceiling $3.00, Save line 50%, daily cap $10.
- The decider is in shadow, and the workspace is opted in.

| Task | Profile | Tier | Decision step | Auto pick and Reason |
|---|---|---|---|---|
| T-41 "docs: explain the retry flag" | docs (title), S (brief: 2 items, 1 path) | routine | Skipped, one option: `cursor` is fenced (kept, routine). | `glm:glm-5.3@max`. Cheapest for routine work: about $0.55 (price × S prior), under $3.00. `cursor` is kept for harder work: its quota isn't reported. |
| T-42 "Rework session expiry in the auth middleware", `--risk` | risk | hard | Skipped, one option: `glm` is fenced (trust floor). | `cursor:claude-opus-5.5@high` (risk chain). Trusted for hard work; `glm` is on probation (2 routine tasks so far; promotion needs 5). |
| T-43 "fix: off-by-one in pagination". A what-if, outside the timeline: `glm` has only $0.40 of its Budget left. | fix, S | routine | Skipped, one option: `glm` is excluded, and `cursor` is the rules pick. | `cursor:claude-sonnet-5.5@high`. `glm` is excluded (budget: about $0.55 expected, at most $0.40 left to reserve). |
| T-50 "Add CSV export to the orders page", a week later, after `glm` went 4 of 5 at routine | feature, M | standard | Ran, in shadow: `cursor` at 0.64. | `glm:glm-5.3@max`, by the rules. Trusted for standard work since T-48. About $2.54, under $3.00 and under the $5 reserve. `cursor` is kept for harder work. The decider's answer is recorded as a disagreement below the threshold. |
| T-51 "Fix the token refresh race in the auth client", `--risk`, while `cursor` is marked out of quota until 14:00 | risk, size unknown (M prior) | hard | Skipped, one option: only `glm` is eligible. | `glm:glm-5.3@max` (risk chain). No Candidate trusted for hard work is available: `cursor` is marked until 14:00. About $2.54, under the reserve. |

In each case, the run's chain is the pick followed by the other entry. A failure on the first falls to the second, as today. An L-size task on T-51's day would find `glm` excluded by budget ($8.32 against $5), and resolve the chain as today.

**Table B: the decider acting.** A later month. The Role `implement-ui` has the chain `claude:claude-sonnet-5.5@high` (subscription, reports a weekly window, now 35%), `glm:glm-5.3@high`, `cursor:claude-sonnet-5.5@high`. In the `implement` group, all three are trusted up to standard, and `claude` and `cursor` up to hard. The decider acts for routine and standard work in `implement`, after both passed the switch-on rule; hard work is still in shadow. The Scorecard at standard: `claude` 3 of 5 first try; `glm` 4 of 4, too few for a band or a recorded cost, and too few to be promoted to hard.

| Task | Tier | Option set | Rules pick | Decider answer | Auto pick and Reason |
|---|---|---|---|---|---|
| U-1 "fix: focus ring on the save button" | routine | `claude`, `glm` (`cursor` fenced: kept, routine) | `claude` (included) | `claude` at 0.93 | `claude`, by the decider at 0.93; the rules agree. |
| U-2 "Rework the settings form layout" | standard | `claude`, `glm`, `cursor` | `claude` (included before metered) | `glm` at 0.86 | `glm`, by the decider at 0.86 (threshold 0.80): its record here is 4 of 4 against 3 of 5, at about $2.54 (price × M prior). The rules would have picked `claude`. |
| U-3 "docs: update the theming guide" | routine | `claude`, `glm` | `claude` | `glm` at 0.62 | `claude`, by the rules: the decider's 0.62 is below 0.80. |
| U-4 a standard task whose route is in the holdout | standard | `claude`, `glm`, `cursor` | `claude` | `glm` at 0.88, recorded | `claude`, by the rules: holdout (one in five). |
| U-5 a standard task while the vendor is slow | standard | `claude`, `glm`, `cursor` | `claude` | none: timeout at 1 s | `claude`, by the rules: the decider was unavailable. |
| U-6 "Migrate the date picker to the new API", `--risk` | hard | `claude`, `cursor` (`glm` fenced: trust floor) | `claude` (Role order) | `cursor` at 0.55, recorded | `claude`, by the rules: hard work is in shadow. |

## 7. Outcomes, the Scorecard, and Standing

### 7.1 The Outcome record

One route id, many facts, each with its source:

| Fact | Source | How |
|---|---|---|
| ran (the entry that ran), fell back (yes, no) | `lease`, else `ledger` | `LeaseGranted` for a run that went through the gate with a route (see below); otherwise the engine layer's ledger row with the same route id (ask 2). A run that switched engines mid-task is `mixed` and counts toward no quality rate. |
| model reported | `lease` | The model in the session's init event, which the launcher already reads (ADR-0018 §8.3). A mismatch is a fact too. |
| cost (with its spend source), minutes | `lease` | The Lease's Spend and duration (CN10). No cost for runs in the engine layer's custody. |
| accepted first try, send-backs | `board` | The task reached done, moved by the manager or the principal (B3), with no move from review back to in progress after this route's run. Each such move counts one send-back. No done within 7 days of the pick gives `unknown`: counted for coverage, not in the rates. |
| findings, fix rounds | `review` | `morndo-connections outcome rt-118 --findings 2 --fix-rounds 1 --by rt-120`, called by the review step. `--by` names the reviewing run's route or lease. A fact whose reviewing run is the judged route's lane, or is unknown, is refused (R26). |
| overruled | `principal` | `outcome rt-118 --accepted no` from the CLI or the page, as a Command. |

Trust, highest first: `principal`, `review`, `board`, `lease`, `ledger`. A fact never comes from the judged run's own words (R26), and a decider answer is never a fact.

**What the launcher must record first** (PR 2, a change in Connections):
- **The route id.** `run` takes `--route ID`, else the `MORNDO_ROUTE` variable.
  - The engine layer's `bin` is called by the engine layer, not by the starter. Until ask 2 lands, the starter exports `MORNDO_ROUTE` in the lane's environment, and `run` inherits it.
  - A route id is not a secret.
  - Whether the engine layer passes the lane's environment to `bin` unchanged is UNVERIFIED. PR 2 checks it with a fake `bin` that prints its environment.
- **The model to run.** With a route, `run` takes the entry for its own Connection from the route's chain (the first such entry), and launches that model at that effort. It reserves the route's reserve. Without a route, it runs as today (the preset's default Pick).
- **The Lease keeps the route and the entry.** `LeaseClosed` gains `entry`, `model` (as reported) and `route`.
- **Facts land at once.** At grant, `run` appends the `ran` fact to the route. At close, it appends cost and minutes. Both happen in the same program and database, so no sweep is needed for them.
- **Several Leases per route.** An engine lane runs one `bin` per turn, so one route may hold several Leases. The Outcome sums their spend and minutes.
- **A stale variable doesn't join.** A Lease joins its route only while the lane's board task, when known, is the route's task. So a reused lane with an old variable doesn't credit the wrong pick.
- Without these, the `lease` facts have nothing to join on.

### 7.2 Storage and the Scorecard

- **Storage:** three tables in the connections database (`connections.db`), added by a `service-kit` migration.
  - `routes`: id, at, role, group, task, lane, workspace id, tier, pick, stage, rules pick, chain, inputs (JSON: profile, Candidates and their facts, settings, decider settings, cells used, the decider record, versions), reasons, exclusions, fences. Declined routes are stored too, with their reason, so a review run that wasn't auto-routed still has a route to name in `--by`.
  - `outcomes`: route, seq, at, kind, value, source. Append-only.
  - `standing`: Candidate, group, level, pinned, and its StandingChanged rows.
  - Routes and Outcomes are kept for 180 days. A replay reads only the route's own `inputs`, so it works for as long as the route is kept.
- **Scorecard:** computed on read from `outcomes`.
  - The cells are per entry that ran, role group and Tier.
  - The window is the last 90 days, at most the last 20 outcomes per cell.
  - Per cell: n, accepted first try (as "k of n"), mean findings, mean fix rounds, median cost with its sources, median minutes, fell-back count, and model mismatches.
  - At this scale (hundreds of rows) reading is cheaper than caching. The cells a pick used are copied into its `inputs`.

### 7.3 Standing rules (`rules-v1`)

They are evaluated when an Outcome lands in a cell, and the result is persisted (R27).

| Move | When |
|---|---|
| Start | Auto first applies to a Role: the first entry of its chain, and of its risk chain, is trusted up to `hard` in the Role's group. Across the Roles of one group the higher start wins, and a later Role never lowers a level already set. Every other Candidate, and any that joins later, is on probation (trusted up to `routine`). Any of them can be changed in the same Command. |
| Promote one Tier | At its highest trusted Tier T: at least 5 outcomes, 4 of the last 5 accepted first try, and none of those 5 took 3 or more fix rounds. Then it is trusted for the next Tier up. |
| Demote | 3 of its last 5 outcomes at some Tier T not accepted first try (sent back at least once). Then it is trusted only up to the Tier below T. Failing at `routine` makes it `held`. |
| Held | Excluded from Auto picks; still in the chain as a fallback. It stays held until the principal releases it. Time and an aging window don't release it. |
| Pin | The principal sets a level. Automatic moves stop for that Candidate and group. The Scorecard still shows what they would have done. |

Alerts and events (R27) say which way it moved, and why, in "k of n" words.

### 7.4 What the Scorecard feeds

1. **The rules:** quality bands and recorded medians in ranking (section 6.2), and Standing moves (section 7.3).
2. **The decider:** each option's record in the decision input (k of n first try, mean findings, median minutes) and its expected cost, which comes from the cell's median once it has 5 outcomes (section 5.4).
3. **The evaluation:** each route stores which stage decided, so Outcomes can be split by stage, and by agreement or disagreement, for the decider report (section 11).

Standing counts every Outcome of a Candidate, whichever stage picked it: the Candidate did the work either way.

## 8. Ports, adapters, and the engine layer

### 8.1 Application

`apps/connections/src/application/router-service.ts`:
- `route(request)`: build the profile, gather the Candidates, run the rules, fence, ask the decider when R29 allows it, finalize, store the route, answer the chain (section 6.4);
- `why(id)` and `replay(id)`;
- `recordOutcome(route, fact)`, which applies R27's moves;
- `sweep()`: join board moves and the engine layer's ledger rows to routes. The launcher appends lease facts itself (section 7.1);
- `preview(role)`: a synthetic profile per Tier, for the page;
- `scorecards(group?)`;
- `deciderReport(group?, tier?)` and `checkSwitches()`: the switch-on proposals and the automatic switch-back (section 11), run after each Outcome lands and once a day.

It reads `RoutingService`'s policy and `ConnectionsService`'s directory. It never writes a chain, an order or a Pick (R25).

### 8.2 Ports

New and extended ports, in `apps/connections/src/application/ports.ts`.

| Port | Application side | Adapter |
|---|---|---|
| `TaskSource` | `task(key)` and `laneTask(lane)`: title and description (in memory only), priority, status, and moves with their actor kinds. | `board-cli`: runs `morndo-board show KEY --json` (or `list --mine` with `MORNDO_LANE`) under the lane's agent token. With no hub or no token, no board signals: the defaults apply. |
| `RepoInspector` (extended) | `inspect(path)` as today, plus `diffStat(path, base)`, `branch(path)` and `manifests(path)`. | `git` and `realpath`. |
| `UsageReader` | `windows(connection)`: the 5-hour and 7-day shares, or null. | `usage-file`, which exists. |
| `EngineSettings` (extended) | As today, plus `providers()`: availability rows from `providers --json`; `otherProvider(role)` from `get --json`; and registration with `family_by_model` instead of a fixed family. The map lists the preset's patterns in order, router models as `unknown`, and last `*` as the preset's own family. The engine layer takes the first pattern that matches, so a model with no pattern keeps the preset's family, as today. | The engines CLI. Never `resolve`, so the router hook can't loop. |
| `Ledger` | `implementers(repo, branch)` and `ran(route)`. | `engines implementers --repo --branch --json`, and the ledger row's route id once ask 2 lands. |
| `RouteStore` | `decideAndSave(facts, answer, finalize)`: one write transaction that re-reads committed spend, runs the pure `decide` and `finalize`, and saves the route (section 6.4). Also `get(id)`, `byTask(key)`, `append(route, fact)`, `appendShadow(route, answer)`, `facts(before)`. | SQLite, in the connections database. |
| `StandingStore` | `levels(group)`, `apply(change)`. | SQLite, in the same database. |
| `DecisionPort` (new) | Section 8.3. | `rules`, `openai-decisions`, later `local-model`. |
| `Catalog` (extended) | Presets as today, plus a per-model family map in the `VendorPreset` schema (`families`: ordered model patterns to a family, router models to `unknown`), a per-model `class`, and a decisions preset (section 8.3). A model no pattern matches keeps the preset's `family`, and class `unknown`. | `catalog-file`. |
| `Clock`, `AlertSink` | As today. | As today. |

### 8.3 The decision port and its adapters

```ts
// apps/connections/src/application/ports.ts (sketch)
export interface DecisionPort {
  readonly id: string;                 // "rules", "openai-decisions:<connection>", "local-model"
  readonly leavesNode: boolean;        // true: R29 requires an opted-in workspace
  ask(input: DecisionInput, question: QuestionVersion, timeoutMs: number): Promise<DecisionAnswer>;
}
```

| Adapter | What it does | Leaves the node | Cost | When |
|---|---|---|---|---|
| `rules` | Answers the escape value `rules` with probability 1: "let the rules decide". It needs nothing it can't see, since the input holds neither the rules pick nor the Role's order. Free and instant. It runs when no other adapter is set, and it is the test double. It never disagrees, so it never passes the switch-on rule. | No | none | PR 7 |
| `openai-decisions` | `POST /v1/decisions` with one `choice` question: the values are the option ids plus `rules`; the descriptions carry each option's features (section 5.4). The base URL follows the region: `https://api.openai.com/v1`, `https://us.api.openai.com/v1` or `https://eu.api.openai.com/v1` [P13]. Reads `choice`, `probabilities`, `confidence` and `usage`. A refusal maps to `refused`; a 4xx, 5xx, 429, timeout, or an answer that fails the schema maps to `unavailable`. The key is opened only after the Lease (ADR-0018). The client is the official `openai` npm package (7.30.0 or later [P9]; 7.32.0 on the registry, 2026-10-11) or plain `fetch` against the documented endpoint, chosen and checked live in PR 8. | Yes, opted-in workspaces only | input tokens only (section 10.5) | PR 8 |
| `local-model` | A small model on the node behind the same port. Because nothing leaves the node, it may also read the title and description in memory to judge the task better; it still stores only what R23 allows. One way to serve it: LiteLLM documents self-hosted decision models (vLLM, `choice` questions only) behind the same `/v1/decisions` format [P15]. | No | local compute | Later. Quality UNVERIFIED |

**The decisions preset.** A catalog preset `openai-decisions`: vendor OpenAI, dialect `decisions`, model `gpt-6-luna`, price dated 2026-10-11 ($0.10 per 1M input tokens; no output, cache-read or cache-write charge [P9]), regional uplift 10% [P12], no isolation needed, since nothing runs in a workspace. The decider's Connection is an ordinary API-key Connection made from it, with its own Budget, repo list and terms (ADR-0018). So CN8 applies to decider Leases unchanged.

The port is generic: the uses in section 16 reuse it with their own question and input builder, each with its own allowlist.

### 8.4 Inbound adapters

- **The CLI** (section 9.2).
- **The page:** the `page` JSON gains an `auto` part, and `apply` gains the commands `auto`, `trust`, `decider` and a Role's `auto` field. The hub runs the program, as it does today. Its step-up decision comes from the program's effect check (R28), not from the command's kind.
- **The engine layer's router hook,** once it exists (ask 1).

### 8.5 The engine layer: two additive asks, and the way until then

1. **A `router` setting.** When set, `engines resolve ROLE` and the lane starter's `--engine auto` call it:
   - The call: `ROUTER --role R [--risk] --cwd D [--task T] [--lane L] [--implementer E,…]`, with a 2-second timeout.
   - The answer, one JSON line: `{"route":"rt-118","auto":true,"chain":["glm:glm-5.3@max","cursor:claude-sonnet-5.5@high"]}`.
   - The engine layer refuses an entry outside the Role's chain (R17, checked on both sides), then applies its own availability and family checks over that order.
   - On a timeout, a non-zero exit or a refusal, it resolves the Role's chain as today and logs why.
2. **`--route ID` to `bin`,** beside ADR-0018's `--role` and `--lane`, and the route id in its ledger row. This joins the Lease and the Outcome to the pick.

The engine layer's mid-task switch needs no change. It takes the first available entry of the Role's chain other than the current one, scanning from the top. That is the run's chain without the pick, in the Role's order (R24).

Until ask 1 lands, whoever starts a run calls `route` and passes the pick on:
- `--engine`, `--model`, `--effort` and `--role` to the engine layer;
- `MORNDO_ROUTE` in the lane's environment, which `run` reads (section 7.1).

Headless runs (reviews, fixes, background jobs) call `morndo-connections run` themselves, so they pass `--route` directly. When the fleet's `lane.start` op learns to start engine lanes, it calls `RouterService` directly.

## 9. The settings page and the CLI

### 9.1 The page (extends the LLM connections page, ADR-0018 §11)

**Priority section:**
- At the top, the switch **Auto: Morndo picks per task, among each Role's chain, and says why**. The five modes stay below it, and the order list reads **Fallback order** while Auto is on.
- **Auto settings:**
  - Task ceiling: "$3.00 per task";
  - Save line: "keep a subscription for harder work once its weekly window passes 50%";
  - Daily cap per metered key: "glm: $10.00";
  - Reserve per Role: "$5.00", with the note "With a $5 reserve, Auto keeps large tasks off metered keys".
- **Decider** (under Auto settings):
  - **Off** or **On**. When on, each role group and Tier reads **Shadow: asks and records, never acts**, or **Acting**, with one switch each. A switch that the switch-on rule doesn't allow yet reads, for example, "Needs 12 more shadow decisions with outcomes" or "No lift yet: the rules did as well when it disagreed".
  - Decider: "Rules only (free, on this machine)" or a vendor Connection, for example "OpenAI Decisions · key `decide`".
  - Where the vendor processes it: Global, United States, or Europe, with the note "Europe needs your vendor account approved for it; Morndo can't see that, and Check shows the vendor's answer".
  - Workspaces that may send a task profile: none by default, each with a switch. The note says what is sent and what never is (section 5.4).
  - Threshold: "Acts at 80% or more".
  - Daily budget: "$0.25 a day", with today's spend.
  - **Shadow report:** per group and Tier, the numbers of section 11.2.
- Turning Auto on shows the Roles it will cover, each with its Auto switch, and each Candidate's starting Standing in words, with a choice to change each. It also states that no chain changes.
- Saving asks for the passkey (R28).

**Each Role card** gains:
- **Auto: On / Off**, defaulting to On for the `implement` Roles and Off for the rest. Off reads "the chain runs in order".
- **"Auto picks"**: one line per Tier, from `preview(role)`, for example:
  - "Routine: glm:glm-5.3@max, because it is the cheapest (about $0.55, under $3.00); cursor is kept for harder work (its quota isn't reported)."
  - "Hard: cursor:claude-opus-5.5@high, because it is trusted for hard work; glm is on probation (2 routine tasks so far, 5 needed)."
- **"Last picks"**: the latest five, each a row such as "U-2 · feature, M · glm · decider 86% · accepted first try · $2.31" or "T-41 · docs, S · glm · rules · accepted first try · $0.41". A row opens the Why sheet, with the same content as `why`.
- **"Scorecard"**: one row per Candidate, with:
  - its Standing in words ("Trusted for hard work", "Trusted up to standard work", "On probation", "Held");
  - k of n accepted first try, per Tier;
  - median cost and median minutes;
  - **Trust** and **Hold**.
- A Role that isn't routed says why:
  - `hand`: "Hand: Auto doesn't route this Role. Its chain runs as you set it."
  - drifted: "Changed outside Morndo: Auto waits until you re-apply or keep it as hand."

**Phone:** the same page in `phone.css`, one 46rem column on wide screens, as ADR-0013. The Why sheet opens over the page, and long reasons wrap. Levels are always words, never colour alone.

**Words:** every string the page and the CLI share sits in one table, `CONNECTION_WORDS.auto` in `packages/protocol`, and a test keeps both on it.

### 9.2 The CLI

```
morndo-connections priority auto on                          # Auto on for the global Priority; chains unchanged
morndo-connections role implement-backend own custom cursor glm
morndo-connections role plan auto off                        # plan's chain runs in order
morndo-connections auto show
morndo-connections auto set task-ceiling 3.00
morndo-connections auto set save-line 50
morndo-connections auto set daily-cap glm 10.00
morndo-connections auto set reserve implement-backend 5.00
morndo-connections route --role implement-backend --task T-41 --workspace . [--risk] [--size S] [--kind docs] [--round 1] [--implementer E] [--brief-file F] [--json]
morndo-connections why rt-118 [--replay] [--json]            # also: why T-41 (its latest pick)
morndo-connections outcome rt-118 --findings 0 --fix-rounds 0 --by rt-120 [--accepted yes|no]
morndo-connections scorecard [GROUP] [--json]
morndo-connections trust glm:glm-5.3@max --group implement --up-to standard|hard|routine|held|auto
morndo-connections decider show
morndo-connections decider use rules | openai-decisions --connection decide [--region global|us|eu]
morndo-connections decider on|off                           # on: shadow everywhere until a group and Tier acts
morndo-connections decider act implement routine|standard|hard on|off   # on only where the switch-on rule holds
morndo-connections decider workspace add|remove [PATH]
morndo-connections decider set threshold 0.80
morndo-connections decider set budget 0.25
morndo-connections decider check                             # one synthetic call; shows the answer or the vendor's error
morndo-connections decider report [GROUP] [--tier T] [--since 30d] [--json]
morndo-connections decider shadow rt-118                     # internal: the detached shadow call for one route
```

- `route` exits 0 with an answer, auto or not (`"auto":false,"reason":"hand"`).
- It exits 1 when it can't answer. The caller then resolves as today (R24).
- Every change R28 calls widening asks for a typed confirmation at the machine, with no `--yes` (CN13's terminal path). That covers:
  - `priority auto on|off` and `role … auto on|off`;
  - a raised ceiling, cap or reserve;
  - a Save line change;
  - `trust` upward or `auto`;
  - a hold or lower pin whose work could move to a key;
  - `decider use`, `decider on`, `decider act … on`, `decider workspace add`, a lower threshold, a raised budget.
- `route` takes the lane from `--lane`, else `MORNDO_LANE`, and stores it on the route.
- `decider check` sends a fixed synthetic input, never a real task.

What `why` prints:

```
rt-131  U-2  implement-ui  2026-11-12 10:02
Profile  kind feature (title) · size M (brief: 4 items, 3 paths) · risk no · round 1 · priority normal → standard (default)
Rules    claude:claude-sonnet-5.5@high: trusted for standard work, included (weekly window 35%)
Decider  openai-decisions · acting · o2 = glm:glm-5.3@high at 0.86 (threshold 0.80) · confidence 0.81 · 412 tokens · $0.00004 · 610 ms
Pick     glm:glm-5.3@high, by the decider; the rules would have picked claude
Ranked   by the rules: 1. claude:claude-sonnet-5.5@high  2. glm:glm-5.3@high  3. cursor:claude-sonnet-5.5@high
Chain    glm:glm-5.3@high → claude:claude-sonnet-5.5@high → cursor:claude-sonnet-5.5@high
Inputs   policy v44 · rules-v1 · decider-v1 · ceiling $3.00 · save line 50% · cells 3 · profile 9f2c41ab07de · replay: same pick
Outcome  ran glm:glm-5.3@high · accepted first try · 0 findings · $2.31 (estimate) · 17 min
```

## 10. Privacy, cost, and the log

### 10.1 What leaves the machine

Only the decision input of section 5.4, only for an opted-in workspace, and only through an adapter that leaves the node. The allowlist is a schema in `packages/protocol`, and a test fails if a field outside it reaches the adapter (section 13). Connection names are left out because they are the user's labels; model ids are sent because they are the vendor's public catalog names, and they let the decider bring what it knows about a model.

Profile fields still say something: which languages a workspace uses, how much work it gets, when, and of what kind. That is the exposure the opt-in accepts.

Text in a task can't steer the decider, because no task text is sent. A model's general reputation can still pull the decider toward names it knows; each option's record on this user's work sits beside it, and the instructions ask the decider to prefer the record.

### 10.2 Opt-in per workspace

- None by default. The principal adds workspaces one by one (R28: adding widens).
- The decider Connection's repo list must also admit the workspace (CN8). Both must say yes.
- The page lists workspaces by path, read on the node; the settings store their ids only.
- A workspace that isn't opted in still gets the rules, and, with a local adapter, the decider.

### 10.3 Where the vendor processes it

From [P13] and [P9], read 2026-10-11:
- `/v1/decisions` data isn't used for training. Abuse-monitoring logs are kept up to 30 days by default. Eligible customers can use Zero Data Retention. Prompt caching may keep encrypted key/value tensors on GPU-local storage for up to 24 hours.
- Regional processing is available in the United States and in Europe (EEA + Switzerland), per project or per request through the regional domain.
- Data residency, US included, starts with an eligibility check through the vendor's sales team. Any non-US region also needs the vendor's approval for abuse-monitoring controls and a Modified Retention amendment. The regional endpoints cost 10% more [P12].
- System data (account, metadata, usage) may be processed outside the region.

Morndo's part:
- The `region` setting picks the base URL (section 8.3).
- Morndo can't see the account's approvals. `decider check` makes one synthetic call to the chosen region and shows the vendor's answer or error, word for word.
- The docs are rechecked when the API leaves beta (section 17).

### 10.4 The decision log

Every decision step, run or skipped, is stored in its route before the chain is answered (R22), or appended right after for shadow and holdout:
- the adapter and its version, the mode, the threshold, the holdout verdict;
- the option set, the id map, and each Fence;
- the decision input as sent (it holds nothing R32 forbids, so it can be kept whole);
- the answer as received: the choice, every probability, `confidence`, a refusal, or the error class;
- the model reported, `usage.input_tokens`, cost, milliseconds;
- the stage that decided, and why.

Kept 180 days, like routes. No key, token or secret is ever in it. A pick replays from it without a call (R22). One log line per decision, through the shared redactor (section 12).

### 10.5 Cost and the decider budget

- **Price** [P9, P12], read 2026-10-11: $0.10 per 1M input tokens; no output, cache-read or cache-write charge; plus 10% on a regional endpoint.
- **Per decision:** `usage.input_tokens` × the catalog's dated price × the regional factor. The request in section 5.4 is about 400 to 600 tokens, so a decision costs about $0.00005 (estimate; measured from `usage` once it runs). Even at 2,000 tokens it is $0.0002.
- **Each call leases** on the decider's Connection: holder `decider`, the route's workspace, reserve $0.01. The cost lands as run spend on that Connection (CN10), so its Budget stays true, and the gate's checks (on, terms, expiry, repo list, budget) apply as for any key.
- **The decider budget:** $0.25 a day per node by default (owner decision 6), across all uses of the port. At the estimate above that is about 5,000 decisions; at a pessimistic $0.0001, about 2,500. Before each call, R29 checks the day's decider spend plus the call's expected cost. Over it, the rules decide until the next day, and an Alert says so once.

## 11. Evaluation: shadow first, then acting, and the way back

### 11.1 Modes

- **Off:** no calls. The rules decide. The default.
- **Shadow:** once the decider is on, every group and Tier not acting. Every route that R29 allows is asked after the pick (section 6.4, step 6). The rules always act. This is how the decider starts.
- **Acting,** per role group and Tier, switched on one by one: the decider's choice acts under R31. One route in five is held out and decided by the rules, so the comparison never stops.

Order: routine first, then standard, then hard. Hard work goes acting only where the trust floor leaves two or more options.

### 11.2 What shadow measures

Per role group and Tier, over answered decisions with an Outcome:
- **Answer rate:** choices over calls; refusals, errors and timeouts counted apart.
- **Agreement:** the decider's choice equals the rules pick, overall and at or above the threshold.
- **Escape rate:** how often it chose `rules`.
- **Lift on disagreement:** the send-back rate of the rules pick on confident disagreements (the decider chose another option at or above the threshold), minus its send-back rate on agreements (the decider chose the rules pick, at any probability). Escapes and disagreements below the threshold are left out. In shadow only the rules pick ran, so this is the measurable question: when the decider says the rules pick is wrong, is it wrong more often? It says nothing about how the decider's own choice would have done; only acting, against the holdout, measures that (section 11.4).
- **Calibration:** per probability band (0.5–0.6, …, 0.9–1.0), the count, the agreement, and the rules pick's Outcomes.
- **Cost and latency:** spend per day and per decision; p50 and p95 milliseconds.

### 11.3 The switch-on rule

Morndo proposes acting for a group and Tier when all of these hold, and the principal confirms with step-up (R33):
1. At least 30 shadow decisions with Outcomes, over at least 7 days.
2. Answer rate at least 95%, and p95 latency within the timeout.
3. At least 8 confident disagreements, with at least 3 send-backs of the rules pick among them, and a lift of at least 15 points. The send-back floor keeps two unlucky tasks from passing the rule.
4. No option outside the offered set, and no replay mismatch.

If agreement is 95% or more, the decider adds cost and no choice; Morndo says "no lift" and proposes leaving it in shadow or off. If shadow shows no lift at all, the rules are the product.

### 11.4 What acting measures

Per group and Tier, the decider's acting picks against the holdout and the rules' own record from the 30 days before acting began: first try accepted, send-backs, findings, fix rounds, and cost per accepted task. These are the same Outcomes the Scorecard uses, split by stage (section 7.4).

### 11.5 The switch-back rule

A group and Tier goes back to shadow automatically, with an Alert, when any of these fires:
1. **Quality:** over its last 10 acting picks with an Outcome, first try accepted is 20 or more points below the baseline (the holdout plus the 30 days before acting, at least 10 Outcomes). For example, 5 of 10 against a baseline of 75%.
2. **Reliability:** an answer rate below 90% over the last 20 calls, or a p95 latency above the timeout over a day.
3. **Integrity:** a replay mismatch, a choice outside the offered set, or an answer that fails the schema.
4. **Cost:** the decider budget ran out on 3 days in a row.
5. **Vendor change:** the model reported differs from the preset's, or the decider Connection's terms change (TermsChanged).

Back in shadow it keeps measuring. Acting again needs the switch-on rule again. The principal can switch back at any time in one tap (narrowing).

### 11.6 Setting the threshold

The vendor's advice is to set thresholds from labelled examples and the cost of each kind of error [P9]. Here the labels are Outcomes. The report shows, for each threshold from 0.60 to 0.95 in steps of 0.05, how many shadow decisions would have acted, how many of those disagreed, and how the rules pick did on them. A new threshold is a Command (lowering widens, R28) and a new decider version recorded with each later pick. The default stays 0.80 until the report supports another.

## 12. Observability

- **One log line per decision,** naming its cause, as [P7] does:
  `auto rt-131 role=implement-ui tier=standard pick=glm:glm-5.3@high by=decider p=0.86 rules=claude:claude-sonnet-5.5@high excluded=0 fenced=0 ms=640`.
  It carries no text from the task, and it goes through the shared redactor like every log.
- **`morndo-connections log --routes [--since 7d]`:**
  - picks per Candidate, Tier and stage;
  - the share of picks that fell back (a pick the gate or the runtime refused means stale inputs);
  - Outcome coverage: the share of picks with an Outcome within 7 days;
  - a replay check of the last 50 picks;
  - size agreement: the estimated size against the diff at acceptance;
  - Auto's committed spend per metered key per day, against its cap;
  - `route` latency at p50 and p95. Without the decider acting the target is under 300 ms at p95; with it, under 1.5 s, and never past `route`'s own deadline of 1.8 s. The engine layer gives up at 2 s.
- **`decider report`:** section 11's numbers per group and Tier, and the decider's spend against its budget.
- **Alerts** (the existing `AlertSink`, later the fleet's Alert kind):
  - StandingChanged;
  - a Candidate held;
  - ReplayMismatch, always;
  - three or more fall-backs after picks of one Candidate within an hour;
  - none eligible, three or more times in a day for one Role;
  - a `review` fact refused for its source;
  - the decider switched back, and why;
  - the decider budget spent for the day;
  - a switch-on proposal ready for a group and Tier.
- **The page** shows the last picks per Role, the Scorecard, Standing and the decider report. Every number on it can be traced to `why`, `outcomes`, `standing` and the decider records.

## 13. Test plan

**Domain** (`packages/domain/test/auto-routing.test.ts`, with a fake clock). One negative-control history per invariant:

| Invariant | Test, and the control that must fail it |
|---|---|
| R16 | Auto off, a Role switched off, `hand` and drifted each answer "not auto" with their reason, and no decision step runs. An `own` Role follows the global switch and its Role switch. Turning Auto on leaves every derived chain byte-equal under each of the five modes. Control: a `hand` Role that gets a pick. |
| R17 | Every pick and chain entry is in the derived chain, whichever stage decided; a risk run uses the risk chain. Control: a Candidate list with an outside entry. |
| R18 | One case per exclusion step, in order, with the first reason only. A router model is excluded as `unknown`. A gate refusal for a repo-denied workspace excludes. An expected cost above the $5 reservation excludes. Two picks within a minute that together pass the daily cap: the second is excluded. A window at 90% excludes. Control: Usage admitting a gate-refused Candidate. |
| R19 | With the per-model map, `cursor:claude-sonnet-5.5` is `anthropic`, so a `claude` reviewer is excluded for it. A model no pattern matches keeps its preset's family, not `unknown`. A `zai` implementer excludes a `zai` reviewer. An implementer that would leave a one-family `review` chain empty is excluded. Control: the rule off; nothing is excluded. |
| R20 | A table over every row of `rules-v1`, including unknown signals. Control: risk with size S, which is still `hard`. |
| R21 | Each Tier's key, term by term, including model class after the band for `hard`. Shuffled Candidates give the same pick. The rules pick exists when the decider acts. Control: a key that ignores the Role's order on a tie. |
| R22 | A property test: random inputs and recorded answers, picked twice and replayed from the stored inputs, give equal picks, also after the Task ceiling and the threshold change and the Outcomes age out. A replay makes no decider call (the fake port counts calls). Control: a `Math.random` planted in a test double, which the replay test catches. |
| R23 | Every pick has a Reason naming its stage; every exclusion and Fence has one. The Reason schema refuses free strings above 64 characters. Control: a title smuggled into a Reason. |
| R24 | The chain is the pick, then the rest in Role order, for both stages. None eligible gives "resolve as today". A decider that throws, refuses or times out leaves the rules pick. Control: a chain that drops a fallback. |
| R25 | `decide`, `finalize` and `RouterService.route` leave the policy's chains and the fake engines settings byte-equal. Control: a pick that marks a provider. |
| R26 | Facts are append-only, with source precedence, and `unknown` after 7 days. A lane's STATUS line is refused as a source, and so is a decider answer. A `review` fact is refused when it comes from the judged lane, lacks `--by`, or either route has no lane. A route without `ran` doesn't count as a round. A Lease whose lane now holds another board task doesn't join an old route. Control: an `estimate` that lowers a `provider` cost. |
| R27 | Histories: promote after 4 of 5; demote after 3 of 5; held at routine; a pin stops both. A held Candidate stays held after 120 days without Outcomes. Two `implement-*` Roles with different first entries both start trusted, and a later Role doesn't lower either. A decider choice moves no Standing. Control: a promotion at 3 of 5. |
| R28 | Each setting change, judged by effect. Auto off for a Role whose plain order starts on a key needs step-up. Holding `cursor` where `glm` shares the chain needs step-up. Holding `glm` alone needs only a session, as does a lower cap. Adding a workspace to the opt-in, lowering the threshold and `decider act … on` need step-up; acting to shadow and removing a workspace don't. Control: raising the ceiling without step-up. |
| R29 | One case per skip reason: off, not opted in, one option, over budget, gate refused, late; an error and a timeout give `unavailable`, a refusal gives `refused`, and the rules pick acts in each. A slow Lease or key counts against the same 1 s deadline. A local adapter runs for a workspace that isn't opted in. Control: a vendor call for a workspace outside the opt-in. |
| R30 | The trust floor removes a probation Candidate on standard work while a trusted one is eligible, and doesn't when none is. The Task ceiling removes a metered option above it and an option of unknown cost. Routine work removes a kept subscription. The rules pick is added back when fenced. Control: a decider choice of a fenced Candidate that acts. |
| R31 | A table over every condition: shadow, holdout, escape, below threshold, at the threshold exactly, refusal, outside the set, stale after a budget change inside the transaction, and stale when a closed Lease makes a trusted Candidate eligible again and the trust floor fences the chosen one. Only the all-true row lets the decider act. Control: acting on `confidence` instead of the chosen option's probability. |
| R32 | The input builder, fed a profile whose title, description, brief, branch, lane, task key, paths and Connection names each carry a unique marker string, produces an input in which no marker appears; the schema refuses an extra field. Control: an input builder that copies the title. |
| R33 | With the decider on, every group and Tier not acting is in shadow. `acting` is refused where the switch-on numbers don't hold, and accepted with them stored. Each switch-back trigger fires on its own history. The holdout picks the same routes on every run, about one in five over 10,000 ids. Control: a switch to acting with 29 shadow decisions. |

**Architecture:**
- `packages/domain/test/architecture.test.ts` also forbids `Math.random` in `auto-routing.ts`.
- `no-vendor-names` covers the new module, `router-service.ts` and the decision port; vendor names live in adapters and the catalog only.
- The protocol's wire allowlists cover `AutoPickView`, the page's `auto` part, the catalog's `families` and `class`, and the decision input schema.

**Application** (`apps/connections/test/router.test.ts`, with fakes):
- `route` stores its inputs and the decider record before answering;
- `why --replay`, with no call to the port;
- `run` with a route (flag or `MORNDO_ROUTE`) launches the route's entry for its Connection, reserves the route's reserve, and appends `ran` at grant and cost at close;
- `sweep` joins board moves and ledger rows;
- `outcome` from the review step, with `--by`;
- a TaskSource that fails gives the defaults, not an error;
- `publishOwned` registers `family_by_model` with `*` last as the preset's family;
- two `route` calls racing on one key's daily cap: the second sees the first's pending cost;
- a shadow answer is appended after the chain is answered and changes nothing;
- a decider Lease is taken before the key is opened, its spend lands on the decider Connection, and the decider budget stops calls when spent.

**Adapter contract** (`apps/connections/test/decisions-adapter.test.ts`), against a fake decisions server:
- the request body matches the documented shape [P10]: `model`, a string `input`, one `choice` question with unique values including `rules`;
- the body holds nothing outside the allowlist;
- a `refusal` answer, a 429, a 500, a slow answer past the timeout, an unknown answer type and a missing `probabilities` each map to `refused` or `unavailable`;
- the region picks the base URL.

The same file runs one live call against the vendor when a decisions key is configured for tests, outside CI. A run without it reports the live case as skipped, never as passed.

**Contract test of the resolver** (`apps/connections/test/router-contract.test.ts`), against the fake engines CLI that the hub's tests use, extended:
- the answer's chain is a subset of `get --json` for the Role, risk included;
- Morndo's family exclusion agrees with `resolve --implementer` on the same settings, including a Claude model inside Cursor;
- `route` never calls `resolve`;
- with the hook fixture, a router that exits 1, or takes 3 s, leaves `resolve` choosing as today.

The same file runs against the real engines CLI when `ENGINES_BIN` is set, outside CI (as `e2e:engines`). A run without it reports the real-CLI cases as skipped, never as passed.

**CLI** (`apps/connections/test/auto-cli.test.ts`): `priority auto on|off`, `role … auto off`, `auto set`, `route --json`, `why --replay`, `outcome --by`, `scorecard`, `trust`, every `decider` command, and the typed confirmation on every widening change.

**End to end** (`e2e/auto-routing.e2e.ts`, `npm run e2e:auto`):
- **Setup:** the hub, the web app and the connections program on a scratch HOME and random ports, with the fake engines CLI, a `cursor` subscription with a fake runtime, a `glm` key on a fake vendor, and a decisions Connection on the fake decisions server.
- **Steps:**
  1. Open the LLM connections page, turn Auto on, and save with the virtual authenticator's step-up. `engines get` shows the same chains as before.
  2. The `implement-backend` card shows "Auto picks": routine → `glm`, hard → `cursor`.
  3. Run `route` for T-1 ("docs: …", S) and for T-2 (`--risk`). The picks are `glm` and `cursor`.
  4. Reload. "Last picks" shows both, with their reasons. Opening T-1's row shows what `why rt-1` prints.
  5. Set the Role to Hand. `route` answers "not auto" and the card says so.
  6. Turn the decider to Shadow and opt the scratch workspace in. Route a standard task with two trusted options: the fake server receives one request, the pick is the rules pick, and `why` shows the shadow answer.
  7. With seeded shadow history that passes the switch-on rule, turn acting on for standard work. On a route the test first checks is outside the holdout, the fake server answers the other option at 0.9: the pick changes and `why` says "by the decider". At 0.7 it doesn't.
  8. Seed 10 acting Outcomes far below the baseline: the group switches back to shadow, and an Alert shows.

## 14. Manual QA checklist

Recorded outside this tree, with screenshots.

**Desktop:**
1. Install from the branch build on a scratch HOME. Add `cursor` (subscription) and `glm` (Z.ai key, budget $20) and acknowledge their terms. `morndo-connections check` passes for both.
2. On the LLM connections page, the Priority section shows the Auto switch above the five modes. Turning it on lists the Roles it covers and the starting Standings (`cursor` trusted, `glm` on probation), and says no chain changes. Save asks for the passkey. `engines get` shows the same chains as before.
3. The `implement-*` cards show "Auto picks" for each Tier, with reasons. The `plan` and `review` cards show "Auto: Off".
4. *(From PR 6, through the lane starter's `--engine auto`; before it, through `route` and `--engine` by hand.)* Start two real tasks: a small docs task and a risk-area change. They start on `glm` and `cursor` respectively. Each run's route links to its board task, and `why` for each matches the card's "Last picks".
5. Lower `glm`'s budget below a task's expected cost. The next routine task picks `cursor`, with the Reason "glm: budget".
6. Turn Auto off for `implement-ui`: its card says the chain runs in order, and `route` answers `role-off`. Set `implement-backend` to Hand: the card says Auto doesn't route it. Edit a derived Role's chain with `engines set`: its card says Auto waits.
7. Hold `glm` from the Scorecard. The next routine task picks `cursor`, and an Alert shows. Release it, which asks for the passkey.
8. `why rt-N --replay` says "same pick" for every pick of the session, also after the Task ceiling was changed.
9. Keyboard only: every control is reachable and labelled. Standings and levels read as words. Run the contrast check.
10. *(From PR 8.)* Add a decisions key, set the decider to Shadow, and opt in one scratch workspace. `decider check` shows a synthetic answer. Route a standard task whose title holds a unique marker word. The route's stored input and the log hold no trace of the marker; `why` shows the shadow answer and the rules pick.
11. *(From PR 8.)* Set the decider budget to $0.0001. The next route says "over budget", the rules decide, and one Alert shows. Cut the network: the next route says "unavailable" and starts on the rules pick without waiting past the timeout.
12. *(From PR 9, with seeded history.)* Turn acting on for one group and Tier: the passkey is asked, and the switch-on numbers show. A route the decider wins says so on the card. Turning it back to shadow asks for no passkey.

**Phone** (the settings sheet → LLM connections, at 390 px width):

13. Turn Auto on and save with the passkey. The cards sit in one column, with no sideways scrolling.
14. "Auto picks", "Last picks" and the decider block wrap and stay readable. A row opens the Why sheet, and going back returns to the card.
15. Offline, a save is refused, not queued (Commands, AC7). Back online, it succeeds after step-up.

## 15. Build plan: small stacked PRs

The rules ship first and act from PR 3 (owner decision 1). The decider follows, in shadow, and acts only after PR 9 and its switch-on rule.

| PR | What | Done when |
|---|---|---|
| 1 | **Domain, catalog and docs:** `auto-routing.ts` (profile to Tier, Candidates, exclusions, ranking, rules pick, Reasons; the Scorecard and Standing-move functions). `routing.ts`: the Priority's `auto` switch, the Role's Auto switch, Auto settings. The catalog's per-model `families` and `class` in `VendorPreset` and `vendors.json`, with router models as `unknown`. `docs/domain.md`: an Auto section under Engines, R16–R28, and U4, CN15 and ADR-0018 decision 9 amended. Protocol: `PolicyView` and `PriorityCommand` gain `auto`, plus `CONNECTION_WORDS.auto`, `AutoPickView` and the route answer schema. | Every row R16–R28 of section 13's domain table passes and its control fails, except the decider cases in those rows, which land with PR 7. Turning Auto on leaves the derivation table unchanged under all five modes. The replay property holds over 1,000 random inputs. The wire allowlists, the catalog schema and the architecture test (no `Math.random`) are green, with controls. `npm test` is green. |
| 2 | **Application, launcher and CLI:** `RouterService`; the ports `TaskSource`, `UsageReader`, `Ledger`, `RouteStore`, `StandingStore` and the extended `RepoInspector`, `EngineSettings` and `Catalog`; `publishOwned` registering `family_by_model`; the migration for `routes`, `outcomes` and `standing`. The launcher change (section 7.1): `run --route` or `MORNDO_ROUTE`, the route's entry and reserve, the Lease's route and entry, `LeaseClosed`'s entry, model and route, and the `ran` and cost facts. The CLI: `priority auto`, `role … auto`, `auto show|set`, `route`, `why [--replay]`. The decision log line. | The application tests and the contract test pass against the fake engines CLI, including a Claude model inside Cursor. `route` p95 is under 300 ms on the fixture. A stored pick replays to the same pick after a settings change. With the board unreachable, the defaults apply. A fake `bin` shows whether `MORNDO_ROUTE` reaches it through the engine layer; the answer is recorded in the PR. The `LeaseClosed` allowlist test covers the new fields. Rounds and the daily cap count from routed Leases. |
| 3 | **The page:** the Auto switch and settings, the Roles-covered and starting-Standing preview, the Role cards ("Auto picks", "Last picks", the Auto switch, the `hand` and drifted notes), the Why sheet; the hub's commands with step-up from the effect check. | `e2e/auto-routing.e2e.ts` steps 1–5 pass. Manual QA checklist items 1–3, 6, 9 and 13–15 pass. A test checks that the page's words come from `CONNECTION_WORDS.auto`. **The rules act from here.** |
| 4 | **Outcomes:** `sweep` (board moves, ledger rows); `outcome --by`; the Scorecard read model; `scorecard`. Ranking stays rules-only. `why` also shows what the Scorecard would have picked. | Ingestion tests: send-backs counted, `unknown` after 7 days, source precedence, a STATUS line and a same-lane or lane-less `review` fact refused. The Scorecard pick appears in `why`. The cost priors are recalibrated from recorded runs, in a new rules version. |
| 5 | **Learned Standing (option B on):** Standing moves on landing Outcomes, holds and pins; the quality bands and the recorded medians in ranking; Alerts; `trust`; the page's Scorecard. | The R27 histories pass, including a hold that outlives its window. The e2e, with seeded outcomes, shows a promotion changing a standard-tier pick. Manual QA items 5, 7 and 8 pass. |
| 6 | **Wiring:** the two asks land in the engine layer's own repo; Morndo's route answer is frozen by the contract test; `docs/agents/` gains the manager's block ("start execution lanes with `--engine auto`; pass `--task`"). | A lane started by the engine layer with `--engine auto` runs the router's pick. A forced 75 falls to the next entry. With the router stopped, resolution is as today (a drill, with its log line). Manual QA item 4 passes through the hook. |
| 7 | **The decision step, local:** `fence`, `decisionInput`, `finalize`, `inHoldout`, `switchOn`, `switchBack` in the domain; R29–R33 in `docs/domain.md`; the decider settings in the Routing policy; `DecisionPort` with the `rules` adapter; the decider record in `routes`; the decision input schema in the protocol; `decider show|use|mode|workspace|set`; the page's decider block in Off and Shadow. | Every row R29–R33 of section 13 passes and its control fails, R32's marker test included. A replay makes no port call. With the `rules` adapter, picks are byte-equal to PR 5's on the same fixtures. |
| 8 | **The vendor adapter, in shadow:** the `openai-decisions` adapter and preset; decider Leases on its Connection; the decider budget; shadow calls after the pick; `decider check` and `decider report`; the Alerts. The docs of section 2.1 are re-read first, and the client library and its version are checked live. | The adapter contract test passes against the fake server; the live case passes once with a test key, or is reported as skipped. Measured p50 and p95 latency are recorded in the PR, and the timeout is set from them. Manual QA items 10 and 11 pass. e2e step 6 passes. |
| 9 | **Acting:** `decider act` with the switch-on check and step-up; the holdout; the automatic switch-back; the threshold report; the page's acting switches and "by the decider" rows. | e2e steps 7 and 8 pass. The R33 histories pass. Manual QA item 12 passes. Acting is turned on for real only after the switch-on rule holds on real shadow data (section 11.3). |

Each PR has its rollback. Turning Auto off leaves every chain as projected, since auto never wrote one (R25). Turning the decider off leaves the rules deciding, with no other change. PR 2's Lease fields are additive, and a `run` without a route behaves as today.

## 16. Where else a decision API helps

The same port and the same pattern serve other places where Morndo, or a tool beside it, has to sort something into a few known boxes. The pattern is the one auto routing uses:
- hard rules first; the decider only on what they leave open;
- an escape option (`unsure`, `other`, or `rules`) that falls back to the rules or a human;
- shadow first, a threshold from labelled examples [P9], and a switch-back rule;
- every decision logged with its input, probabilities and final result;
- the input minimised to an allowlist, opted in per workspace, and a local adapter wherever the input has to hold code or prose.

None of these is in this ADR's scope. Each would get its own ADR before any code.

| Use | Question | Input, and where it may go | Benefit | Risk | How to evaluate |
|---|---|---|---|---|---|
| **Triage of review findings** before a human sees them | `predicate`: "Is this finding a functional defect or a security issue, not a style preference?", plus `score` for severity. | The finding's text, which often quotes code: a local model, or a workspace opted in for code. | The principal reads fewer findings, most serious first. | A real defect sorted low: a false negative. | Shadow over findings that a later validation step already confirmed or rejected. Measure recall on confirmed defects first, then how many rejected ones it would have folded. Low scores fold a finding, never drop it. |
| **Incoming events: needs the owner, or routine** | `choice`: `needs-owner`, `routine`, `unsure`. | Event type, status code, age, retries, which agent: fields only. A free-text status line only through a local model. | Fewer pings; real questions reach the owner sooner. | A real decision filed as routine. | Hard rule first: an explicit "needs decision" or "blocked" status always reaches the owner, and `unsure` does too. Shadow against what the owner actually acted on. Target: at most 1 missed needs-owner event in 200. |
| **Choosing review depth** | `score` over levels such as single pass, two passes, deep review. | Diff statistics: files by area class, lines, migrations or config touched, the risk-area flag. Fields only. | Deep reviews where the risk is; faster small ones. | A one-line config change with a large effect gets a light review. | Hard rule first: risk-area paths and migrations always get the deep review. Then the send-back and post-merge fix rate by chosen depth, against a period of fixed depth. |
| **Stuck-agent detection** from transcript tails | `predicate`: "Is the agent repeating a failed action without a new approach?" | The last lines of a transcript, which hold code and may hold secrets: the shared redactor, then a local model; a vendor only for a workspace opted in for code. | Loops caught early; time and spend saved. | A slow but valid search interrupted. | Label past runs that stalled and ones that recovered. Measure false alarms per day and time to detection. The action is an Alert or a nudge, never a stop, until precision is shown. |
| **Data pipelines: the residue after deterministic extraction** | `choice` or `predicate` per leftover item: "Is this leftover string an identifier of the expected kind, or noise?" | One item and its field label. Usually holds no secret, but may hold personal data: per-dataset opt-in, EU processing where the data requires it. | High volume at a low price per item; people see only the uncertain rest. The pattern is already in use in a data pipeline outside this repo. | Wrong labels flow quietly into the data. | Format rules and checksums first; the decider only on what they can't settle. A human-labelled golden set per class, with precision and recall per class; thresholds from those labels [P9]; below the threshold, a human queue; a weekly sample re-checked for drift. |

## 17. Limits, risks, and what would change this

- **Heuristic signals.** Kind and size come from titles, branches, briefs and diffs. Their agreement with the actual diff is measured (section 12). The decider doesn't fix this: it sees the same fields. A local model that reads the title on the node might, later.
- **The decider may add nothing.** It sees what the rules see, plus each option's record. Its value is in weighing quality against cost where a lexicographic key can't, and that is a hypothesis until shadow shows lift (section 11.3). If it doesn't, it stays off, and the rules are the product.
- **A beta API.** The vendor expects general availability "in the coming weeks" [P9]. Fields may change. The answer is checked against a schema; a failure is `unavailable`, and repeated failures switch the decider back (section 11.5). The docs are re-read before PR 8 and when the API leaves beta.
- **One vendor today.** The port keeps the vendor at the edge, and the `rules` adapter is always there. LiteLLM documents other hosted and self-hosted decision models behind the same format [P15]; none is evaluated here.
- **Probabilities are estimates** [P9], not promised calibration. The threshold comes from this user's Outcomes (section 11.6).
- **Small samples.** One user gives 5–20 outcomes per cell and a few hundred routes a month, hence the bands, the "k of n" wording, the 30-decision floor for switching on, and the holdout's one in five.
- **The holdout costs some benefit.** One acting route in five is decided by the rules even when the decider is confident. That is the price of knowing whether it still helps.
- **Privacy.** Fields only, opt-in per workspace; still, profile fields describe work patterns (section 10.1). EU processing needs the vendor's approval, which Morndo can't verify.
- **Unknown costs.** Cursor's per-run cost isn't visible to Morndo (UNVERIFIED), so a Cursor subscription ranks by quota. The token priors are placeholders until PR 4.
- **Large tasks stay off metered keys** while the Role's reserve is $5 (section 6.2). Raising the reserve is the principal's widening change (CN13).
- **Lenient reviews inflate a model's record,** and the decider reads that record. Demotion, pins, the visible Scorecard and per-Tier promotion limit the damage.
- **Same-user trust** (ADR-0018 §5.3). `--by` and the lane check stop the plain case of a run grading itself. A process of the same user that forges a route id is recorded, not prevented.
- **The route id before ask 2** travels in the lane's environment. Whether the engine layer hands it to `bin` unchanged is UNVERIFIED until PR 2's check. If it doesn't, routed runs record `ran` from the ledger only, after ask 2, and until then the daily cap counts all of a key's spend that day.
- **Races.** A pick sees one moment. The write step of `route` is serialised on a node, the decider's choice is re-checked inside the transaction (`stale`), and the gate catches a budget spent between the pick and the lease (75, fall-through). Interactive and Codex runs have no in-run cap (ADR-0018).
- **Per node.** Routes, Outcomes, Standing and decider settings are per node, as Connections are. Connection names are the join key if a fleet-wide view comes later.
- **What would change this:**
  - a vendor publishes per-run cost for subscription runs;
  - the engine layer ships the router hook, or moves into Morndo (then only the adapter changes);
  - a vendor router reports the family of the model it chose;
  - Verification lands: Verdicts become a higher-trust Outcome source than the board;
  - the Decisions API leaves beta, changes its fields, its price, its data terms or its model;
  - shadow shows no lift after a quarter of use: the decider is retired, and this design falls back to the first one.

## 18. Sources (read 2026-10-11)

- [P1] OpenRouter, Auto Router: a "fast, lightweight classifier" into about 30 task types, spend-share ranking, `cost_tier`, `allowed_models` and `excluded_models`, the `model` field, opt-in router metadata, and "If classification or rankings are ever unavailable, the router degrades gracefully to a default model set". https://openrouter.ai/docs/guides/routing/routers/auto-router
- [P2] Cursor Router: a classifier by task type and complexity; Cost, Balance and Intelligence; "Hidden is the default and recommended, so results are judged on their own merit rather than by model name"; Teams and Enterprise only. https://cursor.com/docs/cursor-router
- [P3] Cursor, "How Cursor Router chooses the right model for the task" (2026-08-06): a complexity score from 0 to 1 against a threshold; "Moving on to the next task is a strong positive signal, while correcting the agent is a strong negative one." https://cursor.com/blog/how-cursor-router-works
- [P4] Cursor, Models & Pricing: "All Auto modes bill at the list price of the model each request is routed to." https://cursor.com/docs/models-and-pricing
- [P5] Claude Code, model configuration: aliases; `opusplan`; `fallbackModel` and `--fallback-model` ("tries them in order, showing a notice when it switches"; "the switch lasts for the current turn only"); the model in the status line and `/status`. https://code.claude.com/docs/en/model-config
- [P6] LiteLLM, Router: routing strategies, fallbacks, order-based failover, cooldowns, `x-litellm-model-id`. https://docs.litellm.ai/docs/routing
- [P7] LiteLLM, Auto Routing: a heuristic scorer over seven dimensions with zero API calls; tiers SIMPLE, MEDIUM, COMPLEX, REASONING; an LLM classifier option; Thompson sampling; `session_affinity`; one log line per decision naming its cause. https://docs.litellm.ai/docs/proxy/auto_routing
- [P8] GitHub Copilot, auto model selection: health and task complexity; "subject to your policies and subscription type"; "You can see which model was used for each Copilot response." https://docs.github.com/en/copilot/concepts/auto-model-selection
- [P9] OpenAI, Decisions guide: public beta, GA expected "in the coming weeks"; `gpt-6-luna` only, `POST /v1/decisions`; `predicate`, `choice`, `score`; `choice` answers with `probabilities` and `confidence`; "Include a fallback option such as "other""; "Use labeled examples from your application to set thresholds"; "about 10x faster than the Responses API"; $0.10 per 1M input tokens, no output or cache charges, regional premiums and long-context multipliers apply; ZDR and HIPAA for eligible customers; US and Europe regional processing; SDK minimum versions. https://developers.openai.com/api/docs/guides/decisions
- [P10] OpenAI, API reference, Create a decision: request fields; answers in the order asked; 2 to 255 unique `choice` values, string or boolean; the answer union with `refusal`; `usage` with `input_tokens`; no seed or temperature parameter. https://developers.openai.com/api/reference/resources/decisions/methods/create
- [P11] OpenAI, API changelog: 2026-10-06 "Released the Decisions API in beta with `gpt-6-luna`"; 2026-10-06 usage tiers simplified to Build, Launch and Grow; 2026-09-22 GPT-6 Luna released. https://developers.openai.com/api/docs/changelog
- [P12] OpenAI, Pricing: `gpt-6-luna` standard rates; short context up to 272K input tokens; "Regional processing (data residency) endpoints are charged a 10% uplift for models released on or after March 5, 2026". https://developers.openai.com/api/docs/pricing
- [P13] OpenAI, data controls ("Your data"): the `/v1/decisions` row (not used for training; abuse monitoring 30 days; ZDR eligible); the `/v1/decisions` section (prompt-caching tensors up to 24 hours; HIPAA addendum); data residency per project or per request through `us.api.openai.com` and `eu.api.openai.com`; non-US regions need approved abuse-monitoring controls and a Modified Retention amendment; system data excluded; `/v1/decisions` regional processing in the United States and Europe (EEA + Switzerland). https://developers.openai.com/api/docs/guides/your-data
- [P14] "RouteLLM: Learning to Route LLMs with Preference Data" (arXiv 2406.18665, v4): a strong/weak router with a cost threshold α on the predicted win probability; PGR, APGR and CPT; "reduces costs by over 2 times in certain cases". https://arxiv.org/abs/2406.18665
- [P15] LiteLLM, `/v1/decisions` and `/v1/systemone`: one route for several decision models in the OpenAI format; providers include OpenAI `gpt-6-luna` and self-hosted vLLM (Qwen3 models, `choice` questions only); cost tracking per request; from v1.104.2. https://docs.litellm.ai/docs/decisions
- [P16] Anthropic, Choosing the right model: the model selection matrix; "Most workloads start with Claude Opus 5.5"; "Tuning effort is often a better lever than switching models"; "having a good evaluation set is the most important step". https://platform.claude.com/docs/en/about-claude/models/choosing-a-model
- [P17] Z.ai, GLM-5.3 ("Z.ai's latest flagship model"; effort `low`, `high`, `max`, default `max`; "For complex tasks such as coding, we recommend using `max`") and GLM-5.3-Flash ("stronger intelligence than GLM-5.2 at an exceptionally low cost"). https://docs.z.ai/guides/llm/glm-5.3, https://docs.z.ai/guides/vlm/glm-5.3-flash
- Engine layer, read 2026-10-11: `resolver.py` (availability, marks, the family rule, exit 3), `config.py` (`family`: a fixed family, else `family_by_model`, else `unknown`), `lane.py` (the mid-task switch takes the first available entry of the Role's chain other than the current one), and its CLI help (`resolve`, `implementers`). Z.ai preset and prices: the `feat/zai-glm` branch's catalog and the source it cites (2026-10-10).
- The `openai` npm package: `npm view openai version` answered 7.32.0 on 2026-10-11.

## Decisions for the owner

1. **How Auto decides. Answered 2026-10-11: a combination.** Hard rules first: the gate, budgets, each Role's allowed Connections, your caps, a reviewer from another provider, and Hand Roles never routed. Then a lightweight decider picks among what is left, and acts only when it is at least 80% sure of its choice. Below that, or when the decider is off, unavailable, over its budget, or not allowed for the workspace, the rules and the Scorecard decide. The rules act from the start for the implement Roles. The decider starts in shadow, and acts only after it beats the rules on your own tasks, routine work first.
2. **How much Auto may spend on a key without asking.** Default unchanged: at most $3 expected per task and $10 a day per metered key, always within the key's own budget. Above that, Auto uses your subscriptions. New: these limits bind the decider too; it can't choose past them.
3. **When Morndo can't see a subscription's quota** (Cursor reports none today). Default unchanged for the rules: keep Cursor for hard and risky work, and send small routine tasks to GLM. New: the decider can't send routine work to Cursor either. The alternative is to let the decider choose Cursor for a routine task when it judges the task harder than its labels say.
4. **New models earn harder work.** Default unchanged: a model new to a Role (GLM now) starts on routine tasks. It moves up a level after 4 of its last 5 are accepted first try, and down after 3 of 5 are sent back. New: the decider can't skip this; it only chooses among models already trusted for the task's level. The alternative is to trust it for every task from the start.
5. **New: may Morndo send task profiles to an outside decider?** Default: off for every workspace; you turn it on per workspace, starting with your own projects, not ones that hold other people's material. When on, only profile fields leave the machine: kind, size, risk, round, priority, languages, and each option's model, cost, trust level and record. Never titles, descriptions, code, paths, or repo and key names. The vendor's standard endpoint; EU processing if your vendor account is approved for it. Off means the rules decide, at no cost.
6. **New: the decider's budget.** Default: $0.25 a day for all decision-API uses together, a few thousand decisions at the price checked on 2026-10-11 (estimate). Over it, the rules decide until the next day, and you get one Alert. The alternative is $1 a day.
