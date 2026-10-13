// A Pages deploy must not publish a site from a feed commit that is already stale.
// Read the branch head, build from that commit, then read the head again. Build once more
// when the head moved. The sequence number moves with the commit, so the sha is the check.
export function freshSite(read: () => string, build: (sha: string) => void, attempts = 5): string {
  for (let n = 1; n <= attempts; n++) {
    const sha = read();
    build(sha);
    if (read() === sha) return sha;
  }
  throw new Error("the feed branch moved on every attempt");
}
