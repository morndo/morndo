<script lang="ts">
  // LLM connections (ADR-0018 §11). Words come from the protocol table. Commands go to the hub; this file decides none
  // of availability, order or a chain, and it never asks for a key.
  import { onMount } from "svelte";
  import { CONNECTION_WORDS, commandNeedsStepUp, type ConnectionsPage } from "@morndo/protocol";
  import { api, ApiError, explain } from "$lib/api.ts";
  import { withStepUp } from "$lib/stepup.ts";
  import { EXPIRY_PLACEHOLDER, expiryMillis, expiryText, isolationLine, keyAddLine, signInLine, subscriptionAddLine } from "./line.ts";
  import { moveTo, ownSaveOrder, swap } from "./order.ts";

  let view = $state<ConnectionsPage | null>(null);
  let problem = $state("");
  let mode = $state<ConnectionsPage["mode"]>("subscriptions-first");
  let order = $state<string[]>([]);
  let roles = $state<ConnectionsPage["roles"]>([]);
  let dialog = $state(false);
  let kind = $state<"subscription" | "api-key">("subscription");
  let vendorId = $state("");
  let connectionName = $state("");
  let budget = $state("20");
  let unlimited = $state(false);
  let expires = $state("");
  let isolation = $state<"none" | "rules" | "os">("rules");
  let dragged = $state(-1);

  const vendor = $derived(view?.catalog.find(item => item.id === vendorId) ?? null);
  const runtime = $derived(vendor?.runtimes[0] ?? "");
  const line = $derived(!vendor || !connectionName ? "" : kind === "subscription"
    ? subscriptionAddLine({ name: connectionName, vendor: vendor.id, runtime })
    : keyAddLine({ name: connectionName, vendor: vendor.id, runtime, budget: unlimited ? "unlimited" : budget, expires: expiryMillis(expires) }));
  const signingIn = $derived(kind === "subscription" ? signInLine(runtime) : null);

  function take(next: ConnectionsPage) {
    view = next;
    mode = next.mode;
    order = [...next.order];
    roles = next.roles.map(row => ({
      ...row, picks: [...row.picks], chain: [...row.chain], riskPicks: [...row.riskPicks],
      order: row.override === "own" ? (ownSaveOrder(row.order, row.chain) ?? []) : [...row.order],
    }));
    problem = "";
  }

  async function load() {
    try { take(await api.get<ConnectionsPage>("/api/connections")); }
    catch (e) { problem = e instanceof ApiError && e.code === "connections_off" ? "connections_off" : explain(e); }
  }

  async function send(command: "priority" | "role" | "revoke" | "narrow", path: string, body: unknown) {
    const run = () => api.post<ConnectionsPage>(path, body);
    try {
      take(commandNeedsStepUp(command) ? await withStepUp(run, () => {}) : await run());
    } catch (e) { problem = explain(e); }
  }

  function move(index: number, by: -1 | 1) {
    order = swap(order, index, by);
  }

  function moveRole(roleIndex: number, index: number, by: -1 | 1) {
    roles = roles.map((item, at) => at === roleIndex ? { ...item, order: swap(item.order, index, by) } : item);
  }

  function postRole(row: ConnectionsPage["roles"][number], override: ConnectionsPage["roles"][number]["override"], action: "save" | "reapply" | "keep-hand") {
    const next = override === "own" ? ownSaveOrder(row.order, row.chain) : row.order;
    if (override === "own" && !next) return;
    if (!view) return;
    void send("role", "/api/connections/role", { version: view.version, role: row.role, override, order: next, picks: row.picks, riskPicks: row.riskPicks, action });
  }

  function drop(index: number) {
    if (dragged < 0 || dragged === index) return;
    order = moveTo(order, dragged, index);
    dragged = -1;
  }

  function chooseKind(next: "subscription" | "api-key") {
    kind = next;
    const match = view?.catalog.find(item => item.kinds.includes(next));
    vendorId = match?.id ?? "";
    isolation = match?.isolation ?? "rules";
  }

  function openAdd() {
    dialog = true;
    connectionName = "";
    chooseKind("subscription");
  }

  onMount(() => void load());
</script>

