// The page guard of the web harness (harness.ts), apart so a unit test can drive it with a stand-in page
// (steady.test.ts). Types only from playwright: this file starts no browser.
import type { Browser, Page, Request as PageRequest } from "playwright";

// Chromium fails every request in flight with net::ERR_NETWORK_CHANGED when an address comes or goes on any of the
// machine's interfaces, though the page only talks to 127.0.0.1 (crbug.com/974711, closed as won't fix). Where other
// work creates and removes container networks, a bridge's address does so every few seconds. A page whose modules were
// cut that way still fires load but mounts nothing, and its test reads an empty page or waits out its timeout: seen
// 2026-10-12, every module request of two pages failing in the same millisecond, as a container network went away.
// So a steady() browser's page.goto loads again when that load itself was cut: a request of it failed that way and
// then goto threw (whatever its words), or a module script of the page failed to load (its own fetch or one it
// imports), so none of the page's code ran and loading again repeats nothing. Any other failure stands, as does a cut
// that left the modules whole: a request after the page started (a lazy chunk, a fetch) fails in the test as before,
// out of this guard's reach. reload() is never repeated: a test reloads to see what the page kept. Up to 4 loads,
// 250 ms, 500 ms and 1 s apart (1.75 s in all, within the test's 20 s): one container's start or stop is a burst of
// address changes, and a load at once after a cut was cut again (5 of 50 runs beside two container churners). A
// fourth load whose modules were cut too fails, naming the cut. The module check of a page that navigated meanwhile (a
// redirect at boot) waits for the new document's load and asks it once more.
// browser.newPage() makes its context with newContext too.
export function steady(browser: Browser): Browser {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    const newPage = context.newPage.bind(context);
    context.newPage = async () => loadsAgainWhenCut(await newPage());
    return context;
  };
  return browser;
}

const CUT = "net::ERR_NETWORK_CHANGED";
const PAUSES = [250, 500, 1000];
// In each document of the page: a module script that could not be loaded fires error at its element (HTML, "execute
// the script element"); errors of the page's own code do not.
const MODULES_FAILED = `addEventListener("error", e => {
  if (e.target instanceof HTMLScriptElement && e.target.type === "module") globalThis.__morndoModulesFailed = true;
}, true);`;

export async function loadsAgainWhenCut(page: Page, pauses: readonly number[] = PAUSES): Promise<Page> {
  await page.addInitScript({ content: MODULES_FAILED });
  const goto = page.goto.bind(page);
  page.goto = (async (url: string, options?: Parameters<Page["goto"]>[1]) => {
    for (let load = 0; ; load++) {
      let cut = false;
      const failed = (r: PageRequest) => { if (r.failure()?.errorText === CUT) cut = true; };
      page.on("requestfailed", failed);
      let response: Awaited<ReturnType<Page["goto"]>> | undefined;
      try {
        response = await goto(url, options);
      } catch (e) {
        if ((!cut && !String(e).includes(CUT)) || load === pauses.length) throw e;
      } finally { page.off("requestfailed", failed); }
      if (response !== undefined) {
        if (!cut || !(await modulesFailed(page))) return response;
        if (load === pauses.length) throw new Error(`${CUT} cut the modules of ${url} on all ${load + 1} loads`);
      }
      console.warn(`${CUT} cut this page's load ${load + 1}: loading it again`);
      await new Promise(resolve => { setTimeout(resolve, pauses[load]); });
    }
  }) as Page["goto"];
  return page;
}

// Whether this document's module scripts failed (MODULES_FAILED). A page that navigated since (a redirect at boot)
// destroys the context the question was asked in: then the new document is asked, once its load has fired.
async function modulesFailed(page: Page): Promise<boolean> {
  const ask = () => page.evaluate(() => (globalThis as { __morndoModulesFailed?: boolean }).__morndoModulesFailed === true);
  try { return await ask(); }
  catch (e) {
    if (!String(e).includes("Execution context was destroyed")) throw e;
    await page.waitForLoadState("load");
    return ask();
  }
}
