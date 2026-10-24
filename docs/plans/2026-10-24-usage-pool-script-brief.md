# Brief: what `claude-pool` and its guard must change to feed the hub's usage contract

**Phase: brief only.** Board T-415, 2026-10-24. Companion to `docs/plans/2026-10-23-usage-detection.md` (plan, ADR-0036) and the code of slices 1 to 7 (PRs #124, #125, #127, #130, #133, #136, #138). It tells the operator (or the lane that owns the pool) what to change in `claude-pool` and its guard; **this brief changes nothing in the pool, and nothing in this repository's code**. `claude-pool` is a script the operator runs beside Morndo (outside this repository); its lines below were read read-only on 2026-10-24 (1324 lines). Account names are made up (`seat-a`, `seat-b`, `seat-c`). `file:line` for the pool is `claude-pool:N`.

Facts carry a source. **VERIFIED** is checked in code or by a run on 2026-10-24; **INFERENCE** is concluded from evidence; **UNVERIFIED** is neither.

## 0. Summary

1. The pool never talks to the hub's usage routes today. Its only outward calls are a notification to the lane-watcher (`claude-pool:584`) and the file it writes for the hub to read (labels). VERIFIED (grep for `api/agent`, `MORNDO`: none).
2. The hub now has one place for each kind of word about an account: **readings** (what a source read, leased or not), **limit posts** (a lane or the manager saw a limit hit: the hub derives a seat), and **pool seats** (the pool's own word on a seat: sticky, wins over a derived mark). The pool should speak through the third and stop producing numbers by typing into a terminal.
3. The "no usage on screen" failures (78% of probes in the audit window) are a classification and backoff gap in `probe()`, and the headless reader makes the probe unnecessary for usage. Until the reader runs on the node that holds each seat, the probe should at least say *why* it failed and stop retrying a seat that is signed out, refused or lapsed.
4. Work estimate: about one day, plus tests (section 7). Rollout is staged so each step can be reverted alone (section 8).

## 1. What the hub offers now (the contract the pool feeds)

Routes (all `POST`, bearer agent token; seconds on the wire everywhere, the hub works in milliseconds). VERIFIED against `apps/hub/src/adapters/http.ts` at `0dab5cef`.

| Route | Who may call | What it says | What the hub does |
|---|---|---|---|
| `/api/agent/usage` | any agent token (status-line reports) | a lane's status line: windows, spend, session | the account's windows from the status line; unchanged by this work |
| `/api/agent/usage/readings` | any agent token | one source's reading or failure for an account: `source`, `node`, `captured_at`, `every_s`, `plan`, `identity`, `windows[]`, flags, `lease_id`, `failure` | stores it per account, source, node; four states; titles from length; thresholds; **a lease id changes what it may do (below)** |
| `/api/agent/usage/lease` | a manager token, or a worker token with the **`usage-pool` scope** | "may I read this account from this source now?" | grants a lease (4-minute cache shared by all nodes, cooldown after a failure, one live lease per account and source, hub-wide cap of 2, on demand only), or answers `fresh` / `denied` |
| `/api/agent/usage/limit` | a manager token, or a worker token with the `usage-pool` scope | a limit hit seen by a lane or the manager | the hub's own **derived** seat mark for the account |
| `/api/agent/usage/pool` | a token with the **`usage-pool` scope** only (role is not the scope) | **the pool's own word on a seat** | the **pool-owned** seat: sticky, no reading clears it, wins over a derived mark |

**Leased versus unleased (what the pool must understand, because it decides what a post can do).** A lease is granted to the token that took it, for one account and source, and lasts 210 s. VERIFIED (`usage-leases.ts`, slice 5 fix round).

- A reading **with** a valid lease from the same token may: end a derived limit mark whose cycle is new (the confirming read), set the cache and the cooldown, feed the plan and identity watch (a changed plan name or account identity, told once after two agreeing readings), and carry the provider's limit flags (they mark or clear a derived seat).
- A reading **without** a lease changes the windows Home shows and the thresholds that watch them, and nothing else: it never clears a mark, never sets the cache, never tells a plan or account change, never drops a derived mark. (Any token can still post one for any account: that is T-430, per-lane tokens and leases bound to the accounts a node really reports.)
- A limit post (`/limit`) and a pool post (`/pool`) are not readings and need no lease; they are gated by token role or scope instead.

**The pool token.** `morndo agent-token new pool --role worker --scope usage-pool`. It lives in a file the pool reads (mode 0600), never in the environment of a lane, never printed, never in a log line or a notification. It can call `/pool`, `/limit` and `/lease`; it must **not** be the token a lane uses.

**Pool seat body** (`UsagePoolBody`): `{ account, action: "set" | "cleared", state?: "logged-out" | "retired" | "out" | "low" | "ok", why?: "usage_limit" | "refused" | "signed_out" | "plan_ended" | "billing" | "by_hand" | null, back_at?: epoch s | null, by: string (<= 80), at?: epoch s }`. `state` and `why` come only with `set`. The principal clears either owner's seat from Home.

## 2. What the pool does today (read 2026-10-24)

All VERIFIED by reading the script; nothing was run against a real account.

- **Numbers come from the status line.** Every lane's status line writes the account's windows to a per-account file the pool reads (`usage()`, `claude-pool:205-226`): used percent and reset per window, a window whose reset has passed counts as full again. An account with no live lane has no fresh numbers.
- **The probe fills the gap for accounts with no live lane** (`probe()`, `claude-pool:832-884`; `probe_due()`, `:887-900`). It starts the CLI in a hidden terminal session, types `/usage`, and parses the words "Current session" and "Current week (all models)" off the screen (`parse_usage_screen`, `:817-829`). Any other screen, for any cause, is one outcome: the log line "no usage on screen" and `return False` (`:871-874`). It runs for a logged-in seat that is not retired, not lapsed and has no live lane, at most every 20 minutes (`:893`), when its numbers are missing, older than an hour or past a reset. It writes the result into the same per-account file with `source: "probe"`.
- **Marks.** `exhausted NAME [MINUTES]` (the failure hook on a rate limit) and `set_mark()` (`:228-236`) mark an account out of usage until a time; `exhausted_until()` (`:239-265`) drops a mark that numbers read after it contradict (at least 25% left in both windows). `flag NAME ERROR` (`:45` in the help) records a billing, authentication or account-on-hold failure from the hook, and `retired.json` holds seats taken out of rotation, with a reason.
- **Lapse.** `lapsed_reason()` (`:300-309`) retires a seat from the login's non-secret tier and the configured expiry; a lapsed seat can still read "ok" until then (F21 in the plan).
- **Guard.** `_guard()` (`:985-1058`) probes one due account per run, retires accounts whose plan is no longer a paid one, and moves lanes off accounts whose state is not `ok` (`state_of()`, `:312-331`: own login, logged out, retired, lapsed, out of usage, low, ok). Run every 2 minutes by a timer and right away by the failure hook on a rate limit.
- **Outward.** One notification to the lane-watcher (`:584`, `notify_once`). No call to any hub route. The hub reads the pool's own account/usage file for **labels only** (name, email, organization, plan, tier; never the organization id) when `MORNDO_POOL_USAGE` names it (`apps/hub/src/adapters/pool-accounts.ts`, VERIFIED).

## 3. The gap: the 78% "no usage on screen"

Evidence (plan section 3.4, audit window 10-15 21:00 to 10-20 00:00; this brief repeats it, it does not re-measure it): 524 of 674 probes failed with "no usage on screen". The 524 are 139 + 186 + 199 failures from **three seats**, each an unbroken streak that began on a different day after that seat had read fine; each seat was later marked by a failed lane turn (two refused by their organization, one lapsed). The three other seats probed in those hours read 128 times with 0 failures. The probe logs one line for every cause and retries every 20 minutes (`:871-874`, `:893`).

- **Leading hypothesis (H1, INFERENCE):** those seats' state changed (refused, lapsed, signed out), so the screen was not the usage screen, and the probe could not tell. The pool then spent a hidden session every 20 minutes for days on seats it should have retired.
- **The question that stays open (H5, UNVERIFIED):** whether the usage endpoint's own rate limit played a part. It fits worse (streaks of days, onsets days apart, healthy seats unaffected) but is not excluded, and no screen was kept to tell.
- **Why the design does not depend on the answer:** every failure gets a class, `rate_limited` and `signed_out` become different things on Home, and the headless reader makes the screen irrelevant (plan section 4.4).

**What to change in `probe()` before it is retired** (each item is independent; items 1 to 4 are the interim, 5 is the end state):

1. **Classify what it sees.** From the captured screen (and, when it is available, the CLI's own `auth status`, local and without a network call: exit 0 means signed in), return one of the hub's closed reasons instead of `False`: `signed_out` (login prompt, "not logged in", a sign-in screen), `refused` (an organization's refusal screen), `rate_limited` (the usage screen names a limit and a retry), `no_usage_for_plan` (a plan with no usage screen), `plan_ended`, `unreachable` (the CLI did not come up in 45 s), `timeout`, and `unknown_screen` for everything else. The matching words are the failing screens' own, matched in memory and **not kept**: record only the class and a hash per seat and class (item 2). That leaves the plan's open question OQ2 (the screen text of each failing class was never kept) unanswered by design; the class plus the hash tells whether two failures are the same shape, and anything more needs the owner's decision (OQ-P1).
2. **Keep the class and a hash, never the screen's words.** Per seat and class, store the class, when it first and last happened, and `unknown shape <8 hex of a sha256 of the screen's first 120 characters>` (enough to tell two broken shapes apart). A redacted head cannot be made safe by pattern: a name, an organization id or a welcome line does not match any shape, which is why the repository's own reader dropped the head entirely (slice 5 fix round, finding 5). Post the class, not the screen.
3. **Back off a failing seat.** Per class: transient (`rate_limited`, `unreachable`, `timeout`) 20 minutes, then 1 hour, then 6 hours, then daily, reset by one good read. A permanent class (`signed_out`, `refused`, `no_usage_for_plan`, `plan_ended`) is not retried by time at all: it ends by `claude-pool login`, `activate`, or the principal clearing the seat. This is `probe_due()` gaining a per-seat failure counter next to `probed.json`.
4. **Gate a signed-out seat on `auth status`.** After a `signed_out` result, spend no further hidden session on that seat until `auth status` says signed in (or six hours passed), as the repository's reader does.
5. **Retire the terminal probe for usage** on every seat whose login sits on a node that runs `morndo-usage-claude` (the collector, slice 5): its headless `/usage` read is rationed by the hub, on demand, never by a timer, and a `setup-token` login has no usage scope (it reads as `no_scope`; the seat needs a full login on that node). A seat no collector can reach has two honest options: retire the probe there too (it then has the status line's numbers only, and the hub shows it as stale or unavailable instead of guessing), or keep the hidden-terminal probe as a **retained exception**. The exception is *not* covered by the decided terms below (they allow only the CLI's own headless `/usage`), so keeping it needs the owner's explicit decision (OQ-P4); until that decision is recorded, retire it, and in the interim apply the classification, backoff and `auth status` gate above. A Team seat is covered by the headless report (same `session` and `weekly_all` windows); no special case. Terms (decided): Claude usage is read only by the unmodified CLI's own headless `/usage`, never the OAuth usage endpoint, a token, a credentials file or a dashboard; the pool must not harvest tokens for usage either.

**After step 5, what feeds the pool's own `pick()` and `guard`?** Today the per-account file. Two honest options; the operator chooses:

- **A (smallest, recommended first):** keep the file as the pool's numbers (status line plus, for unreachable seats, nothing), and treat "no fresh numbers" as **unknown**, not as full: the existing rule "a window whose reset has passed counts as full again" stays (it is a reset, not a silence), but an account with no number at all and no live lane is ranked below one with a known number. Seats are still protected by the hub-side marks (below).
- **B (later, after T-430):** the pool asks the hub's principal-only view. Not possible for a bot token today (`/api/usage` is for the principal's session); it would need a read route for the pool token, which does not exist and is not part of this work. UNVERIFIED that it is wanted.

## 4. What the guard must post to the hub

The pool owns a seat state; the hub must hear it. Post to `/api/agent/usage/pool` with the pool token on every **change** of a seat's pool state (not every guard run: the hub keeps one pool word per account and tells one notice per change).

| Pool state (`state_of`, `:312-331`) | Post | Notes |
|---|---|---|
| logged out | `set`, `state: "logged-out"`, `why: "signed_out"` | sticky until `cleared`; never expires by time |
| retired by `flag` (billing, authentication, account-on-hold) | `set`, `state: "retired"`, `why: "billing"`, `"signed_out"` or `"refused"` by the hook's error | `by` names the hook, never a person |
| retired as lapsed (`lapsed_reason`, plan change in `_guard`) | `set`, `state: "retired"`, `why: "plan_ended"` | |
| retired by hand (`retire NAME`) | `set`, `state: "retired"`, `why: "by_hand"` | `activate` posts `cleared` |
| out of usage (`exhausted`, `set_mark`) | `set`, `state: "out"`, `why: "usage_limit"`, `back_at` = the mark's end | when numbers contradict the mark and `exhausted_until` drops it, post `cleared` |
| low (`fiveMinLeft` / `weekMinLeft`) | `set`, `state: "low"` | optional; the hub's thresholds already tell low windows |
| ok again | `cleared` | |

Rules the pool must follow:

- **Idempotent and ordered.** Send the change once, with `at` = when the pool decided (seconds); retry a failed post with the same body. A post that fails is logged (without the token) and retried on the next guard run; the guard never blocks on the hub.
- **No numbers in a seat post.** The pool posts a seat's state and reason, not windows; windows are readings.
- **No account is invented, and the hub does not stop it here.** The `account` is the pool's own account name (the hub resolves it like the status line's `X-Morndo-Account`). The pool must post only the names it manages. The per-token bound on new unknown names (5 an hour) exists **only on the lease path** (`LeaseBook`); `/api/agent/usage/pool` and `/api/agent/usage/limit` check only that the name is well formed, so a pool-token post for any invented name stores a seat and tells a notice, with no bound. T-430 (leases bound to the accounts a node really reports) must cover these two routes as well: the hub should refuse a seat or limit post for a name no node reports and no lane has used.
- **The pool posts seats, never readings.** The pool token can also post an *unleased* reading for any account (the readings route takes any agent token); such a reading changes the windows Home shows and the thresholds that watch them. The pool has no reading to post, so it must not use that route at all; its numbers stay in its own state, its words go through `/pool`.
- **The failure hook stays.** `exhausted` and `flag` keep marking the pool's own state first (the guard acts on it at once); the post to the hub is an addition, not a gate. The fleet's own tap derives a seat from the same failure for lanes the pool does not know; when both exist, the pool's word wins and the notice is told once.
- **The token never leaves its file.** Read per call; never exported into a lane's environment, never in `ps`, never in `notify_once` text.

## 5. Moved lanes and the account word

A lane moved to another account by `move()` is not a lane the hub started, so the hub's lane record can be stale until the lane's next report (R7 in the plan). The failure hook should send the account name (the documented `MORNDO_ACCOUNT` word) with the failure, so the hub resolves a first-turn failure (`oauth_org_not_allowed` is exactly that case). The hub only trusts that word for an account seen on that node (slice 3 rule); a lane started by hand has no start record. This is a one-line change in the hook's call, not in the pool.

## 6. Where the pool must NOT change

- No proxy, no token pooling, no reading of a credentials file for usage: unchanged and out of scope.
- No change to `pick()`'s ranking beyond the "unknown ranks below known" rule of option A.
- No change to how lanes are moved (`move`, `guard`'s lane logic): only what the guard **posts** and what the probe **returns** change.
- The probe's hidden terminal handling (trust prompts, `UI_RE`) is left as is while it exists.

## 7. Tests

The pool's own scenario tests live beside it (`test_pool.py`, `test_rotation.py`, `test_identity.py`, under the pool's data directory). Add, with a fake hub (a local HTTP server) and a fake `claude` that prints a chosen screen; **never** the real CLI or a real account:

1. **Classification table:** one captured-screen fixture per class (signed out, refused, rate limited, no usage for plan, unknown) returns that class; an empty screen after the 45 s wait is `unreachable`; a screen with a link, an address, a UUID and a long hex run keeps none of them in the stored head.
2. **Backoff:** a transient class is retried at 20 minutes, then 1 hour, then 6 hours, then daily, and a good read resets the counter; a permanent class is never retried by time; `activate` and `login` reset it.
3. **The 78% replay:** feed the three-seat streak shape (a seat reads fine, then fails the same way every probe) and assert at most the backoff's number of probes in the window and exactly one class change posted, not a post per probe.
4. **Seat posts:** each pool state change posts exactly the table's body once (fake hub records bodies); a failed post is retried with the same body; the token appears in no log line, no notification text and no process argument list.
4a. **The account mapping, three ways (swap-proof).** Three seats in three different states (say `seat-a` logged out, `seat-b` out of usage until a back time, `seat-c` retired by hand), and three names that must agree: the pool's account name, the account name in the collector's config (`accounts: { <name>: ... }`), and the name the lanes already report under (`MORNDO_ACCOUNT` / `X-Morndo-Account`). Against the fake hub assert: (i) each seat post's body names its own seat with its own state (distinct states per seat, so a seat-a state posted under seat-b fails); (ii) every account name in the collector config exists in the pool and every pool account that has a collector is in the config (a mismatch is a failing check, not a log line); (iii) the same name in a seat post, in a reading and in a lane's report shows as **one** account in the hub's view, with the seat on that account and no second account created. A fake hub has no view, so this check runs against the real hub in process (the repository's own `startInProcessHub` test helper, or a hub started from a release): post the three kinds of word for each name and read the principal's `GET /api/usage`; it belongs in the integration test, not in the pool's unit test with the fake hub; (iv) a name that only the pool knows, or only the collector, is reported by the check instead of being posted. Mutation check: swap two seats' names in the pool's state and the test must fail.
4b. **Invented names:** because the hub does not bound them on `/pool` and `/limit` (T-430), the pool's own test asserts it posts no name outside its account list, whatever a stale state file says **and whatever the failure hook's text names**: feed the hook an error string that names an account the pool does not manage (and one that is a near-miss of a managed name, differing by case or a trailing space) and assert nothing is posted for it and no seat is created for the managed name by mistake.
5. **No double word:** `exhausted` then the hub's derived mark for the same failure: one notice on Home (hub side, already tested: `usage-seats.test.ts`), and a `cleared` from the pool ends only the pool's word.
6. **Probe retirement:** with the collector configured for a seat, `probe_due()` is false for it; without, the classified probe runs.

Manual QA (record in the lane's notes, with screenshots of Home): a seat signed out on purpose shows "Can't read since ..., Fix: sign in again" within one guard run; `claude-pool retire seat-b` shows a retired seat with "set by the pool" on its card; `activate` clears it; the same account's lane limit hit shows once.

## 8. Rollout (each step reverts alone)

1. Mint the pool token and store the file (no behaviour change).
2. Probe classification and the class-plus-hash record (log only).
3. Backoff and the `auth status` gate (fewer hidden sessions).
4. The seat posts (the hub starts hearing the pool).
5. Retire the probe on seats a collector reads.

Verification after each step is the 78% audit re-run (plan appendix A) over the new log: the share of "no usage on screen" with no class must be zero, and the number of probes per failing seat per day must follow the backoff.

## 9. Open questions

- **OQ-P1:** may a probe be run on a retired seat to capture the failing screens once (needs the owner's OK; the plan's OQ2)? Until then the first classified failure keeps only its class and hash.
- **OQ-P2:** option A or B for the pool's own numbers (section 3)? A needs nothing from the hub; B needs a read route for the pool token.
- **OQ-P3:** who owns the pool's tests and the token file? Out of this repository.
- **OQ-P4:** keep the hidden-terminal probe as a retained exception for a seat no collector reaches? The decided terms allow only the CLI's own headless `/usage`; the exception needs the owner's explicit decision. Recommended default: retire it.
