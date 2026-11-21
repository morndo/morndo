use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{DecisionId, LaneId, Money, Target, Timestamp, TopicId};

use crate::actor::{Actor, ActorKind};
use crate::lane::LaneState;
use crate::present::Present;

/// Topic kind for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum TopicKind {
    Topic,
    Project,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Health state for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum HealthState {
    Ok,
    Warn,
    Bad,
    Idle,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Health for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    /// Current state of the record.
    pub state: HealthState,
    /// Word for this record.
    pub word: String,
}

/// Topic meta for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TopicMeta {
    /// Asked by for this record.
    pub asked_by: Present<String>,
    /// Owner line for this record.
    pub owner_line: Present<String>,
    /// Next report for this record.
    pub next_report: Present<String>,
    /// Parts for this record.
    pub parts: Vec<String>,
}

/// Fact for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    /// Value for this record.
    pub value: String,
    /// Label for this record.
    pub label: String,
}

/// Figure for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Figure {
    /// Value for this record.
    pub value: String,
    /// Of for this record.
    pub of: Present<String>,
    /// Label for this record.
    pub label: String,
}

/// Agent spend for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpend {
    /// Spent for this record.
    pub spent: Money,
    /// Cap for this record.
    pub cap: Money,
}

/// Verdict for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    /// Current state of the record.
    pub state: HealthState,
    /// Word for this record.
    pub word: String,
    /// Action for this record.
    pub action: String,
    /// Text shown to the reader.
    pub text: Present<String>,
}

/// Series point for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SeriesPoint {
    /// Day for this record.
    pub day: i64,
    /// Value for this record.
    pub value: i64,
}

/// Tick for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Tick {
    /// Day for this record.
    pub day: i64,
    /// Label for this record.
    pub label: String,
}

/// Trajectory for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Trajectory {
    /// Start for this record.
    pub start: String,
    /// Days for this record.
    pub days: i64,
    /// Now for this record.
    pub now: i64,
    /// Goal for this record.
    pub goal: i64,
    /// Step for this record.
    pub step: Present<i64>,
    /// Unit for this record.
    pub unit: Present<String>,
    /// Key for this record.
    pub key: Present<String>,
    /// Ticks for this record.
    pub ticks: Vec<Tick>,
    /// Plan for this record.
    pub plan: Vec<SeriesPoint>,
    /// Actual for this record.
    pub actual: Vec<SeriesPoint>,
    /// Expected for this record.
    pub expected: Vec<SeriesPoint>,
    /// Low for this record.
    pub low: Vec<SeriesPoint>,
    /// High for this record.
    pub high: Vec<SeriesPoint>,
    /// No forecast for this record.
    pub no_forecast: Present<String>,
    /// Title displayed above the record.
    pub title: String,
}

/// Deal alt for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DealAlt {
    /// Identifier of the associated decision.
    pub decision_id: DecisionId,
    /// Stage for this record.
    pub stage: Present<String>,
    /// Short for this record.
    pub short: Present<String>,
    /// Next for this record.
    pub next: Present<String>,
}

/// Deal for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Deal {
    /// Name shown to the reader.
    pub name: String,
    /// Confidence for this record.
    pub confidence: String,
    /// Close for this record.
    pub close: Present<String>,
    /// Chart day for this record.
    pub chart_day: Present<i64>,
    /// Stage for this record.
    pub stage: String,
    /// Short for this record.
    pub short: String,
    /// Identifier of the associated lane.
    pub lane_id: Present<LaneId>,
    /// Destination to open in the cockpit.
    pub target: Target,
    /// Evidence for this record.
    pub evidence: String,
    /// Next for this record.
    pub next: Present<String>,
    /// Value for this record.
    pub value: Present<String>,
    /// Alt for this record.
    pub alt: Present<DealAlt>,
}

/// Guardrail item for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GuardrailItem {
    /// Current state of the record.
    pub state: GuardrailState,
    /// What for this record.
    pub what: String,
    /// Value for this record.
    pub value: String,
    /// Limit for this record.
    pub limit: String,
    /// Ratio for this record.
    pub ratio: Present<f64>,
}

/// Guardrails for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Guardrails {
    /// Sub for this record.
    pub sub: String,
    /// Items for this record.
    pub items: Vec<GuardrailItem>,
}

