use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{PullId, Target, Timestamp, TopicId};

use crate::present::Present;

/// Gate state for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GateState {
    Pass,
    Running,
    Todo,
    Fail,
    Skipped,
    #[serde(other)]
    Unknown,
}

/// Gate for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    /// Name shown to the reader.
    pub name: String,
    /// Current state of the record.
    pub state: GateState,
    /// Explanation shown alongside the summary.
    pub detail: Present<String>,
}

/// Pull request for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    /// Current state of the record.
    pub state: PullState,
    /// Identifier of the associated decision.
    pub decision_id: Present<crate::DecisionId>,
    /// Identifier of the associated lane.
    pub lane_id: Present<crate::LaneId>,
    /// Time associated with auto merge.
    pub auto_merge_at: Present<Timestamp>,
    /// Held for this record.
    pub held: bool,
    /// Stable identifier for this record.
    pub id: PullId,
    /// Identifier of the associated project.
    pub project_id: TopicId,
    /// Project name for this record.
    pub project_name: String,
    /// Number for this record.
    pub number: i64,
    /// Author for this record.
    pub author: String,
    /// Time associated with opened.
    pub opened_at: Timestamp,
    /// Title displayed above the record.
    pub title: String,
    /// Summary for this record.
    pub summary: String,
    /// Gates for this record.
    pub gates: Vec<Gate>,
    /// Verdict for this record.
    pub verdict: String,
    /// Url for this record.
    pub url: String,
    /// Destination to open in the cockpit.
    pub target: Present<Target>,
}

/// Pull requests being tracked by the development module.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullsView {
    /// Intro for this record.
    pub intro: String,
    /// Summary for this record.
    pub summary: Present<String>,
    /// Items for this record.
    pub items: Vec<PullRequest>,
}

/// Position of a pull request in the review and release flow.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PullState {
    Ready,
    Blocked,
    InReview,
    AutoMerge,
    Releasing,
    Released,
    Held,
    #[serde(other)]
    Unknown,
}
