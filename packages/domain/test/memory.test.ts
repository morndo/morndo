// Memory context (ADR-0031, docs/domain.md "Memory: what the lanes learned"): the invariants M1-M7 and the skill files
// every node writes.
import { describe, expect, it } from "vitest";
import {
  SKILL_NAME_RE, approveNote, confirmNote, invalidateNote, isDeliverable, isStale, noteId, parseNoteId, parseScope,
  proposeNote, renderBundle, selectIndex, skillName, supersedeNote, type MemoryActor, type Note, type NoteDraft, type Scope,
} from "../src/index.ts";

const NOW = Date.UTC(2026, 9, 20, 12);
const lane: MemoryActor = { kind: "worker", name: "rc-grant", token: "t1" };
const otherLane: MemoryActor = { kind: "worker", name: "rc-other", token: "t2" };
const manager: MemoryActor = { kind: "manager", name: "manager", token: "t0" };
const owner: MemoryActor = { kind: "principal", via: "console", id: "owner" };
const imported: MemoryActor = { kind: "import", label: "mac-memory" };
const draft = (over: Partial<NoteDraft> = {}): NoteDraft => ({ kind: "fact", scope: "repo:shop-api", title: "Accounts are made by the operator CLI", body: "Run the operator create command in the api pod.", ...over });

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r.value;
}
const problem = (r: { ok: boolean; error?: { problem: string } }) => (r.ok ? "ok" : r.error?.problem);
const make = (d: Partial<NoteDraft>, actor: MemoryActor = lane, n = 1, now = NOW) => value(proposeNote(draft(d), actor, noteId(n), now)).note;

describe("ids and scopes", () => {
  it("parses note ids and scopes, and refuses anything else", () => {
    expect(parseNoteId("N-7")).toBe("N-7");
    expect(parseNoteId("N-0")).toBeNull();
    expect(parseNoteId("T-7")).toBeNull();
    for (const s of ["repo:shop-api", "project:Payments_2", "user", "org"]) expect(parseScope(s)).toBe(s);
    for (const s of ["repo:", "repo:../x", "repo:-x", "team", "repo:a b", "REPO:x"]) expect(parseScope(s)).toBeNull();
  });
});

describe("a new note (M3, M5)", () => {
  it("keeps who wrote it, where and from what (M3)", () => {
    const n = make({ ref: "report rc-grant 2026-10-15", node: "pc" });
    expect(n.provenance).toEqual({ by: "lane:rc-grant", node: "pc", ref: "report rc-grant 2026-10-15", untrusted: false });
    expect(problem(proposeNote(draft(), { kind: "worker", name: " ", token: "t" }, noteId(1), NOW))).toBe("no_provenance");
  });
  it("sets the tier from the source: the principal 1, an agent or an import 3, untrusted content 4 (M5)", () => {
    expect(make({}, owner).tier).toBe(1);
    expect(make({}, lane).tier).toBe(3);
    expect(make({}, manager).tier).toBe(3);
    expect(make({}, imported).tier).toBe(3);
    expect(make({ untrusted: true }, lane).tier).toBe(4);
    expect(make({ untrusted: true }, owner).tier).toBe(4);
  });
  it("refuses bad fields", () => {
    expect(problem(proposeNote(draft({ kind: "rumour" as never }), lane, noteId(1), NOW))).toBe("bad_kind");
    expect(problem(proposeNote(draft({ scope: "team" }), lane, noteId(1), NOW))).toBe("bad_scope");
    expect(problem(proposeNote(draft({ title: "  " }), lane, noteId(1), NOW))).toBe("empty");
    expect(problem(proposeNote(draft({ title: "a\u0007b" }), lane, noteId(1), NOW))).toBe("bad_text");
    expect(problem(proposeNote(draft({ title: "x".repeat(121) }), lane, noteId(1), NOW))).toBe("title_size");
    expect(problem(proposeNote(draft({ body: "x".repeat(20_001) }), lane, noteId(1), NOW))).toBe("body_size");
    expect(problem(proposeNote(draft({ node: "Bad Node" }), lane, noteId(1), NOW))).toBe("bad_node");
    expect(make({ body: "line one\nline two\ttabbed" }).body).toBe("line one\nline two\ttabbed");
  });
});

