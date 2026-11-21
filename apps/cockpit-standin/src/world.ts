import { createHash } from "node:crypto";
import { loadFixtures } from "@morndo/cockpit-api";
import type {
  AccessView, Actor, ApiError, Ask, Attachment, BriefView, Command, DailyLimit,
  DecisionQueueView, DecisionView, DraftsView, Event, HistoryEntry, HistoryPage, LabelKind, LaneAct,
  LaneView, ManagerView, Message, ModelId, ModelsView, Pin, PullsView, Receipt,
  SearchView, SettingsView, SidebarView, SkillsView, Target, Theme, ThemePatch, ThreadView,
  TopicView, UsageView, WorkspaceView,
} from "@morndo/cockpit-api";
import { artwork } from "./artwork.ts";
import { done, type Effect, type Outcome } from "./model.ts";
import { BASE, definitionFor, matchRoute, missing, page, Problem, threadScope } from "./protocol.ts";
import { DEV_ROUTES, GTM_ROUTES, leadFor } from "./routes.ts";
import { answerTo, isQuestion, routePreview, searchResults } from "./search.ts";

export type Module = "gtm" | "dev";
export const DEMO_AT = "2026-11-16T08:45:00+01:00";
const DAY = "2026-11-16";
const hour = (time: string) => `${DAY}T${time}:00+01:00`;
const byId = <T extends { id: string }>(items: readonly T[], id: string) => items.find(item => item.id === id);
const target = (kind: Target["kind"], id: string | null = null): Target => ({ kind, id });
const RANK: Record<LaneView["state"], number> = { bad: 4, warn: 3, new: 2, ok: 1, parked: 0, next: 0, idle: 0, done: -1, unknown: 0 };
const WORDS: Record<LaneView["state"], string> = {
  bad: "Stuck", warn: "Needs you", ok: "Working", done: "Done", new: "Starting",
  idle: "Idle", next: "Up next", parked: "Parked", unknown: "Unknown",
};

type HistoryRow = Extract<HistoryEntry, { kind: "event" }>;
type TopicRole = TopicView["viewer"]["role"] | "none";
type HistoryAction = {
  row: HistoryRow;
  topicId: string | null;
  record: string;
  apply: (undone: boolean) => Event[];
};
type FileOptions = {
  topicId?: string | null;
  leadId?: string | null;
  attachment?: Attachment | null;
  model?: ModelId | null;
  fromChat?: boolean;
  route?: boolean;
};
type Preferences = Pick<SettingsView, "theme" | "chatMode" | "layout" | "briefsPerDay" | "interruptOnlyUrgent">;
type FileResult = { lane: LaneView; receipt: Receipt; message: Message; events: Event[] };

function requireRecord<T>(record: T | undefined | null, kind: string): T {
  if (record === undefined || record === null) throw missing(kind);
  return record;
}

function blankActor(name: string, kind: Actor["kind"] = "agent"): Actor {
  return {
    id: slug(name) || "manager", name, shortName: name.split(" ")[0] ?? name, kind,
    avatar: name[0]?.toUpperCase() ?? "?", role: null, state: null, word: null, text: null,
    skill: null, engine: null, record: null,
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 175);
}

function classify(text: string): LabelKind {
  if (isQuestion(text)) return "question";
  if (/\b(change|move|set|raise|lower|extend|reduce|increase|push)\b.*\b(deadline|goal|target|budget|priority|guardrail)\b/i.test(text)) return "goalChange";
  if (/\b(done|checked|finished|is ready|are ready)\b/i.test(text)) return "done";
  if (/\b(approve|decide|go with)\b/i.test(text)) return "decision";
  return "request";
}

function sortLanes(left: LaneView, right: LaneView): number {
  return RANK[right.state] - RANK[left.state];
}

function labelFor(lane: LaneView, me: Actor): string {
  if (lane.lead.id === me.id) return "You";
  return lane.lead.kind === "person" ? lane.lead.shortName : lane.lead.name;
}

function laneUpdate(laneId: string, topicId: string | null): Event[] {
  return [{ type: "lane.changed", laneId }, ...(topicId ? [{ type: "topic.changed", topicId } as const] : [])];
}

function workspaceOutcome(definition: string, body: unknown): Outcome {
  return { status: 200, definition, body };
}

export class World {
  readonly module: Module;
  readonly owner: Actor;
  private readonly routes;
  private readonly workspace: WorkspaceView;
  private readonly settings: SettingsView;
  private readonly sidebarBase: SidebarView;
  private readonly briefBase: BriefView;
  private readonly managerBase: ManagerView;
  private readonly usage: UsageView;
  private readonly drafts: DraftsView;
  private readonly skills: SkillsView;
  private readonly pulls: PullsView;
  private readonly topics = new Map<string, TopicView>();
  private readonly lanes = new Map<string, LaneView>();
  private readonly removed = new Set<string>();
  private readonly filed = new Map<string, Receipt>();
  private readonly decisions = new Map<string, DecisionView>();
  private readonly threads = new Map<string, ThreadView>();
  private readonly access = new Map<string, AccessView>();
  private readonly people = new Map<string, Actor>();
  private readonly history = new Map<string, HistoryAction>();
  private readonly overnightAliases = new Map<string, string>();
  private readonly fixtureActions = new Set<string>();
  private readonly reverted = new Map<string, Set<string>>();
  private readonly seen = new Map<string, string>();
  private readonly pinned = new Map<string, string[]>();
  private readonly preferences = new Map<string, Preferences>();
  private readonly layouts = new Map<string, SettingsView["layout"]>();
  private readonly sinceEdits = new Map<string, string[]>();
  private serial = 0;
  private messageSerial = 0;
  private now = DEMO_AT;
  private readonly origin: () => string;

  constructor(module: Module, origin = () => "https://status.example.test") {
    this.origin = origin;
    this.module = module;
    this.routes = module === "dev" ? DEV_ROUTES : GTM_ROUTES;
    const files = loadFixtures(module);
    const take = <T>(path: string) => requireRecord(files.find(file => file.path === path), "fixture").value as T;
    this.workspace = take("workspace.json");
    this.owner = this.workspace.me;
    this.people.set(this.owner.id, this.owner);
    this.settings = take("settings.json");
    this.sidebarBase = take("sidebar.json");
    this.briefBase = take("brief.json");
    this.managerBase = take("manager.json");
    this.usage = take("usage.json");
    this.drafts = take("drafts.json");
    this.skills = take("skills.json");
    this.pulls = take("pulls.json");
    for (const { definition, value } of files) {
      switch (definition) {
        case "AccessView": {
          const access = value as AccessView;
          this.access.set(access.topicId, access);
          for (const { person } of access.people) this.people.set(person.id, person);
          break;
        }
        case "TopicView": {
          const topic = value as TopicView;
          this.topics.set(topic.id, topic);
          break;
        }
        case "LaneView": {
          const lane = value as LaneView;
          this.lanes.set(lane.id, lane);
          break;
        }
        case "DecisionView": {
          const decision = value as DecisionView;
          this.decisions.set(decision.id, decision);
          break;
        }
        case "ThreadView": {
          const thread = value as ThreadView;
          this.threads.set(thread.id, thread);
          for (const message of thread.messages) this.messageSerial = Math.max(this.messageSerial, Number(message.id.slice(1)));
          break;
        }
      }
    }
    for (const topic of this.topics.values()) {
      for (const day of topic.history?.days ?? []) {
        for (const row of day.entries) {
          if (row.kind !== "event" || !row.undoable) continue;
          const action = this.rememberRecorded(topic.id, row.id, row.text, row.actor, row.laneId, row.at);
          this.fixtureActions.add(row.id);
          row.undone = action.row.undone;
        }
      }
    }
    for (const row of this.briefBase.overnight.filter(item => item.undoable)) {
      const existing = row.laneId && [...this.history.values()].find(action => action.row.laneId === row.laneId && action.topicId === row.topicId);
      if (existing) this.overnightAliases.set(row.id, existing.row.id);
      else this.rememberRecorded(row.topicId, row.id, row.text, this.lanes.get(row.laneId ?? "")?.lead ?? blankActor("Manager"), row.laneId, row.at);
    }
  }

  viewer(id: string | null): Actor {
    if (!id) return this.owner;
    const person = this.people.get(id);
    if (!person) throw new Problem("forbidden", "This reader is not part of the workspace.");
    return person;
  }

  get(path: string, query: URLSearchParams): Outcome {
    try {
      const route = matchRoute(BASE + path);
      const operation = route?.operations.get;
      const definition = operation && definitionFor(operation);
      if (!definition) throw missing("route");
      return workspaceOutcome(definition, this.read(definition, route.parameters[0], query, this.viewer(query.get("as"))));
    } catch (error) {
      const problem: ApiError = error instanceof Problem ? error.body : error instanceof URIError
        ? missing("route").body
        : new Problem("internal", "The cockpit could not read this record.").body;
      return { status: problem.status, definition: "ApiError", body: problem };
    }
  }

