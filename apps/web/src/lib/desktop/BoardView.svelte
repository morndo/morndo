<script lang="ts">
  // The board (ADR-0015): six columns in work order, a card per task, the task open beside it. What the manager runs
  // from its lane with `morndo-board`, the principal runs from here: file a task, hand it to a lane, drag it between
  // columns (a drop on Blocked asks why first), accept what a lane offered for review. The rules are the hub's: a
  // refusal comes back in words on the open task.
  // The look is a Linear board on the desktop's Ink tokens (desk-tokens.css): a status glyph per column and per card,
  // quiet cards on the page background, the counts in words up top, and every radius and shadow from the token file.
  // ADR-0032 (design §7): the board follows the fleet's Runs, on top of that look. The Run of a card's assignee is a ring
  // on its avatar and a live line (TaskCard), the header counts the lanes working now and those waiting on their own
  // work, a quiet row above the columns names the lanes that work without an open task (a click opens the lane, as the
  // panel's "Open <lane>" does), and a card that changes column flies there (crossfade, below).
  import { flip } from "svelte/animate";
  import { cubicOut } from "svelte/easing";
  import { prefersReducedMotion } from "svelte/motion";
  import { crossfade } from "svelte/transition";
  import Plus from "@lucide/svelte/icons/plus";
  import SquareKanban from "@lucide/svelte/icons/square-kanban";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import NewTaskModal from "./NewTaskModal.svelte";
  import Picker, { type PickerOption } from "./Picker.svelte";
  import RunAvatar from "./RunAvatar.svelte";
  import RunDot from "./RunDot.svelte";
  import StatusIcon from "./StatusIcon.svelte";
  import TaskCard from "./TaskCard.svelte";
  import TaskPanel from "./TaskPanel.svelte";
  import { COLUMNS, FILEABLE, byStatus, type MergedView, type Run, type Task, type TaskStatus } from "./board.ts";
  import { jobKey, jobsOn, type JobCount, type ShownJob } from "./jobs.ts";
  import { PHASE_WORDS, lanesWithoutTask, runCards, runCounts, runLook } from "./run-words.ts";
  import "./board-controls.css";

  let { tasks, lanes, live, now, runs = null, merged = null, open = null, jobs = [], counts = [], more = 0, openJob = null, onOpen, onAct, onCreate, onOpenLane, onOpenJob, onLoadJobs }: {
    tasks: Task[]; lanes: string[]; live: boolean; now: number;
    runs?: ReadonlyMap<string, Run> | null;               // each lane's Run, by lane (board.ts decodeRuns); null: the hub sent none
    merged?: ReadonlyMap<string, MergedView> | null;      // where each task's merges stand, by key (board.ts decodeMerged); null: the hub sent none
    open?: string | null;                                 // the task open beside the board, by key
    jobs?: ShownJob[];
    counts?: JobCount[];
    more?: number;
    onOpen: (key: string | null) => void;
    onAct: (key: string, body: Record<string, unknown>) => Promise<string | null>;
    onCreate: (body: Record<string, unknown>) => Promise<string | null>;
    onOpenLane: (name: string) => void;
    onOpenJob?: (id: string) => void;
    onLoadJobs?: (before: string | null) => Promise<{ jobs: ShownJob[]; next: string | null }>;
    openJob?: string | null;
  } = $props();

  let rest = $state<ShownJob[]>([]);
  let restNext = $state<string | null>(null);
  let loadingJobs = $state(false);

  let laneFilter = $state("");
  let dragging = $state<string | null>(null);
  let over = $state<TaskStatus | null>(null);
  // The dialog to file a task (NewTaskModal), and the column it opens on: a column's + fills it in; the header's
  // New task leaves it to the hub (To do when assigned, else Backlog).
  let filing = $state<{ status: "" | TaskStatus } | null>(null);
  let pendingBlock = $state(false);
  let colsEl = $state<HTMLDivElement | null>(null);
  let edgeRect: DOMRect | null = null;                  // the columns' box for one drag; read once, not per event
  let edgeAt = 0;

  const shown = $derived(laneFilter ? tasks.filter(t => t.assignee === laneFilter) : tasks);
  const columns = $derived(byStatus(shown));
  const current = $derived(open ? tasks.find(t => t.key === open) ?? null : null);
  const runningLanes = $derived(new Set(lanes));
  const assignees = $derived([...new Set([...lanes, ...tasks.flatMap(t => (t.assignee ? [t.assignee] : []))])].sort());
  const blocked = $derived(tasks.filter(t => t.status === "blocked").length);
  const laneOption = (l: string): PickerOption => ({ value: l, label: l, avatar: { name: l, kind: l === "manager" ? "peer" : "agent" }, ...(runningLanes.has(l) ? {} : { hint: "not running" }) });
  const filterOptions = $derived<PickerOption[]>([{ value: "", label: "Everyone" }, ...assignees.map(laneOption)]);
  const assignOptions = $derived<PickerOption[]>([{ value: "", label: "Nobody yet" }, ...assignees.map(laneOption), { value: "__other", label: "Another lane…" }]);
  const inProgress = $derived(tasks.filter(t => t.status === "doing").length);
  const openedJob = $derived(openJob ? jobs.find(j => jobKey(j) === openJob) ?? null : null);
  async function loadJobs(before: string | null) {
    if (!onLoadJobs || loadingJobs) return;
    loadingJobs = true;
    try {
      const page = await onLoadJobs(before);
      rest = before === null ? page.jobs : [...rest, ...page.jobs];
      restNext = page.next;
    } finally { loadingJobs = false; }
  }
  const toReview = $derived(tasks.filter(t => t.status === "review").length);
  // The Runs (ADR-0032): which card each lane's shows on, the header's counts, and the lanes without an open task (the
  // lane filter narrows the row as it narrows the cards). A lane whose Run says gone is not running, whatever the hub's
  // lane list still says (R5): its cards keep the "not running" chip.
  const runOn = $derived(runs ? runCards(tasks, runs) : new Map<Task["key"], Run>());
  const runSums = $derived(runs ? runCounts(runs.values()) : null);
  const untasked = $derived(runs ? lanesWithoutTask(runs.values(), tasks).filter(r => !laneFilter || r.lane === laneFilter) : []);
  const isRunning = (lane: string | null) => !lane || (runningLanes.has(lane) && runs?.get(lane)?.phase !== "gone");
  // Design §7, "Moves": a card that changes column flies there with its avatar on it. Svelte's crossfade "creates a pair
  // of transitions called send and receive. When an element is 'sent', it looks for a corresponding element being
  // 'received'" (https://svelte.dev/docs/svelte/svelte-transition, read 2026-10-20): here the card leaving one column's
  // list and the card arriving in another's, paired by the task's key; the cards around them close up (flip). The card
  // leaving stays in its old column while it fades. Svelte makes an element inert for its outro (svelte 5.57.1,
  // transitions.js `out`), so it can't be clicked or focused and is out of the accessibility tree, and it loses its
  // data-task here, so a key is on one card at a time. A card with no counterpart (filed, accepted out of the week,
  // filtered away) just appears or goes: no fallback. Under prefers-reduced-motion nothing animates, no transition and no
  // flip (prefersReducedMotion, "a media query that matches if the user prefers reduced motion", since 5.7.0:
  // https://svelte.dev/docs/svelte/svelte-motion, read 2026-10-20).
  const [send, receive] = crossfade({ duration: d => Math.min(480, Math.sqrt(d * 200)), easing: cubicOut });
  const moving = () => !prefersReducedMotion.current;
  const still = () => ({ duration: 0 });
  function leave(node: Element, p: { key: string }) {
    for (const el of node.querySelectorAll("[data-task]")) el.removeAttribute("data-task");
    return moving() ? send(node, p) : still;
  }
  const arrive = (node: Element, p: { key: string }) => (moving() ? receive(node, p) : still);
  const closeUp = () => ({ duration: moving() ? 200 : 0 });
  function endDrag() { dragging = null; over = null; edgeRect = null; edgeAt = 0; }
  async function drop(to: TaskStatus) {
    const key = dragging;
    endDrag();
    const t = key ? tasks.find(x => x.key === key) : null;
    if (!t || t.status === to) return;
    if (to === "blocked") { pendingBlock = true; onOpen(t.key); return; }
    pendingBlock = false;
    const why = await onAct(t.key, { action: "move", to, ifRev: t.rev });
    if (why) { dropError = { key: t.key, text: why }; onOpen(t.key); }
  }
  // At the reference's column width the board scrolls sideways, so a card dragged towards a column off-screen scrolls
  // the board under the pointer: dragover keeps firing near either edge of the columns (every move, and on its own
  // while the pointer rests), and the board moves by the time passed, 600px a second, whatever the event rate.
  function edgeScroll(e: DragEvent) {
    const el = colsEl;
    if (!el || !dragging) return;
    edgeRect ??= el.getBoundingClientRect();
    const now = performance.now(), dt = Math.min(100, now - edgeAt);
    edgeAt = now;
    const step = 0.6 * dt, edge = 64;
    if (e.clientX < edgeRect.left + edge) el.scrollLeft -= step;
    else if (e.clientX > edgeRect.right - edge) el.scrollLeft += step;
  }
  // Why a drop was refused, kept with the task it was about and shown on it; a card opened by hand clears it.
  let dropError = $state<{ key: string; text: string } | null>(null);
  const notice = $derived(current && dropError?.key === current.key ? dropError.text : null);