<section class="block" aria-labelledby="connections">
  <div class="row">
    <h2 id="connections">{CONNECTION_WORDS.sections.connections}</h2>
    <button class="pbtn small primary" type="button" onclick={openAdd}>{CONNECTION_WORDS.add}</button>
    <button class="pbtn small" type="button" onclick={load}>{CONNECTION_WORDS.check}</button>
  </div>
  {#if problem === "connections_off"}
    <p>This hub has no connections home.</p>
  {:else if problem}
    <p class="err" role="alert">{problem}</p>
  {:else if !view}
    <p>…</p>
  {:else if view.connections.length === 0}
    <p>{CONNECTION_WORDS.empty}</p>
  {:else}
    <ul class="rows" aria-label={CONNECTION_WORDS.sections.connections}>
      {#each view.connections as row (row.name)}
        <li>
          <div>
            <b>{row.name}</b>
            <span>{CONNECTION_WORDS.kinds[row.kind]} · {row.vendor} · {row.runtime}</span>
          </div>
          <span class="chip">{CONNECTION_WORDS.availability[row.availability]}</span>
          {#if row.budgetPercent !== null && row.budgetLevel}
            <p class="meter">{row.budgetPercent}% {CONNECTION_WORDS.budget[row.budgetLevel]}</p>
            <meter value={row.budgetPercent} max="100" aria-valuetext="{row.budgetPercent}% {CONNECTION_WORDS.budget[row.budgetLevel]}"></meter>
          {/if}
          {#if row.expiry !== null}<p>{expiryText(row.expiry)}</p>{/if}
          {#if row.spendSource}<p>{CONNECTION_WORDS.spend[row.spendSource]}</p>{/if}
          {#if row.kind === "subscription" && (row.usageFiveHour !== null || row.usageSevenDay !== null)}
            <p>{CONNECTION_WORDS.windows.fiveHour} {row.usageFiveHour ?? 0}% · {CONNECTION_WORDS.windows.sevenDay} {row.usageSevenDay ?? 0}%</p>
          {/if}
          <button class="pbtn small" type="button" onclick={() => { if (view && confirm(`${CONNECTION_WORDS.revoke} ${row.name}?`)) void send("revoke", "/api/connections/revoke", { version: view.version, name: row.name }); }}>{CONNECTION_WORDS.revoke}</button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

{#if dialog && view}
  <section class="dialog" aria-label={CONNECTION_WORDS.add}>
    <div class="row">
      <button class="pbtn small" type="button" aria-pressed={kind === "subscription"} onclick={() => chooseKind("subscription")}>{CONNECTION_WORDS.kinds.subscription}</button>
      <button class="pbtn small" type="button" aria-pressed={kind === "api-key"} onclick={() => chooseKind("api-key")}>{CONNECTION_WORDS.kinds["api-key"]}</button>
    </div>
    <label><span>{CONNECTION_WORDS.fields.name}</span> <input bind:value={connectionName} autocomplete="off" /></label>
    <label><span>{CONNECTION_WORDS.fields.vendor}</span>
      <select bind:value={vendorId}>
        {#each view.catalog.filter(item => item.kinds.includes(kind)) as item (item.id)}
          <option value={item.id}>{item.label}</option>
        {/each}
      </select>
    </label>
    {#if vendor}
      <p>{vendor.termsSummary}</p>
      {#each vendor.termsSources as source}<p><a href={source}>{source}</a></p>{/each}
      {#if kind === "api-key"}
        <label><span>{CONNECTION_WORDS.fields.budget}</span> <input bind:value={budget} inputmode="decimal" required disabled={unlimited} /></label>
        <label class="row"><input type="checkbox" bind:checked={unlimited} /> unlimited</label>
        <label><span>{CONNECTION_WORDS.fields.expiry}</span> <input bind:value={expires} placeholder={EXPIRY_PLACEHOLDER} autocomplete="off" /></label>
        <label><span>{CONNECTION_WORDS.fields.isolation}</span>
          <select aria-label={CONNECTION_WORDS.fields.isolation} bind:value={isolation}>
            {#each Object.entries(CONNECTION_WORDS.isolation) as [id, label] (id)}
              <option value={id}>{label}</option>
            {/each}
          </select>
        </label>
      {:else if signingIn}
        <p><code>{signingIn}</code></p>
      {/if}
      {#if line}<p><code>{line}</code></p>{/if}
      {#if kind === "api-key" && connectionName}<p><code>{isolationLine(connectionName, isolation)}</code></p>{/if}
    {/if}
    <button class="pbtn small" type="button" onclick={load}>{CONNECTION_WORDS.check}</button>
    <button class="pbtn small" type="button" onclick={() => dialog = false}>{CONNECTION_WORDS.save}</button>
  </section>
{/if}

{#if view}
  <section class="block" aria-labelledby="priority">
    <h2 id="priority">{CONNECTION_WORDS.sections.priority}</h2>
    <select aria-label={CONNECTION_WORDS.sections.priority} bind:value={mode}>
      {#each Object.entries(CONNECTION_WORDS.modes) as [id, label] (id)}
        <option value={id}>{label}</option>
      {/each}
    </select>
    <ol>
      {#each order as name, index (name)}
        <li draggable="true" ondragstart={() => dragged = index} ondragover={(event) => event.preventDefault()} ondrop={() => drop(index)}>
          {name}
          <button class="pbtn small" type="button" disabled={index === 0} onclick={() => move(index, -1)}>{CONNECTION_WORDS.moveEarlier}</button>
          <button class="pbtn small" type="button" disabled={index === order.length - 1} onclick={() => move(index, 1)}>{CONNECTION_WORDS.moveLater}</button>
        </li>
      {/each}
    </ol>
    {#each view.roles as row (row.role)}
      <p>{row.role}: {CONNECTION_WORDS.runsFirst} {row.first ?? CONNECTION_WORDS.empty}</p>
    {/each}
    <button class="pbtn small primary" type="button" onclick={() => view && send("priority", "/api/connections/priority", { version: view.version, mode, order })}>{CONNECTION_WORDS.saveOrder}</button>
  </section>

  <section class="block" aria-labelledby="roles">
    <h2 id="roles">{CONNECTION_WORDS.sections.roles}</h2>
    {#each roles as row, index (row.role)}
      <article>
        <h3>{row.role}</h3>
        <select aria-label={row.role} value={row.override} onchange={(event) => {
          const value = event.currentTarget.value;
          if (value !== "follow" && value !== "own" && value !== "hand") return;
          roles = roles.map((item, at) => at === index ? { ...item, override: value, order: value === "own" && item.order.length === 0 ? [...order] : item.order } : item);
        }}>
          {#each Object.entries(CONNECTION_WORDS.overrides) as [id, label] (id)}
            <option value={id}>{label}</option>
          {/each}
        </select>
        {#if row.override === "own"}
          <ol aria-label={`${row.role} order`}>
            {#each row.order as name, at (name)}
              <li>
                {name}
                <button class="pbtn small" type="button" disabled={at === 0} onclick={() => moveRole(index, at, -1)}>{CONNECTION_WORDS.moveEarlier}</button>
                <button class="pbtn small" type="button" disabled={at === row.order.length - 1} onclick={() => moveRole(index, at, 1)}>{CONNECTION_WORDS.moveLater}</button>
              </li>
            {/each}
          </ol>
        {/if}
        {#each row.riskPicks as pick (pick)}
          <p>
            {pick}
            <button class="pbtn small" type="button" aria-label={`${CONNECTION_WORDS.remove} ${pick}`} onclick={() => {
              roles = roles.map((item, at) => at === index ? { ...item, riskPicks: item.riskPicks.filter(text => text !== pick) } : item);
            }}>{CONNECTION_WORDS.remove}</button>
          </p>
        {/each}
        <p>{CONNECTION_WORDS.chain}</p>
        <ol aria-label={CONNECTION_WORDS.chain}>
          {#each row.chain as entry (entry)}<li>{entry}</li>{/each}
        </ol>
        {#if row.drifted}
          <p>{CONNECTION_WORDS.drift}</p>
          <button class="pbtn small" type="button" onclick={() => postRole(row, row.override, "reapply")}>{CONNECTION_WORDS.reapply}</button>
          <button class="pbtn small" type="button" onclick={() => postRole(row, "hand", "keep-hand")}>{CONNECTION_WORDS.keepHand}</button>
        {/if}
        <button class="pbtn small primary" type="button" onclick={() => postRole(row, row.override, "save")}>{CONNECTION_WORDS.saveRole}</button>
      </article>
    {/each}
  </section>

  <section class="block" aria-labelledby="alerts">
    <h2 id="alerts">{CONNECTION_WORDS.alerts}</h2>
    {#if view.alerts.length === 0}<p>{CONNECTION_WORDS.empty}</p>{/if}
    {#each view.alerts as alert (alert.name + alert.detail)}
      <p role="status">{alert.name}: {alert.detail}</p>
    {/each}
  </section>
{/if}

<style>
  .block, .dialog { display: grid; gap: 12px; margin-top: 16px; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  h2 { margin: 0; font: 700 19px/24px var(--display); }
  h3 { margin: 0; font: 700 19px/24px var(--display); }
  .rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  .rows li, article, .dialog {
    min-width: 0; display: grid; gap: 8px; padding: 16px; border-radius: 18px; background: var(--surface); box-shadow: var(--card-shadow);
  }
  .meter, p { margin: 0; }
  ol { margin: 0; padding-left: 1.4rem; display: grid; gap: 8px; }
  label { display: grid; gap: 3px; min-width: 0; }
  label span { font: 700 11px/14px var(--body); letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
  input, select {
    width: 100%; min-width: 0; min-height: 44px; padding: 0 10px; border-radius: 11px; border: 1px solid var(--edge);
    background: var(--bg); color: var(--fg); font: 400 16px/1.2 var(--body);
  }
  code { font: 500 13px/18px ui-monospace, monospace; word-break: break-all; }
</style>
