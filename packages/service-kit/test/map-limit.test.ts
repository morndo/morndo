// mapLimit and allEnded: no work outlives the answer. A failure stops what hasn't started, asks what is running to stop,
// and is thrown once every piece has ended: the first failure in time, not the first in the list.
import { describe, expect, it } from "vitest";
import { allEnded, mapLimit } from "../src/index.ts";

const after = <T>(ms: number, fn: () => T) => new Promise<T>((resolve, reject) => { setTimeout(() => { try { resolve(fn()); } catch (e) { reject(e); } }, ms); });

describe("mapLimit", () => {
  it("results in input order, at most `limit` at once", async () => {
    let running = 0, most = 0;
    const out = await mapLimit([30, 10, 20, 5, 15], 2, async ms => {
      most = Math.max(most, ++running);
      await after(ms, () => undefined);
      running--;
      return ms * 2;
    });
    expect(out).toEqual([60, 20, 40, 10, 30]);
    expect(most).toBe(2);
  });

  it("after a failure starts nothing new, aborts the running ones and throws that failure once they have ended", async () => {
    const started: number[] = [];
    const ended: number[] = [];
    const run = mapLimit([0, 1, 2, 3, 4, 5], 3, (n, signal) => {
      started.push(n);
      if (n === 1) return after(10, () => { throw new Error("one failed"); });
      // The others run until they are told to stop, then take a moment to wind down.
      return new Promise<number>((_, reject) => {
        signal.addEventListener("abort", () => { setTimeout(() => { ended.push(n); reject(new Error(`stopped ${n}`)); }, 30); });
      });
    });
    await expect(run).rejects.toThrow("one failed");
    expect(started).toEqual([0, 1, 2]);
    expect(ended.sort((a, b) => a - b)).toEqual([0, 2]);
  });
});

describe("allEnded", () => {
  it("the values in order when every one succeeds", async () => {
    expect(await allEnded([after(20, () => "a"), Promise.resolve(2), after(5, () => null)])).toEqual(["a", 2, null]);
  });

  it("throws the first failure in time, once every one has ended, and calls abort once", async () => {
    const ended: string[] = [];
    let aborts = 0;
    const late = after(60, () => { ended.push("late"); throw new Error("late failed"); });
    const early = after(5, () => { ended.push("early"); throw new Error("early failed"); });
    const ok = after(30, () => { ended.push("ok"); return 1; });
    await expect(allEnded([late, early, ok], () => { aborts++; })).rejects.toThrow("early failed");
    expect(ended).toEqual(["early", "ok", "late"]);
    expect(aborts).toBe(1);
  });
});
