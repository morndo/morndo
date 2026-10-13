// Answers this device sent, by decision id, for the version the request named.
// The ledger can report that answer first, with via elsewhere or with via missing. A matching
// request is this device's. A re-ask is another version, so the old request does not claim it.

type Send = { requestId: string; seen: string };
const sends = new Map<string, Send>();
const listeners = new Set<() => void>();

export function rememberSend(id: string, requestId: string, seen: string) {
  sends.set(id, { requestId, seen });
  for (const l of listeners) l();
}

export function onSent(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function clearSends() { sends.clear(); }

// "here" when this device sent this version. Otherwise the record's own via, and a missing via stays missing.
export function viaOf(item: { id: string; version: string; decision: { via?: "here" | "elsewhere" } | null }): "here" | "elsewhere" | undefined {
  const mine = sends.get(item.id);
  if (mine && mine.seen === item.version) return "here";
  const via = item.decision?.via;
  return via === "here" || via === "elsewhere" ? via : undefined;
}
