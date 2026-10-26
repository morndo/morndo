# Brief for the operator's pool script

For whoever runs a pool script beside Morndo (the one that keeps a set of seats, probes their usage and marks seats
out). It lives outside this repository and is **not changed by this repository**: this is what the usage work
(docs/agents/usage.md, slices 1 to 7 of the usage-detection plan) lets it stop doing, and what it should post instead.
About a day of work. Seat names are made up.

## Why

The old probe types `/usage` into a hidden terminal and parses "Current session" and "Current week (all models)". Any
other screen is the same outcome, "no usage on screen", for every cause. In the audit behind the plan, 524 of 674
failed probes (10-15 to 10-20) came from three seats, each an unbroken streak that began on a different day after the
seat had read fine, and each seat was later marked by a failed lane turn (two refused by their organization, one
lapsed). The probe had one word for three different causes and retried every 20 minutes for days. The collector in
this repository (`morndo-usage-claude`) now reads the same numbers with the CLI's own headless `/usage`, rationed by
the hub, so the terminal probe is no longer needed for usage.

## What to change

1. **Retire the terminal probe** for usage once `morndo-usage-claude` runs on the node that holds the seat's login.
   The collector needs a full login per account (a `setup-token` login has no usage scope and reads as `no_scope`),
   and its config names each account's config directory (see "Reading Claude usage (headless)" in
   docs/agents/usage.md).
2. **Until then, classify what the probe sees**, never one word for every failure: signed out, rate limited,
   unreachable, a screen it does not know. Keep one redacted screen head per seat and class (no names, links or
   addresses), and post the class, not the head's words, to the hub.
3. **Back off a failing seat**: 20 minutes, then 1 hour, then 6 hours, then daily, and reset on a good read. A seat in
   a permanent class (signed out, refused by its organization, plan ended) is not retried by time at all.
4. **Check `auth status`** of the CLI (local, no network; exit 0 means signed in) before the next probe of a seat that
   failed signed out, as the collector does.
5. **Post seat states to `POST /api/agent/usage/pool`** with a token that carries the `usage-pool` scope
   (`morndo agent-token new pool --role worker --scope usage-pool`); lanes use the limit route and their marks are
   derived. Do not post usage numbers from a probe that cannot read them: a failure is a class, never 0%.
6. **A Team seat** is covered by the headless report (it carries the same `session` and `weekly_all` windows); no
   special case is needed once the collector reads it.
7. **Moved lanes**: a lane moved to another account by the script is not a `lane.start`; the failure hook should send
   the account (the `MORNDO_ACCOUNT` word) so the hub does not leave the lane record stale.

## Terms (decided)

Usage is read only by the unmodified CLI's own headless `/usage`, never the OAuth usage endpoint, a token, a
credentials file or a dashboard. The script must not harvest tokens for usage either.

## Not covered here

The Cursor and Z.ai collectors are also outside this repository; their contract (and, for Z.ai, a pure parser) is in
docs/agents/usage.md.
