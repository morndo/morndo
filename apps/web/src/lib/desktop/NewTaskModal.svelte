<script lang="ts">
  // Filing a task (ADR-0015), as Linear's "New issue" dialog and Spotlight's pill: one dialog over the board, high on
  // the page, the title first (focused), a line for what done means, the task's properties as pills (the column, the
  // priority, the lane), and File it. The dialog owns the draft; the board owns the filing (onCreate).
  // Keyboard: Ctrl or Cmd plus Enter files; Enter alone never does (in the title it moves on to the description).
  // Escape, the X and a click on the overlay close it, but what was typed is never lost to one of them: a dirty draft
  // asks first. Focus stays inside (Tab wraps), and goes back to what opened the dialog when it closes. "File another"
  // keeps it open for the next task with the same column, priority and lane.
  import { onMount, untrack } from "svelte";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import CircleUserRound from "@lucide/svelte/icons/circle-user-round";
  import Columns3 from "@lucide/svelte/icons/columns-3";
  import Flag from "@lucide/svelte/icons/flag";
  import SquareKanban from "@lucide/svelte/icons/square-kanban";
  import X from "@lucide/svelte/icons/x";
  import Picker, { type PickerOption } from "./Picker.svelte";
  import StatusIcon from "./StatusIcon.svelte";
  import { COLUMNS, FILEABLE, PRIORITY_OPTIONS, type Task, type TaskStatus } from "./board.ts";
  import "./board-controls.css";

  let { status = "", assignOptions, onCreate, onClose }: {
    status?: "" | TaskStatus;                             // the column a + was pressed on; empty: where it fits
    assignOptions: PickerOption[];                        // the lanes, "Nobody yet" first, "Another lane…" last
    onCreate: (body: Record<string, unknown>) => Promise<string | null>;
    onClose: () => void;
  } = $props();

  // The column the dialog opened on is its starting point only: the Column pill may change it, the prop never does.
  let draft = $state({ title: "", description: "", assignee: "", priority: "normal" as Task["priority"], status: untrack(() => status) });
  let otherLane = $state(false);                        // "Another lane…" picked: a name is typed instead
  let more = $state(false);                             // keep the dialog open after filing, for the next task
  let discarding = $state(false);                       // asked whether to drop what was typed
  let error = $state<string | null>(null);
  let busy = $state(false);
  let titleEl = $state<HTMLInputElement | null>(null);
  let descEl = $state<HTMLTextAreaElement | null>(null);
  let dialog = $state<HTMLElement | null>(null);

  const COLUMN_OPTIONS: PickerOption[] = [{ value: "", label: "Where it fits", hint: "To do when assigned, else Backlog" },
    ...COLUMNS.filter(c => FILEABLE.includes(c.status)).map(c => ({ value: c.status, label: c.label, hint: c.hint }))];
  const dirty = $derived(draft.title.trim().length > 0 || draft.description.trim().length > 0);
  const canFile = $derived(!busy && draft.title.trim().length > 0);

  // Focus: on the title when the dialog opens; back on what opened it (New task, a column's +) when it closes.
  onMount(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    titleEl?.focus();
    return () => opener?.focus();
  });
  const listOpen = () => !!dialog?.querySelector("[role=listbox]");   // a pill's list: its own Escape and Tab
  const focusables = () => [...(dialog?.querySelectorAll<HTMLElement>("input, textarea, button:not(:disabled)") ?? [])].filter(el => el.offsetParent !== null);

  // Leaving: a dirty draft asks first; asking again while asked goes back to writing (Escape never discards by itself).
  function leave() {
    if (!dirty) { onClose(); return; }
    discarding = !discarding;
  }
  async function file() {
    if (!canFile) return;
    busy = true; error = null;
    try {
      const body: Record<string, unknown> = { title: draft.title, description: draft.description, priority: draft.priority };
      if (draft.assignee.trim()) body.assignee = draft.assignee.trim();
      if (draft.status) body.status = draft.status;
      const why = await onCreate(body);
      if (why) { error = why; return; }
      if (!more) { onClose(); return; }
      draft.title = ""; draft.description = ""; discarding = false;   // the next one: the same column, priority and lane
      titleEl?.focus();
    } finally { busy = false; }
  }
  function onKey(e: KeyboardEvent) {
    if (e.defaultPrevented || listOpen()) return;
    if (e.key === "Escape") { e.preventDefault(); leave(); }
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void file(); }
    else if (e.key === "Tab") {
      const items = focusables();
      const first = items[0], last = items[items.length - 1];
      if (!first || !last) return;
      const inside = dialog?.contains(document.activeElement) ?? false;
      if (!inside) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  // Enter in a text field submits a form on its own; here it doesn't: the title hands on to the description.
  const noSubmit = (next?: HTMLElement | null) => (e: KeyboardEvent) => { if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); next?.focus(); } };
</script>

