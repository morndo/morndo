// The cockpit API contract's acceptance check (ADR-0044, decisions 9 and 10).
//
// It proves three things without trusting the code under test:
//   1. The JSON Schema exported from the Rust types is committed, and the TypeScript generated from it is current.
//   2. A stand-in hub serves every cockpit screen of both modules with the mockups' data, and every response is valid
//      against the schema definition named for its route.
//   3. The stand-in's commands change its state as the mockups do, refuse what the schema refuses, and announce each
//      change on the live feed.
// The Rust side (fixtures deserialize into the Rust types; the committed schema equals a fresh export) is checked with
// cargo on the build box, not here.
//
// usage: node scripts/cockpit-contract-check.ts        exit 0 when every case passes

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SCHEMA = "packages/cockpit-api/schema/cockpit.schema.json";
const GENERATE = "packages/cockpit-api/scripts/generate.ts";
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
  console.log(`cockpit contract: ${passed} passed, ${failed + 1} failed`);
  process.exit(1);
}

// ---- 1. schema and generated types
if (!existsSync(SCHEMA)) fatal(`no exported schema at ${SCHEMA}`);
const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
ok(schema.$schema === "https://json-schema.org/draft/2020-12/schema", "schema is JSON Schema 2020-12");
const DEFS = ["WorkspaceView", "SidebarView", "UsageView", "BriefView", "DecisionQueueView", "DecisionView", "TopicView",
  "LaneView", "ManagerView", "DraftsView", "SkillsView", "SettingsView", "ThreadView", "SearchView", "RoutePreview",
  "PullsView", "AccessView", "Command", "CommandResult", "Event", "ApiError"];
for (const d of DEFS) ok(schema.$defs && schema.$defs[d], `schema defines ${d}`);
if (!existsSync(GENERATE)) fatal(`no generator at ${GENERATE}`);
const gen = spawnSync(process.execPath, [GENERATE, "--check"], { encoding: "utf8" });
ok(gen.status === 0, `generated TypeScript is current (${GENERATE} --check exit ${gen.status}: ${(gen.stdout + gen.stderr).trim().slice(0, 200)})`);

// ---- validator straight from the committed schema, independent of the package under test
const Ajv2020 = require("ajv/dist/2020.js").default ?? require("ajv/dist/2020.js");
const ajv = new Ajv2020({ allErrors: true, strict: false });
// schemars writes these number formats; check them instead of letting Ajv warn and ignore them
ajv.addFormat("int64", { type: "number", validate: (n: number) => Number.isSafeInteger(n) });
ajv.addFormat("double", { type: "number", validate: (n: number) => Number.isFinite(n) });
ajv.addSchema(schema, "cockpit");
function valid(def: string, value: unknown, what: string) {
  const v = ajv.getSchema(`cockpit#/$defs/${def}`);
  if (!v) return ok(false, `${what}: no $defs/${def}`);
  const good = v(value);
  ok(good, `${what} is a valid ${def}${good ? "" : ": " + ajv.errorsText(v.errors).slice(0, 300)}`);
}

// ---- 2 and 3. the stand-in
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

