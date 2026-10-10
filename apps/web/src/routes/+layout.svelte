<script lang="ts">
  // Lato (OFL-1.1, @fontsource/lato 5.3.0), self-hosted so the CSP stays 'self' (ADR-0006).
  import "@fontsource/lato/400.css";
  import "@fontsource/lato/400-italic.css";
  import "@fontsource/lato/700.css";
  import "@fontsource/lato/900.css";
  // Ink colour tokens (palette "A Ink", packages/brand/COLOR.md): light by default, dark per system or data-theme.
  import "@morndo/brand/tokens.css";
  let { children } = $props();
</script>

{@render children()}

<style>
  /* Layout: one column sized for a phone, a sticky top bar, content that scrolls under it.
     Colours alias the Ink tokens; tokens.css owns dark mode, data-theme and color-scheme. */
  :global(:root) {
    --bg: var(--morndo-bg);
    --surface: var(--morndo-surface);
    --hover: var(--morndo-hover);
    --fill: var(--morndo-fill);                     /* tags, code, chips; text on it is --fg (COLOR.md 8) */
    --edge: var(--morndo-border);                   /* a control's 3:1 boundary */
    --fg: var(--morndo-text);
    --muted: var(--morndo-text-muted);
    --line: var(--morndo-divider);
    --accent: var(--morndo-ink);
    --accent-fg: var(--morndo-ink-fg);
    --active: var(--morndo-success);
    --danger: var(--morndo-danger);
    --danger-text: var(--morndo-danger-text);
    --screen-bg: var(--morndo-neutral-950);
    --screen-fg: var(--morndo-neutral-200);
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  :global(html, body) { margin: 0; height: 100%; }
  :global(body) {
    background: var(--bg);
    color: var(--fg);
    font: 16px/1.5 var(--font);
    -webkit-font-smoothing: antialiased;
    -webkit-tap-highlight-color: transparent;
  }
  :global(*, *::before, *::after) { box-sizing: border-box; }
  :global(button) { font: inherit; }
  :global(:focus-visible) { outline: var(--morndo-focus-ring); outline-offset: var(--morndo-focus-offset); }
  :global(.page) {
    max-width: 40rem;
    margin: 0 auto;
    padding-inline: 16px;
    padding-block: calc(env(safe-area-inset-top, 0px) + 24px) calc(env(safe-area-inset-bottom, 0px) + 32px);
    display: grid;
    gap: 20px;
  }
  :global(.btn) {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    min-height: 48px; padding: 0 20px; border-radius: 12px; border: 0; cursor: pointer;
    background: var(--accent); color: var(--accent-fg); font-weight: 600;
  }
  :global(.btn:disabled) { opacity: 0.55; cursor: default; }
  /* Quiet (Revoke, Keep, Sign out): a secondary button, transparent with a 3:1 edge (COLOR.md 9). */
  :global(.btn.quiet) { background: transparent; color: var(--fg); border: 1px solid var(--edge); font-weight: 500; }
  :global(.btn.danger) { background: transparent; color: var(--danger-text); border: 1px solid var(--danger); }
  :global(.error) { color: var(--danger-text); margin: 0; }
  :global(.muted) { color: var(--muted); }
  :global(h1) { font-size: 1.6rem; line-height: 1.2; margin: 0; letter-spacing: -0.01em; text-wrap: balance; }
  :global(p) { margin: 0; }
  :global(code) { font-family: var(--mono); font-size: 0.9em; background: var(--fill); color: var(--fg); padding: 1px 5px; border-radius: 5px; }
  @media (prefers-reduced-motion: reduce) {
    :global(*) { animation: none !important; transition: none !important; }
  }
</style>
