#!/usr/bin/env node
// A stand-in for the engine layer's CLI (engine-layer bin/engines; its README "For Morndo", d600d21) in the hub's
// tests, and in e2e/engines.e2e.ts where the real CLI isn't installed (CI): the calls Morndo makes, with the same JSON
// shapes, exit codes (3: resolve found nothing) and refusals (exit 2, "engines: <why>" on stderr), on a JSON state file
// at $ENGINES_CONFIG; without one, the engine layer's shipped defaults as its CLI printed them
// (engines-defaults.json), written there on the first change, as the real CLI does. Also `login` and `mark`, which
// the e2e seeds with. Each call is logged to $FAKE_ENGINES_LOG. FAKE_ENGINES_FAIL=crash|garbage makes every call fail;
// FAKE_ENGINES_FAIL_ON=cmd[,cmd…] makes those commands crash, and "read-after-write" makes the look after a write
// crash (`get`, and `providers` if a caller asks again).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_ENGINES_LOG) appendFileSync(process.env.FAKE_ENGINES_LOG, `${JSON.stringify(args)}\n`);
if (process.env.FAKE_ENGINES_FAIL === "crash") { process.stderr.write("Traceback (most recent call last):\n  boom\n"); process.exit(1); }
if (process.env.FAKE_ENGINES_FAIL === "garbage") { process.stdout.write("not json\n"); process.exit(0); }

// argparse's help for other-provider, as the real CLI prints it before it reads anything; FAKE_ENGINES_OLD=1 plays one before 9f3a28c.
if (args[0] === "other-provider" && args[1] === "--help") {
  process.stdout.write(process.env.FAKE_ENGINES_OLD === "1"
    ? "usage: engines other-provider [-h] role {on,off}\n"
    : "usage: engines other-provider [-h] [--effective] role {on,off}\n");
  process.exit(0);
}

