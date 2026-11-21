use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::present::Present;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Meter {
    pub what: String,
    pub used: f64,
    pub value: String,
    pub note: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageAccount {
    pub name: String,
    pub lanes: i64,
    pub note: Present<String>,
    pub meters: Vec<Meter>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageView {
    pub as_of: String,
    pub subscriptions: Vec<UsageAccount>,
    pub keys: Vec<UsageAccount>,
    pub missing: Vec<String>,
}
