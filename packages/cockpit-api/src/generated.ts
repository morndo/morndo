// Generated from schema/cockpit.schema.json by scripts/generate.ts. Do not edit.
/**
 * Access kind for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "AccessKind".
 */
export type AccessKind = "all" | "stages" | "view" | "none" | "unknown";
/**
 * Lane state for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "LaneState".
 */
export type LaneState = "new" | "ok" | "warn" | "bad" | "done" | "idle" | "next" | "parked" | "unknown";
/**
 * Identifier of an action recorded in history.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ActionId".
 */
export type ActionId = string;
/**
 * Visual treatment of an action button.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ActionTone".
 */
export type ActionTone = "ink" | "quiet" | "unknown";
/**
 * Actor kind for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ActorKind".
 */
export type ActorKind = "person" | "agent" | "unknown";
/**
 * Identifier of a lane.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "LaneId".
 */
export type LaneId = string;
/**
 * Identifier of a topic or project.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "TopicId".
 */
export type TopicId = string;
/**
 * Chat mode for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ChatMode".
 */
export type ChatMode = "floating" | "sidebar" | "unknown";
/**
 * A user request accepted by the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Command".
 */
export type Command =
  | {
      /**
       * Identifier of the associated decision.
       */
      decisionId: string;
      type: "decision.approve";
    }
  | {
      /**
       * Identifier of the associated decision.
       */
      decisionId: string;
      type: "decision.decline";
    }
  | {
      /**
       * Identifier of the associated decision.
       */
      decisionId: string;
      type: "decision.undo";
    }
  | {
      /**
       * Identifier of the associated decision.
       */
      decisionId: string;
      /**
       * Text shown to the reader.
       */
      text: string;
      type: "decision.change";
    }
  | {
      /**
       * Identifier of the associated action.
       */
      actionId: string;
      type: "agentAction.undo";
    }
  | {
      /**
       * Identifier of the associated action.
       */
      actionId: string;
      type: "agentAction.redo";
    }
  | {
      /**
       * Attachment for this record.
       */
      attachment?: AttachmentInput | null;
      /**
       * Identifier of the associated lead.
       */
      leadId?: PersonId | null;
      /**
       * Text shown to the reader.
       */
      text: string;
      /**
       * Identifier of the associated topic.
       */
      topicId?: TopicId | null;
      type: "lane.file";
    }
  | {
      /**
       * Identifier of a lane.
       */
      laneId: string;
      /**
       * Identifier of a topic or project.
       */
      topicId: string;
      type: "lane.move";
    }
  | {
      /**
       * Identifier of a lane.
       */
      laneId: string;
      type: "lane.undoFile";
    }
  | {
      /**
       * Act for this record.
       */
      act: string;
      /**
       * Identifier of a lane.
       */
      laneId: string;
      type: "lane.act";
    }
  | {
      /**
       * Identifier of a lane.
       */
      laneId: string;
      /**
       * Identifier of an actor, whether a person or an agent.
       */
      personId: string;
      type: "person.remind";
    }
  | {
      /**
       * Identifier of a topic or project.
       */
      topicId: string;
      type: "goal.ask";
    }
  | {
      /**
       * Text shown to the reader.
       */
      text: string;
      /**
       * Identifier of the associated thread.
       */
      threadId: string;
      type: "message.send";
    }
  | {
      /**
       * Label for this record.
       */
      label: "question" | "request" | "done" | "decision" | "goalChange";
      /**
       * Identifier of the associated message.
       */
      messageId: string;
      type: "message.relabel";
    }
  | {
      /**
       * Lines for this record.
       */
      lines: string[];
      /**
       * Identifier of the associated thread.
       */
      threadId: string;
      type: "since.edit";
    }
  | {
      /**
       * Identifier of the associated pin.
       */
      pinId: string;
      type: "pin.add";
    }
  | {
      /**
       * Identifier of the associated pin.
       */
      pinId: string;
      type: "pin.remove";
    }
  | {
      /**
       * Briefs per day for this record.
       */
      briefsPerDay?: number | null;
      /**
       * Chat mode for this record.
       */
      chatMode?: KnownChatMode | null;
      /**
       * Interrupt only urgent for this record.
       */
      interruptOnlyUrgent?: boolean | null;
      /**
       * Sizes of the cockpit panes.
       */
      layout?: LayoutPatch | null;
      /**
       * Theme for this record.
       */
      theme?: ThemePatch | null;
      type: "prefs.set";
    }
  | {
      /**
       * Daily limit for this record.
       */
      dailyLimit?: DailyLimit | null;
      /**
       * Rule for this record.
       */
      rule: "inYourName" | "hardToUndo" | "onlyYouKnow" | "insideGuardrails" | "overWeeklyCap";
      type: "decisionRight.set";
      /**
       * Who for this record.
       */
      who: "you" | "agent";
    }
  | {
      /**
       * Skill for this record.
       */
      skill: string;
      /**
       * Text shown to the reader.
       */
      text: string;
      type: "skill.run";
    }
  | {
      access: AccessGrantInput1;
      /**
       * Identifier of an actor, whether a person or an agent.
       */
      personId: string;
      /**
       * Identifier of a topic or project.
       */
      topicId: string;
      type: "access.set";
    }
  | {
      /**
       * Name or email for this record.
       */
      nameOrEmail: string;
      /**
       * Identifier of a topic or project.
       */
      topicId: string;
      type: "access.invite";
    };
/**
 * Identifier of an actor, whether a person or an agent.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "PersonId".
 */
export type PersonId = string;
/**
 * Chat mode for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "KnownChatMode".
 */
export type KnownChatMode = "floating" | "sidebar";
/**
 * Theme id for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "KnownThemeId".
 */
export type KnownThemeId = "ink" | "ember" | "sand" | "moss" | "tide" | "sky" | "iris" | "rose";
/**
 * Daily allowance for a rule delegated to an agent.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "DailyLimit".
 */
export type DailyLimit = 5 | 20 | 60;
/**
 * A sequenced event on the resumable workspace feed.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "FeedEvent".
 */
export type FeedEvent = {
  /**
   * Time the hub published the event.
   */
  at: string;
  /**
   * Monotonically increasing sequence number on this hub.
   */
  seq: number;
} & FeedEvent1;
export type FeedEvent1 =
  | {
      /**
       * Identifier of the associated decision.
       */
      decisionId: string;
      /**
       * Current state of the record.
       */
      state: "open" | "approved" | "declined" | "unknown";
      type: "decision.changed";
    }
  | {
      /**
       * Identifier of a lane.
       */
      laneId: string;
      /**
       * Identifier of the associated topic.
       */
      topicId: TopicId | null;
      type: "lane.filed";
    }
  | {
      /**
       * Identifier of a lane.
       */
      laneId: string;
      type: "lane.changed";
    }
  | {
      message: Message;
      /**
       * Identifier of the associated thread.
       */
      threadId: string;
      type: "message.posted";
    }
  | {
      /**
       * Identifier of the associated pin.
       */
      pinId: PinId | null;
      type: "pins.changed";
    }
  | {
      type: "prefs.changed";
    }
  | {
      /**
       * Identifier of the associated topic.
       */
      topicId: TopicId | null;
      type: "access.changed";
    }
  | {
      /**
       * Identifier of the associated action.
       */
      actionId: string;
      type: "agentAction.changed";
    }
  | {
      type: "feed.reset";
    }
  | {
      type: "Unknown";
    };
/**
 * Identifier of a sidebar pin.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "PinId".
 */
export type PinId = string;
/**
 * Connection state for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ConnectionState".
 */
export type ConnectionState = "connected" | "signedIn" | "addKey" | "signIn" | "unknown";
/**
 * Decider for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Decider".
 */
export type Decider = "you" | "agent" | "unknown";
/**
 * Identifier of a decision.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "DecisionId".
 */
export type DecisionId = string;
/**
 * Decision rule for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "DecisionRule".
 */
export type DecisionRule =
  "inYourName" | "hardToUndo" | "onlyYouKnow" | "insideGuardrails" | "overWeeklyCap" | "unknown";
/**
 * Decision state for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "DecisionState".
 */
export type DecisionState = "open" | "approved" | "declined" | "unknown";
/**
 * A point in time with an RFC 3339 UTC offset.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Timestamp".
 */
export type Timestamp = string;
/**
 * Identifier of a draft.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "DraftId".
 */
export type DraftId = string;
/**
 * Stable application code for a failed request.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ErrorCode".
 */
export type ErrorCode =
  | "badRequest"
  | "notFound"
  | "forbidden"
  | "conflict"
  | "limitReached"
  | "skillDisabled"
  | "unsupportedMediaType"
  | "payloadTooLarge"
  | "methodNotAllowed"
  | "internal"
  | "unknown";
/**
 * A change notification delivered to cockpit readers.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Event".
 */
export type Event =
  | {
      /**
       * Identifier of the associated decision.
       */
      decisionId: string;
      /**
       * Current state of the record.
       */
      state: "open" | "approved" | "declined" | "unknown";
      type: "decision.changed";
    }
  | {
      /**
       * Identifier of a lane.
       */
      laneId: string;
      /**
       * Identifier of the associated topic.
       */
      topicId: TopicId | null;
      type: "lane.filed";
    }
  | {
      /**
       * Identifier of a lane.
       */
      laneId: string;
      type: "lane.changed";
    }
  | {
      message: Message2;
      /**
       * Identifier of the associated thread.
       */
      threadId: string;
      type: "message.posted";
    }
  | {
      /**
       * Identifier of the associated pin.
       */
      pinId: PinId | null;
      type: "pins.changed";
    }
  | {
      type: "prefs.changed";
    }
  | {
      /**
       * Identifier of the associated topic.
       */
      topicId: TopicId | null;
      type: "access.changed";
    }
  | {
      /**
       * Identifier of the associated action.
       */
      actionId: string;
      type: "agentAction.changed";
    }
  | {
      type: "feed.reset";
    }
  | {
      type: "Unknown";
    };
/**
 * Health state for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "HealthState".
 */
export type HealthState = "ok" | "warn" | "bad" | "idle" | "unknown";
/**
 * Gate state for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "GateState".
 */
