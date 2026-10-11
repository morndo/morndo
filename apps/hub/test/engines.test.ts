// The Engines page's hub side (ADR-0013): the adapter over the engine layer's CLI, run as a program (a fake with the
// real CLI's calls, shapes, exit codes and refusals: fixtures/fake-engines.mjs), and GET/POST /api/engines on a real
// HTTP server. The real CLI runs in e2e/engines.e2e.ts. Synthetic data only.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chainArg } from "@morndo/domain";
import { EnginesError, RESOLVE_AT_ONCE, enginesCli, nowFrom, providersFrom, rolesFrom } from "../src/adapters/engines-cli.ts";
import { log } from "../src/adapters/log.ts";
import { ENGINES_PROBE_TTL_MS, EnginesService } from "../src/application/engines-service.ts";
import { LIMITS } from "../src/adapters/http.ts";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

const FAKE = join(import.meta.dirname, "fixtures/fake-engines.mjs");
const provider = (name: string, o: Record<string, unknown> = {}) => ({
  provider: name, enabled: true, installed: true, login: "ok", login_source: "settings", marks: [], family: "x", label: `${name} CLI`, kind: "cli",
  models: [], efforts: ["low", "medium", "high"], ...o,
});
const state = () => ({
  enabled: false,
  review_other_provider: false,
  roles: {
    plan: { label: "Plan and brief", chain: ["claude:opus-5.5@high", "cursor:grok-9@high"] },
    "implement-backend": { label: "Implement: backend", chain: ["cursor:claude-sonnet-5.5@high", "claude:sonnet-5.5@high"], risk_chain: ["claude:opus-5.5@high"] },
    review: { label: "Review", chain: ["claude:opus-5.5@high", "codex:gpt-6-astra@high"], other_provider: false },
  },
  providers: [
    provider("claude", { models: ["opus-5.5", "sonnet-5.5"] }),
    provider("cursor", { models: ["claude-sonnet-5.5", "auto"], login: "missing", marks: ["cursor:claude-sonnet-5.5 until Wed 19:30"] }),
    provider("codex", { models: ["gpt-6-astra"], efforts: ["low", "high", "ultra"], marks: ["codex until Thu 08:00"] }),
    provider("agy", { models: ["gemini-3.1-pro"], installed: false }),
    provider("gemini", { models: ["gemini-3.1-pro"], enabled: false, efforts: [] }),
    provider("studio", { models: ["chatgpt", "gemini"], kind: "studio", efforts: [], login: "unknown" }),
  ],
  resolve: {
    "implement-backend": { picked: { entry: "claude:sonnet-5.5@high" }, skipped: [{ entry: "cursor:claude-sonnet-5.5@high", reason: "cursor is not signed in (settings)" }] },
    review: { picked: null, skipped: [] },
  },
});

