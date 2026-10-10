// A pane's follow is rebuilt (its pane missed from one session-registry read, or one tmux listing failed): the
// principal's view of the conversation must still hold each message once, in time order (O5), newest kept.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@morndo/domain";
import { sessionRegistry } from "@morndo/node-ops";
import { localSessions, localTranscripts } from "../src/adapters/local-node.ts";
import { ObservationService, type Listener } from "../src/application/observation-service.ts";
import type { Tmux } from "../src/application/ports.ts";

type Listing = Awaited<ReturnType<Tmux["listWorkers"]>>;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-refollow-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const START = Date.parse("2026-09-30T21:00:00.000Z");   // one reply a minute: the transcripts cross midnight
const reply = (n: number) => JSON.stringify({
  type: "assistant", uuid: `a${n}`, timestamp: new Date(START + n * 60_000).toISOString(),
  message: { role: "assistant", content: [{ type: "text", text: `reply ${n}` }] },
}) + "\n";
const replies = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => reply(from + i)).join("");

function fixture(messages: number) {
  const sessionFile = join(dir, "sessions", "1.json");
  const transcript = join(dir, "projects", "-tmp-demo", "s1.jsonl");
  mkdirSync(join(dir, "sessions"));
  mkdirSync(join(dir, "projects", "-tmp-demo"), { recursive: true });
  const good = JSON.stringify({ pid: process.pid, sessionId: "s1", tmux: "qa:@0.%1", name: "builder", cwd: "/tmp/demo", version: "2.1.286", updatedAt: 1 });
  writeFileSync(sessionFile, good);
  writeFileSync(transcript, replies(0, messages));
  let listing: Listing = [{ id: "%1", name: "builder", location: "demo", node: "local", offline: false }];
  const tmux = { listWorkers: async () => listing, captureMany: async (ids: string[]) => new Map(ids.map(id => [id, "❯ "])) };
  let now = START + 1_000_000;
  const registry = sessionRegistry(dir);
  const service = new ObservationService(tmux, 60_000, () => now, { sessions: localSessions(registry), transcripts: localTranscripts(registry) });
  return {
    service, transcript,
    advance: (ms: number) => { now += ms; },
    setListing: (l: Listing) => { listing = l; },
    breakSessionFile: () => writeFileSync(sessionFile, good.slice(0, 20)),   // one unreadable read of the registry
    fixSessionFile: () => writeFileSync(sessionFile, good),
  };
}

// The web client (apps/web/src/lib/feed.svelte.ts:116-130): "history" replaces the list; "messages" appends the
// ones it doesn't know yet and keeps the last 400.
function client(service: ObservationService, worker: string) {
  const delivered = new Set<string>();
  const redelivered: string[] = [];
  let list: Message[] = service.history(worker);
  for (const m of list) delivered.add(m.id);
  const listener: Listener & { history(w: string, ms: Message[]): void } = {
    events: () => {},
    screen: () => {},
    watching: () => worker,
    history: (w, ms) => { if (w !== worker) return; list = ms; for (const m of ms) delivered.add(m.id); },
    messages: (w, ms) => {
      if (w !== worker) return;
      for (const m of ms) { if (delivered.has(m.id)) redelivered.push(m.id); delivered.add(m.id); }
      const known = new Set(list.map(x => x.id));
      const added = ms.filter(x => !known.has(x.id));
      if (added.length) list = [...list, ...added].slice(-400);
    },
  };
  service.subscribe(listener);
  return { redelivered, list: () => list };
}

const inTimeOrder = (ms: Message[]) => ms.every((m, i) => i === 0 || (ms[i - 1] as Message).at <= m.at);
// The chat starts a day divider whenever the day changes (apps/web/src/lib/desktop/grouping.ts:27-31), keyed by the
// day: a day that comes back further down gives two dividers with one key.
const dayDividersUnique = (ms: Message[]) => {
  const seen = new Set<string>();
  let last = "";
  for (const m of ms) {
    const day = new Date(m.at).toISOString().slice(0, 10);
    if (day === last) continue;
    if (seen.has(day)) return false;
    seen.add(day);
    last = day;
  }
  return true;
};
const view = (c: ReturnType<typeof client>) => {
  const list = c.list();
  return { redelivered: c.redelivered.length, inTimeOrder: inTimeOrder(list), newest: list.at(-1)?.text, dayDividersUnique: dayDividersUnique(list) };
};

describe("a rebuilt follow doesn't resend the conversation as new messages", () => {
  it("after one session-registry read without the pane", async () => {
    const f = fixture(200);
    await f.service.poll();                               // the hub follows the session
    const c = client(f.service, "%1");                    // the principal opens the channel: the latest 150
    expect(c.list()).toHaveLength(150);

    appendFileSync(f.transcript, replies(200, 202));
    f.advance(1_000);
    await f.service.poll();
    expect(c.list().slice(-2).map(m => m.text)).toEqual(["reply 200", "reply 201"]);   // new replies arrive (control)

    f.breakSessionFile();
    f.advance(10_000);
    await f.service.poll();                               // the pane is missing from this read: its follow is dropped
    f.fixSessionFile();
    f.advance(10_000);
    await f.service.poll();                               // ...and rebuilt from the transcript

    expect(view(c)).toEqual({ redelivered: 0, inTimeOrder: true, newest: "reply 201", dayDividersUnique: true });
  });

  it("after one failed tmux listing, with a long transcript (the newest stay shown)", async () => {
    const f = fixture(700);
    await f.service.poll();
    const c = client(f.service, "%1");
    expect(c.list().at(-1)?.text).toBe("reply 699");

    f.setListing([]);                                     // list-panes failed once: the adapter returns no workers
    f.advance(1_000);
    await f.service.poll();
    f.setListing([{ id: "%1", name: "builder", location: "demo", node: "local", offline: false }]);
    f.advance(1_000);
    await f.service.poll();

    expect(view(c)).toEqual({ redelivered: 0, inTimeOrder: true, newest: "reply 699", dayDividersUnique: true });
  });
});
