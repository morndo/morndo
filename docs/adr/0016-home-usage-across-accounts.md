# ADR-0016: Home, and usage across every connected account

- **Status:** Accepted, 2026-10-09. The owner asked for it; built on `claude/funny-fermi-27rrm7`.
- **Builds on:** ADR-0006 (the desktop), ADR-0013 (the engines' availability stays the engine layer's), ADR-0015 (agent tokens, the agents' routes).
- **Rules:** U1 to U4 in `docs/domain.md`.

## Context

The requirement: Home shows usage across every connected account. The first version is that view only.

The accounts are the agent CLI's: each lane runs on one (`claude-as <account>` on the owner's box, each with its own config directory). Their usage is known to the CLI alone, and it tells it in one documented place: the status line's JSON, which carries `rate_limits.five_hour` and `rate_limits.seven_day` (percentage used, reset time) for Pro and Max subscribers after a session's first reply, a `spend_limit` behind a gateway, and the session's `context_window.used_percentage` (https://code.claude.com/docs/en/statusline, read 2026-10-09). On the owner's box the status line already posts that JSON to his chat bot. The hub had no idea of accounts.

## Decision

1. **A Usage context, a read model** (`packages/domain/src/usage.ts`). Per account: the three windows as last reported and the sessions reporting in the last 10 minutes, each with its lane, model and context used. The newest report sets the windows; a window a report lacks is kept until its reset passes, as the CLI drops it then (U2); an older report, which happens when several sessions of one account post, never moves them. Usage decides nothing (U4): engine availability stays ADR-0013's.
2. **Reports come through the agents' door** (ADR-0015): `POST /api/agent/usage` under an agent token, the raw status-line JSON as the body (the hub reads only the fields above and drops the rest), the account named by `X-Morndo-Account` (none: `default`), the lane as the token acts. Three lines in the status-line script, in `docs/agents/usage.md`. No new credential, no new channel.
3. **The hub keeps the latest state per account** (`usage_accounts`, migration 14), so Home is as it was after a restart, and pushes every account to every feed after a hello and whenever a report changed what is shown (`usage` frame). Status lines report after every turn of every session, so a report that changes nothing shown tells nobody.
4. **Home is the desktop's landing tab** (`apps/web/src/lib/desktop/HomeView.svelte`): the rail's first tab, where the desktop opens. The chats move to a tab of their own, Chats. On Home, for now, one section: usage across accounts. A KPI row (accounts, sessions reporting, the account nearest its 5-hour and its weekly limit), a notice when any is running low or nearly out, and a card per account with a meter per window (the fill carries the level; the percentage, the level in words and an icon stand beside it, never colour alone), when it resets, its spend where a gateway sets one, and its sessions, each opening its lane's chat.

   An account may instead name the windows it has (`limits`: a label, a percentage, a reset). Home then shows those bars instead of the 5-hour and weekly rows, and still shows spend and the sessions. An empty list is not that mode. A bad row is dropped, and the domain, not the hub, decides the label and how many windows stay. The notice counts the named windows and that spend meter; the 5-hour and weekly tiles count only the rows the cards show. A report that omits `limits` is the status line above, and an old account frame still parses (`limits` and `onDemand` default to absent). The fields are optional on the wire (ADR-0016, 2026-10-11).

### Where things live

| Piece | Where |
|---|---|
| U1 to U4: the report, the account, the merge, the levels, the tightest account | `packages/domain/src/usage.ts` |
| The wire: the status-line body, the account, the `usage` frame | `packages/protocol/src/usage.ts` |
| The adapter over the status-line JSON, the service | `apps/hub/src/application/usage-service.ts` |
| `POST /api/agent/usage`, `GET /api/usage`, the frame | `apps/hub/src/adapters/http.ts` |
| Home, the words, the meters | `apps/web/src/lib/desktop/HomeView.svelte`, `usage.ts` |
| The checks | `packages/domain/test/usage.test.ts`, `apps/hub/test/usage.test.ts`, `e2e/home.e2e.ts` |

## Alternatives

| Option | Verdict |
|---|---|
| **The hub reads the accounts' files** (`~/.claude-accounts/<name>/…`) | Rejected. Nothing there says the usage; the CLI computes it from its API responses and tells only the status line. And the files are the account's credentials' neighbours, which the hub never opens (file rules). |
| **The fleet's hook bus** (the status line already reaches the node agent as a `/sl` progress event) | Not now. The hub is not a subscriber of the bus, and the account's name isn't in that JSON either: the script would still have to add it. The agents' route works from every node today; a bus subscription can replace it later without changing the domain. |
| **A usage history and charts** | Not now ("for now only the usage"). The latest state per account is what the owner asked for; samples for a trend are a later step on the same route. |
| **Levels by colour alone** | Rejected (brand COLOR.md, the chart rules): the percentage and the level in words stand beside every meter. |

## Consequences

- **Good:** one look says which account is close to a limit and which lanes are on it, with no question to the manager.
- **Cost:** three lines in each account's status-line script and `MORNDO_ACCOUNT` in each lane's environment, on top of ADR-0015's token. `morndo setup` (sub-project 3) should install them.
- **Limit:** a report says what the CLI says; the hub can't check it, and an account whose lanes are all quiet shows its last figures until a window resets.
- **Not here:** the phone, a history, and anything else on Home. The tab is built to take more sections.
