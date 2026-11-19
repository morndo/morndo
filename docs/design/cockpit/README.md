# Cockpit: one calm place to direct many agents

**Phase: design, 2026-11-17. No product code.** This replaces the Slack-style desktop of [ADR-0006](../../adr/0006-slack-style-desktop-client.md) once it is decided. The target after the design is a native Mac app; its decision record comes with the proof of concept, not before.

Open the mockups in any browser. Each is one self-contained file:

| File | What it shows |
|---|---|
| [`mockups/dev-cockpit.html`](mockups/dev-cockpit.html) | The development module: projects, lanes, pull requests, release decisions with proof. |
| [`mockups/gtm-cockpit.html`](mockups/gtm-cockpit.html) | The go-to-market module: topics (content, outbound, paid, SEO, research), drafts, decisions. |

Both are built from one shell, so they differ only in what a module brings. The workspace menu and Settings switch between them. All names, projects and numbers in them are made up.

## Layout of this folder

| Path | What it is |
|---|---|
| `src/shell.html` | Everything the modules share: styles, icons, the sidebar frame, the brief's masthead, settings, behaviour. |
| `src/gtm.blocks.html`, `src/dev.blocks.html` | What one module brings, as blocks. A line `<!-- @@ name -->` starts the block `name`, which fills `@@BLOCK:name@@` in the shell. |
| `src/build.py` | Builds both mockups into `mockups/`. Fonts and artworks are inlined. |
| `src/heroes/`, `src/heroes.json` | The brief's artworks as the mockups embed them (1280 px). |
| `src/glass.sh`, `src/glass/` | The small pre-blurred pictures behind the window frame (needs ImageMagick 7). |
| `src/fonts/` | Newsreader and Schibsted Grotesk, with their OFL licences. |
| `icons/` | The UI icons as single SVGs, plus `sprite.svg`. |
| `hero-art/` | The brief's artworks in web sizes (1536 and 960 WebP, 1536 JPEG) and `heroes.json` with titles and alt text. |

The go-to-market module brings its topics and lanes as records (the `pages` block). The shell draws the sidebar tree, every topic page, every lane page and the Manager's table from them, so a decision approved anywhere shows everywhere, and a lane filed from ⌘K or the Manager gets its own page at once. Pages open at `#topic/<id>` and `#lane/<id>`. The development module still has fixed project and lane pages.

Edit the source, never the built files. Rebuild:

```sh
python3 -I docs/design/cockpit/src/build.py          # both modules
python3 -I docs/design/cockpit/src/build.py dev      # one
python3 -I docs/design/cockpit/src/build.py --out /some/preview/dir
```

## The rules the design keeps

These are the parts a native app has to keep. The mockups are the reference for everything else.

### The window

- The window frame and the sidebar never move. Only content areas scroll, and there is no rubber-band bounce.
- Page layout follows the room the page has (container queries), not the window width.
- The left sidebar can be resized by its edge (224 to 380 px). Double-click resets it; arrow keys move it.

### The sidebar

- A row is one icon and one name. No status words, counts, avatars or guide lines on rows.
- A colour mark appears only where it matters: red for stuck, amber for waiting on you, green for working. It shows once, at the deepest visible level: a closed group carries it, an open group's lanes do. Topics and projects carry none. Decisions are counted only on the Decide pin. The state word is kept for screen readers and shows on hover.
- At the top is a pin grid, at most 12 pins (4 by 3). The module brings Brief, Decide, Drafts or Pull requests, and Skills; you can pin topics, projects and skills as one-click macros. A macro pin opens "New lane" with the skill filled in.
- Then one tree: the Manager pinned first, with lanes that fit no project or topic yet under it; then "New lane"; then Projects (development) or Topics (go-to-market), each with its lanes inside. Subagents and artifacts live on a lane's page, not in the tree, so the tree stays two levels deep.
- No destructive controls appear on hover. Removing something (unpin, for example) is in the context menu: right-click, long press on touch, or the menu key / Shift+F10.

### Lanes and the manager

- A lane is one piece of work and has its own page: what was asked in the asker's words, where it stands with the done-means as a checklist, who leads and who helps, what it made, and its own chat.
- The Manager's page lists every lane with its project, lead, state and next report, plus the recent asks and where each one went.
- A new ask is filed under a project with a receipt naming the lead.

### Chat

- Two modes, chosen in the chat's header or in Settings. **Floating** (default): closed until you press Chat, then a card at the bottom right (440 by 720 px, a bottom sheet on a phone) that does not push the page; Escape, the X or changing page closes it. **Sidebar**: always open at full height, resizable by its edge (320 to 640 px), with no Chat button and no close button.
- A page brings its own thread; pages without one share a general thread.
- ⌘K opens the palette: new lane, skills, engines.

### Colour and glass

- Dark only for now. Colour belongs to the workspace: Ink (monochrome) plus seven presets (Ember, Sand, Moss, Tide, Sky, Iris, Rose) and a strength slider (default 55). Each preset keeps Ink's lightness steps in its own hue (OKLCH), so contrast holds. There is no free colour picker.
- Glass is one slider from 0 (off) to 100, next to the colour choice. Default 25 for Ink and 50 for the colour themes; a point under each slider marks the default.
- Glass is cheap by construction: a 64 by 42 px pre-blurred picture of the day's artwork, stretched by the browser, under a veil of the frame colour. No blur filter, no `backdrop-filter`, no running animation.
- Contrast is safe by construction, not by tuning: the veil only moves the frame toward its plain colour, the glass pictures have a fixed lightest tone, and the sidebar's grey text is a step lighter on glass. Any new sidebar text or surface must keep at least 4.5:1 on the lightest spot. Measured across 8 themes, 3 colour strengths, glass full, half and off, and all 14 artworks: lowest 5.10:1.

### Icons and pictures

- UI icons are drawn by hand on a 24-unit grid: one line weight (1.75), exactly one solid part per icon, colour from `currentColor`. They must read at 16 px. UI icons are not generated with an image model.
- The old-artwork look belongs to the brief's pictures only.
- Motion: a slow drift of the brief's picture, a pulse on working dots, a stamp on approve, a check when everything is decided. All of it is off under reduced motion.

## Where this goes next

1. Finish the design in these mockups.
2. A proof of concept of a native Mac app: a native sidebar with real lanes from the hub, a live terminal view, one lane with its own web tabs, and Decide working end to end. It passes only if it uses clearly less energy than a Chromium-based browser over a day, opens instantly from a local copy, and keeps working when the hub drops.
3. A decision record for the native app (stack, how it gets the protocol types, distribution, updates). It supersedes ADR-0006 once accepted.

The web app stays for the phone and for catching up away from the Mac.

## Credits and licences

- The brief's 14 artworks were generated for Morndo with an image model, from prompts describing period styles. `hero-art/heroes.json` lists each one's title, style and alt text.
- Newsreader (The Newsreader Project Authors) and Schibsted Grotesk (The Schibsted-Grotesk Project Authors) are under the SIL Open Font License 1.1; the licence texts are in `src/fonts/`.
- The icons and everything else here are under the repository's licence.
