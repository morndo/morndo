// morndo-decide sends a date-only due unchanged. Lint resolves it in UTC, the same default the hub uses
// when the principal has not set a time zone, rather than in the machine's local zone.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { run, type Io } from "../src/decide.ts";

const doc = readFileSync(new URL("../../../docs/agents/decision-requests.md", import.meta.url), "utf8");
const example = () => {
  const at = doc.indexOf("## An example");
  const open = doc.indexOf("```markdown\n", at);
  const close = doc.indexOf("\n```", open + 12);
  return doc.slice(open + "```markdown\n".length, close + 1);
};

describe("morndo-decide and a date-only due", () => {
  it("lints in UTC, and new sends the markdown unchanged", async () => {
    const text = example();
    const err: string[] = [];
    const lint: Io = {
      fetch: async () => { throw new Error("lint does not call the hub"); },
      lane: async () => null,
      read: async () => text,
      out: () => {},
      err: l => err.push(l),
      now: () => Date.parse("2026-10-14T22:00:00.000Z"),
    };
    expect(await run(["lint", "brief.md"], {}, lint)).toBe(0);
    expect(err.join("\n")).not.toContain("due_past");

    let sent = "";
    const post: Io = {
      fetch: async (_url, init) => {
        const body = init?.body;
        sent = typeof body === "string" ? body : "";
        return new Response(JSON.stringify({ id: "d-1", version: 1, warnings: [] }), { status: 201, headers: { "content-type": "application/json" } });
      },
      lane: async () => "builder",
      read: async () => text,
      out: () => {},
      err: () => {},
      now: () => Date.parse("2026-10-01T12:00:00.000Z"),
    };
    expect(await run(["new", "brief.md"], { MORNDO_HUB: "https://hub.example.test", MORNDO_AGENT_TOKEN: "t", MORNDO_LANE: "builder" }, post)).toBe(0);
    expect(sent).toContain("due: 2026-10-14");
    expect(sent).not.toContain("2026-10-14T");
  });
});
