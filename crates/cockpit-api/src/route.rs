use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::actor::Actor;
use crate::present::Present;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutePreview {
    pub text: String,
    pub topic_id: Present<String>,
    pub topic_name: Present<String>,
    pub lead: Present<Actor>,
    pub chain: bool,
}
