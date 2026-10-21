<script lang="ts">
  // One conversation on the phone, as a chat app (ADR-0011): bubbles (his on the right), day separators, grouped runs,
  // tool calls folded into a quiet line, long answers shortened; his messages still on their way at the bottom with
  // where they stand (Sending, Queued, Delivered, Not sent with Retry); and a composer kept above the keyboard and the
  // home indicator. Read here, at the bottom of the list, it is read (O7, as on the desktop). "Screen" shows the lane's
  // terminal, read-only. A lane that waits for his call says so above the composer, with the way to its card.
  import { onMount, tick, untrack } from "svelte";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import SendHorizontal from "@lucide/svelte/icons/send-horizontal";
  import X from "@lucide/svelte/icons/x";
  import Check from "@lucide/svelte/icons/check";
  import CheckCheck from "@lucide/svelte/icons/check-check";
  import Clock from "@lucide/svelte/icons/clock-3";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import { UPLOAD_ACCEPT, type Message, type RosterEntry } from "@morndo/domain";
  import { beginAttachments, fileSize, fileType, removalNote, settleAttachment, type AttachmentRow, type SentFile } from "../../attach.ts";
  import { uploadFile } from "../../api.ts";
  import type { LiveFeed } from "../../feed.svelte.ts";
  import type { DecisionItem } from "../../desktop/decisions.ts";
  import { renderMarkdown } from "../../markdown.ts";
  import { present, withoutFileNotes } from "../../desktop/present.ts";
  import { MAX_TEXT, canCancel, canEdit, canRetry, type OutboxRecord } from "../../outbox/state.ts";
  import { heldBehind, sendReason } from "../../outbox/words.ts";
  import { attachmentKey, bubbles, isLong, shortened } from "./bubbles.ts";
  import { deadReason, deliveryLabel, deliveryOf, lostReason, maybeReason } from "./delivery.ts";
  import { displayName, status } from "./rows.ts";
  import { followKeyboard } from "./keyboard.ts";
  import { bindWatch, pinnedToEnd } from "./watch.ts";
  import { deviceDrafts, leftAfterSend } from "../../drafts.ts";
  import { ABSENT_MANAGER, sentTo } from "../../manager.ts";

  let { feed, worker, outgoing, pendingFiles = {}, now, verifiedFresh, verify, onBack, onDecide, onQueue, onRetry, onDiscard, onAgain, onCancel, onEchoes, screen = false }: {
    feed: LiveFeed; worker: RosterEntry; outgoing: OutboxRecord[]; pendingFiles?: Record<string, SentFile[]>; now: number; verifiedFresh: boolean; verify: () => Promise<boolean>;
    onBack: () => void; onDecide: (id: string) => void;
    onQueue: (c: { worker: string; workerName: string; text: string; uploads: string[]; seen: string; files: SentFile[] }) => Promise<void>;
    onRetry: (id: string) => void; onDiscard: (id: string) => void; onAgain: (id: string) => void; onCancel: (id: string) => void;
    onEchoes: (worker: string, echoes: { id: string; at: number; text: string }[], name?: string) => void;
    screen?: boolean;
  } = $props();

  const name = $derived(displayName(worker.name));
  const loaded = $derived(feed.historyFor === worker.id);
  const asks = $derived(feed.decisions.filter((d: DecisionItem) => d.status === "open" && d.need === "decision" && d.asker.workerId === worker.id));
  // His latest message to it, for whether a NEEDS DECISION report is answered (H3): from the loaded conversation, else
  // the chat list's preview.
  const repliedAt = $derived(loaded ? feed.messages.findLast((m: Message) => m.author.kind === "principal")?.at ?? null : feed.chats[worker.id]?.repliedAt ?? null);
  const st = $derived(status(worker, asks, feed.chats[worker.id]?.answer ?? null, now, repliedAt));
  const items = $derived(loaded ? bubbles(present(feed.messages, { show: "clean", activity: true }), now) : []);
  const mine = $derived(outgoing.filter(o => sentTo(o, worker)));
  // The manager while it has no window (a restart): listed as not running. A message waits for it in the fleet's queue
  // when the hub has one on; without it, nothing can hold one, so the box stays shut until it runs again.
  const absent = $derived(worker.id === ABSENT_MANAGER);
  const canWrite = $derived(!absent || feed.managerQueue === true);
  const scope = $derived(absent
    ? (canWrite ? "Waits for the manager while it isn't running, up to a day; it goes in once it runs again." : "Start the manager to message it.")
    : worker.name === "manager"
      ? (feed.managerQueue ? "Goes to the manager's queue; it's typed in once its box is free." : "Goes straight to the manager.")
      : `Goes straight to ${name}; the manager won't see it.`);
  let view = $state<"chat" | "screen">(screen ? "screen" : "chat");
  $effect(() => { if (screen) view = "screen"; });
  let expanded = $state<Record<string, boolean>>({});
  let online = $state(typeof navigator === "undefined" || navigator.onLine !== false);

  $effect(() => {
    const id = worker.id;
    return untrack(() => bindWatch(feed, id));
  });
  // His messages as the conversation shows them end the matching entries on their way (S8): delivered.
  $effect(() => {
    if (!loaded || !mine.some(o => o.state === "sent")) return;
    onEchoes(worker.id, feed.messages.filter((m: Message) => m.author.kind === "principal").map((m: Message) => ({ id: m.id, at: m.at, text: withoutFileNotes(m.text) })), worker.name);
  });

  // Scrolling: to the bottom when it opens and when something arrives while he is at the bottom.
  let scroller = $state<HTMLDivElement | null>(null);
  let screenEl = $state<HTMLPreElement | null>(null);
  let followScreen = $state(true);
  const onScreenScroll = () => { if (screenEl) followScreen = pinnedToEnd(screenEl.scrollHeight, screenEl.scrollTop, screenEl.clientHeight); };
  $effect(() => {
    void feed.screen?.text; void view;
    if (view !== "screen" || !screenEl || !untrack(() => followScreen)) return;
    void tick().then(() => { if (screenEl) screenEl.scrollTop = screenEl.scrollHeight; });
  });
  let atBottom = $state(true);
  let visible = $state(typeof document === "undefined" || document.visibilityState === "visible");
  const fromBottom = () => (scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : 0);
  const onScroll = () => { atBottom = fromBottom() < 60; };
  $effect(() => {
    void items.length; void mine.length;
    if (!scroller || view !== "chat") return;
    if (untrack(() => atBottom)) void tick().then(() => { if (scroller) scroller.scrollTop = scroller.scrollHeight; });
  });
  // Read (O7): open, visible, loaded, at the bottom: up to the last message held, as the desktop does.
  $effect(() => {
    if (!loaded || !visible || !atBottom || view !== "chat" || feed.detached) return;
    const last = feed.messages.at(-1);
    if (last) feed.markRead(worker.name, last.at);
  });

  // The composer: what the lane waited for when he started writing goes with it (S6); a due passkey check comes first
  // (AC7), inside the tap; the box is free at once and the message waits in the outbox, never lost.
  // The draft of this chat, on this device (shared with the desktop's composer): back when the chat opens, saved 300 ms
  // after the last keystroke, gone once sent. Leaving the chat keeps it.
  const drafts = deviceDrafts();
  const restored = untrack(() => drafts.get(worker.id, worker.name));
  let text = $state(restored?.text ?? "");
  // Longer than a lane takes: said while typing, and not sent (the hub would refuse it too_long).
  const over = $derived(text.length > MAX_TEXT);
  const withSep = (n: number) => n.toLocaleString("en-US");
  let seen = $state<string | null>(restored?.seen ?? null);
  $effect(() => { drafts.typed(worker.id, worker.name, text, seen); });
  let note = $state<string | null>(null);
  let busy = $state(false);
  let input = $state<HTMLTextAreaElement | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let dragging = $state(false);
  let files = $state<AttachmentRow[]>([]);
  const readyIds = $derived(files.filter(f => f.status === "ready" && f.id).map(f => f.id as string));
  const uploading = $derived(files.some(f => f.status === "uploading"));
  const failed = $derived(files.some(f => f.status === "error"));
  function addFiles(list: File[]) {
    if (absent) { note = "Files can't go to the manager while it isn't running."; return; }
    const started = beginAttachments(files.length, list);
    note = started.note;
    for (const { file, row } of started.taken) {
      files.push(row);
      void settleAttachment(files.find(s => s.key === row.key) ?? row, file, uploadFile);
    }
  }
  $effect(() => {
    const started = text.trim().length > 0 || files.length > 0;
    if (started && seen === null) seen = worker.waitingOn ?? "none";
    else if (!started) seen = null;
  });
  $effect(() => {
    void text;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  });
  async function send() {
    const blocked = removalNote(files);
    if (blocked) { note = blocked; return; }
    const body = text.trim();
    if (!canWrite || over || (!body && readyIds.length === 0) || busy || uploading) return;
    busy = true;
    note = null;
    const uploads = readyIds;
    const attached = files.filter(f => f.status === "ready").map((f): SentFile => ({ name: f.name, kind: f.kind, size: f.size }));
    const sentFiles = files, typed = text;                             // what goes: anything added during the check stays
    try {
      if (!verifiedFresh && navigator.onLine !== false && !(await verify())) { note = "Not sent: the passkey check didn't finish. Your message is still here."; return; }
      const written = seen ?? worker.waitingOn ?? "none";
      drafts.sent(worker.id);
      text = leftAfterSend(text, typed);
      files = files.filter(f => !sentFiles.includes(f));
      if (text.trim()) drafts.typed(worker.id, worker.name, text, seen);
      try { await onQueue({ worker: worker.id, workerName: worker.name, text: body, uploads, files: attached, seen: written }); }
      catch { text = text.trim() ? `${body}\n\n${text}` : body; files = [...sentFiles, ...files]; note = "Couldn't keep the message on this device. It is back in the box."; return; }
      atBottom = true;
      void tick().then(() => { if (scroller) scroller.scrollTop = scroller.scrollHeight; });
    } finally { busy = false; input?.focus(); }
  }

  let root = $state<HTMLElement | null>(null);
  onMount(() => {
    const stop = root ? followKeyboard(root) : () => {};
    const shown = () => (visible = document.visibilityState === "visible");
    const net = () => (online = navigator.onLine !== false);
    document.addEventListener("visibilitychange", shown);
    addEventListener("online", net);
    addEventListener("offline", net);
    return () => { stop(); document.removeEventListener("visibilitychange", shown); removeEventListener("online", net); removeEventListener("offline", net); };
  });
  const clock = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const used = (n: number, names: string[]) => `Used ${n === 1 ? "1 tool" : `${n} tools`}${names.length ? `: ${names.slice(0, 3).join(", ")}` : ""}`;
