// Generated from schema/cockpit.schema.json by scripts/generate.ts. Do not edit.
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "AccessKind".
 */
export type AccessKind = "all" | "stages" | "view" | "none";
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ActorKind".
 */
export type ActorKind = "person" | "agent";
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "DecisionState".
 */
export type DecisionState = "open" | "approved" | "declined";
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ChatMode".
 */
export type ChatMode = "floating" | "sidebar";
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Command".
 */
export type Command =
  | {
      decisionId: string;
      type: "decision.approve";
    }
  | {
      decisionId: string;
      type: "decision.decline";
    }
  | {
      decisionId: string;
      type: "decision.undo";
    }
  | {
      decisionId: string;
      text: string;
      type: "decision.change";
    }
  | {
      actionId: string;
      type: "agentAction.undo";
    }
  | {
      actionId: string;
      type: "agentAction.redo";
    }
  | {
      attachment?: Attachment | null;
      leadId?: string | null;
      text: string;
      topicId?: string | null;
      type: "lane.file";
    }
  | {
      laneId: string;
      topicId: string;
      type: "lane.move";
    }
  | {
      laneId: string;
      type: "lane.undoFile";
    }
  | {
      act: string;
      laneId: string;
      type: "lane.act";
    }
  | {
      laneId: string;
      personId: string;
      type: "person.remind";
    }
  | {
      topicId: string;
      type: "goal.ask";
    }
  | {
      text: string;
      threadId: string;
      type: "message.send";
    }
  | {
      label: LabelKind;
      messageId: string;
      type: "message.relabel";
    }
  | {
      lines: string[];
      threadId: string;
      type: "since.edit";
    }
  | {
      pinId: string;
      type: "pin.add";
    }
  | {
      pinId: string;
      type: "pin.remove";
    }
  | {
      briefsPerDay?: number | null;
      chatMode?: ChatMode | null;
      interruptOnlyUrgent?: boolean | null;
      layout?: LayoutPatch | null;
      theme?: ThemePatch | null;
      type: "prefs.set";
    }
  | {
      dailyLimit?: number | null;
      rule: DecisionRule;
      type: "decisionRight.set";
      who: Decider;
    }
  | {
      skill: string;
      text: string;
      type: "skill.run";
    }
  | {
      access: AccessGrant;
      personId: string;
      topicId: string;
      type: "access.set";
    }
  | {
      nameOrEmail: string;
      topicId: string;
      type: "access.invite";
    };
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "LabelKind".
 */
export type LabelKind = "question" | "request" | "done" | "decision" | "goalChange";
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ThemeId".
 */
export type ThemeId = "ink" | "ember" | "sand" | "moss" | "tide" | "sky" | "iris" | "rose";
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "DecisionRule".
 */
export type DecisionRule = "inYourName" | "hardToUndo" | "onlyYouKnow" | "insideGuardrails" | "overWeeklyCap";
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Decider".
 */
export type Decider = "you" | "agent";
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Event".
 */
export type Event =
  | {
      decisionId: string;
      state: DecisionState;
      type: "decision.changed";
    }
  | {
      laneId: string;
      topicId: string | null;
      type: "lane.filed";
    }
  | {
      laneId: string;
      type: "lane.changed";
    }
  | {
      message: Message;
      threadId: string;
      type: "message.posted";
    }
  | {
      pinId?: string | null;
      type: "pins.changed";
    }
  | {
      type: "prefs.changed";
    }
  | {
      topicId?: string | null;
      type: "access.changed";
    }
  | {
      actionId: string;
      type: "agentAction.changed";
    };
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ConnectionState".
 */
export type ConnectionState = "connected" | "signedIn" | "addKey" | "signIn";
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "GateState".
 */
export type GateState = "pass" | "running" | "todo" | "fail" | "skipped";
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "HealthState".
 */
export type HealthState = "ok" | "warn" | "bad" | "idle";
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "GroupKind".
 */
export type GroupKind = "topic" | "project";
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "HistoryEntry".
 */
