import { describe, expect, it } from "vitest";
import { DEMO_AT, World, type Module } from "../src/world.ts";

const query = new URLSearchParams();
const MODULES: Module[] = ["gtm", "dev"];
const asAny = (value: unknown) => value as any;

function topicIds(module: Module): string[] {
  const world = new World(module);
  return (asAny(world.read("SidebarView", "", query, world.owner)).groups as any[]).map(group => group.id as string)
    .filter(id => world.get(`/topics/${id}`, query).status === 200);
}

function historyRows(world: World, topicId: string): any[] {
  const out = world.get(`/topics/${topicId}/history`, query);
  if (out.status !== 200) return [];
  return (out.body as any).days.flatMap((day: any) => day.entries).filter((entry: any) => entry.kind === "event");
}

describe("history rows and undo agree", () => {
  for (const module of MODULES) {
    for (const clock of [DEMO_AT, "2026-11-16T23:45:00+01:00"]) {
      it(`${module} at ${clock}: undoable true answers 200, a 409 reads false`, () => {
        const reference = new World(module);
        if (clock !== DEMO_AT) reference.advance(clock);
        const probes: { topic: string; id: string; undoable: boolean; undone: boolean }[] = [];
        for (const topic of topicIds(module)) {
          for (const row of historyRows(reference, topic)) probes.push({ topic, id: row.id, undoable: row.undoable, undone: row.undone });
        }
        expect(probes.length).toBeGreaterThan(module === "gtm" ? 5 : 0);
        const wrong: string[] = [];
        for (const probe of probes) {
          if (probe.undone) continue;
          const world = new World(module);
          if (clock !== DEMO_AT) world.advance(clock);
          let status = 200;
          try { world.act({ type: "agentAction.undo", actionId: probe.id }); } catch (error) { status = (error as any).body?.status ?? 0; }
                    if (probe.undoable && status !== 200) wrong.push(`${probe.topic}/${probe.id}: reads undoable, answers ${String(status)}`);
        }
        expect(wrong).toEqual([]);
      });
    }
  }
});

const laneIds = (world: World): string[] => (asAny(world.read("SidebarView", "", query, world.owner)).groups as any[])
  .flatMap(group => group.lanes.map((lane: any) => lane.id as string));
const readLane = (world: World, id: string) => asAny(world.read("LaneView", id, query, world.owner));

describe("every done step has a time", () => {
  for (const module of MODULES) {
    it(`${module}: ok steps are timed, in order, inside the lane and before the clock`, () => {
      const world = new World(module);
      const clock = Date.parse(DEMO_AT);
      const lanes = laneIds(world);
      expect(lanes.length).toBeGreaterThan(5);
      for (const id of lanes) {
        const lane = readLane(world, id);
        const opened = Date.parse(lane.openedAt);
        const end = Math.min(clock, lane.closedAt ? Date.parse(lane.closedAt) : clock);
        let last = -Infinity;
        for (const step of lane.steps.filter((item: any) => item.kind === "ok")) {
          expect(step.doneAt, `${id}: ${step.text}`).not.toBeNull();
          const at = Date.parse(step.doneAt);
          expect(at, `${id}: ${step.text}`).toBeGreaterThanOrEqual(opened);
          expect(at, `${id}: ${step.text}`).toBeLessThanOrEqual(end);
          expect(at, `${id}: ${step.text} is after the one before`).toBeGreaterThan(last);
          last = at;
        }
        for (const step of lane.steps.filter((item: any) => item.kind !== "ok")) expect(step.doneAt, `${id}: ${step.text}`).toBeNull();
      }
    });
  }

  it("an approved Your OK step carries the time of the approval, in every lane that has one", () => {
    for (const [module, ids] of [["gtm", ["d1", "d2", "d3", "d4"]], ["dev", ["d1", "d2", "d3"]]] as const) {
      for (const id of ids) {
        const world = new World(module);
        const decision = asAny(world.read("DecisionView", id, query, world.owner));
        world.advance("2026-11-16T09:10:00+01:00");
        world.act({ type: "decision.approve", decisionId: id } as never);
        const approved = asAny(world.read("DecisionView", id, query, world.owner));
        for (const step of approved.nextSteps.filter((item: any) => /your ok|you approve/i.test(item.step))) {
          expect(step.doneAt, `${module} ${id}`).toBe("2026-11-16T09:10:00+01:00");
        }
        const lane = decision.laneId && readLane(world, decision.laneId);
        if (!lane) continue;
        for (const step of lane.steps.filter((item: any) => item.kind === "ok")) expect(step.doneAt, `${module} ${id}: ${step.text}`).not.toBeNull();
        for (const step of lane.steps.filter((item: any) => /your ok/i.test(item.text) && item.kind === "ok")) {
          expect(step.doneAt, `${module} ${id}: ${step.text}`).toBe("2026-11-16T09:10:00+01:00");
        }
      }
    }
  });

  it("a settled webinar step has the time of the act", () => {
    const world = new World("gtm");
    world.advance("2026-11-16T09:20:00+01:00");
    world.act({ type: "lane.act", laneId: "webinar", act: "post-passing" } as never);
    const step = readLane(world, "webinar").steps.find((item: any) => item.who === "You · now");
    expect(step).toMatchObject({ kind: "ok", doneAt: "2026-11-16T09:20:00+01:00" });
  });
});

describe("a goal word in a module without goals", () => {
  const send = (world: World, threadId: string, text: string) => asAny(world.act({ type: "message.send", threadId, text } as never));

  it("dev: it is an ordinary request and files a lane", () => {
    for (const text of ["Add a deadline field to the shipment form", "Make the tax rates fix the top priority", "Raise the budget for the build cache", "Add a guardrail for the retry loop"]) {
      const world = new World("dev");
      const result = send(world, "topic:web", text);
      expect(result.message.label?.kind, text).toBe("request");
      expect(result.laneId, text).toBeTruthy();
    }
  });

  it("gtm: the rule stays and a goal sentence is a goal change", () => {
    const world = new World("gtm");
    const result = send(world, "topic:seo", "Change the SEO deadline to 31 January");
    expect(result.message.label?.kind).toBe("goalChange");
    expect(result.laneId).toBeNull();
  });
});

describe("priority ranks", () => {
  it("count only topics that hold a goal, and stay 1..n among them", () => {
    const world = asAny(new World("gtm"));
    world.topics.get("research").meta = { askedBy: "x", ownerLine: "x", parts: [], nextReportAt: null, nextReportId: null, priority: null };
    const ranks = [...world.priorityRanks().entries()] as [string, number][];
    expect(ranks.map(([id]) => id).sort()).toEqual(["content", "outbound", "paid", "partnerships", "seo"]);
    expect(ranks.map(([, rank]) => rank).sort()).toEqual([1, 2, 3, 4, 5]);
    const dev = asAny(new World("dev"));
    for (const topic of dev.topics.values()) topic.meta = { askedBy: "x", ownerLine: "x", parts: [], nextReportAt: null, nextReportId: null, priority: null };
    expect(dev.priorityRanks().size).toBe(0);
  });
});
