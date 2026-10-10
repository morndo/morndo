// What the hub would show for each live engine-lane file. Run before a deploy:
//   node scripts/qa-engine-registry.ts [registry-dir]
// The default directory is ~/.local/share/engines/sessions.
// A file governs only when its pid is alive and both pidStartTicks (field 22) and bootId match exactly.
// A file missing either field is an old writer: match is "no fields" and the screen decides.
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { processAlive, processIdentity } from "@morndo/node-ops";
import { parseEngineFile } from "../apps/hub/src/adapters/engine-registry.ts";

const dir = process.argv[2] ?? join(homedir(), ".local/share/engines/sessions");

type Row = { pid: string; name: string; status: string; match: "yes" | "no" | "no fields"; hub: string };

function hubShows(status: string, governs: boolean): string {
  if (!governs) return "screen";
  if (status === "busy") return "Working";
  if (status === "idle") return "Idle";
  return "screen";
}

function hasFields(body: Record<string, unknown>): boolean {
  return Number.isInteger(body.pidStartTicks) && typeof body.bootId === "string" && body.bootId !== "";
}

const names = (await readdir(dir)).filter(n => /^\d+\.json$/.test(n)).sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
const rows: Row[] = [];
for (const file of names) {
  const pid = Number(file.slice(0, -5));
  let text = "";
  try { text = await readFile(join(dir, file), "utf8"); } catch { /* unreadable */ }
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
  const name = typeof body.name === "string" ? body.name : "";
  const status = body.status === "busy" || body.status === "idle" ? body.status : "?";
  const fields = hasFields(body);
  const alive = processAlive(pid);
  const live = alive ? processIdentity(pid) : null;
  const governs = fields && parseEngineFile(text, pid, live) !== null;
  const match = fields ? (governs ? "yes" : "no") : "no fields";
  rows.push({ pid: String(pid), name, status, match, hub: hubShows(status, governs) });
}

const col = (s: string, n: number) => s.padEnd(n);
console.log(`${col("pid", 10)} ${col("name", 22)} ${col("file", 6)} ${col("match", 9)} hub`);
for (const r of rows) console.log(`${col(r.pid, 10)} ${col(r.name, 22)} ${col(r.status, 6)} ${col(r.match, 9)} ${r.hub}`);
const governed = rows.filter(r => r.match === "yes").length;
console.log(`${rows.length} files, ${governed} govern`);
