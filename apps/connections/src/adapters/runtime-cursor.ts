// Cursor CLI sign-in. `agent status` reports whether the CLI is authenticated.
// A browser login is the subscription. An API key is CURSOR_API_KEY or --api-key, which a subscription run never uses.
// https://cursor.com/docs/cli/reference/authentication (read 2026-10-10).
import { binCommand } from "./spawn-bin.ts";
import type { Isolation } from "@morndo/domain";
import { LOGIN_KEY_REFUSAL } from "../login-refusal.ts";
import type { RunHandle, RunPlan, Runtime } from "../application/ports.ts";
import { assertSubscription, childEnv, loginEnv, runChild, StatusRefused, statusOf, type ChildHooks, type ChildResult } from "./runtime-claude.ts";

export class CursorRuntime implements Runtime {
  readonly #bin: string;
  readonly #parent: NodeJS.ProcessEnv;
  constructor(bin: string, parent: NodeJS.ProcessEnv) {
    this.#bin = bin;
    this.#parent = parent;
  }

  isolation(): Isolation { return "none"; }
  dialects(): readonly string[] { return ["cursor"]; }
  loginStatus(configDir: string | null): Promise<"ok" | "missing" | "unknown"> {
    return statusOf(this.#bin, ["status"], childEnv(this.#parent, loginEnv("cursor", configDir)));
  }

  async launch(plan: RunPlan): Promise<RunHandle> {
    try { await this.execute(plan, []); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${this.#bin} is not on PATH`);
      throw error;
    }
    return { id: plan.lease };
  }

  async execute(plan: RunPlan, extra: readonly string[], hooks?: ChildHooks): Promise<ChildResult> {
    if (!plan.subscription) throw new StatusRefused(LOGIN_KEY_REFUSAL);
    const env = childEnv(this.#parent, loginEnv("cursor", plan.configDir));
    if (plan.subscription) await assertSubscription(this.#bin, ["status"], env, "cursor");
    const started = binCommand(this.#bin, extra);
    return runChild(started.command, started.argv, {
      env,
      cwd: plan.workspace,
      ...(hooks ? { hooks } : {}),
    });
  }
}
