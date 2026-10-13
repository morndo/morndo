// The hub's transcription routes (design §6, §13). With no plugin the install is unchanged. With the fixture,
// a short upload comes back as text. A temporary data dir and a random port, never a running hub.
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { UPLOAD_NAME_HEADER, type Transcriber } from "@morndo/protocol";
import { SENTENCE } from "../../../packages/protocol/test/answers.mjs";
import { LIMITS } from "../src/adapters/http.ts";
import { processTranscriber } from "../src/adapters/transcriber-process.ts";
import { ORIGIN, startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

const FIXTURE = fileURLToPath(new URL("../../../packages/protocol/test/fixtures/fake-transcribe.mjs", import.meta.url));
const hubs: InProcessHub[] = [];
afterEach(async () => { for (const h of hubs.splice(0)) await h.close(); });

const cookieOf = async (hub: InProcessHub) => `__Host-morndo=${await hub.cookie()}`;

async function upload(hub: InProcessHub, cookie: string, name: string, bytes: Uint8Array) {
  return fetch(hub.base + "/api/uploads", {
    method: "POST",
    headers: { origin: ORIGIN, cookie, "content-type": "application/octet-stream", [UPLOAD_NAME_HEADER]: encodeURIComponent(name) },
    body: bytes,
  });
}

describe("transcription http", () => {
  it("keeps a default install unchanged: no field, no routes, no audio, microphone blocked", async () => {
    const hub = await startInProcessHub();
    hubs.push(hub);
    const cookie = await cookieOf(hub);
    const me = await fetch(`${hub.base}/api/me`, { headers: { cookie } });
    expect(me.headers.get("permissions-policy")).toContain("microphone=()");
    expect((await me.json() as { transcription: unknown }).transcription).toBe(false);
    const ogg = await upload(hub, cookie, "note.ogg", Buffer.from("OggS"));
    expect(ogg.status).toBe(415);
    expect(await ogg.json()).toEqual({ error: "not_allowed" });
    const created = await hub.post("/api/transcriptions", { id: "voice1", recording: { kind: "upload", id: "up1" }, language: "auto" }, { cookie });
    expect(created.status).toBe(404);
    expect(await created.json()).toEqual({ error: "transcription_off" });
    const got = await fetch(`${hub.base}/api/transcriptions/voice1`, { headers: { cookie, origin: ORIGIN } });
    expect(got.status).toBe(404);
    expect(await got.json()).toEqual({ error: "transcription_off" });
    const cancelled = await hub.post("/api/transcriptions/voice1/cancel", {}, { cookie });
    expect(cancelled.status).toBe(404);
    expect(await cancelled.json()).toEqual({ error: "transcription_off" });
  });

  it("accepts a short audio upload and returns the fixture's transcript", async () => {
    const hub = await startInProcessHub({ transcriber: processTranscriber(FIXTURE) });
    hubs.push(hub);
    const cookie = await cookieOf(hub);
    const me = await fetch(`${hub.base}/api/me`, { headers: { cookie } });
    expect(me.headers.get("permissions-policy")).toContain("microphone=(self)");
    expect(await me.json()).toMatchObject({
      transcription: { engine: "fixture-ear", model: "tiny-fixture", languages: "multi", maxSeconds: 600 },
    });
    const png = await upload(hub, cookie, "dot.png", Buffer.from("not-a-png"));
    expect(png.status).toBe(415);
    const fake = await upload(hub, cookie, "note.ogg", Buffer.from("not-audio"));
    expect(fake.status).toBe(415);
    expect(await fake.json()).toEqual({ error: "not_allowed" });
    const ogg = await upload(hub, cookie, "note.ogg", Buffer.from("OggSrest"));
    expect(ogg.status).toBe(200);
    const saved = await ogg.json() as { id: string; mime: string };
    expect(saved.mime).toBe("audio/ogg");
    const created = await hub.post("/api/transcriptions", {
      id: "voice1", recording: { kind: "upload", id: saved.id }, language: "auto",
    }, { cookie });
    expect(created.status).toBe(200);
    let view = await created.json() as { state: string; text: { text: string } | null };
    for (let i = 0; view.state !== "done" && view.state !== "failed" && i < 50; i++) {
      await new Promise(r => setTimeout(r, 20));
      view = await (await fetch(`${hub.base}/api/transcriptions/voice1`, { headers: { cookie, origin: ORIGIN } })).json() as typeof view;
    }
    expect(view.state).toBe("done");
    expect(view.text?.text).toBe(SENTENCE);
  });

  it("answers a transcription and its cancel only to the endpoint that owns the row", async () => {
    let release: (value: { ok: true; value: { language: string; durationMs: number; segments: { startMs: number; endMs: number; text: string }[] } }) => void = () => {};
    const transcriber: Transcriber = {
      probe: async () => ({ ready: true, engine: "fixture-ear", engineVersion: "1.0.0", model: "tiny-fixture", languages: "multi", maxSeconds: 600 }),
      transcribe: input => new Promise((resolve, reject) => {
        const stop = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (input.signal.aborted) { stop(); return; }
        input.signal.addEventListener("abort", stop);
        release = resolve;
      }),
    };
    const hub = await startInProcessHub({ transcriber });
    hubs.push(hub);
    const mine = await cookieOf(hub);
    const other = await cookieOf(hub);
    const ogg = await upload(hub, mine, "note.ogg", Buffer.from("OggSrest"));
    expect(ogg.status).toBe(200);
    const saved = await ogg.json() as { id: string };
    const created = await hub.post("/api/transcriptions", {
      id: "voice1", recording: { kind: "upload", id: saved.id }, language: "auto",
    }, { cookie: mine });
    expect(created.status).toBe(200);
    const headers = (cookie: string) => ({ cookie, origin: ORIGIN });
    const missingGet = await fetch(`${hub.base}/api/transcriptions/no-such-row`, { headers: headers(mine) });
    const foreignGet = await fetch(`${hub.base}/api/transcriptions/voice1`, { headers: headers(other) });
    expect(foreignGet.status).toBe(missingGet.status);
    expect(await foreignGet.json()).toEqual(await missingGet.json());
    const ownGet = await fetch(`${hub.base}/api/transcriptions/voice1`, { headers: headers(mine) });
    expect(ownGet.status).toBe(200);
    expect((await ownGet.json() as { state: string }).state).not.toBe("cancelled");
    const missingCancel = await hub.post("/api/transcriptions/no-such-row/cancel", {}, { cookie: mine });
    const foreignCancel = await hub.post("/api/transcriptions/voice1/cancel", {}, { cookie: other });
    expect(foreignCancel.status).toBe(missingCancel.status);
    expect(await foreignCancel.json()).toEqual(await missingCancel.json());
    const still = await fetch(`${hub.base}/api/transcriptions/voice1`, { headers: headers(mine) });
    expect((await still.json() as { state: string }).state).not.toBe("cancelled");
    const ownCancel = await hub.post("/api/transcriptions/voice1/cancel", {}, { cookie: mine });
    expect(ownCancel.status).toBe(200);
    expect((await ownCancel.json() as { state: string }).state).toBe("cancelled");
    release({ ok: true, value: { language: "en", durationMs: 1, segments: [{ startMs: 0, endMs: 1, text: "kept" }] } });
  });

  it("refuses a recording that is not audio, or another device's upload", async () => {
    const hub = await startInProcessHub({ transcriber: processTranscriber(FIXTURE) });
    hubs.push(hub);
    const mine = await cookieOf(hub);
    const other = await cookieOf(hub);                       // a second paired device: another endpoint
    // A PDF is a fine upload but no recording: audio is known by its own bytes (S1), never by the id alone.
    const pdf = await upload(hub, mine, "note.pdf", Buffer.concat([Buffer.from("%PDF-1.7 "), Buffer.alloc(4064, 0x20)]));
    expect(pdf.status).toBe(200);
    const paper = await pdf.json() as { id: string };
    const forPaper = await hub.post("/api/transcriptions", { id: "voice2", recording: { kind: "upload", id: paper.id }, language: "auto" }, { cookie: mine });
    expect(forPaper.status).toBe(404);
    expect(await forPaper.json()).toEqual({ error: "unreadable" });
    // An upload belongs to the endpoint that made it (S2's rule for attachments): not another device's to transcribe.
    const ogg = await upload(hub, other, "note.ogg", Buffer.from("OggSrest"));
    expect(ogg.status).toBe(200);
    const saved = await ogg.json() as { id: string };
    const foreign = await hub.post("/api/transcriptions", { id: "voice3", recording: { kind: "upload", id: saved.id }, language: "auto" }, { cookie: mine });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: "unreadable" });
  });

  it("answers a full queue with 503 and Retry-After, not a malformed request", async () => {
    const transcriber: Transcriber = {
      probe: async () => ({ ready: true, engine: "fixture-ear", engineVersion: "1.0.0", model: "tiny-fixture", languages: "multi", maxSeconds: 600 }),
      transcribe: input => new Promise((_resolve, reject) => {
        const stop = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (input.signal.aborted) stop();
        else input.signal.addEventListener("abort", stop);
      }),
    };
    const hub = await startInProcessHub({
      transcriber,
      // The per-caller bucket is a different door. This test fills the machine's queue, so the bucket stays open.
      limits: { ...LIMITS, transcriptions: { capacity: 200, refillPerSecond: 1000 } },
    });
    hubs.push(hub);
    const cookie = await cookieOf(hub);
    const ogg = await upload(hub, cookie, "note.ogg", Buffer.from("OggSrest"));
    expect(ogg.status).toBe(200);
    const saved = await ogg.json() as { id: string };
    for (let i = 0; i < 100; i++) {
      const made = await hub.post("/api/transcriptions", {
        id: `voice${i}`, recording: { kind: "upload", id: saved.id }, language: `la-${i}`,
      }, { cookie });
      expect(made.status).toBe(200);
    }
    const over = await hub.post("/api/transcriptions", {
      id: "voice-over", recording: { kind: "upload", id: saved.id }, language: "lb",
    }, { cookie });
    expect(over.status).toBe(503);
    expect(over.headers.get("retry-after")).toBe("60");
    expect(await over.json()).toEqual({ error: "too_many" });
  });

  it("serves the app shell from the cached probe and refreshes it in the background", async () => {
    let calls = 0;
    let release = () => {};
    const missing = { ready: false as const, reason: "missing" as const, detail: "missing" };
    const ready = { ready: true as const, engine: "fixture-ear", engineVersion: "1.0.0", model: "tiny-fixture", languages: "multi" as const, maxSeconds: 600 };
    const transcriber: Transcriber = {
      probe: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve(missing);
        if (calls === 2) return new Promise<typeof ready>(resolve => { release = () => resolve(ready); });
        return Promise.resolve(ready);
      },
      transcribe: () => Promise.reject(new Error("not used")),
    };
    const hub = await startInProcessHub({ transcriber });
    hubs.push(hub);
    const shell = fetch(`${hub.base}/`);
    const winner = await Promise.race([
      shell.then(() => "served" as const),
      new Promise<"waited">(resolve => setTimeout(() => resolve("waited"), 200)),
    ]);
    release();
    const before = await shell;
    expect(winner).toBe("served");
    expect(before.headers.get("permissions-policy")).toContain("microphone=()");
    let policy = "";
    for (let i = 0; i < 20 && !policy.includes("microphone=(self)"); i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      policy = (await fetch(`${hub.base}/`)).headers.get("permissions-policy") ?? "";
    }
    expect(policy).toContain("microphone=(self)");
  });

  it("a probe that throws does not take the hub down from the app shell", async () => {
    const reasons: unknown[] = [];
    const onReject = (reason: unknown) => { reasons.push(reason); };
    process.on("unhandledRejection", onReject);
    const warned: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { warned.push(String(chunk)); return true; }) as typeof process.stderr.write;
    let calls = 0;
    const missing = { ready: false as const, reason: "missing" as const, detail: "missing" };
    try {
      const hub = await startInProcessHub({
        locate: () => {
          calls += 1;
          if (calls > 1) throw new Error("probe blew up");
          return {
            transcriber: { probe: async () => missing, transcribe: () => Promise.reject(new Error("not used")) },
            unavailable: null,
          };
        },
      });
      hubs.push(hub);
      const shell = await fetch(`${hub.base}/`);
      expect(shell.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(reasons).toEqual([]);
      expect(warned.join("")).toContain("probe blew up");
    } finally {
      process.stderr.write = write;
      process.off("unhandledRejection", onReject);
    }
  });
});
