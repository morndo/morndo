// The index file adapter: review round 1 of PR #31 (board T-88). Each block written failing before its fix.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexFileRefused, readSecretIndex } from "../src/secret-index-file.ts";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "secret-index-review-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const problem = (f: () => unknown) => {
  try { f(); return "read"; } catch (error) { return error instanceof IndexFileRefused ? error.problem : `other: ${String(error)}`; }
};

describe("round 7, point 2: a file that isn't regular is refused at once, without blocking", () => {
  it("a FIFO at the index path is refused as the wrong kind, without waiting for a writer", () => {
    const fifo = join(dir, "index");
    execFileSync("mkfifo", [fifo]);
    // The reader itself runs in a child with a timeout, never in this worker: a blocking open would hang the worker, not
    // fail the test, whatever flags the reader came to use (review 13 of PR #40). The child imports the .ts module as the
    // package's bins do, so it needs a Node that strips types, which engines.node (>= 24.12, where stripping is stable)
    // promises; on a Node that doesn't, this says so instead of failing as a FIFO problem (T-94).
    expect((process.features as { typescript?: unknown }).typescript, "this Node doesn't strip types, which the bins and this child need").toBeTruthy();
    const module = pathToFileURL(join(import.meta.dirname, "../src/secret-index-file.ts")).href;
    const script = `import { IndexFileRefused, readSecretIndex } from ${JSON.stringify(module)};
      try { readSecretIndex(${JSON.stringify(fifo)}); console.log("read"); }
      catch (e) { console.log(e instanceof IndexFileRefused ? e.problem : "other"); }`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
    expect(r.signal, "killed by the timeout: the open blocked").toBeNull();
    expect(r.stdout.trim(), r.stderr).toBe("kind");
  });
  it("a Unix socket and a character device are refused as the wrong kind too", async () => {
    const path = join(dir, "sock");
    const server = createServer();
    await new Promise<void>(resolve => server.listen(path, resolve));
    try {
      expect(problem(() => readSecretIndex(path))).toBe("kind");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    expect(problem(() => readSecretIndex("/dev/null"))).toBe("kind");
  });
});
