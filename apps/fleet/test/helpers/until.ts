// Waits in real time until `cond` holds. For tests that fake only setInterval: vi.waitFor would advance the fake clock
// on every check and fire the ping sweep early.
export async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) throw new Error(`condition not met within ${ms} ms`);
    await new Promise(r => setTimeout(r, 5));
  }
}
