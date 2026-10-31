<script lang="ts">
  // The Desktop tab: the office's shared desktop (where the agents' Chrome runs), as real VNC through noVNC (MPL-2.0,
  // unmodified) over the hub's bridge. The hub logs in to the VNC server; the browser never sees its password. Watching
  // by default (the hub drops any input then); "Take control" asks for the passkey (AC9) and then mouse and keyboard
  // work. From a phone or tablet (T-670) the bar also holds the keyboard, paste and copy panels, and the choice between
  // Fit and 1:1 with Pan, kept on this device; the remote session is never resized to match.
  import { onDestroy, onMount } from "svelte";
  import RFB from "@novnc/novnc";
  import { neutral } from "@morndo/brand";
  import { stepUp } from "../stepup.ts";
  import Maximize from "@lucide/svelte/icons/maximize-2";
  import Minimize from "@lucide/svelte/icons/minimize-2";
  import Keyboard from "@lucide/svelte/icons/keyboard";
  import ClipboardPaste from "@lucide/svelte/icons/clipboard-paste";
  import ClipboardCopy from "@lucide/svelte/icons/clipboard-copy";
  import { FullscreenToggle } from "./fullscreen.svelte.ts";
  import ControlBar from "./ControlBar.svelte";
  import DesktopKeys from "./DesktopKeys.svelte";
  import DesktopClipboard from "./DesktopClipboard.svelte";
  import { KeySender, VIEW_KEY, loadView, saveView, viewFlags, type DesktopViewPrefs } from "./vnc-input.ts";

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
  // Full screen (the Fullscreen API) for a closer look: the same button leaves it again, and so does Escape. Where the
  // browser has no element full screen at all (iPhone Safari), there is no button to mislead.
  const full = new FullscreenToggle(() => root);
  let canFull = $state(false);
  let note = $state<string | null>(null);
  let rfb: RFB | null = null;
  // The phone's keyboard and extra keys, over whichever connection has control. The held-key buttons follow the sender
  // wherever a press came from: the keys row, the hidden field, or a panel's "Type it".
  let held = $state({ ctrl: false, alt: false });
  const sender = new KeySender(() => rfb, () => { held = { ctrl: sender.ctrl, alt: sender.alt }; });
  let keys = $state<{ toggle: () => void } | null>(null);
  let keysOpen = $state(false);                     // the hidden field has focus: keep noVNC from taking it back
  let panel = $state<"paste" | "copy" | null>(null);
  let deskClip = $state("");                        // the desktop's clipboard, only ever from the connection in control
  let prefs = $state<DesktopViewPrefs>({ mode: "fit", pan: false });
  let destroyed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let fails = 0;

  const url = (wantControl: boolean) => {
    const u = new URL(`/api/desktop${wantControl ? "?control=1" : ""}`, location.href);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  };

  function applyView(r: RFB, inControl: boolean) {
    const f = viewFlags(inControl ? prefs : null);
    r.scaleViewport = f.scaleViewport;
    r.clipViewport = f.clipViewport;
    r.dragViewport = f.dragViewport;
  }

  function connect(wantControl: boolean) {
    clearTimeout(retry);
    if (!screen) return;
    const old = rfb;
    rfb = null;
    old?.disconnect();
    status = old ? "reconnecting" : "connecting";
    const r = new RFB(screen, url(wantControl), { shared: true });
    rfb = r;
    deskClip = "";                                  // nothing of the last connection's clipboard carries over
    applyView(r, wantControl);
    r.viewOnly = !wantControl;
    r.focusOnClick = wantControl && !keysOpen;
    r.qualityLevel = 6;
    r.compressionLevel = 2;
    r.background = neutral[950];
    // Only a connection in control can be trusted with the desktop's clipboard; while watching, none arrives.
    r.addEventListener("clipboard", e => { if (rfb === r && control) deskClip = (e as CustomEvent<{ text?: string }>).detail?.text ?? ""; });
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
      panel = null;
      keysOpen = false;
      deskClip = "";
      if (wantControl && !wasControl) note = "The hub didn't hand over control. Try again.";
      else if (wasControl) note = "Control ended. Watching again.";
      fails++;
      status = fails > 3 ? "unavailable" : "reconnecting";
      retry = setTimeout(() => connect(false), Math.min(10_000, 500 * 2 ** fails));
    });
  }

  // A change of view applies to the live connection at once; watching stays at Fit (noVNC never resizes the session).
  $effect(() => {
    const f = viewFlags(control && prefs.mode === "1:1" ? { mode: "1:1", pan: prefs.pan } : null);
    if (!rfb) return;
    rfb.scaleViewport = f.scaleViewport;
    rfb.clipViewport = f.clipViewport;
    rfb.dragViewport = f.dragViewport;
  });
  // While the hidden field holds focus, noVNC must not steal it back on a tap on the screen (vnc.html's
  // keepVirtualKeyboard): the keyboard stays up.
  $effect(() => { if (rfb) rfb.focusOnClick = control && !keysOpen; });

  function choose(next: DesktopViewPrefs) {
    prefs = next;
    saveView(v => localStorage.setItem(VIEW_KEY, v), next);
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
  function release() { note = null; panel = null; keysOpen = false; connect(false); }

  onMount(() => {
    canFull = document.fullscreenEnabled === true && typeof document.documentElement?.requestFullscreen === "function";
    prefs = loadView(() => localStorage.getItem(VIEW_KEY));
    connect(false);
  });
  onDestroy(() => { destroyed = true; clearTimeout(retry); rfb?.disconnect(); });
</script>

<section class="dv" aria-label="Desktop" bind:this={root}>
  <ControlBar what="the desktop" {control} {status} {busy} verifiedFresh={controlFresh} {note} onTake={take} onRelease={release}>
    {#snippet extra()}
      {#if control}
        <button class="tool icon" aria-pressed={keysOpen} aria-label="Keyboard" title="Keyboard" onmousedown={e => e.preventDefault()} onclick={() => keys?.toggle()}><Keyboard size={15} /></button>
        <button class="tool icon" aria-label="Paste text" title="Paste text" aria-pressed={panel === "paste"} onclick={() => (panel = panel === "paste" ? null : "paste")}><ClipboardPaste size={15} /></button>
        <button class="tool icon" aria-label="Copy from desktop" title="Copy from desktop" aria-pressed={panel === "copy"} onclick={() => (panel = panel === "copy" ? null : "copy")}><ClipboardCopy size={15} /></button>
        <button class="tool" aria-pressed={prefs.mode === "fit"} onclick={() => choose({ mode: "fit", pan: false })}>Fit</button>
        <button class="tool" aria-pressed={prefs.mode === "1:1"} onclick={() => choose({ mode: "1:1", pan: prefs.pan })}>1:1</button>
        {#if prefs.mode === "1:1"}<button class="tool" aria-pressed={prefs.pan} onclick={() => choose({ mode: "1:1", pan: !prefs.pan })}>Pan</button>{/if}
      {/if}
      {#if canFull}<button class="fs" onclick={full.toggle} aria-label={full.on ? "Exit full screen" : "Full screen"} title={full.on ? "Exit full screen" : "Full screen"}>{#if full.on}<Minimize size={15} />{:else}<Maximize size={15} />{/if}</button>{/if}
    {/snippet}
  </ControlBar>
  {#if control}<DesktopKeys bind:this={keys} bind:open={keysOpen} {sender} ctrl={held.ctrl} alt={held.alt} />{/if}
  {#if control}<DesktopClipboard show={panel} {sender} paste={t => rfb?.clipboardPasteFrom(t)} text={deskClip} onClose={() => (panel = null)} />{/if}
  <div class="screen" class:control bind:this={screen} data-theme="dark" onmousedowncapture={e => { if (keysOpen) e.preventDefault(); }}></div>
</section>

<style>
  .dv { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--main-bg); }
  .fs { width: 28px; height: 28px; min-height: 28px; border: 0; border-radius: 6px; background: transparent; color: var(--text); display: grid; place-items: center; cursor: pointer; }
  .fs:hover { background: var(--hover); }
  /* The phone's tool buttons share the bar's height; text labels only where no icon says it (Fit, 1:1, Pan). */
  .tool {
    height: 28px; min-height: 28px; padding: 0 6px; border: 1px solid var(--outline); border-radius: 6px; background: transparent;
    color: var(--text); font: 700 12px/1 var(--font); cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center;
  }
  .tool.icon { width: 28px; padding: 0; justify-content: center; }
  .tool:hover { background: var(--hover); }
  .tool[aria-pressed="true"] { background: var(--selected); color: var(--selected-fg); border-color: transparent; }
  .screen { flex: 1; min-height: 0; overflow: hidden; background: var(--term-bg); }
  .screen.control { box-shadow: inset 0 0 0 2px var(--morndo-success); }   /* data-theme=dark: the screen is dark in both themes */
</style>
