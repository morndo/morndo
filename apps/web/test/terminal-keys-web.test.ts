// Keys typed from the terminal view (ADR-0006, AC9) whose fate the hub can't tell (fleet core §3.1): the worker's
// machine may have typed them before the hub lost touch, so the hub answers `keys_uncertain`, and the view says they may
// have been typed, never that the pane refused them; a real refusal (`keys_refused`) still reads as one. The real
// TerminalView in headless Chromium; the terminal socket faked in the page. Synthetic frames only.
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import TerminalView from "/src/lib/desktop/TerminalView.svelte";
  mount(TerminalView, { target: document.body, props: { pane: "pc.3fa2c1d0.1", name: "alpha", verifiedAt: Date.now(), onVerified: () => {} } });
</script></body></html>`;

// Runs in the page before the app: /api/terminal answers with control and one frame; the test pushes the rest.
function fakeTerminal() {
  type Socket = new (url: string | URL, protocols?: string | string[]) => unknown;
  const w = globalThis as unknown as { WebSocket: Socket; __termPush: (m: unknown) => void };
  const Real = w.WebSocket;
  class Term {
    readyState = 0;
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    constructor() {
      w.__termPush = m => setTimeout(() => this.onmessage?.({ data: JSON.stringify(m) }), 0);
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.({});
        w.__termPush({ t: "mode", control: true });
        w.__termPush({ t: "frame", cols: 20, rows: 2, x: 2, y: 0, cursor: true, lines: ["$ ", ""] });
      }, 0);
    }
    send() {}
    close() { this.readyState = 3; }
  }
  const Fake = function (url: string | URL, protocols?: string | string[]) {
    return String(url).includes("/api/terminal") ? new Term() : new Real(url, protocols);
  } as unknown as Socket;
  Object.assign(Fake, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  w.WebSocket = Fake;
}

let web: Web;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });

describe("keys the hub can't vouch for", () => {
  it("keys_uncertain: may have been typed; keys_refused: the pane didn't take them", { timeout: 30_000 }, async () => {
    const tab: Page = await web.browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors: string[] = [];
    tab.on("pageerror", e => errors.push(e.message));
    await tab.addInitScript(fakeTerminal);
    await tab.goto(web.url);
    const note = tab.locator(".note");
    const push = (m: unknown) => tab.evaluate(x => (globalThis as unknown as { __termPush: (m: unknown) => void }).__termPush(x), m);
    await tab.locator(".xterm-screen").waitFor({ timeout: 15_000 });
    await push({ t: "error", error: "keys_uncertain" });
    await expect.poll(() => note.innerText(), { timeout: 5000 }).toBe("Those keys may have been typed.");
    await push({ t: "error", error: "keys_refused" });
    await expect.poll(() => note.innerText(), { timeout: 5000 }).toBe("The pane didn't take those keys.");
    expect(errors).toEqual([]);
    await tab.close();
  });
});
