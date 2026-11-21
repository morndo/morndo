import { once } from "node:events";
import type { Command, CommandResult, FeedEvent, HistoryPage, SidebarView, ThreadView, TopicView } from "@morndo/cockpit-api";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { start } from "../src/main.ts";
import { DEMO_AT, type Module } from "../src/world.ts";

async function withCockpit(module: Module, run: (url: string, setClock: (at: string) => void) => Promise<void>) {
  let clock = DEMO_AT;
  const server = await start(module, 0, () => clock);
  try {
    await run(`http://127.0.0.1:${server.port}/api/cockpit`, at => { clock = at; });
  } finally {
    await server.close();
  }
}

async function read<T>(url: string, path: string): Promise<T> {
  const response = await fetch(url + path);
  expect(response.status, path).toBe(200);
  return await response.json() as T;
}

async function act(url: string, command: Command, options: { as?: string; key?: string; status?: number } = {}) {
  const query = options.as ? `?as=${options.as}` : "";
  const response = await fetch(url + "/actions" + query, {
    method: "POST",
    headers: { "content-type": "application/json", ...(options.key ? { "idempotency-key": options.key } : {}) },
    body: JSON.stringify(command),
  });
  expect(response.status, command.type).toBe(options.status ?? 200);
  return await response.json() as CommandResult;
}

function subscribe(url: string, query = "") {
  const socket = new WebSocket(url.replace("http", "ws") + "/feed" + query);
  const frames: FeedEvent[] = [];
  socket.on("message", data => {
    const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    frames.push(JSON.parse(buffer.toString("utf8")) as FeedEvent);
  });
  return { socket, frames, ready: once(socket, "open") };
}

it("sequences idempotent results and replays by sequence", async () => {
  await withCockpit("gtm", async url => {
    const live = subscribe(url);
    const restricted = subscribe(url, "?as=lea-brandt");
    await Promise.all([live.ready, restricted.ready]);
    const before = await read<SidebarView>(url, "/sidebar");
    const command: Command = { type: "lane.file", topicId: "content", text: "Write a recap of the webinar for the newsletter" };
    const [filed, duplicate] = await Promise.all([act(url, command, { key: "retry-1" }), act(url, command, { key: "retry-1" })]);
    expect(duplicate).toEqual(filed);
    const after = await read<SidebarView>(url, "/sidebar");
    const lanesBefore = before.groups.find(group => group.id === "content")?.lanes ?? [];
    const lanesAfter = after.groups.find(group => group.id === "content")?.lanes ?? [];
    expect(lanesAfter.filter(lane => !lanesBefore.some(original => original.id === lane.id)).map(lane => lane.id)).toEqual([filed.laneId]);
    expect(lanesAfter.some(lane => lane.title === "Webinar recap post")).toBe(true);
    const approved = await act(url, { type: "decision.approve", decisionId: "d4" });
    await expect.poll(() => live.frames).toEqual([...filed.events, ...approved.events]);
    expect(restricted.frames).toContainEqual(expect.objectContaining({ type: "topic.changed", topicId: "partnerships" }));
    expect(restricted.frames.every(frame => frame.type === "topic.changed" || frame.type === "thread.changed")).toBe(true);
    const initial = filed.events[0]?.seq ?? 0;
    const replay = subscribe(url, `?after=${initial}`);
    await replay.ready;
    await expect.poll(() => replay.frames).toEqual(approved.events);
    const reset = subscribe(url, "?after=123456");
    await reset.ready;
    await expect.poll(() => reset.frames[0]?.type).toBe("feed.reset");
    await act(url, { type: "lane.undoFile", laneId: filed.laneId ?? "" });
    expect((await fetch(`${url}/lanes/${filed.laneId}`)).status).toBe(404);
  });
});