  read(definition: string, id: string | undefined, query: URLSearchParams, viewer: Actor): unknown {
    const key = id ?? "";
    switch (definition) {
      case "WorkspaceView": {
        const prefs = this.prefsOf(viewer, query.get("deviceId"));
        return { ...this.workspace, me: viewer, workspace: { ...this.workspace.workspace, theme: prefs.theme }, chatMode: prefs.chatMode, layout: prefs.layout };
      }
      case "SidebarView": return this.sidebar(viewer);
      case "UsageView": this.requireOwner(viewer); return this.usage;
      case "BriefView": return this.brief(viewer);
      case "Artwork": return artwork(Number(query.get("index") ?? this.briefBase.artwork.index));
      case "DecisionQueueView": return this.queue(viewer);
      case "DecisionView": return this.decisionView(key, viewer);
      case "TopicView": return this.topicView(key, viewer, new URLSearchParams());
      case "HistoryPage": return this.historyView(key, viewer, query);
      case "AccessView": this.requireOwner(viewer); return this.accessView(key);
      case "TopicStatusView": return this.status(key, viewer);
      case "LaneView": return this.visibleLane(key, viewer);
      case "ManagerView": this.requireOwner(viewer); return this.manager(viewer);
      case "DraftsView": this.requireOwner(viewer); return this.draftsView();
      case "SkillsView": return this.skills;
      case "SettingsView": return { ...this.settings, ...this.prefsOf(viewer, query.get("deviceId")) };
      case "PullsView": this.requireOwner(viewer); return this.pulls;
      case "ModelsView": return this.models();
      case "ThreadView": return this.threadView(key, viewer, query);
      case "SearchView": return this.search(query, viewer);
      case "RoutePreview": {
        const text = query.get("text") ?? "";
        this.checkText(text);
        const topics = new Map([...this.topics].filter(([id]) => this.fullTopic(id, viewer)));
        return routePreview(text, query.get("topic"), topics, this.routes);
      }
      default: throw missing("route");
    }
  }

  act(command: Command, viewer: Actor = this.owner): Effect {
    switch (command.type) {
      case "decision.approve": return this.setDecision(command.decisionId, "approved", viewer);
      case "decision.decline": return this.setDecision(command.decisionId, "declined", viewer);
      case "decision.undo": return this.setDecision(command.decisionId, "open", viewer);
      case "decision.change": {
        this.requireOwner(viewer);
        const decision = requireRecord(this.decisions.get(command.decisionId), "decision");
        if (decision.state !== "open") throw new Problem("conflict", "The decision is already settled.");
        decision.changeRequest = command.text;
        return done(this.decisionEvents(decision));
      }
      case "agentAction.undo": return this.undo(command.actionId, true, viewer);
      case "agentAction.redo": return this.undo(command.actionId, false, viewer);
      case "lane.file": {
        const filed = this.file(command.text, viewer, { ...command, topicId: command.toManager ? null : command.topicId ?? null, route: !command.toManager });
        return done(filed.events, filed.lane.id, filed.message, filed.receipt);
      }
      case "lane.move": return this.move(command.laneId, command.topicId, viewer);
      case "lane.undoFile": return this.undo(`file-${command.laneId}`, true, viewer);
      case "lane.act": return this.laneAct(command.laneId, command.act, viewer);
      case "person.remind": return this.remind(command.laneId, command.personId, viewer);
      case "goal.ask": {
        const topic = requireRecord(this.topics.get(command.topicId), "topic");
        const file = this.file(`Propose a goal for ${topic.name} with a measure and a date`, viewer, { topicId: topic.id });
        return done(file.events, file.lane.id, file.message, file.receipt);
      }
      case "message.send": return this.send(command, viewer);
      case "message.relabel": return this.relabel(command.messageId, command.label, viewer);
      case "since.edit": {
        const thread = this.writableThread(command.threadId, viewer);
        this.sinceEdits.set(JSON.stringify([viewer.id, thread.id]), command.lines);
        return done([{ type: "thread.changed", threadId: thread.id }]);
      }
      case "pin.add": return this.pin(command.pinId, viewer, "add");
      case "pin.remove": return this.pin(command.pinId, viewer, "remove");
      case "pin.move": return this.pin(command.pinId, viewer, "move", command.to);
      case "prefs.set": return this.setPrefs(command, viewer);
      case "decisionRight.set": return this.decisionRight(command.rule, command.who, command.dailyLimit, viewer);
      case "skill.run": return this.runSkill(command.skill, command.text, command.model, viewer);
      case "skill.create": return this.createSkill(command.description, viewer);
      case "access.set": return this.setAccess(command.topicId, command.personId, command.access.kind, command.access.stages ?? [], viewer);
      case "access.invite": return this.invite(command.topicId, command.nameOrEmail, viewer);
      case "access.revoke": return this.revoke(command.invitationId, viewer);
      case "access.statusLink": return this.statusLink(command.topicId, viewer);
      case "stage.assign": return this.assign(command.topicId, command.stage, command.personId, viewer);
      case "topic.seen": return this.visit(command.topicId, viewer);
      case "guardrail.set": return this.guardrail(command.name, command.on, viewer);
      case "pull.hold": return this.hold(command.pullId, viewer);
      case "connection.connect": return this.connect(command.connectionId, viewer);
      case "module.switch": this.requireOwner(viewer); return done([{ type: "module.changed", moduleId: command.moduleId }]);
      case "handover.confirm": return this.confirm(command.laneId, viewer);
    }
  }

  private checkText(text: string): void {
    if (Array.from(text).length > 4000) throw new Problem("badRequest", "Text is limited to 4,000 characters.");
  }

  private requireOwner(viewer: Actor): void {
    if (viewer.id !== this.owner.id) throw new Problem("forbidden", "Only the workspace owner can do that.");
  }

  private accessEntry(id: string, viewer: Actor) {
    return this.access.get(id)?.people.find(item => item.person.id === viewer.id);
  }

  private role(id: string, viewer: Actor): TopicRole {
    if (viewer.id === this.owner.id) return "owner";
    const kind = this.accessEntry(id, viewer)?.access.kind;
    return kind && kind !== "unknown" ? kind : "none";
  }

  private fullTopic(id: string, viewer: Actor): boolean {
    const role = this.role(id, viewer);
    return role === "owner" || role === "all";
  }

  private writableTopic(id: string, viewer: Actor, lane?: LaneView): void {
    requireRecord(this.topics.get(id), "topic");
    if (this.fullTopic(id, viewer)) return;
    if (lane && this.role(id, viewer) === "stages" && this.sharedLane(lane, viewer)) return;
    throw new Problem("forbidden", "This reader cannot change that work.");
  }

  private sharedLane(lane: LaneView, viewer: Actor): boolean {
    if (!lane.topicId) return viewer.id === this.owner.id;
    if (this.fullTopic(lane.topicId, viewer)) return true;
    const entry = this.accessEntry(lane.topicId, viewer);
    if (entry?.access.kind !== "stages") return false;
    const topic = this.topics.get(lane.topicId);
    const stage = topic?.plan?.stages.find(item => item.rows.some(row => row.laneId === lane.id))?.name;
    return stage ? (entry.access.stages ?? []).includes(stage) : lane.waitsFor?.id === viewer.id;
  }

  private lane(id: string): LaneView | undefined {
    const stored = this.lanes.get(id);
    if (!stored || this.removed.has(id)) return undefined;
    const lane = structuredClone(stored);
    const reverted = this.reverted.get(id);
    if (reverted?.size) {
      if (lane.state === "done") {
        lane.state = "idle";
        lane.stateWord = "Undone";
        lane.closedAt = null;
      }
      lane.status = "An action on this lane was undone.";
      lane.standing = { headline: "Action undone", detail: lane.status };
    }
    const decision = lane.decisionId && this.decisions.get(lane.decisionId);
    const held = decision && this.pulls.items.some(pull => pull.decisionId === decision.id && pull.held);
    if (decision && decision.state !== "open") {
      lane.acts = decision.state === "expired" ? [] : [{ id: "undo", label: "Undo", tone: "quiet", target: null, personId: null }];
      if (decision.state === "approved" && !held) {
        lane.state = "ok";
        lane.stateWord = "Working";
        lane.next = lane.afterNext ?? lane.next;
        lane.standing = { headline: "You approved it.", detail: lane.after ?? lane.status };
        let promoted = false;
        lane.steps = lane.steps.map(step => {
          if (step.kind === "now") return { ...step, kind: "ok" };
          if (step.kind === "todo" && !promoted) {
            promoted = true;
            return { ...step, kind: "now" };
          }
          return step;
        });
      } else {
        const headline = held ? "The pull request is held." : decision.state === "declined" ? "You declined it." : "The decision expired.";
        lane.standing = { headline, detail: decision.ifNoAnswer ?? lane.status };
      }
    }
    return lane;
  }

  private visibleLane(id: string, viewer: Actor): LaneView {
    const lane = requireRecord(this.lane(id), "lane");
    if (!this.sharedLane(lane, viewer)) throw new Problem("forbidden", "That lane is outside this reader’s access.");
    return lane;
  }

  private allLanes(viewer: Actor): LaneView[] {
    return [...this.lanes.keys()].flatMap(id => {
      const lane = this.lane(id);
      return lane && this.sharedLane(lane, viewer) ? [lane] : [];
    });
  }

  private sidebar(viewer: Actor): SidebarView {
    const lanes = this.allLanes(viewer).filter(lane => lane.state !== "done").sort(sortLanes);
    const pinIds = this.pinsOf(viewer);
    const pinnable = this.sidebarBase.pinnable.filter(pin => this.pinVisible(pin, viewer)).map(pin => ({ ...pin, pinned: pinIds.includes(pin.id) }));
    const summarize = (lane: LaneView) => ({
      id: lane.id, title: lane.title, state: lane.state, stateWord: lane.stateWord, leadName: labelFor(lane, viewer), fresh: lane.fresh,
    });
    const groups = this.sidebarBase.groups.filter(group => this.role(group.id, viewer) !== "none").map(group => {
      const topic = this.topics.get(group.id);
      const inGroup = lanes.filter(lane => lane.topicId === group.id);
      const worst = inGroup[0]?.state;
      const mark = worst && ["bad", "warn", "new", "ok"].includes(worst) ? worst === "new" ? "ok" : worst : null;
      return { ...group, open: topic?.open ?? group.open, stateWord: worst ? WORDS[worst] : topic?.health?.word ?? "Idle", mark, lanes: inGroup.map(summarize) };
    });
    return {
      ...this.sidebarBase, groups, pinnable, managerLanes: lanes.filter(lane => !lane.topicId).map(summarize),
      pins: pinIds.flatMap(id => {
        const pin = byId(pinnable, id);
        return pin ? [pin] : [];
      }),
    };
  }

