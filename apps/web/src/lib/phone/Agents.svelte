<script lang="ts">
  // The phone's Agents tab (ADR-0009; before it, the whole narrow layout): who needs him first, then who is working,
  // and one agent's terminal as read-only text. The live feed is the phone shell's (Phone.svelte).
  import { onDestroy, onMount, tick } from "svelte";
  import type { ConnState, LiveFeed } from "../feed.svelte.ts";
  import { phoneOrder } from "../lanes.ts";

  let { feed, device, open: openFirst = null, onOpened = () => {} }: { feed: LiveFeed; device: string; open?: string | null; onOpened?: () => void } = $props();

  let selected = $state<string | null>(null);
  let now = $state(Date.now());
  let screenEl = $state<HTMLPreElement | null>(null);
  let stickToBottom = true;

  const sorted = $derived(phoneOrder(feed.workers));
  const current = $derived(feed.workers.find(w => w.id === selected) ?? null);
  const activeCount = $derived(feed.workers.filter(w => w.state === "active").length);

  const ago = (t: number) => {
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
  };
  const statusText: Record<ConnState, string> = { connecting: "Connecting", live: "Live", reconnecting: "Reconnecting", offline: "Offline", ended: "Signed out" };

  function open(id: string) {
    selected = id;
    stickToBottom = true;
    feed.watch(id);
    history.pushState({ worker: id }, "", `#${encodeURIComponent(id)}`);
  }
  function back() {
    if (history.state?.worker) history.back();
    else close();
  }
  function close() {
    selected = null;
    feed.watch(null);
  }
  const onPop = () => { if (!history.state?.worker) close(); };
  function onScroll() {
    if (!screenEl) return;
    stickToBottom = screenEl.scrollHeight - screenEl.scrollTop - screenEl.clientHeight < 40;
  }

  $effect(() => {
    void feed.screen?.text;
    if (stickToBottom && screenEl) tick().then(() => screenEl && (screenEl.scrollTop = screenEl.scrollHeight));
  });

  let clock: ReturnType<typeof setInterval>;
  onMount(() => {
    if (openFirst) { open(openFirst); onOpened(); }
    addEventListener("popstate", onPop);
    clock = setInterval(() => (now = Date.now()), 5000);
  });
  onDestroy(() => {
    feed.watch(null);
    removeEventListener("popstate", onPop);
    clearInterval(clock);
  });
</script>

<div class="shell">
  <header>
    {#if current}
      <button class="icon" onclick={back} aria-label="Back to all agents">‹</button>
      <div class="title">
        <strong>{current.name}</strong>
        <span class="muted">{current.location}</span>
      </div>
    {:else}
      <div class="title">
        <strong>Agents</strong>
        <span class="muted">{feed.workers.length} running · {activeCount} active</span>
      </div>
      <a class="icon" href="/devices" aria-label="Devices and sign out">⋯</a>
    {/if}
    <span class="conn {feed.status}" role="status">{statusText[feed.status]}</span>
  </header>

  {#if current}
    <div class="readonly muted">Read-only view · {device}</div>
    <pre class="screen" bind:this={screenEl} onscroll={onScroll}>{feed.screen?.worker === current.id ? feed.screen.text : "Loading the screen…"}</pre>
  {:else}
    <ul class="list">
      {#each sorted as w (w.id)}
        <li>
          <button class:offline={w.offline} onclick={() => open(w.id)}>
            <span class="dot {w.offline ? 'offline' : w.state}" aria-hidden="true"></span>
            <span class="name">{w.name}</span>
            <span class="where muted">{w.location}</span>
            {#if w.offline}<span class="when muted">offline</span>
            {:else if w.needsYou}<span class="when needs">needs you</span>
            {:else}<span class="when muted">{w.state === "active" ? "active" : `quiet ${ago(w.changedAt)}`}</span>{/if}
          </button>
        </li>
      {:else}
        <li class="empty muted">
          {feed.status === "live" ? "No agents are running on this machine." : "Waiting for the hub…"}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .shell { flex: 1; display: flex; flex-direction: column; }
  header {
    position: sticky; top: 0; z-index: 1;
    display: flex; align-items: center; gap: 12px;
    padding: calc(var(--safe-top) + 12px) max(16px, var(--safe-right)) 12px max(16px, var(--safe-left));
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--line);
  }
  .title { display: grid; min-width: 0; flex: 1; }
  .title strong { font-size: 1.15rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .title span { font-size: 0.85rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* A quiet button: transparent with a 3:1 edge; raised is for menus and popovers (COLOR.md 9). */
  .icon {
    display: inline-grid; place-items: center; width: 40px; height: 40px; border-radius: 10px; flex: none;
    background: transparent; color: var(--fg); border: 1px solid var(--edge); font-size: 1.4rem; line-height: 1; text-decoration: none; cursor: pointer;
  }
  /* A neutral chip is the fill with full text; a status in colour sits on its subtle (status text on fill misses Lc 75). */
  .conn { font-size: 0.75rem; font-weight: 600; padding: 4px 8px; border-radius: 999px; background: var(--fill); color: var(--fg); flex: none; }
  .conn.live { color: var(--morndo-success-text); background: var(--morndo-success-subtle); }
  .conn.reconnecting, .conn.connecting { color: var(--morndo-warning-text); background: var(--morndo-warning-subtle); }
  .conn.offline { color: var(--morndo-danger-text); background: var(--morndo-danger-subtle); }
  .list { list-style: none; margin: 0; padding: 8px max(8px, var(--safe-right)) 16px max(8px, var(--safe-left)); display: grid; gap: 2px; }
  .list button {
    width: 100%; display: grid; grid-template-columns: 14px 1fr auto; grid-template-rows: auto auto; column-gap: 12px;
    align-items: center; text-align: left; padding: 12px; border: 0; border-radius: 12px; background: transparent; color: inherit; cursor: pointer;
  }
  /* Text on a tint is full text (COLOR.md 8): the tinted row redeclares the muted alias, so every muted line follows. */
  .list button:hover, .list button:active { background: var(--hover); --muted: var(--fg); }
  .dot { grid-column: 1; grid-row: 1 / 3; width: 10px; height: 10px; border-radius: 50%; background: color-mix(in srgb, var(--muted) 45%, transparent); }
  .dot.active { background: var(--active); box-shadow: 0 0 0 0 var(--active); animation: pulse 1.8s ease-out infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--active) 55%, transparent); } 100% { box-shadow: 0 0 0 8px transparent; } }
  .name { grid-column: 2; grid-row: 1; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .when { grid-column: 3; grid-row: 1; font-size: 0.8rem; justify-self: end; font-variant-numeric: tabular-nums; }
  .when.needs { color: var(--danger-text); font-weight: 700; }
  /* Its machine doesn't answer (fleet core §7): the name in muted text, no pulse, "offline" in place of its state.
     Muted, not faded (phone.css: no opacity); the tinted row turns it to full text (COLOR.md 8). */
  .offline .name { color: var(--muted); }
  .where { grid-column: 2 / 4; grid-row: 2; font-size: 0.85rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { padding: 32px 12px; text-align: center; }
  .readonly { font-size: 0.75rem; padding: 6px 16px; }
  .screen {
    flex: 1; margin: 0 8px calc(env(safe-area-inset-bottom, 0px) + 8px); padding: 12px; border-radius: 12px;
    background: var(--screen-bg); color: var(--screen-fg);
    font: 12px/1.45 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; overflow-y: auto;
    height: calc(100dvh - 186px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));   /* under the tab bar */
  }
</style>
