<script lang="ts">
  // A decision card in catch-up (ADR-0009, the design's catchup-1): who asks and for which project, the question, the
  // recommendation and what happens if he doesn't answer, and the options as buttons, the recommended one first. Since
  // the owner's feedback of 2026-10-04 it reads short (brief.ts: a title, one sentence, the rest behind More), the
  // options are big buttons, and "Answer in my own words" is a button of its own under them, never a small link. A tap
  // says "Answered: …" with Undo for 5 seconds before it goes (CatchUp.svelte holds the window). A decision is never
  // marked read; one that closed elsewhere, or that the hub refuses, says so here and nothing is answered (E8–E11).
  import Star from "@lucide/svelte/icons/star";
  import Clock from "@lucide/svelte/icons/clock";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import PenLine from "@lucide/svelte/icons/pen-line";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import { cardOf } from "@morndo/domain";
  import { renderMarkdown } from "../markdown.ts";
  import { REFUSALS, ago, deliveryLine, standingLine, type DecisionItem } from "../desktop/decisions.ts";
  import { byLabel } from "./horizon.ts";
  import { actions, brief, due } from "./brief.ts";
  import type { Body } from "../catchup/run.ts";
  import { MAY_HAVE_GONE, againLabel } from "../catchup/answer.ts";

  let { item, primed, index, of, now, answering, refusal, note, onPick, onUndo, onVerifyAgain, onTryAgain, onScreen, onNext, onOpenBrief }: {
    item: DecisionItem | null; primed: boolean; index: number; of: number; now: number;
    answering: { label: string; sending: boolean; commitAt: number } | null;
    refusal: { code: string; text: string } | null; note: string | null;
    onPick: (body: Body, label: string) => Promise<boolean>; onUndo: () => void; onVerifyAgain: () => void; onTryAgain: () => void;
    onScreen: (workerId: string) => void; onNext: () => void; onOpenBrief?: () => void;
  } = $props();

  let words = $state("");
  let writing = $state(false);
  let showWhy = $state(false);
  const open = $derived(item?.status === "open");
  const canAnswer = $derived(!!item && open && item.answerable === null && !answering);
  const askerName = $derived(item ? (item.asker.kind === "manager" ? "Manager" : item.asker.name) : "");
  const dueText = $derived(item?.deadline == null ? null : item.deadline <= now ? due(item.deadline, now) : `due ${byLabel(item.deadline, now).replace(/^by (the )?/, "")}`);
  const b = $derived(item ? brief(item, now) : null);
  const compact = $derived(item?.brief ? cardOf(item) : null);
  const acts = $derived(item ? actions(item, "card") : []);
  // What the card draws, once, for the loop, the "or" and which button is primary. A task (an Ask that became one while
  // its card was on top) gets Done; its Later is catch-up's own Later under the card (code review #11).
  const drawn = $derived(acts.filter(a => a.kind !== "later" && a.kind !== "decide"));
  // The meta line under the title, without what the kicker already says (decision, due).
  const meta = $derived((b?.meta ?? []).filter(m => m !== "Decision" && !m.startsWith("due ") && !m.startsWith("overdue ") && !/^≈\d+ min$/.test(m)));
  // With options, the recommended one is marked on its button; the reason for it waits behind More, so the options and
  // his own words fit on the card (and the kicker already says when it is due).
  const marked = $derived(acts.some(a => a.kind === "option" && a.recommended));
  const hasMore = $derived(!compact && !!b && (!!b.more.text || !!b.more.link || !!item?.context || (marked && !!b.more.recommendation)));
  const sentenceCase = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const left = $derived(answering ? Math.max(0, Math.ceil((answering.commitAt - now) / 1000)) : 0);
  // ADR-0010: an answer for the manager waits in its inbox until it reached the manager.
  function answeredHere(d: DecisionItem): string {
    const dl = deliveryLine(d);
    if (dl?.state === "queued") return `Answered. Queued, it will be delivered${dl.why ? `: ${dl.why}` : ""}.`;
    if (dl?.state === "delivered") return "Answered. Delivered to the manager.";
    return "Answered.";
  }
  // What closed it, in words, when it isn't open any more.
  // Not on the board: gone, if the board is current; otherwise nothing can be said yet (review of PR #7, finding 8).
  const closed = $derived(!item ? (primed ? "This decision isn't on the hub's list anymore." : null)
    : item.status === "answered" ? (item.decision?.via === "elsewhere" ? standingLine(item, "") : answeredHere(item))
    : item.status === "settled" ? `Settled${item.resolution ? `: ${item.resolution}` : "."}`
    : item.status === "expired" ? "Expired: nobody answered within a day." : null);
  // The words stay until the answer has started (offline, a cancelled passkey check, or a refusal keep them; Undo
  // brings them back with "Answer in your own words"): review of PR #7, finding 13.
  async function sendWords() {
    const t = words.trim();
    if (t && await onPick({ text: t }, "your own words")) writing = false;
  }
