// POST /api/uploads: the domain allowlist, on the real route. A markdown file is kept; an executable, HTML, and a
// text file over its limit are refused with a code the composer can say in words.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UPLOAD_NAME_HEADER } from "@morndo/protocol";
import { ORIGIN, startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

let hub: InProcessHub;
beforeEach(async () => { hub = await startInProcessHub(); });
afterEach(async () => { await hub.close(); });

const post = async (body: Uint8Array, name: string, cookie: string) => fetch(hub.base + "/api/uploads", {
  method: "POST",
  headers: { origin: ORIGIN, cookie: `__Host-morndo=${cookie}`, "content-type": "application/octet-stream", [UPLOAD_NAME_HEADER]: encodeURIComponent(name) },
  body,
});

describe("upload route", () => {
  it("stores a markdown file and refuses an executable, HTML, and a text file over 1 MB", async () => {
    const cookie = await hub.cookie();
    const ok = await post(new TextEncoder().encode("# Notes\n"), "My Notes.md", cookie);
    expect(ok.status).toBe(200);
    const saved = await ok.json() as { mime: string; name: string; size: number };
    expect(saved.mime).toBe("text/markdown");
    expect(saved.name).toMatch(/My_Notes\.md$/);
    expect(saved.size).toBe(8);
    expect((await post(new TextEncoder().encode("MZ"), "run.exe", cookie)).status).toBe(415);
    expect(await (await post(new TextEncoder().encode("MZ"), "run.exe", cookie)).json()).toEqual({ error: "not_allowed" });
    expect(await (await post(new TextEncoder().encode("<!doctype html>"), "page.html", cookie)).json()).toEqual({ error: "not_allowed" });
    const big = await post(new Uint8Array(1024 * 1024 + 1), "big.md", cookie);
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "too_big" });
  });
});
