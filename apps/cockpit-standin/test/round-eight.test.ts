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
