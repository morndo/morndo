// Drafts per conversation (ADR-0008 phase D): text and what the worker waited for when it was started (S6), on this
// device (localStorage "morndo.drafts"), saved 300 ms after the last keystroke, restored when the conversation opens,
// cleared on send. Keyed by the worker's pane and checked against its name, so a draft never shows in another worker's
// box (review H2: names aren't unique). A send counter keeps a save still pending at send time from bringing the sent
// text back (Signal-Desktop's composer does the same). Each save changes only its own entry (review L5: tabs).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAFT_DEBOUNCE_MS, Drafts } from "../src/lib/drafts.ts";

let backing: Map<string, string>;
const storage = () => ({ getItem: (k: string) => backing.get(k) ?? null, setItem: (k: string, v: string) => { backing.set(k, v); }, removeItem: (k: string) => { backing.delete(k); } });
beforeEach(() => { vi.useFakeTimers(); backing = new Map(); });
afterEach(() => vi.useRealTimers());

describe("drafts", () => {
  it("saves 300 ms after the last keystroke, and a new page restores it with what it was written against", () => {
    const d = new Drafts(storage());
    d.typed("%1", "alpha", "ship", "q:toolu_A");
    d.typed("%1", "alpha", "ship it", "q:toolu_A");
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS - 1);
    expect(new Drafts(storage()).get("%1", "alpha")).toBeNull();
    vi.advanceTimersByTime(1);
    expect(new Drafts(storage()).get("%1", "alpha")).toEqual({ text: "ship it", seen: "q:toolu_A" });
    expect(JSON.parse(backing.get("morndo.drafts") ?? "{}")).toEqual({ "%1": { name: "alpha", text: "ship it", seen: "q:toolu_A" } });
  });
  it("keeps each conversation's own draft", () => {
    const d = new Drafts(storage());
    d.typed("%1", "alpha", "a", "none"); d.typed("%2", "beta", "b", null);
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    expect([d.get("%1", "alpha")?.text, d.get("%2", "beta")?.text]).toEqual(["a", "b"]);
  });
  it("never shows in another worker's box: same name, other pane; same pane, other name (review H2)", () => {
    const d = new Drafts(storage());
    d.typed("%1", "claude", "for the first one", "none");
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    expect(d.get("%2", "claude")).toBeNull();
    expect(d.get("%1", "other")).toBeNull();
    expect(d.get("%1", "claude")?.text).toBe("for the first one");
  });
  it("sending clears it, and a save still pending at that moment can't bring it back", () => {
    const d = new Drafts(storage());
    d.typed("%1", "alpha", "ship it", "none");
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    d.typed("%1", "alpha", "ship it now", "none");                      // the last keystroke, then Enter at once
    d.sent("%1");
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS * 2);
    expect(new Drafts(storage()).get("%1", "alpha")).toBeNull();
  });
  it("an empty box removes the draft", () => {
    const d = new Drafts(storage());
    d.typed("%1", "alpha", "x", "none");
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    d.typed("%1", "alpha", "   ", null);
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    expect(JSON.parse(backing.get("morndo.drafts") ?? "{}")).toEqual({});
  });
  it("two tabs: each save changes only its own entry, so neither erases the other's draft (review L5)", () => {
    const one = new Drafts(storage()), two = new Drafts(storage());
    one.typed("%1", "alpha", "from tab one", "none");
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    two.typed("%2", "beta", "from tab two", "none");
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    two.sent("%3");
    expect(new Drafts(storage()).get("%1", "alpha")?.text).toBe("from tab one");
    expect(one.get("%2", "beta")?.text).toBe("from tab two");
  });
  it("works without storage (private mode): drafts last for the page", () => {
    const d = new Drafts(null);
    d.typed("%1", "alpha", "kept here", "none");
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    expect(d.get("%1", "alpha")?.text).toBe("kept here");
  });
  it("survives a corrupt stored value, and ignores entries of another shape", () => {
    backing.set("morndo.drafts", "{not json");
    expect(new Drafts(storage()).get("%1", "alpha")).toBeNull();
    backing.set("morndo.drafts", JSON.stringify({ alpha: "an old text-only draft", "%1": { name: "alpha", text: 5 } }));
    expect(new Drafts(storage()).get("%1", "alpha")).toBeNull();
  });
});