export type GateState = "pass" | "running" | "todo" | "fail" | "skipped" | "unknown";
/**
 * Group kind for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "GroupKind".
 */
export type GroupKind = "topic" | "project" | "unknown";
/**
 * History entry for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "HistoryEntry".
 */
export type HistoryEntry =
  | {
      kind: "seen";
    }
  | {
      actor: Actor3;
      /**
       * A point in time with an RFC 3339 UTC offset.
       */
      at: string;
      /**
       * Count for this record.
       */
      count: number | null;
      /**
       * Decision for this record.
       */
      decision: boolean;
      /**
       * Identifier of the associated decision.
       */
      decisionId: DecisionId | null;
      kind: "event";
      /**
       * Identifier of the associated lane.
       */
      laneId: LaneId | null;
      /**
       * Samples for this record.
       */
      samples: string[];
      /**
       * Sent outside for this record.
       */
      sentOutside: boolean;
      /**
       * Text shown to the reader.
       */
      text: string;
      /**
       * Undoable for this record.
       */
      undoable: boolean;
    }
  | {
      kind: "unknown";
    };
/**
 * Access kind for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "KnownAccessKind".
 */
export type KnownAccessKind = "all" | "stages" | "view" | "none";
/**
 * Decider for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "KnownDecider".
 */
export type KnownDecider = "you" | "agent";
/**
 * Decision rule for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "KnownDecisionRule".
 */
export type KnownDecisionRule = "inYourName" | "hardToUndo" | "onlyYouKnow" | "insideGuardrails" | "overWeeklyCap";
/**
 * Label kind for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "KnownLabelKind".
 */
export type KnownLabelKind = "question" | "request" | "done" | "decision" | "goalChange";
/**
 * Label kind for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "LabelKind".
 */
export type LabelKind = "question" | "request" | "done" | "decision" | "goalChange" | "unknown";
/**
 * Identifier of a message.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "MessageId".
 */
export type MessageId = string;
/**
 * Identifier of a selectable model.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ModelId".
 */
export type ModelId = string;
/**
 * Availability of an engine in the model picker.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ModelState".
 */
export type ModelState = "unknown" | "default" | "connected" | "addKey" | "signIn";
/**
 * Available cockpit modules.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ModuleId".
 */
export type ModuleId = "gtm" | "dev" | "unknown";
/**
 * Pin kind for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "PinKind".
 */
export type PinKind = "page" | "topic" | "project" | "skill" | "unknown";
/**
 * Pin state for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "PinState".
 */
export type PinState = "waiting" | "approved" | "stuck" | "unknown";
/**
 * Progress of a stage in a topic plan.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "StageState".
 */
export type StageState = "done" | "next" | "now" | "wait" | "unknown";
/**
 * Identifier of a pull request.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "PullId".
 */
export type PullId = string;
/**
 * Which side of the forecast the chart describes.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ScenarioKind".
 */
export type ScenarioKind = "opportunity" | "risk" | "unknown";
/**
 * Search kind for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "SearchKind".
 */
export type SearchKind = "topic" | "lane" | "person" | "decision" | "skill" | "unknown";
/**
 * Identifier of a runnable skill.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "SkillId".
 */
export type SkillId = string;
/**
 * Step kind for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "StepKind".
 */
export type StepKind = "ok" | "now" | "todo" | "unknown";
/**
 * Destination category for navigation within the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "TargetKind".
 */
export type TargetKind =
  | "topic"
  | "lane"
  | "decision"
  | "thread"
  | "person"
  | "draft"
  | "skill"
  | "pull"
  | "manager"
  | "brief"
  | "drafts"
  | "skills"
  | "settings"
  | "unknown";
/**
 * Theme id for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ThemeId".
 */
export type ThemeId = "ink" | "ember" | "sand" | "moss" | "tide" | "sky" | "iris" | "rose" | "unknown";
/**
 * Identifier of a conversation.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ThreadId".
 */
export type ThreadId = string;
/**
 * Topic kind for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "TopicKind".
 */
export type TopicKind = "topic" | "project" | "unknown";

export interface UrnMorndoCockpitApi1 {
  [k: string]: unknown | undefined;
}
/**
 * Access grant for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "AccessGrant".
 */
export interface AccessGrant {
  /**
   * Kind for this record.
   */
  kind: "all" | "stages" | "view" | "none" | "unknown";
  /**
   * Stage names the person can work. Empty unless `kind` is `stages`.
   */
  stages?: string[];
}
/**
 * Access grant submitted by an administrator.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "AccessGrantInput".
 */
export interface AccessGrantInput {
  /**
   * Scope granted to the recipient.
   */
  kind: "all" | "stages" | "view" | "none";
  /**
   * Allowed stage names when the scope is stage-based.
   */
  stages?: string[];
}
/**
 * Access person for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "AccessPerson".
 */
export interface AccessPerson {
  access: AccessGrant1;
  /**
   * Other topics for this record.
   */
  otherTopics: OtherTopicAccess[];
  person: Actor;
  /**
   * Scope for this record.
   */
  scope: string;
}
/**
 * Access for this record.
 */
export interface AccessGrant1 {
  /**
   * Kind for this record.
   */
  kind: "all" | "stages" | "view" | "none" | "unknown";
  /**
   * Stage names the person can work. Empty unless `kind` is `stages`.
   */
  stages?: string[];
}
/**
 * Other topic access for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "OtherTopicAccess".
 */
export interface OtherTopicAccess {
  /**
   * Access for this record.
   */
  access: "all" | "stages" | "view" | "none" | "unknown";
  /**
   * Identifier of the associated topic.
   */
  topicId: string;
}
/**
 * Person for this record.
 */
export interface Actor {
  /**
   * Avatar for this record.
   */
  avatar: string | null;
  /**
   * Engine for this record.
   */
  engine: string | null;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Kind for this record.
   */
  kind: "person" | "agent" | "unknown";
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Record for this record.
   */
  record: string | null;
  /**
   * Role for this record.
   */
  role: string | null;
  /**
   * Short name for this record.
   */
  shortName: string;
  /**
   * Skill for this record.
   */
  skill: string | null;
  /**
   * Current state of the record.
   */
  state: LaneState | null;
  /**
   * Text shown to the reader.
   */
  text: string | null;
  /**
   * Word for this record.
   */
  word: string | null;
}
/**
 * Sharing settings for one topic.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "AccessView".
 */
export interface AccessView {
  /**
   * People for this record.
   */
  people: AccessPerson[];
  /**
   * Identifier of the associated topic.
   */
  topicId: string;
  /**
   * Topic name for this record.
   */
  topicName: string;
}
/**
 * A person or agent, resolved to the record the screens show.
 * Fields a particular card does not carry are null.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Actor".
 */
export interface Actor1 {
  /**
   * Avatar for this record.
   */
  avatar: string | null;
  /**
   * Engine for this record.
   */
  engine: string | null;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Kind for this record.
   */
  kind: "person" | "agent" | "unknown";
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Record for this record.
   */
  record: string | null;
  /**
   * Role for this record.
   */
  role: string | null;
  /**
   * Short name for this record.
   */
  shortName: string;
  /**
   * Skill for this record.
   */
  skill: string | null;
  /**
   * Current state of the record.
   */
  state: LaneState | null;
  /**
   * Text shown to the reader.
   */
  text: string | null;
  /**
   * Word for this record.
   */
  word: string | null;
}
/**
 * Agent spend for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "AgentSpend".
 */
export interface AgentSpend {
  cap: Money;
  spent: Money1;
}
/**
 * Cap for this record.
 */
export interface Money {
  /**
   * Amount in cents for currencies with two fractional digits.
   */
  amountMinor: number;
  /**
   * ISO 4217 alphabetic currency code.
   */
  currency: string;
}
/**
 * Spent for this record.
 */
export interface Money1 {
  /**
   * Amount in cents for currencies with two fractional digits.
   */
  amountMinor: number;
  /**
   * ISO 4217 alphabetic currency code.
   */
  currency: string;
}
/**
 * Agents strip for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "AgentsStrip".
 */
export interface AgentsStrip {
  /**
   * Count for this record.
   */
  count: number;
  /**
   * Items for this record.
   */
  items: StripItem[];
  /**
   * Seen for this record.
   */
  seen: string;
  /**
   * Summary for this record.
   */
  summary: string;
}
/**
 * Strip item for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "StripItem".
 */
export interface StripItem {
  /**
   * Time the record was created or observed.
   */
  at: string;
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Text shown to the reader.
   */
  text: string;
}
/**
 * Answer for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Answer".
 */
export interface Answer {
  /**
   * Source for this record.
   */
  source: string;
  /**
   * Destination to open in the cockpit.
   */
  target: Target | null;
  /**
   * Text shown to the reader.
   */
  text: string;
}
/**
 * An internal link resolved by the client.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Target".
 */
export interface Target {
  /**
   * Destination record identifier, or null for a top-level surface.
   */
  id: string | null;
  /**
   * Surface or record type to open.
   */
  kind:
    | "topic"
    | "lane"
    | "decision"
    | "thread"
    | "person"
    | "draft"
    | "skill"
    | "pull"
    | "manager"
    | "brief"
    | "drafts"
    | "skills"
    | "settings"
    | "unknown";
}
/**
 * An RFC 9457 problem details response.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ApiError".
 */
export interface ApiError {
  /**
   * Stable application code.
   */
  code:
    | "badRequest"
    | "notFound"
    | "forbidden"
    | "conflict"
    | "limitReached"
    | "skillDisabled"
    | "unsupportedMediaType"
    | "payloadTooLarge"
    | "methodNotAllowed"
    | "internal"
    | "unknown";
  /**
   * Explanation specific to this request.
   */
  detail: string;
  /**
   * Field-level validation failures, if any.
   */
  errors: FieldError[];
  /**
   * HTTP response status.
   */
  status: number;
  /**
   * Short description of the problem type.
   */
  title: string;
  /**
   * URI identifying the problem type.
   */
  type: string;
}
/**
 * A specific field that failed request validation.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "FieldError".
 */
