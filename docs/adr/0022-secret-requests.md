# ADR-0022: Secret requests: an agent asks for a named secret, the owner seals it from a card, agents use it by reference

- **Status:** Proposed, 2026-10-11; v2 the same day, after an independent audit of sources and DDD. Design: [`docs/design/secret-requests/README.md`](../design/secret-requests/README.md). Design only; no product code.
- **The request:** an agent asks for a secret the way it asks for a decision. Instead of a decision card, the owner gets an "insert secret" card. The value is stored securely and can be used again by other lanes and in later sessions. Domain rules and current best practice apply, and it ships in the public repo.
- **Number:** 0019 to 0021 belong to other branches.
- **Builds on:** ADR-0001 (pure domain, adapters), ADR-0004 (the web endpoint and its passkeys), ADR-0008 (the shared redactor, A4), ADR-0012 (typed fleet operations, FL7, FL14), ADR-0015 (agent tokens), ADR-0017 (lane notices), ADR-0018 (the sealed store: age vault, plaintext type, process ancestry, exact-value filter, widening rule).
- **Sources:** [S1]–[S28] in the design, section 18, read 2026-10-11.

## Context

1. **Agents need secrets that aren't LLM keys.** Examples: a payment sandbox key for tests, a deploy token, a database URL. With no place for them, the easy path is to paste the value into a conversation. From there it is in the transcript, the pane, the provider's context and, for the manager, an inbox file.
2. **No path for a decision answer can carry a value.** Answers in words are typed into a pane or written to the manager's inbox as text (ADR-0010). The phone keeps a pending answer in `localStorage`. The manager's `[buttons]` lines, the needs-you file and hook events reach the chat bot outside this tree.
3. **No agent raises an ask by command today.** The hub polls the manager's file, its chat line and the workers' screens. The agent routes cover only the board, jobs and usage.
4. **ADR-0018 built the store, for LLM keys.** It has an age vault with a machine identity, a plaintext type that never serialises, ancestry checks, and an exact-value filter in `run`. A key there is added only at the machine. Its gate decides runs of LLM connections, and its CLI is `morndo-keys`.
5. **The redactor knows shapes, not values,** and the `/api/terminal` socket isn't redacted at all.
6. **The vendors moved.** Claude Code's sandbox can mask a credential so that commands see a sentinel and only its proxy sends the real value, to listed hosts [S1]. The MCP spec forbids collecting sensitive information through the agent's form channel and moves it to a URL out of band [S5].

## Decision

1. **A Secrets context**, new, beside Connections (design §3.1).
   - **Secret request:** an aggregate on the hub, with invariants SR1–SR11.
   - **Secret:** an aggregate, one per Reference per node, with invariants SC1–SC11.
   - **Request admission** (SR1, SR10) and the **Fingerprint ledger** (SC2): domain services for the rules that span many aggregates, with uniqueness held by the store (unique indexes, one write transaction).
   - Every invariant names its layer (domain, domain service with the store, application, adapter) and the test that proves it (design §3.3, §3.4, §15.1).
   - The domain lives in `packages/domain/src/secrets.ts`, which is pure.
   - LLM keys stay Connections. The two contexts share the vault, the identity and the process adapters, and no model.
   - The node-side services are a second command, `morndo-secrets`, of `apps/connections`.
2. **The language.**
   - **Reference** (`secret://<scope>/<name>`): the only thing agents, configs, events and the hub hold.
   - **Secret:** one Reference on one node. The same Reference on two nodes is two Secrets; each node is the system of record for its own, and the hub's read model groups them.
   - **Value:** the bytes. Connections' "secret" (bytes), "secret ref" (vault id) and `SecretVault` port map to Value, vault ref and `SealedStore`; `SecretMaterial` is shared and adapter-only (design §3.1).
   - **Grant:** who may resolve a Reference: a lane, a workspace (a repository root the principal registered, with its worktrees) or a node; the modes; an end. Nothing resolves by default.
   - **Use:** one audited resolution for one process.
   - **Ask:** now defined in `docs/domain.md` as a role that an Escalation or a Secret request plays. Catch-up, Notifications and lane status count both; each keeps its own answer rules.
   - **Rotation, Expiry, Disable** (anyone), **Revoke and Delete** (the principal).
3. **An agent asks with a command, and its node vouches for it.** `morndo-secrets request REF --purpose … [--for repo|lane|node] [--wait]` talks only to the node's broker. The broker adds the lane from the caller's process tree and the workspace, and hands the request to the node agent through the `HubLink` port. The node agent sends it to the hub over its proven fleet connection, on a hook path the fleet routes to the hub alone, and the hub takes it in through `NodeRequests`. An agent token can't vouch for a lane: one serves every lane on a machine and names its lane in a header (ADR-0015).
   - With no value yet, the hub opens a request.
   - A value the lane is granted answers `available` at once, from the broker.
   - A value it isn't granted opens an access card with no field.
   - The agent waits (exit 0, 1 or 75) or continues and gets one lane notice when the request ends. While a request of its own is open, a lane counts as waiting for the principal (H3).
