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

## Reading Claude usage (headless)

Besides the status line, an account's whole window set — including windows a status line never names, such as a
model-scoped weekly limit — can be read the documented way: the unmodified Claude CLI's own headless `/usage`, run by
the `morndo-usage-claude` collector. Nothing else is ever read: not the OAuth usage endpoint, not a token, not a
credentials file, no web dashboard. The collector spawns

```sh
claude -p /usage --tools "" --output-format stream-json --verbose --no-session-persistence
```

under the account's own config directory (`CLAUDE_CONFIG_DIR`), with every token variable (`CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`) removed from the child's environment, and parses the report out of its
stdout. The read can take minutes on a loaded machine; the whole process group is killed after 180 s.

**The account needs its FULL login on that machine.** A long-lived `setup-token` login has no usage scope: the read
answers `no_scope` — "sign in fully here" — never 0%. Another machine that holds the full login may read the same
account: the hub keys readings by account and node and never copies a token, so one machine can be the reader for an
account whose sessions run elsewhere.

The collector reads `~/.config/morndo/usage-claude.json` (path from `MORNDO_USAGE_CLAUDE_CONFIG`):

```json
{
  "hub": "http://127.0.0.1:8787",
  "tokenFile": "/etc/morndo/usage-claude.token",
  "node": "pc",
  "accounts": {
    "seat-a": { "configDir": "/path/to/seat-a-config-dir" },
    "codex-a": { "kind": "codex", "codexHome": "/path/to/codex-home" }
  }
}
```

`node` is the machine's own name; `tokenFile` holds the collector's own agent token, read from the file and never
printed. The lease route answers a manager token or a worker token with the `usage-pool` scope (the limit route's
rule), so the collector's token must carry that scope:

```sh
morndo agent-token new <name> --role worker --scope usage-pool
```

A systemd user unit runs the collector in the background:

```ini
# ~/.config/systemd/user/morndo-usage-claude.service
[Unit]
Description=Morndo Claude usage collector
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/morndo/apps/connections/src/adapters/usage-claude-main.ts
Environment=MORNDO_USAGE_CLAUDE_CONFIG=%h/.config/morndo/usage-claude.json
Restart=on-failure

[Install]
WantedBy=default.target
```

**It reads on demand, never on a timer.** Every 30 s the collector asks the hub — never the provider — for a lease
(`POST /api/agent/usage/lease`), and only a granted lease spawns a read. The hub grants one only when somebody is
looking (a feed hello — the principal opened Home — or the look route) and the account's own word is old, when a
derived out mark's back time passed and a confirming read is due, or for an account the hub has never heard of —
wanted once per name, and at most five new unknown names an hour per token. A lease belongs to the token that took
it: only that token's reading completes it. With a grant in hand: at most one read per account
per 4 minutes across all machines, one live lease per account and source across all nodes, and at most two live
leases on the whole hub. A failure cools the account down on every machine at once — the provider's own retry word
when it gave one (never shorter than a minute), else 5 minutes, doubling on consecutive failures to half an hour,
reset by a good reading.

**Known limits of the token model (said plainly).** The hub has no node configuration, so it cannot tell which
accounts a node really reads. (1) The unknown-name budget is five new names per token per hour, not per node: a pool
token that holds both lease slots can still spend its budget on invented names five times an hour. (2) Any token
may post an *unleased* reading for any account. Such a reading cannot end a mark and cannot set the cache (only a
lease does either), but it does change the windows Home shows and the thresholds that watch them. Worker tokens are
shared by lanes, so the token binding only detects a second, different token. The fix is per-lane worker tokens and
leases bound to the accounts a node actually reports; it is the follow-up T-430 on the board, not part of this change.

## Reading Codex usage

The same collector reads a Codex subscription: an account entry with `"kind": "codex"` and `"codexHome"` (its
`CODEX_HOME` directory) in the same config, and optionally `"codexBin"` when the `codex` on `PATH` is not the one to
run (`MORNDO_CODEX_BIN` overrides it for a machine). It reads the app server's own `account/rateLimits/read` — the
CLI's experimental JSON-RPC interface, `codex app-server` on stdio — and nothing else: never a token, never a
credentials file. The reading carries the plan, every window the answer names (the 5-hour and weekly pair, and any
other limit's windows under their limit's own name), and a digest of the account id — never the id itself.

A codex account runs under the same lease as a claude one (source `app-server`): only a granted lease spawns a read,
and the reading or the failure carries the lease id. How often it reads adapts to how full the fullest window is:
every 15 minutes while it idles below 75%, every 5 from 75%, every 2 from 90%, once a minute from 99% — never faster
than once a minute. The hub, not the collector, holds that rhythm through its lease.

