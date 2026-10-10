# ADR-0004: A web endpoint for the principal, modeled on Signal

- **Status:** Accepted, 2026-09-30. Decided by the owner (the principal); built by lane A in coordination with the product lane.
- **Supersedes:** for the principal side only, the "no … phone app" in ADR-0001 Decision 1 and in an internal decision record. The agent side is unchanged: workers still run on existing tools, unmodified.
- **Sources:** [S1]–[S12] at the end, all accessed 2026-09-30.

## Context

1. On 2026-09-30 the principal's only remote channel, a Telegram bot, was refused sends for about 5.5 hours ("Too Many Requests: retry after 19805"). He could not see or steer his workers from his phone. One vendor channel is a single point of failure.
2. The requirement: a standalone web app in the style of Signal, built in the product repo and following the domain rules. The front end is SvelteKit, built as a static site.
3. Signal's design fits the problem: one person, a few devices, a server that must not be trusted with more than it needs. The parts that apply here, from Signal's code and docs:
   - devices are linked with a QR code carrying a one-time address and a fresh public key; only the primary can mint the link token, which lasts 10 minutes and works once; at most 6 devices; the primary can remove any device [S1, S2];
   - pushes carry no content, the app fetches over its own connection [S3];
   - one authenticated WebSocket per device, messages stay queued until the device acknowledges them, then a "queue empty" marker [S4];
   - a changed identity key is a hard stop until the person verifies it again [S5].
4. The principal's machine already sits on a private WireGuard network (Tailscale). Relayed traffic stays end-to-end encrypted; relays forward what they can't read [S6]. Tailscale Serve publishes a local port to that network only, strips client-supplied identity headers, and sets none for tagged devices [S7].

## Decision

1. **The web app is an Endpoint.** In the terms of `docs/domain.md`, a paired browser on the principal's phone or laptop is one Endpoint. The hub that serves it runs on the principal's machine and listens on 127.0.0.1 only. It is reached through the private network's proxy (Tailscale Serve), never a public tunnel, and no third-party relay carries its traffic.
2. **Signal's device model, adapted:**
   - **Pairing:** the console on the principal's machine issues a one-time pairing token that lasts 10 minutes, shown as a QR code. The token goes in the URL fragment, which browsers don't send to the server [S8].
   - **Passkey:** redeeming the token registers a passkey that requires user verification (Face ID or a device PIN) [S9]. Each Endpoint has its own credential, so revoking one deletes one key.
   - **Limits and revocation:** at most 6 active Endpoints. There is a device list with "last seen", and revoking an Endpoint ends its sessions immediately.
   - **Box identity:** the hub has its own identity key. Its fingerprint is pinned at pairing, and if the hub ever presents another key, the app stops (the equivalent of a safety number).
   - **Sequenced feed:** the hub sends a per-connection feed with sequence numbers. A reconnecting Endpoint resumes from its cursor, or gets a fresh snapshot when the gap is too old.
3. **Web hardening:**
   - The session cookie is `__Host-`, Secure, HttpOnly, SameSite=Strict, with idle and absolute expiry [S10].
   - `Origin` is checked on every WebSocket upgrade and every state-changing request [S11].
   - No secrets in URLs apart from the one-time pairing fragment.
   - The hub can require Tailscale's identity header and a configured principal login.
   - A Content-Security-Policy applies to the app.
4. **Increment 1 is read-only:**
   - Observation only: which workers exist and what their screens show, read through a terminal-multiplexer adapter.
   - Typing into workers, answering asks and push notifications come later. They will need signed commands, a fresh user verification and the Escalation context's Delivery and Acknowledgement rules; the product lane is consulted before those terms are touched.
5. **Privacy:** worker screens contain client material. The repo never holds captured screen text, fixtures or screenshots from real workers; tests and QA use synthetic panes on a separate multiplexer server.

## Alternatives

| Option | Verdict |
|---|---|
| Keep Telegram as the only channel | Rejected: it just failed for 5.5 hours, and a bot can't prove the principal read anything (ADR-0001 context 5). Telegram can stay as a second Endpoint. |
| Vendor remote control (Claude Code Remote Control) | Not the product's answer: conversations pass through the vendor's servers, each session belongs to the account that started it, and there is no API for a third-party client [S12]. Fine as the owner's stopgap. |
| Public tunnel with an access proxy (e.g. Cloudflare Access) | Rejected for now: TLS ends at the proxy, so it can read commands and output. |
| Signal Protocol (libsignal) for an extra encryption layer | Rejected: AGPL, "use outside of Signal is unsupported", no browser build [S2]. Both ends are online and the hub is the endpoint, so the WireGuard tunnel plus TLS is enough. Revisit (Noise IK with the pinned hub key) if traffic ever leaves the private network. |

