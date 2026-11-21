use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::decision::DecisionState;
use crate::present::Present;
use crate::thread::Message;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Event {
    #[serde(rename = "decision.changed")]
    DecisionChanged {
        #[serde(rename = "decisionId")]
        decision_id: String,
        state: DecisionState,
    },
    #[serde(rename = "lane.filed")]
    LaneFiled {
        #[serde(rename = "laneId")]
        lane_id: String,
        #[serde(rename = "topicId")]
        topic_id: Present<String>,
    },
    #[serde(rename = "lane.changed")]
    LaneChanged {
        #[serde(rename = "laneId")]
        lane_id: String,
    },
    #[serde(rename = "message.posted")]
    MessagePosted {
        #[serde(rename = "threadId")]
        thread_id: String,
        message: Message,
    },
    #[serde(rename = "pins.changed")]
    PinsChanged {
        #[serde(rename = "pinId", default)]
        pin_id: Option<String>,
    },
    #[serde(rename = "prefs.changed")]
    PrefsChanged {},
    #[serde(rename = "access.changed")]
    AccessChanged {
        #[serde(rename = "topicId", default)]
        topic_id: Option<String>,
    },
    #[serde(rename = "agentAction.changed")]
    AgentActionChanged {
        #[serde(rename = "actionId")]
        action_id: String,
    },
}