let dir: string;
let env: NodeJS.ProcessEnv;
const settings = () => JSON.parse(readFileSync(join(dir, "engines.json"), "utf8"));
const calls = () => { try { return readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").map(l => JSON.parse(l) as string[]); } catch { return []; } };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-engines-"));
  writeFileSync(join(dir, "engines.json"), JSON.stringify(state()));
  env = { ...process.env, ENGINES_CONFIG: join(dir, "engines.json"), FAKE_ENGINES_LOG: join(dir, "calls.log") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("reading the engines through the CLI", () => {
  it("roles with their chains, risk chain and rule; providers with what the resolver reports; what runs now", async () => {
    const v = await enginesCli(FAKE, env).read();
    expect(v.enabled).toBe(false);
    expect(v.roles.map(r => r.role)).toEqual(["plan", "implement-backend", "review"]);
    const backend = v.roles[1];
    expect(backend?.chain.map(e => `${e.provider}:${e.model}@${e.effort}`)).toEqual(["cursor:claude-sonnet-5.5@high", "claude:sonnet-5.5@high"]);
    expect(backend?.riskChain).toEqual([{ provider: "claude", model: "opus-5.5", effort: "high" }]);
    expect(backend?.now).toEqual({ engine: "claude:sonnet-5.5@high", skipped: [{ engine: "cursor:claude-sonnet-5.5@high", reason: "cursor is not signed in (settings)" }] });
    expect(v.roles[2]?.now).toEqual({ engine: null, skipped: [] });                    // exit 3: nothing available
    expect(Object.fromEntries(v.providers.map(p => [p.name, p.availability]))).toEqual({
      claude: "ready", cursor: "signed_out", codex: "out_of_quota", agy: "not_installed", gemini: "off", studio: "unconfirmed",
    });
    expect(v.providers.find(p => p.name === "codex")).toMatchObject({ until: "Thu 08:00", efforts: ["low", "high", "ultra"] });
    expect(v.providers.find(p => p.name === "cursor")).toMatchObject({ until: null, pausedModels: [{ model: "claude-sonnet-5.5", until: "Wed 19:30" }] });
    expect(v.providers.find(p => p.name === "studio")?.kind).toBe("studio");
    expect(calls().every(c => !c.includes("set") && !c.includes("other-provider"))).toBe(true);   // reading writes nothing
  });
  it("the version changes when the settings change, and only then", async () => {
    const cli = enginesCli(FAKE, env);
    const a = (await cli.read()).version, b = (await cli.read()).version;
    expect(a).toBe(b);
    await cli.setChain("plan", ["claude:sonnet-5.5@high"], false);
    expect((await cli.read()).version).not.toBe(a);
  });
  it("the review rule is what the resolver applies: on when either the role's flag or review_other_provider is on", () => {
    expect(rolesFrom({ review: { chain: ["a:b"], other_provider: false, other_provider_effective: true, review_other_provider: true } })[0]?.otherProvider).toBe(true);
  });
  it("no half-support for a CLI before 9f3a28c: a role without other_provider_effective or a provider without efforts is a shape it doesn't know", () => {
    expect(() => rolesFrom({ plan: { chain: ["a:b"], other_provider: true } })).toThrow(/shape/);
    expect(() => providersFrom([{ provider: "x", models: ["m"], marks: [], installed: true, login: "ok" }])).toThrow(/shape/);
  });
  it("efforts: null (the provider lists none: any effort) stays null; [] (it takes none) stays []", () => {
    const [free, none] = providersFrom([
      { provider: "free", models: ["m"], efforts: null, marks: [], installed: true, login: "ok" },
      { provider: "none", models: ["m"], efforts: [], marks: [], installed: true, login: "ok" },
    ]);
    expect(free?.efforts).toBeNull();
    expect(none?.efforts).toEqual([]);
  });
  it("a shape it doesn't know is refused, not guessed at", () => {
    expect(() => rolesFrom([])).toThrow(EnginesError);
    expect(() => rolesFrom({ plan: { chain: [] } })).toThrow(/shape/);
    expect(() => rolesFrom({ plan: { chain: ["not an engine"] } })).toThrow(/shape/);
    expect(() => providersFrom([{ provider: "x", models: "all" }])).toThrow(/shape/);
    expect(() => nowFrom({ picked: null })).toThrow(/shape/);
  });
});

describe("writing through the CLI", () => {
  it("a chain is set at once, in order; --force only when asked", async () => {
    const cli = enginesCli(FAKE, env);
    await cli.setChain("review", ["codex:gpt-6-astra@ultra", "claude:opus-5.5@high"], false);
    await cli.setChain("plan", ["cursor:grok-9@high"], true);
    expect(settings().roles.review.chain).toEqual(["codex:gpt-6-astra@ultra", "claude:opus-5.5@high"]);
    expect(calls().filter(c => c[0] === "set")).toEqual([["set", "review", "codex:gpt-6-astra@ultra,claude:opus-5.5@high"], ["set", "plan", "cursor:grok-9@high", "--force"]]);
  });
  it("the rule is one atomic CLI write (--effective): off for review clears both flags the resolver reads; on sets the role's own", async () => {
    const s = state();
    s.review_other_provider = true;
    s.roles.review.other_provider = true;
    writeFileSync(join(dir, "engines.json"), JSON.stringify(s));
    const cli = enginesCli(FAKE, env);
    await cli.setOtherProvider("review", false);
    expect(settings()).toMatchObject({ review_other_provider: false, roles: { review: { other_provider: false } } });
    await cli.setOtherProvider("plan", true);
    expect(settings().roles.plan.other_provider).toBe(true);
    expect(settings().review_other_provider).toBe(false);
    // One write each, nothing read or written around it (PR #13 high review, finding 2: two writes could half land).
    expect(calls()).toEqual([["other-provider", "review", "off", "--effective"], ["other-provider", "plan", "on", "--effective"]]);
  });
  it("a model with commas inside [options] round-trips through the CLI's parse_chain and through set", async () => {
    // engine-layer src/engines/config.py parse_chain, read 2026-10-09: commas outside [] separate entries;
    // a comma inside a model's [options] is part of that entry.
    const chain = ["claude:opus-5.5[a=1,b=2]@high", "codex:gpt-6-astra@high"];
    // The real parser when this box has the engine-layer checkout (CI does not; the stand-in below covers that).
    const parser = process.env.ENGINES_PARSER ?? join(homedir(), "code/engine-layer/src/engines/config.py");
    if (existsSync(parser)) {
      const parsed = execFileSync("python3", ["-c", `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("engines_config", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print("\\n".join(str(e) for e in mod.parse_chain(sys.argv[2])))
`, parser, chainArg(chain)], { encoding: "utf8" }).trim().split("\n");
      expect(parsed).toEqual(chain);
    }
    await enginesCli(FAKE, env).setChain("plan", chain, false);
    expect(settings().roles.plan.chain).toEqual(chain);
    expect(calls().filter(c => c[0] === "set")).toEqual([["set", "plan", chainArg(chain)]]);
  });
  it("an argparse usage error (exit 2) is an unavailable CLI, not a refusal of the change", async () => {
    const program = join(dir, "usage.mjs");
    writeFileSync(program, "#!/usr/bin/env node\nprocess.stderr.write('usage: engines set [-h] [--force] role chain\\nengines set: error: unrecognized arguments: --force\\n');\nprocess.exit(2);\n");
    chmodSync(program, 0o755);
    await expect(enginesCli(program, env).setChain("plan", ["claude:opus-5.5@high"], true)).rejects.toMatchObject({
      kind: "unavailable", message: expect.stringContaining("unrecognized arguments"),
    });
  });
  it("a refusal carries the CLI's own reason; a missing or failing CLI is 'unavailable'", async () => {
    await expect(enginesCli(FAKE, env).setChain("review", ["claude:opus-5.5@ultra"], false)).rejects.toMatchObject({ kind: "refused", message: "claude:opus-5.5@ultra: claude takes no effort 'ultra' (allowed: low, medium, high)" });
    await expect(enginesCli(join(dir, "no-such-engines"), env).read()).rejects.toMatchObject({ kind: "unavailable", message: expect.stringContaining("can't run (ENOENT)") });
    await expect(enginesCli(FAKE, { ...env, FAKE_ENGINES_FAIL: "crash" }).read()).rejects.toMatchObject({ kind: "unavailable", message: expect.stringContaining("Traceback") });
    await expect(enginesCli(FAKE, { ...env, FAKE_ENGINES_FAIL: "garbage" }).read()).rejects.toMatchObject({ kind: "unavailable", message: "engines get didn't answer in JSON" });
  });
});

describe("GET and POST /api/engines", () => {
  let hub: InProcessHub;
  let now = Date.now();
  const as = (cookie: string) => ({ cookie: `__Host-morndo=${cookie}` });
  const view = async (cookie: string) => (await fetch(`${hub.base}/api/engines`, { headers: as(cookie) })).json() as Promise<{ version: string; roles: { role: string; otherProvider: boolean }[] }>;
  beforeEach(async () => { now = Date.now(); hub = await startInProcessHub({ engines: { bin: FAKE, env }, now: () => now }); });
  afterEach(async () => { await hub.close(); });

  it("only for a signed-in device", async () => {
    expect((await fetch(`${hub.base}/api/engines`)).status).toBe(401);
    expect((await hub.post("/api/engines", { version: "x", changes: [{ role: "plan", otherProvider: true }] })).status).toBe(401);
  });
  it("a save writes through the CLI, answers with the settings as they are now, and is in the audit log", async () => {
    const cookie = await hub.cookie();
    const before = await view(cookie);
    const r = await hub.post("/api/engines", { version: before.version, changes: [{ role: "review", chain: ["codex:gpt-6-astra@high", "claude:opus-5.5@high"], otherProvider: true }] }, as(cookie));
    expect(r.status).toBe(200);
    const after = await r.json() as { version: string; roles: { role: string; otherProvider: boolean }[] };
    expect(after.version).not.toBe(before.version);
    expect(after.roles.find(x => x.role === "review")?.otherProvider).toBe(true);
    expect(settings().roles.review).toMatchObject({ chain: ["codex:gpt-6-astra@high", "claude:opus-5.5@high"], other_provider: true });
    // One entry per write, oldest first: the chain, then the rule.
    const audit = hub.store.audit(5).filter(a => a.type === "EnginesChanged").map(a => a.body).reverse();
    expect(audit).toEqual([
      expect.objectContaining({ role: "review", chain: ["codex:gpt-6-astra@high", "claude:opus-5.5@high"] }),
      expect.objectContaining({ role: "review", otherProvider: true }),
    ]);
  });
  it("refused before anything is written: a bad effort or unknown role (400), a change made elsewhere since (409)", async () => {
    const cookie = await hub.cookie();
    const { version } = await view(cookie);
    const bad = await hub.post("/api/engines", { version, changes: [{ role: "plan", chain: ["claude:sonnet-5.5"] }, { role: "review", chain: ["claude:opus-5.5@ultra"] }] }, as(cookie));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "unknown_effort", role: "review" });
    expect((await hub.post("/api/engines", { version, changes: [{ role: "deploy", otherProvider: true }] }, as(cookie))).status).toBe(400);
    const copy = await hub.post("/api/engines", { version, changes: [{ role: "review", chain: ["claude:opus-5.5@high", "claude:opus-5.5@high"] }] }, as(cookie));
    expect(await copy.json()).toEqual({ error: "duplicate", role: "review", engine: "claude:opus-5.5@high" });
    expect(settings().roles.plan.chain).toEqual(["claude:opus-5.5@high", "cursor:grok-9@high"]);     // the first change wasn't written either
    await enginesCli(FAKE, env).setChain("plan", ["claude:sonnet-5.5@high"], false);              // the manager changed it meanwhile
    const stale = await hub.post("/api/engines", { version, changes: [{ role: "review", otherProvider: true }] }, as(cookie));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "changed" });
    expect(settings().roles.review.other_provider).toBe(false);
  });
  it("the chain limit: past it the refusal names the role; a role already over it saves when it doesn't grow", async () => {
    const cookie = await hub.cookie();
    // Ten different engines the fixture's providers take.
    const long = [...["opus-5.5", "sonnet-5.5"].flatMap(m => ["@low", "@medium", "@high", ""].map(x => `claude:${m}${x}`)), "codex:gpt-6-astra@low", "codex:gpt-6-astra@ultra"];
    const { version } = await view(cookie);
    const r = await hub.post("/api/engines", { version, changes: [{ role: "plan", chain: long.slice(0, 9) }] }, as(cookie));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "too_long", role: "plan" });
    await enginesCli(FAKE, env).setChain("plan", long, false);                         // 10, set from the terminal
    const v2 = (await view(cookie)).version;
    expect((await hub.post("/api/engines", { version: v2, changes: [{ role: "plan", chain: [...long].reverse() }] }, as(cookie))).status).toBe(200);
  });
  it("a held engine the CLI's set would refuse fails the check before any write: nothing half-lands", async () => {
    const s = state();
    s.roles.plan.chain = ["codex:gpt-6-astra@turbo", "claude:opus-5.5@high"];          // an effort codex doesn't take, set by hand
    writeFileSync(join(dir, "engines.json"), JSON.stringify(s));
    const cookie = await hub.cookie();
    const { version } = await view(cookie);
    const r = await hub.post("/api/engines", { version, changes: [
      { role: "review", chain: ["codex:gpt-6-astra@high", "claude:opus-5.5@high"] },
      { role: "plan", chain: ["claude:opus-5.5@high", "codex:gpt-6-astra@turbo"] },
    ] }, as(cookie));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "unknown_effort", role: "plan" });
    expect(settings().roles.review.chain).toEqual(["claude:opus-5.5@high", "codex:gpt-6-astra@high"]);
    expect(calls().filter(c => c[0] === "set")).toEqual([]);
  });
  it("no size cap of its own on a chain: a role of 70 set by hand saves reordered, and growing it is refused naming the role", async () => {
    const s = state();
    const models = Array.from({ length: 71 }, (_, i) => `m-${i}`);
    s.providers.push(provider("bulk", { models, efforts: [] }));
    s.roles.plan.chain = models.slice(0, 70).map(m => `bulk:${m}`);
    writeFileSync(join(dir, "engines.json"), JSON.stringify(s));
    const cookie = await hub.cookie();
    const { version } = await view(cookie);
    const reordered = await hub.post("/api/engines", { version, changes: [{ role: "plan", chain: [...s.roles.plan.chain].reverse() }] }, as(cookie));
    expect(reordered.status).toBe(200);
    const v2 = (await view(cookie)).version;
    const grown = await hub.post("/api/engines", { version: v2, changes: [{ role: "plan", chain: models.map(m => `bulk:${m}`) }] }, as(cookie));
    expect(grown.status).toBe(400);
    expect(await grown.json()).toEqual({ error: "too_long", role: "plan" });
  });
  it("a model set by hand outside the known list is kept with --force when the role is reordered", async () => {
    const cookie = await hub.cookie();
    const { version } = await view(cookie);
    const r = await hub.post("/api/engines", { version, changes: [{ role: "plan", chain: ["cursor:grok-9@high", "claude:opus-5.5@high"] }] }, as(cookie));
    expect(r.status).toBe(200);
    expect(calls().find(c => c[0] === "set")).toEqual(["set", "plan", "cursor:grok-9@high,claude:opus-5.5@high", "--force"]);
  });
  it("a save is a Command: past the step-up window it asks for the passkey again, and writes nothing", async () => {
    const cookie = await hub.cookie();
    const { version } = await view(cookie);
    now += 2 * 3_600_000;                                         // the default policy's step-up window is 1 h
    const r = await hub.post("/api/engines", { version, changes: [{ role: "review", otherProvider: true }] }, as(cookie));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "step_up" });
    expect(settings().roles.review.other_provider).toBe(false);
  });
  it("a CLI that can't answer is a 503 with its words; a body that doesn't fit is a 400", async () => {
    const cookie = await hub.cookie();
    expect((await hub.post("/api/engines", { version: "v", changes: [] }, as(cookie))).status).toBe(400);
    expect((await hub.post("/api/engines", { version: "v", changes: [{ role: "plan", chain: "claude:opus-5.5" }] }, as(cookie))).status).toBe(400);
    writeFileSync(join(dir, "engines.json"), "{ half a file");                 // the CLI crashes on it, with its own words
    const r = await fetch(`${hub.base}/api/engines`, { headers: as(cookie) });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: "unavailable", message: expect.stringMatching(/SyntaxError/) });
  });
});

