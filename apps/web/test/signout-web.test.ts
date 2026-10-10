// Signing out here forgets what was written on this device (whole-branch review L3): drafts and the outbox's unsent
// messages, in a real browser's localStorage and IndexedDB; layout choices and the pinned hub identity stay.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { startWeb, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { forgetWritten } from "/src/lib/signout.ts";
  import { openStore } from "/src/lib/outbox/store.ts";
  globalThis.__forget = forgetWritten; globalThis.__openStore = openStore; globalThis.__ready = true;
</script></body></html>`;
type Win = { __forget: () => Promise<void>; __openStore: () => Promise<{ put(r: unknown): Promise<void>; all(): Promise<unknown[]> }>; __ready?: boolean };

let web: Web;
let tab: Page;
beforeAll(async () => { web = await startWeb(PAGE); tab = await web.browser.newPage(); });
afterAll(async () => { await web?.close(); });

describe("signing out on this device", () => {
  it("forgets the drafts and the unsent messages, and keeps the layout and the pinned hub identity", { timeout: 30_000 }, async () => {
    await tab.goto(web.url);
    await tab.waitForFunction(() => (globalThis as unknown as Win).__ready === true);
    const left = await tab.evaluate(async () => {
      const w = globalThis as unknown as Win;
      localStorage.setItem("morndo.drafts", JSON.stringify({ "%1": { name: "alpha", text: "half a thought", seen: null } }));
      localStorage.setItem("morndo.pin", JSON.stringify({ fingerprint: "ab".repeat(32), device: "phone", pairedAt: 1 }));
      localStorage.setItem("morndo.sidebar", "260");
      const outbox = await w.__openStore();
      await outbox.put({ id: "r1", worker: "%1", workerName: "alpha", text: "not sent yet", uploads: [], createdAt: 1, budgetFrom: 1, state: "failed", error: "timeout", attempts: 3, seen: "none", sentAt: null, typedAt: null });
      if ((await outbox.all()).length !== 1) throw new Error("the outbox record wasn't stored");
      await w.__forget();
      return { drafts: localStorage.getItem("morndo.drafts"), pin: localStorage.getItem("morndo.pin") !== null, sidebar: localStorage.getItem("morndo.sidebar"), outbox: (await (await w.__openStore()).all()).length };
    });
    expect(left).toEqual({ drafts: null, pin: true, sidebar: "260", outbox: 0 });
  });
});
