# Codex: connect an account, run lanes on it, see its usage

Codex runs in Morndo as it is: the official CLI, signed in with its own login, on the node you choose (ADR-0028).

## 1. Sign in on the node

1. In ChatGPT's security settings, turn on device code sign-in (a workspace admin turns it on for a workspace).
2. On the node, in any terminal (over SSH works): `codex login --device-auth`. Open the address it prints on your phone or laptop and enter the code.
3. Check: `codex login status` prints `Logged in using ChatGPT` and exits 0.

The login stays in `CODEX_HOME` (default `~/.codex`) as a file. Morndo never reads it. A keyring login (`cli_auth_credentials_store = "keyring"` or `"auto"`) is refused, since Morndo runs Codex with a home of its own.

## 2. Register it as a Connection

```sh
morndo-keys add codex --vendor codex --runtime codex --subscription true
morndo-keys ack codex --by you@example.com
morndo-keys list
```

Add `--config-dir <dir>` when the login lives in another `CODEX_HOME`.

## 3. Lanes on Codex

A node starts lanes on an engine through its policy's `engines` (ADR-0027). Give Codex a launch command beside the others, for example:

```json
{ "engines": { "cli": "/opt/engines/bin/engines", "launch": {
  "codex": { "command": ["/opt/engines/bin/engine-lane", "--engine", "codex", "--model", "{model}", "--effort", "{effort}", "--window", "{lane}"], "via": "shell" } } } }
```

- The engine lane runs each brief as one `codex exec --json` turn and resumes the same session for the next one.
- Turns run with full access and never ask for approval, as Claude Code lanes do. Start Codex lanes in a Git repository: Codex refuses to run outside one.
- The engine layer's resolver runs with the node agent's `PATH`. Put `codex` on it (a link in `~/.local/bin` is enough), or a start by role skips Codex as not installed.
- An API key in the environment would win over the sign-in. The engine lane drops `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` and `OPENAI_API_KEY` from its turns.

Start one: `morndo lanes start codex-a --cwd <repo> --engine codex:gpt-6-astra@high --reason "<why>" --prompt "<brief>"`.

## 4. Usage on Home

`morndo-keys usage --connection codex` prints the account's windows as one line of status-line JSON (see [`usage.md`](usage.md)):

```json
{"session_id":"codex-limits","model":{"display_name":"Codex (plus)"},"rate_limits":{"five_hour":{"used_percentage":42,"resets_at":1893456000},"seven_day":{"used_percentage":17,"resets_at":1893888000}}}
```

- A 5-hour and a weekly window become Home's two windows. Any other windows are shown by name.
- When the windows can't be read (signed out, an API-key login, an app server that doesn't answer in 15 s), it prints nothing and says why on stderr.

Post it every 15 minutes under a worker token, from a timer on the node:

```sh
morndo-keys usage --connection codex | curl -sS -m 10 -o /dev/null -X POST "$MORNDO_HUB/api/agent/usage" \
  -H "Authorization: Bearer $MORNDO_AGENT_TOKEN" -H "X-Morndo-Lane: usage-collector" \
  -H "X-Morndo-Account: codex" -H 'Content-Type: application/json' --data-binary @-
```

## 5. Add another Codex account

A second account (`codex-b`) gets a sign-in home of its own, so the logins never touch. The login you made in section 1 (`~/.codex`) stays your own and outside the pool. Follow the steps in order.

1. **Turn on device code sign-in** in that account's ChatGPT security settings (a workspace admin does it for a workspace).
2. **Make its home.** The directory must exist before Codex uses it, and only you may read it:

   ```sh
   mkdir -p -m 700 ~/.codex-accounts/codex-b
   printf 'cli_auth_credentials_store = "file"\n' > ~/.codex-accounts/codex-b/config.toml
   ```

3. **Sign in to that home**, once:

   ```sh
   CODEX_HOME=~/.codex-accounts/codex-b codex login --device-auth
   ```

   Open the address it prints on your phone or laptop and enter the code. Check: `CODEX_HOME=~/.codex-accounts/codex-b codex login status` prints `Logged in using ChatGPT`.
4. **Register it and add it to the pool:**

   ```sh
   morndo-keys add codex-b --vendor codex --runtime codex --subscription true --config-dir "$HOME/.codex-accounts/codex-b"
   morndo-keys ack codex-b --by you@example.com
   morndo-keys pool add codex-b
   ```

