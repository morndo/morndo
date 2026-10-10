<script lang="ts">
  // The right-hand panel (ADR-0006 addendum "Decisions"), open by default beside every conversation: the decisions.
  // A 49px header like Slack's panels, and a close button.
  import Signpost from "@lucide/svelte/icons/signpost";
  import X from "@lucide/svelte/icons/x";
  import type { Snippet } from "svelte";

  let { waiting, children, onClose }: { waiting: number; children: Snippet; onClose: () => void } = $props();
</script>

<aside class="side-panel rp" aria-label="Decisions">
  <header>
    <Signpost size={18} /><strong>Decisions</strong>{#if waiting}<span class="count">{waiting}</span>{/if}
    <button class="x" aria-label="Close the right panel" title="Close the right panel" onclick={onClose}><X size={18} /></button>
  </header>
  {@render children()}
</aside>

<style>
  .rp { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-left: 1px solid var(--border); background: var(--main-bg); }
  header { height: 49px; display: flex; align-items: center; gap: 8px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--border); flex: none; }
  strong { font: 900 18px/24px var(--font); }
  .count { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: var(--count-bg); color: var(--count-fg); font: 700 12px/20px var(--font); text-align: center; }
  .x { margin-left: auto; width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: var(--text); display: grid; place-items: center; cursor: pointer; }
  .x:hover { background: var(--hover); }
</style>
