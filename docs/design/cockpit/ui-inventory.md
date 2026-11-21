# Morndo cockpit: every function the UI promises (inventory for the backend)

Branch `docs/cockpit-design`. Read-only inventory, nothing judged, ranked or cut. Mock names and numbers are made up.

**What counts:** v3 = `shell.html` + `gtm.blocks.html` + `v2.extra.html` + `v3.extra.html` (build.py:30-34). The extras overwrite shell functions (`drawTopic`, `fillChat`, `send`, `show`, `openPinMenu`, `trajectory`), so each item below is described as it behaves in v3. Items that are only in the development module are in §22. Items that are only in the sharing variant are in §23.

**Source keys (file:line)**

| Key | File |
|---|---|
| S | docs/design/cockpit/src/shell.html |
| G | docs/design/cockpit/src/gtm.blocks.html |
| D | docs/design/cockpit/src/dev.blocks.html |
| V2 | docs/design/cockpit/src/v2.extra.html |
| V3 | docs/design/cockpit/src/v3.extra.html |
| SH | docs/design/cockpit/src/share.extra.html |
| R | docs/design/cockpit/README.md |
| F | docs/design/cockpit/topic-status-framework.md |
| MF | docs/design/orchestration/messaging-flow.html |
| MR | docs/design/orchestration/management-research.md |

**Mock stand-ins.** In each case the mock fakes something with a regex or canned text that the product has to do for real:
- Intake routing: a regex per topic picks the topic and the lead (G:1439-1444, D:533-537). The product: "the manager's intake… reads the message and the lanes that are open" (S:1873).
- Message classification: a regex (V3:94-97). The product: the topic's manager sorts every message (V3:92).
- Answers from the records: `answerFor` (V3:168-172) and `answerTo` (V3:361-376).
- Picking a lead: word overlap with agent descriptions (V3:348-359).
- Chats, drafts, histories and "since you last looked" lines are fixed strings (G:540-544, G:266-279, V3:124-126).

---

## 1. Window frame and global layout

**Data shown**
- Breadcrumb `[place, page]`, taken from each route (S:1020, S:1681-1683, G:1430-1437). The document title is `"<place> · Morndo"` (S:1683).
- Glass behind the frame: the day's artwork, pre-blurred, two layers that crossfade (S:988-989, S:1220-1223, R:121).

**User actions**
| Control | Effect | Ref |
|---|---|---|
| Sidebar toggle | Hides or shows the sidebar. Under 900 px the sidebar is a drawer instead | S:1017, S:2027 |
| Back / Forward | Moves through the browser history of pages | S:1018-1019, S:2028-2029 |
| Chat button | Opens or closes the floating chat (hidden in sidebar mode) | S:1021, S:2024, S:356-364 |
| Drag the sidebar edge | Width 224-380 px, normal 236. Double-click resets it, arrow keys move it ±16 px. The width is kept | S:1154, S:1730-1774, R:53 |
| Drag the chat-sidebar edge | Width 320-640 px, normal 380. The page always keeps ≥420 px | S:1146, S:1733, S:1739 |
| Hash routes | `#brief #decision #topic/<id> #lane/<id> #manager #skills #drafts #settings` (dev module: `#area #lane #pulls`) | S:1643-1658 |

**Live/automatic**
- The layout (sidebar width, chat width, chat mode) and the theme are restored on load. The mock keeps them in `localStorage` keys `morndo.layout` and `morndo.theme` (S:926-937, S:1728-1729).
- The frame and the sidebar never scroll and there is no rubber-band bounce. Page layout follows container size (R:50-52, S:905-921).
- After any decision, the tree, the Manager table and the open page all redraw and keep their scroll position (S:1662-1671).

## 2. Sidebar: workspace row, command field, tree, account row

**Data shown**
- Workspace row: the workspace name ("Tidewell") and the module name (S:994).
- v3 command field: "Find, ask or start…" with ⌘K. It replaces the "New lane" row (V3:315, V3:60, S:1008).
- Tree (S:1003-1010, S:1321-1350):
  - The Manager row is pinned first and labelled "Always here" (S:1006).
  - Under it, the lanes that have no topic yet (`#mgr-lanes`, S:1007, S:1336).
  - A "Topics" heading with `data-kind="Topic"` (G:2).
  - One group per topic: icon, name, state word (hidden; shown to screen readers and on hover), and a colour mark taken from the worst open lane. The mark shows on a closed group only (S:1327-1332, R:58).
  - Lane rows (`kidRow`): state dot (a spinner while Starting), title, and for screen readers "<state>. <lead> leads". A just-filed lane gets the `fresh` class (S:1313-1316).
  - Lane order: by state rank, bad > warn > new > ok > done. Done lanes are left out of the tree (S:1297, S:1327).
  - State words: Stuck, Needs you, Working, Done, Starting, Idle, Up next (S:1296). "Waits for <person>" replaces "Needs you" when someone else on the team is the one waited for (S:1310).
- Account row: an avatar, the user's name (opens Settings), the gauge (opens Usage) and the sliders (open Settings) (G:4).

**User actions**
| Control | Effect | Ref |
|---|---|---|
| Click a topic name | Opens `#topic/<id>` | S:1332 |
| Topic icon / caret | Folds the topic's lanes away or out | S:1332, S:2008-2009, S:1791-1794 |
| Click a lane | Opens `#lane/<id>` | S:1315 |
| Click the Manager | Opens `#manager` | S:1006 |
| Right-click empty sidebar space | Opens the workspace menu at the pointer | S:1283-1287 |
| Right-click a pin, topic or project | Opens the pin menu (§5) | S:1274-1281 |
| v3: right-click a topic or lane | The menu also has "Start something here…" (§18) | V3:504-528 |
| v3: drop a file or link on a topic | Opens the command center with it attached (§6) | V3:530-548 |
| Account name / sliders | Open Settings | G:4 |
| Gauge | Opens or closes the Usage card | G:4, S:1986 |

**Live/automatic**
- Opening a page unfolds its topic in the tree. The current page is marked (S:1684-1686, S:1659-1661).
- Topics with `open:true` start unfolded (S:1324, G:372).
- No destructive controls appear on hover. Removing something is only in the context menu (R:61).

## 3. Workspace menu, modules, themes, glass

**Data shown:** the workspace name and the current colour name; the modules with a check on the current one; 8 swatches; Strength and Glass sliders with a default point under each; a link to All settings (S:1160-1171).

**User actions**
| Control | Effect | Ref |
|---|---|---|
| Workspace row | Opens or closes the menu | S:1989 |
| Module link (Go-to-market / Development) | Switches module; the current one links back to the brief and reads "You are here" | S:1162-1165, S:1237-1243 |
| Swatch (Ink, Ember, Sand, Moss, Tide, Sky, Iris, Rose) | Sets the workspace theme | S:1167, S:1990 |
| Strength slider 0-100 (default 55) | Sets colour strength. Disabled for Ink. Snaps to the default within ±2 | S:1168, S:1253, S:1262-1267 |
| Strength default point | Resets to 55 | S:2031 |
| Glass slider 0-100 | Sets glass. 0 turns it off. Defaults: 25 for Ink, 50 for colours. Snaps to "follow the theme's default" | S:1169, S:1244-1266 |
| Glass default point | Back to the theme's default | S:2030 |
| All settings | Opens `#settings` | S:1170 |
| Esc / click outside | Closes the menu | S:2049, S:1982 |

**Live/automatic**
- The colour belongs to the workspace, so two workspaces never look alike (S:1099, R:119).
- Glass turns solid under reduced transparency or when `backdrop-filter` is missing (R:122).
- Contrast holds by construction across themes, strengths and artworks (R:123).
- The frame's glass follows the brief's artwork when it changes (S:1220-1223).

## 4. Usage popover (account gauge)

**Data shown:** `USAGE {asOf, subs[], keys[], missing[]}` (S:1881-1900).

| Field | Shape / example |
|---|---|
| asOf | "09:20". The header reads "Only accounts you added · 09:20" (S:1908) |
| subs[] | `{name, lanes, note?, meters:[{what, used 0..1, val, note?}]}`. Examples: Claude Max, 6 lanes, 5 hours 86% "resets 14:20", Week 41% "resets Mon", note "At its limit, lanes move to your Anthropic key". ChatGPT Pro · Codex. Cursor Pro "Requests this month 312 of 500, resets 1 Dec" |
| keys[] | Same shape, spend against a budget. Anthropic API: 0 lanes ("standing by"), "€96 of €150", "Takes over when Claude Max is at its limit". OpenAI API: 4 lanes, "€212 of €300", "GPT agents and GPT Image" |
| missing[] | Gemini, Grok, Seedance: "Not added, so not shown" |
| Derived | Each account shows its lane count, or "standing by" at 0 (S:1907). A meter is "Close" at ≥80% and "Limit reached" at ≥100%, always with the word (S:1904-1905, R:62) |

Subscriptions are labelled "flat price · limits reset on their own". API keys are labelled "your own keys · billed by use" (S:1909-1910).

