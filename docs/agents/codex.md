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

Post it every 5 minutes under a worker token, from a timer on the node. A session counts as reporting for 10 minutes after its last report (U3), so a shorter interval keeps the account's card from flickering to "No session reporting right now". The recipe posts only when the read worked, so a signed-out account sends nothing, and `curl -f` makes a refused post a failure the timer can show:

```sh
report=$(morndo-keys usage --connection codex) || exit 1
printf '%s' "$report" | curl -fsS -m 10 -o /dev/null -X POST "$MORNDO_HUB/api/agent/usage" \
  -H "Authorization: Bearer $MORNDO_AGENT_TOKEN" -H "X-Morndo-Lane: usage-collector" \
  -H "X-Morndo-Account: codex" -H 'Content-Type: application/json' --data-binary @-
```

`morndo-keys usage` says why on stderr when the read failed, and `exit 1` makes the timer unit show as failed, so a signed-out account is noticed rather than hidden.

## 5. Add another Codex account

A second account (`codex-b`) gets a sign-in home of its own, so the two logins never touch. Follow the steps in order; nothing here needs help.

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
4. **Register it:**

   ```sh
   morndo-keys add codex-b --vendor codex --runtime codex --subscription true --config-dir "$HOME/.codex-accounts/codex-b"
   morndo-keys ack codex-b --by you@example.com
   ```

5. **See it:** `morndo-keys list` shows `codex-b` with status `on`, and `morndo-keys usage --connection codex-b` prints its windows.

Here a second account is its own Connection with its own windows on Home. Pinning roles or lanes to one account of several comes with the account pool, which has its own guide when it ships.

To remove one: `morndo-keys revoke codex-b`. The Connection is marked revoked and Morndo stops using it; the home and its login stay on disk until you delete the directory yourself.

**Warning: never sign in again to a home while a turn is using it.** `codex login` first revokes the refresh token the home already holds, so a running turn on that account loses its login mid-way. Wait for the turn to end (stop the lane), then sign in.

## Terms

OpenAI recommends API keys for automation, and its CI guide warns against using a ChatGPT login for public or open-source repositories (https://learn.chatgpt.com/docs/non-interactive-mode, read 2026-10-15). Read your plan's terms before you run lanes on it.