export interface FieldError {
  /**
   * Explanation of the validation failure.
   */
  message: string;
  /**
   * JSON Pointer to the field.
   */
  path: string;
}
/**
 * Artwork for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Artwork".
 */
export interface Artwork {
  /**
   * Alt for this record.
   */
  alt: string;
  /**
   * Credit for this record.
   */
  credit: string;
  /**
   * Index for this record.
   */
  index: number;
  /**
   * Manner for this record.
   */
  manner: string;
  /**
   * Title displayed above the record.
   */
  title: string;
  /**
   * Total for this record.
   */
  total: number;
}
/**
 * Ask for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Ask".
 */
export interface Ask {
  /**
   * Time the record was created or observed.
   */
  at: string;
  /**
   * Chat for this record.
   */
  chat: string;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Quote for this record.
   */
  quote: string;
  target: Target1;
  /**
   * Went for this record.
   */
  went: string;
}
/**
 * An internal link resolved by the client.
 */
export interface Target1 {
  /**
   * Destination record identifier, or null for a top-level surface.
   */
  id: string | null;
  /**
   * Surface or record type to open.
   */
  kind:
    | "topic"
    | "lane"
    | "decision"
    | "thread"
    | "person"
    | "draft"
    | "skill"
    | "pull"
    | "manager"
    | "brief"
    | "drafts"
    | "skills"
    | "settings"
    | "unknown";
}
/**
 * Asked meta for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "AskedMeta".
 */
export interface AskedMeta {
  /**
   * Note for this record.
   */
  note: string | null;
  /**
   * Source for this record.
   */
  source: string;
}
/**
 * File or link supplied with a new request.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "AttachmentInput".
 */
export interface AttachmentInput {
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Url for this record.
   */
  url: string;
}
/**
 * Blocker for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Blocker".
 */
export interface Blocker {
  /**
   * Identifier of the associated lane.
   */
  laneId: LaneId | null;
  /**
   * Short for this record.
   */
  short: string;
  /**
   * Current state of the record.
   */
  state: "ok" | "warn" | "bad" | "idle" | "unknown";
  target: Target2;
  /**
   * What for this record.
   */
  what: string | null;
  /**
   * Who for this record.
   */
  who: string;
  /**
   * Why for this record.
   */
  why: string | null;
}
/**
 * An internal link resolved by the client.
 */
export interface Target2 {
  /**
   * Destination record identifier, or null for a top-level surface.
   */
  id: string | null;
  /**
   * Surface or record type to open.
   */
  kind:
    | "topic"
    | "lane"
    | "decision"
    | "thread"
    | "person"
    | "draft"
    | "skill"
    | "pull"
    | "manager"
    | "brief"
    | "drafts"
    | "skills"
    | "settings"
    | "unknown";
}
/**
 * Brief decision for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "BriefDecision".
 */
export interface BriefDecision {
  /**
   * Context for this record.
   */
  context: string;
  /**
   * Done note for this record.
   */
  doneNote: string;
  /**
   * Time an answer or action is due.
   */
  dueAt: string;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Identifier of the associated lane.
   */
  laneId: LaneId | null;
  /**
   * Minutes for this record.
   */
  minutes: number;
  /**
   * Current state of the record.
   */
  state: "open" | "approved" | "declined" | "unknown";
  /**
   * Title displayed above the record.
   */
  title: string;
  /**
   * Identifier of the associated topic.
   */
  topicId: string;
  /**
   * Topic name for this record.
   */
  topicName: string;
  /**
   * Why yours for this record.
   */
  whyYours: string;
}
/**
 * Brief topic for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "BriefTopic".
 */
export interface BriefTopic {
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Progress for this record.
   */
  progress: string;
  spend: Money2;
  /**
   * Current state of the record.
   */
  state: "ok" | "warn" | "bad" | "idle" | "unknown";
  /**
   * Verdict for this record.
   */
  verdict: string;
}
/**
 * Spend for this record.
 */
export interface Money2 {
  /**
   * Amount in cents for currencies with two fractional digits.
   */
  amountMinor: number;
  /**
   * ISO 4217 alphabetic currency code.
   */
  currency: string;
}
/**
 * The current briefing and items that need attention.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "BriefView".
 */
export interface BriefView {
  artwork: Artwork1;
  /**
   * Time the record was created or observed.
   */
  at: string;
  /**
   * Burns for this record.
   */
  burns: Burn[];
  /**
   * Cadence for this record.
   */
  cadence: string;
  /**
   * Decisions for this record.
   */
  decisions: BriefDecision[];
  drafts: DraftsSummary;
  /**
   * Lede for this record.
   */
  lede: string;
  /**
   * Minutes for this record.
   */
  minutes: number;
  /**
   * Time associated with next brief.
   */
  nextBriefAt: string;
  /**
   * Open count for this record.
   */
  openCount: number;
  /**
   * Overnight for this record.
   */
  overnight: OvernightAction[];
  spend: SpendLine;
  /**
   * Title displayed above the record.
   */
  title: string;
  /**
   * Topics for this record.
   */
  topics: BriefTopic[];
}
/**
 * Artwork for this record.
 */
export interface Artwork1 {
  /**
   * Alt for this record.
   */
  alt: string;
  /**
   * Credit for this record.
   */
  credit: string;
  /**
   * Index for this record.
   */
  index: number;
  /**
   * Manner for this record.
   */
  manner: string;
  /**
   * Title displayed above the record.
   */
  title: string;
  /**
   * Total for this record.
   */
  total: number;
}
/**
 * Burn for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Burn".
 */
export interface Burn {
  /**
   * Explanation shown alongside the summary.
   */
  detail: string;
  /**
   * Time associated with stuck.
   */
  stuckAt: string;
  target: Target3;
  /**
   * Title displayed above the record.
   */
  title: string;
  /**
   * Identifier of the associated topic.
   */
  topicId: string;
  /**
   * Topic name for this record.
   */
  topicName: string;
}
/**
 * An internal link resolved by the client.
 */
export interface Target3 {
  /**
   * Destination record identifier, or null for a top-level surface.
   */
  id: string | null;
  /**
   * Surface or record type to open.
   */
  kind:
    | "topic"
    | "lane"
    | "decision"
    | "thread"
    | "person"
    | "draft"
    | "skill"
    | "pull"
    | "manager"
    | "brief"
    | "drafts"
    | "skills"
    | "settings"
    | "unknown";
}
/**
 * Drafts for this record.
 */
export interface DraftsSummary {
  /**
   * Count for this record.
   */
  count: number;
  /**
   * Explanation shown alongside the summary.
   */
  detail: string;
  /**
   * Text shown to the reader.
   */
  text: string;
}
/**
 * Overnight action for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "OvernightAction".
 */
export interface OvernightAction {
  /**
   * Time the record was created or observed.
   */
  at: string;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Identifier of the associated lane.
   */
  laneId: LaneId | null;
  /**
   * Text shown to the reader.
   */
  text: string;
  /**
   * Identifier of the associated topic.
   */
  topicId: TopicId | null;
  /**
   * Topic name for this record.
   */
  topicName: string;
  /**
   * Undoable for this record.
   */
  undoable: boolean;
  /**
   * Undone for this record.
   */
  undone: boolean;
}
/**
 * Spend for this record.
 */
export interface SpendLine {
  cap: Money3;
  overnight: Money4;
  week: Money5;
}
/**
 * Cap for this record.
 */
export interface Money3 {
  /**
   * Amount in cents for currencies with two fractional digits.
   */
  amountMinor: number;
  /**
   * ISO 4217 alphabetic currency code.
   */
  currency: string;
}
/**
 * Overnight for this record.
 */
export interface Money4 {
  /**
   * Amount in cents for currencies with two fractional digits.
   */
  amountMinor: number;
  /**
   * ISO 4217 alphabetic currency code.
   */
  currency: string;
}
/**
 * Week for this record.
 */
export interface Money5 {
  /**
   * Amount in cents for currencies with two fractional digits.
   */
  amountMinor: number;
  /**
   * ISO 4217 alphabetic currency code.
   */
  currency: string;
}
/**
 * Check result for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "CheckResult".
 */
export interface CheckResult {
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Passed for this record.
   */
  passed: boolean;
}
/**
 * Partial layout written by `prefs.set`.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "LayoutPatch".
 */
export interface LayoutPatch {
  /**
   * Chat width for this record.
   */
  chatWidth?: number | null;
  /**
   * Sidebar width for this record.
   */
  sidebarWidth?: number | null;
}
/**
 * Partial theme written by `prefs.set`. Every field may be omitted.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ThemePatch".
 */
export interface ThemePatch {
  /**
   * Glass for this record.
   */
  glass?: number | null;
  /**
   * Stable identifier for this record.
   */
  id?: KnownThemeId | null;
  /**
   * Strength for this record.
   */
  strength?: number | null;
}
/**
 * Access for this record.
 */
export interface AccessGrantInput1 {
  /**
   * Scope granted to the recipient.
   */
  kind: "all" | "stages" | "view" | "none";
  /**
   * Allowed stage names when the scope is stage-based.
   */
  stages?: string[];
}
/**
 * Receipt and sequenced updates produced by an accepted command.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "CommandResult".
 */
export interface CommandResult {
  /**
   * Events for this record.
   */
  events: FeedEvent[];
  /**
   * Identifier of the associated lane.
   */
  laneId: LaneId | null;
  /**
   * Message for this record.
   */
  message: Message1 | null;
  /**
   * Ok for this record.
   */
  ok: boolean;
}
/**
 * Message for this record.
 */
export interface Message {
  /**
   * Actions for this record.
   */
  actions: MessageAction[];
  /**
   * Time the record was created or observed.
   */
  at: string;
  author: Actor2;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Label for this record.
   */
  label: MessageLabel | null;
  /**
   * Read back for this record.
   */
  readBack: ReadBack | null;
  /**
   * Text shown to the reader.
   */
  text: string;
  /**
   * Thread card for this record.
   */
  threadCard: ThreadCard | null;
}
/**
 * Message action for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "MessageAction".
 */
