// The hub's identity, checked like a Signal safety number (ADR-0004, AC6): the fingerprint pinned at pairing must
// match, and the hub must prove it holds the private key by signing a fresh nonce (Ed25519 via WebCrypto).
import { api } from "./api.ts";

const PIN_KEY = "morndo.pin";

export type Pin = { fingerprint: string; device: string; pairedAt: number };
export type HubCheck = { fingerprint: string; display: string; signature: "verified" | "unsupported" };

export function readPin(): Pin | null {
  try {
    const v = localStorage.getItem(PIN_KEY);
    return v ? (JSON.parse(v) as Pin) : null;
  } catch {
    return null;
  }
}
export function writePin(p: Pin) {
  try { localStorage.setItem(PIN_KEY, JSON.stringify(p)); } catch { /* private mode: the pin lives for this page only */ }
}

const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const toB64u = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

export async function checkHub(): Promise<HubCheck> {
  const id = await api.get<{ fingerprint: string; display: string; publicKey: string }>("/api/identity");
  const publicKey = fromB64u(id.publicKey);
  const fingerprint = hex(await crypto.subtle.digest("SHA-256", publicKey));
  if (fingerprint !== id.fingerprint) throw new Error("The hub sent an identity that doesn't match its own fingerprint.");

  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const { signature } = await api.post<{ signature: string }>("/api/identity/prove", { nonce: toB64u(nonce) });
  const signed = new Uint8Array([...new TextEncoder().encode("morndo-hub-identity:"), ...nonce]);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return { fingerprint, display: id.display, signature: "unsupported" };   // browser without Ed25519: fingerprint only
  }
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, fromB64u(signature), signed);
  if (!ok) throw new Error("The hub couldn't prove its identity. Don't use this connection.");
  return { fingerprint, display: id.display, signature: "verified" };
}