  private queue(viewer: Actor): DecisionQueueView {
    const items = [...this.decisions.values()].filter(d => this.fullTopic(d.topicId, viewer)).map(d => ({
      id: d.id, title: d.title, state: d.state, topicName: d.topicName, target: target("decision", d.id), goalChange: d.goalChange,
    }));
    return { items, total: items.length, open: items.filter(item => item.state === "open").length };
  }

  private decisionView(id: string, viewer: Actor): DecisionView {
    const decision = requireRecord(this.decisions.get(id), "decision");
    if (!this.fullTopic(decision.topicId, viewer)) throw new Problem("forbidden", "That decision is outside this reader’s access.");
    const queue = this.queue(viewer);
    return { ...decision, position: { index: queue.items.findIndex(item => item.id === id) + 1, of: queue.total, open: queue.open } };
  }

  private brief(viewer: Actor): BriefView {
    const prefs = this.prefsOf(viewer);
    const view = structuredClone(this.briefBase);
    view.decisions = [...this.decisions.values()].filter(d => this.fullTopic(d.topicId, viewer)).map(d => ({
      id: d.id, topicId: d.topicId, topicName: d.topicName, title: d.title, dueAt: d.dueAt, whyYours: d.whyYours ?? "",
      context: d.cardContext, minutes: d.minutes, doneNote: d.doneNote, laneId: d.laneId, state: d.state,
    }));
    view.openCount = view.decisions.filter(d => d.state === "open").length;
    view.minutes = view.decisions.filter(d => d.state === "open").reduce((total, d) => total + d.minutes, 0);
    view.burns = view.burns.flatMap(burn => {
      const lane = this.lane(burn.laneId);
      const topic = lane?.topicId ? this.topics.get(lane.topicId) : undefined;
      return lane?.state === "bad" && topic && this.sharedLane(lane, viewer)
        ? [{ ...burn, topicId: topic.id, topicName: topic.name }] : [];
    });
    view.overnight = view.overnight.filter(item => viewer.id === this.owner.id || (item.topicId && this.fullTopic(item.topicId, viewer)))
      .map(item => ({ ...item, undone: this.history.get(this.overnightAliases.get(item.id) ?? item.id)?.row.undone ?? false }));
    view.topics = view.topics.filter(topic => this.role(topic.id, viewer) !== "none").map(item => {
      const topic = this.topicView(item.id, viewer, new URLSearchParams());
      const original = this.topics.get(item.id)?.goal;
      const progress = topic.goal && original && topic.goal.target !== original.target
        ? `${topic.goal.signed} of ${topic.goal.target} ${topic.goal.unit}` : item.progress;
      return { ...item, progress, verdict: topic.goal?.verdict.word ?? topic.health?.word ?? item.verdict,
        state: topic.goal?.verdict.state ?? topic.health?.state ?? item.state };
    });
    const key = (["no", "one", "two", "three", "four"] as const)[view.openCount] ?? String(view.openCount);
    const burns = view.burns.length === 0 ? "" : view.burns.length === 1
      ? this.module === "dev" ? " and main is red in the web app" : " and one thing is stuck" : ` and ${view.burns.length} things are stuck`;
    const decisions = `${key[0]?.toUpperCase() ?? ""}${key.slice(1)} ${view.openCount === 1 ? "decision needs" : "decisions need"} you`;
    view.lede = `${decisions}${burns}. ${this.module === "dev" ? "Everything else was built, reviewed and shipped while you slept." : "Everything else moved on its own while you slept."}`;
    view.nextBriefAt = this.nextBrief(prefs.briefsPerDay);
    view.cadence = prefs.interruptOnlyUrgent ? "Between briefs, you hear only about what cannot wait." : "Between briefs, you hear about changes as they happen.";
    if (viewer.id === this.owner.id) {
      const drafts = this.draftsView();
      if (view.drafts.count !== drafts.count) {
        view.drafts = { count: drafts.count, text: `${drafts.count} drafts wait in your mail`, detail: "Nothing is sent until you send it." };
      }
      if (view.inWorks) {
        const pulls = this.pulls.items.filter(pull => pull.state !== "released");
        view.inWorks = {
          ...view.inWorks, count: pulls.length, ready: pulls.filter(pull => pull.state === "ready").length,
          inReview: pulls.filter(pull => pull.state === "inReview" || pull.state === "blocked").length,
          autoMergeAt: pulls.flatMap(pull => pull.autoMergeAt && pull.state === "autoMerge" ? [pull.autoMergeAt] : []).sort()[0] ?? null,
        };
      }
    } else {
      view.spend = null;
      view.drafts = { count: 0, text: "", detail: "" };
      view.inWorks = null;
    }
    return view;
  }

  private nextBrief(count: number): string {
    const times = count === 1 ? ["07:15"] : count === 2 ? ["07:15", "16:00"] : ["07:15", "13:00", "18:00"];
    const now = Date.parse(this.now);
    const first = times[0] ?? "07:15";
    const day = new Date(now + 3600000).toISOString().slice(0, 10);
    const local = (date: string, time: string) => `${date}T${time}:00+01:00`;
    return times.map(time => local(day, time)).find(at => Date.parse(at) > now)
      ?? local(new Date(now + 25 * 3600000).toISOString().slice(0, 10), first);
  }

  private manager(viewer: Actor): ManagerView {
    const order = new Map(this.managerBase.lanes.map((item, index) => [item.id, index]));
    const lanes = this.allLanes(viewer).filter(lane => lane.state !== "done" && (this.module !== "dev" || lane.state !== "next"))
      .sort((a, b) => (order.get(a.id) ?? -1) - (order.get(b.id) ?? -1) || sortLanes(a, b));
    const projects = new Set(lanes.flatMap(lane => lane.topicId ? [lane.topicId] : []));
    const waiting = lanes.filter(lane => !lane.waitsFor && (lane.state === "warn" || (this.module === "gtm" && lane.state === "bad"))).length;
    const asks: Ask[] = [...this.filed.values()].reverse().flatMap(receipt => {
      const lane = this.lane(receipt.laneId);
      if (!lane) return [];
      const topic = lane.topicId ? this.topics.get(lane.topicId) : undefined;
      return [{
        id: `ask-${lane.id}`, quote: receipt.text, at: lane.openedAt, chat: lane.askedMeta.source,
        went: topic ? `Filed under ${topic.name}. ${lane.lead.name} leads.` : "With the Manager",
        target: target("lane", lane.id),
      }];
    });
    return {
      ...this.managerBase,
      summary: `${lanes.length} lanes in ${projects.size} ${this.module === "dev" ? "projects" : "topics"} · ${waiting ? `${waiting} wait for you` : "none waits for you"}`,
      lanes: lanes.map(lane => ({
        id: lane.id, title: lane.title, topicId: lane.topicId, topicName: this.topics.get(lane.topicId ?? "")?.name ?? "Manager",
        leadName: labelFor(lane, viewer), state: lane.state, stateWord: lane.stateWord, next: lane.next ?? "",
        reason: byId(this.managerBase.lanes, lane.id)?.reason ?? null,
      })),
      asks: [...asks, ...this.managerBase.asks],
    };
  }