**User actions:** X, Esc or a click outside closes it. "Manage accounts" opens `#skills`, the Connections page (S:1911, S:1985-1987, S:2050).

**Live/automatic**
- The system knows which lanes run on which account.
- When a subscription is at its limit, its lanes fail over to the API key, and both accounts say so (S:1884, S:1894, R:62).
- Each window shows when it resets.
- The card is real glass and turns solid when Glass is 0 (R:122).

## 5. Pins, pin popover, pin menu (right-click, long press, keyboard)

**Data shown**
- Pin grid: at most 12 (4×3). Tiles: icon and label; Decide carries a badge with the open-decision count (S:996-1001, S:1806-1849).
- PINNABLE items `{id, kind, label, name?, note?, icon, href | run, badge?, pinned?}` (G:353-367):
  - Pages: Brief, Decide (badge), Drafts, Skills.
  - Topics: Partners, Content, Outbound, Paid, SEO, Research.
  - Skills as one-click macros: Weekly `/weekly-summary`, Post `/linkedin-post`, Visuals `/brand-visual`, Ads `/ad-variants`, Profile `/icp-refresh`.
- v2 default: only the page pins and Weekly are pinned; topic pins are off (V2:151-153).
- Pin popover "Pin to the top": "<n> of 12 places free" or "All 12 places are used". The rest is listed by kind with a note, or "Everything that can be pinned is pinned", plus a tip (S:1175-1179, S:1823-1845).
- Pins are stored per user and per module. Mock key: `morndo.pins2.<module>` (S:1800-1804, S:1848).

**User actions**
| Control | Effect | Ref |
|---|---|---|
| "+ Pin" tile | Opens the popover under the grid | S:1000, S:1992-1998 |
| Item in the popover | Pins it. The popover closes when the grid is full | S:1999 |
| Page pin | Navigates | S:1818 |
| Skill macro pin | Opens the palette with `"<skill> "` filled in ("Run <skill>") | S:1819, S:2006 |
| Topic pin without href | Unfolds the topic in the tree and scrolls to it | S:1820, S:2007 |
| Right-click, menu key or Shift+F10 on a pin/topic/project | Menu: "Unpin X", "Pin X to the top", or a disabled "All 12 places are used" | S:1852-1862, S:2041-2046 |
| Long press 550 ms (touch) | Opens the same menu; the tap that ends it does nothing | S:1864-1871 |
| v3: same menu on a topic | Adds "Start something here…" | V3:506-513 |
| Esc | Closes the menu or popover | S:2047-2048 |

## 6. Drag and drop

| Gesture | Effect | Ref |
|---|---|---|
| v3: drag a file or link over a topic in the tree | The group is highlighted as a drop target | V3:532-539, V3:85 |
| v3: drop | Opens the command center in that topic, with the file name (or the link, scheme stripped, ≤60 chars) attached and the placeholder "What should happen with this?" | V3:540-548, V3:436-443 |
| Sharing variant: drag a teammate's face onto a stage | Hands the stage over (§23) | SH:313-321 |

Implied: an upload or link-ingest store, so the attachment travels with the new lane ("(with <file>)" is added to its text) (V3:462-464).

## 7. Brief (home)

