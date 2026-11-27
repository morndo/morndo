use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{DecisionId, LaneId, Target, Timestamp, TopicId};

use crate::present::Present;

/// Decision state for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum DecisionState {
    Open,
    Approved,
    Declined,
    Expired,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Stat for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    /// Money for this record.
    pub money: Present<crate::Money>,
    /// Label for this record.
    pub label: String,
    /// Value for this record.
    pub value: String,
    /// Sub for this record.
    pub sub: Present<String>,
}

/// Proof for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Proof {
    /// Items for this record.
    pub items: Vec<Stat>,
    /// Meta for this record.
    pub meta: Vec<String>,
    /// Unchecked for this record.
    pub unchecked: Present<String>,
}

/// One possible outcome shown in the decision forecast.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Scenario {
    /// Legend for the projected series.
    pub series_label: String,
    /// Legend for the unchanged comparison.
    pub baseline_label: String,
    /// Series for this record.
    pub series: Vec<ChartPoint>,
    /// Baseline for this record.
    pub baseline: Vec<ChartPoint>,
    /// Unit for this record.
    pub unit: String,
    /// Axis for this record.
    pub axis: Vec<f64>,
    /// Marker for this record.
    pub marker: Present<ChartMarker>,
    /// Kind for this record.
    pub kind: ScenarioKind,
    /// Label for this record.
    pub label: String,
    /// Headline for this record.
    pub headline: String,
    /// Condition for this record.
    pub condition: String,
    /// Summary for this record.
    pub summary: String,
}

/// Next step for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NextStep {
    /// Whether the step is done, under way or still to do, or null when it is not tracked.
    pub state: Present<crate::lane::StepKind>,
    /// Time the step finished, or null while it is not done.
    pub done_at: Present<Timestamp>,
    /// Module to open when the next step crosses into another module.
    pub module_id: Present<crate::ModuleId>,
    /// Destination to open in the cockpit.
    pub target: Present<Target>,
    /// Step for this record.
    pub step: String,
    /// Who for this record.
    pub who: String,
    /// Time an answer or action is due.
    pub due_at: Present<Timestamp>,
}

/// Provenance for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    /// Identifier of the associated lane.
    pub lane_id: Present<LaneId>,
    /// Lane title for this record.
    pub lane_title: String,
    /// Written by for this record.
    pub written_by: String,
    /// Checked by for this record.
    pub checked_by: String,
    /// Time associated with checked.
    pub checked_at: Timestamp,
}

/// Queue item for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    /// Whether this reader may decide. The owner always may. A reader with full topic access may
    /// decide through a decision right assigned to them for this rule, except on a goal change.
    /// When false, show the decision and name who decides, and hide Approve, Decline and Undo.
    pub can_decide: bool,
    /// The manager or agent that proposed this, or null when the reader did.
    pub proposer: Present<crate::actor::Actor>,
    /// Goal change for this record.
    pub goal_change: Present<GoalChange>,
    /// Stable identifier for this record.
    pub id: DecisionId,
    /// Title displayed above the record.
    pub title: String,
    /// Current state of the record.
    pub state: DecisionState,
    /// Topic name for this record.
    pub topic_name: String,
    /// Destination to open in the cockpit.
    pub target: Target,
}

/// Decision queue view for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecisionQueueView {
    /// Items for this record.
    pub items: Vec<QueueItem>,
    /// Open for this record.
    pub open: i64,
    /// Total for this record.
    pub total: i64,
}

/// The evidence, consequences and next steps for a decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecisionView {
    /// Whether this reader may decide. The owner always may. A reader with full topic access may
    /// decide through a decision right assigned to them for this rule, except on a goal change.
    /// When false, show the decision and name who decides, and hide Approve, Decline and Undo.
    pub can_decide: bool,
    /// The manager or agent that proposed this, or null when the reader did.
    pub proposer: Present<crate::actor::Actor>,
    /// Decision right that governs approval, decline and Undo.
    pub rule: Present<crate::DecisionRule>,
    /// Short title for this record.
    pub short_title: String,
    /// Goal change for this record.
    pub goal_change: Present<GoalChange>,
    /// Release for this record.
    pub release: Present<Release>,
    /// Change request for this record.
    pub change_request: Present<String>,
    /// Stable identifier for this record.
    pub id: DecisionId,
    /// Title displayed above the record.
    pub title: String,
    /// Current state of the record.
    pub state: DecisionState,
    /// Identifier of the associated topic.
    pub topic_id: TopicId,
    /// Topic name for this record.
    pub topic_name: String,
    /// Time an answer or action is due.
    pub due_at: Timestamp,
    /// Why yours for this record.
    pub why_yours: Present<String>,
    /// Minutes for this record.
    pub minutes: i64,
    /// Context line for this record.
    pub context_line: String,
    /// The short paragraph on the decision card. The full page uses `context`.
    pub card_context: String,
    /// Done note for this record.
    pub done_note: String,
    /// Identifier of the associated lane.
    pub lane_id: Present<LaneId>,
    /// Approve label for this record.
    pub approve_label: String,
    /// Provenance for this record.
    pub provenance: Present<Provenance>,
    /// Context for this record.
    pub context: Present<String>,
    /// Numbers for this record.
    pub numbers: Vec<Stat>,
    /// Proof for this record.
    pub proof: Present<Proof>,
    /// Opportunity for this record.
    pub opportunity: Present<Scenario>,
    /// Risk for this record.
    pub risk: Present<Scenario>,
    /// Suggestion for this record.
    pub suggestion: Present<String>,
    /// Guardrail for this record.
    pub guardrail: Present<String>,
    /// Next steps for this record.
    pub next_steps: Vec<NextStep>,
    /// If no answer for this record.
    pub if_no_answer: Present<String>,
    /// Position for this record.
    pub position: DecisionPosition,
}

