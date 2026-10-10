<script lang="ts">
  // Slack's 70px tab rail: workspace icon (36px), then 52x68 buttons (36px icon box, 700 11px label).
  import Bell from "@lucide/svelte/icons/bell";
  import House from "@lucide/svelte/icons/house";
  import Laptop from "@lucide/svelte/icons/laptop";
  import MessageCircle from "@lucide/svelte/icons/message-circle";
  import MessagesSquare from "@lucide/svelte/icons/messages-square";
  import Signpost from "@lucide/svelte/icons/signpost";
  import SquareKanban from "@lucide/svelte/icons/square-kanban";

  // "home" is the chats (the conversations, as Slack's Home is); "dashboard" is the Home tab (ADR-0016), the landing view.
  export type View = "home" | "activity" | "board" | "dashboard";
  let { office, view, needsYou, managerUnread, decisions, decisionsOpen, device, blocked = 0, onView, onManager, onDecisions, onPreferences }: {
    office: string; view: View; needsYou: number; managerUnread: boolean; decisions: number; decisionsOpen: boolean; device: string;
    blocked?: number;                                     // ADR-0015: tasks that wait on someone, the Board tab's badge
    onView: (v: View) => void; onManager: () => void; onDecisions: () => void; onPreferences: (tab: "security" | "devices") => void;
  } = $props();
</script>

<nav class="rail" aria-label="Main">
  <button class="team" title={office} onclick={() => onView("dashboard")}>{office.slice(0, 1).toUpperCase()}</button>
  <button class="tab" class:on={view === "dashboard"} onclick={() => onView("dashboard")}>
    <span class="ico"><House size={20} /></span><span class="lbl">Home</span>
  </button>
  <button class="tab" class:on={view === "home"} onclick={() => onView("home")}>
    <span class="ico"><MessagesSquare size={20} /></span><span class="lbl">Chats</span>
  </button>
  <button class="tab" onclick={onManager}>
    <span class="ico"><MessageCircle size={20} />{#if managerUnread}<i class="dot"></i>{/if}</span><span class="lbl">Manager</span>
  </button>
  <button class="tab" class:on={decisionsOpen} onclick={onDecisions} aria-pressed={decisionsOpen}>
    <span class="ico"><Signpost size={20} />{#if decisions}<i class="badge">{decisions}</i>{/if}</span><span class="lbl">Decisions</span>
  </button>
  <button class="tab" class:on={view === "activity"} onclick={() => onView("activity")}>
    <span class="ico"><Bell size={20} />{#if needsYou}<i class="badge">{needsYou}</i>{/if}</span><span class="lbl">Activity</span>
  </button>
  <button class="tab" class:on={view === "board"} onclick={() => onView("board")}>
    <span class="ico"><SquareKanban size={20} />{#if blocked}<i class="badge">{blocked}</i>{/if}</span><span class="lbl">Board</span>
  </button>
  <div class="grow"></div>
  <button class="tab" onclick={() => onPreferences("devices")}>
    <span class="ico"><Laptop size={20} /></span><span class="lbl">Devices</span>
  </button>
  <button class="me" title="{device}: preferences" aria-label="Preferences" onclick={() => onPreferences("security")}>{device.slice(0, 1).toUpperCase()}</button>
</nav>

<style>
  /* The frame is dark in both themes: the ink focus ring would vanish on it, so the rail's ring takes the frame's foreground. */
  .rail {
    width: 70px; flex: none; display: flex; flex-direction: column; align-items: center; padding: 8px 0 12px; color: var(--frame-fg);
    --morndo-focus-ring: var(--morndo-focus-width) solid var(--frame-fg);
  }
  .team {
    width: 36px; height: 36px; border-radius: 8px; border: 0; margin-bottom: 17px; cursor: pointer;
    background: var(--frame-fg); color: var(--frame); font: 900 18px/1 var(--font);
  }
  .tab {
    width: 52px; height: 68px; padding: 8px 0; border: 0; border-radius: 4px; background: transparent; color: var(--frame-fg);
    display: flex; flex-direction: column; align-items: center; gap: 4px; cursor: pointer; text-decoration: none;
  }
  .ico { position: relative; width: 36px; height: 36px; border-radius: 8px; display: grid; place-items: center; transition: background 0.1s; }
  .tab:hover .ico { background: var(--frame-hover); }
  .tab.on .ico { background: var(--frame-active); }
  .lbl { font: 700 11px/12px var(--font); }
  .badge {
    position: absolute; top: -2px; right: -4px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
    background: var(--frame-fg); color: var(--frame); font: 700 11px/18px var(--font); font-style: normal; text-align: center;
    box-shadow: 0 0 0 2px var(--frame);
  }
  .dot { position: absolute; top: 4px; right: 4px; width: 8px; height: 8px; border-radius: 50%; background: var(--frame-fg); box-shadow: 0 0 0 2px var(--frame); }
  .grow { flex: 1; }
  .me {
    width: 36px; height: 36px; border-radius: 8px; margin-top: 8px; display: grid; place-items: center; border: 0; cursor: pointer;
    background: var(--frame-hover); color: var(--frame-fg); font: 900 16px/1 var(--font);
  }
  .me:hover { background: var(--frame-active); }
</style>
