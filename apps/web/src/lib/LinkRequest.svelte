<script lang="ts">
  // "Link with a signed-in device" (ADR-0008 phase E, AC11), on a device not yet paired: it asks the hub to be added,
  // shows a QR code of the address a signed-in device opens to approve, and the 6-digit code the approver types. It
  // asks every 2 seconds whether it was approved; then it goes on to the normal pairing (the hub's identity, then a
  // passkey). Denied or expired, it says so and can ask again; Cancel ends the request. The QR code also carries a key
  // the hub never sees: the approving device proves with it which hub identity it pinned, and this device checks that
  // proof before it trusts the identity (review M1). Design reference, not code: Signal-Desktop
  // ts/textsecure/Provisioner.preload.ts.
  import { onDestroy } from "svelte";
  import { api, ApiError, explain } from "./api.ts";
  import { countdown, identityProof, linkAddress, newLinkKey, pairLink, showCode } from "./linking.ts";
  import QrCode from "./QrCode.svelte";

  type Asked = { requestId: string; secret: string; code: string; expiresAt: number; offset: number; key: string };
  type Answer = { state: "waiting" | "denied" | "expired" | "cancelled" | "mistyped" } | { state: "approved"; token: string; fingerprint: string | null; proof: string | null };
  let asked = $state<Asked | null>(null);
  let ended = $state<"denied" | "expired" | "cancelled" | "mistyped" | null>(null);
  let busy = $state(false);
  let problem = $state<string | null>(null);
  let copied = $state(false);
  let now = $state(Date.now());
  const LINK_MS = 10 * 60_000;

  async function ask() {
    busy = true; problem = null; ended = null; copied = false;
    try {
      const r = await api.post<Omit<Asked, "offset" | "key">>("/api/link");
      // The hub's clock says when it ends; this device's clock only counts down to it.
      asked = { ...r, offset: Date.now() - (r.expiresAt - LINK_MS), key: newLinkKey() };
    } catch (e) { problem = explain(e); }
    finally { busy = false; }
  }

  async function check(a: Asked) {
    try {
      const r = await api.get<Answer>(`/api/link/${a.requestId}`, { "x-morndo-link-secret": a.secret });
      if (asked !== a) return;
      if (r.state === "approved") {
        asked = null;
        if (!r.fingerprint || !r.proof || (await identityProof(a.key, r.fingerprint)) !== r.proof) {
          problem = "The hub's answer doesn't carry the other device's word for the hub's identity. Don't pair here.";
          return;
        }
        location.assign(pairLink(location.origin, r.token, r.fingerprint));   // the pairing page, a fresh load
      } else if (r.state !== "waiting") { asked = null; ended = r.state; }
    } catch (e) {
      if (e instanceof ApiError && e.code === "unknown") { asked = null; ended = "expired"; }
    }
  }

  // Cancel frees the request's place among the 3 the hub keeps open (review L6); whatever the hub says, it is over here.
  function cancel() {
    const a = asked;
    asked = null;
    ended = null;
    if (a) void fetch(`/api/link/${a.requestId}/cancel`, { method: "POST", headers: { "x-morndo-link-secret": a.secret } }).catch(() => {});
  }

  const timer = setInterval(() => { now = Date.now(); }, 1000);
  $effect(() => {
    const a = asked;
    if (!a) return;
    const t = setInterval(() => void check(a), 2000);
    return () => clearInterval(t);
  });
  onDestroy(() => clearInterval(timer));
  // At most the request's 10 minutes: the display clock can lag the moment the offset was taken.
  const left = $derived(asked ? Math.min(LINK_MS, asked.expiresAt - (now - asked.offset)) : 0);
  const address = $derived(asked ? linkAddress(location.origin, asked.requestId, asked.key) : "");
  async function copy() {
    try { await navigator.clipboard.writeText(address); copied = true; } catch { problem = "This browser didn't allow copying. Select the address and copy it."; }
  }
</script>

<section class="link-req">
  {#if asked && left > 0}
    <h2>Link this device</h2>
    <p>On a device that is already signed in, scan this with the camera, or open the address below there, and type this code there.</p>
    <QrCode value={address} label="Address to approve this device" />
    <p class="code">Code <strong>{showCode(asked.code)}</strong></p>
    <div class="addr">
      <input readonly value={address} aria-label="Address to approve this device" onfocus={e => e.currentTarget.select()} />
      <button class="btn quiet" onclick={copy}>{copied ? "Copied" : "Copy"}</button>
    </div>
    <p class="muted"><span role="status">Waiting for approval…</span> {countdown(left)} left.</p>
    <button class="btn quiet" onclick={cancel}>Cancel</button>
  {:else}
    {#if ended === "denied"}<p class="error" role="alert">The other device said no. Nothing was added.</p>
    {:else if ended === "mistyped"}<p class="error" role="alert">The code typed on the other device didn't match, so this request ended. Ask again.</p>
    {:else if ended === "expired" || asked}<p class="error" role="alert">That request expired; they last 10 minutes.</p>{/if}
    <button class="btn quiet" onclick={ask} disabled={busy}>{busy ? "Asking the hub…" : ended || asked ? "Ask again" : "Link with a signed-in device"}</button>
  {/if}
  {#if problem}<p class="error" role="alert">{problem}</p>{/if}
</section>

<style>
  .link-req { display: grid; gap: 12px; justify-items: start; }
  .link-req h2 { margin: 0; font-size: 1.2rem; }
  .link-req p { margin: 0; }
  .code { font-size: 1.05rem; }
  .code strong { font: 700 1.5rem/1.2 var(--mono); letter-spacing: 0.08em; font-variant-numeric: tabular-nums; }
  .addr { display: flex; gap: 8px; width: 100%; }
  .addr input {
    flex: 1; min-width: 0; font: 13px/1.4 var(--mono); padding: 0 10px; min-height: 44px; border-radius: 10px;
    border: 1px solid var(--line); background: var(--surface); color: var(--fg);
  }
</style>
