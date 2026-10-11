# Auto routing: Morndo picks, per run, which allowed Connection does a Role's work (design, 2026-10-11)

**Phase: design only.** This document and [ADR-0020](../../adr/0020-auto-routing.md). No product code yet.

**The request (2026-10-11):** for execution, switch between a Cursor subscription and GLM through a Z.ai key. Morndo decides which one runs when, so the settings need an Auto mode.

**Review.** A fresh-context review of the first draft found fifteen problems. Each was checked against the code or the text and folded in:
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

**Builds on:**
- ADR-0013: Roles, chains, and the engine layer's resolver.
- ADR-0015: the board.
- ADR-0016: Usage windows.
- ADR-0018 and its design ([`../secret-store/README.md`](../secret-store/README.md)): Connections, the Lease gate, and the Routing policy with R7–R15.
- The Z.ai preset on `feat/zai-glm`.

Facts carry a source and the date read. **[P*n*]** points to section 15. UNVERIFIED marks what no primary source settled. The program is named `morndo-connections` here, as in ADR-0018; the build ships it as `morndo-keys`, and every command below runs under either name.

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
| OpenRouter Auto Router | Classifies the prompt into about 30 task types, ranks models by their share of spend for that type over 7 days, applies a `cost_tier`, routes to the top survivor "with fallbacks". `allowed_models` and `excluded_models` restrict it; exclusions win. | "The response includes the `model` field showing which model was actually used." The task type is opt-in metadata. | [P1] |
| Cursor Router (Auto) | A classifier on each agent request "routes it based on task type and complexity". Modes: Cost, Balance, Intelligence. A complexity score from 0 to 1 against a threshold keeps easy turns on a cheap model. It learns from the user's next action. | Admins may show the routed model or hide it: "Hidden is the default and recommended". | [P2], [P3] |
| Cursor billing | "All Auto modes bill at the list price of the model each request is routed to." | | [P4] |
| Claude Code | Aliases. `opusplan` "uses `opus` during plan mode, then switches to `sonnet` for execution". A `fallbackModel` list "tries them in order, showing a notice when it switches", and "the switch lasts for the current turn only". | The model shows in the status line and `/status`. | [P5] |
| LiteLLM Router | Strategies `simple-shuffle` (default), `usage-based-routing-v2`, `latency-based-routing`, `least-busy`, `cost-based-routing`, or custom. Fallbacks, order-based failover, and cooldowns per deployment. | The `x-litellm-model-id` header names the deployment. | [P6] |
| LiteLLM Auto Routing | A heuristic scorer with "zero API calls" over seven dimensions maps to tiers SIMPLE, MEDIUM, COMPLEX and REASONING. Options: an LLM classifier, keyword rules, Thompson sampling within a tier, and `session_affinity` that pins the first-turn model. | "Every routing decision emits one greppable line naming its cause." | [P7] |
| GitHub Copilot auto | System health plus task complexity. Chooses only from models allowed "subject to your policies and subscription type". | "You can see which model was used for each Copilot response." | [P8] |

What we take:
1. **An allowed set first** [P1, P2, P8]. Candidates are the Role's derived chain, nothing else.
2. **A cheap deterministic classifier** [P3, P7]. The Task profile comes from rules over facts at hand, with no model call. A complexity threshold becomes the Tier.
3. **Learn from what the human does next** [P3]. Accepted first try or sent back on the board, review findings, fix rounds.
4. **Name the model that ran, and the cause** [P1, P5, P6, P7, P8]. Cursor hides it by default [P2]; Morndo always shows it, because the review rule needs the family and the principal's trust needs the reason.
5. **Keep fallback apart from routing** [P5, P6]. Routing picks the start; the chain stays the fallback.
6. **Pin a pick for its run**, as LiteLLM's session affinity does [P7]. A new pick is made only when a new run starts.
7. **Not taken:** sampling [P7], market-wide ranking [P1], and opaque learned classifiers [P3]. Each breaks replay or needs data one user doesn't have.

## 3. Goals and non-goals

**Goals:**
- Auto in the settings. Per run, Morndo picks the Connection and model to start with, among those the user allowed for the Role.
- Easy and small work goes to what is cheap. Hard and risky work goes to what the user trusts. A new model earns harder work through results.
- Every pick names its cause in one line, and in full with `why`. Replaying its stored inputs gives the same pick.
- The rules in force still hold: the gate, budgets, the review rule, `hand` and drifted Roles, and fallback.
- Turning Auto on or off changes no chain.

**Non-goals:**
- No model call to decide.
- No change to the projected chain per task.
- No fleet-wide policy: the Routing policy is per node (ADR-0018), and so are routes, Outcomes and Standing.
- No routing inside a run: the runtime's own fallback model [P5] stays the runtime's.
- No new Verification. Outcomes are acceptances by others, not Evidence (V1).

## 4. The model

### 4.1 Where auto lives

The **Engines** context, beside the Routing policy (ADR-0018 §3.4). Code: `packages/domain/src/auto-routing.ts`, pure, beside `routing.ts`.

