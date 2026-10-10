<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { api, explain } from "$lib/api.ts";
  import { withStepUp } from "$lib/stepup.ts";
  import { forgetWritten, signOutHere } from "$lib/signout.ts";
  import SecurityChoices, { type Policy } from "$lib/SecurityChoices.svelte";
  import AddDevice from "$lib/AddDevice.svelte";
  import PushToggle from "$lib/PushToggle.svelte";

  type Device = { id: string; name: string; pairedAt: number; lastSeenAt: number | null; revokedAt: number | null; current: boolean };
  let devices = $state<Device[]>([]);
  let engines = $state(false);
  let confirming = $state<string | null>(null);
  let problem = $state<string | null>(null);
  let policy = $state<Policy | null>(null);
  const when = (t: number | null) => (t ? new Date(t).toLocaleString() : "never");

  async function load() {
    // The three reads are independent. A failed /api/me only hides Engines; the device list and the policy still load.
    const me = api.get<{ engines?: boolean }>("/api/me").then(
      m => { engines = m.engines === true; },
      () => { engines = false; },
    );
    try {
      const [listed, chosen] = await Promise.all([
        api.get<Device[]>("/api/devices"),
        api.get<{ policy: Policy }>("/api/policy"),
        me,
      ]);
      devices = listed;
      policy = chosen.policy;
    }
    catch (e) { problem = explain(e); if (/signed out/i.test(problem)) await goto("/"); }
  }
  async function revoke(d: Device) {
    try {
      await withStepUp(() => api.post(`/api/devices/${d.id}/revoke`), () => {});   // another device: a fresh passkey check
      confirming = null;
      if (d.current) { await forgetWritten(); return goto("/"); }
      await load();
    } catch (e) { problem = explain(e); }
  }
  async function signOut() {
    try { await signOutHere(); } finally { await goto("/"); }
  }
  onMount(load);
</script>

<main class="page">
  <a class="back" href="/">‹ Agents</a>
  {#if engines}<a class="btn quiet" href="/engines">Engines: which AI does what</a>{/if}
  {#if policy}
    <h1>Security</h1>
    <section class="sec"><SecurityChoices {policy} onChanged={p => (policy = p)} /></section>
  {/if}
  <h1>Devices</h1>
  <p class="muted">These devices can see your agents. Up to six at once.</p>
  <section class="sec"><PushToggle /></section>
  <section class="sec"><AddDevice onAdded={load} /></section>
  <ul>
    {#each devices as d (d.id)}
      <li class:revoked={d.revokedAt}>
        <div>
          <strong>{d.name}</strong>{#if d.current}<span class="tag">this device</span>{/if}
          <p class="muted">Paired {when(d.pairedAt)} · last seen {when(d.lastSeenAt)}</p>
          {#if d.revokedAt}<p class="muted">Revoked {when(d.revokedAt)}</p>{/if}
        </div>
        {#if !d.revokedAt}
          {#if confirming === d.id}
            <div class="confirm">
              <span>{d.current ? "Revoke and sign out here?" : `Revoke ${d.name}?`}</span>
              <button class="btn danger" onclick={() => revoke(d)}>Revoke</button>
              <button class="btn quiet" onclick={() => (confirming = null)}>Keep</button>
            </div>
          {:else}
            <button class="btn quiet" onclick={() => (confirming = d.id)}>Revoke…</button>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>
  {#if problem}<p class="error">{problem}</p>{/if}
  <button class="btn quiet" onclick={signOut}>Sign out</button>
</main>

<style>
  .back { color: var(--accent); text-decoration: underline; font-weight: 600; }
  a.btn { justify-self: start; text-decoration: none; }
  .sec { display: grid; gap: 16px; padding: 14px; border-radius: 14px; background: var(--surface); border: 1px solid var(--line); }
  .sec :global(.field) { display: grid; gap: 4px; }
  .sec :global(.note) { margin: 0; font-size: 0.85rem; color: var(--muted); }
  .sec :global(.opt) { display: flex; gap: 10px; align-items: flex-start; padding: 4px 0; font-size: 0.95rem; }
  .sec :global(.opt input) { margin-top: 5px; accent-color: var(--accent); }
  .sec :global(.err) { color: var(--danger-text); margin: 4px 0 0; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  li { display: grid; gap: 10px; padding: 14px; border-radius: 14px; background: var(--surface); border: 1px solid var(--line); }
  li.revoked { opacity: 0.6; }
  li p { font-size: 0.85rem; }
  .tag { margin-left: 8px; font-size: 0.72rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--fill); color: var(--fg); }
  .confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
</style>
