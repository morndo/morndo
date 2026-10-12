<script lang="ts">
  // Slack's message pane: rows padded 8px 20px, 36px avatar + 8px gap, 900 15px/22px sender, 12px grey time, 15px/22px
  // body; centered day pills. Agent-specific: STATUS pills, folded tool activity, questions, long answers collapsed.
  import { onDestroy, tick, untrack, type Snippet } from "svelte";
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import CircleHelp from "@lucide/svelte/icons/message-circle-question-mark";
  import Info from "@lucide/svelte/icons/info";
  import Wrench from "@lucide/svelte/icons/wrench";
  import type { Message, RosterEntry } from "@morndo/domain";
  import { renderMarkdown, statusOf } from "../markdown.ts";
  import Attachments from "./Attachments.svelte";
  import Avatar from "./Avatar.svelte";
  import { clock, toRows } from "./grouping.ts";
  import { present, type ConversationPrefs } from "./present.ts";
  import type { DecisionItem } from "./decisions.ts";
  import { unreachable } from "@morndo/domain";
  import { canCancel, canEdit, canRetry, type OutboxRecord } from "../outbox/state.ts";
  import { fileSize, fileType, type SentFile } from "../attach.ts";
  import { deliveryNote, sendLabel, sendReason } from "../outbox/words.ts";
  import { dividerBefore, scrollAnchor, showJump, type Anchor, type TimelineChange } from "./timeline.ts";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";

  // A Command of the outbox (ADR-0008 phase C), with its images' thumbnails for this page's life.
  export type Outgoing = OutboxRecord & { images: string[]; files: SentFile[] };
  let { worker, messages, loading, outgoing, displayName, prefs, decisionOf, card, focus, onRetry, onDiscard, onVerify, onEdit, onCancel = () => {},
    dividerMark = undefined, onAtBottom = () => {}, older = { loading: false, done: false, failed: false }, olderPages = 0, onOlder = () => {},
    detached = false, newWhileDetached = 0, onLatest = () => {} }: {
    worker: RosterEntry; messages: Message[]; loading: boolean; outgoing: Outgoing[]; displayName: string; prefs: ConversationPrefs;
    decisionOf: (messageId: string) => DecisionItem | undefined; card: Snippet<[DecisionItem]>; focus: { id: string; n: number } | null;
    onRetry: (id: string) => void; onDiscard: (id: string) => void; onVerify: (id: string) => void; onEdit: (id: string) => void;
    onCancel?: (id: string) => void;                    // a message the manager's queue still holds (ruling 83)
    // Phase D: the read mark when the conversation was opened (for "New messages"), whether the list is at the bottom
    // (to mark it read), older pages (and how many were put above), and the latest messages pushed out by them.
    // undefined: not known yet for this opening (the divider waits for it); null: nothing was ever read.
    dividerMark?: number | null | undefined; onAtBottom?: (atBottom: boolean, worker: string) => void;
    older?: { loading: boolean; done: boolean; failed: boolean }; olderPages?: number; onOlder?: () => void;
    detached?: boolean; newWhileDetached?: number; onLatest?: () => void;
  } = $props();

  // Where a Command stands, in words (S8), and why it didn't go, by the hub's code.
  let clockNow = $state(Date.now());
  $effect(() => { const t = setInterval(() => (clockNow = Date.now()), 15_000); return () => clearInterval(t); });
  // The words are shared with the phone's update card (outbox/words.ts).
  const reason = (o: Outgoing) => sendReason(o, displayName);
  const label = (o: Outgoing) => sendLabel(o, outgoing, clockNow);

  let scroller = $state<HTMLDivElement | null>(null);
  let stick = true;
  let expanded = $state<Record<string, boolean>>({});
  const rows = $derived(toRows(present(messages, prefs)));
  // An agent's own "STATUS: DONE" is its claim, not a verified result: shown neutral, never as success, until a check by
  // someone other than the worker exists (Verification, V1 and V4 in docs/domain.md).
  const STATUS_TEXT = { done: "Says done", blocked: "Blocked", decision: "Needs decision", failed: "Failed" } as const;
  const STATUS_TITLE: Record<string, string> = { done: "The agent reports this as done. Nobody else has checked it yet." };
  const authorName = (m: Message) => (m.author.kind === "agent" ? displayName : m.author.name);
  // In the manager's own channel its replies wear the manager's avatar, like everywhere else it appears.
  const avatarKind = (m: Message) => (m.author.kind === "agent" && worker.name === "manager" ? "peer" : m.author.kind);
  const long = (t: string) => t.length > 1400 || t.split("\n").length > 18;

  // Scrolling (ADR-0008 phase D): each change is classified, and timeline.ts's pure scrollAnchor says where to go.
  let divider = $state<string | null>(null);         // the row "New messages" goes before; kept until the view is left
  let newBelow = $state(0);                          // messages that arrived while the bottom was out of view
  let jumpShown = $state(false);
  let armed = $state(false);                         // older pages load only once the opening scroll is done
  let openedFor: string | null = null;
  let seen = { first: undefined as string | undefined, last: undefined as string | undefined, count: 0, outgoing: 0, pages: 0 };
  let savedFromBottom = 0;
  let pinned: { id: string; bottom: number } | null = null;   // the first message on screen before a change, and where
  let wantBottom = false;
  const fromBottom = () => (scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : 0);
  function report() {
    if (!scroller) return;
    stick = fromBottom() < 60;
    if (stick) newBelow = 0;
    jumpShown = showJump(scroller);
    // Only once this conversation's messages are in and its opening scroll is done: an empty list that is still
    // loading is "at the bottom" too, and must not mark everything read.
    if (!loading && openedFor === worker.id) onAtBottom(stick, worker.id);
  }
  // Leaving this conversation (another one, view or tab): it isn't at the bottom of anything any more (review M3).
  $effect(() => { const id = worker.id; return () => onAtBottom(false, id); });
  onDestroy(() => onAtBottom(false, worker.id));
  function onScroll() { report(); }
  // The first row after the read mark that isn't the principal's own, over the rows as shown.
  const rowAsMessage = (r: (typeof rows)[number]) => (r.kind === "msg" || r.kind === "event" ? { id: r.key, at: r.message.at, author: r.message.author } : r.kind === "activity" ? { id: r.key, at: r.at, author: { kind: "agent" as const, name: "" } } : null);
  // Before a change: the distance from the bottom, and the first message on screen with its place, which an older page
  // keeps exactly where it was (review M4: the cap can trim the newest end in the same change). Its bottom edge, not its
  // top: with older messages of the same author above, it loses its name line, and its text must not move up.
  $effect.pre(() => {
    void rows.length; void messages[0]?.id; void olderPages;
    if (!scroller) return;
    savedFromBottom = scroller.scrollHeight - scroller.scrollTop;
    const top = scroller.getBoundingClientRect().top;
    pinned = null;
    for (const el of scroller.querySelectorAll<HTMLElement>("[data-msg]")) {
      const r = el.getBoundingClientRect();
      if (r.bottom > top) { pinned = { id: el.dataset.msg ?? "", bottom: r.bottom - top }; break; }
    }
  });
  $effect(() => {
    const first = messages[0]?.id, last = messages.at(-1)?.id, count = messages.length, out = outgoing.length;
    void rows.length;
    let change: TimelineChange;
    const mark = dividerMark;
    if (loading || (openedFor !== worker.id && mark === undefined)) change = { kind: "loading" };
    else if (openedFor !== worker.id) {
      openedFor = worker.id;
      armed = false;
      const shown = rows.map(rowAsMessage).filter(x => x !== null) as unknown as Message[];
      divider = dividerBefore(shown, mark ?? null);
      change = { kind: "opened", divider };
    } else if (wantBottom) { wantBottom = false; change = { kind: "own" }; }
    else if (olderPages !== seen.pages) change = { kind: "older" };
    else if (out > seen.outgoing) change = { kind: "own" };
    else if (last !== seen.last) {
      change = { kind: "newer", atBottom: stick };
      if (!stick) newBelow += Math.max(1, count - seen.count);
    } else change = { kind: "loading" };
    seen = { first, last, count, outgoing: out, pages: olderPages };
    const anchor = scrollAnchor(change);
    void tick().then(() => apply(anchor));
  });
  function apply(a: Anchor) {
    if (!scroller) return;
    switch (a.kind) {
      case "none": break;
      case "bottom": scroller.scrollTop = scroller.scrollHeight; break;
      case "message": {
        const el = scroller.querySelector<HTMLElement>(a.block === "start" ? ".newdiv" : `[data-msg="${CSS.escape(a.id)}"]`);
        if (el) el.scrollIntoView({ block: a.block });
        else scroller.scrollTop = scroller.scrollHeight;
        break;
      }
      case "keep-in-place": {
        const el = pinned ? scroller.querySelector<HTMLElement>(`[data-msg="${CSS.escape(pinned.id)}"]`) : null;
        if (el && pinned) scroller.scrollTop += el.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top - pinned.bottom;
        else scroller.scrollTop = scroller.scrollHeight - savedFromBottom;
        break;
      }
      default: unreachable(a);
    }
    report();
    if (!armed && openedFor === worker.id && !loading) requestAnimationFrame(() => { armed = true; });
    // A short page can leave the top in view, where the observer won't fire again (review L2): ask for the next one.
    else if (armed && a.kind === "keep-in-place") requestAnimationFrame(olderIfTopInView);
  }
  function jump() {
    newBelow = 0;
    if (detached) { wantBottom = true; onLatest(); return; }
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    report();
  }
  // Older pages: when the top of the list comes into view (O9). Not after the hub couldn't read one: then on Try again.
  let top = $state<HTMLDivElement | null>(null);
  const wantsOlder = () => !older.loading && !older.done && !older.failed && messages.length > 0;
  function olderIfTopInView() {
    if (!top || !scroller || !wantsOlder()) return;
    if (top.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top - 200) onOlder();
  }
  $effect(() => {
    if (!top || !scroller || !armed) return;
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting) && wantsOlder()) onOlder();
    }, { root: scroller, rootMargin: "200px 0px 0px 0px" });
    io.observe(top);
    return () => io.disconnect();
  });
  // "Show in chat" from a decision: scroll its message into view (timeline.ts's focus rule) and flash it once it's loaded.
  let flash = $state<string | null>(null);
  $effect(() => {
    const f = focus;
    if (!f || !rows.some(r => r.key === f.id)) return;
    tick().then(() => {
      if (!scroller?.querySelector(`[data-msg="${CSS.escape(f.id)}"]`)) return;
      apply(scrollAnchor({ kind: "focus", id: f.id }));
      flash = f.id;
      setTimeout(() => { if (flash === f.id) flash = null; }, 2200);
    });
  });
