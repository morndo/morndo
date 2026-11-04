// A task whose merge record is in a repository the hub does not read can be briefed AND finished (T-805, B14, B23): the
// rule "a reference in the repository of the merge record" holds only where a reference could stand, at the filing, in the
// view and at the done gate alike. Real Store, BoardService and ProofService; no forge (the rows are the test's own).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type BoardActor } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { BoardService } from "../src/application/board-service.ts";
import { ProofService } from "../src/application/proof-service.ts";

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "morndo-unread-merge-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const manager: BoardActor = { kind: "manager", name: "manager", token: "tok-manager" };
const lane: BoardActor = { kind: "worker", name: "builder", token: "tok-builder" };
const NOW = 1_800_000_000_000;
const FULL = "3e9d1a7c5b2f4a8e9d0c1b2a3f4e5d6c7b8a9f01";
const REF = "morndo/morndo#42@3e9d1a7";

async function reviewed(mode: "off" | "warn" | "on") {
  const store = new Store(tempDir());
  const board = new BoardService({ store, policy: () => DEFAULT_POLICY, now: () => NOW });
  const proof = new ProofService({ store, board, now: () => NOW, mode, allowedRepos: ["morndo/morndo"] });
  board.create({ title: "Ship the totals row", assignee: "builder" }, manager);
  board.act("T-1", { action: "move", to: "doing" }, lane);
  board.act("T-1", { action: "move", to: "review" }, lane);
  // The manager records a merge in a repository the hub does not read, and the lane files a brief naming only what it does.
  expect(board.act("T-1", { action: "merged", sha: FULL, repo: "acme/vault" }, manager).ok).toBe(true);
  const f = await proof.file("T-1", { summary: "Totals row rounds to cents", leftOut: "nothing", limits: "none known", refs: [REF] }, lane);
  if (!f.ok) throw new Error(`${f.problem} ${f.detail ?? ""}`);
  store.saveProofResult("T-1", f.event.rev, { ref: REF, state: "green", detail: null, checkedAt: NOW });
  return { store, board, proof };
}

describe("a merge record in a repository the hub does not read", () => {
  it("leaves the proof verified in the view when the references elsewhere are green", async () => {
    const { store, proof } = await reviewed("on");
    const view = proof.view("T-1");
    expect(view?.state.kind).toBe("verified");
    expect(view?.state.accepts).toBe(true);
    store.close();
  });

  it("does not hold the done in on mode: the task can be finished, not only briefed", async () => {
    const { store, board } = await reviewed("on");
    const r = await board.actChecked("T-1", { action: "move", to: "done", reason: "the row ships" }, manager);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(store.task("T-1")?.status).toBe("done");
    store.close();
  });
});
