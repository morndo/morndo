// A process Transcriber for the installed plugin. The hub's adapter is the same shape (design §5): an argument
// vector, a clean environment, and a kill of the process group on abort. notReadyBin is the same plugin with
// its model file removed, so the not-ready case is a real exit 5 rather than a name the plugin special-cases.
import { spawn, type ChildProcess } from "node:child_process";
import { problemFromExit, parseProbe, parseRun, type AbortHandle, type Transcriber, type TranscriberProbe } from "@morndo/protocol";
import type { ContractSubject } from "../../../packages/protocol/test/transcriber-contract.ts";

const STDOUT_CAP = 1024 * 1024;

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function cleanEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "/tmp",
    LANG: process.env.LANG ?? "C",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
  };
}

function pluginArgs(kind: "probe" | "run", input?: { path: string; language: string; threads: number; maxSeconds: number }): string[] {
  if (kind === "probe") return ["probe", "--json"];
  if (input === undefined) return ["run"];
  return ["run", "--input", input.path, "--language", input.language, "--threads", String(input.threads), "--max-seconds", String(input.maxSeconds), "--json"];
}

export function contractSubject(readyBin: string, notReadyBin: string, notReadyPath: string): ContractSubject {
  let pids: number[] = [];
  const transcriber: Transcriber = {
    probe: () => probe(readyBin),
    transcribe: (input) => {
      pids = [];
      const bin = input.path === notReadyPath ? notReadyBin : readyBin;
      const child = spawn(process.execPath, [bin, ...pluginArgs("run", input)], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: cleanEnv(),
      });
      if (child.pid === undefined) return Promise.reject(new Error("plugin started without a pid"));
      pids = [child.pid];
      return waitRun(child, input.signal);
    },
  };
  return { transcriber, group: () => pids.slice() };
}

function probe(bin: string): Promise<TranscriberProbe> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...pluginArgs("probe")], { stdio: ["ignore", "pipe", "pipe"], env: cleanEnv() });
    let stdout = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 5_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.resume();
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ready: false, reason: "not_ready", detail: "spawn" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ready: false, reason: "protocol", detail: `exit ${code ?? "signal"}` });
        return;
      }
      const parsed = parseProbe(stdout);
      if (!parsed.ok) {
        resolve({ ready: false, reason: "protocol", detail: "bad_output" });
        return;
      }
      if (!parsed.value.ready) {
        resolve({ ready: false, reason: "not_ready", detail: parsed.value.missing.join(",") });
        return;
      }
      resolve({
        ready: true,
        engine: parsed.value.engine,
        engineVersion: parsed.value.engineVersion,
        model: parsed.value.model,
        languages: parsed.value.languages,
        maxSeconds: parsed.value.maxSeconds,
      });
    });
  });
}

function waitRun(child: ChildProcess, signal: AbortHandle): Promise<Awaited<ReturnType<Transcriber["transcribe"]>>> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
        const later = setTimeout(() => {
          try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
        }, 10_000);
        later.unref();
      }
      finish(() => reject(abortError()));
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > STDOUT_CAP) {
        if (child.pid !== undefined) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
        }
        finish(() => resolve({ ok: false, error: "bad_output" }));
      }
    });
    child.stderr?.resume();
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) {
          const parsed = parseRun(stdout);
          if (!parsed.ok) {
            resolve({ ok: false, error: "bad_output" });
            return;
          }
          resolve({
            ok: true,
            value: { language: parsed.value.language, durationMs: parsed.value.durationMs, segments: parsed.value.segments },
          });
          return;
        }
        const problem = problemFromExit(code ?? 1);
        resolve({ ok: false, error: problem ?? "engine" });
      });
    });
    signal.addEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
  });
}