/// Which side of the forecast the chart describes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum ScenarioKind {
    Opportunity,
    Risk,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// A point displayed in a decision chart.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChartPoint {
    /// X for this record.
    pub x: String,
    /// Y for this record.
    pub y: f64,
}

/// Annotation at a category on the chart.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChartMarker {
    /// X for this record.
    pub x: String,
    /// Label for this record.
    pub label: String,
}

/// Position within the decision queue as seen by this reader.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecisionPosition {
    /// Index for this record.
    pub index: i64,
    /// Of for this record.
    pub of: i64,
    /// Open for this record.
    pub open: i64,
}

/// Proposed change to a topic's goal, spend cap or priority. Budget and priority can change
/// on a topic without a goal. Target, deadline, unit and guardrail changes require a goal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GoalChange {
    /// Desired deadline, when it changes.
    pub deadline_at: Present<Timestamp>,
    /// Original deadline when this proposal was written, or null for a topic without a goal or deadline.
    pub previous_deadline_at: Present<Timestamp>,
    /// Desired unit, when it changes.
    pub unit: Present<String>,
    /// Original unit when this proposal was written, or null for a topic without a goal.
    pub previous_unit: Present<String>,
    /// Identifier of the associated topic.
    pub topic_id: TopicId,
    /// Field for this record.
    pub field: GoalField,
    /// Value before the change. For a typed payload it carries that payload's number: amountMinor, rank or limit value, rounded when a limit is fractional (the payload holds the exact one).
    pub from: i64,
    /// Value the proposal asks for, as `from`.
    pub to: i64,
    /// Other topics affected by the change, such as those that share a budget, resource or report,
    /// or whose rank changes. Excludes the changed topic.
    pub affected_topics: Vec<TopicId>,
    /// Typed payload of a budget change, or null for any other field.
    pub budget: Present<BudgetChange>,
    /// Typed payload of a priority change, or null for any other field.
    pub priority: Present<PriorityChange>,
    /// Typed payload of a guardrail change, or null for any other field.
    pub guardrail: Present<GuardrailChange>,
}

/// A proposed change to a topic's spend cap.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BudgetChange {
    /// Cap before the change.
    pub from: crate::Money,
    /// Cap the proposal asks for.
    pub to: crate::Money,
    /// Period the cap covers, for example "week", or null when it has none.
    pub period: Present<String>,
}

/// A proposed change to a topic's rank among the topics of its module.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PriorityChange {
    /// Rank before the change (1 is first), or null when the topic had none.
    pub from: Present<i64>,
    /// Rank the proposal asks for (1 is first).
    pub to: i64,
}

/// A proposed change to the limit of a guardrail.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GuardrailChange {
    /// Guardrail the proposal changes.
    pub guardrail_id: String,
    /// Name of the guardrail as the reader sees it.
    pub name: String,
    /// Limit before the change.
    pub from: crate::topic::MeasuredValue,
    /// Limit the proposal asks for.
    pub to: crate::topic::MeasuredValue,
}

/// Goal field being edited.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum GoalField {
    Target,
    Deadline,
    Unit,
    Budget,
    Priority,
    Guardrail,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Rollout lifecycle for a release decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum ReleaseStage {
    Scheduled,
    Rolling,
    Watching,
    Done,
    Held,
    RolledBack,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Staged rollout linked to the decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    /// Scheduled start of an approved rollout.
    pub scheduled_at: Timestamp,
    /// Identifier of the associated pull.
    pub pull_id: crate::PullId,
    /// Stage for this record.
    pub stage: ReleaseStage,
    /// Percent for this record.
    pub percent: i64,
    /// Watch minutes for this record.
    pub watch_minutes: i64,
    /// Rollback trigger for this record.
    pub rollback_trigger: String,
    /// Time associated with started.
    pub started_at: Present<Timestamp>,
}
