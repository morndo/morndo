# ADR-0014: Fleet clients: a delivery queue on each node, lane events in the fleet

- **Status:** Proposed, 2026-10-08. Design: [`docs/design/fleet-clients/README.md`](../design/fleet-clients/README.md) (sub-project 2 of the fleet).
- **Number:** 0010, 0011 and 0013 belong to open pull requests (manager inbox, phone chat app, engines settings).
- **Builds on:** ADR-0012 (the fleet), ADR-0008 (send states, idempotency), ADR-0006 (decisions).
- **Supersedes, once its §9.1 is live:** ADR-0010 (the manager's answers through kira's inbox on disk; rebuilt on main by #29, which §9.1's work removes; the owner, 2026-10-09). Its domain rules stay: an answer counts as given once queued, and is recorded once it reached the manager.

## Context

The fleet core is live on the owner's PC. The hub reaches lanes through it; nothing else does:
- `lanes`, kira, the manager's inbox and `lane-events-push` still run `tmux` and read `~/.claude` themselves;
- kira owns the hook port;
- `lane.start` has the owner's launcher (`claude-as`) in its code.

Morndo is to become open source, for many people on modest machines, without anything specific to the owner's setup.

## Decision

The owner's choices, 2026-10-08, each over the alternatives offered:

1. **A delivery queue in each node agent,** not in the fleet service ("every check would cross the network") or in the hub (ADR-0012's coupling).
   - A message to a lane is stored on its node (synced to disk) and typed once when the lane can take it.
   - It is confirmed from the lane's conversation by the manager inbox's receipt rules, ported.
   - One typed but never seen taken is `uncertain`, never typed again.
   - The hub, `morndo lanes`, kira and the fleet's lane events all use it. kira's manager inbox and ADR-0010's on-disk contract retire.
2. **Lane events in the fleet,** built from the hook stream and each session's state: "finished", "needs input", "answered", "stop failure". They are published to clients and delivered to the manager. kira's events file and `lane-events-push` retire.
3. **A documented client API and a TypeScript client library.** The API reference's examples run as tests. `morndo lanes` is Morndo's lanes command.
4. **The owner's tools plug in from outside:**
   - his `lanes` keeps its name and extras, on `morndo lanes`;
   - kira stays his Telegram bot, the first client from outside, and gets hooks as a subscriber of the fleet's hook bus;
   - his account launcher becomes a node setting.
5. **One spec for all of it,** deployed on the PC in steps with a rollback each.

## Consequences

- No Morndo program and none of the clients the design names (kira, `lanes`, the manager's helpers) types into a lane or reads its conversation except through the fleet, so the control plane can move (sub-project 4). Left local by design: the owner's account pool tool, the status line and the hook scripts, which act inside one machine's own panes.
- A delivery's text lives on the node until it is final plus 7 days; the fleet keeps its state, never its text.
- The fleet's hook commits follow §16.4's rule and are measured before hooks go through it (issue #21); the switch waits for that gate.
- Subscribers to the hook bus answer 2xx once they have an event (the subscriber contract), because each stream is delivered in order.
- Open: a lane on a node without the fleet can't use `morndo lanes` until sub-project 4 decides how a node relays client calls, and what a lane may do to lanes on other machines.
