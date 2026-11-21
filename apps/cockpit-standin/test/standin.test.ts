import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { WebSocket as NodeSocket } from "ws";
import { World } from "../src/world.ts";

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
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
      child.kill();
    }),
  };
}

async function get(url: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url + BASE + path);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function feedOutcome(target: string, origin?: string): Promise<"open" | "refused"> {
  return new Promise((resolve) => {
    const socket = origin ? new NodeSocket(target, { headers: { origin } }) : new NodeSocket(target);
    const timer = setTimeout(() => {
      socket.terminate();
      resolve("refused");
    }, 2000);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.close();
      resolve("open");
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve("refused");
    });
  });
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

  it("moves a lane on the manager view with the rest of the state", async () => {
    const { url, stop } = await boot("gtm");
    try {
      const moved = await act(url, { type: "lane.move", laneId: "webinar", topicId: "partnerships" });
      expect(moved.status).toBe(200);
      expect((await get(url, "/lanes/webinar")).body.topicId).toBe("partnerships");
      const manager = await get(url, "/manager");
      const row = (manager.body.lanes as { id: string; topicId: string | null; topicName: string }[]).find((lane) => lane.id === "webinar");
      expect(row).toMatchObject({ topicId: "partnerships", topicName: "Partnerships" });
      const content = await get(url, "/topics/content");
      expect((content.body.lanes as { id: string }[]).some((lane) => lane.id === "webinar")).toBe(false);
      const partnerships = await get(url, "/topics/partnerships");
      expect((partnerships.body.lanes as { id: string }[]).some((lane) => lane.id === "webinar")).toBe(true);
      const sidebar = await get(url, "/sidebar");
      const groups = sidebar.body.groups as { id: string; lanes: { id: string }[] }[];
      expect(groups.find((group) => group.id === "content")?.lanes.some((lane) => lane.id === "webinar")).toBe(false);
      expect(groups.find((group) => group.id === "partnerships")?.lanes.some((lane) => lane.id === "webinar")).toBe(true);
    } finally {
      await stop();
    }
  });

  it("gives each answer its own id when two questions land in the same minute", async () => {
    const { url, stop } = await boot("gtm");
    try {
      const first = await act(url, { type: "message.send", threadId: "topic:partnerships", text: "Where is Halden?" });
      const second = await act(url, { type: "message.send", threadId: "topic:partnerships", text: "How is Brightmoor doing?" });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const thread = await get(url, "/threads/topic:partnerships");
      const messages = thread.body.messages as { id: string; text: string; label: { kind: string } | null }[];
      const ids = messages.map((message) => message.id);
      expect(new Set(ids).size).toBe(ids.length);
      const last = messages.at(-1);
      expect(last?.text.startsWith("From the record")).toBe(true);
      const relabeled = await act(url, { type: "message.relabel", messageId: last?.id, label: "done" });
      expect(relabeled.status).toBe(200);
      expect((relabeled.body.message as { id: string; text: string }).id).toBe(last?.id);
      expect((relabeled.body.message as { text: string }).text).toBe(last?.text);
      const after = await get(url, "/threads/topic:partnerships");
      const updated = (after.body.messages as { id: string; text: string; label: { kind: string } | null }[]).filter((message) => message.label?.kind === "done");
      expect(updated.map((message) => message.id)).toEqual([last?.id]);
      const halden = (after.body.messages as { text: string; label: { kind: string } | null }[]).find((message) => message.text.includes("the offer is drafted"));
      expect(halden?.label).toBeNull();
    } finally {
      await stop();
    }
  });

  it("answers a malformed percent-escape with not found", async () => {
    const direct = new World("gtm").get("/decisions/%E0%A4%A", new URLSearchParams());
    expect(direct.status).toBe(404);
    expect(direct.definition).toBe("ApiError");
    const { url, stop } = await boot("gtm");
    try {
      const response = await fetch(`${url}${BASE}/decisions/%E0%A4%A`);
      expect(response.status).toBe(404);
      const body = await response.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe("not_found");
      expect(body.error.message.length).toBeGreaterThan(0);
      expect((await get(url, "/decisions/missing-decision")).status).toBe(404);
    } finally {
      await stop();
    }
  });

  it("refuses a non-JSON action, an oversized body, and a foreign feed origin", async () => {
    const { url, stop } = await boot("gtm");
    try {
      const plain = await fetch(`${url}${BASE}/actions`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ type: "decision.approve", decisionId: "d1" }),
      });
      expect(plain.status).toBe(415);
      expect((await plain.json() as { error: { code: string } }).error.code).toBe("unsupported_media_type");

      const charset = await fetch(`${url}${BASE}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: "{}",
      });
      expect(charset.status).toBe(400);

      const huge = await fetch(`${url}${BASE}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "decision.approve", decisionId: "d1", pad: "x".repeat(1024 * 1024) }),
      });
      expect(huge.status).toBe(413);
      expect((await huge.json() as { error: { code: string } }).error.code).toBe("payload_too_large");

      expect((await act(url, { type: "decision.approve", decisionId: "d1" })).status).toBe(200);

      const port = new URL(url).port;
      const feed = `${url.replace("http", "ws")}${BASE}/feed`;
      expect(await feedOutcome(feed)).toBe("open");
      expect(await feedOutcome(feed, `http://127.0.0.1:${port}`)).toBe("open");
      expect(await feedOutcome(feed, `http://localhost:${port}`)).toBe("open");
      expect(await feedOutcome(feed, "http://evil.example")).toBe("refused");
    } finally {
      await stop();
    }
  });

  it("names an unknown command and only the fields of a known one", async () => {
    const { url, stop } = await boot("gtm");
    try {
      const unknown = await act(url, { type: "nope" });
      expect(unknown.status).toBe(400);
      expect((unknown.body.error as { message: string }).message).toBe('unknown command type "nope"');
      const missing = await act(url, { type: "decision.approve" });
      expect(missing.status).toBe(400);
      const message = (missing.body.error as { message: string }).message;
      expect(message).toMatch(/decisionId/);
      expect(message).not.toMatch(/threadId|pinId|skill/);
    } finally {
      await stop();
    }
  });

  it("files a goal ask and a skill run, and applies an approved goal change", async () => {
    const { url, stop } = await boot("gtm");
    try {
      const asked = await act(url, { type: "goal.ask", topicId: "content" });
      expect(asked.status).toBe(200);
      const askLane = String(asked.body.laneId);
      expect(asked.body.events).toEqual([expect.objectContaining({ type: "lane.filed", laneId: askLane, topicId: "content" })]);
      expect((await get(url, `/lanes/${askLane}`)).body).toMatchObject({ topicId: "content", state: "new" });
      const manager = await get(url, "/manager");
      expect((manager.body.lanes as { id: string; topicId: string | null }[]).some((lane) => lane.id === askLane && lane.topicId === "content")).toBe(true);
      expect((await act(url, { type: "goal.ask", topicId: "missing" })).status).toBe(404);

      const run = await act(url, { type: "skill.run", skill: "/linkedin-post", text: "Write a post about the webinar" });
      expect(run.status).toBe(200);
      const runLane = String(run.body.laneId);
      expect(run.body.events).toEqual([expect.objectContaining({ type: "lane.filed", laneId: runLane, topicId: "content" })]);
      expect((await get(url, `/lanes/${runLane}`)).body.topicId).toBe("content");

      const loose = await act(url, { type: "skill.run", skill: "/decision-brief", text: "Brief the open question" });
      expect(loose.status).toBe(200);
      expect((loose.body.events as { topicId: string | null }[])[0]?.topicId).toBeNull();
      expect((await get(url, `/lanes/${String(loose.body.laneId)}`)).body.topicId).toBeNull();
      expect((await act(url, { type: "skill.run", skill: "/missing", text: "hi" })).status).toBe(404);

      const before = (await get(url, "/topics/partnerships")).body.goal as { insight: string };
      const sent = await act(url, { type: "message.send", threadId: "topic:partnerships", text: "Move the target to 5 partners" });
      expect(sent.status).toBe(200);
      const decisionId = (sent.body.events as { type: string; decisionId?: string }[]).find((event) => event.type === "decision.changed")?.decisionId;
      expect(typeof decisionId).toBe("string");
      expect((await get(url, "/topics/partnerships")).body.goal).toMatchObject({ insight: before.insight });
      expect((await act(url, { type: "decision.approve", decisionId })).status).toBe(200);
      const goal = (await get(url, "/topics/partnerships")).body.goal as { insight: string; verdict: { text: string } };
      expect(goal.insight).toBe("Move the target to 5 partners");
      expect(goal.verdict.text).toBe("Move the target to 5 partners");
      expect((await act(url, { type: "decision.undo", decisionId })).status).toBe(200);
      expect((await get(url, "/topics/partnerships")).body.goal).toMatchObject({ insight: before.insight });
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
