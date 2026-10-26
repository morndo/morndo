# ADR-0028: Codex as an engine: its own sign-in, an unattended turn, usage through its app server

- **Status:** Accepted with the pull request that adds it, 2026-10-15.
- **Number:** 0019 to 0027 are taken on `main` or on open pull requests.
- **Builds on:** ADR-0001 (logins stay the CLI's own), ADR-0013 (the engine layer), ADR-0016 (Usage), ADR-0018 (Connections, runtime adapters, CN5), ADR-0024 (usage from other vendors, proposed), ADR-0027 (engines by role).

## Context

1. **Codex is already a runtime.** The Connections context has its adapter (`runtime-codex.ts`), the catalog has a `codex` subscription and two key presets, and the engine layer runs `codex exec` turns in its engine lane. What was missing: a sign-in that works on a machine without a browser, a guard that keeps a subscription turn off an API key, a posture for an unattended turn, and the account's usage on Home.
2. **Sign-in.** `codex login --device-auth` signs in by device code. It is a beta that is first turned on in ChatGPT's security settings (personal account) or by a workspace admin [S1]. Credentials stay under `CODEX_HOME` (default `~/.codex`), in `auth.json` unless `cli_auth_credentials_store` says `keyring` or `auto` [S1].
3. **A key in the environment wins.** `codex exec` reads `CODEX_API_KEY` before any stored login: "API key via env var takes precedence over any other auth method" [S5].
4. **An unattended turn.** `codex exec` never asks for approval ("Default to never ask for approvals in headless mode") [S6]. It runs in a read-only sandbox by default; `--sandbox workspace-write` allows edits; `danger-full-access` is "only in a controlled environment" [S2]. In `workspace-write` the network is off unless `sandbox_workspace_write.network_access` turns it on [S7]. `codex exec resume` takes no `--sandbox`, only `-c sandbox_mode=…` [S8].
5. **Usage.** The `codex exec --json` stream carries token counts, not plan windows [S9]. The CLI's app server answers `account/rateLimits/read` with `rateLimits.primary` and `secondary`, each `{ usedPercent, windowDurationMins, resetsAt }`, `resetsAt` in Unix seconds, plus `planType` [S3]. The app server is experimental: it and its WebSocket transport "aren't supported for production workloads" [S3]. Pro plans "currently have no five-hour limit" [S4].
6. **Terms.** OpenAI recommends API keys for automation: "API keys are the right default for automation", and ChatGPT-managed auth in CI is the "advanced" path, "Do not use this workflow for public or open-source repositories" [S1, S2].

## Decision

1. **Codex stays at the edges.** No domain type names it. The Connections context holds its runtime adapter and a usage reader; lanes run it as an engine of the node's `policy.engines.launch` (ADR-0027) through the engine layer, with no node-agent code; Home takes its usage through ADR-0016's route.
2. **The sign-in is the CLI's own.** Morndo shows `codex login --device-auth` for a subscription, with the note to turn device code on first, and never reads, copies or moves `auth.json`. A keyring login stays refused: a run in its own `CODEX_HOME` can't find the entry.
3. **No key reaches a subscription turn.** Every Codex child Morndo starts gets `childEnv`, which keeps no `OPENAI_*` or `CODEX_*` variable but `CODEX_HOME`. The engine lane drops `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` and `OPENAI_API_KEY` from its turns.
4. **An unattended lane turn runs with full access.** `-s danger-full-access` on the first turn and `-c sandbox_mode="danger-full-access"` on a resumed one, with approvals never asked: the posture of Claude Code lanes, which run without permission prompts. The Connection's isolation floor stays `none` until a read-deny is verified on Linux (ADR-0018's open check).
5. **Usage through the app server, read on the node.** `morndo-keys usage --connection <name>` starts `codex app-server` on stdio, sends `initialize` and `initialized`, then `account/rateLimits/read`, and prints the status-line JSON:
   - a 300-minute window is the 5-hour window and a 10,080-minute window the 7-day window;
   - any other set of windows goes out as named windows;
   - nothing is printed when the read fails or the answer has a shape this version doesn't know.

   A program on the node posts it under an agent token, as status lines do. This is ADR-0024's bridge on one machine. When that ADR's source runner lands, the reader becomes its Codex source, standing "documented, experimental".

## Alternatives

| Option | Verdict |
|---|---|
| **The session files' `token_count` events** (`$CODEX_HOME/sessions/…`) | Rejected. An internal file format, and fresh only after a turn ran. |
| **The TUI's `/status` screen** | Rejected. ADR-0024 §4: never read a terminal's screen. |
| **`workspace-write` for lane turns** | Not now. The network is off by default there, so a lane can't install or push. Revisit with a permission profile that denies secret paths once it is verified on Linux. |
| **An API key by default** | Rejected as the default for a principal's own subscription. Keys stay available through the `openai` preset. |
| **A Codex lane runner in the node agent** | Not now. The engine layer already runs Codex turns and posts the hooks lanes rely on. |

## Consequences

- **Good:** a Codex account is connected, run and watched the way the other accounts are, and a stray key can't bill a subscription turn.
- **Cost:** one usage reader and one CLI command in Connections; a launch entry and a device-code sign-in per node.
- **Limit:** a Codex lane can read every file its user can; Claude Code and Cursor lanes have deny lists. A permission profile or a `PreToolUse` hook closes this later.
- **Limit:** the app server is experimental. A shape this reader doesn't know shows "unavailable", never a guess, and a Codex update is checked against its JSON schema before it goes live.
- **Limit:** a report invents one session per account (`<name>-limits`), as ADR-0024 notes for every bridge.

## Sources (read 2026-10-15)

- [S1] https://learn.chatgpt.com/docs/auth (from developers.openai.com/codex/auth)
- [S2] https://learn.chatgpt.com/docs/non-interactive-mode (from developers.openai.com/codex/noninteractive)
- [S3] https://learn.chatgpt.com/docs/app-server
- [S4] https://learn.chatgpt.com/docs/pricing
- [S5] https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/login/src/auth/manager.rs
- [S6] https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/exec/src/lib.rs
- [S7] https://learn.chatgpt.com/docs/sandboxing
- [S8] `codex exec resume --help`, codex-cli 0.161.0
- [S9] https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/exec/src/exec_events.rs
