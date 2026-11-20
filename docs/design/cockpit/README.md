# Cockpit: one calm place to direct many agents

**Phase: design, 2026-11-17. No product code.** This replaces the Slack-style desktop of [ADR-0006](../../adr/0006-slack-style-desktop-client.md) once it is decided. The target after the design is a native Mac app; its decision record comes with the proof of concept, not before.

Open the mockups in any browser. Each is one self-contained file:

| File | What it shows |
|---|---|
| [`mockups/dev-cockpit.html`](mockups/dev-cockpit.html) | The development module: projects, lanes, pull requests, release decisions with proof. |
| [`mockups/gtm-cockpit.html`](mockups/gtm-cockpit.html) | The go-to-market module: topics (content, outbound, paid, SEO, research), drafts, decisions. |
| [`mockups/gtm-cockpit-v2.html`](mockups/gtm-cockpit-v2.html) | Proposal, not decided: the go-to-market mockup with a product review's fixes on top. What agents cost per topic, every topic's verdict on the brief, Decide as a queue, the stuck promo's choices working, decision rights in one place with a limit before anything risky is handed over, and a phone layout that puts the decisions first. |
| [`mockups/gtm-sharing.html`](mockups/gtm-sharing.html) | Proposal, not decided: three ways to share a topic with teammates (a Share button, handing over a stage, a people table), and what each person then sees. |

Both are built from one shell, so they differ only in what a module brings. The workspace menu and Settings switch between them. All names, projects and numbers in them are made up.

## Layout of this folder

| Path | What it is |
|---|---|
| `src/shell.html` | Everything the modules share: styles, icons, the sidebar frame, the brief's masthead, settings, behaviour. |
| `src/gtm.blocks.html`, `src/dev.blocks.html` | What one module brings, as blocks. A line `<!-- @@ name -->` starts the block `name`, which fills `@@BLOCK:name@@` in the shell. |
| `src/build.py` | Builds the mockups into `mockups/`. Fonts and artworks are inlined. |
| `topic-status-framework.md` | The guard rails an agent follows when it writes a topic's status page. |
| `src/share.extra.html` | The sharing proposal: styles and behaviour laid over the go-to-market module (a variant in `build.py`). |
| `src/v2.extra.html` | The review's fixes, laid over the go-to-market module the same way (variant `v2`). |
| `src/heroes/`, `src/heroes.json` | The brief's artworks as the mockups embed them (1280 px). |
| `src/glass.sh`, `src/glass/` | The small pre-blurred pictures behind the window frame (needs ImageMagick 7). |
| `src/fonts/` | Newsreader and Schibsted Grotesk, with their OFL licences. |
| `icons/` | The UI icons as single SVGs, plus `sprite.svg`. |
| `hero-art/` | The brief's artworks in web sizes (1536 and 960 WebP, 1536 JPEG) and `heroes.json` with titles and alt text. |

The go-to-market module brings its topics and lanes as records (the `pages` block). The shell draws the sidebar tree, every topic page, every lane page and the Manager's table from them, so a decision approved anywhere shows everywhere, and a lane filed from ⌘K or the Manager gets its own page at once. Pages open at `#topic/<id>` and `#lane/<id>`. The development module still has fixed project and lane pages.

Edit the source, never the built files. Rebuild:

```sh
python3 -I docs/design/cockpit/src/build.py          # every module and variant
python3 -I docs/design/cockpit/src/build.py dev      # one
python3 -I docs/design/cockpit/src/build.py --out /some/preview/dir
```

## The rules the design keeps

These are the parts a native app has to keep. The mockups are the reference for everything else.

### The window

- The page sits flush with the window, as Dia's does: no inset, no border, no corner. A hairline under the 48 px toolbar is the only line. The breadcrumb names the place above in a quiet grey, then the page itself, brighter.
- The window frame and the sidebar never move. Only content areas scroll, and there is no rubber-band bounce.
- Page layout follows the room the page has (container queries), not the window width.
- The left sidebar can be resized by its edge (224 to 380 px). Double-click resets it; arrow keys move it.

### The sidebar

- A row is one icon and one name. No status words, counts, avatars or guide lines on rows.
- A colour mark appears only where it matters: red for stuck, amber for waiting on you, green for working. It shows once, at the deepest visible level: a closed group carries it, an open group's lanes do. Topics and projects carry none. Decisions are counted only on the Decide pin. The state word is kept for screen readers and shows on hover.
- At the top is a pin grid, at most 12 pins (4 by 3). The module brings Brief, Decide, Drafts or Pull requests, and Skills; you can pin topics, projects and skills as one-click macros. A macro pin opens "New lane" with the skill filled in.
- Then one tree: the Manager pinned first, with lanes that fit no project or topic yet under it; then "New lane"; then Projects (development) or Topics (go-to-market), each with its lanes inside. Subagents and artifacts live on a lane's page, not in the tree, so the tree stays two levels deep.
- No destructive controls appear on hover. Removing something (unpin, for example) is in the context menu: right-click, long press on touch, or the menu key / Shift+F10.
- At the bottom is the account row: the name and the sliders open Settings, the gauge between them opens Usage. Usage is the floating chat's card, smaller, rising from the row (Escape, the X or a click outside closes it). It keeps two kinds of account apart: **subscriptions** (Claude, Codex, Cursor) have a flat price and limits that reset, so each shows how much of its windows is used and when they reset; **API keys** (your own, billed by use) show what was spent against the budget you set. Meters turn amber close to a limit and red at it, always with the word. Only accounts the workspace added appear; the ones not added are named once at the bottom, with "Manage accounts". Where one account takes over from another (a key when a subscription is at its limit), both say so.

