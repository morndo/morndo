import { readerCopy } from "./viewer-copy.ts";
import { createHash } from "node:crypto";
import { loadFixtures } from "@morndo/cockpit-api";
import type {
  AccessView, Actor, ApiError, Ask, Attachment, BriefView, Command, CommandResult, DailyLimit,
  DecisionQueueView, DecisionView, DraftsView, Event, Forecast, GoalChange, GuardrailChange, HistoryEntry, HistoryPage, LabelKind, LaneAct,
  LaneView, MadeRecordView, ManagerView, MeasuredValue, MembersView, Message, MessageAudience, ModelId, ModelsView, OvernightAction, PullsView, Receipt,
  RecentView, Report, SearchView, SettingsView, SidebarView, SkillsView, SpotCheck, Target, Theme, ThemePatch, ThreadView,
  TopicView, UsageView, WorkspaceView,
} from "@morndo/cockpit-api";
import { artwork } from "./artwork.ts";
import { measuredNumber, readGoalAsk, type GoalAsk, type TopicFact } from "./goal-ask.ts";
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
  const person = kind === "person";
  return {
    id: slug(name) || "manager", name, shortName: person ? name.split(" ")[0] ?? name : name, kind,
    avatar: name[0]?.toUpperCase() ?? "?", role: null, state: null, word: null, text: null,
    skill: null, engine: null, record: null,
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 175);
}

function classify(text: string): LabelKind {
  if (/\?\s*$/.test(text)) return "question";
  if (/\b(?:deadline|goal|target|budget|priorit|guardrail)/i.test(text)) return "goalChange";
  if (/\b(?:done|checked|finished|is ready|are ready)\b/i.test(text)) return "done";
  if (/\b(?:approve|decide|go with)\b/i.test(text)) return "decision";
  return "request";
}

const FUNCTION_WORD = new Set(["the", "a", "an", "to", "for", "of", "in", "on", "at", "by", "with", "from", "into", "over", "under", "and", "or", "per", "via", "its", "their", "them", "that", "those", "this", "these", "it"]);
// A clause stands apart when it names something of its own: no pronoun, no word that ties it to what came first.
const BACK_REFERENCE = /\b(?:it|its|them|their|they|this|that|those|these|him|her|his|hers|one|ones|same|both|such)\b/i;
const CHAINED = /\b(?:then|after|before|once|when|while|until|because|which|who|whose|where|if|unless|so)\b/i;
const DETERMINER = new Set(["the", "a", "an", "some", "any", "every", "each", "all", "another", "our", "your", "my", "last", "next", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "several", "many", "few", "more", "most"]);
const IMPERATIVE = new Set(("add address adjust analyse analyze answer approve archive ask audit book brief build call cancel change check clean close collect compare compile confirm "
  + "contact convert copy count create crop cut define delete deploy design draft edit email enter estimate export extract fetch file find fix follow forward gather generate "
  + "get give hire identify import interview invite label launch list log look make map measure merge migrate monitor move name note offer open order organise organize "
  + "pack pause photograph pick pin plan post prepare pitch print profile promote propose proofread publish pull push put rank read rebuild record redesign reduce "
  + "refactor release remind remove rename reply report request research reset resize review revise rewrite rotate run schedule score search select send set share "
  + "shoot show sketch sort split start stop submit summarise summarize survey sync tag take test thank track translate trim tune update upload verify watch write").split(" "));

function isOwnClause(part: string, leading: boolean): boolean {
  if (BACK_REFERENCE.test(part)) return false;
  const words = part.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  const head = words[0] ?? "";
  if (!leading && /^[A-Z]/.test(head)) return false;
  const bare = head.toLowerCase();
  if (FUNCTION_WORD.has(bare)) return false;
  const rest = words.slice(1).map(word => word.toLowerCase());
  if (!rest.some(word => !FUNCTION_WORD.has(word))) return false;
  if (!IMPERATIVE.has(bare) && /s$/.test(bare) && !/ss$/.test(bare)) return false;
  return DETERMINER.has(rest[0] ?? "") || /^\d+$/.test(rest[0] ?? "");
}

// One sentence, one "and" between two clauses, each a verb with an object of its own. A comma, a second sentence, a pronoun
// or a word that chains the second part to the first keep it one lane.
function splitDeliverables(text: string): [string, string] | null {
  const whole = text.trim().replace(/[.!]+$/, "");
  if (/[.!?;,\n]/.test(whole) || CHAINED.test(whole)) return null;
  const parts = whole.split(/\s+and\s+/i);
  if (parts.length !== 2) return null;
  const left = parts[0]?.trim() ?? "";
  const right = parts[1]?.trim() ?? "";
  if (!isOwnClause(left, true) || !isOwnClause(right, false)) return null;
  return [left, right.charAt(0).toUpperCase() + right.slice(1)];
}

/** Same words as a suggestion, ignoring case, spacing and end punctuation: only then is the message the suggestion. */
function matchesSuggestion(text: string, suggestions: string[]): boolean {
  const plain = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?\s]+$/, "");
  const sent = plain(text);
  return suggestions.some(suggestion => plain(suggestion) === sent);
}

function calendarDay(at: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

/** What the forecast already counts beyond what is signed: the goal's own number, or the "likely" figure the page shows. */
function expectedOf(goal: NonNullable<TopicView["goal"]>): number {
  return goal.likely ?? goal.figures.find(figure => /likely|expected/i.test(figure.label))?.value ?? 0;
}

/** The date a goal is judged on: its deadline, else where the plan on its chart ends. */
function goalDate(goal: NonNullable<TopicView["goal"]>): string {
  if (goal.deadlineAt) return goal.deadlineAt;
  const end = new Date(Date.parse(goal.trajectory.start) + goal.trajectory.days * 86400000);
  return new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), 16)).toISOString();
}

/** The one place an item's state is computed: past its limit is breached, within a fifth of it is near, and a limit of 0 holds only at 0. */
function guardrailState(value: MeasuredValue, limit: MeasuredValue | null | undefined): "held" | "near" | "breached" {
  const reading = measuredNumber(value);
  const cap = measuredNumber(limit);
  if (reading === undefined || cap === undefined) return "held";
  if (reading > cap) return "breached";
  return cap > 0 && reading / cap >= 0.8 ? "near" : "held";
}

