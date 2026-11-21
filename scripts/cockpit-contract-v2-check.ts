// The cockpit API contract, second acceptance check (ADR-0044 decisions 9 and 10).
//
// The first check (scripts/cockpit-contract-check.ts) proves the contract exists and serves the mockups. This one
// proves two more things without trusting the code under test:
//   1. The contract can evolve without breaking installed clients: a version, a compatibility gate, an OpenAPI
//      document, tolerant views and strict commands, typed times, money and link targets, paging, a resumable feed,
//      idempotent commands and RFC 9457 errors.
//   2. It covers what the UI master promises beyond the first pass: every button has a command id and an Undo, the
//      charts and artwork have data, sharing has a viewer, settings refuse what the UI cannot show, and the
//      development module links pull requests, decisions and releases.
// The Rust side (serde round-trips, tolerant parsing of unknown fields and events) is checked with cargo, not here.
//
// usage: node scripts/cockpit-contract-v2-check.ts        exit 0 when every case passes

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const SCHEMA = "packages/cockpit-api/schema/cockpit.schema.json";
const OPENAPI = "packages/cockpit-api/schema/cockpit.openapi.json";
const RELEASED = "packages/cockpit-api/schema/released/1.json";
const COMPAT = "packages/cockpit-api/scripts/compat.ts";
const STANDIN = "apps/cockpit-standin/src/main.ts";
const BASE = "/api/cockpit";

