// A lane's details (ADR-0034): the About card names the account with a fresh session on that lane by its label —
// email, organization, plan — and shows no Account field when no account reports there. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const NOW = Date.UTC(2026, 9, 11, 21, 0, 0);

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="with"></div><div id="without"></div><script type="module">
  import { mount } from "svelte";
  import DetailsModal from "/src/lib/desktop/DetailsModal.svelte";
  const worker = {
    id: "%1", name: "builder", location: "/work/builder", node: "local",
    title: "The board's usage", lastMessageAt: null, needsYou: false, waitingOn: null,
    state: "active", changedAt: 0, offline: false,
  };
  const prefs = { show: "clean", activity: true, muted: false, starred: false };
  const account = {
    account: "a3", reportedAt: ${NOW}, fiveHour: null, sevenDay: null, spend: null,
    limits: null, onDemand: null, profile: { email: "ada@example.test", org: "team", plan: "Max 5x" },
    sessions: [{ sessionId: "s1", lane: "builder", model: "Opus", contextUsed: null, at: ${NOW} }],
  };
  const props = account => ({ worker, displayName: "builder", session: undefined, account, prefs, onPrefs: () => {}, onScreen: () => {}, onClose: () => {} });
  mount(DetailsModal, { target: document.getElementById("with"), props: props(account) });
  mount(DetailsModal, { target: document.getElementById("without"), props: props(null) });
</script></body></html>`;

let web: Web;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });

describe("a lane's details: the Account field", () => {
  it("with an account reporting on the lane, About shows its label; without one, there is no Account field", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    tab.on("pageerror", e => errors.push(e.message.split("\n")[0] ?? ""));
    await tab.goto(web.url);
    const withAccount = tab.locator("#with .field", { hasText: "Account" });
    await withAccount.waitFor();
    expect(await withAccount.count()).toBe(1);
    expect(await withAccount.innerText()).toContain("ada@example.test · Team · Max 5x");
    expect(await tab.locator("#with .field", { hasText: "Session" }).count()).toBe(1);   // the card itself rendered
    expect(await tab.locator("#without .field", { hasText: "Account" }).count()).toBe(0);
    expect(errors).toEqual([]);
    await tab.close();
  });
});
