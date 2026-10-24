# Usage readings: who may speak for which account (T-430). Plan, no code

**Question.** Worker tokens are shared, so one lane can steer the usage detection of another. How do we tie a reading, a lease, a limit post and a pool post to the accounts a node really runs?

**Answer in short.** Close it in three layers, cheapest first. (1) Say who may post at all and which names are real. (2) Bind pool tokens and lane reports to a node and to the accounts that node runs. (3) Only then, and only if the owner wants it, give each lane a secret of its own. Per-lane tokens alone do not close the hole on a node whose lanes share one OS user (see [§2](#2-what-a-per-lane-token-can-and-cannot-do)). Estimate: about 9 lane-days for layers 1 and 2; 4 to 5 more for layer 3. Revision 2 (after the review of this plan, [§10](#10-review-of-this-plan-and-how-it-was-answered)) says plainly what each layer does and does not stop.

Code references are to branch `feat/usage-s7` at `1cbd738a` (the head of T-415, PR #138). None of it is on `main` yet, so line numbers move when the stack merges. `docs/adr/0036-usage-reading-health.md` is on the branches `docs/usage-detection-plan` and `docs/usage-pool-brief`, not on `main`. Names below (nodes `n1`, `n2`, lanes `w1`, accounts `acct-a`) are made up.

## 1. Current state

How a call is authenticated:

- A worker token is a row of `agent_tokens`: id, name, role, scopes, secret hash, no node and no lane (`apps/hub/src/adapters/store.ts:39`, table `apps/hub/src/adapters/migrations.ts:144`, `scopes` added at `:292`). The only scope is `usage-pool` (`packages/protocol/src/usage.ts:216`).
- `AgentAccess.authenticate` (`apps/hub/src/application/agent-access.ts:50-66`) takes the lane name from the caller's own `X-Morndo-Lane` header for a worker token. The file says so: "one token can serve every lane on a machine" (`:3-4`). Any lane holding the token can name any lane.
- The node agent does not give lanes a token. It strips `MORNDO_AGENT_TOKEN` from its own environment on purpose (`apps/node-agent/src/main.ts:81`, `agent.ts:212`, `relay/board-token.ts:26`) and starts the window with `tmux new-window` carrying no environment of its own (`apps/node-agent/src/ops/lane-ops.ts:237`). Today the token reaches a lane through the owner's launcher and shell (`docs/agents/usage.md:12-16`).

What each usage route checks (all in `apps/hub/src/adapters/http.ts`):

| Route | Line | Who may call | Account is checked against |
|---|---|---|---|
| `POST /api/agent/usage` (status line) | 452 | any agent token | `ACCOUNT_NAME` only (`usage-service.ts:338`), account from the `X-Morndo-Account` header |
| `POST /api/agent/usage/readings` | 460 | any agent token, no scope | `ACCOUNT_NAME` only (`usage-service.ts:477`) |
| `POST /api/agent/usage/lease` | 471 | manager, or `usage-pool` | the unknown-name budget only |
| `POST /api/agent/usage/limit` | 484 | manager, or `usage-pool` | `ACCOUNT_NAME` only (`usage-service.ts:638`) |
| `POST /api/agent/usage/pool` | 502 | `usage-pool` only | `ACCOUNT_NAME` only (`usage-service.ts:425`) |

What follows from that:

1. **Unleased readings for any account.** The readings route has no role or scope check. An unleased reading cannot end a mark or set the cache (`usage-service.ts:543-555`, `#observe` `:578-584`), but it moves the windows Home shows and the 75% and 90% thresholds. This is the review finding on the slice 5 and slice 7 docs (`docs/agents/usage.md:147-153`).
2. **`node` is the poster's word.** The reading's node is `body.node` (`usage-service.ts:480`) and the lease's node is `body.node` (`http.ts:475`). A pool token for `n1` can post and lease as `n2`.
3. **Unknown names are only budgeted, and only on the lease path.** 5 new names per token per hour (`apps/hub/src/application/usage-leases.ts:18-19`, `#mayStartUnknown` `:85-92`). `/limit` and `/pool` accept any well-formed name and store a seat and a notice for it (`usage-service.ts:425`, `:638`). The pool brief review (round 1 and 2 on PR #141) asked for this to be on those two routes too.
4. **The lane record's token binding protects little.** `report()` writes the record for `(node of lane, lane)` with the reporting token's id (`usage-service.ts:349`; store `:767-790`). With two token ids a second reporter makes the record ambiguous for an hour; with one shared token id there is no conflict at all. The slice 3 reviews ran both: lane `w1` reports `acct-a`, then, with the same token, `acct-b`, and a hook-less failure of `w1` retires `acct-b`. A lane started by hand has no start record, so a second token poisons it too.
5. **A lane started by the hub is known.** `lane.start` with an account emits a `lane_account` tap after an ok result (`apps/fleet/src/application/connections.ts:283-286`), which the hub stores as a `source = 'start'` row (`usage-service.ts:377-383`). The hub also knows which node runs a lane (`apps/hub/src/main.ts:349`, from the fleet observation). The failure path already uses both: a hook's account word counts only for an account the node is seen to run (`usage-service.ts:401`, `#seenOnNode` `:417`).
6. **A node's account list does not exist.** The node's launcher takes `{account}` from the op (`apps/node-agent/src/ops/lane-engine.ts:36-41`). The node never states which accounts it has. The collector's config lists the accounts it reads, but only in the collector's own file (`docs/agents/usage.md:100-130`).

Review findings this plan answers: slice 2 (a worker can mark any account), slice 3 R1 to R3 (record poisoning; "token binding protects nothing with shared tokens"), slice 5 (lane takes a lease on any name; invented names hold both slots), slice 6 and 7 (unleased identity and plan), pool brief rounds 1 and 2 (`/pool` and `/limit` unbounded).

## 2. What a per-lane token can and cannot do

Lanes on one node run as one OS user. A lane that is an agent with a shell can read another process's environment (`/proc/<pid>/environ`) or any file the node agent reads. So a per-lane secret stops:

- a lane that names another lane by mistake or by a copied command line,
- a lane steered by injected text that does not go hunting for secrets,
- any lane on a different node (a secret is per node),
- a stale lane after its stop (revocation).

It does not stop a hostile lane on the same OS user. Only one OS user per lane would. That is out of scope here and is owner decision D1.

This is why the plan binds by node and account set first: that bounds the damage of a stolen secret to one node's accounts, whichever option is chosen.

## 3. Options

### A. A token per lane, minted at `lane.start`, revoked at stop

The hub mints a worker token bound to `(node, lane, account)` when it issues `lane.start`, and the lane carries it.

- **Delivery** is the hard part. The fleet op would carry a secret, and ops are journaled (`apps/node-agent/src/ops/done-keys.ts:50` lists `lane.start`'s keys), so the secret must stay out of the journal. Alternatively the node asks the hub for it after the start, over its fleet connection. Then the node puts it in the window's environment (`new-window -e`, visible in the tmux client's arguments for a moment) or in a file with mode 600 that the launcher reads. Either way the launcher change belongs to the machine's owner.
- **Revocation** at `lane.stop`, plus a sweep for windows that vanish (killed, node reboot, crash). Tokens pile up otherwise: one row per lane start.
- **Lanes the hub did not start** (by hand, by the manager) get no token and need a fallback.
- **Closes:** finding 1 and 4 against a non-hunting lane; a lane cannot report as another lane. Also gives the board, memory and jobs routes a real lane identity (today the lane name is a header).
- **Does not close:** invented names on `/limit`, `/pool` and the lease path (the token knows its own account only if account is part of it); a collector's `node` word; a hostile same-user lane.
- **Cost:** about 5 lane-days (hub mint/revoke/sweep, fleet and node plumbing, launcher change, token-table limits, migration, tests).

### B. A token per node, plus a lane claim the hub checks against `lane.start`

The token carries a node (`morndo agent-token new <name> --role worker --node n1`). A call names its lane in `X-Morndo-Lane`, as now, and the hub checks the claim: the lane must run on the token's node (fleet observation) and, for an account-carrying call, the account must be the lane's recorded start account, or for a hand-started lane one that the node runs.

- **Delivery** changes little: the token is as shared as today, but it is minted per node, so a copy on `n1` is worthless on `n2`.
- **Closes:** a pool token posting as another node or for an account its node does not run; a *node-bound* worker token reporting as a lane of another node (the token's node differs from the lane's node by observation); a report for a name the lane's node does not run.
- **Does not close:** the claim is checked, the claimant is not. The lane is named by the caller's own header on a token every lane of the node shares (`agent-access.ts:50-66`), so a lane on `n1` can claim another lane of `n1`, and a lane holding an *unbound* (legacy) token can claim a lane of any node. Only A (a secret per lane) or D5 (the node's relay vouches for the lane) closes that.
- **Cost:** about 3 lane-days on top of C (column, console flag, claim checks, collector configs).

### C. Keep shared tokens; bind by node and by the account set the node runs

No token change. The hub keeps, per node, the set of accounts that node runs (`node_accounts`). Every usage route refuses a name outside the set of the node the call is *about*. For a lane report the node is the lane's node, found by observation, so a legacy shared token still works. For a pool or collector call the node is the body's `node`, unverified, so C alone binds nothing there.

- **Where the set comes from:** (a) the hub's own knowledge: `lane_accounts` start rows, usage source rows (`usage_sources` has account, source, node); (b) the principal's console, for accounts a collector reads that no lane runs; (c) later, the node's own inventory sent in its hello (a new capability, so an older agent just sends none).
- **Closes:** invented names on all five routes (finding 3), and the budget code becomes redundant; the readings and status-line routes for a name no node runs.
- **Does not close:** one lane against another on the same or another node with the same account set. It is the floor every other option needs.
- **Cost:** about 3 lane-days.

### Comparison

| | A | B | C |
|---|---|---|---|
| Invented names (`/lease`, `/limit`, `/pool`) | no | partly | **yes** |
| Unleased readings for any account | partly | **yes** | partly |
| Pool token posts as another node | no | **yes** | no |
| Lane A reports as lane B, other node | **yes** | **yes**, with node-bound tokens only | no |
| Lane A reports as lane B, same node | **yes** (not vs a hostile user) | no | no |
| Report under an account outside the lane's node set | **yes** | **yes** | **yes** |
| Report under another account *of the same node* (a move looks the same) | **yes** (the lane's own secret still moves it) | no | no |
| Token changes for existing lanes | yes, all | none for lanes, new pool tokens | none |
| Launcher change on the machine | yes | no | no |

## 4. Recommendation

Do C's account set and B's node binding, in the order below, and leave A for after the owner's answer to D1. Each step ships first in `warn` (accept and count), then in `enforce` ([§5](#5-migration-old-lanes-keep-working)).

1. **Gate readings by role, after the callers are moved.** The readings route needs a manager token or the `usage-pool` scope, like the lease and limit routes. What changes, exactly, and in this order so nothing goes dark:
   1. Hub code ships with the gate in `warn`: a reading from a plain worker token is accepted and counted on the token (`unbound_count`, [§5](#5-migration-old-lanes-keep-working)).
   2. Callers that post readings with a plain worker token are moved to a token with the `usage-pool` scope (or the manager token): the e2e helper at `e2e/home.e2e.ts:60` (it posts readings with the plain worker token `token`, while the same file already mints `managerToken` for the limit route); the unit-test helper in `apps/hub/test/usage-health.test.ts:17` and the other tests that build a reading through a plain worker actor; `e2e/usage-claude.e2e.ts:49` already mints a scoped token. Tests that post a reading on purpose with an unscoped token become the refusal tests (1, 2).
   3. Outside collectors (Cursor and Z.ai: `docs/agents/usage.md` §Cursor, §Z.ai; they name no token) get a `usage-pool` token each. Reading Cursor periods already requires them to lease (the S7 review), and the lease route already needs that scope, so the ones that work today hold one; any that post unleased with a plain worker token show in `morndo agent-token list` (count and last use) during the `warn` week.
   4. The docs say it: the Cursor and Z.ai sections name the token (`--role worker --scope usage-pool`, later `--node`).
   5. Flip to `enforce` only when `agent-token list` shows no plain token posting readings for 7 days (D3).
2. **Make names real, with a bootstrap.** `node_accounts(node, account, via, at)` with `via` of `start`, `pool`, `source`, `principal`, `legacy`. The five routes refuse a name that no node's set holds (`unknown_account`), except through the bootstrap below. The lease path's unknown-name budget stays as a guard on the pool's declarations.
3. **Bind tokens to a node** (`--node`, for a pool/collector token and for a worker token a node's lanes hold). `body.node` must equal the token's node; the account must be in that node's set; the lease is bound to the node; a report for a lane of another node is refused for a node-bound token.
4. **Keep moves, bound the account.** A lane report may move the lane's record to another account as it does today, but only to an account in the lane's node set ([§4.1](#41-moved-lanes)). A name outside the set writes nothing.
5. **Then decide A** (D1). If yes, it reuses everything above: the per-lane token is B's token with a lane and an account on it.

### 4.1 Moved lanes

`report()` replaces the `(node, lane)` record when a lane has moved account (`usage-service.ts:339-349`, and the pool brief's item 7 on moved lanes); the pool's `move()` and slice 3 R3 rely on it. The first revision refused a report that differed from the start record, which would break a moved lane: under `enforce` its next failure would retire the old seat. The rule now:

- a report under an account **in the lane's node set** replaces the record, as today (source `report`, the 12-hour rule of a start record against a report for failure resolution is unchanged);
- a report under a name **outside** the set writes no record and changes no account (`unknown_account`, or `pending` in the bootstrap);
- a move the pool or `lane.start` made is already in the set (`via` `pool` or `start`), so it passes.

What this does not stop: a lane steering another lane's record to a different *real* account of the same node. It needs A or D5 (§3). Tests 8 and 9 are rewritten accordingly ([§6](#6-named-tests-red-today)).

### 4.2 Bootstrap: how a name first becomes known

Today a status-line report is how an account first appears, and a lease ask is a collector-only account's first word. With `unknown_account` on all five routes those would be refused until someone declares the name. The smallest bootstrap, so that only one case needs the principal:

| Case | How the name is declared | Principal needed |
|---|---|---|
| Lane started by the hub with an account | `lane.start` tap writes the `start` row (`connections.ts:283-286`, `usage-service.ts:382`) | no |
| A new seat the pool manages | the pool token (scoped, node-bound) may **declare** a name for its own node through a new `action: "declare"` on `/pool`, within the existing budget of 5 new names an hour per token; the principal sees `via = pool` and can undeclare | no |
| Hand-started lane on a seat nobody declared | its first status-line report is kept as **pending** (node, name, lane, first seen, count), not stored as an account and not lost; `morndo usage accounts approve <node> <name>` declares it | once per seat, on the principal's word |
| Collector off the fleet (a laptop; no `lane.start`, no fleet node) | the principal declares `morndo usage accounts add --node <node> <name>`, or its own scoped, node-bound pool token declares it like the pool | once per account |
| Account the hub already shows | backfilled by the migration ([§5](#5-migration-old-lanes-keep-working)) | no |

"Unknown" stays what it is in `#unknown()` (`usage-service.ts:158`): a name with no account row, no source and no seat. A *declared* name with no reading yet is therefore still wanted once for a first read, which is what the lease's first word was for. D7 is no longer circular: a hand-started lane's first report is a pending item, not a refusal.

## 5. Migration (old lanes keep working)

Everything ships in three modes per gate: `off`, `warn`, `enforce`. The gates are `readings` (step 1, the role), `names` (step 2 and §4.2, the set), `node` (step 3, token binding) and `lane` (step 4 and §4.1, the report). Default `warn` on release; the principal flips each to `enforce` after the grace period (D3).

- **Where the mode lives.** A new table `usage_bind(gate TEXT PRIMARY KEY, mode TEXT, at INTEGER)` in the same migration, read by `UsageService` on each call (a row read, not config), and a console command: `morndo usage-bind show` and `morndo usage-bind set <gate> off|warn|enforce`, parsed before the database opens like the other console commands (T-434's pattern). It is the principal's only: no agent route reads or writes it. (`hub_store` is the store-id row and is not a settings table.)
- **`warn`** accepts what `enforce` refuses and counts it per token in `agent_tokens` (new `unbound_count`, `last_unbound_at`), shown in `morndo agent-token list` and in `whoami`. A lane keeps working on its old shared token.
- **Backfill in the migration** (hub migration 28 or the next free one; nothing is renamed or deleted), into `node_accounts` with `via = 'legacy'`:
  - each `lane_accounts` row: `(node, account)`;
  - each `usage_sources` row with a node: `(node, account)`;
  - each status-line account (`usage_accounts`, the rows a status-line report made): `(node "", account)`, the hub-local set. A lane report is checked against its node's set **or** the hub-local set until the principal narrows it (`morndo usage accounts move <name> --node n1`), so a status-line account is not lost to a lane whose node never reported it.
  - each seat with no other row (`usage_seats`, `usage_pool_seats`): `(node "", account)`.
- **Lane reports need no new token.** The hub finds the lane's node by observation, so existing shared tokens carry on. A pool or collector token must be re-issued with `--node`; the old token works in `warn` and is refused on the readings, lease, limit and pool routes in `enforce`.
- **Rollback** is the mode switch. No migration step is destructive.
- **Order across machines:** hub first (all gates `warn`), then move the callers of §4 step 1 (e2e/test helpers, the Cursor and Z.ai collectors), then re-issue pool tokens one node at a time (their config has a `tokenFile`, `docs/agents/usage.md:111`), then flip each gate when `agent-token list` shows it quiet.

## 6. Named tests (red today)

Hub tests in `apps/hub/test/` unless said otherwise. "Red today" is the verdict on `1cbd738a`. Rows changed after the review are marked (r2).

| # | Test | Spoof case (review) | Red today |
|---|---|---|---|
| 1 | `usage-bind: an unscoped worker token cannot post a reading` | any lane posts an unleased reading for any account (slice 5, 7 and the doc review) | 200, should be 403 |
| 2 | `usage-bind: an unscoped token cannot move shown windows or thresholds` | same, the effect on the card | window moves |
| 3 | `usage-bind: /pool refuses a name no node runs` | pool brief review: `/pool` unbounded | 200, seat and notice stored |
| 4 | `usage-bind: /limit refuses a name no node runs` | same, `/limit` | 200 |
| 5 | `usage-bind: a lease for an unknown name is denied and spends no budget` | invented names hold both slots (slice 5) | granted, 5 an hour |
| 6 | `usage-bind: a pool token bound to n1 cannot lease, read or post as n2` | self-declared node (slice 5, slice 3) | accepted |
| 7 | `usage-bind: a pool token for n1 cannot name an account only n2 runs` | token binding to accounts | accepted |
| 8 (r2) | `usage-bind: a report under a name outside the lane's node set writes no record and no account` | slice 3 R2: lane `w1` on `acct-a`, report as an invented name | name stored, record written |
| 9 (r2) | `usage-bind: a moved lane keeps working: a report under another account of its node moves the record and the next failure marks the new seat` | pool `move()`, slice 3 R3 (must stay **green**: the guard against breaking moves) | green today, red if the first revision's rule were built |
| 9b (r2) | `usage-bind: a move to a name outside the set is refused, the old record stands` | slice 3 R3 | record moves to the invented name |
| 10 (r2) | `usage-bind: a hand-started lane's first report under an undeclared name is pending, not an account` | slice 3 R2, D7 bootstrap | account created |
| 11 (r2) | `usage-bind: a node-bound worker token cannot report as a lane of another node` | lane header names a lane on `n2` while the token is for `n1` | accepted. (The first revision's test, "a report claiming a lane of another node is refused" for any token, cannot be built: a legacy shared token has no node. This one can, because the token has.) |
| 11b (r2) | `usage-bind: a shared legacy token can still claim another lane (pinned limit)` | the claim is checked, not the claimant (§3 B) | green; pins the gap, so closing it (A or D5) turns it red on purpose |
| 12 | `usage-bind-migration: legacy shared token keeps reporting in warn mode and is counted` | migration | not written yet |
| 13 (r2) | `usage-bind-migration: backfill gives each node the accounts it already shows, and the status-line accounts go to the hub-local set` | migration | not written yet |
| 14 (r2) | `usage-bind-migration: enforce refuses an unbound pool token on the four routes, warn does not; the mode is read from usage_bind` | migration | not written yet |
| 15 | `fleet lane-account-event: a node's tap cannot add an account to another node's set` | cross-node | not written yet |
| 16 | `usage-bind: the forged failure hook word stays limited to accounts its node runs` | slice 3 caveat, unchanged | green; pinned known limit |
| 17 (r2) | `usage-bind-bootstrap: lane.start declares; the pool declares a seat within its budget; an off-fleet name needs the principal; a declared name with no reading is wanted once` | finding 4 | not written yet |
| 18 (r2) | `e2e home: readings are posted with a scoped token (the helper at e2e/home.e2e.ts:60)` | finding 1: the caller moved before the gate | not written yet |

Each ends with a negative control (the repo's `--only` flow): remove the check and the named test goes red. Tests 12 to 15, 17 and 18 need new code, so they are red by absence, not by a spoof.

## 7. Estimate

| Slice | Work | Lane-days |
|---|---|---|
| 1 | Role gate on readings in `warn`; move the callers (e2e and unit helpers, Cursor and Z.ai docs and collector tokens); `agent-token list` counts; tests 1, 2, 18 | 1.0 |
| 2 | `node_accounts`, migration and backfill (lanes, sources, status-line, seats), `usage_bind` table and console command, `unknown_account` gate on the five routes, the bootstrap (pending list, pool `declare`, console add/approve/list/remove); tests 3, 4, 5, 10, 12, 13, 15, 17 | 3.0 |
| 3 | `--node` on tokens, node check on pool routes, lease bound to node, node-bound worker tokens; tests 6, 7, 11, 11b, 14 | 1.8 |
| 4 | Moves bound to the node set; tests 8, 9, 9b, 16 | 0.7 |
| 5 | Docs (`docs/agents/usage.md` known-limits section rewritten), flip to `enforce` | 0.5 |
| | Review rounds (about 20%) | 1.4 |
| | **Layers 1 and 2** | **about 9** |
| 6 (only if D1 = yes) | Option A on top: mint at `lane.start`, delivery through the node, revoke at stop and sweep, launcher change, tests | 4 to 5 |

Slice 1 ships alone and first, in `warn`, so it stops nothing until its callers are moved.

## 8. Owner decisions

| # | Decision | Recommended |
|---|---|---|
| D1 | Do we defend against a hostile lane on the same OS user, or against mistakes, injected text and other nodes? | The second. Agents are trusted but fallible; one OS user per lane is a larger project. This puts A last. |
| D2 | Who declares the accounts a node runs that no lane started? | `lane.start` and the pool declare their own; the principal only for off-fleet collectors and for hand-started seats (approve from the pending list). The node's own inventory (a hello field) is later. |
| D3 | How long do the gates stay in `warn`? | 7 days, and a gate flips only when `agent-token list` shows it quiet for 7 days. |
| D4 | After the grace period, may an unbound (legacy) pool token still post readings, leases, limits and pool words? | No. Lane reports stay allowed on a shared token (checked by observation); everything pool-side needs a node-bound token. |
| D5 | Should the node agent, not the lane, vouch for a lane's identity (the lane posts to the node relay; the relay resolves the lane from the connection's process, as the failure hook path does, and forwards over the fleet link)? | Yes, as the follow-up to this plan instead of A. It is the only cheap way to close lane-vs-lane on one node without a secret in an environment. Needs its own design. |
| D6 | Is a pool/collector token one per node, or per account? | Per node (`--node`). Per account multiplies tokens for no extra protection. |
| D7 | Hand-started lanes on an undeclared seat: what happens to the first report? | It is kept as pending and the principal approves it once; the lane's report is not lost and not an account. |
| D8 | Should the board, memory and jobs routes get the same lane identity? | Not in T-430. Note it on the board when A or D5 is picked. |
| D9 | Merge order: this work needs T-415's stack on `main` first. | Yes. Start slice 1 once PR #138 has merged, to avoid a second rebase. |
| D10 | May the pool declare new names for its own node (§4.2), within 5 new names an hour per token? | Yes. The pool manages the seats; a stolen pool token can invent only that, for one node, visibly (`via = pool`), and the principal can undeclare. |

## 9. Not covered

- The failure hook word is posted by the lane to the node relay; the node attributes it to the node, not to a token. A lane can mark an account its own node runs (test 16 pins this). Only D5 closes it.
- The `usage_report` format and the collectors' reading of provider data are untouched.
- Rate limits on the usage routes beyond what exists (`agentCalls`, `agentRefusals` buckets).

## 10. Review of this plan, and how it was answered

The review of revision 1 (md-rev6 on T-430, 4 MED, 1 LOW).

| # | Finding | Answer in the text |
|---|---|---|
| 1 (MED) | The role gate breaks `e2e/home.e2e.ts:60` and any outside collector posting unleased with a plain worker token | §4 step 1 names the changes and their order: gate in `warn`, move the e2e helper, the unit helpers and the Cursor and Z.ai collectors to a scoped token, docs, then flip when `agent-token list` shows nothing left. Tests 1, 2, 18; slice 1 is `warn` only |
| 2 (MED) | Binding a report to the start record breaks moved lanes (`usage-service.ts:341-349`) | §4.1: a move to another account of the lane's node set still replaces the record; only a name outside the set is refused. Tests 8, 9, 9b rewritten; 9 stays green on purpose |
| 3 (MED) | Step 4 binds the claim, not the claimant | §3 B and the comparison table say what is and is not closed: node-bound tokens close cross-node claims; same-node claims and a legacy token's claims need A or D5. Test 11 rewritten to what can be built (node-bound token); 11b pins the gap |
| 4 (MED) | `unknown_account` on all five routes leaves a new seat, a hand-started lane and an off-fleet collector refused | §4.2: `lane.start` declares, the pool declares its seats (new `declare`, budgeted, D10), a hand-started lane's first report is pending until the principal approves, only an off-fleet collector needs the principal. D7 is no longer circular. Test 17 |
| 5 (LOW) | The backfill misses the status-line accounts; the `warn`/`enforce` setting has no home | §5: status-line accounts (and seats with no other row) go to the node-`""` hub-local set; the mode is a row of a new `usage_bind` table, set by `morndo usage-bind set <gate> <mode>`, principal only. Test 13, 14 |