4. **The insert-secret card** shows only on Morndo's web endpoint (desktop and phone), where decision cards show. It never shows in Telegram, chat, a pane, the needs-you file or the manager's inbox (SR9). It has:
   - who asks, as the node saw it, and each waiting lane's own purpose;
   - the Reference, editable;
   - the purpose, as the agent's words;
   - a masked field: paste and password managers allowed, Show on demand, `autocomplete="new-password"`, no autocorrect or spellcheck, multi-line or from a file, at most 16 KiB;
   - a Grant picker, a node picker, an optional expiry and Destinations;
   - Store, Reject and Later.

   Store and Grant need a passkey check from the last 5 minutes.
5. **Sealed on the Endpoint.** The browser encrypts the value with `age-encryption` 0.3.1, lazy-loaded, to each target node's age recipient, pinned on first use. Only ciphertext reaches the hub and the fleet, in memory for one keyed operation (FL7), whose record keeps a hash of the outcome, never a ciphertext.
   - The node checks the file opens with its identity, indexes it, stores it as received, and confirms.
   - The value is never persisted in the browser, and a value has no Undo window.
   - FL14 is refined: no plaintext secret and no agent-CLI credential crosses the fleet.
6. **Values reach processes only at launch, never the agent's conversation on the normal path.** One broker per node (`morndo-secrets serve`, a user service on a Unix socket) runs the gate, matches the caller to a lane (process ancestry) and a workspace the node registered (not git remotes, which any folder can claim), records the Use before it opens the vault, and hands the value over. How it learns the caller's pid on Linux and macOS is settled by a spike before PR 3: Node has no peer-credential call. The modes:
   - **`exec`:** `morndo-secrets run --env NAME=REF -- cmd`. The value is in the child's environment, and the child's output is filtered.
   - **`file`:** a 0600 file in a per-Use directory, its path in a variable.
   - **`helper`:** a git credential helper, first.
   - **`inject`:** Claude Code's sandbox mask, so the command sees a sentinel. A spike first.

   There is no command that prints a value. A refusal exits 77 and names the request to make. `exec`, `file` and `helper` stop accidents, not intent: the value is in a process the agent started, so an agent that means to reveal it can. Only `inject` keeps it from the agent's commands, and the card says which a Grant allows.
7. **Redaction learns each value on its node.** On store, the node indexes the value's length and keyed hashes in its raw, base64, percent-encoded, JSON-escaped and hex forms, never the value. Base64 is indexed at all three byte alignments, so a value inside a longer encoded string is found. Every output path on the node applies the index before bytes leave: `run`, transcript reads, pane captures, the terminal stream, job tails, logs, and hook bodies before the relay spools them. A value matching a public token shape from a catalog adds that shape to the hub's shared redactor.
8. **Reuse.** A Grant names lanes, repositories or a node, not a session, so later sessions and other lanes in its reach resolve without asking. A new node gets a value by a transfer Command: the source checks the target's recipient against the target's node key from the Fleet, seals the value to it, and the hub relays ciphertext. Or the owner enters it again (Q2).
9. **Keyed fingerprints.** HMAC-SHA-256 under a node key, not plain SHA-256 as for LLM keys, because a secret may be a short password.
10. **Order:**
    1. domain and protocol;
    2. node custody;
    3. the caller-identity spike, then the broker, `run` and requests through the node;
    4. hub requests and the agent commands;
    5. the card and the Secrets page;
    6. transfer, lifecycle and node-side redaction of every read;
    7. the `inject` spike.

    Each PR has its done-check in the design, section 16.

## Alternatives

