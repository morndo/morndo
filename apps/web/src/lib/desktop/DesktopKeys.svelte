<script lang="ts">
  // The keys a phone or tablet has no button for (T-670): Esc, Tab, arrows and Enter as one row under the bar, with
  // Ctrl and Alt held for exactly the next press, and a hidden field that opens the device's own keyboard — the trick
  // from noVNC's vnc.html (keyInput): the field starts full of underscores, and every edit is diffed into BackSpaces
  // and characters, so autocorrect and swipe typing work too. Buttons never take focus (mousedown's default is
  // prevented), so tapping them leaves the soft keyboard up.
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import { KEYSYM, SENTINEL, keysymOf, namedKey, type KeySender } from "./vnc-input.ts";

  let { sender, ctrl, alt, open = $bindable(false) }: { sender: KeySender; ctrl: boolean; alt: boolean; open?: boolean } = $props();

  let field = $state<HTMLTextAreaElement | null>(null);
  let last = SENTINEL;

  // The Keyboard button: focus the field if it isn't focused (the keyboard comes up), blur it if it is.
  export function toggle() {
    if (field && document.activeElement === field) field.blur();
    else field?.focus();
  }

  // The caret stays collapsed at the end: a drag, the iOS space-bar trackpad or a select-all must never turn into
  // BackSpaces (vnc.html moves the caret to the end when its keyboard opens).
  const toEnd = () => {
    if (!field) return;
    const end = field.value.length;
    if (field.selectionStart !== end || field.selectionEnd !== end) field.setSelectionRange(end, end);
  };

  const tap = (keysym: number, code: string) => sender.press(keysym, code);

  // Physical modifiers held while a key is pressed: held for that one press, as the buttons are.
  function withModifiers(e: KeyboardEvent, keysym: number, code: string | null) {
    if (e.ctrlKey && !sender.ctrl) sender.toggle("ctrl");
    if (e.altKey && !sender.alt) sender.toggle("alt");
    sender.press(keysym, code, e.shiftKey);
  }

  function onKeydown(e: KeyboardEvent) {
    e.stopPropagation();                              // the wide client's own shortcuts (Ctrl+K, Alt+arrows) must not fire from here
    // A soft keyboard mid-composition, or an IME's placeholder key: the text comes as an input event instead.
    if (e.isComposing || e.key === "Unidentified" || e.keyCode === 229) return;
    const n = namedKey(e.key);
    if (n) { e.preventDefault(); withModifiers(e, n.keysym, n.code); return; }
    // Ctrl+k and friends: the character with the modifier held. Option (Alt) and AltGr (Ctrl+Alt) make characters:
    // those are text, and reach the input event.
    if (e.key.length === 1 && e.ctrlKey && !e.altKey) { e.preventDefault(); withModifiers(e, keysymOf(e.key), null); }
  }

  function onInput() {
    if (!field) return;
    sender.typed(last, field.value);
    last = field.value;
    if (field.value.length === 0) {
      // Emptied: back to the filler at once, so the next edit is read against it, then a blur here and the refocus
      // out of the handler, for Android's keyboard to see the new text (vnc.html's keyInput, in that order).
      last = SENTINEL;
      field.value = SENTINEL;
      field.blur();
      const f = field;
      setTimeout(() => f.focus(), 0);
    } else if (field.value.length > 2 * SENTINEL.length) {
      // Past twice the filler: the value goes back to it, nothing else; the caret follows below.
      last = SENTINEL;
      field.value = SENTINEL;
      toEnd();
    }
  }
</script>

<svelte:document onselectionchange={() => { if (field && document.activeElement === field) toEnd(); }} />

<div class="keys" role="toolbar" aria-label="Keys for the desktop" tabindex="-1" onmousedown={e => e.preventDefault()}>
  <button class="k" onclick={() => tap(KEYSYM.Escape, "Escape")}>Esc</button>
  <button class="k" onclick={() => tap(KEYSYM.Tab, "Tab")}>Tab</button>
  <button class="k mod" aria-pressed={ctrl} onclick={() => sender.toggle("ctrl")}>Ctrl</button>
  <button class="k mod" aria-pressed={alt} onclick={() => sender.toggle("alt")}>Alt</button>
  <button class="k arr" aria-label="Left" onclick={() => tap(KEYSYM.Left, "ArrowLeft")}><ArrowLeft size={14} /></button>
  <button class="k arr" aria-label="Up" onclick={() => tap(KEYSYM.Up, "ArrowUp")}><ArrowUp size={14} /></button>
  <button class="k arr" aria-label="Down" onclick={() => tap(KEYSYM.Down, "ArrowDown")}><ArrowDown size={14} /></button>
  <button class="k arr" aria-label="Right" onclick={() => tap(KEYSYM.Right, "ArrowRight")}><ArrowRight size={14} /></button>
  <button class="k" onclick={() => tap(KEYSYM.Return, "Enter")}>Enter</button>
</div>
<!-- The field the device's keyboard types into: invisible but focusable, never display:none (that closes the keyboard).
     autocorrect is Safari's own (not in Svelte's HTML types), so it goes in by spread. -->
<textarea class="field" aria-label="Type on the desktop" bind:this={field} rows="1"
  autocapitalize="off" autocomplete="off" spellcheck="false" {...{ autocorrect: "off" }}
  onfocus={() => { open = true; toEnd(); }} onblur={() => (open = false)} onselect={toEnd}
  onkeydown={onKeydown} oninput={onInput}>{SENTINEL}</textarea>

<style>
  .keys { flex: none; display: flex; align-items: center; gap: 3px; padding: 4px 6px; border-bottom: 1px solid var(--border); background: var(--main-bg); overflow: hidden; position: relative; }
  .k {
    min-height: 32px; padding: 0 7px; border: 1px solid var(--outline); border-radius: 6px; background: transparent;
    color: var(--text); font: 700 12px/1 var(--font); cursor: pointer; white-space: nowrap;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .k.arr { padding: 0 5px; }
  .k:active { background: var(--hover); }
  .k.mod[aria-pressed="true"] { background: var(--selected); color: var(--selected-fg); border-color: transparent; }
  .field {
    position: absolute; width: 1px; height: 1px; top: 0; left: 0; opacity: 0; border: 0; padding: 0; resize: none;
    font: 16px/1 var(--font);                        /* 16px: iOS Safari doesn't zoom the page to read it */
  }
</style>
