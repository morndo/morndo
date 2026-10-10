// Validator for review finding #3 (range 4272ccc..84e2b42): a task row on Today whose answer the hub refused with
// `step_up` must lead to a passkey check before it goes again (ADR-0009: "If the hub still says step_up on arrival, the
// card offers 'Confirm with passkey and send'"; the readability pass: a row's Done goes "by the same path as a
// decision's answer"). Phone passes Today a verifiedFresh that is derived from a `now` ticking every 15 s, so it can be
// true while the hub already says step_up; this mounts Today with verifiedFresh true to model that window.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { startWeb, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Today from "/src/lib/phone/Today.svelte";
  import { QuickAnswers } from "/src/lib/phone/quick.svelte.ts";
  import { postAnswer } from "/src/lib/catchup/answer.ts";
  const w = globalThis;
  w.__log = []; w.__verified = false;
  // The hub: an answer is refused with step_up until a passkey check happened, then accepted.
  const realFetch = w.fetch.bind(w);
  w.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (url.includes("/api/escalations/") && url.endsWith("/answer")) {
      if (!w.__verified) { w.__log.push("post:step_up"); return new Response(JSON.stringify({ error: "step_up" }), { status: 403, headers: { "content-type": "application/json" } }); }
      w.__log.push("post:ok"); return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input, init);
  };
  const now = Date.now();
  const task = {
    id: "t1", asker: { kind: "manager", name: "manager", workerId: null }, need: "time", title: "Water the plants in the office",
    shortTitle: "Water the plants", summary: "The plants need water today.", minutes: 5, link: null, details: null,
    context: null, contextKind: "markdown", options: [], answerBy: "words", recommendation: null, ifNoAnswer: null,
    deadline: null, blocking: false, project: null, askedAt: now - 60_000, messageId: null, tracking: "ledger",
    status: "open", source: "open", decision: null, resolution: null, settledAt: null, askedAgain: false, answerable: null, version: "v1",
  };
  const feed = { decisions: [task], workers: [], primed: true, status: "live", caughtUpAt: null };
  const session = { later: {}, cards: [], count: 0 };
  const quick = new QuickAnswers((id, body, seen, requestId) => postAnswer(id, body, seen, requestId));
  quick.start();
  const verify = async () => { w.__log.push("verify"); w.__verified = true; return true; };
  mount(Today, { target: document.body, props: { feed, session, quick, verifiedFresh: true, verify, onCatchUp: () => {}, onDecide: () => {} } });
  w.__ready = true;
</script></body></html>`;
type Win = { __log: string[]; __ready?: boolean };

let web: Web;
let tab: Page;
beforeAll(async () => { web = await startWeb(PAGE); tab = await web.browser.newPage(); });
afterAll(async () => { await web?.close(); });

describe("a task's Done refused with step_up on Today", () => {
  it("leads to a passkey check before the answer goes again", { timeout: 45_000 }, async () => {
    await tab.goto(web.url);
    await tab.waitForFunction(() => (globalThis as unknown as Win).__ready === true);
    const row = tab.locator('[data-row][data-kind="task"]');
    await row.getByRole("button", { name: "Done", exact: true }).click();
    // The 5-second window, then the hub's refusal.
    await tab.waitForFunction(() => (globalThis as unknown as Win).__log.length === 1, undefined, { timeout: 15_000 });
    await expect.poll(() => row.getByRole("alert").first().textContent()).toBe("Not sent: confirm with your passkey, then it goes.");

    // What he can do now: a passkey button if the row offers one, else Done again.
    const passkey = row.getByRole("button", { name: /passkey/i });
    if (await passkey.count()) await passkey.first().click();
    else await row.getByRole("button", { name: "Done", exact: true }).click();
    await tab.waitForFunction(() => (globalThis as unknown as Win).__log.filter(x => x.startsWith("post:")).length === 2, undefined, { timeout: 15_000 }).catch(() => {});

    const log = await tab.evaluate(() => (globalThis as unknown as Win).__log);
    expect(log).toEqual(["post:step_up", "verify", "post:ok"]);
  });
});
