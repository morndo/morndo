//! The cockpit API: the views, commands and events the screens share.
//!
//! JSON is camelCase. A field that is sometimes absent is still sent, as null, so every client
//! sees the same keys. Commands are the exception: a field the caller may leave out is an `Option`
//! with `#[serde(default)]`.

pub mod access;
pub mod actor;
pub mod brief;
pub mod command;
pub mod decision;
pub mod drafts;
pub mod error;
pub mod event;
pub mod lane;
pub mod manager;
pub mod present;
pub mod pulls;
pub mod route;
pub mod search;
pub mod settings;
pub mod sidebar;
pub mod skills;
pub mod thread;
pub mod topic;
pub mod usage;
pub mod workspace;

pub use access::{AccessGrant, AccessKind, AccessPerson, AccessView, OtherTopicAccess};
pub use actor::{Actor, ActorKind};
pub use brief::{
    Artwork, BriefDecision, BriefTopic, BriefView, Burn, DraftsSummary, OvernightAction, SpendLine,
};
pub use command::{Attachment, Command, CommandResult};
pub use decision::{
    DecisionQueueView, DecisionState, DecisionView, NextStep, Proof, Provenance, QueueItem,
    Scenario, Stat,
};
pub use drafts::{Draft, DraftsView};
pub use error::{ApiError, ErrorCode, FieldError};
pub use event::{Event, FeedEvent};
pub use lane::{
    AskedMeta, Handover, LaneAct, LaneState, LaneView, MadeItem, Standing, Step, StepKind, Thumb,
};
pub use manager::{Ask, ManagerLane, ManagerView, SharedResource};
pub use present::Present;
pub use pulls::{Gate, GateState, PullRequest, PullsView};
pub use route::RoutePreview;
pub use search::{Answer, SearchKind, SearchResult, SearchView};
pub use settings::{
    ChatMode, Decider, DecisionRight, DecisionRule, Layout, LayoutPatch, ModuleCard, SettingsView,
    Theme, ThemeId, ThemePatch,
};
pub use sidebar::{GroupKind, Pin, PinKind, SidebarGroup, SidebarLane, SidebarView};
pub use skills::{Connection, ConnectionState, GuardrailSwitch, Skill, SkillsView};
pub use thread::{
    AgentsStrip, LabelKind, Message, MessageAction, MessageLabel, PinState, PinnedDecision,
    ReadBack, SinceSummary, StripItem, ThreadCard, ThreadView,
};
pub use topic::{
    AgentSpend, Blocker, CheckResult, Deal, DealAlt, Fact, Figure, Funnel, FunnelStep, Gap, Goal,
    GoalDecision, GuardrailItem, Guardrails, Health, HealthState, HistoryDay, HistoryEntry,
    HistoryPage, Job, LadderRung, NightStat, Plan, RowsHeading, SeriesPoint, Stage, StageAlt,
    StageRow, StuckAction, StuckReport, TaskRow, Tick, TopicKind, TopicLane, TopicMeta, TopicView,
    Trajectory, Verdict,
};
pub use usage::{Meter, UsageAccount, UsageView};
pub use workspace::{ModuleId, ModuleInfo, WorkspaceInfo, WorkspaceView};

pub mod wire;
pub use wire::*;

pub mod routes;

pub mod models;
pub use models::{Model, ModelState, ModelsView};

pub mod input;

pub mod extras;
