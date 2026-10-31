<script lang="ts">
  // The keys a phone or tablet has no button for (T-670): Esc, Tab, arrows and Enter as one row under the bar, with
  // Ctrl and Alt held for exactly the next press, and a hidden field that opens the device's own keyboard — the trick
  // from noVNC's vnc.html (keyInput): the field starts full of underscores, and every edit is diffed into BackSpaces
  // and characters, so autocorrect and swipe typing work too. Buttons never take focus (mousedown's default is
  // prevented), so tapping them leaves the soft keyboard up.
  import { tick } from "svelte";
  import { KEYSYM, SENTINEL, keysymOf, namedKey, type KeySender } from "./vnc-input.ts";

  let { sender, open = $bindable(false) }: { sender: KeySender; open?: boolean } = $props();

  let field = $state<HTMLTextAreaElement | null>(null);
  let last = SENTINEL;
  // The buttons' pressed state mirrors the sender, which clears both after the press they were held for.
  let ctrl = $state(false);
  let alt = $state(false);
  const sync = () => { ctrl = sender.ctrl; alt = sender.alt; };

  // The Keyboard button: focus the field if it isn't focused (the keyboard comes up), blur it if it is.
  export function toggle() {
    if (field && document.activeElement === field) field.blur();
    else field?.focus();
  }

  const tap = (keysym: number, code: string) => { sender.press(keysym, code); sync(); };
  const tapMod = (m: "ctrl" | "alt") => { sender.toggle(m); sync(); };

  // A physical Ctrl or Alt held while a key is pressed: held for that one press, as the buttons are.
  function held(e: KeyboardEvent, keysym: number, code: string | null) {
    if (e.ctrlKey && !sender.ctrl) sender.toggle("ctrl");
    if (e.altKey && !sender.alt) sender.toggle("alt");
    sender.press(keysym, code);
  }

  function onKeydown(e: KeyboardEvent) {
    // A soft keyboard mid-composition, or an IME's placeholder key: the text comes as an input event instead.
    if (e.isComposing || e.key === "Unidentified" || e.keyCode === 229) return;
    const n = namedKey(e.key);
    if (n) { e.preventDefault(); held(e, n.keysym, n.code); return; }
    // Ctrl+c and friends: the character with the modifier held, not the browser's shortcut.
    if (e.key.length === 1 && (e.ctrlKey || e.altKey)) { e.preventDefault(); held(e, keysymOf(e.key), null); }
  }

  function onInput() {
    if (!field) return;
    sender.typed(last, field.value);
    last = field.value;
    // Reset before the field grows past twice the sentinel, or when it was emptied: back to the sentinel, with a
    // blur and refocus on the next tick so the caret sits after it (vnc.html's keyInput does the same).
    if (field.value.length === 0 || field.value.length > 2 * SENTINEL.length) {
      last = SENTINEL;
      field.value = SENTINEL;
      field.blur();
      void tick().then(() => field?.focus());
    }
  }
</script>

<div class="keys" role="toolbar" aria-label="Keys for the desktop" tabindex="-1" onmousedown={e => e.preventDefault()}>
  <button class="k" onclick={() => tap(KEYSYM.Escape, "Escape")}>Esc</button>
  <button class="k" onclick={() => tap(KEYSYM.Tab, "Tab")}>Tab</button>
  <button class="k mod" aria-pressed={ctrl} onclick={() => tapMod("ctrl")}>Ctrl</button>
  <button class="k mod" aria-pressed={alt} onclick={() => tapMod("alt")}>Alt</button>
  <button class="k" aria-label="Left" onclick={() => tap(KEYSYM.Left, "ArrowLeft")}>←</button>
  <button class="k" aria-label="Up" onclick={() => tap(KEYSYM.Up, "ArrowUp")}>↑</button>
  <button class="k" aria-label="Down" onclick={() => tap(KEYSYM.Down, "ArrowDown")}>↓</button>
  <button class="k" aria-label="Right" onclick={() => tap(KEYSYM.Right, "ArrowRight")}>→</button>
  <button class="k" onclick={() => tap(KEYSYM.Return, "Enter")}>Enter</button>
</div>
<!-- The field the device's keyboard types into: invisible but focusable, never display:none (that closes the keyboard).
     autocorrect is Safari's own (not in Svelte's HTML types), so it goes in by spread. -->
<textarea class="field" aria-label="Type on the desktop" bind:this={field} rows="1"
  autocapitalize="off" autocomplete="off" spellcheck="false" {...{ autocorrect: "off" }}
  onfocus={() => (open = true)} onblur={() => (open = false)} onkeydown={onKeydown} oninput={onInput}>{SENTINEL}</textarea>

<style>
  .keys { flex: none; display: flex; align-items: center; gap: 3px; padding: 4px 6px; border-bottom: 1px solid var(--border); background: var(--main-bg); overflow: hidden; position: relative; }
  .k {
    min-height: 32px; padding: 0 7px; border: 1px solid var(--outline); border-radius: 6px; background: transparent;
    color: var(--text); font: 700 12px/1 var(--font); cursor: pointer; white-space: nowrap;
  }
  .k:active { background: var(--hover); }
  .k.mod[aria-pressed="true"] { background: var(--selected); color: var(--selected-fg); border-color: transparent; }
  .field {
    position: absolute; width: 1px; height: 1px; top: 0; left: 0; opacity: 0; border: 0; padding: 0; resize: none;
    font: 16px/1 var(--font);                        /* 16px: iOS Safari doesn't zoom the page to read it */
  }
</style>