describe("a save that goes wrong part way, and saves at once", () => {
  const save = (hub: InProcessHub, cookie: string, version: string, changes: unknown[]) =>
    hub.post("/api/engines", { version, changes }, { cookie: `__Host-morndo=${cookie}` });
  const versionOf = async (hub: InProcessHub, cookie: string) =>
    ((await (await fetch(`${hub.base}/api/engines`, { headers: { cookie: `__Host-morndo=${cookie}` } })).json()) as { version: string }).version;

  it("a write that fails after another succeeded: what was written is in the audit log and named in the answer", async () => {
    const hub = await startInProcessHub({ engines: { bin: FAKE, env: { ...env, FAKE_ENGINES_FAIL_ON: "other-provider" } } });
    try {
      const cookie = await hub.cookie();
      const r = await save(hub, cookie, await versionOf(hub, cookie), [{ role: "review", chain: ["codex:gpt-6-astra@high", "claude:opus-5.5@high"], otherProvider: true }]);
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ error: "unavailable", saved: ["review"] });
      expect(settings().roles.review.chain).toEqual(["codex:gpt-6-astra@high", "claude:opus-5.5@high"]);
      const audit = hub.store.audit(5).filter(a => a.type === "EnginesChanged").map(a => a.body);
      expect(audit).toEqual([expect.objectContaining({ role: "review", chain: ["codex:gpt-6-astra@high", "claude:opus-5.5@high"] })]);
      expect(audit[0]).not.toHaveProperty("otherProvider");
    } finally { await hub.close(); }
  });
  it("a store error after the CLI write landed: one busy retry still writes the audit row; a store that stays down is a logged 500 with no internal text", async () => {
    const chain = ["claude:sonnet-5.5@high"];
    const hub = await startInProcessHub({ engines: { bin: FAKE, env } });
    try {
      const cookie = await hub.cookie();
      const version = await versionOf(hub, cookie);
      let busy = 1;
      const orig = hub.store.record.bind(hub.store);
      hub.store.record = events => { if (busy > 0) { busy--; throw new Error("SQLITE_BUSY"); } orig(events); };
      const r = await save(hub, cookie, version, [{ role: "plan", chain }]);
      expect(r.status).toBe(200);
      expect(hub.store.audit(5).filter(a => a.type === "EnginesChanged").map(a => a.body)).toEqual([
        expect.objectContaining({ role: "plan", chain }),
      ]);
    } finally { await hub.close(); }

    const hub2 = await startInProcessHub({ engines: { bin: FAKE, env } });
    try {
      const cookie = await hub2.cookie();
      const version = await versionOf(hub2, cookie);
      hub2.store.record = () => { throw new Error("SQLITE_BUSY"); };
      const seen: unknown[] = [];
      const orig = log.error.bind(log);
      log.error = (message, error) => { seen.push(error ?? message); orig(message, error); };
      try {
        const r = await save(hub2, cookie, version, [{ role: "plan", chain }]);
        expect(r.status).toBe(500);
        const body = await r.json() as { error?: string; message?: string };
        expect(body).toEqual({ error: "internal error" });
        expect(JSON.stringify(body)).not.toContain("SQLITE_BUSY");
        expect(seen.some(e => e instanceof Error && e.message === "SQLITE_BUSY")).toBe(true);
        expect(settings().roles.plan.chain).toEqual(chain);
      } finally { log.error = orig; }
    } finally { await hub2.close(); }
  });
  it("every write made and its last read failing: the answer still names what was saved", async () => {
    const hub = await startInProcessHub({ engines: { bin: FAKE, env: { ...env, FAKE_ENGINES_FAIL_ON: "read-after-write" } } });
    try {
      const cookie = await hub.cookie();
      const r = await save(hub, cookie, await versionOf(hub, cookie), [{ role: "plan", otherProvider: true }]);
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ error: "unavailable", saved: ["plan"] });
    } finally { await hub.close(); }
  });
  it("trims an engine before engines set and the audit row", async () => {
    const hub = await startInProcessHub({ engines: { bin: FAKE, env } });
    try {
      const cookie = await hub.cookie();
      const version = await versionOf(hub, cookie);
      writeFileSync(join(dir, "calls.log"), "");
      const r = await save(hub, cookie, version, [{ role: "plan", chain: ["  claude:sonnet-5.5@high\n"] }]);
      expect(r.status).toBe(200);
      expect(calls().find(c => c[0] === "set")).toEqual(["set", "plan", "claude:sonnet-5.5@high"]);
      expect(hub.store.audit(5).filter(a => a.type === "EnginesChanged").map(a => a.body)).toEqual([
        expect.objectContaining({ role: "plan", chain: ["claude:sonnet-5.5@high"] }),
      ]);
    } finally { await hub.close(); }
  });
  it("two saves against the same version at once (phone and desktop): one is written, the other refused with 409", async () => {
    const hub = await startInProcessHub({ engines: { bin: FAKE, env } });
    try {
      const cookie = await hub.cookie();
      const v = await versionOf(hub, cookie);
      const [a, b] = await Promise.all([
        save(hub, cookie, v, [{ role: "plan", chain: ["claude:sonnet-5.5@high"] }]),
        save(hub, cookie, v, [{ role: "plan", chain: ["codex:gpt-6-astra@high"] }]),
      ]);
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
      expect(calls().filter(c => c[0] === "set")).toHaveLength(1);
    } finally { await hub.close(); }
  });
});

