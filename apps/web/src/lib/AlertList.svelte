<script lang="ts">
  // The fleet's alerts in the app (the owner, 2026-10-12), on the desktop's Activity and the phone's Status: newest
  // first, in words (alerts.ts), the urgent ones marked. Opening the list sees them all (his read mark of SEEN_MARK, on
  // every device); what was new when it opened stays marked new while it is open.
  import { untrack } from "svelte";
  import type { AlertWire } from "@morndo/protocol";
  import { alertWords } from "./alerts.ts";

  let { items, seenAt, onSeen, shown = 20 }: { items: AlertWire[]; seenAt: number; onSeen: (at: number) => void; shown?: number } = $props();
  const newSince = untrack(() => seenAt);
  $effect(() => {
    const newest = items[0]?.at ?? 0;
    if (newest > untrack(() => seenAt)) onSeen(newest);
  });
  const list = $derived(items.slice(0, shown).map(a => ({ a, w: alertWords(a), fresh: a.at > newSince })));
  const when = (t: number) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
</script>

<ul class="alerts" aria-label="Alerts">
  {#each list as { a, w, fresh } (a.id)}
    <li class:urgent={w.urgent} class:fresh data-alert={a.kind}>
      <div><b>{w.title}</b>{#if fresh}<span class="new">New</span>{/if}<p>{w.detail}</p></div>
      <time datetime={new Date(a.at).toISOString()}>{when(a.at)}</time>
    </li>
  {/each}
</ul>

<style>
  .alerts { list-style: none; margin: 0 0 8px; padding: 0; }
  li { display: flex; gap: 12px; align-items: flex-start; padding: 8px 12px; border-radius: 8px; }
  li + li { border-top: 1px solid var(--morndo-divider); border-radius: 0; }
  li.urgent { box-shadow: inset 3px 0 0 var(--morndo-danger); }
  div { min-width: 0; flex: 1; }
  b { font-weight: 800; color: var(--morndo-text); }
  p { margin: 2px 0 0; font-size: 14px; line-height: 20px; color: var(--morndo-text-muted); }
  .new { margin-left: 8px; padding: 0 6px; border-radius: 9px; font-size: 11px; line-height: 18px; font-weight: 700; color: var(--morndo-ink-fg); background: var(--morndo-ink); }
  time { flex: none; font-size: 12px; line-height: 20px; color: var(--morndo-text-muted); }
</style>
