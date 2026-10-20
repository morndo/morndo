// The Memory service (ADR-0031): Notes written through the agents' tokens with their provenance (M3), superseded and
// invalidated, never edited (M2), approved only by the principal at the console (M4, M5); a search and a lane's skills
// carry deliverable Notes only; a lane sees a note that isn't deliverable only if it wrote it; and the bundle's version
// and parts are what every node is sent. Temporary directories, synthetic notes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS, MEMORY_SEARCH, type MemoryRememberBody } from "@morndo/protocol";
import { renderBundle, type BoardActor, type Note, type SkillFile } from "@morndo/domain";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import { MemoryService, bundleParts, bundleVersion, type MemoryResult } from "../src/application/memory-service.ts";

let dir: string;
let store: MemoryStore;
let memory: MemoryService;
let now: number;
const apiFix: BoardActor = { kind: "worker", name: "api-fix", token: "tok-w" };
const webFix: BoardActor = { kind: "worker", name: "web-fix", token: "tok-w" };
const manager: BoardActor = { kind: "manager", name: "manager", token: "tok-m" };
const fact = (over: Partial<MemoryRememberBody> = {}): MemoryRememberBody =>
  ({ kind: "fact", scope: "repo:shop-api", title: "Accounts come from the operator CLI", body: "Run the operator create command in the api pod.", ...over });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-memory-service-"));
  store = new MemoryStore(dir);
  now = Date.UTC(2026, 9, 20, 12);
  memory = new MemoryService({ store, now: () => now });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function made(r: MemoryResult): Note {
  if (!r.ok) throw new Error(`refused: ${r.problem}`);
  return r.note;
}
const problem = (r: { ok: boolean; problem?: string }) => (r.ok ? "ok" : r.problem);
const found = (q: Parameters<MemoryService["search"]>[0]) => {
  const r = memory.search(q);
  if (!r.ok) throw new Error(r.problem);
  return r.notes.map(n => n.id);
};

describe("remember (M3)", () => {
  it("writes a note with the token's provenance, the node and ref from the body, and the agent's tier", () => {
    const n = made(memory.remember(apiFix, fact({ node: "pc", ref: "session 42" })));
    expect(n).toMatchObject({ id: "N-1", tier: 3, provenance: { by: "lane:api-fix", node: "pc", ref: "session 42", untrusted: false } });
    expect(made(memory.remember(manager, fact({ title: "Second" }))).provenance.by).toBe("manager:manager");
    expect(store.events("N-1").map(e => e.change.kind)).toEqual(["proposed"]);
  });
  it("a refused note takes no number", () => {
    expect(problem(memory.remember(apiFix, fact({ scope: "team" })))).toBe("bad_scope");
    expect(problem(memory.remember(apiFix, fact({ node: "Bad Node" })))).toBe("bad_node");
    expect(made(memory.remember(apiFix, fact())).id).toBe("N-1");
  });
  it("supersedes with a successor of the same kind and scope (M2), only a note the caller can see", () => {
    const old = made(memory.remember(apiFix, fact()));
    now += 1000;
    const next = made(memory.remember(webFix, fact({ body: "Use the admin endpoint now.", supersedes: old.id })));
    expect(next).toMatchObject({ id: "N-2", supersedes: "N-1", provenance: { by: "lane:web-fix" } });
    expect(store.get(old.id)).toMatchObject({ invalidatedAt: now, supersededBy: "N-2", invalidatedBy: "lane:web-fix" });
    expect(store.events(old.id).map(e => e.change.kind)).toEqual(["proposed", "superseded"]);
    expect(problem(memory.remember(apiFix, fact({ supersedes: old.id })))).toBe("invalidated");   // its own, already superseded
    expect(problem(memory.remember(manager, fact({ supersedes: old.id })))).toBe("not_found");    // not deliverable, not its own
    expect(problem(memory.remember(webFix, fact({ supersedes: next.id, kind: "procedure" })))).toBe("mismatch");
    expect(problem(memory.remember(webFix, fact({ supersedes: "N-99" })))).toBe("not_found");
    // Another lane's unapproved procedure is not there for anyone else to supersede.
    const proc = made(memory.remember(apiFix, fact({ kind: "procedure", title: "Deploy steps" })));
    expect(problem(memory.remember(webFix, fact({ kind: "procedure", title: "Deploy steps", supersedes: proc.id })))).toBe("not_found");
  });
});

