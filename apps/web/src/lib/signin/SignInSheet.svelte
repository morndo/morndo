<script lang="ts">
  // One CLI account sign-in from the app (ADR-0039): start with a passkey check, open the CLI's link, seal any one-time
  // code to this sign-in's recipient before POST, poll until done or failed. The plain code never leaves sealing.
  import { onDestroy } from "svelte";
  import type { SignInView } from "@morndo/protocol";
  import { ApiError, explain } from "$lib/api.ts";
  import { withStepUp } from "$lib/stepup.ts";
  import { signinApi, type SignInTarget } from "./api.ts";
  import { sealCode } from "./seal.ts";
  import { problemWords, sheetTitle } from "./words.ts";

  let { target, open = $bindable(false), onClosed }: {
    target: SignInTarget | null; open?: boolean; onClosed?: () => void;
  } = $props();

  let view = $state<SignInView | null>(null);
  let problem = $state("");
  let folderExists = $state(false);
  let starting = $state(false);
  let sendingCode = $state(false);
  let codeDraft = $state("");
  let poll: ReturnType<typeof setInterval> | null = null;

  const live = $derived(view !== null && (view.phase === "waiting" || view.phase === "checking"));
  const title = $derived(target ? sheetTitle(target.node, target.runtime, target.account, target.create) : "Sign in");
  const done = $derived(view?.phase === "done");
  const failed = $derived(view !== null && (view.phase === "failed" || view.phase === "expired"));

  function stopPoll() {
    if (poll !== null) { clearInterval(poll); poll = null; }
  }

  function reset() {
    stopPoll();
    view = null;
    problem = "";
    folderExists = false;
    codeDraft = "";
    starting = false;
    sendingCode = false;
  }

  $effect(() => {
    if (!open) reset();
  });

  $effect(() => {
    if (!open || !view || !live) { stopPoll(); return; }
    stopPoll();
    poll = setInterval(() => { void refresh(); }, 1500);
    return () => stopPoll();
  });

  onDestroy(() => stopPoll());

  async function refresh() {
    if (!view) return;
    try {
      view = await signinApi.view(view.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) problem = "This sign-in is no longer on the hub.";
      else problem = explain(e);
      stopPoll();
    }
  }

  async function start(create?: boolean) {
    if (!target || starting) return;
    starting = true; problem = ""; folderExists = false;
    const body = { node: target.node, runtime: target.runtime, account: target.account, create: create ?? target.create };
    const run = () => signinApi.start(body);
    try {
      view = await withStepUp(run, () => {});
    } catch (e) {
      if (e instanceof ApiError && e.code === "exists") { folderExists = true; return; }
      problem = explain(e);
    } finally {
      starting = false;
    }
  }

  function signExistingIn() { void start(false); }

  async function sendCode() {
    if (!view?.recipient || sendingCode) return;
    const plain = codeDraft;
    codeDraft = "";
    sendingCode = true; problem = "";
    try {
      const sealed = await sealCode(view.recipient, plain);
      const run = () => signinApi.code(view!.id, sealed);
      view = await withStepUp(run, () => {});
    } catch (e) {
      problem = explain(e);
    } finally {
      sendingCode = false;
    }
  }

  async function cancelLive() {
    if (!view || !live) return;
    problem = "";
    try { view = await signinApi.cancel(view.id); }
    catch (e) { problem = explain(e); }
    stopPoll();
  }

  function close() {
    open = false;
    onClosed?.();
  }

  function tryAgain() {
    reset();
    void start();
  }
</script>

