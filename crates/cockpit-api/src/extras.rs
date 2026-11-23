use crate::{Present, Target, Timestamp};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// A staging run, CI run, review or file opened from the work it records. Every target a lane's made items point at resolves to one of these, never to the lane itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MadeRecordView {
    /// Identifier in the lane's made-item target.
    pub id: crate::RecordId,
    /// Category of the review or run.
    pub kind: crate::TargetKind,
    /// Work this record belongs to.
    pub lane_id: crate::LaneId,
    /// Heading of the record.
    pub title: String,
    /// Result shown in the record.
    pub detail: String,
    /// Link to the file, draft or page the record points at, or null when it has none.
    pub url: Present<String>,
    /// What started a run, in words, or null for a review or file.
    pub trigger: Present<String>,
    /// Time the run started, or null for a record that is not a run.
    pub started_at: Present<Timestamp>,
    /// Time the run finished, or null while it runs or when it is not a run.
    pub finished_at: Present<Timestamp>,
    /// Outcome of the run, or null for a record that is not a run.
    pub state: Present<crate::GateState>,
    /// Checks the run made; empty for a record that is not a run.
    pub checks: Vec<crate::topic::CheckResult>,
    /// The failing test the run stopped on, or null when none failed.
    pub log: Present<crate::topic::FailingTest>,
    /// Pull request the run belongs to, or null when it ran outside one.
    pub pull_id: Present<crate::PullId>,
}

/// Recent pages for the current reader, newest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecentView {
    /// Last six distinct pages.
    #[schemars(length(max = 6))]
    pub items: Vec<RecentPage>,
}

/// A page the reader opened recently.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecentPage {
    /// Navigation destination.
    pub target: Target,
    /// Display label for the page.
    pub title: String,
    /// Time the reader opened it.
    pub at: Timestamp,
}

/// Binary data and display name supplied by the composer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadInput {
    /// File name to show on the attachment.
    #[schemars(length(min = 1, max = 200))]
    #[serde(deserialize_with = "crate::input::name")]
    pub name: String,
    /// Base64 file bytes, capped at 512 KiB decoded.
    #[schemars(
        length(min = 4, max = 699052),
        regex(pattern = "^[A-Za-z0-9+/]+={0,2}$")
    )]
    pub data: String,
}