describe("invalidate and approve (M2, M4, M5)", () => {
  it("a lane's successor of an approved procedure leaves the old one in the lanes' skills until the console approves it", () => {
    const proc = made(memory.approve(made(memory.remember(apiFix, fact({ kind: "procedure", title: "Deploy steps" }))).id));
    const next = made(memory.remember(webFix, fact({ kind: "procedure", title: "Deploy steps", body: "New deploy steps.", supersedes: proc.id })));
    expect(store.get(proc.id)).toMatchObject({ invalidatedAt: null, supersededBy: null });
    expect(found({ q: "deploy" })).toEqual([proc.id]);
    expect(memory.bundle(now).parts.flat().some(f => f.content.includes("New deploy steps."))).toBe(false);
    now += 1000;
    made(memory.approve(next.id));
    expect(store.get(proc.id)).toMatchObject({ invalidatedAt: now, supersededBy: next.id, invalidatedBy: "principal:console" });
    expect(found({ q: "deploy" })).toEqual([next.id]);
    expect(store.events(proc.id).map(e => e.change.kind)).toEqual(["proposed", "approved", "superseded"]);
  });
  it("a lane invalidates only its own notes; the manager and the console any it can see", () => {
    const mine = made(memory.remember(apiFix, fact()));
    expect(problem(memory.invalidate(webFix, mine.id, "stale"))).toBe("not_yours");
    const gone = made(memory.invalidate(apiFix, mine.id, "stale"));
    expect(gone).toMatchObject({ invalidatedBy: "lane:api-fix", invalidReason: "stale" });
    expect(problem(memory.invalidate(apiFix, mine.id, "again"))).toBe("invalidated");
    const other = made(memory.remember(webFix, fact({ title: "Other" })));
    expect(made(memory.invalidate(manager, other.id, "wrong")).invalidatedBy).toBe("manager:manager");
    const third = made(memory.remember(webFix, fact({ title: "Third" })));
    expect(made(memory.invalidate("console", third.id, "outdated")).invalidatedBy).toBe("principal:console");
    expect(problem(memory.invalidate(manager, "N-99", "x"))).toBe("not_found");
  });
  it("only the console approves; approval makes the note the principal's and deliverable", () => {
    const proc = made(memory.remember(apiFix, fact({ kind: "procedure", title: "Release steps", body: "1. Tag. 2. Push." })));
    expect(found({ q: "release" })).toEqual([]);
    now += 60_000;
    const approved = made(memory.approve(proc.id));
    expect(approved).toMatchObject({ tier: 1, approvedAt: now, approvedBy: "principal:console" });
    expect(found({ q: "release" })).toEqual([proc.id]);
    expect(problem(memory.approve(proc.id))).toBe("already_approved");
    expect(problem(memory.approve("N-99"))).toBe("not_found");
    expect(store.events(proc.id).map(e => e.change.kind)).toEqual(["proposed", "approved"]);
  });
});

describe("search (M4, M5)", () => {
  it("returns deliverable notes only: no unapproved procedure, no untrusted note, nothing invalidated", () => {
    const ok = made(memory.remember(apiFix, fact({ title: "Ports", body: "The api listens on 8080." })));
    made(memory.remember(apiFix, fact({ kind: "procedure", title: "Ports procedure", body: "Open port 8080 first." })));
    made(memory.remember(apiFix, fact({ title: "Ports from a mail", body: "Someone wrote 8080 is wrong.", untrusted: true })));
    const gone = made(memory.remember(apiFix, fact({ title: "Ports old", body: "It was 8000 before 8080." })));
    memory.invalidate(apiFix, gone.id, "superseded by reality");
    expect(found({ q: "8080" })).toEqual([ok.id]);
    expect(found({ q: "" })).toEqual([ok.id]);
    expect(found({ q: "8080", kind: "procedure" })).toEqual([]);
  });
  it("checks the query's fields: length, scope, kind and a limit of 1 to 50", () => {
    for (let i = 0; i < 12; i++) memory.remember(apiFix, fact({ title: `Note ${i}` }));
    expect(found({ q: "operator" })).toHaveLength(MEMORY_SEARCH.limitDefault);
    expect(found({ q: "operator", limit: "3" })).toHaveLength(3);
    expect(found({ q: "operator", scope: "repo:web-app" })).toEqual([]);
    expect(problem(memory.search({ q: "x".repeat(MEMORY_SEARCH.query + 1) }))).toBe("bad_query");
    expect(problem(memory.search({ q: "x", scope: "team" }))).toBe("bad_scope");
    expect(problem(memory.search({ q: "x", kind: "rumour" }))).toBe("bad_kind");
    for (const limit of ["0", "51", "ten", "-1"]) expect(problem(memory.search({ q: "x", limit }))).toBe("bad_limit");
  });
});

