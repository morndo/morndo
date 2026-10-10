<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
  import { hubIdentityMatches } from "@morndo/domain";
  import { api, ApiError, explain } from "$lib/api.ts";
  import { checkHub, writePin, type HubCheck } from "$lib/hub.ts";
  import Fingerprint from "$lib/Fingerprint.svelte";
  import CodeInput from "$lib/CodeInput.svelte";

  let token = $state("");
  let expected = $state("");
  let hub = $state<HubCheck | null>(null);
  let name = $state(guessName());
  let problem = $state<string | null>(null);
  let busy = $state(false);
  // A token from "Add a device" on a signed-in device (ADR-0008 phase E) needs the code that device shows, typed here
  // before the passkey (amendment 11); a wrong one ends the link. One from the console or a Link request needs none.
  let needsCode = $state(false);
  let typed = $state("");

  function guessName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return "iPhone";
    if (/iPad/.test(ua)) return "iPad";
    if (/Android/.test(ua)) return "Android phone";
    if (/Macintosh/.test(ua)) return "Mac";
    return "Browser";
  }

  // A new link opened in this same tab changes only the fragment: it starts over (no reload happens).
  onMount(() => {
    void load();
    const again = () => { if (location.hash) void load(); };
    addEventListener("hashchange", again);
    return () => removeEventListener("hashchange", again);
  });

  async function load() {
    problem = null; hub = null; needsCode = false; typed = "";
    // The code travels in the fragment, which browsers never send to a server. Take it out of the address bar at once.
    const params = new URLSearchParams(location.hash.slice(1));
    token = params.get("t") ?? "";
    expected = params.get("f") ?? "";
    history.replaceState(null, "", "/pair");
    if (!token || !/^[0-9a-f]{64}$/i.test(expected)) {
      problem = "This link is incomplete. Make a new one: Add a device on a signed-in device, or `morndo pair` on your computer.";
      return;
    }
    try {
      hub = await checkHub();
      if (!hubIdentityMatches(expected, hub.fingerprint)) {
        problem = "The hub that answered isn't the one that made this QR code. Don't pair here.";
        hub = null;
        return;
      }
      needsCode = (await api.post<{ needsCode: boolean }>("/api/pair/check", { token })).needsCode;
    } catch (e) {
      problem = explain(e);
      hub = null;
    }
  }

  async function pair() {
    if (!hub) return;
    busy = true;
    problem = null;
    try {
      const { flowId, options } = await api.post<{ flowId: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>(
        "/api/pair/options", { token, name, ...(needsCode ? { code: typed } : {}) });
      const response = await startRegistration({ optionsJSON: options });
      const r = await api.post<{ endpoint: { name: string } }>("/api/pair/verify", { flowId, response });
      writePin({ fingerprint: hub.fingerprint, device: r.endpoint.name, pairedAt: Date.now() });
      token = "";
      await goto("/", { replaceState: true });
    } catch (e) {
      problem = explain(e);
      if (e instanceof ApiError && (e.code === "wrong_code" || e.code === "expired" || e.code === "used")) hub = null;   // this link is over
    } finally {
      busy = false;
    }
  }
</script>

<main class="page">
  <h1>Pair this device</h1>
  {#if hub}
    <p>Check that your terminal or your other device shows this hub identity. Every group must match.</p>
    <Fingerprint value={hub.fingerprint} />
    {#if needsCode}
      <CodeInput label="Code shown on your signed-in device" bind:value={typed} disabled={busy}
        warning="Type the code from the signed-in device you're holding. If someone sent you a code or a QR, stop." />
    {/if}
    {#if hub.signature === "unsupported"}
      <p class="muted">This browser can't check the hub's signature, so only the hub identity above was compared.</p>
    {/if}
    <label class="field">
      <span>Device name</span>
      <input id="device-name" bind:value={name} maxlength="40" autocomplete="off" />
    </label>
    {#if browserSupportsWebAuthn()}
      <button class="btn" onclick={pair} disabled={busy || !name.trim() || (needsCode && typed.length !== 6)}>
        {busy ? "Waiting for your passkey…" : "Create passkey and pair"}
      </button>
      <p class="muted">Face ID, Touch ID or your device PIN protects the passkey. Morndo never sees a password.</p>
    {:else}
      <p class="error">This browser can't use passkeys, so it can't be paired.</p>
    {/if}
  {:else if !problem}
    <p class="muted">Checking the hub's identity…</p>
  {/if}
  {#if problem}<p class="error" role="alert">{problem}</p>{/if}
</main>

<style>
  .field { display: grid; gap: 6px; }
  .field span { font-size: 0.85rem; color: var(--muted); }
  input {
    font: inherit; min-height: 48px; padding: 0 14px; border-radius: 12px;
    border: 1px solid var(--line); background: var(--surface); color: var(--fg);
  }
</style>
