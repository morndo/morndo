use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::lane::LaneState;
use crate::present::Present;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagerLane {
    pub id: String,
    pub title: String,
    pub topic_id: Present<String>,
    pub topic_name: String,
    pub lead_name: String,
    pub state: LaneState,
    pub state_word: String,
    pub next: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharedResource {
    pub name: String,
    pub icon: String,
    pub rule: String,
    pub lanes: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ask {
    pub id: String,
    pub quote: String,
    pub when: String,
    pub chat: String,
    pub went: String,
    pub href: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagerView {
    pub intro: String,
    pub summary: String,
    pub lanes: Vec<ManagerLane>,
    pub shared_resources: Vec<SharedResource>,
    pub asks: Vec<Ask>,
    pub since: Vec<String>,
}
