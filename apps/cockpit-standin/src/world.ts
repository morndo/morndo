import { loadFixtures } from "@morndo/cockpit-api";
import type { AccessView as Access, Actor, Ask, BriefView as Brief, Command, DecisionRule, DecisionView as Decision, Decider, LabelKind, LaneView as Lane, ManagerView as Manager, Message, Pin, DecisionQueueView as Queue, SettingsView as Settings, SidebarView as Sidebar, SkillsView as Skills, Theme, ThemePatch, ThreadView as Thread, TopicView as Topic, Verdict, WorkspaceView as Workspace } from "@morndo/cockpit-api";
import type { Outcome } from "./model.ts";
import { DEV_ROUTES, GTM_ROUTES, type Route } from "./routes.ts";
import { answerTo, isQuestion, routePreview, searchResults } from "./search.ts";

const RANK: Record<string, number> = { bad: 4, warn: 3, new: 2, ok: 1, parked: 0, next: 0, idle: 0, done: -1 };
const WORDS: Record<string, string> = {
  bad: "Stuck",
  warn: "Needs you",
  ok: "Working",
  done: "Done",
  new: "Starting",
  idle: "Idle",
  next: "Up next",
  parked: "Parked",
};
const THEME_NAMES: Record<string, string> = {
  ink: "Ink",
  ember: "Ember",
  sand: "Sand",
  moss: "Moss",
  tide: "Tide",
  sky: "Sky",
  iris: "Iris",
  rose: "Rose",
};

