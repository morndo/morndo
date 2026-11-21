use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::access::AccessGrant;
use crate::event::Event;
use crate::present::Present;
use crate::settings::{ChatMode, Decider, DecisionRule, LayoutPatch, ThemePatch};
use crate::thread::{LabelKind, Message};

/// A file or link dropped onto a topic, or attached to a filed lane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attachment {
    pub name: String,
    #[serde(default)]
    pub href: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Command {
    #[serde(rename = "decision.approve")]
    DecisionApprove {
        #[serde(rename = "decisionId")]
        decision_id: String,
    },
    #[serde(rename = "decision.decline")]
    DecisionDecline {
        #[serde(rename = "decisionId")]
        decision_id: String,
    },
    #[serde(rename = "decision.undo")]
    DecisionUndo {
        #[serde(rename = "decisionId")]
        decision_id: String,
    },
    #[serde(rename = "decision.change")]
    DecisionChange {
        #[serde(rename = "decisionId")]
        decision_id: String,
        text: String,
    },
    #[serde(rename = "agentAction.undo")]
    AgentActionUndo {
        #[serde(rename = "actionId")]
        action_id: String,
    },
    #[serde(rename = "agentAction.redo")]
    AgentActionRedo {
        #[serde(rename = "actionId")]
        action_id: String,
    },
    #[serde(rename = "lane.file")]
    LaneFile {
        text: String,
        #[serde(rename = "topicId", default)]
        topic_id: Option<String>,
        #[serde(rename = "leadId", default)]
        lead_id: Option<String>,
        #[serde(default)]
        attachment: Option<Attachment>,
    },
    #[serde(rename = "lane.move")]
    LaneMove {
        #[serde(rename = "laneId")]
        lane_id: String,
        #[serde(rename = "topicId")]
        topic_id: String,
    },
    #[serde(rename = "lane.undoFile")]
    LaneUndoFile {
        #[serde(rename = "laneId")]
        lane_id: String,
    },
    #[serde(rename = "lane.act")]
    LaneAct {
        #[serde(rename = "laneId")]
        lane_id: String,
        act: String,
    },
    #[serde(rename = "person.remind")]
    PersonRemind {
        #[serde(rename = "laneId")]
        lane_id: String,
        #[serde(rename = "personId")]
        person_id: String,
    },
    #[serde(rename = "goal.ask")]
    GoalAsk {
        #[serde(rename = "topicId")]
        topic_id: String,
    },
    #[serde(rename = "message.send")]
    MessageSend {
        #[serde(rename = "threadId")]
        thread_id: String,
        text: String,
    },
    #[serde(rename = "message.relabel")]
    MessageRelabel {
        #[serde(rename = "messageId")]
        message_id: String,
        label: LabelKind,
    },
    #[serde(rename = "since.edit")]
    SinceEdit {
        #[serde(rename = "threadId")]
        thread_id: String,
        lines: Vec<String>,
    },
    #[serde(rename = "pin.add")]
    PinAdd {
        #[serde(rename = "pinId")]
        pin_id: String,
    },
    #[serde(rename = "pin.remove")]
    PinRemove {
        #[serde(rename = "pinId")]
        pin_id: String,
    },
    #[serde(rename = "prefs.set")]
    PrefsSet {
        #[serde(default)]
        theme: Option<ThemePatch>,
        #[serde(default)]
        layout: Option<LayoutPatch>,
        #[serde(rename = "chatMode", default)]
        chat_mode: Option<ChatMode>,
        #[serde(rename = "briefsPerDay", default)]
        briefs_per_day: Option<i64>,
        #[serde(rename = "interruptOnlyUrgent", default)]
        interrupt_only_urgent: Option<bool>,
    },
    #[serde(rename = "decisionRight.set")]
    DecisionRightSet {
        rule: DecisionRule,
        who: Decider,
        #[serde(rename = "dailyLimit", default)]
        daily_limit: Option<i64>,
    },
    #[serde(rename = "skill.run")]
    SkillRun {
        skill: String,
        text: String,
    },
    #[serde(rename = "access.set")]
    AccessSet {
        #[serde(rename = "topicId")]
        topic_id: String,
        #[serde(rename = "personId")]
        person_id: String,
        access: AccessGrant,
    },
    #[serde(rename = "access.invite")]
    AccessInvite {
        #[serde(rename = "topicId")]
        topic_id: String,
        #[serde(rename = "nameOrEmail")]
        name_or_email: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandResult {
    pub ok: bool,
    pub events: Vec<Event>,
    pub lane_id: Present<String>,
    pub message: Present<Message>,
}
