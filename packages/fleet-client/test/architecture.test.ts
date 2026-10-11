// The fleet client imports only the protocol, node:* and ws (docs/design/fleet-clients/plan.md, Global Constraints, DDD;
// ws for the events socket over a Unix socket): any client can take it without the hub, the fleet or the agent.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../src");
const importsOf = (code: string) => [...code.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1] ?? m[2] ?? "");

export const offending = (code: string) => importsOf(code).filter(spec =>
  !(/^\.\/[\w-]+\.ts$/.test(spec) || /^node:[\w/]+$/.test(spec) || spec === "@morndo/protocol" || spec === "ws"));

describe("fleet-client architecture", () => {
  it("every file imports only siblings, node:*, the protocol and ws", () => {
    const files = readdirSync(SRC).filter(f => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const bad = files.flatMap(f => offending(readFileSync(join(SRC, f), "utf8")).map(spec => `${f} -> ${spec}`));
    expect(bad).toEqual([]);
  });
  it("the check catches an app, another package or a relative path out of the package (negative controls)", () => {
    expect(offending(`import { log } from "../../../apps/hub/src/adapters/log.ts";`)).toEqual(["../../../apps/hub/src/adapters/log.ts"]);
    expect(offending(`import type { NodeState } from "../application/ports.ts";`)).toEqual(["../application/ports.ts"]);
    expect(offending(`import { sessionRegistry } from "@morndo/node-ops";`)).toEqual(["@morndo/node-ops"]);
    expect(offending(`import Database from "better-sqlite3";`)).toEqual(["better-sqlite3"]);
    expect(offending(`import { request } from "node:http";\nimport { WebSocket } from "ws";\nimport { LIMITS } from "@morndo/protocol";\nexport * from "./fleet-client.ts";`)).toEqual([]);
  });
});
