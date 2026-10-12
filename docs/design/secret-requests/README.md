# Secret requests: an agent asks for a named secret, the owner types it into a sealed card, and agents use it by reference (design v2, 2026-10-11)

**Phase: design only.** This document and [ADR-0022](../../adr/0022-secret-requests.md). No product code yet.

**The request:** an agent asks for a secret the way it asks for a decision. Instead of a decision card, the owner gets an "insert secret" card. The value is stored securely and can be used again by other lanes and in later sessions. Domain rules and current best practice apply, and it ships in the public repo.

**Builds on:** ADR-0001 (pure domain, anti-corruption adapters), ADR-0004 (the web endpoint, passkeys, the hub behind the private network's TLS), ADR-0008 (the shared redactor, A4), ADR-0011 (the phone), ADR-0012 (the fleet: typed operations, FL7, FL14), ADR-0015 (agent tokens, and why they can't vouch for a lane), ADR-0017 (lane notices), ADR-0018 (the sealed store this design reuses: the age vault, the plaintext type, process ancestry, the exact-value filter, the widening rule). It does not redo ADR-0018: LLM connections and their keys stay there.

**v2, after an independent audit** (sources and DDD; it found every checked source holding and the structure sound, with gaps):
- Every invariant names its layer (domain, domain service with the store, application, adapter) and what proves it; only domain ones get domain tests (3.3, 3.4, 15.1).
- SR1, SR10 and SC2 span many aggregates: they belong to two domain services, Request admission and the Fingerprint ledger, with uniqueness held by the store (3.3, 3.4).
- "Placement" is gone: a Secret is one Reference on one node. "Ask" is defined in `docs/domain.md` as a role two aggregates play. A table separates the words shared with Connections (3.1).
- New ports: `HubLink` and `NodeRequests` carry requests from node to hub. `CallerIdentity` reads panes through `packages/node-ops`, not the node agent. The scanner is split from the index file adapter (section 14).
- PR 1 adds the anti-corruption rows to `docs/domain.md`, and the vendor-name test covers `secrets.ts` (section 16).
- Sources: the socket rules now quote the settings reference; `tlsTerminate` is marked experimental; git-credential(1), unix(7), the age format spec, OWASP's password storage sheet and Kubernetes are cited where they are used; S18's URL is current; NIST 800-63B is used by analogy.

**v1 review.** A fresh-context security review of the first draft found twelve problems. Each was checked against the code or the docs and folded in:
- A Grant matched git remotes, which any folder can claim; it now matches workspaces the node registered (section 6).
- "An agent never holds a value" was overstated: `exec`, `file` and `helper` stop accidents, not intent (7.0).
- Who asks was a header's claim; requests now go through the node, which vouches (4.1).
- A transfer's recipient was unsigned, and FL7 would have kept the ciphertext as an operation's outcome (SC11, SR7).
- Disable and Revoke weren't "at once" for running children, `inject` lanes or offline nodes (SC8).
- `inject` can't work with files on macOS (7.3).
- Several states of a request had no rule: joins, withdrawals, partial stores, an edited Reference (SR4, SR6, SR8).
- Hook bodies reached the fleet unfiltered (SC6).
- Node has no peer-credential call (section 6).
- The request's place in C1, C6, N2 and H3 was unstated (3.1).
- Base64 inside a longer string was missed (8.1).
- The wire test banned the ciphertext the store needs (section 14).

Facts carry a source and the date checked. **[S*n*]** points to section 18. UNVERIFIED marks what no primary source settled. **Q*n*** is owner question *n* at the end.

## 0. The design in short

1. An agent runs `morndo-secrets request secret://example-app/payments-test --purpose "…"`. The hub opens a **Secret request**, which shows as an **insert-secret card** on the Morndo web and phone app only. The agent either waits for the answer or goes on with other work and gets a lane notice.
2. The card has a masked field (paste allowed, show on demand), the Reference, who may use it, an optional expiry, and Store or Reject. Storing needs a fresh passkey check. The browser **seals the value to the target node's age recipient** before it leaves the page, so the hub and the fleet carry ciphertext only.
3. The node keeps the value in the ADR-0018 vault. The domain, the hub, events and logs know the **Reference** (`secret://scope/name`), never the value.
4. A **Grant** says which lanes, repositories or nodes may resolve the Reference. Nothing resolves by default.
5. A value reaches a process only at launch (`morndo-secrets run --env NAME=secret://… -- cmd`), through a credential helper the tool calls, or, for a sandboxed Claude Code lane, through the vendor proxy's mask. Each **Use** is audited before the value is opened, and the child's output passes an exact-value filter.
6. Each node keeps a **redaction index**: lengths and keyed hashes of each value's common encodings, never the value. Pane captures, transcript reads and job tails pass it before they leave the node.

## 1. What we looked at first

Read on `main` at 09ca6de. No secret was opened.