it("applies and reverses lane and handover actions across history and read views", async () => {
  await withCockpit("gtm", async url => {
    await act(url, { type: "lane.act", laneId: "webinar", act: "wrong" }, { status: 400 });
    await act(url, { type: "lane.act", laneId: "webinar", act: "post-passing" });
    const settled = await read<TopicView>(url, "/topics/content");
    expect(settled.goal?.blockers.some(blocker => blocker.laneId === "webinar")).toBe(false);
    expect(settled.goal?.calm).toBe("Working again");
    const first = await read<HistoryPage>(url, "/topics/content/history?limit=1");
    const row = first.days.flatMap(day => day.entries).find(item => item.kind === "event");
    if (!row || row.kind !== "event") throw new Error("Missing settlement");
    expect(row).toMatchObject({ laneId: "webinar", undoable: true, undone: false });
    expect(first.nextCursor).toBeTypeOf("string");
    const second = await read<HistoryPage>(url, `/topics/content/history?limit=1&cursor=${first.nextCursor}`);
    expect(second.days.flatMap(day => day.entries)).not.toContainEqual(row);
    await act(url, { type: "agentAction.undo", actionId: row.id });
    expect((await read<TopicView>(url, "/topics/content")).goal?.blockers.some(blocker => blocker.laneId === "webinar")).toBe(true);
    await act(url, { type: "agentAction.redo", actionId: row.id });
    expect((await read<{ state: string }>(url, "/lanes/webinar")).state).toBe("ok");
    const confirm = await act(url, { type: "handover.confirm", laneId: "outreach-wave-2" }, { as: "lea-brandt" });
    expect(confirm.events.some(frame => frame.type === "handover.changed")).toBe(true);
    expect((await read<{ handover: { match: boolean } }>(url, "/lanes/outreach-wave-2")).handover.match).toBe(true);
  });
});

it("derives reader-specific grants, viewing markers, and redacted link status", async () => {
  await withCockpit("gtm", async (url, setClock) => {
    const topic = "/topics/partnerships";
    const viewer = "?as=lea-brandt";
    const leah = await read<TopicView>(url, topic + viewer);
    expect(leah.viewer.role).toBe("stages");
    expect(leah.stages.find(item => item.name === "Outreach")?.access).toBe("work");
    expect(leah.stages.find(item => item.name === "Offers")?.runBy).toBeNull();
    expect((await fetch(url + "/lanes/halden-offer" + viewer)).status).toBe(403);
    setClock("2026-11-16T09:00:00+01:00");
    await act(url, { type: "topic.seen", topicId: "partnerships" }, { as: "lea-brandt" });
    expect((await read<TopicView>(url, topic + viewer)).history?.seen.at).toBe("2026-11-16T09:00:00+01:00");
    expect((await read<TopicView>(url, topic)).history?.seen.at).not.toBe("2026-11-16T09:00:00+01:00");
    await act(url, { type: "stage.assign", topicId: "partnerships", stage: "Offers", personId: "lea-brandt" });
    expect((await read<TopicView>(url, topic + viewer)).stages.find(item => item.name === "Offers")?.runBy?.id).toBe("lea-brandt");
    expect((await read<TopicView>(url, topic + "?as=jonas-falk")).viewer.role).toBe("view");
    await act(url, { type: "access.invite", topicId: "partnerships", nameOrEmail: "reader@example.test" });
    const access = await read<{ invitations: { id: string }[] }>(url, topic + "/access");
    await act(url, { type: "access.revoke", invitationId: access.invitations[0]?.id ?? "" });
    expect((await read<{ invitations: unknown[] }>(url, topic + "/access")).invitations).toEqual([]);
    await act(url, { type: "access.statusLink", topicId: "partnerships" });
    const status = await read<Record<string, unknown>>(url, topic + "/status" + viewer);
    expect(Object.keys(status).sort()).toEqual(["health", "stages"]);
  });
});