let failed = 0;
let passed = 0;
function ok(cond: unknown, what: string) {
  if (cond) passed++;
  else { failed++; console.log(`FAIL ${what}`); }
}
function fatal(what: string): never {
  console.log(`FAIL ${what}`);
  console.log(`cockpit contract v2: ${passed} passed, ${failed + 1} failed`);
  process.exit(1);
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const isTime = (v: unknown) => typeof v === "string" && RFC3339.test(v) && !Number.isNaN(Date.parse(v));

// ---- 1. versioning, compatibility gate, OpenAPI
if (!existsSync(SCHEMA)) fatal(`no exported schema at ${SCHEMA}`);
const schema: any = JSON.parse(readFileSync(SCHEMA, "utf8"));
const version: string = schema["x-contract-version"];
ok(typeof version === "string" && /^1\.\d+\.\d+$/.test(version), `schema carries x-contract-version 1.x.y (got ${version})`);
ok(schema.$id === "urn:morndo:cockpit-api:1", `schema $id is urn:morndo:cockpit-api:1 (got ${schema.$id})`);
ok(existsSync(RELEASED), `the released contract is kept at ${RELEASED}`);
if (!existsSync(COMPAT)) fatal(`no compatibility gate at ${COMPAT}`);
const compat = (args: string[]) => spawnSync(process.execPath, [COMPAT, ...args], { encoding: "utf8" });
ok(compat([]).status === 0, "the current schema is compatible with the released one");
{
  const dir = mkdtempSync(join(tmpdir(), "cockpit-compat-"));
  const removed = structuredClone(schema);
  delete removed.$defs.LaneView.properties.title;
  removed.$defs.LaneView.required = (removed.$defs.LaneView.required ?? []).filter((x: string) => x !== "title");
  writeFileSync(join(dir, "removed.json"), JSON.stringify(removed));
  ok(compat(["--current", join(dir, "removed.json")]).status === 1, "compat refuses a removed response field");
  const added = structuredClone(schema);
  added.$defs.LaneView.properties.someNewField = { type: "string" };
  writeFileSync(join(dir, "added.json"), JSON.stringify(added));
  ok(compat(["--current", join(dir, "added.json")]).status === 0, "compat accepts a new response field");
  const cmd = structuredClone(schema);
  const approve = (cmd.$defs.Command.oneOf ?? []).find((b: any) => b?.properties?.type?.const === "decision.approve");
  if (approve) { approve.properties.reason = { type: "string" }; approve.required = [...approve.required, "reason"]; }
  writeFileSync(join(dir, "cmd.json"), JSON.stringify(cmd));
  ok(approve && compat(["--current", join(dir, "cmd.json")]).status === 1, "compat refuses a new required command input");
}
ok(existsSync(OPENAPI), `an OpenAPI document is exported at ${OPENAPI}`);
const openapi: any = existsSync(OPENAPI) ? JSON.parse(readFileSync(OPENAPI, "utf8")) : {};
ok(typeof openapi.openapi === "string" && openapi.openapi.startsWith("3.1"), "OpenAPI 3.1");
const PATHS = ["/workspace", "/sidebar", "/usage", "/brief", "/brief/artwork", "/decisions", "/decisions/{id}", "/topics/{id}",
  "/topics/{id}/access", "/topics/{id}/history", "/lanes/{id}", "/manager", "/drafts", "/skills", "/settings", "/pulls",
  "/threads/{threadId}", "/search", "/route-preview", "/models", "/actions", "/feed"];
for (const p of PATHS) ok(openapi.paths && openapi.paths[BASE + p], `OpenAPI lists ${BASE}${p}`);

// ---- strict validator over the committed schema
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
try { ajv.addSchema(schema, "cockpit"); ajv.getSchema("cockpit#/$defs/WorkspaceView"); ok(true, "schema compiles in Ajv strict mode"); }
catch (e) { fatal(`schema does not compile in Ajv strict mode: ${String((e as Error).message).slice(0, 300)}`); }
function valid(def: string, value: unknown, what: string) {
  const v = ajv.getSchema(`cockpit#/$defs/${def}`);
  if (!v) return ok(false, `${what}: no $defs/${def}`);
  const good = v(value);
  ok(good, `${what} is a valid ${def}${good ? "" : ": " + ajv.errorsText(v.errors).slice(0, 300)}`);
}

const DEFS = ["WorkspaceView", "SidebarView", "UsageView", "BriefView", "DecisionQueueView", "DecisionView", "TopicView",
  "LaneView", "ManagerView", "DraftsView", "SkillsView", "SettingsView", "ThreadView", "SearchView", "RoutePreview",
  "PullsView", "AccessView", "Command", "CommandResult", "Event", "ApiError", "FeedEvent", "Target", "Money", "ModelsView",
  "Artwork", "HistoryPage", "ErrorCode"];
for (const d of DEFS) ok(schema.$defs?.[d], `schema defines ${d}`);
const undescribed = Object.entries(schema.$defs ?? {}).filter(([, d]: any) => !(typeof d?.description === "string" && d.description.trim())).map(([k]) => k);
ok(undescribed.length === 0, `every definition has a description (${undescribed.length} without: ${undescribed.slice(0, 8).join(", ")})`);
const VIEWS = ["WorkspaceView", "SidebarView", "UsageView", "BriefView", "DecisionQueueView", "DecisionView", "TopicView", "LaneView",
  "ManagerView", "DraftsView", "SkillsView", "SettingsView", "ThreadView", "SearchView", "RoutePreview", "PullsView", "AccessView", "ModelsView"];
for (const d of VIEWS) ok(schema.$defs?.[d] && schema.$defs[d].additionalProperties !== false, `${d} tolerates fields it does not know`);
const branches = (def: string) => (schema.$defs?.[def]?.oneOf ?? schema.$defs?.[def]?.anyOf ?? []) as any[];
const tagOf = (b: any) => b?.properties?.type?.const;
ok(branches("Command").length > 0 && branches("Command").every((b: any) => b.additionalProperties === false), "every command refuses unknown fields");
const COMMANDS = ["decision.approve", "decision.decline", "decision.undo", "decision.change", "agentAction.undo", "agentAction.redo",
  "lane.file", "lane.move", "lane.undoFile", "lane.act", "person.remind", "goal.ask", "message.send", "message.relabel", "since.edit",
  "pin.add", "pin.remove", "pin.move", "prefs.set", "decisionRight.set", "skill.run", "skill.create", "access.set", "access.invite",
  "access.revoke", "access.statusLink", "stage.assign", "topic.seen", "guardrail.set", "pull.hold", "connection.connect",
  "module.switch", "handover.confirm"];
const commandTags = branches("Command").map(tagOf);
for (const c of COMMANDS) ok(commandTags.includes(c), `the contract has the command ${c}`);
const EVENTS = ["decision.changed", "decision.expired", "lane.filed", "lane.changed", "lane.removed", "message.posted", "thread.changed",
  "topic.changed", "drafts.changed", "brief.published", "attention.raised", "guardrail.breached", "usage.changed", "release.changed",
  "pull.changed", "pins.changed", "prefs.changed", "access.changed", "agentAction.changed", "feed.reset"];
const eventTags = branches("Event").map(tagOf);
for (const e of EVENTS) ok(eventTags.includes(e), `the contract has the event ${e}`);
ok(JSON.stringify(schema.$defs?.DecisionState ?? {}).includes("\"expired\""), "a decision can expire");

// ---- generic shape rules over every view a test reads
function walk(value: unknown, at: string, visit: (key: string, v: unknown, path: string, parent: any) => void) {
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${at}[${i}]`, visit));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { visit(k, v, `${at}.${k}`, value); walk(v, `${at}.${k}`, visit); }
}
const TARGETS = ["topic", "lane", "decision", "thread", "person", "draft", "skill", "pull", "manager", "brief", "drafts", "skills", "settings"];
const targetsSeen: any[] = [];
function shapeRules(body: unknown, where: string) {
  const bad: string[] = [];
  walk(body, where, (k, v, path, parent) => {
    if (k === "href") bad.push(`${path}: a hash or page link (use target or url)`);
    if ((k === "at" || /[a-z]At$/.test(k)) && v !== null && !isTime(v)) bad.push(`${path}: ${JSON.stringify(v)} is not an RFC 3339 time`);
    if (k === "currency" && !(typeof v === "string" && /^[A-Z]{3}$/.test(v) && Number.isInteger(parent.amountMinor))) bad.push(`${path}: money needs amountMinor and an ISO 4217 currency`);
    if (k === "target" && typeof v === "string") bad.push(`${path}: a string target (use a Target object)`);
    if (k === "target" && v !== null && typeof v === "object") {
      if (!(v && typeof v === "object" && TARGETS.includes((v as any).kind))) bad.push(`${path}: target kind ${JSON.stringify((v as any)?.kind)}`);
      else targetsSeen.push(v);
    }
    if (k === "own") bad.push(`${path}: "own" differs per reader (compare author.id with me.id)`);
  });
  ok(bad.length === 0, `${where}: links, times, money and targets are typed${bad.length ? " — " + bad.slice(0, 4).join("; ") : ""}`);
}

// ---- the stand-in
if (!existsSync(STANDIN)) fatal(`no stand-in at ${STANDIN}`);
async function start(module: string) {
  const child = spawn(process.execPath, [STANDIN, "--module", module, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`stand-in (${module}) printed no listening line: ${out.slice(0, 300)}`)), 15000);
    const read = (b: Buffer) => {
      out += b.toString();
      const m = out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
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
const act = (url: string, command: unknown, headers: Record<string, string> = {}) =>
  http(url, "/actions", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(command) });
async function view(url: string, path: string, def: string) {
  const r = await get(url, path);
  ok(r.status === 200, `GET ${path} → 200 (got ${r.status})`);
  if (r.status === 200) { valid(def, r.body, `GET ${path}`); shapeRules(r.body, `GET ${path}`); }
  return r.body as any;
}
const by = (list: any[] | undefined, key: string, value: unknown) => (list ?? []).find(x => x && x[key] === value);
function openFeed(url: string, after?: number) {
  const frames: any[] = [];
  const ws = new WebSocket(url.replace("http", "ws") + BASE + "/feed" + (after === undefined ? "" : `?after=${after}`));
  const opened = new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("feed did not open")); });
  ws.onmessage = m => { try { frames.push(JSON.parse(String(m.data))); } catch { /* counted below */ } };
  return { ws, frames, opened };
}
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function actionsResolve(url: string, messages: any[]) {
  for (const m of messages) for (const x of m.actions ?? []) {
    const lane = (await get(url, `/lanes/${x.laneId}`)).body;
    if (!(lane?.acts ?? []).some((a: any) => a.id === x.id)) return false;
  }
  return true;
}

async function gtm() {
  const { child, url } = await start("gtm");
  try {
    const feed = openFeed(url);
    await feed.opened;

    // version on the wire
    const w = await get(url, "/workspace");
    ok(w.headers.get("cockpit-contract") === version, `responses carry cockpit-contract: ${version} (got ${w.headers.get("cockpit-contract")})`);
    ok(w.body?.contractVersion === version, "the workspace names the contract version");
    ok(Array.isArray(w.body?.modules) && w.body.modules.length >= 2, "the workspace lists the modules to switch to");
    shapeRules(w.body, "GET /workspace");

    // every view, with the generic shape rules
    const sidebar = await view(url, "/sidebar", "SidebarView");
    ok(sidebar?.pinLimit === 12, "the sidebar states the pin limit of 12");
    await view(url, "/usage", "UsageView");
    const brief = await view(url, "/brief", "BriefView");
    ok(typeof brief?.artwork?.src === "string" && brief.artwork.src.length > 0, "the brief artwork has an image");
    await view(url, "/brief/artwork?index=1", "Artwork");
    ok(by(brief?.burns, "laneId", "webinar")?.target?.kind === "lane", "the stuck burn points at the webinar lane");
    const nextBriefBefore = brief?.nextBriefAt;
    ok(isTime(nextBriefBefore), "next brief is a time");
    await view(url, "/decisions", "DecisionQueueView");
    for (const id of ["d1", "d2", "d3", "d4"]) await view(url, `/decisions/${id}`, "DecisionView");
    const d1 = await view(url, "/decisions/d1", "DecisionView");
    ok(isTime(d1?.dueAt), "d1 has a due time");
    ok(d1?.position?.index === 1 && d1?.position?.of === 4 && d1?.position?.open === 4, "d1 is 1 of 4, 4 open");
    const sc1 = [d1?.opportunity, d1?.risk].filter(Boolean);
    ok(sc1.length === 2 && sc1.every((s: any) => (s.series ?? []).length >= 2 && s.series.every((p: any) => typeof p.y === "number")), "d1's opportunity and risk carry chart series");
    let money = false;
    walk(d1, "d1", (k, v, _p, parent) => { if (k === "currency" && v === "EUR" && parent.amountMinor === 120000) money = true; });
    ok(money, "d1 carries €1,200 as money (amountMinor 120000, EUR)");
    for (const id of ["partnerships", "content", "outbound", "paid", "seo", "research"]) await view(url, `/topics/${id}`, "TopicView");
    for (const g of sidebar?.groups ?? []) for (const l of g.lanes ?? []) await view(url, `/lanes/${l.id}`, "LaneView");
    await view(url, "/manager", "ManagerView");
    const drafts = await view(url, "/drafts", "DraftsView");
    ok((drafts?.items ?? []).length === 4 && drafts.items.every((d: any) => typeof d.openUrl === "string" && d.openUrl.startsWith("https://")), "every draft opens in the mail app");
    const skills = await view(url, "/skills", "SkillsView");
    ok((skills?.skills ?? []).every((s: any) => typeof s.id === "string" && typeof s.enabled === "boolean"), "skills have ids");
    await view(url, "/settings", "SettingsView");
    const models = await view(url, "/models", "ModelsView");
    ok((models?.items ?? []).length >= 1 && models.items.every((m: any) => m.id && m.name && m.state), "the model picker has models");
    for (const t of ["topic:partnerships", "topic:content", "manager", "general", "lane:halden-offer", "decision:d1"]) {
      const th = await view(url, `/threads/${t}`, "ThreadView");
      ok((th?.messages ?? []).every((m: any) => isTime(m.at) && typeof m.author?.id === "string"), `${t}: messages have a time and an author id`);
    }

    // targets resolve
    const ROUTE: Record<string, (id: string) => string> = { topic: id => `/topics/${id}`, lane: id => `/lanes/${id}`, decision: id => `/decisions/${id}`, thread: id => `/threads/${id}` };
    let unresolved = 0;
    for (const t of targetsSeen.filter(t => ROUTE[t.kind]).slice(0, 40)) if ((await get(url, ROUTE[t.kind]!(t.id))).status !== 200) unresolved++;
    ok(targetsSeen.length >= 10 && unresolved === 0, `link targets resolve (${targetsSeen.length} seen, ${unresolved} unresolved)`);

    // paging
    const first = await get(url, "/threads/topic:partnerships?limit=2");
    ok(first.body?.messages?.length === 2 && typeof first.body?.nextCursor === "string", "a thread pages two messages at a time");
    const seen = new Set<string>((first.body?.messages ?? []).map((m: any) => m.id));
    let cursor = first.body?.nextCursor, overlap = false, pages = 1;
    while (typeof cursor === "string" && pages < 30) {
      const page = await get(url, `/threads/topic:partnerships?limit=2&cursor=${encodeURIComponent(cursor)}`);
      for (const m of page.body?.messages ?? []) { if (seen.has(m.id)) overlap = true; seen.add(m.id); }
      cursor = page.body?.nextCursor; pages++;
    }
    ok(cursor === null && !overlap && pages > 1, "following nextCursor reaches the end without repeats");
    await view(url, "/topics/partnerships/history?limit=1", "HistoryPage");

    // errors (RFC 9457)
    const nf = await get(url, "/decisions/nope");
    ok(nf.status === 404 && (nf.headers.get("content-type") ?? "").startsWith("application/problem+json"), "a 404 is application/problem+json");
    valid("ApiError", nf.body, "the 404");
    ok(nf.body?.status === 404 && nf.body?.code === "notFound", "the 404 names status 404 and code notFound");
    const wrong = await http(url, "/actions", { method: "DELETE" });
    ok(wrong.status === 405 && (wrong.headers.get("allow") ?? "").includes("POST"), "a wrong method is 405 with Allow");

    // idempotency
    const recapBefore = (by((await get(url, "/sidebar")).body?.groups, "id", "content")?.lanes ?? []).filter((l: any) => String(l.title).includes("recap")).length;
    const fileOnce = { type: "lane.file", text: "Write a recap of the webinar for the newsletter", topicId: "content" };
    const a1 = await act(url, fileOnce, { "idempotency-key": "check-recap-1" });
    const a2 = await act(url, fileOnce, { "idempotency-key": "check-recap-1" });
    ok(a1.status === 200 && a1.body?.laneId && a1.body.laneId === a2.body?.laneId, "a repeated Idempotency-Key returns the same lane");
    const contentLanes = by((await get(url, "/sidebar")).body?.groups, "id", "content")?.lanes ?? [];
    ok(contentLanes.filter((l: any) => l.id === a1.body?.laneId).length === 1 && contentLanes.filter((l: any) => String(l.title).includes("recap")).length === recapBefore + 1, "the repeated command filed one lane");

    // a lane's own choice, with its history row and Undo
    const webinar = (await get(url, "/lanes/webinar")).body;
    ok((webinar?.acts ?? []).length >= 2 && webinar.acts.every((x: any) => typeof x.id === "string"), "the webinar lane's choices have ids");
    ok((await act(url, { type: "lane.act", laneId: "webinar", act: "totally-bogus" })).status === 400, "an unknown choice is refused");
    const chosen = webinar?.acts?.[0]?.id;
    const r1 = await act(url, { type: "lane.act", laneId: "webinar", act: chosen });
    ok(r1.status === 200 && (r1.body?.events ?? []).some((e: any) => e.type === "topic.changed" && e.topicId === "content"), "a choice announces the topic change");
    ok((await get(url, "/lanes/webinar")).body?.state !== "bad", "the chosen lane is no longer stuck");
    ok(!by((await get(url, "/brief")).body?.burns, "laneId", "webinar"), "the brief no longer shows it stuck");
    const history = (await get(url, "/topics/content")).body?.history;
    const row = (history?.days ?? []).flatMap((d: any) => d.entries ?? []).find((e: any) => e.laneId === "webinar" && e.undoable === true && e.undone === false);
    ok(typeof row?.id === "string", "the choice is a history row with an id and Undo");
    const undo = row ? await act(url, { type: "agentAction.undo", actionId: row.id }) : null;
    ok(undo?.status === 200 && (await get(url, "/lanes/webinar")).body?.state === "bad", "Undo from history puts the lane back");
    const rowAfter = ((await get(url, "/topics/content")).body?.history?.days ?? []).flatMap((d: any) => d.entries ?? []).find((e: any) => e.id === row?.id);
    ok(rowAfter?.undone === true, "the history row shows it was undone");
    const contentThread = (await get(url, "/threads/topic:content")).body;
    const withActions = (contentThread?.messages ?? []).filter((m: any) => (m.actions ?? []).length);
    ok(withActions.length >= 1 && withActions.every((m: any) => m.actions.every((x: any) => typeof x.id === "string" && typeof x.laneId === "string")), "chat buttons carry a choice id and its lane");
    ok(await actionsResolve(url, withActions), "every chat button names a choice its lane has");

    // decisions recompute, expire and conflict
    await act(url, { type: "decision.approve", decisionId: "d1" });
    ok((await get(url, "/decisions/d2")).body?.position?.open === 3, "after approving d1, d2 reads 3 open");
    ok(!/four decisions/i.test((await get(url, "/brief")).body?.lede ?? ""), "the brief's lede is recomputed");
    await act(url, { type: "decision.approve", decisionId: "d2" });
    const conflict = await act(url, { type: "decision.decline", decisionId: "d2" });
    ok(conflict.status === 409 && conflict.body?.code === "conflict", "declining an approved decision is a 409 conflict");

    // settings refuse what the UI cannot show, and recompute
    ok((await act(url, { type: "prefs.set", briefsPerDay: 7 })).status === 400, "seven briefs a day is refused");
    ok((await act(url, { type: "decisionRight.set", rule: "inYourName", who: "agent", dailyLimit: 999 })).status === 400, "a daily limit of 999 is refused");
    ok((await act(url, { type: "prefs.set", briefsPerDay: 2 })).status === 200 && (await get(url, "/brief")).body?.nextBriefAt !== nextBriefBefore, "two briefs a day moves the next brief");
    const glass = await act(url, { type: "prefs.set", theme: { glass: null } });
    const theme = (await get(url, "/workspace")).body?.workspace?.theme;
    ok(glass.status === 200 && theme?.glass === null && typeof theme?.effectiveGlass === "number", "glass can follow the theme default");

    // filing: to the Manager, with a file, with a model; talking to the Manager files too
    const toManager = await act(url, { type: "lane.file", text: "Plan the team offsite in January", toManager: true });
    ok(toManager.status === 200 && (await get(url, `/lanes/${toManager.body?.laneId}`)).body?.topicId === null, "an ask can go to the Manager on purpose");
    const withFile = await act(url, { type: "lane.file", text: "Use this brief for the launch post", topicId: "content", attachment: { name: "launch-brief.pdf", url: "https://files.example.test/launch-brief.pdf" }, model: models?.items?.[0]?.id });
    ok(withFile.status === 200 && (await get(url, `/lanes/${withFile.body?.laneId}`)).body?.attachment?.name === "launch-brief.pdf", "a filed ask keeps its file and model");
    const talk = await act(url, { type: "message.send", threadId: "manager", text: "Draft a post about the webinar" });
    ok(talk.status === 200 && typeof talk.body?.laneId === "string", "a request to the Manager files a lane");

    // pins keep order and a limit
    const pins0 = (await get(url, "/sidebar")).body?.pins ?? [];
    if (pins0.length >= 2) {
      await act(url, { type: "pin.move", pinId: pins0[1].id, to: 0 });
      ok((await get(url, "/sidebar")).body?.pins?.[0]?.id === pins0[1].id, "a pin can be moved to the top");
    } else ok(false, "the sidebar has at least two pins to reorder");
    let limit: any = null;
    for (const id of ((await get(url, "/sidebar")).body?.pinnable ?? []).map((x: any) => x.id)) {
      const r = await act(url, { type: "pin.add", pinId: id });
      if (r.status !== 200) { limit = r; break; }
    }
    ok(limit?.status === 409 && limit?.body?.code === "limitReached" && ((await get(url, "/sidebar")).body?.pins ?? []).length === 12, "the thirteenth pin is refused at 12");

    // reading marks, guardrails, goal changes
    const seenRes = await act(url, { type: "topic.seen", topicId: "partnerships" });
    ok(seenRes.status === 200 && isTime((await get(url, "/topics/partnerships")).body?.history?.seen?.at), "a visit moves the topic's last-looked marker");
    const p = (await get(url, "/topics/partnerships")).body;
    ok((p?.goal?.guardrails?.items ?? []).every((g: any) => ["held", "near", "breached"].includes(g.state)), "every guardrail says held, near or breached");
    const gc = await act(url, { type: "message.send", threadId: "topic:partnerships", text: "Change the goal to 4 partners by the end of the quarter" });
    ok(gc.body?.message?.label?.kind === "goalChange", "a goal change is labelled as one");
    const queue = (await get(url, "/decisions")).body;
    const goalDecision = (queue?.items ?? []).find((d: any) => d.goalChange?.topicId === "partnerships");
    ok(goalDecision?.goalChange?.from === 3 && goalDecision?.goalChange?.to === 4, "it becomes a decision with the change from 3 to 4");
    if (goalDecision) await act(url, { type: "decision.approve", decisionId: goalDecision.id });
    ok((await get(url, "/topics/partnerships")).body?.goal?.target === 4, "approving it sets the goal to 4");

    // skills
    const clip = by(skills?.skills, "enabled", false);
    const run = clip ? await act(url, { type: "skill.run", skill: clip.id, text: "A clip of the export feature" }) : null;
    ok(run?.status === 409 && run?.body?.code === "skillDisabled", "a disabled skill does not run");
    const made = await act(url, { type: "skill.create", description: "Turn a webinar recording into three short clips" });
    ok(made.status === 200 && ((await get(url, "/skills")).body?.skills ?? []).length === (skills?.skills ?? []).length + 1, "a skill can be made from a description");

    // sharing: a viewer, stages, invitations, hand-over, status link
    ok((await get(url, "/topics/research?as=lea-brandt")).status === 403, "a topic not shared with Lea is forbidden to her");
    const asLea = await get(url, "/topics/partnerships?as=lea-brandt");
    ok(asLea.status === 200 && asLea.body?.viewer?.role === "stages", "Lea sees partnerships through her stages");
    const stages = asLea.body?.stages ?? [];
    ok(stages.length >= 2 && stages.every((s: any) => ["work", "view", "locked"].includes(s.access)) && stages.some((s: any) => s.name === "Outreach" && s.access === "work"), "each stage tells Lea whether she can work, view or not see it");
    // the chat follows the role (share.extra.html:158): Lea gets the Outreach thread, not the owner's
    const leaThread = (await get(url, "/threads/topic:partnerships?as=lea-brandt&limit=100")).body;
    ok(Array.isArray(leaThread?.messages) && !leaThread.messages.some((m: any) => /halden/i.test(m.text ?? "")), "Lea's thread holds no message from a stage she does not work on");
    ok((leaThread?.messages ?? []).every((m: any) => m.audience?.kind === "stage" && m.audience?.stage === "Outreach" || m.audience?.kind === "topic"), "every message she sees names its audience (her stage, or the whole topic)");
    const leaPost = await http(url, "/actions?as=lea-brandt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "message.send", threadId: "topic:partnerships", text: "Wave 2 is checked, it can go" }) });
    ok(leaPost.status === 200 && leaPost.body?.message?.audience?.stage === "Outreach", "Lea can post in her stage's thread");
    ok(((await get(url, "/threads/topic:partnerships?limit=100")).body?.messages ?? []).some((m: any) => m.text === "Wave 2 is checked, it can go"), "the owner sees Lea's message");
    await act(url, { type: "message.send", threadId: "topic:partnerships", text: "Between us: Halden may want a discount" });
    ok(!((await get(url, "/threads/topic:partnerships?as=lea-brandt&limit=100")).body?.messages ?? []).some((m: any) => m.text === "Between us: Halden may want a discount"), "the owner's own post stays out of Lea's stage thread");
    const leaBrief = (await get(url, "/brief?as=lea-brandt")).body;
    let leaMoney = 0;
    walk(leaBrief, "brief", (k) => { if (k === "currency") leaMoney++; });
    ok(leaBrief && leaMoney === 0, "a person with stage access sees no money in the brief");
    const acc0 = (await get(url, "/topics/partnerships/access")).body;
    await act(url, { type: "access.invite", topicId: "partnerships", nameOrEmail: "sam@example.test" });
    await act(url, { type: "access.invite", topicId: "partnerships", nameOrEmail: "sam@example.test" });
    const acc1 = (await get(url, "/topics/partnerships/access")).body;
    const inv = (acc1?.invitations ?? []).filter((i: any) => i.nameOrEmail === "sam@example.test");
    ok(inv.length === 1 && inv[0].state === "pending", "inviting twice keeps one pending invitation");
    ok(inv[0] && (await act(url, { type: "access.revoke", invitationId: inv[0].id })).status === 200 && !((await get(url, "/topics/partnerships/access")).body?.invitations ?? []).some((i: any) => i.id === inv[0].id), "an invitation can be revoked");
    ok((await act(url, { type: "access.set", topicId: "partnerships", personId: "lea-brandt", access: { kind: "stages", stages: ["Nowhere"] } })).status === 400, "an unknown stage is refused");
    ok((await act(url, { type: "access.set", topicId: "partnerships", personId: "mara-lind", access: { kind: "none", stages: [] } })).status === 409, "the owner cannot lose access");
    void acc0;
    await act(url, { type: "stage.assign", topicId: "partnerships", stage: "Offers", personId: "lea-brandt" });
    const offers = by((await get(url, "/topics/partnerships")).body?.stages ?? [], "name", "Offers");
    ok(offers?.runBy?.id === "lea-brandt", "Offers is now run by Lea, and only by her");
    await act(url, { type: "access.statusLink", topicId: "partnerships" });
    ok(typeof (await get(url, "/topics/partnerships/access")).body?.statusLink?.url === "string", "a status link can be made");

    // the feed: sequence, time, resume
    await pause(300);
    const frames = feed.frames;
    ok(frames.length >= 5, `the feed carried the changes (${frames.length} frames)`);
    for (const f of frames.slice(0, 50)) valid("FeedEvent", f, `feed frame ${f?.type}`);
    ok(frames.every((f, i) => Number.isInteger(f.seq) && isTime(f.at) && (i === 0 || f.seq > frames[i - 1].seq)), "feed frames have increasing seq and a time");
    feed.ws.close();
    if (frames.length >= 3) {
      const again = openFeed(url, frames[0].seq);
      await again.opened;
      await pause(400);
      const replay = again.frames.map(f => f.seq);
      ok(replay.length >= frames.length - 1 && replay[0] === frames[1].seq, "a reconnect with ?after= replays what was missed");
      again.ws.close();
    } else ok(false, "enough frames to test resume");
  } finally { child.kill(); }
}

async function dev() {
  const { child, url } = await start("dev");
  try {
    const w = await get(url, "/workspace");
    ok(w.body?.contractVersion === version && w.body?.module?.id === "dev", "dev workspace names the contract version");
    const brief = await view(url, "/brief", "BriefView");
    ok(brief?.inWorks?.count === 5, "the dev brief counts five pull requests in the works");
    const pulls = await view(url, "/pulls", "PullsView");
    const STATES = ["ready", "blocked", "inReview", "autoMerge", "releasing", "released", "held"];
    ok((pulls?.items ?? []).length === 5 && pulls.items.every((pr: any) => STATES.includes(pr.state) && typeof pr.url === "string" && pr.url.startsWith("https://")), "pull requests have a state and a link");
    const pr412 = by(pulls?.items, "number", 412);
    ok(pr412?.decisionId === "d1" && pr412?.state === "ready", "PR 412 is ready and tied to the release decision");
    const d1 = await view(url, "/decisions/d1", "DecisionView");
    ok(d1?.release && typeof d1.release.stage === "string" && Number.isInteger(d1.release.watchMinutes), "the release decision carries its staged rollout");
    ok([d1?.opportunity, d1?.risk].filter(Boolean).every((s: any) => (s.series ?? []).length >= 2), "the release decision's scenarios carry chart series");
    await act(url, { type: "decision.approve", decisionId: "d1" });
    ok(by((await get(url, "/pulls")).body?.items, "number", 412)?.state === "releasing", "approving the release starts PR 412's rollout");
    const held = await act(url, { type: "pull.hold", pullId: pr412?.id ?? "412" });
    ok(held.status === 200 && by((await get(url, "/pulls")).body?.items, "number", 412)?.state === "held", "a pull request can be held");
    const m = await view(url, "/manager", "ManagerView");
    ok(m?.summary === "7 lanes in 4 projects · 3 wait for you", `the dev Manager summary matches the mockup (got ${m?.summary})`);
    for (const g of (await get(url, "/sidebar")).body?.groups ?? []) await view(url, `/topics/${g.id}`, "TopicView");
    const devButtons: any[] = [];
    for (const g of (await get(url, "/sidebar")).body?.groups ?? []) devButtons.push(...((await get(url, `/threads/topic:${g.id}`)).body?.messages ?? []).filter((m: any) => (m.actions ?? []).length));
    ok(devButtons.length >= 1 && await actionsResolve(url, devButtons), "every dev chat button names a choice its lane has");
  } finally { child.kill(); }
}

// every choice a lane lists is accepted (each on a fresh stand-in, so one choice cannot hide another)
async function everyChoiceWorks(module: string) {
  const lanes: { id: string; acts: string[] }[] = [];
  {
    const { child, url } = await start(module);
    try {
      for (const g of (await get(url, "/sidebar")).body?.groups ?? []) for (const l of g.lanes ?? []) {
        const lane = (await get(url, `/lanes/${l.id}`)).body;
        lanes.push({ id: l.id, acts: (lane?.acts ?? []).map((x: any) => x.id) });
      }
    } finally { child.kill(); }
  }
  const refused: string[] = [];
  for (const lane of lanes) for (const choice of lane.acts) {
    const { child, url } = await start(module);
    try {
      const r = await act(url, { type: "lane.act", laneId: lane.id, act: choice });
      if (r.status !== 200) refused.push(`${lane.id}/${choice} → ${r.status}`);
    } finally { child.kill(); }
  }
  ok(lanes.some(l => l.acts.length) && refused.length === 0, `${module}: every choice a lane lists is accepted${refused.length ? " — refused: " + refused.slice(0, 6).join(", ") : ""}`);
}

try {
  await gtm();
  await dev();
  await everyChoiceWorks("gtm");
  await everyChoiceWorks("dev");
} catch (e) {
  fatal(String((e as Error)?.message ?? e));
}
console.log(`cockpit contract v2: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
