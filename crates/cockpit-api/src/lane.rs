use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{DecisionId, LaneId, Target, Timestamp, TopicId};

use crate::actor::Actor;
use crate::present::Present;

/// Lane state for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum LaneState {
    New,
    Ok,
    Warn,
    Bad,
    Done,
    Idle,
    Next,
    Parked,
    #[serde(other)]
    Unknown,
}

/// Step kind for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum StepKind {
    Ok,
    Now,
    Todo,
    #[serde(other)]
    Unknown,
}

/// Asked meta for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AskedMeta {
    /// Source for this record.
    pub source: String,
    /// Note for this record.
    pub note: Present<String>,
}

/// Standing for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Standing {
    /// Headline for this record.
    pub headline: String,
    /// Explanation shown alongside the summary.
    pub detail: String,
}

/// Lane act for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LaneAct {
    /// Label for this record.
    pub label: String,
    /// Tone for this record.
    pub tone: ActionTone,
}

/// Thumb for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Thumb {
    /// Label for this record.
    pub label: String,
    /// Passed for this record.
    pub passed: bool,
    /// Reason for this record.
    pub reason: Present<String>,
}

/// Step for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    /// Kind for this record.
    pub kind: StepKind,
    /// Text shown to the reader.
    pub text: String,
    /// Who for this record.
    pub who: String,
}

/// Made item for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MadeItem {
    /// Icon for this record.
    pub icon: String,
    /// Title displayed above the record.
    pub title: String,
    /// Explanation shown alongside the summary.
    pub detail: String,
    /// Destination to open in the cockpit.
    pub target: Present<Target>,
}

/// Handover for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Handover {
    /// Time the record was created or observed.
    pub at: Timestamp,
    /// Matched for this record.
    #[serde(rename = "match")]
    pub matched: bool,
    /// Why for this record.
    pub why: String,
    /// Current state of the record.
    pub summary: String,
    /// Open for this record.
    pub open: String,
    /// Risk for this record.
    pub risk: String,
    /// If so for this record.
    pub if_so: String,
    /// Restated for this record.
    pub restated: String,
    /// Fixed for this record.
    pub fixed: Present<String>,
}

/// A work item and its record of progress.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LaneView {
    /// Stable identifier for this record.
    pub id: LaneId,
    /// Identifier of the associated topic.
    pub topic_id: Present<TopicId>,
    /// Title displayed above the record.
    pub title: String,
    /// Current state of the record.
    pub state: LaneState,
    /// State word for this record.
    pub state_word: String,
    /// Lead for this record.
    pub lead: Actor,
    /// Waits for for this record.
    pub waits_for: Present<Actor>,
    /// Time associated with opened.
    pub opened_at: Timestamp,
    /// Time associated with closed.
    pub closed_at: Present<Timestamp>,
    /// Next for this record.
    pub next: Present<String>,
    /// After next for this record.
    pub after_next: Present<String>,
    /// Identifier of the associated decision.
    pub decision_id: Present<DecisionId>,
    /// Short for this record.
    pub short: Present<String>,
    /// Ask for this record.
    pub ask: Present<String>,
    /// Short after for this record.
    pub short_after: Present<String>,
    /// Recommendation for this record.
    pub recommendation: Present<String>,
    /// Yours for this record.
    pub yours: Present<String>,
    /// Checks for this record.
    pub checks: Vec<String>,
    /// Delay for this record.
    pub delay: Present<String>,
    /// Approve label for this record.
    pub approve_label: Present<String>,
    /// After for this record.
    pub after: Present<String>,
    /// Asked for this record.
    pub asked: String,
    /// Asked meta for this record.
    pub asked_meta: AskedMeta,
    /// Status for this record.
    pub status: String,
    /// Standing for this record.
    pub standing: Standing,
    /// Acts for this record.
    pub acts: Vec<LaneAct>,
    /// Thumbs for this record.
    pub thumbs: Vec<Thumb>,
    /// Steps for this record.
    pub steps: Vec<Step>,
    /// Done note for this record.
    pub done_note: String,
    /// Crew for this record.
    pub crew: Vec<Actor>,
    /// Made for this record.
    pub made: Vec<MadeItem>,
    /// Handover for this record.
    pub handover: Present<Handover>,
    /// Fresh for this record.
    pub fresh: bool,
}

/// Visual treatment of an action button.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ActionTone {
    Ink,
    Quiet,
    #[serde(other)]
    Unknown,
}
