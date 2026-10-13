// A Pages deploy must not publish a site from a feed commit that is already stale.
// Read the branch head, build from that commit, then read the head again. A different
// sha is a moved branch and is built again. The same sha with a lower seq is a regression.
export type SiteHead = { sha: string; seq: number };

export function freshSite(read: () => SiteHead, build: (head: SiteHead) => SiteHead, attempts = 5): SiteHead {
  for (let n = 1; n <= attempts; n++) {
    const head = read();
    const built = build(head);
    const again = read();
    if (again.sha !== head.sha || built.sha !== head.sha) continue;
    if (built.seq < again.seq) throw new Error("feed seq went backwards");
    return built;
  }
  throw new Error("the feed branch moved on every attempt");
}
