<script lang="ts">
  // Mounts the phone's BriefSheet with the state a test drives from outside (brief-phone.test.ts): the item, the
  // answer window, a refusal from the run, and whether the run already answered. The clock ticks like the run's does
  // (every 250 ms), so the sheet's countdown reads a live time, not the mount time. Synthetic data only.
  import BriefSheet from "../src/lib/phone/BriefSheet.svelte";
  import { AnswerSession } from "../src/lib/desktop/answer-session.svelte.ts";
  import type { DecisionItem } from "../src/lib/desktop/decisions.ts";

  let { initial, now: start }: { initial: DecisionItem; now: number } = $props();

  let item = $state(initial);
  let now = $state(start);
  let answering = $state<{ label: string; sending: boolean; commitAt: number } | null>(null);
  let refusal = $state<{ key: string; code: string; text: string } | null>(null);
  let runAnswered = $state(false);
  let note = $state<string | null>(null);
  const session = new AnswerSession(initial);

  $effect(() => { const t = setInterval(() => (now = Date.now()), 250); return () => clearInterval(t); });

  // The sheet follows the list when nothing is held (answer-session's bind): a swapped item becomes the shown one.
  function setItem(next: DecisionItem) { item = next; session.bind(next, false); }
  function setAnswering(next: { label: string; sending: boolean; commitAt: number } | null) { now = Date.now(); answering = next; }

  const counts = { picks: 0, undos: 0, verifyAgain: 0, tryAgain: 0 };
  const picks: { body: unknown; label: string }[] = [];
  Object.assign(globalThis, {
    __setItem: setItem, __setAnswering: setAnswering, __setRefusal: (v: { key: string; code: string; text: string } | null) => (refusal = v),
    __setRunAnswered: (v: boolean) => (runAnswered = v), __setNote: (v: string | null) => (note = v),
    __picks: picks, __counts: () => ({ ...counts }),
  });
</script>

<BriefSheet {item} {now} {session} {answering} {refusal} {runAnswered} {note}
  onPick={async (body, label) => { counts.picks++; picks.push({ body, label }); return true; }}
  onUndo={() => { counts.undos++; }}
  onVerifyAgain={() => { counts.verifyAgain++; }}
  onTryAgain={() => { counts.tryAgain++; }}
  onAskBrief={async () => ({ ok: true })} />