| Piece | Kind | Holds |
|---|---|---|
| Routing policy (extended) | Aggregate | The global Priority's `auto` switch; each Role's Auto switch (default: on for the `implement` group, off for every other Role); Auto settings (Task ceiling, Save line, daily caps, and each Role's reserve, default $5). Guards R16 and R28. |
| Standing table (new) | Aggregate, one per node | Per Candidate and role group: the level, whether the principal pinned it, and its history of StandingChanged. Guards R27. |
| Run route (new) | Aggregate, one per route id (`rt-118`) | The Auto pick, immutable once made, with all its inputs, and the Outcome facts appended to it. Guards R17 to R26. |
| Scorecard | Read model | A projection of Outcome facts per entry that ran, role group and Tier. It feeds ranking and Standing moves; it moves nothing by itself. |

How auto relates to the other contexts:
- **Connections:** Engines stays downstream, as in ADR-0018. Auto reads the directory and runs the gate as a pure query. Connections still knows nothing about Roles (CN15). The one change on that side: the launcher records the route, the asked entry and the model reported (section 7.1).
- **Board:** read through an adapter. Auto takes a task's title, priority and moves with their actors; the board grants nothing (B8).
- **Usage:** read through an adapter, for windows.
- **The engine layer:** read through the existing `EngineSettings` port and a ledger port, for availability, chains, families and implementers.
- **Grants:** none. A pick is not a Lease, a Mandate or a Verdict. Outcomes are not Evidence.

### 4.2 Ubiquitous language

ADR-0018 already uses **Pick** for an engine a Role may run on (`connection:model[@effort]`). To keep one meaning per word, this design says **Auto pick** for the choice made for one run, and **Candidate** for an ADR-0018 Pick under consideration. **Outcome** here is not the Jobs context's Outcome, nor a Lease's `outcome` field (how its process ended).

| Term | Means | Is not |
|---|---|---|
| Auto | A switch on the global Priority, beside its mode. When on, each Role whose Auto switch is on has its derived chain, still derived by its mode or its own Priority (R8–R10), as the allowed set and the fallback order, and Morndo picks per run which entry starts. | A sixth mode; the engine layer's `--engine auto`, which only resolves the chain; a vendor's own router. |
| Auto switch | Per Role, on or off. Default: on for the `implement` group, off for every other Role (owner decision 1). A Role's own Priority (`own`) shapes its chain only; it has no switch of its own. | An Override; `hand`. |
| Reserve | Per Role, an Auto setting: what a run of the Role may reserve on a key, $5 by default as the launcher's `--reserve`. `route` answers it with the pick, and the launcher uses it. | A Budget. |
| Run request | A request to start one run of a Role: role, risk, workspace, and optionally task key, lane, round, implementers and hints (kind, size, brief file). | A board task; a Lease. |
| Task profile | What a Run request is known to be. Each signal has a value and a source (section 5). The brief is kept only as a digest and counts. | The brief's text; a model's guess. |
| Tier | `routine`, `standard` or `hard`: what the profile demands, from the rules table. | A price tier of a vendor. |
| Role group | The Role name up to its first hyphen (`implement-ui` → `implement`). Standing and Scorecards pool over it. | A Role. |
| Family | The model family of one entry, from the catalog's per-model map (`claude-*` → `anthropic` inside Cursor too). A vendor router's model is `unknown`. | The provider; the vendor. |
| Candidate | One entry of the Role's derived chain (its risk chain for risk-area work) under consideration for one run, with its facts: Connection, Kind, custody, family, availability, gate verdict, expected cost, quota, Standing, quality band and median time. | A Connection; a Pick outside the chain. |
| Exclusion | The first hard limit a Candidate fails (section 6.1), with its values. | A low rank. |
| Standing | Per Candidate and role group: held, or trusted up to a Tier. "On probation" means trusted up to routine. It is persisted, and moved only by an Outcome landing (by the rules table) or by the principal's pin. | A Connection's Status; availability; a value recomputed on read. |
| Auto pick | The Candidate chosen for one run, the run's chain (the pick, then the rest of the derived chain in Role order), the Reasons, the Exclusions, the ranking and the inputs. | A Lease; a chain written to the engine layer. |
| Reason | A typed fact that decided or excluded: a code with numbers (`cheapest`, `kept-for-harder`, `trusted-for`, `no-trusted-available`, `budget`, …), rendered from the protocol's words table. | Free text; the brief. |
| Outcome | What came of an Auto pick: the entry that ran, fell back or not, accepted first try, send-backs, review findings, fix rounds, cost with its source, wall time, and the model reported. Append-only facts from named sources. | A lane's own claim of done (V1); a Verdict. |
| Scorecard | Per entry that ran, role group and Tier: counts and medians of Outcomes in a window, with a quality band. | A benchmark; a promise. |
| Task ceiling | The most a metered key may be expected to cost for one task before a kept subscription goes first. | A Budget (CN8). |
| Save line | The weekly-window share past which a subscription is kept for harder work. | The engine layer's out-of-quota mark. |
| Daily cap | Per metered Connection: what Auto's picks may commit to it in a day. | Its Budget. |

### 4.3 Invariants

They continue the Engines context's R1–R15.

| # | Invariant |
|---|---|
| R16 | A run is auto-routed only when all of these hold: Auto is on in the global Priority; the Role's Auto switch is on; the Role's Override is not `hand`; and the Role is not drifted (R14). A Role under `own` follows the same two switches; its own Priority shapes only its chain. Otherwise `route` answers "not auto" with its reason (`off`, `role-off`, `hand` or `drifted`), and the run resolves the derived chain as today. Turning either switch changes no derived chain and writes nothing (R8, R10 unchanged). |
| R17 | The Candidates are exactly the entries of the Role's derived chain. For risk-area work, they are the entries of its derived risk chain when it has one. An Auto pick is always one of them, and the run's chain holds no other entry. |
| R18 | A Candidate is excluded, with its first failing reason, in this order: (1) not in the chain (a tamper guard); (2) a family of `unknown`, which covers vendor router models; (3) the engine layer's availability: off, not installed, signed out, or marked until a time; (4) the gate's dry run for this workspace, every CN8 step, for a Connection in Morndo's custody; (5) budget: a metered Candidate's expected cost is above the reservation the gate would grant for the Role's reserve (an Auto setting, $5 by default), or the day's committed Auto spend on it plus that cost passes its daily cap. Committed spend is closed spend, plus open reservations of routed runs, plus the expected cost of picks not yet leased that are younger than 10 minutes. (6) quota: a subscription window at 90% or more; (7) the review rule (R19); (8) Standing `held`. Usage windows and spend figures act only here and in ranking. They never grant, and never admit what (1)–(4) refused (amends U4, CN15, ADR-0018 decision 9). |
| R19 | **Review rule**, on per-model families. The review Role is the one named `review`, which the engine layer's resolver applies `review_other_provider` to; the rule is also in effect for any Role with `other_provider` on. While it is in effect for a Role, that Role's Candidate is excluded when its family equals the family of any implementer on the task's branch (the engine layer's ledger, joined with earlier Auto picks for the task); `unknown` is already excluded by R18. While it is in effect for `review`, an implementer Candidate is excluded when no entry of another family would remain in the `review` chain. |
| R20 | The Tier is a function of the Task profile and the rules table in force, versioned (`rules-v1`, section 5.3). A missing signal takes its stated default. Risk-area work is always `hard`. |
| R21 | Ranking is lexicographic per Tier (section 6.2). The Role's order is the last key. The result doesn't depend on the order the Candidates were listed in. |
| R22 | An Auto pick is a pure function of its inputs: the profile; the Candidates with their facts, Standing included; the Auto settings in force; the Scorecard cells used, with their counts; the policy and rules versions; and `now`. All of them are stored with the pick before the run's chain is answered. `why --replay` recomputes the pick from the stored inputs and must get the same one, whatever changed since; a mismatch raises an Alert. |
| R23 | An Auto pick carries at least one Reason, which names the key that decided it. Each excluded Candidate carries its first Exclusion. Reasons and Exclusions hold codes, names from the policy and numbers. They never hold a brief, a title, a description or a path. |
| R24 | The run's chain is the pick, then the rest of the derived chain in the Role's order. A refused lease (75) or a failed run falls down that chain as today. When no Candidate is eligible, or `route` fails or is late, the run resolves the derived chain as today. Auto never removes a fallback and never stops a run. |
| R25 | Auto writes nothing to the policy's chains or to the engine layer: no Priority order, Override, Pick, chain, mark or provider. A pick grants nothing. The gate decides at lease time, and the engine layer decides availability at start. |
| R26 | Outcome facts are append-only, tied to one route id, and carry their source (`lease`, `ledger`, `board`, `review`, `principal`). A later fact of the same kind supersedes an earlier one only from a source of equal or higher trust. A spend figure follows CN10. No Outcome comes from the run being judged: a lane's own STATUS line or claim is never one. A `review` fact must name the reviewing run's route or lease. Both routes must carry a lane, and the lanes must differ; otherwise the fact is refused. A route counts toward a task's rounds and toward any Scorecard only once it has a `ran` fact, and it counts in the cell of the entry that ran. A Scorecard is a pure function of the facts recorded before a given time. |
| R27 | **Standing**, per Candidate and role group. When Auto first applies to a Role, each entry that is the first of that Role's derived chain or risk chain starts trusted up to `hard` in the Role's group. If two Roles of a group start different entries, both are trusted: the higher start wins, and a later Role never lowers a level already set. Every other Candidate starts on probation, and so does one that joins a chain later. The principal may set any of them in the same Command. After that, Standing moves only when an Outcome lands, by the rules table (section 7.3), or when the principal pins it. Outcomes leaving the Scorecard window move nothing. A pin holds until removed. Every automatic move is persisted as StandingChanged and raises an Alert. |
| R28 | Every change to Auto's settings is a principal Command (R13), judged by effect. It is narrowing, and needs a session only, when no metered Candidate can gain work or spend from it: a lower Task ceiling, daily cap or reserve; a hold or a lower pin on a Candidate that shares no chain with another metered Candidate. Every other change needs step-up (AC7), or a typed confirmation at the machine: either switch on or off, a Save line change, a raised ceiling, cap or reserve, a higher pin, a release, and a hold or lower pin whose work could move to a key. Off counts too, since it returns a Role to its plain order, which may start on a metered key. R27's automatic moves are the only exceptions. |

