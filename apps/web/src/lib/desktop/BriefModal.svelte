<script lang="ts">
  // The full decision brief (ADR-0023 §6.2). A native dialog: showModal makes the page inert, Escape fires cancel,
  // and focus starts on the headline so a long brief is read from the top. The answer stays in the footer.
  import { onMount, tick } from "svelte";
  import { cardOf } from "@morndo/domain";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import Star from "@lucide/svelte/icons/star";
  import X from "@lucide/svelte/icons/x";
  import { againLabel } from "../catchup/answer.ts";
  import { renderBriefInline, renderBriefMarkdown, renderMarkdown } from "../markdown.ts";
  import { AnswerSession } from "./answer-session.svelte.ts";
  import type { AnswerBody, AnswerProblem, AskOutcome } from "./answer-session.ts";
  import { ago, dueLine, REFUSALS, standingLine, type DecisionItem } from "./decisions.ts";

  let { item, now, verifiedFresh, session: given, onAnswer, onOpenScreen, onAskBrief, onClose }: {
    item: DecisionItem; now: number; verifiedFresh: boolean; session?: AnswerSession;
    onAnswer: (id: string, body: AnswerBody, requestId: string, seen?: string) => Promise<AnswerProblem | null>;
    onOpenScreen: (workerId: string) => void;
    onAskBrief: (item: DecisionItem) => Promise<AskOutcome>;
    onClose: () => void;
  } = $props();

  const own = new AnswerSession(item);
  const session = $derived(given ?? own);
  let dialogEl = $state<HTMLDialogElement | null>(null);
  let headlineEl = $state<HTMLHeadingElement | null>(null);
  let wordsEl = $state<HTMLTextAreaElement | null>(null);

  const view = $derived(session.shown);
  const card = $derived(cardOf(view));
  const brief = $derived(view.brief);
  const open = $derived(item.status === "open");
  const canAnswer = $derived(open && item.answerable === null && !session.sent && !session.stale);
  const asker = $derived(item.asker.kind === "manager" ? "the manager" : item.asker.name);
  const whom = $derived(asker[0] ? asker[0].toUpperCase() + asker.slice(1) : asker);
  const terminal = $derived(item.asker.kind === "manager" ? "the manager" : `#${item.asker.name}`);
  const headline = $derived(card.headline ?? view.title);
  const recommendKey = $derived(brief?.recommend ?? (view.answerBy === "tap" ? view.options[0]?.key ?? null : null));
  const standing = $derived(standingLine(item, whom, session.sent));

  const takeFocus = (node: HTMLElement) => node.focus();

  onMount(() => {
    dialogEl?.showModal();
    headlineEl?.focus();
  });
  $effect(() => { if (session.mode === "words") wordsEl?.focus(); });

  function showNew() { session.showNew(); tick().then(() => headlineEl?.focus()); }
  function choose(label: string, body: AnswerBody) { session.pick(label, body); }
  function writeWords() {
    if (session.stale || session.sending || session.again || !open) return;
    session.words = "";
    session.mode = "words";
    session.error = null;
  }
  function back() { session.back(); tick().then(() => headlineEl?.focus()); }
  function requestClose() { if (!session.sending) onClose(); }
  function onCancel(e: Event) {
    if (session.sending) { e.preventDefault(); return; }
    if (session.mode !== "idle") { e.preventDefault(); back(); }
  }
  function onWordsKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (session.again) sendAgain(); else if (session.words.trim()) void send({ text: session.words }); }
    if (e.key === "Escape") { e.preventDefault(); back(); }
  }

  async function send(body: AnswerBody, requestId?: string) {
    await session.send(onAnswer, body, requestId);
    if (session.sent) headlineEl?.focus();
  }
  function sendAgain() { if (session.again) void send(session.again.body, session.again.requestId); }
  function ask() { void session.ask(onAskBrief); }
</script>