describe("procedures wait for the principal (M4)", () => {
  it("an agent's procedure is not deliverable until the principal approves it", () => {
    const p = make({ kind: "procedure" });
    expect(isDeliverable(p)).toBe(false);
    expect(problem(approveNote(p, manager, NOW))).toBe("not_principal");
    expect(problem(approveNote(p, lane, NOW))).toBe("not_principal");
    const a = value(approveNote(p, owner, NOW + 1));
    expect(a.note).toMatchObject({ tier: 1, approvedAt: NOW + 1, approvedBy: "principal:console" });
    expect(a.event.change).toEqual({ kind: "approved" });
    expect(isDeliverable(a.note)).toBe(true);
    expect(problem(approveNote(a.note, owner, NOW + 2))).toBe("already_approved");
  });
  it("the principal's own procedure is approved as written", () => {
    expect(isDeliverable(make({ kind: "procedure" }, owner))).toBe(true);
  });
  it("a successor of an approved procedure waits for its own approval", () => {
    const approved = value(approveNote(make({ kind: "procedure" }), owner, NOW)).note;
    const s = value(supersedeNote(approved, draft({ kind: "procedure", body: "Changed steps." }), lane, noteId(2), NOW + 5));
    expect(isDeliverable(s.note)).toBe(false);
    expect(isDeliverable(s.old)).toBe(false);
  });
});

describe("untrusted content never rises on its own (M5)", () => {
  it("is not deliverable, and evidence does not lift it; only the principal does", () => {
    const u = make({ untrusted: true });
    expect(isDeliverable(u)).toBe(false);
    expect(problem(confirmNote(u, manager, "verdict V-1", NOW))).toBe("untrusted");
    const a = value(approveNote(u, owner, NOW));
    expect(a.note.tier).toBe(1);
    expect(isDeliverable(a.note)).toBe(true);
  });
  it("an agent's fact rises to tier 2 only with evidence", () => {
    const f = make({});
    expect(problem(confirmNote(f, manager, " ", NOW))).toBe("no_evidence");
    const c = value(confirmNote(f, manager, "gate run G-12", NOW + 9));
    expect(c.note).toMatchObject({ tier: 2, lastConfirmedAt: NOW + 9 });
    expect(c.event.change).toEqual({ kind: "confirmed", evidence: "gate run G-12" });
    expect(problem(confirmNote(c.note, manager, "again", NOW))).toBe("already_confirmed");
  });
});

describe("never edited, never deleted (M2)", () => {
  it("a successor carries the change and the old note is invalidated in its favour", () => {
    const old = make({});
    const s = value(supersedeNote(old, draft({ body: "The operator CLI moved to the jobs pod." }), lane, noteId(2), NOW + 3));
    expect(s.note.supersedes).toBe("N-1");
    expect(s.old).toMatchObject({ invalidatedAt: NOW + 3, supersededBy: "N-2", body: old.body });
    expect(s.events.map(e => e.change.kind)).toEqual(["proposed", "superseded"]);
    expect(problem(supersedeNote(s.old, draft(), lane, noteId(3), NOW))).toBe("invalidated");
    expect(problem(supersedeNote(make({}), draft({ scope: "repo:other" }), lane, noteId(3), NOW))).toBe("mismatch");
  });
  it("a lane invalidates only its own notes; the manager and the principal any", () => {
    const n = make({});
    expect(problem(invalidateNote(n, otherLane, "wrong", NOW))).toBe("not_yours");
    expect(value(invalidateNote(n, lane, "wrong", NOW)).note.invalidReason).toBe("wrong");
    expect(value(invalidateNote(n, manager, "outdated", NOW)).note.invalidatedBy).toBe("manager:manager");
    const gone = value(invalidateNote(n, owner, "", NOW)).note;
    expect(gone.invalidReason).toBe("invalidated");
    expect(isDeliverable(gone)).toBe(false);
    expect(problem(invalidateNote(gone, owner, "again", NOW))).toBe("invalidated");
  });
});

