<script lang="ts">
  import DecisionsPanel from "../src/lib/desktop/DecisionsPanel.svelte";
  import type { AnswerBody, AnswerProblem } from "../src/lib/desktop/DecisionCard.svelte";
  import type { DecisionItem, LedgerState } from "../src/lib/desktop/decisions.ts";

  let { initial, now }: { initial: DecisionItem[]; now: number } = $props();
  let items = $state(initial);
  const ledger: LedgerState = { configured: false, ok: true, at: null };
  const answers: { id: string; body: AnswerBody; requestId: string; seen?: string }[] = [];
  const asks: DecisionItem[] = [];

  function setItems(next: DecisionItem[]) { items = next; }
  function problem(): AnswerProblem | null {
    return (globalThis as { __problem?: AnswerProblem | null }).__problem ?? null;
  }

  Object.assign(globalThis, { __setItems: setItems, __answers: answers, __asks: asks, __ready: true });
</script>

<div class="desk-tokens" style="height:720px;display:flex">
  <div style="width:440px;display:flex;flex-direction:column">
    <DecisionsPanel {items} {ledger} {now} verifiedFresh={true}
      onAnswer={async (id, body, requestId, seen) => { answers.push({ id, body, requestId, seen }); return problem(); }}
      onOpenScreen={() => { (globalThis as { __screen?: boolean }).__screen = true; }}
      onOpenChat={() => {}}
      onAskBrief={async (item) => { asks.push(item); return (globalThis as { __ask?: { ok: boolean; error?: string } }).__ask ?? { ok: true }; }} />
  </div>
</div>
