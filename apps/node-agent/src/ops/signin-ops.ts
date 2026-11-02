import type { ErrorCode, OpArgs } from "@morndo/protocol";
import { effect, fail, read, type EffectContext, type OpTable } from "./executor.ts";
import type { SignInRunner } from "../signin/runner.ts";

const step = (ctx: EffectContext) => {
  const err = ctx.ready();
  return err ? fail(err.code as ErrorCode, err.message) : null;
};

export function signinOps(runner: SignInRunner): OpTable {
  return {
    "signin.accounts": read(a => runner.accounts(a)),
    "signin.status": read(a => runner.status(a)),
    "signin.start": effect(
      (a: OpArgs["signin.start"]) => `signin:${a.id}`,
      async (a, ctx) => {
        const refused = step(ctx);
        if (refused) return refused;
        return runner.start(a);
      },
    ),
    "signin.code": effect(
      (a: OpArgs["signin.code"]) => `signin:${a.id}`,
      async (a, ctx) => {
        const refused = step(ctx);
        if (refused) return refused;
        return runner.code(a);
      },
    ),
    "signin.cancel": effect(
      (a: OpArgs["signin.cancel"]) => `signin:${a.id}`,
      async (a, ctx) => {
        const refused = step(ctx);
        if (refused) return refused;
        return runner.cancel(a);
      },
    ),
  };
}
