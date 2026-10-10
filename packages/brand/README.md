# @morndo/brand

**What it is:** Morndo's brand kit (the mark, wordmark, lockups, app icons, favicon set and social image) and the script that makes it.
- **Not domain code.** It is a shared, presentation-level asset kit; see [ADR-0007](../../docs/adr/0007-brand-kit-as-shared-presentation-package.md).
- **How to use it:** [USAGE.md](USAGE.md) covers clear space, minimum sizes, colours, do's and don'ts, the font licence and the look-alike note.
- **UI colour:** [COLOR.md](COLOR.md) covers the tokens (palette "Ink"), the rules and the research behind them.

![Contact sheet](preview/contact-sheet.png)

## Layout

| Path | What |
|---|---|
| `source/mark.svg` | **The one source:** the mark on a 48-unit grid, as a square XOR sun XOR horizon band with fill-rule evenodd. |
| `source/fonts/` | Outfit (OFL 1.1), unmodified upstream, used to outline the wordmark. `OFL.txt` sits beside it. |
| `scripts/build.ts` | The generator. Every SVG is written from the source path data; every PNG is rasterised from those SVGs with sharp; `favicon.ico` is written by hand from the 16/32/48 PNGs. |
| `assets/` | The generated files, committed. `assets/web/` is exactly what the web app serves from its static root. |
| `src/index.ts` | The browser-safe entry: a typed index of every asset path (`brandAssets`, `BrandAssetPath`), `brandColors`, and the colour tokens. |
| `src/node.ts` | Node-only: `brandAssetUrl()`, imported as `@morndo/brand/node`. It is kept out of the main entry so that Vite doesn't bundle the package folder (`test/entry.test.ts`). |
| `src/tokens.ts` | The colour tokens: the neutral ramp, and light and dark semantic tokens, typed (`themes`, `neutral`, `cssVar`). `scripts/build.ts` writes `assets/tokens/morndo-tokens.css` from it. |
| `test/tokens.test.ts` | WCAG 2.2 and APCA for every text and UI pair in both themes, plus the lightness and "colour only for status" rules. |
| `test/kit.test.ts` | Checks that the index and the files agree, that every PNG has its exact size, that the ICO holds 16/32/48, that the manifest is valid, that every SVG renders, and that a fresh build gives the same SVGs. |
| `preview/contact-sheet.png` | All variants on one sheet, for review. |

## Regenerate

Edit `source/mark.svg`, the font or the proportions at the top of `scripts/build.ts`, then run:

```sh
npm ci                              # at the repo root (npm workspace)
npm run build -w @morndo/brand      # or, in packages/brand: node scripts/build.ts
npx vitest run packages/brand       # or the whole suite: npm test
```

Requirements: Node ≥ 24.12 (`.nvmrc` at the repo root), which runs the TypeScript scripts directly. The package is an npm workspace member, so its dependencies live in the root lockfile.

## Use it

**Web app.** Copy `assets/web/*` into the app's static root, and paste `assets/web/head.html` into the document head. `site.webmanifest` is a snippet: merge its `icons` into the app's own manifest.

**Colours:** `import "@morndo/brand/tokens.css"` once, then use `var(--morndo-…)`. See COLOR.md.

**Node code:**

```ts
import { brandAssets } from "@morndo/brand";
import { brandAssetUrl } from "@morndo/brand/node";

const logo = brandAssetUrl(brandAssets.lockupHorizontal.currentColor); // file URL
```

## Notes

- **Workspace member:** the dependencies are in the root lockfile, the tsconfig extends `tsconfig.base.json`, and the root `check` runs `tsc -p packages/brand`.
- **The maskable icon is full bleed.** The sun's farthest point is 37.5% of the side from the centre, inside the 40% safe zone of the W3C Web App Manifest. The horizon runs to the edge on purpose.
