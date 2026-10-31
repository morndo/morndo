// The Desktop tab's input from a phone or tablet (T-670): the keysyms the extra keys and the phone's keyboard send, as
// noVNC's own vnc.html sends them (core/input/keysym.js and keysymdef.js at v1.7.0), Ctrl and Alt held for one press,
// the hidden field's text diff (vnc.html's keyInput), and the view choice kept on the device. Pure: no DOM, no noVNC.
import { describe, expect, it } from "vitest";
import { KEYSYM, KeySender, VIEW_KEY, keysymOf, loadView, namedKey, saveView, typedDiff, viewFlags } from "../src/lib/desktop/vnc-input.ts";

describe("keysyms", () => {
  it("named keys as X11 defines them, by KeyboardEvent.key", () => {
    expect(KEYSYM).toMatchObject({ BackSpace: 0xff08, Tab: 0xff09, Return: 0xff0d, Escape: 0xff1b, Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54, Control_L: 0xffe3, Alt_L: 0xffe9 });
    expect(namedKey("Enter")).toEqual({ keysym: 0xff0d, code: "Enter" });
    expect(namedKey("Backspace")).toEqual({ keysym: 0xff08, code: "Backspace" });
    expect(namedKey("Escape")).toEqual({ keysym: 0xff1b, code: "Escape" });
    expect(namedKey("Tab")).toEqual({ keysym: 0xff09, code: "Tab" });
    expect(namedKey("ArrowLeft")).toEqual({ keysym: 0xff51, code: "ArrowLeft" });
    expect(namedKey("ArrowUp")).toEqual({ keysym: 0xff52, code: "ArrowUp" });
    expect(namedKey("ArrowRight")).toEqual({ keysym: 0xff53, code: "ArrowRight" });
    expect(namedKey("ArrowDown")).toEqual({ keysym: 0xff54, code: "ArrowDown" });
    expect(namedKey("a")).toBeNull();
    expect(namedKey("Unidentified")).toBeNull();
  });

  it("characters: Latin-1 one to one, anything else as a Unicode keysym, newline and tab as their keys", () => {
    expect(keysymOf("a")).toBe(0x61);
    expect(keysymOf(" ")).toBe(0x20);
    expect(keysymOf("~")).toBe(0x7e);
    expect(keysymOf("é")).toBe(0xe9);
    expect(keysymOf("ÿ")).toBe(0xff);
    expect(keysymOf("€")).toBe(0x010020ac);
    expect(keysymOf("😀")).toBe(0x0101f600);
    expect(keysymOf("\n")).toBe(0xff0d);
    expect(keysymOf("\t")).toBe(0xff09);
  });
});

describe("the hidden field's text diff (vnc.html keyInput)", () => {
  it("typed at the end, deleted at the end, rewritten in the middle, unchanged", () => {
    expect(typedDiff("___", "___ab")).toEqual({ backspaces: 0, text: "ab" });
    expect(typedDiff("___ab", "___a")).toEqual({ backspaces: 1, text: "" });
    expect(typedDiff("___teh", "___the")).toEqual({ backspaces: 2, text: "he" });
    expect(typedDiff("___", "___")).toEqual({ backspaces: 0, text: "" });
  });
});

describe("KeySender", () => {
  const recorder = () => {
    const calls: unknown[][] = [];
    return { calls, target: { sendKey: (...a: unknown[]) => void calls.push(a) } };
  };

  it("a key is one press; Ctrl and Alt hold for exactly the next press; a second tap lets go", () => {
    const { calls, target } = recorder();
    const k = new KeySender(() => target);
    k.press(KEYSYM.Escape, "Escape");
    k.toggle("ctrl");
    expect(k.ctrl).toBe(true);
    k.press(0x63, null);
    expect(k.ctrl).toBe(false);
    k.toggle("ctrl");
    k.toggle("alt");
    k.press(KEYSYM.Tab, "Tab");
    k.press(KEYSYM.Tab, "Tab");
    k.toggle("alt");
    k.toggle("alt");
    expect(k.alt).toBe(false);
    k.press(KEYSYM.Left, "ArrowLeft");
    expect(calls).toEqual([
      [0xff1b, "Escape"],
      [0xffe3, "ControlLeft", true], [0x63, null], [0xffe3, "ControlLeft", false],
      [0xffe3, "ControlLeft", true], [0xffe9, "AltLeft", true], [0xff09, "Tab"], [0xffe9, "AltLeft", false], [0xffe3, "ControlLeft", false],
      [0xff09, "Tab"],
      [0xff51, "ArrowLeft"],
    ]);
  });

  it("typed text: the Backspaces first, then each character; a held Ctrl takes only the first", () => {
    const { calls, target } = recorder();
    const k = new KeySender(() => target);
    k.typed("___teh", "___the");
    k.toggle("ctrl");
    k.typeText("cv\n\t");
    expect(calls).toEqual([
      [0xff08, "Backspace"], [0xff08, "Backspace"], [0x68, null], [0x65, null],
      [0xffe3, "ControlLeft", true], [0x63, null], [0xffe3, "ControlLeft", false], [0x76, null], [0xff0d, "Enter"], [0xff09, "Tab"],
    ]);
  });

  it("sends nothing without a connection, and lets go of a held key then", () => {
    const k = new KeySender(() => null);
    k.toggle("ctrl");
    expect(() => k.press(KEYSYM.Escape, "Escape")).not.toThrow();
    expect(() => k.typeText("ab")).not.toThrow();
    expect(k.ctrl).toBe(false);
  });
});

