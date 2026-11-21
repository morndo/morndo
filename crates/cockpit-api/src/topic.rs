use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::actor::{Actor, ActorKind};
use crate::lane::LaneState;
use crate::present::Present;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TopicKind {
    Topic,
    Project,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum HealthState {
    Ok,
    Warn,
    Bad,
    Idle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Health {
    pub state: HealthState,
    pub word: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TopicMeta {
    pub asked_by: Present<String>,
    pub owner_line: Present<String>,
    pub next_report: Present<String>,
    pub parts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fact {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Figure {
    pub value: String,
    pub of: Present<String>,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSpend {
    pub spent: i64,
    pub cap: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Verdict {
    pub state: HealthState,
    pub word: String,
    pub action: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SeriesPoint {
    pub day: i64,
    pub value: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tick {
    pub day: i64,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Trajectory {
    pub start: String,
    pub days: i64,
    pub now: i64,
    pub goal: i64,
    pub step: Present<i64>,
    pub unit: Present<String>,
    pub key: Present<String>,
    pub ticks: Vec<Tick>,
    pub plan: Vec<SeriesPoint>,
    pub actual: Vec<SeriesPoint>,
    pub expected: Vec<SeriesPoint>,
    pub low: Vec<SeriesPoint>,
    pub high: Vec<SeriesPoint>,
    pub no_forecast: Present<String>,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DealAlt {
    pub decision_id: String,
    pub stage: Present<String>,
    pub short: Present<String>,
    pub next: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Deal {
    pub name: String,
    pub confidence: String,
    pub close: Present<String>,
    pub at: Present<i64>,
    pub stage: String,
    pub short: String,
    pub lane_id: Present<String>,
    pub href: String,
    pub evidence: String,
    pub next: Present<String>,
    pub value: Present<String>,
    pub alt: Present<DealAlt>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuardrailItem {
    pub what: String,
    pub value: String,
    pub limit: String,
    pub ratio: Present<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Guardrails {
    pub sub: String,
    pub items: Vec<GuardrailItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LadderRung {
    pub word: String,
    pub fact: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Gap {
    pub says: String,
    pub steps: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Blocker {
    pub state: String,
    pub short: String,
    pub what: Present<String>,
    pub why: Present<String>,
    pub who: String,
    pub href: String,
    pub lane_id: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FunnelStep {
    pub count: String,
    pub what: String,
    pub change: Present<String>,
    pub rate: Present<String>,
    pub state: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Funnel {
    pub title: String,
    pub since: String,
    pub steps: Vec<FunnelStep>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RowsHeading {
    pub title: String,
    pub sub: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalDecision {
    pub title: String,
    pub detail: String,
    pub done: String,
    pub why: Present<String>,
    pub decision_id: Present<String>,
    pub lane_id: Present<String>,
    pub approve_label: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Goal {
    pub target: i64,
    pub signed: i64,
    pub likely: Present<i64>,
    pub unit: String,
    pub verdict: Verdict,
    pub insight: String,
    pub as_of: String,
    pub decision: Present<GoalDecision>,
    pub calm: Present<String>,
    pub calm_sub: Present<String>,
    pub trajectory: Trajectory,
    pub milestones: Vec<String>,
    pub rows: Present<RowsHeading>,
    pub deals: Vec<Deal>,
    pub guardrails: Present<Guardrails>,
    pub ladder: Vec<LadderRung>,
    pub calibration: Present<String>,
    pub outside: Present<String>,
    pub gap: Present<Gap>,
    pub blockers: Vec<Blocker>,
    pub routine: Present<String>,
    pub funnel: Present<Funnel>,
    pub rest_sub: Present<String>,
    pub figures: Vec<Figure>,
    pub path_title: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageAlt {
    pub decision_id: String,
    pub state: Present<String>,
    pub percent: Present<i64>,
    pub summary: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RowAlt {
    pub decision_id: String,
    pub text: Present<String>,
    pub when: Present<String>,
    pub state: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageRow {
    pub avatar: String,
    pub who: String,
    pub kind: ActorKind,
    pub state: String,
    pub text: String,
    pub when: String,
    pub percent: Present<i64>,
    pub href: Present<String>,
    pub lane_id: Present<String>,
    pub alt: Present<RowAlt>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stage {
    pub name: String,
    pub state: String,
    pub percent: i64,
    pub summary: String,
    pub rows: Vec<StageRow>,
    pub alt: Present<StageAlt>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NightStat {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub stages: Vec<Stage>,
    pub night: Vec<NightStat>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum HistoryEntry {
    #[serde(rename = "seen")]
    Seen,
    #[serde(rename = "event")]
    Event {
        pub time: String,
        pub actor: Actor,
        pub text: String,
        pub lane_id: Present<String>,
        pub decision: bool,
        pub sent_outside: bool,
        pub undoable: bool,
        pub count: Present<i64>,
        pub samples: Vec<String>,
        pub decision_id: Present<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryDay {
    pub label: String,
    pub entries: Vec<HistoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct History {
    pub seen: String,
    pub shown: i64,
    pub since: String,
    pub days: Vec<HistoryDay>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Job {
    pub job: String,
    pub agent: String,
    pub state: LaneState,
    pub due: String,
    pub lane_id: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TopicLane {
    pub id: String,
    pub title: String,
    pub state: LaneState,
    pub state_word: String,
    pub lead_name: String,
    pub next: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckResult {
    pub name: String,
    pub passed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FailingTest {
    pub name: String,
    pub expected: String,
    pub got: String,
    pub location: String,
    pub runs: i64,
    pub failures: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StuckAction {
    pub label: String,
    pub tone: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StuckReport {
    pub since: String,
    pub title: String,
    pub detail: String,
    pub blocks: Present<String>,
    pub checks: Vec<CheckResult>,
    pub log: Present<FailingTest>,
    pub actions: Vec<StuckAction>,
    pub note: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskRow {
    pub task: String,
    pub lane: String,
    pub state: String,
    pub state_word: String,
    pub next: String,
    pub reason: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TopicView {
    pub id: String,
    pub name: String,
    pub kind: TopicKind,
    pub icon: String,
    pub crumb: String,
    pub open: bool,
    pub meta: Present<TopicMeta>,
    pub intro: String,
    pub when: Present<String>,
    pub health: Present<Health>,
    pub goal: Present<Goal>,
    pub no_goal: Present<String>,
    pub facts: Vec<Fact>,
    pub plan: Present<Plan>,
    pub focus_lane_id: Present<String>,
    pub history: Present<History>,
    pub crew: Vec<Actor>,
    pub jobs: Vec<Job>,
    pub chat_sub: String,
    pub lanes: Vec<TopicLane>,
    pub spend: Present<AgentSpend>,
    pub stuck: Present<StuckReport>,
    pub tasks: Vec<TaskRow>,
}
