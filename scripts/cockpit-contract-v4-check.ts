// The cockpit API contract, fourth acceptance check: contract 1.2.0 (.keryx/runs/cockpit-contract-1-2/PLAN.md).
//
// 1.1.0 left two UI promises open. A decision did not say whether its reader may decide it, so a person without the
// right saw Approve and got a 403. And a topic without a goal (Research) could not have its budget or its priority
// changed, though it has a spend cap and the brief counts it. This check names the fields and drives the stand-in (gtm
// and dev). Every assertion is labelled with the plan's decision id (P1, C1..C6, R1..R7, and Q1..Q10 for what QA and the fresh
// review of round 02 found). It is locked: implementers do
// not edit it. The last sections draw their inputs per run; a failing run prints its seed and --seed N repeats it.
//
// usage: node scripts/cockpit-contract-v4-check.ts [--by-id] [--seed N]     exit 0 when every case passes

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";

const require = createRequire(import.meta.url);
const SCHEMA = "packages/cockpit-api/schema/cockpit.schema.json";
const OPENAPI = "packages/cockpit-api/schema/cockpit.openapi.json";
const STANDIN = "apps/cockpit-standin/src/main.ts";
const BASE = "/api/cockpit";
const VERSION = "1.2.0";
const IDS = ["P1", "C1", "C2", "C3", "C4", "C5", "C6", "R1", "R2", "R3", "R4", "R5", "R6", "R7",
  "Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8", "Q9", "Q10"];
const PEOPLE = ["lea-brandt", "jonas-falk", "tom-ahrens"];
const RULES = ["inYourName", "hardToUndo", "onlyYouKnow", "insideGuardrails", "overWeeklyCap"];

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
  console.log(`cockpit contract v4: ${passed} passed, ${failed + 1} failed`);
  process.exit(1);
}
const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);
const short = (v: unknown) => JSON.stringify(v)?.slice(0, 200);
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const isTime = (v: unknown) => typeof v === "string" && RFC3339.test(v) && !Number.isNaN(Date.parse(v));

// ---- schema and OpenAPI (P1 first: on the 1.1.0 base the first failure is the version)
if (!existsSync(SCHEMA)) fatal(`P1 no exported schema at ${SCHEMA}`);
const schema: any = JSON.parse(readFileSync(SCHEMA, "utf8"));
const openapi: any = existsSync(OPENAPI) ? JSON.parse(readFileSync(OPENAPI, "utf8")) : {};
const defs: Record<string, any> = schema.$defs ?? {};
ok(schema["x-contract-version"] === VERSION, `P1 the schema's x-contract-version is ${VERSION} (got ${schema["x-contract-version"]})`);
ok(openapi.info?.version === VERSION, `P1 the OpenAPI info.version is ${VERSION} (got ${openapi.info?.version})`);
ok(schema.$id === "urn:morndo:cockpit-api:1", `P1 the schema $id stays urn:morndo:cockpit-api:1 (got ${schema.$id})`);

// C1: canDecide is a required, non-null boolean on every shape that offers a decision's buttons
for (const name of ["DecisionView", "BriefDecision", "QueueItem"]) {
  const def = defs[name];
  const prop = def?.properties?.canDecide;
  ok(prop?.type === "boolean" && (def?.required ?? []).includes("canDecide"), `C1 ${name}.canDecide is a required boolean (got ${short(prop)})`);
  const text: string = prop?.description ?? "";
  ok(/owner/i.test(text) && /decision right/i.test(text) && /goal change/i.test(text) && /approve/i.test(text),
    `C1 ${name}.canDecide says who may decide: the owner, a decision right, never a goal change, and what the client hides (${short(text)})`);
}
ok(defs.DecisionView?.properties?.approveLabel?.type === "string", "C1 DecisionView.approveLabel stays a non-null string in 1.x");

// R7: the docs say budget and priority need no goal, and who holds a rank
{
  const gc = defs.GoalChange;
  const text = [gc?.description, gc?.properties?.budget?.description, gc?.properties?.priority?.description, gc?.properties?.field?.description]
    .filter(Boolean).join(" ");
  ok(/(without a goal|no goal)/i.test(text), `R7 GoalChange says a budget or priority change needs no goal (${short(text)})`);
  const prev = [gc?.properties?.previousDeadlineAt?.description, gc?.properties?.previousUnit?.description].join(" ");
  ok(/goal/i.test(prev) && /null/i.test(prev), `R7 GoalChange.previousDeadlineAt/previousUnit say they are null for a topic without a goal (${short(prev)})`);
  const meta = Object.values<any>(defs).find(d => d?.properties?.priority && d?.properties?.nextReportId);
  const p: string = meta?.properties?.priority?.description ?? "";
  ok(/goal/i.test(p) && /cap/i.test(p), `R7 the topic's priority says every topic with a goal or a spend cap holds a rank (${short(p)})`);
}

// ---- strict validator over the committed schema (as in v2 and v3)
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
ajv.addKeyword("x-contract-version");
ajv.addFormat("date-time", { type: "string", validate: (s: string) => isTime(s) });
ajv.addFormat("uri", { type: "string", validate: (s: string) => { try { new URL(s); return true; } catch { return false; } } });
try { ajv.addSchema(schema, "cockpit"); ajv.getSchema("cockpit#/$defs/WorkspaceView"); }
catch (e) { fatal(`P1 schema does not compile in Ajv strict mode: ${String((e as Error).message).slice(0, 300)}`); }
function valid(def: string, value: unknown, what: string) {
  const v = ajv.getSchema(`cockpit#/$defs/${def}`);
  if (!v) { ok(false, `META ${what}: no definition ${def}`); return; }
  if (!v(value)) ok(false, `META ${what} is a valid ${def}: ${ajv.errorsText(v.errors).slice(0, 200)}`);
}