describe("the view kept on this device", () => {
  it("Fit by default; 1:1 with or without Pan; anything unreadable is Fit; storage errors are swallowed", () => {
    expect(VIEW_KEY).toBe("morndo.desktop.view");
    expect(loadView(() => null)).toEqual({ mode: "fit", pan: false });
    expect(loadView(() => '{"mode":"1:1","pan":true}')).toEqual({ mode: "1:1", pan: true });
    expect(loadView(() => '{"mode":"1:1"}')).toEqual({ mode: "1:1", pan: false });
    expect(loadView(() => '{"mode":"zoom","pan":true}')).toEqual({ mode: "fit", pan: false });
    expect(loadView(() => "not json")).toEqual({ mode: "fit", pan: false });
    expect(loadView(() => { throw new Error("SecurityError"); })).toEqual({ mode: "fit", pan: false });
    const saved: string[] = [];
    saveView(v => void saved.push(v), { mode: "1:1", pan: true });
    expect(saved.map(s => JSON.parse(s))).toEqual([{ mode: "1:1", pan: true }]);
    expect(() => saveView(() => { throw new Error("QuotaExceededError"); }, { mode: "fit", pan: false })).not.toThrow();
  });

  it("what each choice asks of noVNC; watching (null) is always Fit; nothing resizes the remote session", () => {
    expect(viewFlags(null)).toEqual({ scaleViewport: true, clipViewport: false, dragViewport: false });
    expect(viewFlags({ mode: "fit", pan: true })).toEqual({ scaleViewport: true, clipViewport: false, dragViewport: false });
    expect(viewFlags({ mode: "1:1", pan: false })).toEqual({ scaleViewport: false, clipViewport: true, dragViewport: false });
    expect(viewFlags({ mode: "1:1", pan: true })).toEqual({ scaleViewport: false, clipViewport: true, dragViewport: true });
  });
});

describe("review 2 (T-670)", () => {
  const recorder = () => {
    const calls: unknown[][] = [];
    return { calls, k: new KeySender(() => ({ sendKey: (...a: unknown[]) => void calls.push(a) })) };
  };

  it("a replacement's BackSpaces go out plain, and a held Ctrl takes the first typed character", () => {
    const { calls, k } = recorder();
    k.toggle("ctrl");
    k.typed("___teh", "___the ");
    expect(calls).toEqual([[0xff08, "Backspace"], [0xff08, "Backspace"], [0xffe3, "ControlLeft", true], [0x68, null], [0xffe3, "ControlLeft", false], [0x65, null], [0x20, null]]);
  });

  it("a deletion alone keeps the held key on its first BackSpace", () => {
    const { calls, k } = recorder();
    k.toggle("ctrl");
    k.typed("___ab", "___");
    expect(calls).toEqual([[0xffe3, "ControlLeft", true], [0xff08, "Backspace"], [0xffe3, "ControlLeft", false], [0xff08, "Backspace"]]);
  });

  it("the diff counts characters, not UTF-16 units", () => {
    expect(typedDiff("___a😀", "___a")).toEqual({ backspaces: 1, text: "" });
    expect(typedDiff("___😀", "___😃")).toEqual({ backspaces: 1, text: "😃" });
  });
});
