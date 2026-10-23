# ADR-0036: A usage reading has a health, a window has a cadence, a seat has one state

- **Status:** Proposed, 2026-10-23. Plan: [`docs/plans/2026-10-23-usage-detection.md`](../plans/2026-10-23-usage-detection.md). Design only; no product code.
- **Number:** 0035 is taken on a branch not yet on `main`. 0024 is proposed on a branch and its rules U5 to U8 collide with U5 (labels, ADR-0034); this ADR numbers its rules from U6.
- **Builds on:** ADR-0016 (Usage, U1 to U4), ADR-0029 (the pool's seats), ADR-0034 (U5).

## Context

1. **Home keeps the last figures it was told.** A reader that fails posts nothing, so a failed or dead source leaves old numbers on show with no sign of age (`packages/domain/src/usage.ts:44`, `:148-154`).
2. **A window's name is the poster's word,** so a provider that changes a plan's cadence is mislabelled until a person notices.
3. **A limit hit has three paths that never meet:** the pool, the fleet's `stop_failure` event (nothing reads it for an account) and a reader's own screen.
4. **A probe failure carried the earliest signal of three unusable seats and was logged as one undifferentiated line:** 524 of 674 probes in five days, from three seats, 76 to 118 hours before a lane's failed turn marked them (plan §3.4).

## Decision

1. **Reading health.** Per account and source: `reading`, `aged`, `cannot-read since T` with a reason class (U6). A source may declare how often it will read; silence beyond `max(4 x every, 30 min)` from such a source is `cannot-read`. A source that declares nothing, the status line, is only ever `aged`. Home replaces the meters of a `cannot-read` source with the time and the reason.
2. **Cadence.** A window's title comes from its length when the source reports it, else from the cycle the hub has observed, else from the furthest reset distance seen ("about"), else from the reset alone (U7). A caption is never a title.
3. **Plan change.** A changed plan name, window set or window length, or a used percentage that falls by 20 points or more with its reset still ahead, is told once with what changed (U8). Notice signatures are kept in the hub, so a restart does not repeat one.
4. **One seat state.** A limit hit, refusal or sign-out from any actor sets the same state for the account, with a back-at time and one notice with the source's own fix string (U9). The state is shown and told, never routed on (U10, U4).
5. **Routes.** `POST /api/agent/usage/failure` and `POST /api/agent/usage/limit` under an agent token; optional `length_mins` on a named row; `X-Morndo-Source` and `X-Morndo-Every` on a report.
6. **Never:** a credential file, a web dashboard, a vendor bundle or internal endpoint as a source; a hub-invented fix command.

## Alternatives

| Option | Verdict |
|---|---|
| Show age only ("as of") and keep the meters | Rejected. A figure from a failed reader looks current; the user asked for "can't read since", not a smaller clock. |
| Let each collector decide weekly or monthly | Rejected. Two collectors already have two private rules, one of them stateful; the hub holds the earlier reports. |
| A screen probe inside the repository | Rejected for now. ADR-0024 lists reading a terminal screen under *Never*; a user who runs one posts its result and failures. |
| A Claude runtime in the pool to get usage from the status line | Kept open (Option 3 of the plan). Large; needs its own terms check; a phone-side sign-in is unverified. |

## Consequences

- **Good:** a source that stops, a plan that changes and a seat that is refused are each shown within a poll, and told once.
- **Cost:** two tables (health, notices), two routes, a title function in the domain, a seat-state record in Usage.
- **Limit:** a Team seat has no status-line `rate_limits` (documented for Pro and Max only); its only source is a screen read, so it can be `cannot-read` for a long time.
- **Not here:** usage history, routing on usage, the lanes waiting on a seat.
