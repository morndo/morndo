// The hub's port onto the fleet's Runs (ADR-0032; docs/design/agent-board/README.md §6), over @morndo/fleet-client:
// - runs(): the client's GET /v1/runs ({ runs: RunView[] }). Each run is decoded again here with RunViewSchema and one
//   that doesn't read is dropped, never guessed (the board frame's rule, protocol board.ts). A client that has no
//   runs() (a build before ADR-0032's fleet client) can't be asked: it throws, as a fleet that isn't there does.
// - subscribe(): the client's `run` events ({ t: "run", node, body: RunView }), decoded the same way, and `onOpen` after
//   every (re)subscription, since a run sent meanwhile isn't replayed (fleet-client events()).
// `RunsClient` is the client as this adapter uses it, written against the documented shape: `runs` is optional and the
// event's `t` is read as a string, so it compiles against a fleet client with or without the `run` event.
import { RunViewSchema, parseBody, type RunView } from "@morndo/protocol";
import type { FleetClient } from "@morndo/fleet-client";
import type { RunsSource } from "../application/ports.ts";

export type RunsClient = Pick<FleetClient, "events"> & { runs?: () => Promise<readonly unknown[]> };

const decoded = (v: unknown): RunView | null => parseBody(RunViewSchema, v);

export function fleetRuns(client: RunsClient): RunsSource {
  return {
    async runs() {
      if (typeof client.runs !== "function") throw new Error("this fleet client has no runs(): the fleet's runs can't be asked");
      const list = await client.runs();
      if (!Array.isArray(list)) throw new Error("GET /v1/runs: not a list of runs");
      return list.map(decoded).filter((r): r is RunView => r !== null);
    },
    subscribe(on, onOpen) {
      return client.events(e => {
        const t: string = e.t;
        if (t !== "run") return;
        const run = decoded(e.body);
        if (run) on(run);
      }, { onOpen });
    },
  };
}
