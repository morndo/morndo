import { expect, it } from "vitest";
import { loadFixtures, type BriefView, type DecisionView, type LaneView, type SidebarView, type SkillsView, type ThreadView, type TopicView, type WorkspaceView } from "../src/index.ts";

const now = Date.parse("2026-11-16T08:45:00+01:00");

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
