use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::TopicId;

use crate::actor::Actor;
use crate::present::Present;

/// Route preview for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutePreview {
    /// Text shown to the reader.
    pub text: String,
    /// Identifier of the associated topic.
    pub topic_id: Present<TopicId>,
    /// Topic name for this record.
    pub topic_name: Present<String>,
    /// Lead for this record.
    pub lead: Present<Actor>,
    /// Chain for this record.
    pub chain: bool,
}
