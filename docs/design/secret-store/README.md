# LLM connections: the subscriptions and API keys a user registers, the order they are used in, and a store for the keys (design v2, 2026-10-10)

**Phase: design only.** This document and [ADR-0018](../../adr/0018-secret-store-and-api-key-providers.md). No product code yet.

**v2, after review:** a fixed split that let some repositories use one vendor's keys and barred others was rejected. The user chooses which connection runs, including API keys only. One settings page registers subscription accounts and API keys, with a vendor list. The rest of the draft stands.

What changed from v1:
- The user-facing concept is an **LLM connection**: a subscription account or an API key, registered on one settings page that extends the Engines page (section 11).
- The user decides what runs through an ordered **Priority** (section 3.4). It replaces v1's automatic data classes, the per-provider data policies and the soonest-expiry pick.
- Vendors are a data catalog behind a drop-down (section 8).
- Subscriptions are registered too: Morndo refers to the CLI's own sign-in and stores no token; if Q2 is yes, they run through the same gate (section 6.1).
- The CLI is `morndo-connections`.

Kept: the user chooses which connections run, including an API-key vendor when they want one; `bubblewrap` and `socat` are optional isolation tools; a replaced key is removed after a week of matching spend; keys are added only on the machine that uses them.

**v2 review.** A fresh-context review of this draft found twelve problems, each checked against the code or the docs and folded in: CN5 overstated what `rules` and `none` runtimes enforce; the shim's `exec` left nothing to fall back from; terms and Status shared one field; the reservation capped only headless Claude Code; risk chains and the engine layer's other providers had no place; anyone could revoke a key for good; R11 and R15 allowed empty or over-long chains and ignored `hand` Roles' leeways; widening wasn't judged by effect; the hub's page would have written chains past the policy; a once-per-interval helper rule contradicted Claude Code's documented retries [S1]; Q1's default hid the headline; and runtime ids didn't match.

**v1 review.** A fresh-context review of the first draft found ten material problems, each checked against the code and folded in: a tool command can call its own run's helper (a stated limit, detected by CN9); `exec` left no parent to close a Lease (now a child it waits for); refused spawns didn't fall through (ask 4); concurrent Leases could overspend (the reservation is the cap); the migration fallback bypassed the gate (store failures only); two ports were missing (`Processes`, `EngineSettings`); a re-imported key could dodge the widening rule (Fingerprint dedupe); two invariants disagreed on names; and the app's architecture test let time and I/O globals through.

**The first request:** a sealed store for API keys, with an adapter so a run can use a key-backed vendor when the user wants one. Domain rules apply. Standing rule: Morndo features are universal, not fitted to one box.

