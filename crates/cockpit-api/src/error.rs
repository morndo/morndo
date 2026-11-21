use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Stable application code for a failed request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("$comment" = "cockpit-reader:enum"))]
pub enum ErrorCode {
    BadRequest,
    NotFound,
    Forbidden,
    Conflict,
    LimitReached,
    SkillDisabled,
    UnsupportedMediaType,
    PayloadTooLarge,
    MethodNotAllowed,
    Internal,
    IdempotencyKeyReused,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// A specific field that failed request validation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FieldError {
    /// JSON Pointer to the field.
    pub path: String,
    /// Explanation of the validation failure.
    pub message: String,
}

/// An RFC 9457 problem details response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ApiError {
    /// URI identifying the problem type.
    #[serde(rename = "type")]
    #[schemars(extend("format" = "uri"))]
    pub problem_type: String,
    /// Short description of the problem type.
    pub title: String,
    /// HTTP response status.
    pub status: u16,
    /// Explanation specific to this request.
    pub detail: String,
    /// Stable application code.
    pub code: ErrorCode,
    /// Field-level validation failures, if any.
    pub errors: Vec<FieldError>,
}
