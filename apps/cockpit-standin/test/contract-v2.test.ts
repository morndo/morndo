import { once } from "node:events";
import { request } from "node:http";
import type { BriefView, Command, CommandResult, DecisionView, FeedEvent, HistoryPage, LaneView, ModelsView, PullsView, RecentView, SidebarView, ThreadView, TopicView, UsageView, WorkspaceView } from "@morndo/cockpit-api";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { Idempotency } from "../src/idempotency.ts";
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
    const result = await act(url, { type: "lane.act", laneId: "webinar", act: "post-passing" });
    expect(result.receipt?.text).toBe("The promo goes out at 16:00 with 4 images");
    expect(result.events.map(event => event.type)).toEqual(expect.arrayContaining(["thread.changed", "brief.changed"]));
    const lane = await read<LaneView>(url, "/lanes/webinar");
    expect(lane.steps).toContainEqual({ kind: "ok", text: "4 images pass the brand check; 2 left out", who: "You · now" });
    const brief = await read<BriefView>(url, "/brief");
    expect(brief.settledBurns[0]).toMatchObject({ actionId: result.receipt?.actionId, stateWord: "Settled by you" });
    expect(brief.burnsSub).toBe("Nothing else is stuck.");
    expect((await read<ThreadView>(url, "/threads/topic:content")).pinned).toBeNull();
    const settled = await read<TopicView>(url, "/topics/content");
    expect(settled.goal?.blockers.some(blocker => blocker.laneId === "webinar")).toBe(false);
    expect(settled.goal).toMatchObject({ calm: "The promo is settled", decision: null, verdict: { word: "Behind plan", action: "Reminder Wednesday" } });
    const first = await read<HistoryPage>(url, "/topics/content/history?limit=1");
    const row = first.days.flatMap(day => day.entries).find(item => item.kind === "event");
    if (!row || row.kind !== "event") throw new Error("Missing settlement");
    expect(row).toMatchObject({ laneId: "webinar", undoable: true, undone: false, text: "posted the promo with the 4 images that pass; 3 and 6 stay out" });
    expect(first.nextCursor).toBeTypeOf("string");
    const second = await read<HistoryPage>(url, `/topics/content/history?limit=1&cursor=${first.nextCursor}`);
    expect(second.days.flatMap(day => day.entries)).not.toContainEqual(row);
    await act(url, { type: "agentAction.undo", actionId: row.id });
    expect((await read<BriefView>(url, "/brief")).settledBurns).toEqual([]);
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
    const models = () => read<ModelsView>(url, "/models");
    expect((await models()).items.map(model => model.name)).toEqual(["Auto", "Claude", "GPT", "Gemini", "Grok"]);
    expect((await models()).items.find(model => model.id === "gemini")?.state).toBe("addKey");
    await act(url, { type: "connection.connect", connectionId: "gemini" });
    expect((await models()).items.find(model => model.id === "gemini")?.state).toBe("connected");
    await act(url, { type: "lane.file", text: "Write a post", model: "mail" }, { status: 400 });
    const skills = await read<{ skills: { id: string; enabled: boolean }[]; guardrails: { name: string; on: boolean }[] }>(url, "/skills");
    const disabled = skills.skills.find(s => !s.enabled);
    await act(url, { type: "skill.run", skill: disabled?.id ?? "", text: "Make a clip" }, { status: 409 });
    await act(url, { type: "connection.connect", connectionId: "seedance" });
    await act(url, { type: "skill.run", skill: disabled?.id ?? "", text: "Make a clip", model: "gpt" });
    await act(url, { type: "skill.create", description: "Summarize a meeting" });
    expect((await read<typeof skills>(url, "/skills")).skills).toHaveLength(skills.skills.length + 1);
    await act(url, { type: "module.switch", moduleId: "dev" });
    expect((await models()).items.map(model => model.name)).toEqual(["Auto", "Claude Code", "Codex", "Cursor", "Gemini CLI"]);
    expect((await models()).items.at(-1)?.state).toBe("signIn");
    await act(url, { type: "connection.connect", connectionId: "gemini-cli" });
    expect((await models()).items.at(-1)?.state).toBe("signedIn");
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

