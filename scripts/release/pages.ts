// A Pages deploy must not publish a site from a feed commit that is already stale, nor one
// numbered below the feed that is deployed now. Read the branch head, build from that commit,
// then read the head again: a different sha is a moved branch and is built again. The built
// feed's number is then checked against the deployed feed's (null: nothing is deployed yet).
export type SiteHead = { sha: string; seq: number };

export function freshSite(
  read: () => SiteHead,
  build: (head: SiteHead) => SiteHead,
  deployed: () => number | null,
  attempts = 5,
): SiteHead {
  for (let n = 1; n <= attempts; n++) {
    const head = read();
    const built = build(head);
    const again = read();
    if (again.sha !== head.sha || built.sha !== head.sha) continue;
    const live = deployed();
    if (live !== null && built.seq < live) throw new Error(`feed seq ${built.seq} is older than the deployed feed's ${live}`);
    return built;
  }
  throw new Error("the feed branch moved on every attempt");
}
