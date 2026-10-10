// Shared kernel: identifiers and small helpers only. No I/O, no clock of its own: callers pass `now` (ms since epoch).

export type EndpointId = string & { readonly __brand: "EndpointId" };
export type PairingTokenId = string & { readonly __brand: "PairingTokenId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type WorkerId = string & { readonly __brand: "WorkerId" };

export const endpointId = (s: string) => s as EndpointId;
export const pairingTokenId = (s: string) => s as PairingTokenId;
export const sessionId = (s: string) => s as SessionId;
export const workerId = (s: string) => s as WorkerId;

export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E> = Ok<T> | Err<E>;
export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

// The default of every switch over a union (ADR-0008, A3; design reference: Signal-Desktop's missingCaseError). Only
// `never` fits, so a union member the switch forgets is a compile error; data the types ruled out (a newer peer, a
// bad cast) throws with the value instead of passing silently.
export function unreachable(x: never): never {
  let shown: string;
  try { shown = JSON.stringify(x) ?? String(x); } catch { shown = String(x); }
  throw new TypeError(`Unhandled case: ${shown}`);
}

// The first `n` UTF-16 units of `text`, never ending inside a character: a cut that would split a surrogate pair (an
// emoji, say) ends one unit earlier (validated review finding #8 of PR #11).
export function cutText(text: string, n: number): string {
  if (n >= text.length) return text;
  const end = n > 0 && /[\uD800-\uDBFF]/.test(text.charAt(n - 1)) ? n - 1 : n;
  return text.slice(0, Math.max(0, end));
}
