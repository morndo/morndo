use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::actor::Actor;
use crate::present::Present;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum LabelKind {
    Question,
    Request,
    Done,
    Decision,
    GoalChange,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageLabel {
    pub kind: LabelKind,
    pub corrected: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadCard {
    pub title: String,
    pub owner: String,
    pub state: String,
    pub lane_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadBack {
    pub owner: String,
    pub quote: String,
    pub time: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageAction {
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Message {
    pub id: String,
    pub author: Actor,
    pub time: String,
    pub text: String,
    pub own: bool,
    pub label: Present<MessageLabel>,
    pub thread_card: Present<ThreadCard>,
    pub read_back: Present<ReadBack>,
    pub actions: Vec<MessageAction>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SinceSummary {
    pub seen: String,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PinState {
    Waiting,
    Approved,
    Stuck,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinnedDecision {
    pub title: String,
    pub detail: String,
    pub state: PinState,
    pub decision_id: Present<String>,
    pub lane_id: Present<String>,
    pub approve_label: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StripItem {
    pub time: String,
    pub name: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentsStrip {
    pub seen: String,
    pub count: i64,
    pub summary: String,
    pub items: Vec<StripItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadView {
    pub id: String,
    pub title: String,
    pub sub: Present<String>,
    pub placeholder: String,
    pub reading: Present<String>,
    pub since: Present<SinceSummary>,
    pub pinned: Present<PinnedDecision>,
    pub agents: Present<AgentsStrip>,
    pub suggestions: Vec<String>,
    pub messages: Vec<Message>,
}