const file = process.env.ENGINES_CONFIG ?? "";
const defaults = join(import.meta.dirname, "engines-defaults.json");
const s = JSON.parse(readFileSync(existsSync(file) ? file : defaults, "utf8"));
const refuse = m => { process.stderr.write(`engines: ${m}\n`); process.exit(2); };
const save = () => { s._written = true; mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(s, null, 2)); };
const failOn = (process.env.FAKE_ENGINES_FAIL_ON ?? "").split(",");
const reread = failOn.includes("read-after-write") && s._written && (args[0] === "get" || args[0] === "providers" || args[0] === "option" || args[0] === "resolve");
// "resolve:ROLE" crashes that one role's resolve only.
if (failOn.includes(args[0]) || failOn.includes(`${args[0]}:${args[1]}`) || reread) {
  process.stderr.write(`Traceback (most recent call last):\n  ${args[0]} failed\n`);
  process.exit(1);
}
// FAKE_ENGINES_PAUSE_ON=cmd[,cmd…] holds those commands FAKE_ENGINES_PAUSE_MS before they answer, stamped as resolve is.
if ((process.env.FAKE_ENGINES_PAUSE_ON ?? "").split(",").includes(args[0])) {
  const stamp = process.env.FAKE_ENGINES_STAMP;
  if (stamp) appendFileSync(stamp, `${Date.now()} start ${args[0]}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_ENGINES_PAUSE_MS || 0));
  if (stamp) appendFileSync(stamp, `${Date.now()} end ${args[0]}\n`);
}
const out = v => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
// Same split as the CLI's parse_chain: a comma inside a model's [options] is part of that entry.
const splitChain = text => {
  const parts = [];
  let buf = "", depth = 0;
  for (const ch of text) {
    if (ch === "[") depth++;
    else if (ch === "]" && depth) depth--;
    else if (ch === "," && depth === 0) { parts.push(buf.trim()); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
};
const roleView = n => {
  const r = s.roles[n];
  return { ...r, other_provider_effective: !!r.other_provider || (n === "review" && s.review_other_provider), ...(n === "review" ? { review_other_provider: s.review_other_provider } : {}) };
};

switch (args[0]) {
  case "get": {
    const names = args[1] && args[1] !== "--json" ? [args[1]] : Object.keys(s.roles);
    if (!names.every(n => s.roles[n])) refuse(`unknown role '${args[1]}'`);
    out(Object.fromEntries(names.map(n => [n, roleView(n)])));
    break;
  }
  case "providers": out(s.providers); break;
  case "resolve": {
    if (!s.roles[args[1]]) refuse(`unknown role '${args[1]}'`);
    const pause = Number(process.env.FAKE_ENGINES_PAUSE_RESOLVE || 0);
    const stamp = process.env.FAKE_ENGINES_STAMP;
    if (stamp) appendFileSync(stamp, `${Date.now()} start ${args[1]}\n`);
    if (pause > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
    if (stamp) appendFileSync(stamp, `${Date.now()} end ${args[1]}\n`);
    // As the resolver checks, in its order: off, not installed, not signed in, a mark on the provider or the model.
    const why = entry => {
      const [provider, rest = ""] = entry.split(":");
      const p = s.providers.find(x => x.provider === provider);
      if (!p) return `unknown provider ${provider}`;
      if (p.enabled === false) return `${provider} is disabled in the settings`;
      if (!p.installed) return `${provider} is not installed`;
      if (p.login === "missing") return `${provider} is not signed in (settings)`;
      const key = `${provider}:${rest.split("@")[0]}`;
      const mark = (p.marks ?? []).find(m => m.startsWith(`${provider} `) || m.startsWith(`${key} `));
      return mark ? `${mark.split(" until ")[0]} marked until ${mark.split(" until ")[1]}` : null;
    };
    const resolved = () => {
      const skipped = [];
      for (const entry of s.roles[args[1]].chain) {
        const reason = why(entry);
        if (!reason) return { picked: { entry }, skipped };
        skipped.push({ entry, reason });
      }
      return { picked: null, skipped };
    };
    const r = s.resolve?.[args[1]] ?? resolved();
    out({ role: args[1], chain: "chain", picked: r.picked, skipped: r.skipped, warnings: [], rule: "" });
    process.exit(r.picked ? 0 : 3);
    break;
  }
  case "option": {
    if (args[2] === undefined) { out(s[args[1]]); break; }
    s[args[1]] = args[2] === "on";
    save();
    break;
  }
  case "set": {
    const [, role, chain, ...rest] = args;
    if (!s.roles[role]) refuse(`unknown role '${role}'`);
    const entries = splitChain(chain);
    for (const e of entries) {
      const [provider, rest2 = ""] = e.split(":");
      const [model, effort] = rest2.split("@");
      const p = s.providers.find(x => x.provider === provider);
      if (!p) refuse(`${e}: unknown provider '${provider}'`);
      if (effort && p.efforts !== null && !p.efforts.includes(effort)) refuse(`${e}: ${provider} takes no effort '${effort}' (allowed: ${p.efforts.join(", ")})`);
      // [options] don't count, as the CLI's known_model (config.py): the base model is what the list holds.
      if (p.models.length && !p.models.includes(model.split("[")[0]) && !rest.includes("--force")) refuse(`unknown model in ${e} (known per provider: engines providers); use --force if the id is right`);
    }
    s.roles[role].chain = entries;
    save();
    break;
  }
  case "other-provider": {                              // --effective, off: also the settings' review_other_provider for review
    if (!s.roles[args[1]]) refuse(`unknown role '${args[1]}'`);
    s.roles[args[1]].other_provider = args[2] === "on";
    if (args.includes("--effective") && args[2] === "off" && args[1] === "review") s.review_other_provider = false;
    save();
    break;
  }
  case "login": {
    const p = s.providers.find(x => x.provider === args[1]);
    if (!p) refuse(`unknown provider '${args[1]}'`);
    p.login = args[2];
    save();
    break;
  }
  case "mark": {                                        // mark KEY REASON --for MIN: "KEY until Wed 19:30" on its provider
    const minutes = Number(args[args.indexOf("--for") + 1] ?? 60);
    const p = s.providers.find(x => x.provider === args[1].split(":")[0]);
    if (!p) refuse(`unknown provider in '${args[1]}'`);
    const until = new Date(Date.now() + minutes * 60_000);
    const day = until.toLocaleDateString("en-GB", { weekday: "short" });
    p.marks = [...(p.marks ?? []), `${args[1]} until ${day} ${String(until.getHours()).padStart(2, "0")}:${String(until.getMinutes()).padStart(2, "0")}`];
    save();
    break;
  }
  default: refuse(`unknown command '${args[0]}'`);
}
