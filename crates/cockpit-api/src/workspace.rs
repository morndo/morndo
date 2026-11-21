use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::actor::Actor;
use crate::settings::{ChatMode, Layout, Theme};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ModuleId {
    Gtm,
    Dev,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    pub theme: Theme,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleInfo {
    pub id: ModuleId,
    pub name: String,
    pub icon: String,
    pub kind_word: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceView {
    pub workspace: WorkspaceInfo,
    pub module: ModuleInfo,
    pub me: Actor,
    pub layout: Layout,
    pub chat_mode: ChatMode,
}
