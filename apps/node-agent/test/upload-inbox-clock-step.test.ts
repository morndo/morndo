// An active multi-chunk upload must survive a forward wall-clock step between chunks (time sync), because its idleness
// is real-elapsed-ms, not wall-clock. Only Date is faked; mtimes come from the OS clock.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "@morndo/protocol";
import { tempHome } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

let home: { home: string; cleanup: () => void }; let h: Harness; let realStart = 0;
beforeEach(() => {
  realStart = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(realStart);
  home = tempHome("v45-"); h = opsHarness({ home: home.home, socket: join(home.home, "no-tmux.sock") });
});
afterEach(() => { vi.useRealTimers(); h.close(); home.cleanup(); });

describe("UploadInbox partial TTL is not on the wall clock", () => {
  it("a +15 min step between chunk 3 and chunk 4 does not delete the active partial", async () => {
    const U = "upload-v45"; const C = LIMITS.chunkBytes; const image = randomBytes(4 * C + 1000);
    const args = (i: number) => ({ upload: U, offset: i * C, bytes: image.subarray(i * C, i * C + C).toString("base64"), final: i === 4, name: "shot.png" });
    for (let i = 0; i < 4; i++) expect(await h.call("file.put", args(i), { key: `hub:upload:${U}:${i}` })).toMatchObject({ ok: true });
    vi.setSystemTime(realStart + 15 * 60_000);
    const r4 = await h.call("file.put", args(4), { key: `hub:upload:${U}:4` });
    expect(r4).toMatchObject({ ok: true });
    const path = (r4 as { result: { path: string } }).result.path;
    expect(existsSync(path) && readFileSync(path).equals(image)).toBe(true);
  });
});
