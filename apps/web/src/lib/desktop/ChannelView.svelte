<script lang="ts">
  // Slack's channel view: 49px header (padding 0 12px 0 18px, 900 18px/24px name), 38px tab row (700 13px/18px, 2px
  // underline), message pane, composer. For agents: status and working folder in the header, and two more tabs: Desktop
  // (the office's shared desktop over VNC) and Terminal (the agent's tmux pane, live).
  import Folder from "@lucide/svelte/icons/folder";
  import Hash from "@lucide/svelte/icons/hash";
  import MessageSquare from "@lucide/svelte/icons/message-square";
  import PanelRight from "@lucide/svelte/icons/panel-right";
  import Monitor from "@lucide/svelte/icons/monitor";
  import Terminal from "@lucide/svelte/icons/terminal";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Signpost from "@lucide/svelte/icons/signpost";
  import SquareKanban from "@lucide/svelte/icons/square-kanban";
  import type { Snippet } from "svelte";
  import type { Task } from "./board.ts";
  import type { RosterEntry } from "@morndo/domain";
  import type { DecisionItem } from "./decisions.ts";
  import type { ConversationPrefs } from "./present.ts";
  import type { SentFile } from "../attach.ts";
  import type { LiveFeed } from "../feed.svelte.ts";
  import Avatar from "./Avatar.svelte";
  import Composer from "./Composer.svelte";
  import MessageList, { type Outgoing } from "./MessageList.svelte";
  import { ABSENT_MANAGER } from "../manager.ts";
  // Desktop and Terminal carry noVNC and xterm.js: loaded when their tab first opens, so the chat stays light.
  const loadDesktop = () => import("./DesktopView.svelte");
  const loadTerminal = () => import("./TerminalView.svelte");

  let { worker, displayName, feed, outgoing, verifiedAt, stepUpMs, panel, prefs, onDetails, onSecurity, onPanel, onQueue, onRetry, onDiscard, onCancel = () => {},
    onVerify, onEdit, editRequest, onEdited, onVerified, dividerMark = undefined, onAtBottom = () => {}, decisions, decisionsOpen, onDecisions, screenRequest, decisionOf, card, focus, desktop,
    task = null, onOpenTask = () => {}, composerEl = $bindable(null) }: {
    worker: RosterEntry; displayName: string; feed: LiveFeed; outgoing: Outgoing[]; verifiedAt: number | null; stepUpMs: number | null;
    prefs: ConversationPrefs; onDetails: () => void; onSecurity: () => void;
    panel: boolean; onPanel: () => void;
    decisions: number; decisionsOpen: boolean; onDecisions: () => void; screenRequest: { worker: string; n: number } | null;
    desktop: boolean;
    decisionOf: (messageId: string) => DecisionItem | undefined; card: Snippet<[DecisionItem]>; focus: { id: string; n: number } | null;
    onQueue: (c: { target: string; targetName: string; text: string; uploads: string[]; images: string[]; files: SentFile[]; seen: string; held?: string }) => Promise<void>;
    onRetry: (id: string) => void; onDiscard: (id: string) => void; onVerify: (id: string) => void; onEdit: (id: string) => void;
    onCancel?: (id: string) => void;                    // a message the manager's queue still holds (ruling 83)
    editRequest: { worker: string; text: string; n: number } | null; onEdited: () => void; onVerified: (at: number) => void;
    dividerMark?: number | null | undefined; onAtBottom?: (atBottom: boolean, worker: string) => void;
    task?: Task | null; onOpenTask?: (key: string) => void;   // ADR-0015: the task this lane has in progress, by the board
    composerEl?: HTMLTextAreaElement | null;
  } = $props();

  let tab = $state<"messages" | "desktop" | "terminal">("messages");
  $effect(() => { void worker.id; tab = "messages"; });
  // "Answer in its terminal" from a decision opens this worker on its Terminal tab.
  $effect(() => { if (screenRequest && screenRequest.worker === worker.id) tab = "terminal"; });
  const isManager = $derived(worker.name === "manager");
  // The manager while it has no window (a restart): not running. A message waits for it in the fleet's queue when the hub
  // has one on; without it, the box stays shut until it runs again. Its files would go onto its machine: none now.
  const absent = $derived(worker.id === ABSENT_MANAGER);
  const canWrite = $derived(!absent || feed.managerQueue === true);
  const scope = $derived(absent
    ? (canWrite ? "Waits for the manager while it isn't running, up to a day" : "Start the manager to message it")
    : isManager && feed.managerQueue ? "Goes to the manager's queue; typed in once its box is free" : null);
  const stateLabel = $derived(absent ? "Not running" : worker.offline ? "Offline" : worker.needsYou ? "Needs you" : worker.state === "active" ? "Working" : "Idle");
