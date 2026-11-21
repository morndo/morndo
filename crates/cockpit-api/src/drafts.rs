use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{DraftId, Timestamp};

use crate::present::Present;

/// Draft for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    /// Stable identifier for this record.
    pub id: DraftId,
    /// To for this record.
    pub to: String,
    /// Time associated with written.
    pub written_at: Timestamp,
    /// Skill for this record.
    pub skill: Present<String>,
    /// Subject for this record.
    pub subject: String,
    /// Body for this record.
    pub body: String,
}

/// Messages prepared for review in the mail app.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DraftsView {
    /// Intro for this record.
    pub intro: String,
    /// Count for this record.
    pub count: i64,
    /// Items for this record.
    pub items: Vec<Draft>,
}
