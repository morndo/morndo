// The two-machine run's start-of-run sweep (review of #116), kept apart so it is tested on its own (fleet-sweep.test.ts):
// a run removes only what a gone run of its own kind left — its containers, then its network, then its build scratch —
// never a live run's, and never #109's single-machine run (label morndo-c2-e2e), whose own sweep takes its own. Whose a
// leftover is, and whether that run still lives, are checks.ts's (#109): a run's owner is its pid and start time.
import { sweepContainers, sweepScratch } from "./checks.ts";

/** Every container, network and image this run makes carries this label… */
export const FLEET_LABEL = "morndo-c3-fleet-e2e";
/** …and its containers and network this one too: whose run they are (checks.ts ownerText). */
export const FLEET_OWNER_LABEL = "morndo-c3-fleet-e2e.owner";
/** The build scratch's prefix (build.ts's fleet set): morndo-fleet-build-XXXXXX, owned from its first moment. */
export const FLEET_SCRATCH_PREFIX = "morndo-fleet";

export type Docker = (args: string[]) => { code: number; out: string; err: string };

/** The labels for `docker run` and `docker network create`: the run's kind, and its owner. */
export const ownerLabels = (owner: string): string[] => ["--label", `${FLEET_LABEL}=1`, "--label", `${FLEET_OWNER_LABEL}=${owner}`];

// docker's rows as "<id> <owner>": the owner label's value, empty for a leftover from before owners were labelled.
const rowsOf = (out: string): { id: string; owner: string }[] =>
  out.split("\n").map(l => l.trim()).filter(l => l !== "").map(l => {
    const at = l.indexOf(" ");
    return at === -1 ? { id: l, owner: "" } : { id: l.slice(0, at), owner: l.slice(at + 1).trim() };
  });

/** Removes what gone runs of this kind left and answers what it removed. A failure to remove is said, never thrown. */
export function sweepFleetLeftovers(o: {
  docker: Docker; say: (line: string) => void; keep: boolean; tmp: string; procRoot?: string;
}): { containers: string[]; networks: string[]; scratch: string[] } {
  const format = `{{.ID}} {{.Label "${FLEET_OWNER_LABEL}"}}`;
  const procRoot = o.procRoot === undefined ? {} : { procRoot: o.procRoot };
  const containers = sweepContainers({
    list: () => rowsOf(o.docker(["ps", "-a", "--filter", `label=${FLEET_LABEL}`, "--format", format]).out),
    remove: id => { const r = o.docker(["rm", "-f", id]); return { ok: r.code === 0, err: r.err }; },
    say: o.say, ...procRoot,
  });
  const networks = sweepContainers({
    list: () => rowsOf(o.docker(["network", "ls", "--filter", `label=${FLEET_LABEL}`, "--format", format]).out),
    remove: id => { const r = o.docker(["network", "rm", id]); return { ok: r.code === 0, err: r.err }; },
    say: o.say, what: "network", ...procRoot,
  });
  const scratch = sweepScratch(o.tmp, { keep: o.keep, say: o.say, prefix: FLEET_SCRATCH_PREFIX, ...procRoot });
  return { containers, networks, scratch };
}