/// Ladder rung for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LadderRung {
    /// Word for this record.
    pub word: String,
    /// Fact for this record.
    pub fact: String,
}

/// Gap for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    /// Says for this record.
    pub says: String,
    /// Steps for this record.
    pub steps: Vec<String>,
}

/// Blocker for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Blocker {
    /// Current state of the record.
    pub state: HealthState,
    /// Short for this record.
    pub short: String,
    /// What for this record.
    pub what: Present<String>,
    /// Why for this record.
    pub why: Present<String>,
    /// Who for this record.
    pub who: String,
    /// Destination to open in the cockpit.
    pub target: Target,
    /// Identifier of the associated lane.
    pub lane_id: Present<LaneId>,
}

/// Funnel step for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FunnelStep {
    /// Count for this record.
    pub count: String,
    /// What for this record.
    pub what: String,
    /// Change for this record.
    pub change: Present<String>,
    /// Rate for this record.
    pub rate: Present<String>,
    /// Current state of the record.
    pub state: Present<HealthState>,
}

/// Funnel for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Funnel {
    /// Title displayed above the record.
    pub title: String,
    /// Since for this record.
    pub since: String,
    /// Steps for this record.
    pub steps: Vec<FunnelStep>,
}

/// Rows heading for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RowsHeading {
    /// Title displayed above the record.
    pub title: String,
    /// Sub for this record.
    pub sub: String,
}

/// Goal decision for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GoalDecision {
    /// Title displayed above the record.
    pub title: String,
    /// Explanation shown alongside the summary.
    pub detail: String,
    /// Done for this record.
    pub done: Present<String>,
    /// Why for this record.
    pub why: Present<String>,
    /// Identifier of the associated decision.
    pub decision_id: Present<DecisionId>,
    /// Identifier of the associated lane.
    pub lane_id: Present<LaneId>,
    /// Approve label for this record.
    pub approve_label: Present<String>,
}

/// Goal for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    /// Deadline for reaching the goal.
    pub deadline_at: Present<Timestamp>,
    /// Forecast log for this record.
    pub forecast_log: Vec<Forecast>,
    /// Quantity the topic aims to achieve by its deadline.
    pub target: i64,
    /// Signed for this record.
    pub signed: i64,
    /// Likely for this record.
    pub likely: Present<i64>,
    /// Unit for this record.
    pub unit: String,
    /// Verdict for this record.
    pub verdict: Verdict,
    /// Insight for this record.
    pub insight: String,
    /// As of for this record.
    pub as_of: String,
    /// Decision for this record.
    pub decision: Present<GoalDecision>,
    /// Calm for this record.
    pub calm: Present<String>,
    /// Calm sub for this record.
    pub calm_sub: Present<String>,
    /// Trajectory for this record.
    pub trajectory: Trajectory,
    /// Milestones for this record.
    pub milestones: Vec<String>,
    /// Rows for this record.
    pub rows: Present<RowsHeading>,
    /// Deals for this record.
    pub deals: Vec<Deal>,
    /// Guardrails for this record.
    pub guardrails: Present<Guardrails>,
    /// Ladder for this record.
    pub ladder: Vec<LadderRung>,
    /// Calibration for this record.
    pub calibration: Present<String>,
    /// Outside for this record.
    pub outside: Present<String>,
    /// Gap for this record.
    pub gap: Present<Gap>,
    /// Blockers for this record.
    pub blockers: Vec<Blocker>,
    /// Routine for this record.
    pub routine: Present<String>,
    /// Funnel for this record.
    pub funnel: Present<Funnel>,
    /// Rest sub for this record.
    pub rest_sub: Present<String>,
    /// Figures for this record.
    pub figures: Vec<Figure>,
    /// Path title for this record.
    pub path_title: Present<String>,
}

/// Stage alt for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StageAlt {
    /// Identifier of the associated decision.
    pub decision_id: DecisionId,
    /// Current state of the record.
    pub state: Present<StageState>,
    /// Percent for this record.
    pub percent: Present<i64>,
    /// Summary for this record.
    pub summary: Present<String>,
}

/// Row alt for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RowAlt {
    /// Identifier of the associated decision.
    pub decision_id: DecisionId,
    /// Text shown to the reader.
    pub text: Present<String>,
    /// When for this record.
    pub when: Present<String>,
    /// Current state of the record.
    pub state: Present<LaneState>,
}

