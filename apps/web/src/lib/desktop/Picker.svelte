<script lang="ts" module>
  export type PickerOption = { value: string; label: string; hint?: string; avatar?: { name: string; kind: "agent" | "peer" } };
</script>

<script lang="ts">
  // A picker in the desktop's own look, where a native <select> would show the OS's menu: a button that names the
  // choice, and under it a list like the sidebar's context menu (ContextMenu.svelte), with a check on the chosen one.
  // Controlled: it shows `value`; a pick calls onPick and the owner decides what the value becomes, so a refused pick
  // never sticks. Keyboard: arrows move, Enter picks, Escape closes; a click outside closes.
  import { tick, type Snippet } from "svelte";
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Avatar from "./Avatar.svelte";

  // `pill`: a property pill as in Linear's issue dialog (a 26px capsule with a leading `icon`); the chosen option's
  // avatar takes the icon's place.
  let { value, options, label, onPick, disabled = false, size = "md", placeholder = "Choose…", align = "start", icon }: {
    value: string | null; options: PickerOption[]; label: string; onPick: (value: string) => void;
    disabled?: boolean; size?: "sm" | "md" | "pill"; placeholder?: string; align?: "start" | "end"; icon?: Snippet;
  } = $props();

  let open = $state(false);
  let btn = $state<HTMLButtonElement | null>(null);
  let menu = $state<HTMLDivElement | null>(null);
  let pos = $state({ left: 0, top: 0, width: 220 });
  const current = $derived(options.find(o => o.value === value) ?? null);

  async function show() {
    if (disabled) return;
    open = true;
    await tick();
    const r = btn?.getBoundingClientRect();
    const m = menu?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(r.width, 220, m?.width ?? 0);
    const h = m?.height ?? 240;
    const below = r.bottom + 6 + h <= innerHeight - 8;
    const left = align === "end" ? r.right - width : r.left;
    pos = { left: Math.max(8, Math.min(left, innerWidth - width - 8)), top: below ? r.bottom + 6 : Math.max(8, r.top - 6 - h), width };
    (menu?.querySelector<HTMLButtonElement>("[aria-selected=true]") ?? menu?.querySelector<HTMLButtonElement>("button"))?.focus();
  }
  function close(focusBack = true) { open = false; if (focusBack) btn?.focus(); }
  function pick(o: PickerOption) { close(); onPick(o.value); }
  function onKey(ev: KeyboardEvent) {
    if (!open) return;
    const items = [...(menu?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (ev.key === "Escape") { ev.preventDefault(); close(); }
    else if (ev.key === "ArrowDown") { ev.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (ev.key === "Tab") { ev.preventDefault(); close(); }
  }
</script>

<svelte:window onkeydown={onKey} onresize={() => open && close(false)} />
<!-- type="button": inside a form a plain button would submit it. -->
<button bind:this={btn} type="button" class="pk {size}" class:open aria-label={label} aria-haspopup="listbox" aria-expanded={open} {disabled} onclick={() => (open ? close() : void show())}>
  {#if current?.avatar}<Avatar name={current.avatar.name} kind={current.avatar.kind} size={size === "pill" ? 16 : 18} />{:else if icon}<span class="ico">{@render icon()}</span>{/if}
  <span class="cur" class:ph={!current}>{current?.label ?? placeholder}</span>
  {#if size !== "pill"}<ChevronDown size={14} />{/if}
</button>
{#if open}
  <div class="catcher" role="presentation" onpointerdown={() => close(false)}></div>
  <div class="menu" role="listbox" aria-label={label} bind:this={menu} style:left="{pos.left}px" style:top="{pos.top}px" style:min-width="{pos.width}px">
    {#each options as o (o.value)}
      <button type="button" role="option" aria-selected={o.value === value} class="it" onclick={() => pick(o)}>
        {#if o.avatar}<Avatar name={o.avatar.name} kind={o.avatar.kind} size={20} />{/if}
        <span class="txt">{o.label}{#if o.hint}<small>{o.hint}</small>{/if}</span>
        <span class="mark">{#if o.value === value}<Check size={15} />{/if}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  /* The trigger: a quiet control with a 3:1 edge (COLOR.md 9), the desktop's radius; md matches a field (.bd-in), sm a
     compact button. Focus is the token ring (COLOR.md 3), from the page's own rule; open is the ink edge. */
  .pk {
    display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 8px 0 12px; max-width: 100%; border-radius: var(--radius-md);
    border: 1px solid var(--border-strong); background: var(--main-bg); color: var(--text); font: 400 14px/20px var(--font);
    cursor: pointer; text-align: left; transition: background 0.1s, border-color 0.1s;
  }
  .pk.sm { height: 28px; padding: 0 6px 0 10px; font-size: 13px; border-radius: var(--radius-sm); gap: 6px; }
  .pk.pill { height: 26px; padding: 0 10px 0 8px; gap: 6px; border-radius: 13px; font-size: 12px; line-height: 18px; }
  .pk .ico { display: inline-grid; place-items: center; flex: none; color: var(--muted); }
  .pk :global(svg:last-child) { color: var(--muted); flex: none; }
  .pk:hover:not(:disabled) { background: var(--hover); }
  .pk.open { border-color: var(--link); }
  .pk:disabled { opacity: 0.5; cursor: default; }
  .cur { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cur.ph { color: var(--muted); }
  .catcher { position: fixed; inset: 0; z-index: 40; }
  /* The list: the raised surface over the page with the menu's shadow (COLOR.md 9), rows like the context menu's. */
  .menu {
    position: fixed; z-index: 41; max-height: min(60vh, 420px); overflow-y: auto; padding: 4px; border-radius: var(--radius-md);
    background: var(--menu-bg); color: var(--text); box-shadow: var(--shadow-menu); scrollbar-width: thin;
  }
  .it {
    display: flex; align-items: center; gap: 8px; width: 100%; min-height: 30px; padding: 5px 6px 5px 8px; border: 0; border-radius: var(--radius-sm);
    background: transparent; color: var(--text); font: 400 13px/18px var(--font); text-align: left; cursor: pointer;
  }
  .it .txt { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .it .txt small { font: 400 11px/16px var(--font); color: var(--muted); }
  /* Text on a tint is full text (COLOR.md 8): the row under the pointer or the keyboard redeclares the muted alias. */
  .it:hover, .it:focus-visible { background: var(--menu-hover); color: var(--menu-hover-fg); --muted: var(--menu-hover-fg); outline-offset: -2px; }
  .mark { width: 16px; display: grid; place-items: center; flex: none; color: var(--menu-checked); }
</style>
