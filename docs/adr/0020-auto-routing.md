# ADR-0020: Auto routing: Morndo picks, per run, which allowed Connection does a Role's work, and says why

- **Status:** Proposed, 2026-10-11, revised the same day after two rounds of fresh-context review. Design: [`docs/design/auto-routing/README.md`](../design/auto-routing/README.md). Design only; no product code.
- **The request (2026-10-11):** for execution, switch between a Cursor subscription and GLM through a Z.ai key. Morndo decides which one runs when, so the settings need an Auto mode.
- **Number:** 0019 belongs to the releases-and-updates draft, not yet on `main`.
- **Builds on:**
  - ADR-0013: Roles, chains, and the engine layer's resolver.
  - ADR-0015: the board's tasks, send-backs and done.
  - ADR-0016: Usage windows.
  - ADR-0018: Connections, the Lease gate, and the Routing policy with R7–R15.
  - The Z.ai preset on `feat/zai-glm`: `zai`, family `zai`, `glm-5.3` and `glm-5.3-flash` with dated prices.
- **Amends** (decision 7), narrowly, every rule that says Usage or spend decides nothing beyond the gate:
  - U4 and CN15 in `docs/domain.md`;
  - ADR-0018 decision 9 ("decide nothing");
  - the secret-store design §7.1.
- **Sources:** [P1]–[P8] in the design, section 15, all read 2026-10-11.

## Context

1. **Today the user orders, and the engine layer resolves.** A Role's derived chain comes from its Picks and the Priority (ADR-0018, five modes). Morndo writes the chain through the engines CLI.
   - At start, the engine layer runs the first available entry.
   - After a quota, billing or auth failure, its mid-task switch takes the first available entry of that chain other than the current one.
   - So every task of a Role starts at the same entry.
2. **The ask is per task.** A docs fix and a change to the auth middleware should not start on the same engine. Morndo should decide, only among the Connections and Roles the user allowed, and say why.
3. **Trust is the product.** Morndo exists because the output of the tools tried before couldn't be trusted (README, "Why I built this"). So a model new to this user must earn harder work, and every choice must be visible and checkable afterwards.
4. **Rules already in force bind auto too:**
   - the gate refuses a run that is off, out of budget, outside the repo list, or short of isolation (CN8);
   - a `hand` Role is the user's own chain (R10);
   - an outside edit makes a Role drifted (R14);
   - the reviewer comes from another model family when the rule is on (ADR-0013);
   - availability never reorders a chain (R8).
5. **What others do** (design, section 2):
   - The routers that pick for the user work only inside a set the user allows [P1, P2, P8].
   - Most start with a cheap classifier of task type or complexity [P1, P3, P7].
   - They report the model that actually ran [P1, P5, P6, P8]. LiteLLM also logs one line naming the cause [P7]. Cursor hides the routed model by default [P2].
   - Fallback on failure stays separate from routing [P5, P6].
   - Cursor's router learns from what the user does next: "Moving on to the next task is a strong positive signal, while correcting the agent is a strong negative one" [P3].
   - Vendor routers can't serve here. Each stays inside its own vendor, bills at the routed model's list price [P4], and leaves the family of the model it chose unknown.
6. **Gaps found in the code:**
   - Morndo registers each Connection with its preset's one family, so a Claude model inside Cursor counts as family `cursor`. The engine layer itself can map families per model (`family_by_model`).
   - The launcher leases with the preset's default model as the entry.
   - `LeaseClosed` carries no entry, no model and no route.

## Decision

1. **Auto is a switch beside the Priority's mode, not a sixth mode.**
   - The global Priority becomes a mode, an order and `auto` (on or off).
   - Each Role has an **Auto switch**: on by default for the `implement` group, off for every other Role (owner decision 1). A Role's own Priority (`own`) shapes only its chain and has no switch of its own.
   - A run is auto-routed when the global Auto is on, the Role's switch is on, and the Role is neither `hand` nor drifted.
   - The five modes still derive the chain exactly as today (R8, R10). Under Auto, that chain is the run's **allowed set** and its **fallback order**. Turning Auto on or off changes no derived chain and projects nothing.
   - For each run, Morndo chooses which entry of the chain starts.
   - A sixth mode was rejected after review. A mode replaces the Kind partition, so switching to it would re-derive and re-project the chain of every Role that follows the global Priority, including Roles that opted out.
