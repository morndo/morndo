//! Schedules, reports and spot checks: the recurring work a topic keeps.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::actor::Actor;
use crate::present::Present;
use crate::topic::MeasuredValue;
use crate::{CheckId, DraftId, LaneId, ReportId, ScheduleId, Timestamp, TopicId};

/// What a schedule runs when it fires.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum ScheduleKind {
    Lane,
    Report,
    Check,
    Brief,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// A recurring rule that files a lane, writes a report, runs a spot check or publishes a brief.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    /// Stable identifier of the schedule.
    pub id: ScheduleId,
    /// What the schedule runs when it fires.
    pub kind: ScheduleKind,
    /// Name of the schedule as the reader sees it.
    pub title: String,
    /// Topic the schedule belongs to, or null when it covers the whole workspace.
    pub topic_id: Present<TopicId>,
    /// Recurrence as an RFC 5545 rule, read in the workspace time zone.
    pub rrule: String,
    /// The recurrence in words.
    pub text: String,
    /// Local time of day the schedule fires ("HH:MM"), or null when the rule has no fixed time.
    pub time: Present<String>,
    /// Time of the next run, or null when the schedule is off.
    pub next_at: Present<Timestamp>,
    /// Time of the last run, or null when it has not run yet.
    pub last_at: Present<Timestamp>,
    /// Lane the last run filed, or null when it filed none.
    pub last_lane_id: Present<LaneId>,
    /// Where the schedule came from, in words.
    pub source: String,
    /// Person or agent that set the schedule up.
    pub opener: Actor,
    /// Whether the schedule is switched on.
    pub on: bool,
}

/// Where a report is in its cycle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum ReportState {
    Scheduled,
    Drafting,
    Drafted,
    Sent,
    Skipped,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// A status report a topic sends to its recipients on a schedule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// Stable identifier of the report.
    pub id: ReportId,
    /// Topic the report covers.
    pub topic_id: TopicId,
    /// Title of the report.
    pub title: String,
    /// People who receive the report.
    pub recipients: Vec<Actor>,
    /// Person or agent that writes the report.
    pub writer: Actor,
    /// Schedule that produces the report, or null when it was written once.
    pub schedule_id: Present<ScheduleId>,
    /// Time the report is due.
    pub due_at: Timestamp,
    /// Where the report is in its cycle.
    pub state: ReportState,
    /// Draft that holds the written report, or null before one exists.
    pub draft_id: Present<DraftId>,
    /// Time the report was sent, or null while it is not sent.
    pub sent_at: Present<Timestamp>,
    /// Person or agent that checked the numbers, or null when unchecked.
    pub checked_by: Present<Actor>,
    /// Start of the period the report covers, or null when it has none.
    pub period_from: Present<Timestamp>,
    /// End of the period the report covers, or null when it has none.
    pub period_to: Present<Timestamp>,
}

/// One report, read by id: the fields of a [`Report`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReportView {
    /// The report itself.
    #[serde(flatten)]
    pub report: Report,
}

/// How a spot check picked what to look at.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum SpotCheckKind {
    Random,
    Periodic,
    Numbers,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// What a spot check found.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum SpotCheckOutcome {
    Held,
    Failed,
    Mixed,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// A check of a sample of finished work against a rule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpotCheck {
    /// Stable identifier of the check.
    pub id: CheckId,
    /// How the check picked its sample.
    pub kind: SpotCheckKind,
    /// Topic the check belongs to.
    pub topic_id: TopicId,
    /// Lane whose work was checked, or null when the check spans lanes.
    pub lane_id: Present<LaneId>,
    /// Schedule that ran the check, or null for a one-off check.
    pub schedule_id: Present<ScheduleId>,
    /// Person or agent that ran the check.
    pub checker: Actor,
    /// Person or agent whose work was checked, or null when several.
    pub subject: Present<Actor>,
    /// Time the check ran.
    pub at: Timestamp,
    /// The rule the sample was checked against.
    pub rule: String,
    /// Size of the sample, or null when it is not a count.
    pub sample: Present<MeasuredValue>,
    /// What the check found.
    pub outcome: SpotCheckOutcome,
    /// Items that met the rule.
    pub passed: i64,
    /// Items that broke the rule.
    pub failed: i64,
    /// The finding in words.
    pub text: String,
    /// Lane filed to fix what the check found, or null when none was.
    pub follow_up_lane_id: Present<LaneId>,
}

/// One spot check, read by id: the fields of a [`SpotCheck`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckView {
    /// The check itself.
    #[serde(flatten)]
    pub check: SpotCheck,
}
