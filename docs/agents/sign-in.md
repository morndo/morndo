# Signing an account in, or adding one (ADR-0039)

Agents never sign an account in themselves and never see a sign-in link or code. When an account is signed out, or the
work needs one more, ask the principal with a card; he signs it in from the app in about a minute.

## Ask for a card

```sh
curl -sS -X POST "$MORNDO_HUB/api/agent/signins/request" \
  -H "Authorization: Bearer $MORNDO_AGENT_TOKEN" -H "X-Morndo-Lane: $MORNDO_LANE" -H "Content-Type: application/json" \
  -d '{"node":"n1","runtime":"claude","account":"a9","create":true,"why":"one Claude account left with weekly room"}'
```

- `runtime`: `claude` or `cursor`. Cursor signs in its `main` login only.
- `account`: `main` (the CLI's default login) or a name of lowercase letters, digits, `-` or `_` (at most 31 characters),
  the pool's own rule. For Claude a named account lives in `~/.claude-accounts/<name>` on that node.
- `create: true` adds a new account; leave it out to sign an existing one in again.
- `why`: one sentence the principal reads on the card.

The answer is `{"card":"signin-<node>-<runtime>-<account>"}`. Asking again for the same account keeps one card. The card
goes by itself once the account works; the hub's own sweep also raises cards for signed-out accounts in rotation every
10 minutes, so there is no need to ask for those.

## What the principal does

He taps Sign in (a passkey check), opens the sign-in page, approves, and for Claude pastes the code the page shows into
the card. The code is sealed in his browser to that one sign-in's key; only the node's runner can open it. The card ends
"Works again: signed in as …".

## What stays where

- The login stays in the CLI's own folder on the node (0700 folder, 0600 login file). Morndo never copies it.
- No code, link or key goes into the board, the ledger, a transcript or a log. Don't paste one into a chat.