### 4.4 Events

- **Routing policy:**
  - PriorityChanged (as before);
  - AutoSwitched (`global` or a role, on or off, command);
  - AutoSettingsChanged (which setting, from, to, command).
- **Standing table:**
  - StandingChanged (Candidate, group, from, to, cause: `start`, `promoted`, `demoted` or `pinned`, with the route that tipped it);
  - StandingPinned and StandingUnpinned (Candidate, group, level, command).
- **Run route:**
  - AutoPicked (route, role, tier, pick, cause);
  - AutoDeclined (route, role, reason: `off`, `role-off`, `hand`, `drifted` or `none-eligible`);
  - OutcomeRecorded (route, kind, source).

The audit keeps them for 180 days, the same window as routes and Outcomes. Standing itself is kept as long as the Connection.

### 4.5 A sketch of the domain module

```ts
// packages/domain/src/auto-routing.ts (sketch; names may change in PR 1)
export type Tier = "routine" | "standard" | "hard";
export type Size = "S" | "M" | "L" | "XL" | "unknown";
export type TaskKind = "fix" | "feature" | "refactor" | "test" | "docs" | "chore" | "review-fix" | "unknown";
export type Source = "flag" | "board" | "lane-task" | "branch" | "diff" | "findings" | "brief" | "picks" | "ledger" | "default";
export type Signal<T> = { value: T; source: Source };
export type TaskProfile = {
  role: string; group: string; risk: Signal<boolean>; kind: Signal<TaskKind>; size: Signal<Size>;
  round: Signal<number>; priority: Signal<"high" | "normal" | "low">; workspace: string; task: string | null;
  lane: string | null; implementers: readonly { entry: string; family: string }[];
  brief: { digest: string; items: number; paths: number } | null;
};
export type Level = "held" | Tier;                                  // trusted up to this Tier; "routine" = probation
export type Cost = { kind: "included" } | { kind: "kept" } | { kind: "metered"; usd: number; from: "scorecard" | "prior" } | { kind: "unknown" };
export type Candidate = {
  entry: string; connection: string; kindOf: "subscription" | "api-key"; family: string; inChain: boolean;
  available: true | { reason: string; until: number | null }; gate: "ok" | "not-ours" | GateReason;
  reservation: number | null; cost: Cost; committedToday: number | null; window: number | null;
  level: Level; band: "A" | "B" | "C" | "new"; minutes: number | null; rank: number;   // rank: place in the Role's order
};
export type AutoSettings = {
  taskCeiling: number; saveLine: number; dailyCaps: Readonly<Record<string, number>>; reserves: Readonly<Record<string, number>>;
};
export type AutoPick = {
  route: string; at: number; tier: Tier; pick: string | null; chain: readonly string[];
  reasons: readonly Reason[]; excluded: readonly { entry: string; reason: Reason }[]; ranked: readonly string[];
  inputs: { profile: TaskProfile; candidates: readonly Candidate[]; settings: AutoSettings; cells: readonly CellCounts[];
            versions: { policy: number; rules: string } };
};
export function tierOf(profile: TaskProfile, rules: RulesV1): Tier;                                    // R20
export function decide(inputs: AutoPick["inputs"], rules: RulesV1, now: number): Omit<AutoPick, "route" | "inputs">; // R17–R24
export function scorecard(facts: readonly OutcomeFact[], before: number, window: Window): Scorecard;  // R26
export function move(level: Level, pinned: boolean, cell: CellCounts, landed: OutcomeFact, rules: RulesV1): Level; // R27
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

The title and description are read in memory to find the kind and the size, and are never stored (R23). Everything stays on the node.

### 5.2 Size thresholds (`rules-v1`, defaults)

| From | S | M | L | XL |
|---|---|---|---|---|
| Diff (changed lines, files) | ≤ 50 and ≤ 3 | ≤ 400 and ≤ 15 | ≤ 1,500 | above |
| Findings in a fix round | ≤ 2 | ≤ 5 | above | |
| Brief (acceptance items, paths named) | ≤ 2 and ≤ 2 | not S, L or XL | ≥ 6 or ≥ 10, below XL | ≥ 12 or ≥ 25 |

These are starting values. PR 4 records the actual diff at acceptance beside the estimate, and `log --routes` reports how often they agree (section 10). The thresholds change only with a new rules version.

### 5.3 Tier (`rules-v1`)

In order; the first row that matches decides.

| # | When | Tier | Reason code |
|---|---|---|---|
| 1 | Risk-area work. | hard | `risk` |
| 2 | Round 3 or later: two fix rounds already failed. | hard | `third-round` |
| 3 | Size L or XL. | hard | `large` |
| 4 | Size S, and the kind is `docs`, `test`, `chore`, `fix` or `review-fix`, and the priority isn't high. | routine | `small-routine-kind` |
| 5 | Anything else, unknown signals included. | standard | `default` |

## 6. Candidates, exclusions and ranking

### 6.1 Exclusions

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

A Connection in the engine layer's custody (`studio`, `cursor-cloud`, `agy`) has no gate dry run, since the gate doesn't reach it: step 4 reads `not-ours`. Its cost is `unknown`.

**One decision at a time.** `route` gathers the slow facts first, outside any transaction: availability, the gate's dry run, Usage, the board and the diff. Then, inside one SQLite write transaction (`BEGIN IMMEDIATE`), it re-reads each metered Candidate's committed spend, calls `decide`, and saves the route. Two picks made together therefore see each other's committed spend (R18, step 5).

### 6.2 Ranking

Each Tier has a key, compared left to right. The Role's order is always last.

| Tier | Key |
|---|---|
| hard | trusted for `hard` first → quality band (A, B, new, C) → Role order |
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

### 6.3 Worked example

The setup:
- Connections: `cursor` (subscription, reports no window), `glm` (Z.ai key, metered, budget $20, reserve $5), `claude` (subscription).
- The global Priority is `subscriptions-first` with Auto on.
- The Role `implement-backend` has Override `own` (mode `custom`, order `cursor, glm`) and its Auto switch on. So `claude` is outside its allowed set.
- Its Picks: `cursor:claude-sonnet-5.5@high` and `glm:glm-5.3@max`.
- Its risk Picks: `cursor:claude-opus-5.5@high` and `glm:glm-5.3@max`.
- Families from the per-model map: the `cursor` entries are `anthropic`; `glm` is `zai`.
- Auto was switched on with `cursor` first in both chains, so both `cursor` entries are trusted up to hard, and `glm` is on probation.
- Defaults: Task ceiling $3.00, Save line 50%, daily cap $10.

| Task | Profile | Tier | Auto pick and Reason |
|---|---|---|---|
| T-41 "docs: explain the retry flag" | docs (title), S (brief: 2 items, 1 path) | routine | `glm:glm-5.3@max`. Cheapest for routine work: about $0.55 (price × S prior), under $3.00. `cursor` is kept for harder work: its quota isn't reported. |
| T-42 "Rework session expiry in the auth middleware", `--risk` | risk | hard | `cursor:claude-opus-5.5@high` (risk chain). Trusted for hard work; `glm` is on probation (2 of 5 routine tasks so far). |
| T-43 "fix: off-by-one in pagination". A what-if, outside the timeline: `glm` has only $0.40 of its Budget left. | fix, S | routine | `cursor:claude-sonnet-5.5@high`. `glm` is excluded (budget: about $0.55 expected, at most $0.40 left to reserve). |
| T-50 "Add CSV export to the orders page", a week later, after `glm` went 4 of 5 at routine | feature, M | standard | `glm:glm-5.3@max`. Trusted for standard work since T-48. About $2.54, under $3.00 and under the $5 reserve. `cursor` is kept for harder work. |
| T-51 "Fix the token refresh race in the auth client", `--risk`, while `cursor` is marked out of quota until 14:00 | risk, size unknown (M prior) | hard | `glm:glm-5.3@max` (risk chain). No Candidate trusted for hard work is available: `cursor` is marked until 14:00. About $2.54, under the reserve. |

In each case, the run's chain is the pick followed by the other entry. A failure on the first falls to the second, as today. An L-size task on T-51's day would find `glm` excluded by budget ($8.32 against $5), and resolve the chain as today.

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

Trust, highest first: `principal`, `review`, `board`, `lease`, `ledger`. A fact never comes from the judged run's own words (R26).

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
  - `routes`: id, at, role, group, task, lane, workspace id, tier, pick, chain, inputs (JSON: profile, Candidates and their facts, settings, cells used, versions), reasons, exclusions. Declined routes are stored too, with their reason, so a review run that wasn't auto-routed still has a route to name in `--by`.
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

## 8. Ports, adapters, and the engine layer

### 8.1 Application

`apps/connections/src/application/router-service.ts`:
- `route(request)`: build the profile, gather the Candidates, call `decide`, store the route, answer the chain;
- `why(id)` and `replay(id)`;
- `recordOutcome(route, fact)`, which applies R27's moves;
- `sweep()`: join board moves and the engine layer's ledger rows to routes. The launcher appends lease facts itself (section 7.1);
- `preview(role)`: a synthetic profile per Tier, for the page;
- `scorecards(group?)`.

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
| `RouteStore` | `decideAndSave(facts, decide)`: one write transaction that re-reads committed spend, runs the pure `decide`, and saves the route (section 6.1). Also `get(id)`, `byTask(key)`, `append(route, fact)`, `facts(before)`. | SQLite, in the connections database. |
| `StandingStore` | `levels(group)`, `apply(change)`. | SQLite, in the same database. |
| `Catalog` (extended) | Presets as today, plus a per-model family map in the `VendorPreset` schema (`families`: ordered model patterns to a family, router models to `unknown`). A model no pattern matches keeps the preset's `family`. | `catalog-file`. |
| `Clock`, `AlertSink` | As today. | As today. |

### 8.3 Inbound adapters

- **The CLI** (section 9.2).
- **The page:** the `page` JSON gains an `auto` part, and `apply` gains the commands `auto`, `trust` and a Role's `auto` field. The hub runs the program, as it does today. Its step-up decision comes from the program's effect check (R28), not from the command's kind.
- **The engine layer's router hook,** once it exists (ask 1).

### 8.4 The engine layer: two additive asks, and the way until then

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
- Turning Auto on shows the Roles it will cover, each with its Auto switch (owner decision 1), and each Candidate's starting Standing in words, with a choice to change each. It also states that no chain changes.
- Saving asks for the passkey (R28).

**Each Role card** gains:
- **Auto: On / Off**, defaulting to On for the `implement` Roles and Off for the rest. Off reads "the chain runs in order".
- **"Auto picks"**: one line per Tier, from `preview(role)`, for example:
  - "Routine: glm:glm-5.3@max, because it is the cheapest (about $0.55, under $3.00); cursor is kept for harder work (its quota isn't reported)."
  - "Hard: cursor:claude-opus-5.5@high, because it is trusted for hard work; glm is on probation (2 of 5)."
- **"Last picks"**: the latest five, each a row such as "T-41 · docs, S · glm · accepted first try · $0.41". A row opens the Why sheet, with the same content as `why`.
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
```

