# ADR-0026: Capability knowledge: sourced, dated cards per engine, loop patterns and SOP templates as files the orchestrator reads and cites; a re-check proposes, never writes

- **Status:** Proposed, 2026-10-12. Design: [`docs/design/capability-knowledge/README.md`](../design/capability-knowledge/README.md). Design only; no product code.
- **The request:** issue #30, a capability knowledge base for the orchestrator: model and engine strengths, agent loop patterns, SOP templates.
- **Number:** 0019 to 0025 are taken by open pull requests (#12, #18, #20, #21, #22, #28, #35).
- **Builds on:**
  - ADR-0013: Roles, Engines, chains, the other-provider rule.
  - ADR-0015: the board and its proposals.
  - ADR-0017: jobs that report back.
  - ADR-0018: Connections and the vendor catalog.
  - ADR-0020 (proposed, PR #18): auto routing, the model class, the Scorecard.
  - ADR-0024 (proposed, PR #28): usage of the GLM Coding Plan and Cursor.
- **Sources:** [K1]–[K111] in the design, section 13, all read 2026-10-12.

## Context

1. **The orchestrator improvises.** The manager briefs lanes and sets up recurring work from its instructions and its training data. Which engine suits which step, which loop fits a job, and what a recurring job needs are decided again in each brief, and the reasons are lost with it.
2. **Opinions pass as facts.** Views such as "Claude writes best" and "Gemini is best for SEO" (issue #30) are assumed or forgotten. Section 4.7 of the design checks both: neither is established by a primary source today.
3. **Facts age fast.** Every vendor in the first cards shipped a new model between 2026-08-18 and 2026-10-07 (design, section 4.6). One halved a model's cache-read price nine days after its launch [K16], [K106]; Google deprecated two Flash models on 2026-10-08 and now routes their requests to newer ones [K39]. The leaderboards the cards cite were updated between 2026-09-22 and 2026-10-08, while one long-cited board has had no new entry since 2026-02-26 [K107]. A ranking written into code or a prompt is wrong within weeks.
4. **Part of this already has a home.** The vendor catalog (ADR-0018) holds what the gate enforces: terms revisions, prices, families, isolation floors. ADR-0020 adds a model class per catalog model from the vendor's own words, and a Scorecard of this user's Outcomes, which it ranks on before any prior.
5. **The loops are known and so are their failures.** Vendors and studies describe the common agent loops and how they fail: looping, gaming tests, claiming work that wasn't done, drifting from the task (design, section 5). The guards are known too: stop rules, budgets, checks by someone other than the worker, human gates.
6. **The principal's trust is the product.** Among the README's reasons for Morndo: "'Done' that wasn't done", and a tool whose "quality of the output wasn't there". A workflow that can't say why it chose an engine, or that publishes without a gate, repeats that.

## Decision

1. **A Knowledge context with three kinds of file:** Cards (one per engine line or agent tool), Patterns (agent loops) and SOP templates (recurring jobs as data), plus a file per Disagreement that spans several Facts. Its sourced statements are **Facts**, a word chosen so as not to collide with the Verification context's Claim. Its rules K1 to K13 are pure, in `packages/domain/src/knowledge.ts`. Files are read by an adapter; the CLI is `morndo-knowledge`.
2. **Every Fact is sourced and dated.** A Fact has a Facet, task kinds, the models it holds for, a basis (`vendor-doc`, `vendor-claim`, `measured`, `study`), at least one Source with URL, publisher, read date and a verbatim quote, a checked date, a re-check date within its Facet's interval, and a status (K1, K2).
3. **Rankings are positions, not verdicts.** A leaderboard Fact names the board, its snapshot date and method, and the judge when a model judges (K3). A vendor's own result is labelled vendor-reported. What counts as a source, and what doesn't, is fixed in the design's section 4.3.
4. **Disagreements are shown, not resolved by choice.** Conflicting Facts both stay, `disputed`, and a Citation of either names the Disagreement (K5).
5. **Preferences are kept apart.** A Preference has a holder, a date and its words, needs no source, and is never shown or cited as a Fact (K4). Preferences are per user and never shipped (K12).
6. **Knowledge grants nothing** (K9). It never admits, excludes, fences or ranks a Candidate. ADR-0020's rules and Scorecard decide; the catalog's class and price values point to the Fact behind them, and a test holds the two together (K13).
7. **SOPs are checked data.** An outward Step comes after a Gate, every loop has a Stop rule, every Step has an output and a Check, and every engine Step cites a Fact or a Preference for its choice, or says `no evidence: default` (K10). A Step's `model` is advisory; the Role's chain and auto routing decide what runs (K9). A run's report lists the Citations it used (K11). The first template is a daily blog post (design, section 6.2).
8. **The re-check proposes, never writes** (K7, K8). A weekly job re-reads the Sources of Facts past their date, confirms quotes deterministically, drafts changes with one model and verifies them with another family, and prepares one local branch (shipped files) or one Ask (the overlay); a person pushes the branch and opens the pull request. Until a person accepts, the Facts stay and are cited as stale (K6).
9. **Storage: files first** (the design's option C, built as A). Shipped knowledge is Markdown with front matter under `docs/knowledge/`. Per-user knowledge (Preferences, SOP instances, local Facts) is an overlay in `~/.config/morndo-knowledge/`. Subscriptions, quotas and Outcomes are read from Connections, Usage and auto routing, never copied. A hub page is a later read model over the same loader.
10. **Order:** the first files from the design, the domain rules and loader, the CLI with the manager's prompt block, the catalog link, the re-check, then a page if wanted (design, section 11).

## Alternatives

| Option | Verdict |
|---|---|
| **Rankings in the prompt or in code** ("use Claude for writing") | Rejected. Unsourced, undated, and wrong within weeks. |
| **A domain context with a store and a page first** (the issue's second option) | Not now. Knowledge changes by review, not by use, so pull requests fit it better than records. Agents read files without the hub. A page can read the same files later. |
| **Card Facts as a ranking key in auto routing** | Rejected for now (Q3). ADR-0020 ranks this user's own Outcomes first, as Anthropic's own model guide advises [K5]. A vendor's words or a board's result on other tasks are weaker evidence. |
| **Let the re-check update cards directly when the page changed** | Rejected. A silent change is what K7 forbids: a vendor page that changed its wording, or a fetch that returned an error page, would rewrite knowledge with nobody looking. |
| **Prices and terms as values the code reads from the cards** | Rejected. The gate enforces them, so code reads them from the catalog only. A card holds the evidence for each, tested equal to the catalog (K13). |
| **Treat leaderboards as the truth for "best at"** | Rejected. Each measures its own tasks by its own method on its own date; model judges have documented biases. A position is a Fact with those details attached. |
| **Shipped preferences ("the team's view")** | Rejected. A preference is a person's; shipping one would present it to every user as Morndo's claim. |
| **A deep-research report as a source** | Rejected. It is a lead to the pages it cites; the Fact cites those pages after they are read. |

## Consequences

- **Good:** each engine choice in a brief, an SOP or a route can say which Fact or Preference it rests on, and how old that Fact is. A changed Fact can be traced to the runs that used it.
- **Good:** the two claims in issue #30 become what the sources support: sourced capabilities where they exist, preferences where they don't.
- **Good:** a new kind of recurring work starts from a template with its gates, checks and stop rules already in place.
- **Cost:** a schema, a loader, a CLI and its prompt block, a `fact` field on catalog classes and prices, and a weekly job whose pull requests someone must review. The five first cards hold 67 Facts: 35 fall due every 30 days, 10 every 60 and 22 every 90, so about 47 a month, plus the Patterns' and the template's.
- **Cost:** short verbatim quotes from vendor pages stored in a public repository (Q7).
- **Limit:** a card says what sources said on the day they were read. Between re-checks it can be wrong; its status and dates say how old it is, and a stale Fact says so wherever it is cited.
- **Limit:** for some task kinds no credible public ranking exists (SEO among them, design section 4.7). There the card can only state capabilities, and the choice rests on a Preference or on this user's Scorecard.
- **Risk:** the re-check's drafts are model-written. The verbatim-quote check, a reviewer of another family, and a person's review before merge contain that.

## Verification this implies

1. One negative-control test per invariant K1 to K13 (design, section 10), each fixture breaking only that invariant.
2. Every shipped file validates in CI; a broken fixture must fail.
3. A local quote check that re-reads every Source, outside CI, reported as skipped in CI.
4. The re-check against a fake server with an unchanged, a changed and a gone page: one re-confirmed batch, one changed Fact with a quote found on the new page, one `unverifiable` Proposal, nothing written.
5. `sop check` passes the blog-post template and refuses copies with the Gate, a Stop rule or a `why` removed.
6. Re-check triggers for this ADR: ADR-0020 changes how it uses the class; a vendor publishes a model card schema that could replace hand-written Facts; a credible public benchmark appears for SEO work, or for non-fiction writing judged by people.
