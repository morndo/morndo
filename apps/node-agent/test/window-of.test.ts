// Which window a hook came from (fleet core §5.5; fleet clients spec §6): TMUX_PANE first, then the session registry,
// and only when neither finds one the body's own `window` (the owner's Stop script and `lanes notify` send it), a
// window name or nothing.
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@morndo/node-ops";
import { cachedFor, windowResolver } from "../src/relay/window-of.ts";

const resolve = windowResolver({ windowOfPane: p => (p === "%3" ? "api lane" : null), sessions: () => new Map<string, SessionInfo>() });

describe("the window of a hook", () => {
  it("takes the body's window when neither the pane nor the session finds one", () => {
    expect(resolve({ window: "web", text: "a note from outside a pane" })).toBe("web");            // negative control: null
    expect(resolve({ window: "fix: a/b ü.2", session_id: "not-in-the-registry" })).toBe("fix: a/b ü.2");
  });

  it("prefers the pane it finds over the body's window", () => {
    expect(resolve({ TMUX_PANE: "%3", window: "web" })).toBe("api lane");
  });

  it("takes no body window that isn't a window name, and none when there is none", () => {
    for (const window of ["", "a\tb", "x".repeat(201), 7, null]) expect(resolve({ window }), JSON.stringify(window)).toBeNull();
    expect(resolve({ text: "x" })).toBeNull();
    expect(resolve("plain words")).toBeNull();
  });
});

// An engine lane's hooks (/cc, /hook/stop) name the lane's session as its file does, `session_id = self.session or self.lane_id`:
// the lane's own id, then the engine's, and the lane's again after /clear. The inventory names the lane by its process.
describe("the window of an engine lane's hook", () => {
  const lane = (aliases: string[]): SessionInfo => ({ sessionId: "engine-4242-5500", name: "demo", pane: "%3", cwd: "/work/demo", version: null, pid: 4242, status: "idle", engine: "codex", aliases });
  it("finds the window by any id the lane's file has had", () => {
    const resolve = windowResolver({ windowOfPane: p => (p === "%3" ? "demo" : null), sessions: () => new Map([["%3", lane(["lane-uuid", "engine-session-1"])]]) });
    expect(resolve({ hook_event_name: "PreToolUse", session_id: "lane-uuid" })).toBe("demo");
    expect(resolve({ hook_event_name: "PreToolUse", session_id: "engine-session-1" })).toBe("demo");
    expect(resolve({ hook_event_name: "PreToolUse", session_id: "engine-4242-5500" })).toBe("demo");
    expect(resolve({ hook_event_name: "PreToolUse", session_id: "another-lane" })).toBeNull();           // negative control
  });
  it("reads the registry again once when the id is not in the cached read: the engine named its session a moment ago", () => {
    let aliases = ["lane-uuid"];
    let reads = 0;
    let clock = 0;
    const read = () => { reads++; return new Map([["%3", lane(aliases)]]); };
    const sessions = cachedFor(2000, read, () => clock);
    const resolve = windowResolver({ windowOfPane: () => "demo", sessions, refresh: sessions.fresh, now: () => clock });
    expect(resolve({ session_id: "lane-uuid" })).toBe("demo");
    aliases = ["lane-uuid", "engine-session-1"];
    clock = 500;                                                        // the cache is 500 ms old: not read again by itself
    expect(resolve({ session_id: "engine-session-1" })).toBe("demo");
    expect(reads).toBe(2);
    expect(resolve({ session_id: "nobody" })).toBeNull();               // an unknown id asks once, and not again for a while
    expect(resolve({ session_id: "nobody" })).toBeNull();
    expect(reads).toBe(2);                                              // (its ask found the read of a moment ago still fresh)
    clock = 900;
    expect(resolve({ session_id: "nobody" })).toBeNull();
    expect(reads).toBe(2);
    clock = 6000;
    expect(resolve({ session_id: "nobody" })).toBeNull();
    expect(reads).toBe(3);
  });
});

describe("how often a hook makes the registry be read", () => {
  const lane: SessionInfo = { sessionId: "engine-4242-5500", name: "demo", pane: "%3", cwd: "/work/demo", version: null, pid: 4242, status: "idle", engine: "codex", aliases: ["lane-uuid"] };
  function rig() {
    let clock = 0;
    let reads = 0;
    const sessions = cachedFor(2000, () => { reads++; return new Map([["%3", lane]]); }, () => clock);
    const resolve = windowResolver({ windowOfPane: () => "demo", sessions, refresh: sessions.fresh, now: () => clock });
    return { resolve, reads: () => reads, at: (ms: number) => { clock = ms; } };
  }
  it("a session with no pane that posts all the time makes one extra read, not one every 250 ms (negative control)", () => {
    const r = rig();
    for (let t = 0; t < 4000; t += 50) { r.at(t); expect(r.resolve({ session_id: "no-pane-session", window: "web" })).toBe("web"); }
    expect(r.reads()).toBeLessThanOrEqual(3);                            // the cache's own reads (every 2 s) and one refresh for the id
  });
  it("many different unknown ids in a burst make one extra read between them, and a known alias none", () => {
    const r = rig();
    expect(r.resolve({ session_id: "lane-uuid" })).toBe("demo");
    const before = r.reads();
    for (let i = 0; i < 100; i++) r.resolve({ session_id: `unknown-${i}`, window: "w" });
    expect(r.reads() - before).toBeLessThanOrEqual(1);
    r.resolve({ session_id: "lane-uuid" });
    expect(r.reads() - before).toBeLessThanOrEqual(1);
  });
  it("an id that was asked for is asked for again after a while: the engine may have named a session since", () => {
    const r = rig();
    r.resolve({ session_id: "later-named", window: "w" });
    const first = r.reads();
    r.at(10_000);
    r.resolve({ session_id: "later-named", window: "w" });
    expect(r.reads()).toBeGreaterThan(first);
  });
  it("the read for an unknown id is never staler than the plain cache is", () => {
    let clock = 0;
    let reads = 0;
    const c = cachedFor(100, () => ++reads, () => clock);
    c();
    clock = 150;
    expect(c.fresh()).toBe(2);                                           // the plain cache would have read again at 100 ms
    clock = 200;
    expect(c()).toBe(2);
  });
});

