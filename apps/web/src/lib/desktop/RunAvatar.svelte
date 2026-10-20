<script lang="ts">
  // An avatar with its lane's Run as a ring around it (ADR-0032, design §7): the tile is today's (Avatar.svelte, neutral,
  // COLOR.md 10), and the ring is an outline 2px off its edge, so the gap shows whatever the avatar sits on (a card, the
  // open card's selection, a chip). run-words.ts picks the classes; the shape says what the lane is on, the tone how it
  // stands, in the status colours only (COLOR.md 2):
  //   ring-solid ring-working ring-pulse   working: solid, a soft pulse
  //   ring-dashed ring-working             waiting on its own work: background tasks or a job
  //   ring-dotted ring-muted               waiting on a wake-up
  //   ring-dashed ring-warn                a declared wait, nothing will wake it (R4); ring-warn on any overdue wait (R3)
  //   ring-solid ring-warn                 needs you
  // No ring: no Run, ended, gone or unknown. Decorative, as the avatar is: the live line says the state in words.
  import type { AuthorKind } from "@morndo/domain";
  import Avatar from "./Avatar.svelte";

  let { name, kind = "agent", size = 18, ring = null }: { name: string; kind?: AuthorKind; size?: number; ring?: string | null } = $props();
</script>

<span class="ra {ring ?? ''}" class:ringed={!!ring} data-ring={ring ?? undefined}><Avatar {name} {kind} {size} /></span>

<style>
  .ra { display: inline-flex; flex: none; --ring: transparent; }
  .ringed { margin-left: 2px; }                               /* the ring takes 4px; the name keeps its distance */
  .ring-working { --ring: var(--working); }
  .ring-muted { --ring: var(--muted); }
  .ring-warn { --ring: var(--warn); }
  .ring-solid :global(.av) { outline: 2px solid var(--ring); outline-offset: 2px; }
  .ring-dashed :global(.av) { outline: 2px dashed var(--ring); outline-offset: 2px; }
  .ring-dotted :global(.av) { outline: 2px dotted var(--ring); outline-offset: 2px; }
  /* The pulse: a soft halo of the ring's own colour that swells and fades, as the prototype's working ring did. */
  .ring-pulse :global(.av) { animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 0 transparent; }
    50% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--ring) 28%, transparent); }
  }
  @media (prefers-reduced-motion: reduce) { .ring-pulse :global(.av) { animation: none; } }
</style>
