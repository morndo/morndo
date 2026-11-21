//! Write the JSON Schema compiled from the cockpit types.
//!
//! `export-schema` writes `packages/cockpit-api/schema/cockpit.schema.json`.
//! `export-schema --check` exits 1 when that file is not a fresh export.

use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use cockpit_api::{
    AccessView, ApiError, BriefView, Command, CommandResult, DecisionQueueView, DecisionView, DraftsView,
    Event, LaneView, ManagerView, PullsView, RoutePreview, SearchView, SettingsView, SidebarView,
    SkillsView, ThreadView, TopicView, UsageView, WorkspaceView,
};
use schemars::generate::SchemaSettings;
use schemars::{JsonSchema, SchemaGenerator};
use serde_json::{Map, Value};

fn main() -> ExitCode {
    let check = std::env::args().any(|arg| arg == "--check");
    let fresh = export();
    let path = schema_path();
    if check {
        let current = fs::read_to_string(&path).unwrap_or_default();
        if current != fresh {
            eprintln!("cockpit schema is out of date: {}", path.display());
            return ExitCode::from(1);
        }
        return ExitCode::SUCCESS;
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).expect("schema directory");
    }
    fs::write(&path, fresh).expect("write schema");
    ExitCode::SUCCESS
}

fn schema_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/cockpit-api/schema/cockpit.schema.json")
}

fn export() -> String {
    let settings = SchemaSettings::draft2020_12().for_deserialize();
    let mut generator = SchemaGenerator::new(settings);
    // Referencing each root type pulls it, and every type it reaches, into `$defs`.
    let _ = generator.subschema_for::<WorkspaceView>();
    let _ = generator.subschema_for::<SidebarView>();
    let _ = generator.subschema_for::<UsageView>();
    let _ = generator.subschema_for::<BriefView>();
    let _ = generator.subschema_for::<DecisionQueueView>();
    let _ = generator.subschema_for::<DecisionView>();
    let _ = generator.subschema_for::<TopicView>();
    let _ = generator.subschema_for::<LaneView>();
    let _ = generator.subschema_for::<ManagerView>();
    let _ = generator.subschema_for::<DraftsView>();
    let _ = generator.subschema_for::<SkillsView>();
    let _ = generator.subschema_for::<SettingsView>();
    let _ = generator.subschema_for::<ThreadView>();
    let _ = generator.subschema_for::<SearchView>();
    let _ = generator.subschema_for::<RoutePreview>();
    let _ = generator.subschema_for::<PullsView>();
    let _ = generator.subschema_for::<AccessView>();
    let _ = generator.subschema_for::<Command>();
    let _ = generator.subschema_for::<CommandResult>();
    let _ = generator.subschema_for::<Event>();
    let _ = generator.subschema_for::<ApiError>();

    let defs = serde_json::to_value(generator.take_definitions(true)).expect("schema definitions");
    let mut root = Map::new();
    root.insert(
        "$schema".to_string(),
        Value::String("https://json-schema.org/draft/2020-12/schema".to_string()),
    );
    root.insert("$defs".to_string(), defs);
    let mut value = Value::Object(root);
    sort_keys(&mut value);
    let mut out = serde_json::to_string_pretty(&value).expect("pretty schema");
    out.push('\n');
    out
}

fn sort_keys(value: &mut Value) {
    match value {
        Value::Array(items) => {
            for item in items {
                sort_keys(item);
            }
        }
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = std::mem::take(map).into_iter().collect();
            for (_, child) in &mut entries {
                sort_keys(child);
            }
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            *map = entries.into_iter().collect();
        }
        _ => {}
    }
}

// Keep the JsonSchema import live for readers of this binary; the calls above use it.
#[allow(dead_code)]
fn _schema_bound<T: JsonSchema>() {}
