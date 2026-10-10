<script lang="ts">
  // "Add a device" (ADR-0008 phase E, AC10): this device issues a pairing token after a fresh passkey check, and shows
  // it as a QR code and a link with Copy, with its 6-digit code, which the new device types (amendment 11). The token lasts 10
  // minutes. While it shows, this device asks whether its own token was used, and by which device; the asking stops
  // when the code runs out and doesn't count as the principal's use (review M3). Cancel withdraws the token (L6).
  import { onDestroy } from "svelte";
  import { api, explain } from "./api.ts";
  import { withStepUp } from "./stepup.ts";
  import { readPin } from "./hub.ts";
  import { countdown, pairLink, showCode } from "./linking.ts";
  import QrCode from "./QrCode.svelte";

  let { onVerified = () => {}, onAdded = () => {} }: { onVerified?: (at: number) => void; onAdded?: () => void } = $props();

  type Issued = { tokenId: string; link: string; code: string; expiresAt: number; offset: number };
  let issued = $state<Issued | null>(null);
  let added = $state<string | null>(null);
  let busy = $state(false);
  let problem = $state<string | null>(null);
  let copied = $state(false);
  let now = $state(Date.now());
  const TOKEN_MS = 10 * 60_000;

  async function start() {
    problem = null; added = null; copied = false;
    // The link carries the hub identity this device pinned at its own pairing; without one it can't vouch for the hub.
    const pin = readPin();
    if (!pin) { problem = "This device hasn't kept the hub's identity, so it can't vouch for it. Sign out, then unlock again here."; return; }
    busy = true;
    try {
      const r = await withStepUp(() => api.post<{ tokenId: string; secret: string; code: string; expiresAt: number }>("/api/devices/add"), onVerified);
      // The hub's clock says when it ends; this device's clock only counts down to it.
      issued = { tokenId: r.tokenId, link: pairLink(location.origin, r.secret, pin.fingerprint), code: r.code, expiresAt: r.expiresAt, offset: Date.now() - (r.expiresAt - TOKEN_MS) };
    } catch (e) { problem = explain(e); }
    finally { busy = false; }
  }
  async function copy() {
    if (!issued) return;
    try { await navigator.clipboard.writeText(issued.link); copied = true; } catch { problem = "This browser didn't allow copying. Select the link and copy it."; }
  }
  function done() { issued = null; added = null; }
  function cancel() {
    const i = issued;
    done();
    if (i) void api.post(`/api/devices/add/${i.tokenId}/cancel`).catch(() => {});
  }

  const timer = setInterval(() => { now = Date.now(); }, 1000);
  onDestroy(() => clearInterval(timer));
  // At most the token's 10 minutes: the display clock can lag the moment the offset was taken.
  const left = $derived(issued ? Math.min(TOKEN_MS, issued.expiresAt - (now - issued.offset)) : 0);
  const live = $derived(issued !== null && added === null && left > 0);
  $effect(() => {
    const i = issued;
    if (!live || !i) return;
    const check = async () => {
      try {
        const r = await api.get<{ name: string | null }>(`/api/devices/add/${i.tokenId}`, { "x-morndo-background": "1" });
        if (r.name && issued === i) { added = r.name; onAdded(); }
      } catch { /* the next look */ }
    };
    const t = setInterval(() => void check(), 3000);
    return () => clearInterval(t);
  });
</script>

<div class="add">
  {#if added}
    <p class="ok" role="status"><strong>{added}</strong> was added. It asks for its own passkey check before it can send anything.</p>
    <button class="btn quiet" onclick={done}>Done</button>
  {:else if issued && left > 0}
    <p>On the new device, scan this with the camera or open the link, then type this code there. A wrong code ends it.</p>
    <QrCode value={issued.link} label="Pairing code for a new device" />
    <p class="code">Code <strong>{showCode(issued.code)}</strong></p>
    <div class="link">
      <input readonly value={issued.link} aria-label="Pairing link" onfocus={e => e.currentTarget.select()} />
      <button class="btn quiet" onclick={copy}>{copied ? "Copied" : "Copy"}</button>
    </div>
    <p class="muted">Works once, for {countdown(left)} more. Only open it on a device you own.</p>
    <button class="btn quiet" onclick={cancel}>Cancel</button>
  {:else}
    {#if issued}<p class="muted">That code expired. Make a new one.</p>{/if}
    <button class="btn" onclick={start} disabled={busy}>{busy ? "Checking your passkey…" : "Add a device"}</button>
    <p class="muted">Shows a code for your new device. Asks for your passkey first.</p>
  {/if}
  {#if problem}<p class="error" role="alert">{problem}</p>{/if}
</div>

<style>
  .add { display: grid; gap: 12px; justify-items: start; }
  .add p { margin: 0; }
  .code { font-size: 1.05rem; }
  .code strong { font: 700 1.5rem/1.2 var(--mono); letter-spacing: 0.08em; font-variant-numeric: tabular-nums; }
  .link { display: flex; gap: 8px; width: 100%; }
  .link input {
    flex: 1; min-width: 0; font: 13px/1.4 var(--mono); padding: 0 10px; min-height: 44px; border-radius: 10px;
    border: 1px solid var(--line); background: var(--surface); color: var(--fg);
  }
  .ok strong { font-weight: 700; }
</style>
