// Generated from schema/cockpit.schema.json by scripts/generate.ts. Do not edit.
/**
 * Access kind for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "AccessKind".
 */
export type AccessKind = "all" | "stages" | "view" | "none";
/**
 * Membership of the person in the workspace.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "MembershipState".
 */
export type MembershipState = "active" | "invited";
/**
 * Lane state for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "LaneState".
 */
export type LaneState = "new" | "ok" | "warn" | "bad" | "done" | "idle" | "next" | "parked";
/**
 * A point in time with an RFC 3339 UTC offset.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Timestamp".
 */
export type Timestamp = string;
/**
 * Identifier of a topic or project.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "TopicId".
 */
export type TopicId = string;
/**
 * Identifier of an action recorded in history.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ActionId".
 */
export type ActionId = string;
/**
 * Visual treatment of an action button.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ActionTone".
 */
export type ActionTone = "ink" | "quiet";
/**
 * Actor kind for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ActorKind".
 */
export type ActorKind = "person" | "agent";
/**
 * Identifier of a lane.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "LaneId".
 */
export type LaneId = string;
/**
 * Decision rule for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "DecisionRule".
 */
export type DecisionRule = "inYourName" | "hardToUndo" | "onlyYouKnow" | "insideGuardrails" | "overWeeklyCap";
/**
 * Identifier of a pull request.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "PullId".
 */
export type PullId = string;
/**
 * Identifier of a status report.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ReportId".
 */
export type ReportId = string;
/**
 * Chat mode for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ChatMode".
 */
export type ChatMode = "floating" | "sidebar";
/**
 * Identifier of a spot check.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "CheckId".
 */
export type CheckId = string;
/**
 * Numeric or machine-readable value rendered according to its measurement kind.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "MeasuredValue".
 */
export type MeasuredValue =
  | {
      kind: "count";
      /**
       * Total, when presented as a fraction.
       */
      of: number | null;
      /**
       * Count unit or interval.
       */
      unit: string | null;
      /**
       * Observed count.
       */
      value: number;
    }
  | {
      kind: "rate";
      /**
       * Percentage points, e.g. 1.2 for 1.2%.
       */
      percent: number;
      /**
       * Whether the rate is the standard policy.
       */
      standard: boolean;
    }
  | {
      /**
       * Budget cap, when applicable.
       */
      cap: Money8 | null;
      kind: "money";
      money: Money9;
    }
  | {
      /**
       * A point in time with an RFC 3339 UTC offset.
       */
      at: string;
      kind: "time";
    }
  | {
      kind: "policy";
      /**
       * Rule expressed in words when it has no measurable threshold.
       */
      text: string;
    };
/**
 * Identifier of a recurring schedule.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ScheduleId".
 */
export type ScheduleId = string;
/**
 * A user request accepted by the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
       * Model for this record.
       */
      model?: ModelId | null;
      /**
       * Text shown to the reader.
       */
      text: string;
      /**
       * To manager for this record.
       */
      toManager?: boolean;
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
       * Attachment for this record.
       */
      attachment?: AttachmentInput | null;
      /**
       * Model for this record.
       */
      model?: ModelId | null;
      /**
       * Page for this record.
       */
      page?: TargetInput | null;
      /**
       * Status viewer receiving a private reply from the owner.
       */
      recipientId?: PersonId | null;
      /**
       * Stage to post in when the thread covers several stages.
       */
      stage?: string | null;
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
       *
       * @maxItems 12
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
       * Identifier of the associated device.
       */
      deviceId?: string | null;
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
       * Person authorized to exercise the decision right.
       */
      personId?: PersonId | null;
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
       * Model for this record.
       */
      model?: ModelId | null;
      /**
       * Skill for this record.
       */
      skill: string;
      /**
       * What to ask the skill. Without it the hub runs the skill's default ask.
       */
      text?: string;
      /**
       * Explicit destination when the skill is run from shared work.
       */
      topicId?: TopicId | null;
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
    }
  | {
      /**
       * Identifier of the associated pin.
       */
      pinId: string;
      /**
       * To for this record.
       */
      to: number;
      type: "pin.move";
    }
  | {
      /**
       * Identifier of a topic or project.
       */
      topicId: string;
      type: "topic.seen";
    }
  | {
      /**
       * Identifier of an actor, whether a person or an agent.
       */
      personId: string;
      /**
       * Stage for this record.
       */
      stage: string;
      /**
       * Identifier of a topic or project.
       */
      topicId: string;
      type: "stage.assign";
    }
  | {
      /**
       * Identifier of the associated invitation.
       */
      invitationId: string;
      type: "access.revoke";
    }
  | {
      /**
       * Invitation accepted by its recipient.
       */
      invitationId: string;
      type: "access.accept";
    }
  | {
      /**
       * Enable the link or revoke it. Omission enables it.
       */
      enabled?: boolean;
      /**
       * Identifier of a topic or project.
       */
      topicId: string;
      type: "access.statusLink";
    }
  | {
      /**
       * Description for this record.
       */
      description: string;
      type: "skill.create";
    }
  | {
      /**
       * Guardrail to switch. The name is still accepted without it.
       */
      id?: string | null;
      /**
       * Name shown to the reader.
       */
      name: string;
      /**
       * On for this record.
       */
      on: boolean;
      type: "guardrail.set";
    }
  | {
      /**
       * Identifier of a pull request.
       */
      pullId: string;
      type: "pull.hold";
    }
  | {
      /**
       * Identifier of a pull request.
       */
      pullId: string;
      type: "pull.unhold";
    }
  | {
      /**
       * Identifier of the associated connection.
       */
      connectionId: string;
      type: "connection.connect";
    }
  | {
      /**
       * Identifier of the associated module.
       */
      moduleId: "gtm" | "dev";
      type: "module.switch";
    }
  | {
      /**
       * Identifier of a lane.
       */
      laneId: string;
      type: "handover.confirm";
    }
  | {
      target: TargetInput1;
      type: "recent.visit";
    };
/**
 * Identifier of an actor, whether a person or an agent.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "PersonId".
 */
export type PersonId = string;
/**
 * Identifier of a selectable model.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ModelId".
 */
export type ModelId = string;
/**
 * Chat mode for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "KnownChatMode".
 */
export type KnownChatMode = "floating" | "sidebar";
/**
 * Theme id for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "KnownThemeId".
 */
export type KnownThemeId = "ink" | "ember" | "sand" | "moss" | "tide" | "sky" | "iris" | "rose";
/**
 * Daily allowance for a rule delegated to an agent.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "DailyLimit".
 */
export type DailyLimit = 5 | 20 | 60;
/**
 * A sequenced event on the resumable workspace feed.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "FeedEvent".
 */
export type FeedEvent = {
  /**
   * A point in time with an RFC 3339 UTC offset.
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
      state: "open" | "approved" | "declined" | "expired";
      type: "decision.changed";
    }
  | {
      /**
       * Chain for this record.
       */
      chain: boolean;
      /**
       * Group shared with the sibling lanes when an ask was split, or null when it was not split.
       */
      groupId: string | null;
      /**
       * Identifier of a lane.
       */
      laneId: string;
      /**
       * Schedule that filed the lane, or null when none did.
       */
      scheduleId: ScheduleId | null;
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
       * Person whose grant changed, when the event concerns an individual.
       */
      personId?: PersonId | null;
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
      decisionId: DecisionId;
      type: "decision.expired";
    }
  | {
      laneId: LaneId;
      type: "lane.removed";
    }
  | {
      threadId: ThreadId;
      type: "thread.changed";
    }
  | {
      topicId: TopicId;
      type: "topic.changed";
    }
  | {
      type: "drafts.changed";
    }
  | {
      type: "brief.changed";
    }
  | {
      type: "brief.published";
    }
  | {
      reason: string;
      target: Target;
      type: "attention.raised";
    }
  | {
      /**
       * Guardrail that was breached.
       */
      guardrailId: string;
      name: string;
      topicId: TopicId | null;
      type: "guardrail.breached";
    }
  | {
      type: "usage.changed";
    }
  | {
      decisionId: DecisionId;
      type: "release.changed";
    }
  | {
      pullId: PullId;
      type: "pull.changed";
    }
  | {
      laneId: LaneId;
      type: "handover.changed";
    }
  | {
      type: "skills.changed";
    }
  | {
      moduleId: ModuleId;
      type: "module.changed";
    }
  | {
      type: "feed.reset";
    }
  | {
      /**
       * Identifier of a lane.
       */
      laneId: string;
      /**
       * Run record that changed.
       */
      recordId: string;
      type: "run.changed";
    }
  | {
      /**
       * Identifier of a recurring schedule.
       */
      scheduleId: string;
      type: "schedule.changed";
    }
  | {
      /**
       * Identifier of a status report.
       */
      reportId: string;
      /**
       * Identifier of a topic or project.
       */
      topicId: string;
      type: "report.changed";
    }
  | {
      /**
       * Check that was recorded.
       */
      checkId: string;
      /**
       * Identifier of a topic or project.
       */
      topicId: string;
      type: "check.recorded";
    }
  | {
      type: "decisionRight.changed";
    }
  | {
      /**
       * Person whose right it is, or null when the right belongs to the reader.
       */
      personId: PersonId | null;
      /**
       * Decision rule for the cockpit.
       */
      rule: "inYourName" | "hardToUndo" | "onlyYouKnow" | "insideGuardrails" | "overWeeklyCap";
      type: "decisionRight.limitReached";
    }
  | {
      /**
       * Resource that changed.
       */
      resourceId: string;
      type: "resource.changed";
    }
  | {
      /**
       * Forecast that was scored.
       */
      forecastId: string;
      /**
       * Identifier of a topic or project.
       */
      topicId: string;
      type: "forecast.scored";
    }
  | {
      /**
       * Person who changed, or null when the change concerns the list as a whole.
       */
      personId: PersonId | null;
      type: "members.changed";
    };
/**
 * Identifier of a decision.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "DecisionId".
 */
export type DecisionId = string;
/**
 * Identifier of a sidebar pin.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "PinId".
 */
export type PinId = string;
/**
 * Identifier of a conversation.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ThreadId".
 */
export type ThreadId = string;
/**
 * Available cockpit modules.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ModuleId".
 */
export type ModuleId = "gtm" | "dev";
/**
 * What a connection's grant lets agents do. The action gateway refuses a write beyond the scope.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ConnectionScope".
 */
export type ConnectionScope = "read" | "draftsOnly" | "readWrite" | "runsLanes" | "agent";
/**
 * Identifier of a service connection.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ConnectionId".
 */
export type ConnectionId = string;
/**
 * Connection state for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ConnectionState".
 */
export type ConnectionState = "connected" | "signedIn" | "addKey" | "signIn";
/**
 * Decider for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Decider".
 */
export type Decider = "you" | "agent";
/**
 * Decision state for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "DecisionState".
 */
export type DecisionState = "open" | "approved" | "declined" | "expired";
/**
 * Step kind for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "StepKind".
 */
export type StepKind = "ok" | "now" | "todo";
/**
 * Identifier of a draft.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "DraftId".
 */
export type DraftId = string;
/**
 * Stable application code for a failed request.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  | "idempotencyKeyReused"
  | "rateLimited";
/**
 * A change notification delivered to cockpit readers.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Event".
 */
