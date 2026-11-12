# Usage providers: plans of other vendors on Home (design, 2026-10-11)

**Phase: design only.** This document and [ADR-0024](../../adr/0024-usage-from-other-vendors.md). No product code yet.

**The request:** one place for usage. Home shows the Claude accounts from their status lines (ADR-0016). The plans of other vendors the agents run on should sit next to them; the first two are a GLM Coding Plan on Z.ai and Cursor.

**Builds on:** ADR-0001, ADR-0012 (FL14), ADR-0015, ADR-0016 (U1 to U4), ADR-0018 (Connections, the Vault, the vendor catalog). Facts carry a source, all read 2026-10-11; **[S*n*]** points to section 7. UNVERIFIED marks what no primary source settled.

## 1. What the vendors offer

| | Z.ai GLM Coding Plan | Cursor, team plans | Cursor, personal plans |
|---|---|---|---|
| Plan limits | A 5-hour and a weekly window, in credits. The 5-hour credits refresh 5 hours after use; the weekly reset every 7 days from the subscription [S2]. | Per-member spend in the billing cycle, on-demand and overall, against a per-user limit [S6]. | Included usage and on-demand spend against a limit, per billing cycle [S8]. |
| Machine-readable source | Not in the API reference. Z.ai's own `glm-plan-usage` plugin, linked from its docs, calls a quota endpoint on the API host with the plan key as `Authorization` [S3, S4]. The answer lists each limit with its total, used, remaining, percentage and next reset (epoch ms). Its shape has changed since the plugin was written: the plugin still parses an older one. | The Admin API: `POST /teams/spend`, `/teams/daily-usage-data`, `/teams/filtered-usage-events` (with `chargedCents` per event), Basic auth with a team admin key [S6]. The API overview lists it for Enterprise teams [S7]. | None. The dashboard, and the CLI's interactive `/usage` [S8]. |
| Limits on polling | None published for the quota endpoint. | 20 requests a minute (60 for usage events); data aggregated hourly, poll at most hourly; 429 with `Retry-After: 60` [S7]. | n/a |
| Per-request figures | Tokens in each response's `usage` (prompt, completion, cached) [S5]. Credits = (input × input multiplier + cached × cached multiplier + output × output multiplier) / 10,000, at 50% off-peak; peak is weekdays 14:00 to 18:00 UTC+8 [S2]. | `chargedCents` per usage event [S6]. | Per-turn token totals in the CLI's `stream-json` and hook payloads [S8]. The status line's payload carries the context window, not plan meters [S9, UNVERIFIED for later versions: no official schema page]. |
| Terms | No automated means "for the purpose of accessing, obtaining, or monitoring any unauthorized data" [S10]. Plan benefits only in supported tools [S12]; a quota read calls no model. | No harvesting, scraping or extracting data from the service; no reverse engineering [S11]. | The same [S11]. |

Claude Code on a third-party Anthropic-compatible endpoint is not a Claude.ai subscriber session, so its status line has no `rate_limits` [S1]: a GLM plan used through Claude Code never reports through ADR-0016's route.

## 2. Goals and non-goals

**Goals.** Every plan the agents run on appears on Home as an account card, with the vendor's own figures where the vendor gives them, its credits or dollars beside the percentage, and an honest label where Morndo estimates. No vendor credential leaves its node.

**Non-goals.** No browser sessions, cookies or dashboard calls. No CLI sign-in token used beyond the CLI's own use. No screen reading. No usage history yet, no alerts on windows, no routing on usage (U4 stands).

## 3. Domain: Usage, extended

`packages/domain/src/usage.ts` keeps its aggregate and its merge (U2). New terms:

