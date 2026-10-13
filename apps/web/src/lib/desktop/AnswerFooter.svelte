<script lang="ts">
  // The answer the card and the brief both show: confirm, words, and an answer in doubt. One set of labels.
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import { againLabel } from "../catchup/answer.ts";
  import type { AnswerSession } from "./answer-session.svelte.ts";
  import type { AnswerBody } from "./answer-session.ts";

  let { session, open, verifiedFresh, asker, focusSend = false, escapeBack = false, onSend, onAfterBack }: {
    session: AnswerSession; open: boolean; verifiedFresh: boolean; asker: string;
    focusSend?: boolean; escapeBack?: boolean;
    onSend: (body: AnswerBody, requestId?: string) => void;
    onAfterBack?: () => void;
  } = $props();

  let wordsEl = $state<HTMLTextAreaElement | null>(null);
  const whom = $derived(asker[0] ? asker[0].toUpperCase() + asker.slice(1) : asker);
  const maybeFocus = (node: HTMLElement, on: boolean) => { if (on) node.focus(); };

  function back() { session.back(); onAfterBack?.(); }
  function onEsc(e: KeyboardEvent) { if (escapeBack && e.key === "Escape") { e.preventDefault(); back(); } }
  function sendAgain() { if (session.again) onSend(session.again.body, session.again.requestId); }
  function onWordsKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (session.again) sendAgain(); else if (session.words.trim()) onSend({ text: session.words }); }
    if (e.key === "Escape") { e.preventDefault(); back(); }
  }
  $effect(() => { if (session.mode === "words") wordsEl?.focus(); });
</script>

<div class="answer">
  {#if session.mode === "confirm" && session.picked}
    <div class="confirm" role="group" aria-label="Confirm your answer">
      <p class="your">Your answer: <b>{session.picked.label}</b></p>
      <p class="how">{whom} gets it as your decision and acts on it.</p>
      <div class="actions">
        {#if session.again}
          <button type="button" class="btn primary" disabled={session.sending || !open} use:maybeFocus={focusSend} onkeydown={onEsc} onclick={sendAgain}>{session.sending ? "Checking…" : againLabel(session.again.code)}</button>
        {:else}
          <button type="button" class="btn primary" disabled={session.sending || !open || session.stale} use:maybeFocus={focusSend} onkeydown={onEsc} onclick={() => session.picked && onSend(session.picked.body)}>{session.sending ? "Sending…" : "Send answer"}</button>
        {/if}
        <button type="button" class="btn ghost" disabled={session.sending} onkeydown={onEsc} onclick={back}>Back</button>
        {#if !verifiedFresh}<span class="shield"><ShieldAlert size={14} />Face ID or Touch ID first</span>{/if}
      </div>
    </div>
  {:else if session.mode === "words"}
    <div class="confirm" role="group" aria-label="Answer in words">
      <textarea bind:this={wordsEl} value={session.words} rows="2" readonly={!!session.again} placeholder="Your answer for {asker}…" onkeydown={onWordsKey} oninput={(e) => (session.words = e.currentTarget.value)} aria-label="Your answer for {asker}"></textarea>
      <div class="actions">
        {#if session.again}
          <button type="button" class="btn primary" disabled={session.sending || !open} use:maybeFocus={focusSend} onclick={sendAgain}>{session.sending ? "Checking…" : againLabel(session.again.code)}</button>
        {:else}
          <button type="button" class="btn primary" disabled={session.sending || !open || session.stale || !session.words.trim()} onclick={() => onSend({ text: session.words })}>{session.sending ? "Sending…" : `Send to ${asker}`}</button>
        {/if}
        <button type="button" class="btn ghost" disabled={session.sending} onclick={back}>Back</button>
        {#if !verifiedFresh}<span class="shield"><ShieldAlert size={14} />Face ID or Touch ID first</span>{:else}<span class="hint">Enter sends · Shift+Enter for a new line</span>{/if}
      </div>
    </div>
  {:else if session.again}
    <div class="actions">
      <button type="button" class="btn primary" disabled={session.sending || !open} use:maybeFocus={focusSend} onclick={sendAgain}>{session.sending ? "Checking…" : againLabel(session.again.code)}</button>
    </div>
  {/if}
</div>

<style>
  .answer { position: relative; z-index: 1; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .btn {
    display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 5px 14px; border-radius: 6px; max-width: 100%;
    border: 1px solid var(--outline, var(--border)); background: var(--main-bg); color: var(--text); font: 700 14px/20px var(--font, sans-serif);
    cursor: pointer; text-align: left;
  }
  .btn:hover:not(:disabled) { background: var(--row-hover); border-color: var(--border-strong); }
  .btn.primary { background: var(--send); border-color: var(--send); color: var(--send-fg); }
  .btn.primary:hover:not(:disabled) { background: var(--send-hover); border-color: transparent; }
  .btn:disabled { opacity: 0.45; cursor: default; }
  .btn.ghost { border-color: transparent; background: transparent; }
  .btn.ghost:hover:not(:disabled) { background: var(--hover); }
  .confirm { display: grid; gap: 8px; padding: 10px 12px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--send) 45%, transparent); background: color-mix(in srgb, var(--send) 7%, var(--main-bg)); }
  .your { margin: 0; font: 400 15px/22px var(--font, sans-serif); }
  .how, .hint, .shield { margin: 0; font: 400 13px/18px var(--font, sans-serif); color: var(--muted); }
  .how { margin-top: -6px; }
  .shield, .hint { display: inline-flex; align-items: center; gap: 5px; }
  .shield { margin-left: auto; }
  textarea {
    width: 100%; min-height: 60px; resize: vertical; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border-strong, var(--border));
    background: var(--main-bg); color: var(--text); font: 400 15px/22px var(--font, sans-serif); outline: 0;
  }
  textarea:focus { border-color: var(--link); box-shadow: 0 0 0 1px var(--link); }
</style>
