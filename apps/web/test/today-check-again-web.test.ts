// Today's Check again on a task's answer the hub kept in doubt (409 uncertain; B1 V8, S7 for an answer, E8): it keeps the
// doubt until the hub settles it. Undo inside its 5-second window, the app closed inside it, or a 403 step_up put the
// doubt back, and the passkey confirm sends the same request id. Real Today.svelte, QuickAnswers and postAnswer; the hub
// faked at fetch. Synthetic data only.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Escalations, escalationId, type Ask } from "@morndo/domain";
import { REFUSALS } from "../src/lib/desktop/decisions.ts";
import { startWeb, type Web } from "./harness.ts";

const NOW = Date.now();
const ask: Ask = {
  id: escalationId("ny-8"), asker: { kind: "manager", name: "Manager", workerId: "pc.aaaaaaaa.0" }, need: "time",
  title: "Sign the delivery note", shortTitle: null, summary: null, minutes: null, link: null, details: null, context: null, contextKind: "markdown",
  options: [{ key: "yes", label: "Signed it", detail: null }, { key: "no", label: "Can't today", detail: null }],
  answerBy: "tap", recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null,
  askedAt: NOW - 20 * 60_000, messageId: null, tracking: "ledger",
};
const board = new Escalations();
board.reconcile([{ ask, source: { kind: "open" as const }, answered: null }], NOW, true);
const TASK = { ...board.get("ny-8"), answerable: null, version: "v-ny-8" };
const UNCERTAIN = REFUSALS.uncertain ?? "";

// ?fresh=0: the passkey check has lapsed (verifiedFresh false).
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Today from "/src/lib/phone/Today.svelte";
  import { QuickAnswers } from "/src/lib/phone/quick.svelte.ts";
  import { postAnswer } from "/src/lib/catchup/answer.ts";
  const w = globalThis;
  const q = new URLSearchParams(location.search);
  w.__posts = []; w.__replies = w.__replies ?? [];
  const realFetch = w.fetch.bind(w);
  w.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (!/\\/api\\/escalations\\/[^/]+\\/answer$/.test(url)) return realFetch(input, init);
    const r = w.__replies.shift() ?? { status: 200, body: { ok: true } };
    w.__posts.push(JSON.parse(init.body));
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
  const quick = new QuickAnswers((id, body, seen, requestId) => postAnswer(id, body, seen, requestId));
  w.__quick = quick;
  const feed = { decisions: [${JSON.stringify(TASK)}], workers: [], status: "live", primed: true, caughtUpAt: null };
  mount(Today, { target: document.body, props: { feed, session: { later: {}, cards: [], count: 0 }, quick, verifiedFresh: q.get("fresh") !== "0", verify: async () => true, onCatchUp: () => {}, onDecide: () => {} } });
  w.__ready = true;
</script></body></html>`;

type Win = { __posts: { requestId: string; key?: string }[]; __replies: { status: number; body: unknown }[]; __ready?: boolean;
  __quick: { flush(): void; state: { pending: Record<string, unknown> } } };

let web: Web;
let tab: Page;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });
afterEach(async () => { await tab?.context().close(); });

async function inDoubt(query: string, replies: { status: number; body: unknown }[]) {
  tab = await (await web.browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await tab.addInitScript(r => { (globalThis as unknown as Win).__replies = r; }, [{ status: 409, body: { error: "uncertain" } }, ...replies]);
  await tab.goto(`${web.url}?${query}`);
  await tab.waitForFunction(() => (globalThis as unknown as Win).__ready === true);
  const row = tab.locator('li[data-row="d:ny-8"]');
  await row.getByRole("button", { name: "Signed it" }).click({ timeout: 15_000 });
  await tab.waitForFunction(() => (globalThis as unknown as Win).__quick.state.pending["ny-8"] !== undefined);
  await tab.evaluate(() => (globalThis as unknown as Win).__quick.flush());
  await row.getByText(UNCERTAIN).waitFor({ timeout: 10_000 });
  return row;
}
const posts = () => tab.evaluate(() => (globalThis as unknown as Win).__posts);

describe("Today: Check again on an answer in doubt keeps the doubt until it is settled", () => {
  it("Undo inside Check again's window: the answer is in doubt again, with Check again; nothing was sent", { timeout: 60_000 }, async () => {
    const row = await inDoubt("fresh=1", []);
    await row.getByRole("button", { name: "Check again" }).click();
    await row.getByRole("button", { name: "Undo" }).click({ timeout: 10_000 });
    await row.getByText(UNCERTAIN).waitFor({ timeout: 10_000 });
    expect(await row.getByRole("button", { name: "Check again" }).count()).toBe(1);
    expect(await posts()).toHaveLength(1);
  });

  it("the app closed inside Check again's window: read back in doubt, never 'Not sent'", { timeout: 60_000 }, async () => {
    const row = await inDoubt("fresh=1", []);
    await row.getByRole("button", { name: "Check again" }).click();
    await row.getByRole("button", { name: "Undo" }).waitFor({ timeout: 10_000 });
    await tab.reload();                                             // no visibilitychange flush on this page: a kill
    await tab.waitForFunction(() => (globalThis as unknown as Win).__ready === true);
    const back = tab.locator('li[data-row="d:ny-8"]');
    await back.getByText(UNCERTAIN).waitFor({ timeout: 10_000 });
    expect(await back.getByText(/Not sent/).count()).toBe(0);
    expect(await back.getByRole("button", { name: "Check again" }).count()).toBe(1);
  });

  it("Check again refused for the passkey check: still in doubt, and the confirm sends the same request id", { timeout: 60_000 }, async () => {
    const row = await inDoubt("fresh=0", [{ status: 403, body: { error: "step_up" } }]);
    await row.getByRole("button", { name: "Check again" }).click();
    await tab.waitForFunction(() => (globalThis as unknown as Win).__quick.state.pending["ny-8"] !== undefined);
    await tab.evaluate(() => (globalThis as unknown as Win).__quick.flush());
    await tab.waitForFunction(() => (globalThis as unknown as Win).__posts.length === 2);
    await row.getByRole("button", { name: /Confirm with passkey and send/ }).waitFor({ timeout: 10_000 });
    expect(await row.getByText(UNCERTAIN, { exact: false }).count()).toBe(1);
    await row.getByRole("button", { name: /Confirm with passkey and send/ }).click();
    await tab.waitForFunction(() => (globalThis as unknown as Win).__quick.state.pending["ny-8"] !== undefined);
    await tab.evaluate(() => (globalThis as unknown as Win).__quick.flush());
    await tab.waitForFunction(() => (globalThis as unknown as Win).__posts.length === 3);
    expect(new Set((await posts()).map(p => p.requestId)).size).toBe(1);
  });
});
