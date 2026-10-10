#!/usr/bin/env node
// Stand-in for `engines`. CI has no engine-layer checkout; this file speaks the same argv the connections adapter uses.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const config = process.env.ENGINES_CONFIG || join(homedir(), ".config", "engines", "engines.json");
if (process.env.FAKE_ENGINES_LOG) appendFileSync(process.env.FAKE_ENGINES_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);

const defaults = () => ({
  roles: {
    plan: { chain: ["claude:opus-5.5@high"] },
    "implement-backend": { chain: ["cursor:claude-sonnet-5.5@high", "claude:opus-5.5@high"] },
    "implement-ui": { chain: ["cursor:claude-sonnet-5.5@high"] },
    review: { chain: ["claude:opus-5.5@high"] },
    research: { chain: ["claude:opus-5.5@high"] },
    validate: { chain: ["claude:opus-5.5@high"] },
  },
  providers: {
    claude: { enabled: true, kind: "cli", adapter: "claude", family: "anthropic", login: "ok", models: ["opus-5.5", "sonnet-5.5"], bin: "claude-as" },
    cursor: { enabled: true, kind: "cli", adapter: "cursor", family: "cursor", login: "ok", models: ["claude-sonnet-5.5"], bin: "agent" },
    codex: { enabled: true, kind: "cli", adapter: "codex", family: "openai", login: "ok", models: ["gpt-6-astra"], bin: "codex" },
    studio: { enabled: false, kind: "cli", adapter: "studio", family: "google", login: "unknown", bin: "studio" },
    "cursor-cloud": { enabled: true, kind: "cloud", adapter: "cursor-cloud", family: "cursor", login: "ok" },
    agy: { enabled: true, kind: "cli", adapter: "agy", family: "google", login: "ok", bin: "agy" },
    gemini: { enabled: false, kind: "cli", adapter: "gemini", family: "google", login: "unknown" },
  },
  marks: [],
});

const load = () => {
  if (!existsSync(config)) return defaults();
  const state = JSON.parse(readFileSync(config, "utf8"));
  state.roles ??= {};
  state.providers ??= {};
  state.marks ??= [];
  return state;
};
const save = (state) => {
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify(state));
};
const refuse = (why) => {
  console.error(`engines: ${why}`);
  process.exit(2);
};
const view = (row) => {
  const body = { chain: row.chain ?? [] };
  if (row.risk_chain !== undefined) body.risk_chain = row.risk_chain;
  return body;
};
const providerOf = (entry) => entry.split(":")[0] ?? entry;
const executable = (provider) => {
  const bin = provider.bin;
  if (Array.isArray(bin)) return typeof bin[0] === "string" ? bin[0] : "";
  return typeof bin === "string" ? bin : "";
};
const onPath = (file) => {
  if (file.startsWith("/")) return existsSync(file);
  return (process.env.PATH ?? "").split(":").some(dir => dir !== "" && existsSync(join(dir, file)));
};

const [cmd, ...rest] = process.argv.slice(2);
const state = load();

