<script lang="ts">
  // The modal frame measured from Slack on 2026-10-01: 580px wide, 85% of the window tall, radius 8, a header with a
  // 900 22px/30px title at 28px/20px and a 36px close button, 28px outline action buttons, a 36px tab bar, and a #f8f8f8
  // body (here the Ink surface token). The cards and fields inside follow Slack's details modal (radius 12, fields padded 16px 20px).
  import { onMount, type Snippet } from "svelte";
  import X from "@lucide/svelte/icons/x";

  let { label, onClose, title, actions, tabs, tab = $bindable(), children }: {
    label: string; onClose: () => void; title: Snippet; actions?: Snippet;
    tabs: { id: string; label: string }[]; tab: string; children: Snippet;
  } = $props();
  let closeBtn = $state<HTMLButtonElement | null>(null);
  onMount(() => closeBtn?.focus());
</script>

<svelte:window onkeydown={e => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); onClose(); } }} />
<div class="overlay" role="presentation" onpointerdown={e => { if (e.target === e.currentTarget) onClose(); }}>
  <div class="modal" role="dialog" aria-modal="true" aria-label={label}>
    <header>
      <div class="titlebar">
        <h2>{@render title()}</h2>
        <button class="close" bind:this={closeBtn} onclick={onClose} aria-label="Close"><X size={20} /></button>
      </div>
      {#if actions}<div class="actions">{@render actions()}</div>{/if}
    </header>
    <div class="tabs" role="tablist">
      {#each tabs as t (t.id)}
        <button role="tab" aria-selected={tab === t.id} class:on={tab === t.id} onclick={() => (tab = t.id)}>{t.label}</button>
      {/each}
    </div>
    <div class="body" role="tabpanel">{@render children()}</div>
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; z-index: 60; padding: 28px; display: grid; place-items: center; background: var(--overlay); }
  .modal {
    width: 580px; max-width: 100%; height: min(85vh, 100%); display: flex; flex-direction: column; overflow: hidden;
    border-radius: 8px; background: var(--main-bg); color: var(--text);
    box-shadow: 0 0 0 1px var(--border), 0 18px 48px 0 rgba(0, 0, 0, 0.35);
  }
  header { padding: 20px 20px 8px 28px; flex: none; }
  .titlebar { display: flex; align-items: flex-start; }
  h2 { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; margin: 0; font: 900 22px/30px var(--font); }
  h2 :global(span) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .close { width: 36px; height: 36px; margin-top: -3px; border: 0; border-radius: 8px; background: transparent; color: var(--muted); display: grid; place-items: center; cursor: pointer; }
  .close:hover { background: var(--hover); color: var(--text); }
  .actions { display: flex; gap: 8px; margin-top: 12px; }
  /* Quiet (Revoke, Keep, Sign out here): transparent with a 3:1 edge, also on the recessed body (COLOR.md 9). */
  .modal :global(.ob) {
    display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px 1px; border-radius: 4px;
    border: 1px solid var(--outline); background: transparent; color: var(--text); font: 700 13px/1 var(--font); cursor: pointer;
  }
  .modal :global(.ob:hover) { background: var(--row-hover); }
  .tabs { display: flex; gap: 28px; height: 36px; padding-left: 28px; flex: none; box-shadow: inset 0 -1px 0 0 var(--tab-line); }
  .tabs button {
    height: 36px; padding: 9px 0; border: 0; border-bottom: 2px solid transparent; background: transparent;
    color: var(--muted); font: 700 13px/18px var(--font); cursor: pointer;
  }
  .tabs button.on { color: var(--text); border-bottom-color: var(--text); }
  .tabs button:hover { color: var(--text); }
  .body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 28px; background: var(--modal-body); }
  .body :global(.card) { border: 1px solid var(--border); border-radius: 12px; background: var(--main-bg); overflow: hidden; }
  .body :global(.card + .card) { margin-top: 16px; }
  .body :global(.field) { padding: 16px 20px; display: grid; gap: 2px; }
  .body :global(.field + .field) { border-top: 1px solid var(--border); }
  .body :global(.field strong) { font: 700 15px/22px var(--font); }
  .body :global(.field p) { margin: 0; font: 400 15px/22px var(--font); overflow-wrap: anywhere; }
  .body :global(.field p.ph) { color: var(--muted); }
  .body :global(.field.row) { display: flex; align-items: center; gap: 16px; }
  .body :global(.field.row > div) { flex: 1; min-width: 0; display: grid; gap: 2px; }
  .body :global(.field .note), .body :global(.field.row p) { font-size: 13px; line-height: 18px; color: var(--muted); }
  .body :global(.mono) { font-family: var(--mono); font-size: 13px; }
  .body :global(.opt) { display: flex; gap: 10px; align-items: flex-start; padding: 6px 0; font: 400 15px/22px var(--font); cursor: pointer; }
  .body :global(.opt input) { margin: 4px 0 0; accent-color: var(--send); }
  .body :global(.opt code) { font: 12px/18px var(--mono); padding: 1px 3px; border-radius: 3px; background: var(--code-bg); border: 1px solid var(--code-border); }
  .body :global(.switch) {
    appearance: none; width: 36px; height: 20px; border-radius: 10px; background: var(--border-strong); position: relative; cursor: pointer; flex: none;
    transition: background 0.12s;
  }
  .body :global(.switch::after) { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--main-bg); transition: transform 0.12s; }
  .body :global(.switch:checked) { background: var(--send); }
  .body :global(.switch:checked::after) { transform: translateX(16px); }
  .body :global(.foot) { display: flex; align-items: center; gap: 6px; margin: 16px 20px 0; font: 400 13px/18px var(--font); color: var(--muted); }
  .body :global(.err) { color: var(--bad-fg); font: 400 13px/18px var(--font); margin: 6px 0 0; }
</style>
