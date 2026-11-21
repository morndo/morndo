use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{DecisionId, LaneId, Target, Timestamp, TopicId};

use crate::present::Present;

/// Decision state for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DecisionState {
    Open,
    Approved,
    Declined,
    #[serde(other)]
    Unknown,
}

/// Stat for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    /// Label for this record.
    pub label: String,
    /// Value for this record.
    pub value: String,
    /// Sub for this record.
    pub sub: Present<String>,
}

/// Proof for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Proof {
    /// Items for this record.
    pub items: Vec<Stat>,
    /// Meta for this record.
    pub meta: Vec<String>,
    /// Unchecked for this record.
    pub unchecked: Present<String>,
}

/// One possible outcome shown in the decision forecast.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Scenario {
    /// Kind for this record.
    pub kind: ScenarioKind,
    /// Label for this record.
    pub label: String,
    /// Headline for this record.
    pub headline: String,
    /// Condition for this record.
    pub condition: String,
    /// Summary for this record.
    pub summary: String,
}

/// Next step for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NextStep {
    /// Step for this record.
    pub step: String,
    /// Who for this record.
    pub who: String,
    /// Time an answer or action is due.
    pub due_at: Present<Timestamp>,
}

/// Provenance for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    /// Identifier of the associated lane.
    pub lane_id: Present<LaneId>,
    /// Lane title for this record.
    pub lane_title: String,
    /// Written by for this record.
    pub written_by: String,
    /// Checked by for this record.
    pub checked_by: String,
    /// Time associated with checked.
    pub checked_at: Timestamp,
}

/// Queue item for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    /// Stable identifier for this record.
    pub id: DecisionId,
    /// Title displayed above the record.
    pub title: String,
    /// Current state of the record.
    pub state: DecisionState,
    /// Topic name for this record.
    pub topic_name: String,
    /// Destination to open in the cockpit.
    pub target: Target,
}

/// Decision queue view for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecisionQueueView {
    /// Items for this record.
    pub items: Vec<QueueItem>,
    /// Open for this record.
    pub open: i64,
    /// Total for this record.
    pub total: i64,
}

/// The evidence, consequences and next steps for a decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecisionView {
    /// Stable identifier for this record.
    pub id: DecisionId,
    /// Title displayed above the record.
    pub title: String,
    /// Current state of the record.
    pub state: DecisionState,
    /// Identifier of the associated topic.
    pub topic_id: TopicId,
    /// Topic name for this record.
    pub topic_name: String,
    /// Time an answer or action is due.
    pub due_at: Timestamp,
    /// Why yours for this record.
    pub why_yours: Present<String>,
    /// Minutes for this record.
    pub minutes: i64,
    /// Context line for this record.
    pub context_line: String,
    /// The short paragraph on the decision card. The full page uses `context`.
    pub card_context: String,
    /// Done note for this record.
    pub done_note: String,
    /// Identifier of the associated lane.
    pub lane_id: Present<LaneId>,
    /// Approve label for this record.
    pub approve_label: String,
    /// Provenance for this record.
    pub provenance: Present<Provenance>,
    /// Context for this record.
    pub context: Present<String>,
    /// Numbers for this record.
    pub numbers: Vec<Stat>,
    /// Proof for this record.
    pub proof: Present<Proof>,
    /// Opportunity for this record.
    pub opportunity: Present<Scenario>,
    /// Risk for this record.
    pub risk: Present<Scenario>,
    /// Suggestion for this record.
    pub suggestion: Present<String>,
    /// Guardrail for this record.
    pub guardrail: Present<String>,
    /// Next steps for this record.
    pub next_steps: Vec<NextStep>,
    /// If no answer for this record.
    pub if_no_answer: Present<String>,
    /// Position for this record.
    pub position: String,
}

/// Which side of the forecast the chart describes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ScenarioKind {
    Opportunity,
    Risk,
    #[serde(other)]
    Unknown,
}
