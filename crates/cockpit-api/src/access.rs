use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::TopicId;

use crate::actor::Actor;
use crate::{InvitationId, Present, Timestamp};

/// Access kind for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum AccessKind {
    All,
    Stages,
    View,
    None,
    #[serde(other)]
    #[schemars(skip)]
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
    /// Address used for this person’s invitations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
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
    #[schemars(schema_with = "crate::input::stage_names_schema")]
    #[serde(deserialize_with = "crate::input::stage_names")]
    pub stages: Vec<String>,
}

/// A request to share the topic with someone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Invitation {
    /// Person whose access can be set while the invitation is pending.
    pub person_id: crate::PersonId,
    /// Stable identifier for this record.
    pub id: InvitationId,
    /// Name or email for this record.
    pub name_or_email: String,
    /// Current state of the record.
    pub state: InvitationState,
    /// Time associated with invited.
    pub invited_at: Timestamp,
    /// Time the invitation was accepted, or null while it is pending.
    pub accepted_at: Present<Timestamp>,
    /// Topic the invitation is for, or null when it is for the workspace.
    pub topic_id: Present<TopicId>,
    /// Person who sent the invitation, or null when it is not recorded.
    pub invited_by: Present<Actor>,
}

/// A person in the workspace, with the access they hold.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    /// The person.
    pub person: Actor,
    /// Address used for the person's invitations, or null when unknown.
    pub email: Present<String>,
    /// Role in the workspace, or null when none is set.
    pub role: Present<String>,
    /// Whether the person owns the workspace.
    pub owner: bool,
    /// Access the person holds on each topic.
    pub access: Vec<OtherTopicAccess>,
    /// Time the person was invited, or null when they were not invited.
    pub invited_at: Present<Timestamp>,
    /// Time the person joined, or null while the invitation is pending.
    pub joined_at: Present<Timestamp>,
}

/// Everyone in the workspace and the invitations still open. Only the owner can read it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MembersView {
    /// Active and invited members.
    pub items: Vec<Member>,
    /// Invitations across the workspace.
    pub invitations: Vec<Invitation>,
}

/// Progress of an invitation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum InvitationState {
    Pending,
    Accepted,
    #[serde(other)]
    #[schemars(skip)]
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
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum ViewerRole {
    Owner,
    All,
    Stages,
    View,
    #[serde(other)]
    #[schemars(skip)]
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
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum StageAccess {
    Work,
    View,
    Locked,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Redacted progress shared through an organization-only status link.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TopicStatusView {
    /// Progress measured for the current goal.
    pub signed: Present<i64>,
    /// Target quantity in the status summary.
    pub goal: Present<i64>,
    /// Units used for progress.
    pub unit: Present<String>,
    /// Next report time.
    pub next_report_at: Present<Timestamp>,
    /// Stages with their aggregate progress only.
    pub stages: Vec<StageStatus>,
    /// Topic progress in the current reporting period.
    pub health: Present<crate::Health>,
    /// Report that is due next, or null when none is scheduled.
    pub next_report_id: Present<crate::ReportId>,
}

/// Aggregated progress in one stage, without names or work records.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StageStatus {
    /// Name of the stage.
    pub name: String,
    /// Progress from 0 to 100.
    pub percent: i64,
}

/// A person shown in the topic header without their private profile or work details.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SeenByFace {
    /// The person has status access while they wait to accept their invitation.
    pub pending: bool,
    /// Stable person identifier.
    pub id: crate::PersonId,
    /// Person’s display name.
    pub name: String,
    /// Initials shown in the topic header.
    pub avatar: Present<String>,
    /// Whether this person works on this topic or watches its status.
    pub access: StageAccess,
}
