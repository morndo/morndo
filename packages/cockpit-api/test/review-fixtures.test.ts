import { expect, it } from "vitest";
import { loadFixtures, type BriefView, type DecisionView, type LaneView, type ManagerView, type SidebarView, type SkillsView, type ThreadView, type TopicView, type WorkspaceView } from "../src/index.ts";

const now = Date.parse("2026-11-16T08:45:00+01:00");

it("keeps dates, quantities and currency in machine-readable fixture fields", () => {
  const files = loadFixtures("gtm");
  const paid = files.find(item => item.path === "topics/paid.json")?.value as TopicView;
  const manager = files.find(item => item.path === "manager.json")?.value as ManagerView;
  expect(paid.jobs[0]).toMatchObject({ dueAt: "2026-11-16T14:00:00+01:00", completedAt: null });
  expect(paid.jobs[0]).not.toHaveProperty("due");
  expect(paid.goal).toMatchObject({ updatedAt: "2026-11-16T07:05:00+01:00", unit: "Leads" });
  expect(paid.goal).not.toHaveProperty("asOf");
  expect(paid.facts[0]?.value).toEqual({
    kind: "money", money: { amountMinor: 364000, currency: "EUR" }, cap: { amountMinor: 400000, currency: "EUR" },
  });
  expect(paid.goal?.guardrails?.items[0]).toMatchObject({
    value: { kind: "money", money: { amountMinor: 11400, currency: "EUR" } },
    limit: { kind: "money", money: { amountMinor: 10000, currency: "EUR" } },
  });
  expect(paid.goal?.funnel?.steps[1]).toMatchObject({ count: 214, rate: { percent: 3.3, planPercent: 3 } });
  expect(paid.when).toEqual({ kind: "count", value: 7, of: 13, unit: "weeks" });
  expect(manager.lanes.find(lane => lane.id === "brand-list")?.nextAt).toBe("2026-11-16T18:00:00+01:00");
});

for (const module of ["gtm", "dev"] as const) {
  const files = loadFixtures(module);
  const read = <T>(path: string) => files.find(item => item.path === path)?.value as T;
  it(`${module} keeps fixture observations within the demo clock and declares lane and pin targets`, () => {
    const brief = read<BriefView>("brief.json");
    expect(brief.overnightSinceAt).toBe("2026-11-15T18:00:00+01:00");
    expect(brief.overnight.every(record => Date.parse(record.at) <= now)).toBe(true);
    expect(brief.cadence).not.toContain("13:00");
    expect(read<WorkspaceView>("workspace.json").workspace.theme.glass).toBeNull();
    expect(read<SidebarView>("sidebar.json").pinnable.every(pin => pin.target)).toBe(true);
    for (const { definition, value } of files) {
      if (definition === "ThreadView") {
        const thread = value as ThreadView;
        for (const [index, message] of thread.messages.entries()) {
          const at = Date.parse(message.at);
          const previous = thread.messages[index - 1];
          expect(at, thread.id).toBeLessThanOrEqual(now);
          if (previous) expect(at, thread.id).toBeGreaterThanOrEqual(Date.parse(previous.at));
          if (message.readBack) expect(Date.parse(message.readBack.at)).toBeGreaterThanOrEqual(at);
          for (const action of message.actions) {
            expect(read<LaneView>(`lanes/${action.laneId}.json`).acts.map(choice => choice.id)).toContain(action.id);
          }
        }
      }
    }
    const d1 = read<DecisionView>("decisions/d1.json");
    expect(d1.opportunity?.seriesLabel).toBe(module === "gtm" ? "With the shift" : "With the release");
    expect(d1.risk?.baselineLabel).toBe("No change");
    if (module === "dev") {
      expect(brief.overnight.find(record => record.at.includes("T23:12"))?.at).toBe("2026-11-15T23:12:00+01:00");
      expect(d1.nextSteps.find(step => step.who === "Writer, go-to-market")).toMatchObject({ moduleId: "gtm", target: { kind: "topic", id: "content" } });
      expect(brief.burns[0]?.blocks).toBe("Blocks the shipment filters");
      expect(brief.burnsSub).toBe("One thing an agent could not fix on its own");
      expect(read<TopicView>("topics/web.json").tasks.every(task => task.laneId && read<LaneView>(`lanes/${task.laneId}.json`))).toBe(true);
      const skills = read<SkillsView>("skills.json").skills;
      expect(skills.find(skill => skill.name === "/review")?.engine).toBe("Codex");
      expect(skills.find(skill => skill.name === "/qa-by-hand")?.engine).toBe("Cursor");
    } else {
      expect(d1.shortTitle).toBe("Move €1,200 a week to Google Search");
      expect(read<TopicView>("topics/outbound.json").crew.find(actor => actor.id === "jonas-falk")?.role).toBe("Sales");
    }
  });
}
