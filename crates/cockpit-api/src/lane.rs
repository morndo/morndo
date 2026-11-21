use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::actor::Actor;
use crate::present::Present;

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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum StepKind {
    Ok,
    Now,
    Todo,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AskedMeta {
    pub source: String,
    pub note: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Standing {
    pub headline: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaneAct {
    pub label: String,
    pub tone: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Thumb {
    pub label: String,
    pub passed: bool,
    pub reason: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Step {
    pub kind: StepKind,
    pub text: String,
    pub who: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MadeItem {
    pub icon: String,
    pub title: String,
    pub detail: String,
    pub href: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Handover {
    pub when: String,
    #[serde(rename = "match")]
    pub matched: bool,
    pub why: String,
    pub state: String,
    pub open: String,
    pub risk: String,
    pub if_so: String,
    pub restated: String,
    pub fixed: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaneView {
    pub id: String,
    pub topic_id: Present<String>,
    pub title: String,
    pub state: LaneState,
    pub state_word: String,
    pub lead: Actor,
    pub waits_for: Present<Actor>,
    pub opened: String,
    pub closed: Present<String>,
    pub next: Present<String>,
    pub after_next: Present<String>,
    pub decision_id: Present<String>,
    pub short: Present<String>,
    pub ask: Present<String>,
    pub short_after: Present<String>,
    pub recommendation: Present<String>,
    pub yours: Present<String>,
    pub checks: Vec<String>,
    pub delay: Present<String>,
    pub approve_label: Present<String>,
    pub after: Present<String>,
    pub asked: String,
    pub asked_meta: AskedMeta,
    pub status: String,
    pub standing: Standing,
    pub acts: Vec<LaneAct>,
    pub thumbs: Vec<Thumb>,
    pub steps: Vec<Step>,
    pub done_note: String,
    pub crew: Vec<Actor>,
    pub made: Vec<MadeItem>,
    pub handover: Present<Handover>,
    pub fresh: bool,
}
