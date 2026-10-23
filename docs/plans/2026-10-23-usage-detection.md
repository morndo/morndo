# Usage detection that catches limits for every user: plan

**Phase: plan only.** No code, no pull request. Board T-414, 2026-10-23. Revised three times the same day: round 1 and round 3 (review comments), round 2 (the owner's "make all usage checks more robust, check how other open-source repos do it", with a research brief from the Mac session). Builds on [ADR-0016](../adr/0016-home-usage-across-accounts.md) (Usage, U1 to U5), [ADR-0029](../adr/0029-account-pool.md) (the pool's seats) and [ADR-0034](../adr/0034-account-labels.md) (labels). A short ADR draft is [ADR-0036](../adr/0036-usage-reading-health.md).

Facts carry a citation. `path:line` is this repository at `4a0274cf` (main, 2026-10-23). `pool-script:N` is the pool script a user may run beside Morndo (`claude-pool`, outside this repository, lines read 2026-10-23); `cursor-collector` and `zai-collector` are the two usage collectors that post to Home from outside the repository (the Cursor one was being edited the same day, so it is cited by function). **VERIFIED** marks a claim checked against a primary source or a run on 2026-10-23 and named as such; **INFERENCE** a conclusion drawn from evidence; **UNVERIFIED** what no source or run settled. Account names are made up (`seat-a`, `seat-b`, `seat-c`).

---

## 0. Owner summary

**The problem in one paragraph.** Home shows numbers it was once told and cannot say when they stopped being true. A reader that fails posts nothing, so Home keeps the last figures with no sign of age (`packages/domain/src/usage.ts:44`, `:148-154`; `apps/web/src/lib/desktop/HomeView.svelte:79`). A status-line value that is not a percentage is shown as 100% (F25). Window names are chosen by whoever wrote the reader, so a plan that changes cadence is mislabelled until a person notices. A limit hit is handled by three code paths that never meet. None of this is special to one machine.

**What the open-source monitors do that we do not** (the Mac session's brief, checked here where marked): a typed reading that carries its source, time, plan and window length; four honest states instead of one; a reader per account that is rationed (lock, cache, cooldown) because the usage endpoint is rate limited; a limit decided from events and flags, not from percentages; a baseline reset and one notice when a plan changes; fixtures per source and edge case. The same Cursor bug (a weekly pool shown as monthly) was fixed in CodexBar on 2026-10-22 (F31, VERIFIED).

**The decided design (the owner delegated the calls).**
1. **Claude, primary source: the CLI's own headless `/usage`** (`claude -p /usage --output-format stream-json`), a documented, structured report. It replaces the terminal-screen probe. It is rationed **by the hub across all machines** (a lease per account, a shared cache and cooldown), and it is read **on demand, not on a clock** (§4.4). VERIFIED on this box (F27): 0 turns, $0.
2. **Claude, secondary: the status line,** cheap for busy accounts, with guards (stale after 10 minutes, reject a non-percentage, keyed by account). Of two readings the newer by capture time wins; a disagreement is shown, not resolved silently.
3. **Limit hits** come from events and flags (a rejected rate-limit event, a usage-limit error, `ordinaryUsageAllowed` false), the same rule for lanes and the manager; the account stays blocked until its reset time and **only a fresh read taken after it** clears the mark.
4. **Codex** reads are upgraded (per-limit buckets, account and plan change, pushed updates, slower adaptive polling under the same rationing, never faster than once a minute). **Cursor** stays on the CLI's own screen (its terms), with the period derived from the reset and the pool labelled "shared with Grok". **Z.ai** is parsed by unit and number, with its known drift covered.
5. **Home shows four states** per source, available, stale, unavailable, missing; never old numbers as current; one notice per plan change and per threshold crossing.
6. **Never:** the undocumented OAuth usage endpoint with harvested tokens, a credentials file, or a local transcript estimate as a limit (§6).

**The Claude probe's "no usage on screen" in 78% of probes (524 of 674, 10-15 21:00 to 10-20 00:00): a hypothesis with evidence, not a settled cause.** *Evidence:* the 524 are 139 + 186 + 199 failures from **three seats**, each an unbroken streak that began on a different day after that seat had read fine; each seat was later marked by a failed lane turn (two refused by their organization, one lapsed). The three other seats probed in those hours read 128 times with 0 failures. The probe writes one line for every cause (`pool-script:872-874`) and retries every 20 minutes (`pool-script:893-894`). *Leading hypothesis (H1):* the seats' state changed. *The Mac's question (H5):* was it the usage endpoint's rate limit? It fits worse (streaks of days, onsets days apart, healthy seats unaffected) but is **not excluded**, and no screen was kept to tell. The design does not depend on the answer: every failure gets a class, `rate_limited` and `signed_out` become different things on Home, and the headless reader makes the screen irrelevant (§4.4).

**Three options. One tap each.**

| | Option | What it buys | Cost (INFERENCE, in lane-days) |
|---|---|---|---|
| **1 (recommended)** | **Robust readings for every source.** The seven slices of §5: typed readings and four states; Claude headless reader with rationing; status-line guards; Codex upgrades; Z.ai and Cursor period fixes; one seat state and one notice for limit hits from any reporter; threshold and plan-change notices; fixtures per source. | All five gaps and the owner's "robust" ask. Works for any user's collectors and accounts. | **7 pull requests, about 10 to 13 days** (round 3 adds the hub-side lease, on-demand reads, the single-account and env-style resolution, and the seat lifecycle), plus a short brief for the operator's pool script (retire its tmux probe; about 1 day, outside this repository). Machines whose lanes use `setup-token` tokens need a full login per account or a reading from a machine that has one (§4.4). |
| 2 | **Honest readings and the Claude headless reader only.** Slices S1, S2, S4, S5: typed readings, four states, titles from length, rationed headless reader, status-line guards. No fleet tap, no seat state, no Codex, Z.ai or Cursor changes. | Home stops showing old numbers as current, Claude is read by a documented source, the 78% stops mattering. Limit hits stay as they are. | 4 pull requests, about 6 to 7 days (it includes the lease and on-demand reads). |
| 3 | **Option 1 plus Claude in Morndo's pool** (the product team's proposal B). | Claude accounts leave the outside pool script. | 12 or more pull requests, 3 weeks or more, a terms review, a phone-side sign-in nobody has verified. Less needed now: the headless reader removes the pool's worst usage problem without it. |

Recommended: **Option 1.** Tap "Go: option 1" and the manager files the seven slices with the acceptance tests named in §5. Option 2 is the cut line if time matters: it can ship alone and Option 1's other slices follow.

**Decisions the plan makes by default (undo by saying so):**
- A source that cannot be read replaces its meters with "can't read since X" (§4.3); a source that is only old keeps its meters, dimmed, with its age.
- No credential file is read by anything in this repository (§6); plan names come from what a provider's own CLI or documented API prints.
- Usage still decides nothing (U4): a seat state is displayed and told, never routed on.
- Nothing an agent token posts as free text is shown as a remedy: a remedy is a closed list; other text is shown as "the source says", short, plain, no links (§4.5).
- A plan change or a drop is told only after a second reading confirms it (U8).
- **A judgement call stays with the owner (§6):** whether running the unmodified CLI's own `/usage` on demand, per account, is acceptable under Anthropic's consumer terms ("automated or non-human means ... where we otherwise explicitly permit it"). The plan keeps the cadence as low as works; the fallback that needs no such judgement is the status line alone.

---

## 1. What exists today