2. **One pure function decides.** `packages/domain/src/auto-routing.ts` turns a **Run request** into an **Auto pick**:
   - It derives a **Task profile** from deterministic signals: role, risk, kind, size, round, priority, repo and implementers, each with its source.
   - It maps the profile to a **Tier**: `routine`, `standard` or `hard`.
   - It takes the Role's chain entries as **Candidates**.
   - It excludes Candidates by fixed hard limits, each with its first reason, in this order:
     - not in the allowed set;
     - a vendor router model;
     - the engine layer's availability;
     - the gate's dry run;
     - budget, against both the gate's reservation and a daily cap;
     - a nearly spent quota window;
     - the review rule;
     - a `held` Standing.
   - It ranks the rest by a short lexicographic key per Tier. The Role's order is the last key.
   - No clock and no randomness inside: `now` is an argument, ties break by the Role's order, and the result doesn't depend on the order the Candidates arrive in.
   - **Families are per model.**
     - The catalog gains an ordered per-model family map. Router models (Cursor `auto`, `openrouter/auto`) map to `unknown`, and a model no pattern matches keeps the preset's family.
     - Morndo registers the map with the engine layer as `family_by_model`, ending with `*` as the preset's family, instead of one fixed family per provider.
     - So the resolver and Morndo judge the review rule on the same family, and nothing outside Auto changes for an unmatched model.
3. **Rules first, then a learned Scorecard (option B), shipped in that order.**
   - **Rules (PRs 1–3):**
     - Risk, a third round, or size L or XL make a task `hard`.
     - A small docs, test, chore or fix task (review fixes included) that isn't high priority is `routine`. Everything else is `standard`.
     - `hard` ranks by Standing, then quality.
     - `standard` ranks by Standing, then cost, then quality.
     - `routine` ranks by cost first.
     - A subscription whose quota Morndo can't see, or whose weekly window is past the **Save line**, is kept for harder work.
     - A metered key comes before a kept subscription only while its expected cost for the task is at or under the **Task ceiling**.
   - **Scorecard (PRs 4–5):**
     - **Outcomes** are recorded per Auto pick: the entry that ran, accepted first try, send-backs, review findings, fix rounds, cost and time.
     - They feed a **Scorecard** per entry that ran, role group and Tier. The Scorecard sets the quality band and the recorded cost and time.
     - Its counts move a persisted **Standing** per Candidate and role group: held, or trusted up to a Tier.
     - The first entry of each Role's chain starts trusted. Across one group, the higher start wins.
     - Any other Candidate starts on probation (trusted up to routine). On routine work it competes equally. On standard and hard work it comes after trusted Candidates.
     - It moves up after 4 of its last 5 tasks at its highest Tier were accepted first try. It moves down after 3 of 5 were sent back.
     - Standing changes only when an Outcome lands or the principal pins it. It never decays because old Outcomes leave the window.
     - Bands and counts, not decimals or sampling, so a pick stays reproducible and its reason stays one sentence ("4 of 5 accepted first try").
4. **Every pick is stored with its inputs and reasons before its chain is answered.** The inputs are:
   - the profile;
   - each Candidate's facts and verdict;
   - the Auto settings in force;
   - the Scorecard cells used;
   - the policy and rules versions;
   - `now`.

   How they are used:
   - `morndo-connections why <run>` prints them.
   - `why --replay` recomputes the pick from them and must get the same one. Later settings changes and Outcomes aging out don't affect a replay.
   - Reasons are codes with numbers, rendered from the protocol's words table. They never carry brief text, a title or a description. The brief is kept only as a digest and counts.
5. **Fallback is unchanged.**
   - The run's chain is the pick, then the rest of the derived chain in the Role's order. On a failure, the engine layer's mid-task switch takes the first available entry of the Role's chain other than the current one, which is that same order.
   - A refused lease (exit 75) or a failed run falls through as before.
   - If auto finds no eligible Candidate, or the router fails or is slow, the run resolves the derived chain as today. Auto never stops work.