  private topicView(id: string, viewer: Actor, query: URLSearchParams): TopicView {
    const stored = requireRecord(this.topics.get(id), "topic");
    const role = this.role(id, viewer);
    if (role === "none") throw new Problem("forbidden", `Nothing here is shared with ${viewer.shortName}.`);
    const stages = this.accessEntry(id, viewer)?.access.stages ?? [];
    const view = structuredClone(stored);
    view.viewer = { role, stages, sharedBy: role === "owner" ? null : this.owner };
    view.stages = view.stages.map(stage => {
      const access = this.fullTopic(id, viewer) || stages.includes(stage.name)
        ? "work" : role === "view" ? "view" : "locked";
      return { ...stage, access, runBy: access === "work" ? stage.runBy : null };
    });
    const lanes = this.allLanes(viewer).filter(lane => lane.topicId === id).sort(sortLanes);
    view.lanes = lanes.map(lane => ({
      id: lane.id, title: lane.title, state: lane.state, stateWord: lane.stateWord,
      leadName: labelFor(lane, viewer), next: lane.next ?? "",
    }));
    const approved = (decisionId: string) => this.decisions.get(decisionId)?.state === "approved";
    const settled = stored.stuck && stored.stuck.actions.length > 0 && !lanes.some(lane => lane.id === stored.stuck?.actions[0]?.laneId && lane.state === "bad");
    if (settled) {
      view.stuck = null;
      if (view.health?.state === "bad") view.health = { state: "ok", word: "Working again" };
    }
    view.jobs = view.jobs.map(job => {
      const lane = job.laneId ? byId(lanes, job.laneId) : undefined;
      return lane ? { ...job, state: lane.state } : job;
    });
    view.tasks = view.tasks.map(task => {
      const lane = task.laneId ? byId(lanes, task.laneId) : undefined;
      return lane ? { ...task, state: lane.state, stateWord: lane.stateWord, next: lane.next ?? task.next } : task;
    });
    if (view.plan) {
      for (const stage of view.plan.stages) {
        if (stage.alt && approved(stage.alt.decisionId)) {
          stage.state = stage.alt.state ?? stage.state;
          stage.percent = stage.alt.percent ?? stage.percent;
          stage.summary = stage.alt.summary ?? stage.summary;
        }
        for (const row of stage.rows) {
          if (!row.alt || !approved(row.alt.decisionId)) continue;
          row.state = row.alt.state ?? row.state;
          row.text = row.alt.text ?? row.text;
          row.when = row.alt.when ?? row.when;
        }
        if (role === "view" || (role === "stages" && !stages.includes(stage.name))) {
          stage.rows = [];
          stage.summary = "";
          stage.alt = null;
        }
      }
      if (role === "view" || role === "stages") view.plan.night = [];
    }
    if (view.goal) {
      const goal = view.goal;
      const latest = [...this.decisions.values()].findLast(item => item.topicId === id && item.goalChange && item.state === "approved")?.goalChange;
      if (latest) {
        goal.target = latest.to;
        goal.trajectory.goal = latest.to;
      }
      const decision = goal.decision?.decisionId && this.decisions.get(goal.decision.decisionId);
      if (goal.decision && decision && decision.state === "approved") {
        goal.decision.title = goal.decision.done ?? goal.decision.title;
        const lane = goal.decision.laneId && this.lane(goal.decision.laneId);
        if (lane && lane.shortAfter) goal.decision.detail = lane.shortAfter;
      }
      for (const deal of goal.deals) {
        const alt = deal.alt;
        if (alt && approved(alt.decisionId)) {
          deal.stage = alt.stage ?? deal.stage;
          deal.short = alt.short ?? deal.short;
          deal.next = alt.next ?? deal.next;
        }
      }
      goal.blockers = goal.blockers.filter(blocker => {
        if (!blocker.laneId) return true;
        return this.lane(blocker.laneId)?.topicId === id;
      });
      const cleared = goal.blockers.filter(blocker => blocker.laneId && this.lane(blocker.laneId)?.state === "ok" && stored.lanes.some(lane => lane.id === blocker.laneId && lane.state === "bad"));
      if (cleared.length) {
        goal.blockers = goal.blockers.filter(blocker => !cleared.includes(blocker));
        goal.calm = "Working again";
        goal.calmSub = cleared.map(blocker => this.lane(blocker.laneId ?? "")?.status).filter(Boolean).join(" ");
        goal.verdict = {
          ...goal.verdict, action: "Work resumed", text: goal.calmSub,
          state: goal.verdict.state === "bad" ? "warn" : goal.verdict.state,
        };
      }
      if (goal.guardrails && view.spend && view.spend.cap.amountMinor > 0) {
        const ratio = view.spend.spent.amountMinor / view.spend.cap.amountMinor;
        if (id !== "partnerships") goal.guardrails.items.push({
          what: "Agents this week", value: "", limit: "Then they pause and ask", ratio,
          state: ratio >= 1 ? "breached" : ratio >= 0.8 ? "near" : "held",
        });
      }
    }
    if (role === "view" || role === "stages") {
      view.goal = null;
      view.spend = null;
      view.meta = null;
      view.crew = [];
      view.jobs = [];
      view.tasks = [];
      view.facts = [];
      view.stuck = null;
      view.focusLaneId = null;
      view.noGoal = null;
      view.intro = "";
      view.chatSub = role === "view" ? "" : `${stages.join(", ")} chat`;
    }
    view.history = role === "view" || (!stored.history && ![...this.history.values()].some(action => action.topicId === id))
      ? null : this.historyView(id, viewer, query);
    return view;
  }

  private historyView(id: string, viewer: Actor, query: URLSearchParams): HistoryPage {
    const topic = requireRecord(this.topics.get(id), "topic");
    const role = this.role(id, viewer);
    if (role !== "owner" && role !== "all" && role !== "stages") throw new Problem("forbidden", "The topic’s history is outside this reader’s access.");
    const base = topic.history;
    const canSee = (entry: HistoryRow) => {
      if (entry.decisionId && this.decisions.get(entry.decisionId)?.state !== "approved") return false;
      if (role !== "stages") return true;
      const lane = entry.laneId && this.lanes.get(entry.laneId);
      return Boolean(lane && this.sharedLane(lane, viewer));
    };
    const existing = (base?.days ?? []).flatMap(day => day.entries.flatMap(entry => {
      if (entry.kind !== "event" || !canSee(entry)) return [];
      return [{ label: day.label, entry: this.history.get(entry.id)?.row ?? entry }];
    }));
    const added = [...this.history.values()].filter(action => action.topicId === id && !this.fixtureActions.has(action.row.id) && canSee(action.row)).reverse()
      .map(action => ({ label: Date.parse(action.row.at) < Date.parse(hour("00:00")) ? "Sunday 15 November" : "Monday 16 November", entry: action.row }));
    const { items, nextCursor } = page([...added, ...existing], item => item.entry.id, `history:${id}:${viewer.id}`, query);
    const days: HistoryPage["days"] = [];
    const seenAt = this.seen.get(`${viewer.id}:${id}`) ?? (role === "owner" ? base?.seen.at : null) ?? null;
    let seenAdded = false;
    for (const { label, entry } of items) {
      let day = days.at(-1);
      if (!day || day.label !== label) {
        day = { label, entries: [] };
        days.push(day);
      }
      if (!seenAdded && seenAt && query.get("cursor") === null && Date.parse(entry.at) < Date.parse(seenAt)) {
        day.entries.push({ kind: "seen" });
        seenAdded = true;
      }
      day.entries.push(entry);
    }
    return { seen: { at: seenAt }, shown: items.length, since: base?.since ?? "", days, nextCursor };
  }

  private threadTopic(id: string): string | null {
    const scope = threadScope(id);
    if (scope?.kind === "topic") return scope.id;
    if (scope?.kind === "lane") return this.lanes.get(scope.id)?.topicId ?? null;
    if (scope?.kind === "decision") return this.decisions.get(scope.id)?.topicId ?? null;
    return null;
  }

  private canReadThread(id: string, viewer: Actor): boolean {
    const scope = threadScope(id);
    if (!scope) return false;
    if (scope.kind === "lane") {
      const lane = this.lanes.get(scope.id);
      return Boolean(lane && this.sharedLane(lane, viewer));
    }
    const topicId = this.threadTopic(id);
    return topicId ? this.fullTopic(topicId, viewer) || (scope.kind === "topic" && this.role(topicId, viewer) === "stages") : viewer.id === this.owner.id;
  }

  private writableThread(id: string, viewer: Actor): ThreadView {
    const thread = requireRecord(this.threads.get(id), "thread");
    const laneId = threadScope(id)?.kind === "lane" ? threadScope(id)?.id : null;
    if (laneId && this.removed.has(laneId)) throw missing("thread");
    const topicId = this.threadTopic(id);
    if (topicId) this.writableTopic(topicId, viewer, laneId ? this.lanes.get(laneId) : undefined);
    else this.requireOwner(viewer);
    return thread;
  }

  private threadView(id: string, viewer: Actor, query: URLSearchParams): ThreadView {
    const stored = requireRecord(this.threads.get(id), "thread");
    const scope = threadScope(id);
    if (scope?.kind === "lane" && this.removed.has(scope.id)) throw missing("thread");
    if (!this.canReadThread(id, viewer)) throw new Problem("forbidden", "This reader cannot see that conversation.");
    const associatedTopic = this.threadTopic(id);
    const view = structuredClone(stored);
    if (associatedTopic && scope?.kind === "topic" && this.role(associatedTopic, viewer) === "stages") {
      const stages = this.accessEntry(associatedTopic, viewer)?.access.stages ?? [];
      view.scope = `${stages.join(", ")} only`;
      view.sub = view.scope;
      view.since = null;
      view.agents = null;
      view.pinned = null;
      view.suggestions = [];
      view.messages = view.messages.filter(message => {
        const lane = message.threadCard && this.lanes.get(message.threadCard.laneId);
        return Boolean(lane && this.sharedLane(lane, viewer));
      });
    } else if (associatedTopic) {
      const seen = this.seen.get(`${viewer.id}:${associatedTopic}`);
      if (seen && view.since) view.since = { ...view.since, seen: { at: seen } };
      if (seen && view.agents) {
        const items = view.agents.items.filter(item => Date.parse(item.at) > Date.parse(seen));
        view.agents = { seen: { at: seen }, items, count: items.length, summary: `${items.length} agent updates since your last visit` };
      }
    }
    const edited = this.sinceEdits.get(JSON.stringify([viewer.id, id]));
    if (edited) view.since = { seen: view.since?.seen ?? { at: null }, lines: edited };
    const pin = view.pinned;
    const decision = pin?.decisionId ? this.decisions.get(pin.decisionId) : undefined;
    if (pin && decision && decision.state !== "open" && decision.state !== "unknown") {
      pin.state = decision.state;
      if (decision.state === "approved") {
        const lane = pin.laneId ? this.lane(pin.laneId) : undefined;
        pin.title = `${lane?.short ?? pin.title}: you approved it`;
        if (lane?.shortAfter) pin.detail = lane.shortAfter;
      }
    } else if (pin && pin.laneId && this.lane(pin.laneId)?.state !== "bad" && pin.state === "stuck") {
      view.pinned = null;
    }
    const result = page([...view.messages].reverse(), item => item.id, `thread:${id}:${viewer.id}`, query);
    return { ...view, messages: result.items.reverse(), nextCursor: result.nextCursor };
  }

  private search(query: URLSearchParams, viewer: Actor): SearchView {
    const text = query.get("q") ?? "";
    this.checkText(text);
    const scope = query.get("scope") ?? "";
    if (scope && this.role(scope, viewer) === "none") throw new Problem("forbidden", "This reader cannot search that topic.");
    const topics = [...this.topics.keys()].filter(id => this.role(id, viewer) !== "none")
      .map(id => this.topicView(id, viewer, new URLSearchParams()));
    const lanes = this.allLanes(viewer);
    const people = topics.flatMap(topic => topic.crew.filter(actor => actor.kind === "person").map(actor => ({ actor, topicId: topic.id })));
    const decisions = [...this.decisions.values()].filter(d => this.fullTopic(d.topicId, viewer))
      .map(d => ({ ...d, lead: d.laneId ? this.lane(d.laneId)?.lead ?? null : null }));
    const results = searchResults(text, scope, topics, lanes, people, decisions, this.skills.skills);
    const scopeKey = createHash("sha256").update(JSON.stringify([text, scope, viewer.id])).digest("base64url");
    const { items, nextCursor } = page(results, item => `${item.kind}:${item.id}`, `search:${scopeKey}`, query);
    return { query: text, scope: scope || null, results: items, nextCursor, answer: isQuestion(text) ? answerTo(text, scope || null, topics, lanes) : null };
  }

