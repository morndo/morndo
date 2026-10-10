// The feed the app watches blanks a synthetic key on the screen (ADR-0018 §13). The redactor itself is tested in
// @morndo/protocol; this checks the hub applies it on the way out.
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ObservationService } from "../src/application/observation-service.ts";
import { ORIGIN, startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

const KEY = `sk-or-v1-${"e".repeat(64)}`;

let hub: InProcessHub | null = null;
afterEach(async () => { await hub?.close(); hub = null; });

function frameOf(ws: WebSocket, t: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const on = (raw: unknown) => {
      const m = JSON.parse(String(raw)) as Record<string, unknown>;
      if (m.t !== t) return;
      clearTimeout(timer);
      ws.off("message", on);
      resolve(m);
    };
    const timer = setTimeout(() => { ws.off("message", on); reject(new Error(`no ${t} frame within 5 s`)); }, 5000);
    ws.on("message", on);
  });
}

describe("the feed's screen view", () => {
  it("sends the screen with a synthetic key blanked", async () => {
    const obs = new ObservationService({
      listWorkers: async () => [{ id: "%1", name: "builder", location: "/tmp", node: "local", offline: false }],
      captureMany: async () => new Map([["%1", `ready\n${KEY}\n`]]),
    }, 60_000);
    await obs.poll();
    hub = await startInProcessHub({ observation: obs });
    const ws = await hub.socket("/api/feed", await hub.cookie());
    const screen = frameOf(ws, "screen");
    ws.send(JSON.stringify({ t: "hello" }));
    ws.send(JSON.stringify({ t: "watch", worker: "%1" }));
    const frame = await screen;
    ws.close();
    expect(frame.text).toBe("ready\n[redacted]\n");
    expect(JSON.stringify(frame)).not.toContain(KEY);
  });
});

describe("REST responses", () => {
  it("blanks a key on GET /api/board, the same boundary as an escalation answer", async () => {
    hub = await startInProcessHub();
    const made = hub.board.create({ title: "ship", description: KEY }, { kind: "manager", name: "manager", token: "tok" });
    expect(made.ok).toBe(true);
    const cookie = await hub.cookie();
    const res = await fetch(`${hub.base}/api/board`, { headers: { origin: ORIGIN, cookie: `__Host-morndo=${cookie}` } });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).not.toContain(KEY);
    expect(body).toContain("[redacted]");
  });
  it("saving the redacted description does not replace the stored text", async () => {
    hub = await startInProcessHub();
    const secret = `see ${KEY} please`;
    const made = hub.board.create({ title: "ship", description: secret }, { kind: "manager", name: "manager", token: "tok" });
    expect(made.ok).toBe(true);
    const token = hub.agents.issue("manager", "manager").secret;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const got = await fetch(`${hub.base}/api/agent/board/tasks/T-1`, { headers });
    const task = (await got.json() as { task: { description: string } }).task;
    expect(task.description).toBe("see [redacted] please");
    const saved = await fetch(`${hub.base}/api/agent/board/tasks/T-1`, {
      method: "POST", headers, body: JSON.stringify({ action: "edit", description: task.description, title: "renamed" }),
    });
    expect(saved.status).toBe(200);
    expect(hub.store.task("T-1")?.description).toBe(secret);
    expect(hub.store.task("T-1")?.title).toBe("renamed");
    const again = await fetch(`${hub.base}/api/agent/board/tasks/T-1`, {
      method: "POST", headers, body: JSON.stringify({ action: "edit", description: "plain words" }),
    });
    expect(again.status).toBe(200);
    expect(hub.store.task("T-1")?.description).toBe("plain words");
  });
});