Two things only a leased reading may say. The identity digest feeds the plan watch, and only on a leased reading (an
unleased reading's identity is ignored, so no token can tell a change or poison the baseline): a changed identity
between two agreeing readings is an account change ("the account behind it changed"), told once, and it drops a
derived seat mark as a plan change does. And Codex's own limit flags — `ordinary_usage_allowed` false, or any `rate_limit_reached_type`
— mark the seat out at the soonest reset of a window at 100%; flags that say all is well end a derived mark again. A
reading without a valid lease never marks and never clears from its flags, and the type string itself is never shown
and never stored.

Window identity is explicit. A reading's primary pair is the account's `five_hour` and `seven_day` windows; another
limit's windows (a second limit under its own name) keep their own ids even at the same length, and are shown as named
windows under "Other limits" — they never replace the main pair. A window nobody named explicitly is still read by its
length (300 minutes is the 5-hour window, 10080 the weekly one), and of several such windows of one length the first
is the main one. One edge: a reading that carries only another limit's windows and no primary pair would have the
first of them read by length as the main window.

Two accounts on one machine are told apart by their own directory (`codexHome` here, `configDir` for a claude
account), so the collector refuses a config in which two names resolve to the same directory: it reads nothing and
says which two. It also has no node-wide lock or semaphore for a codex read as the claude read does; a codex read is
bounded by its 15-second timeout and the hub's lease cap of two.

The app server also pushes `account/rateLimits/updated` notifications; Morndo maps one to the same reading body (a
push needs no lease — it is nobody's rationed read). The long-lived app-server client that would receive those
pushes is **not built yet**: until it is, Codex is read by the leased poll alone.

## The readings contract

Every source except the status line (which has its own route) posts one body to `POST /api/agent/usage/readings`,
under the account named in the `X-Morndo-Account` header. **Seconds on the wire** everywhere (`captured_at`,
`resets_at`, `retry_after_s`); the hub's own memory works in milliseconds. The body:

```json
{
  "source": "cli-screen", "node": "mac", "captured_at": 1760000000, "every_s": 300,
  "plan": "Super", "identity": "a1b2c3d4e5f6",
  "windows": [
    { "id": "Cursor models", "used_percent": 72, "resets_at": 1760600000, "length_mins": null, "rolling": false, "note": "shared with Grok" }
  ],
  "lease_id": "..."
}
```

- **`source`** — one closed list: `status-line` (never posted here), `claude-usage`, `app-server`, `cli-screen`,
  `vendor-api`. The body's own source says who read it; the hub keys rows by account, source and node.
- **`node`** — the machine that read (≤ 80 characters), so one account can be read on the machine that holds its
  login while its sessions run elsewhere.
- **`captured_at`** — when the source took the reading, never later than the hub's clock plus a five-minute skew. A
  reading older than the newest stamp the source ever gave is a late replay: answered ok, changes nothing.
- **`every_s`** — how often the source may be read; kept between one minute and six hours.
- **`plan`** — the plan's own name (≤ 80). Its words also title a window with no length of its own (see Cursor
  below); a caption the provider printed is never read as a title.
- **`identity`** — a digest of who is behind the account, never an id. It feeds the plan watch: a changed identity
  between two agreeing readings is an account change.
- **`windows`** — each with `id` (≤ 40 characters; 300 minutes is titled `five_hour` and 10080 `seven_day`,
  whatever the source called them), `used_percent` (0..101; outside that is not a reading of that window — dropped,
  never clamped to 0), `resets_at` (epoch seconds or null), `length_mins` (whole minutes when the source knows the
  window's length, else null — never a guess), `rolling`, and `note` (the provider's own words about the window,
  ≤ 40 after cleaning).
- **`ordinary_usage_allowed`, `rate_limit_reached_type`** — the provider's own limit flags (Codex's). They count
  only on a leased reading: flags that say the account cannot use its plan mark the seat; flags that say all is
  well end a derived mark. The type string is never shown and never stored beyond that boolean effect.
- **`lease_id`** — the lease this read consumed, when it had one. A lease belongs to the token that took it.
- **`failure`** — instead of `windows`, when the source cannot read: `{ reason, hint, retry_after_s }` — one closed
  reason (below), a free-text hint cleaned of links and addresses before it is stored, and the provider's own retry
  word in whole seconds when it gave one. A failure keeps the last good reading.

