<script lang="ts">
  // The right-hand panel (ADR-0006 addendum "Decisions"), open by default beside every conversation: the decisions.
  // A 49px header like Slack's panels, and a close button.
  import Signpost from "@lucide/svelte/icons/signpost";
  import X from "@lucide/svelte/icons/x";
  import type { Snippet } from "svelte";

  let { waiting, width, children, onClose, onWidth }: {
    waiting: number; width: number; children: Snippet; onClose: () => void; onWidth: (next: number) => void;
  } = $props();

  const MIN = 360;
  const MAX = 640;
  const clamp = (n: number) => Math.min(MAX, Math.max(MIN, n));

  function start(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX, startW = width;
    const move = (ev: PointerEvent) => onWidth(clamp(startW + startX - ev.clientX));
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }
  function key(e: KeyboardEvent) {
    if (e.key === "ArrowLeft") { e.preventDefault(); onWidth(clamp(width + 16)); }
    else if (e.key === "ArrowRight") { e.preventDefault(); onWidth(clamp(width - 16)); }
    else if (e.key === "Home") { e.preventDefault(); onWidth(MIN); }
    else if (e.key === "End") { e.preventDefault(); onWidth(MAX); }
  }
</script>

<aside class="side-panel rp" aria-label="Decisions">
  <div class="grip" role="separator" aria-orientation="vertical" aria-label="Resize the decisions panel"
    aria-valuemin={MIN} aria-valuemax={MAX} aria-valuenow={width} tabindex="0" onpointerdown={start} onkeydown={key}></div>
  <header>
    <Signpost size={18} /><h2 id="decisions-heading" tabindex="-1">Decisions</h2>{#if waiting}<span class="count">{waiting}</span>{/if}
    <button class="x" aria-label="Close the right panel" title="Close the right panel" onclick={onClose}><X size={18} /></button>
  </header>
  {@render children()}
</aside>

<style>
  .rp { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; border-left: 1px solid var(--border); background: var(--main-bg); }
  .grip { position: absolute; left: -2px; top: 0; bottom: 0; width: 4px; cursor: col-resize; z-index: 2; }
  .grip:hover, .grip:focus-visible { background: var(--border-strong); }
  header { height: 49px; display: flex; align-items: center; gap: 8px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--border); flex: none; }
  h2 { margin: 0; font: 900 18px/24px var(--font); }
  .count { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: var(--count-bg); color: var(--count-fg); font: 700 12px/20px var(--font); text-align: center; }
  .x { margin-left: auto; width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: var(--text); display: grid; place-items: center; cursor: pointer; }
  .x:hover { background: var(--hover); }
</style>
