use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{LaneId, PinId, Target, TopicId};

use crate::lane::LaneState;
use crate::present::Present;

/// Group kind for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum GroupKind {
    Topic,
    Project,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Pin kind for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum PinKind {
    Page,
    Topic,
    Project,
    Skill,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Sidebar lane for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SidebarLane {
    /// Fresh for this record.
    pub fresh: bool,
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
}

/// Sidebar group for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SidebarGroup {
    /// Stable identifier for this record.
    pub id: TopicId,
    /// Name shown to the reader.
    pub name: String,
    /// Kind for this record.
    pub kind: GroupKind,
    /// Icon for this record.
    pub icon: String,
    /// State word for this record.
    pub state_word: String,
    /// Mark for this record.
    pub mark: Present<String>,
    /// Open for this record.
    pub open: bool,
    /// Lanes for this record.
    pub lanes: Vec<SidebarLane>,
}

/// Pin for the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Pin {
    /// Current open decision count for the Decide pin.
    pub badge_count: Present<u64>,
    /// Stable identifier for this record.
    pub id: PinId,
    /// Kind for this record.
    pub kind: PinKind,
    /// Label for this record.
    pub label: String,
    /// Name shown to the reader.
    pub name: Present<String>,
    /// Note for this record.
    pub note: Present<String>,
    /// Icon for this record.
    pub icon: String,
    /// Destination to open in the cockpit.
    pub target: Present<Target>,
    /// Run for this record.
    pub run: Present<String>,
    /// Badge for this record.
    pub badge: bool,
    /// Pinned for this record.
    pub pinned: bool,
}

/// Navigation, open lanes and ordered pins.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SidebarView {
    /// Pin limit for this record.
    pub pin_limit: i64,
    /// Kind word for this record.
    pub kind_word: String,
    /// Groups for this record.
    pub groups: Vec<SidebarGroup>,
    /// Manager lanes for this record.
    pub manager_lanes: Vec<SidebarLane>,
    /// Pins for this record.
    #[schemars(length(max = 12))]
    pub pins: Vec<Pin>,
    /// Pinnable for this record.
    pub pinnable: Vec<Pin>,
}