<dialog bind:this={dialogEl} class="brief" aria-labelledby="brief-headline" oncancel={onCancel} onclose={onClose}>
  <header>
    {#if session.stale}
      <p class="restated" role="status">{whom} restated this brief. <button type="button" class="link" onclick={showNew}>Show the new version</button></p>
    {/if}
    <div class="titlebar">
      <p class="kicker">Decision request{#if card.topic} · {card.topic}{/if}</p>
      <button type="button" class="close" onclick={requestClose} aria-label="Close" disabled={session.sending}><X size={20} /></button>
    </div>
    <p class="meta">
      <span>Approver · Owner</span>
      {#if card.due !== null}<span>{dueLine(card.due, now)}</span>{/if}
      {#if card.minutes !== null}<span>≈{card.minutes} min</span>{/if}
      {#if brief}<span>v{view.briefVersion}</span>{/if}
    </p>
    <p class="from">From {asker}, {ago(item.askedAt, now)}</p>
    {#if !card.hasBrief}
      <p class="plain">Filed without a brief{#if session.asked} <span role="status">Asked. This decision stays open.</span>{:else if open} <button type="button" class="link" disabled={session.asking} onclick={ask}>Ask for a brief</button>{/if}</p>
      {#if session.askError}<p class="err" role="alert">{session.askError}</p>{/if}
    {/if}
    <h2 id="brief-headline" tabindex="-1" bind:this={headlineEl}>{headline}</h2>
    {#if card.spend}<p class="spend">Includes spend</p>{/if}
  </header>

  <div class="brief-body">
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
                <li class:rec={o.key === brief.recommend}>{#if o.key === brief.recommend}★ {/if}{o.key.toUpperCase()} · {@html renderBriefInline(o.label)} <b>{@html renderBriefInline(row.cells[j] ?? "")}</b></li>
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
  </div>

  <footer>
    {#if session.sent}
      <p class="stand" role="status">{standing}</p>
      <button type="button" class="btn ghost" onclick={requestClose}>Close</button>
    {:else if !open}
      <p class="stand" role="status">This decision is no longer open.</p>
      <button type="button" class="btn ghost" onclick={requestClose}>Close</button>
    {:else if session.stale}
      {#if session.again}
        <div class="actions">
          <button type="button" class="btn primary" disabled={session.sending} onclick={sendAgain}>{session.sending ? "Checking…" : againLabel(session.again.code)}</button>
        </div>
      {:else}
        <button type="button" class="btn ghost" onclick={requestClose}>Close</button>
      {/if}
    {:else if session.mode === "confirm" && session.picked}
      <div class="confirm" role="group" aria-label="Confirm your answer">
        <p class="your">Your answer: <b>{session.picked.label}</b></p>
        <p class="how">{whom} gets it as your decision and acts on it.</p>
        <div class="actions">
          {#if session.again}
            <button type="button" class="btn primary" disabled={session.sending || !open} onclick={sendAgain}>{session.sending ? "Checking…" : againLabel(session.again.code)}</button>
          {:else}
            <button type="button" class="btn primary" disabled={session.sending || !open} use:takeFocus onclick={() => session.picked && send(session.picked.body)}>{session.sending ? "Sending…" : "Send answer"}</button>
          {/if}
          <button type="button" class="btn ghost" disabled={session.sending} onclick={back}>Back</button>
          {#if !verifiedFresh}<span class="shield"><ShieldAlert size={14} />Face ID or Touch ID first</span>{/if}
        </div>
      </div>
    {:else if session.mode === "words"}
      <div class="confirm" role="group" aria-label="Answer in words">
        <textarea bind:this={wordsEl} value={session.words} rows="2" readonly={!!session.again} placeholder="Your answer for {asker}…" onkeydown={onWordsKey} oninput={(e) => (session.words = e.currentTarget.value)} aria-label="Your answer for {asker}"></textarea>
        <div class="actions">
          {#if session.again}
            <button type="button" class="btn primary" disabled={session.sending || !open} onclick={sendAgain}>{session.sending ? "Checking…" : againLabel(session.again.code)}</button>
          {:else}
            <button type="button" class="btn primary" disabled={session.sending || !open || !session.words.trim()} onclick={() => send({ text: session.words })}>{session.sending ? "Sending…" : `Send to ${asker}`}</button>
          {/if}
          <button type="button" class="btn ghost" disabled={session.sending} onclick={back}>Back</button>
          {#if !verifiedFresh}<span class="shield"><ShieldAlert size={14} />Face ID or Touch ID first</span>{:else}<span class="hint">Enter sends · Shift+Enter for a new line</span>{/if}
        </div>
      </div>
    {:else if session.again}
      <div class="actions">
        <button type="button" class="btn primary" disabled={session.sending || !open} use:takeFocus onclick={sendAgain}>{session.sending ? "Checking…" : againLabel(session.again.code)}</button>
      </div>
    {:else if open && item.answerBy === "screen"}
      <div class="actions">
        {#if item.asker.workerId}<button type="button" class="btn primary" onclick={() => item.asker.workerId && onOpenScreen(item.asker.workerId)}>Answer in {terminal}'s terminal</button>{/if}
        <button type="button" class="btn ghost" onclick={requestClose}>Close</button>
      </div>
    {:else if canAnswer}
      <div class="actions">
        <span class="decide">Decision</span>
        {#if brief}
          {#each brief.options as o (o.key)}
            <button type="button" class="btn" class:primary={o.key === recommendKey} onclick={() => choose(`${o.key.toUpperCase()} · ${o.label}`, { key: o.key })}>
              {#if o.key === recommendKey}<Star size={14} />{/if}{o.key.toUpperCase()} · {@html renderBriefInline(o.label)}
            </button>
          {/each}
          <button type="button" class="link" onclick={writeWords}>Something else…</button>
        {:else if view.answerBy === "tap"}
          {#each view.options as o (o.key)}
            <button type="button" class="btn" class:primary={o.key === recommendKey} onclick={() => choose(o.label, { key: o.key })}>
              {#if o.key === recommendKey}<Star size={14} />{/if}{o.label}
            </button>
          {/each}
          <button type="button" class="link" onclick={writeWords}>Something else…</button>
        {:else if view.need === "time"}
          <button type="button" class="btn primary" onclick={() => choose("Done", { text: "Done" })}>Done</button>
          <button type="button" class="btn" onclick={writeWords}>Reply…</button>
        {:else}
          <button type="button" class="btn primary" onclick={writeWords}>Answer…</button>
        {/if}
        <button type="button" class="btn ghost" onclick={requestClose}>Close</button>
      </div>
      {#if !verifiedFresh}<p class="shield"><ShieldAlert size={14} />Face ID or Touch ID first</p>{/if}
    {:else if item.answerable}
      <p class="note">{REFUSALS[item.answerable]}</p>
      <button type="button" class="btn ghost" onclick={requestClose}>Close</button>
    {:else}
      <button type="button" class="btn ghost" onclick={requestClose}>Close</button>
    {/if}
    {#if session.error}<p class="err" role="alert">{session.error}</p>{/if}
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
  a, a:visited { color: var(--link); }
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
