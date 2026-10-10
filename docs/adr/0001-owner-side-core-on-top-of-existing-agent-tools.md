# ADR-0001: An owner-side core on top of existing agent tools

- **Status:** Accepted, amended 2026-09-30 (see the Amendment at the end). Documents only; code waits for the owner's name pick.
- **Deciders:** the product lane (an internal decision record and its addendum). The owner may veto.
- **Sources:** [S1]–[S11] at the end, all accessed 2026-09-30. Installed Claude Code: 2.1.285 (`claude --version`, 2026-09-30).

## Context

1. **The agent side is served.** The official CLI runs background sessions and lists them as JSON [S3]. MIT supervisors exist: firstmate (7,350 stars) and the no-mistakes push gate (8,692 stars) [S8, S9].
2. **The loop back to the principal is not reliable, in either.**
   - firstmate #6034 ("counts an unsubmitted inject as delivered") and #1474 (`fm-send` "exits 0 even when the steer never lands") are open [S8].
   - Channels: "Claude Code doesn't acknowledge notifications. The `await` on `mcp.notification()` resolves when the message is written to the transport, not when Claude has processed it", and an unloaded channel's events are dropped "silently" [S2]. "Events only arrive while the session is open" [S1].
3. **Decide-once can't live in the vendor.**
   - A relayed permission verdict: "Neither verdict affects future calls" [S2].
   - Hooks: "a hook with `permissionDecision` of `"allow"` can't override a deny rule … and `"deny"` and `"ask"` rules are still evaluated regardless of what the hook returns" [S4, S5].
4. **The vendor's completion judge can't check.** The `/goal` evaluator "doesn't run commands or read files independently" [S6].
5. **The acknowledgement must be explicit.** We found no read status for messages a bot sends in the Bot API 10.3 reference (a reading of absence, so a trial check). Its only read-marking method, `readBusinessMessage`, marks *incoming* messages on a business account. Pending updates "will not be kept longer than 24 hours", and `callback_data` is "1-64 bytes" [S11].
6. **Our rules and plan.**
   - Building rules: strict DDD, no infrastructure in the domain, a separate local repo, and no dependency on the owner's running system.
   - The trial needs a frozen, scripted scorer anyway.

## Decision

1. **Agents: build on.** Run existing tools unmodified, through documented interfaces only. No fork, and no runtime, supervisor, multiplexer, phone app or account pool of our own.
2. **Principal: build our own small core.**
   - Three bounded contexts (Authority, Escalation, Verification), as defined in `docs/domain.md`.
   - Pure domain, ports and adapters. Every vendor surface is an anti-corruption adapter.
3. **Order.**
   1. Now: documents.
   2. After the name: the domain layer plus invariant tests. Its first consumer is the trial scorer, which replays raw trial logs and emits Violations F1–F4.
   3. Adapters only on a BUILD result, and only for the failure classes the trial shows.
4. **Cap.** Until the trial result, the core holds only invariants A1–A4, E1–E7 and V1–V4.
5. **Irreversible actions are gated by our PreToolUse hook, not by vendor ask rules.**
   - A hook "allow" "skips the permission prompt" but can't silence an ask rule [S4], so an ask rule would re-ask a decision already given (F2).
   - Vendor deny rules stay as a floor. They "block in every mode, including `bypassPermissions`" [S7], so a Mandate can never widen them.
6. **Deferred to ADR-0002 (after the name):** language, runtime and storage, each checked against live docs.

### Adapter mapping (anti-corruption layers)

| Vendor surface | Domain side | Constraint from the docs |
|---|---|---|
| Claude Code `PreToolUse` hook (`type: "http"` or command) | Action to Authorize; Allowed to `allow`, else `deny` with a reason | Exit code 2 "stops the tool call before permission rules are evaluated" [S5] |
| `PermissionRequest` hook | Ask; Decision back as `behavior` | "Deny and ask rules are still evaluated" [S4] |
| `Notification` hook (`permission_prompt`, `idle_prompt`, `agent_needs_input`, `agent_completed`) | Ask or Alert | [S4] |
| `Stop` / `TaskCompleted` hooks | Claim | Stop can `block` with a `reason` [S4] |
| Channels permission relay (`permission_request`, then `permission` with `request_id`) | Ask; Decision back | First answer wins; a wrong ID is dropped "silently" [S2] |
| `claude agents --json` (`state`, `waitingFor`) | Ask, as a polling backstop | Research preview [S3] |
| firstmate `state/fleet-ledger.jsonl` (v1) | `task.status` needs-decision with `key` to Ask; done to Claim | At-least-once: "a reader that must not double-count should tolerate duplicates" [S8] |
| no-mistakes `axi` | Evidence | Non-interactive interface to its approval flow [S9] |
| Telegram Bot API | Delivery via `sendMessage`/edit; `callback_query` to Acknowledgement | Answer every callback; data ≤64 bytes [S11] |

## Alternatives

