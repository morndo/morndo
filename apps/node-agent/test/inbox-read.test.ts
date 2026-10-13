// The fleet reads what the hub put in a node's upload inbox (so the hub can copy the owner's image into its store),
// and still nothing else under the state directory (spec §5.3, §8). Real ops on a temporary HOME.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedTmux, tempHome, type TestTmux } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

let home: { home: string; cleanup: () => void };
let t: TestTmux;
let h: Harness;
beforeEach(() => { home = tempHome(); t = isolatedTmux(); h = opsHarness({ home: home.home, socket: t.socket }); });
afterEach(async () => { h.close(); await t.kill(); home.cleanup(); });

describe("the node's upload inbox is readable by the fleet", () => {
  it("serves a finished upload by path", async () => {
    mkdirSync(h.paths.inboxDir, { recursive: true });
    const f = join(h.paths.inboxDir, "up1-photo.png");
    writeFileSync(f, "png-bytes");
    expect(await h.call("file.stat", { path: f })).toMatchObject({ ok: true, result: { size: 9 } });
    expect(await h.call("file.get", { path: f, offset: 0, max: 100 })).toMatchObject({ ok: true, result: { size: 9, eof: true } });
  });
  it("refuses a partial upload, the agent's database and a link out of the inbox (negative control)", async () => {
    mkdirSync(join(h.paths.inboxDir, ".partial"), { recursive: true });
    const partial = join(h.paths.inboxDir, ".partial", "up2");
    writeFileSync(partial, "half");
    expect(await h.call("file.stat", { path: partial })).toMatchObject({ ok: false, error: { code: "denied" } });
    expect(await h.call("file.stat", { path: h.paths.dbPath })).toMatchObject({ ok: false, error: { code: "denied" } });
    const link = join(h.paths.inboxDir, "up3-link");
    symlinkSync(h.paths.dbPath, link);
    expect(await h.call("file.stat", { path: link })).toMatchObject({ ok: false, error: { code: "denied" } });
  });
});
