import { describe, expect, it } from "vitest";
import { World } from "../src/world.ts";

const query = new URLSearchParams();
const fresh = () => {
  const world = new World("gtm");
  const read = (definition: string, id = "", as?: string) => world.read(definition, id, query, as ? world.viewer(as) : world.owner) as any;
  const act = (command: Record<string, unknown>, as?: string) => world.act(command as never, as ? world.viewer(as) : world.owner) as any;
  const lanes = () => (read("ManagerView").lanes as unknown[]).length;
  return { world, read, act, lanes };
};

describe("an invitation that is revoked", () => {
  it("leaves nothing behind, can be sent again, and accepting names only its topic", () => {
    const { world, read, act } = fresh();
    const invitation = () => (read("MembersView").invitations as any[]).find(item => item.nameOrEmail === "mira@example.test" && item.acceptedAt === null);
    act({ type: "access.invite", topicId: "seo", nameOrEmail: "mira@example.test" });
    const first = invitation();
    const row = (id: string) => (read("MembersView").items as any[]).find(item => item.person.id === id);
    expect(row(first.personId)).toMatchObject({ invitedAt: first.invitedAt, joinedAt: null });
    const revoked = act({ type: "access.revoke", invitationId: first.id });
    expect(revoked.events).toContainEqual({ type: "members.changed", personId: first.personId });
    expect(() => world.viewer(first.personId)).toThrow();
    expect(JSON.stringify(read("MembersView"))).not.toContain(first.personId);
    act({ type: "access.invite", topicId: "seo", nameOrEmail: "mira@example.test" });
    const second = invitation();
    expect(second.id).not.toBe(first.id);
    const accepted = act({ type: "access.accept", invitationId: second.id }, second.personId);
    const topics = accepted.events.filter((event: any) => event.type === "access.changed").map((event: any) => event.topicId);
    expect([...new Set(topics)]).toEqual(["seo"]);
    const member = row(second.personId);
    expect(member.invitedAt).toBe(second.invitedAt);
    expect(member.joinedAt).toBe(read("MembersView").invitations.find((item: any) => item.id === second.id).acceptedAt);
    expect(member.joinedAt).not.toBeNull();
  });
});

describe("a goal change keeps to its own field", () => {
  it("keeps an approved target when a deadline and a unit are approved after it, and undoes one at a time", () => {
    const { read, act } = fresh();
    const propose = (text: string) => act({ type: "message.send", threadId: "topic:partnerships", text }).message.decisionId as string;
    const date = propose("Move the Partnerships deadline to 9 April");
    const target = propose("Set the Partnerships target to 17");
    const unit = propose("Change the Partnerships goal unit to agreements");
    for (const id of [target, date, unit]) act({ type: "decision.approve", decisionId: id });
    const goal = () => read("TopicView", "partnerships").goal;
    expect([goal().target, goal().deadlineAt.slice(0, 10), goal().unit]).toEqual([17, "2027-04-09", "agreements"]);
    act({ type: "decision.undo", decisionId: date });
    expect([goal().target, goal().unit, goal().deadlineAt.slice(0, 10)]).toEqual([17, "agreements", "2027-01-31"]);
    act({ type: "decision.undo", decisionId: target });
    expect([goal().target, goal().unit]).toEqual([3, "agreements"]);
  });
});

describe("a decision's acts and undos", () => {
  it("follows approve, undo, decline, undo, approve on the same decision", () => {
    const { read, act } = fresh();
    const seen: string[] = [];
    for (const type of ["decision.approve", "decision.undo", "decision.decline", "decision.undo", "decision.approve", "decision.undo", "decision.decline"]) {
      act({ type, decisionId: "d4" });
      seen.push(read("DecisionView", "d4").state);
    }
    expect(seen).toEqual(["approved", "open", "declined", "open", "approved", "open", "declined"]);
  });

  it("credits a delegate's approval to them, with the time it happened, and shows no other step as done", () => {
    const { read, act } = fresh();
    act({ type: "access.set", topicId: "partnerships", personId: "jonas-falk", access: { kind: "all", stages: [] } });
    act({ type: "decisionRight.set", rule: read("DecisionView", "d4").rule, who: "agent", personId: "jonas-falk", dailyLimit: 3 });
    const before = read("DecisionView", "d1").nextSteps;
    expect(act({ type: "decision.approve", decisionId: "d4" }, "jonas-falk").status ?? 200).toBe(200);
    const history = read("HistoryPage", "partnerships") as any;
    const row = history.days.flatMap((day: any) => day.entries).find((entry: any) => entry.decisionId === "d4");
    expect(row.actor.id).toBe("jonas-falk");
    expect(Date.parse(row.at)).toBeGreaterThanOrEqual(Date.parse("2026-11-16T08:45:00+01:00"));
    expect(read("LaneView", read("DecisionView", "d4").laneId).standing.headline).toMatch(/^Jonas/);
    act({ type: "decision.approve", decisionId: "d1" });
    const after = read("DecisionView", "d1").nextSteps;
    expect(after.map((step: any) => step.state)).toEqual(before.map((step: any) => step.state));
  });

  it("keeps the time of an approval's own OK, however often the lane is read", async () => {
    const world = new World("dev");
    const read = (id: string) => world.read("LaneView", id, query, world.owner) as any;
    world.act({ type: "decision.approve", decisionId: "d2" } as never);
    const steps = () => read("tax-rates").steps.map((step: any) => step.doneAt);
    const first = steps();
    world.advance("2026-11-16T12:00:00+01:00");
    expect(steps()).toEqual(first);
  });
});

