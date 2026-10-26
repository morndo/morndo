// The runtime packed into every archive (design §9.3, Q5). 24.22.1 was the newest 24.x on
// https://nodejs.org/dist/index.json on 2026-10-26 (lts "Krypton", dated 2026-10-20, security release; the
// release notes https://nodejs.org/en/blog/release/v24.22.1 carry 2026-10-21). The keyring
// commit is nodejs/release-keys@481637f813e912c4aa3622d7964ab426c97b8e8d (2026-09-01). Node's own
// check is gpgv against that keyring, then `shasum --check` (node README, "Verifying binaries", v24.21.0, read 2026-10-13).
import type { Platform } from "@morndo/domain";

export const BUNDLED_NODE = "24.22.1";
export const NODE_RELEASE_KEYS_COMMIT = "481637f813e912c4aa3622d7964ab426c97b8e8d"; //gitleaks:allow

export function nodeTarball(platform: Platform): string {
  return `node-v${BUNDLED_NODE}-${platform}.tar.gz`;
}

export function newerNode24(index: readonly { version: string }[]): string | null {
  const mine = parts(BUNDLED_NODE);
  let best: number[] | null = null;
  for (const row of index) {
    const match = /^v(24\.\d+\.\d+)$/.exec(row.version);
    const text = match?.[1];
    if (!text) continue;
    const got = parts(text);
    if (!best || compare(got, best) > 0) best = got;
  }
  if (!best || compare(best, mine) <= 0) return null;
  return best.join(".");
}

function parts(version: string): number[] {
  return version.split(".").map(n => Number(n));
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
