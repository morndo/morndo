import { readerCopy } from "./viewer-copy.ts";
import { createHash } from "node:crypto";
import { loadFixtures } from "@morndo/cockpit-api";
import type {
  AccessView, Actor, ApiError, Ask, Attachment, BriefView, Command, CommandResult, DailyLimit,
  DecisionQueueView, DecisionView, DraftsView, Event, HistoryEntry, HistoryPage, LabelKind, LaneAct,
  LaneView, MadeRecordView, ManagerView, Message, MessageAudience, ModelId, ModelsView, OvernightAction, PullsView, Receipt,
  RecentView, SearchView, SettingsView, SidebarView, SkillsView, Target, Theme, ThemePatch, ThreadView,
  TopicView, UsageView, WorkspaceView,
} from "@morndo/cockpit-api";
import { artwork } from "./artwork.ts";
import { done, type Effect, type Outcome } from "./model.ts";
import { beforeOvernight, overnightHistory } from "./overnight.ts";
import { BASE, definitionFor, matchRoute, missing, page, Problem, threadScope } from "./protocol.ts";
import { DEV_ROUTES, GTM_ROUTES, leadFor } from "./routes.ts";
import { answerTo, isQuestion, routePreview, searchResults } from "./search.ts";

export type Module = "gtm" | "dev";
export const DEMO_AT = "2026-11-16T08:45:00+01:00";
const DAY = "2026-11-16";
const hour = (time: string) => `${DAY}T${time}:00+01:00`;
const byId = <T extends { id: string }>(items: readonly T[], id: string) => items.find(item => item.id === id);
const target = (kind: Target["kind"], id: string | null = null): Target => ({ kind, id });
const RANK: Record<LaneView["state"], number> = { bad: 4, warn: 3, new: 2, ok: 1, parked: 0, next: 0, idle: 0, done: -1 };
const WORDS: Record<LaneView["state"], string> = {
  bad: "Stuck", warn: "Needs you", ok: "Working", done: "Done", new: "Starting",
  idle: "Idle", next: "Up next", parked: "Parked",
};


const WEBINAR_SETTLEMENTS = {
  "post-passing": {
    history: "posted the promo with the 4 images that pass; 3 and 6 stay out",
    status: "The promo goes out at 16:00 with the 4 images that pass. Images 3 and 6 stay out.",
    step: "4 images pass the brand check; 2 left out",
    receipt: "The promo goes out at 16:00 with 4 images",
  },
  "one-more-round": {
    history: "allowed one more image round, €0.60",
    status: "Visuals runs round 4: the photo behind the logo gets darker. You see the 6 images at 09:30; the post still goes out at 16:00.",
    step: "Round 4 of the images, allowed by you",
    receipt: "Visuals runs one more round, €0.60",
  },
} as const;