describe("the index a lane receives (M6, M7)", () => {
  const scope = "repo:shop-api" as Scope;
  const notes: Note[] = [
    make({ title: "Old agent fact", lastConfirmedAt: NOW - 9_000 }, lane, 1),
    make({ title: "New agent fact", lastConfirmedAt: NOW - 1_000 }, lane, 2),
    make({ title: "Owner fact", lastConfirmedAt: NOW - 50_000 }, owner, 3),
    make({ title: "Untrusted fact" , untrusted: true }, lane, 4),
    make({ title: "Other repo fact", scope: "repo:other" }, lane, 5),
    make({ title: "Stale fact", recheckAt: NOW - 1 }, lane, 6),
  ];
  it("puts the most trusted first, then the most recently confirmed, and leaves out the undeliverable", () => {
    const { chosen, left } = selectIndex(notes, scope, 100_000, NOW);
    expect(chosen.map(n => n.title)).toEqual(["Owner fact", "Stale fact", "New agent fact", "Old agent fact"]);
    expect(left).toBe(0);
  });
  it("never goes over its budget, and counts what did not fit (M6)", () => {
    const { chosen, left } = selectIndex(notes, scope, 250, NOW);
    expect(chosen.length).toBeGreaterThan(0);
    expect(chosen.length + left).toBe(4);
    const files = renderBundle(notes, NOW, 250);
    const facts = files.find(f => f.name.endsWith("-facts") && f.content.includes("repo:shop-api"))!;
    expect(facts.content).toContain(`${left} more notes did not fit here`);
  });
  it("shows a stale note as stale and keeps it (M7)", () => {
    expect(isStale(notes[5]!, NOW)).toBe(true);
    const facts = renderBundle(notes, NOW).find(f => f.name === "morndo-mem-repo-shop-api-facts")!;
    expect(facts.content).toMatch(/Stale fact.*stale, check before relying on it/);
  });
});

describe("the skill files every node writes", () => {
  it("names follow the Agent Skills rules and fit in 64 characters", () => {
    const names = [
      skillName("repo:shop-api" as Scope, "facts"),
      skillName("repo:shop-api" as Scope, "Create an account without the invite mail!", "N-7"),
      skillName(`repo:${"x".repeat(100)}` as Scope, "Some procedure", "N-123"),
      skillName("org" as Scope, "--weird -- title--", "N-1"),
    ];
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(64);
      expect(n).toMatch(SKILL_NAME_RE);
    }
    expect(names[1]).toBe("morndo-mem-repo-shop-api-create-an-account-without-the-n-7");
  });
  it("writes a facts skill per scope and one skill per approved procedure, nothing for the rest (M4, M5)", () => {
    const approved = value(approveNote(make({ kind: "procedure", title: "Create an account without mail", summary: "Use when a customer needs an account and no invite." }, lane, 10), owner, NOW)).note;
    const waiting = make({ kind: "procedure", title: "Waiting procedure" }, lane, 11);
    const untrusted = make({ kind: "procedure", title: "Planted procedure", untrusted: true }, lane, 12);
    const files = renderBundle([make({}, lane, 1), approved, waiting, untrusted], NOW);
    expect(files.map(f => f.name)).toEqual(["morndo-mem-repo-shop-api-create-an-account-without-mail-n-10", "morndo-mem-repo-shop-api-facts"]);
    const p = files[0]!.content;
    expect(p).toMatch(/^---\nname: morndo-mem-repo-shop-api-create-an-account-without-mail-n-10\ndescription: "Create an account without mail\. Use when/);
    expect(p).toContain("Run the operator create command in the api pod.");
    expect(p).toContain("morndo-memory remember --supersedes N-10");
    expect(files.some(f => f.content.includes("Planted procedure") || f.content.includes("Waiting procedure"))).toBe(false);
  });
  it("escapes quotes in YAML and gives the same files for the same notes", () => {
    const n = value(approveNote(make({ kind: "procedure", title: 'Say "hi" \\ there' }, lane, 3), owner, NOW)).note;
    const a = renderBundle([n], NOW);
    expect(a[0]!.content).toContain('description: "Say \\"hi\\" \\\\ there.');
    expect(renderBundle([n], NOW)).toEqual(a);
  });
});
