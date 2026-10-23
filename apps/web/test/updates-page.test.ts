// The Updates page (updates design §8.2 "Settings → Updates", PR 6c part 2), in headless Chromium: the rows render
// from an UpdatesView, each action runs through withStepUp and posts its body, a 409 shows the fleet's own words, a
// 503 says who could not be asked, a 404 updates_off says updates aren't on this hub — and the Sidebar and the
// SettingsSheet offer the Updates link the way they offer the Engines one. The hub is faked at the browser's edge.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { startWeb, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  const w = window;
  const real = w.fetch.bind(w);
  // The passkey ceremony itself, faked as composer-check-typed-web.test.ts fakes it: the prompt answers at once.
  const buf = () => new Uint8Array([1, 2, 3]).buffer;
  navigator.credentials.get = async () => ({
    id: "AQID", rawId: buf(), type: "public-key", authenticatorAttachment: "platform", getClientExtensionResults: () => ({}),
    response: { authenticatorData: buf(), clientDataJSON: buf(), signature: buf(), userHandle: null },
  });
  w.__gets = 0; w.__posts = []; w.__commands = []; w.__stepups = 0;
  const now = Date.now();
  const rollout = { version: "0.5.0", controlPlaneCommittedAt: now - 40 * 60_000, soakMinutes: 30, halted: false, haltedBy: null, haltReason: null, haltedAt: null };
  const status = (o = {}) => ({ installMethod: "updater", channel: "stable", mode: "apply", pin: null, window: null,
    current: "0.4.2", previous: "0.4.1", good: "0.4.2", staged: null, feed: null, keySet: null, lastCheck: null, checks: [], ...o });
  w.__view = {
    controlPlane: { version: "0.4.2", commit: null, status: status({ staged: "0.5.0" }), state: null },
    rollout,
    aboveControlPlane: [],
    nodes: [
      { name: "pc", status: "online", version: "0.4.2", proto: [1], update: { state: "waiting", version: "0.4.2", target: "0.5.0", reason: "waiting_jitter" } },
      { name: "studio", status: "offline", version: null, proto: null, update: null },
    ],
  };
  const q = new URLSearchParams(location.search).get("case");
  if (q === "halted") {
    const halted = { ...rollout, halted: true, haltedBy: "pc", haltReason: "node health (fleet connection) failed", haltedAt: now };
    w.__view = {
      controlPlane: { version: "0.4.2", commit: null, status: status(), state: null },
      rollout: halted, aboveControlPlane: [halted],
      nodes: [{ name: "pc", status: "online", version: "0.4.2", proto: [1], update: { state: "rolled_back", version: "0.4.2", target: "0.5.0", failedCheck: "node health (fleet connection)" } }],
    };
  }
  const off = q === "off";
  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  w.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = new URL(url, "http://t.test").pathname;
    if (path === "/api/updates") { w.__gets++; return off ? json({ error: "updates_off" }, 404) : json(w.__view); }
    if (path.startsWith("/api/updates/")) {
      w.__posts.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      const next = w.__commands.shift() ?? { status: 200 };
      return json(next.body ?? { ok: true }, next.status);
    }
    if (path === "/api/stepup/options") return json({ flowId: "flow-1", options: { challenge: "AAAA", rpId: location.hostname, allowCredentials: [], userVerification: "required", timeout: 60_000 } });
    if (path === "/api/stepup/verify") { w.__stepups++; return json({ ok: true }); }
    return real(input, init);
  };
  import { mount } from "svelte";
  import Page from "/test/updates-page-page.svelte";
  mount(Page, { target: document.body });
