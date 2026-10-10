// The hub decodes every inbound frame and body with the shared protocol (ADR-0008, A2): a malformed frame closes the
// socket with 1003, a frame type it doesn't know is ignored, and a body that doesn't fit is refused with 400 before
// any service sees it. The hub runs in a child process (http-crash-fixture.ts).
import { afterEach, describe, expect, it } from "vitest";
import { ORIGIN, nextOutcome, openSocket, signedIn, startHub, type Hub } from "./http-crash-fixture.ts";

let hub: Hub | null = null;
afterEach(async () => { await hub?.stop(); hub = null; });

const post = (h: Hub, path: string, body: unknown) => fetch(h.base + path, {
  method: "POST", headers: { ...signedIn(h), origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("the live feed decodes every frame", () => {
  it("ignores a frame type it doesn't know: the socket lives on", async () => {
    hub = await startHub();
    const ws = await openSocket(hub, "/api/feed");
    const outcome = nextOutcome(ws);
    ws.send(JSON.stringify({ t: "from-a-newer-app", x: 1 }));
    ws.send(JSON.stringify({ t: "hello" }));
    expect(await outcome, hub.output()).toMatch(/^message \{"t":"snapshot"/);
  }, 15_000);
  it("closes with 1003 on a frame of a known type that doesn't fit", async () => {
    hub = await startHub();
    const ws = await openSocket(hub, "/api/feed");
    const outcome = nextOutcome(ws);
    ws.send(JSON.stringify({ t: "hello", epoch: "e", cursor: "not a number" }));
    expect(await outcome, hub.output()).toBe("close 1003");
  }, 15_000);
  it("closes with 1003 on a watch for something that isn't a pane", async () => {
    hub = await startHub();
    const ws = await openSocket(hub, "/api/feed");
    const outcome = nextOutcome(ws);
    ws.send(JSON.stringify({ t: "watch", worker: "../../etc" }));
    expect(await outcome, hub.output()).toBe("close 1003");
  }, 15_000);
});

describe("the terminal socket decodes every frame", () => {
  it("closes with 1003 on keys that aren't text", async () => {
    hub = await startHub();
    const ws = await openSocket(hub, "/api/terminal?pane=%251&control=1", true);
    const closed = new Promise<number>(resolve => ws.on("close", code => resolve(code)));
    ws.send(JSON.stringify({ t: "keys", data: 5 }));
    expect(await closed, hub.output()).toBe(1003);
  }, 15_000);
});

describe("HTTP bodies are decoded before any service sees them", () => {
  it("a send with an empty request id is refused with 400 (it used to be typed)", async () => {
    hub = await startHub();
    const r = await post(hub, "/api/workers/%251/send", { text: "hi", requestId: "", seen: "none" });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "bad_request" });
  }, 15_000);
  it("a send with a UUID request id goes through", async () => {
    hub = await startHub();
    const r = await post(hub, "/api/workers/%251/send", { text: "hi", requestId: crypto.randomUUID(), seen: "none" });
    expect(r.status, await r.clone().text()).toBe(200);
  }, 15_000);
  it("a send must say what it was written for (S6): without `seen`, 400", async () => {
    hub = await startHub();
    const r = await post(hub, "/api/workers/%251/send", { text: "hi", requestId: crypto.randomUUID() });
    expect(r.status).toBe(400);
  }, 15_000);
  it("a send written for a question the worker no longer shows is refused: 409 stale, not typed", async () => {
    hub = await startHub();
    const r = await post(hub, "/api/workers/%251/send", { text: "Keep it", requestId: crypto.randomUUID(), seen: "q:toolu_1" });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "stale" });
  }, 15_000);
  it("an answer with a request id that isn't a UUID is refused with 400", async () => {
    hub = await startHub();
    const r = await post(hub, "/api/escalations/ny-1/answer", { key: "ship", requestId: "second" });
    expect(r.status).toBe(400);
  }, 15_000);
  it("a pairing request whose token isn't text is refused with 400", async () => {
    hub = await startHub();
    const r = await post(hub, "/api/pair/options", { token: { $ne: null } });
    expect(r.status).toBe(400);
  }, 15_000);
});

describe("app-level ping (ADR-0008, phase B)", () => {
  it("the hub answers {t:ping,n} with {t:pong,n}", async () => {
    hub = await startHub();
    const ws = await openSocket(hub, "/api/feed");
    const outcome = nextOutcome(ws);
    ws.send(JSON.stringify({ t: "ping", n: 41 }));
    expect(await outcome, hub.output()).toBe('message {"t":"pong","n":41}');
  }, 15_000);
  it("a ping without a number is malformed: 1003", async () => {
    hub = await startHub();
    const ws = await openSocket(hub, "/api/feed");
    const outcome = nextOutcome(ws);
    ws.send(JSON.stringify({ t: "ping", n: "x" }));
    expect(await outcome, hub.output()).toBe("close 1003");
  }, 15_000);
});