export type Event =
  | {
      /**
       * Identifier of a decision.
       */
      decisionId: string;
      /**
       * Current state of the record.
       */
      state: "open" | "approved" | "declined" | "expired";
      type: "decision.changed";
    }
  | {
      /**
       * Chain for this record.
       */
      chain: boolean;
      /**
       * Group shared with the sibling lanes when an ask was split, or null when it was not split.
       */
      groupId: string | null;
      /**
       * Identifier of a lane.
       */
      laneId: string;
      /**
       * Schedule that filed the lane, or null when none did.
       */
      scheduleId: ScheduleId | null;
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
       * Identifier of a conversation.
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
       * Person whose grant changed, when the event concerns an individual.
       */
      personId?: PersonId | null;
      /**
       * Identifier of the associated topic.
       */
      topicId: TopicId | null;
      type: "access.changed";
    }
  | {
      /**
       * Identifier of an action recorded in history.
       */
      actionId: string;
      type: "agentAction.changed";
    }
  | {
      decisionId: DecisionId;
      type: "decision.expired";
    }
  | {
      laneId: LaneId;
      type: "lane.removed";
    }
  | {
      threadId: ThreadId;
      type: "thread.changed";
    }
  | {
      topicId: TopicId;
      type: "topic.changed";
    }
  | {
      type: "drafts.changed";
    }
  | {
      type: "brief.changed";
    }
  | {
      type: "brief.published";
    }
  | {
      reason: string;
      target: Target;
      type: "attention.raised";
    }
  | {
      /**
       * Guardrail that was breached.
       */
      guardrailId: string;
      name: string;
      topicId: TopicId | null;
      type: "guardrail.breached";
    }
  | {
      type: "usage.changed";
    }
  | {
      decisionId: DecisionId;
      type: "release.changed";
    }
  | {
      pullId: PullId;
      type: "pull.changed";
    }
  | {
      laneId: LaneId;
      type: "handover.changed";
    }
  | {
      type: "skills.changed";
    }
  | {
      moduleId: ModuleId;
      type: "module.changed";
    }
  | {
      type: "feed.reset";
    }
  | {
      /**
       * Identifier of a lane.
       */
      laneId: string;
      /**
       * Run record that changed.
       */
      recordId: string;
      type: "run.changed";
    }
  | {
      /**
       * Identifier of a recurring schedule.
       */
      scheduleId: string;
      type: "schedule.changed";
    }
  | {
      /**
       * Identifier of a status report.
       */
      reportId: string;
      /**
       * Identifier of a topic or project.
       */
      topicId: string;
      type: "report.changed";
    }
  | {
      /**
       * Check that was recorded.
       */
      checkId: string;
      /**
       * Identifier of a topic or project.
       */
      topicId: string;
      type: "check.recorded";
    }
  | {
      type: "decisionRight.changed";
    }
  | {
      /**
       * Person whose right it is, or null when the right belongs to the reader.
       */
      personId: PersonId | null;
      /**
       * Decision rule for the cockpit.
       */
      rule: "inYourName" | "hardToUndo" | "onlyYouKnow" | "insideGuardrails" | "overWeeklyCap";
      type: "decisionRight.limitReached";
    }
  | {
      /**
       * Resource that changed.
       */
      resourceId: string;
      type: "resource.changed";
    }
  | {
      /**
       * Forecast that was scored.
       */
      forecastId: string;
      /**
       * Identifier of a topic or project.
       */
      topicId: string;
      type: "forecast.scored";
    }
  | {
      /**
       * Person who changed, or null when the change concerns the list as a whole.
       */
      personId: PersonId | null;
      type: "members.changed";
    };
/**
 * A change event or an unsequenced control message on the feed.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "FeedFrame".
 */
export type FeedFrame =
  | FeedEvent2
  | {
      type: "feed.reset";
    };
/**
 * A sequenced event on the resumable workspace feed.
 */
export type FeedEvent2 = {
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  at: string;
  /**
   * Monotonically increasing sequence number on this hub.
   */
  seq: number;
} & (
  | {
      /**
       * Identifier of the associated decision.
       */
      decisionId: string;
      /**
       * Current state of the record.
       */
      state: "open" | "approved" | "declined" | "expired";
      type: "decision.changed";
    }
  | {
      /**
       * Chain for this record.
       */
      chain: boolean;
      /**
       * Group shared with the sibling lanes when an ask was split, or null when it was not split.
       */
      groupId: string | null;
      /**
       * Identifier of a lane.
       */
      laneId: string;
      /**
       * Schedule that filed the lane, or null when none did.
       */
      scheduleId: ScheduleId | null;
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
       * Person whose grant changed, when the event concerns an individual.
       */
      personId?: PersonId | null;
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
      decisionId: DecisionId;
      type: "decision.expired";
    }
  | {
      laneId: LaneId;
      type: "lane.removed";
    }
  | {
      threadId: ThreadId;
      type: "thread.changed";
    }
  | {
      topicId: TopicId;
      type: "topic.changed";
    }
  | {
      type: "drafts.changed";
    }
  | {
      type: "brief.changed";
    }
  | {
      type: "brief.published";
    }
  | {
      reason: string;
      target: Target;
      type: "attention.raised";
    }
  | {
      /**
       * Guardrail that was breached.
       */
      guardrailId: string;
      name: string;
      topicId: TopicId | null;
      type: "guardrail.breached";
    }
  | {
      type: "usage.changed";
    }
  | {
      decisionId: DecisionId;
      type: "release.changed";
    }
  | {
      pullId: PullId;
      type: "pull.changed";
    }
  | {
      laneId: LaneId;
      type: "handover.changed";
    }
  | {
      type: "skills.changed";
    }
  | {
      moduleId: ModuleId;
      type: "module.changed";
    }
  | {
      type: "feed.reset";
    }
  | {
      /**
       * Identifier of a lane.
       */
      laneId: string;
      /**
       * Run record that changed.
       */
      recordId: string;
      type: "run.changed";
    }
  | {
      /**
       * Identifier of a recurring schedule.
       */
      scheduleId: string;
      type: "schedule.changed";
    }
  | {
      /**
       * Identifier of a status report.
       */
      reportId: string;
      /**
       * Identifier of a topic or project.
       */
      topicId: string;
      type: "report.changed";
    }
  | {
      /**
       * Check that was recorded.
       */
      checkId: string;
      /**
       * Identifier of a topic or project.
       */
      topicId: string;
      type: "check.recorded";
    }
  | {
      type: "decisionRight.changed";
    }
  | {
      /**
       * Person whose right it is, or null when the right belongs to the reader.
       */
      personId: PersonId | null;
      /**
       * Decision rule for the cockpit.
       */
      rule: "inYourName" | "hardToUndo" | "onlyYouKnow" | "insideGuardrails" | "overWeeklyCap";
      type: "decisionRight.limitReached";
    }
  | {
      /**
       * Resource that changed.
       */
      resourceId: string;
      type: "resource.changed";
    }
  | {
      /**
       * Forecast that was scored.
       */
      forecastId: string;
      /**
       * Identifier of a topic or project.
       */
      topicId: string;
      type: "forecast.scored";
    }
  | {
      /**
       * Person who changed, or null when the change concerns the list as a whole.
       */
      personId: PersonId | null;
      type: "members.changed";
    }
);
/**
 * A feed control message without a sequence number; the reader should fetch fresh views.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "FeedResetSignal".
 */
export type FeedResetSignal = {
  type: "feed.reset";
};
/**
 * Health state for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "HealthState".
 */
export type HealthState = "ok" | "warn" | "bad" | "idle";
/**
 * Identifier of a staging run or review record.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "RecordId".
 */
export type RecordId = string;
/**
 * Gate state for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "GateState".
 */
export type GateState = "pass" | "running" | "todo" | "fail" | "skipped";
/**
 * What happens when a guardrail is breached.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "GuardrailAction".
 */
export type GuardrailAction = "ask" | "pause" | "revert" | "stop";
/**
 * Goal field being edited.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "GoalField".
 */
export type GoalField = "target" | "deadline" | "unit" | "budget" | "priority" | "guardrail";
/**
 * Group kind for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "GroupKind".
 */
export type GroupKind = "topic" | "project";
/**
 * Evaluation of a guardrail at the current reading.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "GuardrailState".
 */
export type GuardrailState = "held" | "near" | "breached";
/**
 * History entry for the cockpit.
 * History entry for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "HistoryEntry".
 */
export type HistoryEntry =
  | {
      kind: "seen";
    }
  | {
      actor: Actor5;
      /**
       * A point in time with an RFC 3339 UTC offset.
       */
      at: string;
      /**
       * Spot check the row records, or null when it records no check.
       */
      checkId: CheckId | null;
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
      /**
       * Identifier of an action recorded in history.
       */
      id: string;
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
      /**
       * Undone for this record.
       */
      undone: boolean;
    };
/**
 * Identifier of a sharing invitation.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "InvitationId".
 */
export type InvitationId = string;
/**
 * Progress of an invitation.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "InvitationState".
 */
export type InvitationState = "pending" | "accepted";
/**
 * Schedule for a job whose next run does not have a timestamp.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "JobCadence".
 */
export type JobCadence = "everyMorning" | "afterDecision" | "weekly" | "monthly";
/**
 * Access kind for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "KnownAccessKind".
 */
export type KnownAccessKind = "all" | "stages" | "view" | "none";
/**
 * Decider for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "KnownDecider".
 */
export type KnownDecider = "you" | "agent";
/**
 * Decision rule for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "KnownDecisionRule".
 */
export type KnownDecisionRule = "inYourName" | "hardToUndo" | "onlyYouKnow" | "insideGuardrails" | "overWeeklyCap";
/**
 * Label kind for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "KnownLabelKind".
 */
export type KnownLabelKind = "question" | "request" | "done" | "decision" | "goalChange";
/**
 * Available cockpit modules.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "KnownModuleId".
 */
export type KnownModuleId = "gtm" | "dev";
/**
 * Destination category for navigation within the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "KnownTargetKind".
 */
export type KnownTargetKind =
  | "topic"
  | "lane"
  | "decision"
  | "thread"
  | "person"
  | "draft"
  | "skill"
  | "pull"
  | "run"
  | "review"
  | "file"
  | "report"
  | "check"
  | "manager"
  | "brief"
  | "drafts"
  | "skills"
  | "settings";
/**
 * Label kind for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "LabelKind".
 */
export type LabelKind = "question" | "request" | "done" | "decision" | "goalChange";
/**
 * Audience allowed to receive a message in a topic.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "MessageAudience".
 */
export type MessageAudience =
  | {
      kind: "owner";
    }
  | {
      kind: "viewer";
      /**
       * Identifier of an actor, whether a person or an agent.
       */
      personId: string;
    }
  | {
      kind: "topic";
    }
  | {
      kind: "stage";
      /**
       * Name of the stage in the topic.
       */
      stage: string;
    };
/**
 * Identifier of a message.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "MessageId".
 */
export type MessageId = string;
/**
 * Availability of an engine in the model picker.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ModelState".
 */
export type ModelState = "signedIn" | "default" | "connected" | "addKey" | "signIn";
/**
 * What an overnight action did to the work.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "OutcomeKind".
 */
export type OutcomeKind =
  | "released"
  | "merged"
  | "updated"
  | "renewed"
  | "deleted"
  | "published"
  | "sent"
  | "switchedOff"
  | "added"
  | "stopped";
/**
 * Pin kind for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "PinKind".
 */
export type PinKind = "page" | "topic" | "project" | "skill";
/**
 * Pin state for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "PinState".
 */
export type PinState = "waiting" | "approved" | "declined" | "expired" | "stuck";
/**
 * Progress of a stage in a topic plan.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "StageState".
 */
export type StageState = "done" | "next" | "now" | "wait";
/**
 * Position of a pull request in the review and release flow.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "PullState".
 */
export type PullState = "ready" | "blocked" | "inReview" | "autoMerge" | "releasing" | "released" | "held";
/**
 * Rollout lifecycle for a release decision.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ReleaseStage".
 */
export type ReleaseStage = "scheduled" | "rolling" | "watching" | "done" | "held" | "rolledBack";
/**
 * Where a report is in its cycle.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ReportState".
 */
export type ReportState = "scheduled" | "drafting" | "drafted" | "sent" | "skipped";
/**
 * Which side of the forecast the chart describes.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ScenarioKind".
 */
