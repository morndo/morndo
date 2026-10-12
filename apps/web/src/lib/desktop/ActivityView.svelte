<script lang="ts">
  // The principal's inbox: every agent that waits for you, then what finished recently.
  import Bell from "@lucide/svelte/icons/bell";
  import type { RosterEntry } from "@morndo/domain";
  import type { AlertWire } from "@morndo/protocol";
  import Avatar from "./Avatar.svelte";
  import AlertList from "../AlertList.svelte";

  // `alerts`: the fleet's (the owner, 2026-10-12), seen up to `seenAt`; none without a fleet.
  let { workers, onOpen, nameOf, alerts = [], seenAt = 0, onSeen = () => {} }: {
    workers: RosterEntry[]; onOpen: (id: string) => void; nameOf: (w: RosterEntry) => string;
    alerts?: AlertWire[]; seenAt?: number; onSeen?: (at: number) => void;
  } = $props();
  let now = $state(Date.now());
  $effect(() => { const t = setInterval(() => (now = Date.now()), 30_000); return () => clearInterval(t); });
  const waiting = $derived(workers.filter(w => w.needsYou));
  const recent = $derived(workers.filter(w => !w.needsYou && w.lastMessageAt).sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0)).slice(0, 12));
  const ago = (t: number | null) => {
    if (!t) return "";
    const m = Math.round((now - t) / 60_000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
  };
</script>

<section class="act">
  <header><Bell size={18} /><h1>Activity</h1></header>
  <div class="body">
    {#if alerts.length}
      <h2>Alerts from your fleet</h2>
      <AlertList items={alerts} {seenAt} {onSeen} />
    {/if}
    <h2>Waiting for you <span>{waiting.length}</span></h2>
    {#each waiting as w (w.id)}
      <button class="item urgent" onclick={() => onOpen(w.id)}>
        <Avatar name={nameOf(w)} kind={w.name === "manager" ? "peer" : "agent"} />
        <div><strong>{nameOf(w)}</strong><p>{w.title ?? w.location}</p><p class="why">Asked you something, or shows a menu.</p></div>
      </button>
    {:else}
      <p class="empty">Nothing waits for you right now.</p>
    {/each}
    <h2>Latest answers</h2>
    {#each recent as w (w.id)}
      <button class="item" onclick={() => onOpen(w.id)}>
        <Avatar name={nameOf(w)} kind={w.name === "manager" ? "peer" : "agent"} />
        <div><strong>{nameOf(w)}</strong><p>{w.title ?? w.location}</p></div>
        <time>{ago(w.lastMessageAt)}</time>
      </button>
    {/each}
  </div>
</section>

<style>
  .act { display: flex; flex-direction: column; min-height: 0; flex: 1; }
  header { height: 49px; display: flex; align-items: center; gap: 8px; padding: 0 12px 0 18px; border-bottom: 1px solid var(--border); flex: none; }
  h1 { margin: 0; font: 900 18px/24px var(--font); }
  .body { overflow-y: auto; padding: 8px 12px 24px; }
  h2 { font: 700 13px/18px var(--font); color: var(--muted); margin: 16px 8px 6px; }
  h2 span { font-weight: 400; }
  .item {
    width: 100%; display: flex; gap: 12px; align-items: flex-start; padding: 10px 8px; border: 0; border-radius: 8px;
    background: transparent; color: var(--text); text-align: left; cursor: pointer;
  }
  /* Text on a tint is full text (COLOR.md 8): the hovered item redeclares the muted alias, so every muted line follows.
     Status lines (.why) keep their own colour. */
  .item:hover { background: var(--row-hover); --muted: var(--text); }
  .item div { min-width: 0; flex: 1; }
  .item strong { font: 900 15px/22px var(--font); }
  .item p { margin: 0; font: 400 15px/22px var(--font); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item .why { font-size: 13px; color: var(--bad-fg); }
  .item time { font: 400 12px/22px var(--font); color: var(--muted); flex: none; }
  .urgent { box-shadow: inset 3px 0 0 var(--badge); }
  .empty { margin: 4px 8px; color: var(--muted); font: 400 15px/22px var(--font); }
</style>