### Lanes and the manager

- A lane is one piece of work and has its own page: what was asked in the asker's words, where it stands with the done-means as a checklist, who leads and who helps, what it made, and its own chat.
- The Manager's page lists every lane with its project, lead, state and next report, plus the recent asks and where each one went.
- A new ask is filed under a project with a receipt naming the lead.
- A topic page is read at a glance, the way a manager asks "where are we?": whether it is on track, one or two numbers that matter, and at most one line for the thing that waits for you, with its button. Nothing on it has to be read to know the state.
- A topic with a dated goal follows [the topic status framework](topic-status-framework.md): the overview holds decisions and exceptions (the verdict, signed against target apart from the forecast, the trajectory, the deals as milestone tracks, what needs you, the funnel as one strip); evidence and explanations are one click away (the recovery plan, each decision's reasoning on its lane, Details, History). The agent that writes the page chooses how to show each part; the framework sets the order and the rules.
- The stage plan of such a topic moves into Details. The sharing proposal keeps the stage view, because it shares a topic stage by stage.
- A topic can carry a plan: one bar per stage (green while it is worked on, amber while it waits for a person, plain when done), and under each stage the avatars of who works in it now. People are round, agents are square, and the dot on an avatar is its state. Clicking a stage opens who does what in it, now and next; one line counts what the agents did overnight.
- Everything else on a topic (what it is for, its lanes, the people and agents, the jobs) stays closed under Details. A lane that waits for someone on the team says who ("Waits for Lea") and does not appear as yours; "Needs you" is only for the owner.
- A topic with a goal names its guardrails on the first screen as one row of small meters: what reaching the goal must not cost, each reading against a marked limit. A breach runs past the mark in amber and becomes a blocker under Needs you; a yes-or-no rule says Held or Breached.
- A topic has a History, closed under Details: who did what and when, from people and agents, newest first, by day. A person's action or decision is one line; an agent's batch is one line with its count, and the count opens a few of the items. A line marks where you last looked, and its summary says how many lines are new since then. Filters: People, Agents, Decisions, Sent outside. Every line opens the lane it happened in; what can be undone has Undo, and something already sent outside cannot be undone. A lane page shows the same history, only its own lines.
- The history follows the sharing: someone who runs a stage sees that stage's lines, someone who sees the status sees none. It is kept for the whole life of a topic, so it needs its own storage; the fleet's 7 days of lane events are not enough.

### Attention and decision rights

Taken from management research; [management-research.md](../orchestration/management-research.md) has the findings and the sources.

- Reports wait for the next brief, three a day by default (Settings, Briefs). The brief says when the next one comes. Between briefs Morndo interrupts only for a decision due before the next brief, or for something stuck that puts a deadline at risk.
- Settings says who decides what. The owner decides what goes out in their name, what is hard to undo, and what rests on something only they know; agents decide the rest inside the guardrails and report it in the next brief, with Undo. Each decision says why it is the owner's ("Yours: over €500"), and its lane says it in a sentence.
- Before anything goes outside, its lane shows the checks it passed.
- A handover (a restart, a fresh session, a new lead) is on the lane's page: where it stood, what is open, what could go wrong, what to do then, and the new session's read-back. A read-back that does not match the lane's record is corrected before the lane may send anything; that correction is a line in the History.
- An agent's card shows its record: how often its work held when someone else checked it.
- The Manager splits an ask into several lanes only where the parts can run side by side; steps that build on each other stay in one lane. Its page lists what lanes share (your mail, the CRM, the ad accounts) and how they take turns.

### Chat

- The composer is a field of its own, as Dia's: the words on top and a row of tools under them (Add files or links, the model, Send). Send stays grey until there is something to send.
- Two modes, chosen in the chat's header or in Settings. **Floating** (default): closed until you press Chat, then a card at the bottom right (440 by 720 px, a bottom sheet on a phone) that does not push the page; Escape, the X or changing page closes it. **Sidebar**: always open at full height, resizable by its edge (320 to 640 px), with no Chat button and no close button.
- A page brings its own thread; pages without one share a general thread.
- ⌘K opens the palette: new lane, skills, engines.

### Pages: Dia's way of reading

Measured from Dia's own pages (brief, search popover, new tab), not guessed:

- **One card at most.** A page has at most one box: the brief's first section, a topic's glance. Every other section stands on the page itself, separated by space (56 px between the brief's sections), never by lines. Cards have no outline.
- **Type does the work.** Section names are serif italic (28 px on the brief, 21 px on a page), led by a faint mono number (01, 02). Item titles are 18 px semibold in white. Reading text is 16 px at a 1.75 line height in a warm grey (#a39e95), the one warm tone in the neutral page. Where an item comes from is named in serif italic.
- **Neutral greys.** The page is #111, a card #1d1d1d, a field #2b2b2b. Quiet buttons and hover are a light laid over the surface (white at 7.5% and 12%), so they show on any surface.
- **Popovers and the palette** are raised (#262626) with a faint light rim (white at 8%), 36 px rows, 14 px text, 12 px quiet section labels, and no line under the search field.

### Design tokens

Every colour, size, radius, space, shadow and duration is a token, defined once at the top of `src/shell.html`, in three layers:

| Layer | What | Examples |
|---|---|---|
| Primitives | Raw values: the neutral grey ramp, the frame's cool slate, the status hues | `--grey-100` #111, `--grey-200` #1d1d1d, `--paper-grey` #a39e95, `--teal` |
| Semantic | What a value is for. Rules use only these and the scales. | `--bg`, `--surface`, `--raised`, `--field`, `--fill`, `--line`, `--rim`, `--text-hi`, `--text`, `--prose`, `--muted`, `--faint`, `--ok` |
| Scales | Type, line height, space (4 px grid), radius, control sizes, shadow, motion | `--fs-md`, `--lh-read`, `--sp-6`, `--r-lg`, `--h-ctl`, `--sh-pop`, `--ease` |

A colour theme overrides semantic tokens only, so the web app and the native app can take the whole look over by token names. Text tokens keep at least 4.5:1 on every surface they sit on (lowest: muted on a quiet button, 4.83:1). `--faint` (2.5:1) is for decoration only, never for words that carry meaning. The sidebar keeps its own cool greys (`--cool-*`) over the frame and the glass, so its measured contrast below still holds.

### Colour and glass

- Dark only for now. Colour belongs to the workspace: Ink (neutral greys, as Dia's page) plus seven presets (Ember, Sand, Moss, Tide, Sky, Iris, Rose) and a strength slider (default 55). Each preset keeps Ink's lightness steps in its own hue (OKLCH), so contrast holds. There is no free colour picker.
- Glass is one slider from 0 (off) to 100, next to the colour choice. Default 25 for Ink and 50 for the colour themes; a point under each slider marks the default.
- Glass is cheap by construction: a 64 by 42 px pre-blurred picture of the day's artwork, stretched by the browser, under a veil of the frame colour. No blur filter, no `backdrop-filter`, no running animation.
- One exception, because it is small and only there while open: the Usage card is real glass. What is under it (the sidebar, the page) shows through, lightly blurred so it stays recognisable and darkened to 42%, under the card's surface at 42% (`backdrop-filter`). It never shows a picture of its own. Every text on it is at least #c4c4c4, so contrast holds even over pure white (4.8:1 by calculation). Measured on the rendered card, the faintest text is at 5.9:1 on a wide window, 5.2:1 on a narrow one with page text under the card, and 6.8:1 on a phone. It turns solid with the Glass slider at 0, under reduced transparency, and where `backdrop-filter` is missing.
- Contrast is safe by construction, not by tuning: the veil only moves the frame toward its plain colour, the glass pictures have a fixed lightest tone, and the sidebar's grey text is a step lighter on glass. Any new sidebar text or surface must keep at least 4.5:1 on the lightest spot. Measured across 8 themes, 3 colour strengths, glass full, half and off, and all 14 artworks: lowest 5.10:1.

### Icons and pictures

- UI icons are drawn by hand on a 24-unit grid: one line weight (1.75), exactly one solid part per icon, colour from `currentColor`. They must read at 16 px. UI icons are not generated with an image model.
- The old-artwork look belongs to the brief's pictures only.
- Motion: a slow drift of the brief's picture, a pulse on working dots, a stamp on approve, a check when everything is decided. All of it is off under reduced motion.

## Where this goes next

1. Finish the design in these mockups.
2. A proof of concept of a native Mac app: a native sidebar with real lanes from the hub, a live terminal view, one lane with its own web tabs, and Decide working end to end. It passes only if it uses clearly less energy than a Chromium-based browser over a day, opens instantly from a local copy, and keeps working when the hub drops.
3. A decision record for the native app (stack, how it gets the protocol types, distribution, updates). It supersedes ADR-0006 once accepted.

There are two clients, and both are first-class (owner, 2026-11-19):

- **The native Mac app** is the cockpit for whoever runs the work: terminals, web tabs per lane, everything local and fast.
- **The web app** is for everyone a topic is shared with (a teammate who runs one stage, a CEO who watches the status) and for the phone. Sharing a topic must not mean installing an app.

Both show the same pages from the same records. What a person may see is decided by the hub, never by the client, so a shared view is the same in both.

## Credits and licences

- The brief's 14 artworks were generated for Morndo with an image model, from prompts describing period styles. `hero-art/heroes.json` lists each one's title, style and alt text.
- Newsreader (The Newsreader Project Authors) and Schibsted Grotesk (The Schibsted-Grotesk Project Authors) are under the SIL Open Font License 1.1; the licence texts are in `src/fonts/`.
- The icons and everything else here are under the repository's licence.
