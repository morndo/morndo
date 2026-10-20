// The descendants of a process, found with `ps -A -o pid=,ppid=` (the POSIX options -A for every process and -o with an empty
// header; procps on Linux and the BSD ps on macOS both take them: https://pubs.opengroup.org/onlinepubs/9799919799/utilities/ps.html,
// read 2026-10-20). Best effort: when ps cannot be run there are none. Take the list before signalling the parent, because a process
// whose parent has gone is handed to init and the link is lost.
import { execFileSync } from "node:child_process";

export function descendants(root: number): number[] {
  let table: string;
  try { table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 3_000 }); }
  catch { return []; }
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || parent === undefined || !Number.isInteger(pid) || !Number.isInteger(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const found: number[] = [];
  for (const queue = [root]; queue.length > 0;) {
    for (const child of children.get(queue.shift() ?? 0) ?? []) { found.push(child); queue.push(child); }
  }
  return found;
}
