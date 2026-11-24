// The cockpit API contract, third acceptance check: contract 1.1.0 (.keryx/runs/cockpit-contract-1-1/PLAN.md).
//
// 1.0.0 left UI promises without backend state: typed goal changes, CI runs as records, schedules, reports, spot checks,
// split asks, decision-right counters, guardrail links, shared-resource turns, forecast logs, members, connection scopes
// and a handful of small fields. This check names every definition, field, value, route, command input and behaviour the
// plan adds, and drives the stand-in (gtm and dev) to prove the behaviours. Every assertion is labelled with the plan's
// decision id (P1..P4, G1..G5, R1..R8, L1..L8, E1..E7, S1..S7). It is locked: implementers do not edit it.
//
// Encodings it relies on (lib.rs, the 1.0.0 schema): a Present<T> view field is required and nullable (anyOf with
// {type: null}); a Vec<T> is a required array; an Option command input is a non-required property.
// The last section holds invariants whose inputs are drawn per run.
//
// usage: node scripts/cockpit-contract-v3-check.ts [--by-id] [--seed N]     exit 0 when every case passes

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

// The asks the stand-in must classify (phrasing from the mockups and the audits; the plan cites these constants).
const BUDGET_ASK = "Raise the Paid budget cap to 8000 euros";
const PRIORITY_ASK = "Make Partnerships the top priority this week";
const GUARDRAIL_ASK = "Change the guardrail on cost per lead to 50 euros";
const DEADLINE_ASK = "Move the Partnerships deadline to 15 February";
const SPLIT_ASK = "Write a recap post of the webinar and draft three LinkedIn ads for the Search campaign";
const RESEARCH_ASK = "Profile five more logistics brands for the partner list";
const DEV_ASK = "Add a retry to the export job when it times out";

const require = createRequire(import.meta.url);
const SCHEMA = "packages/cockpit-api/schema/cockpit.schema.json";
const OPENAPI = "packages/cockpit-api/schema/cockpit.openapi.json";
const COMPAT = "packages/cockpit-api/scripts/compat.ts";
const STANDIN = "apps/cockpit-standin/src/main.ts";
const FIXTURES = "packages/cockpit-api/fixtures";
const BASE = "/api/cockpit";
const VERSION = "1.1.0";
const HEADER_PATTERN = "^1\\.[0-9]+\\.[0-9]+$";
const IDS = ["P1", "P2", "P3", "P4", "G1", "G2", "G3", "G4", "G5", "R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8",
  "L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "E1", "E2", "E3", "E4", "E5", "E6", "E7",
  "S1", "S2", "S3", "S4", "S5", "S6", "S7"];

let failed = 0;
let passed = 0;
const counts: Record<string, number> = {};
function ok(cond: unknown, what: string) {
  const id = /^([A-Z]\d+|META)\b/.exec(what)?.[1] ?? "?";
  counts[id] = (counts[id] ?? 0) + 1;
  if (cond) passed++;
  else { failed++; console.log(`FAIL ${what}`); }
}
function fatal(what: string): never {
  console.log(`FAIL ${what}`);
  console.log(`cockpit contract v3: ${passed} passed, ${failed + 1} failed`);
  process.exit(1);
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const isTime = (v: unknown) => typeof v === "string" && RFC3339.test(v) && !Number.isNaN(Date.parse(v));
const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);
const short = (v: unknown) => JSON.stringify(v)?.slice(0, 160);

// ---- schema and OpenAPI (P1 first: on the 1.0.0 base the first failure is the version)
if (!existsSync(SCHEMA)) fatal(`P1 no exported schema at ${SCHEMA}`);
const schema: any = JSON.parse(readFileSync(SCHEMA, "utf8"));
const openapi: any = existsSync(OPENAPI) ? JSON.parse(readFileSync(OPENAPI, "utf8")) : {};
const defs: Record<string, any> = schema.$defs ?? {};
ok(schema["x-contract-version"] === VERSION, `P1 the schema's x-contract-version is ${VERSION} (got ${schema["x-contract-version"]})`);
ok(openapi.info?.version === VERSION, `P1 the OpenAPI info.version is ${VERSION} (got ${openapi.info?.version})`);
ok(schema.$id === "urn:morndo:cockpit-api:1", `P1 the schema $id stays urn:morndo:cockpit-api:1 (got ${schema.$id})`);

// P2: every response header cockpit-contract is a 1.x.y pattern, not a const
{
  const headers: { where: string; schema: any }[] = [];
  for (const [path, ops] of Object.entries<any>(openapi.paths ?? {})) {
    for (const [method, op] of Object.entries<any>(ops ?? {})) {
      for (const [status, response] of Object.entries<any>(op?.responses ?? {})) {
        headers.push({ where: `${method.toUpperCase()} ${path} ${status}`, schema: response?.headers?.["cockpit-contract"]?.schema });
      }
    }
  }
  const bad = headers.filter(h => !(h.schema?.type === "string" && h.schema.pattern === HEADER_PATTERN && h.schema.const === undefined));
  ok(headers.length > 0 && bad.length === 0,
    `P2 every response's cockpit-contract header is {type: string, pattern: ${HEADER_PATTERN}} (${bad.length} of ${headers.length} are not, e.g. ${bad[0]?.where}: ${short(bad[0]?.schema)})`);
}

