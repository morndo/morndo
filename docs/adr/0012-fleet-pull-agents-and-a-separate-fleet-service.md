# ADR-0012: A fleet of machines, with pull agents and a separate fleet service

- **Status:** Proposed, 2026-10-06. Design v2: [`docs/design/fleet-core/README.md`](../design/fleet-core/README.md). It folds in a review of v1 against the code; section 14 there lists the changes. The implementation plan ([`plan.md`](../design/fleet-core/plan.md)) was reconciled the same day and then reviewed a second time (executability and coverage); section 15 of the design lists what each round corrected, and [`plan/RECONCILIATION.md`](../design/fleet-core/plan/RECONCILIATION.md) every decision.
- **The request:** move the control-plane pieces onto a rented server, and make the same architecture run on one PC or split across machines.
- **The choices:**
  - **How the control plane reaches lanes:** a pull agent on each node, ahead of an SSH-first move or a minimal move.
  - **Where the code lives:** inside Morndo.
  - **Review:** a thorough check first, aimed at long-term robustness.
  - **Approval:** the architecture, including the separate fleet service, was accepted.
  - **Follow-up:** review the design, then write the plan. That produced design v2.
- **Number:** 0010 and 0011 belong to open pull requests (manager inbox, phone chat app).
- **Builds on:** ADR-0001, ADR-0005 (stack), ADR-0008 (numbered migrations, the protocol package, send states, liveness).

## Context

One machine that runs every lane together with the manager, the chat bot, the hub and their timers can run out of memory. When it does, the tools that see and steer the lanes go dark with it.

The control plane can sit on its own machine. Other machines can host lanes, and the same architecture can run on one computer or be split across several.

Every part of today's system assumes one host. The hub reaches tmux, `~/.claude`, transcripts, files and a `flock` directly, and its worker IDs are raw tmux pane IDs (`%N`). The box tools (`lanes`, kira, claude-pool) all use one tmux server.

Two research reports of 2026-10-06 ("Multi device agents and Morndo robustness", "Lane clustering and auto placement") recommend a custom placer inside Morndo, with pull agents on the lane hosts, over Kubernetes, Nomad or Swarm.

## Decision

1. **Two roles, one codebase.** The control plane runs the fleet service (`apps/fleet`) and the hub; kira and the manager are clients. A node runs `apps/node-agent`. One machine can hold both roles, with its agent dialing localhost.
2. **Nodes dial in, never the reverse.** Each agent keeps one authenticated WebSocket to the fleet service, over the tailnet (HTTPS through Tailscale Serve) or locally. No inbound access to any node is needed. That works behind WSL's NAT and under Tailscale SSH check mode. The fleet listens on loopback only, behind Serve's TLS, and an agent dials plain `ws://` only to its own loopback.
3. **The fleet service is separate from the hub.**
   - It owns the node registry, connections, routing, the lane registry and the hook bus.
   - It offers a versioned client API (`/v1/`) on a fixed, owner-checked Unix socket. Its alerts are part of it (`GET /v1/alerts` and an `alert` event), so the hub, kira and the owner's tools see them.
   - A hub deploy or crash therefore never cuts kira or the manager's tools off from the lanes.
   - Each service is the only writer of its own SQLite database.
4. **Mutual authentication with keys.**
   - Each node creates an Ed25519 key pair. The fleet service's own key is pinned in the join string, and both sides sign a fresh challenge on every connection.
   - Join codes are single use, expire after 10 minutes and are bound to a node name; the fleet stores only their hash. The join string carries the name, the agent's `join` names it, and the fleet refuses a code used for another name.
   - Joins and hellos are rate-limited per source address before any key work.
   - Tailscale identity headers are not used: Serve omits them for tagged devices.
5. **Typed operations only, with an honest threat model.**
   - There is no generic exec. `lane.start` takes typed fields, and file and worktree paths are confined on the node with today's rules (`files.ts`: symlinks resolved, deny roots, secret names, 25 MiB), widened to the state of Morndo's own services and kira's and every `.credentials.json`; a judged file is opened with `O_NOFOLLOW`. Names and directories reach tmux only as literals, never as formats.
   - Text typed into a Claude Code pane can still run commands, so a compromised control plane can do about what SSH would allow.
   - The node key is a device credential readable by same-user lanes, not an isolation boundary. Mitigations: a node policy (which can turn off `pane.keys`), an audit trail of every side-effecting op (kept 90 days), an alert when a node's source address changes, and revocation.
6. **Pane identity is stamped.**
   - Worker IDs are `<node>.<server>.<pane>`. `server` is a UUID the agent stamps on its tmux server, because pane IDs are reused after a tmux restart (reproduced).
   - Every side-effecting pane op carries an expectation (server, window, session) that the agent checks immediately before acting.
   - Menu escalation IDs and the protocol's worker-ID pattern change with it.
7. **Nothing is typed twice, and retries still work.**
   - Keys are recorded in two phases (`started` before the side effect, `done` after) in the node's own database. Since 2026-10-08 only `started` is synced to the disk (`FULL` for that transaction; the rest `NORMAL`, so no hook waits for a sync): a retry may go to another pane than the first attempt, so `started` must survive a power loss (design §16.4).
   - Refusals that happened before any side effect release the key, so a retry types as it does today.
   - `op.status` lets the hub resolve an `uncertain` send after a reconnect. Every answer names the agent database (the store) that holds the keys, so an agent whose database was lost or restored can't vouch for a key it no longer has: that send stays `uncertain`.
   - Escalation answers carry keys too.
