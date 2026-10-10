// Validation of review finding #2 (quick.svelte.ts #save): a task's answer from Today that is in flight, or still in its
// window, when the installed app is killed must not vanish after the reload. Catch-up keeps such an answer and reports it
// ("Not sure it went" / "Not sent", session.svelte.ts:77-84, run.ts:34 "never dropped silently"). The real QuickAnswers,
// compiled by Vite's Svelte plugin, in headless Chromium; the page reload stands in for iOS killing the app.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { QuickAnswers } from "/src/lib/phone/quick.svelte.ts";
  window.__Q = QuickAnswers;
  window.__ready = true;
</script></body></html>`;

type QState = { pending: Record<string, { sending: boolean; requestId: string }>; sent: Record<string, unknown>; failed: Record<string, { code: string }> };
type Win = { __Q: new (answer: (...a: unknown[]) => Promise<unknown>) => { state: QState; answer: (...a: unknown[]) => void; flush: () => void; tick: (all?: boolean) => Promise<void> }; __ready?: boolean };

let web: Web;
let tab: Page;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });
afterEach(async () => { await tab.context().close(); });

async function open() {
  tab = await (await web.browser.newContext()).newPage();
  await tab.goto(web.url);
  await tab.waitForFunction(() => (globalThis as unknown as Win).__ready === true);
}
// What a fresh QuickAnswers (the app after a reload) reads back from the device for this task.
async function afterReload(id: string) {
  await tab.reload();
  await tab.waitForFunction(() => (globalThis as unknown as Win).__ready === true);
  return tab.evaluate(i => {
    const s = new (globalThis as unknown as Win).__Q(() => new Promise(() => {})).state;
    return { pending: s.pending[i] ?? null, failed: s.failed[i] ?? null, sent: s.sent[i] ?? null };
  }, id);
}

describe("a task's answer from Today across a reload (finding #2)", () => {
  it("control: an answer the hub took is read back as sent", async () => {
    await open();
    await tab.evaluate(async () => {
      const q = new (globalThis as unknown as Win).__Q(async () => ({ ok: true }));
      q.answer("ny-6", { key: "done" }, "Done", "v1", "req-6");
      await q.tick(true);
    });
    expect((await afterReload("ny-6")).sent).not.toBeNull();
  });

  it("an answer whose POST is in flight when the app dies is not dropped silently", async () => {
    await open();
    const before = await tab.evaluate(() => {
      const q = new (globalThis as unknown as Win).__Q(() => new Promise(() => {}));   // the POST never comes back
      q.answer("ny-5", { key: "done" }, "Done", "v1", "req-5");
      q.flush();                                                                         // the page is hidden: it goes now
      return q.state.pending["ny-5"];
    });
    expect(before?.sending).toBe(true);                                                  // it was in flight
    const r = await afterReload("ny-5");
    expect(r.pending ?? r.failed ?? r.sent, "after the reload nothing is left of the in-flight answer").not.toBeNull();
  });

  it("an answer still in its window when the app dies is not dropped silently", async () => {
    await open();
    await tab.evaluate(() => {
      const q = new (globalThis as unknown as Win).__Q(() => new Promise(() => {}));
      q.answer("ny-7", { key: "done" }, "Done", "v1", "req-7");                          // killed before flush ran
    });
    const r = await afterReload("ny-7");
    expect(r.pending ?? r.failed ?? r.sent, "after the reload nothing is left of the answer in its window").not.toBeNull();
  });
});
