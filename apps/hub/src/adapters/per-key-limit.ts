// At most `limit` jobs at a time for one key (a node's name); later ones wait in order and start as slots free.
export function perKeyLimit(limit: number): <T>(key: string, job: () => Promise<T>) => Promise<T> {
  const running = new Map<string, number>();
  const waiting = new Map<string, (() => void)[]>();
  const release = (key: string): void => {
    const next = waiting.get(key)?.shift();
    if (next) { next(); return; }                               // the slot passes to the next in line
    const left = (running.get(key) ?? 1) - 1;
    if (left <= 0) { running.delete(key); waiting.delete(key); } else running.set(key, left);
  };
  return async (key, job) => {
    if ((running.get(key) ?? 0) >= limit) {
      await new Promise<void>(resolve => { const queue = waiting.get(key) ?? []; queue.push(resolve); waiting.set(key, queue); });
    } else running.set(key, (running.get(key) ?? 0) + 1);
    try { return await job(); } finally { release(key); }
  };
}
