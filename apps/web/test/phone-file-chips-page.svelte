<script lang="ts">
  import "@morndo/brand/tokens.css";
  import "@fontsource/lato/400.css";
  import "@fontsource/lato/700.css";
  import type { Message, RosterEntry } from "@morndo/domain";
  import { LiveFeed } from "../src/lib/feed.svelte.ts";
  import Conversation from "../src/lib/phone/chat/Conversation.svelte";
  import type { OutboxRecord } from "../src/lib/outbox/state.ts";
  import "../src/lib/phone/phone.css";

  const now = Date.now();
  const worker = {
    id: "%builder" as RosterEntry["id"], name: "builder", location: "box", node: "local", offline: false,
    title: null, lastMessageAt: now, needsYou: false, waitingOn: null, state: "quiet" as const, changedAt: now,
  };
  const file = (name: string, kind: "image" | "text" | "pdf" | "file", size: number, id: string | null = name): NonNullable<Message["attachments"]>[number] =>
    ({ id, name, mime: "application/octet-stream", kind, size, caption: null });
  const msg = (id: string, author: Message["author"], text: string, attachments: Message["attachments"]): Message =>
    ({ id, at: now - 60_000, author, kind: "text", text, attachments });

  const feed = new LiveFeed();
  feed.historyFor = worker.id;
  feed.messages = [
    msg("lane-a", { kind: "agent", name: "builder" }, "shots", [
      file("login-before-after.png", "image", 1024),
      file("release-notes.md", "text", 119),
    ]),
    msg("lane-b", { kind: "agent", name: "builder" }, "more", [
      file("build.log", "text", 59),
      file("spec.pdf", "pdf", 610),
      file("bundle.bin", "file", 6),
      file("evil.svg", "file", 147),
    ]),
    msg("sent", { kind: "principal", name: "You" }, "sent these", [
      file("notes.md", "text", 12),
      file("rows.csv", "text", 20),
    ]),
  ];
  const outgoing: OutboxRecord[] = [{
    id: "out-1", worker: worker.id, workerName: "builder", text: "on the way", uploads: ["a", "b"],
    createdAt: now, budgetFrom: now, state: "sending", error: null, attempts: 1, seen: "none", sentAt: null, typedAt: null,
  }];
  const pendingFiles = {
    "out-1": [
      { name: "phone.md", kind: "text" as const, size: 17 },
      { name: "quarterly-planning-notes-for-the-whole-team.md", kind: "text" as const, size: 40 },
    ],
  };
</script>

<div class="phone">
  <Conversation {feed} {worker} {outgoing} {pendingFiles} {now} verifiedFresh={true} verify={async () => true}
    onBack={() => {}} onDecide={() => {}} onQueue={async () => {}} onRetry={() => {}} onDiscard={() => {}}
    onAgain={() => {}} onCancel={() => {}} onEchoes={() => {}} />
</div>

<style>
  :global(:root) {
    --bg: var(--morndo-bg); --surface: var(--morndo-surface); --hover: var(--morndo-hover); --fill: var(--morndo-fill);
    --edge: var(--morndo-border); --fg: var(--morndo-text); --muted: var(--morndo-text-muted); --line: var(--morndo-divider);
    --accent: var(--morndo-ink); --accent-fg: var(--morndo-ink-fg); --active: var(--morndo-success);
    --danger: var(--morndo-danger); --danger-text: var(--morndo-danger-text);
    --font: "Lato", sans-serif; --body: "Lato", sans-serif; --mono: ui-monospace, monospace;
  }
  :global(html, body) { margin: 0; height: 100%; background: var(--bg); }
</style>
