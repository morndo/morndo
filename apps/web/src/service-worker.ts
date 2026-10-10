/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />
// App-shell cache (https://svelte.dev/docs/kit/service-workers); the hub's API and live feed are never cached. And web
// push (ADR-0008 phase F): every push shows a notification built from its numbers; a click opens the app there.
import { build, files, version } from "$service-worker";
import { onNotificationClick, onPush, type SwWorld } from "./lib/sw-push.ts";

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `morndo-${version}`;
const ASSETS = [...build, ...files];

sw.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => sw.skipWaiting()));
});

sw.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => sw.clients.claim()));
});

sw.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== sw.location.origin || url.pathname.startsWith("/api/")) return;
  if (ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(url.pathname).then(r => r ?? fetch(event.request)));
  }
  // Pages go to the network: the hub sets their security headers.
});

const world: SwWorld = {
  showNotification: (title, options) => sw.registration.showNotification(title, options),
  matchClients: () => sw.clients.matchAll({ type: "window", includeUncontrolled: true }),
  openWindow: url => sw.clients.openWindow(url),
  origin: sw.location.origin,
};

sw.addEventListener("push", event => {
  event.waitUntil(onPush(() => event.data?.json() as unknown, world));
});

sw.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(onNotificationClick(event.notification.data as unknown, world));
});
