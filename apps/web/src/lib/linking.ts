// Adding a device (ADR-0008 phase E; AC10–AC13): the words and links both screens share.

// "123456" → "123 456": read aloud or compared at a glance.
export const showCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

// The pairing link a signed-in device shows: the token and the hub identity this device pinned at its own pairing, so
// the new device checks the hub against an identity it didn't get from the hub (AC6). Both in the fragment, which the
// browser never sends to a server.
export const pairLink = (origin: string, token: string, fingerprint: string) => `${origin}/pair#t=${encodeURIComponent(token)}&f=${fingerprint}`;

// The address a waiting device shows for a signed-in device to open, with the key for the identity proof.
export const linkAddress = (origin: string, requestId: string, key: string) => `${origin}/link#r=${requestId}&k=${key}`;

// "9:05" until the end, never below "0:00".
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// The key a waiting device puts in its QR code's fragment, which no server sees (review M1): 16 random bytes.
export const newLinkKey = () => b64u(crypto.getRandomValues(new Uint8Array(16)));

// The approving device's word for the hub identity it pinned: HMAC-SHA256 of the fingerprint under that key. The hub
// carries it to the waiting device, which checks it before it trusts the fingerprint: a hub can't make one up.
export async function identityProof(key: string, fingerprint: string): Promise<string> {
  const raw = Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(fingerprint))));
}

function b64u(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
