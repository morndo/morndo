use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{DecisionId, LaneId, MessageId, ThreadId, Timestamp};

use crate::actor::Actor;
use crate::present::Present;

/// Label kind for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum LabelKind {
    Question,
    Request,
    Done,
    Decision,
    GoalChange,
    #[serde(other)]
    Unknown,
}

/// Message label for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageLabel {
    /// Pinned for this record.
    pub pinned: bool,
    /// Kind for this record.
    pub kind: LabelKind,
    /// Corrected for this record.
    pub corrected: bool,
}

/// Thread card for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCard {
    /// Title displayed above the record.
    pub title: String,
    /// Owner for this record.
    pub owner: String,
    /// Current state of the record.
    pub state_word: String,
    /// Identifier of the associated lane.
    pub lane_id: LaneId,
}

/// Read back for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadBack {
    /// Owner for this record.
    pub owner: String,
    /// Quote for this record.
    pub quote: String,
    /// Time the record was created or observed.
    pub at: Timestamp,
}

/// Message action for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageAction {
    /// Stable identifier for this record.
    pub id: crate::ActionId,
    /// Identifier of the associated lane.
    pub lane_id: crate::LaneId,
    /// Identifier of the associated person.
    pub person_id: Present<crate::PersonId>,
    /// Label for this record.
    pub label: String,
}

/// Message for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// Topic-wide or stage-only distribution for this message.
    pub audience: MessageAudience,
    /// Identifier of the associated decision.
    pub decision_id: Present<DecisionId>,
    /// Attachment for this record.
    pub attachment: Present<crate::Attachment>,
    /// Model for this record.
    pub model: Present<crate::ModelId>,
    /// Page for this record.
    pub page: Present<crate::Target>,
    /// Stable identifier for this record.
    pub id: MessageId,
    /// Author for this record.
    pub author: Actor,
    /// Time the record was created or observed.
    pub at: Timestamp,
    /// Text shown to the reader.
    pub text: String,
    /// Label for this record.
    pub label: Present<MessageLabel>,
    /// Thread card for this record.
    pub thread_card: Present<ThreadCard>,
    /// Read back for this record.
    pub read_back: Present<ReadBack>,
    /// Actions for this record.
    pub actions: Vec<MessageAction>,
}

/// Since summary for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SinceSummary {
    /// Seen for this record.
    pub seen: crate::topic::SeenMarker,
    /// Lines for this record.
    pub lines: Vec<String>,
}

/// Pin state for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PinState {
    Waiting,
    Approved,
    Declined,
    Expired,
    Stuck,
    #[serde(other)]
    Unknown,
}

/// Pinned decision for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PinnedDecision {
    /// Title displayed above the record.
    pub title: String,
    /// Explanation shown alongside the summary.
    pub detail: String,
    /// Current state of the record.
    pub state: PinState,
    /// Identifier of the associated decision.
    pub decision_id: Present<DecisionId>,
    /// Identifier of the associated lane.
    pub lane_id: Present<LaneId>,
    /// Approve label for this record.
    pub approve_label: Present<String>,
}

/// Strip item for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StripItem {
    /// Time the record was created or observed.
    pub at: Timestamp,
    /// Name shown to the reader.
    pub name: String,
    /// Text shown to the reader.
    pub text: String,
}

/// Agents strip for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentsStrip {
    /// Seen for this record.
    pub seen: crate::topic::SeenMarker,
    /// Count for this record.
    pub count: i64,
    /// Summary for this record.
    pub summary: String,
    /// Items for this record.
    pub items: Vec<StripItem>,
}

/// A page of conversation and its reading context.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadView {
    /// Scope for this record.
    pub scope: Present<String>,
    /// Stable identifier for this record.
    pub id: ThreadId,
    /// Title displayed above the record.
    pub title: String,
    /// Sub for this record.
    pub sub: Present<String>,
    /// Placeholder for this record.
    pub placeholder: String,
    /// Reading for this record.
    pub reading: Present<String>,
    /// Since for this record.
    pub since: Present<SinceSummary>,
    /// Pinned for this record.
    pub pinned: Present<PinnedDecision>,
    /// Agents for this record.
    pub agents: Present<AgentsStrip>,
    /// Suggestions for this record.
    pub suggestions: Vec<String>,
    /// Messages for this record.
    pub messages: Vec<Message>,
    /// Opaque cursor for the following page, or null at the end.
    pub next_cursor: Present<String>,
}

/// Audience allowed to receive a message in a topic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MessageAudience {
    /// Everyone who can read the topic conversation.
    Topic,
    /// Readers who work in this stage.
    Stage {
        /// Name of the stage in the topic.
        stage: String,
    },
    #[serde(other)]
    Unknown,
}