## Consequences

- **Good:** the principal gains a channel that doesn't depend on a chat vendor's rate limits, with device linking and revocation he controls.
- **Limit:** the hub runs on the same machine, as the same OS user, as the workers. On the owner's box that user can control Docker, which Docker says only trusted users should do [S13]. A hijacked worker could tamper with the hub. Only sandboxing the workers fixes that, and it is out of scope here.
- **Unknowns, probed in QA before the phone relies on them:**
  - whether passkeys work in a home-screen web app on iOS;
  - what happens to the WebSocket when the screen locks;
  - whether identity headers survive the proxy into the machine's local port.

## Sources (accessed 2026-09-30)

- [S1] https://signal.org/blog/a-synchronized-start-for-linked-devices/
- [S2] https://github.com/signalapp/Signal-Server/blob/main/service/src/main/java/org/whispersystems/textsecuregcm/controllers/DeviceController.java ; https://github.com/signalapp/libsignal (README)
- [S3] https://github.com/signalapp/Signal-Server/blob/main/service/src/main/java/org/whispersystems/textsecuregcm/push/APNSender.java
- [S4] https://github.com/signalapp/Signal-Server/blob/main/service/src/main/java/org/whispersystems/textsecuregcm/websocket/WebSocketConnection.java
- [S5] https://support.signal.org/hc/en-us/articles/360007060632
- [S6] https://tailscale.com/kb/1232/derp-servers
- [S7] https://tailscale.com/kb/1312/serve (identity headers: stripped from clients, absent for tagged devices and Funnel)
- [S8] https://www.rfc-editor.org/rfc/rfc3986#section-3.5 (the fragment is not part of the request)
- [S9] https://www.w3.org/TR/webauthn-3/ ; https://simplewebauthn.dev/docs/packages/server
- [S10] https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie
- [S11] https://www.rfc-editor.org/rfc/rfc6455#section-10.2
- [S12] https://code.claude.com/docs/en/remote-control
- [S13] https://docs.docker.com/engine/security/

## Addendum (2026-10-08): an engine lane's Working and Idle

An engine lane writes no transcript the hub follows, so a still pane stayed Idle while the lane was working. Listing every lane with `lanes --json` has the status, and it cost 2.2–2.4 s and about half a core per run (18 lanes, measured 2026-10-08). The same status is already one JSON file per process in the engine registry. Reading the box's status at runtime is allowed when it is an opt-in setting, as `MORNDO_LEDGER` and `MORNDO_ENGINES` are.

1. `MORNDO_ENGINE_SESSIONS` names that directory. Unset, empty, `0` or `off`: the feature is off, no reader is wired, and nothing is logged per poll.
2. With a fleet (`MORNDO_FLEET_SOCKET`), `MORNDO_ENGINE_NODE` must name this machine's node or the feature stays off (one info line at start). A hub without a fleet treats every worker as local.
3. The directory is read on every poll (no cache): small JSON files, read together. A file counts when its pid is alive (`process.kill(pid, 0)`, EPERM means alive; checked before the file is opened), the file name's pid is the body's, and both `pidStartTicks` and `bootId` match the live process exactly. `pidStartTicks` is field 22 of `/proc/<pid>/stat` (clock ticks since boot). `bootId` is `/proc/sys/kernel/random/boot_id` for this boot. There is no `btime`, no wall clock, and no tolerance: a WSL clock step moves `btime`, so an absolute start time drifts. That is why a 15-second window on `startedAt` showed every busy lane Idle (deploy of #18, 2026-10-08), and why a 2-second window on `pidStartedAt` would drift the same way. `startedAt` and `pidStartedAt` are not compared. A file missing either field is an old writer and does not govern; the screen decides. If `/proc` cannot be read, the file does not govern. Bad files are skipped. A failed directory read is no reports for that poll, warned once when the failures start and once when they stop.
4. A report governs only an engine lane on this machine that is online, the only worker of its name, and not one the hub is following. A followed worker keeps the screen. `busy` is Working, `idle` is Idle. The screen text still updates and does not flip that state. `MORNDO_ENGINE_SESSIONS` must be an absolute path. A `MORNDO_ENGINE_NODE` still absent two minutes after the hub starts is warned once as not connected, and no report applies until that node is in the fleet map.

Not `lanes --json`, because of the cost. Opt-in, because another install has no such registry and a hard-coded dependency on this box's tools is not the product. The registry's status is only `busy` or `idle` (engine-layer `src/engines/lane.py`; `lanes` reads the same files). `readdir` and `process.kill`: Node.js docs, https://nodejs.org/api/fs.html and https://nodejs.org/api/process.html, read 2026-10-08.
