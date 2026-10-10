// The fleet service's logger (ADR-0008 A4): levels, and one sink that redacts every line, error stacks included. The rules and the
// error format are @morndo/protocol's (redact.ts), shared with the other two services; what is here is this service's
// prefix, its sink and its one logger. Message text from workers, hook bodies, keys and codes are never passed to it.
import { homedir } from "node:os";
import { LEVEL_RANK, levelFrom, redactText, toLogFormat, type Level } from "@morndo/protocol";

export type { Level };
export { levelFrom, toLogFormat };
export type Sink = (line: string, level: Level) => void;
export type Logger = Record<Level, (message: string, error?: unknown) => void>;

export const redact = (text: string, home: string = homedir()): string => redactText(text, home);

const standardSink: Sink = (line, level) => {
  (level === "warn" || level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
};

export function createLogger(o: { level?: Level; home?: string; sink?: Sink } = {}): Logger {
  const min = LEVEL_RANK[o.level ?? "info"];
  const sink = o.sink ?? standardSink;
  const home = o.home ?? homedir();
  const at = (level: Level) => (message: string, error?: unknown) => {
    if (LEVEL_RANK[level] < min) return;
    const line = `[fleet] ${level}: ${message}${error === undefined ? "" : `\n${toLogFormat(error)}`}`;
    sink(redact(line, home), level);
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

// The fleet service's one logger; MORNDO_FLEET_LOG_LEVEL picks the level (default info).
export const log: Logger = createLogger({ level: levelFrom(process.env.MORNDO_FLEET_LOG_LEVEL) });