describe("a split ask is one act", () => {
  it("files every part or none, undoes every part with one action, and splits the same in a chat", () => {
    const { act, lanes, read } = fresh();
    act({ type: "access.set", topicId: "partnerships", personId: "jonas-falk", access: { kind: "all", stages: [] } });
    const before = lanes();
    expect(() => act({ type: "lane.file", text: "Draft a partner offer and translate the pricing page" }, "jonas-falk")).toThrow();
    expect(lanes()).toBe(before);
    const askText = "Photograph the new stand and rank the booth ideas";
    const filed = act({ type: "lane.file", text: askText });
    expect(filed.receipt.groupLaneIds).toHaveLength(2);
    expect(lanes()).toBe(before + 2);
    act({ type: "agentAction.undo", actionId: filed.receipt.actionId });
    expect(lanes()).toBe(before);
    const chat = act({ type: "message.send", threadId: "topic:content", text: askText });
    expect(chat.receipt.groupLaneIds).toHaveLength(2);
    expect(read("ManagerView").asks.length).toBeGreaterThan(0);
    for (const text of ["Review the pricing tables and test results", "Draft the price list and order form", "Check the new ads and report pages"]) {
      expect(act({ type: "lane.file", text }).receipt.groupLaneIds).toEqual([]);
    }
  });
});

describe("a command that throws leaves nothing half applied", () => {
  it("leaves no lane, no ask and no history row behind a refused split", () => {
    const { act, read, lanes } = fresh();
    act({ type: "access.set", topicId: "partnerships", personId: "jonas-falk", access: { kind: "all", stages: [] } });
    const snapshot = () => JSON.stringify([lanes(), read("ManagerView").asks, read("HistoryPage", "partnerships")]);
    const before = snapshot();
    expect(() => act({ type: "lane.file", text: "Draft a partner offer and translate the pricing page" }, "jonas-falk")).toThrow();
    expect(snapshot()).toBe(before);
    expect(() => act({ type: "decision.approve", decisionId: "d4" }, "jonas-falk")).toThrow();
    expect(snapshot()).toBe(before);
  });
});

describe("what a record says matches what it does", () => {
  it("serves a history row as undoable only while its overnight action can be undone", () => {
    const { read, act } = fresh();
    const rows = (read("HistoryPage", "research").days as any[]).flatMap(day => day.entries);
    expect(rows.find(row => row.id === "research-history-1")).toMatchObject({ undoable: false });
    expect(() => act({ type: "agentAction.undo", actionId: "research-history-1" })).toThrow();
  });

  it("gives a run that passed a finish after its start", () => {
    const world = new World("dev");
    const run = world.read("MadeRecordView", "export-staging", query, world.owner) as any;
    expect(run.state).toBe("pass");
    expect(Date.parse(run.finishedAt)).toBeGreaterThan(Date.parse(run.startedAt));
  });

  it("gives each report schedule the weekly rule that leads to its next date", () => {
    const { read } = fresh();
    const days = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    const reports = (read("ManagerView").schedules as any[]).filter(item => item.kind === "report");
    expect(reports.length).toBeGreaterThan(1);
    for (const item of reports) {
      const at = new Date(item.nextAt);
      expect(item.rrule).toContain(`BYDAY=${days[at.getUTCDay()]}`);
    }
    expect(reports.find(item => item.topicId === "seo").rrule).toContain("INTERVAL=2");
  });

  it("counts what a delegated person decides today, and takes it back on undo", () => {
    const { read, act } = fresh();
    const rule = read("DecisionView", "d4").rule;
    act({ type: "access.set", topicId: "partnerships", personId: "lea-brandt", access: { kind: "all", stages: [] } });
    act({ type: "decisionRight.set", rule, who: "agent", personId: "lea-brandt", dailyLimit: 5 });
    const used = () => (read("SettingsView").decisionRights as any[]).find(item => item.rule === rule).usedToday;
    const before = used();
    const approved = act({ type: "decision.approve", decisionId: "d4" }, "lea-brandt");
    expect(used()).toBe(before + 1);
    expect(approved.events).toContainEqual({ type: "decisionRight.changed" });
    act({ type: "decision.undo", decisionId: "d4" }, "lea-brandt");
    expect(used()).toBe(before);
  });
});
