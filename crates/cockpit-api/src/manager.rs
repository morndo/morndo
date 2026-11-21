use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{LaneId, Target, Timestamp, TopicId};

use crate::lane::LaneState;
use crate::present::Present;

/// Manager lane for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ManagerLane {
    /// Reason for this record.
    pub reason: Present<String>,
    /// Stable identifier for this record.
    pub id: LaneId,
    /// Title displayed above the record.
    pub title: String,
    /// Identifier of the associated topic.
    pub topic_id: Present<TopicId>,
    /// Topic name for this record.
    pub topic_name: String,
    /// Lead name for this record.
    pub lead_name: String,
    /// Current state of the record.
    pub state: LaneState,
    /// State word for this record.
    pub state_word: String,
    /// Next for this record.
    pub next: String,
}

/// Shared resource for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SharedResource {
    /// Name shown to the reader.
    pub name: String,
    /// Icon for this record.
    pub icon: String,
    /// Rule for this record.
    pub rule: String,
    /// Lanes for this record.
    pub lanes: i64,
}

/// Ask for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    /// Stable identifier for this record.
    pub id: String,
    /// Quote for this record.
    pub quote: String,
    /// Time the record was created or observed.
    pub at: Timestamp,
    /// Chat for this record.
    pub chat: String,
    /// Went for this record.
    pub went: String,
    /// Destination to open in the cockpit.
    pub target: Target,
}

/// The Manager’s triage queue and shared resources.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ManagerView {
    /// Intro for this record.
    pub intro: String,
    /// Summary for this record.
    pub summary: String,
    /// Lanes for this record.
    pub lanes: Vec<ManagerLane>,
    /// Shared resources for this record.
    pub shared_resources: Vec<SharedResource>,
    /// Asks for this record.
    pub asks: Vec<Ask>,
    /// Since for this record.
    pub since: Vec<String>,
}
