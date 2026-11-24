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

#[test]
fn a_skill_run_without_text_leaves_the_key_out() {
    let source = json!({ "type": "skill.run", "skill": "weekly-summary" });
    let command: Command = serde_json::from_value(source).unwrap();
    let sent = serde_json::to_value(&command).unwrap();
    assert!(sent.get("text").is_none(), "{sent}");
    assert_eq!(serde_json::from_value::<Command>(sent).unwrap(), command);
    let null = json!({ "type": "skill.run", "skill": "weekly-summary", "text": null });
    assert!(serde_json::from_value::<Command>(null).is_err());
}

#[test]
fn composer_inputs_reject_text_beyond_the_contract_limits() {
    use serde_json::{from_value, json};
    let long_name = "a".repeat(201);
    let commands = [
        json!({ "type": "lane.act", "laneId": "red-main", "act": long_name }),
        json!({ "type": "prefs.set", "deviceId": long_name }),
        json!({ "type": "access.set", "topicId": "web", "personId": "timo", "access": { "kind": "stages", "stages": [long_name] } }),
        json!({ "type": "recent.visit", "target": { "kind": "topic", "id": long_name } }),
        json!({ "type": "message.send", "threadId": "topic:web", "stage": long_name, "text": "Hello" }),
        json!({ "type": "since.edit", "threadId": "topic:web", "lines": ["a".repeat(4001)] }),
        json!({ "type": "since.edit", "threadId": "topic:web", "lines": vec!["line"; 13] }),
    ];
    for command in commands {
        assert!(
            from_value::<cockpit_api::Command>(command.clone()).is_err(),
            "{command}"
        );
    }
    let local = "http://127.0.0.1:1234/api/cockpit/uploads/00000000-0000-0000-0000-000000000000";
    assert!(from_value::<cockpit_api::Attachment>(json!({"name":"plan", "url": local})).is_ok());
    assert!(
        from_value::<cockpit_api::Attachment>(
            json!({"name":"plan", "url":"http://files.example.test/plan"})
        )
        .is_err()
    );
}
