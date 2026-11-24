use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{ActionId, DecisionId, LaneId, PinId, ThreadId, Timestamp, TopicId};

use crate::decision::DecisionState;
use crate::present::Present;
use crate::thread::Message;

/// A change notification delivered to cockpit readers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:tag:type"))]
pub enum Event {
    #[serde(rename = "decision.changed")]
    DecisionChanged {
        /// Identifier of the associated decision.
        decision_id: DecisionId,
        /// Current state of the record.
        state: DecisionState,
    },
    #[serde(rename = "lane.filed")]
    LaneFiled {
        /// Chain for this record.
        chain: bool,
        /// Identifier of the associated lane.
        lane_id: LaneId,
        /// Identifier of the associated topic.
        topic_id: Present<TopicId>,
        /// Schedule that filed the lane, or null when none did.
        schedule_id: Present<crate::ScheduleId>,
        /// Group shared with the sibling lanes when an ask was split, or null when it was not split.
        group_id: Present<String>,
    },
    #[serde(rename = "lane.changed")]
    LaneChanged {
        /// Identifier of the associated lane.
        lane_id: LaneId,
    },
    #[serde(rename = "message.posted")]
    MessagePosted {
        /// Identifier of the associated thread.
        thread_id: ThreadId,
        /// Message for this record.
        message: Box<Message>,
    },
    #[serde(rename = "pins.changed")]
    PinsChanged {
        /// Identifier of the associated pin.
        pin_id: Present<PinId>,
    },
    #[serde(rename = "prefs.changed")]
    PrefsChanged {},
    #[serde(rename = "access.changed")]
    AccessChanged {
        /// Identifier of the associated topic.
        topic_id: Present<TopicId>,
        /// Person whose grant changed, when the event concerns an individual.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        person_id: Option<crate::PersonId>,
    },
    #[serde(rename = "agentAction.changed")]
    AgentActionChanged {
        /// Identifier of the associated action.
        action_id: ActionId,
    },
    #[serde(rename = "decision.expired")]
    DecisionExpired { decision_id: DecisionId },
    #[serde(rename = "lane.removed")]
    LaneRemoved { lane_id: LaneId },
    #[serde(rename = "thread.changed")]
    ThreadChanged { thread_id: ThreadId },
    #[serde(rename = "topic.changed")]
    TopicChanged { topic_id: TopicId },
    #[serde(rename = "drafts.changed")]
    DraftsChanged {},
    #[serde(rename = "brief.changed")]
    BriefChanged {},
    #[serde(rename = "brief.published")]
    BriefPublished {},
    /// Work that cannot wait for the next brief, including due decisions and stuck lanes with deadlines.
    #[serde(rename = "attention.raised")]
    AttentionRaised {
        target: crate::Target,
        reason: String,
    },
    #[serde(rename = "guardrail.breached")]
    GuardrailBreached {
        topic_id: Present<TopicId>,
        name: String,
        /// Guardrail that was breached.
        guardrail_id: String,
    },
    #[serde(rename = "usage.changed")]
    UsageChanged {},
    #[serde(rename = "release.changed")]
    ReleaseChanged { decision_id: DecisionId },
    #[serde(rename = "pull.changed")]
    PullChanged { pull_id: crate::PullId },
    #[serde(rename = "handover.changed")]
    HandoverChanged { lane_id: LaneId },
    #[serde(rename = "skills.changed")]
    SkillsChanged {},
    #[serde(rename = "module.changed")]
    ModuleChanged { module_id: crate::ModuleId },
    #[serde(rename = "feed.reset")]
    FeedReset {},
    /// A CI run record was created or changed.
    #[serde(rename = "run.changed")]
    RunChanged {
        /// Run record that changed.
        record_id: crate::RecordId,
        /// Lane the run belongs to.
        lane_id: LaneId,
    },
    /// A schedule was created, switched or fired.
    #[serde(rename = "schedule.changed")]
    ScheduleChanged {
        /// Schedule that changed.
        schedule_id: crate::ScheduleId,
    },
    /// A report changed state or was rescheduled.
    #[serde(rename = "report.changed")]
    ReportChanged {
        /// Report that changed.
        report_id: crate::ReportId,
        /// Topic the report covers.
        topic_id: TopicId,
    },
    /// A spot check was recorded.
    #[serde(rename = "check.recorded")]
    CheckRecorded {
        /// Check that was recorded.
        check_id: crate::CheckId,
        /// Topic the check belongs to.
        topic_id: TopicId,
    },
    /// A decision right's count or limit changed.
    #[serde(rename = "decisionRight.changed")]
    DecisionRightChanged {},
    /// A decision right reached its daily limit; the next item of that rule becomes a decision in Decide.
    #[serde(rename = "decisionRight.limitReached")]
    DecisionRightLimitReached {
        /// Rule whose daily limit was reached.
        rule: crate::DecisionRule,
        /// Person whose right it is, or null when the right belongs to the reader.
        person_id: Present<crate::PersonId>,
    },
    /// A shared resource changed hands or its quota moved.
    #[serde(rename = "resource.changed")]
    ResourceChanged {
        /// Resource that changed.
        resource_id: String,
    },
    /// A forecast was scored against what was measured.
    #[serde(rename = "forecast.scored")]
    ForecastScored {
        /// Topic whose goal the forecast belongs to.
        topic_id: TopicId,
        /// Forecast that was scored.
        forecast_id: String,
    },
    /// The workspace's members or their access changed.
    #[serde(rename = "members.changed")]
    MembersChanged {
        /// Person who changed, or null when the change concerns the list as a whole.
        person_id: Present<crate::PersonId>,
    },
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// A sequenced event on the resumable workspace feed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(extend("$comment" = "cockpit-reader:tag:type"))]
pub struct FeedEvent {
    /// Monotonically increasing sequence number on this hub.
    pub seq: u64,
    /// Time the hub published the event.
    pub at: Timestamp,
    /// Event payload, encoded alongside the sequence and timestamp.
    #[serde(flatten)]
    pub event: Event,
}

/// A feed control message without a sequence number; the reader should fetch fresh views.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type")]
pub enum FeedResetSignal {
    /// Replay is unavailable for the requested cursor.
    #[serde(rename = "feed.reset")]
    Reset {},
}

/// A change event or an unsequenced control message on the feed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum FeedFrame {
    /// A notification that can be replayed.
    Event(Box<FeedEvent>),
    /// Instructions to re-read the views.
    Reset(FeedResetSignal),
}
