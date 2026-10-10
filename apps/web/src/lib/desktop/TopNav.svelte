<script lang="ts">
  // Slack's 40px top bar: history buttons end where the sidebar ends; the search box starts there (28px, radius 4).
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import Search from "@lucide/svelte/icons/search";
  import type { RosterEntry } from "@morndo/domain";
  import type { ConnState } from "../feed.svelte.ts";

  let { office, sidebarWidth, workers, status, onPick, searchEl = $bindable(null) }: {
    office: string; sidebarWidth: number; workers: RosterEntry[]; status: ConnState;
    onPick: (id: string) => void; searchEl?: HTMLInputElement | null;
  } = $props();

  let query = $state("");
  let open = $state(false);
  let active = $state(0);
  const hits = $derived(query.trim()
    ? workers.filter(w => `${w.name} ${w.title ?? ""} ${w.location}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8)
    : []);
  const statusText: Record<ConnState, string> = { connecting: "Connecting", live: "Live", reconnecting: "Reconnecting", offline: "Offline", ended: "Signed out" };

  function pick(id: string) { onPick(id); query = ""; open = false; searchEl?.blur(); }
  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") { active = Math.min(active + 1, hits.length - 1); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); e.preventDefault(); }
    else if (e.key === "Enter") { const hit = hits[active]; if (hit) pick(hit.id); }
    else if (e.key === "Escape") { query = ""; searchEl?.blur(); }
  }
</script>

<header class="top">
  <div class="left" style:width="{70 + sidebarWidth}px">
    <button class="hist" aria-label="Back" onclick={() => history.back()}><ArrowLeft size={18} /></button>
    <button class="hist" aria-label="Forward" onclick={() => history.forward()}><ArrowRight size={18} /></button>
  </div>
  <div class="search" class:open={open && hits.length > 0}>
    <Search size={14} />
    <input
      id="top-search"
      bind:this={searchEl}
      bind:value={query}
      placeholder="Search {office}"
      autocomplete="off"
      spellcheck="false"
      onfocus={() => { open = true; active = 0; }}
      onblur={() => setTimeout(() => (open = false), 120)}
      oninput={() => (active = 0)}
      onkeydown={onKey}
    />
    <kbd>Ctrl K</kbd>
    {#if open && hits.length}
      <ul class="hits" role="listbox">
        {#each hits as w, i (w.id)}
          <li role="option" aria-selected={i === active}>
            <button class:active={i === active} onmousedown={() => pick(w.id)}>
              <span class="hash">#</span><strong>{w.name}</strong><span class="muted">{w.title ?? w.location}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  <div class="right">
    <!-- The frame is dark in both themes, so the status pill takes the dark status colours. -->
    <span class="conn {status}" role="status" data-theme="dark">{statusText[status]}</span>
  </div>
</header>

<style>
  .top { display: flex; align-items: center; height: 40px; padding-right: 4px; color: var(--frame-fg); }
  .left { display: flex; justify-content: flex-end; align-items: center; gap: 8px; padding-right: 8px; flex: none; }
  /* The frame is dark in both themes: the ink focus ring would vanish on it, so the bar's frame parts take the frame's
     foreground. Not .search: its results (.hits) sit on the page's surface and keep the page's ring. */
  .left, .right { --morndo-focus-ring: var(--morndo-focus-width) solid var(--frame-fg); }
  .hist {
    width: 28px; height: 28px; border-radius: 4px; border: 0; background: transparent; color: var(--frame-fg);
    display: grid; place-items: center; cursor: pointer;
  }
  .hist:hover { background: var(--frame-hover); }
  .search {
    position: relative; display: flex; align-items: center; gap: 8px;
    width: clamp(300px, 44.85vw, 861px); height: 28px; padding: 5px 5px 5px 12px; border-radius: 4px;
    background: var(--search-bg); color: var(--frame-fg); flex: none;
  }
  .search:hover, .search:focus-within { background: var(--search-bg-hover); }
  .search:focus-within { outline: var(--morndo-focus-width) solid var(--frame-fg); outline-offset: var(--morndo-focus-offset); }
  .search input {
    flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--frame-fg); font: 400 13px/18px var(--font);
  }
  .search input::placeholder { color: var(--frame-fg); }
  kbd { font: 700 11px/1 var(--font); opacity: 0.6; padding: 3px 5px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.25); }
  .hits {
    position: absolute; top: 32px; left: 0; right: 0; z-index: 30; list-style: none; margin: 0; padding: 6px;
    background: var(--main-bg); color: var(--text); border: 1px solid var(--border); border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.16);
  }
  .hits button {
    width: 100%; display: flex; align-items: baseline; gap: 8px; padding: 6px 10px; border: 0; border-radius: 6px;
    background: transparent; color: inherit; font: 400 15px/22px var(--font); text-align: left; cursor: pointer;
  }
  .hits .hash { opacity: 0.6; }
  .hits .muted { font-size: 13px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  /* Text on a tint is full text at full opacity (COLOR.md 8): a tinted result redeclares the muted alias and undims. */
  .hits button:hover, .hits button.active { --muted: var(--text); }
  .hits button:hover .hash, .hits button:hover .muted, .hits button.active .hash, .hits button.active .muted { opacity: 1; }
  .hits button:hover { background: var(--hover); }
  /* The highlighted result is aria-selected: selection plus the ink bar, its 3:1 cue (COLOR.md 8). */
  .hits button.active { background: var(--selected); color: var(--selected-fg); box-shadow: inset 3px 0 0 var(--selected-bar); }
  .right { margin-left: auto; display: flex; align-items: center; gap: 8px; padding-right: 8px; }
  .conn { font: 700 11px/1 var(--font); padding: 5px 8px; border-radius: 999px; background: var(--search-bg); }
  .conn.live { color: var(--morndo-success-text); }
  .conn.reconnecting, .conn.connecting { color: var(--morndo-warning-text); }
  .conn.offline { color: var(--morndo-danger-text); }               /* no network: nothing arrives until it is back */
</style>
