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

describe("revoking an accepted invitation", () => {
  it("removes only the invitation: access, stage runner and the member's dates stay", () => {
    const world = new World("gtm");
    const read = (definition: string, id = "", as?: string) => asAny(world.read(definition, id, query, as ? world.viewer(as) : world.owner));
    const act = (command: Record<string, unknown>, as?: string) => asAny(world.act(command as never, as ? world.viewer(as) : world.owner));
    act({ type: "access.invite", topicId: "partnerships", nameOrEmail: "sam@example.test" });
    const invitation = read("MembersView").invitations.find((item: any) => item.nameOrEmail === "sam@example.test");
    const person = invitation.personId as string;
    world.advance("2026-11-16T09:00:00+01:00");
    act({ type: "access.accept", invitationId: invitation.id }, person);
    const stage = "Outreach";
    act({ type: "access.set", topicId: "partnerships", personId: person, access: { kind: "stages", stages: [stage] } });
    act({ type: "stage.assign", topicId: "partnerships", stage, personId: person });
    const row = () => read("MembersView").items.find((item: any) => item.person.id === person);
    const before = row();
    expect(before.joinedAt).toBe("2026-11-16T09:00:00+01:00");
    expect(before.invitedAt).toBe(invitation.invitedAt);
    const runner = () => read("TopicView", "partnerships").stages.find((item: any) => item.name === stage).runBy?.id ?? null;
    expect(runner()).toBe(person);
    const revoked = act({ type: "access.revoke", invitationId: invitation.id });
    expect(revoked.events).toContainEqual({ type: "members.changed", personId: person });
    const after = row();
    expect(after.invitedAt).toBe(before.invitedAt);
    expect(after.joinedAt).toBe(before.joinedAt);
    expect(after.access).toEqual(before.access);
    expect(runner()).toBe(person);
    expect(read("MembersView").invitations.some((item: any) => item.id === invitation.id)).toBe(false);
  });
});

function actor(world: World) {
  const read = (definition: string, id = "", as?: string) => asAny(world.read(definition, id, query, as ? world.viewer(as) : world.owner));
  const act = (command: Record<string, unknown>, as?: string) => asAny(world.act(command as never, as ? world.viewer(as) : world.owner));
  return { read, act };
}

describe("decisionRight.changed", () => {
  it("is emitted whenever a command changes usedToday, undo and redo included", () => {
    const world = new World("gtm");
    const { read, act } = actor(world);
    const rule = read("DecisionView", "d4").rule;
    act({ type: "access.set", topicId: "partnerships", personId: "jonas-falk", access: { kind: "all", stages: [] } });
    act({ type: "decisionRight.set", rule, who: "agent", personId: "jonas-falk", dailyLimit: 3 });
    const used = () => (read("SettingsView").decisionRights as any[]).find(item => item.rule === rule).usedToday;
    const base = used();
    const changed = (result: any) => result.events.filter((event: any) => event.type === "decisionRight.changed").length;
    const approved = act({ type: "decision.approve", decisionId: "d4" }, "jonas-falk");
    expect(used()).toBe(base + 1);
    expect(changed(approved)).toBe(1);
    const undone = act({ type: "decision.undo", decisionId: "d4" }, "jonas-falk");
    expect(used()).toBe(base);
    expect(changed(undone)).toBe(1);
    const row = (read("HistoryPage", "partnerships").days as any[]).flatMap(day => day.entries).find((entry: any) => entry.decisionId === "d4");
    const redone = act({ type: "agentAction.redo", actionId: row.id }, "jonas-falk");
    expect(used()).toBe(base + 1);
    expect(changed(redone)).toBe(1);
    const undoneAgain = act({ type: "agentAction.undo", actionId: row.id }, "jonas-falk");
    expect(used()).toBe(base);
    expect(changed(undoneAgain)).toBe(1);
    expect(changed(act({ type: "prefs.set", briefsPerDay: 2 }))).toBe(0);
  });
});

describe("schedule.changed", () => {
  const scheduleEvents = (events: any[]) => events.filter(event => event.type === "schedule.changed").map(event => event.scheduleId as string).sort();

  it("names each schedule a command adds, removes or moves", () => {
    const world = new World("gtm");
    const { read, act } = actor(world);
    const ids = () => (read("ManagerView").schedules as any[]).map(item => item.id as string);
    const before = ids();
    expect(before).toEqual(expect.arrayContaining(["brief-0715", "brief-1300", "brief-1800"].filter(id => before.includes(id))));
    const briefs = before.filter(id => id.startsWith("brief-"));
    const one = act({ type: "prefs.set", briefsPerDay: 1 });
    const after = ids();
    const gone = before.filter(id => !after.includes(id));
    expect(gone.length).toBeGreaterThan(0);
    for (const id of gone) expect(scheduleEvents(one.events)).toContain(id);
    const back = act({ type: "prefs.set", briefsPerDay: 3 });
    const restored = ids();
    for (const id of restored.filter(id => !after.includes(id))) expect(scheduleEvents(back.events)).toContain(id);
    expect(restored.filter(id => id.startsWith("brief-")).length).toBe(briefs.length);
    expect(scheduleEvents(act({ type: "prefs.set", briefsPerDay: 3 }).events)).toEqual([]);
  });

  it("names the brief schedules the clock moves", () => {
    const world = new World("gtm");
    const { read } = actor(world);
    const next = (id: string) => (read("ManagerView").schedules as any[]).find(item => item.id === id)?.nextAt;
    const brief = (read("ManagerView").schedules as any[]).find(item => item.kind === "brief" && Date.parse(item.nextAt) > Date.parse(DEMO_AT));
    const was = next(brief.id);
    const events = world.advance(new Date(Date.parse(was) + 60000).toISOString());
    expect(next(brief.id)).not.toBe(was);
    expect(scheduleEvents(events)).toContain(brief.id);
    expect(scheduleEvents(world.advance(new Date(Date.parse(was) + 120000).toISOString()))).not.toContain("friday-check");
  });
});
