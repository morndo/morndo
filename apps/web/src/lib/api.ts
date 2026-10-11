// Same-origin JSON calls to the hub. Cookies are HttpOnly; the browser sends them, this code never sees them.
import { UPLOAD_NAME_HEADER } from "@morndo/protocol";
export class ApiError extends Error {
  status: number;
  code: string;
  retryAfterMs: number | null;                // a 429's Retry-After (ADR-0008, A6): how long to wait before asking again
  data: Record<string, unknown>;              // the rest of the error body (the Engines page: which role, the CLI's words)
  constructor(status: number, code: string, retryAfterMs: number | null = null, data: Record<string, unknown> = {}) {
    super(code); this.status = status; this.code = code; this.retryAfterMs = retryAfterMs; this.data = data;
  }
}

// Retry-After is delay-seconds or an HTTP date, "Fri, 02 Oct 2026 12:00:30 GMT" (RFC 9110, 10.2.3); anything else is
// unknown.
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  const v = header?.trim() ?? "";
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(v)) return null;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}
type ErrorBody = { error?: unknown };
const apiError = (res: Response, data: ErrorBody) =>
  new ApiError(res.status, typeof data.error === "string" ? data.error : `http_${res.status}`, res.status === 429 ? retryAfterMs(res.headers.get("retry-after")) : null, data as Record<string, unknown>);

// `extra`: more of fetch's options (keepalive, for a request that must outlive a closing page).
async function call<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal, headers: Record<string, string> = {}, extra: RequestInit = {}): Promise<T> {
  const res = await fetch(path, body === undefined
    ? { ...extra, method, credentials: "same-origin", headers, ...(signal ? { signal } : {}) }
    : { ...extra, method, credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  const data = (await res.json().catch(() => ({}))) as ErrorBody;
  if (!res.ok) throw apiError(res, data);
  return data as T;
}

// A file the principal pasted or attached (S1). The hub decides from the name and the bytes, not from this type.
export async function uploadFile(file: File): Promise<{ id: string; name: string; size: number; mime: string }> {
  const headers: Record<string, string> = { "content-type": "application/octet-stream" };
  if (file.name) headers[UPLOAD_NAME_HEADER] = encodeURIComponent(file.name);
  const res = await fetch("/api/uploads", { method: "POST", credentials: "same-origin", headers, body: file });
  const data = (await res.json().catch(() => ({}))) as ErrorBody;
  if (!res.ok) throw apiError(res, data);
  return data as { id: string; name: string; size: number; mime: string };
}

export const api = {
  get: <T>(path: string, headers: Record<string, string> = {}) => call<T>("GET", path, undefined, undefined, headers),
  post: <T>(path: string, body: unknown = {}, signal?: AbortSignal, extra: RequestInit = {}) => call<T>("POST", path, body, signal, {}, extra),
};

const MESSAGES: Record<string, string> = {
  expired: "This pairing link has expired; they last 10 minutes. Make a new one: Add a device on a signed-in device, or `morndo pair`.",
  used: "This pairing link was already used. Make a new one for another device.",
  unknown_token: "The hub doesn't know this pairing link. Make a new one: Add a device on a signed-in device, or `morndo pair`.",
  too_many_endpoints: "Six devices are paired already. Revoke one first under Devices.",
  too_many: "Three devices are already asking to be added. Try again in a few minutes.",
  decided: "This request was already answered.",
  wrong_code: "That code didn't match, so this has ended. Start again from the device that shows the code.",
  code_needed: "Type the code shown on your signed-in device first.",
  unknown: "The hub doesn't know this request any more: it may have expired.",
  no_user_verification: "The passkey was made without Face ID, Touch ID or a device PIN. Morndo needs one of them.",
  not_verified: "The passkey check failed. Try again.",
  bad_flow: "That took too long or was already used. Try again.",
  unknown_device: "This passkey isn't paired with the hub, or its device was revoked. Pair again with `morndo pair`.",
  revoked: "This device was revoked. Pair it again with `morndo pair`.",
  counter_regressed: "The hub refused this passkey: its counter went backwards, which can mean a copied key. Pair again.",
  signed_out: "You're signed out.",
  NotAllowedError: "Cancelled, or the passkey prompt timed out.",
  InvalidStateError: "This device already has a Morndo passkey. Unlock with it instead.",
};

export function explain(e: unknown): string {
  if (e instanceof ApiError && e.code === "rate_limited") {
    const s = e.retryAfterMs === null ? null : Math.max(1, Math.ceil(e.retryAfterMs / 1000));
    return s === null ? "Too many attempts. Wait a moment, then try again." : `Too many attempts. Try again in ${s} second${s === 1 ? "" : "s"}.`;
  }
  if (e instanceof ApiError) return MESSAGES[e.code] ?? `The hub answered "${e.code}".`;
  if (e instanceof Error) return MESSAGES[e.name] ?? e.message;
  return "Something went wrong.";
}
