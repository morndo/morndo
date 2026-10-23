# ADR-0023: Decision briefs: one format for every decision, a compact card, the full brief in a modal

- **Status:** Accepted, 2026-10-12. The owner approved the design (section 12's defaults) and said build. Design: [`docs/design/decision-briefs/README.md`](../design/decision-briefs/README.md).
- **The request (the owner, 2026-10-11, paraphrased):** the decisions panel is too thin and its cards are not clear enough; he keeps asking what they mean. Compact, sharp cards; a click opens a modal with the full brief, where he decides; the brief written in his format; part of the public harness, so every agent writes it the same way.
- **Number:** 0019 to 0022 belong to other branches.
- **Builds on:** ADR-0006 (the desktop and its decisions panel), ADR-0009 (the phone's decision cards, the 5-second Undo), ADR-0010 (the manager's inbox), ADR-0011 (the phone as a chat app, the visual viewport), ADR-0015 (agent tokens, the agents' door, a CLI first), ADR-0007 (the brand's colour rules).
- **Rules:** E8 to E13 in `docs/domain.md`; new DB1 to DB10 and E14 in the design, section 4, which go into `docs/domain.md` with the first PR.
- **Sources:** [S1]–[S7] in the design, section 11, read 2026-10-11.

## Context

1. **No agent can raise an ask by command.** Asks come from the manager's needs-you file (`MORNDO_LEDGER`, read only), a `[buttons …]` last line in the manager's answer, or a worker's question or menu on its screen. The agent routes cover the board, jobs and usage only. ADR-0022 found the same gap for secrets.
2. **An Ask has no shape for its reasoning.** It carries a title, an optional short form (title, one sentence, minutes, link, details), a recommendation and what happens without an answer. Everything else is free text. Each ask reads differently, and a long title is cut at four lines in the card.
3. **The card is the only place a decision is explained.** In the 440 px panel it holds the asker, the title, a facts grid with a 158 px label column, the options, and the asker's whole message unfolded inside the card. The panel is too narrow for that, and the content has no structure to lean on.
4. **The owner wrote down the format he wants**: a decision request with topic, approver and due; a headline that names the recommended option; the ask with its key numbers; why now; the options compared in a table; why the recommendation, with the assumption behind any money figure and a downside case; what would change it; the main risk and its control; what approval authorizes; one choice per option; and the evidence.

## Decision

1. **A `DecisionBrief` value in the Escalation context** (`packages/domain/src/brief.ts`, pure): the owner's sections as typed fields, required and optional as the design's section 3 lists them. One function, `lintBrief`, refuses a vague brief and returns warnings for a weak one. Its rules (DB1 to DB10):
   - 2 to 6 options in the manager protocol's grammar, so each answer can be typed back as a tap line;
   - one recommended option, and the headline names exactly that one ("option B");
   - a due time after filing, and the minutes it takes to read and decide;
   - a comparison of 3 to 10 factors with exactly one column per option and a note on what the numbers include;
   - a money figure anywhere needs a stated assumption, and every brief states a downside case;
   - every required section present and within its cap, and no unknown section;
   - prose in a markdown subset (no headings, raw HTML or images; `https:` links only);
   - a brief grants nothing: an answer is a Decision under E8 to E13, never a Mandate, and "What approval authorizes" is the asker's commitment, which the hub records and does not enforce;
   - a restated brief is a new version, so an answer to the old one is refused (E11, E12).
2. **An ask filed through the hub stays answerable until its asker withdraws or settles it, or 7 days after it is due** (E14). Overdue is not expired.
3. **The harness: `morndo-decide`,** a second command beside `morndo-board` in `apps/board-cli`, with the same tokens, environment and exit codes. `template`, `lint`, `new`, `restate`, `show`, `list`, `withdraw`, `settle`, and for the manager `forward` and `decline` of a lane's draft. It sends a markdown file in the guide's template, or JSON, to `POST /api/agent/decisions` under an agent token; `?dry=1` lints only. A refusal is one line per problem in words an agent can act on. A hub adapter reads the template strictly (front matter, the fixed headings, labelled lines, one GFM table), and the domain lints the result. A JSON Schema of the brief is committed for engines that call tools. The answer reaches the asker as today: a tap line typed into its pane, for the manager through its inbox.
4. **A public guide**, [`docs/agents/decision-requests.md`](../agents/decision-requests.md): the template, the rules in plain words, and a complete made-up example in the owner's format. A test keeps the guide's template equal to `morndo-decide template` and its example lint-clean.
5. **The compact card** is derived for every Ask, with or without a brief: topic, headline, recommended option, due, minutes, "Includes spend", and quick answers. The whole card opens the brief. The panel becomes resizable from 360 to 640 px (440 by default, remembered per device).
6. **The full brief opens in a native `<dialog>` with `showModal()`** on the desktop (760 px), and as a full-screen sheet on the phone. Sections are in the owner's order. The options are compared in a real table drawn from the structured rows, and the recommended column is marked with a star and the word, not colour alone. The answer buttons sit in a footer that stays in view, with today's confirm step and passkey check (desktop) or 5-second Undo (phone). Focus starts on the headline and returns to the card. Escape steps back from the confirm before it closes. On the phone, the table becomes one block per factor under 560 px, and Back closes the sheet through SvelteKit's shallow routing.
7. **Backwards compatible.** Today's plain asks keep their sources and rules. They get the compact card from their own fields and a modal marked "Filed without a brief", with "Ask for a brief" (a message to the asker, not an answer). An Ask made from a brief also fills every field an older app reads (`shortTitle`, `summary`, `minutes`, `deadline`, `options`, `recommendation`, and the whole brief as markdown in `details`), so an old app shows all of it behind More. A brief may name the manager's list item (`ref`); the list then still decides whether it is open.
8. **Order:** domain and protocol; hub and CLI; desktop; phone; rollout into the manager's instructions. The done criteria and tests are in the design, sections 7 and 8.

### Where things will live

| Piece | Where |
|---|---|
| DB1 to DB10, E14, lint, the compact card, the mapping to an Ask | `packages/domain/src/brief.ts` |
| The wire, the `brief` field on a decision, the JSON Schema | `packages/protocol/src/brief.ts`, `packages/protocol/schema/decision-brief.json` |
| The template adapter, the store, the routes | `apps/hub/src/adapters/brief-template.ts`, `apps/hub/src/application/escalation-service.ts`, `/api/agent/decisions` in `apps/hub/src/adapters/http.ts` |
| The command and its prompt blocks | `apps/board-cli/src/decide.ts`, `apps/board-cli/src/prompt.ts` |
| The guide | `docs/agents/decision-requests.md` |
| The card, the modal, the renderer | `apps/web/src/lib/desktop/DecisionCard.svelte`, `BriefModal.svelte`, `RightPanel.svelte`, `apps/web/src/lib/markdown.ts`; the phone's `phone/DecisionCard.svelte` and a `phone/BriefSheet.svelte` |
| The checks | `packages/domain/test/brief.test.ts`, `packages/protocol/test/brief.test.ts`, `apps/hub/test/briefs.test.ts`, `apps/board-cli/test/decide.test.ts`, `apps/board-cli/test/decide-doc.test.ts`, `e2e/briefs.e2e.ts` |

## Alternatives

| Option | Verdict |
|---|---|
| **A wider panel and longer cards, no modal** | Rejected. It moves the clamp, not the problem: a comparison of three options over seven factors doesn't fit a side column at any width the conversation can spare. |
| **Free markdown with suggested headings** | Rejected. Nothing could tell a vague brief from a good one, the card couldn't be derived, and every agent would drift from the format again. |
| **Briefs written into the manager's needs-you file** | Rejected as the door. One machine, one agent, no lint at writing time, and ADR-0015 rejected the same file pattern for the board (the fleet design retires it, ADR-0014). A brief may still name a list item (`ref`), so the owner's manager can adopt briefs without two cards for one question. |
| **JSON only** | Rejected as the only way in. Agents write long prose more reliably as markdown, and a template reads well in a terminal. JSON stays for tool-calling engines, behind the same lint. |
| **A model judges brief quality** | Rejected. Lint must be deterministic, cheap and the same everywhere (DB10). Quality is the manager's review of drafts (owner decision Q1). |
| **Enforce "What approval authorizes"** | Not now. That is a Mandate (ADR-0002, Proposed). The modal says the hub records the answer and doesn't enforce the limits. |
| **Reuse `SlackModal` for the brief** | Rejected for the brief. It has tabs and a custom overlay; a native `<dialog>` gives inertness, the top layer and Escape from the browser [S1]. `SlackModal` stays for the other modals. |

## Consequences

- **Good:** every decision reads the same way, the card says in three lines what is asked and by when, and the reasoning is one click away in a layout made for it.
- **Good:** an agent learns at filing time, from the same rules the hub applies, why its brief is vague.
- **Cost:** a brief costs an agent more tokens than a buttons line, and the manager more review. The caps, `minutes` at most 30, and owner decision Q3 bound it.
- **Limit:** lint checks structure, not truth. A brief can be well formed and wrong. Evidence links and the manager's review are the controls, and DB8 keeps a brief from granting anything.
- **Limit:** a worker token names its lane by a header the hub can't prove (ADR-0015). With Q1's default only the manager's briefs reach the principal.
- **Not verified here:** the sheet on a real iPhone (the e2e emulates the visual viewport in Chromium, as ADR-0011 did).

## Owner decisions

From the design, section 12, each with the recommended default:

1. **Who may send a brief to you?** Default: the manager only; a lane's brief is a draft the manager forwards or declines.
2. **Quick answers on the compact card?** Default: yes, through the confirm step or the Undo window, except for briefs with spend, which open the brief first.
3. **One format for everything agents file?** Default: yes, a full brief for every decision filed with the new command; today's plain asks keep working.

## Amendment: short cards (2026-10-21, board T-307)

The manager's everyday question to the principal was never a brief: a few lines and a `[buttons …]` last line, sent
on his phone, never filed. A card now gets the brief's discipline as a short form: a pure `lintCard` in the domain, a
text adapter in the protocol, and `morndo-decide card`, which checks a card file and prints the lines to post — it
files nothing and needs no hub, like `lint` and `template`. Its rules: an id for the buttons line, one plain outcome
line, two to four options with the protocol's keys and labels, the recommended option first and named, a default that
is one of the options, and no placeholder left from the blank; with a live Risk named, each option is marked stop or
continue (`| stop`) and the default must be a stop, and ids only the manager can read (#12, a commit hash, an ask id)
warn. The kinds are declared by the asker, and lint checks they are there and that the default is a stop under a live
risk; the jargon patterns are lint — shape, not judgement of truth: whether the risk is real stays with the manager.

Lint cannot catch two mistakes, and the card says nothing of them. A wrong stop or continue declaration passes whenever the
default is marked stop: the asker says which option stops, and whether that is true is the manager's to judge. A card whose
Risk line was dropped is valid, because a card with no Risk line is: lint cannot know a risk existed. Both stay with the
manager's review of the draft.