</script>

<section class="convo" bind:this={root} aria-label="Conversation with {name}">
  <header class="bar">
    <button class="back" onclick={onBack} aria-label="Back to chats"><ChevronLeft size={26} /></button>
    <span class="avatar" class:quiet={worker.name !== "manager"} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
    <span class="who"><b>{name}</b><span class="sub {absent ? "idle" : st.kind}">{absent ? "Not running" : st.label}</span></span>
    {#if !absent}
      <div class="seg" role="tablist" aria-label="Show">
        <button role="tab" aria-selected={view === "chat"} class:on={view === "chat"} onclick={() => (view = "chat")}>Chat</button>
        <button role="tab" aria-selected={view === "screen"} class:on={view === "screen"} onclick={() => (view = "screen")}>Screen</button>
      </div>
    {/if}
  </header>

  {#if view === "screen"}
    <pre class="screen" bind:this={screenEl} onscroll={onScreenScroll} aria-label="{name}'s screen, read-only">{feed.screen?.worker === worker.id ? feed.screen.text : "Loading the screen…"}</pre>
  {:else}
    <div class="scroll" bind:this={scroller} onscroll={onScroll}>
      {#if !loaded}<p class="note pad">Loading the conversation…</p>{/if}
      {#if absent}
        <p class="note pad" data-absent>{canWrite
          ? "The manager isn't running right now. What you write waits for it, up to a day, and goes in once it runs again."
          : "The manager isn't running. Start it to message it."}</p>
      {/if}
      <ol class="msgs">
        {#each items as it (it.kind === "bubble" ? it.m.id : it.key)}
          {#if it.kind === "day"}
            <li class="day"><span>{it.label}</span></li>
          {:else if it.kind === "tools"}
            <li class="tools note">{used(it.count, it.names)}</li>
          {:else}
            {@const m = it.m}
            {@const long = !it.mine && isLong(m.text) && !expanded[m.id]}
            <li class="b" class:mine={it.mine} class:first={it.first} class:last={it.last} class:event={m.kind === "event"} data-msg={m.id}>
              {#if it.first && !it.mine && m.author.kind === "peer"}<span class="from">{m.author.name}</span>{/if}
              <div class="bubble" class:q={m.kind === "question"}>
                {#if m.kind === "question"}<span class="kicker">Asks you</span>{/if}
                {#if m.text}<div class="md">{@html renderMarkdown(long ? shortened(m.text) : it.mine ? withoutFileNotes(m.text) : m.text)}</div>{/if}
                {#if long}<button class="tlink more" onclick={() => (expanded = { ...expanded, [m.id]: true })}>Show more</button>{/if}
                {#if m.attachments?.length}
                  <div class="files">
                    {#each m.attachments as a, i (attachmentKey(m.id, i))}
                      {#if a.id}<a class="file" href="/api/files/{a.id}" target="_blank" rel="noopener"><span>{a.name}</span><small>{fileType(a.name, a.kind)}{a.size != null ? ` · ${fileSize(a.size)}` : ""}</small></a>{:else}<span class="file gone"><span>{a.name}</span><small>not available</small></span>{/if}
                    {/each}
                  </div>
                {/if}
                <span class="meta"><time>{clock(m.at)}</time>{#if it.mine && m.kind !== "event"}<CheckCheck size={14} aria-label="Delivered" />{/if}</span>
              </div>
            </li>
          {/if}
        {/each}
        {#each mine as o (o.id)}
          {@const d = deliveryOf(o, now)}
          <li class="b mine first last pending" data-outbox={o.id} data-delivery={d}>
            <div class="bubble" class:failed={d === "failed" || d === "uncertain" || d === "lost" || d === "unseen" || d === "maybe" || d === "dead"}>
              {#if o.text.trim()}<div class="md"><p>{o.text}</p></div>{/if}
              {#if pendingFiles[o.id]?.length}
                <div class="files">
                  {#each pendingFiles[o.id] ?? [] as f (`${f.name}:${f.size}`)}
                    <span class="file"><span>{f.name}</span><small>{fileType(f.name, f.kind)} · {fileSize(f.size)}</small></span>
                  {/each}
                </div>
              {/if}
              <span class="meta">
                {#if d === "delivered" || d === "arrived"}<CheckCheck size={14} />{:else if d === "sending"}<Check size={14} />{:else if d === "queued"}<Clock size={14} />{:else}<CircleAlert size={14} />{/if}
                <span class="state" role="status">{deliveryLabel(o, outgoing, online, now)}</span>
              </span>
            </div>
            {#if d === "failed" || d === "uncertain"}
              <p class="why">{sendReason(o, name, "its Screen")}</p>
              <div class="acts">
                {#if canRetry(o, now)}<button class="pbtn small" onclick={() => onRetry(o.id)}>Retry</button>{/if}
                {#if canEdit(o)}<button class="pbtn small" onclick={() => { text = o.text; onDiscard(o.id); input?.focus(); }}>Edit</button>{/if}
                <button class="pbtn small" onclick={() => onDiscard(o.id)}>Discard</button>
              </div>
            {:else if d === "lost"}
              <p class="why">{lostReason(o)}</p>
              <div class="acts">
                <button class="pbtn small" onclick={() => onAgain(o.id)}>Send again</button>
                <button class="pbtn small" onclick={() => onDiscard(o.id)}>Discard</button>
              </div>
            {:else if d === "arrived"}
              <div class="acts"><button class="pbtn small" onclick={() => onDiscard(o.id)}>Dismiss</button></div>
            {:else if d === "dead"}
              <!-- The hub can't queue it again: no button that would only ask for the passkey and do nothing. -->
              <p class="why">{deadReason(o)}</p>
              <div class="acts">
                <button class="pbtn small" onclick={() => { text = text.trim() ? `${text}\n\n${o.text}` : o.text; onDiscard(o.id); input?.focus(); }}>Write it again</button>
                <button class="pbtn small" onclick={() => onDiscard(o.id)}>Discard</button>
              </div>
            {:else if d === "maybe"}
              <p class="why">{maybeReason()}</p>
              <div class="acts"><button class="pbtn small" onclick={() => onDiscard(o.id)}>Dismiss</button></div>
            {:else if canCancel(o)}
              <!-- In the manager's queue and not typed yet (ruling 83): it can still be withdrawn. -->
              <div class="acts"><button class="pbtn small" onclick={() => onCancel(o.id)}>Cancel</button></div>
            {:else if d === "unseen"}
              <div class="acts"><button class="pbtn small" onclick={() => onDiscard(o.id)}>Dismiss</button></div>
            {:else if heldBehind(o, outgoing)}
              <!-- Held behind one that didn't go (review M3): it can be dropped too, never stuck. -->
              <div class="acts"><button class="pbtn small" onclick={() => onDiscard(o.id)}>Discard</button></div>
            {/if}
          </li>
        {/each}
      </ol>
    </div>
  {/if}

  {#if asks.length}
    <div class="waitbar">
      <span><b>Waits for your call:</b> {asks[0]?.shortTitle ?? asks[0]?.title}</span>
      <button class="pbtn small primary" onclick={() => asks[0] && onDecide(asks[0].id)}>Decide</button>
    </div>
  {/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="composer" class:dragging
    ondragover={e => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); dragging = true; } }}
    ondragleave={() => (dragging = false)}
    ondrop={e => { dragging = false; const list = [...(e.dataTransfer?.files ?? [])]; if (!list.length) return; e.preventDefault(); void addFiles(list); }}>
    {#if note}<p class="err">{note}</p>{/if}
    {#if files.length}
      <div class="pending" aria-label="Files to send">
        {#each files as f (f.key)}
          <span class="chip {f.status}"><span class="fn">{f.name}</span><small>{f.error ?? `${fileType(f.name, f.kind)} · ${fileSize(f.size)}`}</small><button type="button" onclick={() => (files = files.filter(x => x.key !== f.key))} aria-label="Remove {f.name}"><X size={14} /></button></span>
        {/each}
      </div>
    {/if}
    <div class="box">
      {#if !absent}<button class="clip" type="button" onclick={() => fileInput?.click()} aria-label="Attach a file"><Paperclip size={20} /></button>{/if}
      <input bind:this={fileInput} type="file" accept={UPLOAD_ACCEPT} multiple hidden
        onchange={e => { void addFiles([...((e.currentTarget as HTMLInputElement).files ?? [])]); (e.currentTarget as HTMLInputElement).value = ""; }} />
      <textarea bind:this={input} bind:value={text} rows="1" placeholder="Message {name}" aria-label="Message {name}" enterkeyhint="send" disabled={!canWrite}
        onpaste={e => { const list = [...(e.clipboardData?.files ?? [])]; if (!list.length) return; if (!e.clipboardData?.getData("text/plain")) e.preventDefault(); void addFiles(list); }}
        onkeydown={e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !matchMedia("(pointer: coarse)").matches) { e.preventDefault(); void send(); } }}></textarea>
      <button class="send" disabled={!canWrite || over || ((!text.trim() && readyIds.length === 0 && !failed) || busy || uploading)} onclick={send} aria-label="Send"><SendHorizontal size={20} /></button>
    </div>
    {#if over}<p class="err" data-over>Too long for one message: {withSep(text.length)} of {withSep(MAX_TEXT)} characters.</p>{/if}
    <p class="scope note">{scope}</p>
  </div>
</section>

<style>
  /* Fixed to the visual viewport (keyboard.ts): top at its offset, bottom lifted by the keyboard. */
  .convo { position: fixed; left: 0; right: 0; top: var(--vv-top, 0px); bottom: var(--kb, 0px); z-index: 5; display: flex; flex-direction: column; background: var(--bg); }
  .bar {
    display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--line); background: var(--bg);
    padding: calc(var(--safe-top) + 6px) max(10px, var(--safe-right)) 8px max(4px, var(--safe-left));
  }
  :global(.kb-open) .bar { padding-top: 6px; }
  .back { display: grid; place-items: center; width: 44px; height: 44px; border: 0; background: none; color: var(--fg); cursor: pointer; flex: none; }
  .avatar { width: 36px; height: 36px; border-radius: 18px; }
  .who { display: grid; min-width: 0; flex: 1; }
  .who b { font: 700 16px/20px var(--body); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { font: 400 12.5px/16px var(--body); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub.waits { color: var(--bad-text); font-weight: 700; }
  .seg { display: flex; border: 1px solid var(--edge); border-radius: 10px; overflow: hidden; flex: none; }
  .seg button { min-height: 36px; padding: 0 10px; border: 0; background: transparent; color: var(--fg); font: 700 13px/1 var(--body); cursor: pointer; }
  .seg button.on { background: var(--ink); color: var(--ink-fg); }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
  .pad { padding: 12px 16px; }
  .msgs { list-style: none; margin: 0; padding: 8px max(10px, var(--safe-right)) 12px max(10px, var(--safe-left)); display: flex; flex-direction: column; }
  .day { align-self: center; margin: 14px 0 8px; }
  .day span { display: inline-block; padding: 4px 12px; border-radius: 12px; background: var(--fill); color: var(--fg); font: 700 12px/16px var(--body); }
  .tools { align-self: center; margin: 4px 0; font-size: 12.5px; }
  .b { display: flex; flex-direction: column; align-items: flex-start; max-width: 86%; margin-top: 2px; }
  .b.first { margin-top: 10px; }
  .b.mine { align-self: flex-end; align-items: flex-end; }
  .from { font: 700 12px/16px var(--body); color: var(--muted); margin: 0 0 2px 12px; }
  .bubble {
    position: relative; padding: 8px 12px 6px; border-radius: 18px; background: var(--surface); color: var(--fg); border: 1px solid var(--line);
    font: 400 15.5px/22px var(--body); overflow-wrap: anywhere; min-width: 64px;
  }
  .b:not(.mine):not(.last) .bubble { border-bottom-left-radius: 6px; }
  .b:not(.mine):not(.first) .bubble { border-top-left-radius: 6px; }
  .mine .bubble { background: var(--ink); color: var(--ink-fg); border-color: var(--ink); }
  .mine:not(.last) .bubble { border-bottom-right-radius: 6px; }
  .mine:not(.first) .bubble { border-top-right-radius: 6px; }
  .bubble.q { border: 2px solid var(--fg); }
  .bubble.failed { background: var(--surface); color: var(--fg); border: 2px dashed var(--bad); }
  .event .bubble { background: var(--fill); color: var(--fg); border-color: var(--fill); font-size: 14px; }
  .kicker { display: block; font: 700 11px/16px var(--body); letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 2px; }
  .md :global(p) { margin: 0 0 6px; }
  .md :global(p:last-child) { margin-bottom: 0; }
  .md :global(ul), .md :global(ol) { margin: 0 0 6px; padding-left: 20px; }
  .md :global(pre) { white-space: pre-wrap; font: 12.5px/18px var(--mono); background: var(--fill); color: var(--fg); padding: 6px 8px; border-radius: 8px; margin: 4px 0; }
  .md :global(code) { font: 13.5px var(--mono); }
  .md :global(a) { color: inherit; }
  .md :global(table) { display: block; overflow-x: auto; border-collapse: collapse; font-size: 13.5px; }
  .md :global(td), .md :global(th) { border: 1px solid var(--line); padding: 2px 6px; }
  .mine .md :global(pre) { background: color-mix(in srgb, var(--ink-fg) 14%, var(--ink)); color: var(--ink-fg); }
  .meta { display: flex; justify-content: flex-end; align-items: center; gap: 4px; margin-top: 2px; font: 400 11.5px/14px var(--body); color: var(--muted); }
  .mine .meta { color: var(--ink-fg); }
  .bubble.failed .meta { color: var(--bad-text); }
  .more { min-height: 36px; padding: 0; color: inherit; }
  .files { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; max-width: 100%; }
  .file {
    display: flex; align-items: center; gap: 6px; max-width: 100%; min-width: 0; box-sizing: border-box;
    height: 36px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg);
    font: 700 13px/18px var(--body); text-decoration: none;
  }
  .file span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file small { flex: none; font: 400 12px/16px var(--body); color: var(--muted); }
  .file.gone { color: var(--muted); }
  .why { margin: 4px 4px 0; font: 400 13px/18px var(--body); color: var(--bad-text); text-align: right; }
  .acts { display: flex; gap: 8px; margin-top: 6px; }
  .screen {
    flex: 1; min-height: 0; margin: 8px; padding: 12px; border-radius: 12px; background: var(--screen-bg); color: var(--screen-fg);
    font: 11.5px/1.45 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; overflow-y: auto;
  }
  .waitbar {
    display: flex; align-items: center; gap: 10px; padding: 8px max(12px, var(--safe-right)) 8px max(12px, var(--safe-left));
    border-top: 1px solid var(--line); background: var(--bad-soft); color: var(--bad-text); font: 400 14px/19px var(--body);
  }
  .waitbar span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; }
  .composer {
    border-top: 1px solid var(--line); background: var(--surface);
    padding: 8px max(10px, var(--safe-right)) max(8px, var(--safe-bottom)) max(10px, var(--safe-left));
  }
  :global(.kb-open) .composer { padding-bottom: 8px; }
  .composer.dragging { outline: 2px solid var(--ink); }
  .pending { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-height: 32px; padding: 4px 6px 4px 10px; border: 1px solid var(--edge); border-radius: 10px; background: var(--bg); }
  .chip.error { border-color: var(--bad); }
  .chip.error small { color: var(--bad-text); }
  .chip .fn { font: 700 13px/18px var(--body); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .chip small { flex: none; color: var(--muted); font: 400 12px/16px var(--body); }
  .chip button { width: 28px; height: 28px; border: 0; border-radius: 14px; background: transparent; color: var(--fg); display: grid; place-items: center; cursor: pointer; }
  .clip { flex: none; display: grid; place-items: center; width: 44px; height: 44px; border: 0; border-radius: 22px; background: transparent; color: var(--fg); cursor: pointer; }
  .box { display: flex; align-items: flex-end; gap: 8px; }
  textarea {
    flex: 1; min-height: 44px; max-height: 132px; resize: none; padding: 10px 14px; border-radius: 22px; border: 1px solid var(--edge);
    background: var(--bg); color: var(--fg); font: 400 16px/22px var(--body); outline: none;
  }
  textarea::placeholder { color: var(--muted); }
  .send { flex: none; display: grid; place-items: center; width: 44px; height: 44px; border-radius: 22px; border: 0; background: var(--ink); color: var(--ink-fg); cursor: pointer; }
  .send:disabled { background: var(--fill); color: var(--fg); cursor: default; }
  .scope { margin: 4px 6px 0; font-size: 12px; }
  .err { margin: 0 4px 6px; }
</style>