export interface MessageAction {
  /**
   * Label for this record.
   */
  label: string;
}
/**
 * Author for this record.
 */
export interface Actor2 {
  /**
   * Avatar for this record.
   */
  avatar: string | null;
  /**
   * Engine for this record.
   */
  engine: string | null;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Kind for this record.
   */
  kind: "person" | "agent" | "unknown";
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Record for this record.
   */
  record: string | null;
  /**
   * Role for this record.
   */
  role: string | null;
  /**
   * Short name for this record.
   */
  shortName: string;
  /**
   * Skill for this record.
   */
  skill: string | null;
  /**
   * Current state of the record.
   */
  state: LaneState | null;
  /**
   * Text shown to the reader.
   */
  text: string | null;
  /**
   * Word for this record.
   */
  word: string | null;
}
/**
 * Message label for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "MessageLabel".
 */
export interface MessageLabel {
  /**
   * Corrected for this record.
   */
  corrected: boolean;
  /**
   * Kind for this record.
   */
  kind: "question" | "request" | "done" | "decision" | "goalChange" | "unknown";
}
/**
 * Read back for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ReadBack".
 */
export interface ReadBack {
  /**
   * Time the record was created or observed.
   */
  at: string;
  /**
   * Owner for this record.
   */
  owner: string;
  /**
   * Quote for this record.
   */
  quote: string;
}
/**
 * Thread card for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ThreadCard".
 */
export interface ThreadCard {
  /**
   * Identifier of a lane.
   */
  laneId: string;
  /**
   * Owner for this record.
   */
  owner: string;
  /**
   * Current state of the record.
   */
  stateWord: string;
  /**
   * Title displayed above the record.
   */
  title: string;
}
/**
 * Message for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Message".
 */
export interface Message1 {
  /**
   * Actions for this record.
   */
  actions: MessageAction[];
  /**
   * Time the record was created or observed.
   */
  at: string;
  author: Actor2;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Label for this record.
   */
  label: MessageLabel | null;
  /**
   * Read back for this record.
   */
  readBack: ReadBack | null;
  /**
   * Text shown to the reader.
   */
  text: string;
  /**
   * Thread card for this record.
   */
  threadCard: ThreadCard | null;
}
/**
 * Connection for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Connection".
 */
export interface Connection {
  /**
   * Capacity for this record.
   */
  capacity: string | null;
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Purpose for this record.
   */
  purpose: string;
  /**
   * Current state of the record.
   */
  state: "connected" | "signedIn" | "addKey" | "signIn" | "unknown";
}
/**
 * Deal for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Deal".
 */
export interface Deal {
  /**
   * Alt for this record.
   */
  alt: DealAlt | null;
  /**
   * Chart day for this record.
   */
  chartDay: number | null;
  /**
   * Close for this record.
   */
  close: string | null;
  /**
   * Confidence for this record.
   */
  confidence: string;
  /**
   * Evidence for this record.
   */
  evidence: string;
  /**
   * Identifier of the associated lane.
   */
  laneId: LaneId | null;
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Next for this record.
   */
  next: string | null;
  /**
   * Short for this record.
   */
  short: string;
  /**
   * Stage for this record.
   */
  stage: string;
  target: Target4;
  /**
   * Value for this record.
   */
  value: string | null;
}
/**
 * Deal alt for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "DealAlt".
 */
export interface DealAlt {
  /**
   * Identifier of the associated decision.
   */
  decisionId: string;
  /**
   * Next for this record.
   */
  next: string | null;
  /**
   * Short for this record.
   */
  short: string | null;
  /**
   * Stage for this record.
   */
  stage: string | null;
}
/**
 * An internal link resolved by the client.
 */
export interface Target4 {
  /**
   * Destination record identifier, or null for a top-level surface.
   */
  id: string | null;
  /**
   * Surface or record type to open.
   */
  kind:
    | "topic"
    | "lane"
    | "decision"
    | "thread"
    | "person"
    | "draft"
    | "skill"
    | "pull"
    | "manager"
    | "brief"
    | "drafts"
    | "skills"
    | "settings"
    | "unknown";
}
/**
 * Decision queue view for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "DecisionQueueView".
 */
export interface DecisionQueueView {
  /**
   * Items for this record.
   */
  items: QueueItem[];
  /**
   * Open for this record.
   */
  open: number;
  /**
   * Total for this record.
   */
  total: number;
}
/**
 * Queue item for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "QueueItem".
 */
export interface QueueItem {
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Current state of the record.
   */
  state: "open" | "approved" | "declined" | "unknown";
  target: Target5;
  /**
   * Title displayed above the record.
   */
  title: string;
  /**
   * Topic name for this record.
   */
  topicName: string;
}
/**
 * An internal link resolved by the client.
 */
export interface Target5 {
  /**
   * Destination record identifier, or null for a top-level surface.
   */
  id: string | null;
  /**
   * Surface or record type to open.
   */
  kind:
    | "topic"
    | "lane"
    | "decision"
    | "thread"
    | "person"
    | "draft"
    | "skill"
    | "pull"
    | "manager"
    | "brief"
    | "drafts"
    | "skills"
    | "settings"
    | "unknown";
}
/**
 * Decision right for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "DecisionRight".
 */
export interface DecisionRight {
  /**
   * Daily limit for this record.
   */
  dailyLimit: DailyLimit | null;
  /**
   * Explanation shown alongside the summary.
   */
  detail: string;
  /**
   * Risky for this record.
   */
  risky: boolean;
  /**
   * Rule for this record.
   */
  rule: "inYourName" | "hardToUndo" | "onlyYouKnow" | "insideGuardrails" | "overWeeklyCap" | "unknown";
  /**
   * Title displayed above the record.
   */
  title: string;
  /**
   * Who for this record.
   */
  who: "you" | "agent" | "unknown";
}
/**
 * The evidence, consequences and next steps for a decision.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "DecisionView".
 */
export interface DecisionView {
  /**
   * Approve label for this record.
   */
  approveLabel: string;
  /**
   * The short paragraph on the decision card. The full page uses `context`.
   */
  cardContext: string;
  /**
   * Context for this record.
   */
  context: string | null;
  /**
   * Context line for this record.
   */
  contextLine: string;
  /**
   * Done note for this record.
   */
  doneNote: string;
  /**
   * Time an answer or action is due.
   */
  dueAt: string;
  /**
   * Guardrail for this record.
   */
  guardrail: string | null;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * If no answer for this record.
   */
  ifNoAnswer: string | null;
  /**
   * Identifier of the associated lane.
   */
  laneId: LaneId | null;
  /**
   * Minutes for this record.
   */
  minutes: number;
  /**
   * Next steps for this record.
   */
  nextSteps: NextStep[];
  /**
   * Numbers for this record.
   */
  numbers: Stat[];
  /**
   * Opportunity for this record.
   */
  opportunity: Scenario | null;
  /**
   * Position for this record.
   */
  position: string;
  /**
   * Proof for this record.
   */
  proof: Proof | null;
  /**
   * Provenance for this record.
   */
  provenance: Provenance | null;
  /**
   * Risk for this record.
   */
  risk: Scenario | null;
  /**
   * Current state of the record.
   */
  state: "open" | "approved" | "declined" | "unknown";
  /**
   * Suggestion for this record.
   */
  suggestion: string | null;
  /**
   * Title displayed above the record.
   */
  title: string;
  /**
   * Identifier of a topic or project.
   */
  topicId: string;
  /**
   * Topic name for this record.
   */
  topicName: string;
  /**
   * Why yours for this record.
   */
  whyYours: string | null;
}
/**
 * Next step for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "NextStep".
 */
export interface NextStep {
  /**
   * Time an answer or action is due.
   */
  dueAt: Timestamp | null;
  /**
   * Step for this record.
   */
  step: string;
  /**
   * Who for this record.
   */
  who: string;
}
/**
 * Stat for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Stat".
 */
export interface Stat {
  /**
   * Label for this record.
   */
  label: string;
  /**
   * Sub for this record.
   */
  sub: string | null;
  /**
   * Value for this record.
   */
  value: string;
}
/**
 * One possible outcome shown in the decision forecast.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Scenario".
 */
export interface Scenario {
  /**
   * Condition for this record.
   */
  condition: string;
  /**
   * Headline for this record.
   */
  headline: string;
  /**
   * Kind for this record.
   */
  kind: "opportunity" | "risk" | "unknown";
  /**
   * Label for this record.
   */
  label: string;
  /**
   * Summary for this record.
   */
  summary: string;
}
/**
 * Proof for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Proof".
 */
export interface Proof {
  /**
   * Items for this record.
   */
  items: Stat[];
  /**
   * Meta for this record.
   */
  meta: string[];
  /**
   * Unchecked for this record.
   */
  unchecked: string | null;
}
/**
 * Provenance for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Provenance".
 */
export interface Provenance {
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  checkedAt: string;
  /**
   * Checked by for this record.
   */
  checkedBy: string;
  /**
   * Identifier of the associated lane.
   */
  laneId: LaneId | null;
  /**
   * Lane title for this record.
   */
  laneTitle: string;
  /**
   * Written by for this record.
   */
  writtenBy: string;
}
/**
 * Draft for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Draft".
 */
export interface Draft {
  /**
   * Body for this record.
   */
  body: string;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Skill for this record.
   */
  skill: string | null;
  /**
   * Subject for this record.
   */
  subject: string;
  /**
   * To for this record.
   */
  to: string;
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  writtenAt: string;
}
/**
 * Drafts summary for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "DraftsSummary".
 */
export interface DraftsSummary1 {
  /**
   * Count for this record.
   */
  count: number;
  /**
   * Explanation shown alongside the summary.
   */
  detail: string;
  /**
   * Text shown to the reader.
   */
  text: string;
}
/**
 * Messages prepared for review in the mail app.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "DraftsView".
 */
export interface DraftsView {
  /**
   * Count for this record.
   */
  count: number;
  /**
   * Intro for this record.
   */
  intro: string;
  /**
   * Items for this record.
   */
  items: Draft[];
}
/**
 * Message for the cockpit.
 */
