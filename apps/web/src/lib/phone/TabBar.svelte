<script lang="ts" module>
  export type Tab = "chats" | "today" | "status" | "board" | "home";
</script>

<script lang="ts">
  // The phone (ADR-0011), with room for the board (ADR-0015) and Home (ADR-0016): Chats, Today, Status, Board, Home.
  import Activity from "@lucide/svelte/icons/activity";
  import House from "@lucide/svelte/icons/house";
  import MessagesSquare from "@lucide/svelte/icons/messages-square";
  import SquareKanban from "@lucide/svelte/icons/square-kanban";
  import Sunrise from "@lucide/svelte/icons/sunrise";

  let { tab, chats, decisions, blocked = 0, alerts = 0, onTab }: { tab: Tab; chats: number; decisions: number; blocked?: number; alerts?: number; onTab: (t: Tab) => void } = $props();
</script>

<nav class="tabbar" aria-label="Morndo">
  <button class:on={tab === "chats"} aria-current={tab === "chats" ? "page" : undefined} onclick={() => onTab("chats")}
    aria-label={chats ? `Chats, ${chats} unread` : "Chats"}>
    <MessagesSquare size={20} />Chats{#if chats}<span class="badge" aria-hidden="true">{chats}</span>{/if}
  </button>
  <button class:on={tab === "today"} aria-current={tab === "today" ? "page" : undefined} onclick={() => onTab("today")}
    aria-label={decisions ? `Today, ${decisions} to decide` : "Today"}>
    <Sunrise size={20} />Today{#if decisions}<span class="badge" aria-hidden="true">{decisions}</span>{/if}
  </button>
  <button class:on={tab === "status"} aria-current={tab === "status" ? "page" : undefined} onclick={() => onTab("status")}
    aria-label={alerts ? `Status, ${alerts} new ${alerts === 1 ? "alert" : "alerts"}` : "Status"}>
    <Activity size={20} />Status{#if alerts}<span class="badge" aria-hidden="true">{alerts}</span>{/if}
  </button>
  <button class:on={tab === "board"} aria-current={tab === "board" ? "page" : undefined} onclick={() => onTab("board")}
    aria-label={blocked ? `Board, ${blocked} blocked` : "Board"}>
    <SquareKanban size={20} />Board{#if blocked}<span class="badge" aria-hidden="true">{blocked}</span>{/if}
  </button>
  <button class:on={tab === "home"} aria-current={tab === "home" ? "page" : undefined} onclick={() => onTab("home")}><House size={20} />Home</button>
</nav>

<style>
  .tabbar {
    position: sticky; bottom: 0; z-index: 3; margin-top: auto;
    display: grid; grid-template-columns: repeat(5, 1fr); border-top: 1px solid var(--line); background: var(--surface);
    padding: 6px max(10px, var(--safe-right)) var(--safe-bottom) max(10px, var(--safe-left));
  }
  button {
    position: relative; display: grid; justify-items: center; align-content: center; gap: 3px; min-height: 52px; border: 0; background: none;
    color: var(--muted); font: 700 10px/13px var(--body); cursor: pointer;
  }
  button.on { color: var(--fg); }
  button.on::before { content: ""; position: absolute; top: -7px; width: 34px; height: 3px; border-radius: 2px; background: var(--ink); }
  .badge {
    position: absolute; top: 2px; left: calc(50% + 6px); min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
    background: var(--ink); color: var(--ink-fg); font: 700 11px/18px var(--body); text-align: center;
  }
</style>
