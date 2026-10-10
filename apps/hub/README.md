# Morndo hub

The principal's own server for the web endpoint ([ADR-0004](../../docs/adr/0004-principal-web-endpoint.md)). It listens on 127.0.0.1 only, serves the built web app, and in increment 1 shows the terminal panes of the machine read-only.

## Run it

Needs Node 24 LTS (`.nvmrc`) and tmux.

```sh
npm install
npm run build                      # builds apps/web into apps/web/build
MORNDO_ORIGIN=https://<your-host> node apps/hub/src/main.ts serve
```

To reach it from your phone without a public tunnel, publish the port inside your private network, for example with Tailscale Serve: `tailscale serve --bg --https=8443 http://127.0.0.1:8790`. Then set `MORNDO_ORIGIN` to exactly the URL the browser opens, and `MORNDO_REQUIRE_PROXY_IDENTITY=1` plus `MORNDO_PRINCIPAL_LOGIN=<your tailnet login>`, so requests the proxy didn't vouch for are refused (it sets no identity for tagged devices).

## Pair a device

```sh
node apps/hub/src/main.ts pair     # a one-time QR, valid 10 minutes, for one device
node apps/hub/src/main.ts devices  # what is paired
node apps/hub/src/main.ts revoke <id>
node apps/hub/src/main.ts audit
```

Scan the QR with the phone's camera. The app shows the hub identity: compare it with the terminal, then create a passkey (Face ID, Touch ID or the device PIN). At most 6 devices are active at once.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `MORNDO_ORIGIN` | `http://localhost:8790` | The exact origin the browser uses. Must be https, except localhost. Passkeys are bound to its host name. |
| `MORNDO_PORT` | `8790` | Local port (127.0.0.1 only). |
| `MORNDO_HOME` | `~/.local/share/morndo` | Database and the hub identity key (mode 0600). |
| `MORNDO_REQUIRE_PROXY_IDENTITY` | off | Refuse requests without the proxy's `Tailscale-User-Login` header. |
| `MORNDO_PRINCIPAL_LOGIN` | none | If set, that header must equal it. |
| `MORNDO_TMUX_SOCKET` | default server | `tmux -L <name>`. |
| `MORNDO_TMUX_SESSION` | all sessions | Show only this session's panes. |
| `MORNDO_CLAUDE_DIR` | `~/.claude` (off with a private tmux socket) | Where Claude Code keeps sessions and transcripts, for the conversations. `off` disables them. |
| `MORNDO_VNC` | off | `host:port` of the VNC server the hub connects to for the desktop view, with or without `MORNDO_FLEET_SOCKET` (design, section 16.1). Off unless set. Leave it unset on a control plane apart from its nodes. |
| `MORNDO_VNC_PASSWORD_FILE` | `~/.vnc/passwd` | The VNC password file, read when `MORNDO_VNC` is set. |
| `MORNDO_FLEET_SOCKET` | unset | The fleet service's client socket (`apps/fleet`), an absolute path. When set, the hub reaches every node's tmux and transcripts through the fleet, and `MORNDO_TMUX_SOCKET`, `MORNDO_TMUX_SESSION` and `MORNDO_CLAUDE_DIR` don't apply; the desktop view is the one `MORNDO_VNC` names, as without it, and when the fleet can't be reached every worker shows as not online, under a "Fleet unavailable" banner (the hub starts even if the fleet is down). A worker of a node that doesn't answer gets an offline marker, and an uncertain send offers "Check again". When unset, it uses this machine's tmux and `~/.claude` as before (design, section 10). |
| `MORNDO_OFFICE_NAME` | host name | The workspace name the desktop app shows. |
| `MORNDO_ENGINE_SESSIONS` | off | Absolute path of the engine-lane registry on this machine (`<pid>.json`, status `busy` or `idle`). Unset, empty, `0` or `off`: the hub does not read them. `serve` refuses a relative path. A lane the hub follows by its transcript stays on its screen. |
| `MORNDO_ENGINE_NODE` | unset | This machine's fleet node name. With `MORNDO_FLEET_SOCKET` set, engine-lane status stays off unless this names the node, so another machine's workers are not marked from this registry. A name still absent two minutes after the hub starts is warned once as not connected. A hub without a fleet treats every worker as local. |
| `MORNDO_ENGINES` | none (no Engines page) | The engine layer's CLI, `engine-layer/bin/engines` (ADR-0013). The Engines page reads and writes the per-role provider settings only through it; its own `ENGINES_CONFIG` and `ENGINES_STATE` pass through. |

## Desktop app (ADR-0006)

From 900px wide the app is a Slack-style client: the manager as a direct message, one channel per agent (sections Working and Idle), Activity for everything that needs you, a Screen tab and side panel for the live terminal, and a composer that types into the agent. Sending needs Face ID or Touch ID from the last 10 minutes; the hub pastes only when no menu is open and the agent's input line is empty, and audits each send by length and hash. Shortcuts: Ctrl+K search, Alt+↑/↓ next agent.

## Phone (ADR-0009)

Under 900px wide the app has three tabs. **Today** (Horizon) says when you are next needed: "N waiting now", or "Nothing needs you until HH:MM" from the earliest deadline on the board, then a timeline where a filled dot needs you and an open one happens without you. **Catch up** goes through the open decisions (blocking first), then one card per agent with something new since you last read it: answer, keep for later, mark read, keep unread or reply, by button or swipe, with Undo for 5 seconds before anything goes. **Agents** is the list and an agent's read-only screen. A push about decisions opens catch-up at a decision card.

## Checks

```sh
npm test                           # domain invariants, hub guards, tmux adapter (synthetic panes)
npm run check                      # type checks: domain (no Node types), hub, tests, web
npm run e2e                        # builds, then pairs, watches, signs out, revokes in headless Chromium
npx vitest run --project fleet     # the fleet's drills: real fleet, agents and hub, isolated tmux servers (about 2 min; CI runs the longer soak)
node e2e/fleet-two-node.e2e.ts     # two nodes, one fleet, the hub in fleet mode (after npm run build)
node e2e/phone-shots.ts <folder>   # every phone screen at 390 x 844, light and dark (after npm run build)
npm run e2e:engines                # the Engines page against the real engines CLI, on scratch settings ($ENGINES_BIN)
node e2e/engines-shots.ts <folder> # the Engines page before and after a change, phone and desktop (owner-only images)
```

## Engines (ADR-0013)

`/engines`, from the phone's Devices page (⋯, then this link) or the desktop sidebar: per role, the provider, model and effort of the first choice and each fallback, the reviewer-from-another-provider switch, and what runs now. Saving needs a fresh passkey check like a send; a page whose settings changed elsewhere since it loaded is asked to reload instead of overwriting them.
