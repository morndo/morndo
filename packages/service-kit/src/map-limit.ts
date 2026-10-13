// Like Promise.all, but no work outlives the answer. At the first failure `abort` is called, so the others can stop
// early; every one is then waited for, and that first failure (in time, not in list order) is thrown.
export async function allEnded<T extends readonly unknown[] | []>(runs: T, abort?: () => void): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  let first: { error: unknown } | null = null;
  const watched = (runs as readonly unknown[]).map(run => Promise.resolve(run).catch((error: unknown) => {
    if (!first) { first = { error }; abort?.(); }
    throw error;
  }));
  const settled = await Promise.allSettled(watched);
  if (first) throw (first as { error: unknown }).error;
  return settled.map(s => (s as PromiseFulfilledResult<unknown>).value) as { -readonly [P in keyof T]: Awaited<T[P]> };
}

// `fn` over `items` with at most `limit` running at once, results in input order. After a failure no further item
// starts, the running ones see `signal` aborted, and the failure is thrown once they have ended (allEnded).
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, signal: AbortSignal) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  const stop = new AbortController();
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop.signal.aborted) {
      const i = next++;
      out[i] = await fn(items[i] as T, stop.signal);
    }
  };
  await allEnded(Array.from({ length: Math.min(limit, items.length) }, worker), () => stop.abort());
  return out;
}
