<script lang="ts">
  // TaskCard (B18) for a block that names its waits, and one of words only: what the card says under the reason.
  import TaskCard from "../src/lib/desktop/TaskCard.svelte";
  import type { Task } from "../src/lib/desktop/board.ts";

  const now = 1_800_000_000_000;
  const base = (key: string): Task => ({
    key: key as Task["key"], n: Number(key.slice(2)), title: "Ship it", description: "", status: "blocked", assignee: "builder", priority: "normal",
    blockedReason: "needs the widget fix", createdAt: 1, updatedAt: 1, stateChangedAt: 1, createdBy: { kind: "manager", name: "manager", token: "m" }, rev: 3, doneAt: null, comments: 0,
  });
  const withWaits: Task = { ...base("T-1"), waits: [{ kind: "pr", repo: "acme/widgets", n: 7 }, { kind: "task", key: "T-4" as Task["key"] }, { kind: "card", id: "ny-530" }] };
  const words: Task = base("T-2");
  const noop = () => {};
</script>

<div data-cell="waits"><TaskCard task={withWaits} {now} running={true} selected={false} onOpen={noop} onOpenJob={noop} onDragStart={noop} onDragEnd={noop} /></div>
<div data-cell="words"><TaskCard task={words} {now} running={true} selected={false} onOpen={noop} onOpenJob={noop} onDragStart={noop} onDragEnd={noop} /></div>
