<script lang="ts" module>
  export type AnswerBody = { key: string } | { text: string };
  // Why an answer didn't go: the hub's code (or "unknown" when the hub never answered) and the words for it.
  export type AnswerProblem = { code: string; text: string };
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
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import CircleCheckBig from "@lucide/svelte/icons/circle-check-big";
  import Flag from "@lucide/svelte/icons/flag";
  import Hourglass from "@lucide/svelte/icons/hourglass";
  import Lightbulb from "@lucide/svelte/icons/lightbulb";
  import MessageSquareText from "@lucide/svelte/icons/message-square-text";
  import Repeat from "@lucide/svelte/icons/repeat-2";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import Signpost from "@lucide/svelte/icons/signpost";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import Star from "@lucide/svelte/icons/star";
  import { renderMarkdown } from "../markdown.ts";
  import { MAY_HAVE_GONE, againLabel, endsDoubt } from "../catchup/answer.ts";
  import Avatar from "./Avatar.svelte";
  import { ago, deliveryLine, dueLabel, REFUSALS, urgency, type DecisionItem } from "./decisions.ts";
  import { DELIVERED, MAY_HAVE_BEEN, QUEUED } from "../queue-words.ts";
  import { clock } from "./grouping.ts";

  let { item, variant, now, verifiedFresh, onAnswer, onOpenScreen, onOpenChat }: {
    item: DecisionItem; variant: "panel" | "inline"; now: number; verifiedFresh: boolean;
    onAnswer: (id: string, body: AnswerBody, requestId: string) => Promise<AnswerProblem | null>;
    onOpenScreen: (workerId: string) => void; onOpenChat?: (item: DecisionItem) => void;
  } = $props();

  let mode = $state<"idle" | "confirm" | "words">("idle");
  let picked = $state<{ label: string; body: AnswerBody } | null>(null);
  let words = $state("");
  let sending = $state(false);
  let error = $state<string | null>(null);
  let again = $state<{ body: AnswerBody; requestId: string; code: string } | null>(null);   // may have been typed
  let showContext = $state(false);
  let wordsEl = $state<HTMLTextAreaElement | null>(null);

  const u = $derived(urgency(item, now));
  const open = $derived(item.status === "open");
  const canAnswer = $derived(open && item.answerable === null);
  const asker = $derived(item.asker.kind === "manager" ? "Manager" : `#${item.asker.name}`);
  const whom = $derived(item.asker.kind === "manager" ? "the manager" : item.asker.name);
  const recommended = $derived(item.answerBy === "tap" ? item.options[0]?.key ?? null : null);
  // In the chat the message above is the context, so the question line shows only when it says something new.
  const showRecommendation = $derived(!!item.recommendation && (open || variant === "panel"));
  const showDefault = $derived(!!item.ifNoAnswer && open);
  let root = $state<HTMLElement | null>(null);
  // Picking an option opens the confirmation inside the card: keep it in view (the chat may have it at the bottom edge).
  $effect(() => { if (mode !== "idle") requestAnimationFrame(() => root?.querySelector(".confirm")?.scrollIntoView({ block: "nearest" })); });
  const showTitle = $derived(variant === "panel" || !(item.context ?? "").includes(item.title.slice(0, 48)));
  // Closed meanwhile (an answer that may have been typed arrived after all, say): the card says so, and nothing is left to check.
  $effect(() => { void item.status; if (item.status !== "open") { mode = "idle"; picked = null; if (again) { again = null; error = null; } } });
  $effect(() => { if (mode === "words") wordsEl?.focus(); });

  function pick(label: string, body: AnswerBody) { picked = { label, body }; mode = "confirm"; error = null; }
  function writeWords(prefill = "") { words = prefill; mode = "words"; error = null; }
  // Back keeps an answer in doubt: the card then offers only Check again for it, never another answer (E8).
  function back() { mode = "idle"; picked = null; if (!again) error = null; }
  function escBack(e: KeyboardEvent) { if (e.key === "Escape") { e.preventDefault(); back(); } }

  // A new answer gets a new request id; Check again sends the one that may have been typed with its own. An answer in
  // doubt stays in doubt until Check again is taken (200) or refused by the hub after its machine said it never had it
  // (endsDoubt); anything else (a dismissed passkey prompt, 429, 5xx, no answer) keeps it, with Check again (S7).
  async function send(body: AnswerBody, requestId: string = crypto.randomUUID()) {
    if (sending) return;
    sending = true;
    error = null;
    const doubt = again;
    const problem = await onAnswer(item.id, body, requestId);
    sending = false;
    if (problem) {
      error = problem.text;
      again = MAY_HAVE_GONE.has(problem.code) ? { body, requestId, code: problem.code } : doubt && !endsDoubt(problem.code) ? doubt : null;
      return;
    }
    again = null;
    mode = "idle"; picked = null; words = "";
  }
  function sendAgain() { if (again) void send(again.body, again.requestId); }
  function onWordsKey(e: KeyboardEvent) {
    // Like the message box (and Slack): Enter sends, Shift+Enter starts a new line; not while an IME is composing. While
    // an answer is in doubt, Enter is Check again: never a new answer under a new request id.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (again) sendAgain(); else if (words.trim()) void send({ text: words }); }
    if (e.key === "Escape") { e.preventDefault(); back(); }
  }