describe("one note: deliverable, or the caller's own", () => {
  it("shows a lane its own unapproved procedure and its own invalidated note, and nobody else's", () => {
    const proc = made(memory.remember(apiFix, fact({ kind: "procedure", title: "Steps" })));
    const untrusted = made(memory.remember(apiFix, fact({ title: "From a page", untrusted: true })));
    const gone = made(memory.remember(apiFix, fact({ title: "Gone" })));
    memory.invalidate(apiFix, gone.id, "wrong");
    for (const n of [proc, untrusted, gone]) {
      expect(made(memory.note(apiFix, n.id)).id).toBe(n.id);
      expect(problem(memory.note(webFix, n.id))).toBe("not_found");
      expect(problem(memory.note(manager, n.id))).toBe("not_found");
      expect(made(memory.note("console", n.id)).id).toBe(n.id);
    }
    // A worker token naming the manager's lane is a lane called so: it never reads the manager's notes as its own.
    const managers = made(memory.remember(manager, fact({ kind: "procedure", title: "Manager steps" })));
    expect(problem(memory.note({ kind: "worker", name: "manager", token: "tok-w" }, managers.id))).toBe("not_found");
    expect(made(memory.note(manager, managers.id)).id).toBe(managers.id);
    const plain = made(memory.remember(apiFix, fact({ title: "Plain" })));
    expect(made(memory.note(webFix, plain.id)).id).toBe(plain.id);
    expect(problem(memory.note(webFix, "N-0"))).toBe("not_found");
  });
});

describe("the bundle every node receives", () => {
  it("has a stable version: the same notes give the same files and version; a change gives another", () => {
    made(memory.remember(apiFix, fact()));
    const a = memory.bundle();
    const b = memory.bundle();
    expect(a.version).toMatch(/^[a-f0-9]{32}$/);
    expect(b.version).toBe(a.version);
    const files = renderBundle(store.list(), now);
    expect(bundleVersion(files)).toBe(a.version);
    expect(bundleVersion([...files].reverse().concat({ name: "morndo-mem-x", content: "" }))).not.toBe(a.version);
    const n = made(memory.remember(apiFix, fact({ title: "Another" })));
    const c = memory.bundle();
    expect(c.version).not.toBe(a.version);
    memory.invalidate(apiFix, n.id, "undo");
    expect(memory.bundle().version).toBe(a.version);                 // back to the same notes
  });
  it("an unapproved procedure changes nothing a node receives; its approval does", () => {
    const before = memory.bundle().version;
    const proc = made(memory.remember(apiFix, fact({ kind: "procedure", title: "Rotate keys" })));
    expect(memory.bundle().version).toBe(before);
    memory.approve(proc.id);
    const after = memory.bundle();
    expect(after.version).not.toBe(before);
    expect(after.parts.flat().map(f => f.name)).toContain(`morndo-mem-repo-shop-api-rotate-keys-${proc.id.toLowerCase()}`);
  });
  it("is an empty part when nothing is deliverable, so a node removes what it had", () => {
    expect(memory.bundle().parts).toEqual([[]]);
  });
  it("splits into parts of at most memoryPartBytes, in order, every file once", () => {
    const big = "x".repeat(30_000);
    const files: SkillFile[] = Array.from({ length: 40 }, (_, i) => ({ name: `morndo-mem-repo-shop-api-p${String(i).padStart(2, "0")}`, content: big }));
    const parts = bundleParts(files);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeGreaterThan(0);
      expect(p.reduce((s, f) => s + Buffer.byteLength(JSON.stringify(f)), 0)).toBeLessThanOrEqual(LIMITS.memoryPartBytes);
    }
    expect(parts.flat()).toEqual(files);
    const many = Array.from({ length: 900 }, (_, i) => ({ name: `morndo-mem-org-n${i}`, content: "x" }));
    expect(bundleParts(many).map(p => p.length)).toEqual([400, 400, 100]);
  });
});

describe("competing successors (M2)", () => {
  it("refuses the second approval when another successor replaced the note first, and keeps one live version", () => {
    const base = made(memory.approve(made(memory.remember(apiFix, fact({ kind: "procedure", title: "Rotate the key" }))).id));
    const a = made(memory.remember(webFix, fact({ kind: "procedure", title: "Rotate the key", body: "Version 2a.", supersedes: base.id })));
    const b = made(memory.remember(apiFix, fact({ kind: "procedure", title: "Rotate the key", body: "Version 2b.", supersedes: base.id })));
    made(memory.approve(a.id));
    expect(problem(memory.approve(b.id))).toBe("replaced_meanwhile");
    expect(store.get(b.id)).toMatchObject({ approvedAt: null, invalidatedAt: null });
    expect(found({ q: "rotate" })).toEqual([a.id]);
  });
});
