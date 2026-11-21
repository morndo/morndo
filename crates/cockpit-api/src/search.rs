use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::Target;

use crate::present::Present;

/// Search kind for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SearchKind {
    Topic,
    Lane,
    Person,
    Decision,
    Skill,
    #[serde(other)]
    Unknown,
}

/// Search result for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// Current state of the record.
    pub state: Present<SearchState>,
    /// Lead for this record.
    pub lead: Present<crate::Actor>,
    /// Topics for this record.
    pub topics: Vec<crate::TopicId>,
    /// Kind for this record.
    pub kind: SearchKind,
    /// Stable identifier for this record.
    pub id: String,
    /// Title displayed above the record.
    pub title: String,
    /// Sub for this record.
    pub sub: Present<String>,
    /// Destination to open in the cockpit.
    pub target: Target,
}

/// Answer for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    /// Text shown to the reader.
    pub text: String,
    /// Source for this record.
    pub source: String,
    /// Destination to open in the cockpit.
    pub target: Present<Target>,
}

/// A page of records matching the query and an optional answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchView {
    /// Query for this record.
    pub query: String,
    /// Scope for this record.
    pub scope: Present<String>,
    /// Results for this record.
    pub results: Vec<SearchResult>,
    /// Answer for this record.
    pub answer: Present<Answer>,
    /// Opaque cursor for the following page, or null at the end.
    pub next_cursor: Present<String>,
}

/// Status of a result, interpreted in the context of its kind.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SearchState {
    Open,
    Approved,
    Declined,
    Expired,
    New,
    Ok,
    Warn,
    Bad,
    Done,
    Idle,
    Next,
    Parked,
    #[serde(other)]
    Unknown,
}
