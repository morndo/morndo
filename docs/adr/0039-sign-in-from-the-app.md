# ADR-0039: The principal signs an agent CLI account in, or adds one, from the app

- **Status:** Accepted, 2026-11-02, at the owner's request: sign an account in again from the app, make adding an
  account easy for him and for agents, keep the credentials stored securely, and prove it works with several accounts.
  Built in the pull requests that add this file.
- **Builds on:** ADR-0001 (logins stay the CLI's own), ADR-0012 (FL7, FL14), ADR-0013 (deferred: running the providers'
  sign-in from the page), ADR-0018 (Connections: a subscription is the CLI's own sign-in), ADR-0022 (SR5's fresh passkey,
  the sealed value that may cross the fleet), ADR-0029 (one sign-in home per account, no token copied).
- **Rules:** SI1–SI8 in `docs/domain.md` ("Sign-in"). No migration: the hub keeps sign-ins in memory.

## Context

A signed-out account took a terminal to fix. On the node a person ran `claude auth login` in the account's folder (or
`claude-pool login NAME` over `ssh -t`); for the control plane's tokens the manager made a link, the principal pasted the
code back into a chat, and a script kept the token. Cursor's main login on one node read as signed out three times in a
week before anyone looked. Lanes then ran on fewer accounts or on the wrong engine. The app could show "Signed out: sign
in again", but nothing in it could do that.

Facts that shape the decision, each checked on 2026-11-02 against the CLIs in use:
- `claude auth login` in a terminal without a browser prints the sign-in page's address and waits at "Paste code here if
  prompted"; the page shows a one-time code to paste back. `CLAUDE_CONFIG_DIR` keeps one login per folder
  (https://code.claude.com/docs/en/authentication).
- `agent login` with `NO_OPEN_BROWSER=1` prints the address and finishes by itself once the browser approves
  (https://cursor.com/docs/cli/reference/authentication). Its login lives in `$XDG_CONFIG_HOME/cursor`; the engine layer
  runs only the default one.
- The one-time code is useless without the waiting CLI's own verifier, and it expires in minutes.

## Decision

1. **The node runs the CLI's own sign-in.** Five typed fleet operations (`signin.accounts`, `signin.start`, `signin.code`,
   `signin.status`, `signin.cancel`) reach a runner in the node agent. It starts the CLI's sign-in for one account in a
   hidden tmux server of its own (`-L morndo-signin`), one session per sign-in, and reads only the link (and a device
   code) from the screen. No command line crosses the fleet (FL14): each runtime's command is fixed in the node's recipe.
2. **Accounts.** "main" is the CLI's default home. Any other name is a home of its own: for Claude
   `~/.claude-accounts/<name>`, the folder the pool already uses, created with `claude-pool add` when that tool is there.
   Cursor signs in its main login only. Codex is left for a later change (no node runs it yet).
3. **Logins stay the CLI's own** (ADR-0001, 0018, 0029). Morndo never reads, copies or stores a token; the CLI writes its
   login into the account's home. Before a sign-in the runner sets a named home to 0700; after it, the login file must be
   0600, or the sign-in ends failed. API keys keep using the vault (ADR-0018); a subscription login is never put there,
   because the CLI refreshes and rotates it and a copy would die.
4. **The one-time code crosses sealed.** When the CLI waits for a code, the runner makes an age X25519 identity for that
   one sign-in and returns its recipient. The page seals the code to it (age-encryption) before it leaves the browser;
   the hub and the fleet carry the ciphertext in memory only, for one unkeyed operation; the runner opens it, types it
   and drops the identity when the sign-in ends. This is the value "sealed to one node's recipient" that FL14 lets
   cross. Links and device codes are not credentials: the app may show them; nothing records them.
5. **A fresh passkey** (SI7): starting a sign-in and sending its code need a passkey check from the last 5 minutes,
   whatever the step-up policy, as a Secret's store does (SR5).
6. **Cards.** The hub asks every online node for its accounts every 10 minutes (and 5 seconds after it starts). An account
   that is signed out, named and in rotation (not retired, not past its expiry) gets one hub-held Ask, "Claude a1 on n1 is
   signed out", with one option, Sign in, which opens the sign-in sheet. It never pushes (`need: time`); it goes when the
   account reads signed in or its sign-in from the app is done. Claude's main login gets no card: it is the principal's own. Cursor's main login does, as lanes run on it.
7. **Agents ask, never act** (SI8). `POST /api/agent/signins/request` raises the same card, with the agent's reason, for an
   existing or a new account. An agent never starts a sign-in, sees its link or sends a code.
8. **Where the principal does it.** The card's Sign in, the Home usage badge of a signed-out seat, and the Engines page's
   Accounts section (each node's Claude and Cursor accounts, Sign in, Add account).

## Consequences

- A lost login costs the principal a minute on the phone, with no terminal and no chat.
- A node whose `policy.json` lists its ops must list the five `signin.*` ops, or it answers each with `denied`.
- An abandoned `agent login` was seen to empty Cursor's stored login when it timed out, so the node refuses a Cursor
  sign-in while Cursor reads signed in.
- Adding an account is the same flow with a new name.
- Known limit: the browser does not yet pin node keys (ADR-0022's pins are not built), so a hub that was taken over could
  hand the page another recipient. The code it could then open is single-use, minutes long and bound to the waiting CLI.
- `runtime-claude.ts` checks a named Cursor connection with `CURSOR_CONFIG_DIR`, which does not move Cursor's login; that
  is left for its own change.

## Alternatives

| Alternative | Why not |
|---|---|
| Copy tokens into the vault and hand them to nodes | Rejected by ADR-0018 and 0029: the CLI rotates them; copies die. |
| Send the code over TLS only | FL14 lets only a sealed value cross; the hub would hold a plain code in memory and logs could catch it. |
| The manager relays links and codes | Codes in a transcript; consent and secrets don't go through the manager. |
| Push a card for every signed-out account | Retired and expired accounts would nag; the pool's own alerts cover "no account left". |
