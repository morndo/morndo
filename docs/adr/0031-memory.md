# ADR-0031: Memory: what the lanes learned, kept as Notes and handed to every lane as Agent Skills

- **Status:** Accepted, 2026-10-20. Design: [`docs/design/memory/README.md`](../design/memory/README.md). The request: issue #65.
- **Number:** the next after ADR-0030.
- **Builds on:** ADR-0012 (lanes on many machines, typed operations only, FL14), ADR-0015 (the agents' door: agent tokens, the lane header, a CLI per job), ADR-0026 (Agent Skills as the format the lanes read, a stale note shown as stale, K6).
- **Rules:** M1 to M7 in `docs/domain.md`.

## Context

1. **Lanes start without context.** Each session's memory belongs to one machine and to one vendor's agent CLI, so what one lane learned is invisible to the next. Observed on a live setup (issue #65): a known quick task, creating an account in another product, took 34 minutes through Morndo and 85 seconds in a direct session that already knew the procedure. The Morndo lane spent most of that time rediscovering how it had been done before.
2. **Per-machine memories drift.** Two machines' memories of the same repository had 80 notes on one only, 160 on the other only and 209 on both.
3. **The lanes run more than one engine.** Whatever the store, the delivery must reach every engine a lane can run on. All of them read Agent Skills (ADR-0026).
4. **What a lane reads acts like an instruction.** A procedure in memory is followed, so a memory is a way in: MemPoison plants a backdoor in an agent's long-term memory through ordinary dialogue, with attack success rates up to 0.95, and finds existing defenses fundamentally limited.

## Decision

The design, in short:

1. **Memory is its own bounded context.** A Note is a Fact (a short claim) or a Procedure (a runbook) about one scope: a repository, a project, the user or the org. Every Note carries its provenance: who wrote it, on which node, from what work (M3). A Note is never edited or deleted, only superseded by a successor or invalidated (M2). The rules are pure, in `packages/domain/src/memory.ts`.
2. **Trust tiers come from the source** (M5): 1 the principal wrote or approved it, 2 confirmed by evidence the author did not produce, 3 an agent's, 4 derived from untrusted content (a mail, a web page, a comment). A tier never rises on its own.
3. **Writes are explicit and gated.** A lane writes on purpose, with `morndo-memory remember` through the agents' door (`/api/agent/memory`, an agent token and the lane header). Nothing is extracted from every message. A Procedure reaches a lane only once the principal approved it (M4), and an untrusted Note reaches none until then (M5). Slice 1 takes the approval at the control plane's console (`morndo memory approve`); an Ask in the app is the next slice.
4. **Every engine gets the same skills.** The hub renders the deliverable Notes as Agent Skills: one facts skill per scope, its index bounded (M6), and one skill per approved Procedure. It sends them to every node as one typed operation, `memory.sync`, in parts, with no command and no path (FL14). The node writes them into each engine's skill folder, marked as Memory's, and never touches a skill that is not. A Note past its re-check date is shown as stale, never dropped (M7). `morndo-memory search` and `show` reach what the index left out.
5. **Its own database.** The hub keeps Memory in `memory.db` beside its own database, with its own migrations and schema floor, so a Memory migration never blocks a hub rollback and Memory can be reset alone. Search is SQLite's FTS5 over title, summary and body. No graph database, no vector service.
6. **Memory grants nothing** (M1): a Note is never a Mandate, a Decision, Evidence or a Verdict.

### Where things live

| Piece | Where |
|---|---|
| M1 to M7: Notes, scopes, tiers, supersession, what is deliverable, the bounded index, the skill files | `packages/domain/src/memory.ts` |
| The wire: the agents' bodies and answers, `memory.sync` | `packages/protocol/src/memory.ts`, `packages/protocol/src/fleet.ts` |
| The lanes' command | `apps/memory-cli/src/cli.ts` |
| The hub's store, routes, console and sync loop; the node's `memory.sync` | the design, sections "Storage" to "The node's `memory.sync`" (later changes of slice 1) |
| The checks | `packages/domain/test/memory.test.ts`, `packages/protocol/test/fleet.test.ts`, `apps/memory-cli/test/cli.test.ts` |

## Alternatives considered

| Option | Verdict |
|---|---|
| **Each engine's own memory, as today** | Rejected. Per machine and per vendor: the 34 minutes and the drift above. |
| **A git repository of markdown notes** | Rejected. Many lanes on many nodes write at once, so writes meet as merge conflicts. Nothing gates a write: any lane that can push changes a procedure every lane then follows. |
| **A graph memory** | Rejected for now. On LoCoMo, Mem0's graph variant scored 68.44 against 66.88 overall. It helped temporal questions (+2.6) and open-domain ones (+2.8), but hurt single-hop (-1.4) and multi-hop (-4.0), at about twice the p95 latency (2.59 s against 1.44 s) and memory tokens (3,616 against 1,764). A systematic comparison of RAG and GraphRAG found plain RAG better on single-hop, detail-oriented questions and GraphRAG better on multi-hop ones. GraphRAG-Bench found that GraphRAG "frequently underperforms vanilla RAG on many real-world tasks". The lanes mostly need plain fact and procedure recall. A HippoRAG-style index over the Notes stays an option once multi-hop recall measurably fails. |
| **An LLM that extracts memories from every message** (Mem0's write path) | Rejected. A model call on every message, and the widest poisoning surface: MemPoison's backdoor goes in through ordinary dialogue. Explicit writes, mandatory provenance and the principal's approval of every Procedure instead. |
| **A vector service** | Not needed first. Full-text search finds Notes by their words; embeddings come only if measured retrieval failures justify them. |

## Consequences

- **Good:** a lane on any node, on any engine that reads Agent Skills, finds what other lanes learned through its skills, without being told where. Notes written on two nodes are one memory.
- **Good:** a Note says who wrote it and how far to trust it. A Procedure or untrusted content changes what lanes do only after the principal read it.
- **Cost:** every Procedure waits for the principal, at the console in slice 1.
- **Cost:** a second database file, a sync loop, and a typed operation that every node with an explicit op list must add to its policy.
- **Limit:** lanes keep only what they choose to write. Turning lane reports into proposed Notes is a later, optional job, and its output would be proposals too.
- **Limit:** full-text search misses a paraphrase that shares no words with the Note.
- **Limit:** a facts index has a size limit (M6). The Notes that don't fit are found only by a search, which the skill says.
- **Limit:** a repository is known by the folder name of its main checkout, which every worktree of it shares. Two repositories checked out under the same name share a scope.
- **Risk:** the Agent Skills specification may change. Skill names follow it as read on 2026-10-20.

## Sources (read 2026-10-20)

- Issue #65, "Centralized context: one provider-agnostic memory for every lane": the observed task times and the drift counts.
- Agent Skills specification: https://agentskills.io/specification (`name`: 1 to 64 lowercase letters, digits and hyphens, no leading, trailing or double hyphen, equal to the folder name; `description` up to 1024 characters; `metadata` a map of strings).
- Chhikara et al., "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory", arXiv 2504.19413, Tables 1 and 2: https://arxiv.org/abs/2504.19413
- Han et al., "RAG vs. GraphRAG: A Systematic Evaluation and Key Insights", arXiv 2502.11371, sections 4.2 and 6: https://arxiv.org/abs/2502.11371
- Xiang et al., "When to use Graphs in RAG: A Comprehensive Analysis for Graph Retrieval-Augmented Generation" (GraphRAG-Bench), arXiv 2506.05690: https://arxiv.org/abs/2506.05690
- Wang et al., "MemPoison: Bypassing Selective Memory Mechanisms to Plant Backdoors in LLM Agents", arXiv 2605.29960: https://arxiv.org/abs/2605.29960
- Gutiérrez et al., "HippoRAG: Neurobiologically Inspired Long-Term Memory for Large Language Models", arXiv 2405.14831: https://arxiv.org/abs/2405.14831
- Kumaran, Hassabis and McClelland, "What Learning Systems do Intelligent Agents Need? Complementary Learning Systems Theory Updated", Trends in Cognitive Sciences 20(7):512-534, 2016, https://doi.org/10.1016/j.tics.2016.05.004. A fast store of episodes beside slowly consolidated knowledge: here, lane reports stay where they are, and Facts and Procedures are written and approved apart from them.

## Amendment: approval is the principal's (2026-10-21, board T-309)

Decision 3 had the console approve a Procedure or an untrusted Note by itself, and any process on the box that could run
`morndo memory approve` approved — a lane that proposed a Procedure could have approved it. Approval is now the
principal's answer under step-up (AC7, M8): either a signed-in Endpoint through the existing step-up check
(`mayCommand`, as the board takes it), or the console with a one-time code that only an Endpoint under step-up can mint
for that one note (`MemoryService.issueApprovalCode`). The code is 12 characters of Crockford base32 shown as
`XXXX-XXXX-XXXX`, valid ten minutes, single use, one live code per note, burned after five wrong tries; only a SHA-256
hash of it is stored, and it is compared with `timingSafeEqual`. The limit is ADR-0004's: the console runs as the same OS user
as the hub, so a process of that user that can read or write `memory.db` directly is out of scope; the code raises the
bar from running one command to editing the database file.

Round 2 (2026-10-21) ships the app side: a pending Note files an Ask on the Decisions board — id `mem-n-<k>`, held open
by the hub (E14), at most ten at a time, the oldest first — whose Approve/Reject answer under step-up approves or
invalidates the Note and is recorded as the Decision (E8); nothing is typed and no queue is touched (M1). Minting the
code has a route of its own, `POST /api/memory/notes/:id/approval-code`: a Command under step-up, answered once with
`{ code, expiresAt }`, never logged; `morndo memory approve <id> --code` spends it. The app has no button for the route
yet: the Ask answers approval, the code is for the console.