async function get(url: string, path: string) {
  const r = await fetch(url + BASE + path);
  const body: any = r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text();
  return { status: r.status, body };
}
async function act(url: string, command: unknown) {
  const r = await fetch(url + BASE + "/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
  const body: any = await r.json();
  return { status: r.status, body };
}
async function view(url: string, path: string, def: string) {
  const r = await get(url, path);
  ok(r.status === 200, `GET ${path} → 200 (got ${r.status})`);
  if (r.status === 200) valid(def, r.body, `GET ${path}`);
  return r.body as any;
}
const by = (list: any[] | undefined, key: string, value: unknown) => (list ?? []).find(x => x && x[key] === value);

async function gtm() {
  const { child, url } = await start("gtm");
  try {
    const events: any[] = [];
    const ws = new WebSocket(url.replace("http", "ws") + BASE + "/feed");
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("feed did not open")); });
    ws.onmessage = m => { try { events.push(JSON.parse(String(m.data))); } catch { /* counted as missing below */ } };
    const eventFor = (type: string, pred: (e: any) => boolean) => events.find(e => e && e.type === type && pred(e));

    const w = await view(url, "/workspace", "WorkspaceView");
    ok(w?.workspace?.name === "Tidewell", "workspace is Tidewell");
    ok(w?.module?.id === "gtm", "module is gtm");
    ok(w?.me?.name === "Mara Lind", "signed in as Mara Lind");

    const s = await view(url, "/sidebar", "SidebarView");
    const groupIds = (s?.groups ?? []).map((g: any) => g.id);
    for (const id of ["partnerships", "content", "outbound", "paid", "seo", "research"]) ok(groupIds.includes(id), `sidebar has topic ${id}`);
    const wave2 = by(by(s?.groups, "id", "partnerships")?.lanes, "id", "outreach-wave-2");
    ok(wave2?.stateWord === "Waits for Lea", `outreach-wave-2 reads "Waits for Lea" (got ${wave2?.stateWord})`);

    const u = await view(url, "/usage", "UsageView");
    ok(by(u?.subscriptions, "name", "Claude Max")?.meters?.[0]?.used === 0.86, "Claude Max 5-hour window at 0.86");
    ok(by(u?.keys, "name", "Anthropic API")?.lanes === 0, "Anthropic API key stands by with 0 lanes");

    const b = await view(url, "/brief", "BriefView");
    ok((b?.decisions ?? []).map((d: any) => d.id).join(",") === "d1,d2,d3,d4", "brief lists decisions d1-d4");
    ok(b?.nextBriefAt === "13:00", "next brief at 13:00");
    ok((b?.overnight ?? []).length === 5, "five things done while you slept");
    ok(b?.drafts?.count === 4, "four drafts waiting");
    ok((b?.topics ?? []).length === 6, "the strip shows six topics");

    await view(url, "/decisions", "DecisionQueueView");
    const d1 = await view(url, "/decisions/d1", "DecisionView");
    ok(d1?.title === "Move €1,200 a week from LinkedIn to Google Search", "d1 title");
    ok(/nothing changes/i.test(d1?.ifNoAnswer ?? ""), "d1 says nothing changes without an answer");
    ok((d1?.nextSteps ?? []).length >= 1, "d1 has next steps");
    ok((await get(url, "/decisions/nope")).status === 404, "unknown decision → 404");

    const p = await view(url, "/topics/partnerships", "TopicView");
    ok(p?.goal?.target === 3 && p?.goal?.signed === 0, "partnerships goal 0 of 3");
    ok(p?.goal?.verdict?.word === "Behind plan", "partnerships is behind plan");
    ok((p?.goal?.guardrails?.items ?? []).length === 4, "partnerships has four guardrails");
    ok((p?.history?.days ?? []).length >= 1, "partnerships has history");
    const r = await view(url, "/topics/research", "TopicView");
    ok(r?.goal === null && typeof r?.noGoal === "string", "research has no goal, with the reason");
    for (const id of ["content", "outbound", "paid", "seo"]) await view(url, `/topics/${id}`, "TopicView");

    const h = await view(url, "/lanes/halden-offer", "LaneView");
    ok(h?.lead?.name === "Jonas Falk" && h?.decisionId === "d4", "halden-offer: Jonas Falk leads, decision d4");
    const w2 = await view(url, "/lanes/outreach-wave-2", "LaneView");
    ok(w2?.handover?.match === false, "outreach-wave-2 handover was corrected");
    for (const id of ["webinar", "fenwick", "search-budget", "sequence-b", "keyword-map"]) await view(url, `/lanes/${id}`, "LaneView");

    const m = await view(url, "/manager", "ManagerView");
    ok((m?.lanes ?? []).length === 16, `manager shows 16 open lanes (got ${(m?.lanes ?? []).length})`);
    ok((m?.sharedResources ?? []).length === 3, "three shared resources");

    ok((await view(url, "/drafts", "DraftsView"))?.items?.length === 4, "four drafts");
    const sk = await view(url, "/skills", "SkillsView");
    ok((sk?.skills ?? []).length === 9, "nine skills");
    ok((sk?.connections ?? []).length === 6 && by(sk?.connections, "name", "Seedance")?.state === "addKey", "six connections, Seedance needs a key");
    const st = await view(url, "/settings", "SettingsView");
    ok(st?.briefsPerDay === 3, "three briefs a day");
    ok((st?.decisionRights ?? []).length === 5, "five decision-right rules");

    const t = await view(url, "/threads/topic:partnerships", "ThreadView");
    ok((t?.messages ?? []).length >= 1 && (t?.messages ?? []).every((x: any) => x.label !== undefined), "topic chat messages carry labels");
    await view(url, "/threads/manager", "ThreadView");
    await view(url, "/threads/lane:halden-offer", "ThreadView");
    await view(url, "/threads/decision:d1", "ThreadView");

    const sr = await view(url, "/search?q=halden", "SearchView");
    ok((sr?.results ?? []).some((x: any) => x.kind === "lane" && x.id === "halden-offer"), "search finds the halden-offer lane");
    const sq = await view(url, "/search?q=" + encodeURIComponent("Where does Halden stand?"), "SearchView");
    ok(sq?.answer && typeof sq.answer.text === "string", "a question gets an answer from the record");
    const rp = await view(url, "/route-preview?text=" + encodeURIComponent("Book a call with Northvale next week"), "RoutePreview");
    ok(rp?.topicId === "partnerships" && typeof rp?.lead?.name === "string", "a Northvale call goes to partnerships with a lead");
    await view(url, "/topics/partnerships/access", "AccessView");

    // commands
    let res = await act(url, { type: "decision.approve", decisionId: "d1" });
    ok(res.status === 200, `approve d1 → 200 (got ${res.status})`);
    valid("CommandResult", res.body, "approve d1 result");
    ok((await get(url, "/decisions/d1")).body?.state === "approved", "d1 is approved");
    ok(((await get(url, "/brief")).body?.decisions ?? []).filter((d: any) => d.state === "open").length === 3, "three decisions stay open");
    res = await act(url, { type: "decision.undo", decisionId: "d1" });
    ok(res.status === 200 && (await get(url, "/decisions/d1")).body?.state === "open", "undo reopens d1");

    res = await act(url, { type: "lane.file", text: "Write a recap of the webinar for the newsletter", topicId: "content" });
    const laneId = res.body?.laneId;
    ok(res.status === 200 && typeof laneId === "string", "filing an ask returns its lane id");
    const nl = laneId ? (await get(url, `/lanes/${laneId}`)).body : null;
    ok(nl?.topicId === "content" && nl?.state === "new", "the new lane sits under content, state new");
    ok(by(by((await get(url, "/sidebar")).body?.groups, "id", "content")?.lanes, "id", laneId), "the new lane shows in the sidebar");

    res = await act(url, { type: "message.send", threadId: "topic:partnerships", text: "What is the status of Halden?" });
    ok(res.status === 200 && res.body?.message?.label?.kind === "question", "a question in a topic chat is labelled question");
    const msgId = res.body?.message?.id;
    res = await act(url, { type: "message.relabel", messageId: msgId, label: "request" });
    ok(res.status === 200 && res.body?.message?.label?.kind === "request" && res.body?.message?.label?.corrected === true, "relabel marks the label corrected");

    res = await act(url, { type: "prefs.set", theme: { id: "moss" } });
    ok(res.status === 200 && (await get(url, "/workspace")).body?.workspace?.theme?.id === "moss", "theme changes to moss");
    res = await act(url, { type: "decisionRight.set", rule: "inYourName", who: "agent", dailyLimit: 20 });
    const rule = by((await get(url, "/settings")).body?.decisionRights, "rule", "inYourName");
    ok(res.status === 200 && rule?.who === "agent" && rule?.dailyLimit === 20, "a decision right can go to the agent with a daily limit");
    res = await act(url, { type: "pin.add", pinId: "a-paid" });
    ok(res.status === 200 && ((await get(url, "/sidebar")).body?.pins ?? []).some((x: any) => x.id === "a-paid"), "pin a topic");

    const bad = await act(url, { type: "decision.approve" });
    ok(bad.status === 400, `a command the schema refuses → 400 (got ${bad.status})`);
    valid("ApiError", bad.body, "the refusal");

    await new Promise(r => setTimeout(r, 300));
    ok(eventFor("decision.changed", e => e.decisionId === "d1"), "the feed announced d1's change");
    ok(eventFor("lane.filed", e => e.laneId === laneId), "the feed announced the new lane");
    ok(eventFor("message.posted", e => e.threadId === "topic:partnerships"), "the feed announced the chat message");
    for (const e of events) valid("Event", e, `feed event ${e?.type}`);
    ws.close();
  } finally { child.kill(); }
}

async function dev() {
  const { child, url } = await start("dev");
  try {
    const w = await view(url, "/workspace", "WorkspaceView");
    ok(w?.module?.id === "dev" && w?.me?.name === "Timo Varga", "dev module, signed in as Timo Varga");
    const s = await view(url, "/sidebar", "SidebarView");
    const web = by(s?.groups, "name", "Web app");
    ok(web && web.kind === "project", "dev sidebar has the project Web app");
    if (web) await view(url, `/topics/${web.id}`, "TopicView");
    await view(url, "/brief", "BriefView");
    const pulls = await view(url, "/pulls", "PullsView");
    ok((pulls?.items ?? []).length === 5, "five pull requests");
    const d1 = await view(url, "/decisions/d1", "DecisionView");
    const tests = by(d1?.proof?.items, "label", "Tests");
    ok(tests?.value === "214 pass" && /failed before the fix/.test(tests?.sub ?? ""), "the release decision shows its proof");
    await view(url, "/skills", "SkillsView");
    await view(url, "/manager", "ManagerView");
  } finally { child.kill(); }
}

try {
  await gtm();
  await dev();
} catch (e) {
  fatal(String((e as Error)?.message ?? e));
}
console.log(`cockpit contract: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
