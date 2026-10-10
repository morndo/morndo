// node-ops imports no app (docs/design/fleet-core/README.md §12): the hub's local adapters and the node agent both run
// it, so it may lean on Node, the domain and the protocol, never on apps/* or another npm package.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../src");
const importsOf = (code: string) => [...code.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1] ?? m[2] ?? "");

export const offending = (code: string) => importsOf(code).filter(spec =>
  !(/^\.\/[\w-]+\.ts$/.test(spec) || /^node:[\w/]+$/.test(spec) || spec === "@morndo/domain" || spec === "@morndo/protocol"));

describe("node-ops architecture", () => {
  it("every node-ops file imports only siblings, node:*, the domain and the protocol", () => {
    const files = readdirSync(SRC).filter(f => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const bad = files.flatMap(f => offending(readFileSync(join(SRC, f), "utf8")).map(spec => `${f} -> ${spec}`));
    expect(bad).toEqual([]);
  });
  it("the check catches an app or a package (negative controls)", () => {
    expect(offending(`import { log } from "../../../apps/hub/src/adapters/log.ts";`)).toEqual(["../../../apps/hub/src/adapters/log.ts"]);
    expect(offending(`import type { Store } from "@morndo/hub";`)).toEqual(["@morndo/hub"]);
    expect(offending(`const ws = await import("ws");`)).toEqual(["ws"]);
    expect(offending(`import { spawn } from "child_process";`)).toEqual(["child_process"]);
    expect(offending(`import { spawn } from "node:child_process";\nexport * from "./tmux.ts";\nimport { LIMITS } from "@morndo/protocol";`)).toEqual([]);
  });
});
