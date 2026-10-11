// What hook traffic costs on this machine's disk (fleet core §16.4): a real fleet service and a real node agent in
// temporary HOMEs (test/fleet-harness.ts: isolated tmux server, random ports, nothing of the owner's touched), one hook
// subscriber, and a steady stream of PreToolUse-sized hooks into the relay, sent as /hook/stop: kept, never coalesced,
// so each one can be followed to the subscriber; /cc takes the same write (spool.ts append). It reports, as percentiles:
//   hook     how long the relay took to answer a hook: what a lane waits for on each tool call (a 2 s hook timeout)
//   op       an inventory.get through the fleet while the hooks flow: how much the agent's own work is held up
//   send     a keyed pane.send into a scratch pane (a fake input box): typing, with its done keys
//   deliver  from a hook's answer to its arrival at the subscriber: what kira would see as lag
//   fsync    one 512-byte write and fsync in the temporary directory: the disk itself
// The temporary directories go where TMPDIR points (os.tmpdir()), so point it at the disk you want to measure.
//   node scripts/bench-relay.ts [--hooks 300] [--rate 5] [--sends 10] [--gate]
// --gate: also judge the run by the hook swap's gate (scripts/bench-gate.ts; fleet clients spec §6). The rate is then 2
// hooks a second unless --rate says otherwise, and the gate refuses a lower one. The output ends with the measured numbers
// and a last line, `gate: PASS` or `gate: FAIL (<which bound>)` (plan/RECONCILIATION.md ruling 38); the exit is 0 or 1.
// Run it on the disk the fleet uses: TMPDIR points there.
import { closeSync, fsyncSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { expectOf, fakeLane, hook, joinAgent, paneOf, startFleet, stopAll, subscriber, tmuxServer, until } from "../test/fleet-harness.ts";
import { gate, nearestRank } from "./bench-gate.ts";

const { values } = parseArgs({ options: { hooks: { type: "string", default: "300" }, rate: { type: "string" }, sends: { type: "string", default: "10" }, gate: { type: "boolean", default: false } } });
const HOOKS = Number(values.hooks), RATE = Number(values.rate ?? (values.gate ? "2" : "5")), SENDS = Number(values.sends);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pct = (xs: number[], p: number) => nearestRank(xs, p) ?? 0;
const line = (name: string, xs: number[]) =>
  console.log(`${name.padEnd(8)} n=${String(xs.length).padStart(4)}  p50 ${pct(xs, 50).toFixed(1).padStart(7)} ms  p95 ${pct(xs, 95).toFixed(1).padStart(7)} ms  max ${Math.max(0, ...xs).toFixed(1).padStart(7)} ms`);

function fsyncProbe(n = 15): number[] {
  const dir = mkdtempSync(join(tmpdir(), "morndo-bench-fsync-"));
  const out: number[] = [];
  try {
    const fd = openSync(join(dir, "probe"), "a");
    for (let i = 0; i < n; i++) { const t = performance.now(); writeSync(fd, Buffer.alloc(512)); fsyncSync(fd); out.push(performance.now() - t); }
    closeSync(fd);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return out;
}

// A PreToolUse body of about the size Claude Code sends (session, cwd, the tool and its input).
const body = (i: number) => ({
  session_id: `bench-${i % 4}`, hook_event_name: "PreToolUse", cwd: "/home/user/project", tool_name: "Bash",
  tool_input: { command: `echo step ${i}`, description: "x".repeat(1200) }, transcript_path: "/home/user/.claude/projects/p/s.jsonl",
});

let code = 0;
try {
  console.log(`node ${process.version}, temp dirs in ${tmpdir()}; ${HOOKS} hooks at ${RATE}/s, ${SENDS} sends`);
  line("fsync", fsyncProbe());
  const sub = await subscriber();
  const fleet = await startFleet({ subscribers: [{ name: "bench", url: sub.url, paths: ["/cc", "/sl", "/hook/stop", "/hook/failure", "/notify", "/file"] }] });
  const tmux = tmuxServer();
  const agent = await joinAgent(fleet, "bench", { tmux });
  await fakeLane(tmux, { window: "scratch", prose: "bench scratch lane" });
  await agent.run();
  await agent.waitOnline();
  const pane = await paneOf(fleet.client, "bench", "scratch");

  const hooks: number[] = [], ops: number[] = [], answeredAt = new Map<number, number>();
  let running = true, opFailures = 0, hookFailures = 0, sendFailures = 0;
  const opLoop = (async () => {
    while (running) {
      const t = performance.now();
      // A fleet client gives up after 7 s (fleet-client.ts): a failure here is an op the agent held up that long.
      const r = await fleet.client.op({ node: "bench" }, "inventory.get", {}).catch(() => null);
      if (r?.ok) ops.push(performance.now() - t); else opFailures++;
      await sleep(250);
    }
  })();
  const fired: Promise<void>[] = [];
  const t0 = performance.now();
  for (let i = 0; i < HOOKS; i++) {
    const due = t0 + (i * 1000) / RATE;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
    fired.push((async () => {
      const t = performance.now();
      const r = await hook(agent, "/hook/stop", { ...body(i), hook_event_name: "Stop", bench: i }).catch(() => null);   // kept, never coalesced
      if (r?.status === 200) { hooks.push(performance.now() - t); answeredAt.set(i, performance.now()); } else hookFailures++;
    })());
  }
  await Promise.all(fired);
  running = false;
  await opLoop;

  const sends: number[] = [];
  for (let i = 0; i < SENDS; i++) {
    const t = performance.now();
    const r = await fleet.client.op({ node: "bench" }, "pane.send", { workerId: pane.workerId, text: `bench send ${i}`, expect: expectOf(pane) }, { key: `hub:bench-${i}-${t}` }).catch(() => null);
    if (r?.ok) sends.push(performance.now() - t); else sendFailures++;
    await sleep(200);
  }

  await until("every hook at the subscriber", () => sub.unique().size >= answeredAt.size, 120_000, 250).catch(() => {});
  const lag: number[] = [];
  for (const d of sub.unique().values()) {
    const i = (d.event.body as { bench?: number } | undefined)?.bench;
    const at = i === undefined ? undefined : answeredAt.get(i);
    if (at !== undefined) lag.push(d.got - at);
  }
  line("hook", hooks);
  line("op", ops);
  line("send", sends);
  line("deliver", lag);
  line("fsync", fsyncProbe());
  console.log(`hooks answered ${hooks.length}/${HOOKS}, delivered ${sub.unique().size}; failed or timed out: ${hookFailures} hooks, ${opFailures} ops, ${sendFailures} sends`);
  if (values.gate) {
    const verdict = gate({ rate: RATE, hooks: HOOKS, answered: answeredAt.size, delivered: lag.length, hookFailures, opFailures, deliver: lag, op: ops });
    for (const l of verdict.lines) console.log(l);
    if (!verdict.pass) code = 1;
  }
} finally {
  await stopAll();
}
process.exit(code);
