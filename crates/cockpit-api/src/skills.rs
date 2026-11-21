use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::present::Present;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    Connected,
    SignedIn,
    AddKey,
    SignIn,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Skill {
    pub name: String,
    pub summary: String,
    pub topics: String,
    pub needs_key: Present<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connection {
    pub name: String,
    pub purpose: String,
    pub state: ConnectionState,
    pub capacity: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuardrailSwitch {
    pub name: String,
    pub detail: String,
    pub on: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillsView {
    pub intro: String,
    pub built_in: i64,
    pub skills: Vec<Skill>,
    pub connections: Vec<Connection>,
    pub connected: i64,
    pub guardrails: Vec<GuardrailSwitch>,
    pub rules_note: Present<String>,
}
