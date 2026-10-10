// Run spend is appended. A reported balance replaces it. Each threshold raises one alert (CN10–CN12).
import { findConnection, recordSpend, type Actor, type SpendSource } from "@morndo/domain";
import { err, ok, type Result } from "@morndo/domain";
import type { Deps, Failure } from "./ports.ts";
import { raiseThresholds } from "./thresholds.ts";

export class SpendService {
  readonly #deps: Deps;
  constructor(deps: Deps) { this.#deps = deps; }

  record(name: string, amount: number, source: SpendSource, actor: Actor): Result<void, Failure> {
    if (!Number.isFinite(amount)) return err({ problem: "budget" });
    return this.#append(name, amount, source, actor);
  }

  reconcile(name: string, actor: Actor): Result<void, Failure> {
    const figure = this.#deps.spend.reported(name);
    if (figure === null) return ok(undefined);
    if (!Number.isFinite(figure)) return err({ problem: "budget" });
    return this.#append(name, figure, "balance", actor);
  }

  #append(name: string, amount: number, source: SpendSource, actor: Actor): Result<void, Failure> {
    const { directory, policy, version } = this.#deps.store.load();
    if (!findConnection(directory, name)) return err({ problem: "missing" });
    const next = recordSpend(directory, name, amount, source, actor, this.#deps.clock.now());
    if (!next.ok) return err({ problem: next.error.problem });
    if (!this.#deps.store.save(next.value, policy, version)) return err({ problem: "conflict" });
    raiseThresholds(directory.events, next.value.events, this.#deps.alerts);
    return ok(undefined);
  }
}