type HistoryRow = Extract<HistoryEntry, { kind: "event" }>;
type TopicRole = TopicView["viewer"]["role"] | "none";
type HistoryAction = {
  row: HistoryRow;
  topicId: string | null;
  record: string;
  apply: (undone: boolean) => Event[];
  authorize: (viewer: Actor) => void;
};
type FileOptions = {
  topicId?: string | null;
  leadId?: string | null;
  attachment?: Attachment | null;
  model?: ModelId | null;
  fromChat?: boolean;
  route?: boolean;
  authorize?: HistoryAction["authorize"];
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
  private readonly modelPicker: ModelsView;
  private readonly recent = new Map<string, RecentView["items"]>();
  private readonly settlements = new Map<string, BriefView["settledBurns"][number]>();
  private readonly alerted = new Set<string>();
  private readonly personalDrafts = new Map<string, DraftsView>();
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
    this.modelPicker = take("models.json");
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
    for (const thread of this.threads.values()) {
      if (!thread.id.startsWith("topic:")) continue;
      for (const message of thread.messages) {
        const decisionThread = message.decisionId && this.threads.get(`decision:${message.decisionId}`);
        if (decisionThread && !byId(decisionThread.messages, message.id)) decisionThread.messages.push(message);
      }
    }
    const partnerships = this.threads.get("topic:partnerships");
    if (partnerships && this.people.has("tom-ahrens")) {
      const note = this.message(this.owner, "Tom, this is where Partnerships stands, live. The weekly report still comes on Friday.", null,
        { kind: "viewer", personId: "tom-ahrens" });
      note.at = "2026-11-16T08:00:00+01:00";
      partnerships.messages.push(note);
      partnerships.messages.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
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
      this.rememberOvernight(row);
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
      case "DraftsView": return this.draftsView(viewer);
      case "SkillsView": this.requireOwner(viewer); return this.skills;
      case "SettingsView": return { ...this.settings, decisionRights: viewer.id === this.owner.id ? this.settings.decisionRights : [],
        ...this.prefsOf(viewer, query.get("deviceId")) };
      case "PullsView": this.requireOwner(viewer); return this.pullsView();
      case "ModelsView": return viewer.id === this.owner.id ? this.modelPicker : {
        items: this.modelPicker.items.map(({ id, name }) => ({ id, name, vendor: null, state: null })),
      };
      case "RecentView": return { items: (this.recent.get(viewer.id) ?? []).filter(item => this.recentTitle(item.target, viewer)) } satisfies RecentView;
      case "MadeRecordView": return requireRecord(this.madeRecord(key, viewer), "record");
      // Contract 1.1.0 routes: the records and the member list arrive with the stand-in's 1.1.0 behaviour.
      case "ReportView": throw missing("report");
      case "CheckView": throw missing("check");
      case "MembersView": this.requireOwner(viewer); return { items: [], invitations: [] };
      case "ThreadView": return this.threadView(key, viewer, query);
      case "SearchView": return this.search(query, viewer);
      case "RoutePreview": {
        const text = query.get("text") ?? "";
        this.checkText(text);
        const topics = new Map([...this.topics].filter(([id]) => this.fullTopic(id, viewer)));
        const topic = query.get("topic");
        if (topic && topic !== "manager" && !topics.has(topic.replace(/^[ap]-/, ""))) throw missing("topic");
        return routePreview(text, query.get("topic"), topics, this.routes);
      }
      default: throw missing("route");
    }
  }

  act(command: Command, viewer: Actor = this.owner): Effect {
    if (viewer.membershipState === "invited" && command.type !== "access.accept") {
      throw new Problem("forbidden", "Accept the invitation before changing shared work.");
    }
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
      case "decisionRight.set": return this.decisionRight(command.rule, command.who, command.dailyLimit, command.personId ?? null, viewer);
      case "recent.visit": return this.visitPage(command.target, viewer);
      case "skill.run": return this.runSkill(command.skill, command.text, command.model, command.topicId ?? null, viewer);
      case "skill.create": return this.createSkill(command.description, viewer);
      case "access.set": return this.setAccess(command.topicId, command.personId, command.access.kind, command.access.stages ?? [], viewer);
      case "access.invite": return this.invite(command.topicId, command.nameOrEmail, viewer);
      case "access.revoke": return this.revoke(command.invitationId, viewer);
      case "access.accept": return this.acceptInvitation(command.invitationId, viewer);
      case "access.statusLink": return this.statusLink(command.topicId, command.enabled ?? true, viewer);
      case "stage.assign": return this.assign(command.topicId, command.stage, command.personId, viewer);
      case "topic.seen": return this.visit(command.topicId, viewer);
      case "guardrail.set": return this.guardrail(command.name, command.on, viewer);
      case "pull.hold": return this.hold(command.pullId, viewer);
      case "pull.unhold": return this.unhold(command.pullId, viewer);
      case "connection.connect": return this.connect(command.connectionId, viewer);
      case "module.switch": this.requireOwner(viewer); return done([{ type: "module.changed", moduleId: command.moduleId }]);
      case "handover.confirm": return this.confirm(command.laneId, viewer);
    }
  }

  authorizeReplay(command: Command, result: CommandResult, viewer: Actor): void {
    if (viewer.id === this.owner.id) return;
    const forbid = () => new Problem("forbidden", "This reader no longer has access to the original command.");
    if (viewer.membershipState === "invited") throw forbid();
    if ("decisionId" in command) {
      this.requireDecisionRight(requireRecord(this.decisions.get(command.decisionId), "decision"), viewer);
    } else if ("actionId" in command) {
      requireRecord(this.history.get(this.overnightAliases.get(command.actionId) ?? command.actionId), "action").authorize(viewer);
    } else if ("laneId" in command) {
      const lane = requireRecord(this.lanes.get(command.laneId), "lane");
      if (!lane.topicId || !this.sharedLane(lane, viewer)) throw forbid();
      if (command.type === "lane.act" && lane.decisionId && (command.act === "approve" || command.act === "undo")) {
        this.requireDecisionRight(requireRecord(this.decisions.get(lane.decisionId), "decision"), viewer);
      }
      if (command.type === "lane.move") {
        this.writableTopic(command.topicId, viewer);
        for (const event of result.events) {
          if (event.type === "topic.changed" && event.topicId !== command.topicId) this.writableTopic(event.topicId, viewer);
        }
      }
      if (command.type === "lane.undoFile") {
        requireRecord(this.history.get(`file-${command.laneId}`), "action").authorize(viewer);
      }
    } else if (command.type === "message.send") {
      if (!this.canReadThread(command.threadId, viewer)) throw forbid();
      const topicId = this.threadTopic(command.threadId);
      if (topicId && result.message && !this.seesAudience(topicId, result.message.audience, viewer, command.threadId)) throw forbid();
    } else if (command.type === "since.edit") {
      this.writableThread(command.threadId, viewer);
    } else if (command.type === "message.relabel") {
      const thread = [...this.threads.values()].find(item => byId(item.messages, command.messageId));
      this.writableMessage(requireRecord(thread, "thread").id, command.messageId, viewer);
    } else if (command.type === "skill.run" || command.type === "lane.file" || command.type === "goal.ask") {
      const topicId = result.receipt?.filedUnder?.id;
      if (!topicId || !this.fullTopic(topicId, viewer)) throw forbid();
      if (command.type === "skill.run") this.requireSkillRight(requireRecord(byId(this.skills.skills, command.skill), "skill"), topicId, viewer);
    } else if (command.type === "topic.seen") {
      if (this.role(command.topicId, viewer) === "none") throw forbid();
    } else if (command.type === "recent.visit") {
      if (!this.recentTitle(command.target, viewer)) throw forbid();
    } else if (command.type === "access.accept") {
      const invitation = [...this.access.values()].flatMap(view => view.invitations).find(item => item.id === command.invitationId);
      if (invitation?.personId !== viewer.id) throw forbid();
    } else if (command.type !== "prefs.set") {
      throw forbid();
    }
    if (result.events.some(event => !this.visibleEvent(event, viewer))) throw forbid();
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
    return viewer.membershipState === "invited" && kind && kind !== "none" ? "view" : kind ?? "none";
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

  private laneStage(lane: LaneView): string | undefined {
    const topic = this.topics.get(lane.topicId ?? "");
    return topic?.plan?.stages.find(stage => stage.rows.some(row => row.laneId === lane.id))?.name;
  }

  private sharedLane(lane: LaneView, viewer: Actor): boolean {
    if (!lane.topicId) return viewer.id === this.owner.id;
    if (this.fullTopic(lane.topicId, viewer)) return true;
    const entry = this.accessEntry(lane.topicId, viewer);
    const stage = this.laneStage(lane);
    return Boolean(entry?.access.kind === "stages" && stage && entry.access.stages?.includes(stage));
  }

  private hasDecisionRight(decision: DecisionView, viewer: Actor): boolean {
    if (viewer.id === this.owner.id) return true;
    return this.fullTopic(decision.topicId, viewer) &&
      this.settings.decisionRights.some(right => right.rule === decision.rule && right.who === "agent" && right.personId === viewer.id);
  }

  private requireDecisionRight(decision: DecisionView, viewer: Actor): void {
    if (!this.hasDecisionRight(decision, viewer)) {
      throw new Problem("forbidden", "This decision belongs to the owner or the person named by its decision right.");
    }
  }

  private projectLane(lane: LaneView, viewer: Actor): LaneView {
    const decision = lane.decisionId ? this.decisions.get(lane.decisionId) : undefined;
    if (viewer.id !== this.owner.id) this.shareLaneCopy(lane);
    if (decision && (decision.state === "approved" || decision.state === "declined")) {
      const actor = this.history.get(`decision-${decision.id}`)?.row.actor ?? this.owner;
      const verb = decision.state === "approved" ? "approved" : "declined";
      lane.standing.headline = `${actor.id === viewer.id ? "You" : actor.shortName} ${verb} it.`;
    }
    if (viewer.id === this.owner.id) return lane;
    if (decision && !this.hasDecisionRight(decision, viewer)) {
      lane.decisionId = null;
      lane.approveLabel = null;
      lane.yours = null;
      lane.acts = lane.acts.filter(action => action.id !== "undo" && action.id !== "approve" && action.target?.kind !== "decision");
      if (decision.state === "open") {
        lane.waitsFor = this.owner;
        lane.stateWord = `Waits for ${this.owner.shortName}`;
        lane.standing = { headline: `It waits for ${this.owner.shortName}.`, detail: `${this.owner.shortName} has the decision.` };
      }
    }
    if (lane.waitsFor?.id === viewer.id) {
      lane.stateWord = "Waits for you";
      lane.standing.headline = "It waits for you.";
      lane.acts = lane.acts.filter(action => action.personId !== viewer.id);
      if (lane.id === "outreach-wave-2") {
        lane.short = "Wave 2: 24 emails";
        lane.ask = "check them before they go out · by 11:00";
        lane.acts.push({ id: "send-wave-2", label: "Send wave 2", tone: "ink", personId: viewer.id, target: null });
      }
    }
    return lane;
  }

  private shareLaneCopy(lane: LaneView): void {
    const copy = (text: string) => readerCopy(text, this.owner.shortName);
    lane.stateWord = copy(lane.stateWord);
    lane.status = copy(lane.status);
    lane.standing = { headline: copy(lane.standing.headline), detail: copy(lane.standing.detail) };
    lane.next = readerCopy(lane.next, this.owner.shortName);
    lane.afterNext = readerCopy(lane.afterNext, this.owner.shortName);
    lane.yours = readerCopy(lane.yours, this.owner.shortName);
    lane.after = readerCopy(lane.after, this.owner.shortName);
    lane.doneNote = copy(lane.doneNote);
    if (lane.handover) lane.handover.ifSo = copy(lane.handover.ifSo);
    lane.checks = lane.checks.map(copy);
    lane.steps = lane.steps.map(step => ({ ...step, who: copy(step.who), text: copy(step.text) }));
    lane.made = lane.made.map(item => ({ ...item, detail: copy(item.detail) }));
    lane.lead = this.shareActorCopy(lane.lead);
    lane.crew = lane.crew.map(actor => this.shareActorCopy(actor));
    lane.askedMeta.source = copy(lane.askedMeta.source);
    lane.askedMeta.note = readerCopy(lane.askedMeta.note, this.owner.shortName);
  }

  private shareActorCopy(actor: Actor): Actor {
    const owner = this.owner.shortName;
    return { ...actor, text: readerCopy(actor.text, owner), word: readerCopy(actor.word, owner), record: readerCopy(actor.record, owner) };
  }

  private lane(id: string): LaneView | undefined {
    const stored = this.lanes.get(id);
    if (!stored || this.removed.has(id)) return undefined;
    const lane = structuredClone(stored);
    if (this.briefBase.overnight.some(row => this.history.get(row.id)?.row.undone &&
      (row.laneId === id || row.relatedLaneIds?.includes(id)))) {
      Object.assign(lane, beforeOvernight(lane));
      lane.standing = { headline: "Overnight action undone.", detail: lane.status };
    }
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
      lane.acts = decision.state === "expired" || decision.release?.stage === "done" ? [] : [{ id: "undo", label: "Undo", tone: "quiet", target: null, personId: null }];
      if (decision.state === "approved" && !held) {
        const release = decision.release;
        lane.yours = null;
        lane.waitsFor = null;
        lane.state = release?.stage === "done" ? "done" : "ok";
        lane.stateWord = release?.stage === "scheduled" ? "Scheduled" : WORDS[lane.state];
        if (release) {
          const done = release.stage === "done";
          const scheduled = release.stage === "scheduled";
          const phrase = done ? "The rollout is complete." : scheduled
            ? "The rollout is approved and scheduled." : "The release is rolling out and export failures are being watched.";
          lane.next = done ? "Report the rollout result" : scheduled ? "Rollout is scheduled" : "Watch export failures during rollout";
          lane.nextAt = scheduled ? release.scheduledAt : release.startedAt && !done
            ? new Date(Date.parse(release.startedAt) + release.watchMinutes * 60000).toISOString() : null;
          lane.status = phrase;
          lane.standing = { headline: "You approved it.", detail: phrase };
          lane.lead = { ...lane.lead, state: lane.state, word: lane.stateWord, text: phrase };
          lane.crew = lane.crew.map(member => member.id === lane.lead.id ? lane.lead : member);
          lane.steps = lane.steps.map(step => step.text === "Released to production" ? {
            ...step, kind: done ? "ok" : scheduled ? "todo" : "now",
            who: done ? "Release · complete" : scheduled ? "Release · scheduled" : "Release · watching",
          } : step);
          lane.made = lane.made.map(item => item.target?.kind === "decision"
            ? { ...item, detail: `${decision.shortTitle} · approved` }
            : item.target?.kind === "pull" ? { ...item, detail: done ? "Released" : scheduled ? "Rollout scheduled" : "Rollout in progress" } : item);
        } else {
          lane.next = lane.afterNext ?? lane.next;
          lane.nextAt = lane.afterNextAt ?? lane.nextAt;
          lane.status = lane.after ?? decision.doneNote;
          lane.standing = { headline: "You approved it.", detail: lane.status };
          let promoted = false;
          lane.steps = lane.steps.map(step => {
            if (step.kind === "now") return { ...step, kind: "ok" };
            if (step.kind === "todo" && !promoted) {
              promoted = true;
              return { ...step, kind: "now" };
            }
            return step;
          });
        }
      } else {
        const headline = held ? "The pull request is held." : decision.state === "declined" ? "You declined it." : "The decision expired.";
        if (!held) {
          lane.state = "parked";
          lane.stateWord = decision.state === "declined" ? "Declined" : "Expired";
          lane.yours = null;
          lane.waitsFor = null;
          lane.next = null;
          lane.nextAt = null;
          lane.approveLabel = null;
          lane.steps = lane.steps.map(step => step.kind === "now" ? { ...step, kind: "todo" } : step);
        }
        lane.status = decision.ifNoAnswer ?? headline;
        lane.standing = { headline, detail: lane.status };
      }
    }
    return lane;
  }

  private visibleLane(id: string, viewer: Actor): LaneView {
    const lane = requireRecord(this.lane(id), "lane");
    if (!this.sharedLane(lane, viewer)) throw new Problem("forbidden", "That lane is outside this reader’s access.");
    return this.projectLane(lane, viewer);
  }

  private allLanes(viewer: Actor): LaneView[] {
    return [...this.lanes.keys()].flatMap(id => {
      const lane = this.lane(id);
      return lane && this.sharedLane(lane, viewer) ? [this.projectLane(lane, viewer)] : [];
    });
  }

  private sidebar(viewer: Actor): SidebarView {
    const lanes = this.allLanes(viewer).filter(lane => lane.state !== "done").sort(sortLanes);
    const pinIds = this.pinsOf(viewer);
    const open = this.queue(viewer).open;
    const pinnable = (viewer.id === this.owner.id ? this.sidebarBase.pinnable : []).map(pin => ({
      ...pin, pinned: pinIds.includes(pin.id), badge: pin.id === "t-decide" ? open > 0 : pin.badge,
      badgeCount: pin.id === "t-decide" ? open : null,
    }));
    const summarize = (lane: LaneView) => ({
      id: lane.id, title: lane.title, state: lane.state, stateWord: lane.stateWord, leadName: labelFor(lane, viewer), fresh: lane.fresh,
    });
    const groups = this.sidebarBase.groups.filter(group => this.role(group.id, viewer) !== "none").map(group => {
      const topic = this.topics.get(group.id);
      const inGroup = lanes.filter(lane => lane.topicId === group.id);
      const health = this.topicView(group.id, viewer, new URLSearchParams()).health;
      const worst = health?.state ?? inGroup[0]?.state;
      const mark = worst && ["bad", "warn", "new", "ok"].includes(worst) ? worst === "new" ? "ok" : worst : null;
      return { ...group, open: topic?.open ?? group.open, stateWord: health?.word ?? (worst ? WORDS[worst] : "Idle"), mark, lanes: inGroup.map(summarize) };
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
      id: d.id, title: d.title, state: d.state, topicName: d.topicName, target: target("decision", d.id), goalChange: d.goalChange, proposer: d.proposer,
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
      context: d.cardContext, minutes: d.minutes, doneNote: d.doneNote, laneId: d.laneId, state: d.state, rule: d.rule, proposer: d.proposer,
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
      .map(item => ({ ...item, undone: this.history.get(item.id)?.row.undone ?? false }));
    view.topics = view.topics.filter(topic => this.fullTopic(topic.id, viewer)).map(item => {
      const topic = this.topicView(item.id, viewer, new URLSearchParams());
      const original = this.topics.get(item.id)?.goal;
      const progress = topic.goal && original && topic.goal.target !== original.target
        ? `${topic.goal.signed} of ${topic.goal.target} ${topic.goal.unit}` : item.progress;
      return { ...item, progress, verdict: topic.goal?.verdict.word ?? topic.health?.word ?? item.verdict,
        state: topic.goal?.verdict.state ?? topic.health?.state ?? item.state };
    });
    view.settledBurns = [...this.settlements.values()].filter(item => {
      const lane = this.lane(item.laneId);
      return lane && this.sharedLane(lane, viewer) && viewer.id === this.owner.id;
    });
    if (view.settledBurns.length && view.burns.length === 0) view.burnsSub = "Nothing else is stuck.";
    const key = (["no", "one", "two", "three", "four"] as const)[view.openCount] ?? String(view.openCount);
    const burns = view.burns.length === 0 ? "" : view.burns.length === 1
      ? this.module === "dev" ? " and main is red in the web app" : " and one thing is stuck" : ` and ${view.burns.length} things are stuck`;
    const decisions = `${key[0]?.toUpperCase() ?? ""}${key.slice(1)} ${view.openCount === 1 ? "decision needs" : "decisions need"} you`;
    view.lede = `${decisions}${burns}. ${this.module === "dev" ? "Everything else was built, reviewed and shipped while you slept." : "Everything else moved on its own while you slept."}`;
    view.nextBriefAt = this.nextBrief(prefs.briefsPerDay);
    view.cadence = prefs.interruptOnlyUrgent ? "Until then you hear only about what cannot wait." : "Until then you hear about changes as they happen.";
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
      view.sharedTopics = [...this.topics.keys()].flatMap(id => {
        if (this.role(id, viewer) === "none") return [];
        const view = this.topicView(id, viewer, new URLSearchParams());
        return view.status ? [view.status] : [];
      });
      view.topics = [];
      if (!view.burns.length) view.burnsSub = null;
      view.decisions = [];
      view.openCount = 0;
      view.minutes = 0;
      view.overnight = [];
      view.spend = null;
      view.drafts = { count: 0, text: "", detail: "" };
      view.inWorks = null;
      view.lede = "Your brief covers the work shared with you.";
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
        leadName: labelFor(lane, viewer), state: lane.state, stateWord: lane.stateWord, next: lane.next ?? "", nextAt: lane.nextAt,
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
    view.seenBy = (this.access.get(id)?.people ?? []).filter(entry => entry.access.kind !== "none")
      .map(entry => {
        const pending = entry.person.membershipState === "invited";
        return { id: entry.person.id, name: entry.person.name, avatar: entry.person.avatar,
          access: pending || entry.access.kind === "view" ? "view" : "work", pending };
      });
    view.stages = view.stages.map(stage => {
      const access = this.fullTopic(id, viewer) || stages.includes(stage.name)
        ? "work" : role === "view" ? "view" : "locked";
      return { ...stage, access, runBy: access === "work" ? stage.runBy : null };
    });
    const lanes = this.allLanes(viewer).filter(lane => lane.topicId === id).sort(sortLanes);
    view.lanes = lanes.map(lane => ({
      id: lane.id, title: lane.title, state: lane.state, stateWord: lane.stateWord,
      leadName: labelFor(lane, viewer), next: lane.next ?? "", nextAt: lane.state === "done" ? lane.closedAt : lane.nextAt,
    }));
    const approved = (decisionId: string) => this.decisions.get(decisionId)?.state === "approved";
    const settled = stored.stuck && stored.stuck.actions.length > 0 && !lanes.some(lane => lane.id === stored.stuck?.actions[0]?.laneId && lane.state === "bad");
    if (settled) {
      view.stuck = null;
      if (view.health?.state === "bad") view.health = { state: "ok", word: "Working again" };
    }
    view.jobs = view.jobs.filter(job => !job.laneId || !this.removed.has(job.laneId)).map(job => {
      const lane = job.laneId ? byId(lanes, job.laneId) : undefined;
      return lane ? { ...job, state: lane.state } : job;
    });
    view.tasks = view.tasks.filter(task => !task.laneId || !this.removed.has(task.laneId)).map(task => {
      const lane = task.laneId ? byId(lanes, task.laneId) : undefined;
      return lane ? { ...task, state: lane.state, stateWord: lane.stateWord, next: lane.next ?? task.next, nextAt: lane.nextAt ?? task.nextAt } : task;
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
    const changes = [...this.decisions.values()].flatMap(item => {
      const change = item.goalChange;
      return item.state === "approved" && change && (change.topicId === id || change.affectedTopics.includes(id)) ? [change] : [];
    });
    view.appliedGoalChanges = [];
    if (this.fullTopic(id, viewer)) {
      view.appliedGoalChanges = changes.filter(change => change.topicId === id || this.fullTopic(change.topicId, viewer));
    }
    if (view.goal) {
      const goal = view.goal;
      for (const change of changes) {
        if (change.topicId === id) this.projectGoalChange(goal, change);
      }
      const decision = goal.decision?.decisionId && this.decisions.get(goal.decision.decisionId);
      if (goal.decision && decision && decision.state === "approved") {
        goal.decision.title = goal.decision.done ?? goal.decision.title;
        const lane = goal.decision.laneId && this.lane(goal.decision.laneId);
        if (lane && lane.shortAfter) goal.decision.detail = lane.shortAfter;
      }
      if (decision && (decision.state === "declined" || decision.state === "expired")) goal.decision = null;
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
        if (this.settlements.has("webinar") && id === "content") {
          goal.decision = null;
          goal.calm = "The promo is settled";
          goal.verdict = { ...goal.verdict, state: "warn", word: "Behind plan", action: "Reminder Wednesday", text: null };
        }
      }
      if (goal.guardrails && view.spend && view.spend.cap.amountMinor > 0) {
        const ratio = view.spend.spent.amountMinor / view.spend.cap.amountMinor;
        if (id !== "partnerships") goal.guardrails.items.push({
          what: "Agents this week",
          value: { kind: "money", money: view.spend.spent, cap: null },
          limit: { kind: "money", money: view.spend.cap, cap: null },
          ratio,
          state: ratio >= 1 ? "breached" : ratio >= 0.8 ? "near" : "held",
          id: null, switchId: null, action: null,
        });
      }
    }
    const goal = view.goal;
    const liveLanes = this.module === "dev" ? this.allLanes(this.owner).filter(lane => lane.topicId === id).sort(sortLanes) : [];
    if (goal) {
      view.health = { state: goal.verdict.state, word: goal.verdict.word };
    } else if (this.module === "dev" && [...this.decisions.values()].some(decision => decision.topicId === id && decision.state !== "open")) {
      const worst = liveLanes.find(lane => lane.state !== "done" && lane.state !== "parked");
      view.health = { state: worst?.state === "bad" ? "bad" : worst?.state === "warn" ? "warn" : worst ? "ok" : "idle",
        word: worst ? WORDS[worst.state] : "Idle" };
    }
    const relatedDeadline = changes.findLast(change => change.topicId !== id && change.deadlineAt)?.deadlineAt;
    const nextReportAt = relatedDeadline ?? view.meta?.nextReportAt ?? null;
    if (view.meta) view.meta.nextReportAt = nextReportAt;
    view.status = { topicId: id, name: view.name, signed: goal?.signed ?? null, goal: goal?.target ?? null,
      unit: goal?.unit ?? null, health: view.health, nextReportAt, nextReportId: null };
    if (viewer.id !== this.owner.id) {
      const dash = role === "all" ? "You work on all of it" : role === "stages" ? `You run ${stages.join(", ")}` : "You see the status";
      view.meta = { askedBy: null, ownerLine: null, nextReportAt, nextReportId: null, priority: null, parts: [`Shared by ${this.owner.name}`, dash] };
    }
    if (role === "view" || role === "stages") {
      const team = new Set(lanes.flatMap(lane => [lane.lead.id, ...lane.crew.map(actor => actor.id)]));
      const workers = new Set((view.plan?.stages ?? []).filter(stage => stages.includes(stage.name)).flatMap(stage => stage.rows.map(row => row.who)));
      view.goal = null;
      view.spend = null;
      view.crew = role === "view" ? [] : view.crew.filter(actor =>
        actor.id === viewer.id || actor.id === this.owner.id || team.has(actor.id) || workers.has(actor.name) || workers.has(actor.shortName));
      view.jobs = view.jobs.filter(job => job.laneId && byId(lanes, job.laneId));
      view.tasks = view.tasks.filter(task => task.laneId && byId(lanes, task.laneId));
      view.facts = [];
      view.stuck = null;
      view.focusLaneId = lanes.find(lane => lane.waitsFor?.id === viewer.id)?.id ?? null;
      view.noGoal = null;
      view.intro = "";
      view.chatSub = role === "view" ? `You and ${this.owner.shortName}.` : `${stages.join(", ")} chat`;
    }
    if (viewer.id !== this.owner.id) {
      const owner = this.owner.shortName;
      view.intro = readerCopy(view.intro, owner);
      view.crew = view.crew.map(actor => this.shareActorCopy(actor));
      if (view.goal) {
        view.goal.calm = readerCopy(view.goal.calm, owner);
        view.goal.calmSub = readerCopy(view.goal.calmSub, owner);
        view.goal.routine = readerCopy(view.goal.routine, owner);
        view.goal.verdict.action = readerCopy(view.goal.verdict.action, owner);
        if (view.goal.gap) view.goal.gap.steps = view.goal.gap.steps.map(step => readerCopy(step, owner));
        for (const deal of view.goal.deals) {
          deal.stage = readerCopy(deal.stage, owner);
          deal.short = readerCopy(deal.short, owner);
          deal.evidence = readerCopy(deal.evidence, owner);
          deal.next = readerCopy(deal.next, owner);
          deal.alt = null;
        }
        for (const guardrail of view.goal.guardrails?.items ?? []) {
          guardrail.what = readerCopy(guardrail.what, owner);
          if (guardrail.limit.kind === "policy") guardrail.limit.text = readerCopy(guardrail.limit.text, owner);
        }
        const decision = this.decisions.get(view.goal.decision?.decisionId ?? "");
        if (view.goal.decision && decision && !this.hasDecisionRight(decision, viewer)) {
          view.goal.decision.approveLabel = null;
        }
      }
      for (const stage of view.plan?.stages ?? []) {
        stage.summary = readerCopy(stage.summary, owner);
        stage.alt = null;
        for (const row of stage.rows) {
          row.who = readerCopy(row.who, owner);
          row.text = readerCopy(row.text, owner);
          if (row.when.kind === "policy") row.when.text = readerCopy(row.when.text, owner);
          row.alt = null;
        }
      }
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
    const laneId = query.get("laneId");
    if (laneId && this.visibleLane(laneId, viewer).topicId !== id) throw missing("lane");
    const canSee = (entry: HistoryRow) => {
      if (laneId && entry.laneId !== laneId) return false;
      if (entry.decisionId && !this.history.has(entry.id)
        && (this.decisions.get(entry.decisionId)?.state !== "approved" || this.history.has(`decision-${entry.decisionId}`))) return false;
      if (role !== "stages") return true;
      const lane = entry.laneId && this.lanes.get(entry.laneId);
      return Boolean(lane && lane.topicId === id && this.sharedLane(lane, viewer));
    };
    const existing = (base?.days ?? []).flatMap(day => day.entries.flatMap(entry => {
      if (entry.kind !== "event" || !canSee(entry)) return [];
      const action = this.history.get(this.overnightAliases.get(entry.id) ?? entry.id);
      return [{ label: day.label, entry: action ? { ...entry, undone: action.row.undone } : entry }];
    }));
    const added = [...this.history.values()].filter(action => action.topicId === id && !this.fixtureActions.has(action.row.id) && canSee(action.row)).reverse()
      .map(action => ({ label: Date.parse(action.row.at) < Date.parse(hour("00:00")) ? "Yesterday" : "Today", entry: action.row }));
    const records = [...added, ...existing].sort((a, b) => Date.parse(b.entry.at) - Date.parse(a.entry.at));
    const { items, nextCursor } = page(records, item => item.entry.id, `history:${id}:${viewer.id}:${laneId ?? ""}`, query);
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
      day.entries.push(viewer.id !== this.owner.id ? {
        ...entry, text: readerCopy(entry.text, this.owner.shortName), actor: this.shareActorCopy(entry.actor),
      } : entry);
    }
    const newSince = records.filter(item => !seenAt || Date.parse(item.entry.at) > Date.parse(seenAt)).length;
    return { seen: { at: seenAt }, shown: items.length, newSince, since: base?.since ?? "", days, nextCursor };
  }

  private threadTopic(id: string): string | null {
    const scope = threadScope(id);
    if (scope?.kind === "topic") return scope.id;
    if (scope?.kind === "lane") return this.lanes.get(scope.id)?.topicId ?? null;
    if (scope?.kind === "decision") return this.decisions.get(scope.id)?.topicId ?? null;
    return null;
  }

  private canReadThread(id: string, viewer: Actor): boolean {
    if (viewer.membershipState === "invited") return false;
    const scope = threadScope(id);
    if (!scope) return false;
    if (scope.kind === "lane") {
      const lane = this.lanes.get(scope.id);
      return Boolean(lane && !this.removed.has(lane.id) && this.sharedLane(lane, viewer));
    }
    const topicId = this.threadTopic(id);
    return topicId ? this.fullTopic(topicId, viewer) || (scope.kind === "topic" && ["stages", "view"].includes(this.role(topicId, viewer))) : viewer.id === this.owner.id;
  }

  private seesAudience(topicId: string, audience: MessageAudience, viewer: Actor, threadId: string): boolean {
    if (viewer.id === this.owner.id) return true;
    if (audience.kind === "owner") return false;
    const role = this.role(topicId, viewer);
    if (role === "none") return false;
    if (audience.kind === "viewer") return audience.personId === viewer.id;
    if (role === "all") return true;
    const stages = this.accessEntry(topicId, viewer)?.access.stages ?? [];
    return role === "stages" && (audience.kind === "stage" && stages.includes(audience.stage)
      || audience.kind === "topic" && threadId.startsWith("lane:"));
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

  private writableMessage(threadId: string, id: string, viewer: Actor): { thread: ThreadView; message: Message } {
    const thread = this.writableThread(threadId, viewer);
    const message = requireRecord(byId(thread.messages, id), "message");
    const topicId = this.threadTopic(thread.id);
    if (topicId && !this.seesAudience(topicId, message.audience, viewer, thread.id)) {
      throw new Problem("forbidden", "This reader cannot see that message.");
    }
    return { thread, message };
  }

  private threadView(id: string, viewer: Actor, query: URLSearchParams): ThreadView {
    const stored = requireRecord(this.threads.get(id), "thread");
    const scope = threadScope(id);
    if (scope?.kind === "lane" && this.removed.has(scope.id)) throw missing("thread");
    if (!this.canReadThread(id, viewer)) throw new Problem("forbidden", "This reader cannot see that conversation.");
    const associatedTopic = this.threadTopic(id);
    const view = structuredClone(stored);
    if (associatedTopic) view.messages = view.messages.filter(message => this.seesAudience(associatedTopic, message.audience, viewer, id));
    const role = associatedTopic ? this.role(associatedTopic, viewer) : "owner";
    if (associatedTopic && scope?.kind === "topic" && (role === "stages" || role === "view")) {
      const stages = this.accessEntry(associatedTopic, viewer)?.access.stages ?? [];
      view.scope = role === "view" ? `You and ${this.owner.shortName}.` : `${stages.join(", ")} only`;
      view.sub = view.scope;
      view.since = null;
      view.agents = null;
      view.pinned = null;
      view.suggestions = [];
      view.messages = view.messages.map(message => {
        const visible = (id: string) => {
          const lane = this.lanes.get(id);
          return Boolean(lane && this.sharedLane(lane, viewer));
        };
        return {
          ...message,
          decisionId: null,
          threadCard: message.threadCard && visible(message.threadCard.laneId) ? message.threadCard : null,
          actions: message.actions.filter(action => visible(action.laneId)),
        };
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
    if (pin && decision && decision.state !== "open") {
      pin.state = decision.state;
      if (decision.state === "approved") {
        const lane = pin.laneId ? this.lane(pin.laneId) : undefined;
        const actor = this.history.get(`decision-${decision.id}`)?.row.actor ?? this.owner;
        pin.title = `${lane?.short ?? pin.title}: ${actor.id === viewer.id ? "you" : actor.shortName} approved it`;
        if (lane?.shortAfter) pin.detail = lane.shortAfter;
      }
    } else if (pin && pin.laneId && this.lane(pin.laneId)?.state !== "bad" && pin.state === "stuck") {
      view.pinned = null;
    }
    view.messages = view.messages.map(message => ({
      ...message,
      author: viewer.id === this.owner.id ? message.author : this.shareActorCopy(message.author),
      actions: message.actions.filter(action => {
        const lane = this.lane(action.laneId);
        return lane && this.sharedLane(lane, viewer) && this.projectLane(lane, viewer).acts.some(choice => choice.id === action.id);
      }),
    }));
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
    const results = searchResults(text, scope, topics, lanes, people, decisions, viewer.id === this.owner.id ? this.skills.skills : []);
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
      if (device !== null && (!device.length || device.length > 200)) throw new Problem("badRequest", "deviceId must be 1 to 200 characters.");
      const layout = { ...this.prefsOf(viewer, device).layout };
      if (command.layout.sidebarWidth != null) layout.sidebarWidth = command.layout.sidebarWidth;
      if (command.layout.chatWidth != null) layout.chatWidth = command.layout.chatWidth;
      if (device) this.layouts.set(`${viewer.id}:${device}`, layout);
      else prefs.layout = layout;
    }
    this.preferences.set(viewer.id, prefs);
    return done([{ type: "prefs.changed" }, ...(command.briefsPerDay != null ? [{ type: "brief.published" } as const] : [])]);
  }

  private decisionRight(rule: string, who: "you" | "agent", dailyLimit: DailyLimit | null | undefined, personId: string | null, viewer: Actor): Effect {
    this.requireOwner(viewer);
    const setting = requireRecord(this.settings.decisionRights.find(item => item.rule === rule), "decision right");
    if (setting.risky && who === "agent" && dailyLimit == null) throw new Problem("badRequest", "Delegating this decision right requires a daily limit.");
    if (personId && who !== "agent") throw new Problem("badRequest", "Name a person only when delegating the right.");
    if (personId) requireRecord(this.people.get(personId), "person");
    setting.who = who;
    setting.personId = personId;
    setting.dailyLimit = who === "you" ? null : dailyLimit ?? null;
    return done([{ type: "prefs.changed" }]);
  }

  private pinsOf(viewer: Actor): string[] {
    return this.pinned.get(viewer.id) ?? (viewer.id === this.owner.id ? this.sidebarBase.pins.map(pin => pin.id) : []);
  }

  private pin(id: string, viewer: Actor, action: "add" | "remove" | "move", to = 0): Effect {
    this.requireOwner(viewer);
    requireRecord(byId(this.sidebarBase.pinnable, id), "pin");
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
    if (!this.access.get(id)?.statusLink) throw missing("status link");
    const topic = this.topicView(id, viewer, new URLSearchParams());
    const status = requireRecord(topic.status, "topic status");
    return { health: topic.health, signed: status.signed, goal: status.goal, unit: status.unit, nextReportAt: status.nextReportAt, nextReportId: status.nextReportId,
      stages: (topic.plan?.stages ?? []).map(({ name, percent }) => ({ name, percent })) };
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
    const hadAccess = current && current.access.kind !== "none";
    if (current) current.access = grant;
    else access.people.push({ person, access: grant, owner: false, scope: "", otherTopics: [] });
    for (const stage of topic.stages) {
      if (stage.runBy?.id === personId && !(kind === "all" || grant.stages.includes(stage.name))) stage.runBy = null;
    }
    const events: Event[] = [...this.access.values()].filter(view => view.topicId !== id && view.people.some(item => item.person.id === personId))
      .map(view => ({ type: "access.changed", topicId: view.topicId }));
    events.push({ type: "access.changed", topicId: id, ...(hadAccess || kind !== "none" ? { personId } : {}) });
    events.push({ type: "topic.changed", topicId: id });
    return done(events);
  }

  private assign(id: string, stageName: string, personId: string, viewer: Actor): Effect {
    this.requireOwner(viewer);
    const topic = requireRecord(this.topics.get(id), "topic");
    const stage = topic.stages.find(item => item.name === stageName);
    if (!stage) throw new Problem("badRequest", "That stage does not exist.");
    const stagePlan = topic.plan?.stages.find(item => item.name === stageName);
    const approvedAlt = stagePlan?.alt && this.decisions.get(stagePlan.alt.decisionId)?.state === "approved" ? stagePlan.alt : null;
    if ((approvedAlt?.state ?? stagePlan?.state) === "done") {
      throw new Problem("conflict", "That stage is finished.");
    }
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
    return done([
      { type: "access.changed", topicId: id, personId },
      ...(prior && prior.id !== personId ? [{ type: "access.changed", topicId: id, personId: prior.id } as const] : []),
      { type: "topic.changed", topicId: id },
    ]);
  }

  private madeRecord(id: string, viewer: Actor): MadeRecordView | undefined {
    for (const lane of this.lanes.values()) {
      const kind = lane.made.find(item => item.target?.id === id &&
        (item.target.kind === "run" || item.target.kind === "review"))?.target?.kind;
      if (!kind || this.removed.has(lane.id) || !this.sharedLane(lane, viewer)) continue;
      const item = this.visibleLane(lane.id, viewer).made.find(made => made.target?.id === id && made.target.kind === kind);
      if (item) return {
        id, kind, laneId: lane.id, title: item.title, detail: item.detail, url: null, trigger: null, startedAt: null,
        finishedAt: null, state: null, checks: [], log: null, pullId: null,
      };
    }
  }

  private recentTitle(page: Target, viewer: Actor): string | undefined {
    const id = page.id ?? "";
    switch (page.kind) {
      case "topic": return this.role(id, viewer) === "none" ? undefined : this.topics.get(id)?.name;
      case "lane": {
        const lane = this.lane(id);
        return lane && this.sharedLane(lane, viewer) ? lane.title : undefined;
      }
      case "decision": {
        const decision = this.decisions.get(id);
        return decision && this.fullTopic(decision.topicId, viewer) ? decision.title : undefined;
      }
      case "thread": return this.canReadThread(id, viewer) ? this.threads.get(id)?.title : undefined;
      case "person": return (viewer.id === this.owner.id || id === viewer.id) ? this.people.get(id)?.name : undefined;
      case "draft": return viewer.id === this.owner.id ? byId(this.draftsView().items, id)?.subject : undefined;
      case "skill": return viewer.id === this.owner.id ? byId(this.skills.skills, id)?.name : undefined;
      case "pull": return viewer.id === this.owner.id ? byId(this.pulls.items, id)?.title ?? (page.id === null ? "Pull requests" : undefined) : undefined;
      case "run":
      case "review": {
        const record = this.madeRecord(id, viewer);
        return record?.kind === page.kind ? record.title : undefined;
      }
      // Files, reports and checks have no page to visit until the stand-in serves their records.
      case "file":
      case "report":
      case "check": return undefined;
      case "manager": return viewer.id === this.owner.id ? "Manager" : undefined;
      case "drafts": return viewer.id === this.owner.id ? "Drafts" : undefined;
      case "skills": return viewer.id === this.owner.id ? "Skills" : undefined;
      case "brief": return "Brief";
      case "settings": return "Settings";
    }
  }

  private visitPage(destination: Target, viewer: Actor): Effect {
    const title = this.recentTitle(destination, viewer);
    if (!title) throw missing("page");
    const previous = this.recent.get(viewer.id) ?? [];
    const items = previous.filter(item => item.target.kind !== destination.kind || item.target.id !== destination.id);
    this.recent.set(viewer.id, [{ title, target: destination, at: this.now }, ...items].slice(0, 6));
    return done();
  }

  private invite(id: string, nameOrEmail: string, viewer: Actor): Effect {
    this.requireOwner(viewer);
    const access = requireRecord(this.access.get(id), "topic");
    const name = nameOrEmail.trim();
    if (!name) throw new Problem("badRequest", "Enter a name or email address.");
    const lookup = name.toLowerCase();
    const duplicate = access.invitations.find(item => item.nameOrEmail.toLowerCase() === lookup);
    if (duplicate) return done([{ type: "access.changed", topicId: id, personId: duplicate.personId }]);
    const existing = [...this.access.values()].flatMap(record => record.people)
      .find(entry => entry.person.name.toLowerCase() === lookup || entry.email?.toLowerCase() === lookup);
    const current = existing && this.accessEntry(id, existing.person);
    if (current && current.access.kind !== "none") {
      return done([{ type: "access.changed", topicId: id, personId: current.person.id }]);
    }
    const invitationId = `invite-${++this.serial}`;
    const person = existing?.person ?? { ...blankActor(name.includes("@") ? name.split("@")[0] ?? name : name, "person"),
      id: invitationId, membershipState: "invited" as const };
    this.people.set(person.id, person);
    this.setAccess(id, person.id, "view", [], viewer);
    const entry = this.accessEntry(id, person);
    const email = existing?.email ?? (name.includes("@") ? lookup : undefined);
    if (entry && email) entry.email = email;
    if (person.membershipState === "invited") {
      access.invitations.push({ id: invitationId, personId: person.id, nameOrEmail: name, state: "pending", invitedAt: this.now, acceptedAt: null, topicId: id, invitedBy: this.owner });
    }
    return done([{ type: "access.changed", topicId: id, personId: person.id }, { type: "topic.changed", topicId: id }]);
  }

  private acceptInvitation(id: string, viewer: Actor): Effect {
    const records = [...this.access.values()];
    const invitation = requireRecord(records.flatMap(view => view.invitations).find(item => item.id === id), "invitation");
    if (invitation.personId !== viewer.id) throw new Problem("forbidden", "This invitation belongs to another reader.");
    if (invitation.state === "accepted") return done();
    viewer.membershipState = "active";
    const events: Event[] = [];
    for (const access of records.filter(view => view.people.some(entry => entry.person.id === viewer.id))) {
      for (const item of access.invitations.filter(item => item.personId === viewer.id)) item.state = "accepted";
      events.push({ type: "access.changed", topicId: access.topicId, personId: viewer.id }, { type: "topic.changed", topicId: access.topicId });
    }
    return done(events);
  }

  private revoke(id: string, viewer: Actor): Effect {
    this.requireOwner(viewer);
    for (const [topicId, access] of this.access) {
      const invitation = byId(access.invitations, id);
      if (!invitation) continue;
      const person = this.people.get(invitation.personId);
      if (person?.membershipState === "invited") {
        this.setAccess(topicId, person.id, "none", [], viewer);
        access.people = access.people.filter(entry => entry.person.id !== person.id);
      }
      access.invitations = access.invitations.filter(item => item.id !== id);
      if (person?.membershipState === "invited" && ![...this.access.values()].some(view => view.people.some(entry => entry.person.id === person.id))) {
        this.people.delete(person.id);
      }
      return done([{ type: "access.changed", topicId, personId: invitation.personId }, { type: "topic.changed", topicId }]);
    }
    throw missing("invitation");
  }

  private statusLink(id: string, enabled: boolean, viewer: Actor): Effect {
    this.requireOwner(viewer);
    const access = requireRecord(this.access.get(id), "topic");
    access.statusLink = enabled ? { url: `${this.origin()}${BASE}/topics/${id}/status`, orgOnly: true } : null;
    return done([{ type: "access.changed", topicId: id }]);
  }

  private visit(id: string, viewer: Actor): Effect {
    requireRecord(this.topics.get(id), "topic");
    if (this.role(id, viewer) === "none") throw new Problem("forbidden", "This topic is not shared with this reader.");
    this.seen.set(`${viewer.id}:${id}`, this.now);
    return done([{ type: "topic.changed", topicId: id }, { type: "thread.changed", threadId: `topic:${id}` }]);
  }

  private remember(topicId: string | null, record: string, text: string, actor: Actor, apply: HistoryAction["apply"],
    laneId: string | null = null, id = `action-${++this.serial}`, at = this.now,
    authorize: HistoryAction["authorize"] = viewer => {
      if (topicId) this.writableTopic(topicId, viewer, this.lanes.get(laneId ?? ""));
      else this.requireOwner(viewer);
    }): HistoryAction {
    const action: HistoryAction = {
      row: { id, kind: "event", at, actor, text, laneId, decision: false, sentOutside: false, undoable: true, undone: false,
        count: null, samples: [], decisionId: null, checkId: null },
      topicId, record, apply, authorize,
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

  private rememberOvernight(row: OvernightAction): void {
    const lane = requireRecord(this.lanes.get(row.laneId ?? ""), "overnight lane");
    const lanes = [lane.id, ...(row.relatedLaneIds ?? [])];
    for (const id of lanes) {
      for (const entry of overnightHistory[id] ?? []) {
        this.overnightAliases.set(entry, row.id);
        this.history.delete(entry);
      }
    }
    const remove = this.module === "dev" || lane.id === "customer-profile";
    const apply = (undone: boolean): Event[] => {
      const events: Event[] = [{ type: "brief.changed" }];
      for (const id of lanes) {
        if (remove && undone) this.removed.add(id);
        else if (remove) this.removed.delete(id);
        events.push({ type: remove && undone ? "lane.removed" : "lane.changed", laneId: id });
      }
      if (row.topicId) events.push({ type: "topic.changed", topicId: row.topicId });
      return events;
    };
    this.remember(row.topicId, lane.id, row.text, lane.lead, apply, lane.id, row.id, row.at, viewer => this.requireOwner(viewer));
  }

  private undo(id: string, undone: boolean, viewer: Actor): Effect {
    const action = requireRecord(this.history.get(this.overnightAliases.get(id) ?? id), "action");
    action.authorize(viewer);
    if (action.row.undone === undone) return done();
    const overnight = byId(this.briefBase.overnight, action.row.id);
    const actions = [...this.history.values()].filter(item => item.record === action.record || overnight?.relatedLaneIds?.includes(item.record));
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
    const requester = viewer.id === this.owner.id ? "your" : `${viewer.shortName}'s`;
    const lead = { ...assigned, state: "new", word: "Leads", text: `Reading ${requester} ask`, engine: model?.name ?? assigned.engine ?? "Auto" } satisfies Actor;
    const id = `new-${++this.serial}`;
    const chain = /\b(then|once|after|before)\b/i.test(text);
    const source = options.fromChat && topic ? `In the ${topic.name} chat` : `${viewer.id === this.owner.id ? "You" : viewer.name} to the Manager`;
    const note = topic ? `Filed under ${topic.name}. ${lead.name} leads.` : "The Manager keeps it until it knows where it belongs.";
    const status = topic ? `${lead.name} is reading ${requester} ask and will set what done means before starting.` : note;
    const askText = options.attachment ? `${text} (with ${options.attachment.name})` : text;
    const lane: LaneView = {
      id, topicId, title: text, state: "new", stateWord: "Starting", lead, waitsFor: null,
      openedAt: this.now, closedAt: null, next: null, nextAt: new Date(Date.parse(this.now) + 3600000).toISOString(),
      afterNext: null, afterNextAt: null, decisionId: null,
      short: null, ask: null, shortAfter: null, recommendation: null, yours: null, checks: [], delay: null,
      approveLabel: null, after: null, asked: askText, askedMeta: { source, note }, status,
      standing: { headline: "Just opened.", detail: status },
      acts: [{ id: "undo-file", label: "Undo", tone: "quiet", personId: null, target: null }],
      thumbs: [], steps: [
        { kind: "now", text: "Set what done means", who: lead.name, doneAt: null },
        { kind: "todo", text: "Do the work", who: lead.name, doneAt: null },
        { kind: "todo", text: "Check and report back", who: "Manager", doneAt: null },
      ],
      doneNote: "The lead sets the steps before it starts.", crew: [lead], made: [], handover: null, fresh: true,
      attachment: options.attachment ?? null, model: model?.id ?? null, chain, reminder: null,
      tries: null, scheduleId: null, groupId: null, waitsOnResource: null, leadName: null,
    };
    const receipt: Receipt = {
      actionId: `file-${id}`,
      text: askText, filedUnder: topicId ? target("topic", topicId) : target("manager"),
      lead, chain, laneId: id, groupLaneIds: [],
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
    const filed: Event = { type: "lane.filed", laneId: id, topicId, chain, scheduleId: null, groupId: null };
    this.remember(topicId, id, receipt.text, viewer, undone => {
      if (undone) this.removed.add(id);
      else this.removed.delete(id);
      const events: Event[] = [undone ? { type: "lane.removed", laneId: id } : { ...filed, topicId: lane.topicId }];
      if (lane.topicId) events.push({ type: "topic.changed", topicId: lane.topicId });
      if (this.draftsFor(viewer).items.some(draft => draft.laneId === id)) events.push({ type: "drafts.changed" });
      return events;
    }, id, `file-${id}`, this.now, reader => {
      if (!topicId) this.requireOwner(reader);
      else this.writableTopic(topicId, reader);
      options.authorize?.(reader);
      if (reader.id !== viewer.id && this.draftsFor(viewer).items.some(draft => draft.laneId === id)) {
        this.requireOwner(reader);
      }
    });
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
    this.remember(topicId, id, `Moved ${base.title} to ${topic.name}.`, viewer, apply, id, undefined, this.now, reader => {
      if (previous.topicId) this.writableTopic(previous.topicId, reader, lane);
      else this.requireOwner(reader);
      this.writableTopic(topicId, reader);
    });
    return done(apply(false));
  }

  private laneAct(id: string, actionId: string, viewer: Actor): Effect {
    const lane = this.visibleLane(id, viewer);
    if (lane.topicId) this.writableTopic(lane.topicId, viewer, lane);
    const action = byId(lane.acts, actionId);
    if (actionId === "undo-file" && action) return this.undo(`file-${id}`, true, viewer);
    if (lane.decisionId && actionId === "undo" && action) return this.setDecision(lane.decisionId, "open", viewer);
    if (lane.decisionId && actionId === "approve" && action) return this.setDecision(lane.decisionId, "approved", viewer);
    if (!action) throw new Problem("badRequest", "That choice is not available on this lane.");
    if (action.target) return done([], id);
    if (id === "webinar" && (actionId === "post-passing" || actionId === "one-more-round")) {
      return this.settleWebinar(lane, actionId, viewer);
    }
    if (id === "outreach-wave-2" && actionId === "send-wave-2" && lane.waitsFor?.id === viewer.id) {
      const base = requireRecord(this.lanes.get(id), "lane");
      const status = "Wave 2 goes out at 20 a day. Mara sees it in her brief.";
      const prior = { waitsFor: base.waitsFor, state: base.state, stateWord: base.stateWord, status: base.status, standing: base.standing, acts: base.acts };
      const apply = (undone: boolean): Event[] => {
        Object.assign(base, undone ? prior : { waitsFor: null, state: "ok", stateWord: "Working", status, standing: { headline: "Wave 2 is scheduled.", detail: status }, acts: [] });
        return [...laneUpdate(id, base.topicId), { type: "thread.changed", threadId: "topic:partnerships" }, { type: "brief.changed" }];
      };
      const record = this.remember(base.topicId, id, status, viewer, apply, id, undefined, this.now, reader => {
        if (base.topicId) this.writableTopic(base.topicId, reader, base);
        if (reader.id !== viewer.id) throw new Problem("forbidden", "This choice belongs to the person assigned to the lane.");
      });
      return done([...apply(false), { type: "agentAction.changed", actionId: record.row.id }], id);
    }
    if (action.personId) return this.remind(id, action.personId, viewer);
    const replies: Record<string, string> = {
      "pin-the-old-session-library": "Builder pins the old session library and reruns the checks.",
      "allow-one-more-try": "Builder gets one more run to fix the failing sign-in test.",
    };
    const status = replies[action.id];
    if (!status || lane.state !== "bad") throw new Problem("badRequest", "That choice is not available on this lane.");
    const base = requireRecord(this.lanes.get(id), "lane");
    const previous = { state: base.state, stateWord: base.stateWord, status: base.status, next: base.next, nextAt: base.nextAt, standing: base.standing, steps: base.steps, acts: base.acts };
    const next = {
      state: "ok", stateWord: "Working", status, next: status, standing: { headline: "Working again.", detail: status },
      steps: base.steps.map(step => step.kind === "now" ? { ...step, text: status } : step), acts: [] as LaneAct[],
    };
    const apply = (undone: boolean): Event[] => {
      Object.assign(base, undone ? previous : next);
      return [...laneUpdate(id, base.topicId), { type: "thread.changed", threadId: `topic:${base.topicId}` }, { type: "brief.changed" }];
    };
    const record = this.remember(base.topicId, id, status, viewer, apply, id);
    return done([...apply(false), { type: "agentAction.changed", actionId: record.row.id }]);
  }

  private settleWebinar(lane: LaneView, choice: keyof typeof WEBINAR_SETTLEMENTS, viewer: Actor): Effect {
    if (lane.state !== "bad") throw new Problem("conflict", "The promo is already settled.");
    const values = WEBINAR_SETTLEMENTS[choice];
    const base = requireRecord(this.lanes.get(lane.id), "lane");
    const topicId = requireRecord(base.topicId, "topic");
    const previous = { state: base.state, stateWord: base.stateWord, status: base.status, next: base.next, nextAt: base.nextAt, standing: base.standing, steps: base.steps, acts: base.acts };
    const id = `action-${++this.serial}`;
    const settlement = {
      laneId: lane.id, actionId: id, title: values.receipt, stateWord: "Settled by you",
      detail: "Nothing else is stuck.", target: target("topic", topicId),
    };
    const apply = (undone: boolean): Event[] => {
      if (undone) this.settlements.delete(lane.id);
      else this.settlements.set(lane.id, settlement);
      Object.assign(base, undone ? previous : {
        state: "ok", stateWord: "Working", status: values.status, next: "Promo scheduled",
        nextAt: this.briefBase.burns.find(burn => burn.laneId === lane.id)?.dueAt ?? null, acts: [],
        standing: { headline: "The promo is settled.", detail: values.status },
        steps: previous.steps.map(step => step.kind === "now" ? { kind: "ok", text: values.step, who: "You · now", doneAt: null } : step),
      });
      return [...laneUpdate(lane.id, topicId), { type: "thread.changed", threadId: `topic:${topicId}` }, { type: "brief.changed" }];
    };
    const record = this.remember(topicId, lane.id, values.history, viewer, apply, lane.id, id);
    return done([...apply(false), { type: "agentAction.changed", actionId: id }], lane.id, null, {
      actionId: record.row.id, text: values.receipt, laneId: lane.id, filedUnder: target("topic", topicId), lead: lane.lead, chain: false, groupLaneIds: [],
    });
  }

  private remind(id: string, personId: string, viewer: Actor): Effect {
    const lane = this.visibleLane(id, viewer);
    if (lane.topicId) this.writableTopic(lane.topicId, viewer, lane);
    const recipient = lane.waitsFor?.id === personId ? lane.waitsFor : byId(lane.crew, personId);
    if (!recipient || recipient.kind !== "person") throw missing("person");
    if (recipient.id === viewer.id) throw new Problem("badRequest", "Choose someone else to remind.");
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
    const handover = record.handover;
    if (!handover) throw new Problem("conflict", "There is no handover to confirm.");
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
    for (const topicId of decision.goalChange?.affectedTopics ?? []) {
      events.push({ type: "topic.changed", topicId });
    }
    for (const lane of this.lanes.values()) if (lane.decisionId === decision.id) events.push({ type: "lane.changed", laneId: lane.id });
    for (const thread of this.threads.values()) if (thread.pinned?.decisionId === decision.id || thread.id === `decision:${decision.id}`) {
      events.push({ type: "thread.changed", threadId: thread.id });
    }
    return events;
  }

  private setDecision(id: string, state: "approved" | "declined" | "open", viewer: Actor): Effect {
    const decision = requireRecord(this.decisions.get(id), "decision");
    this.requireDecisionRight(decision, viewer);
    if (decision.state === state) return done();
    if (decision.state === "expired" || (state !== "open" && decision.state !== "open")) {
      throw new Problem("conflict", "The decision is already settled.");
    }
    const actionId = `decision-${id}`;
    if (state === "open") {
      if (decision.release?.stage === "done") throw new Problem("conflict", "The rollout has already finished.");
      return this.undo(actionId, true, viewer);
    }
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
        decision.release.stage = "scheduled";
        decision.release.startedAt = null;
        events.push({ type: "release.changed", decisionId: id });
      }
      if (pull && state === "approved" && !pull.held) {
        pull.state = undone ? initialPullState ?? "ready" : "releasing";
        events.push({ type: "pull.changed", pullId: pull.id });
      }
      return events;
    };
    const record = this.remember(decision.topicId, actionId, `${state === "approved" ? "Approved" : "Declined"}: ${decision.title}`, viewer,
      apply, decision.laneId, actionId, this.now, reader => this.requireDecisionRight(decision, reader));
    record.row.decision = true;
    record.row.decisionId = id;
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

  private message(author: Actor, text: string, kind: LabelKind | null, audience: MessageAudience = { kind: "topic" }): Message {
    return {
      id: `m${++this.messageSerial}`, at: this.now, author, text, audience,
      label: kind ? { kind, corrected: false, pinned: kind === "decision" } : null,
      threadCard: null, readBack: null, actions: [], decisionId: null, attachment: null, model: null, page: null,
      addressee: null,
    };
  }

  private send(command: Extract<Command, { type: "message.send" }>, viewer: Actor): Effect {
    const { threadId, text } = command;
    const scope = requireRecord(threadScope(threadId), "thread");
    const topicId = this.threadTopic(threadId);
    if (topicId && scope.kind === "topic" && (command.recipientId || this.role(topicId, viewer) === "view")) {
      if (command.stage) throw new Problem("badRequest", "A status conversation has no stage.");
      if (command.recipientId) this.requireOwner(viewer);
      const personId = command.recipientId ?? viewer.id;
      const recipient = this.viewer(personId);
      if (this.role(topicId, recipient) !== "view") throw new Problem("forbidden", "This person does not have status access.");
      const thread = requireRecord(this.threads.get(threadId), "thread");
      const message = this.message(viewer, text, null, { kind: "viewer", personId });
      message.attachment = command.attachment ?? null;
      thread.messages.push(message);
      return done([{ type: "message.posted", threadId, message }], null, message);
    }
    if (command.recipientId) throw new Problem("badRequest", "A status conversation belongs to a topic.");
    if (scope.kind === "topic" && topicId && (this.role(topicId, viewer) === "stages" || command.stage)) {
      const topic = requireRecord(this.topics.get(topicId), "topic");
      const stages = this.fullTopic(topicId, viewer) ? topic.stages.map(stage => stage.name) : this.accessEntry(topicId, viewer)?.access.stages ?? [];
      const stage = command.stage ?? (stages.length === 1 ? stages[0] : undefined);
      if (!stage) throw new Problem("badRequest", "Choose a stage for this message.");
      if (!stages.includes(stage)) throw new Problem("forbidden", "This reader cannot post in that stage.");
      const thread = requireRecord(this.threads.get(threadId), "thread");
      const message = this.message(viewer, text, classify(text), { kind: "stage", stage });
      message.attachment = command.attachment ?? null;
      message.model = this.model(command.model)?.id ?? null;
      thread.messages.push(message);
      return done([{ type: "message.posted", threadId, message }], null, message);
    }
    if (command.stage) throw new Problem("badRequest", "Choose a topic conversation to post in a stage.");
    const thread = this.writableThread(threadId, viewer);
    const topic = topicId ? this.topicView(topicId, viewer, new URLSearchParams()) : null;
    const kind = scope.kind === "topic" || scope.kind === "manager" || scope.kind === "general"
      ? command.page && /^(sum up|summari[sz]e)\b/i.test(text) ? "question" : classify(text) : null;
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
      reply = this.message(lane.lead, `Got it. I added ${viewer.shortName}'s note and will report back here.`, null);
    } else if (kind === "question" && topic) {
      const answer = this.questionReply(topic, text);
      reply = this.message(blankActor(`${topic.name} manager`), readerCopy(answer, this.owner.shortName), null, sent.audience);
    } else if (kind === "question" && (scope.kind === "manager" || scope.kind === "general")) {
      const page = command.page;
      const named = page ? this.recentTitle(page, viewer) : undefined;
      const brief = this.brief(viewer);
      const detail = named && page?.kind === "lane" ? this.lane(page.id ?? "")?.status
        : named && page?.kind === "topic" ? this.topics.get(page.id ?? "")?.goal?.insight : undefined;
      reply = this.message(blankActor("Manager"), detail ? `From the record: ${detail}` : brief.lede, null);
    } else if (kind === "goalChange" && topic?.goal) {
      const decision = this.proposeGoal(topic, text, sent);
      reply = this.message(blankActor(`${topic.name} manager`), `I put the goal change in Decide. The goal stays as it is until ${this.owner.shortName} approves it.`, null);
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
    if (reply) reply.audience = sent.audience;
    for (const message of reply ? [sent, reply] : [sent]) {
      thread.messages.push(message);
      events.push({ type: "message.posted", threadId, message });
    }
    return done(events, filed?.lane.id ?? null, sent, filed?.receipt ?? null);
  }

  private projectGoalChange(goal: NonNullable<TopicView["goal"]>, change: NonNullable<DecisionView["goalChange"]>): void {
    const priorTarget = goal.target;
    const unit = change.unit ?? goal.unit;
    goal.target = change.to;
    goal.trajectory.goal = change.to;
    if (change.deadlineAt) goal.deadlineAt = change.deadlineAt;
    if (change.unit || change.deadlineAt) {
      goal.unit = unit;
      if (goal.trajectory.unit) goal.trajectory.unit = unit;
    }
    const targetFigure = goal.figures.find(figure => figure.of === priorTarget);
    if (targetFigure) targetFigure.of = change.to;
    const gap = Math.max(0, goal.target - goal.signed - (goal.likely ?? 0));
    const unsecured = goal.figures.find(figure => /still (unsecured|missing)/i.test(figure.label));
    if (unsecured) unsecured.value = gap;
    if (goal.gap) {
      goal.gap.says = gap === 0 ? `The current forecast reaches the goal of ${goal.target}.` : `To reach ${goal.target}, the forecast still needs ${gap} more ${unit}.`;
    }
    const trajectory = goal.trajectory;
    const end = change.deadlineAt ? Math.round((Date.parse(change.deadlineAt.slice(0, 10)) - Date.parse(trajectory.start)) / 86400000) : null;
    if (end !== null && end > trajectory.now) {
      trajectory.days = end;
      const label = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(change.deadlineAt ?? ""));
      trajectory.ticks = [...trajectory.ticks.filter(tick => tick.day < end), { day: end, label }];
      trajectory.plan = [...trajectory.plan.filter(point => point.day < end), { day: end, value: change.to }];
    } else if (priorTarget !== change.to) {
      const last = trajectory.plan.at(-1);
      if (last) last.value = change.to;
    }
  }

  private proposalDeadline(text: string, current: string | null): string | null {
    const base = new Date(this.now);
    const date = /\b(?:by|to)\s+(?:the\s+)?(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+(20\d{2}))?\b/i.exec(text);
    if (date?.[1] && date[2]) {
      const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].findIndex(name => name.toLowerCase() === date[2]?.toLowerCase());
      const year = date[3] ? Number(date[3]) : current ? Number(current.slice(0, 4)) : base.getUTCFullYear();
      const day = Number(date[1]);
      let result = new Date(Date.UTC(year, month, day, 16));
      if (!date[3] && result <= base) result = new Date(Date.UTC(year + 1, month, day, 16));
      if (result.getUTCDate() !== day || result.getUTCMonth() !== month || result <= base) throw new Problem("badRequest", "Choose a valid future goal deadline.");
      return result.toISOString();
    }
    if (/\bby (?:the )?end of the quarter\b/i.test(text)) {
      const lastMonth = (Math.floor(base.getUTCMonth() / 3) + 1) * 3;
      return new Date(Date.UTC(base.getUTCFullYear(), lastMonth, 0, 16)).toISOString();
    }
    return null;
  }

  private proposeGoal(topic: TopicView, text: string, message: Message): DecisionView {
    const goal = requireRecord(topic.goal, "goal");
    const deadlineAt = this.proposalDeadline(text, goal.deadlineAt);
    const dateOnly = /\b(?:deadline|end date|due date)\b/i.test(text) && !/\b(?:target|from)\b/i.test(text);
    const match = dateOnly ? null : /\b(?:to|target is|goal is)\s+(\d+)\b(?:\s+([a-z][a-z -]*?))?(?=\s+by\b|[.!?,]|$)/i.exec(text);
    const to = match?.[1] ? Number(match[1]) : goal.target;
    const currentUnit = goal.unit;
    const namedUnit = match?.[2]?.trim() ?? /\bunit to ([a-z][a-z -]{0,199}?)(?=\s+by\b|[.!?,]|$)/i.exec(text)?.[1]?.trim();
    const unit = namedUnit && namedUnit.toLowerCase() !== currentUnit.toLowerCase() ? namedUnit : null;
    if (!Number.isSafeInteger(to) || to <= 0 || (match === null && !deadlineAt && !unit)) {
      throw new Problem("badRequest", "Include the new target, units or deadline for this goal.");
    }
    const id = `dc-${++this.serial}`;
    const changesPaid = topic.id === "partnerships" && this.topics.has("paid");
    const detail = changesPaid ? "Paid’s partner budget and the Friday report follow the new goal." : "The new target applies to this topic’s plan.";
    const decision: DecisionView = {
      id, title: text, shortTitle: `Change the ${topic.name} goal`, state: "open", topicId: topic.id, topicName: topic.name,
      dueAt: this.nextBrief(3), whyYours: "Yours: changes a goal", minutes: 2, contextLine: topic.name, cardContext: detail,
      doneNote: "Approved. The goal is changed on record.", laneId: null, approveLabel: "Approve",
      provenance: null, context: detail, numbers: [], proof: null, opportunity: null, risk: null, suggestion: null,
      guardrail: null, nextSteps: [], ifNoAnswer: "Nothing changes without your answer.", position: { index: 0, of: 0, open: 0 },
      changeRequest: null, release: null, rule: "hardToUndo", proposer: null,
      goalChange: {
        topicId: topic.id, field: to !== goal.target ? "target" : deadlineAt ? "deadline" : "unit",
        from: goal.target, to, affectedTopics: changesPaid ? ["paid"] : [],
        deadlineAt, previousDeadlineAt: goal.deadlineAt, unit, previousUnit: currentUnit,
        budget: null, priority: null, guardrail: null,
      },
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
    const { thread, message } = this.writableMessage(requireRecord(containing[0], "message").id, id, viewer);
    if (kind === "decision" && !message.decisionId) message.decisionId = thread.pinned?.decisionId ?? null;
    message.label = { kind, corrected: true, pinned: kind === "decision" };
    const decision = message.decisionId && this.threads.get(`decision:${message.decisionId}`);
    if (kind === "decision" && decision && !containing.includes(decision)) {
      decision.messages.push(message);
      containing.push(decision);
    }
    return done(containing.map(item => ({ type: "thread.changed", threadId: item.id })), null, message);
  }

  private draftsFor(viewer: Actor): DraftsView {
    if (viewer.id === this.owner.id) return this.drafts;
    const stored = this.personalDrafts.get(viewer.id);
    if (stored) return stored;
    const drafts: DraftsView = { intro: "Drafts prepared for your review.", count: 0, items: [] };
    this.personalDrafts.set(viewer.id, drafts);
    return drafts;
  }

  private draftsView(viewer = this.owner): DraftsView {
    const view = this.draftsFor(viewer);
    const items = view.items.filter(draft => !draft.laneId || !this.removed.has(draft.laneId));
    return { ...view, items, count: items.length };
  }

  private model(id: string | null | undefined) {
    if (!id) return null;
    const model = byId(this.modelPicker.items, id);
    if (!model) throw new Problem("badRequest", "Choose a model from the model picker.");
    if (model.state === "addKey" || model.state === "signIn") throw new Problem("conflict", "Connect this model before using it.");
    return model;
  }

  private requireSkillRight(skill: SkillsView["skills"][number], topicId: string | null, viewer: Actor): void {
    if (viewer.id === this.owner.id) return;
    if (!topicId || !this.fullTopic(topicId, viewer)) throw new Problem("forbidden", "This skill needs work access to its topic.");
    const delegation = this.settings.decisionRights.find(right => right.rule === "insideGuardrails");
    if (skill.asksFirst || delegation?.who !== "agent" || (delegation.personId && delegation.personId !== viewer.id)) {
      throw new Problem("forbidden", "The inside-guardrails decision right does not allow this skill run.");
    }
  }

  private runSkill(id: string, input: string | undefined, model: string | null | undefined, explicitTopic: string | null, viewer: Actor): Effect {
    const skill = requireRecord(byId(this.skills.skills, id), "skill");
    const text = input ?? `Run ${skill.name}`;
    const named = [...this.topics.values()].filter(item => skill.topics.toLowerCase().includes(item.name.toLowerCase()))
      .sort((a, b) => b.name.length - a.name.length)[0]?.id ?? null;
    const topicId = explicitTopic ?? named;
    const owner = viewer.id === this.owner.id;
    this.requireSkillRight(skill, topicId, viewer);
    if (!skill.enabled) throw new Problem("skillDisabled", "Connect the skill’s provider before running it.");
    const file = this.file(text, viewer, { model: model ?? null, topicId, route: false,
      authorize: reader => this.requireSkillRight(skill, topicId, reader) });
    if (skill.id === "weekly-summary" || !owner) {
      const draftId = `draft-${++this.serial}`;
      const drafts = this.draftsFor(viewer);
      drafts.items.push({
        id: draftId, to: "Team", writtenAt: this.now, skill: skill.name, subject: skill.id === "weekly-summary" ? "Weekly summary" : skill.name,
        body: text, laneId: file.lane.id, openUrl: `https://mail.example.test/mail/u/0/#drafts/${draftId}`,
      });
      drafts.count = drafts.items.length;
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
    const connection = byId(this.skills.connections, id);
    const model = byId(this.modelPicker.items, id);
    if (!connection && !model) throw missing("connection");
    if (model?.state === "addKey") model.state = "connected";
    if (model?.state === "signIn") model.state = "signedIn";
    if (connection?.state === "addKey") connection.state = "connected";
    if (connection?.state === "signIn") connection.state = "signedIn";
    this.skills.connected = this.skills.connections.filter(item => item.state === "connected" || item.state === "signedIn").length;
    for (const skill of this.skills.skills) {
      if (skill.needsKey && slug(skill.needsKey) === id) skill.enabled = true;
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
      .map(() => ({ type: "guardrail.breached", topicId: topic.id, name, guardrailId: slug(name) } as const)) ?? []);
    return done([{ type: "skills.changed" }, ...(on ? breached : [])]);
  }

  private hold(id: string, viewer: Actor): Effect {
    this.requireOwner(viewer);
    const pull = requireRecord(byId(this.pulls.items, id), "pull request");
    if (pull.state !== "autoMerge" || !pull.autoMergeAt) {
      throw new Problem("conflict", "Only pending auto-merge pull requests can be held.");
    }
    const scheduledAt = pull.autoMergeAt;
    const actionId = `pull-hold-${id}`;
    const previous = this.history.get(actionId);
    if (previous?.row.undone) return this.undo(actionId, false, viewer);
    const lane = pull.laneId ? this.lane(pull.laneId) : undefined;
    const apply = (undone: boolean): Event[] => {
      if (undone ? pull.state !== "held" : pull.state !== "autoMerge") {
        throw new Problem("conflict", "The auto-merge state has changed.");
      }
      pull.held = !undone;
      pull.state = undone ? "autoMerge" : "held";
      pull.autoMergeAt = undone ? scheduledAt : null;
      return [{ type: "pull.changed", pullId: id }, { type: "brief.changed" }, ...(lane ? laneUpdate(lane.id, lane.topicId) : [])];
    };
    const action = this.remember(lane?.topicId ?? pull.projectId, actionId, `Held pull request ${pull.number}.`, viewer,
      apply, pull.laneId, actionId, this.now, reader => this.requireOwner(reader));
    return done([...apply(false), { type: "agentAction.changed", actionId: action.row.id }]);
  }

  private unhold(id: string, viewer: Actor): Effect {
    this.requireOwner(viewer);
    const pull = requireRecord(byId(this.pulls.items, id), "pull request");
    if (pull.state !== "held") throw new Problem("conflict", "This pull request is not held.");
    return this.undo(`pull-hold-${id}`, true, viewer);
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
            { type: "guardrail.breached", topicId: topic.id, name: guardrail.what, guardrailId: slug(guardrail.what) },
            { type: "attention.raised", target: target("topic", topic.id), reason: `${guardrail.what} breached its guardrail.` },
          );
        }
      }
    }
    if (this.resetUsage(now)) events.push({ type: "usage.changed" });
    for (const burn of this.briefBase.burns) {
      if (burn.dueAt && Date.parse(burn.dueAt) > now && this.lane(burn.laneId)?.state === "bad") {
        this.alertOnce(events, target("lane", burn.laneId), "This stuck lane has a deadline.");
      }
    }
    for (const decision of this.decisions.values()) {
      if (decision.state === "open" && Date.parse(decision.dueAt) > now && Date.parse(decision.dueAt) < Date.parse(this.nextBrief(this.prefsOf(this.owner).briefsPerDay))) {
        this.alertOnce(events, target("decision", decision.id), "This decision is due before the next brief.");
      }
      if (decision.state === "open" && Date.parse(decision.dueAt) <= now) {
        decision.state = "expired";
        events.push({ type: "decision.expired", decisionId: decision.id }, ...this.decisionEvents(decision));
      }
      const release = decision.release;
      if (release?.stage === "scheduled" && decision.state === "approved" && Date.parse(release.scheduledAt) <= now) {
        release.stage = "rolling";
        release.startedAt = release.scheduledAt;
        events.push({ type: "release.changed", decisionId: decision.id }, ...(decision.laneId ? laneUpdate(decision.laneId, decision.topicId) : []));
      }
      if (release?.startedAt && (release.stage === "rolling" || release.stage === "watching")) {
        const elapsed = now - Date.parse(release.startedAt);
        const stage = elapsed >= release.watchMinutes * 60000 ? "done" : elapsed >= 60000 ? "watching" : "rolling";
        if (stage === release.stage) continue;
        release.stage = stage;
        events.push({ type: "release.changed", decisionId: decision.id }, ...(decision.laneId ? laneUpdate(decision.laneId, decision.topicId) : []));
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

  /** Take a before-image of shared projections so timing alone cannot expose private work. */
  notificationAudience(): (event: Event) => Set<string> {
    const snapshots = new Map<string, Map<string, string>>();
    const sharedEvents: Event[] = [
      ...[...this.topics.keys()].map(topicId => ({ type: "topic.changed", topicId } as const)),
      ...[...this.threads.keys()].map(threadId => ({ type: "thread.changed", threadId } as const)),
      { type: "brief.changed" },
    ];
    for (const reader of this.people.values()) {
      if (reader.id === this.owner.id) continue;
      snapshots.set(reader.id, new Map(sharedEvents.flatMap(event => {
        const key = this.notificationRecord(event, reader);
        return key === undefined ? [] : [[JSON.stringify(event), key]];
      })));
    }
    return event => {
      const audience = this.readers(event);
      if (event.type !== "topic.changed" && event.type !== "thread.changed" && event.type !== "brief.changed") return audience;
      const key = JSON.stringify(event);
      for (const id of audience) {
        const reader = this.people.get(id);
        if (!reader || reader.id === this.owner.id) continue;
        if (snapshots.get(id)?.get(key) === this.notificationRecord(event, reader)) audience.delete(id);
      }
      return audience;
    };
  }

  private notificationRecord(event: Event, viewer: Actor): string | undefined {
    const query = new URLSearchParams();
    if (!this.visibleEvent(event, viewer)) return undefined;
    if (event.type === "topic.changed") return JSON.stringify(this.topicView(event.topicId, viewer, query));
    if (event.type === "thread.changed" && this.threads.has(event.threadId)) {
      const scope = threadScope(event.threadId);
      if (scope?.kind !== "lane" || !this.removed.has(scope.id)) {
        return JSON.stringify(this.threadView(event.threadId, viewer, query));
      }
    }
    if (event.type === "brief.changed") return JSON.stringify(this.brief(viewer));
    return undefined;
  }

  /** Coarse work notifications on a clock tick only arise at a decision or rollout transition. */
  hasTimedWorkChange(at: string): boolean {
    const now = Date.parse(at);
    if (now <= Date.parse(this.now)) return false;
    return [...this.decisions.values()].some(decision => {
      if (decision.state === "open" && Date.parse(decision.dueAt) <= now) return true;
      const release = decision.release;
      if (!release || decision.state !== "approved") return false;
      if (release.stage === "scheduled") return Date.parse(release.scheduledAt) <= now;
      if (!release.startedAt || (release.stage !== "rolling" && release.stage !== "watching")) return false;
      const elapsed = now - Date.parse(release.startedAt);
      return elapsed >= (release.stage === "rolling" ? Math.min(1, release.watchMinutes) : release.watchMinutes) * 60000;
    });
  }

  private alertOnce(events: Event[], destination: Target, reason: string): void {
    const key = `${destination.kind}:${destination.id}`;
    if (!this.alerted.has(key)) {
      events.push({ type: "attention.raised", target: destination, reason });
      this.alerted.add(key);
    }
  }

  private pullsView(): PullsView {
    const items = this.pulls.items.map(pull => {
      const release = pull.decisionId ? this.decisions.get(pull.decisionId)?.release : undefined;
      const verdict = pull.state === "held" ? "Held by you" : pull.state === "released" ? "Released" :
        pull.state === "releasing" ? release?.stage === "scheduled" ? "Approved, rollout scheduled" : "Rollout in progress" : pull.verdict;
      return { ...pull, verdict };
    });
    const active = items.filter(pull => pull.state !== "released");
    const ready = active.filter(pull => pull.state === "ready").length;
    const review = active.filter(pull => pull.state === "inReview" || pull.state === "blocked").length;
    const auto = active.filter(pull => pull.state === "autoMerge").length;
    return { ...this.pulls, items, summary: `${active.length} open · ${ready} ready · ${review} in review · ${auto} auto-merge` };
  }

  private resetUsage(now: number): boolean {
    let changed = false;
    for (const account of [...this.usage.subscriptions, ...this.usage.keys]) {
      let reset = false;
      for (const meter of account.meters) {
        if (meter.resetsAt === null || Date.parse(meter.resetsAt) > now) continue;
        meter.used = 0;
        if (meter.spend) meter.spend.amountMinor = 0;
        if (meter.count) meter.count.used = 0;
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
    const audience = new Set([...this.people.values()].filter(viewer => this.visibleEvent(event, viewer)).map(viewer => viewer.id));
    if (event.type === "access.changed" && event.personId) audience.add(event.personId);
    return audience;
  }

  canReceive(event: Event, id: string): boolean {
    if (event.type === "access.changed" && event.personId === id) return true;
    const viewer = this.people.get(id);
    return Boolean(viewer && this.visibleEvent(event, viewer));
  }

  visibleEvent(event: Event, viewer: Actor): boolean {
    if (viewer.id === this.owner.id) return true;
    if ("threadId" in event) {
      if (!this.canReadThread(event.threadId, viewer)) return false;
      const topicId = this.threadTopic(event.threadId);
      if (event.type === "message.posted" && topicId) {
        if (!this.seesAudience(topicId, event.message.audience, viewer, event.threadId)) return false;
        if (!this.fullTopic(topicId, viewer)) {
          if (event.message.decisionId || event.message.page) return false;
          const ids = [...event.message.actions.map(action => action.laneId), ...(event.message.threadCard ? [event.message.threadCard.laneId] : [])];
          if (ids.some(id => {
            const lane = this.lanes.get(id);
            return !lane || !this.sharedLane(lane, viewer);
          })) return false;
        }
      }
      return true;
    }
    if ("laneId" in event) {
      const lane = this.lanes.get(event.laneId);
      return Boolean(lane && (event.type === "lane.removed" || !this.removed.has(lane.id)) && this.sharedLane(lane, viewer));
    }
    if ("decisionId" in event) {
      const decision = this.decisions.get(event.decisionId);
      return Boolean(decision && this.fullTopic(decision.topicId, viewer));
    }
    if (event.type === "access.changed") return event.personId === viewer.id;
    if (event.type === "guardrail.breached") return event.topicId !== null && this.fullTopic(event.topicId, viewer);
    if (event.type === "agentAction.changed") {
      const action = this.history.get(event.actionId);
      if (!action?.topicId || action.record.startsWith("pull-hold-")) return false;
      const lane = this.lanes.get(action.row.laneId ?? "");
      return this.fullTopic(action.topicId, viewer) || Boolean(lane && this.sharedLane(lane, viewer));
    }
    if (event.type === "attention.raised") {
      if (event.target.kind === "topic") return this.fullTopic(event.target.id ?? "", viewer);
      if (event.target.kind === "lane") {
        const lane = this.lanes.get(event.target.id ?? "");
        return Boolean(lane && this.sharedLane(lane, viewer));
      }
      if (event.target.kind === "decision") {
        const decision = this.decisions.get(event.target.id ?? "");
        return Boolean(decision && this.fullTopic(decision.topicId, viewer));
      }
    }
    if ("topicId" in event) return event.topicId !== null && this.role(event.topicId, viewer) !== "none";
    return event.type === "brief.published" || event.type === "brief.changed" || event.type === "feed.reset"
      || event.type === "prefs.changed" || event.type === "drafts.changed";
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
