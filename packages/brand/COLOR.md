# Morndo colour: "Ink"

**Ink is monochrome.** Hierarchy comes from lightness steps and space. The light theme is warm morning paper and the dark theme cool night ink. **Colour is only for status.** The owner picked it on 2026-10-01, from the product lane's colour round 2.

## Use it

1. Import `@morndo/brand/tokens.css` once per app. It holds the CSS custom properties.
2. Style with `var(--morndo-…)`. In TypeScript: `import { themes, cssVar } from "@morndo/brand"`.

For wiring the tokens into `apps/web`, see [WIRING-web.md](WIRING-web.md).

**Theme switching:**
- light by default;
- dark follows `prefers-color-scheme`;
- `data-theme="light"` or `data-theme="dark"` on `<html>`, or on any subtree, overrides it.

| Token | Light | Dark | For |
|---|---|---|---|
| `--morndo-bg` | `#fbf9f4` | `#0d0f16` | page background |
| `--morndo-surface` / `--morndo-raised` | `#ffffff` / `#ffffff` | `#14171e` / `#1c1f26` | cards and inputs / menus and popovers |
| `--morndo-divider` | `#e2dfda` | `#2c2f36` | decorative rules (no contrast requirement) |
| `--morndo-border` | `#82807c` | `#979ba4` | boundaries that identify a control (3:1) |
| `--morndo-text` / `--morndo-text-muted` | `#1b1813` / `#66635d` | `#e7e9ef` / `#cdd0d8` | body / secondary |
| `--morndo-placeholder` | `#76726c` | `#9b9ea7` | input placeholder |
| `--morndo-ink` / `--morndo-ink-fg` | `#1b1813` / `#ffffff` | `#e7e9ef` / `#0d0f16` | primary button and its label (`--morndo-accent` is an alias) |
| `--morndo-ink-hover` | `#37342f` | `#ced0d6` | primary button on hover: ink moved toward the page (85% / 90% ink) |
| `--morndo-link` | `#1b1813` | `#e7e9ef` | links: ink, underlined |
| `--morndo-hover` | `#1b18130d` | `#e7e9ef0f` | row or item under the pointer: a translucent state layer, so it shows on bg, surface and raised (menus) alike |
| `--morndo-fill` | `#eceae4` | `#22242b` | quiet fill: tags, code, chips |
| `--morndo-selection` | `#e5e3de` | `#292c33` | selected row or item, plus a 3px ink bar |
| `--morndo-focus` | `#1b1813` | `#e7e9ef` | focus ring (`--morndo-focus-ring` = 2px solid) |
| `--morndo-success` / `-warning` / `-danger` | `#008779` / `#ca7400` / `#af283d` | `#3dc8b5` / `#ffd1a9` / `#f46974` | status icon or dot |
| `--morndo-*-text` | `#006a5e` / `#915100` / `#97042a` | `#97eadc` / `#ffe2ca` / `#ffc2c3` | a status written in colour |
| `--morndo-*-subtle` | `#eafcf8` / `#fff6ee` / `#fff5f4` | `#0a2723` / `#311c08` / `#361618` | status banner or chip background |

The neutral ramp is also available as `--morndo-neutral-50` to `--morndo-neutral-950`.

## Rules

1. **Colour only for status.** Primary actions, links, selection, badges and focus are ink. Don't add a brand hue, and don't use the status colours for decoration. A test enforces this: every non-status token has OKLCH chroma below 0.02.
2. **Status is an icon or dot in the indicator colour, plus the state in words.** Colour is never the only cue. Use `*-text` only when the state itself is written in colour, and `*-subtle` for banner backgrounds.
3. **Focus ring:** `outline: var(--morndo-focus-ring); outline-offset: var(--morndo-focus-offset)`. That is 2px solid with a 2px offset, at least 3:1 against both the page and the component (WCAG 2.4.13, 1.4.11). Never remove it.
4. **Two contrast gates, both themes.** `test/tokens.test.ts` fails if any pair drops below its target:

   | Pair | WCAG 2.2 | APCA \|Lc\| |
   |---|---|---|
   | Body text | 7:1 | 90 light, 85 dark |
   | Secondary text, links, button labels, status text | 4.5:1 | 75 |
   | Text on a tint (hover, fill, selection) | 7:1 | 85 (these are row labels; 75 is the label floor, and we keep a 10-point margin) |
   | Placeholder | 4.5:1 | 45 |
   | Status indicators, control borders, focus ring | 3:1 | 45 |

