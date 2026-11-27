use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{ActionId, DecisionId, LaneId, Money, Target, Timestamp, TopicId};

use crate::decision::DecisionState;
use crate::present::Present;

/// Artwork for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Artwork {
    /// Src for this record.
    pub src: String,
    /// Glass for this record.
    pub glass: String,
    /// Position for this record.
    pub position: String,
    /// Index for this record.
    pub index: i64,
    /// Total for this record.
    pub total: i64,
    /// Title displayed above the record.
    pub title: String,
    /// Manner for this record.
    pub manner: String,
    /// Alt for this record.
    pub alt: String,
    /// Credit for this record.
    pub credit: String,
}

/// Spend line for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpendLine {
    /// Overnight for this record.
    pub overnight: Money,
    /// Week for this record.
    pub week: Money,
    /// Cap for this record.
    pub cap: Money,
}

/// Brief topic for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BriefTopic {
    /// Stable identifier for this record.
    pub id: TopicId,
    /// Name shown to the reader.
    pub name: String,
    /// Current state of the record.
    pub state: crate::HealthState,
    /// Verdict for this record.
    pub verdict: String,
    /// Progress for this record.
    pub progress: String,
    /// Spend for this record.
    pub spend: Money,
}

/// Brief decision for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BriefDecision {
    /// Whether this reader may decide. The owner always may. A reader with full topic access may
    /// decide through a decision right assigned to them for this rule, except on a goal change.
    /// When false, show the decision and name who decides, and hide Approve, Decline and Undo.
    pub can_decide: bool,
    /// The manager or agent that proposed this, or null when the reader did.
    pub proposer: Present<crate::actor::Actor>,
    /// Decision right that governs this request.
    pub rule: Present<crate::DecisionRule>,
    /// Stable identifier for this record.
    pub id: DecisionId,
    /// Identifier of the associated topic.
    pub topic_id: TopicId,
    /// Topic name for this record.
    pub topic_name: String,
    /// Time an answer or action is due.
    pub due_at: Timestamp,
    /// Why yours for this record.
    pub why_yours: String,
    /// Title displayed above the record.
    pub title: String,
    /// Context for this record.
    pub context: String,
    /// Minutes for this record.
    pub minutes: i64,
    /// Done note for this record.
    pub done_note: String,
    /// Identifier of the associated lane.
    pub lane_id: Present<LaneId>,
    /// Current state of the record.
    pub state: DecisionState,
}

/// Burn for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Burn {
    /// Identifier of the associated lane.
    pub lane_id: crate::LaneId,
    /// Blocks for this record.
    pub blocks: Present<String>,
    /// Time an answer or action is due.
    pub due_at: Present<Timestamp>,
    /// Identifier of the associated topic.
    pub topic_id: TopicId,
    /// Topic name for this record.
    pub topic_name: String,
    /// Time associated with stuck.
    pub stuck_at: Timestamp,
    /// Title displayed above the record.
    pub title: String,
    /// Explanation shown alongside the summary.
    pub detail: String,
    /// Destination to open in the cockpit.
    pub target: Target,
}

/// Overnight action for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OvernightAction {
    /// Other lanes modified by a grouped action.
    #[serde(default)]
    pub related_lane_ids: Vec<LaneId>,
    /// Time until which the action can be undone. Set on every undoable overnight row. An undo after it, or on a row whose outcome was sent outside, is a conflict.
    pub undo_until_at: Present<Timestamp>,
    /// Stable identifier for this record.
    pub id: ActionId,
    /// Identifier of the associated topic.
    pub topic_id: Present<TopicId>,
    /// Topic name for this record.
    pub topic_name: String,
    /// Identifier of the associated lane.
    pub lane_id: Present<LaneId>,
    /// Text shown to the reader.
    pub text: String,
    /// Time the record was created or observed.
    pub at: Timestamp,
    /// Undoable for this record.
    pub undoable: bool,
    /// Undone for this record.
    pub undone: bool,
    /// What the action produced, or null when the row carries no count of results.
    pub outcome: Present<OvernightOutcome>,
    /// Decision right the action was taken under, or null when none applied.
    pub rule: Present<crate::DecisionRule>,
}