</script>

<div class="list">
<div class="pane" bind:this={scroller} onscroll={onScroll}>
  <div class="intro">
    <div class="big">{#if worker.name === "manager"}<Avatar name="Manager" kind="peer" size={72} />{:else}<Avatar name={worker.name} size={72} />{/if}</div>
    <h2>{displayName}</h2>
    <p>{worker.title ?? "An agent working on this machine."}</p>
    <p class="meta">Working in <strong>{worker.location}</strong>. You see its answers here; the raw terminal is under Screen.</p>
  </div>

  <div class="older-top" bind:this={top}></div>
  <!-- One line of fixed height, whatever it says: "Loading older…" appearing above must not push the messages down. -->
  <div class="older-status">
    {#if !loading && older.done}<p>Beginning of conversation</p>
    {:else if older.loading}<p>Loading older messages…</p>
    {:else if older.failed}<p>Couldn't load older messages. <button class="more" onclick={onOlder}>Try again</button></p>{/if}
  </div>
  {#if loading}
    <p class="loading">Loading the conversation…</p>
  {/if}

  {#each rows as r (r.key)}
    {#if r.key === divider}<div class="newdiv" role="separator" aria-label="New messages"><span>New messages</span></div>{/if}
    {#if r.kind === "day"}
      <div class="day"><span>{r.label}</span></div>
    {:else if r.kind === "activity"}
      <div class="line act">
        <span class="gut"><Wrench size={14} /></span>
        <span>Used {r.tools.map(t => (t.count > 1 ? `${t.name} ×${t.count}` : t.name)).join(", ")}</span>
        <time>{clock(r.at)}</time>
      </div>
    {:else if r.kind === "event"}
      <div class="line ev" class:tap={r.message.author.kind === "principal" && r.message.text.startsWith("chose ")} data-msg={r.message.id}>
        <span class="gut">{#if r.message.author.kind === "principal" && r.message.text.startsWith("chose ")}<CircleCheck size={14} />{:else}<Info size={14} />{/if}</span>
        <span><strong>{r.message.author.name}</strong> {r.message.text}</span>
        <time>{clock(r.message.at)}</time>
      </div>
    {:else}
      {@const m = r.message}
      {@const s = m.author.kind === "agent" ? statusOf(m.text) : { status: null, rest: m.text }}
      {@const d = decisionOf(m.id)}
      <article class="msg" class:head={r.head} class:flash={flash === m.id} data-msg={m.id}>
        <div class="gutter">
          {#if r.head}<Avatar name={authorName(m)} kind={avatarKind(m)} />{:else}<time class="hover-time">{clock(m.at).replace(/ [AP]M$/, "")}</time>{/if}
        </div>
        <div class="content">
          {#if r.head}
            <div class="who"><strong>{authorName(m)}</strong>{#if m.author.kind === "agent"}<span class="app">AGENT</span>{/if}<time>{clock(m.at)}</time></div>
          {/if}
          {#if m.kind === "question" && d}
            {@render card(d)}
          {:else if m.kind === "question"}
            <div class="question">
              <div class="qh"><CircleHelp size={16} /> Question for you</div>
              <div class="md">{@html renderMarkdown(m.text)}</div>
              {#if worker.needsYou}<p class="hint">It's waiting. Answer it in the Screen tab.</p>{/if}
            </div>
          {:else}
            {#if s.status}<span class="status {s.status}" title={STATUS_TITLE[s.status]}>{STATUS_TEXT[s.status]}</span>{/if}
            {#if s.rest.trim()}<div class="md" class:clamp={long(s.rest) && !expanded[m.id]}>{@html renderMarkdown(s.rest)}</div>{/if}
            {#if m.attachments?.length}<Attachments attachments={m.attachments} />{/if}
            {#if long(s.rest)}
              <button class="more" onclick={() => (expanded[m.id] = !expanded[m.id])}>{expanded[m.id] ? "Show less" : "Show more"}</button>
            {/if}
            {#if d}{@render card(d)}{/if}
          {/if}
        </div>
      </article>
    {/if}
  {/each}

  {#each outgoing as p (p.id)}
    {@const stuck = p.state === "failed" || p.state === "uncertain"}
    <article class="msg head pending {p.state}" class:failed={stuck} data-outbox={p.id} data-state={p.state}>
      <div class="gutter"><Avatar name="You" kind="principal" /></div>
      <div class="content">
        <div class="who"><strong>You</strong><time>{label(p)}</time></div>
        {#if p.text.trim()}<div class="md">{@html renderMarkdown(p.text)}</div>{/if}
        {#if p.images.length}<div class="sent-images">{#each p.images as src (src)}<img {src} alt="" />{/each}</div>{/if}
        {#if p.files.length}
          <div class="sent-files">{#each p.files as f (`${f.name}:${f.size}`)}<span class="filechip"><span class="fn">{f.name}</span><small>{fileType(f.name, f.kind)} · {fileSize(f.size)}</small></span>{/each}</div>
        {:else if !p.images.length && p.uploads.length}<p class="meta-line">{p.uploads.length === 1 ? "1 file" : `${p.uploads.length} files`}</p>{/if}
        {#if stuck}<p class="err">{reason(p)}</p>{/if}
        {#if deliveryNote(p)}<p class="meta-line" data-delivery={p.delivery?.state}>{deliveryNote(p)}</p>{/if}
        {#if stuck || p.state === "queued" || p.state === "sending" || (p.state === "sent" && label(p) !== "Sent")}
          <div class="outbox-actions">
            {#if p.state === "failed" && p.error === "step_up"}<button onclick={() => onVerify(p.id)}>Verify and send</button>
            {:else if canEdit(p)}<button onclick={() => onEdit(p.id)}>Edit</button>
            {:else if canRetry(p, clockNow)}<button onclick={() => onRetry(p.id)}>{p.state === "uncertain" ? "Check again" : "Retry"}</button>
            {:else if canCancel(p)}<button onclick={() => onCancel(p.id)}>Cancel</button>{/if}
            <button onclick={() => onDiscard(p.id)}>{p.state === "sent" ? "Dismiss" : "Discard"}</button>
          </div>
        {/if}
      </div>
    </article>
  {/each}
  <div class="end"></div>
</div>
{#if jumpShown || detached}
  <button class="jump" onclick={jump} aria-label={newBelow + newWhileDetached ? `Jump to the latest: ${newBelow + newWhileDetached} new` : "Jump to the latest"}>
    <ArrowDown size={14} />{#if newBelow + newWhileDetached}<span>{newBelow + newWhileDetached} new</span>{:else}<span>Latest</span>{/if}
  </button>
{/if}
</div>

<style>
  .list { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .pane { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-bottom: 12px; }
  .intro { padding: 32px 20px 20px; display: grid; gap: 6px; }
  .intro .big { margin-bottom: 8px; }
  .intro h2 { margin: 0; font: 900 22px/1.25 var(--font); color: var(--text); }
  .intro p { margin: 0; font: 400 15px/22px var(--font); color: var(--muted); max-width: 70ch; }
  .intro .meta { font-size: 13px; }
  .loading { padding: 0 20px; color: var(--muted); font-size: 13px; }
  .day { position: relative; display: flex; justify-content: center; margin: 16px 0 8px; }
  .day::before { content: ""; position: absolute; left: 0; right: 0; top: 50%; border-top: 1px solid var(--border); }
  .day span {
    position: relative; padding: 0 16px; height: 28px; line-height: 26px; border: 1px solid var(--border); border-radius: 24px;
    background: var(--main-bg); font: 700 13px/26px var(--font); color: var(--text);
  }
  .msg { display: flex; padding: 2px 20px; }
  .msg.head { padding-top: 8px; }
  .msg:hover, .line:hover { background: var(--row-hover); }
  /* Text on a tint is full text, never muted (COLOR.md 8): a tinted row (hovered, or flashed by "Show in chat")
     redeclares the muted alias, so its times, hints and captions follow. Cards on it keep their own (DecisionCard, Attachments). */
  .msg:hover, .msg.flash, .line:hover { --muted: var(--text); }
  .gutter { width: 36px; flex: none; margin-right: 8px; }
  .hover-time { display: block; visibility: hidden; text-align: right; font: 400 12px/22px var(--font); color: var(--muted); }
  .msg:hover .hover-time { visibility: visible; }
  .content { min-width: 0; flex: 1; }
  .who { display: flex; align-items: baseline; gap: 8px; }
  .who strong { font: 900 15px/22px var(--font); color: var(--text); }
  .who time, .line time { font: 400 12px/17.6px var(--font); color: var(--muted); }
  .app { font: 700 10px/1 var(--font); letter-spacing: 0.02em; padding: 3px 4px; border-radius: 3px; background: var(--muted-bg); color: var(--text); }
  .md { font: 400 15px/22px var(--font); color: var(--text); overflow-wrap: anywhere; }
  .md.clamp { max-height: 396px; overflow: hidden; -webkit-mask-image: linear-gradient(#000 70%, transparent); mask-image: linear-gradient(#000 70%, transparent); }
  .md :global(p) { margin: 0 0 4px; }
  .md :global(p:last-child) { margin-bottom: 0; }
  .md :global(ul), .md :global(ol) { margin: 2px 0 6px; padding-left: 26px; }
  .md :global(li) { margin: 2px 0; }
  .md :global(h1), .md :global(h2), .md :global(h3), .md :global(h4) { font: 900 15px/22px var(--font); margin: 8px 0 2px; }
  .md :global(a) { color: var(--link); text-decoration: underline; }
  .md :global(code) { font: 12px/18px var(--mono); padding: 2px 3px 1px; border-radius: 3px; border: 1px solid var(--code-border); background: var(--code-bg); color: var(--code-fg); }
  .md :global(pre) { margin: 4px 0; padding: 8px; border-radius: 4px; border: 1px solid var(--code-border); background: var(--pre-bg); overflow-x: auto; }
  .md :global(pre code) { border: 0; padding: 0; background: transparent; color: var(--text); white-space: pre; }
  .md :global(blockquote) { margin: 4px 0; padding-left: 12px; border-left: 4px solid var(--border-strong); color: var(--text); }
  .md :global(table) { border-collapse: collapse; margin: 6px 0; font-size: 14px; display: block; overflow-x: auto; }
  .md :global(th), .md :global(td) { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
  .md :global(hr) { border: 0; border-top: 1px solid var(--border); }
  .more { margin-top: 2px; padding: 0; border: 0; background: none; color: var(--link); font: 700 13px/19px var(--font); cursor: pointer; text-decoration: underline; }
  .status { display: inline-block; margin: 2px 0 4px; padding: 2px 8px; border-radius: 4px; font: 700 12px/18px var(--font); }
  .status.done { background: var(--muted-bg); color: var(--text); }
  .status.blocked, .status.failed { background: var(--bad-bg); color: var(--bad-fg); }
  .status.decision { background: var(--warn-bg); color: var(--warn-fg); }
  .question { border-left: 4px solid var(--border-strong); padding: 4px 0 4px 12px; margin: 2px 0; }
  .qh { display: flex; align-items: center; gap: 6px; font: 700 13px/19px var(--font); color: var(--text); margin-bottom: 2px; }
  .hint { margin: 4px 0 0; font: 400 13px/19px var(--font); color: var(--muted); }
  .line { display: flex; align-items: center; gap: 8px; padding: 1px 20px; font: 400 13px/20px var(--font); color: var(--muted); }
  .line .gut { width: 36px; margin-right: 0; display: grid; justify-items: end; flex: none; }
  .line span:nth-child(2) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .line time { visibility: hidden; margin-left: auto; }
  .line:hover time { visibility: visible; }
  .ev strong { color: var(--text); font-weight: 700; }
  .ev.tap { color: var(--text); }
  .ev.tap .gut { color: var(--ok-fg); }
  .msg.flash { animation: flash 2.2s ease-out; }
  @keyframes flash { 0%, 40% { background: var(--selected); } 100% { background: transparent; } }
  .pending { opacity: 0.6; }
  .older-top { height: 1px; }
  .older-status { min-height: 36px; display: flex; align-items: center; justify-content: center; padding: 0 20px; color: var(--muted); font-size: 13px; text-align: center; }
  .older-status p { margin: 0; }
  .newdiv { position: relative; display: flex; justify-content: flex-end; margin: 8px 20px 4px; }
  .newdiv::before { content: ""; position: absolute; left: 0; right: 0; top: 50%; border-top: 1px solid var(--badge); }
  .newdiv span { position: relative; padding: 0 6px; background: var(--main-bg); color: var(--bad-fg); font: 700 12px/16px var(--font); }
  .jump {
    position: absolute; right: 24px; bottom: 16px; z-index: 3; display: inline-flex; align-items: center; gap: 6px;
    height: 32px; padding: 0 12px; border-radius: 16px; border: 1px solid var(--outline); background: var(--main-bg); color: var(--text);
    font: 700 13px/30px var(--font); cursor: pointer; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  }
  .jump:hover { background: var(--hover); }
  .sent-images { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
  .sent-images img { max-width: 240px; max-height: 180px; border-radius: 8px; border: 1px solid var(--border); object-fit: contain; }
  .sent-files { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
  .filechip { display: flex; align-items: center; gap: 8px; max-width: 280px; height: 36px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--main-bg); min-width: 0; }
  .filechip .fn { font: 700 13px/18px var(--font); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .filechip small { flex: none; font: 400 12px/16px var(--font); color: var(--muted); }
  .pending.failed, .pending.sent { opacity: 1; }
  .pending.sent time { color: var(--ok-fg); }
  .meta-line { margin: 2px 0 0; font-size: 13px; color: var(--muted); }
  .outbox-actions { display: flex; gap: 8px; margin-top: 6px; }
  .outbox-actions button {
    height: 28px; padding: 0 12px; border-radius: 6px; border: 1px solid var(--outline); background: var(--main-bg); color: var(--text);
    font: 700 13px/26px var(--font); cursor: pointer;
  }
  .outbox-actions button:hover { background: var(--hover); }
  .err { margin: 4px 0 0; color: var(--bad-fg); font: 400 13px/19px var(--font); }
  .end { height: 4px; }
</style>
