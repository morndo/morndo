# ADR-0024: Usage from vendors other than the agent CLI's status line

- **Status:** Proposed, 2026-10-11. Design: [`docs/design/usage-providers/README.md`](../design/usage-providers/README.md). Design only; no product code.
- **The request:** one place for usage. Home (ADR-0016) shows the Claude accounts; the plans of other vendors, a GLM Coding Plan on Z.ai and Cursor, should sit next to them.
- **Number:** 0019 to 0023 are taken on branches not yet on `main`.
- **Builds on:** ADR-0001 (anti-corruption adapters, no pooled logins), ADR-0012 (FL14: no credential crosses the fleet), ADR-0015 (agent tokens), ADR-0016 (Usage, U1 to U4), ADR-0018 (Connections, the Vault, vendors as data).
- **Sources:** [S1] to [S12] in the design, section 7, all read 2026-10-11.

## Context

1. **Usage has one source today.** Claude Code hands its status line `rate_limits.five_hour` and `seven_day` for Claude.ai subscribers [S1]; the status line posts that JSON to the hub (ADR-0016). Other vendors' plans never reach Home.
2. **Z.ai's GLM Coding Plan has two credit windows,** 5 hours and weekly, with credits used out of a total and a reset time [S2]. Its API reference has no usage endpoint. Z.ai's own `glm-plan-usage` plugin, linked from its docs, reads the quota with the plan key from an endpoint on the API host [S3, S4]. The answer's shape changed after the plugin was written: the plugin parses an older shape. Responses carry token counts, not credits [S5]; credits follow a published formula with per-model multipliers and an off-peak discount [S2].
3. **Cursor documents usage for teams only.** The Admin API (`/teams/spend`, `/teams/daily-usage-data`, `/teams/filtered-usage-events`) takes a team admin key, allows 20 requests a minute (60 for usage events) and asks for hourly polling [S6, S7]. A personal plan has no usage API: the dashboard and the CLI's interactive `/usage` show it [S8]. The CLI's status line and `stream-json` output carry per-turn tokens, not plan meters [S8, S9].
4. **The vendors' terms draw the line.** Z.ai forbids automated means that obtain unauthorized data [S10]; Cursor forbids harvesting, scraping or extracting data from the service, and reverse engineering it [S11]. A dashboard's web calls under a browser session, or a CLI's sign-in token against undocumented endpoints, cross that line.
5. **A plan key is a Secret.** The Z.ai plan key and a Cursor admin key are vendor credentials. ADR-0018 keeps such keys sealed on their node; FL14 keeps them off the fleet.

## Decision

1. **A usage source is a port, polled on the node that holds its credential.** `UsageSource.read(now)` returns a Reading (windows, each with a percentage, a reset, and optional amounts) or Unavailable with a reason. A node agent runs each registered source on the preset's interval and posts the Reading to the hub under its agent token. Only figures cross the fleet; the hub never holds a vendor credential (U7).
2. **Adapters, one per vendor path:**
   - `usage-zai-quota`: the quota endpoint Z.ai's plugin calls, with the plan key from the Vault. Every 15 minutes.
   - `usage-cursor-admin`: `/teams/spend` and `/teams/filtered-usage-events` with a team admin key from the Vault. Hourly, honouring `Retry-After` on 429.
   - `usage-token-count`: the fallback. Counts tokens from Morndo's own run records (Lease results, the runtime's `stream-json` or transcript) and prices them with the preset's dated multipliers. Its windows are estimates (U6).
   - The status-line route (ADR-0016) stays as it is: it is the Claude Code source.
3. **Each preset states its usage path and how sanctioned it is.** The vendor catalog (ADR-0018 §5) gains a `usage` entry: the adapter, the interval, the windows it yields, and a standing: `documented` (in the vendor's API reference), `vendor-published` (the vendor's own tool calls it; parsed defensively; an unknown shape posts nothing and raises an Alert), or `none` (no sanctioned path: estimates from `usage-token-count`, or nothing). Z.ai is `vendor-published`; Cursor is `documented` for teams and `none` for personal plans.
4. **Never:** a browser session or cookie, a CLI's sign-in token sent anywhere but the CLI's own use, the dashboard's web calls, or reading a terminal's screen. An architecture test fails if a usage adapter reads a cookie store or an agent CLI's credential directory, or calls a host outside its preset.
5. **The Usage model grows, its rules stay.** A window may carry an amount (used, limit, unit: credits, USD, requests) and a provenance (`reported` by the CLI or the vendor, or `estimated`). The windows stay the three ADR-0016 has: 5-hour, weekly, spend. An account may name its plan (vendor and label). U1 to U4 hold; U5 to U8 are new (design section 3). A Reading creates no session: sessions stay the status line's.
6. **The wire:** `POST /api/agent/usage/readings` takes Morndo's own typed Reading under an agent token. The status-line route keeps taking the CLI's raw JSON.
7. **Home shows** the vendor and plan on each account card, the amounts beside each meter ("6,648 of 12,000 credits"), "estimated" in words where it applies, and "as of" once a Reading is older than twice its interval.

## Alternatives

| Option | Verdict |
|---|---|
| **The dashboard's own web calls**, with the user's browser session | Rejected. Against Cursor's terms [S11], outside Z.ai's authorized data [S10], tied to a login, and broken by any front-end change. |
| **The CLI's sign-in token against the vendor's internal endpoints** | Rejected. Reverse engineering [S11], and a credential used beyond its purpose (ADR-0001). |
| **Drive the CLI's interactive `/usage` and read the screen** | Not now. Brittle, and close to extraction. Revisit if the vendor adds a non-interactive form. |
| **Estimates only, for every vendor** | Rejected as the default. Plan windows follow vendor rules Morndo can't see exactly (peak multipliers, rolling refresh, promotions) [S2]. Estimates fill only where no vendor figure exists, labelled. |
| **Map a provider's figures into the status-line JSON** | Rejected as the design; usable as a bridge on one machine. It drops the amounts, invents a session, and makes a vendor figure look like a CLI report. |
| **The hub polls the vendors itself** | Rejected. The hub would hold vendor keys, against FL14 and ADR-0018's custody. |

## Consequences

- **Good:** one look covers every plan the agents run on, with the vendor's own figures where the vendor gives them.
- **Cost:** a usage entry per preset, two adapters, a source runner in the node agent, a typed route, and amounts on Home's meters.
- **Limit:** a `vendor-published` path can change without notice; Morndo shows "unavailable" rather than a guess. A personal Cursor plan gets estimates or nothing until Cursor documents a personal usage API.
- **Not here:** usage history, alerts on windows (Usage still decides nothing, U4), and routing on usage (ADR-0018's Priority ignores it).
