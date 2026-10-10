// Manual QA (ADR-0008 phase F): one real web push round trip through a real browser's push service. Run a demo office
// (node e2e/demo-office.ts <port>), then, against a Chrome that has its push service (FCM) and listens for CDP:
//   node e2e/qa-push-roundtrip.ts <cdp url> <demo origin> <the demo's MORNDO_HOME> <out dir>
// Raw CDP on a tab of its own (made through /json/new, closed through /json/close): it never attaches to the browser's
// other tabs. That tab loads the demo app, which registers its service worker; the notification permission is granted
// for that origin only (over CDP, no prompt clicked); Chrome subscribes to its own push service with the hub's VAPID
// key; the subscription goes into the demo hub's database as a device's would. Then a new Decision in the synthetic
// ledger makes the hub encrypt and post the counts to that push service, and the service worker's notifications are
// read back: shown only if Chrome received the push and decrypted it. Afterwards: notification closed, unsubscribed on
// both sides, that origin's permission back to "ask", tab closed.
// It doesn't pair the browser: in a browser whose password manager takes over passkeys, a test authenticator never sees
// the request. The toggle and pairing are covered by the Chromium tests (push-web, e2e/signal).
import Database from "better-sqlite3";
import { createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [cdpUrl = "http://127.0.0.1:9222", origin = "http://localhost:8811", home = "", out = "."] = process.argv.slice(2);
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// The hub's VAPID public key, uncompressed, as the browser subscribes with it.
const jwk = createPublicKey(readFileSync(join(home, "push-vapid.pem"))).export({ format: "jwk" });
const vapidKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x ?? "", "base64url"), Buffer.from(jwk.y ?? "", "base64url")]).toString("base64url");

// One CDP connection: send(method, params) → result.
async function connect(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let n = 0;
  const waiting = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();
  ws.onmessage = e => {
    const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message: string } };
    if (m.id !== undefined) waiting.get(m.id)?.(m);
  };
  return {
    send: <T>(method: string, params: Record<string, unknown> = {}) => new Promise<T>((resolve, reject) => {
      const id = ++n;
      waiting.set(id, m => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result as T)));
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => ws.close(),
  };
}

const version = await (await fetch(`${cdpUrl}/json/version`)).json() as { webSocketDebuggerUrl: string };
const target = await (await fetch(`${cdpUrl}/json/new?about:blank`, { method: "PUT" })).json() as { id: string; webSocketDebuggerUrl: string };
const browser = await connect(version.webSocketDebuggerUrl);
const tab = await connect(target.webSocketDebuggerUrl);
const run = async <T>(expression: string): Promise<T> => {
  const r = await tab.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const go = async (url: string) => { await tab.send("Page.navigate", { url }); await sleep(2500); };
const until = async (expression: string, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if (await run<boolean>(expression).catch(() => false)) return true;
  return false;
};
const shot = async (name: string) => {
  const r = await tab.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(out, name), Buffer.from(r.data, "base64"));
};
const db = new Database(join(home, "morndo.db"), { timeout: 15_000 });
const notifications = `navigator.serviceWorker.ready.then(r => r.getNotifications()).then(ns => JSON.stringify(ns.map(n => ({ title: n.title, body: n.body, tag: n.tag }))))`;

let result = 1;
try {
  await tab.send("Page.enable");
  await tab.send("Page.bringToFront");                               // a tab in the background is held back by Chrome
  await browser.send("Browser.setPermission", { permission: { name: "notifications" }, setting: "granted", origin });
  log(`notifications granted for ${origin} only`);
  await go(`${origin}/`);
  if (!(await until(`navigator.serviceWorker.ready.then(r => !!r.active)`, 60_000))) throw new Error("no service worker");
  const sub = JSON.parse(await run<string>(`navigator.serviceWorker.ready.then(r => r.pushManager.subscribe({ userVisibleOnly: true,
    applicationServerKey: Uint8Array.from(atob("${vapidKey}".replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)) })).then(s => JSON.stringify(s.toJSON()))`)) as { endpoint: string; keys: { p256dh: string; auth: string } };
  log(`Chrome subscribed at ${new URL(sub.endpoint).host}`);
  db.prepare("INSERT OR REPLACE INTO push_subscriptions (endpoint_id, url, p256dh, auth, at) VALUES ('qa-roundtrip', ?, ?, ?, ?)").run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now());

  await go("about:blank");                                           // no app open anywhere: nobody is attending
  const ledgerPath = join(home, "ledger.json");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as { needsYou: unknown[] };
  ledger.needsYou.push({ id: `ny-rt-${Date.now()}`, kind: "tap", question: "Round trip: keep this synthetic decision?", default: "no", deadline: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), ts: new Date().toISOString() });
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  const asked = Date.now();
  log("a Decision starts waiting");
  await sleep(15_000);                                               // the hub's look, the second's wait, the push service, Chrome

  const rows = db.prepare("SELECT type, body FROM audit WHERE at >= ? AND type LIKE 'Notification%' ORDER BY seq").all(asked) as { type: string; body: string }[];
  log(`hub audit: ${JSON.stringify(rows.map(r => ({ type: r.type, ...(JSON.parse(r.body) as object) })))}`);
  await go(`${origin}/`);
  let shown: { title: string; body: string; tag: string }[] = [];
  for (let i = 0; i < 30 && !shown.length; i++) { shown = JSON.parse(await run<string>(notifications)) as typeof shown; if (!shown.length) await sleep(1000); }
  log(`shown by the service worker: ${JSON.stringify(shown)}`);
  result = shown.some(n => n.tag === "morndo-decision" && /decisions? wait/.test(n.title)) ? 0 : 1;
  await shot("f-roundtrip-app.png");
} catch (e) {
  log(`error: ${(e as Error).message}`);
} finally {
  await run(`navigator.serviceWorker.ready.then(r => r.getNotifications()).then(ns => ns.forEach(n => n.close()))`).catch(() => {});
  const left = await run<string>(`navigator.serviceWorker.ready.then(r => r.pushManager.getSubscription()).then(s => s ? s.unsubscribe().then(() => "unsubscribed") : "none")`).catch(e => String(e));
  log(`browser subscription: ${left}`);
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint_id = 'qa-roundtrip'").run();
  db.close();
  await browser.send("Browser.setPermission", { permission: { name: "notifications" }, setting: "prompt", origin }).catch(() => {});
  tab.close();
  browser.close();
  await fetch(`${cdpUrl}/json/close/${target.id}`, { method: "PUT" }).catch(() => {});
  log(result === 0 ? "ROUND TRIP OK" : "ROUND TRIP FAILED");
  process.exit(result);
}