export type ScenarioKind = "opportunity" | "risk";
/**
 * What a schedule runs when it fires.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ScheduleKind".
 */
export type ScheduleKind = "lane" | "report" | "check" | "brief";
/**
 * Search kind for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SearchKind".
 */
export type SearchKind = "topic" | "lane" | "person" | "decision" | "skill";
/**
 * Status of a result, interpreted in the context of its kind.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SearchState".
 */
export type SearchState =
  "open" | "approved" | "declined" | "expired" | "new" | "ok" | "warn" | "bad" | "done" | "idle" | "next" | "parked";
/**
 * Identifier of a runnable skill.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SkillId".
 */
export type SkillId = string;
/**
 * How a spot check picked what to look at.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SpotCheckKind".
 */
export type SpotCheckKind = "random" | "periodic" | "numbers";
/**
 * What a spot check found.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SpotCheckOutcome".
 */
export type SpotCheckOutcome = "held" | "failed" | "mixed";
/**
 * Access a reader has to one stage.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "StageAccess".
 */
export type StageAccess = "work" | "view" | "locked";
/**
 * Destination category for navigation within the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  | "run"
  | "review"
  | "file"
  | "report"
  | "check"
  | "manager"
  | "brief"
  | "drafts"
  | "skills"
  | "settings";
/**
 * Theme id for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ThemeId".
 */
export type ThemeId = "ink" | "ember" | "sand" | "moss" | "tide" | "sky" | "iris" | "rose";
/**
 * Topic kind for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "TopicKind".
 */
export type TopicKind = "topic" | "project";
/**
 * How close a usage account is to its current limit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "UsageState".
 */
export type UsageState = "ok" | "near" | "limit" | "standingBy";
/**
 * Access level applied to a topic view.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ViewerRole".
 */
export type ViewerRole = "owner" | "all" | "stages" | "view";

/**
 * Access grant for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "AccessGrant".
 */
export interface AccessGrant {
  /**
   * Kind for this record.
   */
  kind: "all" | "stages" | "view" | "none";
  /**
   * Stage names the person can work. Empty unless `kind` is `stages`.
   */
  stages?: string[];
}
/**
 * Access grant submitted by an administrator.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "AccessPerson".
 */
export interface AccessPerson {
  access: AccessGrant1;
  /**
   * Address used for this person’s invitations.
   */
  email?: string | null;
  /**
   * Other topics for this record.
   */
  otherTopics: OtherTopicAccess[];
  /**
   * Owner for this record.
   */
  owner: boolean;
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
  kind: "all" | "stages" | "view" | "none";
  /**
   * Stage names the person can work. Empty unless `kind` is `stages`.
   */
  stages?: string[];
}
/**
 * Other topic access for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "OtherTopicAccess".
 */
export interface OtherTopicAccess {
  /**
   * Access for this record.
   */
  access: "all" | "stages" | "view" | "none";
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
  kind: "person" | "agent";
  /**
   * Membership state, set for invited readers who have not joined.
   */
  membershipState?: MembershipState | null;
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
   * Short name. Agents show their full name, people their first name, and the viewer reads "You".
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "AccessView".
 */
export interface AccessView {
  /**
   * Invitations for this record.
   */
  invitations: Invitation[];
  /**
   * People for this record.
   */
  people: AccessPerson[];
  /**
   * Status link for this record.
   */
  statusLink: StatusLink | null;
  /**
   * Identifier of a topic or project.
   */
  topicId: string;
  /**
   * Topic name for this record.
   */
  topicName: string;
}
/**
 * A request to share the topic with someone.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Invitation".
 */
export interface Invitation {
  /**
   * Time the invitation was accepted, or null while it is pending.
   */
  acceptedAt: Timestamp | null;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  invitedAt: string;
  /**
   * Person who sent the invitation, or null when it is not recorded.
   */
  invitedBy: Actor1 | null;
  /**
   * Name or email for this record.
   */
  nameOrEmail: string;
  /**
   * Person whose access can be set while the invitation is pending.
   */
  personId: string;
  /**
   * Current state of the record.
   */
  state: "pending" | "accepted";
  /**
   * Topic the invitation is for, or null when it is for the workspace.
   */
  topicId: TopicId | null;
}
/**
 * A person or agent, resolved to the record the screens show.
 * Fields a particular card does not carry are null.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  kind: "person" | "agent";
  /**
   * Membership state, set for invited readers who have not joined.
   */
  membershipState?: MembershipState | null;
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
   * Short name. Agents show their full name, people their first name, and the viewer reads "You".
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
 * A link showing status without names, lanes or chat.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "StatusLink".
 */
export interface StatusLink {
  /**
   * Org only for this record.
   */
  orgOnly: boolean;
  /**
   * Url for this record.
   */
  url: string;
}
/**
 * Agent spend for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  seen: SeenMarker;
  /**
   * Summary for this record.
   */
  summary: string;
}
/**
 * Strip item for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "StripItem".
 */
