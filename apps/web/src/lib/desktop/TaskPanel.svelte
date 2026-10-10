<script lang="ts">
  // One task, open beside the board (ADR-0015): everything the principal may do to it (move, assign, edit, comment,
  // as the manager may), its description, and its record: every change with who made it, comments in full. The record
  // comes from the hub when the panel opens and again whenever the board says the task changed (its rev).
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import CircleCheckBig from "@lucide/svelte/icons/circle-check-big";
  import Hash from "@lucide/svelte/icons/hash";
  import Pencil from "@lucide/svelte/icons/pencil";
  import X from "@lucide/svelte/icons/x";
  import { api } from "../api.ts";
  import Avatar from "./Avatar.svelte";
  import Picker, { type PickerOption } from "./Picker.svelte";
  import StatusIcon from "./StatusIcon.svelte";
  import "./board-controls.css";
  import { COLUMNS, PRIORITY_OPTIONS, PRIORITY_WORDS, STATUS_WORDS, ago, eventLine, type Task, type TaskEvent, type TaskStatus } from "./board.ts";
  import { clock } from "./grouping.ts";

  let { task, lanes, now, pendingBlock = false, notice = null, onAct, onOpenLane, onClose }: {
    task: Task; lanes: string[]; now: number;
    pendingBlock?: boolean;                               // opened by a drop on Blocked: ask the reason first
    notice?: string | null;                               // why a drop on the board was refused, in words
    // One change, as the hub takes it; null when it went, else the words for why not.
    onAct: (key: string, body: Record<string, unknown>) => Promise<string | null>;
    onOpenLane: (name: string) => void; onClose: () => void;
  } = $props();

  let events = $state<TaskEvent[]>([]);
  let loadFailed = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let comment = $state("");
  let reason = $state("");
  let editing = $state(false);
  let draft = $state({ title: "", description: "", priority: "normal" as Task["priority"] });
  let blocking = $state(false);
  let assignOther = $state(false);
  let otherLane = $state("");
  let reasonEl = $state<HTMLInputElement | null>(null);

  // The task's key and revision as primitives: the `task` object is a fresh one on every board frame, so an effect
  // that read it would run on every change anywhere on the board.
  const key = $derived(task.key);
  const rev = $derived(task.rev);
  // The record, when the task opens and when it changes (its rev), not when any other task does.
  $effect(() => {
    void rev;
    let gone = false;
    api.get<{ task: Task; events: TaskEvent[] }>(`/api/board/tasks/${encodeURIComponent(key)}`, { "x-morndo-background": "1" })
      .then(r => { if (!gone) { events = r.events; loadFailed = false; } }, () => { if (!gone) loadFailed = true; })
      .catch(() => {});
    return () => { gone = true; };
  });
  // The panel is remounted per task ({#key}); these only answer what the board hands in: a drop on Blocked asks why,
  // and a refused drop shows its words. Neither touches a draft (a comment, a reason, an edit) in progress.
  $effect(() => { if (pendingBlock) blocking = true; });
  $effect(() => { if (notice) error = notice; });
  $effect(() => { if (blocking) requestAnimationFrame(() => reasonEl?.focus()); });

  async function act(body: Record<string, unknown>): Promise<boolean> {
    busy = true; error = null;
    try {
      const why = await onAct(task.key, body);
      if (why) { error = why; return false; }
      return true;
    } finally { busy = false; }
  }
  // The pickers are controlled: they show the task as it is, so a refused change never sticks.
  async function move(to: TaskStatus) {
    if (to === task.status) return;
    if (to === "blocked") { blocking = true; return; }
    await act({ action: "move", to, ifRev: task.rev });
  }
  async function block() {
    if (!reason.trim()) { error = "Say why it is blocked."; return; }
    if (await act({ action: "move", to: "blocked", reason, ifRev: task.rev })) { blocking = false; reason = ""; }
  }
  async function assign(to: string | null) {
    if (to === "__other") { assignOther = true; return; }
    if (await act({ action: "assign", to, ifRev: task.rev })) { assignOther = false; otherLane = ""; }
  }
  async function send() {
    if (!comment.trim()) return;
    if (await act({ action: "comment", text: comment })) comment = "";
  }
  function startEdit() { draft = { title: task.title, description: task.description, priority: task.priority }; editing = true; }
  async function saveEdit() {
    const body: Record<string, unknown> = { action: "edit", ifRev: task.rev };
    if (draft.title !== task.title) body.title = draft.title;
    if (draft.description !== task.description) body.description = draft.description;
    if (draft.priority !== task.priority) body.priority = draft.priority;
    if (Object.keys(body).length === 2) { editing = false; return; }
    if (await act(body)) editing = false;
  }
  const assigneeChoices = $derived([...new Set([...lanes, ...(task.assignee ? [task.assignee] : [])])].sort());
  const assignOptions = $derived<PickerOption[]>([
    { value: "", label: "Nobody" },
    ...assigneeChoices.map((l): PickerOption => ({ value: l, label: l, avatar: { name: l, kind: l === "manager" ? "peer" : "agent" }, ...(lanes.includes(l) ? {} : { hint: "not running" }) })),
    { value: "__other", label: "Another lane…" },
  ]);
  const statusOptions: PickerOption[] = COLUMNS.map(c => ({ value: c.status, label: c.label, hint: c.hint }));
