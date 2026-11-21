use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::present::Present;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SearchKind {
    Topic,
    Lane,
    Person,
    Decision,
    Skill,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchResult {
    pub kind: SearchKind,
    pub id: String,
    pub title: String,
    pub sub: Present<String>,
    pub href: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Answer {
    pub text: String,
    pub source: String,
    pub href: Present<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchView {
    pub query: String,
    pub scope: Present<String>,
    pub results: Vec<SearchResult>,
    pub answer: Present<Answer>,
}
