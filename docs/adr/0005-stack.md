# ADR-0005: Stack for the hub and the web endpoint

- **Status:** Accepted, 2026-09-30. Matches the product lane's Architect default (an internal decision record, §3); ADR-0002 references this stack instead of deciding it again.
- **Versions:** checked live on 2026-09-30 with `fresh npm`, `npm view <pkg> peerDependencies engines`, and nodejs.org.

## Decision

| Part | Choice | Version | Why, with source |
|---|---|---|---|
| Language | TypeScript | 6.0.3 | 7.0.2 is `latest`, but `@sveltejs/kit` 2.70.3 and `svelte-check` 4.7.6 declare `typescript: ^5 \|\| ^6` as a peer (npm registry). Move to 7 when they do. |
| Runtime | Node.js LTS "Krypton" | 24.22.1 | Latest LTS line (https://nodejs.org/dist/index.json: v24.22.1, 2026-10-20, lts "Krypton", security release, read 2026-10-26; 24.21.0 until then; 26.x not LTS yet). Installed with nvm; the machine's default Node is untouched. `.nvmrc` pins it. |
| Front end | SvelteKit in SPA mode with `adapter-static`, Svelte 5 | kit 2.70.3, svelte 5.57.1, adapter-static 3.0.10, vite 8.3.1, vite-plugin-svelte 7.3.1 | Static files served by the hub, no second web server; SPA mode per https://svelte.dev/docs/kit/single-page-apps (its first-load cost matters little for an installed, cached app); service worker support per https://svelte.dev/docs/kit/service-workers. The owner picked it. |
| Passkeys | `@simplewebauthn/server` and `/browser` | 14.0.3 / 14.0.0 | Supported runtimes: Node 22+ and Deno 2.4+ (https://simplewebauthn.dev/docs/packages/server). v14 API: `startRegistration({ optionsJSON })`, `verifyAuthenticationResponse({ credential })`. |
| WebSocket | `ws` | 8.22.0 | `noServer` plus authenticating in the `upgrade` handler, and ping/pong heartbeats, as in its README (https://github.com/websockets/ws). |
| Storage | SQLite via `better-sqlite3`, behind ports | 13.0.3 (2026-08-05) | Engines `node >=22`. `node:sqlite` is still a release candidate per the Architect's check, so it can be swapped in later behind the same ports. |
| Console QR | `qrcode` | 1.5.4 | Renders the pairing QR in the terminal. |
| Tests | vitest | 5.0.3 | Engines `^22.12 \|\| ^24 \|\| >=26`; peer `vite ^8`. |

**Layout:** npm workspaces, strict DDD:

- `packages/domain`: pure TypeScript. No `node:*` imports and no adapters; an architecture test fails the build otherwise.
- `apps/hub`: application services plus adapters (SQLite, tmux, passkeys, HTTP, WebSocket, console).
- `apps/web`: the SvelteKit app.

**Known and accepted (2026-09-30):**
- `npm audit`: 3 low-severity findings, all `cookie <0.7.0` (GHSA-pxg6-pf52-xh8x) pulled in by `@sveltejs/kit` 2.70.3. They concern Kit's server-side cookie helpers; the static SPA build runs no Kit server, and the hub parses cookies itself. Re-check when Kit updates.
- `better-sqlite3` 13 ships prebuilt binaries for linux-x64 (`prebuilds/`), so its `node-gyp rebuild` install script is denied in `allowScripts` (npm 11).
- End-to-end checks use `playwright` 1.63.0 (dev only) with Chromium's virtual WebAuthn authenticator (Chrome DevTools Protocol, `WebAuthn` domain).

## Rejected

- **Next.js 16.3.8:**
  - Static export drops cookies, headers, redirects and Server Actions (https://nextjs.org/docs/app/guides/static-exports).
  - Server mode is a second web server to secure, and its middleware has a run of bypass advisories (for example CVE-2026-44575 and CVE-2026-44573, via OSV).
- **Bun as the hub runtime:** SimpleWebAuthn lists only Node and Deno.
- **TypeScript 7:** its peer ranges don't allow it yet.
