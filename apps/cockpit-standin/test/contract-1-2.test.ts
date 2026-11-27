import { once } from "node:events";
import type {
  BriefView, Command, CommandResult, DecisionQueueView, DecisionView, FeedEvent, HistoryPage, LaneView, MembersView, SidebarView, ThreadView, TopicView,
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
  const search = (path: string) => as ? `${path.includes("?") ? "&" : "?"}as=${as}` : "";
  return {
    async read<T>(path: string): Promise<T> {
      const response = await fetch(url + path + search(path));
      expect(response.status, path).toBe(200);
      return await response.json() as T;
    },
    async act(command: Command, status = 200): Promise<CommandResult> {
      const response = await fetch(url + "/actions" + search("/actions"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
      });
      expect(response.status, command.type).toBe(status);
      return await response.json() as CommandResult;
    },
  };
}

function feed(url: string, as?: string, after?: number) {
  const query = new URLSearchParams();
  if (as) query.set("as", as);
  if (after !== undefined) query.set("after", String(after));
  const socket = new WebSocket(url.replace("http", "ws") + `/feed?${query}`);
  const frames: FeedEvent[] = [];
  socket.on("message", data => {
    const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    frames.push(JSON.parse(buffer.toString("utf8")) as FeedEvent);
  });
  return { frames, ready: once(socket, "open") };
}

const grant = (topicId: string, personId: string, kind: "all" | "view" = "all"): Command =>
  ({ type: "access.set", topicId, personId, access: { kind, stages: [] } });

async function join(url: string, topicId: string, nameOrEmail: string) {
  const owner = reader(url);
  await owner.act({ type: "access.invite", topicId, nameOrEmail });
  const invitation = (await owner.read<MembersView>("/members")).invitations.find(item => item.nameOrEmail === nameOrEmail);
  if (!invitation) throw new Error("Missing invitation for the test reader");
  await reader(url, invitation.personId).act({ type: "access.accept", invitationId: invitation.id });
  return invitation.personId;
}

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

