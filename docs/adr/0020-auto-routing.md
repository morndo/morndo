# ADR-0020: Auto routing: Morndo picks, per run, which allowed Connection does a Role's work: hard rules first, then a fenced decision step, with the rules as the floor

- **Status:** Proposed, 2026-10-11. Revised the same day after two rounds of fresh-context review, and again the same day to a hybrid router after the owner's answer to decision 1. Design: [`docs/design/auto-routing/README.md`](../design/auto-routing/README.md). Design only; no product code.
- **The request (2026-10-11):** for execution, switch between a Cursor subscription and GLM through a Z.ai key. Morndo decides which one runs when, so the settings need an Auto mode.
- **The owner's answer to decision 1 (2026-10-11):** "A combination. Maybe a lightweight model to decide... research the web when to use what model and if we could use something like decision api to make it more easy. In general maybe how we can use decision api."
- **Number:** 0019 belongs to the releases-and-updates draft, not yet on `main`.
- **Builds on:**
  - ADR-0013: Roles, chains, and the engine layer's resolver.
  - ADR-0015: the board's tasks, send-backs and done.
  - ADR-0016: Usage windows.
  - ADR-0018: Connections, the Lease gate, and the Routing policy with R7–R15.
  - The Z.ai preset on `feat/zai-glm`: `zai`, family `zai`, `glm-5.3` and `glm-5.3-flash` with dated prices.
- **Amends** (decision 12), narrowly, every rule that says Usage or spend decides nothing beyond the gate:
  - U4 and CN15 in `docs/domain.md`;
  - ADR-0018 decision 9 ("decide nothing");
  - the secret-store design §7.1.
- **Sources:** [P1]–[P17] in the design, section 18, all read 2026-10-11.

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
   - Most start with a cheap classifier of task type or complexity [P1, P3, P7]. OpenRouter's "degrades gracefully to a default model set" when classification is unavailable [P1].
   - RouteLLM turns a predicted probability into a choice with a threshold, and judges routers by cost–quality curves against fixed baselines [P14].
   - They report the model that actually ran [P1, P5, P6, P8]. LiteLLM also logs one line naming the cause [P7]. Cursor hides the routed model by default [P2].
   - Fallback on failure stays separate from routing [P5, P6].
   - Cursor's router learns from what the user does next: "Moving on to the next task is a strong positive signal, while correcting the agent is a strong negative one" [P3].
   - Vendor routers can't serve here. Each stays inside its own vendor, bills at the routed model's list price [P4], and leaves the family of the model it chose unknown.
