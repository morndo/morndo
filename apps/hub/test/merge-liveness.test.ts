// Merge liveness (B11): the domain's livenessOf over the nodes' builds, with each ancestry answer cached per
// (merge, build) pair and filled out of band — `of` never runs git, a queue worker does, at most a few checks at once.
// A settled answer ("ancestor"/"not_ancestor") is kept for good; "unknown" is asked again on a backing-off schedule,
// because the operator may have updated the checkout the answer was read from. A spy for ancestry, a fake clock;
// synthetic commits.
import { describe, expect, it } from "vitest";
import { mergeLabel, type AncestryAnswer } from "@morndo/domain";
import { MergeLiveness } from "../src/application/merge-liveness.ts";

const SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
const BUILD1 = "1111111111111111111111111111111111111111";
const BUILD2 = "2222222222222222222222222222222222222222";
const BUILD3 = "3333333333333333333333333333333333333333";
const ON_ABC = "abc1234deadbeef0123456789abcdef012345678";
// One microtask turn: enough for the queue worker to start what it may after `of` queued it.
const tick = async (n = 1) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

describe("merge liveness (B11)", () => {
  it("of never runs git: a cold pair answers unknown and is checked once in the background", async () => {
    let asked = 0;
    const l = new MergeLiveness({
      builds: () => [{ node: "pc", commit: BUILD1 }],
      ancestry: () => { asked++; return Promise.resolve("ancestor"); },
      now: () => 1000,
    });
    expect(asked).toBe(0);                                             // nothing ran while nothing was asked
    expect(l.of(SHA)).toEqual({ live: false, blockers: [{ node: "pc", on: null }] });   // cold: unknown, at once
    expect(asked).toBe(0);                                             // `of` queued the check; it never runs git
    await l.settle();
    expect(asked).toBe(1);                                             // one check, in the background
    expect(l.of(SHA)).toEqual({ live: true });                          // and its answer is kept for good
    expect(l.of(SHA)).toEqual({ live: true });
    expect(asked).toBe(1);
  });

  it("a pair queued or running is not queued twice", async () => {
    const started: string[] = [];
    const release: ((a: AncestryAnswer) => void)[] = [];
    const l = new MergeLiveness({
      builds: () => [{ node: "pc", commit: BUILD1 }, { node: "srv01", commit: BUILD2 }],
      ancestry: (m, b) => new Promise<AncestryAnswer>(resolve => {
        started.push(`${m.slice(0, 7)}/${b.slice(0, 7)}`);
        release.push(resolve);                                         // the test decides when git answers
      }),
      now: () => 1000, parallel: 1,
    });
    l.of(SHA);
    l.of(SHA);                                                         // a second look while both pairs wait
    await tick();
    expect(started).toHaveLength(1);                                   // one check running, the other queued
    l.of(SHA);
    await tick();
    expect(started).toHaveLength(1);                                   // neither queued nor running twice
    release[0]?.("ancestor");
    await tick(2);
    expect(started).toHaveLength(2);                                   // the queued pair began once the first ended
    release[1]?.("not_ancestor");
    await l.settle();
    expect(started).toHaveLength(2);
    expect(l.of(SHA)).toEqual({ live: false, blockers: [{ node: "srv01", on: BUILD2 }] });
    l.of(SHA);
    await l.settle();
    expect(started).toHaveLength(2);                                   // both settled: never asked again
  });

  it("at most parallel checks run at once", async () => {
    let active = 0, maxActive = 0;
    const release: (() => void)[] = [];
    const l = new MergeLiveness({
      builds: () => [{ node: "pc", commit: BUILD1 }, { node: "srv01", commit: BUILD2 }, { node: "srv02", commit: BUILD3 }],
      ancestry: () => new Promise<AncestryAnswer>(resolve => {
        active++; maxActive = Math.max(maxActive, active);
        release.push(() => { active--; resolve("ancestor"); });
      }),
      now: () => 1000, parallel: 2,
    });
    l.of(SHA);
    expect(release).toHaveLength(0);                                   // nothing started synchronously
    await tick();
    expect(release).toHaveLength(2);                                   // two at once; the third waits
    release[0]?.();
    await tick(2);
    expect(release).toHaveLength(3);                                   // one finished, the third began
    for (const r of release.splice(0)) r();
    await l.settle();
    expect(maxActive).toBe(2);
  });

  it("unknown backs off 30 s, 60 s, ... up to the maximum and a final answer resets it", async () => {
    let t = 1000;
    let asked = 0;
    let answer: AncestryAnswer = "unknown";
    const l = new MergeLiveness({
      builds: () => [{ node: "pc", commit: BUILD1 }],
      ancestry: () => { asked++; return Promise.resolve(answer); },
      now: () => t,
    });
    const beat = async (advance: number) => { t += advance; l.of(SHA); await l.settle(); };
    await beat(0);
    expect(asked).toBe(1);
    await beat(29_999);
    expect(asked).toBe(1);                                             // inside the first backoff (30 s)
    await beat(1);
    expect(asked).toBe(2);
    await beat(59_999);
    expect(asked).toBe(2);                                             // the second waits twice as long
    await beat(1);
    expect(asked).toBe(3);
    await beat(120_000);
    expect(asked).toBe(4);
    await beat(240_000);
    expect(asked).toBe(5);
    await beat(480_000);
    expect(asked).toBe(6);
    await beat(600_000);                                               // 30 s * 2^5 would be 960 s: the cap holds
    expect(asked).toBe(7);
    await beat(600_000);
    expect(asked).toBe(8);                                             // the cap again, not a longer wait
    // A final answer ends the asking: the pair is settled for good, whatever the clock does. (The last unknown waits
    // the cap again first: 2 131 000 + 600 000.)
    answer = "ancestor";
    await beat(600_001);
    expect(asked).toBe(9);
    expect(l.of(SHA)).toEqual({ live: true });
    await beat(10 * 600_000);
    l.of(SHA);
    await l.settle();
    expect(asked).toBe(9);                                             // never asked again after a final answer
  });

  it("onChange fires once per drained queue when an answer changed", async () => {
    let t = 1000;
    let calls = 0;
    // pc's pair never settles; srv01's does on the first ask. Only a change of what `of` would answer is worth a call.
    const answers: Record<string, AncestryAnswer> = { [BUILD1]: "unknown", [BUILD2]: "ancestor" };
    const l = new MergeLiveness({
      builds: () => [{ node: "pc", commit: BUILD1 }, { node: "srv01", commit: BUILD2 }],
      ancestry: (_m, b) => Promise.resolve(answers[b] ?? "unknown"),
      now: () => t,
      onChange: () => calls++,
    });
    l.of(SHA);                                                         // two cold pairs; srv01's answer is about to change
    await l.settle();
    expect(calls).toBe(1);                                             // once for the whole batch
    l.of(SHA);
    await l.settle();
    expect(calls).toBe(1);                                             // nothing queued: nothing said
    // pc's unknown expired and stays unknown: what `of` would answer didn't change.
    t += 30_001;
    l.of(SHA);
    await l.settle();
    expect(calls).toBe(1);
    // Its next expiry turns final: that changes the answer.
    answers[BUILD1] = "not_ancestor";
    t += 60_001;
    l.of(SHA);
    await l.settle();
    expect(calls).toBe(2);
    expect(l.of(SHA)).toEqual({ live: false, blockers: [{ node: "pc", on: BUILD1 }] });
  });

  it("a rejecting ancestry is unknown", async () => {
    const l = new MergeLiveness({
      builds: () => [{ node: "pc", commit: BUILD1 }],
      ancestry: () => Promise.reject(new Error("git is gone")),
      now: () => 1000,
    });
    expect(l.of(SHA)).toEqual({ live: false, blockers: [{ node: "pc", on: null }] });
    await l.settle();                                                  // the rejection is caught, not thrown
    expect(l.of(SHA)).toEqual({ live: false, blockers: [{ node: "pc", on: null }] });
  });

  it("stop drops late results", async () => {
    const release: ((a: AncestryAnswer) => void)[] = [];
    let calls = 0;
    const l = new MergeLiveness({
      builds: () => [{ node: "pc", commit: BUILD1 }],
      ancestry: () => new Promise<AncestryAnswer>(resolve => { release.push(resolve); }),
      now: () => 1000,
      onChange: () => calls++,
    });
    l.of(SHA);
    await tick();
    expect(release).toHaveLength(1);                                   // the check is running
    l.stop();
    release[0]?.("ancestor");                                          // git answers after the stop
    await l.settle();
    expect(l.of(SHA)).toEqual({ live: false, blockers: [{ node: "pc", on: null }] });   // the late answer is dropped
    expect(calls).toBe(0);
    l.of(SHA);
    await l.settle();
    expect(l.of(SHA)).toEqual({ live: false, blockers: [{ node: "pc", on: null }] });   // and nothing runs again
    expect(release).toHaveLength(1);
  });

  it("the label names each blocker: a node behind, and a node unknown", async () => {
    let asked = 0;
    const l = new MergeLiveness({
      builds: () => [{ node: "pc", commit: ON_ABC }, { node: "srv01", commit: null }],
      ancestry: () => { asked++; return Promise.resolve("not_ancestor"); },
      now: () => 1000,
    });
    expect(mergeLabel([l.of(SHA)])).toBe("merged, not live: pc unknown, srv01 unknown");   // cold first
    await l.settle();
    expect(mergeLabel([l.of(SHA)])).toBe("merged, not live: pc on abc1234, srv01 unknown");
    expect(asked).toBe(1);                                             // srv01's null commit is never asked of git
  });
});
