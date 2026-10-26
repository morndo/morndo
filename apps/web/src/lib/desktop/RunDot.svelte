<script lang="ts">
  // A Run's state as a 6px dot (ADR-0032, design §7), beside the words that say it: the card's live line, the header's
  // run counts. run-words.ts picks the classes: filled (working, needs you, ended) or hollow (a wait, an offline node),
  // in a status colour (COLOR.md 2), the warning one for a wait that is overdue or has no waker. aria-hidden: the words
  // beside it carry the state.
  let { dot }: { dot: string } = $props();
</script>

<span class="rd {dot}" aria-hidden="true"></span>

<style>
  .rd { width: 6px; height: 6px; border-radius: 50%; flex: none; --c: var(--idle-dot); }
  .dot-working { --c: var(--working); }
  .dot-muted { --c: var(--muted); }
  .dot-warn { --c: var(--warn); }
  .dot-ink { --c: var(--text); }
  .dot-bad { --c: var(--badge); }
  .dot-idle { --c: var(--idle-dot); }
  .dot-fill { background: var(--c); }
  .dot-hollow { box-shadow: inset 0 0 0 1.5px var(--c); }
</style>
