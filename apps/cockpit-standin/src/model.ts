/** The JSON the stand-in reads and writes. Extra fixture fields stay on the objects. */

export interface Actor {
  id: string;
  name: string;
  shortName: string;
  kind: "person" | "agent";
  avatar: string | null;
  role: string | null;
  state: string | null;
  word: string | null;
  text: string | null;
  skill: string | null;
  engine: string | null;
  record: string | null;
}

export interface LaneAct {
  label: string;
  tone: string;
}

export interface Step {
  kind: string;
  text: string;
  who: string;
}

export interface Handover {
  when: string;
  match: boolean;
  why: string;
  state: string;
  open: string;
  risk: string;
  ifSo: string;
  restated: string;
  fixed: string | null;
}

export interface Lane {
  id: string;
  topicId: string | null;
  title: string;
  state: string;
  stateWord: string;
  lead: Actor;
  waitsFor: Actor | null;
  opened: string;
  closed: string | null;
  next: string | null;
  afterNext: string | null;
  decisionId: string | null;
  short: string | null;
  ask: string | null;
  shortAfter: string | null;
  recommendation: string | null;
  yours: string | null;
  checks: string[];
  delay: string | null;
  approveLabel: string | null;
  after: string | null;
  asked: string;
  askedMeta: { source: string; note: string | null };
  status: string;
  standing: { headline: string; detail: string };
  acts: LaneAct[];
  thumbs: { label: string; passed: boolean; reason: string | null }[];
  steps: Step[];
  doneNote: string;
  crew: Actor[];
  made: { icon: string; title: string; detail: string; href: string | null }[];
  handover: Handover | null;
  fresh: boolean;
}

export interface Decision {
  id: string;
  title: string;
  state: "open" | "approved" | "declined";
  topicId: string;
  topicName: string;
  due: string;
  whyYours: string | null;
  minutes: number;
  contextLine: string;
  cardContext: string;
  doneNote: string;
  laneId: string | null;
  approveLabel: string;
  provenance: {
    laneId: string | null;
    laneTitle: string;
    writtenBy: string;
    checkedBy: string;
    checkedAt: string;
  } | null;
  context: string | null;
  numbers: { label: string; value: string; sub: string | null }[];
  proof: { items: { label: string; value: string; sub: string | null }[]; meta: string[]; unchecked: string | null } | null;
  opportunity: { kind: string; label: string; headline: string; condition: string; summary: string } | null;
  risk: { kind: string; label: string; headline: string; condition: string; summary: string } | null;
  suggestion: string | null;
  guardrail: string | null;
  nextSteps: { step: string; who: string; by: string }[];
  ifNoAnswer: string | null;
  position: string;
}

export interface Deal {
  name: string;
  confidence: string;
  stage: string;
  short: string;
  href: string;
  next: string | null;
  alt: { decisionId: string; stage: string | null; short: string | null; next: string | null } | null;
}

export interface Goal {
  verdict: { word: string };
  insight: string;
  asOf: string;
  decision: {
    title: string;
    detail: string;
    done: string;
    decisionId: string | null;
    laneId: string | null;
  } | null;
  deals: Deal[];
}

export interface TopicLane {
  id: string;
  title: string;
  state: string;
  stateWord: string;
  leadName: string;
  next: string;
}

export interface Topic {
  id: string;
  name: string;
  open: boolean;
  intro: string;
  goal: Goal | null;
  crew: Actor[];
  lanes: TopicLane[];
  [key: string]: unknown;
}

export interface MessageLabel {
  kind: "question" | "request" | "done" | "decision" | "goalChange";
  corrected: boolean;
}

export interface Message {
  id: string;
  author: Actor;
  time: string;
  text: string;
  own: boolean;
  label: MessageLabel | null;
  threadCard: { title: string; owner: string; state: string; laneId: string } | null;
  readBack: { owner: string; quote: string; time: string } | null;
  actions: { label: string }[];
}

export interface Thread {
  id: string;
  title: string;
  sub: string | null;
  placeholder: string;
  reading: string | null;
  since: { seen: string; lines: string[] } | null;
  pinned: {
    title: string;
    detail: string;
    state: "waiting" | "approved" | "stuck";
    decisionId: string | null;
    laneId: string | null;
    approveLabel: string | null;
  } | null;
  agents: unknown;
  suggestions: string[];
  messages: Message[];
}

export interface Pin {
  id: string;
  kind: string;
  label: string;
  name: string | null;
  note: string | null;
  icon: string;
  href: string | null;
  run: string | null;
  badge: boolean;
  pinned: boolean;
}

export interface SidebarLane {
  id: string;
  title: string;
  state: string;
  stateWord: string;
  leadName: string;
}

