use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::decision::DecisionState;
use crate::present::Present;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Artwork {
    pub index: i64,
    pub total: i64,
    pub title: String,
    pub manner: String,
    pub alt: String,
    pub credit: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpendLine {
    pub overnight: i64,
    pub week: i64,
    pub cap: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BriefTopic {
    pub id: String,
    pub name: String,
    pub state: String,
    pub verdict: String,
    pub progress: String,
    pub spend: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BriefDecision {
    pub id: String,
    pub topic_id: String,
    pub topic_name: String,
    pub due: String,
    pub why_yours: String,
    pub title: String,
    pub context: String,
    pub minutes: i64,
    pub done_note: String,
    pub lane_id: Present<String>,
    pub state: DecisionState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Burn {
    pub topic_id: String,
    pub topic_name: String,
    pub since: String,
    pub deadline: String,
    pub title: String,
    pub detail: String,
    pub href: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OvernightAction {
    pub id: String,
    pub topic_id: Present<String>,
    pub topic_name: String,
    pub lane_id: Present<String>,
    pub text: String,
    pub time: String,
    pub undoable: bool,
    pub undone: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftsSummary {
    pub count: i64,
    pub text: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BriefView {
    pub date: String,
    pub time: String,
    pub title: String,
    pub lede: String,
    pub next_brief_at: String,
    pub cadence: String,
    pub spend: SpendLine,
    pub topics: Vec<BriefTopic>,
    pub decisions: Vec<BriefDecision>,
    pub open_count: i64,
    pub minutes: i64,
    pub burns: Vec<Burn>,
    pub overnight: Vec<OvernightAction>,
    pub drafts: DraftsSummary,
    pub artwork: Artwork,
}