describe("what a save and a look cost", () => {
  it("a save reads the providers once, then the roles again after the write", async () => {
    const hub = await startInProcessHub({ engines: { bin: FAKE, env } });
    try {
      const cookie = await hub.cookie();
      const { version } = await (await fetch(`${hub.base}/api/engines`, { headers: { cookie: `__Host-morndo=${cookie}` } })).json() as { version: string };
      writeFileSync(join(dir, "calls.log"), "");
      const r = await hub.post("/api/engines", { version, changes: [{ role: "plan", otherProvider: true }] }, { cookie: `__Host-morndo=${cookie}` });
      expect(r.status).toBe(200);
      expect(calls().filter(c => c[0] === "providers")).toHaveLength(1);
      expect(calls().filter(c => c[0] === "get")).toHaveLength(2);
    } finally { await hub.close(); }
  });
  it("a page view resolves roles a few at a time, not every role at once", async () => {
    const s = state();
    const roles = s.roles as Record<string, { label: string; chain: string[] }>;
    for (let i = 0; i < 5; i++) roles[`extra-${i}`] = { label: `Extra ${i}`, chain: ["claude:opus-5.5@high"] };
    writeFileSync(join(dir, "engines.json"), JSON.stringify(s));
    const stamp = join(dir, "resolve-stamp.log");
    const hub = await startInProcessHub({ engines: { bin: FAKE, env: { ...env, FAKE_ENGINES_PAUSE_RESOLVE: "50", FAKE_ENGINES_STAMP: stamp } } });
    try {
      const cookie = await hub.cookie();
      expect((await fetch(`${hub.base}/api/engines`, { headers: { cookie: `__Host-morndo=${cookie}` } })).status).toBe(200);
      const events = readFileSync(stamp, "utf8").trim().split("\n").map(line => {
        const [t, phase] = line.split(" ");
        return { t: Number(t), phase };
      });
      let active = 0, max = 0;
      for (const e of events) {
        if (e.phase === "start") max = Math.max(max, ++active);
        else active--;
      }
      expect(events.filter(e => e.phase === "start")).toHaveLength(8);
      expect(max).toBeLessThanOrEqual(RESOLVE_AT_ONCE);
      expect(max).toBeGreaterThan(1);
    } finally { await hub.close(); }
  });
  it("the check before a save reads only the settings and the providers: no resolve until the writes are done", async () => {
    const hub = await startInProcessHub({ engines: { bin: FAKE, env } });
    try {
      const cookie = await hub.cookie();
      const { version } = await (await fetch(`${hub.base}/api/engines`, { headers: { cookie: `__Host-morndo=${cookie}` } })).json() as { version: string };
      writeFileSync(join(dir, "calls.log"), "");
      const r = await hub.post("/api/engines", { version, changes: [{ role: "plan", otherProvider: true }] }, { cookie: `__Host-morndo=${cookie}` });
      expect(r.status).toBe(200);
      const c = calls().map(x => x[0] ?? "");
      const firstWrite = c.indexOf("other-provider");
      expect(firstWrite, `no write in ${JSON.stringify(c)}`).toBeGreaterThanOrEqual(0);
      expect(c.slice(0, firstWrite).sort((x, y) => x.localeCompare(y))).toEqual(["get", "providers"]);
    } finally { await hub.close(); }
  });
  it("GET /api/engines has its own read bucket: past it 429 with no CLI run, and looking never spends the commands a device answers with", async () => {
    const hub = await startInProcessHub({ engines: { bin: FAKE, env }, limits: { ...LIMITS, commands: { capacity: 1, refillPerSecond: 0.001 }, engineReads: { capacity: 2, refillPerSecond: 0.001 } } });
    try {
      const cookie = await hub.cookie();
      const get = () => fetch(`${hub.base}/api/engines`, { headers: { cookie: `__Host-morndo=${cookie}` } });
      const first = await get();
      expect(first.status).toBe(200);
      expect((await get()).status).toBe(200);
      const before = calls().length;
      const third = await get();
      expect(third.status).toBe(429);
      expect(third.headers.get("retry-after")).toMatch(/^\d+$/);
      expect(calls().length).toBe(before);
      // The one command token is still there: a save (or an answer to a lane) goes through.
      const { version } = await first.json() as { version: string };
      expect((await hub.post("/api/engines", { version, changes: [{ role: "plan", otherProvider: true }] }, { cookie: `__Host-morndo=${cookie}` })).status).toBe(200);
    } finally { await hub.close(); }
  });
});

