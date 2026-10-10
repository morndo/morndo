import type { ConnEvent } from "@morndo/domain";
import type { AlertSink } from "./ports.ts";

export function raiseThresholds(before: readonly ConnEvent[], after: readonly ConnEvent[], alerts: AlertSink): void {
  for (const event of after.slice(before.length)) {
    if (event.type === "ThresholdCrossed") alerts.raise({ kind: "threshold", name: event.name, detail: event.threshold });
  }
}
