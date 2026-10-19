<script lang="ts">
  // An update card in catch-up (ADR-0009, the design's catchup-2): one agent's news since he last looked. Its headline
  // is the agent's latest answer in one sentence, with "Says done" when it led with STATUS: DONE (the worker's own word,
  // never a check, V1); then the counts, a NEW line, the messages (newest 30), and a reply box that goes through the
  // outbox. A tap on a message opens the conversation there; a file opens itself. Back returns to this card.
  import SendHorizontal from "@lucide/svelte/icons/send-horizontal";
  import Wrench from "@lucide/svelte/icons/wrench";
  import FileIcon from "@lucide/svelte/icons/file";
  import type { Message, RosterEntry } from "@morndo/domain";
  import type { CatchUpConversationWire } from "@morndo/protocol";
  import { renderMarkdown } from "../markdown.ts";
  import { present, withoutFileNotes } from "../desktop/present.ts";
  import { canCancel, canRetry, type OutboxRecord } from "../outbox/state.ts";
  import { deliveryNote, sendLabel, sendReason } from "../outbox/words.ts";
  import { headline, sinceLabel, spanLabel } from "./words.ts";

  let { worker, name, view, mark, now, outgoing, loading, note, onReply, onOpen, onRetry, onDiscard, onVerify, onCancel = () => {} }: {
    worker: RosterEntry | null; name: string; view: CatchUpConversationWire | null; mark: number | null; now: number;
    outgoing: OutboxRecord[]; loading: boolean; note: string | null;
    onReply: (text: string, seen: string) => Promise<boolean>; onOpen: (messageId: string) => void; onRetry: (id: string) => void; onDiscard: (id: string) => void;
    onVerify: (id: string) => void;                     // "Not sent: verify": the passkey check, then the same request again
    onCancel?: (id: string) => void;                    // a message the manager's queue still holds (ruling 83)
  } = $props();

  let text = $state("");
  let busy = $state(false);
  // What the agent waited for when this reply was started (S6, as the desktop's composer): taken when the box goes from
  // empty to something, kept while it is written, forgotten when it is emptied. The hub refuses the reply as stale if
  // that changed before it arrived (review of PR #7, finding 1).
  let seen = $state<string | null>(null);
  $effect(() => {
    const started = text.trim().length > 0;
    if (started && seen === null) seen = worker?.waitingOn ?? "none";
    else if (!started) seen = null;
  });
  const shown = $derived(present(view?.messages ?? [], { show: "clean", activity: true }));
  const title = $derived(headline(view?.messages ?? []) ?? (view ? `${view.count} new ${view.count === 1 ? "message" : "messages"}` : "New messages"));
  const clock = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  async function send() {
    const t = text.trim();
    if (!t || busy) return;
    busy = true;
    try { if (await onReply(t, seen ?? worker?.waitingOn ?? "none")) text = ""; }
    finally { busy = false; }
  }
</script>

