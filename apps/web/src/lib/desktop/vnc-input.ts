// Keys and text for the Desktop tab from a phone or tablet (T-670), where there is no physical keyboard: the keysyms
// X11 defines (as noVNC's own vnc.html sends them, core/input/keysym.js at v1.7.0), Ctrl and Alt held for exactly one
// press, and the hidden field's text diff that turns a soft keyboard's edits into BackSpaces and characters. The view
// choice (Fit or 1:1 with Pan) is kept on the device. Pure: no DOM, no noVNC — a KeySender only calls sendKey on
// whatever target it is handed, so the tests can record instead of reaching a VNC server.

// The keysyms used here (noVNC core/input/keysym.js, v1.7.0).
export const KEYSYM = {
  BackSpace: 0xff08, Tab: 0xff09, Return: 0xff0d, Escape: 0xff1b,
  Home: 0xff50, Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54, PageUp: 0xff55, PageDown: 0xff56, End: 0xff57,
  Delete: 0xffff, Control_L: 0xffe3, Alt_L: 0xffe9, Shift_L: 0xffe1,
} as const;

// A KeyboardEvent.key that names a key of its own (not a character): the keysym to send and the code to go with it.
// Characters and anything unrecognized are null: they reach the desktop as text, or not at all.
export function namedKey(key: string): { keysym: number; code: string } | null {
  const named: Record<string, { keysym: number; code: string }> = {
    Enter: { keysym: KEYSYM.Return, code: "Enter" },
    Backspace: { keysym: KEYSYM.BackSpace, code: "Backspace" },
    Tab: { keysym: KEYSYM.Tab, code: "Tab" },
    Escape: { keysym: KEYSYM.Escape, code: "Escape" },
    ArrowLeft: { keysym: KEYSYM.Left, code: "ArrowLeft" },
    ArrowUp: { keysym: KEYSYM.Up, code: "ArrowUp" },
    ArrowRight: { keysym: KEYSYM.Right, code: "ArrowRight" },
    ArrowDown: { keysym: KEYSYM.Down, code: "ArrowDown" },
    Delete: { keysym: KEYSYM.Delete, code: "Delete" },
    Home: { keysym: KEYSYM.Home, code: "Home" },
    End: { keysym: KEYSYM.End, code: "End" },
    PageUp: { keysym: KEYSYM.PageUp, code: "PageUp" },
    PageDown: { keysym: KEYSYM.PageDown, code: "PageDown" },
  };
  return named[key] ?? null;
}

// One code point as a keysym: Latin-1 one to one, anything else as noVNC's Unicode fallback (0x01000000 | codepoint;
// keysyms.lookup, v1.7.0). Newline and tab are their keys, not their characters.
export function keysymOf(ch: string): number {
  if (ch === "\n" || ch === "\r") return KEYSYM.Return;
  if (ch === "\t") return KEYSYM.Tab;
  const cp = ch.codePointAt(0) ?? 0;
  return cp >= 0x20 && cp <= 0xff ? cp : 0x01000000 | cp;
}

// The hidden field starts full of these; typing appends after them, so a soft keyboard's insertions and deletions can
// be read off the value (vnc.html's keyInput).
export const SENTINEL = "_".repeat(99);

// What changed between two values of the hidden field: everything from the first differing character was deleted, then
// the rest typed (vnc.html's keyInput comparison; a caret position is not part of it). Characters, not UTF-16 units:
// an emoji is one key press, not two halves of one.
export function typedDiff(oldValue: string, newValue: string): { backspaces: number; text: string } {
  const old = Array.from(oldValue);
  const fresh = Array.from(newValue);
  let i = 0;
  while (i < old.length && i < fresh.length && old[i] === fresh[i]) i++;
  return { backspaces: old.length - i, text: fresh.slice(i).join("") };
}

// Whatever can take a key: noVNC's RFB (sendKey(keysym, code, down?) sends both events when down is omitted).
export type KeyTarget = { sendKey(keysym: number, code: string | null, down?: boolean): void };

// Sends keys through the current connection, holding Ctrl and Alt for exactly the next press when their buttons (or a
// physical key) put them down — a phone has no modifier keys to hold down and release on its own. Whenever ctrl or alt
// changes, whoever gave a callback hears of it, so the buttons can follow what was sent wherever the press came from.
export class KeySender {
  ctrl = false;
  alt = false;
  #target: () => KeyTarget | null;
  #onChange: (() => void) | undefined;

