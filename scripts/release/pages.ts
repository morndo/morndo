// A Pages deploy must not publish a site older than the feed branch. The caller reads the
// head, builds from that commit, then reads again. A moved branch is built again.
export type SiteHead = { sha: string; seq: number };

export function freshSite(read: () => SiteHead, build: (head: SiteHead) => SiteHead, attempts = 5): SiteHead {
  for (let n = 1; n <= attempts; n++) {
    const head = read();
    const built = build(head);
    const again = read();
    if (built.sha === head.sha && again.sha === head.sha && built.seq >= again.seq) return built;
  }
  throw new Error("the feed branch moved on every attempt");
}
