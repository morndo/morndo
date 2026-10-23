# ADR-0036: A usage reading has a source, a state and a cadence; a seat has one state

- **Status:** Proposed, 2026-10-23 (revised twice the same day). Plan: [`docs/plans/2026-10-23-usage-detection.md`](../plans/2026-10-23-usage-detection.md). Design only; no product code.
- **Number:** 0035 is taken on a branch not yet on `main`. 0024 is proposed on a branch and its rules U5 to U8 collide with U5 (labels, ADR-0034); this ADR numbers its rules from U6.
- **Builds on:** ADR-0016 (Usage, U1 to U4), ADR-0029 (the pool's seats), ADR-0034 (U5).

## Context

1. **Home keeps the last figures it was told.** A reader that fails posts nothing, so a failed or dead source leaves old numbers on show with no sign of age (`packages/domain/src/usage.ts:44`, `:148-154`). A status-line value that is not a percentage shows as 100% (`apps/hub/src/application/usage-service.ts:15-17`, `usage.ts:41-42`).
2. **A window's name is the poster's word,** so a provider that changes a plan's cadence is mislabelled until a person notices (Cursor's weekly pool shown as monthly is the case that started this).
3. **A limit hit has three paths that never meet:** the pool, the fleet's `stop_failure` event (nothing reads it for an account; the manager's never becomes an event) and a reader's own screen.
4. **Claude is read by typing into a terminal.** Its failures carry one line for every cause (524 of 674 probes in five days, from three seats). The CLI documents a structured report instead (`SDKUsageReport`, experimental), checked by a run on 2026-10-23: 0 turns, $0.
5. **The open-source monitors** (CodexBar, ccstatusline, Claude-Code-Usage-Monitor, the Codex TUI) agree on: a typed reading, four states, a rationed reader per account, limits decided from events, a baseline reset on a plan change, fixtures per source.

## Decision

1. **A Reading** carries source, node, captured-at, plan, and windows with percent (null, never 0), reset, length, rolling and a short note; or a failure with a class from a closed list. One route, `POST /api/agent/usage/readings`; the raw status-line route stays and the hub turns each report into a Reading.
2. **Four states per source** (U6): `available`, `stale` (meters kept, dimmed, with age), `unavailable` (meters replaced by "can't read since X"), `missing`. Transient failures (429, timeout, 5xx) leave a source stale for up to an hour; permanent ones (signed out, refused, no scope, unknown shape) make it unavailable at once. A source's declared `every` is clamped to 60 s to 6 h; the status line is stale after 10 minutes and never unavailable by silence; any source silent for 14 days is forgotten with one notice, and the principal can forget one at any time (U11).
3. **Cadence.** A window's title comes from its reported length, else the cycle the hub observed, else the furthest reset distance ("about"), else the reset alone (U7). A caption is never a title.
4. **Plan change** (U8): a changed plan name, account identity, window set or length, or a used percentage that falls 20 points with its reset unchanged on a window not declared rolling, is told once, and only after a second reading agrees. Thresholds at 75% and 90% are told once per account, window, reset and level (U12). Bad values are dropped, never clamped (U14).
5. **One seat state** (U9, U13): the pool's own `SeatState` plus a `why`. A limit hit from any reporter sets it for the account it resolves to, from the failure hook's own account field (`MORNDO_ACCOUNT`, or a pool's config-directory name), then a lane record written at `lane.start` and by reports, then the fresh sessions, then the node's only account, else `unknown`. The fleet taps `/hook/failure` before its manager filter. A limit is decided from an event or a flag, never a percentage, and ends only on a fresh read taken after its `backAt` (nothing clears it early, because a rate-limited usage endpoint can return data up to an hour old). A seat state set by a pool is sticky until that pool or the principal clears it; one the hub derived clears on a fresh primary read (U15).
6. **Claude is read by the CLI's own headless `/usage`,** on demand (a viewer, or after a limit's reset; never on a timer) and leased by the hub across machines (one lease per account, a 4-minute shared cache and cooldown, a hub-wide cap, leases that expire by themselves, a 120-second timeout). The status line is the secondary source with guards, and the newer reading by capture time wins. Codex is rationed the same way and polled no faster than once a minute. A token without the profile scope yields no report: the reason `no_scope`, never 0%, and the reading may come from a machine with a full login.
7. **Remedies are a closed list** (U10). A Fix is one of a fixed set the hub words itself; text from an agent token is a Hint, shown as "the source says", 120 characters, no links, never in a push.
8. **Never:** a credential file, a web dashboard, a vendor bundle, an undocumented endpoint (the OAuth usage endpoint with a harvested token), or a local transcript estimate as a limit. A terminal screen is read only by an operator's collector outside the repository (Cursor); a parser of captured text may live here.

## Alternatives

| Option | Verdict |
|---|---|
| Keep the tmux `/usage` probe and classify its failures | Kept only as the pool script's interim fix. A screen is brittle; the structured report is documented. |
| Call the OAuth usage endpoint with the stored token | Rejected. Undocumented, aggressively rate limited, and it handles tokens the legal page forbids collecting. |
| Show age only ("as of") and keep the meters | Rejected for a failed source. A figure from a failed reader looks current. Kept for a source that is only old. |
| Let each collector decide weekly or monthly | Rejected. Three private rules already; the hub holds the earlier reports. |
| A Claude runtime in the pool for usage from the status line | Kept open (plan, Option 3). Large; needs its own terms check. |

## Consequences

- **Good:** a source that stops, a plan that changes, a seat that is refused or a limit that is hit is shown within a poll and told once; Claude usage no longer depends on a screen.
- **Cost:** tables for health, notices, cadence and lane records (one migration), three routes, a reader with rationing, a fixture matrix; seven pull requests (plan §5).
- **Limits:** whether the headless reader is acceptable under Anthropic's consumer terms on automated access (Section 3 item 7) is a judgement for the owner (plan §6); the `usage_report` type is experimental; a headless read during an endpoint rate limit may be last-known data with no marker; a machine with only pool tokens needs a full login or another machine's reading; a Team seat has no status-line `rate_limits`, so its source is the headless report.
- **Not here:** usage history, routing on usage, the lanes waiting on a seat.