</script>

<article bind:this={root} class="dc {variant} u-{u}" data-decision={item.id} aria-label="Decision: {item.title}">
  <header class="meta">
    {#if variant === "panel"}
      <Avatar name={item.asker.kind === "manager" ? "Manager" : item.asker.name} kind={item.asker.kind === "manager" ? "peer" : "agent"} size={20} />
      <strong class="asker">{asker}</strong><span class="when" title={new Date(item.askedAt).toLocaleString()}>{ago(item.askedAt, now)}</span>
    {:else}
      <span class="kind"><Signpost size={14} />{item.need === "time" ? "Needs your time" : "Decision"}</span>
    {/if}
    <span class="chips">
      {#if item.askedAgain && open}<span class="chip info"><Repeat size={12} />Asked again</span>{/if}
      {#if item.blocking && open}<span class="chip bad"><Flag size={12} />Blocking</span>{/if}
      {#if item.deadline !== null && (open || item.status === "answered")}
        <span class="chip" class:bad={u === "overdue"} class:warn={u === "soon"}><CalendarClock size={12} />{dueLabel(item.deadline, now)}</span>
      {/if}
    </span>
  </header>

  {#if showTitle}<h3 class="title">{item.title}</h3>{/if}
  {#if item.status === "open" && item.notice}<p class="sub" role="status">{item.notice}</p>{/if}
  {#if variant === "panel" && item.project}<span class="project">#{item.project}</span>{/if}

  {#if showRecommendation || showDefault}
    <dl class="facts">
      {#if showRecommendation}<div><dt><Lightbulb size={14} />Recommended</dt><dd>{item.recommendation}</dd></div>{/if}
      {#if showDefault}<div><dt><Hourglass size={14} />If you don't answer</dt><dd>{item.ifNoAnswer}</dd></div>{/if}
    </dl>
  {/if}

  {#if item.status === "answered" && item.decision}
    {@const d = item.decision}
    {@const dl = deliveryLine(item)}
    <div class="state ok" role="status">
      <CircleCheckBig size={18} />
      <div>
        <p>
          {#if d.via === "elsewhere"}Answered on another device: <b>{d.choice.kind === "option" ? d.choice.label : "in words"}</b>
          {:else if d.choice.kind === "option"}You chose <b>{d.choice.label}</b>
          {:else}You answered in words{/if}
          <span class="t">· {clock(d.at)}</span>
        </p>
        <!-- The manager's queue (fleet-clients §9.1, E13): where the answer stands until it is in the conversation. -->
        {#if dl?.state === "queued"}
          <p class="sub" data-delivery="queued">{QUEUED}{#if dl.why}: {dl.why}{/if}.</p>
        {:else if dl?.state === "delivered"}
          <p class="sub" data-delivery="delivered">{DELIVERED}{#if dl.at !== null} <span class="t">· {clock(dl.at)}</span>{/if}. The manager closes this when it's done.</p>
        {:else if dl?.state === "uncertain"}
          <p class="sub" data-delivery="uncertain">{MAY_HAVE_BEEN}: it was typed, but never seen in the manager's conversation. It stays answered; look at the manager's screen to be sure.</p>
        {:else}
          <p class="sub">{item.asker.kind === "manager" ? "The manager has it and closes this when it's done." : "Sent."}</p>
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
  {:else if item.answerBy === "screen"}
    {#if item.options.length}
      <ul class="readonly">
        {#each item.options as o (o.key)}<li><span class="n">{o.key}</span><span><b>{o.label}</b>{#if o.detail}<small>{o.detail}</small>{/if}</span></li>{/each}
      </ul>
    {/if}
    {#if item.context && item.contextKind === "screen"}<pre class="screen">{item.context}</pre>{/if}
    <div class="actions">
      {#if item.asker.workerId}<button class="btn primary" onclick={() => item.asker.workerId && onOpenScreen(item.asker.workerId)}><SquareTerminal size={16} />Answer in {asker}'s terminal</button>{/if}
    </div>
  {:else if mode === "confirm" && picked}
    <div class="confirm" role="group" aria-label="Confirm your answer">
      <p class="your">Your answer: <b>{picked.label}</b></p>
      <p class="how">{whom[0]?.toUpperCase()}{whom.slice(1)} gets it as your decision and acts on it.</p>
      <div class="actions">
        <!-- svelte-ignore a11y_autofocus -->
        {#if again}
          <button class="btn primary" disabled={sending} onkeydown={escBack} onclick={sendAgain}>{sending ? "Checking…" : againLabel(again.code)}</button>
        {:else}
          <button class="btn primary" disabled={sending} autofocus onkeydown={escBack} onclick={() => picked && send(picked.body)}>{sending ? "Sending…" : "Send answer"}</button>
        {/if}
        <button class="btn ghost" disabled={sending} onkeydown={escBack} onclick={back}>Back</button>
        {#if !verifiedFresh}<span class="shield"><ShieldAlert size={14} />Face ID or Touch ID first</span>{/if}
      </div>
    </div>
  {:else if mode === "words"}
    <div class="confirm" role="group" aria-label="Answer in words">
      <textarea bind:this={wordsEl} bind:value={words} rows="2" readonly={!!again} placeholder="Your answer for {whom}…" onkeydown={onWordsKey} aria-label="Your answer for {whom}"></textarea>
      <div class="actions">
        {#if again}
          <button class="btn primary" disabled={sending} onclick={sendAgain}>{sending ? "Checking…" : againLabel(again.code)}</button>
        {:else}
          <button class="btn primary" disabled={sending || !words.trim()} onclick={() => send({ text: words })}>{sending ? "Sending…" : `Send to ${whom}`}</button>
        {/if}
        <button class="btn ghost" disabled={sending} onclick={back}>Cancel</button>
        {#if !verifiedFresh}<span class="shield"><ShieldAlert size={14} />Face ID or Touch ID first</span>{:else}<span class="hint">Enter sends · Shift+Enter for a new line</span>{/if}
      </div>
    </div>
  {:else if again}
    <!-- An answer in doubt: only Check again, never another answer while it may have reached the asker (E8). -->
    <div class="actions">
      <button class="btn primary" disabled={sending} onclick={sendAgain}>{sending ? "Checking…" : againLabel(again.code)}</button>
    </div>
  {:else}
    <div class="actions">
      {#if item.answerBy === "tap"}
        {#each item.options as o (o.key)}
          <button class="btn" class:primary={o.key === recommended} disabled={!canAnswer} onclick={() => pick(o.label, { key: o.key })}
            title={o.key === recommended ? `${o.label} (recommended)` : o.label}>
            {#if o.key === recommended}<Star size={14} />{/if}{o.label}
          </button>
        {/each}
        {#if canAnswer}<button class="link" onclick={() => writeWords()}>Something else…</button>{/if}
      {:else if item.need === "time"}
        <button class="btn primary" disabled={!canAnswer} onclick={() => pick("Done", { text: "Done" })}>Done</button>
        <button class="btn" disabled={!canAnswer} onclick={() => writeWords()}><MessageSquareText size={14} />Reply…</button>
      {:else}
        <button class="btn primary" disabled={!canAnswer} onclick={() => writeWords()}><MessageSquareText size={14} />Answer…</button>
        {#if item.ifNoAnswer}<button class="btn" disabled={!canAnswer} onclick={() => pick(`Go with the default (${item.ifNoAnswer})`, { text: `Go with the default: ${item.ifNoAnswer}` })}>Go with the default</button>{/if}
      {/if}
    </div>
    {#if !canAnswer && item.answerable}<p class="note">{REFUSALS[item.answerable]}</p>{/if}
  {/if}
  {#if error}<p class="err" role="alert">{error}</p>{/if}

  {#if variant === "panel" && ((item.context && item.contextKind === "markdown") || (onOpenChat && item.messageId))}
    <div class="more">
      {#if item.context && item.contextKind === "markdown"}
        <button class="link" aria-expanded={showContext} onclick={() => (showContext = !showContext)}>
          <span class="caret" class:shut={!showContext}><ChevronDown size={14} /></span>{showContext ? "Hide the details" : `Why ${whom} asks`}
        </button>
      {/if}
      {#if onOpenChat && item.messageId}<button class="link right" onclick={() => onOpenChat?.(item)}>Show in chat</button>{/if}
      <span class="id">{item.id.startsWith("ny-") ? item.id : ""}</span>
    </div>
    {#if showContext && item.context}<div class="context md">{@html renderMarkdown(item.context)}</div>{/if}
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
  .asker { font: 900 14px/18px var(--font); color: var(--text); white-space: nowrap; }
  .kind { display: inline-flex; align-items: center; gap: 5px; font: 700 12px/18px var(--font); letter-spacing: 0.02em; text-transform: uppercase; color: var(--muted); }
  .when { white-space: nowrap; }
  .chips { margin-left: auto; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px; border-radius: 10px; white-space: nowrap;
    background: var(--muted-bg); color: var(--text); font: 700 11px/20px var(--font);
  }
  .chip.bad { background: var(--bad-bg); color: var(--bad-fg); }
  .chip.warn { background: var(--warn-bg); color: var(--warn-fg); }
  .title { margin: 0; font: 700 15px/22px var(--font); overflow-wrap: anywhere; }
  .panel .title { display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
  .project { justify-self: start; margin-top: -4px; font: 400 12px/16px var(--font); color: var(--muted); }
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
  .btn.ghost { border-color: transparent; background: transparent; }
  .btn.ghost:hover:not(:disabled) { background: var(--hover); }
  .link { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; color: var(--link); font: 700 13px/19px var(--font); cursor: pointer; text-decoration: underline; }
  .confirm { display: grid; gap: 8px; padding: 10px 12px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--send) 45%, transparent); background: color-mix(in srgb, var(--send) 7%, var(--main-bg)); }
  .your { margin: 0; font: 400 15px/22px var(--font); }
  .how { margin: -6px 0 0; font: 400 13px/18px var(--font); color: var(--muted); }
  textarea {
    width: 100%; min-height: 60px; resize: vertical; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border-strong);
    background: var(--main-bg); color: var(--text); font: 400 15px/22px var(--font); outline: 0;
  }
  textarea:focus { border-color: var(--link); box-shadow: 0 0 0 1px var(--link); }
  .shield, .hint { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; font: 400 12px/1 var(--font); color: var(--muted); }
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
  .more { display: flex; align-items: center; gap: 12px; padding-top: 2px; }
  .more .right { margin-left: auto; }
  .more .id { font: 400 11px/1 var(--mono); color: var(--muted); }
  .caret { display: inline-grid; transition: transform 0.12s; }
  .caret.shut { transform: rotate(-90deg); }
  .context { max-height: 320px; overflow: auto; padding: 10px 12px; border-radius: 6px; border: 1px solid var(--border); font: 400 14px/21px var(--font); overflow-wrap: anywhere; }
  .context :global(p) { margin: 0 0 6px; }
  .context :global(p:last-child) { margin: 0; }
  .context :global(ul), .context :global(ol) { margin: 2px 0 6px; padding-left: 22px; }
  .context :global(code) { font: 12px/18px var(--mono); padding: 1px 3px; border-radius: 3px; background: var(--code-bg); border: 1px solid var(--code-border); }
  .context :global(a) { color: var(--link); }
  .context :global(h1), .context :global(h2), .context :global(h3) { font: 900 14px/20px var(--font); margin: 6px 0 2px; }
</style>
