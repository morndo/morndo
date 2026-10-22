<script lang="ts">
  import { onMount } from "svelte";
  import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
  import { hubIdentityMatches } from "@morndo/domain";
  import { api, ApiError, explain } from "$lib/api.ts";
  import { checkHub, readPin, writePin, type HubCheck } from "$lib/hub.ts";
  import Fingerprint from "$lib/Fingerprint.svelte";
  import Phone from "$lib/phone/Phone.svelte";
  import Desktop from "$lib/desktop/Desktop.svelte";
  import LinkRequest from "$lib/LinkRequest.svelte";
  import type { Policy } from "$lib/SecurityChoices.svelte";
  type Me = { endpoint: { name: string }; office: string; session: { verifiedAt: number }; policy: Policy; desktop?: boolean; engines?: boolean };

  type View =
    | { kind: "checking" }
    | { kind: "mismatch"; pinned: string; presented: string }
    | { kind: "locked"; paired: boolean }
    | { kind: "ready"; device: string; office: string; verifiedAt: number | null; policy: Policy; desktop: boolean; engines: boolean }
    | { kind: "failed"; message: string };

  let view = $state<View>({ kind: "checking" });
  let hub: HubCheck | null = null;
  let busy = $state(false);
  let error = $state<string | null>(null);
  // Desktop (the Slack-style client) from 900px; narrower screens get the phone: Chats, Today, Status, Board and Home.
  let wide = $state(typeof matchMedia === "function" && matchMedia("(min-width: 900px)").matches);
  onMount(() => {
    const mq = matchMedia("(min-width: 900px)");
    const on = () => (wide = mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  });

  async function load() {
    try {
      hub = await checkHub();
      const pin = readPin();
      if (pin && !hubIdentityMatches(pin.fingerprint, hub.fingerprint)) {
        view = { kind: "mismatch", pinned: pin.fingerprint, presented: hub.fingerprint };
        return;
      }
      const me = await api.get<Me>("/api/me").catch(e => {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      });
      view = me ? { kind: "ready", device: me.endpoint.name, office: me.office, verifiedAt: me.session.verifiedAt, policy: me.policy, desktop: me.desktop === true, engines: me.engines === true } : { kind: "locked", paired: pin !== null };
      if (me !== null) void offerUpdates();
    } catch (e) {
      view = { kind: "failed", message: explain(e) };
    }
  }

  // The Updates link (updates §8.2, PR 6c part 2), offered as the Engines one is. That flag comes from /api/me; this
  // hub answer is not changed here, so the link follows its own probe: GET /api/updates offered when the hub answers
  // anything but its 404 updates_off. No answer at all keeps it hidden.
  let updates = $state(false);
  async function offerUpdates(): Promise<void> {
    try { await api.get("/api/updates"); updates = true; }
    catch (e) { updates = e instanceof ApiError && e.status !== 404; }
  }

  async function unlock() {
    busy = true;
    error = null;
    try {
      const { flowId, options } = await api.post<{ flowId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("/api/login/options");
      const response = await startAuthentication({ optionsJSON: options });
      await api.post<{ endpoint: { name: string } }>("/api/login/verify", { flowId, response });
      const me = await api.get<Me>("/api/me");
      if (!readPin() && hub) writePin({ fingerprint: hub.fingerprint, device: me.endpoint.name, pairedAt: Date.now() });
      view = { kind: "ready", device: me.endpoint.name, office: me.office, verifiedAt: me.session.verifiedAt, policy: me.policy, desktop: me.desktop === true, engines: me.engines === true };
      void offerUpdates();
    } catch (e) {
      error = explain(e);
    } finally {
      busy = false;
    }
  }

  onMount(load);
</script>

{#if view.kind === "ready" && wide}
  <Desktop device={view.device} office={view.office} verifiedAt={view.verifiedAt} policy={view.policy} desktop={view.desktop} engines={view.engines} updates={updates} onSignedOut={() => (view = { kind: "locked", paired: true })} />
{:else if view.kind === "ready"}
  <Phone device={view.device} verifiedAt={view.verifiedAt} policy={view.policy} engines={view.engines} updates={updates} onSignedOut={() => (view = { kind: "locked", paired: true })} />
{:else}
  <main class="page">
    <div class="brand">
      <img src="/favicon.svg" alt="" width="56" height="56" />
      <div>
        <h1>Morndo</h1>
        <p class="muted">By morning, it's done.</p>
      </div>
    </div>

    {#if view.kind === "checking"}
      <p class="muted">Checking the hub's identity…</p>
    {:else if view.kind === "mismatch"}
      <section class="stop" role="alert">
        <h2>The hub's identity changed</h2>
        <p>This device paired with a different hub. Someone may be pretending to be yours, or the hub was reinstalled. Don't unlock here.</p>
        <p class="muted">Pinned at pairing:</p>
        <Fingerprint value={view.pinned} />
        <p class="muted">This hub shows:</p>
        <Fingerprint value={view.presented} />
        <p>If you reinstalled the hub yourself, pair this device again with <code>morndo pair</code>.</p>
      </section>
    {:else if view.kind === "failed"}
      <p class="error">{view.message}</p>
      <button class="btn quiet" onclick={load}>Try again</button>
    {:else}
      {#if !browserSupportsWebAuthn()}
        <p class="error">This browser can't use passkeys, so it can't unlock Morndo.</p>
      {:else}
        <button class="btn" onclick={unlock} disabled={busy}>{busy ? "Waiting for your passkey…" : "Unlock with passkey"}</button>
        {#if error}<p class="error">{error}</p>{/if}
      {/if}
      {#if !view.paired}
        <p class="muted">New device? Link it from a device that is signed in, or run <code>morndo pair</code> on your computer and scan its QR code.</p>
      {/if}
      {#if browserSupportsWebAuthn()}<LinkRequest />{/if}
    {/if}
  </main>
{/if}

<style>
  .brand { display: flex; align-items: center; gap: 14px; padding-top: 12vh; }
  .brand img { border-radius: 14px; }
  .stop { display: grid; gap: 12px; padding: 16px; border-radius: 14px; border: 1px solid var(--danger); }
  .stop h2 { margin: 0; color: var(--danger-text); font-size: 1.2rem; }
</style>
