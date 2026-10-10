<script lang="ts">
  // A rounded-square avatar like Slack's (36px, radius 22.222% clamped to 4..12px), shaded from the name.
  // Ink has no decorative hues (packages/brand/COLOR.md 10), so a name picks one of four neutral tiles instead (.t0-.t3).
  import Bot from "@lucide/svelte/icons/bot";
  import Info from "@lucide/svelte/icons/info";
  import type { AuthorKind } from "@morndo/domain";

  let { name, kind = "agent", size = 36 }: { name: string; kind?: AuthorKind; size?: number } = $props();

  const TILES = 4;
  const tile = $derived([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TILES);
  const initials = $derived(name.replace(/^#/, "").split(/[\s_-]+/).filter(Boolean).slice(0, 2).map(p => p[0]?.toUpperCase()).join("") || "?");
</script>

<span
  class="av {kind} t{tile}"
  style:width="{size}px"
  style:height="{size}px"
  style:font-size="{Math.round(size * 0.42)}px"
  aria-hidden="true"
>
  {#if kind === "system"}<Info size={Math.round(size * 0.55)} />
  {:else if kind === "agent" && size >= 28}<Bot size={Math.round(size * 0.5)} />
  {:else}{initials}{/if}
</span>

<style>
  .av {
    border-radius: clamp(4px, min(22.222%, 12px), 12px);             /* Slack's own formula: 8px at 36px */
    display: inline-grid; place-items: center; flex: none; overflow: hidden;
    font-weight: 900; letter-spacing: 0.02em; user-select: none;
    background: var(--tile); color: var(--initials);
  }
  /* The tiles per theme (COLOR.md 10), through light-dark() on the color-scheme tokens.css sets per theme. Light: 600-900
     with ink-fg (white) initials. Dark: 300 and 400 with ink-fg initials, 600 with text initials (500 fails in both). */
  .t0 { --tile: var(--morndo-neutral-600); --initials: light-dark(var(--morndo-ink-fg), var(--morndo-text)); }
  .t1 { --tile: light-dark(var(--morndo-neutral-700), var(--morndo-neutral-400)); --initials: var(--morndo-ink-fg); }
  .t2 { --tile: light-dark(var(--morndo-neutral-800), var(--morndo-neutral-300)); --initials: var(--morndo-ink-fg); }
  .t3 { --tile: light-dark(var(--morndo-neutral-900), var(--morndo-neutral-400)); --initials: var(--morndo-ink-fg); }
  .av.principal { background: var(--you); color: var(--you-fg); }
  .av.peer { background: var(--manager); color: var(--main-bg); }
  .av.system { background: var(--muted-bg); color: var(--text); }
</style>