6. **The owner asked for a combination with a lightweight model, and for a look at a decision API.** The first design rejected a model as the decider: a pick couldn't be replayed, the brief would leave the machine, its text could steer spend, and its explanation wouldn't be the cause. Each objection has an answer if the model is fenced (decision 5).
7. **A decision API exists, in beta** (design, section 2.1, checked on the vendor's pages):
   - OpenAI's Decisions API, released 2026-10-06 in public beta; GA expected "in the coming weeks" [P9, P11].
   - One model, `gpt-6-luna`, on `POST /v1/decisions` [P9].
   - A `choice` question returns one of 2 to 255 supplied values, a probability per value, and a `confidence` the docs don't define [P9, P10].
   - A question may come back as a refusal [P10].
   - $0.10 per 1M input tokens, nothing for output or cache; 10% more on a regional endpoint [P9, P12].
   - Data isn't used for training; abuse-monitoring logs are kept up to 30 days by default; Zero Data Retention for eligible customers; regional processing in the United States and Europe, with vendor approval for non-US regions [P13].
   - The vendor's advice: include a fallback option, and "use labeled examples from your application to set thresholds" [P9].
8. **What the vendors say about which model to use** (design, section 2.2): Anthropic starts most workloads on Opus 5.5, puts everyday coding on Sonnet 5.5 and the lowest latency and price on Haiku 5.5, says "tuning effort is often a better lever than switching models", and that "a good evaluation set is the most important step" [P16]. Z.ai calls GLM-5.3 its "latest flagship model" and recommends `max` effort for coding [P17].
9. **Gaps found in the code:**
   - Morndo registers each Connection with its preset's one family, so a Claude model inside Cursor counts as family `cursor`. The engine layer itself can map families per model (`family_by_model`).
   - The launcher leases with the preset's default model as the entry.
   - `LeaseClosed` carries no entry, no model and no route.

## Decision

1. **Auto is a switch beside the Priority's mode, not a sixth mode.**
   - The global Priority becomes a mode, an order and `auto` (on or off).
   - Each Role has an **Auto switch**: on by default for the `implement` group, off for every other Role. A Role's own Priority (`own`) shapes only its chain and has no switch of its own.
   - A run is auto-routed when the global Auto is on, the Role's switch is on, and the Role is neither `hand` nor drifted.
   - The five modes still derive the chain exactly as today (R8, R10). Under Auto, that chain is the run's **allowed set** and its **fallback order**. Turning Auto on or off changes no derived chain and projects nothing.
   - For each run, Morndo chooses which entry of the chain starts.
   - A sixth mode was rejected after review. A mode replaces the Kind partition, so switching to it would re-derive and re-project the chain of every Role that follows the global Priority, including Roles that opted out.
2. **Three stages per run, in this order** (design, section 6):
   1. **Hard rules** exclude what may not run.
   2. **A decision step** may choose among what the rules accept.
   3. **The rules and the Scorecard** decide whenever the decision step doesn't act. Their pick is computed for every run, whether or not the decider is asked.
3. **The hard rules.** `packages/domain/src/auto-routing.ts` turns a **Run request** into a **Task profile** (role, risk, kind, size, round, priority, languages, implementers, each with its source) and a **Tier** (`routine`, `standard`, `hard`). It takes the Role's chain entries as **Candidates** and excludes them by fixed limits, each with its first reason, in this order:
   - not in the allowed set;
   - a vendor router model (family `unknown`);
   - the engine layer's availability;
   - the gate's dry run;
   - budget, against both the gate's reservation and a daily cap;
   - a nearly spent quota window;
   - the review rule;
   - a `held` Standing.

   With decision 1, these are the owner's list: the gate, budgets, each Role's allowed Connections, the principal's caps, a reviewer from another provider, and `hand` Roles never routed. **Families are per model:** the catalog gains an ordered per-model family map, router models map to `unknown`, and an unmatched model keeps the preset's family. Morndo registers the map with the engine layer as `family_by_model`, ending with `*` as the preset's family. So the resolver and Morndo judge the review rule on the same family.
4. **The rules and a learned Scorecard (option B) rank what is left** and give the **rules pick**: the floor, the fallback, and the decider's baseline.
   - **Rules:**
     - Risk, a third round, or size L or XL make a task `hard`.
     - A small docs, test, chore or fix task (review fixes included) that isn't high priority is `routine`. Everything else is `standard`.
     - `hard` ranks by Standing, then quality, then the model's class in its own vendor's line-up (`flagship`, `everyday`, `fast`, from the vendor's docs [P16, P17]), then the Role's order. This user's own record outranks the vendor's prior.
     - `standard` ranks by Standing, then cost, then quality.
     - `routine` ranks by cost first.
     - A subscription whose quota Morndo can't see, or whose weekly window is past the **Save line**, is kept for harder work.
     - A metered key comes before a kept subscription only while its expected cost for the task is at or under the **Task ceiling**.
   - **Scorecard:**
     - **Outcomes** are recorded per Auto pick: the entry that ran, accepted first try, send-backs, review findings, fix rounds, cost and time.
     - They feed a **Scorecard** per entry that ran, role group and Tier. The Scorecard sets the quality band and the recorded cost and time, and supplies each option's record to the decider.
     - Its counts move a persisted **Standing** per Candidate and role group: held, or trusted up to a Tier.
     - The first entry of each Role's chain starts trusted. Across one group, the higher start wins.
     - Any other Candidate starts on probation (trusted up to routine). On routine work it competes equally. On standard and hard work it comes after trusted Candidates.
     - It moves up after 4 of its last 5 tasks at its highest Tier were accepted first try. It moves down after 3 of 5 were sent back.
     - Standing changes only when an Outcome lands or the principal pins it. It never decays because old Outcomes leave the window, and a decider answer never moves it.
     - Bands and counts, not decimals or sampling, so a pick stays reproducible and its reason stays one sentence ("4 of 5 accepted first try").
5. **The decision step: a fenced decider through a port.**
   - **Fences first.** The decider chooses among acceptable options; it never decides what is acceptable. The **option set** is the eligible Candidates less three Fences, plus the rules pick if a Fence removed it:
     - the **trust floor**: a Candidate not trusted for the Tier, while one trusted for it is eligible;
     - the **Task ceiling**: a metered Candidate expected to cost more, or one whose cost is unknown;
     - **kept for harder work**: on routine work, a kept subscription.

     With fewer than two options, no call is made.
   - **A `DecisionPort`** in the application layer, with adapters:
     - `rules`: answers the escape value `rules` with probability 1, so the rules decide; free; the default and the test double;
     - `openai-decisions`: one `choice` question to `POST /v1/decisions`, whose values are opaque option ids plus an escape value `rules`, with each option's features in its description;
     - later, `local-model`: a small model on the node behind the same port, which may also read the title in memory because nothing leaves the node.

     The domain knows the question and answer shapes, never a vendor.
   - **The threshold.** A choice acts only at or above 0.80 on its own entry in `probabilities`. The answer's `confidence` is recorded and not used, since the docs don't define it. 0.80 is a starting value; the threshold is then set from this user's Outcomes, as the vendor advises [P9].
   - **The rules decide** when the answer is below the threshold, is the escape value, is a refusal, errs or passes the timeout (1 s by default, one deadline over the decider's Lease, the key and the call); and when the decider is off, unavailable, over its budget, or not opted in for the workspace. Also when the chosen Candidate is no longer in the option set recomputed inside the write transaction, by the hard rules and the Fences (`stale`).
   - **At most one call per route.** Morndo never asks again to get a different answer.
6. **Privacy: fields, not text** (design, section 10).
   - The decision input is built only from an allowlist: the task's role group, Tier, kind, size, risk, round, priority, languages and implementers' families; each option's catalog model id and effort, family, class, Kind, cost class and expected dollars, Standing, record, and window share.
   - Never sent: titles, descriptions, briefs, diffs, code, paths, branches, repo names, workspace ids, lanes, task keys, Connection names, keys, or the rules pick.
   - The allowlist is a schema, and a test feeds marker strings through every forbidden field and fails if one reaches the adapter.
   - **Opt-in per workspace:** none by default. The decider Connection's repo list must admit the workspace as well (CN8).
   - **Region:** global, United States or Europe, chosen by base URL [P13]. Data residency needs the vendor's eligibility check, and non-US processing also its approval of abuse-monitoring controls and a Modified Retention amendment. Morndo can't see either; `decider check` shows the vendor's answer.
7. **Cost: a Lease per call and a daily decider budget.**
   - The decider's Connection is an ordinary API-key Connection from a decisions preset (dialect `decisions`, no isolation needed, price dated 2026-10-11).
   - Each call leases on it (holder `decider`, the route's workspace, reserve $0.01), so its spend lands on that Connection's Budget (CN10) and the gate's checks apply unchanged.
   - Cost per decision is `usage.input_tokens` times the dated price, plus 10% on a regional endpoint: about $0.00005 for the 400–600 tokens a request takes (estimate, to be measured).
   - A **decider budget**, $0.25 a day per node by default (owner decision 6), is checked before each call. Over it, the rules decide until the next day, with one Alert.
8. **Evaluation: shadow first, acting per group and Tier, and an automatic way back** (design, section 11).
   - **Modes:** the decider is off (the default) or on. When on, each role group and Tier is in `shadow` (asked after the pick by a detached job, recorded, never acts) unless switched to `acting`.
   - **Shadow measures** agreement with the rules pick, the escape rate, calibration by probability band, cost, latency, and the lift on disagreement: how much more often the rules pick was sent back when the decider chose another option at or above the threshold than when it chose the rules pick. That shows whether its disagreement carries signal; only acting, against the holdout, shows how its own choices do.
   - **Switch-on rule:** at least 30 shadow decisions with Outcomes over at least 7 days; an answer rate of 95% or more and p95 latency within the timeout; at least 8 confident disagreements, with at least 3 send-backs of the rules pick among them, and a lift of 15 points or more; no option outside the set and no replay mismatch. Morndo proposes; the principal confirms with step-up. Routine first, then standard, then hard.
   - **While acting**, one route in five (by a hash of its id) is held out and decided by the rules, so the comparison never stops.
   - **Switch-back rule**, automatic and narrowing, with an Alert: first try accepted 20 points or more below the baseline over the last 10 acting picks; an answer rate below 90%, or p95 latency above the timeout over a day; a replay mismatch, a choice outside the offered set, or a schema failure; the budget spent 3 days running; or the vendor's model or terms change.
   - If shadow shows no lift, the decider stays off, and the rules are the product.
9. **Every pick is stored with its inputs and reasons before its chain is answered.** The inputs are:
   - the profile;
   - each Candidate's facts and verdict;
   - the Auto and decider settings in force;
   - the Scorecard cells used;
   - the decider record: the option set and id map, the input as sent, and the answer as received, or why no call was made;
   - the committed spend read before the call and re-read in the write transaction;
   - the policy, rules and decider versions;
   - `now`.

   How they are used:
   - `morndo-connections why <run>` prints them, and says which stage decided.
   - `why --replay` recomputes the pick from them, without calling the decider, and must get the same one. Later settings changes and Outcomes aging out don't affect a replay.
   - A shadow answer is appended after the chain is answered and never changes the pick.
   - Reasons are codes with numbers, rendered from the protocol's words table. They never carry brief text, a title or a description. The brief is kept only as a digest and counts.
10. **Fallback is unchanged.**
    - The run's chain is the pick, then the rest of the derived chain in the Role's order. On a failure, the engine layer's mid-task switch takes the first available entry of the Role's chain other than the current one, which is that same order.
    - A refused lease (exit 75) or a failed run falls through as before.
    - If auto finds no eligible Candidate, or the router fails or is slow, the run resolves the derived chain as today. Auto never stops work, and neither does the decider.
11. **Where it reaches the run:**
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
      - a `router` setting, which `engines resolve` and its `--engine auto` start call, with a 2-second timeout and a fall-back to the Role's chain;
      - `--route ID` passed to `bin`, and written into its ledger row.
    - The router never calls `engines resolve`, so the two can't loop. `route` has its own deadline of 1.8 s, under the hook's 2 s: an acting call starts only if its 1 s deadline fits, and shadow calls run in a detached job after the answer.
12. **Usage and spend may rank, fence and exclude, narrowly.**
    - Under Auto, a subscription's Usage window and a key's expected cost, remaining budget and daily cap may **rank, fence or exclude** a Candidate.
    - They still grant nothing.
    - They never admit a Candidate the gate refuses.
    - They never move a pick outside the Role's allowed set.
13. **Settings are Commands, judged by effect.**
    - A change is narrowing only when no metered Candidate can gain work or spend beyond what the rules pick, under the same caps, would give it, and no more data can leave the node. A session is enough for those:
      - a lower Task ceiling, daily cap or reserve;
      - a hold or lower pin on a Candidate that shares no chain with another metered Candidate;
      - the decider off, or a group and Tier back to `shadow`, which hand picks back to the rules pick;
      - a higher threshold or a lower decider budget;
      - a workspace removed from the opt-in.
    - Everything else needs step-up (AC7, CN13), or a typed confirmation at the machine:
      - Auto on or off, and a Role's switch. Off counts, because it returns a Role to its plain order, which may start on a metered key.
      - A Save line change.
      - A raised ceiling, cap or reserve.
      - A higher pin, or a release.
      - A hold or lower pin whose work could move to a key.
      - The decider on, a group and Tier to `acting`, a lower threshold, a raised decider budget, a workspace added to the opt-in, a new adapter, Connection or region.
    - Automatic Standing changes and the decider's automatic switch-back are the only exceptions (as R12 and R15 are), and each one raises an Alert.
14. **The settings page and the CLI:**
    - The Priority section gains **Auto: Morndo picks per task**, an on or off switch above the five modes. Under it, the order list reads **Fallback order**.
    - Auto's settings: the Task ceiling, the Save line, a daily cap per metered key, and a reserve per Role.
    - A **Decider** block: on or off, shadow or acting per group and Tier, adapter and Connection, region, opted-in workspaces, threshold, daily budget, and the shadow report.
    - Each Role card shows:
      - "Auto picks: X because …" for each Tier;
      - its last picks, each naming the stage that decided and linking to `why`;
      - its Auto switch;
      - its Scorecard.
      A `hand` or drifted Role says why Auto doesn't route it.
    - The CLI gains `priority auto on|off`, `role ROLE auto on|off`, `auto show|set`, `route`, `why`, `outcome`, `scorecard`, `trust`, and `decider show|use|on|off|act|workspace|set|check|report`.
    - The build ships the program as `morndo-keys`, and every command runs under that name too.
15. **Other uses of a decision API reuse the port and the pattern** (design, section 16): triage of review findings, needs-owner versus routine events, review depth, stuck-agent detection, and the residue of data pipelines. Each needs its own ADR before code. Not decided here.

## Alternatives

| Option | Verdict |
|---|---|
| **A: deterministic rules only** (task kind, size, role, availability, quota, budget) | **Built first, as the floor.** Explainable, testable, reproducible, needs no data. Alone it is static. Its size and kind heuristics are crude, and it can't notice that a model does badly on this user's repos or reviews. The user would tune it by hand, which is the work they asked Morndo to take. |
| **B: rules plus a Scorecard from recorded Outcomes** (accepted first try, review findings, fix rounds, cost, time) | **Chosen, as the floor, the fallback and the baseline.** It learns from the signal this user already trusts: whether their board and their review accepted the work. It stays deterministic: bands over windows, no sampling, the cells used stored with each pick. Probation gives new models a safe way in. Costs: plumbing from the board, the review step and leases; small samples per cell (5–20), so bands, not decimals; and a feedback loop where probation sees only easy work. Promotion is therefore per Tier, and demotion watches the first harder tasks. |
| **C: ask a model to route, unfenced, over the task text** | **Rejected.** The first design's objections hold for this form: the brief, which may hold employer or client material, goes to one more model; text in a task could steer spend toward a key; a model could lift a new Candidate past its Standing; and its explanation is its account, not the cause. Vendor routers do this on millions of users' data [P1, P3]; one user has none. |
| **C′: a fenced decider over the rules** (the hybrid) | **Chosen, behind shadow mode.** It answers C's objections: the input is an allowlist of fields, so no text leaves and none can steer; the options are only Candidates the rules accept, so it can't pass a cap, a gate or a Standing; a pick replays from the recorded answer; its explanation is a probability beside the rules' own account; and shadow, the holdout and the switch-back rule measure it against the rules on this user's work. Costs: a beta vendor API and one more Connection; a small cost and up to 1 s per acting call; profile fields that describe work patterns leave the machine for opted-in workspaces; and more to build and test. Risk: it sees what the rules see plus each option's record, so it may add nothing. Then it stays off. |
| **C″: a model that labels kind and size from the title and description** | **Not now.** Better labels need the text, and the text would leave the machine. The `local-model` adapter may do this later on the node. |
| **D: hand the choice to a vendor router** (Cursor Auto, OpenRouter's auto) | **Rejected.** Each routes only inside its own vendor, so none can choose between Cursor and a Z.ai key. The family is unknown, so the review rule can't be applied. Cursor hides the routed model by default [P2]. Auto bills at the routed model's list price [P4]. Such models stay usable in a chain, but auto never picks them. |
| **E: a sixth Priority mode `auto`** | **Rejected after review.** A mode replaces the Kind partition, so switching to it re-derives every following Role's chain, including Roles that opted out. A switch beside the mode changes no chain. |
| **F: Thompson sampling over a pool** [P7] | **Rejected for now.** Random by design, so a pick can't be replayed, and it spends real tasks to explore. Probation explores only on routine work, and deterministically. The holdout is chosen by route id, not by chance. |
| **G: rewrite the projected chain per task** | **Rejected.** The chain is per Role, so two tasks of one Role running at once would race, and every pick would look like drift (R14). The pick lives with the run, and the chain stays the safety net. |
| **H: the engine layer applies the rules** | **Not now**, for the reason ADR-0018 gave: the domain rule would move to another repo in another language. With the router hook, the engine layer only asks and keeps its own checks. |
| **I: a general generative call with structured output as the decider** | **Rejected.** The Decisions endpoint returns one of our values and a probability per value by design, bills input only, and is the vendor's recommended tool for choosing among fixed options [P9]. A generative call would need parsing, output tokens, and a separate way to get a probability. |
| **J: put a gateway (LiteLLM) in front of decision models** | **Not now.** It would make adding other decision models easy [P15], but adds a service to run. The port keeps that door open: a gateway is one more adapter. |

## Consequences

- **Good:** Auto in the settings does what was asked.
  - Routine work goes to the cheap key while it stays at or under the Task ceiling.
  - Hard work stays on the trusted subscription.
  - A model new to the user earns its way up.
  - Every run says which engine ran, which stage chose it, and why, in one line and in `why`.
- **Good:** the hard rules hold by construction, for both stages.
  - The pick is an entry of the allowed chain.
  - The gate's dry run, the budget and the review rule exclude before ranking, and before the decider sees anything.
  - The decider can't pass the trust floor, the Task ceiling or a cap.
  - Fallback and the gate's last word are untouched.
  - Turning Auto or the decider on or off changes no chain.
- **Good:** the decision API is tried on the owner's terms. It acts only after it beats the rules on this user's tasks, and goes back by itself when it stops doing so.
- **Good:** Outcomes are a record of how each model did on this user's work, in their repos, judged by their board and their review. That record also feeds the decider and is what later work on Verification needs.
- **Cost:**
  - one pure module, two tables (`routes`, `outcomes`) and a Standing table in the connections database;
  - a per-model family map and class in the catalog and in the engine-layer registration;
  - `--route` (or `MORNDO_ROUTE`) on the launcher, which then runs the route's entry with its reserve, and the entry, model and route on `LeaseClosed`;
  - a board reader;
  - an `outcome` command for the review step;
  - two additive asks of the engine layer;
  - a section of the settings page;
  - a decision port with two adapters, a decisions preset, decider settings, a decider record per route, a report, and three more PRs (7–9).
- **Limit:**
  - The size and kind signals are heuristics. Their agreement with the actual diff is measured, not assumed. The decider sees the same signals, so it can't fix them.
  - The cost priors (catalog price times a token estimate per size) are placeholders until recorded runs replace them.
  - Cursor's per-run cost is unknown to Morndo (UNVERIFIED), so a Cursor subscription ranks by quota, not by dollars.
  - The decider's latency is UNVERIFIED: the vendor publishes a relative speed only [P9]. PR 8 measures it and sets the timeout.
- **Limit:** with the launcher's default reserve of $5, a metered key's prior for L or XL work is above the reservation the gate would grant. So Auto never sends L or XL work to a metered key unless the Role's reserve is raised. That is the budget rule working, and the page says so.
- **Limit:** a pick is decided on the inputs it saw.
  - Concurrent picks see each other: the write step of `route` runs one at a time, and a pick not yet leased counts against the daily cap at its expected cost.
  - The decider's choice is re-checked inside the write transaction, against the hard rules and the Fences.
  - A budget spent between the pick and the lease is still caught by the gate (exit 75), and the run falls through.
  - Interactive and Codex runs have no in-run cap (ADR-0018).
- **Limit:** same-user trust (ADR-0018 §5.3). A `review` Outcome must name the reviewing run, from another lane than the judged one. A process of the same user can still forge one, which the record shows but can't prevent.
- **Risk:** a lenient review promotes a weak model, and the decider reads the inflated record. Demotion, per-Tier promotion, pins and the visible Scorecard limit the damage. The principal can hold a Candidate in one tap.
- **Risk:** a model that is never the cheapest for routine work never leaves probation. That is acceptable: it stays a fallback, and the user can trust it by hand.
- **Risk:** the Decisions API is in beta, from one vendor. Its fields, price, terms or model may change. A schema check, the switch-back rule and the `rules` adapter contain it; the docs are re-read before PR 8 and when it leaves beta.
- **Risk:** profile fields of opted-in workspaces leave the machine. They describe work patterns, not content. The opt-in is per workspace and off by default.

## Verification this implies

1. One negative-control test per invariant R16–R33 (design, section 4.3), with a fake clock, plus:
   - a table of profiles to Tiers and of rankings per Tier;
   - a replay property: shuffled Candidates, repeated runs, recorded decider answers, and settings changed after the pick all give the same pick, with no call to the decider;
   - histories for promotion, demotion, holds and pins, and a Standing that survives its Outcomes aging out;
   - a table over every condition of R31, where only the all-true row lets the decider act;
   - R32's marker test: unique strings in every forbidden field never reach the adapter;
   - histories for the switch-on and switch-back rules, and a holdout that picks the same routes every time.
2. A contract test of the resolver against the fake engines CLI:
   - the router's chain is always inside the Role's chain;
   - Morndo's family exclusion agrees with `engines resolve --implementer`, including a Claude model inside Cursor;
   - the router never calls `resolve`;
   - a failed or slow router leaves resolution as today.

   The same test runs against the real CLI locally, outside CI, as `e2e:engines` does. A skipped run is reported as skipped.
3. An adapter contract test against a fake decisions server: the documented request shape [P10], the allowlist, and refusals, 429s, 500s, timeouts and malformed answers mapping to the rules. One live call runs outside CI when a test key is configured; without it, the case is reported as skipped.
4. An e2e that switches Auto on in the UI, then routes a small docs task and a risk-area task on one Role, and sees two different picks with their reasons on the Role card and in `why`. It then turns the decider to shadow, sees a shadow answer recorded with the rules pick acting, and, with seeded history, sees an acting pick, a below-threshold pick, and an automatic switch-back.
5. Manual QA on desktop and phone (design, section 14), recorded outside this tree, including a task title with a marker word that must not appear in the stored decision input or the log.
6. Re-check triggers:
   - a vendor publishes per-run cost for subscription runs (Cursor);
   - the engine layer ships the router hook or changes its mid-task switch;
   - Claude Code changes `opusplan` or fallback models [P5];
   - a vendor router starts reporting the family of the model it chose;
   - the Decisions API leaves beta, or changes its fields, price, data terms or model [P9–P13];
   - a quarter of shadow use shows no lift.