{#snippet columnIcon()}{#if draft.status}<StatusIcon status={draft.status} size={14} />{:else}<Columns3 size={14} />{/if}{/snippet}
{#snippet flagIcon()}<Flag size={13} />{/snippet}
{#snippet laneIcon()}<CircleUserRound size={14} />{/snippet}

<svelte:window onkeydown={onKey} />
<div class="overlay" role="presentation" onpointerdown={e => { if (e.target === e.currentTarget) leave(); }}>
  <div class="dialog" role="dialog" aria-modal="true" aria-label="New task" tabindex="-1" bind:this={dialog}>
   <form class="body" onsubmit={e => { e.preventDefault(); void file(); }}>
    <header>
      <span class="crumb"><span class="where"><SquareKanban size={13} />Board</span><ChevronRight size={13} /><span>New task</span></span>
      <button class="bd-btn ghost icon sm" type="button" aria-label="Close the form" title="Close (Esc)" onclick={leave}><X size={16} /></button>
    </header>
    <input class="ttl" bind:this={titleEl} bind:value={draft.title} aria-label="Title" placeholder="What, in one line" maxlength="120" autocomplete="off" spellcheck="true" required onkeydown={noSubmit(descEl)} />
    <textarea class="desc" bind:this={descEl} bind:value={draft.description} aria-label="Description" rows="3" placeholder="What done means: the check the lane runs before it says so"></textarea>
    <div class="pills">
      <Picker value={draft.status} options={COLUMN_OPTIONS} label="Column" size="pill" icon={columnIcon} onPick={v => (draft.status = v as "" | TaskStatus)} />
      <Picker value={draft.priority} options={PRIORITY_OPTIONS} label="Priority" size="pill" icon={flagIcon} onPick={v => (draft.priority = v as Task["priority"])} />
      {#if otherLane}
        <span class="other"><input class="bd-in sm" bind:value={draft.assignee} aria-label="Lane name" placeholder="lane name" onkeydown={noSubmit()} /><button class="bd-btn ghost sm" type="button" onclick={() => { otherLane = false; draft.assignee = ""; }}>Pick one</button></span>
      {:else}
        <Picker value={draft.assignee} options={assignOptions} label="Assign to" size="pill" icon={laneIcon} onPick={v => { if (v === "__other") { otherLane = true; draft.assignee = ""; } else draft.assignee = v; }} />
      {/if}
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <footer>
      {#if discarding}
        <span class="ask" role="status">Discard what you typed?</span>
        <span class="grow"></span>
        <button class="bd-btn ghost sm" type="button" onclick={() => (discarding = false)}>Keep writing</button>
        <button class="bd-btn sm" type="button" onclick={onClose}>Discard</button>
      {:else}
        <label class="more"><input class="switch" type="checkbox" role="switch" bind:checked={more} />File another</label>
        <span class="grow"></span>
        <kbd title="Files the task">{navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl"} ↵</kbd>
        <button class="bd-btn primary" type="submit" disabled={!canFile}>File it</button>
      {/if}
    </footer>
   </form>
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; z-index: 60; padding: 12vh 24px 24px; display: flex; justify-content: center; align-items: flex-start; background: var(--overlay); }
  .dialog {
    width: 720px; max-width: 100%; max-height: 100%; overflow-y: auto; padding: 12px 16px 12px;
    border-radius: var(--radius-lg); background: var(--main-bg); color: var(--text); box-shadow: var(--shadow-modal); outline: 0;
  }
  .body { display: grid; gap: 4px; margin: 0; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
  .crumb { display: inline-flex; align-items: center; gap: 4px; font: 400 12px/18px var(--font); color: var(--muted); }
  .crumb .where { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px 0 6px; border-radius: 11px; background: var(--muted-bg); color: var(--text); }
  /* The fields have no box of their own: the dialog is the field (Linear). The title at 18px, the line under it at
     14px. Their focus ring is the page's token ring (COLOR.md 3), kept. */
  .ttl, .desc { width: 100%; margin: 0; padding: 4px 4px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text); font: 700 18px/26px var(--font); }
  .desc { font: 400 14px/21px var(--font); resize: none; min-height: 64px; }
  .ttl::placeholder, .desc::placeholder { color: var(--morndo-placeholder); font-weight: inherit; }
  .pills { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px 2px 10px; border-bottom: 1px solid var(--border); }
  .other { display: inline-flex; align-items: center; gap: 6px; }
  .bd-in.sm { height: 26px; padding: 0 10px; font-size: 13px; border-radius: 13px; }
  .error { margin: 6px 0 0; padding: 8px 10px; border-radius: var(--radius-md); background: var(--bad-bg); color: var(--bad-fg); font: 400 13px/18px var(--font); }
  footer { display: flex; align-items: center; gap: 10px; padding-top: 10px; min-height: 44px; }
  .grow { flex: 1; }
  .ask { font: 700 13px/18px var(--font); }
  .more { display: inline-flex; align-items: center; gap: 8px; font: 400 13px/18px var(--font); color: var(--muted); cursor: pointer; }
  /* The switch, as the details modal's (SlackModal .switch): 36 x 20, the knob 16. */
  .switch {
    appearance: none; margin: 0; width: 36px; height: 20px; border-radius: 10px; background: var(--border-strong); position: relative; cursor: pointer; flex: none;
    transition: background 0.12s;
  }
  .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--main-bg); transition: transform 0.12s; }
  .switch:checked { background: var(--send); }
  .switch:checked::after { transform: translateX(16px); }
  kbd { font: 400 11px/16px var(--font); color: var(--muted); padding: 2px 6px; border-radius: var(--radius-sm); border: 1px solid var(--border); }
  @media (prefers-reduced-motion: reduce) { .switch, .switch::after { transition: none; } }
</style>