6. **Where it reaches the run:**
   - `morndo-connections route --role R …` answers one JSON line: a route id and the run's chain.
   - Until the engine layer can call it, whoever starts the run passes the pick as `--engine`, `--model` and `--effort`, and exports the route id as `MORNDO_ROUTE` in the lane's environment.
   - **The launcher records what ran** (PR 2):
     - `run` takes `--route`, else `MORNDO_ROUTE`.
     - It launches the route's entry for its own Connection with the route's reserve, the per-Role **Reserve** setting ($5 by default, as today).
     - The Lease keeps the route and the entry.
     - `LeaseClosed` gains the entry, the model reported and the route.
     - At grant and at close, `run` appends the `ran` and cost facts to the route.
     - Whether the engine layer hands the lane's environment to `bin` unchanged is UNVERIFIED until PR 2 checks it.
   - Two additive asks of the engine layer:
     - a `router` setting, which `engines resolve` and its `--engine auto` start call, with a timeout and a fall-back to the Role's chain;
     - `--route ID` passed to `bin`, and written into its ledger row.
   - The router never calls `engines resolve`, so the two can't loop.
7. **Usage and spend may rank and exclude, narrowly.**
   - Under Auto, a subscription's Usage window and a key's expected cost, remaining budget and daily cap may **rank or exclude** a Candidate.
   - They still grant nothing.
   - They never admit a Candidate the gate refuses.
   - They never move a pick outside the Role's allowed set.
8. **Settings are Commands, judged by effect.**
   - A change is narrowing only when no metered Candidate can gain work or spend from it: a lower Task ceiling, daily cap or reserve, or a hold or lower pin on a Candidate that shares no chain with another metered Candidate. A session is enough for those.
   - Everything else needs step-up (AC7, CN13), or a typed confirmation at the machine:
     - Auto on or off, and a Role's switch. Off counts, because it returns a Role to its plain order, which may start on a metered key.
     - A Save line change.
     - A raised ceiling, cap or reserve.
     - A higher pin, or a release.
     - A hold or lower pin whose work could move to a key.
   - Automatic Standing changes are the only exception (as R12 and R15 are), and each one raises an Alert.
9. **The settings page and the CLI:**
   - The Priority section gains **Auto: Morndo picks per task**, an on or off switch above the five modes. Under it, the order list reads **Fallback order**.
   - Auto's settings: the Task ceiling, the Save line, a daily cap per metered key, and a reserve per Role.
   - Each Role card shows:
     - "Auto picks: X because …" for each Tier;
     - its last picks, each linking to `why`;
     - its Auto switch;
     - its Scorecard.
     A `hand` or drifted Role says why Auto doesn't route it.
   - The CLI gains `priority auto on|off`, `role ROLE auto on|off`, `auto show|set`, `route`, `why`, `outcome`, `scorecard` and `trust`.
   - The build ships the program as `morndo-keys`, and every command runs under that name too.

## Alternatives

