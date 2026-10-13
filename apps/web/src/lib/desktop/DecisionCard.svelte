<script lang="ts" module>
  export type { AnswerBody, AnswerProblem } from "./answer-session.ts";
</script>

<script lang="ts">
  // One decision, in the Decisions panel or under the manager's message in the chat (ADR-0006 addendum "Decisions").
  // Built like a Slack message attachment with Block Kit buttons: a 4px color bar for urgency, the question, what
  // happens if nobody answers, and the options with the asker's recommendation first. Picking an option asks once more
  // before it goes; the manager then gets it exactly like a tap in the chat bot.
  // An answer that may have been typed (the hub's 409 "uncertain": the manager's machine may have typed it; or no answer
  // of the hub's own) keeps its body and request id, and Check again (Try again) sends exactly those again: the hub
  // asks that machine and never types it twice (fleet core §3.1, §7).
  import CalendarClock from "@lucide/svelte/icons/calendar-clock";
  import CheckCheck from "@lucide/svelte/icons/check-check";
  import CircleCheckBig from "@lucide/svelte/icons/circle-check-big";
  import Flag from "@lucide/svelte/icons/flag";
  import Hourglass from "@lucide/svelte/icons/hourglass";
  import Lightbulb from "@lucide/svelte/icons/lightbulb";
  import MessageSquareText from "@lucide/svelte/icons/message-square-text";
  import Repeat from "@lucide/svelte/icons/repeat-2";
  import Signpost from "@lucide/svelte/icons/signpost";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import Star from "@lucide/svelte/icons/star";
  import { cardOf } from "@morndo/domain";
  import AnswerFooter from "./AnswerFooter.svelte";
  import { AnswerSession } from "./answer-session.svelte.ts";
  import type { AnswerBody, AnswerProblem } from "./answer-session.ts";
  import { ago, deliveryLine, dueLabel, REFUSALS, urgency, type DecisionItem } from "./decisions.ts";
  import { viaOf } from "../sent-here.ts";
  import { clock } from "./grouping.ts";

  let { item, variant, now, verifiedFresh, briefOpen = false, session: given, onAnswer, onOpenScreen, onOpenChat, onOpen }: {
    item: DecisionItem; variant: "panel" | "inline"; now: number; verifiedFresh: boolean; briefOpen?: boolean;
    session?: AnswerSession;
    onAnswer: (id: string, body: AnswerBody, requestId: string, seen?: string) => Promise<AnswerProblem | null>;
    onOpenScreen: (workerId: string) => void; onOpenChat?: (item: DecisionItem) => void;
    onOpen?: (item: DecisionItem) => void;
  } = $props();

  const own = new AnswerSession(item);
  const session = $derived(given ?? own);
  $effect(() => { if (!given) own.bind(item, false); });

  // The body is the version the pending answer targets. A restate stays behind the banner until it is shown.
  const view = $derived(session.shown);
  const u = $derived(urgency(view, now));
  const open = $derived(item.status === "open");
  const canAnswer = $derived(open && item.answerable === null);
  const card = $derived(cardOf(view));
  const asker = $derived(view.asker.kind === "manager" ? "Manager" : `#${view.asker.name}`);
  const whom = $derived(view.asker.kind === "manager" ? "the manager" : view.asker.name);
  const answers = $derived(variant === "panel" ? card.quickAnswers : view.options);
  const recommended = $derived(view.answerBy === "tap" ? answers[0]?.key ?? null : null);
  // In the chat the message above is the context, so the question line shows only when it says something new.
  const showRecommendation = $derived(!!view.recommendation && open);
  const showDefault = $derived(!!view.ifNoAnswer && open);
  let root = $state<HTMLElement | null>(null);
  // Picking an option opens the confirmation inside the card: keep it in view (the chat may have it at the bottom edge).
  $effect(() => { if (session.mode !== "idle") requestAnimationFrame(() => root?.querySelector(".confirm")?.scrollIntoView({ block: "nearest" })); });
  const showTitle = $derived(!(view.context ?? "").includes(view.title.slice(0, 48)));
  const byline = $derived([
    asker,
    ago(view.askedAt, now),
    card.minutes !== null ? `≈${card.minutes} min` : null,
    card.spend ? "Includes spend" : null,
    view.blocking && open ? "Blocking" : null,
    view.askedAgain && open ? "Asked again" : null,
    card.hasBrief ? null : "Filed without a brief",
  ].filter((part): part is string => part !== null).join(" · "));
  const readLabel = $derived(card.hasBrief ? "Read the brief ›" : "Details ›");

  function choose(label: string, body: AnswerBody) { session.pick(label, body); }
  function writeWords(prefill = "") {
    if (session.stale || session.sending || session.again || !open) return;
    session.words = prefill;
    session.mode = "words";
    session.error = null;
  }
  function send(body: AnswerBody, requestId?: string) { void session.send(onAnswer, body, requestId); }
