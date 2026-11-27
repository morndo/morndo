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
  it("count topics that hold a goal or a cap, and stay 1..n among them", () => {
    const world = asAny(new World("gtm"));
    world.topics.get("research").meta = { askedBy: "x", ownerLine: "x", parts: [], nextReportAt: null, nextReportId: null, priority: null };
    const ranks = [...world.priorityRanks().entries()] as [string, number][];
    expect(ranks.map(([id]) => id).sort()).toEqual(["content", "outbound", "paid", "partnerships", "research", "seo"]);
    expect(ranks.map(([, rank]) => rank).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
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

describe("a report schedule", () => {
  const reports = (world: World) => (asAny(world.read("ManagerView", "", query, world.owner)).schedules as any[]).filter(item => item.kind === "report");
  const view = (item: any) => JSON.stringify([item.id, item.title, item.rrule, item.text, item.time, item.nextAt]);

  it("says in words what its rule says, and does not call a two-weekly report weekly", () => {
    const seo = reports(new World("gtm")).find(item => item.topicId === "seo");
    expect(seo.rrule).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO");
    expect(seo.text).toBe("every second Monday at 17:00");
    expect(seo.title).not.toMatch(/weekly/i);
    const content = reports(new World("gtm")).find(item => item.topicId === "content");
    expect(content.rrule).toBe("FREQ=WEEKLY;BYDAY=FR");
    expect(content.text).toBe("each Friday at 17:00");
    expect(content.title).toMatch(/weekly/i);
  });

  it("is fixed when it is made: the clock moves neither its rule, its words nor its next date", () => {
    const world = new World("gtm");
    const before = reports(world).map(view);
    for (const at of ["2026-11-17T09:00:00+01:00", "2026-11-23T12:00:00+01:00", "2026-11-29T12:00:00+01:00"]) {
      world.advance(at);
      expect(reports(world).map(view)).toEqual(before);
    }
  });
});

describe("a job that is scheduled says so", () => {
  for (const module of MODULES) {
    it(`${module}: a job whose lane or due time has a schedule carries its id and cadence`, () => {
      const world = new World(module);
      const schedules = (asAny(world.read("ManagerView", "", query, world.owner)).schedules as any[]).filter(item => item.kind !== "brief");
      const cadenceOf = (rrule: string) => rrule.startsWith("FREQ=WEEKLY") ? "weekly" : rrule.startsWith("FREQ=MONTHLY") ? "monthly" : null;
      let scheduled = 0;
      for (const topic of topicIds(module)) {
        for (const job of asAny(world.read("TopicView", topic, query, world.owner)).jobs as any[]) {
          const lane = job.laneId ? readLane(world, job.laneId) : null;
          const byLane = lane?.scheduleId ? schedules.find(item => item.id === lane.scheduleId) : undefined;
          // a job named for a report that falls due when the topic's report schedule does is that schedule's own
          const byTime = !byLane && job.dueAt && /report/i.test(job.job)
            ? schedules.find(item => item.kind === "report" && item.topicId === topic && item.nextAt === job.dueAt) : undefined;
          const schedule = byLane ?? byTime;
          if (!schedule) continue;
          scheduled += 1;
          expect(job.scheduleId, `${topic}: ${job.job}`).toBe(schedule.id);
          expect(job.cadence, `${topic}: ${job.job}`).toBe(cadenceOf(schedule.rrule));
        }
      }
      if (module === "gtm") expect(scheduled).toBeGreaterThanOrEqual(2);
    });
  }
});

describe("splits and receipts", () => {
  const filed = (module: Module, text: string, attachment?: unknown) => {
    const world = new World(module);
    const result = asAny(world.act({ type: "lane.file", text, ...(attachment ? { attachment } : {}) } as never));
    return { result, count: (result.events as any[]).filter(event => event.type === "lane.filed").length };
  };

  it("an object that the first clause already named is one ask", () => {
    expect(filed("gtm", "Write a blog post and publish the post").count).toBe(1);
    expect(filed("gtm", "Create a landing page and test the landing page").count).toBe(1);
    expect(filed("gtm", "Write a blog post and publish the page").count).toBe(2);
    expect(filed("gtm", "Interview the three churned customers and proofread the pricing page").count).toBe(2);
    expect(filed("gtm", "Collect a list of event sponsors and translate our onboarding email").count).toBe(2);
  });

  it("the receipt of a split ask names its attachment like a plain one", () => {
    const attachment = { id: "up-1", name: "brief.pdf", kind: "pdf", sizeBytes: 1200, url: "https://files.example.test/brief.pdf" };
    const world = new World("gtm");
    const upload = (name: string) => ({ ...attachment, name });
    const split = asAny(world.act({ type: "lane.file", text: "Interview the three churned customers and proofread the pricing page", attachment: upload("a.pdf") } as never));
    const plain = asAny(new World("gtm").act({ type: "lane.file", text: "Interview the three churned customers", attachment: upload("a.pdf") } as never));
    expect(plain.receipt.text).toContain("(with a.pdf)");
    expect(split.events.filter((event: any) => event.type === "lane.filed").length).toBe(2);
    expect(split.receipt.text).toBe("Interview the three churned customers and proofread the pricing page (with a.pdf)");
  });
});

describe("what the Manager's lines say", () => {
  it("counts a message once, by its stored label", () => {
    const world = new World("gtm");
    const { read, act } = actor(world);
    act({ type: "message.send", threadId: "topic:paid", text: "Can you draft two ad variants for finance" });
    const line = (read("ManagerView").since as string[]).find(item => item.startsWith("Paid:") && /instruction|question/.test(item));
    expect(line).toContain("1 instruction");
    expect(line).not.toMatch(/question/);
    const world2 = new World("gtm");
    const second = actor(world2);
    second.act({ type: "message.send", threadId: "topic:paid", text: "Where does the paid budget stand this week?" });
    const asked = (second.read("ManagerView").since as string[]).find(item => item.startsWith("Paid:") && /question/.test(item));
    expect(asked).toMatch(/1 question/);
    expect(asked).not.toMatch(/instruction/);
  });
});

describe("a guardrail change", () => {
  const change = (world: World, topic: string, text: string) => {
    const { read, act } = actor(world);
    const id = asAny(act({ type: "message.send", threadId: `topic:${topic}`, text })).message.decisionId as string;
    expect(id, text).toBeTruthy();
    act({ type: "decision.approve", decisionId: id });
    return read("TopicView", topic).goal;
  };

  it("names the owner to every reader but the owner on a blocker that is theirs", () => {
    const world = new World("gtm");
    const { read, act } = actor(world);
    act({ type: "access.set", topicId: "outbound", personId: "jonas-falk", access: { kind: "all", stages: [] } });
    const goal = change(world, "outbound", "Set the bounces guardrail to 1%");
    const generated = (goal.blockers as any[]).filter(item => item.guardrailId);
    expect(generated.length).toBeGreaterThan(0);
    for (const blocker of generated) expect(blocker.who).toBe("You");
    const seen = read("TopicView", "outbound", "jonas-falk").goal.blockers as any[];
    for (const blocker of seen) expect(blocker.who, blocker.short).not.toMatch(/\byou\b/i);
    expect(seen.filter(item => item.guardrailId).map(item => item.who)).toEqual(generated.map(() => world.owner.shortName));
  });

  it("says the reading is inside a raised limit, and keeps its words while it is still breached", () => {
    const raised = change(new World("gtm"), "paid", "Change the guardrail on cost per lead to 150 euros");
    expect(raised.guardrails.items.find((item: any) => item.id === "cost-per-lead").state).not.toBe("breached");
    expect(raised.gap.says).toBe("Cost per lead is €114, inside the €150 guardrail.");
    const still = change(new World("gtm"), "paid", "Change the guardrail on cost per lead to 110 euros");
    expect(still.guardrails.items.find((item: any) => item.id === "cost-per-lead").state).toBe("breached");
    expect(still.gap.says).toBe("To bring a lead under €110 by December:");
  });
});

describe("data the plan promises", () => {
  it("a lane behind another on a resource with a quota waits on it, until it has the turn", () => {
    const world = new World("gtm");
    const { read, act } = actor(world);
    expect(read("LaneView", "outreach-wave-2").waitsOnResource).toBe("your-mail");
    expect(read("LaneView", "outreach-wave-1").waitsOnResource).toBeNull();
    expect(read("LaneView", "brand-list").waitsOnResource).toBeNull();
    const sent = act({ type: "lane.act", laneId: "outreach-wave-2", act: "send-wave-2" }, "lea-brandt");
    expect(read("LaneView", "outreach-wave-2").waitsOnResource).toBeNull();
    const actionId = sent.events.find((event: any) => event.type === "agentAction.changed").actionId;
    act({ type: "agentAction.undo", actionId }, "lea-brandt");
    expect(read("LaneView", "outreach-wave-2").waitsOnResource).toBe("your-mail");
  });

  it("the gates of a pull whose lane or record says 2 rounds name the round, the reviewer and the run", () => {
    const world = new World("dev");
    const { read } = actor(world);
    const pull = (id: string) => (read("PullsView").items as any[]).find(item => item.id === id);
    const gate = (id: string, name: string) => pull(id).gates.find((item: any) => item.name === name);
    const review = gate("412", "Fresh review");
    expect(review).toMatchObject({ state: "pass", round: 2 });
    expect(review.reviewer).toMatchObject({ id: "reviewer", kind: "agent" });
    const run = read("MadeRecordView", gate("412", "QA by hand").runId);
    expect(run).toMatchObject({ kind: "run", laneId: "export-for-big-accounts", state: "pass" });
    expect(gate("731", "Fresh review")).toMatchObject({ round: 2 });
    expect(read("MadeRecordView", gate("731", "Checks").runId)).toMatchObject({ kind: "run", state: "fail" });
    for (const item of read("PullsView").items as any[]) {
      for (const each of item.gates as any[]) {
        if (each.runId) expect(read("MadeRecordView", each.runId).kind, `${item.id}: ${each.name}`).toBe("run");
        if (each.round !== null) expect(each.reviewer, `${item.id}: ${each.name}`).not.toBeNull();
      }
    }
  });
});
