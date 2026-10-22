<script lang="ts">
  import DecisionsPanel from "../src/lib/desktop/DecisionsPanel.svelte";
  import type { AnswerBody, AnswerProblem, AskOutcome } from "../src/lib/desktop/answer-session.ts";
  import type { DecisionItem, LedgerState } from "../src/lib/desktop/decisions.ts";
  import type { CodeOutcome } from "../src/lib/desktop/memory-code.ts";

  let { initial, now }: { initial: DecisionItem[]; now: number } = $props();
  let items = $state(initial);
  let clock = $state(now);
  const ledger: LedgerState = { configured: false, ok: true, at: null };
  const answers: { id: string; body: AnswerBody; requestId: string; seen?: string }[] = [];
  const asks: DecisionItem[] = [];
  const memoryCalls: string[] = [];

  function setItems(next: DecisionItem[]) { items = next; }
  function setNow(n: number) { clock = n; }
  function problem(): AnswerProblem | null {
    return (globalThis as { __problem?: AnswerProblem | null }).__problem ?? null;
  }
  // The console code's mint, as the Desktop's would be: what the test puts in __memoryCode, or a fake code good for ten
  // minutes from the harness clock. Every ask is recorded, so a test can say it asked once.
  async function memoryCode(noteId: string): Promise<CodeOutcome> {
    memoryCalls.push(noteId);
    const fake = (globalThis as { __memoryCode?: (id: string) => CodeOutcome | Promise<CodeOutcome> }).__memoryCode;
    return fake ? await fake(noteId) : { ok: true, code: "K7M2-9QPX-4TWB", expiresAt: clock + 600_000 };
  }

  Object.assign(globalThis, { __setItems: setItems, __setNow: setNow, __answers: answers, __asks: asks, __memoryCodeCalls: memoryCalls, __ready: true });
</script>

<div class="desk-tokens" style="height:720px;display:flex">
  <div style="width:440px;display:flex;flex-direction:column">
    <DecisionsPanel {items} {ledger} now={clock} verifiedFresh={true}
      onAnswer={async (id, body, requestId, seen) => {
        answers.push({ id, body, requestId, seen });
        const gate = (globalThis as { __answerGate?: Promise<void> }).__answerGate;
        if (gate) await gate;
        return problem();
      }}
      onOpenScreen={() => { (globalThis as { __screen?: boolean }).__screen = true; }}
      onOpenChat={() => {}}
      onAskBrief={async (item): Promise<AskOutcome> => { asks.push(item); return (globalThis as { __ask?: AskOutcome }).__ask ?? { ok: true }; }}
      onMemoryCode={memoryCode} />
  </div>
</div>
