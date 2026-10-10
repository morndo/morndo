<script lang="ts">
  // The chat list (ADR-0011; H1, H2), Signal's way: the manager pinned first, then the lanes with the newest activity on
  // top; each row its name, the time of its last message, one line of preview, and a count only of the messages that
  // matter (answers, questions, files: never tool calls or narration). A lane that waits for him says so. Above the
  // rows: what waits for his call, and the digest he kept for later.
  import Settings from "@lucide/svelte/icons/settings";
  import Pin from "@lucide/svelte/icons/pin";
  import BellOff from "@lucide/svelte/icons/bell-off";
  import type { ConnState } from "../../feed.svelte.ts";
  import { when, type ChatListRow } from "./rows.ts";

  let { rows, status, now, decisions, digestWaiting, onOpen, onDecide, onDigest, onSettings }: {
    rows: ChatListRow[]; status: ConnState; now: number; decisions: number; digestWaiting: boolean;
    onOpen: (worker: string) => void; onDecide: () => void; onDigest: () => void; onSettings: () => void;
  } = $props();
  const STATUS = { connecting: "Connecting", live: "Live", reconnecting: "Reconnecting", offline: "Offline", ended: "Signed out" } as const;
</script>

<section class="list" aria-label="Chats">
  <header class="top">
    <div class="t"><h1>Chats</h1>
      <!-- The chip stays while Live: the phone's ready mark (the Agents list showed it; the fleet tests wait for it). -->
      <span class="conn {status}" role="status"><i></i>{STATUS[status]}{status === "offline" ? ": messages wait on this phone" : ""}</span>
    </div>
    <button class="icon" onclick={onSettings} aria-label="Settings"><Settings size={20} /></button>
  </header>
  {#if decisions}
    <button class="banner you" onclick={onDecide}><b>{decisions === 1 ? "1 decision waits for you" : `${decisions} decisions wait for you`}</b><span>Decide</span></button>
  {/if}
  {#if digestWaiting}
    <button class="banner" onclick={onDigest}><b>While you were away</b><span>Open</span></button>
  {/if}
  <ul>
    {#each rows as r (r.worker)}
      <li>
        <button class="row" class:unread={r.unread > 0} data-chat={r.name} onclick={() => onOpen(r.worker)}
          aria-label="{r.display}{r.offline ? ', offline' : ''}{r.unread ? `, ${r.unread} unread` : ''}{r.needsYou ? ', waits for you' : ''}">
          <span class="avatar" class:quiet={r.name !== "manager"} aria-hidden="true">{r.display.slice(0, 1).toUpperCase()}{#if r.active}<i class="live"></i>{/if}</span>
          <span class="name">{r.display}{#if r.name === "manager"}<Pin size={13} aria-label="pinned" />{/if}{#if r.muted}<BellOff size={13} aria-label="muted" />{/if}</span>
          <time>{r.lastAt ? when(r.lastAt, now) : ""}</time>
          <span class="pre">{#if r.offline}<b class="off">Offline</b>{#if r.needsYou || r.preview}{" · "}{/if}{/if}{#if r.needsYou}<b class="waits">Waits for you</b>{" · "}{/if}{r.preview}</span>
          {#if r.unread}<span class="count" aria-hidden="true">{r.unread > 99 ? "99+" : r.unread}</span>{/if}
        </button>
      </li>
    {:else}
      <li class="empty note">{status === "live" ? "No agents are running in this office." : "Waiting for the hub…"}</li>
    {/each}
  </ul>
</section>

<style>
  .list { flex: 1; display: flex; flex-direction: column; }
  .top {
    position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px; background: var(--bg);
    padding: calc(var(--safe-top) + 10px) max(16px, var(--safe-right)) 8px max(16px, var(--safe-left));
  }
  .t { flex: 1; min-width: 0; display: grid; justify-items: start; gap: 2px; }
  h1 { margin: 0; font: 700 28px/34px var(--display); }
  .icon { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; border: 1px solid var(--edge); background: transparent; color: var(--fg); cursor: pointer; }
  .banner {
    display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 52px; margin: 4px max(12px, var(--safe-right)) 4px max(12px, var(--safe-left));
    padding: 0 16px; border: 1px solid var(--edge); border-radius: 14px; background: var(--surface); color: var(--fg); font: 400 15px/20px var(--body); cursor: pointer; text-align: left;
  }
  .banner.you { background: var(--ink); color: var(--ink-fg); border-color: var(--ink); }
  .banner span { font-weight: 700; text-decoration: underline; text-underline-offset: 3px; }
  ul { list-style: none; margin: 0; padding: 4px 0 16px; }
  .row {
    width: 100%; display: grid; grid-template-columns: 48px 1fr auto; grid-template-rows: auto auto; column-gap: 12px; row-gap: 2px; align-items: center;
    min-height: 72px; padding: 10px max(16px, var(--safe-right)) 10px max(16px, var(--safe-left)); border: 0; background: transparent; color: var(--fg); text-align: left; cursor: pointer;
  }
  .row:active { background: var(--hover); --muted: var(--fg); }
  .avatar { position: relative; grid-row: 1 / 3; width: 48px; height: 48px; border-radius: 24px; font-size: 19px; }
  .live { position: absolute; right: 0; bottom: 0; width: 12px; height: 12px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 2px var(--bg); }
  .name { display: flex; align-items: center; gap: 6px; min-width: 0; font: 700 16px/22px var(--body); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .name :global(svg) { flex: none; color: var(--muted); }
  time { justify-self: end; font: 400 13px/18px var(--body); color: var(--muted); }
  .unread time { color: var(--fg); font-weight: 700; }
  .pre { grid-column: 2; min-width: 0; font: 400 14.5px/20px var(--body); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .unread .pre { color: var(--fg); }
  .waits { color: var(--bad-text); }
  .count { grid-column: 3; justify-self: end; min-width: 22px; height: 22px; padding: 0 7px; border-radius: 11px; background: var(--ink); color: var(--ink-fg); font: 700 12px/22px var(--body); text-align: center; }
  .empty { padding: 32px 20px; text-align: center; }
</style>