  private prefsOf(viewer: Actor, deviceId: string | null = null): Preferences {
    const prefs = this.preferences.get(viewer.id) ?? this.settings;
    return {
      theme: prefs.theme, chatMode: prefs.chatMode, layout: this.layouts.get(`${viewer.id}:${deviceId ?? ""}`) ?? prefs.layout,
      briefsPerDay: prefs.briefsPerDay, interruptOnlyUrgent: prefs.interruptOnlyUrgent,
    };
  }

  private setPrefs(command: Extract<Command, { type: "prefs.set" }>, viewer: Actor): Effect {
    const prefs = structuredClone(this.prefsOf(viewer));
    if (command.theme) applyTheme(prefs.theme, command.theme);
    if (command.chatMode) prefs.chatMode = command.chatMode;
    if (command.interruptOnlyUrgent != null) prefs.interruptOnlyUrgent = command.interruptOnlyUrgent;
    if (command.briefsPerDay != null) prefs.briefsPerDay = command.briefsPerDay;
    if (command.layout) {
      const device = command.deviceId ?? null;
      const layout = { ...this.prefsOf(viewer, device).layout };
      if (command.layout.sidebarWidth != null) layout.sidebarWidth = command.layout.sidebarWidth;
      if (command.layout.chatWidth != null) layout.chatWidth = command.layout.chatWidth;
      if (device) this.layouts.set(`${viewer.id}:${device}`, layout);
      else prefs.layout = layout;
    }
    this.preferences.set(viewer.id, prefs);
    return done([{ type: "prefs.changed" }, ...(command.briefsPerDay != null ? [{ type: "brief.published" } as const] : [])]);
  }

  private decisionRight(rule: string, who: "you" | "agent", dailyLimit: DailyLimit | null | undefined, viewer: Actor): Effect {
    this.requireOwner(viewer);
    const setting = requireRecord(this.settings.decisionRights.find(item => item.rule === rule), "decision right");
    if (setting.risky && who === "agent" && dailyLimit == null) throw new Problem("badRequest", "Delegating this decision right requires a daily limit.");
    setting.who = who;
    setting.dailyLimit = who === "you" ? null : dailyLimit ?? null;
    return done([{ type: "prefs.changed" }]);
  }

  private pinsOf(viewer: Actor): string[] {
    return this.pinned.get(viewer.id) ?? (viewer.id === this.owner.id ? this.sidebarBase.pins.map(pin => pin.id) : []);
  }

  private pinVisible(pin: Pin, viewer: Actor): boolean {
    return viewer.id === this.owner.id || (pin.target?.kind === "topic" && this.role(pin.target.id ?? "", viewer) !== "none");
  }

  private pin(id: string, viewer: Actor, action: "add" | "remove" | "move", to = 0): Effect {
    const pin = requireRecord(byId(this.sidebarBase.pinnable, id), "pin");
    if (!this.pinVisible(pin, viewer)) throw new Problem("forbidden", "That pin is outside this reader’s access.");
    const pins = this.pinsOf(viewer).slice();
    const from = pins.indexOf(id);
    if (action === "add" && from < 0) {
      if (pins.length >= this.sidebarBase.pinLimit) throw new Problem("limitReached", "The sidebar holds up to 12 pins.");
      pins.push(id);
    } else if (action === "remove" && from >= 0) {
      pins.splice(from, 1);
    } else if (action === "move") {
      if (from < 0 || to < 0 || to >= pins.length) throw new Problem("badRequest", "The pin or destination is outside the pinned list.");
      pins.splice(from, 1);
      pins.splice(to, 0, id);
    } else {
      return done();
    }
    this.pinned.set(viewer.id, pins);
    return done([{ type: "pins.changed", pinId: id }]);
  }

  private accessView(id: string): AccessView {
    const stored = requireRecord(this.access.get(id), "topic");
    return {
      ...stored,
      people: stored.people.map(entry => ({
        ...entry, scope: entry.owner ? "owner" : entry.access.kind === "all" ? "everything" : entry.access.kind === "view" ? "status only"
          : entry.access.kind === "stages" ? (entry.access.stages ?? []).join(", ") : "no access",
        otherTopics: [...this.access].flatMap(([topicId, view]) => {
          if (topicId === id) return [];
          const access = view.people.find(item => item.person.id === entry.person.id)?.access.kind;
          return access && access !== "none" ? [{ topicId, access }] : [];
        }),
      })),
    };
  }

  private status(id: string, viewer: Actor) {
    const topic = requireRecord(this.topics.get(id), "topic");
    if (!this.access.get(id)?.statusLink) throw missing("status link");
    if (!this.people.has(viewer.id)) throw new Problem("forbidden", "The status link is for this workspace.");
    return { health: topic.health, stages: (topic.plan?.stages ?? []).map(({ name, percent }) => ({ name, percent })) };
  }

  private setAccess(id: string, personId: string, kind: "all" | "stages" | "view" | "none", stages: string[], viewer: Actor): Effect {
    this.requireOwner(viewer);
    const access = requireRecord(this.access.get(id), "topic");
    const topic = requireRecord(this.topics.get(id), "topic");
    const person = requireRecord(this.people.get(personId), "person");
    if (personId === this.owner.id) throw new Problem("conflict", "The owner’s access cannot change.");
    if ((kind === "stages" && (!stages.length || stages.some(name => !topic.stages.some(stage => stage.name === name)))) || (kind !== "stages" && stages.length)) {
      throw new Problem("badRequest", "Choose existing stages only for stage-based access.");
    }
    const grant = { kind, stages: [...new Set(stages)] };
    const current = this.accessEntry(id, person);
    if (current) current.access = grant;
    else access.people.push({ person, access: grant, owner: false, scope: "", otherTopics: [] });
    for (const stage of topic.stages) {
      if (stage.runBy?.id === personId && !(kind === "all" || grant.stages.includes(stage.name))) stage.runBy = null;
    }
    return done([{ type: "access.changed", topicId: id }]);
  }

  private assign(id: string, stageName: string, personId: string, viewer: Actor): Effect {
    this.requireOwner(viewer);
    const topic = requireRecord(this.topics.get(id), "topic");
    const stage = topic.stages.find(item => item.name === stageName);
    if (!stage) throw new Problem("badRequest", "That stage does not exist.");
    const next = requireRecord(this.people.get(personId), "person");
    const prior = stage.runBy;
    if (prior && prior.id !== personId) {
      const entry = this.accessEntry(id, prior);
      if (entry?.access.kind === "stages") {
        entry.access.stages = (entry.access.stages ?? []).filter(name => name !== stageName);
        if (entry.access.stages.length === 0) entry.access.kind = "view";
      }
    }
    if (next.id !== this.owner.id) {
      const entry = this.accessEntry(id, next);
      if (entry?.access.kind !== "all") {
        const stages = [...new Set([...(entry?.access.stages ?? []), stageName])];
        this.setAccess(id, personId, "stages", stages, viewer);
      }
    }
    stage.runBy = next;
    return done([{ type: "access.changed", topicId: id }, { type: "topic.changed", topicId: id }]);
  }

  private invite(id: string, nameOrEmail: string, viewer: Actor): Effect {
    this.requireOwner(viewer);
    const access = requireRecord(this.access.get(id), "topic");
    const name = nameOrEmail.trim();
    if (!name) throw new Problem("badRequest", "Enter a name or email address.");
    if (access.invitations.some(item => item.nameOrEmail.toLowerCase() === name.toLowerCase())) return done();
    access.invitations.push({ id: `invite-${++this.serial}`, nameOrEmail: name, state: "pending", invitedAt: this.now });
    return done([{ type: "access.changed", topicId: id }]);
  }

  private revoke(id: string, viewer: Actor): Effect {
    this.requireOwner(viewer);
    for (const [topicId, access] of this.access) {
      const i = access.invitations.findIndex(invitation => invitation.id === id);
      if (i < 0) continue;
      access.invitations.splice(i, 1);
      return done([{ type: "access.changed", topicId }]);
    }
    throw missing("invitation");
  }

  private statusLink(id: string, viewer: Actor): Effect {
    this.requireOwner(viewer);
    const access = requireRecord(this.access.get(id), "topic");
    access.statusLink ??= { url: `${this.origin()}${BASE}/topics/${id}/status`, orgOnly: true };
    return done([{ type: "access.changed", topicId: id }]);
  }

  private visit(id: string, viewer: Actor): Effect {
    requireRecord(this.topics.get(id), "topic");
    if (this.role(id, viewer) === "none") throw new Problem("forbidden", "This topic is not shared with this reader.");
    this.seen.set(`${viewer.id}:${id}`, this.now);
    return done([{ type: "topic.changed", topicId: id }, { type: "thread.changed", threadId: `topic:${id}` }]);
  }

  private remember(topicId: string | null, record: string, text: string, actor: Actor, apply: HistoryAction["apply"],
    laneId: string | null = null, id = `action-${++this.serial}`, at = this.now): HistoryAction {
    const action: HistoryAction = {
      row: { id, kind: "event", at, actor, text, laneId, decision: false, sentOutside: false, undoable: true, undone: false,
        count: null, samples: [], decisionId: null },
      topicId, record, apply,
    };
    this.history.set(id, action);
    return action;
  }

