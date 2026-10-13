<script lang="ts">
  import type { RosterEntry } from "@morndo/domain";
  import MessageList from "../src/lib/desktop/MessageList.svelte";
  import { DEFAULT_PREFS } from "../src/lib/desktop/present.ts";

  const worker = {
    id: "%lane" as RosterEntry["id"], name: "lane", location: "box", node: "local", offline: false,
    title: null, lastMessageAt: null, needsYou: false, waitingOn: null, state: "quiet" as const, changedAt: 0,
  };
  const outgoing = [{
    id: "out-1", worker: worker.id, workerName: "lane", text: "with files", uploads: ["img", "md", "csv"], seen: "none",
    createdAt: 1, budgetFrom: 1, state: "queued" as const, error: null, attempts: 0, sentAt: null, typedAt: null,
    images: ["data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"],
    files: [
      { name: "notes.md", kind: "text" as const, size: 12 },
      { name: "rows.csv", kind: "text" as const, size: 20 },
    ],
  }];
</script>

<MessageList {worker} messages={[]} loading={false} {outgoing} displayName="Lane" prefs={DEFAULT_PREFS}
  decisionOf={() => undefined} focus={null}
  onRetry={() => {}} onDiscard={() => {}} onVerify={() => {}} onEdit={() => {}}>
  {#snippet card()}{/snippet}
</MessageList>