/// What an overnight action produced.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OvernightOutcome {
    /// What happened to the work.
    pub kind: OutcomeKind,
    /// Items the action covered, or null when it is not a count.
    pub count: Present<i64>,
    /// Items the action held back, or null when none were.
    pub held_back: Present<i64>,
    /// Review rounds it took, or null when it had no review.
    pub rounds: Present<i64>,
    /// Checks the action made; empty when it made none.
    pub checks: Vec<crate::topic::CheckResult>,
    /// Pull request the action belongs to, or null when it has none.
    pub pull_id: Present<crate::PullId>,
    /// Whether the action sent something outside the workspace. Such an action cannot be undone.
    pub sent_outside: bool,
}

/// What an overnight action did to the work.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum OutcomeKind {
    Released,
    Merged,
    Updated,
    Renewed,
    Deleted,
    Published,
    Sent,
    SwitchedOff,
    Added,
    Stopped,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Drafts summary for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DraftsSummary {
    /// Count for this record.
    pub count: i64,
    /// Text shown to the reader.
    pub text: String,
    /// Explanation shown alongside the summary.
    pub detail: String,
}

/// The current briefing and items that need attention.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BriefView {
    /// Settled items retained for the reader’s receipt and Undo.
    pub settled_burns: Vec<SettledBurn>,
    /// Shared progress visible without topic spending or private records.
    pub shared_topics: Vec<crate::topic::SharedTopicStatus>,
    /// In works for this record.
    pub in_works: Present<InWorks>,
    /// Time associated with overnight since.
    pub overnight_since_at: Timestamp,
    /// Burns sub for this record.
    pub burns_sub: Present<String>,
    /// Time the record was created or observed.
    pub at: Timestamp,
    /// Title displayed above the record.
    pub title: String,
    /// Lede for this record.
    pub lede: String,
    /// Time associated with next brief.
    pub next_brief_at: Timestamp,
    /// Cadence for this record.
    pub cadence: String,
    /// Spend for this record.
    pub spend: Present<SpendLine>,
    /// Topics for this record.
    pub topics: Vec<BriefTopic>,
    /// Decisions for this record.
    pub decisions: Vec<BriefDecision>,
    /// Open count for this record.
    pub open_count: i64,
    /// Minutes for this record.
    pub minutes: i64,
    /// Burns for this record.
    pub burns: Vec<Burn>,
    /// Overnight for this record.
    pub overnight: Vec<OvernightAction>,
    /// Drafts for this record.
    pub drafts: DraftsSummary,
    /// Artwork for this record.
    pub artwork: Artwork,
    /// Which edition of the day this is, for example 1 of 3, or null when the brief has one.
    pub edition: Present<crate::usage::MeterCount>,
}

/// Pull requests still in progress, grouped by what happens next.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InWorks {
    /// Count for this record.
    pub count: i64,
    /// Ready for this record.
    pub ready: i64,
    /// In review for this record.
    pub in_review: i64,
    /// Time associated with auto merge.
    pub auto_merge_at: Present<Timestamp>,
    /// Destination to open in the cockpit.
    pub target: Target,
}

/// A burn resolved by the reader during this edition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SettledBurn {
    /// Lane where the stuck work was settled.
    pub lane_id: crate::LaneId,
    /// Action recorded in the topic’s history for Undo.
    pub action_id: crate::ActionId,
    /// Resolution text shown in the brief and in the receipt.
    pub title: String,
    /// Status of the resolved burn.
    pub state_word: String,
    /// Whether anything still needs attention.
    pub detail: String,
    /// Topic to open from the settled row.
    pub target: Target,
}
