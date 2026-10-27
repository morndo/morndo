// Review B12: every e2e file runs in `npm run e2e` and in CI (.github/workflows/ci.yml), as all the others do.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");
const scripts = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
// The e2e that run on their own, never in `npm run e2e` or CI: the updater's throwaway-machine runs (updates design
// §13) need Docker with CAP_SYS_ADMIN and some twenty minutes or more — one machine, and the fleet's two (PR 6d: two
// systemd containers and four Releases built, about half an hour, one heavy job at a time on a shared box). Neither
// is one that never runs: each has its own script. The adoption rehearsal (C6-0, e2e/update-adopt.e2e.ts) is the same kind:
// one systemd container, about ten minutes.
const OWN_SCRIPT: Record<string, string> = { "update.e2e.ts": "e2e:update", "update-fleet.e2e.ts": "e2e:update-fleet", "update-adopt.e2e.ts": "e2e:update-adopt" };
const e2e = readdirSync(join(ROOT, "e2e")).filter(f => f.endsWith(".e2e.ts") && !(f in OWN_SCRIPT)).sort();
const script = scripts.e2e ?? "";
const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

describe("B12: e2e files that never run", () => {
  it("each e2e/*.e2e.ts is in `npm run e2e`", () => {
    expect(e2e.filter(f => !script.includes(`e2e/${f}`))).toEqual([]);
  });
  it("an e2e that runs on its own has its own npm script, which runs it", () => {
    for (const [file, name] of Object.entries(OWN_SCRIPT)) expect(scripts[name], name).toBe(`node e2e/${file}`);
  });
  it("each e2e/*.e2e.ts is a CI step", () => {
    expect(e2e.filter(f => !ci.includes(`run: node e2e/${f}`))).toEqual([]);
  });
});