5. **Lightness:**
   - Dark background: L\* 4-10, never `#000`.
   - Dark body text: L\* 88-94, never `#fff`.
   - Light background: L\* 97-100.
   - Dividers: 1.2-2.1:1, quiet but visible.
6. **To change a colour:** edit `src/tokens.ts`, run `npm run build -w @morndo/brand` (it rewrites `assets/tokens/morndo-tokens.css`), then run `npx vitest run packages/brand`.
7. **Aliases follow the theme only where they are declared.** A custom property such as `--bg: var(--morndo-bg)` is resolved where it is declared, and children inherit the resolved value. If you alias tokens on `:root` or on a component and then set `data-theme` on a subtree, either redeclare the aliases on that subtree or use `--morndo-*` directly there. The tokens CSS does this itself: it declares `--morndo-focus-ring` in every theme block.
8. **Tints, from light to strong: hover < fill < selection.** A test checks the order in both themes, on bg and surface; for hover also on raised.
   - Hover is a state layer: the text colour at 5% (light) or 6% (dark) opacity, the same idea as Material 3's state layers (hover 8% there). Because it sits on top of whatever it hovers, it never vanishes on a menu.
   - Text on any tint is `--morndo-text`, never muted: muted text can't reach Lc 75 on a visible tint.
   - The selected or open item also gets a 3px `--morndo-ink` bar on its leading edge. That is the state cue at 3:1 or more (WCAG 1.4.11); the tint only supports it.
9. **Quiet controls:** a quiet button (Revoke, Keep, Sign out) is transparent with a 1px `--morndo-border` edge, like a secondary button. `--morndo-raised` is for popovers and menus (white with a shadow in light), not for buttons.
10. **Avatars use the neutral ramp, never hues.**
    - Light: tiles 600-900 with white initials.
    - Dark: tiles 300 and 400 with `--morndo-ink-fg` initials, and 600 with `--morndo-text` initials. Skip 500: initials fail on it in both colours.
    - The principal: an `--morndo-ink` tile with `--morndo-ink-fg` initials.
11. **Recessed areas** (a modal body under cards, the composer bar) use `--morndo-bg` in both themes. Cards on them stay `--morndo-surface` with a `--morndo-divider` edge. In dark, elevation means lighter, so a card stays above its surroundings.

## Why (research summary)

Full memos, with all sources checked 2026-10-01, stay in an internal decision record.

- **In premium tools, colour covers under 1% of the screen.** We measured Linear, Vercel, Cursor, Raycast, Things, xAI/Grok and Anthropic:
  - where there is an accent, it is small, at near-maximum chroma and in one hue;
  - primary buttons are black or white;
  - so the neutral ramp, spacing and contrast set the impression, not the accent hue.
- **Lightness and saturation are the levers with the best evidence.** Hue meanings are mostly weak associations (Valdez & Mehrabian 1994; Jonauskaite & Mohr 2025 review).
- **Colour draws attention only when it is rare and different** (Wolfe & Horowitz 2017; Theeuwes 1992). That is why Ink keeps colour for status.
- **Red and orange signal danger** (Braun & Silver 1995), so they are kept for states.
- **WCAG 2 overstates dark-mode contrast.** 4.5:1 is only about Lc 33 on `#121212`, so APCA is the second gate (apca-w3 0.1.9).
  - APCA is not part of the WCAG 3 draft; its working draft of 2026-09-10 leaves the contrast method open.
  - WCAG 2.2 stays the conformance standard.
- **Dark mode:** grey, not black (Material). Dark-on-light reads better for small text (Piepenbrock et al. 2013, 2014), so the light theme is first-class.
- **Focus:** a solid 2px ring at 3:1 (WCAG 2.2 SC 2.4.13 and 1.4.11). Inputs need a 3:1 boundary; decorative dividers have no requirement (Understanding 1.4.11).

## Notes

- **APCA in this repo:** the test imports the official `apca-w3` package (0.1.9) unmodified, as a dev-only dependency.
  - Its licence permits predicting contrast for web content in support of WCAG.
  - No APCA code is copied, ported or shipped.
  - If the owner prefers no APCA dependency, replace it with a recorded snapshot of the Lc values.
- **Provenance:** the values come from the product lane's palette tool (OKLCH ramps, palette "A Ink", round 2), and a check confirmed all 59 values match it.
