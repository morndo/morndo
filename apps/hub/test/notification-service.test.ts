// Notifications on the hub (ADR-0008 phase F; N1–N5): a Decision starting to wait, a worker starting to need him (not
// when muted) or a device linked raises one; per kind the latest wins after a second; nothing goes while he is attending
// on any device; the payload is numbers only and passes the protocol's strict schema; a push service's 404 or 410
// drops that subscription; the audit keeps when and how many, never who or what. A fake sender: no network.
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationEvent } from "@morndo/domain";
import { PushPayload, parseBody } from "@morndo/protocol";
import { NotificationService, type PushStore } from "../src/application/notification-service.ts";
import { loadOrCreateVapid, pushSender, type PushOptions, type PushSubscription } from "../src/adapters/webpush.ts";
import { log } from "../src/adapters/log.ts";

type Sent = { endpoint: string; payload: unknown; options: PushOptions };
let sent: Sent[];
let answer: (endpoint: string) => number;
let reason: (endpoint: string) => string | undefined;
let audit: NotificationEvent[];
let subs: ({ endpointId: string } & PushSubscription)[];
let muted: Set<string>;
let svc: NotificationService;

const store: PushStore = {
  pushSubscriptions: () => subs,
  savePushSubscription: (endpointId, s) => { subs = [...subs.filter(x => x.endpointId !== endpointId), { endpointId, ...s }]; },
  deletePushSubscription: id => { const n = subs.length; subs = subs.filter(s => s.endpointId !== id); return subs.length < n; },
  record: e => { audit.push(...e); },
};
const sub = (id: string) => ({ endpointId: id, endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, p256dh: "k", auth: "a" });
const decision = (id: string, status = "open") => ({ id, status, need: "decision" });
const tick = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await svc.settled(); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 2, 12));
  sent = []; audit = []; subs = [sub("phone"), sub("laptop")]; muted = new Set(); answer = () => 201; reason = () => undefined;
  svc = new NotificationService({
    store, muted: w => muted.has(w),
    send: async (s, payload, options) => { sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload.toString()), options }); const why = reason(s.endpoint); return why === undefined ? { status: answer(s.endpoint) } : { status: answer(s.endpoint), reason: why }; },
  });
  svc.board([]);                                                     // what waits at start: nothing
});
afterEach(() => { svc.stop(); vi.useRealTimers(); });