export interface Message2 {
  /**
   * Actions for this record.
   */
  actions: MessageAction[];
  /**
   * Time the record was created or observed.
   */
  at: string;
  author: Actor2;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Label for this record.
   */
  label: MessageLabel | null;
  /**
   * Read back for this record.
   */
  readBack: ReadBack | null;
  /**
   * Text shown to the reader.
   */
  text: string;
  /**
   * Thread card for this record.
   */
  threadCard: ThreadCard | null;
}
/**
 * Fact for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Fact".
 */
export interface Fact {
  /**
   * Label for this record.
   */
  label: string;
  /**
   * Value for this record.
   */
  value: string;
}
/**
 * Failing test for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "FailingTest".
 */
export interface FailingTest {
  /**
   * Expected for this record.
   */
  expected: string;
  /**
   * Failures for this record.
   */
  failures: number;
  /**
   * Got for this record.
   */
  got: string;
  /**
   * Location for this record.
   */
  location: string;
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Runs for this record.
   */
  runs: number;
}
/**
 * Figure for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Figure".
 */
export interface Figure {
  /**
   * Label for this record.
   */
  label: string;
  /**
   * Of for this record.
   */
  of: string | null;
  /**
   * Value for this record.
   */
  value: string;
}
/**
 * Funnel for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Funnel".
 */
export interface Funnel {
  /**
   * Since for this record.
   */
  since: string;
  /**
   * Steps for this record.
   */
  steps: FunnelStep[];
  /**
   * Title displayed above the record.
   */
  title: string;
}
/**
 * Funnel step for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "FunnelStep".
 */
export interface FunnelStep {
  /**
   * Change for this record.
   */
  change: string | null;
  /**
   * Count for this record.
   */
  count: string;
  /**
   * Rate for this record.
   */
  rate: string | null;
  /**
   * Current state of the record.
   */
  state: HealthState | null;
  /**
   * What for this record.
   */
  what: string;
}
/**
 * Gap for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Gap".
 */
export interface Gap {
  /**
   * Says for this record.
   */
  says: string;
  /**
   * Steps for this record.
   */
  steps: string[];
}
/**
 * Gate for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Gate".
 */
export interface Gate {
  /**
   * Explanation shown alongside the summary.
   */
  detail: string | null;
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Current state of the record.
   */
  state: "pass" | "running" | "todo" | "fail" | "skipped" | "unknown";
}
/**
 * Goal for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Goal".
 */
export interface Goal {
  /**
   * As of for this record.
   */
  asOf: string;
  /**
   * Blockers for this record.
   */
  blockers: Blocker[];
  /**
   * Calibration for this record.
   */
  calibration: string | null;
  /**
   * Calm for this record.
   */
  calm: string | null;
  /**
   * Calm sub for this record.
   */
  calmSub: string | null;
  /**
   * Deals for this record.
   */
  deals: Deal[];
  /**
   * Decision for this record.
   */
  decision: GoalDecision | null;
  /**
   * Figures for this record.
   */
  figures: Figure[];
  /**
   * Funnel for this record.
   */
  funnel: Funnel | null;
  /**
   * Gap for this record.
   */
  gap: Gap | null;
  /**
   * Guardrails for this record.
   */
  guardrails: Guardrails | null;
  /**
   * Insight for this record.
   */
  insight: string;
  /**
   * Ladder for this record.
   */
  ladder: LadderRung[];
  /**
   * Likely for this record.
   */
  likely: number | null;
  /**
   * Milestones for this record.
   */
  milestones: string[];
  /**
   * Outside for this record.
   */
  outside: string | null;
  /**
   * Path title for this record.
   */
  pathTitle: string | null;
  /**
   * Rest sub for this record.
   */
  restSub: string | null;
  /**
   * Routine for this record.
   */
  routine: string | null;
  /**
   * Rows for this record.
   */
  rows: RowsHeading | null;
  /**
   * Signed for this record.
   */
  signed: number;
  /**
   * Destination to open in the cockpit.
   */
  target: number;
  trajectory: Trajectory;
  /**
   * Unit for this record.
   */
  unit: string;
  verdict: Verdict;
}
/**
 * Goal decision for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "GoalDecision".
 */
export interface GoalDecision {
  /**
   * Approve label for this record.
   */
  approveLabel: string | null;
  /**
   * Identifier of the associated decision.
   */
  decisionId: DecisionId | null;
  /**
   * Explanation shown alongside the summary.
   */
  detail: string;
  /**
   * Done for this record.
   */
  done: string;
  /**
   * Identifier of the associated lane.
   */
  laneId: LaneId | null;
  /**
   * Title displayed above the record.
   */
  title: string;
  /**
   * Why for this record.
   */
  why: string | null;
}
/**
 * Guardrails for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Guardrails".
 */
export interface Guardrails {
  /**
   * Items for this record.
   */
  items: GuardrailItem[];
  /**
   * Sub for this record.
   */
  sub: string;
}
/**
 * Guardrail item for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "GuardrailItem".
 */
export interface GuardrailItem {
  /**
   * Limit for this record.
   */
  limit: string;
  /**
   * Ratio for this record.
   */
  ratio: number | null;
  /**
   * Value for this record.
   */
  value: string;
  /**
   * What for this record.
   */
  what: string;
}
/**
 * Ladder rung for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "LadderRung".
 */
export interface LadderRung {
  /**
   * Fact for this record.
   */
  fact: string;
  /**
   * Word for this record.
   */
  word: string;
}
/**
 * Rows heading for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "RowsHeading".
 */
export interface RowsHeading {
  /**
   * Sub for this record.
   */
  sub: string;
  /**
   * Title displayed above the record.
   */
  title: string;
}
/**
 * Trajectory for this record.
 */
export interface Trajectory {
  /**
   * Actual for this record.
   */
  actual: SeriesPoint[];
  /**
   * Days for this record.
   */
  days: number;
  /**
   * Expected for this record.
   */
  expected: SeriesPoint[];
  /**
   * Goal for this record.
   */
  goal: number;
  /**
   * High for this record.
   */
  high: SeriesPoint[];
  /**
   * Key for this record.
   */
  key: string | null;
  /**
   * Low for this record.
   */
  low: SeriesPoint[];
  /**
   * No forecast for this record.
   */
  noForecast: string | null;
  /**
   * Now for this record.
   */
  now: number;
  /**
   * Plan for this record.
   */
  plan: SeriesPoint[];
  /**
   * Start for this record.
   */
  start: string;
  /**
   * Step for this record.
   */
  step: number | null;
  /**
   * Ticks for this record.
   */
  ticks: Tick[];
  /**
   * Title displayed above the record.
   */
  title: string;
  /**
   * Unit for this record.
   */
  unit: string | null;
}
/**
 * Series point for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "SeriesPoint".
 */
export interface SeriesPoint {
  /**
   * Day for this record.
   */
  day: number;
  /**
   * Value for this record.
   */
  value: number;
}
/**
 * Tick for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Tick".
 */
export interface Tick {
  /**
   * Day for this record.
   */
  day: number;
  /**
   * Label for this record.
   */
  label: string;
}
/**
 * Verdict for this record.
 */
export interface Verdict {
  /**
   * Action for this record.
   */
  action: string;
  /**
   * Health state for the cockpit.
   */
  state: "ok" | "warn" | "bad" | "idle" | "unknown";
  /**
   * Text shown to the reader.
   */
  text: string;
  /**
   * Word for this record.
   */
  word: string;
}
/**
 * Guardrail switch for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "GuardrailSwitch".
 */
export interface GuardrailSwitch {
  /**
   * Explanation shown alongside the summary.
   */
  detail: string;
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * On for this record.
   */
  on: boolean;
}
/**
 * Handover for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Handover".
 */
export interface Handover {
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  at: string;
  /**
   * Fixed for this record.
   */
  fixed: string | null;
  /**
   * If so for this record.
   */
  ifSo: string;
  /**
   * Matched for this record.
   */
  match: boolean;
  /**
   * Open for this record.
   */
  open: string;
  /**
   * Restated for this record.
   */
  restated: string;
  /**
   * Risk for this record.
   */
  risk: string;
  /**
   * Current state of the record.
   */
  summary: string;
  /**
   * Why for this record.
   */
  why: string;
}
/**
 * Health for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Health".
 */
export interface Health {
  /**
   * Health state for the cockpit.
   */
  state: "ok" | "warn" | "bad" | "idle" | "unknown";
  /**
   * Word for this record.
   */
  word: string;
}
/**
 * History day for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "HistoryDay".
 */
export interface HistoryDay {
  /**
   * Entries for this record.
   */
  entries: HistoryEntry[];
  /**
   * Label for this record.
   */
  label: string;
}
/**
 * Actor for this record.
 */
export interface Actor3 {
  /**
   * Avatar for this record.
   */
  avatar: string | null;
  /**
   * Engine for this record.
   */
  engine: string | null;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Kind for this record.
   */
  kind: "person" | "agent" | "unknown";
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Record for this record.
   */
  record: string | null;
  /**
   * Role for this record.
   */
  role: string | null;
  /**
   * Short name for this record.
   */
  shortName: string;
  /**
   * Skill for this record.
   */
  skill: string | null;
  /**
   * Current state of the record.
   */
  state: LaneState | null;
  /**
   * Text shown to the reader.
   */
  text: string | null;
  /**
   * Word for this record.
   */
  word: string | null;
}
/**
 * A page of activity in a topic.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "HistoryPage".
 */
export interface HistoryPage {
  /**
   * Days for this record.
   */
  days: HistoryDay[];
  /**
   * Opaque cursor for the following page, or null at the end.
   */
  nextCursor: string | null;
  seen: SeenMarker;
  /**
   * Shown for this record.
   */
  shown: number;
  /**
   * Since for this record.
   */
  since: string;
}
/**
 * Seen for this record.
 */
export interface SeenMarker {
  /**
   * Time of the visit.
   */
  at: Timestamp | null;
}
/**
 * Job for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Job".
 */
