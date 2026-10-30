// ProcessTranscriber (design §5, §13): the contract suite from the protocol package, against the fixture plugin,
// plus the host's own bounds. group() is passed so the timeout case checks the process group is dead.
import { existsSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { constants, getPriority, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SENTENCE } from "../../../packages/protocol/test/answers.mjs";
import { alive, until } from "../../../packages/protocol/test/proc.ts";
import { transcriberContract } from "../../../packages/protocol/test/transcriber-contract.ts";
import { processTranscriber } from "../src/adapters/transcriber-process.ts";

const FIXTURE = fileURLToPath(new URL("../../../packages/protocol/test/fixtures/fake-transcribe.mjs", import.meta.url));

const call = (path: string, signal = new AbortController().signal) =>
  ({ path, language: "auto" as const, threads: 1, maxSeconds: 600, signal });

// An abort rejects the call at once, but the run's working directory goes when the child's stdio closes, a moment
// later. A test that aborts waits for that before it ends, or the directory is still there when the scratch check runs.
const removed = (dir: string) => until(() => !existsSync(dir), 5000);

transcriberContract(() => {
  const transcriber = processTranscriber(FIXTURE);
  return { transcriber, group: () => transcriber.group() };
});

describe("process host", () => {
  it("returns bad_output for a broken document and keeps neither the sentence nor a stderr token", async () => {
    const host = processTranscriber(FIXTURE);
    expect(await host.transcribe(call("/audio/bad-json.wav"))).toEqual({ ok: false, error: "bad_output" });
    expect(host.detail()).not.toContain(SENTENCE);
    expect(await host.transcribe(call("/audio/protocol-2.wav"))).toEqual({ ok: false, error: "bad_output" });
    expect(host.detail()).not.toContain("protocol");
    const huge = await host.transcribe(call("/audio/huge.wav"));
    expect(huge).toEqual({ ok: false, error: "bad_output" });
    expect(host.detail().length).toBeLessThan(4096);
    expect(host.detail()).not.toContain("x".repeat(64));
    const heard = await host.transcribe(call("/audio/stderr-token.wav"));
    expect(heard).toEqual({
      ok: true,
      value: { language: "de", durationMs: 5200, segments: [{ startMs: 0, endMs: 5200, text: SENTENCE }] },
    });
    expect(host.detail()).not.toContain("fixture-token-9f3a");
    expect(host.detail()).not.toContain(SENTENCE);
  });

  it("runs the child below normal, with only PATH, HOME, LANG and TMPDIR", async () => {
    const host = processTranscriber(FIXTURE);
    const ac = new AbortController();
    const pending = host.transcribe(call("/audio/hang.wav", ac.signal));
    expect(await until(() => host.group().length > 0, 2000)).toBe(true);
    const pid = host.group()[0];
    if (pid === undefined) throw new Error("the run started without a pid");
    // The pid is visible before the child has exec'd, and while the exec lands /proc/<pid>/environ reads back
    // empty: until the new image's argument pages are in place, env_start equals env_end (proc(5), read
    // 2026-10-13). Both states pass a "has a TMPDIR row" gate — the runner's own environment has one — so the
    // gate can pass on one state and the read below land on another, under load. What only the exec'd child
    // shows is the final shape: no key besides the four, and a TMPDIR pointing at the run's own morndo-tx
    // directory (the runner's TMPDIR, the one before the exec, is a morndo-test scratch path). That state is
    // final — the environment never changes again — so the rows the wait ends on are the rows to assert against.
    const allowed = new Set(["PATH", "HOME", "LANG", "TMPDIR"]);
    let raw: string[] = [];
    let seen = "(no read yet)";
    const settled = () => {
      try {
        const rows = readFileSync(`/proc/${pid}/environ`).toString("utf8").split("\0").filter(row => row !== "");
        seen = rows.join(" ") || "(empty)";
        const tmp = rows.find(row => row.startsWith("TMPDIR=") && row.includes("morndo-tx-"));
        if (tmp !== undefined && rows.every(row => allowed.has(row.split("=")[0] ?? ""))) raw = rows;
      } catch { seen = `unreadable: /proc/${pid}/environ`; }
      return raw.length > 0;
    };
    if (!(await until(settled, 2000))) throw new Error(`the child's environment never settled; last seen: ${seen}`);
    expect(alive(pid)).toBe(true);
    // Node 24 os.constants.priority.PRIORITY_BELOW_NORMAL is nice 10 on Linux (docs fetched 2026-10-13).
    expect(constants.priority.PRIORITY_BELOW_NORMAL).toBe(10);
    expect(getPriority(pid)).toBe(10);
    const keys = raw.map(row => row.split("=")[0] ?? "");
    const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    const expected = ["HOME", "LANG", "PATH", "TMPDIR"].filter(key => key === "TMPDIR" || process.env[key]);
    expect(keys.sort(order)).toEqual(expected.sort(order));
    expect(raw.join("\0")).not.toContain("MORNDO_");
    const tmp = raw.find(row => row.startsWith("TMPDIR="))?.slice("TMPDIR=".length);
    expect(readlinkSync(`/proc/${pid}/cwd`)).toBe(tmp);
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(await removed(tmp ?? "")).toBe(true);
  });

  it("a setup that throws synchronously leaves no temp directory behind", async () => {
    const dirs = () => readdirSync(tmpdir()).filter(name => name.startsWith("morndo-tx-")).length;
    const before = dirs();
    const host = processTranscriber("");                      // spawn throws before the child exists
    await expect(host.transcribe(call("/audio/a.wav"))).rejects.toThrow();
    expect(dirs()).toBe(before);                              // the run's working directory is the host's to remove
  });

  it("a group member that ignores SIGTERM is still killed after the leader closes", async () => {
    const host = processTranscriber(FIXTURE);
    const ac = new AbortController();
    const pending = host.transcribe(call("/audio/stubborn.wav", ac.signal));
    expect(await until(() => host.group().length > 1, 2000)).toBe(true);   // the leader and its stubborn child
    const member = host.group()[1];
    if (member === undefined) throw new Error("the group never named the member");
    const dir = readlinkSync(`/proc/${host.group()[0]}/cwd`);
    await new Promise(r => setTimeout(r, 500));               // let the member install its SIGTERM handler
    ac.abort();                                               // SIGTERM to the group: the leader ends, the member stays
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });   // 'close' has fired by now
    expect(alive(member)).toBe(true);                         // SIGTERM alone was not enough for it
    // The SIGKILL escalation must outlive the leader's stdio: the member dies without the hub's help.
    expect(await until(() => !alive(member), 15_000)).toBe(true);
    expect(await removed(dir)).toBe(true);
  });

  it("a probe during a run neither takes the run's group nor empties it", async () => {
    const host = processTranscriber(FIXTURE);
    const ac = new AbortController();
    const pending = host.transcribe(call("/audio/hang.wav", ac.signal));
    expect(await until(() => host.group().length > 0, 2000)).toBe(true);   // the run's leader is in place
    const leader = host.group()[0];
    if (leader === undefined) throw new Error("the run started without a pid");
    const dir = readlinkSync(`/proc/${leader}/cwd`);
    const probe = await host.probe();                         // /api/me's probe, while the run lives
    expect(probe.ready).toBe(true);
    await new Promise(r => setTimeout(r, 300));               // the probe's close has run its microtasks
    expect(host.group()).toContain(leader);                   // the run still owns its group
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(await removed(dir)).toBe(true);
  });
});
