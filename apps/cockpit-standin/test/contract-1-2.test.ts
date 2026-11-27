import { once } from "node:events";
import type {
  BriefView, Command, CommandResult, DecisionQueueView, DecisionView, FeedEvent, LaneView, SidebarView, ThreadView, TopicView,
} from "@morndo/cockpit-api";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { start } from "../src/main.ts";
import { DEMO_AT, type Module } from "../src/world.ts";

async function withCockpit(module: Module, run: (url: string) => Promise<void>) {
  const server = await start(module, 0, () => DEMO_AT);
  try {
    await run(`http://127.0.0.1:${server.port}/api/cockpit`);
  } finally {
    await server.close();
  }
}

function reader(url: string, as?: string) {
  const suffix = as ? `?as=${as}` : "";
  return {
    async read<T>(path: string): Promise<T> {
      const response = await fetch(url + path + suffix);
      expect(response.status, path).toBe(200);
      return await response.json() as T;
    },
    async act(command: Command, status = 200): Promise<CommandResult> {
      const response = await fetch(url + "/actions" + suffix, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
      });
      expect(response.status, command.type).toBe(status);
      return await response.json() as CommandResult;
    },
  };
}

function feed(url: string, as: string) {
  const socket = new WebSocket(url.replace("http", "ws") + `/feed?as=${as}`);
  const frames: FeedEvent[] = [];
  socket.on("message", data => {
    const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    frames.push(JSON.parse(buffer.toString("utf8")) as FeedEvent);
  });
  return { frames, ready: once(socket, "open") };
}

const grant = (topicId: string, personId: string, kind: "all" | "view" = "all"): Command =>
  ({ type: "access.set", topicId, personId, access: { kind, stages: [] } });

async function proposal(owner: ReturnType<typeof reader>, chat: string, text: string) {
  const { message } = await owner.act({ type: "message.send", threadId: `topic:${chat}`, text });
  const id = message?.decisionId;
  if (!id) throw new Error(`No decision was proposed for "${text}"`);
  return owner.read<DecisionView>(`/decisions/${id}`);
}

it("C2 gives the owner the right on a settled dev decision in all three views", async () => {
  await withCockpit("dev", async url => {
    const owner = reader(url);
    await owner.act({ type: "decision.decline", decisionId: "d3" });
    const [view, queue, brief] = await Promise.all([
      owner.read<DecisionView>("/decisions/d3"), owner.read<DecisionQueueView>("/decisions"), owner.read<BriefView>("/brief"),
    ]);
    expect(view).toMatchObject({ state: "declined", canDecide: true });
    expect(queue.items.find(item => item.id === "d3")).toMatchObject({ canDecide: true });
    expect(brief.decisions.find(item => item.id === "d3")).toMatchObject({ canDecide: true });
  });
});

it("C4 lets the named reader decline and undo an Outbound decision", async () => {
  await withCockpit("gtm", async url => {
    const owner = reader(url);
    const delegate = reader(url, "tom-ahrens");
    await owner.act(grant("outbound", "tom-ahrens"));
    await owner.act({ type: "decisionRight.set", rule: "inYourName", who: "agent", personId: "tom-ahrens", dailyLimit: 5 });
    const before = await delegate.read<DecisionView>("/decisions/d2");
    expect(before).toMatchObject({ state: "open", canDecide: true });
    const lane = await delegate.read<LaneView>(`/lanes/${before.laneId}`);
    expect(lane.decisionId).toBe("d2");
    expect(lane.approveLabel).toBeTypeOf("string");
    await delegate.act({ type: "decision.decline", decisionId: "d2" });
    expect(await delegate.read<DecisionView>("/decisions/d2")).toMatchObject({ state: "declined", canDecide: true });
    await delegate.act({ type: "decision.undo", decisionId: "d2" });
    expect(await delegate.read<DecisionView>("/decisions/d2")).toMatchObject({ state: "open", canDecide: true });
  });
});

it("C5 keeps a cap change with the owner and withdraws a delegated Content decision on loss of full access", async () => {
  await withCockpit("gtm", async url => {
    const owner = reader(url);
    const delegate = reader(url, "lea-brandt");
    await owner.act(grant("content", "lea-brandt"));
    await owner.act({ type: "decisionRight.set", rule: "inYourName", who: "agent", personId: "lea-brandt", dailyLimit: 5 });
    expect(await delegate.read<DecisionView>("/decisions/d3")).toMatchObject({ canDecide: true });
    const change = await proposal(owner, "content", "Set the Content budget cap to €41.50 each week");
    if (!change.rule) throw new Error("The budget proposal has no decision rule");
    await owner.act({ type: "decisionRight.set", rule: change.rule, who: "agent", personId: "lea-brandt", dailyLimit: 5 });
    expect(await delegate.read<DecisionView>(`/decisions/${change.id}`)).toMatchObject({ canDecide: false });
    await delegate.act({ type: "decision.decline", decisionId: change.id }, 403);
    await owner.act(grant("content", "lea-brandt", "view"));
    const queue = await delegate.read<DecisionQueueView>("/decisions");
    expect(queue.items.map(item => item.id)).not.toContain("d3");
    await delegate.act({ type: "decision.decline", decisionId: "d3" }, 403);
  });
});