<header class="card-head">
  <span class="avatar quiet" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
  <span class="who"><b>{name}</b><span>{worker?.title ?? worker?.location ?? ""}{worker ? ` · ${worker.state === "active" ? "working" : `quiet ${spanLabel(now - worker.changedAt)}`}` : ""}</span></span>
  {#if worker?.needsYou}<span class="chip bad">Needs you</span>
  {:else if view?.claim === "says_done"}<span class="chip warn">Says done</span>{/if}
</header>

<div class="card-body">
  <p class="kicker">Update · {sinceLabel(mark, now)}</p>
  <h2 class="headline">{title}</h2>
  {#if view && view.count === 0 && view.lastAt === null}
    <p class="note">Nothing new here: it was read on another device, or its session ended. Mark it read to clear it.</p>
  {:else if view}
    <div class="facts">
      <span class="chip">{view.count === 1 ? "1 new message" : `${view.count} new messages`}</span>
      {#if view.firstAt !== null && view.lastAt !== null && view.lastAt - view.firstAt >= 60_000}<span class="chip">over {spanLabel(view.lastAt - view.firstAt)}</span>{/if}
      {#if view.files}<span class="chip">{view.files === 1 ? "1 file" : `${view.files} files`}</span>{/if}
    </div>
    {#if view.tools}
      <p class="tools"><Wrench size={14} />Used {view.tools === 1 ? "1 tool" : `${view.tools} tools`}{#if view.toolNames.length}: {view.toolNames.join(", ")}{/if}</p>
    {/if}
    <div class="new" aria-hidden="true">NEW</div>
    <ul class="msgs" aria-label="New messages from {name}">
      {#if view.count > view.messages.length}<li class="note">{view.count - view.messages.length} earlier new messages are in the conversation.</li>{/if}
      {#each shown as m (m.id)}
        {#if m.kind === "activity"}
          <!-- Not listed on a card (counted above); kept for a hub older than this rule. -->
        {:else}
          <li class="msg" data-msg={m.id}>
            <span class="avatar sm" class:quiet={m.author.kind !== "principal"} aria-hidden="true">{(m.author.kind === "principal" ? "You" : m.author.name).slice(0, 1).toUpperCase()}</span>
            <div>
              <button class="open" onclick={() => onOpen(m.id)} aria-label="Open this message from {m.author.kind === 'principal' ? 'you' : m.author.name} in the conversation">
                <b>{m.author.kind === "principal" ? "You" : m.author.name}</b><time>{clock(m.at)}</time>
              </button>
              {#if m.text}<div class="text md">{@html renderMarkdown(m.author.kind === "principal" ? withoutFileNotes(m.text) : m.text)}</div>{/if}
              {#each m.attachments ?? [] as a, i (`${a.id ?? a.name}-${i}`)}
                {#if a.id}
                  <a class="file" href="/api/files/{a.id}" target="_blank" rel="noopener">
                    {#if a.kind === "image"}<img src="/api/files/{a.id}" alt={a.caption ?? a.name} loading="lazy" />{:else}<i><FileIcon size={16} /></i>{/if}
                    <span>{a.name}<small>{a.caption ?? a.mime}</small></span>
                  </a>
                {:else if a.pending}
                  <span class="file gone"><i><FileIcon size={16} /></i><span>{a.name}<small>Copying…</small></span></span>
                {:else}
                  <span class="file gone"><i><FileIcon size={16} /></i><span>{a.name}<small>Not available</small></span></span>
                {/if}
              {/each}
            </div>
          </li>
        {/if}
      {/each}
      {#each outgoing as o (o.id)}
        {@const label = sendLabel(o, outgoing, now)}
        {@const stuck = o.state === "failed" || o.state === "uncertain"}
        <li class="msg mine" data-outgoing={o.state}>
          <span class="avatar sm" aria-hidden="true">Y</span>
          <div>
            <p class="who-line"><b>You</b><time>{label}</time></p>
            <p class="text">{o.text}</p>
            <!-- The desktop's words and actions (outbox/words.ts; review of PR #7, finding 12). -->
            {#if stuck}<p class="err">{sendReason(o, name, "its screen in Agents")}</p>{/if}
            {#if deliveryNote(o)}<p class="note" data-delivery={o.delivery?.state}>{deliveryNote(o)}</p>{/if}
            {#if stuck || o.state === "queued" || o.state === "sending" || (o.state === "sent" && label !== "Sent")}
              <div class="row">
                {#if o.state === "failed" && o.error === "step_up"}<button class="pbtn small" onclick={() => onVerify(o.id)}>Confirm with passkey</button>
                {:else if o.state === "failed" && o.error === "stale"}<button class="pbtn small" onclick={() => { text = text.trim() ? `${text}\n\n${o.text}` : o.text; onDiscard(o.id); }}>Edit</button>
                {:else if canRetry(o, now)}<button class="pbtn small" onclick={() => onRetry(o.id)}>{o.state === "uncertain" ? "Check again" : "Retry"}</button>
                {:else if canCancel(o)}<button class="pbtn small" onclick={() => onCancel(o.id)}>Cancel</button>{/if}
                <button class="pbtn small" onclick={() => onDiscard(o.id)}>{o.state === "sent" ? "Dismiss" : "Discard"}</button>
              </div>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="note">{loading ? "Loading the new messages…" : "The messages haven't loaded: you're offline. They come when the hub is back."}</p>
  {/if}
  {#if note}<p class="err" role="alert">{note}</p>{/if}
</div>

<form class="composer" onsubmit={e => { e.preventDefault(); void send(); }}>
  <label class="sr" for="reply">Message {name}</label>
  <textarea id="reply" bind:value={text} rows="1" placeholder="Message {name}" enterkeyhint="send"
    onkeydown={e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); } }}></textarea>
  <button class="send" type="submit" disabled={!text.trim() || busy} aria-label="Send to {name}"><SendHorizontal size={18} /></button>
</form>

<style>
  .card-head { padding: 16px 20px 13px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 10px; }
  .who { flex: 1; min-width: 0; }
  .who b { display: block; font: 700 15px/20px var(--body); }
  .who span { display: block; font: 400 13px/18px var(--body); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* pan-y here too: touch-action stops at the nearest scroll container (review of PR #7, finding 3). */
  .card-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 16px 20px 12px; touch-action: pan-y; }
  .headline { font: 600 23px/28px var(--display); letter-spacing: -0.01em; margin: 4px 0 6px; overflow-wrap: anywhere; }
  .facts { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 0; }
  .new { display: flex; align-items: center; gap: 10px; margin: 16px 0 10px; font: 700 11px/1 var(--body); letter-spacing: 0.09em; color: var(--bad-text); }
  .new::before { content: ""; flex: 1; height: 1px; background: var(--bad); }
  .msgs { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
  .msg { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 10px; }
  .open, .who-line { display: flex; align-items: center; gap: 6px; padding: 0; margin: 0; border: 0; background: none; color: var(--fg); font: inherit; cursor: pointer; text-align: left; min-height: 22px; }
  /* A 44px target (Apple's minimum) around a 22px line: it reaches into the gaps above and below, not the layout. */
  .open { min-height: 44px; margin: -11px 0; padding-right: 24px; }
  .open b, .who-line b { font: 700 14px/20px var(--body); }
  time { font: 400 12px/20px var(--body); color: var(--muted); }
  .text { font: 400 14.5px/21px var(--body); overflow-wrap: anywhere; margin: 0; }
  .text :global(p) { margin: 0 0 6px; }
  .text :global(p:last-child) { margin: 0; }
  .text :global(pre) { white-space: pre-wrap; font: 12.5px/18px var(--mono); background: var(--fill); color: var(--fg); padding: 6px 8px; border-radius: 8px; }
  .text :global(ul), .text :global(ol) { margin: 2px 0 6px; padding-left: 20px; }
  .text :global(table) { border-collapse: collapse; font-size: 13px; }
  .text :global(td), .text :global(th) { border: 1px solid var(--line); padding: 2px 6px; }
  .tools { display: flex; align-items: center; gap: 8px; margin: 10px 0 0; font: 400 13px/18px var(--body); color: var(--muted); }
  .file { display: flex; align-items: center; gap: 10px; margin-top: 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 12px; color: var(--fg); text-decoration: none; font: 700 13px/18px var(--body); min-height: 44px; }
  .file span { display: grid; min-width: 0; overflow-wrap: anywhere; }
  .file small { color: var(--muted); font-weight: 400; }
  .file i { width: 34px; height: 34px; border-radius: 8px; background: var(--fill); color: var(--fg); display: grid; place-items: center; flex: none; }
  .file img { width: 56px; height: 40px; object-fit: cover; border-radius: 6px; flex: none; }
  .mine .text { white-space: pre-wrap; }
  .row { display: flex; gap: 8px; margin-top: 6px; }
  .composer { flex: none; display: flex; align-items: flex-end; gap: 8px; margin: 0 12px 12px; padding: 4px 4px 4px 14px; box-sizing: border-box; border: 1px solid var(--edge); border-radius: 23px; background: var(--surface); }
  textarea { flex: 1; min-height: 34px; max-height: 120px; padding: 6px 0; border: 0; background: transparent; color: var(--fg); font: 400 16px/22px var(--body); resize: none; outline: 0; }
  textarea::placeholder { color: var(--morndo-placeholder); }
  .composer:focus-within { outline: var(--morndo-focus-ring); outline-offset: 1px; }
  .send { width: 44px; height: 44px; min-height: 44px; flex: none; border-radius: 50%; border: 0; display: grid; place-items: center; background: var(--ink); color: var(--ink-fg); cursor: pointer; }
  .send:disabled { background: var(--fill); color: var(--fg); cursor: default; }
</style>