if (cmd === "get") {
  const role = rest.find(arg => !arg.startsWith("--"));
  const out = {};
  const roles = role ? [role] : Object.keys(state.roles);
  for (const name of roles) {
    const row = state.roles[name];
    if (!row) refuse(`unknown role '${name}'`);
    out[name] = view(row);
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

if (cmd === "set") {
  if (process.env.ENGINES_FAIL_SET === "1") refuse("blocked");
  const role = rest[0];
  if (!role || role.startsWith("--")) refuse("missing role");
  state.roles[role] ??= { chain: [] };
  if (rest.includes("--clear-risk")) {
    delete state.roles[role].risk_chain;
    save(state);
    process.exit(0);
  }
  const chain = rest.find((arg, index) => index > 0 && !arg.startsWith("--"));
  if (!chain) refuse("empty chain: give at least one provider:model");
  const entries = chain.split(",").filter(Boolean);
  if (entries.length === 0) refuse("empty chain: give at least one provider:model");
  if (rest.includes("--risk")) state.roles[role].risk_chain = entries;
  else state.roles[role].chain = entries;
  save(state);
  process.exit(0);
}

if (cmd === "providers") {
  const rows = Object.entries(state.providers).map(([name, provider]) => ({
    provider: name,
    enabled: provider.enabled !== false,
    installed: onPath(executable(provider)),
    login: provider.login ?? "unknown",
    family: provider.family ?? "",
    models: provider.models ?? [],
    efforts: provider.efforts ?? null,
    label: provider.label ?? "",
    kind: provider.kind ?? "cli",
    bin: Object.hasOwn(provider, "bin") ? provider.bin : "listing-default",
    probe: Object.hasOwn(provider, "probe") ? provider.probe : "listing-probe",
    held: state.marks.filter(mark => mark.name === name || mark.name.startsWith(`${name}:`)),
  }));
  console.log(JSON.stringify(rows));
  process.exit(0);
}

if (cmd === "provider") {
  const action = rest[0];
  const name = rest[1];
  if (action === "show") {
    const provider = state.providers[name];
    if (!provider) refuse(`unknown provider '${name}'`);
    console.log(JSON.stringify(provider));
    process.exit(0);
  }
  if (action === "set" && rest.includes("--batch")) {
    if (process.env.ENGINES_NO_BATCH === "1") refuse("usage: engines provider set NAME --json BODY");
    const body = rest[rest.indexOf("--batch") + 1];
    let items;
    try { items = JSON.parse(body ?? ""); }
    catch { refuse("provider set: body is not JSON"); }
    if (!Array.isArray(items)) refuse("provider set: batch is not a list");
    for (const item of items) {
      if (!item || typeof item.name !== "string") refuse("provider set: batch entry has no name");
      const fields = { ...item };
      delete fields.name;
      state.providers[item.name] = fields;
    }
    save(state);
    process.exit(0);
  }
  if (action === "set") {
    const jsonAt = rest.indexOf("--json");
    const body = jsonAt >= 0 ? rest[jsonAt + 1] : undefined;
    if (!name || !body) refuse("usage: engines provider set NAME --json BODY");
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { refuse("provider set: body is not JSON"); }
    state.providers[name] = parsed;
    save(state);
    process.exit(0);
  }
  const provider = state.providers[name];
  if (!provider) refuse(`unknown provider '${name}'`);
  if (action === "enable") {
    if (process.env.ENGINES_FAIL_ENABLE === "1") refuse("down");
    provider.enabled = rest[2] === "on";
    save(state);
    process.exit(0);
  }
  if (action === "remove") {
    for (const [role, row] of Object.entries(state.roles)) {
      const named = [...(row.chain ?? []), ...(row.risk_chain ?? [])].some(entry => entry === name || entry.startsWith(`${name}:`));
      if (named) refuse(`${name} is still in ${role}'s chain`);
    }
    delete state.providers[name];
    save(state);
    process.exit(0);
  }
  refuse(`unknown provider command '${action ?? ""}'`);
}

if (cmd === "mark") {
  const untilAt = rest.indexOf("--until");
  state.marks.push({ name: rest[0], reason: rest[1], until: Number(untilAt >= 0 ? rest[untilAt + 1] : 0) });
  save(state);
  process.exit(0);
}

if (cmd === "unmark") {
  state.marks = state.marks.filter(mark => mark.name !== rest[0]);
  save(state);
  process.exit(0);
}

if (cmd === "resolve") {
  const role = rest[0];
  const row = state.roles[role];
  if (!row) refuse(`unknown role '${role}'`);
  const chain = rest.includes("--risk") && row.risk_chain ? row.risk_chain : (row.chain ?? []);
  const skipped = [];
  let picked = null;
  for (const entry of chain) {
    const name = providerOf(entry);
    const provider = state.providers[name];
    let reason = "";
    if (!provider) reason = `unknown provider ${name}`;
    else if (provider.enabled === false) reason = `${name} is disabled in the settings`;
    else if (!onPath(executable(provider))) reason = `${name}: ${executable(provider) || name} is not installed`;
    else if ((provider.login ?? "unknown") === "missing") reason = `${name} is not signed in`;
    else {
      const mark = state.marks.find(item => (item.name === name || item.name === entry) && item.until > Date.now() / 1000);
      if (mark) reason = `${entry} marked until later: ${mark.reason}`;
    }
    if (reason) skipped.push({ entry, reason });
    else { picked = entry; break; }
  }
  for (const item of skipped) console.log(`skip  ${item.entry.padEnd(34)} ${item.reason}`);
  if (picked) console.log(`use   ${picked.padEnd(34)} family ${state.providers[providerOf(picked)].family ?? ""}`);
  else console.log(`none  nothing in ${role}'s chain is available`);
  process.exit(picked ? 0 : 3);
}

if (cmd === "login") {
  const provider = state.providers[rest[0]];
  if (!provider) refuse(`unknown provider '${rest[0]}'`);
  provider.login = rest[1];
  save(state);
  process.exit(0);
}

refuse(`unknown command '${cmd ?? ""}'`);
