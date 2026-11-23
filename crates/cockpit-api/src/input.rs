//! Deserializers for bounded and closed command inputs.
use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize, de};

/// An enum input restricted to the values supported by this contract version.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Known<T>(pub T);

impl<'de, T: Deserialize<'de> + Serialize> Deserialize<'de> for Known<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = T::deserialize(deserializer)?;
        if serde_json::to_value(&value).map_err(de::Error::custom)? == "unknown" {
            return Err(de::Error::custom("unsupported value"));
        }
        Ok(Self(value))
    }
}

impl<T: JsonSchema> JsonSchema for Known<T> {
    fn schema_name() -> Cow<'static, str> {
        format!("Known{}", T::schema_name()).into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut schema = T::json_schema(generator).to_value();
        if let Some(values) = schema
            .get_mut("enum")
            .and_then(serde_json::Value::as_array_mut)
        {
            values.retain(|value| value != "unknown");
        }
        schema.try_into().expect("enum schema")
    }
}

pub(crate) fn text<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    bounded_text::<D, 4000>(deserializer)
}

pub(crate) fn optional_text<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    let value = Option::<String>::deserialize(deserializer)?;
    if value
        .as_ref()
        .is_some_and(|text| text.is_empty() || text.chars().count() > 4000)
    {
        return Err(de::Error::custom("expected 1 to 4000 characters"));
    }
    Ok(value)
}

pub(crate) fn name<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    bounded_text::<D, 200>(deserializer)
}

pub(crate) fn optional_name<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    let value = Option::<String>::deserialize(deserializer)?;
    if value
        .as_ref()
        .is_some_and(|name| name.is_empty() || name.chars().count() > 200)
    {
        return Err(de::Error::custom("expected 1 to 200 characters"));
    }
    Ok(value)
}

pub(crate) fn target_id<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<crate::Present<String>, D::Error> {
    optional_name(deserializer).map(Into::into)
}

pub(crate) fn stage_names<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<String>, D::Error> {
    let names = Vec::<String>::deserialize(deserializer)?;
    if names
        .iter()
        .any(|name| name.is_empty() || name.chars().count() > 200)
    {
        return Err(de::Error::custom(
            "stage names must have 1 to 200 characters",
        ));
    }
    Ok(names)
}

pub(crate) fn since_lines<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<String>, D::Error> {
    let lines = Vec::<String>::deserialize(deserializer)?;
    if lines.len() > 12 || lines.iter().any(|line| line.chars().count() > 4000) {
        return Err(de::Error::custom(
            "expected up to 12 lines of 4000 characters each",
        ));
    }
    Ok(lines)
}

fn bounded_text<'de, D: Deserializer<'de>, const MAX: usize>(
    deserializer: D,
) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.is_empty() || value.chars().count() > MAX {
        return Err(de::Error::custom(format!("expected 1 to {MAX} characters")));
    }
    Ok(value)
}

pub(crate) fn optional_range<'de, D: Deserializer<'de>, const MIN: i64, const MAX: i64>(
    deserializer: D,
) -> Result<Option<i64>, D::Error> {
    let value = Option::<i64>::deserialize(deserializer)?;
    if value.is_some_and(|n| !(MIN..=MAX).contains(&n)) {
        return Err(de::Error::custom(format!("expected {MIN} to {MAX}")));
    }
    Ok(value)
}

pub(crate) fn percent_schema(_: &mut SchemaGenerator) -> Schema {
    schemars::json_schema!({ "anyOf": [
        { "type": "integer", "minimum": 0, "maximum": 100 },
        { "type": "null" }
    ] })
}

pub(crate) fn attachment_url<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    let authority = value
        .strip_prefix("https://")
        .unwrap_or("")
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    let local_upload = value
        .strip_prefix("http://127.0.0.1:")
        .and_then(|url| url.split_once("/api/cockpit/uploads/"))
        .is_some_and(|(port, id)| {
            !port.starts_with('0')
                && port.bytes().all(|byte| byte.is_ascii_digit())
                && port.parse::<u16>().is_ok_and(|port| port > 0)
                && id.split('-').map(str::len).eq([8, 4, 4, 4, 12])
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        });
    if (authority.is_empty() && !local_upload)
        || value.chars().count() > 2048
        || value
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
    {
        return Err(de::Error::custom(
            "expected an HTTPS attachment URL or a loopback upload URL of at most 2048 characters",
        ));
    }
    Ok(value)
}

pub(crate) fn target_id_schema(_: &mut SchemaGenerator) -> Schema {
    schemars::json_schema!({ "anyOf": [
        { "type": "string", "minLength": 1, "maxLength": 200 },
        { "type": "null" }
    ] })
}

pub(crate) fn text_schema(_: &mut SchemaGenerator) -> Schema {
    schemars::json_schema!({ "type": "string", "minLength": 1, "maxLength": 4000 })
}

pub(crate) fn stage_names_schema(_: &mut SchemaGenerator) -> Schema {
    schemars::json_schema!({
        "type": "array", "items": { "type": "string", "minLength": 1, "maxLength": 200 }
    })
}

pub(crate) fn since_lines_schema(_: &mut SchemaGenerator) -> Schema {
    schemars::json_schema!({
        "type": "array", "maxItems": 12, "items": { "type": "string", "maxLength": 4000 }
    })
}

pub(crate) fn attachment_schema(_: &mut SchemaGenerator) -> Schema {
    schemars::json_schema!({
        "type": "string", "format": "uri", "maxLength": 2048,
        "pattern": "^https://|^http://127[.]0[.]0[.]1:(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])/api/cockpit/uploads/[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$"
    })
}