8. **Hooks cannot stall a session or be lost silently.**
   - The agent serves `127.0.0.1:8787` on every node, so `settings.json` stays identical everywhere. It acknowledges after a durable write and answers 503 on the script paths when it can't write.
   - Hooks form a durable stream (`streamId`, `seq`), replayed in order before anything new; the agent's `hello` names its stream, so the fleet's welcome can say how far it got. Progress events are coalesced to the latest per session.
   - The fleet service delivers to statically configured subscribers through an outbox, at least once, with an idempotency key, dead letters and capped backlogs.
   - kira becomes a subscriber.
9. **State over events after a reconnect.**
   - A reconnecting agent sends a full inventory; a node that drops off shows its workers as offline, never as gone.
   - One live instance per node: a second instance with the same key is refused with an alert while the live one answers a ping, not swapped in; one whose old connection is dead or half-open is admitted after 3 s, so an unclean restart can't lock the node out. A refused agent tries again every 5 minutes.
   - The hub polls nodes in parallel, so a slow node never delays the others.
10. **Version skew is expected.** The agent channel and the client API accept the current and the previous version, and the handshake carries agent, protocol and Claude Code versions.
11. **Lane names are fleet-wide.**
    - Persisted hub data is keyed by lane name or request UUID (verified), so no migration is needed for read marks or sends.
    - A name belongs to the node that registered it first, and a conflict stops every route by that name (`lane_conflict`), the manager's answers included, until the owner resolves it. The hub still lists every window, and a send to one by its worker ID still goes through.

## Consequences

- The hub's transcript, file, upload and older-page paths become async ports; its local adapters move to `packages/node-ops`. Their tests are adapted, not unchanged.
- The web app and the protocol take the new worker IDs. An old cached outbox with `%N` entries fails those entries as `no_pane`. The app marks an offline node's workers, and offers "Check again" for a send in doubt, which the hub resolves with `op.status`.
- The store alone can't see an older copy of the agent's database put back in place (`cp` over the file, a VM snapshot): that copy keeps the store id. So every answer also carries the store's sequence (`storeSeq`, one more for each keyed op started, never lowered), the hub keeps it with a send or answer in doubt, and an `unknown` from the same store at a lower sequence stays `uncertain` (added during execution, 2026-10-07; design §5.3). The fleet also keeps the highest `storeSeq` per store and sends it in the welcome, so an agent whose database is behind starts a new store before it runs anything. What remains is in the agent's README: a copy taken just before a send whose answer never reached the fleet.
- The agent has test hooks for the negative controls that need a fault inside it. It refuses them unless `NODE_ENV=test` and its `HOME` is not the account's own, so an installed agent can't run with them.
- Every negative control the plan describes is kept as data (`scripts/negative-controls.ts`) and run on a schedule, so a guard that stops biting is noticed.
- kira, `lanes` and the manager's scripts become clients in sub-project 2; install by role is sub-project 3; the cutover is sub-project 4.
- One more always-on service runs on the control plane, and each hop between local services adds a Unix-socket round trip.

## Rejected

- **SSH from the control plane into nodes.** It needs inbound access to every node, which Tailscale SSH check mode and WSL's NAT block, and it gives broad shell access by default.
- **The fleet core inside the hub.** A hub deploy or a UI bug would cut kira and the manager off from the lanes.
- **Kubernetes (k3s), Nomad, Docker Swarm.** None runs interactive tmux sessions well or knows Claude accounts and transcripts, and the Macs can't join k3s ("Lane clustering and auto placement", sections 2–3).
- **OpenClaw as software.** Its gateway and node design is a reference. It was not chosen as the product. Its own docs prefer an API key for a long-lived gateway, and say native Claude login tokens stay with the Claude CLI (https://docs.openclaw.ai/gateway/authentication and https://docs.openclaw.ai/anthropic, checked 2026-10-10).
- **Bearer tokens per node.** A captured token replays, and the fleet service would hold secrets.

## Sources (checked 2026-10-06)

- **Node.js 24 crypto:** Ed25519 `generateKeyPairSync('ed25519')`, `sign(null, …)` and `verify(null, …)`. https://nodejs.org/docs/latest-v24.x/api/crypto.html
- **`ws` README and API docs:**
  - ping/pong liveness with `terminate()`;
  - `noServer` with authentication in `upgrade`;
  - `ws+unix:` client URLs;
  - `maxPayload`.

  https://github.com/websockets/ws (README.md, doc/ws.md)
- **Claude Code hooks:**
  - HTTP hook failures are non-blocking;
  - the default timeout is 600 s;
  - the per-hook `timeout` is in seconds;
  - a slow hook stalls the session.

  https://code.claude.com/docs/en/hooks
- **Tailscale Serve:** its identity headers are not set for tagged devices. https://tailscale.com/kb/1312/serve. WebSockets through Serve are not documented there; they are observed working (the hub's feed through Serve on the owner's PC).
- **Fencing tokens:** M. Kleppmann, "How to do distributed locking", 2016. https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html