</script></body></html>`;

type Post = { path: string; body: unknown };
type Win = { __gets: number; __posts: Post[]; __commands: { status: number; body?: unknown }[]; __stepups: number };

describe("the Updates page", () => {
  let web: Web;
  beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
  afterAll(async () => { await web?.close(); });

  async function open(case_ = ""): Promise<Page> {
    const page = await web.browser.newPage();
    await page.goto(case_ === "" ? web.url : `${web.url}?case=${case_}`);
    await page.locator("[data-machine=control-plane]").getByText("This machine").waitFor();
    return page;
  }
  const win = (page: Page) => page.evaluate(() => {
    const w = globalThis as unknown as Win;
    return { __gets: w.__gets, __posts: w.__posts, __stepups: w.__stepups };
  });

  it("renders a row per machine, the Rollout line, and the words that channel and mode are set on the machine", async () => {
    const page = await open();
    try {
      const cp = page.locator("[data-machine=control-plane]");
      expect(await cp.textContent()).toContain("staged 0.5.0 (ready to apply)");
      expect(await cp.textContent()).toContain("Version 0.4.2");
      expect(await cp.textContent()).toContain("Channel stable · mode apply");
      const pc = page.locator("[data-machine=pc]");
      expect(await pc.textContent()).toContain("waiting: this node's own delay is still running");
      expect(await pc.textContent()).toContain("run morndo update --rollback on pc");
      expect(await pc.textContent()).toContain("Channel and mode unknown here");
      const studio = page.locator("[data-machine=studio]");
      expect(await studio.textContent()).toContain("offline");
      expect(await studio.textContent()).toContain("Version unknown");
      expect(await page.locator("[data-rollout]").textContent()).toContain("Rollout 0.5.0");
      expect(await page.locator("[data-rollout]").textContent()).toContain("committed");
      expect(await page.locator("[data-updates] .sum").textContent()).toContain("Channel and mode are set with");
      expect(await page.locator("[data-updates] .sum").textContent()).toContain("morndo update");
    } finally { await page.close(); }
  });

  it("Update now posts apply with the machine and the Version, then loads the view again", async () => {
    const page = await open();
    try {
      await page.locator("[data-machine=control-plane]").getByRole("button", { name: "Update now" }).click();
      await page.waitForFunction(() => (globalThis as unknown as Win).__posts.length === 1);
      expect(await win(page)).toMatchObject({
        __posts: [{ path: "/api/updates/apply", body: { machine: "control-plane", version: "0.5.0" } }],
        __gets: 2,
      });
    } finally { await page.close(); }
  });

  it("a 403 step_up runs the passkey check (faked) and posts the command again", async () => {
    const page = await open();
    try {
      await page.evaluate(() => { (globalThis as unknown as Win).__commands = [{ status: 403, body: { error: "step_up" } }]; });
      await page.locator("[data-machine=pc]").getByRole("button", { name: "Update now" }).click();
      await page.waitForFunction(() => (globalThis as unknown as Win).__posts.length === 2 && (globalThis as unknown as Win).__stepups === 1);
      const w = await win(page);
      expect(w.__stepups).toBe(1);
      expect(w.__posts).toEqual([
        { path: "/api/updates/apply", body: { machine: "pc", version: "0.5.0" } },
        { path: "/api/updates/apply", body: { machine: "pc", version: "0.5.0" } },
      ]);
    } finally { await page.close(); }
  });

  it("a 409 shows the fleet's message as it came", async () => {
    const page = await open();
    try {
      await page.evaluate(() => { (globalThis as unknown as Win).__commands = [{ status: 409, body: { error: "refused", message: "the Rollout of 0.5.0 is halted (RL12)" } }]; });
      await page.locator("[data-machine=pc]").getByRole("button", { name: "Update now" }).click();
      await expect.poll(() => page.getByRole("alert").textContent()).toContain("the Rollout of 0.5.0 is halted (RL12)");
    } finally { await page.close(); }
  });

  it("a 503 says the fleet or the updater could not be asked", async () => {
    const page = await open();
    try {
      await page.evaluate(() => { (globalThis as unknown as Win).__commands = [{ status: 503, body: { error: "unavailable", message: "the fleet did not answer" } }]; });
      await page.locator("[data-machine=pc]").getByRole("button", { name: "Update now" }).click();
      await expect.poll(() => page.getByRole("alert").textContent()).toContain("could not be asked");
      expect(await page.getByRole("alert").textContent()).toContain("the fleet did not answer");
    } finally { await page.close(); }
  });

  it("Roll back asks first, then posts rollback for the control plane", async () => {
    const page = await open();
    try {
      const cp = page.locator("[data-machine=control-plane]");
      await cp.getByRole("button", { name: "Roll back…" }).click();
      await expect.poll(() => cp.getByText("0.4.1").isVisible()).toBe(true);
      expect((await win(page)).__posts).toEqual([]);
      await cp.getByRole("button", { name: "Roll back", exact: true }).click();
      await page.waitForFunction(() => (globalThis as unknown as Win).__posts.length === 1);
      expect(await win(page)).toMatchObject({ __posts: [{ path: "/api/updates/rollback", body: { machine: "control-plane" } }] });
    } finally { await page.close(); }
  });

  // §11.4 through the hub (review round 1): a rollback that restores answers needs_word, and the card shows what
  // the restore drops — worded as the CLI words it — beside the field the typed word goes in. Only the exact word
  // enables the second Roll back, and that press carries it.
  it("a needs_word answer shows the restore lines and a field; only the exact word enables the second Roll back, which carries it", async () => {
    const page = await open();
    try {
      const cp = page.locator("[data-machine=control-plane]");
      await page.evaluate(() => {
        const w = globalThis as unknown as Win;
        const at = new Date(Date.now() - 3 * 3600_000).toISOString();
        w.__commands = [{
          status: 409,
          body: {
            error: "needs_word",
            message: "rolling back to 0.4.1 restores a database's backup and drops the writes since; type rollback to go on",
            restores: [{ db: "hub", at }],
          },
        }];
      });
      await cp.getByRole("button", { name: "Roll back…" }).click();
      await cp.getByRole("button", { name: "Roll back", exact: true }).click();
      const ask = page.locator("[data-needs-word]");
      await ask.waitFor();
      const text = await ask.textContent();
      expect(text).toContain("The hub database goes back to its backup from");
      expect(text).toContain("(3 hours of writes since are dropped)");
      expect(text).toContain("Type rollback to go on");
      const go = cp.getByRole("button", { name: "Roll back", exact: true });
      expect(await go.isDisabled()).toBe(true);            // nothing typed: the word is not there
      await page.locator("[data-word]").fill("rollbac");
      expect(await go.isDisabled()).toBe(true);            // almost the word is not the word
      await page.locator("[data-word]").fill("rollback");
      expect(await go.isEnabled()).toBe(true);
      await go.click();
      await page.waitForFunction(() => (globalThis as unknown as Win).__posts.length === 2);
      expect((await win(page)).__posts).toEqual([
        { path: "/api/updates/rollback", body: { machine: "control-plane" } },
        { path: "/api/updates/rollback", body: { machine: "control-plane", word: "rollback" } },
      ]);
    } finally { await page.close(); }
  });

  it("a halted Rollout says who and why, offers Resume (which posts resume), and no node offers Update now", async () => {
    const page = await open("halted");
    try {
      expect(await page.locator("[data-rollout]").textContent()).toContain("halted by pc: node health (fleet connection) failed");
      expect(await page.locator("[data-machine=pc]").textContent()).toContain("rolled back from 0.5.0: node health (fleet connection) failed");
      expect(await page.getByRole("button", { name: "Update now" }).count()).toBe(0);
      await page.locator("[data-rollout]").getByRole("button", { name: "Resume" }).click();
      await page.waitForFunction(() => (globalThis as unknown as Win).__posts.length === 1);
      expect(await win(page)).toMatchObject({ __posts: [{ path: "/api/updates/resume", body: { version: "0.5.0" } }] });
    } finally { await page.close(); }
  });

  it("a hub without the updates service (404 updates_off) says updates aren't available", async () => {
    const page = await web.browser.newPage();
    try {
      await page.goto(`${web.url}?case=off`);
      await expect.poll(() => page.locator("[data-updates]").textContent()).toContain("Updates aren't available on this hub");
    } finally { await page.close(); }
  });
});

describe("the Updates links", () => {
  let web: Web;
  beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
  afterAll(async () => { await web?.close(); });

  it("the Sidebar and the SettingsSheet offer Updates only when the hub has it", async () => {
    const page = await web.browser.newPage();
    try {
      await page.goto(web.url);
      await page.locator("[data-side=on]").getByRole("link", { name: "Updates" }).waitFor();
      expect(await page.locator("[data-side=off]").getByRole("link", { name: "Updates" }).count()).toBe(0);
      expect(await page.locator("[data-sheet=off]").getByRole("link", { name: /Updates/ }).count()).toBe(0);
      expect(await page.locator("[data-sheet=on]").getByRole("link", { name: /Updates/ }).count()).toBe(1);
      expect(await page.locator("[data-sheet=on]").getByRole("link", { name: /Updates/ }).getAttribute("href")).toBe("/updates");
    } finally { await page.close(); }
  });
});
