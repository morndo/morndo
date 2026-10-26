<script lang="ts">
  // The status view (ADR-0011, H3): every lane in one line: whether it waits for him, what it is doing, since when. Who
  // waits comes first (the longest wait on top), then who works, then the rest; the manager leads. A tap opens its chat.
  import type { ConnState } from "../../feed.svelte.ts";
  import type { AlertWire } from "@morndo/protocol";
  import { statusRows, type ChatListRow } from "./rows.ts";
  import AlertList from "../../AlertList.svelte";

  // `alerts`: the fleet's (the owner, 2026-10-12), seen up to `seenAt`; none without a fleet.
  let { rows, status, primed, onOpen, alerts = [], seenAt = 0, onSeen = () => {} }: {
    rows: ChatListRow[]; status: ConnState; primed: boolean; onOpen: (worker: string) => void;
    alerts?: AlertWire[]; seenAt?: number; onSeen?: (at: number) => void;
  } = $props();
  const sorted = $derived(statusRows(rows));
  const waits = $derived(rows.filter(r => r.status.kind === "waits").length);
  const working = $derived(rows.filter(r => r.status.kind === "working").length);
  const STATUS = { connecting: "Connecting", live: "Live", reconnecting: "Reconnecting", offline: "Offline", ended: "Signed out" } as const;
</script>

<section class="status" aria-label="Status">
  <header class="top">
    <div><h1>Status</h1>
      <p class="sum">{#if !primed}Waiting for the hub…{:else}{waits ? `${waits} ${waits === 1 ? "waits" : "wait"} for you · ` : "Nothing waits for you · "}{working} working · {rows.length} lanes{/if}</p>
    </div>
    <span class="conn {status}" role="status"><i></i>{STATUS[status]}</span>
  </header>
  {#if alerts.length}
    <h2 class="alerts-head">Alerts from your fleet</h2>
    <AlertList items={alerts} {seenAt} {onSeen} shown={10} />
  {/if}
  <ul>
    {#each sorted as r (r.worker)}
      <li>
        <button class="row {r.status.kind}" data-status={r.name} onclick={() => onOpen(r.worker)}>
          <i class="dot" aria-hidden="true"></i>
          <b>{r.display}</b>
          <span class="since">{r.status.label}</span>
          <span class="line">{r.status.line}</span>
        </button>
      </li>
    {/each}
  </ul>
</section>

<style>
  .alerts-head { margin: 12px 16px 4px; font-size: 13px; font-weight: 800; color: var(--morndo-text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .status { flex: 1; display: flex; flex-direction: column; }
  .top {
    position: sticky; top: 0; z-index: 2; display: flex; align-items: flex-start; gap: 10px; background: var(--bg); border-bottom: 1px solid var(--line);
    padding: calc(var(--safe-top) + 10px) max(16px, var(--safe-right)) 10px max(16px, var(--safe-left));
  }
  .top div { flex: 1; min-width: 0; }
  h1 { margin: 0; font: 700 28px/34px var(--display); }
  .sum { margin: 2px 0 0; font: 400 14px/20px var(--body); color: var(--muted); }
  ul { list-style: none; margin: 0; padding: 4px 0 16px; }
  .row {
    width: 100%; display: grid; grid-template-columns: 12px 1fr auto; column-gap: 12px; row-gap: 2px; align-items: center; min-height: 64px;
    padding: 10px max(16px, var(--safe-right)) 10px max(16px, var(--safe-left)); border: 0; border-bottom: 1px solid var(--line);
    background: transparent; color: var(--fg); text-align: left; cursor: pointer;
  }
  .row:active { background: var(--hover); --muted: var(--fg); }
  .dot { grid-row: 1 / 3; width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--muted); }
  .waits .dot { background: var(--bad); border-color: var(--bad); }
  .working .dot { background: var(--ok); border-color: var(--ok); }
  .blocked .dot { border-color: var(--warn); background: var(--warn); }
  b { font: 700 16px/22px var(--body); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .since { font: 400 13px/18px var(--body); color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .waits .since { color: var(--bad-text); font-weight: 700; }
  .line { grid-column: 2 / 4; font: 400 14.5px/20px var(--body); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .waits .line { color: var(--fg); }
</style>