function decodeId(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    if (err instanceof URIError) return undefined;
    throw err;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function byRank(left: Lane, right: Lane): number {
  return (RANK[right.state] ?? 0) - (RANK[left.state] ?? 0);
}

function displayLead(lane: Lane, meId: string): string {
  if (lane.lead.id === meId && meId === "mara-lind") return "You";
  if (lane.lead.name.includes(" ") && lane.lead.kind === "person") return lane.lead.shortName;
  return lane.lead.name;
}

function markFor(state: string | undefined): string | null {
  if (!state || state === "done" || state === "parked" || state === "next" || state === "idle") return null;
  return state === "new" ? "ok" : state;
}

function classify(text: string): LabelKind {
  if (/\?\s*$/.test(text)) return "question";
  if (/\b(deadline|goal|target|budget|priorit|guardrail)/i.test(text)) return "goalChange";
  if (/\b(done|checked|finished|is ready|are ready)\b/i.test(text)) return "done";
  if (/\b(approve|decide|go with)\b/i.test(text)) return "decision";
  return "request";
}

function nowTime(): string {
  return new Date().toTimeString().slice(0, 5);
}

function blankActor(name: string): Actor {
  const first = name.split(" ")[0] ?? name;
  return {
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "person",
    name,
    shortName: first,
    kind: "person",
    avatar: name.slice(0, 1).toUpperCase() || "?",
    role: null,
    state: null,
    word: null,
    text: null,
    skill: null,
    engine: null,
    record: null,
  };
}

interface GoalChange {
  topicId: string;
  applied: boolean;
  noGoal: string | null;
  goal: { insight: string; asOf: string; verdict: Verdict } | null;
}

export class World {
  readonly module: "gtm" | "dev";
  private readonly routes: Route[];
  private readonly workspace: Workspace;
  private readonly settings: Settings;
  private readonly sidebarBase: Sidebar;
  private readonly pinnable: Pin[];
  private readonly briefBase: Brief;
  private readonly queueBase: Queue;
  private readonly managerBase: Manager;
  private readonly usage: unknown;
  private readonly drafts: unknown;
  private readonly skills: Skills;
  private readonly pulls: unknown;
  private readonly topics = new Map<string, Topic>();
  private readonly lanes = new Map<string, Lane>();
  private readonly extraLanes = new Map<string, Lane>();
  private readonly removed = new Set<string>();
  private readonly moved = new Map<string, string>();
  private readonly statusNote = new Map<string, string>();
  private readonly decisions = new Map<string, Decision>();
  private readonly extraDecisions: Decision[] = [];
  private readonly threads = new Map<string, Thread>();
  private readonly access = new Map<string, Access>();
  private readonly extraAsks: Ask[] = [];
  private readonly undone = new Set<string>();
  private readonly goalChanges = new Map<string, GoalChange>();
  private seq = 0;

  constructor(module: "gtm" | "dev") {
    this.module = module;
    this.routes = module === "dev" ? DEV_ROUTES : GTM_ROUTES;
    const files = loadFixtures(module);
    const take = <T>(path: string): T => {
      const file = files.find((item) => item.path === path);
      if (!file) throw new Error(`missing ${module} fixture ${path}`);
      return clone(file.value) as T;
    };
    this.workspace = take("workspace.json");
    this.settings = take("settings.json");
    this.sidebarBase = take("sidebar.json");
    this.pinnable = clone(this.sidebarBase.pinnable);
    this.briefBase = take("brief.json");
    this.queueBase = take("decisions.json");
    this.managerBase = take("manager.json");
    this.usage = take("usage.json");
    this.drafts = take("drafts.json");
    this.skills = take("skills.json");
    this.pulls = take("pulls.json");
    for (const file of files) {
      if (file.path.startsWith("topics/") && file.path.endsWith(".access.json")) {
        const view = clone(file.value) as Access;
        this.access.set(view.topicId, view);
      } else if (file.path.startsWith("topics/") && file.definition === "TopicView") {
        const topic = clone(file.value) as Topic;
        this.topics.set(topic.id, topic);
      } else if (file.path.startsWith("lanes/")) {
        const lane = clone(file.value) as Lane;
        this.lanes.set(lane.id, lane);
      } else if (file.path.startsWith("decisions/") && file.definition === "DecisionView") {
        const decision = clone(file.value) as Decision;
        this.decisions.set(decision.id, decision);
      } else if (file.path.startsWith("threads/")) {
        const thread = clone(file.value) as Thread;
        this.threads.set(thread.id, thread);
      }
    }
  }

  get(path: string, query: URLSearchParams): Outcome {
    if (path === "/workspace") return ok("WorkspaceView", this.workspaceView());
    if (path === "/sidebar") return ok("SidebarView", this.sidebar());
    if (path === "/usage") return ok("UsageView", clone(this.usage));
    if (path === "/brief") return ok("BriefView", this.brief());
    if (path === "/decisions") return ok("DecisionQueueView", this.queue());
    if (path === "/manager") return ok("ManagerView", this.manager());
    if (path === "/drafts") return ok("DraftsView", clone(this.drafts));
    if (path === "/skills") return ok("SkillsView", clone(this.skills));
    if (path === "/settings") return ok("SettingsView", clone(this.settings));
    if (path === "/pulls") return ok("PullsView", clone(this.pulls));
    if (path === "/search") return ok("SearchView", this.search(query.get("q") ?? "", query.get("scope") ?? ""));
    if (path === "/route-preview") return ok("RoutePreview", routePreview(query.get("text") ?? "", query.get("topic"), this.topics, this.routes));
    const decision = /^\/decisions\/([^/]+)$/.exec(path);
    if (decision?.[1]) {
      const id = decodeId(decision[1]);
      const view = id ? this.decisions.get(id) : undefined;
      return view ? ok("DecisionView", clone(view)) : missing("decision");
    }
    const access = /^\/topics\/([^/]+)\/access$/.exec(path);
    if (access?.[1]) {
      const id = decodeId(access[1]);
      const view = id ? this.access.get(id) : undefined;
      return view ? ok("AccessView", clone(view)) : missing("topic");
    }
    const topic = /^\/topics\/([^/]+)$/.exec(path);
    if (topic?.[1]) {
      const id = decodeId(topic[1]);
      const view = id ? this.topic(id) : undefined;
      return view ? ok("TopicView", view) : missing("topic");
    }
    const lane = /^\/lanes\/([^/]+)$/.exec(path);
    if (lane?.[1]) {
      const id = decodeId(lane[1]);
      const view = id ? this.lane(id) : undefined;
      return view ? ok("LaneView", view) : missing("lane");
    }
    if (path.startsWith("/threads/")) {
      const id = decodeId(path.slice("/threads/".length));
      const view = id ? this.thread(id) : undefined;
      return view ? ok("ThreadView", view) : missing("thread");
    }
    return missing("route");
  }

  act(command: Command): Outcome {
    switch (command.type) {
      case "decision.approve":
        return this.setDecision(command.decisionId, "approved");
      case "decision.decline":
        return this.setDecision(command.decisionId, "declined");
      case "decision.undo":
        return this.setDecision(command.decisionId, "open");
      case "decision.change":
        return this.changeDecision(command.decisionId, command.text);
      case "agentAction.undo":
        return this.agentAction(command.actionId, true);
      case "agentAction.redo":
        return this.agentAction(command.actionId, false);
      case "lane.file":
        return this.fileLane(command.text, command.topicId ?? null, command.leadId ?? null, false);
      case "lane.move":
        return this.moveLane(command.laneId, command.topicId);
      case "lane.undoFile":
        return this.undoFile(command.laneId);
      case "lane.act":
        return this.laneAct(command.laneId, command.act);
      case "person.remind":
        return this.remind(command.laneId, command.personId);
      case "goal.ask":
        return this.goalAsk(command.topicId);
      case "message.send":
        return this.send(command.threadId, command.text);
      case "message.relabel":
        return this.relabel(command.messageId, command.label);
      case "since.edit":
        return this.editSince(command.threadId, command.lines);
      case "pin.add":
        return this.pin(command.pinId, true);
      case "pin.remove":
        return this.pin(command.pinId, false);
      case "prefs.set":
        return this.prefs(command);
      case "decisionRight.set":
        return this.decisionRight(command.rule, command.who, command.dailyLimit);
      case "skill.run":
        return this.skillRun(command.skill, command.text);
      case "access.set":
        return this.setAccess(command.topicId, command.personId, command.access);
      case "access.invite":
        return this.invite(command.topicId, command.nameOrEmail);
      default: {
        const never: never = command;
        return never;
      }
    }
  }

  private workspaceView(): Workspace {
    return clone(this.workspace);
  }

  private lane(id: string): Lane | undefined {
    if (this.removed.has(id)) return undefined;
    const base = this.extraLanes.get(id) ?? this.lanes.get(id);
    if (!base) return undefined;
    const lane = clone(base);
    const moved = this.moved.get(id);
    if (moved) lane.topicId = moved;
    const note = this.statusNote.get(id);
    if (note) {
      lane.status = note;
      lane.standing = { headline: lane.standing.headline, detail: note };
    }
    const decision = lane.decisionId ? this.decisions.get(lane.decisionId) : undefined;
    if (decision?.state === "approved" || decision?.state === "declined") {
      lane.state = "ok";
      lane.stateWord = "Working";
      lane.standing = {
        headline: decision.state === "approved" ? "You approved it." : "You declined it.",
        detail: lane.after ?? lane.status,
      };
      lane.acts = [{ label: "Undo", tone: "quiet" }];
      if (decision.state === "approved") {
        let promoted = false;
        lane.steps = lane.steps.map((step) => {
          if (step.kind === "now") return { ...step, kind: "ok" };
          if (step.kind === "todo" && !promoted) {
            promoted = true;
            return { ...step, kind: "now" };
          }
          return step;
        });
        lane.next = lane.afterNext ?? lane.next;
      }
    }
    return lane;
  }

  private allLanes(): Lane[] {
    const ids = [...this.lanes.keys(), ...this.extraLanes.keys()];
    const out: Lane[] = [];
    for (const id of ids) {
      const lane = this.lane(id);
      if (lane) out.push(lane);
    }
    return out;
  }

  private lanesFor(topicId: string): Lane[] {
    return this.allLanes().filter((lane) => lane.topicId === topicId);
  }

  private sidebar(): Sidebar {
    const view = clone(this.sidebarBase);
    view.pinnable = clone(this.pinnable);
    view.pins = this.pinnable.filter((pin) => pin.pinned);
    view.groups = view.groups.map((group) => {
      const topic = this.topics.get(group.id);
      const lanes = this.lanesFor(group.id).filter((lane) => lane.state !== "done").sort(byRank);
      const worst = lanes[0]?.state;
      return {
        ...group,
        open: topic?.open ?? group.open,
        stateWord: worst ? WORDS[worst] ?? worst : "Idle",
        mark: markFor(worst),
        lanes: lanes.map((lane) => ({
          id: lane.id,
          title: lane.title,
          state: lane.state,
          stateWord: lane.stateWord,
          leadName: displayLead(lane, this.workspace.me.id),
        })),
      };
    });
    const loose = this.allLanes().filter((lane) => !lane.topicId && lane.state !== "done").sort(byRank);
    view.managerLanes = loose.map((lane) => ({
      id: lane.id,
      title: lane.title,
      state: lane.state,
      stateWord: lane.stateWord,
      leadName: displayLead(lane, this.workspace.me.id),
    }));
    return view;
  }

  private brief(): Brief {
    const view = clone(this.briefBase);
    for (const item of view.decisions) {
      const live = this.decisions.get(item.id);
      if (!live) continue;
      item.state = live.state;
      item.title = live.title;
    }
    for (const extra of this.extraDecisions) view.decisions.push(briefOf(extra));
    view.openCount = view.decisions.filter((item) => item.state === "open").length;
    view.minutes = view.decisions.filter((item) => item.state === "open").reduce((sum, item) => sum + item.minutes, 0);
    for (const action of view.overnight) action.undone = this.undone.has(action.id);
    return view;
  }

  private queue(): Queue {
    const view = clone(this.queueBase);
    for (const item of view.items) {
      const live = this.decisions.get(item.id);
      if (!live) continue;
      item.state = live.state;
      item.title = live.title;
    }
    for (const extra of this.extraDecisions) {
      view.items.push({ id: extra.id, title: extra.title, state: extra.state, topicName: extra.topicName, href: `#topic/${extra.topicId}` });
    }
    view.open = view.items.filter((item) => item.state === "open").length;
    view.total = view.items.length;
    return view;
  }

  private manager(): Manager {
    const base = this.managerBase;
    const lanes = this.allLanes().filter((lane) => lane.state !== "done").sort(byRank);
    const topics = new Set(lanes.map((lane) => lane.topicId).filter((id): id is string => Boolean(id)));
    const waiting = lanes.filter((lane) => (lane.state === "warn" || lane.state === "bad") && !lane.waitsFor).length;
    const noun = this.module === "dev" ? "projects" : "topics";
    return {
      intro: base.intro,
      summary: `${lanes.length} lanes in ${topics.size} ${noun} · ${waiting ? `${waiting} wait for you` : "none waits for you"}`,
      lanes: lanes.map((lane) => ({
        id: lane.id,
        title: lane.title,
        topicId: lane.topicId,
        topicName: lane.topicId ? this.topics.get(lane.topicId)?.name ?? "Manager" : "Manager",
        leadName: displayLead(lane, this.workspace.me.id),
        state: lane.state,
        stateWord: lane.stateWord,
        next: lane.next ?? "",
      })),
      sharedResources: clone(base.sharedResources),
      asks: [...this.extraAsks, ...base.asks],
      since: clone(base.since),
    };
  }

  private topic(id: string): Topic | undefined {
    const stored = this.topics.get(id);
    if (!stored) return undefined;
    const view = clone(stored);
    const live = this.lanesFor(id);
    const ordered = [...live.filter((lane) => lane.state !== "done").sort(byRank), ...live.filter((lane) => lane.state === "done")];
    view.lanes = ordered.map((lane) => ({
      id: lane.id,
      title: lane.title,
      state: lane.state,
      stateWord: lane.stateWord,
      leadName: displayLead(lane, this.workspace.me.id),
      next: lane.state === "done" ? lane.closed ?? "" : lane.next ?? "",
    }));
    const goal = view.goal;
    if (goal?.decision?.decisionId) {
      const decision = this.decisions.get(goal.decision.decisionId);
      if (decision?.state === "approved") {
        goal.decision.title = goal.decision.done || goal.decision.title;
        const lane = goal.decision.laneId ? this.lane(goal.decision.laneId) : undefined;
        if (lane?.shortAfter) goal.decision.detail = lane.shortAfter;
      }
    }
    for (const deal of goal?.deals ?? []) {
      if (!deal.alt || this.decisions.get(deal.alt.decisionId)?.state !== "approved") continue;
      if (deal.alt.stage) deal.stage = deal.alt.stage;
      if (deal.alt.short) deal.short = deal.alt.short;
      if (deal.alt.next) deal.next = deal.alt.next;
    }
    return view;
  }

  private thread(id: string): Thread | undefined {
    const stored = this.threads.get(id);
    if (!stored) return undefined;
    const view = clone(stored);
    const pin = view.pinned;
    if (pin?.decisionId) {
      const decision = this.decisions.get(pin.decisionId);
      const lane = pin.laneId ? this.lane(pin.laneId) : undefined;
      if (decision?.state === "approved") {
        pin.state = "approved";
        const name = lane?.short || lane?.title || pin.title;
        pin.title = name.includes("you approved") ? name : `${name}: you approved it`;
        if (lane?.shortAfter) pin.detail = lane.shortAfter;
      } else if (lane?.state === "bad") {
        pin.state = "stuck";
      }
    }
    return view;
  }

  private search(query: string, scope: string) {
    const topics = [...this.topics.values()];
    const lanes = this.allLanes();
    const people = topics.flatMap((topic) => topic.crew.filter((actor) => actor.kind === "person").map((actor) => ({ actor, topicId: topic.id })));
    const decisions = [...this.decisions.values()].map((decision) => ({
      id: decision.id,
      title: decision.title,
      topicId: decision.topicId,
      topicName: decision.topicName,
    }));
    const question = isQuestion(query);
    return {
      query,
      scope: scope || null,
      results: searchResults(query, scope, topics, lanes, people, decisions, this.skills.skills),
      answer: question ? answerTo(query, scope || null, topics, lanes) : null,
    };
  }

  private setDecision(id: string, state: Decision["state"]): Outcome {
    const decision = this.decisions.get(id);
    if (!decision) return missing("decision");
    decision.state = state;
    this.applyGoalChange(id, state);
    const events: unknown[] = [{ type: "decision.changed", decisionId: id, state }];
    for (const lane of this.allLanes()) {
      if (lane.decisionId === id) events.push({ type: "lane.changed", laneId: lane.id });
    }
    return done(events);
  }

  private changeDecision(id: string, text: string): Outcome {
    const decision = this.decisions.get(id);
    if (!decision) return missing("decision");
    decision.title = text;
    decision.cardContext = text;
    return done([{ type: "decision.changed", decisionId: id, state: decision.state }]);
  }

  private agentAction(id: string, undo: boolean): Outcome {
    const known = this.briefBase.overnight.some((action) => action.id === id);
    if (!known) return missing("action");
    if (undo) this.undone.add(id);
    else this.undone.delete(id);
    return done([{ type: "agentAction.changed", actionId: id }]);
  }

  private fileLane(text: string, topicId: string | null, leadId: string | null, fromChat: boolean, route = true): Outcome {
    let topic = topicId ? this.topics.get(topicId) : undefined;
    if (topicId && !topic) return missing("topic");
    if (!topic && route) {
      const found = this.routes.find((item) => item.re.test(text));
      topic = found ? this.topics.get(found.topicId) : undefined;
    }
    if (topic) topic.open = true;
    const leadRoute = topic ? this.routes.find((item) => item.topicId === topic.id) : undefined;
    const lead = this.resolveLead(topic, leadId, leadRoute?.lead ?? "Manager");
    const id = `new-${++this.seq}`;
    const lane = newLane(id, text, topic, lead, fromChat);
    this.extraLanes.set(id, lane);
    this.threads.set(`lane:${id}`, laneThread(id, text, topic?.name ?? null, this.workspace.me, lead, this.messageId(), this.messageId()));
    const where = fromChat && topic ? `in the ${topic.name} chat` : "You to the Manager";
    const went = fromChat ? `a thread · ${lead.name} owns it` : topic ? `Filed under ${topic.name}. ${lead.name} leads.` : "With the Manager, until it knows where this belongs";
    this.extraAsks.unshift({ id: `ask-${id}`, quote: text, when: "Just now", chat: where, went, href: `#lane/${id}` });
    return done([{ type: "lane.filed", laneId: id, topicId: topic?.id ?? null }], id);
  }

  private resolveLead(topic: Topic | undefined, leadId: string | null, leadName: string): Actor {
    const crew = topic?.crew ?? [];
    const found = (leadId ? crew.find((actor) => actor.id === leadId) : undefined) ?? crew.find((actor) => actor.name === leadName);
    const lead = found ? clone(found) : blankActor(leadName);
    if (!found) lead.kind = "agent";
    lead.state = "new";
    lead.word = "Leads";
    lead.text = "Reading your ask";
    lead.skill = found?.skill ?? "";
    lead.engine = "Auto";
    return lead;
  }

  private moveLane(laneId: string, topicId: string): Outcome {
    if (!this.lane(laneId)) return missing("lane");
    if (!this.topics.has(topicId)) return missing("topic");
    this.moved.set(laneId, topicId);
    const topic = this.topics.get(topicId);
    if (topic) topic.open = true;
    return done([{ type: "lane.changed", laneId }]);
  }

  private undoFile(laneId: string): Outcome {
    if (!this.extraLanes.has(laneId)) return missing("lane");
    this.removed.add(laneId);
    this.extraLanes.delete(laneId);
    this.threads.delete(`lane:${laneId}`);
    const ask = this.extraAsks.findIndex((item) => item.id === `ask-${laneId}`);
    if (ask >= 0) this.extraAsks.splice(ask, 1);
    return done([{ type: "lane.changed", laneId }]);
  }

  private laneAct(laneId: string, act: string): Outcome {
    const lane = this.lane(laneId);
    if (!lane) return missing("lane");
    if (lane.decisionId && (act === "approve" || act === "decline" || act === "undo")) {
      const state = act === "approve" ? "approved" : act === "decline" ? "declined" : "open";
      return this.setDecision(lane.decisionId, state);
    }
    this.statusNote.set(laneId, act === "remind" ? "Reminded." : lane.status);
    return done([{ type: "lane.changed", laneId }]);
  }

  private remind(laneId: string, personId: string): Outcome {
    const lane = this.lane(laneId);
    if (!lane) return missing("lane");
    const person = lane.waitsFor?.id === personId ? lane.waitsFor : lane.crew.find((actor) => actor.id === personId) ?? lane.lead;
    this.statusNote.set(laneId, `Reminded ${person.shortName || person.name}.`);
    return done([{ type: "lane.changed", laneId }]);
  }

  private send(threadId: string, text: string): Outcome {
    const thread = this.threads.get(threadId);
    if (!thread) return missing("thread");
    const topicId = threadId.startsWith("topic:") ? threadId.slice("topic:".length) : null;
    const topic = topicId ? this.topics.get(topicId) : undefined;
    const kind = topic ? classify(text) : null;
    const time = nowTime();
    const message = userMessage(this.messageId(), this.workspace.me, text, time, kind);
    const events: unknown[] = [];
    if (topic && kind === "request") {
      const filed = this.fileLane(text, topic.id, null, true);
      const laneId = filed.body && typeof filed.body === "object" && "laneId" in filed.body ? filed.body.laneId : null;
      if (typeof laneId === "string") {
        const lane = this.lane(laneId);
        message.threadCard = { title: text.length > 48 ? `${text.slice(0, 46)}…` : text, owner: lane?.lead.name ?? "Manager", state: "just opened", laneId };
        message.readBack = { owner: lane?.lead.name ?? "Manager", quote: "Got it. I set what done means, start now, and tell you in this thread.", time };
        events.push(...eventsOf(filed));
      }
    }
    thread.messages.push(message);
    events.push({ type: "message.posted", threadId, message: clone(message) });
    if (topic && kind === "question") {
      const answer = answerMessage(this.messageId(), topic, answerFor(topic, text), time);
      thread.messages.push(answer);
      events.push({ type: "message.posted", threadId, message: clone(answer) });
    } else if (topic && kind === "goalChange") {
      const decision = this.proposeChange(topic, text);
      const reply = answerMessage(this.messageId(), topic, "That changes the goal, and it reaches other topics. I proposed it to the Manager; you get one brief in Decide with what it affects. Nothing changes until you approve it there.", time);
      thread.messages.push(reply);
      events.push({ type: "decision.changed", decisionId: decision.id, state: "open" }, { type: "message.posted", threadId, message: clone(reply) });
    } else if (topic && kind === "done") {
      const reply = answerMessage(this.messageId(), topic, "Logged as done on the thread it belongs to.", time);
      reply.readBack = { owner: reply.author.name, quote: "Logged as done on the thread it belongs to.", time };
      thread.messages.push(reply);
      events.push({ type: "message.posted", threadId, message: clone(reply) });
    } else if (topic && kind === "decision") {
      const reply = answerMessage(this.messageId(), topic, "Noted as a decision and pinned for the team.", time);
      reply.readBack = { owner: reply.author.name, quote: "Noted as a decision and pinned for the team.", time };
      thread.messages.push(reply);
      events.push({ type: "message.posted", threadId, message: clone(reply) });
    }
    return done(events, null, clone(message));
  }

  private proposeChange(topic: Topic, text: string): Decision {
    const id = `dc${++this.seq}`;
    const card = "It reaches other topics: Paid's partner budget and the CEO's Friday report follow the new date.";
    const decision: Decision = {
      id,
      title: text,
      state: "open",
      topicId: topic.id,
      topicName: topic.name,
      due: `Proposed by the ${topic.name} manager`,
      whyYours: "Yours: changes a goal",
      minutes: 2,
      contextLine: `${topic.name} · Proposed by the ${topic.name} manager · 2 min`,
      cardContext: card,
      doneNote: "Approved. The goal is changed on record; every topic sees it.",
      laneId: null,
      approveLabel: "Approve",
      provenance: null,
      context: card,
      numbers: [],
      proof: null,
      opportunity: null,
      risk: null,
      suggestion: null,
      guardrail: null,
      nextSteps: [],
      ifNoAnswer: null,
      position: "",
    };
    this.decisions.set(id, decision);
    this.extraDecisions.push(decision);
    this.extraAsks.unshift({ id: `ask-${id}`, quote: text, when: "Just now", chat: `in the ${topic.name} chat`, went: "a goal change · waits for you in Decide", href: `#decision/${id}` });
    const goal = topic.goal;
    this.goalChanges.set(id, {
      topicId: topic.id,
      applied: false,
      noGoal: topic.noGoal,
      goal: goal ? { insight: goal.insight, asOf: goal.asOf, verdict: clone(goal.verdict) } : null,
    });
    return decision;
  }

  private goalAsk(topicId: string): Outcome {
    const topic = this.topics.get(topicId);
    if (!topic) return missing("topic");
    return this.fileLane(`Set a goal for ${topic.name}`, topicId, null, false);
  }

  private skillRun(name: string, text: string): Outcome {
    const skill = this.skills.skills.find((item) => item.name === name);
    if (!skill) return missing("skill");
    return this.fileLane(text, this.topicForSkill(skill.topics), null, false, false);
  }

  private topicForSkill(topics: string): string | null {
    const hay = topics.toLowerCase();
    let match: { id: string; length: number } | undefined;
    for (const topic of this.topics.values()) {
      const name = topic.name.toLowerCase();
      if (!name || !hay.includes(name)) continue;
      if (!match || name.length > match.length) match = { id: topic.id, length: name.length };
    }
    return match?.id ?? null;
  }

  private applyGoalChange(id: string, state: Decision["state"]): void {
    const change = this.goalChanges.get(id);
    if (!change) return;
    const topic = this.topics.get(change.topicId);
    const decision = this.decisions.get(id);
    if (!topic || !decision) return;
    if (state === "approved") {
      this.writeGoal(topic, decision.title);
      change.applied = true;
      return;
    }
    if (!change.applied) return;
    topic.noGoal = change.noGoal;
    if (topic.goal && change.goal) {
      topic.goal.insight = change.goal.insight;
      topic.goal.asOf = change.goal.asOf;
      topic.goal.verdict = clone(change.goal.verdict);
    }
    change.applied = false;
  }

  private writeGoal(topic: Topic, title: string): void {
    if (!topic.goal) {
      topic.noGoal = title;
      return;
    }
    topic.goal.insight = title;
    topic.goal.asOf = "updated just now";
    topic.goal.verdict = { ...topic.goal.verdict, text: title, action: "You approved the change" };
  }

  private relabel(messageId: string, label: LabelKind): Outcome {
    for (const thread of this.threads.values()) {
      const message = thread.messages.find((item) => item.id === messageId);
      if (!message) continue;
      message.label = { kind: label, corrected: true };
      return done([], null, clone(message));
    }
    return missing("message");
  }

  private editSince(threadId: string, lines: string[]): Outcome {
    const thread = this.threads.get(threadId);
    if (!thread) return missing("thread");
    thread.since = { seen: thread.since?.seen ?? "", lines: [...lines] };
    return done([]);
  }

  private pin(pinId: string, pinned: boolean): Outcome {
    const pin = this.pinnable.find((item) => item.id === pinId);
    if (!pin) return missing("pin");
    pin.pinned = pinned;
    return done([{ type: "pins.changed", pinId }]);
  }

  private prefs(command: Extract<Command, { type: "prefs.set" }>): Outcome {
    if (command.theme) applyTheme(this.workspace.workspace.theme, command.theme);
    if (command.theme) applyTheme(this.settings.theme, command.theme);
    const sidebarWidth = command.layout?.sidebarWidth;
    if (typeof sidebarWidth === "number") {
      this.workspace.layout.sidebarWidth = sidebarWidth;
      this.settings.layout.sidebarWidth = sidebarWidth;
    }
    const chatWidth = command.layout?.chatWidth;
    if (typeof chatWidth === "number") {
      this.workspace.layout.chatWidth = chatWidth;
      this.settings.layout.chatWidth = chatWidth;
    }
    if (command.chatMode) {
      this.workspace.chatMode = command.chatMode;
      this.settings.chatMode = command.chatMode;
    }
    if (typeof command.briefsPerDay === "number") this.settings.briefsPerDay = command.briefsPerDay;
    if (typeof command.interruptOnlyUrgent === "boolean") this.settings.interruptOnlyUrgent = command.interruptOnlyUrgent;
    return done([{ type: "prefs.changed" }]);
  }

  private decisionRight(rule: DecisionRule, who: Decider, dailyLimit: number | null | undefined): Outcome {
    const right = this.settings.decisionRights.find((item) => item.rule === rule);
    if (!right) return missing("rule");
    right.who = who;
    if (dailyLimit !== undefined) right.dailyLimit = dailyLimit;
    return done([{ type: "prefs.changed" }]);
  }

  private setAccess(topicId: string, personId: string, access: { kind: Access["people"][number]["access"]["kind"]; stages?: string[] }): Outcome {
    const view = this.access.get(topicId);
    if (!view) return missing("topic");
    const person = view.people.find((item) => item.person.id === personId);
    if (!person) return missing("person");
    person.access = { kind: access.kind, stages: access.stages ?? [] };
    return done([{ type: "access.changed", topicId }]);
  }

  private messageId(): string {
    return `m${++this.seq}`;
  }

  private invite(topicId: string, nameOrEmail: string): Outcome {
    const view = this.access.get(topicId);
    if (!view) return missing("topic");
    view.people.push({ person: blankActor(nameOrEmail), access: { kind: "view", stages: [] }, scope: "Invited", otherTopics: [] });
    return done([{ type: "access.changed", topicId }]);
  }
}

function ok(definition: string, body: unknown): Outcome {
  return { status: 200, definition, body };
}

function missing(what: string): Outcome {
  return { status: 404, definition: "ApiError", body: { error: { code: "not_found", message: `No ${what} with that id.` } } };
}

function done(events: unknown[], laneId: string | null = null, message: Message | null = null): Outcome {
  return { status: 200, definition: "CommandResult", body: { ok: true, events, laneId, message } };
}

function eventsOf(outcome: Outcome): unknown[] {
  const body = outcome.body;
  if (!body || typeof body !== "object" || !("events" in body) || !Array.isArray(body.events)) return [];
  return body.events;
}

function briefOf(decision: Decision): Brief["decisions"][number] {
  return {
    id: decision.id,
    topicId: decision.topicId,
    topicName: decision.topicName,
    due: decision.due,
    whyYours: decision.whyYours ?? "",
    title: decision.title,
    context: decision.cardContext,
    minutes: decision.minutes,
    doneNote: decision.doneNote,
    laneId: decision.laneId,
    state: decision.state,
  };
}

function applyTheme(theme: Theme, patch: ThemePatch): void {
  if (patch.id) {
    theme.id = patch.id;
    const name = THEME_NAMES[patch.id];
    if (name) theme.name = name;
  }
  if (typeof patch.strength === "number") theme.strength = patch.strength;
  if (typeof patch.glass === "number") theme.glass = patch.glass;
}

function userMessage(id: string, me: Actor, text: string, time: string, kind: LabelKind | null): Message {
  return {
    id,
    author: clone(me),
    time,
    text,
    own: true,
    label: kind ? { kind, corrected: false } : null,
    threadCard: null,
    readBack: null,
    actions: [],
  };
}

function answerFor(topic: Topic, text: string): string {
  if (topic.id === "partnerships" && /halden/i.test(text)) {
    return "From the record: the offer is drafted and waits for your OK, due Thursday. Halden sets its partner budget on 1 December.";
  }
  if (topic.goal) return `From the record: ${topic.goal.verdict.word.toLowerCase()}. ${topic.goal.insight}`;
  return `From the record: ${topic.intro}`;
}

function managerActor(topic: Topic): Actor {
  return {
    id: `${topic.id}-manager`,
    name: `${topic.name} manager`,
    shortName: "Manager",
    kind: "agent",
    avatar: "M",
    role: null,
    state: null,
    word: null,
    text: null,
    skill: null,
    engine: null,
    record: null,
  };
}

function answerMessage(id: string, topic: Topic, text: string, time: string): Message {
  return {
    id,
    author: managerActor(topic),
    time,
    text,
    own: false,
    label: null,
    threadCard: null,
    readBack: null,
    actions: [],
  };
}

function newLane(id: string, text: string, topic: Topic | undefined, lead: Actor, fromChat: boolean): Lane {
  const name = lead.name;
  const source = fromChat && topic ? `You in the ${topic.name} chat, just now` : "You to the Manager, just now";
  const note = fromChat && topic
    ? `The ${topic.name} manager opened this thread and named ${name}.`
    : topic
      ? `The Manager filed it under ${topic.name} and named ${name} to lead.`
      : "The Manager keeps it until it knows where it belongs.";
  const status = topic
    ? `${name} is reading your ask and will set what done means before starting.`
    : "The Manager is working out which topic this belongs to. It asks you only if it cannot tell.";
  return {
    id,
    topicId: topic?.id ?? null,
    title: text,
    state: "new",
    stateWord: "Starting",
    lead,
    waitsFor: null,
    opened: "Opened just now",
    closed: null,
    next: "Within the hour",
    afterNext: null,
    decisionId: null,
    short: null,
    ask: null,
    shortAfter: null,
    recommendation: null,
    yours: null,
    checks: [],
    delay: null,
    approveLabel: null,
    after: null,
    asked: text,
    askedMeta: { source, note },
    status,
    standing: { headline: "Just opened.", detail: status },
    acts: [{ label: "Undo", tone: "quiet" }],
    thumbs: [],
    steps: [
      { kind: "now", text: "What done means, set from your ask", who: `${name} · now` },
      { kind: "todo", text: "The work itself", who: name },
      { kind: "todo", text: `Checked by someone other than ${name}`, who: "Manager" },
      { kind: "todo", text: "Reported back to you", who: "Manager" },
    ],
    doneNote: "These are the first steps. The lead replaces them with the real ones before it starts.",
    crew: [lead],
    made: [],
    handover: null,
    fresh: true,
  };
}

function laneThread(id: string, text: string, topicName: string | null, me: Actor, lead: Actor, yours: string, ack: string): Thread {
  return {
    id: `lane:${id}`,
    title: text,
    sub: topicName,
    placeholder: "Message the lane",
    reading: null,
    since: null,
    pinned: null,
    agents: null,
    suggestions: [],
    messages: [
      userMessage(yours, me, text, "now", null),
      {
        id: ack,
        author: clone(lead),
        time: "now",
        text: "Got it. I will set what done means and start. You hear from me when it is done or when I need you.",
        own: false,
        label: null,
        threadCard: null,
        readBack: null,
        actions: [],
      },
    ],
  };
}
