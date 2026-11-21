use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{ModelId, Present};

/// Availability of an engine in the model picker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum ModelState {
    /// Selected automatically by the hub.
    Default,
    /// Available for work.
    Connected,
    SignedIn,
    /// Requires a connection.
    AddKey,
    /// Requires sign-in.
    SignIn,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Model offered by the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Model {
    /// Identifier passed with a command.
    pub id: ModelId,
    /// Display name.
    pub name: String,
    /// Engine vendor.
    pub vendor: Present<String>,
    /// Current availability.
    pub state: Present<ModelState>,
}

/// Choices available for a new request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ModelsView {
    /// Selectable models in picker order.
    pub items: Vec<Model>,
}