</script>

<aside class="tp" aria-label="Task {task.key}" data-task-panel={task.key}>
  <header>
    <span class="key">{task.key}</span>
    <span class="st s-{task.status}"><StatusIcon status={task.status} size={13} />{STATUS_WORDS[task.status]}</span>
    <button class="x" aria-label="Close the task" onclick={onClose}><X size={18} /></button>
  </header>
  <div class="scroll">
    {#if editing}
      <div class="edit">
        <input class="bd-in title" aria-label="Title" bind:value={draft.title} maxlength="120" />
        <textarea class="bd-in" aria-label="Description" bind:value={draft.description} rows="5" placeholder="What done means"></textarea>
        <div class="row"><span class="bd-label">Priority</span><Picker value={draft.priority} options={PRIORITY_OPTIONS} label="Priority" size="sm" onPick={v => (draft.priority = v as Task["priority"])} /></div>
        <div class="acts"><button class="bd-btn ghost" disabled={busy} onclick={() => (editing = false)}>Cancel</button><button class="bd-btn primary" disabled={busy} onclick={saveEdit}>Save</button></div>
      </div>
    {:else}
      <h2>{task.title}<button class="ib" aria-label="Edit the task" title="Edit" onclick={startEdit}><Pencil size={14} /></button></h2>
      {#if task.description}<p class="desc">{task.description}</p>{:else}<p class="desc ph">No description. What does done mean?</p>{/if}
    {/if}

    <dl class="facts" aria-label="Facts">
      <div>
        <dt>Assigned to</dt>
        <dd>
          {#if assignOther}
            <form class="other" onsubmit={e => { e.preventDefault(); void assign(otherLane.trim() || null); }}>
              <input class="bd-in" aria-label="Lane name" bind:value={otherLane} placeholder="lane name" />
              <button class="bd-btn sm" type="submit" disabled={busy}>Assign</button>
              <button class="bd-btn ghost sm" type="button" onclick={() => (assignOther = false)}>Cancel</button>
            </form>
          {:else}
            <Picker value={task.assignee ?? ""} options={assignOptions} label="Assigned to" size="sm" disabled={busy} onPick={v => void assign(v === "" ? null : v)} />
            {#if task.assignee}<button class="link" onclick={() => task.assignee && onOpenLane(task.assignee)}><Hash size={12} />Open {task.assignee}</button>{/if}
          {/if}
        </dd>
      </div>
      <div>
        <dt>Status</dt>
        <dd>
          <Picker value={task.status} options={statusOptions} label="Status" size="sm" disabled={busy} onPick={v => void move(v as TaskStatus)} />
          {#if task.status === "review"}<button class="bd-btn primary sm" disabled={busy} onclick={() => void act({ action: "move", to: "done", ifRev: task.rev })}><CircleCheckBig size={14} />Accept as done</button>{/if}
        </dd>
      </div>
      <div><dt>Priority</dt><dd>{PRIORITY_WORDS[task.priority]}</dd></div>
      {#if task.blockedReason}<div><dt>Blocked</dt><dd class="bad">{task.blockedReason}</dd></div>{/if}
      <div><dt>Filed</dt><dd>{ago(task.createdAt, now)} by {task.createdBy.kind === "principal" ? "you" : task.createdBy.name}</dd></div>
    </dl>

    {#if blocking}
      <form class="block" onsubmit={e => { e.preventDefault(); void block(); }}>
        <label for="block-reason">Why is it blocked?</label>
        <input id="block-reason" class="bd-in" bind:this={reasonEl} bind:value={reason} maxlength="300" placeholder="What it needs, from whom" />
        <div class="acts"><button class="bd-btn ghost" type="button" onclick={() => (blocking = false)}>Cancel</button><button class="bd-btn primary" type="submit" disabled={busy}>Mark blocked</button></div>
      </form>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}

    <h3>Record</h3>
    {#if loadFailed}<p class="ph">Couldn't load the record.</p>{/if}
    <ol class="log">
      {#each events as e (e.rev)}
        {@const l = eventLine(e)}
        <li>
          <Avatar name={l.who} kind={e.actor.kind === "principal" ? "principal" : e.actor.kind === "manager" ? "peer" : "agent"} size={20} />
          <div>
            <p><strong>{l.who}</strong> {l.text}<time title={new Date(e.at).toLocaleString()}>{clock(e.at)}</time></p>
            {#if l.comment}<p class="cmt">{l.comment}</p>{/if}
          </div>
        </li>
      {/each}
    </ol>
  </div>
  <form class="composer" onsubmit={e => { e.preventDefault(); void send(); }}>
    <textarea class="bd-in" aria-label="Comment" bind:value={comment} rows="2" placeholder="A line on the record, for the lane and the manager"
      onkeydown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}></textarea>
    <button class="bd-btn primary icon" type="submit" disabled={busy || !comment.trim()} aria-label="Send the comment"><ArrowRight size={16} /></button>
  </form>
</aside>

<style>
  .tp { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-left: 1px solid var(--border); background: var(--main-bg); }
  header { height: 49px; display: flex; align-items: center; gap: 8px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--border); flex: none; }
  .key { font: 400 13px/20px var(--mono); color: var(--muted); }
  /* The status: the glyph in the status colour and the state in words, on a quiet chip (COLOR.md 2). */
  .st { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px 0 6px; border-radius: 11px; background: var(--muted-bg); color: var(--text); font: 700 12px/20px var(--font); }
  .st.s-doing { background: var(--ok-bg); color: var(--ok-fg); }
  .st.s-blocked { background: var(--bad-bg); color: var(--bad-fg); }
  .st.s-review { background: var(--warn-bg); color: var(--warn-fg); }
  .x { margin-left: auto; width: 28px; height: 28px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text); display: grid; place-items: center; cursor: pointer; }
  .x:hover { background: var(--hover); }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px 16px; display: grid; gap: 14px; align-content: start; scrollbar-width: thin; }
  h2 { margin: 0; display: flex; align-items: flex-start; gap: 6px; font: 700 17px/24px var(--font); overflow-wrap: anywhere; }
  .ib { flex: none; width: 24px; height: 24px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--muted); display: grid; place-items: center; cursor: pointer; }
  .ib:hover { background: var(--hover); color: var(--text); }
  .desc { margin: 0; white-space: pre-wrap; font: 400 14px/21px var(--font); overflow-wrap: anywhere; }
  .ph { color: var(--muted); font-style: italic; }
  /* The facts: a recessed box (the page background, COLOR.md 11) with a label column and the pickers. */
  .facts { margin: 0; display: grid; gap: 6px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--recessed); border: 1px solid var(--border); }
  .facts div { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 8px; align-items: center; min-height: 28px; }
  .facts dt { font: 400 12px/18px var(--font); color: var(--muted); }
  .facts dd { margin: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font: 400 13px/20px var(--font); min-width: 0; }
  .facts dd.bad { color: var(--bad-fg); }
  .edit { display: grid; gap: 10px; }
  .row { display: flex; align-items: center; gap: 10px; }
  .other { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .block { display: grid; gap: 8px; padding: 12px; border-radius: var(--radius-md); border: 1px solid color-mix(in srgb, var(--badge) 45%, transparent); background: var(--bad-bg); }
  .block label { font: 700 13px/18px var(--font); color: var(--bad-fg); }
  .acts { display: flex; gap: 8px; justify-content: flex-end; }
  .link { display: inline-flex; align-items: center; gap: 3px; padding: 0; border: 0; background: none; color: var(--link); font: 400 13px/19px var(--font); cursor: pointer; text-decoration: underline; }
  .error { margin: 0; padding: 8px 10px; border-radius: var(--radius-md); background: var(--bad-bg); color: var(--bad-fg); font: 400 13px/18px var(--font); }
  h3 { margin: 2px 0 -4px; font: 700 12px/18px var(--font); color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  /* The record: a timeline, one row per change, the avatars on a thin line down the left. */
  .log { margin: 0; padding: 0; list-style: none; display: grid; gap: 10px; position: relative; }
  .log::before { content: ""; position: absolute; left: 9px; top: 12px; bottom: 12px; width: 1px; background: var(--border); }
  .log li { display: flex; gap: 10px; align-items: flex-start; position: relative; }
  .log li :global(.av) { box-shadow: 0 0 0 3px var(--main-bg); }
  .log p { margin: 0; font: 400 13px/20px var(--font); overflow-wrap: anywhere; }
  .log time { margin-left: 6px; font-size: 11px; color: var(--muted); }
  .cmt { white-space: pre-wrap; padding: 6px 10px; margin-top: 4px !important; border-radius: var(--radius-sm); background: var(--recessed); border: 1px solid var(--border); }
  .composer { display: flex; gap: 8px; align-items: flex-end; padding: 10px 12px; border-top: 1px solid var(--border); background: var(--composer-bar); flex: none; }
  .composer textarea { flex: 1; }
</style>
