// Migration 20. 18 is manager_deliveries (fleet clients) and 19 is decision briefs; those lines merge first.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Transcription } from "@morndo/domain";
import { MIGRATIONS, migrate } from "../src/adapters/migrations.ts";
import { Store } from "../src/adapters/store.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("transcription store", () => {
  it("migration 20 adds transcriptions after 18 and 19, and a second run changes nothing", () => {
    expect(MIGRATIONS.map(m => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    expect(MIGRATIONS[19]?.version).toBe(20);
    expect(MIGRATIONS[17]?.name).toMatch(/manager_deliveries/);
    expect(MIGRATIONS[18]?.name).toMatch(/decision brief/i);
    expect(MIGRATIONS[19]?.name).toMatch(/transcription/);
    const dir = mkdtempSync(join(tmpdir(), "morndo-tx-"));
    dirs.push(dir);
    const db = new Database(join(dir, "morndo.db"));
    expect(migrate(db, MIGRATIONS.slice(0, 19))).toEqual({ from: 0, to: 19 });
    expect(migrate(db, MIGRATIONS.slice(0, 20))).toEqual({ from: 19, to: 20 });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(r => r.name);
    expect(tables).toContain("transcriptions");
    expect(tables).toContain("manager_deliveries");
    expect(tables).toContain("decision_briefs");
    expect(() => MIGRATIONS[19]?.up(db)).not.toThrow();
    const cols = db.prepare("SELECT name, pk, \"notnull\" AS nn FROM pragma_table_info('transcriptions')").all() as { name: string; pk: number; nn: number }[];
    const endpoint = cols.find(col => col.name === "endpoint_id");
    expect(endpoint).toMatchObject({ pk: expect.any(Number), nn: 1 });
    expect(endpoint && endpoint.pk).toBeGreaterThan(0);
    db.close();
  });

  it("keeps each endpoint's row when the id and the clip are the same", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-tx-own-"));
    dirs.push(dir);
    const row = (endpointId: string, sizeBytes: number): Transcription & { endpointId: string } => ({
      id: "t1", recording: { kind: "attachment", id: "clip" }, language: "en", sizeBytes,
      acceptedAt: 1, state: "queued", position: null, reason: null, outcome: null, problem: null,
      text: null, report: null, startedAt: null, endedAt: null, endpointId,
    });
    const first = new Store(dir);
    first.saveTranscription(row("ep-1", 100));
    first.saveTranscription(row("ep-2", 120));
    first.close();
    const again = new Store(dir);
    const saved = again.transcriptions() as (Transcription & { endpointId?: string })[];
    expect(saved.map(item => [item.endpointId, item.sizeBytes]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([["ep-1", 100], ["ep-2", 120]]);
    again.close();
  });
});
