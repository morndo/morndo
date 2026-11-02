<script lang="ts">
  // Agent CLI accounts on one node: list from the hub, sign in or add from the app (ADR-0039).
  import { onMount } from "svelte";
  import type { SignInRuntime } from "@morndo/domain";
  import type { AccountRow } from "@morndo/protocol";
  import { ApiError, explain } from "../api.ts";
  import SignInSheet from "./SignInSheet.svelte";
  import { signinApi, type SignInTarget } from "./api.ts";
  import { accountStateWords, badAccountName } from "./words.ts";

  let nodes = $state<string[]>([]);
  let node = $state("");
  let claude = $state<AccountRow[]>([]);
  let cursor = $state<AccountRow[]>([]);
  let loadProblem = $state("");
  let newName = $state("");
  let nameProblem = $state("");
  let sheetTarget = $state<SignInTarget | null>(null);
  let sheetOpen = $state(false);

  async function loadNodes() {
    loadProblem = "";
    try {
      const v = await signinApi.nodes();
      nodes = v.nodes;
      if (v.nodes.length && !v.nodes.includes(node)) node = v.nodes[0] ?? "";
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) loadProblem = "Sign-in from the app is not on this hub yet.";
      else loadProblem = explain(e);
      nodes = [];
    }
  }

  async function loadAccounts() {
    if (!node) { claude = []; cursor = []; return; }
    loadProblem = "";
    try {
      const [c, u] = await Promise.all([
        signinApi.accounts(node, "claude"),
        signinApi.accounts(node, "cursor"),
      ]);
      claude = c.accounts;
      cursor = u.accounts;
    } catch (e) {
      loadProblem = explain(e);
      claude = []; cursor = [];
    }
  }

  async function refreshAll() {
    await loadNodes();
    await loadAccounts();
  }

  onMount(() => { void refreshAll(); });

  $effect(() => {
    void node;
    void loadAccounts();
  });

  function openSheet(target: SignInTarget) {
    sheetTarget = target;
    sheetOpen = true;
  }

  function signIn(runtime: SignInRuntime, account: string) {
    if (!node) return;
    openSheet({ node, runtime, account, create: false });
  }

  function addAccount() {
    nameProblem = "";
    const name = newName.trim();
    const bad = badAccountName(name);
    if (bad) { nameProblem = bad; return; }
    if (!node) return;
    newName = "";
    openSheet({ node, runtime: "claude", account: name, create: true });
  }

  function onSheetClosed() {
    sheetOpen = false;
    sheetTarget = null;
    void loadAccounts();
  }

  const runtimeLabel = (r: SignInRuntime) => (r === "claude" ? "Claude" : "Cursor");
</script>

<section class="accounts" id="accounts" aria-label="Accounts">
  <h2 class="kicker">Accounts</h2>
  {#if loadProblem}<p class="err" role="alert">{loadProblem}</p>{/if}
  {#if nodes.length}
    <label for="signin-node">Node</label>
    <select id="signin-node" bind:value={node}>
      {#each nodes as n (n)}<option value={n}>{n}</option>{/each}
    </select>
  {:else if !loadProblem}
    <p class="note">No node is connected to this hub, so there is no account to sign in yet.</p>
  {/if}

  {#if node}
    <div class="group">
      <h3>Claude</h3>
      <ul>
        {#each claude as row (row.name)}
          <li>
            <span class="name">{row.name}</span>
            <span class="state">{accountStateWords(row)}{#if row.plan && row.signedIn === "ok"} · {row.plan}{/if}</span>
            <button type="button" aria-label="Sign in claude {row.name}" onclick={() => signIn("claude", row.name)}>Sign in</button>
          </li>
        {/each}
      </ul>
    </div>
    <div class="group">
      <h3>Cursor</h3>
      <ul>
        {#each cursor as row (row.name)}
          <li>
            <span class="name">{row.name}</span>
            <span class="state">{accountStateWords(row)}{#if row.plan && row.signedIn === "ok"} · {row.plan}{/if}</span>
            <button type="button" aria-label="Sign in cursor {row.name}" onclick={() => signIn("cursor", row.name)}>Sign in</button>
          </li>
        {/each}
      </ul>
    </div>
    <div class="add">
      <label for="signin-new-name">New account name</label>
      <div class="row">
        <input id="signin-new-name" bind:value={newName} autocomplete="off" spellcheck={false} autocapitalize="off" />
        <button type="button" class="pbtn" onclick={addAccount}>Add account</button>
      </div>
      {#if nameProblem}<p class="err" role="alert">{nameProblem}</p>{/if}
    </div>
  {/if}
</section>

<SignInSheet target={sheetTarget} bind:open={sheetOpen} onClosed={onSheetClosed} />

<style>
  .accounts { display: grid; gap: 10px; margin-top: 8px; }
  .kicker { margin: 12px 0 0; font: 700 19px/24px var(--display, system-ui); }
  .group h3 { margin: 8px 0 4px; font: 700 15px/20px var(--body, system-ui); }
  ul { list-style: none; margin: 0; padding: 0; border-radius: 14px; background: var(--surface, #f5f5f5); overflow: hidden; }
  li {
    display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; align-items: center;
    padding: 10px 14px; border-bottom: 1px solid var(--line, #ddd); font: 400 14px/20px var(--body, system-ui);
  }
  li:last-child { border-bottom: 0; }
  .name { font-weight: 700; }
  .state { color: var(--muted, #666); text-align: right; }
  .add { display: grid; gap: 6px; margin-top: 8px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .row input { flex: 1; min-width: 8rem; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--edge, #ccc); }
  .err { margin: 0; color: var(--bad-fg, #b00020); font: 400 14px/20px var(--body, system-ui); }
  label { font: 700 13px/18px var(--body, system-ui); }
  select { max-width: 100%; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--edge, #ccc); }
</style>
