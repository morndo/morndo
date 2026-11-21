use crate::{Target, Timestamp};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Recent pages for the current reader, newest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecentView {
    /// Last six distinct pages.
    #[schemars(length(max = 6))]
    pub items: Vec<RecentPage>,
}

/// A page the reader opened recently.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecentPage {
    /// Navigation destination.
    pub target: Target,
    /// Display label for the page.
    pub title: String,
    /// Time the reader opened it.
    pub at: Timestamp,
}

/// Binary data and display name supplied by the composer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadInput {
    /// File name to show on the attachment.
    #[schemars(length(min = 1, max = 200))]
    #[serde(deserialize_with = "crate::input::name")]
    pub name: String,
    /// Base64 file bytes, capped at 512 KiB decoded.
    #[schemars(
        length(min = 4, max = 699052),
        regex(pattern = "^[A-Za-z0-9+/]+={0,2}$")
    )]
    pub data: String,
}
