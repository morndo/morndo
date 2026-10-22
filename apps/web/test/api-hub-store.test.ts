// The hub's store as the app keeps it (RL10, updates design §11.5): every hub answer names it in Morndo-Store; the app
// keeps the last one it saw — in memory and in localStorage, read back at load — so each Command can be stamped with the
// store its device saw before its first attempt, and a hub restored from another database answers uncertain instead of
// typing it twice.
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, seenHubStore } from "../src/lib/api.ts";

const STORE_A = "11111111-1111-4111-8111-111111111111";
const STORE_B = "22222222-2222-4222-8222-222222222222";
const answer = (store?: string) => new Response(JSON.stringify({}), {
  status: 200, headers: { "content-type": "application/json", ...(store ? { "morndo-store": store } : {}) },
});
const storage = (kept: Map<string, string>, broken = false) => ({
  getItem: (k: string) => { if (broken) throw new Error("blocked"); return kept.get(k) ?? null; },
  setItem: (k: string, v: string) => { if (broken) throw new Error("blocked"); kept.set(k, v); },
});

afterEach(() => vi.unstubAllGlobals());

describe("the last Morndo-Store the app saw", () => {
  it("an answer's header is kept and saved; a later answer's wins; one without the header keeps the last", async () => {
    const kept = new Map<string, string>();
    vi.stubGlobal("localStorage", storage(kept));
    vi.stubGlobal("fetch", async () => answer(STORE_A));
    await api.post("/api/anything");
    expect(seenHubStore()).toBe(STORE_A);
    expect(kept.get("morndo-hub-store")).toBe(STORE_A);
    vi.stubGlobal("fetch", async () => answer(STORE_B));
    await api.get("/api/anything");
    expect(seenHubStore()).toBe(STORE_B);
    vi.stubGlobal("fetch", async () => answer());             // an older hub, a proxy's page: no header
    await api.get("/api/anything");
    expect(seenHubStore()).toBe(STORE_B);
  });

  it("storage that throws changes nothing else: the store is kept for this page", async () => {
    vi.stubGlobal("localStorage", storage(new Map(), true));
    vi.stubGlobal("fetch", async () => answer(STORE_A));
    await expect(api.post("/api/anything")).resolves.toBeDefined();
    expect(seenHubStore()).toBe(STORE_A);
  });

  it("a load reads what was kept", async () => {
    vi.stubGlobal("localStorage", storage(new Map([["morndo-hub-store", STORE_B]])));
    vi.resetModules();
    const { seenHubStore: atLoad } = await import("../src/lib/api.ts");
    expect(atLoad()).toBe(STORE_B);
  });
});
