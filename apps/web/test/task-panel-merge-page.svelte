<script lang="ts">
  // TaskPanel (B11) with a merge handed in by the board frame: one panel whose merge is not live yet, one whose is.
  // The record stays empty here (the test server has no hub), which the panel says; the merge lines are what's tested.
  import TaskPanel from "../src/lib/desktop/TaskPanel.svelte";
  import type { MergedView, Task } from "../src/lib/desktop/board.ts";

  const SHA = "abc1234deadbeef0123456789abcdef012345678";
  const now = 1_800_000_000_000;
  const taskKey = (key: string) => key as Task["key"];
  const task = (key: string): Task => ({
    key: taskKey(key), n: Number(key.slice(2)), title: "Ship it", description: "", status: "review", assignee: "builder", priority: "normal",
    blockedReason: null, createdAt: 1, updatedAt: 1, stateChangedAt: 1, createdBy: { kind: "manager", name: "manager", token: "m" }, rev: 1, doneAt: null, comments: 0,
  });
  const notLive: MergedView = {
    key: taskKey("T-1"),
    merges: [{ repo: "morndo/morndo", sha: SHA, at: 2, by: "builder", override: "accepted by the principal" }],
    live: false, label: "merged, not live: pc on abc1234",
  };
  const live: MergedView = {
    key: taskKey("T-2"),
    merges: [{ repo: "morndo/morndo", sha: SHA, at: 2, by: "builder", override: null }],
    live: true, label: "merged, live",
  };
  const onAct = async () => null;
</script>

<div class="row">
  <div class="cell" data-cell="not-live">
    <TaskPanel task={task("T-1")} lanes={["builder"]} {now} merged={notLive} {onAct} onOpenLane={() => {}} onClose={() => {}} />
  </div>
  <div class="cell" data-cell="live">
    <TaskPanel task={task("T-2")} lanes={["builder"]} {now} merged={live} {onAct} onOpenLane={() => {}} onClose={() => {}} />
  </div>
</div>

<style>
  .row { display: flex; }
  .cell { width: 400px; height: 640px; display: flex; }
</style>
