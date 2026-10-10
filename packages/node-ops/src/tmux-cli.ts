// How this machine's code calls tmux (tmux(1), https://man7.org/linux/man-pages/man1/tmux.1.html, read 2026-10-06;
// each rule below seen on tmux 3.6a on 2026-10-06):
// - `-u` on every call: tmux writes UTF-8 only when the first of LC_ALL, LC_CTYPE and LANG that is set says UTF-8. A
//   service started without a locale otherwise gets every non-ASCII character, and even a tab, as "_" ("ünï<TAB>tab"
//   comes out as "_n__tab").
// - A session target is "=name": without "=", tmux also takes a prefix ("-t mai" finds "main").
// - Some arguments are formats: new-window's -n (a window name) and -c (its directory), new-session's -s, -n and -c, and
//   rename-window's name. "a#S b" becomes "amain b", and a directory "a#{session_name}b" starts the pane in "amainb"; a
//   "#(…)" in one expanded to nothing (tmux 3.6a ran no job within 2 s; other versions are not known to behave the
//   same). Every such argument that carries data from outside goes through tmuxLiteral, which writes "#" as "##", so it
//   arrives as it was given. No -F or display-message -p format is ever built from outside data.
// - A window is never targeted by its name: the window part of a target is matched as a pattern ("=main:f*" found
//   "f*x") and split at "." ("=main:fix.a" looked for a window "fix"), and display-message -p -t with a target that
//   matched nothing printed the session's current window, exit 0. Callers target "@N" or "%N", found by listing.
export function tmuxArgv(socket: string | null, args: readonly string[]): string[] {
  return ["-u", ...(socket ? ["-L", socket] : []), ...args];
}

export const exactSession = (name: string): string => `=${name}`;

// tmux ends a command at an argument that ends in ";" (tmux(1): "a trailing semicolon is also interpreted as a command
// separator"; one that is meant as an argument is escaped for tmux, written "\;"). execFile has no shell, so this
// is the only escape. "a;b" is one argument and is left alone.
export const tmuxLiteral = (s: string): string => {
  const doubled = s.replaceAll("#", "##");
  return doubled.endsWith(";") ? `${doubled.slice(0, -1)}\\;` : doubled;
};

// What a failed tmux call means (tmux 3.6a, seen 2026-10-07): with no server, no session or no such pane, tmux exits 1 and
// says so ("no server running on ...", "error connecting to ... (No such file or directory)", "can't find session|window|
// pane: ..."). Anything else (a timeout kill, a spawn error such as EMFILE, another exit code or other words) is a tmux
// that did not answer, which says nothing about what exists. The caller must not read it as "nothing there".
export type TmuxFailure = "absent" | "unavailable";
const ABSENT = /^(can't find (session|window|pane)\b|no server running\b|error connecting to .+ \((No such file or directory|Connection refused)\))/m;
export function tmuxFailure(e: unknown): TmuxFailure {
  const x = (typeof e === "object" && e !== null ? e : {}) as { code?: unknown; killed?: unknown; signal?: unknown; stderr?: unknown };
  return x.code === 1 && x.killed !== true && (x.signal === null || x.signal === undefined) && typeof x.stderr === "string" && ABSENT.test(x.stderr)
    ? "absent" : "unavailable";
}

// A tmux call that did not answer: not "empty", not "gone".
export class TmuxUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "TmuxUnavailable"; }
}
