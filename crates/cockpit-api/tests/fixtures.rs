//! Every committed fixture deserializes into the view it is named for and serializes back
//! to the same JSON.

use std::fs;
use std::path::{Path, PathBuf};

use cockpit_api::{
    AccessView, BriefView, DecisionQueueView, DecisionView, DraftsView, LaneView, ManagerView,
    PullsView, SettingsView, SidebarView, SkillsView, ThreadView, TopicView, UsageView,
    WorkspaceView,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

#[test]
fn fixtures_round_trip() {
    let root =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/cockpit-api/fixtures");
    let mut files = Vec::new();
    collect(&root, &mut files);
    assert!(!files.is_empty(), "no fixtures under {}", root.display());
    let mut failed = Vec::new();
    for path in files {
        let rel = path
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let text = fs::read_to_string(&path).unwrap();
        let result = match kind(&rel) {
            Some("WorkspaceView") => round_trip::<WorkspaceView>(&text),
            Some("SidebarView") => round_trip::<SidebarView>(&text),
            Some("UsageView") => round_trip::<UsageView>(&text),
            Some("ModelsView") => round_trip::<cockpit_api::ModelsView>(&text),
            Some("BriefView") => round_trip::<BriefView>(&text),
            Some("DecisionQueueView") => round_trip::<DecisionQueueView>(&text),
            Some("DecisionView") => round_trip::<DecisionView>(&text),
            Some("TopicView") => round_trip::<TopicView>(&text),
            Some("LaneView") => round_trip::<LaneView>(&text),
            Some("ManagerView") => round_trip::<ManagerView>(&text),
            Some("DraftsView") => round_trip::<DraftsView>(&text),
            Some("SkillsView") => round_trip::<SkillsView>(&text),
            Some("SettingsView") => round_trip::<SettingsView>(&text),
            Some("PullsView") => round_trip::<PullsView>(&text),
            Some("AccessView") => round_trip::<AccessView>(&text),
            Some("ThreadView") => round_trip::<ThreadView>(&text),
            Some(other) => Err(format!("unmapped kind {other}")),
            None => Err("no view mapping".to_string()),
        };
        if let Err(reason) = result {
            failed.push(format!("{rel}: {reason}"));
        }
    }
    assert!(
        failed.is_empty(),
        "fixture round-trip failed:\n{}",
        failed.join("\n")
    );
}

fn kind(rel: &str) -> Option<&'static str> {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let parent = rel.rsplit('/').nth(1);
    if name.ends_with(".access.json") {
        return Some("AccessView");
    }
    Some(match name {
        "workspace.json" => "WorkspaceView",
        "sidebar.json" => "SidebarView",
        "usage.json" => "UsageView",
        "models.json" => "ModelsView",
        "brief.json" => "BriefView",
        "decisions.json" => "DecisionQueueView",
        "manager.json" if parent != Some("threads") => "ManagerView",
        "drafts.json" => "DraftsView",
        "skills.json" => "SkillsView",
        "settings.json" => "SettingsView",
        "pulls.json" => "PullsView",
        _ if parent == Some("decisions") => "DecisionView",
        _ if parent == Some("topics") => "TopicView",
        _ if parent == Some("lanes") => "LaneView",
        _ if parent == Some("threads") => "ThreadView",
        _ => return None,
    })
}

fn round_trip<T: DeserializeOwned + Serialize>(text: &str) -> Result<(), String> {
    let original: Value = serde_json::from_str(text).map_err(|err| err.to_string())?;
    let typed: T = serde_json::from_value(original.clone()).map_err(|err| err.to_string())?;
    let back = serde_json::to_value(&typed).map_err(|err| err.to_string())?;
    if let Some(diff) = first_diff(&original, &back, "$") {
        return Err(diff);
    }
    Ok(())
}

fn first_diff(left: &Value, right: &Value, path: &str) -> Option<String> {
    match (left, right) {
        (Value::Object(a), Value::Object(b)) => {
            let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
            keys.sort();
            keys.dedup();
            for key in keys {
                let next = format!("{path}.{key}");
                match (a.get(key), b.get(key)) {
                    (None, Some(value)) => {
                        return Some(format!("{next} missing in fixture, typed has {value}"));
                    }
                    (Some(value), None) => {
                        return Some(format!(
                            "{next} missing after round-trip, fixture has {value}"
                        ));
                    }
                    (Some(av), Some(bv)) => {
                        if let Some(diff) = first_diff(av, bv, &next) {
                            return Some(diff);
                        }
                    }
                    (None, None) => {}
                }
            }
            None
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                return Some(format!("{path} length {} != {}", a.len(), b.len()));
            }
            for (index, (av, bv)) in a.iter().zip(b).enumerate() {
                if let Some(diff) = first_diff(av, bv, &format!("{path}[{index}]")) {
                    return Some(diff);
                }
            }
            None
        }
        (Value::Number(left), Value::Number(right)) if same_number(left, right) => None,
        _ if left != right => Some(format!("{path}: {left} != {right}")),
        _ => None,
    }
}

fn same_number(left: &serde_json::Number, right: &serde_json::Number) -> bool {
    match (left.as_f64(), right.as_f64()) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = fs::read_dir(dir).unwrap_or_else(|err| panic!("read {}: {err}", dir.display()));
    for entry in entries {
        let entry = entry.expect("fixture entry");
        let path = entry.path();
        if path.is_dir() {
            collect(&path, out);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
            out.push(path);
        }
    }
}
