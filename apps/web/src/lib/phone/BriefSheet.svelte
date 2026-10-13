<script lang="ts">
  // The decision brief on the phone (ADR-0023 §6.3): a full-screen dialog fixed to the visual viewport, the same way a
  // conversation is. The brief on screen is the shared AnswerSession (a restate stays until he asks for the new one).
  // Sending is catch-up's 5-second Undo, not a second confirm step: the parent starts that window.
  import { onMount } from "svelte";
  import { cardOf } from "@morndo/domain";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import Star from "@lucide/svelte/icons/star";
  import { renderBriefInline, renderBriefMarkdown, renderMarkdown } from "../markdown.ts";
  import type { AnswerSession } from "../desktop/answer-session.svelte.ts";
  import type { AnswerBody, AskOutcome } from "../desktop/answer-session.ts";
  import { dueLine, type DecisionItem } from "../desktop/decisions.ts";
  import { followKeyboard } from "./chat/keyboard.ts";

  let { item, now, session, answering, note, onPick, onUndo, onAskBrief }: {
    item: DecisionItem; now: number; session: AnswerSession;
    answering: { label: string; sending: boolean; commitAt: number } | null;
    note: string | null;
    onPick: (body: AnswerBody, label: string) => Promise<boolean>;
    onUndo: () => void;
    onAskBrief: (item: DecisionItem) => Promise<AskOutcome>;
  } = $props();

  let dialogEl = $state<HTMLDialogElement | null>(null);
  let headlineEl = $state<HTMLHeadingElement | null>(null);
  let bodyEl = $state<HTMLElement | null>(null);
  let writing = $state(false);
  let words = $state("");
  let tick = $state(Date.now());

  const view = $derived(session.shown);
  const card = $derived(cardOf(view));
  const brief = $derived(view.brief);
  const open = $derived(item.status === "open");
  const primary = $derived(brief ? brief.options.find(o => o.key === brief.recommend) ?? brief.options[0] ?? null : view.options[0] ?? null);
  const headline = $derived(card.headline ?? view.title);
  const left = $derived(answering ? Math.max(0, Math.ceil((answering.commitAt - tick) / 1000)) : 0);

  $effect(() => {
    if (!answering || answering.sending) return;
    const t = setInterval(() => (tick = Date.now()), 250);
    return () => clearInterval(t);
  });
  $effect(() => { if (answering) writing = false; });

  onMount(() => {
    const dialog = dialogEl;
    dialog?.showModal();
    const stop = dialog ? followKeyboard(dialog) : () => {};
    headlineEl?.focus();
    return () => { stop(); if (dialog?.open) dialog.close(); };
  });

  function goBack() {
    if (answering?.sending) return;
    history.back();
  }
  function onCancel(e: Event) {
    e.preventDefault();
    goBack();
  }
  function showNew() { session.showNew(); queueMicrotask(() => headlineEl?.focus()); }
  function showOthers() { bodyEl?.querySelector("#brief-choices")?.scrollIntoView({ block: "start" }); }
  async function choose(label: string, body: AnswerBody) {
    if (session.stale || answering || !open || item.answerable !== null) return;
    if (await onPick(body, label)) writing = false;
  }
  function ask() { void session.ask(onAskBrief); }
</script>