</script>

<section class="chan">
  <header class="vh">
    <div class="name">
      <button class="big" onclick={onDetails} aria-label="{displayName}: conversation details">
        {#if isManager}<Avatar name="Manager" kind="peer" size={24} />{:else}<Hash size={18} />{/if}
        <h1>{displayName}</h1><ChevronDown size={16} />
      </button>
      {#if task}
        <button class="task" onclick={() => task && onOpenTask(task.key)} title="On the board: {task.key}" aria-label="Working on {task.key}: {task.title}"><SquareKanban size={13} /><span class="tk">{task.key}</span><span class="tt">{task.title}</span></button>
      {:else if worker.title}<span class="topic" title={worker.title}>{worker.title}</span>{/if}
    </div>
    <div class="right">
      <span class="state {absent || worker.offline ? 'offline' : worker.needsYou ? 'needs' : worker.state}">{stateLabel}</span>
      {#if isManager}
        <button class="dec" class:on={decisionsOpen} class:has={decisions > 0} onclick={onDecisions} aria-label="Decisions: {decisions} waiting" title="Decisions">
          <Signpost size={15} />{decisions ? `${decisions} to decide` : "Decisions"}
        </button>
      {/if}
      {#if !absent}<span class="loc" title="Working folder"><Folder size={14} />{worker.location}</span>{/if}
      <button class="ib" class:on={panel} onclick={onPanel} aria-pressed={panel} aria-label={panel ? "Hide the right panel" : "Show the right panel"} title={panel ? "Hide the right panel" : "Show the right panel (decisions)"}><PanelRight size={18} /></button>
    </div>
  </header>
  <div class="tabs" role="tablist">
    <button role="tab" aria-selected={tab === "messages"} class:on={tab === "messages"} onclick={() => (tab = "messages")}><MessageSquare size={14} />Messages</button>
    {#if desktop}<button role="tab" aria-selected={tab === "desktop"} class:on={tab === "desktop"} onclick={() => (tab = "desktop")}><Monitor size={14} />Desktop</button>{/if}
    {#if !absent}<button role="tab" aria-selected={tab === "terminal"} class:on={tab === "terminal"} onclick={() => (tab = "terminal")}><Terminal size={14} />Terminal</button>{/if}
  </div>
  {#if tab === "messages"}
    <MessageList {worker} {prefs} messages={feed.historyFor === worker.id ? feed.messages : []} loading={feed.historyFor !== worker.id} {outgoing} {displayName} {decisionOf} {card} {focus}
      {onRetry} {onDiscard} {onVerify} {onEdit} {onCancel} {dividerMark} {onAtBottom}
      older={feed.older} olderPages={feed.olderPages} onOlder={() => feed.loadOlder()} detached={feed.detached} newWhileDetached={feed.newWhileDetached} onLatest={() => feed.latest()} />
    {#if absent}
      <p class="absent" data-absent>{canWrite
        ? "The manager isn't running right now. What you write waits for it, up to a day, and goes in once it runs again."
        : "The manager isn't running. Start it to message it."}</p>
    {/if}
    <!-- One composer per conversation: a draft and its images never carry over to another (a switch drops them). -->
    {#key worker.id}<Composer target={worker.id} targetName={displayName} conversation={worker.name} working={worker.state === "active"} waitingOn={worker.waitingOn} {verifiedAt} {stepUpMs} {onSecurity}
      {onQueue} {onVerified} edit={editRequest?.worker === worker.id ? editRequest : null} {onEdited} bind:inputEl={composerEl}
      closed={!canWrite} noFiles={absent} {scope} />{/key}
  {:else if tab === "desktop"}
    {#await loadDesktop() then m}<m.default {verifiedAt} {onVerified} />{/await}
  {:else}
    {#await loadTerminal() then m}{#key worker.id}<m.default pane={worker.id} name={displayName} {verifiedAt} {onVerified} />{/key}{/await}
  {/if}
</section>

<style>
  .absent { margin: 0 20px 8px; padding: 10px 12px; border-radius: 8px; background: var(--muted-bg); font: 400 13px/18px var(--font); color: var(--muted); }
  .chan { display: flex; flex-direction: column; min-width: 0; min-height: 0; flex: 1; background: var(--main-bg); container-type: inline-size; }
  /* A narrow conversation keeps the name and the state; the folder and the topic give way first. */
  @container (max-width: 720px) { .loc { display: none; } }
  @container (max-width: 560px) { .topic { display: none; } }
  .vh { height: 49px; display: flex; align-items: center; gap: 12px; padding: 0 12px 0 18px; flex: none; }
  .name { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--text); }
  .big {
    display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 4px; margin-left: -4px; border: 0; border-radius: 6px;
    background: transparent; color: var(--text); cursor: pointer; flex: none;
  }
  .big:hover { background: var(--hover); }
  h1 { margin: 0; font: 900 18px/24px var(--font); white-space: nowrap; }
  .topic { margin-left: 6px; font: 400 13px/18px var(--font); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  /* The task in progress, from the board: a chip that opens it. */
  .task {
    margin-left: 6px; display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px; min-width: 0; max-width: 360px;
    border: 1px solid var(--border); border-radius: 12px; background: var(--ok-bg); color: var(--ok-fg); font: 400 13px/18px var(--font); cursor: pointer;
  }
  .task:hover { border-color: var(--border-strong); }
  .task :global(svg) { flex: none; }
  /* The key is one word that must not shrink: a hyphen is a break, so without nowrap "T-18" wraps inside the chip. */
  .task .tk { font: 700 12px/18px var(--mono); white-space: nowrap; flex: none; }
  .task .tt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; color: var(--text); }
  @container (max-width: 560px) { .task { display: none; } }
  .right { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: none; }
  .state { font: 700 12px/1 var(--font); padding: 5px 8px; border-radius: 999px; background: var(--muted-bg); color: var(--text); }
  .state.active { background: var(--ok-bg); color: var(--ok-fg); }
  .state.needs { background: var(--bad-bg); color: var(--bad-fg); }
  .loc { display: inline-flex; align-items: center; gap: 4px; font: 400 13px/1 var(--font); color: var(--muted); max-width: 220px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .dec {
    display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--border);
    background: var(--main-bg); color: var(--text); font: 700 13px/1 var(--font); cursor: pointer;
  }
  .dec:hover { background: var(--hover); }
  .dec.has { border-color: color-mix(in srgb, var(--badge) 40%, transparent); color: var(--bad-fg); }
  .ib { width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--text); cursor: pointer; }
  .ib:hover { background: var(--hover); }
  /* Pressed (its panel is open): the selection tint in full text (COLOR.md 8). Danger text on selection misses Lc 75 in both
     themes, so a pressed "N to decide" keeps the danger colour on its icon, with the state in words (COLOR.md 2). */
  .dec.on, .ib.on { background: var(--selected); color: var(--selected-fg); }
  .dec.has.on :global(svg) { color: var(--bad-fg); }
  .tabs { display: flex; gap: 4px; height: 38px; padding-left: 16px; border-bottom: 1px solid var(--border); flex: none; }
  .tabs button {
    display: inline-flex; align-items: center; gap: 6px; height: 38px; padding: 0 8px; border: 0; border-bottom: 2px solid transparent;
    background: transparent; color: var(--muted); font: 700 13px/18px var(--font); cursor: pointer;
  }
  .tabs button:hover { color: var(--text); }
  .tabs button.on { color: var(--text); border-bottom-color: var(--text); }
</style>
