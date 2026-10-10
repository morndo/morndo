// One step earlier or later. The ends stay put.
export function swap(order: readonly string[], index: number, by: -1 | 1): string[] {
  const next = index + by;
  if (next < 0 || next >= order.length) return [...order];
  const copy = [...order];
  const held = copy[index];
  const swapped = copy[next];
  if (held === undefined || swapped === undefined) return [...order];
  copy[index] = swapped;
  copy[next] = held;
  return copy;
}

// Dropping an entry puts it at that index. Removing first, then inserting, works in either direction.

export function moveTo(order: readonly string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return [...order];
  const copy = [...order];
  const [held] = copy.splice(from, 1);
  if (held === undefined) return [...order];
  copy.splice(to, 0, held);
  return copy;
}

// An own role with nothing stored takes its order from the chain. An empty result is not a save.
export function ownSaveOrder(stored: readonly string[], chain: readonly string[]): string[] | null {
  if (stored.length > 0) return [...stored];
  const names: string[] = [];
  for (const entry of chain) {
    const name = entry.split(":")[0] ?? "";
    if (name !== "" && !names.includes(name)) names.push(name);
  }
  return names.length > 0 ? names : null;
}
