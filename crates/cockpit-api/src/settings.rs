use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::present::Present;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ThemeId {
    Ink,
    Ember,
    Sand,
    Moss,
    Tide,
    Sky,
    Iris,
    Rose,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ChatMode {
    Floating,
    Sidebar,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Decider {
    You,
    Agent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DecisionRule {
    InYourName,
    HardToUndo,
    OnlyYouKnow,
    InsideGuardrails,
    OverWeeklyCap,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Theme {
    pub id: ThemeId,
    pub name: String,
    pub strength: i64,
    pub glass: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Layout {
    pub sidebar_width: i64,
    pub chat_width: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleCard {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub here: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecisionRight {
    pub rule: DecisionRule,
    pub title: String,
    pub detail: String,
    pub who: Decider,
    pub daily_limit: Present<i64>,
    pub risky: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsView {
    pub briefs_per_day: i64,
    pub interrupt_only_urgent: bool,
    pub decision_rights: Vec<DecisionRight>,
    pub theme: Theme,
    pub chat_mode: ChatMode,
    pub layout: Layout,
    pub modules: Vec<ModuleCard>,
}

/// Partial theme written by `prefs.set`. Every field may be omitted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct ThemePatch {
    pub id: Option<ThemeId>,
    pub strength: Option<i64>,
    pub glass: Option<i64>,
}

/// Partial layout written by `prefs.set`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct LayoutPatch {
    pub sidebar_width: Option<i64>,
    pub chat_width: Option<i64>,
}