<dialog bind:this={dialogEl} class="sheet" aria-labelledby="brief-sheet-headline" oncancel={onCancel}>
  <header>
    <div class="bar">
      <button type="button" class="back" aria-label="Back" onclick={goBack} disabled={answering?.sending}><ChevronLeft size={24} /></button>
      <span class="topic">{card.topic}</span>
    </div>
    {#if session.stale}
      <p class="restated" role="status">The manager restated this brief. <button type="button" class="link" onclick={showNew}>Show the new version</button></p>
    {/if}
    <p class="kicker">Decision request</p>
    <p class="meta">
      {#if card.due !== null}<span>{dueLine(card.due, now)}</span>{/if}
      {#if card.minutes !== null}<span>≈{card.minutes} min</span>{/if}
    </p>
    <h2 id="brief-sheet-headline" tabindex="-1" bind:this={headlineEl}>{headline}</h2>
    {#if card.spend}<p class="spend">Includes spend</p>{/if}
    {#if !card.hasBrief}
      <p class="plain">Filed without a brief{#if session.asked} <span role="status">Asked. This decision stays open.</span>{:else if open} <button type="button" class="link" disabled={session.asking} onclick={ask}>Ask for a brief</button>{/if}</p>
      {#if session.askError}<p class="err" role="alert">{session.askError}</p>{/if}
    {/if}
  </header>

  <div class="brief-body" bind:this={bodyEl}>
    {#if brief}
      <section>
        <h3>The ask</h3>
        <div class="md">{@html renderBriefMarkdown(brief.ask.text)}</div>
        <p class="pair"><b>Alternative</b> <span class="md">{@html renderBriefInline(brief.ask.alternative)}</span></p>
        <p class="pair"><b>Uncertainty</b> <span class="md">{@html renderBriefInline(brief.ask.uncertainty)}</span></p>
      </section>
      <section>
        <h3>Why now</h3>
        <div class="md">{@html renderBriefMarkdown(brief.whyNow)}</div>
      </section>
      <section>
        <h3>Options compared</h3>
        <table class="compare">
          <caption class="sr">Options compared</caption>
          <thead>
            <tr>
              <td></td>
              {#each brief.options as o (o.key)}
                <th scope="col" class:rec={o.key === brief.recommend}>{o.key.toUpperCase()} · {@html renderBriefInline(o.label)}{#if o.key === brief.recommend}<span class="mark"><Star size={12} /> Recommended</span>{/if}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each brief.comparison.rows as row, i (i)}
              <tr>
                <th scope="row">{@html renderBriefInline(row.factor)}</th>
                {#each row.cells as cell, j (j)}<td class:rec={brief.options[j]?.key === brief.recommend}>{@html renderBriefInline(cell)}</td>{/each}
              </tr>
            {/each}
          </tbody>
        </table>
        <div class="factors">
          {#each brief.comparison.rows as row, i (i)}
            <h4>{@html renderBriefInline(row.factor)}</h4>
            <ul>
              {#each brief.options as o, j (o.key)}
                <li class:rec={o.key === brief.recommend}>
                  {#if o.key === brief.recommend}<span class="mark"><Star size={12} /> Recommended</span>{/if}
                  {o.key.toUpperCase()} · {@html renderBriefInline(o.label)} <b>{@html renderBriefInline(row.cells[j] ?? "")}</b>
                </li>
              {/each}
            </ul>
          {/each}
        </div>
        <p class="note">{@html renderBriefInline(brief.comparison.note)}</p>
      </section>
      <section>
        <h3>Why the recommendation</h3>
        <div class="md">{@html renderBriefMarkdown(brief.why.text)}</div>
        {#if brief.why.assumptions.length}
          <h4>Assumptions</h4>
          <ul>{#each brief.why.assumptions as a, i (i)}<li>{@html renderBriefInline(a)}</li>{/each}</ul>
        {/if}
        <p class="pair"><b>Downside case</b> {@html renderBriefInline(brief.why.downside)}</p>
      </section>
      <section>
        <h3>What would change it</h3>
        <div class="md">{@html renderBriefMarkdown(brief.changeIf)}</div>
      </section>
      <section>
        <h3>Main risk and control</h3>
        <p class="pair"><b>Risk</b> {@html renderBriefInline(brief.risk.risk)}</p>
        <p class="pair"><b>Control</b> {@html renderBriefInline(brief.risk.control)}</p>
      </section>
      <section>
        <h3>What approval authorizes</h3>
        <p class="commit">The asker's commitment. Morndo records your answer and doesn't enforce the limits.</p>
        <ul>{#each brief.authorizes.limits as limit, i (i)}<li>{@html renderBriefInline(limit)}</li>{/each}</ul>
        <p class="pair"><b>Needs fresh approval</b> {@html renderBriefInline(brief.authorizes.freshApproval)}</p>
        <p class="pair"><b>Review point</b> {@html renderBriefInline(brief.authorizes.reviewPoint)}</p>
      </section>
      {#if brief.ifNoAnswer}
        <section>
          <h3>If no decision by the due date</h3>
          <div class="md">{@html renderBriefMarkdown(brief.ifNoAnswer)}</div>
        </section>
      {/if}
      {#if brief.evidence.length}
        <section>
          <h3>Evidence</h3>
          <ul>
            {#each brief.evidence as e, i (i)}
              {#if e.url.startsWith("https://")}<li><a href={e.url} target="_blank" rel="noopener noreferrer">{@html renderBriefInline(e.label)}</a></li>{/if}
            {/each}
          </ul>
        </section>
      {/if}
    {:else}
      {#if view.summary && view.summary !== headline}<p>{view.summary}</p>{/if}
      {#if view.recommendation}<p class="pair"><b>Recommended</b> {@html renderBriefInline(view.recommendation)}</p>{/if}
      {#if view.ifNoAnswer}<p class="pair"><b>If you don't answer</b> {@html renderBriefInline(view.ifNoAnswer)}</p>{/if}
      {#if view.details}<div class="md">{@html renderMarkdown(view.details)}</div>{/if}
      {#if view.context && view.contextKind === "markdown"}<div class="md">{@html renderMarkdown(view.context)}</div>{/if}
      {#if view.context && view.contextKind === "screen"}<pre class="screen">{view.context}</pre>{/if}
    {/if}

    <section id="brief-choices">
      <h3>Decision</h3>
      {#if brief}
        {#each brief.options as o (o.key)}
          <button type="button" class="act" class:primary={o.key === brief.recommend} disabled={!open || !!answering || session.stale} onclick={() => void choose(o.label, { key: o.key })}>
            {#if o.key === brief.recommend}<Star size={16} />{/if}{o.key.toUpperCase()} · {@html renderBriefInline(o.label)}
          </button>
        {/each}
      {:else}
        {#each view.options as o (o.key)}
          <button type="button" class="act" class:primary={o.key === primary?.key} disabled={!open || !!answering || session.stale} onclick={() => void choose(o.label, { key: o.key })}>{o.label}</button>
        {/each}
      {/if}
      {#if writing}
        <label class="sr" for="brief-words">Your answer</label>
        <textarea id="brief-words" bind:value={words} rows="3" placeholder="Your answer…"></textarea>
        <button type="button" class="act primary" disabled={!words.trim() || !open || !!answering} onclick={() => void choose("your own words", { text: words.trim() })}>Send</button>
        <button type="button" class="act" onclick={() => (writing = false)}>Cancel</button>
      {:else}
        <button type="button" class="act" disabled={!open || !!answering || session.stale} onclick={() => (writing = true)}>Answer in my own words</button>
      {/if}
    </section>
  </div>

  <footer>
    {#if answering}
      <p class="stand" role="status"><b>Answered: {answering.label}</b></p>
      <p class="note">{answering.sending ? "Sending…" : `Goes in ${left} s.`}</p>
      {#if !answering.sending}<button type="button" class="act" onclick={onUndo}>Undo</button>{/if}
    {:else if session.stale}
      <button type="button" class="act" onclick={goBack}>Back</button>
    {:else if primary}
      <button type="button" class="act primary" disabled={!open || item.answerable !== null} onclick={() => void choose(primary.label, { key: primary.key })}>
        {#if brief && primary.key === brief.recommend}<Star size={16} />{/if}{primary.label}
      </button>
      <button type="button" class="act" onclick={showOthers}>Other answers</button>
    {:else}
      <button type="button" class="act primary" disabled={!open} onclick={showOthers}>Answer in my own words</button>
    {/if}
    {#if note}<p class="err" role="alert">{note}</p>{/if}
  </footer>
</dialog>

<style>
  dialog.sheet {
    width: 100%; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; border-radius: 0;
    background: var(--bg, #fff); color: var(--fg, inherit);
  }
  dialog.sheet[open] {
    position: fixed; top: var(--vv-top, 0px); right: 0; bottom: var(--kb, 0px); left: 0;
    display: flex; flex-direction: column; overflow: hidden; height: auto;
  }
  dialog.sheet::backdrop { background: var(--bg, #fff); }
  header, footer { flex: none; }
  header { padding: calc(var(--safe-top, 0px) + 6px) 16px 12px; }
  :global(.kb-open) header { padding-top: 6px; }
  .bar { display: flex; align-items: center; gap: 8px; min-height: 44px; margin: 0 -8px 4px; }
  .back { width: 44px; height: 44px; display: grid; place-items: center; border: 0; background: none; color: var(--fg); cursor: pointer; flex: none; }
  .topic { min-width: 0; font: 700 15px/20px var(--body, var(--font, sans-serif)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .kicker { margin: 0; font: 700 11px/16px var(--body, var(--font, sans-serif)); letter-spacing: 0.09em; text-transform: uppercase; color: var(--muted); }
  .meta { display: flex; flex-wrap: wrap; gap: 6px 12px; margin: 4px 0 0; font: 400 13px/18px var(--body, var(--font, sans-serif)); color: var(--muted); }
  h2 { margin: 8px 0 0; font: 600 25px/29px var(--display, var(--font, sans-serif)); letter-spacing: -0.015em; }
  .spend { margin: 8px 0 0; font: 700 12px/16px var(--body, var(--font, sans-serif)); }
  .plain, .restated { margin: 8px 0 0; font: 400 14px/20px var(--body, var(--font, sans-serif)); }
  .restated { padding: 8px 10px; border-radius: 10px; background: var(--fill); }
  .brief-body { container-type: inline-size; flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; touch-action: pan-y; padding: 8px 16px 16px; }
  section { margin: 0 0 18px; }
  h3 { margin: 0 0 6px; font: 700 12px/16px var(--body, var(--font, sans-serif)); letter-spacing: 0.06em; text-transform: uppercase; }
  h4 { margin: 10px 0 4px; font: 700 13px/18px var(--body, var(--font, sans-serif)); }
  p { margin: 0 0 6px; font: 400 15px/22px var(--body, var(--font, sans-serif)); overflow-wrap: anywhere; }
  .pair b { font: 700 13px/18px var(--body, var(--font, sans-serif)); margin-right: 6px; }
  .commit, .note { font: 400 13px/18px var(--body, var(--font, sans-serif)); color: var(--muted); }
  .md :global(p) { margin: 0 0 6px; }
  .md :global(ul), .md :global(ol) { margin: 2px 0 6px; padding-left: 22px; }
  a, a:visited, .md :global(a) { color: var(--fg); }
  table.compare { width: 100%; border-collapse: collapse; font: 400 13px/18px var(--body, var(--font, sans-serif)); }
  .sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  th, td { padding: 6px 8px; border: 1px solid var(--line, var(--edge)); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
  .mark { display: flex; align-items: center; gap: 4px; margin-top: 2px; font: 700 11px/14px var(--body, var(--font, sans-serif)); color: var(--fg); }
  .rec { background: var(--morndo-selection, var(--fill)); box-shadow: inset 3px 0 0 var(--ink, var(--accent)); }
  .factors { display: none; }
  @container (max-width: 559px) {
    table.compare { display: none; }
    .factors { display: block; }
    .factors ul { list-style: none; margin: 0 0 12px; padding: 0; }
    .factors li { padding: 4px 0; font: 400 15px/21px var(--body, var(--font, sans-serif)); overflow-wrap: anywhere; }
  }
  ul { margin: 4px 0 8px; padding-left: 22px; }
  #brief-choices { display: grid; gap: 8px; }
  #brief-choices .act { width: 100%; }
  footer { display: grid; gap: 8px; padding: 12px 16px calc(12px + var(--safe-bottom, 0px)); border-top: 1px solid var(--line, var(--edge)); background: var(--bg, #fff); }
  :global(.kb-open) footer { padding-bottom: 12px; }
  .act {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 48px; width: 100%;
    padding: 8px 16px; border-radius: 14px; border: 1px solid var(--edge); background: transparent; color: var(--fg);
    font: 700 16px/1.25 var(--body, var(--font, sans-serif)); cursor: pointer; text-align: center;
  }
  .act.primary { background: var(--ink, var(--accent)); color: var(--ink-fg, var(--accent-fg)); border-color: var(--ink, var(--accent)); }
  .act:disabled { cursor: default; opacity: 1; border-style: dashed; }
  .link { padding: 0; border: 0; background: none; color: var(--fg); font: 700 14px/20px var(--body, var(--font, sans-serif)); text-decoration: underline; cursor: pointer; }
  .err { margin: 0; color: var(--bad-text, var(--danger-text)); font: 400 14px/20px var(--body, var(--font, sans-serif)); }
  .stand { margin: 0; font: 700 16px/22px var(--body, var(--font, sans-serif)); }
  textarea { width: 100%; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--edge); background: var(--surface, var(--bg)); color: var(--fg); font: 400 15px/21px var(--body, var(--font, sans-serif)); resize: vertical; }
  .screen { margin: 0; max-height: 180px; overflow: auto; padding: 8px 10px; border-radius: 10px; background: var(--screen-bg); color: var(--screen-fg); font: 12px/17px var(--mono, monospace); white-space: pre; }
  @media (prefers-reduced-motion: reduce) { dialog.sheet { transition: none; } }
</style>
