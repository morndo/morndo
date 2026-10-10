// Validation of review finding #5 (range b9328b196..d90a1443e, PR #11): Away (phone/chat/away.svelte.ts) writes "last
// active here" only once a return is decided, and a return is decided only when the hub's presence word arrives. A
// whole visit without the hub (offline, the outbox still takes his messages) therefore records no activity, not even
// on hide, and the next return judges from the time before that visit: a "While you were away" digest for someone
// who used this device an hour ago. H4: a digest shows only if he was away from every device long enough.
// The real Away class with the page's edges faked (localStorage, document, the feed); $state is Svelte's rune, here a
// plain value. Synthetic data.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const H = 3_600_000, MIN = 60_000;
const T0 = Date.UTC(2026, 9, 5, 8);                    // his last activity on this device before the first visit
type Feed = { primed: boolean; presence: { elsewhere: number | null; n: number }; digest: null; asked: number[]; requestPresence(): void; requestDigest(since: number): void };
type AwayLike = { open: boolean; pending: { since: number; until: number } | null; start(): void; stop(): void; check(): void };

let now: number, kept: Map<string, string>, win: Map<string, () => void>, doc: Map<string, () => void>, visibility: "visible" | "hidden", feed: Feed;
const load = async (): Promise<AwayLike> => {
  const path = "../src/lib/phone/chat/away.svelte.ts";
  const m = await import(/* @vite-ignore */ path) as { Away: new (feed: Feed, now: () => number) => AwayLike };
  return new m.Away(feed, () => now);
};
const input = () => win.get("pointerdown")?.();
const hide = () => { visibility = "hidden"; doc.get("visibilitychange")?.(); };
const show = () => { visibility = "visible"; doc.get("visibilitychange")?.(); };
const hubAnswers = (a: AwayLike, elsewhere: number | null = null) => { feed.primed = true; feed.presence = { elsewhere, n: feed.presence.n + 1 }; a.check(); };

beforeEach(() => {
  now = T0; kept = new Map([["morndo.lastActive", String(T0)]]); win = new Map(); doc = new Map(); visibility = "visible";
  feed = { primed: false, presence: { elsewhere: null, n: 0 }, digest: null, asked: [], requestPresence() {}, requestDigest(since) { this.asked.push(since); } };
  vi.stubGlobal("$state", <T>(v: T) => v);
  vi.stubGlobal("localStorage", { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) });
  vi.stubGlobal("addEventListener", (t: string, fn: () => void) => void win.set(t, fn));
  vi.stubGlobal("removeEventListener", (t: string) => void win.delete(t));
  vi.stubGlobal("document", { get visibilityState() { return visibility; }, addEventListener: (t: string, fn: () => void) => void doc.set(t, fn), removeEventListener: (t: string) => void doc.delete(t) });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("finding #5: a visit the hub never answered (H4)", () => {
  it("control: away 5 hours, the hub answers: the digest shows, since his last activity", async () => {
    const a = await load();
    now = T0 + 5 * H; a.start(); hubAnswers(a);
    expect(a.open).toBe(true);
    expect(a.pending).toEqual({ since: T0, until: T0 + 5 * H });
  });
  it("control: he used the device 90 minutes ago in a visit the hub answered: no digest", async () => {
    const a = await load();
    now = T0 + 3 * H; a.start(); hubAnswers(a);
    now = T0 + 4 * H; input(); hide();
    now = T0 + 5.5 * H; show(); hubAnswers(a);
    expect(a.open).toBe(false);
  });
  it("control: a return after 9 hours that the hub never answered still gets its digest on the next visit", async () => {
    const a = await load();
    now = T0 + 9 * H; a.start();                         // offline: no presence word
    now = T0 + 9 * H + 10 * MIN; input(); hide();
    now = T0 + 9 * H + 15 * MIN; show(); hubAnswers(a);
    expect(a.open).toBe(true);
    expect(a.pending?.since).toBe(T0);
  });
  it("he used the device 90 minutes ago in a visit the hub never answered: no digest either", async () => {
    const a = await load();
    now = T0 + 3 * H; a.start();                         // 3 h after his last activity (not away), and the hub is unreachable
    expect(a.open).toBe(false);
    now = T0 + 3 * H + 5 * MIN; input();                 // he writes messages into the outbox for an hour
    now = T0 + 4 * H; input(); hide();                   // and locks the phone
    now = T0 + 5.5 * H; show(); hubAnswers(a);           // back 90 minutes later, the hub answers now
    expect(a.open).toBe(false);
    expect(a.pending).toBeNull();
    expect(feed.asked).toEqual([]);
  });
});
