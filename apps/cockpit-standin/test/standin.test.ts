import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

const BASE = "/api/cockpit";

async function boot(module: "gtm" | "dev"): Promise<{ url: string; stop: () => Promise<void> }> {
  const child: ChildProcess = spawn(process.execPath, ["apps/cockpit-standin/src/main.ts", "--module", module, "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listening line: ${out.slice(0, 300)}`)), 15000);
    const read = (chunk: Buffer) => {
      out += chunk.toString();
      const found = out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (!found?.[1]) return;
      clearTimeout(timer);
      resolve(Number(found[1]));
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`stand-in exited ${code}: ${out.slice(0, 300)}`));
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      child.kill();
      await once(child, "exit");
    },
  };
}

async function get(url: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url + BASE + path);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function act(url: string, command: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url + BASE + "/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("cockpit stand-in", () => {
  it("serves the go-to-market mock and keeps one decision consistent", async () => {
    const { url, stop } = await boot("gtm");
    try {
      const events: { type?: string; decisionId?: string; laneId?: string; threadId?: string }[] = [];
      const ws = new WebSocket(url.replace("http", "ws") + BASE + "/feed");
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("feed did not open"));
      });
      ws.onmessage = (message) => {
        events.push(JSON.parse(String(message.data)) as { type?: string });
      };

      const workspace = await get(url, "/workspace");
      expect(workspace.status).toBe(200);
      expect((workspace.body.workspace as { name: string }).name).toBe("Tidewell");
      expect((workspace.body.me as { name: string }).name).toBe("Mara Lind");

      const wave = await get(url, "/lanes/outreach-wave-2");
      expect((wave.body.handover as { match: boolean }).match).toBe(false);
      expect((wave.body.stateWord as string)).toBe("Waits for Lea");

      const approved = await act(url, { type: "decision.approve", decisionId: "d1" });
      expect(approved.status).toBe(200);
      expect((await get(url, "/decisions/d1")).body.state).toBe("approved");
      const brief = await get(url, "/brief");
      const open = (brief.body.decisions as { state: string }[]).filter((item) => item.state === "open");
      expect(open).toHaveLength(3);
      const paid = await get(url, "/topics/paid");
      const shift = (paid.body.lanes as { id: string; stateWord: string }[]).find((lane) => lane.id === "search-budget");
      expect(shift?.stateWord).toBe("Working");
      expect((await get(url, "/lanes/search-budget")).body.standing).toMatchObject({ headline: "You approved it." });

      const undone = await act(url, { type: "decision.undo", decisionId: "d1" });
      expect(undone.status).toBe(200);
      expect((await get(url, "/decisions/d1")).body.state).toBe("open");
      expect((await get(url, "/lanes/search-budget")).body.stateWord).toBe("Needs you");

      const filed = await act(url, { type: "lane.file", text: "Write a recap of the webinar for the newsletter", topicId: "content" });
      const laneId = filed.body.laneId;
      expect(typeof laneId).toBe("string");
      const created = await get(url, `/lanes/${String(laneId)}`);
      expect(created.body.topicId).toBe("content");
      expect(created.body.state).toBe("new");
      const sidebar = await get(url, "/sidebar");
      const content = (sidebar.body.groups as { id: string; lanes: { id: string }[] }[]).find((group) => group.id === "content");
      expect(content?.lanes.some((lane) => lane.id === laneId)).toBe(true);

      const sent = await act(url, { type: "message.send", threadId: "topic:partnerships", text: "What is the status of Halden?" });
      const message = sent.body.message as { id: string; label: { kind: string; corrected: boolean } };
      expect(message.label.kind).toBe("question");
      const relabeled = await act(url, { type: "message.relabel", messageId: message.id, label: "request" });
      expect((relabeled.body.message as { label: { kind: string; corrected: boolean } }).label).toEqual({ kind: "request", corrected: true });

      await act(url, { type: "prefs.set", theme: { id: "moss" } });
      expect(((await get(url, "/workspace")).body.workspace as { theme: { id: string; strength: number } }).theme).toMatchObject({ id: "moss", strength: 55 });
      await act(url, { type: "decisionRight.set", rule: "inYourName", who: "agent", dailyLimit: 20 });
      const rights = ((await get(url, "/settings")).body.decisionRights as { rule: string; who: string; dailyLimit: number | null }[]);
      expect(rights.find((right) => right.rule === "inYourName")).toMatchObject({ who: "agent", dailyLimit: 20 });
      await act(url, { type: "pin.add", pinId: "a-paid" });
      expect(((await get(url, "/sidebar")).body.pins as { id: string }[]).some((pin) => pin.id === "a-paid")).toBe(true);

      const refused = await act(url, { type: "decision.approve" });
      expect(refused.status).toBe(400);
      expect((await get(url, "/decisions/nope")).status).toBe(404);

      const found = await get(url, "/search?q=halden");
      expect((found.body.results as { kind: string; id: string }[]).some((item) => item.kind === "lane" && item.id === "halden-offer")).toBe(true);
      const asked = await get(url, `/search?q=${encodeURIComponent("Where does Halden stand?")}`);
      expect(typeof (asked.body.answer as { text: string } | null)?.text).toBe("string");
      const route = await get(url, `/route-preview?text=${encodeURIComponent("Book a call with Northvale next week")}`);
      expect(route.body.topicId).toBe("partnerships");
      expect(typeof (route.body.lead as { name: string }).name).toBe("string");

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(events.some((event) => event.type === "decision.changed" && event.decisionId === "d1")).toBe(true);
      expect(events.some((event) => event.type === "lane.filed" && event.laneId === laneId)).toBe(true);
      expect(events.some((event) => event.type === "message.posted" && event.threadId === "topic:partnerships")).toBe(true);
      ws.close();
    } finally {
      await stop();
    }
  });

  it("serves the development module", async () => {
    const { url, stop } = await boot("dev");
    try {
      const workspace = await get(url, "/workspace");
      expect((workspace.body.module as { id: string }).id).toBe("dev");
      expect((workspace.body.me as { name: string }).name).toBe("Timo Varga");
      const sidebar = await get(url, "/sidebar");
      const web = (sidebar.body.groups as { id: string; name: string; kind: string }[]).find((group) => group.name === "Web app");
      expect(web?.kind).toBe("project");
      expect((await get(url, `/topics/${web?.id ?? ""}`)).status).toBe(200);
      const pulls = await get(url, "/pulls");
      expect((pulls.body.items as unknown[]).length).toBe(5);
      const proof = await get(url, "/decisions/d1");
      const tests = ((proof.body.proof as { items: { label: string; value: string; sub: string | null }[] }).items).find((item) => item.label === "Tests");
      expect(tests?.value).toBe("214 pass");
      expect(tests?.sub ?? "").toMatch(/failed before the fix/);
    } finally {
      await stop();
    }
  });
});
