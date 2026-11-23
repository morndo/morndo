//! Export JSON Schema and OpenAPI from the Rust cockpit contract.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use cockpit_api::*;
use schemars::SchemaGenerator;
use schemars::generate::SchemaSettings;
use serde_json::{Value, json};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/cockpit-api/schema");
    let schema = export();
    let openapi = json!({
        "openapi": "3.1.1",
        "info": {"title": "Morndo cockpit API", "version": CONTRACT_VERSION},
        "paths": routes::openapi_paths(),
        "components": {"schemas": openapi_refs(schema["$defs"].clone())}
    });
    match args.as_slice() {
        [] => {
            fs::create_dir_all(&dir)?;
            fs::write(dir.join("cockpit.schema.json"), pretty(&schema))?;
            fs::write(dir.join("cockpit.openapi.json"), pretty(&openapi))?;
        }
        [arg] if arg == "--check" => {
            check(&dir.join("cockpit.schema.json"), &schema)?;
            check(&dir.join("cockpit.openapi.json"), &openapi)?;
        }
        [arg] if arg == "--release" => {
            check(&dir.join("cockpit.schema.json"), &schema)?;
            check(&dir.join("cockpit.openapi.json"), &openapi)?;
            let major = CONTRACT_VERSION.split('.').next().expect("contract major");
            let released = dir.join("released");
            fs::create_dir_all(&released)?;
            let path = released.join(format!("{major}.json"));
            let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
            file.write_all(pretty(&schema).as_bytes())?;
            let path = released.join(format!("{major}.openapi.json"));
            let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
            file.write_all(pretty(&openapi).as_bytes())?;
        }
        _ => return Err("usage: export-schema [--check | --release]".into()),
    }
    Ok(())
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).expect("JSON document") + "\n"
}

fn check(path: &Path, value: &Value) -> io::Result<()> {
    if fs::read_to_string(path)? == pretty(value) {
        return Ok(());
    }
    Err(io::Error::other(format!(
        "cockpit contract is out of date: {}",
        path.display()
    )))
}

fn export() -> Value {
    let mut generator = SchemaGenerator::new(SchemaSettings::draft2020_12().for_deserialize());
    macro_rules! roots {
        ($($type:ty),+ $(,)?) => { $(let _ = generator.subschema_for::<$type>();)+ };
    }
    roots!(
        WorkspaceView,
        SidebarView,
        UsageView,
        BriefView,
        DecisionQueueView,
        DecisionView,
        TopicView,
        LaneView,
        ManagerView,
        DraftsView,
        SkillsView,
        SettingsView,
        ThreadView,
        SearchView,
        RoutePreview,
        PullsView,
        AccessView,
        HistoryPage,
        ModelsView,
        Command,
        CommandResult,
        Event,
        FeedEvent,
        cockpit_api::event::FeedFrame,
        cockpit_api::extras::RecentView,
        cockpit_api::extras::MadeRecordView,
        cockpit_api::extras::UploadInput,
        cockpit_api::access::TopicStatusView,
        ReportView,
        CheckView,
        MembersView,
        Report,
        SpotCheck,
        ApiError,
    );
    let defs = generator.take_definitions(true);
    for route in routes::ROUTES {
        assert!(
            defs.contains_key(route.response),
            "missing route definition: {}",
            route.response
        );
    }
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": CONTRACT_ID,
        "x-contract-version": CONTRACT_VERSION,
        "$defs": defs
    })
}

fn openapi_refs(mut value: Value) -> Value {
    fn rewrite(value: &mut Value) {
        match value {
            Value::Object(map) => {
                if let Some(Value::String(reference)) = map.get_mut("$ref") {
                    *reference = reference.replacen("#/$defs/", "#/components/schemas/", 1);
                }
                map.values_mut().for_each(rewrite);
            }
            Value::Array(items) => items.iter_mut().for_each(rewrite),
            _ => {}
        }
    }
    rewrite(&mut value);
    value
}
