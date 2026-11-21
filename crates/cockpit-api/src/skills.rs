use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::present::Present;

/// Connection state for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum ConnectionState {
    Connected,
    SignedIn,
    AddKey,
    SignIn,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Skill for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    /// Stable identifier for this record.
    pub id: crate::SkillId,
    /// Engine for this record.
    pub engine: Present<String>,
    /// Asks first for this record.
    pub asks_first: bool,
    /// Built in for this record.
    pub built_in: bool,
    /// Name shown to the reader.
    pub name: String,
    /// Summary for this record.
    pub summary: String,
    /// Topics for this record.
    pub topics: String,
    /// Needs key for this record.
    pub needs_key: Present<String>,
    /// Enabled for this record.
    pub enabled: bool,
}

/// Connection for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    /// Stable identifier for this record.
    pub id: crate::ConnectionId,
    /// Name shown to the reader.
    pub name: String,
    /// Purpose for this record.
    pub purpose: String,
    /// Current state of the record.
    pub state: ConnectionState,
    /// Capacity for this record.
    pub capacity: Present<String>,
}

/// Guardrail switch for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GuardrailSwitch {
    /// Name shown to the reader.
    pub name: String,
    /// Explanation shown alongside the summary.
    pub detail: String,
    /// On for this record.
    pub on: bool,
}

/// Runnable skills, service connections and standing guardrails.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillsView {
    /// Intro for this record.
    pub intro: String,
    /// Built in for this record.
    pub built_in: i64,
    /// Skills for this record.
    pub skills: Vec<Skill>,
    /// Connections for this record.
    pub connections: Vec<Connection>,
    /// Connected for this record.
    pub connected: i64,
    /// Guardrails for this record.
    pub guardrails: Vec<GuardrailSwitch>,
    /// Rules note for this record.
    pub rules_note: Present<String>,
}
