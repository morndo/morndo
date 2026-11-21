use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{ActionId, DecisionId, LaneId, MessageId, PersonId, PinId, SkillId, ThreadId, TopicId};

use crate::access::AccessGrantInput;
use crate::event::FeedEvent;
use crate::input::{self, Known};
use crate::present::Present;
use crate::settings::{ChatMode, DailyLimit, Decider, DecisionRule, LayoutPatch, ThemePatch};
use crate::thread::{LabelKind, Message};
use crate::{ConnectionId, InvitationId, ModelId, ModuleId, PullId, Target};

/// A file or link dropped onto a topic, or attached to a filed lane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// Name shown to the reader.
    #[schemars(length(min = 1, max = 200))]
    pub name: String,
    /// Url for this record.
    #[schemars(extend("format" = "uri"))]
    pub url: String,
}

/// File or link supplied with a new request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AttachmentInput {
    /// Name shown to the reader.
    #[schemars(length(min = 1, max = 200))]
    #[serde(deserialize_with = "input::name")]
    pub name: String,
    /// Url for this record.
    #[schemars(extend("format" = "uri"))]
    pub url: String,
}

/// A user request accepted by the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum Command {
    #[serde(rename = "decision.approve")]
    DecisionApprove {
        /// Identifier of the associated decision.
        decision_id: DecisionId,
    },
    #[serde(rename = "decision.decline")]
    DecisionDecline {
        /// Identifier of the associated decision.
        decision_id: DecisionId,
    },
    #[serde(rename = "decision.undo")]
    DecisionUndo {
        /// Identifier of the associated decision.
        decision_id: DecisionId,
    },
    #[serde(rename = "decision.change")]
    DecisionChange {
        /// Identifier of the associated decision.
        decision_id: DecisionId,
        /// Text shown to the reader.
        #[schemars(length(min = 1, max = 4000))]
        #[serde(deserialize_with = "input::text")]
        text: String,
    },
    #[serde(rename = "agentAction.undo")]
    AgentActionUndo {
        /// Identifier of the associated action.
        action_id: ActionId,
    },
    #[serde(rename = "agentAction.redo")]
    AgentActionRedo {
        /// Identifier of the associated action.
        action_id: ActionId,
    },
    #[serde(rename = "lane.file")]
    LaneFile {
        /// To manager for this record.
        #[serde(default)]
        to_manager: bool,
        /// Model for this record.
        #[serde(default)]
        model: Option<ModelId>,
        /// Text shown to the reader.
        #[schemars(length(min = 1, max = 4000))]
        #[serde(deserialize_with = "input::text")]
        text: String,
        /// Identifier of the associated topic.
        #[serde(default)]
        topic_id: Option<TopicId>,
        /// Identifier of the associated lead.
        #[serde(default)]
        lead_id: Option<PersonId>,
        /// Attachment for this record.
        #[serde(default)]
        attachment: Option<AttachmentInput>,
    },
    #[serde(rename = "lane.move")]
    LaneMove {
        /// Identifier of the associated lane.
        lane_id: LaneId,
        /// Identifier of the associated topic.
        topic_id: TopicId,
    },
    #[serde(rename = "lane.undoFile")]
    LaneUndoFile {
        /// Identifier of the associated lane.
        lane_id: LaneId,
    },
    #[serde(rename = "lane.act")]
    LaneAct {
        /// Identifier of the associated lane.
        lane_id: LaneId,
        /// Act for this record.
        act: String,
    },
    #[serde(rename = "person.remind")]
    PersonRemind {
        /// Identifier of the associated lane.
        lane_id: LaneId,
        /// Identifier of the associated person.
        person_id: PersonId,
    },
    #[serde(rename = "goal.ask")]
    GoalAsk {
        /// Identifier of the associated topic.
        topic_id: TopicId,
    },
    #[serde(rename = "message.send")]
    MessageSend {
        /// Attachment for this record.
        #[serde(default)]
        attachment: Option<AttachmentInput>,
        /// Page for this record.
        #[serde(default)]
        page: Option<TargetInput>,
        /// Model for this record.
        #[serde(default)]
        model: Option<ModelId>,
        /// Identifier of the associated thread.
        thread_id: ThreadId,
        /// Text shown to the reader.
        #[schemars(length(min = 1, max = 4000))]
        #[serde(deserialize_with = "input::text")]
        text: String,
    },
    #[serde(rename = "message.relabel")]
    MessageRelabel {
        /// Identifier of the associated message.
        message_id: MessageId,
        /// Label for this record.
        label: Known<LabelKind>,
    },
    #[serde(rename = "since.edit")]
    SinceEdit {
        /// Identifier of the associated thread.
        thread_id: ThreadId,
        /// Lines for this record.
        lines: Vec<String>,
    },
    #[serde(rename = "pin.add")]
    PinAdd {
        /// Identifier of the associated pin.
        pin_id: PinId,
    },
    #[serde(rename = "pin.remove")]
    PinRemove {
        /// Identifier of the associated pin.
        pin_id: PinId,
    },
    #[serde(rename = "prefs.set")]
    PrefsSet {
        /// Identifier of the associated device.
        #[serde(default)]
        device_id: Option<String>,
        /// Theme for this record.
        #[serde(default)]
        theme: Option<ThemePatch>,
        /// Sizes of the cockpit panes.
        #[serde(default)]
        layout: Option<LayoutPatch>,
        /// Chat mode for this record.
        #[serde(default)]
        chat_mode: Option<Known<ChatMode>>,
        /// Briefs per day for this record.
        #[serde(default)]
        #[schemars(range(min = 1, max = 3))]
        #[serde(deserialize_with = "input::optional_range::<_, 1, 3>")]
        briefs_per_day: Option<i64>,
        /// Interrupt only urgent for this record.
        #[serde(default)]
        interrupt_only_urgent: Option<bool>,
    },
    #[serde(rename = "decisionRight.set")]
    DecisionRightSet {
        /// Rule for this record.
        rule: Known<DecisionRule>,
        /// Who for this record.
        who: Known<Decider>,
        /// Daily limit for this record.
        #[serde(default)]
        daily_limit: Option<DailyLimit>,
    },
    #[serde(rename = "skill.run")]
    SkillRun {
        /// Model for this record.
        #[serde(default)]
        model: Option<ModelId>,
        /// Skill for this record.
        skill: SkillId,
        /// Text shown to the reader.
        #[schemars(length(min = 1, max = 4000))]
        #[serde(deserialize_with = "input::text")]
        text: String,
    },
    #[serde(rename = "access.set")]
    AccessSet {
        /// Identifier of the associated topic.
        topic_id: TopicId,
        /// Identifier of the associated person.
        person_id: PersonId,
        /// Access for this record.
        access: AccessGrantInput,
    },
    #[serde(rename = "access.invite")]
    AccessInvite {
        /// Identifier of the associated topic.
        topic_id: TopicId,
        /// Name or email for this record.
        #[schemars(length(min = 1, max = 200))]
        #[serde(deserialize_with = "input::name")]
        name_or_email: String,
    },
    #[serde(rename = "pin.move")]
    PinMove {
        /// Identifier of the associated pin.
        pin_id: PinId,
        /// To for this record.
        to: u8,
    },
    #[serde(rename = "topic.seen")]
    TopicSeen {
        /// Identifier of the associated topic.
        topic_id: TopicId,
    },
    #[serde(rename = "stage.assign")]
    StageAssign {
        /// Identifier of the associated topic.
        topic_id: TopicId,
        /// Stage for this record.
        #[schemars(length(min = 1, max = 200))]
        #[serde(deserialize_with = "input::name")]
        stage: String,
        /// Identifier of the associated person.
        person_id: PersonId,
    },
    #[serde(rename = "access.revoke")]
    AccessRevoke {
        /// Identifier of the associated invitation.
        invitation_id: InvitationId,
    },
    #[serde(rename = "access.statusLink")]
    AccessStatusLink {
        /// Identifier of the associated topic.
        topic_id: TopicId,
    },
    #[serde(rename = "skill.create")]
    SkillCreate {
        /// Description for this record.
        #[schemars(length(min = 1, max = 4000))]
        #[serde(deserialize_with = "input::text")]
        description: String,
    },
    #[serde(rename = "guardrail.set")]
    GuardrailSet {
        /// Name shown to the reader.
        #[schemars(length(min = 1, max = 200))]
        #[serde(deserialize_with = "input::name")]
        name: String,
        /// On for this record.
        on: bool,
    },
    #[serde(rename = "pull.hold")]
    PullHold {
        /// Identifier of the associated pull.
        pull_id: PullId,
    },
    #[serde(rename = "connection.connect")]
    ConnectionConnect {
        /// Identifier of the associated connection.
        connection_id: ConnectionId,
    },
    #[serde(rename = "module.switch")]
    ModuleSwitch {
        /// Identifier of the associated module.
        module_id: Known<ModuleId>,
    },
    #[serde(rename = "handover.confirm")]
    HandoverConfirm {
        /// Identifier of the associated lane.
        lane_id: LaneId,
    },
}

/// Receipt and sequenced updates produced by an accepted command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    /// Receipt for this record.
    pub receipt: Present<Receipt>,
    /// Ok for this record.
    pub ok: bool,
    /// Events for this record.
    pub events: Vec<FeedEvent>,
    /// Identifier of the associated lane.
    pub lane_id: Present<LaneId>,
    /// Message for this record.
    pub message: Present<Message>,
}

/// Context supplied by a composer when sending a message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetInput {
    /// Kind for this record.
    pub kind: Known<crate::TargetKind>,
    /// Stable identifier for this record.
    pub id: Present<String>,
}

/// Where the Manager filed a request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    /// Text shown to the reader.
    pub text: String,
    /// Filed under for this record.
    pub filed_under: Present<Target>,
    /// Lead for this record.
    pub lead: crate::Actor,
    /// Chain for this record.
    pub chain: bool,
    /// Identifier of the associated lane.
    pub lane_id: LaneId,
}
