// The hub's shutdown stack (src/adapters/shutdown.ts): the order, the late close, the parked step.
import { describe, expect, it } from "vitest";
import { shutdownStack } from "../src/adapters/shutdown.ts";

const quiet = { error: () => {} };

describe("shutdownStack", () => {
  it("closes last made, first closed, each one waited for", async () => {
    const seen: string[] = [];
    const s = shutdownStack(quiet);
    s.onStop(() => { seen.push("store"); });
    s.onStop(async () => { await new Promise(r => setTimeout(r, 5)); seen.push("http"); });
    s.onStop(() => { seen.push("timer"); });
    await s.stop();
    expect(seen).toEqual(["timer", "http", "store"]);
  });

  it("is one stop however often it is asked for", async () => {
    let n = 0;
    const s = shutdownStack(quiet);
    s.onStop(() => { n++; });
    await Promise.all([s.stop(), s.stop()]);
    await s.stop();
    expect(n).toBe(1);
    expect(s.stopping).toBe(true);
  });

  it("a close that throws is logged and the rest still run", async () => {
    const logged: string[] = [];
    const seen: string[] = [];
    const s = shutdownStack({ error: m => logged.push(m) });
    s.onStop(() => { seen.push("first made"); });
    s.onStop(() => { throw new Error("busy"); });
    await s.stop();
    expect(seen).toEqual(["first made"]);
    expect(logged).toHaveLength(1);
  });

  it("a close registered after the stop began runs at once", async () => {
    const s = shutdownStack(quiet);
    await s.stop();
    let ran = false;
    s.onStop(() => { ran = true; });
    await Promise.resolve();
    expect(ran).toBe(true);
  });

  it("a step answers as it does while running, and is parked for good once the stop began", async () => {
    const s = shutdownStack(quiet);
    await expect(s.whileRunning(Promise.resolve(7))).resolves.toBe(7);
    await expect(s.whileRunning(Promise.reject(new Error("no")))).rejects.toThrow("no");
    let finish!: () => void;
    let fail!: () => void;
    const slow = s.whileRunning(new Promise<number>(r => { finish = () => r(1); }));
    const failing = s.whileRunning(new Promise<number>((_, reject) => { fail = () => reject(new Error("late")); }));
    let settled = false;
    void slow.then(() => { settled = true; }, () => { settled = true; });
    void failing.catch(() => { settled = true; });
    await s.stop();
    finish();
    fail();
    await new Promise(r => setTimeout(r, 20));
    expect(settled).toBe(false);
  });
});
