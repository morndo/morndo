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

## What Home shows

- **At a glance:** how many accounts and sessions report, and the account nearest its 5-hour and its weekly limit.
- **Per account:** a meter per window with the percentage used in words, its level (fine from 0, running low from
  75%, nearly out from 90%), when it resets, the spend limit where a gateway sets one, and the sessions reporting in
  the last 10 minutes with the lane, the model and the context used. A session opens its lane's chat.

Usage decides nothing (U4): which engine runs is the engine layer's (ADR-0013), and a lane that hits its limit says so
itself in its conversation. Home only shows what the accounts reported.