| Term | Means | Is not |
|---|---|---|
| Usage source | Where an account's windows come from: the agent CLI's status line (ADR-0016), or a vendor path polled on a node. Named by the preset's usage entry. | A Connection, a runtime. |
| Reading | One poll of a usage source: the windows it yields, at a time, for one account. | A Report: it has no session, lane or context. |
| Amount | Used and, when known, limit, in a unit (`credits`, `usd`, `requests`). | The percentage, which the vendor states or Morndo derives from the amount. |
| Provenance | `reported` (the CLI or the vendor stated it) or `estimated` (Morndo counted it from its own run records). | A confidence score. |
| Standing | How sanctioned a source is: `documented`, `vendor-published`, `none`. | A permission. |

Model changes: `UsageWindow` gains `amount: Amount | null` and `provenance`. `AccountUsage` gains `plan: { vendor; label } | null` and, per window, the time its figures were read. `UsageReport` keeps its shape; `UsageReading` is new.

| # | Invariant |
|---|---|
| U5 | A Reading is taken only under a node's agent token, for an account registered with that usage source, and names its source. It creates no session (U3 stays the status line's). |
| U6 | A `reported` window replaces an `estimated` one. An `estimated` window never replaces a `reported` one that has not reset. Home says "estimated" in words. |
| U7 | No vendor credential is in a Reading, the hub, the fleet, a log, an event or an Alert. A source opens its Secret on its own node, inside the adapter, for the one call (CN1, CN5, FL14). |
| U8 | A window's amount and percentage come from the same Reading. A window read more than twice its source's interval ago shows "as of" its time; it is still dropped at its reset (U2). |

## 4. The port, the adapters, and a vendor without an API

```
UsageSource.read(now): Reading | Unavailable(reason)      // reason: no_credential, refused, rate_limited, unknown_shape, unreachable
```

The runner lives with the node's Connections (`apps/connections`, beside the SpendMeter adapters of ADR-0018), so the Vault never has a second reader. It polls each registered source on its preset's interval, posts Readings to the hub, backs off on 429 (`Retry-After`) and on repeated failures, and raises one Alert per new Unavailable reason.

| Adapter | Standing | Yields | Interval |
|---|---|---|---|
| status line (ADR-0016, unchanged) | `documented` [S1] | 5-hour, weekly, spend; sessions | each turn |
| `usage-zai-quota` | `vendor-published` [S3, S4] | 5-hour and weekly, with credits as the amount | 15 min |
| `usage-cursor-admin` | `documented` [S6, S7], team plans | spend: the member's `spendCents` against `effectivePerUserLimitDollars`, `overallSpendCents` as context | 60 min |
| `usage-token-count` | n/a: Morndo's own records | estimated windows: Z.ai credits by the published formula and peak hours; Cursor dollars by the preset's dated prices | after each run |

**`vendor-published` paths fail closed.** The adapter matches the limits it knows (by type and period) and ignores the rest. An answer with none of them is `unknown_shape`: nothing is posted, the last windows stand until their reset (U2), and the Alert names the types seen, never the body. Fixtures pin the current shape and the older one the vendor's own tool still parses.

**A vendor without a sanctioned path** has standing `none` in the catalog. Its card shows "No usage source" and, if the user turns it on, `usage-token-count` estimates, labelled. Cursor personal plans are there today. A vendor that later documents an API moves to `documented` by a catalog change.

**Vendors are data** (ADR-0018 §5): each preset gains `usage: { adapter, standing, interval, windows, host }`. An architecture test fails if a usage adapter calls a host outside its preset, or reads a cookie store or an agent CLI's credential directory.

## 5. Secrets and privacy

- **Custody.** A usage credential is a Secret in the node's Vault (ADR-0018 §8), registered from stdin like any key. Q1 asks whether a plan key is its own Billing.
- **The call.** The adapter opens the Secret, passes it to the HTTP client as a header, and drops it. Never an argument, an environment variable of a child, a file, a log line or an error message; error bodies are cut and passed through the shared redactor, which knows the Secret's fingerprint.
- **The fleet.** Only the Reading crosses: numbers, reset times, the plan label. The hub can't call a vendor (FL14).
- **What a Reading holds about people.** A team source answers for every member; the adapter keeps the one member the account names, by an email the user typed, and discards the rest before anything is stored.

