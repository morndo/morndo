use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::Present;

/// Current version of the cockpit wire contract.
pub const CONTRACT_VERSION: &str = "1.1.0";
/// Schema identifier for this major version.
pub const CONTRACT_ID: &str = "urn:morndo:cockpit-api:1";

macro_rules! id {
    ($name:ident, $doc:literal, $pattern:literal) => {
        #[doc = $doc]
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(#[doc = $doc] pub String);

        impl JsonSchema for $name {
            fn schema_name() -> std::borrow::Cow<'static, str> { stringify!($name).into() }
            fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
                schemars::json_schema!({ "type": "string", "pattern": $pattern, "description": $doc })
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                Self::try_from(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
            }
        }

        impl TryFrom<String> for $name {
            type Error = &'static str;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                if id_pattern_matches($pattern, &value) {
                    Ok(Self(value))
                } else {
                    Err(concat!("invalid ", stringify!($name)))
                }
            }
        }
    };
}

fn slug(value: &str) -> bool {
    let mut chars = value.bytes();
    let alphanumeric = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    chars.next().is_some_and(alphanumeric)
        && chars.all(|byte| alphanumeric(byte) || byte == b'-')
        && value.len() <= 200
}

fn id_pattern_matches(pattern: &str, value: &str) -> bool {
    match pattern {
        MESSAGE_PATTERN => value.strip_prefix('m').is_some_and(|digits| {
            !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
        }),
        THREAD_PATTERN => parse_thread_id(value).is_some(),
        _ => slug(value),
    }
}

const MESSAGE_PATTERN: &str = "^m[0-9]+$";
const THREAD_PATTERN: &str =
    "^(?:manager|general|(?:topic|lane|decision):[a-z0-9][a-z0-9-]{0,199})$";
macro_rules! slug_ids {
    ($($name:ident => $doc:literal),+ $(,)?) => {
        $(id!($name, $doc, "^[a-z0-9][a-z0-9-]{0,199}$");)+
    };
}

slug_ids! {
    TopicId => "Identifier of a topic or project.",
    LaneId => "Identifier of a lane.",
    DecisionId => "Identifier of a decision.",
    PersonId => "Identifier of an actor, whether a person or an agent.",
    PinId => "Identifier of a sidebar pin.",
    ActionId => "Identifier of an action recorded in history.",
    SkillId => "Identifier of a runnable skill.",
    DraftId => "Identifier of a draft.",
    PullId => "Identifier of a pull request.",
    ConnectionId => "Identifier of a service connection.",
    InvitationId => "Identifier of a sharing invitation.",
    ModelId => "Identifier of a selectable model.",
    RecordId => "Identifier of a staging run or review record.",
    ScheduleId => "Identifier of a recurring schedule.",
    ReportId => "Identifier of a status report.",
    CheckId => "Identifier of a spot check.",
}
id!(MessageId, "Identifier of a message.", "^m[0-9]+$");
id!(
    ThreadId,
    "Identifier of a conversation.",
    "^(?:manager|general|(?:topic|lane|decision):[a-z0-9][a-z0-9-]{0,199})$"
);

/// Scope of a parsed thread identifier.
pub enum ThreadScope<'a> {
    /// Workspace-wide Manager chat.
    Manager,
    /// Workspace-wide general chat.
    General,
    /// Topic or project chat.
    Topic(&'a str),
    /// Lane chat.
    Lane(&'a str),
    /// Decision chat.
    Decision(&'a str),
}

/// Parse a cockpit thread identifier and return its scope.
pub fn parse_thread_id(value: &str) -> Option<ThreadScope<'_>> {
    match value {
        "manager" => Some(ThreadScope::Manager),
        "general" => Some(ThreadScope::General),
        _ => {
            let (kind, id) = value.split_once(':')?;
            if !slug(id) {
                return None;
            }
            match kind {
                "topic" => Some(ThreadScope::Topic(id)),
                "lane" => Some(ThreadScope::Lane(id)),
                "decision" => Some(ThreadScope::Decision(id)),
                _ => None,
            }
        }
    }
}

/// A point in time with an RFC 3339 UTC offset.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct Timestamp(#[schemars(extend("format" = "date-time"))] pub String);

/// A currency amount in the currency's minor units.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Money {
    /// Amount in cents for currencies with two fractional digits.
    pub amount_minor: i64,
    /// ISO 4217 alphabetic currency code.
    #[schemars(regex(pattern = "^[A-Z]{3}$"))]
    pub currency: String,
}

/// Destination category for navigation within the cockpit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum TargetKind {
    Topic,
    Lane,
    Decision,
    Thread,
    Person,
    Draft,
    Skill,
    Pull,
    Run,
    Review,
    File,
    Report,
    Check,
    Manager,
    Brief,
    Drafts,
    Skills,
    Settings,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// An internal link resolved by the client.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// Surface or record type to open.
    pub kind: TargetKind,
    /// Destination record identifier, or null for a top-level surface.
    pub id: Present<String>,
}
