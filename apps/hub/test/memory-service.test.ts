// The Memory service (ADR-0031): Notes written through the agents' tokens with their provenance (M3), superseded and
// invalidated, never edited (M2), approved only by the principal (M4, M5, M8): an Endpoint under step-up, or the
// console with a one-time code that only a step-up session mints; a search and a lane's skills carry deliverable Notes
// only; a lane sees a note that isn't deliverable only if it wrote it; and the bundle's version and parts are what every
// node is sent. Temporary directories, synthetic notes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS, MEMORY_SEARCH, type MemoryRememberBody } from "@morndo/protocol";
import { endpointId, renderBundle, sessionId, type BoardActor, type Note, type SkillFile } from "@morndo/domain";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import {
  APPROVAL_CODE_FAILURES, APPROVAL_CODE_TTL_MS, MemoryService, bundleParts, bundleVersion, codeHash, normalCode, type MemoryResult,
} from "../src/application/memory-service.ts";
import type { Authenticated } from "../src/application/access-service.ts";

let dir: string;
let store: MemoryStore;
let memory: MemoryService;
let now: number;
const apiFix: BoardActor = { kind: "worker", name: "api-fix", token: "tok-w" };
const webFix: BoardActor = { kind: "worker", name: "web-fix", token: "tok-w" };
const manager: BoardActor = { kind: "manager", name: "manager", token: "tok-m" };
const fact = (over: Partial<MemoryRememberBody> = {}): MemoryRememberBody =>
  ({ kind: "fact", scope: "repo:shop-api", title: "Accounts come from the operator CLI", body: "Run the operator create command in the api pod.", ...over });
// The principal's signed-in Endpoint, as escalation-service.test.ts builds one. The policy is the service's default
// (DEFAULT_POLICY: a 1h step-up window), so `now - 2h` is a session that must verify again.
const auth = (verifiedAt = now): Authenticated => ({
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: verifiedAt, lastSeenAt: now, verifiedAt, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: now, revokedAt: null },
});
// The principal's answer: the actor a fresh step-up yields (M8).
const answer = (): BoardActor => {
  const a = memory.principal(auth());
  if ("problem" in a) throw new Error(a.problem);
  return a;
};

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
  it("a lane's successor of an approved procedure leaves the old one in the lanes' skills until the principal approves it", () => {
    const proc = made(memory.approve(answer(), made(memory.remember(apiFix, fact({ kind: "procedure", title: "Deploy steps" }))).id));
    const next = made(memory.remember(webFix, fact({ kind: "procedure", title: "Deploy steps", body: "New deploy steps.", supersedes: proc.id })));
    expect(store.get(proc.id)).toMatchObject({ invalidatedAt: null, supersededBy: null });
    expect(found({ q: "deploy" })).toEqual([proc.id]);
    expect(memory.bundle(now).parts.flat().some(f => f.content.includes("New deploy steps."))).toBe(false);
    now += 1000;
    made(memory.approve(answer(), next.id));
    expect(store.get(proc.id)).toMatchObject({ invalidatedAt: now, supersededBy: next.id, invalidatedBy: "principal:endpoint" });
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
  it("only the principal approves; approval makes the note the principal's and deliverable", () => {
    const proc = made(memory.remember(apiFix, fact({ kind: "procedure", title: "Release steps", body: "1. Tag. 2. Push." })));
    expect(found({ q: "release" })).toEqual([]);
    now += 60_000;
    const approved = made(memory.approve(answer(), proc.id));
    expect(approved).toMatchObject({ tier: 1, approvedAt: now, approvedBy: "principal:endpoint" });
    expect(found({ q: "release" })).toEqual([proc.id]);
    expect(problem(memory.approve(answer(), proc.id))).toBe("already_approved");
    expect(problem(memory.approve(answer(), "N-99"))).toBe("not_found");
    expect(problem(memory.approve("console", "N-99"))).toBe("not_found");
    expect(store.events(proc.id).map(e => e.change.kind)).toEqual(["proposed", "approved"]);
  });
});

