# Backend map: what the cockpit promises, what the server has, what to build

**21 November 2026.** The design is the goal: V1 ships every function the mockups promise. Nothing here is cut;
gaps are work for the backend, ordered into phases. The Mac app is native with a Rust core from the start (it is also
what a browser inside Morndo would later need).

Inputs: the v3 go-to-market mockup (shell + `gtm.blocks` + `v2.extra` + `v3.extra`), the development mockup
(`dev.blocks`), the sharing proposal (`share.extra`), this folder's README and `topic-status-framework.md`, and the
messaging page in `../orchestration/`. Against them, the code on `main` as of 21 November: `apps/hub`, `apps/fleet`,
`apps/node-agent`, `apps/connections`, `packages/*`, `apps/web`, the ADRs, and the unmerged modules design of 13 November.

Status words: **Have** (exists and serves it), **Partial** (a base exists, it needs extending), **Missing**.

## 1. What the server is today, in one paragraph

One owner ("the principal") with paired devices. The hub (TypeScript, SQLite) observes agent CLIs that run unmodified in
tmux on nodes, relays the owner's messages to them, keeps a board of tasks, decision briefs, usage windows, memory notes
and an audit log, and pushes counts to the phone. The Manager is itself an agent session; lanes are started by it through
the console. The hub never calls a model, stores no chat text (it reads the CLIs' transcripts), has no scheduler for user
work, no people besides the owner, and no connection to the tools a go-to-market team works in (mail, CRM, ads,
publishing). Usage windows per account are read from the providers' own CLIs; spend and budgets live in the
connections CLI, not in the hub.

## 2. The six gaps that decide everything

Most of the rows in section 4 fall out of these. Each needs an owner decision (section 6) before code.

1. **People.** The design has a team: Lea and Jonas in a topic's chat, "Waits for Lea", Remind Jonas, a CEO who gets
   reports, sharing by stage. The server knows one principal. → identity, invites, roles, per-person views.
2. **The record.** History for a topic's whole life, chats with labels and corrections, threads, read-backs, "since you
   last looked" per reader. The server keeps board events and an audit log; lane events live 7 days in the fleet; chat
   text is not stored by rule (ADR-0006). → a durable record store owned by the hub.
3. **Judgement.** Sorting every message, answering from the record, choosing topic and lead before starting, writing
   briefs, status pages, summaries and forecasts. Today only agents in lanes think; the hub does not. → a way for the
   hub to ask a model for small, checked answers (proposed: headless engine runs on nodes, section 6, D3).
4. **Time.** Three briefs a day, standing lanes every Monday, reports to the CEO on Friday, decisions that expire at
   14:00, forecasts scored on a date. Nothing runs on a clock today. → a scheduler.
5. **The outside world.** Drafts in the user's mail, HubSpot, ad accounts, LinkedIn, Supabase read-only, Adobe,
   Seedance, Sentry, deploy targets; and the numbers that feed goals, funnels and guardrail meters (sign-ups, leads, cost
   per lead, bounces, meetings, rankings). Today: GitHub reads only. → connectors, both read (metrics) and write
   (actions).
6. **Control of actions.** Guardrails that hold whatever an agent tries, decision rights, daily limits, weekly spend caps,
   auto-pause and auto-revert, Undo of agent actions, outside sends held until a handover read-back matches. Today an
   agent's actions happen inside its CLI, out of the hub's reach. → every outward action goes through the hub (an action
   gateway), which can check, count, log and undo it.

## 3. Components to build

Sizes are rough estimates (S days, M one to two weeks, L several weeks, XL a month or more for one person). They exist
to order work, not to cut it.

| # | Component | Serves | Base today | Size |
|---|---|---|---|---|
| C1 | **Identity and team**: people, invites by name or email, roles, a passkey per person, sessions per person; native-app sign-in (platform passkeys, a session token kept in the Keychain instead of the web cookie and Origin check) | chats with people, waits for a person, sharing, Mac app | devices and passkeys for one principal (ADR-0004/0008) | L |
| C2 | **Work model**: workspace, module, topic (project in dev), lane as a first-class record linked to its board task and its tmux lane, lead, asked-in-their-words and where it came from, done-means steps, what it made, next report | sidebar tree, topic and lane pages, Manager table | board tasks (no project field), fleet lane registry, decision briefs' `topic`/`project` strings | L |
| C3 | **Record store**: one event log per topic and lane for its whole life (actor person/agent, kind, flags decision/sent-outside/undoable, batch with samples, the decision it depends on), per-reader seen marks, retention "nothing is dropped" | History on topic and lane, "since you last looked", brief's overnight log, Undo rows | `board_events`, `audit`, fleet `lane_events` (7 days) | M |
| C4 | **Messaging**: threads (topic group chat, lane, decision, Manager, page), stored messages from people, agents, a topic's manager and the Manager; labels with corrections; thread cards; read-back receipts; pinned decision; agents' strip; inline action buttons; attachments | the whole v3 chat | manager chat read from transcripts, delivery queue, `/api/workers/:id/send`, read marks, mutes, uploads | XL |
| C5 | **Judgement runs**: the hub sends a typed request (classify this message, answer from these records, pick topic and lead, write this summary/brief/status) as a headless run on a node and accepts only an answer that passes its schema; every run is logged with its inputs | labels, answers in chat and ⌘K, routing preview, briefs, status pages, since-summaries | none in the hub; headless runs exist inside connections (`total_cost_usd`), `engine.run` is planned in the modules design | L |
| C6 | **Scheduler**: briefs at the chosen times, standing and recurring lanes, reports to stakeholders, decision deadlines and their defaults, forecast scoring dates, periodic checks (every Friday no yes waited more than a day), "next report" times | brief cadence, Manager's own lanes, "if you do not answer by 14:00" | wait watch and reminders only (B19, B20); no user schedules | M |
| C7 | **Decisions, extended**: the brief's five sections as data (context, numbers, best and worst case as series, suggestion with its guardrail, next steps with who and when), why-it-is-yours category, reading minutes, deadline and default, approve/decline/change/undo, proposer (agent, topic manager), goal changes with effects on other topics, the chat discussion attached; the Decide queue | brief, Decide, topic Needs you, lane standing box | `decision_briefs` (ADR-0023) already has topic, due, minutes, headline, recommend, risk, ifNoAnswer, options, evidence | M |
| C8 | **Goals and status**: goal (target, unit, date), deals/rows with milestones, confidence and evidence, trajectory series (plan, actual, forecast with range), forecast records scored later, the confidence ladder learned from scores, funnel, blockers (top two), recovery plan, verdict under rules R1-R23 | topic page, brief strip, Weekly | none | L |
| C9 | **Metrics ingestion**: numbers pulled on a schedule from connected tools into time series with source and time | goal actuals, funnel, guardrail meters, decision numbers | none | L |
| C10 | **Connectors**: credentials, scopes (read only, drafts only), health; read and write adapters for mail drafts, CRM, ad accounts, publishing, warehouse/Supabase, notes, image and video models; GitHub and deploy targets for dev | Connections page, drafts, outward actions, metrics | LLM connections and vault (ADR-0018), GitHub reads | XL |
| C11 | **Action gateway, guardrails and decision rights**: every outward action is a typed request to the hub; rules per workspace and topic (limits, quotas, yes/no rules, weekly agent spend cap) checked before it runs; Who decides rules with optional daily limits; auto-pause and auto-revert triggers; breaches become blockers; agents cannot change rules | guardrail meters, Settings › Who decides, Skills page rules, decision suggestions' guardrails | board gates, node `policy.json`, connection budgets; mandates and a write proxy are specified (A1-A4) but not built | XL |
| C12 | **Action log and Undo**: each action stored with how to reverse it and until when; sent-outside marked irreversible; Undo/Redo from brief, history and receipts | Done while you slept, history Undo, receipts Undo | none | L |
| C13 | **Agents**: an agent record (name, skill, engine, topics, state, current line), one token per lane, its record (how often its work held when someone else checked it) | agent cards, crew avatars, Record line | lanes are tmux windows; one shared worker token | M |
| C14 | **Skills**: built-in skills per module, user-made skills ("Make your own" writes it and asks before the first run), the connections each needs (disabled until added), run in a lane or chat after a slash | Skills page, pins as macros, ⌘K `/` | memory notes synced as Agent Skills, `knowledge/skills` | M |
| C15 | **Usage and spend in one view**: subscriptions and own keys side by side, lanes per account, failover from a subscription at its limit to a key, spend per topic and per agent (overnight, this week, against caps) | usage card, brief spend line, topic as-of line, weekly cap guardrail | usage windows (ADR-0016/0034), pools (ADR-0029), key pools (ADR-0037), spend records in connections | M |
| C16 | **Intake**: a hub route that files an ask as a lane under a topic with a lead (preview first, then start), move to another topic, undo, split only parallel parts, attachments travel with it | ⌘K Start, chat requests, Ask for a goal, receipts | the Manager's prompt plus console `lanes start`; no hub route (planned in the modules design) | M |
| C17 | **Handover read-back**: on a fresh session, restart or new lead the agent restates the state; the hub compares with the record, holds outward actions until they match, logs the correction | lane Handover, history lines | `morndo lanes brief` after restart; nothing compares | M |
| C18 | **Shared resources**: registry (mail, CRM, ad accounts), rule (who writes, order, daily quota), turn-taking through the gateway | Manager › What lanes share | none | M |
| C19 | **Search**: one index over topics, lanes, people, decisions, skills and the record; recent places per person | ⌘K | memory FTS5 | S-M |
| C20 | **Preferences**: per person and module: pins (12), layout, chat mode, recent places; per workspace: colour theme, strength, glass, brief cadence, interrupt rule | sidebar, workspace menu, Settings | none on the server (web keeps light/dark in CSS) | S |
| C21 | **Attention**: interrupt only for what cannot wait, everything else waits for the next brief; push on the phone and the Mac | between-briefs rule | Web Push with counts (N1-N6) | S-M |
| C22 | **Drafts**: drafts written into the user's mail, never sent, linked to the lane that made them | Drafts page, What it made | none (needs C10) | M |
| C23 | **Sharing**: access per topic down to a stage, invites, status-only viewers, an org-only status link, every view, chat and history cut by the hub to what the role covers | sharing proposal | none (needs C1) | L |
| C24 | **Development module**: PR cards with their gates (tests, fresh review by another engine, QA by hand, checks), red-main details with the failing test, auto-merge of docs-only changes with Hold, release decisions with proof, staged rollout with a watch window and automatic rollback, backup before a migration, try limits | dev brief, PRs, project page, release decision | GitHub checks, proof refs (ADR-0035), merge watch, jobs | L |
| C26 | **Lane runtime**: the node agent owns each lane's terminal directly (a PTY per lane, our own screen model from a terminal parser, scrollback kept) instead of polling tmux screens; a structured channel per engine next to it (Claude Code hooks and transcript, Codex app-server, Cursor stream-json); typing only when the screen model says the input is free; any client attaches read-only or to steer. See section 8 | reliability of every lane, the Mac app's native terminal, the clean lane chat | tmux per node, `pane.capture`/`pane.frame` polling, the delivery queue with its waiting reasons, turn-end hooks | L |
| C25 | **Mac app core (Rust)**: hub client over HTTP and the live feed, types generated from the protocol package's schemas, a local mirror for instant start and offline reading, the terminal stream for a native terminal view; the Swift UI on top | the whole app | the web app's API and feed | L |

## 4. Mapping, surface by surface

### 4.1 Window, sidebar, pins, workspace menu
| Promise | Today | Status | Work |
|---|---|---|---|
| Tree: Manager, unplaced lanes, topics with lanes ordered by state, worst mark on a closed topic | runs and lanes in the feed, no topics | Partial | C2 |
| State words Stuck, Needs you, Working, Starting, Idle, Up next; "Waits for <person>" | run phases working/waiting/needs_you/ended | Partial | C2, C1 |
| Pins (12, per person and module), skill macros, pin menu | — | Missing | C20, C14 |
| Workspace name, modules, switch module | — | Missing | C2 |
| Colour theme, strength, glass per workspace | — | Missing | C20 |
| Layout, chat mode, sidebar widths kept | browser only | Missing | C20 |
| Drop a file or link on a topic | uploads exist | Partial | C16 |
| Account row: person's name | — | Missing | C1 |

### 4.2 Usage card
| Promise | Today | Status | Work |
|---|---|---|---|
| Subscriptions: windows used, reset times (Claude, Codex, Cursor) | Claude status line and `/usage`, Codex app-server, Cursor-style limits in the read model | Have | — |
| Own keys: spend against a budget | spend records and budgets in the connections CLI, not in the hub | Partial | C15 |
| Lanes per account, "standing by" | `lane_accounts` | Have | — |
| A subscription at its limit hands its lanes to a key | pools rotate within one runtime; key pools within keys; no subscription-to-key failover | Missing | C15 |
| Providers not added are listed | engines/connections list | Partial | C15 |

### 4.3 Brief
| Promise | Today | Status | Work |
|---|---|---|---|
| Written at set times (three a day by default), names the next one | — | Missing | C6, C5 |
| Lede that sums up the state | — | Missing | C5 |
| Yours to decide: count, minutes, why-yours, approve/undo | decision briefs, answers | Partial | C7 |
| Where it burns: stuck items with the deadline at risk | runs `needs_you`, board blocked | Partial | C2, C8 |
| Done while you slept, with Undo | — | Missing | C3, C12 |
| Drafts in your mail | — | Missing | C22 |
| Where each topic stands (verdict, actual of target, spend) | — | Missing | C8, C15 |
| Agent spend overnight and this week | per-run cost in connections | Partial | C15 |
| Artwork by date, pager | static assets | Have (client) | — |

### 4.4 Decide and the decision page
| Promise | Today | Status | Work |
|---|---|---|---|
| Queue of open decisions with position | escalations list | Have | — |
| Context, numbers, best and worst case series, suggestion with guardrail, next steps with who and when | brief has headline, recommend, risk, comparison, evidence, ifNoAnswer; no series, no next-steps table | Partial | C7 |
| Provenance: written by, numbers checked by the Manager at a time | filed_by, drafted_by | Partial | C7 |
| "If you do not answer by 14:00, nothing changes" | due and ifNoAnswer as text; nothing acts on the deadline | Partial | C6, C7 |
| Decline, Change something (opens the discussion), Approve, Undo | answer by option or words | Partial | C7, C4 |
| The suggestion's guardrail is enforced (move money back above €110 for 5 days) | — | Missing | C11, C9 |
| Result reported against the best case on a date | — | Missing | C6, C8 |

### 4.5 Topic page
| Promise | Today | Status | Work |
|---|---|---|---|
| Verdict, three numbers (actual, forecast, unsecured), as-of line | — | Missing | C8 |
| Trajectory: plan, actual, forecast with range; hover | — | Missing | C8, C9 |
| Deals with milestones, confidence, evidence, next | — | Missing | C8 |
| Needs you: one decision, top two blockers, "+N more" | — | Missing | C7, C8 |
| Funnel with rates against plan | — | Missing | C9, C8 |
| Guardrail meters, Held/Breached, breached first | — | Missing | C11, C9 |
| Recovery plan, fact ladder, how forecasts scored | — | Missing | C8 |
| Plan stages with crew, overnight strip, ask line | — | Missing | C2, C3 |
| Details: lanes, people and agents with their record, jobs this week | jobs mirror, lanes | Partial | C2, C13 |
| History for the topic's life: filters, batches, Undo, "you last looked here" | — | Missing | C3, C12 |
| No goal: "Ask for a goal" files a lane | — | Missing | C16, C8 |

### 4.6 Lane page
| Promise | Today | Status | Work |
|---|---|---|---|
| What you asked, in your words, with where it came from | board task title/description | Partial | C2 |
| Standing box with approve, open decision, Remind <person>, custom choices | board blocked/decision | Partial | C2, C7, C1 |
| We recommend / If it waits / Why it is yours / Checked before it goes out | brief fields partly | Partial | C7, C11 |
| Done-means checklist set by the Manager, real steps by the lead, checked by someone else | proof gate B16 (env), modules design plans Done-means | Partial | C2, modules design phase 2 |
| Who is on it, What it made | lane registry; no artifacts | Partial | C13, C2 |
| Handover with read-back, matched or corrected | — | Missing | C17 |
| Lane chat with the lead | type into a lane, transcript read-back | Partial | C4 |

### 4.7 Manager page
| Promise | Today | Status | Work |
|---|---|---|---|
| Everything in motion with next report | runs, lane watch deadlines | Partial | C2, C6 |
| What lanes share and how they take turns | — | Missing | C18 |
| Asks from every chat and where each went | manager deliveries | Partial | C4, C16 |
| Manager chat with "since its last turn" | manager chat; `lanes brief` | Partial | C4, C5 |
| Spot checks, Friday checks, standing lanes | — | Missing | C6 |

### 4.8 Drafts, Skills, Connections, Settings
| Promise | Today | Status | Work |
|---|---|---|---|
| Drafts in your mail, Open in Mail | — | Missing | C22, C10 |
| Skills with topics and tools, "Needs a key" | memory skills, static loop skills | Partial | C14 |
| Make your own skill, asks before first run | — | Missing | C14, C5 |
| Connections with scope and state, Add key | LLM connections, sign-in from the app | Partial | C10 |
| Briefs: how often, interrupt rule | — | Missing | C6, C21, C20 |
| Who decides (five rules), daily limit when handing a risky one over | — | Missing | C11 |
| Modules on, colour, glass, chat placement | — | Missing | C2, C20 |

### 4.9 Chat
| Promise | Today | Status | Work |
|---|---|---|---|
| One panel, a thread per page, the Manager reachable from any page | manager chat, worker chats | Partial | C4 |
| Topic group chat with people and agents; the Manager reads, is not in it | — | Missing | C4, C1 |
| Every message sorted with a label you can correct; corrections teach | — | Missing | C4, C5 |
| Question answered from the record | — | Missing | C5, C19 |
| Request becomes a thread (lane) with owner and read-back | manager files tasks by prompt | Partial | C16, C4, C17 |
| Goal change becomes one decision with effects on other topics | — | Missing | C7, C8, C5 |
| Since you last looked (editable), pinned decision, agents' strip | phone digest per conversation | Partial | C3, C4, C5 |
| Attachments, inline action buttons | uploads, manager `[buttons]` | Partial | C4 |
| Model picker "Auto", Claude, GPT, Gemini, Grok | engines per role, auto routing partly | Partial | C15, auto routing (ADR-0020) |

### 4.10 Command center (⌘K)
| Promise | Today | Status | Work |
|---|---|---|---|
| Find topics, lanes, people, decisions, skills | — | Missing | C19 |
| Answers from the records, with source | — | Missing | C19, C5 |
| Preview where new work goes (topic, lead), Tab for another, start | — | Missing | C16, C5 |
| Skills after a slash, attachment, scope to a topic | — | Missing | C14, C16 |
| Waiting for you, recent places | escalations | Partial | C20 |

### 4.11 Attention and phone
| Promise | Today | Status | Work |
|---|---|---|---|
| Interrupt only for what cannot wait; the rest in the next brief | push counts | Partial | C21, C6 |
| Agents' own decisions reported in the next brief with Undo | — | Missing | C11, C12 |
| Phone layout of the same pages | web app | Partial (client) | web follows the cockpit |

### 4.12 Development module
| Promise | Today | Status | Work |
|---|---|---|---|
| Projects with lanes, parked with a reason and date | board blocked with waits | Partial | C2 |
| Release decision with proof (tests, fresh review, staging run, checks, not checked) | proof refs checked on GitHub | Partial | C24, modules design (reviewer runs) |
| Red main with the failing test and its log | GitHub checks | Partial | C24 |
| Pull requests with gates, auto-merge docs-only at a time, Hold | merge watch flags; no auto-merge | Partial | C24, C11 |
| Staged rollout, watch window, automatic rollback of the user's product | Morndo's own updater does this for Morndo | Missing | C24, C10 (deploy targets) |
| Backup before a migration, try limits | — | Missing | C24, C11 |
| Lanes on your server, "3 of 8 busy" | nodes and lanes | Have | — |

### 4.13 Sharing
| Promise | Today | Status | Work |
|---|---|---|---|
| Share a topic or a stage, status-only viewers, invites, org-only status link | — | Missing | C23, C1 |
| Each person sees only their stages, agents, chat and history | — | Missing | C23, C3, C4 |

### 4.14 What the system does on its own (the 31 behaviours in the inventory)
Intake and lanes: C16, C2, C6. Briefs and reporting: C6, C5, C8, C3. Forecast scoring and agent records: C8, C13.
Decisions and guardrails: C7, C6, C11, C12. Messaging: C4, C5. Handover and shared resources: C17, C18. Accounts:
C15. Drafts: C22. Overnight work: exists (lanes on nodes). Notifications: C21. Dev: C24. Sharing: C23.

## 5. Order of work (all of it ships in V1)

The order follows dependencies. Nothing later is optional.

0. **Contract first (S-M).** Write the API for every surface as schemas in `packages/protocol` (it already uses zod),
   and a fixture hub that serves the mockups' data through those schemas. The Mac app and the backend then start the
   same week: the app is built against the fixtures, each backend component replaces a fixture when it lands. This is
   what keeps the backend from blocking the app.
1. **Foundations:** C1 identity and team, C2 work model, C3 record store, C20 preferences, C25 the Mac core against the
   existing feed and the fixtures.
2. **Talking:** C4 messaging, C5 judgement runs, C16 intake, C19 search, C13 agents.
3. **Time and decisions:** C6 scheduler, C7 decisions, C21 attention, the brief.
4. **Numbers:** C10 connectors (read side first), C9 metrics, C8 goals and status, C15 usage and spend.
5. **Control:** C11 action gateway and guardrails, C12 Undo, C17 handover read-back, C18 shared resources, C22 drafts,
   C10 write side.
6. **Team and dev:** C23 sharing, C24 development module, C14 user-made skills.

The unmerged modules design (Done gate in the server, modules as data, every CLI a client through `morndo mcp`,
per-lane tokens, mandates, scheduler, reviewer runs) overlaps C2, C6, C11, C13, C14, C16 and C24. Its phases should be
merged into this order rather than run beside it.

## 6. Decisions needed before code

Decided by the owner on 21 November: **D1 yes** (team), **D2 yes** (the hub stores history and chat text), **D3**
headless runs or lanes in a terminal, whichever fits the job, with a more reliable lane runtime of our own (C26,
section 8). D4-D7 are open.

| # | Question | Why it matters | My recommendation |
|---|---|---|---|
| D1 | Is Morndo a team product in V1? **Decided: yes.** | The design has people in chats, waits for a person, sharing. The 13 November decisions said "still one person, sharing by links". | Yes, as the design shows. It changes C1, C3, C4 and C23 from the start, so it must be settled first. |
| D2 | May the hub store chat text and the full history? **Decided: yes.** | ADR-0006 says the hub stores no message text; the design needs labels, threads, read-backs and a life-long history. | Yes, in the hub's own store, encrypted at rest, with export and delete. A new ADR replaces ADR-0006 as a whole. |
| D3 | Where do the hub's model calls run? **Decided: headless or in a terminal lane.** | Sorting, answers, briefs and status pages need a model. | Short typed requests run headless on nodes (`engine.run`); long work stays in lanes. ⌘K answers come from search first, so they stay instant. The subscription question in section 8 decides which account a headless Claude run uses. |
| D4 | Connectors: own adapters, or the agent CLIs' MCP connectors? | Guardrails, Undo, quotas and metrics only work if the hub sees every outward action. | Own adapters behind the action gateway for every write; MCP tools may read. |
| D5 | Which outside tools in V1? | Each is real work (auth, scopes, write and undo). | The ones the mockups name: one mail provider for drafts, HubSpot, Google and LinkedIn ads, LinkedIn posting, Supabase read, an image model, Seedance; for dev GitHub, Sentry and one deploy target. You confirm the list and the deploy target. |
| D6 | How does the Mac app sign in? | The web relies on a `__Host-` cookie and an Origin check. | Platform passkeys plus a session token in the Keychain, bound to the device, with the same step-up rules. |
| D7 | Protocol for the Rust core | One source of truth for web and Mac. | Schemas in `packages/protocol` → JSON Schema → generated Rust types. The tooling is checked against its official docs when the work starts. |

## 7. What exists and carries over

The fleet (nodes, tmux lanes, typed ops, delivery queue, lane events, jobs), the board with waits and the proof gate,
decision briefs, usage windows and pools, key pools and the vault, sign-in from the app, memory synced as skills, push,
the updater and its rollouts, passkey access. None of it is thrown away; the cockpit's components sit on top of it.

## 8. Lane runtime: the terminal and a clean UI together (C26)

**Direction agreed with the owner, 21 November 2026; details are worked out later.**
- Lanes stay as they are: the agent CLIs run interactively in tmux on the server (Claude Code with
  `--dangerously-skip-permissions`, on the owner's subscription), always on. Headless runs are only for the hub's small
  judgement jobs (C5), never a replacement for lanes.
- Morndo becomes a tmux client the way iTerm2 is one: it reads tmux's control mode (`tmux -CC`, a live `%output` stream
  per pane, keys sent back as commands) instead of polling screenshots (today the terminal view asks for a frame every
  80 ms, `apps/hub/src/adapters/http.ts:63`, and menus are found by a regex over captured screens,
  `packages/node-ops/src/tmux.ts:98`).
- Each lane has two views of the same stream: a clean view (conversation from the transcript and hooks; questions,
  menus and prompts turned into buttons that send the exact keys; typing only when the live screen model says the input
  is free) and a full terminal view (a real terminal engine such as libghostty in the Mac app) for taking over.
- Our own terminal server in Rust (a small long-lived process per node that holds the terminals) replaces tmux only if
  measurements show tmux itself causes failures. The clean view does not change either way.
- First proof when the work starts: stream one lane through control mode into the terminal view and compare its
  latency with today's 80 ms frames.

The analysis behind it:

Why: lanes are agent TUIs in tmux, and Morndo reaches them by reading screens (`pane.capture`) and typing keys. Most
failures are the gap between what the screen shows and what Morndo believes: the delivery queue already names them
(`menu_open`, `draft_present`, `no_input_box`, `busy`, `no_pane`, `no_session`). Before building, count how often each
happens on the fleet, so the new runtime is judged against a number.

The idea, in three layers:

1. **A structured channel per engine, where one exists.** Codex has `codex app-server`, JSON-RPC over stdio made for
   rich clients: `thread/start`, `turn/start`, `turn/steer`, `turn/interrupt`, approvals as server requests, streamed
   events (`item/agentMessage/delta`, `turn/completed`). Cursor's CLI has `--print --output-format stream-json`. Claude
   Code has hooks and its transcript for the interactive TUI, and `claude -p --output-format stream-json` (and
   `--input-format stream-json`) for headless runs. The clean lane chat in the app is drawn from these events, not
   from the screen.
2. **Our own terminal host instead of tmux.** The node agent owns one PTY per lane, feeds the output through a terminal
   parser to keep an exact screen model (cursor, input line, open menus), keeps scrollback, survives the agent's own
   restart, and types only when the model says the input is free. Clients attach read-only or to steer; the Mac app
   draws the same stream in a native terminal view. Candidates for the parser: libghostty-vt (reported 1.0 with a stable
   C ABI in November 2026, to confirm on the official site) or a Rust crate such as `alacritty_terminal`; to be chosen
   in the ADR against official docs.
3. **A cheaper first step, if wanted:** keep tmux but drive it in control mode (`tmux -C`), which streams each pane's
   output as `%output` notifications instead of polling screens. iTerm2 is built on it.

In the app this is one lane with two faces: the chat view (structured events, labels, read-backs) and, one tab away,
the live terminal of the same lane. Nobody has to open tmux to see or steer a lane.

**Open question before Claude runs headless on subscriptions.** Anthropic's Agent SDK page says: "Unless previously
approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products,
including agents built on the Claude Agent SDK." `claude -p` is documented as the Agent SDK's CLI, and `--bare` (to
become the default for `-p`) never reads the subscription login. Running the user's own interactive Claude Code in a
terminal is not that case. So until this is cleared with Anthropic, headless Claude runs use an API key, and
subscription work stays in terminal lanes. Codex and Cursor need the same check against their terms.

Sources: Claude Code headless (https://code.claude.com/docs/en/headless), Agent SDK overview
(https://code.claude.com/docs/en/agent-sdk/overview), Codex app-server (https://learn.chatgpt.com/docs/app-server),
Cursor CLI output format (https://cursor.com/docs/cli/reference/output-format), tmux control mode
(https://github.com/tmux/tmux/wiki/Control-Mode). Read 21 November 2026.
