use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::decision::DecisionState;
use crate::present::Present;
use crate::thread::Message;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    #[serde(rename = "decision.changed", deny_unknown_fields)]
    DecisionChanged {
        #[serde(rename = "decisionId")]
        decision_id: String,
        state: DecisionState,
    },
    #[serde(rename = "lane.filed", deny_unknown_fields)]
    LaneFiled {
        #[serde(rename = "laneId")]
        lane_id: String,
        #[serde(rename = "topicId")]
        topic_id: Present<String>,
    },
    #[serde(rename = "lane.changed", deny_unknown_fields)]
    LaneChanged {
        #[serde(rename = "laneId")]
        lane_id: String,
    },
    #[serde(rename = "message.posted", deny_unknown_fields)]
    MessagePosted {
        #[serde(rename = "threadId")]
        thread_id: String,
        message: Message,
    },
    #[serde(rename = "pins.changed", deny_unknown_fields)]
    PinsChanged {
        #[serde(rename = "pinId", default)]
        pin_id: Option<String>,
    },
    #[serde(rename = "prefs.changed", deny_unknown_fields)]
    PrefsChanged {},
    #[serde(rename = "access.changed", deny_unknown_fields)]
    AccessChanged {
        #[serde(rename = "topicId", default)]
        topic_id: Option<String>,
    },
    #[serde(rename = "agentAction.changed", deny_unknown_fields)]
    AgentActionChanged {
        #[serde(rename = "actionId")]
        action_id: String,
    },
}
