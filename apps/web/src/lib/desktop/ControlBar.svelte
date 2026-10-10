<script lang="ts">
  // The bar above the Terminal and Desktop tabs: whether you're watching or in control, and the switch between them.
  // Taking control asks for Face ID or Touch ID first unless the last check is fresh (AC9).
  import Eye from "@lucide/svelte/icons/eye";
  import Hand from "@lucide/svelte/icons/hand";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import type { Snippet } from "svelte";

  let { what, control, status, busy, verifiedFresh, note, onTake, onRelease, extra }: {
    what: string; control: boolean; status: "connecting" | "live" | "reconnecting" | "unavailable"; busy: boolean;
    verifiedFresh: boolean; note: string | null; onTake: () => void; onRelease: () => void; extra?: Snippet;
  } = $props();
  const STATUS = { connecting: "Connecting…", live: "Live", reconnecting: "Reconnecting…", unavailable: "Not available" } as const;
</script>

<div class="cb" class:control>
  {#if control}
    <span class="mode on"><Hand size={14} />You're in control of {what}</span>
    <button class="btn" onclick={onRelease}>Release control</button>
  {:else}
    <span class="mode"><Eye size={14} />Watching {what}</span>
    <button class="btn primary" disabled={busy || status !== "live"} onclick={onTake}>{busy ? "Checking…" : "Take control"}</button>
    {#if !verifiedFresh}<span class="hint"><ShieldAlert size={13} />Face ID or Touch ID first</span>{/if}
  {/if}
  {#if note}<span class="note" role="status">{note}</span>{/if}
  <span class="right">
    {@render extra?.()}
    <span class="status {status}"><i></i>{STATUS[status]}</span>
  </span>
</div>

<style>
  .cb { display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 12px 0 16px; flex: none; border-bottom: 1px solid var(--border); background: var(--main-bg); min-width: 0; }
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
</style>
