//! A value that is always present in JSON: `null` when absent, and required in the schema.
//!
//! View responses use this so every client sees every field. Command inputs that may be omitted
//! stay plain `Option`s with `#[serde(default)]`.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Present<T>(pub Option<T>);

impl<T> Present<T> {
    pub fn some(value: T) -> Self {
        Self(Some(value))
    }

    pub fn none() -> Self {
        Self(None)
    }
}

impl<T> From<Option<T>> for Present<T> {
    fn from(value: Option<T>) -> Self {
        Self(value)
    }
}

impl<T: JsonSchema> JsonSchema for Present<T> {
    fn schema_name() -> Cow<'static, str> {
        Cow::Owned(format!("Nullable_{}", T::schema_name()))
    }

    fn schema_id() -> Cow<'static, str> {
        Cow::Owned(format!("Present<{}>", T::schema_id()))
    }

    fn inline_schema() -> bool {
        true
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let inner = generator.subschema_for::<T>().to_value();
        serde_json::json!({ "anyOf": [inner, { "type": "null" }] })
            .try_into()
            .expect("a nullable schema is an object")
    }
}
