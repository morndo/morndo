use std::{fs, path::PathBuf};

use cockpit_api::{Command, Event, FeedEvent, ModuleId, WorkspaceView};
use serde_json::{Value, json};

#[test]
fn shared_examples() {
    let root =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/cockpit-api/examples");
    for category in ["commands", "events"] {
        for (dir, valid) in [("valid", true), ("invalid", false)] {
            let examples: Vec<_> = fs::read_dir(root.join(category).join(dir))
                .unwrap()
                .collect();
            assert!(!examples.is_empty());
            for entry in examples {
                let path = entry.unwrap().path();
                let source = fs::read_to_string(&path).unwrap();
                let accepts = if category == "commands" {
                    serde_json::from_str::<Command>(&source).is_ok()
                } else {
                    serde_json::from_str::<Event>(&source).is_ok()
                };
                assert_eq!(accepts, valid, "{}", path.display());
            }
        }
    }
}

#[test]
fn installed_readers_tolerate_new_fields_and_tags() {
    let mut workspace: Value = serde_json::from_str(include_str!(
        "../../../packages/cockpit-api/fixtures/gtm/workspace.json"
    ))
    .unwrap();
    workspace["otherField"] = json!("new data");
    workspace["module"]["id"] = json!("future");
    workspace["me"]["newBadge"] = json!(true);
    let read: WorkspaceView = serde_json::from_value(workspace).unwrap();
    assert_eq!(read.module.id, ModuleId::Unknown);
    let feed: FeedEvent = serde_json::from_value(json!({
        "seq": 4, "at": "2026-11-16T08:45:00+01:00", "type": "future.updated",
        "futureField": "new data"
    }))
    .unwrap();
    assert_eq!(feed.event, Event::Unknown);
}
