# Usage, for the agents: what each account has spent

Home on the desktop (ADR-0016) shows how much of every connected account's rate-limit windows is used. The figures
come from the agent CLI itself: Claude Code hands its status line a JSON document after every turn, with
`rate_limits.five_hour` and `rate_limits.seven_day` (`used_percentage`, `resets_at`) for the account the session runs
on, and `context_window.used_percentage` for the session
(https://code.claude.com/docs/en/statusline, read 2026-10-09). Morndo takes that document as it is, under the lane's
agent token, and keeps the latest per account.

## Setup

1. **A worker token** (`morndo agent-token new lanes --role worker`), in every lane's environment as
   `MORNDO_AGENT_TOKEN`, with `MORNDO_HUB` (the hub's address). The same ones the board uses
   ([`board.md`](board.md)).
2. **The account's name,** in the lane's environment as `MORNDO_ACCOUNT`: whatever you call that account
   (`max-1`, `alice@…`, letters, digits, `. _ @ -`). Lanes without it report under `default`.
3. **Three lines in the status line script** (`~/.claude/statusline.sh`, or the account's own), after whatever it
   prints. The JSON on stdin goes to the hub as it is; the hub reads only the fields named above:
   ```sh
   input=$(cat)
   printf '%s' "$input" | curl -sS -m 3 -o /dev/null -X POST "$MORNDO_HUB/api/agent/usage" \
     -H "Authorization: Bearer $MORNDO_AGENT_TOKEN" -H "X-Morndo-Lane: ${MORNDO_LANE:-$(tmux display-message -p '#W' 2>/dev/null)}" \
     -H "X-Morndo-Account: ${MORNDO_ACCOUNT:-default}" -H 'Content-Type: application/json' --data-binary @- &
   ```
   The `&` keeps the status line fast: the post runs on its own and the script's output is already printed. `-m 3`
   gives up on a hub that doesn't answer, silently.

A lane's first report carries no windows: Claude Code adds `rate_limits` after the session's first reply, for Pro and
Max subscribers (or behind a gateway with a spend limit). Until then the account's card says "not reported" for each
window, and a report without a window never clears one reported before (U2).

Codex has no status line. Its windows come from `morndo-keys usage --connection <name>`, posted the same way; see [`codex.md`](codex.md).

With a pool, each member posts its own windows: see [`codex.md`](codex.md) §5.

## What Home shows

- **At a glance:** how many accounts and sessions report, and the account nearest its 5-hour and its weekly limit.
- **Per account:** a meter per window with the percentage used in words, its level (fine from 0, running low from
  75%, nearly out from 90%), when it resets, the spend limit where a gateway sets one, and the sessions reporting in
  the last 10 minutes with the lane, the model and the context used. A session opens its lane's chat.

Usage decides nothing (U4): which engine runs is the engine layer's (ADR-0013), and a lane that hits its limit says so
itself in its conversation. Home only shows what the accounts reported.

## A lane's failure and its account

When a turn fails, the failure hook posts its JSON to the node relay as it does today; it SHOULD add the account the
session runs on as `"account": "$MORNDO_ACCOUNT"` (a pool-style hook may send the config directory's name instead).
The fleet turns a failure whose error word is a limit (`rate_limit`, `billing_error`, `authentication_failed`,
`account_on_hold`, `oauth_org_not_allowed`) into a usage tap and hands it to the hub, which resolves the account in
this order:

1. the hook's own `account` field, when it is a valid account name **and** an account the hub already knows of that is
   run on the node the failure came from (a word naming an unknown account is dropped, and nothing is ever created by
   a failure);
2. the lane's last record — written when a lane is started with an account, and by each status-line report — if it is
   at most seven days old; a record written at the lane's start outranks one written by a report for twelve hours, so
   a lane started with an account keeps it against a self-declared header;
3. the session the failure's `session_id` names, while that session is fresh;
4. the node's only account, when every record and session on that node names the same one.

A failure that resolves to no account is kept as nothing: no seat changes (U9). A failure older than five minutes is a
replayed event and marks nothing.

A lane's record is bound to the worker token that reported for it (the tokens are trusted to report, R3). Another
token reporting the same account for the lane only refreshes the record's stamp, but two tokens reporting different
accounts for one lane make its record ambiguous for an hour: a failure of that lane then marks nothing unless its hook
word names an account this node runs. Giving each lane — or each node — its own worker token is what makes that
protection bite.

An account first heard of through a hub-issued `lane.start` is the principal's own act, so its account is known from
that moment: it appears on Home as soon as a failure names it, and Forget (the principal's) removes it — the account,
its seat and its lane records together, so a later failure of one of its lanes marks nothing until a start or a report
names the account again.

## Pool seats

The accounts pool can set a seat by hand, with a token that carries the `usage-pool` scope:

```sh
morndo agent-token new pool --role worker --scope usage-pool
```

That token posts to `POST /api/agent/usage/pool`:

```json
{ "account": "max-1", "action": "set", "state": "retired", "why": "refused", "by": "pool-bot", "at": 1760000000 }
```

`state` is one of `logged-out`, `retired`, `out`, `low`, `ok`; `why` one of `usage_limit`, `refused`, `signed_out`,
`plan_ended`, `billing`, `by_hand`; `action: "cleared"` removes the pool's word again. A pool-set seat is sticky: no
reading clears it, and it wins over the hub's own derived mark when both name the same state. The principal clears
either owner's seat with `POST /api/usage/seat/clear` (`{ "account": "max-1", "owner": "pool" | "derived" }`, no
`owner` for both).

A limit post (`POST /api/agent/usage/limit`) is for a manager token or a token with the `usage-pool` scope; it always
speaks for the hub's own derived seat, never the pool's. Until the headless reader arrives, a derived mark ends when
the plan or account changes, when the principal clears it, or when it expires: an out mark is dropped six hours after
the later of its back time and the cycle's own reset (the cycle the limit hit is the clock, so a weekly window that
resets days later is not shown as fine while it still reads 100%), with no newer hit to push either out. A retired or
logged-out derived mark never expires by time: it ends by a leased read, a plan or account change, or the principal.
