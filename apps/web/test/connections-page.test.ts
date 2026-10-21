// The LLM connections page in Chromium, against a fake hub. One browser, its default context, closed after.
import type {} from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONNECTION_WORDS, type ConnectionsPage } from "@morndo/protocol";
import { expiryMillis, isolationLine } from "../src/lib/connections/line.ts";
import { startWeb } from "./harness.ts";

const SHOTS = mkdtempSync(join(tmpdir(), "morndo-connections-"));
const apiOnly = {
  id: "deepseek", label: "DeepSeek", kinds: ["api-key"] as ("api-key" | "subscription")[], runtimes: ["codex"],
  termsSummary: "Read the terms.", termsSources: ["https://example.com/terms"], isolation: "none" as const,
};
const choice = {
  id: "openai", label: "OpenAI", kinds: ["api-key", "subscription"] as ("api-key" | "subscription")[], runtimes: ["codex"],
  termsSummary: "Read the terms.", termsSources: ["https://example.com/terms"], isolation: "rules" as const,
};
const empty: ConnectionsPage = {
  version: 1, connections: [], mode: "subscriptions-first", order: [], roles: [], alerts: [], catalog: [apiOnly, choice],
};
const row = (over: Partial<ConnectionsPage["connections"][number]>): ConnectionsPage["connections"][number] => ({
  name: "key-a", kind: "api-key", vendor: "openai", runtime: "codex", availability: "ready",
  budgetPercent: 50, budgetLevel: "half", expiry: null, spendSource: "manual", usageFiveHour: null, usageSevenDay: null, ...over,
});
const withConnections: ConnectionsPage = {
  ...empty, version: 2, mode: "subscriptions-first", order: ["sub-a", "key-a"],
  connections: [
    row({ name: "sub-a", kind: "subscription", vendor: "claude", runtime: "claude", budgetPercent: null, budgetLevel: null, spendSource: null, usageFiveHour: 12, usageSevenDay: 40 }),
    row({ expiry: Number(expiryMillis("10 Oct 2026")) }),
  ],
};
const withRole: ConnectionsPage = {
  ...withConnections, version: 3, mode: "keys-only", order: ["sub-a", "key-a"],
  roles: [{ role: "implement", override: "follow", order: ["key-a"], picks: ["key-a:m", "sub-a:m"], riskPicks: [], chain: ["key-a:m"], drifted: false, first: "key-a:m" }],
};
const subscriptionsOnly: ConnectionsPage = {
  ...withConnections, version: 5, mode: "subscriptions-only", order: ["sub-a", "key-a"],
  roles: [{ role: "implement", override: "follow", order: [], picks: ["key-a:m", "sub-a:m"], riskPicks: [], chain: ["sub-a:m"], drifted: false, first: "sub-a:m" }],
};
const withAlert: ConnectionsPage = { ...withRole, version: 4, alerts: [{ kind: "connection", name: "implement", detail: CONNECTION_WORDS.drift }] };

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
  window.__view = ${JSON.stringify(empty)};
  window.__posts = [];
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const headers = { "content-type": "application/json" };
    if (url === "/api/engines") return new Response(JSON.stringify({ error: "engines_off" }), { status: 404, headers });
    if (url.startsWith("/api/connections") && init && init.method === "POST") {
      window.__posts.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(window.__view), { status: 200, headers });
    }
    if (url === "/api/connections") return new Response(JSON.stringify(window.__view), { status: 200, headers });
    return new Response("{}", { status: 404, headers });
  };
</script><script type="module">
  import { mount } from "svelte";
  import Page from "/src/routes/engines/+page.svelte";
  mount(Page, { target: document.body });