it("scopes stage chat, lane actions, history and live messages to the reader", async () => {
  await withCockpit("gtm", async url => {
    const lea = "?as=lea-brandt";
    const jonas = "?as=jonas-falk";
    const tom = "?as=tom-ahrens";
    const thread = "/threads/topic:partnerships";
    const leaFeed = subscribe(url, lea);
    const jonasFeed = subscribe(url, jonas);
    const ownerFeed = subscribe(url);
    await Promise.all([leaFeed.ready, jonasFeed.ready, ownerFeed.ready]);
    const scoped = await read<ThreadView>(url, thread + lea);
    expect(scoped.messages.some(message => message.text.includes("Halden"))).toBe(false);
    expect(scoped.messages.find(message => message.text.startsWith("Retail first"))?.threadCard?.laneId).toBe("outreach-wave-2");
    expect(scoped.messages.every(message => message.audience.kind === "stage" && message.audience.stage === "Outreach")).toBe(true);
    const posted = await act(url, { type: "message.send", threadId: "topic:partnerships", text: "Wave 2 is checked, it can go" }, { as: "lea-brandt" });
    expect(posted.message?.audience).toEqual({ kind: "stage", stage: "Outreach" });
    await expect.poll(() => leaFeed.frames.some(frame => frame.type === "message.posted")).toBe(true);
    await expect.poll(() => ownerFeed.frames.some(frame => frame.type === "message.posted")).toBe(true);
    expect(jonasFeed.frames.some(frame => frame.type === "message.posted")).toBe(false);
    const replay = subscribe(url, jonas + "&after=0");
    await replay.ready;
    expect(replay.frames.some(frame => frame.type === "message.posted")).toBe(false);
    expect((await read<ThreadView>(url, thread)).messages).toContainEqual(posted.message);
    expect((await read<ThreadView>(url, "/threads/decision:d4")).messages.some(message => message.author.id === "jonas-falk")).toBe(true);
    await act(url, { type: "message.send", threadId: "topic:partnerships", stage: "Offers", text: "Cross-stage post" }, { as: "lea-brandt", status: 403 });
    const topic = await read<TopicView>(url, "/topics/partnerships" + lea);
    expect(topic.crew.map(actor => actor.name)).toEqual(expect.arrayContaining(["Mara Lind", "Lea Brandt", "Sender"]));
    expect(topic.crew.map(actor => actor.name)).not.toContain("Call prep");
    const lane = await read<LaneView>(url, "/lanes/outreach-wave-2" + lea);
    expect(lane.standing.headline).toBe("It waits for you.");
    expect(lane.short).toBe("Wave 2: 24 emails");
    expect(lane.acts.map(action => action.id)).toContain("send-wave-2");
    expect((await read<LaneView>(url, "/lanes/halden-offer" + jonas)).approveLabel).toBeNull();
    const shared = await read<TopicView>(url, "/topics/partnerships" + tom);
    expect(shared.status).toMatchObject({ signed: 0, goal: 3, health: { word: "Behind plan" } });
    expect(shared.lanes).toEqual([]);
    expect(shared.goal).toBeNull();
    expect(shared.history).toBeNull();
    expect((await fetch(url + thread + tom)).status).toBe(403);
    expect(JSON.stringify(await read<BriefView>(url, "/brief" + lea))).not.toContain('"currency"');
    await act(url, { type: "lane.act", laneId: lane.id, act: "send-wave-2" }, { as: "lea-brandt" });
    expect((await read<LaneView>(url, "/lanes/outreach-wave-2")).stateWord).toBe("Working");
  });
});

it("delivers non-owner preferences and pin frames privately and advertises per-device reads", async () => {
  await withCockpit("gtm", async url => {
    const owner = subscribe(url);
    const reader = subscribe(url, "?as=lea-brandt");
    await Promise.all([owner.ready, reader.ready]);
    await act(url, { type: "prefs.set", deviceId: "phone", layout: { chatWidth: 350 } }, { as: "lea-brandt" });
    await act(url, { type: "pin.add", pinId: "a-partnerships" }, { as: "lea-brandt" });
    await expect.poll(() => reader.frames.map(frame => frame.type)).toEqual(["prefs.changed", "pins.changed"]);
    expect(owner.frames).toEqual([]);
    expect((await read<WorkspaceView>(url, "/workspace?as=lea-brandt&deviceId=phone")).layout.chatWidth).toBe(350);
    expect((await read<WorkspaceView>(url, "/workspace?as=lea-brandt")).layout.chatWidth).toBe(380);
    expect((await read<WorkspaceView>(url, "/workspace")).workspace.theme.glass).toBeNull();
    await act(url, { type: "prefs.set", theme: { id: "moss" } });
    expect((await read<WorkspaceView>(url, "/workspace")).workspace.theme.effectiveGlass).toBe(50);
  });
});

