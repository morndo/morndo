<script lang="ts">
  // The bar above the Terminal and Desktop tabs: whether you're watching or in control, and the switch between them.
  // Taking control asks for Face ID or Touch ID first unless the last check is fresh (AC9). One row at any width: under
  // 600px the words give way to their icons (still there for screen readers, and still found by name), so the Desktop
  // tab's own tools fit beside them on a phone.
  import Eye from "@lucide/svelte/icons/eye";
  import Hand from "@lucide/svelte/icons/hand";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import X from "@lucide/svelte/icons/x";
  import type { Snippet } from "svelte";

  let { what, control, status, busy, verifiedFresh, note, onTake, onRelease, extra }: {
    what: string; control: boolean; status: "connecting" | "live" | "reconnecting" | "unavailable"; busy: boolean;
    verifiedFresh: boolean; note: string | null; onTake: () => void; onRelease: () => void; extra?: Snippet;
  } = $props();
  const STATUS = { connecting: "Connecting…", live: "Live", reconnecting: "Reconnecting…", unavailable: "Not available" } as const;
</script>

<div class="cb" class:control>
  {#if control}
    <span class="mode on"><Hand size={14} /><span class="lbl">You're in control of {what}</span></span>
    <button class="btn" onclick={onRelease} aria-label="Release control"><span class="ic"><X size={14} /></span><span class="lbl">Release control</span></button>
  {:else}
    <span class="mode"><Eye size={14} /><span class="lbl">Watching {what}</span></span>
    <button class="btn primary" disabled={busy || status !== "live"} onclick={onTake} aria-label="Take control"><span class="ic"><Hand size={14} /></span><span class="lbl">{busy ? "Checking…" : "Take control"}</span></button>
    {#if !verifiedFresh}<span class="hint"><ShieldAlert size={13} /><span class="lbl">Face ID or Touch ID first</span></span>{/if}
  {/if}
  {#if note}<span class="note" role="status">{note}</span>{/if}
  <span class="right">
    {@render extra?.()}
    <span class="status {status}"><i></i><span class="lbl">{STATUS[status]}</span></span>
  </span>
</div>

<style>
  .cb { display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 12px 0 16px; flex: none; border-bottom: 1px solid var(--border); background: var(--main-bg); min-width: 0; container-type: inline-size; }
  .cb.control { background: var(--control-bg); }
  .mode { display: inline-flex; align-items: center; gap: 6px; font: 700 13px/1 var(--font); color: var(--muted); white-space: nowrap; }
  .mode.on { color: var(--ok-fg); }
  .btn { height: 28px; min-height: 28px; padding: 0 12px; border-radius: 6px; border: 1px solid var(--outline); background: var(--main-bg); color: var(--text); font: 700 13px/1 var(--font); cursor: pointer; white-space: nowrap; }
  .btn:hover:not(:disabled) { background: var(--row-hover); }
  .btn.primary { background: var(--send); border-color: var(--send); color: var(--send-fg); }
  .btn.primary:hover:not(:disabled) { background: var(--send-hover); border-color: var(--send-hover); }   /* not the row tint under an ink-fg label */
  .btn:disabled { opacity: 0.5; cursor: default; }
  .hint { display: inline-flex; align-items: center; gap: 4px; font: 400 12px/1 var(--font); color: var(--muted); white-space: nowrap; }
  .note { font: 400 12px/16px var(--font); color: var(--bad-fg); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .right { margin-left: auto; display: flex; align-items: center; gap: 10px; flex: none; }
  .status { display: inline-flex; align-items: center; gap: 6px; font: 700 11px/1 var(--font); color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .status i { width: 7px; height: 7px; border-radius: 50%; background: var(--idle-dot); }
  .status.live { color: var(--ok-fg); }
  .status.live i { background: var(--working); }
  .status.unavailable { color: var(--bad-fg); }
  /* The icons the narrow bar shows instead of the words (wide screens have no use for them). */
  .ic { display: none; }
  /* One row on a phone: the words leave the screen but stay for screen readers and by-name lookup. */
  @container (width < 600px) {
    .cb { gap: 6px; padding: 0 8px 0 10px; }
    .lbl {
      position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden;
      clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
    }
    .ic { display: grid; place-items: center; }
    .btn { padding: 0 7px; }
  }
</style>