</script></body></html>`;

describe("the LLM connections page", () => {
  let web: Awaited<ReturnType<typeof startWeb>>;
  beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
  afterAll(async () => {
    try { await web?.close(); }
    finally { rmSync(SHOTS, { recursive: true, force: true }); }
  });

  it("adds, changes priority, saves a role and revokes, using the protocol words", async () => {
    const page = await web.browser.newPage();
    try {
      await page.goto(web.url);
      await page.getByRole("heading", { name: CONNECTION_WORDS.sections.priority, level: 2 }).waitFor();
      expect(await page.locator("h1").innerText()).toBe(CONNECTION_WORDS.title);
      for (const name of Object.values(CONNECTION_WORDS.sections)) {
        expect(await page.getByRole("heading", { name, level: 2 }).count()).toBe(1);
      }
      expect(await page.getByRole("combobox", { name: CONNECTION_WORDS.sections.priority }).locator("option").allTextContents()).toEqual(Object.values(CONNECTION_WORDS.modes));
      const shot = async (name: string) => {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: join(SHOTS, name), fullPage: true });
      };
      await shot("empty.png");

      await page.getByRole("button", { name: CONNECTION_WORDS.add }).click();
      await page.getByLabel("Name").fill("sub-a");
      expect(await page.getByLabel(CONNECTION_WORDS.fields.vendor).inputValue()).toBe("openai");
      expect(await page.locator(".dialog code").first().innerText()).toBe(CONNECTION_WORDS.signIn.codex);
      expect(await page.locator(".dialog").getByText(CONNECTION_WORDS.signInNotes.codex).count()).toBe(1);
      expect(await page.locator(".dialog code").nth(1).innerText()).toContain("--vendor openai");
      expect(await page.locator(".dialog").getByRole("button", { name: CONNECTION_WORDS.check }).count()).toBe(1);
      await page.getByRole("button", { name: CONNECTION_WORDS.kinds["api-key"] }).click();
      expect(await page.getByLabel(CONNECTION_WORDS.fields.vendor).inputValue()).toBe("deepseek");
      await page.getByLabel("Name").fill("key-a");
      await page.getByLabel(CONNECTION_WORDS.fields.expiry).fill("10 Oct 2026");
      expect(await page.locator("input[type=date]").count()).toBe(0);
      await page.getByRole("combobox", { name: CONNECTION_WORDS.fields.isolation }).selectOption("os");
      expect(await page.getByRole("combobox", { name: CONNECTION_WORDS.fields.isolation }).locator("option").allTextContents()).toEqual(Object.values(CONNECTION_WORDS.isolation));
      const line = await page.locator(".dialog code").first().innerText();
      expect(await page.locator(".dialog code").nth(1).innerText()).toBe(isolationLine("key-a", "os"));
      expect(line).toContain(`--expires ${expiryMillis("10 Oct 2026")}`);
      expect(line.startsWith(CONNECTION_WORDS.addLine)).toBe(true);
      expect(line.endsWith(" < keyfile")).toBe(true);
      expect(line).not.toContain("pbpaste");
      expect(line).not.toMatch(/sk-|secret/);
      expect(await page.locator("input[type=password]").count()).toBe(0);
      await page.evaluate(next => { (window as unknown as { __view: ConnectionsPage }).__view = next; }, withConnections);
      await page.locator(".dialog").getByRole("button", { name: CONNECTION_WORDS.check }).click();
      await page.getByText("50%").waitFor();
      await page.getByText("10 Oct 2026").waitFor();
      expect(await page.getByText(CONNECTION_WORDS.budget.half).count()).toBeGreaterThan(0);
      expect(await page.getByText(CONNECTION_WORDS.windows.fiveHour).count()).toBeGreaterThan(0);
      expect(await page.locator("body").innerText()).not.toMatch(/sk-|ref-key/);
      await page.locator(".dialog").getByRole("button", { name: CONNECTION_WORDS.save, exact: true }).click();
      await shot("connections.png");

      await page.getByRole("combobox", { name: CONNECTION_WORDS.sections.priority }).selectOption("keys-only");
      expect(await page.getByRole("button", { name: CONNECTION_WORDS.moveEarlier }).first().isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: CONNECTION_WORDS.moveLater }).last().isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: CONNECTION_WORDS.moveLater }).first().isDisabled()).toBe(false);
      await page.getByRole("button", { name: CONNECTION_WORDS.moveEarlier }).nth(1).click();
      await page.getByRole("button", { name: CONNECTION_WORDS.saveOrder }).click();

      await page.evaluate(next => { (window as unknown as { __view: ConnectionsPage }).__view = next; }, withRole);
      await page.locator(".block").getByRole("button", { name: CONNECTION_WORDS.check }).click();
      const chainItem = () => page.getByRole("list", { name: CONNECTION_WORDS.chain }).getByRole("listitem").first();
      await expect.poll(() => chainItem().textContent()).toBe("key-a:m");
      const keysChain = await page.getByRole("list", { name: CONNECTION_WORDS.chain }).innerText();
      const keysPreview = await page.getByText(`implement: ${CONNECTION_WORDS.runsFirst}`).innerText();
      expect(keysChain).toContain("key-a:m");
      expect(keysChain).not.toContain("sub-a");
      expect(keysPreview).toBe(`implement: ${CONNECTION_WORDS.runsFirst} key-a:m`);
      await shot("role.png");
      await page.getByRole("combobox", { name: "implement" }).selectOption("own");
      await page.getByRole("button", { name: CONNECTION_WORDS.saveRole }).click();

      await page.evaluate(next => { (window as unknown as { __view: ConnectionsPage }).__view = next; }, subscriptionsOnly);
      await page.locator(".block").getByRole("button", { name: CONNECTION_WORDS.check }).click();
      await expect.poll(() => chainItem().textContent()).toBe("sub-a:m");
      const subsChain = await page.getByRole("list", { name: CONNECTION_WORDS.chain }).innerText();
      const subsPreview = await page.getByText(`implement: ${CONNECTION_WORDS.runsFirst}`).innerText();
      expect(subsChain).toContain("sub-a:m");
      expect(subsChain).not.toContain("key-a");
      expect(subsPreview).toBe(`implement: ${CONNECTION_WORDS.runsFirst} sub-a:m`);
      const drifted: ConnectionsPage = { ...withRole, roles: [{ ...withRole.roles[0]!, drifted: true }] };
      await page.evaluate(next => { (window as unknown as { __view: ConnectionsPage }).__view = next; }, drifted);
      await page.locator(".block").getByRole("button", { name: CONNECTION_WORDS.check }).click();
      await page.getByRole("button", { name: CONNECTION_WORDS.reapply }).waitFor();
      expect(await page.getByText(CONNECTION_WORDS.drift).count()).toBeGreaterThan(0);
      await shot("drift.png");
      await page.getByRole("button", { name: CONNECTION_WORDS.reapply }).click();
      await page.getByRole("button", { name: CONNECTION_WORDS.keepHand }).click();

      await page.evaluate(next => { (window as unknown as { __view: ConnectionsPage }).__view = next; }, withAlert);
      await page.locator(".block").getByRole("button", { name: CONNECTION_WORDS.check }).click();
      await page.getByText(CONNECTION_WORDS.drift).waitFor();
      await shot("alert.png");

      page.once("dialog", dialog => void dialog.accept());
      await page.getByRole("list", { name: CONNECTION_WORDS.sections.connections }).getByRole("button", { name: CONNECTION_WORDS.revoke }).nth(1).click();

      const posts = await page.evaluate(() => (window as unknown as { __posts: { url: string; body: { mode?: string; order?: string[]; override?: string; action?: string; name?: string } }[] }).__posts);
      expect(posts.map(item => item.url)).toEqual(["/api/connections/priority", "/api/connections/role", "/api/connections/role", "/api/connections/role", "/api/connections/revoke"]);
      expect(posts[0]?.body.mode).toBe("keys-only");
      expect(posts[0]?.body.order?.[0]).toBe("key-a");
      expect(posts[1]?.body.override).toBe("own");
      expect(posts[1]?.body.order).toEqual(["key-a"]);
      expect(posts[1]?.body.action).toBe("save");
      expect(posts[2]?.body.action).toBe("reapply");
      expect(posts[3]?.body.action).toBe("keep-hand");
      expect(posts[3]?.body.override).toBe("hand");
      expect(posts[4]?.body.name).toBe("key-a");
    } finally { await page.close(); }
  }, 30_000);
});
