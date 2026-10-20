<script lang="ts">
  // One task on the board (ADR-0015), laid out as a Linear card: the key and the lane on top, the status glyph and the
  // title (two lines, the rest in the panel), what stands out as chips (priority, comments, a lane that isn't running),
  // the blocked reason in words, and the age. Dragged between columns with the pointer; opened with a click or Enter
  // for everything else (the panel). Ink: the glyph carries the status colour, everything else is ink (COLOR.md 1, 2).
  // ADR-0032 (design §7): on the one card its assignee's Run shows on (run-words.ts runCards), a ring on the avatar and
  // one live line under the title, a status dot and the Run in words (runLook). The "not running" chip stays.
  import CircleDashed from "@lucide/svelte/icons/circle-dashed";
  import Flag from "@lucide/svelte/icons/flag";
  import MessageSquareText from "@lucide/svelte/icons/message-square-text";
  import Unplug from "@lucide/svelte/icons/unplug";
  import RunAvatar from "./RunAvatar.svelte";
  import RunDot from "./RunDot.svelte";
  import StatusIcon from "./StatusIcon.svelte";
  import { ago, type Run, type Task } from "./board.ts";
  import { chipOpensJob, jobKey, type ShownJob } from "./jobs.ts";
  import { runLook } from "./run-words.ts";

  let { task, now, running, selected, jobs = [], run = null, onOpen, onOpenJob, onDragStart, onDragEnd }: {
    task: Task; now: number; running: boolean; selected: boolean; jobs?: ShownJob[];
    run?: Run | null;                                     // the assignee's Run, when this is the card it shows on
    onOpen: () => void; onOpenJob: (id: string) => void; onDragStart: () => void; onDragEnd: () => void;
  } = $props();
  const look = $derived(runLook(run, now));
  const when = $derived(task.status === "done" && task.doneAt !== null ? task.doneAt : task.updatedAt);
  const whenWord = $derived(task.status === "done" ? "Accepted" : task.rev === 1 ? "Filed" : "Updated");
</script>

<div
  class="tc" class:sel={selected} data-task={task.key} draggable="true" role="button" tabindex="0" aria-label="{task.key}: {task.title}"
  onclick={onOpen} onkeydown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
  ondragstart={e => { e.dataTransfer?.setData("text/plain", task.key); if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
  ondragend={onDragEnd}
>
  <header>
    <span class="key">{task.key}</span>
    {#if task.assignee}
      <span class="who" class:off={!running} title={running ? (look ? `${task.assignee}: ${look.words}` : task.assignee) : `${task.assignee}: no lane by this name is running`}>
        <span class="nm">{task.assignee}</span><RunAvatar name={task.assignee} kind={task.assignee === "manager" ? "peer" : "agent"} size={18} ring={look?.ring ?? null} />
      </span>
    {:else}
      <span class="who none" title="Nobody yet"><span class="nm">Nobody yet</span><CircleDashed size={18} strokeWidth={1.5} /></span>
    {/if}
  </header>
  <div class="ttl">
    <StatusIcon status={task.status} size={14} />
    <h4 title={task.title}>{task.title}</h4>
  </div>
  {#if look}<p class="live" class:warn={look.dot.includes("dot-warn")} data-run={run?.phase} title={look.words}><RunDot dot={look.dot} /><span>{look.words}</span></p>{/if}
  {#each jobs as job (jobKey(job))}
    <button type="button" class="chip job" data-job={jobKey(job)} onclick={e => { e.stopPropagation(); onOpenJob(jobKey(job)); }} onkeydown={e => { if (chipOpensJob(e.key)) { e.stopPropagation(); e.preventDefault(); onOpenJob(jobKey(job)); } }}>{job.name} · {job.state}</button>
  {/each}
  {#if task.status === "blocked" && task.blockedReason}<p class="why" title={task.blockedReason}>{task.blockedReason}</p>{/if}
  <footer>
    {#if task.priority !== "normal"}
      <span class="chip" class:bad={task.priority === "high"} title="{task.priority === "high" ? "High" : "Low"} priority"><Flag size={11} />{task.priority === "high" ? "High" : "Low"}</span>
    {/if}
    {#if task.assignee && !running}<span class="chip off"><Unplug size={11} />not running</span>{/if}
    {#if task.comments}<span class="chip n" title="{task.comments} comment{task.comments === 1 ? "" : "s"} on the record"><MessageSquareText size={11} />{task.comments}</span>{/if}
    <time title="{whenWord} {new Date(when).toLocaleString()}">{whenWord} {ago(when, now)}</time>
  </footer>
</div>

<style>
  .tc {
    position: relative; display: grid; gap: 8px; padding: 10px 12px 10px; border: 1px solid var(--border); border-radius: var(--radius-md);
    background: var(--main-bg); color: var(--text); cursor: grab; text-align: left; box-shadow: var(--shadow-card);
    transition: box-shadow 0.12s, border-color 0.12s;
  }
  .tc:hover { border-color: var(--border-strong); box-shadow: var(--shadow-lift); }
  /* The open task: selection with the 3px ink bar, its 3:1 cue (COLOR.md 8), as the sidebar's open conversation. */
  .tc.sel { background: var(--selected); border-color: var(--border-strong); box-shadow: inset 3px 0 0 var(--selected-bar), var(--shadow-card); }
  .tc.sel:hover { box-shadow: inset 3px 0 0 var(--selected-bar), var(--shadow-lift); }
  .tc:active { cursor: grabbing; }
  @media (prefers-reduced-motion: reduce) { .tc { transition: none; } }
  header { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
  .key { font: 400 12px/18px var(--mono); color: var(--muted); letter-spacing: 0.01em; }
  .who { display: inline-flex; align-items: center; gap: 6px; min-width: 0; font: 400 12px/18px var(--font); color: var(--muted); }
  .who .nm { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .who.none { color: var(--muted); }
  .who.none :global(svg) { flex: none; }
  .who.off { color: var(--muted); }
  .ttl { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
  .ttl :global(.si) { margin-top: 3px; }
  h4 {
    margin: 0; min-width: 0; font: 400 14px/20px var(--font); overflow-wrap: anywhere;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden;    /* the rest in the panel */
  }
  /* The live line: the dot centred under the status glyph, the words under the title, one line (the rest in its title). */
  .live { margin: 0; display: flex; align-items: center; gap: 12px; min-width: 0; padding-left: 4px; font: 400 12px/17px var(--font); color: var(--muted); }
  .live span { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  /* What asks for him (needs you, a wait nothing will wake, overdue) is written in the warning colour: status in colour
     (COLOR.md 2), as the prototype the owner approved shows it. */
  .live.warn { color: var(--warn-fg); }
  .why {
    margin: 0 0 0 22px; font: 400 12px/17px var(--font); color: var(--bad-fg);
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden;
  }
  footer { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px; border-radius: var(--radius-sm);
    border: 1px solid var(--border); background: var(--main-bg); color: var(--text); font: 400 11px/18px var(--font); white-space: nowrap;
  }
  .chip :global(svg) { color: var(--muted); }
  .chip.bad { border-color: color-mix(in srgb, var(--badge) 40%, transparent); background: var(--bad-bg); color: var(--bad-fg); }
  .chip.bad :global(svg) { color: var(--badge); }
  .chip.off { color: var(--muted); }
  .chip.job { cursor: pointer; width: fit-content; }
  time { margin-left: auto; font: 400 11px/18px var(--font); color: var(--muted); white-space: nowrap; }
</style>