export interface Job {
  /**
   * Agent for this record.
   */
  agent: string;
  /**
   * Due for this record.
   */
  due: string;
  /**
   * Job for this record.
   */
  job: string;
  /**
   * Identifier of the associated lane.
   */
  laneId: LaneId | null;
  /**
   * Lane state for the cockpit.
   */
  state: "new" | "ok" | "warn" | "bad" | "done" | "idle" | "next" | "parked" | "unknown";
}
/**
 * Lane act for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "LaneAct".
 */
export interface LaneAct {
  /**
   * Label for this record.
   */
  label: string;
  /**
   * Tone for this record.
   */
  tone: "ink" | "quiet" | "unknown";
}
/**
 * A work item and its record of progress.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "LaneView".
 */
export interface LaneView {
  /**
   * Acts for this record.
   */
  acts: LaneAct[];
  /**
   * After for this record.
   */
  after: string | null;
  /**
   * After next for this record.
   */
  afterNext: string | null;
  /**
   * Approve label for this record.
   */
  approveLabel: string | null;
  /**
   * Ask for this record.
   */
  ask: string | null;
  /**
   * Asked for this record.
   */
  asked: string;
  askedMeta: AskedMeta1;
  /**
   * Checks for this record.
   */
  checks: string[];
  /**
   * Time associated with closed.
   */
  closedAt: Timestamp | null;
  /**
   * Crew for this record.
   */
  crew: Actor1[];
  /**
   * Identifier of the associated decision.
   */
  decisionId: DecisionId | null;
  /**
   * Delay for this record.
   */
  delay: string | null;
  /**
   * Done note for this record.
   */
  doneNote: string;
  /**
   * Fresh for this record.
   */
  fresh: boolean;
  /**
   * Handover for this record.
   */
  handover: Handover | null;
  /**
   * Identifier of a lane.
   */
  id: string;
  lead: Actor4;
  /**
   * Made for this record.
   */
  made: MadeItem[];
  /**
   * Next for this record.
   */
  next: string | null;
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  openedAt: string;
  /**
   * Recommendation for this record.
   */
  recommendation: string | null;
  /**
   * Short for this record.
   */
  short: string | null;
  /**
   * Short after for this record.
   */
  shortAfter: string | null;
  standing: Standing;
  /**
   * Lane state for the cockpit.
   */
  state: "new" | "ok" | "warn" | "bad" | "done" | "idle" | "next" | "parked" | "unknown";
  /**
   * State word for this record.
   */
  stateWord: string;
  /**
   * Status for this record.
   */
  status: string;
  /**
   * Steps for this record.
   */
  steps: Step[];
  /**
   * Thumbs for this record.
   */
  thumbs: Thumb[];
  /**
   * Title displayed above the record.
   */
  title: string;
  /**
   * Identifier of the associated topic.
   */
  topicId: TopicId | null;
  /**
   * Waits for for this record.
   */
  waitsFor: Actor1 | null;
  /**
   * Yours for this record.
   */
  yours: string | null;
}
/**
 * Asked meta for this record.
 */
export interface AskedMeta1 {
  /**
   * Note for this record.
   */
  note: string | null;
  /**
   * Source for this record.
   */
  source: string;
}
/**
 * A person or agent, resolved to the record the screens show.
 * Fields a particular card does not carry are null.
 */
export interface Actor4 {
  /**
   * Avatar for this record.
   */
  avatar: string | null;
  /**
   * Engine for this record.
   */
  engine: string | null;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Kind for this record.
   */
  kind: "person" | "agent" | "unknown";
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Record for this record.
   */
  record: string | null;
  /**
   * Role for this record.
   */
  role: string | null;
  /**
   * Short name for this record.
   */
  shortName: string;
  /**
   * Skill for this record.
   */
  skill: string | null;
  /**
   * Current state of the record.
   */
  state: LaneState | null;
  /**
   * Text shown to the reader.
   */
  text: string | null;
  /**
   * Word for this record.
   */
  word: string | null;
}
/**
 * Made item for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "MadeItem".
 */
export interface MadeItem {
  /**
   * Explanation shown alongside the summary.
   */
  detail: string;
  /**
   * Icon for this record.
   */
  icon: string;
  /**
   * Destination to open in the cockpit.
   */
  target: Target | null;
  /**
   * Title displayed above the record.
   */
  title: string;
}
/**
 * Standing for this record.
 */
export interface Standing {
  /**
   * Explanation shown alongside the summary.
   */
  detail: string;
  /**
   * Headline for this record.
   */
  headline: string;
}
/**
 * Step for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Step".
 */
export interface Step {
  /**
   * Kind for this record.
   */
  kind: "ok" | "now" | "todo" | "unknown";
  /**
   * Text shown to the reader.
   */
  text: string;
  /**
   * Who for this record.
   */
  who: string;
}
/**
 * Thumb for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Thumb".
 */
export interface Thumb {
  /**
   * Label for this record.
   */
  label: string;
  /**
   * Passed for this record.
   */
  passed: boolean;
  /**
   * Reason for this record.
   */
  reason: string | null;
}
/**
 * Layout for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Layout".
 */
export interface Layout {
  /**
   * Chat width for this record.
   */
  chatWidth: number;
  /**
   * Sidebar width for this record.
   */
  sidebarWidth: number;
}
/**
 * Manager lane for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ManagerLane".
 */
export interface ManagerLane {
  /**
   * Identifier of a lane.
   */
  id: string;
  /**
   * Lead name for this record.
   */
  leadName: string;
  /**
   * Next for this record.
   */
  next: string;
  /**
   * Lane state for the cockpit.
   */
  state: "new" | "ok" | "warn" | "bad" | "done" | "idle" | "next" | "parked" | "unknown";
  /**
   * State word for this record.
   */
  stateWord: string;
  /**
   * Title displayed above the record.
   */
  title: string;
  /**
   * Identifier of the associated topic.
   */
  topicId: TopicId | null;
  /**
   * Topic name for this record.
   */
  topicName: string;
}
/**
 * The Manager’s triage queue and shared resources.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ManagerView".
 */
export interface ManagerView {
  /**
   * Asks for this record.
   */
  asks: Ask[];
  /**
   * Intro for this record.
   */
  intro: string;
  /**
   * Lanes for this record.
   */
  lanes: ManagerLane[];
  /**
   * Shared resources for this record.
   */
  sharedResources: SharedResource[];
  /**
   * Since for this record.
   */
  since: string[];
  /**
   * Summary for this record.
   */
  summary: string;
}
/**
 * Shared resource for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "SharedResource".
 */
export interface SharedResource {
  /**
   * Icon for this record.
   */
  icon: string;
  /**
   * Lanes for this record.
   */
  lanes: number;
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Rule for this record.
   */
  rule: string;
}
/**
 * Meter for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Meter".
 */
export interface Meter {
  /**
   * Note for this record.
   */
  note: string | null;
  /**
   * Time associated with resets.
   */
  resetsAt: Timestamp | null;
  /**
   * Used for this record.
   */
  used: number;
  /**
   * Value for this record.
   */
  value: string;
  /**
   * What for this record.
   */
  what: string;
}
/**
 * Model offered by the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Model".
 */
export interface Model {
  /**
   * Identifier passed with a command.
   */
  id: string;
  /**
   * Display name.
   */
  name: string;
  /**
   * Current availability.
   */
  state: "unknown" | "default" | "connected" | "addKey" | "signIn";
  /**
   * Engine vendor.
   */
  vendor: string;
}
/**
 * Choices available for a new request.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ModelsView".
 */
export interface ModelsView {
  /**
   * Selectable models in picker order.
   */
  items: Model[];
}
/**
 * Module card for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ModuleCard".
 */
export interface ModuleCard {
  /**
   * Here for this record.
   */
  here: boolean;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Summary for this record.
   */
  summary: string;
}
/**
 * The active cockpit module.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ModuleInfo".
 */
export interface ModuleInfo {
  /**
   * Icon for this record.
   */
  icon: string;
  /**
   * Stable identifier for this record.
   */
  id: "gtm" | "dev" | "unknown";
  /**
   * Kind word for this record.
   */
  kindWord: string;
  /**
   * Name shown to the reader.
   */
  name: string;
}
/**
 * A currency amount in the currency's minor units.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Money".
 */
export interface Money6 {
  /**
   * Amount in cents for currencies with two fractional digits.
   */
  amountMinor: number;
  /**
   * ISO 4217 alphabetic currency code.
   */
  currency: string;
}
/**
 * Night stat for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "NightStat".
 */
export interface NightStat {
  /**
   * Label for this record.
   */
  label: string;
  /**
   * Value for this record.
   */
  value: string;
}
/**
 * Pin for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Pin".
 */
export interface Pin {
  /**
   * Badge for this record.
   */
  badge: boolean;
  /**
   * Icon for this record.
   */
  icon: string;
  /**
   * Identifier of a sidebar pin.
   */
  id: string;
  /**
   * Kind for this record.
   */
  kind: "page" | "topic" | "project" | "skill" | "unknown";
  /**
   * Label for this record.
   */
  label: string;
  /**
   * Name shown to the reader.
   */
  name: string | null;
  /**
   * Note for this record.
   */
  note: string | null;
  /**
   * Pinned for this record.
   */
  pinned: boolean;
  /**
   * Run for this record.
   */
  run: string | null;
  /**
   * Destination to open in the cockpit.
   */
  target: Target | null;
}
/**
 * Pinned decision for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "PinnedDecision".
 */
export interface PinnedDecision {
  /**
   * Approve label for this record.
   */
  approveLabel: string | null;
  /**
   * Identifier of the associated decision.
   */
  decisionId: DecisionId | null;
  /**
   * Explanation shown alongside the summary.
   */
  detail: string;
  /**
   * Identifier of the associated lane.
   */
  laneId: LaneId | null;
  /**
   * Current state of the record.
   */
  state: "waiting" | "approved" | "stuck" | "unknown";
  /**
   * Title displayed above the record.
   */
  title: string;
}
/**
 * Plan for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Plan".
 */
export interface Plan {
  /**
   * Night for this record.
   */
  night: NightStat[];
  /**
   * Stages for this record.
   */
  stages: Stage[];
}
/**
 * Stage for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Stage".
 */
