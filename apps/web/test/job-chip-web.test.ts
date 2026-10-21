// Two nodes can both run `--id build` on one task. The chips must both render and each open its own job.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import TaskCard from "/src/lib/desktop/TaskCard.svelte";
  const task = { key: "T-5", n: 5, title: "Ship", description: "", status: "doing", assignee: "builder", priority: "normal", blockedReason: null, createdAt: 1, updatedAt: 1, stateChangedAt: 1, createdBy: { kind: "manager", name: "manager", token: "m" }, rev: 1, doneAt: null, comments: 0 };
  const job = (node) => ({ id: "build", node, lane: "builder", name: "build", class: "default", state: "running", outcome: null, exit: null, durationSec: null, notice: "none", task: "T-5" });
  globalThis.__opened = [];
  mount(TaskCard, { target: document.body, props: {
    task, now: 1_000, running: true, selected: false, jobs: [job("pc"), job("mac")],
    onOpen: () => {}, onOpenJob: (id) => { globalThis.__opened.push(id); }, onDragStart: () => {}, onDragEnd: () => {},
  } });
</script></body></html>`;

let web: Web;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });

describe("job chips on two nodes", () => {
  it("renders both and opens each by node and id", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 800, height: 600 } });
    const errors: string[] = [];
    tab.on("pageerror", e => errors.push(e.message.split("\n")[0] ?? ""));
    await tab.goto(web.url);
    await tab.locator("[data-job='pc:build']").waitFor();
    await tab.locator("[data-job='mac:build']").click();
    await tab.locator("[data-job='pc:build']").click();
    expect(await tab.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)).toEqual(["mac:build", "pc:build"]);
    expect(errors).toEqual([]);
    await tab.close();
  });
});