**Data shown**
- Date and time ("16 Nov 2026", "07:15 AM") in a mini date and side rails (S:1029-1036). Masthead "The Monday Brief" (S:1033).
- Hero artwork: one of 14, picked by day of year. Credit "<title>" and "Generated for Morndo, in the manner of <manner>". A pager shows "n / 14". `heroes.json` holds `{file, title, manner, alt, pos?}` (S:1211-1230, S:1043, src/heroes.json).
- Lede: a one-sentence summary ("Four decisions need you and one thing is stuck. Everything else moved on its own while you slept.") (G:6).
- Cadence line: "Next brief at 13:00. Until then you hear only about what cannot wait." (S:1041).
- v2 spend line: "Agents spent €21 overnight · €117 of €220 this week" (the sum of per-topic spend and caps) (V2:43-51).
- v2 strip "Where each topic stands", worst first (V2:53-69). Each row: dot, topic name, verdict word, "<actual> of <target> <unit>" or "No goal set", and "€<spend> this week". Sort order is bad, warn, ok, idle (V2:54-63).
- Card **Yours to decide** (G:9-53):
  - Header: "N open · about M minutes" (the sum of each decision's reading minutes `data-min`), and a count emblem that turns into a check when everything is decided: "All decided. Nothing waits for you." (S:1780-1788).
  - Decision item `{id, topic, due ("Due today, 14:00"), why-yours ("Yours: over €500" / "in your name" / "a public claim" / "binding terms"), title, one-line context, minutes, done-note}`.
  - Examples: d1 Paid €1,200 shift; d2 Outbound sequence B; d3 Content Fenwick story; d4 Partnerships Halden offer (G:16-51).
- Card **Where it burns** (G:55-71): stuck items `{topic, "Stuck since 09:12", deadline ("Post goes out today at 16:00"), title, detail}` and a link "Go to Content".
- Card **Done while you slept** (G:73-86): "Decided by agents inside your rules, since 18:00", count 5. Each log row `{topic link, what, time}` has Undo.
- Card **When you are done** (G:88-103): "Your summaries are already written": 4 drafts in your mail, "Nothing is sent until you send it", link Open drafts.
- Composer (shell; hidden in v3, where the chat is the only place to write): "Tell Morndo what to do", Add files or links, model "Auto", Send (S:1050-1055, V3:45-47).

**User actions**
| Control | Effect | Ref |
|---|---|---|
| Artwork ◀ ▶ | Previous or next artwork, with a fade; the glass follows | S:1034, S:1991 |
| Approve (decision) | The decision is done; its note reads e.g. "Approved. The Paid agent starts now." Counts, the stamp, the tree and the pages update | G:22-23, S:2012 |
| Undo (in the done note) | Reopens the decision | S:2013 |
| Open brief / Open lane | Opens `#decision` or the lane | G:22, G:31 |
| Undo on a "Done while you slept" row | Reverts that agent action; the button becomes Redo | G:80-84, S:2021 |
| Go to Content | Opens the topic | G:68 |
| Open drafts | Opens `#drafts` | G:100 |
| Strip row (v2) | Opens the topic | V2:63 |
| Composer Send / Enter (shell) | Files the text as a lane (§16) | S:2011, S:2038 |
| Phone (v2) | Decisions first, then the strip; the artwork shrinks to a band; the composer is one row | V2:13-15, V2:28-35 |

**Live/automatic**
- Briefs are written at set times, three a day by default (S:1080, R:82).
- The lede summarises the state.
- Overnight actions taken by agents inside the rules are listed with Undo (G:76).
- Drafts are pre-written into the mail.
- The decision count and minutes are computed.
- Agent spend overnight and for the week is computed (V2:51).

## 8. Decide queue and the decision page (`#decision`)

**Data shown** (d1, G:107-209)
- v2 queue: every decision from the brief, the current one highlighted and done ones struck through, plus "1 of 4 · N open" (V2:104-114, V2:17-22).
- Meta: topic chip, due time with a dot, "2 min to read", position (G:112).
- Provenance: "Part of the lane Search budget shift · written by Paid buyer · numbers checked by the Manager at 07:05" (G:114).
- 1 Context (prose) (G:117-120).
- 2 Numbers: stat boxes `{label, value, sub}` (cost per lead per channel, call rate per channel, calls a week) (G:122-130).
- 3 Opportunity and risk: two charts. "the dream output" (best case, the condition it rests on, a projection over 4 weeks) and "the worst case" (with when the change is undone). Each has a legend and an aria text alternative (G:132-162).
- 4 Suggestion, with a guardrail sentence: "if a Search lead costs more than €110 for 5 days in a row, the Paid agent moves the money back and tells you. The most this can cost is about 2 sales calls." (G:164-170).
- 5 Next steps table `{step, who (agent / person / Manager), by when}`, including "Report the result against the dream output, Manager, Mon 7 Dec" (G:172-186).
- Decide bar: "If you do not answer by 14:00, nothing changes." (G:188-195). It stays clear of the floating chat (S:346-352).
- Decision chat: "Reading this decision and its numbers". Suggestions: "Make it a 2-week test", "Show the 14-day numbers" (G:199-207).

**User actions**
| Control | Effect | Ref |
|---|---|---|
| Queue chip | Opens that decision (d1 = the brief page, the others their lanes) | V2:106-110 |
| Decline | Back to the brief. Implied: the decision is recorded as declined | G:191 |
| Change something | v2: opens the decision's chat to ask for a change | G:192, V2:101-102 |
| Approve the shift | Approves d1, back to the brief | G:193, S:2014 |
| Chat suggestions | Ask for a variant (2-week test) or for evidence | G:206 |

**Live/automatic**
- Agents write the brief; the Manager checks the numbers.
- An unanswered decision expires at its deadline and the default is "nothing changes".
- The guardrail auto-reverts the spend.
- The result is reported against the dream output on a date.
- The open count is shared with the badge (V2:104).

## 9. Topic page (`#topic/<id>`), drawn from records

### 9a. Goal glance (topics with a dated goal; topic-status framework F:40-52)
**Data shown** (`goalGlance`, S:1506-1570)
- Eyebrow: "<topic> · <when> · <asOf>". Examples of when: "Week 5 of 15", "3 days to the webinar". asOf: "updated 07:45, forecast unchanged since yesterday"; v2 adds "· agents €38 of €60 this week" (S:1513, V2:48).
- Verdict: a health dot and word ("Behind plan", "At risk", "Ahead of plan", "Over cost", "Too early to tell"), with an action phrase ("Action needed", "Your call by 16:00", "Decide by 14:00", "Nothing needed today") (S:1514).
- Three numbers (R1: actuals and forecasts never share a number):
  - `[signed/target]`, `[likely (forecast)]`, `[still unsecured = target − signed − likely]`.
  - Labels can be overridden (`labels`); the numbers can be overridden (`nums`, e.g. SEO `[0/3, "–", 3]`).
  - By default, likely = the count of deals whose conf is "Likely" (S:1508-1519).
- Trajectory chart "Forecast vs goal" or "Progress vs plan" (S:1461-1486). The data `{start, days, now, goal, step, unit, key, ticks[[day,label]], plan[[d,v]], actual[[d,v]], expected?[[d,v]], low?, high?, noForecast?}` is drawn as step lines:
  - plan dashed, actual solid, forecast with its band, a today line and dot;
  - right-hand labels "Plan N", "Forecast N, range lo to hi", or "No forecast yet" / "First reading 30 Nov";
  - a legend, a hidden text table, and a hover that shows a day's plan, actual, or forecast with its range (S:1488-1502).
  - v2: on narrow pages it collapses to one line "Forecast X by <date>, range a to b · plan N" (V2:143-149).
  - One line of insight (S:1520).
- Deals / rows: one per target slot `{name, conf, at (milestone index), stage, short, href (lane), evidence, next?, close?, val?, alt?{d, …}}`. A milestone track comes from `milestones[]` ("Replied → Call held → Qualified → Offer sent → Signed"), or a value when the topic has none (Paid: "40 leads"). The confidence word is in neutral grey (likely, possible, early, done, n). The section title and subtitle can be overridden (`rows`) (S:1521-1531).
- `alt` applies once its decision is approved: the deal shows its new stage, short and next (S:1453).
- Needs you (the one card):
  - The decision row `{title, sub (due · why it cannot wait), done}` with the lane's approve label and a "Why" (or "Details") link to the lane.
  - Undo after approval.
  - "Nothing needs you" plus a calm sub when there is no decision (S:1532-1542).
  - Team blockers: the count of all, the top two `{st, short, who, what?, why?, href}`, and "+N more", or "None. Everything else is on schedule." (S:1543-1546, R9).
- Funnel strip `{title?, since, steps[{n, what, d (change), rate ("21% · plan 15%"), st:"warn" if below plan}]}`. Bar width is the step's share of the largest step (S:1547-1550).
- Guardrails `{sub, items[{what, val, limit, p? (reading/limit)}]}` (S:1551-1563).
  - A meter runs to 125% of the limit with the limit marked. Words: "close to the limit" (≥0.9), "at the limit" (=1), "over the limit" (>1). Breached items sort first; the header says "N breached" or "all held".
  - A yes/no rule (no p) shows Held or Breached.
  - v2 adds "Agents this week €v / cap €c, then they pause and ask" to every goal topic (V2:49).
- Recovery plan, closed (S:1564-1568). Title "Recovery plan", "N steps to reach T, and what each forecast rests on", or "What the forecast rests on" when there is no gap. Inside:
  - `gap{says, steps[]}`;
  - "What each forecast rests on": per deal, its stage, evidence and next;
  - `out` (what is outside the goal);
  - "How a forecast is set": the `ladder[[word, fact]]`;
  - `calib` (how forecasts have scored, e.g. "No forecast can be scored yet. The first is scored on 18 December…", "Last webinar was forecast at 240… it got 226") (R21).

**User actions:** approve or undo the focus decision (S:1538-1539); open "Why" on the lane (S:1541); open a deal's lane (S:1528); open a blocker or "+N more" (S:1545-1546); hover the chart (S:1488); open or close the recovery plan (the open state is kept) (S:1565, S:1673).

### 9b. Glance without a goal, or the shell stage view
**Data shown**
- KPI tiles from `numbers` or the first three `facts` (`[value, (of), label]`) (S:1576-1578).
- The crew of avatars: a person is round, an agent square, with a state dot and a tooltip "<name> · <word> · <what>" (S:1580, S:1372).
- A health dot and word with `when` (S:1593).
- Plan stages `[name, st (done/now/wait/next), pct, sub, rows[], alt?]`. Each stage is a bar plus its crew. A row is `[av, who, kind p/a, st, text, when, pct, href, alt?]`, and an approved decision swaps in what happens instead (S:1365-1374, S:1420-1436, G:379-405).
- "Overnight" strip: `night[[n, what]]`, e.g. "+32 brands" (S:1585, G:406).
- Ask line: the focus lane's one waiting item, with its button and Details. A lane waiting on someone else is not shown here (S:1438-1449).
- "No goal set" with what is missing, and the button "Ask for a goal" (S:1598, G:972).

**User actions:** click a stage to open its tray (who does what in it, now and next, each row linking to its lane) (S:2016, S:1427-1434); Approve or Undo, or the lane's own buttons, on the ask line; "Ask for a goal" files the lane "Propose a goal for <topic> with a measure and a date" (S:2032).

### 9c. Details (closed; the summary reads "N lanes · P people, A agents")
**Data shown** (S:1599-1607)
- Meta, for example "Asked by Tom Ahrens, CEO · You own it · Next report to Tom Fri 08:00" (G:373).
- Intro (what the topic is for).
- The plan (in the goal view the stage plan moves here) (S:1588, R:71).
- Lanes: open then done. Each row has its state sign, title, "<lead> leads · next report <when>" or "closed <date>", the state word and Open (S:1581-1584, S:1602-1604).
- People and agents cards `[av, name, st, word, text, cmd (skill), engine/role, kind, record?]`. "Record" says how often the agent's work held when someone else checked it (S:1317-1319, R:86, F:117).
- Jobs this week `[job, agent, st, due, lane?]` (S:1606, G:642-649).

### 9d. History (closed; on the topic, and on each lane filtered to that lane)
**Data shown** (S:1377-1418)
- `history {seen, shown (days shown at first), since (end text), days:[[dayLabel, rows[]]]}`.
- A row is `[time, av, who, kind p/a, text, laneId, flags (d decision, o sent outside, u undoable), n (batch count), sub[] (sample items), decisionId (row appears only once that decision is approved)]`. The marker `"seen"` is where you last looked.
- Summary: "N new since <seen>" or "Nothing new since …". Marker line: "You last looked here, <seen>".
- Icons: Sent outside, A decision. A batch count opens a few items plus "and N more in the lane".
- End: "Earlier days", or "That is everything since the topic began… Nothing is dropped."

**User actions**
| Control | Effect | Ref |
|---|---|---|
| Filter All / People / Agents / Decisions / Sent outside | Filters the rows | S:1380, S:2017 |
| Count button | Opens the sample items | S:1396, S:2018 |
| Undo / Redo on a `u` row | Reverts that action | S:1398, S:2019 |
| Undo on a decision row | Reopens the decision | S:1397 |
| Open | Opens the lane where it happened | S:1399 |
| Earlier days | Loads the full history | S:1414, S:2020 |

Something already sent outside cannot be undone: `o` rows have no Undo (R:75).

**Live/automatic**
- The history is kept for the topic's whole life, in its own storage (the fleet's 7 days are not enough) (R:76).
- It records the last visit per reader (F:137).
- It shows only what the viewer's sharing role covers (R:76).
- Read-back corrections appear as lines (G:499, R:85).
- Manager spot checks appear as lines (G:493).

### 9e. Topic chat (v3 group chat), see §15b.

### 9f. Per-topic records in the GTM mock
| Topic | when / health | Goal (target, signed, likely; unit) | Focus lane / decision | Guardrails (p) | Notable | Ref |
|---|---|---|---|---|---|---|
| Partnerships | Week 5 of 15 · Behind plan / Action needed | 3, 0, 1; partners by 31 Jan | halden-offer / d4 | Bounces 0.3, Asked to stop 0, Sent unchecked (yes/no), Terms (yes/no) | Plan with 6 stages; night strip; 3 blockers; recovery 3 steps; out: Kestrel; calib not scorable before 18 Dec; 9 agents/people with records | G:371-545 |
| Content | 3 days to the webinar · At risk / Your call by 16:00 | 300, 212, 55; sign-ups | webinar (stuck) | Off-brand 0, Newsletter sends p=1, Unsourced claims 0 | Jobs table; stuck promo choices (v2) | G:546-655 |
| Outbound | Week 4 of 8 · Ahead of plan | 30, 11, 10; meetings | sequence-b / d2 | Bounces 0.45, Asked to stop 0.56, Sends a day p=1, Spam 0 | Calib "Sequence A forecast 8, booked 9"; out: 3 in January | G:656-770 |
| Paid | Week 7 of 13 · Over cost / Decide by 14:00 | 450, 214, 216; leads at ≤€100 | search-budget / d1 | CPL p=1.14 (breached), Weekly spend 0.91, Changes >€500 (yes/no), Customer data in ads (yes/no) | Rows show a value (cost per lead) instead of milestones; ladder Forecast/Range | G:771-877 |
| SEO | Week 3 of 9 · Too early to tell | 3 pages in the top 10, no forecast until 30 Nov | comparison-pages, no decision ("Nothing needs you" + calm sub) | Unsourced claims, Live without outline, Bought links | Funnel titled "Signals"; restSub | G:878-968 |
| Research | (no goal) | noGoal text | none | none | facts only; "Ask for a goal" | G:969-996 |