export interface SidebarGroup {
  id: string;
  name: string;
  kind: string;
  icon: string;
  stateWord: string;
  mark: string | null;
  open: boolean;
  lanes: SidebarLane[];
}

export interface Sidebar {
  kindWord: string;
  groups: SidebarGroup[];
  managerLanes: SidebarLane[];
  pins: Pin[];
  pinnable: Pin[];
}

export interface BriefDecision {
  id: string;
  topicId: string;
  topicName: string;
  due: string;
  whyYours: string;
  title: string;
  context: string;
  minutes: number;
  doneNote: string;
  laneId: string | null;
  state: "open" | "approved" | "declined";
}

export interface Brief {
  decisions: BriefDecision[];
  openCount: number;
  minutes: number;
  overnight: { id: string; undone: boolean }[];
  [key: string]: unknown;
}

export interface QueueItem {
  id: string;
  title: string;
  state: "open" | "approved" | "declined";
  topicName: string;
  href: string;
}

export interface Queue {
  items: QueueItem[];
  open: number;
  total: number;
}

export interface ManagerLane {
  id: string;
  title: string;
  topicId: string | null;
  topicName: string;
  leadName: string;
  state: string;
  stateWord: string;
  next: string;
}

export interface Ask {
  id: string;
  quote: string;
  when: string;
  chat: string;
  went: string;
  href: string;
}

export interface Manager {
  intro: string;
  summary: string;
  lanes: ManagerLane[];
  sharedResources: unknown[];
  asks: Ask[];
  since: string[];
}

export interface Theme {
  id: string;
  name: string;
  strength: number;
  glass: number;
}

export interface Layout {
  sidebarWidth: number;
  chatWidth: number;
}

export interface Workspace {
  workspace: { id: string; name: string; theme: Theme };
  module: { id: string; name: string; icon: string; kindWord: string };
  me: Actor;
  layout: Layout;
  chatMode: "floating" | "sidebar";
}

export interface DecisionRight {
  rule: string;
  title: string;
  detail: string;
  who: "you" | "agent";
  dailyLimit: number | null;
  risky: boolean;
}

export interface Settings {
  briefsPerDay: number;
  interruptOnlyUrgent: boolean;
  decisionRights: DecisionRight[];
  theme: Theme;
  chatMode: "floating" | "sidebar";
  layout: Layout;
  modules: unknown[];
}

export interface AccessGrant {
  kind: "all" | "stages" | "view" | "none";
  stages: string[];
}

export interface AccessPerson {
  person: Actor;
  access: AccessGrant;
  scope: string;
  otherTopics: { topicId: string; access: "all" | "stages" | "view" | "none" }[];
}

export interface Access {
  topicId: string;
  topicName: string;
  people: AccessPerson[];
}

export interface Skill {
  name: string;
  summary: string;
}

export interface Skills {
  skills: Skill[];
  [key: string]: unknown;
}

export type LabelKind = MessageLabel["kind"];

export type Command =
  | { type: "decision.approve"; decisionId: string }
  | { type: "decision.decline"; decisionId: string }
  | { type: "decision.undo"; decisionId: string }
  | { type: "decision.change"; decisionId: string; text: string }
  | { type: "agentAction.undo"; actionId: string }
  | { type: "agentAction.redo"; actionId: string }
  | { type: "lane.file"; text: string; topicId?: string; leadId?: string; attachment?: { name: string; href?: string } }
  | { type: "lane.move"; laneId: string; topicId: string }
  | { type: "lane.undoFile"; laneId: string }
  | { type: "lane.act"; laneId: string; act: string }
  | { type: "person.remind"; laneId: string; personId: string }
  | { type: "goal.ask"; topicId: string }
  | { type: "message.send"; threadId: string; text: string }
  | { type: "message.relabel"; messageId: string; label: LabelKind }
  | { type: "since.edit"; threadId: string; lines: string[] }
  | { type: "pin.add"; pinId: string }
  | { type: "pin.remove"; pinId: string }
  | {
      type: "prefs.set";
      theme?: { id?: string; strength?: number; glass?: number };
      layout?: { sidebarWidth?: number; chatWidth?: number };
      chatMode?: "floating" | "sidebar";
      briefsPerDay?: number;
      interruptOnlyUrgent?: boolean;
    }
  | { type: "decisionRight.set"; rule: string; who: "you" | "agent"; dailyLimit?: number }
  | { type: "skill.run"; skill: string; text: string }
  | { type: "access.set"; topicId: string; personId: string; access: AccessGrant }
  | { type: "access.invite"; topicId: string; nameOrEmail: string };

export interface Outcome {
  status: number;
  definition: string;
  body: unknown;
}