it("C3 and C6 show only the delegate's decisions in the brief and refresh it when a right changes", async () => {
  await withCockpit("dev", async url => {
    const owner = reader(url);
    const nameOrEmail = "riley@example.test";
    await owner.act({ type: "access.invite", topicId: "web", nameOrEmail });
    const invitation = (await owner.read<MembersView>("/members")).invitations.find(item => item.nameOrEmail === nameOrEmail);
    if (!invitation) throw new Error("Missing invitation for the test reader");
    const { id: invitationId, personId } = invitation;
    const delegate = reader(url, personId);
    await delegate.act({ type: "access.accept", invitationId });
    await owner.act(grant("web", personId));
    await owner.act(grant("billing", personId));
    const ownerBefore = await owner.read<BriefView>("/brief");
    const brief = () => delegate.read<BriefView>("/brief");
    expect((await delegate.read<DecisionQueueView>("/decisions")).items).toEqual([
      expect.objectContaining({ id: "d2", canDecide: false }),
      expect.objectContaining({ id: "d3", canDecide: false }),
    ]);
    expect(await brief()).toMatchObject({ decisions: [], openCount: 0, minutes: 0 });

    const { frames, ready } = feed(url, personId);
    await ready;
    const briefFrames = () => frames.filter(frame => frame.type === "brief.changed");
    await owner.act({ type: "decisionRight.set", rule: "onlyYouKnow", who: "agent", personId, dailyLimit: 5 });
    await expect.poll(briefFrames).toHaveLength(1);
    const assigned = await brief();
    expect(assigned.decisions.map(item => item.id)).toEqual(["d3"]);
    expect(assigned).toMatchObject({ openCount: 1, minutes: 3 });
    await delegate.act({ type: "decision.decline", decisionId: "d3" });
    const settled = await brief();
    expect(settled.decisions.map(item => item.id)).toEqual(["d3"]);
    expect(settled).toMatchObject({ openCount: 0, minutes: 0 });
    await owner.act({ type: "decisionRight.set", rule: "onlyYouKnow", who: "you" });
    await expect.poll(briefFrames).toHaveLength(2);
    expect(await brief()).toMatchObject({ decisions: [], openCount: 0, minutes: 0 });
    const ownerAfter = await owner.read<BriefView>("/brief");
    expect(ownerAfter.decisions.map(item => item.id)).toEqual(ownerBefore.decisions.map(item => item.id));
    expect(ownerAfter.openCount).toBe(ownerBefore.openCount - 1);
    expect(ownerAfter.minutes).toBe(ownerBefore.minutes - 3);
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

it("R3 includes a shared-resource topic outside the ranks Research passes", async () => {
  await withCockpit("gtm", async url => {
    const owner = reader(url);
    const text = "Raise Research priority by one";
    const before = await proposal(owner, "outbound", text);
    expect(before.goalChange?.affectedTopics).toEqual(["seo"]);

    await owner.act({ type: "lane.move", laneId: "click-floor", topicId: "research" });
    const linked = await proposal(owner, "outbound", text);
    expect(linked.goalChange).toMatchObject({ priority: { from: 6, to: 5 }, previousUnit: null });
    expect(linked.goalChange?.affectedTopics.toSorted()).toEqual(["paid", "seo"]);
  });
});

it("Q1 projects a cross-topic decision link in thread reads and live and replayed messages", async () => {
  await withCockpit("gtm", async url => {
    const owner = reader(url);
    const personId = await join(url, "paid", "tess-quill@example.test");
    const guest = reader(url, personId);
    await owner.act(grant("paid", personId));
    const checkpoint = await owner.act(grant("content", personId, "view"));
    const after = checkpoint.events.at(-1)!.seq;
    const live = feed(url, personId);
    await live.ready;

    const threadId = "topic:paid";
    const result = await owner.act({ type: "message.send", threadId, text: "Increase the Content target by 17" });
    const decisionId = result.message?.decisionId;
    expect(decisionId).toBeTruthy();
    const ids = new Set(result.events.flatMap(event => event.type === "message.posted" ? [event.message.id] : []));
    expect(ids.size).toBe(2);
    const links = async () => (await guest.read<ThreadView>(`/threads/${threadId}`)).messages
      .filter(message => ids.has(message.id)).map(message => message.decisionId);
    const feedLinks = (frames: FeedEvent[]) => frames.flatMap(event =>
      event.type === "message.posted" && ids.has(event.message.id) ? [event.message.decisionId] : []);
    await expect.poll(() => feedLinks(live.frames).length).toBe(2);
    const replay = feed(url, personId, after);
    await replay.ready;
    await expect.poll(() => feedLinks(replay.frames).length).toBe(2);
    expect({ thread: await links(), live: feedLinks(live.frames), replay: feedLinks(replay.frames) })
      .toEqual({ thread: [null, null], live: [null, null], replay: [null, null] });

    await owner.act(grant("content", personId));
    expect(await links()).toEqual([decisionId, decisionId]);
    const allowedReplay = feed(url, personId, after);
    await allowedReplay.ready;
    await expect.poll(() => feedLinks(allowedReplay.frames)).toEqual([decisionId, decisionId]);
  });
});

it("Q2 approval history and Undo frames skip an invited stage reader who cannot open the decision", async () => {
  await withCockpit("gtm", async url => {
    const owner = reader(url);
    const personId = await join(url, "partnerships", "sam-larch@example.test");
    const fullId = await join(url, "partnerships", "devon-pike@example.test");
    await owner.act(grant("partnerships", fullId));
    await owner.act({ type: "access.set", topicId: "partnerships", personId, access: { kind: "stages", stages: ["Offers"] } });
    const stage = feed(url, personId);
    const full = feed(url, fullId);
    await Promise.all([stage.ready, full.ready]);
    const rows = async (id: string) => (await reader(url, id).read<HistoryPage>("/topics/partnerships/history?laneId=halden-offer"))
      .days.flatMap(day => day.entries).filter(row => row.kind === "event" && row.decisionId === "d4");

    await owner.act({ type: "decision.approve", decisionId: "d4" });
    expect(await rows(fullId)).not.toHaveLength(0);
    const undo = await owner.act({ type: "decision.undo", decisionId: "d4" });
    const action = undo.events.find(event => event.type === "agentAction.changed");
    expect(action).toBeDefined();
    await expect.poll(() => full.frames.some(frame => frame.seq === action?.seq)).toBe(true);
    await expect.poll(() => stage.frames.some(frame => frame.type === "lane.changed" && frame.laneId === "halden-offer")).toBe(true);
    expect({ rows: await rows(personId), undo: stage.frames.some(frame => frame.seq === action?.seq) })
      .toEqual({ rows: [], undo: false });
  });
});

it("Q3 files an ordinary request mentioning a unit and still parses a requested change to the goal unit", async () => {
  await withCockpit("gtm", async url => {
    const owner = reader(url);
    const work = await owner.act({
      type: "message.send", threadId: "topic:content", text: "Deliver the display unit to the Alder Hall reception",
    });
    expect(work).toMatchObject({ laneId: expect.any(String), message: { decisionId: null, label: { kind: "request" } } });
    const change = await proposal(owner, "content", "Change the Content unit to registrations");
    expect(change.goalChange).toMatchObject({ topicId: "content", field: "unit", unit: "registrations" });
  });
});

it("Q4 updates a pending Paid move when Content changes its starting rank and freezes what approval moved", async () => {
  await withCockpit("gtm", async url => {
    const owner = reader(url);
    const pending = await proposal(owner, "paid", "Set Paid priority to 5");
    const content = await proposal(owner, "content", "Give Content priority 6");
    await owner.act({ type: "decision.approve", decisionId: content.id });
    const change = async () => (await owner.read<DecisionView>(`/decisions/${pending.id}`)).goalChange;
    expect(await change()).toMatchObject({ priority: { from: 3, to: 5 }, affectedTopics: ["partnerships", "seo", "research"] });
    await owner.act({ type: "decision.approve", decisionId: pending.id });
    const applied = await change();
    expect(applied).toMatchObject({ priority: { from: 3, to: 5 }, affectedTopics: ["partnerships", "seo", "research"] });
    for (const id of ["seo", "research"]) {
      expect((await owner.read<TopicView>(`/topics/${id}`)).appliedGoalChanges).toContainEqual(applied);
    }
    const research = await proposal(owner, "research", "Give Research priority 1");
    await owner.act({ type: "decision.approve", decisionId: research.id });
    expect(await change()).toEqual(applied);
  });
});

it("Q5 notifies the owner and Billing delegate when a decline or history redo changes their brief", async () => {
  await withCockpit("dev", async url => {
    const owner = reader(url);
    const personId = await join(url, "billing", "rowan-beck@example.test");
    const delegate = reader(url, personId);
    await owner.act(grant("billing", personId));
    await owner.act({ type: "decisionRight.set", rule: "hardToUndo", who: "agent", personId, dailyLimit: 60 });
    const feeds = [feed(url), feed(url, personId)];
    await Promise.all(feeds.map(item => item.ready));
    const count = async () => (await delegate.read<BriefView>("/brief")).openCount;
    expect(await count()).toBe(1);
    const commands: Command[] = [
      { type: "decision.decline", decisionId: "d2" },
      { type: "decision.undo", decisionId: "d2" },
      { type: "agentAction.redo", actionId: "decision-d2" },
    ];
    for (const [index, command] of commands.entries()) {
      await (index === 2 ? owner : delegate).act(command);
      expect(await count()).toBe(index % 2);
      for (const { frames } of feeds) {
        await expect.poll(() => frames.filter(frame => frame.type === "brief.changed").length).toBe(index + 1);
      }
    }
  });
});

it("Q7 reflects the Content holder and the actor who declined, even after the right moves", async () => {
  await withCockpit("gtm", async url => {
    const owner = reader(url);
    const personId = await join(url, "content", "avery-glen@example.test");
    const observerId = await join(url, "content", "morgan-flint@example.test");
    const holder = reader(url, personId);
    const observer = reader(url, observerId);
    for (const id of [personId, observerId]) await owner.act(grant("content", id));
    await owner.act({ type: "decisionRight.set", rule: "inYourName", who: "agent", personId, dailyLimit: 60 });
    const lane = (who: ReturnType<typeof reader>) => who.read<LaneView>("/lanes/fenwick");
    const open = await lane(holder);
    const waiting = await observer.read<DecisionView>("/decisions/d3");
    const lede = (await holder.read<BriefView>("/brief")).lede;
    expect({ stateWord: open.stateWord, headline: open.standing.headline, why: waiting.whyYours, lede })
      .toMatchObject({ stateWord: "Waits for you", headline: "It waits for you.", why: expect.stringMatching(/^Avery\b/i), lede: expect.stringMatching(/one decision/i) });

    await holder.act({ type: "decision.decline", decisionId: "d3" });
    await owner.act({ type: "decisionRight.set", rule: "inYourName", who: "agent", personId: observerId, dailyLimit: 60 });
    expect((await lane(observer)).standing).toMatchObject({ headline: "Avery declined it.", detail: "Avery declined it." });
    expect((await holder.read<BriefView>("/brief")).lede).toMatch(/no decisions/i);
  });
});

it("Q9 updates the dev sign-in lane and Web topic when Only You Know is handed back", async () => {
  await withCockpit("dev", async url => {
    const owner = reader(url);
    const personId = await join(url, "web", "jules-fir@example.test");
    const limitedId = await join(url, "web", "blair-reed@example.test");
    await owner.act(grant("web", personId));
    await owner.act(grant("web", limitedId, "view"));
    await owner.act({ type: "decisionRight.set", rule: "onlyYouKnow", who: "agent", personId, dailyLimit: 5 });
    const delegate = reader(url, personId);
    expect((await delegate.read<LaneView>("/lanes/new-sign-in")).decisionId).toBe("d3");
    const full = feed(url, personId);
    const limited = feed(url, limitedId);
    await Promise.all([full.ready, limited.ready]);
    await owner.act({ type: "decisionRight.set", rule: "onlyYouKnow", who: "you" });
    expect((await delegate.read<LaneView>("/lanes/new-sign-in")).decisionId).toBeNull();
    await expect.poll(() => full.frames).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "lane.changed", laneId: "new-sign-in" }),
      expect.objectContaining({ type: "topic.changed", topicId: "web" }),
    ]));
    expect(limited.frames.filter(frame => frame.type === "lane.changed" || frame.type === "topic.changed")).toEqual([]);
  });
});
