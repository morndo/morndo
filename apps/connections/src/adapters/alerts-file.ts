import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Alert, AlertSink } from "../application/ports.ts";

function stored(path: string): { alerts: Alert[]; skipped: number } {
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return { alerts: [], skipped: 0 }; }
  const alerts: Alert[] = [];
  let skipped = 0;
  for (const line of text.split("\n").filter(item => item !== "").slice(-20)) {
    try {
      const parsed = JSON.parse(line) as Partial<Alert>;
      if (typeof parsed.kind === "string" && typeof parsed.name === "string" && typeof parsed.detail === "string") {
        alerts.push({ kind: parsed.kind, name: parsed.name, detail: parsed.detail });
      } else skipped += 1;
    } catch { skipped += 1; }
  }
  return { alerts, skipped };
}

export class FileAlerts implements AlertSink {
  readonly #path: string;
  readonly #recent: Alert[];
  skipped: number;
  constructor(path: string) {
    this.#path = path;
    const loaded = stored(path);
    this.#recent = loaded.alerts;
    this.skipped = loaded.skipped;
  }
  raise(alert: Alert): void {
    this.#recent.push(alert);
    if (this.#recent.length > 20) this.#recent.shift();
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    appendFileSync(this.#path, `${JSON.stringify(alert)}\n`, { mode: 0o600 });
  }
  recent(): readonly Alert[] { return [...this.#recent].reverse(); }
}
