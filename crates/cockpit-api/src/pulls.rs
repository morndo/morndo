use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::present::Present;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GateState {
    Pass,
    Running,
    Todo,
    Fail,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Gate {
    pub name: String,
    pub state: GateState,
    pub detail: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PullRequest {
    pub id: String,
    pub project_id: String,
    pub project_name: String,
    pub number: i64,
    pub author: String,
    pub opened: String,
    pub title: String,
    pub summary: String,
    pub gates: Vec<Gate>,
    pub verdict: String,
    pub href: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PullsView {
    pub intro: String,
    pub summary: Present<String>,
    pub items: Vec<PullRequest>,
}