// ---- the stand-in (a fresh instance per scenario)
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
const asOf = (as?: string) => (as ? `?as=${as}` : "");
const get = (url: string, path: string, as?: string) => http(url, path + asOf(as));
async function act(url: string, command: unknown, as?: string) {
  const r = await http(url, `/actions${asOf(as)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
  if (r.status === 200) valid("CommandResult", r.body, `the result of ${(command as any)?.type}`);
  return r;
}
function openFeed(url: string, as?: string) {
  const frames: any[] = [];
  const ws = new WebSocket(url.replace("http", "ws") + BASE + "/feed" + asOf(as));
  const opened = new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("feed did not open")); });
  ws.onmessage = m => { try { frames.push(JSON.parse(String(m.data))); } catch { /* not JSON: ignored */ } };
  return { ws, frames, opened };
}
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function scenario(name: string, module: Module, fn: (url: string) => Promise<void>) {
  let instance: Awaited<ReturnType<typeof start>> | undefined;
  try {
    instance = await start(module);
    await fn(instance.url);
  } catch (e) {
    ok(false, `${name}: the scenario ran to the end (${String((e as Error)?.message ?? e).slice(0, 200)})`);
  } finally { instance?.child.kill(); }
}
async function topicIds(url: string): Promise<string[]> {
  return ((await get(url, "/sidebar")).body?.groups ?? []).map((g: any) => g.id);
}
const decisionOf = (r: { body: any }): string | undefined => r.body?.message?.decisionId ?? undefined;
async function propose(url: string, threadTopic: string, text: string, as?: string) {
  const sent = await act(url, { type: "message.send", threadId: `topic:${threadTopic}`, text }, as);
  const id = decisionOf(sent);
  return { sent, id, gc: id ? (await get(url, `/decisions/${id}`)).body?.goalChange ?? null : null };
}


async function allPages(url: string, path: string, pick: (body: any) => any[]): Promise<any[]> {
  const items: any[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < 50; n++) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await http(url, `${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (r.status !== 200) break;
    items.push(...pick(r.body));
    cursor = typeof r.body?.nextCursor === "string" ? r.body.nextCursor : null;
    if (!cursor) break;
  }
  return items;
}
const withAs = (path: string, as?: string) => (as ? `${path}${path.includes("?") ? "&" : "?"}as=${as}` : path);
const historyRows = (url: string, topicId: string, as?: string) => allPages(url, withAs(`/topics/${topicId}/history`, as),
  body => (body?.days ?? []).flatMap((d: any) => d.entries ?? []).filter((e: any) => e.kind === "event"));
const threadMessages = (url: string, threadId: string, as?: string) => allPages(url, withAs(`/threads/${threadId}`, as), body => body?.messages ?? []);

// seeded draws
const seedArg = process.argv.indexOf("--seed");
const SEED = seedArg > 0 ? Number(process.argv[seedArg + 1]) : Math.floor(Math.random() * 1e9);
let seedState = SEED;
function rand(min: number, max: number): number {
  seedState = (seedState * 1664525 + 1013904223) % 4294967296;
  return min + Math.floor((seedState / 4294967296) * (max - min + 1));
}
const pick = <T>(list: T[]): T => list[rand(0, list.length - 1)] as T;

// ---- canDecide as one reader reads it, in the three shapes
type Seen = { id: string; state: string; view: unknown; brief: unknown; queue: unknown; goalChange: boolean; laneId: string | null };
async function rights(url: string, as?: string): Promise<Seen[]> {
  const queue = await get(url, "/decisions", as);
  const brief = await get(url, "/brief", as);
  if (queue.status === 200) valid("DecisionQueueView", queue.body, `GET /decisions as ${as ?? "owner"}`);
  if (brief.status === 200) valid("BriefView", brief.body, `GET /brief as ${as ?? "owner"}`);
  const seen: Seen[] = [];
  for (const item of queue.body?.items ?? []) {
    const view = await get(url, `/decisions/${item.id}`, as);
    if (view.status !== 200) continue;
    valid("DecisionView", view.body, `GET /decisions/${item.id} as ${as ?? "owner"}`);
    const card = (brief.body?.decisions ?? []).find((d: any) => d.id === item.id);
    seen.push({ id: item.id, state: view.body.state, view: view.body.canDecide, brief: card ? card.canDecide : "absent", queue: item.canDecide,
      goalChange: Boolean(view.body.goalChange), laneId: view.body.laneId ?? null });
  }
  return seen;
}
const agree = (s: Seen) => typeof s.view === "boolean" && s.view === s.queue && (s.brief === "absent" || s.brief === s.view);

// C4: the server's answer agrees with canDecide, for every open decision this reader reads; an approval is undone again
async function answersAgree(url: string, as: string | undefined, label: string) {
  const wrong: string[] = [];
  let tried = 0;
  for (const s of await rights(url, as)) {
    if (s.state !== "open") continue;
    tried++;
    const r = await act(url, { type: "decision.approve", decisionId: s.id }, as);
    const allowed = r.status === 200;
    if (allowed !== (s.view === true)) wrong.push(`${s.id} canDecide ${short(s.view)} approve ${r.status}`);
    if (!allowed && r.status !== 403) wrong.push(`${s.id} refused with ${r.status}, not 403`);
    if (allowed) {
      const back = await act(url, { type: "decision.undo", decisionId: s.id }, as);
      const state = (await get(url, `/decisions/${s.id}`)).body?.state;
      if (back.status !== 200 || state !== "open") wrong.push(`${s.id} undo by the same reader ${back.status} → ${state}`);
    }
    if (!s.view && as) {
      const d = await act(url, { type: "decision.decline", decisionId: s.id }, as);
      if (d.status !== 403) wrong.push(`${s.id} decline by a reader who may not decide → ${d.status}`);
    }
  }
  ok(wrong.length === 0, `C4 ${label}: approve and decline answer as canDecide says (${tried} open; ${wrong.slice(0, 4).join("; ")})`);
}

// C3: the three shapes agree with each other and with the decision's lane
async function shapesAgree(url: string, as: string | undefined, label: string) {
  const seen = await rights(url, as);
  const bad = seen.filter(s => !agree(s));
  ok(bad.length === 0, `C3 ${label}: DecisionView, the queue and the brief say the same canDecide (${short(bad.slice(0, 3))})`);
  if (as) {
    // "Yours to decide": a person's brief lists the decisions they may decide and counts only those
    const brief = (await get(url, "/brief", as)).body;
    const listed = ((brief?.decisions ?? []) as any[]).map(d => String(d.id)).sort((a, b) => a.localeCompare(b));
    const theirs = seen.filter(s => s.view === true).map(s => s.id).sort((a, b) => a.localeCompare(b));
    const open = seen.filter(s => s.view === true && s.state === "open").length;
    ok(same(listed, theirs) && brief?.openCount === open, `C3 ${label}: the brief lists exactly the decisions this person may decide and counts the open ones (${short(listed)} vs ${short(theirs)}; open ${short(brief?.openCount)} vs ${open})`);
  }
  const laneBad: string[] = [];
  for (const s of seen) {
    if (!s.laneId) continue;
    const lane = await get(url, `/lanes/${s.laneId}`, as);
    if (lane.status !== 200) continue;
    // the lane offers the act as the design draws it (some lanes only open the decision); a reader who may not decide
    // is offered nothing, and a reader who may is still led to the decision
    const offers = lane.body?.approveLabel != null || ((lane.body?.acts ?? []) as any[]).some(a => a?.id === "approve" || a?.id === "undo" || a?.target?.kind === "decision");
    const linked = lane.body?.decisionId === s.id;
    if (s.state === "open" && s.view !== true && (offers || linked)) laneBad.push(`${s.id}: canDecide ${short(s.view)}, the lane still offers it (label ${short(lane.body?.approveLabel)}, linked ${String(linked)})`);
    if (s.view === true && !linked) laneBad.push(`${s.id}: canDecide true, the lane does not name the decision`);
  }
  ok(laneBad.length === 0, `C3 ${label}: a reader who may not decide is offered nothing on the decision's lane; one who may is led to it (${laneBad.slice(0, 3).join("; ")})`);
  return seen;
}

// C6: a move that changes a reader's decisions sends them a frame for each changed one
async function decisionFrames(url: string, what: string, move: () => Promise<{ status: number; body: any }>) {
  const viewers = [undefined, ...PEOPLE];
  const feeds = viewers.map(v => openFeed(url, v));
  await Promise.all(feeds.map(f => f.opened));
  const read = async () => Promise.all(viewers.map(async v => {
    const out: Record<string, unknown> = {};
    for (const item of (await get(url, "/decisions", v)).body?.items ?? []) {
      const d = await get(url, `/decisions/${item.id}`, v);
      if (d.status === 200) out[item.id] = { canDecide: d.body.canDecide, state: d.body.state };
    }
    const brief = await get(url, "/brief", v);
    return { decisions: out, brief: (brief.body?.decisions ?? []).map((d: any) => [d.id, d.canDecide, d.state]) };
  }));
  const before = await read();
  const from = feeds.map(f => f.frames.length);
  const r = await move();
  await pause(400);
  const after = await read();
  const silent: string[] = [];
  viewers.forEach((v, i) => {
    const heard = feeds[i]!.frames.slice(from[i]);
    for (const id of new Set([...Object.keys(before[i]!.decisions), ...Object.keys(after[i]!.decisions)])) {
      if (same(before[i]!.decisions[id], after[i]!.decisions[id])) continue;
      // a decision the reader can no longer open is covered by their access.changed
      const gone = after[i]!.decisions[id] === undefined && heard.some(f => f.type === "access.changed");
      if (!gone && !heard.some(f => f.type === "decision.changed" && f.decisionId === id)) silent.push(`${v ?? "owner"} ${id}`);
    }
    if (!same(before[i]!.brief, after[i]!.brief) && !heard.some(f => f.type === "brief.changed" || f.type === "access.changed")) silent.push(`${v ?? "owner"} brief`);
  });
  feeds.forEach(f => f.ws.close());
  ok(r.status === 200 && silent.length === 0, `C6 ${what}: every reader whose decisions changed hears it (${r.status}; silent: ${silent.slice(0, 6).join(", ")})`);
}

// ---- topics: ranks, caps and the brief's total
async function topics(url: string, as?: string) {
  const out: { id: string; goal: boolean; cap: number | null; rank: number | null }[] = [];
  for (const id of await topicIds(url)) {
    const t = await get(url, `/topics/${id}`, as);
    if (t.status !== 200) continue;
    out.push({ id, goal: Boolean(t.body?.goal), cap: t.body?.spend?.cap?.amountMinor ?? null, rank: t.body?.meta?.priority ?? null });
  }
  return out;
}
async function ranksHold(url: string, label: string) {
  const ts = await topics(url);
  const held = ts.filter(t => t.goal || t.cap !== null);
  const ranks = held.map(t => t.rank).filter((r): r is number => typeof r === "number").sort((a, b) => a - b);
  ok(held.every(t => typeof t.rank === "number") && same(ranks, held.map((_, i) => i + 1)) && ts.filter(t => !t.goal && t.cap === null).every(t => t.rank === null),
    `R1 ${label}: every topic with a goal or a cap holds a rank, the ranks are 1..${held.length}, the others hold none (${short(ts.map(t => [t.id, t.rank]))})`);
  return ts;
}
async function briefSumsCaps(url: string, label: string) {
  const ts = await topics(url);
  const total = ts.reduce((sum, t) => sum + (t.cap ?? 0), 0);
  const cap = (await get(url, "/brief")).body?.spend?.cap?.amountMinor;
  ok(cap === total, `R2 ${label}: the brief's week cap is the sum of the topics' caps (${cap} vs ${total})`);
}
async function topicFrames(url: string, what: string, move: () => Promise<{ status: number; body: any }>) {
  const viewers = [undefined, ...PEOPLE];
  const feeds = viewers.map(v => openFeed(url, v));
  await Promise.all(feeds.map(f => f.opened));
  const ids = await topicIds(url);
  const read = async () => Promise.all(viewers.map(async v => Promise.all(ids.map(async id => {
    const r = await get(url, `/topics/${id}`, v);
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
  ok(r.status === 200 && silent.length === 0, `R3 ${what}: every viewer whose topic changed hears it (${r.status}; silent: ${silent.slice(0, 6).join(", ")})`);
}
const noGoalWords = async (url: string, id: string, label: string) => {
  const d = (await get(url, `/decisions/${id}`)).body;
  const card = ((await get(url, "/brief")).body?.decisions ?? []).find((x: any) => x.id === id);
  const words = [d?.shortTitle, d?.whyYours, d?.doneNote, d?.cardContext, d?.context, card?.whyYours, card?.context, card?.doneNote].filter(Boolean).join(" | ");
  ok(words.length > 0 && !/\bgoals?\b/i.test(words), `R6 ${label}: the decision names no goal Research does not have (${short(words)})`);
};

async function run() {
  // P1 at runtime
  await scenario("P1 gtm", "gtm", async url => {
    const w = await get(url, "/workspace");
    ok(w.headers.get("cockpit-contract") === VERSION && w.body?.contractVersion === VERSION, `P1 gtm names contract ${VERSION} (${w.headers.get("cockpit-contract")}, ${w.body?.contractVersion})`);
  });
  await scenario("P1 dev", "dev", async url => {
    const w = await get(url, "/workspace");
    ok(w.headers.get("cockpit-contract") === VERSION && w.body?.contractVersion === VERSION, `P1 dev names contract ${VERSION} (${w.headers.get("cockpit-contract")}, ${w.body?.contractVersion})`);
  });

  // C2: the owner decides everything, in both modules
  for (const module of ["gtm", "dev"] as Module[]) {
    await scenario(`C2 owner ${module}`, module, async url => {
      const seen = await shapesAgree(url, undefined, `${module} owner`);
      ok(seen.length > 0 && seen.every(s => s.view === true && s.queue === true && (s.brief === "absent" || s.brief === true)),
        `C2 ${module}: the owner may decide every decision (${short(seen.map(s => [s.id, s.view, s.queue, s.brief]))})`);
      await answersAgree(url, undefined, `${module} owner`);
    });
  }

  // C3, C4: people as the fixture starts; nobody holds a delegated right yet
  await scenario("C3 people as they start", "gtm", async url => {
    for (const p of PEOPLE) {
      const seen = await shapesAgree(url, p, p);
      ok(seen.every(s => s.view === false), `C3 ${p}: with no right handed to them, canDecide is false on all ${seen.length} decisions they read (${short(seen.filter(s => s.view !== false).map(s => s.id))})`);
      await answersAgree(url, p, `${p} as they start`);
    }
  });

  // C5: a right handed over flips canDecide for that person only; a goal change stays the owner's; handing it back flips it again
  await scenario("C5 delegation", "gtm", async url => {
    await act(url, { type: "access.set", topicId: "partnerships", personId: "jonas-falk", access: { kind: "all", stages: [] } });
    const rule = (await get(url, "/decisions/d4")).body?.rule;
    ok(RULES.includes(rule), `C5 d4 names its decision right (${rule})`);
    await decisionFrames(url, "handing d4's right to Jonas", () => act(url, { type: "decisionRight.set", rule, who: "agent", personId: "jonas-falk", dailyLimit: 20 }));
    const jonas = await shapesAgree(url, "jonas-falk", "Jonas with d4's right");
    const d4 = jonas.find(s => s.id === "d4");
    ok(d4?.view === true && d4?.queue === true && d4?.brief !== false, `C5 Jonas may now decide d4 (${short(d4)})`);
    ok(jonas.filter(s => s.id !== "d4").every(s => s.view === false || s.goalChange === false), "C5 Jonas decides no goal change");
    const lea = (await rights(url, "lea-brandt")).find(s => s.id === "d4");
    ok(!lea || lea.view === false, `C5 Lea still may not decide d4 (${short(lea)})`);
    const { id } = await propose(url, "partnerships", `Set the Partnerships budget to €${rand(61, 95)} a week`);
    ok(Boolean(id), "C5 the owner's budget ask is proposed");
    if (id) {
      await act(url, { type: "decisionRight.set", rule: (await get(url, `/decisions/${id}`)).body?.rule ?? rule, who: "agent", personId: "jonas-falk", dailyLimit: 20 });
      const g = (await rights(url, "jonas-falk")).find(s => s.id === id);
      ok(g?.view === false && g?.queue === false, `C5 a goal change stays the owner's, even for a delegate of its rule (${short(g)})`);
      ok((await act(url, { type: "decision.approve", decisionId: id }, "jonas-falk")).status === 403, "C5 Jonas's approval of the goal change is refused");
      ok((await rights(url)).find(s => s.id === id)?.view === true, "C5 the owner may decide the goal change");
    }
    await answersAgree(url, "jonas-falk", "Jonas with d4's right");
    await decisionFrames(url, "taking d4's right back", () => act(url, { type: "decisionRight.set", rule, who: "you" }));
    ok((await rights(url, "jonas-falk")).find(s => s.id === "d4")?.view === false, "C5 once the right is back with the owner, Jonas may not decide d4");
    await act(url, { type: "decisionRight.set", rule, who: "agent", personId: "jonas-falk", dailyLimit: 20 });
    await decisionFrames(url, "taking Jonas's full access to Partnerships", () => act(url, { type: "access.set", topicId: "partnerships", personId: "jonas-falk", access: { kind: "view", stages: [] } }));
    const watch = (await rights(url, "jonas-falk")).find(s => s.id === "d4");
    ok(!watch || watch.view === false, `C5 without full access the right does not decide (${short(watch)})`);
  });

  // R1: ranks
  await scenario("R1 ranks gtm", "gtm", async url => {
    const ts = await ranksHold(url, "gtm as it starts");
    const research = ts.find(t => t.id === "research");
    ok(research && !research.goal && research.cap !== null && typeof research.rank === "number", `R1 Research has no goal, a cap and a rank (${short(research)})`);
    ok((await get(url, "/topics/research", "tom-ahrens")).body?.meta?.priority == null, "R1 a reader without full access reads no rank on Research");
  });
  await scenario("R1 ranks dev", "dev", async url => {
    const ts = await ranksHold(url, "dev as it starts");
    ok(ts.length > 0 && ts.every(t => t.rank === null), "R1 dev projects (no goal, no cap) hold no rank");
    const name = (await get(url, `/topics/${ts[0]!.id}`)).body?.name;
    const { sent, id } = await propose(url, ts[0]!.id, `Make ${name} the top priority`);
    ok(sent.status === 200 && !id, `R1 a priority ask on a dev project proposes nothing (${sent.status}, ${id ?? "no decision"})`);
  });

  // R2: a budget change on Research, asked in its own chat and from another chat
  for (const thread of ["research", "paid"]) {
    await scenario(`R2 Research budget from ${thread}`, "gtm", async url => {
      const n = rand(21, 89);
      const text = pick([`Raise the Research budget to €${n} a week`, `Set the Research budget to ${n} euros per week`, `Give Research a budget of €${n} per week`]);
      const { id, gc } = await propose(url, thread, text);
      ok(gc?.field === "budget" && gc?.topicId === "research" && gc?.budget?.from?.amountMinor === 2000 && gc?.budget?.to?.amountMinor === n * 100 && gc?.budget?.period === "week",
        `R2 "${text}" (in ${thread}) proposes Research's cap €20 → €${n} a week (${short(gc && [gc.field, gc.topicId, gc.budget])})`);
      ok(gc?.previousDeadlineAt === null && gc?.previousUnit === null && !(gc?.affectedTopics ?? []).includes("research"), `R2 no goal values are made up (${short(gc && [gc.previousDeadlineAt, gc.previousUnit, gc.affectedTopics])})`);
      if (!id) return;
      await noGoalWords(url, id, "the budget change");
      await topicFrames(url, "approving Research's budget", () => act(url, { type: "decision.approve", decisionId: id }));
      ok((await get(url, "/topics/research")).body?.spend?.cap?.amountMinor === n * 100, `R2 Research's cap is €${n} once approved`);
      await briefSumsCaps(url, "after Research's budget");
      await act(url, { type: "decision.undo", decisionId: id });
      ok((await get(url, "/topics/research")).body?.spend?.cap?.amountMinor === 2000, "R2 undo puts Research's cap back to €20");
      await briefSumsCaps(url, "after the undo");
    });
  }

  // R3: Research's priority
  await scenario("R3 Research to the top", "gtm", async url => {
    const before = await topics(url);
    const from = before.find(t => t.id === "research")?.rank ?? null;
    const { id, gc } = await propose(url, "research", "Make Research the top priority");
    ok(gc?.field === "priority" && gc?.topicId === "research" && gc?.priority?.from === from && gc?.priority?.to === 1, `R3 "Make Research the top priority" asks rank ${from} → 1 (${short(gc?.priority)})`);
    const displaced = before.filter(t => t.id !== "research" && typeof t.rank === "number" && from !== null && t.rank < from).map(t => t.id);
    const affected: string[] = gc?.affectedTopics ?? [];
    ok(displaced.length > 0 && displaced.every(t => affected.includes(t)) && !affected.includes("research"),
      `R3 every topic it moves down is among the affected ones, never Research itself (${short(affected)} vs ${short(displaced)})`);
    if (!id) return;
    await noGoalWords(url, id, "the priority change");
    await topicFrames(url, "approving Research's priority", () => act(url, { type: "decision.approve", decisionId: id }));
    const after = await ranksHold(url, "after Research to the top");
    ok(after.find(t => t.id === "research")?.rank === 1 && before.filter(t => t.rank !== null && t.id !== "research").every(t => after.find(a => a.id === t.id)?.rank === t.rank! + (from !== null && t.rank! < from ? 1 : 0)),
      `R3 Research is first and the others moved down by one (${short(after.map(t => [t.id, t.rank]))})`);
  });
  await scenario("R4 a topic below Research", "gtm", async url => {
    const before = await topics(url);
    const last = before.filter(t => typeof t.rank === "number").sort((a, b) => b.rank! - a.rank!)[0];
    const above = before.find(t => t.rank === (last?.rank ?? 0) - 1);
    if (!last || !above) { ok(false, "R4 the gtm ranks have a last and a second-to-last topic"); return; }
    ok(last.id === "research", `R4 Research, the topic without a goal, starts last in the ranks (${last.id})`);
    const name = (await get(url, `/topics/${above.id}`)).body?.name;
    const { id, gc } = await propose(url, above.id, `Lower the priority of ${name}`);
    ok(gc?.field === "priority" && gc?.priority?.to === last.rank, `R4 "Lower the priority of ${name}" moves it to rank ${last.rank} (${short(gc?.priority)})`);
    if (!id) return;
    await act(url, { type: "decision.approve", decisionId: id });
    const after = await ranksHold(url, `after lowering ${name}`);
    ok(after.find(t => t.id === last.id)?.rank === above.rank, `R4 ${last.id} moves up to rank ${above.rank} (${short(after.map(t => [t.id, t.rank]))})`);
  });

  // R5: a target, deadline, unit or guardrail on a topic without a goal proposes nothing; the message is kept
  await scenario("R5 no goal fields on Research", "gtm", async url => {
    for (const text of ["Set the Research target to 12", "Move the Research deadline to 3 December 2026", "Change the Research unit to profiles",
      "Set the Research guardrail on spend to €30"]) {
      const { sent, id } = await propose(url, "research", text);
      const kept = ((await get(url, "/threads/topic:research")).body?.messages ?? []).some((m: any) => m.text === text);
      ok(sent.status === 200 && !id && kept, `R5 "${text}" proposes nothing and stays in the chat (${sent.status}, ${id ?? "no decision"}, kept ${kept})`);
    }
  });

  // R6: the owner decides a Research change; a delegate of its rule does not
  await scenario("R6 Research change and its decider", "gtm", async url => {
    await act(url, { type: "access.set", topicId: "research", personId: "lea-brandt", access: { kind: "all", stages: [] } });
    const { id } = await propose(url, "research", `Set the Research budget to €${rand(25, 60)} a week`);
    if (!id) { ok(false, "R6 the Research budget ask is proposed"); return; }
    const rule = (await get(url, `/decisions/${id}`)).body?.rule;
    await act(url, { type: "decisionRight.set", rule, who: "agent", personId: "lea-brandt", dailyLimit: 20 });
    const lea = (await rights(url, "lea-brandt")).find(s => s.id === id);
    ok(lea?.view === false && (await act(url, { type: "decision.approve", decisionId: id }, "lea-brandt")).status === 403, `R6 Lea, a delegate of its rule, may not decide Research's budget (${short(lea)})`);
    ok((await rights(url)).find(s => s.id === id)?.view === true, "R6 the owner may");
  });
}


// ---- what QA and the fresh review of round 02 found (Q1..Q10)
async function found() {
  // Q1: a chat message names a decision only to a reader who may open it
  await scenario("Q1 decision id in a shared chat", "gtm", async url => {
    await act(url, { type: "access.set", topicId: "outbound", personId: "jonas-falk", access: { kind: "all", stages: [] } });
    await act(url, { type: "access.set", topicId: "research", personId: "jonas-falk", access: { kind: "view", stages: [] } });
    const feed = openFeed(url, "jonas-falk");
    await feed.opened;
    const { id } = await propose(url, "outbound", `Give Research a budget of €${rand(21, 60)} each week`);
    await pause(300);
    feed.ws.close();
    ok(Boolean(id) && (await get(url, `/decisions/${id}`, "jonas-falk")).status === 403, "Q1 the Research budget is proposed and Jonas may not open it");
    const posted = feed.frames.filter(f => f.type === "message.posted" && f.message?.decisionId === id);
    const kept = (await threadMessages(url, "topic:outbound", "jonas-falk")).filter((m: any) => m.decisionId === id);
    ok(posted.length === 0 && kept.length === 0, `Q1 Jonas's Outbound chat and feed never name the decision he may not open (${posted.length} frames, ${kept.length} messages)`);
  });

  // Q2: history and Undo frames of a decision reach only readers who may open it
  await scenario("Q2 a stage reader and a decision's history", "gtm", async url => {
    await act(url, { type: "access.set", topicId: "partnerships", personId: "jonas-falk", access: { kind: "stages", stages: ["Offers"] } });
    await act(url, { type: "access.set", topicId: "partnerships", personId: "tom-ahrens", access: { kind: "all", stages: [] } });
    const rule = (await get(url, "/decisions/d4")).body?.rule;
    await act(url, { type: "decisionRight.set", rule, who: "agent", personId: "tom-ahrens", dailyLimit: 20 });
    const feed = openFeed(url, "jonas-falk");
    await feed.opened;
    const declined = await act(url, { type: "decision.decline", decisionId: "d4" }, "tom-ahrens");
    await act(url, { type: "decision.undo", decisionId: "d4" }, "tom-ahrens");
    await pause(300);
    feed.ws.close();
    ok(declined.status === 200 && (await get(url, "/decisions/d4", "jonas-falk")).status === 403, "Q2 Tom declines d4; Jonas, on the Offers stage only, may not open it");
    const rows = (await historyRows(url, "partnerships", "jonas-falk")).filter((e: any) => e.decisionId === "d4" || (e.undoable && /declin/i.test(e.text ?? "")));
    const frames = feed.frames.filter(f => f.type === "agentAction.changed" && /d4/.test(String(f.actionId)));
    ok(rows.length === 0 && frames.length === 0, `Q2 Jonas's history and feed carry nothing he could act on for d4 (${short(rows.slice(0, 2))}; ${frames.length} frames)`);
  });

  // Q3: the word "unit" in an ordinary request does not make it a goal change
  await scenario("Q3 a request that names a unit", "gtm", async url => {
    const lanes = async () => ((await get(url, "/topics/research")).body?.lanes ?? []).length;
    const before = await lanes();
    const text = pick(["Send the sample unit to the Juniper Workshop", "Ship the demo unit to the Corvane office by Friday"]);
    const r = await act(url, { type: "message.send", threadId: "topic:research", text });
    ok(r.status === 200 && r.body?.message?.label?.kind !== "goalChange" && (await lanes()) === before + 1, `Q3 "${text}" is filed as work, as in 1.1.0 (${short(r.body?.message?.label)}; lanes ${before} → ${await lanes()})`);
  });

  // Q4: an open priority change reads the ranks as they are now; an approved one keeps what it moved
  await scenario("Q4 two priority changes", "gtm", async url => {
    const research = await propose(url, "research", "Give Research priority 4");
    const seo = await propose(url, "seo", "Raise the priority of SEO to number 2");
    if (!research.id || !seo.id) { ok(false, `Q4 both priority asks are proposed (${research.id}, ${seo.id})`); return; }
    await act(url, { type: "decision.approve", decisionId: seo.id });
    const now = await topics(url);
    const from = now.find(t => t.id === "research")?.rank ?? 0;
    const passes = now.filter(t => t.id !== "research" && typeof t.rank === "number" && t.rank >= 4 && t.rank < from).map(t => t.id);
    const open = (await get(url, `/decisions/${research.id}`)).body?.goalChange;
    ok(open?.priority?.from === from && passes.every(t => (open?.affectedTopics ?? []).includes(t)) && !(open?.affectedTopics ?? []).includes("seo"),
      `Q4 after SEO moved, the open Research change names the topics it passes now (${short(open?.affectedTopics)} vs ${short(passes)}, from ${short(open?.priority?.from)})`);
    await act(url, { type: "decision.approve", decisionId: research.id });
    const approved = (await get(url, `/decisions/${research.id}`)).body?.goalChange;
    ok(passes.every(t => (approved?.affectedTopics ?? []).includes(t)), `Q4 the approved change keeps the topics it moved (${short(approved?.affectedTopics)})`);
    const applied = await Promise.all(passes.map(async t => ((await get(url, `/topics/${t}`)).body?.appliedGoalChanges ?? []).some((c: any) => c.topicId === "research" && c.field === "priority")));
    ok(applied.length > 0 && applied.every(Boolean), `Q4 each topic it moved lists the applied Research change (${short(passes)} ${short(applied)})`);
  });

  // Q5: an approval or an undo that changes a brief announces it
  await scenario("Q5 brief.changed on a decision", "gtm", async url => {
    await act(url, { type: "access.set", topicId: "outbound", personId: "lea-brandt", access: { kind: "all", stages: [] } });
    const rule = (await get(url, "/decisions/d2")).body?.rule;
    await act(url, { type: "decisionRight.set", rule, who: "agent", personId: "lea-brandt", dailyLimit: 20 });
    for (const [type, as] of [["decision.approve", "lea-brandt"], ["decision.undo", "lea-brandt"], ["decision.approve", undefined]] as const) {
      const feeds = [openFeed(url), openFeed(url, "lea-brandt")];
      await Promise.all(feeds.map(f => f.opened));
      const r = await act(url, { type, decisionId: "d2" }, as);
      await pause(300);
      feeds.forEach(f => f.ws.close());
      ok(r.status === 200 && feeds.every(f => f.frames.some(x => x.type === "brief.changed")), `Q5 ${type} of d2 by ${as ?? "the owner"}: the owner and Lea hear brief.changed (${r.status}; ${feeds.map(f => f.frames.map(x => x.type).join("/")).join(" | ")})`);
    }
  });

  // Q6: once a decision is settled, its lane and topic offer no Approve
  await scenario("Q6 settled decision labels", "gtm", async url => {
    const laneId = (await get(url, "/decisions/d2")).body?.laneId;
    await act(url, { type: "decision.approve", decisionId: "d2" });
    const lane = (await get(url, `/lanes/${laneId}`)).body;
    const topic = (await get(url, "/topics/outbound")).body;
    ok(lane?.approveLabel === null && (topic?.goal?.decision?.approveLabel ?? null) === null && (lane?.acts ?? []).some((a: any) => a.id === "undo"),
      `Q6 after approval the lane and the topic offer Undo, not Approve (${short([lane?.approveLabel, topic?.goal?.decision?.approveLabel, (lane?.acts ?? []).map((a: any) => a.id)])})`);
  });

  // Q7: the words a reader reads agree with canDecide
  await scenario("Q7 words and canDecide", "gtm", async url => {
    for (const p of ["lea-brandt", "tom-ahrens"]) await act(url, { type: "access.set", topicId: "outbound", personId: p, access: { kind: "all", stages: [] } });
    const rule = (await get(url, "/decisions/d2")).body?.rule;
    await act(url, { type: "decisionRight.set", rule, who: "agent", personId: "lea-brandt", dailyLimit: 20 });
    const laneId = (await get(url, "/decisions/d2")).body?.laneId;
    const leaLane = (await get(url, `/lanes/${laneId}`, "lea-brandt")).body;
    ok(/waits for you/i.test(leaLane?.standing?.headline ?? "") && /waits for you/i.test(leaLane?.stateWord ?? "Waits for you"), `Q7 the holder's lane says it waits for her (${short([leaLane?.standing?.headline, leaLane?.stateWord])})`);
    const tom = (await get(url, "/decisions/d2", "tom-ahrens")).body;
    ok(tom?.canDecide === false && !/^yours\b/i.test(tom?.whyYours ?? ""), `Q7 a reader who may not decide is not told it is theirs (${short(tom?.whyYours)})`);
    const lea = (await get(url, "/brief", "lea-brandt")).body;
    ok(lea?.openCount > 0 && /decision/i.test(lea?.lede ?? ""), `Q7 the holder's brief lede counts her open decisions (${lea?.openCount}: ${short(lea?.lede)})`);
    await act(url, { type: "decision.decline", decisionId: "d2" }, "lea-brandt");
    const seen = (await get(url, `/lanes/${laneId}`, "tom-ahrens")).body?.standing;
    ok(/^Lea\b/.test(seen?.headline ?? "") && !/Mara/.test(`${seen?.headline} ${seen?.detail}`), `Q7 who declined it reads the same in the headline and the detail (${short(seen)})`);
  });

  // Q8: the Manager names a Research change by its field
  await scenario("Q8 Manager words for Research", "gtm", async url => {
    const budget = await propose(url, "research", `Set the Research budget to €${rand(25, 60)} a week`);
    const rank = await propose(url, "research", "Raise the priority of Research");
    const words = async () => JSON.stringify([(await get(url, "/manager")).body?.asks, (await get(url, "/manager")).body?.since, (await get(url, "/threads/manager")).body?.since]);
    const open = await words();
    ok(Boolean(budget.id && rank.id), "Q8 both Research changes are proposed");
    const asks = ((await get(url, "/manager")).body?.asks ?? []).filter((a: any) => [budget.id, rank.id].includes(a.target?.id));
    ok(asks.length === 2 && asks.every((a: any) => !/goal/i.test(a.went ?? "")) && !/Research: a goal change/i.test(open), `Q8 the Manager's asks and since lines name no goal for Research (${short(asks.map((a: any) => a.went))})`);
    await act(url, { type: "decision.approve", decisionId: budget.id });
    const done = ((await get(url, "/manager")).body?.asks ?? []).find((a: any) => a.target?.id === budget.id);
    ok(done && !/goal/i.test(done.went ?? ""), `Q8 after approval it still names no goal (${short(done?.went)})`);
    const asked = "Set the Research target to 14";
    await act(url, { type: "message.send", threadId: "topic:research", text: asked });
    const thread: any[] = await threadMessages(url, "topic:research");
    const answer = thread.slice(thread.findLastIndex((m: any) => m.text === asked) + 1).at(0);
    ok(!/as a goal change/i.test(answer?.text ?? ""), `Q8 a target ask on Research is not called a kept goal change (${short(answer?.text)})`);
  });

  // Q9: handing a right over announces the lane and topic the person reads differently
  await scenario("Q9 lane and topic frames on a right", "gtm", async url => {
    await act(url, { type: "access.set", topicId: "partnerships", personId: "jonas-falk", access: { kind: "all", stages: [] } });
    const d4 = (await get(url, "/decisions/d4")).body;
    const feed = openFeed(url, "jonas-falk");
    await feed.opened;
    await act(url, { type: "decisionRight.set", rule: d4?.rule, who: "agent", personId: "jonas-falk", dailyLimit: 20 });
    await pause(300);
    feed.ws.close();
    ok(feed.frames.some(f => f.type === "lane.changed" && f.laneId === d4?.laneId) && feed.frames.some(f => f.type === "topic.changed" && f.topicId === "partnerships"),
      `Q9 Jonas hears lane.changed for ${d4?.laneId} and topic.changed for partnerships (${short(feed.frames.map(f => f.type))})`);
  });

  // Q10: a right handed to a reader without full access changes nothing they read and sends them nothing
  await scenario("Q10 a right without full access", "gtm", async url => {
    await act(url, { type: "access.set", topicId: "partnerships", personId: "jonas-falk", access: { kind: pick(["view", "stages"]), stages: ["Offers"] } });
    const before = JSON.stringify((await get(url, "/brief", "jonas-falk")).body?.decisions);
    const feed = openFeed(url, "jonas-falk");
    await feed.opened;
    await act(url, { type: "decisionRight.set", rule: (await get(url, "/decisions/d4")).body?.rule, who: "agent", personId: "jonas-falk", dailyLimit: 20 });
    await pause(300);
    feed.ws.close();
    const after = JSON.stringify((await get(url, "/brief", "jonas-falk")).body?.decisions);
    const told = feed.frames.filter(f => f.type === "decision.changed" || f.type === "brief.changed" || f.type === "lane.changed");
    ok(before === after && told.length === 0, `Q10 the right alone gives Jonas no card and no frame (${short(after)}; ${short(told)})`);
  });
}

// ---- drawn inputs: random access, random rights, random goal changes; the three shapes and the answer always agree
async function drawn() {
  for (let round = 0; round < 4; round++) {
    await scenario(`C4 drawn round ${round + 1}`, "gtm", async url => {
      const ids = await topicIds(url);
      const moves: string[] = [];
      for (const p of PEOPLE) {
        for (const t of ids) {
          const kind = pick(["all", "all", "view", "none", "keep"]);
          if (kind === "keep") continue;
          await act(url, { type: "access.set", topicId: t, personId: p, access: { kind, stages: [] } });
          moves.push(`${p} ${t} ${kind}`);
        }
      }
      for (const rule of RULES) {
        const who = pick(["you", "agent", ...PEOPLE]);
        if (who === "you") await act(url, { type: "decisionRight.set", rule, who: "you" });
        else await act(url, { type: "decisionRight.set", rule, who: "agent", personId: who === "agent" ? undefined : who, dailyLimit: 20 });
        moves.push(`${rule} ${who}`);
      }
      const t = pick(ids.filter(x => x !== "research"));
      const name = (await get(url, `/topics/${t}`)).body?.name;
      await propose(url, t, pick([`Set the ${name} budget to €${rand(20, 90)} a week`, `Make ${name} the top priority`, "Make Research the top priority", `Raise the Research budget to €${rand(21, 70)} a week`]));
      for (const reader of [undefined, ...PEOPLE]) {
        await shapesAgree(url, reader, `drawn round ${round + 1} ${reader ?? "owner"}`);
        const seen = await rights(url, reader);
        ok(!reader || seen.every(s => !s.goalChange || s.view === false), `C4 drawn round ${round + 1} ${reader}: no person decides a goal change`);
        await answersAgree(url, reader, `drawn round ${round + 1} ${reader ?? "owner"} [${moves.slice(-5).join(", ")}]`);
      }
    });
  }
  for (let round = 0; round < 3; round++) {
    await scenario(`R3 drawn rank ${round + 1}`, "gtm", async url => {
      const before = await topics(url);
      const ranked = before.filter(t => typeof t.rank === "number").length;
      const from = before.find(t => t.id === "research")?.rank ?? null;
      const to = rand(1, Math.max(1, ranked - 1));
      const text = pick([`Raise the priority of Research to number ${to}`, `Give Research priority ${to}`]);
      const { id, gc } = await propose(url, pick(["research", "seo"]), text);
      if (to === from) { ok(!id, `R3 "${text}" asks for the rank Research has: nothing to propose`); return; }
      ok(gc?.field === "priority" && gc?.priority?.to === to, `R3 "${text}" asks rank ${from} → ${to} (${short(gc?.priority)})`);
      if (!id) return;
      await topicFrames(url, `approving Research to rank ${to}`, () => act(url, { type: "decision.approve", decisionId: id }));
      const after = await ranksHold(url, `after Research to rank ${to}`);
      ok(after.find(t => t.id === "research")?.rank === to, `R3 Research holds rank ${to}`);
      await act(url, { type: "decision.undo", decisionId: id });
      const back = await topics(url);
      ok(same(back.map(t => [t.id, t.rank]), before.map(t => [t.id, t.rank])), `R3 undo restores every rank (${short(back.map(t => [t.id, t.rank]))})`);
    });
  }
}

try {
  await run();
  await found();
  await drawn();
} catch (e) {
  fatal(String((e as Error)?.message ?? e));
}
const missingIds = IDS.filter(id => !counts[id]);
ok(missingIds.length === 0, `META every plan decision has an assertion (missing ${missingIds.join(", ")})`);
if (process.argv.includes("--by-id")) console.log(IDS.map(id => `${id} ${counts[id] ?? 0}`).join(", "));
if (failed) console.log(`seed ${SEED}`);
console.log(`cockpit contract v4: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
