<script lang="ts">
  // Preferences, in Slack's modal frame: Security (the access policy) and Devices (paired devices, revoke, sign out).
  import { onMount } from "svelte";
  import Laptop from "@lucide/svelte/icons/laptop";
  import { api, explain } from "../api.ts";
  import { forgetWritten, signOutHere } from "../signout.ts";
  import { withStepUp } from "../stepup.ts";
  import SecurityChoices, { type Policy } from "../SecurityChoices.svelte";
  import SlackModal from "./SlackModal.svelte";
  import AddDevice from "../AddDevice.svelte";
  import PushToggle from "../PushToggle.svelte";

  let { policy, tab: initialTab = "security", onPolicy, onVerified, onSignedOut, onClose }: {
    policy: Policy; tab?: "security" | "devices"; onPolicy: (p: Policy) => void; onVerified: (at: number) => void;
    onSignedOut: () => void; onClose: () => void;
  } = $props();

  type Device = { id: string; name: string; pairedAt: number; lastSeenAt: number | null; revokedAt: number | null; current: boolean };
  let tab = $state("security");
  $effect.pre(() => { tab = initialTab; });
  let devices = $state<Device[]>([]);
  let confirming = $state<string | null>(null);
  let problem = $state<string | null>(null);
  const when = (t: number | null) => (t ? new Date(t).toLocaleString() : "never");

  async function load() { try { devices = await api.get<Device[]>("/api/devices"); } catch (e) { problem = explain(e); } }
  async function revoke(d: Device) {
    try {
      await withStepUp(() => api.post(`/api/devices/${d.id}/revoke`), () => {});   // another device: a fresh passkey check
      confirming = null;
      if (d.current) { await forgetWritten(); return onSignedOut(); }
      await load();
    } catch (e) { problem = explain(e); }
  }
  async function signOut() { try { await signOutHere(); } finally { onSignedOut(); } }
  onMount(load);
</script>

<SlackModal label="Preferences" {onClose} tabs={[{ id: "security", label: "Security" }, { id: "devices", label: "Devices" }]} bind:tab>
  {#snippet title()}<span>Preferences</span>{/snippet}
  {#if tab === "security"}
    <div class="card"><SecurityChoices {policy} onChanged={onPolicy} {onVerified} /></div>
    <p class="foot">These apply to every device and are kept in the hub.</p>
  {:else}
    <div class="card">
      {#each devices as d (d.id)}
        <div class="field row" class:revoked={d.revokedAt}>
          <Laptop size={20} />
          <div>
            <strong>{d.name}{#if d.current} <span class="tag">this device</span>{/if}</strong>
            <p>Paired {when(d.pairedAt)} · last seen {when(d.lastSeenAt)}{d.revokedAt ? ` · revoked ${when(d.revokedAt)}` : ""}</p>
          </div>
          {#if !d.revokedAt}
            {#if confirming === d.id}
              <button class="ob danger" onclick={() => revoke(d)}>{d.current ? "Revoke and sign out" : "Revoke"}</button>
              <button class="ob" onclick={() => (confirming = null)}>Keep</button>
            {:else}
              <button class="ob" onclick={() => (confirming = d.id)}>Revoke…</button>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
    <div class="card"><div class="field"><PushToggle /></div></div>
    <div class="card"><div class="field"><AddDevice {onVerified} onAdded={load} /></div></div>
    {#if problem}<p class="err">{problem}</p>{/if}
    <p class="foot">Up to six devices. Or pair one with <code>morndo pair</code> on the machine. <button class="ob so" onclick={signOut}>Sign out here</button></p>
  {/if}
</SlackModal>

<style>
  .tag { margin-left: 6px; font: 700 11px/1 var(--font); padding: 3px 6px; border-radius: 999px; background: var(--muted-bg); color: var(--text); vertical-align: 2px; }
  .revoked { opacity: 0.55; }
  .danger { color: var(--bad-fg) !important; border-color: var(--bad-fg) !important; }
  .so { margin-left: auto; }
  code { font: 12px/18px var(--mono); }
</style>