{#if open && target}
  <div class="backdrop" role="presentation" onclick={e => { if (e.target === e.currentTarget) close(); }}>
    <div class="dialog" role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2></header>

      {#if !view}
        <p class="note">The node runs this account's own CLI sign-in. You open its page and approve there.</p>
        {#if folderExists}
          <p class="note" role="status">This account's folder already exists on the node.</p>
          <button class="btn primary" disabled={starting} onclick={signExistingIn}>{starting ? "Starting…" : "Sign it in"}</button>
        {:else}
          <button class="btn primary" disabled={starting} onclick={() => void start()}>{starting ? "Starting…" : "Start sign-in"}</button>
        {/if}
      {:else if done && view.identity}
        <p class="ok" role="status"><b>Works again</b></p>
        <p class="ok" role="status">signed in as {view.identity.email}{view.identity.plan ? ` (${view.identity.plan})` : ""}</p>
      {:else if failed}
        <p class="err" role="alert">{problemWords(view.problem, view.phase)}</p>
        <button class="btn primary" onclick={tryAgain}>Try again</button>
      {:else if view.phase === "cancelled"}
        <p class="note" role="status">Cancelled.</p>
      {:else}
        {#if view.link}
          <p><a href={view.link} target="_blank" rel="noopener noreferrer">Open sign-in page</a></p>
        {/if}
        {#if view.userCode}<p class="device">Device code: <code>{view.userCode}</code></p>{/if}
        {#if view.needsCode}
          <p class="note">Sign in there with the account you want for {view.account === "main" ? "the main login" : view.account}, approve, then paste the code the page shows.</p>
          <label for="signin-code">Code from the sign-in page</label>
          <input id="signin-code" bind:value={codeDraft} autocomplete="off" spellcheck={false} autocapitalize="off" />
          <button class="btn primary" disabled={!codeDraft.trim() || sendingCode || !view.recipient} onclick={() => void sendCode()}>
            {sendingCode ? "Sending…" : "Send code"}
          </button>
        {:else}
          <p class="note">Approve on the page; this finishes by itself.</p>
        {/if}
        {#if view.phase === "checking"}<p class="note" role="status">Checking…</p>{/if}
        {#if live}<button class="btn" onclick={() => void cancelLive()}>Cancel</button>{/if}
      {/if}

      {#if problem}<p class="err" role="alert">{problem}</p>{/if}

      <footer>
        <button class="btn" onclick={close}>Close</button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 16px;
    background: rgb(0 0 0 / 0.45);
  }
  .dialog {
    width: min(420px, 100%); max-height: min(90dvh, 560px); overflow: auto; display: grid; gap: 12px; padding: 16px 18px;
    border-radius: 12px; border: 1px solid var(--border, #ccc); background: var(--surface, var(--main-bg, #fff)); color: var(--fg, var(--text, #111));
    box-shadow: 0 12px 40px rgb(0 0 0 / 0.2);
  }
  header h2 { margin: 0; font: 700 17px/22px var(--font, system-ui); }
  .note { margin: 0; font: 400 14px/20px var(--font, system-ui); color: var(--muted, #666); }
  .ok { margin: 0; font: 400 15px/22px var(--font, system-ui); }
  .err { margin: 0; font: 400 14px/20px var(--font, system-ui); color: var(--bad-fg, #b00020); }
  .device { margin: 0; font: 400 14px/20px var(--font, system-ui); }
  .device code { font: 700 14px/20px var(--mono, monospace); }
  label { font: 700 13px/18px var(--font, system-ui); }
  input {
    width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--outline, #aaa);
    font: 400 15px/20px var(--font, system-ui);
  }
  .btn {
    justify-self: start; min-height: 36px; padding: 6px 14px; border-radius: 8px; border: 1px solid var(--outline, #aaa);
    background: var(--surface, var(--main-bg, #fff)); color: var(--fg, var(--text, #111)); font: 700 14px/20px var(--font, system-ui); cursor: pointer;
  }
  .btn.primary { background: var(--send, #111); border-color: var(--send, #111); color: var(--send-fg, #fff); }
  .btn:disabled { opacity: 0.5; cursor: default; }
  footer { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; border-top: 1px solid var(--border, #eee); }
  a { font: 700 14px/20px var(--font, system-ui); color: var(--link, #06c); }
</style>