it("C6 tells both readers about the decisions and brief that change when a shared rule moves between them", async () => {
  await withCockpit("gtm", async url => {
    const owner = reader(url);
    for (const topic of ["content", "outbound"]) {
      for (const person of ["lea-brandt", "tom-ahrens"]) await owner.act(grant(topic, person));
    }
    await owner.act({ type: "decisionRight.set", rule: "inYourName", who: "agent", personId: "lea-brandt", dailyLimit: 60 });
    const feeds = ["lea-brandt", "tom-ahrens"].map(person => feed(url, person));
    await Promise.all(feeds.map(item => item.ready));
    await owner.act({ type: "decisionRight.set", rule: "inYourName", who: "agent", personId: "tom-ahrens", dailyLimit: 60 });
    for (const { frames } of feeds) {
      await expect.poll(() => frames).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "decision.changed", decisionId: "d2" }),
        expect.objectContaining({ type: "decision.changed", decisionId: "d3" }),
        expect.objectContaining({ type: "brief.changed" }),
      ]));
    }
  });
});

it("R1 exposes the last rank of a capped topic to a newly granted full reader", async () => {
  await withCockpit("gtm", async url => {
    const owner = reader(url);
    const guest = reader(url, "jonas-falk");
    await owner.act(grant("research", "jonas-falk", "view"));
    expect((await guest.read<TopicView>("/topics/research")).meta?.priority).toBeNull();
    await owner.act(grant("research", "jonas-falk"));
    expect(await guest.read<TopicView>("/topics/research")).toMatchObject({ goal: null, meta: { priority: 6 } });
  });
});

it("R2 applies and undoes a relative Research budget with cents from the Outbound chat", async () => {
  await withCockpit("gtm", async url => {
    const owner = reader(url);
    const briefCap = async () => (await owner.read<BriefView>("/brief")).spend?.cap.amountMinor;
    const topic = () => owner.read<TopicView>("/topics/research");
    const before = await briefCap();
    const change = await proposal(owner, "outbound", "Lower the budget for Research by €7.25 each week");
    expect(change.goalChange).toMatchObject({
      topicId: "research", field: "budget", affectedTopics: [], previousDeadlineAt: null, previousUnit: null,
      budget: { from: { amountMinor: 2000, currency: "EUR" }, to: { amountMinor: 1275, currency: "EUR" }, period: "week" },
    });
    await owner.act({ type: "decision.approve", decisionId: change.id });
    expect((await topic()).spend?.cap.amountMinor).toBe(1275);
    expect(await briefCap()).toBe((before ?? 0) - 725);
    await owner.act({ type: "decision.undo", decisionId: change.id });
    expect((await topic()).spend?.cap.amountMinor).toBe(2000);
    expect(await briefCap()).toBe(before);
  });
});

it("R3 promotes Research above Paid, notifies a full reader of both moved topics, and restores the ranks on undo", async () => {
  await withCockpit("gtm", async url => {
    const owner = reader(url);
    for (const topic of ["research", "paid", "seo"]) await owner.act(grant(topic, "lea-brandt"));
    const ids = (await owner.read<SidebarView>("/sidebar")).groups.map(group => group.id);
    const ranks = () => Promise.all(ids.map(async id => (await owner.read<TopicView>(`/topics/${id}`)).meta?.priority));
    const before = await ranks();
    const change = await proposal(owner, "content", "Prioritize Research above Paid");
    expect(change.goalChange).toMatchObject({ field: "priority", priority: { from: 6, to: 4 } });
    expect(change.goalChange?.affectedTopics.toSorted()).toEqual(["paid", "seo"]);
    const shared = feed(url, "lea-brandt");
    await shared.ready;
    await owner.act({ type: "decision.approve", decisionId: change.id });
    expect(await ranks()).toEqual([1, 2, 3, 5, 6, 4]);
    await expect.poll(() => shared.frames.flatMap(frame => frame.type === "topic.changed" ? [frame.topicId] : []).sort())
      .toEqual(["paid", "research", "seo"]);
    await owner.act({ type: "decision.undo", decisionId: change.id });
    expect(await ranks()).toEqual(before);
  });
});

it("R5 keeps a goal-only ask in Research chat without proposing a decision or filing a lane", async () => {
  await withCockpit("gtm", async url => {
    const owner = reader(url);
    for (const text of [
      "Raise the Research target by 4", "Move the Research deadline to January 21", "Set the Research unit to interviews",
      "Change the Research bounces guardrail to 1%",
    ]) {
      const result = await owner.act({ type: "message.send", threadId: "topic:research", text });
      expect(result.message?.decisionId, text).toBeNull();
      expect(result.laneId, text).toBeNull();
      const thread = await owner.read<ThreadView>("/threads/topic:research");
      expect(thread.messages.some(message => message.id === result.message?.id && message.text === text)).toBe(true);
    }
  });
});
