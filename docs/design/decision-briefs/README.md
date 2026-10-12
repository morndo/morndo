# Decision briefs: compact cards, the full brief in a modal, one format for every agent

**Phase: building.** The owner approved section 12's defaults and said build (2026-10-12). This document and [ADR-0023](../../adr/0023-decision-briefs.md). PR 1 is the domain; PR 2 is the hub and `morndo-decide`.

**The request (the owner, 2026-10-11, paraphrased):** the decisions panel is too thin and the cards are not clear enough; he keeps asking what they mean. He wants compact, sharp cards. Clicking a card opens a modal with the full brief, and he decides there. The brief follows one format, his own (section 3), and it is part of the public harness, so every agent writes it the same way.

## 1. How decisions work today

Read on `main` at 3f638f0, 2026-10-11.

| Step | Where | What happens |
|---|---|---|
| An agent asks | The manager's needs-you list (a JSON file the hub reads when `MORNDO_LEDGER` names it, `apps/hub/src/adapters/ledger.ts`); a `[buttons <id>] key=Label \| …` last line in the manager's answer (`adapters/manager-protocol.ts`); a worker's open question or menu (Observation) | There is no command or route for an agent to raise an ask. ADR-0022 states the same gap for secrets. |
| The hub joins them | `apps/hub/src/application/escalation-service.ts` over `packages/domain/src/escalation.ts` | One Escalation per id (E1). An Ask has a title, an optional short form (`shortTitle`, `summary`, `minutes`, `link`, `details`), a recommendation, what happens without an answer, a deadline, options (recommended first), how it is answered (tap, words, screen) and how long it stays answerable (E10). |
| The app gets them | The `decisions` feed frame, `DecisionItemSchema` in `packages/protocol/src/feed.ts` | Every Endpoint gets the whole list on hello and on each change. |
| Desktop | `RightPanel.svelte` (440 px, `RIGHT_WIDTH` in `Desktop.svelte`), `DecisionsPanel.svelte`, `DecisionCard.svelte` | A card carries the asker, the title (clamped to 4 lines), a facts grid (Recommended, If you don't answer, in a 158 px label column), the options as buttons, and "Why the manager asks", which expands the asker's message as markdown inside the card. |
| Phone | `phone/DecisionCard.svelte` in catch-up, rows on Today, `phone/brief.ts` | A short title, one sentence, a meta line, big option buttons; the rest behind More. A tap goes after a 5-second Undo window (C6). |
| He answers | `POST /api/escalations/:id/answer` | E8 to E12 and the passkey step-up (AC7). For the manager the answer goes through its inbox (E13, ADR-0010) as `[tap <id>] <key> (<Label>)`, or `About <id>: <words>`. |

What goes wrong, from the code: the card is the only place a decision is explained, and the panel has to hold it. Everything the asker wrote is either clamped (the title), squeezed into a label column (the facts), or unfolded inside a 440 px column (the context). There is no agreed shape for the explanation, so each ask reads differently, and an ask written as one long title is cut at four lines. "Too thin" holds in both readings: the column is narrow for what it carries, and the content has no structure to lean on.

No design-master or UI-parity rule exists in this repo (searched `docs/`, `AGENTS.md`, `CONTRIBUTING.md` and `packages/brand`, 2026-10-11). The UI follows ADR-0006 (Slack's measurements for the desktop), ADR-0011 (the phone) and the brand's `packages/brand/COLOR.md`: colour only for status, never colour alone, ink for actions and selection.

## 2. The idea in five lines

1. A **DecisionBrief** is a value in the Escalation context: the owner's format as typed sections, checked by one pure function in the domain.
2. Agents file a brief with **`morndo-decide new brief.md`** (a markdown template) or JSON over `POST /api/agent/decisions`. A vague brief is refused with one line per problem.
3. The panel shows a **compact card** derived from the brief: topic, headline, recommended option, due, minutes to read, and quick answers.
4. Clicking the card opens a **modal with the full brief**, the options compared in a real table, and the answer buttons in its footer. On the phone it is a full-screen sheet.
5. Today's plain asks keep working: they get the same compact card, and the modal shows what they have, marked "Filed without a brief".

## 3. The format

The owner's example is the target. Its parts, in his order, and how each becomes a field:

| # | The owner's part | Field | Required |
|---|---|---|---|
| 1 | DECISION REQUEST · topic; Approver · Owner · Decision due | `topic`, `due` (the approver is always the principal for now) | yes |
| 2 | Headline recommendation ("Approve option B: …") | `headline`, `recommend` (an option key) | yes |
| 3 | The ask, key numbers in bold (spend, effort, time, estimated benefit), one line on the alternative, one on the main uncertainty | `ask.text`, `ask.alternative`, `ask.uncertainty` | yes |
| 4 | Why a decision is needed now: facts, the deadline that forces it | `whyNow` | yes |
| 5 | Options compared: factors as rows, options as columns, a note on what the numbers include | `comparison.rows[]`, `comparison.note` | yes |
| 6 | Why the recommendation, the assumption behind any money figure, a downside case | `why.text`, `why.assumptions[]`, `why.downside` | yes; assumptions when money appears |
| 7 | What would change the recommendation: the concrete condition | `changeIf` | yes |
| 8 | Main risk and control | `risk.risk`, `risk.control` | yes |
| 9 | What approval authorizes: limits, what needs fresh approval, the review point | `authorizes.limits[]`, `authorizes.freshApproval`, `authorizes.reviewPoint` | yes |
| 10 | Decision: one choice per option | `options[]` (key, label) | yes, 2 to 6 |
| 11 | Supporting evidence to attach | `evidence[]` (label, https link) | no (a warning) |
| – | (from today's Ask) what happens without an answer | `ifNoAnswer` | no |
| – | Minutes to read and decide | `minutes` | yes |
| – | Blocking, project, a board task, the asker's own id | `blocking`, `project`, `task`, `ref` | no |

The public guide, [`docs/agents/decision-requests.md`](../../agents/decision-requests.md), has the template and a complete made-up example. This document uses the same example.

## 4. The domain: `DecisionBrief`

New module `packages/domain/src/brief.ts`, in the Escalation context. Pure: no clock (callers pass `now`), no markdown library, no I/O. The terms and rules below go into `docs/domain.md` with PR 1.

| Term | Means | Is not |
|---|---|---|
| Decision brief | The asker's case for one decision, in the fixed sections of section 3, in one version. | A Decision, a Mandate, or a plan the hub enforces. |
| Version | One statement of a brief. Restating makes the next one. | An edit in place. |
| Lint | The domain's check of a brief: problems that refuse it, and warnings that don't. | A reading by a model. |
| Compact card | What the panel shows of an Ask: topic, headline, recommended option, due, minutes, quick answers. Derived, never stored. | A second copy of the brief. |

```ts
type BriefOption = { key: string; label: string };              // the manager protocol's grammar
type DecisionBrief = {
  topic: string;                    // ≤ 60, one line
  due: number;                      // ms; the template adapter reads a date alone as the end of that day, as parseDeadline does
  minutes: number;                  // 1–30: time to read and decide
  headline: string;                 // ≤ 100, one line, names one option: "Approve option B: …"
  recommend: string;                // an option key
  ask: { text: Md; alternative: Md; uncertainty: Md };   // alternative and uncertainty: one line each
  whyNow: Md;
  options: BriefOption[];           // 2–6, in the table's column order
  comparison: { rows: { factor: string; cells: string[] }[]; note: string };   // cells in option order
  why: { text: Md; assumptions: string[]; downside: string };
  changeIf: string;
  risk: { risk: string; control: string };
  authorizes: { limits: string[]; freshApproval: string; reviewPoint: string };
  ifNoAnswer: string | null;
  evidence: { label: string; url: string }[];
  blocking: boolean; project: string | null; task: string | null; ref: string | null;
};
type BriefProblem = { level: "error" | "warning"; code: string; where: string; text: string };
function lintBrief(draft: unknown, now: number): { brief: DecisionBrief | null; problems: BriefProblem[] };
function cardOf(item: Ask & { brief: DecisionBrief | null }, now: number): CompactCard;
function askFromBrief(id: string, brief: DecisionBrief, asker: Asker, version: number, at: number): Ask;
function briefMarkdown(brief: DecisionBrief): string;     // the canonical text, for old apps and the CLI's show
```

`Md` is text in the brief's markdown subset (DB7).

### 4.1 Invariants

| # | Invariant | Guards |
|---|---|---|
| DB1 | A brief has 2 to 6 options. Keys are letters, digits, `-` and `_`, at most 16, unique; labels are 1 to 40 characters with no control character. This is the manager protocol's grammar (`optionsProblem`), so every answer can be typed back as a tap line. | E9 |
| DB2 | `recommend` is one of the options. The headline names exactly that option, as `option <KEY>` (any case), and names no other key. | F2: an answer he didn't mean |
| DB3 | A brief has a due time after the time it is filed or restated, and `minutes` from 1 to 30. | the owner's "decision due" |
| DB4 | The comparison has 3 to 10 factor rows and one column per option, in the options' order: every row has exactly one non-empty cell per option ("n/a" is a value; an empty cell is not). It has a note on what the numbers include. | "every option has a column" |
| DB5 | A money figure anywhere in the brief (a currency sign or code next to a number) needs at least one stated assumption. Every brief states a downside case. | the owner's rule for money |
| DB6 | Each required section of section 3 is present, non-empty and within its cap (section 4.3). An unknown section is refused, so a misspelt heading never drops its text. | vague briefs |
| DB7 | Prose fields use the subset: paragraphs, lists, bold, italic, strikethrough, inline and fenced code, block quotes, GFM tables, and links whose target is `https:`. No headings (the format owns the outline), no raw HTML, no images. What lint accepts, the renderer shows; what the renderer would drop, lint refuses. | A1, the app's sanitiser |
| DB8 | A brief grants nothing. An answer to it is a Decision under E8 to E13, to the asker, never a Mandate. "What approval authorizes" is the asker's commitment, shown to the principal and recorded with the brief; the hub does not enforce it. | B8, O4 |
| DB9 | Restating a brief makes the next version and a new ask message: an answer given for the earlier version is refused as `changed` (E12), and a Decision already given no longer answers the new version (E11). | F2 |
| DB10 | Lint is one function. The CLI's `lint`, the agent route and the dry run call the same `lintBrief`, so an agent sees exactly what the hub will refuse. Warnings never refuse. | |

And one amendment to E10, as a new invariant:

| # | Invariant | Guards |
|---|---|---|
| E14 | An Ask filed through the hub (`tracking: "hub"`) is answerable while the hub holds it open: until its asker withdraws or settles it, and at most 7 days after its due time, when it expires. Overdue is not expired: he can still answer an overdue brief. | F2, F4 |

### 4.2 Lint codes

Errors refuse the brief; warnings come back with the id. Each line names the field and says what to do.

| Code | Level | When |
|---|---|---|
| `no_options`, `too_many_options`, `bad_option`, `duplicate_option` | error | DB1 |
| `no_recommendation` | error | `recommend` missing or not an option key |
| `headline_option` | error | the headline names no option, another option, or more than one (DB2) |
| `no_due`, `bad_due`, `due_past` | error | DB3 |
| `bad_minutes` | error | missing, not a whole number, or outside 1–30 |
| `missing_section`, `unknown_section`, `empty_section` | error | DB6 |
| `table_columns` | error | an option has no column, a column has no option, or the order or label differs (DB4) |
| `table_rows`, `empty_cell`, `no_table_note` | error | DB4 |
| `money_without_assumption`, `no_downside` | error | DB5 |
| `bad_markdown`, `bad_link` | error | DB7 |
| `too_long`, `control_char` | error | caps, section 4.3 |
| `no_evidence` | warning | no evidence listed |
| `ask_no_bold_figure` | warning | the ask has no bold figure (the owner reads the numbers first) |
| `why_now_no_date` | warning | "Why now" names no date or time |
| `change_if_vague` | warning | "What would change" has no number or date in it |
| `minutes_low` | warning | the text takes longer to read at 200 words a minute than `minutes` says |

Money is matched by one pattern in the domain: a currency sign (`$ € £ ¥ ₹`) before a digit, or a number (with `k`, `m` or `bn`) before a sign or an ISO code from a short list (USD, EUR, GBP, CHF, JPY, INR, CAD, AUD). "3 weeks" and "6 agent-days" are not money; "$2,400", "2.4k EUR" and "€180" are. The tests hold a table of both.

### 4.3 Caps

| Field | Cap |
|---|---|
| topic | 60 characters, one line |
| headline | 100 characters, one line |
| ask.text | 600 |
| ask.alternative, ask.uncertainty, changeIf, risk.risk, risk.control, why.downside, authorizes.freshApproval, authorizes.reviewPoint, ifNoAnswer | 300 each |
| whyNow | 800 |
| why.text | 1200 |
| why.assumptions, authorizes.limits | 1 to 6 items (assumptions may be empty when no money appears), 200 each |
| comparison | 3 to 10 rows; factor 40, cell 120, note 300 |
| evidence | at most 8; label 80, url 2000, `https:` only |
| the whole brief as JSON | 16 KB |

### 4.4 The compact card, derived

`cardOf` works for every Ask, with or without a brief:

| Card field | From a brief | From a plain Ask (today's) |
|---|---|---|
| Topic | `topic` | `shortTitle`, else the first clause of `title` (today's `phone/brief.ts` `clause`, moved into the domain) |
| Headline | `headline` | `summary`, else the rest of `title`, else none |
| Recommended | the `recommend` option's label | `options[0]` for a tap ask (the manager's protocol puts it first), else none |
| Due | `due` | `deadline` |
| Minutes | `minutes` | `minutes`, else none |
| Includes spend | DB5's money pattern found | the same pattern over title, summary and details |
| Quick answers | the options, recommended first, or none (owner decision Q2) | as today: options, Done for a time item, "Answer…" for words |
| Has brief | yes | no: the modal says "Filed without a brief" |

### 4.5 Backwards compatibility

- **Old asks.** The manager's list, its button lines and the workers' questions and menus are unchanged. They get `brief: null`, the compact card from their own fields (section 4.4), and a modal that shows the fields they have.
- **Old apps.** The hub fills an Ask made from a brief with everything an app that doesn't know `brief` reads: `shortTitle` = topic, `summary` = headline, `minutes`, `deadline` = due, `options` (recommended first), `recommendation` = headline, `ifNoAnswer`, and `details` = `briefMarkdown(brief)`. An old phone shows the whole brief behind More; an old desktop shows it under "Why the manager asks".
- **The wire.** `DecisionItemSchema` gains `brief: orElse(nullable(DecisionBriefSchema), null)` and `briefVersion`. A hub that doesn't send them reads as `null`. A brief this app can't parse is `null`, never a half brief, and the card falls back to the plain fields above.
- **The ask's version.** `askVersion` already covers `details`, so a restated brief changes it. PR 1 adds the brief's version number to it as well, so E12 doesn't depend on the markdown rendering. A hub ask's `askedAt` is its version's own filing time (the store's filed and restated times, §5.5), and the store must rebuild it as that time after a restart, never as the load or sighting time: a Decision restored from before a restate is dropped by `restored.at >= askedAt` (E11), so a rebuilt `askedAt` would silently reopen every answered brief.
- **The manager's list.** A brief may name its list item: `ref: ny-400`. The hub then shows one Escalation with that id, the list still decides whether it is open (E10), and the brief's options are the ask's options. Without `ref` the hub numbers it `d-<n>` from a counter that only grows (as B7), and E14 applies.

## 5. The harness: how an agent asks

### 5.1 The command

`morndo-decide`, a second command in `apps/board-cli` beside `morndo-board`. The same environment (`MORNDO_HUB`, `MORNDO_AGENT_TOKEN`, `MORNDO_LANE`), no dependency but the hub, the same exit codes: 0 done, 1 refused (one line per problem on stderr), 2 usage, 3 the hub can't be reached.

```
morndo-decide template                      print the template (the guide's, exactly)
morndo-decide lint <file.md|->              check a brief; files nothing
morndo-decide new <file.md|-> [--json]      file it; prints the id (d-12) and any warnings
morndo-decide restate <id> <file.md|->      the next version; answers to the old one are refused
morndo-decide show <id> [--json]            the brief as filed, its status, and the answer once given
morndo-decide list [--open] [--drafts]      your requests (the manager: also the lanes' drafts)
morndo-decide forward <id>                  manager: send a lane's draft to the principal
morndo-decide decline <id> --why "…"        manager: turn a lane's draft down
morndo-decide withdraw <id> --why "…"       the question went away
morndo-decide settle <id> [--note "…"]      you acted on the answer; it leaves the principal's list
morndo-decide prompt --role manager|worker  the instruction block for a lane's prompt
```

A refusal reads like `error headline_option (headline): the headline names option C, but recommend is b; name the option you recommend`, one per line, errors first. The answer reaches the asker as it does today: typed into its pane as `[tap d-12] b (Extend the triage script)` or `About d-12: <words>`, for the manager through its inbox (E13). `show` says which option was chosen, or "in words" (E9 keeps only the words' length and hash, so the words themselves are in the asker's conversation, not in the hub's record).

### 5.2 The routes

Under the agents' door (ADR-0015): an agent token, no cookie, no Origin.

| Route | Does |
|---|---|
| `POST /api/agent/decisions` | Body `text/markdown` (the template) or `application/json` (`DecisionBrief`). `?dry=1` lints only. 201 `{ id, version, warnings }`; 422 `{ error: "brief_refused", problems, warnings }`; 403 `not_allowed` (owner decision Q1); 409 `ref_taken`, `too_many_open` (20 open per asker). |
| `GET /api/agent/decisions[?open=1&drafts=1]` | The caller's own requests (the manager also sees drafts): id, version, topic, status, the answer. |
| `GET /api/agent/decisions/:id` | One request, as above, with the brief. |
| `PUT /api/agent/decisions/:id` | Restate (DB9). Same bodies and answers as POST. |
| `POST /api/agent/decisions/:id/withdraw` `{ why }`, `.../settle` `{ note? }` | The asker only. Settled with its words as the resolution. |
| `POST /api/agent/decisions/:id/forward`, `.../decline` `{ why }` | The manager only, on a draft. |
| `GET /api/agent/decisions/template` | The template text. |

The principal's side doesn't change: `GET /api/escalations` and `POST /api/escalations/:id/answer`, with E8 to E13 and AC7.

The markdown template is turned into a `DecisionBrief` by an adapter in the hub (`apps/hub/src/adapters/brief-template.ts`): front matter of `key: value` lines, then the fixed headings in order, labelled lines (`Alternative:`, `Assumptions:` and so on) and one GFM table. It reads only this template, strictly, by hand: it is not a general markdown parser, and a heading it doesn't know is `unknown_section`. The domain then lints the result. JSON callers skip the adapter.

### 5.3 The tool schema

`packages/protocol/src/brief.ts` holds `DecisionBriefSchema`, and a test writes it out as JSON Schema (`packages/protocol/schema/decision-brief.json`) and fails when the committed file differs. An engine that calls tools rather than shell commands can file the same JSON with it. An MCP adapter over the same routes can come later; the CLI comes first because every engine runs shell commands (ADR-0015 made the same call for the board).

### 5.4 Who may file, and drafts

With owner decision Q1's default, a worker lane's brief is a **draft**: it lands for the manager, as a board proposal does (B2), and the principal doesn't see it until the manager forwards it. Forwarded, the manager is the asker (the answer goes to the manager's inbox) and the card says "drafted by #<lane>". A worker token names its lane by a header (ADR-0015), which the hub can't prove; drafts keep that claim away from the principal's list. If the owner opens filing to every lane, the lane's claimed name is shown as claimed, as the board does, until the node can vouch for it the way ADR-0022 proposes for secret requests.

### 5.5 Store, audit, notifications

- **Store:** `decision_briefs` (id, ref, asker kind and name, token id, version, brief JSON, state: draft, open, withdrawn, settled, expired, filed and restated times, resolution) and a counter, in the next migration. A restate keeps the earlier versions' JSON for the record.
- **Audit:** `BriefFiled`, `BriefRestated`, `BriefWithdrawn`, `BriefSettled`, `BriefForwarded`, `BriefDeclined`: the id, version, asker and token id, never the text (as `BoardChanged`). Refusals are counted in the log, not audited.
- **Notifications:** a brief that opens raises one counts-only Notification as a Decision waiting (N1, N2). Nothing new.
- **Redaction:** brief JSON leaves the hub through the shared redactor, as every JSON body does (ADR-0018 §6.2).

## 6. The UI

### 6.1 The panel and the compact card

The panel keeps its groups and summary tiles. Changes:

- **The card is three lines and a row of buttons.** The facts grid, the 4-line title and the in-card context expander leave the card; they live in the modal.
- **The whole card opens the brief.** The headline is a `<button aria-haspopup="dialog">` inside an `<h3>`, stretched over the card with a pseudo-element; the quick answers sit above it. Tab reaches the headline, then the quick answers.
- **The panel is resizable,** from 360 to 640 px, 440 by default, remembered on the device (`morndo.right.width`), with a separator like the sidebar's that also moves with ← and → (`role="separator"`, `aria-valuenow`, `-min`, `-max`). The rule that turns the panel into an overlay below a 560 px conversation uses the chosen width.

A brief with spend (owner decision Q2's default: read before deciding):

```
┌────────────────────────────────────────────────────────┐
│▌ SUPPORT INBOX TRIAGE                 [Due Tue 14 Oct] │
│▌ Approve option B: extend the in-house triage script   │
│▌ Manager · 2 h ago · ≈4 min · Includes spend           │
│▌ ★ Recommended: Extend the triage script               │
│▌ [ Read and decide › ]                                 │
└────────────────────────────────────────────────────────┘
```

A brief without spend, with quick answers (each goes through the card's confirm step, as today):

```
┌────────────────────────────────────────────────────────┐
│▌ RELEASE TIMING                    [Due today 4:00 PM] │
│▌ Approve option A: ship the release candidate today    │
│▌ Manager · 20 min ago · ≈2 min · [Blocking]            │
│▌ [★ Ship today] [Wait for Monday]   Read the brief ›   │
└────────────────────────────────────────────────────────┘
```

A plain ask from the manager's list (today's fields):

```
┌────────────────────────────────────────────────────────┐
│▌ NEWSLETTER SEND DAY                         [Due Fri] │
│▌ Pick the weekday for the newsletter                   │
│▌ Manager · yesterday · Filed without a brief           │
│▌ [★ Tuesday] [Thursday]   Details ›                    │
└────────────────────────────────────────────────────────┘
```

The bar on the left keeps today's urgency colours (blocking and overdue, soon, answered, done), always with the words beside them (COLOR.md 2). The topic is one line with an ellipsis; the headline wraps to two lines at most.

### 6.2 The modal (desktop)

A native `<dialog>` opened with `showModal()`: the browser makes the rest of the page inert, puts the dialog in the top layer, and Escape fires `cancel` [S1]. The frame is 760 px wide (at most the window less 56 px), `min(90vh, 100%)` tall, with the SlackModal look (radius 8, 900 22/30 title) but no tabs: a brief is read top to bottom. `SlackModal.svelte` stays as it is for the other modals.

```
┌────────────────────────────────────────────────────────────────────────┐
│ DECISION REQUEST · SUPPORT INBOX TRIAGE                            [×] │
│ Approver · Owner   Due Tue 14 Oct (in 3 days)   ≈4 min   v1            │
│ From the manager, 2 h ago                                              │
│                                                                        │
│ Approve option B: extend the in-house triage script                    │
│ [Includes spend]                                                       │
├────────────────────────────────────────────────────────────────────────┤
│ THE ASK                                                                │
│ Approve $2,400 of contractor time and 6 agent-days to extend the       │
│ in-house triage script. It pays back in about 3 weeks and saves an     │
│ estimated 5 staff hours a week.                                        │
│ Alternative  Buy the hosted add-on (C) for $180 a month.               │
│ Uncertainty  The saving comes from a two-week sample of 310 tickets.   │
│                                                                        │
│ WHY NOW                                                                │
│ • Tickets waiting more than a day rose from 9 to 23 a week.            │
│ • The contractor's free slot runs 20 Oct to 7 Nov; the next is in Jan. │
│                                                                        │
│ OPTIONS COMPARED                                                       │
│ ┌──────────────────┬──────────────┬────────────────────┬──────────────┐│
│ │                  │A · Keep      │B · Extend the      │C · Buy a     ││
│ │                  │manual triage │triage script       │hosted add-on ││
│ │                  │              │★ Recommended       │              ││
│ ├──────────────────┼──────────────┼────────────────────┼──────────────┤│
│ │Year-one cost     │$0            │$2,400              │$2,160        ││
│ │Ongoing cost      │5 h a week    │~1 agent-day/qtr    │$180/month    ││
│ │…                 │              │                    │              ││
│ └──────────────────┴──────────────┴────────────────────┴──────────────┘│
│ Costs are cash only. Agent-days and staff hours are not priced.        │
│                                                                        │
│ WHY THE RECOMMENDATION … ASSUMPTIONS … DOWNSIDE CASE …                 │
│ WHAT WOULD CHANGE IT · MAIN RISK AND CONTROL                           │
│ WHAT APPROVAL AUTHORIZES  (the asker's commitment; Morndo records      │
│                           your answer and doesn't enforce the limits)  │
│ IF NO DECISION BY THE DUE DATE · EVIDENCE                              │
├────────────────────────────────────────────────────────────────────────┤
│ Decision  [A · Keep manual triage] [★ B · Extend the triage script]    │
│           [C · Buy a hosted add-on]   Something else…          Close   │
└────────────────────────────────────────────────────────────────────────┘
```

- **Order** is the owner's: the ask, why now, options compared, why the recommendation (with its assumptions and downside case), what would change it, main risk and control, what approval authorizes, if no decision, evidence. Section headings are `<h3>`; the headline is the dialog's `<h2>` and its name (`aria-labelledby`).
- **The table** is drawn from the structured rows, not from markdown: `<caption>Options compared</caption>`, a `<th scope="col">` per option with its key and label, a `<th scope="row">` per factor. The recommended column has the selection tint, a star and the word "Recommended" in its header: never the tint alone (COLOR.md 1 and 2). The note sits under the table.
- **The footer stays in view** and holds the answer: one button per option in the brief's order, the recommended one primary with a star, "Something else…" (his own words, as today) and Close. Picking an option replaces the footer with today's confirm step: "Your answer: **B · Extend the triage script**. The manager gets it as your decision and acts on it. [Send answer] [Back]", with the passkey note when the step-up isn't fresh (AC7). After it goes, the footer says where it stands (Queued with the inbox's reason, Delivered, or the refusal in words, `REFUSALS`), in a `role="status"` region, and the dialog stays open until he closes it.
- **A brief restated while open** shows a bar at the top: "The manager restated this brief. [Show the new version]". An answer sent for the old version is refused as `changed` (E12) and says so.
- **A plain ask** opens the same dialog with what it has: its title as the headline, the summary, Recommended, If you don't answer, the details and the asker's message (markdown) or the screen excerpt, and its own answer controls (tap, words, Done for a time item, "Answer in the terminal" for a menu). A line under the header says "Filed without a brief" with **Ask for a brief**, which sends the asker a message ("Please restate ny-400 as a decision brief: morndo-decide template"). That is a Command in the outbox (S4 to S8), not an answer: the ask stays open.

### 6.3 The phone

The brief opens as a full-screen sheet: the same `<dialog>`, sized to the visual viewport as a conversation is (ADR-0011 decision 5), with the header padded by the status bar's inset and the footer by the home indicator's.

```
┌─────────────────────────────┐
│ ‹ Back       Support inbox… │
│ DECISION REQUEST            │
│ Due Tue 14 Oct · ≈4 min     │
│ Approve option B: extend    │
│ the in-house triage script  │
│ [Includes spend]            │
│                             │
│ THE ASK …                   │
│ OPTIONS COMPARED            │
│ Year-one cost               │
│   A · Keep manual    $0     │
│ ★ B · Extend script  $2,400 │
│   C · Hosted add-on  $2,160 │
│ Ongoing cost                │
│   A … B … C …               │
│ …                           │
├─────────────────────────────┤
│ [★ Extend the triage script]│
│ [ Other answers ]           │
└─────────────────────────────┘
```

- **The table turns into one block per factor** when the dialog's body is under 560 px wide (a container query): the factor as a small heading, then one line per option, the recommended one starred and labelled. Comparing across options is what the table is for, so the rows stay together; nothing scrolls sideways. The same rule covers the desktop at 400% zoom (WCAG 1.4.10, 320 px [S3]).
- **The footer** has the recommended option as the primary button and **Other answers**, which scrolls to the Decision section at the end: every option, then "Answer in my own words". Buttons are 48 px tall.
- **An answer** goes as catch-up's do: "Answered: Extend the triage script · Undo" for 5 seconds, then sent (C6). Offline it is refused, not queued.
- **Back closes the sheet.** Opening it pushes a history entry with `pushState('', { brief: id })` from `$app/navigation`, the shallow-routing API of the installed SvelteKit 2.70.3 [S4]; the sheet shows while `page.state.brief` is set, the browser's back gesture closes it, and the sheet's own Back calls `history.back()`. SvelteKit 3 replaces `pushState` with `goto('', { shallow: true, state })` [S4]; an open dependency update moves to 3.x, so PR 4 uses whichever is installed when it lands.
- **Links in:** `/?decision=<id>` opens catch-up with that brief's sheet, so the manager can link to a brief and a push about decisions lands next to it.
- **Catch-up and Today** use the compact card (section 6.1) with big buttons: "Read the brief" and, per Q2, the quick answers.

### 6.4 Keyboard

| Where | Key | Does |
|---|---|---|
| Panel | Tab | the card's headline (opens the brief), then its quick answers, then the next card |
| Card headline | Enter, Space | opens the brief |
| Separator | ← → | resizes the panel by 16 px; Home and End go to the limits |
| Modal | (open) | focus on the headline (`tabindex="-1"`), so a long brief starts at its top and a screen reader reads its structure (APG, large content [S2]) |
| Modal | Tab, Shift+Tab | the links, the table region when it scrolls, then the footer's buttons; the page under it is inert [S1] |
| Modal | Escape | in the confirm step: back to the options (the `cancel` event is prevented); while sending: nothing; otherwise closes |
| Modal | Enter in "Something else…" | sends, Shift+Enter is a new line (as today) |
| Modal | (close) | focus returns to the card's headline; if the card moved to another group, to it there; if it is gone, to the panel's heading (APG [S2]; done in code, since MDN doesn't promise it [S1]) |

No single-character shortcuts: a letter that answers would fire by accident and breaks WCAG 2.1.4 [S5].

### 6.5 Accessibility

- The dialog has `aria-labelledby` on the headline and no `aria-describedby`: the content is long and structured [S2]. No `tabindex` on the `<dialog>` itself [S1].
- Real headings (`h2`, then `h3` per section), a real table with a caption and scoped headers, lists as lists.
- The quick answers on a card carry `aria-describedby` pointing at its topic, so "Extend the triage script" isn't heard without its decision.
- Targets: 32 px buttons on the desktop (today's `.btn`), above WCAG 2.5.8's 24 px [S6]; 48 px on the phone.
- Status in words beside every colour: due and overdue, blocking, includes spend, recommended.
- Answer states in a `role="status"` region; refusals in `role="alert"`, as today.
- Focus ring from the brand (`--morndo-focus-ring`, COLOR.md 3). No open or close animation under `prefers-reduced-motion`.
- `e2e/contrast.ts` runs on the open modal in both themes.

### 6.6 The markdown subset

The prose fields go through a renderer of their own, `renderBriefMarkdown` in `apps/web/src/lib/markdown.ts`: `marked` with GFM (on by default in marked [S7]; checked on 2026-10-11 that marked 18.0.14's lexer gives `table` tokens for a GFM table), then DOMPurify with an allowlist: `p br strong em del code pre ul ol li blockquote a table thead tbody tr th td`. Links stay `https:` only and open in a new tab with `rel="noopener noreferrer"`, as today. marked doesn't sanitise [S7]; the agent's text is untrusted, so it is sanitised on every render even though lint already refused headings, HTML and images (DB7). Defence in depth, and the two lists are kept equal by a test.

## 7. Tests

| Layer | File | Checks |
|---|---|---|
| Domain | `packages/domain/test/brief.test.ts` | Every lint code, each from one change to the guide's valid example (a mutation table: drop the due, name two options in the headline, delete one column, add a money figure without an assumption, put a heading in "Why now", an `http:` link, a 61-character topic …), so each rule is shown to refuse; the valid example passes with no errors; money pattern table (matches and non-matches); `cardOf` for a brief and for each kind of plain Ask; `askFromBrief` fills every field an old app reads; a restated brief changes `askVersion`; E14 (open until withdrawn, overdue still answerable, expired 7 days after due). |
| Protocol | `packages/protocol/test/brief.test.ts` | `DecisionItemSchema` with and without `brief`; a malformed brief reads as `null` and the item survives; the committed JSON Schema equals the generated one. |
| Hub | `apps/hub/test/briefs.test.ts` | POST markdown and JSON (201, the id, warnings); a vague brief is 422 with the problem codes and nothing is stored; `?dry=1` stores nothing; a worker token files a draft (Q1 default), the manager forwards it; `ref` attaches to a list item and the list decides E10; an answer goes to the manager's inbox as `[tap d-1] b (…)`; E8 (a second answer refused), E12 (answer for v1 after a restate refused `changed`), E11 (a Decision on v1 doesn't answer v2); withdraw and settle; 20 open per asker; the audit rows hold no text; the `decisions` frame carries `brief`. |
| CLI | `apps/board-cli/test/decide.test.ts` | `lint` refuses the bare template (placeholders are not a brief) and passes the guide's example; exit codes 0, 1, 2, 3; one problem per line, errors first. |
| Docs | `apps/board-cli/test/decide-doc.test.ts` | The template in `docs/agents/decision-requests.md` equals `morndo-decide template`; its example lints with no errors and no warnings, `now` fixed at 2026-10-01; once the prompt blocks exist, they equal `morndo-decide prompt` (as `prompt-doc.test.ts` does for the board). |
| E2E, Chromium | `e2e/briefs.e2e.ts` (and in `npm run e2e`) | On a synthetic office, the real CLI as the manager: **negative control first:** a vague brief (no recommendation, one option without a column) exits 1 with those two codes and the panel still shows no card after the feed settles. Then a valid brief: the compact card shows topic, headline, recommended option, due and minutes; Enter on the headline opens a `dialog` named by the headline; the table has one column per option and the recommended header says "Recommended"; Escape closes and focus is back on the headline; pick, confirm, passkey (the virtual authenticator) and the manager's synthetic pane receives `[tap d-1] b (…)`; restate while open shows the bar and the old answer is refused; a plain list item shows "Filed without a brief" and Ask for a brief sends a message, leaving the ask open; at 390 × 844 the sheet opens, the table is per factor, footer buttons are at least 48 px tall, Back closes it, and Undo within 5 seconds sends nothing; contrast in both themes; at 320 px no horizontal scroll in the modal body. |

The negative control matters because a lint test that only feeds valid briefs passes with an empty `lintBrief`. The mutation table and the e2e's first check fail if lint stops refusing.

## 8. PR plan

| PR | Scope | Suits | Done when |
|---|---|---|---|
| 1 | Domain and protocol: `brief.ts`, lint, `cardOf`, `askFromBrief`, `briefMarkdown`, the wire schema and JSON Schema, E14, terms and DB1–DB10 in `docs/domain.md` | Any coding lane, test first; the rules are deterministic and fully specified here. Review by a model from another provider. | `npm test` for domain and protocol green with the mutation table; `npm run check` clean. |
| 2 | Hub and CLI: store and migration, the routes, the template adapter, the escalation source (`tracking: "hub"`), delivery through the inbox or the pane, `ref`, drafts, audit; `morndo-decide`, its prompt blocks, the guide sync test | A backend lane that knows `escalation-service.ts` (770 lines of E8–E13 handling); careful review there. | Hub, CLI and doc tests green; on a synthetic office, a brief filed by the CLI shows in `GET /api/escalations` and an answer lands in the manager's pane as a tap line. |
| 3 | Desktop: compact card, resizable panel, `BriefModal.svelte`, the subset renderer, keyboard and focus | A UI lane with Playwright and screenshots. | The desktop checks of `e2e/briefs.e2e.ts` pass; screenshots light and dark in a private QA record (not in this tree); an agent drives the real flow in Chromium once by hand. |
| 4 | Phone: the sheet, the per-factor table, the footer, history, links in, catch-up and Today cards | A UI lane with Playwright. | The phone checks pass at 390 × 844 with the visual viewport emulated; the owner's check on a real iPhone is listed as open (not verifiable on this box). |
| 5 | Rollout | The manager (operations, outside this repo). | The manager's instructions carry `morndo-decide prompt --role manager`; new decisions arrive as briefs. |

PR 1 blocks the rest; 3 and 4 can run in parallel after 2.

## 9. Not now

- Files as evidence: an agent can link, not attach. Attaching needs an agent upload route.
- Briefs in the chat bot or other channels: they get the topic, the headline and a link to `/?decision=<id>`.
- Enforcing "What approval authorizes": that would be a Mandate (ADR-0002, Proposed). Until then it is the asker's commitment (DB8), and the modal says so.
- Approvers other than the principal, and templates per kind of decision (hiring, spend, release).
- An MCP server for filing briefs (section 5.3).

## 10. Risks

| Risk | Control |
|---|---|
| Brief fatigue: every small question becomes a page. | Caps (section 4.3), `minutes` at most 30, the card readable on its own, and owner decision Q3. |
| Agents pad sections to pass lint. | Lint checks structure, not quality. The caps limit padding; the manager's review of drafts (Q1) is the quality gate; the guide says one line where one line will do. |
| False authority: "authorizes" reads as enforced. | DB8 and the note in the modal. |
| A misspelt heading drops content. | `unknown_section` refuses it (DB6). |
| A brief restated under his thumb. | E12: the answer for the old version is refused as `changed`, and the modal shows the bar. |

## 11. Sources (read 2026-10-11)

- [S1] MDN, `<dialog>`: `showModal()` makes the rest of the page inert, Escape dismisses and fires `cancel`, focus goes to the first focusable element, no `tabindex` on the dialog. https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog
- [S2] WAI-ARIA Authoring Practices, Dialog (Modal) pattern: Tab cycles inside, Escape closes, for large or structured content focus a static element at the top, return focus to the opener, omit `aria-describedby` for long content. https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
- [S3] WCAG 2.2 Understanding 1.4.10 Reflow (AA): 320 CSS px, data tables excepted but cells still reflow. https://www.w3.org/WAI/WCAG22/Understanding/reflow.html
- [S4] SvelteKit, Shallow routing: https://svelte.dev/docs/kit/shallow-routing (now documents `goto` with `shallow: true`, and `pushState` as deprecated); the installed `@sveltejs/kit` 2.70.3 (package-lock) declares `pushState(url, state)` for shallow routing (`types/index.d.ts` of 2.70.3 from unpkg); npm `latest` is 3.0.1 (`fresh npm @sveltejs/kit`).
- [S5] WCAG 2.2 Understanding 2.1.4 Character Key Shortcuts (A). https://www.w3.org/WAI/WCAG22/Understanding/character-key-shortcuts.html
- [S6] WCAG 2.2 Understanding 2.5.8 Target Size (Minimum) (AA): 24 by 24 CSS px, with the spacing exception. https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- [S7] marked, Advanced usage: `gfm` defaults to true; marked doesn't sanitise and recommends DOMPurify. https://marked.js.org/using_advanced . The table check was run against marked 18.0.14 (the locked version) from the npm registry in a scratch directory.

## 12. Owner decisions

Three, each with the default the team recommends. Everything else above is the team's call and can change in review.

| # | Question | Default (recommended) | Other options |
|---|---|---|---|
| Q1 | Who may send a brief to you? | **The manager only.** A lane's brief is a draft the manager forwards or declines, as board proposals work. You keep one filter, and a lane's claimed name never reaches your list unchecked. | Every lane files to you directly. |
| Q2 | Quick answers on the compact card? | **Yes, except for briefs with spend.** Each quick answer goes through the confirm step (desktop) or the 5-second Undo (phone). A brief with a money figure shows "Read and decide" only, so spend is never approved from a three-line card. | Modal only, for every decision; or quick answers on every card. |
| Q3 | One format for everything agents file? | **Yes: every decision filed with the new command is a full brief.** Today's plain asks keep working, and the manager is told to file briefs. | A short form for small decisions (2 minutes or less, no money): topic, headline, options, due and one paragraph of why. |