## 6. Wire, Home, and the order of work

- `POST /api/agent/usage/readings`, under an agent token: `{ source, account, at, plan, windows: { fiveHour?, sevenDay?, spend? } }`, each window `{ usedPercentage, resetsAt, amount?, provenance }`, typed in `packages/protocol/src/usage.ts`. The status-line route keeps taking the CLI's raw JSON.
- Home: the plan under the account's name, "6,648 of 12,000 credits" beside the meter, "estimated" in words, "as of 14:05" when stale (U8), and Unavailable reasons in words.

| PR | What | Done when |
|---|---|---|
| 1 | Domain and protocol: Amount, provenance, plan, Reading, U5 to U8. | Unit tests for each invariant, including a stale estimate that never replaces a fresh vendor figure. |
| 2 | Hub: the readings route, the store migration, Home's amounts, labels and "as of". | `e2e/home` posts a Reading and a status-line Report to one account and sees both, with no session from the Reading. |
| 3 | Node: the runner, Vault access, `usage-zai-quota`. | Fixtures for the current shape, the older one, an unknown one (nothing posted, one Alert), a 401 and a 429. A process scan during a poll finds the key in no argument list. |
| 4 | `usage-cursor-admin`. | Fixtures from the documented response; one member kept, the rest discarded. A live check needs a team admin key. |
| 5 | `usage-token-count`. | An estimate within the vendor's figure over a day of runs, stated as a range, not a pass. |

**Bridge until PR 3.** On a single machine, a small script can poll a source and map its windows into the status-line JSON for ADR-0016's route. It loses the amounts and shows the script as a session for 10 minutes. It is a stopgap, replaced by PR 3.

**Q1.** A plan key (Z.ai's Coding Plan key) is billed by its plan's windows, not metered or prepaid. Should ADR-0018's Billing gain `plan`, with no USD Budget, its limits shown by Usage? Default: yes, in ADR-0018's next revision.

## 7. Sources (all read 2026-10-11)

- [S1] Claude Code status line: `rate_limits.five_hour`, `seven_day` for Claude.ai subscribers. https://code.claude.com/docs/en/statusline
- [S2] Z.ai GLM Coding Plan: 5-hour and weekly credits per plan, reset rules, credit formula, multipliers, off-peak rate, peak hours. https://docs.z.ai/devpack/overview ; plan update notice: https://docs.z.ai/devpack/notice/usage-revision
- [S3] Z.ai usage query plugin (docs). https://docs.z.ai/devpack/extension/usage-query-plugin
- [S4] Z.ai plugin source (Apache-2.0): the quota, model-usage and tool-usage endpoints and the `Authorization` header. https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs
- [S5] Z.ai chat completion: `usage.prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, `total_tokens`. https://docs.z.ai/api-reference/llm/chat-completion
- [S6] Cursor Admin API: spend, daily usage and usage events, Basic auth, `chargedCents`. https://cursor.com/docs/account/teams/admin-api
- [S7] Cursor APIs overview: availability, key types, rate limits, polling guidance. https://cursor.com/docs/api
- [S8] Cursor CLI changelog: `/usage` (v2026.07.13), custom status line (v2026.06.09), per-turn token totals in `stream-json`. https://cursor.com/docs/cli/changelog
- [S9] Cursor forum, custom status line payload (CLI 2026.07.20, staff reply 2026-07-27): context window and `autorun`. https://forum.cursor.com/t/cursor-cli-custom-statusline-replaces-native-footer-and-cannot-preserve-auto-review-state/166364
- [S10] Z.ai Terms of Use, prohibited conduct (b). https://docs.z.ai/legal-agreement/terms-of-use
- [S11] Cursor Terms of Service §1.5, updated 2026-09-03. https://cursor.com/terms-of-service
- [S12] Z.ai usage policy: plan benefits limited to supported tools; the subscription page as the user's view. https://docs.z.ai/devpack/usage-policy
