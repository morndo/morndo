// The doc test's matcher (test/api-doc-examples.ts) on its own, with no fleet: what an example matches and what it doesn't
// (docs/fleet-api.md §4, "How to read the examples"). The "(negative control)" cases are the altered answers the spec asks
// for (fleet clients spec §12 "Contract"): each must fail to match, so a doc that drifted from the API fails its test.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { match, matchAnswer, matchEvents, parseExamples, substitute, type Vars } from "../api-doc-examples.ts";
import { ROOT } from "../fleet-harness.ts";

const m = (exp: unknown, act: unknown, vars: Vars = new Map()) => match(exp, act, vars);
const S = "6f1c2a8e-0b1d-4f5e-9a3b-2c4d5e6f7a8b";

describe("placeholders", () => {
  it("each kind matches its values, and only those", () => {
    expect(m("{{any}}", { x: 1 })).toBeNull();
    expect(m("{{string}}", "x")).toBeNull();
    expect(m("{{string}}", 1)).toMatch(/expected string/);
    expect(m("{{number}}", 1.5)).toBeNull();
    expect(m("{{number}}", "1")).toMatch(/expected number/);
    expect(m("{{time}}", Date.now())).toBeNull();
    expect(m("{{time}}", 1000)).toMatch(/expected time/);
    expect(m("{{uuid}}", S)).toBeNull();
    expect(m("{{uuid}}", "not-a-uuid")).toMatch(/expected uuid/);
    expect(m("{{workerId}}", "n1.0a1b2c3d.4")).toBeNull();
    expect(m("{{workerId}}", "%4")).toMatch(/expected workerId/);
  });

  it("binds a name the first time, then holds every later use to that value", () => {
    const vars: Vars = new Map();
    expect(m({ a: "{{number:n}}", b: "{{number:n}}" }, { a: 3, b: 3 }, vars)).toBeNull();
    expect(vars.get("n")).toBe(3);
    expect(m("{{number:n}}", 4, vars)).toMatch(/expected n = 3/);
  });

  it("an optional field may be absent, but not of another kind", () => {
    expect(m({ a: 1, b: "{{string?}}" }, { a: 1 })).toBeNull();
    expect(m({ a: 1, b: "{{string?}}" }, { a: 1, b: "x" })).toBeNull();
    expect(m({ a: 1, b: "{{string?}}" }, { a: 1, b: 2 })).toMatch(/\$\.b/);
  });

  it("an unordered list matches its items in any order, each once", () => {
    expect(m(["{{unordered}}", 1, 2], [2, 1])).toBeNull();
    expect(m(["{{unordered}}", 1, 1], [1, 2])).toMatch(/nothing matches/);
    expect(m(["{{unordered}}", 1], [1, 1])).toMatch(/1 items/);
  });

  it("a placeholder inside a string matches part of it, and binds it", () => {
    const vars: Vars = new Map();
    expect(m("n1:{{uuid:s}}:{{number}}", `n1:${S}:7`, vars)).toBeNull();
    expect(vars.get("s")).toBe(S);
    expect(m("n1:{{uuid:s}}:{{number}}", `n2:${S}:7`)).toMatch(/expected/);
  });

  it("substitutes bound names into a request, and refuses an unbound or an open one", () => {
    const vars: Vars = new Map<string, unknown>([["w1", "n1.0a1b2c3d.4"], ["n", 3], ["p", "/a b/c"]]);
    expect(substitute('{ "workerId": "{{workerId:w1}}", "since": "{{number:n}}" }', vars)).toBe('{ "workerId": "n1.0a1b2c3d.4", "since": 3 }');
    expect(substitute("/v1/files/n1/{{uri:p}}?since={{number:n}}", vars)).toBe("/v1/files/n1/%2Fa%20b%2Fc?since=3");
    expect(() => substitute('"{{string:nobody}}"', vars)).toThrow(/nothing bound to nobody/);
    expect(() => substitute('"{{string}}"', vars)).toThrow(/open placeholder/);
  });

  it("events match in their order, with others between them", () => {
    const got = [{ t: "status", n: 1 }, { t: "other" }, { t: "inventory" }];
    expect(matchEvents(['{"t":"status","n":"{{number}}"}', '{"t":"inventory"}'], got, new Map()).ok).toBe(true);
    expect(matchEvents(['{"t":"inventory"}', '{"t":"status","n":1}'], got, new Map()).ok).toBe(false);
  });
});

describe("(negative control) an altered answer fails", () => {
  it("a changed value", () => expect(m({ api: [1] }, { api: [2] })).toMatch(/\$\.api\[0\]/));
  it("a field the example doesn't name", () => expect(m({ a: 1 }, { a: 1, b: 2 })).toMatch(/not in the example/));
  it("a field the example names and the answer lacks", () => expect(m({ a: 1, b: 2 }, { a: 1 })).toMatch(/\$\.b: missing/));
  it("another status, or a header that differs", () => {
    const ok = { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
    expect(matchAnswer(ok, { ...ok }, new Map()).ok).toBe(true);
    expect(matchAnswer(ok, { ...ok, status: 409 }, new Map()).ok).toBe(false);
    expect(matchAnswer(ok, { ...ok, headers: { "content-type": "text/plain" } }, new Map()).ok).toBe(false);
  });
  it("the doc's own caps example, altered, fails against the answer it describes", () => {
    const caps = parseExamples(readFileSync(join(ROOT, "docs/fleet-api.md"), "utf8")).find(e => e.name === "caps");
    if (caps?.kind !== "http") throw new Error("docs/fleet-api.md has no request example named caps");
    const real = { status: 200, headers: { "content-type": "application/json" }, body: '{"api":[1],"stickyLanes":["manager"]}' };
    expect(matchAnswer(caps.answer, real, new Map()).ok).toBe(true);
    const altered = { ...caps.answer, body: caps.answer.body.replace('"manager"', '"boss"') };
    expect(matchAnswer(altered, real, new Map())).toMatchObject({ ok: false, why: expect.stringContaining("stickyLanes") });
  });
});

describe("the doc's examples parse", () => {
  it("every one: a unique name, known modifiers, known placeholders", () => {
    expect(parseExamples(readFileSync(join(ROOT, "docs/fleet-api.md"), "utf8")).length).toBeGreaterThanOrEqual(80);
  });
  it("a duplicate name, an unknown placeholder and an example without its answer are refused", () => {
    const one = "```example a\nGET /v1/caps\n---\n200\n```\n";
    expect(() => parseExamples(one + one)).toThrow(/used twice/);
    expect(() => parseExamples('```example b\nGET /v1/caps\n---\n200\n\n{"x":"{{date}}"}\n```\n')).toThrow(/unknown placeholder/);
    expect(() => parseExamples("```example c\nGET /v1/caps\n```\n")).toThrow(/no "---"/);
  });
});
