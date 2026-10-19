// Spending a reset credit (ADR-0029, PL10): the only module that names the method. It runs only on the principal's command
// (`pool reset … --by … --yes`), never from a read or a turn. In 0.161.0 the method is `account/rateLimitResetCredit/consume`
// with { idempotencyKey } and answers { outcome }, one of reset, nothingToReset, noCredit, alreadyRedeemed (codex-cli 0.161.0,
// `codex app-server generate-json-schema`: v2/ConsumeAccountRateLimitResetCreditParams.json and …Response.json, 2026-10-15).
import { askAppServer } from "./codex-account.ts";

const OUTCOMES = ["reset", "nothingToReset", "noCredit", "alreadyRedeemed"] as const;
export type ResetOutcome = (typeof OUTCOMES)[number];

export async function spendResetCredit(input: { bin: string; env: NodeJS.ProcessEnv; version: string; key: string }):
  Promise<{ ok: true; outcome: ResetOutcome } | { ok: false; problem: string }> {
  const asked = await askAppServer({ bin: input.bin, env: input.env, version: input.version }, [
    { method: "account/rateLimitResetCredit/consume", params: { idempotencyKey: input.key } },
  ]);
  if (!asked.ok) return asked;
  const answer = asked.results[0];
  const outcome = typeof answer === "object" && answer !== null ? (answer as { outcome?: unknown }).outcome : undefined;
  const known = OUTCOMES.find(o => o === outcome);
  return known ? { ok: true, outcome: known } : { ok: false, problem: "codex app-server answered in a shape this reader does not know" };
}