it("moves pins, serves artwork and models, and connects an engine", async () => {
  await withCockpit("gtm", async url => {
    const base = await read<SidebarView>(url, "/sidebar");
    const second = base.pins[1]?.id ?? "";
    await act(url, { type: "pin.move", pinId: second, to: 0 });
    expect((await read<SidebarView>(url, "/sidebar")).pins[0]?.id).toBe(second);
    const art = await read<{ src: string }>(url, "/brief/artwork?index=1");
    const bytes = await fetch(new URL(art.src, url));
    expect(bytes.headers.get("content-type")).toBe("image/webp");
    expect((await bytes.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const modelState = async () => (await read<{ items: { id: string; state: string }[] }>(url, "/models")).items.find(model => model.id === "seedance")?.state;
    expect(await modelState()).toBe("addKey");
    const skills = await read<{ skills: { id: string; enabled: boolean }[]; guardrails: { name: string; on: boolean }[] }>(url, "/skills");
    const disabled = skills.skills.find(s => !s.enabled);
    await act(url, { type: "skill.run", skill: disabled?.id ?? "", text: "Make a clip" }, { status: 409 });
    await act(url, { type: "connection.connect", connectionId: "seedance" });
    expect(await modelState()).toBe("connected");
    await act(url, { type: "skill.run", skill: disabled?.id ?? "", text: "Make a clip", model: "seedance" });
    await act(url, { type: "skill.create", description: "Summarize a meeting" });
    expect((await read<typeof skills>(url, "/skills")).skills).toHaveLength(skills.skills.length + 1);
    await act(url, { type: "module.switch", moduleId: "dev" });
    const guardrail = (await read<typeof skills>(url, "/skills")).guardrails[0];
    if (!guardrail) throw new Error("Missing guardrail");
    await act(url, { type: "guardrail.set", name: guardrail.name, on: !guardrail.on });
    expect((await read<typeof skills>(url, "/skills")).guardrails[0]?.on).toBe(!guardrail.on);
  });
});

it("keeps module state and lets held pull requests stop a release", async () => {
  await withCockpit("dev", async (url, setClock) => {
    await act(url, { type: "decision.approve", decisionId: "d1" });
    await act(url, { type: "pull.hold", pullId: "412" });
    setClock("2026-11-16T09:20:00+01:00");
    const pulls = await read<{ items: { id: string; state: string }[] }>(url, "/pulls");
    expect(pulls.items.find(item => item.id === "412")?.state).toBe("held");
    expect(pulls.items.find(item => item.id === "413")?.state).toBe("released");
    await act(url, { type: "module.switch", moduleId: "gtm" });
    expect((await read<{ module: { id: string } }>(url, "/workspace")).module.id).toBe("gtm");
    await act(url, { type: "module.switch", moduleId: "dev" });
    expect((await read<{ items: { id: string; state: string }[] }>(url, "/pulls")).items.find(item => item.id === "412")?.state).toBe("held");
  });
});

it("expires decisions, publishes scheduled briefs, and pages stable thread records", async () => {
  await withCockpit("gtm", async (url, setClock) => {
    const feed = subscribe(url);
    await feed.ready;
    const thread = "/threads/topic:partnerships";
    const first = await read<ThreadView>(url, thread + "?limit=2");
    await act(url, { type: "message.send", threadId: "topic:partnerships", text: "Where does Halden stand?" });
    const older = await read<ThreadView>(url, thread + `?limit=2&cursor=${first.nextCursor}`);
    expect(older.messages.every(message => !first.messages.some(item => item.id === message.id))).toBe(true);
    setClock("2026-11-16T14:01:00+01:00");
    expect((await read<{ state: string }>(url, "/decisions/d1")).state).toBe("expired");
    await act(url, { type: "decision.approve", decisionId: "d1" }, { status: 409 });
    await expect.poll(() => feed.frames.some(frame => frame.type === "decision.expired")).toBe(true);
    expect(feed.frames.some(frame => frame.type === "brief.published")).toBe(true);
  });
});
