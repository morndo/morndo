<script lang="ts" module>
  export type MenuEntry =
    | { kind: "item"; label: string; action: () => void; submenu?: boolean; shortcut?: string; danger?: boolean }
    | { kind: "radio"; label: string; checked: boolean; action: () => void }
    | { kind: "label"; text: string }
    | { kind: "sep" };
</script>

<script lang="ts">
  // Slack's sidebar context menu (measured 2026-10-01): 300px wide, 12px vertical padding, 28px items at 400 15px/28px
  // with 24px side padding, 13px group labels, 1px separators with 8px around, the checked radio in the accent color.
  import { onMount, tick } from "svelte";
  import Check from "@lucide/svelte/icons/check";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";

  let { x, y, entries, onClose, label }: { x: number; y: number; entries: MenuEntry[]; onClose: () => void; label: string } = $props();
  let el = $state<HTMLDivElement | null>(null);
  let pos = $state({ left: 0, top: 0 });

  function run(e: MenuEntry) {
    if (e.kind === "item" || e.kind === "radio") { onClose(); e.action(); }
  }
  function onKey(ev: KeyboardEvent) {
    const items = [...(el?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (ev.key === "Escape") { ev.preventDefault(); onClose(); }
    else if (ev.key === "ArrowDown") { ev.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (ev.key === "Tab") { ev.preventDefault(); }
  }
  onMount(async () => {
    await tick();
    const r = el?.getBoundingClientRect();
    const w = r?.width ?? 300, h = r?.height ?? 300;
    pos = { left: Math.max(8, Math.min(x, innerWidth - w - 8)), top: Math.max(8, Math.min(y, innerHeight - h - 8)) };
    el?.querySelector<HTMLButtonElement>("button")?.focus();
  });
</script>

<svelte:window onkeydown={onKey} onresize={onClose} />
<div class="catcher" role="presentation" onpointerdown={onClose} oncontextmenu={e => { e.preventDefault(); onClose(); }}></div>
<div class="menu" role="menu" aria-label={label} bind:this={el} style:left="{pos.left}px" style:top="{pos.top}px">
  {#each entries as e, i (i)}
    {#if e.kind === "sep"}
      <hr />
    {:else if e.kind === "label"}
      <div class="lbl">{e.text}</div>
    {:else if e.kind === "radio"}
      <button role="menuitemradio" aria-checked={e.checked} class="it radio" class:checked={e.checked} onclick={() => run(e)}>
        <span class="mark">{#if e.checked}<Check size={16} />{/if}</span>{e.label}
      </button>
    {:else}
      <button role="menuitem" aria-haspopup={e.submenu ? "true" : undefined} class="it" class:danger={e.danger} onclick={() => run(e)}>
        <span class="txt">{e.label}</span>
        {#if e.shortcut}<span class="sc">{e.shortcut}</span>{/if}
        {#if e.submenu}<ChevronRight size={16} />{/if}
      </button>
    {/if}
  {/each}
</div>

<style>
  .catcher { position: fixed; inset: 0; z-index: 40; }
  .menu {
    position: fixed; z-index: 41; width: 300px; padding: 12px 0; border-radius: 4px;
    background: var(--menu-bg); color: var(--text);
    box-shadow: 0 0 0 1px var(--border), 0 4px 12px 0 rgba(0, 0, 0, 0.12);
  }
  .it {
    display: flex; align-items: center; gap: 8px; width: 100%; height: 28px; padding: 0 24px; border: 0; background: transparent;
    color: var(--text); font: 400 15px/28px var(--font); text-align: left; cursor: pointer;
  }
  .it .txt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Text on a tint is full text (COLOR.md 8): the item under the pointer or the keyboard redeclares the muted alias, so its
     shortcut follows. */
  .it:hover, .it:focus-visible { background: var(--menu-hover); color: var(--menu-hover-fg); --muted: var(--text); outline-offset: -2px; }
  .it.danger { color: var(--bad-fg); }
  .it.danger:hover, .it.danger:focus-visible { background: var(--bad-bg); color: var(--bad-fg); }
  .radio { padding-left: 4px; }
  .mark { width: 20px; display: grid; place-items: center; flex: none; }
  .radio.checked { color: var(--menu-checked); }
  .radio.checked:hover, .radio.checked:focus-visible { color: var(--menu-hover-fg); }
  .sc { font: 400 13px/1 var(--font); color: var(--muted); }
  hr { border: 0; border-top: 1px solid var(--border); margin: 8px 0; }
  .lbl { padding: 4px 24px 2px; font: 400 13px/18px var(--font); color: var(--muted); }
</style>
