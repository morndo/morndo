use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::TopicId;

use crate::actor::Actor;

/// Access kind for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AccessKind {
    All,
    Stages,
    View,
    None,
    #[serde(other)]
    Unknown,
}

/// Access grant for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccessGrant {
    /// Kind for this record.
    pub kind: AccessKind,
    /// Stage names the person can work. Empty unless `kind` is `stages`.
    #[serde(default)]
    pub stages: Vec<String>,
}

/// Other topic access for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OtherTopicAccess {
    /// Identifier of the associated topic.
    pub topic_id: TopicId,
    /// Access for this record.
    pub access: AccessKind,
}

/// Access person for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccessPerson {
    /// Person for this record.
    pub person: Actor,
    /// Access for this record.
    pub access: AccessGrant,
    /// Scope for this record.
    pub scope: String,
    /// Other topics for this record.
    pub other_topics: Vec<OtherTopicAccess>,
}

/// Sharing settings for one topic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccessView {
    /// Identifier of the associated topic.
    pub topic_id: TopicId,
    /// Topic name for this record.
    pub topic_name: String,
    /// People for this record.
    pub people: Vec<AccessPerson>,
}

/// Access grant submitted by an administrator.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessGrantInput {
    /// Scope granted to the recipient.
    pub kind: crate::input::Known<AccessKind>,
    /// Allowed stage names when the scope is stage-based.
    #[serde(default)]
    pub stages: Vec<String>,
}