</script>

<section class="board" class:with-panel={current}>
  <div class="main">
    <header class="bh">
      <SquareKanban size={18} /><h1>Board</h1>
      <div class="sums" role="group" aria-label="The board in numbers">
        {#if runSums}
          <span class="sum run" data-sum="working"><RunDot dot="dot-fill dot-working" /><b>{runSums.working}</b> working now</span>
          <span class="sum run" data-sum="own-work"><RunDot dot="dot-hollow dot-working" /><b>{runSums.ownWork}</b> waiting on their own work</span>
        {/if}
        <span class="sum s-doing"><StatusIcon status="doing" size={13} /><b>{inProgress}</b> in progress</span>
        <span class="sum s-review"><StatusIcon status="review" size={13} /><b>{toReview}</b> to review</span>
        <span class="sum s-blocked"><StatusIcon status="blocked" size={13} /><b>{blocked}</b> blocked</span>
      </div>
      <div class="right">
        <Picker value={laneFilter} options={filterOptions} label="Show tasks of" size="sm" align="end" onPick={v => (laneFilter = v)} />
        <button class="bd-btn primary sm" onclick={() => (filing = { status: "" })} aria-haspopup="dialog" aria-expanded={!!filing}><Plus size={15} />New task</button>
      </div>
    </header>
    {#if counts.length}
      <p class="counts">
        {#each counts as c (c.node)}
          <span data-node={c.node}><b>{c.running}</b> running · <b>{c.queued}</b> queued · <b>{c.failed}</b> failed on {c.node}</span>
        {/each}
      </p>
    {/if}
    {#if openedJob}
      <p class="job-open" data-open-job={jobKey(openedJob)}>{openedJob.name} · {openedJob.node} · {openedJob.state}</p>
    {/if}
    {#if jobs.length || more > 0}
      <ul class="jobs" aria-label="Jobs">
        {#each jobs as j (jobKey(j))}
          <li data-job={jobKey(j)}>{j.name} · {j.class} · {j.state} · {j.lane} · {j.outcome ?? "—"} · {j.exit ?? "—"} · {j.durationSec ?? "—"} · {j.notice}</li>
        {/each}
        {#if more > 0}<li><button type="button" class="more" onclick={() => void loadJobs(null)}>{more} more</button></li>{/if}
      </ul>
    {/if}
    {#if rest.length}
      <ul class="job-rest" aria-label="Older jobs">
        {#each rest as j (jobKey(j))}
          <li data-job={jobKey(j)}>{j.name} · {j.node} · {j.state}</li>
        {/each}
        {#if restNext}<li><button type="button" class="more next" onclick={() => void loadJobs(restNext)}>Next</button></li>{/if}
      </ul>
    {/if}
    {#if !live}
      <div class="warn-bar" role="status"><TriangleAlert size={16} /><span>The hub hasn't sent the board yet.</span></div>
    {/if}
    {#if untasked.length}
      <div class="untasked" role="group" aria-label="Lanes working without a task">
        <span class="ul">Without a task</span>
        {#each untasked as r (r.lane)}
          {@const look = runLook(r, now)}
          <button type="button" class="lane" data-lane={r.lane} title="{r.lane}: {look?.words ?? PHASE_WORDS[r.phase]}. Open its channel" onclick={() => onOpenLane(r.lane)}>
            <RunAvatar name={r.lane} kind={r.lane === "manager" ? "peer" : "agent"} size={16} ring={look?.ring ?? null} /><span class="nm">{r.lane}</span><span class="ph">{PHASE_WORDS[r.phase]}</span>
          </button>
        {/each}
      </div>
    {/if}
    <div class="cols" role="group" aria-label="Columns" bind:this={colsEl} ondragover={edgeScroll}>
      {#each COLUMNS as c (c.status)}
        {@const rows = columns.get(c.status) ?? []}
        <div class="col s-{c.status}" class:over={over === c.status} data-column={c.status} role="list" aria-label={c.label}
          ondragover={e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "move"; over = c.status; }}
          ondragleave={() => { if (over === c.status) over = null; }}
          ondrop={e => { e.preventDefault(); void drop(c.status); }}>
          <h2 title={c.hint}>
            <StatusIcon status={c.status} size={14} /><span class="cl">{c.label}</span><span class="n">{rows.length}</span>
            {#if FILEABLE.includes(c.status)}
              <button class="add" type="button" aria-label="File a task in {c.label}" title="File a task in {c.label}" onclick={() => (filing = { status: c.status })}><Plus size={14} /></button>
            {/if}
          </h2>
          <div class="cards">
            {#each rows as t (t.key)}
              <div class="slot" role="listitem" in:arrive={{ key: t.key }} out:leave={{ key: t.key }} animate:flip={closeUp()}>
                <TaskCard task={t} {now} jobs={jobsOn(t.key, jobs)} run={runOn.get(t.key) ?? null} running={isRunning(t.assignee)} selected={open === t.key}
                  onOpen={() => { pendingBlock = false; dropError = null; onOpen(open === t.key ? null : t.key); }}
                  onOpenJob={id => onOpenJob?.(id)}
                  onDragStart={() => (dragging = t.key)} onDragEnd={endDrag} />
              </div>
            {:else}
              <p class="empty"><span>{c.status === "doing" ? "Nothing in progress" : c.status === "blocked" ? "Nothing blocked" : c.status === "done" ? "Nothing accepted this week" : "Nothing here"}</span><small>{c.hint}</small></p>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </div>
  {#if current}
    {#key current.key}
      <TaskPanel task={current} {lanes} {now} merged={merged?.get(current.key) ?? null} {pendingBlock} {notice} {onAct} {onOpenLane} onClose={() => onOpen(null)} />
    {/key}
  {/if}
  {#if filing}
    <NewTaskModal status={filing.status} {assignOptions} {onCreate} onClose={() => (filing = null)} />
  {/if}
</section>

<style>
  .board { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; min-height: 0; flex: 1; background: var(--main-bg); }
  .board.with-panel { grid-template-columns: minmax(0, 1fr) 400px; }
  .main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .bh { height: 49px; display: flex; align-items: center; gap: 10px; padding: 0 12px 0 18px; border-bottom: 1px solid var(--border); flex: none; }
  h1 { margin: 0 8px 0 0; font: 900 18px/24px var(--font); }
  /* The counts that matter, as quiet chips: the glyph in the status colour, the state in words (COLOR.md 2). */
  .sums { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; }
  .sum {
    display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px 0 7px; border-radius: 12px;
    background: var(--muted-bg); color: var(--text); font: 400 12px/18px var(--font); white-space: nowrap;
  }
  .sum b { font-weight: 700; font-variant-numeric: tabular-nums; }
  .sum.run { gap: 7px; padding-left: 10px; }               /* a 6px dot where the others have a 13px glyph */
  .right { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: none; }
  .warn-bar { display: flex; gap: 8px; align-items: center; padding: 8px 18px; background: var(--warn-bg); color: var(--warn-fg); font: 400 13px/18px var(--font); flex: none; }
  .counts, .jobs, .job-open { margin: 0; padding: 8px 18px; border-bottom: 1px solid var(--border); font: 400 13px/18px var(--font); flex: none; }
  .counts { display: flex; flex-wrap: wrap; gap: 12px; color: var(--muted); }
  .counts b { font-weight: 900; color: var(--text); }
  .jobs { list-style: none; display: grid; gap: 4px; }
  .more { color: var(--link); border: 0; background: none; padding: 0; font: inherit; cursor: pointer; }
  .job-open { font-weight: 700; }
  /* The columns: on the page background, each a heading and a stack of surface cards, no box of its own, at Linear's
     width (340px); the board scrolls sideways past what the window holds. */
  .cols { flex: 1; min-height: 0; display: grid; grid-auto-flow: column; grid-auto-columns: 340px; gap: 12px; padding: 12px 16px 16px; overflow: auto; background: var(--sidebar-bg); }
  .col { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-radius: var(--radius-md); padding: 4px; margin: -4px; outline: 2px dashed transparent; outline-offset: -2px; transition: outline-color 0.1s, background 0.1s; }
  .col.over { outline-color: var(--border-strong); background: var(--hover); }
  .col h2 { margin: 0 0 8px; padding: 0 4px 0 6px; min-height: 32px; display: flex; align-items: center; gap: 7px; font: 700 13px/20px var(--font); color: var(--text); }
  .col h2 .cl { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .col h2 .n { font: 400 12px/20px var(--font); color: var(--muted); font-variant-numeric: tabular-nums; }
  .col h2 .add {
    margin-left: auto; width: 24px; height: 24px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--muted);
    display: grid; place-items: center; cursor: pointer; flex: none;
  }
  .col h2 .add:hover { background: var(--hover); color: var(--text); }
  /* Lanes without a task: one quiet row of chips (avatar with its ring, name, phase), wrapping on a narrow window. */
  .untasked { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 7px 18px; border-bottom: 1px solid var(--border); flex: none; }
  .untasked .ul { margin-right: 4px; font: 400 12px/18px var(--font); color: var(--muted); white-space: nowrap; }
  .lane {
    display: inline-flex; align-items: center; gap: 7px; height: 28px; padding: 0 10px 0 8px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--main-bg); color: var(--text); font: 400 12px/18px var(--font); cursor: pointer; white-space: nowrap; min-width: 0; max-width: 100%;
  }
  .lane:hover { background: var(--hover); border-color: var(--border-strong); }
  .lane .nm { overflow: hidden; text-overflow: ellipsis; }
  .lane .ph { color: var(--muted); }
  .slot { min-width: 0; }
  .cards { flex: 1; min-height: 40px; overflow-y: auto; display: grid; gap: 8px; align-content: start; padding: 1px; scrollbar-width: thin; }
  .empty { margin: 2px 4px; display: grid; gap: 2px; font: 400 13px/18px var(--font); color: var(--muted); }
  .empty small { font: 400 11px/16px var(--font); }
</style>
