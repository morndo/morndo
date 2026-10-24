// The service worker's push handlers (ADR-0008 phase F; N1, N3): every push shows a notification, even an unreadable
// one; the words come from the numbers only; one tag per kind; a click focuses an open window of the app and takes it
// there, or opens one, and never follows an address outside the app. Fakes for the service worker's world.
import { describe, expect, it } from "vitest";
import { notificationFor, onNotificationClick, onPush, type SwWorld } from "../src/lib/sw-push.ts";

function fakeWorld(open: { url: string }[] = []) {
  const shown: { title: string; options: unknown }[] = [];
  const done: string[] = [];
  const world: SwWorld = {
    showNotification: async (title, options) => { shown.push({ title, options }); },
    matchClients: async () => open.map(c => ({ url: c.url, focus: async () => done.push(`focus ${c.url}`), navigate: async (u: string) => done.push(`navigate ${u}`) })),
    openWindow: async u => done.push(`open ${u}`),
    origin: "https://hub.example.test",
  };
  return { world, shown, done };
}

describe("what a notification says (N1)", () => {
  it("decisions, workers, devices: the words from the numbers, a tag per kind, where a click goes", () => {
    expect(notificationFor({ kind: 0, decisions: 2, workers: 1, linked: 0 })).toEqual({
      title: "2 decisions wait for you", body: "Open Morndo to decide. 1 worker needs you too.", tag: "morndo-decision", url: "/?view=decisions",
    });
    expect(notificationFor({ kind: 0, decisions: 1, workers: 0, linked: 0 }).title).toBe("A decision waits for you");
    expect(notificationFor({ kind: 1, decisions: 1, workers: 3, linked: 0 })).toEqual({
      title: "3 workers need you", body: "Open Morndo to see what it asks. 1 decision waits too.", tag: "morndo-worker", url: "/?view=activity",
    });
    expect(notificationFor({ kind: 2, decisions: 0, workers: 0, linked: 1 })).toEqual({
      title: "A device was added", body: "Not you? Review your devices.", tag: "morndo-linked", url: "/devices",
    });
  });
  it("fleet alerts: the urgent ones he hasn't seen, counted; a hub from before sends no count (none)", () => {
    expect(notificationFor({ kind: 3, decisions: 0, workers: 0, linked: 0, alerts: 2 })).toEqual({
      title: "Your fleet has 2 alerts", body: "Open Morndo to see what happened.", tag: "morndo-alert", url: "/?view=alerts",
    });
    expect(notificationFor({ kind: 3, decisions: 0, workers: 0, linked: 0, alerts: 1 }).title).toBe("Your fleet has an alert");
    expect(notificationFor({ kind: 2, decisions: 0, workers: 0, linked: 1 }).tag).toBe("morndo-linked");
  });
  it("anything it can't read still shows one, saying only that something needs him", () => {
    for (const junk of [null, "text", { kind: 9, decisions: 1, workers: 0, linked: 0 }, { kind: 0, decisions: "2", workers: 0, linked: 0 }, { kind: 0 }]) {
      expect(notificationFor(junk)).toEqual({ title: "Morndo", body: "Something needs you.", tag: "morndo", url: "/" });
    }
  });
  it("usage notices (S4, plan 4.4): counted, a tag of its own, Home; a hub from before sends no count (one)", () => {
    expect(notificationFor({ kind: 4, decisions: 0, workers: 0, linked: 0, alerts: 0, usage: 2 })).toEqual({
      title: "2 usage changes need a look", body: "Open Morndo to see what changed.", tag: "morndo-usage", url: "/?view=dashboard",
    });
    expect(notificationFor({ kind: 4, decisions: 0, workers: 0, linked: 0, alerts: 0, usage: 1 }).title).toBe("Usage needs a look");
    expect(notificationFor({ kind: 4, decisions: 0, workers: 0, linked: 0, alerts: 0 }).title).toBe("Usage needs a look");
  });
  it("a kind this code doesn't know still shows a notification (the round before, kind 4 read that way)", () => {
    expect(notificationFor({ kind: 5, decisions: 1, workers: 0, linked: 0, alerts: 0, usage: 0 })).toEqual({ title: "Morndo", body: "Something needs you.", tag: "morndo", url: "/" });
  });
});

describe("the push handler", () => {
  it("always shows a notification, with its tag so a newer one replaces it", async () => {
    const { world, shown } = fakeWorld();
    await onPush(() => ({ kind: 1, decisions: 0, workers: 1, linked: 0 }), world);
    await onPush(() => { throw new SyntaxError("not JSON"); }, world);
    expect(shown.map(s => s.title)).toEqual(["A worker needs you", "Morndo"]);
    expect(shown[0]?.options).toMatchObject({ tag: "morndo-worker", data: { url: "/?view=activity" }, renotify: true });
  });
});

describe("a click on a notification", () => {
  it("focuses an open window of the app and takes it there", async () => {
    const { world, done } = fakeWorld([{ url: "https://elsewhere.example/" }, { url: "https://hub.example.test/" }]);
    await onNotificationClick({ url: "/?view=decisions" }, world);
    expect(done).toEqual(["focus https://hub.example.test/", "navigate /?view=decisions"]);
  });
  it("opens the app when no window of it is open", async () => {
    const { world, done } = fakeWorld();
    await onNotificationClick({ url: "/devices" }, world);
    expect(done).toEqual(["open /devices"]);
  });
  it("never follows an address outside the app", async () => {
    const { world, done } = fakeWorld();
    await onNotificationClick({ url: "https://evil.example/phish" }, world);
    await onNotificationClick(null, world);
    expect(done).toEqual(["open /", "open /"]);
  });
});