describe("an engines CLI older than this page needs (before engine-layer 9f3a28c)", () => {
  it("is found by its missing other-provider --effective and refused clearly: 503 unsupported, saying what to update, nothing written", async () => {
    const hub = await startInProcessHub({ engines: { bin: FAKE, env: { ...env, FAKE_ENGINES_OLD: "1" } } });
    try {
      const cookie = await hub.cookie();
      const look = await fetch(`${hub.base}/api/engines`, { headers: { cookie: `__Host-morndo=${cookie}` } });
      expect(look.status).toBe(503);
      expect(await look.json()).toMatchObject({ error: "unsupported", message: expect.stringContaining("--effective") });
      const save = await hub.post("/api/engines", { version: "v", changes: [{ role: "plan", otherProvider: true }] }, { cookie: `__Host-morndo=${cookie}` });
      expect(save.status).toBe(503);
      expect(await save.json()).toMatchObject({ error: "unsupported" });
      expect(calls().filter(c => c[0] === "set" || (c[0] === "other-provider" && c[1] !== "--help"))).toEqual([]);
    } finally { await hub.close(); }
  });
  it("an unsupported verdict is asked again after a short while, and a save asks at once, so an update needs no hub restart", async () => {
    const old: NodeJS.ProcessEnv = { ...env, FAKE_ENGINES_OLD: "1" };
    let now = Date.now();
    const hub = await startInProcessHub({ engines: { bin: FAKE, env: old }, now: () => now });
    try {
      const cookie = await hub.cookie();
      const look = () => fetch(`${hub.base}/api/engines`, { headers: { cookie: `__Host-morndo=${cookie}` } });
      expect((await look()).status).toBe(503);
      expect((await look()).status).toBe(503);
      expect(calls().filter(c => c.includes("--help"))).toHaveLength(1);
      delete old.FAKE_ENGINES_OLD;
      const version = (await enginesCli(FAKE, old).settings()).version;
      const save = await hub.post("/api/engines", { version, changes: [{ role: "plan", otherProvider: true }] }, { cookie: `__Host-morndo=${cookie}` });
      expect(save.status).toBe(200);
      expect(calls().filter(c => c.includes("--help")).length).toBeGreaterThan(1);
    } finally { await hub.close(); }

    const again: NodeJS.ProcessEnv = { ...env, FAKE_ENGINES_OLD: "1" };
    writeFileSync(join(dir, "calls.log"), "");
    now = Date.now();
    const hub2 = await startInProcessHub({ engines: { bin: FAKE, env: again }, now: () => now });
    try {
      const cookie = await hub2.cookie();
      const look = () => fetch(`${hub2.base}/api/engines`, { headers: { cookie: `__Host-morndo=${cookie}` } });
      expect((await look()).status).toBe(503);
      now += ENGINES_PROBE_TTL_MS;
      delete again.FAKE_ENGINES_OLD;
      expect((await look()).status).toBe(200);
    } finally { await hub2.close(); }
  });
  it("one probe runs at a time, and an older answer never replaces a newer one", async () => {
    const gates: Array<(why: string | null) => void> = [];
    let calls = 0;
    let inflight = 0;
    let max = 0;
    const cli = {
      probe: () => {
        calls += 1;
        inflight += 1;
        max = Math.max(max, inflight);
        return new Promise<string | null>(resolve => {
          gates.push(why => { inflight -= 1; resolve(why); });
        });
      },
      read: async () => { throw new Error("unread"); },
      settings: async () => { throw new Error("unread"); },
      setChain: async () => {},
      setOtherProvider: async () => {},
    };
    const svc = new EnginesService({ cli, store: { record() {} } as never, policy: () => ({}) as never });
    const view = svc.ready();
    const save = svc.ready({ onSave: true });
    expect(calls).toBe(1);
    expect(max).toBe(1);
    gates[0]!("older than the Engines page needs");
    await view;
    expect(calls).toBe(2);
    expect(max).toBe(1);
    gates[1]!(null);
    expect(await save).toBeNull();
    expect(await svc.ready()).toBeNull();
    expect(calls).toBe(2);
  });
  it("a current one passes the probe once and is not asked again", async () => {
    const hub = await startInProcessHub({ engines: { bin: FAKE, env } });
    try {
      const cookie = await hub.cookie();
      for (let i = 0; i < 2; i++) expect((await fetch(`${hub.base}/api/engines`, { headers: { cookie: `__Host-morndo=${cookie}` } })).status).toBe(200);
      expect(calls().filter(c => c.includes("--help"))).toEqual([["other-provider", "--help"]]);
    } finally { await hub.close(); }
  });
});

