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

/// What a connection's grant lets agents do. The action gateway refuses a write beyond the scope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum ConnectionScope {
    Read,
    DraftsOnly,
    ReadWrite,
    RunsLanes,
    Agent,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// What happens when a guardrail is breached.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum GuardrailAction {
    Ask,
    Pause,
    Revert,
    Stop,
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
    pub capacity: Present<crate::topic::MeasuredValue>,
    /// What the grant lets agents do, or null when the connection has no grant. The action gateway refuses a write beyond the scope.
    pub scope: Present<ConnectionScope>,
}

/// Guardrail switch for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GuardrailSwitch {
    /// Stable identifier of the guardrail, or null when it has none.
    pub id: Present<String>,
    /// Topic the guardrail covers, or null when it is workspace-wide.
    pub topic_id: Present<crate::TopicId>,
    /// What happens when the guardrail is breached, or null when it only reports.
    pub action: Present<GuardrailAction>,
    /// The limit the switch guards, or null when it has none.
    pub limit: Present<crate::topic::MeasuredValue>,
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
