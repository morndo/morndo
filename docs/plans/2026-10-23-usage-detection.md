# Usage detection that catches limits for every user: plan

**Phase: plan only.** No code, no pull request. Board T-414, 2026-10-23. Builds on [ADR-0016](../adr/0016-home-usage-across-accounts.md) (Usage, U1 to U5), [ADR-0029](../adr/0029-account-pool.md) (the pool's seats) and [ADR-0034](../adr/0034-account-labels.md) (labels). A short ADR draft is [ADR-0036](../adr/0036-usage-reading-health.md).

Facts carry a citation. `path:line` is this repository at `4a0274cf` (main, 2026-10-23). `pool-script:N` is the pool script a user may run beside Morndo (`claude-pool`, outside this repository, lines read 2026-10-23); `cursor-collector` and `zai-collector` are the two usage collectors that post to Home from outside the repository. The Cursor collector was being edited the same day, so it is cited by function. **INFERENCE** marks a conclusion drawn from evidence; **UNVERIFIED** marks what no source or run settled. Account names below are made up (`seat-a`, `seat-b`, `seat-c`).

---

## 0. Owner summary

**The problem in one paragraph.** Home shows numbers it was once told and cannot say when they stopped being true. A usage reader that fails (a screen it does not know, a plan that ended, a sign-in that was refused) posts nothing, so Home keeps the last figures with no sign of age (`packages/domain/src/usage.ts:44`, `:148-154`; `apps/web/src/lib/desktop/HomeView.svelte:79`). Window names are chosen by whoever wrote the reader, so a plan that changes cadence is mislabelled until a person notices. A limit hit is handled by three separate code paths that never meet. None of this is special to one machine: any user who connects an account that changes plan, loses its sign-in or hits a limit meets the same silence.

**Why the Claude probe read "no usage on screen" in 78% of probes (524 of 674, 10-15 21:00 to 10-20 00:00).** It is not a screen-format problem. 524 = 186 + 199 + 139 failures from **three seats** that had stopped being usable (two later refused by their organization, one lapsed). The three other seats probed in those hours read cleanly (128 reads, 0 failures; same binary, same parser). The probe writes the same line for every cause (`pool-script:872-874`), and it retries a logged-in seat with no live lane every 20 minutes for as long as that lasts (`pool-script:893-894`), so three dead seats outvote four healthy ones. The state they hid surfaced only when a lane's turn failed: 76 h, 118 h and 109 h after each seat's first failed probe (§3.4). What the screen showed on those probes is **UNVERIFIED**: the probe keeps no screen. Fix: classify the failure, keep one redacted screen per class, back off, and tell Home (§4.4). Explained, not a parser bug.

**Three options. One tap each.**

| | Option | What it buys | Cost (INFERENCE, in lane-days) |
|---|---|---|---|
| **1 (recommended)** | **Readings that tell the truth.** A reading has a health (reading, aged, can't read since X), a window is named from its own length or reset distance, a plan change is told once, and a limit hit from any lane or the manager sets one seat state with a back-at time and one notice with the fix. | All five gaps, each in its smallest form (§5). Works for any user's collectors and any account that posts. | 4 pull requests, about 2 to 3 days, plus a patch brief for the operator's own pool script (outside this repository). |
| 2 | **Labels and staleness only.** Gaps 1 and 3: names from length, "can't read since X". | Home stops showing old numbers as current and stops mislabelling a changed plan. Does not explain or reduce the probe failures, does not unify limit hits, no notices. | 2 pull requests, about 1 day. |
| 3 | **Option 1 plus Claude in Morndo's pool** (the product team's proposal B). | Claude accounts leave the outside pool script; usage comes from the status line, not a screen probe. | 8 or more pull requests, 1 to 2 weeks, a terms review, and a phone-side sign-in nobody has verified. Not recommended before Option 1 has shipped. |

Recommended: **Option 1.** Tap "Go: option 1" and the manager files the four slices of §5 with the acceptance tests named there. Option 3 stays open and is easier after Option 1, because the seat state and the reading health it needs are built there.

**Decisions the plan makes by default (undo by saying so):**
- A reading that cannot be made replaces the meters with "can't read since X" (§4.3); the last figures are not shown beside it.
- No credential file is read by anything in this repository (§6). Plan names come from what a provider's own CLI or documented API prints.
- Usage still decides nothing (U4): a seat state is displayed and told, never routed on.

---

## 1. What exists today

| # | Fact | Source |
|---|---|---|
| F1 | Usage keeps per account the newest report's windows; a window a report lacks is kept until its reset time passes, then dropped. There is no age beyond `reportedAt` and no failure state. | `packages/domain/src/usage.ts:44`, `:117-140`, `:148-154` |
| F2 | Home shows "reported {ago}" per account and "Usage as of" for the view; a window never reported reads "not reported". | `apps/web/src/lib/desktop/HomeView.svelte:39-40`, `:48`, `:79`; `apps/web/src/lib/desktop/usage.ts:33-35` |
| F3 | The status-line route takes the agent CLI's own JSON. A window is `five_hour`, `seven_day` or `spend_limit`, or a named row with a label the poster chose. | `packages/protocol/src/usage.ts:23-38`; `apps/hub/src/application/usage-service.ts:13-33` |
| F4 | Claude Code puts `rate_limits` in the status line **only for claude.ai Pro and Max subscribers** (or behind a gateway with a spend limit), **only after the first response of a session**, each window may be absent, and a window is dropped at its `resets_at`. | https://code.claude.com/docs/en/statusline (read 2026-10-23), "rate_limits" note |
| F5 | The built-in `/usage` command shows session cost and plan usage limits, on Pro, Max, Team and Enterprise plans. | https://code.claude.com/docs/en/commands (read 2026-10-23), `/usage` row |
| F6 | The Codex reader already labels a window from its own length (`windowDurationMins`): 300 is "5-hour", 10080 is "7-day", otherwise "N-day/hour/minute window", null is "Window". The rule lives in an adapter, not the domain. | `apps/connections/src/adapters/usage-codex.ts:14-15`, `:71-78`, `:82-99` |
| F7 | An answer in an unknown shape is "unavailable", never a guess; the reader returns a problem string. Nothing carries that problem to the hub. | `apps/connections/src/adapters/usage-codex.ts:8-9`, `:110-111` |
| F8 | The pool's domain already has the vocabulary for a seat: states `logged-out`, `retired`, `out`, `low`, `ok`, a `backAt`, marks with an end time (default 60 min, at most 168 h), and a reading with windows that carry `minutes`. It is Codex-only today. | `packages/domain/src/pool.ts:24-27`, `:53-66`, `:199-205`, `:263-296`; `apps/connections/src/pool-cli.ts:24` |
| F9 | The pool decides a window is "short" or "long" by sorting on `minutes`, not by a name. | `packages/domain/src/pool.ts:219-224` |
| F10 | A notice about a seat exists for one case only (reset-credit advice), once per member and reason per day, recorded so it does not repeat. | `apps/connections/src/application/pool-service.ts:44`, `:254-262`; `apps/connections/src/pool-cli.ts:197-210` |
| F11 | A usage limit on a Codex turn marks the member out until the reset the failure names; a sign-in failure marks it signed out and keeps the marks. | `apps/connections/src/application/pool-service.ts:195-200`; `apps/connections/src/pool-cli.ts:378-380`, `:412-428` |
| F12 | A failed turn on any lane reaches the fleet as a `stop_failure` event whose `error` is up to 60 characters. Nothing in the hub reads it for an account. | `apps/fleet/src/application/lane-events.ts:79`; `packages/protocol/src/fleet.ts:287`; `apps/fleet/README.md:117` |
| F13 | The hub reads the pool's usage file for label parts (email, org, plan). A tier that is empty or the free tier reads as "no paid plan". That file is refreshed every 60 s. | `apps/hub/src/adapters/pool-accounts.ts:11-24`, `:65-121`; `apps/hub/src/main.ts:348-350` |
| F14 | The hub keeps each account's last state in `usage_accounts`, and `UsageService` takes `now` as a parameter (testable with a fake clock). | `apps/hub/src/adapters/store.ts:614-618`; `apps/hub/src/application/usage-service.ts:56-60` |
| F15 | The Z.ai collector picks windows by fixed codes (unit 3 / number 5 is "five_hour", unit 6 / number 1 is "seven_day") and exits 1, posting nothing, when neither is present. | `zai-collector:58-64` |
| F16 | The Cursor collector reads the CLI's own `/usage` screen. A screen it does not know raises `UnknownScreen`, logs a warning and posts nothing (`main`). On 2026-10-23 the screen still printed the caption "Monthly plan and on-demand usage" while the plan was on a weekly pool, so it now decides weekly or monthly from the reset distance, the plan name and the first date it saw a reset (`classify_period`). That rule lives inside one collector, with its own state file. | `cursor-collector`: `parse_usage_screen`, `classify_period`, `main` |
| F17 | The pool script's probe types `/usage` into a hidden terminal and parses "Current session" and "Current week (all models)". Any other screen is the same outcome: log "no usage on screen" and return. | `pool-script:817-830`, `:832-884` (failure at `:872-874`) |
| F18 | The probe runs only for a logged-in seat that is not retired, not lapsed and has **no live lane**, at most every 20 minutes, when its numbers are missing, older than an hour or past a reset. A seat with a live but idle lane is not probed, and the status line posts only when the lane takes a turn. | `pool-script:887-901` (`:889`, `:893-894`); status-line writer in the operator's status-line script |
| F19 | Usage-limit errors from a lane reach the pool through a failure hook: `rate_limit` marks the seat out until the later reset; `billing_error`, `authentication_failed`, `account_on_hold`, `oauth_org_not_allowed` flag it (retired, or 30 minutes for a token-refresh race). The hook runs before it checks for a terminal, so headless runs also mark. | hook script: lines 7-17; `pool-script:1241-1272` |
| F20 | The manager and the studio lane are looped windows. The guard moves them by a restart script, and reports a failed move with a different note than a lane's move. | `pool-script:87`, `:724-731` |
| F21 | The pool script retires a seat as "lapsed" from the credentials file's non-secret fields (tier, subscription type) and the configured expiry; a lapsed Max plan reads as "ok 100%" until then. | `pool-script:186-203`, `:294-326` |
| F22 | On this box today, three seats' usage files are 7, 10 and 14 days old, still holding their last numbers, with no sign of age anywhere. | usage files of the pool, mtimes read 2026-10-23 |

---

## 2. Principles

1. **Every user, not one owner.** Nothing in the design names a vendor, a machine or an operator script. A source tells the hub what it read and how often it will read again; the hub does the rest.
2. **Say when you can't read; never show old numbers as current.**
3. **Name a window by what it is.** Its length if the source gives it; else what was observed; else only its reset. Never a name a collector hard-coded.
4. **One thing, said once.** A state change produces one notice, whoever caused it.
5. **Read only what the provider's own CLI or documented API shows** (§6). No credential files, no web dashboards, no vendor bundles.
6. **Degrade the label before the reading.** A screen whose caption is unknown but whose percentages parse still posts the percentages.

---

## 3. Evidence

### 3.1 Labels (gap 1)

F15 and F16 show two collectors with two private rules. F16's own comment states the weakness: the caption "says nothing" and the rule is "wrong only for a monthly plan in its last week and not yet watched from the start of that month". A stateless collector cannot do better. The hub can: it holds every account's earlier reports (F14).

### 3.2 Plan change (gap 2)

F13 already turns a tier change into "no paid plan" for a label, but silently. F21 shows the lapse found by a heuristic over a credentials file. Neither tells anyone *what changed*.

### 3.3 Silence (gap 3)

F1, F2, F7, F16 and F22: a failed read has no path to Home, and an unread account keeps its last figures.

### 3.4 The 78% (gap 4)

Counted from the pool's `guard.log` (`probe NAME: ...` lines), window 10-15 21:00 to 10-20 00:00 box time:

| | Probes | Outcome |
|---|---|---|
| seat-a | 139 | all "no usage on screen" |
| seat-b | 187 | 186 "no usage on screen", 1 "claude did not come up" |
| seat-c | 220 | 21 read before its plan ended, then 199 "no usage on screen" |
| three other seats | 128 | all read |
| **Total** | **674** | **524 "no usage on screen" (77.7%), 149 read, 1 did not come up** |

Each failing run is one unbroken streak per seat, not scattered misses. From each seat's first failed probe to the event that finally marked it:

| Seat | First failed probe | Marked by | Gap |
|---|---|---|---|
| seat-a | 10-14 18:21 | a lane turn failed with `oauth_org_not_allowed`, 10-17 22:23 | 76 h |
| seat-b | 10-13 17:43 | same error, 10-18 15:21 | 118 h |
| seat-c | 10-17 01:05 | lapse noticed from the plan's expiry, 10-21 13:49 | 109 h |

Reading: **the probe's failure was the earliest signal of three seat problems and was thrown away.** The classes cannot be told apart from the log, because `probe()` logs one line for all of them (F17). The audit is repeatable (appendix A). On 10-21 the operator added a "lapsed" skip to the probe (F18 `:889`; **INFERENCE** from that day's backup of the script and the last failure at 13:45, which is why seat-c's failures stop then); seat-a and seat-b were probed until they were marked.

A second effect (INFERENCE): the status line cannot cover a Team seat. Claude Code documents `rate_limits` for Pro and Max only (F4), and `/usage` for Team too (F5). A Team seat with no live lane therefore depends on the probe, and with the probe failing it has no source at all.

---

## 4. Design

New words (to join `docs/domain.md`'s Usage section):

| Term | Means | Is not |
|---|---|---|
| **Source** | A named way an account's figures arrive: `status-line`, `app-server`, `cli-screen`, `vendor-api`. It may declare `every` (how often it will read, in seconds). | A Connection, a runtime. |
| **Reading health** | Per account and source: `reading` (last read ok and recent), `aged` (ok but older than the source's usual gap), `cannot-read` (a failure was posted, or an expected read did not come). With `since` and a reason class. | A window. |
| **Reason class** | Why a read failed: `unknown_screen`, `signed_out`, `refused`, `no_usage_for_plan`, `unreachable`, `timeout`, `plan_ended`. A closed list; a source may add free text of 120 characters. | A message to show verbatim. |
| **Cadence** | How long a window is, with its basis: `reported` (the source gave minutes), `observed` (two resets seen), `horizon` (only the furthest reset seen), `none`. | A name. |
| **Plan fact** | The plan name and the set of window ids a source last gave. | An entitlement. |
| **Seat state** | `ok`, `low`, `out`, `signed-out`, `refused`, `ended`, as the pool's `SeatState` plus `refused`. With `backAt` and `since`. | A routing decision (U4). |

New invariants (U6 onward; U5 is taken by labels):

| # | Invariant |
|---|---|
| U6 | A failed or missing read of a source never leaves that source's windows on show as current. Reading health `cannot-read` removes them from the card and says since when. A later ok read clears it. |
| U7 | A window's title comes from its cadence: `reported` or `observed` length, else the reset distance. A source cannot set the title. A guessed cadence is shown as "about". |
| U8 | A plan fact that changes (name, window ids, a window's length) or a used percentage that falls by 20 points or more while its reset is still ahead is a **plan change**. One notice per distinct change; the new fact becomes the baseline. The first fact ever seen is never a change. |
| U9 | A limit hit, a refused sign-in or a sign-out from any actor (a lane, the manager, a collector, the pool) sets the same seat state for the account. One notice per seat-state change, never per actor. |
| U10 | A seat state is shown and told, never routed on (U4 stands). |

### 4.1 Gap 1: windows named from their own length

**Today.** F6: Codex names by minutes in an adapter. F15: Z.ai by hard-coded unit codes. F16: Cursor by a private rule. F3: a named row's label is the poster's word.

**Design.**
1. Move the Codex rule to the domain as `windowTitle(cadence, resetsAt, now)`: 300 minutes is "5-hour", 10080 is "weekly" (the status line's `five_hour` and `seven_day` keep their documented names, F4); other whole days "N-day"; 28 to 31 days "monthly"; other hours and minutes as in F6.
2. A named row on the wire gains optional `length_mins`. A source that knows the length sends it (Codex has it, F6; Z.ai's code pair becomes minutes in the collector, with an unknown code sending `null` instead of failing, F15).
3. Without a length, the hub keeps per window id the **furthest reset distance seen in the current cycle** and the **time between two consecutive resets** once one has passed (the hub holds earlier reports, F14). Cadence is `observed` after one reset, `horizon` before it. This is F16's rule moved to where the memory is. The 7-day bound stays a rule of thumb for a `horizon`, and the title says "about" until the cadence is `observed`.
4. With neither, the card says "resets in 6 d 2 h" and no cadence word.
5. A collector's caption is never read as a title (F16).

**Verified by.** AT-1 to AT-4 (§5). Live check: replay the Cursor screen captured on 2026-10-23 (weekly pool, "Monthly" caption) through the collector's `--parse`; Home must say "weekly" or "about weekly", never "monthly".

### 4.2 Gap 2: a plan change noticed and told once

**Today.** F13 relabels silently; F21 detects a lapse by heuristic. Nothing compares one plan fact with the last.

**Design.** `observePlan(before, after)` is a pure domain function over plan facts (name, window ids with lengths, per-window used percent and reset). It returns zero or more `PlanChange { kind: name | cadence | windows | drop, from, to }`.
- **name**: both known and different. Sources: Codex `planType` (F6), the Cursor screen header, the pool file's plan (F13, which already reaches the hub every 60 s, so a plan that falls to "no paid plan" is a name change).
- **cadence / windows**: the set of window ids, or one window's length, differs.
- **drop**: used percent falls by 20 points or more, and the previous reset is still more than a minute ahead, and the reset time has not moved by a cycle. This catches a provider-side reset and a plan upgrade. The pool script's own "numbers contradict the mark" rule is the same idea (`pool-script:224-262`).
- The hub records the notice signature (account, kind, to-value) in a small table `usage_notices`, so a repeat after a restart tells nobody (the pattern of F10, in the hub).
- The notice names what changed in words: "seat-b: window changed from 'monthly' to 'weekly, shared with a second product'. Home now shows the weekly window."

**Verified by.** AT-5 to AT-8.

### 4.3 Gap 3: "can't read since X", with a threshold per source

**Today.** F1, F2, F7, F16, F22.

**Design.**
1. A new route `POST /api/agent/usage/failure` (agent token, same account header) takes `{ source, reason, detail?, every_s? }`. A collector that meets an unknown screen posts this instead of nothing. Detail is cut to 120 characters, control characters removed, and anything containing an `@` dropped.
2. Every ok post may carry `X-Morndo-Source` and `X-Morndo-Every` (seconds). The first sets the source (default `status-line`); the second registers that this source will read again by then.
3. The hub keeps health per (account, source): `lastOkAt`, `lastFailAt`, `reason`, `every`. It computes the state on `view()`:
   - `reading`: last ok within `2 x every`;
   - `aged`: older than that, shown as "as of 2 h ago", meters kept;
   - `cannot-read`: a failure newer than the last ok, **or** no read for `max(4 x every, 30 min)` from a source that declared `every` (this catches a collector that died, which can post nothing).
   A source with no `every` (the status line) is never `cannot-read` by silence: an idle account is not a fault. It is `aged` only, as today's "reported {ago}".
4. Defaults a source can rely on: status line none; Codex app-server and the two vendor collectors 15 minutes; a pool screen probe 60 minutes. These are the sources' own declarations, not hub constants, except the 30-minute floor.
5. Home: the card replaces the meters of a `cannot-read` source with "can't read since 14:05 (screen not recognised)". Other sources of the same account keep their meters. U2's rule about a window a report lacks is unchanged: that is a successful read without the window.
6. Compatibility: an old collector that never posts a failure and never declares `every` behaves as today.

**Verified by.** AT-9 to AT-12.

### 4.4 Gap 4: the Claude probe's "no usage on screen"

**Cause.** §3.4: three unusable seats retried forever under one undifferentiated line. Not the parser.

**Fix (two parts, only the second is in this repository).**
1. *The operator's pool script* (outside this repository; a separate brief): `probe()` classifies what it sees before it gives up, in the way the Cursor collector already does (`parse_usage_screen` separates "Not logged in", "Failed to load usage data", "not available for this plan", an unknown layout). It keeps **one redacted screen head (40 lines, addresses masked) per seat per class** next to the log; backs off a failing seat (20 min, 1 h, 6 h, then daily) instead of every 20 minutes; checks `claude auth status` (documented: JSON, exit code 1 when signed out) to separate `signed_out` from the rest; and posts the class as a failure to Home (§4.3). Step 0 of the brief is to capture the missing evidence: the screen text for each failing class. Until then the mapping from screen to class is **UNVERIFIED** and AT-13 uses synthetic screens labelled as such.
2. *This repository*: the reason classes and the failure route of §4.3, and a seat state (§4.5) so a `refused` or `signed_out` class becomes "seat-a is refused by its organization; sign in with another account" the day it starts, not 76 h later.

**Live accounts the probe skips (F18).** An account with an idle live lane has no status-line post and no probe. Under §4.3 the status line carries no `every`, so it is only `aged`. Where a Claude status line has `refreshInterval` (https://code.claude.com/docs/en/statusline, read 2026-10-23), re-running the script on a timer does not help: the data it receives updates only after a response. The honest answer is the age label. Probing a live seat's account from outside its session is not proposed (it would start a second client on a subscription that has a running one).

**Team seats (INFERENCE from F4 and F5).** Their only documented sources are `/usage` and a probe of it. If the probe cannot read them they are `cannot-read`, with the reason class, which is the true state.

**Verified by.** AT-13, AT-14, and the audit of appendix A re-run after the pool-script patch: every failing probe line carries a class; no seat is probed more than once an hour after three failures.

### 4.5 Gap 5: one seat state for a limit hit from any actor

**Today.** Three paths that never meet: the failure hook marks the pool script's own files (F19); the hub receives `stop_failure` and does nothing with it (F12); the Codex pool marks its own domain (F11). The manager is moved by a different script than a lane, with a different note (F20). **UNVERIFIED:** whether the manager's failure reaches the fleet hook identically to a lane's; the plan does not depend on it, because the account is the key (below).

**Design.**
1. `UsageService.noteLimit({ account, kind, backAt?, by, at, fix? })`, where `kind` is `usage_limit`, `refused`, `signed_out`, `billing`, `unknown`. One route, `POST /api/agent/usage/limit`, for collectors, the Codex pool and the hook, and one in-process call from the fleet's `stop_failure` consumer. `by` is a label (lane name, `manager`, `pool`, a collector); it is stored for the notice but does not change the outcome.
2. The account of a `stop_failure` comes from the lane's own `MORNDO_ACCOUNT` header, else from the account that has the failing session among its fresh sessions (`packages/domain/src/usage.ts:11`, `:122-124`, 10-minute freshness). If neither exists the event is kept as `unknown` with no seat change.
3. Seat state precedence is the pool's (`packages/domain/src/pool.ts:263-283`): signed-out, then ended or refused, then out, then low, then ok. `out` ends at `backAt` (the failure's reset if it names one, else 60 minutes, never more than 168 hours: the pool's own marks, F8). `low` comes from readings at 90% and above, the notice level already used (`usage.ts:36-39`). A fresh ok reading with at least 25 points left in every window clears a mark made before it (the pool does this already, `pool-script:224-262`, and `packages/domain/src/pool.ts:189-194`).
4. A seat-state change produces exactly one notice with: the account, the state, the back-at time, who hit it, and the fix. The fix is a string the source supplies (`fix`, 120 characters), for example the pool script's undo command; with none, a generic sentence. The hub never invents a command.
5. The Codex path posts its seat states through the same route from the collector that already lists them (`morndo-keys pool list --json`, used by the Codex collector), so a Codex and a Claude seat share one Home row.
6. Notices go to Home's notice area and, as a count-only push, through the existing notification service (`apps/hub/src/application/notification-service.ts:30`, `apps/hub/src/main.ts:290-296`). A new `NotificationKind` for usage is a domain addition in slice 2.

**Verified by.** AT-15 to AT-18.

---

## 5. The smallest v1, and its acceptance tests

Four pull requests, in order. Each is green on its own and leaves Home working.

| Slice | Contents | Done when |
|---|---|---|
| **S1 domain and protocol** | `windowTitle`, cadence inference, `ReadingHealth` as a pure function of facts, `observePlan`, seat-state precedence, U6 to U10 in `docs/domain.md`; wire: optional `length_mins`, failure body, limit body, source headers. | AT-1 to AT-8, AT-15 (domain side) |
| **S2 hub** | `usage_notices` and health tables (one migration), the two routes, the `stop_failure` consumer, the silence sweep, notices to the notice area. | AT-9, AT-10, AT-11, AT-15 to AT-18 |
| **S3 Home** | "can't read since X", titles from cadence, seat state and back-at on the card. | AT-12 and the Home e2e |
| **S4 collector contract and docs** | `docs/agents/usage.md` gains the source/failure/limit contract and the reason classes. The Codex collector posts seat states; its reader sends `length_mins`. | AT-14 |

**Not in v1:** the lanes waiting on a seat (proposal A's third item), a usage history, any routing on usage, any change to the pool script (a separate brief), a Claude runtime in the pool.

Acceptance tests. Test files are new unless noted; a fake clock is passed as `now` everywhere (F14).

| ID | File and name | Asserts |
|---|---|---|
| AT-1 | `packages/domain/test/usage-title.test.ts` "names a window from its reported length" | 300 min is "5-hour"; 10080 is "weekly"; 4320 is "3-day"; 43200 is "monthly"; 90 is "90-minute window". |
| AT-2 | same, "never names from a caption" | A window with `length_mins` 10080 and a poster label "monthly" is titled "weekly". |
| AT-3 | same, "observes a cycle" | Two reports across a reset 7 days apart: cadence `observed`, title "weekly" with no "about". |
| AT-4 | same, "horizon only says about" | One report 6 d 20 h before its reset: title "about weekly"; one 25 d before: "about monthly"; no length and no history: "resets in ...", no cadence word. |
| AT-5 | `packages/domain/test/usage-plan.test.ts` "a changed plan name is one change" | before "Plan X", after "Plan Y": one `name` change; before null: none. |
| AT-6 | same, "a changed window set or length is a change" | A second window appearing, or 43200 becoming 10080, each one change. |
| AT-7 | same, "a drop outside a reset is a change; at a reset it is not" | 80% to 20% with the reset 3 d ahead and unchanged: `drop`. 80% to 5% with the reset moved forward a cycle: none. A fall of 19 points: none. |
| AT-8 | `apps/hub/test/usage-notices.test.ts` "tells a change once, across a restart" | The same change posted twice, and again after the service is rebuilt on the same store: one notice. A different change: a second. |
| AT-9 | `apps/hub/test/usage-health.test.ts` "a posted failure replaces the meters" | After `failure {reason: unknown_screen}`, the account view has `cannot-read since T` and no windows for that source; other sources keep theirs. |
| AT-10 | same, "a source that declared every goes silent" | `every` 900 s, no post for `max(4 x every, 30 min)`: `cannot-read`; a post clears it. |
| AT-11 | same, "the status line is never cannot-read by silence" | No `every`, 6 h of silence: `aged`, windows kept until their reset (U2 unchanged). |
| AT-12 | `e2e/home.e2e.ts` "shows can't read since, and a title from the cadence" (existing file) | Post a failure and a 7-day window labelled "monthly" with `length_mins` 10080: the card says "can't read since" and "weekly". Screenshot kept. |
| AT-13 | `packages/domain/test/usage-reason.test.ts` "reason classes are closed" | An unknown reason maps to `unknown_screen`; detail with an `@` is dropped; 120-character cut. Fixtures are synthetic and labelled so until the real screens of §4.4 are captured. |
| AT-14 | `apps/connections/test/usage-codex.test.ts` (existing) "sends length_mins" | `usageReport` rows carry the window duration; an unknown duration sends `null`, not a failure. |
| AT-15 | `apps/hub/test/usage-seats.test.ts` "a lane and the manager set the same seat state" | A `stop_failure` `rate_limit` from a lane actor and from the principal actor, in two runs: identical seat state and back-at; one notice each run. |
| AT-16 | same, "two actors, one change, one notice" | A lane then the manager hit the same account within the mark: one notice. |
| AT-17 | same, "a refusal is its own state with the fix" | `oauth_org_not_allowed` sets `refused`; the notice carries the source's `fix` string, or the generic sentence when none is given; the hub adds no command of its own. |
| AT-18 | same, "a fresh reading clears a mark made before it" | `out` until 18:00; at 15:00 a reading with 40 points left in both windows: `ok`, one "back" notice. |

**Negative controls** (a test that cannot fail proves nothing): `scripts/negative-controls.ts` runs HEAD, so each slice commits first. Controls to add: the sweep returns `reading` always (AT-10 must fail); the title function reads the poster's label (AT-2 must fail); the notice signature ignores the account (AT-16 must fail).

**Manual QA before "done"** (recorded in `qa/<date>.md` with screenshots): install from scratch with the quick start; post a status-line report, then a failure, with `curl` as in `docs/agents/usage.md`; stop the collector's timer and watch Home go from "reading" through "aged" to "can't read since"; post a plan change; post a limit from a lane token and from a manager token; confirm one notice each.

---

## 6. Terms check (read 2026-10-23)

| Provider | What the terms say | What v1 does |
|---|---|---|
| Claude Code | "Developers ... may not collect, store, or intermediate Claude.ai credentials or session tokens"; OAuth is "intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans". It "does not prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". https://code.claude.com/docs/en/legal-and-compliance | Reads only the status line's JSON, `claude auth status` and the built-in `/usage`; never a credentials file; never a token. Each account is a user's own sign-in in its own config directory (https://code.claude.com/docs/en/authentication, "Log in with multiple accounts"). The pool script reads non-secret fields of the credentials file for plan names (F21); **that is not carried into this repository**. A documented way to read the plan name for Claude is not found (**UNVERIFIED**): v1 shows no plan name for Claude beyond the label parts the operator's own pool file supplies (F13). |
| Cursor | Section 1.5 (updated 2026-09-03): no "reverse engineer ... or otherwise attempt to derive or gain access to the source code", no "probe, scan or attempt to penetrate the Service", no "harvest, scrape, or extract data from the Service". https://cursor.com/terms-of-service | Reads only what the official CLI's `/usage` command prints. Never the web dashboard, never the CLI's bundle or internal endpoints. Whether driving the CLI's screen is "extraction" is a judgment the owner already made (2026-10-11, ADR-0024 [S11]); this plan keeps it and adds nothing to it. A team admin API key route stays as ADR-0024 left it. |
| Z.ai | No automated means "for the purpose of accessing, obtaining, or monitoring any unauthorized data". https://docs.z.ai/legal-agreement/terms-of-use (quoted from ADR-0024 [S10], read 2026-10-11; not re-read today) | Unchanged: the quota call Z.ai's own plugin makes. A shape this reader does not know posts a failure (§4.3), not a guess. |
| Codex | Settled in ADR-0028 and the plan of 2026-10-15; the app server is "experimental" and an unknown shape is "unavailable" (F7). | Unchanged. |

The probe that types `/usage` into a hidden terminal (F17) drives the official binary and reads its own screen. ADR-0024 listed "reading a terminal's screen" under *Never* for a usage adapter in this repository; the operator's pool script is outside it. This plan therefore does **not** put a screen probe into the repository. A user who wants one runs their own and posts its result and its failures through the routes of §4.3.

---

## 7. Risks and open questions

| # | Risk or question | Default |
|---|---|---|
| R1 | A `horizon` guess is wrong at a cycle boundary (a monthly plan seen in its last week). | The title says "about" until `observed` (U7), and the first reset corrects it. |
| R2 | A provider-side reset looks like a plan change (the `drop` rule). | Accepted: the notice says "used fell from 80% to 20% with the reset still 3 days away", which is what the user wants to know. |
| R3 | A collector can post a false failure. | A failure is as trusted as a report (U1: an agent token). |
| R4 | Two collectors for one account fight (one ok, one failing). | Health is per source; the card shows each source's state. |
| R5 | The Cursor collector is being changed by T-412 now. | S4 consumes its output (`length_mins`, failure); it does not touch it. Hand T-412 this plan's §4.1 and §4.3. |
| R6 | ADR-0024's draft (not on main) proposes `U5` to `U8` for provider readings. | They collide with U5 (labels) on main. ADR-0036 supersedes the numbering; its content (sources, standing, amounts) is still wanted later. |
| OQ1 | Is there a documented, non-credential way to read a Claude account's plan name? | None found. v1 does without. Ask the provider's docs again at S1. |
| OQ2 | The screen text of each failing class of the Claude probe. | Step 0 of the pool-script brief; needs the owner's OK to run a probe on a seat that is retired. |

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