5. **See it:** read its windows once, then list the pool.

   ```sh
   morndo-keys pool read --runtime codex --member codex-b
   morndo-keys pool list --runtime codex
   ```

   `pool list` shows `codex-b` with its state (`ok`, `low`, `out`, `logged-out` or `retired`) and how much of its short and long window is left. `pool read --runtime codex --all` reads every member. The collector in section 4 can post each member's windows to Home with `pool read --runtime codex --member codex-b --report`.
6. **Optional: use it for some work.** Give the pool a default account, or pin a lane to one when it starts (section 6). Pinning a lane needs the node's launch entry to pass the lane's `{account}` on to the pool (ADR-0027's placeholder; a node setup step, not part of the repository):

   ```sh
   morndo-keys pool set defaultMember codex-b
   morndo lanes start research-1 --cwd <repo> --engine codex:gpt-6.1-sol@medium --reason "<why>" --account codex-b --prompt "<brief>"
   ```

To remove one: `morndo-keys pool remove codex-b` takes it out of the pool and ends its placements. Its Connection stays; `morndo-keys revoke codex-b` removes that too. The home and its login stay on disk until you delete the directory yourself.

**Warning: never sign in again to a home while a turn is using it.** `codex login` first revokes the refresh token the home already holds, so a running turn on that account loses its login. To sign an account in again, run `morndo-keys pool retire codex-b`, wait for its turn to end, sign in, then `morndo-keys pool activate codex-b`.

## 6. Several accounts: the pool

The pool is a list of Codex accounts that lanes on this node share (ADR-0029). It decides one thing: which account the next turn of a session runs on.

- **One turn at a time per account.** A second lane on a busy account waits (up to 30 minutes, or `MORNDO_POOL_WAIT_MS`), then is told the account is busy. Two accounts give two turns at once.
- **One writer per session.** A session never runs on two accounts at once; a second turn on it is refused with the holder's pid.
- **Usage without a task.** `pool read` asks the CLI's app server for the account's windows, its plan and its reset credits. It starts no model request, and it skips an account that has a turn running.

### Pinned (the default) or rotate

- **Pinned:** a session runs on the account it was pinned to, or on `pool set defaultMember`, and never changes account because of a limit. At the limit, the turn fails as a usage limit; the lane waits, or the engine layer takes the next provider in the role's chain.
- **Rotate:** new sessions go to the account whose quota expires first, and a turn cut off by a limit goes on as the same session on the next account. It is off until you turn it on:

  ```sh
  morndo-keys pool mode rotate --runtime codex --by you@example.com
  ```

  The command prints the terms line first. OpenAI's terms say users may not engage in "circumventing any rate limits or restrictions" (EU Terms of Use, "What you cannot do"; https://openai.com/policies/eu-terms-of-use/, snapshot 2026-10-11), and moving a lane to a second account because the first is full does that in plain words. No document mentions rotating between your own paid accounts. Whether it is allowed is your call, not the tool's.

To split work by account while pinned, pin by role when the lane starts: for example `--account codex-a` for review and validate lanes, and `--account codex-b` for plan and research lanes.

### Reset credits

Some plans carry banked rate-limit resets. Nothing spends one automatically. `morndo-keys pool advice --runtime codex` says when one would pay off (every account is blocked, work waits, and the first comes back four or more hours away; or a credit lapses within 72 hours). `--notify` posts it once a day when `MORNDO_POOL_NOTIFY_URL` is set. Spending one is your command:

```sh
morndo-keys pool reset --runtime codex --member codex-b --by you@example.com --yes
```

### Which model for which job

From OpenAI's model guidance (https://learn.chatgpt.com/docs/models and /model-selection, read 2026-10-15). These are proposals for the engine layer's chains, not changes to them:

| Role | Entry | Why |
|---|---|---|
| implement-* | `codex:gpt-6.1-sol@medium` | The workhorse, at the effort they name for complex technical work. |
| plan, review, validate | `codex:gpt-6.1-sol@high` | Depth matters; Astra spends a Plus 5-hour window in 5 to 45 messages. |
| research, long documents | `codex:gpt-6.1-sol@medium` | |
| small chores, fix-ups | `codex:gpt-6-luna@high` | "Start with High for Luna"; 350 to 3,000 messages per 5 hours. |
| hard design, by name only | `codex:gpt-6-astra@low` | "Light for Astra" (read as `low`: an inference). |
| never unattended | `max`, `ultra` | "Most tasks do not need Max or Ultra", and `ultra` delegates to sub-agents. |

## Terms

OpenAI recommends API keys for automation, and its CI guide warns against using a ChatGPT login for public or open-source repositories (https://learn.chatgpt.com/docs/non-interactive-mode, read 2026-10-15). Read your plan's terms before you run lanes on it.