| # | Fact | Source |
|---|---|---|
| F1 | Usage keeps per account the newest report's windows; a window a report lacks is kept until its reset time passes, then dropped. There is no age beyond `reportedAt` and no failure state. | `packages/domain/src/usage.ts:44`, `:117-140`, `:148-154` |
| F2 | Home shows "reported {ago}" per account and "Usage as of" for the view; a window never reported reads "not reported". | `apps/web/src/lib/desktop/HomeView.svelte:39-40`, `:48`, `:79`; `apps/web/src/lib/desktop/usage.ts:33-35` |
| F3 | The status-line route takes the agent CLI's own JSON. A window is `five_hour`, `seven_day` or `spend_limit`, or a named row with a label the poster chose. | `packages/protocol/src/usage.ts:23-38`; `apps/hub/src/application/usage-service.ts:13-33` |
| F4 | Claude Code puts `rate_limits` in the status line **only for claude.ai Pro and Max subscribers** (or behind a gateway with a spend limit), **only after the first response of a session**, each window may be absent, and a window is dropped at its `resets_at`. VERIFIED, https://code.claude.com/docs/en/statusline, read 2026-10-23. | statusline docs, "rate_limits" note |
| F5 | The built-in `/usage` command shows session cost and plan usage limits, on Pro, Max, Team and Enterprise plans. VERIFIED, https://code.claude.com/docs/en/commands, read 2026-10-23. | commands docs, `/usage` row |
| F6 | The Codex reader already labels a window from its own length (`windowDurationMins`): 300 is "5-hour", 10080 is "7-day", otherwise "N-day/hour/minute window", null is "Window". It already reads the other limits (`rateLimitsByLimitId`). The rule lives in an adapter, not the domain. | `apps/connections/src/adapters/usage-codex.ts:14-15`, `:54-68`, `:71-78`, `:82-99` |
| F7 | An answer in an unknown shape is "unavailable", never a guess; the reader returns a problem string. Nothing carries that problem to the hub. | `apps/connections/src/adapters/usage-codex.ts:8-9`, `:110-111` |
| F8 | The pool's domain has the vocabulary for a seat: states `logged-out`, `retired`, `out`, `low`, `ok`, a `backAt`, marks with an end time (default 60 min, at most 168 h), and a reading with windows that carry `minutes`. Codex-only today. | `packages/domain/src/pool.ts:24-27`, `:53-66`, `:199-205`, `:263-296`; `apps/connections/src/pool-cli.ts:24` |
| F9 | The pool decides a window is "short" or "long" by sorting on `minutes`, not by a name. | `packages/domain/src/pool.ts:219-224` |
| F10 | A notice about a seat exists for one case only (reset-credit advice), once per member and reason per day, recorded so it does not repeat. | `apps/connections/src/application/pool-service.ts:44`, `:254-262`; `apps/connections/src/pool-cli.ts:197-210` |
| F11 | A usage limit on a Codex turn marks the member out until the reset the failure names; a sign-in failure marks it signed out and keeps the marks. | `apps/connections/src/application/pool-service.ts:195-200`; `apps/connections/src/pool-cli.ts:378-380`, `:412-428` |
| F12 | A failed turn on any lane reaches the fleet as a `stop_failure` event whose `error` is up to 60 characters. Nothing in the hub reads it for an account. | `apps/fleet/src/application/lane-events.ts:79`; `packages/protocol/src/fleet.ts:287`; `apps/fleet/README.md:117` |
| F13 | The hub reads the pool's usage file for label parts (email, org, plan). A tier that is empty or the free tier reads as "no paid plan". That file is refreshed every 60 s; on a machine whose lanes use pool tokens it is the only source of the PC's readings (`MORNDO_POOL_USAGE`). | `apps/hub/src/adapters/pool-accounts.ts:11-24`, `:65-121`; `apps/hub/src/main.ts:348-350`; `apps/hub/src/config.ts:22` |
| F14 | The hub keeps each account's last state in `usage_accounts`, and `UsageService` takes `now` as a parameter (testable with a fake clock). | `apps/hub/src/adapters/store.ts:614-618`; `apps/hub/src/application/usage-service.ts:56-60` |
| F15 | The Z.ai collector picks windows by fixed codes (unit 3 / number 5 is "five_hour", unit 6 / number 1 is "seven_day"), accepts a `TOKENS_LIMIT` as the 5-hour window, and exits 1, posting nothing, when neither is present. It checks the HTTP status and `success == false`, not a `code` inside a 200. | `zai-collector:43-64` |
| F16 | The Cursor collector reads the CLI's own `/usage` screen. A screen it does not know raises `UnknownScreen`, logs a warning and posts nothing (`main`). On 2026-10-23 the screen still printed the caption "Monthly plan and on-demand usage" while the plan was on a weekly pool, so it now decides weekly or monthly from the reset distance, the plan name and the first date it saw a reset (`classify_period`). That rule lives inside one collector, with its own state file. | `cursor-collector`: `parse_usage_screen`, `classify_period`, `main` |
| F17 | The pool script's probe types `/usage` into a hidden terminal and parses "Current session" and "Current week (all models)". Any other screen is the same outcome: log "no usage on screen" and return. | `pool-script:817-830`, `:832-884` (failure at `:872-874`) |
| F18 | The probe runs only for a logged-in seat that is not retired, not lapsed and has **no live lane**, at most every 20 minutes, when its numbers are missing, older than an hour or past a reset. A seat with a live but idle lane is not probed, and the status line posts only when the lane takes a turn. | `pool-script:887-901` (`:889`, `:893-894`) |
| F19 | Usage-limit errors from a lane reach the pool through a failure hook: `rate_limit` marks the seat out until the later reset; `billing_error`, `authentication_failed`, `account_on_hold`, `oauth_org_not_allowed` flag it (retired, or 30 minutes for a token-refresh race). The hook runs before it checks for a terminal, so headless runs also mark. | hook script: lines 7-17; `pool-script:1241-1272` |
| F20 | The manager and the studio lane are looped windows. The guard moves them by a restart script, and reports a failed move with a different note than a lane's move. | `pool-script:87`, `:724-731` |
| F21 | The pool script retires a seat as "lapsed" from the credentials file's non-secret fields (tier, subscription type) and the configured expiry; a lapsed Max plan reads as "ok 100%" until then. | `pool-script:186-203`, `:294-326` |
| F22 | On this box today, three seats' usage files are 7, 10 and 14 days old, still holding their last numbers, with no sign of age anywhere. | usage files of the pool, mtimes read 2026-10-23 |
| F23 | The fleet's lane-event consumer drops the manager's own window and any ignored window before it makes an event, so a manager's `stop_failure` produces no lane event at all. A `stop_failure` event has a lane (window) and a node and an `error` of up to 60 characters; it has **no actor and no account**. | `apps/fleet/src/application/lane-events.ts:62`, `:79`, `:150-152` |
| F24 | A lane started through the fleet carries its account in `lane.start`; the node's launcher takes it as `{account}` and refuses a start that disagrees. A lane started by hand, or moved to another account by a pool script, is not a `lane.start`. | `packages/protocol/src/fleet.ts:161`, `:365`; `apps/node-agent/src/ops/lane-engine.ts:35-38`; issued at `apps/hub/src/console/lanes.ts:343` |
| F25 | A status-line `used_percentage` of any finite number is accepted and clamped to 0..100. A timestamp in that field (a real bug: anthropics/claude-code#52326, closed, VERIFIED with `gh` 2026-10-23) therefore shows as **100%, "nearly out"**. | `apps/hub/src/application/usage-service.ts:15-17`; `packages/domain/src/usage.ts:41-42` |
| F26 | `SDKUsageReport`: `session{...}` and `rate_limits{ limits[]: {kind, group, percent, resets_at (ISO or null), scope?{model?, surface?}, severity (string), is_active}, extra_usage?{is_enabled, monthly_limit, used_credits, utilization, currency} } \| null`. `rate_limits` is null "when Claude Code couldn't get the plan's usage, for example when the session's OAuth token lacks the `user:profile` scope". **The type is experimental: its shape may change.** It carries no fetched-at or last-known marker. VERIFIED, https://code.claude.com/docs/en/agent-sdk/typescript, read 2026-10-23. | SDK reference, "SDKUsageReport" |
| F27 | `claude -p /usage --output-format stream-json --verbose --no-session-persistence < /dev/null` on this box (Claude Code 2.1.309, a full login): one message event carrying `usage_report`; limits of kind `session`, `weekly_all` (the active one) and `weekly_scoped` (with a model scope); `extra_usage.is_enabled` false; result `num_turns` 0, cost $0, `duration_api_ms` 0. **Wall time 74.5 s** (the Mac session saw 7 to 11 s): user-level hooks started in the print run, on a busy box. VERIFIED by a run, 2026-10-23. | run; shape in appendix B |
| F28 | When the plan-limits request fails, "most often because the usage endpoint is rate limited", the interactive `/usage` shows the last bars it loaded on this machine within 60 minutes with a "Showing last-known usage" note. Whether the headless report does the same is **UNVERIFIED**, and the report has no marker (F26). VERIFIED for the interactive text, https://code.claude.com/docs/en/costs ("When the usage request fails"), read 2026-10-23. | costs docs |
| F29 | `SDKRateLimitEvent`: `rate_limit_info.status` is `allowed`, `allowed_warning` or `rejected`, with optional `resetsAt` (seconds), `utilization`, and `errorCode: "credits_required"` for a subscription whose included usage is exhausted. VERIFIED, SDK reference, read 2026-10-23. | SDK reference |
| F30 | Codex app server: `account/rateLimits/read`; `rateLimitsByLimitId` "is the multi-bucket view keyed by metered limit_id"; `account/rateLimits/updated` "emitted whenever a user's ChatGPT rate limits change"; `account/updated` carries `authMode` and `planType`; `rateLimitReachedType` "identifies the server-classified limit state when one has been reached"; `windowDurationMins` and `resetsAt` (seconds). The schema also has `ordinaryUsageAllowed` (openai/codex `GetAccountRateLimitsResponse`, code search 2026-10-23). VERIFIED. The Codex TUI's polling cadence (60 s, 30 s at 75%, 15 s at 90%, 5 s at 99%) is the Mac session's reading of the source at 970111f: **UNVERIFIED here**. | https://learn.chatgpt.com/docs/app-server (read 2026-10-23) |
| F31 | The same Cursor bug, fixed elsewhere: steipete/CodexBar#4545 (closed) and PR #4695 (merged 2026-10-22 09:23Z). VERIFIED with `gh`. That project reads an undocumented dashboard call; this plan does not (§6). | `gh api` |
| F32 | Our own tests assume a monthly included-usage period: `period: "included usage, monthly"`. | `apps/hub/test/usage.test.ts:83`, `:104` |
| F33 | Anthropic's Consumer Terms (effective Oct 8, 2025, read 2026-10-23), Section 3, item 7: "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise." Section 2: "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else ... or make your Account available to anyone else." The Commercial Terms (effective Jun 17, 2025, which govern Team and Enterprise per the legal page) have no clause on automated access; D.2 ties use to a Usage Policy that was not read. VERIFIED. | https://www.anthropic.com/legal/consumer-terms; https://www.anthropic.com/legal/commercial-terms |
| F34 | The documented way to name an account is `MORNDO_ACCOUNT` in the lane's environment (lanes without it report under `default`); the config-directory name is a pool-script convention. | `docs/agents/usage.md:15-16`, `:23`; `packages/domain/src/usage.ts:32` |

---

## 2. Principles

1. **Every user, not one owner.** Nothing in the design names a vendor, a machine or an operator script. A source tells the hub what it read, when, and how often it will read again.
2. **Say when you can't read; never show old numbers as current. Unknown is never 0%.**
3. **Name a window by what it is.** Its length if the source gives it; else what was observed; else only its reset. Never a name a collector hard-coded.
4. **One thing, said once.** A state change produces one notice, whoever caused it.
5. **Read only what the provider's own CLI or documented API shows** (§6). No credential files, no dashboards, no bundles, no undocumented endpoints.
6. **Degrade the label before the reading.** A screen whose caption is unknown but whose percentages parse still posts the percentages.
7. **Ration every reader.** A usage endpoint is somebody's rate-limited service: one reader per account, a cache, a lock, a cooldown.
8. **Decide a limit from an event or a flag, not from a percentage.**

---

## 3. Evidence

### 3.1 Labels (gap 1)
F15 and F16 show two collectors with two private rules; F32 shows our own tests with a third. F16's comment states the weakness: the caption "says nothing" and the rule is wrong "only for a monthly plan in its last week and not yet watched from the start of that month". A stateless collector cannot do better; the hub holds every account's earlier reports (F14).

### 3.2 Plan change (gap 2)
F13 turns a tier change into "no paid plan" for a label, silently. F21 finds a lapse by heuristic over a credentials file. Neither tells anyone *what changed*. Codex gives `planType` and an `account/updated` notification (F30).

### 3.3 Silence and false certainty (gap 3)
F1, F2, F7, F16, F22: a failed read has no path to Home, and an unread account keeps its last figures. F25: a bad value is shown as 100%.

### 3.4 The 78% (gap 4): evidence, then hypotheses

Counted from the pool's `guard.log` (`probe NAME: ...` lines), window 10-15 21:00 to 10-20 00:00 box time:

| | Probes | Outcome |
|---|---|---|
| seat-a | 139 | all "no usage on screen" |
| seat-b | 187 | 186 "no usage on screen", 1 "claude did not come up" |
| seat-c | 220 | 21 read before its plan ended, then 199 "no usage on screen" |
| three other seats | 128 | all read |
| **Total** | **674** | **524 "no usage on screen" (77.7%), 149 read, 1 did not come up** |

Each failing run is one unbroken streak per seat. From each seat's first failed probe to the event that finally marked it:

| Seat | First failed probe | Marked by | Gap |
|---|---|---|---|
| seat-a | 10-14 18:21 | a lane turn failed with `oauth_org_not_allowed`, 10-17 22:23 | 76 h |
| seat-b | 10-13 17:43 | same error, 10-18 15:21 | 118 h |
| seat-c | 10-17 01:05 | lapse noticed from the plan's expiry, 10-21 13:49 | 109 h |

Every seat read fine until its streak began (seat-a until 10-14 17:20, seat-b until 10-13 16:41, seat-c until 10-17 00:04), and the onsets are days apart. The classes cannot be told apart from the log, because `probe()` logs one line for all of them (F17). On 10-21 the operator added a "lapsed" skip to the probe (F18 `:889`; **INFERENCE** from that day's backup of the script and the last failure at 13:45).

| Hypothesis | Fits | Against | Status |
|---|---|---|---|
| **H1** the seat's state changed (refused, lapsed) and the CLI shows no usage block for it | Onset after a good read; each seat later marked; the three healthy seats unaffected | Nothing contradicts it; nothing confirms the screen | Leading, **UNVERIFIED** |
| H2 a layout that differs by plan type | The parser asks for "Current week (all models)" only (F17) | Each seat read fine before its onset | Unlikely |
| H3 a transient fault in the service or the CLI | | Three onsets on three days; streaks of days; healthy seats read throughout | Unlikely |
| H4 the probe's environment (trust dialog, folder) | "claude did not come up" is a separate line | Same folder and command for every seat | Unlikely |
| **H5** the usage endpoint rate-limited those seats' tokens (the Mac's question; the CLI documents this as the usual failure, F28) | The documented usual cause; a rate-limited interactive `/usage` shows no bars after 60 minutes | A limit that clears would not hold a seat for 76 to 118 hours at 20-minute intervals, nor start on three different days for three seats whose lane turns failed with refusal soon after | Not excluded, **UNVERIFIED** |

What settles it: one captured screen head per failing seat, or the classes of §4.4 once the headless reader is in (it separates `rate_limited` from `signed_out` and `refused`). Under H1 the probe's failure was the earliest signal of three seat problems and was thrown away; the timing is **consistent with** that, which is all it shows.

A second effect (INFERENCE): the status line cannot cover a Team seat. Claude Code documents `rate_limits` for Pro and Max only (F4), and `/usage` for Team too (F5). The headless `/usage` (F26, F27) covers it.

---

## 4. Design

### 4.0 Words and rules

New words (to join `docs/domain.md`'s Usage section):

| Term | Means | Is not |
|---|---|---|
| **Reading** | One read of a source for one account: `source`, `node`, `capturedAt`, `plan` (or null), and windows, each with `id`, `usedPercent` (or **null**, never 0), `resetsAt`, `lengthMins` (or null), `rolling` and a short `note` (for example "shared with Grok"). Or a failure with a Reason class. | A Report (a session's status line). |
| **Source** | A named way figures arrive: `status-line`, `claude-usage` (the headless report), `app-server`, `cli-screen`, `vendor-api`. Keyed with the account and the node that read it. It may declare `every` (seconds, clamped to 60 s to 6 h). | A Connection, a runtime. |
| **State** (of a source) | `available`, `stale`, `unavailable`, `missing` (the Codex TUI's four). | A window. |
| **Reason class** | Why a read failed: `unknown_screen`, `signed_out`, `refused`, `no_usage_for_plan`, `plan_ended`, `no_scope`, `rate_limited`, `unreachable`, `timeout`. A closed list. | A message to show. |
| **Cadence** | How long a window is, with its basis: `reported`, `observed` (two resets seen), `horizon` (only the furthest reset seen), `none`. | A name. |
| **Plan fact** | The plan name, an account identity digest where the source gives one, and the set of window ids with lengths. | An entitlement. |
| **Fix** | One of a closed list the hub words itself: `sign_in_again`, `use_another_account`, `wait_for_reset`, `ask_the_org_admin`, `reactivate_the_seat`, `check_the_source`, `sign_in_fully_here`. | Free text, a command, a link. |
| **Hint** | Optional text a source adds to a failure or a limit. Shown only as "the source says: ...", plain text, 120 characters, no links, never in a push. | A remedy. |
| **Seat state** | The pool's own `SeatState` (`packages/domain/src/pool.ts:53`): `logged-out`, `retired`, `out`, `low`, `ok`; no new member. With `backAt`, `since` and a `why`: `usage_limit`, `refused`, `signed_out`, `plan_ended`, `billing`, `by_hand`. A refusal or an ended plan is `retired` with that `why`, as the pool retires an unpaid plan (`pool.ts:186-187`). | A routing decision (U4). |

New invariants (U6 onward; U5 is labels):

| # | Invariant |
|---|---|
| U6 | **States.** A source is `available` while its last good read is within its stale line; `stale` when older (meters kept, dimmed, with "as of"), or while only a *transient* failure (`rate_limited`, `unreachable`, `timeout`) follows its last good read, up to 60 minutes; `unavailable` after a *permanent* failure (`signed_out`, `refused`, `no_scope`, `unknown_screen`, `plan_ended`, `no_usage_for_plan`), a transient one that lasts past 60 minutes, or silence beyond `max(4 x every, 30 min)` from a source that declared `every`. Its meters are then replaced by "can't read since T". `missing`: no source has ever read the window. A later good read clears it. **Unknown is never 0%**, and a window that resets while its source is stale shows unknown. |
| U7 | **Titles.** A window's title comes from its cadence: `reported` or `observed` length, else the reset distance. A source cannot set the title; a guessed cadence is shown as "about". `note` may add a qualifier ("shared with Grok") and is never a title. |
| U8 | **Plan change.** A changed plan name, account identity, window set or window length is a **plan change**. So is a used percentage that falls by 20 points or more while the window's reset time is **unchanged** (within a minute) and still ahead, on a window not declared rolling. A rolling window, or one whose reset moves, falls as old use ages out and is never a change. **A change is told only when a second reading, at a later `capturedAt`, agrees.** One notice per distinct change; the new fact becomes the baseline. The first fact ever seen is never a change. |
| U9 | **One seat state.** A limit hit, a refused sign-in or a sign-out, from whatever reports it (a lane's failure, the manager's, a collector, the pool), sets the same seat state for the account the hit resolves to (§4.5). One notice per seat-state change, never per reporter. A hit that cannot be resolved to an account is kept as `unknown` and changes no seat. |
| U10 | A seat state is shown and told, never routed on (U4 stands). A remedy shown to the principal is a Fix from the closed list; text from an agent token is a Hint and nothing more. |
| U11 | **Forgetting.** A source with no post for 14 days, whatever it declared (the status line included), or `unavailable` for 14 days, is forgotten with one last notice. The principal can forget a source or an account at any time. A later post starts it afresh (its first fact is not a change, U8). |
| U12 | **Thresholds.** A window crossing 75% or 90% (the levels Home already uses, `usage.ts:36-39`) on two consecutive readings is told once per account, window, reset time and level. It is cleared when the window resets or falls 5 points below the level. |
| U13 | **A limit ends on a fresh read of a new cycle, and only then.** A usage-limit mark records, when it is set, its `markedAt`, its `backAt`, and **the reset time of the limited window's cycle** (`cycleReset`) as the last reading before the hit gave it (null if none). It clears only on a read that (1) was **captured after both `markedAt` and `backAt`**, (2) carries a valid hub lease (U17), and (3) shows **a new cycle** of the limited window: its `resets_at` is later than `cycleReset` (when recorded) **and**, when the window's length is known, its cycle start (`resets_at` minus the length) is not before `markedAt`; and the window is below 100%. For Codex, `ordinaryUsageAllowed` not false and `rateLimitReachedType` unset replace (3). A read without a known cycle start or length cannot clear a Claude mark; a flag-based Codex read can. So a stale read cannot pass by being stamped late: with the limit at 10:00, the real reset at 13:00 and the default `backAt` at 11:00, a last-known read of 09:55 (80%, resets 13:00) stamped 11:05 fails (3): its reset is not later than 13:00 and its cycle began before 10:00. **Nothing clears a mark early,** and a percentage never marks a seat `out` by itself; an event or a flag does (F28). |
| U14 | **Bad values.** A percentage that is not 0 to 101 is not a reading of that window (it is dropped, never clamped); 100 to 101 is 100. |
| U15 | **Seat lifecycle.** Every seat state has an owner, and the owner comes from **who authenticated, never from a field in the post**. A state set through the pool route by a token holding the `usage-pool` scope (U17) is owned by the pool: it is cleared only by that pool's token posting a `cleared`, or by the principal, exactly as the pool's `retired` is cleared only by `activate` (`packages/domain/src/pool.ts`, `activateMember`). A state set by any other token (a lane's failure, a collector, a worker or manager token) is **derived**, whatever its body says (`by` is a display label). A derived `out` ends by U13; a derived `retired` with why `refused` or `plan_ended`, or `logged-out`, ends when a **fresh primary read carrying a valid hub lease (U17)**, captured after the state's `since`, shows the account usable (windows present, no refusal), or by the principal. Where both exist, the pool's state wins on Home and the derived one is shown only if it is worse. |
| U16 | **Reads are leased by the hub.** A node asks the hub for a lease before it runs a rationed read (§4.4). One lease per account and source at a time across all nodes; a shared minimum gap, cache and cooldown per account and source; a hub-wide cap on concurrent leases; a lease expires by itself. A polled source declares `every` of 60 s or more. |
| U17 | **Authority is bound to the token, and a clear to a lease.** Pool authority is a property of the token: the principal mints it (`morndo agent-token new <name> --role worker --scope usage-pool`; today a token has only a role, `apps/hub/src/main.ts:481`), and only such a token may post to `POST /api/agent/usage/pool` (set, `cleared`). A body that says `by: pool` on any other route or token changes nothing about ownership. A read ends a mark (U13) or clears a derived state (U15) only if it carries a valid, unexpired lease the hub granted for that account and source (U16), so a bare post claiming to be a headless read cannot. **Limit of this protection:** agent tokens are trusted to post readings (R3) and usage decides nothing (U4), so a token holding a lease could still post a false clear; the blast radius is a wrong display and one "back" notice that names the reporting node and token label, and the principal can re-mark. |

### 4.1 Gap 1: windows named from their own length

**Today.** F6: Codex names by minutes in an adapter. F15: Z.ai by hard-coded unit codes. F16: Cursor by a private rule. F32: our tests assume monthly. F3: a named row's label is the poster's word.

**Design.**
1. Move the Codex rule to the domain as `windowTitle(cadence, resetsAt, now)`: 300 minutes is "5-hour", 10080 is "weekly" (the status line's `five_hour` and `seven_day` and the headless `session` and `weekly_all` kinds carry those lengths by their documented names, F4, F26); other whole days "N-day"; 28 to 31 days "monthly"; other hours and minutes as in F6.
2. A window gains optional `lengthMins` on the wire. A source that knows the length sends it (Codex has it, F6; Z.ai's unit and number become minutes in its parser, F15 and §4.6).
3. Without a length, the hub keeps per window id the **furthest reset distance seen in the current cycle** and the **time between two consecutive resets** once one has passed (F14). Cadence is `observed` after one reset, `horizon` before it. This is F16's rule moved to where the memory is, with the Mac brief's thresholds: a reset more than 8 days out is monthly; within 8 days is weekly for a plan family the source says is weekly (Free, Plus, Premium, Super); a plan name that exists on both (Ultra) is decided by the gap between two observed resets, and until known the title is "plan period".
4. With neither, the card says "resets in 6 d 2 h" and no cadence word.
5. A collector's caption is never read as a title (F16). A pool shared with another product is a `note` ("shared with Grok"); prepaid credit is a line under the bars (the existing on-demand line, `usage.ts:68-81`), not a percentage.
6. The monthly assumption in our own tests (F32) is replaced by a fixture per period.

**Verified by.** AT-1 to AT-4, AT-37.

### 4.2 Gap 2: a plan change noticed and told once

**Design.** `observePlan(before, after)` is a pure domain function over plan facts (name, identity digest, window ids with lengths, per-window used percent and reset). It returns zero or more `PlanChange { kind: name | account | cadence | windows | drop, from, to }`.
- **name / account**: both known and different. Sources: Codex `planType` and the `account/updated` notification (F30), the Cursor screen header, the pool file's plan (F13). A changed account identity is told as "account changed" and the baseline restarts.
- **cadence / windows**: the set of window ids, or one window's length, differs.
- **drop**: U8's rule, with the rolling guard. `rolling` is declared by the source (the Z.ai credit windows that "refresh 5 hours after use" are the known case, ADR-0024 [S2]); a window that falls while its reset moves is remembered as rolling.
- **Confirmation (U8).** The first reading that differs is held; a second reading at a later `capturedAt` that agrees tells it. A single outlier (a timestamp in the percent field, a wrong account's numbers, F25 and #68772) never produces a notice.
- The hub records the notice signature (account, kind, to-value) in `usage_notices`, so a repeat after a restart tells nobody (the pattern of F10, in the hub).
- The notice names what changed in words: "seat-b: window changed from 'monthly' to 'weekly, shared with a second product'. Home now shows the weekly window."

**Verified by.** AT-5 to AT-8, AT-28.

### 4.3 Gap 3: four states, and "can't read since X"

**Design.**
1. **One typed route** for every source except the raw status line: `POST /api/agent/usage/readings` (agent token, account header) takes `{ source, node?, captured_at, every_s?, plan?, windows?, failure?: { reason, hint? } }`. A reader that meets an unknown screen posts a `failure` instead of nothing. The raw status-line route stays as it is; the hub's adapter turns each status-line report into a Reading with source `status-line`, `captured_at` the time of receipt, and window lengths from the documented keys.
2. `every_s` is **clamped to 60 s to 6 h** by the hub (a source can neither declare itself immortal nor ask to be polled every few seconds), so the silence line `max(4 x every, 30 min)` is at most 24 h.
3. The hub keeps health per (account, source, node): `lastOkAt`, `lastFailAt`, `reason`, `every`. It computes U6 on `view()`.
4. **Stale lines:** `max(15 min, 2 x every)` for a source that reads on a clock, and 15 minutes for one that declares nothing; **10 minutes for the status line**, the guard other monitors use. The status line is never `unavailable` by silence (an idle account is not a fault) but, like every source, is forgotten after 14 days (U11).
5. Home: `available` shows the meters; `stale` shows them dimmed with "as of 22:41"; `unavailable` replaces them with "can't read since 14:05 (sign in again)"; `missing` says "no reading yet". Other sources of the same account keep theirs. Where two sources read the same window (headless and status line), **the newer reading by capture time wins**, with one guard: a headless reading whose values are identical to the previous headless reading's while the status line has moved since is treated as last-known data (F28) and the status line shows. A difference of 15 points or more between two readings captured within 10 minutes is **shown, not resolved silently**: the card says "sources disagree" with both values in the details (another account's numbers can reach a status line when several accounts run on one machine: anthropics/claude-code#68772, closed as not planned, VERIFIED with `gh`). Neither reading is ever used to end a limit mark early (U13).
6. **Errors, classified, with the retry rule each implies:**

| What happened | Class | State | Retry |
|---|---|---|---|
| 401, 403, "login expired", signed out | `signed_out` | unavailable | none until `claude auth status` (local, no network) reports signed in again, or 6 h |
| org refused, `oauth_org_not_allowed` | `refused` | unavailable | none until sign-in changes |
| report is null, token lacks `user:profile` | `no_scope` | unavailable | none; Fix `sign_in_fully_here` |
| 429 | `rate_limited` | stale up to 60 min, then unavailable | `Retry-After` if given, else 300 s, doubling to 30 min |
| 5xx, timeout, process killed | `unreachable`, `timeout` | stale up to 60 min | back off as above; keep the last good reading with its age |
| screen or JSON not in a known shape | `unknown_screen` | unavailable | normal interval; hint carries a redacted head |
| plan has no usage (free tier) | `no_usage_for_plan` | unavailable | daily |

7. **Clearing a dead source (U11).** The principal can forget one source or a whole account from Home (`POST /api/usage/forget`, principal session only, never an agent token); the hub keeps no tombstone. Without this a removed collector would say "can't read since" for ever.

**Verified by.** AT-9 to AT-12, AT-23 to AT-27, AT-30, AT-33.

### 4.4 Gap 4: Claude usage, read the documented way

**Cause (hypotheses H1 and H5, §3.4).** Not shown to be the parser; only a classified failure will say which.

**Primary source: the headless report.** `claude -p /usage --output-format stream-json --verbose --no-session-persistence < /dev/null`, run by the unmodified CLI under the account's own config directory on the node that holds the login (https://code.claude.com/docs/en/authentication, "Log in with multiple accounts"). The message event that follows `system init` carries `usage_report` (F26, F27). Mapping: `session` is the 5-hour window (300 min), `weekly_all` the weekly window (10080 min), `weekly_scoped` a weekly window titled with its model scope ("weekly, <model name>"), `extra_usage` the on-demand line, `resets_at` ISO to ms, `severity` kept for details and never used as the level (the level is computed from the percentage as Home does today). The type is experimental (F26), so an answer outside the shape is `unknown_screen`, never a guess; a null `rate_limits` is `no_scope` or unavailable, **never 0%**.

**Rationing, by the hub across machines (U16).** A node-side lock and cache are not enough: the same account read from two machines is uncoordinated (round 3 review). So the hub grants the read:
- `POST /api/agent/usage/lease { account, source, node }` answers `granted` with a `lease_id` and an expiry, or `denied` with the reason and a `retry_after`, or `fresh` with the newest reading's capture time (the caller spawns nothing and uses it);
- **one lease per account and source at a time across all nodes**; a lease expires after the read's timeout plus 30 s (150 s), so a killed reader needs no cleanup: the lease simply lapses;
- the **minimum gap** between grants for an account and source is the cache window (4 minutes for `claude-usage`); a `fresh` answer inside it costs no spawn on any node;
- the **cooldown after a failure is shared**: a failure posted for the account and source (with `Retry-After` when the error gives one, else 300 s, doubling to 30 min) makes the hub deny leases until then, whichever node asks;
- a **hub-wide cap** of 2 concurrent leases, so a fleet of nodes cannot stampede a provider;
- a node also keeps its own lock file for its own processes, holding the owner's pid and start time; a lock whose pid is gone, or older than 150 s, is stale and taken over (AT-41), and a node-wide semaphore allows one headless read at a time (74.5 s on a loaded box, F27);
- timeout 120 s, the whole process group killed; stderr never read or logged; no OAuth token variable passed;
- failures follow the table of §4.3 item 6;
- the run uses `--setting-sources ""` as this repository's other CLI launches do (`apps/connections/src/cli.ts:82`, `apps/connections/src/adapters/caller-proof.ts:10`) so user hooks do not slow or alter it. Whether that flag affects `/usage` is **UNVERIFIED**; without it the read may take over a minute (F27).

**When it reads: on demand, never on a clock.** There is no fixed timer. A read is requested only when:
1. **someone is looking:** the principal opens Home or taps refresh, and the account's best reading is stale (older than 15 minutes) and its status line has been silent for 10 minutes. At most one lease per account per cache window answers any number of viewers;
2. **a limit mark's `backAt` has passed**, once, to confirm (U13), then at the cooldown rhythm until it succeeds;
3. **a transient failure** is retried by the shared cooldown, only while someone is looking or a mark awaits confirmation.

An account that nobody looks at and that no lane uses is not read at all: it goes `stale`, then is forgotten at 14 days (U11), which is the honest state. Threshold and plan-change notices therefore come from the status line and from reads someone asked for; they are not promised for an unwatched idle account. This is the lowest cadence that still answers "what is it now?" when it is asked, and it is the plan's answer to the terms question in §6.

**Last-known data (F28).** If the endpoint is rate limited, the interactive command can show bars up to 60 minutes old; the headless report has no marker. So a headless reading is stamped with the time *we* read it, it **never** ends a limit mark early (U13), it never outranks a newer status-line reading (§4.3 item 5), and the risk is stated (R9).

**Machines with pool tokens.** A lane that runs on a `setup-token` token has no `user:profile` scope, so its headless report is null (F26; the Mac session saw exactly this on one box). Two ways: sign each account in fully on that machine, or **read it on a machine that has the full login** (the PC's readings reach the hub, which keys them by account and node, and Home shows the account with its source and age). The hub never copies a token between machines.

**The pool script (outside this repository; a separate short brief).** Until the reader ships, `probe()` classifies what it sees (as the Cursor collector's parser does), keeps one redacted screen head per seat and class, backs off a failing seat (20 min, 1 h, 6 h, daily), checks `claude auth status`, and posts the class. When the reader ships, the tmux probe is retired. A Team seat is covered by the headless report.

**Verified by.** AT-31, AT-32, AT-35, and the appendix A audit re-run after the pool-script patch.

### 4.5 Gap 5: one seat state for a limit hit from any reporter

**Today.** Three paths that never meet: the failure hook marks the pool script's own files (F19); the hub receives `stop_failure` and does nothing with it (F12); the Codex pool marks its own domain (F11). The manager is moved by a different script than a lane, with a different note (F20), and **its failures do not become lane events at all** (F23).

**Design.**
1. `UsageService.noteLimit({ account, kind, backAt?, by, at, fix?, hint? })`, where `kind` is `usage_limit`, `refused`, `signed_out`, `billing`, `unknown`. One route, `POST /api/agent/usage/limit`, for collectors, the Codex pool and the hook, and one in-process call from the fleet. `by` is a label stored for the notice; it does not change the outcome. A `stop_failure` has no actor (F23), so `by` there is the lane's name.
2. **What counts as a limit hit** (events and flags, not percentages, U13): Claude: a rate-limit event with `status: "rejected"` (and its `resetsAt`, F29) or a turn error `rate_limit`; `credits_required` is a limit with the Fix `ask_the_org_admin` or `wait_for_reset`; `overloaded` (529) is capacity, never a quota mark. Codex: `UsageLimitExceeded`, `ordinaryUsageAllowed` false, or `rateLimitReachedType` set (F30); the Codex source says null means unavailable and clients must not infer recovery from percentages or reset times.
3. **The fleet tap.** The fleet's lane-event intake gets a limit tap that reads `/hook/failure` events **before** the manager and ignore filters (`lane-events.ts:62`), the way it already gives a Run the manager's turn end (`lane-events.ts:150-152`). It stores nothing new in the lane events; it calls `noteLimit`. A failure whose `error` is not a known limit kind is ignored.
4. **Resolving the account (the first-turn case), for every way of naming an account.** A first-turn failure has no status-line session yet and may have no header, and `oauth_org_not_allowed` is exactly that failure. The documented name is `MORNDO_ACCOUNT` in the lane's environment (F34); the config-directory name is a pool-script convention. The order, tested in both styles (AT-19 to AT-20b):
   1. the `account` field of the failure hook's own body: the documented hook sends **`$MORNDO_ACCOUNT`**; a pool-style operator's hook may send the config directory's name instead, which is the operator's convention and is documented as such. A hook with neither sends no field;
   2. the **lane record**: `lane_accounts (node, lane, account, at)`, written (a) when the hub issues `lane.start` with an `account` (F24) and (b) by every status-line report, whose header carries `MORNDO_ACCOUNT` (`usage.ts:11`, `:122-124`). **On a node whose launcher has no `{account}`** (F24: such a start carries no account) writer (a) is empty by design; the lane's account is then whatever its environment says, so step 1 and writer (b) cover it;
   3. else the account whose fresh sessions (10 minutes, `usage.ts:34`) include the failing session;
   4. else the node's **only account**: if every fresh session and lane record on that node names one account, that is the answer (a single-account node, the common case for someone who has not set `MORNDO_ACCOUNT` at all: their reports and failures both land on `default`, `usage.ts:32`); with two or more, or none, `unknown`;
   5. else `unknown`: kept, no seat change (U9).
   A lane started by hand, or moved to another account by a pool script, has no record or a stale one until its next report; step 1 covers it where the hook sends the field (R7).
5. Seat state precedence is the pool's (`packages/domain/src/pool.ts:263-283`): `logged-out`, then `retired`, then `out`, then `low`, then `ok`. `out` ends at `backAt` (the failure's reset if it names one, else 60 minutes, never more than 168 hours: the pool's marks, F8) and then only on a fresh read taken after it (U13). `low` comes from readings at 90% and above.
6. **Lifecycle and authority (U15, U17).** A seat state set by a `usage-pool` token is sticky until that pool's token or the principal clears it, as the pool's own `retired` is; any other token's post is derived, whatever its body says, and clears on a lease-carrying fresh primary read after its `since`. Home shows which, and who. A seat-state change produces exactly one notice: account, state and `why`, back-at, who hit it, and the Fix chosen by the hub from the state and `why` (`retired`/`refused` gives `use_another_account` or `ask_the_org_admin`, `logged-out` gives `sign_in_again`, `out` gives `wait_for_reset`). The hub never shows a command or a sentence an agent token wrote as a remedy. A source's `hint` appears only as "the source says: ..." (U10); shared per-node worker tokens can post it, so it is untrusted.
7. The Codex pool and a Claude pool script post their seat states to `POST /api/agent/usage/pool`, which only a token with the `usage-pool` scope may call (U17); lanes, collectors and the manager use the limit route and their states are derived. The Codex collector lists seats with `morndo-keys pool list --json`.
8. Notices (plan change U8, seat state U9, threshold U12, forgetting U11) go to Home's notice area and, as a count-only push, through the existing notification service (`apps/hub/src/application/notification-service.ts:30`, `apps/hub/src/main.ts:290-296`). A new `NotificationKind` for usage is a domain addition in slice 2.

**Verified by.** AT-15 to AT-22, AT-29, AT-34.

### 4.6 The other sources

**Codex (upgrade of F6, F7).** (a) Compare the account identity digest and `planType` on every read; a change is a plan fact change (U8). (b) Keep reading `rateLimitsByLimitId` (already read, F6) and show each bucket under its limit's name. (c) A long-lived app server's `account/rateLimits/updated` notification is merged as a reading (source `app-server`), so a busy seat is read without polling. (d) Poll adaptively **and slowly, under the same rationing as Claude (U16)**: the source declares `every_s` per post, 15 minutes while idle, 5 minutes from 75%, 2 minutes from 90%, 60 seconds from 99%, never below the 60-second clamp. The Codex TUI polls faster (60 s, 30 s at 75%, 15 s at 90%, 5 s at 99%: F30, UNVERIFIED here) because it is one foreground client of a server it owns; Morndo polls a remote endpoint on behalf of a fleet, so it does not copy that. Faster updates come from the pushed `account/rateLimits/updated` notifications of (c), which cost no request. Each read takes a hub lease; a long-lived app server's pushes need none. (e) A hung app-server child is killed (the shared client already stops the process group, `usage-codex.ts:8-9`).

**Cursor (stays on the CLI's own screen).** The reader stays an operator collector outside the repository (Cursor's terms, §6); this plan adds its **contract**: it posts a Reading with `lengthMins` when it knows it, `note` "shared with Grok" for the shared pool, prepaid credit as a line, and a `failure` with a redacted head when the screen is unknown. The period rule of §4.1 item 3 is the hub's. A parser of already-captured text (no process driving) may live in the repository with its fixtures; driving the CLI stays outside.

**Z.ai.** Parse by `unit` and `number` only (3 is hours, 6 is weeks), never by order or by reset sort (windows swap near the end of a week); accept `CREDIT_LIMIT` where `TOKENS_LIMIT` was; a missing weekly entry is `missing`, not a failure; an HTTP 200 whose body carries `code: 401` is `signed_out`; an unknown `unit` sends `lengthMins: null`. The Z.ai credit windows are `rolling`.

---

## 5. The smallest v1 in slices, and its acceptance tests

Seven pull requests, in order. Each is green on its own and leaves Home working. S1, S2, S4, S5 are Option 2.

| Slice | Contents | Done when |
|---|---|---|
| **S1 domain and protocol** | `Reading`, U6 to U14, `windowTitle` and cadence, `observePlan` with the rolling rule and confirmation, thresholds, seat-state precedence on `SeatState`, Fix and Hint, reason classes; wire: the readings body, `length_mins`, `rolling`, `note`, limit body. | AT-1 to AT-7, AT-13, AT-27, AT-28, AT-29, AT-33, AT-34 (domain side) |
| **S2 hub storage and routes** | One migration: health, notices, cadence observations, `lane_accounts`. The readings, limit and forget routes, the status-line adapter with its guards, the silence sweep and forgetting, notices. | AT-8 to AT-11, AT-16, AT-18, AT-23 to AT-26, AT-30 |
| **S3 fleet tap and account resolution** | The `/hook/failure` tap before the manager filter; `lane_accounts` at `lane.start` and from reports; the documented failure hook sends `$MORNDO_ACCOUNT`; the resolution order including the single-account node; the seat lifecycle owners; the `usage-pool` token scope and the pool route (the principal's `agent-token new --scope`). | AT-15, AT-17, AT-19 to AT-21, AT-43, AT-44 |
| **S4 Home** | The four states, "can't read since X", titles from cadence, seat state, back-at and Fix on the card, "forget this source", notices, the e2e. | AT-12 and the manual QA |
| **S5 Claude headless reader** | The adapter in `apps/connections` (parse, mapping), the hub lease route and its cap, cache and shared cooldown, the node-side lock with stale takeover, on-demand triggers (Home viewers, `backAt`), the node collector that posts readings, docs for full logins and for reading on another machine. | AT-31, AT-32, AT-35, AT-40, AT-41, AT-45 |
| **S6 Codex upgrade** | Identity and plan comparison, bucket display, `account/rateLimits/updated` merge, slow adaptive `every` under the lease. | AT-36, AT-42 |
| **S7 Z.ai, Cursor, fixtures, docs** | Z.ai parser by unit and number; the Cursor contract and period rule fixtures; the fixture matrix test; `docs/agents/usage.md` gains the readings contract, reason classes and Fix names. | AT-14, AT-37, AT-38, AT-39 |

**Not in v1:** the lanes waiting on a seat, a usage history, any routing on usage, a Claude runtime in the pool, a Cursor process driver in the repository.

Acceptance tests. A fake clock is passed as `now` everywhere (F14). Fixtures live in `test/fixtures/usage/<source>/<case>` with made-up values.

| ID | File and name | Asserts |
|---|---|---|
| AT-1 | `packages/domain/test/usage-title.test.ts` "names a window from its reported length" | 300 min is "5-hour"; 10080 is "weekly"; 4320 is "3-day"; 43200 is "monthly"; 90 is "90-minute window". |
| AT-2 | same, "never names from a caption" | `lengthMins` 10080 with a poster label "monthly" is titled "weekly". |
| AT-3 | same, "observes a cycle" | Two reports across a reset 7 days apart: cadence `observed`, title "weekly" with no "about". |
| AT-4 | same, "horizon only says about" | Reset 6 d 20 h ahead on a weekly-family plan: "about weekly"; 25 d ahead: "about monthly"; an Ultra-named plan with one reset seen: "plan period"; no length, no history: "resets in ...". |
| AT-5 | `packages/domain/test/usage-plan.test.ts` "a changed plan name is one change" | Two agreeing readings with "Plan Y" after "Plan X": one `name` change; before null: none. |
| AT-6 | same, "a changed window set, length or account is a change" | A second window appearing, 43200 becoming 10080, a new identity digest: each one change. |
| AT-7 | same, "a drop needs the reset unchanged, and a rolling window never drops" | Fixed window, 80% to 20%, reset 3 d ahead and unchanged: `drop`. 80% to 5% with the reset moved forward a cycle: none. A fall of 19 points: none. **Rolling cases that can fail:** declared `rolling`, 80% to 45%, reset constant: none; not declared, 80% to 45% with the reset moving 40 minutes later: none, and the window is remembered as rolling. |
| AT-8 | `apps/hub/test/usage-notices.test.ts` "tells a change once, across a restart" | The same change posted twice, and again after the service is rebuilt on the same store: one notice. A different change: a second. |
| AT-9 | `apps/hub/test/usage-health.test.ts` "a posted permanent failure replaces the meters" | After `failure {reason: unknown_screen}`: that source `unavailable since T`, no windows from it; other sources keep theirs. |
| AT-10 | same, "a source that declared every goes silent" | `every` 900 s, no post for `max(4 x every, 30 min)`: `unavailable`; a post clears it. |
| AT-11 | same, "the status line is stale after 10 minutes and never unavailable by silence" | 9 min: `available`; 11 min: `stale` with meters; 6 h: `stale`; windows dropped at their reset (U2). |
| AT-12 | `e2e/home.e2e.ts` "shows the four states and a title from the cadence" (existing file) | A missing account says "no reading yet"; a stale one "as of"; an unavailable one "can't read since"; a 7-day window labelled "monthly" with `length_mins` 10080 says "weekly". Screenshot kept. |
| AT-13 | `packages/domain/test/usage-reason.test.ts` "reason classes are closed" | An unknown reason maps to `unknown_screen`; a hint with an `@` or a link is cut; 120-character limit. Fixtures synthetic and labelled so. |
| AT-14 | `apps/connections/test/usage-codex.test.ts` (existing) "sends length_mins" | Reading windows carry the duration; an unknown duration sends `null`, not a failure. |
| AT-15 | `apps/hub/test/usage-seats.test.ts` "a lane's failure and a manager's limit post set the same seat state" | A `rate_limit` `stop_failure` for lane `w1` (resolved to `seat-a`) and, in a second run, `POST /usage/limit` under a manager token for `seat-a` with the same reset: the same `out` state and `backAt`, one notice each run. |
| AT-16 | same, "two reporters, one change, one notice" | A lane's failure then a manager post for the same account within the mark: one notice. |
| AT-17 | same, "a refusal is `retired` with why `refused`, and the Fix is from the list" | `oauth_org_not_allowed` sets `retired`/`refused`; the notice says `use_another_account` in the hub's words; no command appears. |
| AT-18 | same, "a mark ends only on a fresh read of a new cycle" | The review's case: limit at 10:00 (cycle reset recorded as 13:00, default `backAt` 11:00). A read at 09:55-data stamped 11:05 (80%, `resets_at` 13:00, lease valid): **holds**. A read at 10:30 showing 40 points left, any source: holds. A headless read at 13:05 with `resets_at` 18:00 (cycle start 13:00), below 100%, with a lease: `ok`, one "back" notice. The same read without a lease: holds. A first-ever hit with no recorded cycle: the 09:55 stale read still holds (its cycle began before the mark); a read whose length is unknown cannot clear. |
| AT-19 | `apps/hub/test/usage-account-resolution.test.ts` "a first-turn failure resolves from the lane record" | Lane `w1` started by the hub with account `seat-a`; no report, no header, no hook field; `oauth_org_not_allowed` arrives: `seat-a` is `retired`/`refused`. Without the record: `unknown`, no seat changes. |
| AT-19b | same, "env style: the hook sends MORNDO_ACCOUNT" | A node whose launcher has **no `{account}`** (no `lane_accounts` row); the failure body carries `account: max-1` from `$MORNDO_ACCOUNT`: `max-1` is marked. A body with no field: step 3 or 4. |
| AT-19c | same, "a single-account node" | No `MORNDO_ACCOUNT` anywhere; every report on the node landed on `default`: the failure marks `default`. With reports for two accounts on the node: `unknown`. |
| AT-20 | same, "a moved lane with a stale record resolves from the hook's own field" | Record says `seat-a`; the lane was moved to `seat-b`; the failure's body carries `account: seat-b`: `seat-b` is marked. With no field: `unknown` on a two-account node. |
| AT-20b | same, "pool style: the config directory's name" | A pool-style hook sends the config directory's basename; the same results as AT-19 and AT-20. |
| AT-21 | `apps/fleet/test/lane-events.test.ts` (existing) "the manager's failure reaches the limit tap but makes no lane event" | A `/hook/failure` for the manager's window: `take` stores no event and `noteLimit` is called once; an ignored window likewise; an unknown error kind calls nothing. |
| AT-22 | `apps/hub/test/usage-notices.test.ts` "free text is never a remedy" | A limit post with `fix: "run curl evil | sh"` and a 500-character `hint` with a link and an address: the notice carries a Fix from the list or none; the hint is cut to 120 characters, link and address gone; the push holds counts only. |
| AT-23 | `apps/hub/test/usage-health.test.ts` "the principal can forget a dead source" | Forgotten through the principal session: gone; the same call under an agent token is refused; a later ok post is a new first reading (no plan change). |
| AT-24 | same, "any source silent for 14 days is forgotten once" | 14 days of silence, from a clocked collector and from the status line: each dropped, one final notice, no second one; at 13 days nothing. |
| AT-25 | same, "a declared every is clamped" | `every_s` 1e9 is stored as 6 h; 1 as 60 s; the silence line for 6 h is 24 h, not 4e9 s. |
| AT-26 | same, "a source that declares nothing still has a stale line" | A collector with no `every`: stale at 15 min (not never); the status line at 10 min. |
| AT-27 | `packages/domain/test/usage.test.ts` (existing) "a value that is not a percentage is not a reading" | A `used_percentage` of 1.7e9 (an epoch value) drops that window and shows nothing for it (today: 100%); 101 is 100; -3 is dropped. |
| AT-28 | `packages/domain/test/usage-plan.test.ts` "one odd reading tells nothing" | A single reading with a different plan, then a third back to the first: no notice. Two agreeing: one. |
| AT-29 | same, "a threshold is told once per crossing and cleared on recovery" | 74, 76, 77: no notice at one reading, one at the second; 80, 91, 92: one more at 90; a reset and a new crossing: told again; falling 5 points below clears. |
| AT-30 | `apps/hub/test/usage-health.test.ts` "the newer reading wins, and a disagreement is shown" | Headless 40% captured 10:00, status line 70% captured 10:03: 70% shows, "sources disagree" with both values; headless 40% captured 10:10 identical to 10:00's while the status line moved: treated as last-known, 70% still shows; a headless reading that differs and is newer shows. Neither reading ends a mark (AT-18). |
| AT-31 | `apps/connections/test/usage-claude.test.ts` "maps the headless report" | A made-up report with kinds `session`, `weekly_all`, `weekly_scoped` (model scope), `extra_usage`: windows of 300 and 10080 minutes, a scoped weekly titled with the model, an on-demand line; `rate_limits: null` is `no_scope`, never 0%; `percent` out of range is dropped; a changed shape is `unknown_screen`. |
| AT-32 | same, "rations the reads on one node" | A fake spawner: two requests inside 4 minutes spawn once; two accounts never run at once on a node; a failure sets the cooldown (300 s, doubling); `signed_out` is not retried until `claude auth status` changes; the process group is killed at 120 s; a status-line report within 10 minutes prevents a read. |
| AT-33 | `packages/domain/test/usage-health.test.ts` "transient failures stay stale for an hour" | `rate_limited` after a good read: `stale` with meters at 30 min, `unavailable` at 61; `signed_out`: `unavailable` at once. |
| AT-34 | `packages/domain/test/usage-seat.test.ts` "no early clear, from any source" | A status-line read and a headless read before `backAt`, each with 90 points left: the mark holds (both). A read captured before `markedAt` but stamped after `backAt`: holds. A fresh read after `backAt` with the same `resets_at` as the recorded cycle: holds; with a later `resets_at` and a cycle start at or after `markedAt`: cleared. A Codex read with `ordinaryUsageAllowed` true and a lease: cleared; the same with the flag false: holds. |
| AT-35 | `apps/connections/test/usage-claude.test.ts` "a machine with only a pool token says so" | A fake CLI whose report is null: reason `no_scope`, Fix `sign_in_fully_here`; a reading of the same account from another node still shows. |
| AT-36 | `apps/connections/test/usage-codex.test.ts` (existing) "plan, identity and pushed updates" | A changed `planType` or identity between reads is a plan fact change; a pushed `account/rateLimits/updated` becomes a reading with no lease; `rateLimitReachedType` set marks a limit hit; the declared `every` shortens at 75, 90 and 99% and **never below 60 s**. |
| AT-37 | `apps/hub/test/usage.test.ts` (existing, `:83`, `:104`) "a period per fixture" | The "included usage, monthly" expectation is replaced by three fixtures: a weekly pool shared with Grok (reset within 8 days), a legacy monthly plan, an Ultra with two observed resets. |
| AT-38 | `apps/connections/test/usage-fixtures.test.ts` "every source has its edge fixtures" | For each source with a parser, a fixture exists for: a null window, a timestamp in the percent field, an expired window, a 429 with and without `Retry-After`, a token without `user:profile`, and the source's own unknown shape; the test fails when one is missing. |
| AT-39 | `apps/connections/test/usage-zai.test.ts` "maps by unit and number" | Windows in swapped order, `CREDIT_LIMIT` without `TOKENS_LIMIT`, a missing weekly entry, an unknown unit (`lengthMins` null), HTTP 200 with `code: 401` (`signed_out`). |
| AT-40 | `apps/hub/test/usage-lease.test.ts` "one lease per account across nodes" | Node A holds a lease for `seat-a`; node B asks: `denied` with `retry_after`. Node A's reading lands; node B asks inside 4 minutes: `fresh`, no spawn. A failure posted by A with `Retry-After` 120: B is denied until then. Two accounts at once are granted; a third concurrent lease is denied by the hub-wide cap of 2. |
| AT-41 | same, "a killed reader's lease and lock lapse" | A lease granted to node A, never completed: after 150 s node B is granted. A node lock file whose pid is gone, or older than 150 s, is taken over; a live fresh one is not. |
| AT-42 | `apps/connections/test/usage-codex.test.ts` (existing) "Codex is rationed like Claude" | Two Codex reads of one seat inside the minimum gap take one lease; the adaptive `every` ladder is 15 min, 5 min, 2 min, 60 s; no read runs without a lease; a pushed notification needs none. |
| AT-43 | `apps/hub/test/usage-seats.test.ts` "a pool-set state is sticky, a derived one clears, and authority is the token's" | A `usage-pool` token sets `retired`/`refused`; a good fresh read does not clear it; that token's `cleared` does; the principal's activation does. **Spoof cases that can fail:** a worker token (and a manager token) posting `by: "pool"` with `kind: "cleared"` to the limit route or the readings route changes nothing; the same posted to the pool route without the scope is refused (403); a worker token posting a retired state with `by: "pool"` creates a **derived** state that clears on a lease-carrying fresh read. **Derived refusal:** a derived `retired`/`refused` is not cleared by a primary-labelled read without a lease, nor by one captured before `since`; with a lease and captured after, it clears and the notice names the node and token label. |
| AT-44 | same, "the pool's state wins on Home" | A pool-set `retired` and a derived `ok`: Home shows `retired`; a derived `out` over a pool `ok` shows `out`. |
| AT-45 | `apps/hub/test/usage-ondemand.test.ts` "no read without a viewer or a mark" | With no Home viewer and no mark: no lease is requested for an hour of fake time. A viewer opens Home with a stale account and a silent status line: one lease. Ten viewers inside the cache window: one lease. A viewer for an account whose status line reported 5 minutes ago: none. After `backAt`: one confirming lease with no viewer. |

**Negative controls** (a test that cannot fail proves nothing): `scripts/negative-controls.ts` runs HEAD, so each slice commits first. A control per behaviour, each making a named test red:
- the sweep returns `available` always (AT-10, AT-11); the title function reads the poster's label (AT-2); the notice signature ignores the account (AT-16);
- the drop rule without the reset-unchanged test (the rolling cases of AT-7); a notice on the first differing reading (AT-28);
- account resolution without the lane record (AT-19); **resolution that prefers the lane record over the hook field (AT-20)**; the tap placed after the manager filter (AT-21); the Fix taken from the post (AT-22);
- **forget allowed under an agent token, or leaving a tombstone so the next post is not a first reading (AT-23)**;
- **forgetting only clocked collectors, or at 13 days, or twice (AT-24)**; **no clamp on `every_s` (AT-25)**; no default stale line (AT-26);
- the percent clamped instead of dropped (AT-27); a threshold notice per reading (AT-29); the cache bypassed or two accounts run at once on a node (AT-32); a transient failure treated as permanent (AT-33); **any read, or a headless one, allowed to clear a mark before `backAt` or on an unchanged `resets_at` (AT-18, AT-34)**; a null report read as 0% (AT-31);
- **the headless value preferred over a newer status line (AT-30)**; **a lease per node instead of per account, a lease that never expires, a cooldown kept per node, or no hub-wide cap (AT-40, AT-41)**; **a stale lock file honoured (AT-41)**; **Codex polled without a lease, or below 60 s (AT-36, AT-42)**; **resolution that reads only the config-directory name, or has no single-account step (AT-19b, AT-19c, AT-20b)**; **a pool-set state cleared by a read, or a derived one that never clears (AT-43)**; **ownership taken from the body's `by`, or the pool route open to any token (AT-43)**; **a clear that ignores the lease or the capture time, or compares only to `backAt` (AT-18, AT-34, AT-43)**; **a read on a timer with nobody looking (AT-45)**.

**Manual QA before "done"** (recorded in `qa/<date>.md` with screenshots): install from scratch with the quick start; post a status-line report, then a reading, then a failure, with `curl` as in `docs/agents/usage.md`; stop a collector's timer and watch a source go available, stale, unavailable; run the headless reader against a real login and against a pool token; post a plan change twice; post a limit from a lane token and a manager token; start a lane with an account and make its first turn fail with a refusal; confirm one notice each.

---

## 6. Terms check (read 2026-10-23)

| Provider | What the terms say | What v1 does |
|---|---|---|
| Claude Code | "Developers ... may not collect, store, or intermediate Claude.ai credentials or session tokens"; OAuth is "intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans". It "does not prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". https://code.claude.com/docs/en/legal-and-compliance | Runs the unmodified CLI's own documented `/usage` under the user's own login and config directory; reads the status line's JSON, `claude auth status` and the stream-json events; **never** a credentials file, a token, or the undocumented OAuth usage endpoint with a harvested token (undocumented, aggressively rate limited: anthropics/claude-code#31637 per the Mac brief; and it would mean handling tokens the legal page forbids). Nothing is routed through the user's plan on others' behalf. The pool script reads non-secret fields of the credentials file for plan names (F21); **that is not carried into this repository**. A documented way to read a Claude plan name is not found (**UNVERIFIED**): v1 shows no Claude plan name beyond the pool file's label parts (F13). |
| Anthropic Consumer Terms (Free, Pro, Max) | Section 3, item 7: "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise." Effective Oct 8, 2025; read 2026-10-23. https://www.anthropic.com/legal/consumer-terms. Section 2: no sharing of account login or credentials, or making the Account available to anyone else. | The CLI's `/usage` is a documented command, `-p` print mode and the `SDKUsageReport` type are documented, and the status line is documented as a place to run scripts that read `rate_limits`; the plan found **no sentence that explicitly permits polling `/usage`**. So the plan (a) uses the user's own unmodified CLI under their own login, on their own machine, never a key or token handed to Morndo (Section 2 is not touched: nothing is shared); (b) reads **on demand and after a limit's reset, not on a timer** (§4.4), so an account nobody looks at is never read; (c) leases reads across machines so the same account is read at most once per 4 minutes; (d) treats the status line, which Claude Code itself runs and passes the figures to, as the primary source that needs no judgement. |
| Anthropic Commercial Terms (Team, Enterprise, API) | Effective Jun 17, 2025: no clause on automated access or scraping in the text read; D.2 ties use to a Usage Policy that was **not read** here; D.4 restricts building competing products and reverse engineering. https://www.anthropic.com/legal/commercial-terms | Same behaviour as above. For a Team seat the Usage Policy is an open item (OQ3). |
| Cursor | Section 1.5 (updated 2026-09-03): no "reverse engineer ... or otherwise attempt to derive or gain access to the source code", no "probe, scan or attempt to penetrate the Service", no "harvest, scrape, or extract data from the Service". https://cursor.com/terms-of-service | Reads only what the official CLI's `/usage` command prints, in an operator collector outside the repository. Never the web dashboard, the CLI's bundle, or an internal endpoint (the dashboard call CodexBar reads is exactly that, F31). Whether driving the CLI's screen is "extraction" is a judgment the owner already made (2026-10-11, ADR-0024 [S11]); this plan adds nothing to it. |
| Z.ai | No automated means "for the purpose of accessing, obtaining, or monitoring any unauthorized data". https://docs.z.ai/legal-agreement/terms-of-use (quoted from ADR-0024 [S10], read 2026-10-11; not re-read today) | Unchanged: the quota call Z.ai's own plugin makes; an unknown shape posts a failure, not a guess. |
| Codex | Settled in ADR-0028 and the plan of 2026-10-15; the stdio app server is the documented route; WebSocket is experimental (https://learn.chatgpt.com/docs/app-server, read 2026-10-23). | Unchanged transport (stdio); the new reads use documented methods and notifications (F30). |

**What remains a judgement call for the owner.** (1) Whether running the unmodified CLI's own `/usage` in print mode, on demand and at most once per account per 4 minutes, is "access ... through automated or non-human means" under Consumer Terms Section 3 item 7, or is permitted because Anthropic documents the command, the print mode and the report type. The plan cannot settle this from the text; it lowers the exposure as far as it still works. (2) The fallback needs no such judgement: read the status line only, accept that an idle account is `stale`, and give up the Team-seat reading and the early view of a refused seat. (3) Whether to ask Anthropic (the legal page invites questions about permitted authentication methods: contact sales) before shipping the headless reader to other users. Recommended default: ship Option 1 with on-demand reads, keep the status-line-only mode as a setting, and ask.

Also never: a local transcript estimate (ccusage-style) as a limit, because it misses other devices and the web app (https://code.claude.com/docs/en/costs, "computed from local session history on this machine, so usage from other devices or claude.ai is not included", read 2026-10-23).

The tmux `/usage` probe (F17) types into a hidden terminal and reads its screen. ADR-0024's draft lists reading a terminal's screen under *Never* for a usage adapter in this repository. The headless reader replaces it for Claude with a structured source; the Cursor screen reader stays outside the repository (§4.6).

---

## 7. Risks and open questions

| # | Risk or question | Default |
|---|---|---|
| R1 | A `horizon` guess is wrong at a cycle boundary (a monthly plan seen in its last week). | The title says "about" until `observed` (U7), and the first reset corrects it. |
| R2 | A provider-side reset looks like a plan change (the `drop` rule). | Accepted, and a second reading must agree (U8): the notice says "used fell from 80% to 20% with the reset still 3 days away". |
| R3 | A collector can post a false failure or reading. | A reading is as trusted as a report (U1: an agent token); a wrong value is bounded by U14 and U8's confirmation. |
| R4 | Two sources or nodes read one account and differ. | Health is per (account, source, node); the newer available wins and a 15-point disagreement is shown in the details (§4.3 item 5). |
| R5 | The Cursor collector is being changed by T-412 now. | S7 consumes its output; it does not touch it. Hand T-412 §4.1 and §4.6. |
| R6 | ADR-0024's draft (not on main) proposes `U5` to `U8` for provider readings. | They collide with U5 (labels). ADR-0036 supersedes the numbering; its other content (standing, amounts) is still wanted later. |
| R7 | A lane moved by a pool script, with a hook that sends no account, leaves the lane record stale. | The first failure after a move is `unknown` until the next report. The documented hook sends the account. |
| R8 | The 14-day forgetting hides a broken seat. | The last notice says so and stays in the notice history. |
| R9 | A headless read during an endpoint rate limit may be last-known data up to 60 minutes old, with no marker (F28). | It never ends a limit mark early (U13), never outranks a newer status line (§4.3 item 5), and an unchanged repeat is treated as last-known. Settle with one deliberate rate-limited run. |
| R10 | The `usage_report` type is experimental (F26) and may change. | An answer outside the shape is `unknown_screen`; the fixture matrix (AT-38) fails when a parser lacks its edge fixtures; pin the CLI version in the QA record. |
| R11 | The headless run takes over a minute on a loaded box (F27). | Node-wide single reader, 120 s timeout, cache; a hook-free run via `--setting-sources ""` if it works (UNVERIFIED). |
| R12 | A machine with only pool tokens gets no reading of its own. | `no_scope` with the Fix `sign_in_fully_here`, or the reading from a machine with the full login. Option 1's cost assumes the latter. |
| R13 | The headless reader is automated access to a subscription service (§6). | On demand only, leased across machines; a status-line-only setting; the owner's decision. |
| R14 | On-demand reads leave an unwatched idle account stale, so a plan change on it goes unnoticed until someone looks. | Accepted and stated (§4.4): stale is the honest state. |
| OQ1 | Is there a documented, non-credential way to read a Claude account's plan name? | None found. v1 does without. |
| OQ3 | Anthropic's Usage Policy (referenced by Commercial Terms D.2) on automated access was not read. | Read it before Team seats are read by the headless reader. |
| OQ2 | The screen text of each failing class of the old probe. | Superseded for Claude by the headless classes; kept for the pool-script brief; needs the owner's OK to run a probe on a retired seat. |

---

## Appendix A. Repeating the 78% audit

Input: the pool's `guard.log`, lines of the form `2026-10-17T22:19:53 probe seat-a: no usage on screen` (or `probe seat-a: 5h 3% week 41%`, or `probe seat-a: claude did not come up`).

```sh
python3 -I - <<'PY'
import re, collections
rows = []
for line in open("guard.log"):
    m = re.match(r"(\S+) probe (\S+): (.*)", line)
    if m: rows.append(m.groups())
kind = lambda t: "none" if "no usage" in t else "down" if "did not come" in t else "ok" if t.startswith("5h") else "other"
window = [r for r in rows if "2026-10-15T21" <= r[0] < "2026-10-20T00"]
print(len(window), collections.Counter(kind(r[2]) for r in window))
by = collections.defaultdict(collections.Counter)
for t, a, x in window: by[a][kind(x)] += 1
for a in sorted(by): print(a, dict(by[a]))
PY
```

Result on 2026-10-23: 674 probes, 524 none, 149 ok, 1 down; three seats account for all 524. Streaks and the gap to the marking event came from the same file (`flag NAME: ERROR` and `notify:` lines).

## Appendix B. The headless report on this box (shape only, 2026-10-23)

Command: `claude -p /usage --output-format stream-json --verbose --no-session-persistence < /dev/null`, Claude Code 2.1.309, a full login. Seven lines of output: hook events, `system init`, one message event carrying `usage_report`, one `result`. The result had `num_turns` 0, cost $0, `duration_api_ms` 0, `duration_ms` 74518. The report's shape (types only; the values belong to the account and are not kept):

```text
usage_report.session        { total_cost_usd, total_api_duration_ms, total_duration_ms, total_lines_added, total_lines_removed, model_usage{} }
usage_report.rate_limits    { limits: [ { kind, group, percent:int, resets_at:ISO string, scope:null|{model,surface}, severity, is_active:bool } ],
                              extra_usage: { is_enabled:bool, monthly_limit, used_credits, utilization, currency } }
limits seen                 session/session, weekly_all/weekly (is_active true), weekly_scoped/weekly (scope present)
```

This agrees with the documented type (F26). The run's output file was deleted after the shape was read.
