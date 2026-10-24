# ADR-0037: Key pools: several API keys of one provider behind one name, rotated only on exhausted credit

- **Status:** Accepted with the pull request that adds slice 1, 2026-10-25.
- **Builds on:** ADR-0018 (Connections, the lease gate, the sealed store, CN1, CN4, CN5, CN8, CN15), ADR-0022 (the store and the Use gate are shared; Secrets stay a separate context), ADR-0029 (the account pool, the sibling for subscriptions).
- **Rules:** KP1 to KP15 in `docs/domain.md` (KP16 to KP19 arrive with slices 2 and 3).
- **Plan:** `docs/plans/2026-10-24-key-pools.md`, revision 3.1, reviewed twice. This ADR records what slice 1 built and the decisions the plan left to the build.

## Context

1. The owner wants prepaid API keys used in rotation, opt in, with consumers getting a key the way they do today. A pool member is a Connection, so the lease gate still runs on every key.
2. No provider API reports a key's balance (plan section 4). "Until empty" means: use a key, learn it is empty from the first refusal, skip it from then on.
3. A refusal is not always a reason to move on. The Usage Policy forbids circumventing a ban with another account (plan section 7). Rotating on a 401, a 403 or an account on hold would move traffic to another account because one account was refused.
4. Provider facts (read 2026-10-25): the errors page lists 401 `authentication_error`, 402 `billing_error`, 403 `permission_error`, 429 `rate_limit_error`, and says a spend limit the owner set returns 400 `invalid_request_error`; the rate-limits page gives the monthly cap's 429 with `error.details.error_code` `enforced_spend_limit_reached` and no `retry-after`, and the spend-limit message "You have reached your specified API usage limits" with the date access resumes [S1, S2]. Which status a credit refusal carries is not documented; the classifier matches the message and accepts 400 or 402.

## Decision

1. **A KeyPool aggregate inside the Connections context** (`packages/domain/src/key-pool.ts`), not a new context and not a field of Connection: a Connection must not know its siblings (CN15), and a pool needs its own consistency boundary (the last pick, the member health, the terms). Pure; the clock is the `now` argument. A member is the Connection's **name**. The pool holds no ref, no fingerprint, no secret (CN1, CN5).
2. **Key pool, never "pool" alone; "last pick", not "cursor".** `docs/domain.md` already has Pool (ADR-0029, subscriptions). The two share the idea of rotation and nothing else, so prose says "key pool" and code says `KeyPool` / `KeyMember`. The plan called the saved position of the rotation the cursor; that word is a catalog preset id, which a repository test keeps out of the domain and application sources (`no-vendor-names`), so the term and the field are `lastPick`.
3. **Rotation: `round-robin` by default, `drain` as the opt-in "until empty"**, order = join order, deterministic, saved last pick (KP4). No randomness, no clock in the choice.
4. **Automatic rotation only on exhausted credit or an owner-set spend limit.** A 401, 403, `account_on_hold`, `authentication_failed` and the tier's monthly cap are `failing`: they **block the pool** (KP3) until the principal revives the member or the Connection is rotated to a new key. A probe never clears a failing member. A 429 for rate is recorded and changes nothing.
5. **The last pick is saved before the lease gate runs, the pick event after it** (KP9, KP15). Two concurrent picks then see each other's last pick and get different members in round-robin; a gate refusal (budget, terms, repo, isolation) tries the next servable member, records the refused words in the one `MemberPicked`, and never changes health.
6. **A pool holds only keys of accounts the owner holds.** A join needs the member's provider organization to be one the principal confirmed, or `--confirm-own-account` (`OwnerConfirmed`, with the command id). Slice 1 has no probe, so it cannot read an organization id: **every member needs the flag in slice 1**, and the flag is the whole check.
7. **Terms: the principal acknowledges a catalog line at `keypool create`** (`--by <who>`, as CN4). The preset carries an optional `keyPool` object (`errorDialect`, `termsRevision`, `termsLine`); only the first-party preset has one, so no other provider can host a pool yet (`no_classifier`). A pool whose acknowledged revision is not the catalog's is refused by the gate word `terms`. The line's wording is the owner's to revise.
8. **The classifier is an anti-corruption adapter** (`adapters/outcome-anthropic.ts`), chosen by the preset's `errorDialect`. It turns a status, an error type, a bounded message, a `retry-after` and a date into an `Outcome` and drops them. An unmatched 4xx raises an `unclassified` alert carrying the status and error type only. A malformed request (a bad `max_tokens`) is `unknown` and never exhausts a key.
9. **Report-back in slice 1 is the `run` wrapper.** `morndo-keys run --pool P` supervises the child, classifies its final output with the same table, reports the member it ran on, and, for a headless turn (`-p`), retries once on the next servable member. An interactive session reports but is not retried. Claude Code's printed refusal lines are not documented; the fixtures for them are synthetic, and the `StopFailure` hook (slice 4) replaces the reading of printed text.
10. **Storage: one additive migration (4), table `key_pool`**, one JSON body and a version per pool, saved only on the version read. A deleted pool leaves a tombstone row, so its name is never reused (KP1). Names are shared with Connections: a Connection cannot take a pool's name, nor a pool a Connection's.
11. **Revocation reaches the pool through a lifecycle hook** on `ConnectionsService` (`reserved`, `revoked`, `rotated`), and a pick heals a pool whose member was revoked behind its back.

## Not in slice 1

Grants and the pooled helper hand-off (KP17 to KP19, slice 2), Priority and engine-layer re-derivation (slice 2), probes, the claimed recheck and the organization reader (KP16, slice 3), the `StopFailure` hook, `write-env` and sinks (slice 4), the web card (slice 5). Until slice 2 an interactive session that runs dry keeps its key for the whole session.

## Alternatives

| Option | Verdict |
|---|---|
| Skip a failing member and carry on | Rejected for v1: it moves traffic to another account because one was refused (decision 4). A later skip for `rejected` only is possible. |
| A local gateway that sees every response | Deferred (ADR-0018 deferred it): exact reporting and per-request rotation, at the price of a proxy in the key path. |
| Pool members as a field of the Connection | Rejected: a Connection must not know its siblings (CN15). |
| Pool inside the account Pool | Rejected: subscriptions have seats, windows and marks; keys have credit. Different rules. |
| Pick and write one event after the gate, saving the last pick once | Rejected: two concurrent picks would take the same member. |

## Consequences

- **Good:** two or more prepaid keys are used one after the other with no hand-switching; a dry key costs one refused request; nothing about a single key changes.
- **Cost:** one table, one aggregate, one service, one classifier, one CLI command group, and a lifecycle hook on `ConnectionsService`.
- **Limit:** a key that runs dry in an interactive session is served until the session ends (until slices 2 and 4).
- **Limit:** a failed run is classified from the end of its output; a failing run whose output quotes a refusal could mark a key exhausted wrongly, and until slice 3's recheck only `revive` undoes it. A successful run is never read.
- **Limit:** keys of one organization share its rate limits and monthly cap; a pool gains nothing against a 429 or the cap.
- **Limit:** the ownership check is the owner's confirmation, not a proof (decision 6).

## Sources (read 2026-10-25)

- [S1] https://platform.claude.com/docs/en/api/errors
- [S2] https://platform.claude.com/docs/en/api/rate-limits
- [S3] https://code.claude.com/docs/en/settings-reference.md (`apiKeyHelper`), as read for the plan on 2026-10-24
- [S4] The plan's terms section (the owner's reading of the Consumer, Commercial and Supplemental Credits Terms, 2026-10-24)
