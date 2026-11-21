use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::actor::Actor;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AccessKind {
    All,
    Stages,
    View,
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessGrant {
    pub kind: AccessKind,
    /// Stage names the person can work. Empty unless `kind` is `stages`.
    #[serde(default)]
    pub stages: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OtherTopicAccess {
    pub topic_id: String,
    pub access: AccessKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessPerson {
    pub person: Actor,
    pub access: AccessGrant,
    pub scope: String,
    pub other_topics: Vec<OtherTopicAccess>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessView {
    pub topic_id: String,
    pub topic_name: String,
    pub people: Vec<AccessPerson>,
}