export interface StripItem {
  /**
   * A point in time with an RFC 3339 UTC offset.
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
 * Seen for this record.
 */
export interface SeenMarker {
  /**
   * Time of the visit.
   */
  at: Timestamp | null;
}
/**
 * Answer for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
    | "run"
    | "review"
    | "file"
    | "report"
    | "check"
    | "manager"
    | "brief"
    | "drafts"
    | "skills"
    | "settings";
}
/**
 * An RFC 9457 problem details response.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
    | "idempotencyKeyReused"
    | "rateLimited";
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
   * Glass for this record.
   */
  glass: string;
  /**
   * Index for this record.
   */
  index: number;
  /**
   * Manner for this record.
   */
  manner: string;
  /**
   * Position for this record.
   */
  position: string;
  /**
   * Src for this record.
   */
  src: string;
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Ask".
 */
export interface Ask {
  /**
   * A point in time with an RFC 3339 UTC offset.
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
    | "run"
    | "review"
    | "file"
    | "report"
    | "check"
    | "manager"
    | "brief"
    | "drafts"
    | "skills"
    | "settings";
}
/**
 * Asked meta for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * A file or link dropped onto a topic, or attached to a filed lane.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Attachment".
 */
export interface Attachment {
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * The hub serves attachments over HTTPS. The local stand-in also returns its loopback upload URL.
   */
  url: string;
}
/**
 * File or link supplied with a new request.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "AttachmentInput".
 */
export interface AttachmentInput {
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Supply an HTTPS URL to the hub. The local stand-in also accepts its own loopback upload URL.
   */
  url: string;
}
/**
 * Blocker for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Blocker".
 */
export interface Blocker {
  /**
   * Guardrail this blocker is about, or null when it is not a guardrail breach.
   */
  guardrailId: string | null;
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
  state: "ok" | "warn" | "bad" | "idle";
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
    | "run"
    | "review"
    | "file"
    | "report"
    | "check"
    | "manager"
    | "brief"
    | "drafts"
    | "skills"
    | "settings";
}
/**
 * Brief decision for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
   * A point in time with an RFC 3339 UTC offset.
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
   * The manager or agent that proposed this, or null when the reader did.
   */
  proposer: Actor1 | null;
  /**
   * Decision right that governs this request.
   */
  rule: DecisionRule | null;
  /**
   * Current state of the record.
   */
  state: "open" | "approved" | "declined" | "expired";
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
  whyYours: string;
}
/**
 * Brief topic for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "BriefTopic".
 */
export interface BriefTopic {
  /**
   * Identifier of a topic or project.
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
  state: "ok" | "warn" | "bad" | "idle";
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "BriefView".
 */
export interface BriefView {
  artwork: Artwork1;
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  at: string;
  /**
   * Burns for this record.
   */
  burns: Burn[];
  /**
   * Burns sub for this record.
   */
  burnsSub: string | null;
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
   * Which edition of the day this is, for example 1 of 3, or null when the brief has one.
   */
  edition: MeterCount | null;
  /**
   * In works for this record.
   */
  inWorks: InWorks | null;
  /**
   * Lede for this record.
   */
  lede: string;
  /**
   * Minutes for this record.
   */
  minutes: number;
  /**
   * A point in time with an RFC 3339 UTC offset.
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
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  overnightSinceAt: string;
  /**
   * Settled items retained for the reader’s receipt and Undo.
   */
  settledBurns: SettledBurn[];
  /**
   * Shared progress visible without topic spending or private records.
   */
  sharedTopics: SharedTopicStatus[];
  /**
   * Spend for this record.
   */
  spend: SpendLine | null;
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
   * Glass for this record.
   */
  glass: string;
  /**
   * Index for this record.
   */
  index: number;
  /**
   * Manner for this record.
   */
  manner: string;
  /**
   * Position for this record.
   */
  position: string;
  /**
   * Src for this record.
   */
  src: string;
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Burn".
 */
export interface Burn {
  /**
   * Blocks for this record.
   */
  blocks: string | null;
  /**
   * Explanation shown alongside the summary.
   */
  detail: string;
  /**
   * Time an answer or action is due.
   */
  dueAt: Timestamp | null;
  /**
   * Identifier of a lane.
   */
  laneId: string;
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  stuckAt: string;
  target: Target3;
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
    | "run"
    | "review"
    | "file"
    | "report"
    | "check"
    | "manager"
    | "brief"
    | "drafts"
    | "skills"
    | "settings";
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
 * Used and allowed requests in the current window.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "MeterCount".
 */
export interface MeterCount {
  /**
   * Request allowance.
   */
  of: number;
  /**
   * Requests used.
   */
  used: number;
}
/**
 * Pull requests still in progress, grouped by what happens next.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "InWorks".
 */
export interface InWorks {
  /**
   * Time associated with auto merge.
   */
  autoMergeAt: Timestamp | null;
  /**
   * Count for this record.
   */
  count: number;
  /**
   * In review for this record.
   */
  inReview: number;
  /**
   * Ready for this record.
   */
  ready: number;
  target: Target4;
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
    | "run"
    | "review"
    | "file"
    | "report"
    | "check"
    | "manager"
    | "brief"
    | "drafts"
    | "skills"
    | "settings";
}
/**
 * Overnight action for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "OvernightAction".
 */
export interface OvernightAction {
  /**
   * A point in time with an RFC 3339 UTC offset.
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
   * What the action produced, or null when the row carries no count of results.
   */
  outcome: OvernightOutcome | null;
  /**
   * Other lanes modified by a grouped action.
   */
  relatedLaneIds?: LaneId[];
  /**
   * Decision right the action was taken under, or null when none applied.
   */
  rule: DecisionRule | null;
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
   * Time until which the action can be undone. Set on every undoable overnight row. An undo after it, or on a row whose outcome was sent outside, is a conflict.
   */
  undoUntilAt: Timestamp | null;
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
 * What an overnight action produced.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "OvernightOutcome".
 */
export interface OvernightOutcome {
  /**
   * Checks the action made; empty when it made none.
   */
  checks: CheckResult[];
  /**
   * Items the action covered, or null when it is not a count.
   */
  count: number | null;
  /**
   * Items the action held back, or null when none were.
   */
  heldBack: number | null;
  /**
   * What happened to the work.
   */
  kind:
    | "released"
    | "merged"
    | "updated"
    | "renewed"
    | "deleted"
    | "published"
    | "sent"
    | "switchedOff"
    | "added"
    | "stopped";
  /**
   * Pull request the action belongs to, or null when it has none.
   */
  pullId: PullId | null;
  /**
   * Review rounds it took, or null when it had no review.
   */
  rounds: number | null;
  /**
   * Whether the action sent something outside the workspace. Such an action cannot be undone.
   */
  sentOutside: boolean;
}
/**
 * Check result for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * A burn resolved by the reader during this edition.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SettledBurn".
 */
export interface SettledBurn {
  /**
   * Action recorded in the topic’s history for Undo.
   */
  actionId: string;
  /**
   * Whether anything still needs attention.
   */
  detail: string;
  /**
   * Identifier of a lane.
   */
  laneId: string;
  /**
   * Status of the resolved burn.
   */
  stateWord: string;
  target: Target5;
  /**
   * Resolution text shown in the brief and in the receipt.
   */
  title: string;
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
    | "run"
    | "review"
    | "file"
    | "report"
    | "check"
    | "manager"
    | "brief"
    | "drafts"
    | "skills"
    | "settings";
}
/**
 * Aggregate progress without lanes, names, or private commentary.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SharedTopicStatus".
 */
export interface SharedTopicStatus {
  /**
   * Quantity needed to reach the goal.
   */
  goal: number | null;
  /**
   * Whether the topic is on track.
   */
  health: Health | null;
  /**
   * Topic heading visible to the reader.
   */
  name: string;
  /**
   * Time of the next status report.
   */
  nextReportAt: Timestamp | null;
  /**
   * Report that is due next, or null when none is scheduled.
   */
  nextReportId: ReportId | null;
  /**
   * Current progress toward the goal.
   */
  signed: number | null;
  /**
   * Identifier of a topic or project.
   */
  topicId: string;
  /**
   * Units used for the goal.
   */
  unit: string | null;
}
/**
 * Health for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Health".
 */
export interface Health {
  /**
   * Current state of the record.
   */
  state: "ok" | "warn" | "bad" | "idle";
  /**
   * Word for this record.
   */
  word: string;
}
/**
 * Spend line for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SpendLine".
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
 * A proposed change to a topic's spend cap.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "BudgetChange".
 */
export interface BudgetChange {
  from: Money6;
  /**
   * Period the cap covers, for example "week", or null when it has none.
   */
  period: string | null;
  to: Money7;
}
/**
 * Cap before the change.
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
 * Cap the proposal asks for.
 */
export interface Money7 {
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
 * Annotation at a category on the chart.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ChartMarker".
 */
export interface ChartMarker {
  /**
   * Label for this record.
   */
  label: string;
  /**
   * X for this record.
   */
  x: string;
}
/**
 * A point displayed in a decision chart.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ChartPoint".
 */
export interface ChartPoint {
  /**
   * X for this record.
   */
  x: string;
  /**
   * Y for this record.
   */
  y: number;
}
/**
 * One spot check, read by id: the fields of a [`SpotCheck`].
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "CheckView".
 */
export interface CheckView {
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  at: string;
  checker: Actor2;
  /**
   * Items that broke the rule.
   */
  failed: number;
  /**
   * Lane filed to fix what the check found, or null when none was.
   */
  followUpLaneId: LaneId | null;
  /**
   * Stable identifier of the check.
   */
  id: string;
  /**
   * How the check picked its sample.
   */
  kind: "random" | "periodic" | "numbers";
  /**
   * Lane whose work was checked, or null when the check spans lanes.
   */
  laneId: LaneId | null;
  /**
   * What the check found.
   */
  outcome: "held" | "failed" | "mixed";
  /**
   * Items that met the rule.
   */
  passed: number;
  /**
   * The rule the sample was checked against.
   */
  rule: string;
  /**
   * Size of the sample, or null when it is not a count.
   */
  sample: MeasuredValue | null;
  /**
   * Schedule that ran the check, or null for a one-off check.
   */
  scheduleId: ScheduleId | null;
  /**
   * Person or agent whose work was checked, or null when several.
   */
  subject: Actor1 | null;
  /**
   * The finding in words.
   */
  text: string;
  /**
   * Identifier of a topic or project.
   */
  topicId: string;
}
/**
 * A person or agent, resolved to the record the screens show.
 * Fields a particular card does not carry are null.
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
  kind: "person" | "agent";
  /**
   * Membership state, set for invited readers who have not joined.
   */
  membershipState?: MembershipState | null;
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
   * Short name. Agents show their full name, people their first name, and the viewer reads "You".
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
 * A currency amount in the currency's minor units.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Money".
 */
export interface Money8 {
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
 * A currency amount in the currency's minor units.
 */
export interface Money9 {
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
 * Context supplied by a composer when sending a message.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "TargetInput".
 */
export interface TargetInput {
  /**
   * Stable identifier for this record.
   */
  id: string | null;
  /**
   * Kind for this record.
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
    | "run"
    | "review"
    | "file"
    | "report"
    | "check"
    | "manager"
    | "brief"
    | "drafts"
    | "skills"
    | "settings";
}
/**
 * Partial layout written by `prefs.set`.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ThemePatch".
 */
export interface ThemePatch {
  /**
   * Glass for this record.
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
 * Context supplied by a composer when sending a message.
 */
export interface TargetInput1 {
  /**
   * Stable identifier for this record.
   */
  id: string | null;
  /**
   * Kind for this record.
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
    | "run"
    | "review"
    | "file"
    | "report"
    | "check"
    | "manager"
    | "brief"
    | "drafts"
    | "skills"
    | "settings";
}
/**
 * Receipt and sequenced updates produced by an accepted command.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  /**
   * Receipt for this record.
   */
  receipt: Receipt | null;
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
   * Person the message is written to, or null when it is for everyone in the thread. A message written to the previous stage holder names them, so the new holder's client can label it.
   */
  addressee: PersonId | null;
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  at: string;
  /**
   * Attachment for this record.
   */
  attachment: Attachment | null;
  /**
   * Topic-wide or stage-only distribution for this message.
   */
  audience:
    | {
        kind: "owner";
      }
    | {
        kind: "viewer";
        /**
         * Identifier of an actor, whether a person or an agent.
         */
        personId: string;
      }
    | {
        kind: "topic";
      }
    | {
        kind: "stage";
        /**
         * Name of the stage in the topic.
         */
        stage: string;
      };
  author: Actor3;
  /**
   * Identifier of the associated decision.
   */
  decisionId: DecisionId | null;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Label for this record.
   */
  label: MessageLabel | null;
  /**
   * Model for this record.
   */
  model: ModelId | null;
  /**
   * Page for this record.
   */
  page: Target | null;
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "MessageAction".
 */
export interface MessageAction {
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Label for this record.
   */
  label: string;
  /**
   * Identifier of a lane.
   */
  laneId: string;
  /**
   * Identifier of the associated person.
   */
  personId: PersonId | null;
}
/**
 * A person or agent, resolved to the record the screens show.
 * Fields a particular card does not carry are null.
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
  kind: "person" | "agent";
  /**
   * Membership state, set for invited readers who have not joined.
   */
  membershipState?: MembershipState | null;
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
   * Short name. Agents show their full name, people their first name, and the viewer reads "You".
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  kind: "question" | "request" | "done" | "decision" | "goalChange";
  /**
   * Pinned for this record.
   */
  pinned: boolean;
}
/**
 * Read back for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ReadBack".
 */
export interface ReadBack {
  /**
   * A point in time with an RFC 3339 UTC offset.
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Message".
 */
export interface Message1 {
  /**
   * Actions for this record.
   */
  actions: MessageAction[];
  /**
   * Person the message is written to, or null when it is for everyone in the thread. A message written to the previous stage holder names them, so the new holder's client can label it.
   */
  addressee: PersonId | null;
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  at: string;
  /**
   * Attachment for this record.
   */
  attachment: Attachment | null;
  /**
   * Topic-wide or stage-only distribution for this message.
   */
  audience:
    | {
        kind: "owner";
      }
    | {
        kind: "viewer";
        /**
         * Identifier of an actor, whether a person or an agent.
         */
        personId: string;
      }
    | {
        kind: "topic";
      }
    | {
        kind: "stage";
        /**
         * Name of the stage in the topic.
         */
        stage: string;
      };
  author: Actor3;
  /**
   * Identifier of the associated decision.
   */
  decisionId: DecisionId | null;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Label for this record.
   */
  label: MessageLabel | null;
  /**
   * Model for this record.
   */
  model: ModelId | null;
  /**
   * Page for this record.
   */
  page: Target | null;
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
 * Where the Manager filed a request.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Receipt".
 */
export interface Receipt {
  /**
   * Action addressable by Undo, when this receipt records a reversible action.
   */
  actionId: ActionId | null;
  /**
   * Chain for this record.
   */
  chain: boolean;
  /**
   * Filed under for this record.
   */
  filedUnder: Target | null;
  /**
   * Lanes filed together when the ask was split into independent parts. Empty when it was not split.
   */
  groupLaneIds: LaneId[];
  /**
   * Identifier of a lane.
   */
  laneId: string;
  lead: Actor4;
  /**
   * Text shown to the reader.
   */
  text: string;
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
  kind: "person" | "agent";
  /**
   * Membership state, set for invited readers who have not joined.
   */
  membershipState?: MembershipState | null;
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
   * Short name. Agents show their full name, people their first name, and the viewer reads "You".
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
 * Connection for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Connection".
 */
export interface Connection {
  /**
   * Capacity for this record.
   */
  capacity: MeasuredValue | null;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Purpose for this record.
   */
  purpose: string;
  /**
   * What the grant lets agents do, or null when the connection has no grant. The action gateway refuses a write beyond the scope.
   */
  scope: ConnectionScope | null;
  /**
   * Current state of the record.
   */
  state: "connected" | "signedIn" | "addKey" | "signIn";
}
/**
 * Deal for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  confidence: string | null;
  /**
   * Unit cost when the cohort is measured by cost per lead.
   */
  costPerLead: Money8 | null;
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
  target: Target6;
  /**
   * Value for this record.
   */
  value: MeasuredValue | null;
}
/**
 * Deal alt for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "DealAlt".
 */
export interface DealAlt {
  /**
   * Identifier of a decision.
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
    | "run"
    | "review"
    | "file"
    | "report"
    | "check"
    | "manager"
    | "brief"
    | "drafts"
    | "skills"
    | "settings";
}
/**
 * Position within the decision queue as seen by this reader.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "DecisionPosition".
 */
export interface DecisionPosition {
  /**
   * Index for this record.
   */
  index: number;
  /**
   * Of for this record.
   */
  of: number;
  /**
   * Open for this record.
   */
  open: number;
}
/**
 * Decision queue view for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "QueueItem".
 */
export interface QueueItem {
  /**
   * Goal change for this record.
   */
  goalChange: GoalChange | null;
  /**
   * Identifier of a decision.
   */
  id: string;
  /**
   * The manager or agent that proposed this, or null when the reader did.
   */
  proposer: Actor1 | null;
  /**
   * Current state of the record.
   */
  state: "open" | "approved" | "declined" | "expired";
  target: Target7;
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
 * Proposed change to the numeric goal for a topic.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "GoalChange".
 */
export interface GoalChange {
  /**
   * Affected topics for this record. Never the changed topic itself: the other topics that share a budget, a resource or a report with it.
   */
  affectedTopics: TopicId[];
  /**
   * Typed payload of a budget change, or null for any other field.
   */
  budget: BudgetChange | null;
  /**
   * Desired deadline, when it changes.
   */
  deadlineAt: Timestamp | null;
  /**
   * Field for this record.
   */
  field: "target" | "deadline" | "unit" | "budget" | "priority" | "guardrail";
  /**
   * Value before the change. For a typed payload it carries that payload's number: amountMinor, rank or limit value.
   */
  from: number;
  /**
   * Typed payload of a guardrail change, or null for any other field.
   */
  guardrail: GuardrailChange | null;
  /**
   * Original deadline when this proposal was written.
   */
  previousDeadlineAt: Timestamp | null;
  /**
   * Original unit when this proposal was written.
   */
  previousUnit: string | null;
  /**
   * Typed payload of a priority change, or null for any other field.
   */
  priority: PriorityChange | null;
  /**
   * Value the proposal asks for, as `from`.
   */
  to: number;
  /**
   * Identifier of a topic or project.
   */
  topicId: string;
  /**
   * Desired unit, when it changes.
   */
  unit: string | null;
}
/**
 * A proposed change to the limit of a guardrail.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "GuardrailChange".
 */
export interface GuardrailChange {
  /**
   * Numeric or machine-readable value rendered according to its measurement kind.
   */
  from:
    | {
        kind: "count";
        /**
         * Total, when presented as a fraction.
         */
        of: number | null;
        /**
         * Count unit or interval.
         */
        unit: string | null;
        /**
         * Observed count.
         */
        value: number;
      }
    | {
        kind: "rate";
        /**
         * Percentage points, e.g. 1.2 for 1.2%.
         */
        percent: number;
        /**
         * Whether the rate is the standard policy.
         */
        standard: boolean;
      }
    | {
        /**
         * Budget cap, when applicable.
         */
        cap: Money8 | null;
        kind: "money";
        money: Money9;
      }
    | {
        /**
         * A point in time with an RFC 3339 UTC offset.
         */
        at: string;
        kind: "time";
      }
    | {
        kind: "policy";
        /**
         * Rule expressed in words when it has no measurable threshold.
         */
        text: string;
      };
  /**
   * Guardrail the proposal changes.
   */
  guardrailId: string;
  /**
   * Name of the guardrail as the reader sees it.
   */
  name: string;
  /**
   * Numeric or machine-readable value rendered according to its measurement kind.
   */
  to:
    | {
        kind: "count";
        /**
         * Total, when presented as a fraction.
         */
        of: number | null;
        /**
         * Count unit or interval.
         */
        unit: string | null;
        /**
         * Observed count.
         */
        value: number;
      }
    | {
        kind: "rate";
        /**
         * Percentage points, e.g. 1.2 for 1.2%.
         */
        percent: number;
        /**
         * Whether the rate is the standard policy.
         */
        standard: boolean;
      }
    | {
        /**
         * Budget cap, when applicable.
         */
        cap: Money8 | null;
        kind: "money";
        money: Money9;
      }
    | {
        /**
         * A point in time with an RFC 3339 UTC offset.
         */
        at: string;
        kind: "time";
      }
    | {
        kind: "policy";
        /**
         * Rule expressed in words when it has no measurable threshold.
         */
        text: string;
      };
}
/**
 * A proposed change to a topic's rank among the topics of its module.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "PriorityChange".
 */
export interface PriorityChange {
  /**
   * Rank before the change (1 is first), or null when the topic had none.
   */
  from: number | null;
  /**
   * Rank the proposal asks for (1 is first).
   */
  to: number;
}
/**
 * An internal link resolved by the client.
 */
export interface Target7 {
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
    | "run"
    | "review"
    | "file"
    | "report"
    | "check"
    | "manager"
    | "brief"
    | "drafts"
    | "skills"
    | "settings";
}
/**
 * Decision right for the cockpit. A right with a daily limit counts what it has used today. At the limit the next item of that rule becomes a decision in Decide (the action gateway does this in the real hub).
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
   * Person explicitly granted this decision right. Topic work access by itself does not grant it.
   */
  personId: PersonId | null;
  /**
   * Time the count resets, or null when the right is yours.
   */
  resetsAt: Timestamp | null;
  /**
   * Risky for this record.
   */
  risky: boolean;
  /**
   * Decision rule for the cockpit.
   */
  rule: "inYourName" | "hardToUndo" | "onlyYouKnow" | "insideGuardrails" | "overWeeklyCap";
  /**
   * Title displayed above the record.
   */
  title: string;
  /**
   * Items decided under this right today, or null when the right is yours.
   */
  usedToday: number | null;
  /**
   * Who for this record.
   */
  who: "you" | "agent";
}
/**
 * The evidence, consequences and next steps for a decision.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
   * Change request for this record.
   */
  changeRequest: string | null;
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
   * A point in time with an RFC 3339 UTC offset.
   */
  dueAt: string;
  /**
   * Goal change for this record.
   */
  goalChange: GoalChange | null;
  /**
   * Guardrail for this record.
   */
  guardrail: string | null;
  /**
   * Identifier of a decision.
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
  position: DecisionPosition1;
  /**
   * Proof for this record.
   */
  proof: Proof | null;
  /**
   * The manager or agent that proposed this, or null when the reader did.
   */
  proposer: Actor1 | null;
  /**
   * Provenance for this record.
   */
  provenance: Provenance | null;
  /**
   * Release for this record.
   */
  release: Release | null;
  /**
   * Risk for this record.
   */
  risk: Scenario | null;
  /**
   * Decision right that governs approval, decline and Undo.
   */
  rule: DecisionRule | null;
  /**
   * Short title for this record.
   */
  shortTitle: string;
  /**
   * Current state of the record.
   */
  state: "open" | "approved" | "declined" | "expired";
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "NextStep".
 */
export interface NextStep {
  /**
   * Time the step finished, or null while it is not done.
   */
  doneAt: Timestamp | null;
  /**
   * Time an answer or action is due.
   */
  dueAt: Timestamp | null;
  /**
   * Module to open when the next step crosses into another module.
   */
  moduleId: ModuleId | null;
  /**
   * Whether the step is done, under way or still to do, or null when it is not tracked.
   */
  state: StepKind | null;
  /**
   * Step for this record.
   */
  step: string;
  /**
   * Destination to open in the cockpit.
   */
  target: Target | null;
  /**
   * Who for this record.
   */
  who: string;
}
/**
 * Stat for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Stat".
 */
export interface Stat {
  /**
   * Label for this record.
   */
  label: string;
  /**
   * Money for this record.
   */
  money: Money8 | null;
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Scenario".
 */
export interface Scenario {
  /**
   * Axis for this record.
   */
  axis: number[];
  /**
   * Baseline for this record.
   */
  baseline: ChartPoint[];
  /**
   * Legend for the unchanged comparison.
   */
  baselineLabel: string;
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
  kind: "opportunity" | "risk";
  /**
   * Label for this record.
   */
  label: string;
  /**
   * Marker for this record.
   */
  marker: ChartMarker | null;
  /**
   * Series for this record.
   */
  series: ChartPoint[];
  /**
   * Legend for the projected series.
   */
  seriesLabel: string;
  /**
   * Summary for this record.
   */
  summary: string;
  /**
   * Unit for this record.
   */
  unit: string;
}
/**
 * Position for this record.
 */
export interface DecisionPosition1 {
  /**
   * Index for this record.
   */
  index: number;
  /**
   * Of for this record.
   */
  of: number;
  /**
   * Open for this record.
   */
  open: number;
}
/**
 * Proof for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * Staged rollout linked to the decision.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Release".
 */
export interface Release {
  /**
   * Percent for this record.
   */
  percent: number;
  /**
   * Identifier of a pull request.
   */
  pullId: string;
  /**
   * Rollback trigger for this record.
   */
  rollbackTrigger: string;
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  scheduledAt: string;
  /**
   * Stage for this record.
   */
  stage: "scheduled" | "rolling" | "watching" | "done" | "held" | "rolledBack";
  /**
   * Time associated with started.
   */
  startedAt: Timestamp | null;
  /**
   * Watch minutes for this record.
   */
  watchMinutes: number;
}
/**
 * Draft for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
   * Identifier of the associated lane.
   */
  laneId: LaneId | null;
  /**
   * Open url for this record.
   */
  openUrl: string;
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
   * Person the message is written to, or null when it is for everyone in the thread. A message written to the previous stage holder names them, so the new holder's client can label it.
   */
  addressee: PersonId | null;
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  at: string;
  /**
   * Attachment for this record.
   */
  attachment: Attachment | null;
  /**
   * Topic-wide or stage-only distribution for this message.
   */
  audience:
    | {
        kind: "owner";
      }
    | {
        kind: "viewer";
        /**
         * Identifier of an actor, whether a person or an agent.
         */
        personId: string;
      }
    | {
        kind: "topic";
      }
    | {
        kind: "stage";
        /**
         * Name of the stage in the topic.
         */
        stage: string;
      };
  author: Actor3;
  /**
   * Identifier of the associated decision.
   */
  decisionId: DecisionId | null;
  /**
   * Stable identifier for this record.
   */
  id: string;
  /**
   * Label for this record.
   */
  label: MessageLabel | null;
  /**
   * Model for this record.
   */
  model: ModelId | null;
  /**
   * Page for this record.
   */
  page: Target | null;
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Fact".
 */
export interface Fact {
  /**
   * Label for this record.
   */
  label: string;
  /**
   * Numeric or machine-readable value rendered according to its measurement kind.
   */
  value:
    | {
        kind: "count";
        /**
         * Total, when presented as a fraction.
         */
        of: number | null;
        /**
         * Count unit or interval.
         */
        unit: string | null;
        /**
         * Observed count.
         */
        value: number;
      }
    | {
        kind: "rate";
        /**
         * Percentage points, e.g. 1.2 for 1.2%.
         */
        percent: number;
        /**
         * Whether the rate is the standard policy.
         */
        standard: boolean;
      }
    | {
        /**
         * Budget cap, when applicable.
         */
        cap: Money8 | null;
        kind: "money";
        money: Money9;
      }
    | {
        /**
         * A point in time with an RFC 3339 UTC offset.
         */
        at: string;
        kind: "time";
      }
    | {
        kind: "policy";
        /**
         * Rule expressed in words when it has no measurable threshold.
         */
        text: string;
      };
}
/**
 * Failing test for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  of: number | null;
  /**
   * Value for this record.
   */
  value: number | null;
}
/**
 * Forecast and its later outcome, for calibration.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Forecast".
 */
export interface Forecast {
  /**
   * What was measured when the forecast was scored, or null before then.
   */
  actual: MeasuredValue | null;
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  givenAt: string;
  /**
   * Whether the forecast held when scored, or null before then.
   */
  held: boolean | null;
  /**
   * High end of the forecast range, or null when it has none.
   */
  high: MeasuredValue | null;
  /**
   * Stable identifier of the forecast, or null when it has none.
   */
  id: string | null;
  /**
   * Low end of the forecast range, or null when it has none.
   */
  low: MeasuredValue | null;
  /**
   * Outcome for this record. Empty until the forecast is scored.
   */
  outcome: string;
  /**
   * Time the forecast is scored, or null when it is not scheduled.
   */
  scoreAt: Timestamp | null;
  /**
   * Time the forecast was scored, or null before then.
   */
  scoredAt: Timestamp | null;
  /**
   * The forecast value, or null when the forecast is only a word.
   */
  value: MeasuredValue | null;
  /**
   * Word for this record.
   */
  word: string;
}
/**
 * Funnel for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Funnel".
 */
export interface Funnel {
  /**
   * Since for this record.
   */
  since: string;
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  sinceAt: string;
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "FunnelStep".
 */
export interface FunnelStep {
  /**
   * Change for this record.
   */
  change: MeasuredValue | null;
  /**
   * Count for this record.
   */
  count: number;
  /**
   * Rate for this record.
   */
  rate: FunnelRate | null;
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
 * Conversion rate or plan for a funnel stage.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "FunnelRate".
 */
export interface FunnelRate {
  /**
   * Time the plan’s count is due.
   */
  dueAt: Timestamp | null;
  /**
   * Observed conversion percentage.
   */
  percent: number | null;
  /**
   * Planned conversion percentage.
   */
  planPercent: number | null;
  /**
   * Planned count by the milestone date.
   */
  plannedCount: number | null;
}
/**
 * Gap for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
   * Person or agent that reviewed, or null when the gate is not a review.
   */
  reviewer: Actor1 | null;
  /**
   * Review round the gate belongs to, or null when it is not a review.
   */
  round: number | null;
  /**
   * CI run record the gate was read from, or null when it has none.
   */
  runId: RecordId | null;
  /**
   * Current state of the record.
   */
  state: "pass" | "running" | "todo" | "fail" | "skipped";
}
/**
 * Goal for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Goal".
 */
export interface Goal {
  /**
   * Blockers for this record.
   */
  blockers: Blocker[];
  /**
   * Calibration for this record.
   */
  calibration: string | null;
  /**
   * How well the forecasts have held so far, or null before one is scored.
   */
  calibrationScore: MeasuredValue | null;
  /**
   * Calm for this record.
   */
  calm: string | null;
  /**
   * Calm sub for this record.
   */
  calmSub: string | null;
  /**
   * Deadline for reaching the goal.
   */
  deadlineAt: Timestamp | null;
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
   * Forecast log for this record.
   */
  forecastLog: Forecast[];
  /**
   * Assessment context written alongside the forecast.
   */
  forecastNote: string | null;
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
   * Time the next forecast is scored, or null when none is waiting.
   */
  nextScoreAt: Timestamp | null;
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
   * Quantity the topic aims to achieve by its deadline.
   */
  target: number;
  trajectory: Trajectory;
  /**
   * Unit for this record.
   */
  unit: string;
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  updatedAt: string;
  verdict: Verdict;
}
/**
 * Goal decision for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  done: string | null;
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "GuardrailItem".
 */
export interface GuardrailItem {
  /**
   * What happens when the guardrail is breached, or null when it only reports.
   */
  action: GuardrailAction | null;
  /**
   * Stable identifier of the guardrail, or null when it has none.
   */
  id: string | null;
  /**
   * Numeric or machine-readable value rendered according to its measurement kind.
   */
  limit:
    | {
        kind: "count";
        /**
         * Total, when presented as a fraction.
         */
        of: number | null;
        /**
         * Count unit or interval.
         */
        unit: string | null;
        /**
         * Observed count.
         */
        value: number;
      }
    | {
        kind: "rate";
        /**
         * Percentage points, e.g. 1.2 for 1.2%.
         */
        percent: number;
        /**
         * Whether the rate is the standard policy.
         */
        standard: boolean;
      }
    | {
        /**
         * Budget cap, when applicable.
         */
        cap: Money8 | null;
        kind: "money";
        money: Money9;
      }
    | {
        /**
         * A point in time with an RFC 3339 UTC offset.
         */
        at: string;
        kind: "time";
      }
    | {
        kind: "policy";
        /**
         * Rule expressed in words when it has no measurable threshold.
         */
        text: string;
      };
  /**
   * Ratio for this record.
   */
  ratio: number | null;
  /**
   * Current state of the record.
   */
  state: "held" | "near" | "breached";
  /**
   * Switch on the Skills page that turns this guardrail on or off, or null when it has none.
   */
  switchId: string | null;
  /**
   * Numeric or machine-readable value rendered according to its measurement kind.
   */
  value:
    | {
        kind: "count";
        /**
         * Total, when presented as a fraction.
         */
        of: number | null;
        /**
         * Count unit or interval.
         */
        unit: string | null;
        /**
         * Observed count.
         */
        value: number;
      }
    | {
        kind: "rate";
        /**
         * Percentage points, e.g. 1.2 for 1.2%.
         */
        percent: number;
        /**
         * Whether the rate is the standard policy.
         */
        standard: boolean;
      }
    | {
        /**
         * Budget cap, when applicable.
         */
        cap: Money8 | null;
        kind: "money";
        money: Money9;
      }
    | {
        /**
         * A point in time with an RFC 3339 UTC offset.
         */
        at: string;
        kind: "time";
      }
    | {
        kind: "policy";
        /**
         * Rule expressed in words when it has no measurable threshold.
         */
        text: string;
      };
  /**
   * What for this record.
   */
  what: string;
}
/**
 * Ladder rung for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  state: "ok" | "warn" | "bad" | "idle";
  /**
   * Text shown to the reader.
   */
  text: string | null;
  /**
   * Word for this record.
   */
  word: string;
}
/**
 * Guardrail switch for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "GuardrailSwitch".
 */
export interface GuardrailSwitch {
  /**
   * What happens when the guardrail is breached, or null when it only reports.
   */
  action: GuardrailAction | null;
  /**
   * Explanation shown alongside the summary.
   */
  detail: string;
  /**
   * Stable identifier of the guardrail, or null when it has none.
   */
  id: string | null;
  /**
   * The limit the switch guards, or null when it has none.
   */
  limit: MeasuredValue | null;
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * On for this record.
   */
  on: boolean;
  /**
   * Topic the guardrail covers, or null when it is workspace-wide.
   */
  topicId: TopicId | null;
}
/**
 * Handover for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Handover".
 */
export interface Handover {
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  at: string;
  /**
   * Time associated with confirmed.
   */
  confirmedAt: Timestamp | null;
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
 * History day for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  kind: "person" | "agent";
  /**
   * Membership state, set for invited readers who have not joined.
   */
  membershipState?: MembershipState | null;
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
   * Short name. Agents show their full name, people their first name, and the viewer reads "You".
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "HistoryPage".
 */
export interface HistoryPage {
  /**
   * Days for this record.
   */
  days: HistoryDay[];
  /**
   * Number of matching rows newer than the reader’s last visit, across all pages.
   */
  newSince: number;
  /**
   * Opaque cursor for the following page, or null at the end.
   */
  nextCursor: string | null;
  seen: SeenMarker1;
  /**
   * Number of activity rows in this page.
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
export interface SeenMarker1 {
  /**
   * Time of the visit.
   */
  at: Timestamp | null;
}
/**
 * Job for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Job".
 */
export interface Job {
  /**
   * Agent for this record.
   */
  agent: string;
  /**
   * How an undated job is scheduled.
   */
  cadence: JobCadence | null;
  /**
   * Time the job finished.
   */
  completedAt: Timestamp | null;
  /**
   * Time the job must finish, when it has a deadline.
   */
  dueAt: Timestamp | null;
  /**
   * Job for this record.
   */
  job: string;
  /**
   * Identifier of the associated lane.
   */
  laneId: LaneId | null;
  /**
   * Schedule that runs the job, or null when it is not scheduled.
   */
  scheduleId: ScheduleId | null;
  /**
   * Lane state for the cockpit.
   */
  state: "new" | "ok" | "warn" | "bad" | "done" | "idle" | "next" | "parked";
}
/**
 * Lane act for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "LaneAct".
 */
export interface LaneAct {
  /**
   * Identifier of an action recorded in history.
   */
  id: string;
  /**
   * Label for this record.
   */
  label: string;
  /**
   * Identifier of the associated person.
   */
  personId: PersonId | null;
  /**
   * Destination to open in the cockpit.
   */
  target: Target | null;
  /**
   * Tone for this record.
   */
  tone: "ink" | "quiet";
}
/**
 * A work item and its record of progress. The lane's chat is shared with whoever works the lane.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
   * Time for the next step after approval.
   */
  afterNextAt: Timestamp | null;
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
   * Attachment for this record.
   */
  attachment: Attachment | null;
  /**
   * Chain for this record.
   */
  chain: boolean;
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
   * Group the lane was split into with its sibling lanes, or null when it was not split.
   */
  groupId: string | null;
  /**
   * Handover for this record.
   */
  handover: Handover | null;
  /**
   * Identifier of a lane.
   */
  id: string;
  lead: Actor6;
  /**
   * Name of the lead as a topic's lane row shows it ("Brand scout", "Jonas", "You").
   */
  leadName: string | null;
  /**
   * Made for this record.
   */
  made: MadeItem[];
  /**
   * Model for this record.
   */
  model: ModelId | null;
  /**
   * Next for this record.
   */
  next: string | null;
  /**
   * Time the next report or action is due.
   */
  nextAt: Timestamp | null;
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  openedAt: string;
  /**
   * Recommendation for this record.
   */
  recommendation: string | null;
  /**
   * Reminder for this record.
   */
  reminder: Reminder | null;
  /**
   * Schedule that filed the lane, or null when it was not filed by one.
   */
  scheduleId: ScheduleId | null;
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
  state: "new" | "ok" | "warn" | "bad" | "done" | "idle" | "next" | "parked";
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
   * Tries used out of the tries allowed, or null when the lane does not retry.
   */
  tries: MeasuredValue | null;
  /**
   * Waits for for this record.
   */
  waitsFor: Actor1 | null;
  /**
   * Shared resource the lane waits on, or null when it waits on none.
   */
  waitsOnResource: string | null;
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
export interface Actor6 {
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
  kind: "person" | "agent";
  /**
   * Membership state, set for invited readers who have not joined.
   */
  membershipState?: MembershipState | null;
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
   * Short name. Agents show their full name, people their first name, and the viewer reads "You".
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * A reminder to the person holding up a lane.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Reminder".
 */
export interface Reminder {
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  at: string;
  /**
   * Identifier of an actor, whether a person or an agent.
   */
  personId: string;
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Step".
 */
export interface Step {
  /**
   * Time the step finished, or null while it is not done.
   */
  doneAt: Timestamp | null;
  /**
   * Step kind for the cockpit.
   */
  kind: "ok" | "now" | "todo";
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * A staging run, CI run, review or file opened from the work it records. Every target a lane's made items point at resolves to one of these, never to the lane itself.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "MadeRecordView".
 */
export interface MadeRecordView {
  /**
   * Checks the run made; empty for a record that is not a run.
   */
  checks: CheckResult[];
  /**
   * Result shown in the record.
   */
  detail: string;
  /**
   * Time the run finished, or null while it runs or when it is not a run.
   */
  finishedAt: Timestamp | null;
  /**
   * Identifier of a staging run or review record.
   */
  id: string;
  /**
   * Category of the review or run.
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
    | "run"
    | "review"
    | "file"
    | "report"
    | "check"
    | "manager"
    | "brief"
    | "drafts"
    | "skills"
    | "settings";
  /**
   * Identifier of a lane.
   */
  laneId: string;
  /**
   * The failing test the run stopped on, or null when none failed.
   */
  log: FailingTest | null;
  /**
   * Pull request the run belongs to, or null when it ran outside one.
   */
  pullId: PullId | null;
  /**
   * Time the run started, or null for a record that is not a run.
   */
  startedAt: Timestamp | null;
  /**
   * Outcome of the run, or null for a record that is not a run.
   */
  state: GateState | null;
  /**
   * Heading of the record.
   */
  title: string;
  /**
   * What started a run, in words, or null for a review or file.
   */
  trigger: string | null;
  /**
   * Link to the file, draft or page the record points at, or null when it has none.
   */
  url: string | null;
}
/**
 * Manager lane for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
   * Time the next report or action is due.
   */
  nextAt: Timestamp | null;
  /**
   * Reason for this record.
   */
  reason: string | null;
  /**
   * Lane state for the cockpit.
   */
  state: "new" | "ok" | "warn" | "bad" | "done" | "idle" | "next" | "parked";
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
   * Recurring schedules of the workspace.
   */
  schedules: Schedule[];
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
 * A recurring rule that files a lane, writes a report, runs a spot check or publishes a brief.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Schedule".
 */
export interface Schedule {
  /**
   * Identifier of a recurring schedule.
   */
  id: string;
  /**
   * What the schedule runs when it fires.
   */
  kind: "lane" | "report" | "check" | "brief";
  /**
   * Time of the last run, or null when it has not run yet.
   */
  lastAt: Timestamp | null;
  /**
   * Lane the last run filed, or null when it filed none.
   */
  lastLaneId: LaneId | null;
  /**
   * Time of the next run, or null when the schedule is off.
   */
  nextAt: Timestamp | null;
  /**
   * Whether the schedule is switched on.
   */
  on: boolean;
  opener: Actor7;
  /**
   * Recurrence as an RFC 5545 rule, read in the workspace time zone.
   */
  rrule: string;
  /**
   * Where the schedule came from, in words.
   */
  source: string;
  /**
   * The recurrence in words.
   */
  text: string;
  /**
   * Local time of day the schedule fires ("HH:MM"), or null when the rule has no fixed time.
   */
  time: string | null;
  /**
   * Name of the schedule as the reader sees it.
   */
  title: string;
  /**
   * Topic the schedule belongs to, or null when it covers the whole workspace.
   */
  topicId: TopicId | null;
}
/**
 * A person or agent, resolved to the record the screens show.
 * Fields a particular card does not carry are null.
 */
export interface Actor7 {
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
  kind: "person" | "agent";
  /**
   * Membership state, set for invited readers who have not joined.
   */
  membershipState?: MembershipState | null;
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
   * Short name. Agents show their full name, people their first name, and the viewer reads "You".
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
 * Shared resource for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SharedResource".
 */
export interface SharedResource {
  /**
   * Icon for this record.
   */
  icon: string;
  /**
   * Stable identifier of the resource, or null when it has none.
   */
  id: string | null;
  /**
   * Lanes that use the resource.
   */
  laneIds: LaneId[];
  /**
   * Number of lanes that use the resource. Equals `laneIds.len()`.
   */
  lanes: number;
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Order in which the lanes take their turn.
   */
  order: LaneId[];
  /**
   * Use of the resource against its quota, for example 18 of 40 sends today, or null when it has none.
   */
  quota: MeasuredValue | null;
  /**
   * People and agents that only read the resource.
   */
  readers: Actor1[];
  /**
   * Time the quota resets, or null when it does not.
   */
  resetsAt: Timestamp | null;
  /**
   * Rule for this record.
   */
  rule: string;
  /**
   * Lane whose turn it is, or null when the resource is free.
   */
  turn: LaneId | null;
  /**
   * People and agents that write to the resource.
   */
  writers: Actor1[];
}
/**
 * A person in the workspace, with the access they hold.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Member".
 */
export interface Member {
  /**
   * Access the person holds on each topic.
   */
  access: OtherTopicAccess[];
  /**
   * Address used for the person's invitations, or null when unknown.
   */
  email: string | null;
  /**
   * Time the person was invited, or null when they were not invited.
   */
  invitedAt: Timestamp | null;
  /**
   * Time the person joined, or null while the invitation is pending.
   */
  joinedAt: Timestamp | null;
  /**
   * Whether the person owns the workspace.
   */
  owner: boolean;
  person: Actor8;
  /**
   * Role in the workspace, or null when none is set.
   */
  role: string | null;
}
/**
 * A person or agent, resolved to the record the screens show.
 * Fields a particular card does not carry are null.
 */
export interface Actor8 {
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
  kind: "person" | "agent";
  /**
   * Membership state, set for invited readers who have not joined.
   */
  membershipState?: MembershipState | null;
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
   * Short name. Agents show their full name, people their first name, and the viewer reads "You".
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
 * Everyone in the workspace and the invitations still open. Only the owner can read it.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "MembersView".
 */
export interface MembersView {
  /**
   * Invitations across the workspace.
   */
  invitations: Invitation[];
  /**
   * Active and invited members.
   */
  items: Member[];
}
/**
 * Meter for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Meter".
 */
export interface Meter {
  /**
   * Cap for this record.
   */
  cap: Money8 | null;
  /**
   * Exact counts for meters measured in requests.
   */
  count: MeterCount | null;
  /**
   * Note for this record.
   */
  note: string | null;
  /**
   * Time associated with resets.
   */
  resetsAt: Timestamp | null;
  /**
   * Spend for this record.
   */
  spend: Money8 | null;
  /**
   * Used for this record.
   */
  used: number;
  /**
   * What for this record.
   */
  what: string;
}
/**
 * Model offered by the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Model".
 */
export interface Model {
  /**
   * Identifier of a selectable model.
   */
  id: string;
  /**
   * Display name.
   */
  name: string;
  /**
   * Current availability.
   */
  state: ModelState | null;
  /**
   * Engine vendor.
   */
  vendor: string | null;
}
/**
 * Choices available for a new request.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ModuleInfo".
 */
export interface ModuleInfo {
  /**
   * Icon for this record.
   */
  icon: string;
  /**
   * Available cockpit modules.
   */
  id: "gtm" | "dev";
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
 * Night stat for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "NightStat".
 */
export interface NightStat {
  /**
   * Label for this record.
   */
  label: string;
  /**
   * Numeric or machine-readable value rendered according to its measurement kind.
   */
  value:
    | {
        kind: "count";
        /**
         * Total, when presented as a fraction.
         */
        of: number | null;
        /**
         * Count unit or interval.
         */
        unit: string | null;
        /**
         * Observed count.
         */
        value: number;
      }
    | {
        kind: "rate";
        /**
         * Percentage points, e.g. 1.2 for 1.2%.
         */
        percent: number;
        /**
         * Whether the rate is the standard policy.
         */
        standard: boolean;
      }
    | {
        /**
         * Budget cap, when applicable.
         */
        cap: Money8 | null;
        kind: "money";
        money: Money9;
      }
    | {
        /**
         * A point in time with an RFC 3339 UTC offset.
         */
        at: string;
        kind: "time";
      }
    | {
        kind: "policy";
        /**
         * Rule expressed in words when it has no measurable threshold.
         */
        text: string;
      };
}
/**
 * Pin for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Pin".
 */
export interface Pin {
  /**
   * Badge for this record.
   */
  badge: boolean;
  /**
   * Current open decision count for the Decide pin.
   */
  badgeCount: number | null;
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
  kind: "page" | "topic" | "project" | "skill";
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  state: "waiting" | "approved" | "declined" | "expired" | "stuck";
  /**
   * Title displayed above the record.
   */
  title: string;
}
/**
 * Plan for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  state: "done" | "next" | "now" | "wait";
  /**
   * Summary for this record.
   */
  summary: string;
}
/**
 * Stage alt for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  kind: "person" | "agent";
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
  state: "new" | "ok" | "warn" | "bad" | "done" | "idle" | "next" | "parked";
  /**
   * Destination to open in the cockpit.
   */
  target: Target | null;
  /**
   * Text shown to the reader.
   */
  text: string;
  /**
   * Numeric or machine-readable value rendered according to its measurement kind.
   */
  when:
    | {
        kind: "count";
        /**
         * Total, when presented as a fraction.
         */
        of: number | null;
        /**
         * Count unit or interval.
         */
        unit: string | null;
        /**
         * Observed count.
         */
        value: number;
      }
    | {
        kind: "rate";
        /**
         * Percentage points, e.g. 1.2 for 1.2%.
         */
        percent: number;
        /**
         * Whether the rate is the standard policy.
         */
        standard: boolean;
      }
    | {
        /**
         * Budget cap, when applicable.
         */
        cap: Money8 | null;
        kind: "money";
        money: Money9;
      }
    | {
        /**
         * A point in time with an RFC 3339 UTC offset.
         */
        at: string;
        kind: "time";
      }
    | {
        kind: "policy";
        /**
         * Rule expressed in words when it has no measurable threshold.
         */
        text: string;
      };
  /**
   * Who for this record.
   */
  who: string;
}
/**
 * Row alt for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  when: MeasuredValue | null;
}
/**
 * Pull request for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "PullRequest".
 */
export interface PullRequest {
  /**
   * Author for this record.
   */
  author: string;
  /**
   * Time associated with auto merge.
   */
  autoMergeAt: Timestamp | null;
  /**
   * Identifier of the associated decision.
   */
  decisionId: DecisionId | null;
  /**
   * Gates for this record.
   */
  gates: Gate[];
  /**
   * Held for this record.
   */
  held: boolean;
  /**
   * Identifier of a pull request.
   */
  id: string;
  /**
   * Identifier of the associated lane.
   */
  laneId: LaneId | null;
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
   * Current state of the record.
   */
  state: "ready" | "blocked" | "inReview" | "autoMerge" | "releasing" | "released" | "held";
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * A page the reader opened recently.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "RecentPage".
 */
export interface RecentPage {
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  at: string;
  target: Target8;
  /**
   * Display label for the page.
   */
  title: string;
}
/**
 * An internal link resolved by the client.
 */
export interface Target8 {
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
    | "run"
    | "review"
    | "file"
    | "report"
    | "check"
    | "manager"
    | "brief"
    | "drafts"
    | "skills"
    | "settings";
}
/**
 * Recent pages for the current reader, newest first.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "RecentView".
 */
export interface RecentView {
  /**
   * Last six distinct pages.
   *
   * @maxItems 6
   */
  items: RecentPage[];
}
/**
 * A status report a topic sends to its recipients on a schedule.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Report".
 */
export interface Report {
  /**
   * Person or agent that checked the numbers, or null when unchecked.
   */
  checkedBy: Actor1 | null;
  /**
   * Draft that holds the written report, or null before one exists.
   */
  draftId: DraftId | null;
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  dueAt: string;
  /**
   * Identifier of a status report.
   */
  id: string;
  /**
   * Start of the period the report covers, or null when it has none.
   */
  periodFrom: Timestamp | null;
  /**
   * End of the period the report covers, or null when it has none.
   */
  periodTo: Timestamp | null;
  /**
   * People who receive the report.
   */
  recipients: Actor1[];
  /**
   * Schedule that produces the report, or null when it was written once.
   */
  scheduleId: ScheduleId | null;
  /**
   * Time the report was sent, or null while it is not sent.
   */
  sentAt: Timestamp | null;
  /**
   * Where the report is in its cycle.
   */
  state: "scheduled" | "drafting" | "drafted" | "sent" | "skipped";
  /**
   * Title of the report.
   */
  title: string;
  /**
   * Identifier of a topic or project.
   */
  topicId: string;
  writer: Actor9;
}
/**
 * A person or agent, resolved to the record the screens show.
 * Fields a particular card does not carry are null.
 */
export interface Actor9 {
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
  kind: "person" | "agent";
  /**
   * Membership state, set for invited readers who have not joined.
   */
  membershipState?: MembershipState | null;
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
   * Short name. Agents show their full name, people their first name, and the viewer reads "You".
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
 * One report, read by id: the fields of a [`Report`].
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ReportView".
 */
export interface ReportView {
  /**
   * Person or agent that checked the numbers, or null when unchecked.
   */
  checkedBy: Actor1 | null;
  /**
   * Draft that holds the written report, or null before one exists.
   */
  draftId: DraftId | null;
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  dueAt: string;
  /**
   * Identifier of a status report.
   */
  id: string;
  /**
   * Start of the period the report covers, or null when it has none.
   */
  periodFrom: Timestamp | null;
  /**
   * End of the period the report covers, or null when it has none.
   */
  periodTo: Timestamp | null;
  /**
   * People who receive the report.
   */
  recipients: Actor1[];
  /**
   * Schedule that produces the report, or null when it was written once.
   */
  scheduleId: ScheduleId | null;
  /**
   * Time the report was sent, or null while it is not sent.
   */
  sentAt: Timestamp | null;
  /**
   * Where the report is in its cycle.
   */
  state: "scheduled" | "drafting" | "drafted" | "sent" | "skipped";
  /**
   * Title of the report.
   */
  title: string;
  /**
   * Identifier of a topic or project.
   */
  topicId: string;
  writer: Actor10;
}
/**
 * A person or agent, resolved to the record the screens show.
 * Fields a particular card does not carry are null.
 */
export interface Actor10 {
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
  kind: "person" | "agent";
  /**
   * Membership state, set for invited readers who have not joined.
   */
  membershipState?: MembershipState | null;
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
   * Short name. Agents show their full name, people their first name, and the viewer reads "You".
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
 * Route preview for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  kind: "topic" | "lane" | "person" | "decision" | "skill";
  /**
   * Lead for this record.
   */
  lead: Actor1 | null;
  /**
   * Current state of the record.
   */
  state: SearchState | null;
  /**
   * Sub for this record.
   */
  sub: string | null;
  target: Target9;
  /**
   * Title displayed above the record.
   */
  title: string;
  /**
   * Topics for this record.
   */
  topics: TopicId[];
}
/**
 * An internal link resolved by the client.
 */
export interface Target9 {
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
    | "run"
    | "review"
    | "file"
    | "report"
    | "check"
    | "manager"
    | "brief"
    | "drafts"
    | "skills"
    | "settings";
}
/**
 * A page of records matching the query and an optional answer. An empty query returns no results: the client builds the empty panel from /decisions, /brief, /recent and /skills.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * A person shown in the topic header without their private profile or work details.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SeenByFace".
 */
export interface SeenByFace {
  /**
   * Whether this person works on this topic or watches its status.
   */
  access: "work" | "view" | "locked";
  /**
   * Initials shown in the topic header.
   */
  avatar: string | null;
  /**
   * Identifier of an actor, whether a person or an agent.
   */
  id: string;
  /**
   * Person’s display name.
   */
  name: string;
  /**
   * The person has status access while they wait to accept their invitation.
   */
  pending: boolean;
}
/**
 * The reader's last visit to a topic or thread.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SeenMarker".
 */
export interface SeenMarker2 {
  /**
   * Time of the visit.
   */
  at: Timestamp | null;
}
/**
 * Editable cockpit preferences and decision rights.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  chatMode: "floating" | "sidebar";
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
  id: "ink" | "ember" | "sand" | "moss" | "tide" | "sky" | "iris" | "rose";
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  kind: "topic" | "project";
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SidebarLane".
 */
export interface SidebarLane {
  /**
   * Fresh for this record.
   */
  fresh: boolean;
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
  state: "new" | "ok" | "warn" | "bad" | "done" | "idle" | "next" | "parked";
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
   * Pin limit for this record.
   */
  pinLimit: number;
  /**
   * Pinnable for this record.
   */
  pinnable: Pin[];
  /**
   * Pins for this record.
   *
   * @maxItems 12
   */
  pins: Pin[];
}
/**
 * Since summary for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SinceSummary".
 */
export interface SinceSummary {
  /**
   * Lines computed from the current records, not stored: a settled item drops out and an open goal change is named.
   */
  lines: string[];
  seen: SeenMarker3;
}
/**
 * Seen for this record.
 */
export interface SeenMarker3 {
  /**
   * Time of the visit.
   */
  at: Timestamp | null;
}
/**
 * Skill for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "Skill".
 */
export interface Skill {
  /**
   * Asks first for this record.
   */
  asksFirst: boolean;
  /**
   * Built in for this record.
   */
  builtIn: boolean;
  /**
   * Enabled for this record.
   */
  enabled: boolean;
  /**
   * Engine for this record.
   */
  engine: string | null;
  /**
   * Stable identifier for this record.
   */
  id: string;
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * A check of a sample of finished work against a rule.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "SpotCheck".
 */
export interface SpotCheck {
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  at: string;
  checker: Actor11;
  /**
   * Items that broke the rule.
   */
  failed: number;
  /**
   * Lane filed to fix what the check found, or null when none was.
   */
  followUpLaneId: LaneId | null;
  /**
   * Identifier of a spot check.
   */
  id: string;
  /**
   * How the check picked its sample.
   */
  kind: "random" | "periodic" | "numbers";
  /**
   * Lane whose work was checked, or null when the check spans lanes.
   */
  laneId: LaneId | null;
  /**
   * What the check found.
   */
  outcome: "held" | "failed" | "mixed";
  /**
   * Items that met the rule.
   */
  passed: number;
  /**
   * The rule the sample was checked against.
   */
  rule: string;
  /**
   * Size of the sample, or null when it is not a count.
   */
  sample: MeasuredValue | null;
  /**
   * Schedule that ran the check, or null for a one-off check.
   */
  scheduleId: ScheduleId | null;
  /**
   * Person or agent whose work was checked, or null when several.
   */
  subject: Actor1 | null;
  /**
   * The finding in words.
   */
  text: string;
  /**
   * Identifier of a topic or project.
   */
  topicId: string;
}
/**
 * A person or agent, resolved to the record the screens show.
 * Fields a particular card does not carry are null.
 */
export interface Actor11 {
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
  kind: "person" | "agent";
  /**
   * Membership state, set for invited readers who have not joined.
   */
  membershipState?: MembershipState | null;
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
   * Short name. Agents show their full name, people their first name, and the viewer reads "You".
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
 * Aggregated progress in one stage, without names or work records.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "StageStatus".
 */
export interface StageStatus {
  /**
   * Name of the stage.
   */
  name: string;
  /**
   * Progress from 0 to 100.
   */
  percent: number;
}
/**
 * Standing for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "StuckAction".
 */
export interface StuckAction {
  /**
   * Identifier of an action recorded in history.
   */
  id: string;
  /**
   * Label for this record.
   */
  label: string;
  /**
   * Identifier of a lane.
   */
  laneId: string;
  /**
   * Destination to open in the cockpit.
   */
  target: Target | null;
  /**
   * Tone for this record.
   */
  tone: "ink" | "quiet";
}
/**
 * Stuck report for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
   * CI run the report was written from, or null when it names none. The action "Open the run" targets it.
   */
  runId: RecordId | null;
  /**
   * A point in time with an RFC 3339 UTC offset.
   */
  sinceAt: string;
  /**
   * Title displayed above the record.
   */
  title: string;
  /**
   * Tries used out of the tries allowed, or null when the lane does not retry.
   */
  tries: MeasuredValue | null;
}
/**
 * Task row for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "TaskRow".
 */
export interface TaskRow {
  /**
   * Lane for this record.
   */
  lane: string;
  /**
   * Identifier of the associated lane.
   */
  laneId: LaneId | null;
  /**
   * Next for this record.
   */
  next: string;
  /**
   * Time the next report or action is due.
   */
  nextAt: Timestamp | null;
  /**
   * Reason for this record.
   */
  reason: string | null;
  /**
   * Lane state for the cockpit.
   */
  state: "new" | "ok" | "warn" | "bad" | "done" | "idle" | "next" | "parked";
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  id: "ink" | "ember" | "sand" | "moss" | "tide" | "sky" | "iris" | "rose";
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ThreadView".
 */
export interface ThreadView {
  /**
   * Agents for this record.
   */
  agents: AgentsStrip | null;
  /**
   * Identifier of a conversation.
   */
  id: string;
  /**
   * Messages on this page, oldest first by `at`. In a lane thread the chat is shared with whoever works the lane.
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
   * Scope for this record.
   */
  scope: string | null;
  /**
   * Since for this record.
   */
  since: SinceSummary | null;
  /**
   * Sub for this record.
   */
  sub: string | null;
  /**
   * Suggestions the composer offers. A suggestion sent as written is answered from the record and never files a lane.
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
   * Time the next report or action is due.
   */
  nextAt: Timestamp | null;
  /**
   * Lane state for the cockpit.
   */
  state: "new" | "ok" | "warn" | "bad" | "done" | "idle" | "next" | "parked";
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  nextReportAt: Timestamp | null;
  /**
   * Report that is due next, or null when none is scheduled.
   */
  nextReportId: ReportId | null;
  /**
   * Owner line for this record.
   */
  ownerLine: string | null;
  /**
   * Parts for this record.
   */
  parts: string[];
  /**
   * Rank among the topics of the module (1 is first), or null when the topic has none.
   */
  priority: number | null;
}
/**
 * Redacted progress shared through an organization-only status link.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "TopicStatusView".
 */
export interface TopicStatusView {
  /**
   * Target quantity in the status summary.
   */
  goal: number | null;
  /**
   * Topic progress in the current reporting period.
   */
  health: Health | null;
  /**
   * Next report time.
   */
  nextReportAt: Timestamp | null;
  /**
   * Report that is due next, or null when none is scheduled.
   */
  nextReportId: ReportId | null;
  /**
   * Progress measured for the current goal.
   */
  signed: number | null;
  /**
   * Stages with their aggregate progress only.
   */
  stages: StageStatus[];
  /**
   * Units used for progress.
   */
  unit: string | null;
}
/**
 * Progress, work and conversation context for one topic or project. Whether the recovery plan is open, the history filter and the "Earlier days" fold belong to the client; the hub keeps none of that state.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "TopicView".
 */
export interface TopicView {
  /**
   * Approved goal changes that apply to this plan from this or another topic.
   */
  appliedGoalChanges?: GoalChange[];
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
   * Health of the topic. With no goal, a bad lane gives Stuck, open lanes give On track, and otherwise the topic is Idle. In the dev module a project reads as its lanes: Stuck, Needs you, Working or Idle.
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
  kind: "topic" | "project";
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
   * Faces of people who can work on or watch this topic.
   */
  seenBy: SeenByFace[];
  /**
   * Spend of the topic's agents. A person who can work everything sees it; stage workers and status watchers do not and get null.
   */
  spend: AgentSpend | null;
  /**
   * Stages for this record.
   */
  stages: ViewerStage[];
  /**
   * Progress shared with a status-only reader.
   */
  status: SharedTopicStatus | null;
  /**
   * Stuck for this record.
   */
  stuck: StuckReport | null;
  /**
   * Tasks for this record.
   */
  tasks: TaskRow[];
  viewer: TopicViewer;
  /**
   * Progress through the planning period, or the date of its next milestone.
   */
  when: MeasuredValue | null;
}
/**
 * One handover stage and what the current reader can do in it.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "ViewerStage".
 */
export interface ViewerStage {
  /**
   * Access for this record.
   */
  access: "work" | "view" | "locked";
  /**
   * Name shown to the reader.
   */
  name: string;
  /**
   * Run by for this record.
   */
  runBy: Actor1 | null;
}
/**
 * Viewer for this record.
 */
export interface TopicViewer {
  /**
   * Role for this record.
   */
  role: "owner" | "all" | "stages" | "view";
  /**
   * Shared by for this record.
   */
  sharedBy: Actor1 | null;
  /**
   * Stages for this record.
   */
  stages: string[];
}
/**
 * Effective topic access for the current reader.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "TopicViewer".
 */
export interface TopicViewer1 {
  /**
   * Role for this record.
   */
  role: "owner" | "all" | "stages" | "view";
  /**
   * Shared by for this record.
   */
  sharedBy: Actor1 | null;
  /**
   * Stages for this record.
   */
  stages: string[];
}
/**
 * Trajectory for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * Binary data and display name supplied by the composer.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "UploadInput".
 */
export interface UploadInput {
  /**
   * Base64 file bytes, capped at 512 KiB decoded.
   */
  data: string;
  /**
   * File name to show on the attachment.
   */
  name: string;
}
/**
 * Usage account for the cockpit.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "UsageAccount".
 */
export interface UsageAccount {
  /**
   * Fails over to for this record.
   */
  failsOverTo: string | null;
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
  /**
   * Current state of the record.
   */
  state: "ok" | "near" | "limit" | "standingBy";
}
/**
 * Provider usage and capacity for the workspace.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  state: "ok" | "warn" | "bad" | "idle";
  /**
   * Text shown to the reader.
   */
  text: string | null;
  /**
   * Word for this record.
   */
  word: string;
}
/**
 * Identity and appearance of the workspace.
 *
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
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
  id: "ink" | "ember" | "sand" | "moss" | "tide" | "sky" | "iris" | "rose";
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
 * This interface was referenced by `CockpitSchemaRoot`'s JSON-Schema
 * via the `definition` "WorkspaceView".
 */
export interface WorkspaceView {
  /**
   * Chat mode for this record.
   */
  chatMode: "floating" | "sidebar";
  /**
   * Version of the contract served by the hub.
   */
  contractVersion: string;
  layout: Layout2;
  me: Actor12;
  module: ModuleInfo1;
  /**
   * Modules available in the workspace.
   */
  modules: ModuleCard[];
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
export interface Actor12 {
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
  kind: "person" | "agent";
  /**
   * Membership state, set for invited readers who have not joined.
   */
  membershipState?: MembershipState | null;
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
   * Short name. Agents show their full name, people their first name, and the viewer reads "You".
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
   * Available cockpit modules.
   */
  id: "gtm" | "dev";
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
