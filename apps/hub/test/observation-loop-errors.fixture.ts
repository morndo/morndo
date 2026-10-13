// Child process for observation-loop-errors.test.ts: runs the real ObservationService loop against a Claude config dir
// the parent prepared (with a bad session registry), adds a worker to the tmux listing once the loop runs, and reports
// what a subscriber saw. Usage: node observation-loop-errors.fixture.ts <claudeDir>
import type { FeedEvent } from "@morndo/domain";
import { sessionRegistry } from "@morndo/node-ops";
import { localSessions, localTranscripts } from "../src/adapters/local-node.ts";
import { ObservationService } from "../src/application/observation-service.ts";

const dir = process.argv[2] as string;
let polls = 0;
let listing = [{ id: "%1", name: "builder", location: "demo", node: "local", offline: false }];
const tmux = { listWorkers: async () => { polls++; return listing; }, captureMany: async (ids: string[]) => new Map(ids.map(id => [id, "❯ "])) };
const registry = sessionRegistry(dir);
const service = new ObservationService(tmux, 60_000, Date.now, { sessions: localSessions(registry), transcripts: localTranscripts(registry) });
const appeared: string[] = [];
const listener = {
  events: (events: FeedEvent[]) => { for (const e of events) if (e.body.type === "WorkerAppeared") appeared.push(e.body.worker.id); },
  screen: () => {}, messages: () => {}, history: () => {}, watching: () => null,
};
service.subscribe(listener);
// A failed read is logged to stderr (log.ts); the result goes to stdout as JSON.

service.start(20);
const until = async (ok: () => boolean, ms: number) => {
  const end = performance.now() + ms;
  while (!ok() && performance.now() < end) await new Promise(r => setTimeout(r, 10));
};
await until(() => polls >= 1, 5_000);
listing = [...listing, { id: "%2", name: "reviewer", location: "demo", node: "local", offline: false }];
const after = polls;
await until(() => polls >= after + 2 && appeared.includes("%2"), 5_000);
service.stop();
console.log(JSON.stringify({ appeared, history: service.history("%1").map(m => m.text) }));