v2 per-topic agent spend: `SPEND {partnerships 38/60, content 36/40, outbound 17/40, paid 9/30, seo 14/30, research 3/20}` (V2:43).

## 10. Lane page (`#lane/<id>`), drawn from records

**Data shown** (`drawLane`, S:1613-1640)
- Header: topic chip (or "With the Manager"), state sign and word ("Working" once approved), "<lead> leads", opened date, title (S:1631).
- 1 What you asked: the ask in the asker's words, plus `askedMeta` (who asked whom, when; where the Manager filed it; who leads; in v3, which chat it came from) (S:1632, V3:120-121, V3:187).
- 2 Where it stands:
  - The `standing` box: "It is stuck." / "It waits for you." / "It waits for Lea." / "It is working." / "You approved it." with the status sentence or `after`, and actions: Approve (`approve` label) and "Open the decision" (`decisionHref`), Undo, or custom `acts` (Remind Lea, Remind Jonas, Post with the 4 that pass, Allow one more round) (S:1353-1363).
  - Reasoning list: "We recommend" (`rec`), "If it waits" (`delay`), "Why it is yours" (`yours`), "Checked before it goes out" (`checks[]`) (S:1623).
  - `extra` (e.g. a pass/fail grid of 6 thumbnails with the failure reason "Logo unclear") (G:1147-1154).
  - Done-means checklist `steps[[ok|now|todo, text, who · when]]`. On approval the "now" step turns ok and the next todo becomes now (S:1616-1621).
  - Done note, default: "Done means all N. The Manager set them when it opened the lane." (S:1633).
- 3 Who is on it: agent and person cards (S:1634).
- 4 What it made: `made[[icon (file/mail/image/decide), what, more, href?]]` with Open (S:1635).
- Handover, closed `{when, match, why, state, open, risk, ifso, restated, fixed?}`. The summary reads "the read-back matched the records" or "…missed something and was corrected" (S:1626-1628, G:1073-1076, G:1094-1098).
- History filtered to this lane (S:1637).
- Lane chat: "You, the Manager and this lane's agents. Nothing else lives here." Placeholder "Message this lane" (S:1639).

**Lane record fields (complete):** `id, topic|null, title, state (new/ok/warn/bad/done), lead, waits?, opened, closed?, next, afterNext?, decision?, decisionHref?, short?, ask?, shortAfter?, rec?, yours?, checks?, delay?, approve?, after?, asked, askedMeta, status, acts?, extra?, steps[], doneNote?, agents[], made[], handover?, chat, fresh?` (G:998-1428, S:1950-1959).

**Lanes in the mock**
| id | topic | state / lead | special | ref |
|---|---|---|---|---|
| partner-strategy | partnerships | done / You | goal agreed with the CEO | G:999-1014 |
| partner-stack | partnerships | done / Jonas | tool choice; "no email leaves without a person's OK" | G:1015-1030 |
| brand-list | partnerships | ok / Brand scout | batches checked by Lea | G:1031-1045 |
| contact-data | partnerships | ok / Contact finder | emails checked | G:1046-1060 |
| outreach-wave-1 | partnerships | ok / Sender | handover matched | G:1061-1079 |
| outreach-wave-2 | partnerships | warn, waits Lea / Sender | Remind Lea; handover corrected; v3 thread origin | G:1080-1102 |
| partner-calls | partnerships | ok / You | brief before, notes after each call | G:1103-1119 |
| halden-offer | partnerships | warn / Jonas, d4 | rec, yours, checks, delay | G:1120-1143 |
| webinar | content | bad / Visuals | thumbs; two choices | G:1144-1173 |
| fenwick | content | warn / Writer, d3 | yours: public claim | G:1174-1197 |
| recap | content | ok / Writer | "reaches you only if it quotes a customer by name" | G:1198-1215 |
| sequence-b | outbound | warn / Sender, d2 | auto-pause at 4% bounces | G:1216-1241 |
| sequence-a | outbound | done / Sender | closed by the Manager after a check by someone else | G:1242-1260 |
| search-budget | paid | warn / Paid buyer, d1, decisionHref #decision | 5-step done-means | G:1261-1287 |
| click-floor | paid | done / Paid buyer | standing rule; opened by the Manager each Monday; undo from the brief until tonight | G:1288-1302 |
| comparison-pages | seo | ok / SEO writer | | G:1303-1321 |
| customer-profile | research | done / Researcher | started from the pinned macro; customer data never left Supabase | G:1322-1336 |
| webinar-reminders | content | ok / Publisher | | G:1337-1351 |
| reply-handling | outbound | warn, waits Jonas / Replies | Remind Jonas; the Manager checks every Friday that no yes waited >1 day | G:1352-1368 |
| logistics-round-2 | outbound | ok / Prospector | opened by the Manager on its own, from the plan | G:1369-1383 |
| webinar-campaign | paid | ok / Paid buyer | its own budget | G:1384-1397 |
| keyword-map | seo | done / Checker | | G:1398-1412 |
| competitor-watch | research | done / Researcher | standing ask, monthly (second Monday) | G:1413-1427 |

**User actions:** Approve (custom label) or Undo; Open the decision; Remind <person>; the lane's custom choice buttons; Open a made item; open or close the Handover; history actions; write in the lane chat (v3: the lead answers "Got it. I add it to this lane and tell you here when it is done.") (V3:288-291).

**Live/automatic**
- The Manager sets done-means when it opens a lane; the lead replaces the first steps with the real ones before starting (S:1956).
- Done is checked by someone other than the lead (S:1955, MR:24).
- Before anything goes outside, the lane lists the checks it passed (R:84).
- Handover read-back: the hub compares it with the record, and until they match the lane sends nothing outside. The correction is logged (R:85, MR:19).

## 11. Manager page (`#manager`)

**Data shown**
- Intro: chief of staff. It turns each ask into a lane under the right topic with a lead, splits only parallel parts, and comes back only for decisions (G:286).
- "Everything in motion": every open lane, most urgent first. Columns: Lane, Topic (or "Manager"), Lead, State (sign + word), Next report (`afterNext` once decided). Summary: "N lanes in T topics · W wait for you", or "none waits for you"; lanes that wait on a teammate are not counted (S:1338-1348, G:288-296).
- "What lanes share": shared resources `{icon, name, rule, count of lanes}`: Your mail (wave 1 first, 40 sends a day shared), HubSpot (one writer at a time per brand), the ad accounts (only Paid buyer changes them, Analyst reads) (G:297-304, R:87).
- v3 "Asks from every chat": `{quote, when · which chat · where it went (topic/thread/lane · owner)}` with Open. New asks from topic chats are prepended (V3:218-228). (Shell title: "What you told it last", G:305-313.)
- Manager chat (v3): opens with "Since its last turn · from the topics' records" (per-topic lines, and whether goal or priority changes wait for you), then the Q&A. Suggestions: "Show what waits for me", "What is stuck, and why?" (V3:229-231, G:321-328).
- The composer on the page is hidden in v3 (V3:47).

**User actions:** open a lane or topic from the table; Open an ask's destination; write to the Manager (files a lane, §15c).

**Live/automatic**
- The Manager reads every topic's record rather than being told (MF:217).
- It coordinates shared resources so lanes take turns through the hub (MR:21).
- It spot-checks finished work at random (MR:21, G:493).
- It approves cross-topic changes with the owner (MF:186).

## 12. Drafts (`#drafts`)

**Data shown:** "Morndo wrote these from this morning's work. They sit in your mail as drafts. Nothing is sent until you send it." (G:270). Each draft `{to (team / board / a customer / a guest), written time, skill used?, subject, body preview}` (G:272-277). Breadcrumb "4 waiting in your mail" (G:1436).

**User actions:** "Open in Mail" on each draft (G:273-276).

**Live/automatic:** drafts are generated into the user's mail provider and never sent by Morndo (G:246, "Writes drafts, never sends"). They are linked from lanes' "What it made" (G:1141, 1193, 1349, 1366).

## 13. Skills and setup (`#skills`)

