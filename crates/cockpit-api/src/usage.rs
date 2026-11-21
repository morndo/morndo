use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::Timestamp;

use crate::present::Present;

/// Meter for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Meter {
    /// Spend for this record.
    pub spend: Present<crate::Money>,
    /// Cap for this record.
    pub cap: Present<crate::Money>,
    /// What for this record.
    pub what: String,
    /// Time associated with resets.
    pub resets_at: Present<Timestamp>,
    /// Used for this record.
    pub used: f64,
    /// Value for this record.

    /// Note for this record.
    pub note: Present<String>,
}

/// Usage account for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageAccount {
    /// Current state of the record.
    pub state: UsageState,
    /// Fails over to for this record.
    pub fails_over_to: Present<String>,
    /// Name shown to the reader.
    pub name: String,
    /// Lanes for this record.
    pub lanes: i64,
    /// Note for this record.
    pub note: Present<String>,
    /// Meters for this record.
    pub meters: Vec<Meter>,
}

/// Provider usage and capacity for the workspace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageView {
    /// Time the record was created or observed.
    pub at: Timestamp,
    /// Subscriptions for this record.
    pub subscriptions: Vec<UsageAccount>,
    /// Keys for this record.
    pub keys: Vec<UsageAccount>,
    /// Missing for this record.
    pub missing: Vec<String>,
}

/// How close a usage account is to its current limit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum UsageState {
    Ok,
    Near,
    Limit,
    StandingBy,
    #[serde(other)]
    Unknown,
}
