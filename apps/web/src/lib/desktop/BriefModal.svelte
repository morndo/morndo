<script lang="ts">
  // The full decision brief (ADR-0023 §6.2). A native dialog: showModal makes the page inert, Escape fires cancel,
  // and focus starts on the headline so a long brief is read from the top. The answer stays in the footer.
  import { onMount } from "svelte";
  import { cardOf } from "@morndo/domain";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import Star from "@lucide/svelte/icons/star";
  import X from "@lucide/svelte/icons/x";
  import { MAY_HAVE_GONE, againLabel, endsDoubt } from "../catchup/answer.ts";
  import { renderBriefMarkdown, renderMarkdown } from "../markdown.ts";
  import { ago, deliveryLine, dueLabel, REFUSALS, type DecisionItem } from "./decisions.ts";
  import type { AnswerBody, AnswerProblem } from "./DecisionCard.svelte";

  let { item, now, verifiedFresh, onAnswer, onOpenScreen, onAskBrief, onClose }: {
    item: DecisionItem; now: number; verifiedFresh: boolean;
    onAnswer: (id: string, body: AnswerBody, requestId: string, seen?: string) => Promise<AnswerProblem | null>;
    onOpenScreen: (workerId: string) => void;
    onAskBrief: (item: DecisionItem) => boolean | Promise<boolean>;
    onClose: () => void;
  } = $props();

  let dialogEl = $state<HTMLDialogElement | null>(null);
  let headlineEl = $state<HTMLHeadingElement | null>(null);
  let wordsEl = $state<HTMLTextAreaElement | null>(null);
  let mode = $state<"idle" | "confirm" | "words">("idle");
  let picked = $state<{ label: string; body: AnswerBody } | null>(null);
  let words = $state("");
  let sending = $state(false);
  let error = $state<string | null>(null);
  let again = $state<{ body: AnswerBody; requestId: string; code: string } | null>(null);
  let sent = $state(false);
  let asked = $state(false);
  // The version on screen when the dialog opened. A restate changes item.version; the answer still names this one
  // until he asks for the new version, so the hub refuses it as changed (E12).
  let seen = $state(item.version);
  let shown = $state(item.version);

  const card = $derived(cardOf(item));
  const brief = $derived(item.brief);
  const stale = $derived(item.version !== shown);
  const open = $derived(item.status === "open");
  const canAnswer = $derived(open && item.answerable === null && !sent);
  const asker = $derived(item.asker.kind === "manager" ? "the manager" : item.asker.name);
  const whom = $derived(asker[0] ? asker[0].toUpperCase() + asker.slice(1) : asker);
  const headline = $derived(card.headline ?? item.title);
  const recommendKey = $derived(brief?.recommend ?? (item.answerBy === "tap" ? item.options[0]?.key ?? null : null));
  const standing = $derived.by(() => {
    const d = item.decision;
    if (!d) return "Sent. The manager gets it as your decision and acts on it.";
    const choice = d.choice.kind === "option" ? d.choice.label : "in words";
    const dl = deliveryLine(item);
    if (dl?.state === "queued") return `Queued${dl.why ? `, ${dl.why}` : ""}.`;
    if (dl?.state === "delivered") return `Delivered. You chose ${choice}.`;
    return `Sent. You chose ${choice}. ${whom} has it.`;
  });

  function dueLine(deadline: number): string {
    const label = dueLabel(deadline, now);
    if (deadline <= now) return label;
    const days = Math.round((deadline - now) / 86_400_000);
    if (days > 1) return `${label} (in ${days} days)`;
    if (days === 1) return `${label} (in 1 day)`;
    return label;
  }

  onMount(() => {
    dialogEl?.showModal();
    headlineEl?.focus();
  });
  $effect(() => { if (mode === "words") wordsEl?.focus(); });

  function showNew() { shown = item.version; seen = item.version; error = null; }
  function pick(label: string, body: AnswerBody) { picked = { label, body }; mode = "confirm"; error = null; }
  function writeWords() { words = ""; mode = "words"; error = null; }
  function back() { mode = "idle"; picked = null; if (!again) error = null; }
  function onCancel(e: Event) {
    if (sending) { e.preventDefault(); return; }
    if (mode !== "idle") { e.preventDefault(); back(); }
  }
  function onWordsKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (again) sendAgain(); else if (words.trim()) void send({ text: words }); }
    if (e.key === "Escape") { e.preventDefault(); back(); }
  }

  async function send(body: AnswerBody, requestId: string = crypto.randomUUID()) {
    if (sending) return;
    sending = true;
    error = null;
    const doubt = again;
    const problem = await onAnswer(item.id, body, requestId, seen);
    sending = false;
    if (problem) {
      error = problem.text;
      again = MAY_HAVE_GONE.has(problem.code) ? { body, requestId, code: problem.code } : doubt && !endsDoubt(problem.code) ? doubt : null;
      return;
    }
    again = null;
    sent = true;
    mode = "idle";
    picked = null;
  }
  function sendAgain() { if (again) void send(again.body, again.requestId); }
  async function ask() { asked = await onAskBrief(item); }
