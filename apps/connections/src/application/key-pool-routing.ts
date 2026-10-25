// A pool joins the Priority and the engine layer after its own save (ADR-0037). The provider is published before a chain
// names it. An engine write that fails leaves the pool saved and names the retry.
import { foldPool, unfoldPool } from "@morndo/domain";
import { err, ok, type Result } from "@morndo/domain";
import { publishOwned } from "./engines-sync.ts";
import type { Catalog, Clock, ConnectionStore, EngineSettings, Failure, ModelLister, PoolNames, PoolRouting } from "./ports.ts";
import type { RoutingService } from "./routing-service.ts";

const ENGINE_LAYER = "saved, engine layer not updated (retry: morndo-keys keypool sync)";
const engineLayer = (): Failure => ({ problem: ENGINE_LAYER });

type Deps = {
  routing: RoutingService;
  engines: EngineSettings;
  catalog: Catalog;
  models: ModelLister;
  store: ConnectionStore;
  clock: Clock;
  pools: () => readonly PoolNames[];
};

export class PoolRoutingSync implements PoolRouting {
  readonly #deps: Deps;
  constructor(deps: Deps) { this.#deps = deps; }

  joined(pool: string, members: readonly string[]): Result<void, Failure> {
    try { this.#publish(); } catch { return err(engineLayer()); }
    const folded = this.#deps.routing.refold(policy => foldPool(policy, pool, members, this.#deps.clock.now()));
    if (!folded.ok) return err(engineLayer());
    try { this.#publish(); } catch { return err(engineLayer()); }
    return ok(undefined);
  }

  left(pool: string, leaving: readonly string[], remaining: readonly string[]): Result<void, Failure> {
    const unfolded = this.#deps.routing.refold((policy, listed) => unfoldPool(policy, pool, leaving, remaining, listed, this.#deps.clock.now()));
    if (!unfolded.ok) return err(engineLayer());
    try {
      this.#publish();
      if (remaining.length === 0) this.#drop(pool);
    } catch {
      return err(engineLayer());
    }
    return ok(undefined);
  }

  #publish(): void {
    const { directory } = this.#deps.store.load();
    publishOwned(directory, this.#deps.catalog, this.#deps.models, this.#deps.engines, this.#deps.pools());
  }

  // A chain that still names the pool refuses the removal; the provider stays, off.
  #drop(name: string): void {
    try {
      this.#deps.engines.removeProvider(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!message.includes("still in")) throw error;
      this.#deps.engines.putProvider({ name, enabled: false });
    }
  }
}