it("recomputes a declined decision and requires the explicit decision right", async () => {
  await withCockpit("gtm", async url => {
    const delegate = { as: "lea-brandt" };
    const decision = { decisionId: "d4" };
    const earlier = await read<{ summary: string }>(url, "/manager");
    await act(url, { type: "access.set", topicId: "partnerships", personId: "lea-brandt", access: { kind: "all" } });
    await act(url, { type: "decision.decline", ...decision }, { ...delegate, status: 403 });
    await act(url, { type: "decision.approve", ...decision }, { ...delegate, status: 403 });
    await act(url, { type: "decisionRight.set", rule: "hardToUndo", who: "agent", dailyLimit: 20, personId: "lea-brandt" });
    await act(url, { type: "decision.decline", ...decision }, delegate);
    const lane = await read<LaneView>(url, "/lanes/halden-offer");
    expect(lane).toMatchObject({ stateWord: "Declined", next: null, yours: null });
    const sidebar = await read<SidebarView>(url, "/sidebar");
    expect(sidebar.pins.find(pin => pin.id === "t-decide")?.badgeCount).toBe(3);
    expect(sidebar.groups.flatMap(group => group.lanes).find(item => item.id === lane.id)?.stateWord).toBe("Declined");
    expect((await read<{ summary: string }>(url, "/manager")).summary).not.toBe(earlier.summary);
    await act(url, { type: "decision.undo", ...decision }, delegate);
    await act(url, { type: "decision.approve", ...decision }, delegate);
    await act(url, { type: "decisionRight.set", rule: "hardToUndo", who: "you" });
    await act(url, { type: "agentAction.undo", actionId: "decision-d4" }, { ...delegate, status: 403 });
    await act(url, { type: "decision.undo", ...decision });
  });
});

it("projects goal and lane history changes through approval and Undo", async () => {
  await withCockpit("gtm", async url => {
    const result = await act(url, { type: "message.send", threadId: "topic:partnerships", text: "Change the goal to 4 qualified partners by 28 February" });
    const decision = result.events.find(event => event.type === "decision.changed");
    if (!decision || decision.type !== "decision.changed") throw new Error("Missing decision");
    const proposal = await read<DecisionView>(url, `/decisions/${decision.decisionId}`);
    expect(proposal.goalChange).toMatchObject({ from: 3, to: 4, unit: "qualified partners", deadlineAt: "2027-02-28T16:00:00.000Z" });
    await act(url, { type: "decision.approve", decisionId: decision.decisionId });
    const path = "/topics/partnerships";
    const goal = (await read<TopicView>(url, path)).goal;
    expect(goal).toMatchObject({ target: 4, unit: "qualified partners by 28 February", trajectory: { goal: 4 } });
    expect(goal?.figures[0]?.of).toBe("4");
    expect(goal?.trajectory.ticks.at(-1)?.label).toBe("28 Feb");
    expect(goal?.gap?.says).toContain("To reach 4");
    await act(url, { type: "decision.undo", decisionId: decision.decisionId });
    expect((await read<TopicView>(url, path)).goal?.target).toBe(3);
    const history = await read<HistoryPage>(url, path + "/history?laneId=outreach-wave-1&limit=1");
    expect(history.days.flatMap(day => day.entries).filter(row => row.kind === "event").every(row => row.laneId === "outreach-wave-1")).toBe(true);
    expect(history.newSince).toBeGreaterThan(0);
    await act(url, { type: "topic.seen", topicId: "partnerships" });
    expect((await read<HistoryPage>(url, path + "/history?laneId=outreach-wave-1")).newSince).toBe(0);
  });
});

it("executes both dev chat choices and starts an approved release on schedule", async () => {
  await withCockpit("dev", async (url, setClock) => {
    const chat = await read<ThreadView>(url, "/threads/topic:web");
    const buttons = chat.messages.flatMap(message => message.actions);
    expect(buttons).toHaveLength(2);
    for (const action of buttons) {
      expect((await read<LaneView>(url, `/lanes/${action.laneId}`)).acts.map(item => item.id)).toContain(action.id);
      const result = await act(url, { type: "lane.act", laneId: action.laneId, act: action.id });
      const changed = result.events.find(event => event.type === "agentAction.changed");
      if (changed?.type !== "agentAction.changed") throw new Error("Missing history action");
      await act(url, { type: "agentAction.undo", actionId: changed.actionId });
    }
    await act(url, { type: "decision.approve", decisionId: "d1" });
    const pulls = await read<PullsView>(url, "/pulls");
    expect(pulls.items.find(item => item.id === "412")).toMatchObject({ verdict: "Approved, rollout scheduled", state: "releasing" });
    expect(pulls.summary).toContain("1 ready");
    expect((await read<LaneView>(url, "/lanes/export-for-big-accounts")).next).toBe("Rollout is scheduled");
    const release = async () => (await read<DecisionView>(url, "/decisions/d1")).release;
    expect(await release()).toMatchObject({ stage: "scheduled", startedAt: null });
    setClock("2026-11-16T22:00:00+01:00");
    expect(await release()).toMatchObject({ stage: "rolling", startedAt: "2026-11-16T22:00:00+01:00" });
    setClock("2026-11-16T22:30:00+01:00");
    expect(await release()).toMatchObject({ stage: "done", percent: 100 });
  });
});