</script>

<dialog bind:this={dialogEl} class="brief" aria-labelledby="brief-headline" oncancel={onCancel} onclose={onClose}>
  <header>
    {#if stale}
      <p class="restated" role="status">{whom} restated this brief. <button type="button" class="link" onclick={showNew}>Show the new version</button></p>
    {/if}
    <div class="titlebar">
      <p class="kicker">Decision request{#if card.topic} · {card.topic}{/if}</p>
      <button type="button" class="close" onclick={onClose} aria-label="Close"><X size={20} /></button>
    </div>
    <p class="meta">
      <span>Approver · Owner</span>
      {#if card.due !== null}<span>{dueLine(card.due)}</span>{/if}
      {#if card.minutes !== null}<span>≈{card.minutes} min</span>{/if}
      {#if brief}<span>v{item.briefVersion}</span>{/if}
    </p>
    <p class="from">From {asker}, {ago(item.askedAt, now)}</p>
    {#if !card.hasBrief}<p class="plain">Filed without a brief{#if asked} <span role="status">Asked. This decision stays open.</span>{:else if open} <button type="button" class="link" onclick={ask}>Ask for a brief</button>{/if}</p>{/if}
    <h2 id="brief-headline" tabindex="-1" bind:this={headlineEl}>{headline}</h2>
    {#if card.spend}<p class="spend">Includes spend</p>{/if}
  </header>

  <div class="brief-body">
    {#if brief}
      <section>
        <h3>The ask</h3>
        <div class="md">{@html renderBriefMarkdown(brief.ask.text)}</div>
        <p class="pair"><b>Alternative</b> <span class="md">{@html renderBriefMarkdown(brief.ask.alternative)}</span></p>
        <p class="pair"><b>Uncertainty</b> <span class="md">{@html renderBriefMarkdown(brief.ask.uncertainty)}</span></p>
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
                <th scope="col" class:rec={o.key === brief.recommend}>{o.key.toUpperCase()} · {o.label}{#if o.key === brief.recommend}<span class="mark"><Star size={12} /> Recommended</span>{/if}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each brief.comparison.rows as row (row.factor)}
              <tr>
                <th scope="row">{row.factor}</th>
                {#each row.cells as cell, i (i)}<td class:rec={brief.options[i]?.key === brief.recommend}>{cell}</td>{/each}
              </tr>
            {/each}
          </tbody>
        </table>
        <div class="factors">
          {#each brief.comparison.rows as row (row.factor)}
            <h4>{row.factor}</h4>
            <ul>
              {#each brief.options as o, i (o.key)}
                <li class:rec={o.key === brief.recommend}>{#if o.key === brief.recommend}★ {/if}{o.key.toUpperCase()} · {o.label} <b>{row.cells[i]}</b></li>
              {/each}
            </ul>
          {/each}
        </div>
        <p class="note">{brief.comparison.note}</p>
      </section>
      <section>
        <h3>Why the recommendation</h3>
        <div class="md">{@html renderBriefMarkdown(brief.why.text)}</div>
        {#if brief.why.assumptions.length}
          <h4>Assumptions</h4>
          <ul>{#each brief.why.assumptions as a (a)}<li>{a}</li>{/each}</ul>
        {/if}
        <p class="pair"><b>Downside case</b> {brief.why.downside}</p>
      </section>
      <section>
        <h3>What would change it</h3>
        <p>{brief.changeIf}</p>
      </section>
      <section>
        <h3>Main risk and control</h3>
        <p class="pair"><b>Risk</b> {brief.risk.risk}</p>
        <p class="pair"><b>Control</b> {brief.risk.control}</p>
      </section>
      <section>
        <h3>What approval authorizes</h3>
        <p class="commit">The asker's commitment. Morndo records your answer and doesn't enforce the limits.</p>
        <ul>{#each brief.authorizes.limits as limit (limit)}<li>{limit}</li>{/each}</ul>
        <p class="pair"><b>Needs fresh approval</b> {brief.authorizes.freshApproval}</p>
        <p class="pair"><b>Review point</b> {brief.authorizes.reviewPoint}</p>
      </section>
      {#if brief.ifNoAnswer}
        <section>
          <h3>If no decision by the due date</h3>
          <p>{brief.ifNoAnswer}</p>
        </section>
      {/if}
      {#if brief.evidence.length}
        <section>
          <h3>Evidence</h3>
          <ul>
            {#each brief.evidence as e (e.url)}
              {#if e.url.startsWith("https://")}<li><a href={e.url} target="_blank" rel="noopener noreferrer">{e.label}</a></li>{/if}
            {/each}
          </ul>
        </section>
      {/if}
    {:else}
      {#if item.summary && item.summary !== headline}<p>{item.summary}</p>{/if}
      {#if item.recommendation}<p class="pair"><b>Recommended</b> {item.recommendation}</p>{/if}
      {#if item.ifNoAnswer}<p class="pair"><b>If you don't answer</b> {item.ifNoAnswer}</p>{/if}
      {#if item.details}<div class="md">{@html renderMarkdown(item.details)}</div>{/if}
      {#if item.context && item.contextKind === "markdown"}<div class="md">{@html renderMarkdown(item.context)}</div>{/if}
      {#if item.context && item.contextKind === "screen"}<pre class="screen">{item.context}</pre>{/if}
    {/if}
  </div>

  <footer>
    {#if sent}
      <p class="stand" role="status">{standing}</p>
      <button type="button" class="btn ghost" onclick={onClose}>Close</button>
    {:else if mode === "confirm" && picked}
      <div class="confirm" role="group" aria-label="Confirm your answer">
        <p class="your">Your answer: <b>{picked.label}</b></p>
        <p class="how">{whom} gets it as your decision and acts on it.</p>
        <div class="actions">
          {#if again}
            <button type="button" class="btn primary" disabled={sending} onclick={sendAgain}>{sending ? "Checking…" : againLabel(again.code)}</button>
          {:else}
            <button type="button" class="btn primary" disabled={sending} onclick={() => picked && send(picked.body)}>{sending ? "Sending…" : "Send answer"}</button>
          {/if}
          <button type="button" class="btn ghost" disabled={sending} onclick={back}>Back</button>
          {#if !verifiedFresh}<span class="shield"><ShieldAlert size={14} />Face ID or Touch ID first</span>{/if}
        </div>
      </div>
    {:else if mode === "words"}
      <div class="confirm" role="group" aria-label="Answer in words">
        <textarea bind:this={wordsEl} bind:value={words} rows="2" readonly={!!again} placeholder="Your answer for {asker}…" onkeydown={onWordsKey} aria-label="Your answer for {asker}"></textarea>
        <div class="actions">
          {#if again}
            <button type="button" class="btn primary" disabled={sending} onclick={sendAgain}>{sending ? "Checking…" : againLabel(again.code)}</button>
          {:else}
            <button type="button" class="btn primary" disabled={sending || !words.trim()} onclick={() => send({ text: words })}>{sending ? "Sending…" : `Send to ${asker}`}</button>
          {/if}
          <button type="button" class="btn ghost" disabled={sending} onclick={back}>Back</button>
          {#if !verifiedFresh}<span class="shield"><ShieldAlert size={14} />Face ID or Touch ID first</span>{:else}<span class="hint">Enter sends · Shift+Enter for a new line</span>{/if}
        </div>
      </div>
    {:else if again}
      <div class="actions">
        <button type="button" class="btn primary" disabled={sending} onclick={sendAgain}>{sending ? "Checking…" : againLabel(again.code)}</button>
      </div>
    {:else if canAnswer}
      <div class="actions">
        <span class="decide">Decision</span>
        {#if brief}
          {#each brief.options as o (o.key)}
            <button type="button" class="btn" class:primary={o.key === recommendKey} onclick={() => pick(`${o.key.toUpperCase()} · ${o.label}`, { key: o.key })}>
              {#if o.key === recommendKey}<Star size={14} />{/if}{o.key.toUpperCase()} · {o.label}
            </button>
          {/each}
          <button type="button" class="link" onclick={writeWords}>Something else…</button>
        {:else if item.answerBy === "tap"}
          {#each item.options as o (o.key)}
            <button type="button" class="btn" class:primary={o.key === recommendKey} onclick={() => pick(o.label, { key: o.key })}>
              {#if o.key === recommendKey}<Star size={14} />{/if}{o.label}
            </button>
          {/each}
          <button type="button" class="link" onclick={writeWords}>Something else…</button>
        {:else if item.answerBy === "screen"}
          {#if item.asker.workerId}<button type="button" class="btn primary" onclick={() => item.asker.workerId && onOpenScreen(item.asker.workerId)}>Answer in {item.asker.kind === "manager" ? "the manager" : `#${item.asker.name}`}'s terminal</button>{/if}
        {:else if item.need === "time"}
          <button type="button" class="btn primary" onclick={() => pick("Done", { text: "Done" })}>Done</button>
          <button type="button" class="btn" onclick={writeWords}>Reply…</button>
        {:else}
          <button type="button" class="btn primary" onclick={writeWords}>Answer…</button>
        {/if}
        <button type="button" class="btn ghost" onclick={onClose}>Close</button>
      </div>
      {#if !verifiedFresh}<p class="shield"><ShieldAlert size={14} />Face ID or Touch ID first</p>{/if}
    {:else if item.answerable}
      <p class="note">{REFUSALS[item.answerable]}</p>
      <button type="button" class="btn ghost" onclick={onClose}>Close</button>
    {:else}
      <button type="button" class="btn ghost" onclick={onClose}>Close</button>
    {/if}
    {#if error}<p class="err" role="alert">{error}</p>{/if}
  </footer>
</dialog>

<style>
  dialog.brief {
    width: min(760px, calc(100vw - 56px)); height: min(90vh, 100%); max-height: calc(100vh - 56px); margin: auto; padding: 0;
    border: 0; border-radius: 8px; background: var(--main-bg, #fff); color: var(--text, inherit);
    box-shadow: var(--shadow-modal, 0 18px 48px rgba(0, 0, 0, 0.35));
  }
  dialog.brief[open] { display: flex; flex-direction: column; overflow: hidden; }
  dialog.brief::backdrop { background: var(--overlay, rgba(13, 15, 22, 0.55)); }
  header, footer { flex: none; }
  header { padding: 20px 20px 12px 28px; }
  .titlebar { display: flex; align-items: flex-start; gap: 12px; }
  .kicker { flex: 1; margin: 0; font: 700 12px/16px var(--font, sans-serif); letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
  .close { width: 36px; height: 36px; margin-top: -6px; border: 0; border-radius: 8px; background: transparent; color: var(--muted); display: grid; place-items: center; cursor: pointer; }
  .close:hover { background: var(--hover); color: var(--text); }
  .meta, .from, .plain { margin: 4px 0 0; font: 400 13px/18px var(--font, sans-serif); color: var(--muted); }
  .meta { display: flex; flex-wrap: wrap; gap: 8px 16px; }
  h2 { margin: 12px 0 0; font: 900 22px/30px var(--font, sans-serif); }
  .spend { margin: 8px 0 0; font: 700 12px/16px var(--font, sans-serif); }
  .restated { margin: 0 0 10px; padding: 8px 10px; border-radius: 6px; background: var(--warn-bg); color: var(--warn-fg); font: 400 13px/18px var(--font, sans-serif); }
  .brief-body { container-type: inline-size; flex: 1; min-height: 0; overflow: auto; padding: 8px 28px 20px; background: var(--modal-body, transparent); }
  section { margin: 0 0 18px; }
  h3 { margin: 0 0 6px; font: 700 12px/16px var(--font, sans-serif); letter-spacing: 0.06em; text-transform: uppercase; }
  h4 { margin: 10px 0 4px; font: 700 13px/18px var(--font, sans-serif); }
  p { margin: 0 0 6px; font: 400 15px/22px var(--font, sans-serif); overflow-wrap: anywhere; }
  .pair b { font: 700 13px/18px var(--font, sans-serif); margin-right: 6px; }
  .commit { font: 400 13px/18px var(--font, sans-serif); color: var(--muted); }
  .md :global(p) { margin: 0 0 6px; }
  .md :global(ul), .md :global(ol) { margin: 2px 0 6px; padding-left: 22px; }
  .md :global(code) { font: 12px/18px var(--mono, monospace); padding: 1px 3px; border-radius: 3px; background: var(--code-bg); }
  .md :global(pre) { margin: 0 0 8px; padding: 8px 10px; overflow: auto; border-radius: 6px; background: var(--pre-bg, var(--code-bg)); }
  .md :global(a) { color: var(--link); }
  .md :global(blockquote) { margin: 0 0 8px; padding-left: 12px; border-left: 3px solid var(--border); color: var(--muted); }
  table.compare { width: 100%; border-collapse: collapse; font: 400 13px/18px var(--font, sans-serif); }
  caption.sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  th, td { padding: 6px 8px; border: 1px solid var(--border); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
  th { font: 700 12px/16px var(--font, sans-serif); }
  .mark { display: flex; align-items: center; gap: 4px; margin-top: 2px; font: 700 11px/14px var(--font, sans-serif); }
  .rec { background: var(--selected); }
  .note { margin-top: 6px; font: 400 13px/18px var(--font, sans-serif); color: var(--muted); }
  .factors { display: none; }
  @container (max-width: 559px) {
    table.compare { display: none; }
    .factors { display: block; }
    .factors ul { list-style: none; margin: 0 0 10px; padding: 0; }
    .factors li { padding: 2px 0; font: 400 14px/20px var(--font, sans-serif); }
  }
  ul { margin: 4px 0 8px; padding-left: 22px; }
  footer { padding: 12px 20px 16px 28px; border-top: 1px solid var(--border); background: var(--main-bg); }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .decide { font: 700 13px/18px var(--font, sans-serif); margin-right: 4px; }
  .btn {
    display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 5px 14px; border-radius: 6px; max-width: 100%;
    border: 1px solid var(--outline, var(--border)); background: var(--main-bg); color: var(--text); font: 700 14px/20px var(--font, sans-serif);
    cursor: pointer; text-align: left;
  }
  .btn.primary { background: var(--send); border-color: var(--send); color: var(--send-fg); }
  .btn.ghost { border-color: transparent; background: transparent; }
  .btn:disabled { opacity: 0.45; cursor: default; }
  .link { padding: 0; border: 0; background: none; color: var(--link); font: 700 13px/19px var(--font, sans-serif); cursor: pointer; text-decoration: underline; }
  .confirm { display: grid; gap: 8px; }
  .your { margin: 0; }
  .how, .hint, .shield, .note { font: 400 13px/18px var(--font, sans-serif); color: var(--muted); }
  .shield { display: inline-flex; align-items: center; gap: 5px; }
  .err { margin: 8px 0 0; color: var(--bad-fg); font: 400 13px/18px var(--font, sans-serif); }
  .stand { margin: 0 0 8px; font: 400 15px/22px var(--font, sans-serif); }
  textarea {
    width: 100%; min-height: 60px; resize: vertical; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border);
    background: var(--main-bg); color: var(--text); font: 400 15px/22px var(--font, sans-serif);
  }
  .screen { margin: 0; max-height: 220px; overflow: auto; padding: 8px 10px; border-radius: 6px; background: var(--term-bg); color: var(--term-fg); font: 12px/17px var(--mono, monospace); white-space: pre; }
  @media (prefers-reduced-motion: reduce) {
    dialog.brief { transition: none; }
  }
</style>
