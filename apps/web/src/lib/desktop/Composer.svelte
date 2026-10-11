<script lang="ts">
  // Slack's composer: 20px side padding, a box with an 8px radius and 1px border: 38px top bar, the input (15px/22px),
  // a 40px bottom bar with the send button at the right, and a 24px line under it for "… is working".
  // For agents: quick replies in the top bar, and the passkey freshness (AC7) instead of formatting buttons. Images can
  // be pasted, dropped or attached (S1–S3): each is uploaded at once, shown as a thumbnail, and sent with the message as
  // a file on the office's machine that the agent opens and looks at.
  import SendHorizontal from "@lucide/svelte/icons/send-horizontal";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import X from "@lucide/svelte/icons/x";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import { onDestroy, untrack } from "svelte";
  import { UPLOAD_ACCEPT } from "@morndo/domain";
  import { beginAttachments, fileSize, fileType, settleAttachment, type AttachmentRow, type SentFile } from "../attach.ts";
  import { explain, uploadFile } from "../api.ts";
  import { stepUp as verify } from "../stepup.ts";
  import { deviceDrafts } from "../drafts.ts";

  let { target, targetName, conversation = target, working, waitingOn, verifiedAt, stepUpMs, onQueue, onVerified, onSecurity, edit = null, onEdited = () => {}, inputEl = $bindable(null) }: {
    target: string; targetName: string; working: boolean; waitingOn: string | null; verifiedAt: number | null; stepUpMs: number | null; onSecurity: () => void;
    conversation?: string;                                       // the worker's name: its draft comes back only with it
    edit?: { text: string; n: number } | null;                   // "Edit" on a send whose question changed: its text comes back here
    onEdited?: () => void;
    onQueue: (c: { target: string; targetName: string; text: string; uploads: string[]; images: string[]; files: SentFile[]; seen: string; held?: string }) => Promise<void>;
    onVerified: (at: number) => void; inputEl?: HTMLTextAreaElement | null;
  } = $props();

  // The draft of this conversation, on this device (phase D): back when it opens, saved 300 ms after the last keystroke,
  // with what the worker waited for when it was started (S6, review H1).
  const drafts = deviceDrafts();
  const restored = untrack(() => drafts.get(target, conversation));
  let text = $state(restored?.text ?? "");
  // What the worker waited for when this message was started (S6, review H1): taken when the box goes from empty to
  // something, kept while it is written (and with its draft), forgotten when it is emptied. Not what shows at Enter: the
  // question it answers may have changed while it was written, and the hub must then refuse it.
  let seen = $state<string | null>(restored?.seen ?? null);
  $effect(() => { drafts.typed(target, conversation, text, seen); });
  let shots = $state<AttachmentRow[]>([]);
  let dragging = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);
  const uploading = $derived(shots.some(s => s.status === "uploading"));
  const readyIds = $derived(shots.filter(s => s.status === "ready" && s.id).map(s => s.id as string));
  const canSend = $derived((text.trim().length > 0 || readyIds.length > 0) && !uploading && !shots.some(s => s.status === "error"));

  function addFiles(files: File[]) {
    const started = beginAttachments(shots.length, files);
    note = started.note;
    for (const { file, row } of started.taken) {
      shots.push(row);
      void settleAttachment(shots.find(s => s.key === row.key) ?? row, file, uploadFile);
    }
  }
  function removeShot(key: string) {
    const s = shots.find(x => x.key === key);
    if (s?.preview) URL.revokeObjectURL(s.preview);
    shots = shots.filter(x => x.key !== key);
  }
  function onPaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    if (!e.clipboardData?.getData("text/plain")) e.preventDefault();   // a file alone: nothing to paste as text
    void addFiles(files);
  }
  function onDrop(e: DragEvent) {
    dragging = false;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  }
  let verifying = $state(false);                 // a passkey check before queueing is open
  let note = $state<string | null>(null);
  let now = $state(Date.now());
  // stepUpMs null: the principal chose "only when I sign in", so the sign-in's check is enough.
  // A device added from another has never verified for Commands (verifiedAt 0, AC12): not fresh, whatever the policy.
  const verified = $derived(verifiedAt !== null && verifiedAt > 0);
  const fresh = $derived(verified && (stepUpMs === null || now - (verifiedAt ?? 0) < stepUpMs));
  const leftMin = $derived(stepUpMs === null || verifiedAt === null ? 0 : Math.max(0, Math.ceil((stepUpMs - (now - verifiedAt)) / 60_000)));
  const left = $derived(leftMin > 90 ? `${Math.round(leftMin / 60)} h` : `${leftMin} min`);
  const QUICK = ["Yes", "No", "Continue", "Status?"];

  $effect(() => { const t = setInterval(() => (now = Date.now()), 15_000); return () => clearInterval(t); });
  $effect(() => { void target; note = null; });
  // Edit puts the text back once (review M4), after what is already in the box rather than over it.
  $effect(() => {
    const e = edit;
    if (!e) return;
    untrack(() => {
      text = text.trim() ? `${text}\n\n${e.text}` : e.text;
      seen = waitingOn ?? "none";                                      // read again now: it is written for what shows now
    });
    onEdited();
    untrack(() => inputEl?.focus());
  });
  $effect(() => {
    const started = text.trim().length > 0 || shots.length > 0;
    if (started && seen === null) seen = waitingOn ?? "none";
    else if (!started) seen = null;
  });

  async function stepUp() { onVerified(await verify()); }

  // Another conversation was opened while the passkey check was open: this composer is gone (F15's {#key}).
  let destroyed = false;
  onDestroy(() => { destroyed = true; });

  // Enter queues the message in the outbox (ADR-0008 phase C, S4) and the box is free at once: the outbox sends it,
  // retries it and shows in the conversation how it went. It carries what the worker waited for when it was written
  // (S6), and goes to the conversation it was written in. Only a due passkey check comes first (AC7); offline there is
  // none to make, and the hub's "verify" then shows on the message itself.
  async function send() {
    const body = text.trim();
    if (!canSend || verifying) return;
    // The worker's own name (its conversation), not the one shown ("Manager"): the hub checks it against the pane (M2).
    const to = target, toName = conversation, written = seen ?? waitingOn ?? "none";
    const uploads = readyIds;
    const images = shots.filter(s => s.status === "ready" && s.kind === "image" && s.preview).map(s => s.preview);
    const files = shots.filter(s => s.status === "ready" && s.kind !== "image").map((s): SentFile => ({ name: s.name, kind: s.kind, size: s.size }));
    note = null;
    let held: "step_up" | undefined;
    if (!fresh && navigator.onLine !== false) {
      verifying = true;
      try { await stepUp(); }
      catch (e) {
        // Cancelled here: the draft stays. Cancelled after this conversation was left: it is written down unsent, as
        // "Not sent: verify" in its own conversation, and nothing goes out (R2: never lost, never in another one).
        if (!destroyed) { note = explain(e); verifying = false; return; }
        held = "step_up";
      }
      verifying = false;
    }
    // The box is free at once (a second Enter must not send the same text twice); if the message couldn't be written
    // down on this device, it comes back into the box, never lost (review M6).
    const sentShots = shots;
    drafts.sent(target);                                               // a save still pending can't bring it back
    if (!destroyed) { text = ""; shots = []; inputEl?.focus(); }
    try { await onQueue({ target: to, targetName: toName, text: body, uploads, images, files, seen: written, ...(held ? { held } : {}) }); }
    catch (e) {
      if (destroyed) return;
      text = text.trim() ? `${body}\n\n${text}` : body;
      if (!shots.length) shots = sentShots;
      note = `Couldn't keep the message on this device: ${explain(e)} It is back in the box.`;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); }
  }
  function grow() {
    if (!inputEl) return;
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 320)}px`;
  }
  $effect(() => { void text; grow(); });
</script>

<div class="wrap">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="box" class:busy={verifying} class:dragging
    ondragover={e => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); dragging = true; } }}
    ondragleave={() => (dragging = false)} ondrop={onDrop}>
    <div class="bar">
      {#each QUICK as q}
        <button class="chip" onclick={() => { text = text ? `${text} ${q}` : q; inputEl?.focus(); }}>{q}</button>
      {/each}
      <span class="scope">{targetName === "Manager" ? "Goes to the manager" : `Goes straight to ${targetName}; the manager won't see it`}</span>
    </div>
    {#if shots.length}
      <div class="shots" aria-label="Files to send">
        {#each shots as s (s.key)}
          {#if s.kind === "image"}
            <div class="shot {s.status}" title={s.error ?? s.name}>
              <img src={s.preview} alt="" />
              {#if s.status === "uploading"}<span class="spin" aria-label="Uploading"></span>{/if}
              <button class="rm" onclick={() => removeShot(s.key)} aria-label="Remove {s.name}"><X size={12} /></button>
            </div>
          {:else}
            <div class="filechip {s.status}" title={s.error ?? s.name}>
              <span class="fn">{s.name}</span>
              <small>{fileType(s.name, s.kind)} · {fileSize(s.size)}</small>
              {#if s.status === "uploading"}<span class="spin" aria-label="Uploading"></span>{/if}
              <button class="rm" onclick={() => removeShot(s.key)} aria-label="Remove {s.name}"><X size={12} /></button>
            </div>
          {/if}
        {/each}
      </div>
      {#each shots.filter(s => s.error) as s (s.key)}<p class="shot-err">{s.error}</p>{/each}
    {/if}
    <textarea
      id="composer"
      bind:this={inputEl}
      bind:value={text}
      rows="1"
      placeholder="Message {targetName === 'Manager' ? 'Manager' : `#${targetName}`}"
      onkeydown={onKey}
      onpaste={onPaste}
      aria-label="Message {targetName}"
    ></textarea>
    <div class="tools">
      <button class="attach" onclick={() => fileInput?.click()} aria-label="Attach a file" title="Attach a file (or paste or drop one)"><Paperclip size={16} /></button>
      <input bind:this={fileInput} type="file" accept={UPLOAD_ACCEPT} multiple hidden
        onchange={e => { addFiles([...((e.currentTarget as HTMLInputElement).files ?? [])]); (e.currentTarget as HTMLInputElement).value = ""; }} />
      <button class="verify" class:fresh onclick={onSecurity} title="Change how often sending asks for your passkey">
        {#if fresh && stepUpMs === null}<ShieldCheck size={16} /> Signed in with your passkey
        {:else if fresh}<ShieldCheck size={16} /> Verified · {left} left
        {:else}<ShieldAlert size={16} /> Face ID or Touch ID on send{/if}
      </button>
      <button class="send" class:ready={canSend} disabled={!canSend || verifying} onclick={send} aria-label="Send">
        <SendHorizontal size={16} />
      </button>
    </div>
  </div>
  <div class="typing">
    {#if note}<span class="err">{note}</span>{:else if working}<span><b>{targetName}</b> is working…</span>{/if}
  </div>
</div>

<style>
  .wrap { padding: 0 20px; flex: none; }
  .box { border: 1px solid var(--border); border-radius: 8px; background: var(--main-bg); overflow: hidden; }
  .box:focus-within { border-color: var(--border-strong); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); }
  .bar { display: flex; align-items: center; gap: 4px; height: 38px; padding: 0 6px; background: var(--composer-bar); }
  .chip {
    height: 26px; padding: 0 10px; border-radius: 13px; border: 1px solid var(--border); background: var(--main-bg); color: var(--text);
    font: 700 12px/1 var(--font); cursor: pointer;
  }
  .chip:hover { border-color: var(--border-strong); }
  .scope { margin-left: auto; padding-right: 6px; font: 400 12px/1 var(--font); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  textarea {
    display: block; width: 100%; min-height: 38px; max-height: 320px; padding: 8px 12px; border: 0; outline: 0; resize: none;
    background: transparent; color: var(--text); font: 400 15px/22px var(--font);
  }
  textarea::placeholder { color: var(--muted); }
  .tools { display: flex; align-items: center; height: 40px; padding: 0 6px 0 8px; }
  .verify { display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px; margin-left: -6px; border: 0; border-radius: 4px; background: transparent; font: 400 12px/1 var(--font); color: var(--muted); cursor: pointer; }
  .verify:hover { background: var(--hover); color: var(--text); }
  .verify.fresh { color: var(--ok-fg); }
  /* Status text keeps its colour under the pointer on its own subtle: success text on the hover tint misses Lc 75 in light. */
  .verify.fresh:hover { background: var(--ok-bg); }
  .send {
    margin-left: auto; width: 32px; height: 28px; border: 0; border-radius: 4px; display: grid; place-items: center;
    background: transparent; color: var(--muted); cursor: pointer;
  }
  .send.ready { background: var(--send); color: var(--send-fg); }
  .send.ready:hover:not(:disabled) { background: var(--send-hover); }
  .send:disabled { cursor: default; }
  .busy { opacity: 0.85; }
  .dragging { border-color: var(--link); box-shadow: 0 0 0 2px color-mix(in srgb, var(--link) 30%, transparent); }
  .shots { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 12px 0; }
  .shot { position: relative; width: 64px; height: 64px; border-radius: 8px; overflow: hidden; border: 1px solid var(--border); background: var(--code-bg); }
  .shot img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .shot.uploading img { opacity: 0.5; }
  .shot.error { border-color: var(--bad-fg); }
  .shot .rm { position: absolute; top: 3px; right: 3px; width: 20px; height: 20px; min-height: 20px; padding: 0; border: 0; border-radius: 50%; background: rgba(0, 0, 0, 0.6); color: #fff; display: grid; place-items: center; cursor: pointer; }
  .shot .spin { position: absolute; inset: 0; margin: auto; width: 18px; height: 18px; border-radius: 50%; border: 2px solid rgba(255, 255, 255, 0.5); border-top-color: #fff; animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .filechip {
    display: flex; align-items: center; gap: 8px; max-width: 280px; height: 36px; padding: 0 8px 0 10px;
    border: 1px solid var(--border); border-radius: 8px; background: var(--main-bg); min-width: 0;
  }
  .filechip .fn { font: 700 13px/18px var(--font); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .filechip small { flex: none; font: 400 12px/16px var(--font); color: var(--muted); }
  .filechip.error { border-color: var(--bad-fg); }
  .filechip .rm { position: static; width: 20px; height: 20px; flex: none; }
  .shot-err { margin: 4px 12px 0; font: 400 12px/16px var(--font); color: var(--bad-fg); }
  .attach { width: 28px; height: 28px; min-height: 28px; margin-right: 4px; border: 0; border-radius: 4px; background: transparent; color: var(--muted); display: grid; place-items: center; cursor: pointer; }
  .attach:hover { background: var(--hover); color: var(--text); }
  .typing { height: 24px; display: flex; align-items: center; font: 400 12px/1 var(--font); color: var(--muted); padding: 0 2px; }
  .typing b { font-weight: 700; color: var(--text); }
  .err { color: var(--bad-fg); }
</style>