it("refuses a different payload under an existing key and resets without consuming a sequence", async () => {
  await withCockpit("gtm", async url => {
    const options = { key: "retry-key" };
    const initial = await act(url, { type: "lane.file", topicId: "content", text: "Review the file" }, options);
    const same = await act(url, { text: "Review the file", topicId: "content", type: "lane.file" }, options);
    expect(same).toEqual(initial);
    await act(url, { type: "decision.approve", decisionId: "d1" }, { ...options, status: 422 });
    expect((await read<DecisionView>(url, "/decisions/d1")).state).toBe("open");
    const reset = subscribe(url, "?after=100000");
    await reset.ready;
    await expect.poll(() => reset.frames[0]).toEqual({ type: "feed.reset" });
    const approval = await act(url, { type: "decision.approve", decisionId: "d1" });
    expect(approval.events[0]?.seq).toBe((initial.events.at(-1)?.seq ?? 0) + 1);
  });
});

it("sweeps expired idempotency entries without another request", () => {
  let time = 0;
  const cache = new Idempotency(() => time);
  const command: Command = { type: "decision.approve", decisionId: "d1" };
  const result: CommandResult = { ok: true, receipt: null, message: null, events: [], laneId: null };
  cache.run("reader", "key", command, () => result);
  time = 24 * 60 * 60 * 1000;
  expect(cache.sweep()).toBe(1);
  expect(cache.sweep()).toBe(0);
});

it("enforces local HTTP origins and bounded HTTPS links, and stores demo uploads", async () => {
  await withCockpit("gtm", async url => {
    expect((await fetch(url + "/workspace", { headers: { origin: "https://foreign.example.test" } })).status).toBe(403);
    const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url + "/workspace", { headers: { host: "foreign.example.test" } }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject);
      req.end();
    });
    expect(foreignHost).toBe(403);
    for (const badUrl of ["http://files.example.test/plan", "https://files.example.test/" + "a".repeat(2048)]) {
      await act(url, { type: "lane.file", text: "Read this plan", attachment: { name: "plan", url: badUrl } }, { status: 400 });
    }
    const uploaded = await fetch(url + "/uploads", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "plan.txt", data: "UGxhbg==" }),
    });
    expect(uploaded.status).toBe(200);
    const file = await uploaded.json() as { name: string; url: string };
    expect(file.url).toMatch(/^https:\/\/files\.example\.test\//);
    const local = new URL(url).origin + new URL(file.url).pathname;
    expect(await (await fetch(local)).text()).toBe("Plan");
    expect((await fetch(local + "?as=lea-brandt")).status).toBe(404);
    const result = await act(url, { type: "lane.file", text: "Read this plan", attachment: file, topicId: "content" });
    expect((await read<LaneView>(url, `/lanes/${result.laneId}`)).attachment).toEqual(file);
  });
});

it("retains six recent pages per reader and sends urgent attention", async () => {
  await withCockpit("gtm", async (url, setClock) => {
    const ws = subscribe(url);
    await ws.ready;
    for (const id of ["partnerships", "content", "outbound", "paid", "seo", "research"]) {
      await act(url, { type: "recent.visit", target: { kind: "topic", id } });
    }
    await act(url, { type: "recent.visit", target: { kind: "brief", id: null } });
    const recent = await read<RecentView>(url, "/recent");
    expect(recent.items).toHaveLength(6);
    expect(recent.items[0]?.target.kind).toBe("brief");
    expect((await read<RecentView>(url, "/recent?as=lea-brandt")).items).toEqual([]);
    await act(url, { type: "prefs.set", briefsPerDay: 2 });
    setClock("2026-11-16T09:00:00+01:00");
    const usage = await read<UsageView>(url, "/usage");
    expect(usage.subscriptions.find(item => item.name === "Cursor Pro")?.meters[0]?.count).toEqual({ used: 312, of: 500 });
    await expect.poll(() => ws.frames.filter(frame => frame.type === "attention.raised").map(frame => frame.target.id))
      .toEqual(expect.arrayContaining(["d1", "webinar"]));
  });
});
