<script lang="ts">
  import ChannelView from "../src/lib/desktop/ChannelView.svelte";
  import type { DecisionItem } from "../src/lib/desktop/decisions.ts";
  import type { LiveFeed } from "../src/lib/feed.svelte.ts";
  import type { Task } from "../src/lib/desktop/board.ts";
  import type { RosterEntry } from "@morndo/domain";

  const worker = {
    id: "%0", name: "manager", location: "/work/demo-office/lanes/manager", node: "office",
    title: null, lastMessageAt: null, needsYou: false, waitingOn: null, state: "active", changedAt: 1, offline: false,
  } as RosterEntry;
  const task = {
    key: "T-18", n: 18, title: "Athenum: max reviews of #955,#958,#959 after the window", description: "",
    status: "doing", assignee: "manager", priority: "normal", blockedReason: null, createdAt: 1, updatedAt: 1,
    createdBy: { kind: "manager", name: "manager", token: "m" }, rev: 1, doneAt: null, comments: 0,
  } as Task;
  const feed = { historyFor: "%0", messages: [], older: false, olderPages: 0, loadOlder() {}, detached: false, newWhileDetached: 0, latest() {} } as unknown as LiveFeed;
</script>

{#snippet card(_item: DecisionItem)}<span></span>{/snippet}

<div class="frame">
  <ChannelView {worker} displayName="Manager" {feed} outgoing={[]} verifiedAt={1} stepUpMs={3_600_000} panel={false}
    prefs={{ show: "clean", activity: true, muted: false, starred: false }}
    onDetails={() => {}} onSecurity={() => {}} onPanel={() => {}}
    onQueue={async () => {}} onRetry={() => {}} onDiscard={() => {}} onVerify={() => {}} onEdit={() => {}}
    editRequest={null} onEdited={() => {}} onVerified={() => {}}
    decisions={2} decisionsOpen={false} onDecisions={() => {}} screenRequest={null}
    decisionOf={() => undefined} {card} focus={null} desktop={false} {task} />
</div>

<style>
  .frame { width: 780px; height: 240px; display: flex; }
</style>
