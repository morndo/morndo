// The service worker's side of web push (ADR-0008 phase F; N1, N3): every push shows a notification, as
// `userVisibleOnly` requires and Safari enforces (it revokes the subscription of a page that doesn't); its words come
// from the numbers alone, since the payload carries nothing else; one tag per kind, so a newer one replaces the older;
// a click focuses the app (or opens it) on what the notification is about. Pure apart from what comes in, so the
// handlers are tested without a browser (sw-push.test.ts).

export type PushView = { title: string; body: string; tag: string; url: string };
type Payload = { kind: number; decisions: number; workers: number; linked: number; alerts: number; usage: number };

const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000 ? v : null);
function payloadOf(data: unknown): Payload | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const kind = count(d.kind), decisions = count(d.decisions), workers = count(d.workers), linked = count(d.linked);
  const alerts = d.alerts === undefined ? 0 : count(d.alerts);      // a hub from before the fleet's alerts: none
  const usage = d.usage === undefined ? 0 : count(d.usage);         // a hub from before usage notices: none
  if (kind === null || kind > 4 || decisions === null || workers === null || linked === null || alerts === null || usage === null) return null;
  return { kind, decisions, workers, linked, alerts, usage };
}

const many = (n: number, one: string, more: string) => (n === 1 ? one : more.replace("#", String(n)));

// What a notification says for a payload; anything unreadable still shows one, saying only that something needs him.
export function notificationFor(data: unknown): PushView {
  const p = payloadOf(data);
  if (!p) return { title: "Morndo", body: "Something needs you.", tag: "morndo", url: "/" };
  switch (p.kind) {
    case 0: return {
      title: many(p.decisions, "A decision waits for you", "# decisions wait for you"),
      body: `Open Morndo to decide.${p.workers ? ` ${many(p.workers, "1 worker needs you", "# workers need you")} too.` : ""}`,
      tag: "morndo-decision", url: "/?view=decisions",
    };
    case 1: return {
      title: many(p.workers, "A worker needs you", "# workers need you"),
      body: `Open Morndo to see what it asks.${p.decisions ? ` ${many(p.decisions, "1 decision waits", "# decisions wait")} too.` : ""}`,
      tag: "morndo-worker", url: "/?view=activity",
    };
    case 2: return {
      title: many(p.linked, "A device was added", "# devices were added"),
      body: "Not you? Review your devices.",
      tag: "morndo-linked", url: "/devices",
    };
    case 4:
      // S4 (plan 4.4): a count of usage notices, Home's own view. A hub from before the count sends none: one.
      return {
        title: many(Math.max(p.usage, 1), "Usage needs a look", "# usage changes need a look"),
        body: "Open Morndo to see what changed.",
        tag: "morndo-usage", url: "/?view=dashboard",
      };
    default: return {
      title: many(p.alerts, "Your fleet has an alert", "Your fleet has # alerts"),
      body: "Open Morndo to see what happened.",
      tag: "morndo-alert", url: "/?view=alerts",
    };
  }
}

// What a push handler needs of the service worker's world.
export type SwWorld = {
  showNotification(title: string, options: { body: string; tag: string; data: { url: string }; icon: string; badge: string; renotify: boolean }): Promise<void>;
  matchClients(): Promise<readonly { url: string; focus(): Promise<unknown>; navigate(url: string): Promise<unknown> }[]>;
  openWindow(url: string): Promise<unknown>;
  origin: string;
};

// The `push` event: its data as JSON, or nothing readable; a notification either way.
export async function onPush(json: () => unknown, world: SwWorld): Promise<void> {
  let data: unknown = null;
  try { data = json(); } catch { data = null; }
  const v = notificationFor(data);
  await world.showNotification(v.title, { body: v.body, tag: v.tag, data: { url: v.url }, icon: "/favicon.svg", badge: "/favicon.svg", renotify: true });
}

// The `notificationclick` event: an open window of the app is focused and taken there; otherwise one is opened. Only
// addresses of this app are followed.
export async function onNotificationClick(data: unknown, world: SwWorld): Promise<void> {
  const raw = data && typeof data === "object" ? (data as { url?: unknown }).url : null;
  const url = new URL(typeof raw === "string" ? raw : "/", world.origin);
  const target = url.origin === world.origin ? url.pathname + url.search : "/";
  const open = (await world.matchClients()).find(c => new URL(c.url).origin === world.origin);
  if (open) {
    await open.focus();
    await open.navigate(target);
  } else await world.openWindow(target);
}
