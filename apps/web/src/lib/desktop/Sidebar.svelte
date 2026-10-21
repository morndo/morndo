<script lang="ts">
  // Slack's sidebar: 49px header (900 18px title), 28px filter (radius 8), 28px rows inset 8px (radius 6, 15px/28px),
  // section headings 500 15px with a caret. Sections here follow what agents do: the manager, working, idle.
  // A worker whose machine doesn't answer keeps its row, with a plug icon and the word "offline" (fleet core §7;
  // COLOR.md 2: an icon plus the state in words).
  import Bell from "@lucide/svelte/icons/bell";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Cpu from "@lucide/svelte/icons/cpu";
  import Hash from "@lucide/svelte/icons/hash";
  import ListFilter from "@lucide/svelte/icons/list-filter";
  import Settings from "@lucide/svelte/icons/settings";
  import SquarePen from "@lucide/svelte/icons/square-pen";
  import Signpost from "@lucide/svelte/icons/signpost";
  import Unplug from "@lucide/svelte/icons/unplug";
  import type { RosterEntry, Run } from "@morndo/domain";
  import Avatar from "./Avatar.svelte";
  import { ABSENT_MANAGER } from "../manager.ts";
  import { BACKGROUND_LABEL, inBackground, partitionAgents } from "../lanes.ts";
  import type { ConversationPrefs } from "./present.ts";

  let { office, workers, manager, selected, view, unread, needsYouCount, decisions, decisionsOpen, prefsOf, engines = false, runs = null, onMenu, onSelect, onActivity, onDecisions, onCompose }: {
    office: string; workers: RosterEntry[]; manager: RosterEntry | null; selected: string | null; view: "home" | "activity" | "board" | "dashboard";
    unread: (w: RosterEntry) => boolean; needsYouCount: number; decisions: number; decisionsOpen: boolean; prefsOf: (name: string) => ConversationPrefs;
    engines?: boolean; runs?: ReadonlyMap<string, Run> | null;
    onMenu: (id: string, x: number, y: number) => void;
    onSelect: (id: string) => void; onActivity: () => void; onDecisions: () => void; onCompose: () => void;
  } = $props();
  const ctx = (w: RosterEntry) => (e: MouseEvent) => { e.preventDefault(); onMenu(w.id, e.clientX, e.clientY); };

  let filter = $state("");
  let collapsed = $state<Record<string, boolean>>({});
  const match = (w: RosterEntry) => !filter.trim() || `${w.name} ${w.title ?? ""}`.toLowerCase().includes(filter.trim().toLowerCase());
  const agents = $derived(workers.filter(w => w !== manager && match(w)));
  const parts = $derived(partitionAgents(agents, runs, w => prefsOf(w.name).starred));
  const sections = $derived([
    ...(parts.starred.length ? [{ key: "starred", label: "Starred", items: parts.starred }] : []),
    { key: "working", label: "Working", items: parts.working },
    { key: "idle", label: "Idle", items: parts.idle },
  ]);
  // A working row whose lane waits on its own background work says so beside the name.
  const tagged = (key: string, w: RosterEntry) => key === "working" && inBackground(w, runs);
</script>