  private rememberRecorded(topicId: string | null, id: string, text: string, actor: Actor, laneId: string | null, at: string): HistoryAction {
    const apply = (undone: boolean): Event[] => {
      if (!laneId) return topicId ? [{ type: "topic.changed", topicId }] : [];
      const set = this.reverted.get(laneId) ?? new Set<string>();
      if (undone) set.add(id);
      else set.delete(id);
      this.reverted.set(laneId, set);
      return laneUpdate(laneId, topicId);
    };
    return this.remember(topicId, id, text, actor, apply, laneId, id, at);
  }

  private undo(id: string, undone: boolean, viewer: Actor): Effect {
    const action = requireRecord(this.history.get(this.overnightAliases.get(id) ?? id), "action");
    const lane = action.row.laneId ? this.lanes.get(action.row.laneId) : undefined;
    if (action.topicId) this.writableTopic(action.topicId, viewer, lane);
    else this.requireOwner(viewer);
    if (action.row.undone === undone) return done();
    const actions = [...this.history.values()].filter(item => item.record === action.record);
    const later = actions.slice(actions.indexOf(action) + 1);
    if (later.some(item => !item.row.undone)) throw new Problem("conflict", "Undo the newer change to this record first.");
    const events = action.apply(undone);
    action.row.undone = undone;
    return done([...events, { type: "agentAction.changed", actionId: action.row.id }], action.row.laneId);
  }

  private file(text: string, viewer: Actor, options: FileOptions): FileResult {
    const model = this.model(options.model);
    const route = options.route === false ? null : routePreview(text, options.topicId ?? null, this.topics, this.routes);
    const topicId = options.topicId ?? route?.topicId ?? null;
    const topic = topicId ? requireRecord(this.topics.get(topicId), "topic") : undefined;
    if (topic) this.writableTopic(topic.id, viewer);
    else this.requireOwner(viewer);
    const proposedLead = options.leadId && topic ? requireRecord(byId(topic.crew, options.leadId), "lead") : null;
    const assigned = proposedLead ?? (topic && leadFor(topic, text, this.routes)) ?? blankActor("Manager");
    const lead = { ...assigned, state: "new", word: "Leads", text: "Reading your ask", engine: model?.name ?? assigned.engine ?? "Auto" } satisfies Actor;
    const id = `new-${++this.serial}`;
    const chain = /\b(then|once|after|before)\b/i.test(text);
    const source = options.fromChat && topic ? `In the ${topic.name} chat` : "You to the Manager";
    const note = topic ? `Filed under ${topic.name}. ${lead.name} leads.` : "The Manager keeps it until it knows where it belongs.";
    const status = topic ? `${lead.name} is reading your ask and will set what done means before starting.` : note;
    const lane: LaneView = {
      id, topicId, title: text, state: "new", stateWord: "Starting", lead, waitsFor: null,
      openedAt: this.now, closedAt: null, next: "Within the hour", afterNext: null, decisionId: null,
      short: null, ask: null, shortAfter: null, recommendation: null, yours: null, checks: [], delay: null,
      approveLabel: null, after: null, asked: text, askedMeta: { source, note }, status,
      standing: { headline: "Just opened.", detail: status },
      acts: [{ id: "undo-file", label: "Undo", tone: "quiet", personId: null, target: null }],
      thumbs: [], steps: [
        { kind: "now", text: "Set what done means", who: lead.name },
        { kind: "todo", text: "Do the work", who: lead.name },
        { kind: "todo", text: "Check and report back", who: "Manager" },
      ],
      doneNote: "The lead sets the steps before it starts.", crew: [lead], made: [], handover: null, fresh: true,
      attachment: options.attachment ?? null, model: model?.id ?? null, chain, reminder: null,
    };
    const receipt: Receipt = {
      text: options.attachment ? `${text} (with file)` : text, filedUnder: topicId ? target("topic", topicId) : target("manager"),
      lead, chain, laneId: id,
    };
    const message = this.message(lead, `Filed it. ${note}`, null);
    message.threadCard = { title: text, owner: lead.name, stateWord: "just opened", laneId: id };
    const ask = this.message(viewer, text, null);
    ask.attachment = lane.attachment;
    ask.model = lane.model;
    if (topic) topic.open = true;
    this.lanes.set(id, lane);
    this.filed.set(id, receipt);
    this.threads.set(`lane:${id}`, {
      id: `lane:${id}`, title: text, sub: topic?.name ?? null, placeholder: "Message the lane",
      reading: null, since: null, pinned: null, agents: null, suggestions: [], messages: [ask, message], scope: null, nextCursor: null,
    });
    const filed: Event = { type: "lane.filed", laneId: id, topicId, chain };
    this.remember(topicId, id, receipt.text, viewer, undone => {
      if (undone) this.removed.add(id);
      else this.removed.delete(id);
      const events: Event[] = [undone ? { type: "lane.removed", laneId: id } : { ...filed, topicId: lane.topicId }];
      if (lane.topicId) events.push({ type: "topic.changed", topicId: lane.topicId });
      if (this.drafts.items.some(draft => draft.laneId === id)) events.push({ type: "drafts.changed" });
      return events;
    }, id, `file-${id}`);
    return { lane, receipt, message, events: [filed] };
  }

  private move(id: string, topicId: string, viewer: Actor): Effect {
    const lane = this.visibleLane(id, viewer);
    if (lane.topicId) this.writableTopic(lane.topicId, viewer, lane);
    this.writableTopic(topicId, viewer);
    if (lane.topicId === topicId) return done();
    const base = requireRecord(this.lanes.get(id), "lane");
    const topic = requireRecord(this.topics.get(topicId), "topic");
    const previous = { topicId: base.topicId, lead: base.lead, askedMeta: base.askedMeta, status: base.status };
    const lead = leadFor(topic, base.asked, this.routes) ?? base.lead;
    const note = `Filed under ${topic.name}. ${lead.name} leads.`;
    const next = { topicId, lead, askedMeta: { ...base.askedMeta, note }, status: base.state === "new" ? note : base.status };
    const apply = (undone: boolean): Event[] => {
      Object.assign(base, undone ? previous : next);
      const thread = this.threads.get(`lane:${id}`);
      if (thread) thread.sub = base.topicId ? this.topics.get(base.topicId)?.name ?? null : null;
      return [...laneUpdate(id, topicId), ...(previous.topicId ? [{ type: "topic.changed", topicId: previous.topicId } as const] : [])];
    };
    topic.open = true;
    this.remember(topicId, id, `Moved ${base.title} to ${topic.name}.`, viewer, apply, id);
    return done(apply(false));
  }

  private laneAct(id: string, actionId: string, viewer: Actor): Effect {
    const lane = this.visibleLane(id, viewer);
    if (lane.topicId) this.writableTopic(lane.topicId, viewer, lane);
    const action = byId(lane.acts, actionId);
    if (actionId === "undo-file" && action) return this.undo(`file-${id}`, true, viewer);
    if (lane.decisionId && actionId === "undo" && action) return this.setDecision(lane.decisionId, "open", viewer);
    if (lane.decisionId && actionId === "approve" && lane.approveLabel) return this.setDecision(lane.decisionId, "approved", viewer);
    if (!action) throw new Problem("badRequest", "That choice is not available on this lane.");
    if (action.target) return done([], id);
    if (action.personId) return this.remind(id, action.personId, viewer);
    const replies: Record<string, string> = {
      "post-passing": "Publisher uses the four images that pass the brand check for the 16:00 post.",
      "one-more-round": "Visuals gets one more round on the two images that failed the brand check.",
      "pin-the-old-session-library": "Builder pins the old session library and reruns the checks.",
      "allow-one-more-try": "Builder gets one more run to fix the failing sign-in test.",
    };
    const status = replies[action.id];
    if (!status || lane.state !== "bad") throw new Problem("badRequest", "That choice is not available on this lane.");
    const base = requireRecord(this.lanes.get(id), "lane");
    const previous = { state: base.state, stateWord: base.stateWord, status: base.status, next: base.next, standing: base.standing, steps: base.steps, acts: base.acts };
    const next = {
      state: "ok", stateWord: "Working", status, next: status, standing: { headline: "Working again.", detail: status },
      steps: base.steps.map(step => step.kind === "now" ? { ...step, text: status } : step), acts: [] as LaneAct[],
    };
    const apply = (undone: boolean): Event[] => {
      Object.assign(base, undone ? previous : next);
      return laneUpdate(id, base.topicId);
    };
    const record = this.remember(base.topicId, id, status, viewer, apply, id);
    return done([...apply(false), { type: "agentAction.changed", actionId: record.row.id }]);
  }

  private remind(id: string, personId: string, viewer: Actor): Effect {
    const lane = this.visibleLane(id, viewer);
    if (lane.topicId) this.writableTopic(lane.topicId, viewer, lane);
    const recipient = lane.waitsFor?.id === personId ? lane.waitsFor : byId(lane.crew, personId);
    if (!recipient || recipient.kind !== "person") throw missing("person");
    const base = requireRecord(this.lanes.get(id), "lane");
    const previous = base.reminder;
    const reminder = { personId, at: this.now };
    const apply = (undone: boolean) => {
      base.reminder = undone ? previous : reminder;
      return laneUpdate(id, base.topicId);
    };
    const action = this.remember(base.topicId, `reminder-${id}`, `Reminded ${recipient.shortName}.`, viewer, apply, id);
    return done([...apply(false), { type: "agentAction.changed", actionId: action.row.id }]);
  }

