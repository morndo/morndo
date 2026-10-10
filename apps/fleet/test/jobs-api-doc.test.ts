// Every example fence in docs/jobs-api.md is sent to a real fleet. A fence that drifts from the API fails here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { client } from "./helpers/socket-client.ts";
import { startTestFleet } from "./helpers/fleet.ts";

const DOC = join(fileURLToPath(new URL(".", import.meta.url)), "../../../docs/jobs-api.md");
const AT = 1_700_000_000_000;

type Example = { name: string; method: string; path: string; body: unknown; status: number; answer: unknown };

function parseExamples(markdown: string): Example[] {
  const found: Example[] = [];
  const re = /```example ([a-z0-9-]+)\n([\s\S]*?)```/g;
  for (const hit of markdown.matchAll(re)) {
    const name = hit[1] ?? "";
    const raw = hit[2] ?? "";
    const cut = raw.split("\n---\n");
    if (cut.length !== 2) throw new Error(`${name}: expected a --- between the request and the answer`);
    const request = cut[0] ?? "";
    const answer = cut[1] ?? "";
    const lines = request.split("\n");
    const head = lines[0] ?? "";
    const [method, path] = head.split(" ");
    if (!method || !path?.startsWith("/")) throw new Error(`${name}: first line must be METHOD /path`);
    const payload = lines.slice(1).join("\n").trim();
    const statusLine = answer.trim().split("\n")[0] ?? "";
    const status = Number(statusLine);
    if (!Number.isInteger(status)) throw new Error(`${name}: the answer must start with a status`);
    const json = answer.trim().slice(statusLine.length).trim();
    found.push({ name, method, path, body: payload.length === 0 ? undefined : JSON.parse(payload), status, answer: JSON.parse(json) });
  }
  return found;
}

function covers(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((item, i) => covers(item, actual[i]));
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object") return false;
    const got = actual as Record<string, unknown>;
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) => covers(value, got[key]));
  }
  return Object.is(expected, actual);
}

const ev = (over: Record<string, unknown> = {}) => ({
  v: 1, t: "job",
  id: "job-1", node: "pc", lane: "builder", name: "pack", class: "default",
  state: "exited", outcome: "exited", exit: 0, durationSec: 1.5,
  notify: { kind: "lane", name: "builder" }, task: null, notice: "pending",
  at: AT, ended: AT, tail: "all good",
  position: null, reason: null, error: null,
  command: "npm test --secret", argv: ["npm", "test"],
  ...over,
});

describe("docs/jobs-api.md", () => {
  it("runs every example against a fleet", async () => {
    const examples = parseExamples(readFileSync(DOC, "utf8"));
    expect(examples.map(ex => ex.name)).toEqual(["list", "one", "missing", "cancel"]);
    const fleet = await startTestFleet();
    const owner = await fleet.online("pc");
    owner.send(ev());
    owner.send(ev({
      id: "job-9", state: "running", outcome: null, exit: null, durationSec: null, notice: "none", ended: null,
    }));
    const api = client(fleet.config.socketPath);
    await vi.waitFor(async () => expect((await api.get("/v1/jobs/pc/job-9"))?.status).toBe(200));
    for (const ex of examples) {
      const got = ex.method === "GET" ? await api.get(ex.path) : await api.post(ex.path, ex.body);
      expect(got, ex.name).not.toBeNull();
      expect(got?.status, ex.name).toBe(ex.status);
      expect(covers(ex.answer, got?.body), `${ex.name}: ${JSON.stringify(got?.body)}`).toBe(true);
      expect(JSON.stringify(got?.body), ex.name).not.toContain("secret");
      expect(JSON.stringify(got?.body), ex.name).not.toContain("npm test");
    }
    const sent = owner.reqs.filter(req => req.op === "job.cancel");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.args).toEqual({ id: "job-9", token: "lane-token" });
  });
});
