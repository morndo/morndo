// The optional load and memory guard (design §5). The domain schedule only sees a reason. This module turns a
// policy and one reading into that reason. An absent policy is `off` and does not read. A reading that throws,
// or that is not a number, is `unknown` and the job stays queued.
import { readFileSync } from "node:fs";
import type { Guard } from "@morndo/domain";
import type { JobGuardPolicy } from "../config.ts";

export type MachineSample = { load1?: number; memAvailableMiB?: number };
export type ProcLines = { load1?: boolean; mem?: boolean };

export function guardOf(policy: JobGuardPolicy | undefined, read: () => MachineSample): Guard {
  if (!policy) return "off";
  const wantLoad = policy.load1 !== undefined;
  const wantMem = policy.memAvailableMiB !== undefined;
  let sample: MachineSample;
  try { sample = read(); }
  catch { return "unknown"; }
  if (wantLoad && !Number.isFinite(sample.load1)) return "unknown";
  if (wantMem && !Number.isFinite(sample.memAvailableMiB)) return "unknown";
  if (wantLoad && sample.load1! > policy.load1!) return "load";
  if (wantMem && sample.memAvailableMiB! < policy.memAvailableMiB!) return "memory";
  return "off";
}

// proc_loadavg(5): the first field is the 1-minute load. proc_meminfo(5): MemAvailable is kibibytes.
// Only the lines named in `lines` are read. A missing reading for a line the policy did not set is not a failure.
export function readProc(loadPath = "/proc/loadavg", memPath = "/proc/meminfo", lines: ProcLines = { load1: true, mem: true }): MachineSample {
  const sample: MachineSample = {};
  if (lines.load1 !== false) {
    const load1 = Number(readFileSync(loadPath, "utf8").trim().split(/\s+/)[0]);
    if (!Number.isFinite(load1)) throw new Error("proc unreadable");
    sample.load1 = load1;
  }
  if (lines.mem !== false) {
    const line = readFileSync(memPath, "utf8").split("\n").find(row => row.startsWith("MemAvailable:"));
    const kib = Number(line?.trim().split(/\s+/)[1]);
    if (!Number.isFinite(kib)) throw new Error("proc unreadable");
    sample.memAvailableMiB = kib / 1024;
  }
  return sample;
}