  constructor(target: () => KeyTarget | null, onChange?: () => void) {
    this.#target = target;
    this.#onChange = onChange;
  }

  toggle(m: "ctrl" | "alt") {
    this[m] = !this[m];
    this.#onChange?.();
  }

  // Lets go of a held Ctrl or Alt without sending anything, so it cannot touch the text typed next.
  letGo() {
    if (!this.ctrl && !this.alt) return;
    this.ctrl = false;
    this.alt = false;
    this.#onChange?.();
  }

  // A physical Shift held for one press (Shift+Tab), as Ctrl and Alt are held by their buttons.
  press(keysym: number, code: string | null, withShift = false) {
    const t = this.#target();
    if (t) {
      if (this.ctrl) t.sendKey(KEYSYM.Control_L, "ControlLeft", true);
      if (this.alt) t.sendKey(KEYSYM.Alt_L, "AltLeft", true);
      if (withShift) t.sendKey(KEYSYM.Shift_L, "ShiftLeft", true);
      t.sendKey(keysym, code);
      if (withShift) t.sendKey(KEYSYM.Shift_L, "ShiftLeft", false);
      if (this.alt) t.sendKey(KEYSYM.Alt_L, "AltLeft", false);
      if (this.ctrl) t.sendKey(KEYSYM.Control_L, "ControlLeft", false);
    }
    const wasHeld = this.ctrl || this.alt;
    this.ctrl = false;
    this.alt = false;
    if (wasHeld) this.#onChange?.();
  }

  // Sent just as it is, whatever is held: a replacement's deleting is not what a held key was held for.
  #plain(keysym: number, code: string | null) {
    this.#target()?.sendKey(keysym, code);
  }

  // Text, one press per code point: newline and tab as their keys (vnc.html sends those from the field too).
  typeText(text: string) {
    for (const ch of text) {
      if (ch === "\n" || ch === "\r") this.press(KEYSYM.Return, "Enter");
      else if (ch === "\t") this.press(KEYSYM.Tab, "Tab");
      else this.press(keysymOf(ch), null);
    }
  }

  // The hidden field's new value: the deletions as BackSpaces, then what was typed. An edit that does both (autocorrect
  // replacing a word) sends its BackSpaces plain — a held key lands on the first typed character, not on the deleting —
  // while a deletion alone keeps it on its first BackSpace.
  typed(oldValue: string, newValue: string) {
    const { backspaces, text } = typedDiff(oldValue, newValue);
    const replacement = backspaces > 0 && text.length > 0;
    for (let i = 0; i < backspaces; i++) {
      if (replacement) this.#plain(KEYSYM.BackSpace, "Backspace");
      else this.press(KEYSYM.BackSpace, "Backspace");
    }
    this.typeText(text);
  }
}

// How the desktop is shown: scaled to fit the tab, or one remote pixel to one screen pixel with the whole 1920×1080
// reachable by panning. The remote session is never resized to match.
export type DesktopViewPrefs = { mode: "fit" | "1:1"; pan: boolean };
export const VIEW_KEY = "morndo.desktop.view";

// The choice kept on this device; anything unreadable (no storage, old shape) is Fit, and pan without 1:1 is nothing.
export function loadView(get: () => string | null): DesktopViewPrefs {
  try {
    const v = JSON.parse(get() ?? "null") as { mode?: unknown; pan?: unknown };
    if (v?.mode === "1:1") return { mode: "1:1", pan: v.pan === true };
    return { mode: "fit", pan: false };
  } catch {
    return { mode: "fit", pan: false };
  }
}

// Saved once per change; a storage that refuses (a private window) keeps the choice for this page only.
export function saveView(set: (v: string) => void, v: DesktopViewPrefs) {
  try { set(JSON.stringify(v)); } catch { /* not kept on this device */ }
}

// What each choice asks of noVNC. Watching (null) is always Fit, as it has always been.
export function viewFlags(v: DesktopViewPrefs | null): { scaleViewport: boolean; clipViewport: boolean; dragViewport: boolean } {
  if (v?.mode === "1:1") return { scaleViewport: false, clipViewport: true, dragViewport: v.pan === true };
  return { scaleViewport: true, clipViewport: false, dragViewport: false };
}
