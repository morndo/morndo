<script lang="ts">
  // "Notifications on this device" (ADR-0008 phase F; N4): off until he taps it, and the browser's permission prompt
  // comes only from that tap. On, this device subscribes to its browser's push service with the hub's key and the hub
  // keeps one subscription for it; off, both go. On iPhone and iPad a web app gets push only once it is on the Home
  // Screen (Apple: "Add web push to Home Screen web apps in iOS 16.4 or later", developer.apple.com, "Sending web push
  // notifications in web apps and browsers", read 2026-10-02), so there it says how.
  import { onMount } from "svelte";
  import { api, ApiError, explain } from "./api.ts";

  type State = "loading" | "off" | "on" | "busy" | "denied" | "ios_home_screen" | "unsupported" | "push_off";
  let status = $state<State>("loading");
  let key: string | null = null;
  let problem = $state<string | null>(null);

  const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
  const standalone = () => (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches;
  const supported = () => "serviceWorker" in navigator && "PushManager" in globalThis && "Notification" in globalThis;
  const bytes = (b64u: string) => Uint8Array.from(atob(b64u.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

  async function localSubscription() {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  }

  onMount(async () => {
    if (!supported()) { status = ios() && !standalone() ? "ios_home_screen" : "unsupported"; return; }
    if (Notification.permission === "denied") { status = "denied"; return; }
    try {
      const r = await api.get<{ key: string; subscribed: boolean }>("/api/push/key");
      key = r.key;
      status = r.subscribed && (await localSubscription()) ? "on" : "off";
    } catch (e) {
      if (e instanceof ApiError && e.code === "push_off") status = "push_off";
      else { problem = explain(e); status = "off"; }
    }
  });

  // From the tap itself: the permission prompt, then the subscription (Safari asks for both inside the gesture).
  async function turnOn() {
    if (!key) return;
    status = "busy"; problem = null;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        status = permission === "denied" ? "denied" : "off";
        if (permission !== "denied") problem = "Notifications weren't allowed. Tap again to be asked again.";
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) });
      await api.post("/api/push/subscription", sub.toJSON());
      status = "on";
    } catch (e) { problem = explain(e); status = "off"; }
  }
  async function turnOff() {
    status = "busy"; problem = null;
    try {
      await (await localSubscription())?.unsubscribe();
      const res = await fetch("/api/push/subscription", { method: "DELETE", credentials: "same-origin" });
      if (!res.ok) throw new ApiError(res.status, `http_${res.status}`);
      status = "off";
    } catch (e) { problem = explain(e); status = "on"; }
  }
</script>

<div class="push">
  {#if status === "ios_home_screen"}
    <strong>Notifications on this device</strong>
    <p class="muted">On iPhone and iPad, notifications work once Morndo is on your Home Screen: tap Share, then Add to Home Screen, and open Morndo from there (iOS 16.4 or later).</p>
  {:else if status === "unsupported"}
    <strong>Notifications on this device</strong>
    <p class="muted">This browser can't show notifications from Morndo.</p>
  {:else if status === "push_off"}
    <strong>Notifications on this device</strong>
    <p class="muted">This hub doesn't send notifications.</p>
  {:else if status === "denied"}
    <strong>Notifications on this device</strong>
    <p class="muted">Notifications are blocked for this site in the browser's settings. Allow them there, then come back.</p>
  {:else}
    <label class="row">
      <span>
        <strong>Notifications on this device</strong>
        <span class="muted">Counts only: how many decisions wait, how many workers need you, a device added. Never names or text.</span>
      </span>
      <input type="checkbox" role="switch" checked={status === "on"} disabled={status === "loading" || status === "busy"}
        onchange={e => {
          // The box shows what is true afterwards, not what was tapped (review M4: a dismissed prompt left it ticked).
          const box = e.currentTarget;
          void (box.checked ? turnOn() : turnOff()).then(() => { box.checked = status === "on"; });
        }} />
    </label>
  {/if}
  {#if problem}<p class="error" role="alert">{problem}</p>{/if}
</div>

<style>
  .push { display: grid; gap: 6px; }
  .push p { margin: 0; }
  .row { display: flex; gap: 16px; align-items: center; justify-content: space-between; cursor: pointer; }
  .row > span { display: grid; gap: 2px; }
  .row .muted { font-size: 0.9rem; }
  input[type="checkbox"] { width: 44px; height: 26px; flex: none; accent-color: var(--accent); cursor: pointer; }
</style>
