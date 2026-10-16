// The deliverer's view of this node (deliverer.ts: PaneView, TranscriptView; RECONCILIATION.md ruling 19):
// - the lanes the inventory lists, each with its Claude Code session and that session's status (Task 4's Lane, from the
//   session registry), and when its pane's own process started (ruling 14);
// - the input box's own text, read from the pane's screen with its colours (Claude Code's dim suggestion is no draft);
// - a session's transcript, read as whole JSONL lines from a byte offset, at most 1 MiB a call.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { draftOnScreen, localTranscriptBytes, type Tmux } from "@morndo/node-ops";
import { LIMITS } from "@morndo/protocol";
import type { Inventory, Snapshot } from "../ops/inventory.ts";
import type { PaneState, PaneView, TranscriptView } from "./deliverer.ts";

// When a process started, on this machine's clock (ruling 14). The 2-minute grace of spec §4.1 counts from a pane's own
// process, so it survives an agent restart.
// - Linux: field 22 of /proc/<pid>/stat, "the time the process started after system boot ... expressed in clock ticks
//   (divide by sysconf(_SC_CLK_TCK))", plus /proc/stat's btime, "boot time, in seconds since the Epoch"
//   (https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html, https://man7.org/linux/man-pages/man5/proc_stat.5.html,
//   read 2026-10-08). The command's name (field 2) may hold spaces and parentheses, so fields are counted after its last ")".
// - Elsewhere (macOS): `ps -o lstart= -p <pid>` under LC_ALL=C. It gives the start to the second, in a form Date.parse
//   reads only in the C locale: "Thu Oct  8 21:57:02 2026"; under de_DE it printed "Do.  8 Okt. 21:57:02 2026" (macOS,
//   2026-10-08).
// null when the process is gone or its start can't be read. A start once read is kept while its pid is listed, since a pid
// is reused only after its process ended. Reads are synchronous, once per new pane.
export function startFromProcStat(stat: string, btimeSec: number, ticksPerSec: number): number | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");       // field 3 onwards
  const raw = fields[19];                                                   // field 22
  const ticks = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(ticks) && Number.isFinite(btimeSec) && ticksPerSec > 0 ? btimeSec * 1000 + Math.round((ticks / ticksPerSec) * 1000) : null;
}

// /proc/stat's boot time, and the clock ticks a second (getconf CLK_TCK; 100 on the usual kernels).
function bootInfo(): { btimeSec: number; ticks: number } {
  const btimeSec = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
  let ticks = 100;
  try { ticks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim()) || 100; }
  catch { /* the usual 100 */ }
  return { btimeSec, ticks };
}

export class ProcessStarts {
  #at = new Map<number, number>();
  #boot: { btimeSec: number; ticks: number } | null = null;

  at(pid: number): number | null {
    const known = this.#at.get(pid);
    if (known !== undefined) return known;
    const at = this.#read(pid);
    if (at !== null) this.#at.set(pid, at);
    return at;
  }

  // Forgets every pid but these (the panes listed now), so a pid used again by a new process is read again.
  keepOnly(pids: ReadonlySet<number>): void {
    for (const pid of this.#at.keys()) if (!pids.has(pid)) this.#at.delete(pid);
  }

  #read(pid: number): number | null {
    try {
      if (process.platform === "linux") {
        this.#boot ??= bootInfo();
        return startFromProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"), this.#boot.btimeSec, this.#boot.ticks);
      }
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" },
      }).trim();
      const at = Date.parse(out);
      return Number.isFinite(at) ? at : null;
    } catch {
      return null;
    }
  }
}

// A screen line as it shows, without SGR sequences (ESC [ … m), read character by character: the lint forbids the
// escape character in a regular expression outside the terminal fixtures.
function visible(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    if (line.charCodeAt(i) === 27 && line[i + 1] === "[") {
      let j = i + 2;
      while (j < line.length && "0123456789;".includes(line[j] as string)) j++;
      if (line[j] === "m") { i = j; continue; }
    }
    out += line[i];
  }
  return out;
}

export function agentPaneView(d: { inventory: Inventory; tmux: Pick<Tmux, "capture">; starts?: ProcessStarts }): PaneView {
  const starts = d.starts ?? new ProcessStarts();
  const states = (s: Snapshot): PaneState[] => {
    const pids = new Map(s.rows.map(r => [r.pane, r.panePid] as const));
    starts.keepOnly(new Set([...pids.values()].filter((p): p is number => p !== null)));
    return s.lanes.map(l => {
      const pid = pids.get(l.pane) ?? null;
      return { workerId: l.workerId, pane: l.pane, window: l.window, sessionId: l.sessionId, status: l.status, startedAt: pid === null ? null : starts.at(pid) };
    });
  };
  return {
    snapshot: () => states(d.inventory.last()),
    refresh: async () => states(await d.inventory.current(LIMITS.inventoryPollMs)),
    async draft(pane) {
      const screen = await d.tmux.capture(pane, { lines: 30, attributes: true });
      if (screen === null) return null;
      const lines = screen.split("\n");
      while (lines.length && visible(lines.at(-1) ?? "").trim() === "") lines.pop();   // the pane's empty bottom lines
      return draftOnScreen(lines.join("\n"));
    },
  };
}

const READ_MAX = 1 << 20;

export function agentTranscripts(transcriptPath: (sessionId: string) => string | null): TranscriptView {
  return {
    async size(sessionId) {
      const path = transcriptPath(sessionId);
      return path === null ? null : await localTranscriptBytes(path).size();
    },
    // Whole lines from `from` (a line still being written stays for the next call). A line longer than one call reads
    // is skipped: the cursor moves past what was read, and the line's rest is no JSON that could be a receipt.
    async lines(sessionId, from) {
      const path = transcriptPath(sessionId);
      if (path === null) return null;
      const source = localTranscriptBytes(path);
      const size = await source.size();
      if (size === null) return null;
      const start = from > size ? 0 : from;                    // a transcript shorter than before: read it again
      const parts: Buffer[] = [];
      let pos = start;
      while (pos < size && pos - start < READ_MAX) {
        const got = await source.read(pos, LIMITS.chunkBytes);
        if (!got || got.bytes.length === 0) break;
        parts.push(Buffer.from(got.bytes));
        pos += got.bytes.length;
      }
      const buf = Buffer.concat(parts);
      const end = buf.lastIndexOf(0x0a);
      if (end === -1) return { lines: [], next: buf.length >= READ_MAX ? start + buf.length : start };
      const rows = buf.subarray(0, end).toString("utf8").split("\n");
      let at = start;
      const starts = rows.map(row => { const s = at; at += Buffer.byteLength(row) + 1; return s; });
      return { lines: rows.filter(l => l.length > 0), starts: starts.filter((_, i) => rows[i]!.length > 0), next: start + end + 1 };
    },
  };
}
