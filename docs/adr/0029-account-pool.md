# ADR-0029: An account pool per runtime: pinned by default, rotation on the principal's word, one writer per session

- **Status:** Accepted with the pull request that adds it, 2026-10-15.
- **Builds on:** ADR-0016 (Usage, U4), ADR-0018 (Connections, CN1, CN3, CN5, CN15), ADR-0027 (engines by role, `{account}`), ADR-0028 (Codex as an engine).
- **Rules:** PL1 to PL14 in `docs/domain.md`.

## Context

1. The owner runs several subscriptions of one CLI and wants Claude's flexibility for Codex too: an account chosen per lane, usage watched, and a lane that goes on when an account is full. On his box, `claude-pool` does that for Claude, outside Morndo.
2. No Morndo context may decide it. Usage decides nothing (U4). A Connection grants nothing and leaves which one runs to routing (CN15). Chains and priorities are "not a rotation".
3. Codex 0.161.0 [S1–S6]:
   - The login lives in `CODEX_HOME/auth.json`.
   - Token refresh is locked only inside one process. The docs allow "one machine or serialized job stream" per `auth.json`.
   - Thread writer locks are per `CODEX_HOME`.
   - Sessions are JSONL under `sessions/`, plus a SQLite index whose place `sqlite_home` sets.
   - A usage limit ends a headless turn with `turn.failed` and exit 1.
   - The app server reads each account's windows, `ordinaryUsageAllowed` and reset credits with no model request.
   - Nothing spends a reset credit without an explicit request.
   - Whether a session resumes under another account is not settled.
4. Terms [S7]: the EU Terms forbid "circumventing any rate limits or restrictions". OpenAI recommends API keys for automation.

## Decision

1. **A Pool context** (`packages/domain/src/pool.ts`) owns one decision: which member account runs a session's next turn. It also owns the rules around that: seat states, one account behind two homes, marks, placement, claims, one turn per sign-in, and reset advice. It has no vendor name. Runtime specifics are adapters in `apps/connections`.
2. **Pinned by default.** A session keeps the account it was pinned to (`--account` at lane start, through ADR-0027's `{account}`), or the pool's default account. **Rotate** (weighted round robin by the quota that expires first, plus a move as the same turn's continuation at a usage limit) is turned on only by the principal, naming who decided.
3. **One sign-in home per account. Run homes link the login and one shared conversation store.** No token is copied. Codex's own writer lock directory is shared too.
4. **One turn at a time per account**, usage reads included. Raising that is the principal's call.
5. **Usage from the app server**, every 15 minutes and after a usage limit. A mark ends only when the backend allows ordinary use again.
6. **Reset credits are only advised.** Spending one is the principal's command, and one module names the method.
7. **No engine-layer code change.** Its provider's binary is a wrapper around `morndo-keys pool exec`.

## Alternatives

| Option | Verdict |
|---|---|
| Rotation on by default | Rejected. The Terms forbid circumventing rate limits; it is the principal's legal call. |
| Copy `auth.json` between homes, or one home with swapped logins | Rejected. Copies die when a refresh rotates the token (and `--device-auth` revokes the old one), and a swap races running turns. |
| Grow `claude-pool` to Codex | Rejected. It is the live system and outside the product, and its tmux steps don't fit turn-per-process lanes. |
| Accounts as separate engine-layer providers | Not possible without engine-layer code: engine-lane only runs providers named after an adapter. |
| Read usage from the rollout's `token_count` | Rejected, as in ADR-0028: an internal format. |

## Consequences

- **Good:** two accounts are watched, placed and shown on Home like one. A session never has two writers, and no reset is spent behind the owner's back.
- **Cost:** a pool table, a service, four Codex adapters, one CLI command, a launcher script and two settings on the node.
- **Limit:** pinned mode can't keep a lane going past its account's limit. That is the point.
- **Limit:** moving across accounts may need a handoff, which loses the session's context (PL14).
- **Limit:** the engine layer still marks the whole `codex` provider for an hour after a usage limit.

## Sources (read 2026-10-15)

- [S1] https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/login/src/auth/storage.rs, `auth/manager.rs`, `cli/src/login.rs`
- [S2] https://learn.chatgpt.com/docs/auth/ci-cd-auth
- [S3] https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/rollout/src/writer_lock.rs, `rollout/src/list.rs`, `thread-store/src/local/thread_rollout_resolver.rs`, `config/src/config_toml.rs`
- [S4] https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/protocol/src/error.rs, `exec/src/event_processor_with_jsonl_output.rs`
- [S5] `codex app-server generate-json-schema`, codex-cli 0.161.0: `GetAccountRateLimitsResponse`, `ConsumeAccountRateLimitResetCreditParams`
- [S6] https://github.com/openai/codex/issues/13724
- [S7] https://openai.com/policies/eu-terms-of-use/ (snapshot 2026-10-11), https://learn.chatgpt.com/docs/auth
