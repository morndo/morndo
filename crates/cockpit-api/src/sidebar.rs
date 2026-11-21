use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::lane::LaneState;
use crate::present::Present;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GroupKind {
    Topic,
    Project,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PinKind {
    Page,
    Topic,
    Project,
    Skill,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidebarLane {
    pub id: String,
    pub title: String,
    pub state: LaneState,
    pub state_word: String,
    pub lead_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidebarGroup {
    pub id: String,
    pub name: String,
    pub kind: GroupKind,
    pub icon: String,
    pub state_word: String,
    pub mark: Present<String>,
    pub open: bool,
    pub lanes: Vec<SidebarLane>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pin {
    pub id: String,
    pub kind: PinKind,
    pub label: String,
    pub name: Present<String>,
    pub note: Present<String>,
    pub icon: String,
    pub href: Present<String>,
    pub run: Present<String>,
    pub badge: bool,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidebarView {
    pub kind_word: String,
    pub groups: Vec<SidebarGroup>,
    pub manager_lanes: Vec<SidebarLane>,
    pub pins: Vec<Pin>,
    pub pinnable: Vec<Pin>,
}
