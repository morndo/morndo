use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::PersonId;

use crate::present::Present;

/// Actor kind for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum ActorKind {
    Person,
    Agent,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// A person or agent, resolved to the record the screens show.
/// Fields a particular card does not carry are null.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    /// Membership state, set for invited readers who have not joined.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub membership_state: Option<MembershipState>,
    /// Stable identifier for this record.
    pub id: PersonId,
    /// Name shown to the reader.
    pub name: String,
    /// Short name for this record.
    pub short_name: String,
    /// Kind for this record.
    pub kind: ActorKind,
    /// Avatar for this record.
    pub avatar: Present<String>,
    /// Role for this record.
    pub role: Present<String>,
    /// Current state of the record.
    pub state: Present<crate::LaneState>,
    /// Word for this record.
    pub word: Present<String>,
    /// Text shown to the reader.
    pub text: Present<String>,
    /// Skill for this record.
    pub skill: Present<String>,
    /// Engine for this record.
    pub engine: Present<String>,
    /// Record for this record.
    pub record: Present<String>,
}

/// Membership of the person in the workspace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum MembershipState {
    Active,
    Invited,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}
