// The Desktop tab on phones and tablets (T-670). Under control: a keyboard button whose hidden field opens the phone's
// keyboard, an extra keys row with Ctrl and Alt held for one press, "Paste text" (to the desktop's clipboard, or typed
// key by key), "Copy from desktop", and Fit or 1:1 with Pan, kept on the device. Watching stays view-only and shows none
// of them. The control bar is one row, and the desktop fills the height that is left. The real DesktopView and
// ControlBar in headless Chromium; noVNC's RFB is the recording stand-in (novnc.stub.ts), so these check what the view
// asks noVNC to send, not the wire. Synthetic text only.
import { join } from "node:path";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;height:100vh;display:flex;flex-direction:column"><script type="module">
  import { mount } from "svelte";
  import DesktopView from "/src/lib/desktop/DesktopView.svelte";
  mount(DesktopView, { target: document.body, props: { verifiedAt: Date.now(), onVerified: () => {} } });
</script></body></html>`;

// X11 keysyms (noVNC core/input/keysym.js, v1.7.0).
const XK = { BackSpace: 0xff08, Tab: 0xff09, Return: 0xff0d, Escape: 0xff1b, Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54, Control_L: 0xffe3, Alt_L: 0xffe9 };
type Size = { width: number; height: number };
const PHONE: Size = { width: 390, height: 844 };
const LANDSCAPE: Size = { width: 844, height: 390 };
const TABLET: Size = { width: 820, height: 1180 };
const ROW = 48;                                     // one row of icons, at most

type Seen = { url: string; keys: unknown[][]; pasted: string[]; viewOnly: boolean; scaleViewport: boolean; clipViewport: boolean; dragViewport: boolean; resized: boolean; disconnected: boolean };
const all = (tab: Page): Promise<Seen[]> => tab.evaluate(() => ((globalThis as unknown as { __rfb?: Seen[] }).__rfb ?? []).map(r => ({
  url: r.url, keys: r.keys, pasted: r.pasted, viewOnly: r.viewOnly, scaleViewport: r.scaleViewport, clipViewport: r.clipViewport,
  dragViewport: r.dragViewport, resized: r.resized, disconnected: r.disconnected,
})));
// The one connection still open: the view closes the old one before it opens the next.
async function current(tab: Page): Promise<Seen> {
  const open = (await all(tab)).filter(r => !r.disconnected);
  expect(open).toHaveLength(1);
  return open[0]!;
}
const keysSent = async (tab: Page) => (await all(tab)).flatMap(r => r.keys);
const view3 = (r: Seen) => [r.scaleViewport, r.clipViewport, r.dragViewport];

let web: Web;
beforeAll(async () => { web = await startWeb(PAGE, { "@novnc/novnc": join(import.meta.dirname, "novnc.stub.ts") }); }, 60_000);
afterAll(async () => { await web?.close(); });

async function open(size: Size, init?: () => void) {
  const context = await web.browser.newContext({ viewport: size, permissions: ["clipboard-read", "clipboard-write"] });
  const tab = await context.newPage();
  const errors: string[] = [];
  tab.on("pageerror", e => errors.push(e.message));
  if (init) await tab.addInitScript(init);
  await tab.goto(web.url);
  await tab.locator(".status.live").waitFor({ timeout: 15_000 });
  return { tab, errors, close: () => context.close() };
}
async function take(tab: Page) {
  await tab.getByRole("button", { name: "Take control" }).click();
  await tab.getByRole("button", { name: "Release control" }).waitFor({ timeout: 5000 });
}
async function oneRow(tab: Page) {
  const m = await tab.locator(".cb").evaluate(el => ({ h: el.getBoundingClientRect().height, sw: el.scrollWidth, cw: el.clientWidth }));
  expect(m.h).toBeLessThanOrEqual(ROW);
  expect(m.sw).toBeLessThanOrEqual(m.cw);
  expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function fills(tab: Page, size: Size) {
  const s = await tab.locator(".screen").evaluate(el => { const r = el.getBoundingClientRect(); return { bottom: r.bottom, h: r.height }; });
  expect(Math.abs(s.bottom - size.height)).toBeLessThanOrEqual(1);
  expect(s.h).toBeGreaterThanOrEqual(size.height - 2 * ROW - 2);
}

describe("watching", () => {
  it("is view-only at Fit, shows no input controls, and sends nothing, at phone, landscape and tablet sizes", { timeout: 60_000 }, async () => {
    for (const size of [PHONE, LANDSCAPE, TABLET]) {
      const { tab, errors, close } = await open(size);
      const r = await current(tab);
      expect(r.url.endsWith("/api/desktop")).toBe(true);
      expect([r.viewOnly, ...view3(r)]).toEqual([true, true, false, false]);
      for (const name of ["Keyboard", "Paste text", "Copy from desktop", "Fit", "1:1", "Pan", "Esc", "Ctrl", "Release control"])
        expect(await tab.getByRole("button", { name, exact: true }).count(), name).toBe(0);
      expect(await tab.getByRole("toolbar", { name: "Keys for the desktop" }).count()).toBe(0);
      expect(await tab.getByRole("textbox", { name: "Type on the desktop" }).count()).toBe(0);
      await tab.locator(".screen").click();
      await tab.keyboard.type("ab");
      await tab.keyboard.press("Enter");
      expect(await keysSent(tab)).toEqual([]);
      expect((await all(tab)).flatMap(x => x.pasted)).toEqual([]);
      await oneRow(tab);
      await fills(tab, size);
      expect(errors).toEqual([]);
      await close();
    }
  });
});

describe("under control", () => {
  it("the keys row sends each key's keysym; Ctrl and Alt hold for one press; both bars stay one row", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE);
    await take(tab);
    const r = await current(tab);
    expect(r.url.endsWith("/api/desktop?control=1")).toBe(true);
    expect(r.viewOnly).toBe(false);
    const keys = tab.getByRole("toolbar", { name: "Keys for the desktop" });
    const key = (name: string) => keys.getByRole("button", { name, exact: true });
    for (const name of ["Esc", "Tab", "Left", "Up", "Down", "Right", "Enter"]) await key(name).click();
    expect((await current(tab)).keys).toEqual([[XK.Escape, "Escape"], [XK.Tab, "Tab"], [XK.Left, "ArrowLeft"], [XK.Up, "ArrowUp"], [XK.Down, "ArrowDown"], [XK.Right, "ArrowRight"], [XK.Return, "Enter"]]);
    await key("Ctrl").click();
    expect(await key("Ctrl").getAttribute("aria-pressed")).toBe("true");
    await key("Tab").click();
    expect(await key("Ctrl").getAttribute("aria-pressed")).toBe("false");
    await key("Ctrl").click();
    await key("Alt").click();
    await key("Esc").click();
    await key("Ctrl").click();
    await key("Ctrl").click();                                    // a second tap lets go
    expect(await key("Ctrl").getAttribute("aria-pressed")).toBe("false");
    await key("Esc").click();
    expect((await current(tab)).keys.slice(7)).toEqual([
      [XK.Control_L, "ControlLeft", true], [XK.Tab, "Tab"], [XK.Control_L, "ControlLeft", false],
      [XK.Control_L, "ControlLeft", true], [XK.Alt_L, "AltLeft", true], [XK.Escape, "Escape"], [XK.Alt_L, "AltLeft", false], [XK.Control_L, "ControlLeft", false],
      [XK.Escape, "Escape"],
    ]);
    await oneRow(tab);
    const row = await keys.evaluate(el => ({ sw: el.scrollWidth, cw: el.clientWidth, h: el.getBoundingClientRect().height }));
    expect(row.sw).toBeLessThanOrEqual(row.cw);
    expect(row.h).toBeLessThanOrEqual(ROW);
    await fills(tab, PHONE);
    expect(errors).toEqual([]);
    await close();
  });

  it("the keyboard button opens a field whose typing, Backspace and Enter reach the desktop; the keys row keeps it open; Ctrl+c is one combo", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE);
    await take(tab);
    const kb = tab.getByRole("button", { name: "Keyboard", exact: true });
    await kb.click();
    const field = tab.getByRole("textbox", { name: "Type on the desktop" });
    const focused = () => field.evaluate(el => el === document.activeElement);
    await expect.poll(focused).toBe(true);
    expect(await kb.getAttribute("aria-pressed")).toBe("true");
    await tab.keyboard.type("hi");
    await tab.keyboard.press("Backspace");
    await tab.keyboard.press("Enter");
    await tab.keyboard.insertText("é€");
    expect((await current(tab)).keys).toEqual([[0x68, null], [0x69, null], [XK.BackSpace, "Backspace"], [XK.Return, "Enter"], [0xe9, null], [0x010020ac, null]]);
    await tab.getByRole("toolbar", { name: "Keys for the desktop" }).getByRole("button", { name: "Ctrl", exact: true }).click();
    expect(await focused()).toBe(true);
    await tab.keyboard.type("c");
    expect((await current(tab)).keys.slice(6)).toEqual([[XK.Control_L, "ControlLeft", true], [0x63, null], [XK.Control_L, "ControlLeft", false]]);
    // Keyboards that only send input events (Android's, autocorrect): a rewrite, a deletion and a newline.
    const edit = (f: string) => field.evaluate((el, f) => {
      const t = el as HTMLTextAreaElement;
      t.value = f === "rewrite" ? `${t.value.slice(0, -2)}ok` : f === "delete" ? t.value.slice(0, -1) : `${t.value}\n`;
      t.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: f === "rewrite" ? "insertReplacementText" : f === "delete" ? "deleteContentBackward" : "insertLineBreak" }));
    }, f);
    await edit("rewrite");
    await edit("delete");
    await edit("newline");
    expect((await current(tab)).keys.slice(9)).toEqual([[XK.BackSpace, "Backspace"], [XK.BackSpace, "Backspace"], [0x6f, null], [0x6b, null], [XK.BackSpace, "Backspace"], [XK.Return, "Enter"]]);
    await kb.click();
    expect(await kb.getAttribute("aria-pressed")).toBe("false");
    expect(await focused()).toBe(false);
    expect(errors).toEqual([]);
    await close();
  });

  it("Paste text: to the desktop's clipboard, or typed key by key", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE);
    await take(tab);
    const dlg = tab.getByRole("dialog", { name: "Paste text" });
    await tab.getByRole("button", { name: "Paste text", exact: true }).click();
    await dlg.getByRole("textbox", { name: "Text to paste" }).fill("ab1");
    await dlg.getByRole("button", { name: "Send to the desktop's clipboard" }).click();
    expect((await current(tab)).pasted).toEqual(["ab1"]);
    expect((await current(tab)).keys).toEqual([]);
    await expect.poll(() => dlg.count()).toBe(0);
    await tab.getByRole("button", { name: "Paste text", exact: true }).click();
    await dlg.getByRole("textbox", { name: "Text to paste" }).fill("Zy\n");
    await dlg.getByRole("button", { name: "Type it" }).click();
    expect((await current(tab)).keys).toEqual([[0x5a, null], [0x79, null], [XK.Return, "Enter"]]);
    expect((await current(tab)).pasted).toEqual(["ab1"]);
    await expect.poll(() => dlg.count()).toBe(0);
    expect(errors).toEqual([]);
    await close();
  });

  it("Copy from desktop: the desktop's clipboard text with a copy button; nothing kept from watching or after release", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE);
    const clip = (text: string) => tab.evaluate(text => {
      const l = (globalThis as unknown as { __rfb: EventTarget[] }).__rfb;
      l[l.length - 1]!.dispatchEvent(new CustomEvent("clipboard", { detail: { text } }));
    }, text);
    await clip("seen while watching");
    await take(tab);
    const dlg = tab.getByRole("dialog", { name: "Copy from desktop" });
    const text = dlg.getByRole("textbox", { name: "The desktop's clipboard" });
    await tab.getByRole("button", { name: "Copy from desktop", exact: true }).click();
    expect(await text.inputValue()).toBe("");
    await clip("from the desk");
    await expect.poll(() => text.inputValue()).toBe("from the desk");
    await dlg.getByRole("button", { name: "Copy", exact: true }).click();
    await expect.poll(() => tab.evaluate(() => navigator.clipboard.readText())).toBe("from the desk");
    await tab.getByRole("button", { name: "Release control" }).click();
    await tab.getByRole("button", { name: "Take control" }).waitFor();
    expect(await dlg.count()).toBe(0);
    await take(tab);
    await tab.getByRole("button", { name: "Copy from desktop", exact: true }).click();
    expect(await text.inputValue()).toBe("");
    expect(errors).toEqual([]);
    await close();
  });

  it("Fit and 1:1 with Pan, kept on this device; watching stays at Fit; nothing resizes the remote session", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE);
    await take(tab);
    const btn = (name: string) => tab.getByRole("button", { name, exact: true });
    expect(view3(await current(tab))).toEqual([true, false, false]);
    expect(await btn("Fit").getAttribute("aria-pressed")).toBe("true");
    expect(await btn("Pan").count()).toBe(0);
    await btn("1:1").click();
    expect(await btn("1:1").getAttribute("aria-pressed")).toBe("true");
    expect(view3(await current(tab))).toEqual([false, true, false]);
    await btn("Pan").click();
    expect(await btn("Pan").getAttribute("aria-pressed")).toBe("true");
    expect(view3(await current(tab))).toEqual([false, true, true]);
    expect(JSON.parse((await tab.evaluate(() => localStorage.getItem("morndo.desktop.view")))!)).toEqual({ mode: "1:1", pan: true });
    await tab.reload();
    await tab.locator(".status.live").waitFor({ timeout: 15_000 });
    const watching = await current(tab);
    expect([watching.viewOnly, ...view3(watching)]).toEqual([true, true, false, false]);
    await take(tab);
    expect(view3(await current(tab))).toEqual([false, true, true]);
    await btn("Fit").click();
    expect(view3(await current(tab))).toEqual([true, false, false]);
    expect(await btn("Pan").count()).toBe(0);
    expect((await all(tab)).some(x => x.resized)).toBe(false);
    expect(errors).toEqual([]);
    await close();
  });

  it("works when the device's storage refuses (a private window)", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE, () => {
      Object.defineProperty(window, "localStorage", { get() { throw new DOMException("denied", "SecurityError"); } });
    });
    await take(tab);
    expect(view3(await current(tab))).toEqual([true, false, false]);
    await tab.getByRole("button", { name: "1:1", exact: true }).click();
    expect(view3(await current(tab))).toEqual([false, true, false]);
    expect(errors).toEqual([]);
    await close();
  });

  it("release: back to watching, the input controls go, and nothing more is sent", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE);
    await take(tab);
    await tab.getByRole("button", { name: "Keyboard", exact: true }).click();
    await tab.getByRole("button", { name: "Release control" }).click();
    await tab.getByRole("button", { name: "Take control" }).waitFor();
    expect((await current(tab)).viewOnly).toBe(true);
    expect(await tab.getByRole("toolbar", { name: "Keys for the desktop" }).count()).toBe(0);
    expect(await tab.getByRole("textbox", { name: "Type on the desktop" }).count()).toBe(0);
    const before = (await keysSent(tab)).length;
    await tab.keyboard.type("zz");
    await tab.keyboard.press("Enter");
    expect((await keysSent(tab)).length).toBe(before);
    expect(errors).toEqual([]);
    await close();
  });

  it("no Full screen button where the browser has no element full screen (iPhone Safari)", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE, () => {
      Object.defineProperty(Document.prototype, "fullscreenEnabled", { get: () => false });
    });
    expect(await tab.getByRole("button", { name: "Full screen" }).count()).toBe(0);
    await take(tab);
    expect(await tab.getByRole("button", { name: "Full screen" }).count()).toBe(0);
    expect(errors).toEqual([]);
    await close();
  });
});

describe("the held keys' buttons follow what was sent (review 1, T-670)", () => {
  it("Ctrl lets go on screen once a key typed in the field used it; Type it types the text as given and lets go of a held Alt", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE);
    await take(tab);
    const keys = tab.getByRole("toolbar", { name: "Keys for the desktop" });
    const ctrl = keys.getByRole("button", { name: "Ctrl", exact: true });
    const alt = keys.getByRole("button", { name: "Alt", exact: true });
    await tab.getByRole("button", { name: "Keyboard", exact: true }).click();
    await ctrl.click();
    await tab.keyboard.type("c");
    await expect.poll(() => ctrl.getAttribute("aria-pressed")).toBe("false");
    await alt.click();
    await tab.getByRole("button", { name: "Paste text", exact: true }).click();
    const dlg = tab.getByRole("dialog", { name: "Paste text" });
    await dlg.getByRole("textbox", { name: "Text to paste" }).fill("x");
    await dlg.getByRole("button", { name: "Type it" }).click();
    await expect.poll(() => alt.getAttribute("aria-pressed")).toBe("false");
    expect((await current(tab)).keys).toEqual([[XK.Control_L, "ControlLeft", true], [0x63, null], [XK.Control_L, "ControlLeft", false], [0x78, null]]);
    expect(errors).toEqual([]);
    await close();
  });
  it("the panels' text fields are at least 16px, so iPhone Safari doesn't zoom the page into them", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE);
    await tab.addStyleTag({ content: ":root { --font: system-ui, sans-serif; }" });   // the app's font token, as its pages set it
    await take(tab);
    const px = (name: string) => tab.getByRole("textbox", { name }).evaluate(el => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(await px("Type on the desktop")).toBeGreaterThanOrEqual(16);
    await tab.getByRole("button", { name: "Paste text", exact: true }).click();
    expect(await px("Text to paste")).toBeGreaterThanOrEqual(16);
    await tab.getByRole("button", { name: "Copy from desktop", exact: true }).click();
    expect(await px("The desktop's clipboard")).toBeGreaterThanOrEqual(16);
    expect(errors).toEqual([]);
    await close();
  });
});

describe("review 2 (T-670)", () => {
  const field = (tab: Page) => tab.getByRole("textbox", { name: "Type on the desktop" });
  const focused = (tab: Page) => field(tab).evaluate(el => el === document.activeElement);
  async function keyboard(tab: Page) {
    await take(tab);
    await tab.getByRole("button", { name: "Keyboard", exact: true }).click();
    await expect.poll(() => focused(tab)).toBe(true);
  }

  it("the hidden field keeps its caret at the end: a moved caret or a select-all never turns into BackSpaces", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE);
    await keyboard(tab);
    const atEnd = () => field(tab).evaluate(el => { const t = el as HTMLTextAreaElement; return t.selectionStart === t.value.length && t.selectionEnd === t.value.length; });
    await tab.keyboard.type("ab");
    await field(tab).evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(5, 5));
    await expect.poll(atEnd).toBe(true);
    await tab.keyboard.type("x");
    await field(tab).evaluate(el => (el as HTMLTextAreaElement).select());
    await expect.poll(atEnd).toBe(true);
    await tab.keyboard.type("y");
    expect((await current(tab)).keys).toEqual([[0x61, null], [0x62, null], [0x78, null], [0x79, null]]);
    expect(errors).toEqual([]);
    await close();
  });

  it("past twice the field's filler the field resets without a BackSpace and stays focused", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE);
    await keyboard(tab);
    await tab.keyboard.type("a".repeat(120));
    const keys = (await current(tab)).keys;
    expect(keys).toHaveLength(120);
    expect(keys.every(k => JSON.stringify(k) === JSON.stringify([0x61, null]))).toBe(true);
    expect(await focused(tab)).toBe(true);
    expect(errors).toEqual([]);
    await close();
  });

  it("a held Ctrl doesn't outlive control: after release and a new take, Esc goes out plain", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE);
    await take(tab);
    const keys = tab.getByRole("toolbar", { name: "Keys for the desktop" });
    await keys.getByRole("button", { name: "Ctrl", exact: true }).click();
    await tab.getByRole("button", { name: "Release control" }).click();
    await tab.getByRole("button", { name: "Take control" }).waitFor();
    await take(tab);
    expect(await keys.getByRole("button", { name: "Ctrl", exact: true }).getAttribute("aria-pressed")).toBe("false");
    await keys.getByRole("button", { name: "Esc", exact: true }).click();
    expect((await current(tab)).keys).toEqual([[XK.Escape, "Escape"]]);
    expect(errors).toEqual([]);
    await close();
  });

  it("Fit, 1:1 and Pan keep the phone's keyboard up", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE);
    await keyboard(tab);
    for (const name of ["1:1", "Pan", "Fit"]) {
      await tab.getByRole("button", { name, exact: true }).click();
      expect(await focused(tab), name).toBe(true);
    }
    expect(errors).toEqual([]);
    await close();
  });

  it("keys typed in the field don't reach the app's own shortcuts; Shift goes with a named key; Option and AltGr characters are text", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE);
    await keyboard(tab);
    await tab.evaluate(() => {
      const w = globalThis as unknown as { __appKeys: string[] };
      w.__appKeys = [];
      addEventListener("keydown", e => w.__appKeys.push(e.key));
    });
    await tab.keyboard.press("Control+k");
    expect(await tab.evaluate(() => (globalThis as unknown as { __appKeys: string[] }).__appKeys)).toEqual([]);
    await field(tab).evaluate(el => {
      for (const init of [{ key: "Tab", shiftKey: true }, { key: "@", altKey: true }, { key: "@", ctrlKey: true, altKey: true }])
        el.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }));
    });
    expect((await current(tab)).keys).toEqual([
      [XK.Control_L, "ControlLeft", true], [0x6b, null], [XK.Control_L, "ControlLeft", false],
      [0xffe1, "ShiftLeft", true], [XK.Tab, "Tab"], [0xffe1, "ShiftLeft", false],
    ]);
    expect(errors).toEqual([]);
    await close();
  });

  it("Copy is off until the desktop has sent something, so it never empties this device's clipboard", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE);
    await take(tab);
    await tab.getByRole("button", { name: "Copy from desktop", exact: true }).click();
    const copy = tab.getByRole("dialog", { name: "Copy from desktop" }).getByRole("button", { name: "Copy", exact: true });
    expect(await copy.isDisabled()).toBe(true);
    await tab.evaluate(() => {
      const l = (globalThis as unknown as { __rfb: EventTarget[] }).__rfb;
      l[l.length - 1]!.dispatchEvent(new CustomEvent("clipboard", { detail: { text: "from the desk" } }));
    });
    await expect.poll(() => copy.isDisabled()).toBe(false);
    expect(errors).toEqual([]);
    await close();
  });

  it("on a narrow bar a lost connection still says so in words", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE);
    await tab.evaluate(() => {
      const l = (globalThis as unknown as { __rfb: EventTarget[] }).__rfb;
      l[l.length - 1]!.dispatchEvent(new Event("disconnect"));
    });
    const words = tab.getByText("Reconnecting…");
    await expect.poll(async () => (await words.boundingBox())?.width ?? 0).toBeGreaterThan(20);
    expect(errors).toEqual([]);
    await close();
  });

  it("the bar stays one row at 360px with every tool showing (1:1 and Pan)", { timeout: 30_000 }, async () => {
    const small = { width: 360, height: 740 };
    const { tab, errors, close } = await open(small);
    await take(tab);
    await tab.getByRole("button", { name: "1:1", exact: true }).click();
    await tab.getByRole("button", { name: "Pan", exact: true }).waitFor();
    await oneRow(tab);
    const row = await tab.getByRole("toolbar", { name: "Keys for the desktop" }).evaluate(el => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(row.sw).toBeLessThanOrEqual(row.cw);
    expect(errors).toEqual([]);
    await close();
  });
});

describe("review 3 (T-670)", () => {
  type Live = { focusOnClick: boolean; listens: string[]; viewOnly: boolean; disconnected: boolean };
  const live = (tab: Page) => tab.evaluate(() => (globalThis as unknown as { __rfb: Live[] }).__rfb.map(r => ({ focusOnClick: r.focusOnClick, clipboard: r.listens.includes("clipboard"), viewOnly: r.viewOnly, disconnected: r.disconnected })));
  const focusOnClick = async (tab: Page) => (await live(tab)).filter(r => !r.disconnected).at(-1)!.focusOnClick;
  const field = (tab: Page) => tab.getByRole("textbox", { name: "Type on the desktop" });

  it("with the keyboard open, a tap on the screen keeps it open; with it closed, a tap gives noVNC the focus again", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE);
    await take(tab);
    expect(await focusOnClick(tab)).toBe(true);
    const kb = tab.getByRole("button", { name: "Keyboard", exact: true });
    await kb.click();
    await expect.poll(() => focusOnClick(tab)).toBe(false);
    await tab.locator(".screen").click();
    expect(await field(tab).evaluate(el => el === document.activeElement)).toBe(true);
    await kb.click();
    await expect.poll(() => focusOnClick(tab)).toBe(true);
    await tab.locator(".screen").click();
    expect(await tab.evaluate(() => document.activeElement?.tagName)).toBe("CANVAS");
    expect(errors).toEqual([]);
    await close();
  });

  it("only a connection in control listens for the desktop's clipboard", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE);
    const seen = async () => (await live(tab)).map(r => ({ viewOnly: r.viewOnly, clipboard: r.clipboard }));
    expect(await seen()).toEqual([{ viewOnly: true, clipboard: false }]);
    await take(tab);
    await tab.getByRole("button", { name: "Release control" }).click();
    await tab.getByRole("button", { name: "Take control" }).waitFor();
    expect(await seen()).toEqual([{ viewOnly: true, clipboard: false }, { viewOnly: false, clipboard: true }, { viewOnly: true, clipboard: false }]);
    expect(errors).toEqual([]);
    await close();
  });

  it("Paste text forgets what was pasted: after Send, Type it, Close or the bar's button, the box is empty again", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE);
    await take(tab);
    const open_ = tab.getByRole("button", { name: "Paste text", exact: true });
    const dlg = tab.getByRole("dialog", { name: "Paste text" });
    const box = dlg.getByRole("textbox", { name: "Text to paste" });
    for (const how of ["Send to the desktop's clipboard", "Type it", "Close", "the bar's button"]) {
      await open_.click();
      expect(await box.inputValue(), how).toBe("");
      await box.fill("s3cret-123");
      if (how === "the bar's button") await open_.click();
      else await dlg.getByRole("button", { name: how, exact: true }).click();
      await expect.poll(() => dlg.count()).toBe(0);
    }
    await open_.click();
    expect(await box.inputValue()).toBe("");
    expect(errors).toEqual([]);
    await close();
  });

  it("Copy says whether it copied, and says so when neither way could", { timeout: 30_000 }, async () => {
    const clip = (tab: Page) => tab.evaluate(() => {
      const l = (globalThis as unknown as { __rfb: EventTarget[] }).__rfb;
      l[l.length - 1]!.dispatchEvent(new CustomEvent("clipboard", { detail: { text: "from the desk" } }));
    });
    for (const fails of [false, true]) {
      const { tab, errors, close } = await open(PHONE, fails ? () => {
        Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")), readText: () => Promise.reject(new Error("denied")) } });
        Document.prototype.execCommand = () => false;
      } : undefined);
      await take(tab);
      await tab.getByRole("button", { name: "Copy from desktop", exact: true }).click();
      const dlg = tab.getByRole("dialog", { name: "Copy from desktop" });
      await clip(tab);
      await expect.poll(() => dlg.getByRole("button", { name: "Copy", exact: true }).isDisabled()).toBe(false);
      await dlg.getByRole("button", { name: "Copy", exact: true }).click();
      await expect.poll(() => dlg.getByRole("status").innerText()).toMatch(fails ? /^Couldn't copy/ : /^Copied/);
      expect(errors).toEqual([]);
      await close();
    }
  });

  it("from a hardware keyboard: Cmd goes with a named key as Super; Alt+letter is a combo; composed Option and AltGr characters stay text", { timeout: 30_000 }, async () => {
    const { tab, errors, close } = await open(PHONE);
    await take(tab);
    await tab.getByRole("button", { name: "Keyboard", exact: true }).click();
    await expect.poll(() => field(tab).evaluate(el => el === document.activeElement)).toBe(true);
    await field(tab).evaluate(el => {
      for (const init of [
        { key: "ArrowLeft", code: "ArrowLeft", metaKey: true },
        { key: "f", code: "KeyF", altKey: true },
        { key: "ƒ", code: "KeyF", altKey: true },
        { key: "@", code: "KeyQ", ctrlKey: true, altKey: true },
        { key: "t", code: "KeyT", ctrlKey: true, altKey: true },
      ]) el.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }));
    });
    expect((await current(tab)).keys).toEqual([
      [0xffeb, "MetaLeft", true], [XK.Left, "ArrowLeft"], [0xffeb, "MetaLeft", false],
      [XK.Alt_L, "AltLeft", true], [0x66, null], [XK.Alt_L, "AltLeft", false],
      [XK.Control_L, "ControlLeft", true], [XK.Alt_L, "AltLeft", true], [0x74, null], [XK.Alt_L, "AltLeft", false], [XK.Control_L, "ControlLeft", false],
    ]);
    expect(errors).toEqual([]);
    await close();
  });
});
