# ADR-0018: LLM connections: the user registers subscriptions and API keys and decides the order they run in; keys stay sealed on their node

- **Status:** Proposed, 2026-10-10, revised the same day after the owner's review (v2). Design: [`docs/design/secret-store/README.md`](../design/secret-store/README.md). Design only; no product code.
- **The requests:**
  - A sealed store for API keys, with an adapter so a run can use a key-backed vendor when the user wants one. Domain rules apply.
  - A fixed split that let some repositories use one vendor's keys and barred others was rejected. The user chooses which connection runs, including API keys only. One settings page registers subscription accounts and API keys, with a vendor list. The rest of the draft stands.
- **Number:** 0017 belongs to the background-jobs branch, not yet on `main`.
- **Builds on:** ADR-0001 (pure domain, anti-corruption adapters, no pooled logins), ADR-0008 (the shared redactor), ADR-0012 (FL14), ADR-0013 (engines through the engine layer's CLI; this extends its page), ADR-0015 (agent tokens), ADR-0016 (Usage grants nothing).
- **Sources:** [S1]–[S24] in the design, section 15, all checked 2026-10-10.

## Context

1. **Keys arrived before a place for them.**
   - A wrapper can export an API key and then start the CLI, so the key is in the environment of every command that agent runs.
   - In `-p` mode an inherited key "is always used when present" [S1], so a subscription run started from there would bill the key.
2. **Morndo's own guards miss them.** The node's file rules match neither the key files nor their directory, and the redactor knows no API-key shape.
3. **The user chooses, and is not chosen for.**
   - v1 classified repositories and let a per-provider data policy decide which key could see which repo. That was rejected.
   - One place registers subscription accounts and API keys, with a vendor list, and a priority the user sets. For example, API keys only.
4. **The engine layer already runs role chains** (ADR-0013): `provider:model@effort`, first available wins, marks take a provider out until a time. It knows the subscription CLIs (`claude`, `codex`, `cursor`, `agy`) and one key-backed provider (`cursor-cloud`). It has no command to add a provider.
5. **The vendors offer the hooks.**
   - Claude Code's `apiKeyHelper` output goes out "as both the `X-Api-Key` and `Authorization: Bearer` headers" and is refreshed after a TTL or on a 401/403 [S2].
   - Codex has `model_providers.<id>.auth.command` [S18].
   - `claude auth status` reports `authMethod` and `configDirectory` as JSON [S2]. Codex and the Cursor agent have their own status commands [S18, S24].
   - DeepSeek, Kimi and OpenRouter serve Anthropic-compatible endpoints [S14, S16, S17]; Anthropic doesn't support those routes [S4]. Every vendor in the catalog lists its models over HTTP [S23].
6. **This machine** (WSL2, systemd 255, no TPM, no keyring daemon) can't use systemd-creds per user [S10]. Morndo must also run on macOS and small VPSes.

## Decision

1. **"LLM connections" is the user-facing concept.** A Connection is a subscription account or an API key, registered by name.
   - **Subscription:** Morndo refers to the CLI's own sign-in (its config directory) and never stores its token.
   - **API key:** sealed in the node's Vault. It carries a Budget, a Billing (`metered` or `prepaid`) and an optional Expiry.
   - Runtimes are named as the engine layer's adapters are: `claude`, `codex`, `cursor`. The engine layer's other providers (`studio`, `cursor-cloud`, `agy`) become Connections in its custody: the Priority orders them, but no gate, budget or repo list reaches their runs.
   - One settings page, **LLM connections**, extends the Engines page (ADR-0013) at its route, with three sections: Connections, Priority, Roles. It comes after a complete CLI, `morndo-connections`, and both take their words from one table in `packages/protocol`.
2. **Two bounded contexts.**
   - **Connections** (new; v1's Credentials): the Connection aggregate with its open Leases, Vendor presets as reference data, the Lease gate, and invariants CN1–CN15.
   - **Engines** (ADR-0013, extended): the **Routing policy** aggregate, holding the global **Priority**, a per-role **Override** (`follow`, `own`, `hand`) and per-role **Picks**, with invariants R7–R15.
   - **Why the Priority sits in Engines:** it is about roles and chains, which Engines already names (R1–R6), and a Connection should know nothing about roles (CN15).
   - **Why keys are not a context of their own:** the gate decides on a Connection's status, terms, repo list, isolation and budget as one consistency boundary.
   - `packages/domain/src/connections.ts` and `routing.ts` are pure. `apps/connections` holds the services, the ports and the adapters for both.
   - The ports: `SecretVault`, `Runtime`, `ModelLister`, `SpendMeter`, `Catalog`, `Clock`, `ConnectionStore`, `RepoInspector`, `AlertSink`, `Processes`, `EngineSettings`.
3. **The Priority is a value object: a mode and an order of Connection names.**
   - The modes: `subscriptions-first` (keys as overflow), `keys-first`, `subscriptions-only`, `keys-only`, `custom` (the order as given).
   - A Role's derived chain is its Picks, filtered to the Connections in its effective order and stably sorted by it; risk chains the same way from risk Picks. A `hand` Role keeps its Picks as its chain, exactly as ADR-0013 edits it today.
   - A save is checked over the Roles it changes: each derived chain gets 1 to 8 entries, and each new Pick fits its Connection's model list. `hand` Roles keep ADR-0013's leeways.
   - Availability (off, expired, out of budget, signed out, terms pending) never reorders: the engine layer skips such entries through probes, marks and the exit code 75.
   - A new Connection goes to the end of the global order. Once it can run, each non-`hand` Role gets its preset's default Pick, where the model is listed and the chain stays within 8.
   - Every policy change is a principal Command. `role --all follow` puts every Role under the global Priority in one step and shows each chain before and after.
4. **Chains are projected, not owned.**
   - Each Connection is one engine-layer provider of the same name. Morndo writes derived chains only through the engines CLI, and records what it wrote.
   - A derived Role's chain changed outside Morndo makes it drifted. Morndo doesn't overwrite it until the principal re-applies the policy or keeps the outside chain as `hand`. A `hand` Role's Picks are read back from the engine layer, so editing one anywhere is never drift.
   - From PR 7 the hub's page saves Roles through the same service, not through its own `engines set`.
   - Only structural changes re-derive: a policy change, a Connection's terms first acknowledged with its model list read, a Connection revoked. A revocation that would empty a chain keeps the last one written, with an Alert. A revoked provider stays registered, failing its probe, until no chain names it.
5. **Vendors are data.**
   - `packages/protocol/catalog/vendors.json`, plus the user's own file for custom endpoints, validated by a schema. Each preset holds the runtimes with dialect and base URL, the model list source, the family, the spend sources, dated prices, default Picks, an isolation floor, and the data terms (revision, summary, sources).
   - Shipped: `anthropic`, `openai`, `deepseek`, `moonshot`, `zai`, `openrouter`, `custom-anthropic`, `custom-openai` (both with a base URL), and subscriptions for `claude`, `codex`, `cursor`. Balances and key usage are read by one adapter driven by each preset's endpoint and field.
   - A test fails if a vendor name appears in domain or application code.
6. **Hard rules: only those that are not choices.**
   - **Secrets and credentials go to no provider** (CN5), on every Connection, as far as its runtime lets Morndo enforce it. Morndo never puts one into a prompt, an argument, a workspace, a lane's environment or a log. Under `rules`, the CLI's own file tools are denied the vault, the database, every agent CLI's credential directory and node-ops' secret paths. Under `os`, the sandbox denies them to every tool command. The preset's isolation floor belongs to this rule and no setting lowers it (Q3). A Connection without `os` says on its row that tool commands can read the user's files.
   - **Terms first** (CN4): a Connection can't run (shown as "terms not read") until the principal acknowledges its preset's current terms revision; a new revision asks again. For a Connection in the engine layer's custody, Morndo keeps its provider off until then.
   - **An optional repo allow/deny list per Connection** (CN7). Setting one also sandboxes the run (CN6), so it binds tool commands.
   - The automatic data classes, the per-provider data policies and the soonest-expiry pick are removed.
7. **Every run is a Lease, recorded before use.**
   - The gate, in order: status on, terms acknowledged, (key) not expired, the repo list admits the workspace, the isolation is available, the dialect matches, open Leases are under the limit, (key) the budget leaves a reservation.
   - A refusal is recorded with its first reason and exits 75. The launcher exits 70 only when the store failed before the child started; a child's own 70 or 75 comes out as 1. `LeaseClosed` carries the Spend and its source.
8. **Keys stay on their node and reach a runtime only through a helper.**
   - The default store is age files with a machine identity: one file per Secret under `~/.local/share/morndo-connections/vault/`, encrypted to `~/.config/morndo-connections/identity` (0600), using `age-encryption` 0.3.1, BSD-3-Clause [S11]. Plain 0600 files remain an adapter for migration.
   - Claude Code gets `apiKeyHelper` through `--settings`, and Codex gets `auth.command`. Both call `morndo-connections helper --lease <id>`, which serves only an ancestor Holder of an open Lease. Both refresh every 60 s. The number of calls allowed per interval is measured in PR 4, since Claude Code retries a failing helper up to three times [S1]; a call past it ends the Lease.
   - Only metadata crosses the fleet. A key is added on the machine, from stdin.
9. **If Q2 is yes, subscriptions run through the same gate** (PR 6, one provider at a time, with the old command as rollback).
   - The launcher strips every inherited API-key variable, points the CLI at its own config directory or the command used before (`claude-as` on this box), and checks the CLI's auth method at start. A subscription run therefore never bills a key.
   - Usage windows (ADR-0016) are shown beside it and decide nothing.
10. **Budgets and expiry.**
    - Spend is append-only. Warnings fire once at 50/80/95 % and 7/2/1 days. A headless Claude Code run is capped at its reservation with `--max-budget-usd` [S2]. Interactive and Codex runs have no in-run cap; where the vendor reports nothing, such a run is charged its whole reservation when it closes, until a manual figure replaces it.
    - Widening is judged by effect: a Connection may afterwards run at all, in more workspaces, spend more, run longer, or run with less isolation. It is the principal's (hub step-up, or a typed confirmation at the machine). Narrowing is anyone's, turning a Connection off included. Revoking is the principal's, since it can't be undone.
11. **What we ask the engine layer for** (additive): an `adapter` field; `bin` as an argv list; `--role` and `--lane` passed to `bin`; exit 75 treated like `billing`; and `engines provider set|remove`. Headless `bg-wake` runs need none of them.
12. **Order:** PR 0 (file rules and redactor), domain, application, storage, the key CLI with the runtime adapters and then the migration of the two keys, the policy CLI with the projection, subscriptions through the gate, and the web page. Each PR has its done-check in the design, section 13.

## Alternatives

| Option | Verdict |
|---|---|
| **v1: repo classes and a data policy per provider** | Rejected by the owner. It decided for him which key could see which repo. A per-Connection repo list keeps the guard for those who want it. |
| **One Credentials context, Priority included** | Rejected. Roles and chains are the Engines context's language. The key store would learn what the work is, and the chain rules would live in two places. |
| **Keys (custody) as a context apart from Connections** | Rejected. The gate's checks are one invariant on one Connection; split, they would span two stores. |
| **The engine layer applies the Priority at resolve time** | Not now. It would put the domain rule into another repo in another language, and that repo has no notion of Kind. If the engine layer moves into Morndo or offers a `priority` section, only the projection adapter changes. |
| **Morndo rewrites chains on every availability change** | Rejected. Availability already has its mechanism (probes, marks, exit 75). Rewriting would churn the file and race the resolver. |
| **Hand-coded vendor adapters, one per vendor** | Rejected. A vendor is data plus a reused runtime adapter: two runtime adapters (`claude`, `codex`) cover every shipped key preset. |
| **Keep the automatic soonest-expiry pick among prepaid keys** | Dropped. The order is the user's; the page hints when a later key expires sooner. |
| **Store subscription tokens too** | Rejected. Logins stay the CLI's own (ADR-0001). |
| **A local Cursor key** | Later. Its only documented routes are an environment variable or a flag [S24], which every tool command would inherit. |
| **systemd-creds, Secret Service, SOPS, a hosted vault, one vault on the control plane** | As in v1: root-only or Linux-only here [S10, S13]; needs an unlocked desktop keyring [S12]; no gain on one machine; another sign-in per node; keys would cross the fleet (FL14). |
| **An environment variable at spawn for Claude Code** | Rejected. Every Bash command, hook and MCP server inherits it unless scrubbed, and the scrub would also take `MORNDO_AGENT_TOKEN` (unverified) [S3]. |
| **A local gateway holding the key** | Deferred: the 10x version. It isolates only when it runs as another user, and it adds a proxy to every request [S4]. The ports allow it. |

## Consequences

- **Good:** the owner registers what he has and decides the order: "API keys only" is `role --all follow` and `priority set keys-only`, or two clicks. A Role keeps working through the order as keys run out or expire.
- **Good** (if Q2 is yes): subscription runs can no longer bill a stray key silently, and every run Morndo starts, key or subscription, is on record.
- **Good:** a new vendor is a catalog entry, not code. The gaps found in passing close first (PR 0).
- **Cost:** a new app, five additive asks of the engine layer, one npm dependency (`age-encryption`), and `bubblewrap` and `socat` on nodes that run sandboxed Connections.
- **Cost:** the policy and the chain live in two places. Drift is detected and never overwritten, but the window before a write lasts until the engine layer offers a compare-and-set.
- **Limit:** same-user processes are trusted. Under `rules` isolation, a tool command can call its run's helper; that is detected (CN9), not prevented.
- **Limit:** Codex's read-deny (beta permission profiles [S18]) is unverified on Linux, so Codex offers `none` until PR 4 checks it. Until then, OpenAI keys through Codex are refused by the gate.
- **Limit:** spend on Anthropic and OpenAI keys is a client-side estimate, and interactive and Codex runs have no in-run cap. Budgets keep a margin.
- **Risk:** third-party routes are unsupported by Anthropic and change fast. Unknown DeepSeek model names silently fall back to `deepseek-flash` [S14], so Picks must come from the model list and each Lease checks the model it got.

## Verification this implies

1. Invariant tests for CN1–CN15 and R7–R15 with a fake clock and vault, one negative-control history per invariant, and a derivation table over every mode.
2. The architecture tests: shape and wire allowlists, the app's layering, the plaintext type, no vendor names in code, file rules and redactor. Each has controls that must fail.
3. An end-to-end run against a local fake Messages API that records headers:
   - the key arrives only as the helper's header;
   - `env` inside the run shows no key;
   - a Lease whose Connection is turned off fails within one TTL, and helper calls are counted to set the allowance;
   - unacknowledged terms and a denied repo refuse with 75 and fall through;
   - a subscription run with a stray key in its parent's environment still runs on the subscription;
   - a sandboxed read of a denied path fails.
4. Projection: after `role --all follow`, `priority set keys-only` changes `engines get`, risk chains included; a terminal edit makes a derived Role drifted and is not overwritten; revoking the only key keeps the last chain and raises an Alert.
5. Manual QA in `qa/<date>.md`: import the two keys on a scratch HOME first, then a week of reviews through the store with spend matching the old log, then the page's screenshots.
6. Re-check triggers: Claude Code changes its credential order, its helper or `auth status`; a vendor changes its endpoint, models or terms (a new terms revision in the catalog); Codex's permission profiles leave beta; systemd ≥ 256 or a TPM reaches the nodes.