export type HistoryEntry =
  | {
      kind: "seen";
    }
  | {
      actor: Actor;
      count: number | null;
      decision: boolean;
      decisionId: string | null;
      kind: "event";
      laneId: string | null;
      samples: string[];
      sentOutside: boolean;
      text: string;
      time: string;
      undoable: boolean;
    };
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "LaneState".
 */
export type LaneState = "new" | "ok" | "warn" | "bad" | "done" | "idle" | "next" | "parked";
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "StepKind".
 */
export type StepKind = "ok" | "now" | "todo";
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ModuleId".
 */
export type ModuleId = "gtm" | "dev";
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "PinKind".
 */
export type PinKind = "page" | "topic" | "project" | "skill";
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "PinState".
 */
export type PinState = "waiting" | "approved" | "stuck";
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SearchKind".
 */
export type SearchKind = "topic" | "lane" | "person" | "decision" | "skill";
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "TopicKind".
 */
export type TopicKind = "topic" | "project";

/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "AccessGrant".
 */
export interface AccessGrant {
  kind: AccessKind;
  /**
   * Stage names the person can work. Empty unless `kind` is `stages`.
   */
  stages?: string[];
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "AccessPerson".
 */
export interface AccessPerson {
  access: AccessGrant;
  otherTopics: OtherTopicAccess[];
  person: Actor;
  scope: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "OtherTopicAccess".
 */
export interface OtherTopicAccess {
  access: AccessKind;
  topicId: string;
}
/**
 * A person or agent, resolved to the record the screens show.
 * Fields a particular card does not carry are null.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Actor".
 */
export interface Actor {
  avatar: string | null;
  engine: string | null;
  id: string;
  kind: ActorKind;
  name: string;
  record: string | null;
  role: string | null;
  shortName: string;
  skill: string | null;
  state: string | null;
  text: string | null;
  word: string | null;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "AccessView".
 */
export interface AccessView {
  people: AccessPerson[];
  topicId: string;
  topicName: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "AgentSpend".
 */
export interface AgentSpend {
  cap: number;
  spent: number;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "AgentsStrip".
 */
export interface AgentsStrip {
  count: number;
  items: StripItem[];
  seen: string;
  summary: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "StripItem".
 */
export interface StripItem {
  name: string;
  text: string;
  time: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Answer".
 */
export interface Answer {
  href: string | null;
  source: string;
  text: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ApiError".
 */
export interface ApiError {
  error: ErrorBody;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ErrorBody".
 */
export interface ErrorBody {
  code: string;
  message: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Artwork".
 */
export interface Artwork {
  alt: string;
  credit: string;
  index: number;
  manner: string;
  title: string;
  total: number;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Ask".
 */
export interface Ask {
  chat: string;
  href: string;
  id: string;
  quote: string;
  went: string;
  when: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "AskedMeta".
 */
export interface AskedMeta {
  note: string | null;
  source: string;
}
/**
 * A file or link dropped onto a topic, or attached to a filed lane.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Attachment".
 */
export interface Attachment {
  href?: string | null;
  name: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Blocker".
 */
export interface Blocker {
  href: string;
  laneId: string | null;
  short: string;
  state: string;
  what: string | null;
  who: string;
  why: string | null;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "BriefDecision".
 */
export interface BriefDecision {
  context: string;
  doneNote: string;
  due: string;
  id: string;
  laneId: string | null;
  minutes: number;
  state: DecisionState;
  title: string;
  topicId: string;
  topicName: string;
  whyYours: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "BriefTopic".
 */
export interface BriefTopic {
  id: string;
  name: string;
  progress: string;
  spend: number;
  state: string;
  verdict: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "BriefView".
 */
export interface BriefView {
  artwork: Artwork;
  burns: Burn[];
  cadence: string;
  date: string;
  decisions: BriefDecision[];
  drafts: DraftsSummary;
  lede: string;
  minutes: number;
  nextBriefAt: string;
  openCount: number;
  overnight: OvernightAction[];
  spend: SpendLine;
  time: string;
  title: string;
  topics: BriefTopic[];
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Burn".
 */
export interface Burn {
  deadline: string;
  detail: string;
  href: string;
  since: string;
  title: string;
  topicId: string;
  topicName: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "DraftsSummary".
 */
export interface DraftsSummary {
  count: number;
  detail: string;
  text: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "OvernightAction".
 */
export interface OvernightAction {
  id: string;
  laneId: string | null;
  text: string;
  time: string;
  topicId: string | null;
  topicName: string;
  undoable: boolean;
  undone: boolean;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SpendLine".
 */
export interface SpendLine {
  cap: number;
  overnight: number;
  week: number;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "CheckResult".
 */
export interface CheckResult {
  name: string;
  passed: boolean;
}
/**
 * Partial layout written by `prefs.set`.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "LayoutPatch".
 */
export interface LayoutPatch {
  chatWidth?: number | null;
  sidebarWidth?: number | null;
}
/**
 * Partial theme written by `prefs.set`. Every field may be omitted.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ThemePatch".
 */
export interface ThemePatch {
  glass?: number | null;
  id?: ThemeId | null;
  strength?: number | null;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "CommandResult".
 */
export interface CommandResult {
  events: Event[];
  laneId: string | null;
  message: Message | null;
  ok: boolean;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Message".
 */
export interface Message {
  actions: MessageAction[];
  author: Actor;
  id: string;
  label: MessageLabel | null;
  own: boolean;
  readBack: ReadBack | null;
  text: string;
  threadCard: ThreadCard | null;
  time: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "MessageAction".
 */
export interface MessageAction {
  label: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "MessageLabel".
 */
export interface MessageLabel {
  corrected: boolean;
  kind: LabelKind;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ReadBack".
 */
export interface ReadBack {
  owner: string;
  quote: string;
  time: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ThreadCard".
 */
export interface ThreadCard {
  laneId: string;
  owner: string;
  state: string;
  title: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Connection".
 */
export interface Connection {
  capacity: string | null;
  name: string;
  purpose: string;
  state: ConnectionState;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Deal".
 */
export interface Deal {
  alt: DealAlt | null;
  at: number | null;
  close: string | null;
  confidence: string;
  evidence: string;
  href: string;
  laneId: string | null;
  name: string;
  next: string | null;
  short: string;
  stage: string;
  value: string | null;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "DealAlt".
 */
export interface DealAlt {
  decisionId: string;
  next: string | null;
  short: string | null;
  stage: string | null;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "DecisionQueueView".
 */
export interface DecisionQueueView {
  items: QueueItem[];
  open: number;
  total: number;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "QueueItem".
 */
export interface QueueItem {
  href: string;
  id: string;
  state: DecisionState;
  title: string;
  topicName: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "DecisionRight".
 */
export interface DecisionRight {
  dailyLimit: number | null;
  detail: string;
  risky: boolean;
  rule: DecisionRule;
  title: string;
  who: Decider;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "DecisionView".
 */
export interface DecisionView {
  approveLabel: string;
  /**
   * The short paragraph on the decision card. The full page uses `context`.
   */
  cardContext: string;
  context: string | null;
  contextLine: string;
  doneNote: string;
  due: string;
  guardrail: string | null;
  id: string;
  ifNoAnswer: string | null;
  laneId: string | null;
  minutes: number;
  nextSteps: NextStep[];
  numbers: Stat[];
  opportunity: Scenario | null;
  position: string;
  proof: Proof | null;
  provenance: Provenance | null;
  risk: Scenario | null;
  state: DecisionState;
  suggestion: string | null;
  title: string;
  topicId: string;
  topicName: string;
  whyYours: string | null;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "NextStep".
 */
export interface NextStep {
  by: string;
  step: string;
  who: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Stat".
 */
export interface Stat {
  label: string;
  sub: string | null;
  value: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Scenario".
 */
export interface Scenario {
  condition: string;
  headline: string;
  kind: string;
  label: string;
  summary: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Proof".
 */
export interface Proof {
  items: Stat[];
  meta: string[];
  unchecked: string | null;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Provenance".
 */
export interface Provenance {
  checkedAt: string;
  checkedBy: string;
  laneId: string | null;
  laneTitle: string;
  writtenBy: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Draft".
 */
export interface Draft {
  body: string;
  id: string;
  skill: string | null;
  subject: string;
  to: string;
  written: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "DraftsView".
 */
export interface DraftsView {
  count: number;
  intro: string;
  items: Draft[];
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Fact".
 */
export interface Fact {
  label: string;
  value: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "FailingTest".
 */
export interface FailingTest {
  expected: string;
  failures: number;
  got: string;
  location: string;
  name: string;
  runs: number;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Figure".
 */
export interface Figure {
  label: string;
  of: string | null;
  value: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Funnel".
 */
export interface Funnel {
  since: string;
  steps: FunnelStep[];
  title: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "FunnelStep".
 */
export interface FunnelStep {
  change: string | null;
  count: string;
  rate: string | null;
  state: string | null;
  what: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Gap".
 */
export interface Gap {
  says: string;
  steps: string[];
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Gate".
 */
export interface Gate {
  detail: string | null;
  name: string;
  state: GateState;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Goal".
 */
export interface Goal {
  asOf: string;
  blockers: Blocker[];
  calibration: string | null;
  calm: string | null;
  calmSub: string | null;
  deals: Deal[];
  decision: GoalDecision | null;
  figures: Figure[];
  funnel: Funnel | null;
  gap: Gap | null;
  guardrails: Guardrails | null;
  insight: string;
  ladder: LadderRung[];
  likely: number | null;
  milestones: string[];
  outside: string | null;
  pathTitle: string | null;
  restSub: string | null;
  routine: string | null;
  rows: RowsHeading | null;
  signed: number;
  target: number;
  trajectory: Trajectory;
  unit: string;
  verdict: Verdict;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "GoalDecision".
 */
export interface GoalDecision {
  approveLabel: string | null;
  decisionId: string | null;
  detail: string;
  done: string;
  laneId: string | null;
  title: string;
  why: string | null;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Guardrails".
 */
export interface Guardrails {
  items: GuardrailItem[];
  sub: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "GuardrailItem".
 */
export interface GuardrailItem {
  limit: string;
  ratio: number | null;
  value: string;
  what: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "LadderRung".
 */
export interface LadderRung {
  fact: string;
  word: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "RowsHeading".
 */
export interface RowsHeading {
  sub: string;
  title: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Trajectory".
 */
export interface Trajectory {
  actual: SeriesPoint[];
  days: number;
  expected: SeriesPoint[];
  goal: number;
  high: SeriesPoint[];
  key: string | null;
  low: SeriesPoint[];
  noForecast: string | null;
  now: number;
  plan: SeriesPoint[];
  start: string;
  step: number | null;
  ticks: Tick[];
  title: string;
  unit: string | null;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SeriesPoint".
 */
export interface SeriesPoint {
  day: number;
  value: number;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Tick".
 */
export interface Tick {
  day: number;
  label: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Verdict".
 */
export interface Verdict {
  action: string;
  state: HealthState;
  text: string;
  word: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "GuardrailSwitch".
 */
export interface GuardrailSwitch {
  detail: string;
  name: string;
  on: boolean;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Handover".
 */
export interface Handover {
  fixed: string | null;
  ifSo: string;
  match: boolean;
  open: string;
  restated: string;
  risk: string;
  state: string;
  when: string;
  why: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Health".
 */
export interface Health {
  state: HealthState;
  word: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "History".
 */
export interface History {
  days: HistoryDay[];
  seen: string;
  shown: number;
  since: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "HistoryDay".
 */
export interface HistoryDay {
  entries: HistoryEntry[];
  label: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Job".
 */
export interface Job {
  agent: string;
  due: string;
  job: string;
  laneId: string | null;
  state: LaneState;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "LaneAct".
 */
export interface LaneAct {
  label: string;
  tone: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "LaneView".
 */
export interface LaneView {
  acts: LaneAct[];
  after: string | null;
  afterNext: string | null;
  approveLabel: string | null;
  ask: string | null;
  asked: string;
  askedMeta: AskedMeta;
  checks: string[];
  closed: string | null;
  crew: Actor[];
  decisionId: string | null;
  delay: string | null;
  doneNote: string;
  fresh: boolean;
  handover: Handover | null;
  id: string;
  lead: Actor;
  made: MadeItem[];
  next: string | null;
  opened: string;
  recommendation: string | null;
  short: string | null;
  shortAfter: string | null;
  standing: Standing;
  state: LaneState;
  stateWord: string;
  status: string;
  steps: Step[];
  thumbs: Thumb[];
  title: string;
  topicId: string | null;
  waitsFor: Actor | null;
  yours: string | null;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "MadeItem".
 */
export interface MadeItem {
  detail: string;
  href: string | null;
  icon: string;
  title: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Standing".
 */
export interface Standing {
  detail: string;
  headline: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Step".
 */
export interface Step {
  kind: StepKind;
  text: string;
  who: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Thumb".
 */
export interface Thumb {
  label: string;
  passed: boolean;
  reason: string | null;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Layout".
 */
export interface Layout {
  chatWidth: number;
  sidebarWidth: number;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ManagerLane".
 */
export interface ManagerLane {
  id: string;
  leadName: string;
  next: string;
  state: LaneState;
  stateWord: string;
  title: string;
  topicId: string | null;
  topicName: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ManagerView".
 */
export interface ManagerView {
  asks: Ask[];
  intro: string;
  lanes: ManagerLane[];
  sharedResources: SharedResource[];
  since: string[];
  summary: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SharedResource".
 */
export interface SharedResource {
  icon: string;
  lanes: number;
  name: string;
  rule: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Meter".
 */
export interface Meter {
  note: string | null;
  used: number;
  value: string;
  what: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ModuleCard".
 */
export interface ModuleCard {
  here: boolean;
  id: string;
  name: string;
  summary: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ModuleInfo".
 */
export interface ModuleInfo {
  icon: string;
  id: ModuleId;
  kindWord: string;
  name: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "NightStat".
 */
export interface NightStat {
  label: string;
  value: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Pin".
 */
export interface Pin {
  badge: boolean;
  href: string | null;
  icon: string;
  id: string;
  kind: PinKind;
  label: string;
  name: string | null;
  note: string | null;
  pinned: boolean;
  run: string | null;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "PinnedDecision".
 */
export interface PinnedDecision {
  approveLabel: string | null;
  decisionId: string | null;
  detail: string;
  laneId: string | null;
  state: PinState;
  title: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Plan".
 */
export interface Plan {
  night: NightStat[];
  stages: Stage[];
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Stage".
 */
export interface Stage {
  alt: StageAlt | null;
  name: string;
  percent: number;
  rows: StageRow[];
  state: string;
  summary: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "StageAlt".
 */
export interface StageAlt {
  decisionId: string;
  percent: number | null;
  state: string | null;
  summary: string | null;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "StageRow".
 */
export interface StageRow {
  alt: RowAlt | null;
  avatar: string;
  href: string | null;
  kind: ActorKind;
  laneId: string | null;
  percent: number | null;
  state: string;
  text: string;
  when: string;
  who: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "RowAlt".
 */
export interface RowAlt {
  decisionId: string;
  state: string | null;
  text: string | null;
  when: string | null;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "PullRequest".
 */
export interface PullRequest {
  author: string;
  gates: Gate[];
  href: string | null;
  id: string;
  number: number;
  opened: string;
  projectId: string;
  projectName: string;
  summary: string;
  title: string;
  verdict: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "PullsView".
 */
export interface PullsView {
  intro: string;
  items: PullRequest[];
  summary: string | null;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "RoutePreview".
 */
export interface RoutePreview {
  chain: boolean;
  lead: Actor | null;
  text: string;
  topicId: string | null;
  topicName: string | null;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SearchResult".
 */
export interface SearchResult {
  href: string;
  id: string;
  kind: SearchKind;
  sub: string | null;
  title: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SearchView".
 */
export interface SearchView {
  answer: Answer | null;
  query: string;
  results: SearchResult[];
  scope: string | null;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SettingsView".
 */
export interface SettingsView {
  briefsPerDay: number;
  chatMode: ChatMode;
  decisionRights: DecisionRight[];
  interruptOnlyUrgent: boolean;
  layout: Layout;
  modules: ModuleCard[];
  theme: Theme;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Theme".
 */
export interface Theme {
  glass: number;
  id: ThemeId;
  name: string;
  strength: number;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SidebarGroup".
 */
export interface SidebarGroup {
  icon: string;
  id: string;
  kind: GroupKind;
  lanes: SidebarLane[];
  mark: string | null;
  name: string;
  open: boolean;
  stateWord: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SidebarLane".
 */
export interface SidebarLane {
  id: string;
  leadName: string;
  state: LaneState;
  stateWord: string;
  title: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SidebarView".
 */
export interface SidebarView {
  groups: SidebarGroup[];
  kindWord: string;
  managerLanes: SidebarLane[];
  pinnable: Pin[];
  pins: Pin[];
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SinceSummary".
 */
export interface SinceSummary {
  lines: string[];
  seen: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Skill".
 */
export interface Skill {
  enabled: boolean;
  name: string;
  needsKey: string | null;
  summary: string;
  topics: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SkillsView".
 */
export interface SkillsView {
  builtIn: number;
  connected: number;
  connections: Connection[];
  guardrails: GuardrailSwitch[];
  intro: string;
  rulesNote: string | null;
  skills: Skill[];
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "StuckAction".
 */
export interface StuckAction {
  label: string;
  tone: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "StuckReport".
 */
export interface StuckReport {
  actions: StuckAction[];
  blocks: string | null;
  checks: CheckResult[];
  detail: string;
  log: FailingTest | null;
  note: string | null;
  since: string;
  title: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "TaskRow".
 */
export interface TaskRow {
  lane: string;
  next: string;
  reason: string | null;
  state: string;
  stateWord: string;
  task: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ThreadView".
 */
export interface ThreadView {
  agents: AgentsStrip | null;
  id: string;
  messages: Message[];
  pinned: PinnedDecision | null;
  placeholder: string;
  reading: string | null;
  since: SinceSummary | null;
  sub: string | null;
  suggestions: string[];
  title: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "TopicLane".
 */
export interface TopicLane {
  id: string;
  leadName: string;
  next: string;
  state: LaneState;
  stateWord: string;
  title: string;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "TopicMeta".
 */
export interface TopicMeta {
  askedBy: string | null;
  nextReport: string | null;
  ownerLine: string | null;
  parts: string[];
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "TopicView".
 */
export interface TopicView {
  chatSub: string;
  crew: Actor[];
  crumb: string;
  facts: Fact[];
  focusLaneId: string | null;
  goal: Goal | null;
  health: Health | null;
  history: History | null;
  icon: string;
  id: string;
  intro: string;
  jobs: Job[];
  kind: TopicKind;
  lanes: TopicLane[];
  meta: TopicMeta | null;
  name: string;
  noGoal: string | null;
  open: boolean;
  plan: Plan | null;
  spend: AgentSpend | null;
  stuck: StuckReport | null;
  tasks: TaskRow[];
  when: string | null;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "UsageAccount".
 */
export interface UsageAccount {
  lanes: number;
  meters: Meter[];
  name: string;
  note: string | null;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "UsageView".
 */
export interface UsageView {
  asOf: string;
  keys: UsageAccount[];
  missing: string[];
  subscriptions: UsageAccount[];
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "WorkspaceInfo".
 */
export interface WorkspaceInfo {
  id: string;
  name: string;
  theme: Theme;
}
/**
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "WorkspaceView".
 */
export interface WorkspaceView {
  chatMode: ChatMode;
  layout: Layout;
  me: Actor;
  module: ModuleInfo;
  workspace: WorkspaceInfo;
}
