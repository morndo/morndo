use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{ActionId, DecisionId, LaneId, PinId, ThreadId, Timestamp, TopicId};

use crate::decision::DecisionState;
use crate::present::Present;
use crate::thread::Message;

/// A change notification delivered to cockpit readers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum Event {
    #[serde(rename = "decision.changed")]
    DecisionChanged {
        /// Identifier of the associated decision.
        decision_id: DecisionId,
        /// Current state of the record.
        state: DecisionState,
    },
    #[serde(rename = "lane.filed")]
    LaneFiled {
        /// Identifier of the associated lane.
        lane_id: LaneId,
        /// Identifier of the associated topic.
        topic_id: Present<TopicId>,
    },
    #[serde(rename = "lane.changed")]
    LaneChanged {
        /// Identifier of the associated lane.
        lane_id: LaneId,
    },
    #[serde(rename = "message.posted")]
    MessagePosted {
        /// Identifier of the associated thread.
        thread_id: ThreadId,
        /// Message for this record.
        message: Box<Message>,
    },
    #[serde(rename = "pins.changed")]
    PinsChanged {
        /// Identifier of the associated pin.
        pin_id: Present<PinId>,
    },
    #[serde(rename = "prefs.changed")]
    PrefsChanged {},
    #[serde(rename = "access.changed")]
    AccessChanged {
        /// Identifier of the associated topic.
        topic_id: Present<TopicId>,
    },
    #[serde(rename = "agentAction.changed")]
    AgentActionChanged {
        /// Identifier of the associated action.
        action_id: ActionId,
    },
    #[serde(rename = "feed.reset")]
    FeedReset {},
    #[serde(other)]
    Unknown,
}

/// A sequenced event on the resumable workspace feed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FeedEvent {
    /// Monotonically increasing sequence number on this hub.
    pub seq: u64,
    /// Time the hub published the event.
    pub at: Timestamp,
    /// Event payload, encoded alongside the sequence and timestamp.
    #[serde(flatten)]
    pub event: Event,
}
