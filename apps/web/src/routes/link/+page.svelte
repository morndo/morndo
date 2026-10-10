<script lang="ts">
  // Approving a device that asked to be added (ADR-0008 phase E, AC11), on a signed-in device: opened from the QR
  // code on the new device. Linking needs the code that device shows, typed here (amendment 11: typed, not compared; a
  // wrong one ends the request at once), and a passkey check from the last 5 minutes; denying needs neither. It shows
  // when the request came and the network's identity header. Answered once. Linking sends the hub
  // identity this device pinned, with a proof under the key from the QR code that the new device checks (review M1);
  // a device that has no pinned identity can't link another.
  import { onMount } from "svelte";
  import { api, ApiError, explain } from "$lib/api.ts";
  import { withStepUp } from "$lib/stepup.ts";
  import { readPin } from "$lib/hub.ts";
  import { identityProof } from "$lib/linking.ts";
  import Fingerprint from "$lib/Fingerprint.svelte";
  import CodeInput from "$lib/CodeInput.svelte";

  type Details = { createdAt: number; expiresAt: number; requester: { login: string | null }; state: "open" | "approved" | "denied" | "expired" | "cancelled" | "mistyped" };
  let id = $state("");
  let key = $state("");
  const pin = readPin();
  let details = $state<Details | null>(null);
  let view = $state<"loading" | "ask" | "approved" | "denied" | "mistyped" | "signed_out" | "gone">("loading");
  let typed = $state("");
  let busy = $state(false);
  let problem = $state<string | null>(null);

  // A new address opened in this same tab changes only the fragment: it starts over (no reload happens).
  onMount(() => {
    void load();
    const again = () => { if (location.hash) void load(); };
    addEventListener("hashchange", again);
    return () => removeEventListener("hashchange", again);
  });

  async function load() {
    view = "loading"; details = null; problem = null; typed = "";
    // The request's id travels in the fragment, which browsers never send to a server; out of the address bar at once.
    const params = new URLSearchParams(location.hash.slice(1));
    id = params.get("r") ?? "";
    key = params.get("k") ?? "";
    history.replaceState(null, "", "/link");
    if (!/^[0-9a-f-]{36}$/.test(id) || !/^[A-Za-z0-9_-]{22}$/.test(key)) { view = "gone"; return; }
    try {
      details = await api.get<Details>(`/api/link/${id}/details`);
      view = details.state === "open" ? "ask" : details.state === "approved" ? "approved" : details.state === "denied" ? "denied" : "gone";
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) view = "signed_out";
      else if (e instanceof ApiError && e.status === 404) view = "gone";
      else problem = explain(e);
    }
  }

  async function answer(approve: boolean) {
    busy = true; problem = null;
    try {
      if (approve) {
        if (!pin) { problem = "This device hasn't kept the hub's identity, so it can't vouch for it. Sign out, then unlock again here."; return; }
        const proof = await identityProof(key, pin.fingerprint);
        await withStepUp(() => api.post(`/api/link/${id}/approve`, { fingerprint: pin.fingerprint, proof, code: typed }), () => {});
        view = "approved";
      } else {
        await api.post(`/api/link/${id}/deny`, {});
        view = "denied";
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "wrong_code") view = "mistyped";
      else if (e instanceof ApiError && (e.code === "expired" || e.code === "unknown")) view = "gone";
      else problem = explain(e);
    } finally { busy = false; }
  }
</script>

<main class="page">
  <a class="back" href="/">‹ Agents</a>
  {#if view === "ask" && details}
    <h1>Link a new device?</h1>
    <CodeInput label="The code the new device shows" bind:value={typed} disabled={busy}
      warning="Type the code from the device you're holding. If someone sent you a code or a QR, stop." />
    {#if pin}
      <details><summary>The hub identity this device vouches for</summary><Fingerprint value={pin.fingerprint} /></details>
    {/if}
    <p class="muted">Asked at {new Date(details.createdAt).toLocaleTimeString()}{#if details.requester.login} by {details.requester.login} on your network{/if}.</p>
    <div class="actions">
      <button class="btn" onclick={() => answer(true)} disabled={busy || typed.length !== 6}>{busy ? "Checking your passkey…" : "Link it"}</button>
      <button class="btn quiet" onclick={() => answer(false)} disabled={busy}>Deny</button>
    </div>
    <p class="muted">Linking asks for your passkey. The new device then checks the hub's identity and makes its own passkey; it can't send anything before its own passkey check.</p>
  {:else if view === "approved"}
    <h1>Linked</h1>
    <p>The new device goes on by itself: it checks the hub's identity, then makes its passkey.</p>
  {:else if view === "denied"}
    <h1>Denied</h1>
    <p>Nothing was added.</p>
  {:else if view === "mistyped"}
    <h1>The code didn't match</h1>
    <p>Nothing was added, and this request has ended. If the device in front of you asked, start again on it.</p>
  {:else if view === "signed_out"}
    <h1>Sign in first</h1>
    <p>Only a signed-in device can link another. <a href="/">Unlock this device</a>, then open the code again.</p>
  {:else if view === "gone"}
    <h1>This request is over</h1>
    <p>It expired, was cancelled on the new device, was answered, or the address is incomplete. The new device can ask again.</p>
  {:else}
    <p class="muted">Looking up the request…</p>
  {/if}
  {#if problem}<p class="error" role="alert">{problem}</p>{/if}
</main>

<style>
  .back { color: var(--accent); text-decoration: underline; font-weight: 600; }
  h1 { margin: 0; }
  p { margin: 0; }
  .actions { display: flex; gap: 12px; flex-wrap: wrap; }
</style>