// P3: compat compares response headers
if (!existsSync(COMPAT)) fatal(`P3 no compatibility gate at ${COMPAT}`);
{
  const compat = (args: string[]) => spawnSync(process.execPath, [COMPAT, "--base-ref", "HEAD", ...args], { encoding: "utf8" });
  const current = compat([]);
  ok(current.status === 0, `P3 the current contract is compatible with the released 1.0.0 (${(current.stderr || current.stdout).trim().slice(0, 200)})`);
  const dir = mkdtempSync(join(tmpdir(), "cockpit-compat-v3-"));
  try {
    const constant = structuredClone(openapi);
    for (const ops of Object.values<any>(constant.paths ?? {})) for (const op of Object.values<any>(ops ?? {})) {
      for (const response of Object.values<any>(op?.responses ?? {})) {
        if (response?.headers?.["cockpit-contract"]) response.headers["cockpit-contract"].schema = { type: "string", const: "2.0.0" };
      }
    }
    writeFileSync(join(dir, "const.openapi.json"), JSON.stringify(constant));
    ok(compat(["--current-openapi", join(dir, "const.openapi.json")]).status === 1, "P3 compat refuses a cockpit-contract header restored to const \"2.0.0\"");
    const removed = structuredClone(openapi);
    const workspace = removed.paths?.[`${BASE}/workspace`]?.get?.responses?.["200"];
    if (workspace?.headers) delete workspace.headers["cockpit-contract"];
    writeFileSync(join(dir, "removed.openapi.json"), JSON.stringify(removed));
    ok(workspace && compat(["--current-openapi", join(dir, "removed.openapi.json")]).status === 1, "P3 compat refuses a response that drops the cockpit-contract header");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---- schema shapes
type Ty = "string" | "integer" | "boolean" | `#${string}`;
const descTreeOf = (s: any): string[] => [s?.description ?? "", ...Object.values<any>(s?.properties ?? {}).map(p => p?.description ?? "")]
  .filter((t): t is string => typeof t === "string");
const refOf = (s: any): string | undefined => s?.$ref ?? (s?.allOf?.length === 1 ? s.allOf[0]?.$ref : undefined);
function nullable(s: any): boolean {
  if (Array.isArray(s?.type)) return s.type.includes("null");
  return (s?.anyOf ?? s?.oneOf ?? []).some((b: any) => b?.type === "null");
}
function nonNull(s: any): any {
  if (Array.isArray(s?.type)) return { ...s, type: s.type.find((t: string) => t !== "null") };
  const parts = s?.anyOf ?? s?.oneOf;
  if (Array.isArray(parts) && parts.some((b: any) => b?.type === "null")) {
    const rest = parts.filter((b: any) => b?.type !== "null");
    return rest.length === 1 ? rest[0] : { anyOf: rest };
  }
  return s;
}
function isTy(s: any, ty: Ty): boolean {
  if (ty.startsWith("#")) return refOf(s) === `#/$defs/${ty.slice(1)}`;
  return s?.type === ty;
}
type Shape = "present" | "vec" | "req" | "any" | "optional";
function shapeOk(owner: any, field: string, shape: Shape, ty: Ty): string | null {
  const s = owner?.properties?.[field];
  if (!s) return "missing";
  const required = (owner.required ?? []).includes(field);
  if (!(typeof s.description === "string" && s.description.trim())) return "no description";
  switch (shape) {
    case "present": return required && nullable(s) && isTy(nonNull(s), ty) ? null : `not required+nullable ${ty}: ${short(s)}`;
    case "req": return required && !nullable(s) && isTy(s, ty) ? null : `not required ${ty}: ${short(s)}`;
    case "any": return required && isTy(nonNull(s), ty) ? null : `not required ${ty}: ${short(s)}`;
    case "vec": return required && s.type === "array" && isTy(s.items, ty) ? null : `not a required array of ${ty}: ${short(s)}`;
    case "optional": return !required && isTy(nonNull(s), ty) ? null : `not an optional ${ty}: ${short(s)}`;
  }
}
const branch = (def: string, tag: string, key = "type") => (defs[def]?.oneOf ?? defs[def]?.anyOf ?? []).find((b: any) => b?.properties?.[key]?.const === tag);
function field(id: string, def: string, name: string, shape: Shape, ty: Ty) {
  const problem = shapeOk(defs[def], name, shape, ty);
  ok(problem === null, `${id} ${def}.${name} is ${shape} ${ty}${problem ? ` (${problem})` : ""}`);
}
function fields(id: string, def: string, list: [string, Shape, Ty][]) { for (const [name, shape, ty] of list) field(id, def, name, shape, ty); }
function eventField(id: string, type: string, name: string, shape: Shape, ty: Ty) {
  const problem = shapeOk(branch("Event", type), name, shape, ty);
  ok(problem === null, `${id} event ${type}.${name} is ${shape} ${ty}${problem ? ` (${problem})` : ""}`);
}
function objectDef(id: string, name: string) {
  const d = defs[name];
  ok(d && d.type === "object" && typeof d.description === "string" && d.description.trim(), `${id} the schema defines ${name}, with a description`);
}
function enumDef(id: string, name: string, values: string[], isNew: boolean) {
  const d = defs[name];
  const missing = values.filter(v => !(d?.enum ?? []).includes(v));
  ok(d && missing.length === 0 && d.$comment === "cockpit-reader:enum" && (!isNew || (typeof d.description === "string" && d.description.trim())),
    `${id} ${name} ${isNew ? "is a new reader-tolerant enum with a description and" : "gains"} ${values.join(", ")}${missing.length ? ` (missing ${missing.join(", ")})` : ""}`);
}
function slugId(id: string, name: string) {
  const d = defs[name];
  ok(d && d.type === "string" && d.pattern === defs.TopicId?.pattern && typeof d.description === "string" && d.description.trim(),
    `${id} ${name} is a slug id with a description`);
}
function eventDef(id: string, type: string) {
  const b = branch("Event", type);
  ok(b && (b.required ?? []).includes("type"), `${id} the contract has the event ${type}`);
}
const routeRef = (path: string) => (openapi.paths?.[BASE + path]?.get?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref as string | undefined)
  ?.replace("#/components/schemas/", "");

// G: goal changes
enumDef("G1", "GoalField", ["budget", "priority", "guardrail"], false);
for (const n of ["BudgetChange", "PriorityChange", "GuardrailChange"]) objectDef("G2", n);
fields("G2", "GoalChange", [["budget", "present", "#BudgetChange"], ["priority", "present", "#PriorityChange"],
  ["guardrail", "present", "#GuardrailChange"], ["from", "req", "integer"], ["to", "req", "integer"]]);
fields("G2", "BudgetChange", [["from", "req", "#Money"], ["to", "req", "#Money"], ["period", "present", "string"]]);
fields("G2", "PriorityChange", [["from", "present", "integer"], ["to", "req", "integer"]]);
fields("G2", "GuardrailChange", [["guardrailId", "req", "string"], ["name", "req", "string"], ["from", "req", "#MeasuredValue"], ["to", "req", "#MeasuredValue"]]);
field("G4", "TopicMeta", "priority", "present", "integer");
for (const d of ["DecisionView", "QueueItem", "BriefDecision"]) field("G5", d, "proposer", "present", "#Actor");

// R: records and the development module
enumDef("R1", "TargetKind", ["file"], false);
field("R1", "MadeRecordView", "url", "present", "string");
fields("R2", "MadeRecordView", [["trigger", "present", "string"], ["startedAt", "present", "#Timestamp"], ["finishedAt", "present", "#Timestamp"],
  ["state", "present", "#GateState"], ["checks", "vec", "#CheckResult"], ["log", "present", "#FailingTest"], ["pullId", "present", "#PullId"]]);
field("R2", "StuckReport", "runId", "present", "#RecordId");
eventDef("R2", "run.changed");
eventField("R2", "run.changed", "recordId", "any", "#RecordId");
eventField("R2", "run.changed", "laneId", "any", "#LaneId");
fields("R3", "Gate", [["round", "present", "integer"], ["reviewer", "present", "#Actor"], ["runId", "present", "#RecordId"]]);
field("R4", "StuckReport", "tries", "present", "#MeasuredValue");
field("R4", "LaneView", "tries", "present", "#MeasuredValue");
field("R4", "GuardrailSwitch", "limit", "present", "#MeasuredValue");
fields("R5", "NextStep", [["state", "present", "#StepKind"], ["doneAt", "present", "#Timestamp"]]);
field("R5", "Step", "doneAt", "present", "#Timestamp");
const OUTCOME_KINDS = ["released", "merged", "updated", "renewed", "deleted", "published", "sent", "switchedOff", "added", "stopped"];
enumDef("R6", "OutcomeKind", OUTCOME_KINDS, true);
objectDef("R6", "OvernightOutcome");
field("R6", "OvernightAction", "outcome", "present", "#OvernightOutcome");
fields("R6", "OvernightOutcome", [["kind", "req", "#OutcomeKind"], ["count", "present", "integer"], ["heldBack", "present", "integer"],
  ["rounds", "present", "integer"], ["checks", "vec", "#CheckResult"], ["pullId", "present", "#PullId"], ["sentOutside", "req", "boolean"]]);

// L: live behaviours
slugId("L1", "ScheduleId");
enumDef("L1", "ScheduleKind", ["lane", "report", "check", "brief"], true);
objectDef("L1", "Schedule");
fields("L1", "Schedule", [["id", "req", "#ScheduleId"], ["kind", "req", "#ScheduleKind"], ["title", "req", "string"], ["topicId", "present", "#TopicId"],
  ["rrule", "req", "string"], ["text", "req", "string"], ["time", "present", "string"], ["nextAt", "present", "#Timestamp"], ["lastAt", "present", "#Timestamp"],
  ["lastLaneId", "present", "#LaneId"], ["source", "req", "string"], ["opener", "req", "#Actor"], ["on", "req", "boolean"]]);
field("L1", "ManagerView", "schedules", "vec", "#Schedule");
field("L1", "LaneView", "scheduleId", "present", "#ScheduleId");
field("L1", "Job", "scheduleId", "present", "#ScheduleId");
enumDef("L1", "JobCadence", ["weekly", "monthly"], false);
eventDef("L1", "schedule.changed");
eventField("L1", "schedule.changed", "scheduleId", "any", "#ScheduleId");
eventField("L1", "lane.filed", "scheduleId", "present", "#ScheduleId");

slugId("L2", "ReportId");
enumDef("L2", "TargetKind", ["report"], false);
enumDef("L2", "ReportState", ["scheduled", "drafting", "drafted", "sent", "skipped"], true);
objectDef("L2", "Report");
fields("L2", "Report", [["id", "req", "#ReportId"], ["topicId", "req", "#TopicId"], ["title", "req", "string"], ["recipients", "vec", "#Actor"],
  ["writer", "req", "#Actor"], ["scheduleId", "present", "#ScheduleId"], ["dueAt", "req", "#Timestamp"], ["state", "req", "#ReportState"],
  ["draftId", "present", "#DraftId"], ["sentAt", "present", "#Timestamp"], ["checkedBy", "present", "#Actor"], ["periodFrom", "present", "#Timestamp"],
  ["periodTo", "present", "#Timestamp"]]);
objectDef("L2", "ReportView");
ok(routeRef("/reports/{id}") === "ReportView", `L2 the OpenAPI lists GET ${BASE}/reports/{id} → ReportView (got ${routeRef("/reports/{id}")})`);
for (const d of ["TopicMeta", "SharedTopicStatus", "TopicStatusView"]) field("L2", d, "nextReportId", "present", "#ReportId");
eventDef("L2", "report.changed");
eventField("L2", "report.changed", "reportId", "any", "#ReportId");
eventField("L2", "report.changed", "topicId", "any", "#TopicId");

slugId("L3", "CheckId");
enumDef("L3", "TargetKind", ["check"], false);
enumDef("L3", "SpotCheckKind", ["random", "periodic", "numbers"], true);
enumDef("L3", "SpotCheckOutcome", ["held", "failed", "mixed"], true);
objectDef("L3", "SpotCheck");
fields("L3", "SpotCheck", [["id", "req", "#CheckId"], ["kind", "req", "#SpotCheckKind"], ["topicId", "req", "#TopicId"], ["laneId", "present", "#LaneId"],
  ["scheduleId", "present", "#ScheduleId"], ["checker", "req", "#Actor"], ["subject", "present", "#Actor"], ["at", "req", "#Timestamp"],
  ["rule", "req", "string"], ["sample", "present", "#MeasuredValue"], ["outcome", "req", "#SpotCheckOutcome"], ["passed", "req", "integer"],
  ["failed", "req", "integer"], ["text", "req", "string"], ["followUpLaneId", "present", "#LaneId"]]);
objectDef("L3", "CheckView");
ok(routeRef("/checks/{id}") === "CheckView", `L3 the OpenAPI lists GET ${BASE}/checks/{id} → CheckView (got ${routeRef("/checks/{id}")})`);
{
  const problem = shapeOk(branch("HistoryEntry", "event", "kind"), "checkId", "present", "#CheckId");
  ok(problem === null, `L3 the history event entry gains checkId: Present<CheckId>${problem ? ` (${problem})` : ""}`);
}
eventDef("L3", "check.recorded");
eventField("L3", "check.recorded", "checkId", "any", "#CheckId");
eventField("L3", "check.recorded", "topicId", "any", "#TopicId");

eventField("L4", "lane.filed", "groupId", "present", "string");
field("L4", "LaneView", "groupId", "present", "string");
field("L4", "Receipt", "groupLaneIds", "vec", "#LaneId");

fields("L5", "DecisionRight", [["usedToday", "present", "integer"], ["resetsAt", "present", "#Timestamp"]]);
ok(descTreeOf(defs.DecisionRight).some(t => /limit/i.test(t) && /next/i.test(t) && /decision|decide/i.test(t)),
  "L5 DecisionRight's doc says that at the limit the next item of that rule becomes a decision in Decide");
field("L5", "OvernightAction", "rule", "present", "#DecisionRule");
eventDef("L5", "decisionRight.changed");
eventDef("L5", "decisionRight.limitReached");
eventField("L5", "decisionRight.limitReached", "rule", "any", "#DecisionRule");
eventField("L5", "decisionRight.limitReached", "personId", "present", "#PersonId");

enumDef("L6", "GuardrailAction", ["ask", "pause", "revert", "stop"], true);
fields("L6", "GuardrailSwitch", [["id", "present", "string"], ["topicId", "present", "#TopicId"], ["action", "present", "#GuardrailAction"]]);
fields("L6", "GuardrailItem", [["id", "present", "string"], ["switchId", "present", "string"], ["action", "present", "#GuardrailAction"]]);
field("L6", "Blocker", "guardrailId", "present", "string");
{
  const set = branch("Command", "guardrail.set");
  const problem = shapeOk(set, "id", "optional", "string");
  ok(problem === null && set?.properties?.name, `L6 guardrail.set gains an optional id and still takes the name${problem ? ` (${problem})` : ""}`);
}
eventField("L6", "guardrail.breached", "guardrailId", "any", "string");

fields("L7", "SharedResource", [["id", "present", "string"], ["laneIds", "vec", "#LaneId"], ["order", "vec", "#LaneId"], ["turn", "present", "#LaneId"],
  ["writers", "vec", "#Actor"], ["readers", "vec", "#Actor"], ["quota", "present", "#MeasuredValue"], ["resetsAt", "present", "#Timestamp"],
  ["lanes", "req", "integer"]]);
field("L7", "LaneView", "waitsOnResource", "present", "string");
eventDef("L7", "resource.changed");
eventField("L7", "resource.changed", "resourceId", "any", "string");

fields("L8", "Forecast", [["id", "present", "string"], ["value", "present", "#MeasuredValue"], ["low", "present", "#MeasuredValue"],
  ["high", "present", "#MeasuredValue"], ["scoreAt", "present", "#Timestamp"], ["actual", "present", "#MeasuredValue"],
  ["scoredAt", "present", "#Timestamp"], ["held", "present", "boolean"], ["outcome", "req", "string"]]);
fields("L8", "Goal", [["calibrationScore", "present", "#MeasuredValue"], ["nextScoreAt", "present", "#Timestamp"]]);
eventDef("L8", "forecast.scored");
eventField("L8", "forecast.scored", "topicId", "any", "#TopicId");
eventField("L8", "forecast.scored", "forecastId", "any", "string");

// E: entities, sharing, small fields
objectDef("E1", "Member");
fields("E1", "Member", [["person", "req", "#Actor"], ["email", "present", "string"], ["role", "present", "string"], ["owner", "req", "boolean"],
  ["access", "vec", "#OtherTopicAccess"], ["invitedAt", "present", "#Timestamp"], ["joinedAt", "present", "#Timestamp"]]);
objectDef("E1", "MembersView");
fields("E1", "MembersView", [["items", "vec", "#Member"], ["invitations", "vec", "#Invitation"]]);
ok(routeRef("/members") === "MembersView", `E1 the OpenAPI lists GET ${BASE}/members → MembersView (got ${routeRef("/members")})`);
fields("E1", "Invitation", [["acceptedAt", "present", "#Timestamp"], ["topicId", "present", "#TopicId"], ["invitedBy", "present", "#Actor"]]);
eventDef("E1", "members.changed");
eventField("E1", "members.changed", "personId", "present", "#PersonId");
const SCOPES = ["read", "draftsOnly", "readWrite", "runsLanes", "agent"];
enumDef("E2", "ConnectionScope", SCOPES, true);
field("E2", "Connection", "scope", "present", "#ConnectionScope");
ok(/refus/i.test(`${defs.Connection?.properties?.scope?.description ?? ""} ${defs.ConnectionScope?.description ?? ""}`),
  "E2 the scope's doc says the action gateway refuses a write beyond the scope");
{
  const run = branch("Command", "skill.run");
  ok(run?.properties?.text && !(run.required ?? []).includes("text"), "E3 skill.run.text is optional");
}
field("E4", "BriefView", "edition", "present", "#MeterCount");
field("E5", "LaneView", "leadName", "present", "string");
field("E6", "Message", "addressee", "present", "#PersonId");

// P4 and E7: doc sentences, matched by keyword rather than wording
const desc = (s: any) => (typeof s?.description === "string" ? s.description : "");
const descTree = (s: any) => [desc(s), ...Object.values<any>(s?.properties ?? {}).map(desc)];
const opText = (path: string) => {
  const op = openapi.paths?.[BASE + path]?.get;
  return [op?.summary ?? "", op?.description ?? "", ...(op?.parameters ?? []).map((p: any) => `${p?.description ?? ""} ${p?.schema?.description ?? ""}`)];
};
const anyText = (texts: string[], test: (t: string) => boolean) => texts.some(t => test(t));
ok(anyText([...descTree(defs.SearchView), ...opText("/search")], t => /empty/i.test(t) && /recent/i.test(t) && /skills/i.test(t)),
  "P4 SearchView says an empty query returns no results and the client builds the empty panel (decisions, brief, recent, skills)");
ok(anyText(descTree(defs.TopicView), t => /client/i.test(t) && /(recovery|earlier days|history filter)/i.test(t)),
  "P4 TopicView says the open state of the recovery plan, the history filter and Earlier days belongs to the client");
ok(/oldest/i.test(desc(defs.ThreadView?.properties?.messages)), "P4 ThreadView.messages says oldest first by at");
ok(/lane/i.test(desc(defs.ThreadView?.properties?.suggestions)) && /\b(never|not|no)\b/i.test(desc(defs.ThreadView?.properties?.suggestions)),
  "P4 ThreadView.suggestions says a suggestion sent as written is answered and never files a lane");
ok(/current/i.test(desc(defs.SinceSummary?.properties?.lines)) && /record/i.test(desc(defs.SinceSummary?.properties?.lines)),
  "P4 SinceSummary.lines says the lines are computed from the current records");
{
  const t = desc(defs.TopicView?.properties?.health);
  ok(/no goal/i.test(t) && /stuck/i.test(t) && /on track/i.test(t) && /idle/i.test(t), "P4 TopicView.health states the no-goal rule (Stuck, On track, Idle)");
  ok(/project/i.test(t) && /needs you/i.test(t) && /working/i.test(t), "P4 TopicView.health states the dev rule: a project reads as its lanes (Stuck, Needs you, Working, Idle)");
}
{
  const t = desc(defs.Actor?.properties?.shortName);
  ok(/full name/i.test(t) && /first name/i.test(t) && /\byou\b/i.test(t), "P4 Actor.shortName states the rule (agents full name, people first name, the viewer You)");
}
{
  const texts = [...descTree(defs.ThreadView), desc(defs.ThreadId), desc(defs.MessageAudience), ...descTree(defs.Message), desc(defs.LaneView), ...opText("/threads/{threadId}")];
  ok(anyText(texts, t => /lane/i.test(t) && /shared/i.test(t) && /work/i.test(t)), "E7 the lane thread's doc says lane chat is shared with whoever works the lane");
  const spend = desc(defs.TopicView?.properties?.spend);
  ok(/everything|all/i.test(spend) && /stage/i.test(spend) && /(watch|status)/i.test(spend),
    "E7 TopicView.spend says a person who can work everything sees the spend, stage workers and watchers do not");
}

// ---- strict validator over the committed schema (as in v2)
const Ajv2020 = require("ajv/dist/2020.js").default ?? require("ajv/dist/2020.js");
const ajv = new Ajv2020({ strict: true, allErrors: false });
const intFormat = (min: number, max: number) => ({ type: "number", validate: (n: number) => Number.isInteger(n) && n >= min && n <= max });
ajv.addFormat("int64", intFormat(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
ajv.addFormat("uint64", intFormat(0, Number.MAX_SAFE_INTEGER));
ajv.addFormat("int32", intFormat(-(2 ** 31), 2 ** 31 - 1));
ajv.addFormat("uint32", intFormat(0, 2 ** 32 - 1));
ajv.addFormat("uint16", intFormat(0, 65535));
ajv.addFormat("uint8", intFormat(0, 255));
ajv.addFormat("uint", intFormat(0, Number.MAX_SAFE_INTEGER));
ajv.addFormat("double", { type: "number", validate: (n: number) => Number.isFinite(n) });
ajv.addFormat("float", { type: "number", validate: (n: number) => Number.isFinite(n) });
// the schema root carries the contract version as an annotation (https://ajv.js.org/strict-mode.html#unknown-keywords)
ajv.addKeyword("x-contract-version");
ajv.addFormat("date-time", { type: "string", validate: (s: string) => isTime(s) });
ajv.addFormat("uri", { type: "string", validate: (s: string) => { try { new URL(s); return true; } catch { return false; } } });
try { ajv.addSchema(schema, "cockpit"); ajv.getSchema("cockpit#/$defs/WorkspaceView"); }
catch (e) { fatal(`P1 schema does not compile in Ajv strict mode: ${String((e as Error).message).slice(0, 300)}`); }
function valid(def: string, value: unknown, what: string) {
  const v = ajv.getSchema(`cockpit#/$defs/${def}`);
  if (!v) return ok(false, `${what}: no $defs/${def}`);
  const good = v(value);
  ok(good, `${what} is a valid ${def}${good ? "" : ": " + ajv.errorsText(v.errors).slice(0, 300)}`);
}

// ---- generic shape rules (v2), with the new target kinds
function walk(value: unknown, at: string, visit: (key: string, v: unknown, path: string, parent: any) => void) {
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${at}[${i}]`, visit));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { visit(k, v, `${at}.${k}`, value); walk(v, `${at}.${k}`, visit); }
}
const TARGETS = ["topic", "lane", "decision", "thread", "person", "draft", "skill", "pull", "run", "review", "file", "report", "check",
  "manager", "brief", "drafts", "skills", "settings"];
function shapeRules(id: string, body: unknown, where: string) {
  const bad: string[] = [];
  walk(body, where, (k, v, path, parent) => {
    if (k === "href") bad.push(`${path}: a hash or page link (use target or url)`);
    if ((k === "at" || /[a-z]At$/.test(k)) && v !== null && !isTime(v)) bad.push(`${path}: ${JSON.stringify(v)} is not an RFC 3339 time`);
    if (k === "currency" && !(typeof v === "string" && /^[A-Z]{3}$/.test(v) && Number.isInteger(parent.amountMinor))) bad.push(`${path}: money needs amountMinor and an ISO 4217 currency`);
    if (k === "target" && typeof v === "string") bad.push(`${path}: a string target (use a Target object)`);
    if (k === "target" && v !== null && typeof v === "object" && !TARGETS.includes((v as any).kind)) bad.push(`${path}: target kind ${JSON.stringify((v as any)?.kind)}`);
    if (k === "own") bad.push(`${path}: "own" differs per reader (compare author.id with me.id)`);
  });
  ok(bad.length === 0, `${id} ${where}: links, times, money and targets are typed${bad.length ? " — " + bad.slice(0, 4).join("; ") : ""}`);
}

// ---- the stand-in (a fresh instance per scenario, as v2 does)
if (!existsSync(STANDIN)) fatal(`no stand-in at ${STANDIN}`);
type Module = "gtm" | "dev";
async function start(module: Module) {
  const child = spawn(process.execPath, [STANDIN, "--module", module, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`stand-in (${module}) printed no listening line: ${out.slice(0, 300)}`)), 15000);
    const read = (b: Buffer) => {
      out += b.toString();
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("exit", code => { clearTimeout(timer); reject(new Error(`stand-in (${module}) exited ${code}: ${out.slice(0, 300)}`)); });
  });
  return { child, url: `http://127.0.0.1:${port}` };
}
async function http(url: string, path: string, init?: RequestInit) {
  const r = await fetch(url + BASE + path, init);
  const type = r.headers.get("content-type") ?? "";
  const body: any = type.includes("json") ? await r.json() : await r.text();
  return { status: r.status, body, headers: r.headers };
}
const get = (url: string, path: string) => http(url, path);
const asOf = (as?: string) => (as ? `?as=${as}` : "");
async function act(url: string, command: unknown, as?: string) {
  const r = await http(url, `/actions${asOf(as)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
  if (r.status === 200) {
    const v = ajv.getSchema("cockpit#/$defs/CommandResult");
    if (v && !v(r.body)) ok(false, `META the result of ${(command as any)?.type} is a valid CommandResult: ${ajv.errorsText(v.errors).slice(0, 200)}`);
  }
  return r;
}
async function view(id: string, url: string, path: string, def: string) {
  const r = await get(url, path);
  ok(r.status === 200, `${id} GET ${path} → 200 (got ${r.status})`);
  if (r.status === 200) { valid(def, r.body, `${id} GET ${path}`); shapeRules(id, r.body, `GET ${path}`); }
  return r.status === 200 ? r.body : undefined;
}
const by = (list: any[] | undefined, key: string, value: unknown) => (list ?? []).find(x => x && x[key] === value);
const events = (r: { body: any }) => (r.body?.events ?? []) as any[];
const hasEvent = (r: { body: any }, type: string, match: Record<string, unknown> = {}) =>
  events(r).some(e => e.type === type && Object.entries(match).every(([k, v]) => e[k] === v));
function openFeed(url: string, as?: string) {
  const frames: any[] = [];
  const ws = new WebSocket(url.replace("http", "ws") + BASE + "/feed" + asOf(as));
  const opened = new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("feed did not open")); });
  ws.onmessage = m => { try { frames.push(JSON.parse(String(m.data))); } catch { /* not JSON: ignored */ } };
  return { ws, frames, opened };
}
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function allPages(url: string, path: string, pick: (body: any) => any[]): Promise<any[]> {
  const items: any[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < 50; n++) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await get(url, `${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (r.status !== 200) break;
    items.push(...pick(r.body));
    cursor = typeof r.body?.nextCursor === "string" ? r.body.nextCursor : null;
    if (!cursor) break;
  }
  return items;
}
const historyRows = (url: string, topicId: string, as?: string) => allPages(url, `/topics/${topicId}/history${asOf(as)}`,
  body => (body?.days ?? []).flatMap((d: any) => d.entries ?? []).filter((e: any) => e.kind === "event"));
const threadMessages = (url: string, threadId: string, as?: string) => allPages(url, `/threads/${threadId}${asOf(as)}`, body => body?.messages ?? []);
function numberOf(v: any): number | undefined {
  if (v?.kind === "count") return v.value;
  if (v?.kind === "money") return v.money?.amountMinor;
  if (v?.kind === "rate") return v.percent;
  return undefined;
}
function local(t: string, tz: string, part: "date" | "time"): string {
  const d = new Date(t);
  if (part === "time") return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
async function topicIds(url: string): Promise<string[]> {
  return ((await get(url, "/sidebar")).body?.groups ?? []).map((g: any) => g.id);
}
async function laneIds(url: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const t of await topicIds(url)) for (const l of (await get(url, `/topics/${t}`)).body?.lanes ?? []) ids.add(l.id);
  for (const l of (await get(url, "/sidebar")).body?.managerLanes ?? []) ids.add(l.id);
  return [...ids];
}
async function resolves(url: string, t: any): Promise<boolean> {
  const id = t?.id;
  const okGet = async (path: string) => (await get(url, path)).status === 200;
  switch (t?.kind) {
    case "topic": return okGet(`/topics/${id}`);
    case "lane": return okGet(`/lanes/${id}`);
    case "decision": return okGet(`/decisions/${id}`);
    case "thread": return okGet(`/threads/${id}`);
    case "run": case "review": case "file": return okGet(`/records/${id}`);
    case "report": return okGet(`/reports/${id}`);
    case "check": return okGet(`/checks/${id}`);
    case "pull": return id ? Boolean(by((await get(url, "/pulls")).body?.items, "id", id)) : okGet("/pulls");
    case "draft": return Boolean(by((await get(url, "/drafts")).body?.items, "id", id));
    case "skill": return Boolean(by((await get(url, "/skills")).body?.skills, "id", id));
    case "person": return ((await get(url, "/members")).body?.items ?? []).some((m: any) => m.person?.id === id);
    case "manager": case "brief": case "drafts": case "skills": case "settings": return okGet(`/${t.kind}`);
    default: return false;
  }
}

async function scenario(name: string, module: Module, fn: (url: string) => Promise<void>) {
  let instance: Awaited<ReturnType<typeof start>> | undefined;
  try {
    instance = await start(module);
    await fn(instance.url);
  } catch (e) {
    ok(false, `${name}: the scenario ran to the end (${String((e as Error)?.message ?? e).slice(0, 200)})`);
  } finally { instance?.child.kill(); }
}

// ---- gtm, read-only: the views, records and fixtures as they start
async function gtmReads(url: string) {
  const w = await get(url, "/workspace");
  ok(w.headers.get("cockpit-contract") === VERSION, `P1 gtm responses carry cockpit-contract: ${VERSION} (got ${w.headers.get("cockpit-contract")})`);
  ok(w.body?.contractVersion === VERSION, `P1 the gtm workspace names contract ${VERSION} (got ${w.body?.contractVersion})`);
  const tz: string = w.body?.timezone ?? "Europe/Berlin";
  const owner: string = w.body?.me?.id;
  const brief = await view("E4", url, "/brief", "BriefView");
  const settings = await view("E4", url, "/settings", "SettingsView");
  const e = brief?.edition;
  ok(e && e.of === settings?.briefsPerDay && e.used >= 1 && e.used <= e.of, `E4 gtm brief edition is n of briefsPerDay (got ${short(e)}, ${settings?.briefsPerDay} a day)`);

  // E2 connection scopes
  const skills = await view("E2", url, "/skills", "SkillsView");
  const conns: any[] = skills?.connections ?? [];
  ok(conns.length > 0 && conns.every(c => SCOPES.includes(c.scope)), `E2 every gtm connection has a scope (${short(conns.map(c => [c.id, c.scope]))})`);

  // L5 decision-right counters
  const rights: any[] = settings?.decisionRights ?? [];
  ok(rights.length > 0 && rights.every(r => r.who === "you" ? r.usedToday === null : Number.isInteger(r.usedToday) && r.usedToday >= 0
    && (r.dailyLimit === null || r.usedToday <= r.dailyLimit)), `L5 usedToday is null for your rights and a count up to the limit for delegated ones (${short(rights.map(r => [r.rule, r.who, r.usedToday]))})`);

  // L1 schedules, L7 shared resources
  const manager = await view("L1", url, "/manager", "ManagerView");
  const schedules: any[] = manager?.schedules ?? [];
  const kinds = new Set(schedules.map(s => s.kind));
  ok(["lane", "report", "check", "brief"].every(k => kinds.has(k)), `L1 the Manager lists lane, report, check and brief schedules (got ${[...kinds].join(", ")})`);
  ok(schedules.length > 0 && schedules.every(s => /^(RRULE:)?FREQ=(SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)(;|$)/.test(s.rrule)
    && (s.time === null || /^\d{2}:\d{2}$/.test(s.time))), "L1 every schedule has an RFC 5545 rrule and an HH:MM time or null");
  const laneSchedule = async (laneId: string) => by(schedules, "id", (await get(url, `/lanes/${laneId}`)).body?.scheduleId);
  const weekly = await laneSchedule("click-floor");
  ok(weekly?.kind === "lane" && /FREQ=WEEKLY/.test(weekly.rrule) && /BYDAY=([^;]*,)?MO/.test(weekly.rrule), `L1 click-floor opens each Monday from its schedule (${short(weekly)})`);
  const monthly = await laneSchedule("competitor-watch");
  ok(monthly?.kind === "lane" && /FREQ=MONTHLY/.test(monthly.rrule) && (/BYDAY=([^;]*,)?2MO/.test(monthly.rrule) || (/BYDAY=MO/.test(monthly.rrule) && /BYSETPOS=2/.test(monthly.rrule))),
    `L1 competitor-watch opens on the second Monday of each month from its schedule (${short(monthly)})`);
  const resources: any[] = manager?.sharedResources ?? [];
  ok(resources.length > 0 && resources.every(r => Array.isArray(r.laneIds) && r.laneIds.length === r.lanes), `L7 every shared resource lists its lanes (lanes === laneIds.length: ${short(resources.map(r => [r.lanes, r.laneIds]))})`);
  ok(resources.every(r => (r.order ?? []).every((id: string) => r.laneIds?.includes(id)) && (r.turn === null || r.laneIds?.includes(r.turn))),
    "L7 a resource's turn order and current turn are among its lanes");
  let unresolvedLanes = 0;
  for (const r of resources) for (const id of r.laneIds ?? []) if ((await get(url, `/lanes/${id}`)).status !== 200) unresolvedLanes++;
  ok(resources.some(r => (r.laneIds ?? []).length) && unresolvedLanes === 0, `L7 every shared-resource lane resolves (${unresolvedLanes} do not)`);

  // L8 forecast logs filled from the calibration prose; L6 the paid CPL blocker names its guardrail
  const topics: Record<string, any> = {};
  for (const id of await topicIds(url)) topics[id] = await view("L8", url, `/topics/${id}`, "TopicView");
  const log = (id: string): any[] => topics[id]?.goal?.forecastLog ?? [];
  ok(log("paid").some(f => numberOf(f.value) === 140 && numberOf(f.actual) === 132), "L8 paid's log holds the October forecast, 140 → 132");
  ok(log("content").some(f => numberOf(f.value) === 240 && numberOf(f.actual) === 226), "L8 content's log holds the last webinar's forecast, 240 → 226");
  const scoredOutbound = log("outbound").filter(f => f.scoredAt !== null && f.scoredAt !== undefined);
  ok(scoredOutbound.length === 1 && scoredOutbound[0]?.held === true, `L8 outbound has one scored forecast and it held (${short(scoredOutbound)})`);
  ok(log("partnerships").some(f => isTime(f.scoreAt) && local(f.scoreAt, tz, "date").endsWith("-12-18") && f.scoredAt === null && f.outcome === ""),
    "L8 partnerships' first forecast is scored on 18 December and is not scored yet");
  const all = Object.values(topics).flatMap((t: any) => t?.goal?.forecastLog ?? []);
  ok(all.length > 0 && all.every(f => f.scoredAt !== null || f.outcome === ""), "L8 a forecast not yet scored has outcome \"\"");
  const cpl = (topics.paid?.goal?.guardrails?.items ?? []).find((g: any) => /cost per lead/i.test(g.what));
  ok(typeof cpl?.id === "string" && (topics.paid?.goal?.blockers ?? []).some((b: any) => b.guardrailId === cpl.id),
    `L6 the paid cost-per-lead blocker names its guardrail (${cpl?.id})`);

  // R6, R7 (gtm overnight rows: outcomes and undo windows are checked in the overnight scenario)
  // R1 What it made: no item targets its own lane, every target resolves, file records carry a url; E5 leadName
  await madeAndLeads("gtm", url, owner);

  // L3 the spot check of batch 3, as a record linked from history
  const withCheck: { topicId: string; checkId: string }[] = [];
  for (const id of Object.keys(topics)) for (const row of await historyRows(url, id)) if (row.checkId) withCheck.push({ topicId: id, checkId: row.checkId });
  ok(withCheck.length > 0, "L3 a history row links its spot check (checkId)");
  for (const c of withCheck.slice(0, 5)) {
    const check = await view("L3", url, `/checks/${c.checkId}`, "CheckView");
    ok(check?.id === c.checkId && check?.topicId === c.topicId, `L3 the spot check ${c.checkId} names its topic ${c.topicId}`);
  }

  // L2 the report to a status-only recipient, and nothing else new
  const tomBrief = (await get(url, "/brief?as=tom-ahrens")).body;
  const tomTopic = (await get(url, "/topics/partnerships?as=tom-ahrens")).body;
  const shared = by(tomBrief?.sharedTopics, "topicId", "partnerships");
  const rid = shared?.nextReportId ?? tomTopic?.meta?.nextReportId;
  ok(typeof rid === "string" && shared?.nextReportId === rid && tomTopic?.meta?.nextReportId === rid,
    `L2 Tom's shared status and topic meta name the next Partnerships report (${shared?.nextReportId}, ${tomTopic?.meta?.nextReportId})`);
  const report = typeof rid === "string" ? await view("L2", url, `/reports/${rid}?as=tom-ahrens`, "ReportView") : undefined;
  const rep = report;
  ok(rep?.topicId === "partnerships" && (rep?.recipients ?? []).some((a: any) => a.id === "tom-ahrens"), "L2 Tom reads his Partnerships report, which names him as a recipient");
  const reportIds = new Set<string>();
  for (const t of Object.values(topics)) if (t?.meta?.nextReportId) reportIds.add(t.meta.nextReportId);
  for (const id of reportIds) {
    const r = (await get(url, `/reports/${id}`)).body;
    const r2 = r;
    if (r2 && !(r2.recipients ?? []).some((a: any) => a.id === "tom-ahrens")) {
      ok((await get(url, `/reports/${id}?as=tom-ahrens`)).status === 403, `L2 a report not sent to Tom (${id}) is 403 for him`);
    }
  }
  ok((await get(url, "/members?as=tom-ahrens")).status === 403, "L2 a status-only recipient cannot read the members");
  if (withCheck[0]) ok((await get(url, `/checks/${withCheck[0].checkId}?as=tom-ahrens`)).status === 403, "L2 a status-only recipient cannot read a spot check");

  // S4 one clock for the stuck promo
  for (const burn of brief?.burns ?? []) {
    const lane = (await get(url, `/lanes/${burn.laneId}`)).body;
    const rows = (await historyRows(url, lane?.topicId)).filter(r => r.laneId === burn.laneId);
    const strip: any[] = (await get(url, `/threads/topic:${lane?.topicId}`)).body?.agents?.items ?? [];
    const key = (t: string) => String(t).toLowerCase().slice(0, 30);
    const pairs = strip.flatMap(s => rows.filter(r => key(r.text) === key(s.text)).map(r => [s.at, r.at]));
    ok(pairs.length > 0 && pairs.every(([a, b]) => Date.parse(a) === Date.parse(b)),
      `S4 ${burn.laneId}: each stuck event has one time in the history and the chat strip (${short(pairs)})`);
    ok(rows.some(r => Date.parse(r.at) === Date.parse(burn.stuckAt)), `S4 ${burn.laneId}: stuckAt is the time of its history row (${burn.stuckAt})`);
    const clock = local(burn.stuckAt, tz, "time");
    const texts: string[] = (lane?.steps ?? []).flatMap((s: any) => [s.text, s.who]);
    const since = texts.flatMap(t => [...String(t).matchAll(/stuck since (\d{1,2}:\d{2})/gi)].map(m => (m[1] ?? "").padStart(5, "0")));
    ok(texts.some(t => String(t).includes(clock)) && since.every(t => t === clock), `S4 ${burn.laneId}: the step text names the same time, ${clock} (${short(since)})`);
  }
}

// R1 and E5 over every lane a module shows
async function madeAndLeads(module: Module, url: string, owner: string) {
  const own: string[] = [];
  const unresolved: string[] = [];
  const notRecord: string[] = [];
  const files: any[] = [];
  const leadWrong: string[] = [];
  let checked = 0;
  const topicLane = new Map<string, any>();
  for (const t of await topicIds(url)) for (const l of (await get(url, `/topics/${t}`)).body?.lanes ?? []) topicLane.set(l.id, l);
  const sidebarLane = new Map<string, any>();
  for (const l of (await get(url, "/sidebar")).body?.managerLanes ?? []) sidebarLane.set(l.id, l);
  for (const id of await laneIds(url)) {
    const lane = await view("R1", url, `/lanes/${id}`, "LaneView");
    for (const item of lane?.made ?? []) {
      if (!item.target) continue;
      checked++;
      if (item.target.kind === "lane" && item.target.id === id) own.push(`${id}/${item.title}`);
      else if (!(await resolves(url, item.target))) unresolved.push(`${id} → ${item.target.kind}:${item.target.id}`);
      if (item.target.kind === "file") files.push(item.target);
      // R1: a made file or image opens its record; a made mail opens its draft
      const record = ["file", "run", "review", "report", "check"];
      if ((item.icon === "file" || item.icon === "image") && !record.includes(item.target.kind)) notRecord.push(`${id}/${item.title} → ${item.target.kind}`);
      // the mockup links a made mail to the Drafts page (#drafts); a single draft listed there is fine too
      if (item.icon === "mail" && !(item.target.kind === "drafts" || (item.target.kind === "draft" && typeof item.target.id === "string"))) notRecord.push(`${id}/${item.title} → ${item.target.kind}:${item.target.id}`);
    }
    const expected = topicLane.get(id)?.leadName ?? sidebarLane.get(id)?.leadName;
    const lead = lane?.lead;
    const rule = lead?.id === owner ? "You" : lead?.kind === "person" ? lead?.shortName : lead?.name;
    if (lane && !(lane.leadName === expected && lane.leadName === rule)) leadWrong.push(`${id}: ${lane.leadName} (topic ${expected}, rule ${rule})`);
  }
  ok(checked > 0 && own.length === 0, `R1 ${module}: no "What it made" item targets its own lane (${own.length} do: ${own.slice(0, 3).join("; ")})`);
  ok(checked > 0 && unresolved.length === 0, `R1 ${module}: every "What it made" target resolves (${unresolved.length} do not: ${unresolved.slice(0, 3).join("; ")})`);
  ok(checked > 0 && notRecord.length === 0, `R1 ${module}: made files and images open their record, made mail the Drafts page or its draft (${notRecord.length} do not: ${notRecord.slice(0, 3).join("; ")})`);
  if (module === "gtm") {
    ok(files.length > 0, "R1 gtm: made files point at file records");
    let bad = 0;
    for (const f of files) {
      const r = await get(url, `/records/${f.id}`);
      if (!(r.status === 200 && r.body?.kind === "file" && typeof r.body?.url === "string" && r.body.url.length > 0)) bad++;
    }
    ok(files.length > 0 && bad === 0, `R1 gtm: every file record carries a url (${bad} of ${files.length} do not)`);
  }
  ok(leadWrong.length === 0, `E5 ${module}: LaneView.leadName follows the TopicLane rule (${leadWrong.slice(0, 3).join("; ")})`);
}

// ---- dev, read-only
async function devReads(url: string) {
  const w = await get(url, "/workspace");
  ok(w.headers.get("cockpit-contract") === VERSION && w.body?.contractVersion === VERSION, `P1 the dev workspace names contract ${VERSION}`);
  const owner: string = w.body?.me?.id;
  const brief = await view("E4", url, "/brief", "BriefView");
  const settings = await view("E4", url, "/settings", "SettingsView");
  ok(brief?.edition && brief.edition.of === settings?.briefsPerDay && brief.edition.used >= 1 && brief.edition.used <= brief.edition.of,
    `E4 dev brief edition is n of briefsPerDay (got ${short(brief?.edition)})`);
  const skills = await view("E2", url, "/skills", "SkillsView");
  const conns: any[] = skills?.connections ?? [];
  ok(conns.length > 0 && conns.every(c => SCOPES.includes(c.scope)), `E2 every dev connection has a scope (${short(conns.map(c => [c.id, c.scope]))})`);

  // R2 the stuck run as a record; R4 tries
  const web = await view("R2", url, "/topics/web", "TopicView");
  const stuck = web?.stuck;
  const runId = stuck?.runId;
  const openRun = (stuck?.actions ?? []).find((a: any) => a.id === "open-the-run" || /open the run/i.test(a.label ?? ""));
  ok(typeof runId === "string" && openRun?.target?.kind === "run" && openRun.target.id === runId, `R2 the stuck report's "Open the run" targets its run (${short(openRun?.target)}, runId ${runId})`);
  const run = typeof runId === "string" ? await view("R2", url, `/records/${runId}`, "MadeRecordView") : undefined;
  ok(run?.kind === "run" && run?.laneId === openRun?.laneId && isTime(run?.startedAt) && run?.state !== null && run?.state !== undefined,
    `R2 the run record names its lane, start and state (${short(run && { kind: run.kind, laneId: run.laneId, startedAt: run.startedAt, state: run.state })})`);
  ok((run?.checks ?? []).some((c: any) => c.passed === false) && run?.log !== null && run?.log !== undefined, "R2 the run record carries its checks and the failing test");
  const tries = stuck?.tries;
  ok(tries?.kind === "count" && tries.value === 3 && tries.of === 3, `R4 the stuck report counts 3 of 3 tries (${short(tries)})`);
  const laneTries = (await get(url, "/lanes/red-main")).body?.tries;
  ok(laneTries?.kind === "count" && laneTries.value === 3 && laneTries.of === 3, `R4 the red-main lane counts 3 of 3 tries (${short(laneTries)})`);
  ok((skills?.guardrails ?? []).some((g: any) => g.limit?.kind === "count" && g.limit.value === tries?.of), "R4 a guardrail switch carries the tries limit");

  // R3 gates
  const pulls = await view("R3", url, "/pulls", "PullsView");
  const gates: any[] = (pulls?.items ?? []).flatMap((p: any) => p.gates ?? []);
  ok(gates.some(g => Number.isInteger(g.round)), "R3 a review gate carries its round");
  ok(gates.some(g => g.reviewer && typeof g.reviewer.id === "string"), "R3 a review gate names its reviewer");

  // L6 switches carry ids, and guardrail.set takes the id
  const switches: any[] = skills?.guardrails ?? [];
  ok(switches.length > 0 && switches.every(s => typeof s.id === "string"), "L6 every dev guardrail switch has an id");
  const sw = switches.find(s => s.on === true && typeof s.id === "string");
  if (sw) {
    const r = await act(url, { type: "guardrail.set", id: sw.id, name: sw.name, on: false });
    ok(r.status === 200 && by((await get(url, "/skills")).body?.guardrails, "id", sw.id)?.on === false, "L6 guardrail.set with an id switches that guardrail");
    ok((await act(url, { type: "guardrail.set", name: sw.name, on: true })).status === 200, "L6 guardrail.set still accepts the name");
  } else ok(false, "L6 a dev guardrail switch with an id to set");

  await madeAndLeads("dev", url, owner);
}

// ---- overnight rows: outcomes and the undo window (R6, R7)
// The stand-in's clock runs from the demo time at real speed and cannot be moved, so "undo after undoUntilAt" is driven
// by the fixture row whose window has already passed (R7: exactly one in gtm, none in dev).
async function overnight(module: Module, url: string) {
  const w = (await get(url, "/workspace")).body;
  const tz: string = w?.timezone ?? "Europe/Berlin";
  const feed = openFeed(url);
  await feed.opened;
  const first = (await get(url, "/sidebar")).body?.groups?.[0]?.id;
  await act(url, { type: "topic.seen", topicId: first });
  await pause(300);
  feed.ws.close();
  const now: string | undefined = feed.frames.at(-1)?.at;
  ok(isTime(now), `R7 ${module}: the feed tells the stand-in's time`);
  const rows: any[] = (await get(url, "/brief")).body?.overnight ?? [];
  ok(rows.length > 0 && rows.every(r => r.outcome && OUTCOME_KINDS.includes(r.outcome.kind)), `R6 ${module}: every overnight row has an outcome (${short(rows.map(r => r.outcome?.kind ?? null))})`);
  const undoable = rows.filter(r => r.undoable);
  ok(undoable.length > 0 && undoable.every(r => isTime(r.undoUntilAt)), `R7 ${module}: every undoable overnight row has undoUntilAt (${short(undoable.map(r => r.undoUntilAt))})`);
  const expired = undoable.filter(r => isTime(r.undoUntilAt) && now !== undefined && Date.parse(r.undoUntilAt) <= Date.parse(now));
  const tonight = (u: string) => now !== undefined && Date.parse(u) > Date.parse(now)
    && local(new Date(Date.parse(u) - 1).toISOString(), tz, "date") === local(now, tz, "date");
  const open = undoable.filter(r => !expired.includes(r));
  ok(expired.length === (module === "gtm" ? 1 : 0), `R7 ${module}: ${module === "gtm" ? "exactly one overnight row's" : "no overnight row's"} undo window has passed (${short(expired.map(r => r.id))})`);
  ok(open.length > 0 && open.every(r => tonight(r.undoUntilAt)), `R7 ${module}: every other undoable overnight row can be undone until tonight, after the clock (${short(open.map(r => r.undoUntilAt))}, now ${now})`);
  for (const r of expired) ok((await act(url, { type: "agentAction.undo", actionId: r.id })).status === 409, `R7 ${module}: undo after undoUntilAt (${r.id}) is 409`);
  const sent = rows.filter(r => r.outcome?.sentOutside === true);
  if (module === "gtm") ok(sent.length >= 1, "R7 gtm: an overnight row was sent outside");
  for (const r of sent) ok((await act(url, { type: "agentAction.undo", actionId: r.id })).status === 409, `R7 ${module}: undo of an overnight row sent outside (${r.id}) is 409`);
}

// ---- goal changes (G1-G5): one fresh instance per kind
async function goalChange(url: string, kind: "budget" | "priority" | "guardrail" | "deadline", topicId: string, text: string) {
  const topicsBefore: Record<string, any> = {};
  for (const id of await topicIds(url)) topicsBefore[id] = (await get(url, `/topics/${id}`)).body;
  const before = topicsBefore[topicId];
  const topicName: string = before?.name ?? topicId;
  const sent = await act(url, { type: "message.send", threadId: `topic:${topicId}`, text });
  ok(sent.status === 200 && sent.body?.message?.label?.kind === "goalChange", `G3 "${text}" is labelled a goal change (got ${sent.status} ${sent.body?.message?.label?.kind})`);
  ok(sent.status === 200 && !sent.body?.laneId && !hasEvent(sent, "lane.filed"), `G3 "${text}" files no lane`);
  const decisionId = sent.body?.message?.decisionId
    ?? ((await get(url, "/decisions")).body?.items ?? []).filter((d: any) => d.goalChange?.topicId === topicId && d.state === "open").at(-1)?.id;
  const decision = decisionId ? await view("G2", url, `/decisions/${decisionId}`, "DecisionView") : undefined;
  const gc = decision?.goalChange;
  ok(gc?.topicId === topicId && gc?.field === kind, `G1 "${text}" becomes a ${kind} goal change (got ${gc?.field})`);
  ok(Array.isArray(gc?.affectedTopics) && !gc.affectedTopics.includes(topicId) && gc.affectedTopics.every((id: string) => id in topicsBefore),
    `G3 the ${kind} change lists other topics it affects, never its own (${short(gc?.affectedTopics)})`);
  if (kind === "deadline") ok((gc?.affectedTopics ?? []).includes("paid"), `G3 the Partnerships deadline change lists Paid among the affected topics (${short(gc?.affectedTopics)})`);
  // G5 proposer on the decision, the queue item and the brief card
  const queueItem = by((await get(url, "/decisions")).body?.items, "id", decisionId);
  const briefItem = by((await get(url, "/brief")).body?.decisions, "id", decisionId);
  const expected = `${topicName} manager`;
  ok([decision, queueItem, briefItem].every(x => x?.proposer?.name === expected),
    `G5 the ${kind} change is proposed by the ${expected} on the decision, the queue and the brief (${short([decision?.proposer?.name, queueItem?.proposer?.name, briefItem?.proposer?.name])})`);

  let apply: (() => Promise<void>) | undefined;
  if (kind === "budget") {
    const b = gc?.budget;
    ok(b && same(b.from, before?.spend?.cap) && same(b.to, { amountMinor: 800000, currency: "EUR" })
      && gc.from === b.from.amountMinor && gc.to === 800000, `G2 the budget change carries money from the current cap to the new one (${short(b)}, from ${gc?.from} to ${gc?.to})`);
    apply = async () => {
      const after = (await get(url, `/topics/${topicId}`)).body;
      ok(b && same(after?.spend?.cap, b.to), `G4 approving the budget change sets spend.cap (${short(after?.spend?.cap)})`);
    };
  } else if (kind === "priority") {
    const p = gc?.priority;
    ok(p && p.to === 1 && gc.to === 1 && same(p.from, before?.meta?.priority ?? null) && (p.from === null || gc.from === p.from),
      `G2 the priority change ranks ${topicName} first (${short(p)}, from ${gc?.from} to ${gc?.to})`);
    apply = async () => {
      const after = (await get(url, `/topics/${topicId}`)).body;
      ok(after?.meta?.priority === 1, `G4 approving the priority change ranks ${topicName} first (got ${after?.meta?.priority})`);
      const others: any[] = [];
      for (const id of Object.keys(topicsBefore)) if (id !== topicId) others.push((await get(url, `/topics/${id}`)).body?.meta?.priority);
      ok(others.every(r => r !== 1), `G4 no other topic keeps rank 1 (${short(others)})`);
    };
  } else if (kind === "guardrail") {
    const g = gc?.guardrail;
    const item = (before?.goal?.guardrails?.items ?? []).find((x: any) => /cost per lead/i.test(x.what));
    ok(g && typeof item?.id === "string" && g.guardrailId === item.id && String(g.name).toLowerCase() === String(item.what).toLowerCase()
      && same(g.from, item.limit) && g.to?.kind === "money" && same(g.to.money, { amountMinor: 5000, currency: "EUR" })
      && gc.from === numberOf(g.from) && gc.to === 5000,
      `G2 the guardrail change names the cost-per-lead guardrail and its old and new limits (${short(g)}, from ${gc?.from} to ${gc?.to})`);
    apply = async () => {
      const after = ((await get(url, `/topics/${topicId}`)).body?.goal?.guardrails?.items ?? []).find((x: any) => x.id === item?.id);
      ok(g && same(after?.limit, g.to), `G4 approving the guardrail change sets that guardrail's limit (${short(after?.limit)})`);
      // the cost per lead (€114) stays above the new €50 limit
      ok(after?.state === "breached" && numberOf(after?.value) !== undefined && (numberOf(after?.value) ?? 0) > 5000,
        `G4 the guardrail's state follows its new limit (${after?.state}, ${numberOf(after?.value)} against ${numberOf(after?.limit)})`);
    };
  } else {
    ok(gc && isTime(before?.goal?.deadlineAt) && Date.parse(gc.previousDeadlineAt) === Date.parse(before.goal.deadlineAt),
      `G3 the deadline change keeps the goal's deadline as previousDeadlineAt (${gc?.previousDeadlineAt})`);
    ok(gc && isTime(gc.deadlineAt) && local(gc.deadlineAt, "Europe/Berlin", "date").endsWith("-02-15"), `G3 the new deadline is 15 February (${gc?.deadlineAt})`);
    apply = async () => {
      const after = (await get(url, `/topics/${topicId}`)).body;
      ok(gc && Date.parse(after?.goal?.deadlineAt) === Date.parse(gc.deadlineAt), `G4 approving the deadline change moves the deadline (${after?.goal?.deadlineAt})`);
    };
  }
  const approved = decisionId ? await act(url, { type: "decision.approve", decisionId }) : undefined;
  ok(approved?.status === 200, `G4 the ${kind} change can be approved (got ${approved?.status})`);
  const announced = approved ? [topicId, ...(gc?.affectedTopics ?? [])].every(id => hasEvent(approved, "topic.changed", { topicId: id })) : false;
  ok(announced, `G4 approving the ${kind} change announces topic.changed for the topic and every affected topic`);
  await apply();
  const target = (await get(url, `/topics/${topicId}`)).body?.goal?.target;
  ok(target === before?.goal?.target, `G4 the ${kind} change leaves goal.target untouched (${before?.goal?.target} → ${target})`);
}

// ---- the plan's other behaviours, each on a fresh stand-in
async function run() {
  await scenario("P1 gtm reads", "gtm", gtmReads);
  await scenario("P1 dev reads", "dev", devReads);
  await scenario("R6 gtm overnight", "gtm", url => overnight("gtm", url));
  await scenario("R6 dev overnight", "dev", url => overnight("dev", url));
  await scenario("G2 budget", "gtm", url => goalChange(url, "budget", "paid", BUDGET_ASK));
  await scenario("G2 priority", "gtm", url => goalChange(url, "priority", "partnerships", PRIORITY_ASK));
  await scenario("G2 guardrail", "gtm", url => goalChange(url, "guardrail", "paid", GUARDRAIL_ASK));
  await scenario("G3 deadline", "gtm", url => goalChange(url, "deadline", "partnerships", DEADLINE_ASK));

  await scenario("R4 one more try", "dev", async url => {
    const before = (await get(url, "/lanes/red-main")).body?.tries;
    const r = await act(url, { type: "lane.act", laneId: "red-main", act: "allow-one-more-try" });
    ok(r.status === 200, `R4 "Allow one more try" is accepted (got ${r.status})`);
    const after = (await get(url, "/lanes/red-main")).body?.tries;
    ok(before?.of === 3 && after?.kind === "count" && after.of === 4, `R4 "Allow one more try" raises the lane's tries.of from 3 to 4 (${short(before)} → ${short(after)})`);
  });

  await scenario("R5 approve d2", "dev", async url => {
    const r = await act(url, { type: "decision.approve", decisionId: "d2" });
    ok(r.status === 200, `R5 d2 can be approved (got ${r.status})`);
    const lane = await view("R5", url, "/lanes/tax-rates", "LaneView");
    const steps: any[] = lane?.steps ?? [];
    // the backup step is the first that names a backup; the migration step is the last other step that names the migration
    const backup = steps.findIndex(s => /back(ed|ing)?[ -]?up/i.test(s.text));
    const migration = steps.reduce((last: number, s: any, i: number) => (i !== backup && /migrat/i.test(s.text) ? i : last), -1);
    ok(backup >= 0 && migration > backup, `R5 after approving d2 the lane backs up before the migration (${short(steps.map(s => s.text))})`);
    const tz = (await get(url, "/workspace")).body?.timezone ?? "Europe/Berlin";
    ok(typeof lane?.next === "string" && lane.next.length > 0 && isTime(lane?.nextAt) && local(lane.nextAt, tz, "time") === "23:00",
      `R5 after approving d2 the lane's next is the 23:00 run (next ${short(lane?.next)}, nextAt ${lane?.nextAt})`);
  });

  await scenario("R8 server capacity", "dev", async url => {
    const busy = async () => ((await get(url, "/skills")).body?.connections ?? []).find((c: any) => c.capacity?.kind === "count" && /busy/i.test(c.capacity?.unit ?? ""))?.capacity;
    const before = await busy();
    const r = await act(url, { type: "lane.file", text: DEV_ASK, topicId: "api" });
    const after = await busy();
    ok(r.status === 200 && hasEvent(r, "skills.changed"), "R8 filing a dev lane emits skills.changed");
    ok(typeof before?.value === "number" && after?.value === before.value + 1, `R8 filing a dev lane raises the busy count (${before?.value} → ${after?.value})`);
  });

  await scenario("L4 split", "gtm", async url => {
    const r = await act(url, { type: "lane.file", text: SPLIT_ASK });
    const group: string[] = r.body?.receipt?.groupLaneIds ?? [];
    ok(r.status === 200 && group.length === 2 && group.includes(r.body?.receipt?.laneId), `L4 an ask with two parts files two lanes and the receipt lists both (${short(group)})`);
    const lanes = await Promise.all(group.map(async id => (await get(url, `/lanes/${id}`)).body));
    const groupId = lanes[0]?.groupId;
    ok(typeof groupId === "string" && lanes.every(l => l?.groupId === groupId), `L4 both lanes share one group id (${short(lanes.map(l => l?.groupId))})`);
    const filed = events(r).filter(e => e.type === "lane.filed");
    ok(filed.length === 2 && filed.every(e => e.groupId === groupId), `L4 each lane.filed carries the group id (${short(filed.map(e => e.groupId))})`);
  });

  await scenario("L8 forecast on a verdict change", "gtm", async url => {
    const before = (await get(url, "/topics/content")).body?.goal;
    const r = await act(url, { type: "lane.act", laneId: "webinar", act: "post-passing" });
    const after = (await get(url, "/topics/content")).body?.goal;
    const added = (after?.forecastLog ?? []).length - (before?.forecastLog ?? []).length;
    ok(r.status === 200 && before?.verdict?.word !== after?.verdict?.word && added === 1 && isTime(after?.forecastLog?.at(-1)?.givenAt),
      `L8 a verdict change (${before?.verdict?.word} → ${after?.verdict?.word}) appends one forecast (${added})`);
  });

  await scenario("E1 members", "gtm", async url => {
    const owner = (await get(url, "/workspace")).body?.me?.id;
    const members = await view("E1", url, "/members", "MembersView");
    const owners = (members?.items ?? []).filter((m: any) => m.owner);
    ok(owners.length === 1 && owners[0]?.person?.id === owner, "E1 /members names the one owner");
    for (const p of ["lea-brandt", "jonas-falk", "tom-ahrens"]) ok((await get(url, `/members?as=${p}`)).status === 403, `E1 /members is 403 for ${p}`);
    // an existing member: a message, and nothing changes
    const jonas = (members?.items ?? []).find((m: any) => m.person?.id === "jonas-falk")?.person?.name;
    const snapshot = async () => [(await get(url, "/members")).body, (await get(url, "/topics/content/access")).body];
    const before = await snapshot();
    const again = await act(url, { type: "access.invite", topicId: "content", nameOrEmail: jonas ?? "Jonas Falk" });
    ok(again.status === 200 && again.body?.message, `E1 inviting an existing member answers with a message (${again.status})`);
    ok(same(await snapshot(), before), "E1 inviting an existing member changes nothing");
    // a new invitation
    const invited = await act(url, { type: "access.invite", topicId: "partnerships", nameOrEmail: "sam@example.test" });
    ok(invited.status === 200, "E1 a new person can be invited");
    const inv = ((await get(url, "/members")).body?.invitations ?? []).find((i: any) => i.nameOrEmail === "sam@example.test");
    ok(inv?.topicId === "partnerships" && inv?.invitedBy?.id === owner && inv?.acceptedAt === null, `E1 the invitation names its topic and who invited, not yet accepted (${short(inv)})`);
    const ids = new Set<string>(((await get(url, "/members")).body?.items ?? []).map((m: any) => m.person?.id));
    const missing: string[] = [];
    for (const t of await topicIds(url)) {
      const people = new Set(((await get(url, `/topics/${t}/access`)).body?.people ?? []).map((p: any) => p.person?.id));
      for (const id of [...ids, inv?.personId]) if (!people.has(id)) missing.push(`${t}:${id}`);
    }
    ok(ids.size > 0 && inv && missing.length === 0, `E1 every topic's access lists every active or invited member (${missing.slice(0, 4).join(", ")})`);
    if (inv) {
      await act(url, { type: "access.accept", invitationId: inv.id }, inv.personId);
      const accepted = ((await get(url, "/members")).body?.invitations ?? []).find((i: any) => i.id === inv.id);
      ok(isTime(accepted?.acceptedAt), `E1 an accepted invitation has acceptedAt (${accepted?.acceptedAt})`);
    }
  });

  await scenario("E3 skill run", "gtm", async url => {
    const skill = by((await get(url, "/skills")).body?.skills, "enabled", true);
    const r = await act(url, { type: "skill.run", skill: skill?.id });
    ok(r.status === 200, `E3 skill.run without text runs the skill's default ask (got ${r.status})`);
  });

  await scenario("E6 addressee", "gtm", async url => {
    const owned = await threadMessages(url, "topic:partnerships");
    const toLea = owned.filter(m => m.addressee === "lea-brandt");
    ok(toLea.length > 0, "E6 a message written to Lea, who runs Outreach, names her as addressee");
    await act(url, { type: "stage.assign", topicId: "partnerships", stage: "Outreach", personId: "tom-ahrens" });
    const tom = await threadMessages(url, "topic:partnerships", "tom-ahrens");
    ok(toLea.length > 0 && toLea.every(m => by(tom, "id", m.id)?.addressee === "lea-brandt"), "E6 the new holder of Outreach sees those messages addressed to Lea");
  });

  await scenario("S1 health without a goal", "gtm", async url => {
    const before = (await get(url, "/topics/research")).body?.health;
    ok(before?.word === "Idle", `S1 research, with no goal and no open lane, reads Idle (got ${short(before)})`);
    await act(url, { type: "lane.file", text: RESEARCH_ASK, topicId: "research" });
    const after = (await get(url, "/topics/research")).body?.health;
    ok(after?.word === "On track", `S1 research reads On track once a lane is open (got ${short(after)})`);
  });

  await scenario("S2 fixture history row", "gtm", async url => {
    const rows: { topicId: string; id: string; decisionId: string }[] = [];
    const dir = join(FIXTURES, "gtm", "topics");
    for (const f of readdirSync(dir).filter(f => f.endsWith(".json") && !f.endsWith(".access.json"))) {
      const t = JSON.parse(readFileSync(join(dir, f), "utf8"));
      for (const d of t.history?.days ?? []) for (const e of d.entries ?? []) if (e.kind === "event" && e.decisionId) rows.push({ topicId: t.id, id: e.id, decisionId: e.decisionId });
    }
    ok(rows.length > 0, "S2 a gtm fixture history row records an approval by decisionId");
    for (const row of rows) {
      const r = await act(url, { type: "decision.approve", decisionId: row.decisionId });
      const shown = (await historyRows(url, row.topicId)).filter(e => e.decisionId === row.decisionId);
      ok(r.status === 200 && shown.length === 1 && shown[0]?.id === row.id && shown[0]?.undoable === true && shown[0]?.undone === false,
        `S2 approving ${row.decisionId} shows the fixture row ${row.id} with Undo, not a generated one (${short(shown.map(e => [e.id, e.undoable]))})`);
    }
  });

  await scenario("S3 suggestions", "gtm", async url => {
    const owner = (await get(url, "/workspace")).body?.me?.id;
    const threads = ["manager", "general", ...(await topicIds(url)).map(t => `topic:${t}`)];
    const bad: string[] = [];
    let sent = 0;
    for (const t of threads) for (const s of (await get(url, `/threads/${t}`)).body?.suggestions ?? []) {
      sent++;
      const r = await act(url, { type: "message.send", threadId: t, text: s });
      const answered = events(r).some(e => e.type === "message.posted" && e.message?.author?.id !== owner);
      if (!(r.status === 200 && !r.body?.laneId && !hasEvent(r, "lane.filed") && answered)) bad.push(`${t}: ${s} → ${r.status} lane ${r.body?.laneId}`);
    }
    ok(sent > 0 && bad.length === 0, `S3 a suggestion sent as written is answered and files no lane (${bad.slice(0, 3).join("; ")})`);
  });

  await scenario("S5 since lines", "gtm", async url => {
    const lines = async (): Promise<string[]> => (await get(url, "/threads/manager")).body?.since?.lines ?? [];
    const before = await lines();
    const promo = (l: string) => /promo/i.test(l) && /stuck/i.test(l);
    const settled = await act(url, { type: "lane.act", laneId: "webinar", act: "post-passing" });
    const afterSettle = await lines();
    ok(before.some(promo) && !afterSettle.some(promo) && hasEvent(settled, "thread.changed", { threadId: "manager" }),
      `S5 the settled promo drops out of the Manager's since lines, with thread.changed manager (${short(afterSettle)})`);
    const proposed = await act(url, { type: "message.send", threadId: "topic:partnerships", text: DEADLINE_ASK });
    const afterGoal = await lines();
    ok(afterGoal.some(l => !afterSettle.includes(l) && /Partnerships/.test(l) && /(goal|deadline)/i.test(l)) && hasEvent(proposed, "thread.changed", { threadId: "manager" }),
      `S5 an open goal change is named in the since lines, with thread.changed manager (${short(afterGoal)})`);
  });

  await scenario("S6 attach by time", "gtm", async url => {
    const topic = (await get(url, "/threads/topic:partnerships?limit=100")).body;
    const decisionId = topic?.pinned?.decisionId;
    const threadId = `decision:${decisionId}`;
    const attached: any[] = (await get(url, `/threads/${threadId}?limit=100`)).body?.messages ?? [];
    const firstAt = Math.min(...attached.map(m => Date.parse(m.at)));
    const candidate = (topic?.messages ?? []).filter((m: any) => !m.decisionId && m.label?.kind !== "decision" && Date.parse(m.at) < firstAt).at(-1);
    ok(decisionId && attached.length > 0 && candidate, "S6 a topic message earlier than the decision thread can be attached to it");
    if (candidate) {
      const r = await act(url, { type: "message.relabel", messageId: candidate.id, label: "decision" });
      const after: any[] = (await get(url, `/threads/${threadId}?limit=100`)).body?.messages ?? [];
      ok(r.status === 200 && by(after, "id", candidate.id) && after.every((m, i) => i === 0 || Date.parse(after[i - 1].at) <= Date.parse(m.at)),
        `S6 the attached message is inserted by time (${short(after.map(m => m.at))})`);
    }
  });

  // S7, audit row 24 (R-1): tom-ahrens sees Partnerships as status only; work moves in the Outreach stage, which he cannot see.
  // Two moves: the owner reminds Lea on the Outreach lane outreach-wave-2 (person.remind), then Lea sends wave 2 on it
  // (lane.act send-wave-2 as lea-brandt). The owner's projection changes each time; Tom's does not.
  await scenario("S7 feed routing", "gtm", async url => {
    const tom = openFeed(url, "tom-ahrens");
    const owner = openFeed(url);
    await Promise.all([tom.opened, owner.opened]);
    const moves: [string, () => Promise<{ status: number }>][] = [
      ["the owner reminds Lea on outreach-wave-2", () => act(url, { type: "person.remind", laneId: "outreach-wave-2", personId: "lea-brandt" })],
      ["Lea sends wave 2 on outreach-wave-2", () => act(url, { type: "lane.act", laneId: "outreach-wave-2", act: "send-wave-2" }, "lea-brandt")],
    ];
    for (const [what, move] of moves) {
      const tomFrom = tom.frames.length;
      const ownerFrom = owner.frames.length;
      const r = await move();
      await pause(400);
      const ownerHeard = owner.frames.slice(ownerFrom).some(f => f.type === "topic.changed" && f.topicId === "partnerships");
      ok(r.status === 200 && ownerHeard, `S7 ${what}: the owner, whose view changed, gets topic.changed partnerships (${r.status})`);
      const leaked = tom.frames.slice(tomFrom).filter(f => (f.type === "topic.changed" && f.topicId === "partnerships") || (f.type === "thread.changed" && f.threadId === "topic:partnerships"));
      ok(leaked.length === 0, `S7 ${what}: tom-ahrens (status only) gets no topic.changed or thread.changed for it (${short(leaked.map(f => f.type))})`);
    }
    tom.ws.close();
    owner.ws.close();
    for (const f of [...tom.frames, ...owner.frames].slice(0, 40)) valid("FeedEvent", f, `S7 feed frame ${f?.type}`);
  });
}

// ---- invariants: rules that hold for any input, not for the sentences above. The inputs are drawn per run; the seed is
// printed on a failure and --seed N repeats it.
const seedArg = process.argv.indexOf("--seed");
const SEED = seedArg > 0 ? Number(process.argv[seedArg + 1]) : Math.floor(Math.random() * 1e9);
let seedState = SEED;
function rand(min: number, max: number): number {
  seedState = (seedState * 1664525 + 1013904223) % 4294967296;
  return min + Math.floor((seedState / 4294967296) * (max - min + 1));
}
const pick = <T>(list: T[]): T => list[rand(0, list.length - 1)] as T;
const PEOPLE = ["lea-brandt", "jonas-falk", "tom-ahrens"];
const getAs = (url: string, path: string, as?: string) => get(url, path + asOf(as));

// E7, L2: a person reads a report only while they can read its topic, and no view names a report they cannot open
async function reportAccess(url: string, when: string) {
  const reports: { topicId: string; id: string }[] = [];
  for (const t of await topicIds(url)) {
    const id = (await get(url, `/topics/${t}`)).body?.meta?.nextReportId;
    if (id) reports.push({ topicId: t, id });
  }
  ok(reports.length >= 1, `E7 ${when}: the topics name their next reports (${reports.length})`);
  const leaks: string[] = [];
  for (const p of PEOPLE) {
    for (const r of reports) {
      const [topic, report] = [(await getAs(url, `/topics/${r.topicId}`, p)).status, (await getAs(url, `/reports/${r.id}`, p)).status];
      if (report === 200 && topic !== 200) leaks.push(`${p} reads ${r.id} without ${r.topicId}`);
    }
    for (const t of await topicIds(url)) {
      const body = (await getAs(url, `/topics/${t}`, p)).body;
      const named = new Set<string>();
      walk(body, t, (k, v) => { if (/reportId$/i.test(k) && typeof v === "string") named.add(v); });
      for (const id of named) if ((await getAs(url, `/reports/${id}`, p)).status !== 200) leaks.push(`${p} sees ${id} on ${t} and cannot open it`);
    }
  }
  ok(leaks.length === 0, `E7 ${when}: reports follow the access to their topic (${leaks.slice(0, 4).join("; ")})`);
}

// G4: whoever's topic view changed by an action hears topic.changed for it, and only then does it change silently nowhere
async function framesMatchViews(url: string, what: string, move: () => Promise<{ status: number; body: any }>) {
  const viewers = [undefined, ...PEOPLE];
  const feeds = viewers.map(v => openFeed(url, v));
  await Promise.all(feeds.map(f => f.opened));
  const ids = await topicIds(url);
  const read = async () => Promise.all(viewers.map(async v => Promise.all(ids.map(async id => {
    const r = await getAs(url, `/topics/${id}`, v);
    return r.status === 200 ? r.body : null;
  }))));
  const before = await read();
  const from = feeds.map(f => f.frames.length);
  const r = await move();
  await pause(400);
  const after = await read();
  const silent: string[] = [];
  viewers.forEach((v, i) => ids.forEach((id, j) => {
    const changed = !same(before[i]?.[j], after[i]?.[j]);
    const heard = feeds[i]!.frames.slice(from[i]).some(f => f.type === "topic.changed" && f.topicId === id);
    if (changed && !heard) silent.push(`${v ?? "owner"} ${id}`);
  }));
  feeds.forEach(f => f.ws.close());
  ok(r.status === 200 && silent.length === 0, `G4 ${what}: every viewer whose topic changed hears it (${r.status}; silent: ${silent.slice(0, 6).join(", ")})`);
}
const decisionOf = (r: { body: any }): string | undefined => r.body?.message?.decisionId ?? undefined;

async function invariants() {
  await scenario("E7 report access", "gtm", async url => {
    await reportAccess(url, "as it starts");
    for (const t of await topicIds(url)) {
      const r = await act(url, { type: "access.set", topicId: t, personId: "tom-ahrens", access: { kind: "none", stages: [] } });
      ok(r.status === 200 && (await getAs(url, `/topics/${t}`, "tom-ahrens")).status === 403, `E7 Tom's access to ${t} can be set to none (${r.status})`);
    }
    await reportAccess(url, "after Tom's access is set to none");
    const recipients: string[] = [];
    for (const t of await topicIds(url)) {
      const id = (await get(url, `/topics/${t}`)).body?.meta?.nextReportId;
      if (id && (await getAs(url, `/reports/${id}`, "tom-ahrens")).status === 200) recipients.push(id);
    }
    ok(recipients.length === 0, `E7 without access to any topic, Tom reads no report (${recipients.join(", ")})`);
  });

  // L2, L1: the mockup reports Partnerships to Tom; the other topics are asked by the owner, who gets their reports
  await scenario("L2 report recipients and schedules", "gtm", async url => {
    const owner = (await get(url, "/workspace")).body?.me?.id;
    const schedules: any[] = (await get(url, "/manager")).body?.schedules ?? [];
    for (const t of await topicIds(url)) {
      const id = (await get(url, `/topics/${t}`)).body?.meta?.nextReportId;
      if (!id) continue;
      const report = (await get(url, `/reports/${id}`)).body;
      const to = (report?.recipients ?? []).map((a: any) => String(a.id)).sort((x: string, y: string) => x.localeCompare(y));
      const expected = t === "partnerships" ? ["tom-ahrens"] : [owner];
      ok(same(to, expected), `L2 ${t}'s report goes to ${expected.join(", ")} (${short(to)})`);
      const s = by(schedules, "id", report?.scheduleId);
      ok(s?.kind === "report" && s?.topicId === t && s?.nextAt && Date.parse(s.nextAt) === Date.parse(report?.dueAt),
        `L1 ${id} comes from a report schedule of its topic that fires when it is due (${short([report?.scheduleId, s?.nextAt, report?.dueAt])})`);
    }
    // a schedule of kind check that has run has its record
    for (const s of schedules.filter(x => x.kind === "check" && x.lastAt)) {
      const rows = (await Promise.all((await topicIds(url)).map(t => historyRows(url, t)))).flat().filter((e: any) => e.checkId);
      const checks = await Promise.all([...new Set(rows.map((e: any) => e.checkId))].map(async id => (await get(url, `/checks/${id}`)).body));
      ok(checks.some(c => c?.scheduleId === s.id && Date.parse(c.at) === Date.parse(s.lastAt)), `L3 the ${s.title}, which last ran ${s.lastAt}, has its check on a history row`);
    }
  });

  // L1: as many brief schedules as briefs a day, the next of them is the next brief, and the count follows the setting
  for (const module of ["gtm", "dev"] as Module[]) await scenario("L1 brief schedules", module, async url => {
    const briefs = async () => (((await get(url, "/manager")).body?.schedules ?? []) as any[]).filter(s => s.kind === "brief" && s.on);
    const [list, brief] = [await briefs(), (await get(url, "/brief")).body];
    ok(list.length === brief?.edition?.of && new Set(list.map(s => s.time)).size === list.length, `L1 ${module}: one brief schedule per brief of the day (${short(list.map(s => s.time))} for ${brief?.edition?.of})`);
    ok(Math.min(...list.map(s => Date.parse(s.nextAt))) === Date.parse(brief?.nextBriefAt), `L1 ${module}: the next brief schedule is the next brief (${short(list.map(s => s.nextAt))})`);
    ok(list.every(s => local(s.nextAt, "Europe/Berlin", "time") === s.time), `L1 ${module}: each brief schedule fires at its own time (${short(list.map(s => [s.time, s.nextAt]))})`);
    const n = pick([1, 2]);
    await act(url, { type: "prefs.set", briefsPerDay: n });
    ok((await briefs()).length === n, `L1 ${module}: with ${n} briefs a day there are ${n} brief schedules (${(await briefs()).length})`);
  });

  // L5: what an agent decided today under a right is what the right says it used
  for (const module of ["gtm", "dev"] as Module[]) await scenario("L5 used today", module, async url => {
    const today = (await get(url, "/brief")).body?.at;
    const rows: any[] = (await get(url, "/brief")).body?.overnight ?? [];
    const rights: any[] = (await get(url, "/settings")).body?.decisionRights ?? [];
    for (const right of rights.filter(x => x.who !== "you")) {
      const used = rows.filter(o => o.rule === right.rule && local(o.at, "Europe/Berlin", "date") === local(today, "Europe/Berlin", "date")).length;
      ok(right.usedToday === used, `L5 ${module}: ${right.rule} says ${right.usedToday} used today, the overnight rows say ${used}`);
    }
  });

  // S1: a dev project reads as its lanes do (the dev mockup's sidebar words)
  await scenario("S1 dev project words", "dev", async url => {
    const word = async (id: string) => [(await get(url, `/topics/${id}`)).body?.health?.word, by((await get(url, "/sidebar")).body?.groups, "id", id)?.stateWord];
    for (const [id, expected] of [["web", "Stuck"], ["api", "Needs you"], ["billing", "Needs you"], ["mobile", "Working"], ["infra", "Idle"]] as const) {
      const got = await word(id);
      ok(got.every(w => w === expected), `S1 ${id} reads ${expected} in the topic and the sidebar (${short(got)})`);
    }
    await act(url, { type: "lane.file", text: `Rotate certificate number ${rand(10, 99)}`, topicId: "infra" });
    ok((await word("infra")).every(w => w === "Working"), `S1 infra reads Working once a lane is open (${short(await word("infra"))})`);
  });

  // R8: busy follows what the lanes show, and undoing what raised it lowers it again
  await scenario("R8 busy follows the lanes", "dev", async url => {
    const busy = async () => ((await get(url, "/skills")).body?.connections ?? []).find((c: any) => c.capacity?.kind === "count")?.capacity?.value;
    const start = await busy();
    const shown = async () => (await get(url, "/topics/billing")).body?.lanes?.find((l: any) => l.id === "tax-rates")?.state;
    await act(url, { type: "decision.approve", decisionId: "d2" });
    ok((await shown()) === "ok" ? (await busy()) === start + 1 : (await busy()) === start, `R8 approving d2 counts tax-rates as it shows (${await shown()}, ${start} → ${await busy()})`);
    const before = await busy();
    const filed = await act(url, { type: "lane.file", text: `Rename job number ${rand(10, 99)}`, topicId: "api" });
    const undone = await act(url, { type: "lane.undoFile", laneId: filed.body?.laneId ?? filed.body?.receipt?.laneId });
    ok(undone.status === 200 && hasEvent(undone, "skills.changed") && (await busy()) === before, `R8 undoing a filing lowers the busy count and emits skills.changed (${before} → ${await busy()})`);
  });

  // G3: the mockup's rule (v3.extra.html, classify): an ask that names a deadline, goal, target, budget, priority or
  // guardrail is a goal change. It never files a lane and the message is never lost, whatever its wording.
  await scenario("G3 no ask is lost", "gtm", async url => {
    const topics = ["paid", "outbound", "seo", "content", "partnerships"];
    const asks = [
      `Cut the SEO budget to EUR ${rand(2, 9)}00 per month`, `Tighten the weekly spend guardrail to €3,${rand(1, 5)}00`,
      `Our goal for SEO is now ${rand(3, 9)} pages`, `Budget for Partnerships: ${rand(50, 99)} euros a week please`,
      `Change the guardrail on bounces to ${rand(2, 3)} percent`, "Please prioritise Outbound over Paid",
      "Make sure the deadline page is readable", `The target should be something like ${rand(20, 90)}`,
      `Could the budget breathe a little`, `I worry about the guardrails on ${pick(["tone", "colour", "timing"])}`,
    ];
    for (const text of asks) {
      const topicId = pick(topics);
      const r = await act(url, { type: "message.send", threadId: `topic:${topicId}`, text });
      const kept = (await threadMessages(url, `topic:${topicId}`)).some((m: any) => JSON.stringify(m).includes(JSON.stringify(text).slice(1, -1)));
      ok(r.status === 200 && kept, `G3 "${text}" in ${topicId} is kept (${r.status})`);
      ok(r.status === 200 && r.body?.message?.label?.kind === "goalChange" && !r.body?.laneId && !hasEvent(r, "lane.filed"),
        `G3 "${text}" in ${topicId} is a goal change and files no lane (${r.status} ${r.body?.message?.label?.kind})`);
    }
  });

  // G1, G4: numbers drawn per run, approved, and read back
  const budget = rand(1100, 9900);
  await scenario("G4 budget in other words", "gtm", async url => {
    const text = pick([`Cut the SEO budget to EUR ${budget} per month`, `Bring the budget of SEO to €${budget} a month`]);
    const r = await act(url, { type: "message.send", threadId: "topic:seo", text });
    const id = decisionOf(r);
    const gc = id ? (await get(url, `/decisions/${id}`)).body?.goalChange : undefined;
    ok(gc?.field === "budget" && gc?.budget?.to?.amountMinor === budget * 100 && gc?.budget?.period === "month", `G1 "${text}" asks for ${budget} EUR a month (${short(gc?.budget)})`);
    await framesMatchViews(url, "approving a budget", () => act(url, { type: "decision.approve", decisionId: id }));
    ok((await get(url, "/topics/seo")).body?.spend?.cap?.amountMinor === budget * 100, "G4 the approved SEO budget is the cap");
    const asks: any[] = (await get(url, "/manager")).body?.asks ?? [];
    ok(asks.some(a => JSON.stringify(a).includes(text.slice(0, 20))), "G4 the approved ask stays among the Manager's asks from every chat");
  });
  await scenario("G4 priority to a rank", "gtm", async url => {
    const to = pick([2, 3]);
    const r = await act(url, { type: "message.send", threadId: "topic:paid", text: `Raise the priority of Paid to number ${to}` });
    const id = decisionOf(r);
    const gc = id ? (await get(url, `/decisions/${id}`)).body?.goalChange : undefined;
    ok(gc?.field === "priority" && gc?.priority?.to === to, `G1 "number ${to}" is the rank asked for (${short(gc?.priority)})`);
    await framesMatchViews(url, "approving a priority", () => act(url, { type: "decision.approve", decisionId: id }));
    const ranks = (await Promise.all((await topicIds(url)).map(async t => [t, (await get(url, `/topics/${t}`)).body?.meta?.priority] as const))).filter(x => x[1] !== null && x[1] !== undefined);
    ok(ranks.find(x => x[0] === "paid")?.[1] === to && same(ranks.map(x => Number(x[1])).sort((x, y) => x - y), ranks.map((_, i) => i + 1)), `G4 Paid has rank ${to} and the ranks are 1..n (${short(ranks)})`);
  });

  // L6: the guardrail item, its switch and its blocker say the same, whatever the limit (framework R20)
  await scenario("L6 a guardrail agrees with itself", "gtm", async url => {
    const item = async () => ((await get(url, "/topics/outbound")).body?.goal?.guardrails?.items ?? []).find((x: any) => x.id === "outbound-sends-a-day");
    const agree = async (when: string) => {
      const blockers: string[] = [];
      const actions: string[] = [];
      let seen = 0;
      const switches: any[] = (await get(url, "/skills")).body?.guardrails ?? [];
      for (const t of await topicIds(url)) {
        const goal = (await get(url, `/topics/${t}`)).body?.goal;
        const blocked = new Set((goal?.blockers ?? []).map((b: any) => b.guardrailId).filter(Boolean));
        for (const i of goal?.guardrails?.items ?? []) {
          seen++;
          if ((i.state === "breached") !== blocked.has(i.id)) blockers.push(`${i.id} ${i.state}`);
          if (i.switchId && i.action !== by(switches, "id", i.switchId)?.action) actions.push(`${i.id} ${i.action}`);
        }
      }
      ok(seen > 0 && blockers.length === 0, `L6 ${when}: a guardrail has a blocker exactly while it is breached (${blockers.join(", ")})`);
      ok(seen > 0 && actions.length === 0, `L6 ${when}: a guardrail linked to a switch acts as the switch does (${actions.slice(0, 4).join(", ")})`);
    };
    await agree("as it starts");
    for (const n of [rand(20, 58), rand(70, 120)]) {
      const r = await act(url, { type: "message.send", threadId: "topic:outbound", text: `Set the sends a day guardrail to ${n}` });
      await act(url, { type: "decision.approve", decisionId: decisionOf(r) });
      const now = await item();
      ok(now?.limit?.value === n && (now?.state === "breached") === (now?.value?.value > n), `L6 sends a day: ${now?.value?.value} against ${n} is ${now?.state}`);
      const sw = by((await get(url, "/skills")).body?.guardrails, "id", "outbound");
      ok(sw?.limit?.value === n && new RegExp(`\\b${n}\\b`).test(sw?.detail ?? ""), `L6 the Outbound switch says ${n} (${short([sw?.limit?.value, sw?.detail])})`);
      await agree(`sends a day at ${n}`);
    }
    const euros = rand(150, 250);
    const r = await act(url, { type: "message.send", threadId: "topic:paid", text: `Loosen the guardrail on cost per lead, set it to €${euros}` });
    await act(url, { type: "decision.approve", decisionId: decisionOf(r) });
    const paid = (await get(url, "/topics/paid")).body?.goal;
    const cost = (paid?.guardrails?.items ?? []).find((x: any) => x.id === "cost-per-lead");
    ok(cost?.limit?.money?.amountMinor === euros * 100 && cost?.state !== "breached", `L6 cost per lead is inside ${euros} EUR (${short([cost?.limit, cost?.state])})`);
    ok(!JSON.stringify([paid?.gap, paid?.blockers]).includes("€100"), "L6 nothing on Paid still says €100");
    await agree(`cost per lead at €${euros}`);
  });

  // L8: a verdict that changes by an approved target appends one scored forecast
  await scenario("L8 forecast on an approved target", "gtm", async url => {
    let changed = 0;
    for (const [topicId, name] of [["outbound", "Outbound"], ["paid", "Paid"]] as const) {
      const before = (await get(url, `/topics/${topicId}`)).body?.goal;
      const r = await act(url, { type: "message.send", threadId: `topic:${topicId}`, text: `Change the ${name} target to ${before?.target * rand(3, 6)}` });
      await act(url, { type: "decision.approve", decisionId: decisionOf(r) });
      const after = (await get(url, `/topics/${topicId}`)).body?.goal;
      const added = (after?.forecastLog ?? []).length - (before?.forecastLog ?? []).length;
      const moved = before?.verdict?.word !== after?.verdict?.word;
      if (moved) changed++;
      ok(added === (moved ? 1 : 0), `L8 ${topicId}: ${before?.verdict?.word} → ${after?.verdict?.word} appends ${added} forecasts`);
      const last = after?.forecastLog?.at(-1);
      if (moved) ok(last?.value !== null && isTime(last?.givenAt) && isTime(last?.scoreAt), `L8 ${topicId}: the new forecast has a value and the date it is scored (${short(last)})`);
    }
    ok(changed > 0, "L8 a much higher target changes a verdict");
    const r = await act(url, { type: "lane.act", laneId: "webinar", act: "post-passing" });
    const last = (await get(url, "/topics/content")).body?.goal?.forecastLog?.at(-1);
    ok(r.status === 200 && last?.value && isTime(last?.scoreAt), `L8 content: the forecast after the post has a value and its scoring date (${short(last)})`);
  });

  // L4: two asks that run side by side become two lanes; a second part that builds on the first stays in it
  await scenario("L4 splits by dependence", "gtm", async url => {
    const verbs = ["Translate", "Record", "Interview", "Count", "Audit", "Sketch", "Redesign", "Book", "Photograph", "Proofread", "Rank", "Collect"];
    const things = ["the pricing page", "a stand at the Bremen fair", "four lost customers", "the newsletter header", "two product demos", "the old landing pages",
      "last week's replies", "a banner for the fair"];
    const clause = (verb: string, thing: string) => `${verb} ${thing}`;
    const two = () => {
      const [v, w] = [pick(verbs), pick(verbs)];
      const [x, y] = [pick(things), pick(things)];
      return v === w || x === y ? null : { v, w, x, y };
    };
    const pairs = Array.from({ length: 40 }, two).filter(p => p !== null);
    const apart = pairs.slice(0, 4).map(p => `${clause(p.v, p.x)} and ${clause(p.w.toLowerCase(), p.y)}`);
    const together = [...pairs.slice(4, 8).map((p, i) => `${clause(p.v, p.x)} and ${p.w.toLowerCase()} ${["it", "them", "their first lines", "its cover"][i]}`),
      "Compare the Leipzig and Bremen fairs", "Draft a note to the retail and logistics partners"];
    for (const [list, n] of [[apart, 2], [together, 1]] as const) for (const text of list) {
      const r = await act(url, { type: "lane.file", text });
      const got = events(r).filter(e => e.type === "lane.filed").length;
      ok(r.status === 200 && got === n, `L4 "${text}" files ${n} (${r.status}, ${got})`);
    }
  });

  // E1: an existing member, however named, is not invited twice
  await scenario("E1 an existing member by any name", "gtm", async url => {
    const before = ((await get(url, "/members")).body?.invitations ?? []).length;
    for (const p of (await get(url, "/members")).body?.items ?? []) for (const name of String(p.person?.name ?? "").split(" ")) {
      await act(url, { type: "access.invite", topicId: "content", nameOrEmail: pick([name, name.toLowerCase(), name.toUpperCase()]) });
    }
    ok(((await get(url, "/members")).body?.invitations ?? []).length === before, "E1 a first or last name of a member creates no invitation");
  });
}

// ---- a proposal says what the ask says, or there is none
const MONTHS = ["January", "February", "March", "April", "May", "June"];
type Want = (gc: any) => boolean;
const wantBudget = (topicId: string, euros: number, period: string | null = null): Want => gc => gc.field === "budget" && gc.topicId === topicId
  && gc.budget?.to?.amountMinor === euros * 100 && (period === null || gc.budget?.period === period);
const wantTarget = (topicId: string, n: number): Want => gc => gc.field === "target" && gc.topicId === topicId && gc.to === n && gc.unit === null && gc.deadlineAt === null;
const wantRank = (topicId: string, n: number): Want => gc => gc.field === "priority" && gc.topicId === topicId && gc.priority?.to === n;
const wantLimit = (id: string, n: number): Want => gc => gc.field === "guardrail" && gc.guardrail?.guardrailId === id
  && (numberOf(gc.guardrail?.to) === (gc.guardrail?.to?.kind === "money" ? n * 100 : n));
const wantDeadline = (topicId: string, date: string): Want => gc => gc.field === "deadline" && gc.topicId === topicId && gc.from === gc.to
  && isTime(gc.deadlineAt) && local(gc.deadlineAt, "Europe/Berlin", "date") === date;
async function propose(url: string, threadTopic: string, text: string, as?: string) {
  const sent = await act(url, { type: "message.send", threadId: `topic:${threadTopic}`, text }, as);
  const id = decisionOf(sent);
  return { sent, id, gc: id ? (await get(url, `/decisions/${id}`)).body?.goalChange ?? null : null };
}
const said = (gc: any) => short(gc && [gc.field, gc.topicId, gc.to, gc.unit, gc.deadlineAt, gc.budget?.to, gc.guardrail?.guardrailId]);

async function faithful() {
  // plain asks in the mockup's words are understood
  await scenario("G1 plain asks are understood", "gtm", async url => {
    const n = rand(31, 89);
    const [month, year, monthNumber] = (() => { const m = rand(1, 5); return [MONTHS[m]!, 2027, String(m + 1).padStart(2, "0")] as const; })();
    const day = rand(10, 28);
    const plain: [string, string, Want][] = [
      ["seo", `Set the SEO budget to €${n} a week`, wantBudget("seo", n, "week")],
      ["paid", `Raise the Paid budget cap to ${n}00 euros`, wantBudget("paid", n * 100)],
      ["content", `Give Content a budget of €${n} per month`, wantBudget("content", n, "month")],
      ["outbound", `Cut the Outbound budget to EUR ${n} a month`, wantBudget("outbound", n, "month")],
      ["outbound", `Set the Outbound target to ${n}`, wantTarget("outbound", n)],
      ["paid", `Raise the Paid target to 1,${n}0 leads`, wantTarget("paid", 1000 + n * 10)],
      ["outbound", `The Outbound goal is now ${n} meetings`, wantTarget("outbound", n)],
      ["partnerships", `Move the Partnerships deadline to ${day} ${month}`, wantDeadline("partnerships", `${year}-${monthNumber}-${day}`)],
      ["content", `Extend the Content deadline to 3 December 2026`, wantDeadline("content", "2026-12-03")],
      ["outbound", `Set the sends a day guardrail to ${n}`, wantLimit("outbound-sends-a-day", n)],
      ["outbound", `Change the guardrail on bounces to 3 percent`, wantLimit("outbound-bounces", 3)],
      ["paid", `Raise the cost per lead guardrail to €1${n}`, wantLimit("cost-per-lead", 100 + n)],
      ["seo", "Make SEO the top priority", wantRank("seo", 1)],
      ["paid", "Raise the priority of Paid to number 2", wantRank("paid", 2)],
      ["content", "Lower the priority of Content", wantRank("content", 3)],
      ["seo", "Prioritise SEO over Outbound", wantRank("seo", 3)],
    ];
    for (const [thread, text, want] of plain) {
      const { gc } = await propose(url, thread, text);
      ok(gc && want(gc), `G1 "${text}" is proposed as asked (${said(gc)})`);
    }
  });

  // anything else: the same proposal, or none; never another topic, field, amount, rank or guardrail
  await scenario("G1 no proposal says something else", "gtm", async url => {
    const n = rand(31, 89);
    const asks: [string, string, Want][] = [
      ["paid", `Raise the Research budget to €${n} a week`, wantBudget("research", n)],
      ["paid", "Make Research the top priority", wantRank("research", 1)],
      ["paid", "SEO should get a higher priority than Paid", wantRank("seo", 4)],
      ["seo", "Give SEO a higher priority than Outbound", wantRank("seo", 3)],
      ["content", "Move the Content deadline from 19 November 2026 to 3 December 2026", wantDeadline("content", "2026-12-03")],
      ["outbound", `Raise the Outbound target to ${n} this quarter`, wantTarget("outbound", n)],
      ["outbound", `Raise the Outbound goal by ${n} meetings`, wantTarget("outbound", 30 + n)],
      ["outbound", `We missed the target by ${n} meetings last month`, () => false],
      ["paid", `Cut the Paid budget by €${rand(5, 20)} a week`, gc => gc.field === "budget" && gc.topicId === "paid" && gc.budget.to.amountMinor >= 1000 && gc.budget.to.amountMinor <= 2500],
      ["content", `Move €1,${n}0 of the Paid budget from LinkedIn to Search`, () => false],
      ["paid", `We spent €${n} of the Paid budget so far`, () => false],
      ["content", `Set the budgets of Paid and SEO to €${n} a week`, () => false],
      ["content", `Target of ${n} for Outbound and ${n}0 for Paid`, () => false],
      ["outbound", `Raise the sends a day guardrail by ${n}`, wantLimit("outbound-sends-a-day", 60 + n)],
      ["outbound", "Set the email bounce guardrail to 3%", wantLimit("outbound-bounces", 3)],
      ["paid", `Raise the spend guardrail to €${n}0 per change`, () => false],
      ["content", `In Outbound, set the cost per lead guardrail to €${n}`, () => false],
      ["paid", "Raise the priority of Paid for the first week of December", wantRank("paid", 3)],
      ["outbound", `The Outbound budget can go up to EUR 1 ${n}0,00 per month`, wantBudget("outbound", 1000 + n * 10)],
    ];
    const whole: [string, string, Want][] = [
      ["seo", `Set the SEO budget to €${n} a week`, wantBudget("seo", n)], ["outbound", `Set the Outbound target to ${n}`, wantTarget("outbound", n)],
      ["outbound", `Set the sends a day guardrail to ${n}`, wantLimit("outbound-sends-a-day", n)], ["paid", "Raise the priority of Paid to number 2", wantRank("paid", 2)],
      ["partnerships", "Move the Partnerships deadline to 21 February", wantDeadline("partnerships", "2027-02-21")],
    ];
    const tails = [" for the first two weeks of December", ` instead of ${n + 7}`, ` and the Content one to ${n + 9}`, ` unless it falls below ${n - 20}`, ", not more than 12 per person", " except in Paid", " once Outbound is 3rd"];
    const heads = ["Do not ", "Ask Lea whether to ", "After 12 December, ", "In Content, "];
    for (const [thread, text, want] of whole) {
      for (const tail of tails) asks.push([thread, text + tail, want]);
      const head = pick(heads);
      asks.push([thread, head + text.charAt(0).toLowerCase() + text.slice(1), () => false]);
    }
    const wrong: string[] = [];
    for (const [thread, text, want] of asks) {
      const { sent, gc } = await propose(url, thread, text);
      if (sent.status !== 200 || (gc && !want(gc))) wrong.push(`"${text}" → ${sent.status} ${said(gc)}`);
      if (hasEvent(sent, "lane.filed") && sent.body?.message?.label?.kind === "goalChange") wrong.push(`"${text}" filed a lane`);
    }
    ok(wrong.length === 0, `G1 of ${asks.length} odd asks none is proposed as something else (${wrong.length}: ${wrong.slice(0, 6).join("; ")})`);
  });

  // E7: nobody opens a goal change on a topic they cannot see, from any chat they can write in
  await scenario("E7 no goal change on a topic out of reach", "gtm", async url => {
    const owned = async () => ((await get(url, "/decisions")).body?.items ?? []).filter((d: any) => d.goalChange).length;
    const before = await owned();
    const opened: string[] = [];
    let tried = 0;
    await act(url, { type: "access.set", topicId: "partnerships", personId: "lea-brandt", access: { kind: "all", stages: [] } });
    const ids = await topicIds(url);
    for (const p of PEOPLE) {
      const sees = new Map<string, boolean>();
      for (const t of ids) sees.set(t, (await getAs(url, `/topics/${t}`, p)).status === 200);
      for (const from of ids.filter(t => sees.get(t))) for (const t of ids.filter(x => !sees.get(x))) {
        const name = t === "seo" ? "SEO" : t.charAt(0).toUpperCase() + t.slice(1);
        for (const text of [`Set the ${name} budget to €${rand(31, 89)} a week`, `Make ${name} the top priority`]) {
          tried++;
          const { sent } = await propose(url, from, text, p);
          if (decisionOf(sent)) opened.push(`${p} in ${from}: ${text}`);
        }
      }
    }
    ok(tried > 0 && opened.length === 0 && (await owned()) === before, `E7 ${tried} asks on topics out of reach open no goal change (${opened.slice(0, 4).join("; ")}; ${before} → ${await owned()})`);
  });

  // G4: the last approval counts, whatever was written first, and undoing it gives back the one before
  await scenario("G4 approvals apply in the order they are given", "gtm", async url => {
    const [a, b] = [rand(31, 59), rand(60, 89)];
    const kinds: [string, string, (n: number) => string, (body: any) => number | undefined][] = [
      ["target", "outbound", n => `Set the Outbound target to ${n}`, t => t?.goal?.target],
      ["budget", "seo", n => `Set the SEO budget to €${n} a week`, t => t?.spend?.cap?.amountMinor / 100],
      ["guardrail", "outbound", n => `Set the sends a day guardrail to ${n}`, t => (t?.goal?.guardrails?.items ?? []).find((x: any) => x.id === "outbound-sends-a-day")?.limit?.value],
    ];
    for (const [kind, topicId, text, read] of kinds) {
      const value = async () => read((await get(url, `/topics/${topicId}`)).body);
      const start = await value();
      const first = await propose(url, topicId, text(a));
      const second = await propose(url, topicId, text(b));
      await act(url, { type: "decision.approve", decisionId: second.id });
      ok((await value()) === b, `G4 ${kind}: approving the second proposal sets ${b} (${await value()})`);
      const r = await act(url, { type: "decision.approve", decisionId: first.id });
      ok((await value()) === a, `G4 ${kind}: approving the first one last sets ${a} (${await value()})`);
      ok(hasEvent(r, "thread.changed", { threadId: "manager" }), `G4 ${kind}: the approval changes the Manager's chat too`);
      const u = await act(url, { type: "decision.undo", decisionId: first.id });
      ok((await value()) === b && hasEvent(u, "thread.changed", { threadId: "manager" }), `G4 ${kind}: undoing it gives back ${b}, with thread.changed manager (${await value()})`);
      await act(url, { type: "decision.undo", decisionId: second.id });
      ok((await value()) === start, `G4 ${kind}: undoing both gives back ${start} (${await value()})`);
    }
    const one = await propose(url, "paid", "Make Paid the top priority");
    const two = await propose(url, "seo", "Make SEO the top priority");
    await act(url, { type: "decision.approve", decisionId: two.id });
    await act(url, { type: "decision.approve", decisionId: one.id });
    const ranks = [(await get(url, "/topics/paid")).body?.meta?.priority, (await get(url, "/topics/seo")).body?.meta?.priority];
    ok(same(ranks, [1, 2]), `G4 priority: the topic approved last is first (${short(ranks)})`);
  });

  await scenario("L6 limits reach every place", "gtm", async url => {
    const before = by((await get(url, "/skills")).body?.guardrails, "id", "outbound")?.limit;
    const n = rand(20, 58);
    const { id } = await propose(url, "outbound", `Set the sends a day guardrail to ${n}`);
    const r = await act(url, { type: "decision.approve", decisionId: id });
    const after = by((await get(url, "/skills")).body?.guardrails, "id", "outbound")?.limit;
    ok(same(after, { ...before, value: n, of: n }) && hasEvent(r, "skills.changed"), `L6 the switch keeps its shape and /skills says it changed (${short(before)} → ${short(after)})`);
    ok(hasEvent(r, "guardrail.breached", { topicId: "outbound", guardrailId: "outbound-sends-a-day" }), "L6 an approval that breaches a guardrail emits guardrail.breached with its id");
    const u = await act(url, { type: "decision.undo", decisionId: id });
    ok(same(by((await get(url, "/skills")).body?.guardrails, "id", "outbound")?.limit, before) && hasEvent(u, "skills.changed"), "L6 undoing it restores the switch and says so");
    const zero = await propose(url, "outbound", "Set the sends a day guardrail to 0");
    await act(url, { type: "decision.approve", decisionId: zero.id });
    const goal = (await get(url, "/topics/outbound")).body?.goal;
    ok((goal?.guardrails?.items ?? []).find((x: any) => x.id === "outbound-sends-a-day")?.state === "breached" && by(goal?.blockers, "guardrailId", "outbound-sends-a-day"), "L6 a reading above a limit of 0 is breached and blocks");
    const euros = rand(45, 90);
    const agents = await propose(url, "content", `Set the agents this week guardrail to €${euros}`);
    await act(url, { type: "decision.approve", decisionId: agents.id });
    const content = (await get(url, "/topics/content")).body;
    const item = (content?.goal?.guardrails?.items ?? []).find((x: any) => x.id === "content-agents-this-week");
    ok(numberOf(item?.limit) === euros * 100 && content?.spend?.cap?.amountMinor === euros * 100, `L6 the agents-this-week limit is the topic's cap (${numberOf(item?.limit)}, ${content?.spend?.cap?.amountMinor})`);
  });

  await scenario("L8 a forecast is stored once", "gtm", async url => {
    for (const [topicId, name, date] of [["outbound", "Outbound", "2026-12-18"], ["paid", "Paid", "2026-12-31"]] as const) {
      const target = (await get(url, `/topics/${topicId}`)).body?.goal?.target;
      const { id } = await propose(url, topicId, `Set the ${name} target to ${target * rand(3, 5)}`);
      await act(url, { type: "decision.approve", decisionId: id });
      const read = async () => (await get(url, `/topics/${topicId}`)).body?.goal?.forecastLog?.at(-1);
      const first = await read();
      await pause(1100);
      ok(same(first, await read()), `L8 ${topicId}: the new forecast does not change between reads (${first?.givenAt}, ${(await read())?.givenAt})`);
      ok(isTime(first?.scoreAt) && local(first.scoreAt, "Europe/Berlin", "date") === date, `L8 ${topicId}: it is scored on ${date}, the goal's date in the mockup (${first?.scoreAt})`);
    }
  });

  await scenario("L2 report dates agree", "gtm", async url => {
    const { id } = await propose(url, "partnerships", "Move the Partnerships deadline to 21 February");
    await act(url, { type: "decision.approve", decisionId: id });
    const schedules: any[] = (await get(url, "/manager")).body?.schedules ?? [];
    const off: string[] = [];
    for (const t of await topicIds(url)) {
      const meta = (await get(url, `/topics/${t}`)).body?.meta;
      if (!meta?.nextReportId) continue;
      const report = (await get(url, `/reports/${meta.nextReportId}`)).body;
      const dates = [meta.nextReportAt, report?.dueAt, by(schedules, "id", report?.scheduleId)?.nextAt].map(d => Date.parse(d));
      if (new Set(dates).size !== 1) off.push(`${t} ${short([meta.nextReportAt, report?.dueAt])}`);
    }
    ok(off.length === 0, `L2 a moved deadline moves no report away from its schedule (${off.join("; ")})`);
  });

  for (const module of ["gtm", "dev"] as Module[]) await scenario("L4 the mockup's own asks", module, async url => {
    const asks = (await Promise.all((await laneIds(url)).map(async id => (await get(url, `/lanes/${id}`)).body?.asked as string | undefined))).filter((t): t is string => Boolean(t));
    const split: string[] = [];
    for (const text of asks) {
      const r = await act(url, { type: "lane.file", text });
      if (r.status !== 200 || events(r).filter(e => e.type === "lane.filed").length !== 1) split.push(text);
    }
    ok(asks.length > 5 && split.length === 0, `L4 ${module}: none of the ${asks.length} asks that are one lane in the mockup is split (${split.join("; ")})`);
  });

  await scenario("E4 edition follows the setting", "gtm", async url => {
    const n = pick([1, 2]);
    await act(url, { type: "prefs.set", briefsPerDay: n });
    ok((await get(url, "/brief")).body?.edition?.of === n, `E4 with ${n} briefs a day the edition is of ${n} (${short((await get(url, "/brief")).body?.edition)})`);
  });

  await scenario("L3 a check hangs on its own row", "gtm", async url => {
    const rows = (await Promise.all((await topicIds(url)).map(t => historyRows(url, t)))).flat().filter((e: any) => e.checkId);
    const off: string[] = [];
    for (const e of rows) {
      const check = (await get(url, `/checks/${e.checkId}`)).body;
      if (check?.laneId !== (e.laneId ?? e.target?.id) || local(check.at, "Europe/Berlin", "date") !== local(e.at, "Europe/Berlin", "date")) off.push(`${e.checkId}: ${short([check?.laneId, check?.at, e.laneId ?? e.target?.id, e.at])}`);
    }
    ok(rows.length >= 2 && off.length === 0, `L3 each check is on a row of its lane and day (${off.join("; ")})`);
  });
}

try {
  await run();
  await invariants();
  await faithful();
} catch (e) {
  fatal(String((e as Error)?.message ?? e));
}
const missingIds = IDS.filter(id => !counts[id]);
ok(missingIds.length === 0, `META every plan decision has an assertion (missing ${missingIds.join(", ")})`);
if (process.argv.includes("--by-id")) console.log(IDS.map(id => `${id} ${counts[id] ?? 0}`).join(", "));
if (failed) console.log(`seed ${SEED}`);
console.log(`cockpit contract v3: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