describe("approval is the principal's (M8)", () => {
  it("approve without a principal answer is refused", () => {
    const proc = made(memory.remember(apiFix, fact({ kind: "procedure", title: "Release steps", body: "1. Tag. 2. Push." })));
    expect(problem(memory.approve(manager, proc.id))).toBe("not_principal");
    expect(problem(memory.approve(apiFix, proc.id))).toBe("not_principal");       // the author itself
    expect(found({ q: "release" })).toEqual([]);
    expect(problem(memory.approve("console", proc.id))).toBe("code_needed");
    expect(problem(memory.approve("console", proc.id, {}))).toBe("code_needed");
    expect(problem(memory.approve("console", proc.id, { code: "  " }))).toBe("code_needed");
    expect(found({ q: "release" })).toEqual([]);                                  // nothing got through
  });

  it("an approval needs a principal that passed step-up", () => {
    const proc = made(memory.remember(apiFix, fact({ kind: "procedure", title: "Deploy steps" })));
    expect(memory.principal(auth(now - 2 * 60 * 60_000))).toEqual({ problem: "step_up" });
    expect(memory.principal(auth())).toEqual({ kind: "principal", endpointId: "ep1", sessionId: "s1" });
    const approved = made(memory.approve(answer(), proc.id));
    expect(approved).toMatchObject({ tier: 1, approvedAt: now, approvedBy: "principal:endpoint" });
    expect(found({ q: "deploy" })).toEqual([proc.id]);
  });

  it("a one-time code approves one note once, and only at the console", () => {
    const a = made(memory.remember(apiFix, fact({ kind: "procedure", title: "Ports procedure" })));
    const b = made(memory.remember(webFix, fact({ kind: "procedure", title: "Release procedure" })));
    const issue = memory.issueApprovalCode(auth(), a.id);
    expect(issue.ok).toBe(true);
    if (!issue.ok) throw new Error(issue.problem);
    expect(issue.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(issue.expiresAt).toBe(now + APPROVAL_CODE_TTL_MS);
    // Typed lower-case without the dashes: the code is normalised before it is judged.
    const typed = issue.code.toLowerCase().replaceAll("-", "");
    expect(made(memory.approve("console", a.id, { code: typed })).approvedBy).toBe("principal:console");
    // Single use, and bound to one note: the spent code never works again, there or elsewhere.
    expect(problem(memory.approve("console", a.id, { code: typed }))).toBe("bad_code");
    expect(problem(memory.approve("console", b.id, { code: typed }))).toBe("bad_code");
    // A code is bound to the note it was minted for: x's never approves y.
    const x = made(memory.remember(apiFix, fact({ kind: "procedure", title: "Build procedure" })));
    const y = made(memory.remember(webFix, fact({ kind: "procedure", title: "Ship procedure" })));
    const forX = memory.issueApprovalCode(auth(), x.id);
    const forY = memory.issueApprovalCode(auth(), y.id);
    expect(forX.ok && forY.ok).toBe(true);
    if (!forX.ok || !forY.ok) throw new Error("minting refused");
    expect(problem(memory.approve("console", y.id, { code: forX.code }))).toBe("bad_code");
    expect(problem(memory.approve("console", y.id, { code: forY.code }))).toBe("ok");
    // One live code per note: a newer one replaces it.
    const c = made(memory.remember(apiFix, fact({ kind: "procedure", title: "Keys procedure" })));
    const first = memory.issueApprovalCode(auth(), c.id);
    const second = memory.issueApprovalCode(auth(), c.id);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("minting refused");
    expect(problem(memory.approve("console", c.id, { code: first.code }))).toBe("bad_code");
    expect(problem(memory.approve("console", c.id, { code: second.code }))).toBe("ok");
    // A code is never an answer for an agent caller, and minting needs a step-up session and a waiting note.
    const d = made(memory.remember(apiFix, fact({ kind: "procedure", title: "Last procedure" })));
    const code = memory.issueApprovalCode(auth(), d.id);
    expect(code.ok).toBe(true);
    if (!code.ok) throw new Error(code.problem);
    expect(problem(memory.approve(apiFix, d.id, { code: code.code }))).toBe("not_principal");
    expect(memory.issueApprovalCode(auth(now - 2 * 60 * 60_000), d.id)).toEqual({ ok: false, problem: "step_up" });
    expect(memory.issueApprovalCode(auth(), y.id)).toEqual({ ok: false, problem: "not_pending" });   // approved above
    const plain = made(memory.remember(apiFix, fact({ title: "A plain fact" })));
    expect(memory.issueApprovalCode(auth(), plain.id)).toEqual({ ok: false, problem: "not_pending" });
    expect(memory.issueApprovalCode(auth(), "N-99")).toEqual({ ok: false, problem: "not_found" });
  });

  it("a code expires after ten minutes and burns after five wrong tries", () => {
    const forgiving = made(memory.remember(apiFix, fact({ kind: "procedure", title: "Rotate keys" })));
    const lenient = memory.issueApprovalCode(auth(), forgiving.id);
    expect(lenient.ok).toBe(true);
    if (!lenient.ok) throw new Error(lenient.problem);
    for (let i = 0; i < APPROVAL_CODE_FAILURES - 1; i++) expect(problem(memory.approve("console", forgiving.id, { code: "0WRONG" }))).toBe("bad_code");
    expect(problem(memory.approve("console", forgiving.id, { code: lenient.code }))).toBe("ok");       // four tries leave it alive
    const strict = made(memory.remember(apiFix, fact({ kind: "procedure", title: "Rotate again" })));
    const burned = memory.issueApprovalCode(auth(), strict.id);
    expect(burned.ok).toBe(true);
    if (!burned.ok) throw new Error(burned.problem);
    for (let i = 0; i < APPROVAL_CODE_FAILURES; i++) expect(problem(memory.approve("console", strict.id, { code: "0WRONG" }))).toBe("bad_code");
    expect(problem(memory.approve("console", strict.id, { code: burned.code }))).toBe("bad_code");      // burned: even the right one is refused
    const expiring = made(memory.remember(webFix, fact({ kind: "procedure", title: "Rotate last" })));
    const old = memory.issueApprovalCode(auth(), expiring.id);
    expect(old.ok).toBe(true);
    if (!old.ok) throw new Error(old.problem);
    now += APPROVAL_CODE_TTL_MS + 1;
    expect(problem(memory.approve("console", expiring.id, { code: old.code }))).toBe("bad_code");      // past its ten minutes
  });

  it("only a hash of the code is stored", () => {
    const proc = made(memory.remember(apiFix, fact({ kind: "procedure", title: "Hashed code" })));
    const issue = memory.issueApprovalCode(auth(), proc.id);
    expect(issue.ok).toBe(true);
    if (!issue.ok) throw new Error(issue.problem);
    const row = store.approvalCode(proc.id);
    expect(row).toMatchObject({ failures: 0, expires_at: now + APPROVAL_CODE_TTL_MS });
    expect(row?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row?.hash).toBe(codeHash(normalCode(issue.code)));
    expect(JSON.stringify(row)).not.toContain(issue.code);
    expect(JSON.stringify(row)).not.toContain(normalCode(issue.code));
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
    memory.approve(answer(), proc.id);
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
    const base = made(memory.approve(answer(), made(memory.remember(apiFix, fact({ kind: "procedure", title: "Rotate the key" }))).id));
    const a = made(memory.remember(webFix, fact({ kind: "procedure", title: "Rotate the key", body: "Version 2a.", supersedes: base.id })));
    const b = made(memory.remember(apiFix, fact({ kind: "procedure", title: "Rotate the key", body: "Version 2b.", supersedes: base.id })));
    made(memory.approve(answer(), a.id));
    expect(problem(memory.approve(answer(), b.id))).toBe("replaced_meanwhile");
    expect(store.get(b.id)).toMatchObject({ approvedAt: null, invalidatedAt: null });
    expect(found({ q: "rotate" })).toEqual([a.id]);
  });
});
