// The adoption rehearsal's own judgements: pure functions on text the scenario read from the machine.
export interface Verdict { ok: boolean; detail: string }

// The same string as UNIT_MARK in apps/updater/src/adapters/services-systemd.ts (the first line of every unit Morndo writes).
export const UNIT_MARK = "# Morndo's own unit: every update rewrites it. Put changes in a drop-in (<unit>.d/*.conf).";

/** A unit file is adopted when it carries Morndo's mark as its first line and the old file was kept beside it. */
export function unitAdopted(name: string, text: string, dirListing: readonly string[]): Verdict {
  if (!text.startsWith(`${UNIT_MARK}\n`)) return { ok: false, detail: `${name} has no Morndo mark on its first line` };
  if (!dirListing.includes(`${name}.before-morndo`)) return { ok: false, detail: `${name}.before-morndo was not kept beside it` };
  return { ok: true, detail: `${name} is marked and ${name}.before-morndo is kept` };
}

/** Whether the unit's ExecStart runs the service's launcher in ~/.local/bin rather than a release folder's main.ts. */
export function runsFromLauncher(unitText: string): boolean {
  return unitText.split("\n").some(line => /^ExecStart=\S*\/\.local\/bin\/morndo(-\w+)?(\s|$)/.test(line.trim()));
}

export interface Proc { pid: number; started: string }

/** The same process: same pid and same start time (a reused pid has another start time). */
export function sameProcess(before: Proc | null, after: Proc | null): Verdict {
  if (before === null || after === null) return { ok: false, detail: `a process is missing (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})` };
  if (before.pid !== after.pid) return { ok: false, detail: `pid ${before.pid} is now ${after.pid}` };
  if (before.started !== after.started) return { ok: false, detail: `pid ${before.pid} started at ${before.started}, now ${after.started}: another process` };
  return { ok: true, detail: `pid ${before.pid} started at ${before.started}, unchanged` };
}

const parseListing = (text: string): Map<string, string> => {
  const m = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const at = line.lastIndexOf(" ");
    m.set(at < 0 ? line : line.slice(0, at), at < 0 ? "" : line.slice(at + 1));
  }
  return m;
};

/** `path size` lines compared as sets: names the paths that went, changed or appeared. */
export function sameListing(before: string, after: string): Verdict {
  const a = parseListing(before);
  const b = parseListing(after);
  if (a.size === 0 && b.size === 0) return { ok: false, detail: "both listings are empty: nothing was compared" };
  const diffs: string[] = [];
  for (const [p, s] of a) {
    if (!b.has(p)) diffs.push(`${p} is gone`);
    else if (b.get(p) !== s) diffs.push(`${p} changed (${s} -> ${b.get(p)})`);
  }
  for (const p of b.keys()) if (!a.has(p)) diffs.push(`${p} appeared`);
  return diffs.length === 0 ? { ok: true, detail: `${a.size} files, same paths and sizes` } : { ok: false, detail: diffs.slice(0, 10).join("; ") };
}

/** The expected rows that no whole line of a database answer matches. */
export function missingRows(answer: string, expected: readonly string[]): string[] {
  const have = new Set(answer.split("\n").map(l => l.trim()));
  return expected.filter(e => !have.has(e));
}

/** The hash SHA256SUMS gives a file ("<64 hex>  name" or "<64 hex> *name"); the name must match whole. */
export function sha256For(sumsText: string, fileName: string): string | null {
  for (const line of sumsText.split("\n")) {
    const m = /^([0-9a-f]{64}) [ *](.+?)\s*$/.exec(line);
    if (m !== null && m[2] === fileName) return m[1] ?? null;
  }
  return null;
}

/** The text of the README's single-quoted `echo '...' > morndo.allowed_signers` line; null when absent or ambiguous. */
export function allowedSignersLine(readmeText: string): string | null {
  const found = new Set<string>();
  for (const line of readmeText.split("\n")) {
    const m = /^\s*echo '([^']*)' > morndo\.allowed_signers\s*$/.exec(line);
    if (m !== null && m[1] !== undefined) found.add(m[1]);
  }
  return found.size === 1 ? [...found][0] ?? null : null;
}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * `--published <semver>` from the arguments; null when the flag is absent, a throw when it is repeated (the first one would
 * win silently), when its value is missing or no version, or, with `--require-published`, when it is absent.
 */
export function parsePublished(argv: readonly string[]): string | null {
  const at = argv.indexOf("--published");
  if (at < 0) {
    if (argv.includes("--require-published")) throw new Error("this run needs --published <version> (npm run e2e:update-adopt-published -- --published 0.2.0)");
    return null;
  }
  if (argv.indexOf("--published", at + 1) >= 0) throw new Error("--published may be given once");
  const value = argv[at + 1];
  if (value === undefined || !SEMVER.test(value)) throw new Error(`--published needs a version like 0.2.0, got ${JSON.stringify(value ?? null)}`);
  return value;
}
