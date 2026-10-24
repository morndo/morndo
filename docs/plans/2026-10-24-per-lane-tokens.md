# Usage readings: who may speak for which account (T-430). Plan, no code

**Question.** Worker tokens are shared, so one lane can steer the usage detection of another. How do we tie a reading, a lease, a limit post and a pool post to the accounts a node really runs?

**Answer in short.** Close it in three layers, cheapest first. (1) Say who may post at all and which names are real. (2) Bind pool tokens and lane reports to a node and to the accounts that node runs. (3) Only then, and only if the owner wants it, give each lane a secret of its own. Per-lane tokens alone do not close the hole on a node whose lanes share one OS user (see [§2](#2-what-a-per-lane-token-can-and-cannot-do)). Estimate: about 6 lane-days for layers 1 and 2; 4 to 5 more for layer 3.

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
- **Closes:** every cross-node case (finding 2, 3 and the pool token posting as another node); a lane claiming a lane of another node; a report under an account that lane was not started with (finding 4, with a start record); a pool token speaking for an account its node does not run.
- **Does not close:** a lane on `n1` claiming another lane of `n1` that runs a different account (the secret is shared on the node). That needs A, or a node-derived lane identity (D5 below).
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
| Lane A reports as lane B, other node | **yes** | **yes** | no |
| Lane A reports as lane B, same node | **yes** (not vs a hostile user) | no | no |
| Report under an account the lane was not started with | **yes** | **yes** | partly |
| Token changes for existing lanes | yes, all | none for lanes, new pool tokens | none |
| Launcher change on the machine | yes | no | no |

## 4. Recommendation

Do C's account set and B's node binding, in the order below, and leave A for after the owner's answer to D1.

1. **Gate by role first (a one-line check).** The readings route needs a manager token or the `usage-pool` scope, like the lease and limit routes. A lane has no business posting a reading: the collectors do, and they already hold a pool token. This alone closes finding 1 for lanes.
2. **Make names real.** `node_accounts(node, account, via, at)` with `via` of `start`, `source` or `principal`. All five routes refuse a name that no node's set holds (`unknown_account`). The lease path's unknown-name budget stays as a guard, but it no longer lets anything through. The principal's `lane.start` and the console add names; nothing else does.
3. **Bind the pool token to a node** (`--node`). `body.node` must equal the token's node; the account must be in that node's set; the lease is bound to the node too.
4. **Bind a lane report to its lane.** A report whose account differs from the lane's start record is refused (`account_mismatch`) and writes no record. A lane without a start record may report only accounts in its node's set, and the first report becomes its record.
5. **Then decide A** (D1). If yes, it reuses everything above: the per-lane token is B's token with a lane and an account on it.

## 5. Migration (old lanes keep working)

Everything ships in three modes per gate: `off`, `warn`, `enforce`, set in the hub's settings, default `warn` on release, flipped to `enforce` by the principal after the grace period (D3).

- **`warn`** accepts what is refused in `enforce`, counts it per token in `agent_tokens` (new `last_unbound_at`, `unbound_count`), and shows the count in `morndo agent-token list` and in `whoami`. A lane keeps working on its old shared token in this mode.
- **Backfill in the migration** (hub migration 28 or the next free one; no table is renamed, no row is deleted): `node_accounts` from `lane_accounts` rows and from `usage_sources` rows whose node is not empty. Accounts of the hub-local status line (node `""`) go to a hub-local set that every node may use until the principal narrows it.
- **Lane reports need no new token.** The hub finds the lane's node by observation, so existing shared tokens carry on. Only a pool or collector token must be re-issued with `--node`; its old token keeps working in `warn` and is refused for the readings, lease, limit and pool routes in `enforce`.
- **Rollback** is the mode switch. No migration step is destructive.
- **Order across machines:** hub first (modes `warn`), then re-issue pool tokens one node at a time (their config has a `tokenFile`, `docs/agents/usage.md:111`), then flip each gate.

## 6. Named tests (red today)

Hub tests in `apps/hub/test/` unless said otherwise. Each of the spoof cases from the reviews is one test; "red today" is the verdict on `1cbd738a`.

| # | Test | Spoof case (review) | Red today |
|---|---|---|---|
| 1 | `usage-bind: an unscoped worker token cannot post a reading` | any lane posts an unleased reading for any account (slice 5, 7 and the doc review) | 200, should be 403 |
| 2 | `usage-bind: an unscoped token cannot move shown windows or thresholds` | same, the effect on the card | window moves |
| 3 | `usage-bind: /pool refuses a name no node runs` | pool brief review: `/pool` unbounded | 200, seat and notice stored |
| 4 | `usage-bind: /limit refuses a name no node runs` | same, `/limit` | 200 |
| 5 | `usage-bind: a lease for an unknown name is denied and spends no budget` | invented names hold both slots (slice 5) | granted, 5 an hour |
| 6 | `usage-bind: a pool token bound to n1 cannot lease, read or post as n2` | self-declared node (slice 5, slice 3) | accepted |
| 7 | `usage-bind: a pool token for n1 cannot name an account only n2 runs` | token binding to accounts | accepted |
| 8 | `usage-bind: a report under an account other than the lane's start record is refused` | lane `w1` started on `acct-a`, report as `acct-c` (slice 3 R2) | writes the account, shown windows change |
| 9 | `usage-bind: same token, second account, does not retarget a lane's failure` | slice 3 R3: one token id replaces its own word | `acct-b` retired |
| 10 | `usage-bind: a hand-started lane may report only an account its node runs` | slice 3 R2: lane without a start record | any name accepted |
| 11 | `usage-bind: a report claiming a lane of another node is refused` | lane header names a lane on `n2` | accepted |
| 12 | `usage-bind-migration: legacy shared token keeps reporting in warn mode and is counted` | migration | not written yet |
| 13 | `usage-bind-migration: backfill gives each node the accounts it already shows` | migration | not written yet |
| 14 | `usage-bind-migration: enforce refuses an unbound pool token on the four routes, warn does not` | migration | not written yet |
| 15 | `fleet lane-account-event: a node's tap cannot add an account to another node's set` | cross-node | not written yet |
| 16 | `usage-bind: the forged failure hook word stays limited to accounts its node runs` | slice 3 caveat, unchanged (a lane on the node can still mark an account the node runs) | green; kept as the pinned known limit, so a change shows |

Each ends with a negative control (the repo's `--only` flow): remove the check, the named test goes red. Tests 12 to 15 need the new code to exist, so they are red by absence, not by a spoof.

## 7. Estimate

| Slice | Work | Lane-days |
|---|---|---|
| 1 | Role gate on readings; tests 1, 2; docs line | 0.5 |
| 2 | `node_accounts`, migration and backfill, console to add/list/remove, the `unknown_account` gate on the five routes in `warn`/`enforce`; tests 3, 4, 5, 12, 13, 15 | 2.5 |
| 3 | `--node` on tokens, node check on pool routes, lease bound to node; tests 6, 7, 14 | 1.5 |
| 4 | Report binding to the lane's start record; tests 8 to 11, 16 | 1.0 |
| 5 | Docs (`docs/agents/usage.md` known-limits section rewritten), flip to `enforce` | 0.5 |
| | Review rounds (about 20%) | 1.2 |
| | **Layers 1 and 2** | **about 6** |
| 6 (only if D1 = yes) | Option A on top: mint at `lane.start`, delivery through the node, revoke at stop and sweep, launcher change, tests | 4 to 5 |

Slice 1 can ship alone and first: it is the smallest change that stops a lane posting readings.

## 8. Owner decisions

| # | Decision | Recommended |
|---|---|---|
| D1 | Do we defend against a hostile lane on the same OS user, or against mistakes, injected text and other nodes? | The second. Agents are trusted but fallible; one OS user per lane is a larger project. This puts A last. |
| D2 | Who declares the accounts a node runs that no lane started? (collector-only accounts) | The principal, from the console, one command per node and account; the node's own inventory (hello field) later. Backfill covers what the hub already shows. |
| D3 | How long do the gates stay in `warn`? | 7 days, then the principal flips each gate to `enforce`. |
| D4 | After the grace period, may an unbound (legacy) pool token still post readings, leases, limits and pool words? | No. Lane reports stay allowed on a shared token (checked by observation), everything pool-side needs a node-bound token. |
| D5 | Should the node agent, not the lane, vouch for a lane's identity (the lane posts to the node relay; the relay resolves the lane from the connection's process, as the failure hook path does, and forwards over the fleet link)? | Yes, as the follow-up to this plan instead of A. It closes same-node lane-vs-lane without a secret in an environment, and fits `lane.start`'s existing tap. Needs its own design. |
| D6 | Are a pool token and a collector one token per node, or per account? | Per node (`--node`). Per account multiplies tokens for no extra protection. |
| D7 | Lanes started by hand or by the manager: allowed a first report under an account their node runs? | Yes, the node's set bounds it; the first report becomes the record. |
| D8 | Should the board, memory and jobs routes get the same lane identity? | Not in T-430. Note it on the board when A or D5 is picked. |
| D9 | Merge order: this work needs T-415's stack on `main` first. | Yes. Start slice 1 on `feat/usage-s7`'s successor once PR #138 has merged, to avoid a second rebase. |

## 9. Not covered

- The failure hook word is posted by the lane to the node relay; the node attributes it to the node, not to a token. A lane can mark an account its own node runs (test 16 pins this). Only D5 closes it.
- The `usage_report` format and the collectors' reading of provider data are untouched.
- Rate limits on the usage routes beyond what exists (`agentCalls`, `agentRefusals` buckets).
