<script lang="ts">
  // The right-hand panel (ADR-0006 addendum "Decisions"), open by default beside every conversation: the decisions.
  // A 49px header like Slack's panels, and a close button.
  import Signpost from "@lucide/svelte/icons/signpost";
  import X from "@lucide/svelte/icons/x";
  import type { Snippet } from "svelte";

  import { RIGHT_MAX, RIGHT_MIN, clampRight } from "./panel-width.ts";

  let { waiting, width, children, onClose, onWidth, onCommit }: {
    waiting: number; width: number; children: Snippet; onClose: () => void;
    onWidth: (next: number) => void; onCommit: (next: number) => void;
  } = $props();

  function start(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX, startW = width;
    const at = (ev: PointerEvent) => clampRight(startW + startX - ev.clientX);
    const move = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) onWidth(at(ev)); };
    const finish = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", finish);
      grip.removeEventListener("pointercancel", finish);
      onCommit(at(ev));
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", finish);
    grip.addEventListener("pointercancel", finish);
  }
  function key(e: KeyboardEvent) {
    const next = e.key === "ArrowLeft" ? width + 16 : e.key === "ArrowRight" ? width - 16 : e.key === "Home" ? RIGHT_MIN : e.key === "End" ? RIGHT_MAX : null;
    if (next === null) return;
    e.preventDefault();
    onCommit(clampRight(next));
  }
</script>

<aside class="side-panel rp" aria-label="Decisions">
  <div class="grip" role="separator" aria-orientation="vertical" aria-label="Resize the decisions panel"
    aria-valuemin={RIGHT_MIN} aria-valuemax={RIGHT_MAX} aria-valuenow={width} tabindex="0" onpointerdown={start} onkeydown={key}></div>
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