function eurosLabel(minor: number): string {
  const euros = minor / 100;
  if (!Number.isInteger(euros)) return `€${euros.toFixed(2)}`;
  return `€${String(euros).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function repairAgents(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (value instanceof Map) {
    for (const item of value.values()) repairAgents(item, seen);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) repairAgents(item, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "agent" && typeof record.name === "string" && record.name.includes(" ")) record.shortName = record.name;
  for (const child of Object.values(record)) repairAgents(child, seen);
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
  private readonly fixtureMessageIds = new Set<string>();
  private readonly reverted = new Map<string, Set<string>>();
  private readonly seen = new Map<string, string>();
  private readonly pinned = new Map<string, string[]>();
  private readonly preferences = new Map<string, Preferences>();
  private readonly layouts = new Map<string, SettingsView["layout"]>();
  private readonly sinceEdits = new Map<string, string[]>();
  private readonly reports = new Map<string, Report>();
  private readonly checks = new Map<string, SpotCheck>();
  private readonly records = new Map<string, MadeRecordView>();
  private readonly approvals = new Map<string, number>();
  private readonly forecasts = new Map<string, { topicId: string; row: Forecast }>();
  private readonly asked = new Map<string, { at: string; chat: string }>();
  private readonly approvedAt = new Map<string, string>();
  private approvalSerial = 0;
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
    this.prepareRecords();
    repairAgents(this);
    for (const thread of this.threads.values()) {
      for (const message of thread.messages) this.fixtureMessageIds.add(message.id);
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
      case "SkillsView": this.requireOwner(viewer); return this.skillsView();
      case "SettingsView": return { ...this.settings, decisionRights: this.decisionRights(viewer),
        ...this.prefsOf(viewer, query.get("deviceId")) };
      case "PullsView": this.requireOwner(viewer); return this.pullsView();
      case "ModelsView": return viewer.id === this.owner.id ? this.modelPicker : {
        items: this.modelPicker.items.map(({ id, name }) => ({ id, name, vendor: null, state: null })),
      };
      case "RecentView": return { items: (this.recent.get(viewer.id) ?? []).filter(item => this.recentTitle(item.target, viewer)) } satisfies RecentView;
      case "MadeRecordView": return requireRecord(this.madeRecord(key, viewer), "record");
      case "ReportView": return this.reportView(key, viewer);
      case "CheckView": return this.checkView(key, viewer);
      case "MembersView": this.requireOwner(viewer); return this.membersView();
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
      case "lane.file": return this.fileCommand(command, viewer);
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
      case "guardrail.set": return this.guardrail(command.name, command.on, viewer, command.id ?? null);
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
    // a goal change moves money, limits and ranks that are the owner's: no delegated right decides one
    if (decision.goalChange) return false;
    return this.fullTopic(decision.topicId, viewer) &&
      this.settings.decisionRights.some(right => right.rule === decision.rule && right.who === "agent" && right.personId === viewer.id);
  }

  /** A goal change as this reader may see it: the topics it reaches are the reader's own. */
  private goalChangeFor<T extends NonNullable<DecisionView["goalChange"]>>(change: T, viewer: Actor): T {
    return { ...change, affectedTopics: change.affectedTopics.filter(id => this.fullTopic(id, viewer)) };
  }

  /** The line under a decision: a proposed change's line names only topics the reader can read. */
  private decisionDetail<L extends string | null>(decision: DecisionView, viewer: Actor, line: L): L | string {
    if (!decision.goalChange || line !== this.goalChangeDetail(decision.goalChange)) return line;
    return this.goalChangeDetail(this.goalChangeFor(decision.goalChange, viewer));
  }

  /** The history action of a decision's latest approval or decline. */
  private decisionAction(decisionId: string): HistoryAction | undefined {
    return this.history.get(this.overnightAliases.get(`decision-${decisionId}`) ?? `decision-${decisionId}`);
  }

  private requireDecisionRight(decision: DecisionView, viewer: Actor): void {
    if (!this.hasDecisionRight(decision, viewer)) {
      throw new Problem("forbidden", "This decision belongs to the owner or the person named by its decision right.");
    }
  }

  private projectLane(lane: LaneView, viewer: Actor): LaneView {
    const decision = lane.decisionId ? this.decisions.get(lane.decisionId) : undefined;
    if (viewer.id !== this.owner.id) this.shareLaneCopy(lane);
    lane.leadName = labelFor(lane, viewer);
    if (decision && (decision.state === "approved" || decision.state === "declined")) {
      const actor = this.decisionAction(decision.id)?.row.actor ?? this.owner;
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
          if (lane.id === "tax-rates") {
            lane.steps = lane.steps.map(step => /your ok to run/i.test(step.text) ? { ...step, kind: "ok", doneAt: this.approvedAt.get(decision.id) ?? this.now } : step);
            const migration = lane.steps.findIndex(step => /migration runs/i.test(step.text));
            if (migration >= 0 && !lane.steps.some(step => /back up the production database/i.test(step.text))) {
              lane.steps.splice(migration, 0, { kind: "now", text: "Back up the production database", who: "Builder", doneAt: null });
            }
            const runsAt = lane.steps.findIndex(step => /migration runs/i.test(step.text));
            if (runsAt >= 0 && lane.steps[runsAt]?.kind === "now") lane.steps[runsAt] = { ...lane.steps[runsAt], kind: "todo" };
            lane.next = "The migration runs tonight at 23:00, after the backup";
            lane.nextAt = "2026-11-16T23:00:00+01:00";
          }
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
      id: d.id, title: d.title, state: d.state, topicName: d.topicName, target: target("decision", d.id), goalChange: d.goalChange && this.goalChangeFor(d.goalChange, viewer), proposer: d.proposer,
    }));
    return { items, total: items.length, open: items.filter(item => item.state === "open").length };
  }

  private decisionView(id: string, viewer: Actor): DecisionView {
    const decision = requireRecord(this.decisions.get(id), "decision");
    if (!this.fullTopic(decision.topicId, viewer)) throw new Problem("forbidden", "That decision is outside this reader’s access.");
    const queue = this.queue(viewer);
    const lane = decision.state === "approved" && decision.laneId ? this.lane(decision.laneId) : undefined;
    // A step is done when the decision's own OK is, or when the lane has the very same step done; nothing else moves.
    const nextSteps = decision.nextSteps.map(step => {
      if (decision.state === "approved" && /your ok|you approve/i.test(step.step)) return { ...step, state: "ok" as const, doneAt: this.approvedAt.get(id) ?? null };
      const same = lane?.steps.find(item => item.text.trim().toLowerCase() === step.step.trim().toLowerCase());
      if (!same) return step;
      const state = same.kind === "ok" || same.kind === "now" || same.kind === "todo" ? same.kind : step.state;
      return { ...step, state, doneAt: same.doneAt };
    });
    return { ...decision, goalChange: decision.goalChange && this.goalChangeFor(decision.goalChange, viewer),
      cardContext: this.decisionDetail(decision, viewer, decision.cardContext), context: this.decisionDetail(decision, viewer, decision.context),
      nextSteps, position: { index: queue.items.findIndex(item => item.id === id) + 1, of: queue.total, open: queue.open } };
  }

  private brief(viewer: Actor): BriefView {
    const prefs = this.prefsOf(viewer);
    const view = structuredClone(this.briefBase);
    view.decisions = [...this.decisions.values()].filter(d => this.fullTopic(d.topicId, viewer)).map(d => ({
      id: d.id, topicId: d.topicId, topicName: d.topicName, title: d.title, dueAt: d.dueAt, whyYours: d.whyYours ?? "",
      context: this.decisionDetail(d, viewer, d.cardContext), minutes: d.minutes, doneNote: d.doneNote, laneId: d.laneId, state: d.state, rule: d.rule, proposer: d.proposer,
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
    let capMinor = 0;
    let capCurrency = view.spend?.cap.currency ?? "EUR";
    view.topics = view.topics.filter(topic => this.fullTopic(topic.id, viewer)).map(item => {
      const topic = this.topicView(item.id, viewer, new URLSearchParams());
      if (viewer.id === this.owner.id && topic.spend) {
        capMinor += topic.spend.cap.amountMinor;
        capCurrency = topic.spend.cap.currency;
      }
      const original = this.topics.get(item.id)?.goal;
      const progress = topic.goal && original && topic.goal.target !== original.target
        ? `${topic.goal.signed} of ${topic.goal.target} ${topic.goal.unit}` : item.progress;
      return { ...item, progress, verdict: topic.goal?.verdict.word ?? topic.health?.word ?? item.verdict,
        state: topic.goal?.verdict.state ?? topic.health?.state ?? item.state };
    });
    if (viewer.id === this.owner.id && view.spend && capMinor > 0) view.spend.cap = { amountMinor: capMinor, currency: capCurrency };
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
    const publishedToday = this.briefTimes(prefs.briefsPerDay).filter(time => Date.parse(this.atTime(this.localDay(), time)) <= Date.parse(this.now)).length;
    view.edition = { used: publishedToday, of: prefs.briefsPerDay };
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

  private briefTimes(count: number): string[] {
    if (count <= 1) return ["07:15"];
    if (count === 2) return ["07:15", "16:00"];
    return ["07:15", "13:00", "18:00"];
  }

  private localDay(offset = 0): string {
    return new Date(Date.parse(this.now) + 3600000 + offset * 86400000).toISOString().slice(0, 10);
  }

  private atTime(day: string, time: string): string {
    return `${day}T${time}:00+01:00`;
  }

  private occurrence(time: string, which: "next" | "last"): string {
    const now = Date.parse(this.now);
    const today = Date.parse(this.atTime(this.localDay(), time));
    if (which === "next") return this.atTime(this.localDay(today > now ? 0 : 1), time);
    return this.atTime(this.localDay(today <= now ? 0 : -1), time);
  }

  private nextBrief(count: number): string {
    return this.briefTimes(count).map(time => this.occurrence(time, "next"))
      .reduce((best, at) => Date.parse(at) < Date.parse(best) ? at : best);
  }

  private schedules(): ManagerView["schedules"] {
    const kept = this.managerBase.schedules.filter(item => item.kind !== "brief");
    const present = new Set(kept.map(item => item.id));
    const opener = kept[0]?.opener ?? blankActor("Manager");
    const reports = [...this.reports.values()].flatMap(report => {
      const id = report.scheduleId ?? `${report.topicId}-report`;
      if (present.has(id)) return [];
      present.add(id);
      const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(report.dueAt));
      return [{
        id, kind: "report" as const, title: report.title, topicId: report.topicId, rrule: "FREQ=WEEKLY",
        text: "when the report is due", time, nextAt: report.dueAt, lastAt: null, lastLaneId: null,
        source: report.title, opener: report.writer, on: true,
      }];
    });
    const briefs = this.briefTimes(this.prefsOf(this.owner).briefsPerDay).map(time => ({
      id: `brief-${time.replace(":", "")}`, kind: "brief" as const, title: "Morning brief", topicId: null,
      rrule: "FREQ=DAILY", text: `at ${time}`, time, nextAt: this.occurrence(time, "next"),
      lastAt: this.occurrence(time, "last"), lastLaneId: null, source: "The brief", opener, on: true,
    }));
    return [...kept, ...reports, ...briefs];
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
    for (const decision of this.decisions.values()) {
      if (!decision.goalChange || (decision.state !== "open" && decision.state !== "approved")) continue;
      const written = this.asked.get(decision.id);
      asks.unshift({
        id: `ask-${decision.id}`, quote: decision.title, at: written?.at ?? decision.dueAt, chat: written?.chat ?? decision.topicName,
        went: decision.state === "open" ? "a goal change · waits for you in Decide" : "a goal change · approved",
        target: target("decision", decision.id),
      });
    }
    return {
      ...this.managerBase,
      schedules: this.schedules(),
      since: this.sinceLines(),
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
    const changes = this.approvedChanges().filter(change => change.topicId === id || change.affectedTopics.includes(id));
    view.appliedGoalChanges = [];
    if (this.fullTopic(id, viewer)) {
      view.appliedGoalChanges = changes.filter(change => change.topicId === id || this.fullTopic(change.topicId, viewer))
        .map(change => this.goalChangeFor(change, viewer));
    }
    if (view.goal) {
      const goal = view.goal;
      for (const change of changes) {
        if (change.topicId !== id) continue;
        if (change.field === "budget" && change.budget && view.spend) view.spend.cap = structuredClone(change.budget.to);
        else if (change.field === "guardrail" && change.guardrail) {
          this.applyGuardrailChange(goal, change.guardrail);
          if (change.guardrail.guardrailId === `${id}-agents-this-week` && change.guardrail.to.kind === "money" && view.spend) {
            view.spend.cap = { amountMinor: change.guardrail.to.money.amountMinor, currency: change.guardrail.to.money.currency };
          }
        }
        else if (change.field === "target" || change.field === "deadline" || change.field === "unit") this.projectGoalChange(goal, change);
      }
      if (view.meta) {
        const rank = this.priorityRanks().get(id);
        if (rank !== undefined) view.meta.priority = rank;
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
      }
      if (this.settlements.has("webinar") && id === "content") {
        goal.decision = null;
        goal.calm = "The promo is settled";
        this.setVerdict(goal, { state: "warn", word: "Behind plan", action: "Reminder Wednesday", text: null });
      }
      if (goal.guardrails && view.spend && view.spend.cap.amountMinor > 0) {
        const ratio = view.spend.spent.amountMinor / view.spend.cap.amountMinor;
        if (id !== "partnerships") goal.guardrails.items.push({
          what: "Agents this week",
          value: { kind: "money", money: view.spend.spent, cap: null },
          limit: { kind: "money", money: view.spend.cap, cap: null },
          ratio,
          state: "held",
          id: `${id}-agents-this-week`, switchId: null, action: null,
        });
      }
      this.alignGuardrails(id, goal, stored.goal);
      goal.forecastLog.push(...[...this.forecasts.values()].filter(item => item.topicId === id).map(item => structuredClone(item.row)));
      this.scoreForecast(goal);
    }
    const goal = view.goal;
    if (goal) {
      view.health = { state: goal.verdict.state, word: goal.verdict.word };
    } else {
      view.health = this.module === "dev" ? this.devHealth(id) : this.healthWithoutGoal(id);
    }
    const nextReportId = stored.meta?.nextReportId ?? null;
    // The report says when it is due; no goal's deadline moves it.
    const nextReportAt = (nextReportId ? this.reports.get(nextReportId)?.dueAt : undefined) ?? view.meta?.nextReportAt ?? null;
    if (view.meta) view.meta.nextReportAt = nextReportAt;
    view.status = { topicId: id, name: view.name, signed: goal?.signed ?? null, goal: goal?.target ?? null,
      unit: goal?.unit ?? null, health: view.health, nextReportAt, nextReportId };
    if (viewer.id !== this.owner.id) {
      const dash = role === "all" ? "You work on all of it" : role === "stages" ? `You run ${stages.join(", ")}` : "You see the status";
      view.meta = { askedBy: null, ownerLine: null, nextReportAt, nextReportId, priority: this.fullTopic(id, viewer) ? view.meta?.priority ?? null : null, parts: [`Shared by ${this.owner.name}`, dash] };
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
    this.hideClosedReports(view, viewer);
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
      return [{ label: day.label, entry: action ? { ...entry, actor: action.row.actor, at: action.row.at, undone: action.row.undone } : entry }];
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
    else if (id === "manager" && this.module === "gtm") view.since = { seen: view.since?.seen ?? { at: null }, lines: this.sinceLines() };
    const pin = view.pinned;
    const decision = pin?.decisionId ? this.decisions.get(pin.decisionId) : undefined;
    if (pin && decision && decision.state !== "open") {
      pin.state = decision.state;
      if (decision.state === "approved") {
        const lane = pin.laneId ? this.lane(pin.laneId) : undefined;
        const actor = this.decisionAction(decision.id)?.row.actor ?? this.owner;
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
    })).sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.id.localeCompare(right.id));
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
    if (who === "you") {
      setting.usedToday = null;
      setting.resetsAt = null;
    } else if (setting.dailyLimit != null) {
      setting.usedToday = setting.usedToday != null && setting.usedToday <= setting.dailyLimit ? setting.usedToday : 0;
      setting.resetsAt = setting.resetsAt ?? this.nextMidnight();
    }
    return done([{ type: "prefs.changed" }, { type: "decisionRight.changed" }]);
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

  private sinceLines(): string[] {
    const stored = this.threads.get("manager")?.since?.lines ?? [];
    const badTopics = new Set([...this.lanes.values()].flatMap(lane => {
      if (lane.state !== "bad" || !lane.topicId) return [];
      const name = this.topics.get(lane.topicId)?.name;
      return name ? [name.toLowerCase()] : [];
    }));
    const open = [...this.decisions.values()].filter(item => item.state === "open" && item.goalChange);
    const lines = stored.filter(line => {
      if (/stuck/i.test(line)) return [...badTopics].some(name => line.toLowerCase().includes(name));
      if (/no goal or priority changes wait for you/i.test(line)) return open.length === 0;
      return true;
    });
    for (const topic of this.topics.values()) {
      const thread = this.threads.get(`topic:${topic.id}`);
      if (!thread) continue;
      const fresh = thread.messages.filter(message => !this.fixtureMessageIds.has(message.id));
      const questions = fresh.filter(message => message.label?.kind === "question" || isQuestion(message.text)).length;
      const instructions = fresh.filter(message => message.label?.kind === "request" || message.label?.kind === "goalChange").length;
      if (!questions && !instructions) continue;
      const index = lines.findIndex(line => line.toLowerCase().startsWith(`${topic.name.toLowerCase()}:`) && /instruction|question/i.test(line));
      const bumped = this.activityLine(topic.name, index >= 0 ? lines[index] : undefined, instructions, questions);
      if (index >= 0 && bumped) lines[index] = bumped;
      else if (bumped) lines.unshift(bumped);
    }
    for (const item of open) {
      const field = item.goalChange?.field === "deadline" ? "deadline" : item.goalChange?.field === "priority" ? "priority" : "goal";
      const line = `${item.topicName}: a ${field} change waits for you.`;
      if (!lines.includes(line)) lines.push(line);
    }
    if (open.length === 0 && !lines.some(line => /no goal or priority changes wait for you/i.test(line))) {
      lines.push("No goal or priority changes wait for you.");
    }
    return lines;
  }

  private activityLine(name: string, existing: string | undefined, instructions: number, questions: number): string | undefined {
    if (!instructions && !questions) return existing;
    const instructionWord = (count: number) => `${count} instruction${count === 1 ? "" : "s"}`;
    const questionWord = (count: number) => `${count} question${count === 1 ? "" : "s"}`;
    if (!existing) {
      const parts = [
        instructions ? instructionWord(instructions) : "",
        questions ? `${questionWord(questions)} answered` : "",
      ].filter(Boolean);
      return `${name}: ${parts.join(", ")} in the topic.`;
    }
    let line = existing;
    if (instructions) line = line.replace(/(\d+)\s+instructions?/, (_match, count: string) => instructionWord(Number(count) + instructions));
    if (questions) line = line.replace(/(\d+)\s+questions?/, (_match, count: string) => questionWord(Number(count) + questions));
    return line;
  }

  private healthWithoutGoal(topicId: string): NonNullable<TopicView["health"]> {
    const lanes = this.allLanes(this.owner).filter(lane => lane.topicId === topicId && lane.state !== "done" && lane.state !== "parked" && lane.state !== "idle");
    if (lanes.some(lane => lane.state === "bad")) return { state: "bad", word: "Stuck" };
    if (lanes.length > 0) return { state: "ok", word: "On track" };
    return { state: "idle", word: "Idle" };
  }

  private devHealth(topicId: string): NonNullable<TopicView["health"]> {
    const lanes = this.allLanes(this.owner).filter(lane => lane.topicId === topicId && lane.state !== "done" && lane.state !== "parked" && lane.state !== "idle");
    const word = lanes.some(lane => lane.state === "bad") ? "Stuck"
      : lanes.some(lane => lane.state === "warn") ? "Needs you"
      : lanes.some(lane => lane.state === "ok" || lane.state === "new") ? "Working"
      : "Idle";
    const state = word === "Stuck" ? "bad" : word === "Needs you" ? "warn" : word === "Working" ? "ok" : "idle";
    return { state, word };
  }

  /** Every item of every topic with its state as the topic page shows it, keyed by topic and item. */
  private breachedItems(): Map<string, { topicId: string; name: string; guardrailId: string; state: string }> {
    const items = new Map<string, { topicId: string; name: string; guardrailId: string; state: string }>();
    for (const id of this.topics.keys()) {
      for (const item of this.topicView(id, this.owner, new URLSearchParams()).goal?.guardrails?.items ?? []) {
        if (item.id) items.set(`${id}:${item.id}`, { topicId: id, name: item.what, guardrailId: item.id, state: item.state });
      }
    }
    return items;
  }

  /** guardrail.breached for each item a command made breached, with the item's id. */
  private newlyBreached(before: ReturnType<World["breachedItems"]>): Event[] {
    const events: Event[] = [];
    for (const [key, item] of this.breachedItems()) {
      if (item.state === "breached" && before.get(key)?.state !== "breached") {
        events.push({ type: "guardrail.breached", topicId: item.topicId, name: item.name, guardrailId: item.guardrailId });
      }
    }
    return events;
  }

  private guardrailShort(item: NonNullable<NonNullable<TopicView["goal"]>["guardrails"]>["items"][number]): string {
    const reading = measuredNumber(item.value);
    const limit = measuredNumber(item.limit);
    if (item.value.kind === "money" && item.limit?.kind === "money" && reading != null && limit != null) {
      const subject = /cost per lead/i.test(item.what) ? "a lead costs" : `${item.what} is`;
      return `${subject} ${eurosLabel(reading)} against the ${eurosLabel(limit)} guardrail`;
    }
    if (reading != null && limit != null && item.limit?.kind === "rate") return `${item.what} is ${reading}% against the ${limit}% guardrail`;
    if (reading != null && limit != null) return `${item.what} is ${reading} against the ${limit} guardrail`;
    return `${item.what} is past its guardrail`;
  }

  private applyGuardrailChange(goal: NonNullable<TopicView["goal"]>, change: GuardrailChange): void {
    const item = goal.guardrails?.items.find(entry => entry.id === change.guardrailId);
    if (!item) return;
    item.limit = structuredClone(change.to);
  }

  private alignGuardrails(topicId: string, goal: NonNullable<TopicView["goal"]>, stored: TopicView["goal"]): void {
    const items = goal.guardrails?.items ?? [];
    const originals = new Map((stored?.guardrails?.items ?? []).filter(item => item.id).map(item => [item.id, item]));
    for (const item of items) {
      item.state = guardrailState(item.value, item.limit);
      const reading = measuredNumber(item.value);
      const limit = measuredNumber(item.limit);
      item.ratio = reading != null && limit != null && limit > 0 ? reading / limit : null;
      if (item.switchId) {
        const linked = this.skills.guardrails.find(entry => entry.id === item.switchId);
        if (linked) item.action = linked.action;
      }
    }
    const breached = new Set(items.filter(item => item.state === "breached" && item.id).map(item => item.id));
    goal.blockers = goal.blockers.filter(blocker => !blocker.guardrailId || breached.has(blocker.guardrailId));
    for (const item of items) {
      if (!item.id || item.state !== "breached") continue;
      const short = this.guardrailShort(item);
      const blocker = goal.blockers.find(entry => entry.guardrailId === item.id);
      if (blocker) blocker.short = short;
      else goal.blockers.push({
        guardrailId: item.id, laneId: null, short, state: "bad", what: item.what, who: "You", why: null,
        target: { kind: "topic", id: topicId },
      });
    }
    if (!goal.gap) return;
    for (const item of items) {
      const original = item.id ? originals.get(item.id) : undefined;
      if (!original || original.limit?.kind !== "money" || item.limit?.kind !== "money") continue;
      const from = eurosLabel(original.limit.money.amountMinor);
      const to = eurosLabel(item.limit.money.amountMinor);
      if (from === to) continue;
      goal.gap.says = goal.gap.says.replaceAll(from, to);
      goal.gap.steps = goal.gap.steps.map(step => step.replaceAll(from, to));
    }
  }

  private setVerdict(goal: NonNullable<TopicView["goal"]>, patch: NonNullable<TopicView["goal"]>["verdict"]): void {
    goal.verdict = { ...goal.verdict, ...patch };
  }

  private verdictWord(topicId: string): string | undefined {
    return this.topicView(topicId, this.owner, new URLSearchParams()).goal?.verdict.word;
  }

  /** A verdict that moved because of an approval or an act gets its forecast once, at that moment; Undo takes it back. */
  private noteForecast(source: string, topicId: string, before: string | undefined): void {
    const goal = this.topicView(topicId, this.owner, new URLSearchParams()).goal;
    if (!goal || goal.verdict.word === before) return;
    this.forecasts.set(source, { topicId, row: {
      id: source, word: goal.verdict.word, givenAt: this.now, outcome: "",
      value: { kind: "count", value: goal.signed + expectedOf(goal), of: goal.target, unit: goal.unit },
      low: null, high: null, scoreAt: goalDate(goal), actual: null, scoredAt: null, held: null,
    } });
  }

  private scoreForecast(goal: NonNullable<TopicView["goal"]>): void {
    const scored = goal.forecastLog.filter(row => row.scoredAt);
    if (scored.length > 0) {
      goal.calibrationScore = { kind: "count", value: scored.filter(row => row.held).length, of: scored.length, unit: "held" };
    }
    const next = goal.forecastLog.find(row => !row.scoredAt && row.scoreAt);
    if (next?.scoreAt) goal.nextScoreAt = next.scoreAt;
  }

  private priorityRanks(): Map<string, number> {
    const ids = this.sidebarBase.groups.map(group => group.id).filter(id => this.topics.get(id)?.meta);
    const ranks = new Map<string, number>();
    ids.forEach((id, index) => ranks.set(id, this.topics.get(id)?.meta?.priority ?? index + 1));
    for (const change of this.approvedChanges()) {
      if (change.field === "priority" && change.priority?.to != null) this.shiftRank(ranks, change.topicId, change.priority.to);
    }
    return ranks;
  }

  /** Approved goal changes, in the order they were approved: the last approval counts. */
  private approvedChanges(): NonNullable<DecisionView["goalChange"]>[] {
    return [...this.decisions.values()].flatMap(decision => decision.state === "approved" && decision.goalChange ? [decision] : [])
      .sort((left, right) => (this.approvals.get(left.id) ?? 0) - (this.approvals.get(right.id) ?? 0))
      .flatMap(decision => decision.goalChange ? [decision.goalChange] : []);
  }

  private shiftRank(ranks: Map<string, number>, topicId: string, to: number): void {
    const from = ranks.get(topicId);
    if (from === undefined || from === to) return;
    for (const [id, rank] of ranks) {
      if (id === topicId) continue;
      if (to < from && rank >= to && rank < from) ranks.set(id, rank + 1);
      if (to > from && rank <= to && rank > from) ranks.set(id, rank - 1);
    }
    ranks.set(topicId, to);
  }

  private syncBusy(): void {
    if (this.module !== "dev") return;
    const server = this.skills.connections.find(item => item.id === "your-server");
    if (server?.capacity?.kind !== "count" || server.capacity.of == null) return;
    const busy = [...this.lanes.keys()].filter(id => {
      const lane = this.lane(id);
      return lane && (lane.state === "ok" || lane.state === "bad" || lane.state === "new");
    }).length;
    server.capacity = { ...server.capacity, value: Math.min(server.capacity.of, busy) };
  }

  private busyValue(): number | null {
    if (this.module !== "dev") return null;
    this.syncBusy();
    const server = this.skills.connections.find(item => item.id === "your-server");
    return server?.capacity?.kind === "count" ? server.capacity.value : null;
  }

  private skillsView(): SkillsView {
    this.syncBusy();
    const view = structuredClone(this.skills);
    for (const sw of view.guardrails) {
      if (!sw.id) continue;
      const next = this.appliedSwitchLimit(sw.id);
      if (!next || !sw.limit || next.kind !== sw.limit.kind) continue;
      const previous = measuredNumber(sw.limit);
      const amount = measuredNumber(next);
      if (sw.detail && previous != null && amount != null && previous !== amount) {
        sw.detail = sw.limit.kind === "money"
          ? sw.detail.replaceAll(eurosLabel(previous), eurosLabel(amount))
          : sw.detail.replace(new RegExp(`\\b${previous}\\b(?!%)`, "g"), String(amount));
      }
      sw.limit = structuredClone(next);
    }
    for (const sw of view.guardrails) sw.detail = this.switchRates(sw.id, sw.detail);
    return view;
  }

  private storedGuardrail(id: string) {
    for (const topic of this.topics.values()) {
      const item = topic.goal?.guardrails?.items.find(entry => entry.id === id);
      if (item) return item;
    }
    return undefined;
  }

  /** A percentage a switch states beside its limit ("pause at 4% bounces") follows the linked guardrail it names. */
  private switchRates(switchId: string | null, detail: string): string {
    let text = detail;
    for (const change of this.approvedChanges()) {
      const item = change.guardrail ? this.storedGuardrail(change.guardrail.guardrailId) : undefined;
      if (!change.guardrail || !item || item.switchId !== switchId || change.guardrail.to.kind !== "rate") continue;
      text = text.replace(new RegExp(`\\d+(?:\\.\\d+)?(?=% ${item.what.toLowerCase()}\\b)`, "g"), String(change.guardrail.to.percent));
    }
    return text;
  }

  /** The switch's limit after the approved limits a switch states: only the number changes, the shape stays. */
  private appliedSwitchLimit(switchId: string): MeasuredValue | null {
    const sw = this.skills.guardrails.find(item => item.id === switchId);
    if (!sw?.limit) return null;
    const origin = measuredNumber(sw.limit);
    let chosen: MeasuredValue | null = null;
    for (const change of this.approvedChanges()) {
      if (!change.guardrail) continue;
      const item = this.storedGuardrail(change.guardrail.guardrailId);
      if (!item || item.switchId !== switchId || measuredNumber(item.limit) !== origin || change.guardrail.to.kind !== sw.limit.kind) continue;
      const to = change.guardrail.to;
      if (sw.limit.kind === "count" && to.kind === "count") chosen = { ...sw.limit, value: to.value, of: to.value };
      else if (sw.limit.kind === "money" && to.kind === "money") chosen = { ...sw.limit, money: { ...sw.limit.money, amountMinor: to.money.amountMinor } };
      else if (sw.limit.kind === "rate" && to.kind === "rate") chosen = { ...sw.limit, percent: to.percent };
    }
    return chosen;
  }

  private decisionRights(viewer: Actor): SettingsView["decisionRights"] {
    if (viewer.id !== this.owner.id) return [];
    const today = calendarDay(this.now);
    return this.settings.decisionRights.map(right => ({
      ...right,
      usedToday: right.who === "you" ? null : this.briefBase.overnight.filter(row => row.rule === right.rule && calendarDay(row.at) === today).length,
      resetsAt: right.who === "you" ? null : this.nextMidnight(),
    }));
  }

  private canReadReport(id: string, viewer: Actor): boolean {
    const report = this.reports.get(id);
    if (!report) return false;
    if (viewer.id === this.owner.id) return true;
    return report.recipients.some(person => person.id === viewer.id) && this.role(report.topicId, viewer) !== "none";
  }

  private hideClosedReports(value: unknown, viewer: Actor, seen = new Set<object>()): void {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) this.hideClosedReports(item, viewer, seen);
      return;
    }
    const record = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      if (/reportId$/i.test(key) && typeof child === "string" && !this.canReadReport(child, viewer)) record[key] = null;
      else this.hideClosedReports(child, viewer, seen);
    }
  }

  private nextMidnight(): string {
    const localDay = new Date(Date.parse(this.now) + 3600000).toISOString().slice(0, 10);
    const midnight = Date.parse(`${localDay}T00:00:00+01:00`);
    const next = Date.parse(this.now) < midnight ? midnight : midnight + 86400000;
    return `${new Date(next + 3600000).toISOString().slice(0, 19)}+01:00`;
  }

  private membersView(): MembersView {
    const invitations = [...new Map([...this.access.values()].flatMap(view => view.invitations).map(item => [item.id, item])).values()];
    const items = [...this.people.values()].filter(person => person.kind === "person").map(person => {
      const invitation = invitations.find(item => item.personId === person.id);
      return {
      person, email: [...this.access.values()].flatMap(view => view.people).find(entry => entry.person.id === person.id)?.email ?? null,
      role: person.role, owner: person.id === this.owner.id, invitedAt: invitation?.invitedAt ?? null,
      joinedAt: invitation ? invitation.acceptedAt : person.membershipState === "invited" ? null : "2026-10-01T09:00:00+02:00",
      access: [...this.access.keys()].map(topicId => ({
        topicId, access: this.access.get(topicId)?.people.find(entry => entry.person.id === person.id)?.access.kind ?? "none" as const,
      })),
    };
    });
    return { items, invitations };
  }

  private reportView(id: string, viewer: Actor): Report {
    requireRecord(this.reports.get(id), "report");
    if (!this.canReadReport(id, viewer)) throw new Problem("forbidden", "This report is not shared with this reader.");
    const report = requireRecord(this.reports.get(id), "report");
    return report;
  }

  private checkView(id: string, viewer: Actor): SpotCheck {
    const check = requireRecord(this.checks.get(id), "check");
    if (viewer.id !== this.owner.id && !this.fullTopic(check.topicId, viewer)) {
      throw new Problem("forbidden", "This check is outside this reader’s access.");
    }
    return check;
  }

  private prepareRecords(): void {
    for (const lane of this.lanes.values()) {
      for (const item of lane.made) {
        const kind = item.target?.kind;
        const id = item.target?.id;
        if (!id || (kind !== "file" && kind !== "run" && kind !== "review") || this.records.has(id)) continue;
        this.records.set(id, {
          id, kind, laneId: lane.id, title: item.title, detail: item.detail,
          url: kind === "file" ? `https://files.example.test/${id}` : null,
          trigger: kind === "run" ? "staging" : null, startedAt: kind === "run" ? lane.openedAt : null,
          finishedAt: null, state: kind === "run" ? "pass" : null, checks: [], log: null, pullId: null,
        });
      }
    }
    const stuck = this.topics.get("web")?.stuck;
    const runId = stuck?.runId;
    if (stuck && runId && stuck.log) {
      this.records.set(runId, {
        id: runId, kind: "run", laneId: stuck.actions.find(action => action.target?.kind === "run")?.laneId ?? "red-main",
        title: "Nightly checks", detail: stuck.detail, url: `https://files.example.test/runs/${runId}`,
        trigger: "nightly", startedAt: "2026-11-16T03:20:00+01:00", finishedAt: "2026-11-16T06:40:00+01:00",
        state: "fail", checks: stuck.checks, log: stuck.log, pullId: null,
      });
    }
    const reporter = this.topics.get("partnerships")?.crew.find(actor => actor.id === "reporter");
    const tom = this.people.get("tom-ahrens");
    if (reporter && tom) {
      this.reports.set("partnerships-weekly", {
        id: "partnerships-weekly", topicId: "partnerships", title: "Weekly partner report", recipients: [tom], writer: reporter,
        scheduleId: "partnerships-report", dueAt: "2026-11-20T08:00:00+01:00", state: "scheduled", draftId: null,
        sentAt: null, checkedBy: null, periodFrom: "2026-11-09T00:00:00+01:00", periodTo: "2026-11-15T23:59:00+01:00",
      });
      for (const [id, topicId, title] of [
        ["content-weekly", "content", "Weekly content report"],
        ["outbound-weekly", "outbound", "Weekly outbound report"],
        ["paid-weekly", "paid", "Weekly paid report"],
        ["seo-weekly", "seo", "Weekly SEO report"],
      ] as const) {
        const topic = this.topics.get(topicId);
        const dueAt = topic?.meta?.nextReportAt;
        const writer = topic?.crew.find(actor => actor.kind === "agent") ?? reporter;
        if (!topic?.meta || !dueAt) continue;
        topic.meta.nextReportId = topic.meta.nextReportId ?? id;
        this.reports.set(id, {
          id, topicId, title, recipients: [this.owner], writer, scheduleId: `${topicId}-report`, dueAt, state: "scheduled", draftId: null,
          sentAt: null, checkedBy: null, periodFrom: "2026-11-09T00:00:00+01:00", periodTo: "2026-11-15T23:59:00+01:00",
        });
      }
    }
    const lea = this.people.get("lea-brandt");
    const checker = [...this.topics.values()].flatMap(topic => topic.crew).find(actor => actor.id === "manager") ?? blankActor("Manager");
    if (lea) {
      this.checks.set("batch-3", {
        id: "batch-3", kind: "random", topicId: "partnerships", laneId: "brand-list", scheduleId: null,
        checker, subject: lea, at: "2026-11-16T07:20:00+01:00", rule: "the batch matches the partner profile",
        sample: { kind: "count", value: 5, of: 40, unit: "brands" }, outcome: "held", passed: 5, failed: 0,
        text: "spot-checked 5 brands of Lea's batch 3 at random: all 5 fit the profile", followUpLaneId: null,
      });
      const reply = this.lanes.get("reply-handling");
      this.checks.set("friday-reply", {
        id: "friday-reply", kind: "periodic", topicId: "outbound", laneId: "reply-handling", scheduleId: "friday-check",
        checker, subject: reply?.lead ?? lea, at: "2026-11-13T09:00:00+01:00", rule: "no yes waited more than a day",
        sample: { kind: "count", value: 8, of: 8, unit: "replies" }, outcome: "held", passed: 8, failed: 0,
        text: "Friday check of reply handling: no yes waited more than a day", followUpLaneId: null,
      });
    }
  }

  private madeRecord(id: string, viewer: Actor): MadeRecordView | undefined {
    const built = this.records.get(id);
    if (built) {
      const lane = this.lanes.get(built.laneId);
      if (!lane || this.removed.has(lane.id)) return undefined;
      if (!this.sharedLane(lane, viewer)) throw new Problem("forbidden", "This record is outside this reader’s lanes.");
      // what the lane shows this reader: its title and detail, in the reader's words
      const item = this.visibleLane(lane.id, viewer).made.find(made => made.target?.id === id);
      return item ? { ...built, title: item.title, detail: item.detail } : built;
    }
    let hidden = false;
    for (const lane of this.lanes.values()) {
      const kind = lane.made.find(item => item.target?.id === id &&
        (item.target.kind === "run" || item.target.kind === "review"))?.target?.kind;
      if (!kind || this.removed.has(lane.id)) continue;
      if (!this.sharedLane(lane, viewer)) {
        hidden = true;
        continue;
      }
      const item = this.visibleLane(lane.id, viewer).made.find(made => made.target?.id === id && made.target.kind === kind);
      if (item) return {
        id, kind, laneId: lane.id, title: item.title, detail: item.detail, url: null, trigger: null, startedAt: null,
        finishedAt: null, state: null, checks: [], log: null, pullId: null,
      };
    }
    if (hidden) throw new Problem("forbidden", "This record is outside this reader’s lanes.");
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
      case "review":
      case "file": {
        const record = this.madeRecord(id, viewer);
        return record?.kind === page.kind ? record.title : undefined;
      }
      case "report": return this.canReadReport(id, viewer) ? this.reports.get(id)?.title : undefined;
      case "check": {
        const check = this.checks.get(id);
        return check && (viewer.id === this.owner.id || this.fullTopic(check.topicId, viewer)) ? check.text : undefined;
      }
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

  /** A member named by their short name, one part of the name, or any two parts in any order ("Brandt, Lea"; "lea b"). */
  private knownByFirstName(people: AccessView["people"], lookup: string): AccessView["people"][number] | undefined {
    const parts = lookup.split(/[\s,]+/).filter(Boolean);
    const matches = people.filter(entry => {
      const name = entry.person.name.toLowerCase();
      if (entry.person.shortName.toLowerCase() === lookup || name === lookup || name.split(/\s+/).includes(lookup)) return true;
      const own = name.split(/[\s,]+/).filter(Boolean);
      const used = new Set<number>();
      return parts.length >= 2 && parts.every(part => {
        const bare = part.replace(/\.$/, "");
        const at = own.findIndex((word, index) => !used.has(index) && (word === bare || (bare.length === 1 && word.startsWith(bare))));
        if (at < 0) return false;
        used.add(at);
        return true;
      });
    });
    return matches.length === 1 ? matches[0] : undefined;
  }

  private invite(id: string, nameOrEmail: string, viewer: Actor): Effect {
    this.requireOwner(viewer);
    const access = requireRecord(this.access.get(id), "topic");
    const name = nameOrEmail.trim();
    if (!name) throw new Problem("badRequest", "Enter a name or email address.");
    const lookup = name.toLowerCase();
    const people = [...new Map([...this.access.values()].flatMap(record => record.people).map(entry => [entry.person.id, entry])).values()];
    const known = people.find(entry => entry.person.name.toLowerCase() === lookup || entry.email?.toLowerCase() === lookup)
      ?? this.knownByFirstName(people, lookup);
    if (known) {
      const current = this.accessEntry(id, known.person);
      const message = this.message(blankActor("Manager"), `${known.person.name} is already in Tidewell; set what they see.`, null);
      if (current && current.access.kind !== "none") return done([{ type: "access.changed", topicId: id, personId: known.person.id }], null, message);
      return done([], null, message);
    }
    const duplicate = access.invitations.find(item => item.nameOrEmail.toLowerCase() === lookup);
    if (duplicate) return done([{ type: "access.changed", topicId: id, personId: duplicate.personId }]);
    const invitationId = `invite-${++this.serial}`;
    const person = { ...blankActor(name.includes("@") ? name.split("@")[0] ?? name : name, "person"),
      id: invitationId, membershipState: "invited" as const };
    this.people.set(person.id, person);
    this.setAccess(id, person.id, "view", [], viewer);
    const email = name.includes("@") ? lookup : null;
    for (const record of this.access.values()) {
      const entry = record.people.find(item => item.person.id === person.id);
      if (entry) { if (email) entry.email = email; continue; }
      record.people.push({ person, access: { kind: "none", stages: [] }, owner: false, scope: "", otherTopics: [], email });
    }
    if (person.membershipState === "invited") {
      access.invitations.push({ id: invitationId, personId: person.id, nameOrEmail: name, state: "pending", invitedAt: this.now, acceptedAt: null, topicId: id, invitedBy: this.owner });
    }
    return done([{ type: "access.changed", topicId: id, personId: person.id }, { type: "topic.changed", topicId: id }, { type: "members.changed", personId: person.id }]);
  }

  private acceptInvitation(id: string, viewer: Actor): Effect {
    const records = [...this.access.values()];
    const invitation = requireRecord(records.flatMap(view => view.invitations).find(item => item.id === id), "invitation");
    if (invitation.personId !== viewer.id) throw new Problem("forbidden", "This invitation belongs to another reader.");
    if (invitation.state === "accepted") return done();
    viewer.membershipState = "active";
    const events: Event[] = [];
    for (const access of records.filter(view => view.people.some(entry => entry.person.id === viewer.id && entry.access.kind !== "none"))) {
      for (const item of access.invitations.filter(item => item.personId === viewer.id)) {
        item.state = "accepted";
        item.acceptedAt = this.now;
      }
      events.push({ type: "access.changed", topicId: access.topicId, personId: viewer.id }, { type: "topic.changed", topicId: access.topicId });
    }
    events.push({ type: "members.changed", personId: viewer.id });
    return done(events);
  }

  private revoke(id: string, viewer: Actor): Effect {
    this.requireOwner(viewer);
    for (const [topicId, access] of this.access) {
      const invitation = byId(access.invitations, id);
      if (!invitation) continue;
      const person = this.people.get(invitation.personId);
      const pending = person?.membershipState === "invited";
      const stages = this.topics.get(topicId)?.stages ?? [];
      for (const view of this.access.values()) {
        view.invitations = view.invitations.filter(item => item.id !== id);
        if (pending) view.people = view.people.filter(entry => entry.person.id !== invitation.personId);
      }
      for (const stage of stages) if (stage.runBy?.id === invitation.personId) stage.runBy = null;
      if (pending) this.people.delete(invitation.personId);
      return done([{ type: "access.changed", topicId, personId: invitation.personId }, { type: "topic.changed", topicId },
        { type: "members.changed", personId: invitation.personId }]);
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
    const alias = this.overnightAliases.get(id) ?? id;
    const overnightRow = this.briefBase.overnight.find(row => row.id === id || row.id === alias);
    if (undone && overnightRow) {
      if (viewer.id !== this.owner.id) this.requireOwner(viewer);
      if (overnightRow.outcome?.sentOutside) throw new Problem("conflict", "An action sent outside the workspace cannot be undone.");
      if (overnightRow.undoUntilAt && Date.parse(overnightRow.undoUntilAt) <= Date.parse(this.now)) {
        throw new Problem("conflict", "The undo window for this action has passed.");
      }
    }
    const action = requireRecord(this.history.get(alias), "action");
    action.authorize(viewer);
    if (action.row.undone === undone) return done();
    if (undone) {
      const overnight = byId(this.briefBase.overnight, action.row.id);
      if (overnight?.outcome?.sentOutside) throw new Problem("conflict", "An action sent outside the workspace cannot be undone.");
      if (overnight?.undoUntilAt && Date.parse(overnight.undoUntilAt) <= Date.parse(this.now)) {
        throw new Problem("conflict", "The undo window for this action has passed.");
      }
    }
    const overnight = byId(this.briefBase.overnight, action.row.id);
    const actions = [...this.history.values()].filter(item => item.record === action.record || overnight?.relatedLaneIds?.includes(item.record));
    const later = actions.slice(actions.indexOf(action) + 1);
    if (later.some(item => !item.row.undone)) throw new Problem("conflict", "Undo the newer change to this record first.");
    const events = action.apply(undone);
    action.row.undone = undone;
    return done([...events, { type: "agentAction.changed", actionId: action.row.id }], action.row.laneId);
  }

  /** Where an ask would be filed, and whether this reader may file it there; nothing is written. */
  private filingPlace(text: string, viewer: Actor, options: FileOptions) {
    const route = options.route === false ? null : routePreview(text, options.topicId ?? null, this.topics, this.routes);
    const topicId = options.topicId ?? route?.topicId ?? null;
    const topic = topicId ? requireRecord(this.topics.get(topicId), "topic") : undefined;
    if (topic) this.writableTopic(topic.id, viewer);
    else this.requireOwner(viewer);
    const proposedLead = options.leadId && topic ? requireRecord(byId(topic.crew, options.leadId), "lead") : null;
    return { route, topicId, topic, proposedLead };
  }

  private file(text: string, viewer: Actor, options: FileOptions): FileResult {
    const model = this.model(options.model);
    const { topicId, topic, proposedLead } = this.filingPlace(text, viewer, options);
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
      const busyBefore = this.busyValue();
      if (undone) this.removed.add(id);
      else this.removed.delete(id);
      const events: Event[] = [undone ? { type: "lane.removed", laneId: id } : { ...filed, topicId: lane.topicId }];
      if (lane.topicId) events.push({ type: "topic.changed", topicId: lane.topicId });
      if (this.draftsFor(viewer).items.some(draft => draft.laneId === id)) events.push({ type: "drafts.changed" });
      const busyAfter = this.busyValue();
      if (busyBefore !== null && busyAfter !== null && busyBefore !== busyAfter) events.push({ type: "skills.changed" });
      return events;
    }, id, `file-${id}`, this.now, reader => {
      if (!topicId) this.requireOwner(reader);
      else this.writableTopic(topicId, reader);
      options.authorize?.(reader);
      if (reader.id !== viewer.id && this.draftsFor(viewer).items.some(draft => draft.laneId === id)) {
        this.requireOwner(reader);
      }
    });
    const events: Event[] = [filed];
    if (this.module === "dev") {
      this.syncBusy();
      events.push({ type: "skills.changed" });
    }
    return { lane, receipt, message, events };
  }

  /** An ask as one act: split into parts with an object each, every part's rights checked first, then all parts filed or none. */
  private fileAsk(text: string, viewer: Actor, options: FileOptions): FileResult {
    const parts = splitDeliverables(text);
    if (!parts) return this.file(text, viewer, options);
    this.model(options.model);
    for (const part of parts) this.filingPlace(part, viewer, options);
    const groupId = `group-${++this.serial}`;
    const filed = parts.map(part => this.file(part, viewer, options));
    for (const item of filed) item.receipt.text = text;
    const ids = filed.map(item => item.lane.id);
    for (const item of filed) {
      item.lane.groupId = groupId;
      for (const event of item.events) if (event.type === "lane.filed") event.groupId = groupId;
    }
    const first = requireRecord(filed[0], "lane");
    const members = ids.map(id => requireRecord(this.history.get(`file-${id}`), "action"));
    const record = this.remember(null, `file-${groupId}`, text, viewer, undone => {
      const events = members.flatMap(member => {
        const changed = member.apply(undone);
        member.row.undone = undone;
        return changed;
      });
      return events;
    }, first.lane.id, `file-${groupId}`, this.now, reader => { for (const member of members) member.authorize(reader); });
    const receipt = { ...first.receipt, actionId: record.row.id, laneId: first.lane.id, groupLaneIds: ids };
    return { lane: first.lane, receipt, message: first.message, events: filed.flatMap(item => item.events) };
  }

  private fileCommand(command: Extract<Command, { type: "lane.file" }>, viewer: Actor): Effect {
    const options: FileOptions = {
      topicId: command.toManager ? null : command.topicId ?? null, leadId: command.leadId ?? null,
      attachment: command.attachment ?? null, model: command.model ?? null, route: !command.toManager,
    };
    const filed = this.fileAsk(command.text, viewer, options);
    return done(filed.events, filed.lane.id, filed.message, filed.receipt);
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
      const next = "Sent from your mail, 20 a day";
      const resource = this.managerBase.sharedResources.find(item => item.laneIds.includes(id) && item.quota);
      const priorQuota = resource?.quota ? structuredClone(resource.quota) : null;
      const priorTurn = resource?.turn ?? null;
      const sentSteps = base.steps.map(step => {
        if (/lea checks/i.test(step.text)) return { ...step, kind: "ok" as const, doneAt: this.now };
        if (/20 a day/i.test(step.text)) return { ...step, kind: "now" as const };
        return step;
      });
      const sentQuota = priorQuota?.kind === "count"
        ? { ...priorQuota, value: Math.min(priorQuota.of ?? priorQuota.value + 20, priorQuota.value + 20) }
        : priorQuota;
      const prior = {
        waitsFor: base.waitsFor, state: base.state, stateWord: base.stateWord, status: base.status,
        standing: base.standing, acts: base.acts, next: base.next, steps: structuredClone(base.steps),
      };
      const apply = (undone: boolean): Event[] => {
        Object.assign(base, undone ? prior : {
          waitsFor: null, state: "ok", stateWord: "Working", status, next,
          standing: { headline: "Wave 2 is scheduled.", detail: status }, acts: [], steps: sentSteps,
        });
        if (resource) {
          resource.turn = undone ? priorTurn : id;
          resource.quota = undone ? priorQuota : sentQuota;
        }
        return [...laneUpdate(id, base.topicId), { type: "thread.changed", threadId: "topic:partnerships" }, { type: "brief.changed" },
          ...(resource?.id ? [{ type: "resource.changed" as const, resourceId: resource.id }] : [])];
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
    const previous = { state: base.state, stateWord: base.stateWord, status: base.status, next: base.next, nextAt: base.nextAt, standing: base.standing, steps: base.steps, acts: base.acts, tries: structuredClone(base.tries) };
    const raised = base.tries?.kind === "count" ? { ...base.tries, of: (base.tries.of ?? base.tries.value) + 1 } : base.tries;
    const next = {
      state: "ok" as const, stateWord: "Working", status, next: status, standing: { headline: "Working again.", detail: status },
      steps: base.steps.map(step => step.kind === "now" ? { ...step, text: status } : step), acts: [] as LaneAct[],
      tries: action.id === "allow-one-more-try" ? raised : base.tries,
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
      const wordBefore = this.verdictWord(topicId);
      if (undone) this.settlements.delete(lane.id);
      else this.settlements.set(lane.id, settlement);
      if (undone) this.forecasts.delete(`forecast-settled-${lane.id}`);
      Object.assign(base, undone ? previous : {
        state: "ok", stateWord: "Working", status: values.status, next: "Promo scheduled",
        nextAt: this.briefBase.burns.find(burn => burn.laneId === lane.id)?.dueAt ?? null, acts: [],
        standing: { headline: "The promo is settled.", detail: values.status },
        steps: previous.steps.map(step => step.kind === "now" ? { kind: "ok", text: values.step, who: "You · now", doneAt: null } : step),
      });
      if (!undone) this.noteForecast(`forecast-settled-${lane.id}`, topicId, wordBefore);
      return [...laneUpdate(lane.id, topicId), { type: "thread.changed", threadId: `topic:${topicId}` },
        { type: "thread.changed", threadId: "manager" }, { type: "brief.changed" }];
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

  private topicFingerprints(): Map<string, string> {
    const out = new Map<string, string>();
    for (const person of this.people.values()) {
      for (const id of this.topics.keys()) {
        if (this.role(id, person) === "none") continue;
        out.set(`${person.id}:${id}`, JSON.stringify(this.topicView(id, person, new URLSearchParams())));
      }
    }
    return out;
  }

  private changedTopicIds(before: Map<string, string>): string[] {
    const ids = new Set<string>();
    for (const person of this.people.values()) {
      for (const id of this.topics.keys()) {
        if (this.role(id, person) === "none") continue;
        const after = JSON.stringify(this.topicView(id, person, new URLSearchParams()));
        if (before.get(`${person.id}:${id}`) !== after) ids.add(id);
      }
    }
    return [...ids];
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
    const fixture = state === "approved" ? this.fixtureDecisionRow(decision.topicId, id) : undefined;
    const actionId = fixture?.id ?? `decision-${id}`;
    if (state === "open") {
      if (decision.release?.stage === "done") throw new Problem("conflict", "The rollout has already finished.");
      return this.undo(`decision-${id}`, true, viewer);
    }
    const pull = this.pulls.items.find(item => item.decisionId === id);
    if (state === "approved" && pull?.held) throw new Problem("conflict", "The pull request is held.");
    const initialPullState = pull?.state;
    const apply = (undone: boolean): Event[] => {
      if (decision.release?.stage === "done") throw new Problem("conflict", "The rollout has already finished.");
      if (pull?.held) throw new Problem("conflict", "Undo the pull request hold first.");
      if (decision.state !== (undone ? state : "open")) throw new Problem("conflict", "The decision has changed.");
      const before = this.topicFingerprints();
      const busyBefore = this.busyValue();
      const switchesBefore = JSON.stringify(this.skillsView().guardrails);
      const breachedBefore = this.breachedItems();
      const wordBefore = decision.goalChange ? this.verdictWord(decision.topicId) : undefined;
      decision.state = undone ? "open" : state;
      if (decision.state === "approved") this.approvedAt.set(id, this.now);
      else this.approvedAt.delete(id);
      if (decision.goalChange) {
        if (decision.state === "approved") this.approvals.set(id, ++this.approvalSerial);
        else this.approvals.delete(id);
        if (decision.state === "approved") this.noteForecast(`forecast-${id}`, decision.topicId, wordBefore);
        else this.forecasts.delete(`forecast-${id}`);
      }
      const events = this.decisionEvents(decision);
      if (decision.goalChange) events.push({ type: "thread.changed", threadId: "manager" });
      for (const topicId of this.changedTopicIds(before)) {
        if (!events.some(event => event.type === "topic.changed" && event.topicId === topicId)) events.push({ type: "topic.changed", topicId });
      }
      const busyAfter = this.busyValue();
      if (busyBefore !== null && busyAfter !== null && busyBefore !== busyAfter) events.push({ type: "skills.changed" });
      if (JSON.stringify(this.skillsView().guardrails) !== switchesBefore && !events.some(event => event.type === "skills.changed")) events.push({ type: "skills.changed" });
      events.push(...this.newlyBreached(breachedBefore));
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
    const record = this.remember(decision.topicId, actionId, fixture?.text ?? `${state === "approved" ? "Approved" : "Declined"}: ${decision.title}`, viewer,
      apply, decision.laneId ?? fixture?.laneId ?? null, actionId, this.now, reader => this.requireDecisionRight(decision, reader));
    record.row.decision = true;
    record.row.decisionId = id;
    // The alias belongs to this act only: a decline after an approval is undone as itself.
    const aliased = this.overnightAliases.get(`decision-${id}`);
    if (fixture) {
      fixture.undoable = true;
      this.fixtureActions.add(fixture.id);
      this.overnightAliases.set(`decision-${id}`, fixture.id);
    } else this.overnightAliases.delete(`decision-${id}`);
    try {
      return done(apply(false));
    } catch (error) {
      this.history.delete(record.row.id);
      if (aliased === undefined) this.overnightAliases.delete(`decision-${id}`);
      else this.overnightAliases.set(`decision-${id}`, aliased);
      throw error;
    }
  }

  private fixtureDecisionRow(topicId: string, decisionId: string): HistoryRow | undefined {
    for (const day of this.topics.get(topicId)?.history?.days ?? []) {
      for (const entry of day.entries) if (entry.kind === "event" && entry.decisionId === decisionId) return entry;
    }
    return undefined;
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
      message.addressee = personId;
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
      message.addressee = topic.stages.find(item => item.name === stage)?.runBy?.id ?? null;
      message.attachment = command.attachment ?? null;
      message.model = this.model(command.model)?.id ?? null;
      thread.messages.push(message);
      return done([{ type: "message.posted", threadId, message }], null, message);
    }
    if (command.stage) throw new Problem("badRequest", "Choose a topic conversation to post in a stage.");
    const thread = this.writableThread(threadId, viewer);
    const topic = topicId ? this.topicView(topicId, viewer, new URLSearchParams()) : null;
    const suggested = matchesSuggestion(text, thread.suggestions);
    const kind = scope.kind === "topic" || scope.kind === "manager" || scope.kind === "general"
      ? suggested || (command.page && /^(sum up|summari[sz]e)\b/i.test(text)) ? "question" : classify(text) : null;
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
      filed = this.fileAsk(text, viewer, { topicId, attachment: sent.attachment, model: sent.model, fromChat: true });
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
    } else if (kind === "goalChange") {
      const decision = this.proposeGoal(readGoalAsk(text, this.askFacts(viewer), topicId, this.now, this.priorityRanks().size), text, sent, threadId);
      const speaker = blankActor(decision ? `${decision.topicName} manager` : topic ? `${topic.name} manager` : "Manager");
      if (decision) {
        const approver = viewer.id === this.owner.id ? "you" : this.owner.shortName;
        reply = this.message(speaker, `I put the goal change in Decide. The goal stays as it is until ${approver} ${approver === "you" ? "approve" : "approves"} it.`, null);
        reply.decisionId = decision.id;
        events.push(...this.decisionEvents(decision), { type: "thread.changed", threadId: "manager" });
        if (!this.prefsOf(viewer).interruptOnlyUrgent) events.push({ type: "attention.raised", target: target("decision", decision.id), reason: "A proposed goal change needs a decision." });
      } else {
        reply = this.message(speaker, `I kept this as a goal change. ${this.missingGoal(text)} Nothing else is filed until that is clear.`, null);
      }
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
    // only a target change writes the target; a date or a unit leaves it as it stands
    const to = change.field === "target" ? change.to : priorTarget;
    const unit = change.unit ?? goal.unit;
    goal.target = to;
    goal.trajectory.goal = to;
    if (change.deadlineAt) goal.deadlineAt = change.deadlineAt;
    if (change.unit || change.deadlineAt) {
      goal.unit = unit;
      if (goal.trajectory.unit) goal.trajectory.unit = unit;
    }
    // A new date or unit leaves every number alone; only a new target moves the figures that count toward it.
    if (to !== priorTarget) {
      const targetFigure = goal.figures.find(figure => figure.of === priorTarget);
      if (targetFigure) targetFigure.of = to;
      const gap = Math.max(0, goal.target - goal.signed - expectedOf(goal));
      const unsecured = goal.figures.find(figure => /still (unsecured|missing)/i.test(figure.label));
      if (unsecured) unsecured.value = gap;
      if (goal.gap) {
        goal.gap.says = gap === 0 ? `The current forecast reaches the goal of ${goal.target}.` : `To reach ${goal.target}, the forecast still needs ${gap} more ${unit}.`;
      }
      const forecast = goal.signed + expectedOf(goal);
      const word = forecast > goal.target ? "Ahead of plan" : forecast === goal.target ? "On track" : "Behind plan";
      this.setVerdict(goal, { ...goal.verdict, state: word === "Behind plan" ? "warn" : "ok", word,
        text: goal.verdict.text?.replace(`the plan needs ${priorTarget}`, `the plan needs ${to}`) ?? null });
    }
    const trajectory = goal.trajectory;
    const end = change.deadlineAt ? Math.round((Date.parse(change.deadlineAt.slice(0, 10)) - Date.parse(trajectory.start)) / 86400000) : null;
    if (end !== null && end > trajectory.now) {
      trajectory.days = end;
      const label = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(change.deadlineAt ?? ""));
      trajectory.ticks = [...trajectory.ticks.filter(tick => tick.day < end), { day: end, label }];
      trajectory.plan = [...trajectory.plan.filter(point => point.day < end), { day: end, value: to }];
    } else if (priorTarget !== to) {
      const last = trajectory.plan.at(-1);
      if (last) last.value = to;
    }
  }

  private budgetSentences(goal: TopicView["goal"] | undefined): string[] {
    return [goal?.outside, goal?.insight, goal?.calibration].filter((line): line is string => Boolean(line)).join(" ").split(/(?<=[.])/);
  }

  private affectedTopicIds(topicId: string): string[] {
    const found = new Set<string>();
    const topic = this.topics.get(topicId);
    for (const sentence of this.budgetSentences(topic?.goal)) {
      if (!/\bbudget\b/i.test(sentence)) continue;
      for (const other of this.topics.values()) {
        if (other.id !== topicId && new RegExp(`\\b${other.name}\\b`, "i").test(sentence)) found.add(other.id);
      }
    }
    for (const other of this.topics.values()) {
      if (other.id === topicId || !topic) continue;
      for (const sentence of this.budgetSentences(other.goal)) {
        if (/\bbudget\b/i.test(sentence) && new RegExp(`\\b${topic.name}\\b`, "i").test(sentence)) found.add(other.id);
      }
    }
    for (const resource of this.managerBase.sharedResources) {
      const topics = new Set(resource.laneIds.flatMap(id => {
        const related = this.lanes.get(id)?.topicId;
        return related ? [related] : [];
      }));
      if (!topics.has(topicId)) continue;
      for (const other of topics) if (other !== topicId) found.add(other);
    }
    for (const report of this.reports.values()) {
      if (report.topicId !== topicId) continue;
      for (const other of this.topics.values()) {
        if (other.id !== topicId && new RegExp(`\\b${other.name}\\b`, "i").test(report.title)) found.add(other.id);
      }
    }
    found.delete(topicId);
    return [...found];
  }

  private goalChangeDetail(change: NonNullable<DecisionView["goalChange"]>): string {
    if ((change.field === "deadline" || change.field === "target") && change.topicId === "partnerships" && change.affectedTopics.includes("paid")) return "Paid's partner budget and the Friday report follow the new goal.";
    if (change.field === "budget") return "The new budget applies to this topic's plan.";
    if (change.field === "priority") return "The new priority applies across this module's topics.";
    if (change.field === "guardrail") return "The new guardrail applies to this topic's plan.";
    if (change.field === "deadline") return "The new deadline applies to this topic's plan.";
    return "The new target applies to this topic's plan.";
  }

  private missingGoal(text: string): string {
    if (/\bguardrail/i.test(text)) return "Name the guardrail and the new limit.";
    if (/\bbudget/i.test(text)) return "Name the new budget.";
    if (/\bpriorit/i.test(text)) return "Say the new rank.";
    if (/\bdeadline/i.test(text)) return "Say the new deadline.";
    return "Say the new target.";
  }

  /** What the topics a reader may see say about themselves: the only world a sentence of theirs can name. */
  private askFacts(viewer: Actor): TopicFact[] {
    const ranks = this.priorityRanks();
    return [...this.topics.keys()].filter(id => this.fullTopic(id, viewer)).map(id => {
      const view = this.topicView(id, viewer, new URLSearchParams());
      const goal = view.goal;
      return {
        id, name: view.name, rank: ranks.get(id) ?? null, cap: view.spend?.cap ?? null,
        goal: goal ? {
          target: goal.target, unit: goal.unit, deadlineAt: goal.deadlineAt,
          guardrails: (goal.guardrails?.items ?? []).flatMap(item => item.id ? [{ id: item.id, what: item.what, limit: item.limit }] : []),
        } : null,
      };
    });
  }

  /** The topics whose rank moves when `topicId` goes from rank `from` to rank `to`. */
  private displacedBy(topicId: string, from: number, to: number): string[] {
    return [...this.priorityRanks()].filter(([id, rank]) => id !== topicId
      && (to < from ? rank >= to && rank < from : rank > from && rank <= to)).map(([id]) => id);
  }

  private proposeGoal(ask: GoalAsk | null, text: string, message: Message, threadId: string): DecisionView | null {
    if (!ask) return null;
    const topic = this.topicView(ask.topicId, this.owner, new URLSearchParams());
    const affected = new Set(this.affectedTopicIds(topic.id));
    if (ask.priority?.from != null) for (const id of this.displacedBy(topic.id, ask.priority.from, ask.priority.to)) affected.add(id);
    const goal = requireRecord(topic.goal, "goal");
    const goalChange: GoalChange = {
      topicId: topic.id, affectedTopics: [...affected], deadlineAt: ask.deadlineAt, previousDeadlineAt: goal.deadlineAt,
      unit: ask.unit, previousUnit: goal.unit, budget: ask.budget, priority: ask.priority, guardrail: ask.guardrail,
      field: ask.field, from: ask.from, to: ask.to,
    };
    const id = `dc-${++this.serial}`;
    const detail = this.goalChangeDetail(goalChange);
    const decision: DecisionView = {
      id, title: text, shortTitle: `Change the ${topic.name} goal`, state: "open", topicId: topic.id, topicName: topic.name,
      dueAt: this.nextBrief(3), whyYours: "Yours: changes a goal", minutes: 2, contextLine: topic.name, cardContext: detail,
      doneNote: "Approved. The goal is changed on record.", laneId: null, approveLabel: "Approve",
      provenance: null, context: detail, numbers: [], proof: null, opportunity: null, risk: null, suggestion: null,
      guardrail: null, nextSteps: [], ifNoAnswer: "Nothing changes without your answer.", position: { index: 0, of: 0, open: 0 },
      changeRequest: null, release: null, rule: "hardToUndo", proposer: blankActor(`${topic.name} manager`),
      goalChange,
    };
    this.decisions.set(id, decision);
    this.asked.set(id, { at: message.at, chat: this.chatName(threadId) });
    message.decisionId = id;
    this.threads.set(`decision:${id}`, {
      id: `decision:${id}`, title: "Chat", sub: topic.name, placeholder: "Ask about the decision", reading: null, since: null,
      pinned: null, agents: null, suggestions: [], messages: [message], scope: null, nextCursor: null,
    });
    return decision;
  }

  /** The chat an ask was written in, as the Manager's asks name it. */
  private chatName(threadId: string): string {
    if (threadScope(threadId)?.kind === "general") return "General";
    const topicId = this.threadTopic(threadId);
    return (topicId ? this.topics.get(topicId)?.name : undefined) ?? "Manager";
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

  private guardrail(name: string, on: boolean, viewer: Actor, id: string | null = null): Effect {
    this.requireOwner(viewer);
    const guardrail = requireRecord(
      (id ? this.skills.guardrails.find(item => item.id === id) : undefined)
        ?? this.skills.guardrails.find(item => item.name === name)
        ?? this.skills.guardrails.find(item => item.name.toLowerCase() === name.toLowerCase() || item.id === slug(name)),
      "guardrail",
    );
    if (guardrail.on === on) return done();
    guardrail.on = on;
    const breached = [...this.breachedItems().values()].filter(item => item.state === "breached" && this.storedGuardrail(item.guardrailId)?.switchId === guardrail.id)
      .map(item => ({ type: "guardrail.breached", topicId: item.topicId, name: item.name, guardrailId: item.guardrailId } as const));
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
    const busyBefore = this.busyValue();
    this.now = at;
    const events: Event[] = [];
    if (Date.parse(nextBrief) <= now) {
      this.briefBase.at = nextBrief;
      events.push({ type: "brief.published" });
      for (const item of this.breachedItems().values()) {
        if (item.state === "breached") events.push(
          { type: "guardrail.breached", topicId: item.topicId, name: item.name, guardrailId: item.guardrailId },
          { type: "attention.raised", target: target("topic", item.topicId), reason: `${item.name} breached its guardrail.` },
        );
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
    const busyAfter = this.busyValue();
    if (busyBefore !== null && busyAfter !== null && busyBefore !== busyAfter) events.push({ type: "skills.changed" });
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
    if (event.type === "resource.changed") {
      const resource = this.managerBase.sharedResources.find(item => item.id === event.resourceId);
      return Boolean(resource?.laneIds.some(laneId => {
        const lane = this.lanes.get(laneId);
        return Boolean(lane && this.sharedLane(lane, viewer));
      }));
    }
    // a frame names a record only to those who can open it
    if (event.type === "report.changed") return this.canReadReport(event.reportId, viewer);
    if (event.type === "check.recorded") {
      const check = this.checks.get(event.checkId);
      return Boolean(check && this.fullTopic(check.topicId, viewer));
    }
    if (event.type === "forecast.scored") return this.fullTopic(event.topicId, viewer);
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
