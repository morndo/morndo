<script lang="ts">
  // The Terminal tab: the agent's tmux pane, live, drawn by xterm.js (MIT) from the hub's frames (colors, cursor, the
  // pane's own size, scaled to fit). Watching by default; "Take control" asks for the passkey (AC9), and then the keys
  // typed here go into the pane, so a menu can be answered from the browser.
  import { onDestroy, onMount } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { neutral } from "@morndo/brand";
  import "@xterm/xterm/css/xterm.css";
  import { stepUp } from "../stepup.ts";
  import Maximize from "@lucide/svelte/icons/maximize-2";
  import ControlBar from "./ControlBar.svelte";
  import { ServerTerminalFrames, decode } from "@morndo/protocol";
  import { unreachable } from "@morndo/domain";
  import { backoff } from "../connection.ts";
  import { sessionState } from "../feed.svelte.ts";

  type Frame = { cols: number; rows: number; x: number; y: number; cursor: boolean; lines: string[] };
  let { pane, name, verifiedAt, onVerified }: { pane: string; name: string; verifiedAt: number | null; onVerified: (at: number) => void } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let box = $state<HTMLDivElement | null>(null);
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
  // Full screen (the Fullscreen API) for a closer look; Escape leaves it, as the browser shows.
  const fullscreen = () => { void root?.requestFullscreen?.().catch(() => {}); };
  let note = $state<string | null>(null);
  let term: Terminal | null = null;
  let ws: WebSocket | null = null;
  let last = $state.raw<Frame | null>(null);
  let destroyed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;                                     // reconnects since the last open: the feed's backoff (phase B)

  const url = (wantControl: boolean) => {
    const u = new URL(`/api/terminal?pane=${encodeURIComponent(pane)}${wantControl ? "&control=1" : ""}`, location.href);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  };

  // The pane's whole screen, row by row: each row is erased before it is drawn, so nothing of the old frame remains.
  function draw(f: Frame) {
    if (!term) return;
    if (term.cols !== f.cols || term.rows !== f.rows) term.resize(f.cols, f.rows);
    let out = "\x1b[?25l";
    f.lines.forEach((line, i) => { out += `\x1b[${i + 1};1H\x1b[2K${line}\x1b[0m`; });
    out += `\x1b[${f.y + 1};${f.x + 1}H${f.cursor ? "\x1b[?25h" : ""}`;
    term.write(out);
    last = f;
    fit();
  }

  // The largest font (8 to 16px) at which the pane's columns and rows fit the tab. A pane too big even at 8px (a 200-column
  // agent beside the decisions) is scaled down as a whole, so nothing is ever cut off; full screen makes it readable.
  let scale = $state(1);
  function fit() {
    if (!term || !box || !host || !last) return;
    const w = box.clientWidth - 24, h = box.clientHeight - 24;
    const size = Math.max(8, Math.min(16, Math.floor(Math.min(w / (last.cols * 0.6), h / (last.rows * 1.2)))));
    if (term.options.fontSize !== size) term.options.fontSize = size;
    requestAnimationFrame(() => {
      const screen = host?.querySelector<HTMLElement>(".xterm-screen");
      if (!screen) return;
      scale = Math.min(1, w / screen.offsetWidth, h / screen.offsetHeight);
    });
  }

  function connect(wantControl: boolean) {
    clearTimeout(retry);
    ws?.close();
    const socket = new WebSocket(url(wantControl));
    ws = socket;
    let opened = false;
    socket.onopen = () => { status = "live"; opened = true; };
    // Every frame is decoded (ADR-0008, A2): a malformed one is dropped, a type this build doesn't know ignored.
    socket.onmessage = e => {
      const d = decode(ServerTerminalFrames, e.data);
      if (d.kind !== "ok") return;
      attempt = 0;                                     // the hub said something: the backoff starts over (review L6)
      const m = d.frame;
      switch (m.t) {
        case "frame": draw(m); break;
        case "mode": control = m.control; if (term) term.options.disableStdin = !control; if (control) term?.focus(); break;
        // keys_uncertain: the worker's machine may have typed them, but the hub lost touch before it could say (fleet
        // core §3.1); never a refusal. Anything else the hub says is one.
        case "error": note = m.error === "keys_uncertain" ? "Those keys may have been typed." : "The pane didn't take those keys."; break;
        default: unreachable(m);
      }
    };
    socket.onclose = e => {
      if (ws !== socket || destroyed) return;
      ws = null;
      const wasControl = control;
      control = false;
      if (term) term.options.disableStdin = true;
      if (e.code === 4404) { status = "unavailable"; note = `#${name} isn't running anymore.`; return; }
      if (e.code === 4403 && wasControl) note = "Control ended: your passkey check expired. Watching again.";
      else if (e.code === 4401) { status = "unavailable"; note = "You're signed out."; return; }
      else if (wantControl && !wasControl) note = "The hub didn't hand over control. Try again.";
      status = "reconnecting";
      // A refused upgrade (signed out, revoked) looks like any failure to the browser: ask before retrying (review M4).
      if (!opened) {
        void sessionState().then(s => {
          if (destroyed || ws) return;
          if (s === "ended") { status = "unavailable"; note = "You're signed out."; }
          else retry = setTimeout(() => connect(false), backoff(attempt++));
        });
        return;
      }
      retry = setTimeout(() => connect(false), wantControl && !wasControl ? 0 : backoff(attempt++));
    };
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

  onMount(() => {
    term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace', fontSize: 13, lineHeight: 1.0, scrollback: 0,
      cursorBlink: true, disableStdin: true, cursorInactiveStyle: "outline",
      theme: { background: neutral[950], foreground: neutral[200], cursor: neutral[200], selectionBackground: neutral[700] },
    });
    if (host) term.open(host);
    term.onData(data => { if (control && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "keys", data })); });
    connect(false);
    const ro = new ResizeObserver(() => fit());
    if (box) ro.observe(box);
    return () => ro.disconnect();
  });
  onDestroy(() => { destroyed = true; clearTimeout(retry); ws?.close(); term?.dispose(); });