  private confirm(id: string, viewer: Actor): Effect {
    const lane = this.visibleLane(id, viewer);
    if (lane.topicId) this.writableTopic(lane.topicId, viewer, lane);
    const record = requireRecord(this.lanes.get(id), "lane");
    const handover = requireRecord(record.handover, "handover");
    if (handover.confirmedAt) return done();
    const match = handover.match;
    const confirmedAt = this.now;
    const apply = (undone: boolean): Event[] => {
      handover.match = undone ? match : true;
      handover.confirmedAt = undone ? null : confirmedAt;
      return [{ type: "handover.changed", laneId: id }, ...laneUpdate(id, record.topicId)];
    };
    this.remember(lane.topicId, `handover-${id}`, "Confirmed the handover.", viewer, apply, id);
    return done(apply(false));
  }

  private decisionEvents(decision: DecisionView): Event[] {
    const events: Event[] = [
      { type: "decision.changed", decisionId: decision.id, state: decision.state },
      { type: "topic.changed", topicId: decision.topicId },
    ];
    for (const lane of this.lanes.values()) if (lane.decisionId === decision.id) events.push({ type: "lane.changed", laneId: lane.id });
    for (const thread of this.threads.values()) if (thread.pinned?.decisionId === decision.id || thread.id === `decision:${decision.id}`) {
      events.push({ type: "thread.changed", threadId: thread.id });
    }
    return events;
  }

  private setDecision(id: string, state: "approved" | "declined" | "open", viewer: Actor): Effect {
    const decision = requireRecord(this.decisions.get(id), "decision");
    this.writableTopic(decision.topicId, viewer);
    if (decision.state === state) return done();
    if (decision.state === "expired" || (state !== "open" && decision.state !== "open")) {
      throw new Problem("conflict", "The decision is already settled.");
    }
    const actionId = `decision-${id}`;
    if (state === "open") {
      if (decision.release?.stage === "done") throw new Problem("conflict", "The rollout has already finished.");
      return this.undo(actionId, true, viewer);
    }
    const releaseStart = this.now;
    const pull = this.pulls.items.find(item => item.decisionId === id);
    if (state === "approved" && pull?.held) throw new Problem("conflict", "The pull request is held.");
    const initialPullState = pull?.state;
    const apply = (undone: boolean): Event[] => {
      if (decision.release?.stage === "done") throw new Problem("conflict", "The rollout has already finished.");
      if (pull?.held) throw new Problem("conflict", "Undo the pull request hold first.");
      if (decision.state !== (undone ? state : "open")) throw new Problem("conflict", "The decision has changed.");
      decision.state = undone ? "open" : state;
      const events = this.decisionEvents(decision);
      if (decision.release && state === "approved") {
        decision.release.stage = undone ? "scheduled" : "rolling";
        decision.release.startedAt = undone ? null : releaseStart;
        events.push({ type: "release.changed", decisionId: id });
      }
      if (pull && state === "approved" && !pull.held) {
        pull.state = undone ? initialPullState ?? "ready" : "releasing";
        events.push({ type: "pull.changed", pullId: pull.id });
      }
      return events;
    };
    this.remember(decision.topicId, actionId, `${state === "approved" ? "Approved" : "Declined"}: ${decision.title}`, viewer, apply, decision.laneId, actionId);
    return done(apply(false));
  }

  private questionReply(topic: TopicView, text: string): string {
    const answer = answerTo(text, topic.id, [topic], this.allLanes(this.owner).filter(lane => lane.topicId === topic.id));
    if (/halden/i.test(text) && topic.id === "partnerships") {
      const decision = this.decisions.get("d4");
      if (decision?.state === "open") return "From the record: the offer is drafted and waits for your OK, due Thursday. Halden sets its partner budget on 1 December.";
    }
    return `From the record: ${answer?.text ?? topic.goal?.insight ?? topic.intro}`;
  }

  private message(author: Actor, text: string, kind: LabelKind | null): Message {
    return {
      id: `m${++this.messageSerial}`, at: this.now, author, text,
      label: kind ? { kind, corrected: false, pinned: kind === "decision" } : null,
      threadCard: null, readBack: null, actions: [], decisionId: null, attachment: null, model: null, page: null,
    };
  }

  private send(command: Extract<Command, { type: "message.send" }>, viewer: Actor): Effect {
    const { threadId, text } = command;
    const thread = this.writableThread(threadId, viewer);
    const scope = requireRecord(threadScope(threadId), "thread");
    const topicId = this.threadTopic(threadId);
    const topic = topicId ? this.topicView(topicId, viewer, new URLSearchParams()) : null;
    const kind = scope.kind === "topic" || scope.kind === "manager" || scope.kind === "general" ? classify(text) : null;
    const model = this.model(command.model);
    const sent = this.message(viewer, text, kind);
    sent.attachment = command.attachment ?? null;
    sent.model = model?.id ?? null;
    sent.page = command.page ?? null;
    sent.decisionId = scope.kind === "decision" ? scope.id : null;
    const events: Event[] = [];
    let filed: FileResult | null = null;
    let reply: Message | null = null;
    if (kind === "request") {
      filed = this.file(text, viewer, { topicId, attachment: sent.attachment, model: sent.model, fromChat: true });
      sent.threadCard = filed.message.threadCard;
      sent.readBack = { owner: filed.lane.lead.name, quote: filed.message.text, at: this.now };
      reply = this.message(filed.message.author, filed.message.text, null);
      reply.threadCard = filed.message.threadCard;
      events.push(...filed.events);
    } else if (scope.kind === "lane") {
      const lane = this.visibleLane(scope.id, viewer);
      reply = this.message(lane.lead, "Got it. I add it to this lane and tell you here when it is done.", null);
    } else if (kind === "question" && topic) {
      reply = this.message(blankActor(`${topic.name} manager`), this.questionReply(topic, text), null);
    } else if (kind === "goalChange" && topic?.goal) {
      const decision = this.proposeGoal(topic, text, sent);
      reply = this.message(blankActor(`${topic.name} manager`), "I put the goal change in Decide. The goal stays as it is until you approve it.", null);
      reply.decisionId = decision.id;
      events.push(...this.decisionEvents(decision));
      if (!this.prefsOf(viewer).interruptOnlyUrgent) events.push({ type: "attention.raised", target: target("decision", decision.id), reason: "A proposed goal change needs a decision." });
    } else if (kind === "done" && topic) {
      reply = this.message(blankActor(`${topic.name} manager`), "Logged as done on the thread it belongs to.", null);
    } else if (kind === "decision" && topic) {
      sent.decisionId = thread.pinned?.decisionId ?? [...this.decisions.values()].find(item => item.topicId === topic.id && item.state === "open")?.id ?? null;
      reply = this.message(blankActor(`${topic.name} manager`), "Noted as a decision and pinned for the team.", null);
      reply.decisionId = sent.decisionId;
    }
    for (const message of reply ? [sent, reply] : [sent]) {
      thread.messages.push(message);
      events.push({ type: "message.posted", threadId, message });
    }
    return done(events, filed?.lane.id ?? null, sent, filed?.receipt ?? null);
  }

  private proposeGoal(topic: TopicView, text: string, message: Message): DecisionView {
    const goal = requireRecord(topic.goal, "goal");
    const number = /\b(?:to|target is|goal is)\s+(\d+)\b/i.exec(text)?.[1];
    const to = number ? Number(number) : NaN;
    if (!Number.isSafeInteger(to) || to <= 0) throw new Problem("badRequest", "Include the new numeric target after ‘to’.");
    const id = `dc-${++this.serial}`;
    const changesPaid = topic.id === "partnerships" && this.topics.has("paid");
    const detail = changesPaid ? "Paid’s partner budget and the Friday report follow the new goal." : "The new target applies to this topic’s plan.";
    const decision: DecisionView = {
      id, title: text, shortTitle: `Change the ${topic.name} goal`, state: "open", topicId: topic.id, topicName: topic.name,
      dueAt: this.nextBrief(3), whyYours: "Yours: changes a goal", minutes: 2, contextLine: topic.name, cardContext: detail,
      doneNote: "Approved. The goal is changed on record.", laneId: null, approveLabel: "Approve",
      provenance: null, context: detail, numbers: [], proof: null, opportunity: null, risk: null, suggestion: null,
      guardrail: null, nextSteps: [], ifNoAnswer: "Nothing changes without your answer.", position: { index: 0, of: 0, open: 0 },
      changeRequest: null, release: null, goalChange: { topicId: topic.id, field: "target", from: goal.target, to, affectedTopics: changesPaid ? ["paid"] : [] },
    };
    this.decisions.set(id, decision);
    message.decisionId = id;
    this.threads.set(`decision:${id}`, {
      id: `decision:${id}`, title: "Chat", sub: topic.name, placeholder: "Ask about the decision", reading: null, since: null,
      pinned: null, agents: null, suggestions: [], messages: [message], scope: null, nextCursor: null,
    });
    return decision;
  }

  private relabel(id: string, kind: LabelKind, viewer: Actor): Effect {
    const containing = [...this.threads.values()].filter(thread => thread.messages.some(item => item.id === id));
    const thread = this.writableThread(requireRecord(containing[0], "message").id, viewer);
    const message = requireRecord(byId(thread.messages, id), "message");
    if (kind === "decision" && !message.decisionId) message.decisionId = thread.pinned?.decisionId ?? null;
    message.label = { kind, corrected: true, pinned: kind === "decision" };
    return done(containing.map(item => ({ type: "thread.changed", threadId: item.id })), null, message);
  }

  private draftsView(): DraftsView {
    const items = this.drafts.items.filter(draft => !draft.laneId || !this.removed.has(draft.laneId));
    return { ...this.drafts, items, count: items.length };
  }

  private models(): ModelsView {
    return {
      items: [
        { id: "auto", name: "Auto", vendor: "Morndo", state: "default" },
        ...this.skills.connections.map(c => ({
          id: c.id, name: c.name, vendor: c.name,
          state: c.state === "signIn" || c.state === "addKey" ? c.state : "connected" as const,
        })),
      ],
    };
  }

