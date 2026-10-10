# Wiring the colour tokens into apps/web

This is the note for the web session (2026-10-01), as sent. The rules behind it are in [COLOR.md](COLOR.md).

Colour tokens (palette Ink) are on morndo/morndo PR #1, branch `brand/morndo-mark`, commit `5ec0bb9`. Add `"@morndo/brand": "0.0.0"` to `apps/web/package.json` dependencies, and add `import "@morndo/brand/tokens.css";` to the script of `apps/web/src/routes/+layout.svelte`. In its `:root` block, replace the hex values with aliases: `--bg: var(--morndo-bg)`, `--surface: var(--morndo-surface)`, `--raised: var(--morndo-raised)`, `--fg: var(--morndo-text)`, `--muted: var(--morndo-text-muted)`, `--line: var(--morndo-divider)`, `--accent: var(--morndo-ink)`, `--accent-fg: var(--morndo-ink-fg)`, `--active: var(--morndo-success)`, `--danger: var(--morndo-danger)`, `--screen-bg: var(--morndo-neutral-950)`, `--screen-fg: var(--morndo-neutral-200)`. Then delete the `prefers-color-scheme: dark` block; `tokens.css` handles dark mode and `data-theme`. In `lib/desktop/Desktop.svelte` (`.desk`), apply these aliases:

| Replace | With |
|---|---|
| `--text`, `--muted`, `--muted2` | `--morndo-text`, `--morndo-text-muted` |
| `--main-bg`, `--filter-bg`, `--menu-bg`, `--modal-body` | `--morndo-surface` |
| `--sidebar-bg`, `--composer-bar`, `--code-bg`, `--pre-bg`, `--muted-bg`, `--row-hover` | `--morndo-bg` / `--morndo-raised` |
| `--border`, `--border-soft`, `--code-border`, `--tab-line` | `--morndo-divider` |
| `--border-strong`, `--outline` | `--morndo-border` |
| `--link`, `--menu-checked` | `--morndo-link` (underlined) |
| `--selected`, `--you`, `--menu-hover` | `--morndo-selection`, with `--morndo-text` as their foregrounds |
| `--frame`, `--frame-fg` | `--morndo-neutral-900`, `--morndo-neutral-100` |
| `--working`, `--ok-fg`, `--ok-bg` | `--morndo-success`, `--morndo-success-text`, `--morndo-success-subtle` |
| `--warn-*` | `--morndo-warning-*` |
| `--bad-*`, `--badge` | `--morndo-danger-*` |
| `--manager` | `--morndo-text-muted` |

Remove the orange, blue and navy accents. Ink allows colour only for status (`packages/brand/COLOR.md`). Use `outline: var(--morndo-focus-ring); outline-offset: var(--morndo-focus-offset)` for focus. In `app.html`, update the two `theme-color` metas to `#fbf9f4` (light) and `#0d0f16` (dark).

## Addendum (after the first wiring, 2026-10-01)

The web session reported this, and it is fixed on this branch:

- **`--morndo-focus-ring` inside a `data-theme` subtree.** It used to be declared once on `:root`, so inside a `data-theme` subtree it kept the page theme's colour. It is now declared in each theme block; check it with `test/tokens.test.ts`. The workaround in the web app can go.
- **The same applies to the aliases above.** `--bg: var(--morndo-bg)` and the rest are resolved where they are declared (on `:root` or `.desk`). Where `data-theme="dark"` is set on a subtree (the frame, terminal, screen), either redeclare those aliases on that subtree or use `--morndo-*` directly. See COLOR.md rule 7.

## Addendum 2: UI states (2026-10-02)

These answer the Ink review. The full rules are in COLOR.md, rules 8 to 11.

**New tokens:**

| Token | Light | Dark |
|---|---|---|
| `--morndo-hover` | `#1b18130d` | `#e7e9ef0f` |
| `--morndo-fill` | `#eceae4` | `#22242b` |
| `--morndo-ink-hover` | `#37342f` | `#ced0d6` |

**`--morndo-selection` is stronger:** `#e5e3de` in light, `#292c33` in dark.

**Wiring:**
- Row hover: `--morndo-hover`.
- Tags, code and chips: `--morndo-fill`.
- The open conversation and the selected nav item: `--morndo-selection`, plus a 3px `--morndo-ink` bar on the left.
- Text on all tints: `--morndo-text`.
- Primary button hover: `--morndo-ink-hover`.
- Quiet buttons: transparent with a 1px `--morndo-border` edge.
- Avatars and modal body: see COLOR.md rules 10 and 11.

**`brandAssetUrl()` moved to `@morndo/brand/node`.** The main entry no longer uses `import.meta.url`, so importing `@morndo/brand` in the web app no longer bundles the package folder.

### Update: hover is translucent (2026-10-02)

`--morndo-hover` is now a state layer: the text colour at 5% (light) or 6% (dark).
- **Why:** the opaque dark hover equalled `--morndo-raised`, so it vanished on menus.
- **Effect:** it now shows on bg, surface and raised (1.10-1.16:1), with no wiring change needed.