</script>

<article bind:this={root} class="dc {variant} u-{u}" data-decision={item.id} aria-label="Decision: {card.topic}">
  {#if variant === "panel"}
    <div class="top">
      {#if card.headline}
        <p class="topic" id="topic-{item.id}">{card.topic}</p>
      {:else}
        <h3 class="hit"><button type="button" class="headline" aria-haspopup="dialog" aria-expanded={briefOpen} id="topic-{item.id}" onclick={() => onOpen?.(item)}>{card.topic}</button></h3>
      {/if}
      {#if card.due !== null && (open || item.status === "answered")}
        <span class="chip" class:bad={u === "overdue"} class:warn={u === "soon"}><CalendarClock size={12} />{dueLabel(card.due, now)}</span>
      {/if}
    </div>
    {#if card.headline}
      <h3 class="hit"><button type="button" class="headline" aria-haspopup="dialog" aria-expanded={briefOpen} onclick={() => onOpen?.(item)}>{card.headline}</button></h3>
    {/if}
    <p class="byline">{byline}</p>
    {#if card.spend && card.recommended}<p class="rec"><Star size={14} aria-hidden="true" /> Recommended: {card.recommended}</p>{/if}
  {:else}
  <header class="meta">
    <span class="kind"><Signpost size={14} />{view.need === "time" ? "Needs your time" : "Decision"}</span>
    <span class="chips">
      {#if view.askedAgain && open}<span class="chip info"><Repeat size={12} />Asked again</span>{/if}
      {#if view.blocking && open}<span class="chip bad"><Flag size={12} />Blocking</span>{/if}
      {#if view.deadline !== null && (open || item.status === "answered")}
        <span class="chip" class:bad={u === "overdue"} class:warn={u === "soon"}><CalendarClock size={12} />{dueLabel(view.deadline, now)}</span>
      {/if}
    </span>
  </header>
  {#if showTitle}<h3 class="title">{view.title}</h3>{/if}
  {/if}
  {#if item.status === "open" && view.notice}<p class="sub" role="status">{view.notice}</p>{/if}
  {#if open && session.stale}
    <p class="restated" role="status">{whom[0] ? whom[0].toUpperCase() + whom.slice(1) : whom} restated this brief. <button type="button" class="link" onclick={() => session.showNew()}>Show the new version</button></p>
  {/if}

  {#if variant !== "panel" && (showRecommendation || showDefault)}
    <dl class="facts">
      {#if showRecommendation}<div><dt><Lightbulb size={14} />Recommended</dt><dd>{view.recommendation}</dd></div>{/if}
      {#if showDefault}<div><dt><Hourglass size={14} />If you don't answer</dt><dd>{view.ifNoAnswer}</dd></div>{/if}
    </dl>
  {/if}

  {#if item.status === "answered" && item.decision}
    {@const d = item.decision}
    {@const dl = deliveryLine(item)}
    <div class="state ok" role="status">
      <CircleCheckBig size={18} />
      <div>
        <p>
          {#if viaOf(item) === "elsewhere"}Answered on another device: <b>{d.choice.kind === "option" ? d.choice.label : "in words"}</b>
          {:else if viaOf(item) !== "here"}Answered: <b>{d.choice.kind === "option" ? d.choice.label : "in words"}</b>
          {:else if d.choice.kind === "option"}You chose <b>{d.choice.label}</b>
          {:else}You answered in words{/if}
          <span class="t">· {clock(d.at)}</span>
        </p>
        {#if viaOf(item) === "here"}
          {#if dl?.state === "queued"}
            <p class="sub">Queued, it will be delivered{#if dl.why}: {dl.why}{/if}.</p>
          {:else if dl?.state === "delivered"}
            <p class="sub">Delivered{#if dl.at !== null} <span class="t">· {clock(dl.at)}</span>{/if}. The manager closes this when it's done.</p>
          {:else}
            <p class="sub">{item.asker.kind === "manager" ? "The manager has it and closes this when it's done." : "Sent."}</p>
          {/if}
        {/if}
      </div>
    </div>
  {:else if item.status === "settled"}
    <div class="state done" role="status">
      <CheckCheck size={18} />
      <div>
        <p>Decided{#if item.decision?.choice.kind === "option"}: <b>{item.decision.choice.label}</b>{/if}{#if item.settledAt}<span class="t">· {clock(item.settledAt)}</span>{/if}</p>
        {#if item.resolution}<p class="sub quote">{item.resolution}</p>{/if}
      </div>
    </div>
  {:else if item.status === "expired"}
    <div class="state done" role="status"><Hourglass size={18} /><p>Expired: nobody answered within a day.</p></div>
  {:else if session.sent}
    <div class="state ok" role="status"><CircleCheckBig size={18} /><p>Sent. {whom[0] ? whom[0].toUpperCase() + whom.slice(1) : whom} gets it as your decision and acts on it.</p></div>
  {:else if view.answerBy === "screen"}
    {#if view.options.length}
      <ul class="readonly">
        {#each view.options as o (o.key)}<li><span class="n">{o.key}</span><span><b>{o.label}</b>{#if o.detail}<small>{o.detail}</small>{/if}</span></li>{/each}
      </ul>
    {/if}
    {#if view.context && view.contextKind === "screen"}<pre class="screen">{view.context}</pre>{/if}
    <div class="actions">
      {#if view.asker.workerId}<button class="btn primary" onclick={() => view.asker.workerId && onOpenScreen(view.asker.workerId)}><SquareTerminal size={16} />Answer in {asker}'s terminal</button>{/if}
    </div>
  {:else if session.mode === "confirm" || session.mode === "words" || session.again}
    <!-- An answer in doubt: only Check again, never another answer while it may have reached the asker (E8). -->
    <AnswerFooter {session} {open} {verifiedFresh} asker={whom} focusSend={!briefOpen} escapeBack onSend={send} />
  {:else}
    <div class="actions">
      {#if variant === "panel" && card.spend}
        <button type="button" class="btn" disabled={!canAnswer} onclick={() => onOpen?.(item)}>Read and decide ›</button>
      {:else if view.answerBy === "tap"}
        {#each answers as o (o.key)}
          <button class="btn" class:primary={o.key === recommended} disabled={!canAnswer || session.stale} onclick={() => choose(o.label, { key: o.key })}
            aria-describedby={variant === "panel" ? `topic-${item.id}` : undefined}
            title={o.key === recommended ? `${o.label} (recommended)` : o.label}>
            {#if o.key === recommended}<Star size={14} aria-hidden="true" />{/if}{o.label}
          </button>
        {/each}
        {#if canAnswer && !session.stale}<button class="link" onclick={() => writeWords()}>Something else…</button>{/if}
        {#if variant === "panel" && canAnswer}<button type="button" class="link" onclick={() => onOpen?.(item)}>{readLabel}</button>{/if}
      {:else if view.need === "time"}
        <button class="btn primary" disabled={!canAnswer || session.stale} onclick={() => choose("Done", { text: "Done" })}>Done</button>
        <button class="btn" disabled={!canAnswer || session.stale} onclick={() => writeWords()}><MessageSquareText size={14} />Reply…</button>
        {#if variant === "panel" && canAnswer}<button type="button" class="link" onclick={() => onOpen?.(item)}>{readLabel}</button>{/if}
      {:else}
        <button class="btn primary" disabled={!canAnswer || session.stale} onclick={() => writeWords()}><MessageSquareText size={14} />Answer…</button>
        {#if view.ifNoAnswer}<button class="btn" disabled={!canAnswer || session.stale} onclick={() => choose(`Go with the default (${view.ifNoAnswer})`, { text: `Go with the default: ${view.ifNoAnswer}` })}>Go with the default</button>{/if}
        {#if variant === "panel" && canAnswer}<button type="button" class="link" onclick={() => onOpen?.(item)}>{readLabel}</button>{/if}
      {/if}
    </div>
    {#if !canAnswer && item.answerable}<p class="note">{REFUSALS[item.answerable]}</p>{/if}
  {/if}
  {#if session.error}<p class="err" role="alert">{session.error}</p>{/if}
  {#if variant === "panel" && onOpenChat && item.messageId}
    <button type="button" class="link chat" onclick={() => onOpenChat?.(item)}>Show in chat</button>
  {/if}
</article>

<style>
  /* A card is a surface of its own: on a tinted row (a hovered message) it keeps muted text muted, and its recessed parts
     (the facts, the read-only list) are the page background under it (COLOR.md 8, 11), not the modal's token. */
  .dc {
    --bar: var(--manager);
    --muted: var(--morndo-text-muted);
    --well: var(--morndo-bg);
    position: relative; display: grid; gap: 8px; min-width: 0; padding: 12px 14px 12px 18px;
    border: 1px solid var(--border); border-radius: 8px; background: var(--main-bg); color: var(--text);
  }
  .dc::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; border-radius: 8px 0 0 8px; background: var(--bar); }
  .dc.panel { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04); }
  .dc.panel:hover { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08); }
  .dc.inline { max-width: 640px; margin: 8px 0 4px; }
  .u-blocking, .u-overdue { --bar: var(--badge); }
  .u-soon { --bar: var(--warn); }
  .u-answered { --bar: var(--working); }
  .u-done { --bar: var(--idle-dot); }
  .meta { display: flex; align-items: center; gap: 6px; min-width: 0; font: 400 13px/18px var(--font); color: var(--muted); }
  .kind { display: inline-flex; align-items: center; gap: 5px; font: 700 12px/18px var(--font); letter-spacing: 0.02em; text-transform: uppercase; color: var(--muted); }
  .chips { margin-left: auto; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px; border-radius: 10px; white-space: nowrap;
    background: var(--muted-bg); color: var(--text); font: 700 11px/20px var(--font);
  }
  .chip.bad { background: var(--bad-bg); color: var(--bad-fg); }
  .chip.warn { background: var(--warn-bg); color: var(--warn-fg); }
  .title { margin: 0; font: 700 15px/22px var(--font); overflow-wrap: anywhere; }
  .panel .title { display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
  .facts { margin: 0; display: grid; gap: 4px; padding: 8px 10px; border-radius: 6px; background: var(--well); }
  .facts div { display: grid; grid-template-columns: 158px minmax(0, 1fr); gap: 8px; align-items: baseline; }
  .facts dt { display: inline-flex; align-items: center; gap: 6px; font: 700 12px/18px var(--font); color: var(--muted); white-space: nowrap; }
  .facts dd { margin: 0; font: 400 13px/18px var(--font); color: var(--text); overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .btn {
    display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 5px 14px; border-radius: 6px; max-width: 100%;
    border: 1px solid var(--outline); background: var(--main-bg); color: var(--text); font: 700 14px/20px var(--font);
    cursor: pointer; text-align: left;
  }
  .btn:hover:not(:disabled) { background: var(--row-hover); border-color: var(--border-strong); }
  .btn.primary { background: var(--send); border-color: var(--send); color: var(--send-fg); }
  .btn.primary:hover:not(:disabled) { background: var(--send-hover); border-color: transparent; }
  .btn:disabled { opacity: 0.45; cursor: default; }
  .link { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; color: var(--link); font: 700 13px/19px var(--font); cursor: pointer; text-decoration: underline; }
  .state { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 8px; }
  .state p { margin: 0; font: 400 14px/20px var(--font); }
  .state .sub { font-size: 13px; color: var(--muted); }
  .state .quote { font-style: italic; overflow-wrap: anywhere; }
  .state .t { color: var(--muted); font-size: 12px; margin-left: 4px; }
  .state.ok { background: var(--ok-bg); color: var(--text); }
  .state.ok :global(svg) { color: var(--ok-fg); flex: none; margin-top: 1px; }
  .state.done { background: var(--muted-bg); --muted: var(--text); }   /* on the fill: full text, never muted (COLOR.md 8) */
  .state.done :global(svg) { color: var(--text); flex: none; margin-top: 1px; }
  .readonly { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
  .readonly li { display: flex; gap: 8px; align-items: baseline; padding: 6px 8px; border-radius: 6px; background: var(--well); font: 400 14px/20px var(--font); }
  .readonly .n { flex: none; width: 18px; height: 18px; border-radius: 4px; background: var(--muted-bg); color: var(--text); font: 700 11px/18px var(--font); text-align: center; }
  .readonly small { display: block; color: var(--muted); font-size: 12px; line-height: 17px; }
  .screen {
    margin: 0; max-height: 220px; overflow: auto; padding: 8px 10px; border-radius: 6px; background: var(--term-bg); color: var(--term-fg);
    font: 12px/17px var(--mono); white-space: pre;
  }
  .note { margin: 0; font: 400 13px/18px var(--font); color: var(--muted); }
  .err { margin: 0; font: 400 13px/18px var(--font); color: var(--bad-fg); }
  .top { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .top .hit { flex: 1; min-width: 0; }
  .topic { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 700 12px/16px var(--font); letter-spacing: 0.04em; text-transform: uppercase; }
  .top .chip { margin-left: auto; }
  .hit { margin: 0; min-width: 0; font: inherit; }
  .headline {
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    width: 100%; padding: 0; border: 0; background: none; color: var(--text); text-align: left; cursor: pointer;
    font: 700 15px/22px var(--font);
  }
  .headline::after { content: ""; position: absolute; inset: 0; }
  .byline { margin: 0; font: 400 13px/18px var(--font); color: var(--muted); }
  .rec { margin: 0; display: flex; align-items: center; gap: 6px; font: 400 13px/18px var(--font); }
  .chat { justify-self: start; }
  .restated { margin: 0; padding: 8px 10px; border-radius: 6px; background: var(--warn-bg); color: var(--warn-fg); font: 400 13px/18px var(--font); }
  .actions, .state, .err, .note, .chat, .readonly, .screen, .restated { position: relative; z-index: 1; }
</style>
