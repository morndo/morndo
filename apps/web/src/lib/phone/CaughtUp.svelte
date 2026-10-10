<script lang="ts">
  // The end of a catch-up run (ADR-0009, the design's catchup-3): what he did in it (the run's own counts), how long it
  // took, when he is next needed (Horizon's headline), and the decisions he kept for later, one tap away.
  import type { Counts } from "../catchup/run.ts";
  import { heroTime, untilLabel, type Row } from "./horizon.ts";

  let { counts, skipped, now, next, waitingNow, working, later, primed, onDay, onLater }: {
    counts: Counts; skipped: number; now: number; next: Row | null; waitingNow: number; working: number; primed: boolean;
    later: { id: string; title: string }[]; onDay: () => void; onLater: (id: string) => void;
  } = $props();
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("#", String(n)));
</script>

<div class="end">
  <div class="sky" aria-hidden="true">
    <span class="ring" style="width:250px;height:250px"></span>
    <span class="ring" style="width:340px;height:340px"></span>
    <span class="ring" style="width:440px;height:440px"></span>
    <span class="sun"></span><span class="band"></span><span class="ground"></span>
  </div>
  <p class="kicker">{new Date(now).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</p>
  <h2>You're caught up.</h2>
  <ul class="sum" aria-label="What you did">
    <li class="chip" data-count="decided">{plural(counts.decided, "1 decided", "# decided")}</li>
    {#if counts.read}<li class="chip" data-count="read">{plural(counts.read, "1 read", "# read")}</li>{/if}
    {#if counts.kept}<li class="chip" data-count="kept">{plural(counts.kept, "1 kept unread", "# kept unread")}</li>{/if}
    {#if counts.later}<li class="chip" data-count="later">{plural(counts.later, "1 kept for later", "# kept for later")}</li>{/if}
    {#if skipped}<li class="chip" data-count="muted">{plural(skipped, "1 muted, skipped", "# muted, skipped")}</li>{/if}
  </ul>
  <div class="next">
    {#if !primed}
      <p class="kicker">What is next</p>
      <p class="say">Waiting for the hub to say what needs you next.</p>
    {:else if waitingNow > 0}
      <p class="kicker">Still waiting</p>
      <p class="when num">{waitingNow}</p>
      <p class="say">{plural(waitingNow, "One decision waits", "# decisions wait")} for your call: kept for later, or new since you started.</p>
    {:else if next?.at}
      <p class="kicker">Nothing needs you until</p>
      <p class="when num">{heroTime(next.at, now)}</p>
      <p class="say"><b>{next.title}</b>, {untilLabel(next.at, now)}.{#if working}{" "}Until then {plural(working, "1 agent keeps", "# agents keep")} working without you.{/if}</p>
    {:else}
      <p class="kicker">Nothing needs you</p>
      <p class="say">No open item has a time written down.{#if working}{" "}{plural(working, "1 agent keeps", "# agents keep")} working without you.{/if}</p>
    {/if}
  </div>
</div>

<div class="foot">
  <button class="pbtn primary" onclick={onDay}>See your day</button>
  {#each later as l (l.id)}
    <button class="tlink kept" onclick={() => onLater(l.id)}>Kept for later: {l.title}</button>
  {/each}
</div>

<style>
  .end { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; padding: 0 26px; }
  .sky { position: relative; height: 200px; flex: none; margin: 6px -26px 18px; overflow: hidden; }
  .sun { position: absolute; left: 50%; bottom: 40px; width: 150px; height: 150px; margin-left: -75px; border-radius: 50%; background: var(--ink); }
  .band { position: absolute; left: 0; right: 0; bottom: 68px; height: 18px; background: var(--bg); }
  .ground { position: absolute; left: 0; right: 0; bottom: 0; height: 40px; background: var(--bg); border-top: 1px solid var(--line); }
  .ring { position: absolute; left: 50%; bottom: 40px; border: 1px solid var(--line); border-radius: 50%; transform: translate(-50%, 50%); }
  h2 { font: 600 36px/40px var(--display); letter-spacing: -0.02em; margin: 4px 0 0; }
  .sum { display: flex; gap: 8px; margin: 14px 0 0; padding: 0; list-style: none; flex-wrap: wrap; }
  .next { margin-top: 22px; padding: 16px 0 12px; border-top: 1px solid var(--line); }
  .when { font: 600 50px/54px var(--display); letter-spacing: -0.03em; margin: 6px 0 4px; }
  .say { font: 400 15px/22px var(--body); color: var(--muted); margin: 0; }
  .say b { color: var(--fg); }
  .foot { flex: none; padding: 8px 20px calc(env(safe-area-inset-bottom, 0px) + 10px); display: grid; gap: 4px; }
  .kept { font-weight: 400; text-decoration: underline; }
</style>