A reading whose windows are all unreadable is a failure the principal sees, not silence. The hub merges what the
sources show across one account, treats a window a source repeats verbatim as last-known data, and forgets a source
that has been silent for two weeks.

## Reason classes

A read fails for exactly one closed-list reason. Transient ones are worth retrying (a source in them stays merely
stale for its grace hour before it is called unavailable); permanent ones are not fixed by waiting. The Fix shown
comes from the domain's closed fix list — a reason with no fix of its own shows none.

| Reason | Class | What it means | Fix |
| --- | --- | --- | --- |
| `unknown_screen` | permanent | its screen was not in a shape Morndo knows | check the source |
| `signed_out` | permanent | it is signed out | sign in again |
| `refused` | permanent | its organization refused it | use another account |
| `no_usage_for_plan` | permanent | this plan has no usage to read | — |
| `plan_ended` | permanent | the plan has ended | reactivate the seat |
| `no_scope` | permanent | this sign-in cannot read usage | sign in fully on this machine |
| `rate_limited` | transient | the provider is limiting reads | — |
| `unreachable` | transient | the provider could not be reached | — |
| `timeout` | transient | the read took too long | — |

## Z.ai

A Z.ai subscription's quota is read by the operator's own collector, which makes the HTTP call and hands the answer
— status, `Retry-After` header and parsed body — to the pure parser in this repository
(`apps/connections/src/adapters/usage-zai.ts`). Driving the HTTP call stays in the operator's collector, outside
this repository: the parser never reaches the network. It accepts the answer's `data.limits` entries (made-up
example):

```json
{
  "code": 0, "success": true,
  "data": { "limits": [
    { "type": "CREDIT_LIMIT", "unit": 3, "number": 5, "percentage": 42, "nextResetTime": 1793460000000 },
    { "type": "CREDIT_LIMIT", "unit": 6, "number": 1, "currentValue": 30, "usage": 200, "nextResetTime": 1793620000000 }
  ] }
}
```

A limit is told by its `unit` and `number` alone — unit 3 is hours (`number` × 60 minutes), unit 6 is weeks
(`number` × 10080) — never by array order: the weekly and the 5-hour entries swap order near the end of a week.
300 minutes becomes the `five_hour` window, 10080 the `seven_day` one, any other length a window named by its
minutes, an unknown unit a window with no length. `CREDIT_LIMIT` is accepted wherever `TOKENS_LIMIT` was, and a
tokens limit with neither unit nor number is the legacy 5-hour window. The used percent is `percentage`, or
`currentValue × 100 / usage` when `usage` is a positive number — out of range or epoch-like is no number, and that
window is dropped and shown as missing, never as 0%. Every Z.ai window is rolling (the credit windows refresh after
use). A missing weekly entry is missing, not a failure. The failure classes, in their order: HTTP 401/403, or a body
carrying `code: 401`, is `signed_out`; a 429 is `rate_limited` with `Retry-After` as whole seconds (an HTTP date is
not supported); `success: false` or a 5xx is `unreachable`; anything else is `unknown_screen`, whose hint is only
the fixed shape `unknown shape <hash>` — never a word of the answer. The ok result maps to a reading with source
`vendor-api`, posted under the readings contract above.

## Cursor

The hub never drives the Cursor CLI. A collector outside the repository reads the screen and posts named windows as
readings with source `cli-screen`, under the readings contract above: `length_mins` when the collector knows the
window's length, a `note` for what the provider said about it (a pool shared with another product carries
`"shared with Grok"`), prepaid credit as a line of its own, and a `failure` with the fixed-shape hint when the
screen is unknown. Which period a Cursor plan is on is the hub's own call, never the caption the poster printed: a
window with a length is titled by it; with none, the gap between two observed resets titles it; with only one reset
seen, the reset horizon does — within 8 days and a weekly-family plan name (`free`, `plus`, `premium`, `super`)
"about weekly", further out "about monthly", and a name on both periods (`ultra`) "plan period" until the second
reset is observed.

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
speaks for the hub's own derived seat, never the pool's. A derived mark ends when a fresh leased read of a new cycle
clears it — the headless reader above is granted exactly that lease once the mark's back time has passed — or when
the plan or account changes, when the principal clears it, or when it expires: an out mark is dropped six hours after
the later of its back time and the cycle's own reset (the cycle the limit hit is the clock, so a weekly window that
resets days later is not shown as fine while it still reads 100%), with no newer hit to push either out. A retired or
logged-out derived mark never expires by time: it ends by a leased read, a plan or account change, or the principal.
