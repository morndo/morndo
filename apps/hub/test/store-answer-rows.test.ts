// The sends rows of escalation answers, as the store reads them back: the row a request wrote, and every answer row
// under a key prefix (review of PR #55, round 3).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/adapters/store.ts";
import { answerKey } from "../src/application/escalation-service.ts";

const T0 = Date.UTC(2026, 9, 1, 8);
const ship = { kind: "option" as const, key: "ship" };

describe("answer rows in the store", () => {
  let dir: string, store: Store;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-answer-rows-")); store = new Store(dir); });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  // One request can hold rows for two versions of an ask: asked again in between, the first never started at its node,
  // the same choice typed anew under the new version's key (round 3.6). Which row it reads back is the latest it
  // wrote, every time, not whichever SQLite meets first.
  it("reads back the latest row a request wrote when it wrote two", () => {
    const v1 = answerKey("ny-7", { messageId: "m1", askedAt: T0 - 60_000 }, ship);
    const v2 = answerKey("ny-7", { messageId: "m2", askedAt: T0 }, ship);
    store.startAnswer(v1, T0 - 2000, { workerId: "%0", request: "desk:r1" });
    store.startAnswer(v2, T0 - 1000, { workerId: "%0", request: "desk:r1" });
    expect(store.sendOfRequest("desk:r1")?.key).toBe(v2);
  });
});