| Option | Verdict |
|---|---|
| **Extend Connections with general secrets** | Rejected. Its gate decides LLM runs on terms, budget, isolation and dialect; a tool secret has none of them, and its rule is who may resolve, not which role runs. Shared infrastructure, separate model. |
| **Answer through the decision path (words typed back)** | Rejected. The value would land in the pane, the transcript, the provider's context and, for the manager, an inbox file (Context 2). |
| **Hub receives plaintext over TLS and forwards it** | Rejected. Simpler, but the hub would hold every value in memory and its logs, crash reports and request middleware would be in scope. Sealing on the Endpoint costs one lazy chunk. |
| **Owner enters secrets only at the machine (ADR-0018's rule)** | Kept as a path (`morndo-secrets put`), rejected as the only one: the owner works from a phone, and the request is for a card. |
| **Values in the lane's environment at start** | Rejected. Every tool command, hook and MCP server inherits them, and one `echo` puts a value in the transcript [S1, S19]. |
| **A `get` command that prints the value** | Rejected. The agent would run it in its shell tool, and the value would be in the transcript. |
| **Telegram or chat as an entry path** | Rejected. Neither is Morndo's endpoint, neither can mask a field, and a chat keeps history. |
| **A hosted secrets manager** (1Password, Vault, Doppler, Infisical) | Not v1: another account and another sign-in per node. Morndo's References follow their pattern [S9, S10, S11], and a credential-swapping agent proxy exists as a product [S24]. A `SealedStore` adapter for one can come later. |
| **systemd credentials as the store** | Not the default, as in ADR-0018: root-only host key on systemd 255, Linux only. Its file-per-credential delivery is what `--file` copies [S12]. |
| **Requests over HTTP with the agent token, as the board does** | Rejected. The token names its lane in a header, so a lane could ask as another, and the card's "who asks" would be the agent's word. |
| **The broker starts the child itself, so no client ever gets the value** | Rejected. The broker runs outside the lane's sandbox, so its children would too, and the child is still the agent's choice. `inject` is the way to keep a value from the agent's commands. |
| **Pattern redaction only** | Rejected. A random password has no pattern; only the exact value finds it. |
| **One age file with every node as a recipient** | Rejected. Any node could open every other node's copy forever. One ciphertext per node. |

## Consequences

- **Good:** the owner answers a secret request from a phone like a decision, without the value entering any conversation. Agents and configs hold References, which are safe to commit and to show; on the normal path the value never reaches the agent's conversation or the provider.
- **Good:** one stored value serves every granted lane and later session, and moves to a new machine with one tap and no re-typing.
- **Good:** the node-side index closes gaps that exist today: the terminal socket, transcript reads and pane frames pass an exact filter.
- **Cost:** a broker service per node, new tables on the hub and the node, twelve fleet operations and one node event, a lazy age chunk in the web app, and a shape catalog to keep.
- **Limit:** same-user trust, as ADR-0018. Lane and workspace matching stops mistakes, not a same-user process that starts itself in another lane's pane. Under `rules`, a granted child can send its value anywhere the network allows; `inject` removes that only for one vendor, on Linux and WSL2 (on macOS a masked file is blocked, not replaced).
- **Limit:** an encoding outside the index, or a value under 8 bytes, can reach output. A compromised hub could serve page code that reads the field; recipient pins catch only a swapped recipient. Disable and Revoke stop new Uses at once; a running child keeps its value, and an offline node serves until it reconnects.
- **Limit:** on Linux with the sandbox's seccomp filter, neither `exec` nor git's helper can reach the broker from a sandboxed command, since Morndo never opens every Unix socket. Such lanes use `inject` and MCP servers started through `run`.
- **Risk:** a prompt-injected agent can ask with a plausible purpose. The card shows who asks above the agent's words, the Grant defaults narrow, and requests are rate-limited.

## Verification this implies

1. A domain test, with a failing control, for each invariant tagged domain, and for each domain service, plus a store test of its uniqueness (two concurrent opens make one request). Invariants tagged application or adapter (SR2, SR5, SR7, SR9, SC4, SC5, SC6, and the edge parts of SR3, SR8, SC1, SC8, SC11) are proved by the application, contract and end-to-end tests their rows name: no pure-domain test can prove them.
2. Shape and wire allowlists that fail on a planted value field, with `SealedValue` allowed in exactly three schemas. An architecture test for the Secrets application (no adapter, no Node global, no import of the node agent). The vendor-name test extended to `secrets.ts` and the shape catalog. The scanner imports no file system.
3. One contract suite for the store port, run on `vault-age`, `vault-file` and a fake.
4. Broker tests: peer credentials, ancestry, record-before-open, exit codes, no value in `/proc/<pid>/cmdline`.
5. Redaction tests: no value in the index; each encoding found, split across chunks.
6. The end-to-end run (design §15.5): request, card, store, a fixture agent that uses the value through a Reference against a fake server and also prints it. The value, in every indexed encoding, is absent from the pane, transcript, databases, logs, spool, recorded request bodies, browser storage, notice and comment. Negative controls prove the scan finds a planted value.
7. Manual QA in a private record: the card on phone and desktop, a transfer between two nodes, a sandboxed lane on macOS and Linux.
8. Re-check triggers:
   - Claude Code changes `sandbox.credentials` or its socket rules.
   - The MCP spec changes elicitation.
   - `age-encryption` releases a new version.
   - A catalog shape changes at its vendor.

## Amendment, 2026-10-21 (T-340): a lease serves a key to apiKeyHelper

A lane's Claude Code that `run` did not start still needs the key without it sitting in env, argv or a file. `morndo-keys lease --connection <name>` is itself the `apiKeyHelper` (Claude Code runs the command through the shell and takes its stdout as the credential; non-zero is failure, the output is cached for the TTL — code.claude.com/docs/en/llm-gateway-connect#rotate-credentials-with-apikeyhelper and code.claude.com/docs/en/settings-reference#apikeyhelper, read 2026-10-21). One call is one short lease: the gate runs, the key is printed once on stdout and nothing else, a `KeyServed` event is written — with the caller's pid, ppid and lane, never a value — and the lease closes. This breaks decision 6's "no command that prints a value" for one case: the caller is Claude Code's own helper runner, not the agent's shell, and the refusal paths print a reason word only ("failed" when the vault cannot open). Isolation is checked, not claimed, where it matters: for a connection whose isolation has to be `os` (the preset floor of ADR-0018, Z.ai today), the lease reads its parent, and nothing it reads comes from the caller's environment. (1) `/proc/<ppid>/exe` must be the binary the owner pinned with `morndo-keys pin-claude`, and its content must be what was pinned. The pin is a file in the connections home with the binary's real path, its sha256, and its size, mtime and inode; the owner makes it once at a terminal (an agent's tool call has none, so it cannot pin the binary it wants), and it prints what it pins. At lease time the running inode (`stat /proc/<ppid>/exe`, which works for a deleted file too) is compared with the pinned size, mtime and inode, and the sha256 of the running binary is compared only when one differs. A binary that reads "(deleted)" after an update is accepted only when it is the pinned file; the updated binary is a new file and is pinned again. (2) Its command line must have `--strict-mcp-config` and no `--mcp-config` (an MCP server is a child of the parent that runs outside the sandbox, and could run the lease), exactly one `--settings` (a file or inline JSON) and `--setting-sources ""`, so that no user, project or local settings file merges its arrays into the sandbox (https://code.claude.com/docs/en/cli-reference, read 2026-10-21; that an empty value loads no source is not stated there: the lane launcher confirms it on its own version, where `/status` lists the sources loaded). (3) The sandbox is `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false` and has no `excludedCommands`; this node's vault, `connections.db` and `identity` are in `sandbox.filesystem.denyRead` and are `Read` rules in `permissions.deny` (what the runtime writes for `run`), not re-opened by `allowRead`, and the pin and those files are not opened by `allowWrite`; paths are compared by real path; and no key that weakens the sandbox is set: `enableWeakerNestedSandbox`, `enableWeakerNetworkIsolation`, `allowAppleEvents`, `ignoreViolations`, `filesystem.disabled`, `network.allowAllUnixSockets`, `network.allowUnixSockets`, `network.allowLocalBinding`, `network.allowMachLookup` (one list, `SANDBOX_WEAKENERS` in `caller-proof.ts`; https://code.claude.com/docs/en/sandboxing, read 2026-10-21; `network.allowedDomains` is not on it, the lane needs its API host). (4) A settings file must not have changed since the parent started (mtime and ctime against the start time in `/proc/<ppid>/stat`, within the clock's 20 ms grain), must be reached through no symlink (each part of the path is `lstat`ed, so a swapped link cannot hide behind an unchanged file) and must be in `denyWrite`; inline JSON is in the parent's argv and needs none of that. (5) The parent is read again at the end: the same parent pid, start time and binary, or it is refused. Anything else is refused with `isolation` (exit 75, a `LeaseRefused` event) whatever `--isolation` says. The helper line must be `ulimit -c 0; exec morndo-keys lease --connection <name> --lane <lane> --workspace <dir> --isolation os`: the `exec` makes Claude Code the parent, so an agent's own Bash tool call (its parent is the sandbox's shell, and it cannot read the vault or the identity anyway) is refused. For a lower need, `--isolation` is the caller's claim. The `KeyServed` event says which: `proof: verified | claimed`, with the isolation, the pid and ppid, and the `lane` and `workspace`, which are always claims (the repo gate guards a mistake, not a lie). Managed settings from an administrator are not limited by `--setting-sources` and stay in force.

Residual: same-user is not a boundary in Morndo (ADR-0004). Another process of the same user that starts a claude-shaped process with a conforming settings file can lease the key, as it could read the identity file; the check stops a mistake and the agent's own tools, not that. A key is in the helper's memory while it prints it; Node can neither wipe a string nor set its own core limit, so the helper line sets `ulimit -c 0` first. A call killed with SIGKILL leaves its lease open; every `lease`, `run` and `check` first closes the leases whose holder is gone (`LeaseLost`). The store is on the node, so there is no hub start to sweep at. A failure prints a reason word (`failed`), never an error's message, which can carry a path. Other gate refusals exit 75, and a missing, revoked or not-leasable connection (a subscription, a non-Claude runtime) exits 1. `run` still uses `helper --lease <id>`, unchanged.
