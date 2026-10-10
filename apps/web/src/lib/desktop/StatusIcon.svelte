<script lang="ts">
  // A task's status as one glyph, the way Linear draws it (a ring that fills as the work moves), in the colour its
  // context sets: the column header, the card, the panel's status chip. Ink keeps colour for status (COLOR.md 2): the
  // glyph is the indicator, and the words beside it say the state; it is never the only cue, so it is aria-hidden.
  //   backlog: a dashed ring (nobody's yet)       todo: an empty ring (handed out)
  //   doing: half the ring filled                 review: three quarters filled, waiting on the manager
  //   blocked: the ring with a mark in it         done: the ring filled, with a check
  import type { TaskStatus } from "./board.ts";

  let { status, size = 14 }: { status: TaskStatus; size?: number } = $props();
  // The inner disc is drawn as a stroke whose dash covers the share of the work done; its circumference at r 3.25.
  const C = 2 * Math.PI * 3.25;
  const share: Partial<Record<TaskStatus, number>> = { doing: 0.5, review: 0.75 };
</script>

<svg class="si s-{status}" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
  {#if status === "backlog"}
    <circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.1 2.3" stroke-linecap="round" />
  {:else if status === "done"}
    <circle cx="8" cy="8" r="7" fill="currentColor" />
    <path d="M5 8.3l2 2 4-4.3" stroke="var(--si-check, var(--main-bg))" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  {:else if status === "blocked"}
    <circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.5" />
    <path d="M8 4.75v3.9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
    <circle cx="8" cy="11.1" r="0.95" fill="currentColor" />
  {:else}
    <circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.5" />
    {#if share[status]}
      <circle cx="8" cy="8" r="3.25" stroke="currentColor" stroke-width="6.5" stroke-dasharray="{C * (share[status] ?? 0)} {C}" transform="rotate(-90 8 8)" />
    {/if}
  {/if}
</svg>

<style>
  /* The colour, once, on the glyph: the status colour where there is one (the indicator tokens, COLOR.md 2), muted
     for work not started, ink for done. A context overrides only an exception. */
  .si { flex: none; display: inline-block; vertical-align: -2px; color: var(--muted); }
  .s-doing { color: var(--working); }
  .s-review { color: var(--warn); }
  .s-blocked { color: var(--badge); }
  .s-done { color: var(--text); }
</style>
