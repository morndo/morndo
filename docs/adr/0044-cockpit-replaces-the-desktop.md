# ADR-0044: The cockpit replaces the Slack-style desktop, and the backend is built to serve all of it

- **Status:** Proposed, 2026-11-21. The owner made each decision below on 21 November; the ADR becomes Accepted when he
  accepts this text.
- **Replaces, once accepted:** ADR-0006 (Slack-style desktop client) as a whole, including its rule that the hub never
  stores message text.
- **Amends:** ADR-0004 (one principal; access becomes per person), ADR-0005 (stack: a native Mac app with a Rust core
  joins the TypeScript hub and the SvelteKit web app).
- **Builds on:** ADR-0012/0014 (fleet, delivery queue, lane events), ADR-0015/0032/0035/0038 (board, runs, proof, waits),
  ADR-0016/0029/0037 (usage, account pool, key pools), ADR-0018 (connections and vault), ADR-0023 (decision briefs),
  ADR-0039 (sign-in from the app).
- **Design and map:** `docs/design/cockpit/` (mockups, README, `topic-status-framework.md`) and
  `docs/design/cockpit/backend-map.md` (every promise mapped to the server, components C1-C26).

## Context

The owner and testers found the Slack-style desktop hard to use. From 16 to 21 November the cockpit was designed in
HTML mockups: a brief written for the owner, decisions in a fixed form, topics (projects for development) with their
lanes, goals, forecasts and guardrails, one chat per topic shared by people and agents, a Manager that files every ask
as a lane, a command center, a usage card, and a sharing model. Two modules (go-to-market, development) come from one
shell.

The owner set the rule on 21 November: the design is the goal, and V1 ships every function it promises. Mapping the
design onto the code showed that most of it does not exist on the server yet. The server has one principal, no stored
chat, no scheduler, no model calls of its own, no connection to the tools a go-to-market team uses, and no way to see or
stop an agent's outward actions. The backend is the bottleneck, so this ADR fixes the direction for it.

## Decision

1. **Target.** The cockpit in `docs/design/cockpit/` is the product's UI: the v3 go-to-market mockup, the development
   mockup and the sharing proposal. Nothing it promises is cut from V1. Gaps are backend work, ordered in
   `backend-map.md` section 5.
2. **Clients.** A native Mac app with a Rust core (hub client, local mirror, terminal stream) is the main client. The UI
   toolkit over the core is decided in its own ADR. The web app follows the cockpit for the phone and for people a topic
   is shared with.
3. **A team, not one principal.** People, invitations by name or email, roles, a passkey per person, and access per topic
   down to a stage. The hub decides what each person sees; no client filters.
4. **The hub stores the record.** Chat text, labels and their corrections, threads, read-backs, and every topic's and
   lane's history for its whole life, in the hub's own store, encrypted at rest, with export and delete. Transcripts
   remain a source, not the store.
5. **Judgement runs.** Small typed jobs (sort a message, answer from the record, pick topic and lead, write a summary, a
   brief or a status page) run headless on nodes. The hub sends a typed request and accepts only an answer that passes
   its schema; each run is logged. Until Anthropic confirms otherwise, headless Claude runs use an API key, because the
   Agent SDK terms bar third-party products from offering the claude.ai login.
6. **Lanes stay interactive.** Agent CLIs keep running interactively in tmux on the server (Claude Code with
   `--dangerously-skip-permissions`, on the owner's subscription). Morndo reads tmux's control mode (`tmux -CC`) like
   iTerm2 does, instead of polling screenshots, and keeps a live screen model. Each lane has a clean view (conversation
   from the transcript and hooks; questions, menus and prompts as buttons that send the exact keys; typing only when the
   input is free) and a full terminal view. A terminal server of our own in Rust replaces tmux only if measurements
   blame tmux. Details: `backend-map.md` section 8.
7. **Outside tools through our own connectors.** Every write to an outside tool is a typed request to the hub's action
   gateway, which checks guardrails and decision rights, counts quotas and spend, logs it with how to undo it, and holds
   it while a handover read-back does not match. Agents' MCP tools may read. V1 ships every tool the mockups name: Gmail
   / Google Workspace for drafts, HubSpot, Google and LinkedIn ads, LinkedIn posting, Supabase (read), an image model,
   Seedance; for development GitHub, Sentry and one deploy target, still to be chosen.
8. **The Mac app signs in two ways.** The macOS passkey prompt, then a device-bound session token in the Keychain; or
   pairing by QR code from a device that is already signed in. Step-up rules stay as for the web.
9. **Rust types are the source of the API.** The protocol is defined in Rust; the TypeScript types and the hub's runtime
   checks are generated from it, so the web, the hub and the Mac app cannot disagree. The generator is chosen in the
   contract work, against its official documentation.
10. **Contract first.** Before the components, every screen's API is written as types, and a stand-in hub serves the
    mockups' data through them. The Mac app is built against the stand-in from the first week; each backend component
    replaces part of it when it lands. The unmerged modules design of 13 November (Done gate in the server, modules as
    data, every CLI a client, per-lane tokens, mandates, scheduler) is merged into this order rather than run beside it.

## Consequences

- The largest new parts are identity and team (C1), the record store (C3), messaging (C4), judgement runs (C5),
  connectors (C10) and the action gateway with guardrails and Undo (C11, C12). Each gets its own ADR before code.
- `packages/protocol` moves from hand-written zod schemas to types generated from Rust. Existing decoders keep working
  until each route moves.
- Sharing is no longer "links and exports only, still one person" as the modules design said on 13 November.
- Storing chat text changes the threat model: backups, export, deletion per person and retention need rules (a new
  section in `docs/domain.md`).
- Headless runs on an API key cost money per run; the usage card and spend caps (C15) have to show them.
- tmux stays. Control mode is new code in the node agent; the 80 ms frame polling and the screen regex go once it works.

## Open

- The deploy target for the development module's staged rollout.
- Whether Anthropic approves subscription use for headless runs (decision 5), and the same question for Codex and
  Cursor.
- The Mac app's UI toolkit over the Rust core.
- The type generator (decision 9).