- **No agent raises an ask through a Morndo command today.** The hub finds asks by polling three passive sources: the manager's needs-you file, its `[buttons …]` chat line, and a worker's question or menu on its screen (`apps/hub/src/application/escalation-service.ts`, `apps/hub/src/adapters/ledger.ts`, `manager-protocol.ts`). The agent routes are `whoami`, `jobs/grant`, `usage` and `board` (`apps/hub/src/adapters/http.ts`). A secret request is the first ask an agent raises through a command.
- **Every way a decision answer travels would leak a value.**
  - An answer in words is typed into the asker's pane (`pane.send`), or for the manager written as plain text to an inbox message file (ADR-0010).
  - The phone's catch-up keeps a pending answer's body, words included, in `localStorage` (the run's shape in `apps/web/src/lib/catchup/run.ts`, stored under `morndo.catchup.run` by `session.svelte.ts`).
  - The manager's `[buttons]` lines, the needs-you file, hook events and `/notify` all reach the chat bot outside this tree (Telegram).
  - So the insert-secret card reuses the card's look and place, not its answer path.
- **The redactor knows shapes, not values.** `packages/protocol/src/redact.ts` has fixed patterns and no way to add a value at runtime. The only exact-value filter is `streamRedactor` in `apps/connections/src/adapters/redact.ts`, used by `morndo-keys run`. The hub blanks key shapes in feed frames and JSON bodies (`view-redact.ts`), but the `/api/terminal` socket is sent as is (`http.ts`, "The terminal socket does not").
- **ADR-0018's store exists.** `apps/connections` ships `morndo-keys` (the design called it `morndo-connections`): `AgeVault` (age-encryption 0.3.1, one file per ref, an X25519 identity), `FileVault`, `SecretMaterial` (serialises as `[secret]`), `Processes` (ancestry from `/proc`), and an application port `SecretVault` with no method that returns a secret.
- **The wider problem is measured.** A vendor's 2026 report counts 24,008 unique secrets exposed in MCP configuration files (its own figures; method not checked) [S23].
- **The agent CLIs.** Claude Code 2.1.296 and Codex 0.161.0 are installed (`--version`, 2026-10-11). Claude Code's sandbox can now **mask** a credential: sandboxed commands see a per-session sentinel, and its proxy puts the real value only into requests to the hosts listed for it [S1].

## 2. Goals and non-goals

**Goals.**
- An agent can ask for a named secret, with a purpose and who should use it, in one command, from any engine that runs shell commands.
- The owner answers from a phone or desktop, in Morndo's own app: a masked field, a scope, an optional expiry, Store or Reject.
- On the normal path, the value never enters a prompt, a transcript, a pane, a log, a report, a chat or the hub's database (7.0 says what an agent that means to reveal it can do). Agents and config files hold References only, which are safe to commit and to show.
- Least privilege by default: a stored value resolves for nobody until a Grant admits a caller, and the card proposes the narrowest useful one.
- Stored once, used by other lanes and later sessions without asking again, within the Grant.
- Every Use is on record. Rotation, expiry and revocation are first-class.
- A new machine of the fleet gets a value without anyone typing it again, and without plaintext crossing the fleet.

**Non-goals.**
- LLM provider keys for running agents. They stay Connections (ADR-0018), with their Lease gate and budgets.
- Subscription logins of agent CLIs. They stay the CLI's own (ADR-0001, FL14).
- Agents storing values themselves (a generated password, say). v1 stores only what the principal enters (section 17).
- A hosted vault, or isolation from processes of the same OS user. Same-user trust stays as in the [secret-store design](../secret-store/README.md) §5.3; section 12 says what moves.
- Showing a stored value again (Q3).

## 3. The model

### 3.1 A Secrets context, and why not more Connections

**Secrets** is a new bounded context: what agents may use for their work, and how the principal provides it. It holds two aggregates and two domain services:
- **Secret request** (on the hub): an agent's ask for a value or for access, answered once.
- **Secret** (on each node): one Reference on one node, with its versions, Grants and Uses.
- **Request admission** (a domain service on the hub): SR1 and SR10, which span every request of a node or lane.
- **Fingerprint ledger** (a domain service on each node): SC2, which spans every Secret on the node.

The code is `packages/domain/src/secrets.ts`, pure.

**Why not extend Connections.**
- A Connection is "something that can run agent work". Its Lease gate decides on terms, budget, isolation, dialect and a repo list, and it is consumed by the engine layer's chains.
- A secret for a lane's tool (a payment sandbox key, a deploy token, a database URL) has none of those. Its rule is who may resolve it: lanes, repositories and nodes, not roles and chains.
- Folding it in would give half of all Connections fields they never use, and would widen CN1–CN15 for a case they weren't written for.
- ADR-0018 kept key custody inside Connections because one gate decides one Connection. That still holds for LLM keys. It doesn't make every secret a Connection.

**What the two share** is infrastructure, not model: the age vault and the machine identity, the plaintext type, process ancestry, the repo inspector and the exact-value filter. The node-side Secrets services live in the same program, `apps/connections`, as a second command, `morndo-secrets`. ADR-0018 already hosts Engines' routing service there, so no adapter moves and the plaintext type stays in one app.

**Words the two contexts share, and how they differ.** They share a program, so a word that means two things would leak across:

| Connections (ADR-0018) | Secrets (this design) | Resolution |
|---|---|---|
| "Secret": the bytes of a key ("no secret in the model", CN1) | **Value** is the bytes; **Secret** is the aggregate | Secrets never says "secret" for bytes. Its domain has no type for them; adapters use `SecretMaterial`. |
| "Secret ref": the opaque id of a vault file | **Vault ref**: the same kind of id, `s-<random>` | Adapter-only: never in the Secrets domain, wire or events. A **Reference** (`secret://…`) is the public name, a different thing. |
| `SecretVault` port: `has`, `fingerprint`, `remove` | `SealedStore` port: `storeSealed`, `has`, `fingerprint`, `remove` | One adapter class per vault kind (`AgeVault`, `FileVault`) implements both; each context imports only its own port. |
| `SecretMaterial`: plaintext that never serialises | the same type | Shared, adapter-only, unchanged. |
| Fingerprint: 12 hex characters of SHA-256 | Keyed fingerprint: 12 hex characters of HMAC-SHA-256 | Different on purpose (3.2), with different field names (`fingerprint`, `keyedFingerprint`). |

**A request and Escalation: what an Ask is.** `docs/domain.md` used "Ask" under Escalation without defining it. v2 adds the definition there (this commit): an **Ask** is a role, not an aggregate. It is anything that waits for the principal's answer and shows as a decision card. Two aggregates play it: an Escalation that is an Ask (E1–E13), and a Secret request (SR1–SR11).
- Catch-up (C1), Notifications (N2) and lane status (H3) count Asks, whichever aggregate holds them.
- Escalation's answer rules (E8–E13) stay Escalation's. A Secret request is not an Escalation: its answer never reaches the asker as words (E9 sends words to the asker), and is never recorded in any form. It mirrors E1, E8, E12 and N1 in its own invariants.
- PR 1 amends C1, N2 and H3 to name both, and C6 to say that a card carrying a value has no Undo window (5.3).

### 3.2 Ubiquitous language

| Term | Means | Is not |
|---|---|---|
| Secret | One Reference on one node: its status, versions, Grants, Destinations and Expiry, with the value sealed in that node's vault. The same Reference on two nodes is two Secrets, each with its own versions and Grants. Each node is the system of record for its Secrets; the hub's read model groups them by Reference. | The value; an LLM connection's key (ADR-0018); a replica the hub owns. |
| Value | The bytes the principal entered. Exists only on the Endpoint while typed, sealed in a node's vault, and in a process a Use started. | Anything the domain, the hub, the fleet, an event, a log or a prompt holds. |
| Reference | The name agents and configs use instead of the value: `secret://<scope>/<name>`, such as `secret://example-app/payments-test`. Safe to commit, log and show. | A path, a URL anyone can fetch, a permission, a vault ref. |
| Scope | The Reference's first part: a namespace. The card proposes the requesting repository's name; `shared` is the convention for secrets many repositories use. | A Grant. A scope admits nobody. |
| Version | One value of a Secret over time: a number, its keyed fingerprint, when and by which Command it was stored. One version is current. | A copy on another node: that is another Secret. |
| Keyed fingerprint | 12 hex characters of HMAC-SHA-256 over the value, under a key that stays on the node. Used for dedupe and audit. | A plain hash. Fast hashes such as SHA-256 "allow attackers to perform large numbers of guesses quickly" [S25], so a short value's plain hash could be guessed; a key kept on the node is the HMAC "pepper" that stops guesses off it [S25] (12.6). |
| Workspace | A repository root the principal registered on a node, and every git worktree that shares its git directory. | A folder that merely has a matching git remote. |
| Grant | Who may resolve a Reference on a node: a subject (one lane, a workspace, or every lane on the node), the use modes allowed, and an end (when revoked, at an instant, or when the lane ends). | An agent token; a Mandate. |
| Use | One resolution of a Reference for one process: the caller (node, lane as the process tree shows it, workspace), the mode, the Grant that admitted it, the time, the outcome. | Reading the value into a prompt. |
| Use mode | How a value reaches a process: `exec` (the environment of a child that `run` starts), `file` (a 0600 file whose path the child gets), `helper` (stdout of a credential helper to the tool that called it), `inject` (the agent CLI's sandbox proxy puts it into requests to the Destinations; the command sees a sentinel). | `print`: there is none. |
| Destinations | Optional hosts the value is meant for. Binding under `inject`; shown on the card and advisory otherwise. | A network policy for the lane. |
| Ask | (`docs/domain.md`) What waits for the principal's answer as a decision card: an Escalation that is an Ask, or a Secret request. | An aggregate. |
| Secret request | An agent's ask: a Reference, a purpose, a kind, the requester, and a proposed Grant. One answer: Stored, Granted, Rejected; or Withdrawn by its requester; or Expired. | An Escalation; a chat message. |
| Request kind | `new` (no value yet), `access` (a value exists, the requester isn't granted), `rotate` (replace the current value), `renew` (it expired). | The answer. |
| Insert-secret card | The request's card on Morndo's web endpoint: a masked field, the Reference, the Grant, an optional expiry, Store, Reject, Later. | A decision card; a Telegram message. |
| Recipient | A node's age public key (`age1…`) that Endpoints seal values to. Reported by the node over the fleet, signed with its node key, and pinned by each Endpoint on first use. | The node's fleet key (FL2); a secret. |
| Redaction index | Per node: for each value of the last 30 days, the length and a keyed hash of each indexed encoding. Read by every output path on the node. | A list of values. |
| Shape | A public pattern a value matches (a vendor's token prefix and length), from the shape catalog. Sent to the hub's shared redactor. | The value, or a pattern derived from its private part. |
| Disable, Revoke, Delete | Disable stops every new Use, reversibly (anyone). Revoke destroys the current value on a node (the principal). Delete removes the Reference and its Grants (the principal). | Rotation. |

### 3.3 Invariants: Secret requests (hub)

Each invariant names its layer, as ADR-0018's CN5 splits the model's part from the edges', and what proves it:
- **domain**: pure code in `packages/domain/src/secrets.ts`, proved by a domain test;
- **domain service + store**: a rule over many aggregates, decided by a domain service, its uniqueness held by the store (a store test proves it);
- **application**: a service's order or policy, proved by an application test with fakes;
- **adapter**: an edge, proved by a contract test or the end-to-end run (15.5).

| # | Invariant | Layer | Proved by | Mirrors |
|---|---|---|---|---|
| SR1 | One open request per (node, Reference). A repeat from any lane joins it: the card lists every lane that waits, and nothing else changes. | domain service + store | Request admission's domain test; a store test in which two concurrent opens make one request and one join | E1 |
| SR2 | A request is not opened when the requester's broker, running the use gate (SC3) for that caller without opening anything, admits it: it answers `available` at once, and nothing reaches the hub. With a value but no admitting Grant, it opens as `access`, and its card asks for a Grant, never for a value. The hub's read model never decides this: a stale copy would answer `available` while `run` is refused. | application | Broker test with a fake vault and caller (15.3) | E5 |
| SR3 | A request carries the Reference, a purpose (plain text, at most 300 characters, shown as the agent's words), its kind, the requester as its node saw it (node, lane from the process tree, workspace; section 6) and a proposed Grant. No type has a field a value could travel in. The wire refuses whole a body with a key named like `value`, `secret`, `token`, `password` or `key`. | domain + adapter | Shape test (domain); wire test (protocol) | CN1 |
| SR4 | A request takes one answer: Stored, Granted or Rejected from the principal, Withdrawn when its last waiting lane withdraws (an earlier withdrawal only takes that lane off the list), or Expired 7 days after it opened. A second answer is refused and shows the first. A request that ended can be asked again; that opens a new one. | domain | Domain test | E8, E10 |
| SR5 | Store and Grant are Commands that widen (SC7). Each needs a user verification from the last 5 minutes, whatever the step-up policy, as AC8 to AC10 do. Reject and Later need a valid Session only. | application, with Access's freshness rule | Application test; the end-to-end run checks the prompt | AC7 to AC10 |
| SR6 | An answer names the version of the request it saw: its kind, Reference, the waiting lanes with each one's purpose and workspace, and the proposed Grant. If any changed since, a join or a withdrawal included, it is refused as `changed`. Editing the Reference on the card to one that already has a value turns the card into a Rotation, which it says, and asks again. | domain | Domain test | E12 |
| SR7 | **Sealed on the Endpoint.** The value is encrypted on the Endpoint to the recipient of each target node that this Endpoint has pinned, before it leaves the page. The hub and the fleet carry the ciphertext in memory only, until the node confirms or the operation times out. They never write it to a database, a log, a queue file, an audit row or a crash report. FL7's record of a `secrets.*` operation keeps a hash of its outcome, never a ciphertext, so a repeat runs again instead of replaying one. Plaintext leaves the Endpoint only inside a target node. | adapter (web, hub, fleet, node agent) | Contract tests: the store route and the done-key record hold no ciphertext after the operation; the end-to-end scan (15.5) | FL14, CN5 |
| SR8 | A request is Stored only when the requester's node confirms its keyed store operation. Until then it stays open, and a failure (node offline, a recipient that changed, a ciphertext that doesn't open) is shown on the card with nothing kept: the owner enters the value again to retry. Other target nodes get Secrets of their own: each one that fails is shown on the Secrets page, to retry by transfer (9.2), and doesn't hold the request open. | domain (the state moves only on that confirmation) + application (the store across nodes) | Domain test; application test with a fake fleet | E13, FL7 |
| SR9 | **Only on Morndo's web endpoint.** No chat adapter, `[buttons]` line, needs-you file item, hook event a chat bot receives, `/notify` event, manager-inbox message or pane text carries a request as answerable or carries an answer. A Notification counts it as a waiting decision and says nothing else (N1). A link to the card is never pre-authenticated: it opens only in a valid Session, as the MCP spec requires of a URL that collects a credential [S5]. | adapter (routing and links) | Contract test: the fleet routes `/secrets/*` to the hub's subscriber only, and a planted second subscriber fails it; the end-to-end run opens a card link with no Session and lands on sign-in | N1 |
| SR10 | A lane holds at most 5 open requests and opens at most 20 a day, and a node at most 20 and 100; past that, a request is refused with the limit named. The card shows who asks as the node saw it (node, lane, workspace) above the agent's words. | domain service + store | As SR1: counting and inserting in one write transaction | ADR-0008 A6 |
| SR11 | A request, its answer and its card grant nothing beyond the Grant the principal stored: no Mandate, no Decision for another Ask, no board move. | domain | Domain test: no event of a request names a Mandate, a Decision or a task status | N5, J7 |

Aggregate **Secret request**: its state (SR4), its version (SR6) and the requester node's confirmation (SR8) are its consistency boundary. SR1 and SR10 span every request of a node or lane, so they are **Request admission**'s: `admit(open requests of the node, the lane's and node's counts, the request)` returns open, join (with the request id) or refuse (with the limit). The store holds a unique index on (node, Reference) over open requests, and runs the counts, the decision and the insert in one write transaction, so two concurrent requests can't both open.

States: **Open**, then **Stored**, **Granted**, **Rejected**, **Withdrawn** or **Expired**. Events: SecretRequested, SecretRequestJoined, SecretRequestStored (Reference, nodes, version, Command id), SecretRequestGranted, SecretRequestRejected (with the principal's reason, if any, which goes back to the requester), SecretRequestWithdrawn, SecretRequestExpired.

### 3.4 Invariants: Secrets (node)

| # | Invariant | Layer | Proved by | Mirrors |
|---|---|---|---|---|
| SC1 | **No value in the model.** A Secret holds its Reference, status, versions (number, keyed fingerprint, stored at, Command id), Grants, Destinations, Expiry and Shape id. No domain type, wire shape, event, audit row or log line carries more. | domain (+ adapter for logs) | Shape test (allowlist of keys); the end-to-end scan for logs | CN1 |
| SC2 | A Reference is unique on a node and follows the grammar (3.6). At most one version is current. A store under an existing Reference is a Rotation, which is the principal's. A value whose keyed fingerprint matches a revoked version anywhere on the node, or any earlier version of the same Reference, is refused. A match with another active Secret is stored, and the card says "same value as …". Fingerprint keys are per node, so this holds per node; storing a Reference that is revoked on another node gets a warning on the card. | domain service + store | Fingerprint ledger's domain test; a store test of the unique indexes and the transaction | CN2 |
| SC3 | **Default deny; the use gate.** A Secret with no Grant resolves for nobody. The gate, in order: status active; a current version on this node; now before Expiry; a Grant admits the caller (its lane, its workspace, this node) and has not ended; the Grant allows the mode. The first failure is the refusal: recorded, and `run` exits 77. | domain | Domain test, one refusal per step, in order | CN8 |
| SC4 | **Recorded before use.** `SecretUsed` is durable before the vault opens the value. Refusals are recorded too. | application | Broker test: killed between the record and the open, it leaves a record and no value (15.3) | CN9 |
| SC5 | **Only the use modes.** A value reaches a process only as the environment or a 0600 file of a child `run` starts, as a helper's stdout to the tool that called it, or through the agent CLI's sandbox proxy (`inject`). Never as an argument, a prompt, a workspace file, the lane's own environment, a hub or fleet message, or the output of a command the agent reads unfiltered. No command prints a value. | application + adapter | Architecture test (no command prints a value); broker test (`/proc/<pid>/cmdline`); the end-to-end run | CN5 |
| SC6 | **Output is filtered on the node.** Every output path the node controls passes the exact filter before it leaves the process or the node: the stdout and stderr of a `run` child, pane captures and frames, the terminal stream, transcript reads, job tails, and hook bodies and `/file` copies in the hook relay before they are spooled. The filter knows every version stored or retired in the last 30 days, in every indexed encoding (8.1). The index holds lengths and keyed hashes, never a value, and is updated before a store or rotation is confirmed. | adapter | Scanner tests (15.4); a contract test per output path; the end-to-end scan | secret-store design §6.2 |
| SC7 | **Narrowing is anyone's; widening is the principal's, judged by effect.** A change widens when afterwards the Secret may resolve for more lanes, workspaces or nodes, in more modes, to more Destinations, for longer, or again after a Disable. Disable is anyone's, an agent's included: one that sees a leak stops every new Use at once (SC8). Enable, Rotation, Revoke, Delete and every widening are the principal's: a Command from the hub with a fresh verification (SR5), or at the machine with a typed confirmation and no `--yes`. | domain (narrowing or widening) + application (who may command) | Domain table test of changes; application test of who may make them | CN13 |
| SC8 | Disable and Revoke refuse every new Use at once. Revoke also destroys the current value on that node (the vault file removed) and keeps the Reference, its history and its Grants, so a new value under it is a new version. Delete removes the Reference and its Grants. A running child keeps what it already has; an `inject` lane's file is deleted and the lane restarted. A node that is offline gets the Command when it reconnects, and serves until then; the page says "pending on node-b". The audit outlives all of these by 90 days. | domain (status refuses new Uses) + adapter (vault removal, the lane restart, delivery on reconnect) | Domain test; store-port contract test (15.2); the end-to-end run | CN14 |
| SC9 | Expiry is optional per Secret. Warnings go once each, 7, 2 and 1 days before. Expired, every Use is refused, and the first refused Use opens a `renew` request (SR1 dedupes). | domain | Domain test with a fake clock | CN12 |
| SC10 | **A Secret grants nothing.** A Use is not a Mandate: holding a deploy token never authorizes an irreversible action (A2). A Grant is not an agent token, and an agent token is not a Grant. | domain | Domain test: no Secret event names a Mandate | CN15, J7 |
| SC11 | **Moving between nodes is the principal's.** A value goes to another node only by a transfer Command (fresh verification), from a node that holds it to a node the Fleet admitted (FL1). The target's recipient is signed with the target's node key; the source checks that signature against the node key the Fleet admitted at Join (FL1, FL2) before it seals, so a hub alone can't put in a recipient of its own. The hub and the fleet carry ciphertext only (SR7). Grants go with it, each narrowed to the target node. | domain (Grants narrowed) + adapter (signature check, sealing) | Domain test; contract test in which a wrong signature is refused; the two-node run (PR 6) | FL14 |

Aggregate **Secret**, one per Reference per node, with its versions, Grants and open Uses inside it: the use gate (SC3), its status and its versions are its consistency boundary. A closed Use leaves as an event. The clock is the `now` argument.

SC2 spans every Secret on the node, so it is the **Fingerprint ledger**'s: `check(the node's ledger, Reference, keyed fingerprint)` returns accept, refuse (revoked), refuse (an earlier version) or accept with a warning (same value as another Reference). The store keeps every version's keyed fingerprint, revoked ones included, in one table. It holds unique indexes on the Reference (the aggregate's identity) and on (Reference, keyed fingerprint), and runs the check and the insert in one write transaction.

Events: SecretStored, SecretRotated, SecretDisabled, SecretEnabled, SecretRevoked, SecretDeleted, SecretExpired, ExpiryWarned, GrantAdded, GrantRemoved, GrantEnded, DestinationsChanged, SecretUsed, UseRefused, UseEnded, SecretTransferred. Widening events carry the Command id.

### 3.5 Who holds what

| Holder | Holds | Never holds |
|---|---|---|
| The Endpoint (browser) | The value while typed; the pinned recipients. | The value after Store or Reject, in any storage. |
| The hub | Requests, their events, a read model of every node's Secrets (metadata), Alerts. | The value; the ciphertext beyond one operation. |
| The fleet | Typed operations in flight, the audit of each (no arguments, FL14). | The value; the ciphertext beyond one operation. |
| The node | The vault file, the Secret's metadata, the fingerprint ledger, the redaction index, the Use audit. | The value outside the vault and a Use's process. |
| A Use's process | The value, in its environment or a file. It is a process the agent started, so the agent can make it reveal the value (7.0). | Anything the agent's model reads unfiltered, on the normal path (SC5, SC6). |

### 3.6 References

Grammar: `secret://<scope>/<name>`.
- `scope`: `[a-z0-9][a-z0-9-]{0,39}`.
- `name`: `[a-z0-9][a-z0-9._-]{0,63}`.

Lower case only, so two spellings can't name two secrets. The environment variable name is chosen at the Use, not stored: `--env PAYMENTS_KEY=secret://example-app/payments-test`. The prefix follows the established pattern of a secret reference that names a location instead of carrying the value, as 1Password's `op://vault/item/field` [S9].

### 3.7 Context map additions

- *Access supplies Secrets*: the Session and its fresh verification (SR5).
- *Secrets supplies Catch-up, Notifications and Observation with Asks*: an open request is a decision card (C1), raises one Notification (N2), and makes its lane wait for the principal (H3).
- *The Fleet carries Secrets' typed operations*, keyed (FL7), and one node event, `secrets.requested`, routed to the hub only (SR9). FL14 is refined: no plaintext secret and no agent-CLI credential crosses the fleet; a value sealed to one node's recipient may (12.2).
- *Secrets stands beside Connections*: shared vault, identity and process adapters, no shared model, and the word table in 3.1. An LLM key is a Connection; a value a lane's tools need is a Secret.
- *Secrets stands beside Authority*: a Use is not a Mandate (SC10).
- *Board*: a request may name a task. Its answer becomes one comment on it, keyed by the request id, which does not move it (B3, B8, as J3).

## 4. How an agent asks

### 4.1 The command

`morndo-secrets` is the second command of `apps/connections`. The calls an agent makes:

```
morndo-secrets request secret://example-app/payments-test \
    --purpose "Run the checkout tests against the payment sandbox" \
    [--for repo|lane|node] [--rotate|--renew] [--task T-12] [--wait [10m]]
morndo-secrets status <request-id | reference>
morndo-secrets wait <request-id> [--timeout 10m]
morndo-secrets withdraw <request-id>
morndo-secrets list                   # References this lane may use here, and their state. No values.
morndo-secrets run [--env NAME=REF]... [--file NAME=REF]... [--env-file PATH] -- <command...>
morndo-secrets disable <reference>    # anyone: stops every Use on this node
morndo-secrets prompt                 # the instructions block for agents (docs/agents/secrets.md)
```

- **`request` goes through the node, not straight to the hub.** The CLI talks only to the node's broker (section 6). The broker adds what the node sees: the lane from the caller's process tree and the registered workspace with its repository. It answers SR2 itself, and otherwise hands the request to the node agent, which sends it to the hub as a node event over its proven connection (FL2).
  - Why: one worker token serves every lane on a machine and names its lane in a header (ADR-0015), so a token can't vouch for a lane, and a lane could claim to be another.
  - The card shows the node's view, labelled "as node-a saw it". The node's view is stronger than a header, but it is still not proof (12.10).
- `--for` proposes the Grant's subject. The default is `repo`. `node` must be asked for and is shown as wider on the card.
- The kind is `new`, or `rotate` and `renew` when asked for. SR2 turns a `new` into `available` or `access` when it finds a value.

### 4.2 Pause or continue

The agent picks:
- **Continue** (no `--wait`): exit 0 and one line: `requested secret://example-app/payments-test (r-7f3a); the owner will be asked; you get a notice when it is answered`. The agent goes on with other work. When the request ends, the node's delivery queue (ADR-0014) types one notice into the lane, id `secrets:request:<id>:answered`, with the Reference and the outcome only. With `--task`, the answer is also one comment on that task.
- **Wait** (`--wait [duration]`, default 10 minutes, at most 60): the CLI waits on the broker. The answer reaches the node anyway: as a `secrets.store` operation, or as `secrets.answered` for a reject, a grant, a withdrawal or an expiry. Exit 0 when the value is available to this lane, 1 when rejected, withdrawn or expired (with the principal's reason, if any), 75 when the wait ends with the request still open.
- **Already there:** exit 0 and `available`, without a card (SR2).

Exit codes otherwise follow `morndo-board`: 1 refused (a bad Reference, over the limit), 2 usage, 3 when the broker or, through it, the hub can't be reached. Nothing is queued then: the agent asks again later.

While a request of its own is open, a lane counts as waiting for the principal (H3). The prompt block tells the agent to block its board task with the Reference when it can't go on without it.

### 4.3 What the agent instructions say

`morndo-secrets prompt`, and `docs/agents/secrets.md` kept equal by a test, as `docs/agents/board.md` is:
- Never ask for a secret in chat, in a report, or in a question. Ask with `morndo-secrets request`.
- Never write a value into a file, an argument, a commit, or your output. Use References, and `morndo-secrets run`.
- When the tool can read a credential from a file, use `--file`; use `--env` only when it can't. OWASP: environment variables are "not recommended unless the other methods are not possible" [S6].
- A config that needs a secret gets a Reference line in an env file (`PAYMENTS_KEY=secret://example-app/payments-test`), which is safe to commit.
- If you see a value in any output, run `morndo-secrets disable <reference>` and say so in your report.

## 5. The insert-secret card

### 5.1 Where it shows

Where decision cards show, with the same badge and the same Notification:
- the desktop's decisions panel and inline under the lane's message;
- the phone's catch-up stack and the lane's chat;
- the Secrets page (section 10), as a list of open requests.

It never shows in Telegram or any chat bot (SR9). A device that isn't a paired Endpoint never sees it.

### 5.2 What it shows

1. **Who asks**, as the node saw it: node, lane, repository. Each waiting lane is listed with its own purpose and repository, and the Grant picker offers each repository.
2. **The Reference**, `secret://example-app/payments-test`. Scope and name can be edited before storing; the requesters are told the final Reference.
3. **The purpose**, quoted and labelled "the agent says". It is plain text: no links, no markdown.
4. **The kind** in words: "New secret", "Access to an existing secret" (no field), "Replace the value", "Renew: the value expired".
5. **The field** (not for `access`):
   - `<input type="password">`, with `autocomplete="new-password"`, `autocapitalize="off"`, `autocorrect="off"` and `spellcheck="false"`. `off` "will not prevent a password manager from asking the user if they would like to save"; `new-password` keeps a saved login, such as the hub's own, from being filled in, and is "a hint to browsers; some may not comply" [S17]. Password managers are not blocked: pasting from one is the usual way a value arrives, and NIST says verifiers "SHALL allow the use of password managers" [S7]. NIST's rules are for password verifiers, a different job; this design follows them by analogy, for a field that takes a credential. `spellcheck` stays off because the Show toggle turns the field into text, where spellcheck applies [S17];
   - paste allowed, and a Show toggle that reveals it until the next tap. By the same analogy: verifiers "SHOULD permit claimants to use the 'paste' function" and "SHOULD offer an option to display the password" [S7];
   - a "multi-line" switch for PEM keys and JSON, which uses a masked text area, and "From a file", read in the browser and never uploaded;
   - at most 16 KiB. A value under 8 bytes is accepted with a warning: it is too short to filter from output (8.1).
6. **Who may use it**: the Grant picker. "This repository, any lane" is preselected (Q1); "This lane only, until it ends" and "Every lane on this node" are the others; a wider choice than the agent asked for is marked "wider than requested".
7. **Where it is stored**: the requester's node by default, plus any other node of the fleet. Each node shows its recipient's short fingerprint.
8. **Optional**: an expiry date and Destinations (hosts the value is for).
9. **Buttons**: Store (or Grant, for `access`), Reject (with an optional reason sent to the requester), Later.

### 5.3 What happens on Store

1. The page asks for a passkey check if the last one is older than 5 minutes (SR5).
2. It loads `age-encryption` 0.3.1 in a chunk of its own, only now, so the bundle budget of every other page is unchanged. typage "uses the Web Crypto API when available" and supports "all recent browsers" [S4].
3. It checks each target node's recipient against this Endpoint's pin. The first time, it pins it after showing its fingerprint. A changed recipient stops the store and tells the principal to compare it with `morndo-secrets recipient` on that machine, as AC6 does for the hub.
4. It encrypts the value once per target node and sends `POST /api/secrets/requests/<id>/store` with the request version it saw, the request id of this attempt, the Grant, the expiry, the Destinations, and one ciphertext per node.
5. It clears the field and drops every reference to the value, whatever the answer. The value is never in `localStorage`, `sessionStorage`, IndexedDB, the outbox, the catch-up run or a log. The catch-up records only that this card was handled; there is no Undo window for a value (unlike C6), because holding it 5 seconds would mean keeping it.
6. The hub checks SR4 to SR6 and sends a keyed `secrets.store` operation, naming the request and its kind, to each node through the fleet. The node checks that the age file opens with its identity. For a `renew` it checks that the store names an Expiry later than now and than the Secret's current one, and otherwise refuses with `renew_expiry` before it stores anything, so the request stays open and nothing is kept (SR8). It computes the keyed fingerprint and the redaction index, seals the file as it came, and records SecretStored. Only then does it confirm, with the Reference it stored under, the version, the time it stored at by its own clock, and whether the renew rule held (`renewed`). The hub takes a confirmation only for the Reference its answer names, and a `rotate` or `renew` only under the request's own Reference (T-88). The answer carries every confirming node's confirmation, each node once; each one must name that Reference and lie in the hub's window, and SecretRequestStored names exactly those nodes, so no node is listed under a Reference it didn't store (decided on T-94). For a renew, every one of them must say `renewed`, each with the Expiry later than its own time of the store (review 8 of PR #40, decided on T-94). The hub marks a renew Stored only on the requester node's own confirmation that it renewed, never on another node's, with that time between five minutes before the request opened and five minutes after the hub's now. The renew check on the node was decided on T-80 (review round 4); judging it by the node's time, on T-83 (review round 5); by the requester node's `renewed`, on T-85.
7. The card says "Stored on node-a, version 1" and nothing derived from the value. The requesters get their notice, or their `--wait` returns.

**Reject** ends the request. **Later** takes the card out of this run only, as C6 does.

### 5.4 A value typed in the wrong place

The lane chat's composer checks its text against the shape catalog before sending. A match asks "This looks like a secret. Send it as a secret instead?" and offers the insert-secret flow for a new Reference. This catches the common mistake, pasting a token into a chat; it cannot catch a value with no known shape.

## 6. Custody on the node

- **Vault.** The ADR-0018 vault and identity: one age file per Secret under the Connections home's `vault/`, named by a vault ref of its own kind (`s-<random>`), encrypted to the node's identity.
  - The adapter gains `storeSealed(ref, ciphertext)`. It opens the file once with the node's identity, refuses one that doesn't open, and writes the ciphertext as received, with ADR-0018's temp file and rename. The plaintext vault (`MORNDO_VAULT=file`) refuses every sealed store (15.2; decided on T-85).
  - It also refuses a file whose header has more than one recipient stanza. In age, the header "wraps the file key for one or more recipients" and lists "one or more recipient stanzas" [S26], so the node can count them. Exactly one is Morndo's rule, not age's: it makes each copy readable by one node only (5.3, 9.2). A grease stanza doesn't count: rage adds one, typed `<1 to 8 printable characters>-grease`, to every header without scrypt (age-core `grease_the_joint`), and identities "MUST ignore unrecognized stanzas" [S26]; any other second stanza counts, a type Morndo doesn't know included (review 10 of PR #40, decided on T-94). age itself requires the same of passphrase files, where "an scrypt stanza, if present, MUST be the only stanza in the header" [S26].
- **Metadata** is in the Connections database, in new tables (`secrets`, `secret_versions`, `secret_grants`, `secret_uses`, `secret_events`, `secret_workspaces`), with a numbered migration. `secret_versions` is the fingerprint ledger's table (3.4).
  - As built in PR 2 (migration 2, `apps/connections/src/adapters/secrets-sqlite.ts`, T-94): unique indexes on `secrets(reference)`, `secret_versions(reference, keyed_fingerprint)` and `secret_versions(reference, version)`, and a partial unique index on `secret_versions(reference)` where the state is current, so the store holds "at most one version is current" too; `secret_workspaces` has a unique name and a unique root. CHECKs keep states, statuses, versions and the 12-hex fingerprint in range.
  - Each version's vault ref lives on its ledger row (`secret_versions.vault_ref`), null once its file is removed. A save sets only the refs its change names; a row it leaves out keeps its ref, and clearing one names it with none (review 9 of PR #40, T-94). The ledger only grows: a save that drops, moves or changes a stored entry's Reference, version or fingerprint is refused; only its state and vault ref change (SC8's "the ledger keeps its versions" as a store rule). Events are append-only the same way.
  - Open for PR 3: the Secrets connection runs `synchronous=NORMAL`, as the Connections store does. In WAL mode "a transaction committed ... with synchronous=NORMAL might roll back following a power loss or system crash" (https://www.sqlite.org/pragma.html#pragma_synchronous, read 2026-10-12), so SC4's record before use, and a store confirmed to the hub (PR 4), need `FULL` on this connection. And each write reads every stored event; with a Use adding events and the audit kept 90 days, PR 3 should pass new events as a delta (or record Uses in `secret_uses` alone) and say which record SC4 relies on.
- **Keys of the node.** Besides the age identity: the fingerprint key and the index key, 32 random bytes each, 0600, beside the identity and excluded from backups with it.
  - As built in PR 2 (T-94): `fingerprint.key` and `index.key` in the Connections home, made on first use with a link into place, so two processes making one at once end with one key; a key file of another length, or looser than 0600, is refused (`apps/connections/src/adapters/node-keys.ts`).
- **A store, as built in PR 2** (D2, decided on T-85; `apps/connections/src/application/secrets-service.ts`, T-94):
  1. the sealed value is written under a fresh vault ref `s-<16 hex>`, after the vault's checks (`storeSealed`);
  2. the index entries are computed from that file (keyed hashes only);
  3. one `BEGIN IMMEDIATE` transaction checks the file is still there, runs the domain (the ledger check included), adds the new version's entries to the index file and saves, with the version's vault ref;
  4. after the commit, a write transaction of its own retires the replaced version in the index, and then its file is removed. A refusal or a failure removes the new file.
  - The index file is written outside the SQLite transaction, so only additions happen inside it: a rolled-back addition filters more, but a rolled-back retirement would leave a live version to be pruned 30 days later. A retirement therefore follows its commit; a crash in between leaves the version live (filtering more) until the sweep. Found while wiring the index writer, decided on T-94.
  - Revoke and Delete clear the current version's vault ref in their transaction, then retire it in the index and remove the file after the commit.
  - What fails after a commit (the retirement, the file removal) never undoes the change or stops the next step: the command names it as left to clean and exits 3; the next sweep cleans up what it can (review 4 of PR #40, decided on T-94). The sweep itself never stops a command: a failed sweep is a warning, so an emergency `disable` or `revoke` runs with the index unreadable (review 3). An index file the reader refuses is a file problem, exit 70.
  - Every `morndo-secrets` command first sweeps, inside a write transaction so no store commits meanwhile: it removes the `s-` files no version refers to, and retires in the index every version the ledger no longer holds current (retiring again keeps the first time).
  - Plaintext bytes this code holds are zeroed after use: the decrypted value once fingerprinted or indexed, and `put`'s stdin buffer and its copies once sealed, whatever the outcome (review 12 of PR #40). What it can't zero: the age library's own buffers while it encrypts and decrypts, and the copies Node's stream makes before the bin gets stdin's bytes.
  - The index file is `secret-index.json` in the Connections home, written whole by temp file and rename at 0600, and created by the first write. Each write reads it as the scanner does, so an index the scanner would refuse (mode, owner, kind or format) is refused on write too and left as it is: a loosened index stops every store until it is fixed.
- **Workspaces, as built** (T-94, `apps/connections/src/adapters/git-workspaces.ts`): `git rev-parse --path-format=absolute --git-common-dir`, the output resolved with realpath; without `--path-format=absolute` a subdirectory of the main worktree prints `../.git` (git-scm.com/docs/git-rev-parse, read 2026-10-12, git 2.43.0). Git runs with every `GIT_` variable cleared, since a `GIT_DIR` or `GIT_COMMON_DIR` there overrides `-C` and would answer for every path (git-scm.com/docs/git, "Environment Variables"). Any git failure means no workspace. `workspace add PATH` registers that common dir, with the repository directory's name.
- **The recipient** (`age1…`) is reported to the fleet by the node agent as node metadata, signed with the node's key (FL2), so other nodes can check it (SC11).
- **Workspaces.** The principal registers repository roots on a node: `morndo-secrets workspace add PATH` at the machine (typed confirmation), or from the Secrets page. A caller's working directory belongs to a workspace when `git rev-parse --git-common-dir` there resolves to a registered root's git directory, which covers every worktree of that repository. A git remote counts for nothing, since `git remote add` in a scratch folder would claim any repository.
- **The broker.** `morndo-secrets serve` runs as a user service on each node: a systemd user unit, or a launchd agent on macOS. It owns the gate (SC3), the Use record (SC4) and every vault open. It listens on a Unix socket in a 0700 directory of the user's runtime directory, and answers only callers whose peer credentials have its own uid.
  - **Caller identity** is the `CallerIdentity` port (section 14), and its adapter composes four sources, none of them another app:
    - the peer's pid (below);
    - the process ancestry, from the existing `processes` adapter;
    - the pane table, from `packages/node-ops`' tmux adapter. Both `apps/connections` and the node agent already depend on that package. It gains `panes()`, which lists `#{pane_id}`, `#{pane_pid}` and `#{window_name}`; today's `listWorkers()` reads no pane pid. So no app imports another.
    - the workspaces in the store.
  - **The lane** is the window of the pane whose process is an ancestor of the caller, not the claimed `MORNDO_LANE`. A process with no pane among its ancestors, a `morndo job` child for one, has no lane. It passes only a workspace or node-wide Grant.
  - **How the broker learns the caller's pid is open.** The kernel offers it: `SO_PEERCRED` "returns the credentials of the peer process connected to this socket" on a connected `AF_UNIX` stream socket [S27]. Node's `net` module doesn't expose it: on the installed Node 22.23.3 only `_getpeername` matches (`node -e`, 2026-10-11). The candidates:
    - a small native addon calling `SO_PEERCRED` on Linux and `LOCAL_PEERPID` on macOS;
    - on Linux only, matching the peer socket's inode through `/proc`.

    The macOS ancestry source is open too (`pid.ts` reads `/proc`; ADR-0018 left `sysctl` to its PR 4). A spike settles both before PR 3 starts.
  - **Not proof.** All of this runs as one OS user. A process can be started inside another lane's pane (`tmux split-window`), or `cd` into another lane's worktree. Ancestry and workspaces stop mistakes and casual misuse, not a same-user attacker (12.10).

## 7. Use without exposure

### 7.0 What each mode protects against

| Mode | The agent's conversation sees the value | A process the agent starts holds it | So it stops |
|---|---|---|---|
| `exec`, `file` | No, on the normal path: output is filtered | Yes | Accidents: a value echoed, logged or pasted. Not an agent that means to reveal it (by reversing it, writing it to a file it then reads, or calling the broker itself). |
| `helper` | No, on the normal path | Yes: with `fill`, "the username and password attributes of the credential description are then printed to stdout" [S28] | The same as `exec`. |
| `inject` | No | No: commands see a sentinel [S1] | Accidents and intent, for the Destinations only. |

The card's Grant picker shows this in words: "processes this agent starts can read it" for the first three, "the agent's commands never hold it" for `inject`. The default modes are `exec`, `file` and `helper`, because `inject` works only on one vendor's sandbox, on Linux (7.3).

### 7.1 `exec` and `file`: launch a child with the value

```
morndo-secrets run --env PAYMENTS_KEY=secret://example-app/payments-test -- npm test
morndo-secrets run --file GOOGLE_APPLICATION_CREDENTIALS=secret://example-app/service-account -- ./deploy.sh
morndo-secrets run --env-file .env.morndo -- npm run dev
```

1. `run` asks the broker for each Reference. The broker runs the gate, records the Use, opens the value, and passes it back over the socket.
2. `run` starts the child with the value:
   - **`--env`**: in the child's environment only;
   - **`--file`**: in a 0600 file under a 0700 directory of the runtime directory, created for this Use, with the variable set to its path and the directory removed when the child exits. This follows systemd's credentials, which are files in a per-service directory rather than environment variables [S12]. On Linux the runtime directory is a tmpfs (`findmnt` on `/run/user/<uid>` here, 2026-10-11), so the file never reaches durable storage, as Kubernetes keeps mounted secrets on "a tmpfs so that the confidential data is not written to durable storage" [S15]. macOS has no such directory; there the file is on disk for the child's life;
   - **`--env-file`**: a file of `NAME=secret://…` lines, safe to commit, as the reference files of 1Password and Doppler are [S9, S11].
3. `run` stays the parent and passes the child's stdout and stderr through the exact filter (SC6). Interactive children keep the terminal, and the filter applies to what the node captures.
4. It exits with the child's code. A refusal exits 77 with one JSON line on stderr (`{"refused":"not_granted","reference":"…","ask":"morndo-secrets request …"}`). A broker that can't be reached exits 75. A child's own 75 or 77 comes out as 1, so neither can be mistaken for `run`'s.
5. It refuses variable names that change how a program loads or starts: `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PYTHONSTARTUP`, `PYTHONPATH`, `BASH_ENV`, `ENV`, `PERL5OPT`, `RUBYOPT`, `GIT_*`, `PATH`. Doppler warns that some names "can have unintended consequences… In the worst case, they can lead to Remote Code Execution" [S11]. Here the agent picks the name and the owner the value, so a value must never become code or a search path.

**Why not the lane's environment.** A variable in the agent CLI's environment is inherited by every tool command, hook and MCP server, unless each is scrubbed, and one `echo` puts it in the transcript and in the provider's context (ADR-0018 rejected it for keys) [S1, S19]. With `run`, the agent's own process never has the value.

**What `ps` sees.** References only: `run`'s argv and the child's argv carry no value. A process's command line is readable by other processes, and its environment by processes of the same user [S16]; the child's environment is the one place a value is, and only for that child's life.

**MCP servers** are started by the agent CLI outside its sandbox [S1]. An MCP server that needs a token is configured with `morndo-secrets run --env TOKEN=secret://… -- <server>` as its command, so its config holds a Reference.

### 7.2 `helper`: tools that ask for a credential

`morndo-secrets git-credential` is a git credential helper: git runs it with `get`, gives the request on stdin, and reads `username=` and `password=` lines from its stdout [S3]. The value goes from the broker to git, not to the agent's conversation. But `git credential fill`, which any process can run, prints what the helpers return to stdout [S28], so this mode protects as much as `exec` does (7.0). It is configured per repository (`credential.https://git.example.com.helper`), names the Reference in that config, and records a `helper` Use. Other helper protocols, such as container registries, are later adapters on the same broker.

### 7.3 `inject`: the command never holds the value

For a Claude Code lane under `os` isolation, Claude Code's sandbox can mask a credential. Sandboxed commands see "a per-session placeholder called the sentinel", and the sandbox proxy "substitutes the real value on outbound requests to hosts you allow" [S1]. That needs:
- `network.tlsTerminate`;
- `injectHosts` that `allowedDomains` also admits;
- a trusted settings scope, which includes the `--settings` flag that ADR-0018's runtime adapter already uses [S1].

On Linux and WSL2 a masked file is read as a sentinel copy. On macOS a masked file is blocked and "Claude Code builds no sentinel copy", so a tool can't authenticate with it [S1]. `inject` is therefore Linux and WSL2 only in v1. Masking an environment variable would work on macOS, but the value would then sit in the agent CLI's own environment, which hooks and MCP servers inherit [S19].

The runtime adapter would:
1. ask the broker, at lane start, for every Secret granted to that lane with mode `inject` and with Destinations;
2. write each to a 0600 file in the lane's runtime directory;
3. pass `sandbox.credentials.files` entries with `"mode": "mask"` and `injectHosts` set to the Destinations;
4. deny the file tools that directory, since the sandbox doesn't cover them [S1];
5. remove the directory when the lane ends.

The file is plaintext for the lane's life. The sandbox and the deny rules keep the agent's commands and file tools off it, but hooks and MCP servers run outside the sandbox and could read it [S1].

This is the strongest mode: neither the agent nor its commands ever hold the value. It also has limits:
- Claude Code reads its settings at start, so a Secret granted later reaches the lane at its next start (UNVERIFIED whether settings reload).
- It is one vendor's feature, so it is an adapter.
- It needs `sandbox.network.tlsTerminate`, which the settings reference calls "experimental"; "mask credential substitution requires it" [S2]. v1 has not tried it here.

A hosted product does the same for any agent: a proxy that "swaps dummy credentials for real ones" [S24]. It is PR 7, a spike with its own done-check. The mode exists in the model from PR 1, so a Grant can allow it.

### 7.4 Under `os` isolation

The sandbox denies the vault, the identity and the database to every tool command (the secret-store design's CN5 (c)), so the broker is the only way to a value. Whether a sandboxed command can reach the broker's socket depends on the platform, per the settings reference [S2]:
- **macOS:** the runtime adapter adds the broker's socket to `sandbox.network.allowUnixSockets`, the list of "Unix socket paths sandboxed commands can connect to on macOS" [S2].
- **Linux and WSL2:** Claude Code "ignores this list on Linux and WSL2, where the seccomp filter can't inspect socket paths; use allowAllUnixSockets there instead" [S2]. With the seccomp filter present, `allowAllUnixSockets` "is the only way to permit Unix sockets there"; without it, "the sandbox doesn't block Unix-socket calls" [S2]. The filter is optional [S1].

Morndo never sets `allowAllUnixSockets`: it opens every socket, and the docs warn that one such as Docker's "effectively grants access to the host system" [S1]. A Linux or WSL2 lane sandboxed with the seccomp filter therefore uses `inject`, and MCP servers started through `run` (the CLI starts them outside the sandbox [S1]). It can't use `exec`, nor a helper that a sandboxed command calls: git started from the shell tool runs its helper inside the sandbox. `morndo-secrets list` says which modes work in this lane. PR 3 checks both platforms against this.

### 7.5 What never happens

- No `get`, `show`, `cat` or `export` prints a value. The one command that emits anything is `transfer`, and it emits ciphertext for another node's recipient (9.2).
- No value in an argument, a URL, a commit, the lane's environment, a hub or fleet message, a board comment, a notice, an Alert or a report.

## 8. Redaction

### 8.1 Exact values: the node's index

On every store and rotation, before it confirms, the node indexes the value in these encodings:
- raw;
- base64, standard and URL-safe, with and without padding, at each of the three byte alignments with the edge characters that depend on neighbours trimmed, so a value inside a longer encoded string (`user:token` in HTTP Basic) is found too;
- percent-encoded;
- JSON-string-escaped;
- lower-case hex.

For each encoding it keeps the length and HMAC-SHA-256 under the index key. To find candidates without hashing every window at full length, it also keeps a keyed hash of each encoding's first 8 bytes. A scanner rolls over 8-byte windows of the output, looks each up, and confirms a hit with the full-length HMAC. A retired version stays indexed 30 days after its rotation or revocation.

Values under 8 bytes are not indexed (5.2 warns). Vault's audit devices take the same approach: they write "a keyed hash (HMAC-SHA256) of most string values", so a log can be checked without holding them [S10].

As built in PR 2a (T-88, `packages/node-ops/src/secret-scan.ts`):
- **Hex** is indexed in lower and upper case, contiguous. A dump with separators or line breaks (`xxd`'s default) is not matched.
- **Percent** is indexed with six safe sets, each with upper- and lower-case escapes (RFC 3986 treats them as equal):
  - strict, RFC 3986's unreserved characters only (Python's `quote(s, safe="")`);
  - as `encodeURIComponent` leaves it (also `! ' ( ) *`);
  - the WHATWG form encoding (`URLSearchParams`: `* - . _` kept, a space as `+`);
  - Python's `quote_plus` (`_ . - ~` kept, a space as `+`);
  - Python's `quote(s)` with its default `safe="/"`, which keeps `/` too;
  - as `encodeURI` leaves it (also `! ~ * ' ( ) ; / ? : @ & = + $ , #`).

  The last two were added on T-94: `quote(s)` is the common Python call [docs.python.org/3/library/urllib.parse.html, read 2026-10-12], and `encodeURI` keeps the characters MDN lists [developer.mozilla.org, `encodeURI()`, read 2026-10-12]. Another safe set is not matched.
- **JSON**, for a UTF-8 value, is indexed as `JSON.stringify` writes it, and ASCII-only with every code unit from 0x7f up as `\uXXXX`, as Python's `json.dumps` writes by default (DEL included). A writer that escapes `/` as `\/` is not matched.
- Every form above was checked against the writer it names, with Python 3.12.3 and Node 22.23.3 on 2026-10-12 (T-88).
- **Base64** gets one core per alignment and alphabet: alignment *a* drops 0, 2 or 3 leading characters, and drops the last one unless the value ends on a 3-byte boundary.
  - Padding carries no bits, so one core serves padded and unpadded text.
  - A hit's range also takes the one character on each side that carries bits of both the value and a neighbour, plus up to two `=`. Redacting it leaves no bit of the value.
- Identical forms are kept once.
- **A value is at most 64 KiB** (`VALUE_MAX_BYTES`): a control byte written as JSON's `\uXXXX` is the widest form, six bytes for one, so every form of such a value fits what the index file's parser takes (1 MiB, `INDEX_FORM_MAX`). The vault refuses a larger value as `too_large` before writing anything; the card's field already stops at 16 KiB (5.2). Found by the PR #40 review (a 600 KB value made the index unreadable), decided on T-94.
- **The streaming scanner** holds back the bytes from the first position it hasn't checked. It checks a position once the longest match from it could have arrived, and checks every position left at the end of the stream. Each step says up to where the bytes are settled.
- **A retired version** is kept while now minus its retirement is at most 30 days. Retiring it again keeps the first time. Pruning keeps, per Reference, the highest version it dropped; versions are never reused, so adding one at or under that mark is a replay and indexes nothing (decided on T-94).
- **The index file** is JSON: References, versions, retirement times, keyed hashes and the pruned marks, parsed strictly, with an unknown key refusing the whole file.
  - `secret-index-file.ts` opens it without following a link. On that one descriptor it refuses anything but a regular file this user owns, at 0600 or tighter.
  - No file reads as an empty index; the writer creates it before the first store confirms (PR 2b).
- **Cost, measured** on the build box (Node 22.23.3, 2026-10-12): about 0.3 MiB/s.
  - One HMAC per byte of output takes about 2.6 s per MiB, and the scanner itself 0.8 s.
  - That is enough for panes and job tails, not for multi-megabyte transcript reads. A cheaper keyed candidate filter is to be settled before PR 6 applies the index there.

The scanner and the index file are two files in `packages/node-ops`: `secret-scan.ts`, a pure function over bytes and an index with the HMAC passed in, and `secret-index-file.ts`, the adapter that reads the index file the Secrets service writes and checks its mode and owner. The index is applied:
- in `run`, which holds the values it resolved and also matches them exactly with `streamRedactor`;
- in the node agent's `transcript.read`, `pane.captureMany` and `pane.frame` operations, before any byte leaves the node;
- in the terminal stream the node sends for `/api/terminal`, with a held-back tail as `streamRedactor` keeps one, which today passes nothing;
- in job tails (J6) and every node log line;
- in the hook relay, on each body and `/file` copy before it is spooled: hook events carry tool output, and the fleet's outbox and dead letters keep them and forward them to subscribers such as a chat bot (`apps/node-agent/src/relay/server.ts` spools bodies as they come today).

### 8.2 Shapes: the hub's shared redactor

`packages/protocol/catalog/secret-shapes.json` holds public token shapes: a vendor's prefix, its character set and length, and a source for each. On store, the node finds which shape a value matches, if any, and records the shape's id: a fact about the token type, not about the value.
- The shared redactor (ADR-0008 A4) gains every catalog shape, so the hub's logs and the feed and JSON views blank them (`view-redact.ts`).
- The composer guard uses them too (5.4).
- A value with no known shape gets no pattern. A pattern made from its private part would leak it or blank half the transcript.

### 8.3 Limits

- An encoding outside the indexed list passes: a reversed string, an encryption, a value split across two writes with other output between them. GitHub's masking has the same limit for "a transformed" secret [S14].
- The agent CLI's own transcript file on disk is outside Morndo's filter. It holds a value only if the value reached the model, which SC5 is there to prevent.
- A full-screen terminal program can draw a value with escape sequences between its characters; the terminal stream filter misses that.

## 9. Reuse across lanes, sessions and machines

### 9.1 Lanes and sessions

A Grant names lanes, repositories or the node, not a session. Every later session of a granted lane, and every lane working in a granted repository, resolves the Reference without a new request. "This lane only, until it ends" ends the Grant when the node agent sees the lane's pane close. A lane that needs a Secret it isn't granted asks with `request`; SR2 makes that an `access` card, a single tap.

### 9.2 A new machine of the fleet

A Secret is per node. When a lane asks on a node that has no Secret for the Reference while another node has one (or `run` is refused with `not_here`), the card offers both ways (Q2):
- **Transfer from node-a** (recommended): a Command with a fresh verification (SC11). With the source offline, the card names it and offers another node that holds the value, or entering it again. The hub sends `secrets.transfer` to the source node, naming the target's signed recipient. The source checks the signature against the target's node key from the Fleet (SC11), checks the gate as for a principal's Use, records it, seals the value to that recipient, and returns the ciphertext. The hub sends it to the target as `secrets.store`, and the target confirms as in 5.3. The ciphertext is in the hub's memory for one operation.
- **Enter it again on this node**: the same card with a field, for an owner who prefers that no node ever seals to another.

A Secret stored on several nodes from one card is one ciphertext per node (5.3), so no node can open another's copy.

### 9.3 The Secrets page

A settings page lists every Reference across nodes:
- per Reference: its nodes, current version, Grants, Destinations, Expiry, status, last Use and Use count (7 days), open requests;
- actions: replace the value (a card without a request), edit Grants (widening needs a fresh verification), disable, enable, revoke, delete, transfer, and the Use log;
- differing Grants on two nodes are shown side by side, never merged.

It uses the same words as the CLI, from one words table in `packages/protocol`, as the LLM connections page does. It never shows a value (Q3).

## 10. Rotation, expiry, revocation

- **Rotation.** The principal enters a new value for a Reference: from the page, or from a `rotate` request that an agent opened ("the payment sandbox answers 401 since this morning"). The version increases. Grants, Destinations and Reference stay. Uses already running keep the old value until they end, and an `inject` lane until its next start; every new Use gets the new one. The old version is removed from the vault when the new one is sealed and stays in the index 30 days (SC2, SC6).
- **Expiry.** Optional. Warnings at 7, 2 and 1 days become fleet Alerts. After it, Uses are refused and the first refusal opens a `renew` request (SC9). A cryptoperiod is "the time span during which a specific key is authorized for use" [S8]; an Expiry is that period's end.
- **Revocation.** For a leaked or retired value. Anyone may Disable at once (SC7); the principal then Revokes, which destroys the value on that node, or Rotates. A revoked fingerprint can't come back (SC2).
- **Deletion.** The principal removes the Reference and its Grants once no config uses it. The page shows the last Use to help decide.

## 11. Audit

Each Use is one `SecretUsed` and one `UseEnded` on the node, sent to the hub as a fleet event:
- the Reference, version and mode;
- the caller: node, lane, pid, the base name of the program;
- the workspace's repository name (the path stays on the node);
- the Grant that admitted it, the time and the outcome.

Refusals are `UseRefused`, with the gate's reason. Requests, answers, Grants and lifecycle events are on the hub's audit. The audit is kept 90 days, as the fleet's is. Nothing in it is a value or derived from one but the keyed fingerprint. `morndo-secrets log [REFERENCE]` reads it on the node, and the page shows it.

## 12. Threat model: what changes from ADR-0018

The [secret-store design](../secret-store/README.md) §5.3 stands for everything below that it already covered. Each row is new or changed.

| # | Threat | ADR-0018 | Now | Limit |
|---|---|---|---|---|
| 12.1 | **The device the owner types on** | Keys were typed only at the machine. | A paired Endpoint with a passkey and a fresh verification (SR5). The field turns off autocomplete, autocorrect and spellcheck. The value is never persisted and is cleared on Store or Reject. A CSP applies (ADR-0004). | A compromised phone or browser, a malicious extension, a keyboard app or the clipboard history sees what is typed or pasted. |
| 12.2 | **The hub and the fleet in the path** | Only metadata crossed them. | Ciphertext sealed on the Endpoint to one node's recipient crosses them, in memory for one operation (SR7). FL14 now reads: no plaintext secret and no agent-CLI credential. | A compromised hub could serve page code that reads the field before sealing, or offer its own recipient. Recipient pins catch the second on Endpoints that pinned before; the first is the same-user limit of ADR-0004. A node trusts the hub's word that the principal verified, as it does for every Command; a transfer's recipient needs the Fleet's node key as well, so redirecting one takes both the hub and the Fleet. |
| 12.3 | **An agent phishing for a value** | No agent could ask. | The card shows who asks as the node saw it, above the agent's words, and the node, not the agent, says which lane asks (4.1). The Grant defaults to narrow, a wider one is marked, and requests are rate-limited (SR10). No other route can ask for a value (SR9), so a request in chat is itself a warning sign, and the prompt block forbids it. | A prompt-injected agent can still ask with a plausible purpose. The owner decides. |
| 12.4 | **A granted command sends the value away** | Keys went only to the runtime, through a helper. | `exec` gives the value to a child the agent chose. Narrow Grants, the Use audit with the program's name, Destinations, and `inject` under `os`, where the command never holds the value. | Under `rules`, a granted child can send it anywhere the network allows. The filter sees output, not traffic. It also stops accidents, not intent: a granted agent that means to show a value can reverse it, or talk to the broker's socket with a client of its own that filters nothing. The audit records that Use; only `inject` prevents it. |
| 12.5 | **Leaks into transcripts, panes, logs** | Key shapes plus an exact filter on `run`. | The node's exact index on every node output path, the terminal stream included; shapes on the hub; the composer guard. | 8.3. |
| 12.6 | **Low-entropy values and fingerprints** | Plain SHA-256, right for high-entropy keys. | Keyed fingerprints and keyed index hashes. A fast hash such as SHA-256 lets an attacker "perform large numbers of guesses quickly"; the node's key works as the HMAC "pepper" OWASP describes [S25]. Neither can be checked against a guess off the node. | The keys sit beside the vault: same-user trust. |
| 12.7 | **A store or transfer repeated** | None. | Keyed operations (FL7), and the request's version (SR6). | none known |
| 12.8 | **One node reading another's copy** | Keys never left their node. | One ciphertext per node. A transfer is the principal's Command to a Fleet-admitted node (SC11). | A node that was compromised before a transfer receives the value. |
| 12.9 | **Chat and Telegram** | Only metadata. | Never answerable there. A Notification carries counts only (SR9, N1). | none known |
| 12.10 | **Processes of the same user** | They can read the identity and the vault; `os` denies tool commands. | Unchanged, plus a broker with one gate and a caller matched to a lane and a registered workspace. Under `os`, the sandbox makes the broker the only path to the vault, and the broker serves any process its gate admits. | Ancestry and workspaces are not proof: a process started in another lane's pane, or in its worktree, passes as that lane (section 6). A same-user process that ignores Morndo's rules can still read the vault. The next step is still the broker under its own user (secret-store design §5.3). |
| 12.11 | **Hook events** | Not covered. | Hook bodies carry tool output and reach the fleet's outbox, dead letters and subscribers. The relay filters them with the index before spooling (SC6). | As 8.3. |

## 13. Best-practice checklist

| Practice | Source (read 2026-10-11) | Here |
|---|---|---|
| Least privilege; deny by default. | OWASP: "the Least Privilege principle should be applied" [S6]. Vault: "Policies are deny by default" [S10] | Default deny (SC3); a narrow default Grant (Q1). |
| Authorize outside the agent's context. | OWASP AI Agent Security: "Enforce authorization in the execution component, outside the agent's context" [S21] | The broker decides (SC3); the model never sees a value or a decision about it. |
| Each secret has a lifecycle: creation, rotation, revocation, expiry. | OWASP: "Creation Rotation Revocation Expiration" [S6]. NIST SP 800-57 key states, from pre-activation to destroyed, with a record that remains [S8] | Open request (pre-activation), active, disabled (suspended), revoked and rotated-out (deactivated), deleted with the audit kept (section 10). |
| Audit who asked, who approved, who used. | OWASP: "Who requested a secret… Whether the secret request was approved or rejected. When the secret was used and by whom/what" [S6] | Request events, `SecretUsed` before use (SC4), refusals (section 11). |
| Never log a secret; keyed hashes are enough. | OWASP: "Never be logged" [S6]; OWASP Logging [S20]. Vault "only writes a keyed hash (HMAC-SHA256)" to audit logs [S10] | Keyed fingerprints and a keyed index only (SC1, 8.1). |
| Prefer files over environment variables; keep secrets out of argv. | OWASP: environment variables "not recommended unless the other methods are not possible" [S6]. systemd: "environment variables are not suitable for passing secrets" [S12]. Doppler: mount "to an ephemeral file" [S11]. proc(5) [S16] | `--file` in a per-Use directory, preferred by the prompt block; References only in argv (7.1). |
| No static secret embedded in code or config. | NIST SP 800-53 IA-5(7) [S22] | References are what configs and repos hold (3.6). |
| Refer by reference; resolve at launch; mask the child's output. | 1Password `op://`, and `op run`: "Secrets printed to stdout or stderr are concealed by default" [S9]. Doppler references [S11] | `secret://` References; `run`, `--env-file`, the filter (7.1). |
| Don't let a secret's name become code. | Doppler: some variable names "can lead to Remote Code Execution" [S11] | `run` refuses loader and startup variables (7.1). |
| Mask output, and know that transformed values escape. | GitHub: register a transformed secret too; "automatic redaction is not guaranteed" [S14] | The index covers common encodings; limits stated (8.3). |
| Encrypt values to named recipients; ciphertext is safe to move. | age [S4]; SOPS encrypts values to "one or more age recipients" [S13] | Sealed on the Endpoint, and on transfer, to one node's recipient (SR7, SC11). |
| Never collect a secret through the agent's own channel. | MCP: "Servers MUST NOT use form mode elicitation to request sensitive information"; URL mode keeps credentials out of "the LLM context, MCP client or any intermediate MCP servers"; no pre-authenticated URL [S5] | The card is Morndo's own page, behind a Session (SR9). |
| Allow paste and password managers; offer Show. | NIST SP 800-63B-4 §3.1.1.2 [S7], written for password verifiers and used here by analogy | 5.2. |
| Keep secrets out of the agent's environment and tool commands. | Claude Code: `env` values "reach every subprocess"; the scrub is by name or shape [S19]. Codex doesn't remove KEY, SECRET or TOKEN names by default [S18]. Claude Code sandbox `credentials` deny and mask [S1] | No value in a lane's environment (SC5); `run` children only; `inject` (7.3). |

## 14. Layers, ports, and where the code goes

```
packages/domain/src/secrets.ts            Reference, SecretRequest, Secret, Grant, the use gate, Request admission,
                                          Fingerprint ledger; the invariants tagged domain. Pure.
packages/protocol/src/secrets.ts          the wire: request and answer shapes, views (metadata only), SealedValue,
                                          the fleet operations and the node event, the words table.
packages/protocol/catalog/secret-shapes.json   public token shapes, each with its source.
packages/node-ops/src/secret-scan.ts      the scanner: pure, bytes and an index in, ranges out; the HMAC is passed in.
packages/node-ops/src/secret-index-file.ts the index file adapter: reads it, refuses a mode looser than 0600 or a
                                          foreign owner, hands the scanner its index.
packages/node-ops/src/tmux.ts             gains panes(): pane id, pane pid, window name (for CallerIdentity).
apps/connections/src/application/         secrets-service.ts, use-service.ts, ports.ts (the ports below).
apps/connections/src/adapters/            vault-age and vault-file (storeSealed), broker-socket, caller-identity,
                                          peer-pid (after the spike), secret-index-writer, git-credential, hub-link-relay.
apps/connections/src/secrets-cli.ts       `morndo-secrets`: the agent commands, the machine commands, `serve`, `op`
                                          (fleet operations on stdin).
apps/node-agent/                          the `secrets.*` operation handlers (piping to `morndo-secrets op` on stdin),
                                          the recipient report, the `/secrets/requested` relay path, and the scanner on
                                          transcript, pane, terminal and hook reads.
apps/fleet/                               routes the `/secrets/*` hook path to the hub's subscriber only (SR9).
apps/hub/                                 secrets-service.ts (requests, the read model), the principal's routes, a
                                          migration, the node-request subscriber, the fleet operations.
apps/web/src/lib/secrets/                 SecretCard.svelte (desktop and phone), seal.ts (lazy age), pins.ts,
                                          SecretsView.svelte.
docs/agents/secrets.md                    the prompt block.
```

**Ports on the node** (`apps/connections/src/application/ports.ts`):

| Port | Application side | Adapters |
|---|---|---|
| `SealedStore` | `storeSealed(ref, sealed)`, `has(ref)`, `fingerprint(ref)`, `remove(ref)`. Nothing returns a value; `open` stays on the adapter class. As built (T-94): `keyedFingerprint(ref)`, since `fingerprint` on these classes is Connections' unkeyed one; `storeSealed` answers with the keyed fingerprint or a named refusal; and `refs(prefix)` for the startup sweep. | `AgeVault`, `FileVault`: the same classes that implement Connections' `SecretVault` (3.1). |
| `UseChannel` | Hand a value to the `run` client that asked, over the broker's socket. | `broker-socket`. |
| `CallerIdentity` | `identify(connection)`: the caller's pid, its lane (or none) and its workspace (or none). | `caller-identity`, composing `peer-pid`, the `processes` adapter, `node-ops`' `panes()` and the workspace table (section 6). No import of the node agent. |
| `HubLink` | `requested(request)`: hand one request, as this node saw it, to the hub. Answers come back as `secrets.answered` operations. | `hub-link-relay`: POSTs to the node agent's hook relay on loopback, path `/secrets/requested`. The relay acknowledges only once the event is durable (FL10). The fleet's hook bus delivers it at least once, keyed (FL11), to the hub alone. |
| `IndexWriter` | Add and retire a version's index entries. As built (T-94): `prepare(ref)` opens the vault file once, before the transaction, and `write` adds, retires and prunes in one atomic write inside it. | `secret-index-writer`, over the file `secret-index-file.ts` reads. |
| `SecretsDirectory` | Load and save a Secret, the fingerprint ledger, the workspaces and the Use audit, with their events, in one transaction. As built (T-94): `load()`, and `write(change)`, one `BEGIN IMMEDIATE` transaction that reads the state, saves what `change` returns, and rolls back on a throw. | The SQLite store. |
| `WorkspaceRoots`, `Ids` (T-94) | A path's git common directory, or none; a fresh vault ref or Command id. | `git-workspaces` (`git rev-parse --path-format=absolute --git-common-dir`); random bytes in the composition. |
| `Clock` | `now()`. | The system clock; a fake in tests. |

**Ports on the hub:**

| Port | Application side | Adapters |
|---|---|---|
| `NodeRequests` (inbound) | `secrets.requested` events from nodes, deduplicated on the bus key (FL11), as SecretRequested. | The hub's fleet subscriber endpoint for `/secrets/*`. |
| `NodeSecrets` (outbound) | The fleet operations below, keyed. | The hub's fleet client. |
| `SecretsRequests` | Load and save requests with their events; Request admission's index and transaction (3.3). | The hub's SQLite store, one migration. |

**The fleet operations**, all typed and keyed (FL7), with no command line, and FL7's record keeping a hash of each outcome (SR7):
- `secrets.recipient`;
- `secrets.store`, carrying a SealedValue, Grant, expiry and Destinations, and the request it answers with its kind (none from the Secrets page or the machine), so the node holds a `renew` to its rule (5.3, step 6; decided on T-80, review round 4). Its answer names the Reference stored under, the version, the node's time of the store and whether the renew rule held (T-83; `renewed` decided on T-85; the Reference on T-88);
- `secrets.grant` and `secrets.ungrant`;
- `secrets.disable`, `secrets.enable`, `secrets.revoke` and `secrets.delete`;
- `secrets.transfer`, whose answer is a SealedValue;
- `secrets.check`, the gate for a named lane and workspace, opening nothing (for a request about another node);
- `secrets.answered`, which tells the requester's node how a request ended, for `--wait` and the notice;
- `secrets.list`, metadata only.

One node event goes the other way: `secrets.requested` (4.1). The audit records an operation's name, key and outcome, never its arguments (FL14).

**Architecture tests** (each with a control that must fail):
1. `packages/domain/test/secrets-shape.test.ts`: the keys of a built Secret, Request and every event match an allowlist exactly. A field named like `value|secret|plaintext|token|password|cipher` fails.
2. `packages/protocol/test/secrets-wire.test.ts`: the same over every schema, and a request body with a value-like key is refused whole (SR3). The one exception is the `SealedValue` type (an age file, at most 64 KiB), allowed in exactly three schemas: the store body, `secrets.store`, and the answer of `secrets.transfer`. The test lists them, and a fourth fails it. The shape catalog validates, and each shape has a source.
3. `apps/connections/test/architecture.test.ts`, extended: the Secrets application imports no adapter and no Node global, only listed files import `secret-material.ts`, and nothing under `apps/connections` imports `apps/node-agent`.
4. `packages/domain/test/no-vendor-names.test.ts`, extended: it also reads `secrets.ts`, and takes names from the shape catalog (`secret-shapes.json`) as well as the vendor catalog. A planted shape id in `secrets.ts` must fail it.
5. `packages/node-ops`: `secret-scan.ts` imports nothing from `node:fs` or `node:crypto`; a planted import fails the test.
6. `apps/web` unit test: the card's field has the attributes of 5.2, and the value never reaches a store, the outbox, the catch-up run or `console`.

## 15. Tests

### 15.1 Which test proves which invariant

The Layer column of 3.3 and 3.4 decides where each invariant is proved:

| Layer | Invariants | Test |
|---|---|---|
| domain | SR3 (shape), SR4, SR6, SR8 (state), SR11, SC1 (shape), SC3, SC7 (classification), SC8 (status), SC9, SC10, SC11 (Grants) | `packages/domain/test/secrets.test.ts`, with a fake clock. One test per invariant, each with a history that breaks it and must be refused. |
| domain service + store | SR1, SR10 (Request admission); SC2 (Fingerprint ledger) | A domain test of the service, plus a store test: two concurrent opens of one Reference give one request and one join; a revoked fingerprint is refused across Secrets; the unique indexes refuse a direct duplicate insert. As built for SC2 (T-94): two concurrent stores of one Reference and keyed fingerprint store it once, the second waiting for the first's commit (BEGIN IMMEDIATE) and refused as earlier; the ledger only grows and events are append-only. |
| application | SR2, SR5, SR8 (orchestration), SC4, SC5 (no print command), SC7 (who may command) | Application tests with fakes, and the broker tests of 15.3. |
| adapter | SR3 (wire), SR7, SR9, SC1 (logs), SC5 (argv), SC6, SC8 (vault, lane restart, reconnect), SC11 (signature) | Contract tests (15.2, 15.4, and the routing contract below) and the end-to-end run (15.5). |

Among the domain tests:
- SR4: a second answer is refused; expiry at 7 days; the last waiting lane's withdrawal ends the request, an earlier one doesn't.
- SR6: an answer to a request changed by a join, a withdrawal or an edited Reference is refused.
- SC3: the gate refuses at each step, in order.
- SC7: a table of changes that widen and narrow, emptying a lane list included.
- SC9: the first refused Use after expiry opens one `renew` request.
- SC11: a transfer narrows Grants to the target node.

**The routing contract** (SR9): the fleet's subscriber configuration sends `/secrets/*` to the hub's subscriber and nowhere else. A configuration that adds a second subscriber for that path fails the test.

**The no-replay contract** (SR7): after a `secrets.store` and a `secrets.transfer`, the node agent's done-key record and the hub's database hold a hash of the outcome and no SealedValue. A repeat of the transfer's key runs the gate again and returns a fresh ciphertext.

### 15.2 Contract tests for the store port

One suite, run against `vault-age`, `vault-file` and an in-memory fake:
- a round trip through `storeSealed` and the adapter's `open`;
- a ciphertext for another recipient, or with two recipients, is refused;
- a 0644 file or a foreign owner is refused;
- a replace is atomic: a crash between the write and the rename leaves the old version readable;
- `remove` leaves nothing;
- `has` opens nothing;
- keyed fingerprints are stable on a node and differ across nodes for one value.

`vault-file` takes no sealed value: `storeSealed` refuses it as `plaintext_vault` and writes nothing, and a node on that vault migrates to the age vault first. A sealed value is never written as plaintext at rest; OWASP's Secrets Management Cheat Sheet: "secrets must be stored encrypted somewhere to protect their confidentiality and integrity" (§7, https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html, read 2026-10-12). Decided on T-85. So on `vault-file` the suite asserts that refusal in place of the round trip, the recipient checks, the replace and `remove` after a store; the file cases (0644, foreign owner, `has` opens nothing) run on a file the vault wrote itself. As built (`apps/connections/test/sealed-store-contract.test.ts`, T-94):
- the port's keyed fingerprint is `keyedFingerprint(ref)`, since `fingerprint(ref)` on the same classes is Connections' unkeyed one (ADR-0018), and `storeSealed` returns the keyed fingerprint with its answer;
- a refusal names its problem: `not_age`, `stanzas` (other than one recipient stanza), `foreign` (doesn't open with this node's identity) or `plaintext_vault`;
- the fake seals to named recipients as JSON, so it makes the same two checks.

### 15.3 The broker

- Peer credentials of another uid are refused.
- A process with no pane among its ancestors has no lane.
- A Use is recorded before the open: killing the broker between the two leaves a record and no value.
- Each gate refusal exits 77 with its reason, and a child's 77 comes out as 1.
- `/proc/<pid>/cmdline` of the child shows no value.

### 15.4 Redaction

- The index file holds no value in any indexed encoding (a scan for each).
- The scanner finds each encoding, including split across chunk boundaries and at the end of a stream.
- A retired version is still found for 30 days.
- A value under 8 bytes is not indexed, and the card warns.

### 15.5 End to end: request, card, store, use, and the value nowhere

`e2e/secrets.e2e.ts`, on the synthetic office the e2e suite already builds: a test hub, a node agent and a multiplexer server of their own. Steps:
1. A fixture agent in a synthetic lane, `e2e/fixtures/secret-agent.mjs`, runs `morndo-secrets request secret://demo/api-token --purpose "call the demo API" --wait 2m`.
2. Playwright, on a paired test Endpoint, finds the card, checks its fields (5.2), types a random 40-character value made for this run, picks "this repository", and stores after a test passkey check.
3. The fixture's wait returns 0. It runs `morndo-secrets run --env DEMO_TOKEN=secret://demo/api-token -- node e2e/fixtures/use-token.mjs`. That script calls a local fake HTTP server with the token as a bearer header, then prints the token raw, base64 and percent-encoded, on purpose.
4. **Asserts:**
   - The fake server received the exact value, so the Use works.
   - The value, in every indexed encoding, appears in none of: the lane's pane capture, the fixture's transcript file, the hub's and node's databases (FL7's done keys included), the hub, fleet and node logs, the node's delivery spool and hook spool, the fleet's outbox and dead letters, the request bodies the hub received (a recording proxy in the test), the browser's `localStorage`, `sessionStorage` and IndexedDB, the notice, and the board comment.
   - The output the fixture saw has `[redacted]` where it printed the value.
   - The hub's audit has one `SecretUsed` with the fixture's lane.
5. **Negative control:** the same scan, run over a planted log line with the value in each encoding, must fail, so a scan that finds nothing is known to look. A second control runs the fixture's printing step without `run`, with the value passed in by the test, and the scan must fail on the pane.

### 15.6 Manual QA

In a private QA record, not in this tree:
- the card on a phone and a desktop, with paste, Show and a multi-line value;
- a passkey check older than 5 minutes;
- a reject with a reason, as the agent sees it;
- a transfer between two nodes;
- a sandboxed Claude Code lane using `exec` on macOS and Linux.

## 16. Build plan: small stacked PRs

| PR | What | Done-check |
|---|---|---|
| 1 | Domain and protocol: `secrets.ts` in both packages, with Request admission and the Fingerprint ledger; the shape catalog; the words table. `docs/domain.md`: a Secrets section with the Layer of each invariant, the context map, the amendments to C1, C6, N2 and H3 (3.1), and the anti-corruption rows below. `docs/agents/secrets.md`. `no-vendor-names.test.ts` extended (section 14). | The domain rows of 15.1 green, each with a failing control. The shape and wire allowlists fail on a planted field, and SealedValue in a fourth schema fails. The vendor-name test fails on a planted shape id. Reference grammar table tested. |
| 2 | Node custody: `SealedStore` with `storeSealed` on both vaults, keyed fingerprints and the fingerprint ledger's store, the index writer, `packages/node-ops`' `secret-scan.ts` and `secret-index-file.ts`. Machine commands: `put` (stdin, typed confirmation), `workspace add`, `list`, `grant`, `disable`, `enable`, `revoke`, `delete`, `log`, `recipient`. Built as 2a (redaction, T-88) and 2b (custody, T-94); 2b also has `ungrant`, and `put` stores with no Grant (default deny), so `grant` follows it. | 15.2 on three adapters, and 15.4. |
| 3 | Starts with the spike of section 6 (peer pid on Linux and macOS, macOS ancestry). Broker and use: `serve`, `CallerIdentity` (peer pid, ancestry, `node-ops`' `panes()`, workspaces), the gate, the Use record, and `HubLink` with the relay's `/secrets/requested` path (4.1). `run` with `--env`, `--file` and `--env-file`, and the filter. `git-credential`. The Claude Code runtime adapter allows the socket where the platform can (7.4). | 15.3. A sandboxed Bash command in a scratch session can't read the vault, and `run` works through the socket on macOS; on Linux, the measured answer with and without the seccomp filter is written into 7.4. |
| 4 | Hub requests: the `NodeRequests` subscriber, the fleet's `/secrets/*` route to the hub only, Request admission's store, the principal's routes, a migration; `secrets.answered` back to the node for `status`, `wait` and `withdraw`; the other fleet operations and the recipient report; the lane notice; H3; SR9's exclusions. | The store and routing rows of 15.1: two concurrent opens make one request; the routing contract; the no-replay contract. A store retried after a dropped connection stores once. Scans of the hub database, logs and spool find no ciphertext after the operation and no plaintext ever. |
| 5 | Web: the card on desktop and phone, sealing in the browser, pins, the fresh check; the Secrets page; the composer guard. | 15.5 green with its controls. The bundle budget holds for every page but the card's chunk. Manual QA (15.6). |
| 6 | Reuse and lifecycle: transfer, `renew` on expiry, `rotate` requests, expiry Alerts; the node's timer runs `secretExpirySweep` and `endTimedGrants` together (until then the gate already refuses an ended Grant); the hub's shapes; the index on transcript, pane and terminal reads. | Two synthetic nodes: a transfer whose recorded fleet frames hold ciphertext only. One `renew` card for many refused Uses. The terminal stream test with a value split across frames. |
| 7 | Spike: `inject` for Claude Code under `os`, on Linux and WSL2 (7.3). | A sandboxed `cat` of the masked file shows the sentinel. A request to the Destination authenticates against a local fake server; one to another allowed host carries the sentinel. The Read tool is denied the directory. If it fails, `inject` stays off and 7.3 says why. |

**Anti-corruption rows** PR 1 adds to `docs/domain.md`'s adapter table (the domain never sees these payloads):

| Adapter | Translates |
|---|---|
| Agent CLI sandbox credentials (Claude Code `sandbox.credentials`, `mask`) | a Grant's `inject` mode and Destinations to a `--settings` entry for the lane; a platform or version without it to "inject unavailable here", never a weaker mode chosen silently |
| Git credential helper protocol (`git credential-*` with `get`) | git's request on stdin to a Use of the Reference configured for that remote; the value to `password=` on stdout, to git only |
| Browser age encryption (`age-encryption` in the web app) | the typed bytes and a pinned recipient to a SealedValue; a recipient that differs from the pin to "stop and compare" |
| Peer credentials and the pane table (`SO_PEERCRED` or `LOCAL_PEERPID`, process ancestry, tmux `#{pane_pid}`, `git rev-parse --git-common-dir`) | a socket connection to a Caller: a lane or none, a workspace or none. The domain never sees a pid, a pane id or a path. |
| Fleet hook path `/secrets/requested` | a node's request, as the node saw it, to SecretRequested at the hub |

Each PR updates this document where it measured something different.

## 17. Limits, risks, and what would change this

- **Same-user trust** is unchanged (12.10). The broker is the one place where a separate OS user would make it real.
- **`exec` under `rules`** hands the value to a process the agent chose (12.4). `inject` removes that for one vendor; other vendors may follow.
- **Agents can't store values** in v1. An agent that creates a resource and gets a password back has to show it to no one and ask the owner. A later `put` for agents from a pipe (`generate | morndo-secrets put …`), with a Grant only to its own repository, is the obvious next step. It needs its own threat review.
- **The LLM connections page** still adds keys at the machine (secret-store design §11). The sealed card could serve it too; that change belongs in an amendment to ADR-0018.
- **Re-check triggers:**
  - Claude Code changes `sandbox.credentials`, its socket rules or its settings scopes.
  - The MCP spec changes how secrets are collected.
  - `age-encryption` releases a new version.
  - A shape in the catalog changes at its vendor.

## 18. Sources (read 2026-10-11 unless marked)

- [S1] Claude Code, sandboxing: what runs outside the sandbox (file tools, MCP servers, hooks, `apiKeyHelper`), `credentials` deny and mask, the sentinel, `injectHosts`, `tlsTerminate`, trusted scopes, Linux seccomp socket blocking, `allowAllUnixSockets` and the Docker socket warning. https://code.claude.com/docs/en/sandboxing
- [S2] Claude Code, settings reference. `sandbox.network.allowUnixSockets`: "List the Unix socket paths sandboxed commands can connect to on macOS. Claude Code ignores this list on Linux and WSL2, where the seccomp filter can't inspect socket paths; use allowAllUnixSockets there instead." `allowAllUnixSockets`: "On Linux and WSL2, the sandbox's seccomp filter blocks socket(AF_UNIX, ...) calls, so this is the only way to permit Unix sockets there. When the filter is missing … the sandbox doesn't block Unix-socket calls." `tlsTerminate`: "This is experimental, and mask credential substitution requires it." Also `sandbox.credentials.envVars|files`, `env`, `apiKeyHelper`. https://code.claude.com/docs/en/settings-reference
- [S3] Git, gitcredentials(7): `credential.helper`, the `get` operation, attributes on stdin and stdout. https://git-scm.com/docs/gitcredentials
- [S4] age: https://github.com/FiloSottile/age. typage (npm `age-encryption`): "compatible with Node.js 20+, Bun, Deno, and all recent browsers", "uses the Web Crypto API when available". https://github.com/FiloSottile/typage. Version 0.3.1 is latest (`fresh npm age-encryption`, https://www.npmjs.com/package/age-encryption).
- [S5] Model Context Protocol, elicitation, protocol version 2026-07-28 (current per https://modelcontextprotocol.io/specification/versioning): "Servers MUST NOT use form mode elicitation to request sensitive information such as passwords, API keys, access tokens, or payment credentials"; "Servers MUST use URL mode for interactions involving such sensitive information"; "sensitive credentials never pass through the LLM context, MCP client or any intermediate MCP servers"; servers "MUST NOT provide a URL which is pre-authenticated" and "MUST verify the identity of the user who opens the URL". URL mode was introduced in 2025-11-25. https://modelcontextprotocol.io/specification/latest/client/elicitation
- [S6] OWASP Secrets Management Cheat Sheet: §2.2 (the primary secret needs protecting too), §2.3 least privilege, §2.6 audit ("Who requested a secret…"), §2.7 lifecycle, §5.1 environment variables "not recommended unless the other methods are not possible", §8.3 "Never be logged". https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
- [S7] NIST SP 800-63B-4 §3.1.1.2 (page dated 2025-08-26), rules for password verifiers, used here by analogy: verifiers "SHALL allow the use of password managers and autofill functionality", "SHOULD permit claimants to use the 'paste' function", "SHOULD offer an option to display the password". https://pages.nist.gov/800-63-4/sp800-63b.html
- [S8] NIST SP 800-57 Part 1 Rev. 5: §5.3 cryptoperiod; §2.1 and §7 key states (pre-activation, active, suspended, deactivated, compromised, destroyed); a destroyed key's "previous existence may be recorded (e.g., in metadata or audit logs)". https://doi.org/10.6028/NIST.SP.800-57pt1r5
- [S9] 1Password CLI (developer.1password.com now redirects to 1password.dev): secret reference syntax `op://<vault>/<item>/[section/]<field>`; `op run` conceals secrets printed to stdout or stderr by default (`--no-masking` turns it off) and makes them environment variables "only for the duration of the process". https://www.1password.dev/cli/secret-reference-syntax/, https://www.1password.dev/cli/reference/commands/run/, https://www.1password.dev/cli/secrets-environment-variables/
- [S10] HashiCorp Vault: "Policies are deny by default"; audit devices write "a keyed hash (HMAC-SHA256) of most string values"; KV keeps versions. https://developer.hashicorp.com/vault/docs/concepts/policies, https://developer.hashicorp.com/vault/docs/audit, https://developer.hashicorp.com/vault/docs/secrets/kv
- [S11] Doppler: reference syntax `${project.config.SECRET_NAME}`; some variable names "can lead to Remote Code Execution", and mounting "to an ephemeral file" is recommended; service tokens are read-only and scoped. https://docs.doppler.com/docs/secrets, https://docs.doppler.com/docs/accessing-secrets, https://docs.doppler.com/docs/service-tokens
- [S12] systemd.exec(5), systemd 262: "environment variables are not suitable for passing secrets… to service processes"; credentials in `$CREDENTIALS_DIRECTORY`; `SetCredential=` is visible over IPC. https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html. "Unlike environment variables the credential data is not propagated down the process tree." https://systemd.io/CREDENTIALS/
- [S13] SOPS: "keys are stored in cleartext, and values are encrypted"; age recipients. https://getsops.io/docs/security/, https://getsops.io/docs/usage/identities/age/
- [S14] GitHub Actions: `add-mask` ("Masking a value prevents a string or variable from being printed in the log"); "If your secret is transformed in some way (such as Base64 or URL-encoded), be sure to register the new value as a secret too"; "automatic redaction is not guaranteed". https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands, https://docs.github.com/en/actions/reference/security/secure-use
- [S15] Kubernetes: Secrets good practices (restrict list access; don't log secret data); a mounted Secret is kept in "a tmpfs so that the confidential data is not written to durable storage". https://kubernetes.io/docs/concepts/security/secrets-good-practices/, https://kubernetes.io/docs/concepts/configuration/secret/
- [S16] proc(5), proc_pid_cmdline(5), proc_pid_environ(5), from the man-pages source (man7.org did not answer): `/proc/pid` is readable by everybody by default (`hidepid=0`); `environ` is guarded by a `PTRACE_MODE_READ_FSCREDS` check and holds the initial environment. https://git.kernel.org/pub/scm/docs/man-pages/man-pages.git/plain/man/man5/proc.5, …/proc_pid_environ.5
- [S17] MDN, `autocomplete` ("setting autocomplete to 'off' will not prevent a password manager from asking the user if they would like to save") and turning off autocompletion (`new-password`, "a hint to browsers; some may not comply"). https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/autocomplete, https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/Turning_off_form_autocompletion. WHATWG HTML: spellcheck applies in the Text state. https://html.spec.whatwg.org/multipage/interaction.html
- [S18] Codex: `shell_environment_policy`, whose `ignore_default_excludes` defaults to true, so names containing KEY, SECRET or TOKEN are not removed by default; `model_providers.<id>.auth.command` "must print the token to stdout". https://learn.chatgpt.com/docs/config-file/config-advanced, https://learn.chatgpt.com/docs/config-file/config-reference (the old developers.openai.com/codex/… URLs redirect there, checked 2026-10-11)
- [S19] Claude Code: the settings `env` block's values "reach every subprocess Claude Code starts"; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` "recognizes a credential by its variable name or by the shape of its value". https://code.claude.com/docs/en/settings-reference, https://code.claude.com/docs/en/env-vars
- [S20] OWASP Logging Cheat Sheet: access tokens, passwords and "Encryption keys and other primary secrets" are not to be recorded in logs. https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- [S21] OWASP AI Agent Security Cheat Sheet: credentials "inadvertently included in agent context or logs"; "Enforce authorization in the execution component, outside the agent's context." https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html
- [S22] NIST SP 800-53 Rev. 5, IA-5(7): "Ensure that unencrypted static authenticators are not embedded in applications or other forms of static storage." Read from the OSCAL catalog v5.2.0. https://github.com/usnistgov/oscal-content
- [S23] GitGuardian, State of Secrets Sprawl 2026 (the vendor's own figures; method not checked here): 28,649,024 new secrets in public GitHub commits in 2025; 24,008 unique secrets in MCP configuration files. https://gitguardian.com/state-of-secrets-sprawl-report-2026
- [S24] Infisical Agent Proxy, "a credential broker for AI agents" that swaps dummy credentials for real ones: prior art for `inject` (licence not checked; nothing borrowed). https://infisical.com/docs/documentation/platform/agent-proxy/overview
- [S25] OWASP Password Storage Cheat Sheet: "Fast hashing algorithms such as SHA‑256 are not suitable for password storage because they allow attackers to perform large numbers of guesses quickly"; a pepper used "as the HMAC key". https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- [S26] age file format (C2SP): the header "wraps the file key for one or more recipients" and has "one or more recipient stanzas"; "An scrypt stanza, if present, MUST be the only stanza in the header." https://github.com/C2SP/C2SP/blob/main/age.md
- [S27] unix(7), from the man-pages source: `SO_PEERCRED` "returns the credentials of the peer process connected to this socket", for connected `AF_UNIX` stream sockets. https://git.kernel.org/pub/scm/docs/man-pages/man-pages.git/plain/man/man7/unix.7
- [S28] git-credential(1): with `fill`, "The username and password attributes of the credential description are then printed to stdout". https://git-scm.com/docs/git-credential

## Open questions for the owner

1. **Who may use a secret you store, by default.** Default: **this repository, any lane, until you revoke it.** Other lanes and later sessions in that repository use it without asking again, and nothing outside it can. The other choices on the card: this lane only, until it ends (safest, but every new lane asks again), or every lane on the machine (fewest asks, widest reach).
2. **A new machine.** Default: **transfer with one tap.** The machine that has the value seals it for the new one, and only ciphertext passes through the hub. The alternative is to type it again on each machine, so that no machine ever sends a value to another.
3. **Seeing a stored value again.** Default: **never; replace it instead.** As with CI secret stores, a stored value is write-only, so a stolen session can't read it back. The alternative is a Reveal button behind a fresh passkey check, recorded on the audit.