**Data shown**
- Skills, "9 built in · type / in any chat to use one". Each card `{/name, what it does, topic(s) · tools}`, or "Needs a <X> key" when a connection is missing (G:223-235). GTM skills: /icp-refresh, /linkedin-post, /brand-visual, /carousel, /product-clip (needs Seedance), /outbound-sequence, /ad-variants, /weekly-summary, /decision-brief.
- Agent cards elsewhere also reference /find-brands, /find-contacts, /call-brief, /call-notes, /schedule-post, /reply-triage, /seo-page, /fact-check, /market-map, /customer-story (G:532-537, 640, 756, 955-956, 1011, 1190).
- Connections, "5 of 6 connected": `{name, purpose/scope, state Connected | Add key}`. OpenAI, Adobe, Supabase ("read only"), Obsidian ("Memory and notes"), Mail ("Writes drafts, never sends"), Seedance (Add key) (G:239-249).
- Guardrails in the shell (v2 replaces this list with "What agents may do on their own is set in one place" and a link to Settings › Who decides) (G:250-259, V2:117-118). Listed for completeness, as switches: Publishing "ask before anything goes public"; Spend "ask above €500 per change"; Outbound "60 emails a day, pause at 4% bounces"; Visuals "3 feedback rounds, then stop and ask"; Customer data "never sent to image or video models". "Agents cannot change them. You can."

**User actions:** Run a skill (starts it, presumably via the palette or a new lane) (G:225-233); "Make your own" ("Say what you want in plain words. Morndo writes the skill and asks before the first run.") (G:234); Add key (G:247); guardrail switches (shell) (G:253-257, S:2034); Settings › Who decides link (v2).

**Live/automatic:** skills run inside lanes and chats ("type / in any chat"). Agents are bound to skills and engines (cards show `cmd · engine`). A missing key disables a skill.

## 14. Settings (`#settings`)

**Data shown and controls** (S:1063-1127)
| Section | Control | Options / default | Implied effect | Ref |
|---|---|---|---|---|
| Nav | Workspace · Connections · Guardrails | the last two link to #skills | | S:1067 |
| Modules | Module cards "2 on" | Go-to-market, Development ("Open" / "You are here") | each module brings its own topics or projects, decisions and skills | S:1069-1075 |
| Briefs › How often | Once / Twice / **3 times** | 3 | sets the brief schedule | S:1078-1081 |
| Briefs › Between briefs | Switch "Interrupt only for what cannot wait" | on | notification policy | S:1082-1085 |
| Who decides › It goes out in your name | **You** / The agent | You | decision-rights rule | S:1090 |
| › It is hard to undo | **You** / The agent | You | | S:1091 |
| › It rests on what only you know | **You** / The agent | You | | S:1092 |
| › It stays inside the guardrails and can be undone | You / **The agent** | The agent | | S:1093 |
| › v2: It spends more than a topic's weekly cap on agents | **You** / The agent | You | agents pause at the cap and ask | V2:119-124 |
| v2 limit confirm | Choosing "The agent" on a risky row asks for a daily limit (5 / **20** / 60), then Allow or Cancel. The row then reads "· agents, up to N a day"; "Each one shows in the next brief, with Undo." | | a per-rule daily quota | V2:125-141 |
| Workspace colour | 8 theme cards; "Now: <name>" | Ink | | S:1097-1110 |
| Strength | slider, default point | 55 | | S:1111-1114 |
| Glass | slider, default point | 25 / 50 | | S:1115-1118 |
| Chat › Floating or sidebar | **Floating** / Sidebar | Floating | | S:1119-1125, S:2026 |

Explanatory copy: "A decision is worth your time when you know something the agent does not, or when it cannot be taken back…" (S:1095).

**Live/automatic:** every decision states why it is the owner's, mapped to these rules ("Yours: over €500", `yours` on the lane) (R:83, F:114-116). A decision that fits none of the rules is the agent's to take and report (F:115).

## 15. Chat

