use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::present::Present;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ActorKind {
    Person,
    Agent,
}

/// A person or agent, resolved to the record the screens show.
/// Fields a particular card does not carry are null.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Actor {
    pub id: String,
    pub name: String,
    pub short_name: String,
    pub kind: ActorKind,
    pub avatar: Present<String>,
    pub role: Present<String>,
    pub state: Present<String>,
    pub word: Present<String>,
    pub text: Present<String>,
    pub skill: Present<String>,
    pub engine: Present<String>,
    pub record: Present<String>,
}