**Builds on:** ADR-0001 (pure domain, anti-corruption adapters, no pooled logins), ADR-0005 (stack, `packages/domain`), ADR-0008 (the shared redactor), ADR-0012 (FL14: no credential of an agent CLI crosses the fleet), ADR-0013 (engines through the engine layer's CLI only; this design extends its page), ADR-0015 (agent tokens, Actors), ADR-0016 (Usage per account, which grants nothing).

Facts carry a source and the date checked. **[S*n*]** points to section 15. UNVERIFIED marks what no primary source settled, and **Q*n*** is open question *n* at the end.

## 1. What we looked at first

Read against the installed CLIs and Morndo's file rules. No key file was opened and no key value was printed.

- **Keys beside the product.** A machine may already hold API keys in private files, with a small wrapper that puts one in the environment and then starts the agent CLI. A usage log may record cost per run.
- **What an inherited environment can do.** A CLI that prefers an API key when one is set will bill that key even for work meant to use a subscription, because in `-p` mode the key "is always used when present" [S1]. The store must hand a key only to the process that needs it.
- **Morndo's file rules.** `SECRET_NAME` in `packages/node-ops/src/file-rules.ts` matches common secret filenames, not every private name a user might pick, and `denyRoots` does not list every config directory a key file might sit in. PR 0 closes that gap.
- **The redactor.** `packages/protocol/src/redact.ts` redacts bearer tokens, PEM blocks and named JSON fields, not a bare API-key shape in free text.
- **The engine layer** (`engines providers --json`): subscription CLIs and key-backed providers, adapters chosen by provider name, a way to mark a provider out until a time, and no help text for adding a provider entry.
- **Layering.** Architecture tests exist for `domain`, `protocol` and `node-ops`. The hub's application layer imports its adapters, so an app-level rule starts in the new app.
- **The kind of machine.** A Linux user session that can run user services, with the agent CLIs installed. Optional tools (`age`, `bwrap`, `socat`, `secret-tool`) are not assumed.

## 2. Goals and non-goals

**Goals.**
- One place per machine where the user registers what his agents may run on: his subscription accounts (Claude, Codex, Cursor, and the others the engine layer knows) and his API keys (any vendor in the catalog, or a custom endpoint).
- **He decides the order they are used in:** one global Priority, an optional one per role, and plain modes such as "API keys only", "subscriptions first, keys as overflow", or an order he sets by hand.
- Keys rest sealed and reach only the process that needs them, at spawn. They never go into a prompt, a repo, a log or a chat.
- Every run is on record. Per-key budgets and expiry warn first, then fall through to the next connection in the order.
- A few hard rules that are not choices (section 10).
- The same words in the CLI and on the settings page.

**Non-goals.** Morndo stores no subscription token: signing in stays the CLI's own (ADR-0001). It decides for no repository which vendor may see it: there are no data classes, and a repo list per connection is the user's, if he wants one. No central vault: keys never leave their node (FL14). No isolation from processes of the same user in v1 (5.3). No fleet-wide Priority yet: v1 holds one per node.

## 3. The model

### 3.1 Two contexts, and why

- **Connections** (new; v1 called it Credentials): what the user can run on, plus the custody and metering of keys. It holds the Connection aggregate with its open Leases, the vendor catalog as reference data, and the Lease gate. Code: `packages/domain/src/connections.ts`.
- **Engines** (ADR-0013, extended): which AI does each role's work. It gains the **Routing policy** aggregate (a global Priority, a per-role Override, per-role Picks) and the derivation of chains. Code: `packages/domain/src/routing.ts`, beside `engines.ts`.

**Why the Priority is not in Connections.** A Priority orders work by role, and roles, chains and the fit of an engine are already the Engines context's language (R1–R6). Put into Connections, the Priority would teach the key store what the work is, and the chain rules would live in two places. A Connection knowing nothing about roles also keeps CN15 (it grants nothing) true by construction.

**Why keys are not a context apart from Connections.** The Lease gate decides on one Connection's status, terms acknowledgement, repo list, isolation and budget at once. Split, that one invariant would span two models and two stores. Custody (Vault, Secret ref, Fingerprint) stays inside, behind ports, and the plaintext type stays adapter-only (section 4).

**Relationship.** Engines is downstream (customer and supplier). It reads the Connections directory: name, kind, the vendor's family, runtime, models and availability. Connections never reads the Routing policy. One node-side program, `apps/connections` (`morndo-connections`), hosts both services, as the hub hosts several contexts.

### 3.2 Connections: ubiquitous language

| Term | Means | Is not |
|---|---|---|
| Connection | One thing the user registered that can run agent work, by name (`claude`, `credit1`, `deepseek-main`): Kind, Vendor, Runtime, Custody, Status, Terms acknowledgement, Repo list, Isolation, and for a key its Secret ref, Fingerprint, Billing, Budget and Expiry. | A sign-in token; a role. |
| Kind | `subscription`: Morndo refers to the CLI's own sign-in (its config directory) and stores no token. `api-key`: a key Morndo holds sealed in its Vault. Fixed at creation. | A vendor. |
| Custody | `morndo`: Morndo starts its runs (and, for a key, holds it). `engine-layer`: the engine layer starts its runs and holds whatever key it needs; today `studio`, `cursor-cloud`, and `agy` until it has a runtime adapter. Such a Connection is ordered by the Priority like any other, but the gate, budgets and repo lists don't reach its runs. | A Kind. |
| Billing | Of a key: `metered` (billed as used) or `prepaid` (a credit grant that expires). | A Budget. |
| Vendor preset | One entry of the vendor catalog (data, section 8.1): kinds offered, runtimes, dialect, base URL, model list source, family, spend sources, default Picks, data terms, required Isolation. | Code. No vendor name appears in the domain or the application. |
| Runtime | The agent CLI a run starts, named as the engine layer's adapters are: `claude` (Claude Code), `codex`, `cursor` (Cursor agent). One id set, in the words table. | The model. |
| Status | Stored: `on` (the default at creation), `off` (anyone turned it off; reversible), `revoked` (the principal ended it; permanent). | Availability; the terms. |
| Availability | Derived when asked: signed in or not (subscription), expired, out of budget, terms changed, runtime missing. It goes to the engine layer as its probe and marks. | A promise that a run will succeed. |
| Terms acknowledgement | Its own field: the principal's record that he read the preset's data terms at one revision (who, when, which revision). Without one at the current revision the Connection can't run, whatever its Status. | An agreement with the vendor; that is his account. |
| Repo list | Optional, per Connection: allow and deny patterns over git remotes (`host/owner/repo`, globs) and path prefixes. | A class Morndo infers. |
| Isolation | What a run on this Connection gets: `rules` (the CLI's own deny rules) or `os` (an OS sandbox that can't be turned off from inside the run). A runtime that can deny neither offers `none`. | A separate user account. |
| Secret, Secret ref, Fingerprint | As in v1. The bytes are held only by the Vault and the process a Lease starts. The ref is an opaque random id. The Fingerprint is 12 hex characters of SHA-256 over the Secret, computed in an adapter. | Anything the domain, the hub, the fleet, a log or an event holds. |
| Budget, Spend, Expiry | Of a key. The Budget is the most it may spend (stated, never unlimited by default). Spend is an amount with its source (`provider`, `manual` or `estimate`). Expiry is the instant after which it is never leased. | The vendor's own limit, which stays the backstop. |
| Lease | Permission for one Holder to run once on one Connection: role label, engine entry, Runtime, workspace, Isolation, start, end, outcome, Spend. Every run, on a subscription or a key. A `probe` Lease (model list, balance) starts no runtime and reserves nothing. | A Mandate. |
| Holder | The runtime process a Lease was granted to: node, pid, start ticks, boot id, and the lane it claims. | Proof of who the lane is. |
| Vault | Where Secrets rest, sealed. | The Connections database, which holds no Secret. |

### 3.3 Connections: invariants

| # | Invariant |
|---|---|
| CN1 | No Secret and no sign-in token in the model. A key Connection holds a Secret ref and a Fingerprint. A subscription Connection holds at most the path of the CLI's config directory. No domain type, wire shape, event, audit row or log line carries more. |
| CN2 | Names follow the engine layer's grammar (`[a-z][a-z0-9-]*`). They are unique on a node, revoked ones included, and never reused. A Connection's name is its engine-layer provider name. A new Secret under an active key's name is a Rotation: history, Budget and Spend stay, the Fingerprint changes. An add or a Rotation whose Fingerprint matches any other Connection, revoked included, is refused. |
| CN3 | Kind, Vendor and Runtime are fixed at creation. A subscription has no Secret ref, Budget or Expiry: its limits are the vendor's, and Usage shows them (ADR-0016). A key in Morndo's custody has a Secret ref, a Fingerprint, a Billing, a Budget ("unlimited" only as a stated choice) and an optional Expiry, required when prepaid. A Connection in the engine layer's custody has none of them in Morndo. |
| CN4 | **Terms first.** A Connection can't run until the principal acknowledges its preset's current terms revision; to the user it shows as off, "terms not read". A new revision ships only in a Morndo release, whose notes and `check` name the Connections it will stop. Once installed, those become unavailable (`terms changed`) and raise an Alert until he acknowledges again. A custom preset's terms are `unknown`, and the acknowledgement records exactly that. For a Connection in the engine layer's custody, which the gate doesn't reach, Morndo keeps its provider off (`provider set`, ask 5) until the acknowledgement. |
| CN5 | **Secrets go to no provider, as far as the runtime lets Morndo enforce it.** (a) Always: no Secret is ever an argument, a prompt, a workspace file, a lane's environment variable, a log line or a chat message; a helper hands it to the runtime process only. (b) Under `rules` and `os`: deny rules on the vault, the identity, the Connections database, every agent CLI's credential directory, and node-ops' deny roots and secret names, for the CLI's own file tools. (c) Under `os`: the sandbox denies the same to every tool command. Under `rules` a tool command can still read them [S5], and under `none` only (a) holds. Each Connection's row says which applies. No setting lowers (a), (b), or a preset's Isolation floor (CN6). |
| CN6 | A run gets at least its preset's Isolation floor, `os` when its Connection has a repo list, and whatever more the principal set, never less. A Runtime that can't give it here (no `bwrap`, or Codex before its read-deny is verified) refuses the start rather than run with less. |
| CN7 | The repo list is optional. With none, every repository is allowed: the user decides, Morndo infers nothing. Deny wins over allow. With an allow list, only matches pass. It is checked against the workspace's real path and its git remotes. |
| CN8 | **The Lease gate**, in this order: Status is `on`; the terms are acknowledged at the current revision; (key) now is before the Expiry; the repo list admits the workspace; the Runtime can give the required Isolation here; the Runtime speaks the preset's dialect; fewer Leases are open than the Connection allows; (key) Budget minus Spend minus open reservations minus a margin leaves a positive reservation. The reservation is the smaller of the role's reserve and that remainder. It caps a headless Claude Code run; other runs are bounded only by the helper's refresh and the vendor's limit (7.2). Otherwise the gate refuses with the first reason that failed, records the refusal, and exits 75 so the engine layer falls through to the next entry of the chain. |
| CN9 | Recorded before use. `LeaseGranted` is durable before any adapter opens a Secret. A credential helper serves the Secret only to an open Lease whose Holder (pid, start ticks, boot id) is among its ancestors, at most N times per refresh interval. N is measured in PR 4 (subagents, a forced 401, a refusal), since Claude Code reruns the helper on any 401 or 403 and fails a request "within three attempts" when it fails [S1, S2]; until then it is UNVERIFIED. A call past N raises an Alert and ends the Lease. Calls after a refusal or a close are answered "refused" and are no misuse. The ancestor check can't tell the runtime from its own tool commands (5.3). |
| CN10 | Spend is append-only. Spent = the newest `provider` or `manual` figure plus every `estimate` recorded after it. An estimate never lowers it. |
| CN11 | When Spend plus open reservations reaches the Budget, no new Lease is granted, and every open Lease's next helper refresh is refused. A headless run is capped at its reservation (7.2). |
| CN12 | Warnings fire once each per Connection: at each budget fraction (default 0.5, 0.8, 0.95) and each lead time before Expiry (default 7, 2 and 1 days). Dedupe key: `connection:threshold`. |
| CN13 | **Narrowing is anyone's; widening is the principal's, judged by effect.** A change widens when afterwards a Connection may run at all (on, terms acknowledged), in more workspaces (a deny removed, an allow added to a non-empty list, the list removed), spend more, run longer, or run with less Isolation (down to the floor). Anything else narrows, and anyone may make it, turning a Connection off included. Revocation is the principal's, since it can't be undone (CN14). A principal's Command comes from the hub with step-up (AC7), or from the CLI on the machine with a typed confirmation and no `--yes`. The terminal path keeps scripts from widening by accident, but it can't tell the owner from an agent typing into a pane: same-user trust (5.3). |
| CN14 | Turning off and revoking both stop new Leases at once and open ones at their next refresh. Off is undone by turning on; a revoked Connection is never on again (CN2). The answer to a leaked key is therefore anyone's `off`, then the principal's `revoke` or `rotate`. |
| CN15 | Connections grant nothing (as U4, B8). Which Connection runs a role's work is the Routing policy's and the engine resolver's. A Lease is not a Mandate. No Spend figure decides anything but the Lease gate. |

Aggregate **Connection**, with its open Leases inside it: the gate's checks and the budget reservation are one consistency boundary. Closed Leases leave the aggregate as events. The **Vendor preset** is reference data, handed to the domain as a value. The **Workspace** (real path, git remotes) is a value an adapter reads.

### 3.4 Engines: the Priority and the Routing policy

| Term | Means | Is not |
|---|---|---|
| Pick | An engine a Role may run on: `connection:model[@effort]`. A Role keeps its Picks in its own order, and its risk Picks apart. | The chain. |
| Priority | A value object: a **mode** and an **order** of Connection names. The modes: `subscriptions-first` (keys as overflow), `keys-first`, `subscriptions-only`, `keys-only`, and `custom` (the order exactly as given). | A rotation; a budget rule. |
| Override | Per Role: `follow` (the global Priority), `own` (a Priority of its own), or `hand` (its Picks are its chain, edited as ADR-0013 does today). | A merge of two Priorities. |
| Routing policy | Per node, the aggregate: the global Priority, and each Role's Override and Picks. | The engine layer's settings file. |
| Derived chain | What the policy gives a Role. Morndo writes it to the engine layer as that Role's chain. | Availability. |
| Drift | A Role's chain in the engine layer that is not the one Morndo last wrote. | An error. |

The rules continue the Engines context's R1–R6 (ADR-0013):

| # | Invariant |
|---|---|
| R7 | A Priority's order has no duplicate names, and when saved every name is a Connection known on this node. |
| R8 | The effective order is the order filtered by Kind (`keys-only`, `subscriptions-only`), partitioned stably by Kind (`subscriptions-first`, `keys-first`), or as given (`custom`). Names unknown on this node drop out. Availability never reorders: a Connection that is off, expired, out of budget, signed out or awaiting terms stays in its place, and the engine layer skips it, with its probe saying why. |
| R9 | A Role follows the global Priority unless its Override is `own` (its own Priority replaces the global one; they don't merge) or `hand`. |
| R10 | A Role's derived chain is its Picks, kept only where the Pick's Connection is in the Role's effective order, then stably sorted by that order. Picks on one Connection keep the Role's own order between them. A `hand` Role's chain is its Picks, as they are. The risk chain is derived the same way from the risk Picks; a Role with none has no risk chain, as today. |
| R11 | A save is checked whole over the Roles whose chain it changes. Each derived chain must have between 1 and 8 entries (`MAX_CHAIN`, R3), and each new Pick must fit its Connection's models and efforts (R3's fit rule, over the Connection's model list). Otherwise the save is refused, naming the Role ("keys-only leaves `review` with nothing: add a Pick on a key"). A `hand` Role keeps R5's leeways (its copies, a `--force` model, its length). A Role whose Connections are all unavailable right now still saves, with a warning. |
| R12 | A new Connection goes to the end of the global order. When it first can run (terms acknowledged, model list read), every Role that isn't `hand` gets the preset's default Pick for that Role. That happens only where the model is listed and the derived chain stays within 8; an Alert names the Roles skipped. The Pick runs only where the Role's order includes the Connection. So "API keys only" has something to run as soon as a key can. |
| R13 | Every change to the policy (Priority, Override, Picks) is a Command from the principal, as in CN13; the automatic steps of R12 and R15 are the only exceptions. Events: PriorityChanged, OverrideChanged, PicksChanged, each carrying the Command id. |
| R14 | **Projection without overwriting.** Morndo writes derived chains only through the engine layer's CLI (ADR-0013), one Role at a time, and records each chain it wrote. A derived Role whose chain changed outside Morndo is drifted: Morndo doesn't write it again until the principal re-applies the policy, or sets the Role to `hand` with the outside chain as its Picks. An Alert says so. A `hand` Role's Picks are read back from the engine layer, so editing it anywhere is never drift. Only structural events re-derive: a policy change, a Connection's terms first acknowledged with its model list read (once, R12), a Connection revoked. Availability changes never do. |
| R15 | A revoked Connection leaves every order, and its Picks are removed. If that leaves a derived chain empty, Morndo keeps the last chain it wrote for that Role (the engine layer refuses an empty one) and raises an Alert that the Role has nothing to run on. A revoked Connection's provider stays registered, its probe failing, until no chain names it; only then is it removed. |

**Example.** Connections: `claude` and `codex` (subscriptions), `credit1` (Anthropic key, prepaid), `deepseek-main` (DeepSeek key). Global order: `claude, codex, credit1, deepseek-main`. The Picks of `implement-backend`, in the Role's order: `claude:sonnet-5.5@high`, `deepseek-main:deepseek-v4-pro@high`, `credit1:sonnet-5.5@high`, `codex:gpt-6-astra@high`.

| Mode | Derived chain |
|---|---|
| `subscriptions-first` | `claude:sonnet-5.5@high, codex:gpt-6-astra@high, credit1:sonnet-5.5@high, deepseek-main:deepseek-v4-pro@high` |
| `keys-only` | `credit1:sonnet-5.5@high, deepseek-main:deepseek-v4-pro@high` |
| `custom` with order `deepseek-main, claude` | `deepseek-main:deepseek-v4-pro@high, claude:sonnet-5.5@high` |
| Override `hand` | the Picks exactly as listed |

When `credit1` runs out of budget, its probe fails and its `bin` exits 75: the resolver skips it, and the next entry runs (section 9). The chain itself is not rewritten.

### 3.5 Events

- **Connections:** ConnectionAdded, ConnectionRotated, ConnectionRevoked, ConnectionTurnedOn, ConnectionTurnedOff, TermsAcknowledged, TermsChanged, RepoListChanged, IsolationChanged, BudgetChanged, ExpiryChanged, LeaseGranted, LeaseRefused (reason), LeaseRefreshed, LeaseRefreshRefused, LeaseClosed (outcome, Spend and its source, duration), LeaseLost (holder gone, Spend unknown), SpendRecorded, SpendReconciled, ThresholdCrossed. Widening events carry the Command id.
- **Engines:** PriorityChanged, OverrideChanged, PicksChanged, ChainProjected, ChainDrifted.

The audit keeps them 90 days after a Connection is removed, as the fleet's audit does.

## 4. Layers, ports and the tests that hold them

```
packages/domain/src/connections.ts    Connection, Lease, Budget, Spend, repo list, the gate, CN1–CN15. Pure.
packages/domain/src/routing.ts        Priority, Routing policy, deriveChains, R7–R15. Pure (Engines context).
packages/protocol/src/connections.ts  the wire: ConnectionView (metadata only), LeaseView, PolicyView, the typed ops;
                                      the VendorPreset schema and the words table the CLI and the page share.
packages/protocol/catalog/vendors.json the shipped vendor catalog (data).
apps/connections/src/application/     services + ports.ts. Imports the domain, the protocol and its siblings only.
apps/connections/src/adapters/        vault-age, vault-file, runtime-claude, runtime-codex, runtime-cursor, spend-*,
                                      models-*, store-sqlite, catalog-file, repo-inspector, processes, engines-cli, clock.
apps/connections/src/cli.ts           `morndo-connections`: composition root and the command line.
```

**Application services:**
- `ConnectionsService`: add a subscription, add or import a key, rotate, acknowledge terms, set the repo list, narrow, widen by Command, revoke.
- `LeaseService`: lease, refresh, close, and sweep lost Holders.
- `SpendService`: record, reconcile, and turn thresholds into Alerts.
- `AvailabilityService`: can this Connection run now, and until when. It is the engine layer's probe.
- `RoutingService`: set the Priority, Overrides and Picks; derive; project; detect drift.
- `CatalogService`: presets, and model lists through a `probe` Lease.

**Ports** (`apps/connections/src/application/ports.ts`):

| Port | Application side | Adapters |
|---|---|---|
| `SecretVault` | `has(ref)`, `fingerprint(ref)`, `remove(ref)`. No method returns a Secret. | `vault-age` (default), `vault-file` (opt-in). Later `vault-keychain` (macOS) and `vault-systemd-creds` (systemd ≥ 256). `seal` and `open` exist only on the adapter class. |
| `Runtime` | `isolation()`, `dialects()`, `loginStatus(configDir)` for subscriptions, and `launch(plan): RunHandle`. The plan names the Lease, the Connection, the Secret ref (keys), the config directory, model, effort, mode, workspace, deny paths and caps. | `runtime-claude`, `runtime-codex`, `runtime-cursor`. Each starts the runtime as a child and waits for it (6.1). |
| `ModelLister` | `models(connection)`: ids with their efforts where the vendor says. | `models-endpoint` (the preset's URL and list shape, under a `probe` Lease), `models-engine-layer` (the provider's list, for subscriptions), `models-static` (the preset's list). |
| `SpendMeter` | `fromRun(result)`: an estimate or nothing. `reported(connection)`: a provider figure or "not available". | `spend-claude-result`, `spend-token-price`, `spend-balance` and `spend-key-usage` (both driven by the preset's endpoint and field), `spend-manual`. |
| `Catalog` | `presets()`: the shipped catalog merged with the user's own file, validated. | `catalog-file`. |
| `Clock` | `now()` | The system clock; a fake in tests. |
| `ConnectionStore` | Load and save a Connection, or the Routing policy, with its events, in one transaction. | SQLite (`better-sqlite3`, ADR-0005; `service-kit` migrations). |
| `RepoInspector` | `inspect(path)`: the real path and the git remotes. | `git` and `realpath`. |
| `AlertSink` | `raise(alert)` | A fleet Alert raised by the node (a new kind, PR 7), else a log line. |
| `Processes` | `identity(pid)`, `ancestors(pid)`, `alive(identity)` | `node-ops` `pid.ts` (`/proc`). A macOS source (`sysctl` `kern.proc`) is to be chosen in PR 4. |
| `EngineSettings` | `chains()`, `setChain(role, entries, risk?)`, `putProvider(entry)`, `removeProvider(name)`, `mark(name, reason, until)`, `unmark(name)` | The engine layer's CLI only: `get --json`, `set`, `mark`, `unmark`, and `provider set|remove` (ask 5). |

**The plaintext type.** `SecretMaterial` lives in `apps/connections/src/adapters/secret-material.ts` and never serialises: `toJSON` and `toString` return `[secret]`. Application code can't import it, so it can't hold one.

**Architecture tests** (each with negative controls, in the style of the three that exist):
1. `packages/domain/test/architecture.test.ts`, unchanged. It already scans every file, so `connections.ts` and `routing.ts` get "siblings only, no `crypto`, `process`, `Date.now`" for free.
2. New `packages/domain/test/connections-shape.test.ts`: the keys of a built Connection, Lease, Routing policy and every event match an allowlist exactly. A field named like `secret|value|plaintext|apiKey|token` fails (CN1).
3. New `packages/protocol/test/connections-wire.test.ts`: the same allowlist over every schema. Also: the shipped catalog validates, and every preset, subscriptions and engine-layer custody included, has a terms revision, a summary and a source URL.
4. New `apps/connections/test/architecture.test.ts`:
   - `src/application/*` imports only `@morndo/domain`, `@morndo/protocol` and `./*.ts` siblings.
   - It uses no Node global and no ambient I/O (the protocol test's `NODE_GLOBALS`, plus `fetch|process|require|Date.now|setTimeout|setInterval|crypto|new Date(`).
   - Only the files on a fixed list import `secret-material.ts`.
   - No other app imports `apps/connections`: the hub calls the program, as it calls the engines CLI.
5. New `packages/domain/test/no-vendor-names.test.ts`: no preset id or vendor label from the catalog appears in `connections.ts`, `routing.ts` or `apps/connections/src/application`. A planted `deepseek` must fail it. This holds "vendors are data".
6. The `packages/node-ops` file-rule tests, extended: `confine()` refuses the vault, the database and the legacy key directories, asked for directly and through a symlink.
7. The redactor tests (`packages/protocol`), extended: a synthetic key of each catalog shape comes out `[redacted]`.

## 5. Storage at rest

### 5.1 The options, from current docs

| Option | What the docs say (checked 2026-10-10) | On this box | Verdict |
|---|---|---|---|
| systemd-creds | The host key is "only accessible to the root user". `--with-key=auto` uses a TPM2, else the host key. Per-user encryption arrived in systemd 256. Credentials are "not propagated down the process tree" [S10]. | systemd 255: no `--user`. `has-tpm2` answers `partial`, there is no `/dev/tpm*`, and WSL exposes no TPM (microsoft/WSL#5178 is open) [S13]. | Not the default: a root-only key here, and Linux only. A later adapter for systemd ≥ 256. |
| age file with a machine key | An identity file holds `AGE-SECRET-KEY-1…` lines. A passphrase is "not necessary for most use cases, where access to the encrypted identity file implies access to the whole system" [S11]. The npm package `age-encryption` (typage, by age's author) is 0.3.1, BSD-3-Clause, pure JS [S11]. | Works anywhere Node does; no daemon, no root. | **Default.** |
| Secret Service (libsecret) | Needs an unlocked collection in the login session: "the secrets of locked items cannot be accessed", and the spec "does not mandate any form of access control" [S12]. | No keyring daemon here, and lanes run headless. | Rejected for headless nodes. A macOS Keychain adapter can come later. |
| Plain 0600 file | Every process of the owning user reads it [S20]. Claude Code keeps Linux credentials the same way [S1]. | Today's layout. | Kept as `vault-file`, for migration and for those who choose it. |

### 5.2 The pick

**Default: `vault-age`.** Pinned 2026-10-10 to [`age-encryption` 0.3.1](https://www.npmjs.com/package/age-encryption) (published 2026-08-28; repository [FiloSottile/typage](https://github.com/FiloSottile/typage)). `npm view age-encryption version` was `0.3.1`. An OSV query for npm `age-encryption` 0.3.1 returned no advisories (`https://api.osv.dev/v1/query`, 2026-10-10).
- One age file per Secret: `~/.local/share/morndo-connections/vault/<secret ref>.age`.
- Encrypted to one X25519 machine identity at `~/.config/morndo-connections/identity` (0600, directory 0700, created on first use).
- The database is `~/.local/share/morndo-connections/connections.db`. It holds no Secret.
- Writes are a temp file plus a rename. The adapter refuses anything looser than 0600 or not owned by the user.
- `age -d -i identity <ref>.age` recovers a key with the standard tool, so the format is not ours.
- The identity is excluded from Morndo's backups: back up the vault, keep the identity offline.

Both age and a plain file fall to a process of the same user; age protects the copies. A backup, a synced dotfiles repo, or an agent's `grep -r sk-` finds only ciphertext. Over systemd-creds or a keyring, it is the only option that works on every target Morndo names, headless, without root, today.

### 5.3 Threat model

| Threat | v1 answer | Limit |
|---|---|---|
| Other local users | 0600 files in 0700 directories; looser modes are refused. | root reads everything. |
| Lane processes (same user) | Keys stay out of lanes' environments (6.1). Deny rules keep the CLI's file tools off the vault (CN5). Yama `ptrace_scope` 1 lets a process attach only to its descendants [S21]. Under `os` Isolation the sandbox denies the vault, identity and database to every tool command. | Under `rules`, a tool command inside the run is a descendant of the runtime and can call the helper itself. The deny rule stops the plain call, not a disguised one [S5]. CN9 detects it; it doesn't prevent it. Any same-user process that ignores the rules can read the identity and the vault. Real isolation needs a broker under its own user behind a loopback gateway (`ANTHROPIC_BASE_URL` to loopback, a per-Lease token instead of the key [S4]). Named here, not built. |
| A subscription run billing a key | The launcher strips every inherited API-key variable before a subscription run, and checks the CLI's own auth method at start (6.1). | Only for runs that go through the gate (Q2). |
| Prompts and transcripts | No Secret is ever an argument, a prompt, a workspace file or a lane variable. The hub's transcript and screen views pass the key shapes too (PR 0). | A model shown a key elsewhere can repeat it. |
| Logs | The shared redactor gains key shapes. The launcher replaces the exact leased value in every byte it captures. | Shapes miss unknown formats. The exact filter covers only what the launcher captures. |
| Backups, git | Ciphertext only, identity excluded. The vault is outside every repo, and the file rules deny it. | A backup that takes the identity too gets everything. |
| Telegram and the hub | Only metadata crosses (CN1, FL14). A key is added only on the machine, from stdin. | none known. |

## 6. Use without exposure

### 6.1 How a run starts

`morndo-connections run --connection NAME [--role R --lane L] -- <runtime args>` takes the Lease through the gate (CN8), builds the child's environment from an allowlist, and starts the runtime as its child; the child's identity becomes the Holder. It exits 70 only when the store failed before the child started, and 75 on a refusal; a child's own 70 or 75 comes out as 1, so neither can be mistaken for the launcher's. It stays the parent so it can close the Lease. Headless, it pipes the child's output through the exact-value filter and reads the result's cost. Interactive, the child keeps the terminal, and the Lease closes on exit. If the parent is killed first, the sweep closes the open Lease as `LeaseLost`.

**Keys: a credential helper wherever the runtime has one.**
- **Claude Code: `apiKeyHelper`.** The launcher passes `--settings '{"apiKeyHelper":"morndo-connections helper --lease <id>"}'`; inline JSON is allowed [S2]. Claude Code sends the helper's output "as both the `X-Api-Key` and `Authorization: Bearer` headers". It reruns the helper after the TTL (`CLAUDE_CODE_API_KEY_HELPER_TTL_MS`) and on a 401 or 403 [S2, S3]. The launcher sets the TTL to 60 s, so turning a Connection off, revoking it, or a budget the vendor reports as spent stops a run within a minute. A helper from `--settings` is expected to skip the workspace trust prompt; PR 4 checks it.
- **Codex: `model_providers.<id>.auth`.** A command that "must print the token to stdout", with `timeout_ms` (5000) and `refresh_interval_ms` (default 300000; the launcher sets 60000, as for Claude Code). It "can't be combined with `env_key`" [S18].
- **Anything else: one environment variable at spawn,** which the runtime is told to drop from its subprocesses: Claude Code's `sandbox.credentials.envVars` with `"mode": "deny"` [S6], Codex's `shell_environment_policy` [S18]. The Cursor agent takes a key only as `CURSOR_API_KEY` or `--api-key` [S24]. Every tool command would inherit that, so the catalog offers no local Cursor key in v1.

**Subscriptions: the CLI's own sign-in, and nothing else.**
- The launcher points the runtime at the Connection's config directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), or runs the command the engine layer used before. On this box that is `claude-as`, where claude-pool picks the account; Morndo doesn't look inside.
- It strips every inherited API-key variable first.
- Its done-check reads the CLI's status: `claude auth status` exits 0 when signed in, and its JSON has `authMethod` (`claude.ai` for a subscription; `api_key` and `api_key_helper` are keys) and `configDirectory` [S2, Claude Code ≥ 2.1.268]; `codex login status` (local `--help`, 0.161.0); `agent status` [S24]. A subscription run whose auth method isn't the subscription's is stopped and refused (`not the subscription`).

**The precedence trap.** Claude Code picks credentials in this order: cloud provider variables, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, profiles, then the subscription [S1]. A stray inherited key beats both the helper and the subscription.
- The launcher strips `ANTHROPIC_*`, `CLAUDE_CODE_USE_BEDROCK|VERTEX|FOUNDRY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_*`, `CODEX_*` and `CURSOR_API_KEY` from every child.
- Each key Connection gets its own config directory, with no login and no `env` block in it: a settings `env` value overrides the shell [S2].
- The done-check fails the Lease if the model or the base URL in the session's init event is not the Lease's.

**Not `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` by default.** It strips credentials by name or by shape [S3], which would take `MORNDO_AGENT_TOKEN` from `morndo-board` too (UNVERIFIED for that name). With helpers, no key is in the environment to scrub. A node may still turn it on.

### 6.2 Redaction rule for output

1. The shared redactor gains the catalog's key shapes (`sk-ant-…`, `sk-or-v1-…`, a generic `sk-[A-Za-z0-9_-]{20,}`, `AGE-SECRET-KEY-1…`) and `…_TOKEN=`/`…_KEY=` assignments. Every service's log already runs through it (ADR-0008 A4).
2. In headless runs, the launcher replaces the leased value with `[redacted]` in stdout and stderr before anything is written. An interactive TUI writes to its terminal directly; there the protection is that the key is in no environment, argument or file the lane can see.
3. Nothing logs a Secret, a helper's stdout or a child's environment. Tests feed synthetic keys through each path and grep the outputs.

### 6.3 Audit of each use

Each run gets one `LeaseGranted` / `LeaseClosed` pair, in the database and as a node event the hub can read. It records the Connection, its Kind and Fingerprint (keys), the Holder (node, pid, claimed lane), the role label, the engine entry, the Runtime, the mode, the workspace (its name; the path stays on the node), the Isolation, start and end, the outcome, and Spend with its source. Refusals and refused refreshes are recorded too. `morndo-connections log [NAME]` reads it on the node.

## 7. Budgets and expiry

### 7.1 Where spend comes from

| Vendor | Provider-reported | Client-side | Used as |
|---|---|---|---|
| Anthropic key or credit | No per-key balance endpoint found (UNVERIFIED). | `total_cost_usd`, "client-side estimates" [S7] from "a price table bundled at build time" [S8]. | `estimate`, and `manual` from the console. |
| DeepSeek | `GET /user/balance` per account [S14]. | Tokens × the catalog's dated prices; Claude Code's figure means nothing for these models [S8]. Off-peak prices apply outside 01:00–04:00 and 06:00–10:00 UTC on weekdays [S14]. | `estimate`, and `provider` from the balance drop when the account holds one key. |
| Moonshot / Kimi | `GET /v1/users/me/balance` [S16]. | Tokens × prices. | As DeepSeek, through the same data-driven `spend-balance`. |
| OpenRouter | `usage.cost` on every response; `GET /api/v1/key` gives usage and limit per key [S17]. | none needed | `provider`, per key. |
| OpenAI | No per-key balance endpoint found (UNVERIFIED). | Tokens × prices. | `estimate`, and `manual`. |
| Subscriptions | Their windows, through Usage (ADR-0016). | none | Shown only. They decide nothing (U4). |

### 7.2 Enforcement, in layers

1. **Before:** the gate reserves the smaller of the role's reserve (default $5, configurable per role label) and what remains (CN8).
2. **During, headless:** `claude -p --max-budget-usd` is set to the reservation. It stops the run "once estimated spend … reaches this amount", but "spend can pass the cap" [S2]. The margin covers it.
3. **During, every run:** the helper refuses a refresh past the Budget, or once the Connection is off or revoked (CN11, CN14). It sees a running Lease's own spend only where the vendor reports it during the run (OpenRouter's key usage, a balance drop). Interactive Claude Code runs and Codex runs have no result to read and no in-run cap. Where the vendor reports nothing, such a run is charged its whole reservation as an `estimate` when it closes, so the Budget still moves and CN11 still fires; a later `manual` or `provider` figure replaces it (CN10). A token-count estimate from the session transcript is UNVERIFIED (PR 4). The page says so beside each such key.
4. **Last:** the vendor's own limit, such as a spent grant, or an OpenRouter key's 402 [S17].

### 7.3 Warnings and fall-through

Thresholds (CN12) become fleet Alerts (PR 7). Until then, `check` and the log carry them. When a key can't lease:
- its probe (`morndo-connections check --connection NAME`) fails with the reason, so the resolver skips it;
- an exhausted key is marked until its Expiry through `EngineSettings`, and unmarked when its budget is raised;
- a spawn refused anyway (probes are cached an hour) exits 75, so the chain's next entry runs.

Two prepaid keys fall through in the user's order. The page hints when a later key expires sooner than an earlier one; it doesn't reorder (v1's automatic soonest-expiry pick is gone).

## 8. Vendor catalog and runtime adapters

### 8.1 The catalog is data

`packages/protocol/catalog/vendors.json`, validated by the `VendorPreset` schema. The user's file `~/.config/morndo-connections/vendors.json` can add presets, which is how a custom endpoint gets a name. A new vendor is a data change plus, at most, a runtime adapter it reuses; never a domain change. Fields: `id`, `label`, `kinds`, `runtimes` (in preference order, each with its dialect and base URL, or `ask`), `models` (`endpoint` URL and list shape, `engine-layer`, or `static`), `family` (for the review rule), `keyShapes`, `spend`, `prices` (dated), `balance` (endpoint and field, if any), `defaultPicks` (by role, with `*` as the fallback), `isolation` (the floor), and `terms` (`revision`, `summary`, `sources`).

```jsonc
{ "id": "deepseek", "label": "DeepSeek", "kinds": ["api-key"],
  "runtimes": [{ "runtime": "claude", "dialect": "anthropic", "baseUrl": "https://api.deepseek.com/anthropic" },
               { "runtime": "codex", "dialect": "openai-responses", "baseUrl": "https://api.deepseek.com/" }],
  "models": { "endpoint": "https://api.deepseek.com/models", "shape": "openai-list" }, "family": "deepseek",
  "balance": { "endpoint": "https://api.deepseek.com/user/balance", "field": "balance_infos[].total_balance" },
  "spend": ["balance", "token-price"], "defaultPicks": { "plan": "deepseek-v4-pro@max", "*": "deepseek-v4-pro@high" },
  "isolation": "os",
  "terms": { "revision": "2026-04-29", "summary": "Stored in the PRC; may be used for training; opt-out with no API switch.",
             "sources": ["https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html"] } }
```

**Shipped presets.** The drop-down offers the API-key rows. Subscriptions are offered for each runtime Morndo has an adapter for; the engine layer's other providers appear as Connections in its custody (3.2).

| Preset | Kinds | Runtime (dialect) | Models from | Terms summary | Isolation floor |
|---|---|---|---|---|---|
| `anthropic` | api-key | Claude Code (helper) | `GET /v1/models` [S23] | "may not train models on Customer Content from Services" [S19] | `rules` |
| `openai` | api-key | Codex (`auth.command`) | `GET /v1/models` [S23] | API data "is not used to train or improve OpenAI models" since 2023-03-01; abuse logs "up to 30 days" [S22] | `rules`. Codex gives `none` until PR 4 verifies its read-deny. |
| `deepseek` | api-key | Claude Code, or Codex (Responses) | `GET /models` [S23] | stored in the PRC, may train [S15] | `os` |
| `moonshot` | api-key | Claude Code | `GET /v1/models` [S23] | may train "unless otherwise expressly agreed in writing" [S16] | `os` |
| `zai` | api-key | Claude Code | static `glm-5.3`, `glm-5.3-flash` (no list route) [S26] | API input is processed in real time and not saved [S26] | `os` |
| `openrouter` | api-key | Claude Code | `GET /api/v1/models` [S23] | keeps no prompts unless you opt in; ZDR per request or account-wide [S17] | `os` |
| `custom-anthropic` | api-key, base URL asked | Claude Code | endpoint if offered, else typed in | `unknown` | `os` |
| `custom-openai` | api-key, base URL asked | Codex | `GET {base}/models` if offered, else typed in | `unknown` | `os` |
| `claude`, `codex`, `cursor` | subscription | their CLI | the engine layer's provider list | the vendor's terms for that plan, linked; the revision is the date they were checked | `claude`: `rules`. `codex`: `none` until PR 4 verifies its read-deny. `cursor`: `none` (UNVERIFIED). |
| `studio`, `cursor-cloud`, `agy` | subscription, api-key, subscription; engine-layer custody | the engine layer's | the engine layer's provider list | as for subscriptions; until acknowledged, Morndo sets the provider off through `provider set` (ask 5) | not Morndo's to set |

**Add a Z.ai key.** Put the key in a file the shell can read, then:

```
morndo-keys add glm --vendor zai --runtime claude --billing metered --budget 20 < keyfile
```

The runtime is Claude Code against `https://api.z.ai/api/anthropic` (Anthropic Messages). The implement role's default pick is `glm-5.3@max`; other roles fall back to `glm-5.3@high`. `glm-5.3-flash` is also listed. Read 2026-10-10 [S26]: GLM-5.3 and GLM-5.3-Flash each have a 1M-token context and 128K max output; coding should use effort `max` (`low`, `high`, `max`; default `max`). Auth on the general API is `Authorization: Bearer`; Claude Code sends the helper's stdout as that header and as `x-api-key`. The OpenAPI spec has no models route, so the ids are static. Prices per 1M tokens: GLM-5.3 $1.40 in / $4.40 out; GLM-5.3-Flash $0.15 / $0.50. A key that has ever been on a GLM Coding Plan, including an expired one, can currently call the pay-as-you-go model API only through OpenAI Chat Completions (`https://api.z.ai/api/paas/v4` or the coding-plan base `https://api.z.ai/api/coding/paas/v4`); the Anthropic base above is the one the coding-plan Claude Code guide and the GLM-5.3 protocol table both name.

**Later presets:** a local Cursor key (only an environment variable or a flag exists [S24]) and Google's Gemini API, which the engine layer lists as key-only.

### 8.2 Anthropic key with Claude Code

The key Connection gets:
- the helper as in 6.1, and its own config directory;
- `attribution: false` (from v2.1.281 [S2]; installed 2.1.296);
- the house deny list, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.

Everything works as on a subscription except features tied to claude.ai, such as connectors, Remote Control, Routines and cloud sessions [S9].

### 8.3 Anthropic-compatible endpoints with Claude Code

- `ANTHROPIC_BASE_URL`, plus the key through the helper (sent as both headers).
- `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS|SONNET|HAIKU_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL` set to the Lease's model, so no request names a Claude model.
- Anthropic "doesn't support routing Claude Code to non-Claude models through any gateway" [S4]: these routes work by the third party's docs.
- Behind a third-party base URL, MCP tool search is off and Remote Control is disabled [S4]. WebSearch uses Anthropic's backend [S9]; through a third party it is UNVERIFIED, so it is denied.

| | DeepSeek [S14, S15] | Moonshot / Kimi [S16] | OpenRouter [S17] |
|---|---|---|---|
| Base URL | `https://api.deepseek.com/anthropic` | `https://api.moonshot.ai/anthropic` | `https://openrouter.ai/api`. Its guide sets `ANTHROPIC_API_KEY=""`; whether an empty value outranks the helper is UNVERIFIED (PR 4). |
| Models | `deepseek-flash`, `deepseek-v4-pro`; 1M context | `kimi-k3`, `kimi-k2.7-code` | many; "only guaranteed to work with the Anthropic first-party provider" |
| Price per 1M tokens | flash $0.15 / $0.60 off-peak; v4-pro $0.66 / $1.98 | k3 $3 / $15; k2.7-code $0.95 / $4 | per routed model |
| Gaps | MCP tool blocks and `cache_control` unsupported. **An unknown model name silently maps to `deepseek-flash`.** The v4-pro routing notice contradicts the changelog. | Setting only some variables "makes the corresponding scenarios fail silently". | ZDR "does not apply to plugins and tools". |

The silent downgrade has two answers: a Pick must name a model from the Connection's model list (R11), and every Lease's done-check compares the model each response reports with the Lease's, marking the engine on a mismatch.

### 8.4 OpenAI-compatible keys with Codex

The Connection's own `CODEX_HOME` holds a `[model_providers.<id>]` table [S18]:
- `base_url`;
- `wire_api = "responses"`, "the only supported value";
- `auth.command` = the helper. Never `env_key`, and never `codex login --with-api-key`, whose login becomes local state.

Codex's commands get `shell_environment_policy` excludes for KEY, SECRET and TOKEN variables.

Codex now documents beta permission profiles: `default_permissions` and `permissions.<name>.filesystem.<path> = "deny"`, to "deny reads for matching paths" in sandboxed tool calls [S18]. Whether 0.161.0 enforces that on Linux is UNVERIFIED. PR 4 runs a sandboxed `cat` of a denied path. If it fails as it should, Codex offers `os`; if not, `none`, and the gate refuses Codex for every preset with a floor above `none`.

### 8.5 Safety config every run carries

- **Deny rules:** Read and Edit on the vault, the database, the legacy key directories, every agent CLI's credential directory, and node-ops' deny roots, as absolute `//path` patterns [S5].
- **Under `os`:**
  - `sandbox.enabled`;
  - `failIfUnavailable: true`, so a missing sandbox is a refused start [S6];
  - `allowUnsandboxedCommands: false`;
  - `filesystem.denyRead: ["~/"]`, with `allowRead` for the workspace, its toolchain, and what the repo list allows [S6].
- **Why both:** deny rules "don't apply to … arbitrary subprocesses" [S5], and a `denyRead` entry "doesn't stop the Read tool" [S6]. Each layer covers the other.
- **For third-party presets:** no attribution, no WebSearch, telemetry off.

## 9. Routing in the engine layer

Each Connection is one engine-layer provider of the same name. Morndo registers it, with the vendor's `family` and the Connection's model list, through the CLI (ask 5):

```jsonc
"deepseek-main": { "kind": "cli", "adapter": "claude", "family": "deepseek",
                   "bin":   ["morndo-connections", "run", "--connection", "deepseek-main", "--"],
                   "probe": ["morndo-connections", "check", "--connection", "deepseek-main"],
                   "models": ["deepseek-v4-pro", "deepseek-flash"], "efforts": ["high", "max"] }
```

The derived chains (3.4) are written with `engines set ROLE A,B,C` (and `--risk` for risk chains), so the resolver, the marks and the review rule keep working as they do. From PR 7 the hub's page saves Roles, Overrides and Picks through `RoutingService`, never through its own `engines set`; until then its saves on a derived Role count as drift (R14), and derived Roles are edited with the CLI. A subscription Connection adopts its existing provider (`claude`, `codex`, `cursor`), and the engine layer's other providers become Connections in its custody. If Q2 is yes, a subscription's `bin` changes to `morndo-connections run` in PR 6, one provider at a time, with the old command kept as the rollback.

**What we ask the engine layer for** (additive, as ADR-0013 did):
1. An optional `adapter` field, so a provider named `deepseek-main` reuses the `claude` adapter (today the provider's name picks the adapter).
2. `bin` as an argv list.
3. The lane's role and name passed to `bin` (`--role`, `--lane`), for the audit and the per-role reserve. Without them, a Lease records role `unknown` and uses the default reserve.
4. A "not available here" exit code (75, with one JSON line on stderr: reason, until), which `finish_turn` treats like `billing`: mark the provider and fall through. Today a refused spawn fails the turn.
5. `engines provider set NAME --json` and `engines provider remove NAME`, validated like `set`, so that Morndo never writes the settings file (ADR-0013).

All five are needed before an engine lane runs on a key. Headless runs through `bg-wake` and `review-run` call `morndo-connections run` directly and need none. A compare-and-set (`set --if-version`, open since ADR-0013) would make drift detection exact. Until then, Morndo compares a Role's chain just before writing it, and accepts a window of a few hundred milliseconds.

**The reviewer stays on another family.** The family is the model's, not the runtime's: `deepseek-main` is family `deepseek` even inside Claude Code. With the other-provider rule on, DeepSeek-implemented work gets an `anthropic` reviewer. The resolver already does this from `family`.

## 10. Hard rules, and what was removed

The user decides which Connection does what. What remains are rules that are not choices:
1. **Secrets and credentials go to no provider** (CN5), on every Connection, whatever its order or mode, as far as its runtime lets Morndo enforce it. Morndo never hands one over. Under `rules`, the CLI's own file tools are denied them, in-workspace secrets (`.env`, key and credential files by node-ops' names) included. Under `os`, every tool command is denied them too. The preset's Isolation floor is part of this rule, and no setting lowers it (CN6, Q3). A Connection without `os` says on its row that tool commands can read the user's files.
2. **Terms before use** (CN4). A Connection can't run (shown as "terms not read") until the principal has read its preset's data terms and acknowledged them; for one in the engine layer's custody, Morndo keeps its provider off until then. The add dialog and `morndo-connections add` show the summary and the sources. A new revision asks again.
3. **The repo list is his, and optional** (CN7, CN6). With one, the run is sandboxed, so the list binds tool commands too, not just the CLI's file tools. A Connection whose runtime can't give `os` therefore can't have a repo list until it can.

**Removed from v1:**
- The data classes (`own`, `public`, `employer`, `client`, `unclassified`), the rules file that set them, and the per-provider data policies built on them.
- v1 CR11 (unclassified workspaces) and v1 CR8 (the automatic soonest-expiry pick).
- The Scope by role and Data class, replaced by the Routing policy and the repo list.

A user who wants one account limited to some repositories writes that as a repo list on the Connections concerned.

## 11. The settings page, after the CLI

The CLI comes first and is complete on its own. Its commands:
- `morndo-connections add NAME --subscription --runtime claude [--config-dir P]`;
- `add NAME --vendor deepseek` (the key on stdin) and `import`;
- `list`, `ack`, `repos`, `isolation`, `on|off`, `budget`, `expiry`, `revoke`, `rotate`;
- `models`, `check`, `run`, `helper`, `spend`, `log`;
- `priority show|set MODE [ORDER…]`;
- `role ROLE|--all follow|own MODE [ORDER…]|hand`, and `picks ROLE [--risk] add|remove ENTRY`. `role --all follow` puts every Role under the global Priority at once; it regroups chains that interleave Connections, and prints each Role's chain before and after.

The page (PR 7) extends the Engines page (ADR-0013) at the same route and is titled **LLM connections**. It has three sections and uses the same words, from one words table in `packages/protocol`, so the two can't drift.
1. **Connections.**
   - One row per Connection: name, Kind, vendor, runtime, and availability with its reason. A key also shows its budget meter (the percentage and the level in words, never colour alone), its expiry and its spend source. A subscription shows its Usage windows (ADR-0016) when its account reports.
   - **Add connection** opens a dialog: Subscription or API key.
     - Subscription: pick a runtime Morndo has an adapter for (`claude`, `codex`, `cursor`). The page shows the sign-in command to run on the machine, then rechecks.
     - API key: a vendor drop-down from the catalog, then the preset's data terms with links, a budget, an expiry and an isolation. The key itself is added on the machine only: the page shows the exact `morndo-connections add …` line to run there, and the row appears once it ran.
2. **Priority.** The five modes, in words, and the Connections as a list ordered by dragging. A preview shows what runs first for each Role.
3. **Roles.** ADR-0013's cards. Each gains its Override (Follow, Own order, Hand), its Picks, and its derived chain numbered. A drifted Role shows "Changed outside Morndo", with Re-apply and Keep as hand.

Saves are Commands with the version they read and step-up (ADR-0013, AC7). Narrowing actions (turn off, lower a budget, add a deny) need no step-up beyond a session. Revoking asks for step-up, since it can't be undone.

## 12. Moving keys that already exist

No step stops work that already runs on a key, and each step has its own rollback.
1. **Install beside.** PRs 1–4 ship `morndo-connections`. Any existing wrapper is untouched.
2. **Import.** `morndo-connections import NAME --vendor VENDOR --billing prepaid --budget AMOUNT --expires DATE --config-dir CONFIG --from-file FILE`, once per key.
   - It seals the key and prints the old file's Fingerprint next to the new one, never a key.
   - `spend import` turns each earlier cost line into an `estimate`, once.
   - Each role's reserve is set from the largest cost observed for it before the cut-over, plus the margin, so the cap never cuts a run that fits today.
   - A Connection can't run until its terms are read (CN4). The user acknowledges them once, in a terminal on that machine. The next step waits until `morndo-connections check` exits 0 for each imported name.
3. **The wrapper becomes a thin adapter.** It runs `morndo-connections run --connection NAME --role ROLE -- …`, keeps the exit code, and does not replace itself with the child.
   - For one week it falls back to the old path only on exit 70, which the launcher gives only when the store failed before the child started (6.1). It never falls back on a refusal (75).
   - A fallback logs loudly, raises an Alert, and writes its usage line marked `fallback`.
4. **Compare, then one writer of spend.** `run` records cost itself. The old log stays through the week as the comparison, and a later import takes only the `fallback` lines.
5. **Retire.** After seven days of matching spend, spend is read from `morndo-connections`. The old key files go afterwards, by hand.

Imported connections enter the Routing policy like any other, at the end of the order. Nothing changes for engine roles until the user picks a mode (Q1). Rollback at any step: the old wrapper lines, kept until step 5.

## 13. Build plan: small stacked PRs

| PR | What | Done-check |
|---|---|---|
| 0 | node-ops: `.config/claude-credits` and `.config/engines` into `denyRoots`; `*-api-key` and `key-[0-9]+` into `SECRET_NAME`; redactor key shapes, applied to logs and to the hub's transcript and screen views. Independent; ship first. | `confine()` refuses each path, directly and through a symlink; synthetic keys redact; existing suites green. |
| 1 | Domain: `connections.ts` (CN1–CN15) and `routing.ts` (R7–R15). `docs/domain.md`: a Connections section, the Engines additions, the context map. Protocol: wire schemas, `vendors.json` with its schema, the words table. | One negative-control history per invariant, with a fake clock. A derivation table: five modes × kinds, the stable order, `hand`, unknown names, and an empty or 9-entry chain refused. The allowlists fail on an added field; the catalog validates; the no-vendor-names test fails on a planted literal. |
| 2 | `apps/connections` application: services, ports, fakes, the architecture test. | The gate's order, one refusal per step; lease, refresh, close, reconcile, thresholds; Routing save, derive and drift against a fake `EngineSettings`. The architecture controls catch `node:fs`, an adapter import and a Node global. |
| 3 | Storage: `vault-age` (`age-encryption` pinned after a fresh check), `vault-file`, the SQLite store (Connections, events, the Routing policy). | Round trip; 0644 files and foreign owners refused; the identity never leaves its path; `age -d` interop in manual QA. |
| 4 | CLI for keys (`add`, `import`, `list`, `ack`, `repos`, `isolation`, `on|off`, `budget`, `expiry`, `models`, `check`, `run`, `helper`, `spend`, `log`, `revoke`, `rotate`); runtime adapters `runtime-claude` and `runtime-codex`; spend meters; model listers; the catalog file. Then the migration (section 12). | E2E against a local fake Messages API that records headers. The key arrives only as the helper's header; a Bash `env` in the run shows no key; a Lease whose Connection is turned off fails within one TTL; helper calls are counted for subagents, a forced 401 and a refusal, which sets N (CN9), and a call past N ends the Lease; two Leases can't reserve past the Budget; `--max-budget-usd` equals the reservation. Exit codes: 70 on a store failure, 75 when terms are unacknowledged or the repo list denies the workspace. A child exiting 70 comes out as 1. A model list is fetched under a `probe` Lease; a model mismatch marks the engine; a sandboxed `cat` of a denied path fails; Codex's permission profile is checked, which settles its Isolation. Manual QA in `qa/`. |
| 5 | CLI for the policy (`priority`, `role`, `picks`), risk chains included; the projection through the engines CLI; drift; the engine layer's other providers as Connections in its custody; the five asks to engine-layer. | After `role --all follow` and `priority set keys-only`, `engines get` shows the derived chains and risk chains. Revoking the only key under `keys-only` keeps the last chain and raises an Alert. A terminal `engines set` makes a derived Role drifted, and Morndo doesn't overwrite it; on a `hand` Role it is no drift. `engines resolve` skips an exhausted key with its reason; a refused spawn (75) falls through; the review rule skips a DeepSeek reviewer for DeepSeek work. |
| 6 | Subscriptions through the gate: login checks, stripped variables and the auth-method check in `runtime-claude`, `runtime-codex` and `runtime-cursor`; the `bin` switch per provider, with the old command as rollback (Q2). | A subscription run started with a stray `ANTHROPIC_API_KEY` in its parent's environment runs on the subscription: `authMethod` is `claude.ai`, and the fake server sees no key. A repo-denied workspace refuses (75) and falls through. A week of the owner's `claude` lanes through the gate with no wrong refusal. |
| 7 | Web: the LLM connections page; the hub's Role saves moved to `RoutingService`; the widening Commands as fleet typed ops with step-up; the Alerts kind. | E2E plus manual QA screenshots. A test that the page's words come from the protocol table. No wire message carries more than the allowlist. |

## 14. Limits, risks, and what would change this

- **Same-user trust.** v1 keeps keys out of environments, prompts, logs and repos, and keeps tools off the vault. It doesn't stop a same-user process that ignores those rules, nor, under `rules`, a tool command that calls its run's helper (detected, not prevented). The next step is the broker under its own user (5.3).
- **Spend outside headless Claude Code.** Interactive and Codex runs have no in-run cap, and their spend is known only where the vendor reports it (7.2).
- **Connections in the engine layer's custody** (`studio`, `cursor-cloud`, `agy`) are ordered by the Priority, but no gate, budget or repo list reaches their runs until they move to Morndo.
- **Two sources for a chain.** The policy lives in Morndo, and the chain in the engine layer's file. Drift detection (R14) keeps them honest without silent overwrites. If the engine layer moves into Morndo, or offers a `priority` section, the domain rule stays and only the projection adapter changes.
- **Per node.** Priority and Connections are per node. Names are the join key, so a fleet-wide Priority can later order names, and each node skips the ones it lacks.
- **Third-party routes are unsupported by Anthropic** [S4] and change fast. Adapters pin the versions they were tested on, and each Lease checks the model it got.
- **Spend is an estimate** for Anthropic and OpenAI keys until a balance source exists. Budgets keep a margin.
- **Helpers act within a minute,** not instantly. `--max-budget-usd` also caps a headless run.

## 15. Sources (checked 2026-10-10)

- [S1] Claude Code authentication: precedence, `-p` and `ANTHROPIC_API_KEY`, Linux `.credentials.json` 0600. https://code.claude.com/docs/en/authentication
- [S2] Claude Code settings: `apiKeyHelper`, `attribution`, `env`. https://code.claude.com/docs/en/settings-reference. CLI reference: `--settings` inline JSON, `--max-budget-usd`, `claude auth status` (JSON, exit 0/1, `authMethod`, `configDirectory` from v2.1.268). https://code.claude.com/docs/en/cli-reference
- [S3] Claude Code environment variables: `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. https://code.claude.com/docs/en/env-vars
- [S4] Claude Code LLM gateway and its protocol. https://code.claude.com/docs/en/llm-gateway, https://code.claude.com/docs/en/llm-gateway-protocol
- [S5] Claude Code permissions: path syntax, limits of deny rules. https://code.claude.com/docs/en/permissions
- [S6] Claude Code sandboxing: WSL2, bubblewrap and socat, `credentials`, `failIfUnavailable`, `allowUnsandboxedCommands`, `denyRead`/`allowRead`. https://code.claude.com/docs/en/sandboxing
- [S7] Claude Code headless: `total_cost_usd` as a client-side estimate. https://code.claude.com/docs/en/headless
- [S8] Agent SDK cost tracking: bundled price table, `costBasis`. https://code.claude.com/docs/en/agent-sdk/cost-tracking
- [S9] Claude Code feature availability. https://code.claude.com/docs/en/feature-availability
- [S10] systemd-creds(1): https://github.com/systemd/systemd/blob/main/man/systemd-creds.xml. Also systemd 256 NEWS, https://systemd.io/CREDENTIALS, and local `systemctl --version`, `systemd-creds --help`, `systemd-creds has-tpm2`.
- [S11] age: https://github.com/FiloSottile/age. typage: https://github.com/FiloSottile/typage (npm `age-encryption` 0.3.1, BSD-3-Clause). SOPS age identities: https://getsops.io/docs/usage/identities/age/
- [S12] Secret Service API: https://specifications.freedesktop.org/secret-service/latest/. libsecret: https://gitlab.gnome.org/GNOME/libsecret
- [S13] TPM support in WSL distros, open since 2020-05-07: https://github.com/microsoft/WSL/issues/5178
- [S14] DeepSeek: https://api-docs.deepseek.com/guides/anthropic_api, …/quick_start/agent_integrations/claude_code, …/quick_start/agent_integrations/codex, …/quick_start/pricing, …/quick_start/rate_limit, …/api/get-user-balance, …/updates
- [S15] DeepSeek privacy policy (2026-02-10): https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html. Open platform terms (2026-04-29): https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html
- [S16] Kimi: https://platform.kimi.ai/docs/guide/claude-code-kimi, /docs/models, /docs/pricing/chat, /docs/pricing/limits, /docs/api/balance, /docs/agreement/modeluse
- [S17] OpenRouter: https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration, …/cookbook/administration/usage-accounting, …/api/api-reference/api-keys/get-current-api-key, …/guides/features/zdr
- [S18] Codex config reference: `model_providers.<id>.auth`, `wire_api`, `shell_environment_policy`, `default_permissions`, `permissions.<name>.filesystem` (beta). https://learn.chatgpt.com/docs/config-file/config-reference. Releases: https://github.com/openai/codex/releases (0.162.1, 2026-10-09). Local `codex --version` 0.161.0, and `codex login --help` (`status`, `--with-api-key`).
- [S19] Anthropic Commercial Terms (effective 2025-06-17): https://www.anthropic.com/legal/commercial-terms
- [S20] path_resolution(7): https://man7.org/linux/man-pages/man7/path_resolution.7.html
- [S21] Yama, `ptrace_scope` 1: https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html
- [S22] OpenAI, data controls for the API: no training on API data since 2023-03-01; abuse logs up to 30 days. https://developers.openai.com/api/docs/guides/your-data
- [S23] Model lists: Anthropic `GET /v1/models` https://platform.claude.com/docs/en/api/models/list ; OpenAI `GET /v1/models` https://developers.openai.com/api/reference/resources/models/methods/list ; DeepSeek `GET /models` https://api-docs.deepseek.com/api/list-models ; Kimi `GET /v1/models` https://platform.kimi.ai/docs/api/list-models ; OpenRouter `GET /api/v1/models` https://openrouter.ai/docs/api/api-reference/models/get-models
- [S24] Cursor CLI authentication: `agent login`, `agent status`, `CURSOR_API_KEY`, `--api-key`. https://cursor.com/docs/cli/reference/authentication
- [S26] Z.ai, read 2026-10-10. GLM-5.3 (1M context, 128K output, efforts `low`/`high`/`max`, coding recommends `max`; Anthropic Messages `https://api.z.ai/api/anthropic`): https://docs.z.ai/guides/llm/glm-5.3. Coding-plan Claude Code base and model switch (`glm-5.3`, `glm-5.3-flash`): https://docs.z.ai/devpack/latest-model and https://docs.z.ai/devpack/tool/claude. Bearer auth and general base `https://api.z.ai/api/paas/v4`: https://docs.z.ai/api-reference/introduction. GLM-5.3-Flash (1M / 128K, id `glm-5.3-flash`): https://docs.z.ai/guides/vlm/glm-5.3-flash. Prices: https://docs.z.ai/guides/overview/pricing. API content not saved (privacy policy last update 2025-09-29, DPA §4(b) on the same page): https://docs.z.ai/legal-agreement/privacy-policy. Terms: https://docs.z.ai/legal-agreement/terms-of-use. OpenAPI paths (no models route): https://docs.z.ai/openapi.json.
- [S25] Re-checked for the keys CLI on 2026-10-10. `apiKeyHelper` stdout is sent as both `Authorization` and `x-api-key`; `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` overrides the five-minute cache (the launcher sets 60000). https://code.claude.com/docs/en/llm-gateway-connect and https://code.claude.com/docs/en/env-vars. `--settings` inline JSON overrides the session; `--max-budget-usd` is print mode (`-p`) and equals the reservation. https://code.claude.com/docs/en/cli-reference. `sandbox.credentials.envVars` (`deny`) and `sandbox.filesystem.denyRead`. https://code.claude.com/docs/en/settings-reference. Codex `[model_providers.<id>.auth] command` prints the token, `timeout_ms` 5000, `refresh_interval_ms` 60000, and is not combined with `env_key`. https://developers.openai.com/codex/config-advanced. `default_permissions` does not compose with `sandbox_mode`; a set `sandbox_mode` selects the older sandbox. Built-ins include `:read-only`, `:workspace`, `:danger-full-access`. https://developers.openai.com/codex/permissions. The helper allowance measured here is 4 calls per 60s window; the next call ends the lease.

## Open questions for the owner

1. **What runs after deploy.** Default: every Role keeps its current chain (Override `hand`), so nothing changes on its own. A mode applies once you put Roles under it with "All Roles follow" (`role --all follow`), which regroups chains that interleave providers, shown before and after. The alternative is to switch every Role at once to "subscriptions first, keys as overflow".
2. **Your daily Claude, Codex and Cursor runs through Morndo's gate.** This is what makes repo lists work on Claude subscriptions (on Codex and Cursor once they can give `os`), and what stops a stray API key from silently billing a subscription run. Default: yes, one provider at a time after the week of key runs, with the old start command as the rollback.
3. **The sandbox can't be switched off for DeepSeek, Kimi, OpenRouter and custom endpoints.** Default: yes. Anthropic and OpenAI keys and subscriptions run without it, unless you turn it on or set a repo list.
