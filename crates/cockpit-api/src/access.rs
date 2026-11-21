use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::TopicId;

use crate::actor::Actor;
use crate::{InvitationId, Present, Timestamp};

/// Access kind for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AccessKind {
    All,
    Stages,
    View,
    None,
    #[serde(other)]
    Unknown,
}

/// Access grant for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccessGrant {
    /// Kind for this record.
    pub kind: AccessKind,
    /// Stage names the person can work. Empty unless `kind` is `stages`.
    #[serde(default)]
    pub stages: Vec<String>,
}

/// Other topic access for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OtherTopicAccess {
    /// Identifier of the associated topic.
    pub topic_id: TopicId,
    /// Access for this record.
    pub access: AccessKind,
}

/// Access person for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccessPerson {
    /// Owner for this record.
    pub owner: bool,
    /// Person for this record.
    pub person: Actor,
    /// Access for this record.
    pub access: AccessGrant,
    /// Scope for this record.
    pub scope: String,
    /// Other topics for this record.
    pub other_topics: Vec<OtherTopicAccess>,
}

/// Sharing settings for one topic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccessView {
    /// Invitations for this record.
    pub invitations: Vec<Invitation>,
    /// Status link for this record.
    pub status_link: Present<StatusLink>,
    /// Identifier of the associated topic.
    pub topic_id: TopicId,
    /// Topic name for this record.
    pub topic_name: String,
    /// People for this record.
    pub people: Vec<AccessPerson>,
}

/// Access grant submitted by an administrator.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessGrantInput {
    /// Scope granted to the recipient.
    pub kind: crate::input::Known<AccessKind>,
    /// Allowed stage names when the scope is stage-based.
    #[serde(default)]
    pub stages: Vec<String>,
}

/// A request to share the topic with someone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Invitation {
    /// Stable identifier for this record.
    pub id: InvitationId,
    /// Name or email for this record.
    pub name_or_email: String,
    /// Current state of the record.
    pub state: InvitationState,
    /// Time associated with invited.
    pub invited_at: Timestamp,
}

/// Progress of an invitation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum InvitationState {
    Pending,
    Accepted,
    #[serde(other)]
    Unknown,
}

/// A link showing status without names, lanes or chat.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatusLink {
    /// Url for this record.
    #[schemars(extend("format" = "uri"))]
    pub url: String,
    /// Org only for this record.
    pub org_only: bool,
}

/// Effective topic access for the current reader.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TopicViewer {
    /// Role for this record.
    pub role: ViewerRole,
    /// Stages for this record.
    pub stages: Vec<String>,
    /// Shared by for this record.
    pub shared_by: Present<Actor>,
}

/// Access level applied to a topic view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ViewerRole {
    Owner,
    All,
    Stages,
    View,
    #[serde(other)]
    Unknown,
}

/// One handover stage and what the current reader can do in it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ViewerStage {
    /// Name shown to the reader.
    pub name: String,
    /// Access for this record.
    pub access: StageAccess,
    /// Run by for this record.
    pub run_by: Present<Actor>,
}

/// Access a reader has to one stage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum StageAccess {
    Work,
    View,
    Locked,
    #[serde(other)]
    Unknown,
}

/// Redacted progress shared through an organization-only status link.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TopicStatusView {
    /// Stages with their aggregate progress only.
    pub stages: Vec<StageStatus>,
    /// Topic progress in the current reporting period.
    pub health: Present<crate::Health>,
}

/// Aggregated progress in one stage, without names or work records.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StageStatus {
    /// Name of the stage.
    pub name: String,
    /// Progress from 0 to 100.
    pub percent: i64,
}