| Option | Verdict |
|---|---|
| **A: deterministic rules only** (task kind, size, role, availability, quota, budget) | **Built first, as B's floor.** Explainable, testable, reproducible, needs no data. Alone it is static. Its size and kind heuristics are crude, and it can't notice that a model does badly on this user's repos or reviews. The user would tune it by hand, which is the work they asked Morndo to take. |
| **B: rules plus a Scorecard from recorded Outcomes** (accepted first try, review findings, fix rounds, cost, time) | **Chosen.** It learns from the signal this user already trusts: whether their board and their review accepted the work. It stays deterministic: bands over windows, no sampling, the cells used stored with each pick. Probation gives new models a safe way in. Costs: plumbing from the board, the review step and leases; small samples per cell (5–20), so bands, not decimals; and a feedback loop where probation sees only easy work. Promotion is therefore per Tier, and demotion watches the first harder tasks. |
| **C: ask a model to route** | **Rejected as the decider.** Each pick costs a call and latency. The same brief can route two ways, so a pick can't be replayed. The brief, which may hold employer or client material, goes to one more model. Text in a task could steer spend toward a key. The explanation is the model's account of its choice, not the cause. Vendor routers do this on millions of users' data [P1, P3]; one user has none. A model may later *label* kind or size behind a cache, as one more signal the rules read; it never picks. |
| **D: hand the choice to a vendor router** (Cursor Auto, OpenRouter's auto) | **Rejected.** Each routes only inside its own vendor, so none can choose between Cursor and a Z.ai key. The family is unknown, so the review rule can't be applied. Cursor hides the routed model by default [P2]. Auto bills at the routed model's list price [P4]. Such models stay usable in a chain, but auto never picks them. |
| **E: a sixth Priority mode `auto`** | **Rejected after review.** A mode replaces the Kind partition, so switching to it re-derives every following Role's chain, including Roles that opted out. A switch beside the mode changes no chain. |
| **F: Thompson sampling over a pool** [P7] | **Rejected for now.** Random by design, so a pick can't be replayed, and it spends real tasks to explore. Probation explores only on routine work, and deterministically. |
| **G: rewrite the projected chain per task** | **Rejected.** The chain is per Role, so two tasks of one Role running at once would race, and every pick would look like drift (R14). The pick lives with the run, and the chain stays the safety net. |
| **H: the engine layer applies the rules** | **Not now**, for the reason ADR-0018 gave: the domain rule would move to another repo in another language. With the router hook, the engine layer only asks and keeps its own checks. |

## Consequences

- **Good:** Auto in the settings does what was asked.
  - Routine work goes to the cheap key while it stays at or under the Task ceiling.
  - Hard work stays on the trusted subscription.
  - A model new to the user earns its way up.
  - Every run says which engine ran and why, in one line and in `why`.
- **Good:** the hard rules hold by construction.
  - The pick is an entry of the allowed chain.
  - The gate's dry run, the budget and the review rule exclude before ranking.
  - Fallback and the gate's last word are untouched.
  - Turning Auto on or off changes no chain.
- **Good:** Outcomes are a record of how each model did on this user's work, in their repos, judged by their board and their review. That record is also what later work on Verification needs.
- **Cost:**
  - one pure module, two tables (`routes`, `outcomes`) and a Standing table in the connections database;
  - a per-model family map in the catalog and in the engine-layer registration;
  - `--route` (or `MORNDO_ROUTE`) on the launcher, which then runs the route's entry with its reserve, and the entry, model and route on `LeaseClosed`;
  - a board reader;
  - an `outcome` command for the review step;
  - two additive asks of the engine layer;
  - a section of the settings page.
- **Limit:**
  - The size and kind signals are heuristics. Their agreement with the actual diff is measured, not assumed.
  - The cost priors (catalog price times a token estimate per size) are placeholders until recorded runs replace them.
  - Cursor's per-run cost is unknown to Morndo (UNVERIFIED), so a Cursor subscription ranks by quota, not by dollars.
- **Limit:** with the launcher's default reserve of $5, a metered key's prior for L or XL work is above the reservation the gate would grant. So Auto never sends L or XL work to a metered key unless the Role's reserve is raised. That is the budget rule working, and the page says so.
- **Limit:** a pick is decided on the inputs it saw.
  - Concurrent picks see each other: `route` runs one at a time, and a pick not yet leased counts against the daily cap at its expected cost.
  - A budget spent between the pick and the lease is still caught by the gate (exit 75), and the run falls through.
  - Interactive and Codex runs have no in-run cap (ADR-0018).
- **Limit:** same-user trust (ADR-0018 §5.3). A `review` Outcome must name the reviewing run, from another lane than the judged one. A process of the same user can still forge one, which the record shows but can't prevent.
- **Risk:** a lenient review promotes a weak model. Demotion, per-Tier promotion, pins and the visible Scorecard limit the damage. The principal can hold a Candidate in one tap.
- **Risk:** a model that is never the cheapest for routine work never leaves probation. That is acceptable: it stays a fallback, and the user can trust it by hand.

## Verification this implies

1. One negative-control test per invariant R16–R28 (design, section 4.3), with a fake clock, plus:
   - a table of profiles to Tiers and of rankings per Tier;
   - a replay property: shuffled Candidates, repeated runs, and settings changed after the pick all give the same pick;
   - histories for promotion, demotion, holds and pins, and a Standing that survives its Outcomes aging out.
2. A contract test of the resolver against the fake engines CLI:
   - the router's chain is always inside the Role's chain;
   - Morndo's family exclusion agrees with `engines resolve --implementer`, including a Claude model inside Cursor;
   - the router never calls `resolve`;
   - a failed or slow router leaves resolution as today.

   The same test runs against the real CLI locally, outside CI, as `e2e:engines` does. A skipped run is reported as skipped.
3. An e2e that switches Auto on in the UI, then routes a small docs task and a risk-area task on one Role, and sees two different picks with their reasons on the Role card and in `why`.
4. Manual QA on desktop and phone (design, section 12), recorded outside this tree.
5. Re-check triggers:
   - a vendor publishes per-run cost for subscription runs (Cursor);
   - the engine layer ships the router hook or changes its mid-task switch;
   - Claude Code changes `opusplan` or fallback models [P5];
   - a vendor router starts reporting the family of the model it chose.