</script>

<header class="card-head">
  <span class="avatar" aria-hidden="true">{askerName.slice(0, 1).toUpperCase()}</span>
  <span class="who"><b>{askerName} asks you</b><span>{item?.project ? `#${item.project} · ` : ""}{item ? ago(item.askedAt, now) : ""}</span></span>
  {#if item?.blocking && open}<span class="chip bad">Blocking</span>{/if}
</header>

<div class="card-body">
  <p class="kicker">{compact ? compact.topic : `Decision ${index} of ${of}`}{dueText ? ` · ${dueText}` : ""}{#if compact?.minutes != null} · ≈{compact.minutes} min{/if}</p>
  <h2 class="q">{compact?.headline ?? b?.title ?? "A decision"}</h2>
  {#if compact?.spend}<p class="spend">Includes spend</p>{/if}
  {#if !compact && b?.sentence}<p class="sum">{b.sentence}</p>{/if}
  {#if compact?.spend && compact.recommended}<p class="sum"><b>Recommended:</b> {compact.recommended}</p>{/if}
  {#if item?.context && item.contextKind === "screen"}
    {#if meta.length}<p class="meta">{sentenceCase(meta.join(" · "))}</p>{/if}
    <pre class="screen">{item.context}</pre>
  {:else if meta.length || hasMore}
    <div class="metarow">
      {#if meta.length}<span class="meta">{sentenceCase(meta.join(" · "))}</span>{/if}
      {#if hasMore}<button class="pbtn small ghost more" onclick={() => (showWhy = !showWhy)} aria-expanded={showWhy}>{showWhy ? "Less" : "More"}<span class="caret" class:up={showWhy}><ChevronDown size={16} /></span></button>{/if}
    </div>
    {#if showWhy && b}
      <div class="why">
        {#if marked && b.more.recommendation}<p><b>Why it recommends “{item?.options[0]?.label}”:</b> {b.more.recommendation}</p>{/if}
        {#if b.more.text}<p class="long">{b.more.text}</p>{/if}
        {#if item?.context}<div class="md">{@html renderMarkdown(item.context)}</div>{/if}
        {#if b.more.link}<a class="pbtn small link" href={b.more.link} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} />Open the link</a>{/if}
      </div>
    {/if}
  {/if}

  {#if item && open && ((item.recommendation && !marked) || item.ifNoAnswer)}
    <div class="rec">
      {#if item.recommendation && !marked}<div><Star size={16} /><span><b>Recommended:</b> {item.recommendation}</span></div>{/if}
      {#if item.ifNoAnswer}<div><Clock size={16} /><span><b>If you don't answer:</b> {item.ifNoAnswer}</span></div>{/if}
    </div>
  {/if}

  {#if answering}
    <div class="state" role="status">
      <p><b>Answered: {answering.label}</b></p>
      <p class="note">{answering.sending ? "Sending…" : `Goes in ${left} s.`}</p>
    </div>
    {#if !answering.sending}<button class="pbtn small undo" onclick={onUndo}>Undo</button>{/if}
  {:else if !item && !primed}
    <p class="note" role="status">Waiting for the hub to say where this decision stands…</p>
  {:else if closed}
    {#if refusal && !MAY_HAVE_GONE.has(refusal.code)}<p class="err" role="alert">{refusal.text}</p>{/if}
    <div class="state" role="status"><p>{closed}</p>{#if item && item.decision?.via !== "here"}<p class="note">Nothing was answered from here.</p>{/if}</div>
    <button class="pbtn primary block" onclick={onNext}>Next card</button>
  {:else if item}
    {#if refusal}
      <p class="err" role="alert">{refusal.text}</p>
      {#if refusal.code === "step_up"}<button class="pbtn small" onclick={onVerifyAgain}><ShieldAlert size={16} />Confirm with passkey and send</button>
      {:else if MAY_HAVE_GONE.has(refusal.code)}<button class="pbtn small" onclick={onTryAgain}>{againLabel(refusal.code)}</button>{/if}
    {/if}
    {#if note}<p class="err" role="alert">{note}</p>{/if}
    {#if item.notice}<p class="note" role="status">{item.notice}</p>{/if}
    {#if item.answerBy === "screen"}
      {#if item.options.length}
        <ul class="ro">{#each item.options as o (o.key)}<li><b>{o.label}</b>{#if o.detail}<small>{o.detail}</small>{/if}</li>{/each}</ul>
      {/if}
      {#if item.asker.workerId}<button class="pbtn block" onclick={() => item.asker.workerId && onScreen(item.asker.workerId)}><SquareTerminal size={18} />Answer on its screen</button>{/if}
      <p class="note">{askerName} waits at a prompt on its own screen; Morndo never presses keys in it.</p>
    {:else if compact}
      <div class="opts">
        {#each compact.quickAnswers as a, i (a.key)}
          <button class="pbtn opt" class:primary={i === 0} disabled={!canAnswer} onclick={() => void onPick({ key: a.key }, a.label)}>
            <span>{a.label}</span>{#if i === 0}<small>Recommended</small>{/if}
          </button>
        {/each}
        <button class="pbtn read" class:primary={compact.quickAnswers.length === 0} data-open-brief={item?.id} aria-haspopup="dialog" onclick={() => onOpenBrief?.()}>Read the brief</button>
      </div>
      {#if item.answerable}<p class="note">{REFUSALS[item.answerable] ?? item.answerable}</p>{/if}
    {:else if writing}
      <label class="sr" for="words">Your answer for {askerName}</label>
      <textarea id="words" bind:value={words} rows="3" placeholder="Your answer for {askerName}…"></textarea>
      <div class="opts">
        <button class="pbtn primary" disabled={!words.trim() || !canAnswer} onclick={() => void sendWords()}>Send to {askerName}</button>
        <button class="pbtn" onclick={() => (writing = false)}>Cancel</button>
      </div>
    {:else}
      <div class="opts">
        {#each drawn as a (a.kind === "option" ? `o:${a.key}` : a.kind)}
          {#if a.kind === "done"}
            <button class="pbtn opt primary" disabled={!canAnswer} onclick={() => void onPick({ text: "Done" }, "Done")}><span>Done</span></button>
          {:else if a.kind === "option"}
            <button class="pbtn opt" class:primary={a.recommended} disabled={!canAnswer} onclick={() => void onPick({ key: a.key }, a.label)}>
              <span>{a.label}</span>{#if a.recommended}<small>Recommended</small>{/if}
            </button>
          {:else if a.kind === "default"}
            <button class="pbtn opt" disabled={!canAnswer} onclick={() => void onPick({ text: `Go with the default: ${a.text}` }, "go with the default")}>
              <span>Go with the default</span><small class="def">{a.text}</small>
            </button>
          {:else if a.kind === "words"}
            {#if drawn.length > 1}<p class="or" aria-hidden="true"><span>or</span></p>{/if}
            <button class="pbtn words" class:primary={drawn.length === 1} disabled={!canAnswer} onclick={() => (writing = true)}><PenLine size={18} />Answer in my own words</button>
          {/if}
        {/each}
      </div>
      {#if item.answerable}<p class="note">{REFUSALS[item.answerable] ?? item.answerable}</p>{/if}
    {/if}
  {/if}
</div>

<style>
  .card-head { padding: 16px 20px 13px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 10px; }
  .who { flex: 1; min-width: 0; }
  .who b { display: block; font: 700 15px/20px var(--body); }
  .who span { display: block; font: 400 13px/18px var(--body); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* touch-action is intersected only up to the nearest scroll container, so each scroller in the card says pan-y too,
     or a swipe that starts on it is the browser's pan (pointercancel); review of PR #7, finding 3. */
  .card-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 14px 20px 18px; touch-action: pan-y; }
  .q { font: 600 25px/29px var(--display); letter-spacing: -0.015em; margin: 3px 0 4px; overflow-wrap: anywhere; }
  .sum { margin: 0 0 2px; font: 400 16px/22px var(--body); color: var(--fg); overflow-wrap: anywhere; }
  .meta { margin: 0; font: 400 13px/18px var(--body); color: var(--muted); }
  .metarow { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; }
  .why { display: grid; gap: 8px; justify-items: start; margin: 8px 0 2px; padding-top: 10px; border-top: 1px solid var(--line); font: 400 14.5px/20px var(--body); overflow-wrap: anywhere; }
  .why .long { margin: 0; white-space: pre-wrap; }
  .why :global(p) { margin: 0 0 6px; }
  .why :global(ul), .why :global(ol) { margin: 2px 0 6px; padding-left: 20px; }
  .why :global(code) { font-size: 0.9em; }
  .card-body .more { margin-left: auto; margin-right: -10px; }
  .card-body .pbtn.ghost { border-color: transparent; padding: 0 10px; gap: 4px; }
  .caret { display: inline-flex; transition: transform 150ms; }
  .caret.up { transform: rotate(180deg); }
  @media (prefers-reduced-motion: reduce) { .caret { transition: none; } }
  .link { gap: 6px; }
  .screen { margin: 4px 0 8px; max-height: 180px; overflow: auto; padding: 8px 10px; border-radius: 10px; background: var(--screen-bg); color: var(--screen-fg); font: 11.5px/16px var(--mono); white-space: pre; }
  .rec { margin: 6px 0 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .rec div { display: grid; grid-template-columns: 22px 1fr; gap: 8px; padding: 7px 0; font: 400 13.5px/19px var(--body); }
  .rec div + div { border-top: 1px solid var(--line); }
  .rec :global(svg) { margin-top: 2px; color: var(--muted); }
  /* The options are the card's main act: big, the recommended (first) one filled; his own words a button of its own. */
  .opts { display: grid; gap: 9px; margin-top: 12px; }
  /* "Recommended" sits above its option's words, so a long label keeps the whole width. */
  .opts .opt { flex-direction: column; align-items: flex-start; justify-content: center; gap: 3px; min-height: 56px; padding: 8px 18px; border-radius: 14px; font: 700 17px/1.25 var(--body); text-align: left; }
  .opt small { order: -1; font: 700 11px/13px var(--body); letter-spacing: 0.06em; text-transform: uppercase; }
  .opt small.def { order: 0; text-transform: none; letter-spacing: 0; font-weight: 400; font-size: 13px; line-height: 17px; }
  .or { display: flex; align-items: center; gap: 10px; margin: 0; color: var(--muted); font: 400 13px/1 var(--body); }
  .or::before, .or::after { content: ""; flex: 1; height: 1px; background: var(--line); }
  .words, .read { min-height: 48px; gap: 8px; font-size: 16px; width: 100%; }
  .spend { margin: 6px 0 0; font: 700 12px/16px var(--body); }
  .state { margin-top: 14px; padding: 12px 14px; border-radius: 14px; background: var(--fill); }
  .state p { margin: 0; color: var(--fg); }
  .state .note { color: var(--fg); }
  .undo { margin-top: 10px; }
  .err { margin-top: 12px; }
  .ro { list-style: none; margin: 10px 0; padding: 0; display: grid; gap: 6px; }
  .ro li { display: grid; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; font: 400 14px/19px var(--body); }
  .ro small { color: var(--muted); font-size: 12.5px; }
  .block { width: 100%; margin-top: 8px; }
  textarea { width: 100%; margin-top: 12px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--edge); background: var(--surface); color: var(--fg); font: 400 15px/21px var(--body); resize: vertical; }
  textarea::placeholder { color: var(--morndo-placeholder); }
</style>
