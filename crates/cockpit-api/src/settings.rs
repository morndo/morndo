use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::present::Present;

/// Theme id for the cockpit.
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
    #[serde(other)]
    Unknown,
}

/// Chat mode for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ChatMode {
    Floating,
    Sidebar,
    #[serde(other)]
    Unknown,
}

/// Decider for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Decider {
    You,
    Agent,
    #[serde(other)]
    Unknown,
}

/// Decision rule for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DecisionRule {
    InYourName,
    HardToUndo,
    OnlyYouKnow,
    InsideGuardrails,
    OverWeeklyCap,
    #[serde(other)]
    Unknown,
}

/// Theme for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    /// Stable identifier for this record.
    pub id: ThemeId,
    /// Name shown to the reader.
    pub name: String,
    /// Strength for this record.
    #[schemars(range(min = 0, max = 100))]
    pub strength: i64,
    /// Glass for this record.
    #[schemars(range(min = 0, max = 100))]
    #[schemars(schema_with = "crate::input::percent_schema")]
    pub glass: Present<i64>,
    /// Effective glass for this record.
    pub effective_glass: i64,
}

/// Layout for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    /// Sidebar width for this record.
    #[schemars(range(min = 224, max = 380))]
    pub sidebar_width: i64,
    /// Chat width for this record.
    #[schemars(range(min = 320, max = 640))]
    pub chat_width: i64,
}

/// Module card for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModuleCard {
    /// Stable identifier for this record.
    pub id: String,
    /// Name shown to the reader.
    pub name: String,
    /// Summary for this record.
    pub summary: String,
    /// Here for this record.
    pub here: bool,
}

/// Decision right for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecisionRight {
    /// Person explicitly granted this decision right. Topic work access by itself does not grant it.
    pub person_id: Present<crate::PersonId>,
    /// Rule for this record.
    pub rule: DecisionRule,
    /// Title displayed above the record.
    pub title: String,
    /// Explanation shown alongside the summary.
    pub detail: String,
    /// Who for this record.
    pub who: Decider,
    /// Daily limit for this record.
    pub daily_limit: Present<DailyLimit>,
    /// Risky for this record.
    pub risky: bool,
}

/// Editable cockpit preferences and decision rights.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    /// Briefs per day for this record.
    #[schemars(range(min = 1, max = 3))]
    pub briefs_per_day: i64,
    /// Interrupt only urgent for this record.
    pub interrupt_only_urgent: bool,
    /// Decision rights for this record.
    pub decision_rights: Vec<DecisionRight>,
    /// Theme for this record.
    pub theme: Theme,
    /// Chat mode for this record.
    pub chat_mode: ChatMode,
    /// Sizes of the cockpit panes.
    pub layout: Layout,
    /// Modules for this record.
    pub modules: Vec<ModuleCard>,
}

/// Partial theme written by `prefs.set`. Every field may be omitted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct ThemePatch {
    /// Stable identifier for this record.
    pub id: Option<crate::input::Known<ThemeId>>,
    /// Strength for this record.
    #[schemars(range(min = 0, max = 100))]
    #[serde(deserialize_with = "crate::input::optional_range::<_, 0, 100>")]
    pub strength: Option<i64>,
    /// Glass for this record.
    #[schemars(schema_with = "crate::input::percent_schema")]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_glass"
    )]
    /// Glass for this record.
    pub glass: Option<Present<i64>>,
}

/// Partial layout written by `prefs.set`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct LayoutPatch {
    /// Sidebar width for this record.
    #[schemars(range(min = 224, max = 380))]
    #[serde(deserialize_with = "crate::input::optional_range::<_, 224, 380>")]
    pub sidebar_width: Option<i64>,
    /// Chat width for this record.
    #[schemars(range(min = 320, max = 640))]
    #[serde(deserialize_with = "crate::input::optional_range::<_, 320, 640>")]
    pub chat_width: Option<i64>,
}

fn present_glass<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Present<i64>>, D::Error> {
    crate::input::optional_range::<D, 0, 100>(deserializer).map(|value| Some(Present(value)))
}

/// Daily allowance for a rule delegated to an agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "i64", into = "i64")]
pub struct DailyLimit(i64);

impl TryFrom<i64> for DailyLimit {
    type Error = &'static str;

    fn try_from(value: i64) -> Result<Self, Self::Error> {
        match value {
            5 | 20 | 60 => Ok(Self(value)),
            _ => Err("daily limit must be 5, 20 or 60"),
        }
    }
}

impl From<DailyLimit> for i64 {
    fn from(value: DailyLimit) -> Self {
        value.0
    }
}

impl JsonSchema for DailyLimit {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "DailyLimit".into()
    }
    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({ "description": "Daily allowance for a rule delegated to an agent.", "type": "integer", "enum": [5, 20, 60] })
    }
}
