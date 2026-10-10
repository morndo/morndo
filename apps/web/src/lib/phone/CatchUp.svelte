<script lang="ts">
  // Catch-up on the phone (ADR-0009, the design's section 3): one card at a time, decisions first, then one card per
  // agent with something new. The counter says how many are left and of which kind; a segment per card shows the run,
  // decisions outlined until done. Every gesture has a button: swipe right marks an update read (a decision only says
  // how to answer it), swipe left keeps it unread or for later, holding "Mark as read" marks all updates read. Undo
  // brings the last card back while nothing has gone: a read mark and an answer go only after 5 seconds.
  import { onDestroy } from "svelte";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import { newSince } from "@morndo/domain";
  import type { CatchUpConversationWire } from "@morndo/protocol";
  import type { LiveFeed } from "../feed.svelte.ts";
  import { MAY_HAVE_GONE, type CatchUpSession } from "../catchup/session.svelte.ts";
  import { counts, segments, type Body, type Mark } from "../catchup/run.ts";
  import { hold, swipe, type Swiped } from "../catchup/swipe.ts";
  import type { NewCommand } from "../outbox/outbox.ts";
  import type { Echo, OutboxRecord } from "../outbox/state.ts";
  import { withoutFileNotes } from "../desktop/present.ts";
  import Chat from "./Chat.svelte";
  import CaughtUp from "./CaughtUp.svelte";
  import DecisionCard from "./DecisionCard.svelte";
  import UpdateCard from "./UpdateCard.svelte";
  import { horizon, keptForLater } from "./horizon.ts";
  import { keptTasks } from "./quick.ts";
  import type { QuickAnswers } from "./quick.svelte.ts";
  import { tookLabel } from "./words.ts";

  let { feed, session, quick, outgoing, verifiedFresh, verify, onBack, onDay, onQueue, onRetry, onDiscard, onEchoes, onScreen }: {
    feed: LiveFeed; session: CatchUpSession; quick: QuickAnswers; outgoing: OutboxRecord[]; verifiedFresh: boolean; verify: () => Promise<boolean>;
    onBack: () => void; onDay: () => void; onQueue: (c: NewCommand) => Promise<void>; onRetry: (id: string) => void; onDiscard: (id: string) => void;
    onEchoes: (worker: string, echoes: Echo[]) => void; onScreen: (workerId: string) => void;
  } = $props();

  const run = $derived(session.run);
  const top = $derived(session.top);
  const c = $derived(run ? counts(run) : null);
  const segs = $derived(run ? segments(run) : []);
  const now = $derived(session.now);
  const online = $derived(feed.status === "live");
  let note = $state<string | null>(null);
  let hintFlash = $state(false);
  // A note belongs to the card it was said on: it goes when another card comes on top (not when this one refreshes).
  let noteFor: string | null = null;
  $effect(() => { const k = top?.key ?? null; if (k !== noteFor) { noteFor = k; note = null; } });

  // Reduced motion: cards change without sliding (the global rule stops transitions; the fly-out is skipped here too).
  const reducedQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  let reduced = $state(reducedQuery?.matches ?? false);
  $effect(() => {
    if (!reducedQuery) return;
    const on = () => (reduced = reducedQuery.matches);
    reducedQuery.addEventListener("change", on);
    return () => reducedQuery.removeEventListener("change", on);
  });

  // The conversation opened from a card ("Open the chat", a tap on a message); the phone's back closes it.
  let chat = $state<{ worker: string; name: string; focus: string | null } | null>(null);
  function openChat(worker: string, name: string, focus: string | null) {
    chat = { worker, name, focus };
    history.pushState({ morndoChat: true }, "");
  }
  function closeChat() { if (history.state?.morndoChat) history.back(); else chat = null; }
  $effect(() => {
    const pop = () => { if (!history.state?.morndoChat) chat = null; };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  });

  // Watched: the update card's agent (its new messages live, and the echo of a reply), or the open conversation.
  $effect(() => { if (!chat) feed.watch(top?.kind === "update" ? top.worker : null); });
  onDestroy(() => feed.watch(null));

  // What the update card shows: the hub's catch-up for it, or, once its conversation is here live, the same rule on the
  // live messages (newer ones and the reply's echo show up while the card is open).
  const data = $derived(top?.kind === "update" ? feed.catchup[top.conversation] ?? null : null);
  const view = $derived.by((): CatchUpConversationWire | null => {
    if (top?.kind !== "update") return null;
    const mark = data?.mark ?? feed.reads[top.conversation] ?? null;
    const live = feed.historyFor === top.worker ? newSince(feed.messages, mark, 30) : null;
    if (!live || live.lastAt === null || (data && (data.lastAt ?? 0) > live.lastAt)) return data;
    return { ...live, worker: top.worker as CatchUpConversationWire["worker"], name: top.conversation, mark, count: Math.max(live.count, data?.count ?? 0), tools: Math.max(live.tools, data?.tools ?? 0), files: Math.max(live.files, data?.files ?? 0) };
  });
  // Nothing loaded for the card on top (read on another device, so the full list left it out; or its session ended): ask
  // the hub for that one, once per card; it answers even when nothing is new (review of PR #7, finding 9).
  let askedFor: string | null = null;
  $effect(() => {
    if (top?.kind !== "update" || data || !feed.primed || askedFor === top.key) return;
    if (feed.requestCatchUp(top.worker)) askedFor = top.key;
  });
  const echoesOf = (messages: typeof feed.messages): Echo[] => messages.filter(m => m.author.kind === "principal").map(m => ({ id: m.id, at: m.at, text: withoutFileNotes(m.text) }));
  $effect(() => {
    const w = feed.historyFor;
    if (w && outgoing.some(r => r.worker === w && r.state === "sent")) onEchoes(w, echoesOf(feed.messages));
  });

  // ---- actions (each a button too)
  function markRead() {
    if (top?.kind !== "update") return;
    if (!view) { note = "Not marked read: its messages haven't loaded, so you haven't seen them yet."; return; }
    // Nothing new to show (read elsewhere, or the session ended): marked up to the last message the roster knows.
    session.markRead(top.key, { conversation: top.conversation, at: view.lastAt ?? top.lastAt });
  }
  function markAll() {
    if (!run) return;
    const marks: Mark[] = run.order.flatMap(k => {
      const card = run.cards[k];
      if (k in run.done || card?.kind !== "update") return [];
      return [{ key: k, conversation: card.conversation, at: Math.max(feed.catchup[card.conversation]?.lastAt ?? 0, card.lastAt) }];
    });
    session.markAllRead(marks);
  }
  function aside() { if (top) session.setAside(top.key); }
  let lastPick: { key: string; id: string; body: Body; label: string; seen: string } | null = null;
  // Whether the answer started (its 5 seconds run): the card keeps words that didn't go (review of PR #7, 13).
  async function pick(body: Body, label: string): Promise<boolean> {
    if (top?.kind !== "decision") return false;
    const card = top;
    note = null;
    if (!online || navigator.onLine === false) { note = "You're offline. A decision goes only while Morndo is connected, so nothing was sent; it stays here."; return false; }
    // AC7: the passkey first, inside the tap (Safari asks for Face ID only from a user gesture), then the 5 seconds.
    if (!verifiedFresh && !(await verify())) { note = "Not answered: the passkey check didn't finish."; return false; }
    // The version of the ask on screen now goes with it (review of PR #7, finding 5).
    const seen = feed.decisions.find(d => d.id === card.id)?.version ?? "";
    lastPick = { key: card.key, id: card.id, body, label, seen };
    session.answer(card.key, card.id, body, label, seen);
    return session.run?.answering?.key === card.key;
  }
  // "Try again" after an unknown outcome: the same answer with the same request id (typed at most once).
  async function tryAgain() {
    const r = session.refusal;
    if (!r?.retry) return;
    if (!online || navigator.onLine === false) { note = "Still offline. It goes when you try again online."; return; }
    if (!verifiedFresh && !(await verify())) { note = "Not answered: the passkey check didn't finish."; return; }
    await session.retry(r.key, r.retry.id, r.retry.body, r.retry.label, r.retry.seen, r.retry.requestId);
  }
  // An unknown outcome that did reach the hub: the board shows it answered here, and it counts as his answer.
  $effect(() => {
    if (top?.kind === "decision" && session.refusal?.key === top.key && MAY_HAVE_GONE.has(session.refusal.code) && item?.status === "answered" && item.decision?.via === "here") session.confirmAnswered(top.key);
  });
  async function verifyAgain() {
    const p = lastPick;
    if (!p || !(await verify())) return;
    await session.retry(p.key, p.id, p.body, p.label, p.seen);
  }
  // Queued in the outbox, or false with a note (the text stays in the box).
  async function reply(text: string, seen: string): Promise<boolean> {
    if (top?.kind !== "update") return false;
    const card = top;
    note = null;
    // Online, a due passkey check comes first; offline the outbox keeps it, and the hub's "verify" shows on it later.
    if (!verifiedFresh && navigator.onLine !== false && !(await verify())) { note = "Not sent: the passkey check didn't finish. Your text is still in the box."; return false; }
    // To the pane whose messages the card shows (two panes can share a name; review of PR #7, finding 4).
    const worker = view && view.name === card.conversation ? view.worker : card.worker;
    try { await onQueue({ worker, workerName: card.conversation, text, uploads: [], seen }); return true; }
    catch (e) { note = `Couldn't keep the message on this device: ${e instanceof Error ? e.message : String(e)}. It is still in the box.`; return false; }
  }

  // ---- the swipe
  let dx = $state(0);
  let flying = $state<Swiped | null>(null);
  function onSwipe(side: Swiped) {
    if (!top || run?.answering) return;                                    // an answer in its window: Undo, or let it go
    if (side === "right" && top.kind === "decision") { hintFlash = true; setTimeout(() => (hintFlash = false), 2500); return; }
    if (side === "right" && !view) { markRead(); return; }
    const act = side === "right" ? markRead : aside;
    if (reduced) { act(); return; }
    flying = side;
    setTimeout(() => { flying = null; act(); }, 180);
  }
  const transform = $derived(flying ? `translateX(${flying === "right" ? 125 : -125}%) rotate(${flying === "right" ? 8 : -8}deg)` : dx ? `translateX(${dx}px) rotate(${dx / 40}deg)` : undefined);

  // ---- the counter and the end
  const decisionIndex = $derived(top?.kind === "decision" && run ? run.order.filter(k => run.cards[k]?.kind === "decision").indexOf(top.key) + 1 : 0);
  const item = $derived(top?.kind === "decision" ? feed.decisions.find(d => d.id === top.id) ?? null : null);
  const answering = $derived(run?.answering && top && run.answering.key === top.key ? run.answering : null);
  const refusal = $derived(session.refusal && top && session.refusal.key === top.key ? session.refusal : null);
  const sub = $derived(!c ? "" : run?.endedAt ? tookLabel(run.endedAt - run.startedAt)
    : `${c.decisionsLeft ? `${c.decisionsLeft} to decide` : c.decisionsInRun ? "all decided" : "nothing to decide"}${c.updatesLeft ? ` · ${c.updatesLeft === 1 ? "1 update" : `${c.updatesLeft} updates`}` : ""}`);
  // As Today sees it: tasks kept for later on this device are off today here too (code review #4).
  const h = $derived(horizon({ decisions: feed.decisions, workers: feed.workers, later: keptForLater(session.later, feed.decisions), kept: keptTasks(quick.state, feed.decisions, now), now }));
  const laterItems = $derived(run ? run.order.flatMap(k => {
    const card = run.cards[k];
    if (run.done[k] !== "later" || card?.kind !== "decision") return [];
    const d = feed.decisions.find(x => x.id === card.id && x.status === "open");
    return d ? [{ id: d.id, title: d.title }] : [];
  }) : []);
