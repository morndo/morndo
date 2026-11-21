use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::present::Present;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DecisionState {
    Open,
    Approved,
    Declined,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stat {
    pub label: String,
    pub value: String,
    pub sub: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Proof {
    pub items: Vec<Stat>,
    pub meta: Vec<String>,
    pub unchecked: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scenario {
    pub kind: String,
    pub label: String,
    pub headline: String,
    pub condition: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NextStep {
    pub step: String,
    pub who: String,
    pub by: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provenance {
    pub lane_id: Present<String>,
    pub lane_title: String,
    pub written_by: String,
    pub checked_by: String,
    pub checked_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueItem {
    pub id: String,
    pub title: String,
    pub state: DecisionState,
    pub topic_name: String,
    pub href: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecisionQueueView {
    pub items: Vec<QueueItem>,
    pub open: i64,
    pub total: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecisionView {
    pub id: String,
    pub title: String,
    pub state: DecisionState,
    pub topic_id: String,
    pub topic_name: String,
    pub due: String,
    pub why_yours: Present<String>,
    pub minutes: i64,
    pub context_line: String,
    /// The short paragraph on the decision card. The full page uses `context`.
    pub card_context: String,
    pub done_note: String,
    pub lane_id: Present<String>,
    pub approve_label: String,
    pub provenance: Present<Provenance>,
    pub context: Present<String>,
    pub numbers: Vec<Stat>,
    pub proof: Present<Proof>,
    pub opportunity: Present<Scenario>,
    pub risk: Present<Scenario>,
    pub suggestion: Present<String>,
    pub guardrail: Present<String>,
    pub next_steps: Vec<NextStep>,
    pub if_no_answer: Present<String>,
    pub position: String,
}
