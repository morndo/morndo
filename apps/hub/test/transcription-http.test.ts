// The hub's transcription routes (design §6, §13). With no plugin the install is unchanged. With the fixture,
// a short upload comes back as text. A temporary data dir and a random port, never a running hub.
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { UPLOAD_NAME_HEADER } from "@morndo/protocol";
import { SENTENCE } from "../../../packages/protocol/test/answers.mjs";
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
});