export interface Stage {
  /**
   * Alt for this record.
   */
  alt: StageAlt | null;
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Percent for this record.
   */
  percent: number;
  /**
   * Rows for this record.
   */
  rows: StageRow[];
  /**
   * Progress of a stage in a topic plan.
   */
  state: "done" | "next" | "now" | "wait" | "unknown";
  /**
   * Summary for this record.
   */
  summary: string;
}
/**
 * Stage alt for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "StageAlt".
 */
export interface StageAlt {
  /**
   * Identifier of a decision.
   */
  decisionId: string;
  /**
   * Percent for this record.
   */
  percent: number | null;
  /**
   * Current state of the record.
   */
  state: StageState | null;
  /**
   * Summary for this record.
   */
  summary: string | null;
}
/**
 * Stage row for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "StageRow".
 */
export interface StageRow {
  /**
   * Alt for this record.
   */
  alt: RowAlt | null;
  /**
   * Avatar for this record.
   */
  avatar: string;
  /**
   * Kind for this record.
   */
  kind: "person" | "agent" | "unknown";
  /**
   * Identifier of the associated lane.
   */
  laneId: LaneId | null;
  /**
   * Percent for this record.
   */
  percent: number | null;
  /**
   * Lane state for the cockpit.
   */
  state: "new" | "ok" | "warn" | "bad" | "done" | "idle" | "next" | "parked" | "unknown";
  /**
   * Destination to open in the cockpit.
   */
  target: Target | null;
  /**
   * Text shown to the reader.
   */
  text: string;
  /**
   * When for this record.
   */
  when: string;
  /**
   * Who for this record.
   */
  who: string;
}
/**
 * Row alt for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "RowAlt".
 */
export interface RowAlt {
  /**
   * Identifier of a decision.
   */
  decisionId: string;
  /**
   * Current state of the record.
   */
  state: LaneState | null;
  /**
   * Text shown to the reader.
   */
  text: string | null;
  /**
   * When for this record.
   */
  when: string | null;
}
/**
 * Pull request for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "PullRequest".
 */
export interface PullRequest {
  /**
   * Author for this record.
   */
  author: string;
  /**
   * Gates for this record.
   */
  gates: Gate[];
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Number for this record.
   */
  number: number;
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  openedAt: string;
  /**
   * Identifier of a topic or project.
   */
  projectId: string;
  /**
   * Project name for this record.
   */
  projectName: string;
  /**
   * Summary for this record.
   */
  summary: string;
  /**
   * Destination to open in the cockpit.
   */
  target: Target | null;
  /**
   * Title displayed above the record.
   */
  title: string;
  /**
   * Url for this record.
   */
  url: string;
  /**
   * Verdict for this record.
   */
  verdict: string;
}
/**
 * Pull requests being tracked by the development module.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "PullsView".
 */
export interface PullsView {
  /**
   * Intro for this record.
   */
  intro: string;
  /**
   * Items for this record.
   */
  items: PullRequest[];
  /**
   * Summary for this record.
   */
  summary: string | null;
}
/**
 * Route preview for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "RoutePreview".
 */
export interface RoutePreview {
  /**
   * Chain for this record.
   */
  chain: boolean;
  /**
   * Lead for this record.
   */
  lead: Actor1 | null;
  /**
   * Text shown to the reader.
   */
  text: string;
  /**
   * Identifier of the associated topic.
   */
  topicId: TopicId | null;
  /**
   * Topic name for this record.
   */
  topicName: string | null;
}
/**
 * Search result for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "SearchResult".
 */
export interface SearchResult {
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Kind for this record.
   */
  kind: "topic" | "lane" | "person" | "decision" | "skill" | "unknown";
  /**
   * Sub for this record.
   */
  sub: string | null;
  target: Target6;
  /**
   * Title displayed above the record.
   */
  title: string;
}
/**
 * An internal link resolved by the client.
 */
export interface Target6 {
  /**
   * Destination record identifier, or null for a top-level surface.
   */
  id: string | null;
  /**
   * Surface or record type to open.
   */
  kind:
    | "topic"
    | "lane"
    | "decision"
    | "thread"
    | "person"
    | "draft"
    | "skill"
    | "pull"
    | "manager"
    | "brief"
    | "drafts"
    | "skills"
    | "settings"
    | "unknown";
}
/**
 * A page of records matching the query and an optional answer.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "SearchView".
 */
export interface SearchView {
  /**
   * Answer for this record.
   */
  answer: Answer | null;
  /**
   * Opaque cursor for the following page, or null at the end.
   */
  nextCursor: string | null;
  /**
   * Query for this record.
   */
  query: string;
  /**
   * Results for this record.
   */
  results: SearchResult[];
  /**
   * Scope for this record.
   */
  scope: string | null;
}
/**
 * The reader's last visit to a topic or thread.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "SeenMarker".
 */
export interface SeenMarker1 {
  /**
   * Time of the visit.
   */
  at: Timestamp | null;
}
/**
 * Editable cockpit preferences and decision rights.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "SettingsView".
 */
export interface SettingsView {
  /**
   * Briefs per day for this record.
   */
  briefsPerDay: number;
  /**
   * Chat mode for this record.
   */
  chatMode: "floating" | "sidebar" | "unknown";
  /**
   * Decision rights for this record.
   */
  decisionRights: DecisionRight[];
  /**
   * Interrupt only urgent for this record.
   */
  interruptOnlyUrgent: boolean;
  layout: Layout1;
  /**
   * Modules for this record.
   */
  modules: ModuleCard[];
  theme: Theme;
}
/**
 * Sizes of the cockpit panes.
 */
export interface Layout1 {
  /**
   * Chat width for this record.
   */
  chatWidth: number;
  /**
   * Sidebar width for this record.
   */
  sidebarWidth: number;
}
/**
 * Theme for this record.
 */
export interface Theme {
  /**
   * Effective glass for this record.
   */
  effectiveGlass: number;
  /**
   * Glass for this record.
   */
  glass: number | null;
  /**
   * Stable identifier for this record.
   */
  id: "ink" | "ember" | "sand" | "moss" | "tide" | "sky" | "iris" | "rose" | "unknown";
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Strength for this record.
   */
  strength: number;
}
/**
 * Sidebar group for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "SidebarGroup".
 */
export interface SidebarGroup {
  /**
   * Icon for this record.
   */
  icon: string;
  /**
   * Identifier of a topic or project.
   */
  id: string;
  /**
   * Kind for this record.
   */
  kind: "topic" | "project" | "unknown";
  /**
   * Lanes for this record.
   */
  lanes: SidebarLane[];
  /**
   * Mark for this record.
   */
  mark: string | null;
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Open for this record.
   */
  open: boolean;
  /**
   * State word for this record.
   */
  stateWord: string;
}
/**
 * Sidebar lane for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "SidebarLane".
 */
export interface SidebarLane {
  /**
   * Identifier of a lane.
   */
  id: string;
  /**
   * Lead name for this record.
   */
  leadName: string;
  /**
   * Lane state for the cockpit.
   */
  state: "new" | "ok" | "warn" | "bad" | "done" | "idle" | "next" | "parked" | "unknown";
  /**
   * State word for this record.
   */
  stateWord: string;
  /**
   * Title displayed above the record.
   */
  title: string;
}
/**
 * Navigation, open lanes and ordered pins.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "SidebarView".
 */
export interface SidebarView {
  /**
   * Groups for this record.
   */
  groups: SidebarGroup[];
  /**
   * Kind word for this record.
   */
  kindWord: string;
  /**
   * Manager lanes for this record.
   */
  managerLanes: SidebarLane[];
  /**
   * Pinnable for this record.
   */
  pinnable: Pin[];
  /**
   * Pins for this record.
   *
   * @maxItems 12
   */
  pins:
    | []
    | [Pin]
    | [Pin, Pin]
    | [Pin, Pin, Pin]
    | [Pin, Pin, Pin, Pin]
    | [Pin, Pin, Pin, Pin, Pin]
    | [Pin, Pin, Pin, Pin, Pin, Pin]
    | [Pin, Pin, Pin, Pin, Pin, Pin, Pin]
    | [Pin, Pin, Pin, Pin, Pin, Pin, Pin, Pin]
    | [Pin, Pin, Pin, Pin, Pin, Pin, Pin, Pin, Pin]
    | [Pin, Pin, Pin, Pin, Pin, Pin, Pin, Pin, Pin, Pin]
    | [Pin, Pin, Pin, Pin, Pin, Pin, Pin, Pin, Pin, Pin, Pin]
    | [Pin, Pin, Pin, Pin, Pin, Pin, Pin, Pin, Pin, Pin, Pin, Pin];
}
/**
 * Since summary for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "SinceSummary".
 */
export interface SinceSummary {
  /**
   * Lines for this record.
   */
  lines: string[];
  /**
   * Seen for this record.
   */
  seen: string;
}
/**
 * Skill for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Skill".
 */
export interface Skill {
  /**
   * Enabled for this record.
   */
  enabled: boolean;
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Needs key for this record.
   */
  needsKey: string | null;
  /**
   * Summary for this record.
   */
  summary: string;
  /**
   * Topics for this record.
   */
  topics: string;
}
/**
 * Runnable skills, service connections and standing guardrails.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "SkillsView".
 */
export interface SkillsView {
  /**
   * Built in for this record.
   */
  builtIn: number;
  /**
   * Connected for this record.
   */
  connected: number;
  /**
   * Connections for this record.
   */
  connections: Connection[];
  /**
   * Guardrails for this record.
   */
  guardrails: GuardrailSwitch[];
  /**
   * Intro for this record.
   */
  intro: string;
  /**
   * Rules note for this record.
   */
  rulesNote: string | null;
  /**
   * Skills for this record.
   */
  skills: Skill[];
}
/**
 * Spend line for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "SpendLine".
 */
export interface SpendLine1 {
  cap: Money3;
  overnight: Money4;
  week: Money5;
}
/**
 * Standing for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Standing".
 */
export interface Standing1 {
  /**
   * Explanation shown alongside the summary.
   */
  detail: string;
  /**
   * Headline for this record.
   */
  headline: string;
}
/**
 * Stuck action for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "StuckAction".
 */