- `route` exits 0 with an answer, auto or not (`"auto":false,"reason":"hand"`).
- It exits 1 when it can't answer. The caller then resolves as today (R24).
- Every change R28 calls widening asks for a typed confirmation at the machine, with no `--yes` (CN13's terminal path). That covers:
  - `priority auto on|off` and `role … auto on|off`;
  - a raised ceiling, cap or reserve;
  - a Save line change;
  - `trust` upward or `auto`;
  - a hold or lower pin whose work could move to a key.
- `route` takes the lane from `--lane`, else `MORNDO_LANE`, and stores it on the route.

What `why` prints:

```
rt-118  T-41  implement-backend  2026-10-11 09:14
Profile  kind docs (title) · size S (brief: 2 items, 1 path) · risk no · round 1 · priority normal → routine (small-routine-kind)
Pick     glm:glm-5.3@max: cheapest for routine work, about $0.55 (price × S prior), under the $3.00 ceiling
Ranked   2. cursor:claude-sonnet-5.5@high: kept for harder work (its quota isn't reported)
Chain    glm:glm-5.3@max → cursor:claude-sonnet-5.5@high
Inputs   policy v31 · rules-v1 · ceiling $3.00 · save line 50% · cells 2 · profile 9f2c41ab07de · replay: same pick
Outcome  ran glm:glm-5.3@max · accepted first try · 0 findings · $0.41 (estimate) · 11 min
```

## 10. Observability

- **One log line per decision,** naming its cause, as [P7] does:
  `auto rt-118 role=implement-backend tier=routine pick=glm:glm-5.3@max cause=cost excluded=0 ms=140`.
  It carries no text from the task, and it goes through the shared redactor like every log.
- **`morndo-connections log --routes [--since 7d]`:**
  - picks per Candidate and Tier;
  - the share of picks that fell back (a pick the gate or the runtime refused means stale inputs);
  - Outcome coverage: the share of picks with an Outcome within 7 days;
  - a replay check of the last 50 picks;
  - size agreement: the estimated size against the diff at acceptance;
  - Auto's committed spend per metered key per day, against its cap;
  - `route` latency at p50 and p95. The target is under 300 ms at p95; the engine layer gives up at 2 s.
- **Alerts** (the existing `AlertSink`, later the fleet's Alert kind):
  - StandingChanged;
  - a Candidate held;
  - ReplayMismatch, always;
  - three or more fall-backs after picks of one Candidate within an hour;
  - none eligible, three or more times in a day for one Role;
  - a `review` fact refused for its source.
- **The page** shows the last picks per Role, the Scorecard and Standing. Every number on it can be traced to `why`, `outcomes` and `standing`.

## 11. Test plan

**Domain** (`packages/domain/test/auto-routing.test.ts`, with a fake clock). One negative-control history per invariant:

| Invariant | Test, and the control that must fail it |
|---|---|
| R16 | Auto off, a Role switched off, `hand` and drifted each answer "not auto" with their reason. An `own` Role follows the global switch and its Role switch. Turning Auto on leaves every derived chain byte-equal under each of the five modes. Control: a `hand` Role that gets a pick. |
| R17 | Every pick and chain entry is in the derived chain; a risk run uses the risk chain. Control: a Candidate list with an outside entry. |
| R18 | One case per exclusion step, in order, with the first reason only. A router model is excluded as `unknown`. A gate refusal for a repo-denied workspace excludes. An expected cost above the $5 reservation excludes. Two picks within a minute that together pass the daily cap: the second is excluded. A window at 90% excludes. Control: Usage admitting a gate-refused Candidate. |
| R19 | With the per-model map, `cursor:claude-sonnet-5.5` is `anthropic`, so a `claude` reviewer is excluded for it. A model no pattern matches keeps its preset's family, not `unknown`. A `zai` implementer excludes a `zai` reviewer. An implementer that would leave a one-family `review` chain empty is excluded. Control: the rule off; nothing is excluded. |
| R20 | A table over every row of `rules-v1`, including unknown signals. Control: risk with size S, which is still `hard`. |
| R21 | Each Tier's key, term by term. Shuffled Candidates give the same pick. Control: a key that ignores the Role's order on a tie. |
| R22 | A property test: random inputs, picked twice and replayed from the stored inputs, give equal picks, also after the Task ceiling changes and the Outcomes age out. Control: a `Math.random` planted in a test double, which the replay test catches. |
| R23 | Every pick has a Reason; every exclusion has one. The Reason schema refuses free strings above 64 characters. Control: a title smuggled into a Reason. |
| R24 | The chain is the pick, then the rest in Role order. None eligible gives "resolve as today". Control: a chain that drops a fallback. |
| R25 | `decide` and `RouterService.route` leave the policy's chains and the fake engines settings byte-equal. Control: a pick that marks a provider. |
| R26 | Facts are append-only, with source precedence, and `unknown` after 7 days. A lane's STATUS line is refused as a source. A `review` fact is refused when it comes from the judged lane, lacks `--by`, or either route has no lane. A route without `ran` doesn't count as a round. A Lease whose lane now holds another board task doesn't join an old route. Control: an `estimate` that lowers a `provider` cost. |
| R27 | Histories: promote after 4 of 5; demote after 3 of 5; held at routine; a pin stops both. A held Candidate stays held after 120 days without Outcomes. Two `implement-*` Roles with different first entries both start trusted, and a later Role doesn't lower either. Control: a promotion at 3 of 5. |
| R28 | Each setting change, judged by effect. Auto off for a Role whose plain order starts on a key needs step-up. Holding `cursor` where `glm` shares the chain needs step-up. Holding `glm` alone needs only a session, as does a lower cap. Control: raising the ceiling without step-up. |

**Architecture:**
- `packages/domain/test/architecture.test.ts` also forbids `Math.random` in `auto-routing.ts`.
- `no-vendor-names` covers the new module and `router-service.ts`.
- The protocol's wire allowlists cover `AutoPickView`, the page's `auto` part and the catalog's `families`.

**Application** (`apps/connections/test/router.test.ts`, with fakes):
- `route` stores its inputs before answering;
- `why --replay`;
- `run` with a route (flag or `MORNDO_ROUTE`) launches the route's entry for its Connection, reserves the route's reserve, and appends `ran` at grant and cost at close;
- `sweep` joins board moves and ledger rows;
- `outcome` from the review step, with `--by`;
- a TaskSource that fails gives the defaults, not an error;
- `publishOwned` registers `family_by_model` with `*` last as the preset's family;
- two `route` calls racing on one key's daily cap: the second sees the first's pending cost.

**Contract test of the resolver** (`apps/connections/test/router-contract.test.ts`), against the fake engines CLI that the hub's tests use, extended:
- the answer's chain is a subset of `get --json` for the Role, risk included;
- Morndo's family exclusion agrees with `resolve --implementer` on the same settings, including a Claude model inside Cursor;
- `route` never calls `resolve`;
- with the hook fixture, a router that exits 1, or takes 3 s, leaves `resolve` choosing as today.

The same file runs against the real engines CLI when `ENGINES_BIN` is set, outside CI (as `e2e:engines`). A run without it reports the real-CLI cases as skipped, never as passed.

**CLI** (`apps/connections/test/auto-cli.test.ts`): `priority auto on|off`, `role … auto off`, `auto set`, `route --json`, `why --replay`, `outcome --by`, `scorecard`, `trust`, and the typed confirmation on every widening change.

**End to end** (`e2e/auto-routing.e2e.ts`, `npm run e2e:auto`):
- **Setup:** the hub, the web app and the connections program on a scratch HOME and random ports, with the fake engines CLI, a `cursor` subscription with a fake runtime, and a `glm` key on a fake vendor.
- **Steps:**
  1. Open the LLM connections page, turn Auto on, and save with the virtual authenticator's step-up. `engines get` shows the same chains as before.
  2. The `implement-backend` card shows "Auto picks": routine → `glm`, hard → `cursor`.
  3. Run `route` for T-1 ("docs: …", S) and for T-2 (`--risk`). The picks are `glm` and `cursor`.
  4. Reload. "Last picks" shows both, with their reasons. Opening T-1's row shows what `why rt-1` prints.
  5. Set the Role to Hand. `route` answers "not auto" and the card says so.

## 12. Manual QA checklist

Recorded outside this tree, with screenshots.

**Desktop:**
1. Install from the branch build on a scratch HOME. Add `cursor` (subscription) and `glm` (Z.ai key, budget $20) and acknowledge their terms. `morndo-connections check` passes for both.
2. On the LLM connections page, the Priority section shows the Auto switch above the five modes. Turning it on lists the Roles it covers and the starting Standings (`cursor` trusted, `glm` on probation), and says no chain changes. Save asks for the passkey. `engines get` shows the same chains as before.
3. The `implement-*` cards show "Auto picks" for each Tier, with reasons. The `plan` and `review` cards show "Auto: Off" (owner decision 1).
4. *(From PR 6, through the lane starter's `--engine auto`; before it, through `route` and `--engine` by hand.)* Start two real tasks: a small docs task and a risk-area change. They start on `glm` and `cursor` respectively. Each run's route links to its board task, and `why` for each matches the card's "Last picks".
5. Lower `glm`'s budget below a task's expected cost. The next routine task picks `cursor`, with the Reason "glm: budget".
6. Turn Auto off for `implement-ui`: its card says the chain runs in order, and `route` answers `role-off`. Set `implement-backend` to Hand: the card says Auto doesn't route it. Edit a derived Role's chain with `engines set`: its card says Auto waits.
7. Hold `glm` from the Scorecard. The next routine task picks `cursor`, and an Alert shows. Release it, which asks for the passkey.
8. `why rt-N --replay` says "same pick" for every pick of the session, also after the Task ceiling was changed.
9. Keyboard only: every control is reachable and labelled. Standings and levels read as words. Run the contrast check.

**Phone** (the settings sheet → LLM connections, at 390 px width):

10. Turn Auto on and save with the passkey. The cards sit in one column, with no sideways scrolling.
11. "Auto picks" and "Last picks" wrap and stay readable. A row opens the Why sheet, and going back returns to the card.
12. Offline, a save is refused, not queued (Commands, AC7). Back online, it succeeds after step-up.

## 13. Build plan: small stacked PRs

| PR | What | Done when |
|---|---|---|
| 1 | **Domain, catalog and docs:** `auto-routing.ts` (profile to Tier, Candidates, exclusions, ranking, pick, Reasons; the Scorecard and Standing-move functions). `routing.ts`: the Priority's `auto` switch, the Role's Auto switch, Auto settings. The catalog's per-model `families` in `VendorPreset` and `vendors.json`, with router models as `unknown`. `docs/domain.md`: an Auto section under Engines, R16–R28, and U4, CN15 and ADR-0018 decision 9 amended. Protocol: `PolicyView` and `PriorityCommand` gain `auto`, plus `CONNECTION_WORDS.auto`, `AutoPickView` and the route answer schema. | Every row of section 11's domain table passes and its control fails. Turning Auto on leaves the derivation table unchanged under all five modes. The replay property holds over 1,000 random inputs. The wire allowlists, the catalog schema and the architecture test (no `Math.random`) are green, with controls. `npm test` is green. |
| 2 | **Application, launcher and CLI:** `RouterService`; the ports `TaskSource`, `UsageReader`, `Ledger`, `RouteStore`, `StandingStore` and the extended `RepoInspector`, `EngineSettings` and `Catalog`; `publishOwned` registering `family_by_model`; the migration for `routes`, `outcomes` and `standing`. The launcher change (section 7.1): `run --route` or `MORNDO_ROUTE`, the route's entry and reserve, the Lease's route and entry, `LeaseClosed`'s entry, model and route, and the `ran` and cost facts. The CLI: `priority auto`, `role … auto`, `auto show|set`, `route`, `why [--replay]`. The decision log line. | The application tests and the contract test pass against the fake engines CLI, including a Claude model inside Cursor. `route` p95 is under 300 ms on the fixture. A stored pick replays to the same pick after a settings change. With the board unreachable, the defaults apply. A fake `bin` shows whether `MORNDO_ROUTE` reaches it through the engine layer; the answer is recorded in the PR. The `LeaseClosed` allowlist test covers the new fields. Rounds and the daily cap count from routed Leases. |
| 3 | **The page:** the Auto switch and settings, the Roles-covered and starting-Standing preview, the Role cards ("Auto picks", "Last picks", the Auto switch, the `hand` and drifted notes), the Why sheet; the hub's commands with step-up from the effect check. | `e2e/auto-routing.e2e.ts` passes. Manual QA checklist items 1–3, 6, 9 and 10–12 pass. A test checks that the page's words come from `CONNECTION_WORDS.auto`. **Option A is usable from here.** |
| 4 | **Outcomes:** `sweep` (board moves, ledger rows); `outcome --by`; the Scorecard read model; `scorecard`. Ranking stays rules-only. `why` also shows what the Scorecard would have picked (shadow). | Ingestion tests: send-backs counted, `unknown` after 7 days, source precedence, a STATUS line and a same-lane or lane-less `review` fact refused. The shadow pick appears in `why`. The cost priors are recalibrated from recorded runs, in a new rules version. |
| 5 | **Learned Standing (option B on):** Standing moves on landing Outcomes, holds and pins; the quality bands and the recorded medians in ranking; Alerts; `trust`; the page's Scorecard. | The R27 histories pass, including a hold that outlives its window. The e2e, with seeded outcomes, shows a promotion changing a standard-tier pick. Manual QA items 5, 7 and 8 pass. |
| 6 | **Wiring:** the two asks land in the engine layer's own repo; Morndo's route answer is frozen by the contract test; `docs/agents/` gains the manager's block ("start execution lanes with `--engine auto`; pass `--task`"). | A lane started by the engine layer with `--engine auto` runs the router's pick. A forced 75 falls to the next entry. With the router stopped, resolution is as today (a drill, with its log line). Manual QA item 4 passes through the hook. |

Each PR has its rollback. Turning Auto off leaves every chain as projected, since auto never wrote one (R25). PR 2's Lease fields are additive, and a `run` without a route behaves as today.

## 14. Limits, risks, and what would change this

- **Heuristic signals.** Kind and size come from titles, branches, briefs and diffs. Their agreement with the actual diff is measured (section 10). A model may later label them behind a cache, as one more signal; it never picks (ADR-0020, option C).
- **Unknown costs.** Cursor's per-run cost isn't visible to Morndo (UNVERIFIED), so a Cursor subscription ranks by quota. The token priors are placeholders until PR 4.
- **Large tasks stay off metered keys** while the Role's reserve is $5 (section 6.2). Raising the reserve is the principal's widening change (CN13).
- **Small samples.** One user gives 5–20 outcomes per cell, hence the bands, the "k of n" wording, and promotion that needs 4 of the last 5.
- **Lenient reviews inflate a model's record.** Demotion, pins, the visible Scorecard and per-Tier promotion limit the damage.
- **Same-user trust** (ADR-0018 §5.3). `--by` and the lane check stop the plain case of a run grading itself. A process of the same user that forges a route id is recorded, not prevented.
- **The route id before ask 2** travels in the lane's environment. Whether the engine layer hands it to `bin` unchanged is UNVERIFIED until PR 2's check. If it doesn't, routed runs record `ran` from the ledger only, after ask 2, and until then the daily cap counts all of a key's spend that day.
- **Races.** A pick sees one moment. Routes are serialised on a node, and the gate catches a budget spent between the pick and the lease (75, fall-through). Interactive and Codex runs have no in-run cap (ADR-0018).
- **Per node.** Routes, Outcomes and Standing are per node, as Connections are. Connection names are the join key if a fleet-wide view comes later.
- **What would change this:**
  - a vendor publishes per-run cost for subscription runs;
  - the engine layer ships the router hook, or moves into Morndo (then only the adapter changes);
  - a vendor router reports the family of the model it chose;
  - Verification lands: Verdicts become a higher-trust Outcome source than the board.

## 15. Sources (read 2026-10-11)

- [P1] OpenRouter, Auto Router: task types, spend-share ranking, `cost_tier`, `allowed_models` and `excluded_models`, the `model` field, opt-in router metadata. https://openrouter.ai/docs/guides/routing/routers/auto-router
- [P2] Cursor Router: a classifier by task type and complexity; Cost, Balance and Intelligence; "Hidden is the default and recommended, so results are judged on their own merit rather than by model name"; Teams and Enterprise only. https://cursor.com/docs/cursor-router
- [P3] Cursor, "How Cursor Router chooses the right model for the task" (2026-08-06): a complexity score from 0 to 1 against a threshold; "Moving on to the next task is a strong positive signal, while correcting the agent is a strong negative one." https://cursor.com/blog/how-cursor-router-works
- [P4] Cursor, Models & Pricing: "All Auto modes bill at the list price of the model each request is routed to." https://cursor.com/docs/models-and-pricing
- [P5] Claude Code, model configuration: aliases; `opusplan`; `fallbackModel` and `--fallback-model` ("tries them in order, showing a notice when it switches"; "the switch lasts for the current turn only"); the model in the status line and `/status`. https://code.claude.com/docs/en/model-config
- [P6] LiteLLM, Router: routing strategies, fallbacks, order-based failover, cooldowns, `x-litellm-model-id`. https://docs.litellm.ai/docs/routing
- [P7] LiteLLM, Auto Routing: a heuristic scorer over seven dimensions with zero API calls; tiers SIMPLE, MEDIUM, COMPLEX, REASONING; an LLM classifier option; Thompson sampling; `session_affinity`; one log line per decision naming its cause. https://docs.litellm.ai/docs/proxy/auto_routing
- [P8] GitHub Copilot, auto model selection: health and task complexity; "subject to your policies and subscription type"; "You can see which model was used for each Copilot response." https://docs.github.com/en/copilot/concepts/auto-model-selection
- Engine layer, read 2026-10-11: `resolver.py` (availability, marks, the family rule, exit 3), `config.py` (`family`: a fixed family, else `family_by_model`, else `unknown`), `lane.py` (the mid-task switch takes the first available entry of the Role's chain other than the current one), and its CLI help (`resolve`, `implementers`). Z.ai preset and prices: the `feat/zai-glm` branch's catalog and its source [S26] (2026-10-10).

## Decisions for the owner

1. **When Auto starts acting.** Default: right away, for the implement Roles only (backend, UI, infra). Plan, review, research and validate keep their order until you turn Auto on for them. The alternative is a week in which Auto only shows what it would pick.
2. **How much Auto may spend on a key without asking.** Default: at most $3 expected per task and $10 a day per metered key, always within the key's own budget. Above that, Auto uses your subscriptions.
3. **When Morndo can't see a subscription's quota** (Cursor reports none today). Default: keep Cursor for hard and risky work, and send small routine tasks to GLM. The alternative is to use Cursor first until it runs out, which is today's order.
4. **New models earn harder work.** Default: a model new to a Role (GLM now) starts on routine tasks. It moves up a level after 4 of its last 5 are accepted first try, and down after 3 of 5 are sent back. The alternative is to trust it for every task from the start.
