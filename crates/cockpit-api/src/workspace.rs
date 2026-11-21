use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::actor::Actor;
use crate::settings::{ChatMode, Layout, Theme};

/// Available cockpit modules.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ModuleId {
    Gtm,
    Dev,
    #[serde(other)]
    Unknown,
}

/// Identity and appearance of the workspace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    /// Stable identifier for this record.
    pub id: String,
    /// Name shown to the reader.
    pub name: String,
    /// Theme for this record.
    pub theme: Theme,
}

/// The active cockpit module.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModuleInfo {
    /// Stable identifier for this record.
    pub id: ModuleId,
    /// Name shown to the reader.
    pub name: String,
    /// Icon for this record.
    pub icon: String,
    /// Kind word for this record.
    pub kind_word: String,
}

/// Workspace identity, reader and presentation settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceView {
    /// Modules available in the workspace.
    pub modules: Vec<crate::ModuleCard>,
    /// Version of the contract served by the hub.
    pub contract_version: String,
    /// IANA time zone used by the workspace.
    pub timezone: String,
    /// Workspace for this record.
    pub workspace: WorkspaceInfo,
    /// Module for this record.
    pub module: ModuleInfo,
    /// Me for this record.
    pub me: Actor,
    /// Sizes of the cockpit panes.
    pub layout: Layout,
    /// Chat mode for this record.
    pub chat_mode: ChatMode,
}