### 15a. Shell chat panel (every page)
- One panel for the window. A page brings its own thread (`template.chat-src {title, sub, placeholder, content}`); pages without one share the general thread "Manager": "Reading this page", "Ask about anything on this page, or say what you want done. A new job becomes its own lane.", with the suggestions "What needs me today?", "What is stuck?", "Sum up this page" (S:1131-1152, S:1700-1707).
- Floating mode: 440×720, bottom right; Escape, X or a page change closes it (S:342-345, S:1690, S:2051). Sidebar mode: always open, full height, resizable, no Chat or close button (S:356-364). Under 900 px it always floats, as a bottom sheet (S:1698-1699, S:896-903).
- Header: title, sub (members: "You, Lea, Jonas and the partnership agents. Nothing else lives here."), the mode toggle "Keep the chat as a sidebar" / "Let the chat float" (S:1134-1138, S:1712-1716, S:2025).
- Composer: "Ask Morndo" / per-page placeholder, Add a file or a link, model "Auto" (opens the model/engine picker, §17), Send (grey until there is text) (S:1140-1145, R:91).
- Messages: `msg {av, who, time, text, acts?}`, `said` (the user's own), `answer`, `ctx` (what it is reading), `sugg` buttons (G:540-544, G:199-207).
- Inline action buttons inside agent messages, e.g. "Run one more round", "Post the 4" (G:654).

### 15b. v3 topic group chat
- Sub: "<people> and N agents · the Manager reads it, it is not in it" (V3:102-107). Placeholder "Message <topic> · its manager sorts it" (V3:157).
- Top of the chat (V3:136-148):
  - **Since you last looked** (time from history.seen): up to 3 lines from people's actions and an agent digest, with an **Edit** button that makes the lines editable ("Done" ends it) (V3:140, V3:249-254, MF:220).
  - **Pinned decision**: "<short> · Waits for you · <ask>" with Brief and <approve label>; once approved, "you approved it", with Undo; when stuck, "<short> is stuck" with Open (V3:141-145).
  - **Agents strip**, folded: "Agents · N updates since <seen>, nothing needs you". It opens the list `{time, agent, text}` (V3:146, V3:245-248).
  - A "Today" day separator.
- Messages carry a **label** (Question, Request, Done, Decision, Goal change; Decision can read "Decision · pinned"). Clicking a label opens a picker; choosing one marks it "Corrected; the topic's manager learns from it." (V3:92-98, V3:239-244).
- Thread card `{Thread · <title>, "<owner> owns it · <state>"}` that links to the lane (V3:115, V3:188).
- Read-back receipt `{owner avatar, quoted plan, "read back HH:MM"}` (V3:116, V3:189).

**What happens when you send in a topic chat** (V3:173-199). The user's message posts with its label, then the topic manager acts by kind:
| Kind | System response | Ref |
|---|---|---|
| question | The topic's manager answers "From the record: …" (deal, lane or goal state) | V3:179, V3:168-172 |
| request | Files a lane under the topic with the best lead, posts the thread card and the owner's read-back, and adds the ask to the Manager's "Asks from every chat" | V3:180-190 |
| change (deadline, goal, target, budget, priority, guardrail) | Proposes it to the Manager: a new decision in Decide "Proposed by the <topic> manager · Yours: changes a goal", with what it reaches in other topics. Badge and queue update. Chat reply: "Nothing changes until you approve it there." The ask is logged. On approval: "The goal is changed on record; every topic sees it." | V3:191-194, V3:205-216 |
| done | "Logged as done on the thread it belongs to." | V3:195 |
| decision | "Noted as a decision and pinned for the team." | V3:196 |

- Approving or undoing anywhere redraws the open topic chat, so the pinned decision stays current (V3:237-238).
- Live posts are kept per topic (LIVE) across navigation (V3:135, V3:158, V3:163-167).

### 15c. v3 "Talk to" switch and one place to write
- The brief and Manager composers are gone; the chat is the only place to write (V3:45-48, R:11).
- On every page except the brief and the Manager, the header has a switch: [page owner: <topic> / "This lane" / "This decision" / "The Manager"] | [The Manager] (V3:259-273).
- Talking to the Manager (from anywhere, or on brief, Manager, skills, drafts, settings): the message files a lane. The reply is a lane card "Lane · <text> — <topic> · <lead> leads · just opened" plus "Filed it as its own lane under <topic>, and named <lead> to lead. You hear from it there." or "…I keep it until I know where it belongs." (V3:282-299).
- In a lane chat (talking to the lane): the lead acknowledges and adds it to the lane (V3:288-291).
- Each page's thread, and the Manager thread, is kept separately (`STORE`) (V3:278-280, V3:272).

### 15d. Messaging rules this implements (MF:178-189, MF:215-224)
- A topic is a group chat for its people and agents. The Manager is not in it; it reads the shared record.
- Agents speak only to deliver or to ask. Status lives on the topic page.
- Every message is sorted by the topic's manager, with a correctable label. Nobody picks a category.
- A request becomes a lane thread with an owner and a state. An instruction gets one read-back.
- Decisions are pinned and open as a brief in Decide, with the chat discussion attached (MF:184, MF:301).
- "Since you last looked" opens every topic chat. It is written by agents and editable by people.
- Only the topic's manager speaks outward, and only for what spans topics (goals, priorities, budgets, shared resources). The Manager approves those with you.
- Open question: should agents post in the stream or in a strip? (The mock uses a strip.) (MF:188-189)

## 16. Receipts (filing toasts)

- "Filed as its own lane". The text of the ask, then "<Topic>: <name> · <lead> leads" or "With the Manager, until it knows where this belongs", plus "· one lane: the steps build on each other" when the text has then, once, after or before (S:1963-1969).
- Buttons: Open (the new lane), Move it (refile to another topic; in the mock it only dismisses), Undo (deletes the lane and leaves its page), X (dismiss). At most 3 stack (S:1965, S:1970-1977, S:2010).
- v2 settle receipts: "<what was done>", "Logged in Content's history", Undo (V2:89-92).
- In a topic chat, the thread card replaces the receipt (V3:183-185).

**The new lane record created on filing** (S:1950-1959):
- `state:new, lead, opened "Opened just now", next "Within the hour"`.
- `askedMeta` names who filed it and where.
- status: "<lead> is reading your ask and will set what done means before starting" or "The Manager is working out which topic… asks you only if it cannot tell".
- Default steps: [What done means (now), The work itself, Checked by someone other than <lead> (Manager), Reported back to you (Manager)].
- The agent card has engine "Auto".
- The chat holds the ask and "Got it. I will set what done means and start. You hear from me when it is done or when I need you."
- The lane gets its own page at once (R:34).

## 17. Model / engine picker (palette overlay; the "Auto" button)

The overlay is still reachable in v3 from the composer's "Auto" model button (S:1143, S:1183-1200).
- Input: "Say what you want done, or type / for a skill". Chip "Auto · Tab". Hint: "Each message becomes its own lane, filed under the right group. Send several in a row; they do not mix." (S:1188-1191).
- Models: Auto ("Morndo picks the model for each task", Default), Claude (Anthropic, Connected), GPT (OpenAI, Connected), Gemini (Add key), Grok (Add key) (G:334-339).
- "Agents · talk to one topic only": each topic with its agents; the link opens the topic (G:340-346).
- Skills: /weekly-summary, /brand-visual (G:347-349).
- Keys: ↵ File it, Tab Next model, Esc Close (G:351).

**Implied:** per-message or per-lane model choice; Auto routing; keys that can be added from here.

## 18. Command center (⌘K, v3)

- Entry: the sidebar field, ⌘K or Ctrl+K anywhere (toggles), ⌘N or ⌥N (opens ready to start). It is a centred modal over a dimmed page (V3:311-319, V3:489-494).
- Chips: scope "in <topic>", with an X for "Search everywhere"; an attachment chip. Placeholders: "Find, ask or start" / "…in <topic>" / "What should we start?" / "What should happen with this?" (V3:436-443).
- Scope defaults to the topic you are on (V3:445).

**Empty panel** (V3:396-405)
- Waiting for you: open decisions (filtered to the scope) and stuck lanes.
- Recent: the last pages visited, up to 4 shown, 6 kept (V3:323-330).
- Skills (3).
- In start or attachment mode: the prompt "Say what should happen with <file>…" and "Start from a skill" (every skill).

**Typed query** (V3:406-423)
- `/…`: matching skills.
- A question (ends in ?, or starts with where, what, how, who, when, why, which, is, are…) (V3:360):
  - an answer card from the records: a deal's stage and next, a lane's state and status, or a topic's verdict and insight, with the source "From the record · <topic> · <conf / lane / asOf>"; or "No record answers that yet";
  - then "Open it" and "Ask the Manager instead" (V3:361-376, V3:409-413).
- Several words that are not a question: "Start "<text>"", subtitled "New lane under <topic> · <lead> leads · Tab for another topic" or "With the Manager, until it knows where it belongs · Tab for a topic" (V3:392-395, V3:414).
- Results also list Topics (with their verdict), Lanes (topic · state · lead, ≤5), People (role · topics), Waiting for you, and Skills (≤3). A single word lists the matches first and Start last (V3:415-422).
- Nothing found: "Nothing yet. Type what you are looking for, ask a question, or say what should be done." (V3:424).

**Keys and actions** (V3:457-488)
| Input | Effect |
|---|---|
| ↑ ↓ / mouse | Select |
| ↵ | Act: go (navigate); start (files the lane under the previewed topic with the chosen lead, and the attachment); run (puts the "/skill " into the field, in start mode); ask (opens the chat to the Manager with the question filled in) |
| Tab / Shift+Tab | Cycles the target topic for Start, through the Manager and every topic |
| Backspace on empty | Removes the attachment, then the scope |
| Esc / click outside | Close |
| Pin menu "Start something here…" (topic or lane right-click) | Opens it scoped to that topic (V3:501, V3:504-528) |

**Implied backend:** search over topics, lanes, people, decisions and skills; Q&A grounded in the records; previewing the routing (target topic and lead) before anything starts; a recent-pages history per user.

## 19. Notifications, brief cadence, attention

- Reports wait for the next brief, three a day by default. The brief names the next one ("Next brief at 13:00") (S:1041, S:1080, R:82, MR:15).
- Between briefs, Morndo interrupts only for a decision due before the next brief, or for something stuck that puts a deadline at risk. This is a switch (S:1083-1084).
- Agents' own decisions are reported in the next brief, with Undo (S:1088, V2:137).
- A decision says by when, and what happens if it waits ("If it waits", `delay`) (S:1623, G:1126).
- Decisions expire with a default ("nothing changes" / "nothing is released") (G:189, D:215).
- Topic reports to stakeholders on a schedule ("Next report to Tom Fri 08:00", "Sign-ups reported Fri 20 Nov") (G:373, G:548). The Reporter agent drafts the CEO's weekly report (G:403).
- "You hear about it in that morning's brief" (SEO first ranking check) (G:888).
- The owner never has to watch terminals (MR:22).

## 20. Phone and narrow layout

- Under 900 px: the sidebar is an off-canvas drawer (the toggle opens it; navigating closes it); the chat is a bottom sheet (left/right 8 px, ≤78% height); there is no chat-sidebar mode and no resize grip (S:896-903, S:1694, S:2027).
- Brief at ≤860 px container: a mini date line instead of the rails, a 4:3.4 hero, one-column cards, no count emblems, no Undo buttons on log rows, a shorter decide bar (S:909-920).
- v2 phone: decisions first, then the topic strip, then the other cards; the hero becomes a 132 px band with no credit; the composer is one row (S:13-15, V2:28-35). The trajectory becomes one text line at ≤560 px (V2:36, V2:143-149).
- Topic page: "Needs you" moves above the deals at ≤860 px; the funnel wraps into 4 columns; stage bars wrap; history "Undo/Open" show on hover or focus (S:627-631).
- Decide bar: on narrow screens Approve gets its own row (S:334-338).
- Long press replaces right-click (S:1864-1871).
- "The web app is for everyone a topic is shared with… and for the phone." (R:140).

## 21. Motion and accessibility promises (non-functional)

- A drift on the brief picture, a pulse on working dots, a stamp on approve, a check when everything is decided, a bump on the count. All of it is off under reduced motion (S:670-682, S:883-894, R:129).
- State is never colour alone: words come with every mark, and the state word is kept for screen readers (R:58, F:95).
- Every chart has a text alternative; meters have role="meter" (S:1484, S:1560, S:1905).
- Text contrast is at least 4.5:1 on every surface (R:115).

## 22. Development module only (dev.blocks.html)

**Sidebar tree (fixed):** Projects: Web app (Stuck: Red main; New sign-in; Shipment filters; "Upgrade to Node 24" parked until Thu with a pause icon), API (Export for big accounts; Export limits in the docs "Merges by itself at 09:00"), Billing (Tax rates per country), Mobile (Keep scans without a signal), Infra (no lanes, Idle) (D:1-34). Account: Timo Varga (D:36).

**Brief cards**
- Yours to decide (D:41-76):
  - d1 "Release the fix for exports that time out" (API, due 14:00). Done note: "The Release lane rolls out at 22:00 and watches for 30 minutes".
  - d2 "Run the tax-rate migration on the production database" (backup first; dry run 41 s). Done: "runs tonight at 23:00, after the backup".
  - d3 "Choose the new sign-in: passkeys or a link by email" (built behind a switch, QA passed; the lane suggests passkeys). Done: "Passkeys go to staging today, with the email link as the fallback".
- Where it burns: "Main is red in the web app", red since 06:40; "Builder tried 3 fixes and stopped at its limit" (D:78-94).
- Shipped while you slept, with Undo per row: API released the rate-limit fix after review and a production check; Billing merged after 2 review rounds; Web app updated 6 dependencies and held 1 back; Infra renewed the staging cert 12 days early; Mobile deleted 4 merged branches (D:96-109).
- Still in the works: 5 PRs (2 ready and waiting, 2 in review, 1 auto-merges at 09:00, docs only) and Open pull requests (D:111-126).

**Release decision brief** (D:130-235)
- Context.
- **Proof**: Tests "214 pass, 6 new that failed before the fix"; Fresh review "2 rounds, 3 findings, all fixed"; Run on staging "48 s, Fenwick's 1.2 GB export"; Checks "5 of 5 green on the version to release". Meta: PR #412, files and +/− lines, "No database change", "Rollback tried on staging: 2 minutes". "Not checked: exports larger than 5 GB" (D:145-155).
- Opportunity and risk charts (failed exports a day; the worst case at 14% for 2 minutes, then rolled back).
- Suggestion: a staged rollout at 22:00 to 10% for 30 minutes, then everyone. Guardrail: automatic rollback if failures exceed today's rate.
- Next steps: Release lane, QA lane, the GTM Writer drafts the "it is fixed" note to the customer (a cross-module handoff), the Manager reports.
- Decide bar: "If you do not answer by 14:00, nothing is released." with Decline, Change something, Approve the release.
- Chat suggestions: "Show what changed", "Release to Fenwick only first".

**Project page "Web app"** (D:238-308)
- The stuck box: meta, cause, a CI check row (Build, Types, Unit tests, Checkout e2e pass; Sign-in e2e fail), a failing-test log excerpt `{test name, expected/got, file:line · runs/failures}`.
- Actions: **Pin the old session library** ("about 3 minutes and turns main green"), **Allow one more try**, **Open the run**.
- Lane agents: Builder (/red-main, Claude Code), Reviewer (/review, Codex), QA (/qa-by-hand, Cursor).
- Tasks table `{task, lane, state incl. Parked with reason, next report}`.
- Chat: Builder asks for an OK because "It changes main directly", with **Pin it** and **One more try**. It will "file the proper upgrade as its own task, with a test" (D:305).

**Pull requests page** (D:362-381)
- "A change merges only after its tests, a fresh review and green checks. Production always waits for you."
- PR card `{project, #number, opened by agent and when, title, summary, gate: Tests / Fresh review (round n, spinning) / QA by hand / Checks / No tests needed, verdict}`. Verdicts: "Ready, yours to release", "Ready, the migration waits for you", "Blocked by red main", "In review", "Merges by itself at 09:00, docs only".
- Actions: Open brief, Go to Web app, Open on GitHub, **Hold** (stops the auto-merge).

**Manager (dev):** a fixed table (7 lanes in 4 projects · 3 wait for you, including Parked with its reason); asks list; chat suggestion "What is parked, and why?" (D:384-430).

**Lane "Export for big accounts"** (D:433-489): the lead changed ("Builder led the fix, Release leads now"); done-means of 5 steps; agents Release, Builder, Reviewer, QA; made: decision brief, PR 412, staging run, review notes; chat: "put Fenwick in the first 10% of accounts".

**Skills (dev)**, 9 (D:320-331): /fix-with-proof, /build-feature, /review (Codex), /qa-by-hand (Cursor), /release ("Asks first"), /red-main, /upgrade, /what-broke (needs a Sentry key), /decision-brief; plus "Make your own".

**Connections (dev)** (D:335-345): GitHub (code, PRs, checks), Claude Code / Codex / Cursor ("Signed in"), "Your server: Lanes run here · 3 of 8 busy", Sentry (Add key).

**Guardrails (dev)** (D:346-355): Production "ask before anything is released"; Database "Backup first, and ask me before a change"; Merging "Tests and one fresh review before any merge"; Tries "3 tries at a fix, then stop and ask"; Keys "Stay in the vault, never in a chat".

**Palette (dev)** (D:491-505): Engines: Auto ("Morndo picks the agent for each task"), Claude Code, Codex, Cursor (Signed in), Gemini CLI (Sign in); "Projects · talk to one project only"; Skills; Tab = Next engine.

**Pins (dev)** (D:507-520): Brief, Decide, PRs, Skills, the 5 projects, and the macros /review, /red-main, /release, /qa-by-hand, /upgrade.

**Routes (dev)** (D:533-537): project routing for intake.

**Live/automatic (dev):** auto-merge of docs-only PRs at a set time; staged rollout with a watch window and auto-rollback; backup before a migration; a try-limit then stop; nightly CI runs; dependency updates that hold back on failing tests; certificate renewal; branch cleanup; lanes run on the user's server with a capacity count; a fresh review by a different engine.

## 23. Sharing variant (share.extra.html; proposal; it keeps the stage view of the glance, SH:63)

**Data shown**
- Team `{av, name, role}`: Mara (owner), Lea, Jonas, Tom (CEO) (SH:67-72).
- Access per person: `{kind: all | stages[idx] | view | none}`, plus access to other topics `{content/outbound/paid: view|work}` (SH:74-78).
- Scope words: owner, everything, "<stage names>", status only, no access (SH:100-103).
- "Seen by" faces on the topic header; watchers are dimmed (SH:147).
- A non-owner's topic view (SH:127-144, SH:222-240):
  - Meta: "Shared by Mara Lind · You run <stages>" / "You see the status".
  - Only their stages' rows; other stages are locked or read-only bars.
  - Agents limited to theirs; their own ask turned to them (MINE: "Wave 2: 24 emails · check them before they go out", with the button "Send wave 2").
  - The owner's decisions read "Waits for Mara".
  - A role-scoped chat (Lea gets the Outreach thread).
  - The history filtered to their lanes, with "your mail" rewritten to "Mara's mail".
- A status-only viewer: no Details or History, only "Mara shares the status of this topic with you. The weekly report comes on Friday at 08:00." (SH:236-239).
- Non-owners do not see the pins, the Manager row or the Manager's lanes (SH:59). Topics not shared with them read "Nothing here is shared with <name>." (SH:226-228).

**Variant 1, Share button** (SH:149-159, SH:191): the popover "Share Partnerships". The owner row is fixed; per person a select: Can work: everything / Can work: <stage> / Can view: status only / No access. "Add someone by name or email" and Invite. Note: "Each person sees only what their role covers… The chat follows the role."

**Variant 2, Hand over a stage** (SH:160-167, SH:192-205, SH:207-220):
- Team faces you can drag onto a stage; the stage tray has a "Run by" select.
- The person who runs a stage is ringed in its crew.
- The toast: "<name> now runs <stage>: its lanes, agents and chat. The rest of the topic shows as bars."
- "Share status" popover: "They see the numbers, the stage bars and whether it is on track. No lanes, no chat, no names of brands." Each viewer has Stop. Add someone. **Copy status link** ("Only people at Tidewell can open it, and they see the status only.").

**Variant 3, People table** (SH:168-184, SH:193): the dialog "People and access". A matrix of people × (Partnerships: All, each working stage, Status | other topics). A cell cycles none → view → work for other topics; it toggles stages, all and view. Key: dot = works on it, ring = sees the status. The owner's row is disabled. Done closes it.

**Other actions:** Invite (a new person gets view) (SH:302-312); Stop (SH:273); role change toasts (SH:296); Esc closes the popover (SH:322). The demo bar "Sharing 1/2/3" and "See it as Mara/Lea/Tom" is a design aid (SH:247-268).

**Implied backend:**
- Per-topic ACL at stage granularity.
- Invitations by name or email.
- Org-restricted status links.
- Scoped projections of topic, lanes, chat and history per viewer, decided by the hub, never the client (R:142).
- The web client is first-class for shared viewers (R:137-142).

## 24. Live/automatic behaviour the UI implies (consolidated)

**Intake and lanes**
1. Every message to the Manager (from chat, ⌘K, pins, receipts, "Ask for a goal") becomes its own lane, filed under a topic with a named lead. It stays with the Manager until it knows where it belongs, and asks only if it cannot tell (S:1921-1978, G:286).
2. The Manager splits an ask only into parallel parts; sequential steps stay in one lane, and the receipt says so (S:1967-1969, R:87, MR:16).
3. The Manager sets done-means when it opens a lane. The lead sets the real steps before starting. Done is checked by someone other than the lead, and the Manager closes the lane (S:1633, S:1955-1956, G:1253, G:1010, G:1026).
4. A lead asks instead of guessing when the ask is unclear (MR:26).
5. Standing and recurring lanes are opened by the Manager on a schedule (each Monday, the second Monday monthly) or on its own from the plan (G:1291, G:1416, G:1372).
6. The Manager runs periodic checks (every Friday no yes waited more than a day), random spot checks on finished work, and checks numbers before a decision brief goes out (G:1364, G:493, G:114).

**Briefs and reporting**

7. Briefs are written at the configured times. They hold a lede, decisions with minutes, stuck items, the overnight agent log with Undo, drafts, the topic strip and spend (S:1041, G:6-103, V2:43-69).
8. Topic status pages are written by an agent under rules R1-R23 (verdict only against a dated plan, forecasts resting on a fact ladder, gaps stated, the as-of line, guardrail meters, top-2 blockers, recovery plan) (F:3-139).
9. Forecasts are stored with their date and scored later. The ladder learns ("Likely signed 3 of 4 times") (F:111-113, G:452, G:607, G:720, G:835).
10. Agent records are computed: how often work held when someone else checked it (S:1317, F:117, R:86).
11. "Since you last looked" and the agents strip are summarised from the record per reader. The Manager has its own "since its last turn" summary (V3:124-148, V3:229-231).
12. Reports go to stakeholders on a schedule; the Reporter drafts the CEO's weekly report (G:373, G:403).
13. History is kept for the topic's lifetime with per-reader "seen" marks (R:75-76).
14. The brief artwork is picked by date (S:1211-1215).

**Decisions and guardrails**

15. Decision rights: agents act alone inside the guardrails and the Who decides rules, and report it in the next brief with Undo. Optional daily limits apply when a risky class is delegated (S:1088-1093, V2:125-141).
16. Decisions expire at their deadline with the default "nothing changes" (G:189).
17. Guardrails are enforced automatically:
    - the spend cap per change (€500);
    - auto-revert of a budget shift on a cost trigger (>€110 for 5 days);
    - sending capped at 60 a day and paused at 4% bounces;
    - 3 visual feedback rounds, then stop and ask;
    - customer data never sent to image or video models;
    - a weekly agent spend cap per topic, then pause and ask (G:254-257, G:168, G:1224, V2:49).
18. A breached guardrail becomes a blocker under Needs you (R:74, F:47).
19. Before anything goes outside, the checks it passed are recorded on the lane (R:84, F:116).
20. Undo of agent actions is available for a window ("until tonight"). Anything sent outside cannot be undone (G:1298, R:75).

**Messaging**

21. Topic managers classify every message, answer questions from the record, open threads with an owner, post read-backs, log done on the right thread, and pin decisions. They propose goal changes to the Manager, which checks the effects on other topics and puts one decision in Decide (V3:92-216, MF:270-290).
22. Label corrections train the topic's manager (V3:244).
23. Agents do not post status in the chat; their status goes to the strip and the page (MF:181).

**Sessions and accounts**

24. A handover read-back on restart, a fresh session or a new lead: the hub compares the read-back with the record and holds outside sends until they match. Corrections are logged (G:1094-1098, R:85, MR:19). Agents start fresh sessions on their own when a conversation grows long (G:1073).
25. Shared resources (mail, CRM, ad accounts) are scheduled so lanes take turns (G:297-304, MR:21).
26. Account routing: Auto model or engine choice; subscription → API key failover at the limit; per-account usage and reset tracking (S:1884, G:335).
27. Drafts are written into the user's mail; Morndo never sends from there (G:246, G:270).
28. Overnight work happens around the clock by agents (G:374, G:76).
29. Notifications between briefs only for what cannot wait (S:1083).

**Development module and sharing**

30. Dev: auto-merge docs-only PRs; staged rollout, watch and auto-rollback; backup before a migration; nightly CI; try-limits (D:121, D:193, D:61, D:352).
31. Sharing: the hub decides what each viewer sees; the history and the chat follow the role (R:76, R:142, SH:138-142).

## 25. Cross-cutting entities (the data model the UI implies)

| Entity | Fields (as the UI uses them) | Refs |
|---|---|---|
| Workspace | name, colour theme {id, strength k, glass g}, modules on, members, connections, guardrails, decision-rights rules, brief cadence, interrupt policy, chat placement default | S:994, S:1063-1127 |
| User / person | name, avatar initial, role/title, kind "p", topics, access per topic or stage, last-seen per topic (history.seen), pins (per module), layout prefs, recent pages | G:529-531, SH:67-78, V3:323-341 |
| Module | id (gtm/dev), name, icon, kind word (Topic/Project), its pages, pinnables, skills, routes, palette | S:1069-1075, G:2, D:2 |
| Topic (Project in dev) | id, name, icon, crumb, open, meta (asked by, owner, next report), intro, when, health [st, word], numbers/facts, plan {stages[], night[]}, focusLane, goal?, noGoal?, history, agents[] (people + agents), jobs[], chat, chatSub, members | G:371-996 |
| Goal | target, signed, likely?, nums?, labels?, targetWords, health, action, insight, decision {title, sub, done, why?}, calm/calmSub, asOf, verdict, trajectory {...}, milestones[], rows {title, sub}, deals[], guards {sub, items[]}, ladder[], calib, out, gap {says, steps[]}, attention[], routine, funnel {title?, since, steps[]}, restSub | G:412-480, F:126-137 |
| Deal / source row | name, conf (Likely/Possible/Early/Done or a value word), at, stage, short, val?, close?, href (lane), evidence (fact + date), next, alt {d, …} | G:430-440 |
| Forecast record | word, date given, outcome later (for scoring) | F:111-113 |
| Guardrail | what, val (reading), limit text, p (reading/limit) or yes/no state, scope (workspace or topic), on/off, owner-only editable, enforcement action (pause/revert/ask) | G:442-450, G:253-257, V2:49 |
| Blocker (attention) | st, short, what?, why?, who (person or agent), href | G:462-466 |
| Funnel step | n, what, d (change this period), rate vs plan, st | G:468-479 |
| Plan stage | name, st, pct, sub, rows [av, who, kind, st, text, when, pct, href, alt], alt; owner (sharing: run by) | G:379-405, SH:204 |
| Lane | id, topic?, title, state, lead, waits?, opened, closed?, next, afterNext, decision?, decisionHref?, short, ask, shortAfter, rec, yours, checks[], delay, approve, after, asked (verbatim), askedMeta (source chat/person, filer), status, acts, extra, steps [kind, text, who·when], doneNote, agents[], made[], handover?, chat thread, history rows, model/engine, account used | G:998-1428, S:1950-1959 |
| Handover | when, match, why, state, open, risk, ifso, restated (read-back), fixed? | G:1073-1076, G:1094-1098 |
| Agent | av, name, state, word, current text, skill cmd, engine/tool, kind "a", record ("51 of 52 passed Lea's check"), topic(s), lanes | G:532-538 |
| Decision | id, topic, title, context line, due, why-yours category, minutes to read, lane, brief {context, numbers, opportunity/risk scenarios, suggestion, guardrail, next steps [step, who, by when]}, provenance (written by, checked by, at), expiry default, approve label, after text, state (open/approved/declined/undone), proposer (agent / topic manager), kind (incl. goal change with cross-topic effects), attached chat discussion | G:16-51, G:107-209, V3:205-216 |
| Decision-rights rule | category (in your name / hard to undo / only you know / inside guardrails / spend over cap), who (You/Agent), daily limit? | S:1090-1093, V2:119-141 |
| History event | time, actor (av, name, kind), text, lane, flags d/o/u, batch count n, sample items, depends-on decision, undone state, day; topic seen marker | S:1377-1383, G:483-527 |
| Brief | date/time, edition (of N a day), next brief time, artwork, lede, decisions, burns, overnight log rows {topic, text, time, undoable}, drafts summary, topic strip, spend line | S:1027-1057, G:6-103, V2:51-63 |
| Draft | to, written at, skill?, subject, body, mail link, source lane | G:272-277 |
| Skill | /name, description, topics, tools/connections needed, enabled (key present), built-in or user-made, "asks before first run" | G:224-234 |
| Connection | name, purpose, scope (read-only, drafts-only), state (Connected / Signed in / Add key / Sign in), capacity (server "3 of 8 busy") | G:241-248, D:337-344 |
| Usage account | type (subscription / API key), name, lanes on it, meters [{what, used, val, note/reset}], budget, failover target/note, asOf; missing providers | S:1881-1900 |
| Agent spend | per topic: this week vs cap; overnight total; workspace week total | V2:43-51 |
| Message (chat) | thread (page/topic/lane/decision/Manager/general), author (person/agent/topic manager/Manager), time, text, label {kind, corrected?}, attachments, inline actions, thread card link, read-back receipt | V3:92-199 |
| Thread | = a lane opened from a chat: title, owner, state, origin message, read-back | V3:115-116, V3:188-189 |
| Since-summary | per reader per topic: lines (≤3), seen time, editable; Manager "since its last turn" | V3:124-148, V3:231 |
| Ask (Manager log) | quote, when, which chat, where it went (topic/thread/lane, owner) | V3:218-228, G:307-312 |
| Shared resource | name, rule (who writes, order, daily quota), lanes using it | G:299-303 |
| Receipt | text, filed under, lead, chain note; actions open/move/undo | S:1963-1977 |
| Pin | id, kind (page/topic/skill macro), label, icon, href or run, badge; max 12, per user per module | G:353-367, S:1797-1849 |
| Share / access grant | person, topic, kind (all/stages/view/none), stages[], other-topic access, invite, status link | SH:74-78, SH:149-184 |
| Dev: Pull request | project, number, author agent, opened, title, summary, gate checks (tests, fresh review round, QA by hand, checks), verdict, auto-merge time, hold | D:369-378 |
| Dev: CI run | checks [name, pass/fail], failing test log {name, expected/got, location, runs/failures} | D:256-265 |
| Dev: Release | PR, proof stats, unchecked scope, rollout plan (%/watch minutes), rollback time, auto-rollback trigger | D:145-193 |
| Artwork | file, title, manner, alt, pos | src/heroes.json, S:1212 |