  private model(id: string | null | undefined) {
    if (!id) return null;
    const model = byId(this.models().items, id);
    if (!model) throw new Problem("badRequest", "Choose a model from the model picker.");
    if (model.state === "addKey" || model.state === "signIn") throw new Problem("conflict", "Connect this model before using it.");
    return model;
  }

  private runSkill(id: string, text: string, model: string | null | undefined, viewer: Actor): Effect {
    const skill = requireRecord(byId(this.skills.skills, id), "skill");
    if (!skill.enabled) throw new Problem("skillDisabled", "Connect the skill’s provider before running it.");
    const topic = [...this.topics.values()].filter(item => skill.topics.toLowerCase().includes(item.name.toLowerCase()))
      .sort((a, b) => b.name.length - a.name.length)[0];
    const file = this.file(text, viewer, { model: model ?? null, topicId: topic?.id ?? null, route: false });
    if (skill.id === "weekly-summary") {
      const draftId = `draft-${++this.serial}`;
      this.drafts.items.push({
        id: draftId, to: "Team", writtenAt: this.now, skill: skill.name, subject: "Weekly summary",
        body: text, laneId: file.lane.id, openUrl: `https://mail.example.test/mail/u/0/#drafts/${draftId}`,
      });
      this.drafts.count = this.drafts.items.length;
      file.events.push({ type: "drafts.changed" });
    }
    return done(file.events, file.lane.id, file.message, file.receipt);
  }

  private createSkill(description: string, viewer: Actor): Effect {
    this.requireOwner(viewer);
    const base = slug(description.split(/\s+/).slice(0, 4).join(" ")) || "custom-skill";
    const id = byId(this.skills.skills, base) ? `${base}-${++this.serial}` : base;
    this.skills.skills.push({
      id, name: `/${id}`, summary: description, topics: "Workspace", needsKey: null, enabled: true, engine: "Auto", asksFirst: true, builtIn: false,
    });
    return done([{ type: "skills.changed" }]);
  }

  private connect(id: string, viewer: Actor): Effect {
    this.requireOwner(viewer);
    const connection = requireRecord(byId(this.skills.connections, id), "connection");
    if (connection.state === "connected" || connection.state === "signedIn") return done();
    connection.state = connection.state === "signIn" ? "signedIn" : "connected";
    this.skills.connected = this.skills.connections.filter(item => item.state === "connected" || item.state === "signedIn").length;
    for (const skill of this.skills.skills) {
      if (skill.needsKey && [connection.id, slug(connection.name)].includes(slug(skill.needsKey))) skill.enabled = true;
    }
    this.usage.missing = this.usage.missing.filter(name => slug(name) !== id);
    return done([{ type: "skills.changed" }, { type: "usage.changed" }]);
  }

  private guardrail(name: string, on: boolean, viewer: Actor): Effect {
    this.requireOwner(viewer);
    const guardrail = requireRecord(this.skills.guardrails.find(item => item.name === name), "guardrail");
    if (guardrail.on === on) return done();
    guardrail.on = on;
    const breached = [...this.topics.values()].flatMap(topic => topic.goal?.guardrails?.items
      .filter(item => item.what === name && item.state === "breached")
      .map(() => ({ type: "guardrail.breached", topicId: topic.id, name } as const)) ?? []);
    return done([{ type: "skills.changed" }, ...(on ? breached : [])]);
  }

  private hold(id: string, viewer: Actor): Effect {
    this.requireOwner(viewer);
    const pull = requireRecord(byId(this.pulls.items, id), "pull request");
    if (pull.state === "released") throw new Problem("conflict", "The pull request is already released.");
    if (pull.held) return done();
    const prev = pull.state;
    const release = pull.decisionId ? this.decisions.get(pull.decisionId)?.release : null;
    const priorStage = release?.stage;
    let heldAt = Date.parse(this.now);
    const lane = pull.laneId ? this.lane(pull.laneId) : undefined;
    const apply = (undone: boolean): Event[] => {
      pull.held = !undone;
      pull.state = undone ? prev : "held";
      const events: Event[] = [{ type: "pull.changed", pullId: id }];
      if (release && priorStage && pull.decisionId) {
        if (undone && release.startedAt) {
          const resumption = Date.parse(release.startedAt) + Date.parse(this.now) - heldAt;
          release.startedAt = new Date(resumption).toISOString();
        }
        if (!undone) heldAt = Date.parse(this.now);
        release.stage = undone ? priorStage : "held";
        events.push({ type: "release.changed", decisionId: pull.decisionId });
      }
      if (lane) events.push(...laneUpdate(lane.id, lane.topicId));
      return events;
    };
    this.remember(lane?.topicId ?? pull.projectId, `pull-${id}`, `Held pull request ${pull.number}.`, viewer, apply, pull.laneId);
    return done(apply(false));
  }

  advance(at: string): Event[] {
    const now = Date.parse(at);
    if (now <= Date.parse(this.now)) return [];
    const nextBrief = this.nextBrief(this.prefsOf(this.owner).briefsPerDay);
    this.now = at;
    const events: Event[] = [];
    if (Date.parse(nextBrief) <= now) {
      this.briefBase.at = nextBrief;
      events.push({ type: "brief.published" });
      for (const topic of this.topics.values()) {
        for (const guardrail of topic.goal?.guardrails?.items ?? []) {
          if (guardrail.state === "breached") events.push(
            { type: "guardrail.breached", topicId: topic.id, name: guardrail.what },
            { type: "attention.raised", target: target("topic", topic.id), reason: `${guardrail.what} breached its guardrail.` },
          );
        }
      }
    }
    if (this.resetUsage(now)) events.push({ type: "usage.changed" });
    for (const decision of this.decisions.values()) {
      if (decision.state === "open" && Date.parse(decision.dueAt) <= now) {
        decision.state = "expired";
        events.push({ type: "decision.expired", decisionId: decision.id }, ...this.decisionEvents(decision));
      }
      const release = decision.release;
      if (release?.startedAt && (release.stage === "rolling" || release.stage === "watching")) {
        const elapsed = now - Date.parse(release.startedAt);
        const stage = elapsed >= release.watchMinutes * 60000 ? "done" : elapsed >= 60000 ? "watching" : "rolling";
        if (stage === release.stage) continue;
        release.stage = stage;
        events.push({ type: "release.changed", decisionId: decision.id });
        const pull = byId(this.pulls.items, release.pullId);
        if (stage === "done" && pull && !pull.held) {
          release.percent = 100;
          pull.state = "released";
          events.push({ type: "pull.changed", pullId: pull.id });
        }
      }
    }
    for (const pull of this.pulls.items) {
      if (pull.state !== "autoMerge" || pull.held || !pull.autoMergeAt || Date.parse(pull.autoMergeAt) > now) continue;
      pull.state = "released";
      events.push({ type: "pull.changed", pullId: pull.id });
    }
    return events;
  }

  private resetUsage(now: number): boolean {
    let changed = false;
    for (const account of [...this.usage.subscriptions, ...this.usage.keys]) {
      let reset = false;
      for (const meter of account.meters) {
        if (meter.resetsAt === null || Date.parse(meter.resetsAt) > now) continue;
        meter.used = 0;
        if (meter.spend) meter.spend.amountMinor = 0;
        meter.resetsAt = null;
        reset = true;
      }
      if (!reset) continue;
      changed = true;
      const highest = Math.max(...account.meters.map(meter => meter.used));
      if (account.state !== "standingBy") account.state = highest >= 1 ? "limit" : highest >= 0.8 ? "near" : "ok";
    }
    if (changed) this.usage.at = this.now;
    return changed;
  }

  readers(event: Event): Set<string> {
    return new Set([...this.people.values()].filter(viewer => this.visibleEvent(event, viewer)).map(viewer => viewer.id));
  }

  visibleEvent(event: Event, viewer: Actor): boolean {
    if (viewer.id === this.owner.id) return true;
    if ("threadId" in event) {
      if (!this.canReadThread(event.threadId, viewer)) return false;
      const topicId = this.threadTopic(event.threadId);
      if (event.type === "message.posted" && topicId && !this.fullTopic(topicId, viewer) && threadScope(event.threadId)?.kind === "topic") {
        const lane = event.message.threadCard && this.lanes.get(event.message.threadCard.laneId);
        return Boolean(lane && this.sharedLane(lane, viewer));
      }
      return true;
    }
    if ("laneId" in event) {
      const lane = this.lanes.get(event.laneId);
      return Boolean(lane && this.sharedLane(lane, viewer));
    }
    if ("decisionId" in event) {
      const decision = this.decisions.get(event.decisionId);
      return Boolean(decision && this.fullTopic(decision.topicId, viewer));
    }
    if (event.type === "attention.raised") {
      if (event.target.kind === "topic") return this.fullTopic(event.target.id ?? "", viewer);
      if (event.target.kind === "decision") {
        const decision = this.decisions.get(event.target.id ?? "");
        return Boolean(decision && this.fullTopic(decision.topicId, viewer));
      }
    }
    if ("topicId" in event) return event.topicId !== null && this.role(event.topicId, viewer) !== "none";
    return event.type === "brief.published" || event.type === "feed.reset" || event.type === "skills.changed";
  }
}

function applyTheme(theme: Theme, patch: ThemePatch): void {
  if (patch.id) {
    theme.id = patch.id;
    theme.name = patch.id.charAt(0).toUpperCase() + patch.id.slice(1);
    if (patch.strength == null) theme.strength = patch.id === "ink" ? 0 : 55;
  }
  if (patch.strength != null) theme.strength = patch.strength;
  if (patch.glass !== undefined) theme.glass = patch.glass;
  theme.effectiveGlass = theme.glass ?? (theme.id === "ink" ? 25 : 50);
}