describe("without MORNDO_ENGINES", () => {
  it("tells /api/me the page is off when the CLI is missing or too old, so the links stay hidden", async () => {
    const me = async (base: string, cookie: string) =>
      (await (await fetch(`${base}/api/me`, { headers: { cookie: `__Host-morndo=${cookie}` } })).json()) as { engines?: boolean };
    const missing = await startInProcessHub({ engines: { bin: join(dir, "no-such-engines"), env } });
    try {
      expect((await me(missing.base, await missing.cookie())).engines).toBe(false);
    } finally { await missing.close(); }
    const old = await startInProcessHub({ engines: { bin: FAKE, env: { ...env, FAKE_ENGINES_OLD: "1" } } });
    try {
      expect((await me(old.base, await old.cookie())).engines).toBe(false);
    } finally { await old.close(); }
  });
  it("tells /api/me the page is off, and on when the CLI is configured, so the links can follow", async () => {
    const off = await startInProcessHub();
    try {
      const cookie = await off.cookie();
      const me = await (await fetch(`${off.base}/api/me`, { headers: { cookie: `__Host-morndo=${cookie}` } })).json() as { engines?: boolean; connections?: boolean };
      expect(me.engines).toBe(false);
      expect(me.connections).toBe(false);
    } finally { await off.close(); }
    const on = await startInProcessHub({ engines: { bin: FAKE, env } });
    try {
      const cookie = await on.cookie();
      const me = await (await fetch(`${on.base}/api/me`, { headers: { cookie: `__Host-morndo=${cookie}` } })).json() as { engines?: boolean };
      expect(me.engines).toBe(true);
    } finally { await on.close(); }
  });
  it("the page is off: 404 engines_off", async () => {
    const hub = await startInProcessHub();
    try {
      const cookie = await hub.cookie();
      const r = await fetch(`${hub.base}/api/engines`, { headers: { cookie: `__Host-morndo=${cookie}` } });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "engines_off" });
    } finally { await hub.close(); }
  });
});
