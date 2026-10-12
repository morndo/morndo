// Web push at the hub's HTTP edge (ADR-0008 phase F; N3, N4, AC13): the VAPID key for subscribing, one subscription
// per device, only a browser vendor's push service, gone with the device when it is revoked; a device that says the
// principal is attending silences pushes; a device added from another raises a counts-only push. Real server, a fake
// push sender (no network); synthetic data only.
import { createECDH } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

let hub: InProcessHub;
beforeEach(async () => { hub = await startInProcessHub(); });
afterEach(async () => { await hub.close(); });

const as = (cookie: string) => ({ cookie: `__Host-morndo=${cookie}` });
const get = (path: string, cookie: string) => fetch(hub.base + path, { headers: as(cookie) });
const ua = createECDH("prime256v1");
ua.generateKeys();
const keys = { p256dh: ua.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 5).toString("base64url") };   // a real point
const subscribe = (cookie: string, endpoint = "https://fcm.googleapis.com/fcm/send/abc") => hub.post("/api/push/subscription", { endpoint, keys }, as(cookie));
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("subscriptions (N4)", () => {
  it("the key is the hub's P-256 public key; a device subscribes once, replaces it, and unsubscribes", async () => {
    const phone = await hub.cookie(), laptop = await hub.cookie();
    const k = await (await get("/api/push/key", phone)).json() as { key: string; subscribed: boolean };
    expect(Buffer.from(k.key, "base64url")).toHaveLength(65);
    expect(k.subscribed).toBe(false);
    expect((await subscribe(phone)).status).toBe(200);
    expect((await subscribe(phone, "https://fcm.googleapis.com/fcm/send/def")).status).toBe(200);
    expect(hub.store.pushSubscriptions().map(s => s.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/def"]);
    expect((await (await get("/api/push/key", phone)).json() as { subscribed: boolean }).subscribed).toBe(true);
    expect((await (await get("/api/push/key", laptop)).json() as { subscribed: boolean }).subscribed).toBe(false);
    const del = await fetch(`${hub.base}/api/push/subscription`, { method: "DELETE", headers: { ...as(phone), origin: "https://hub.example.test" } });
    expect(del.status).toBe(200);
    expect(hub.store.pushSubscriptions()).toEqual([]);
  });
  it("only a browser vendor's push service, keys of the right size; signed out, nothing", async () => {
    const phone = await hub.cookie();
    const evil = await subscribe(phone, "https://collector.example/x");
    expect([evil.status, await evil.json()]).toEqual([400, { error: "not_a_push_service" }]);
    const inner = await subscribe(phone, "http://127.0.0.1:8790/api/devices");
    expect(inner.status).toBe(400);
    const bad = await hub.post("/api/push/subscription", { endpoint: "https://fcm.googleapis.com/a", keys: { p256dh: "AAAA", auth: keys.auth } }, as(phone));
    expect([bad.status, await bad.json()]).toEqual([400, { error: "bad_keys" }]);
    expect((await fetch(`${hub.base}/api/push/key`)).status).toBe(401);
    expect(hub.store.pushSubscriptions()).toEqual([]);
  });
  it("a request from another site can't unsubscribe (the origin check)", async () => {
    const phone = await hub.cookie();
    await subscribe(phone);
    const r = await fetch(`${hub.base}/api/push/subscription`, { method: "DELETE", headers: { ...as(phone), origin: "https://elsewhere.example" } });
    expect(r.status).toBe(403);
    expect(hub.store.pushSubscriptions()).toHaveLength(1);
  });
  it("signing out deletes this device's subscription, with an audit row (review L3)", async () => {
    const phone = await hub.cookie(), laptop = await hub.cookie();
    await subscribe(phone);
    await subscribe(laptop, "https://fcm.googleapis.com/fcm/send/laptop");
    const out = await fetch(`${hub.base}/api/logout`, { method: "POST", headers: { ...as(phone), origin: "https://hub.example.test" } });
    expect(out.status).toBe(200);
    expect(hub.store.pushSubscriptions().map(s => s.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/laptop"]);
    expect(hub.store.audit().find(a => a.type === "PushUnsubscribed")?.body).toMatchObject({ reason: "signed_out" });
  });
  it("revoking a device deletes its subscription, with an audit row", async () => {
    const phone = await hub.cookie();
    await subscribe(phone);
    const id = hub.store.pushSubscriptions()[0]?.endpointId ?? "";
    expect(hub.access.revoke(id)).toBe(true);
    expect(hub.store.pushSubscriptions()).toEqual([]);
    expect(hub.store.audit().find(a => a.type === "PushUnsubscribed")?.body).toMatchObject({ endpointId: id, reason: "revoked" });
  });
});

describe("pushes", () => {
  it("a device added from another raises a counts-only push to every subscribed device (AC13)", async () => {
    const phone = await hub.cookie();
    await subscribe(phone);
    const { secret, code } = await (await hub.post("/api/devices/add", {}, as(phone))).json() as { secret: string; code: string };
    const options = await (await hub.post("/api/pair/options", { token: secret, name: "laptop", code })).json() as { flowId: string };
    await hub.post("/api/pair/verify", { flowId: options.flowId, response: { id: "x", type: "public-key", response: {} } });
    await wait(1300);
    await hub.notifications.settled();
    expect(hub.pushes).toEqual([{ endpoint: "https://fcm.googleapis.com/fcm/send/abc", payload: { kind: 2, decisions: 0, workers: 0, linked: 1, alerts: 0 } }]);
    expect(hub.store.audit().find(a => a.type === "NotificationSent")?.body).toMatchObject({ kind: "linked", devices: 1 });
  });
  const decide = (ids: string[]) => hub.notifications.board(ids.map(id => ({ id, status: "open", need: "decision" })));
  it("while a device says he is attending, nothing goes; once it says he isn't, it does (N3)", async () => {
    const phone = await hub.cookie();
    await subscribe(phone);
    const feed = await hub.socket("/api/feed", phone);
    feed.send(JSON.stringify({ t: "visible", v: true }));
    await wait(100);
    decide(["ny-1"]);
    await wait(1300);
    await hub.notifications.settled();
    expect(hub.pushes).toEqual([]);
    feed.send(JSON.stringify({ t: "visible", v: false }));
    await wait(100);
    decide(["ny-1", "ny-2"]);
    await wait(1300);
    await hub.notifications.settled();
    expect(hub.pushes).toHaveLength(1);
    feed.close();
  });
  it("a closed feed no longer counts as attending", async () => {
    const phone = await hub.cookie();
    await subscribe(phone);
    const feed = await hub.socket("/api/feed", phone);
    feed.send(JSON.stringify({ t: "visible", v: true }));
    await wait(100);
    feed.close();
    await wait(200);
    decide(["ny-1"]);
    await wait(1300);
    await hub.notifications.settled();
    expect(hub.pushes).toHaveLength(1);
  });
});
