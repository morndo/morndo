// `morndo doctor` (design §8.1): re-ask the machine what it believes. The installed tree against its signed file
// list, the layout's links against what is installed, the provenance of the current Version, the Key set's expiry
// against the Alert's 30-day horizon (§12, update_keys_expiring), the Feed's freshness against its last verified
// word, and the free space as a number for the human to judge (the apply step owns the must-cover check, §6.1). The
// units, lingering and tmux placement checks are that step's too, not this one's.
import { CHECKOUT_SENTENCE } from "./check-service.ts";
import type { Clock, Installer, UpdateStore } from "./ports.ts";
import { iso } from "./status-service.ts";

export type DoctorFinding =
  | { area: "install"; detail: string }      // RL14: an install the updater did not make
  | { area: "tree"; detail: string }         // the current Version against its signed file list
  | { area: "provenance"; detail: string }   // a current Version the store has no record of
  | { area: "layout"; detail: string }       // links that point nowhere
  | { area: "keys"; detail: string }         // the trusted Key set's expiry
  | { area: "feed"; detail: string };        // the Feed's last verified word
export type DoctorReport = { ok: boolean; findings: DoctorFinding[]; freeBytes: number };

// The Alert's horizon (§12): a Key set inside this many days is already news, not a surprise.
const KEYS_ALERT_WINDOW_MS = 30 * 24 * 3600_000;

export async function doctor(p: { installer: Installer; store: UpdateStore; clock: Clock }): Promise<DoctorReport> {
  const freeBytes = p.installer.freeBytes();
  const layout = p.installer.layout();
  if (layout.method !== "updater") {
    // RL14: not ours to diagnose further — the updater's own view of a checkout ends at this sentence.
    return { ok: false, findings: [{ area: "install", detail: CHECKOUT_SENTENCE }], freeBytes };
  }
  const findings: DoctorFinding[] = [];

  if (layout.current !== null) {
    // What runs now against what was signed (RL1). Without a record there is no list to check against, and the
    // finding says so — a Version the updater never staged cannot be re-verified.
    const record = p.store.versionRecord(layout.current);
    const tree = await p.installer.verifyTree(layout.current, record?.filesSha256 ?? null);
    findings.push(...tree.map(finding => ({ area: "tree" as const, detail: `${finding.path}: ${finding.problem}` })));
    if (record === null) {
      findings.push({ area: "provenance", detail: `no record of ${layout.current}: not staged by this updater, or the store was reset` });
    }
  } else {
    findings.push({ area: "layout", detail: "no current Version: the current link is missing" });
  }

  for (const [name, version] of [["previous", layout.previous], ["good", layout.good]] as const) {
    if (version !== null && !p.installer.has(version)) {
      findings.push({ area: "layout", detail: `${name} ${version} is linked but not installed` });
    }
  }

  const trust = p.store.trust();
  if (trust.keySet === null) {
    findings.push({ area: "keys", detail: "no key set is trusted yet: this machine has never completed a check" });
  } else {
    const left = trust.keySet.expiresAt - p.clock.now();
    if (left <= 0) {
      findings.push({ area: "keys", detail: `key set ${trust.keySet.version} has expired: nothing new can be verified until it is rotated` });
    } else if (left < KEYS_ALERT_WINDOW_MS) {
      findings.push({ area: "keys", detail: `key set ${trust.keySet.version} expires in ${Math.ceil(left / 24 / 3600_000)} days` });
    }
  }

  // The feed's last verified word — a later refusal leaves it standing (§4.5), so staleness is judged from it, not
  // from the newest row.
  const feedRow = p.store.checks(10).flatMap(row => row.feedExpiresAt !== null && row.feedSeq !== null
    ? [{ seq: row.feedSeq, expiresAt: row.feedExpiresAt }]
    : [])[0] ?? null;
  if (feedRow === null) {
    findings.push({ area: "feed", detail: "the feed has never been verified: this machine has never completed a check" });
  } else if (feedRow.expiresAt <= p.clock.now()) {
    findings.push({ area: "feed", detail: `the feed's last verified word (seq ${feedRow.seq}, ${iso(feedRow.expiresAt)}) has expired: no check has verified it since` });
  }

  return { ok: findings.length === 0, findings, freeBytes };
}