</script>

<div class="cu">
  <header class="cu-top">
    <div class="row">
      <button class="back" onclick={chat ? closeChat : onBack} aria-label={chat ? "Back to the card" : "Back to Today"}><ChevronLeft size={24} /></button>
      <span class="count" aria-live="polite"><span class="num">{c?.left ?? 0} left</span><small>{sub}</small></span>
      <button class="undo" class:off={!session.canUndo || !!chat} disabled={!session.canUndo || !!chat} onclick={() => session.undo()}>Undo</button>
    </div>
    <div class="segments" aria-hidden="true">
      {#each segs as s (s.key)}<i class="{s.state}" class:decide={s.decision}></i>{/each}
    </div>
  </header>

  {#if chat}
    <Chat {feed} worker={chat.worker} name={chat.name} focus={chat.focus} />
  {:else if !run || !session.opened}
    <p class="wait note">{feed.primed ? "Getting what waits…" : feed.status === "offline" ? "Offline. Waiting for the hub to say what waits…" : "Waiting for the hub…"}</p>
  {:else if top}
    <div class="stack">
      {#key top.key}
        <article class="card" class:dragging={dx !== 0 && !flying} class:flying use:swipe={{ onMove: x => (dx = reduced ? 0 : x), onSwipe }}
          style:transform data-card={top.key} aria-label={top.kind === "decision" ? `Decision ${decisionIndex} of ${c?.decisionsInRun ?? 0}` : `Update from ${top.conversation}`}>
          {#if top.kind === "decision"}
            <DecisionCard {item} primed={feed.primed} index={decisionIndex} of={c?.decisionsInRun ?? 0} {now} {answering} {refusal} {note}
              onPick={(b, l) => pick(b, l)} onUndo={() => session.undo()} onVerifyAgain={() => void verifyAgain()} onTryAgain={() => void tryAgain()}
              onScreen={id => onScreen(id)} onNext={() => session.moveOn(top.key)} />
          {:else}
            <UpdateCard worker={feed.workers.find(w => w.id === top.worker) ?? null} name={top.conversation} {view} mark={view?.mark ?? feed.reads[top.conversation] ?? null}
              {now} outgoing={outgoing.filter(o => o.worker === top.worker)} loading={online} {note}
              onReply={reply} onOpen={id => openChat(top.worker, top.conversation, id)} {onRetry} {onDiscard}
              onVerify={id => void verify().then(ok => { if (ok) onRetry(id); })} />
          {/if}
        </article>
      {/key}
    </div>
    <div class="actions">
      {#if top.kind === "decision"}
        <button class="pbtn" onclick={aside} disabled={!!answering}>Later</button>
        <button class="pbtn" disabled={!item?.asker.workerId} onclick={() => item?.asker.workerId && openChat(item.asker.workerId, item.asker.kind === "manager" ? "Manager" : item.asker.name, item.messageId)}>Open the chat</button>
      {:else}
        <button class="pbtn" onclick={aside}>Keep unread</button>
        <button class="pbtn primary" onclick={markRead} use:hold={markAll}>Mark as read</button>
      {/if}
    </div>
    <div class="hint" class:flash={hintFlash}>
      {#if top.kind === "decision"}
        <p role={hintFlash ? "alert" : undefined}>A decision is never marked read. Answer it, or swipe left for later.</p>
      {:else}
        <p>Swipe right to mark read, left to keep it unread.</p>
        {#if (c?.updatesLeft ?? 0) > 1}<button class="tlink" onclick={markAll}>Mark all {c?.updatesLeft} updates read</button>{/if}
      {/if}
    </div>
  {:else}
    <CaughtUp counts={c ?? counts(run)} skipped={session.skipped} {now} next={h.next} waitingNow={h.waitingNow}
      working={feed.workers.filter(w => w.state === "active").length} later={laterItems} primed={feed.primed} {onDay} onLater={id => session.revisit(id)} />
  {/if}
</div>

<style>
  .cu { height: 100dvh; display: flex; flex-direction: column; padding: 0 var(--safe-right) var(--safe-bottom) var(--safe-left); }
  .cu-top { flex: none; padding: calc(var(--safe-top) + 6px) 20px 12px; }
  .row { display: flex; align-items: center; justify-content: space-between; min-height: 44px; gap: 8px; }
  .back { width: 44px; height: 44px; margin-left: -12px; display: grid; place-items: center; border: 0; background: none; color: var(--fg); cursor: pointer; }
  .count { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .count .num { font: 600 20px/1 var(--display); letter-spacing: -0.01em; white-space: nowrap; }
  .count small { color: var(--muted); font: 400 13px/1.2 var(--body); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .undo { min-width: 44px; min-height: 44px; margin-right: -8px; padding: 0 8px; border: 0; background: none; color: var(--fg); font: 700 14px/1 var(--body); cursor: pointer; }
  .undo.off { visibility: hidden; }
  .segments { display: flex; gap: 4px; margin-top: 8px; }
  .segments i { flex: 1; height: 4px; border-radius: 2px; background: var(--line); }
  .segments i.done { background: var(--muted); }
  .segments i.now { background: var(--ink); }
  .segments i.decide.next { background: transparent; box-shadow: inset 0 0 0 1px var(--edge); }
  .wait { padding: 24px 20px; }
  .stack { flex: 1; min-height: 0; position: relative; padding: 0 14px; }
  .stack::before, .stack::after { content: ""; position: absolute; height: 30px; border-radius: 26px; background: var(--surface); border: 1px solid var(--line); }
  .stack::before { bottom: -14px; left: 44px; right: 44px; }
  .stack::after { bottom: -7px; left: 30px; right: 30px; }
  .card {
    position: relative; z-index: 1; height: 100%; display: flex; flex-direction: column; overflow: hidden;
    background: var(--surface); border: 1px solid var(--line); border-radius: 28px; box-shadow: var(--card-shadow);
    touch-action: pan-y; transition: transform 0.18s ease-out; animation: enter 0.18s ease-out;
  }
  .card.dragging { transition: none; }
  @keyframes enter { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: none; } }
  .actions { flex: none; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 22px 14px 4px; }
  .hint { flex: none; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 0 10px; min-height: 44px; padding: 0 16px; text-align: center; }
  .hint p { margin: 0; font: 400 12px/16px var(--body); color: var(--muted); }
  .hint.flash p { color: var(--fg); font-weight: 700; }
  .hint .tlink { font-size: 12px; min-height: 44px; }
</style>
