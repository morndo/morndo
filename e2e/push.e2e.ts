// End-to-end checks for web push (ADR-0008 phase F; N1–N5) on a synthetic office with its own hub, and a push service
// of the test's own on localhost (the hub allows it through MORNDO_PUSH_EXTRA_ORIGINS; in production only the browser
// vendors' push services are accepted). Run: npm run build && node e2e/push.e2e.ts
//   1. The service worker: a push delivered through CDP (ServiceWorker.deliverPushMessage, which skips encryption) shows
//      a notification built from its numbers, and a newer one of the same kind replaces it.
//   2. The hub: a Decision that starts waiting reaches the push service encrypted (RFC 8291), with VAPID (RFC 8292),
//      counts only; nothing goes while a device says he is attending (N3).
// A real browser's decryption of the hub's push is the owner-style round trip in the QA record, not here.
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { verifyVapidJwt } from "../apps/hub/src/adapters/webpush.ts";
import { assert, checks, outDir, pairedPage, startOffice } from "./harness.ts";

const OUT = outDir("push");

// The test's push service: keeps what the hub posts.
const received: { headers: IncomingHttpHeaders; body: Buffer }[] = [];
const service = createServer((req, res) => {
  const parts: Buffer[] = [];
  req.on("data", (d: Buffer) => parts.push(d));
  req.on("end", () => { received.push({ headers: req.headers, body: Buffer.concat(parts) }); res.writeHead(201).end(); });
});
await new Promise<void>(r => service.listen(0, "127.0.0.1", r));
const serviceOrigin = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;

const office = await startOffice("push", { MORNDO_PUSH_EXTRA_ORIGINS: serviceOrigin });
const { check, watch, finish } = checks(OUT);
// The full Chromium in new headless mode: Playwright's default headless shell has no notification permission at all
// (showNotification throws "No notification permission has been granted", even after grantPermissions; probed
// 2026-10-02), while this one shows them and takes CDP's pushes.
const browser = await chromium.launch({ channel: "chromium" });
let code = 1;

// The user agent's side of RFC 8291: its key and secret open what the hub sealed.
const ua = createECDH("prime256v1");
ua.generateKeys();
const auth = randomBytes(16);
function open(body: Buffer): unknown {
  const salt = body.subarray(0, 16), idlen = body.readUInt8(20), asPublic = body.subarray(21, 21 + idlen), sealed = body.subarray(21 + idlen);
  const secret = ua.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync("sha256", secret, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  const padded = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  return JSON.parse(padded.subarray(0, padded.length - 1).toString()) as unknown;
}
const { ledger, writeLedger } = office.office;
const addDecision = (id: string, question: string) => {
  ledger.needsYou.push({ id, kind: "tap", question, default: "wait", deadline: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), ts: new Date().toISOString() });
  writeLedger(ledger);
};
const waitFor = async (cond: () => boolean, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 100)); } return cond(); };

