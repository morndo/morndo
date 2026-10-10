# ADR-0007: The brand kit is a shared presentation package, `packages/brand`

- **Status:** Proposed, 2026-10-01.
- **Deciders:** the product lane, on the owner's brief ("Keep original M1. Create the different logo variants and also the svg file for the logo. Also create favicon etc and organize it following ddd in the repo"). The owner may veto.
- **Number:**
  - 0002 is reserved for the product lane's Record ADR.
  - 0003 was proposed and rejected in the product lane (cycle 2026-09-30d), so it is left unused to avoid confusion.
  - 0004 to 0006 are on `feat/web-endpoint`.

## Context

1. **Layout.** [ADR-0005](https://github.com/morndo/morndo/blob/feat/web-endpoint/docs/adr/0005-stack.md) sets the repo out as npm workspaces under strict DDD:
   - `packages/domain` is pure TypeScript, and an architecture test keeps out `node:*` imports and other packages;
   - `apps/hub` holds the application services and adapters;
   - `apps/web` is the SvelteKit app.
2. **The brand has no domain.** `docs/domain.md` has no brand terms, invariants or events. A logo carries no business rule; it is a presentation resource.
3. **It has many consumers.** The web app needs favicons, manifest icons and a header logo. Docs and the README need the logo, store listings need app icons, and later clients (the desktop client of ADR-0006) need the same files. Copying files per consumer would split the source.
4. **It must regenerate.** The owner asked for many variants (positive, negative, `currentColor`, two lockups, an app icon, a maskable icon, the favicon set and a social image). Hand-exporting them would drift from the mark.

## Decision

1. **`packages/brand` (`@morndo/brand`) holds the kit:**

   | Path | Holds |
   |---|---|
   | `source/mark.svg` | **The one source**, on a 48-unit grid |
   | `source/fonts/` | The wordmark font: Outfit, OFL 1.1, unmodified upstream, with its licence |
   | `scripts/build.ts` | The generator, run with Node's type stripping like `apps/hub`. Dev dependencies: sharp and opentype.js. |
   | `assets/` | The generated files, committed |
   | `src/index.ts` | A typed index of asset paths, with no runtime dependencies |
   | `src/tokens.ts` | The colour tokens, from which `assets/tokens/morndo-tokens.css` is generated. Rules: `COLOR.md`. |
   | `test/kit.test.ts` | Picked up by the workspace's `packages/*/test` vitest glob |
   | `USAGE.md` | The usage note |

2. **Dependencies point one way: consumers depend on the brand, never the reverse.**
   - `apps/web` serves `assets/web/` from its static root, by a copy or a build step. It owns that wiring.
   - `packages/domain` never imports the brand, and the brand imports nothing from the domain or the apps.
3. **It is not a bounded context.** There is no ubiquitous language, no aggregate and no invariant. It sits beside the contexts as a shared presentation resource, like a design token set.

## Rejected

- **Only in `apps/web/static/`:** it would tie the kit to one app. The desktop client, the docs and the store listings would copy files, and nothing would regenerate them from the mark.
- **A "Brand" context in `packages/domain`:** there is no domain behaviour to model. It would also break the domain's no-I/O rule and its architecture test.
- **A separate repository:** too much ceremony for one small kit that versions with the product.
- **`docs/brand/`:** docs aren't a package. Apps couldn't depend on it, and the paths would have no types.

## Consequences

- **Committed binaries:** about 0.3 MB of generated PNGs and SVGs plus a 0.1 MB contact sheet. The test catches drift between the index, the files and a fresh build.
- **The npm workspace is on `main` (PR #2, 2026-10-01),** and the package is now a member:
  - its dependencies are in the root lockfile (the nested lock is gone);
  - its tsconfig extends `tsconfig.base.json`;
  - the root `check` runs `tsc -p packages/brand`.
- **The main entry stays browser-safe.** The Node-only helper is the `@morndo/brand/node` subpath, because a template-literal `new URL(…, import.meta.url)` makes Vite bundle the whole package folder.
- **Changing the mark** means editing `source/mark.svg` and running `npm run build -w @morndo/brand`. The usage rules live in `packages/brand/USAGE.md`.
