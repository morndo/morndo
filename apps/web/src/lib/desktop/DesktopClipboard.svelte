<script lang="ts">
  // Text in and out of the desktop's clipboard (T-670), where a phone has no Ctrl+v: "Paste text" puts what is typed
  // here on the desktop's clipboard (noVNC's clipboardPasteFrom) or types it key by key, and "Copy from desktop" shows
  // what the desktop last sent and copies it to this device's clipboard. One panel at a time, over the screen.
  import type { KeySender } from "./vnc-input.ts";

  let { paste, sender, text, show, onClose }: {
    paste: (text: string) => void; sender: KeySender; text: string; show: "paste" | "copy" | null; onClose: () => void;
  } = $props();

  let toPaste = $state("");
  let deskField = $state<HTMLTextAreaElement | null>(null);
  let copied = $state<"yes" | "no" | null>(null);

  // Whatever was typed for the desktop is gone once the panel closes, whichever way it closed: a pasted password
  // must not sit there for the next opening.
  $effect(() => { if (show !== "paste" && toPaste !== "") toPaste = ""; });

  // Typed out exactly as given: a stray held Ctrl or Alt lets go first, so it cannot touch the first character.
  function typeIt() {
    sender.letGo();
    sender.typeText(toPaste);
    onClose();
  }

  // Copy is off until the desktop has sent something, so it never empties this device's clipboard. Either way of
  // copying answers for itself; the fallback's own answer is execCommand's.
  async function copy() {
    copied = null;
    try { await navigator.clipboard.writeText(text); copied = "yes"; return; } catch { /* no permission here: the old way below */ }
    deskField?.select();
    copied = document.execCommand("copy") ? "yes" : "no";
  }
</script>

{#if show === "paste"}
  <div class="panel" role="dialog" aria-label="Paste text">
    <textarea bind:value={toPaste} aria-label="Text to paste" rows="4" placeholder="What goes to the desktop"></textarea>
    <div class="acts">
      <button class="b" onclick={() => { paste(toPaste); onClose(); }}>Send to the desktop's clipboard</button>
      <button class="b" onclick={typeIt}>Type it</button>
      <button class="b" onclick={onClose}>Close</button>
    </div>
  </div>
{:else if show === "copy"}
  <div class="panel" role="dialog" aria-label="Copy from desktop">
    <textarea readonly bind:this={deskField} value={text} aria-label="The desktop's clipboard" rows="4" placeholder="Nothing copied on the desktop yet"></textarea>
    <div class="acts">
      <button class="b" disabled={!text} onclick={copy}>Copy</button>
      <button class="b" onclick={onClose}>Close</button>
    </div>
    {#if copied}<p class="answer" role="status">{copied === "yes" ? "Copied" : "Couldn't copy: select the text and copy it."}</p>{/if}
  </div>
{/if}

<style>
  .panel {
    position: absolute; top: 44px; left: 50%; transform: translateX(-50%); z-index: 3; width: min(360px, calc(100% - 16px));
    display: grid; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--menu-bg, var(--main-bg)); box-shadow: var(--shadow-menu);
  }
  .panel textarea { resize: vertical; min-height: 64px; padding: 8px; border: 1px solid var(--outline); border-radius: 6px; background: var(--main-bg); color: var(--text); font: 400 16px/20px var(--font); }   /* 16px: iPhone Safari doesn't zoom the page into it */
  .acts { display: flex; flex-wrap: wrap; gap: 6px; }
  .b { min-height: 30px; padding: 0 10px; border: 1px solid var(--outline); border-radius: 6px; background: transparent; color: var(--text); font: 700 12px/1 var(--font); cursor: pointer; }
  .b:hover { background: var(--hover); }
  .answer { margin: 0; font: 400 12px/16px var(--font); color: var(--muted); }
</style>