<aside class="side" aria-label="Agents">
  <div class="head">
    <button class="title" onclick={onActivity}><span>{office}</span><ChevronDown size={16} /></button>
    <div class="acts">
      {#if engines}<a class="ib" href="/engines" aria-label="Engines" title="Engines: which AI does what"><Cpu size={18} /></a>{/if}
      <a class="ib" href="/devices" aria-label="Devices and settings"><Settings size={18} /></a>
      <button class="ib" aria-label="Message the manager" onclick={onCompose}><SquarePen size={18} /></button>
    </div>
  </div>
  <label class="filter">
    <ListFilter size={14} />
    <input id="sidebar-filter" bind:value={filter} placeholder="Find an agent…" autocomplete="off" spellcheck="false" />
  </label>

  <div class="list">
    <button class="row static" class:sel={view === "activity"} onclick={onActivity}>
      <span class="ic"><Bell size={16} /></span><span class="nm">Activity</span>
      {#if needsYouCount}<span class="badge">{needsYouCount}</span>{/if}
    </button>
    <button class="row static" class:on={decisionsOpen} onclick={onDecisions} aria-pressed={decisionsOpen}>
      <span class="ic"><Signpost size={16} /></span><span class="nm">Decisions</span>
      {#if decisions}<span class="badge">{decisions}</span>{/if}
    </button>
    <hr />

    <div class="sec">
      <button class="sh" onclick={() => (collapsed.dm = !collapsed.dm)} aria-expanded={!collapsed.dm}>
        <span class="caret" class:shut={collapsed.dm}><ChevronDown size={14} /></span>Direct messages
      </button>
      {#if !collapsed.dm && manager}
        <button class="row" class:sel={view === "home" && selected === manager.id} class:unread={unread(manager)} class:muted={prefsOf(manager.name).muted}
          onclick={() => onSelect(manager.id)} oncontextmenu={ctx(manager)}>
          <span class="ic face"><Avatar name="Manager" kind="peer" size={20} /><i class="presence" class:on={manager.state === "active"}></i></span>
          <span class="nm">Manager</span>
          {#if manager.id === ABSENT_MANAGER}<span class="off">not running</span>{:else if manager.offline}<span class="off">offline</span>{/if}
          {#if manager.needsYou}<span class="badge">!</span>{/if}
        </button>
      {/if}
    </div>

    {#each sections as s (s.key)}
      <div class="sec">
        <button class="sh" onclick={() => (collapsed[s.key] = !collapsed[s.key])} aria-expanded={!collapsed[s.key]}>
          <span class="caret" class:shut={collapsed[s.key]}><ChevronDown size={14} /></span>{s.label}
          <span class="count">{s.items.length}</span>
        </button>
        {#if !collapsed[s.key]}
          {#each s.items as w (w.id)}
            <button class="row" class:sel={view === "home" && selected === w.id} class:unread={unread(w)} class:muted={prefsOf(w.name).muted}
              onclick={() => onSelect(w.id)} oncontextmenu={ctx(w)} title={w.title ?? w.location}
              aria-label={tagged(s.key, w) ? `${w.name}, working in the background` : undefined}>
              <span class="ic">{#if w.offline}<Unplug size={16} />{:else if w.state === "active"}<i class="spin"></i>{:else}<Hash size={16} />{/if}</span>
              <span class="nm">{w.name}</span>
              {#if tagged(s.key, w)}<span class="off" title={BACKGROUND_LABEL}>background</span>{/if}
              {#if w.offline}<span class="off">offline</span>{/if}
              {#if w.needsYou}<span class="badge">!</span>{/if}
            </button>
          {/each}
        {/if}
      </div>
    {/each}
  </div>
</aside>

<style>
  .side { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; overflow: hidden; background: var(--sidebar-bg); color: var(--sidebar-fg); }
  .head { height: 49px; padding: 0 8px; display: flex; align-items: center; gap: 4px; flex: none; }
  .title {
    display: flex; align-items: center; gap: 4px; height: 32px; padding: 0 8px; border: 0; border-radius: 6px; min-width: 0;
    background: transparent; color: var(--text); font: 900 18px/24px var(--font); cursor: pointer;
  }
  .title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title:hover { background: var(--hover); }
  .acts { margin-left: auto; display: flex; gap: 6px; }
  .ib { width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--text); cursor: pointer; }
  .ib:hover { background: var(--hover); }
  .filter {
    display: flex; align-items: center; gap: 6px; height: 28px; margin: 0 8px; padding: 0 8px; flex: none;
    border: 1px solid var(--border-soft); border-radius: 8px; background: var(--filter-bg); color: var(--muted);
  }
  .filter input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font: 400 13px/19px var(--font); }
  .list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 10px 0 16px; }
  hr { border: 0; border-top: 1px solid var(--border-soft); margin: 8px 16px; }
  .sec { margin-top: 8px; }
  .sh {
    display: flex; align-items: center; gap: 6px; width: calc(100% - 16px); height: 28px; margin: 0 8px; padding: 0 8px;
    border: 0; border-radius: 6px; background: transparent; color: var(--sidebar-fg); font: 500 15px/28px var(--font); cursor: pointer; text-align: left;
  }
  .caret { display: inline-grid; transition: transform 0.12s; }
  .caret.shut { transform: rotate(-90deg); }
  .count { margin-left: auto; font: 400 12px/1 var(--font); opacity: 0.6; }
  /* Text on a tint is full text at full opacity (COLOR.md 8): a tinted heading or row redeclares the muted aliases, so
     every child follows, and undims its count. */
  .sh:hover { background: var(--hover); --sidebar-fg: var(--text); --muted: var(--text); }
  .sh:hover .count { opacity: 1; }
  .row {
    display: flex; align-items: center; gap: 8px; width: calc(100% - 16px); height: 28px; margin: 0 8px; padding: 0 8px 0 24px;
    border: 0; border-radius: 6px; background: transparent; color: var(--sidebar-fg); font: 400 15px/28px var(--font); cursor: pointer; text-align: left;
  }
  .row.static { padding-left: 16px; }
  .row:hover, .row.sel, .row.on { --sidebar-fg: var(--text); --muted: var(--text); }   /* the same for every tinted row */
  .row:hover { background: var(--hover); }
  .row.unread { color: var(--text); font-weight: 900; }
  /* The open conversation, the current view and the open panel (Decisions): selection plus the 3px ink bar, the state's
     3:1 cue (COLOR.md 8). */
  .row.sel, .row.on { background: var(--selected); color: var(--selected-fg); box-shadow: inset 3px 0 0 var(--selected-bar); }
  .row.muted:not(.sel) { opacity: 0.5; }
  .ic { width: 16px; height: 16px; display: grid; place-items: center; flex: none; position: relative; }
  .ic.face { width: 20px; height: 20px; margin-left: -2px; }          /* the avatar's slot; .av is the avatar itself */
  .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge {
    margin-left: auto; min-width: 18px; height: 18px; padding: 0 6px; border-radius: 9px; background: var(--count-bg); color: var(--count-fg);
    font: 700 12px/18px var(--font); text-align: center; flex: none;
  }
  /* Muted text, which a tinted row turns to full text (COLOR.md 8); a needs-you badge follows it. */
  .off { margin-left: auto; font: 400 12px/18px var(--font); color: var(--muted); flex: none; }
  .off + .badge { margin-left: 0; }
  .presence { position: absolute; right: -3px; bottom: -3px; width: 9px; height: 9px; border-radius: 50%; border: 2px solid var(--sidebar-bg); background: var(--idle-dot); }
  .presence.on { background: var(--working); }
  .spin {
    width: 12px; height: 12px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--working) 30%, transparent);
    border-top-color: var(--working); animation: spin 0.9s linear infinite;
  }
  .row.sel .spin { border-color: color-mix(in srgb, var(--selected-fg) 30%, transparent); border-top-color: var(--selected-fg); }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
