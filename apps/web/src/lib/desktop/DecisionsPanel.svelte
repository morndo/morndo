<script lang="ts">
  // The Decisions tab of the right-hand panel: everything that waits for the principal's call. A summary on top, then
  // groups: needs your call, on your plate, answered, decided.
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import PartyPopper from "@lucide/svelte/icons/party-popper";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import DecisionCard, { type AnswerBody, type AnswerProblem } from "./DecisionCard.svelte";
  import { groups, urgency, waitingCount, type DecisionItem, type LedgerState } from "./decisions.ts";
  import { clock } from "./grouping.ts";

  let { items, ledger, now, verifiedFresh, onAnswer, onOpenScreen, onOpenChat }: {
    items: DecisionItem[]; ledger: LedgerState; now: number; verifiedFresh: boolean;
    onAnswer: (id: string, body: AnswerBody, requestId: string) => Promise<AnswerProblem | null>;
    onOpenScreen: (workerId: string) => void; onOpenChat: (item: DecisionItem) => void;
  } = $props();

  let collapsed = $state<Record<string, boolean>>({});
  const list = $derived(groups(items));
  const waiting = $derived(waitingCount(items));
  const urgent = $derived(items.filter(d => d.status === "open" && ["blocking", "overdue", "soon"].includes(urgency(d, now))).length);
  const plate = $derived(items.filter(d => d.status === "open" && d.need === "time").length);
  const isShut = (key: string, open: boolean) => collapsed[key] ?? !open;
</script>

<div class="dp">
  {#if ledger.configured && !ledger.ok}
    <div class="warn" role="status"><TriangleAlert size={16} /><span>Can't read the manager's list{ledger.at ? ` (tried ${clock(ledger.at)})` : ""}. Answers wait until it can be read again.</span></div>
  {/if}
  <div class="scroll">
    <div class="summary">
      <div class="tile" class:zero={!waiting}><b>{waiting}</b><span>to decide</span></div>
      <div class="tile urgent" class:zero={!urgent}><b>{urgent}</b><span>urgent</span></div>
      <div class="tile" class:zero={!plate}><b>{plate}</b><span>on your plate</span></div>
    </div>

    {#if !waiting && !plate}
      <div class="empty">
        <span class="art"><PartyPopper size={28} /></span>
        <h3>You're all caught up</h3>
        <p>Nothing needs your call right now. When the manager or an agent needs a decision, it lands here.</p>
      </div>
    {/if}

    {#each list as g (g.key)}
      <section class="group">
        <button class="gh" aria-expanded={!isShut(g.key, g.open)} onclick={() => (collapsed[g.key] = !isShut(g.key, g.open))}>
          <span class="caret" class:shut={isShut(g.key, g.open)}><ChevronDown size={14} /></span>{g.label}<span class="n">{g.items.length}</span>
        </button>
        {#if !isShut(g.key, g.open)}
          <div class="cards">
            {#each g.items as d (d.id)}
              <DecisionCard item={d} variant="panel" {now} {verifiedFresh} {onAnswer} {onOpenScreen} {onOpenChat} />
            {/each}
          </div>
        {/if}
      </section>
    {/each}
  </div>
</div>

<style>
  .dp { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--sidebar-bg); }
  .warn { display: flex; gap: 8px; align-items: flex-start; padding: 10px 16px; background: var(--warn-bg); color: var(--warn-fg); font: 400 13px/18px var(--font); flex: none; }
  .warn :global(svg) { flex: none; margin-top: 1px; }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 12px 12px 24px; }
  .summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 4px; }
  .tile { display: grid; gap: 0; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--main-bg); }
  .tile b { font: 900 22px/28px var(--font); color: var(--text); font-variant-numeric: tabular-nums; }
  .tile span { font: 400 12px/16px var(--font); color: var(--muted); }
  .tile.urgent:not(.zero) b { color: var(--bad-fg); }
  .tile.zero b { color: var(--muted); }
  .empty { display: grid; justify-items: center; gap: 6px; padding: 32px 16px 16px; text-align: center; }
  .art { width: 56px; height: 56px; border-radius: 14px; display: grid; place-items: center; background: var(--muted-bg); color: var(--text); margin-bottom: 4px; }
  .empty h3 { margin: 0; font: 900 18px/24px var(--font); }
  .empty p { margin: 0; max-width: 32ch; font: 400 14px/20px var(--font); color: var(--muted); }
  .group { margin-top: 12px; }
  .gh {
    display: flex; align-items: center; gap: 6px; width: 100%; height: 28px; padding: 0 6px; border: 0; border-radius: 6px;
    background: transparent; color: var(--sidebar-fg); font: 700 13px/28px var(--font); cursor: pointer; text-align: left;
  }
  .gh .n { margin-left: auto; font: 400 12px/1 var(--font); opacity: 0.7; }
  /* Text on a tint is full text at full opacity (COLOR.md 8): the hovered heading redeclares the muted aliases and undims its count. */
  .gh:hover { background: var(--hover); --sidebar-fg: var(--text); --muted: var(--text); }
  .gh:hover .n { opacity: 1; }
  .caret { display: inline-grid; transition: transform 0.12s; }
  .caret.shut { transform: rotate(-90deg); }
  .cards { display: grid; gap: 8px; margin-top: 6px; }
</style>
