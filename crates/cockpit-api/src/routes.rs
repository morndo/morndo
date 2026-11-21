//! HTTP operations shared by the schema exporter and stand-in.
use serde_json::{Value, json};

/// Description of one cockpit HTTP operation.
pub struct Route {
    /// HTTP method.
    pub method: &'static str,
    /// Path relative to the cockpit API prefix.
    pub path: &'static str,
    /// Definition for the successful response.
    pub response: &'static str,
    /// Error statuses the operation may return.
    pub errors: &'static [u16],
    /// Path, query, and header parameters.
    pub parameters: fn() -> Vec<Value>,
}

/// Common prefix for every cockpit operation.
pub const BASE: &str = "/api/cockpit";
const READ: &[u16] = &[400, 403, 404, 405, 500];
const WRITE: &[u16] = &[400, 403, 404, 405, 409, 413, 415, 500];

fn parameter(name: &str, location: &str, schema: Value) -> Value {
    json!({"name": name, "in": location, "required": location == "path", "schema": schema})
}

fn query(name: &str, schema: Value) -> Value {
    parameter(name, "query", schema)
}

fn reference(name: &str) -> Value {
    json!({"$ref": format!("#/components/schemas/{name}")})
}

fn id(kind: &str) -> Value {
    parameter("id", "path", reference(kind))
}

fn page() -> Vec<Value> {
    vec![
        query(
            "limit",
            json!({"type": "integer", "minimum": 1, "maximum": 100}),
        ),
        query("cursor", json!({"type": "string", "maxLength": 400})),
    ]
}

macro_rules! read {
    ($path:literal, $response:ident $(, $parameters:expr)*) => {
        Route { method: "get", path: $path, response: stringify!($response), errors: READ, parameters: || vec![$($parameters),*] }
    }
}

/// Public routes and their wire representations.
pub const ROUTES: &[Route] = &[
    read!("/workspace", WorkspaceView),
    read!("/sidebar", SidebarView),
    read!("/usage", UsageView),
    read!("/brief", BriefView),
    read!(
        "/brief/artwork",
        Artwork,
        query("index", json!({"type": "integer", "minimum": 1}))
    ),
    read!(
        "/brief/artwork/{index}/{variant}",
        Artwork,
        parameter("index", "path", json!({"type": "integer", "minimum": 1})),
        parameter(
            "variant",
            "path",
            json!({"type": "string", "enum": ["image", "glass"]})
        )
    ),
    read!("/topics/{id}/status", TopicStatusView, id("TopicId")),
    read!("/decisions", DecisionQueueView),
    read!("/decisions/{id}", DecisionView, id("DecisionId")),
    read!("/topics/{id}", TopicView, id("TopicId")),
    read!("/topics/{id}/access", AccessView, id("TopicId")),
    Route {
        parameters: || [vec![id("TopicId")], page()].concat(),
        ..read!("/topics/{id}/history", HistoryPage)
    },
    read!("/lanes/{id}", LaneView, id("LaneId")),
    read!("/manager", ManagerView),
    read!("/drafts", DraftsView),
    read!("/skills", SkillsView),
    read!("/settings", SettingsView),
    read!("/pulls", PullsView),
    Route {
        parameters: || {
            [
                vec![parameter("threadId", "path", reference("ThreadId"))],
                page(),
            ]
            .concat()
        },
        ..read!("/threads/{threadId}", ThreadView)
    },
    Route {
        parameters: || {
            [
                vec![
                    query("q", json!({"type": "string", "maxLength": 4000})),
                    query("scope", reference("TopicId")),
                ],
                page(),
            ]
            .concat()
        },
        ..read!("/search", SearchView)
    },
    read!(
        "/route-preview",
        RoutePreview,
        query("text", json!({"type": "string", "maxLength": 4000})),
        query("topic", reference("TopicId"))
    ),
    read!("/models", ModelsView),
    Route {
        method: "post",
        path: "/actions",
        response: "CommandResult",
        errors: WRITE,
        parameters: || {
            vec![parameter(
                "Idempotency-Key",
                "header",
                json!({"type": "string", "maxLength": 200}),
            )]
        },
    },
    read!(
        "/feed",
        FeedEvent,
        query(
            "after",
            json!({"type": "integer", "minimum": 0, "maximum": 9007199254740991_u64})
        )
    ),
];

/// Produce OpenAPI operations from the route table.
pub fn openapi_paths() -> Value {
    let mut paths = json!({});
    for route in ROUTES {
        let mut parameters = (route.parameters)();
        parameters.push(query("as", reference("PersonId")));
        let feed = route.path == "/feed";
        let mut responses = json!({});
        if feed {
            responses["101"] = json!({
                "description": "Upgraded to a WebSocket carrying sequenced cockpit events.",
                "headers": response_headers(false)
            });
        } else if route.path == "/brief/artwork/{index}/{variant}" {
            responses["200"] = json!({
                "description": "Brief artwork image",
                "content": {"image/webp": {}},
                "headers": response_headers(false)
            });
        } else {
            responses["200"] = json!({
                "description": "Successful cockpit response",
                "content": {"application/json": {"schema": reference(route.response)}},
                "headers": response_headers(false)
            });
        }
        for status in route.errors {
            responses[status.to_string()] = json!({
                "description": "Request failed",
                "content": {"application/problem+json": {"schema": reference("ApiError")}},
                "headers": response_headers(*status == 405)
            });
        }
        let mut operation = json!({"parameters": parameters, "responses": responses});
        if feed {
            operation["x-websocket-message"] = reference(route.response);
        }
        if route.method == "post" {
            operation["requestBody"] = json!({
                "required": true,
                "content": {"application/json": {"schema": reference("Command")}}
            });
        }
        paths[format!("{BASE}{}", route.path)] = json!({ route.method: operation });
    }
    paths
}

fn response_headers(allow: bool) -> Value {
    let mut headers = json!({
        "cockpit-contract": {
            "required": true,
            "schema": {"type": "string", "const": crate::CONTRACT_VERSION}
        }
    });
    if allow {
        headers["Allow"] = json!({"required": true, "schema": {"type": "string"}});
    }
    headers
}