/// Stage row for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StageRow {
    /// Avatar for this record.
    pub avatar: String,
    /// Who for this record.
    pub who: String,
    /// Kind for this record.
    pub kind: ActorKind,
    /// Current state of the record.
    pub state: LaneState,
    /// Text shown to the reader.
    pub text: String,
    /// When for this record.
    pub when: String,
    /// Percent for this record.
    pub percent: Present<i64>,
    /// Destination to open in the cockpit.
    pub target: Present<Target>,
    /// Identifier of the associated lane.
    pub lane_id: Present<LaneId>,
    /// Alt for this record.
    pub alt: Present<RowAlt>,
}

/// Stage for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    /// Name shown to the reader.
    pub name: String,
    /// Current state of the record.
    pub state: StageState,
    /// Percent for this record.
    pub percent: i64,
    /// Summary for this record.
    pub summary: String,
    /// Rows for this record.
    pub rows: Vec<StageRow>,
    /// Alt for this record.
    pub alt: Present<StageAlt>,
}

/// Night stat for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NightStat {
    /// Value for this record.
    pub value: String,
    /// Label for this record.
    pub label: String,
}

/// Plan for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// Stages for this record.
    pub stages: Vec<Stage>,
    /// Night for this record.
    pub night: Vec<NightStat>,
}

/// History entry for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
/// History entry for the cockpit.
#[schemars(extend("$comment" = "cockpit-reader:tag:kind"))]
pub enum HistoryEntry {
    #[serde(rename = "seen")]
    Seen,
    #[serde(rename = "event")]
    Event {
        /// Stable identifier for this record.
        id: crate::ActionId,
        /// Undone for this record.
        undone: bool,
        /// Time the record was created or observed.
        at: Timestamp,
        /// Actor for this record.
        actor: Box<Actor>,
        /// Text shown to the reader.
        text: String,
        /// Identifier of the associated lane.
        lane_id: Present<LaneId>,
        /// Decision for this record.
        decision: bool,
        /// Sent outside for this record.
        sent_outside: bool,
        /// Undoable for this record.
        undoable: bool,
        /// Count for this record.
        count: Present<i64>,
        /// Samples for this record.
        samples: Vec<String>,
        /// Identifier of the associated decision.
        decision_id: Present<DecisionId>,
    },
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// History day for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDay {
    /// Label for this record.
    pub label: String,
    /// Entries for this record.
    pub entries: Vec<HistoryEntry>,
}

/// A page of activity in a topic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    /// Number of matching rows newer than the reader’s last visit, across all pages.
    pub new_since: u64,
    /// Seen for this record.
    pub seen: SeenMarker,
    /// Opaque cursor for the following page, or null at the end.
    pub next_cursor: Present<String>,
    /// Number of activity rows in this page.
    pub shown: i64,
    /// Since for this record.
    pub since: String,
    /// Days for this record.
    pub days: Vec<HistoryDay>,
}

/// Job for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    /// Job for this record.
    pub job: String,
    /// Agent for this record.
    pub agent: String,
    /// Current state of the record.
    pub state: LaneState,
    /// Due for this record.
    pub due: String,
    /// Identifier of the associated lane.
    pub lane_id: Present<LaneId>,
}

/// Topic lane for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TopicLane {
    /// Stable identifier for this record.
    pub id: LaneId,
    /// Title displayed above the record.
    pub title: String,
    /// Current state of the record.
    pub state: LaneState,
    /// State word for this record.
    pub state_word: String,
    /// Lead name for this record.
    pub lead_name: String,
    /// Next for this record.
    pub next: String,
}

/// Check result for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    /// Name shown to the reader.
    pub name: String,
    /// Passed for this record.
    pub passed: bool,
}

/// Failing test for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FailingTest {
    /// Name shown to the reader.
    pub name: String,
    /// Expected for this record.
    pub expected: String,
    /// Got for this record.
    pub got: String,
    /// Location for this record.
    pub location: String,
    /// Runs for this record.
    pub runs: i64,
    /// Failures for this record.
    pub failures: i64,
}

