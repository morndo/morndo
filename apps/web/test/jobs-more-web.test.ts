// "N more" opens the finished jobs the header does not show, then the next page. Real board in headless Chromium.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import BoardView from "/src/lib/desktop/BoardView.svelte";
  const task = { key: "T-1", n: 1, title: "Ship", description: "", status: "doing", assignee: "builder", priority: "normal", blockedReason: null, createdAt: 1, updatedAt: 1, stateChangedAt: 1, createdBy: { kind: "manager", name: "manager", token: "m" }, rev: 1, doneAt: null, comments: 0 };
  const job = (id, node) => ({ id, node, lane: "builder", name: id, class: "default", state: "exited", outcome: "exited", exit: 0, durationSec: 1, notice: "pending", task: null });
  const pages = [
    { jobs: [job("hidden-a", "pc"), job("hidden-b", "mac")], next: "cursor-1" },
    { jobs: [job("hidden-c", "pc")], next: null },
  ];
  mount(BoardView, { target: document.body, props: {
    tasks: [task], lanes: ["builder"], live: true, now: 1_000, jobs: [job("shown", "pc")], more: 3,
    onOpen: () => {}, onAct: async () => null, onCreate: async () => null, onOpenLane: () => {},
    onLoadJobs: async () => pages.shift() ?? { jobs: [], next: null },
  } });
</script></body></html>`;

let web: Web;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });

describe("older jobs", () => {
  it("opens the hidden page, then the next one", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    tab.on("pageerror", e => errors.push(e.message.split("\n")[0] ?? ""));
    await tab.goto(web.url);
    await tab.getByRole("button", { name: "3 more" }).click();
    await tab.getByRole("list", { name: "Older jobs" }).waitFor();
    const listed = await tab.locator(".job-rest li").allTextContents();
    expect(listed.slice(0, 2)).toEqual(["hidden-a · pc · exited", "hidden-b · mac · exited"]);
    await tab.getByRole("button", { name: "Next" }).click();
    await tab.getByText("hidden-c · pc · exited").waitFor();
    expect(await tab.getByRole("button", { name: "Next" }).count()).toBe(0);
    expect(errors).toEqual([]);
    await tab.close();
  });
});