| Option | Verdict |
|---|---|
| **Fork firstmate** | Rejected. MIT allows it, but it is mostly shell, with 208 entries in `bin/` (`gh api`, 2026-09-30), and fails our DDD rule. We'd inherit its delivery bug class (#6034) and a single maintainer's churn. We borrow ideas only, such as its fleet-ledger contract; no code is copied, so `research/borrowed.md` is unchanged. |
| **Build a full platform** (supervisor, runtime, phone app, pooled logins) | Rejected. It fights the vendors on their home turf and takes weeks before the trial tells us anything. Hosting logins is barred: developers may not "route requests through Free, Pro, or Max plan credentials on behalf of their users" [S10]. |
| **Plugin only** (hooks plus a channel, no core) | Rejected as the home of the domain, kept as a possible adapter package. Its state lives in one session (events arrive "only … while the session is open" [S1]). Relay verdicts don't persist [S2]. A custom channel needs `--dangerously-load-development-channels` during the preview, and the "protocol contract may change" [S1, S2]. It would also tie the domain to one vendor. |
| **Recipe only, no code** | This is the KILL outcome. Reaching it honestly still needs the scorer. |

## Consequences

- **Good:** the core survives vendor fixes. If firstmate or Anthropic fix delivery, an adapter shrinks, and the invariants live on as the scorer and a benchmark.
- **Good:** one scorer serves arms A and B and baseline C alike.
- **Cost:** our code scores the trial. Mitigation: the frozen ground truth, synthetic controls and a manual cross-score.
- **Cost:** the principal pays one tap per item, since the channel can't prove he read anything. Owner-minutes are recorded.
- **Limit:** "exactly once" means at-least-once delivery plus dedupe (E1, E3) plus acknowledgement (E2). It is not a transport guarantee.
- **Risk:** Channels and agent view are research previews [S1, S3]. Adapters pin the version they were tested on.

## Verification this implies

1. **Invariant tests** for A1–A4, E1–E7 and V1–V4: pure, no I/O, with a fake clock. Each gets a negative control, a history that must produce its Violation.
2. **Architecture test:** the domain package imports no adapter, file-system, network or process module. It fails the build.
3. **Scorer controls** (from the Addendum):
   - the spec and ground truth are frozen by sha256 before any run;
   - one synthetic log per failure class must be flagged, and a clean log must pass, before any real log is read;
   - a manual score cross-checks it.
4. **Adapter contract tests** replay recorded vendor payloads: hook JSON, `permission_request`, `callback_query`, fleet-ledger v1. Each is pinned to the version it was recorded on.
5. **Trial probes**, because the docs leave these open (UNVERIFIED):
   - (a) Does a `PreToolUse` deny hold under `bypassPermissions`?
   - (b) Does a `PermissionRequest` "allow" answer a prompt forced by an ask rule? [S4] and [S7] read differently.
   - (c) Can a worker denied with "held for principal" wait and retry without a new ask?
6. **Manual QA** per Building rule 5, recorded outside this tree.
7. **Re-check triggers:**
   - Channels or agent view changes contract, or leaves preview;
   - firstmate closes #6034 or #1474;
   - the `/goal` evaluator gains tools.

## Sources (accessed 2026-09-30)

- [S1] https://code.claude.com/docs/en/channels
- [S2] https://code.claude.com/docs/en/channels-reference ("Notification format", "Relay permission prompts")
- [S3] https://code.claude.com/docs/en/agent-view
- [S4] https://code.claude.com/docs/en/hooks (PreToolUse and PermissionRequest decision control, Notification matchers, Stop)
- [S5] https://code.claude.com/docs/en/permissions ("Extend permissions with hooks")
- [S6] https://code.claude.com/docs/en/goal
- [S7] https://code.claude.com/docs/en/permission-modes
- [S8] https://github.com/kunchenguid/firstmate: README, `docs/fleet-ledger.md`, issues #6034 and #1474 (open; via `gh api`)
- [S9] https://github.com/kunchenguid/no-mistakes: README; latest release v1.84.0, 2026-09-26 (via `gh api`)
- [S10] https://code.claude.com/docs/en/legal-and-compliance
- [S11] https://core.telegram.org/bots/api (Bot API 10.3, 2026-08-24)

## Amendment (2026-09-30, cycle b)

Source: an internal decision record (§4.9, §5). The sections above stay as decided. Where they conflict with this amendment, the amendment wins.

1. **The scorer is research code, not domain code.** It is a script outside this repo, validated on the synthetic cases first, and it doesn't wait for the name. This replaces Decision 3.2's "its first consumer is the trial scorer".
2. **The core's first scope is the 7 invariants the scorer needs:** A2, A4, E1, E4, E5, V1 and V3. The rest (A1, A3, E2, E3, E6, E7, V2, V4) are deferred until evidence, as are Endpoint pairing, the Mandate lifecycle, Acknowledgement and the Done-means hash. This narrows Decision 4's cap and the invariant tests under Verification 1. `docs/domain.md` marks each invariant.
3. **A Record context is a candidate for ADR-0002, after the name.** It would be the owner's record: approvals with provenance, worker claims, and checks run by someone other than the worker on a named commit. The three contexts would become projections of it. It is not adopted yet.