try {
  const { context, page, cdp } = await pairedPage(browser, office, { serviceWorkers: "allow" });
  watch(page);
  await context.grantPermissions(["notifications"], { origin: office.base });

  await check("the service worker shows a push built from its numbers, and a newer one of its kind replaces it (CDP)", async () => {
    // What Chromium says about each push, on one clock: the pushMessaging and notifications events of the DevTools
    // BackgroundService domain (experimental; https://chromedevtools.github.io/devtools-protocol/tot/BackgroundService/),
    // the worker's state changes and errors, and when each CDP delivery returned. Printed when this check fails.
    const t0 = Date.now();
    const trace: string[] = [];
    const displayed: string[] = [];                                       // the titles Chromium displayed, in order
    const note = (what: string) => trace.push(`${((Date.now() - t0) / 1000).toFixed(3)}s ${what}`);
    const onEvent = (e: { backgroundServiceEvent: { service: string; eventName: string; instanceId: string; eventMetadata: { key: string; value: string }[] } }) => {
      const ev = e.backgroundServiceEvent;
      note(`${ev.service} "${ev.eventName}" instance ${ev.instanceId} ${ev.eventMetadata.map(m => `${m.key}=${m.value}`).join(" ")}`);
      if (ev.service === "notifications" && ev.eventName === "Notification displayed") displayed.push(ev.eventMetadata.find(m => m.key === "Title")?.value ?? "");
    };
    const onVersion = (e: { versions: { versionId: string; runningStatus: string; status: string }[] }) => { for (const v of e.versions) note(`worker version ${v.versionId}: ${v.runningStatus}, ${v.status}`); };
    const onError = (e: { errorMessage: { errorMessage: string } }) => note(`worker error: ${e.errorMessage.errorMessage}`);
    const services = ["pushMessaging", "notifications"] as const;
    cdp.on("BackgroundService.backgroundServiceEventReceived", onEvent);
    cdp.on("ServiceWorker.workerVersionUpdated", onVersion);
    cdp.on("ServiceWorker.workerErrorReported", onError);
    try {
      for (const service of services) {
        await cdp.send("BackgroundService.startObserving", { service });
        await cdp.send("BackgroundService.setRecording", { shouldRecord: true, service });
      }
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      const registrations: { registrationId: string; scopeURL: string }[] = [];
      cdp.on("ServiceWorker.workerRegistrationUpdated", e => registrations.push(...(e.registrations as typeof registrations)));
      await cdp.send("ServiceWorker.enable");
      assert(await waitFor(() => registrations.some(r => r.scopeURL.startsWith(office.base)), 10_000), "no service worker registration");
      const registrationId = registrations.find(r => r.scopeURL.startsWith(office.base))?.registrationId ?? "";
      const shown = () => page.evaluate(() => navigator.serviceWorker.ready.then(r => r.getNotifications()).then(ns => ns.map(n => ({ title: n.title, body: n.body, tag: n.tag }))));
      // Delivers a push and waits until Chromium says it displayed the notification, and only then does the caller read
      // the list. Reading getNotifications() while Chromium is still storing a notification can lose that notification
      // for good: it is displayed, and never listed (T-67: push 1 empty in 3 of 160 plain runs, 8 of 30 with reads back to
      // back; push 3 missing in 2 of 40 with reads throughout, the failure CI showed about 1 in 19 runs).
      const deliver = async (n: number, data: string, title: string) => {
        const before = displayed.length;
        note(`push ${n} sent`);
        await cdp.send("ServiceWorker.deliverPushMessage", { origin: office.base, registrationId, data });
        note(`push ${n} returned`);
        assert(await waitFor(() => displayed.slice(before).includes(title), 10_000), `Chromium never displayed push ${n} ("${title}")`);
      };
      await deliver(1, JSON.stringify({ kind: 0, decisions: 2, workers: 1, linked: 0 }), "2 decisions wait for you");
      let list: { title: string; body: string; tag: string }[] = [];
      for (let i = 0; i < 50 && !list.length; i++) { list = await shown(); if (!list.length) await page.waitForTimeout(100); }
      assert(JSON.stringify(list) === JSON.stringify([{ title: "2 decisions wait for you", body: "Open Morndo to decide. 1 worker needs you too.", tag: "morndo-decision" }]), `shown: ${JSON.stringify(list)}`);
      await deliver(2, JSON.stringify({ kind: 0, decisions: 3, workers: 1, linked: 0 }), "3 decisions wait for you");
      for (let i = 0; i < 50; i++) { list = await shown(); if (list[0]?.title.startsWith("3")) break; await page.waitForTimeout(100); }
      assert(list.length === 1 && list[0]?.title === "3 decisions wait for you", `after the second: ${JSON.stringify(list)}`);
      await deliver(3, "not json", "Morndo");
      for (let i = 0; i < 50; i++) { list = await shown(); if (list.length === 2) break; await page.waitForTimeout(100); }
      assert(list.some(n => n.title === "Morndo" && n.body === "Something needs you."), `an unreadable push showed: ${JSON.stringify(list)}`);
    } catch (e) {
      console.log(`      push trace:\n${trace.map(l => `        ${l}`).join("\n")}`);
      throw e;
    } finally {
      // The recording belongs to this check: a later check in the same browser must not keep filling its trace. A failed
      // stop (the page already gone) must not hide the check's own failure.
      cdp.off("BackgroundService.backgroundServiceEventReceived", onEvent);
      cdp.off("ServiceWorker.workerVersionUpdated", onVersion);
      cdp.off("ServiceWorker.workerErrorReported", onError);
      for (const service of services) {
        await cdp.send("BackgroundService.setRecording", { shouldRecord: false, service }).catch(() => undefined);
        await cdp.send("BackgroundService.stopObserving", { service }).catch(() => undefined);
      }
    }
  });

  await check("the hub sends nothing while this device says he is attending (N3)", async () => {
    const r = await page.evaluate(([endpoint, p256dh, a]) => fetch("/api/push/subscription", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint, keys: { p256dh, auth: a } }),
    }).then(x => x.status), [`${serviceOrigin}/push/device-1`, ua.getPublicKey().toString("base64url"), auth.toString("base64url")] as const);
    assert(r === 200, `subscribing answered ${r}`);
    await page.bringToFront();
    await page.mouse.click(5, 5);                                            // his input, in a focused window
    await page.waitForTimeout(500);
    addDecision("ny-20", "Keep the old logo on the invoice?");
    await page.waitForTimeout(5000);
    assert(received.length === 0, `pushed while he was attending: ${received.length}`);
  });

  await check("with no device attending, a Decision that starts waiting reaches the push service encrypted, counts only, with VAPID", async () => {
    await context.close();                                                   // no device open: nobody attending
    addDecision("ny-21", "Move the standup to 10:00?");
    assert(await waitFor(() => received.length > 0, 15_000), "nothing reached the push service");
    const got = received[0];
    if (!got) throw new Error("no push");
    const payload = open(got.body) as Record<string, unknown>;
    assert(Object.values(payload).every(v => typeof v === "number"), `not numbers only: ${JSON.stringify(payload)}`);
    assert(payload.kind === 0 && typeof payload.decisions === "number" && payload.decisions >= 3, `payload ${JSON.stringify(payload)}`);
    const h = got.headers;
    assert(h["content-encoding"] === "aes128gcm" && h.topic === "decision" && h.urgency === "high" && h.ttl === String(12 * 3600), `headers ${JSON.stringify({ ce: h["content-encoding"], topic: h.topic, urgency: h.urgency, ttl: h.ttl })}`);
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(String(h.authorization));
    assert(m && verifyVapidJwt(m[1] ?? "", Buffer.from(m[2] ?? "", "base64url")), "the VAPID JWT doesn't verify with its key");
    const claims = JSON.parse(Buffer.from((m?.[1] ?? "").split(".")[1] ?? "", "base64url").toString()) as { aud: string; exp: number; sub: string };
    assert(claims.aud === serviceOrigin && claims.exp - Date.now() / 1000 <= 24 * 3600 && claims.sub.length > 0, `claims ${JSON.stringify(claims)}`);
    assert(received.length === 1, `one Decision, ${received.length} pushes`);
    assert(!got.body.toString("latin1").includes("standup"), "the question travelled in clear");
  });
  code = finish();
} finally {
  await browser.close();
  office.stop();
  service.close();
}
process.exit(code);
