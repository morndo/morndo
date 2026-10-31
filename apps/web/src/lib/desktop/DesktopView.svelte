<script lang="ts">
  // The Desktop tab: the office's shared desktop (where the agents' Chrome runs), as real VNC through noVNC (MPL-2.0,
  // unmodified) over the hub's bridge. The hub logs in to the VNC server; the browser never sees its password. Watching
  // by default (the hub drops any input then); "Take control" asks for the passkey (AC9) and then mouse and keyboard work.
  import { onDestroy, onMount } from "svelte";
  import RFB from "@novnc/novnc";
  import { neutral } from "@morndo/brand";
  import { stepUp } from "../stepup.ts";
  import Maximize from "@lucide/svelte/icons/maximize-2";
  import Minimize from "@lucide/svelte/icons/minimize-2";
  import { FullscreenToggle } from "./fullscreen.svelte.ts";
  import ControlBar from "./ControlBar.svelte";

  let { verifiedAt, onVerified }: { verifiedAt: number | null; onVerified: (at: number) => void } = $props();

  let screen = $state<HTMLDivElement | null>(null);
  let status = $state<"connecting" | "live" | "reconnecting" | "unavailable">("connecting");
  let control = $state(false);
  let busy = $state(false);
  // Taking control always needs a passkey check from the last few minutes (AC9: the hub wants one within 5), whatever
  // the step-up setting for messages.
  const CONTROL_FRESH_MS = 4 * 60_000;
  let clock = $state(Date.now());
  $effect(() => { const t = setInterval(() => (clock = Date.now()), 15_000); return () => clearInterval(t); });
  const controlFresh = $derived(verifiedAt !== null && clock - verifiedAt < CONTROL_FRESH_MS);
  let root = $state<HTMLElement | null>(null);
  // Full screen (the Fullscreen API) for a closer look: the same button leaves it again, and so does Escape.
  const full = new FullscreenToggle(() => root);
  let note = $state<string | null>(null);
  let rfb: RFB | null = null;
  let destroyed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let fails = 0;

  const url = (wantControl: boolean) => {
    const u = new URL(`/api/desktop${wantControl ? "?control=1" : ""}`, location.href);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  };

  function connect(wantControl: boolean) {
    clearTimeout(retry);
    if (!screen) return;
    const old = rfb;
    rfb = null;
    old?.disconnect();
    status = old ? "reconnecting" : "connecting";
    const r = new RFB(screen, url(wantControl), { shared: true });
    rfb = r;
    r.viewOnly = !wantControl;
    r.focusOnClick = wantControl;
    r.scaleViewport = true;
    r.qualityLevel = 6;
    r.compressionLevel = 2;
    r.background = neutral[950];
    r.addEventListener("connect", () => {
      if (rfb !== r) return;
      status = "live";
      fails = 0;
      control = wantControl;
      if (control) r.focus();
    });
    r.addEventListener("disconnect", () => {
      if (rfb !== r || destroyed) return;
      const wasControl = control;
      control = false;
      if (wantControl && !wasControl) note = "The hub didn't hand over control. Try again.";
      else if (wasControl) note = "Control ended. Watching again.";
      fails++;
      status = fails > 3 ? "unavailable" : "reconnecting";
      retry = setTimeout(() => connect(false), Math.min(10_000, 500 * 2 ** fails));
    });
  }

  async function take() {
    busy = true;
    note = null;
    try {
      if (!(verifiedAt !== null && Date.now() - verifiedAt < CONTROL_FRESH_MS)) onVerified(await stepUp());
      connect(true);
    } catch {
      note = "Face ID or Touch ID was cancelled; still watching.";
    } finally { busy = false; }
  }
  function release() { note = null; connect(false); }

  onMount(() => connect(false));
  onDestroy(() => { destroyed = true; clearTimeout(retry); rfb?.disconnect(); });
</script>

<section class="dv" aria-label="Desktop" bind:this={root}>
  <ControlBar what="the desktop" {control} {status} {busy} verifiedFresh={controlFresh} {note} onTake={take} onRelease={release}>
    {#snippet extra()}<button class="fs" onclick={full.toggle} aria-label={full.on ? "Exit full screen" : "Full screen"} title={full.on ? "Exit full screen" : "Full screen"}>{#if full.on}<Minimize size={15} />{:else}<Maximize size={15} />{/if}</button>{/snippet}
  </ControlBar>
  <div class="screen" class:control bind:this={screen} data-theme="dark"></div>
</section>

<style>
  .dv { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--main-bg); }
  .fs { width: 28px; height: 28px; min-height: 28px; border: 0; border-radius: 6px; background: transparent; color: var(--text); display: grid; place-items: center; cursor: pointer; }
  .fs:hover { background: var(--hover); }
  .screen { flex: 1; min-height: 0; overflow: hidden; background: var(--term-bg); }
  .screen.control { box-shadow: inset 0 0 0 2px var(--morndo-success); }   /* data-theme=dark: the screen is dark in both themes */
</style>