</script>

<section class="tv" aria-label="Terminal of #{name}" bind:this={root}>
  <ControlBar what="#{name}'s terminal" {control} {status} {busy} verifiedFresh={controlFresh} {note} onTake={take} onRelease={release}>
    {#snippet extra()}
      {#if scale < 0.9}
        <button class="fs wide" onclick={fullscreen} title="The pane is {last?.cols}×{last?.rows}; shrunk to {Math.round(scale * 100)}% to fit"><Maximize size={14} />Full screen to read</button>
      {:else}
        <button class="fs" onclick={fullscreen} aria-label="Full screen" title="Full screen"><Maximize size={15} /></button>
      {/if}
    {/snippet}
  </ControlBar>
  <div class="box" class:control bind:this={box} data-theme="dark">
    <div class="host" bind:this={host} style:transform="translateX(-50%) scale({scale})"></div>
  </div>
</section>

<style>
  .tv { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--main-bg); }
  .fs { width: 28px; height: 28px; min-height: 28px; border: 0; border-radius: 6px; background: transparent; color: var(--text); display: grid; place-items: center; cursor: pointer; }
  .fs:hover { background: var(--hover); }
  .fs.wide { width: auto; gap: 6px; padding: 0 10px; display: inline-flex; align-items: center; border: 1px solid var(--outline); font: 700 12px/1 var(--font); }
  .box { position: relative; flex: 1; min-height: 0; overflow: hidden; background: var(--term-bg); }
  .box.control { box-shadow: inset 0 0 0 2px var(--morndo-success); }   /* data-theme=dark: the terminal is dark in both themes */
  /* Centered whatever its size: anchored at the middle, then scaled around its top center. */
  .host { position: absolute; top: 12px; left: 50%; transform-origin: top center; }
  .host :global(.xterm-viewport) { overflow-y: hidden !important; background: transparent !important; }
</style>