/// Stuck action for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StuckAction {
    /// Stable identifier for this record.
    pub id: crate::ActionId,
    /// Identifier of the associated lane.
    pub lane_id: LaneId,
    /// Destination to open in the cockpit.
    pub target: Present<Target>,
    /// Label for this record.
    pub label: String,
    /// Tone for this record.
    pub tone: crate::lane::ActionTone,
}

/// Stuck report for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StuckReport {
    /// Since for this record.
    pub since: String,
    /// Title displayed above the record.
    pub title: String,
    /// Explanation shown alongside the summary.
    pub detail: String,
    /// Blocks for this record.
    pub blocks: Present<String>,
    /// Checks for this record.
    pub checks: Vec<CheckResult>,
    /// Log for this record.
    pub log: Present<FailingTest>,
    /// Actions for this record.
    pub actions: Vec<StuckAction>,
    /// Note for this record.
    pub note: Present<String>,
}

/// Task row for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskRow {
    /// Identifier of the associated lane.
    pub lane_id: Present<LaneId>,
    /// Task for this record.
    pub task: String,
    /// Lane for this record.
    pub lane: String,
    /// Current state of the record.
    pub state: LaneState,
    /// State word for this record.
    pub state_word: String,
    /// Next for this record.
    pub next: String,
    /// Reason for this record.
    pub reason: Present<String>,
}

/// Progress, work and conversation context for one topic or project.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TopicView {
    /// Progress shared with a status-only reader.
    pub status: Present<SharedTopicStatus>,
    /// Viewer for this record.
    pub viewer: crate::access::TopicViewer,
    /// Stages for this record.
    pub stages: Vec<crate::access::ViewerStage>,
    /// Stable identifier for this record.
    pub id: TopicId,
    /// Name shown to the reader.
    pub name: String,
    /// Kind for this record.
    pub kind: TopicKind,
    /// Icon for this record.
    pub icon: String,
    /// Crumb for this record.
    pub crumb: String,
    /// Open for this record.
    pub open: bool,
    /// Meta for this record.
    pub meta: Present<TopicMeta>,
    /// Intro for this record.
    pub intro: String,
    /// When for this record.
    pub when: Present<String>,
    /// Health for this record.
    pub health: Present<Health>,
    /// Goal for this record.
    pub goal: Present<Goal>,
    /// No goal for this record.
    pub no_goal: Present<String>,
    /// Facts for this record.
    pub facts: Vec<Fact>,
    /// Plan for this record.
    pub plan: Present<Plan>,
    /// Identifier of the associated focus lane.
    pub focus_lane_id: Present<LaneId>,
    /// History for this record.
    pub history: Present<HistoryPage>,
    /// Crew for this record.
    pub crew: Vec<Actor>,
    /// Jobs for this record.
    pub jobs: Vec<Job>,
    /// Chat sub for this record.
    pub chat_sub: String,
    /// Lanes for this record.
    pub lanes: Vec<TopicLane>,
    /// Spend for this record.
    pub spend: Present<AgentSpend>,
    /// Stuck for this record.
    pub stuck: Present<StuckReport>,
    /// Tasks for this record.
    pub tasks: Vec<TaskRow>,
}

/// The reader's last visit to a topic or thread.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SeenMarker {
    /// Time of the visit.
    pub at: Present<Timestamp>,
}

/// Progress of a stage in a topic plan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum StageState {
    Done,
    Next,
    Now,
    Wait,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Evaluation of a guardrail at the current reading.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum GuardrailState {
    Held,
    Near,
    Breached,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Forecast and its later outcome, for calibration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Forecast {
    /// Word for this record.
    pub word: String,
    /// Time associated with given.
    pub given_at: Timestamp,
    /// Outcome for this record.
    pub outcome: String,
}

/// Aggregate progress without lanes, names, or private commentary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SharedTopicStatus {
    /// Topic whose status is shared.
    pub topic_id: TopicId,
    /// Topic heading visible to the reader.
    pub name: String,
    /// Current progress toward the goal.
    pub signed: Present<i64>,
    /// Quantity needed to reach the goal.
    pub goal: Present<i64>,
    /// Units used for the goal.
    pub unit: Present<String>,
    /// Whether the topic is on track.
    pub health: Present<Health>,
    /// Time of the next status report.
    pub next_report_at: Present<Timestamp>,
}