describe("what raises a Notification (N2)", () => {
  it("a Decision starting to wait: after a second, one push to each device, numbers only, and an audit row", async () => {
    svc.board([decision("ny-1")]);
    await tick(999);
    expect(sent).toEqual([]);
    await tick(1);
    expect(sent.map(s => s.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/phone", "https://fcm.googleapis.com/fcm/send/laptop"]);
    expect(sent[0]?.payload).toEqual({ kind: 0, decisions: 1, workers: 0, linked: 0, alerts: 0, usage: 0 });
    expect(sent[0]?.options).toEqual({ ttlSeconds: 12 * 3600, topic: "decision", urgency: "high" });
    expect(audit).toEqual([{ type: "NotificationSent", kind: "decision", counts: { decisions: 1, workers: 0, linked: 0, alerts: 0, usage: 0 }, devices: 2, at: Date.now() }]);
  });
  it("the board at start raises nothing: those were waiting before", async () => {
    const fresh = new NotificationService({ store, send: async () => ({ status: 201 }) });
    fresh.board([decision("ny-1"), decision("ny-2")]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(audit).toEqual([]);
    fresh.stop();
  });
  it("a worker that starts needing him with something that isn't an Ask; not one that still does, not a muted one; a Decision even if its asker is muted", async () => {
    svc.worker("%1", false, null, true);
    svc.worker("%1", true, null);
    await tick(1000);
    expect(sent.at(-1)?.payload).toEqual({ kind: 1, decisions: 0, workers: 1, linked: 0, alerts: 0, usage: 0 });
    expect(sent.at(-1)?.options).toEqual({ ttlSeconds: 3600, topic: "worker", urgency: "normal" });
    const before = sent.length;
    svc.worker("%1", true, null);                                    // still needing
    muted.add("%2");
    svc.worker("%2", true, null);                                    // muted
    await tick(2000);
    expect(sent.length).toBe(before);
    svc.board([decision("ny-9")]);
    await tick(1000);
    expect(sent.at(-1)?.payload).toEqual({ kind: 0, decisions: 1, workers: 1, linked: 0, alerts: 0, usage: 0 });   // the muted worker isn't counted
  });
  it("every kind's Topic is one a push service takes: at most 32 URL-safe Base64 characters, a length that decodes (Apple refused the 5-character \"alert\" and \"usage\" with 400 BadWebPushTopic, 2026-10-12 and 2026-10-25)", async () => {
    const topicsOf: string[] = [];
    const all = new NotificationService({ store, alerts: () => 1, send: async (_s, _p, o) => { topicsOf.push(o.topic); return { status: 201 }; } });
    all.board([]);
    all.board([decision("t-1")]);
    all.worker("%1", false, null, true);
    all.worker("%1", true, null);
    all.linked();
    all.alert(true);
    all.usage();
    await vi.advanceTimersByTimeAsync(5000); await all.settled();
    all.stop();
    const topics = [...new Set(topicsOf)].sort();
    expect(topics).toHaveLength(5);                                     // decision, worker, linked, alert, usage
    for (const t of topics) {
      expect(t, t).toMatch(/^[A-Za-z0-9_-]{1,32}$/);                  // RFC 8030 section 5.4
      expect(t.length % 4, `${t}: a Base64 length`).not.toBe(1);       // 4n+1 never decodes; Apple checks it
    }
  });
  it("a device linked (AC13)", async () => {
    svc.linked();
    await tick(1000);
    expect(sent[0]?.payload).toEqual({ kind: 2, decisions: 0, workers: 0, linked: 1, alerts: 0, usage: 0 });
    expect(sent[0]?.options).toEqual({ ttlSeconds: 3600, topic: "linked", urgency: "high" });
    svc.linked();
    await tick(1000);
    expect(sent.at(-1)?.payload).toMatchObject({ kind: 2, linked: 1 });   // counted from the last one that went
  });
});

describe("the latest wins after a second (N3)", () => {
  it("two Decisions within the second: one push, with both counted", async () => {
    svc.board([decision("ny-1")]);
    await tick(500);
    svc.board([decision("ny-1"), decision("ny-2")]);
    await tick(999);
    expect(sent).toEqual([]);
    await tick(1);
    expect(sent.map(s => s.payload)).toEqual([{ kind: 0, decisions: 2, workers: 0, linked: 0, alerts: 0, usage: 0 }, { kind: 0, decisions: 2, workers: 0, linked: 0, alerts: 0, usage: 0 }]);
  });
  it("answered within the second: nothing to say, nothing sent", async () => {
    svc.board([decision("ny-1")]);
    await tick(400);
    svc.board([decision("ny-1", "answered")]);
    await tick(2000);
    expect(sent).toEqual([]);
    expect(audit).toEqual([]);
  });
});

describe("nothing while he is attending (N3, amendment 3)", () => {
  it("one device attending silences all; a report two minutes old doesn't; a closed connection doesn't", async () => {
    svc.attending("conn-1", true);
    svc.board([decision("ny-1")]);
    await tick(1000);
    expect(sent).toEqual([]);
    expect(audit).toEqual([]);
    await tick(2 * 60_000);
    svc.board([decision("ny-1"), decision("ny-2")]);
    await tick(1000);
    expect(sent.length).toBe(2);                                    // the report aged out
    svc.attending("conn-2", true);
    svc.left("conn-2");
    svc.board([decision("ny-1"), decision("ny-2"), decision("ny-3")]);
    await tick(1000);
    expect(sent.length).toBe(4);
  });
  it("a device that says it isn't attending doesn't silence anything", async () => {
    svc.attending("conn-1", false);
    svc.board([decision("ny-1")]);
    await tick(1000);
    expect(sent.length).toBe(2);
  });
});

describe("push services answering (N4)", () => {
  it("a refusal is recorded with the push service's reason code and logged, and the subscription is kept", async () => {
    const warned: string[] = [];
    const spy = vi.spyOn(log, "warn").mockImplementation(m => { warned.push(m); });
    reason = e => (e.endsWith("/phone") ? "BadJwtToken" : undefined);
    answer = e => (e.endsWith("/phone") ? 403 : 201);
    svc.board([decision("ny-1")]);
    await tick(1000);
    expect(audit[0]).toEqual({ type: "NotificationFailed", kind: "decision", status: 403, reason: "BadJwtToken", at: Date.now() });
    expect(audit[1]).toMatchObject({ type: "NotificationSent", devices: 1 });
    expect(subs.map(s => s.endpointId)).toEqual(["phone", "laptop"]);
    expect(warned).toEqual(["a push service refused a decision notification: 403 BadJwtToken"]);
    spy.mockRestore();
  });
  it("whatever a sender gives as the reason, only a short code reaches the audit and the log (review L8)", async () => {
    const warned: string[] = [];
    const spy = vi.spyOn(log, "warn").mockImplementation(m => { warned.push(m); });
    reason = () => "the device of user 42 said <b>no</b>\nand more";
    answer = () => 403;
    svc.board([decision("ny-1")]);
    await tick(1000);
    expect(audit).toEqual([{ type: "NotificationFailed", kind: "decision", status: 403, at: Date.now() }, { type: "NotificationFailed", kind: "decision", status: 403, at: Date.now() }]);
    expect(warned).toEqual(["a push service refused a decision notification: 403", "a push service refused a decision notification: 403"]);
    spy.mockRestore();
  });
  it("404 or 410 drops that subscription; another failure is recorded, counts only; the rest still get it", async () => {
    answer = e => (e.endsWith("/phone") ? 410 : e.endsWith("/laptop") ? 500 : 201);
    subs.push(sub("tablet"));
    svc.board([decision("ny-1")]);
    await tick(1000);
    expect(subs.map(s => s.endpointId)).toEqual(["laptop", "tablet"]);
    expect(audit.map(a => a.type)).toEqual(["PushUnsubscribed", "NotificationFailed", "NotificationSent"]);
    expect(audit[0]).toMatchObject({ endpointId: "phone", reason: "gone" });
    expect(audit[1]).toEqual({ type: "NotificationFailed", kind: "decision", status: 500, at: Date.now() });
    expect(audit[2]).toMatchObject({ devices: 1 });
  });
});

describe("the payload (N1, amendment 4)", () => {
  it("passes the protocol's strict numbers-only schema, which refuses a name or text", async () => {
    svc.worker("%1", true, null);
    svc.board([decision("ny-1")]);
    svc.linked();
    await tick(1000);
    for (const s of sent) {
      expect(parseBody(PushPayload, s.payload)).toEqual(s.payload);
      expect(Object.values(s.payload as object).every(v => typeof v === "number")).toBe(true);
    }
    expect(new Set(sent.map(s => (s.payload as { kind: number }).kind))).toEqual(new Set([0, 1, 2]));
    expect(parseBody(PushPayload, { kind: 1, decisions: 0, workers: 1, linked: 0, worker: "builder" })).toBeNull();
    expect(parseBody(PushPayload, { kind: "worker", decisions: 0, workers: 1, linked: 0 })).toBeNull();
    expect(parseBody(PushPayload, { kind: 5, decisions: 0, workers: 1, linked: 0, alerts: 0, usage: 0 })).toBeNull();
  });
  it("records nothing but Notification rows: no Delivery, nothing an Escalation counts (N5)", async () => {
    answer = () => 500;
    svc.board([decision("ny-1")]);
    await tick(1000);
    answer = () => 201;
    svc.board([decision("ny-1"), decision("ny-2")]);
    await tick(1000);
    expect(new Set(audit.map(a => a.type))).toEqual(new Set(["NotificationFailed", "NotificationSent"]));
  });
});

describe("subscriptions (N4)", () => {
  // A browser's keys: a real point on P-256 and a 16-byte secret.
  const ua = () => { const e = createECDH("prime256v1"); e.generateKeys(); return { p256dh: e.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") }; };
  const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url");     // the right size, no point
  it("one per device, replaced by a new one, audited; only a browser's push service; keys of the right size", () => {
    subs = [];
    expect(svc.subscribe("phone", { endpoint: "https://fcm.googleapis.com/fcm/send/a", ...ua() })).toEqual({ ok: true });
    expect(svc.subscribe("phone", { endpoint: "https://fcm.googleapis.com/fcm/send/b", ...ua() })).toEqual({ ok: true });
    expect(subs.map(s => s.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/b"]);
    expect(svc.subscribe("phone", { endpoint: "https://evil.example/collect", ...ua() })).toEqual({ refused: "not_a_push_service" });
    expect(svc.subscribe("phone", { endpoint: "https://fcm.googleapis.com/x", p256dh: "AAAA", auth: ua().auth })).toEqual({ refused: "bad_keys" });
    expect(svc.subscribe("phone", { endpoint: "https://fcm.googleapis.com/x", p256dh: offCurve, auth: ua().auth })).toEqual({ refused: "bad_keys" });   // review H1
    expect(svc.subscribe("phone", { endpoint: "https://fcm.googleapis.com/x", p256dh: ua().p256dh, auth: "AAAA" })).toEqual({ refused: "bad_keys" });
    svc.unsubscribe("phone");
    svc.unsubscribe("phone");                                        // nothing left: nothing recorded
    expect(subs).toEqual([]);
    expect(audit.map(a => a.type)).toEqual(["PushSubscribed", "PushSubscribed", "PushUnsubscribed"]);
  });
});

describe("one bad subscription can't stop the others, or the hub (review H1)", () => {
  it("a sender that throws for one device: the others still get it, and the next round still goes", async () => {
    const throwing = new NotificationService({
      store, send: async (s, payload) => {
        if (s.endpoint.endsWith("/phone")) throw new Error("boom");
        sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload.toString()), options: { ttlSeconds: 0, topic: "", urgency: "normal" } });
        return { status: 201 };
      },
    });
    throwing.board([]);
    throwing.board([decision("ny-1")]);
    await vi.advanceTimersByTimeAsync(1000); await throwing.settled();
    throwing.board([decision("ny-1"), decision("ny-2")]);
    await vi.advanceTimersByTimeAsync(1000); await throwing.settled();
    expect(sent.map(s => s.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/laptop", "https://fcm.googleapis.com/fcm/send/laptop"]);
    throwing.stop();
  });
  it("the real sender with a key that isn't a point (stored before this check): dropped as invalid, nothing thrown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-push-h1-"));
    try {
      const { p256dh, auth } = (() => { const e = createECDH("prime256v1"); e.generateKeys(); return { p256dh: e.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") }; })();
      subs = [{ endpointId: "bad", endpoint: "https://fcm.googleapis.com/fcm/send/bad", p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url"), auth },
        { endpointId: "good", endpoint: "http://127.0.0.1:9/nobody", p256dh, auth }];
      const real = new NotificationService({ store, send: pushSender(loadOrCreateVapid(dir, "mailto:test@example.test"), Date.now, 1000) });
      real.board([]);
      real.board([decision("ny-1")]);
      await vi.advanceTimersByTimeAsync(1000); await real.settled();
      expect(subs.map(s => s.endpointId)).toEqual(["good"]);
      expect(audit.find(a => a.type === "PushUnsubscribed")).toMatchObject({ endpointId: "bad", reason: "invalid" });
      real.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("one push per ask (review M1)", () => {
  it("a worker's question is an Ask: one Decision push, not a worker one too, and it isn't counted twice", async () => {
    svc.worker("%3", false, null, true);
    svc.worker("%3", true, "q:toolu_1");                              // the question it waits on…
    svc.board([decision("q-toolu_1")]);                              // …is the Ask the board shows
    await tick(1000);
    expect(sent.map(s => s.payload)).toEqual([{ kind: 0, decisions: 1, workers: 0, linked: 0, alerts: 0, usage: 0 }, { kind: 0, decisions: 1, workers: 0, linked: 0, alerts: 0, usage: 0 }]);
  });
  it("a muted worker's question still goes, as a Decision: an Ask breaks mute, as a mention does", async () => {
    muted.add("%3");
    svc.worker("%3", true, "menu:abc");
    svc.board([decision("menu-3")]);
    await tick(1000);
    expect(sent.map(s => (s.payload as { kind: number }).kind)).toEqual([0, 0]);
  });
});

describe("a device linked goes even while he is attending (review M2)", () => {
  it("attending drops a Decision push but not a linked one", async () => {
    svc.attending("conn-1", true);
    svc.board([decision("ny-1")]);
    svc.linked();
    await tick(1000);
    expect(sent.map(s => (s.payload as { kind: number }).kind)).toEqual([2, 2]);
  });
});

describe("a usage notice the hub wrote (S4, plan 4.4)", () => {
  it("counts one more per notice, debounced, and the count resets once it went; the payload is the count, no text", async () => {
    svc.usage();
    svc.usage();                                                       // a second before the second is over: one push, both counted
    await tick(999);
    expect(sent).toEqual([]);
    await tick(1);
    expect(sent.map(s => s.payload)).toEqual([{ kind: 4, decisions: 0, workers: 0, linked: 0, alerts: 0, usage: 2 }, { kind: 4, decisions: 0, workers: 0, linked: 0, alerts: 0, usage: 2 }]);
    expect(sent[0]?.options).toEqual({ ttlSeconds: 6 * 3600, topic: "usages", urgency: "normal" });
    expect(audit).toEqual([{ type: "NotificationSent", kind: "usage", counts: { decisions: 0, workers: 0, linked: 0, alerts: 0, usage: 2 }, devices: 2, at: Date.now() }]);
    expect(Object.values(sent[0]?.payload as object).every(v => typeof v === "number")).toBe(true);   // numbers only, never a word of the notice
    svc.usage();                                                       // counted from zero again
    await tick(1000);
    expect(sent.at(-1)?.payload).toEqual({ kind: 4, decisions: 0, workers: 0, linked: 0, alerts: 0, usage: 1 });
  });
  it("not while he is attending; the count waits for the next one", async () => {
    svc.attending("conn-1", true);
    svc.usage();
    await tick(2000);
    expect(sent).toEqual([]);
    expect(audit).toEqual([]);
    expect(svc.counts().usage).toBe(1);                                // still counted: it goes with the next one
  });
  it("the payload passes the protocol's strict numbers-only schema", async () => {
    svc.usage();
    await tick(1000);
    for (const s of sent) {
      expect(parseBody(PushPayload, s.payload)).toEqual(s.payload);
      expect(parseBody(PushPayload, { ...(s.payload as object), text: "seat-a: plan changed" })).toBeNull();
    }
  });
});