export interface StuckAction {
  /**
   * Label for this record.
   */
  label: string;
  /**
   * Tone for this record.
   */
  tone: "ink" | "quiet" | "unknown";
}
/**
 * Stuck report for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "StuckReport".
 */
export interface StuckReport {
  /**
   * Actions for this record.
   */
  actions: StuckAction[];
  /**
   * Blocks for this record.
   */
  blocks: string | null;
  /**
   * Checks for this record.
   */
  checks: CheckResult[];
  /**
   * Explanation shown alongside the summary.
   */
  detail: string;
  /**
   * Log for this record.
   */
  log: FailingTest | null;
  /**
   * Note for this record.
   */
  note: string | null;
  /**
   * Since for this record.
   */
  since: string;
  /**
   * Title displayed above the record.
   */
  title: string;
}
/**
 * Task row for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "TaskRow".
 */
export interface TaskRow {
  /**
   * Lane for this record.
   */
  lane: string;
  /**
   * Next for this record.
   */
  next: string;
  /**
   * Reason for this record.
   */
  reason: string | null;
  /**
   * Lane state for the cockpit.
   */
  state: "new" | "ok" | "warn" | "bad" | "done" | "idle" | "next" | "parked" | "unknown";
  /**
   * State word for this record.
   */
  stateWord: string;
  /**
   * Task for this record.
   */
  task: string;
}
/**
 * Theme for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Theme".
 */
export interface Theme1 {
  /**
   * Effective glass for this record.
   */
  effectiveGlass: number;
  /**
   * Glass for this record.
   */
  glass: number | null;
  /**
   * Stable identifier for this record.
   */
  id: "ink" | "ember" | "sand" | "moss" | "tide" | "sky" | "iris" | "rose" | "unknown";
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Strength for this record.
   */
  strength: number;
}
/**
 * A page of conversation and its reading context.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "ThreadView".
 */
export interface ThreadView {
  /**
   * Agents for this record.
   */
  agents: AgentsStrip | null;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Messages for this record.
   */
  messages: Message1[];
  /**
   * Opaque cursor for the following page, or null at the end.
   */
  nextCursor: string | null;
  /**
   * Pinned for this record.
   */
  pinned: PinnedDecision | null;
  /**
   * Placeholder for this record.
   */
  placeholder: string;
  /**
   * Reading for this record.
   */
  reading: string | null;
  /**
   * Since for this record.
   */
  since: SinceSummary | null;
  /**
   * Sub for this record.
   */
  sub: string | null;
  /**
   * Suggestions for this record.
   */
  suggestions: string[];
  /**
   * Title displayed above the record.
   */
  title: string;
}
/**
 * Topic lane for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "TopicLane".
 */
export interface TopicLane {
  /**
   * Identifier of a lane.
   */
  id: string;
  /**
   * Lead name for this record.
   */
  leadName: string;
  /**
   * Next for this record.
   */
  next: string;
  /**
   * Lane state for the cockpit.
   */
  state: "new" | "ok" | "warn" | "bad" | "done" | "idle" | "next" | "parked" | "unknown";
  /**
   * State word for this record.
   */
  stateWord: string;
  /**
   * Title displayed above the record.
   */
  title: string;
}
/**
 * Topic meta for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "TopicMeta".
 */
export interface TopicMeta {
  /**
   * Asked by for this record.
   */
  askedBy: string | null;
  /**
   * Next report for this record.
   */
  nextReport: string | null;
  /**
   * Owner line for this record.
   */
  ownerLine: string | null;
  /**
   * Parts for this record.
   */
  parts: string[];
}
/**
 * Progress, work and conversation context for one topic or project.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "TopicView".
 */
export interface TopicView {
  /**
   * Chat sub for this record.
   */
  chatSub: string;
  /**
   * Crew for this record.
   */
  crew: Actor1[];
  /**
   * Crumb for this record.
   */
  crumb: string;
  /**
   * Facts for this record.
   */
  facts: Fact[];
  /**
   * Identifier of the associated focus lane.
   */
  focusLaneId: LaneId | null;
  /**
   * Goal for this record.
   */
  goal: Goal | null;
  /**
   * Health for this record.
   */
  health: Health | null;
  /**
   * History for this record.
   */
  history: HistoryPage | null;
  /**
   * Icon for this record.
   */
  icon: string;
  /**
   * Identifier of a topic or project.
   */
  id: string;
  /**
   * Intro for this record.
   */
  intro: string;
  /**
   * Jobs for this record.
   */
  jobs: Job[];
  /**
   * Kind for this record.
   */
  kind: "topic" | "project" | "unknown";
  /**
   * Lanes for this record.
   */
  lanes: TopicLane[];
  /**
   * Meta for this record.
   */
  meta: TopicMeta | null;
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * No goal for this record.
   */
  noGoal: string | null;
  /**
   * Open for this record.
   */
  open: boolean;
  /**
   * Plan for this record.
   */
  plan: Plan | null;
  /**
   * Spend for this record.
   */
  spend: AgentSpend | null;
  /**
   * Stuck for this record.
   */
  stuck: StuckReport | null;
  /**
   * Tasks for this record.
   */
  tasks: TaskRow[];
  /**
   * When for this record.
   */
  when: string | null;
}
/**
 * Trajectory for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Trajectory".
 */
export interface Trajectory1 {
  /**
   * Actual for this record.
   */
  actual: SeriesPoint[];
  /**
   * Days for this record.
   */
  days: number;
  /**
   * Expected for this record.
   */
  expected: SeriesPoint[];
  /**
   * Goal for this record.
   */
  goal: number;
  /**
   * High for this record.
   */
  high: SeriesPoint[];
  /**
   * Key for this record.
   */
  key: string | null;
  /**
   * Low for this record.
   */
  low: SeriesPoint[];
  /**
   * No forecast for this record.
   */
  noForecast: string | null;
  /**
   * Now for this record.
   */
  now: number;
  /**
   * Plan for this record.
   */
  plan: SeriesPoint[];
  /**
   * Start for this record.
   */
  start: string;
  /**
   * Step for this record.
   */
  step: number | null;
  /**
   * Ticks for this record.
   */
  ticks: Tick[];
  /**
   * Title displayed above the record.
   */
  title: string;
  /**
   * Unit for this record.
   */
  unit: string | null;
}
/**
 * Usage account for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "UsageAccount".
 */
export interface UsageAccount {
  /**
   * Lanes for this record.
   */
  lanes: number;
  /**
   * Meters for this record.
   */
  meters: Meter[];
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Note for this record.
   */
  note: string | null;
}
/**
 * Provider usage and capacity for the workspace.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "UsageView".
 */
export interface UsageView {
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  at: string;
  /**
   * Keys for this record.
   */
  keys: UsageAccount[];
  /**
   * Missing for this record.
   */
  missing: string[];
  /**
   * Subscriptions for this record.
   */
  subscriptions: UsageAccount[];
}
/**
 * Verdict for the cockpit.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "Verdict".
 */
export interface Verdict1 {
  /**
   * Action for this record.
   */
  action: string;
  /**
   * Health state for the cockpit.
   */
  state: "ok" | "warn" | "bad" | "idle" | "unknown";
  /**
   * Text shown to the reader.
   */
  text: string;
  /**
   * Word for this record.
   */
  word: string;
}
/**
 * Identity and appearance of the workspace.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "WorkspaceInfo".
 */
export interface WorkspaceInfo {
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Name shown to the reader.
   */
  name: string;
  theme: Theme2;
}
/**
 * Theme for this record.
 */
export interface Theme2 {
  /**
   * Effective glass for this record.
   */
  effectiveGlass: number;
  /**
   * Glass for this record.
   */
  glass: number | null;
  /**
   * Stable identifier for this record.
   */
  id: "ink" | "ember" | "sand" | "moss" | "tide" | "sky" | "iris" | "rose" | "unknown";
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Strength for this record.
   */
  strength: number;
}
/**
 * Workspace identity, reader and presentation settings.
 *
 * This interface was referenced by `UrnMorndoCockpitApi1`'s JSON-Schema
 * via the `definition` "WorkspaceView".
 */
export interface WorkspaceView {
  /**
   * Chat mode for this record.
   */
  chatMode: "floating" | "sidebar" | "unknown";
  /**
   * Version of the contract served by the hub.
   */
  contractVersion: string;
  layout: Layout2;
  me: Actor5;
  module: ModuleInfo1;
  /**
   * IANA time zone used by the workspace.
   */
  timezone: string;
  workspace: WorkspaceInfo1;
}
/**
 * Sizes of the cockpit panes.
 */
export interface Layout2 {
  /**
   * Chat width for this record.
   */
  chatWidth: number;
  /**
   * Sidebar width for this record.
   */
  sidebarWidth: number;
}
/**
 * A person or agent, resolved to the record the screens show.
 * Fields a particular card does not carry are null.
 */
export interface Actor5 {
  /**
   * Avatar for this record.
   */
  avatar: string | null;
  /**
   * Engine for this record.
   */
  engine: string | null;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Kind for this record.
   */
  kind: "person" | "agent" | "unknown";
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Record for this record.
   */
  record: string | null;
  /**
   * Role for this record.
   */
  role: string | null;
  /**
   * Short name for this record.
   */
  shortName: string;
  /**
   * Skill for this record.
   */
  skill: string | null;
  /**
   * Current state of the record.
   */
  state: LaneState | null;
  /**
   * Text shown to the reader.
   */
  text: string | null;
  /**
   * Word for this record.
   */
  word: string | null;
}
/**
 * Module for this record.
 */
export interface ModuleInfo1 {
  /**
   * Icon for this record.
   */
  icon: string;
  /**
   * Stable identifier for this record.
   */
  id: "gtm" | "dev" | "unknown";
  /**
   * Kind word for this record.
   */
  kindWord: string;
  /**
   * Name shown to the reader.
   */
  name: string;
}
/**
 * Workspace for this record.
 */
export interface WorkspaceInfo1 {
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Name shown to the reader.
   */
  name: string;
  theme: Theme2;
}
