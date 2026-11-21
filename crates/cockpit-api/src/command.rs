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
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Command {
    #[serde(rename = "decision.approve", deny_unknown_fields)]
    DecisionApprove {
        #[serde(rename = "decisionId")]
        decision_id: String,
    },
    #[serde(rename = "decision.decline", deny_unknown_fields)]
    DecisionDecline {
        #[serde(rename = "decisionId")]
        decision_id: String,
    },
    #[serde(rename = "decision.undo", deny_unknown_fields)]
    DecisionUndo {
        #[serde(rename = "decisionId")]
        decision_id: String,
    },
    #[serde(rename = "decision.change", deny_unknown_fields)]
    DecisionChange {
        #[serde(rename = "decisionId")]
        decision_id: String,
        text: String,
    },
    #[serde(rename = "agentAction.undo", deny_unknown_fields)]
    AgentActionUndo {
        #[serde(rename = "actionId")]
        action_id: String,
    },
    #[serde(rename = "agentAction.redo", deny_unknown_fields)]
    AgentActionRedo {
        #[serde(rename = "actionId")]
        action_id: String,
    },
    #[serde(rename = "lane.file", deny_unknown_fields)]
    LaneFile {
        text: String,
        #[serde(rename = "topicId", default)]
        topic_id: Option<String>,
        #[serde(rename = "leadId", default)]
        lead_id: Option<String>,
        #[serde(default)]
        attachment: Option<Attachment>,
    },
    #[serde(rename = "lane.move", deny_unknown_fields)]
    LaneMove {
        #[serde(rename = "laneId")]
        lane_id: String,
        #[serde(rename = "topicId")]
        topic_id: String,
    },
    #[serde(rename = "lane.undoFile", deny_unknown_fields)]
    LaneUndoFile {
        #[serde(rename = "laneId")]
        lane_id: String,
    },
    #[serde(rename = "lane.act", deny_unknown_fields)]
    LaneAct {
        #[serde(rename = "laneId")]
        lane_id: String,
        act: String,
    },
    #[serde(rename = "person.remind", deny_unknown_fields)]
    PersonRemind {
        #[serde(rename = "laneId")]
        lane_id: String,
        #[serde(rename = "personId")]
        person_id: String,
    },
    #[serde(rename = "goal.ask", deny_unknown_fields)]
    GoalAsk {
        #[serde(rename = "topicId")]
        topic_id: String,
    },
    #[serde(rename = "message.send", deny_unknown_fields)]
    MessageSend {
        #[serde(rename = "threadId")]
        thread_id: String,
        text: String,
    },
    #[serde(rename = "message.relabel", deny_unknown_fields)]
    MessageRelabel {
        #[serde(rename = "messageId")]
        message_id: String,
        label: LabelKind,
    },
    #[serde(rename = "since.edit", deny_unknown_fields)]
    SinceEdit {
        #[serde(rename = "threadId")]
        thread_id: String,
        lines: Vec<String>,
    },
    #[serde(rename = "pin.add", deny_unknown_fields)]
    PinAdd {
        #[serde(rename = "pinId")]
        pin_id: String,
    },
    #[serde(rename = "pin.remove", deny_unknown_fields)]
    PinRemove {
        #[serde(rename = "pinId")]
        pin_id: String,
    },
    #[serde(rename = "prefs.set", deny_unknown_fields)]
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
    #[serde(rename = "decisionRight.set", deny_unknown_fields)]
    DecisionRightSet {
        rule: DecisionRule,
        who: Decider,
        #[serde(rename = "dailyLimit", default)]
        daily_limit: Option<i64>,
    },
    #[serde(rename = "skill.run", deny_unknown_fields)]
    SkillRun {
        skill: String,
        text: String,
    },
    #[serde(rename = "access.set", deny_unknown_fields)]
    AccessSet {
        #[serde(rename = "topicId")]
        topic_id: String,
        #[serde(rename = "personId")]
        person_id: String,
        access: AccessGrant,
    },
    #[serde(rename = "access.invite", deny_unknown_fields)]
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
