<script lang="ts">
  // Proof beside a task (ADR-0035 step 5): text only — the line, the brief, each reference's mark, attested items.
  import { MARK, WORD, type CoverageStatus, type RefState, type TaskStatus } from "@morndo/domain";
  import type { ProofView } from "./board.ts";

  let { proof, status }: { proof: ProofView; status: TaskStatus } = $props();

  const NEED_MARK: Record<CoverageStatus, string> = {
    covered: "✓", told: "~", open: "…", not_covered: "◇",
  };
  const NEED_WORD: Record<CoverageStatus, string> = {
    covered: "covered", told: "the lane's word", open: "open", not_covered: "not covered",
  };

  const show = $derived(
    proof.brief !== null || status === "review" || status === "done" || proof.coverage.length > 0,
  );

  const lineClass = $derived.by(() => {
    const k = proof.state.kind;
    if (k === "verified") return "ok";
    if (k === "failing" || k === "not_covered") return "bad";
    if (k === "attested_only") return "muted";
    return "warn";
  });

  const refRows = $derived.by(() => {
    const latest = new Map<string, { state: RefState; detail: string | null; checkedAt: number }>();
    for (const r of proof.results) {
      const prev = latest.get(r.ref);
      if (!prev || r.checkedAt > prev.checkedAt) latest.set(r.ref, { state: r.state, detail: r.detail, checkedAt: r.checkedAt });
    }
    return (proof.brief?.refs ?? []).map(ref => {
      const row = latest.get(ref);
      return { ref, state: (row?.state ?? "pending") as RefState, detail: row?.detail ?? null };
    });
  });
</script>

{#if show}
  <section class="proof" data-proof aria-label="Proof">
    <h3>Proof</h3>
    <p data-proof-line class="line {lineClass}">{proof.state.line}</p>
    {#if proof.standIn}<p data-proof-standin class="muted standin">Read from a stand-in forge, not GitHub</p>{/if}
    {#if proof.coverage.length > 0}
      <div class="needs-wrap">
        <h4 class="needs-heading">Needs</h4>
        <ul data-proof-needs class="needs">
          {#each proof.coverage as item}
            <li data-proof-need data-status={item.status} class:bad={item.status === "not_covered"}>
              <span class="mark" aria-hidden="true">{NEED_MARK[item.status]}</span>
              <span class="sr-only">{NEED_WORD[item.status]}</span>
              <code class="spec">{item.spec}</code>
              {#if item.by === "lane"}<span class="muted lane-added">added by the lane</span>{/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    {#if !proof.brief}
      {#if status === "review" || status === "done"}
        <p class="muted no-brief">No brief yet. The lane files one with morndo-board brief.</p>
      {/if}
    {:else}
      <p data-proof-summary>{proof.brief.summary}</p>
      {#if proof.brief.decisions || proof.brief.leftOut || proof.brief.limits}
        <dl class="brief-dl">
          {#if proof.brief.decisions}<div><dt>Decisions</dt><dd>{proof.brief.decisions}</dd></div>{/if}
          {#if proof.brief.leftOut}<div><dt>Left out</dt><dd>{proof.brief.leftOut}</dd></div>{/if}
          {#if proof.brief.limits}<div><dt>Limits</dt><dd>{proof.brief.limits}</dd></div>{/if}
        </dl>
      {/if}
      {#if proof.brief.refs.length > 0}
        <ul class="refs">
          {#each refRows as row}
            <li data-proof-ref data-state={row.state}>
              <span class="mark" aria-hidden="true">{MARK[row.state]}</span>
              <span class="sr-only">{WORD[row.state]}</span>
              <code class="ref">{row.ref}</code>
              {#if row.detail}<span class="detail">{row.detail}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if proof.brief.attested.length > 0}
        <ul data-proof-attested class="attested">
          {#each proof.brief.attested as a}
            <li>Attested ({a.kind}): {a.how}<span class="muted">the lane's word, not checked</span></li>
          {/each}
        </ul>
      {/if}
      {#if proof.brief.noCode}
        <p data-proof-nocode>No code change: {proof.brief.noCode}</p>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .proof { display: grid; gap: 8px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--recessed); border: 1px solid var(--border); }
  .proof h3 { margin: 0; font: 700 12px/18px var(--font); color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .line { margin: 0; font: 400 13px/20px var(--font); }
  .line.ok { color: var(--ok-fg); }
  .line.bad { color: var(--bad-fg); }
  .line.warn { color: var(--warn-fg); }
  .line.muted { color: var(--muted); }
  .muted { color: var(--muted); font: 400 12px/18px var(--font); }
  .no-brief { margin: 0; }
  .standin { margin: 0; }
  [data-proof-summary] { margin: 0; font: 400 14px/21px var(--font); }
  .brief-dl { margin: 0; display: grid; gap: 4px; font: 400 13px/20px var(--font); }
  .brief-dl div { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 8px; }
  .brief-dl dt { color: var(--muted); }
  .brief-dl dd { margin: 0; }
  .refs, .attested, .needs { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
  .needs-wrap { display: grid; gap: 4px; min-width: 0; }
  .needs-heading { margin: 0; font: 700 11px/16px var(--font); color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .needs { overflow-wrap: anywhere; }
  .needs li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font: 400 13px/20px var(--font); }
  .needs li.bad { color: var(--bad-fg); }
  .spec { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
  .lane-added { margin-left: 2px; }
  .attested .muted { margin-left: 6px; }
  .refs li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font: 400 13px/20px var(--font); }
  .mark { flex: none; }
  .ref { font-family: var(--mono); font-size: 12px; }
  .detail { color: var(--muted); overflow-wrap: anywhere; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  [data-proof-nocode] { margin: 0; font: 400 13px/20px var(--font); color: var(--muted); }
</style>
